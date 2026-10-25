/**
 * InboxMosire → DSH wake state machine.
 *
 * Responsibilities are deliberately narrow (wake-adapter contract v1):
 * subscribe to SSE, read `status`, keep the session binding, call
 * `agent.followup()` at the host's idle/turn-end boundaries, and persist the
 * cursor, revisions, and binding. It never claims or completes notifications
 * and never reads item content.
 *
 * @module @mosire/dsh-inbox-mosire/lib/adapter
 */
import { CLIENT_ERROR, InboxClientError, normalizeStatus } from './inbox-client.js'
import {
  buildWakeMessage,
  renderWakeTemplate,
  sanitizeChannels,
  wakeKey,
  wakeMessageId,
} from './template.js'

/** Longest single wake guard; a followup that never starts a turn is abandoned. */
const WAKE_GUARD_MS = 10 * 60 * 1000

/** How long a prefetched status may be reused by the next decision. */
const STATUS_FRESH_MS = 5000

/** Bound for a recorded error message. */
const MAX_ERROR_CHARS = 300

/**
 * Resolve after a delay, or immediately when the signal aborts.
 * @param {number} delayMs - delay in milliseconds.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>} settled by the timer or the abort.
 */
function sleep(delayMs, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, Math.max(0, delayMs))
    timer.unref?.()
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Exponential reconnect delay with bounded jitter.
 * @param {number} attempt - zero-based failure count.
 * @param {number} base - first delay.
 * @param {number} max - cap.
 * @param {() => number} [random] - injectable randomness.
 * @returns {number} delay in milliseconds.
 */
export function reconnectDelay(attempt, base, max, random = Math.random) {
  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt))
  const jitter = exponential * 0.2 * random()
  return Math.round(exponential - exponential * 0.1 + jitter)
}

/**
 * @typedef {object} AdapterHost
 * @property {(sessionId: string) => any} getAgent - live agent for a session id.
 * @property {() => any[]} listAgents - every live agent.
 * @property {(agent: any) => boolean} isIdle - whether the agent accepts a followup turn now.
 * @property {(agent: any, message: any) => void} followup - host wake entry.
 * @property {() => number} now - wall clock.
 */

/**
 * The adapter itself. One instance owns exactly one inbox binding.
 */
export class InboxAdapter {
  /**
   * @param {object} options - construction.
   * @param {Record<string, any>} options.config - resolved configuration value.
   * @param {string[]} options.configErrors - validation failures that block startup.
   * @param {string} [options.token] - loaded adapter token.
   * @param {object} options.logger - redacting logger.
   * @param {object} options.store - StateStore.
   * @param {Record<string, any>} options.state - loaded state document.
   * @param {import('./inbox-client.js').InboxClient|null} options.client - read-only inbox client.
   * @param {AdapterHost} options.host - host callbacks.
   * @param {{kind: string, value?: string}} [options.tokenSource] - token provenance for diagnostics.
   */
  constructor({ config, configErrors = [], token, logger, store, state, client, host, tokenSource }) {
    this.config = config
    this.configErrors = configErrors
    this.token = token
    this.logger = logger
    this.store = store
    this.state = state
    this.client = client
    this.host = host
    this.tokenSource = tokenSource ?? { kind: 'none' }

    this.stopping = false
    this.started = false
    this.engine = null
    this.boundAgent = null
    this.wakeInFlight = false
    this.turnActive = false
    this.dirty = false
    /** @type {Set<string>} */
    this.changedChannels = new Set()
    this.configError = null
    this.lastStatus = null
    this.lastStatusAt = 0

    this.reconcileTimer = null
    this.reconcileDueAt = 0
    this.reconcileChain = Promise.resolve()
    this.wakeGuardTimer = null
    this.reconnectAttempt = 0
    this.sequence = 0
  }

  /** @returns {number} monotonic decision sequence, for diagnostics. */
  nextSequence() {
    this.sequence += 1
    return this.sequence
  }

  /** @returns {string} current wall-clock ISO string. */
  nowIso() {
    return new Date(this.host.now()).toISOString()
  }

  /**
   * Load-time reconciliation of an interrupted wake.
   *
   * A `pendingWake` means the process died between persisting intent and
   * completing the delivery record. `agent.followup()` is synchronous, so the
   * turn was either queued or the process died before it was; either way the
   * contract's at-most-once rule forbids replaying it.
   */
  recoverPendingWake() {
    const pending = this.state.pendingWake
    if (!pending || !Number.isSafeInteger(pending.revision)) return
    this.state.lastWokenRevision = Math.max(
      this.state.lastWokenRevision,
      pending.revision,
    )
    this.state.lastWake = {
      key: pending.key,
      revision: pending.revision,
      available: pending.available,
      channels: sanitizeChannels(pending.channels),
      messageId: pending.messageId,
      at: pending.at,
      recovered: true,
    }
    this.state.pendingWake = null
    this.logger.warn('恢复未确认的唤醒：按已投递处理，不重复唤醒', {
      revision: pending.revision,
    })
  }

