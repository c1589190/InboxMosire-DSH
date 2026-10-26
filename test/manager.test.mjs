import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeHostState } from '../lib/state.js'
import {
  createFakeHost,
  createTestManager,
  waitFor,
  writeBindingDescriptor,
} from './helpers/fake-host.mjs'
import { startFakeInbox } from './helpers/fake-server.mjs'

/**
 * Create a temp directory.
 * @param {import('node:test').TestContext} t - test context.
 * @returns {Promise<string>} directory.
 */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-manager-test-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  return dir
}

/**
 * Build a host with two live sessions, two fake inboxes, and two bindings.
 * @param {import('node:test').TestContext} t - test context.
 * @returns {Promise<Record<string, any>>} handles.
 */
async function setupTwo(t) {
  const serverA = await startFakeInbox({ inbox: 'app-a' })
  const serverB = await startFakeInbox({ inbox: 'app-b' })
  t.after(() => Promise.all([serverA.close(), serverB.close()]))
  const host = createFakeHost()
  host.createAgent('session-a')
  host.createAgent('session-b')
  const dir = await tempDir(t)
  const created = await createTestManager({ host })
  t.after(() => created.manager.stop())
  await created.manager.start()
  const descriptorA = await writeBindingDescriptor(dir, serverA, { label: 'S1' })
  const descriptorB = await writeBindingDescriptor(dir, serverB, { label: 'S2' })
  const boundA = await created.manager.bind({ sessionId: 'session-a', descriptor: descriptorA })
  const boundB = await created.manager.bind({ sessionId: 'session-b', descriptor: descriptorB })
  assert.equal(boundA.ok, true, boundA.message)
  assert.equal(boundB.ok, true, boundB.message)
  await waitFor(
    () => serverA.connectionCount === 1 && serverB.connectionCount === 1,
    { label: 'both SSE connections' },
  )
  return { ...created, host, serverA, serverB, descriptorA, descriptorB, dir }
}

test('v1 single-binding state migrates to v2 without losing data', () => {
  const migrated = normalizeHostState(
    {
      version: 1,
      inboxId: 'main',
      sessionRef: 'session-legacy',
      channels: ['ticket'],
      lastEventId: 151,
      lastObservedRevision: 9,
      lastWokenRevision: 4,
      enabled: true,
      lastWake: { revision: 4, available: 1 },
      wake: { attempts: 2, stalls: 0, nextWakeAllowedAt: null },
      health: { sse: 'connected', reconnects: 1 },
    },
    {
      legacyDefaults: {
        apiBaseUrl: 'http://127.0.0.1:18765',
        adapterTokenRef: 'file:/tmp/legacy.token',
      },
    },
  )
  assert.equal(migrated.state.version, 2)
  assert.equal(migrated.state.legacyV1.sessionRef, 'session-legacy')
  const binding = migrated.state.bindings['session-legacy']
  assert.ok(binding)
  assert.equal(binding.inboxId, 'main')
  assert.equal(binding.apiBaseUrl, 'http://127.0.0.1:18765')
  assert.equal(binding.adapterTokenRef, 'file:/tmp/legacy.token')
  assert.equal(binding.lastEventId, 151)
  assert.equal(binding.lastWokenRevision, 4)
  assert.equal(binding.health.sse, 'idle', 'a restart never inherits a live SSE status')
  assert.equal(binding.blocked, null)
})

test('a v1 binding without a tokenRef is preserved but blocked, never silent', () => {
  const migrated = normalizeHostState(
    { version: 1, inboxId: 'main', sessionRef: 'session-legacy', lastEventId: 9 },
    { legacyDefaults: { apiBaseUrl: 'http://127.0.0.1:18765' } },
  )
  const binding = migrated.state.bindings['session-legacy']
  assert.equal(binding.blocked.code, 'TOKEN_REF_MISSING')
  assert.equal(migrated.state.legacyV1.lastEventId, 9)
})

