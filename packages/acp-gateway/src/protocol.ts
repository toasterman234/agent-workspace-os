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

export interface AgentConfig {
  id: string;
  name: string;
  type: "codex" | "claude" | "pi" | "gemini" | "opencode";
  command: string; // e.g. "codex" or full path
  args?: string[]; // e.g. ["exec", "--dangerously-skip-permissions"]
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
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
