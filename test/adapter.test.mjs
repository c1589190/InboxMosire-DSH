import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { renderWakeTemplate } from '../lib/template.js'
import { createFakeHost, createTestAdapter, delay, waitFor } from './helpers/fake-host.mjs'
import { startFakeInbox } from './helpers/fake-server.mjs'

/**
 * Build a started adapter on a fake inbox and a fake host.
 * @param {import('node:test').TestContext} t - test context.
 * @param {object} [options] - setup options.
 * @param {'idle'|'running'} [options.agentStatus] - initial agent status.
 * @param {boolean} [options.createAgent] - create the bound agent.
 * @param {boolean} [options.start] - call `adapter.start()`.
 * @param {Record<string, any>} [options.overrides] - config overrides.
 * @returns {Promise<Record<string, any>>} connected handles.
 */
async function setup(t, { agentStatus = 'idle', createAgent = true, start = true, overrides = {} } = {}) {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const host = createFakeHost()
  const agent = createAgent ? host.createAgent('session-test', { status: agentStatus }) : undefined
  const created = await createTestAdapter({ server, host, overrides })
  t.after(() => created.adapter.stop())
  if (start) await created.adapter.start()
  return { server, host, agent, ...created }
}

test('an empty board never wakes the session', async (t) => {
  const { server, host, adapter } = await setup(t)
  await waitFor(() => server.connectionCount === 1, { label: 'SSE connection' })
  await delay(150)
  assert.equal(host.followups.length, 0)
  assert.equal(adapter.snapshot().lastWokenRevision, 0)
  assert.equal(adapter.snapshot().health.sse, 'connected')
})

test('one push wakes an idle session exactly once with a bounded summary', async (t) => {
  const { server, host, adapter } = await setup(t)
  await waitFor(() => server.connectionCount === 1, { label: 'SSE connection' })
  server.push({ channel: 'ticket', title: '工单更新' })
  await waitFor(() => host.followups.length === 1, { label: 'first wake' })
  const { message } = host.followups[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'inbox-mosire')
  assert.deepEqual(message.content, [
    {
      type: 'text',
      text: renderWakeTemplate({
        inboxId: 'smoke',
        revision: 1,
        available: 1,
        channels: ['ticket'],
        summary: {
          items: [
            {
              itemId: 'itm_fake_1',
              channel: 'ticket',
              kind: 'reply',
              summary: '工单更新',
            },
          ],
          remaining: 0,
          maxItems: 3,
          maxTitleChars: 80,
          maxTotalChars: 600,
        },
      }),
    },
  ])
  await waitFor(() => adapter.state.lastWokenRevision === 1, { label: 'watermark' })
  await delay(250)
  assert.equal(host.followups.length, 1, 'no duplicate followup')
})

test('the same revision is never woken twice', async (t) => {
  const { server, host, agent, adapter } = await setup(t)
  await waitFor(() => server.connectionCount === 1, { label: 'SSE connection' })
  server.push({ channel: 'ticket' })
  await waitFor(() => host.followups.length === 1, { label: 'first wake' })
  host.endTurn(agent)
  await delay(400)
  assert.equal(host.followups.length, 1)
  assert.equal(adapter.snapshot().wake.stalls, 1, 'no progress is recorded as a stall')
  assert.ok(adapter.snapshot().wake.nextWakeAllowedAt > Date.now() - 1000)
})

test('an active turn is only marked dirty; turn end wakes at most once', async (t) => {
  const { server, host, agent } = await setup(t, { agentStatus: 'running' })
  await waitFor(() => server.connectionCount === 1, { label: 'SSE connection' })
  server.push({ channel: 'ticket' })
  server.push({ channel: 'ticket' })
  server.push({ channel: 'ticket' })
  await delay(200)
  assert.equal(host.followups.length, 0, 'the active turn is not interrupted')
  host.endTurn(agent)
  await waitFor(() => host.followups.length === 1, { label: 'single turn-end wake' })
  assert.match(host.followups[0].message.content[0].text, /revision=3 available=3/)
  await delay(250)
  assert.equal(host.followups.length, 1)
})

test('a burst of events is debounced into one wake', async (t) => {
  const { server, host } = await setup(t)
  await waitFor(() => server.connectionCount === 1, { label: 'SSE connection' })
  for (let index = 0; index < 6; index += 1) server.push({ channel: 'ticket' })
  await waitFor(() => host.followups.length === 1, { label: 'debounced wake' })
  await delay(300)
  assert.equal(host.followups.length, 1)
  assert.match(host.followups[0].message.content[0].text, /revision=6 available=6/)
})