test('two bindings wake only their own session and mark occupancy', async (t) => {
  const { host, serverA, serverB, manager } = await setupTwo(t)

  assert.equal(serverA.occupant, 'session-a')
  assert.equal(serverB.occupant, 'session-b')
  assert.ok(serverA.occupancyCalls.some((call) => call.method === 'PUT' && call.occupiedBy === 'session-a'))

  serverA.push({ channel: 'ticket' })
  await waitFor(
    () => host.followups.some((entry) => entry.agentId === 'session-a'),
    { label: 'wake for session-a' },
  )
  assert.equal(host.followups.filter((entry) => entry.agentId === 'session-b').length, 0, 'B is not woken by A')
  const wakeA = host.followups.find((entry) => entry.agentId === 'session-a')
  assert.match(wakeA.message.content[0].text, /inbox=app-a revision=1 available=1/)
  assert.match(wakeA.message.content[0].text, /如果摘要不足，再调用 inbox_list/)
  assert.match(wakeA.message.content[0].text, /"itemId":"itm_fake_1"/)

  host.endTurn(host.agents.get('session-a'))
  serverB.push({ channel: 'ticket' })
  await waitFor(
    () => host.followups.some((entry) => entry.agentId === 'session-b'),
    { label: 'wake for session-b' },
  )
  assert.equal(host.followups.filter((entry) => entry.agentId === 'session-a').length, 1, 'A is not woken by B')
  const wakeB = host.followups.find((entry) => entry.agentId === 'session-b')
  assert.match(wakeB.message.content[0].text, /inbox=app-b revision=1/)

  const bindingA = manager.bindingFor('session-a')
  const bindingB = manager.bindingFor('session-b')
  assert.equal(bindingA.lastEventId, 1)
  assert.equal(bindingB.lastEventId, 1)
  assert.equal(manager.engines.size, 2, 'each binding owns its own engine')
  assert.notEqual(
    manager.engines.get('session-a'),
    manager.engines.get('session-b'),
    'engines are not shared',
  )
  assert.equal(bindingA.lastWokenRevision, 1)
  assert.equal(bindingB.lastWokenRevision, 1)

  const text = manager.statusText('session-a')
  assert.match(text, /isBound=true inbox=app-a/)
  assert.match(text, /session-b → app-b/)
  assert.match(text, /occupancy: occupied by session-a/)
})

test('re-binding one session to another inbox resets only that session', async (t) => {
  const { host, serverA, serverB, manager, dir } = await setupTwo(t)
  const serverC = await startFakeInbox({ inbox: 'app-c' })
  t.after(() => serverC.close())

  serverA.push({ channel: 'ticket' })
  await waitFor(() => manager.bindingFor('session-a').lastWokenRevision === 1, {
    label: 'first A wake',
  })
  host.endTurn(host.agents.get('session-a'))
  const cursorB = manager.bindingFor('session-b').lastEventId

  const descriptorC = await writeBindingDescriptor(dir, serverC, { label: 'S1-c' })
  const rebound = await manager.bind({ sessionId: 'session-a', descriptor: descriptorC })
  assert.equal(rebound.ok, true, rebound.message)
  assert.equal(manager.bindingFor('session-a').inboxId, 'app-c')
  assert.equal(manager.bindingFor('session-a').lastWokenRevision, 0, 'different inbox resets the watermark')
  assert.ok(serverA.occupancyCalls.some((call) => call.method === 'DELETE'), 'old occupancy vacated')
  await waitFor(() => serverC.connectionCount === 1, { label: 'C SSE' })

  serverB.push({ channel: 'ticket' })
  await waitFor(() => host.followups.filter((entry) => entry.agentId === 'session-b').length === 1, {
    label: 'S2 still woken',
  })
  assert.equal(manager.bindingFor('session-b').lastEventId, cursorB + 1, 'S2 cursor untouched')
})

test('disposing one session stops only that binding and clears its occupancy', async (t) => {
  const { host, serverA, serverB, manager } = await setupTwo(t)
  host.dispose(host.agents.get('session-a'))
  await waitFor(() => manager.bindingFor('session-a').health.session === 'disposed', {
    label: 'disposed state',
  })
  await waitFor(() => serverA.connectionCount === 0, { label: 'A SSE closed' })
  await waitFor(
    () => serverA.occupancyCalls.some((call) => call.method === 'DELETE'),
    { label: 'A occupancy cleared' },
  )
  assert.equal(serverB.connectionCount, 1, 'B SSE stays open')
  serverB.push({ channel: 'ticket' })
  await waitFor(
    () => host.followups.filter((entry) => entry.agentId === 'session-b').length === 1,
    { label: 'B still wakes' },
  )
  assert.equal(host.followups.filter((entry) => entry.agentId === 'session-a').length, 0)
})

test('unbinding one session removes only its binding', async (t) => {
  const { serverA, serverB, manager, host } = await setupTwo(t)
  const result = await manager.unbind('session-a')
  assert.match(result.message, /已解绑 session-a/)
  assert.equal(manager.bindingFor('session-a'), undefined)
  assert.ok(manager.bindingFor('session-b'))
  await waitFor(() => serverA.connectionCount === 0, { label: 'A SSE closed' })
  await waitFor(
    () => serverA.occupancyCalls.some((call) => call.method === 'DELETE'),
    { label: 'A occupancy cleared' },
  )
  assert.equal(serverB.connectionCount, 1)
  serverB.push({ channel: 'ticket' })
  await waitFor(
    () => host.followups.filter((entry) => entry.agentId === 'session-b').length === 1,
    { label: 'B wakes after A unbind' },
  )
})

