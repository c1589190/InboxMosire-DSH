# Delivery report — InboxMosire → DSH v2 multi-binding adapter with bounded summary wake

Scope: `/home/cna/InboxMosire-DSH` only. The backend, its HTTP/SSE/MCP contract,
and the program side were not modified. No backend logic was copied; the adapter
never claims, completes, pushes, reads payload/payloadRef, or speaks MCP.

## 1. Files and key locations

| File | Role |
|---|---|
| `index.js` | Engine row: config, v2 state load/migration, manager creation, host event wiring, `/inbox` command (`apply` :111, `createManager` :61, `wireHostEvents` :33). |
| `lib/manager.js` | Multi-binding manager: `BindingManager` :24, `start` :59, `bind` :90, `unbind` :177, `retry` :194, `startBinding` :219, `stopBinding` :307, occupancy :327/:360, lifecycle :401/:451/:465, status :543/:565. |
| `lib/bindings.js` | Descriptor validation and token refs: `tokenRefPath` :45, `loadBindingToken`, `validateDescriptor` :130. |
| `lib/state.js` | v2 host state: `emptySummary` :27, `normalizeSummary` :43, `emptyHostState`/`normalizeBinding`/`normalizeHostState` (v1→v2); generic `StateStore.loadDocument`. |
| `lib/adapter.js` | Per-binding engine: SSE, status, bounded summary read/degrade/dedupe, followup, backoff, lifecycle (`readSummary` :633, `recordSummaryFailure` :672, `deliverWake` :711). |
| `lib/inbox-client.js` | Read-only client: `getItems` :285, safe projection `normalizeItems` :148, status, occupancy, SSE parser/heartbeat/reconnect. |
| `lib/template.js` | Bounded summary template (`renderSummarySection` :151, `renderWakeTemplate` :213) and legacy no-summary body. |
| `lib/commands.js` | `/inbox status\|bind\|unbind\|retry` over the manager. |
| `tools.js` | `inbox_adapter_status\|bind\|unbind`; descriptor/tokenRef arguments. |
| `lib/runtime.js` | In-process manager bridge between the engine row and the tool row. |
| `test/summary.test.mjs` | 23 summary tests: client, template, config, degrade/forbidden, restart, two-binding isolation. |
| `test/manager.test.mjs` | Migration, isolation, occupancy, rebind, dispose, unbind, cold resume, restart, summary status. |
| `test/real-backend.test.mjs` | Live app-a/app-b isolation/occupancy/restart, token migration, bounded summary wake. |
| `scripts/acceptance-acp.mjs` | Real DSH host, two ACP sessions, tool-driven binding. |
| `docs/ACCEPTANCE.md` | Full v2 evidence. |

## 2. Host capabilities used

Same Host surface as v1, plus tool registration; full citations in
`docs/HOST-CAPABILITIES.md`.

- `agent.followup()` (`runtime-types.d.ts:192`) — one call per due wake.
- `agent/status` (`:252`), `session/event` `turn/end`, `agent/created` (`:227`),
  `agent/disposed` (`:240`), `workspace/session-stop`.
- `agent.id` / `agent.session.id` for authoritative binding keys.
- `ctx.tools.register()` (`dsh-tools` `ToolDefinition`, `:115-128`, `agent` at
  `:229`) for the three adapter tools.
- Occupancy is a backend endpoint; the adapter calls it, the host is unaware.

## 3. v1 → v2 state migration

- The document is now `{version:2, bindings:{sessionRef: binding}, legacyV1}`.
- A v1 document is preserved verbatim under `legacyV1`; if it names a session and
  a usable legacy token reference exists (configured `tokenFile`), that session
  becomes a v2 binding with its cursor/watermark.
- A v1 binding without a usable token reference is kept and marked
  `blocked: {code:'TOKEN_REF_MISSING'}` — visible in status, never silently
  dropped, never woken.
- Newer versions are refused; corrupt JSON is refused without overwriting.
- Existing v2 bindings are validated individually; an invalid one is kept
  `blocked` and does not affect the others.

## 4. Bind / unbind / status and the command

- `inbox_adapter_bind(sessionId?, inboxId, adapterTokenRef, apiBaseUrl?, channels?, label?, descriptor?)`
  loads the token **before** persisting; an unreadable/relative ref fails the
  bind and leaves the previous binding intact. Same-inbox re-bind keeps the
  cursor/watermark; a different inbox resets that session only.
- `inbox_adapter_unbind(sessionId?)` stops only that engine, clears its
  occupancy, and leaves other bindings untouched.
- `inbox_adapter_status()` returns the caller's binding (inbox, cursor, SSE,
  occupancy, last wake, config error) plus summaries of the others. No token.
- `/inbox status|bind <descriptor.json | inboxId tokenRef [channels]>|unbind|retry`.

