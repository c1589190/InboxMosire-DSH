/**
 * Session-level wake rest (snooze) helpers.
 *
 * Rest is an adapter concern: the Inbox board remains unchanged, and the
 * bound DSH session simply suppresses new inbox followups until a deadline.
 */

/** Maximum accepted rest window. */
export const MAX_REST_SECONDS = 86_400

/** Completion/archive tools whose successful result may carry restSeconds. */
const REST_TOOL_NAMES = new Set(['inbox_complete', 'inbox_delete', 'bot_thread_ack'])

/**
 * Whether a tool name is an allowed rest-carrying completion tool.
 * Accepts MCP-prefixed names such as `mcp__iibot__bot_thread_ack`.
 * @param {unknown} name - tool name.
 * @returns {boolean} true when allowed.
 */
export function isRestCompletionTool(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  for (const tool of REST_TOOL_NAMES) {
    if (name === tool || name.endsWith(`__${tool}`)) return true
  }
  return false
}

/**
 * Parse a restSeconds value.
 * @param {unknown} value - raw tool argument.
 * @returns {number|null|undefined} seconds, null for invalid, undefined when absent.
 */
export function parseRestSeconds(value) {
  if (value === undefined || value === null || value === '') return undefined
  const seconds = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_REST_SECONDS) {
    return null
  }
  return seconds
}

/**
 * Compute the absolute rest deadline.
 * @param {number} now - epoch milliseconds.
 * @param {number} seconds - rest duration; 0 clears.
 * @returns {number|null} deadline, or null when rest is cleared.
 */
export function restDeadline(now, seconds) {
  return seconds > 0 ? now + seconds * 1000 : null
}
