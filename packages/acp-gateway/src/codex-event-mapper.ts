/**
 * CodexEventMapper — parses codex exec --json lines and maps them to
 * engine event frames that the browser AcpEngine can relay through
 * the AG-UI mapper.
 *
 * Codex JSON event types (from codex exec --json):
 *   thread.started              → ignored
 *   turn.started                → lifecycle:started
 *   turn.completed              → chat:final (with usage)
 *   item.completed/agent_message → assistant text block
 *   item.started/command_execution → tool call start
 *   item.completed/command_execution → tool call result
 *   item.started/file_change    → tool call (file edit) start
 *   item.completed/file_change  → tool call (file edit) result
 *   item.completed/error        → item.error
 *
 * All events include a runId so the browser can scope them to the
 * correct stream.
 */

export interface CodexThreadStarted {
  type: "thread.started";
  thread_id: string;
}

export interface CodexTurnStarted {
  type: "turn.started";
}

export interface CodexTurnCompleted {
  type: "turn.completed";
  usage?: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  };
}

export interface CodexItemStarted {
  type: "item.started";
  item: CodexItem;
}

export interface CodexItemCompleted {
  type: "item.completed";
  item: CodexItem;
}

export interface CodexItem {
  id: string;
  type: "agent_message" | "command_execution" | "file_change" | "error" | "mcp_tool_call";
  text?: string;
  message?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: "in_progress" | "completed" | "failed" | "skipped";
  file_path?: string;
  diff?: string;
}

export type CodexEvent =
  | CodexThreadStarted
  | CodexTurnStarted
  | CodexTurnCompleted
  | CodexItemStarted
  | CodexItemCompleted;

export interface EngineEvent {
  event: string; // "chat" | "agent" | "item"
  payload: Record<string, unknown>;
}

/**
 * Map a single Codex JSON line to engine event(s).
 * Returns an array because some events (like item.completed) produce
 * multiple engine events (tool:result + tool:end).
 */
export function mapCodexEvent(line: string, runId: string): EngineEvent[] {
  let obj: CodexEvent;
  try {
    obj = JSON.parse(line) as CodexEvent;
  } catch {
    return [];
  }

  const ts = Date.now() / 1000;

  switch (obj.type) {
    case "turn.started":
      return [
        {
          event: "agent",
          payload: {
            stream: "lifecycle",
            runId,
            seq: 0,
            ts,
            data: { phase: "started" },
          },
        },
      ];

    case "turn.completed":
      return [
        {
          event: "chat",
          payload: {
            runId,
            sessionKey: "",
            seq: 0,
            state: "final",
            stopReason: "end_turn",
            usage: obj.usage,
          },
        },
      ];

    case "item.started":
      return mapItemStarted(obj.item, runId, ts);

    case "item.completed":
      return mapItemCompleted(obj.item, runId, ts);

    default:
      return [];
  }
}

function mapItemStarted(item: CodexItem, runId: string, ts: number): EngineEvent[] {
  switch (item.type) {
    case "command_execution":
      return [
        {
          event: "agent",
          payload: {
            stream: "tool",
            runId,
            seq: 0,
            ts,
            data: {
              phase: "start",
              name: "command_execution",
              toolCallId: item.id,
              args: { command: item.command ?? "" },
            },
          },
        },
      ];

    case "file_change":
      return [
        {
          event: "agent",
          payload: {
            stream: "tool",
            runId,
            seq: 0,
            ts,
            data: {
              phase: "start",
              name: "file_change",
              toolCallId: item.id,
              args: { file_path: item.file_path },
            },
          },
        },
      ];

    case "mcp_tool_call":
      return [
        {
          event: "agent",
          payload: {
            stream: "tool",
            runId,
            seq: 0,
            ts,
            data: {
              phase: "start",
              name: "mcp_tool_call",
              toolCallId: item.id,
              args: {},
            },
          },
        },
      ];

    default:
      return [];
  }
}

function mapItemCompleted(item: CodexItem, runId: string, ts: number): EngineEvent[] {
  const events: EngineEvent[] = [];

  switch (item.type) {
    case "agent_message":
      if (item.text) {
        events.push({
          event: "agent",
          payload: {
            stream: "assistant",
            runId,
            seq: 0,
            ts,
            data: { delta: item.text, text: item.text },
          },
        });
      }
      break;

    case "command_execution": {
      const isError = item.exit_code !== 0;
      events.push({
        event: "agent",
        payload: {
          stream: "tool",
          runId,
          seq: 0,
          ts,
          data: {
            phase: "result",
            name: "command_execution",
            toolCallId: item.id,
            result: item.aggregated_output ?? `exit_code: ${item.exit_code}`,
            isError,
            durationMs: undefined,
          },
        },
      });
      break;
    }

    case "file_change":
      // File change completed — emit as tool result with diff content
      events.push({
        event: "agent",
        payload: {
          stream: "tool",
          runId,
          seq: 0,
          ts,
          data: {
            phase: "result",
            name: "file_change",
            toolCallId: item.id,
            result: item.diff ?? `file_path: ${item.file_path}`,
            isError: item.status === "failed",
          },
        },
      });
      break;

    case "mcp_tool_call":
      events.push({
        event: "agent",
        payload: {
          stream: "tool",
          runId,
          seq: 0,
          ts,
          data: {
            phase: "result",
            name: "mcp_tool_call",
            toolCallId: item.id,
            result: {},
            isError: item.status === "failed",
          },
        },
      });
      break;

    case "error":
      events.push({
        event: "item",
        payload: {
          type: "item.completed",
          item: { id: item.id, type: "error", message: item.message ?? "unknown error" },
        },
      });
      break;
  }

  return events;
}
