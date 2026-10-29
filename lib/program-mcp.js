/**
 * Detect whether one DSH agent can see a program-owned business tool.
 *
 * The adapter never provides these tools; it only uses this as a readiness
 * diagnostic. Claim-mode programs expose `inbox_claim`/`inbox_list`/
 * `inbox_view`; a view-ack program's tools come from its named wake profile.
 * Both unprefixed (`qq_conversation_read`) and MCP-prefixed
 * (`mcp__server__qq_conversation_read`) names are accepted. A view-ack profile
 * that names no tools reports `undefined` (unknown), so the adapter never
 * invents a warning it cannot justify.
 */

import { WAKE_MODE } from './wake-mode.js'

export const CLAIM_BUSINESS_TOOL_NAMES = Object.freeze([
  'inbox_claim',
  'inbox_list',
  'inbox_view',
])

/** Retained for compatibility; profiles now supply view-ack tool names. */
export const VIEW_ACK_BUSINESS_TOOL_NAMES = Object.freeze([])

/**
 * Select the recognized tool set for one wake mode.
 * @param {unknown} wakeMode - claim, view-ack, or omitted.
 * @param {object} [profile] - named view-ack wake profile.
 * @returns {readonly string[]} names accepted for the mode.
 */
function toolNamesForMode(wakeMode, profile) {
  const viewAckTools = profile?.businessTools ?? []
  if (wakeMode === WAKE_MODE.CLAIM) return CLAIM_BUSINESS_TOOL_NAMES
  if (wakeMode === WAKE_MODE.VIEW_ACK) return viewAckTools
  return [...CLAIM_BUSINESS_TOOL_NAMES, ...viewAckTools]
}

/**
 * Whether one schema name is a recognized business tool.
 * @param {unknown} name - tool name.
 * @param {unknown} [wakeMode] - optional claim/view-ack discriminator.
 * @param {object} [profile] - named view-ack wake profile.
 * @returns {boolean} true when recognized.
 */
export function isBusinessToolName(name, wakeMode, profile) {
  if (typeof name !== 'string' || name.length === 0) return false
  return toolNamesForMode(wakeMode, profile).some(
    (tool) => name === tool || name.endsWith(`__${tool}`),
  )
}

/**
 * Inspect the live agent's visible tool schemas.
 * @param {any} agent - DSH agent.
 * @param {unknown} [wakeMode] - optional claim/view-ack discriminator.
 * @param {object} [profile] - named view-ack wake profile.
 * @returns {boolean|undefined} true/false, or undefined when the mode/profile
 * names no tools or introspection is unavailable.
 */
export function hasBusinessTools(agent, wakeMode, profile) {
  const candidates = toolNamesForMode(wakeMode, profile)
  if (candidates.length === 0) return undefined
  try {
    const tools = agent?.ctx?.tools
    if (!tools || typeof tools.schemas !== 'function') return undefined
    const names = tools
      .schemas()
      .map((schema) => schema?.name)
      .filter((name) => typeof name === 'string')
    return names.some((name) => isBusinessToolName(name, wakeMode, profile))
  } catch {
    return undefined
  }
}
