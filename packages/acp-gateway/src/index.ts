#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterRegistry } from "./adapters/registry.js";
import { GatewayDB } from "./db.js";
import type { AgentConfig } from "./protocol.js";
import { RunController } from "./runtime/RunController.js";
import { SessionController } from "./runtime/SessionController.js";
import { createGatewayServer } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

// ── Config ──────────────────────────────────────────────────────────────

const PORT = parseInt(process.env["ACP_PORT"] ?? "18791", 10);
const STATIC_DIR = process.env["ACP_STATIC_DIR"] ?? resolve(rootDir, "../claw-client/out");
const DB_PATH = process.env["ACP_DB_PATH"] ?? resolve(rootDir, "data/gateway.db");
const AGENTS_CONFIG_PATH =
  process.env["ACP_AGENTS_CONFIG"] ?? resolve(rootDir, "config/agents.json");
const AGENT_CWD = process.env["ACP_AGENT_CWD"] ?? process.cwd();

// ── Ensure DB directory exists ──────────────────────────────────────────

const dbDir = dirname(DB_PATH);
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

// ── Load agent configs ──────────────────────────────────────────────────

function loadAgentConfigs(): AgentConfig[] {
  // Defaults: DCode (ACP) preferred/first, Codex (JSON) present but secondary.
  // No hardcoded home-directory paths — commands are resolved from PATH.
  const defaults: AgentConfig[] = [
    {
      id: "dcode",
      name: "DCode",
      adapter: "acp",
      type: "dcode",
      command: "dcode",
      args: ["--acp"],
      enabled: true,
    },
    {
      id: "codex",
      name: "Codex",
      adapter: "json",
      type: "codex",
      command: "codex",
      args: [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--json",
        "--skip-git-repo-check",
      ],
      enabled: true,
    },
  ];

  if (existsSync(AGENTS_CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(AGENTS_CONFIG_PATH, "utf-8"));
      const agents = Array.isArray(raw?.agents) ? raw.agents : Array.isArray(raw) ? raw : null;
      if (agents) return agents as AgentConfig[];
      console.warn("[acp] agents config is not an array, using defaults");
    } catch (err) {
      console.warn("[acp] failed to parse agents config:", (err as Error).message);
    }
  } else {
    console.info("[acp] no agents config at", AGENTS_CONFIG_PATH, "— using defaults");
  }
  return defaults;
}

// ── Start ───────────────────────────────────────────────────────────────

async function main() {
  const db = await GatewayDB.create(DB_PATH);
  const registry = new AdapterRegistry();
  const runs = new RunController(db);
  const sessions = new SessionController(db);

  // Reset any run left 'running' by a previous (possibly crashed) gateway.
  const orphans = runs.reconcileOrphans();
  if (orphans.length > 0) {
    console.warn(`[acp] reset ${orphans.length} orphaned running run(s) at startup`);
  }

  const agentConfigs = loadAgentConfigs();
  registry.registerAll(agentConfigs);
  console.info(
    "[acp] registered",
    agentConfigs.length,
    "agent(s):",
    agentConfigs.map((a) => `${a.id}[${a.adapter ?? "json"}]`).join(", "),
  );

  const server = createGatewayServer(
    { db, registry, runs, sessions, agentCwd: AGENT_CWD },
    { port: PORT, staticDir: existsSync(STATIC_DIR) ? STATIC_DIR : resolve(rootDir, "public") },
  );

  server.listen(PORT, () => {
    console.info(`[acp] gateway listening on http://localhost:${PORT}`);
    console.info(`[acp] static dir: ${STATIC_DIR}`);
    console.info(`[acp] db: ${DB_PATH}`);
    console.info(`[acp] agent cwd: ${AGENT_CWD}`);
    if (!existsSync(STATIC_DIR)) {
      console.warn(`[acp] WARNING: static dir not found at ${STATIC_DIR}`);
      console.warn(`[acp] build claw-client first, then set ACP_STATIC_DIR`);
    }
  });

  function shutdown() {
    console.info("\n[acp] shutting down...");
    registry.disconnectAll();
    db.close();
    server.close();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[acp] failed to start:", err);
  process.exit(1);
});
