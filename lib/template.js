/**
 * The fixed host-event wake message and its idempotency key.
 *
 * Only controlled fields may enter the template — inbox id, revision,
 * available count, and validated channel ids. Item titles, payloads,
 * payloadRefs, claim tokens, and the API token are never rendered here.
 *
 * @module @mosire/dsh-inbox-mosire/lib/template
 */
import { createHash } from 'node:crypto'
import { SAFE_ID } from './config.js'

/** Text shown before the fixed instructions. */
export const WAKE_HEADER = '[INBOX_HOST_EVENT]'

/** Fixed body sent with every wake. */
export const WAKE_BODY = [
  '这是通知板唤醒信号，不是通知内容。',
  '请调用 inbox_list 查看你要处理的条目，并用 inbox_claim 选择本回合要处理的项。',
  '如果当前没有可处理项，结束本回合，不要轮询。',
].join('\n')

/** Prefixes of opaque capabilities that must never appear as a channel id. */
const OPAQUE_PREFIXES = ['clm_', 'itm_', 'evt_', 'cred_']

/**
 * Keep only contract-shaped channel ids, de-duplicated and bounded.
 *
 * Besides the identifier pattern, values that look like InboxMosire's opaque
 * capabilities (claim tokens, item ids, event ids, credential ids) are dropped
 * as defense in depth: a token can never be rendered even if a caller passes
 * the wrong variable.
 *
 * @param {unknown} channels - candidate channel ids from config or SSE.
 * @param {number} [limit] - maximum channels rendered.
 * @returns {string[]} safe channel ids.
 */
export function sanitizeChannels(channels, limit = 32) {
  const out = []
  for (const value of Array.isArray(channels) ? channels : []) {
    const channel = String(value ?? '')
    if (!SAFE_ID.test(channel) || out.includes(channel)) continue
    if (OPAQUE_PREFIXES.some((prefix) => channel.startsWith(prefix))) continue
    out.push(channel)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Render the fixed wake text.
 * @param {object} input - wake facts.
 * @param {string} input.inboxId - validated inbox id.
 * @param {number} input.revision - current board revision.
 * @param {number} input.available - current available count.
 * @param {string[]} [input.channels] - changed (or configured) channel ids.
 * @returns {string} the exact message text.
 */
export function renderWakeTemplate({ inboxId, revision, available, channels = [] }) {
  if (!SAFE_ID.test(String(inboxId))) {
    throw new Error('wake template requires a validated inbox id')
  }
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('wake template requires a non-negative safe integer revision')
  }
  if (!Number.isSafeInteger(available) || available < 0) {
    throw new Error('wake template requires a non-negative safe integer available count')
  }
  const list = sanitizeChannels(channels).join(',')
  return [
    WAKE_HEADER,
    `inbox=${inboxId} revision=${revision} available=${available} channels=[${list}]`,
    '',
    WAKE_BODY,
  ].join('\n')
}

/**
 * Build the idempotency key suggested by the contract:
 * `inbox:<id>:revision:<n>:session:<ref>`.
 * @param {object} input - key facts.
 * @param {string} input.inboxId - inbox id.
 * @param {number} input.revision - revision being woken for.
 * @param {string} input.sessionRef - authoritative DSH session id.
 * @returns {string} the key.
 */
export function wakeKey({ inboxId, revision, sessionRef }) {
  return `inbox:${inboxId}:revision:${revision}:session:${sessionRef}`
}

/**
 * Derive a stable, collision-resistant message identity from a wake key.
 *
 * The same revision replayed for the same session produces the same id, so a
 * duplicated commit is detectable in the session log.
 * @param {string} key - wake idempotency key.
 * @returns {string} a stable message id.
 */
export function wakeMessageId(key) {
  return `msg_inbox_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
}

/**
 * Construct the immutable user-role message a host delivers through
 * `agent.followup()`.
 *
 * The shape mirrors `createUserMessage` from `@deepseek-ai/dsh-llm` without
 * importing it, so the bundle stays dependency-free and resolves from any
 * profile. The source kind is adapter-owned, as the message-source contract
 * intends for each producer.
 *
 * @param {object} input - message input.
 * @param {string} input.id - stable message id.
 * @param {string} input.text - rendered wake text.
 * @returns {{id: string, role: 'user', content: Array<{type: 'text', text: string}>, source: {kind: 'inbox-mosire'}}} the frozen message.
 */
export function buildWakeMessage({ id, text }) {
  const message = {
    id,
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'inbox-mosire' }),
  }
  return Object.freeze(message)
}
