/**
 * v2 multi-binding manager: one DSH host, many sessions, one binding each.
 *
 * The manager owns the versioned host-state document, the per-session token
 * references, and the advisory occupancy mark. Each session gets its own
 * `InboxAdapter` engine instance (SSE, cursor, revision watermarks, wake
 * dedupe, backoff), so bindings cannot share or leak state.
 *
 * @module @mosire/dsh-inbox-mosire/lib/manager
 */
import { InboxAdapter, summarizeStatus } from './adapter.js'
import {
  BindingError,
  displayTokenRef,
  loadBindingToken,
  validateDescriptor,
} from './bindings.js'
import { InboxClient } from './inbox-client.js'
import { emptyBinding, emptySummary, HOST_STATE_VERSION } from './state.js'

/**
 * One bindable wake target.
 */
export class BindingManager {
  /**
   * @param {object} options - construction.
   * @param {Record<string, any>} options.config - resolved global configuration.
   * @param {{info: Function, warn: Function, error: Function, addSecret?: Function}} options.logger - redacting logger.
   * @param {object} options.store - StateStore.
   * @param {Record<string, any>} options.state - normalized v2 host state.
   * @param {{getAgent: Function, listAgents: Function, isIdle: Function, followup: Function, now: Function}} options.host - host callbacks.
   */
  constructor({ config, logger, store, state, host }) {
    this.config = config
    this.logger = logger
    this.store = store
    this.state = state
    this.host = host
    /** @type {Map<string, InboxAdapter>} */
    this.engines = new Map()
    /** @type {Map<string, InboxClient>} */
    this.clients = new Map()
    this.stopping = false
    this.bindingStore = {
      save: () => this.persist(),
      flush: async () => {
        await this.flush()
      },
      close: async () => {
        await this.flush()
      },
    }
  }

  /**
   * Start every enabled, non-blocked binding.
   * @returns {Promise<void>} after each binding has been attempted.
   */
  async start() {
    this.stopping = false
    for (const binding of Object.values(this.state.bindings)) {
      await this.startBinding(binding, 'startup')
    }
    await this.flush()
  }

  /**
   * Stop every engine and flush the document.
   * @returns {Promise<void>} after shutdown.
   */
  async stop() {
    this.stopping = true
    for (const sessionRef of [...this.engines.keys()]) {
      await this.stopBinding(sessionRef, 'stopped')
    }
    await this.flush()
  }

  /**
   * Bind one session from a validated descriptor.
   *
   * The token is loaded before anything is persisted: an unreadable or
   * relative reference fails the bind and leaves the previous binding intact.
   *
   * @param {object} options - bind request.
   * @param {string} options.sessionId - target authoritative session id.
   * @param {unknown} options.descriptor - BindingDescriptor fields.
   * @returns {Promise<{ok: boolean, message: string, status: string}>} outcome.
   */
  async bind({ sessionId, descriptor }) {
    const target = String(sessionId ?? '').trim()
    if (!target) {
      return { ok: false, message: 'sessionId 必填（默认使用调用者 session）', status: this.statusText('') }
    }
    let validated
    try {
      validated = validateDescriptor(descriptor, { defaultApiBaseUrl: this.config.apiUrl })
    } catch (error) {
      if (error instanceof BindingError) {
        return { ok: false, message: `${error.code}: ${error.message}`, status: this.statusText(target) }
      }
      throw error
    }
    let loaded
    try {
      loaded = await loadBindingToken(validated.adapterTokenRef)
    } catch (error) {
      if (error instanceof BindingError) {
        return {
          ok: false,
          message: `${error.code}: ${error.message}`,
          status: this.statusText(target),
        }
      }
      throw error
    }
    if (loaded.warning) this.logger.warn(loaded.warning)
    this.logger.addSecret?.(loaded.token)

    const existing = this.state.bindings[target]
    const sameInbox =
      existing !== undefined &&
      existing.inboxId === validated.inboxId &&
      existing.apiBaseUrl === validated.apiBaseUrl
    if (existing) {
      if (!sameInbox) await this.clearOccupancy(existing)
      await this.stopBinding(target, 'rebind')
    }

    const binding = existing ?? emptyBinding(target)
    if (!sameInbox) {
      binding.lastEventId = null
      binding.lastObservedRevision = 0
      binding.lastWokenRevision = 0
      binding.lastWake = null
      binding.pendingWake = null
      binding.wake = { attempts: 0, stalls: 0, nextWakeAllowedAt: null }
      binding.lastStatus = null
    }
    binding.sessionRef = target
    binding.inboxId = validated.inboxId
    binding.apiBaseUrl = validated.apiBaseUrl
    binding.adapterTokenRef = validated.adapterTokenRef
    binding.channels = validated.channels
    binding.label = validated.label
    binding.blocked = null
    binding.enabled = true
    binding.summary = emptySummary()
    binding.health.configError = null
    binding.health.lastError = null
    binding.health.occupancy = null
    binding.health.session = this.host.getAgent(target) ? 'live' : 'not-live'
    binding.updatedAt = new Date().toISOString()
    this.state.bindings[target] = binding
    await this.flush()

    this.logger.info('绑定 session', {
      session: target,
      inbox: binding.inboxId,
      apiBaseUrl: binding.apiBaseUrl,
      channels: binding.channels,
      replaced: existing !== undefined,
      resetCursor: !sameInbox,
    })
    await this.startBinding(binding, 'bind', loaded)
    return {
      ok: true,
      message: `已绑定 ${target} → ${binding.inboxId}`,
      status: this.statusText(target),
    }
  }

