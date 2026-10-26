# Acceptance evidence — bounded summary wake (2026-10-26)

Run on 2026-10-26 21:26–21:30 (Asia/Shanghai) against InboxMosire backend
`bd28ffa` (jar built 21:16) and Node `22.23.3`. The daemon was started manually
because the old `inboxd-live.service` unit no longer exists; it used the existing
live data directory and was stopped after the run.

| Item | Value |
|---|---|
| Backend | `bd28ffa`, `inbox-server-0.1.0-SNAPSHOT-all.jar` |
| API/SSE | `http://127.0.0.1:18765`, PID 11427 during the run |
| Boards | `app-a`, `app-b` (drained after every scenario) |
| Wake tokens | reissued with `InboxClient.issueBinding()`: `status:read`, `events:read`, `items:read`, `inbox:occupy` (0600) |
| Legacy proof | a valid `status:read/events:read/inbox:occupy` token (no `items:read`) |
| DSH | fake-host engine surface; same `BindingManager`/`InboxAdapter` code as production |
| Evidence | `/tmp/inbox-mosire-summary/` (token-migration, real-backend, privacy) |

## 1. Token migration: legacy 403, reissued 200

The historical token file copied before reissue was already revoked (`401`), so
it could not prove the scope path. A valid legacy-scope token (same scopes as the
old wake token, explicitly **without** `items:read`) was issued for the 403
proof; then `issueBinding()` wrote a fresh token to the same `adapterTokenRef`.

```console
$ curl -o old-status.json -w '%{http_code}' -H "Authorization: Bearer $OLD" \
    http://127.0.0.1:18765/v1/inboxes/app-a/status
200
$ curl -o old-items.json -w '%{http_code}' -H "Authorization: Bearer $OLD" \
    'http://127.0.0.1:18765/v1/inboxes/app-a/items?limit=3'
403
$ cat old-items.json
{"error":{"message":"token 缺少 scope: items:read","code":"FORBIDDEN"}}

$ curl -o new-items.json -w '%{http_code}' -H "Authorization: Bearer $NEW" \
    'http://127.0.0.1:18765/v1/inboxes/app-a/items?limit=3'
200
```

`issueBinding()` output (printed without the raw token):

```console
issued inbox=app-a tokenRef=file:/home/cna/InboxMosire/.work/live/secrets/dsh-session-app-a-wake.token
issued inbox=app-b tokenRef=file:/home/cna/InboxMosire/.work/live/secrets/dsh-session-app-b-wake.token
```

## 2. Test suite

```console
$ node --test
# tests 121
# pass 121
# fail 0
# skipped 0
```

The 121 include the earlier coverage, `test/summary.test.mjs` (28 tests),
`test/panel.test.mjs` (3), `test/client-panel.test.mjs` (3),
`test/program-tools.test.mjs` (4), `test/turn-end.test.mjs` (1), the config
coverage, and the live file.
When the daemon is down the live tests skip rather than fail.

## 3. Live two-binding + summary

```console
$ node --test test/real-backend.test.mjs
ok 1 - v2 live: two sessions, two inboxes, isolated wakes, occupancy, restart
ok 2 - v2 live summary: old token is rejected by /items, the reissued token is accepted
ok 3 - v2 live summary: three bounded JSON lines, sanitized summary, update, remaining count
# tests 3
# pass 3
# fail 0
```

The summary scenario pushes four `summary/content` items to `app-a` (the first
summary contains a quote, newline, and tab), binds a fresh session, and receives
one wake:

```text
[INBOX_HOST_EVENT]
inbox=app-a revision=46 available=4 channels=[]

摘要（最多 3 条；可能已变化，claim 时以通知板为准）:
- {"itemId":"itm_...","channel":"ticket","kind":"acceptance","summary":"line \"one\" next line"}
- {"itemId":"itm_...","channel":"ticket","kind":"acceptance","summary":"summary-two"}
- {"itemId":"itm_...","channel":"ticket","kind":"acceptance","summary":"summary-three"}
- 还有 1 条未展示

请直接通过你的程序 MCP 调用 inbox_claim 选择本回合要处理的 itemId；
如果摘要不足，再调用 inbox_list。
如果当前没有可处理项，结束本回合，不要轮询。
```

