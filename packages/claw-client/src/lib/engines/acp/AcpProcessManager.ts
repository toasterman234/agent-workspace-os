/**
 * AcpProcessManager — stub for managing ACP agent processes.
 *
 * Will be responsible for: spawning/lifecycling ACP-conformant agent
 * subprocesses (one per agent), monitoring their health, and relaying
 * stdin/stdout over the ACP protocol transport.
 */
export class AcpProcessManager {
  private processes = new Map<string, unknown>();

  constructor() {
    // no-op stub
  }

  /** Spawn an agent process. Future: returns process handle with stdin/stdout. */
  async spawn(agentId: string): Promise<void> {
    void agentId;
    // TODO: spawn ACP subprocess
  }

  /** Kill an agent process by id. */
  async kill(agentId: string): Promise<void> {
    this.processes.delete(agentId);
  }

  /** Return currently running agent ids. */
  listRunning(): string[] {
    return [...this.processes.keys()];
  }
}
