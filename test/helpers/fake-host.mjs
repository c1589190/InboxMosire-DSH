/**
 * Fake DSH host surface for adapter tests: a Cordis-like context with an
 * in-memory agent registry, `agent/status` transitions, `/inbox` commands, and
 * a redacting logger that keeps every line for privacy assertions.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InboxAdapter } from '../../lib/adapter.js'
import { resolveConfig } from '../../lib/config.js'
import { wireHostEvents } from '../../index.js'
import { InboxClient } from '../../lib/inbox-client.js'
import { createLogger } from '../../lib/log.js'
import { StateStore } from '../../lib/state.js'

/**
 * Create a fake host.
 * @param {object} [options] - host options.
 * @returns {Record<string, any>} host facade.
 */
export function createFakeHost({ now } = {}) {
  const listeners = new Map()
  const agents = new Map()
  const logs = []
  const commands = []
  const followups = []
  const toolDefinitions = []
  const disposers = []

  /**
   * Push one log line to the collected array.
   * @param {'debug'|'info'|'warn'|'error'} level - severity.
   * @returns {(message: string) => void} sink.
   */
  const sink = (level) => (message) => {
    logs.push({ level, message: String(message) })
  }
  const baseLogger = {
    debug: sink('debug'),
    info: sink('info'),
    warn: sink('warn'),
    error: sink('error'),
  }

  /**
   * Emit one host event.
   * @param {string} name - event name.
   * @param {...unknown} args - payload arguments.
   */
  function emit(name, ...args) {
    for (const handler of listeners.get(name) ?? []) handler(...args)
  }

  const services = {
    agents: {
      get: (id) => agents.get(String(id)),
      list: () => [...agents.values()],
    },
    commands: {
      register: (definition) => {
        commands.push(definition)
        return () => {
          const index = commands.indexOf(definition)
          if (index >= 0) commands.splice(index, 1)
        }
      },
      find: (_agent, name) => commands.find((definition) => definition.name === name),
    },
    tools: {
      register: (definition) => {
        toolDefinitions.push(definition)
        return () => {
          const index = toolDefinitions.indexOf(definition)
          if (index >= 0) toolDefinitions.splice(index, 1)
        }
      },
      schemas: () => toolDefinitions.map(({ name: toolName, description, parameters }) => ({ name: toolName, description, parameters })),
    },
  }

  const ctx = {
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
      return () => {
        const list = listeners.get(name) ?? []
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(callback) {
      const disposer = callback()
      const wrapped = () => {
        if (typeof disposer === 'function') disposer()
      }
      disposers.push(wrapped)
      return wrapped
    },
    get(name) {
      return services[name]
    },
    inject(names, callback) {
      if (names.every((name) => services[name] !== undefined)) callback(ctx)
      return () => {}
    },
    logger() {
      return baseLogger
    },
    agents: services.agents,
    commands: services.commands,
    tools: services.tools,
  }

  /**
   * Create one live agent.
   * @param {string} id - session id.
   * @param {object} [options] - agent options.
   * @param {'idle'|'running'} [options.status] - initial status.
   * @param {boolean} [options.child] - make it a subagent session.
   * @returns {Record<string, any>} agent.
   */
  function createAgent(id, { status = 'idle', child = false } = {}) {
    const agent = {
      id,
      status,
      session: {
        id,
        header: child
          ? { version: 4, id, createdAt: Date.now(), isSeeded: false, parentSession: 'parent', origin: 'subagent', delegationDepth: 1 }
          : { version: 4, id, createdAt: Date.now(), isSeeded: false },
      },
      followup(message) {
        followups.push({ agentId: id, message })
        if (agent.status !== 'running') {
          agent.status = 'running'
          emit('agent/status', { agent, status: 'running' })
        }
      },
      whenIdle: async () => {},
      cancel: () => {},
    }
    agents.set(id, agent)
    emit('agent/created', { agent, source: 'startup' })
    return agent
  }

  /**
   * End the agent's turn.
   * @param {Record<string, any>} agent - agent to idle.
   */
  function endTurn(agent) {
    if (agent.status === 'idle') return
    agent.status = 'idle'
    emit('agent/status', { agent, status: 'idle' })
  }

  /**
   * Dispose the agent, as archive/delete/unload does.
   * @param {Record<string, any>} agent - agent to remove.
   */
  function dispose(agent) {
    agents.delete(agent.id)
    emit('agent/disposed', { agent })
  }

  return {
    ctx,
    agents,
    commands,
    tools: toolDefinitions,
    followups,
    logs,
    disposers,
    baseLogger,
    emit,
    createAgent,
    endTurn,
    dispose,
    /** Run every registered effect disposer (plugin unload). */
    async disposeAll() {
      for (const disposer of disposers.splice(0).reverse()) {
        await disposer()
      }
      for (const list of listeners.values()) list.length = 0
    },
    now: now ?? (() => Date.now()),
  }
}

/**
 * Wait until a predicate holds.
 * @param {() => boolean} predicate - condition.
 * @param {object} [options] - wait options.
 * @param {number} [options.timeoutMs] - budget.
 * @param {number} [options.intervalMs] - poll interval.
 * @param {string} [options.label] - failure label.
 * @returns {Promise<void>} resolves when the predicate holds.
 */
export async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 10, label = 'condition' } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * Resolve after a fixed delay.
 * @param {number} ms - delay.
 * @returns {Promise<void>} resolved promise.
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build one adapter wired to the fake host and a real (fake-server) HTTP client.
 * @param {object} options - construction.
 * @param {Record<string, any>} options.server - fake inbox handle.
 * @param {Record<string, any>} options.host - fake host.
 * @param {Record<string, any>} [options.overrides] - config overrides.
 * @param {Record<string, string>} [options.env] - environment overrides.
 * @param {string} [options.stateFile] - reuse a state path.
 * @param {{apiUrl: string, inboxId: string, channels?: string[], token: string}} [options.connection] - explicit inbox endpoint.
 * @returns {Promise<Record<string, any>>} adapter plus test handles.
 */
