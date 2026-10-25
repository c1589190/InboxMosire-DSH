/**
 * `/inbox` human command for the v2 multi-binding adapter.
 *
 * The command operates on the calling session's binding by default. Structured
 * binding (explicit other session, descriptor objects) is the tool surface's
 * job; the command is the operator's shorthand.
 *
 * @module @mosire/dsh-inbox-mosire/lib/commands
 */
import { readFile } from 'node:fs/promises'

/** Usage line shown for unknown subcommands. */
export const INBOX_COMMAND_HELP = [
  '用法: /inbox [status|bind <descriptor.json | inboxId tokenRef [channels]>|unbind [sessionId]|retry [sessionId]]',
  '  status   显示调用者 binding、其他 binding 摘要、cursor/occupancy/错误',
  '  bind     绑定当前会话：给 descriptor JSON 路径，或 inboxId + tokenRef [+ channels]',
  '  unbind   解除当前会话（或指定 session）的绑定',
  '  retry    重新读取 tokenRef 并重启 binding（token rotate 后使用）',
].join('\n')

/**
 * Split a channel list.
 * @param {string|undefined} value - comma-separated text.
 * @returns {string[]} channel ids.
 */
function channelsOf(value) {
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((channel) => channel.trim())
    .filter(Boolean)
}

/**
 * Execute one `/inbox` invocation.
 * @param {string} rawInput - text after the command name.
 * @param {{id: string}|undefined} agent - invoking session.
 * @param {import('./manager.js').BindingManager} manager - the live manager.
 * @returns {Promise<string>} command output.
 */
export async function runInboxCommand(rawInput, agent, manager) {
  const line = String(rawInput ?? '').trim()
  const [subcommand = 'status', ...rest] = line === '' ? [] : line.split(/\s+/)
  switch (subcommand.toLowerCase()) {
    case '':
    case 'status':
      return manager.statusText(agent?.id)
    case 'bind': {
      if (rest.length === 0) return INBOX_COMMAND_HELP
      let descriptor
      if (rest.length === 1) {
        let text
        try {
          text = await readFile(rest[0], 'utf8')
        } catch (error) {
          return `descriptor 不可读: ${rest[0]} (${error?.code ?? error})`
        }
        try {
          descriptor = JSON.parse(text)
        } catch (error) {
          return `descriptor 不是 JSON: ${rest[0]} (${error.message})`
        }
      } else {
        descriptor = {
          inboxId: rest[0],
          adapterTokenRef: rest[1],
          channels: channelsOf(rest[2]),
        }
      }
      const result = await manager.bind({ sessionId: agent?.id, descriptor })
      return `${result.message}\n\n${result.status}`
    }
    case 'unbind': {
      const target = rest[0] || agent?.id
      const result = await manager.unbind(target)
      return result.message
    }
    case 'retry': {
      const result = await manager.retry(rest[0])
      return `${result.message}\n\n${manager.statusText(agent?.id)}`
    }
    case 'help':
      return INBOX_COMMAND_HELP
    default:
      return `未知子命令: ${subcommand}\n${INBOX_COMMAND_HELP}`
  }
}

/**
 * Register the `/inbox` command on a commands service.
 * @param {{register: (definition: any) => () => void}} commands - commands service.
 * @param {Promise<import('./manager.js').BindingManager>} managerReady - pending manager.
 * @param {{error: Function}} logger - redacting logger.
 * @returns {() => void} registry disposer.
 */
export function registerInboxCommand(commands, managerReady, logger) {
  return commands.register({
    name: 'inbox',
    description:
      'InboxMosire 多 binding 适配器：status / bind / unbind / retry（每个 session 独立 binding）',
    input: {
      hint: 'status | bind <descriptor.json | inboxId tokenRef [channels]> | unbind [sessionId] | retry [sessionId]',
    },
    handler: async (invocation) => {
      try {
        const manager = await managerReady
        if (!manager) throw new Error('adapter 引擎未加载')
        const text = await runInboxCommand(invocation.rawInput, invocation.agent, manager)
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
