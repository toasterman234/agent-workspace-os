import type { EventFrame } from "../protocol.js";
import type { NormalizedAgentEvent } from "./NormalizedAgentEvent.js";

/**
 * Translate a protocol-neutral NormalizedAgentEvent into the wire EventFrame(s)
 * the browser AcpEngine already understands. The browser consumes two event
 * kinds:
 *   - "agent" frames: {stream, runId, seq, ts, data}
 *       streams: "assistant" | "thinking" | "tool" | "lifecycle"
 *   - "chat"  frames: {runId, sessionKey, state, stopReason?, errorMessage?}
 *
 * Keeping this mapping in one function means adapters emit only normalized
 * events and the transport shape lives in a single, testable place.
 */
export function normalizedToWire(
  ev: NormalizedAgentEvent,
  sessionKey: string,
): EventFrame[] {
  const ts = Date.now() / 1000;
  const agent = (stream: string, data: Record<string, unknown>): EventFrame => ({
    type: "event",
    event: "agent",
    payload: { stream, runId: ev.runId, seq: 0, ts, data },
  });

  switch (ev.type) {
    case "turn.started":
      return [agent("lifecycle", { phase: "started" })];

    case "assistant.delta":
      return [agent("assistant", { delta: ev.text, text: ev.text })];

    case "assistant.completed":
      return ev.text ? [agent("assistant", { delta: ev.text, text: ev.text })] : [];

    case "tool.started":
      return [
        agent("tool", {
          phase: "start",
          name: ev.name,
          toolCallId: ev.toolCallId,
          args: ev.input ?? {},
        }),
      ];

    case "tool.completed":
      return [
        agent("tool", {
          phase: "result",
          toolCallId: ev.toolCallId,
          result: ev.output ?? {},
          isError: ev.isError ?? false,
        }),
      ];

    case "file.changed":
      return [
        agent("tool", {
          phase: "result",
          name: "file_change",
          result: ev.diff ?? ev.path ?? "",
        }),
      ];

    case "permission.requested":
      return [
        agent("lifecycle", {
          phase: "permission",
          requestId: ev.requestId,
          details: ev.details,
        }),
      ];

    case "turn.completed":
      return [
        {
          type: "event",
          event: "chat",
          payload: {
            runId: ev.runId,
            sessionKey,
            seq: 0,
            state: "final",
            stopReason: "end_turn",
            usage: ev.usage,
          },
        },
      ];

    case "turn.error":
      return [
        {
          type: "event",
          event: "chat",
          payload: {
            runId: ev.runId,
            sessionKey,
            seq: 0,
            state: "error",
            stopReason: "error",
            errorMessage: ev.error,
          },
        },
      ];

    default:
      return [];
  }
}
