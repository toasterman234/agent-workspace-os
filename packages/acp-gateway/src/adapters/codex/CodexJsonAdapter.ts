import { spawn, type ChildProcess } from "node:child_process";
import type { AgentConfig } from "../../protocol.js";
import type {
  AdapterCapabilities,
  AdapterPromptRequest,
  AdapterPromptResult,
  AgentAdapter,
  NormalizedAgentEvent,
} from "../../runtime/NormalizedAgentEvent.js";

/**
 * CodexJsonAdapter — wraps the existing `codex exec --json` behaviour behind
 * the generic AgentAdapter interface. Codex-specific event names
 * (agent_message, command_execution, file_change, turn.completed, ...) are
 * mapped to NormalizedAgentEvents *here* and never leak into the runtime.
 *
 * Unlike the ACP adapter, `codex exec` runs one turn per process and exits, so
 * each `prompt()` spawns a fresh process. The process's exit is the natural
 * turn terminator; if the JSON stream already emitted turn.completed, the exit
 * is a no-op at the RunController (idempotent completion).
 */

interface CodexItem {
  id: string;
  type: string;
  text?: string;
  message?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  file_path?: string;
  diff?: string;
}

interface CodexEvent {
  type: string;
  item?: CodexItem;
  usage?: unknown;
}

export class CodexJsonAdapter implements AgentAdapter {
  readonly agentId: string;
  readonly capabilities: AdapterCapabilities = {
    resumeSession: false,
    toolCalls: true,
    permissions: false,
  };

  private config: AgentConfig;
  private proc: ChildProcess | null = null;
  private eventListeners = new Set<(ev: NormalizedAgentEvent) => void>();
  private exitListeners = new Set<(reason: string) => void>();
  private activeRunId: string | null = null;

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
        console.warn("[codex] event listener threw:", err);
      }
    }
  }

  // Codex has no persistent server; start() is a no-op. Each prompt spawns.
  async start(_cwd: string): Promise<void> {
    return;
  }

  disconnect(): void {
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    this.proc = null;
  }

  async prompt(req: AdapterPromptRequest): Promise<AdapterPromptResult> {
    return new Promise<AdapterPromptResult>((resolve) => {
      const args = [...(this.config.args ?? [])];
      const env = { ...process.env, ...this.config.env };
      const workDir = this.config.cwd ?? req.cwd ?? process.cwd();

      console.info(`[codex] spawning ${this.config.command} ${args.join(" ")} in ${workDir}`);
      const proc = spawn(this.config.command, args, {
        cwd: workDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = proc;
      this.activeRunId = req.runId;

      let buffered = "";
      let sawTerminal = false;

      this.emit({ type: "turn.started", runId: req.runId });

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{")) return;
        let obj: CodexEvent;
        try {
          obj = JSON.parse(trimmed) as CodexEvent;
        } catch {
          return;
        }
        for (const ev of this.mapCodexEvent(obj, req.runId)) {
          if (ev.type === "turn.completed" || ev.type === "turn.error") sawTerminal = true;
          this.emit(ev);
        }
      };

      proc.stdout?.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) console.warn("[codex:stderr]", text.slice(0, 500));
      });

      proc.on("error", (err: Error) => {
        this.emit({ type: "turn.error", runId: req.runId, error: err.message });
        this.proc = null;
        this.activeRunId = null;
        for (const l of this.exitListeners) l(`spawn error: ${err.message}`);
        resolve({});
      });

      proc.on("exit", (code, signal) => {
        if (buffered.trim()) handleLine(buffered);
        // Fallback terminal: if the JSON stream never produced a terminal
        // event, synthesize one from the exit code. Idempotent downstream.
        if (!sawTerminal) {
          if (code === 0) {
            this.emit({ type: "turn.completed", runId: req.runId });
          } else {
            this.emit({
              type: "turn.error",
              runId: req.runId,
              error: `codex exited code=${code ?? "null"} signal=${signal ?? "null"}`,
            });
          }
        }
        this.proc = null;
        this.activeRunId = null;
        for (const l of this.exitListeners) {
          l(`exited code=${code ?? "null"} signal=${signal ?? "null"}`);
        }
        resolve({});
      });

      // Feed the prompt on stdin (matches prior behaviour for codex exec).
      if (proc.stdin && proc.exitCode === null) {
        proc.stdin.write(req.text + "\n");
        proc.stdin.end();
      }
    });
  }

  abort(runId: string): void {
    if (this.activeRunId === runId && this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }

  // ── Codex event mapping (kept internal to this adapter) ────────────────────

  private mapCodexEvent(obj: CodexEvent, runId: string): NormalizedAgentEvent[] {
    switch (obj.type) {
      case "turn.started":
        return [{ type: "turn.started", runId }];
      case "turn.completed":
        return [{ type: "turn.completed", runId, usage: obj.usage }];
      case "item.started":
        return obj.item ? this.mapItemStarted(obj.item, runId) : [];
      case "item.completed":
        return obj.item ? this.mapItemCompleted(obj.item, runId) : [];
      default:
        return [];
    }
  }

  private mapItemStarted(item: CodexItem, runId: string): NormalizedAgentEvent[] {
    switch (item.type) {
      case "command_execution":
        return [
          {
            type: "tool.started",
            runId,
            toolCallId: item.id,
            name: "command_execution",
            input: { command: item.command ?? "" },
          },
        ];
      case "file_change":
        return [
          {
            type: "tool.started",
            runId,
            toolCallId: item.id,
            name: "file_change",
            input: { file_path: item.file_path },
          },
        ];
      case "mcp_tool_call":
        return [{ type: "tool.started", runId, toolCallId: item.id, name: "mcp_tool_call" }];
      default:
        return [];
    }
  }

  private mapItemCompleted(item: CodexItem, runId: string): NormalizedAgentEvent[] {
    switch (item.type) {
      case "agent_message":
        return item.text
          ? [{ type: "assistant.completed", runId, text: item.text }]
          : [];
      case "command_execution":
        return [
          {
            type: "tool.completed",
            runId,
            toolCallId: item.id,
            output: item.aggregated_output ?? `exit_code: ${item.exit_code}`,
            isError: item.exit_code !== 0,
          },
        ];
      case "file_change":
        return [
          { type: "file.changed", runId, path: item.file_path, diff: item.diff },
          {
            type: "tool.completed",
            runId,
            toolCallId: item.id,
            output: item.diff ?? `file_path: ${item.file_path}`,
            isError: item.status === "failed",
          },
        ];
      case "mcp_tool_call":
        return [
          {
            type: "tool.completed",
            runId,
            toolCallId: item.id,
            output: {},
            isError: item.status === "failed",
          },
        ];
      case "error":
        return [{ type: "turn.error", runId, error: item.message ?? "unknown error" }];
      default:
        return [];
    }
  }
}