test('an unusable tokenRef fails the bind and leaves no binding', async (t) => {
  const host = createFakeHost()
  host.createAgent('session-a')
  const created = await createTestManager({ host })
  t.after(() => created.manager.stop())
  await created.manager.start()
  const relative = await created.manager.bind({
    sessionId: 'session-a',
    descriptor: { inboxId: 'app-a', apiBaseUrl: 'http://127.0.0.1:18765', adapterTokenRef: 'relative.token' },
  })
  assert.equal(relative.ok, false)
  assert.match(relative.message, /TOKEN_REF_NOT_ABSOLUTE/)
  const missing = await created.manager.bind({
    sessionId: 'session-a',
    descriptor: { inboxId: 'app-a', apiBaseUrl: 'http://127.0.0.1:18765', adapterTokenRef: 'file:/nonexistent/wake.token' },
  })
  assert.equal(missing.ok, false)
  assert.match(missing.message, /TOKEN_REF_UNREADABLE/)
  assert.equal(created.manager.bindingFor('session-a'), undefined)
})

test('a binding for a cold session starts on resume', async (t) => {
  const server = await startFakeInbox({ inbox: 'app-a' })
  t.after(() => server.close())
  const host = createFakeHost()
  const dir = await tempDir(t)
  const created = await createTestManager({ host })
  t.after(() => created.manager.stop())
  await created.manager.start()
  const descriptor = await writeBindingDescriptor(dir, server)
  const bound = await created.manager.bind({ sessionId: 'session-late', descriptor })
  assert.equal(bound.ok, true)
  assert.equal(server.connectionCount, 0, 'no SSE without a live agent')
  host.createAgent('session-late')
  await waitFor(() => server.connectionCount === 1, { label: 'SSE after resume' })
  assert.equal(server.occupant, 'session-late')
  server.push({ channel: 'ticket' })
  await waitFor(
    () => host.followups.some((entry) => entry.agentId === 'session-late'),
    { label: 'wake after resume' },
  )
})

test('RESTART: both bindings restore independently from the v2 document', async (t) => {
  const serverA = await startFakeInbox({ inbox: 'app-a' })
  const serverB = await startFakeInbox({ inbox: 'app-b' })
  t.after(() => Promise.all([serverA.close(), serverB.close()]))
  const dir = await tempDir(t)
  const firstHost = createFakeHost()
  firstHost.createAgent('session-a')
  firstHost.createAgent('session-b')
  const first = await createTestManager({ host: firstHost })
  await first.manager.start()
  await first.manager.bind({ sessionId: 'session-a', descriptor: await writeBindingDescriptor(dir, serverA) })
  await first.manager.bind({ sessionId: 'session-b', descriptor: await writeBindingDescriptor(dir, serverB) })
  await waitFor(() => serverA.connectionCount === 1 && serverB.connectionCount === 1, { label: 'SSE' })
  serverA.push({ channel: 'ticket' })
  await waitFor(() => first.manager.bindingFor('session-a').lastWokenRevision === 1, {
    label: 'A wake before restart',
  })
  const cursorA = first.manager.bindingFor('session-a').lastEventId
  const cursorB = first.manager.bindingFor('session-b').lastEventId
  await first.manager.stop()

  const secondHost = createFakeHost()
  secondHost.createAgent('session-a')
  secondHost.createAgent('session-b')
  const second = await createTestManager({ host: secondHost, stateFile: first.stateFile })
  t.after(() => second.manager.stop())
  await second.manager.start()
  await waitFor(() => serverA.connectionCount === 1 && serverB.connectionCount === 1, {
    label: 'SSE after restart',
  })
  assert.equal(second.manager.bindingFor('session-a').lastWokenRevision, 1)
  assert.equal(second.manager.bindingFor('session-a').lastEventId, cursorA)
  assert.equal(second.manager.bindingFor('session-b').lastEventId, cursorB)
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(secondHost.followups.length, 0, 'already-woken revisions are not replayed')

  serverB.push({ channel: 'ticket' })
  await waitFor(
    () => secondHost.followups.some((entry) => entry.agentId === 'session-b'),
    { label: 'B wake after restart' },
  )
})

test('the v2 document is versioned and keeps the legacy snapshot', async (t) => {
  const host = createFakeHost()
  host.createAgent('session-a')
  const dir = await tempDir(t)
  const stateFile = join(dir, 'state.json')
  await writeFile(
    stateFile,
    JSON.stringify({
      version: 1,
      inboxId: 'main',
      sessionRef: 'session-a',
      lastEventId: 12,
      lastWokenRevision: 3,
      enabled: true,
    }),
  )
  const created = await createTestManager({
    host,
    stateFile,
    overrides: { tokenFile: '/tmp/does-not-exist.token' },
  })
  t.after(() => created.manager.stop())
  assert.equal(created.manager.state.version, 2)
  assert.equal(created.manager.state.legacyV1.lastEventId, 12)
  const binding = created.manager.bindingFor('session-a')
  assert.equal(binding.lastEventId, 12)
  assert.equal(binding.adapterTokenRef, 'file:/tmp/does-not-exist.token')
  assert.equal(binding.blocked, null)
  await created.manager.start()
  assert.equal(
    binding.health.configError?.code,
    'TOKEN_REF_UNREADABLE',
    'a legacy binding with an unreadable token fails closed',
  )
  assert.ok(dir)
})

