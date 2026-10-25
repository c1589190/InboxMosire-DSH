# Delivery report — InboxMosire → DSH wake adapter

Scope: `/home/cna/InboxMosire-DSH` (adapter only). The InboxMosire backend and
its v1 HTTP/SSE/MCP contract were not modified. No backend logic was copied and
the adapter never calls MCP.

---

## 1. Changed files and key locations

| File | Role |
|---|---|
| `index.js` | Host plugin entry: config/state assembly, host event wiring, `/inbox` registration. `apply()` at `index.js:144`, `createAdapter()` at `:52`, `wireHostEvents()` at `:36`. |
| `lib/adapter.js` | Wake state machine. `InboxAdapter` at `:76`; startup (`:166`), binding (`:228`, `:269`), lifecycle (`:353`, `:381`, `:400`, `:436`, `:447`), decision (`:503`), delivery (`:588`), turn-end re-evaluation (`:682`), SSE frame intake (`:724`), debounce (`:746`), connect/reconnect (`:791`, `:850`), auth/config failure (`:913`, `:956`), diagnostics (`:1003`, `:1040`). |
| `lib/inbox-client.js` | Read-only v1 client. `getStatus()` (`:131`), `streamEvents()` SSE parser/heartbeat/cursor, error classification (`:26`, `:89`). |
| `lib/state.js` | Atomic, versioned state. `emptyState()` (`:24`), `normalizeState()` migration/refusal (`:82`), `StateStore` (`:141`). |
| `lib/template.js` | Fixed wake template (`:59`), idempotency key (`:87`), message id (`:99`), immutable `UserMessage` (`:117`), channel sanitization (`:38`). |
| `lib/config.js` | Precedence and validation (`:156`), token loading (`:329`), redaction (`:360`). |
| `lib/commands.js` | `/inbox status\|bind\|unbind\|pause\|resume\|retry` (`:29`, `:81`); status now reports the caller and `isBound`. |
| `tools.js` | Model-facing `inbox_adapter_status`, `inbox_adapter_bind`, `inbox_adapter_unbind`; a separate loader row that delegates to the `/inbox` command. |
| `lib/log.js` | Redacting JSONL logger with rotation and an in-memory tail (`:27`). |
| `cordis.patch.yml` | Bundle patch that inserts the `inbox-mosire-adapter` row. |
| `package.json` / `locale/*.json` / `icon.svg` | Bundle manifest, display metadata, artwork. |
| `test/…` | 66 tests: unit, fake host + fake server, live backend, tool surface, manifest. |
| `test/helpers/mcp.mjs`, `scripts/acceptance-acp.mjs` | Acceptance harness (Agent stand-in and real ACP host driver). |
| `scripts/privacy-scan.mjs` | Credential/content leak scan. |
| `docs/HOST-CAPABILITIES.md`, `docs/ACCEPTANCE.md` | Host probe and acceptance evidence. |

## 2. DSH host capability conclusions

Verified against `@deepseek-ai/*@0.2.1-rc.2` installed packages via the Host
Inspect providers and the package type declarations. Full citations in
`docs/HOST-CAPABILITIES.md`.

1. **Authoritative session id** — `agent.id: SessionId` / `agent.session.id`
   (`runtime-types.d.ts:139-147`, `types.d.ts:11`).
2. **Turn start/end/idle** — `agent/status` `{agent, status: 'idle'|'running'}`
   (`runtime-types.d.ts:252`, `:90`), plus `agent/turn-stopping` (`:387`) and
   the durable `session/event` `turn/end` (`dsh-session/.../index.d.ts:61`).
3. **Resume/archive/delete** — `agent/created` with `source: startup|resume|clear|compact`
   (`:227`), `agent/disposed` (`:240`), `workspace/session-stop`
   (`dsh-workspace/.../index.d.ts:110`).
4. **Wake entry** — `agent.followup(message: UserMessage): void`
   (`runtime-types.d.ts:192`), the exact API the contract asks for; precedent in
   `dsh-schedule/lib/index.js:1586-1596`.
5. **Idempotency key** — **not provided by the host.** The adapter implements
   `inbox:<id>:revision:<n>:session:<ref>` itself and gates on persisted
   watermarks.
6. **State location** — a host-wide binding does not fit a per-session
   `storageDomain`, so the adapter keeps a dedicated atomic document under
   `$DSH_HOME/inbox-mosire/`.

**Conclusion: not degraded.** No acceptance item is blocked by a missing host
capability; the only gap (host-native followup idempotency) is covered by
adapter state.

## 3. Persisted state and migration

- Location: `$DSH_HOME/inbox-mosire/state.json` (default
  `/home/cna/.dsh/inbox-mosire/state.json`), atomic `tmp` + `rename`, mode 0600.
- Shape: `version`, `inboxId`, `sessionRef`, `channels`, `lastEventId`,
  `lastObservedRevision`, `lastWokenRevision`, `enabled`, `lastStatus`,
  `lastWake`, `pendingWake`, `wake {attempts, stalls, nextWakeAllowedAt}`,
  `health {sse, reconnects, lastError, configError, session}`.
- Migration: unversioned/older documents are normalized field by field; a
  document whose `inboxId` differs, whose JSON is corrupt, or whose `version` is
  newer is **refused without being overwritten** (`lib/state.js:82-139`,
  `:141-196`).
