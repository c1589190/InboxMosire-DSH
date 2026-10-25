import test from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_ERROR, InboxClient, normalizeStatus } from '../lib/inbox-client.js'
import { delay, waitFor } from './helpers/fake-host.mjs'
import { startFakeInbox } from './helpers/fake-server.mjs'

/**
 * Start a fake server and a matching client.
 * @param {import('node:test').TestContext} t - test context.
 * @param {object} [options] - client overrides.
 * @returns {Promise<{server: Record<string, any>, client: InboxClient}>} handles.
 */
async function setup(t, options = {}) {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const client = new InboxClient({
    apiUrl: server.url,
    inboxId: server.inbox,
    channels: ['ticket'],
    token: server.token,
    requestTimeoutMs: 2000,
    ...options,
  })
  return { server, client }
}

test('status is normalized and requests carry the token only in the header', async (t) => {
  const { server, client } = await setup(t)
  server.push({ channel: 'ticket' })
  server.push({ channel: 'other' })
  const status = await client.getStatus()
  assert.equal(status.revision, 2)
  assert.equal(status.available, 1, 'channel filter limits the visible total')
  assert.deepEqual(status.channels, { ticket: { available: 1, claimed: 0 } })

  const request = server.requests.at(-1)
  assert.equal(request.path, '/v1/inboxes/smoke/status')
  assert.match(request.search, /channel=ticket/)
  assert.ok(!request.search.includes(server.token))
})

test('401, 403, and 404 are classified without exposing the token', async (t) => {
  const { server, client } = await setup(t)
  server.setAuthMode('401')
  await assert.rejects(
    () => client.getStatus(),
    (error) => {
      assert.equal(error.code, CLIENT_ERROR.AUTH)
      assert.equal(error.status, 401)
      assert.ok(!error.message.includes(server.token))
      return true
    },
  )
  server.setAuthMode('403')
  await assert.rejects(
    () => client.getStatus(),
    (error) => error.code === CLIENT_ERROR.AUTH && error.status === 403,
  )
  const missing = new InboxClient({
    apiUrl: server.url,
    inboxId: 'absent',
    token: server.token,
  })
  server.setAuthMode('ok')
  await assert.rejects(
    () => missing.getStatus(),
    (error) => error.code === CLIENT_ERROR.NOT_FOUND,
  )
})

test('SSE delivers ids, multi-line data, and ignores comments', async (t) => {
  const { server, client } = await setup(t)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const events = []
  const opened = new Promise((resolve) => {
    void client.streamEvents({
      signal: controller.signal,
      onOpen: resolve,
      onEvent: (event) => events.push(event),
    })
  })
  await opened
  server.push({ channel: 'ticket' })
  await waitFor(() => events.length === 1, { label: 'first SSE event' })
  assert.equal(events[0].id, 1)
  assert.equal(events[0].type, 'inbox.changed')
  const payload = JSON.parse(events[0].data)
  assert.equal(payload.data.revision, 1)
  assert.equal(payload.data.inbox, 'smoke')
  assert.ok(!events[0].data.includes('SECRET-TITLE'))
  assert.ok(!events[0].data.includes('SECRET-BODY'))
})

test('reconnect replays from Last-Event-ID and keeps the cursor', async (t) => {
  const { server, client } = await setup(t)
  const events = []
  let controller = new AbortController()
  const open = (lastEventId) =>
    new Promise((resolve) => {
      void client.streamEvents({
        lastEventId,
        signal: controller.signal,
        onOpen: resolve,
        onEvent: (event) => events.push(event),
      })
    })
  await open(null)
  server.push({ channel: 'ticket' })
  await waitFor(() => events.at(-1)?.id === 1, { label: 'event 1' })
  controller.abort()
  await delay(20)

  server.push({ channel: 'ticket' })
  server.push({ channel: 'ticket' })
  controller = new AbortController()
  t.after(() => controller.abort())
  await open(1)
  await waitFor(() => events.filter((event) => event.id > 1).length === 2, {
    label: 'replayed events',
  })
  assert.equal(server.connections.at(-1).lastEventId, 1)
  assert.deepEqual(events.map((event) => event.id), [1, 2, 3])
})

test('no Last-Event-ID starts at the current tip without replay', async (t) => {
  const { server, client } = await setup(t)
  server.push({ channel: 'ticket' })
  server.push({ channel: 'ticket' })
  const controller = new AbortController()
  t.after(() => controller.abort())
  const events = []
  await new Promise((resolve) => {
    void client.streamEvents({
      signal: controller.signal,
      onOpen: resolve,
      onEvent: (event) => events.push(event),
    })
  })
  await delay(80)
  assert.equal(events.length, 0)
  server.push({ channel: 'ticket' })
  await waitFor(() => events.length === 1, { label: 'live event only' })
  assert.equal(events[0].id, 3)
})

test('silence beyond the heartbeat budget ends the stream as timeout', async (t) => {
  const { server, client } = await setup(t)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const started = Date.now()
  const result = await client.streamEvents({
    signal: controller.signal,
    heartbeatTimeoutMs: 150,
    onEvent: () => {},
  })
  assert.equal(result.reason, 'timeout')
  assert.ok(Date.now() - started < 2000)
  void server
})

test('an invalid cursor is classified so the adapter can drop it', async (t) => {
  const { server, client } = await setup(t)
  server.setInvalidCursor(true)
  const controller = new AbortController()
  t.after(() => controller.abort())
  await assert.rejects(
    () => client.streamEvents({ lastEventId: 9, signal: controller.signal, onEvent: () => {} }),
    (error) => error.code === CLIENT_ERROR.INVALID_CURSOR,
  )
})

test('a non-SSE response is rejected as a protocol failure', async (t) => {
  const { client } = await setup(t, {})
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  globalThis.fetch = async () =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  const controller = new AbortController()
  await assert.rejects(
    () =>
      new InboxClient({
        apiUrl: 'http://127.0.0.1:1',
        inboxId: 'smoke',
        token: 'x',
      }).streamEvents({ signal: controller.signal, onEvent: () => {} }),
    (error) => error.code === CLIENT_ERROR.PROTOCOL,
  )
  void client
})

test('normalizeStatus rejects malformed counters', () => {
  assert.throws(() => normalizeStatus({ revision: -1, available: 0 }))
  assert.throws(() => normalizeStatus({ revision: 1, available: 'many' }))
  assert.throws(() => normalizeStatus(null))
  const ok = normalizeStatus({ inbox: 'main', revision: 0, available: 0, claimed: 0 })
  assert.deepEqual(ok.channels, {})
})
