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

Also found: `AcpEngine.sendMessage`/`chat.send` never passed a `sessionId`, so the gateway created a brand-new session on every message. Combined with `chat.history` returning a hardcoded `[Run ... completed]` placeholder instead of real assistant text, this meant conversations only ever "worked" live-streamed and never survived a reload. Added `AcpEngine.resolveSessionId()` (cache thread→session, reuse via `sessions.list`/`sessions.create`) and a `runs.response` column on the gateway DB.

**Update — root cause found and fixed.** The stuck-`running` symptom traced to a copy-paste bug in `GatewayDB.updateRun()` (`db.ts`): the SQL-builder appended a stray `fields.push("id = ?")` into the `SET` clause in addition to the correct trailing `WHERE id = ?`. This shifted the bound-values array out of alignment with the query's placeholders. `sql.js` doesn't throw on this — it just binds silently wrong — so `status`/`response`/`ended_at` were never actually written to the row, and `getRun`/`listRuns` kept reading back the original `status: "running", response: null` forever. One-line fix: remove the stray `fields.push("id = ?")`.

While reproducing, a second bug surfaced: `streamRun()`'s process-exit handler decided whether to emit a synthetic `chat:final` event by checking `!buffered.includes('"turn.completed"')`. `buffered` only ever holds the last (usually empty) partial stdout line at the moment the process exits — not the accumulated stream — so this check was true almost every time, even after a real `turn.completed` → `chat:final` had already been sent moments earlier from the JSON-line parser. Every run got a duplicate `chat:final`. Fixed by tracking an explicit `sentFinal` boolean, set when the JSON-line mapper actually emits a `chat` event, and gating the exit-handler's synthetic fallback on that instead of a buffer substring match. **Lesson for future event-stream code in this codebase: never infer "did X already happen" from what's left in a rolling parse buffer — track it with an explicit flag.**

Also added defensive pid-scoping: `ProcessManager`'s `process` events now include the spawned child's `pid`, and each `streamRun()` listener ignores events whose `pid` doesn't match the process it spawned (previously filtered only by the string `agentId`, which two concurrent runs for the same agent would share).

Verified via `scripts/test-gw-2turn.cjs` (new): two `chat.send` calls on one reused session — mirrors what `AcpEngine.resolveSessionId()` actually does — stream correctly, persist correctly (`status: completed`, real `response` text), and `chat.history` replays both turns with real assistant text. No more duplicate `chat:final`, no more stuck `running` rows.

## DCode ACP adapter + gateway restructure

### `dcode --acp` wire protocol, verified empirically (deepagents-code 0.1.51)
JSON-RPC 2.0 over stdio, same family Zed's Agent Client Protocol uses:
```
client -> initialize {protocolVersion, clientCapabilities}
       <- {protocolVersion, agentCapabilities}
client -> session/new {cwd, mcpServers:[]}  -> {sessionId}
client -> session/load {sessionId, cwd, mcpServers:[]} -> {}   (resume)
client -> session/prompt {sessionId, prompt:[{type:"text",text}]}
       <- session/update notifications:
            agent_message_chunk  {update:{sessionUpdate, content:{text}}}
            tool_call            {update:{toolCallId,title,kind,status,rawInput}}
            tool_call_update     {update:{toolCallId,status,content:[...]}}
       <- {stopReason:"end_turn"|"cancelled"}   (prompt response)
client -> session/cancel {sessionId}   (NOTIFICATION, no id) -> cancels turn

server -> session/request_permission {options:[{optionId,...}]}   (request)
server -> fs/read_text_file / fs/write_text_file  (requests)
```
One process is spawned per agent and reused across turns (multi-turn: same pid) — matches the Codex adapter's long-lived-process model. `DCodeAcpAdapter` (`packages/acp-gateway/src/adapters/dcode/DCodeAcpAdapter.ts`) never auto-approves `session/request_permission` — it surfaces the request as a normalized `permission.requested` event for observability and declines by selecting a reject/deny option when present, otherwise responds `{outcome:{outcome:"cancelled"}}`. `fs/read_text_file`/`fs/write_text_file` requests are answered with empty/no-op results — the gateway is not the file authority for DCode; DCode's own tools do the real reads/writes.

