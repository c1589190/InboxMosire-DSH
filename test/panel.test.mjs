import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPanelHandler, PANEL_CHANNEL, registerPanelRpc } from '../lib/panel.js'
import {
  createFakeHost,
  createTestManager,
  waitFor,
  writeBindingDescriptor,
} from './helpers/fake-host.mjs'
import { startFakeInbox } from './helpers/fake-server.mjs'

const SIGNAL = new AbortController().signal

test('manager panel status exposes counts only for a bound session', async (t) => {
  const server = await startFakeInbox({ inbox: 'app-a' })
  t.after(() => server.close())
  const host = createFakeHost()
  host.createAgent('session-a')
  const dir = await mkdtemp(join(tmpdir(), 'inbox-panel-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const created = await createTestManager({ host })
  t.after(() => created.manager.stop())
  await created.manager.start()
  const bound = await created.manager.bind({
    sessionId: 'session-a',
    descriptor: await writeBindingDescriptor(dir, server),
  })
  assert.equal(bound.ok, true, bound.message)
  await waitFor(() => server.connectionCount === 1, { label: 'panel SSE connection' })
  const pushed = server.push({ channel: 'ticket', summary: 'PANEL-SECRET-SUMMARY' })
  await waitFor(() => created.manager.panelStatus('session-a').available === 1, {
    label: 'panel count',
  })
  const panel = created.manager.panelStatus('session-a')
  assert.equal(panel.bound, true)
  assert.equal(panel.inboxId, 'app-a')
  assert.equal(panel.available, 1)
  assert.equal(panel.claimed, 0)
  assert.equal(panel.revision, pushed.revision)
  assert.equal(panel.sse, 'connected')
  assert.equal(panel.programMcp, 'available')
  assert.ok(!JSON.stringify(panel).includes('PANEL-SECRET-SUMMARY'))
  assert.ok(!JSON.stringify(panel).includes('test-token'))
  created.manager.bindingFor('session-a').health.programMcp = {
    state: 'missing',
    at: new Date().toISOString(),
  }
  created.manager.config.programMcpConnectorKey = 'custom-iibot'
  assert.equal(created.manager.panelStatus('session-a').programMcp, 'missing')
  assert.equal(
    created.manager.panelStatus('session-a').programMcpConnectorKey,
    'custom-iibot',
  )
  assert.match(created.manager.statusText('session-a'), /programMcp: state=missing/)
  const absent = created.manager.panelStatus('session-absent')
  assert.deepEqual(
    { bound: absent.bound, sessionRef: absent.sessionRef },
    { bound: false, sessionRef: 'session-absent' },
  )
})

test('the panel RPC channel validates endpoints and never throws', async () => {
  let captured
  const connection = {
    rpc: {
      handle(channel, handler) {
        captured = { channel, handler }
        return async () => {}
      },
    },
  }
  const manager = {
    panelStatus(sessionId) {
      return { bound: true, sessionRef: sessionId, available: 2 }
    },
    async refreshPanelStatus(sessionId) {
      return { bound: true, sessionRef: sessionId, available: 3, refreshed: true }
    },
  }
  registerPanelRpc(connection, Promise.resolve(manager))
  assert.equal(captured.channel, PANEL_CHANNEL)
  assert.equal(PANEL_CHANNEL, '/inbox-mosire')

  const ok = await captured.handler('status', { sessionId: 'session-a' }, SIGNAL, {})
  assert.deepEqual(ok, { ok: true, value: { bound: true, sessionRef: 'session-a', available: 2 } })

  const refreshed = await captured.handler(
    'status',
    { sessionId: 'session-a', refresh: true },
    SIGNAL,
    {},
  )
  assert.deepEqual(refreshed, {
    ok: true,
    value: { bound: true, sessionRef: 'session-a', available: 3, refreshed: true },
  })

  const blank = await captured.handler('status', { sessionId: '  ' }, SIGNAL, {})
  assert.equal(blank.ok, false)
  assert.equal(blank.error.code, 'INVALID_ARGUMENT')

  const unknown = await captured.handler('items', {}, SIGNAL, {})
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'NOT_FOUND')

  const unavailable = createPanelHandler(Promise.resolve(null))
  const missing = await unavailable('status', { sessionId: 'session-a' }, SIGNAL, {})
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'ENGINE_UNAVAILABLE')

  const rejected = createPanelHandler(Promise.reject(new Error('startup failed')))
  const failed = await rejected('status', { sessionId: 'session-a' }, SIGNAL, {})
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'ENGINE_UNAVAILABLE')
  assert.match(failed.error.message, /startup failed/)
})

test('the panel RPC handler contains a manager failure', async () => {
  const handler = createPanelHandler(
    Promise.resolve({
      panelStatus() {
        throw new Error('boom')
      },
    }),
  )
  const result = await handler('status', { sessionId: 'session-a' }, SIGNAL, {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'PANEL_STATUS_FAILED')
  assert.match(result.error.message, /boom/)
})
