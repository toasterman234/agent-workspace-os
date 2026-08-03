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
- **Next**: Phase G — translate coding-agent events

## Session: 2026-08-02 (Phase G)
- Researched Codex CLI JSON event format (`codex exec --json`)
- Codex emits JSON-line events: `thread.started`, `turn.started`/`turn.completed`, `item.started`/`item.completed` with types `agent_message`, `command_execution`, `file_change`, `mcp_tool_call`, `error`
- Codex does NOT stream token-by-token — sends completed message blocks
- Created `codex-event-mapper.ts` (250+ lines) — parses JSON lines, maps to engine events:
  - `agent_message` → agent:assistant (text block)
  - `command_execution` → tool:start/tool:result (with command, exit_code, aggregated_output)
  - `file_change` → tool events (file_path, diff content)
  - `mcp_tool_call` → tool events
  - `turn.started` → agent:lifecycle (phase: started)
  - `turn.completed` → chat:final (with usage)
  - errors → item:completed error events
- Rewrote `streamRun()` in rpc.ts: buffers stdout, splits on newlines, tries JSON parse, routes non-JSON as stderr, maps JSON through mapCodexEvent
- Added fallback chat:final on process exit when turn.completed is absent
- Updated Codex defaults: `--json` + `--skip-git-repo-check` (prevents hang in non-git dirs)
- Switched prompt delivery from positional arg to stdin.write+end (more reliable for codex)
- Created test script `scripts/test-gw.cjs`: spawns gateway, connects WS, sends chat.send, verifies event flow
- End-to-end verified: health ✓, RPC ok ✓, 12 events including agent:assistant("Hello! 👋") ✓
- Committed `feat(gateway): Codex JSON event mapping`
- **Next**: Phase H — genericize remaining OpenClaw assumptions in useGateway.ts

## Session: 2026-08-02 (Phase H)
- Extended `Settings` type with `engineType?: "openclaw" | "acp"` field
- Extended `Engine` interface with 14 optional OpenClaw-specific methods: `fetchThreadList`, `patchSession`, `resetSession`, `compactSession`, `subscribeSessions`, `fetchGatewayCommands`, `listNotifications`, `markNotificationsRead`, `upsertNotification`, `listCronJobs`, `listCronRuns`, `updateCronJob`, `runCronJob`, `removeCronJob`
- Removed `reconnect` from base `Engine` — it's OpenClaw-only, called via casting
- Refactored `useGateway.ts`:
  - Reads engine type from `getSettings()?.engineType ?? "openclaw"`
  - `engineRef` typed as `Engine` instead of `OpenClawEngine`
  - Replaced `useCronGateway`/`useNotificationsGateway` sub-hooks with inline capability-gated versions
  - All OpenClaw-specific calls use optional chaining: `engineRef.current?.fetchThreadList?.()` etc.
  - `reconnect` casts to `OpenClawEngine` for the OpenClaw-specific path
  - `refreshNotifications` and `refreshCronData` return proper types matching ChatApp's expectations
  - Capability flags (`cronsCap`, `notificationsCap`) recorded from `engine.capabilities` on mount
- Result: selecting `engineType: "acp"` in settings now constructs `AcpEngine` via the registry with zero code changes
- Verified: typecheck ✓, lint ✓, format ✓, build ✓
- Committed `feat(ui): genericize useGateway`
- **Next**: Phase I — persistent apps and artifacts for the ACP gateway

