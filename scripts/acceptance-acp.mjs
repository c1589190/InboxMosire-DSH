#!/usr/bin/env node
/**
 * Real DSH host acceptance for the v2 multi-binding adapter.
 *
 * One ACP server, two sessions: S1 binds app-a, S2 binds app-b through the
 * model-facing `inbox_adapter_bind` tool. The driver pushes one notification to
 * each inbox and verifies that only the matching session is woken, that
 * occupancy follows bind/archive, and that archiving S1 leaves S2 working.
 *
 * Mode A note: no program-owned MCP server is running on this machine, so the
 * wake turns have no business tools; the driver drains the boards through the
 * program's own HTTP client surface (the same calls `InboxClientMcpTools`
 * wraps). The adapter itself never claims or completes anything.
 *
 * Usage: node scripts/acceptance-acp.mjs
 * Exit code 0 means every assertion held; evidence is printed and written to
 * /tmp/inbox-mosire-acp/acceptance.txt.
 */
import { spawn } from 'node:child_process'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readSessionEvents,
  sessionDir,
  wakeMessages,
} from '../test/helpers/session-log.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const API = process.env.INBOX_API_URL ?? 'http://127.0.0.1:18765'
const LIVE = '/home/cna/InboxMosire/.work/live'
const DESCRIPTOR_A = process.env.INBOX_APP_A_BINDING ?? `${LIVE}/bindings/app-a.json`
const DESCRIPTOR_B = process.env.INBOX_APP_B_BINDING ?? `${LIVE}/bindings/app-b.json`
const PROGRAM_A =
  process.env.INBOX_APP_A_PROGRAM_MCP_TOKEN_FILE ?? `${LIVE}/secrets/program-a-mcp.token`
const PROGRAM_B =
  process.env.INBOX_APP_B_PROGRAM_MCP_TOKEN_FILE ?? `${LIVE}/secrets/program-b-mcp.token`
const PROFILE = process.env.INBOX_ACP_PROFILE ?? 'inbox-acp'
const PATCH = join(ROOT, 'test', 'acp-test.patch.yml')
const WORK = process.env.INBOX_ACP_WORK ?? '/tmp/inbox-mosire-acp'
const CWD1 = join(WORK, 'workspace-s1')
const CWD2 = join(WORK, 'workspace-s2')

const descriptorA = JSON.parse(await readFile(DESCRIPTOR_A, 'utf8'))
const descriptorB = JSON.parse(await readFile(DESCRIPTOR_B, 'utf8'))
const programA = (await readFile(PROGRAM_A, 'utf8')).trim()
const programB = (await readFile(PROGRAM_B, 'utf8')).trim()
const wakeA = (await readFile(descriptorA.adapterTokenRef.replace(/^file:/, ''), 'utf8')).trim()
const wakeB = (await readFile(descriptorB.adapterTokenRef.replace(/^file:/, ''), 'utf8')).trim()

/** Collected evidence lines. */
const evidence = []

/**
 * Record one evidence line.
 * @param {string} line - text.
 */
function note(line) {
  evidence.push(line)
  console.log(line)
}

/**
 * Resolve after a delay.
 * @param {number} ms - delay.
 * @returns {Promise<void>} resolved promise.
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll until the predicate holds.
 * @param {string} label - failure label.
 * @param {() => Promise<boolean>|boolean} predicate - condition.
 * @param {number} [timeoutMs] - budget.
 * @returns {Promise<number>} elapsed milliseconds.
 */
