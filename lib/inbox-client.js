/**
 * InboxMosire v1 HTTP + SSE client used by the wake adapter.
 *
 * The adapter is read-only: it may call `GET /status`, `GET /events`, and the
 * bounded `GET /items` summary endpoint, and nothing else. The token travels in
 * the `Authorization` header only — never in a URL, a thrown message, or a log
 * line.
 *
 * Wake tokens are opaque bearer credentials. The server enforces
 * `status:read` + `items:read`; the client never guesses scopes and never
 * persists or echoes the token. An `items` 403 is classified as an
 * authorization failure so the adapter can record `SUMMARY_FORBIDDEN` and
 * degrade to a no-summary wake.
 *
 * @module @mosire/dsh-inbox-mosire/lib/inbox-client
 */
import { SAFE_ID } from './config.js'

/** Stable adapter-side failure codes. */
export const CLIENT_ERROR = Object.freeze({
  AUTH: 'INBOX_AUTH',
  NOT_FOUND: 'INBOX_NOT_FOUND',
  INVALID_CURSOR: 'INBOX_INVALID_CURSOR',
  INVALID_ARGUMENT: 'INBOX_INVALID_ARGUMENT',
  HTTP: 'INBOX_HTTP',
  NETWORK: 'INBOX_NETWORK',
  PROTOCOL: 'INBOX_PROTOCOL',
  TIMEOUT: 'INBOX_TIMEOUT',
  ABORTED: 'INBOX_ABORTED',
})

/**
 * One classified InboxMosire request failure.
 */
export class InboxClientError extends Error {
  /**
   * @param {string} code - one of {@link CLIENT_ERROR}.
   * @param {string} message - safe, token-free explanation.
   * @param {object} [details] - status/code classification.
   * @param {number} [details.status] - HTTP status when one was received.
   * @param {string} [details.apiCode] - the contract's `error.code`.
   * @param {boolean} [details.retryable] - whether a reconnect may help.
   */
  constructor(code, message, { status, apiCode, retryable = false } = {}) {
    super(message)
    this.name = 'InboxClientError'
    this.code = code
    this.status = status
    this.apiCode = apiCode
    this.retryable = retryable
  }
}

/**
 * Parse an InboxMosire error body without trusting its shape.
 * @param {string} text - raw response body.
 * @returns {{code?: string, message?: string}} the contract error, if any.
 */
function parseErrorBody(text) {
  try {
    const body = JSON.parse(text)
    const error = body?.error
    if (error && typeof error === 'object') {
      return {
        code: typeof error.code === 'string' ? error.code : undefined,
        message: typeof error.message === 'string' ? error.message.slice(0, 300) : undefined,
      }
    }
  } catch {
    // A non-JSON body carries no contract information.
  }
  return {}
}

/**
 * Read a bounded JSON response body.
 * @param {Response} response - fetch response.
 * @param {number} maxBytes - hard cap.
 * @returns {Promise<unknown>} parsed JSON.
 */
async function readJson(response, maxBytes) {
  const text = await response.text()
  if (text.length > maxBytes) {
    throw new InboxClientError(CLIENT_ERROR.PROTOCOL, '响应体超过大小上限')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new InboxClientError(CLIENT_ERROR.PROTOCOL, '响应不是 JSON')
  }
}

/**
 * Validate the status document the state machine relies on.
 * @param {unknown} value - parsed JSON.
 * @returns {{inbox: string, revision: number, available: number, claimed: number, channels: Record<string, {available: number, claimed: number}>, updatedAt: string}} normalized status.
 */
export function normalizeStatus(value) {
  if (value === null || typeof value !== 'object') {
    throw new InboxClientError(CLIENT_ERROR.PROTOCOL, 'status 响应不是对象')
  }
  const status = /** @type {Record<string, any>} */ (value)
  const revision = Number(status.revision)
  const available = Number(status.available)
  const claimed = Number(status.claimed ?? 0)
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new InboxClientError(CLIENT_ERROR.PROTOCOL, 'status.revision 不是非负整数')
  }
  if (!Number.isSafeInteger(available) || available < 0) {
    throw new InboxClientError(CLIENT_ERROR.PROTOCOL, 'status.available 不是非负整数')
  }
  if (!Number.isSafeInteger(claimed) || claimed < 0) {
    throw new InboxClientError(CLIENT_ERROR.PROTOCOL, 'status.claimed 不是非负整数')
  }
  const channels =
    status.channels && typeof status.channels === 'object' && !Array.isArray(status.channels)
      ? Object.fromEntries(
          Object.entries(status.channels).map(([name, counts]) => [
            name,
            {
              available: Number(counts?.available ?? 0) || 0,
              claimed: Number(counts?.claimed ?? 0) || 0,
            },
          ]),
        )
      : {}
  return {
    inbox: typeof status.inbox === 'string' ? status.inbox : '',
    revision,
    available,
    claimed,
    channels,
    updatedAt: typeof status.updatedAt === 'string' ? status.updatedAt : '',
  }
}

