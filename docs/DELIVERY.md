# Delivery report — InboxMosire → DSH v2 adapter with summary/content wake and WebUI panel

Scope: `/home/cna/InboxMosire-DSH` only. The backend, its HTTP/SSE/MCP contract,
and the program side were not modified. No backend logic was copied; the adapter
never claims, completes, pushes, reads content/payload/payloadRef, or speaks MCP.

## 1. Files and key locations

| File | Role |
|---|---|
| `index.js` | Engine row: config, v2 state load/migration, manager creation, host event wiring, `/inbox` command (`apply` :111, `createManager` :61, `wireHostEvents` :33). |
| `lib/manager.js` | Multi-binding manager: `BindingManager` :24, `start` :59, `bind` :90, `unbind` :177, `retry` :194, `startBinding` :219, `stopBinding` :307, occupancy :327/:360, lifecycle :401/:451/:465, status :543/:565. |
| `lib/bindings.js` | Descriptor validation and token refs: `tokenRefPath` :45, `loadBindingToken`, `validateDescriptor` :130. |
| `lib/state.js` | v2 host state: `emptySummary` :27, `normalizeSummary` :43, `emptyHostState`/`normalizeBinding`/`normalizeHostState` (v1→v2); generic `StateStore.loadDocument`. |
| `lib/panel.js` | Authenticated Web UI bridge: `PANEL_CHANNEL` `/inbox-mosire`, count-only `status` handler and refresh path. |
| `client.js` | Browser dock panel in `conversation.input.dock`: locale dictionaries, 5s poll, mount/refresh `GET /status`, hidden when unbound, `程序 MCP 未挂载` state. |
| `lib/adapter.js` | Per-binding engine: SSE, status, bounded summary read/degrade/dedupe, followup, backoff, lifecycle (`readSummary` :633, `recordSummaryFailure` :672, `deliverWake` :711). |
| `lib/inbox-client.js` | Read-only client: `getItems` :285, safe projection `normalizeItems` :148 (summary-first, legacy title fallback, content dropped), status, occupancy, SSE. |
| `lib/template.js` | Bounded `summary` template (`renderSummarySection` :151, `renderWakeTemplate` :213) and legacy no-summary body. |
| `lib/commands.js` | `/inbox status\|bind\|unbind\|retry` over the manager. |
| `tools.js` | `inbox_adapter_status\|bind\|unbind`; descriptor/tokenRef arguments. |
| `lib/runtime.js` | In-process manager bridge between the engine row and the tool row. |
| `test/summary.test.mjs` | 28 summary tests: summary/title fallback, template, config, degrade/forbidden, restart, two-binding isolation, update. |
| `test/panel.test.mjs` | Host panel projection/RPC validation/refresh/no-throw. |
| `test/program-tools.test.mjs` | Wake warning/state for `programMcp` available vs missing. |
| `test/turn-end.test.mjs` | Running turn defers injection; a new revision bypasses no-progress backoff at turn end. |
| `test/client-panel.test.mjs` | Client bundle registration, locale parity, rendered bound/unbound states. |
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
- `ctx.connection.rpc.handle('/inbox-mosire', …)` (optional) + the Client
  `conversation.input.dock` slot for the Web UI count panel; the browser calls
  `ctx.connection.rpc.call` with the authenticated cookie.

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
- While a turn is active, SSE only marks the binding dirty; at turn end one
  reconcile runs, and a new revision bypasses the no-progress backoff so the
  catch-up wake is ~300ms plus request latency instead of 30s+.

## 6. Bounded summary wake (2026-10-26)

Per wake decision, with `available > 0` only:

```text
tokenRef -> GET /status -> GET /items?limit=summaryMaxItems
          -> filter by status/binding channels -> bounded summary -> one followup
```

- `InboxClient.getItems` uses the existing `Authorization` header, appends the
  binding's channel filters, reuses the client response-size cap, and projects
  each row to exactly `itemId/channel/kind/summary`; `summary` wins, legacy
  `title` is the fallback, and `content`/`payload`/`payloadRef` never enter the
  process (client :148/:285).
- `InboxAdapter.readSummary` runs after the revision dedupe/backoff gates, so an
  empty board, an active turn, an already-woken revision, or a backoff window
  makes **no** `/items` request (adapter :633, :711).