Assertions: three JSON lines; each has exactly
`itemId/channel/kind/summary`; `summary` is the cleaned single-line form;
`还有 1 条未展示`; no `content`/`payload` key; no claim token; after `turn/end`
the same revision is not re-woken; the binding records
`summary.state=ok/shown=3/remaining=1`.

Then `GET /items/{itemId}` (`inbox_view`) returns `summary` plus the opaque
`content`; `PATCH /items/{itemId}` (`inbox_update`) changes the summary. The
next revision wake shows the new summary and no old one, and the same updated
revision is not woken twice. `content` appears only in the view/claim response,
never in the wake, state, or logs.

## 4. Injected failure matrix

These require a fault-injecting server, so they use the fake daemon that mirrors
the frozen HTTP contract; the adapter and its real `InboxClient` are the
production code.

| Scenario | Test | Result |
|---|---|---|
| Empty board: no `/items`, no wake | `summary.test.mjs` | **pass** |
| `available > 0`: exactly 3 lines, remaining | summary + live | **pass** |
| `/items` 500 | `items 500 degrades...` | **pass** — wake delivered, `state=degraded/code=INBOX_HTTP`, warning logged |
| `/items` timeout | `items timeout still wakes` | **pass** — wake delivered, `code=INBOX_TIMEOUT` |
| `/items` 403 (missing `items:read`) | `items 403 records SUMMARY_FORBIDDEN...` | **pass** — wake delivered, one request only, later revisions skip `/items` |
| Forbidden token persisted across restart | `persisted SUMMARY_FORBIDDEN...` | **pass** — no new `/items` request |
| Same revision | unit + live | **pass** — one followup, one `/items` per revision |
| Two bindings, two inboxes | `two bindings never mix...` + live | **pass** — each wake carries only its own item |
| Summary newline/quote/control chars | unit + live | **pass** — cleaned, JSON-escaped, line stays single-line |
| Legacy title-only item | `legacy title-only...` | **pass** — `summary` falls back to `title` |
| `inbox_update` summary change | unit + live | **pass** — new revision shows new summary, old one absent |
| `content` never in wake/state/logs | unit + live + privacy | **pass** — only view/claim can see it |
| Summary disabled | `summaryEnabled=false...` | **pass** — no `/items`, fixed no-summary body |
| New revision while the Agent runs | `turn-end.test.mjs` | **pass** — no injection during the turn; turn-end catch-up wakes within the test budget despite a 5s backoff |
| No token in artifacts | privacy scan + tests | **pass** |

## 5. Privacy scan

```console
$ node scripts/privacy-scan.mjs
privacy scan: PASS
  repo files scanned: 50
  adapter state/config/log files: 3
  DSH host log files: 6
  DSH session logs: 897 (56 inbox-mosire wake messages)
  secrets checked: dsh-adapter.token, dsh-smoke-adapter.token, producer-main.token,
    smoke-producer.token, smoke-verify.token, dsh-session-app-a-wake.token,
    dsh-session-app-b-wake.token, dsh-session-app-a-wake.legacy.token,
    program-a-mcp.token, program-b-mcp.token
```

## 6. Summary acceptance checklist

| # | Requirement | Result | Evidence |
|---|---|---|---|
| 1 | Old token `/items` 403; reissued token 200 | **pass** | §1 (legacy-scope token; historical file was already revoked) |
| 2 | Empty board: no `/items`, no wake | **pass** | §4 |
| 3 | `available > 0`: wake message has at most 3 summaries | **pass** | §3 live + §4 |
| 4 | Summary has `itemId/channel/kind/summary`, no content/payload | **pass** | §3 live + §4 |
| 5 | More than 3 shows “还有 N 条未展示” | **pass** | §3 (`还有 1 条未展示`) |
| 6 | Newline/quote summary text cleaned and JSON-escaped | **pass** | §3 live (`line \"one\" next line`) + §4 |
| 7 | `/items` 500/timeout still wakes without summary | **pass** | §4 |
| 8 | Same revision not woken twice | **pass** | §3 live + §4 |
| 9 | S1→app-a and S2→app-b summaries never cross | **pass** | §3 live test 1 + §4 |
| 10 | No raw token in logs/state/wake/transcript | **pass** | §5 |
| 11 | `inbox_update` summary reaches the next wake | **pass** | §3 live |
| 12 | Adapter never claims/completes/pushes | **pass** | code/tests; no such client method exists |
| 13 | Wake warns when program MCP is missing | **pass** | §8 live + unit |
| 14 | Program-owned MCP can complete the full loop | **pass** | §8 live |
| 15 | Running turn defers all injection; new revision catches up at turn end | **pass** | `turn-end.test.mjs` (5s backoff bypassed, wake <1s) |
| 16 | Target Bot session sees 24 iibot tools and `programMcp=available` | **pass** | §9 request header + status |
| 17 | `view-ack` wake text has no `inbox_claim` | **pass** | §9 live wake |
| 18 | Target Agent honors no-claim (never calls `inbox_claim`) | **fail** | §9: target used bash `inbox_claim` + release, then ack |
| 19 | Manual panel mount/unmount | **pass (unit)** | §10; live button needs client reload |