  /**
   * Start the adapter: validate the binding, read status once, then follow SSE.
   * @returns {Promise<void>} after the first status read and stream start.
   */
  async start() {
    this.started = true
    if (this.configErrors.length > 0) {
      this.failConfig('CONFIG_INVALID', new Error(this.configErrors.join('; ')))
      return
    }
    if (this.state.enabled === false) {
      this.logger.info('适配器处于停用状态（enabled=false）；不会唤醒')
    }
    this.recoverPendingWake()

    if (this.config.autoBind) {
      this.resolveAutoBinding()
    } else if (this.config.sessionId) {
      if (this.state.sessionRef && this.state.sessionRef !== this.config.sessionId) {
        this.logger.warn('配置的 sessionId 与持久绑定不同，改为配置值', {
          previous: this.state.sessionRef,
          next: this.config.sessionId,
        })
        this.switchBinding(this.config.sessionId)
      } else if (!this.state.sessionRef) {
        this.switchBinding(this.config.sessionId)
      }
    }

    if (!this.state.sessionRef) {
      this.logger.info('空闲：等待绑定 DSH session（/inbox bind 或配置 sessionId）')
      await this.persist()
      return
    }
    if (!this.state.enabled) {
      await this.persist()
      return
    }
    this.logger.info('绑定已加载', {
      inbox: this.config.inboxId,
      session: this.state.sessionRef,
      cursor: this.state.lastEventId,
      lastWokenRevision: this.state.lastWokenRevision,
    })
    await this.ensureEngine('startup')
    await this.persist()
  }

  /**
   * Stop every timer, stream, and pending write.
   * @returns {Promise<void>} after the state is flushed.
   */
  async stop() {
    this.stopping = true
    this.clearReconcileTimer()
    this.clearWakeGuard()
    this.stopEngine('stopped')
    if (this.store) await this.store.close(this.state).catch(() => {})
  }

  /**
   * Bind this adapter to one authoritative DSH session id.
   * @param {string} sessionRef - `Session.id` from the host.
   * @param {string} reason - who requested the binding.
   * @returns {Promise<{ok: boolean, message: string}>} outcome.
   */
  async bind(sessionRef, reason = 'command') {
    const value = String(sessionRef ?? '').trim()
    if (!value || value.length > 200) {
      return { ok: false, message: '无效的 session id' }
    }
    if (this.state.sessionRef === value) {
      await this.ensureEngine('bind')
      return { ok: true, message: `已绑定 ${value}` }
    }
    this.stopEngine('rebind')
    this.switchBinding(value)
    this.configError = null
    this.state.health.configError = null
    this.logger.info('绑定 DSH session', { session: value, reason })
    await this.persist()
    if (this.state.enabled) await this.ensureEngine('bind')
    return { ok: true, message: `已绑定 ${value}` }
  }

  /**
   * Replace the binding target, resetting the per-session wake ledger but
   * keeping the board cursor.
   * @param {string} sessionRef - new session id.
   */
  switchBinding(sessionRef) {
    this.state.sessionRef = sessionRef
    this.state.lastWokenRevision = 0
    this.state.lastWake = null
    this.state.pendingWake = null
    this.state.wake.stalls = 0
    this.state.wake.nextWakeAllowedAt = null
    this.state.wake.attempts = 0
    this.wakeInFlight = false
    this.changedChannels.clear()
    this.boundAgent = null
  }

  /**
   * Remove the binding and stop delivering wakes.
   * @returns {Promise<{ok: boolean, message: string}>} outcome.
   */
  async unbind() {
    this.stopEngine('unbind')
    const previous = this.state.sessionRef
    this.state.sessionRef = ''
    this.state.lastWake = null
    this.state.pendingWake = null
    this.state.wake.nextWakeAllowedAt = null
    this.boundAgent = null
    this.wakeInFlight = false
    await this.persist()
    this.logger.info('已解绑 DSH session', { previous })
    return { ok: true, message: previous ? `已解绑 ${previous}` : '本来未绑定' }
  }

  /**
   * Enable or disable automatic wakes without losing the binding or cursor.
   * @param {boolean} enabled - desired state.
   * @returns {Promise<void>} after the change is durable.
   */
  async setEnabled(enabled) {
    this.state.enabled = Boolean(enabled)
    if (!this.state.enabled) {
      this.stopEngine('disabled')
    } else {
      this.configError = null
      this.state.health.configError = null
      await this.ensureEngine('enabled')
    }
    await this.persist()
    this.logger.info(this.state.enabled ? '自动唤醒已启用' : '自动唤醒已停用')
  }

