import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayDB } from "./db.js";

/**
 * Real integration test for the sql.js-backed GatewayDB. Uses an on-disk
 * database in a temp dir (no mocks) so the reload-from-disk path is exercised
 * end to end — this is the path that the run-completion persistence fix
 * (commit 9d21a70) actually cares about.
 */
describe("GatewayDB", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gwdb-"));
    dbPath = join(dir, "gateway.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a session and reads it back", async () => {
    const db = await GatewayDB.create(dbPath);
    const session = db.createSession("dcode", "My Session");
    expect(session.id).toBeTruthy();
    expect(session.agentId).toBe("dcode");
    expect(session.title).toBe("My Session");

    const loaded = db.getSession(session.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(session.id);
    expect(loaded?.title).toBe("My Session");
    db.close();
  });

  it("creates a run in the running state", async () => {
    const db = await GatewayDB.create(dbPath);
    const session = db.createSession("dcode");
    const run = db.createRun(session.id, "dcode", "hello");
    expect(run.status).toBe("running");
    expect(run.prompt).toBe("hello");
    expect(run.response).toBeUndefined();
    expect(run.endedAt).toBeUndefined();
    db.close();
  });

  it("completes a run: running -> completed with response and endedAt", async () => {
    const db = await GatewayDB.create(dbPath);
    const session = db.createSession("dcode");
    const run = db.createRun(session.id, "dcode", "hi");

    db.updateRun(run.id, { status: "completed", response: "PONG" });

    const reloaded = db.getRun(run.id);
    expect(reloaded?.status).toBe("completed");
    expect(reloaded?.response).toBe("PONG");
    expect(reloaded?.endedAt).toBeTruthy();
    expect(reloaded?.error).toBeUndefined();
    db.close();
  });

  it("records an error completion with an error message", async () => {
    const db = await GatewayDB.create(dbPath);
    const session = db.createSession("dcode");
    const run = db.createRun(session.id, "dcode", "boom");

    db.updateRun(run.id, { status: "error", error: "spawn failed" });

    const reloaded = db.getRun(run.id);
    expect(reloaded?.status).toBe("error");
    expect(reloaded?.error).toBe("spawn failed");
    expect(reloaded?.endedAt).toBeTruthy();
    db.close();
  });

  it("does not corrupt the id column when updating a run (regression: stray id = ? in SET)", async () => {
    const db = await GatewayDB.create(dbPath);
    const session = db.createSession("dcode");
    const run = db.createRun(session.id, "dcode", "hi");
    const originalId = run.id;

    db.updateRun(run.id, { status: "completed", response: "done" });

    // The run must still be addressable by its original id.
    const reloaded = db.getRun(originalId);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.id).toBe(originalId);
    expect(db.listRuns(session.id)).toHaveLength(1);
    db.close();
  });

  it("persists data across a close/reopen cycle (reload from disk)", async () => {
    // Write with one instance.
    const db1 = await GatewayDB.create(dbPath);
    const session = db1.createSession("dcode", "Persistent");
    const run = db1.createRun(session.id, "dcode", "remember me");
    db1.updateRun(run.id, { status: "completed", response: "remembered" });
    db1.close();

    expect(existsSync(dbPath)).toBe(true);

    // Reopen a brand-new instance pointed at the same file.
    const db2 = await GatewayDB.create(dbPath);

    const loadedSession = db2.getSession(session.id);
    expect(loadedSession?.title).toBe("Persistent");

    const loadedRun = db2.getRun(run.id);
    expect(loadedRun?.status).toBe("completed");
    expect(loadedRun?.response).toBe("remembered");
    expect(loadedRun?.prompt).toBe("remember me");

    const sessions = db2.listSessions("dcode");
    expect(sessions.map((s) => s.id)).toContain(session.id);

    const runs = db2.listRuns(session.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.response).toBe("remembered");
    db2.close();
  });

  it("deletes a session and its runs", async () => {
    const db = await GatewayDB.create(dbPath);
    const session = db.createSession("dcode");
    db.createRun(session.id, "dcode", "one");
    db.createRun(session.id, "dcode", "two");
    expect(db.listRuns(session.id)).toHaveLength(2);

    db.deleteSession(session.id);
    expect(db.getSession(session.id)).toBeNull();
    expect(db.listRuns(session.id)).toHaveLength(0);
    db.close();
  });
});
