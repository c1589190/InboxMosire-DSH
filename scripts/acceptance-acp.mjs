#!/usr/bin/env node
/**
 * Real DSH host acceptance: boot the shipped ACP profile with the InboxMosire
 * adapter, drive one session through the standard ACP stdio surface, push
 * notifications while a turn is active, and verify the wake actually reached
 * the model and produced a claim/complete loop.
 *
 * Usage: node scripts/acceptance-acp.mjs [--keep]
 *
 * Exit code 0 means every assertion held. Evidence is printed and also written
 * to /tmp/inbox-mosire-acp/.
 */
import { spawn } from 'node:child_process'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpClient } from '../test/helpers/mcp.mjs'
import {
  readSessionEvents,
  sessionDir,
  toolCalls,
  wakeMessages,
} from '../test/helpers/session-log.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BACKEND = process.env.INBOX_API_URL ?? 'http://127.0.0.1:18765'
const MCP_URL = process.env.INBOX_MCP_URL ?? 'http://127.0.0.1:18766/mcp'
const INBOX = process.env.INBOX_SMOKE_INBOX_ID ?? 'smoke'
const TOKEN_FILE =
  process.env.INBOX_SMOKE_ADAPTER_TOKEN_FILE ??
  '/home/cna/InboxMosire/.work/live/secrets/dsh-smoke-adapter.token'
const PRODUCER_FILE =
  process.env.INBOX_SMOKE_PRODUCER_TOKEN_FILE ??
  '/home/cna/InboxMosire/.work/live/secrets/smoke-producer.token'
const PROFILE = process.env.INBOX_ACP_PROFILE ?? 'inbox-acp'
const PATCH = join(ROOT, 'test', 'acp-test.patch.yml')
const WORK = process.env.INBOX_ACP_WORK ?? '/tmp/inbox-mosire-acp'
const CWD = join(WORK, 'workspace')
const KEEP = process.argv.includes('--keep')

const adapterToken = (await readFile(TOKEN_FILE, 'utf8')).trim()
const producerToken = (await readFile(PRODUCER_FILE, 'utf8')).trim()

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
 * @param {() => Promise<boolean>} predicate - async condition.
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
 * Read the current board status with the adapter token.
 * @returns {Promise<Record<string, any>>} status document.
 */
async function boardStatus() {
  const response = await fetch(`${BACKEND}/v1/inboxes/${INBOX}/status`, {
    headers: { Authorization: `Bearer ${adapterToken}` },
  })
  if (!response.ok) throw new Error(`status HTTP ${response.status}`)
  return response.json()
}

/**
 * Push one notification through the producer endpoint.
 * @param {object} input - push fields.
 * @returns {Promise<Record<string, any>>} push response.
 */
async function push({ channel = 'ticket', title, payload }) {
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
      dedupeKey: `acp:${Date.now()}:${Math.random()}`,
    }),
  })
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`push HTTP ${response.status}: ${await response.text()}`)
  }
  return response.json()
}

/**
 * Read the adapter's JSONL log.
 * @returns {Promise<Array<Record<string, any>>>} log entries.
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
 * Minimal ACP JSON-RPC client over the child's stdio.
 */