  /**
   * Whether the persisted binding targets one exact session.
   * @param {string} sessionId - session id to compare.
   * @returns {boolean} true when `sessionId` is the wake target.
   */
  isBoundTo(sessionId) {
    return Boolean(sessionId) && this.state.sessionRef === String(sessionId)
  }

  /** @returns {boolean} whether a live agent is bound right now. */
  hasLiveBinding() {
    return Boolean(this.liveAgent())
  }

  /**
   * Resolve the bound agent from the host registry, refreshing the cache.
   * @returns {any|undefined} the live agent.
   */
  liveAgent() {
    if (!this.state.sessionRef || !this.host) {
      this.boundAgent = null
      return undefined
    }
    const agent = this.host.getAgent(this.state.sessionRef)
    this.boundAgent = agent
    return agent
  }

  /**
   * Auto-binding: adopt the single live root agent, or wait for the next one.
   * @returns {void}
   */
  resolveAutoBinding() {
    if (this.state.sessionRef) {
      if (this.host.getAgent(this.state.sessionRef)) return
      this.logger.info('持久绑定的 session 尚未复活，等待 resume', {
        session: this.state.sessionRef,
      })
      return
    }
    const roots = this.host
      .listAgents()
      .filter((agent) => isRootAgent(agent))
    if (roots.length === 1) {
      this.switchBinding(String(roots[0].id))
      this.logger.info('自动绑定唯一的 live root session', {
        session: this.state.sessionRef,
      })
      return
    }
    if (roots.length > 1) {
      this.logger.warn('自动绑定失败：存在多个 live root session，改为等待 /inbox bind', {
        candidates: roots.length,
      })
    }
  }

  /**
   * Handle `agent/created`.
   * @param {{agent: any, source?: string}} payload - host event payload.
   */
  onAgentCreated(payload) {
    const agent = payload?.agent
    if (!agent || !agent.id) return
    if (this.config.autoBind && !this.state.sessionRef && isRootAgent(agent)) {
      this.switchBinding(String(agent.id))
      this.logger.info('自动绑定新的 root session', {
        session: agent.id,
        source: payload.source ?? 'unknown',
      })
      this.persist()
      void this.ensureEngine('auto-bind')
      return
    }
    if (String(agent.id) !== this.state.sessionRef) return
    this.boundAgent = agent
    this.state.health.session = 'live'
    this.logger.info('绑定的 session 已就绪', {
      session: agent.id,
      source: payload.source ?? 'unknown',
    })
    void this.ensureEngine('session-created')
  }

  /**
   * Handle `agent/disposed`: an archived, deleted, or unloaded session must
   * never receive a wake.
   * @param {{agent: any}} payload - host event payload.
   */
  onAgentDisposed(payload) {
    const agent = payload?.agent
    if (!agent || String(agent.id) !== this.state.sessionRef) return
    if (this.boundAgent !== null && this.boundAgent !== agent) return
    this.boundAgent = null
    this.wakeInFlight = false
    this.clearWakeGuard()
    this.stopEngine('session-disposed')
    this.state.health.session = 'disposed'
    this.logger.warn('绑定的 session 已卸载或归档；停止投递，等待 resume', {
      session: agent.id,
    })
    void this.persist()
  }

  /**
   * Handle `agent/status` (`idle` ⇄ `running`).
   * @param {{agent: any, status: string}} payload - host event payload.
   */
  onAgentStatus(payload) {
    const agent = payload?.agent
    if (!agent || String(agent.id) !== this.state.sessionRef) return
    this.boundAgent = agent
    if (payload.status === 'running') {
      this.turnActive = true
      return
    }
    if (payload.status !== 'idle') return
    this.turnActive = false
    if (this.wakeInFlight) {
      this.wakeInFlight = false
      this.clearWakeGuard()
      const run = async () => {
        try {
          await this.evaluateAfterWake(agent)
        } catch (error) {
          this.logger.error('turn end 状态复核失败', {
            error: String(error?.message ?? error).slice(0, MAX_ERROR_CHARS),
          })
          this.scheduleReconcile(this.config.debounceMs, 'turn-end-error')
        }
      }
      this.reconcileChain = this.reconcileChain.then(run, run)
      return
    }
    this.scheduleReconcile(this.config.debounceMs, 'turn-end')
  }

  /**
   * Handle `session/event` turn boundaries as a second, durable turn-end
   * signal. `agent/status` idle is the primary trigger; this keeps the state
   * machine attached to the session log when a status frame is missed.
   * @param {any} session - session that appended the event.
   * @param {{type: string}} event - appended event.
   */
  onSessionEvent(session, event) {
    if (!session || String(session.id) !== this.state.sessionRef) return
    if (event?.type !== 'turn/end') return
    if (this.wakeInFlight) return
    this.scheduleReconcile(this.config.debounceMs, 'turn-end-event')
  }

