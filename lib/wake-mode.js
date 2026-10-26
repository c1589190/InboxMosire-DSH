/**
 * Wake processing modes.
 *
 * `claim` keeps the original claim-based program lifecycle. `view-ack` is for
 * programs that inspect an item and archive it themselves without claiming,
 * such as the bot-first message board.
 */

/** Supported wake modes. */
export const WAKE_MODE = Object.freeze({
  CLAIM: 'claim',
  VIEW_ACK: 'view-ack',
})

const WAKE_MODES = new Set(Object.values(WAKE_MODE))

/**
 * Normalize a configured wake mode.
 * @param {unknown} value - candidate.
 * @param {string} [fallback] - mode used when absent/invalid.
 * @returns {string} supported mode.
 */
export function normalizeWakeMode(value, fallback = WAKE_MODE.CLAIM) {
  if (typeof value === 'string' && WAKE_MODES.has(value)) return value
  return WAKE_MODES.has(fallback) ? fallback : WAKE_MODE.CLAIM
}

/**
 * Whether a value is a supported wake mode.
 * @param {unknown} value - candidate.
 * @returns {boolean} true when supported.
 */
export function isWakeMode(value) {
  return typeof value === 'string' && WAKE_MODES.has(value)
}
