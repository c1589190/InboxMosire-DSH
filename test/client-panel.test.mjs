import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * Load the browser bundle with a fake module loader and React.
 * @returns {Promise<{definition: any, React: any}>} captured definition.
 */
async function loadClient() {
  let definition
  const React = {
    createElement: (type, props, children) => ({ type, props, children }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
  }
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  await import(`../client.js?test=${Date.now()}`)
  const module = definition.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  return { definition, module, React }
}

test('the client bundle registers one localized dock entry and dictionaries', async () => {
  const { definition, module, React } = await loadClient()
  assert.equal(definition.id, '@mosire/dsh-inbox-mosire')
  assert.deepEqual(module.inject, ['slots', 'connection', 'locale'])

  const effects = []
  const injections = []
  const registrations = []
  const dictionaries = []
  const ctx = {
    effect(fn, label) {
      effects.push({ label, disposer: fn() })
      return () => {}
    },
    locale: {
      register(namespace, dicts) {
        dictionaries.push({ namespace, dicts })
        return () => {}
      },
    },
    slots: {
      inject(key, callback) {
        injections.push({ key, callback })
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    connection: { rpc: { call: async () => ({ ok: true, value: { bound: false } }) } },
  }
  module.apply(ctx)

  assert.equal(effects.length, 1)
  assert.equal(effects[0].label, 'inbox-mosire: panel dictionaries')
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, 'inbox-mosire')
  assert.deepEqual(
    Object.keys(dictionaries[0].dicts.zh).sort(),
    Object.keys(dictionaries[0].dicts.en).sort(),
  )
  assert.equal(dictionaries[0].dicts.en['panel.pending'], 'pending')
  assert.equal(dictionaries[0].dicts.zh['panel.pending'], '条待处理')

  assert.equal(injections.length, 1)
  assert.equal(injections[0].key, 'conversation.input.dock')
  injections[0].callback()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.id, 'inbox-mosire')
  assert.equal(registrations[0].options.order, 30)
  assert.equal(registrations[0].options.locale, 'inbox-mosire')
  assert.equal(typeof registrations[0].component, 'function')

  assert.equal(registrations[0].component.length, 1)
  assert.equal(typeof React.createElement, 'function')
})

test('the client bundle parses as a standalone module and keeps copy bounded', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./client'], './client.js')
  assert.ok(pkg.files.includes('client.js'))
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'))
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
  const text = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(text.includes("id: '@mosire/dsh-inbox-mosire'"))
  assert.ok(text.includes('ctx.connection.rpc.call('))
  assert.ok(text.includes("'suspend' : 'resume'"))
  assert.ok(text.includes('AbortController'))
  assert.ok(text.includes('15_000'))
  assert.ok(text.includes("className: 'ims-endpoint'"))
  assert.ok(!text.includes('mcp-connector'), 'the dock no longer touches the MCP connector')
  assert.ok(!text.includes('programMcp'), 'the dock no longer gates on program MCP tools')
  assert.ok(!text.includes('setEnabled'))
  assert.ok(!text.includes('Authorization'))
  assert.ok(!text.includes('inbox_claim'))
  assert.ok(!text.includes('inbox_complete'))
  assert.ok(!text.includes('localStorage'))
})

test('the dock renders the bound inbox address and one suspend/resume toggle', async () => {
  const { module, React: hooksReact } = await loadClient()
  const registrations = []
  const ctx = {
    effect: () => () => {},
    locale: { register: () => () => {} },
    slots: {
      inject: (_key, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    connection: { rpc: { call: async () => ({ ok: true, value: { bound: false } }) } },
  }
  module.apply(ctx)
  const component = registrations[0].component
  const saved = {
    useState: hooksReact.useState,
    useEffect: hooksReact.useEffect,
  }
  const t = (key) => key

  const states = [
    [
      {
        data: {
          bound: true,
          inboxId: 'app-a',
          available: 3,
          sse: 'connected',
          enabled: true,
          endpoint: '127.0.0.1:47651',
          lastOp: {
            at: '2026-10-27T13:02:09.633Z',
            action: 'bind',
            actor: 'agent',
            result: 'ok',
          },
        },
        error: false,
      },
      () => {},
    ],
  ]
  let cursor = 0
  hooksReact.useState = () => states[cursor++] ?? [undefined, () => {}]
  hooksReact.useEffect = () => {}

  const tree = component({ sessionId: 'session-a', t })
  assert.ok(tree)
  const text = JSON.stringify(tree)
  assert.ok(text.includes('InboxMosire'))
  assert.ok(text.includes('app-a'))
  assert.ok(text.includes('127.0.0.1:47651'), 'the bound address is visible')
  assert.ok(text.includes('panel.pending'))
  assert.ok(!text.includes('panel.mount'), 'a live inbox offers the unmount action')

  const bar = tree.children.find((child) => child?.props?.className === 'ims-bar')
  assert.ok(bar)
  const count = bar.children.find((child) => child?.props?.className === 'ims-count')
  assert.equal(count.children, 3)
  const endpoint = bar.children.find((child) => child?.props?.className === 'ims-endpoint')
  assert.equal(endpoint.children, '127.0.0.1:47651')
  const toggle = bar.children.find((child) => child?.props?.className === 'ims-toggle')
  assert.equal(toggle.props?.['aria-label'], 'panel.unmount')
  assert.equal(toggle.children, 'panel.unmount')

  states[0] = [
    {
      data: {
        bound: true,
        inboxId: 'app-a',
        available: null,
        sse: 'idle',
        enabled: false,
        endpoint: '127.0.0.1:47651',
        lastOp: {
          at: '2026-10-27T13:02:13.471Z',
          action: 'suspend',
          actor: 'user',
          result: 'ok',
        },
      },
      error: false,
    },
    () => {},
  ]
  cursor = 0
  const suspended = component({ sessionId: 'session-a', t })
  const suspendedText = JSON.stringify(suspended)
  assert.ok(suspendedText.includes('panel.status.unloaded'))
  assert.ok(suspendedText.includes('panel.actor.user'), 'the user action is attributed')
  const suspendedBar = suspended.children.find((child) => child?.props?.className === 'ims-bar')
  assert.equal(
    suspendedBar.children.some((child) => child?.props?.className === 'ims-count'),
    false,
    'a suspended inbox shows no pending count',
  )
  const suspendedToggle = suspendedBar.children.find(
    (child) => child?.props?.className === 'ims-toggle',
  )
  assert.equal(suspendedToggle.children, 'panel.mount')

  states[0] = [{ data: { bound: false }, error: false }, () => {}]
  cursor = 0
  assert.equal(component({ sessionId: 'session-a', t }), null)

  Object.assign(hooksReact, saved)
})
