/**
 * Detect whether one DSH agent can see a program-owned Inbox business tool.
 *
 * The adapter never provides these tools; it only uses this as a readiness
 * diagnostic. Accept both unprefixed (`inbox_list`) and MCP-prefixed
 * (`mcp__server__inbox_list`) names, and include `inbox_view` so no-claim
 * programs are recognized.
 */

const BUSINESS_TOOL_NAMES = ['inbox_claim', 'inbox_list', 'inbox_view']

/**
 * Whether one schema name is a recognized Inbox business tool.
 * @param {unknown} name - tool name.
 * @returns {boolean} true when recognized.
 */
export function isBusinessToolName(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  return BUSINESS_TOOL_NAMES.some(
    (tool) => name === tool || name.endsWith(`__${tool}`),
  )
}

/**
 * Inspect the live agent's visible tool schemas.
 * @param {any} agent - DSH agent.
 * @returns {boolean|undefined} true/false, or undefined when introspection is unavailable.
 */
export function hasBusinessTools(agent) {
  try {
    const tools = agent?.ctx?.tools
    if (!tools || typeof tools.schemas !== 'function') return undefined
    const names = tools
      .schemas()
      .map((schema) => schema?.name)
      .filter((name) => typeof name === 'string')
    return names.some(isBusinessToolName)
  } catch {
    return undefined
  }
}
