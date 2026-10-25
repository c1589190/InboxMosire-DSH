/**
 * Real-backend v2 acceptance: one DSH host, two sessions, two inboxes.
 *
 * Uses the live daemon and the Mode A artifacts produced by the backend:
 * `bindings/app-a.json`, `bindings/app-b.json`, the 0600 wake tokens they
 * reference, and the program MCP tokens (used here through the program's HTTP
 * action surface — the same calls `InboxClientMcpTools` makes).
 *
 * Skipped when the daemon, descriptors, or secrets are absent. Every item the
 * run creates is completed and both occupancy marks are cleared.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createFakeHost, createTestManager, waitFor } from './helpers/fake-host.mjs'

const API = process.env.INBOX_API_URL ?? 'http://127.0.0.1:18765'
const LIVE = '/home/cna/InboxMosire/.work/live'
const DESCRIPTOR_A = process.env.INBOX_APP_A_BINDING ?? `${LIVE}/bindings/app-a.json`
const DESCRIPTOR_B = process.env.INBOX_APP_B_BINDING ?? `${LIVE}/bindings/app-b.json`
const PROGRAM_A = process.env.INBOX_APP_A_PROGRAM_MCP_TOKEN_FILE ?? `${LIVE}/secrets/program-a-mcp.token`
const PROGRAM_B = process.env.INBOX_APP_B_PROGRAM_MCP_TOKEN_FILE ?? `${LIVE}/secrets/program-b-mcp.token`

/**
 * Probe the daemon.
 * @returns {Promise<boolean>} whether `healthz` answered.
 */
