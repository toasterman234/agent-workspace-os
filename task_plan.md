# Task Plan: ACP Engine Foundation

## Goal
Transform the OpenClaw OS fork (`agent-workspace-os`) into a standalone coding-agent workspace powered by CLI coding agents (Codex, Claude, Pi, etc.) via a pluggable engine architecture. Ship a functional single-agent MVP first, then expand.

## Current Phase
- **Phase A-D complete.** Fork created, engine registry/AcpEngine scaffold built, useGateway refactored, committed and pushed. Experiment registered in Central Ops.
- **Phase E next**: Build the server-side gateway.

## Phases

### Phase A: Fork & Baseline
- [x] Fork `thesysdev/openclaw-os` → `toasterman234/agent-workspace-os`
- [x] Install Node 20, pnpm 9.15+, run `pnpm install`
- [x] Verify baseline: typecheck, lint, format, build all pass
- [x] Create and push `feat/acp-engine-foundation`
- [x] Register experiment in Central Ops tracker
- **Status:** complete

### Phase B: Fix Central Ops experiment tracker paths
- [x] Update `generate-work-items-feed.sh` and `promote-inbox-item-to-experiment.sh` to use `~/central-ops/`
- [x] Verify `validate-local.sh` passes
- **Status:** complete

### Phase C: EngineRegistry + AcpEngine Skeleton
- [x] Add `engines/types.ts` changes: `crons`/`notifications` capability flags, `EngineFactory` type, `type` discriminator
- [x] Add `engines/registry.ts` — `registerEngine()` / `buildEngine()`
- [x] Add `engines/index.ts` — registers `"openclaw"` factory
- [x] Add `engines/openclaw/OpenClawEngine.ts` — add capability flags
- [x] Add `engines/acp/AcpEngine.ts` — no-op skeleton implementing `Engine`
- [x] Add `engines/acp/AcpProcessManager.ts` — stub
- [x] Add `engines/acp/AcpEventMapper.ts` — stub
- [x] Refactor `useGateway.ts` to use `buildEngine()` via registry
- [x] Verify: typecheck ✓, lint ✓, format ✓, build ✓
- **Status:** complete

### Phase D: Commit, Push, Publish
- [x] Stage engine files + useGateway.ts
- [x] Commit with human sign-off trailers
- [x] Push to `origin/feat/acp-engine-foundation`
- [x] Verify `local == origin` (same commit, no diff)
- **Status:** complete

### Phase E: Server-side gateway
Build a new Node package (packages/acp-gateway/) that:
- [x] Runs independently of OpenClaw — a standalone server process
- [x] Hosts the static claw-client workspace or exposes a WebSocket endpoint
- [x] Starts and stops ACP processes (one per agent)
- [x] Tracks runs by workspace, project, agent, and session
- [x] Relays structured events to the browser
- [x] Persists session mappings in SQLite
- [x] Survives browser refreshes
- **Status:** complete

### Phase F: End-to-end single agent
First vertical slice — one agent, not five:
- [x] AcpEngine rewritten from no-op skeleton to working WebSocket engine
- [x] Full Engine interface: connect, disconnect, listAgents, listModels, sendMessage, abort
- [x] RPC dispatch with request/response correlation
- [x] Server-push events wired through AG-UI mapper
- [x] ConversationStore over gateway sessions.* and chat.history
- [x] Gateway enhanced: prompt-as-arg, chat.history, models.list
- [x] Verified: typecheck ✓, lint ✓, format ✓, build ✓, gateway ✓
- **Status:** complete

### Phase G: Translate coding-agent events
Map Codex JSON events into structured engine event frames:
- [x] Assistant text (agent_message) → agent:assistant stream
- [x] Command execution → tool:start (command_execution) / tool:result
- [x] File modification → tool events (file_change with diff content)
- [x] MCP tool calls → tool events
- [x] Turn lifecycle → agent:lifecycle (started/completed)
- [x] Errors → item:completed error events
- [x] StreamRun parses JSON lines, buffers partial lines, routes non-JSON as stderr
- [x] Gateway defaults updated: --json + --skip-git-repo-check
- [x] Prompt sent via stdin for reliability (not positional arg)
- [x] Verified end-to-end: gateway spawns codex, streams events over WS
- **Status:** complete

