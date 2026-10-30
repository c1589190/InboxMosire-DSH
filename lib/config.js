/**
 * Configuration resolution for the InboxMosire wake adapter.
 *
 * Precedence: explicit plugin-row config > `INBOX_*` environment > the
 * machine-local JSON file (`$DSH_HOME/inbox-mosire/config.json`) > defaults.
 * The API token is never part of the resolved configuration value: only its
 * source (environment or a file path) is, and the value is loaded on demand.
 *
 * @module @mosire/dsh-inbox-mosire/lib/config
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Machine-local configuration file, outside every repository. */
export const LOCAL_CONFIG_PATH = join(
  process.env.DSH_HOME || join(homedir(), '.dsh'),
  'inbox-mosire',
  'config.json',
)

/** Contract-defined defaults from the wake-adapter contract v1. */
export const DEFAULTS = Object.freeze({
  apiUrl: 'http://127.0.0.1:18765',
  inboxId: 'main',
  channels: [],
  debounceMs: 300,
  heartbeatTimeoutSeconds: 45,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 60000,
  wakeBackoffBaseMs: 30000,
  wakeBackoffMaxMs: 900000,
  requestTimeoutMs: 10000,
  summaryEnabled: true,
  summaryMaxItems: 3,
  summaryMaxTitleChars: 80,
  summaryMaxTotalChars: 1200,
  sessionId: '',
  wakeProfile: 'generic',
  enabled: true,
})

/** Safe identifiers for inbox and channel ids (`[A-Za-z0-9._-]{1,64}`). */
export const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/

/** Largest accepted status/event payload; a guard against a hostile server. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** Configuration that cannot be used to reach the inbox. */
export class ConfigError extends Error {
  /**
   * @param {string} message - operator-facing explanation.
   * @param {string[]} [details] - every problem found, when more than one.
   */
  constructor(message, details = []) {
    super(message)
    this.name = 'ConfigError'
    this.code = 'INBOX_CONFIG'
    this.details = details
  }
}

/**
 * Parse an environment-style channel list.
 * @param {unknown} input - comma- or whitespace-separated string, or array.
 * @returns {string[]} trimmed, de-duplicated channel ids.
 */
export function parseChannels(input) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,\s]+/)
      : []
  const out = []
  for (const value of raw) {
    const channel = String(value ?? '').trim()
    if (channel && !out.includes(channel)) out.push(channel)
  }
  return out
}

/**
 * Read one optional machine-local JSON object.
 * @param {string} path - absolute file path.
 * @returns {Promise<Record<string, unknown>>} the object, or an empty object.
 */
export async function readLocalConfig(path = LOCAL_CONFIG_PATH) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new ConfigError(`本地配置文件不可读: ${path} (${error?.code ?? error})`)
  }
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not a JSON object')
    }
    return value
  } catch (error) {
    throw new ConfigError(`本地配置文件不是 JSON 对象: ${path} (${error.message})`)
  }
}

/**
 * Pick the first defined value in precedence order.
 * @param {...unknown} values - candidates from highest to lowest precedence.
 * @returns {unknown} the first value that is not undefined, null, or `''`.
 */
function pick(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue
    return value
  }
  return undefined
}

/**
 * Coerce a bounded integer.
 * @param {unknown} value - candidate value.
 * @param {number} fallback - value to use when absent or invalid.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} the bounded integer.
 */
function boundedInt(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * Coerce a boolean supplied as a boolean, `"true"`/`"false"`, or `0`/`1`.
 * @param {unknown} value - candidate value.
 * @param {boolean} fallback - value to use when absent or unrecognized.
 * @returns {boolean} the resolved boolean.
 */
function boundedBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  }
  return fallback
}

/**
 * Resolve, validate, and normalize the adapter configuration.
 *
 * Never throws for an unusable configuration: callers receive every problem in
 * `errors` and a safe value they can still report through `/inbox status`.
 *
 * @param {Record<string, unknown>} [pluginConfig] - the loader row's `config`.
 * @param {NodeJS.ProcessEnv} [env] - environment to read `INBOX_*` from.
 * @param {Record<string, unknown>} [local] - machine-local file contents.
 * @returns {{ value: Record<string, any>, errors: string[], warnings: string[], tokenSource: {kind: 'env'|'file'|'inline'|'none', value?: string} }}
 */
