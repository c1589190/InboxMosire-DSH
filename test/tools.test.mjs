import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyTools } from '../tools.js'
import { setManager, setManagerFailure } from '../lib/runtime.js'
import {
  createFakeHost,
  createTestManager,
  waitFor,
  writeBindingDescriptor,
} from './helpers/fake-host.mjs'
import { startFakeInbox } from './helpers/fake-server.mjs'

const SIGNAL = new AbortController().signal

/**
 * Build a manager, two fake inboxes, and the tool row.
 * @param {import('node:test').TestContext} t - test context.
 * @returns {Promise<Record<string, any>>} handles.
 */
async function setup(t) {
  const serverA = await startFakeInbox({ inbox: 'app-a' })
  const serverB = await startFakeInbox({ inbox: 'app-b' })
  t.after(() => Promise.all([serverA.close(), serverB.close()]))
  const host = createFakeHost()
  host.createAgent('session-test')
  host.createAgent('session-other')
  const created = await createTestManager({ host })
  t.after(() => created.manager.stop())
  await created.manager.start()
  setManager(created.manager)
  applyTools(host.ctx)
  const dir = await mkdtemp(join(tmpdir(), 'inbox-tools-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const descA = await writeBindingDescriptor(dir, serverA, { label: 'A' })
  const descB = await writeBindingDescriptor(dir, serverB, { label: 'B' })
  return { ...created, host, serverA, serverB, descA, descB, dir }
}

/**
 * Find one registered tool.
 * @param {Record<string, any>} host - fake host.
 * @param {string} name - tool name.
 * @returns {Record<string, any>} definition.
 */
function tool(host, name) {
  const definition = host.tools.find((entry) => entry.name === name)
  assert.ok(definition, `tool ${name} is registered`)
  return definition
}

test('the tool row registers v2 status, bind, unbind, and the per-session log', async (t) => {
  const { host } = await setup(t)
  assert.deepEqual(
    host.tools.map((entry) => entry.name).sort(),
    ['inbox_adapter_bind', 'inbox_adapter_log', 'inbox_adapter_status', 'inbox_adapter_unbind'],
  )
  for (const definition of host.tools) {
    assert.equal(typeof definition.execute, 'function')
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.output.schema.type, 'object')
    assert.deepEqual(definition.output.render({}, { text: 'x' }), [{ type: 'text', text: 'x' }])
  }
  const bind = tool(host, 'inbox_adapter_bind')
  assert.ok(bind.parameters.properties.inboxId)
  assert.ok(bind.parameters.properties.adapterTokenRef)
  assert.ok(bind.parameters.properties.descriptor)
  assert.deepEqual(bind.parameters.properties.wakeMode.enum, ['claim', 'view-ack'])
})

test('inbox_adapter_bind accepts explicit fields and reports per-caller status', async (t) => {
  const { host, serverA, descA } = await setup(t)
  const bind = tool(host, 'inbox_adapter_bind')
  const result = await bind.execute(
    {
      inboxId: 'app-a',
      adapterTokenRef: descA.adapterTokenRef,
      apiBaseUrl: serverA.url,
      channels: ['ticket'],
      label: 'S-test',
      wakeMode: 'view-ack',
    },
    { agent: { id: 'session-test' }, signal: SIGNAL },
  )
  assert.match(result.text, /已绑定 session-test → app-a/)
  assert.match(result.text, /isBound=true inbox=app-a/)
  assert.match(result.text, /channels=\[ticket\]/)
  assert.match(result.text, /wakeMode=view-ack/)
  await waitFor(() => serverA.connectionCount === 1, { label: 'SSE' })

  const status = tool(host, 'inbox_adapter_status')
  const self = await status.execute({}, { agent: { id: 'session-test' }, signal: SIGNAL })
  assert.match(self.text, /programMcp: state=available/)
  host.businessTools = false
  const refreshed = await status.execute({}, { agent: { id: 'session-test' }, signal: SIGNAL })
  assert.match(refreshed.text, /programMcp: state=missing/)
  host.businessTools = true

  const other = await status.execute({}, { agent: { id: 'session-other' }, signal: SIGNAL })
  assert.match(other.text, /isBound=false/)
  assert.match(other.text, /session-test → app-a/)
  assert.ok(!other.text.includes('test-token'))
})

test('inbox_adapter_bind rejects an unknown wakeMode', async (t) => {
  const { host, serverA, descA } = await setup(t)
  const bind = tool(host, 'inbox_adapter_bind')
  const result = await bind.execute(
    {
      inboxId: 'app-a',
      adapterTokenRef: descA.adapterTokenRef,
      apiBaseUrl: serverA.url,
      wakeMode: 'make-believe',
    },
    { agent: { id: 'session-test' }, signal: SIGNAL },
  )
  assert.match(result.text, /WAKE_MODE_INVALID/)
  assert.equal(serverA.connectionCount, 0)
})

test('the descriptor object binds a different session without touching the caller', async (t) => {
  const { host, serverA, serverB, descA, descB } = await setup(t)
  const bind = tool(host, 'inbox_adapter_bind')
  await bind.execute(
    { inboxId: 'app-a', adapterTokenRef: descA.adapterTokenRef, apiBaseUrl: serverA.url },
    { agent: { id: 'session-test' }, signal: SIGNAL },
  )
  const second = await bind.execute(
    { sessionId: 'session-other', descriptor: descB },
    { agent: { id: 'session-test' }, signal: SIGNAL },
  )
  assert.match(second.text, /已绑定 session-other → app-b/)
  assert.match(second.text, /isBound=true inbox=app-b/)
  assert.match(second.text, /session=session-other/)
  await waitFor(
    () => serverA.connectionCount === 1 && serverB.connectionCount === 1,
    { label: 'both SSE' },
  )

  const unbind = tool(host, 'inbox_adapter_unbind')
  const removed = await unbind.execute({}, { agent: { id: 'session-test' }, signal: SIGNAL })
  assert.match(removed.text, /已解绑 session-test/)
  await waitFor(() => serverA.connectionCount === 0, { label: 'A closed' })
  assert.equal(serverB.connectionCount, 1, 'the other binding is untouched')
})

test('an unusable descriptor returns an error text and keeps the caller unbound', async (t) => {
  const { host, manager } = await setup(t)
  const bind = tool(host, 'inbox_adapter_bind')
  const relative = await bind.execute(
    { inboxId: 'app-a', adapterTokenRef: 'relative.token' },
    { agent: { id: 'session-test' }, signal: SIGNAL },
  )
  assert.match(relative.text, /TOKEN_REF_NOT_ABSOLUTE/)
  const invalid = await bind.execute(
    { inboxId: 'bad inbox', adapterTokenRef: 'file:/tmp/x.token' },
    { agent: { id: 'session-test' }, signal: SIGNAL },
  )
  assert.match(invalid.text, /INVALID_INBOX/)
  assert.equal(manager.bindingFor('session-test'), undefined)
})

test('tools fail loudly when the engine row is not ready', async (t) => {
  const host = createFakeHost()
  applyTools(host.ctx)
  setManagerFailure('engine row missing')
  const status = tool(host, 'inbox_adapter_status')
  await assert.rejects(
    () => status.execute({}, { agent: { id: 'session-test' }, signal: SIGNAL }),
    /engine row missing/,
  )
})

test('inbox_adapter_log returns only the caller session and never a token', async (t) => {
  const { host, serverA, serverB, descA, descB } = await setup(t)
  const bind = tool(host, 'inbox_adapter_bind')
  await bind.execute(
    { sessionId: 'session-test', descriptor: descA },
    { agent: { id: 'session-test' }, signal: SIGNAL },
  )
  await bind.execute(
    { sessionId: 'session-other', descriptor: descB },
    { agent: { id: 'session-other' }, signal: SIGNAL },
  )
  await waitFor(
    () => serverA.connectionCount === 1 && serverB.connectionCount === 1,
    { label: 'both SSE' },
  )

  const log = tool(host, 'inbox_adapter_log')
  const mine = await log.execute({ limit: 10 }, { agent: { id: 'session-test' }, signal: SIGNAL })
  assert.match(mine.text, /本会话，最新在前/)
  assert.match(mine.text, /bind by=agent inbox=app-a/)
  assert.match(mine.text, /at=127\.0\.0\.1:\d+/)
  assert.ok(!mine.text.includes('app-b'), 'the other session stays invisible')
  assert.ok(!mine.text.includes('test-token'))
  assert.ok(!mine.text.includes(descA.adapterTokenRef))
  assert.ok(!mine.text.includes(serverA.token))

  const other = await log.execute({}, { agent: { id: 'session-other' }, signal: SIGNAL })
  assert.ok(!other.text.includes('app-a'))

  const stranger = await log.execute({}, { agent: { id: 'session-stranger' }, signal: SIGNAL })
  assert.equal(stranger.text, '本会话没有 inbox 操作记录。')

  const unbind = tool(host, 'inbox_adapter_unbind')
  await unbind.execute({ sessionId: 'session-test' }, { agent: { id: 'session-test' }, signal: SIGNAL })
  const after = await log.execute({ limit: 1 }, { agent: { id: 'session-test' }, signal: SIGNAL })
  assert.match(after.text, /unbind by=agent/)
})
