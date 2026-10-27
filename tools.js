/**
 * Model-facing tools for the v2 multi-binding adapter.
 *
 * Separate loader row from the wake engine (`index.js`): the engine holds the
 * live bindings and SSE streams, while this module only needs the published
 * manager from `lib/runtime.js`. Every tool reports the caller's binding plus a
 * summary of the other bindings; no tool ever returns a raw token.
 *
 * Business operations (`inbox_list`, `inbox_claim`, `inbox_complete`, …) are
 * NOT here. Under Mode A the target session uses its program-owned MCP server;
 * the adapter only wakes.
 *
 * @module @mosire/dsh-inbox-mosire/tools
 */

/** Plugin id used by loader diagnostics. */
export const name = 'inbox-mosire-tools'

/** Only the tool registry is required; the manager arrives through runtime. */
export const inject = ['tools']

/** Canonical tool output: one text block carrying the command result. */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Human-readable adapter output.' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  /**
   * Render the canonical value as the model-facing text block.
   * @param {unknown} _args - unused.
   * @param {{text: string}} value - canonical value.
   * @returns {Array<{type: 'text', text: string}>} content blocks.
   */
  render(_args, value) {
    return [{ type: 'text', text: value.text }]
  },
}

/**
 * Await the live manager, translating a startup failure into a tool error.
 * @returns {Promise<import('./lib/manager.js').BindingManager>} manager.
 */
async function manager() {
  const runtime = await import('./lib/runtime.js')
  return runtime.waitManager()
}

/**
 * Build a descriptor from tool arguments.
 *
 * Accepts a `descriptor` object or a descriptor JSON string, or the explicit
 * contract fields (`inboxId`, `adapterTokenRef`, `apiBaseUrl`, `channels`).
 *
 * @param {Record<string, any>} args - tool arguments.
 * @returns {Record<string, any>} descriptor.
 */
function descriptorOf(args) {
  const record = args && typeof args === 'object' ? args : {}
  if (typeof record.descriptor === 'string' && record.descriptor.trim() !== '') {
    try {
      return JSON.parse(record.descriptor)
    } catch (error) {
      throw new Error(`descriptor 不是合法 JSON: ${error.message}`)
    }
  }
  if (record.descriptor && typeof record.descriptor === 'object') {
    return record.descriptor
  }
  const descriptor = {}
  if (typeof record.inboxId === 'string') descriptor.inboxId = record.inboxId
  if (typeof record.adapterTokenRef === 'string') {
    descriptor.adapterTokenRef = record.adapterTokenRef
  }
  if (typeof record.apiBaseUrl === 'string') descriptor.apiBaseUrl = record.apiBaseUrl
  if (Array.isArray(record.channels)) descriptor.channels = record.channels
  if (typeof record.label === 'string') descriptor.label = record.label
  return descriptor
}

/**
 * Register the adapter's model-facing tools.
 * @param {any} ctx - Cordis plugin context.
 */
export function apply(ctx) {
  const { tools } = ctx
  const register = (definition) => ctx.effect(() => tools.register(definition))

  register({
    name: 'inbox_adapter_status',
    description:
      'Read the InboxMosire v2 adapter state: whether the calling session is bound, its inbox/cursor/SSE/occupancy/summary result/last wake/config error, and a summary of every other binding in this DSH host. Read-only. Never returns a token.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: OUTPUT,
    execute: async (_args, exec) => {
      const live = await manager()
      await live.refreshProgramMcp?.(exec.agent?.id)
      return { text: live.statusText(exec.agent?.id) }
    },
  })

  register({
    name: 'inbox_adapter_bind',
    description:
      'Bind one DSH session (default: the caller) to an InboxMosire inbox from a BindingDescriptor. Provide inboxId + adapterTokenRef (a file:/absolute path to the 0600 wake token) and optional channels, or pass the whole descriptor. Re-binding the same session replaces its binding; a different inbox resets that session\'s cursor and wake watermark. Wakes are delivered only while the bound session is idle.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Target authoritative DSH session id; defaults to the calling session.',
        },
        inboxId: { type: 'string', description: 'Inbox id, e.g. app-a.' },
        adapterTokenRef: {
          type: 'string',
          description: 'file:/absolute/path to the 0600 adapter wake token.',
        },
        apiBaseUrl: {
          type: 'string',
          description: 'Optional InboxMosire API base URL; defaults to the adapter configuration.',
        },
        channels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional channel filter (empty means all channels).',
        },
        label: { type: 'string', description: 'Optional human label.' },
        wakeMode: {
          type: 'string',
          enum: ['claim', 'view-ack'],
          description:
            'Processing lifecycle used in the wake instructions: claim for claim-based programs, view-ack for programs that view and archive without claiming. Defaults to claim.',
        },
        descriptor: {
          type: 'object',
          description: 'Optional full descriptor object (overrides the explicit fields).',
        },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    execute: async (args, exec) => {
      const live = await manager()
      const descriptor = descriptorOf(args)
      const target =
        args && typeof args.sessionId === 'string' && args.sessionId.trim() !== ''
          ? args.sessionId.trim()
          : String(exec.agent?.id ?? '')
      const result = await live.bind({
        sessionId: target,
        descriptor,
        wakeMode: args && typeof args.wakeMode === 'string' ? args.wakeMode : undefined,
      })
      return { text: `${result.message}\n\n${result.status}` }
    },
  })

  register({
    name: 'inbox_adapter_unbind',
    description:
      'Remove the InboxMosire wake binding for one session (default: the caller) and clear its advisory occupancy mark. Other sessions keep their bindings.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Target session id; defaults to the calling session.',
        },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    execute: async (args, exec) => {
      const live = await manager()
      const target =
        args && typeof args.sessionId === 'string' && args.sessionId.trim() !== ''
          ? args.sessionId.trim()
          : String(exec.agent?.id ?? '')
      const result = await live.unbind(target)
      return { text: result.message }
    },
  })

  register({
    name: 'inbox_adapter_log',
    description:
      "Read this session's InboxMosire binding operation log, newest first: who bound, unbound, suspended (panel 卸载), resumed (panel 挂载), retried, failed to start, or stopped because the session was disposed/archived, with the inbox id and host:port. Strictly per-session: it never returns another session's entries, any token/token path, item content, or wake deliveries. Read-only.",
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20,
          description: 'Entries to return (1-100); default 20.',
        },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    execute: async (args, exec) => {
      const live = await manager()
      const requested = args && Number.isSafeInteger(args.limit) ? args.limit : 20
      const limit = Math.max(1, Math.min(100, requested))
      const entries = live.readOps(String(exec.agent?.id ?? ''), limit)
      if (entries.length === 0) {
        return { text: '本会话没有 inbox 操作记录。' }
      }
      const lines = [`InboxMosire 操作日志（本会话，最新在前，共 ${entries.length} 条）`]
      for (const entry of entries) {
        const parts = [
          entry.at,
          entry.action,
          `by=${entry.actor}`,
          entry.inbox ? `inbox=${entry.inbox}` : null,
          entry.endpoint ? `at=${entry.endpoint}` : null,
          entry.wakeMode ? `wakeMode=${entry.wakeMode}` : null,
          `result=${entry.result}`,
          entry.error ? `error=${entry.error}` : null,
        ]
        lines.push(parts.filter(Boolean).join(' '))
      }
      return { text: lines.join('\n') }
    },
  })
}
