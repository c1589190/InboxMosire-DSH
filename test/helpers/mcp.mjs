/**
 * Minimal MCP Streamable HTTP client for the acceptance harness.
 *
 * The adapter itself never speaks MCP; this client stands in for the Agent
 * when an acceptance scenario needs to claim and complete notifications.
 */

/**
 * Parse one JSON-RPC response from either a JSON body or an SSE frame list.
 * @param {Response} response - MCP response.
 * @param {number|string} id - request id to match.
 * @returns {Promise<Record<string, any>>} the JSON-RPC response.
 */
async function readRpcResponse(response, id) {
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text()
  if (contentType.includes('text/event-stream')) {
    for (const block of text.split('\n\n')) {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
      if (!data) continue
      try {
        const message = JSON.parse(data)
        if (message.id === id) return message
      } catch {
        // A non-JSON frame is not the response.
      }
    }
    throw new Error('MCP stream returned no matching JSON-RPC response')
  }
  const message = JSON.parse(text)
  if (message.id !== id) throw new Error('MCP returned a mismatched JSON-RPC id')
  return message
}

/**
 * One MCP session against the InboxMosire tool server.
 */
export class McpClient {
  /**
   * @param {string} url - MCP endpoint (`/mcp`).
   */
  constructor(url) {
    this.url = url
    this.sessionId = null
    this.nextId = 1
  }

  /**
   * Send one JSON-RPC request.
   * @param {string} method - method name.
   * @param {Record<string, any>} params - parameters.
   * @returns {Promise<Record<string, any>>} the result.
   */
  async request(method, params = {}) {
    const id = this.nextId
    this.nextId += 1
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId
      headers['MCP-Protocol-Version'] = '2025-03-26'
    }
    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    if (!response.ok) {
      throw new Error(`MCP ${method} failed: HTTP ${response.status}`)
    }
    const sessionId = response.headers.get('mcp-session-id')
    if (sessionId) this.sessionId = sessionId
    const message = await readRpcResponse(response, id)
    if (message.error) {
      throw new Error(`MCP ${method} error: ${message.error.message ?? 'unknown'}`)
    }
    return message.result
  }

  /**
   * Initialize the MCP session.
   * @returns {Promise<void>} after initialization.
   */
  async init() {
    await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'inbox-mosire-acceptance', version: '0.1.0' },
    })
  }

  /**
   * Call one inbox tool and decode its JSON text result.
   * @param {string} name - tool name.
   * @param {Record<string, any>} args - tool arguments.
   * @returns {Promise<Record<string, any>>} decoded result.
   */
  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args })
    const text = result?.content?.find((block) => block.type === 'text')?.text ?? ''
    if (result?.isError || text.startsWith('[mosire:code=')) {
      throw new Error(`${name} rejected: ${text.split('\n')[0]}`)
    }
    return text ? JSON.parse(text) : {}
  }

  /**
   * List the available notifications on one inbox.
   * @param {string} inbox - inbox id.
   * @returns {Promise<Array<Record<string, any>>>} listed items.
   */
  async list(inbox) {
    const value = await this.callTool('inbox_list', { inbox })
    return Array.isArray(value.items) ? value.items : []
  }

  /**
   * Claim every available notification on one inbox.
   * @param {string} inbox - inbox id.
   * @returns {Promise<Array<Record<string, any>>>} claimed items with tokens.
   */
  async claimAll(inbox) {
    const items = await this.list(inbox)
    if (items.length === 0) return []
    const claimed = await this.callTool('inbox_claim', {
      inbox,
      itemIds: items.map((item) => item.itemId),
    })
    return Array.isArray(claimed.claimed) ? claimed.claimed : []
  }

  /**
   * Claim up to `count` available notifications.
   * @param {string} inbox - inbox id.
   * @param {number} count - maximum items to claim.
   * @returns {Promise<Array<Record<string, any>>>} claimed items with tokens.
   */
  async claimSome(inbox, count) {
    const items = await this.list(inbox)
    const selected = items.slice(0, count)
    if (selected.length === 0) return []
    const claimed = await this.callTool('inbox_claim', {
      inbox,
      itemIds: selected.map((item) => item.itemId),
    })
    return Array.isArray(claimed.claimed) ? claimed.claimed : []
  }

  /**
   * Complete every claim.
   * @param {string} inbox - inbox id.
   * @param {Array<Record<string, any>>} claimed - claim records.
   * @param {'completed'|'failed'} [outcome] - completion outcome.
   * @returns {Promise<Record<string, any>>} the completion result.
   */
  async completeAll(inbox, claimed, outcome = 'completed') {
    if (claimed.length === 0) return { available: 0 }
    return this.callTool('inbox_complete', {
      inbox,
      completions: claimed.map((item) => ({
        claimToken: item.claimToken,
        outcome,
        summary: 'acceptance harness',
      })),
    })
  }

  /**
   * Drain one inbox: claim then complete everything currently available.
   * @param {string} inbox - inbox id.
   * @returns {Promise<number>} number of drained items.
   */
  async drain(inbox) {
    const claimed = await this.claimAll(inbox)
    if (claimed.length > 0) await this.completeAll(inbox, claimed)
    return claimed.length
  }

  /** Best-effort MCP session teardown. */
  async close() {
    if (!this.sessionId) return
    await fetch(this.url, {
      method: 'DELETE',
      headers: {
        'Mcp-Session-Id': this.sessionId,
        'MCP-Protocol-Version': '2025-03-26',
      },
    }).catch(() => {})
    this.sessionId = null
  }
}
