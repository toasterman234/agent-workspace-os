// Protocol frame types for the ACP gateway WebSocket transport.
// Mirrors packages/claw-client/src/lib/gateway/types.ts but is
// standalone — the gateway has zero dependencies on claw-client.

export interface RequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export interface EventFrame {
  type: "event";
  event: string;
  payload?: unknown;
}

export type GatewayFrame = RequestFrame | ResponseFrame | EventFrame;

// ── ACP agent types ──────────────────────────────────────────────────────

/**
 * Which gateway adapter drives this agent's process:
 *   - "json": line-delimited JSON events on stdout (Codex-style).
 *   - "acp":  JSON-RPC 2.0 Agent Client Protocol over stdio (DCode/Zed-style).
 */
export type AgentAdapter = "acp" | "json";

export interface AgentConfig {
  id: string;
  name: string;
  /**
   * Adapter discriminator. Determines how the gateway talks to the process.
   * Optional for backwards compatibility; when omitted it is inferred from
   * `type` ("codex" → "json").
   */
  adapter?: AgentAdapter;
  /**
   * Free-form agent family label ("codex", "dcode", ...). Kept broad so new
   * agents can be added via config without a code change.
   */
  type: string;
  command: string; // e.g. "codex", "dcode", or full path
  args?: string[]; // e.g. ["exec", "--json"] or ["--acp"]
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
}

/** Resolve the effective adapter for a config, inferring from `type` when unset. */
export function resolveAdapter(config: AgentConfig): AgentAdapter {
  if (config.adapter) return config.adapter;
  // Historical default: everything was Codex JSON.
  return "json";
}

export interface AgentStatus {
  id: string;
  name: string;
  type: string;
  running: boolean;
  pid?: number;
  startedAt?: string;
}

// ── Session types ────────────────────────────────────────────────────────

export interface SessionRecord {
  id: string;
  agentId: string;
  title?: string;
  createdAt: string;
  updatedAt?: string;
}

// ── Run types ─────────────────────────────────────────────────────────────

export type RunStatus = "running" | "completed" | "aborted" | "error";

export interface RunRecord {
  id: string;
  sessionId: string;
  agentId: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  prompt?: string;
  error?: string;
  response?: string;
}
