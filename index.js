/**
 * `@mosire/dsh-inbox-mosire` — the InboxMosire v2 multi-binding adapter engine.
 *
 * One DSH host, one binding per session: this row owns the v2 state document,
 * the per-binding SSE streams, wake state machines, and advisory occupancy.
 * The model-facing tools live in the sibling `tools.js` row and reach this
 * engine through `lib/runtime.js`.
 *
 * Host capability citations: `docs/HOST-CAPABILITIES.md`.
 *
 * @module @mosire/dsh-inbox-mosire
 */
import { registerInboxCommand } from './lib/commands.js'
import { ConfigError, readLocalConfig, resolveConfig } from './lib/config.js'
import { createLogger } from './lib/log.js'
import { BindingManager } from './lib/manager.js'
import { registerPanelRpc } from './lib/panel.js'
import { setManager, setManagerFailure } from './lib/runtime.js'
import { StateStore, normalizeHostState } from './lib/state.js'
import { hasBusinessTools } from './lib/program-mcp.js'

/** Plugin id used by loader diagnostics. */
export const name = 'inbox-mosire-adapter'

/** The adapter cannot function without the live-agent registry. */
export const inject = ['agents']

/**
 * Wire the v2 manager's host lifecycle surface.
 *
 * Every listener is owned by the plugin fiber, so unloading the row removes it.
 * @param {any} ctx - Cordis plugin context.
 * @param {BindingManager} manager - the manager to feed.
 */
export function wireHostEvents(ctx, manager) {
  ctx.on('agent/created', (payload) => manager.onAgentCreated(payload))
  ctx.on('agent/disposed', (payload) => manager.onAgentDisposed(payload))
  ctx.on('agent/status', (payload) => manager.onAgentStatus(payload))
  ctx.on('session/event', (session, event) => manager.onSessionEvent(session, event))
  ctx.on('workspace/session-stop', (request) => manager.onSessionStop(request))
  ctx.on('tools/result', (exec, result) => manager.onToolResult(exec, result))
}

/**
 * Wire one single-binding engine (kept for the engine-level test harness).
 * @param {any} ctx - Cordis plugin context.
 * @param {import('./lib/adapter.js').InboxAdapter} adapter - engine.
 */
export function wireEngineEvents(ctx, adapter) {
  ctx.on('agent/created', (payload) => adapter.onAgentCreated(payload))
  ctx.on('agent/disposed', (payload) => adapter.onAgentDisposed(payload))
  ctx.on('agent/status', (payload) => adapter.onAgentStatus(payload))
  ctx.on('session/event', (session, event) => adapter.onSessionEvent(session, event))
  ctx.on('workspace/session-stop', (request) => adapter.onSessionStop(request))
}

/**
 * Resolve configuration, load/migrate the v2 state, and build the manager.
 * @param {any} ctx - Cordis plugin context.
 * @param {Record<string, unknown>} rowConfig - loader row config.
 * @param {{info: Function, warn: Function, error: Function, debug: Function}} baseLogger - Cordis logger.
 * @returns {Promise<{manager: BindingManager, logger: any, config: Record<string, any>}>} manager and logger.
 */
async function createManager(ctx, rowConfig, baseLogger) {
  const errors = []
  let local = {}
  try {
    local = await readLocalConfig()
  } catch (error) {
    errors.push(error.message)
  }
  const resolved = resolveConfig(rowConfig, process.env, local)
  errors.push(...resolved.errors)
  const config = resolved.value
  const logger = createLogger({ base: baseLogger, file: config.logFile })
  for (const warning of resolved.warnings) logger.warn(warning)
  if (errors.length > 0) throw new ConfigError(errors.join('; '), errors)

  const store = new StateStore({ file: config.stateFile, logger })
  const loaded = await store.loadDocument(normalizeHostState, {
    legacyDefaults: {
      inboxId: config.inboxId,
      apiBaseUrl: config.apiUrl,
      adapterTokenRef: config.tokenFile ? `file:${config.tokenFile}` : undefined,
    },
  })
  for (const warning of loaded.warnings) logger.warn(warning)
  if (loaded.migrated) {
    logger.info('状态已迁移到 v2', {
      existed: loaded.existed,
      bindings: Object.keys(loaded.state.bindings).length,
    })
  }
  if (loaded.state.legacyV1) {
    logger.info('v1 状态快照已保留在 legacyV1（未丢弃）')
  }

  const host = {
    getAgent: (sessionId) => ctx.agents.get(sessionId),
    listAgents: () => ctx.agents.list(),
    isIdle: (agent) => agent?.status === 'idle',
    followup: (agent, message) => agent.followup(message),
    now: () => Date.now(),
    hasBusinessTools,
  }
  const manager = new BindingManager({ config, logger, store, state: loaded.state, host })
  return { manager, logger, config }
}

/**
 * Cordis plugin entry.
 * @param {any} ctx - plugin context.
 * @param {Record<string, unknown>} [config] - loader row config.
 */
export function apply(ctx, config = {}) {
  let baseLogger
  try {
    baseLogger = ctx.logger('inbox-mosire')
  } catch {
    baseLogger = console
  }

  const ready = createManager(ctx, config ?? {}, baseLogger)
    .then(async (created) => {
      wireHostEvents(ctx, created.manager)
      setManager(created.manager)
      await created.manager.start()
      return created.manager
    })
    .catch((error) => {
      const message = String(error?.message ?? error).slice(0, 400)
      baseLogger.error(`inbox-mosire: 启动失败: ${message}`)
      setManagerFailure(message)
      return null
    })

  // The dock panel is optional: headless/ACP compositions have no Web
  // Connection service, so the engine keeps working without it.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (connectionCtx) => {
      registerPanelRpc(connectionCtx.connection, ready)
    })
  }

  ctx.effect(() => {
    /** Register `/inbox` as soon as a commands service exists. */
    const mount = (commands) => {
      if (!commands) return
      ctx.effect(() => registerInboxCommand(commands, ready, baseLogger))
    }
    if (ctx.get('commands')) {
      mount(ctx.get('commands'))
    } else if (typeof ctx.inject === 'function') {
      ctx.inject(['commands'], (readyCtx) => mount(readyCtx.get('commands')))
    }
    return () => {}
  })

  ctx.effect(() => () => {
    return ready.then(async (manager) => {
      if (manager) await manager.stop()
      setManager(null)
    })
  })
}