- A summary failure is recorded in `binding.summary` and the wake continues with
  the no-summary body. 5xx/timeout/network/protocol set `state=degraded` and are
  retried only on the next revision; 401/403 set `SUMMARY_FORBIDDEN`, persist,
  and skip `/items` until re-bind or `/inbox retry` (adapter :672, state :27/:43,
  manager bind/retry reset).
- Summary text is untrusted: control characters/newlines are removed, text
  length and the whole block are bounded, and rows are JSON encoded; empty
  summaries fall back to `kind/channel` (template :151/:213).
- `summaryEnabled`/`summaryMaxItems`/`summaryMaxTitleChars`/`summaryMaxTotalChars`
  resolve from row config, `INBOX_SUMMARY_*`, the local file, or defaults
  (config :229–:270).
- `/inbox status` and the adapter status tool print the config, the last outcome
  (`ok/empty/degraded/forbidden/disabled`), `shown/remaining`, timestamp, code,
  and message; item summary text is never stored or logged (adapter :1162/:1221,
  manager :527/:590).

## 7. WebUI inbox panel

- `BindingManager.panelStatus(sessionId)` returns one binding's `inboxId`,
  `available`, `claimed`, `revision`, SSE state, and errors; it never returns
  item ids, summaries, content, payloads, or the token. `refreshPanelStatus`
  performs one read-only `GET /status` for the mount/refresh path.
- `index.js` registers the optional Host Connection RPC channel `/inbox-mosire`
  only when `connection` exists, so headless/ACP compositions are unaffected.
- `client.js` registers the dock entry at order 30 in
  `conversation.input.dock`, uses `ctx.connection.rpc.call`, follows theme
  tokens, registers `zh`/`en` copy, hides when unbound, and polls every 5s.
- Live registration was observed after the Web Host restart. The panel has a
  manual **挂载 / 卸载** button when `programMcpConnectorKey` is set.
  **卸载** disables the connector and calls Host RPC `suspend`, stopping the
  binding engine, clearing occupancy, and persisting `enabled=false`; the row
  stays as `Inbox 已卸载` with a mount control. **挂载** enables the connector
  and calls `resume`, which reloads the token, starts status/SSE, and re-PUTs
  occupancy. The toggle is single-flight with a 15s abort and no token reaches
  the browser.
- The button's client half needs one client reload after this code change.

## 8. Program MCP diagnostic

- `InboxAdapter.recordProgramMcp` asks the live agent's tool schema whether
  `inbox_claim`/`inbox_list`/`inbox_view` is visible (including MCP-prefixed
  names), stores `health.programMcp`, and adds a warning to the wake only when
  it is `missing`; the wake is still delivered.
- `inbox_adapter_status` re-probes the caller's schema so a stale `missing`
  diagnostic can clear without waiting for a new wake.
- `state.js` persists only `{state, at}` for `programMcp`; `manager.panelStatus`
  exposes the state and `/inbox status` prints it. The Client strip shows
  `程序 MCP 未挂载` when missing.
- A temporary program-owned stdio MCP for app-a (8 tools, program token) was
  attached through the DSH connector for the live test:
  `status/list/view/claim/complete` succeeded (revision 294→296), wake had no
  warning and `programMcp=available`.
- After disconnecting the MCP, a new item (revision 297) produced a wake with
  the missing-tool warning and `programMcp=missing`; the item was drained via
  the program token and the connector was removed.
- The adapter does **not** inject or call business tools. Automatic MCP
  attachment remains outside the adapter, as Mode A requires.

## 9. Live connector + Bot session (6b71f6b, 2026-10-27)

- Connector `custom-iibot` was repaired in place: `streamable-http`,
  `http://127.0.0.1:8765/mcp/bot`, Bearer auth stored in the local connector
  credential, scope `simulation2`
  (`c0c85162-96b8-4d28-b222-39bb023f5be4`); 24 `mcp__iibot__*` tools.
- Target Bot session was rebound with `wakeMode: view-ack`; its request header
  contained all 24 tools and `programMcp=available`.
- The revision-166 wake was view-ack, contained no `inbox_claim`, and used
  `inbox_list` / `inbox_view`.
- The target Agent still chose its `scripts/06-mcp.sh` path and called
  `inbox_claim`, then released before `bot_thread_ack`. `bot_reply` and
  `bot_thread_ack` returned `ok:true`, but the no-claim requirement was not
  honored by the Agent. This is target-program prompt/Skill behavior; the
  adapter cannot prevent a shell fallback. The target prompt must be updated
  to use the native tools and never claim.