  /**
   * Remove one session's binding and clear its advisory occupancy.
   * @param {string} sessionId - target session.
   * @returns {Promise<{ok: boolean, message: string}>} outcome.
   */
  async unbind(sessionId) {
    const target = String(sessionId ?? '').trim()
    const binding = this.state.bindings[target]
    if (!binding) return { ok: true, message: `本来未绑定 ${target || '(空 session)'}` }
    await this.stopBinding(target, 'unbind')
    await this.clearOccupancy(binding)
    delete this.state.bindings[target]
    await this.flush()
    this.logger.info('已解绑 session', { session: target, inbox: binding.inboxId })
    return { ok: true, message: `已解绑 ${target}（${binding.inboxId}）` }
  }

  /**
   * Reload tokens and restart one or every binding (token rotation path).
   * @param {string} [sessionId] - target session; all bindings when omitted.
   * @returns {Promise<{ok: boolean, message: string}>} outcome.
   */
  async retry(sessionId) {
    const targets = sessionId
      ? [String(sessionId)]
      : Object.keys(this.state.bindings)
    if (targets.length === 0) return { ok: true, message: '没有可重试的 binding' }
    for (const target of targets) {
      const binding = this.state.bindings[target]
      if (!binding) continue
      await this.stopBinding(target, 'retry')
      binding.summary = emptySummary()
      binding.health.configError = null
      binding.health.occupancy = null
      await this.startBinding(binding, 'retry')
    }
    await this.flush()
    return { ok: true, message: `已重试 ${targets.length} 个 binding` }
  }