## 7. WebUI inbox panel

- [x] Host RPC `/inbox-mosire` `status` returns counts for one session and
  nothing else; `curl` without browser auth returns `401` (route mounted,
  authenticated).
- [x] Unit tests cover the manager projection, endpoint validation, refresh,
  no-throw behavior, dictionary parity, and component rendering of
  `InboxMosire · app-a · 3 pending`; an unbound session renders `null`.
- [x] Live page registration was observed **after the DSH Web Host restart**:
  `conversation.input.dock` lists occupant `id: inbox-mosire`, `order: 30`,
  `active: true`. The authenticated Host RPC route is mounted (unauthenticated
  requests return `401`); the strip showed the bound `app-a` count during the
  demo. The client-side `程序 MCP 未挂载` text needs one more client load to
  appear because the client half changed after that restart.

## 8. Program MCP injection and diagnostic (2026-10-26)

A temporary **program-owned** stdio MCP server for `app-a` was attached through
the DSH MCP connector (8 tools: `inbox_status/list/view/claim/complete/update/
append/delete`, using `program-a-mcp.token`). It is not the central MCP and it is
not provided by the adapter. With it attached:

```console
inbox_status   -> revision 294 available 1
inbox_list     -> "诊断测试：程序 MCP 已挂载"
inbox_view     -> content {"case":"mcp-available"}
inbox_claim    -> 1 claimed, claimToken returned only in the tool result
inbox_complete -> revision 296, available 0
```

The wake for revision 294 had **no** missing-MCP warning, and
`bindings[session].health.programMcp = {state:"available"}`.

Then the MCP connection was disconnected and a second item was pushed:

```text
[INBOX_HOST_EVENT]
inbox=app-a revision=297 available=1 channels=[ticket]

摘要（最多 3 条；可能已变化，claim 时以通知板为准）:
- {"itemId":"itm_...","channel":"ticket","kind":"diagnostic","summary":"诊断测试：程序 MCP 未挂载"}

注意：本会话未检测到程序 MCP 的 inbox_list/inbox_view 工具；请先挂载程序 MCP，否则本回合无法处理。

请直接通过你的程序 MCP 调用 inbox_claim 选择本回合要处理的 itemId；
如果摘要不足，再调用 inbox_list。
如果当前没有可处理项，结束本回合，不要轮询。
```

`health.programMcp` became `{state:"missing", at:"..."}` and the last wake
recorded the same state. The diagnostic is a warning only: the wake still
orders/delivers and the adapter never calls `inbox_claim` itself.

The MCP connection was removed after the test, and the item was drained via the
program token. No adapter auto-injection was added: the program owns its MCP
server and token; the adapter only detects and reports whether it is visible.

## 9. 6b71f6b connector + Bot session live check (2026-10-27)

The actual DSH connector was repaired in place for workspace `simulation2`:

```text
custom-iibot: streamable-http, manual/bearer
url:  http://127.0.0.1:8765/mcp/bot
scope: simulation2 (workspace c0c85162-96b8-4d28-b222-39bb023f5be4)
tools: 24 (bot_* + inbox_*)
```

The target Bot session (workspace `simulation2`) was rebound with
`wakeMode: view-ack`. Its request header at turn 34 contained all 24
`mcp__iibot__*` tools; `programMcp=available`.

Its revision-166 wake was view-ack and contained no `inbox_claim`:

```text
[INBOX_HOST_EVENT]
inbox=iibot-bot-sim revision=166 available=2 channels=[qq]

摘要（最多 3 条；可能已变化，处理时以通知板为准）:
- {"itemId":"itm_...","channel":"qq","kind":"digest","summary":"..."}
- {"itemId":"itm_...","channel":"qq","kind":"digest","summary":"..."}

请通过你的程序 MCP 调用 inbox_list / inbox_view 选择本回合要处理的 itemId；
如果摘要不足，再调用 inbox_list；按该程序定义的处理流程完成。
如果当前没有可处理项，结束本回合，不要轮询。
```

**Important finding:** the target Agent still chose its local
`scripts/06-mcp.sh` path and called `inbox_claim`, then released and called
`bot_thread_ack` to avoid `INBOX_CONFLICT`. `bot_reply` and `bot_thread_ack`
both returned `ok:true`, but the no-claim requirement was **not** honored by the
Agent. The adapter's wake text is correct; this is target-program prompt/Skill
behavior, not something the DSH adapter can enforce against a shell fallback.
The target prompt should be updated to use the native
`mcp__iibot__inbox_list` / `inbox_view` path and never call `inbox_claim`.

## 10. WebUI mount/unmount button

- `programMcpConnectorKey` is local config (`custom-iibot`); the panel now
  renders 挂载 MCP / 卸载 MCP. The client calls the installed connector's
  trusted same-origin `/mcp-connector/api` (`setEnabled` + `reconnect`) and
  refreshes `programMcp`; no token reaches the browser.
- Unit coverage: config parsing, panel status key, rendered mount/unmount
  controls. The client half needs a reload/restart before the new button is
  visible in an already-open page.

## 11. Not verified / limits

- The live daemon cannot be told to return 500 or hang, so those two cases were
  exercised with the fake contract server, not the Java backend.
- The real DSH host / ACP scenario (`scripts/acceptance-acp.mjs`) was **not**
  rerun for this change. The two-binding/multi-inbox behavior was verified with
  the real daemon and the production manager/adapter through the fake host; the
  previous ACP evidence below remains the host-level reference.
- The historical token file was revoked before this run (401); the 403 evidence
  uses a newly issued token with exactly the old scope set, not `items:read`.
- The adapter still does not claim/complete/push; the summary is not a claim
  result, and the claim response remains authoritative.
- The program-MCP loop above used a temporary `/tmp` stdio bridge, removed after
  the test; automatic MCP attachment is intentionally **not** implemented. The
  adapter detects `programMcp` but never injects or calls it.
- The client-side `program MCP missing` strip text needs one page/client reload
  to appear; the Host-side wake warning and state are already live.
- Panel visual verification waits for the DSH Web Host restart described in §7;
  the page booted before the `dsh.client` declaration existed.

---

# Acceptance evidence — v2 multi-binding (historical)

Run on 2026-10-25 (Asia/Shanghai) against the live InboxMosire daemon (v2,
advisory occupancy) and a real DSH `0.2.1-rc.2` host. Fake-host scenarios replace
only the DSH `Agent` surface; the InboxMosire side, tokens, descriptors, and MCP
call shapes are real.

## Environment

| Item | Value |
|---|---|
| Daemon | `inboxd-live.service`, PID 53296, API/SSE `http://127.0.0.1:18765` |
| Boards | `app-a` and `app-b`, one `ticket` item each at start, then drained |
| Descriptors | `.work/live/bindings/app-a.json`, `app-b.json` |
| Wake tokens | `status:read`, `events:read`, `inbox:occupy` (0600) |
| Program tokens | `program-a-mcp.token`, `program-b-mcp.token` (items:write/read/manage, status:read, inbox:occupy) |
| DSH | `0.2.1-rc.2`, Node `22.23.3` |
| Real host | profile `inbox-acp` + `test/acp-test.patch.yml` (engine row + tool row) |
| Evidence | `/tmp/inbox-mosire-acp/{acceptance.txt,adapter.log,state-v2.json,dsh.stderr.log}` |

## 1. Test suite

```console
$ node --test
…
1..73
# tests 73
# pass 73
# fail 0
```

Covers v1→v2 migration, descriptor/tokenRef validation, per-binding isolation
(two fake inboxes), occupancy PUT/DELETE, rebind/dispose/unbind isolation, cold
session resume, restart recovery, tools, command entry, engine wake rules, and
privacy.

