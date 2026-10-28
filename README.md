# InboxMosire → DeepSeek Harness wake adapter (v2, multi-binding, summary wake)

`@mosire/dsh-inbox-mosire` is a **DSH Host plugin** that makes idle DeepSeek
Harness sessions react to InboxMosire notification boards. Version 2 implements
the multi-binding contract in
`/home/cna/InboxMosire/docs/upstream/DSH-MULTI-BINDING-PROMPT.md`:

```
one DSH host
  session-S1 ──binding──> app-a   own SSE, cursor, revision, wake watermark
  session-S2 ──binding──> app-b   own SSE, cursor, revision, wake watermark
```

Each session gets its own `InboxAdapter` engine instance, so bindings cannot
share or leak a cursor, a revision watermark, a wake, or a backoff.

Before a wake the adapter also performs one bounded summary read
(`GET /items?limit=N`) and puts up to three `itemId/channel/kind/source/summary` lines
in the wake message, so the model can often claim directly without an extra
`inbox_list`. New items carry `summary`; legacy title-only rows fall back to
`title`. Failure to read the summary never suppresses the wake.

## Boundaries (Mode A)

The adapter only:

1. reads a **BindingDescriptor** (`inboxId`, `apiBaseUrl`, `adapterTokenRef`,
   `channels`, `label`);
2. opens one SSE stream per binding;
3. reads `status` as the source of truth;
4. when `available > 0`, reads at most `summaryMaxItems` safe summary rows
   (`itemId/channel/kind/source/summary` only; `title` is the legacy fallback);
5. calls `agent.followup()` at the idle/turn-end boundary, at most once per
   revision;
6. persists each binding's cursor/revision/wake/summary diagnostics;
7. stops on archive/dispose and maintains advisory occupancy.

It never claims, completes, pushes, reads `content`/`payload`/`payloadRef`, or
speaks MCP. The
target session uses its **program-owned MCP** (Mode A) for
its own business tool set (for iiBot: `qq_conversation_read`/`qq_conversation_ack`;
for claim-style programs: `inbox_list`/`inbox_claim`/`inbox_complete`). The central InboxMosire MCP is not
exposed to target sessions. The wake token must carry `status:read`,
`events:read`, `items:read`, and `inbox:occupy`; tokens issued by
`InboxClient.issueBinding()` do. A token without `items:read` still wakes, but
its summary is disabled and recorded as `SUMMARY_FORBIDDEN`.

## Install

```bash
dsh plugin --profile web add /home/cna/InboxMosire-DSH
# or, inside a Harness session: plugin_manager install_bundle with the package dir
```

The bundle patch inserts two rows:

```yaml
- insert:
    - id: inbox-mosire-adapter
      name: '@mosire/dsh-inbox-mosire'          # bindings + SSE + followup
    - id: inbox-mosire-tools
      name: '@mosire/dsh-inbox-mosire/tools'    # inbox_adapter_* tools
```

The engine row is inert until a session is bound. No single global inbox/token
is configured: every binding carries its own descriptor.

## Bind, inspect, unbind

Model-facing tools (both rows are hot-reloadable independently):

| Tool | Arguments | Effect |
|---|---|---|
| `inbox_adapter_bind` | `sessionId?`, `inboxId`, `adapterTokenRef`, `apiBaseUrl?`, `channels?`, `label?`, `descriptor?`, `wakeMode?` | bind one session (default: caller); `wakeMode=claim` (default) or `view-ack`; same inbox keeps cursor/watermark, a different inbox resets them |
| `inbox_adapter_status` | — | caller binding (inbox/cursor/SSE/occupancy/last wake/config error) + other bindings summary; never a token |
| `inbox_adapter_unbind` | `sessionId?` | remove one binding and clear its occupancy; other bindings untouched |
| `inbox_adapter_log` | `limit?` (1–100, default 20) | this caller's binding operation log, newest first (bind/unbind/suspend/resume/retry/failed start, with inbox and `host:port`); strictly per-session; never a token, item content, or wake delivery |

