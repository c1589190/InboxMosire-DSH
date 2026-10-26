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

/** Summary outcomes that may be persisted. */
const SUMMARY_STATES = new Set(['unknown', 'disabled', 'ok', 'empty', 'degraded', 'forbidden'])

/**
 * Build one empty summary-diagnostics record.
 *
 * Only counts, timestamps, and stable codes are stored: item ids and titles
 * never enter the state document.
 * @returns {{state: string, at: string|null, shown: number, remaining: number, code: string|null, message: string|null}} record.
 */
export function emptySummary() {
  return {
    state: 'unknown',
    at: null,
    shown: 0,
    remaining: 0,
    code: null,
    message: null,
  }
}

/**
 * Validate one persisted summary-diagnostics record.
 * @param {unknown} raw - persisted value.
 * @returns {ReturnType<typeof emptySummary>} safe record.
 */
export function normalizeSummary(raw) {
  if (!isRecord(raw)) return emptySummary()
  return {
    state: SUMMARY_STATES.has(raw.state) ? raw.state : 'unknown',
    at: typeof raw.at === 'string' ? raw.at : null,
    shown: nonNegativeInt(raw.shown, 0),
    remaining: nonNegativeInt(raw.remaining, 0),
    code: typeof raw.code === 'string' ? raw.code.slice(0, 80) : null,
    message: typeof raw.message === 'string' ? raw.message.slice(0, 300) : null,
  }
}

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
    summary: emptySummary(),
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
    summary: normalizeSummary(input.summary),
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
   * Load an arbitrary versioned document through a normalizer.
   * @param {(raw: unknown, options?: Record<string, any>) => {state: Record<string, any>, migrated: boolean, warnings: string[]}} normalize - document normalizer.
   * @param {Record<string, any>} [options] - normalizer options.
   * @returns {Promise<{state: Record<string, any>, existed: boolean, migrated: boolean, warnings: string[]}>} loaded document.
   */
  async loadDocument(normalize, options = {}) {
    let text
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { ...normalize(undefined, options), existed: false }
      }
      throw new Error(`状态文件不可读: ${this.file} (${error?.code ?? error})`)
    }
    let raw
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw new Error(`状态文件不是 JSON: ${this.file} (${error.message})`)
    }
    return { ...normalize(raw, options), existed: true }
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
    const write = this.queue.then(async () => {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(temp, text, { mode: 0o600 })
      await chmod(temp, 0o600).catch(() => {})
      await rename(temp, target)
    })
    // Keep the chain alive after a failed write: the caller observes the
    // rejection, while the next write starts from a resolved queue.
    this.queue = write.catch(() => {})
    return write
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

// ---------------------------------------------------------------------------
// v2 host state: one document, one binding per authoritative DSH session.
// ---------------------------------------------------------------------------

/** Host-state version written by this build. */
export const HOST_STATE_VERSION = 2

/** Contract-shaped channel id. */
const SAFE_CHANNEL = /^[A-Za-z0-9._-]{1,64}$/

/**
 * Build an empty v2 host-state document.
 * @returns {Record<string, any>} versioned document.
 */
export function emptyHostState() {
  return {
    version: HOST_STATE_VERSION,
    updatedAt: null,
    bindings: {},
    legacyV1: null,
  }
}

/**
 * Build one empty binding record.
 * @param {string} sessionRef - authoritative DSH session id.
 * @param {object} [descriptor] - validated binding descriptor.
 * @returns {Record<string, any>} binding record.
 */
export function emptyBinding(sessionRef, descriptor = {}) {
  return {
    sessionRef,
    inboxId: descriptor.inboxId ?? '',
    apiBaseUrl: descriptor.apiBaseUrl ?? '',
    adapterTokenRef: descriptor.adapterTokenRef ?? '',
    channels: Array.isArray(descriptor.channels) ? [...descriptor.channels] : [],
    label: descriptor.label ?? '',
    lastEventId: null,
    lastObservedRevision: 0,
    lastWokenRevision: 0,
    lastWake: null,
    pendingWake: null,
    wake: { attempts: 0, stalls: 0, nextWakeAllowedAt: null },
    summary: emptySummary(),
    health: {
      sse: 'idle',
      reconnects: 0,
      lastError: null,
      configError: null,
      session: 'unknown',
      lastEventAt: null,
    },
    lastStatus: null,
    lastReason: null,
    enabled: true,
    blocked: null,
    createdAt: new Date().toISOString(),
    updatedAt: null,
  }
}

/**
 * Validate and normalize one binding record from persisted state.
 *
 * A structurally invalid binding is kept and marked `blocked` instead of being
 * dropped: the operator can see it in status and re-bind it.
 *
 * @param {unknown} raw - persisted binding record.
 * @param {string} sessionRef - key the record was stored under.
 * @returns {Record<string, any>} normalized binding.
 */
