import test from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyTools } from '../tools.js'
import { registerInboxCommand } from '../lib/commands.js'
import { createFakeHost, createTestAdapter, waitFor } from './helpers/fake-host.mjs'
import { startFakeInbox } from './helpers/fake-server.mjs'

const SIGNAL = new AbortController().signal

/**
 * Build an adapter plus the `/inbox` command and the tool row.
 * @param {import('node:test').TestContext} t - test context.
 * @returns {Promise<Record<string, any>>} connected handles.
 */
async function setup(t) {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const host = createFakeHost()
  host.createAgent('session-test')
  const created = await createTestAdapter({ server, host })
  t.after(() => created.adapter.stop())
  await created.adapter.start()
  host.ctx.effect(() =>
    registerInboxCommand(host.ctx.commands, Promise.resolve(created.adapter), created.logger),
  )
  applyTools(host.ctx)
  return { server, host, ...created }
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

test('the tool row registers status, bind, and unbind with JSON schemas', async (t) => {
  const { host } = await setup(t)
  assert.deepEqual(
    host.tools.map((entry) => entry.name).sort(),
    ['inbox_adapter_bind', 'inbox_adapter_status', 'inbox_adapter_unbind'],
  )
  for (const definition of host.tools) {
    assert.equal(typeof definition.execute, 'function')
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.output.schema.type, 'object')
    assert.deepEqual(definition.output.render({}, { text: 'x' }), [{ type: 'text', text: 'x' }])
  }
})

test('inbox_adapter_status reports the exact binding and caller relationship', async (t) => {
  const { host, adapter } = await setup(t)
  const status = tool(host, 'inbox_adapter_status')
  const value = await status.execute({}, { agent: { id: 'session-test' }, signal: SIGNAL })
  assert.match(value.text, /InboxMosire adapter/)
  assert.match(value.text, /inbox=smoke/)
  assert.match(value.text, /session=session-test/)
  assert.match(value.text, /caller=session-test isBound=true/)
  assert.equal(adapter.state.sessionRef, 'session-test')

  const foreign = await status.execute({}, { agent: { id: 'session-other' }, signal: SIGNAL })
  assert.match(foreign.text, /caller=session-other isBound=false/)
  assert.ok(!value.text.includes('test-token'))
})

test('inbox_adapter_bind binds the calling session or an explicit session id', async (t) => {
  const { host, adapter } = await setup(t)
  const bind = tool(host, 'inbox_adapter_bind')

  const explicit = await bind.execute(
    { sessionId: 'session-other' },
    { agent: { id: 'session-test' }, signal: SIGNAL },
  )
  assert.match(explicit.text, /已绑定 session-other/)
  assert.equal(adapter.state.sessionRef, 'session-other')
  assert.match(explicit.text, /caller=session-test isBound=false/)

  host.createAgent('session-other')
  const self = await bind.execute({}, { agent: { id: 'session-other' }, signal: SIGNAL })
  assert.match(self.text, /已绑定 session-other/)
  assert.match(self.text, /caller=session-other isBound=true/)
  assert.equal(adapter.state.sessionRef, 'session-other')

  const empty = await bind.execute({ sessionId: '   ' }, { agent: { id: 'session-other' }, signal: SIGNAL })
  assert.match(empty.text, /已绑定 session-other/, 'blank id falls back to the caller')
})

test('inbox_adapter_unbind removes the binding and keeps the cursor', async (t) => {
  const { host, server, adapter } = await setup(t)
  await waitFor(() => server.connectionCount === 1, { label: 'SSE connection' })
  server.push({ channel: 'ticket' })
  await waitFor(() => adapter.state.lastEventId !== null, { label: 'cursor' })
  const cursor = adapter.state.lastEventId
  const unbind = tool(host, 'inbox_adapter_unbind')
  const value = await unbind.execute({}, { agent: { id: 'session-test' }, signal: SIGNAL })
  assert.match(value.text, /已解绑 session-test/)
  assert.equal(adapter.state.sessionRef, '')
  assert.equal(adapter.state.lastEventId, cursor)
})

test('a tool call without a calling session fails loudly', async (t) => {
  const { host } = await setup(t)
  const status = tool(host, 'inbox_adapter_status')
  await assert.rejects(
    () => status.execute({}, { signal: SIGNAL }),
    /no calling session/,
  )
})

test('tools fail closed when the adapter command is not registered', async (t) => {
  const host = createFakeHost()
  applyTools(host.ctx)
  const status = tool(host, 'inbox_adapter_status')
  await assert.rejects(
    () => status.execute({}, { agent: { id: 'session-test' }, signal: SIGNAL }),
    /adapter is not loaded/,
  )
})

test('unloading the tool row unregisters every tool', async (t) => {
  const { host } = await setup(t)
  assert.equal(host.tools.length, 3)
  await host.disposeAll()
  assert.equal(host.tools.length, 0)
  assert.equal(host.commands.length, 0)
})