### `runtime/` vs `adapters/` split
The gateway's `src/` was flat (`process-manager.ts`, `codex-event-mapper.ts`, `rpc.ts` all Codex-shaped) and adding a second, structurally different wire protocol (JSON-RPC vs line-delimited JSON) would have meant more Codex-specific branching in `rpc.ts`. Instead:
- `runtime/` holds everything that doesn't know which agent it's talking to: `NormalizedAgentEvent.ts` (the common event vocabulary — `assistant.delta`, `tool.started`, `tool.completed`, `turn.started`, `turn.completed`, `turn.error`, `permission.requested`), `RunController.ts` (run lifecycle/persistence), `SessionController.ts` (session/provider-session-id mapping), `wire.ts` (NormalizedAgentEvent → browser wire frame).
- `adapters/` holds one directory per wire protocol, each implementing the same `AgentAdapter` interface (`start`, `prompt`, `abort`, `onEvent`, `onExit`, `isRunning`, `pid`, `disconnect`, `capabilities`): `adapters/codex/CodexJsonAdapter.ts` (the old process-manager + codex-event-mapper logic, unified), `adapters/dcode/DCodeAcpAdapter.ts` (new), `adapters/registry.ts` (`AdapterRegistry` — picks the concrete adapter class from `AgentConfig.adapter`, the only place that knows which class serves which protocol).
- `rpc.ts` and `server.ts` now depend only on `AgentAdapter`/`RunController`/`SessionController`/`AdapterRegistry` — zero remaining Codex- or DCode-specific code in the transport layer. Adding a third agent means adding a third `adapters/<name>/` directory and one line in `registry.ts`, not touching `rpc.ts`.
- Verified via grep that nothing still referenced the flat `process-manager.ts`/`codex-event-mapper.ts` files before deleting them — their logic lives on unchanged inside `CodexJsonAdapter`, so this was "isolate, don't discard," not a rewrite-and-hope.

### Multi-turn verification result
`scripts/test-gw-dcode-2turn.cjs` sends two `chat.send` calls on the same gateway session (mirrors what the browser UI's session-reuse logic does) and checks `agents.list` pid between turns. Result: turn 1 ("ALPHA") and turn 2 ("BETA") both streamed the correct text and reached `state: final`; the `dcode` entry in `agents.list` reported the same pid (`26016`) after both turns, confirming the ACP subprocess is reused, not respawned, across turns — matching the long-lived-process contract the Codex adapter already had. Direct inspection of `gateway.db`'s `runs` table after the run showed both rows with `agent_id: "dcode"`, `status: "completed"`, real `prompt`/`response` text (not placeholders), and identical `session_id`.

### Browser verification gap
No browser-automation tool (Interceptor or otherwise) was reachable in this session — confirmed by searching the available/deferred tool set, which returned no browser-control tool. Rather than claim a browser check that didn't happen, this was verified at the protocol layer instead: the gateway was started for real (`npx tsx src/index.ts`), `curl http://localhost:18791/` confirmed the built Next.js SPA (Claw client) serves its HTML shell correctly, and the DCode 2-turn script drove the exact same WebSocket RPC/event protocol (`chat.send`, `session/update`-derived events, `chat:final`) the browser UI uses. What remains unverified is purely visual/UX: does the DCode thread render correctly in the sidebar and composer. Manual steps for whoever picks this up: `ACP_AGENTS_CONFIG=packages/acp-gateway/config/agents.json pnpm --filter @agent-workspace/acp-gateway dev`, open the served UI in a real browser, select/create the "DCode" thread, send a message, confirm streamed text renders and a reload replays history correctly (the same checks Phase H.1 did for Codex).

## Next technical decisions needed

1. **Server-side gateway**: New pnpm package at `packages/acp-gateway/` or a separate repo? Recommendation: separate package to avoid cross-contamination with the existing `claw-client`/`claw-plugin` build pipeline.
2. **WebSocket or SSE transport?**: The OpenClaw engine uses a GatewaySocket over WebSocket. ACP could use the same or SSE. WebSocket is simpler for bidirectional events.
3. **SQLite schema**: Needs to persist sessions, runs, and agent process mappings. Should be minimal — just enough to survive browser refreshes.
4. **ACP process spawning**: `child_process.spawn` with per-agent configs? Or a wrapper process manager? Recommendation: start with direct `spawn`, add a process manager if out-of-band lifecycle (restart on crash, health checks) gets complex.
