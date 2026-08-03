import { resolve } from "node:path";
import type { WebSocket } from "ws";
import type { AdapterRegistry } from "./adapters/registry.js";
import type { GatewayDB } from "./db.js";
import type { RequestFrame, ResponseFrame, RunRecord } from "./protocol.js";
import type { NormalizedAgentEvent } from "./runtime/NormalizedAgentEvent.js";
import type { RunController } from "./runtime/RunController.js";
import type { SessionController } from "./runtime/SessionController.js";
import { normalizedToWire } from "./runtime/wire.js";

/**
 * RpcDispatcher — WebSocket request handler. It no longer hardcodes Codex:
 * every chat turn is dispatched through the AgentAdapter that the agent's
 * config selects (via AdapterRegistry), and run lifecycle is owned by the
 * RunController (completed/errored from turn.* events, not process exit).
 */
export class RpcDispatcher {
  /** runId -> adapter, so chat.abort can reach the right in-flight turn. */
  private activeRuns = new Map<string, { agentId: string }>();
  private cwd: string;

  constructor(
    private db: GatewayDB,
    private registry: AdapterRegistry,
    private runs: RunController,
    private sessions: SessionController,
    cwd?: string,
  ) {
    // Default working directory for agent turns. Overridable via ACP_AGENT_CWD.
    this.cwd = cwd ?? process.env["ACP_AGENT_CWD"] ?? resolve(process.cwd());
  }

  async dispatch(frame: RequestFrame, ws: WebSocket): Promise<ResponseFrame> {
    const { id, method, params } = frame;
    try {
      switch (method) {
        case "agents.list": {
          const statuses = this.registry.listConfigs().map((c) => {
            const adapter = this.registry.peek(c.id);
            return {
              id: c.id,
              name: c.name,
              type: c.type,
              running: adapter?.isRunning() ?? false,
              pid: adapter?.pid(),
            };
          });
          return { type: "res", id, ok: true, payload: { agents: statuses } };
        }

        case "sessions.list": {
          const agentId = params?.["agentId"] as string | undefined;
          return {
            type: "res",
            id,
            ok: true,
            payload: { sessions: this.sessions.list(agentId) },
          };
        }

        case "sessions.create": {
          const agentId = params?.["agentId"] as string;
          if (!agentId) return { type: "res", id, ok: false, error: "agentId required" };
          const title = params?.["title"] as string | undefined;
          return {
            type: "res",
            id,
            ok: true,
            payload: { session: this.sessions.create(agentId, title) },
          };
        }

        case "sessions.delete": {
          const sessionId = params?.["sessionId"] as string;
          if (!sessionId) return { type: "res", id, ok: false, error: "sessionId required" };
          this.sessions.delete(sessionId);
          return { type: "res", id, ok: true };
        }

        case "chat.send":
          return this.handleChatSend(id, params, ws);

        case "chat.abort": {
          const runId = params?.["runId"] as string | undefined;
          const agentId = params?.["agentId"] as string | undefined;
          if (runId) {
            const active = this.activeRuns.get(runId);
            if (active) {
              this.registry.peek(active.agentId)?.abort(runId);
              this.runs.abort(runId);
              return { type: "res", id, ok: true };
            }
          }
          // Fallback: abort every in-flight run for the agent.
          if (agentId) {
            let any = false;
            for (const [rid, a] of this.activeRuns) {
              if (a.agentId === agentId) {
                this.registry.peek(agentId)?.abort(rid);
                this.runs.abort(rid);
                any = true;
              }
            }
            return { type: "res", id, ok: any };
          }
          return { type: "res", id, ok: false, error: "runId or agentId required" };
        }

        case "chat.history": {
          const sessionId = params?.["sessionId"] as string;
          if (!sessionId) return { type: "res", id, ok: false, error: "sessionId required" };
          const runs = this.db.listRuns(sessionId);
          const messages: Array<Record<string, unknown>> = [];
          // listRuns returns newest-first; render oldest-first for the UI.
          for (const run of [...runs].reverse()) {
            if (run.prompt) messages.push({ id: run.id, role: "user", content: run.prompt });
            if (run.status === "completed") {
              messages.push({
                id: `assistant-${run.id}`,
                role: "assistant",
                content: run.response ?? "",
              });
            } else if (run.status === "error") {
              messages.push({
                id: `assistant-${run.id}`,
                role: "assistant",
                content: `[Error: ${run.error ?? "unknown"}]`,
              });
            } else if (run.status === "aborted") {
              messages.push({
                id: `assistant-${run.id}`,
                role: "assistant",
                content: run.response ?? "[Aborted]",
              });
            }
          }
          return { type: "res", id, ok: true, payload: { messages } };
        }

        case "models.list": {
          return {
            type: "res",
            id,
            ok: true,
            payload: {
              models: this.registry.listConfigs().map((c) => ({
                id: `${c.id}-default`,
                name: c.name,
                provider: c.type,
              })),
            },
          };
        }

        default:
          return { type: "res", id, ok: false, error: `unknown method: ${method}` };
      }
    } catch (err) {
      return {
        type: "res",
        id,
        ok: false,
        error: err instanceof Error ? err.message : "internal error",
      };
    }
  }