async function probe() {
  try {
    const response = await fetch(`${API}/healthz`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

const ready =
  existsSync(DESCRIPTOR_A) && existsSync(DESCRIPTOR_B) && existsSync(PROGRAM_A) && existsSync(PROGRAM_B)
    ? await probe()
    : false
const SKIP = ready ? false : `live InboxMosire/v2 artifacts unavailable (${API})`

const programA = ready ? (await readFile(PROGRAM_A, 'utf8')).trim() : ''
const programB = ready ? (await readFile(PROGRAM_B, 'utf8')).trim() : ''
const descriptorA = ready ? JSON.parse(await readFile(DESCRIPTOR_A, 'utf8')) : {}
const descriptorB = ready ? JSON.parse(await readFile(DESCRIPTOR_B, 'utf8')) : {}
const wakeA = ready ? (await readFile(descriptorA.adapterTokenRef.replace(/^file:/, ''), 'utf8')).trim() : ''
const wakeB = ready ? (await readFile(descriptorB.adapterTokenRef.replace(/^file:/, ''), 'utf8')).trim() : ''

/**
 * Call one InboxMosire HTTP endpoint.
 * @param {string} path - path after the API base.
 * @param {object} options - request options.
 * @param {string} options.token - bearer token.
 * @param {string} [options.method] - HTTP method.
 * @param {Record<string, unknown>} [options.body] - JSON body.
 * @returns {Promise<{status: number, json: any}>} response.
 */
async function call(path, { token, method = 'GET', body }) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : null }
}

/**
 * Claim and complete every available item on one inbox.
 * @param {string} inbox - inbox id.
 * @param {string} token - program token.
 * @returns {Promise<number>} completed item count.
 */
async function drain(inbox, token) {
  const list = await call(`/v1/inboxes/${inbox}/items`, { token })
  assert.equal(list.status, 200, `list ${inbox}`)
  const ids = (list.json.items ?? []).map((item) => item.itemId)
  if (ids.length === 0) return 0
  const claimed = await call(`/v1/inboxes/${inbox}/claims`, {
    token,
    method: 'POST',
    body: { itemIds: ids },
  })
  assert.equal(claimed.status, 200, `claim ${inbox}`)
  const completions = (claimed.json.claimed ?? []).map((item) => ({
    claimToken: item.claimToken,
    outcome: 'completed',
    summary: 'v2 acceptance harness',
  }))
  if (completions.length === 0) return 0
  const completed = await call(`/v1/inboxes/${inbox}/claims/complete`, {
    token,
    method: 'POST',
    body: { completions },
  })
  assert.equal(completed.status, 200, `complete ${inbox}`)
  return completions.length
}

/**
 * Push one notification with a program token.
 * @param {string} inbox - inbox id.
 * @param {string} token - program token.
 * @param {object} input - item fields.
 * @returns {Promise<Record<string, any>>} push response.
 */
async function push(inbox, token, input) {
  const response = await call(`/v1/inboxes/${inbox}/items`, {
    token,
    method: 'POST',
    body: {
      channel: 'ticket',
      kind: 'acceptance',
      dedupeKey: `v2:${Date.now()}:${Math.random()}`,
      ...input,
    },
  })
  assert.ok(response.status === 201 || response.status === 200, `push ${inbox}: ${response.status}`)
  return response.json
}

test('v2 live: two sessions, two inboxes, isolated wakes, occupancy, restart', { skip: SKIP }, async (t) => {
  await drain('app-a', programA)
  await drain('app-b', programB)
  const pushedA = await push('app-a', programA, { title: 'v2-isolation-a', payload: { side: 'a' } })
  const pushedB = await push('app-b', programB, { title: 'v2-isolation-b', payload: { side: 'b' } })

  const host = createFakeHost()
  host.createAgent('session-a')
  host.createAgent('session-b')
  const first = await createTestManager({ host })
  t.after(() => first.manager.stop())
  await first.manager.start()

  const boundA = await first.manager.bind({ sessionId: 'session-a', descriptor: descriptorA })
  const boundB = await first.manager.bind({ sessionId: 'session-b', descriptor: descriptorB })
  assert.equal(boundA.ok, true, boundA.message)
  assert.equal(boundB.ok, true, boundB.message)

  await waitFor(
    () => host.followups.filter((entry) => entry.agentId === 'session-a').length === 1,
    { label: 'session-a wake', timeoutMs: 8000 },
  )
  await waitFor(
    () => host.followups.filter((entry) => entry.agentId === 'session-b').length === 1,
    { label: 'session-b wake', timeoutMs: 8000 },
  )
  const wakeTextA = host.followups.find((entry) => entry.agentId === 'session-a').message.content[0].text
  const wakeTextB = host.followups.find((entry) => entry.agentId === 'session-b').message.content[0].text
  assert.match(wakeTextA, new RegExp(`inbox=app-a revision=${pushedA.revision}`))
  assert.match(wakeTextB, new RegExp(`inbox=app-b revision=${pushedB.revision}`))
  assert.ok(!wakeTextA.includes('v2-isolation-a'))
  assert.ok(!wakeTextA.includes('app-b'))
  assert.ok(!wakeTextB.includes('app-a'))

  const occupancyA = await call('/v1/inboxes/app-a/occupancy', { token: wakeA })
  const occupancyB = await call('/v1/inboxes/app-b/occupancy', { token: wakeB })
  assert.equal(occupancyA.json.occupiedBy, 'session-a')
  assert.equal(occupancyB.json.occupiedBy, 'session-b')

  // Drain via the program's own client surface, then end both turns: no wake.
  await drain('app-a', programA)
  await drain('app-b', programB)
  host.endTurn(host.agents.get('session-a'))
  host.endTurn(host.agents.get('session-b'))
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(host.followups.length, 2, 'an empty board stays silent')

  // A new item on app-a wakes only session-a.
  host.endTurn(host.agents.get('session-a'))
  await push('app-a', programA, { title: 'v2-isolation-a2', payload: { round: 2 } })
  await waitFor(
    () => host.followups.filter((entry) => entry.agentId === 'session-a').length === 2,
    { label: 'second A wake', timeoutMs: 8000 },
  )
  assert.equal(host.followups.filter((entry) => entry.agentId === 'session-b').length, 1, 'B untouched')
  host.endTurn(host.agents.get('session-a'))
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(
    host.followups.filter((entry) => entry.agentId === 'session-a').length,
    2,
    'the same revision is not re-woken',
  )
  await drain('app-a', programA)

  // Restart: both bindings and cursors restore; no replay of the processed revision.
  await first.manager.stop()
  const secondHost = createFakeHost()
  secondHost.createAgent('session-a')
  secondHost.createAgent('session-b')
  const second = await createTestManager({ host: secondHost, stateFile: first.stateFile })
  t.after(() => second.manager.stop())
  await second.manager.start()
  await waitFor(
    () => second.manager.engines.size === 2,
    { label: 'two engines after restart', timeoutMs: 8000 },
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(secondHost.followups.length, 0, 'processed revisions are not replayed')
  await push('app-b', programB, { title: 'v2-after-restart', payload: { round: 2 } })
  await waitFor(
    () => secondHost.followups.filter((entry) => entry.agentId === 'session-b').length === 1,
    { label: 'B wake after restart', timeoutMs: 8000 },
  )
  assert.equal(
    secondHost.followups.filter((entry) => entry.agentId === 'session-a').length,
    0,
    'A is not woken by app-b',
  )
  await drain('app-b', programB)

  // Token-ref validation fails closed.
  const invalid = await second.manager.bind({
    sessionId: 'session-c',
    descriptor: { inboxId: 'app-a', adapterTokenRef: 'relative.token' },
  })
  assert.equal(invalid.ok, false)
  assert.match(invalid.message, /TOKEN_REF_NOT_ABSOLUTE/)

  // Disposing one session clears only its binding/occupancy.
  secondHost.dispose(secondHost.agents.get('session-a'))
  await waitFor(
    async () => {
      const occupancy = await call('/v1/inboxes/app-a/occupancy', { token: wakeA })
      return occupancy.json.occupied === false
    },
    { label: 'app-a occupancy cleared', timeoutMs: 8000 },
  )
  assert.equal(second.manager.bindingFor('session-b') !== undefined, true)
  assert.equal(second.manager.engines.has('session-b'), true, 'B engine stays alive')

  await second.manager.unbind('session-b')
  const occupancyBAfter = await call('/v1/inboxes/app-b/occupancy', { token: wakeB })
  assert.equal(occupancyBAfter.json.occupied, false)
  await drain('app-a', programA)
  await drain('app-b', programB)
})
