import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type { ArtifactRecord, ArtifactSummary, RunRecord, SessionRecord } from "./protocol.js";

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
      // sql.js expects a Uint8Array of the file bytes. Passing `.buffer`
      // (the underlying ArrayBuffer) is wrong for a Node Buffer: the Buffer
      // may be a view into a larger shared pool, so `.buffer` can contain
      // unrelated bytes and corrupts the load (sessions/runs silently vanish
      // on reopen). Construct a Uint8Array that exactly covers the file bytes.
      const bytes = new Uint8Array(buffer.byteLength);
      bytes.set(buffer);
      inst.db = new inst.SQL.Database(bytes);
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

    // Artifacts table — files/HTML/markdown created by agents during turns.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        agent_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL DEFAULT 'html',
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id)");

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

  // ── Artifacts ──────────────────────────────────────────────────────────

  /** Register a file written by an agent tool call as a workspace artifact. */
  createArtifact(record: {
    sessionId: string;
    agentId: string;
    runId: string;
    path: string;
    content: string;
  }): ArtifactRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const ext = record.path.split(".").pop()?.toLowerCase() ?? "";
    const kind =
      ext === "html" || ext === "htm"
        ? "html"
        : ext === "md"
          ? "markdown"
          : ext === "json" || ext === "yaml" || ext === "yml"
            ? "code"
            : "code";
    const title = record.path.split("/").pop() ?? record.path;
    this.db.run(
      "INSERT INTO artifacts (id, session_id, agent_id, run_id, kind, title, path, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [id, record.sessionId, record.agentId, record.runId, kind, title, record.path, record.content, now, now],
    );
    this.save();
    return { id, sessionId: record.sessionId, agentId: record.agentId, runId: record.runId, kind, title, path: record.path, content: record.content, createdAt: now, updatedAt: now };
  }

  listArtifacts(sessionId?: string, kind?: string): ArtifactSummary[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (sessionId) {
      clauses.push("session_id = ?");
      params.push(sessionId);
    }
    if (kind) {
      clauses.push("kind = ?");
      params.push(kind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT id, session_id, agent_id, run_id, kind, title, path, created_at, updated_at FROM artifacts ${where} ORDER BY created_at DESC`;
    const results = this.db.exec(sql, params);
    if (results.length === 0) return [];
    const rows = results[0]!;
    return rows.values.map((row) => ({
      id: row[rows.columns.indexOf("id")] as string,
      sessionId: row[rows.columns.indexOf("session_id")] as string,
      agentId: row[rows.columns.indexOf("agent_id")] as string,
      runId: row[rows.columns.indexOf("run_id")] as string,
      kind: row[rows.columns.indexOf("kind")] as string,
      title: row[rows.columns.indexOf("title")] as string,
      path: row[rows.columns.indexOf("path")] as string,
      createdAt: row[rows.columns.indexOf("created_at")] as string,
      updatedAt: row[rows.columns.indexOf("updated_at")] as string,
    }));
  }

  getArtifact(id: string): ArtifactRecord | null {
    const stmt = this.db.prepare(
      "SELECT id, session_id, agent_id, run_id, kind, title, path, content, created_at, updated_at FROM artifacts WHERE id = ?",
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
      runId: row["run_id"] as string,
      kind: row["kind"] as string,
      title: row["title"] as string,
      path: row["path"] as string,
      content: row["content"] as string,
      createdAt: row["created_at"] as string,
      updatedAt: row["updated_at"] as string,
    };
  }

  deleteArtifact(id: string): void {
    this.db.run("DELETE FROM artifacts WHERE id = ?", [id]);
    this.save();
  }
}
