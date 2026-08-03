import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AgentConfig } from "../../protocol.js";
import type {
  AdapterCapabilities,
  AdapterPromptRequest,
  AdapterPromptResult,
  AgentAdapter,
  NormalizedAgentEvent,
} from "../../runtime/NormalizedAgentEvent.js";

/**
 * DCodeAcpAdapter — a real Agent Client Protocol (ACP) client for
 * `dcode --acp`. ACP is JSON-RPC 2.0 over stdio (the same family Zed uses).
 *
 * Protocol shape (verified empirically against deepagents-code 0.1.51):
 *
 *   client -> initialize {protocolVersion, clientCapabilities}
 *          <- {protocolVersion, agentCapabilities}
 *   client -> session/new {cwd, mcpServers:[]}  -> {sessionId}
 *   client -> session/load {sessionId, cwd, mcpServers:[]} -> {}   (resume)
 *   client -> session/prompt {sessionId, prompt:[{type:"text",text}]}
 *          <- session/update notifications:
 *               agent_message_chunk  {update:{sessionUpdate, content:{text}}}
 *               tool_call            {update:{toolCallId,title,kind,status,rawInput}}
 *               tool_call_update     {update:{toolCallId,status,content:[...]}}
 *          <- {stopReason:"end_turn"|"cancelled"}   (prompt response)
 *   client -> session/cancel {sessionId}   (NOTIFICATION, no id) -> cancels turn
 *
 *   server -> session/request_permission {options:[{optionId,...}]}   (request)
 *          <- {outcome:{outcome:"selected",optionId}}
 *   server -> fs/read_text_file / fs/write_text_file  (requests)
 *
 * One process is spawned per agent and reused across turns (multi-turn: same
 * pid), matching the gateway's long-lived-agent model.
 */

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// Shapes of the ACP session/update payloads we care about.
interface SessionUpdate {
  sessionId?: string;
  update?: {
    sessionUpdate?: string;
    content?: { text?: string; type?: string };
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: unknown;
  };
}

export class DCodeAcpAdapter implements AgentAdapter {
  readonly agentId: string;
  readonly capabilities: AdapterCapabilities = {
    resumeSession: true,
    toolCalls: true,
    permissions: true,
  };