test('claiming and completing inside a turn keeps the loop going', async (t) => {
  const { server, host, agent } = await setup(t)
  await waitFor(() => server.connectionCount === 1, { label: 'SSE connection' })
  server.push({ channel: 'ticket' })
  server.push({ channel: 'ticket' })
  server.push({ channel: 'ticket' })
  await waitFor(() => host.followups.length === 1, { label: 'first wake' })

  server.claim('ticket', 2)
  server.complete('ticket', 1)
  host.endTurn(agent)
  await waitFor(() => host.followups.length === 2, { label: 'follow-up wake' })
  assert.equal(server.available, 1)
  assert.match(host.followups[1].message.content[0].text, /available=1/)

  server.claim('ticket', 1)
  server.complete('ticket', 1)
  host.endTurn(agent)
  await delay(400)
  assert.equal(host.followups.length, 2, 'empty board stays silent')
  assert.equal(server.available, 0)
})

test('an archived session receives no wake; resume wakes once', async (t) => {
  const { server, host, agent, adapter } = await setup(t)
  await waitFor(() => server.connectionCount === 1, { label: 'SSE connection' })
  server.push({ channel: 'ticket' })
  await waitFor(() => host.followups.length === 1, { label: 'first wake' })

  host.dispose(agent)
  await delay(100)
  assert.equal(adapter.snapshot().health.session, 'disposed')
  assert.equal(server.connectionCount, 0, 'SSE stops with the session')
  server.push({ channel: 'ticket' })
  await delay(300)
  assert.equal(host.followups.length, 1, 'no delivery to an archived session')

  host.createAgent('session-test', { status: 'idle' })
  await waitFor(() => host.followups.length === 2, { label: 'resume wake' })
  assert.match(host.followups[1].message.content[0].text, /revision=2 available=2/)
})

test('401 stops automatic wakes, records a config error, and retry recovers', async (t) => {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const host = createFakeHost()
  host.createAgent('session-test')
  const { adapter } = await createTestAdapter({ server, host })
  t.after(() => adapter.stop())

  server.setAuthMode('401')
  await adapter.start()
  assert.equal(adapter.configError?.code, 'AUTH_FAILED')
  assert.equal(server.connectionCount, 0)
  server.push({ channel: 'ticket' })
  await delay(250)
  assert.equal(host.followups.length, 0)
  assert.match(adapter.statusText(), /CONFIG ERROR: AUTH_FAILED/)

  server.setAuthMode('ok')
  const retried = await adapter.retry()
  assert.equal(retried.ok, true)
  await waitFor(() => server.connectionCount === 1, { label: 'reconnected SSE' })
  await waitFor(() => host.followups.length === 1, { label: 'wake after retry' })
  assert.equal(adapter.configError, null)
})

test('a missing inbox is a fail-closed configuration error', async (t) => {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const host = createFakeHost()
  host.createAgent('session-test')
  const { adapter } = await createTestAdapter({ server, host, overrides: { inboxId: 'other' } })
  t.after(() => adapter.stop())
  await adapter.start()
  assert.equal(adapter.configError?.code, 'INBOX_NOT_FOUND')
})

test('SSE reconnect replays from the last event id and still wakes', async (t) => {
  const { server, host, agent } = await setup(t)
  await waitFor(() => server.connectionCount === 1, { label: 'SSE connection' })
  server.push({ channel: 'ticket' })
  await waitFor(() => host.followups.length === 1, { label: 'first wake' })
  server.disconnectAll()
  await waitFor(() => server.connectionCount === 1, { label: 'SSE reconnect' })
  assert.equal(server.connections.at(-1).lastEventId, 1, 'reconnect carries Last-Event-ID')

  server.push({ channel: 'ticket' })
  server.push({ channel: 'ticket' })
  host.endTurn(agent)
  await waitFor(() => host.followups.length === 2, { label: 'wake after reconnect' })
  assert.match(host.followups[1].message.content[0].text, /revision=3 available=3/)
})