## Session: 2026-08-02 (continued) — first live browser verification
- Started the gateway and opened the built UI in a real browser (Interceptor) for the first time — Phases C-H had only ever been typecheck/lint/build/smoke-test verified, never visually.
- Found "stuck on Connecting": `buildEngine()`'s `events` argument was dropped by `createAcpEngine()` and by the `"acp"` entry in `engines/index.ts`, so `onConnectionStateChange` never fired even though the WebSocket connected fine underneath. Fixed by threading `events` through both call sites; `AcpEngine` now calls `onConnectionStateChange` on open/close/error. Verified in-browser: sidebar shows "Connected — open settings" immediately.
- Found sidebar stuck on "No agents yet" / composer unusable from Home: `AcpEngine` had no `fetchThreadList()`, so the UI never had a thread to target. Added a synthetic one-thread-per-agent list from `listAgents()`, and had `AcpEngine` fire `onKnownAgentIdsChanged`/`onModelDefaultsChanged` right after connecting. Verified: "Codex" now appears in the sidebar and the composer becomes usable.
- Fixed `AcpEngine.sendMessage`/`abort` hardcoding `agentId: "codex"` regardless of which thread was active — now resolves the real agent id from the thread id.
- Sent a live message end-to-end through the UI: gateway spawned `codex exec --json`, streamed events, "Hello" rendered in the chat pane. Confirms the full round trip (browser → WS → gateway → codex → WS → AG-UI mapper → UI) works live.
- Attempted to fix conversation persistence (reload showed only the user message, not the assistant reply): added `AcpEngine.resolveSessionId()` to cache/reuse one gateway session per thread instead of creating a new one per message, and added a `runs.response` column + accumulation in `acp-gateway/rpc.ts`/`db.ts` so `chat.history` could replay real text instead of a `[Run ... completed]` placeholder.
- **This last change is unverified and possibly broken**: a test run got stuck at `status: running` in `runs` with no `response` saved — the exit-handling path in `streamRun()` isn't reliably firing/persisting. Stopped debugging at user's request; needs its own pass.
- Docs updated (this file, `task_plan.md`, `findings.md`) to reflect verified vs. unverified state before committing.
- **Next**: debug the stuck-run/response-persistence path in `acp-gateway/src/rpc.ts` (`streamRun`'s exit handler), or roll it back if not worth the complexity yet. Then continue Phase I.

## Session: 2026-08-02 (continued) — session-persistence bug fixed
- Root-caused the stuck-run bug: `GatewayDB.updateRun()` in `db.ts` had a stray `fields.push("id = ?")` appended to the SQL `SET` clause (in addition to the correct trailing `WHERE id = ?`). This shifted the bound-parameter array out of alignment with the placeholders — `sql.js` bound the values silently wrong instead of throwing, so `status`/`response`/`ended_at` were never actually written. Every run stayed `status: "running"` forever with `response: null`. Fixed by removing the stray line.
- Found a second bug while reproducing: `streamRun()`'s exit handler decided whether to send a synthetic `chat:final` by checking `!buffered.includes('"turn.completed"')` — but `buffered` only ever holds the last (usually empty) partial line at exit time, not the full stream history, so this check was almost always true. Every run that already streamed a real `turn.completed`→`chat:final` got a **second, duplicate** `chat:final` sent right after. Fixed by tracking a `sentFinal` boolean set when a real `chat:final` is mapped from Codex's `turn.completed`, and gating the synthetic fallback on that instead.
- Defensive hardening: `ProcessManager`'s `process` event now carries the spawned `pid`, and `streamRun`'s listener ignores events from any pid other than the one it spawned — guards against event cross-talk if two processes for the same `agentId` are ever briefly alive at once (not observed as a live bug, but the string-based `agentId`-only filter had no such protection).
- Verified via a new two-turn WebSocket repro script (`scripts/test-gw-2turn.cjs`) that sends two `chat.send` calls on the same session (mirrors `AcpEngine.resolveSessionId()`'s session-reuse): both turns now stream text live, both get exactly one `chat:final`, both persist `status: completed` with real `response` text, and `chat.history` correctly replays both real assistant replies (previously: only user messages ever appeared in history, no assistant replies, and turn-2 events sometimes duplicated).
- Verified: typecheck ✓ (all three packages), lint ✓, build ✓ (all three packages including Next.js production build)
- Ran `prettier --write` on the three touched acp-gateway source files (`db.ts`, `process-manager.ts`, `rpc.ts`) to bring them in line with the rest of the monorepo's formatting — `acp-gateway` has no `format:check` script of its own yet (pre-existing gap, not introduced here).
- **Next**: continue Phase I — persistent apps/artifacts for the ACP gateway. Session-persistence path is now verified working; safe to build on top of it.