Human command:

```
/inbox status
/inbox bind <descriptor.json | inboxId tokenRef [channels]>
/inbox unbind [sessionId]
/inbox retry [sessionId]        # re-read tokenRef after rotation
```

`adapterTokenRef` must be an absolute path or `file:/absolute/path`. It is read
at bind time; an unreadable or relative reference fails the bind closed and
leaves the previous binding intact. The raw token is used only in the
`Authorization` header and is redacted from every log line.

## Operation log

Every binding lifecycle event is appended to a per-session JSONL log next to
`state.json` (`opsFile`, default `ops.jsonl`, mode 0600):

- **who / what**: `bind` and `unbind` (Agent), `suspend` and `resume` (the dock
  panel, actor `user`), `retry`, a `start` failure when the token reference is
  unusable, and a `stop` when the Host disposes or archives the session
  (actor `host`, with `reason`);
- **state facts only**: `at`, `action`, `actor`, `session`, `inbox`, `endpoint`
  (`host:port`), `wakeMode`, `result`, an error code, and a short `reason`. Tokens, token paths,
  item content, summaries, and wake deliveries are never written;
- **strictly per-session**: `read(session)` filters on one session id, and no
  cross-session query exists — `inbox_adapter_log` can only ever return the
  caller's own entries;
- **bounded**: 200 entries per session and a 256 KiB rotation ceiling, so one
  busy session cannot evict another session's newest rows.

`inbox_adapter_status` prints the newest row as `lastOp:` so an Agent can see
"the panel suspended me at 13:02" without calling the log tool.

## Global configuration

Precedence: plugin-row `config` > `INBOX_*` environment > `$DSH_HOME/inbox-mosire/config.json`
> defaults.

| Setting | Environment | Default |
|---|---|---|
| `apiUrl` (fallback for descriptors) | `INBOX_API_URL` | `http://127.0.0.1:18765` |
| `stateFile` | `INBOX_STATE_FILE` | `$DSH_HOME/inbox-mosire/state.json` |
| `logFile` | `INBOX_LOG_FILE` | next to `stateFile` |
| `opsFile` | `INBOX_OPS_FILE` | next to `stateFile` (`ops.jsonl`) |
| `debounceMs` | `INBOX_WAKE_DEBOUNCE_MS` | `300` |
| `heartbeatTimeoutSeconds` | `INBOX_HEARTBEAT_TIMEOUT_SECONDS` | `45` |
| `requestTimeoutMs` | — | `10000` |
| `summaryEnabled` | `INBOX_SUMMARY_ENABLED` | `true` |
| `summaryMaxItems` | `INBOX_SUMMARY_MAX_ITEMS` | `3` (1–10) |
| `summaryMaxTitleChars` | `INBOX_SUMMARY_MAX_TITLE_CHARS` | `80` (16–200) |
| `summaryMaxTotalChars` | `INBOX_SUMMARY_MAX_TOTAL_CHARS` | `600` (120–4000) |
| `inboxId` / `tokenFile` / `sessionId` | legacy `INBOX_*` | used only for v1 state migration |

## State (v2)

`$DSH_HOME/inbox-mosire/state.json`, atomic (`tmp` + `rename`), mode 0600:

```json
{
  "version": 2,
  "bindings": {
    "session-S1": {
      "inboxId": "app-a",
      "apiBaseUrl": "http://127.0.0.1:18765",
      "adapterTokenRef": "file:/…/dsh-session-app-a-wake.token",
      "channels": [],
      "lastEventId": 128,
      "lastObservedRevision": 42,
      "lastWokenRevision": 40,
      "lastWake": { "revision": 40, "available": 1, "summary": { "state": "ok", "shown": 1, "remaining": 0 } },
      "summary": { "state": "ok", "shown": 1, "remaining": 0, "code": null, "at": "2026-10-26T13:27:30.000Z" },
      "enabled": true,
      "health": { "sse": "connected", "session": "live", "occupied": "occupied",
                  "programMcp": { "state": "available", "at": "2026-10-26T13:27:31.000Z" } }
    }
  },
  "legacyV1": { "…": "v1 snapshot, preserved" }
}
```

