# DSH Host capability probe

Probe target: DeepSeek Harness `0.2.1-rc.2`, profile `web` / `acp`, process on
this machine. Everything below was read from the installed packages (not from
the DSH source checkout) through the Host Inspect providers
(`Service.listService`, `Event.listEvents`) and the package type declarations.

Paths are relative to
`/home/cna/.local/share/pnpm/global/v11/4bb-18e127bbb990c805-0/node_modules/.pnpm/`.

---

## 1. Authoritative session id

**Yes.** A live `Agent` exposes `agent.id: SessionId` and `agent.session: Session`;
`Session.id` mirrors it and is the identity persisted by the session store.

- `@deepseek-ai+dsh-agent@0.2.1-rc.2_…/node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:139-147`
  (`interface Agent { readonly session: Session; … }`),
  `…/lib/types/types.d.ts:11` (`interface Agent { readonly id: SessionId }`).
- `@deepseek-ai+dsh-session@0.2.1-rc.2_…/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts:40`
  (`class Session { get id(): SessionId }`).
- The id is supplied by the host only. Producer input never reaches it; the
  adapter takes it from `invocation.agent.id` (`/inbox bind`) or from
  `ctx.agents.list()` (`sessionId: auto`).

## 2. Turn start / turn end / idle lifecycle

**Yes.**

| Signal | Event | Mode | Declaration |
|---|---|---|---|
| agent running ⇄ idle | `agent/status` | emit | `runtime-types.d.ts:252` (`{ agent, status: AgentStatus }`) |
| status type | — | — | `runtime-types.d.ts:90` (`'idle' \| 'running'`) |
| turn about to close | `agent/turn-stopping` | serial | `runtime-types.d.ts:387` |
| agent created (startup/resume/clear/compact) | `agent/created` | serial | `runtime-types.d.ts:227` |
| agent disposed | `agent/disposed` | emit | `runtime-types.d.ts:240` |
| durable turn boundary | `session/event` → `turn/end` | emit | `@deepseek-ai+dsh-session…/lib/types/index.d.ts:61`, `types.d.ts:274` |
| session archived with activity stop | `workspace/session-stop` | parallel | `@deepseek-ai+dsh-workspace…/lib/types/index.d.ts:110` |

`agent/status` `idle` is the primary turn-end/idle signal. The durable
`turn/end` event is used as a second trigger so a missed status frame cannot
strand the loop. Both funnel into one serialized, debounced decision.

## 3. Session resume / archive / delete

**Yes.** `agent/created` carries `source: 'startup' | 'resume' | 'clear' | 'compact'`,
and `agent/disposed` fires when a session is archived, deleted, or unloaded.
`workspace/session-stop` fires for an archive that stops work
(`SessionActivityRequest = { sessionId }`, `index.d.ts:67`).

The adapter treats `disposed` / `session-stop` as immediate stop conditions and
requires `ctx.agents.get(sessionRef)` to return a live agent before any wake, so
an archived session is fail-closed even if a lifecycle frame is missed.

## 4. `agent.followup()` or equivalent

**Yes — the exact entry point the contract asks for.**

- `@deepseek-ai+dsh-agent…/lib/types/runtime-types.d.ts:192`
  `followup(message: UserMessage): void` — *"Queue an ordinary follow-up turn and
  wake the driver. The item becomes the sole ordinary message of its own turn."*
- Related, unused by this adapter: `send(message, target, wakeup)` (`:186`),
  `steer(message)` (`:200`), `inject(message)` (`:209`), `whenIdle()` (`:164`).
- Host precedent for this exact pattern:
  `@deepseek-ai+dsh-schedule…/lib/index.js:1586-1596` builds a `UserMessage`
  with `createUserMessage({ content, source })` and calls
  `resolved.agent.followup(message)`, then `ctx.sessions.flush(...)`.
- `createUserMessage` lives in `@deepseek-ai+dsh-llm…/lib/index.js:59`; it always
  mints a random `MessageId`, so this adapter constructs the same immutable
  shape itself (`lib/template.js:buildWakeMessage`) to keep a deterministic,
  idempotency-derived id and to avoid a `@deepseek-ai/*` runtime dependency.

## 5. Idempotency keys for followup

**No first-class key.** `followup()` takes a `UserMessage` whose `id: MessageId`
is normally random and is not deduplicated by the host.

The adapter therefore implements the contract's suggested key itself:
`inbox:<inboxId>:revision:<n>:session:<sessionRef>` is persisted before delivery
and derives the message id (`sha256(key)[0:24]`). Duplicate suppression lives in
the durable state (`lastWake.key`, `lastWokenRevision`, `pendingWake`), not in
the host.

## 6. Where adapter state should live

**Decision: a dedicated atomic JSON document under `$DSH_HOME`, not a
per-session DSH storage domain.**

- DSH's own durable stores are session-scoped or host-singleton
  (`ctx.storageDomain` / `ctx.storage`, with per-session projections). The wake
  binding is *host-wide* (it names one session and outlives that session's
  agent), so it does not fit a per-session domain, and writing into the session
  log would mix adapter bookkeeping into the model transcript.
- `$DSH_HOME/inbox-mosire/state.json` is the same profile-owned area DSH already
  uses for `storages/`, `sessions/`, and credentials; it survives restart,
  profile switches, and plugin reinstalls, and is mode 0600.
- The state file is explicitly versioned (`version: 1`) with a migration path
  and a refusal path for unknown/newer versions and foreign inboxes.

## 7. Model-facing tool registration

**Yes.** A Host plugin registers tools with the same API the built-in tools use:

- `tools.register(definition: ToolDefinition): () => void`
  (`@deepseek-ai/dsh-tools…/lib/types/index.d.ts:96`), where
  `ToolDefinition extends ToolSchema` and adds
  `output: { schema, render(args, value) }` and
  `execute(args, exec): Promise<unknown>` (`:115-128`).
- `ToolExecutionInput.agent?: Agent` (`:229`) identifies the calling session, so
  a binding tool can be authoritative; `exec.signal` carries cancellation.
- Precedent: `@deepseek-ai/dsh-mcp-client…/lib/index.js:179-195` builds plain
  `{ name, description, parameters: inputSchema, output, execute }` definitions
  — exactly the shape this bundle's `tools.js` uses, with no DSH import needed.
- The adapter exposes only `inbox_adapter_status|bind|unbind`; the board tools
  stay on the MCP surface (`mcp__inbox-mosire__*`) as the handoff requires.

## 8. Credentials for the token

The adapter deliberately does **not** use `ctx.credentials`: the contract
requires a local secret file read at runtime (`INBOX_API_TOKEN_FILE`). The token
is read on every start, kept in memory, used only in the `Authorization` header,
and redacted from all logs.

---

## Conclusion

Every hook the wake-adapter contract requires exists in this DSH version:
authoritative session id, turn/idle lifecycle, resume/archive/dispose,
`agent.followup()`, durable state, and a human command surface for binding.
The adapter is **not degraded** — no acceptance item is blocked by a missing
host capability.

The only contract item DSH does not provide natively is a followup idempotency
key; the adapter supplies it through persisted revision watermarks and a
deterministic message id.
