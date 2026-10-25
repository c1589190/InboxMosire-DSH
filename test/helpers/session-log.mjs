/**
 * Read DSH's durable session log (`session.v4.jsonl.zstd`) for acceptance
 * evidence.
 *
 * The log is a sequence of independently compressed zstd frames appended per
 * checkpoint, so the reader splits on the frame magic and decompresses each
 * frame before parsing the JSONL records.
 */
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Zstd frame magic number. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Derive the DSH sessions-directory slug for one working directory.
 * @param {string} cwd - absolute session working directory.
 * @returns {string} directory name.
 */
export function cwdSlug(cwd) {
  return `--${cwd.replace(/^\//, '').replace(/[\\/]/g, '-')}--`
}

/**
 * Locate the session log directory for one session.
 * @param {string} sessionId - session id.
 * @param {string} cwd - absolute session working directory.
 * @param {string} [dshHome] - DSH home, defaults to `$DSH_HOME` or `~/.dsh`.
 * @returns {Promise<string|undefined>} the session directory.
 */
export async function sessionDir(sessionId, cwd, dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  const root = join(dshHome, 'sessions')
  const candidates = [join(root, cwdSlug(cwd), sessionId)]
  for (const candidate of candidates) {
    try {
      const entries = await readdir(candidate)
      if (entries.length > 0) return candidate
    } catch {
      // Try the next candidate.
    }
  }
  try {
    for (const slug of await readdir(root)) {
      const candidate = join(root, slug, sessionId)
      const entries = await readdir(candidate).catch(() => [])
      if (entries.length > 0) return candidate
    }
  } catch {
    // No sessions root.
  }
  return undefined
}

/**
 * Decompress every zstd frame in a buffer.
 * @param {Buffer} buffer - concatenated frames.
 * @returns {string} decoded text.
 */
export function decompressFrames(buffer) {
  const offsets = []
  let index = 0
  while ((index = buffer.indexOf(ZSTD_MAGIC, index)) !== -1) {
    offsets.push(index)
    index += ZSTD_MAGIC.length
  }
  const chunks = []
  for (let position = 0; position < offsets.length; position += 1) {
    const start = offsets[position]
    const end = offsets[position + 1] ?? buffer.length
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
    } catch {
      // A partially written trailing frame is ignored until the next read.
    }
  }
  return chunks.join('')
}

/**
 * Read and parse every complete event of a session log.
 * @param {string} directory - session directory.
 * @param {string} [file] - log file name.
 * @returns {Promise<Array<Record<string, any>>>} parsed records in order.
 */
export async function readSessionEvents(directory, file = 'session.v4.jsonl.zstd') {
  let buffer
  try {
    buffer = await readFile(join(directory, file))
  } catch {
    return []
  }
  const text = decompressFrames(buffer)
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // A frame may end mid-line while a writer is appending.
    }
  }
  return events
}

/**
 * Select host-event wake messages from a session log.
 * @param {Array<Record<string, any>>} events - parsed session records.
 * @returns {Array<Record<string, any>>} `user/message` records owned by the adapter.
 */
export function wakeMessages(events) {
  return events.filter(
    (event) =>
      event.type === 'user/message' && event.data?.source?.kind === 'inbox-mosire',
  )
}

/**
 * Select tool call records from a session log.
 * @param {Array<Record<string, any>>} events - parsed session records.
 * @returns {Array<Record<string, any>>} `tool/call` records.
 */
export function toolCalls(events) {
  return events.filter((event) => event.type === 'tool/call')
}