- v1 single-binding documents migrate to v2; the original document is kept
  verbatim under `legacyV1`, and a v1 binding without a usable token reference
  is marked `blocked` instead of being dropped.
- A document belonging to a newer version is refused, never overwritten.
- A `pendingWake` left by a crash is treated as delivered (at-most-once).
- Summary diagnostics store only counts/stable codes. Item ids and summary text
  never enter the state file or the logs.

## Per-binding wake rules

```
archived / unknown session   -> no delivery
active turn                  -> dirty only (never interrupts)
idle && available > 0        -> at most one followup
turn end                     -> re-read status, at most one followup
available == 0               -> silent
```

- one SSE connection, cursor, revision watermark, and wake ledger per binding;
- same revision never wakes twice;
- one unfinished wake per binding;
- burst debounce 200–500 ms;
- exponential reconnect with each binding's own `Last-Event-ID`;
- no-progress backoff per binding;
- 401/403/404 set that binding's `configError` and stop its wakes;
- `agent/disposed` / `workspace/session-stop` stop only that binding and clear
  its occupancy.

## Turn-end catch-up

While the Agent is running, the adapter does **not** read status/items and does
**not** inject a followup. SSE events only mark the binding dirty; InboxMosire
continues to update normally.

At the turn-end boundary (`agent/status` idle or `session/event` `turn/end`):

```text
300ms debounce -> GET /status -> (new revision?) -> items summary -> one followup
```

If a new revision arrived during the turn, this catch-up **bypasses the
no-progress backoff**, so stopping the turn can produce a wake almost
immediately after the 300ms debounce instead of waiting 30s+. Same-revision
turns still never re-wake, and backoff still applies to idle/new-event paths.

## Occupancy

`PUT /v1/inboxes/{inbox}/occupancy {"occupiedBy":"<sessionRef>"}` on bind (and
on resume), `DELETE` on unbind/archive/dispose. It is advisory: a token without
`inbox:occupy` produces a warning, never a blocked wake. `status` exposes
`occupied/occupiedBy/occupiedAt`.

## Bounded summary wake message

When the summary succeeds, the followup carries at most `summaryMaxItems` lines:

```text
[INBOX_HOST_EVENT]
inbox={inboxId} revision={revision} available={available} channels=[{changedChannels}]

摘要（最多 {N} 条；可能已变化，claim 时以通知板为准）:
- {"itemId":"itm_...","channel":"ticket","kind":"reply","source":"qq_group/bot-1/955432692","summary":"..."}
- {"itemId":"itm_...","channel":"tweet-review","kind":"review","summary":"..."}
- 还有 {remaining} 条未展示

请直接通过你的程序 MCP 调用 inbox_claim 选择本回合要处理的 itemId；
如果摘要不足，再调用 inbox_list。
如果当前没有可处理项，结束本回合，不要轮询。
```

For `wakeMode=view-ack`, the bounded summary/fixed body instead tells the
Agent to use each item's `source` with the program's business tools. In the
iiBot deployment the loop is:

```text
qq_conversation_read(source) -> process -> qq_conversation_ack(source)
```

The wake never asks a view-ack Agent to call `inbox_list` or `inbox_view`.
If the summary is unavailable, it asks for `qq_conversation_list` to find an
unread source before reading it.

When the summary is disabled or fails, the fixed no-summary body is used
instead, so the wake still happens:

```text
这是通知板唤醒信号，不是通知内容。
请使用你的程序 MCP 的 inbox_list 查看你要处理的条目，并用 inbox_claim 选择本回合要处理的项。
如果当前没有可处理项，结束本回合，不要轮询。
```

Summary safety rules:

- only `itemId/channel/kind/source/summary` are read; `content`, `payload`,
  `payloadRef`, and claim tokens are never requested into the message, state,
  or logs;