/**
 * Project the summary endpoint's response onto the only fields the wake
 * message may carry.
 *
 * Anything not needed for a bounded summary — payload, payloadRef, claim
 * material, priority, attempts — is dropped before it can reach a caller,
 * the state document, or a log line.
 *
 * @param {unknown} value - parsed JSON.
 * @returns {{inbox: string, count: number, items: Array<{itemId: string, channel: string, kind: string, title: string}>}} safe summary.
 */
export function normalizeItems(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InboxClientError(CLIENT_ERROR.PROTOCOL, 'items 响应不是对象')
  }
  const body = /** @type {Record<string, any>} */ (value)
  if (!Array.isArray(body.items)) {
    throw new InboxClientError(CLIENT_ERROR.PROTOCOL, 'items 响应缺少 items 数组')
  }
  const items = []
  for (const raw of body.items.slice(0, 100)) {
    if (raw === null || typeof raw !== 'object') continue
    const itemId = typeof raw.itemId === 'string' ? raw.itemId.trim() : ''
    if (!itemId || itemId.length > 200) continue
    const channel = typeof raw.channel === 'string' ? raw.channel.trim() : ''
    if (!SAFE_ID.test(channel)) continue
    items.push({
      itemId,
      channel,
      kind: typeof raw.kind === 'string' ? raw.kind.slice(0, 200) : '',
      title: typeof raw.title === 'string' ? raw.title.slice(0, 4000) : '',
    })
  }
  const count = Number.isSafeInteger(body.count) && body.count >= 0
    ? body.count
    : items.length
  return {
    inbox: typeof body.inbox === 'string' ? body.inbox : '',
    count,
    items,
  }
}

/**
 * A read-only client for one inbox.
 */
