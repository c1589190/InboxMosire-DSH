/**
 * Model-facing tools for the InboxMosire wake adapter.
 *
 * This module is a separate loader row from the wake engine (`index.js`) on
 * purpose: the engine holds a long-lived SSE connection and the durable
 * binding, while the tool surface can be installed or reloaded independently.
 * Every tool delegates to the same `/inbox` command handler, which closes over
 * the one live adapter instance — there is no second source of truth.
 *
 * Authority: `bind` / `unbind` are exposed to the model by explicit operator
 * choice. `inbox_list` / `inbox_claim` / `inbox_complete` are NOT here; they
 * belong to the InboxMosire MCP server and stay in the MCP tool namespace.
 *
 * @module @mosire/dsh-inbox-mosire/tools
 */

/** Plugin id used by loader diagnostics. */
export const name = 'inbox-mosire-tools'

/** Both the human-command registry and the tool registry must exist. */
export const inject = ['commands', 'tools']

/** Canonical tool output: one text block carrying the command result. */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The `/inbox` command output.' },
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
 * Execute one `/inbox` subcommand through the registered command definition.
 * @param {any} commands - commands service.
 * @param {{id: string}|undefined} agent - calling agent.
 * @param {string} rawInput - command arguments.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<string>} command output.
 */
async function runInboxCommand(commands, agent, rawInput, signal) {
  if (!agent?.id) throw new Error('no calling session for this tool')
  const definition = commands.find(agent, 'inbox')
  if (!definition) {
    throw new Error(
      'the InboxMosire adapter is not loaded (no /inbox command); install @mosire/dsh-inbox-mosire first',
    )
  }
  const result = await definition.handler({
    commandId: 'inbox-adapter-tool',
    agent,
    rawInput,
    attachments: [],
    signal,
  })
  if (result?.kind === 'error') throw new Error(result.text || '/inbox command failed')
  return result?.text ?? ''
}

/**
 * Register the adapter's model-facing tools.
 * @param {any} ctx - Cordis plugin context.
 */
export function apply(ctx) {
  const { commands, tools } = ctx
  const register = (definition) => ctx.effect(() => tools.register(definition))

  register({
    name: 'inbox_adapter_status',
    description:
      'Read the InboxMosire wake adapter state: whether this session is the wake target, SSE connection, cursor, board revision, last wake, and any configuration error. Read-only. Use it before binding or when a wake seems missing.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: OUTPUT,
    execute: async (_args, exec) => ({
      text: await runInboxCommand(commands, exec.agent, 'status', exec.signal),
    }),
  })

  register({
    name: 'inbox_adapter_bind',
    description:
      'Bind this DSH session (or an explicitly named session id) as the InboxMosire wake target. Wakes are delivered only while the target session is idle. This is the tool form of the human `/inbox bind` command.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description:
            'Optional authoritative DSH session id to bind instead of the calling session.',
        },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    execute: async (args, exec) => {
      const explicit =
        args && typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
      return {
        text: await runInboxCommand(
          commands,
          exec.agent,
          explicit ? `bind ${explicit}` : 'bind',
          exec.signal,
        ),
      }
    },
  })

  register({
    name: 'inbox_adapter_unbind',
    description:
      'Remove the InboxMosire wake binding so the adapter stops delivering wakes. Keeps the board cursor and revision watermarks. This is the tool form of the human `/inbox unbind` command.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: OUTPUT,
    execute: async (_args, exec) => ({
      text: await runInboxCommand(commands, exec.agent, 'unbind', exec.signal),
    }),
  })
}
