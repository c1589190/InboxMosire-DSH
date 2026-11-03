import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeHost, createTestAdapter, delay, waitFor } from './helpers/fake-host.mjs'
import { startFakeInbox } from './helpers/fake-server.mjs'
import { CLIENT_ERROR, InboxClientError } from '../lib/inbox-client.js'

/**
 * Build an adapter whose first `getStatus()` calls fail, then delegate to the
 * real client. The fake inbox has no way to fail `/status` with an error.
 * @param {import('node:test').TestContext} t - test context.
 * @param {Error} error - thrown for the first `failures` calls.
 * @param {number} failures - how many calls fail.
 * @returns {Promise<Record<string, any>>} handles + call counter accessor.
 */
async function setup(t, error, failures) {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const host = createFakeHost()
  const agent = host.createAgent('session-test')
  const created = await createTestAdapter({ server, host })
  t.after(() => created.adapter.stop())
  const real = created.adapter.client.getStatus.bind(created.adapter.client)
  const calls = { count: 0 }
  created.adapter.client.getStatus = async () => {
    calls.count += 1
    if (calls.count <= failures) throw error
    return real()
  }
  return { server, host, agent, calls, ...created }
}

test('a transient status failure at startup reconnects without a manual retry', async (t) => {
  const { server, host, calls, adapter } = await setup(
    t,
    new InboxClientError(CLIENT_ERROR.NETWORK, 'daemon not up yet', { retryable: true }),
    2,
  )
  // The backlog exists before the adapter ever reaches the inbox: without a
  // retry this wake would never arrive and nothing would ask for it again.
  server.push({ channel: 'ticket', summary: '未读消息' })
  await adapter.start()
  assert.equal(server.connectionCount, 0, '启动时 status 失败，SSE 尚未建立')
  assert.equal(adapter.configError, null, '网络错误不是配置错误')

  await waitFor(() => server.connectionCount === 1, {
    label: 'SSE connection after startup retry',
    timeoutMs: 3000,
  })
  await waitFor(() => host.followups.length === 1, { label: 'wake after startup retry' })
  assert.ok(calls.count >= 3, `expected at least 3 status reads, got ${calls.count}`)
  assert.ok(adapter.state.health.reconnects >= 2, '重连计数应当累积')
  assert.match(host.followups[0].message.content[0].text, /revision=/)
})

test('a fatal startup failure stops instead of retrying forever', async (t) => {
  const { server, calls, adapter } = await setup(
    t,
    new InboxClientError(CLIENT_ERROR.AUTH, 'token rejected', { status: 401 }),
    99,
  )
  await adapter.start()
  assert.equal(adapter.configError?.code, 'AUTH_FAILED', '401 必须停在配置错误上')
  await delay(300)
  assert.equal(calls.count, 1, '致命错误不重试')
  assert.equal(server.connectionCount, 0, '不应建立 SSE')
  assert.equal(adapter.startupTimer, null, '不应留下重试定时器')
})

test('stopping cancels a pending startup retry', async (t) => {
  const { calls, adapter } = await setup(
    t,
    new InboxClientError(CLIENT_ERROR.NETWORK, 'daemon not up yet', { retryable: true }),
    99,
  )
  await adapter.start()
  assert.notEqual(adapter.startupTimer, null, '非致命失败应排了重试')
  await adapter.stop()
  assert.equal(adapter.startupTimer, null, 'stop() 必须清掉重试定时器')
  const seen = calls.count
  await delay(300)
  assert.equal(calls.count, seen, '停止后不再发起请求')
})