async function waitUntil(label, predicate, timeoutMs = 60000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return Date.now() - started
    await delay(250)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

/**
 * Call one InboxMosire HTTP endpoint.
 * @param {string} path - path after the API base.
 * @param {object} options - request options.
 * @returns {Promise<any>} parsed JSON.
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
  const json = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`)
  return json
}

/**
 * Push one notification with a program token.
 * @param {string} inbox - inbox id.
 * @param {string} token - program token.
 * @param {object} input - item fields.
 * @returns {Promise<Record<string, any>>} push response.
 */
function push(inbox, token, input) {
  return call(`/v1/inboxes/${inbox}/items`, {
    token,
    method: 'POST',
    body: {
      channel: 'ticket',
      kind: 'acceptance',
      dedupeKey: `acp-v2:${Date.now()}:${Math.random()}`,
      ...input,
    },
  })
}

/**
 * Claim and complete everything available on one inbox.
 * @param {string} inbox - inbox id.
 * @param {string} token - program token.
 * @returns {Promise<number>} completed count.
 */
async function drain(inbox, token) {
  const list = await call(`/v1/inboxes/${inbox}/items`, { token })
  const ids = (list.items ?? []).map((item) => item.itemId)
  if (ids.length === 0) return 0
  const claimed = await call(`/v1/inboxes/${inbox}/claims`, {
    token,
    method: 'POST',
    body: { itemIds: ids },
  })
  const completions = (claimed.claimed ?? []).map((item) => ({
    claimToken: item.claimToken,
    outcome: 'completed',
    summary: 'acp v2 acceptance driver',
  }))
  if (completions.length > 0) {
    await call(`/v1/inboxes/${inbox}/claims/complete`, {
      token,
      method: 'POST',
      body: { completions },
    })
  }
  return completions.length
}

/**
 * Read occupancy of one inbox.
 * @param {string} inbox - inbox id.
 * @param {string} token - wake token (status:read).
 * @returns {Promise<Record<string, any>>} occupancy.
 */
function occupancy(inbox, token) {
  return call(`/v1/inboxes/${inbox}/occupancy`, { token })
}

/**
 * Read the adapter JSONL log.
 * @returns {Promise<Array<Record<string, any>>>} entries.
 */
async function adapterLog() {
  try {
    const text = await readFile(join(WORK, 'adapter.log'), 'utf8')
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return { message: line }
        }
      })
  } catch {
    return []
  }
}

/**
 * Count adapter log entries matching one message fragment and session.
 * @param {string} fragment - message fragment.
 * @param {string} [session] - session id to require.
 * @returns {Promise<number>} count.
 */
async function logCount(fragment, session) {
  const entries = await adapterLog()
  return entries.filter(
    (entry) =>
      String(entry.message ?? '').includes(fragment) &&
      (session === undefined || String(entry.message ?? '').includes(session)),
  ).length
}

/**
 * Assert one condition.
 * @param {boolean} condition - must hold.
 * @param {string} message - assertion text.
 */
function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
  note(`  ok: ${message}`)
}

/** Minimal ACP JSON-RPC client over the child's stdio. */
class AcpClient {
  /**
   * @param {import('node:stream').Writable} stdin - child stdin.
   * @param {import('node:stream').Readable} stdout - child stdout.
   */
  constructor(stdin, stdout) {
    this.stdin = stdin
    this.pending = new Map()
    this.nextId = 1
    this.buffer = ''
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk) => this.onData(chunk))
  }

  /**
   * Consume stdout bytes.
   * @param {string} chunk - decoded text.
   */
  onData(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      this.onMessage(message)
    }
  }

  /**
   * Route one JSON-RPC frame.
   * @param {Record<string, any>} message - parsed frame.
   */
  onMessage(message) {
    if (message.id !== undefined && message.method) {
      this.onServerRequest(message)
      return
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
      else pending.resolve(message.result)
    }
  }

  /**
   * Answer a server request (auto-allow permissions).
   * @param {Record<string, any>} message - request frame.
   */
  onServerRequest(message) {
    if (message.method === 'session/request_permission') {
      const options = message.params?.options ?? []
      const allow =
        options.find((option) => option.kind === 'allow_once') ??
        options.find((option) => option.kind === 'allow_always') ??
        options[0]
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        result: allow
          ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
          : { outcome: { outcome: 'cancelled' } },
      })
      return
    }
    this.write({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `unsupported client method ${message.method}` },
    })
  }

  /**
   * Write one frame.
   * @param {Record<string, any>} message - frame.
   */
  write(message) {
    this.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /**
   * Send one request.
   * @param {string} method - ACP method.
   * @param {Record<string, any>} params - parameters.
   * @param {number} [timeoutMs] - budget.
   * @returns {Promise<any>} result.
   */
  request(method, params, timeoutMs = 180000) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }
}

/**
 * Prompt one session to bind its descriptor through the adapter tool.
 * @param {AcpClient} acp - ACP client.
 * @param {string} sessionId - session id.
 * @param {Record<string, any>} descriptor - binding descriptor.
 * @returns {Promise<void>} after the bind turn settles.
 */
async function bindThroughTool(acp, sessionId, descriptor) {
  const args = JSON.stringify({
    inboxId: descriptor.inboxId,
    adapterTokenRef: descriptor.adapterTokenRef,
    apiBaseUrl: descriptor.apiBaseUrl,
  })
  const text = [
    'Call the tool `inbox_adapter_bind` exactly once with these arguments:',
    args,
    'Then reply with exactly BIND-OK. Do not call any other tool and do not retry.',
  ].join('\n')
  const result = await acp.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text }],
  })
  note(`bind prompt settled for ${sessionId}: stopReason=${result.stopReason}`)
}