- The no-claim requirement is therefore **not fully accepted** end-to-end even
  though the DSH side (wake text, mode, tool detection) is correct.

## 10. Live acceptance

| Command | Result |
|---|---|
| `node --test` | **121/121 pass** (live tests included while the daemon was up) |
| `node --test test/real-backend.test.mjs` | **3/3 pass** — isolation/restart, legacy-token 403 vs reissued 200, bounded 3-line summary, `inbox_view` + `inbox_update` new-summary wake |
| `node scripts/acceptance-acp.mjs` | **all assertions passed** — S1→app-a, S2→app-b via the model tool; pushes wake only the matching session; archive S1 clears only app-a; S2 wakes again; session logs contain only their own inbox wakes; boards left clean |
| `node scripts/privacy-scan.mjs` | **PASS** — see §10 for the final counts |

Raw evidence: `docs/ACCEPTANCE.md`, `/tmp/inbox-mosire-summary/`, and the older
ACP artifacts in `/tmp/inbox-mosire-acp/`.

## 11. Unverified, degraded, blocked

- **Target no-claim behavior is unresolved**: the Bot Agent used its shell
  `06-mcp.sh inbox_claim` path and release+ack despite the view-ack wake. The
  adapter cannot block a shell fallback; update the target prompt/Skill or
  start a fresh Bot session with no-claim instructions.
- **Panel button live display** still needs a client reload after the button
  code change; unit coverage and the Host path are in place.
- **Suspended binding scope**: the connector toggle affects the configured
  connector scope; it is not a per-session MCP isolation mechanism.
- The **web profile** still runs the pre-upgrade v1 module generation in its
  live process. The linked package, patch, and state load v2 on the next DSH
  restart. The central InboxMosire MCP connection was disconnected for Mode A.
- Wakes require a live agent; cold sessions start on resume.
- Delivery is at-most-once per revision; a crash between persisting intent and
  `followup()` loses one wake rather than duplicating it.
- Occupancy is advisory; a token without `inbox:occupy` logs a warning and wakes
  continue.

## 12. Token leakage check

`scripts/privacy-scan.mjs` reads all ten local credential files and scans 50
repository files, 3 adapter state/config/log files, 6 DSH host logs, 899 session
logs (183 wake messages), and every adapter wake message. Result: **PASS**, 0
credential hits.
Summary text is allowed only in the wake message; state and logs store
counts/codes only. Content is excluded from the client projection and appears
only in a program's own view/claim path. Per-binding tokens are loaded from their
`file:` refs, used only in the `Authorization` header, registered with the
redacting logger, and never written to state, logs, wake messages, or the
repository.

## v1.6 wakeMode and program-MCP attachment

- `inbox_adapter_bind` now accepts DSH-local `wakeMode: claim|view-ack`.
  `view-ack` never puts `inbox_claim` in the wake instructions, for programs that
  use `inbox_list` / `inbox_view` and archive via their own ack path.
- `wakeMode` is persisted per binding and is not part of `BindingDescriptor`.
- Program-MCP detection now accepts `inbox_claim`, `inbox_list`, and
  `inbox_view`, including MCP-prefixed names.
- `inbox_adapter_status` re-probes the caller's tool schema instead of waiting
  for another wake, so a stale `programMcp=missing` can be cleared after the
  connector is attached.
- See `docs/PROGRAM-MCP-ATTACH.md` for connector scope/URL/Bearer setup. The
  adapter still does not auto-attach or call business tools.
- Test status: `node --test` has 121 tests; with the clean daemon/occupancy it
  passed 121/121 here. Live tests must be run only when the target daemon and
  occupancy are isolated.


## v1.7 session-level rest

- Preferred: the standard `inbox_rest` MCP tool accepts `restSeconds`; Bot programs
  using `InboxClientMcpTools` get it without an ack-schema change.
- Successful `inbox_complete`, `inbox_delete`, and `bot_thread_ack` tool results
  may also carry `restSeconds`.
- DSH sets a per-binding `restUntil`; while active it does not poll status,
  fetch summaries, or inject followups.
- `inbox_adapter_status` displays the rest deadline and remaining seconds.
- `restSeconds: 0` clears rest; max is 86400 seconds.
- Rest is adapter state and does not mute the Inbox board for other sessions.
- Bot must add the optional `restSeconds` field to its `bot_thread_ack` schema;
  Inbox's own `inbox_complete` / `inbox_delete` MCP schemas already accept it.
