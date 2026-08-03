import type { WebSocket } from "ws";
import { mapCodexEvent } from "./codex-event-mapper.js";
import type { GatewayDB } from "./db.js";
import type { ProcessManager } from "./process-manager.js";
import type {
  EventFrame,
  RequestFrame,
  ResponseFrame,
  RunRecord,
  SessionRecord,
} from "./protocol.js";

export class RpcDispatcher {
  constructor(
    private db: GatewayDB,
    private pm: ProcessManager,
  ) {}

  /** Dispatch an incoming request frame and return a response. */
  async dispatch(frame: RequestFrame, ws: WebSocket): Promise<ResponseFrame> {
    const { id, method, params } = frame;
    try {
      switch (method) {
        case "agents.list": {
          const statuses = this.pm.listStatuses();
          return { type: "res", id, ok: true, payload: { agents: statuses } };
        }

        case "sessions.list": {
          const agentId = params?.agentId as string | undefined;
          const sessions = this.db.listSessions(agentId);
          return { type: "res", id, ok: true, payload: { sessions } };
        }

        case "sessions.create": {
          const agentId = params?.agentId as string;
          if (!agentId) return { type: "res", id, ok: false, error: "agentId required" };
          const title = params?.title as string | undefined;
          const session = this.db.createSession(agentId, title);
          return { type: "res", id, ok: true, payload: { session } };
        }

        case "sessions.delete": {
          const sessionId = params?.sessionId as string;
          if (!sessionId) return { type: "res", id, ok: false, error: "sessionId required" };
          this.db.deleteSession(sessionId);
          return { type: "res", id, ok: true };
        }

        case "chat.send": {
          return this.handleChatSend(id, params, ws);
        }

        case "chat.abort": {
          const agentId = params?.agentId as string;
          if (!agentId) return { type: "res", id, ok: false, error: "agentId required" };
          const killed = this.pm.kill(agentId);
          return { type: "res", id, ok: killed };
        }

        case "chat.history": {
          const sessionId = params?.sessionId as string;
          if (!sessionId) return { type: "res", id, ok: false, error: "sessionId required" };
          const runs = this.db.listRuns(sessionId);
          const messages: Array<Record<string, unknown>> = [];
          for (const run of runs) {
            if (run.prompt) {
              messages.push({ id: run.id, role: "user", content: run.prompt });
            }
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
              models: [
                { id: "codex-default", name: "Codex", provider: "openai" },
                { id: "claude-default", name: "Claude", provider: "anthropic" },
              ],
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

  /** Handle chat.send: create a run, spawn the agent, stream events back. */
  private handleChatSend(
    reqId: string,
    params: Record<string, unknown> | undefined,
    ws: WebSocket,
  ): ResponseFrame {
    const agentId = params?.agentId as string | undefined;
    const sessionId = params?.sessionId as string | undefined;
    const message = params?.message as string | undefined;

    if (!agentId) return { type: "res", id: reqId, ok: false, error: "agentId required" };

    // Resolve or create session
    let session: SessionRecord;
    if (sessionId) {
      const existing = this.db.getSession(sessionId);
      if (!existing) {
        // Session doesn't exist yet — create it on demand
        session = this.db.createSession(agentId);
      } else {
        session = existing;
      }
    } else {
      session = this.db.createSession(agentId);
    }

    // Create run record
    const run = this.db.createRun(session.id, agentId, message);

    // Respond synchronously — the run ID lets the client track events
    const response: ResponseFrame = {
      type: "res",
      id: reqId,
      ok: true,
      payload: { runId: run.id, sessionId: session.id },
    };

    // Start the agent process and stream events back
    this.streamRun(agentId, run, message, ws);

    return response;
  }

  /** Spawn the agent process and relay JSON-line events to the browser. */
  private streamRun(
    agentId: string,
    run: RunRecord,
    message: string | undefined,
    ws: WebSocket,
  ): void {
    let buffered = "";
    let responseText = "";
    let sentFinal = false;
    let spawnedPid: number | undefined;

    const send = (event: string, payload: unknown) => {
      if (ws.readyState !== ws.OPEN) return;
      const frame: EventFrame = { type: "event", event, payload };
      ws.send(JSON.stringify(frame));
    };

    const onProcessEvent = (ev: {
      agentId: string;
      type: string;
      data: string;
      code?: number | null;
      pid?: number;
    }) => {
      if (ev.agentId !== agentId) return;
      if (spawnedPid !== undefined && ev.pid !== undefined && ev.pid !== spawnedPid) return;

      if (ev.type === "stdout") {
        buffered += ev.data;
        // Try to parse JSON lines from the buffer
        const lines = buffered.split("\n");
        // Keep the last (potentially incomplete) line in buffer
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (!trimmed.startsWith("{")) {
            // Non-JSON log line (e.g. rmcp errors) — send as stderr
            send("agent", {
              stream: "stderr",
              runId: run.id,
              data: { delta: trimmed },
            });
            continue;
          }
          // Parse and map Codex JSON events
          const events = mapCodexEvent(trimmed, run.id);
          for (const e of events) {
            if (e.event === "agent") {
              const data = (e.payload as { stream?: string; data?: { text?: string } }).data;
              const stream = (e.payload as { stream?: string }).stream;
              if (stream === "assistant" && data?.text) {
                responseText = data.text;
              }
            }
            if (e.event === "chat") {
              sentFinal = true;
            }
            send(e.event, e.payload);
          }
        }
      } else if (ev.type === "stderr") {
        send("agent", {
          stream: "stderr",
          runId: run.id,
          data: { delta: ev.data },
        });
      } else if (ev.type === "exit") {
        this.pm.off("process", onProcessEvent);
        const ok = ev.code === 0;
        this.db.updateRun(run.id, {
          status: ok ? "completed" : "error",
          response: responseText || undefined,
          error: ok ? undefined : `exit code ${ev.code}`,
        });
        // If the process exited without emitting turn.completed JSON,
        // send a final chat event so the client closes the stream.
        if (!sentFinal) {
          send("chat", {
            runId: run.id,
            sessionKey: run.sessionId,
            state: ok ? "final" : "error",
            stopReason: ok ? "end_turn" : "error",
          });
        }
      } else if (ev.type === "error") {
        this.pm.off("process", onProcessEvent);
        this.db.updateRun(run.id, { status: "error", error: ev.data });
        send("chat", {
          runId: run.id,
          sessionKey: run.sessionId,
          state: "error",
          errorMessage: ev.data,
        });
      }
    };

    this.pm.on("process", onProcessEvent);

    // Spawn the process (or get the already-running one)
    try {
      const proc = this.pm.spawn(agentId);
      spawnedPid = proc.pid;
      if (message && proc.stdin && proc.exitCode === null) {
        proc.stdin.write(message + "\n");
        proc.stdin.end();
      }
    } catch (err) {
      this.pm.off("process", onProcessEvent);
      this.db.updateRun(run.id, {
        status: "error",
        error: err instanceof Error ? err.message : "spawn failed",
      });
      send("chat", {
        runId: run.id,
        sessionKey: run.sessionId,
        state: "error",
        errorMessage: err instanceof Error ? err.message : "spawn failed",
      });
    }
  }
}
