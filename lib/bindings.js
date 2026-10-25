/**
 * Binding descriptors and adapter token references (v2).
 *
 * A descriptor names one inbox, one API base URL, and one local `file:` token
 * reference. Raw tokens never enter the descriptor, the state document, a log
 * line, or a wake message: the adapter reads the referenced `0600` file.
 *
 * @module @mosire/dsh-inbox-mosire/lib/bindings
 */
import { readFile, stat } from 'node:fs/promises'
import { SAFE_ID } from './config.js'
import { isHttpUrl } from './state.js'

/** Stable descriptor/token failure codes. */
export const BINDING_ERROR = Object.freeze({
  INVALID_DESCRIPTOR: 'INVALID_DESCRIPTOR',
  INVALID_INBOX: 'INVALID_INBOX',
  INVALID_API_BASE: 'INVALID_API_BASE',
  INVALID_CHANNEL: 'INVALID_CHANNEL',
  TOKEN_REF_INVALID: 'TOKEN_REF_INVALID',
  TOKEN_REF_NOT_ABSOLUTE: 'TOKEN_REF_NOT_ABSOLUTE',
  TOKEN_REF_UNREADABLE: 'TOKEN_REF_UNREADABLE',
  TOKEN_REF_EMPTY: 'TOKEN_REF_EMPTY',
})

/** A descriptor or token reference the adapter refuses to use. */
export class BindingError extends Error {
  /**
   * @param {string} code - one of {@link BINDING_ERROR}.
   * @param {string} message - token-free explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'BindingError'
    this.code = code
  }
}

/**
 * Resolve a `file:` URI or absolute path to a host path.
 * @param {unknown} ref - descriptor's `adapterTokenRef`.
 * @returns {string} absolute path.
 * @throws {BindingError} when the reference is missing, relative, or not a file URI.
 */
export function tokenRefPath(ref) {
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new BindingError(BINDING_ERROR.TOKEN_REF_INVALID, 'adapterTokenRef 必填')
  }
  const value = ref.trim()
  if (value.startsWith('file:')) {
    let url
    try {
      url = new URL(value)
    } catch {
      throw new BindingError(BINDING_ERROR.TOKEN_REF_INVALID, 'adapterTokenRef 不是合法 file URI')
    }
    if (url.protocol !== 'file:' || url.hostname !== '') {
      throw new BindingError(
        BINDING_ERROR.TOKEN_REF_INVALID,
        'adapterTokenRef 只接受本机 file:/绝对路径 形式',
      )
    }
    const path = decodeURIComponent(url.pathname)
    if (!path.startsWith('/')) {
      throw new BindingError(BINDING_ERROR.TOKEN_REF_NOT_ABSOLUTE, 'file URI 不是绝对路径')
    }
    return path
  }
  if (!value.startsWith('/')) {
    throw new BindingError(
      BINDING_ERROR.TOKEN_REF_NOT_ABSOLUTE,
      'adapterTokenRef 必须是绝对路径或 file:/ 绝对 URI',
    )
  }
  return value
}

/**
 * Read the wake token referenced by a descriptor.
 *
 * The value is returned only to the caller that builds the Authorization
 * header; callers must register it with the redacting logger.
 *
 * @param {unknown} ref - descriptor's `adapterTokenRef`.
 * @returns {Promise<{token: string, path: string, warning?: string}>} token and provenance.
 * @throws {BindingError} when the reference is unusable or the file is unreadable/empty.
 */
export async function loadBindingToken(ref) {
  const path = tokenRefPath(ref)
  let text
  let info
  try {
    info = await stat(path)
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new BindingError(
      BINDING_ERROR.TOKEN_REF_UNREADABLE,
      `adapter token 文件不可读: ${path} (${error?.code ?? error})`,
    )
  }
  if (!info.isFile()) {
    throw new BindingError(
      BINDING_ERROR.TOKEN_REF_UNREADABLE,
      `adapter token 引用不是普通文件: ${path}`,
    )
  }
  const token = text.trim()
  if (!token) {
    throw new BindingError(BINDING_ERROR.TOKEN_REF_EMPTY, `adapter token 文件为空: ${path}`)
  }
  const warning =
    (info.mode & 0o077) !== 0
      ? `adapter token 文件权限不是 0600: ${path}`
      : undefined
  return { token, path, warning }
}

/**
 * Validate and normalize one binding descriptor.
 *
 * Accepts the contract shape (`inboxId`, `apiBaseUrl`, `adapterTokenRef`,
 * `channels`, `label`). `apiBaseUrl` may be omitted by a caller that wants the
 * adapter's configured default.
 *
 * @param {unknown} input - descriptor object.
 * @param {{defaultApiBaseUrl?: string}} [options] - fallback API base.
 * @returns {{inboxId: string, apiBaseUrl: string, adapterTokenRef: string, channels: string[], label: string}} descriptor.
 * @throws {BindingError} for any invalid field.
 */
export function validateDescriptor(input, { defaultApiBaseUrl = '' } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new BindingError(BINDING_ERROR.INVALID_DESCRIPTOR, 'descriptor 必须是对象')
  }
  const record = /** @type {Record<string, any>} */ (input)
  const inboxId = typeof record.inboxId === 'string' ? record.inboxId.trim() : ''
  if (!SAFE_ID.test(inboxId)) {
    throw new BindingError(
      BINDING_ERROR.INVALID_INBOX,
      `inboxId 必须匹配 ${SAFE_ID.source}`,
    )
  }
  const apiBaseRaw =
    typeof record.apiBaseUrl === 'string' && record.apiBaseUrl.trim() !== ''
      ? record.apiBaseUrl.trim()
      : defaultApiBaseUrl
  if (!isHttpUrl(apiBaseRaw)) {
    throw new BindingError(
      BINDING_ERROR.INVALID_API_BASE,
      'apiBaseUrl 必须是 http(s) URL 且不含凭据',
    )
  }
  const url = new URL(apiBaseRaw)
  const apiBaseUrl = (url.origin + url.pathname).replace(/\/+$/, '')

  if (typeof record.adapterTokenRef !== 'string' || record.adapterTokenRef.trim() === '') {
    throw new BindingError(BINDING_ERROR.TOKEN_REF_INVALID, 'adapterTokenRef 必填')
  }
  tokenRefPath(record.adapterTokenRef)

  const channels = Array.isArray(record.channels)
    ? [...new Set(record.channels.map((value) => String(value ?? '').trim()).filter(Boolean))]
    : []
  for (const channel of channels) {
    if (!SAFE_ID.test(channel)) {
      throw new BindingError(
        BINDING_ERROR.INVALID_CHANNEL,
        `channel 必须匹配 ${SAFE_ID.source}: ${JSON.stringify(channel)}`,
      )
    }
  }
  const label =
    typeof record.label === 'string' ? record.label.trim().slice(0, 120) : ''

  return {
    inboxId,
    apiBaseUrl,
    adapterTokenRef: record.adapterTokenRef.trim(),
    channels,
    label,
  }
}

/**
 * Redact the token reference down to a host path for diagnostics.
 * @param {string} ref - `file:` URI or absolute path.
 * @returns {string} path, or the raw value when it cannot be parsed.
 */
export function displayTokenRef(ref) {
  try {
    return tokenRefPath(ref)
  } catch {
    return String(ref ?? '')
  }
}
