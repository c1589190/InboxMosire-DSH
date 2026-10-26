import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_VERSION, StateStore, emptyState, normalizeState } from '../lib/state.js'
import { emptyBinding, normalizeBinding } from '../lib/state.js'

const EXPECTED = { inboxId: 'main', channels: ['ticket'] }

/**
 * Create a temporary directory and state path.
 * @param {import('node:test').TestContext} t - test context.
 * @returns {Promise<{dir: string, file: string}>} paths.
 */
async function tempState(t) {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-state-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  return { dir, file: join(dir, 'nested', 'state.json') }
}

test('load returns an empty state when no file exists', async (t) => {
  const { file } = await tempState(t)
  const store = new StateStore({ file, debounceMs: 1 })
  const loaded = await store.load(EXPECTED)
  assert.equal(loaded.existed, false)
  assert.equal(loaded.state.sessionRef, '')
  assert.equal(loaded.state.lastEventId, null)
  assert.equal(loaded.state.version, STATE_VERSION)
})

test('write persists atomically with mode 0600 and reloads', async (t) => {
  const { dir, file } = await tempState(t)
  const store = new StateStore({ file, debounceMs: 1 })
  const state = emptyState(EXPECTED)
  state.sessionRef = 'session-1'
  state.lastEventId = 129
  state.lastObservedRevision = 8
  state.lastWokenRevision = 7
  state.channels = ['ticket', 'tweet-review']
  state.enabled = false
  await store.flush(state)

  const info = await stat(file)
  assert.equal(info.mode & 0o777, 0o600)
  assert.deepEqual(await readdir(join(dir, 'nested')), ['state.json'])

  const reloaded = await new StateStore({ file }).load(EXPECTED)
  assert.equal(reloaded.existed, true)
  assert.equal(reloaded.state.sessionRef, 'session-1')
  assert.equal(reloaded.state.lastEventId, 129)
  assert.equal(reloaded.state.lastObservedRevision, 8)
  assert.equal(reloaded.state.lastWokenRevision, 7)
  assert.deepEqual(reloaded.state.channels, ['ticket', 'tweet-review'])
  assert.equal(reloaded.state.enabled, false)
  assert.match(reloaded.state.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('a state file for another inbox is refused, not overwritten', async (t) => {
  const { file } = await tempState(t)
  const store = new StateStore({ file })
  const state = emptyState({ inboxId: 'smoke', channels: [] })
  state.sessionRef = 'session-smoke'
  await store.flush(state)
  const before = await readFile(file, 'utf8')
  await assert.rejects(
    () => new StateStore({ file }).load(EXPECTED),
    /属于 inbox "smoke"/,
  )
  assert.equal(await readFile(file, 'utf8'), before)
})

test('a newer state version is refused', async (t) => {
  const { file } = await tempState(t)
  const store = new StateStore({ file })
  await store.flush({ ...emptyState(EXPECTED), version: STATE_VERSION + 1 })
  await assert.rejects(
    () => new StateStore({ file }).load(EXPECTED),
    /版本/,
  )
})

test('an unversioned legacy document migrates with defaults', () => {
  const { state, migrated } = normalizeState(
    {
      inboxId: 'main',
      sessionRef: 'session-legacy',
      lastEventId: 12,
      lastWokenRevision: 3,
      channels: ['ticket'],
    },
    EXPECTED,
  )
  assert.equal(migrated, true)
  assert.equal(state.version, STATE_VERSION)
  assert.equal(state.lastEventId, 12)
  assert.equal(state.lastWokenRevision, 3)
  assert.equal(state.wake.stalls, 0)
  assert.equal(state.health.sse, 'idle')
  assert.equal(state.pendingWake, null)
})

test('malformed numbers and health records are repaired, not trusted', () => {
  const { state } = normalizeState(
    {
      version: 1,
      inboxId: 'main',
      lastEventId: 'NaN',
      lastWokenRevision: -4,
      wake: { stalls: 'x', nextWakeAllowedAt: 'never' },
      health: { configError: 'oops', lastError: [] },
    },
    EXPECTED,
  )
  assert.equal(state.lastEventId, 0)
  assert.equal(state.lastWokenRevision, 0)
  assert.equal(state.wake.stalls, 0)
  assert.equal(state.wake.nextWakeAllowedAt, null)
  assert.equal(state.health.configError, null)
  assert.equal(state.health.lastError, null)
})

test('a corrupt JSON document reports a readable error and stays intact', async (t) => {
  const { file } = await tempState(t)
  const store = new StateStore({ file })
  await store.flush(emptyState(EXPECTED))
  await writeFile(file, '{ not json', 'utf8')
  await assert.rejects(() => new StateStore({ file }).load(EXPECTED), /不是 JSON/)
  assert.equal(await readFile(file, 'utf8'), '{ not json')
})

test('summary diagnostics persist only bounded counts and codes, never item text', () => {
  const { state } = normalizeState(
    {
      version: 1,
      inboxId: 'main',
      summary: {
        state: 'ok',
        at: '2026-10-26T00:00:00.000Z',
        shown: 2,
        remaining: 1,
        code: null,
        message: 'bounded',
        title: 'SECRET-TITLE',
        items: [{ itemId: 'itm_1', title: 'SECRET-TITLE' }],
      },
    },
    EXPECTED,
  )
  assert.deepEqual(state.summary, {
    state: 'ok',
    at: '2026-10-26T00:00:00.000Z',
    shown: 2,
    remaining: 1,
    code: null,
    message: 'bounded',
  })
  assert.ok(!JSON.stringify(state).includes('SECRET-TITLE'))
  assert.equal(emptyState(EXPECTED).summary.state, 'unknown')
})

test('a binding summary record repairs unknown states and preserves forbidden', () => {
  const base = normalizeBinding({}, 'session-a')
  assert.equal(base.summary.state, 'unknown')
  const forbidden = normalizeBinding(
    {
      summary: {
        state: 'forbidden',
        shown: 'x',
        remaining: -2,
        code: 'SUMMARY_FORBIDDEN',
        message: 'token 缺少 items:read',
      },
    },
    'session-a',
  )
  assert.equal(forbidden.summary.state, 'forbidden')
  assert.equal(forbidden.summary.code, 'SUMMARY_FORBIDDEN')
  assert.equal(forbidden.summary.shown, 0)
  assert.equal(forbidden.summary.remaining, 0)
  const junk = normalizeBinding({ summary: { state: 'made-up', at: 42 } }, 'session-a')
  assert.equal(junk.summary.state, 'unknown')
  assert.equal(junk.summary.at, null)
  assert.equal(emptyBinding('session-a').summary.state, 'unknown')
  assert.equal(emptyBinding('session-a').health.programMcp.state, 'unknown')
  const withProgram = normalizeBinding(
    { health: { programMcp: { state: 'missing', at: '2026-10-26T00:00:00.000Z' } } },
    'session-a',
  )
  assert.deepEqual(withProgram.health.programMcp, {
    state: 'missing',
    at: '2026-10-26T00:00:00.000Z',
  })
  const junkProgram = normalizeBinding(
    { health: { programMcp: { state: 'made-up', at: 1 } } },
    'session-a',
  )
  assert.deepEqual(junkProgram.health.programMcp, { state: 'unknown', at: null })
})


test('binding wakeMode defaults to claim, persists view-ack, and rejects junk', () => {
  assert.equal(emptyBinding('session-a').wakeMode, 'claim')
  assert.equal(emptyBinding('session-a').restUntil, null)
  const viewAck = normalizeBinding(
    {
      inboxId: 'main',
      apiBaseUrl: 'http://127.0.0.1:18765',
      adapterTokenRef: 'file:/tmp/wake.token',
      channels: ['qq'],
      wakeMode: 'view-ack',
      restUntil: 1893456000000,
    },
    'session-a',
  )
  assert.equal(viewAck.wakeMode, 'view-ack')
  assert.equal(viewAck.restUntil, 1893456000000)
  const junk = normalizeBinding(
    {
      inboxId: 'main',
      apiBaseUrl: 'http://127.0.0.1:18765',
      adapterTokenRef: 'file:/tmp/wake.token',
      wakeMode: 'make-believe',
    },
    'session-b',
  )
  assert.equal(junk.wakeMode, 'claim')
})
