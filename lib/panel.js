/**
 * Web UI bridge for the InboxMosire dock panel.
 *
 * The browser never sees a token or item content. It asks the authenticated
 * Connection RPC channel for one session's current board counters; the Host
 * answers from the binding's last observed `status`.
 *
 * @module @mosire/dsh-inbox-mosire/lib/panel
 */

/** Authenticated Connection RPC channel owned by this plugin. */
export const PANEL_CHANNEL = '/inbox-mosire'

/** Longest accepted session id, matching the binding contract. */
const MAX_SESSION_ID = 200

/**
 * Build one Connection RPC handler over the manager.
 *
 * The handler is deliberately read-only and count-only. It never asks the
 * InboxMosire server for item content and never returns a token or item text.
 *
 * @param {Promise<import('./manager.js').BindingManager|null>} managerReady - startup result.
 * @returns {(endpoint: string, payload: unknown, signal: AbortSignal, peer: any) => Promise<{ok: true, value: unknown}|{ok: false, error: {code: string, message: string, details: object}}>} RPC handler.
 */
export function createPanelHandler(managerReady) {
  return async (endpoint, payload) => {
    if (endpoint !== 'status') {
      return {
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: `未知的 InboxMosire panel endpoint: ${JSON.stringify(endpoint)}`,
          details: {},
        },
      }
    }
    const sessionId =
      payload && typeof payload === 'object' && typeof payload.sessionId === 'string'
        ? payload.sessionId.trim()
        : ''
    if (!sessionId || sessionId.length > MAX_SESSION_ID) {
      return {
        ok: false,
        error: {
          code: 'INVALID_ARGUMENT',
          message: 'sessionId 必填且长度不超过 200',
          details: {},
        },
      }
    }
    let manager
    try {
      manager = await managerReady
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'ENGINE_UNAVAILABLE',
          message: String(error?.message ?? error).slice(0, 200),
          details: {},
        },
      }
    }
    if (!manager) {
      return {
        ok: false,
        error: {
          code: 'ENGINE_UNAVAILABLE',
          message: 'InboxMosire adapter 引擎未加载',
          details: {},
        },
      }
    }
    try {
      const value = payload?.refresh === true
        ? await manager.refreshPanelStatus(sessionId)
        : manager.panelStatus(sessionId)
      return { ok: true, value }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'PANEL_STATUS_FAILED',
          message: String(error?.message ?? error).slice(0, 200),
          details: {},
        },
      }
    }
  }
}

/**
 * Register the panel RPC channel on one Host Connection service.
 * @param {any} connection - `ctx.connection` from the Host.
 * @param {Promise<import('./manager.js').BindingManager|null>} managerReady - startup result.
 * @returns {() => Promise<void>} channel disposer.
 */
export function registerPanelRpc(connection, managerReady) {
  return connection.rpc.handle(PANEL_CHANNEL, createPanelHandler(managerReady))
}
