/**
 * Detect the claim-mode Inbox tools exposed by a program-owned MCP.
 *
 * View-ack programs are no longer guessed from a mirrored business-tool list:
 * their workflow belongs to their own MCP tool descriptions. The adapter never
 * provides or calls those tools; claim mode keeps a generic readiness
 * diagnostic because the Inbox claim lifecycle itself is part of Mode A.
 *
 * @module @mosire/dsh-inbox-mosire/lib/program-mcp
 */

import { WAKE_MODE, normalizeWakeMode } from './wake-mode.js'

export const CLAIM_BUSINESS_TOOL_NAMES = Object.freeze([
  'inbox_claim',
  'inbox_list',
  'inbox_view',
])

/**
 * Whether one schema name is a recognized claim-mode business tool.
 * @param {unknown} name - tool name.
 * @param {unknown} [wakeMode] - optional claim/view-ack discriminator.
 * @returns {boolean} true when recognized for the mode.
 */
export function isBusinessToolName(name, wakeMode) {
  if (normalizeWakeMode(wakeMode) !== WAKE_MODE.CLAIM) return false
  if (typeof name !== 'string' || name.length === 0) return false
  return CLAIM_BUSINESS_TOOL_NAMES.some(
    (tool) => name === tool || name.endsWith(`__${tool}`),
  )
}

/**
 * Inspect the live agent's visible tool schemas.
 * @param {any} agent - DSH agent.
 * @param {unknown} [wakeMode] - optional claim/view-ack discriminator.
 * @returns {boolean|undefined} claim-mode availability, or undefined when the
 * mode does not define a generic tool family or introspection is unavailable.
 */
export function hasBusinessTools(agent, wakeMode) {
  if (normalizeWakeMode(wakeMode) !== WAKE_MODE.CLAIM) return undefined
  try {
    const tools = agent?.ctx?.tools
    if (!tools || typeof tools.schemas !== 'function') return undefined
    const names = tools
      // DSH tool visibility is agent-scoped. Querying the registry without
      // the live agent yields the global view and can miss tools injected
      // only into the target session's MCP connection.
      .schemas(agent)
      .map((schema) => schema?.name)
      .filter((name) => typeof name === 'string')
    return names.some((name) => isBusinessToolName(name, wakeMode))
  } catch {
    return undefined
  }
}