/** Top-level scenario. */
async function main() {
  await rm(WORK, { recursive: true, force: true })
  await mkdir(CWD1, { recursive: true })
  await mkdir(CWD2, { recursive: true })
  await drain('app-a', programA)
  await drain('app-b', programB)
  note(`boards drained: app-a=${(await call('/v1/inboxes/app-a/status', { token: wakeA })).available} app-b=${(await call('/v1/inboxes/app-b/status', { token: wakeB })).available}`)

  const stderr = await open(join(WORK, 'dsh.stderr.log'), 'w')
  const child = spawn('dsh', ['--profile', PROFILE, '--patch', PATCH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  })
  const stderrStream = stderr.createWriteStream()
  child.stderr.pipe(stderrStream)
  const acp = new AcpClient(child.stdin, child.stdout)
  let s1
  let s2
  try {
    note('')
    note('== ACP handshake')
    const init = await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'inbox-mosire-v2-acceptance', version: '0.2.0' },
    })
    note(`initialize ok: protocolVersion=${init.protocolVersion}`)
    s1 = (await acp.request('session/new', { cwd: CWD1, mcpServers: [] })).sessionId
    s2 = (await acp.request('session/new', { cwd: CWD2, mcpServers: [] })).sessionId
    note(`S1=${s1} (app-a)`)
    note(`S2=${s2} (app-b)`)

    note('')
    note('== Bind each session through inbox_adapter_bind')
    await bindThroughTool(acp, s1, descriptorA)
    await bindThroughTool(acp, s2, descriptorB)
    await waitUntil('two binding engines', async () => {
      const events = await adapterLog()
      return (
        events.some((entry) => String(entry.message).includes('启动 binding') && String(entry.message).includes(s1)) &&
        events.some((entry) => String(entry.message).includes('启动 binding') && String(entry.message).includes(s2))
      )
    }, 30000)
    note('adapter started one engine per session')

    const occA = await occupancy('app-a', wakeA)
    const occB = await occupancy('app-b', wakeB)
    note(`occupancy: app-a=${occA.occupiedBy ?? 'none'} app-b=${occB.occupiedBy ?? 'none'}`)
    assert(occA.occupiedBy === s1, 'app-a occupancy names S1')
    assert(occB.occupiedBy === s2, 'app-b occupancy names S2')

    note('')
    note('== Push one notification per inbox')
    const pushedA = await push('app-a', programA, { title: 'v2-acp-a', payload: { side: 'a' } })
    const pushedB = await push('app-b', programB, { title: 'v2-acp-b', payload: { side: 'b' } })
    note(`pushed app-a revision=${pushedA.revision}, app-b revision=${pushedB.revision}`)

    await waitUntil('S1 wake', () => logCount('已投递唤醒', s1), 60000)
    await waitUntil('S2 wake', () => logCount('已投递唤醒', s2), 60000)
    const wakes = (await adapterLog()).filter((entry) => String(entry.message).includes('已投递唤醒'))
    for (const entry of wakes) note(`adapter: ${entry.message}`)
    const s1Wake = wakes.find((entry) => String(entry.message).includes(s1))
    const s2Wake = wakes.find((entry) => String(entry.message).includes(s2))
    assert(s1Wake && s1Wake.message.includes('"inbox":"app-a"'), 'S1 woken for app-a')
    assert(s2Wake && s2Wake.message.includes('"inbox":"app-b"'), 'S2 woken for app-b')
    assert(!wakes.some((entry) => String(entry.message).includes(s1) && String(entry.message).includes('app-b')), 'S1 never receives app-b')
    assert(!wakes.some((entry) => String(entry.message).includes(s2) && String(entry.message).includes('app-a')), 'S2 never receives app-a')

    // Drain the boards, then cancel the autonomous wake turns so both
    // sessions return to idle deterministically before the archive test.
    await drain('app-a', programA)
    await drain('app-b', programB)
    await acp.request('session/cancel', { sessionId: s1 }).catch(() => {})
    await acp.request('session/cancel', { sessionId: s2 }).catch(() => {})
    await delay(2500)
    note('wake turns cancelled; both sessions idle')

    note('')
    note('== Archive S1; S2 must keep working')
    await acp.request('session/close', { sessionId: s1 }, 60000)
    await waitUntil('app-a occupancy cleared', async () => {
      const value = await occupancy('app-a', wakeA)
      return value.occupied === false
    }, 30000)
    const occBAfter = await occupancy('app-b', wakeB)
    assert(occBAfter.occupiedBy === s2, 'app-b still occupied by S2 after S1 archive')

    const wakesBeforeB2 = await logCount('已投递唤醒', s2)
    const s1WakesBeforeB2 = await logCount('已投递唤醒', s1)
    const pushedB2 = await push('app-b', programB, { title: 'v2-acp-b2', payload: { side: 'b2' } })
    await waitUntil('S2 second wake', async () => (await logCount('已投递唤醒', s2)) > wakesBeforeB2, 90000)
    note(`S2 woken again for app-b revision=${pushedB2.revision}`)
    assert(
      (await logCount('已投递唤醒', s1)) === s1WakesBeforeB2,
      'archived S1 receives no further wake',
    )
    await drain('app-b', programB)
    await delay(1500)

    note('')
    note('== Close S2 and inspect durable session logs')
    await acp.request('session/close', { sessionId: s2 }, 60000)
    await waitUntil('app-b occupancy cleared', async () => {
      const value = await occupancy('app-b', wakeB)
      return value.occupied === false
    }, 30000)
    await delay(500)

    const dir1 = await sessionDir(s1, CWD1)
    const dir2 = await sessionDir(s2, CWD2)
    if (!dir1 || !dir2) throw new Error('session log directory missing')
    const wakes1 = wakeMessages(await readSessionEvents(dir1))
    const wakes2 = wakeMessages(await readSessionEvents(dir2))
    note(`S1 wake messages=${wakes1.length}, S2 wake messages=${wakes2.length}`)
    for (const wake of wakes1) {
      const text = wake.data?.content?.[0]?.text ?? ''
      note(`S1 wake seq=${wake.seq}: ${JSON.stringify(text.split('\n')[1] ?? '')}`)
    }
    for (const wake of wakes2) {
      const text = wake.data?.content?.[0]?.text ?? ''
      note(`S2 wake seq=${wake.seq}: ${JSON.stringify(text.split('\n')[1] ?? '')}`)
    }
    assert(wakes1.length >= 1 && wakes1.every((wake) => (wake.data?.content?.[0]?.text ?? '').includes('inbox=app-a')), 'S1 log contains app-a wakes only')
    assert(wakes2.length >= 2 && wakes2.every((wake) => (wake.data?.content?.[0]?.text ?? '').includes('inbox=app-b')), 'S2 log contains app-b wakes only')
    const allText = [...wakes1, ...wakes2]
      .map((wake) => wake.data?.content?.[0]?.text ?? '')
      .join('\n')
    for (const secret of ['v2-acp-a', 'v2-acp-b', 'v2-acp-b2', 'itm_', 'clm_', programA, programB, wakeA, wakeB]) {
      assert(!allText.includes(secret), `wake messages contain no ${secret.slice(0, 10)}…`)
    }
    const finalA = await call('/v1/inboxes/app-a/status', { token: wakeA })
    const finalB = await call('/v1/inboxes/app-b/status', { token: wakeB })
    note(`final: app-a available=${finalA.available} occupied=${finalA.occupied}; app-b available=${finalB.available} occupied=${finalB.occupied}`)
    assert(finalA.available === 0 && finalA.occupied === false, 'app-a left clean')
    assert(finalB.available === 0 && finalB.occupied === false, 'app-b left clean')
    note('')
    note('all v2 assertions passed')
  } finally {
    note('')
    note('== Teardown')
    await acp.request('session/close', { sessionId: s1 }, 10000).catch(() => {})
    await acp.request('session/close', { sessionId: s2 }, 10000).catch(() => {})
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 5000)
      child.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    await stderrStream.end()
    await stderr.close().catch(() => {})
    await writeFile(join(WORK, 'acceptance.txt'), `${evidence.join('\n')}\n`).catch(() => {})
    await drain('app-a', programA).catch(() => {})
    await drain('app-b', programB).catch(() => {})
    await rm(CWD1, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {})
    await rm(CWD2, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {})
  }
}

await main().catch((error) => {
  console.error(`\nACCEPTANCE FAILED: ${error.message}`)
  console.error(`evidence written to ${join(WORK, 'acceptance.txt')}`)
  process.exitCode = 1
})
