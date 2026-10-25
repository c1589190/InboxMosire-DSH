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
  let occupant = null
  let occupiedAt = null
  let seq = 0
  let authMode = 'ok'
  let invalidCursor = false
  let silent = false
  let holdStatus = false
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
   * @param {object} [input] - push fields.
   * @param {string} [input.channel] - channel id.
   * @param {string} [input.title] - must never reach the adapter.
   * @param {object} [input.payload] - must never reach the adapter.
   * @returns {{revision: number}} resulting revision.
   */
  function push({ channel = 'ticket', title = 'SECRET-TITLE', payload = { body: 'SECRET-BODY' } } = {}) {
    void title
    void payload
    state.revision += 1
    counter(channel).available += 1
    state.available += 1
    publish([channel])
    return { revision: state.revision }
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

    const match = url.pathname.match(/^\/v1\/inboxes\/([^/]+)\/(status|events|occupancy)$/)
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
    push,
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
