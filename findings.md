# Findings: ACP Engine Foundation

## Architecture decisions

### Registry dispatch: `Record<string, unknown>` over typed interfaces
The `EngineFactory` type accepts `Record<string, unknown>` for both config and events rather than typed interfaces. This avoids coupling the registry module to engine-specific types (OpenClawEngineConfig, OpenClawEngineEvents) while still letting each factory validate its own input. The trade-off is that type errors surface at runtime in the factory rather than at compile time in `buildEngine()`.

### `useGateway.ts` still casts to `OpenClawEngine`
The hook currently does `buildEngine(...) as OpenClawEngine` because many internal hooks (crons, notifications, session patching) reference methods only on `OpenClawEngine`, not the `Engine` interface. Phase H will split these into capability-gated hooks so the cast is no longer necessary.

### Capability flags: additive, not retroactive
Added `crons` and `notifications` to `EngineCapabilities` as optional booleans. Existing code that checks capabilities (e.g. `useCronGateway`, `useNotificationsGateway`) needs updating to gate on these flags, not just on `engineRef` being non-null. That's part of Phase H.

### ACP engine is truly a skeleton
`AcpEngine` returns empty arrays for `listAgents()`/`listModels()`, a `RUN_ERROR` stream for `sendMessage()`, and no-op for `connect()`/`disconnect()`/`abort()`. All store implementations (`conversations`, etc.) return empty/no-op results. This is intentional — the real ACP bridge will replace these with WebSocket relayed calls to the server-side gateway.

## OpenClaw-specific code still present

`useGateway.ts` exposes these OpenClaw-specific concepts that Phase H will genericize:
- Gateway auth/pairing (`onPairingRequired`, `onAuthFailed`)
- Session rows (`SessionRow`) with OpenClaw metadata
- Encoded session keys (`agent:name:scope:claw-os`)
- Gateway model defaults (`gatewayDefaultModelId`, `agentModelById`)
- Native gateway commands (`gatewayCommands`, `fetchGatewayCommands`)
- OpenClaw notifications (`onSessionChanged`, cron broadcasts)
- Agent-ID hydration behavior (`_agentIdsHydrated`)

## UI wiring gaps found during first live browser test

The Phase C-H work typechecked and built cleanly but was never exercised against a real browser until this session. Three real bugs surfaced immediately, all from the same root cause: `EngineFactory` signatures accept `(config, events)`, but two call sites — `createAcpEngine()` and the `"acp"` entry in `engines/index.ts` — only forwarded `config`, silently dropping `events`. Nothing failed loudly; the WebSocket connected and RPCs worked, so it looked functional in every non-visual check (typecheck/lint/build/gateway smoke test). Only opening the actual UI showed the symptom (stuck on "Connecting", empty sidebar). Lesson: an `Engine` factory that ignores half its parameters can't be caught by TypeScript if the parameter type is `Record<string, unknown>` — worth a lint rule or a narrower type if this pattern gets copied for a third engine.

Also found: `AcpEngine.sendMessage`/`chat.send` never passed a `sessionId`, so the gateway created a brand-new session on every message. Combined with `chat.history` returning a hardcoded `[Run ... completed]` placeholder instead of real assistant text, this meant conversations only ever "worked" live-streamed and never survived a reload. Added `AcpEngine.resolveSessionId()` (cache thread→session, reuse via `sessions.list`/`sessions.create`) and a `runs.response` column on the gateway DB — **this part is unverified**; a live test left a run stuck at `status: running` with no response persisted, so the exit-handling path needs another look before relying on it.

## Next technical decisions needed

1. **Server-side gateway**: New pnpm package at `packages/acp-gateway/` or a separate repo? Recommendation: separate package to avoid cross-contamination with the existing `claw-client`/`claw-plugin` build pipeline.
2. **WebSocket or SSE transport?**: The OpenClaw engine uses a GatewaySocket over WebSocket. ACP could use the same or SSE. WebSocket is simpler for bidirectional events.
3. **SQLite schema**: Needs to persist sessions, runs, and agent process mappings. Should be minimal — just enough to survive browser refreshes.
4. **ACP process spawning**: `child_process.spawn` with per-agent configs? Or a wrapper process manager? Recommendation: start with direct `spawn`, add a process manager if out-of-band lifecycle (restart on crash, health checks) gets complex.