- `pendingWake` recovery treats an interrupted delivery as delivered
  (at-most-once), matching the contract's "same revision never wakes twice".

## 4. SSE and lifecycle implementation

Startup: load state → validate binding → `GET status` → at most one wake →
open SSE with `Last-Event-ID` (only after the status read, because a connect
without a cursor starts at the tip).

- Frames are parsed as a real SSE stream (multi-line `data:`, comments,
  `id:`, `event:`), with a heartbeat watchdog. Events are **invalidations
  only**; every decision re-reads `status`.
- Burst events are debounced (300 ms default) into one decision; decisions are
  serialized through one promise chain.
- Reconnect uses exponential backoff with jitter and keeps the last successful
  event id. `INVALID_CURSOR` drops the cursor and reconnects from the tip.
- 401/403/404 → stop SSE, record `configError`, no automatic wakes;
  `/inbox retry` clears it.
- `agent/status` idle and `session/event` `turn/end` both trigger the turn-end
  reconciliation; `agent/created` rebinds/reconnects; `agent/disposed` and
  `workspace/session-stop` stop delivery immediately and mark the binding
  not-live/archived.
- One unfinished wake at a time (`wakeInFlight` + 10-minute guard), one wake per
  revision (`lastWokenRevision` + `lastWake.key`), no-progress exponential
  backoff, and fail-closed behavior when the session is unknown or cold.

## 5. Real acceptance commands and results

| Command | Result |
|---|---|
| `node --test` | **66/66 pass**, exit 0 |
| `node --test test/real-backend.test.mjs` | **2/2 pass** against the live daemon on `smoke` (empty board, one wake, claim/complete, dedupe, offline push + restart replay, claim 2 / complete 1 / remaining wake, bad token) |
| `node scripts/acceptance-acp.mjs` | **all assertions passed** on a real DSH host: 2 pushes during an 8 s active turn, one wake 508 ms after turn end (seq 29 > turn/end seq 24), Agent called `inbox_list` → `inbox_claim` → `inbox_complete`, board drained in 4.3 s, exactly one `inbox-mosire` wake message in the durable log, archived session push produced no wake |
| `node scripts/privacy-scan.mjs` | **PASS** across 34 repo files, adapter state/config/log, DSH host logs, and the full decompressed content of 875 session logs (0 credential hits) plus 3 wake messages |
| `plugin_manager install_bundle /home/cna/InboxMosire-DSH` | `application: applied`, `warnings: []`; after the tool-row reinstall the live adapter restored `绑定已加载 {cursor:118}` and `SSE 已连接 {cursor:118}` |
| live tool calls | `inbox_adapter_status` → `isBound=true`; `inbox_adapter_bind` → 已绑定; `mcp__inbox-mosire__inbox_list` → `{count:0}` |
| `mcp_connector_configure` | `inbox-mosire` → `http://127.0.0.1:18766/mcp`, connected; 7 `inbox_*` tools cached and injected (`mcp__inbox-mosire__*`) |

Full logs and exact output: `docs/ACCEPTANCE.md`, `/tmp/inbox-mosire-acp/`
(`acceptance.txt`, `adapter.log`, `state.json`, `dsh.stderr.log`), the durable
session log under `~/.dsh/sessions/--tmp-inbox-mosire-acp-workspace--/`, and
`~/.dsh/inbox-mosire/{state.json,adapter.log}`.

## 6. Unverified, degraded, or blocked

- **Not degraded.** No contract item is blocked.
- Wakes require a **live** agent. A cold session is woken on resume, never
  resurrected by the adapter; this is a deliberate fail-closed choice.
- The `/inbox` command's visual appearance in the Web composer was not verified
  with browser control. Its registration and behavior are covered by the plugin
  entry test and the live profile load.
- The **Web profile** is now fully wired: the engine is bound to the live
  session `session-5d2eb5b6-…` with an open SSE connection, the native
  `inbox_adapter_*` tools are registered, and the InboxMosire MCP server is
  configured so `inbox_list`/`inbox_claim`/`inbox_complete` are available as
  `mcp__inbox-mosire__*`.
- Exposing `inbox_adapter_bind`/`unbind` to the model was an explicit operator
  choice; the same actions remain available to a human through `/inbox`.
- The real-host run used the `inbox-acp` test profile (shipped ACP template plus
  `test/acp-test.patch.yml`) rather than the Web UI, because ACP provides a
  scriptable, standard control surface and a real Agent/Session/turn lifecycle.
- Delivery is at-most-once per revision: a crash in the window between persisting
  intent and calling `followup()` loses that one wake instead of duplicating it.

## 7. Token leakage check

`node scripts/privacy-scan.mjs` reads all five local credential files and scans:

- every repository file (34),
- the adapter state, config, and log (3),
- the Web profile host logs (5),
- the **complete decompressed content** of every session log on this machine
  (875) for credential values,
- every adapter wake message (3) for credential *and* notification-content
  markers.

**Result: PASS.** No credential value appears anywhere in the scanned
transcripts or artifacts, and no synthetic title/payload marker appears in an
adapter artifact or wake message. The token is loaded at start, used only in the
`Authorization` header, redacted from every log line, and never written to
state, the wake message, a URL, or an error string.
