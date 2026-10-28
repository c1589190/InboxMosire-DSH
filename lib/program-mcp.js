/**
 * Detect whether one DSH agent can see a program-owned business tool.
 *
 * The adapter never provides these tools; it only uses this as a readiness
 * diagnostic. Claim-mode programs expose `inbox_claim`/`inbox_list`/
 * `inbox_view`; the iiBot view-ack lifecycle exposes
 * `qq_conversation_read`/`qq_conversation_ack`. Both unprefixed
 * (`qq_conversation_read`) and MCP-prefixed (`mcp__server__qq_conversation_read`)
 * names are accepted. Callers that cannot supply a wake mode fall back to the
 * union, so any recognized business tool is enough for the legacy diagnostic.
 */

import { WAKE_MODE } from './wake-mode.js'

export const CLAIM_BUSINESS_TOOL_NAMES = Object.freeze([
  'inbox_claim',
  'inbox_list',
  'inbox_view',
])

export const VIEW_ACK_BUSINESS_TOOL_NAMES = Object.freeze([
  'qq_conversation_read',
  'qq_conversation_ack',
])

const BUSINESS_TOOL_NAMES = Object.freeze([
  ...CLAIM_BUSINESS_TOOL_NAMES,
  ...VIEW_ACK_BUSINESS_TOOL_NAMES,
])

/**
 * Select the recognized tool set for one wake mode.
 * @param {unknown} wakeMode - claim, view-ack, or omitted.
 * @returns {readonly string[]} names accepted for the mode.
 */
function toolNamesForMode(wakeMode) {
  if (wakeMode === WAKE_MODE.CLAIM) return CLAIM_BUSINESS_TOOL_NAMES
  if (wakeMode === WAKE_MODE.VIEW_ACK) return VIEW_ACK_BUSINESS_TOOL_NAMES
  return BUSINESS_TOOL_NAMES
}

/**
 * Whether one schema name is a recognized business tool.
 * @param {unknown} name - tool name.
 * @param {unknown} [wakeMode] - optional claim/view-ack discriminator.
 * @returns {boolean} true when recognized.
 */
export function isBusinessToolName(name, wakeMode) {
  if (typeof name !== 'string' || name.length === 0) return false
  return toolNamesForMode(wakeMode).some(
    (tool) => name === tool || name.endsWith(`__${tool}`),
  )
}

/**
 * Inspect the live agent's visible tool schemas.
 * @param {any} agent - DSH agent.
 * @param {unknown} [wakeMode] - optional claim/view-ack discriminator.
 * @returns {boolean|undefined} true/false, or undefined when introspection is unavailable.
 */
export function hasBusinessTools(agent, wakeMode) {
  try {
    const tools = agent?.ctx?.tools
    if (!tools || typeof tools.schemas !== 'function') return undefined
    const names = tools
      .schemas()
      .map((schema) => schema?.name)
      .filter((name) => typeof name === 'string')
    return names.some((name) => isBusinessToolName(name, wakeMode))
  } catch {
    return undefined
  }
}
