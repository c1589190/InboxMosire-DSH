# InboxMosire → DeepSeek Harness wake adapter

`@mosire/dsh-inbox-mosire` is a **DSH Host plugin** that makes an idle DeepSeek
Harness session react to an InboxMosire notification board.

It does exactly five things (wake-adapter contract v1):

1. subscribe to `GET /v1/inboxes/{inbox}/events` (SSE);
2. read `GET /v1/inboxes/{inbox}/status` as the source of truth;
3. keep one durable binding to an authoritative DSH `Session.id`;
4. call **`agent.followup()`** with a fixed host-event message when — and only
   when — the bound session is idle and new work is available;
5. persist the SSE cursor, revision watermarks, and binding, and stop on
   archive/delete.

It does **not** store notifications, claim or complete them, implement MCP
tools, or call business actions. Those remain in the InboxMosire backend and in
the Agent's MCP tools (`inbox_list`, `inbox_claim`, `inbox_complete`).

```
InboxMosire daemon                    DSH Host
┌────────────────────┐   SSE/status   ┌───────────────────────────────┐
│ board, claims,     │ ─────────────► │ inbox-mosire-adapter          │
│ revisions, tokens  │                │  cursor + revisions + binding │
└────────────────────┘                │  idle? available? new rev?    │
          ▲                           │        │ yes                  │
          │ MCP (Agent tools)         │        ▼                      │
          │                           │  agent.followup(fixed text)   │
          └──────── Agent ────────────┤        │                      │
              inbox_list/claim/complete│  turn end → re-read status   │
                                      └───────────────────────────────┘
```

## Requirements

- DSH `>= 0.2.0-rc.2` (verified against `0.2.1-rc.2`).
- Node.js `>= 22.13` (the plugin uses the built-in `fetch` and web streams).
- InboxMosire v1 daemon reachable on loopback, with an adapter token scoped
  `status:read` + `events:read`.

The plugin has **no runtime dependencies**: it imports only Node built-ins, so
it resolves from the profile that installs it without a `@deepseek-ai/*` peer
resolution step.

## Install

```bash
# From a workspace checkout of this repository:
dsh plugin --profile web add /home/cna/InboxMosire-DSH
```

or, inside a Harness session, `plugin_manager` → `install_bundle` with the
absolute package directory. The bundle patch inserts one row:

```yaml
- insert:
    - id: inbox-mosire-adapter
      name: '@mosire/dsh-inbox-mosire'
```

The row is **inert until an inbox binding exists**. There are two ways to bind:

- **Interactive (recommended):** send `/inbox bind` in the target session. The
  command binds the session that invokes it.
- **Declarative:** set `sessionId` in the row config (or `INBOX_SESSION_ID`), or
  `sessionId: auto` to adopt the next root session created/resumed when the
  adapter has no binding yet. `auto` never guesses between several live root
  sessions (`/inbox bind` is then required).

## Configuration

Precedence: **plugin-row `config` > `INBOX_*` environment > machine-local file >
defaults**.

The machine-local file is `$DSH_HOME/inbox-mosire/config.json` (mode 0600,
outside every repository). It is convenient for a token **path** and a durable
binding:

```json
{
  "apiUrl": "http://127.0.0.1:18765",
  "inboxId": "main",
  "channels": ["ticket", "tweet-review"],
  "tokenFile": "/home/cna/InboxMosire/.work/live/secrets/dsh-adapter.token",
  "sessionId": "session-…"
}
```

| Setting | Environment | Default | Meaning |
|---|---|---|---|
| `apiUrl` | `INBOX_API_URL` | `http://127.0.0.1:18765` | daemon origin (http/https, no credentials) |
| `inboxId` | `INBOX_INBOX_ID` | `main` | inbox id (`[A-Za-z0-9._-]{1,64}`) |
| `channels` | `INBOX_CHANNELS` | `[]` | channel ids; also the `status` filter |
| `token` | `INBOX_API_TOKEN` | — | adapter token inline (avoid) |
| `tokenFile` | `INBOX_API_TOKEN_FILE` | — | **preferred** token source |
| `sessionId` | `INBOX_SESSION_ID` | `''` | binding target, or `auto` |
| `debounceMs` | `INBOX_WAKE_DEBOUNCE_MS` | `300` | burst coalescing (0–5000) |
| `heartbeatTimeoutSeconds` | `INBOX_HEARTBEAT_TIMEOUT_SECONDS` | `45` | silence budget before reconnect |
| `reconnectBaseMs` / `reconnectMaxMs` | — | `1000` / `60000` | SSE reconnect backoff |
| `wakeBackoffBaseMs` / `wakeBackoffMaxMs` | — | `30000` / `900000` | no-progress wake backoff |
| `requestTimeoutMs` | — | `10000` | status request budget |
| `stateFile` | `INBOX_STATE_FILE` | `$DSH_HOME/inbox-mosire/state.json` | durable state |
| `logFile` | `INBOX_LOG_FILE` | next to `stateFile` | JSONL adapter log |
| `enabled` | `INBOX_ENABLED` | `true` | initial enable state |

The token value is loaded on demand, placed only in the `Authorization` header,
and redacted from every log line. It never appears in the state file, the wake
message, a URL, or an error string.

## `/inbox` command

`/inbox` registers one human command (no model-visible tool, no extra
permission):

