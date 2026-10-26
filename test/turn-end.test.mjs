import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createFakeHost,
  createTestAdapter,
  delay,
  waitFor,
} from './helpers/fake-host.mjs'
import { startFakeInbox } from './helpers/fake-server.mjs'

/**
 * Start an adapter with a long no-progress backoff.
 * @param {import('node:test').TestContext} t - test context.
 * @returns {Promise<Record<string, any>>} handles.
 */
async function setup(t) {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const host = createFakeHost()
  const agent = host.createAgent('session-test')
  const created = await createTestAdapter({
    server,
    host,
    overrides: { wakeBackoffBaseMs: 5000, wakeBackoffMaxMs: 5000 },
  })
  t.after(() => created.adapter.stop())
  await created.adapter.start()
  await waitFor(() => server.connectionCount === 1, { label: 'SSE connection' })
  return { server, host, agent, ...created }
}

test('a new revision during a turn is woken at turn end despite backoff', async (t) => {
  const { server, host, agent, adapter } = await setup(t)
  const first = server.push({ channel: 'ticket', summary: '旧摘要' })
  await waitFor(() => host.followups.length === 1, { label: 'first wake' })
  host.endTurn(agent)
  await delay(250)
  assert.ok(
    adapter.snapshot().wake.nextWakeAllowedAt > Date.now(),
    'no-progress backoff is active',
  )

  // A new revision arrives while the Agent is running; the adapter must only
  // mark it dirty, not read items or inject during the turn.
  agent.status = 'running'
  host.emit('agent/status', { agent, status: 'running' })
  server.updateSummary(first.itemId, '新摘要')
  await delay(120)
  assert.equal(host.followups.length, 1, 'no injection during the running turn')
  assert.equal(adapter.snapshot().dirty, true, 'the new revision is marked dirty')

  host.endTurn(agent)
  await waitFor(() => host.followups.length === 2, {
    label: 'turn-end catch-up wake',
    timeoutMs: 1000,
  })
  assert.match(host.followups[1].message.content[0].text, /"summary":"新摘要"/)
  assert.equal(host.followups[1].message.content[0].text.includes('旧摘要'), false)
})