  /**
   * Start one binding engine: load its token, build its client, then run the
   * status-then-SSE sequence.
   * @param {Record<string, any>} binding - binding record.
   * @param {string} reason - trigger label.
   * @param {{token: string}} [preloaded] - already-loaded token (bind path).
   * @returns {Promise<boolean>} whether the engine started.
   */
  async startBinding(binding, reason, preloaded) {
    if (this.stopping) return false
    if (binding.enabled === false) {
      this.logger.info('binding 已停用，跳过启动', { session: binding.sessionRef })
      return false
    }
    if (binding.blocked) {
      this.logger.warn('binding 被阻塞，拒绝启动', {
        session: binding.sessionRef,
        code: binding.blocked.code,
        message: binding.blocked.message,
      })
      return false
    }
    let token
    try {
      const loaded = preloaded ?? (await loadBindingToken(binding.adapterTokenRef))
      token = loaded.token
      if (loaded.warning) this.logger.warn(loaded.warning)
      this.logger.addSecret?.(token)
    } catch (error) {
      const message = error instanceof BindingError ? `${error.code}: ${error.message}` : String(error)
      binding.health.configError = {
        code: error?.code ?? 'TOKEN_REF',
        message: message.slice(0, 300),
        at: new Date().toISOString(),
      }
      this.logger.error('binding token 不可用，拒绝唤醒', {
        session: binding.sessionRef,
        error: message.slice(0, 300),
      })
      this.persist()
      return false
    }

    const client = new InboxClient({
      apiUrl: binding.apiBaseUrl,
      inboxId: binding.inboxId,
      channels: binding.channels,
      token,
      requestTimeoutMs: this.config.requestTimeoutMs,
      maxResponseBytes: this.config.maxResponseBytes,
    })
    this.clients.set(binding.sessionRef, client)

    const engine = new InboxAdapter({
      config: {
        ...this.config,
        apiUrl: binding.apiBaseUrl,
        inboxId: binding.inboxId,
        channels: binding.channels,
        sessionId: binding.sessionRef,
        autoBind: false,
        enabled: binding.enabled !== false,
      },
      configErrors: [],
      token,
      logger: this.logger,
      store: this.bindingStore,
      state: binding,
      client,
      host: this.host,
      tokenSource: { kind: 'file' },
    })
    this.engines.set(binding.sessionRef, engine)
    this.logger.info('启动 binding', {
      session: binding.sessionRef,
      inbox: binding.inboxId,
      cursor: binding.lastEventId,
      reason,
    })
    await engine.start()
    if (this.host.getAgent(binding.sessionRef)) {
      await this.putOccupancy(binding, client)
    } else {
      this.logger.info('binding 已持久化，等待 session resume 后再标记 occupancy', {
        session: binding.sessionRef,
      })
    }
    return true
  }

  /**
   * Stop one binding engine.
   * @param {string} sessionRef - session id.
   * @param {string} reason - trigger label.
   * @returns {Promise<void>} after the engine settles.
   */
  async stopBinding(sessionRef, reason) {
    const engine = this.engines.get(sessionRef)
    this.engines.delete(sessionRef)
    this.clients.delete(sessionRef)
    if (!engine) return
    this.logger.info('停止 binding', { session: sessionRef, reason })
    await engine.stop().catch((error) => {
      this.logger.warn('停止 binding 失败', {
        session: sessionRef,
        error: String(error?.message ?? error).slice(0, 200),
      })
    })
  }

  /**
   * Mark the inbox as occupied by one session (advisory, best effort).
   * @param {Record<string, any>} binding - binding record.
   * @param {InboxClient} client - binding client.
   * @returns {Promise<void>} after the attempt.
   */
  async putOccupancy(binding, client) {
    try {
      const result = await client.putOccupancy(binding.sessionRef)
      binding.health.occupancy = {
        state: 'occupied',
        occupiedBy: result?.occupiedBy ?? binding.sessionRef,
        occupiedAt: result?.occupiedAt ?? null,
        at: new Date().toISOString(),
      }
    } catch (error) {
      const forbidden = error?.code === 'INBOX_AUTH'
      binding.health.occupancy = {
        state: forbidden ? 'not-authorized' : 'failed',
        message: forbidden
          ? 'token 缺少 inbox:occupy（advisory 标记跳过）'
          : String(error?.message ?? error).slice(0, 200),
        at: new Date().toISOString(),
      }
      this.logger.warn('occupancy PUT 未生效（advisory，不影响唤醒）', {
        session: binding.sessionRef,
        inbox: binding.inboxId,
        code: error?.code,
        message: binding.health.occupancy.message,
      })
    }
    this.persist()
  }

  /**
   * Clear the advisory occupancy mark for one binding (best effort).
   * @param {Record<string, any>} binding - binding record.
   * @returns {Promise<void>} after the attempt.
   */
  async clearOccupancy(binding) {
    let client = this.clients.get(binding.sessionRef)
    if (!client) {
      try {
        const loaded = await loadBindingToken(binding.adapterTokenRef)
        client = new InboxClient({
          apiUrl: binding.apiBaseUrl,
          inboxId: binding.inboxId,
          token: loaded.token,
          requestTimeoutMs: 3000,
        })
      } catch (error) {
        this.logger.warn('occupancy DELETE 跳过：token 不可用', {
          session: binding.sessionRef,
          error: String(error?.message ?? error).slice(0, 160),
        })
        return
      }
    }
    try {
      await client.deleteOccupancy()
      binding.health.occupancy = { state: 'vacated', at: new Date().toISOString() }
    } catch (error) {
      binding.health.occupancy = {
        state: 'failed',
        message: String(error?.message ?? error).slice(0, 200),
        at: new Date().toISOString(),
      }
      this.logger.warn('occupancy DELETE 未生效', {
        session: binding.sessionRef,
        inbox: binding.inboxId,
        code: error?.code,
      })
    }
    this.persist()
  }