### Phase H: Genericize remaining OpenClaw assumptions
Split `useGateway.ts` into capability-gated hooks:
- [x] `Settings.engineType` field drives registry dispatch ("openclaw"|"acp")
- [x] engineRef typed as `Engine` instead of `OpenClawEngine`
- [x] 14 optional OpenClaw methods added to Engine interface
- [x] All OpenClaw-only calls use optional chaining
- [x] CronGateway/NotificationsGateway replaced with inline capability-gated versions
- [x] Reconnect, session ops, gateway commands all gated
- [x] Existing OpenClaw behavior preserved unchanged
- **Status:** complete

### Phase H.1: UI wiring bugfixes (post-Phase-H)
Found and fixed while doing first live browser verification of the ACP engine:
- [x] `buildEngine()`'s `events` bundle was silently dropped by `createAcpEngine()` and the `"acp"` registry entry — `onConnectionStateChange` never fired, so the UI stayed on "Connecting" forever even though the WebSocket connected fine. Fixed by threading `events` through both call sites and having `AcpEngine` invoke the callback on open/close/error.
- [x] `AcpEngine.fetchThreadList()` didn't exist, so the sidebar always showed "No agents yet" and the home composer had no thread to target (`mainThreadId` stayed `null`). Added a synthetic one-thread-per-agent list backed by `listAgents()`, and had `AcpEngine` push `onKnownAgentIdsChanged`/`onModelDefaultsChanged` after connecting.
- [x] `AcpEngine.sendMessage`/`abort` hardcoded `agentId: "codex"` regardless of the thread clicked. Now resolves the real agent id from the thread id.
- [x] Session-persistence path debugged and fixed: `GatewayDB.updateRun()` had a stray `fields.push("id = ?")` in the SQL `SET` clause that misaligned bound parameters, so `status`/`response` were silently never written (`sql.js` didn't throw). Also fixed a duplicate-`chat:final` bug in `streamRun()`'s exit handler (was checking a nearly-always-true string match on the tail buffer instead of tracking whether a real final was already sent). Verified with a two-turn same-session repro script: both turns stream, persist, and replay correctly via `chat.history`.
- **Status:** complete — connection-state, thread-list, and session-persistence fixes all verified (persistence via scripted two-turn WS test; connection/thread-list via Interceptor browser session in the prior entry).

### Phase I: Persistent apps and artifacts
Replace OpenClaw server-side storage for ACP agents:
- [ ] `app_create` / `app_update` in SQLite
- [ ] Artifact persistence
- [ ] Upload storage
- [ ] Tool invocation bridging
- [ ] OpenUI prompt injection or agent skill
- [ ] Source linkage back to agent/session/run
- **Status:** not started

### Phase J: Hardening and additional agents
- [ ] Add mock ACP server for automated tests
- [ ] Test permission rejection and approval
- [ ] Test process crashes and reconnects
- [ ] Test simultaneous sessions
- [ ] Test multiple project directories
- [x] Add DCode (real ACP/JSON-RPC) configuration — `DCodeAcpAdapter`, registered as default agent
- [ ] Add Claude/Gemini/Pi/OpenCode configurations
- [ ] Add install detection and health checks
- [ ] Add safe environment-variable handling
- [ ] Add mobile/Tailscale authentication
- **Status:** in progress (DCode adapter added)

### Phase K: DCode ACP client + gateway restructure
Add a real second agent (DCode) speaking actual Agent Client Protocol, and split the gateway's src/ so agent-specific logic lives behind a common adapter interface instead of being hand-rolled per agent in `rpc.ts`:
- [x] Empirically probe `dcode --acp` (deepagents-code 0.1.51) wire protocol: `initialize` → `session/new`/`session/load` → `session/prompt` → `session/update` notifications → prompt response `{stopReason}`; server-initiated `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`; `session/cancel` notification for abort.
- [x] Restructure `src/` into `runtime/` (transport-agnostic: `NormalizedAgentEvent.ts`, `RunController.ts`, `SessionController.ts`, `wire.ts`) and `adapters/` (`codex/CodexJsonAdapter.ts`, `dcode/DCodeAcpAdapter.ts`, `registry.ts`)
- [x] `AgentAdapter` interface unifies both wire protocols behind one contract (`start`, `prompt`, `abort`, `onEvent`, `onExit`, `isRunning`, `pid`, `disconnect`, `capabilities`)
- [x] Moved old `process-manager.ts`/`codex-event-mapper.ts` logic into `CodexJsonAdapter`; confirmed via grep no remaining references, then `git rm`'d the orphaned flat files (logic preserved, not discarded)
- [x] `config/agents.json` — DCode registered first/default (`adapter: "acp"`), Codex second (`adapter: "json"`)
- [x] Multi-turn verification script (`scripts/test-gw-dcode-2turn.cjs`) — two `chat.send` calls on one session, confirms same subprocess pid reused across turns, both turns reach `state: final` with correct text, DB shows both runs `status: completed` with real prompt/response
- [x] Quality gates: `pnpm typecheck` ✓, `pnpm test` ✓ (7/7)
- [ ] Browser (UI) verification of the DCode thread — no browser-automation tool available this session; verified instead via the same WS protocol the UI drives (see `progress.md`)
- **Status:** adapter + restructure + config + multi-turn verification complete; browser-level confirmation outstanding

### Phase L: Surface plan/reasoning trace from DCode
Bridge DCode's ACP session updates that the adapter currently drops (`default: break` in `DCodeAcpAdapter.ts`) through to the browser's existing Work Trace UI (`AssistantMessage.tsx` ThinkingPanel), which already renders reasoning/plan rows but never receives any.

**Empirical check of `deepagents-code` 0.1.51 (`deepagents_acp/server.py`), done before scoping:**
- [x] `plan` updates (`AgentPlanUpdate`, `session_update: "plan"`) ARE real and already sent today, driven by the `write_todos` tool (`_handle_todo_update`, `_clear_plan`). This is genuinely available now.
- [x] `agent_thought_chunk` (`AgentThoughtChunk`) is defined in the underlying `acp` SDK schema but is **never constructed or sent anywhere in `deepagents_acp`** — grepped the whole package, zero hits. DCode does not currently emit reasoning/thought events at all, despite the SDK supporting the type. Building a "thinking" bridge today would wire up dead plumbing with nothing on the other end.
- [ ] `usage_update` — not yet checked; lower priority since token counts already come through some other path (UI already shows input/output token counts).

**Revised plan given that finding:**
- [ ] Sub-phase L1 (do first, real data available): map `AgentPlanUpdate`/`session_update: "plan"` in `DCodeAcpAdapter.ts` → new `plan.updated` `NormalizedAgentEvent` → wire into a plan/checklist row above the tool timeline in `AssistantMessage.tsx`. No upstream DCode changes needed.
- [ ] Sub-phase L2 (blocked on upstream): `agent_thought_chunk` → `reasoning.delta` → existing `"thinking"` stream handling in `openclaw-agui-mapper.ts` (already implemented and dormant) → existing `ReasoningDetail` rows in `AssistantMessage.tsx`. Do NOT build this against DCode until deepagents-code actually emits `agent_thought_chunk`, or find/wire an alternate source of reasoning text. Track upstream deepagents-code releases for this addition, or ask upstream if it's planned.
- [ ] Sub-phase L3: preserve intermediate `tool_call_update` states (not just terminal completed/failed) — tool kind, raw input, incremental output, timestamps — currently mostly discarded until final status.
- [ ] Sub-phase L4 (bigger, do after L1-L3 prove out): add a `run_events` table to `db.ts`, write path in `RunController.ts` (currently only accumulates `assistantText`), and rewrite `chat.history` reconstruction in `rpc.ts` (currently only replays prompt + final response text) so plan/tool/reasoning traces survive a page reload.
- [ ] Optional: raw ACP event inspector / debug view for the timeline, gated behind a toggle.
- **Status:** scoped, not started. L1 is unblocked and lowest-risk; L2 is blocked pending upstream DCode support for `agent_thought_chunk`.

## Decisions
| Decision | Rationale |
|---|---|
| Keep `OpenClawEngine` as the default adapter | Refactor is a no-op for existing users; ACP is additive. |
| Use `Record<string, unknown>` for registry dispatch | Avoids coupling registry types to engine-specific config/event shapes. |
| Single agent MVP before multi-agent | Reduces risk — prove the ACP bridge works before scaling. |

## Completion Estimate
| Scope | Status |
|---|---|
| Fork and baseline | 100% |
| Engine abstraction foundation | 100% |
| Remote publication | 100% |
| ACP runtime (server-side gateway) | 0% |
| Functional single-agent MVP | 0% |
| Full multi-agent workspace | 0% |
| **Overall** | ~15-20% |
