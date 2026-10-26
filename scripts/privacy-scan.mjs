#!/usr/bin/env node
/**
 * Privacy scan for the InboxMosire wake adapter.
 *
 * Verifies that no InboxMosire credential and no notification content appears
 * in:
 *   - this repository's files,
 *   - the adapter's persisted state, configuration, and log,
 *   - the DSH profile's host logs,
 *   - every `user/message` the adapter committed to a DSH session log.
 *
 * Secrets are read from their local files and never printed. Exit code 1 means
 * at least one leak was found (the offending path and category are printed).
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decompressFrames, wakeMessages } from '../test/helpers/session-log.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SECRET_DIR = '/home/cna/InboxMosire/.work/live/secrets'
const SECRET_FILES = [
  'dsh-adapter.token',
  'dsh-smoke-adapter.token',
  'producer-main.token',
  'smoke-producer.token',
  'smoke-verify.token',
  'dsh-session-app-a-wake.token',
  'dsh-session-app-b-wake.token',
  'dsh-session-app-a-wake.legacy.token',
  'program-a-mcp.token',
  'program-b-mcp.token',
]
const CONTENT_MARKERS = [
  'SECRET-TITLE',
  'SECRET-BODY',
  'SECRET-CONTENT',
  'SECRET-ACP',
  'acp-active-',
  'acceptance-harness-secret',
]
const REPO_SKIP = new Set(['node_modules', '.git', '.work'])
const TEXT_LIMIT = 4 * 1024 * 1024

/** Collected findings and stats. */
const findings = []
const scanned = { repo: 0, adapter: 0, logs: 0, sessions: 0, wakeMessages: 0 }

/**
 * Read the secret values that must never appear.
 * @returns {Promise<Array<{label: string, value: string}>>} known secrets.
 */
async function readSecrets() {
  const secrets = []
  for (const name of SECRET_FILES) {
    const path = join(SECRET_DIR, name)
    if (!existsSync(path)) continue
    const value = (await readFile(path, 'utf8')).trim()
    if (value.length >= 8) secrets.push({ label: name, value })
  }
  return secrets
}

/**
 * Recursively list files under a directory.
 * @param {string} directory - root.
 * @param {string[]} [skip] - directory names to skip.
 * @returns {Promise<string[]>} file paths.
 */
async function walk(directory, skip = []) {
  const out = []
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (skip.includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path, skip)))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/**
 * Scan one text blob for every marker.
 * @param {string} text - haystack.
 * @param {Array<{label: string, value: string}>} secrets - secrets.
 * @param {string} kind - finding category.
 * @param {string} path - source path.
 * @param {boolean} [content] - also scan synthetic notification markers.
 */
function scanText(text, secrets, kind, path, content = true) {
  for (const secret of secrets) {
    if (text.includes(secret.value)) {
      findings.push({ kind, path, what: `credential ${secret.label}` })
    }
  }
  if (!content) return
  for (const marker of CONTENT_MARKERS) {
    if (text.includes(marker)) findings.push({ kind, path, what: `content marker ${marker}` })
  }
}

const secrets = await readSecrets()
if (secrets.length === 0) {
  console.error(`no secret files under ${SECRET_DIR}; nothing to scan`)
  process.exit(2)
}

for (const path of await walk(ROOT, [...REPO_SKIP])) {
  const info = await stat(path).catch(() => undefined)
  if (!info || info.size > TEXT_LIMIT) continue
  // Repository sources legitimately define the synthetic markers used by the
  // tests, so only credentials are checked here.
  scanText(await readFile(path, 'utf8').catch(() => ''), secrets, 'repo', relative(ROOT, path), false)
  scanned.repo += 1
}

for (const path of await walk(join(DSH_HOME, 'inbox-mosire'))) {
  scanText(await readFile(path, 'utf8').catch(() => ''), secrets, 'adapter', path)
  scanned.adapter += 1
}

const logRoots = [join(DSH_HOME, 'profiles', 'web'), join(DSH_HOME, 'logs')]
for (const root of logRoots) {
  for (const path of await walk(root, ['node_modules', '.plugin-manager'])) {
    if (!/\.(log|txt|jsonl|json)$/.test(path)) continue
    const info = await stat(path).catch(() => undefined)
    if (!info || info.size > TEXT_LIMIT) continue
    scanText(await readFile(path, 'utf8').catch(() => ''), secrets, 'log', path)
    scanned.logs += 1
  }
}

for (const slug of await readdir(join(DSH_HOME, 'sessions')).catch(() => [])) {
  const slugRoot = join(DSH_HOME, 'sessions', slug)
  for (const sessionId of await readdir(slugRoot).catch(() => [])) {
    const file = join(slugRoot, sessionId, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    const text = decompressFrames(await readFile(file))
    // Credentials must not appear anywhere in a transcript; content markers are
    // checked on wake messages only, because tool results legitimately carry
    // notification titles and payloads to the Agent.
    scanText(text, secrets, 'session', file, false)
    const events = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // ignore a trailing partial line
      }
    }
    const wakes = wakeMessages(events)
    scanned.sessions += 1
    for (const wake of wakes) {
      scanned.wakeMessages += 1
      scanText(JSON.stringify(wake), secrets, 'wake', file)
    }
  }
}

if (findings.length > 0) {
  console.error('PRIVACY SCAN FAILED')
  for (const finding of findings) {
    console.error(`  ${finding.kind}: ${finding.path} — ${finding.what}`)
  }
  process.exit(1)
}

console.log('privacy scan: PASS')
console.log(`  repo files scanned: ${scanned.repo}`)
console.log(`  adapter state/config/log files: ${scanned.adapter}`)
console.log(`  DSH host log files: ${scanned.logs}`)
console.log(`  DSH session logs: ${scanned.sessions} (${scanned.wakeMessages} inbox-mosire wake messages)`)
console.log(`  secrets checked: ${secrets.map((secret) => secret.label).join(', ')}`)