export function normalizeBinding(raw, sessionRef) {
  const input = isRecord(raw) ? raw : {}
  const base = emptyBinding(sessionRef)
  const binding = {
    ...base,
    sessionRef,
    inboxId: typeof input.inboxId === 'string' ? input.inboxId : '',
    apiBaseUrl: typeof input.apiBaseUrl === 'string' ? input.apiBaseUrl : '',
    adapterTokenRef:
      typeof input.adapterTokenRef === 'string' ? input.adapterTokenRef : '',
    channels: Array.isArray(input.channels)
      ? input.channels.filter((value) => typeof value === 'string')
      : [],
    label: typeof input.label === 'string' ? input.label.slice(0, 120) : '',
    lastEventId:
      input.lastEventId === null || input.lastEventId === undefined
        ? null
        : nonNegativeInt(input.lastEventId, 0),
    lastObservedRevision: nonNegativeInt(input.lastObservedRevision, 0),
    lastWokenRevision: nonNegativeInt(input.lastWokenRevision, 0),
    lastWake: isRecord(input.lastWake) ? input.lastWake : null,
    pendingWake: isRecord(input.pendingWake) ? input.pendingWake : null,
    summary: normalizeSummary(input.summary),
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
      configError: isRecord(input.health?.configError)
        ? input.health.configError
        : null,
      session: typeof input.health?.session === 'string' ? input.health.session : 'unknown',
      lastEventAt:
        typeof input.health?.lastEventAt === 'string' ? input.health.lastEventAt : null,
    },
    lastStatus: isRecord(input.lastStatus) ? input.lastStatus : null,
    lastReason: typeof input.lastReason === 'string' ? input.lastReason : null,
    enabled: input.enabled !== false,
    blocked: isRecord(input.blocked) ? input.blocked : null,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : base.createdAt,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null,
  }
  if (!binding.inboxId || !SAFE_CHANNEL.test(binding.inboxId)) {
    binding.blocked = { code: 'INVALID_INBOX', message: `inboxId 非法: ${JSON.stringify(binding.inboxId)}` }
  } else if (!isHttpUrl(binding.apiBaseUrl)) {
    binding.blocked = { code: 'INVALID_API_BASE', message: `apiBaseUrl 非法: ${JSON.stringify(binding.apiBaseUrl)}` }
  } else if (!binding.adapterTokenRef) {
    binding.blocked = { code: 'TOKEN_REF_MISSING', message: '缺少 adapterTokenRef' }
  } else if (binding.channels.some((channel) => !SAFE_CHANNEL.test(channel))) {
    binding.blocked = { code: 'INVALID_CHANNEL', message: 'channels 含非法 id' }
  }
  return binding
}

/**
 * Whether a string is an http(s) URL without embedded credentials.
 * @param {unknown} value - candidate.
 * @returns {boolean} true when usable as an API base.
 */
export function isHttpUrl(value) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}

/**
 * Normalize or migrate a host-state document.
 *
 * v1 (single binding) is preserved verbatim under `legacyV1`; when it names a
 * session and the caller supplies legacy endpoint defaults, that session is
 * migrated into a real binding. Nothing is silently discarded.
 *
 * @param {unknown} raw - persisted document.
 * @param {{legacyDefaults?: {inboxId?: string, apiBaseUrl?: string, adapterTokenRef?: string}}} [options] - migration defaults.
 * @returns {{state: Record<string, any>, migrated: boolean, warnings: string[]}} normalized document.
 * @throws {Error} for an unsupported newer version or a non-object document.
 */
export function normalizeHostState(raw, { legacyDefaults = {} } = {}) {
  if (raw === null || raw === undefined) {
    return { state: emptyHostState(), migrated: false, warnings: [] }
  }
  if (!isRecord(raw)) {
    return {
      state: emptyHostState(),
      migrated: true,
      warnings: ['状态文件不是对象，已重建'],
    }
  }
  const version = nonNegativeInt(raw.version, 0)
  if (version > HOST_STATE_VERSION) {
    throw new Error(
      `状态文件版本 ${version} 高于本适配器支持的 ${HOST_STATE_VERSION}；拒绝覆盖未知状态`,
    )
  }
  const warnings = []
  const state = emptyHostState()

  if (version >= 2) {
    state.legacyV1 = isRecord(raw.legacyV1) ? raw.legacyV1 : null
    for (const [sessionRef, record] of Object.entries(
      isRecord(raw.bindings) ? raw.bindings : {},
    )) {
      if (typeof sessionRef !== 'string' || sessionRef.length === 0) {
        warnings.push('忽略空 session key 的 binding')
        continue
      }
      const binding = normalizeBinding(record, sessionRef)
      if (binding.blocked) {
        warnings.push(`${sessionRef}: ${binding.blocked.code} ${binding.blocked.message}`)
      }
      state.bindings[sessionRef] = binding
    }
    return { state, migrated: version !== HOST_STATE_VERSION, warnings }
  }

  // v1 or unversioned single-binding document.
  state.legacyV1 = { ...raw }
  warnings.push('v1 单 binding 状态已迁移到 v2')
  const sessionRef = typeof raw.sessionRef === 'string' ? raw.sessionRef : ''
  if (sessionRef) {
    const binding = normalizeBinding(
      {
        ...raw,
        inboxId: raw.inboxId ?? legacyDefaults.inboxId,
        apiBaseUrl: raw.apiBaseUrl ?? legacyDefaults.apiBaseUrl,
        adapterTokenRef: raw.adapterTokenRef ?? legacyDefaults.adapterTokenRef,
      },
      sessionRef,
    )
    if (binding.blocked) {
      warnings.push(
        `${sessionRef}: v1 binding 无法迁移 (${binding.blocked.code}); legacyV1 已保留`,
      )
    }
    state.bindings[sessionRef] = binding
  }
  return { state, migrated: true, warnings }
}