- `source` is optional, untrusted, single-line and length-bounded; it is never
  treated as an instruction;
- `summary` is preferred; a legacy `title` is used only when `summary` is
  missing;
- summary text is untrusted: newlines and control characters are removed, the
  text is capped by `summaryMaxTitleChars` (the historical setting name), and
  it is embedded with JSON escaping;
- an empty summary falls back to `kind/channel`;
- `summaryMaxItems` and `summaryMaxTotalChars` bound the summary block; the
  fixed instructions are never truncated;
- channel ids are validated and intersected with the binding/status channels;
  values shaped like opaque capabilities (`clm_`, `itm_`, `evt_`, `cred_`) are
  dropped as channels;
- a 401/403 on `/items` records `SUMMARY_FORBIDDEN`, disables further summary
  reads for that binding, and still wakes; 5xx/timeout/network errors degrade to
  a warning and retry on the next revision;
- the summary is not a claim result: the claim response remains authoritative.

## WebUI inbox panel

When the current session has an inbox binding, the Web UI shows a compact
`InboxMosire · {inbox} · N pending` strip in the composer-context dock (above
the composer, beside Todo/Goal/Queue). It is hidden for unbound sessions.

- data path: browser → authenticated Connection RPC `/inbox-mosire` `status`
  → the binding's last observed `status` counts; no token or item content ever
  reaches the browser;
- on mount and on the refresh button the Host performs one read-only
  `GET /status`, so the count is current even if the first SSE event was missed;
- the strip follows the Host theme tokens and locale (`zh`/`en`), and refreshes
  every 5 seconds while mounted;
- the strip also shows the bound inbox address as `host:port` (scheme, path,
  and userinfo are dropped before it leaves the Host);
- one **挂载 / 卸载** button controls only this session's recorded Inbox
  binding — MCP mounting belongs to the MCP connector plugin and is not touched
  from this strip:
  - **卸载** calls Host RPC `suspend`: SSE, cursor activity, occupancy, and
    wakes stop; the descriptor is kept, `enabled=false` is persisted, and the
    row changes to `Inbox 已卸载` plus who did it and when;
  - **挂载** calls `resume`: the token is reloaded, status/SSE restart, and
    occupancy is re-PUT for the same descriptor.
  A suspended binding stays disabled across Host restarts until remounted.
  Every bind/unbind/suspend/resume/retry/failed-start is appended to the
  per-session operation log; see `inbox_adapter_log`.
  connector's configured scope, so it can affect other sessions in the same
  workspace/global scope;
- the toggle is single-flight and aborts after 15s, so rapid clicks cannot
  leave the button stuck; the connector key and Bearer credential stay in the
  Host/local connector store, and no token is sent to the browser or
  repository;
- the client half is served by DSH's client-module system. Adding a `dsh.client`
  declaration to an already-running Host is picked up only after a DSH Web Host
  restart (the client module graph is cached at boot); existing sessions and
  bindings survive on disk.

## Wake modes

Bindings can use one of two explicit processing lifecycles:

- `claim` (default): the wake text tells the Agent to call `inbox_claim`;
- `view-ack`: the wake text tells the Agent to use each item's `source` with the
  program's own business tools; iiBot uses `qq_conversation_read(source)` and
  `qq_conversation_ack(source)`. It never instructs the Agent to claim.

`view-ack` is for programs such as the bot-first message board where
`bot_thread_ack` archives a still-available item with `inbox_delete`. It does
not change Inbox core semantics: claimed items still require complete/release.

```json
{
  "descriptor": { "inboxId": "iibot-bot-sim", "adapterTokenRef": "file:/..." },
  "wakeMode": "view-ack"
}
```

The mode is DSH-local binding state (`wakeMode`), not a `BindingDescriptor`
field. `inbox_adapter_status` displays it.

## Rest / snooze

A successful completion or archive tool may carry an optional `restSeconds`
argument. The preferred generic tool is:

```text
inbox_rest
```