## 2. Live two-inbox isolation (fake host, real daemon)

```console
$ node --test test/real-backend.test.mjs
ok 1 - v2 live: two sessions, two inboxes, isolated wakes, occupancy, restart
# pass 1, fail 0
```

What it proves: S1→app-a and S2→app-b each wake once for their own pushed item;
`occupiedBy` names the right session on both; the two cursors/watermarks are
independent; draining both boards makes both silent; a new app-a item wakes only
S1; the same revision is not re-woken; a restart restores both bindings with no
replay; a relative `adapterTokenRef` fails closed; disposing S1 clears only
app-a's occupancy and leaves S2's engine alive; unbinding S2 clears app-b.

## 3. Real DSH host, two ACP sessions

```console
$ node scripts/acceptance-acp.mjs
S1=51120274-… (app-a)
S2=d0add9f4-… (app-b)
bind prompt settled … stopReason=end_turn      (×2, through inbox_adapter_bind)
adapter started one engine per session
occupancy: app-a=51120274-… app-b=d0add9f4-…
pushed app-a revision=13, app-b revision=16
adapter: 已投递唤醒 {session: S2, inbox: app-b, revision: 16, available: 1, reason: turn-end-event}
adapter: 已投递唤醒 {session: S1, inbox: app-a, revision: 13, available: 1, reason: sse-event}
  ok: S1 woken for app-a
  ok: S2 woken for app-b
  ok: S1 never receives app-b
  ok: S2 never receives app-a
wake turns cancelled; both sessions idle
  ok: app-b still occupied by S2 after S1 archive
S2 woken again for app-b revision=19
  ok: archived S1 receives no further wake
S1 wake messages=1, S2 wake messages=2
S1 wake seq=27: "inbox=app-a revision=13 available=1 channels=[ticket]"
S2 wake seq=27: "inbox=app-b revision=16 available=1 channels=[ticket]"
S2 wake seq=110: "inbox=app-b revision=19 available=1 channels=[ticket]"
  ok: S1 log contains app-a wakes only
  ok: S2 log contains app-b wakes only
  ok: wake messages contain no item/claim/token material
final: app-a available=0 occupied=false; app-b available=0 occupied=false
  ok: app-a left clean
  ok: app-b left clean
all v2 assertions passed
```

Both sessions bound **through the model-facing tool**, not a test backdoor.
Archiving S1 (`session/close`) cleared only app-a's occupancy and stopped only
S1's engine; S2 was woken again afterwards.

## 4. Privacy scan

```console
$ node scripts/privacy-scan.mjs
privacy scan: PASS
  repo files scanned: 40
  adapter state/config/log files: 3
  DSH host log files: 6
  DSH session logs: 872 (2 inbox-mosire wake messages)
  secrets checked: dsh-adapter.token, dsh-smoke-adapter.token, producer-main.token, smoke-producer.token, smoke-verify.token
```

The scan reads every local credential file and searches the repository, adapter
artifacts, DSH host logs, and the complete decompressed content of every session
log on the machine, plus every adapter wake message. The ACP test session logs
(created in `/tmp` workspaces and deleted after the run) were removed because
the model, lacking a program MCP, explored secret **paths** during its wake turn;
that run is not part of the repository.

## 5. The v2 acceptance checklist

