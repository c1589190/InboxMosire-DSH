import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpsLog, endpointOf, sanitizeEntry } from '../lib/ops-log.js'

/**
 * Create a temp directory.
 * @param {import('node:test').TestContext} t - test context.
 * @returns {Promise<string>} directory.
 */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-ops-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  return dir
}

test('the ops log is strictly per-session', async (t) => {
  const dir = await tempDir(t)
  const log = new OpsLog({ file: join(dir, 'ops.jsonl') })
  log.append({ action: 'bind', actor: 'agent', session: 'session-a', inbox: 'app-a' })
  log.append({ action: 'bind', actor: 'agent', session: 'session-b', inbox: 'app-b' })
  log.append({ action: 'suspend', actor: 'user', session: 'session-a', inbox: 'app-a' })

  const a = log.read('session-a')
  assert.deepEqual(
    a.map((entry) => entry.action),
    ['suspend', 'bind'],
    'newest first, only this session',
  )
  const b = log.read('session-b')
  assert.equal(b.length, 1)
  assert.equal(b[0].inbox, 'app-b')

  assert.deepEqual(log.read(''), [])
  assert.deepEqual(log.read('session-unknown'), [])
  assert.equal(log.last('session-a').action, 'suspend')
  assert.equal(log.last('session-unknown'), null)
})

test('the ops log whitelists fields so no credential or content can persist', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'ops.jsonl')
  const log = new OpsLog({ file })
  const written = log.append({
    action: 'bind',
    actor: 'agent',
    session: 'session-a',
    inbox: 'app-a',
    endpoint: '127.0.0.1:47651',
    wakeMode: 'view-ack',
    result: 'ok',
    token: 'SUPER-SECRET-TOKEN',
    adapterTokenRef: 'file:/home/u/.config/iibot/wake.token',
    content: 'private message body',
    payload: { any: 'thing' },
  })
  assert.deepEqual(Object.keys(written).sort(), [
    'action',
    'actor',
    'at',
    'endpoint',
    'inbox',
    'result',
    'session',
    'wakeMode',
  ])

  const raw = await readFile(file, 'utf8')
  assert.ok(!raw.includes('SUPER-SECRET-TOKEN'))
  assert.ok(!raw.includes('wake.token'))
  assert.ok(!raw.includes('private message body'))
  assert.equal((await stat(file)).mode & 0o777, 0o600)

  assert.equal(log.append({ action: 'wake', actor: 'user', session: 'session-a' }), null)
  assert.equal(log.append({ action: 'bind', actor: 'nobody', session: 'session-a' }), null)
  assert.equal(log.append({ action: 'bind', actor: 'user', session: '' }), null)
})

test('sanitizeEntry truncates long fields and normalizes the result flag', () => {
  const record = sanitizeEntry(
    {
      action: 'bind',
      actor: 'agent',
      session: 's'.repeat(500),
      inbox: 'i'.repeat(500),
      endpoint: 'e'.repeat(500),
      error: 'x'.repeat(500),
      result: 'weird',
    },
    '2026-10-27T00:00:00.000Z',
  )
  assert.equal(record.session.length, 200)
  assert.equal(record.inbox.length, 200)
  assert.equal(record.endpoint.length, 120)
  assert.equal(record.error.length, 64)
  assert.equal(record.result, 'ok')
  assert.equal(record.at, '2026-10-27T00:00:00.000Z')
})

test('rotation keeps the newest entries of every session', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'ops.jsonl')
  const log = new OpsLog({ file, perSessionCap: 3, maxBytes: 1 })
  for (let index = 1; index <= 6; index += 1) {
    log.append({ action: 'bind', actor: 'agent', session: 'session-a', inbox: `a${index}` })
  }
  log.append({ action: 'suspend', actor: 'user', session: 'session-b', inbox: 'b1' })

  assert.deepEqual(
    log.read('session-a').map((entry) => entry.inbox),
    ['a6', 'a5', 'a4'],
  )
  assert.deepEqual(
    log.read('session-b').map((entry) => entry.inbox),
    ['b1'],
  )
  const raw = await readFile(file, 'utf8')
  assert.ok(!raw.includes('"a1"'), 'rotated file no longer carries the oldest entry')

  const reloaded = new OpsLog({ file })
  assert.deepEqual(
    reloaded.read('session-a').map((entry) => entry.inbox),
    ['a6', 'a5', 'a4'],
  )
})

test('a torn line is skipped and a missing file reads empty', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'ops.jsonl')
  await writeFile(
    file,
    `${JSON.stringify({ at: 't1', action: 'bind', actor: 'agent', session: 's1', result: 'ok' })}\n{not json\n`,
  )
  const log = new OpsLog({ file })
  assert.equal(log.read('s1').length, 1)

  const missing = new OpsLog({ file: join(dir, 'nope', 'ops.jsonl') })
  assert.deepEqual(missing.read('s1'), [])
  assert.equal(missing.last('s1'), null)
})

test('endpointOf keeps only host:port and drops credentials and paths', () => {
  assert.equal(endpointOf('http://127.0.0.1:47651/v1'), '127.0.0.1:47651')
  assert.equal(endpointOf('http://user:pass@127.0.0.1:47651/v1?x=1'), '127.0.0.1:47651')
  assert.equal(endpointOf('http://[::1]:47651/v1'), '[::1]:47651')
  assert.equal(endpointOf('not a url'), '')
  assert.equal(endpointOf(undefined), '')
})

test('a host stop keeps its reason and stays inside one session', async (t) => {
  const dir = await tempDir(t)
  const log = new OpsLog({ file: join(dir, 'ops.jsonl') })
  const record = log.append({
    action: 'stop',
    actor: 'host',
    session: 'session-a',
    inbox: 'app-a',
    reason: 'session-archived',
    result: 'ok',
    token: 'nope',
  })
  assert.equal(record.reason, 'session-archived')
  assert.equal(log.read('session-a')[0].reason, 'session-archived')
  assert.deepEqual(log.read('session-b'), [])
  assert.ok(!(await readFile(join(dir, 'ops.jsonl'), 'utf8')).includes('nope'))
})