  private handleChatSend(
    reqId: string,
    params: Record<string, unknown> | undefined,
    ws: WebSocket,
  ): ResponseFrame {
    const agentId = params?.["agentId"] as string | undefined;
    const sessionIdParam = params?.["sessionId"] as string | undefined;
    const message = (params?.["message"] as string | undefined) ?? "";

    if (!agentId) return { type: "res", id: reqId, ok: false, error: "agentId required" };
    if (!this.registry.getConfig(agentId)) {
      return { type: "res", id: reqId, ok: false, error: `unknown agent: ${agentId}` };
    }

    const session = this.sessions.resolveOrCreate(agentId, sessionIdParam);
    const run = this.runs.create(session.id, agentId, message);

    // Fire the turn asynchronously; the run id lets the client track events.
    void this.runTurn(agentId, run, session.id, message, ws);

    return {
      type: "res",
      id: reqId,
      ok: true,
      payload: { runId: run.id, sessionId: session.id },
    };
  }

  /** Drive one prompt turn through the agent's adapter, relaying events. */
  private async runTurn(
    agentId: string,
    run: RunRecord,
    sessionId: string,
    message: string,
    ws: WebSocket,
  ): Promise<void> {
    const send = (frame: { type: "event"; event: string; payload?: unknown }) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(frame));
    };

    let adapter;
    try {
      adapter = this.registry.get(agentId);
    } catch (err) {
      this.runs.error(run.id, err instanceof Error ? err.message : "adapter unavailable");
      for (const f of normalizedToWire(
        { type: "turn.error", runId: run.id, error: err instanceof Error ? err.message : "adapter unavailable" },
        sessionId,
      )) {
        send(f);
      }
      return;
    }

    this.activeRuns.set(run.id, { agentId });

    // Relay this run's normalized events to the browser + fold into the run.
    const onEvent = (ev: NormalizedAgentEvent) => {
      if (ev.runId !== run.id) return;
      this.runs.ingest(ev);
      for (const f of normalizedToWire(ev, sessionId)) send(f);
    };
    const unsubEvent = adapter.onEvent(onEvent);

    // Crash fallback: if the process dies while this run is still running,
    // mark it error and close the client stream.
    const unsubExit = adapter.onExit((reason) => {
      const failed = this.runs.onProcessDeath([run.id], reason);
      if (failed.includes(run.id)) {
        for (const f of normalizedToWire(
          { type: "turn.error", runId: run.id, error: `agent process ended (${reason})` },
          sessionId,
        )) {
          send(f);
        }
      }
    });

    try {
      const result = await adapter.prompt({
        runId: run.id,
        providerSessionId: this.sessions.getProviderSessionId(sessionId),
        cwd: this.cwd,
        text: message,
      });
      if (result.providerSessionId) {
        this.sessions.setProviderSessionId(sessionId, result.providerSessionId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "turn failed";
      if (this.runs.error(run.id, msg)) {
        for (const f of normalizedToWire({ type: "turn.error", runId: run.id, error: msg }, sessionId)) {
          send(f);
        }
      }
    } finally {
      unsubEvent();
      unsubExit();
      this.activeRuns.delete(run.id);
    }
  }
}
