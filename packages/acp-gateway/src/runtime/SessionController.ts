import type { GatewayDB } from "../db.js";
import type { SessionRecord } from "../protocol.js";

/**
 * SessionController — a thin, intention-revealing wrapper over the session
 * rows in GatewayDB. It exists so the rpc layer and RunController depend on a
 * small session API rather than reaching into the DB directly, and so
 * provider-session bookkeeping has a single home.
 *
 * Provider session ids (e.g. an ACP `sessionId`) are cached in-memory keyed by
 * the gateway session id. They are intentionally NOT persisted: a provider
 * process is per-gateway-lifetime, so a resumed provider session only makes
 * sense within one gateway run. On restart, a fresh provider session is created
 * while the persisted transcript (runs) is still served from the DB.
 */
export class SessionController {
  private providerSessionByGatewaySession = new Map<string, string>();

  constructor(private db: GatewayDB) {}

  create(agentId: string, title?: string): SessionRecord {
    return this.db.createSession(agentId, title);
  }

  get(id: string): SessionRecord | null {
    return this.db.getSession(id);
  }

  list(agentId?: string): SessionRecord[] {
    return this.db.listSessions(agentId);
  }

  delete(id: string): void {
    this.providerSessionByGatewaySession.delete(id);
    this.db.deleteSession(id);
  }

  /**
   * Resolve an existing session or create one on demand. Mirrors the previous
   * rpc `handleChatSend` behaviour: a missing/unknown session id creates a
   * fresh session for the agent.
   */
  resolveOrCreate(agentId: string, sessionId?: string): SessionRecord {
    if (sessionId) {
      const existing = this.db.getSession(sessionId);
      if (existing) return existing;
    }
    return this.db.createSession(agentId);
  }

  getProviderSessionId(gatewaySessionId: string): string | undefined {
    return this.providerSessionByGatewaySession.get(gatewaySessionId);
  }

  setProviderSessionId(gatewaySessionId: string, providerSessionId: string): void {
    this.providerSessionByGatewaySession.set(gatewaySessionId, providerSessionId);
  }
}