  /**
   * Route `agent/created`: start or refresh the binding engine.
   * @param {{agent: any, source?: string}} payload - host event payload.
   */
  onAgentCreated(payload) {
    const sessionRef = String(payload?.agent?.id ?? '')
    const binding = this.state.bindings[sessionRef]
    if (!binding) return
    const engine = this.engines.get(sessionRef)
    if (engine) {
      engine.onAgentCreated(payload)
      void this.refreshOccupancy(sessionRef)
      return
    }
    void this.startBinding(binding, `session-${payload?.source ?? 'created'}`).then(() => {
      void this.refreshOccupancy(sessionRef)
    })
  }

  /**
   * Re-PUT occupancy after a resume (the daemon clears marks on restart).
   * @param {string} sessionRef - session id.
   */
  async refreshOccupancy(sessionRef) {
    const binding = this.state.bindings[sessionRef]
    const client = this.clients.get(sessionRef)
    if (!binding || !client) return
    await this.putOccupancy(binding, client)
    await this.flush()
  }

  /**
   * Route `agent/status`.
   * @param {{agent: any, status: string}} payload - host event payload.
   */
  onAgentStatus(payload) {
    const engine = this.engines.get(String(payload?.agent?.id ?? ''))
    engine?.onAgentStatus(payload)
  }

  /**
   * Route `session/event`.
   * @param {any} session - appending session.
   * @param {any} event - appended event.
   */
  onSessionEvent(session, event) {
    const engine = this.engines.get(String(session?.id ?? ''))
    engine?.onSessionEvent(session, event)
  }

  /**
   * Handle `agent/disposed`: stop only that binding and vacate its occupancy.
   * @param {{agent: any}} payload - host event payload.
   */
  onAgentDisposed(payload) {
    const sessionRef = String(payload?.agent?.id ?? '')
    const binding = this.state.bindings[sessionRef]
    if (!binding) return
    binding.health.session = 'disposed'
    this.persist()
    void this.clearOccupancy(binding).then(() => this.stopBinding(sessionRef, 'session-disposed'))
    this.logger.warn('绑定 session 已卸载或归档；仅停止该 binding', { session: sessionRef })
  }

  /**
   * Handle `workspace/session-stop` (archive with stopActivity).
   * @param {{sessionId?: string}} request - stop request.
   */
  onSessionStop(request) {
    const sessionRef = String(request?.sessionId ?? '')
    const binding = this.state.bindings[sessionRef]
    if (!binding) return
    binding.health.session = 'archived'
    this.persist()
    void this.clearOccupancy(binding).then(() => this.stopBinding(sessionRef, 'session-archived'))
    this.logger.warn('绑定 session 已归档；仅停止该 binding', { session: sessionRef })
  }

  /**
   * Whether one session is bound.
   * @param {string} sessionId - session id.
   * @returns {boolean} true when a binding exists.
   */
  isBoundTo(sessionId) {
    return Boolean(sessionId) && this.state.bindings[String(sessionId)] !== undefined
  }

  /**
   * One binding record, if present.
   * @param {string} sessionId - session id.
   * @returns {Record<string, any>|undefined} binding.
   */
  bindingFor(sessionId) {
    return this.state.bindings[String(sessionId ?? '')]
  }

