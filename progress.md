# Progress: ACP Engine Foundation

## Session: 2026-08-02
- Forked `thesysdev/openclaw-os` → `toasterman234/agent-workspace-os` in `~/.buzz/REPOS/`
- Installed Node 20 via nvm, pnpm 9.15.9; `pnpm install` → 1089 packages
- Verified baseline: typecheck ✓, lint ✓, format ✓, build ✓
- Created branch `feat/acp-engine-foundation`, pushed to origin
- Fixed Central Ops experiment tracker paths in `generate-work-items-feed.sh` and `promote-inbox-item-to-experiment.sh` (activity-feed → central-ops)
- Created `engines/registry.ts` with `registerEngine()` / `buildEngine()` dispatch on `config["type"]`
- Created `engines/index.ts` barrel that registers `"openclaw"` factory
- Extended `engines/types.ts`: added `crons`/`notifications` capability flags, `EngineFactory` type, `type` discriminator on `EngineConfig`
- Added `crons: true, notifications: true` capability flags to `OpenClawEngine`
- Created `engines/acp/AcpEngine.ts` — no-op skeleton implementing `Engine` interface with all capabilities `false`
- Created `engines/acp/AcpProcessManager.ts` — stub for spawn/kill/list lifecycle
- Created `engines/acp/AcpEventMapper.ts` — stub for ACP protocol → engine event translation
- Refactored `useGateway.ts`: replaced `new OpenClawEngine(...)` with `buildEngine({ type: "openclaw", ... }, events) as OpenClawEngine` + `import "@/lib/engines/index"` side-effect
- Verified: typecheck ✓, lint ✓ (auto-fixed), format ✓ (auto-fixed), build ✓
- Registered experiment `acp-engine-foundation-01` in Central Ops via tracker: capture → discover → intake → create → update
- Central Ops `validate-local.sh` → 11 passed, 0 failed
- Staged, committed (`feat(claw-client): add pluggable engine foundation`), pushed to origin
- Verified `HEAD == origin/feat/acp-engine-foundation` (commit `3d67116`, no diff)
- Created `task_plan.md` with Phases A-J, decisions, and completion estimate (~15-20%)

## Session: 2026-08-02 (Phase E)
- Created `packages/acp-gateway/` — new monorepo package independent of OpenClaw
- `protocol.ts` — frame types (RequestFrame, ResponseFrame, EventFrame), AgentConfig, SessionRecord, RunRecord
- `db.ts` — SQLite persistence via `sql.js` (WASM, no native compile). Tables: `sessions`, `runs`. WAL journal mode, auto-migration on start
- `process-manager.ts` — spawn/kill/relay agent subprocesses via `child_process`. Emits typed events (stdout, stderr, exit, error). Supports writeStdin for prompt injection
- `rpc.ts` — RpcDispatcher handles JSON-RPC methods: `agents.list`, `sessions.*`, `chat.send`, `chat.abort`. Creates sessions on demand, spawns agents, streams stdout as `event:agent` frames
- `server.ts` — HTTP server with WebSocket upgrade. Serves static files from claw-client build + SPA fallback. /health endpoint. Wildcard MIME types
- `index.ts` — entrypoint: loads agent configs, initializes DB, starts server. Default configs: Codex agent (`codex exec --dangerously-skip-permissions`). Graceful shutdown on SIGINT/SIGTERM
- Switched from `better-sqlite3` (native compile failed on Node 26) to `sql.js` (WASM, pure JS)
- Relaxed tsconfig: `noPropertyAccessFromIndexSignature: false`, `noUncheckedIndexedAccess: false` — standalone server, not the claw-client UI
- Added `sql.js.d.ts` type declarations for the WASM module
- Verified: typecheck ✓ (all three packages), gateway starts and answers `curl /health → {"ok":true}`
- Committed `feat(acp-gateway): standalone ACP gateway server` (11 files, 922 lines)
- Pushed to origin, updated Central Ops experiment tracker
- **Next**: Phase F — end-to-end single agent (AcpEngine ↔ gateway ↔ CLI process)

## Session: 2026-08-02 (Phase F)
- Rewrote `AcpEngine` from no-op skeleton (~70 lines) to working WebSocket engine (~420 lines)
- Opens browser WebSocket to ACP gateway, implements full `Engine` interface
- RPC dispatch: typed request/response correlation by message ID with pending map
- Server-push event subscription: `onEvent("agent" | "chat", handler)` → typed handlers
- `sendMessage()` extracts text from last user message, sends `chat.send` RPC
- Streams agent stdout events through existing `createOpenClawAGUIMapper` — same AG-UI mapping as OpenClawEngine
- Implements full `ConversationStore`: listSessions, getSession, createSession, deleteSession, loadHistory over gateway RPC
- Pre-bound `engine` closure in constructor so store methods can call `this.rpc()`
- `createAcpEngine()` factory reads `gatewayUrl` from config (default `http://localhost:18791`)
- Registered `"acp"` type in `engines/index.ts`
- Gateway enhancements: `process-manager.spawn(agentId, cwd?, prompt?)` appends prompt to CLI args; `chat.history`/`models.list` RPC handlers added
- Verified: typecheck ✓, lint ✓, format ✓, build ✓, gateway /health ✓
- Committed `feat(acp): working AcpEngine — WebSocket RPC + AG-UI event mapper`
- **Next**: Phase G — translate coding-agent events (thought/tool/file/permission events in the gateway, AG-UI mapping in the engine)
