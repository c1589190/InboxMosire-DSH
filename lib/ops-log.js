/**
 * Per-session operation log for InboxMosire bindings.
 *
 * One append-only JSONL file records *binding lifecycle* events only: who bound,
 * unbound, suspended, resumed, retried, or failed to start one session's inbox.
 * It never records item content, summaries, wake deliveries, or any credential —
 * the only network fact kept is the inbox `host:port` already shown by the panel.
 *
 * Reads are hard-scoped to one session id: a caller can never observe another
 * session's lines, and there is no cross-session query mode.
 *
 * @module @mosire/dsh-inbox-mosire/lib/ops-log
 */

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

/** Recognized lifecycle actions. */
export const OPS_ACTIONS = ['bind', 'unbind', 'suspend', 'resume', 'retry', 'start', 'stop']

/** Recognized actors; anything else is dropped rather than guessed. */
export const OPS_ACTORS = ['agent', 'user', 'host', 'auto']

/** Default rotation ceiling for one log file. */
export const DEFAULT_MAX_BYTES = 256 * 1024

/** Default number of entries kept per session across rotation. */
export const DEFAULT_PER_SESSION_CAP = 200

/** Longest field lengths kept verbatim; longer values are truncated. */
const LIMITS = {
  session: 200,
  inbox: 200,
  endpoint: 120,
  error: 64,
  reason: 40,
  wakeMode: 32,
}

/**
 * Reduce an API base URL to its `host:port` form.
 *
 * Drops scheme, path, query, and userinfo so an operator-supplied credential
 * embedded in a URL can never reach the log or the panel.
 *
 * @param {unknown} value - descriptor `apiBaseUrl`.
 * @returns {string} `host:port`, or an empty string when unparsable.
 */
export function endpointOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  try {
    return new URL(value.trim()).host
  } catch {
    return ''
  }
}

/**
 * Trim one optional string field.
 * @param {unknown} value - candidate.
 * @param {number} max - longest kept length.
 * @returns {string|undefined} sanitized value.
 */
function field(value, max) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/**
 * Build the on-disk record from a caller-supplied entry.
 *
 * Only whitelisted keys survive: a token, token reference, item text, or any
 * future field added by mistake can never be persisted.
 *
 * @param {Record<string, unknown>} entry - candidate entry.
 * @param {string} at - ISO timestamp stamped by the log.
 * @returns {Record<string, string>|null} sanitized record, or null when invalid.
 */
export function sanitizeEntry(entry, at) {
  if (!entry || typeof entry !== 'object') return null
  const action = OPS_ACTIONS.includes(entry.action) ? entry.action : null
  const actor = OPS_ACTORS.includes(entry.actor) ? entry.actor : null
  const session = field(entry.session, LIMITS.session)
  if (!action || !actor || !session) return null
  const record = { at, action, actor, session }
  const inbox = field(entry.inbox, LIMITS.inbox)
  const endpoint = field(entry.endpoint, LIMITS.endpoint)
  const error = field(entry.error, LIMITS.error)
  const reason = field(entry.reason, LIMITS.reason)
  const wakeMode = field(entry.wakeMode, LIMITS.wakeMode)
  const result = entry.result === 'fail' ? 'fail' : 'ok'
  if (inbox !== undefined) record.inbox = inbox
  if (endpoint !== undefined) record.endpoint = endpoint
  if (wakeMode !== undefined) record.wakeMode = wakeMode
  record.result = result
  if (error !== undefined) record.error = error
  if (reason !== undefined) record.reason = reason
  return record
}

/**
 * Append-only, per-session binding log.
 */
export class OpsLog {
  /**
   * @param {object} options - construction.
   * @param {string} options.file - absolute JSONL path.
   * @param {() => string} [options.now] - ISO clock.
   * @param {number} [options.maxBytes] - rotation ceiling.
   * @param {number} [options.perSessionCap] - entries kept per session.
   * @param {{warn: Function}} [options.logger] - redacting logger.
   */
  constructor({
    file,
    now = () => new Date().toISOString(),
    maxBytes = DEFAULT_MAX_BYTES,
    perSessionCap = DEFAULT_PER_SESSION_CAP,
    logger = null,
  }) {
    if (typeof file !== 'string' || !file.startsWith('/')) {
      throw new Error('OpsLog file 必须是绝对路径')
    }
    this.file = file
    this.now = now
    this.maxBytes = maxBytes
    this.perSessionCap = perSessionCap
    this.logger = logger
    /** @type {Record<string, string>[]|null} */
    this.entries = null
    this.size = 0
  }

