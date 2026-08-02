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

## Next technical decisions needed

1. **Server-side gateway**: New pnpm package at `packages/acp-gateway/` or a separate repo? Recommendation: separate package to avoid cross-contamination with the existing `claw-client`/`claw-plugin` build pipeline.
2. **WebSocket or SSE transport?**: The OpenClaw engine uses a GatewaySocket over WebSocket. ACP could use the same or SSE. WebSocket is simpler for bidirectional events.
3. **SQLite schema**: Needs to persist sessions, runs, and agent process mappings. Should be minimal — just enough to survive browser refreshes.
4. **ACP process spawning**: `child_process.spawn` with per-agent configs? Or a wrapper process manager? Recommendation: start with direct `spawn`, add a process manager if out-of-band lifecycle (restart on crash, health checks) gets complex.
