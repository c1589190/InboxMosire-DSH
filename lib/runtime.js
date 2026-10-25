/**
 * In-process bridge between the adapter engine row and the tool row.
 *
 * The engine row (`index.js`) creates the one `BindingManager` and publishes it
 * here; the tool row (`tools.js`) awaits it. Both rows are loaded into the same
 * Host process, so this is a plain module singleton rather than a second copy
 * of the adapter.
 *
 * @module @mosire/dsh-inbox-mosire/lib/runtime
 */

/** @type {import('./manager.js').BindingManager|null} */
let manager = null
/** @type {string|null} */
let failure = null
/** @type {((value: any) => void)|null} */
let resolveReady = null

const ready = new Promise((resolve) => {
  resolveReady = resolve
})

/**
 * Publish the live manager.
 * @param {import('./manager.js').BindingManager|null} instance - manager.
 */
export function setManager(instance) {
  manager = instance
  failure = instance ? null : failure
  resolveReady?.(instance)
}

/**
 * Publish a startup failure so tool calls fail loudly instead of hanging.
 * @param {string} message - token-free explanation.
 */
export function setManagerFailure(message) {
  failure = String(message)
  manager = null
  resolveReady?.(null)
}

/** @returns {import('./manager.js').BindingManager|null} the live manager. */
export function getManager() {
  return manager
}

/**
 * Await the live manager.
 * @param {number} [timeoutMs] - readiness budget.
 * @returns {Promise<import('./manager.js').BindingManager>} manager.
 */
export async function waitManager(timeoutMs = 15000) {
  if (manager) return manager
  if (failure) throw new Error(failure)
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error('InboxMosire adapter 尚未就绪（引擎行未加载）')),
      timeoutMs,
    )
    timer.unref?.()
  })
  const value = await Promise.race([ready, timeout])
  if (!value) throw new Error(failure ?? 'InboxMosire adapter 尚未就绪')
  return value
}
