import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ConfigError,
  loadToken,
  parseChannels,
  redact,
  resolveConfig,
} from '../lib/config.js'

/**
 * Create a temporary directory for a test.
 * @param {import('node:test').TestContext} t - test context.
 * @returns {Promise<string>} directory path.
 */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-config-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  return dir
}

test('parseChannels accepts comma, whitespace, arrays, and de-duplicates', () => {
  assert.deepEqual(parseChannels('ticket,tweet-review'), ['ticket', 'tweet-review'])
  assert.deepEqual(parseChannels(' ticket  tweet-review '), ['ticket', 'tweet-review'])
  assert.deepEqual(parseChannels(['ticket', 'ticket', '']), ['ticket'])
  assert.deepEqual(parseChannels(undefined), [])
})

test('configuration precedence is row > env > local file > defaults', async (t) => {
  const dir = await tempDir(t)
  const resolved = resolveConfig(
    { inboxId: 'row-inbox', debounceMs: 250 },
    { INBOX_INBOX_ID: 'env-inbox', INBOX_API_URL: 'http://env:1234' },
    { inboxId: 'file-inbox', debounceMs: 9999, apiUrl: 'http://file:9' },
  )
  assert.equal(resolved.value.inboxId, 'row-inbox')
  assert.equal(resolved.value.debounceMs, 250)
  assert.equal(resolved.value.apiUrl, 'http://env:1234')
  assert.deepEqual(resolved.errors, [])
  assert.ok(dir)
})

test('apiUrl rejects non-HTTP schemes and embedded credentials', () => {
  const ftp = resolveConfig({ apiUrl: 'ftp://example.com' }, {}, {})
  assert.ok(ftp.errors.some((message) => message.includes('http(s)')))
  const credentials = resolveConfig({ apiUrl: 'http://user:pass@example.com' }, {}, {})
  assert.ok(credentials.errors.some((message) => message.includes('用户名')))
  const trailing = resolveConfig({ apiUrl: 'http://127.0.0.1:18765/' }, {}, {})
  assert.equal(trailing.value.apiUrl, 'http://127.0.0.1:18765')
})

test('inbox, channel, and state-path validation fail closed', () => {
  const bad = resolveConfig(
    {
      inboxId: 'bad inbox',
      channels: ['ok', 'bad channel'],
      stateFile: 'relative/state.json',
    },
    {},
    {},
  )
  assert.equal(bad.errors.length, 3)
  assert.ok(bad.errors.some((message) => message.includes('inboxId')))
  assert.ok(bad.errors.some((message) => message.includes('channel')))
  assert.ok(bad.errors.some((message) => message.includes('stateFile')))
})

test('bounded numeric and boolean settings are clamped and parsed', () => {
  const high = resolveConfig({ debounceMs: 999999, heartbeatTimeoutSeconds: 1 }, {}, {})
  assert.equal(high.value.debounceMs, 5000)
  assert.equal(high.value.heartbeatTimeoutSeconds, 5)
  const negative = resolveConfig({ debounceMs: -1 }, {}, {})
  assert.equal(negative.value.debounceMs, 0)
  assert.equal(resolveConfig({}, { INBOX_ENABLED: 'false' }, {}).value.enabled, false)
  assert.equal(resolveConfig({}, { INBOX_ENABLED: '0' }, {}).value.enabled, false)
  assert.equal(resolveConfig({ enabled: false }, {}, {}).value.enabled, false)
  assert.equal(resolveConfig({ enabled: 'true' }, {}, {}).value.enabled, true)
})

test('sessionId "auto" enables auto-binding; empty leaves the adapter unbound', () => {
  assert.equal(resolveConfig({ sessionId: 'auto' }, {}, {}).value.autoBind, true)
  assert.equal(resolveConfig({ sessionId: 'session-x' }, {}, {}).value.autoBind, false)
  assert.equal(resolveConfig({}, {}, {}).value.sessionId, '')
})

test('token provenance prefers inline, then file, and never lands in the value', () => {
  const inline = resolveConfig({ token: 'inline-secret' }, {}, {})
  assert.deepEqual(inline.tokenSource, { kind: 'inline', value: 'inline-secret' })
  assert.ok(!JSON.stringify(inline.value).includes('inline-secret'))

  const file = resolveConfig(
    {},
    { INBOX_API_TOKEN_FILE: '/run/secrets/adapter.token' },
    {},
  )
  assert.deepEqual(file.tokenSource, { kind: 'file', value: '/run/secrets/adapter.token' })
  assert.equal(file.value.tokenFile, '/run/secrets/adapter.token')
  assert.equal(resolveConfig({}, {}, {}).tokenSource.kind, 'none')
})

test('loadToken reads a file, trims it, and refuses missing or empty sources', async (t) => {
  const dir = await tempDir(t)
  const tokenFile = join(dir, 'token')
  await writeFile(tokenFile, 'abc123\n', { mode: 0o600 })
  assert.equal(await loadToken({ kind: 'file', value: tokenFile }), 'abc123')

  await assert.rejects(
    () => loadToken({ kind: 'file', value: join(dir, 'absent') }),
    (error) => error instanceof ConfigError && error.message.includes('不可读'),
  )
  await writeFile(join(dir, 'empty'), '\n')
  await assert.rejects(
    () => loadToken({ kind: 'file', value: join(dir, 'empty') }),
    (error) => error instanceof ConfigError && error.message.includes('为空'),
  )
  await assert.rejects(
    () => loadToken({ kind: 'none' }),
    (error) => error instanceof ConfigError,
  )
  assert.equal(await loadToken({ kind: 'inline', value: '  inline  ' }), 'inline')
})

test('redact removes the exact token from arbitrary text', async (t) => {
  const token = 'secret-token-value'
  assert.equal(redact(`Bearer ${token}`, token), 'Bearer <redacted-token>')
  assert.ok(!redact(`x ${token} y`, token).includes(token))
  const dir = await tempDir(t)
  await writeFile(join(dir, 'f'), 'x')
  assert.equal(await readFile(join(dir, 'f'), 'utf8'), 'x')
})

test('programMcpConnectorKey is local, bounded, and optional', () => {
  assert.equal(resolveConfig({}, {}, {}).value.programMcpConnectorKey, '')
  assert.equal(
    resolveConfig({ programMcpConnectorKey: 'custom-iibot' }, {}, {}).value.programMcpConnectorKey,
    'custom-iibot',
  )
  assert.equal(
    resolveConfig({}, { INBOX_PROGRAM_MCP_CONNECTOR_KEY: 'custom-iibot' }, {}).value.programMcpConnectorKey,
    'custom-iibot',
  )
  const bad = resolveConfig({ programMcpConnectorKey: 'bad key' }, {}, {})
  assert.ok(bad.errors.some((message) => message.includes('programMcpConnectorKey')))
})
