import type { GatewayDB } from "../db.js";
import type { RunRecord } from "../protocol.js";
import type { NormalizedAgentEvent } from "./NormalizedAgentEvent.js";

/**
 * RunController — owns run lifecycle and the invariant that "no run stays
 * 'running' forever".
 *
 * Completion is driven by NormalizedAgentEvents (turn.completed / turn.error),
 * NOT by process exit. Process exit is a fallback: `onProcessDeath` marks any
 * still-running run as error. All completion paths are idempotent — the first
 * terminal transition wins and later calls are no-ops, so a turn.completed
 * followed by a process-death fallback (or vice versa) never double-writes or
 * resurrects a finished run.
 */
export class RunController {
  /** In-memory accumulator of assistant text per run, keyed by run id. */
  private assistantText = new Map<string, string>();
  /** Run ids that have already reached a terminal state this process. */
  private finalized = new Set<string>();

  constructor(private db: GatewayDB) {}

  /** Create a new run row (status 'running') and start tracking it. */
  create(sessionId: string, agentId: string, prompt?: string): RunRecord {
    const run = this.db.createRun(sessionId, agentId, prompt);
    this.assistantText.set(run.id, "");
    return run;
  }

  /**
   * Fold a normalized event into run state. Accumulates assistant text and, on
   * a terminal event, persists the final run row. Returns true if this call
   * finalized the run (useful for the relay to stop listening).
   */
  ingest(ev: NormalizedAgentEvent): boolean {
    switch (ev.type) {
      case "assistant.delta": {
        const prev = this.assistantText.get(ev.runId) ?? "";
        this.assistantText.set(ev.runId, prev + ev.text);
        return false;
      }
      case "assistant.completed": {
        if (ev.text !== undefined) {
          // A completed block replaces the streamed accumulation for this run
          // when the adapter provides the full text (Codex item.completed).
          this.assistantText.set(ev.runId, ev.text);
        }
        return false;
      }
      case "file.created": {
        // Register the written file as a workspace artifact so the UI's
        // Artifacts panel can display it without requiring OpenClaw plugin tools.
        if (ev.path && ev.content) {
          // We need the sessionId and agentId — they live on the run record.
          const run = this.db.getRun(ev.runId);
          if (run) {
            this.db.createArtifact({
              sessionId: run.sessionId,
              agentId: run.agentId,
              runId: ev.runId,
              path: ev.path,
              content: ev.content,
            });
          }
        }
        return false;
      }
      case "turn.completed": {
        return this.complete(ev.runId);
      }
      case "turn.error": {
        return this.error(ev.runId, ev.error);
      }
      default:
        return false;
    }
  }

  /** Idempotently mark a run completed with its accumulated response. */
  complete(runId: string): boolean {
    if (this.finalized.has(runId)) return false;
    this.finalized.add(runId);
    const response = this.assistantText.get(runId);
    this.db.updateRun(runId, {
      status: "completed",
      response: response && response.length > 0 ? response : undefined,
    });
    this.assistantText.delete(runId);
    return true;
  }

  /** Idempotently mark a run errored. */
  error(runId: string, message: string): boolean {
    if (this.finalized.has(runId)) return false;
    this.finalized.add(runId);
    this.db.updateRun(runId, { status: "error", error: message });
    this.assistantText.delete(runId);
    return true;
  }

  /** Idempotently mark a run aborted (user-initiated stop). */
  abort(runId: string): boolean {
    if (this.finalized.has(runId)) return false;
    this.finalized.add(runId);
    const response = this.assistantText.get(runId);
    this.db.updateRun(runId, {
      status: "aborted",
      response: response && response.length > 0 ? response : undefined,
    });
    this.assistantText.delete(runId);
    return true;
  }

  /**
   * Crash fallback. Given a set of run ids that were active on a process that
   * just died, mark any still-running run as error. Idempotent no-op for runs
   * already finalized by a terminal event.
   */
  onProcessDeath(runIds: Iterable<string>, reason: string): string[] {
    const failed: string[] = [];
    for (const runId of runIds) {
      if (this.finalized.has(runId)) continue;
      const run = this.db.getRun(runId);
      if (run && run.status === "running") {
        this.error(runId, `agent process ended before completing the turn (${reason})`);
        failed.push(runId);
      }
    }
    return failed;
  }

  /**
   * Sweep the DB for any run left 'running' (e.g. from a previous gateway that
   * crashed) and mark it error. Called once at startup so stale runs never
   * linger. Returns the ids it reset.
   */
  reconcileOrphans(): string[] {
    const orphans = this.db.listRuns().filter((r) => r.status === "running");
    for (const r of orphans) {
      this.db.updateRun(r.id, {
        status: "error",
        error: "run was still 'running' at gateway startup (previous process ended)",
      });
    }
    return orphans.map((r) => r.id);
  }

  /** Current accumulated assistant text for a run (for the relay's final send). */
  currentText(runId: string): string {
    return this.assistantText.get(runId) ?? "";
  }
}