  /**
   * Count-only projection for the Web UI dock panel.
   *
   * Reads the binding's last observed `status`; it never returns item ids,
   * titles/summaries, content, payloads, or the token. A session without a
   * binding yields `{bound:false}` so the Client can hide the panel.
   *
   * @param {string} sessionId - authoritative DSH session id.
   * @returns {Record<string, any>} safe panel state.
   */
  panelStatus(sessionId) {
    const ref = String(sessionId ?? '').trim()
    const binding = this.state.bindings[ref]
    if (!binding) {
      return {
        bound: false,
        sessionRef: ref,
        observedAt: new Date().toISOString(),
      }
    }
    const status = binding.lastStatus
    const numberOrNull = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)
    return {
      bound: true,
      sessionRef: binding.sessionRef,
      inboxId: binding.inboxId,
      enabled: binding.enabled !== false,
      blocked: binding.blocked?.code ?? null,
      configError: binding.health?.configError?.code ?? null,
      sse: binding.health?.sse ?? 'idle',
      session: binding.health?.session ?? 'unknown',
      available: numberOrNull(status?.available),
      claimed: numberOrNull(status?.claimed),
      revision: numberOrNull(status?.revision),
      channels: Object.keys(status?.channels ?? {}),
      updatedAt: typeof status?.updatedAt === 'string' ? status.updatedAt : null,
      observedAt: new Date().toISOString(),
    }
  }

  /**
   * Refresh one binding's cached board status on demand (panel refresh).
   *
   * This is a read-only `GET /status`; it never fetches items, claims, or
   * wakes. A cold binding without a client returns its last cached count.
   *
   * @param {string} sessionId - authoritative DSH session id.
   * @returns {Promise<Record<string, any>>} safe panel state.
   */
  async refreshPanelStatus(sessionId) {
    const binding = this.state.bindings[String(sessionId ?? '').trim()]
    const client = binding ? this.clients.get(binding.sessionRef) : undefined
    if (binding && client) {
      try {
        const status = await client.getStatus()
        binding.lastStatus = summarizeStatus(status)
        binding.lastObservedRevision = status.revision
        binding.updatedAt = new Date().toISOString()
      } catch (error) {
        binding.health.lastError = {
          code: error?.code ?? 'PANEL_STATUS',
          message: error?.status ? `HTTP ${error.status}` : 'status refresh failed',
          at: new Date().toISOString(),
          operation: 'panel-status',
        }
        this.persist()
      }
    }
    return this.panelStatus(sessionId)
  }

  /**
   * Summarize one binding for status output (never includes the raw token).
   * @param {Record<string, any>} binding - binding record.
   * @param {boolean} full - include the token reference path and log tail.
   * @returns {Record<string, any>} summary.
   */
  summarize(binding, full) {
    return {
      sessionRef: binding.sessionRef,
      inboxId: binding.inboxId,
      apiBaseUrl: binding.apiBaseUrl,
      channels: binding.channels,
      label: binding.label,
      enabled: binding.enabled !== false,
      engine: this.engines.has(binding.sessionRef),
      session: binding.health.session,
      sse: binding.health.sse,
      reconnects: binding.health.reconnects,
      cursor: binding.lastEventId,
      lastObservedRevision: binding.lastObservedRevision,
      lastWokenRevision: binding.lastWokenRevision,
      lastStatus: binding.lastStatus,
      lastWake: binding.lastWake
        ? {
            revision: binding.lastWake.revision,
            available: binding.lastWake.available,
            channels: binding.lastWake.channels,
            summary: binding.lastWake.summary ?? null,
            at: binding.lastWake.at,
            reason: binding.lastWake.reason,
          }
        : null,
      summary: binding.summary ?? null,
      configError: binding.health.configError,
      blocked: binding.blocked,
      occupancy: binding.health.occupancy ?? null,
      ...(full
        ? {
            adapterTokenRef: displayTokenRef(binding.adapterTokenRef),
            wakeInFlight: binding.wakeInFlight ?? false,
            wake: binding.wake,
            lastReason: binding.lastReason,
          }
        : {}),
    }
  }

  /**
   * Machine-readable status for tools and tests.
   * @param {string} callerId - calling session id.
   * @returns {Record<string, any>} status.
   */
  snapshot(callerId) {
    const caller = this.state.bindings[String(callerId ?? '')]
    const others = Object.values(this.state.bindings)
      .filter((binding) => binding.sessionRef !== callerId)
      .map((binding) => this.summarize(binding, false))
    return {
      version: HOST_STATE_VERSION,
      caller: callerId ?? '',
      binding: caller ? this.summarize(caller, true) : null,
      otherBindings: others,
      bindingCount: Object.keys(this.state.bindings).length,
      stateFile: this.config.stateFile,
      engineCount: this.engines.size,
      legacyV1: this.state.legacyV1 ? true : false,
    }
  }

  /**
   * Human-readable status for `/inbox status`.
   * @param {string} callerId - calling session id.
   * @returns {string} multi-line status.
   */
  statusText(callerId) {
    const snapshot = this.snapshot(callerId)
    const binding = snapshot.binding
    const lines = [
      `InboxMosire adapter v2 — ${snapshot.bindingCount} binding(s)`,
    ]
    if (!binding) {
      lines.push(`caller=${callerId || '(unknown)'} isBound=false（未绑定）`)
    } else {
      const board = binding.lastStatus
        ? `revision=${binding.lastStatus.revision} available=${binding.lastStatus.available} claimed=${binding.lastStatus.claimed}`
        : '尚未读取 status'
      lines.push(
        `caller=${callerId} isBound=true inbox=${binding.inboxId} session=${binding.sessionRef}`,
        `apiBaseUrl=${binding.apiBaseUrl} channels=[${(binding.channels ?? []).join(',')}]`,
        `board: ${board}`,
        `cursor: lastEventId=${binding.cursor ?? 'null'} lastObservedRevision=${binding.lastObservedRevision} lastWokenRevision=${binding.lastWokenRevision}`,
        `sse: ${binding.sse} reconnects=${binding.reconnects} session=${binding.session} engine=${binding.engine}`,
        `tokenRef: ${binding.adapterTokenRef}`,
        `occupancy: ${binding.occupancy ? `${binding.occupancy.state}${binding.occupancy.occupiedBy ? ` by ${binding.occupancy.occupiedBy}` : ''}` : '未标记'}`,
        `lastWake: ${binding.lastWake ? `revision=${binding.lastWake.revision} at=${binding.lastWake.at} channels=[${(binding.lastWake.channels ?? []).join(',')}] summary=${binding.lastWake.summary?.state ?? 'unknown'}` : '无'}`,
        `summary: enabled=${this.config.summaryEnabled !== false} maxItems=${this.config.summaryMaxItems} titleChars=${this.config.summaryMaxTitleChars} totalChars=${this.config.summaryMaxTotalChars} state=${binding.summary?.state ?? 'unknown'} shown=${binding.summary?.shown ?? 0} remaining=${binding.summary?.remaining ?? 0}${binding.summary?.at ? ` at=${binding.summary.at}` : ''}${binding.summary?.code ? ` code=${binding.summary.code}` : ''}${binding.summary?.message ? ` — ${binding.summary.message}` : ''}`,
      )
      if (binding.configError) {
        lines.push(`CONFIG ERROR: ${binding.configError.code} — ${binding.configError.message}（/inbox retry）`)
      }
      if (binding.blocked) {
        lines.push(`BLOCKED: ${binding.blocked.code} — ${binding.blocked.message}`)
      }
    }
    if (snapshot.legacyV1) lines.push('legacyV1: 已保留 v1 状态快照（未丢弃）')
    if (snapshot.otherBindings.length > 0) {
      lines.push('other bindings:')
      for (const other of snapshot.otherBindings) {
        const counts = other.lastStatus
          ? `rev=${other.lastStatus.revision} avail=${other.lastStatus.available}`
          : 'rev=?'
        lines.push(
          `  ${other.sessionRef} → ${other.inboxId} sse=${other.sse} ${counts} lastWoken=${other.lastWokenRevision}${other.configError ? ` ERROR=${other.configError.code}` : ''}`,
        )
      }
    }
    lines.push(`state: ${snapshot.stateFile}`)
    const tail = typeof this.logger.tail === 'function' ? this.logger.tail(6) : []
    if (tail.length > 0) {
      lines.push('recent:')
      for (const entry of tail) lines.push(`  ${entry.time} ${entry.level} ${entry.message}`)
    }
    return lines.join('\n')
  }

  /** Persist the host document within the store's debounce window. */
  persist() {
    this.store?.save(this.state)
  }

  /** Flush the host document (and any engine-side changes) immediately. */
  async flush() {
    for (const binding of Object.values(this.state.bindings)) {
      binding.updatedAt = new Date().toISOString()
    }
    await this.store?.flush(this.state)
  }
}
