import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFakeHost,
  createTestAdapter,
  delay,
  waitFor,
} from './helpers/fake-host.mjs'
import { startFakeInbox } from './helpers/fake-server.mjs'

/**
 * The text of one delivered wake.
 * @param {Record<string, any>} record - fake-host followup record.
 * @returns {string} message text.
 */
function text(record) {
  return record.message.content[0].text
}

/**
 * Start an adapter with a short repeat cadence and a long no-progress backoff,
 * so the repeat loop is observable in a fast test.
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
    overrides: { reackIntervalMs: 1000, wakeBackoffBaseMs: 60000, wakeBackoffMaxMs: 60000 },
  })
  t.after(() => created.adapter.stop())
  await created.adapter.start()
  await waitFor(() => server.connectionCount === 1, { label: 'SSE connection' })
  return { server, host, agent, ...created }
}

test('an un-acked wake repeats on a fixed cadence until the backlog is acked', async (t) => {
  const { server, host, agent, adapter } = await setup(t)
  server.push({ channel: 'ticket', summary: '未读消息' })
  await waitFor(() => host.followups.length === 1, { label: 'first wake' })
  const first = host.followups[0]
  assert.equal(/重复提醒/.test(text(first)), false, '首唤不带重复提醒')

  // 回合结束但没有 ack：条目仍是 available，必须继续提醒。
  host.endTurn(agent)
  await waitFor(() => host.followups.length === 2, {
    label: 'first repeat wake',
    timeoutMs: 3000,
  })
  const second = host.followups[1]
  assert.notEqual(second.message.id, first.message.id, '重复注入使用独立的消息 id')
  assert.match(text(second), /重复提醒 #1/)
  assert.match(text(second), new RegExp(`revision=${server.revision}`))
  assert.equal(adapter.snapshot().lastWokenRevision, server.revision, '同一 revision 被重复注入')

  host.endTurn(agent)
  await waitFor(() => host.followups.length === 3, {
    label: 'second repeat wake',
    timeoutMs: 3000,
  })
  assert.match(text(host.followups[2]), /重复提醒 #2/, '重复注入不设次数上限')

  const before = host.followups.length
  server.claim('ticket', 1)
  await waitFor(() => server.available === 0, { label: 'backlog drained' })
  host.endTurn(agent)
  await waitFor(() => adapter.snapshot().wake.reackAt === null, {
    label: 'repeat ledger reset',
    timeoutMs: 3000,
  })
  await delay(1600)
  assert.equal(host.followups.length, before, 'ack 之后不再重复注入')
  const snapshot = adapter.snapshot()
  assert.equal(snapshot.wake.reinjections, 0)
})

test('a new revision starts a fresh wake instead of a repeat', async (t) => {
  const { server, host, agent } = await setup(t)
  server.push({ channel: 'ticket', summary: '第一条' })
  await waitFor(() => host.followups.length === 1, { label: 'first wake' })
  host.endTurn(agent)
  await waitFor(() => host.followups.length === 2, {
    label: 'repeat wake',
    timeoutMs: 3000,
  })
  host.endTurn(agent)

  server.push({ channel: 'ticket', summary: '第二条' })
  await waitFor(() => host.followups.length === 3, {
    label: 'new revision wake',
    timeoutMs: 3000,
  })
  const latest = text(host.followups[2])
  assert.equal(/重复提醒/.test(latest), false, '新 revision 是一次首唤')
  assert.match(latest, /available=2/)
  assert.match(latest, new RegExp(`revision=${server.revision}`))
})

test('state written before the repeat ledger existed re-injects after the interval', async (t) => {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const host = createFakeHost()
  host.createAgent('session-test')
  server.push({ channel: 'ticket', summary: '升级前的积压' })
  const dir = await mkdtemp(join(tmpdir(), 'inbox-reack-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const stateFile = join(dir, 'state.json')
  const { itemId } = server.availableItems[0]
  await writeFile(
    stateFile,
    JSON.stringify({
      version: 1,
      inboxId: 'smoke',
      sessionRef: 'session-test',
      channels: ['ticket'],
      lastEventId: 1,
      lastObservedRevision: 1,
      lastWokenRevision: 1,
      enabled: true,
      lastWake: {
        key: `inbox:smoke:revision:1:session:session-test`,
        revision: 1,
        available: 1,
        messageId: 'msg_inbox_before_upgrade',
        at: new Date(Date.now() - 5000).toISOString(),
      },
      wake: { attempts: 1, stalls: 0, nextWakeAllowedAt: null },
      health: {},
    }),
  )
  const { adapter } = await createTestAdapter({
    server,
    host,
    stateFile,
    overrides: { reackIntervalMs: 1000 },
  })
  t.after(() => adapter.stop())
  await adapter.start()
  await waitFor(() => host.followups.length === 1, {
    label: 'upgrade repeat wake',
    timeoutMs: 3000,
  })
  const delivered = text(host.followups[0])
  assert.match(delivered, /重复提醒 #1/)
  assert.match(delivered, new RegExp(itemId), '重复注入带上未处理的 itemId')
})