  /**
   * Handle `workspace/session-stop` — an archive that stops activity.
   * @param {{sessionId?: string}} request - stop request.
   */
  onSessionStop(request) {
    const id = request?.sessionId ? String(request.sessionId) : ''
    if (!id || id !== this.state.sessionRef) return
    this.wakeInFlight = false
    this.clearWakeGuard()
    this.stopEngine('session-archived')
    this.state.health.session = 'archived'
    this.logger.warn('绑定的 session 已归档；停止投递', { session: id })
    void this.persist()
  }

  /**
   * Provide the host's followup entry point (index.js wires it).
   * @param {any} agent - live agent.
   * @param {any} message - immutable wake message.
   */
  followup(agent, message) {
    this.host.followup(agent, message)
  }

  /**
   * Decide whether a wake is due, using a fresh `status` read.
   * @param {string} reason - trigger label.
   * @param {{status?: object, at?: number}} [prefetched] - status fetched by the caller.
   * @returns {Promise<void>} after the decision settles.
   */
  async reconcile(reason, prefetched) {
    const run = async () => {
      try {
        await this.reconcileOnce(reason, prefetched)
      } catch (error) {
        this.logger.error('唤醒决策失败', {
          reason,
          error: String(error?.message ?? error).slice(0, MAX_ERROR_CHARS),
        })
        this.scheduleReconcile(Math.max(1000, this.config.debounceMs), 'reconcile-error')
      }
    }
    this.reconcileChain = this.reconcileChain.then(run, run)
    return this.reconcileChain
  }

  /**
   * Await every queued decision (tests and `/inbox status`).
   * @returns {Promise<void>} settled queue.
   */
  async whenSettled() {
    await this.reconcileChain
    await this.store?.flush(this.state)
  }

  /**
   * One decision pass.
   * @param {string} reason - trigger label.
   * @param {{status?: object, at?: number}} [prefetched] - status fetched by the caller.
   */
  async reconcileOnce(reason, prefetched) {
    if (this.stopping) return
    if (this.configError) return
    if (this.state.enabled === false) return
    const sequence = this.nextSequence()
    const agent = this.liveAgent()
    if (!agent) {
      this.state.lastReason = 'session-not-live'
      return
    }
    if (this.wakeInFlight || !this.host.isIdle(agent)) {
      this.dirty = true
      this.state.lastReason = 'turn-active'
      return
    }
    let status = prefetched?.status
    if (!status || this.host.now() - (prefetched?.at ?? 0) > STATUS_FRESH_MS) {
      status = await this.readStatus()
      if (!status) return
    }
    this.state.lastObservedRevision = status.revision
    this.lastStatus = status
    this.state.lastStatus = summarizeStatus(status)

    if (status.revision < this.state.lastWokenRevision) {
      this.logger.warn('通知板 revision 回退，重置水印与 cursor', {
        revision: status.revision,
        lastWokenRevision: this.state.lastWokenRevision,
      })
      this.state.lastWokenRevision = 0
      this.state.lastEventId = null
      this.state.lastWake = null
      this.state.wake.stalls = 0
      this.state.wake.nextWakeAllowedAt = null
    }

    if (status.available <= 0) {
      this.dirty = false
      this.changedChannels.clear()
      this.state.wake.stalls = 0
      this.state.wake.nextWakeAllowedAt = null
      this.state.lastReason = 'idle-empty'
      await this.persist()
      return
    }
    if (status.revision <= this.state.lastWokenRevision) {
      this.dirty = false
      this.state.lastReason = 'already-woken'
      await this.persist()
      return
    }

    const gate = this.state.wake.nextWakeAllowedAt
    if (gate && this.host.now() < gate) {
      this.state.lastReason = 'wake-backoff'
      this.scheduleReconcile(gate - this.host.now(), 'wake-backoff')
      await this.persist()
      return
    }

    await this.deliverWake(agent, status, { reason, sequence })
  }

  /**
   * Read and normalize status, classifying failures.
   * @returns {Promise<object|undefined>} status, or undefined when the read failed.
   */
  async readStatus() {
    try {
      const status = await this.client.getStatus()
      this.lastStatusAt = this.host.now()
      return status
    } catch (error) {
      this.handleClientError(error, 'status')
      return undefined
    }
  }