class AcpClient {
  /**
   * @param {import('node:stream').Writable} stdin - child stdin.
   * @param {import('node:stream').Readable} stdout - child stdout.
   */
  constructor(stdin, stdout) {
    this.stdin = stdin
    this.pending = new Map()
    this.nextId = 1
    this.updates = []
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
   * Route one JSON-RPC message.
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
      return
    }
    if (message.method === 'session/update') {
      this.updates.push(message.params)
      return
    }
  }

  /**
   * Answer a server-to-client request.
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
   * @param {Record<string, any>} message - JSON-RPC frame.
   */
  write(message) {
    this.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /**
   * Send one request.
   * @param {string} method - ACP method.
   * @param {Record<string, any>} params - parameters.
   * @param {number} [timeoutMs] - response budget.
   * @returns {Promise<any>} result.
   */
  request(method, params, timeoutMs = 120000) {
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

/** Print a section header. */
function section(title) {
  note('')
  note(`== ${title}`)
}

/** Top-level scenario. */
async function main() {
  await rm(WORK, { recursive: true, force: true })
  await mkdir(CWD, { recursive: true })

  const mcp = new McpClient(MCP_URL)
  await mcp.init()
  await mcp.drain(INBOX)
  const baseline = await boardStatus()
  note(`board baseline: revision=${baseline.revision} available=${baseline.available} claimed=${baseline.claimed}`)
  if (baseline.available !== 0) throw new Error('smoke board is not empty before the run')
  if (baseline.claimed > 0) {
    note(`warning: ${baseline.claimed} claim lease(s) from an earlier run are still open; they expire on their own`)
  }

  const stderr = await open(join(WORK, 'dsh.stderr.log'), 'w')
  const child = spawn('dsh', ['--profile', PROFILE, '--patch', PATCH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  })
  const stderrStream = stderr.createWriteStream()
  child.stderr.pipe(stderrStream)
  const acp = new AcpClient(child.stdin, child.stdout)
  let sessionId
  try {
    section('ACP handshake')
    const init = await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'inbox-mosire-acceptance', version: '0.1.0' },
    })
    note(`initialize ok: protocolVersion=${init.protocolVersion}`)

    const created = await acp.request('session/new', {
      cwd: CWD,
      mcpServers: [
        { name: 'inbox-mosire', type: 'http', url: MCP_URL, headers: [] },
      ],
    })
    sessionId = created.sessionId
    note(`session/new: ${sessionId}`)

    section('Adapter binding')
    const bindWait = await waitUntil('adapter binding', async () => {
      const log = await adapterLog()
      return log.some((entry) => /绑定|已绑定/.test(entry.message ?? ''))
    }, 30000)
    note(`adapter bound after ${bindWait}ms`)
    const boundLog = (await adapterLog()).filter((entry) => /绑定/.test(entry.message ?? ''))
    for (const entry of boundLog.slice(0, 3)) note(`adapter: ${entry.message}`)

    section('Active turn with pushes')
    const promptText = [
      'Use the bash tool to run exactly `sleep 8`.',
      'When it finishes, reply with exactly DONE.',
      'Do not call any other tool.',
    ].join(' ')
    const promptPromise = acp.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: promptText }] },
      180000,
    )
    await delay(1200)
    const running1 = await boardStatus()
    const p1 = await push({ title: 'acp-active-1', payload: { secret: 'SECRET-ACP-1' } })
    note(`pushed #1 while active: revision=${p1.revision} available=${running1.available + 1} at +1.2s`)
    await delay(1500)
    const p2 = await push({ title: 'acp-active-2', payload: { secret: 'SECRET-ACP-2' } })
    note(`pushed #2 while active: revision=${p2.revision} at +2.7s`)
    const promptResult = await promptPromise
    note(`first prompt settled: stopReason=${promptResult.stopReason}`)

    section('Wake at turn end')
    const wakeWait = await waitUntil('adapter wake delivery', async () => {
      const log = await adapterLog()
      return log.some((entry) => /已投递唤醒/.test(entry.message ?? ''))
    }, 60000)
    note(`adapter delivered a wake ${wakeWait}ms after the first prompt settled`)
    for (const entry of (await adapterLog()).filter((line) => /唤醒/.test(line.message ?? ''))) {
      note(`adapter: ${entry.message}`)
    }

    section('Agent claim / complete loop')
    const drainWait = await waitUntil('agent to claim and complete', async () => {
      const status = await boardStatus()
      return (
        status.revision > p2.revision &&
        status.available === 0 &&
        status.claimed <= baseline.claimed
      )
    }, 180000)
    const finalStatus = await boardStatus()
    note(`board drained ${drainWait}ms after the wake: revision=${finalStatus.revision} available=${finalStatus.available} claimed=${finalStatus.claimed}`)

    section('Archived session receives no wake')
    await acp.request('session/close', { sessionId }, 30000)
    const archiveWait = await waitUntil('adapter to observe the disposed session', async () => {
      const log = await adapterLog()
      return log.some((entry) => /已卸载或归档|停止投递/.test(entry.message ?? ''))
    }, 20000)
    note(`adapter stopped delivery ${archiveWait}ms after session/close`)
    const wakesBeforeArchive = (await adapterLog()).filter((entry) =>
      /已投递唤醒/.test(entry.message ?? ''),
    ).length
    const archivedPush = await push({
      title: 'acp-archived',
      payload: { secret: 'SECRET-ACP-ARCHIVED' },
    })
    note(`pushed revision=${archivedPush.revision} after the session was closed`)
    await delay(3000)
    const wakesAfterArchive = (await adapterLog()).filter((entry) =>
      /已投递唤醒/.test(entry.message ?? ''),
    ).length
    assert(
      wakesAfterArchive === wakesBeforeArchive,
      'an archived session is never woken',
    )
    const afterArchiveStatus = await boardStatus()
    assert(
      afterArchiveStatus.available >= 1,
      'the pushed item stayed on the board (nobody consumed it)',
    )
    await mcp.drain(INBOX)
    note(`drained the archived-session notification(s): available=${(await boardStatus()).available}`)

    section('Durable session log')
    await delay(500)
    const directory = await sessionDir(sessionId, CWD)
    if (!directory) throw new Error('session directory not found')
    const events = await readSessionEvents(directory)
    const wakes = wakeMessages(events)
    const calls = toolCalls(events)
    const turnEnds = events.filter((event) => event.type === 'turn/end')
    note(`log: ${events.length} records from ${directory}`)
    note(`log: turn/end count=${turnEnds.length}`)
    note(`log: inbox-mosire wake messages=${wakes.length}`)
    for (const wake of wakes) {
      note(`log: wake seq=${wake.seq} text=${JSON.stringify(wake.data?.content?.[0]?.text ?? '')}`)
    }
    const inboxTools = calls.filter((call) => /inbox_/.test(call.data?.name ?? ''))
    note(`log: tool calls=${calls.map((call) => call.data?.name).join(',')}`)
    note(`log: inbox tool calls=${inboxTools.length} (${inboxTools.map((call) => call.data?.name).join(',')})`)

    section('Assertions')
    assert(wakes.length === 1, `exactly one wake message, got ${wakes.length}`)
    assert(
      turnEnds.length >= 2,
      `at least two turns (initial + wake), got ${turnEnds.length}`,
    )
    const firstTurnEnd = turnEnds[0].seq
    assert(
      wakes[0].seq > firstTurnEnd,
      `wake seq ${wakes[0].seq} must follow the first turn end ${firstTurnEnd}`,
    )
    assert(
      inboxTools.some((call) => call.data?.name?.includes('inbox_list')),
      'the agent called inbox_list after the wake',
    )
    assert(
      inboxTools.some((call) => call.data?.name?.includes('inbox_claim')),
      'the agent called inbox_claim after the wake',
    )
    assert(
      inboxTools.some((call) => call.data?.name?.includes('inbox_complete')),
      'the agent called inbox_complete after the wake',
    )
    assert(finalStatus.available === 0, 'the board is empty')
    const wakeText = JSON.stringify(wakes)
    for (const secret of ['SECRET-ACP-1', 'SECRET-ACP-2', 'acp-active-1', 'acp-active-2', adapterToken, producerToken]) {
      assert(!wakeText.includes(secret), `wake message must not contain ${secret.slice(0, 12)}…`)
    }
    note('all assertions passed')
  } finally {
    section('Teardown')
    await acp.request('session/close', { sessionId }, 10000).catch(() => {})
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
    await mcp.close().catch(() => {})
    await writeFile(join(WORK, 'acceptance.txt'), `${evidence.join('\n')}\n`)
    if (!KEEP) {
      // Keep the evidence directory; the workspace is disposable.
      await rm(CWD, { recursive: true, force: true }).catch(() => {})
      await mkdir(CWD, { recursive: true }).catch(() => {})
    }
  }
}

/**
 * Assert one condition.
 * @param {boolean} condition - must be true.
 * @param {string} message - failure text.
 */
function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
  note(`  ok: ${message}`)
}

await main().catch((error) => {
  console.error(`\nACCEPTANCE FAILED: ${error.message}`)
  console.error(`evidence written to ${join(WORK, 'acceptance.txt')}`)
  process.exitCode = 1
})
