/**
 * Real-backend acceptance: the adapter against the live InboxMosire daemon on
 * the `smoke` inbox, with a fake DSH host and a real MCP client standing in for
 * the Agent's claim/complete loop.
 *
 * Skipped when the daemon or its local secret files are absent. The scenarios
 * drain everything they create so the smoke board is left clean.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { renderWakeTemplate } from '../lib/template.js'
import { createFakeHost, createTestAdapter, delay, waitFor } from './helpers/fake-host.mjs'
import { McpClient } from './helpers/mcp.mjs'

const BACKEND = process.env.INBOX_API_URL ?? 'http://127.0.0.1:18765'
const MCP_URL = process.env.INBOX_MCP_URL ?? 'http://127.0.0.1:18766/mcp'
const INBOX = process.env.INBOX_SMOKE_INBOX_ID ?? 'smoke'
const ADAPTER_TOKEN_FILE =
  process.env.INBOX_SMOKE_ADAPTER_TOKEN_FILE ??
  '/home/cna/InboxMosire/.work/live/secrets/dsh-smoke-adapter.token'
const PRODUCER_TOKEN_FILE =
  process.env.INBOX_SMOKE_PRODUCER_TOKEN_FILE ??
  '/home/cna/InboxMosire/.work/live/secrets/smoke-producer.token'

/**
 * Probe the daemon.
 * @returns {Promise<boolean>} whether it answered `healthz`.
 */
async function probe() {
  try {
    const response = await fetch(`${BACKEND}/healthz`, {
      signal: AbortSignal.timeout(1500),
    })
    return response.ok
  } catch {
    return false
  }
}

const adb = existsSync(ADAPTER_TOKEN_FILE)
const prod = existsSync(PRODUCER_TOKEN_FILE)
const alive = adb && prod ? await probe() : false
const SKIP = alive ? false : `InboxMosire smoke backend unavailable (${BACKEND})`
const adapterToken = alive ? (await readFile(ADAPTER_TOKEN_FILE, 'utf8')).trim() : ''
const producerToken = alive ? (await readFile(PRODUCER_TOKEN_FILE, 'utf8')).trim() : ''

/**
 * Push one notification through the producer endpoint.
 * @param {object} input - push fields.
 * @returns {Promise<Record<string, any>>} push response.
 */
async function push({ channel = 'ticket', title, payload, dedupeKey }) {
  const response = await fetch(`${BACKEND}/v1/inboxes/${INBOX}/items`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${producerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel,
      kind: 'acceptance',
      title,
      payload,
      dedupeKey: dedupeKey ?? `acceptance:${Date.now()}:${Math.random()}`,
    }),
  })
  assert.ok(response.status === 201 || response.status === 200, `push HTTP ${response.status}`)
  return response.json()
}

/**
 * Read the live board status with the adapter token.
 * @returns {Promise<Record<string, any>>} status document.
 */
async function boardStatus() {
  const response = await fetch(`${BACKEND}/v1/inboxes/${INBOX}/status`, {
    headers: { Authorization: `Bearer ${adapterToken}` },
  })
  assert.equal(response.status, 200)
  return response.json()
}

/**
 * Wait until the adapter's SSE stream is established.
 * @param {Record<string, any>} adapter - adapter under test.
 * @returns {Promise<void>} after the connection is reported.
 */
function waitConnected(adapter) {
  return waitFor(() => adapter.snapshot().health.sse === 'connected', {
    timeoutMs: 5000,
    label: 'real SSE connection',
  })
}