  /**
   * Deliver at most one wake for one revision.
   * @param {any} agent - idle live agent.
   * @param {object} status - current board status.
   * @param {{reason: string, sequence: number}} context - decision context.
   * @returns {Promise<boolean>} whether a followup was submitted.
   */
  async deliverWake(agent, status, { reason, sequence }) {
    const key = wakeKey({
      inboxId: this.config.inboxId,
      revision: status.revision,
      sessionRef: this.state.sessionRef,
    })
    if (this.state.lastWake?.key === key) {
      this.logger.debug('同一 revision 已唤醒，跳过', { key })
      return false
    }
    const configured = this.config.channels.length > 0
      ? new Set(this.config.channels)
      : null
    const candidates = this.changedChannels.size > 0
      ? [...this.changedChannels]
      : this.config.channels
    const channels = sanitizeChannels(
      candidates.filter((channel) => configured === null || configured.has(channel)),
    )
    let text
    let message
    try {
      text = renderWakeTemplate({
        inboxId: this.config.inboxId,
        revision: status.revision,
        available: status.available,
        channels,
      })
      message = buildWakeMessage({ id: wakeMessageId(key), text })
    } catch (error) {
      this.logger.error('唤醒模板渲染失败', {
        error: String(error?.message ?? error).slice(0, MAX_ERROR_CHARS),
      })
      return false
    }

    this.state.pendingWake = {
      key,
      revision: status.revision,
      available: status.available,
      channels,
      messageId: message.id,
      at: this.nowIso(),
    }
    await this.store?.flush(this.state)

    try {
      this.followup(agent, message)
    } catch (error) {
      this.state.pendingWake = null
      await this.persist()
      this.logger.error('宿主 followup 被拒绝', {
        session: this.state.sessionRef,
        error: String(error?.message ?? error).slice(0, MAX_ERROR_CHARS),
      })
      this.scheduleReconcile(1000, 'followup-retry')
      return false
    }

    this.wakeInFlight = true
    this.armWakeGuard()
    this.state.pendingWake = null
    this.state.lastWokenRevision = status.revision
    this.state.lastWake = {
      key,
      revision: status.revision,
      available: status.available,
      channels,
      messageId: message.id,
      at: this.nowIso(),
      reason,
      sequence,
      sessionRef: this.state.sessionRef,
    }
    this.state.wake.attempts += 1
    this.state.lastReason = 'woken'
    this.changedChannels.clear()
    this.dirty = false
    await this.persist()
    this.logger.info('已投递唤醒', {
      session: this.state.sessionRef,
      inbox: this.config.inboxId,
      revision: status.revision,
      available: status.available,
      channels,
      reason,
      messageId: message.id,
    })
    return true
  }

  /**
   * Re-read status after a wake turn ended and record progress or a stall.
   * @param {any} agent - the agent that just went idle.
   */
  async evaluateAfterWake(agent) {
    if (this.stopping) return
    const previous = this.state.lastWake
    const status = await this.readStatus()
    if (!status) {
      this.scheduleReconcile(this.config.debounceMs, 'turn-end-retry')
      return
    }
    this.lastStatus = status
    this.state.lastObservedRevision = status.revision
    this.state.lastStatus = summarizeStatus(status)
    if (status.revision < this.state.lastWokenRevision) {
      this.state.lastWokenRevision = 0
      this.state.lastWake = null
    }
    const progress = status.available <= 0 || (previous && status.available < previous.available)
    const newWork = Boolean(previous) && status.available > previous.available
    if (progress || newWork) {
      this.state.wake.stalls = 0
      this.state.wake.nextWakeAllowedAt = null
    } else if (status.available > 0) {
      this.state.wake.stalls = Math.min(this.state.wake.stalls + 1, 16)
      const delay = Math.min(
        this.config.wakeBackoffMaxMs,
        this.config.wakeBackoffBaseMs * 2 ** (this.state.wake.stalls - 1),
      )
      this.state.wake.nextWakeAllowedAt = this.host.now() + delay
      this.logger.warn('唤醒后 available 无进展，退避下一次唤醒', {
        stalls: this.state.wake.stalls,
        delayMs: delay,
        available: status.available,
      })
    }
    await this.persist()
    this.scheduleReconcile(this.config.debounceMs, 'turn-end')
  }

  /**
   * Apply one SSE frame. The payload is only an invalidation: the decision
   * always re-reads `status`.
   * @param {{id: number|null, type: string, data: string}} event - dispatched frame.
   */
  onSseEvent(event) {
    if (event?.id !== null && Number.isSafeInteger(event.id)) {
      if (this.state.lastEventId === null || event.id > this.state.lastEventId) {
        this.state.lastEventId = event.id
        this.persist()
      }
    }
    if (event?.type !== 'inbox.changed') return
    this.state.health.lastEventAt = this.nowIso()
    const parsed = parseInboxEvent(event.data)
    if (parsed) {
      for (const channel of parsed.changedChannels) this.changedChannels.add(channel)
    }
    this.dirty = true
    this.scheduleReconcile(this.config.debounceMs, 'sse-event')
  }

