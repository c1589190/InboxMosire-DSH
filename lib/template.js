/**
 * The bounded host-event wake message and its idempotency key.
 *
 * Only controlled fields and the four safe summary fields may enter the
 * template — inbox id, revision, available count, validated channel ids, and
 * `itemId/channel/kind/summary`. Content, payloads, payloadRefs, claim tokens,
 * and the API token are never rendered here.
 *
 * @module @mosire/dsh-inbox-mosire/lib/template
 */
import { createHash } from 'node:crypto'
import { SAFE_ID } from './config.js'

/** Text shown before the fixed instructions. */
export const WAKE_HEADER = '[INBOX_HOST_EVENT]'

/** Fixed body sent when no summary is available. */
export const WAKE_BODY = [
  '这是通知板唤醒信号，不是通知内容。',
  '请使用你的程序 MCP 的 inbox_list 查看你要处理的条目，并用 inbox_claim 选择本回合要处理的项。',
  '如果当前没有可处理项，结束本回合，不要轮询。',
].join('\n')

/** Warning shown when the target session has no program-MCP business tools. */
export const PROGRAM_MCP_WARNING =
  '注意：本会话未检测到程序 MCP 的 inbox_claim/inbox_list 工具；请先挂载程序 MCP，否则本回合无法处理。'

/** Fixed instructions appended after a bounded summary. */
export const SUMMARY_BODY = [
  '请直接通过你的程序 MCP 调用 inbox_claim 选择本回合要处理的 itemId；',
  '如果摘要不足，再调用 inbox_list。',
  '如果当前没有可处理项，结束本回合，不要轮询。',
].join('\n')

/** Prefixes of opaque capabilities that must never appear as a channel id. */
const OPAQUE_PREFIXES = ['clm_', 'itm_', 'evt_', 'cred_']

/** Control characters, including the Unicode line/paragraph separators. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g

/** A bounded opaque item id (`itm_…`). */
const SAFE_ITEM_ID = /^[A-Za-z0-9._:-]{1,128}$/

/** Defaults used when a caller omits a bound. */
const DEFAULT_MAX_ITEMS = 3
const DEFAULT_MAX_SUMMARY_CHARS = 80
const DEFAULT_MAX_TOTAL_CHARS = 600

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
 * Remove newlines and control characters, collapse whitespace, and trim.
 * @param {unknown} value - untrusted display text.
 * @returns {string} safe single-line text.
 */
