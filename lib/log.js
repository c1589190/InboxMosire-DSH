/**
 * Adapter logging: redaction, an in-memory tail for `/inbox status`, and an
 * optional JSONL append log next to the persisted state.
 *
 * A token must never reach a log line. Every message is redacted before it is
 * written to the Cordis logger or to disk, and the configured token is never
 * included in a structured field.
 *
 * @module @mosire/dsh-inbox-mosire/lib/log
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { redact } from './config.js'

/** Rotate the append log once it exceeds this size. */
const MAX_LOG_BYTES = 2 * 1024 * 1024

/**
 * Create one redacting logger.
 * @param {object} options - logger construction.
 * @param {{info: Function, warn: Function, error: Function, debug?: Function}} options.base - Cordis logger facade.
 * @param {string} [options.token] - secret to redact from every line.
 * @param {string} [options.file] - optional absolute JSONL log path.
 * @param {number} [options.tailSize] - in-memory line capacity.
 * @returns {{debug: Function, info: Function, warn: Function, error: Function, tail: Function, file: string|undefined, flush: Function, close: Function}}
 */
export function createLogger({ base, token, file, tailSize = 200 }) {
  /** @type {Array<{time: string, level: string, message: string}>} */
  const tail = []
  let ready = false
  let closed = false
  let pending = Promise.resolve()

  /**
   * Serialize one line to every sink.
   * @param {'debug'|'info'|'warn'|'error'} level - severity.
   * @param {string} message - already-redacted text.
   */
  function record(level, message) {
    const entry = { time: new Date().toISOString(), level, message }
    tail.push(entry)
    if (tail.length > tailSize) tail.splice(0, tail.length - tailSize)
    const line = `inbox-mosire: ${message}`
    if (level === 'error') base.error?.(line)
    else if (level === 'warn') base.warn?.(line)
    else base.info?.(line)
    if (file && !closed) {
      pending = pending
        .then(async () => {
          if (!ready) {
            await mkdir(dirname(file), { recursive: true, mode: 0o700 })
            ready = true
          }
          const info = await stat(file).catch(() => undefined)
          if (info && info.size > MAX_LOG_BYTES) {
            await rename(file, `${file}.1`)
          }
          await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
        })
        .catch(() => {})
    }
  }

  /**
   * Format a message and optional structured fields, then redact them.
   * @param {string} message - message template.
   * @param {Record<string, unknown>} [fields] - structured context.
   * @returns {string} one safe line.
   */
  function format(message, fields) {
    let text = String(message)
    if (fields && Object.keys(fields).length > 0) {
      text += ` ${JSON.stringify(fields)}`
    }
    return redact(text, token)
  }

  return {
    debug: (message, fields) => record('debug', format(message, fields)),
    info: (message, fields) => record('info', format(message, fields)),
    warn: (message, fields) => record('warn', format(message, fields)),
    error: (message, fields) => record('error', format(message, fields)),
    /** @returns {Array<{time: string, level: string, message: string}>} recent lines, oldest first. */
    tail: (count = 20) => tail.slice(-count),
    file,
    /** Wait for queued file writes. */
    flush: () => pending,
    /** Stop accepting file writes and drain the queue. */
    close: async () => {
      closed = true
      await pending
    },
  }
}