| # | Requirement | Result | Evidence |
|---|---|---|---|
| 1 | One host holds S1→app-a and S2→app-b | **pass** | ACP run; `state.bindings` has two entries |
| 2 | Push app-a wakes only S1; push app-b only S2 | **pass** | ACP run; real two-inbox test |
| 3 | S1 cursor/revision/lastWake never affect S2 | **pass** | per-binding engines; real test asserts independent cursors |
| 4 | Rebind S1→app-c leaves S2 on app-b working | **pass** | manager test (rebind resets only S1, old occupancy vacated, S2 still wakes) |
| 5 | S1 archive/dispose stops app-a only | **pass** | ACP run + manager test; occupancy cleared only for S1 |
| 6 | Same revision not re-woken | **pass** | engine + manager + real tests |
| 7 | Each binding reconnects with its own `Last-Event-ID` | **pass** | engine reconnect test; manager restart test preserves per-binding cursors |
| 8 | Daemon/DSH restart restores each binding | **pass** | manager restart test; real-backend restart step; live Web restart migrated the v1 state to v2 without loss |
| 9 | Unreadable/non-absolute tokenRef fails closed | **pass** | manager + tools + real tests (`TOKEN_REF_NOT_ABSOLUTE`, `TOKEN_REF_UNREADABLE`) |
| 10 | No raw token in logs/state/wake/transcript | **pass** | privacy scan; wake-message assertions |
| 11 | Mode A: target session claims/completes via program MCP; adapter never does | **partial** | The adapter never calls claim/complete/list/push (asserted by code and tests). No program-owned MCP server is running on this machine, so claim/complete was exercised through the program's own HTTP client surface with the program tokens — the same calls `InboxClientMcpTools` wraps — not through the MCP transport. |
| 12 | After bind, occupancy is `occupied/occupiedBy=session`; after unbind `false` | **pass** | ACP run; real-backend test; fake-server occupancy assertions |
| 13 | Occupancy does not block another valid token | **pass** | backend contract; adapter treats a missing `inbox:occupy` as advisory |
| 14 | v1 single-binding data migrates or reports incompatibility, never silently | **pass** | `normalizeHostState` keeps `legacyV1`, migrates a usable binding, marks a tokenRef-less binding `blocked`; unit tests |

## 6. Post-restart web-profile self-loop (2026-10-25 21:27–21:28)

After the DSH Web host was restarted, the live profile loaded the v2 engine and
migrated the state in place:

```console
13:27:08.459 warn v1 单 binding 状态已迁移到 v2
13:27:08.459 info 状态已迁移到 v2 {"existed":true,"bindings":0}
13:27:08.459 info v1 状态快照已保留在 legacyV1（未丢弃）
```

Then the current session bound itself through the model tool, pushed one item,
was woken once, processed it, and unbound itself:

```console
inbox_adapter_bind({inboxId:"app-a", adapterTokenRef:"file:…"})
→ 已绑定 session-5d2eb5b6-… → app-a
  sse=connected occupancy=occupied by session-5d2eb5b6-…

push (program-a token) → itm_44d40d5e-…, revision=34, available=1
# the turn stayed active; no wake was delivered before it ended
13:28:30.907 已投递唤醒 {session:session-5d2eb5b6-…, inbox:app-a, revision:34,
                        available:1, channels:[ticket], reason:turn-end-event}

list → 1 item (v2 自测：bind → push → wake → 处理 → unbind)
claim → 1 (payload {"demo":true,"from":"self"} appears only here)
complete → 1, revision=36, available=0

inbox_adapter_unbind → 已解绑 session-5d2eb5b6-…（app-a）
13:28:37.020 停止 binding {reason:"unbind"}
13:28:37.020 停止 InboxMosire 连接 {reason:"stopped"}
state: version=2, bindings=[], legacyV1=true
app-a: available=0 claimed=0 occupied=false (socket FIN-WAIT)
```

This is the v2 loop in the production Web profile: binding, SSE, one wake at
turn end, processing through the program-token client surface, and unbind with
occupancy cleanup.

## Notes and limits

- The **web profile** was restarted and now runs v2 (the state above). The
  linked package, patch, and v2 state stay in place across restarts.
- The central InboxMosire MCP connection (`custom-inbox-mosire`) was
  **disconnected** to honor Mode A: target sessions must use their program-owned
  MCP server, not the central one.
- The ACP wake turns had no business tools (no program MCP), so the driver
  drained the boards through the program's HTTP client surface. The adapter's
  wake message still told the model to use its program MCP, which is the
  intended production shape.
- `app-a`/`app-b` are left with `available=0`, `occupied=false` after the run.

## v1.6 no-claim and program-MCP diagnostics

- `wakeMode=view-ack` wake text contains no `inbox_claim`; the fixed body uses
  `inbox_list` / `inbox_view`.
- `wakeMode=claim` remains the default and preserves the previous wake body.
- `hasBusinessTools` recognizes `mcp__<server>__inbox_view` even when no claim
  tool is exposed.
- `inbox_adapter_status` refreshes `programMcp` from the caller's current tool
  schema; it is no longer necessary to wait for a new wake to clear a stale
  `missing` state.
- Program-MCP attachment is documented in `docs/PROGRAM-MCP-ATTACH.md`; it is a
  host connector concern, not a `BindingDescriptor` field.
