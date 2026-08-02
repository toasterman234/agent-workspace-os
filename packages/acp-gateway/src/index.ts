#!/usr/bin/env node
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { GatewayDB } from "./db.js";
import { ProcessManager } from "./process-manager.js";
import { createGatewayServer } from "./server.js";
import type { AgentConfig } from "./protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

// ── Config ──────────────────────────────────────────────────────────────

const PORT = parseInt(process.env["ACP_PORT"] ?? "18791", 10);
const STATIC_DIR = process.env["ACP_STATIC_DIR"] ?? resolve(rootDir, "../claw-client/out");
const DB_PATH = process.env["ACP_DB_PATH"] ?? resolve(rootDir, "data/gateway.db");
const AGENTS_CONFIG_PATH = process.env["ACP_AGENTS_CONFIG"] ?? resolve(rootDir, "config/agents.json");

// ── Ensure DB directory exists ──────────────────────────────────────────

const dbDir = dirname(DB_PATH);
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

// ── Load agent configs ──────────────────────────────────────────────────

function loadAgentConfigs(): AgentConfig[] {
  const defaults: AgentConfig[] = [
    {
      id: "codex",
      name: "Codex",
      type: "codex",
      command: "codex",
      args: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--json", "--skip-git-repo-check"],
      enabled: true,
    },
  ];

  if (existsSync(AGENTS_CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(AGENTS_CONFIG_PATH, "utf-8"));
      if (Array.isArray(raw?.agents)) return raw.agents as AgentConfig[];
      if (Array.isArray(raw)) return raw as AgentConfig[];
      console.warn("[acp] agents config is not an array, using defaults");
    } catch (err) {
      console.warn("[acp] failed to parse agents config:", (err as Error).message);
    }
  } else {
    console.log("[acp] no agents config found at", AGENTS_CONFIG_PATH, "using defaults");
  }

  return defaults;
}

// ── Start ───────────────────────────────────────────────────────────────

async function main() {
  const db = await GatewayDB.create(DB_PATH);
  const pm = new ProcessManager();

  // Register agents
  const agentConfigs = loadAgentConfigs();
  pm.registerAll(agentConfigs);
  console.log("[acp] registered", agentConfigs.length, "agent(s):", agentConfigs.map((a) => a.id).join(", "));

  // Create server
  const server = createGatewayServer(db, pm, {
    port: PORT,
    staticDir: existsSync(STATIC_DIR) ? STATIC_DIR : resolve(rootDir, "public"),
  });

  server.listen(PORT, () => {
    console.log(`[acp] gateway listening on http://localhost:${PORT}`);
    console.log(`[acp] static dir: ${STATIC_DIR}`);
    console.log(`[acp] db: ${DB_PATH}`);

    if (!existsSync(STATIC_DIR)) {
      console.warn(`[acp] WARNING: static dir not found at ${STATIC_DIR}`);
      console.warn(`[acp] run 'pnpm build' in packages/claw-client first, then set ACP_STATIC_DIR`);
    }
  });

  // ── Graceful shutdown ───────────────────────────────────────────────────
  function shutdown() {
    console.log("\n[acp] shutting down...");
    for (const agent of pm.listStatuses()) {
      if (agent.running) pm.kill(agent.id);
    }
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
