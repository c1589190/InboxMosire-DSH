/**
 * Minimal InboxMosire v1 server for adapter tests: status, SSE with
 * Last-Event-ID replay, forced disconnects, and failure injection.
 *
 * The model mirrors the frozen contract, not the Java implementation: SSE
 * frames are invalidations only, and status is the source of truth.
 */
import { createServer } from 'node:http'

/**
 * Start a fake inbox daemon on an ephemeral port.
 * @param {object} [options] - server options.
 * @param {string} [options.token] - required bearer token.
 * @param {string} [options.inbox] - inbox id.
 * @param {number} [options.heartbeatMs] - `: ping` interval; 0 disables.
 * @returns {Promise<Record<string, any>>} handle with URL and controls.
 */
export async function startFakeInbox({
  token = 'test-token',
  inbox = 'smoke',
  heartbeatMs = 0,
} = {}) {
  const state = {
    revision: 0,
    available: 0,
    claimed: 0,
    channels: new Map(),
  }
  const history = []
  const clients = new Set()
  const requests = []
  const connections = []
  const occupancyCalls = []
  const itemsCalls = []
  const availableItems = []
  const claimedItems = []
  const itemsModes = new Set()
  let occupant = null
  let occupiedAt = null
  let seq = 0
  let itemSeq = 0
  let authMode = 'ok'
  let invalidCursor = false
  let silent = false
  let holdStatus = false
  let holdItems = false
  let closed = false

  /**
   * Ensure a channel counter exists.
   * @param {string} channel - channel id.
   * @returns {{available: number, claimed: number}} counter.
   */
  function counter(channel) {
    if (!state.channels.has(channel)) {
      state.channels.set(channel, { available: 0, claimed: 0 })
    }
    return state.channels.get(channel)
  }

  /**
   * Render the current status document.
   * @param {string[]} filter - channel filter.
   * @returns {Record<string, any>} status.
   */
  function statusDocument(filter = []) {
    const names = filter.length > 0
      ? [...state.channels.keys()].filter((name) => filter.includes(name))
      : [...state.channels.keys()]
    const channels = {}
    let available = 0
    let claimed = 0
    for (const name of names) {
      const counts = state.channels.get(name)
      channels[name] = { available: counts.available, claimed: counts.claimed }
      available += counts.available
      claimed += counts.claimed
    }
    return {
      inbox,
      revision: state.revision,
      available,
      claimed,
      channels,
      updatedAt: new Date().toISOString(),
      occupied: occupant !== null,
      occupiedBy: occupant,
      occupiedAt,
    }
  }

  /**
   * Publish one `inbox.changed` frame to every connected client.
   * @param {string[]} changedChannels - changed channels.
   */
  function publish(changedChannels) {
    seq += 1
    const channels = {}
    for (const [name, counts] of state.channels) {
      channels[name] = { available: counts.available, claimed: counts.claimed }
    }
    const data = {
      specversion: '1.0',
      id: `evt_${seq}`,
      source: `urn:inboxmosire:inbox:${inbox}`,
      type: 'io.mosire.inbox.changed.v1',
      subject: inbox,
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: {
        inbox,
        revision: state.revision,
        available: state.available,
        claimed: state.claimed,
        channels,
        changedChannels,
      },
    }
    const frame = {
      id: seq,
      body: `id: ${seq}\nevent: inbox.changed\ndata: ${JSON.stringify(data)}\n\n`,
    }
    history.push(frame)
    for (const client of clients) {
      client.res.write(frame.body)
    }
  }

  /**
   * Push one notification (producer path).
   *
   * New items carry `summary`; `legacyTitle: true` emits a title-only item so
   * the adapter's fallback can be exercised. `aliasTitle` lets a test prove
   * that `summary` wins over the legacy alias.
   *
   * @param {object} [input] - push fields.
   * @param {string} [input.channel] - channel id.
   * @param {string} [input.kind] - item kind.
   * @param {string} [input.summary] - short summary shown by the adapter.
   * @param {string} [input.title] - summary text, or the legacy title.
   * @param {string} [input.aliasTitle] - legacy title returned beside summary.
   * @param {boolean} [input.legacyTitle] - emit a title-only legacy item.
   * @param {boolean} [input.summaryOnly] - omit the title alias.
   * @param {string} [input.content] - never returned by `/items`.
   * @param {object} [input.payload] - never returned by `/items`.
   * @returns {{revision: number, itemId: string}} resulting revision.
   */
  function push(input = {}) {
    const channel = input.channel ?? 'ticket'
    const kind = input.kind ?? 'reply'
    const title = input.title ?? 'SECRET-TITLE'
    const summary = input.summary ?? title
    itemSeq += 1
    const itemId = `itm_fake_${itemSeq}`
    const item = {
      itemId,
      channel,
      kind,
      priority: 0,
      attempts: 0,
      createdAt: new Date().toISOString(),
    }
    if (input.legacyTitle === true) {
      item.title = title
    } else {
      item.summary = summary
      if (input.summaryOnly !== true) item.title = input.aliasTitle ?? summary
    }
    void input.content
    void input.payload
    availableItems.push(item)
    state.revision += 1
    counter(channel).available += 1
    state.available += 1
    publish([channel])
    return { revision: state.revision, itemId }
  }

  /**
   * Replace one available item's summary (the `inbox_update` path) and publish
   * the revision change.
   * @param {string} itemId - target item.
   * @param {string} summary - new summary.
   * @returns {{revision: number, itemId: string}|undefined} new revision.
   */
  function updateSummary(itemId, summary) {
    const item = availableItems.find((entry) => entry.itemId === itemId)
    if (!item) return undefined
    item.summary = summary
    if (item.title !== undefined) item.title = summary
    state.revision += 1
    publish([item.channel])
    return { revision: state.revision, itemId }
  }

  /**
   * Simulate an agent claim.
   * @param {string} channel - channel id.
   * @param {number} count - items claimed.
   * @returns {{revision: number, available: number}} board counts.
   */
  function claim(channel, count) {
    const counts = counter(channel)
    const moved = Math.min(count, counts.available)
    const moving = availableItems
      .filter((item) => item.channel === channel)
      .slice(0, moved)
    for (const item of moving) {
      const index = availableItems.indexOf(item)
      if (index >= 0) availableItems.splice(index, 1)
      claimedItems.push(item)
    }
    counts.available -= moved
    counts.claimed += moved
    state.available -= moved
    state.claimed += moved
    if (moved > 0) {
      state.revision += 1
      publish([channel])
    }
    return { revision: state.revision, available: state.available }
  }

  /**
   * Simulate an agent completion.
   * @param {string} channel - channel id.
   * @param {number} count - items completed.
   * @returns {{revision: number, available: number}} board counts.
   */
  function complete(channel, count) {
    const counts = counter(channel)
    const moved = Math.min(count, counts.claimed)
    let remaining = moved
    for (let index = claimedItems.length - 1; index >= 0 && remaining > 0; index -= 1) {
      if (claimedItems[index].channel !== channel) continue
      claimedItems.splice(index, 1)
      remaining -= 1
    }
    counts.claimed -= moved
    state.claimed -= moved
    if (moved > 0) {
      state.revision += 1
      publish([channel])
    }
    return { revision: state.revision, available: state.available }
  }

  /**
   * Simulate an agent releasing a claim without completing it.
   * @param {string} channel - channel id.
   * @param {number} count - items released.
   * @returns {{revision: number, available: number}} board counts.
   */
  function release(channel, count) {
    const counts = counter(channel)
    const moved = Math.min(count, counts.claimed)
    let remaining = moved
    for (let index = claimedItems.length - 1; index >= 0 && remaining > 0; index -= 1) {
      if (claimedItems[index].channel !== channel) continue
      availableItems.push(...claimedItems.splice(index, 1))
      remaining -= 1
    }
    counts.claimed -= moved
    counts.available += moved
    state.claimed -= moved
    state.available += moved
    if (moved > 0) {
      state.revision += 1
      publish([channel])
    }
    return { revision: state.revision, available: state.available }
  }

  /**
   * Close every live SSE response, forcing a client reconnect.
   */
  function disconnectAll() {
    for (const client of clients) {
      client.res.end()
    }
    clients.clear()
  }

  /**
   * Read and parse one JSON request body.
   * @param {import('node:http').IncomingMessage} req - request.
   * @returns {Promise<Record<string, any>>} parsed body.
   */
  async function readJsonBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    return text ? JSON.parse(text) : {}
  }

  /**
   * Current occupancy document.
   * @returns {Record<string, any>} occupancy.
   */
  function occupancyDocument() {
    return {
      inboxId: inbox,
      occupied: occupant !== null,
      occupiedBy: occupant,
      occupiedAt,
      updatedAt: new Date().toISOString(),
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake')
    requests.push({ method: req.method, path: url.pathname, search: url.search })
    const auth = req.headers.authorization ?? ''
    if (authMode === '401' || authMode === '403' || auth !== `Bearer ${token}`) {
      const status = authMode === '403' ? 403 : 401
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: {
          code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
          message: status === 401 ? 'missing or invalid token' : 'token lacks scope',
        },
      }))
      return
    }

    const match = url.pathname.match(/^\/v1\/inboxes\/([^/]+)\/(status|events|occupancy|items)$/)
    if (!match || decodeURIComponent(match[1]) !== inbox) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'inbox not found' } }))
      return
    }

    if (match[2] === 'occupancy') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(occupancyDocument()))
        return
      }
      if (req.method === 'PUT') {
        const body = await readJsonBody(req).catch(() => null)
        if (!body || typeof body.occupiedBy !== 'string' || body.occupiedBy === '') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'INVALID_ARGUMENT', message: 'occupiedBy required' } }))
          return
        }
        occupancyCalls.push({ method: 'PUT', occupiedBy: body.occupiedBy })
        if (occupant === null) {
          occupant = body.occupiedBy
          occupiedAt = new Date().toISOString()
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(occupancyDocument()))
        return
      }
      if (req.method === 'DELETE') {
        occupancyCalls.push({ method: 'DELETE' })
        occupant = null
        occupiedAt = null
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(occupancyDocument()))
        return
      }
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'occupancy' } }))
      return
    }

    if (match[2] === 'items') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'items' } }))
        return
      }
      const filter = url.searchParams.getAll('channel')
      const rawLimit = url.searchParams.get('limit')
      itemsCalls.push({ search: url.search, channels: filter, limit: rawLimit, at: Date.now() })
      if (holdItems) return
      if (itemsModes.has('403')) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          error: { code: 'FORBIDDEN', message: 'token 缺少 scope: items:read' },
        }))
        return
      }
      if (itemsModes.has('500')) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'items failed' } }))
        return
      }
      if (itemsModes.has('malformed')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ inbox, count: 'many', items: 'not-an-array' }))
        return
      }
      const limit = rawLimit === null ? 50 : Number(rawLimit)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'INVALID_ARGUMENT', message: 'limit 必须在 1..100' } }))
        return
      }
      const visible = availableItems
        .filter((item) => filter.length === 0 || filter.includes(item.channel))
        .slice(0, limit)
        .map((item) => (itemsModes.has('payload')
          ? {
              ...item,
              content: 'SECRET-CONTENT',
              contentRef: '/secret/content-ref',
              payload: { body: 'SECRET-BODY' },
              payloadRef: '/secret/ref',
            }
          : item))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ inbox, count: visible.length, items: visible }))
      return
    }

    if (match[2] === 'status') {
      if (holdStatus) {
        // Deliberately never answer: exercises request timeouts.
        return
      }
      const filter = url.searchParams.getAll('channel')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(statusDocument(filter)))
      return
    }

    if (!String(req.headers.accept ?? '').includes('text/event-stream')) {
      res.writeHead(406, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'NOT_ACCEPTABLE', message: '需要 text/event-stream' } }))
      return
    }
    if (invalidCursor && req.headers['last-event-id'] !== undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'INVALID_CURSOR', message: 'cursor 已失效' } }))
      return
    }

    const lastEventId = Number(req.headers['last-event-id'] ?? NaN)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const client = { res, lastEventId: Number.isSafeInteger(lastEventId) ? lastEventId : null }
    clients.add(client)
    connections.push({ lastEventId: client.lastEventId, at: Date.now() })
    res.write(': connected\n\n')
    if (Number.isSafeInteger(lastEventId)) {
      for (const frame of history) {
        if (frame.id > lastEventId) res.write(frame.body)
      }
    }
    if (heartbeatMs > 0 && !silent) {
      client.timer = setInterval(() => {
        if (!silent) res.write(': ping\n\n')
      }, heartbeatMs)
      client.timer.unref?.()
    }
    req.on('close', () => {
      if (client.timer) clearInterval(client.timer)
      clients.delete(client)
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    inbox,
    state,
    history,
    requests,
    connections,
    occupancyCalls,
    itemsCalls,
    push,
    updateSummary,
    claim,
    complete,
    release,
    disconnectAll,
    statusDocument,
    get revision() {
      return state.revision
    },
    get available() {
      return state.available
    },
    /** Inject an authentication failure for subsequent requests. */
    setAuthMode(mode) {
      authMode = mode
    },
    /** Reject any request carrying a Last-Event-ID. */
    setInvalidCursor(value) {
      invalidCursor = value
    },
    /** Stop sending heartbeats while keeping connections open. */
    setSilent(value) {
      silent = value
    },
    /** Hang status requests instead of answering them. */
    setHoldStatus(value) {
      holdStatus = value
    },
    /** Hang item-summary requests instead of answering them. */
    setHoldItems(value) {
      holdItems = value
    },
    /** Inject one or more `/items` failure modes: 403, 500, malformed, payload. */
    setItemsMode(...modes) {
      itemsModes.clear()
      for (const mode of modes.flat()) {
        if (mode === 'ok') continue
        itemsModes.add(mode)
      }
    },
    /** Available item summaries, in push order. */
    availableItems,
    /** Claimed item summaries, in claim order. */
    claimedItems,
    /** Number of live SSE connections. */
    get connectionCount() {
      return clients.size
    },
    /** Current advisory occupant. */
    get occupant() {
      return occupant
    },
    /** Stop the server. */
    async close() {
      if (closed) return
      closed = true
      disconnectAll()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