  private config: AgentConfig;
  private proc: ChildProcess | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (r: JsonRpcMessage) => void; reject: (e: Error) => void }
  >();
  private eventListeners = new Set<(ev: NormalizedAgentEvent) => void>();
  private exitListeners = new Set<(reason: string) => void>();
  private startPromise: Promise<void> | null = null;
  private initialized = false;

  /** Maps ACP sessionId -> the gateway runId currently prompting on it, so
   *  session/update notifications can be attributed to the right run. */
  private activeRunBySession = new Map<string, string>();
  /** Reverse: runId -> ACP sessionId, for abort(). */
  private sessionByRun = new Map<string, string>();
  /** Track tool metadata (name, input) from tool_call so file.created can be
   *  emitted when tool_call_update marks it completed. */
  private toolMeta = new Map<string, { name: string; rawInput?: unknown }>();

  constructor(config: AgentConfig) {
    this.config = config;
    this.agentId = config.id;
  }

  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }

  pid(): number | undefined {
    return this.proc?.pid;
  }

  onEvent(listener: (ev: NormalizedAgentEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onExit(listener: (reason: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private emit(ev: NormalizedAgentEvent): void {
    for (const l of this.eventListeners) {
      try {
        l(ev);
      } catch (err) {
        console.warn("[acp:dcode] event listener threw:", err);
      }
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(cwd: string): Promise<void> {
    if (this.isRunning() && this.initialized) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      const args = [...(this.config.args ?? [])];
      const env = { ...process.env, ...this.config.env };
      const workDir = this.config.cwd ?? cwd ?? process.cwd();

      console.info(`[acp:dcode] spawning ${this.config.command} ${args.join(" ")} in ${workDir}`);
      const proc = spawn(this.config.command, args, {
        cwd: workDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = proc;

      proc.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
      proc.stderr?.on("data", (chunk: Buffer) => {
        // dcode logs skill-validation noise to stderr; keep it low-signal.
        const text = chunk.toString().trim();
        if (text) console.warn("[acp:dcode:stderr]", text.slice(0, 500));
      });
      proc.on("error", (err: Error) => this.handleDeath(`spawn error: ${err.message}`));
      proc.on("exit", (code, signal) =>
        this.handleDeath(`exited code=${code ?? "null"} signal=${signal ?? "null"}`),
      );

      // ACP handshake. Do NOT advertise fs capabilities — we respond to
      // fs/* requests with empty results (the gateway is not the file
      // authority), which causes DCode to stall or error. Let DCode use its
      // own native tools for file I/O instead.
      await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      this.initialized = true;
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  disconnect(): void {
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    // Escalate if it doesn't die promptly.
    setTimeout(() => {
      if (proc.exitCode === null && !proc.killed) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }, 2000).unref?.();
  }

  private handleDeath(reason: string): void {
    if (this.proc === null) return;
    this.proc = null;
    this.initialized = false;
    // Reject any in-flight requests so callers don't hang.
    for (const [, p] of this.pending) {
      p.reject(new Error(`dcode process ended: ${reason}`));
    }
    this.pending.clear();
    this.activeRunBySession.clear();
    this.sessionByRun.clear();
    for (const l of this.exitListeners) {
      try {
        l(reason);
      } catch (err) {
        console.warn("[acp:dcode] exit listener threw:", err);
      }
    }
  }

  // ── JSON-RPC plumbing ─────────────────────────────────────────────────────

  private onStdout(chunk: Buffer): void {
    this.buf += chunk.toString();
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        // Non-JSON stdout line (shouldn't happen in ACP mode) — ignore.
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id as number);
      if (p) {
        this.pending.delete(msg.id as number);
        p.resolve(msg);
      }
      return;
    }

    // Server -> client request (needs a response) or notification.
    if (msg.method) {
      if (msg.id !== undefined) {
        this.handleServerRequest(msg);
      } else {
        this.handleServerNotification(msg);
      }
    }
  }

  private handleServerNotification(msg: JsonRpcMessage): void {
    if (msg.method !== "session/update") return;
    const params = msg.params as SessionUpdate | undefined;
    // The update payload can appear either directly on params (observed) or
    // nested under params.update depending on ACP peer; support both.
    const sessionId = params?.sessionId ?? (msg.params?.["sessionId"] as string | undefined);
    const update = params?.update ?? (msg.params?.["update"] as SessionUpdate["update"]);
    if (!update) return;
    const runId = sessionId ? this.activeRunBySession.get(sessionId) : undefined;
    if (!runId) return;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = update.content?.text ?? "";
        if (text) this.emit({ type: "assistant.delta", runId, text });
        break;
      }
      case "tool_call": {
        const toolId = update.toolCallId ?? "";
        const toolName = update.title ?? update.kind ?? "tool";
        this.toolMeta.set(toolId, { name: toolName, rawInput: update.rawInput });
        this.emit({
          type: "tool.started",
          runId,
          toolCallId: toolId,
          name: toolName,
          input: update.rawInput,
        });
        break;
      }
      case "tool_call_update": {
        if (update.status === "completed" || update.status === "failed") {
          const toolId = update.toolCallId ?? "";
          const meta = this.toolMeta.get(toolId);

          if (
            meta &&
            (meta.name === "write_file" || meta.name === "write") &&
            update.status === "completed"
          ) {
            const rawInput = meta.rawInput as
              | { file_path?: string; path?: string; content?: string }
              | undefined;
            const filePath = rawInput?.file_path ?? rawInput?.path;
            if (filePath) {
              // Read the file content from disk so it's available even after a restart.
              let content: string | undefined;
              try {
                content = readFileSync(filePath, "utf-8");
              } catch {
                // file may have been written outside the gateway's visibility.
              }
              this.emit({
                type: "file.created",
                runId,
                path: filePath,
                content,
              });
            }
          }

          this.emit({
            type: "tool.completed",
            runId,
            toolCallId: toolId,
            output: (update as { content?: unknown }).content,
            isError: update.status === "failed",
          });
          this.toolMeta.delete(toolId);
        }
        break;
      }
      default:
        // plan / thought / other update kinds — not surfaced yet.
        break;
    }
  }

  private handleServerRequest(msg: JsonRpcMessage): void {
    const id = msg.id!;
    const method = msg.method!;
    if (method === "session/request_permission") {
      // Security: auto-allow only write_file / write targeting paths within
      // the agent's configured workspace directory. Everything else (shell
      // execution, destructive ops, reads outside workspace) is declined.
      // This unblocks artifact creation while preserving sandbox boundaries.
      const params = msg.params as
        | {
            options?: Array<{
              optionId?: string;
              name?: string;
              kind?: string;
              toolCall?: { name?: string; input?: Record<string, unknown> };
            }>;
          }
        | undefined;
      const sessionId = msg.params?.["sessionId"] as string | undefined;
      const runId = sessionId ? this.activeRunBySession.get(sessionId) : undefined;
      if (runId) {
        this.emit({
          type: "permission.requested",
          runId,
          requestId: String(id),
          details: msg.params,
        });
      }

      // Check if this is a write_file/write into the workspace.
      // toolCall is a TOP-LEVEL param, NOT nested inside each option.
      const toolCall = msg.params?.["toolCall"] as
        | {
            title?: string;
            rawInput?: { file_path?: string; path?: string };
          }
        | undefined;
      const title = toolCall?.title ?? "";
      const targetPath =
        toolCall?.rawInput?.file_path ?? toolCall?.rawInput?.path;
      if (
        (title.startsWith("Write ") || title === "write_file") &&
        targetPath
      ) {
        const workspaceDir =
          this.config.cwd ??
          process.env["ACP_AGENT_CWD"] ??
          process.cwd();
        // Verify target is within the workspace — simple prefix check.
        if (
          targetPath.startsWith(workspaceDir + "/") ||
          targetPath.startsWith(workspaceDir)
        ) {
          const options = params?.options ?? [];
          const allow =
            options.find((o) =>
              /allow|approve|yes|confirm/i.test(
                `${o.optionId ?? ""} ${o.name ?? ""} ${o.kind ?? ""}`,
              ),
            ) ?? options[0];
          if (allow?.optionId) {
            this.respond(id, {
              outcome: { outcome: "selected", optionId: allow.optionId },
            });
            return;
          }
        }
      }

      // Default: reject or cancel.
      const options = params?.options ?? [];
      const reject = options.find((o) =>
        /reject|deny|no|cancel/i.test(
          `${o.optionId ?? ""} ${o.name ?? ""} ${o.kind ?? ""}`,
        ),
      );
      if (reject?.optionId) {
        this.respond(id, {
          outcome: { outcome: "selected", optionId: reject.optionId },
        });
      } else {
        this.respond(id, { outcome: { outcome: "cancelled" } });
      }
      return;
    }
    if (method === "fs/read_text_file") {
      // The gateway isn't the file authority here; let the agent's own tools
      // read files. Return empty so the peer falls back to its native read.
      this.respond(id, { content: "" });
      return;
    }
    if (method === "fs/write_text_file") {
      this.respond(id, {});
      return;
    }
    // Unknown request — respond with empty result to avoid hanging the peer.
    this.respond(id, {});
  }

  /** Requests that can legitimately run long (an agentic turn may involve
   *  several tool calls / permission round-trips) get a generous timeout;
   *  everything else should resolve quickly or something is actually wrong.
   *  Without this, a turn that never gets an explicit completion response
   *  from dcode (e.g. it silently stalls after a declined permission
   *  request) leaves the run — and the composer's busy state — stuck
   *  forever, with no way to recover short of the user clicking Stop. */
  private static readonly DEFAULT_TIMEOUT_MS = 30_000;
  private static readonly PROMPT_TIMEOUT_MS = 10 * 60_000;

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = DCodeAcpAdapter.DEFAULT_TIMEOUT_MS,
  ): Promise<JsonRpcMessage> {
    const proc = this.proc;
    if (!proc?.stdin || proc.exitCode !== null) {
      return Promise.reject(new Error("dcode process not available"));
    }
    const id = this.nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`dcode ${method} timed out after ${timeoutMs}ms with no response`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const proc = this.proc;
    if (!proc?.stdin || proc.exitCode !== null) return;
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private respond(id: number | string, result: unknown): void {
    const proc = this.proc;
    if (!proc?.stdin || proc.exitCode !== null) return;
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  // ── Prompt turn ───────────────────────────────────────────────────────────

  async prompt(req: AdapterPromptRequest): Promise<AdapterPromptResult> {
    await this.start(req.cwd);

    // Resolve provider session: resume if we have one, else create.
    let sessionId = req.providerSessionId;
    if (sessionId) {
      try {
        await this.request("session/load", {
          sessionId,
          cwd: req.cwd,
          mcpServers: [],
        });
      } catch {
        // Resume failed (e.g. fresh process) — fall through to create.
        sessionId = undefined;
      }
    }
    if (!sessionId) {
      const created = await this.request("session/new", { cwd: req.cwd, mcpServers: [] });
      sessionId = (created.result as { sessionId?: string } | undefined)?.sessionId;
      if (!sessionId) throw new Error("dcode session/new returned no sessionId");
    }

    this.activeRunBySession.set(sessionId, req.runId);
    this.sessionByRun.set(req.runId, sessionId);

    this.emit({ type: "turn.started", runId: req.runId });

    try {
      const res = await this.request(
        "session/prompt",
        {
          sessionId,
          prompt: [{ type: "text", text: req.text }],
        },
        DCodeAcpAdapter.PROMPT_TIMEOUT_MS,
      );
      const stopReason = (res.result as { stopReason?: string } | undefined)?.stopReason;
      if (res.error) {
        this.emit({ type: "turn.error", runId: req.runId, error: res.error.message });
      } else if (stopReason === "cancelled") {
        // Abort is surfaced as an error-ish terminal; the runtime treats the
        // user-initiated abort separately, but if the peer cancels we still
        // must terminate the run.
        this.emit({ type: "turn.completed", runId: req.runId, usage: { stopReason } });
      } else {
        this.emit({ type: "turn.completed", runId: req.runId, usage: { stopReason } });
      }
    } catch (err) {
      this.emit({
        type: "turn.error",
        runId: req.runId,
        error: err instanceof Error ? err.message : "prompt failed",
      });
    } finally {
      this.activeRunBySession.delete(sessionId);
      this.sessionByRun.delete(req.runId);
    }

    return { providerSessionId: sessionId };
  }

  abort(runId: string): void {
    const sessionId = this.sessionByRun.get(runId);
    if (!sessionId) return;
    // ACP cancel is a notification (no response).
    this.notify("session/cancel", { sessionId });
  }
}
