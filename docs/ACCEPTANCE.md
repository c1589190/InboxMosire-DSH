# Acceptance evidence

Run on 2026-10-25 (Asia/Shanghai) against the live InboxMosire daemon and a real
DSH `0.2.1-rc.2` host. Nothing below is simulated except where explicitly marked
**fake host** (the DSH `Agent` surface replaced by an in-process stub while the
InboxMosire side stays real).

## Environment

| Item | Value |
|---|---|
| InboxMosire API/SSE | `http://127.0.0.1:18765` (daemon PID 17040) |
| InboxMosire MCP | `http://127.0.0.1:18766/mcp` |
| Adapter token | `.work/live/secrets/dsh-smoke-adapter.token` (`status:read`, `events:read`, inbox `smoke`) |
| Producer token | `.work/live/secrets/smoke-producer.token` (`items:write`, inbox `smoke`) |
| DSH | `0.2.1-rc.2`, Node `22.23.3` |
| Real host run | profile `inbox-acp` (shipped `acp` template) + `test/acp-test.patch.yml` |
| Web profile install | `web`, bundle `@mosire/dsh-inbox-mosire@0.1.0` (`link:/home/cna/InboxMosire-DSH`) |
| Evidence directory | `/tmp/inbox-mosire-acp/` |

## Commands and results

### 1. Unit / fake-host / fake-server suite

```console
$ node --test
…
1..66
# tests 66
# suites 0
# pass 66
# fail 0
```

Covers: config precedence/validation, token loading and redaction, state
atomicity/migration/refusal, SSE parsing, Last-Event-ID replay, heartbeat
timeout, 401/403/404/invalid-cursor classification, empty board, one wake,
revision dedupe, active-turn deferral, debounce, claim/complete loop,
dispose/resume, no-progress backoff, restart recovery, auto-binding, `/inbox`
through the real plugin entry point, manifest/display resources.

### 2. Live backend suite (real daemon, real tokens, real MCP claim/complete)

```console
$ node --test test/real-backend.test.mjs
ok 1 - real backend: empty board, one wake, claim/complete loop, dedupe, restart
ok 2 - real backend: a bad token is a fail-closed configuration error
# pass 2, fail 0
```

What it proves: the smoke board starts clean; no wake while empty; one push
produces exactly one wake with the byte-exact template; claiming and completing
via the real MCP server empties the board and produces no further wake; the same
revision is never woken twice; a push made while the adapter is stopped is
delivered once after restart from the persisted `Last-Event-ID`; a board with
three available items where the Agent claims two and completes one wakes once
more for the remaining item; a wrong token is a `CONFIG ERROR: AUTH_FAILED`
with zero wakes; and no title, payload, or token appears in wake text, state, or
adapter log.

### 3. Real DSH host end-to-end (ACP)

```console
$ node scripts/acceptance-acp.mjs
board baseline: revision=58 available=0
initialize ok: protocolVersion=1
session/new: 1da4b815-0ee9-445b-94b7-0d5018de6223
adapter: 自动绑定新的 root session {"session":"1da4b815-…","source":"startup"}
pushed #1 while active: revision=59 available=1 at +1.2s
pushed #2 while active: revision=60 at +2.7s
first prompt settled: stopReason=end_turn
adapter delivered a wake 508ms after the first prompt settled
adapter: 已投递唤醒 {"revision":60,"available":2,"channels":["ticket"],"reason":"turn-end-event"}
board drained 4304ms after the wake: revision=62 available=0 claimed=0
adapter stopped delivery 3197ms after session/close
pushed revision=63 after the session was closed
  ok: an archived session is never woken
  ok: the pushed item stayed on the board (nobody consumed it)
log: turn/end count=2
log: inbox-mosire wake messages=1
log: wake seq=29 text="[INBOX_HOST_EVENT]\ninbox=smoke revision=60 available=2 channels=[ticket]…"
log: tool calls=bash,mcp__inbox-mosire__inbox_list,mcp__inbox-mosire__inbox_claim,mcp__inbox-mosire__inbox_complete
  ok: exactly one wake message, got 1
  ok: wake seq 29 must follow the first turn end 24
  ok: the agent called inbox_list after the wake
  ok: the agent called inbox_claim after the wake
  ok: the agent called inbox_complete after the wake
  ok: the board is empty
all assertions passed
```

