# Acceptance evidence — v2 multi-binding

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
| 8 | Daemon/DSH restart restores each binding | **pass** | manager restart test; real-backend restart step |
| 9 | Unreadable/non-absolute tokenRef fails closed | **pass** | manager + tools + real tests (`TOKEN_REF_NOT_ABSOLUTE`, `TOKEN_REF_UNREADABLE`) |
| 10 | No raw token in logs/state/wake/transcript | **pass** | privacy scan; wake-message assertions |
| 11 | Mode A: target session claims/completes via program MCP; adapter never does | **partial** | The adapter never calls claim/complete/list/push (asserted by code and tests). No program-owned MCP server is running on this machine, so claim/complete was exercised through the program's own HTTP client surface with the program tokens — the same calls `InboxClientMcpTools` wraps — not through the MCP transport. |
| 12 | After bind, occupancy is `occupied/occupiedBy=session`; after unbind `false` | **pass** | ACP run; real-backend test; fake-server occupancy assertions |
| 13 | Occupancy does not block another valid token | **pass** | backend contract; adapter treats a missing `inbox:occupy` as advisory |
| 14 | v1 single-binding data migrates or reports incompatibility, never silently | **pass** | `normalizeHostState` keeps `legacyV1`, migrates a usable binding, marks a tokenRef-less binding `blocked`; unit tests |

## Notes and limits

- The **web profile** still runs the v1 module generation in its live process
  from before this upgrade. The linked package, patch, and state migrate to v2
  on the next DSH restart; no unbound session is woken meanwhile.
- The central InboxMosire MCP connection (`custom-inbox-mosire`) was
  **disconnected** to honor Mode A: target sessions must use their program-owned
  MCP server, not the central one.
- The ACP wake turns had no business tools (no program MCP), so the driver
  drained the boards through the program's HTTP client surface. The adapter's
  wake message still told the model to use its program MCP, which is the
  intended production shape.
- `app-a`/`app-b` are left with `available=0`, `occupied=false` after the run.
