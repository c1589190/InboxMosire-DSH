# InboxMosire → DeepSeek Harness wake adapter (v2, multi-binding)

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

## Boundaries (Mode A)

The adapter only:

1. reads a **BindingDescriptor** (`inboxId`, `apiBaseUrl`, `adapterTokenRef`,
   `channels`, `label`);
2. opens one SSE stream per binding;
3. reads `status` as the source of truth;
4. calls `agent.followup()` at the idle/turn-end boundary;
5. persists each binding's cursor/revision/wake state;
6. stops on archive/dispose and maintains advisory occupancy.

It never claims, completes, pushes, reads item content, or speaks MCP. The
target session uses its **program-owned MCP** (Mode A) for
`inbox_list`/`inbox_claim`/`inbox_complete`. The central InboxMosire MCP is not
exposed to target sessions.

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
| `inbox_adapter_bind` | `sessionId?`, `inboxId`, `adapterTokenRef`, `apiBaseUrl?`, `channels?`, `label?`, `descriptor?` | bind one session (default: caller); same inbox keeps cursor/watermark, a different inbox resets them |
| `inbox_adapter_status` | — | caller binding (inbox/cursor/SSE/occupancy/last wake/config error) + other bindings summary; never a token |
| `inbox_adapter_unbind` | `sessionId?` | remove one binding and clear its occupancy; other bindings untouched |

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

## Global configuration

Precedence: plugin-row `config` > `INBOX_*` environment > `$DSH_HOME/inbox-mosire/config.json`
> defaults.

| Setting | Environment | Default |
|---|---|---|
| `apiUrl` (fallback for descriptors) | `INBOX_API_URL` | `http://127.0.0.1:18765` |
| `stateFile` | `INBOX_STATE_FILE` | `$DSH_HOME/inbox-mosire/state.json` |
| `logFile` | `INBOX_LOG_FILE` | next to `stateFile` |
| `debounceMs` | `INBOX_WAKE_DEBOUNCE_MS` | `300` |
| `heartbeatTimeoutSeconds` | `INBOX_HEARTBEAT_TIMEOUT_SECONDS` | `45` |
| `requestTimeoutMs` | — | `10000` |
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
      "lastWake": { "revision": 40, "available": 1 },
      "enabled": true,
      "health": { "sse": "connected", "session": "live", "occupied": "occupied" }
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

## Occupancy

`PUT /v1/inboxes/{inbox}/occupancy {"occupiedBy":"<sessionRef>"}` on bind (and
on resume), `DELETE` on unbind/archive/dispose. It is advisory: a token without
`inbox:occupy` produces a warning, never a blocked wake. `status` exposes
`occupied/occupiedBy/occupiedAt`.

## Fixed wake message

```
[INBOX_HOST_EVENT]
inbox={inboxId} revision={revision} available={available} channels=[{changedChannels}]

这是通知板唤醒信号，不是通知内容。
请使用你的程序 MCP 的 inbox_list 查看你要处理的条目，并用 inbox_claim 选择本回合要处理的项。
如果当前没有可处理项，结束本回合，不要轮询。
```

Only controlled fields are rendered. Channel ids are validated and intersected
with the binding's channels; values shaped like opaque capabilities (`clm_`,
`itm_`, `evt_`, `cred_`) are dropped.

## Testing and acceptance

```bash
node --test                        # 73 tests
node --test test/real-backend.test.mjs   # live app-a/app-b isolation
node scripts/acceptance-acp.mjs    # real DSH host, two ACP sessions
node scripts/privacy-scan.mjs      # credentials across repo/state/logs/sessions
```

`docs/ACCEPTANCE.md` records the live evidence; `docs/DELIVERY.md` is the v2
delivery report.

## Limits

- A wake requires a **live** agent. A cold session is not resumed by the
  adapter; its binding starts when the session resumes.
- One binding per session; re-binding replaces it. Different sessions may bind
  different inboxes.
- Delivery is at-most-once per revision by design.
- Mode A assumes a program-owned MCP server for business tools. If none is
  running, a woken session has no inbox tools until one is attached.
- The adapter is read-only against InboxMosire.