test('the manager exposes each binding summary outcome and clears it on retry', async (t) => {
  const { host, serverA, manager } = await setupTwo(t)
  serverA.push({ channel: 'ticket', title: 'A-SUMMARY' })
  await waitFor(() => manager.bindingFor('session-a').summary?.state === 'ok', {
    label: 'A summary ok',
  })
  const binding = manager.bindingFor('session-a')
  assert.equal(binding.summary.shown, 1)
  assert.equal(binding.summary.remaining, 0)
  const text = manager.statusText('session-a')
  assert.match(text, /summary: enabled=true maxItems=3/)
  assert.match(text, /state=ok shown=1/)
  assert.match(text, /summary=ok/)

  await manager.retry('session-a')
  assert.equal(manager.bindingFor('session-a').summary.state, 'unknown')
  await waitFor(() => manager.engines.has('session-a'), { label: 'A engine restarted' })
  serverA.setItemsMode('403')
  host.endTurn(host.agents.get('session-a'))
  serverA.push({ channel: 'ticket', title: 'A-FORBIDDEN' })
  await waitFor(() => manager.bindingFor('session-a').summary?.state === 'forbidden', {
    label: 'A summary forbidden',
  })
  assert.equal(manager.bindingFor('session-a').summary.code, 'SUMMARY_FORBIDDEN')
  assert.match(manager.statusText('session-a'), /state=forbidden/)
  assert.match(manager.statusText('session-a'), /SUMMARY_FORBIDDEN/)
})

test('a successful completion can rest only the calling binding, and 0 clears it', async (t) => {
  const { host, serverA, manager } = await setupTwo(t)
  const startedAt = host.now()
  host.emit(
    'tools/result',
    {
      agent: { id: 'session-a' },
      name: 'mcp__iibot__inbox_rest',
      arguments: { restSeconds: 60 },
    },
    { isError: false },
  )
  const bindingA = manager.bindingFor('session-a')
  assert.ok(bindingA.restUntil >= startedAt + 60_000)
  assert.equal(manager.bindingFor('session-b').restUntil ?? null, null)
  assert.match(manager.statusText('session-a'), /rest: until=/)

  serverA.push({ channel: 'ticket' })
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(
    host.followups.filter((entry) => entry.agentId === 'session-a').length,
    0,
    'rest suppresses followup',
  )

  host.emit(
    'tools/result',
    {
      agent: { id: 'session-a' },
      name: 'mcp__iibot__inbox_rest',
      arguments: { restSeconds: 0 },
    },
    { isError: false },
  )
  assert.equal(manager.bindingFor('session-a').restUntil, null)
  await waitFor(
    () => host.followups.some((entry) => entry.agentId === 'session-a'),
    { label: 'wake after rest cleared' },
  )
})

test('rest is ignored for failed tools and unrelated tools', async (t) => {
  const { manager } = await setupTwo(t)
  const failed = manager.onToolResult(
    {
      agent: { id: 'session-a' },
      name: 'mcp__iibot__inbox_rest',
      arguments: { restSeconds: 60 },
    },
    { isError: true },
  )
  assert.equal(failed, undefined)
  const unrelated = manager.onToolResult(
    {
      agent: { id: 'session-a' },
      name: 'mcp__iibot__bot_reply',
      arguments: { restSeconds: 60 },
    },
    { isError: false },
  )
  assert.equal(unrelated, undefined)
  assert.equal(manager.bindingFor('session-a').restUntil ?? null, null)
})

test('rest expires and wakes at most once for the latest revision', async (t) => {
  const { host, serverA } = await setupTwo(t)
  host.emit(
    'tools/result',
    {
      agent: { id: 'session-a' },
      name: 'mcp__iibot__inbox_complete',
      arguments: { restSeconds: 1 },
    },
    { isError: false },
  )
  serverA.push({ channel: 'ticket', summary: 'rest expiry' })
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(
    host.followups.filter((entry) => entry.agentId === 'session-a').length,
    0,
    'no wake before expiry',
  )
  await waitFor(
    () => host.followups.filter((entry) => entry.agentId === 'session-a').length === 1,
    { label: 'wake after rest expiry', timeoutMs: 4000 },
  )
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(
    host.followups.filter((entry) => entry.agentId === 'session-a').length,
    1,
    'expiry produces one wake, not a loop',
  )
})