  /**
   * Schedule one debounced decision, coalescing with a pending earlier one.
   * @param {number} delayMs - delay before the decision.
   * @param {string} reason - trigger label.
   */
  scheduleReconcile(delayMs, reason) {
    if (this.stopping || this.configError) return
    const dueAt = this.host.now() + Math.max(0, delayMs)
    if (this.reconcileTimer && this.reconcileDueAt <= dueAt) return
    this.clearReconcileTimer()
    this.reconcileDueAt = dueAt
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null
      this.reconcileDueAt = 0
      void this.reconcile(reason)
    }, Math.max(0, delayMs))
    this.reconcileTimer.unref?.()
  }

  /** Cancel a pending decision. */
  clearReconcileTimer() {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer)
    this.reconcileTimer = null
    this.reconcileDueAt = 0
  }

  /** Arm the guard that abandons a followup that never starts a turn. */
  armWakeGuard() {
    this.clearWakeGuard()
    this.wakeGuardTimer = setTimeout(() => {
      this.wakeGuardTimer = null
      if (!this.wakeInFlight) return
      this.wakeInFlight = false
      this.logger.warn('唤醒后 10 分钟未见 turn 启动，释放单次唤醒锁')
      this.scheduleReconcile(this.config.debounceMs, 'wake-guard')
    }, WAKE_GUARD_MS)
    this.wakeGuardTimer.unref?.()
  }

  /** Cancel the wake guard. */
  clearWakeGuard() {
    if (this.wakeGuardTimer) clearTimeout(this.wakeGuardTimer)
    this.wakeGuardTimer = null
  }

  /**
   * Start the status-then-SSE engine when a live binding exists.
   * @param {string} reason - trigger label.
   * @returns {Promise<void>} after the first status read.
   */
  async ensureEngine(reason) {
    if (this.stopping || this.configError) return
    if (!this.state.enabled || !this.client || !this.state.sessionRef) return
    if (this.engine) return
    const agent = this.liveAgent()
    if (!agent) {
      this.state.health.session = 'not-live'
      this.logger.info('绑定的 session 没有 live agent；等待 resume 后连接 SSE', {
        session: this.state.sessionRef,
      })
      await this.persist()
      return
    }
    this.state.health.session = 'live'
    const engine = { abort: new AbortController(), loop: null }
    this.engine = engine
    this.logger.info('连接 InboxMosire（先 status 后 SSE）', {
      inbox: this.config.inboxId,
      cursor: this.state.lastEventId,
      reason,
    })
    let status
    try {
      status = await this.client.getStatus()
      this.lastStatus = status
      this.lastStatusAt = this.host.now()
    } catch (error) {
      this.handleClientError(error, 'startup-status')
      if (this.engine === engine) this.engine = null
      return
    }
    if (this.engine !== engine) return
    this.state.health.sse = 'connecting'
    await this.reconcile('startup', { status, at: this.host.now() })
    if (this.stopping || engine.abort.signal.aborted) return
    engine.loop = this.runSseLoop(engine).catch((error) => {
      this.logger.error('SSE 循环异常退出', {
        error: String(error?.message ?? error).slice(0, MAX_ERROR_CHARS),
      })
    })
  }

  /**
   * Stop the SSE engine.
   * @param {string} reason - trigger label.
   */
  stopEngine(reason) {
    if (!this.engine) return
    const engine = this.engine
    this.engine = null
    engine.abort.abort()
    this.state.health.sse = 'disconnected'
    this.logger.info('停止 InboxMosire 连接', { reason })
  }

  /**
   * The reconnect loop. Cursor survives every disconnect.
   * @param {{abort: AbortController, loop: any}} engine - current engine.
   */
  async runSseLoop(engine) {
    const signal = engine.abort.signal
    let attempt = 0
    while (!signal.aborted && !this.stopping) {
      this.state.health.sse = 'connecting'
      await this.reconcileChain.catch(() => {})
      try {
        const result = await this.client.streamEvents({
          lastEventId: this.state.lastEventId,
          signal,
          heartbeatTimeoutMs: this.config.heartbeatTimeoutSeconds * 1000,
          onOpen: () => {
            attempt = 0
            this.reconnectAttempt = 0
            this.state.health.sse = 'connected'
            this.state.health.sseConnectedAt = this.nowIso()
            this.state.health.lastError = null
            this.logger.info('SSE 已连接', { cursor: this.state.lastEventId })
            this.persist()
          },
          onEvent: (event) => this.onSseEvent(event),
          onHeartbeat: () => {
            this.state.health.lastEventAt = this.nowIso()
          },
        })
        if (signal.aborted) break
        if (result.reason === 'aborted') break
        this.state.health.lastError = {
          code: result.reason === 'timeout' ? 'HEARTBEAT_TIMEOUT' : 'SSE_CLOSED',
          message: result.reason === 'timeout' ? '心跳超时' : '服务端关闭连接',
          at: this.nowIso(),
        }
        this.logger.warn('SSE 断开', this.state.health.lastError)
      } catch (error) {
        if (signal.aborted) break
        if (this.handleClientError(error, 'events')) break
      }
      if (signal.aborted || this.stopping) break
      attempt += 1
      this.state.health.reconnects += 1
      this.state.health.sse = 'disconnected'
      await this.persist()
      const delay = reconnectDelay(
        attempt - 1,
        this.config.reconnectBaseMs,
        this.config.reconnectMaxMs,
      )
      this.logger.info('SSE 重连退避', {
        attempt,
        delayMs: delay,
        cursor: this.state.lastEventId,
      })
      await sleep(delay, signal)
    }
    if (this.state.health.sse !== 'idle') this.state.health.sse = 'disconnected'
  }

  /**
   * Classify a client failure and update health/config state.
   * @param {unknown} error - thrown value.
   * @param {string} operation - caller label.
   * @returns {boolean} whether the engine should stop.
   */
  handleClientError(error, operation) {
    const failure = error instanceof InboxClientError
      ? error
      : new InboxClientError(CLIENT_ERROR.HTTP, String(error?.message ?? error))
    if (failure.code === CLIENT_ERROR.ABORTED) return false
    if (failure.code === CLIENT_ERROR.AUTH) {
      this.failConfig('AUTH_FAILED', failure)
      return true
    }
    if (failure.code === CLIENT_ERROR.NOT_FOUND) {
      this.failConfig('INBOX_NOT_FOUND', failure)
      return true
    }
    if (failure.code === CLIENT_ERROR.INVALID_CURSOR) {
      this.logger.warn('SSE cursor 无效，丢弃 cursor 后从当前 tip 重连', {
        operation,
      })
      this.state.lastEventId = null
      this.persist()
      return false
    }
    this.state.health.lastError = {
      code: failure.code,
      message: failure.message.slice(0, MAX_ERROR_CHARS),
      at: this.nowIso(),
      operation,
    }
    this.logger.warn('InboxMosire 请求失败', {
      operation,
      code: failure.code,
      status: failure.status,
      message: failure.message.slice(0, MAX_ERROR_CHARS),
      retryable: failure.retryable,
    })
    this.persist()
    return false
  }

  /**
   * Stop automatic wakes and record a configuration error.
   * @param {string} code - stable adapter error code.
   * @param {Error} error - cause; its message is already token-free.
   */
  failConfig(code, error) {
    const message = String(error?.message ?? error).slice(0, MAX_ERROR_CHARS)
    this.configError = {
      code,
      message,
      status: error instanceof InboxClientError ? error.status : undefined,
      at: this.nowIso(),
    }
    this.state.health.configError = this.configError
    this.state.health.sse = 'stopped'
    this.stopEngine(code)
    this.clearReconcileTimer()
    this.logger.error(`配置错误 ${code}：${message}；已停止自动唤醒（修复后 /inbox retry）`)
    this.persist()
  }

  /**
   * Clear a configuration error and reconnect.
   * @returns {Promise<{ok: boolean, message: string}>} outcome.
   */
  async retry() {
    const previous = this.configError
    this.configError = null
    this.state.health.configError = null
    this.state.health.lastError = null
    this.state.health.sse = 'idle'
    this.reconnectAttempt = 0
    if (!previous) {
      await this.ensureEngine('retry')
      await this.persist()
      return { ok: true, message: '没有待清除的错误，已重新连接' }
    }
    this.logger.info('清除配置错误并重试', { code: previous.code })
    await this.ensureEngine('retry')
    await this.persist()
    return { ok: true, message: `已清除 ${previous.code}，正在重连` }
  }

  /** Persist the current state within the store's debounce window. */
  persist() {
    this.store?.save(this.state)
  }

  /**
   * One diagnostic snapshot for `/inbox status` and tests.
   * @returns {Record<string, any>} snapshot.
   */
  snapshot() {
    const agent = this.state.sessionRef ? this.host.getAgent(this.state.sessionRef) : undefined
    return {
      inboxId: this.config.inboxId,
      apiUrl: this.config.apiUrl,
      sessionRef: this.state.sessionRef,
      bound: Boolean(agent),
      agentStatus: agent?.status ?? null,
      enabled: this.state.enabled !== false,
      cursor: this.state.lastEventId,
      lastObservedRevision: this.state.lastObservedRevision,
      lastWokenRevision: this.state.lastWokenRevision,
      lastStatus: this.state.lastStatus,
      lastWake: this.state.lastWake,
      wake: { ...this.state.wake },
      wakeInFlight: this.wakeInFlight,
      turnActive: this.turnActive,
      dirty: this.dirty,
      changedChannels: [...this.changedChannels],
      health: { ...this.state.health },
      configError: this.configError,
      stateFile: this.config.stateFile,
      tokenSource:
        this.tokenSource.kind === 'file'
          ? { kind: 'file' }
          : { kind: this.tokenSource.kind },
      logger: this.logger,
      engine: Boolean(this.engine),
      channels: this.config.channels,
      lastReason: this.state.lastReason,
    }
  }

  /**
   * Human-readable status for the `/inbox` command.
   * @returns {string} multi-line status.
   */
  statusText() {
    const snap = this.snapshot()
    const lines = []
    lines.push(
      `InboxMosire adapter — ${snap.enabled ? '启用' : '停用'}${snap.bound ? '' : '（未绑定 live session）'}`,
    )
    lines.push(`inbox=${snap.inboxId} server=${snap.apiUrl}`)
    lines.push(
      `session=${snap.sessionRef || '(未绑定)'} agent=${snap.agentStatus ?? 'absent'}`,
    )
    const status = snap.lastStatus
    lines.push(
      status
        ? `board: revision=${status.revision} available=${status.available} claimed=${status.claimed} updatedAt=${status.updatedAt || '?'}`
        : 'board: 尚未读取 status',
    )
    lines.push(
      `cursor: lastEventId=${snap.cursor ?? 'null'} lastObservedRevision=${snap.lastObservedRevision} lastWokenRevision=${snap.lastWokenRevision}`,
    )
    lines.push(
      `sse: ${snap.health.sse}${snap.health.sseConnectedAt ? ` since ${snap.health.sseConnectedAt}` : ''} reconnects=${snap.health.reconnects}`,
    )
    const wake = snap.lastWake
    lines.push(
      wake
        ? `lastWake: revision=${wake.revision} available=${wake.available} at=${wake.at} channels=[${(wake.channels ?? []).join(',')}]`
        : 'lastWake: 无',
    )
    lines.push(
      `wake: attempts=${snap.wake.attempts} stalls=${snap.wake.stalls} backoffUntil=${snap.wake.nextWakeAllowedAt ? new Date(snap.wake.nextWakeAllowedAt).toISOString() : 'none'} inFlight=${snap.wakeInFlight} turnActive=${snap.turnActive}`,
    )
    if (snap.health.lastError) {
      lines.push(
        `lastError: ${snap.health.lastError.code} ${snap.health.lastError.message ?? ''} at ${snap.health.lastError.at ?? '?'}`,
      )
    }
    if (snap.configError) {
      lines.push(
        `CONFIG ERROR: ${snap.configError.code} — ${snap.configError.message}（修复后 /inbox retry）`,
      )
    }
    lines.push(`state: ${snap.stateFile}`)
    lines.push(`token: ${snap.tokenSource.kind === 'none' ? '未配置' : `来自 ${snap.tokenSource.kind}`}`)
    const tail = typeof snap.logger?.tail === 'function' ? snap.logger.tail(6) : []
    if (tail.length > 0) {
      lines.push('recent:')
      for (const entry of tail) lines.push(`  ${entry.time} ${entry.level} ${entry.message}`)
    }
    return lines.join('\n')
  }
}

