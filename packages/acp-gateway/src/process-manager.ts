import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AgentConfig, AgentStatus } from "./protocol.js";

export interface ProcessEvent {
  agentId: string;
  type: "stdout" | "stderr" | "exit" | "error";
  data: string;
  code?: number | null;
  pid?: number;
}

/**
 * Manages ACP agent subprocesses. Each agent gets one spawned process.
 * Events are emitted when a process writes to stdout/stderr or exits.
 */
export class ProcessManager extends EventEmitter {
  private processes = new Map<string, ChildProcess>();
  private agentConfigs = new Map<string, AgentConfig>();

  // The event emitter is used for process events typed as ProcessEvent
  declare emit: (event: "process", payload: ProcessEvent) => boolean;
  declare on: (event: "process", listener: (payload: ProcessEvent) => void) => this;
  declare off: (event: "process", listener: (payload: ProcessEvent) => void) => this;

  /** Register agent configs for later spawning. */
  register(config: AgentConfig): void {
    this.agentConfigs.set(config.id, config);
  }

  /** Register multiple agent configs. */
  registerAll(configs: AgentConfig[]): void {
    for (const c of configs) this.register(c);
  }

  /** Spawn a registered agent. Emits process events.
   *  If prompt is provided, it's appended as an extra argument
   *  (works for `codex exec <prompt>` and similar CLI tools). */
  spawn(agentId: string, cwd?: string, prompt?: string): ChildProcess {
    const config = this.agentConfigs.get(agentId);
    if (!config) throw new Error(`Agent not registered: ${agentId}`);
    if (!config.enabled && config.enabled !== undefined)
      throw new Error(`Agent not enabled: ${agentId}`);

    const existing = this.processes.get(agentId);
    if (existing && existing.exitCode === null) {
      return existing; // already running
    }

    const args = [...(config.args ?? [])];
    if (prompt) args.push(prompt);
    const env = { ...process.env, ...config.env };
    const workDir = cwd ?? config.cwd ?? process.cwd();

    console.log(`[acp:pm] spawning ${config.command} ${args.join(" ")} in ${workDir}`);
    const proc = spawn(config.command, args, {
      cwd: workDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.processes.set(agentId, proc);

    const pid = proc.pid;

    proc.stdout?.on("data", (chunk: Buffer) => {
      this.emit("process", { agentId, type: "stdout", data: chunk.toString(), pid });
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      this.emit("process", { agentId, type: "stderr", data: chunk.toString(), pid });
    });

    proc.on("error", (err: Error) => {
      this.emit("process", { agentId, type: "error", data: err.message, pid });
      this.processes.delete(agentId);
    });

    proc.on("exit", (code: number | null) => {
      this.emit("process", { agentId, type: "exit", data: `exited with code ${code}`, code, pid });
      this.processes.delete(agentId);
    });

    return proc;
  }

  /** Kill a running agent process. */
  kill(agentId: string): boolean {
    const proc = this.processes.get(agentId);
    if (!proc) return false;
    proc.kill("SIGTERM");
    this.processes.delete(agentId);
    return true;
  }

  /** Write to an agent process's stdin. */
  writeStdin(agentId: string, data: string): boolean {
    const proc = this.processes.get(agentId);
    if (!proc?.stdin) return false;
    proc.stdin.write(data);
    return true;
  }

  /** Return status of all registered agents. */
  listStatuses(): AgentStatus[] {
    const result: AgentStatus[] = [];
    for (const [id, config] of this.agentConfigs) {
      const proc = this.processes.get(id);
      result.push({
        id,
        name: config.name,
        type: config.type,
        running: proc !== undefined && proc.exitCode === null,
        pid: proc?.pid,
      });
    }
    return result;
  }

  /** Check if an agent is currently running. */
  isRunning(agentId: string): boolean {
    const proc = this.processes.get(agentId);
    return proc !== undefined && proc.exitCode === null;
  }
}
