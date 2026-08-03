/**
 * NormalizedAgentEvent — the protocol-neutral event vocabulary that every
 * agent adapter emits. Adapters translate their wire-specific events (Codex
 * JSON items, ACP session/update notifications, ...) into this union so the
 * generic runtime (RunController, rpc dispatch) never has to know which agent
 * produced them.
 *
 * A run's lifecycle is expressed entirely through these events. In particular
 * the RunController completes/errors a run from `turn.completed` / `turn.error`
 * — NOT from process exit. Process exit is a fallback safety net only.
 */
export type NormalizedAgentEvent =
  | { type: "turn.started"; runId: string }
  | { type: "assistant.delta"; runId: string; text: string }
  | { type: "assistant.completed"; runId: string; text?: string }
  | { type: "tool.started"; runId: string; toolCallId: string; name: string; input?: unknown }
  | { type: "tool.completed"; runId: string; toolCallId: string; output?: unknown; isError?: boolean }
  | { type: "file.changed"; runId: string; path?: string; diff?: string }
  | { type: "file.created"; runId: string; path: string; content?: string }
  | { type: "permission.requested"; runId: string; requestId: string; details: unknown }
  | { type: "turn.completed"; runId: string; usage?: unknown }
  | { type: "turn.error"; runId: string; error: string };

/** Terminal events that end a run. */
export function isTerminalEvent(
  ev: NormalizedAgentEvent,
): ev is Extract<NormalizedAgentEvent, { type: "turn.completed" | "turn.error" }> {
  return ev.type === "turn.completed" || ev.type === "turn.error";
}

// ── Adapter interface ──────────────────────────────────────────────────────

/**
 * Capabilities an adapter advertises after connecting/initializing. Kept
 * intentionally small; extend as concrete needs appear.
 */
export interface AdapterCapabilities {
  /** Adapter can resume an existing provider session (ACP session/load). */
  resumeSession: boolean;
  /** Adapter surfaces tool-call events. */
  toolCalls: boolean;
  /** Adapter can request permission mid-turn. */
  permissions: boolean;
}

/** A prompt turn request handed to an adapter. */
export interface AdapterPromptRequest {
  /** Gateway run id — every emitted NormalizedAgentEvent carries this. */
  runId: string;
  /** Provider session id to resume, if the adapter supports it. */
  providerSessionId?: string;
  /** Working directory for the turn. */
  cwd: string;
  /** User prompt text. */
  text: string;
}

/** Result of a completed prompt turn. */
export interface AdapterPromptResult {
  /** Provider session id used (created or resumed) — persist for reuse. */
  providerSessionId?: string;
}

/**
 * AgentAdapter — the narrow contract both DCodeAcpAdapter and CodexJsonAdapter
 * implement. The runtime holds one adapter instance per registered agent.
 *
 * Lifecycle: `start()` once, then any number of `prompt()` turns on the same
 * long-lived process, then `disconnect()`. `onEvent` fans NormalizedAgentEvents
 * out to subscribers (the RunController + the WebSocket relay).
 */
export interface AgentAdapter {
  /** Stable agent id (matches AgentConfig.id). */
  readonly agentId: string;

  /** Capabilities, valid after `start()` resolves. */
  readonly capabilities: AdapterCapabilities;

  /** True while the underlying process is alive. */
  isRunning(): boolean;

  /** OS pid of the underlying process, if started. */
  pid(): number | undefined;

  /**
   * Spawn/connect and complete any protocol handshake (ACP `initialize`).
   * Idempotent: a second call while already running is a no-op.
   */
  start(cwd: string): Promise<void>;

  /**
   * Run one prompt turn. Emits NormalizedAgentEvents via `onEvent` as the turn
   * streams, and resolves with the provider session id when the turn's terminal
   * event has been delivered. Rejects only on transport failure (which the
   * caller maps to a turn.error).
   */
  prompt(req: AdapterPromptRequest): Promise<AdapterPromptResult>;

  /** Abort the in-flight turn for a run (best effort). */
  abort(runId: string): void;

  /** Subscribe to normalized events. Returns an unsubscribe fn. */
  onEvent(listener: (ev: NormalizedAgentEvent) => void): () => void;

  /**
   * Subscribe to process-death notifications. The runtime uses this as the
   * crash fallback: any run still `running` when the process dies is marked
   * error. `reason` is a short human-readable cause.
   */
  onExit(listener: (reason: string) => void): () => void;

  /** Kill the process and release resources. */
  disconnect(): void;
}
