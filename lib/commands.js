/**
 * `/inbox` human command: binding and diagnostics without granting the model
 * any additional tool permission.
 *
 * The command runs against the session that invokes it, so a human can bind the
 * current conversation and inspect the adapter's exact state.
 *
 * @module @mosire/dsh-inbox-mosire/lib/commands
 */

/** Usage line shown for unknown subcommands. */
export const INBOX_COMMAND_HELP = [
  '用法: /inbox [status|bind [sessionId]|unbind|pause|resume|retry]',
  '  status   显示绑定、cursor、revision 与最后一次唤醒',
  '  bind     把当前会话绑定为唤醒目标（可显式给出 sessionId）',
  '  unbind   解除绑定，停止投递',
  '  pause    暂停自动唤醒（保留绑定与 cursor）',
  '  resume   恢复自动唤醒',
  '  retry    清除 401/403 等配置错误并重连',
].join('\n')

/**
 * Render adapter status, adding the caller's binding relationship when known.
 * @param {import('./adapter.js').InboxAdapter} adapter - the adapter.
 * @param {{id: string}|undefined} agent - invoking agent.
 * @returns {string} status text.
 */
function statusWithCaller(adapter, agent) {
  const text = adapter.statusText()
  if (!agent?.id) return text
  return `${text}\ncaller=${agent.id} isBound=${adapter.isBoundTo(agent.id)}`
}

/**
 * Execute one `/inbox` invocation.
 * @param {string} rawInput - text after the command name.
 * @param {{id: string}} agent - invoking agent.
 * @param {import('./adapter.js').InboxAdapter} adapter - the adapter.
 * @returns {Promise<string>} command output text.
 */
export async function runInboxCommand(rawInput, agent, adapter) {
  const [subcommand = 'status', argument] = String(rawInput ?? '')
    .trim()
    .split(/\s+/, 2)
  switch (subcommand.toLowerCase()) {
    case '':
    case 'status': {
      return statusWithCaller(adapter, agent)
    }
    case 'bind': {
      const target = argument || String(agent?.id ?? '')
      if (!target) return '无法确定当前 session id；请显式传入 /inbox bind <sessionId>'
      const result = await adapter.bind(target, 'command')
      return `${result.message}\n\n${statusWithCaller(adapter, agent)}`
    }
    case 'unbind': {
      const result = await adapter.unbind()
      return result.message
    }
    case 'pause':
    case 'stop': {
      await adapter.setEnabled(false)
      return '自动唤醒已暂停；绑定与 cursor 保留。用 /inbox resume 恢复。'
    }
    case 'resume':
    case 'start': {
      await adapter.setEnabled(true)
      return `${'自动唤醒已恢复。'}\n\n${statusWithCaller(adapter, agent)}`
    }
    case 'retry':
    case 'reconnect': {
      const result = await adapter.retry()
      return `${result.message}\n\n${statusWithCaller(adapter, agent)}`
    }
    case 'help':
      return INBOX_COMMAND_HELP
    default:
      return `未知子命令: ${subcommand}\n${INBOX_COMMAND_HELP}`
  }
}

/**
 * Register the `/inbox` command on a commands service.
 *
 * The adapter is supplied as a promise so the command is registered
 * synchronously at plugin load and answers as soon as the adapter exists.
 *
 * @param {{register: (definition: any) => () => void}} commands - commands service.
 * @param {Promise<import('./adapter.js').InboxAdapter>} adapterReady - pending adapter.
 * @param {{error: Function}} logger - redacting logger.
 * @returns {() => void} disposer from the registry.
 */
export function registerInboxCommand(commands, adapterReady, logger) {
  return commands.register({
    name: 'inbox',
    description: 'InboxMosire 唤醒适配器：status / bind / unbind / pause / resume / retry',
    input: {
      hint: 'status | bind [sessionId] | unbind | pause | resume | retry',
    },
    handler: async (invocation) => {
      try {
        const adapter = await adapterReady
        const text = await runInboxCommand(invocation.rawInput, invocation.agent, adapter)
        return { kind: 'success', text }
      } catch (error) {
        logger.error('命令执行失败', {
          error: String(error?.message ?? error).slice(0, 300),
        })
        return { kind: 'error', text: `命令失败: ${error?.message ?? error}` }
      }
    },
  })
}