It is provided by Inbox's own MCP modules, so Bot programs using
`InboxClientMcpTools` get it automatically and do not need a custom ack-schema
change. Completion/archive tools may also carry `restSeconds`:

```text
inbox_complete
inbox_delete
qq_conversation_ack
```

and their MCP-prefixed forms. When the tool result is successful, the DSH
adapter stores `restUntil` on the **calling binding only**:

```json
{"restSeconds": 60}
```

- `restSeconds > 0`: suppress new inbox status/summary/followup delivery for
  that binding until the deadline;
- `restSeconds: 0`: clear the rest immediately;
- max: 86400 seconds;
- the Inbox board is untouched; items remain available;
- at deadline the adapter reconciles once and wakes at most once for the latest
  revision;
- rest is persisted with the binding and does not affect other sessions;
- `inbox_adapter_status` shows `restUntil` / remaining seconds.

The Inbox core does not interpret `restSeconds`; it is an adapter hint. Prefer
`inbox_rest` so no downstream ack-tool schema change is required. If a custom
completion tool wants to carry the duration itself, add the optional field to
that tool's schema.

## Program MCP diagnostic

The adapter never injects or calls business tools. At each wake it asks the live
agent's tool schema for the tools relevant to the binding's `wakeMode`:
claim mode looks for `inbox_claim`/`inbox_list`/`inbox_view`; view-ack looks for
`qq_conversation_read`/`qq_conversation_ack` (including MCP-prefixed names), and
stores the result as `health.programMcp`:

```json
{ "state": "available" | "missing" | "unknown", "at": "..." }
```

- `available`: the wake instructions are actionable; no warning is added;
- `missing`: the wake still happens, but it carries
  `注意：本会话未检测到可处理 source 的程序 MCP 业务工具（如 qq_conversation_read/ack）；请先挂载程序 MCP，否则本回合无法处理。`
  and `/inbox status` / the WebUI strip show the same condition;
- `unknown`: tool introspection was unavailable; no claim is made either way.

This is deliberately a diagnostic, not automatic tool injection: the program
owns its MCP server and token, and the adapter must not speak MCP or expose
business tools. To run the full loop, attach the program-owned MCP through the
DSH connector for the target workspace; see
[`docs/PROGRAM-MCP-ATTACH.md`](docs/PROGRAM-MCP-ATTACH.md). `inbox_adapter_status`
re-probes the caller's current tool schema, so an already-attached connector
does not need a new wake just to clear a stale `missing` state.

## Testing and acceptance

```bash
node --test                        # 124 tests (unit + live; live skips when the daemon is down)
node --test test/real-backend.test.mjs   # live app-a/app-b isolation, summary wake, token migration
node scripts/acceptance-acp.mjs    # real DSH host, two ACP sessions
node scripts/privacy-scan.mjs      # credentials across repo/state/logs/sessions
```

`docs/ACCEPTANCE.md` records the live evidence (including the 2026-10-26
summary-wake run); `docs/DELIVERY.md` is the delivery report.

## Limits

- A wake requires a **live** agent. A cold session is not resumed by the
  adapter; its binding starts when the session resumes.
- Binding a session with existing `available` items and no prior `lastWake`
  emits one bootstrap wake, so restart/rebind cannot silently lose a backlog.
- One binding per session; re-binding replaces it. Different sessions may bind
  different inboxes.
- Delivery is at-most-once per revision by design.
- Summary failure degrades to a no-summary wake; it never blocks the wake.
- `content` is opaque and only reaches the target program through its own MCP
  (`inbox_view`/`inbox_claim` or `qq_conversation_read`); the DSH adapter never reads, parses, stores, or
  forwards it.
- A `SUMMARY_FORBIDDEN` token keeps waking without summaries until the binding
  is re-bound or `/inbox retry` is run with a token that has `items:read`.
- Mode A assumes a program-owned MCP server for business tools. If none is
  attached, the wake is still delivered but carries the `programMcp=missing`
  warning; the adapter never auto-attaches or calls business tools.
- The adapter is read-only against InboxMosire.
