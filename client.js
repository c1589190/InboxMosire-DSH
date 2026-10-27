window.__ModuleLoader__.load({
  id: '@mosire/dsh-inbox-mosire',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by the dock panel. */
    const NS = 'inbox-mosire'

    /** Simplified Chinese copy. */
    const zh = {
      'panel.aria': 'InboxMosire 通知板',
      'panel.pending': '条待处理',
      'panel.status.live': '已连接',
      'panel.status.connecting': '连接中',
      'panel.status.offline': '离线',
      'panel.status.unloaded': 'Inbox 已卸载',
      'panel.status.error': '读取失败',
      'panel.refresh': '刷新通知数',
      'panel.endpoint': '绑定的 InboxMosire 地址',
      'panel.mount': '挂载',
      'panel.unmount': '卸载',
      'panel.working': '处理中…',
      'panel.failed': '操作失败',
      'panel.op.failed': '失败',
      'panel.actor.user': '用户',
      'panel.actor.agent': 'Agent',
      'panel.actor.host': '系统',
      'panel.actor.auto': '自动',
    }

    /** English copy, checked against the same key set. */
    const en = {
      'panel.aria': 'InboxMosire notification board',
      'panel.pending': 'pending',
      'panel.status.live': 'live',
      'panel.status.connecting': 'connecting',
      'panel.status.offline': 'offline',
      'panel.status.unloaded': 'Inbox unmounted',
      'panel.status.error': 'read failed',
      'panel.refresh': 'Refresh notification count',
      'panel.endpoint': 'Bound InboxMosire address',
      'panel.mount': 'Mount',
      'panel.unmount': 'Unmount',
      'panel.working': 'working…',
      'panel.failed': 'action failed',
      'panel.op.failed': 'failed',
      'panel.actor.user': 'user',
      'panel.actor.agent': 'agent',
      'panel.actor.host': 'system',
      'panel.actor.auto': 'auto',
    }

    const css = `
.ims-dock{box-sizing:border-box;width:100%;margin:0 auto}
.ims-bar{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width,100%) - 4 * var(--dsh-composer-dock-inset,0px));min-height:36px;margin:0 auto;padding:4px 8px 4px 12px;display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.ims-icon{flex:none;display:inline-flex;color:var(--dsw-alias-brand-primary)}
.ims-title{flex:none;font-weight:600;line-height:24px}
.ims-inbox{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.ims-sep{flex:none;color:var(--dsw-alias-border-l2)}
.ims-dot{flex:none;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-success-primary)}
.ims-dot.offline{background:var(--dsw-alias-state-idle-primary)}
.ims-dot.connecting{background:var(--dsw-alias-state-warn-primary)}
.ims-dot.error{background:var(--dsw-alias-state-error-primary)}
.ims-status{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px}
.ims-spacer{flex:1;min-width:8px}
.ims-count{flex:none;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary)}
.ims-pending{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px}
.ims-endpoint{flex:none;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary)}
.ims-toggle{flex:none;height:24px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:22px;cursor:pointer;transition:background .12s ease,color .12s ease,border-color .12s ease}
.ims-toggle:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.ims-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ims-toggle:disabled{opacity:.5;cursor:default}
.ims-refresh{flex:none;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ims-refresh:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ims-refresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
@media (max-width: 560px){.ims-title{display:none}.ims-status{display:none}}
`

    /**
     * Inbox count strip; renders nothing when the current session is unbound.
     * @param {{sessionId?: string, t?: (key: string) => string}} props - slot props.
     * @returns {any} React tree.
     */
    function createPanel(ctx) {
      return function InboxDock({ sessionId, t }) {
        const translate = typeof t === 'function' ? t : (key) => key
        const [snapshot, setSnapshot] = React.useState({ data: null, error: false })
        const [refreshKey, setRefreshKey] = React.useState(0)
        const [busy, setBusy] = React.useState(false)
        const [actionError, setActionError] = React.useState(false)
        const busyRef = React.useRef(false)

        React.useEffect(() => {
          if (!sessionId) return undefined
          let alive = true
          let controller = null
          let timer = null

          const load = async (refresh) => {
            if (!alive) return
            controller?.abort()
            const local = new AbortController()
            controller = local
            try {
              const result = await ctx.connection.rpc.call(
                '/inbox-mosire',
                'status',
                { sessionId, refresh },
                local.signal,
              )
              if (!alive || local.signal.aborted) return
              if (result?.ok) {
                setSnapshot({ data: result.value, error: false })
              } else {
                setSnapshot((previous) => ({ data: previous.data, error: true }))
              }
            } catch (error) {
              if (!alive || local.signal.aborted) return
              setSnapshot((previous) => ({ data: previous.data, error: true }))
            }
          }

          load(true)
          timer = setInterval(() => load(false), 5000)
          return () => {
            alive = false
            if (timer) clearInterval(timer)
            controller?.abort()
          }
        }, [sessionId, refreshKey])

        const data = snapshot.data
        if (!data || data.bound !== true) return null

        const inboxActive = data.enabled !== false
        const endpoint = typeof data.endpoint === 'string' ? data.endpoint : ''
        const lastOp =
          data.lastOp && typeof data.lastOp === 'object' && typeof data.lastOp.action === 'string'
            ? data.lastOp
            : null
        const actionLabel = inboxActive
          ? translate('panel.unmount')
          : translate('panel.mount')
        /**
         * Clock time of the last operation, in the viewer's local zone.
         * @param {string} at - ISO timestamp.
         * @returns {string} `HH:MM` or an empty string.
         */
        const clockOf = (at) => {
          const value = new Date(at)
          if (Number.isNaN(value.getTime())) return ''
          return value.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })
        }
        const actorLabel = lastOp
          ? translate(`panel.actor.${lastOp.actor}`)
          : ''
        const lastOpNote = lastOp
          ? `${actorLabel || lastOp.actor}${clockOf(lastOp.at) ? ` ${clockOf(lastOp.at)}` : ''}${
              lastOp.result === 'fail' ? ` ${translate('panel.op.failed')}` : ''
            }`
          : ''
        const toggleInbox = async () => {
          if (busyRef.current) return
          busyRef.current = true
          setBusy(true)
          setActionError(false)
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 15_000)
          try {
            const result = await ctx.connection.rpc.call(
              '/inbox-mosire',
              inboxActive ? 'suspend' : 'resume',
              { sessionId },
              controller.signal,
            )
            if (!result?.ok) {
              throw new Error(result?.error?.message ?? `${inboxActive ? 'suspend' : 'resume'} failed`)
            }
            setRefreshKey((value) => value + 1)
          } catch {
            setActionError(true)
          } finally {
            clearTimeout(timer)
            busyRef.current = false
            setBusy(false)
          }
        }

        const available = Number.isSafeInteger(data.available) ? data.available : null
        let tone = 'live'
        let status = translate('panel.status.live')
        if (snapshot.error || data.blocked || data.configError) {
          tone = 'error'
          status = translate('panel.status.error')
        } else if (actionError) {
          tone = 'error'
          status = translate('panel.failed')
        } else if (!inboxActive) {
          tone = 'offline'
          status = `${translate('panel.status.unloaded')}${lastOpNote ? `（${lastOpNote}）` : ''}`
        } else if (data.sse === 'connecting') {
          tone = 'connecting'
          status = translate('panel.status.connecting')
        } else if (data.sse !== 'connected') {
          tone = 'offline'
          status = translate('panel.status.offline')
        }

        const label = `${available ?? '—'} ${translate('panel.pending')}`
        return h('div', { className: 'ims-dock' }, [
          h('style', { key: 'ims-style' }, css),
          h(
            'div',
            {
              key: 'ims-bar',
              className: 'ims-bar',
              role: 'group',
              'aria-label': translate('panel.aria'),
            },
            [
              h(
                'span',
                { key: 'icon', className: 'ims-icon', 'aria-hidden': true },
                h(
                  'svg',
                  {
                    width: 16,
                    height: 16,
                    viewBox: '0 0 24 24',
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: 1.8,
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                  },
                  [
                    h('path', {
                      key: 'tray',
                      d: 'M4 13.5 6.2 5.8A2 2 0 0 1 8.1 4.4h7.8a2 2 0 0 1 1.9 1.4L20 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
                    }),
                    h('path', { key: 'slot', d: 'M4 13.5h4l1.2 2h5.6l1.2-2H20' }),
                  ],
                ),
              ),
              h('span', { key: 'title', className: 'ims-title' }, 'InboxMosire'),
              h('span', { key: 'sep', className: 'ims-sep', 'aria-hidden': true }, '·'),
              h(
                'span',
                { key: 'inbox', className: 'ims-inbox', title: data.inboxId },
                data.inboxId,
              ),
              h('span', { key: 'dot', className: `ims-dot ${tone}`, 'aria-hidden': true }),
              h('span', { key: 'status', className: 'ims-status' }, status),
              endpoint
                ? h(
                    'span',
                    { key: 'endpoint', className: 'ims-endpoint', title: translate('panel.endpoint') },
                    endpoint,
                  )
                : null,
              h('span', { key: 'spacer', className: 'ims-spacer' }),
              inboxActive
                ? h('span', { key: 'count', className: 'ims-count' }, available ?? '—')
                : null,
              inboxActive
                ? h('span', { key: 'pending', className: 'ims-pending' }, translate('panel.pending'))
                : null,
              h(
                'button',
                {
                  key: 'toggle',
                  type: 'button',
                  className: 'ims-toggle',
                  disabled: busy,
                  title: actionLabel,
                  'aria-label': actionLabel,
                  onClick: toggleInbox,
                },
                busy ? translate('panel.working') : actionLabel,
              ),
              h(
                'button',
                {
                  key: 'refresh',
                  type: 'button',
                  className: 'ims-refresh',
                  title: translate('panel.refresh'),
                  'aria-label': translate('panel.refresh'),
                  onClick: () => setRefreshKey((value) => value + 1),
                },
                h(
                  'svg',
                  {
                    width: 14,
                    height: 14,
                    viewBox: '0 0 24 24',
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: 2,
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                    'aria-hidden': true,
                  },
                  [
                    h('path', { key: 'arc', d: 'M20 11a8 8 0 1 0-2.4 6.4' }),
                    h('path', { key: 'head', d: 'M20 5v6h-6' }),
                  ],
                ),
              ),
            ],
          ),
        ])
      }
    }

    return {
      inject: ['slots', 'connection', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'inbox-mosire: panel dictionaries',
        )
        const InboxDock = createPanel(ctx)
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'inbox-mosire',
              order: 30,
              locale: NS,
            },
            InboxDock,
          ),
        )
      },
    }
  },
})