test('real backend: empty board, one wake, claim/complete loop, dedupe, restart', { skip: SKIP }, async (t) => {
  const mcp = new McpClient(MCP_URL)
  await mcp.init()
  t.after(() => mcp.close())
  await mcp.drain(INBOX)
  assert.equal((await boardStatus()).available, 0, 'smoke board starts clean')

  const host = createFakeHost()
  const agent = host.createAgent('session-test')
  const first = await createTestAdapter({
    host,
    connection: { apiUrl: BACKEND, inboxId: INBOX, channels: ['ticket'], token: adapterToken },
    overrides: { debounceMs: 50, requestTimeoutMs: 5000, reconnectBaseMs: 200 },
  })
  t.after(() => first.adapter.stop())

  // 1. Empty board: no wake.
  await first.adapter.start()
  await waitConnected(first.adapter)
  await delay(400)
  assert.equal(host.followups.length, 0, 'empty board stays silent')

  // 2. One push on an idle session: exactly one fixed-template wake.
  const secretTitle = `SECRET-TITLE-${Date.now()}`
  const secretBody = `SECRET-BODY-${Date.now()}`
  const pushed = await push({ title: secretTitle, payload: { body: secretBody } })
  await waitFor(() => host.followups.length === 1, { label: 'real wake', timeoutMs: 6000 })
  const expected = renderWakeTemplate({
    inboxId: INBOX,
    revision: pushed.revision,
    available: 1,
    channels: ['ticket'],
  })
  assert.equal(host.followups[0].message.content[0].text, expected)
  assert.ok(!expected.includes(secretTitle) && !expected.includes(secretBody))

  // 3. Agent claims and completes, then ends the turn; the board is empty.
  const claimed = await mcp.claimAll(INBOX)
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].payload.body, secretBody, 'payload exists only in the claim result')
  await mcp.completeAll(INBOX, claimed)
  const afterComplete = await boardStatus()
  assert.equal(afterComplete.available, 0)
  host.endTurn(agent)
  await delay(500)
  assert.equal(host.followups.length, 1, 'no wake once the board is empty')

  // 4. Same revision is not woken twice.
  const second = await push({ title: 'dedupe', payload: { n: 2 } })
  await waitFor(() => host.followups.length === 2, { label: 'second wake', timeoutMs: 6000 })
  host.endTurn(agent)
  await delay(600)
  assert.equal(host.followups.length, 2, 'unchanged board and revision stay silent')
  assert.ok(second.revision > pushed.revision)

  // 5. Restart: cursor and watermark survive; a notification pushed while the
  // adapter is down is delivered once after reconnecting with Last-Event-ID.
  await first.adapter.whenSettled()
  const cursorBefore = first.adapter.snapshot().cursor
  const watermarkBefore = first.adapter.snapshot().lastWokenRevision
  assert.equal(watermarkBefore, second.revision)
  await first.adapter.stop()
  const offlinePush = await push({ title: 'offline', payload: { n: 3 } })

  const restartedHost = createFakeHost()
  const restartedAgent = restartedHost.createAgent('session-test')
  const second2 = await createTestAdapter({
    host: restartedHost,
    connection: { apiUrl: BACKEND, inboxId: INBOX, channels: ['ticket'], token: adapterToken },
    overrides: { debounceMs: 50, requestTimeoutMs: 5000, reconnectBaseMs: 200 },
    stateFile: first.stateFile,
  })
  t.after(() => second2.adapter.stop())
  await second2.adapter.start()
  await waitConnected(second2.adapter)
  assert.equal(second2.adapter.snapshot().cursor, cursorBefore, 'cursor restored from disk')
  await waitFor(() => restartedHost.followups.length === 1, {
    label: 'wake after restart',
    timeoutMs: 6000,
  })
  assert.match(
    restartedHost.followups[0].message.content[0].text,
    new RegExp(`revision=${offlinePush.revision}`),
  )
  await delay(400)
  assert.equal(restartedHost.followups.length, 1, 'one wake only')

  // 6. Claim two of three available items and complete one: the unclaimed
  // notification keeps the loop alive after turn end.
  await push({ title: 'second-a', payload: { n: 4 } })
  await push({ title: 'second-b', payload: { n: 5 } })
  const before = await boardStatus()
  assert.ok(before.available >= 3, `expected 3 available, got ${before.available}`)
  const partial = await mcp.claimSome(INBOX, 2)
  assert.equal(partial.length, 2)
  await mcp.completeAll(INBOX, partial.slice(0, 1))
  assert.equal((await boardStatus()).available, before.available - 2)
  restartedAgent.status = 'running'
  restartedHost.emit('agent/status', { agent: restartedAgent, status: 'running' })
  restartedHost.endTurn(restartedAgent)
  await waitFor(() => restartedHost.followups.length === 2, {
    label: 'remaining work wake',
    timeoutMs: 6000,
  })
  assert.match(
    restartedHost.followups[1].message.content[0].text,
    new RegExp(`available=${before.available - 2}`),
  )
  const rest = await mcp.claimAll(INBOX)
  await mcp.completeAll(INBOX, rest)
  assert.equal((await boardStatus()).available, 0)

  // 7. Privacy: no title, payload, or token in wake text, state, or log.
  await second2.adapter.whenSettled()
  await delay(200)
  const wakeText = restartedHost.followups.map((entry) => entry.message.content[0].text).join('\n')
  const stateText = await readFile(second2.adapter.config.stateFile, 'utf8')
  const logText = await readFile(second2.adapter.config.logFile, 'utf8').catch(() => '')
  for (const haystack of [wakeText, stateText, logText]) {
    assert.ok(!haystack.includes('SECRET-TITLE'))
    assert.ok(!haystack.includes('SECRET-BODY'))
    assert.ok(!haystack.includes(adapterToken))
    assert.ok(!haystack.includes(producerToken))
  }
})

test('real backend: a bad token is a fail-closed configuration error', { skip: SKIP }, async () => {
  const host = createFakeHost()
  host.createAgent('session-test')
  const created = await createTestAdapter({
    host,
    connection: { apiUrl: BACKEND, inboxId: INBOX, channels: ['ticket'], token: 'not-a-token' },
    overrides: { debounceMs: 20, requestTimeoutMs: 3000 },
  })
  try {
    await created.adapter.start()
    assert.equal(created.adapter.configError?.code, 'AUTH_FAILED')
    await delay(300)
    assert.equal(host.followups.length, 0)
    assert.match(created.adapter.statusText(), /CONFIG ERROR: AUTH_FAILED/)
  } finally {
    await created.adapter.stop()
  }
})
