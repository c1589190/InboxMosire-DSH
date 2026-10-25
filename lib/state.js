/**
 * Durable adapter state: binding, SSE cursor, revision watermarks, and the
 * one-wake ledger.
 *
 * Storage is one JSON document written atomically (`tmp` + `rename`, mode
 * 0600) under `$DSH_HOME/inbox-mosire/state.json` by default. It never contains
 * the API token, an item title, or an item payload.
 *
 * @module @mosire/dsh-inbox-mosire/lib/state
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** State document version written by this build. */
export const STATE_VERSION = 1

/**
 * Build the empty state document for one binding target.
 * @param {object} options - initial values.
 * @param {string} options.inboxId - inbox the adapter is configured for.
 * @param {string[]} options.channels - configured channels.
 * @returns {Record<string, any>} a complete, versioned state document.
 */
export function emptyState({ inboxId, channels }) {
  return {
    version: STATE_VERSION,
    inboxId,
    sessionRef: '',
    channels: [...channels],
    lastEventId: null,
    lastObservedRevision: 0,
    lastWokenRevision: 0,
    enabled: true,
    updatedAt: null,
    lastStatus: null,
    lastWake: null,
    pendingWake: null,
    wake: { attempts: 0, stalls: 0, nextWakeAllowedAt: null },
    health: {
      sse: 'idle',
      sseConnectedAt: null,
      reconnects: 0,
      lastEventAt: null,
      lastError: null,
      configError: null,
    },
  }
}

/**
 * Coerce a non-negative integer with a fallback.
 * @param {unknown} value - candidate.
 * @param {number} fallback - value when absent or invalid.
 * @returns {number} the coerced integer.
 */
function nonNegativeInt(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0) return fallback
  return Math.trunc(number)
}

/**
 * Whether a persisted value is a plain JSON object.
 * @param {unknown} value - candidate.
 * @returns {boolean} true for a non-null, non-array object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate and migrate one persisted state document.
 *
 * Unknown fields are dropped; a document from another inbox is refused so a
 * cursor from one board is never applied to another.
 *
 * @param {unknown} raw - parsed JSON document.
 * @param {{inboxId: string, channels: string[]}} expected - current configuration.
 * @returns {{state: Record<string, any>, migrated: boolean, warning?: string}}
 * @throws {Error} when the document belongs to a different inbox.
 */
export function normalizeState(raw, expected) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: emptyState(expected), migrated: true, warning: '状态文件不是对象，已重建' }
  }
  const input = /** @type {Record<string, any>} */ (raw)
  const version = nonNegativeInt(input.version, 0)
  if (version > STATE_VERSION) {
    throw new Error(
      `状态文件版本 ${version} 高于本适配器支持的 ${STATE_VERSION}；拒绝覆盖未知状态`,
    )
  }
  if (input.inboxId !== undefined && input.inboxId !== expected.inboxId) {
    throw new Error(
      `状态文件属于 inbox ${JSON.stringify(input.inboxId)}，而当前配置是 ${JSON.stringify(expected.inboxId)}`,
    )
  }

  const base = emptyState(expected)
  const state = {
    ...base,
    version: STATE_VERSION,
    inboxId: expected.inboxId,
    sessionRef: typeof input.sessionRef === 'string' ? input.sessionRef : '',
    channels: Array.isArray(input.channels)
      ? input.channels.filter((value) => typeof value === 'string')
      : expected.channels,
    lastEventId:
      input.lastEventId === null || input.lastEventId === undefined
        ? null
        : nonNegativeInt(input.lastEventId, 0),
    lastObservedRevision: nonNegativeInt(input.lastObservedRevision, 0),
    lastWokenRevision: nonNegativeInt(input.lastWokenRevision, 0),
    enabled: input.enabled !== false,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null,
    lastStatus: isRecord(input.lastStatus) ? input.lastStatus : null,
    lastWake: isRecord(input.lastWake) ? input.lastWake : null,
    pendingWake: isRecord(input.pendingWake) ? input.pendingWake : null,
    wake: {
      attempts: nonNegativeInt(input.wake?.attempts, 0),
      stalls: nonNegativeInt(input.wake?.stalls, 0),
      nextWakeAllowedAt:
        input.wake?.nextWakeAllowedAt === null || input.wake?.nextWakeAllowedAt === undefined
          ? null
          : nonNegativeInt(input.wake.nextWakeAllowedAt, 0) || null,
    },
    health: {
      ...base.health,
      sse: 'idle',
      reconnects: nonNegativeInt(input.health?.reconnects, 0),
      lastError: isRecord(input.health?.lastError) ? input.health.lastError : null,
      configError: isRecord(input.health?.configError) ? input.health.configError : null,
    },
  }
  return { state, migrated: version !== STATE_VERSION }
}

/**
 * One atomic JSON state file with debounced persistence.
 */
export class StateStore {
  /**
   * @param {object} options - store construction.
   * @param {string} options.file - absolute path of the state document.
   * @param {number} [options.debounceMs] - coalescing window for `save`.
   * @param {{warn: Function, error: Function}} [options.logger] - failure sink.
   */
  constructor({ file, debounceMs = 200, logger }) {
    this.file = file
    this.debounceMs = debounceMs
    this.logger = logger
    this.timer = null
    this.queue = Promise.resolve()
    this.closed = false
    this.dirty = false
  }

  /**
   * Load the persisted state, or an empty one when the file is absent.
   * @param {{inboxId: string, channels: string[]}} expected - current configuration.
   * @returns {Promise<{state: Record<string, any>, existed: boolean, migrated: boolean, warning?: string}>} loaded state.
   */
  async load(expected) {
    let text
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { state: emptyState(expected), existed: false, migrated: false }
      }
      throw new Error(`状态文件不可读: ${this.file} (${error?.code ?? error})`)
    }
    let raw
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw new Error(`状态文件不是 JSON: ${this.file} (${error.message})`)
    }
    const normalized = normalizeState(raw, expected)
    return { ...normalized, existed: true }
  }

  /**
   * Persist the state document atomically.
   * @param {Record<string, any>} state - complete state document.
   * @returns {Promise<void>} after the rename.
   */
  async writeNow(state) {
    if (this.closed) return
    state.updatedAt = new Date().toISOString()
    const text = `${JSON.stringify(state, null, 2)}\n`
    const target = this.file
    const temp = `${target}.${process.pid}.tmp`
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(temp, text, { mode: 0o600 })
      await chmod(temp, 0o600).catch(() => {})
      await rename(temp, target)
    })
    return this.queue
  }

  /**
   * Schedule persistence within the debounce window.
   * @param {Record<string, any>} state - complete state document.
   */
  save(state) {
    this.dirty = true
    this.current = state
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.dirty || !this.current) return
      this.dirty = false
      this.writeNow(this.current).catch((error) => {
        this.logger?.warn(`状态写入失败: ${this.file} (${error?.code ?? error})`)
      })
    }, this.debounceMs)
    this.timer.unref?.()
  }

  /**
   * Write any pending state immediately.
   * @param {Record<string, any>} [state] - document to write instead of the pending one.
   * @returns {Promise<void>} after the write settles.
   */
  async flush(state) {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.dirty = false
    const document = state ?? this.current
    if (!document) return this.queue
    await this.writeNow(document).catch((error) => {
      this.logger?.warn(`状态写入失败: ${this.file} (${error?.code ?? error})`)
    })
    await this.queue
  }

  /** Flush and refuse further writes. */
  async close(state) {
    await this.flush(state)
    this.closed = true
  }
}