function cleanText(value) {
  return String(value ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Bound text to a maximum number of Unicode code points.
 * @param {string} text - clean text.
 * @param {number} maxChars - inclusive bound.
 * @returns {string} text, with an ellipsis when truncated.
 */
function truncateText(text, maxChars) {
  const chars = [...text]
  if (chars.length <= maxChars) return text
  if (maxChars <= 1) return chars.slice(0, Math.max(0, maxChars)).join('')
  return `${chars.slice(0, maxChars - 1).join('')}…`
}

/**
 * Coerce one summary bound, falling back to the contract default.
 * @param {unknown} value - candidate.
 * @param {number} fallback - default.
 * @param {number} min - inclusive minimum.
 * @param {number} max - inclusive maximum.
 * @returns {number} bounded integer.
 */
function bounded(value, fallback, min, max) {
  if (!Number.isSafeInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * Project one API item into the four fields the wake message may show.
 *
 * Invalid ids are dropped rather than rendered: the model cannot claim a
 * malformed item, and dropping keeps the line safe. Content and payload
 * fields are never read, even if a server sends them.
 *
 * @param {unknown} item - candidate item from `GET /items`.
 * @param {number} maxSummaryChars - summary text bound.
 * @returns {{itemId: string, channel: string, kind: string, summary: string}|undefined} safe item.
 */
function safeSummaryItem(item, maxSummaryChars) {
  if (item === null || typeof item !== 'object') return undefined
  const record = /** @type {Record<string, unknown>} */ (item)
  const itemId = cleanText(record.itemId)
  if (!SAFE_ITEM_ID.test(itemId)) return undefined
  const channel = sanitizeChannels([record.channel])[0]
  if (!channel) return undefined
  const kind = truncateText(cleanText(record.kind) || 'item', 40)
  const cleanedSummary = truncateText(cleanText(record.summary), maxSummaryChars)
  const fallback = truncateText(`${kind}/${channel}`, maxSummaryChars)
  return {
    itemId,
    channel,
    kind,
    summary: cleanedSummary || fallback,
  }
}

/**
 * Render one bounded summary section.
 *
 * The budget covers only the summary block (intro, item lines, remaining
 * line); the fixed instructions are never truncated.
 *
 * @param {object} input - summary input.
 * @param {unknown[]} input.items - candidate items.
 * @param {number} input.available - total available items on the board.
 * @param {number} input.maxItems - maximum item lines.
 * @param {number} input.maxTitleChars - summary-text bound (historical name).
 * @param {number} input.maxTotalChars - summary block budget.
 * @param {number} [input.remaining] - caller-computed hidden count.
 * @returns {string|undefined} summary block, or undefined when nothing is showable.
 */
export function renderSummarySection({
  items,
  available,
  maxItems,
  maxTitleChars,
  maxTotalChars,
  remaining,
}) {
  const itemLimit = bounded(maxItems, DEFAULT_MAX_ITEMS, 1, 10)
  const summaryLimit = bounded(maxTitleChars, DEFAULT_MAX_SUMMARY_CHARS, 8, 200)
  const budget = bounded(maxTotalChars, DEFAULT_MAX_TOTAL_CHARS, 80, 4000)
  const safeItems = []
  for (const item of Array.isArray(items) ? items.slice(0, itemLimit) : []) {
    const safe = safeSummaryItem(item, summaryLimit)
    if (safe) safeItems.push(safe)
  }
  if (safeItems.length === 0) return undefined

  const intro = `摘要（最多 ${itemLimit} 条；可能已变化，claim 时以通知板为准）:`
  let block = intro
  let shown = 0
  for (const item of safeItems) {
    const next = `${block}\n- ${JSON.stringify(item)}`
    if (next.length > budget) break
    block = next
    shown += 1
  }
  if (shown === 0) return undefined

  const hiddenFromCaller =
    Number.isSafeInteger(remaining) && remaining > 0 ? remaining : 0
  let hidden = Math.max(hiddenFromCaller, Math.max(0, available - shown))
  if (hidden > 0) {
    const tail = `- 还有 ${hidden} 条未展示`
    if (`${block}\n${tail}`.length <= budget) {
      block = `${block}\n${tail}`
      hidden = 0
    }
  }
  return block
}

/**
 * Render the wake text.
 *
 * When `summary` is absent, empty, or unrenderable, the legacy fixed body is
 * used, so a summary failure always degrades to a normal wake instead of
 * suppressing it.
 *
 * @param {object} input - wake facts.
 * @param {string} input.inboxId - validated inbox id.
 * @param {number} input.revision - current board revision.
 * @param {number} input.available - current available count.
 * @param {string[]} [input.channels] - changed (or configured) channel ids.
 * @param {object} [input.summary] - bounded summary material.
 * @param {unknown[]} [input.summary.items] - summary items.
 * @param {number} [input.summary.remaining] - hidden item count.
 * @param {number} [input.summary.maxItems] - item-line bound.
 * @param {number} [input.summary.maxTitleChars] - summary-text bound (historical name).
 * @param {number} [input.summary.maxTotalChars] - block budget.
 * @param {boolean} [input.programMcpMissing] - add the missing-program-MCP warning.
 * @returns {string} the exact message text.
 */
export function renderWakeTemplate({
  inboxId,
  revision,
  available,
  channels = [],
  summary,
  programMcpMissing = false,
}) {
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
  const header = [
    WAKE_HEADER,
    `inbox=${inboxId} revision=${revision} available=${available} channels=[${list}]`,
  ]
  const section = summary
    ? renderSummarySection({
        items: summary.items,
        available,
        maxItems: summary.maxItems,
        maxTitleChars: summary.maxTitleChars,
        maxTotalChars: summary.maxTotalChars,
        remaining: summary.remaining,
      })
    : undefined
  const lines = [...header, '']
  if (section) lines.push(section, '')
  if (programMcpMissing) lines.push(PROGRAM_MCP_WARNING, '')
  lines.push(section ? SUMMARY_BODY : WAKE_BODY)
  return lines.join('\n')
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