## 5. Per-binding SSE and wake isolation

- One `InboxAdapter` engine and one `InboxClient` per binding; one SSE stream,
  one cursor (`lastEventId`), one revision pair, one `lastWake`/`pendingWake`,
  one backoff ladder, one `wakeInFlight` guard.
- Startup per binding: `GET status` → at most one wake → SSE with that binding's
  `Last-Event-ID`; reconnect and `INVALID_CURSOR` recovery are per binding.
- `agent/status` and `session/event` are routed by session id to the owning
  engine; `agent/disposed`/`session-stop` stop only that engine and clear its
  occupancy.
- Each binding also owns its summary diagnostics (`summary` record); a forbidden
  token affects only that binding and never blocks its wakes.

## 6. Bounded summary wake (2026-10-26)

Per wake decision, with `available > 0` only:

```text
tokenRef -> GET /status -> GET /items?limit=summaryMaxItems
          -> filter by status/binding channels -> bounded summary -> one followup
```

- `InboxClient.getItems` uses the existing `Authorization` header, appends the
  binding's channel filters, reuses the client response-size cap, and projects
  each row to exactly `itemId/channel/kind/title`; payload/payloadRef never enter
  the process (client :148/:285).
- `InboxAdapter.readSummary` runs after the revision dedupe/backoff gates, so an
  empty board, an active turn, an already-woken revision, or a backoff window
  makes **no** `/items` request (adapter :633, :711).
- A summary failure is recorded in `binding.summary` and the wake continues with
  the no-summary body. 5xx/timeout/network/protocol set `state=degraded` and are
  retried only on the next revision; 401/403 set `SUMMARY_FORBIDDEN`, persist,
  and skip `/items` until re-bind or `/inbox retry` (adapter :672, state :27/:43,
  manager bind/retry reset).
- Titles and all summary fields are untrusted: control characters/newlines are
  removed, title length and the whole block are bounded, and rows are JSON
  encoded; empty titles fall back to `kind/channel` (template :151/:213).
- `summaryEnabled`/`summaryMaxItems`/`summaryMaxTitleChars`/`summaryMaxTotalChars`
  resolve from row config, `INBOX_SUMMARY_*`, the local file, or defaults
  (config :229–:270).
- `/inbox status` and the adapter status tool print the config, the last outcome
  (`ok/empty/degraded/forbidden/disabled`), `shown/remaining`, timestamp, code,
  and message; item titles are never stored or logged (adapter :1162/:1221,
  manager :527/:590).

## 7. Live acceptance

| Command | Result |
|---|---|
| `node --test` | **101/101 pass** (live tests included while the daemon was up) |
| `node --test test/real-backend.test.mjs` | **3/3 pass** — two-session isolation/restart, legacy-token 403 vs reissued 200, bounded 3-line summary with remaining count |
| `node scripts/acceptance-acp.mjs` | **all assertions passed** — S1→app-a, S2→app-b via the model tool; pushes wake only the matching session; archive S1 clears only app-a; S2 wakes again; session logs contain only their own inbox wakes; boards left clean |
| `node scripts/privacy-scan.mjs` | **PASS** — 41 repo files, adapter artifacts, 6 host logs, 881 session transcripts, 15 wake messages, 10 credentials, 0 hits |

Raw evidence: `docs/ACCEPTANCE.md`, `/tmp/inbox-mosire-summary/`, and the older
ACP artifacts in `/tmp/inbox-mosire-acp/`.

## 8. Unverified, degraded, blocked

- **Item 11 is partial**: no program-owned MCP server is running on this
  machine. The adapter correctly never claims/completes; claim/complete was
  exercised through the program's own HTTP client surface with the program
  tokens (the same calls `InboxClientMcpTools` wraps), not through an MCP
  transport.
- The **web profile** still runs the pre-upgrade v1 module generation in its
  live process. The linked package, patch, and state load v2 on the next DSH
  restart. The central InboxMosire MCP connection was disconnected for Mode A.
- Wakes require a live agent; cold sessions start on resume.
- Delivery is at-most-once per revision; a crash between persisting intent and
  `followup()` loses one wake rather than duplicating it.
- Occupancy is advisory; a token without `inbox:occupy` logs a warning and wakes
  continue.

## 9. Token leakage check

`scripts/privacy-scan.mjs` reads all ten local credential files (including both
reissued wake tokens and the legacy-scope proof token) and scans the repository,
the adapter state/config/log, DSH host logs, the complete decompressed content of
every session log (881), and every adapter wake message (15). Result: **PASS**, 0
credential hits. Summary titles are allowed only in the wake message; state and
logs store counts/codes only. Per-binding tokens are loaded from their
`file:` refs, used only in the `Authorization` header, registered with the
redacting logger, and never written to state, logs, wake messages, or the
repository.