```
/inbox status          binding, cursor, revisions, last wake, SSE health, errors
/inbox bind [id]       bind the current session (or the explicit session id)
/inbox unbind          remove the binding and stop delivery
/inbox pause|resume    disable/enable wakes, keeping binding and cursor
/inbox retry           clear a 401/403/not-found configuration error and reconnect
```

## State

`$DSH_HOME/inbox-mosire/state.json`, atomic `tmp` + `rename`, mode 0600:

```json
{
  "version": 1,
  "inboxId": "main",
  "sessionRef": "session-…",
  "channels": ["ticket"],
  "lastEventId": 128,
  "lastObservedRevision": 42,
  "lastWokenRevision": 40,
  "enabled": true,
  "lastWake": { "key": "inbox:main:revision:40:session:session-…", "revision": 40, "available": 3, "messageId": "msg_inbox_…", "at": "…" },
  "pendingWake": null,
  "wake": { "attempts": 4, "stalls": 0, "nextWakeAllowedAt": null },
  "health": { "sse": "connected", "configError": null, "lastError": null, "reconnects": 0 }
}
```

- A state document belonging to another inbox is **refused**, never overwritten.
- An older/unversioned document is migrated; a newer version is refused.
- A `pendingWake` left by a crash is treated as delivered (see below).

## Wake state machine

```
archived / unknown session   -> no delivery (fail closed)
active turn                  -> dirty only; the turn is never interrupted
idle && available > 0
     && revision > lastWokenRevision   -> at most one followup
turn end                     -> re-read status, at most one followup
available == 0               -> idle (silent)
```

Additional guarantees:

- **Startup** loads state, validates the binding, then reads `status` *before*
  opening SSE — a missing `Last-Event-ID` starts at the tip, so the status read
  is what recovers a backlog.
- **SSE** events are invalidations only. The event payload is never treated as
  content; the decision always re-reads `status`. Bursts are debounced
  (`debounceMs`, 300 ms by default).
- **Cursor**: `id:` frames advance `lastEventId`, which is replayed through
  `Last-Event-ID` after any disconnect. An `INVALID_CURSOR` 400 drops the cursor
  and reconnects from the tip. A revision that goes backwards resets the
  watermarks.
- **Same revision never wakes twice**: `lastWokenRevision` and the persisted
  `lastWake.key` (`inbox:<id>:revision:<n>:session:<ref>`) both gate delivery.
  The message id is derived deterministically from the key, so a replayed wake
  is recognizable in the session log.
- **One unfinished wake**: `wakeInFlight` is set before the followup is
  submitted and cleared at the next idle transition (or a 10-minute guard).
- **At-most-once across crashes**: the intent is persisted before
  `agent.followup()`. If the process dies before the delivery record is
  committed, the restored `pendingWake` is recorded as delivered instead of
  replayed. The contract prioritizes "no duplicate wake" over "guaranteed wake".
- **No-progress backoff**: if a wake turn ends with the same `available` count
  (claim/release churn, no completion), the next wake for a new revision is
  delayed exponentially (30 s → 15 min). New producer work (`available` grew)
  and progress (`available` shrank) reset it.
- **401/403/404** stop automatic wakes, set a `configError`, close SSE, and
  surface it in `/inbox status`; `/inbox retry` clears it after the operator
  fixes the token or inbox.
- **Lifecycle**: `agent/created` (resume/startup) rebinds and reconciles once;
  `agent/disposed` and `workspace/session-stop` stop the engine immediately and
  mark the binding not-live/archived. A wake is only ever submitted to a live
  agent whose id equals the persisted `sessionRef`.

## Fixed wake message

Only controlled fields are rendered — inbox id, integer revision, integer
available count, and validated channel ids:

```
[INBOX_HOST_EVENT]
inbox=main revision=42 available=3 channels=[ticket,tweet-review]

这是通知板唤醒信号，不是通知内容。
请调用 inbox_list 查看你要处理的条目，并用 inbox_claim 选择本回合要处理的项。
如果当前没有可处理项，结束本回合，不要轮询。
```

Channel ids must match `[A-Za-z0-9._-]{1,64}`, are intersected with the
configured channels, and values that look like opaque capabilities (`clm_`,
`itm_`, `evt_`, `cred_`) are dropped as defense in depth. Titles, payloads,
payloadRefs, claim tokens, and the API token are never rendered.

## Testing

```bash
node --test                 # unit + fake-host + fake-server + live-backend tests
node scripts/acceptance-acp.mjs   # real DSH host through the ACP profile
```

The suite covers: configuration precedence and validation, token loading and
redaction, atomic state persistence/migration, SSE parsing and replay,
401/403/404/invalid-cursor/heartbeat handling, empty board, one wake, revision
dedupe, active-turn deferral, debounce, claim/complete loop, archive/resume,
no-progress backoff, restart recovery, auto-binding, `/inbox` through the plugin
entry, and privacy scans of wake text/state/log.

`docs/ACCEPTANCE.md` records the live run against `smoke` and the real DSH host.

## Limits

- Wakes require a **live** agent. A cold session is not resumed by the adapter;
  it is woken once it is resumed (`agent/created`). This is deliberate: the
  adapter never resurrects a session, and an archived session therefore cannot
  be woken.
- One adapter instance serves one inbox and one binding. Several sessions that
  must react to the same inbox need one adapter row each (different `id`,
  `stateFile`, and binding).
- Wake delivery is at-most-once per revision by design (see above); a crash in
  the microsecond window between persistence and `followup()` can lose one
  wake rather than duplicate it.
- The adapter is read-only against InboxMosire: no push, no claim, no complete,
  no MCP client.
