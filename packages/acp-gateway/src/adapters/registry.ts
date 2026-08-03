import { type AgentConfig, resolveAdapter } from "../protocol.js";
import type { AgentAdapter } from "../runtime/NormalizedAgentEvent.js";
import { CodexJsonAdapter } from "./codex/CodexJsonAdapter.js";
import { DCodeAcpAdapter } from "./dcode/DCodeAcpAdapter.js";

/**
 * AdapterRegistry — holds one long-lived AgentAdapter instance per registered
 * agent config, constructed from the config's `adapter` discriminator. This is
 * the single place that knows which concrete adapter class serves which wire
 * protocol; the rest of the runtime deals only with the AgentAdapter contract.
 */
export class AdapterRegistry {
  private configs = new Map<string, AgentConfig>();
  private adapters = new Map<string, AgentAdapter>();

  registerAll(configs: AgentConfig[]): void {
    for (const c of configs) this.configs.set(c.id, c);
  }

  getConfig(agentId: string): AgentConfig | undefined {
    return this.configs.get(agentId);
  }

  listConfigs(): AgentConfig[] {
    return [...this.configs.values()];
  }

  /** Get (or lazily construct) the adapter for an agent id. */
  get(agentId: string): AgentAdapter {
    const existing = this.adapters.get(agentId);
    if (existing) return existing;

    const config = this.configs.get(agentId);
    if (!config) throw new Error(`Agent not registered: ${agentId}`);
    if (config.enabled === false) throw new Error(`Agent not enabled: ${agentId}`);

    const adapter =
      resolveAdapter(config) === "acp"
        ? new DCodeAcpAdapter(config)
        : new CodexJsonAdapter(config);
    this.adapters.set(agentId, adapter);
    return adapter;
  }

  /** Adapter instance if one has been constructed (for status queries). */
  peek(agentId: string): AgentAdapter | undefined {
    return this.adapters.get(agentId);
  }

  /** Disconnect all live adapters (graceful shutdown). */
  disconnectAll(): void {
    for (const a of this.adapters.values()) a.disconnect();
  }
}
