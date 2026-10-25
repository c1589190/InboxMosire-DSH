/**
 * `@mosire/dsh-inbox-mosire` — the InboxMosire wake adapter as one DSH Host
 * plugin.
 *
 * The host probe behind this design is recorded in `docs/HOST-CAPABILITIES.md`:
 * `agent.followup()`, `agent/status`, `agent/created`, `agent/disposed`, and the
 * durable session log provide every hook the wake-adapter contract requires.
 *
 * @module @mosire/dsh-inbox-mosire
 */
import { InboxAdapter } from './lib/adapter.js'
import { registerInboxCommand } from './lib/commands.js'
import {
  ConfigError,
  loadToken,
  readLocalConfig,
  resolveConfig,
} from './lib/config.js'
import { InboxClient } from './lib/inbox-client.js'
import { createLogger } from './lib/log.js'
import { StateStore, emptyState } from './lib/state.js'

/** Plugin id used by loader diagnostics. */
export const name = 'inbox-mosire-adapter'

/** The adapter cannot function without the live-agent registry. */
export const inject = ['agents']

/**
 * Wire the host's lifecycle surface into an adapter instance.
 *
 * Every listener is owned by the plugin fiber, so unloading the row removes it.
 * @param {any} ctx - Cordis plugin context.
 * @param {InboxAdapter} adapter - the adapter to feed.
 */
export function wireHostEvents(ctx, adapter) {
  ctx.on('agent/created', (payload) => adapter.onAgentCreated(payload))
  ctx.on('agent/disposed', (payload) => adapter.onAgentDisposed(payload))
  ctx.on('agent/status', (payload) => adapter.onAgentStatus(payload))
  ctx.on('session/event', (session, event) => adapter.onSessionEvent(session, event))
  ctx.on('workspace/session-stop', (request) => adapter.onSessionStop(request))
}

/**
 * Build the adapter from the row config, the environment, the machine-local
 * file, and the DSH store.
 * @param {any} ctx - Cordis plugin context.
 * @param {Record<string, unknown>} rowConfig - the loader row's config.
 * @param {{info: Function, warn: Function, error: Function, debug: Function}} baseLogger - Cordis logger.
 * @returns {Promise<InboxAdapter>} a started adapter.
 */
async function createAdapter(ctx, rowConfig, baseLogger) {
  const configErrors = []
  const warnings = []
  let local = {}
  try {
    local = await readLocalConfig()
  } catch (error) {
    configErrors.push(error.message)
  }

  const resolved = resolveConfig(rowConfig, process.env, local)
  configErrors.push(...resolved.errors)
  warnings.push(...resolved.warnings)
  const config = resolved.value

  let token
  try {
    token = await loadToken(resolved.tokenSource)
  } catch (error) {
    if (error instanceof ConfigError) configErrors.push(error.message)
    else throw error
  }

  const logger = createLogger({
    base: baseLogger,
    token,
    file: configErrors.length === 0 ? config.logFile : undefined,
  })
  for (const warning of warnings) logger.warn(warning)

  /** @type {StateStore|null} */
  let store = null
  /** @type {Record<string, any>} */
  let state = emptyState({ inboxId: config.inboxId, channels: config.channels })
  try {
    store = new StateStore({ file: config.stateFile, logger })
    const loaded = await store.load({ inboxId: config.inboxId, channels: config.channels })
    state = loaded.state
    if (loaded.migrated && loaded.existed) {
      logger.info('已迁移状态文件到当前版本', { file: config.stateFile })
    }
    if (loaded.warning) logger.warn(loaded.warning)
  } catch (error) {
    configErrors.push(error.message)
    store = null
  }

  const client =
    configErrors.length === 0
      ? new InboxClient({
          apiUrl: config.apiUrl,
          inboxId: config.inboxId,
          channels: config.channels,
          token,
          requestTimeoutMs: config.requestTimeoutMs,
          maxResponseBytes: config.maxResponseBytes,
        })
      : null

  const host = {
    getAgent: (sessionId) => ctx.agents.get(sessionId),
    listAgents: () => ctx.agents.list(),
    isIdle: (agent) => agent?.status === 'idle',
    followup: (agent, message) => agent.followup(message),
    now: () => Date.now(),
  }

  const adapter = new InboxAdapter({
    config,
    configErrors,
    token,
    logger,
    store,
    state,
    client,
    host,
    tokenSource: resolved.tokenSource,
  })

  wireHostEvents(ctx, adapter)
  await adapter.start()
  if (configErrors.length > 0) {
    logger.error(`适配器未启动：${configErrors.join('; ')}`)
  }
  return adapter
}

/**
 * Cordis plugin entry.
 * @param {any} ctx - plugin context.
 * @param {Record<string, unknown>} [config] - loader row config.
 */
export function apply(ctx, config = {}) {
  /** @type {InboxAdapter|undefined} */
  let adapter
  let baseLogger
  try {
    baseLogger = ctx.logger('inbox-mosire')
  } catch {
    baseLogger = console
  }

  const ready = createAdapter(ctx, config ?? {}, baseLogger).then((created) => {
    adapter = created
    return created
  })
  ready.catch((error) => {
    baseLogger.error(
      `inbox-mosire: 启动失败: ${String(error?.message ?? error).slice(0, 300)}`,
    )
  })

  ctx.effect(() => {
    /** Register `/inbox` as soon as a commands service exists. */
    const mount = (commands) => {
      if (!commands) return
      ctx.effect(() =>
        registerInboxCommand(commands, ready, baseLogger),
      )
    }
    if (ctx.get('commands')) {
      mount(ctx.get('commands'))
    } else if (typeof ctx.inject === 'function') {
      ctx.inject(['commands'], (readyCtx) => mount(readyCtx.get('commands')))
    }
    return () => {}
  })

  ctx.effect(() => () => {
    void ready.then(async (created) => {
      await created.stop()
    }, () => {})
  })
}
