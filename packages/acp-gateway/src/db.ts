import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type { RunRecord, SessionRecord } from "./protocol.js";

export class GatewayDB {
  private db!: Database;
  private SQL!: SqlJsStatic;
  private dbPath: string;

  private constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  static async create(dbPath: string): Promise<GatewayDB> {
    const inst = new GatewayDB(dbPath);
    inst.SQL = await initSqlJs();
    // Load existing database or create fresh
    if (existsSync(dbPath)) {
      const buffer = readFileSync(dbPath);
      inst.db = new inst.SQL.Database(new Uint8Array(buffer).buffer);
    } else {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      inst.db = new inst.SQL.Database();
    }
    inst.migrate();
    return inst;
  }

  private save(): void {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.dbPath, buffer);
  }

  close(): void {
    this.db.close();
  }

  // ── Migrations ───────────────────────────────────────────────────────

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        prompt TEXT,
        response TEXT,
        error TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id)");
    // Migrate older databases created before `response` existed.
    const cols = this.db.exec("PRAGMA table_info(runs)");
    const hasResponse = cols[0]?.values.some((row) => row[1] === "response") ?? true;
    if (!hasResponse) {
      this.db.run("ALTER TABLE runs ADD COLUMN response TEXT");
    }
    this.save();
  }

  // ── Sessions ─────────────────────────────────────────────────────────

  createSession(agentId: string, title?: string): SessionRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.run("INSERT INTO sessions (id, agent_id, title, created_at) VALUES (?, ?, ?, ?)", [
      id,
      agentId,
      title ?? null,
      now,
    ]);
    this.save();
    return { id, agentId, title, createdAt: now };
  }

  getSession(id: string): SessionRecord | null {
    const stmt = this.db.prepare(
      "SELECT id, agent_id, title, created_at, updated_at FROM sessions WHERE id = ?",
    );
    stmt.bind([id]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return {
      id: row["id"] as string,
      agentId: row["agent_id"] as string,
      title: (row["title"] as string) ?? undefined,
      createdAt: row["created_at"] as string,
      updatedAt: (row["updated_at"] as string) ?? undefined,
    };
  }

  listSessions(agentId?: string): SessionRecord[] {
    const sql = agentId
      ? "SELECT id, agent_id, title, created_at, updated_at FROM sessions WHERE agent_id = ? ORDER BY created_at DESC"
      : "SELECT id, agent_id, title, created_at, updated_at FROM sessions ORDER BY created_at DESC";
    const results = agentId ? this.db.exec(sql, [agentId]) : this.db.exec(sql);
    if (results.length === 0) return [];
    const rows = results[0]!;
    return rows.values.map((row) => ({
      id: row[rows.columns.indexOf("id")] as string,
      agentId: row[rows.columns.indexOf("agent_id")] as string,
      title: row[rows.columns.indexOf("title")] as string | undefined,
      createdAt: row[rows.columns.indexOf("created_at")] as string,
      updatedAt: row[rows.columns.indexOf("updated_at")] as string | undefined,
    }));
  }

  deleteSession(id: string): void {
    this.db.run("DELETE FROM runs WHERE session_id = ?", [id]);
    this.db.run("DELETE FROM sessions WHERE id = ?", [id]);
    this.save();
  }

  // ── Runs ─────────────────────────────────────────────────────────────

  createRun(sessionId: string, agentId: string, prompt?: string): RunRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      "INSERT INTO runs (id, session_id, agent_id, status, prompt, started_at) VALUES (?, ?, ?, 'running', ?, ?)",
      [id, sessionId, agentId, prompt ?? null, now],
    );
    this.save();
    return { id, sessionId, agentId, status: "running", startedAt: now, prompt };
  }

  getRun(id: string): RunRecord | null {
    const stmt = this.db.prepare(
      "SELECT id, session_id, agent_id, status, prompt, response, error, started_at, ended_at FROM runs WHERE id = ?",
    );
    stmt.bind([id]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return {
      id: row["id"] as string,
      sessionId: row["session_id"] as string,
      agentId: row["agent_id"] as string,
      status: row["status"] as RunRecord["status"],
      prompt: (row["prompt"] as string) ?? undefined,
      response: (row["response"] as string) ?? undefined,
      error: (row["error"] as string) ?? undefined,
      startedAt: row["started_at"] as string,
      endedAt: (row["ended_at"] as string) ?? undefined,
    };
  }

  listRuns(sessionId?: string): RunRecord[] {
    const sql = sessionId
      ? "SELECT id, session_id, agent_id, status, prompt, response, error, started_at, ended_at FROM runs WHERE session_id = ? ORDER BY started_at DESC"
      : "SELECT id, session_id, agent_id, status, prompt, response, error, started_at, ended_at FROM runs ORDER BY started_at DESC";
    const results = sessionId ? this.db.exec(sql, [sessionId]) : this.db.exec(sql);
    if (results.length === 0) return [];
    const rows = results[0]!;
    return rows.values.map((row) => ({
      id: row[rows.columns.indexOf("id")] as string,
      sessionId: row[rows.columns.indexOf("session_id")] as string,
      agentId: row[rows.columns.indexOf("agent_id")] as string,
      status: row[rows.columns.indexOf("status")] as RunRecord["status"],
      prompt: row[rows.columns.indexOf("prompt")] as string | undefined,
      response: row[rows.columns.indexOf("response")] as string | undefined,
      error: row[rows.columns.indexOf("error")] as string | undefined,
      startedAt: row[rows.columns.indexOf("started_at")] as string,
      endedAt: row[rows.columns.indexOf("ended_at")] as string | undefined,
    }));
  }

  updateRun(
    id: string,
    patch: { status?: RunRecord["status"]; response?: string; error?: string },
  ): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (patch.status !== undefined) {
      fields.push("status = ?");
      values.push(patch.status);
    }
    if (patch.response !== undefined) {
      fields.push("response = ?");
      values.push(patch.response);
    }
    if (patch.error !== undefined) {
      fields.push("error = ?");
      values.push(patch.error);
    }
    if (fields.length === 0) return;
    fields.push("ended_at = datetime('now')");
    values.push(id);
    this.db.run(`UPDATE runs SET ${fields.join(", ")} WHERE id = ?`, values);
    this.save();
  }
}