export class InboxClient {
  /**
   * @param {object} options - client construction.
   * @param {string} options.apiUrl - origin of the InboxMosire daemon.
   * @param {string} options.inboxId - inbox id.
   * @param {string[]} [options.channels] - channel filter sent with `status`.
   * @param {string} options.token - adapter token (header only).
   * @param {typeof fetch} [options.fetchImpl] - injectable fetch.
   * @param {number} [options.requestTimeoutMs] - header/body timeout.
   * @param {number} [options.maxResponseBytes] - body cap.
   */
  constructor({
    apiUrl,
    inboxId,
    channels = [],
    token,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 10000,
    maxResponseBytes = 8 * 1024 * 1024,
  }) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('this runtime has no fetch implementation')
    }
    this.apiUrl = apiUrl
    this.inboxId = inboxId
    this.channels = channels
    this.token = token
    this.fetchImpl = fetchImpl
    this.requestTimeoutMs = requestTimeoutMs
    this.maxResponseBytes = maxResponseBytes
  }

  /** @returns {Record<string, string>} headers carrying the token. */
  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    }
  }

  /** @returns {string} encoded inbox path segment. */
  inboxPath() {
    return encodeURIComponent(this.inboxId)
  }

  /**
   * `GET /v1/inboxes/{inbox}/status`, filtered to configured channels.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<ReturnType<typeof normalizeStatus>>} normalized status.
   */
  async getStatus(signal) {
    const url = new URL(`${this.apiUrl}/v1/inboxes/${this.inboxPath()}/status`)
    for (const channel of this.channels) url.searchParams.append('channel', channel)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
      })
    } catch (error) {
      if (signal?.aborted) {
        throw new InboxClientError(CLIENT_ERROR.ABORTED, 'status 请求被取消')
      }
      if (error?.name === 'AbortError') {
        throw new InboxClientError(CLIENT_ERROR.TIMEOUT, 'status 请求超时', {
          retryable: true,
        })
      }
      throw new InboxClientError(
        CLIENT_ERROR.NETWORK,
        `status 请求失败: ${error?.code ?? error?.name ?? 'network'}`,
        { retryable: true },
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    if (!response.ok) throw await this.httpError(response, 'status')
    const body = await readJson(response, this.maxResponseBytes)
    return normalizeStatus(body)
  }

  /**
   * `GET /v1/inboxes/{inbox}/items?limit=N`, filtered to channels.
   *
   * This is the bounded summary read used immediately before a wake. It
   * requires a wake token with `status:read` + `items:read`; a 403 is returned
   * as {@link CLIENT_ERROR.AUTH} so the adapter can degrade to a no-summary
   * wake instead of suppressing it.
   *
   * @param {object} [options] - summary options.
   * @param {number} [options.limit] - item-line bound, 1..100.
   * @param {string[]} [options.channels] - channel filter; defaults to the client's.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<ReturnType<typeof normalizeItems>>} safe item summaries.
   */
  async getItems({ limit = 3, channels = this.channels, signal } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new InboxClientError(
        CLIENT_ERROR.INVALID_ARGUMENT,
        'items limit 必须是 1..100 的整数',
      )
    }
    const url = new URL(`${this.apiUrl}/v1/inboxes/${this.inboxPath()}/items`)
    url.searchParams.set('limit', String(limit))
    for (const channel of Array.isArray(channels) ? channels : []) {
      if (SAFE_ID.test(String(channel))) url.searchParams.append('channel', String(channel))
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
        cache: 'no-store',
      })
    } catch (error) {
      if (signal?.aborted) {
        throw new InboxClientError(CLIENT_ERROR.ABORTED, 'items 请求被取消')
      }
      if (error?.name === 'AbortError') {
        throw new InboxClientError(CLIENT_ERROR.TIMEOUT, 'items 请求超时', {
          retryable: true,
        })
      }
      throw new InboxClientError(
        CLIENT_ERROR.NETWORK,
        `items 请求失败: ${error?.code ?? error?.name ?? 'network'}`,
        { retryable: true },
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    if (!response.ok) throw await this.httpError(response, 'items')
    const body = await readJson(response, this.maxResponseBytes)
    return normalizeItems(body)
  }

  /**
   * Call the advisory occupancy endpoint.
   * @param {'GET'|'PUT'|'DELETE'} method - HTTP method.
   * @param {Record<string, unknown>} [body] - JSON body for PUT.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<Record<string, any>|null>} occupancy document, or null for 204.
   */
  async occupancyRequest(method, body, signal) {
    const url = new URL(`${this.apiUrl}/v1/inboxes/${this.inboxPath()}/occupancy`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    let response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          ...this.headers(),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (signal?.aborted) {
        throw new InboxClientError(CLIENT_ERROR.ABORTED, 'occupancy 请求被取消')
      }
      if (error?.name === 'AbortError') {
        throw new InboxClientError(CLIENT_ERROR.TIMEOUT, 'occupancy 请求超时', {
          retryable: true,
        })
      }
      throw new InboxClientError(
        CLIENT_ERROR.NETWORK,
        `occupancy 请求失败: ${error?.code ?? error?.name ?? 'network'}`,
        { retryable: true },
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    if (!response.ok) throw await this.httpError(response, `occupancy ${method}`)
    if (response.status === 204) return null
    return readJson(response, this.maxResponseBytes)
  }

  /**
   * Mark the inbox as occupied by one session (advisory).
   * @param {string} occupiedBy - authoritative session id.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<Record<string, any>|null>} occupancy document.
   */
  putOccupancy(occupiedBy, signal) {
    return this.occupancyRequest('PUT', { occupiedBy }, signal)
  }

  /**
   * Clear the advisory occupancy mark.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<Record<string, any>|null>} occupancy document.
   */
  deleteOccupancy(signal) {
    return this.occupancyRequest('DELETE', undefined, signal)
  }

  /**
   * Read the advisory occupancy mark.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<Record<string, any>|null>} occupancy document.
   */
  getOccupancy(signal) {
    return this.occupancyRequest('GET', undefined, signal)
  }

  /**
   * Classify a non-2xx response.
   * @param {Response} response - failed response.
   * @param {string} operation - `status` or `events`, for the message.
   * @returns {Promise<InboxClientError>} the classified error.
   */
  async httpError(response, operation) {
    const text = await response.text().catch(() => '')
    const parsed = parseErrorBody(text)
    const status = response.status
    const suffix = `HTTP ${status}${parsed.code ? ` ${parsed.code}` : ''}`
    if (status === 401 || status === 403) {
      return new InboxClientError(CLIENT_ERROR.AUTH, `${operation}: 鉴权失败 (${suffix})`, {
        status,
        apiCode: parsed.code,
      })
    }
    if (status === 404) {
      return new InboxClientError(CLIENT_ERROR.NOT_FOUND, `${operation}: inbox 不存在 (${suffix})`, {
        status,
        apiCode: parsed.code,
      })
    }
    if (status === 400 && (parsed.code === 'INVALID_CURSOR' || /cursor/i.test(parsed.message ?? ''))) {
      return new InboxClientError(
        CLIENT_ERROR.INVALID_CURSOR,
        `${operation}: SSE cursor 无效 (${suffix})`,
        { status, apiCode: parsed.code },
      )
    }
    return new InboxClientError(
      CLIENT_ERROR.HTTP,
      `${operation}: ${suffix}${parsed.message ? `: ${parsed.message}` : ''}`,
      { status, apiCode: parsed.code, retryable: status >= 500 || status === 429 },
    )
  }

  /**
   * Open the inbox event stream until the caller aborts.
   *
   * Resolves only after a clean close (caller abort); every other ending is
   * thrown so the reconnect loop can classify it.
   *
   * @param {object} options - stream options.
   * @param {number|null} [options.lastEventId] - SSE cursor.
   * @param {AbortSignal} options.signal - caller cancellation.
   * @param {(event: {id: number|null, type: string, data: string}) => void} options.onEvent - one dispatched frame.
   * @param {(info: {lastEventId: number|null}) => void} [options.onOpen] - headers accepted.
   * @param {() => void} [options.onHeartbeat] - any bytes received (comment or frame).
   * @param {number} [options.heartbeatTimeoutMs] - silence budget.
   * @returns {Promise<{reason: 'aborted'|'timeout'|'closed'}>} how the stream ended.
   */
  async streamEvents({
    lastEventId = null,
    signal,
    onEvent,
    onOpen,
    onHeartbeat,
    heartbeatTimeoutMs = 45000,
  }) {
    const url = new URL(`${this.apiUrl}/v1/inboxes/${this.inboxPath()}/events`)
    const headers = this.headers()
    headers.Accept = 'text/event-stream'
    if (Number.isSafeInteger(lastEventId) && lastEventId !== null) {
      headers['Last-Event-ID'] = String(lastEventId)
    }

    const controller = new AbortController()
    let timedOut = false
    let watchdog = null
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, Math.max(1000, heartbeatTimeoutMs))
      watchdog.unref?.()
    }
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    armWatchdog()

    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
        cache: 'no-store',
      })
    } catch (error) {
      clearTimeout(watchdog)
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return { reason: 'aborted' }
      if (timedOut) return { reason: 'timeout' }
      if (error?.name === 'AbortError') return { reason: 'aborted' }
      throw new InboxClientError(
        CLIENT_ERROR.NETWORK,
        `events 连接失败: ${error?.code ?? error?.name ?? 'network'}`,
        { retryable: true },
      )
    }

    if (!response.ok) {
      clearTimeout(watchdog)
      signal?.removeEventListener('abort', onAbort)
      throw await this.httpError(response, 'events')
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      clearTimeout(watchdog)
      signal?.removeEventListener('abort', onAbort)
      controller.abort()
      throw new InboxClientError(
        CLIENT_ERROR.PROTOCOL,
        `events 响应不是 text/event-stream (${contentType || 'missing content-type'})`,
        { retryable: true },
      )
    }
    if (!response.body) {
      clearTimeout(watchdog)
      signal?.removeEventListener('abort', onAbort)
      throw new InboxClientError(CLIENT_ERROR.PROTOCOL, 'events 响应没有 body', {
        retryable: true,
      })
    }

    onOpen?.({ lastEventId })

    let buffer = ''
    let frameId = null
    let frameType = 'message'
    let dataLines = []
    const decoder = new TextDecoder('utf-8')

    /**
     * Handle one complete SSE line.
     * @param {string} line - line without its terminator.
     */
    const handleLine = (line) => {
      if (line === '') {
        if (dataLines.length > 0 || frameType !== 'message' || frameId !== null) {
          const id = frameId !== null && /^\d+$/.test(frameId) ? Number(frameId) : null
          onEvent({ id, type: frameType, data: dataLines.join('\n') })
        }
        frameId = null
        frameType = 'message'
        dataLines = []
        return
      }
      if (line.startsWith(':')) return
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      switch (field) {
        case 'id':
          frameId = value
          break
        case 'event':
          frameType = value || 'message'
          break
        case 'data':
          dataLines.push(value)
          break
        case 'retry':
          break
        default:
          break
      }
    }

    try {
      for await (const chunk of response.body) {
        armWatchdog()
        onHeartbeat?.()
        buffer += decoder.decode(chunk, { stream: true })
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '')
          buffer = buffer.slice(index + 1)
          handleLine(line)
        }
        if (buffer.length > 1024 * 1024) {
          throw new InboxClientError(CLIENT_ERROR.PROTOCOL, 'SSE 单行超过大小上限')
        }
      }
    } catch (error) {
      if (signal?.aborted) return { reason: 'aborted' }
      if (timedOut) return { reason: 'timeout' }
      if (error instanceof InboxClientError) {
        error.retryable = true
        throw error
      }
      if (error?.name === 'AbortError') {
        return { reason: timedOut ? 'timeout' : 'aborted' }
      }
      throw new InboxClientError(
        CLIENT_ERROR.NETWORK,
        `events 读取中断: ${error?.code ?? error?.name ?? 'stream'}`,
        { retryable: true },
      )
    } finally {
      clearTimeout(watchdog)
      signal?.removeEventListener('abort', onAbort)
    }

    if (signal?.aborted) return { reason: 'aborted' }
    if (timedOut) return { reason: 'timeout' }
    return { reason: 'closed' }
  }
}
