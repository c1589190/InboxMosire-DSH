/**
 * Sanitize an untrusted Inbox item `source` address for wake display.
 *
 * A source is a locator value, never an instruction. The adapter keeps it
 * single-line, strips control characters, trims surrounding whitespace, and
 * applies a hard length bound before it can reach a wake summary.
 *
 * @module @mosire/dsh-inbox-mosire/lib/source
 */

/** Maximum source address length retained in a wake summary. */
export const MAX_SOURCE_CHARS = 512

/** Control characters, including the Unicode line/paragraph separators. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g

/**
 * Clean one optional source value.
 *
 * Only strings are accepted. Empty or control-only values normalize to an
 * empty string so callers can omit the field entirely.
 *
 * @param {unknown} value - candidate source from an API item.
 * @returns {string} bounded, single-line source, or an empty string.
 */
export function sanitizeSource(value) {
  if (typeof value !== 'string') return ''
  const cleaned = value
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  return cleaned.slice(0, MAX_SOURCE_CHARS)
}