test('an invalid cursor is dropped and the stream reconnects from the tip', async (t) => {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const host = createFakeHost()
  host.createAgent('session-test')
  const dir = await mkdtemp(join(tmpdir(), 'inbox-cursor-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const stateFile = join(dir, 'state.json')
  await writeFile(
    stateFile,
    JSON.stringify({
      version: 1,
      inboxId: 'smoke',
      sessionRef: 'session-test',
      channels: ['ticket'],
      lastEventId: 9,
      lastObservedRevision: 9,
      lastWokenRevision: 9,
      enabled: true,
      wake: { attempts: 1, stalls: 0, nextWakeAllowedAt: null },
      health: {},
    }),
  )
  server.setInvalidCursor(true)
  const { adapter } = await createTestAdapter({ server, host, stateFile })
  t.after(() => adapter.stop())
  await adapter.start()
  await waitFor(() => server.connectionCount === 1, { label: 'cursorless reconnect' })
  assert.equal(adapter.state.lastEventId, null)
  assert.equal(server.connections.at(-1).lastEventId, null)
})

test('RESTART: cursor, watermark, and binding survive a restart without a duplicate wake', async (t) => {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const firstHost = createFakeHost()
  firstHost.createAgent('session-test')
  const first = await createTestAdapter({ server, host: firstHost })
  await first.adapter.start()
  await waitFor(() => server.connectionCount === 1, { label: 'first SSE connection' })
  server.push({ channel: 'ticket' })
  await waitFor(() => firstHost.followups.length === 1, { label: 'first wake' })
  await first.adapter.whenSettled()
  await first.adapter.stop()
  const snapshotAfterStop = first.adapter.snapshot()
  assert.equal(snapshotAfterStop.lastWokenRevision, 1)
  assert.equal(snapshotAfterStop.cursor, 1)

  const secondHost = createFakeHost()
  secondHost.createAgent('session-test')
  const second = await createTestAdapter({
    server,
    host: secondHost,
    stateFile: first.stateFile,
  })
  t.after(() => second.adapter.stop())
  await second.adapter.start()
  await waitFor(() => server.connections.length >= 2, { label: 'second SSE connection' })
  assert.equal(server.connections.at(-1).lastEventId, 1, 'cursor restored from disk')
  await delay(250)
  assert.equal(secondHost.followups.length, 0, 'processed revision is not woken again')
  assert.equal(second.adapter.state.lastWokenRevision, 1)

  server.push({ channel: 'ticket' })
  await waitFor(() => secondHost.followups.length === 1, { label: 'wake after restart' })
  assert.match(secondHost.followups[0].message.content[0].text, /revision=2/)
})

test('RESTART: an interrupted wake is treated as delivered (at-most-once)', async (t) => {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const host = createFakeHost()
  host.createAgent('session-test')
  const dir = await mkdtemp(join(tmpdir(), 'inbox-pending-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const stateFile = join(dir, 'state.json')
  server.push({ channel: 'ticket' })
  server.push({ channel: 'ticket' })
  await writeFile(
    stateFile,
    JSON.stringify({
      version: 1,
      inboxId: 'smoke',
      sessionRef: 'session-test',
      channels: ['ticket'],
      lastEventId: 2,
      lastObservedRevision: 2,
      lastWokenRevision: 1,
      enabled: true,
      pendingWake: {
        key: 'inbox:smoke:revision:2:session:session-test',
        revision: 2,
        available: 2,
        messageId: 'msg_inbox_pending',
        at: new Date().toISOString(),
      },
      wake: { attempts: 1, stalls: 0, nextWakeAllowedAt: null },
      health: {},
    }),
  )
  const { adapter } = await createTestAdapter({ server, host, stateFile })
  t.after(() => adapter.stop())
  await adapter.start()
  await waitFor(() => server.connectionCount === 1, { label: 'SSE connection' })
  await delay(200)
  assert.equal(host.followups.length, 0, 'the unconfirmed wake is not replayed')
  assert.equal(adapter.state.lastWokenRevision, 2)
  assert.equal(adapter.state.pendingWake, null)
})

test('no-progress wakes are backed off before the next revision is woken', async (t) => {
  const { server, host, agent, adapter } = await setup(t, {
    overrides: { wakeBackoffBaseMs: 300, wakeBackoffMaxMs: 600 },
  })
  await waitFor(() => server.connectionCount === 1, { label: 'SSE connection' })
  server.push({ channel: 'ticket' })
  await waitFor(() => host.followups.length === 1, { label: 'first wake' })
  server.claim('ticket', 1)
  server.release('ticket', 1)
  host.endTurn(agent)
  await delay(150)
  assert.equal(host.followups.length, 1, 'backoff holds the next wake')
  await waitFor(() => host.followups.length === 2, { label: 'delayed wake', timeoutMs: 3000 })
  assert.ok(adapter.snapshot().wake.attempts >= 2)
})

test('auto-binding adopts the session created after startup', async (t) => {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const host = createFakeHost()
  const { adapter } = await createTestAdapter({
    server,
    host,
    overrides: { sessionId: 'auto' },
  })
  t.after(() => adapter.stop())
  await adapter.start()
  assert.equal(adapter.state.sessionRef, '')
  host.createAgent('session-auto')
  await waitFor(() => adapter.state.sessionRef === 'session-auto', { label: 'auto bind' })
  await waitFor(() => server.connectionCount === 1, { label: 'SSE after auto bind' })
  server.push({ channel: 'ticket' })
  await waitFor(() => host.followups.length === 1, { label: 'wake for auto-bound session' })
})

test('PRIVACY: summaries carry no payload and no artifact carries the token', async (t) => {
  const { server, host, adapter } = await setup(t)
  await waitFor(() => server.connectionCount === 1, { label: 'SSE connection' })
  server.push({
    channel: 'ticket',
    title: 'PUBLIC-SUMMARY-TITLE-42',
    payload: { body: 'SECRET-BODY-42', payloadRef: '/secret/ref' },
  })
  await waitFor(() => host.followups.length === 1, { label: 'wake' })
  await adapter.whenSettled()
  await delay(100)
  const texts = host.followups.map((entry) => entry.message.content[0].text).join('\n')
  const stateText = await readFile(adapter.config.stateFile, 'utf8')
  const logText = await readFile(adapter.config.logFile, 'utf8')
  const loggerText = host.logs.map((line) => line.message).join('\n')
  assert.match(texts, /PUBLIC-SUMMARY-TITLE-42/, 'the bounded title is part of the summary')
  for (const haystack of [texts, stateText, logText, loggerText]) {
    assert.ok(!haystack.includes('SECRET-BODY-42'))
    assert.ok(!haystack.includes('/secret/ref'))
    assert.ok(!haystack.includes('test-token'))
  }
  for (const haystack of [stateText, logText, loggerText]) {
    assert.ok(!haystack.includes('PUBLIC-SUMMARY-TITLE-42'), 'state and logs never store titles')
  }
})

test('the plugin entry wires a v2 manager and the /inbox command', async (t) => {
  const server = await startFakeInbox({ inbox: 'app-a' })
  t.after(() => server.close())
  const host = createFakeHost()
  host.createAgent('session-test')
  const home = await mkdtemp(join(tmpdir(), 'inbox-home-'))
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const tokenFile = join(home, 'wake.token')
  await writeFile(tokenFile, `${server.token}\n`, { mode: 0o600 })
  const descriptorFile = join(home, 'binding.json')
  await writeFile(
    descriptorFile,
    JSON.stringify({
      inboxId: 'app-a',
      apiBaseUrl: server.url,
      adapterTokenRef: `file:${tokenFile}`,
      channels: [],
      label: 'entry-test',
    }),
  )
  const saved = { ...process.env }
  Object.assign(process.env, {
    DSH_HOME: home,
    INBOX_API_URL: server.url,
    INBOX_STATE_FILE: join(home, 'state.json'),
    INBOX_LOG_FILE: join(home, 'adapter.log'),
    INBOX_WAKE_DEBOUNCE_MS: '20',
  })
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key]
    }
    Object.assign(process.env, saved)
  })

  apply(host.ctx, {})
  await waitFor(() => host.commands.length === 1, { label: '/inbox registration' })
  const definition = host.commands[0]
  assert.equal(definition.name, 'inbox')

  const empty = await definition.handler({ rawInput: 'status', agent: { id: 'session-test' } })
  assert.equal(empty.kind, 'success')
  assert.match(empty.text, /0 binding\(s\)/)
  assert.match(empty.text, /isBound=false/)

  const bound = await definition.handler({
    rawInput: `bind ${descriptorFile}`,
    agent: { id: 'session-test' },
  })
  assert.match(bound.text, /已绑定 session-test → app-a/)
  assert.match(bound.text, /isBound=true inbox=app-a/)
  await waitFor(() => server.connectionCount === 1, { label: 'SSE through plugin entry' })
  server.push({ channel: 'ticket' })
  await waitFor(() => host.followups.length === 1, { label: 'wake through plugin entry' })

  const removed = await definition.handler({
    rawInput: 'unbind',
    agent: { id: 'session-test' },
  })
  assert.match(removed.text, /已解绑 session-test/)
  await waitFor(() => server.connectionCount === 0, { label: 'SSE closed after unbind' })

  await host.disposeAll()
})