export async function createTestAdapter({
  server,
  host,
  overrides = {},
  env = {},
  stateFile,
  connection,
}) {
  const dir = stateFile ? null : await mkdtemp(join(tmpdir(), 'inbox-adapter-'))
  const file = stateFile ?? join(dir, 'state.json')
  const conn = connection ?? {
    apiUrl: server.url,
    inboxId: server.inbox,
    channels: ['ticket'],
    token: 'test-token',
  }
  const resolved = resolveConfig(
    {
      apiUrl: conn.apiUrl,
      inboxId: conn.inboxId,
      channels: conn.channels ?? ['ticket'],
      sessionId: 'session-test',
      token: conn.token,
      stateFile: file,
      logFile: `${file}.log`,
      debounceMs: 20,
      heartbeatTimeoutSeconds: 5,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
      wakeBackoffBaseMs: 100,
      wakeBackoffMaxMs: 400,
      requestTimeoutMs: 2000,
      ...overrides,
    },
    env,
    {},
  )
  const logger = createLogger({
    base: host.baseLogger,
    token: conn.token,
    file: resolved.value.logFile,
    tailSize: 200,
  })
  const store = new StateStore({ file: resolved.value.stateFile, logger, debounceMs: 5 })
  const loaded = await store.load({
    inboxId: resolved.value.inboxId,
    channels: resolved.value.channels,
  })
  const client = new InboxClient({
    apiUrl: resolved.value.apiUrl,
    inboxId: resolved.value.inboxId,
    channels: resolved.value.channels,
    token: conn.token,
    requestTimeoutMs: resolved.value.requestTimeoutMs,
  })
  const adapter = new InboxAdapter({
    config: resolved.value,
    configErrors: resolved.errors,
    token: conn.token,
    logger,
    store,
    state: loaded.state,
    client,
    host: {
      getAgent: (id) => host.ctx.agents.get(id),
      listAgents: () => host.ctx.agents.list(),
      isIdle: (agent) => agent?.status === 'idle',
      followup: (agent, message) => agent.followup(message),
      now: host.now,
    },
    tokenSource: { kind: 'inline' },
  })
  wireHostEvents(host.ctx, adapter)
  return { adapter, store, logger, config: resolved.value, loaded, stateFile: file }
}
