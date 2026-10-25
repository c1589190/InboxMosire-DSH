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
1..59
# tests 59
# suites 0
# pass 59
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

### 5. Web profile installation

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

## The ten acceptance items

| # | Requirement | Result | Evidence |
|---|---|---|---|
| 1 | An empty `main` board never wakes | **pass** | `adapter.test.mjs` “an empty board never wakes the session”; real-backend step 1 on `smoke`; the live `main` adapter is unbound and silent |
| 2 | One push on an idle session wakes exactly once | **pass** | real-backend step 2 (byte-exact template); ACP wake `revision=60` |
| 3 | Pushes during an active turn do not interrupt it; turn end wakes at most once | **pass** | `adapter.test.mjs` active-turn test; ACP: two pushes during an 8 s `sleep`, wake `seq=29 > turn/end seq=24`, one wake |
| 4 | Claim 2 / complete 1, then remaining work is processed | **pass** | real-backend step 6 (3 available, claim 2, complete 1, one wake for the remaining item); ACP claim+complete loop drains the board |
| 5 | The same revision is never woken twice | **pass** | `adapter.test.mjs` dedupe test; real-backend step 4 |
| 6 | SSE reconnect uses `Last-Event-ID` | **pass** | `client.test.mjs` replay test; `adapter.test.mjs` reconnect test (`connections.at(-1).lastEventId === 1`); real-backend restart with an offline push |
| 7 | An archived session receives no wake | **pass** | `adapter.test.mjs` dispose/resume; ACP real `session/close` followed by a push: delivery stopped, no wake, the item stayed on the board |
| 8 | Cursor / `lastWokenRevision` / binding survive a DSH restart | **pass** | `adapter.test.mjs` restart tests (including interrupted `pendingWake` at-most-once); real-backend restart test |
| 9 | No payload/title/token in adapter logs or wake messages | **pass** | `node scripts/privacy-scan.mjs`; privacy tests in `adapter.test.mjs` and `real-backend.test.mjs`; ACP assertions |
| 10 | Full loop: idle → wake → multi-claim → complete → continue/silence | **pass** | ACP transcript above: wake → `inbox_list` → `inbox_claim` → `inbox_complete` → board empty → silent |

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