/**
 * Whether an agent is a top-level session (never a subagent child).
 * @param {any} agent - live agent.
 * @returns {boolean} true for a root session.
 */
export function isRootAgent(agent) {
  const header = agent?.session?.header
  if (!header) return true
  return !header.parentSession && !header.origin
}

/**
 * Parse one CloudEvent `inbox.changed` payload, tolerating extra fields.
 * @param {string} data - SSE `data:` payload.
 * @returns {{revision?: number, available?: number, changedChannels: string[]}|undefined} invalidation facts.
 */
export function parseInboxEvent(data) {
  if (typeof data !== 'string' || data.length > 1024 * 1024) return undefined
  let body
  try {
    body = JSON.parse(data)
  } catch {
    return undefined
  }
  const inner = body?.data && typeof body.data === 'object' ? body.data : body
  const changedChannels = sanitizeChannels(
    Array.isArray(inner?.changedChannels) ? inner.changedChannels : [],
  )
  return {
    revision: Number.isSafeInteger(inner?.revision) ? inner.revision : undefined,
    available: Number.isSafeInteger(inner?.available) ? inner.available : undefined,
    changedChannels,
  }
}

/**
 * Keep only the numbers the adapter records from a status document.
 * @param {object} status - normalized status.
 * @returns {Record<string, any>} durable summary.
 */
export function summarizeStatus(status) {
  return {
    revision: status.revision,
    available: status.available,
    claimed: status.claimed,
    channels: status.channels,
    updatedAt: status.updatedAt,
  }
}

export { normalizeStatus }