  /**
   * Load the file once, keeping only what rotation would keep anyway.
   * @returns {Record<string, string>[]} in-memory entries (oldest first).
   */
  load() {
    if (this.entries) return this.entries
    /** @type {Record<string, string>[]} */
    const parsed = []
    let raw = ''
    try {
      raw = readFileSync(this.file, 'utf8')
      this.size = Buffer.byteLength(raw)
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn?.(`inbox ops log 读取失败: ${error?.code ?? 'error'}`)
      this.size = 0
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const value = JSON.parse(line)
        if (value && typeof value === 'object' && typeof value.session === 'string') {
          parsed.push(value)
        }
      } catch {
        // A torn line from a crash is skipped, never repaired in place.
      }
    }
    this.entries = this.compact(parsed)
    return this.entries
  }

  /**
   * Keep the newest `perSessionCap` entries of every session.
   * @param {Record<string, string>[]} entries - oldest-first entries.
   * @returns {Record<string, string>[]} compacted entries.
   */
  compact(entries) {
    const kept = new Map()
    for (const entry of entries) {
      const bucket = kept.get(entry.session) ?? []
      bucket.push(entry)
      if (bucket.length > this.perSessionCap) bucket.splice(0, bucket.length - this.perSessionCap)
      kept.set(entry.session, bucket)
    }
    const merged = []
    for (const bucket of kept.values()) merged.push(...bucket)
    merged.sort((left, right) => String(left.at).localeCompare(String(right.at)))
    return merged
  }

  /**
   * Append one lifecycle entry.
   * @param {Record<string, unknown>} entry - candidate entry.
   * @returns {Record<string, string>|null} the record written, or null when rejected.
   */
  append(entry) {
    const record = sanitizeEntry(entry, this.now())
    if (!record) return null
    const entries = this.load()
    const line = `${JSON.stringify(record)}\n`
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      appendFileSync(this.file, line, { mode: 0o600 })
      chmodSync(this.file, 0o600)
      this.size += Buffer.byteLength(line)
    } catch (error) {
      this.logger?.warn?.(`inbox ops log 写入失败: ${error?.code ?? 'error'}`)
      return null
    }
    entries.push(record)
    if (entries.length > this.perSessionCap * 4 || this.size > this.maxBytes) this.rotate(entries)
    return record
  }

  /**
   * Rewrite the file with the compacted entries.
   * @param {Record<string, string>[]} entries - newest entries.
   * @returns {void}
   */
  rotate(entries) {
    const compacted = this.compact(entries)
    const body = compacted.map((item) => JSON.stringify(item)).join('\n')
    const text = body === '' ? '' : `${body}\n`
    const temporary = `${this.file}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      writeFileSync(temporary, text, { mode: 0o600 })
      renameSync(temporary, this.file)
      this.size = Buffer.byteLength(text)
      this.entries = compacted
    } catch (error) {
      this.logger?.warn?.(`inbox ops log 轮转失败: ${error?.code ?? 'error'}`)
      this.entries = compacted
    }
  }

  /**
   * Newest-first entries for exactly one session.
   * @param {string} sessionId - authoritative session id.
   * @param {{limit?: number}} [options] - read options.
   * @returns {Record<string, string>[]} entries; empty when unknown or unreadable.
   */
  read(sessionId, { limit = 20 } = {}) {
    const target = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (target === '') return []
    const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20
    const entries = this.load().filter((entry) => entry.session === target)
    return entries.slice(-size).reverse()
  }

  /**
   * Most recent entry for one session, for the panel/status one-liner.
   * @param {string} sessionId - authoritative session id.
   * @returns {Record<string, string>|null} entry or null.
   */
  last(sessionId) {
    return this.read(sessionId, { limit: 1 })[0] ?? null
  }

  /**
   * Current on-disk size, for tests and diagnostics.
   * @returns {number} bytes.
   */
  bytes() {
    try {
      return statSync(this.file).size
    } catch {
      return 0
    }
  }
}
