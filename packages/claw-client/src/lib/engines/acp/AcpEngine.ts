import type {
  AgentInfo,
  ConversationStore,
  Engine,
  EngineCapabilities,
  EngineConfig,
  ModelInfo,
} from "../types";

const log = (...args: unknown[]) => console.info("[claw:acp-engine]", ...args);
const warn = (...args: unknown[]) => console.warn("[claw:acp-engine]", ...args);

/**
 * AcpEngine is a no-op skeleton implementing the Engine interface.
 * It is registered as the "acp" engine type but produces empty results
 * for all operations. Intended as the foundation for the ACP protocol
 * bridge.
 */
export class AcpEngine implements Engine {
  readonly id: string;

  readonly capabilities: EngineCapabilities = {
    loadSession: false,
    listSessions: false,
    deleteSessions: false,
    multiAgent: false,
    sessionConfig: false,
    artifacts: false,
    apps: false,
    uploads: false,
    crons: false,
    notifications: false,
  };

  constructor(config: EngineConfig) {
    this.id = config.id;
    log("AcpEngine initialized", this.id);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    log("connect (no-op)");
  }

  async disconnect(): Promise<void> {
    log("disconnect (no-op)");
  }

  // ── Orchestration ──────────────────────────────────────────────────────

  async listAgents(): Promise<AgentInfo[]> {
    warn("listAgents not implemented");
    return [];
  }

  async listModels(): Promise<ModelInfo[]> {
    warn("listModels not implemented");
    return [];
  }

  async sendMessage(
    _sessionId: string,
    _messages: unknown[],
    _abortController: AbortController,
  ): Promise<Response> {
    warn("sendMessage not implemented — returning error stream");
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(
          encoder.encode(
            JSON.stringify({
              type: "RUN_ERROR",
              message: "ACP engine not yet implemented",
            }) + "\n",
          ),
        );
        ctrl.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  async abort(_sessionId: string): Promise<void> {
    // no-op
  }

  // ── Conversations ──────────────────────────────────────────────────────

  readonly conversations: ConversationStore = {
    listSessions: async () => [],
    getSession: async () => null,
    createSession: async (agentId: string) => ({
      id: "",
      agentId,
      createdAt: new Date().toISOString(),
    }),
    deleteSession: async () => {},
    renameSession: async () => {},
    loadHistory: async () => [],
    getSessionConfig: async () => ({}),
    setSessionConfig: async () => {},
  };
}

/** Factory for use with EngineRegistry. */
export function createAcpEngine(config: EngineConfig): AcpEngine {
  return new AcpEngine(config);
}
