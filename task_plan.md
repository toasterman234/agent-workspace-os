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
- [ ] Select agent → select project directory → start ACP process
- [ ] Initialize → create session → send prompt → stream text
- [ ] Cancel → close process
- **Do not add** artifacts, schedules, multiple agents, or elaborate UI
- **Status:** not started

### Phase G: Translate coding-agent events
Map ACP events into the existing workspace UI:
- [ ] Assistant text → streamed message
- [ ] Thought/reasoning → collapsible reasoning timeline
- [ ] Tool call → tool event card
- [ ] Terminal command → terminal activity
- [ ] File modification → diff card
- [ ] Plan update → plan panel
- [ ] Permission request → approval UI
- [ ] Completion/error → run status
- [ ] Child agent → nested run
- **Status:** not started

### Phase H: Genericize remaining OpenClaw assumptions
Split `useGateway.ts` into capability-gated hooks:
- [ ] `useEngine()` — construction and lifecycle
- [ ] `useSessions()` — session list/CRUD
- [ ] `useRuns()` — run state, send/abort, event dispatch
- [ ] `useModels()` — model listing and selection
- [ ] `useArtifacts()` — artifact store (optional capability)
- [ ] `useNotifications()` — gated on `capabilities.notifications`
- [ ] `useSchedules()` — gated on `capabilities.crons`
- **Status:** not started

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
- [ ] Add Codex/Claude/Gemini/Pi/OpenCode configurations
- [ ] Add install detection and health checks
- [ ] Add safe environment-variable handling
- [ ] Add mobile/Tailscale authentication
- **Status:** not started

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