export function resolveConfig(pluginConfig = {}, env = process.env, local = {}) {
  const row = pluginConfig && typeof pluginConfig === 'object' ? pluginConfig : {}
  const file = local && typeof local === 'object' ? local : {}
  const errors = []
  const warnings = []

  const apiUrlRaw = String(
    pick(row.apiUrl, env.INBOX_API_URL, file.apiUrl, DEFAULTS.apiUrl),
  ).trim()
  let apiUrl
  try {
    const parsed = new URL(apiUrlRaw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      errors.push(`apiUrl 必须是 http(s) URL，收到 ${JSON.stringify(apiUrlRaw)}`)
    } else if (parsed.username || parsed.password) {
      errors.push('apiUrl 不能包含用户名或密码')
    } else {
      apiUrl = parsed.origin + parsed.pathname.replace(/\/+$/, '')
    }
  } catch {
    errors.push(`apiUrl 不是合法 URL: ${JSON.stringify(apiUrlRaw)}`)
  }

  const inboxId = String(
    pick(row.inboxId, env.INBOX_INBOX_ID, file.inboxId, DEFAULTS.inboxId),
  ).trim()
  if (!SAFE_ID.test(inboxId)) {
    errors.push(`inboxId 必须匹配 ${SAFE_ID.source}，收到 ${JSON.stringify(inboxId)}`)
  }

  const channels = parseChannels(
    pick(
      row.channels,
      env.INBOX_CHANNELS,
      file.channels,
      DEFAULTS.channels,
    ),
  )
  for (const channel of channels) {
    if (!SAFE_ID.test(channel)) {
      errors.push(`channel 必须匹配 ${SAFE_ID.source}，收到 ${JSON.stringify(channel)}`)
    }
  }
  if (channels.length === 0) {
    warnings.push('未配置 channels：将按 token 可见的全部 channel 统计')
  }

  const debounceMs = boundedInt(
    pick(row.debounceMs, env.INBOX_WAKE_DEBOUNCE_MS, file.debounceMs, DEFAULTS.debounceMs),
    DEFAULTS.debounceMs,
    0,
    5000,
  )
  if (debounceMs < 200) {
    warnings.push('debounceMs 低于契约建议的 200ms')
  }

  const heartbeatTimeoutSeconds = boundedInt(
    pick(
      row.heartbeatTimeoutSeconds,
      env.INBOX_HEARTBEAT_TIMEOUT_SECONDS,
      file.heartbeatTimeoutSeconds,
      DEFAULTS.heartbeatTimeoutSeconds,
    ),
    DEFAULTS.heartbeatTimeoutSeconds,
    5,
    300,
  )

  const summaryEnabled = boundedBool(
    pick(
      row.summaryEnabled,
      env.INBOX_SUMMARY_ENABLED,
      file.summaryEnabled,
    ),
    DEFAULTS.summaryEnabled,
  )
  const summaryMaxItems = boundedInt(
    pick(
      row.summaryMaxItems,
      env.INBOX_SUMMARY_MAX_ITEMS,
      file.summaryMaxItems,
    ),
    DEFAULTS.summaryMaxItems,
    1,
    10,
  )
  const summaryMaxTitleChars = boundedInt(
    pick(
      row.summaryMaxTitleChars,
      env.INBOX_SUMMARY_MAX_TITLE_CHARS,
      file.summaryMaxTitleChars,
    ),
    DEFAULTS.summaryMaxTitleChars,
    16,
    200,
  )
  const summaryMaxTotalChars = boundedInt(
    pick(
      row.summaryMaxTotalChars,
      env.INBOX_SUMMARY_MAX_TOTAL_CHARS,
      file.summaryMaxTotalChars,
    ),
    DEFAULTS.summaryMaxTotalChars,
    120,
    4000,
  )

  const sessionId = String(
    pick(row.sessionId, env.INBOX_SESSION_ID, file.sessionId, DEFAULTS.sessionId) ?? '',
  ).trim()
  if (sessionId && sessionId !== 'auto' && sessionId.length > 200) {
    errors.push('sessionId 过长')
  }

  const wakeProfile = String(
    pick(row.wakeProfile, env.INBOX_WAKE_PROFILE, file.wakeProfile, DEFAULTS.wakeProfile) ?? '',
  ).trim()
  if (!SAFE_ID.test(wakeProfile)) {
    errors.push(`wakeProfile 必须是 [A-Za-z0-9._-]{1,64}，收到 ${JSON.stringify(wakeProfile)}`)
  }

  const stateFile = String(
    pick(
      row.stateFile,
      env.INBOX_STATE_FILE,
      file.stateFile,
      join(
        process.env.DSH_HOME || join(homedir(), '.dsh'),
        'inbox-mosire',
        'state.json',
      ),
    ),
  ).trim()
  if (!stateFile.startsWith('/')) {
    errors.push(`stateFile 必须是绝对路径，收到 ${JSON.stringify(stateFile)}`)
  }

  const tokenInline = pick(row.token, env.INBOX_API_TOKEN)
  const tokenFile = pick(
    row.tokenFile,
    env.INBOX_API_TOKEN_FILE,
    file.tokenFile,
  )
  const tokenSource =
    tokenInline !== undefined
      ? { kind: 'inline', value: String(tokenInline) }
      : tokenFile !== undefined
        ? { kind: 'file', value: String(tokenFile) }
        : { kind: 'none' }

  const value = {
    apiUrl,
    inboxId,
    channels,
    debounceMs,
    heartbeatTimeoutSeconds,
    reconnectBaseMs: boundedInt(
      pick(row.reconnectBaseMs, file.reconnectBaseMs, DEFAULTS.reconnectBaseMs),
      DEFAULTS.reconnectBaseMs,
      100,
      60000,
    ),
    reconnectMaxMs: boundedInt(
      pick(row.reconnectMaxMs, file.reconnectMaxMs, DEFAULTS.reconnectMaxMs),
      DEFAULTS.reconnectMaxMs,
      1000,
      600000,
    ),
    wakeBackoffBaseMs: boundedInt(
      pick(row.wakeBackoffBaseMs, file.wakeBackoffBaseMs, DEFAULTS.wakeBackoffBaseMs),
      DEFAULTS.wakeBackoffBaseMs,
      100,
      3600000,
    ),
    wakeBackoffMaxMs: boundedInt(
      pick(row.wakeBackoffMaxMs, file.wakeBackoffMaxMs, DEFAULTS.wakeBackoffMaxMs),
      DEFAULTS.wakeBackoffMaxMs,
      1000,
      86400000,
    ),
    requestTimeoutMs: boundedInt(
      pick(row.requestTimeoutMs, file.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
      DEFAULTS.requestTimeoutMs,
      1000,
      120000,
    ),
    maxResponseBytes: MAX_RESPONSE_BYTES,
    summaryEnabled,
    summaryMaxItems,
    summaryMaxTitleChars,
    summaryMaxTotalChars,
    sessionId,
    wakeProfile,
    autoBind: sessionId === 'auto',
    stateFile,
    enabled: boundedBool(
      pick(row.enabled, env.INBOX_ENABLED, file.enabled),
      DEFAULTS.enabled,
    ),
  }
  value.tokenFile = tokenSource.kind === 'file' ? tokenSource.value : undefined
  value.logFile = String(
    pick(
      row.logFile,
      env.INBOX_LOG_FILE,
      file.logFile,
      join(dirname(value.stateFile), 'adapter.log'),
    ),
  ).trim()
  const defaultOpsFile = value.stateFile.startsWith('/')
    ? join(dirname(value.stateFile), 'ops.jsonl')
    : undefined
  value.opsFile = String(
    pick(row.opsFile, env.INBOX_OPS_FILE, file.opsFile, defaultOpsFile) ?? '',
  ).trim()
  if (value.opsFile !== '' && !value.opsFile.startsWith('/')) {
    errors.push(`opsFile 必须是绝对路径，收到 ${JSON.stringify(value.opsFile)}`)
  }

  return { value, errors, warnings, tokenSource }
}

/**
 * Load the adapter token from its configured source.
 *
 * The returned value is only ever placed in an `Authorization` header. Callers
 * must not log it.
 *
 * @param {{kind: 'env'|'file'|'inline'|'none', value?: string}} source - token source.
 * @returns {Promise<string>} the token.
 * @throws {ConfigError} when the source is missing, unreadable, or empty.
 */
export async function loadToken(source) {
  if (source.kind === 'none') {
    throw new ConfigError(
      '未配置 adapter token：请设置 INBOX_API_TOKEN_FILE、INBOX_API_TOKEN 或 config.tokenFile',
    )
  }
  if (source.kind === 'inline') {
    const value = String(source.value ?? '').trim()
    if (!value) throw new ConfigError('INBOX_API_TOKEN 为空')
    return value
  }
  const path = String(source.value ?? '')
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new ConfigError(
      `adapter token 文件不可读: ${path} (${error?.code ?? error})`,
    )
  }
  const value = text.trim()
  if (!value) throw new ConfigError(`adapter token 文件为空: ${path}`)
  return value
}

/**
 * Redact the token from arbitrary text before logging.
 * @param {string} text - candidate log text.
 * @param {string} [token] - the exact secret to remove.
 * @returns {string} text safe to log.
 */
export function redact(text, token) {
  let out = String(text ?? '')
  if (token) out = out.split(token).join('<redacted-token>')
  return out
}