Raw evidence: `/tmp/inbox-mosire-acp/acceptance.txt`,
`/tmp/inbox-mosire-acp/adapter.log`, `/tmp/inbox-mosire-acp/state.json`,
`/tmp/inbox-mosire-acp/dsh.stderr.log`, and the durable session log at
`~/.dsh/sessions/--tmp-inbox-mosire-acp-workspace--/1da4b815-0ee9-445b-94b7-0d5018de6223/session.v4.jsonl.zstd`.

### 4. Privacy scan

```console
$ node scripts/privacy-scan.mjs
privacy scan: PASS
  repo files scanned: 34
  adapter state/config/log files: 3
  DSH host log files: 5
  DSH session logs: 875 (3 inbox-mosire wake messages)
  secrets checked: dsh-adapter.token, dsh-smoke-adapter.token, producer-main.token, smoke-producer.token, smoke-verify.token
```

The scan reads every secret file and searches the repository, the adapter's
state/config/log, the DSH host logs, and the **complete decompressed content of
every session log on this machine** (875) for credential values. It additionally
checks every committed `inbox-mosire` wake message and every runtime artifact
for synthetic notification markers (`SECRET-TITLE`, `SECRET-BODY`,
`acp-active-*`). A full-transcript credential scan is stricter than required:
0 hits.

### 5. Live tool surface (web profile)

After registering the InboxMosire MCP server in DSH and reinstalling the bundle
(remove → install, so the new `tools.js` row loads), the calling session has
both tool families. The calls below were executed live in this session:

```console
# native adapter tool → /inbox command → live adapter
inbox_adapter_status()
→ InboxMosire adapter — 启用
  inbox=main server=http://127.0.0.1:18765
  session=session-5d2eb5b6-… agent=running
  board: revision=3 available=0 claimed=0
  cursor: lastEventId=118 lastObservedRevision=3 lastWokenRevision=1
  sse: connected since 2026-10-25T11:43:54.250Z reconnects=0
  lastWake: revision=1 available=1 at=2026-10-25T11:36:59.915Z channels=[ticket]
  caller=session-5d2eb5b6-… isBound=true

inbox_adapter_bind()
→ 已绑定 session-5d2eb5b6-…

mcp__inbox-mosire__inbox_list()
→ {"count":0,"items":[],"inbox":"main"}
```

The remove → install cycle also proves restart recovery in the live profile:
the engine logged `绑定已加载 {session, cursor:118, lastWokenRevision:1}` and
`SSE 已连接 {cursor:118}` from the persisted state, with no duplicate wake.

### 6. Web profile installation

```console
plugin_manager install_bundle /home/cna/InboxMosire-DSH
→ {"stage":"enable","target":"@mosire/dsh-inbox-mosire","enabled":true,
   "application":"applied","bundle":"@mosire/dsh-inbox-mosire","version":"0.1.0",
   "warnings":[]}
```

Immediately after activation:

```console
$ cat ~/.dsh/inbox-mosire/adapter.log
{"time":"2026-10-25T10:58:10.683Z","level":"info","message":"空闲：等待绑定 DSH session（/inbox bind 或配置 sessionId）"}

$ cat ~/.dsh/inbox-mosire/state.json
{"version":1,"inboxId":"main","sessionRef":"", …,"enabled":true}
```

The row is loaded in the live Web profile and is **inert until bound**, which is
the intended production posture. `/inbox bind` (or a `sessionId` in the config)
arms it. The optional MCP registration of `inbox_list`/`inbox_claim`/
`inbox_complete` is a separate DSH-side action and is not performed by the
adapter.

### 7. Live native-tool loop on `main` (2026-10-25 11:46–11:47)

With the adapter bound to the live session, the MCP server registered, and the
native `inbox_adapter_*` tools loaded, the full loop was driven once more on the
production board — this time with tools only, no curl on the Agent side:

```console
mcp__inbox-mosire__inbox_push(channel=ticket, kind=self-task, priority=5)
→ {"itemId":"itm_fe05ba6e-…","revision":4,"duplicate":false}

# …the turn stayed active; the adapter logged no wake until turn end…
adapter 11:46:47.978 已投递唤醒 {revision:4, available:1, channels:[ticket],
                               reason:"turn-end-event", messageId:"msg_inbox_369db3f2…"}

mcp__inbox-mosire__inbox_list(inbox=main)
→ count=1 (itm_fe05ba6e-…, self-task, priority 5)
mcp__inbox-mosire__inbox_claim(itemIds=[itm_fe05ba6e-…])
→ claimed 1, available 1             # a second item appeared mid-turn
mcp__inbox-mosire__inbox_complete(claimToken=clm_…)
→ completed 1, revision 7, available 1

mcp__inbox-mosire__inbox_list(inbox=main)
→ count=1 (itm_595840a3-…, title "工单更新", created 11:46:51.004Z)
mcp__inbox-mosire__inbox_claim + inbox_complete
→ revision 9, available 0

final board: revision=9 available=0 claimed=0
adapter: sse=connected, lastEventId=151, lastWokenRevision=4, attempts=2, stalls=0
session log: 2 inbox-mosire wake messages, last seq=1644
  "inbox=main revision=4 available=1 channels=[ticket]"
  title/payload/itemId/claimToken markers: none
```

The second item was pushed (with the curl command from the README/answer) while
the wake turn was already running. Because an active turn is never interrupted,
it produced no second wake; the Agent listed and processed it in the same turn.
Had the turn ended with it still available, the adapter would have woken the
session once more (`revision 5 > lastWokenRevision 4`) — both paths are the
designed behavior.

## The ten acceptance items

| # | Requirement | Result | Evidence |
|---|---|---|---|
| 1 | An empty `main` board never wakes | **pass** | `adapter.test.mjs` “an empty board never wakes the session”; real-backend step 1 on `smoke`; the live `main` adapter is unbound and silent |
| 2 | One push on an idle session wakes exactly once | **pass** | real-backend step 2 (byte-exact template); ACP wake `revision=60`; live web-session wake `revision=1` |
| 3 | Pushes during an active turn do not interrupt it; turn end wakes at most once | **pass** | `adapter.test.mjs` active-turn test; ACP: two pushes during an 8 s `sleep`, wake `seq=29 > turn/end seq=24`, one wake |
| 4 | Claim 2 / complete 1, then remaining work is processed | **pass** | real-backend step 6 (3 available, claim 2, complete 1, one wake for the remaining item); ACP claim+complete loop drains the board |
| 5 | The same revision is never woken twice | **pass** | `adapter.test.mjs` dedupe test; real-backend step 4 |
| 6 | SSE reconnect uses `Last-Event-ID` | **pass** | `client.test.mjs` replay test; `adapter.test.mjs` reconnect test (`connections.at(-1).lastEventId === 1`); real-backend restart with an offline push |
| 7 | An archived session receives no wake | **pass** | `adapter.test.mjs` dispose/resume; ACP real `session/close` followed by a push: delivery stopped, no wake, the item stayed on the board |
| 8 | Cursor / `lastWokenRevision` / binding survive a DSH restart | **pass** | `adapter.test.mjs` restart tests (including interrupted `pendingWake` at-most-once); real-backend restart test |
| 9 | No payload/title/token in adapter logs or wake messages | **pass** | `node scripts/privacy-scan.mjs`; privacy tests in `adapter.test.mjs` and `real-backend.test.mjs`; ACP assertions |
| 10 | Full loop: idle → wake → multi-claim → complete → continue/silence | **pass** | ACP transcript: wake → `inbox_list` → `inbox_claim` → `inbox_complete` → board empty → silent; the live Web session loop on `main` with curl (wake 11:36:59, claim/complete 11:37:13); and the native-tool loop in §7 (wake 11:46:47, two items, board back to 0) |

## Notes and limits

- Acceptance items 2, 4, 5, 6, and 8 were exercised against the real daemon
  with a **fake host**, and item 10 end-to-end with a **real host** (ACP).
  Item 7 was exercised both ways.
- The real-host run uses the shipped `inbox-acp` profile (created with
  `dsh --profile inbox-acp --from-default-profile acp`) plus
  `test/acp-test.patch.yml`. That overlay points the model route at the
  `deepseek-account` provider the Web profile uses.
- The smoke board is left clean (`available=0`, `claimed=0`) by every scenario.
- Notification content that the Agent legitimately receives through
  `inbox_claim` does exist in the **session log's tool result**. The contract
  only forbids it in wake messages and adapter logs, which the scan verifies.
