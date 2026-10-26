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
  assert.ok(text.includes("ctx.connection.rpc.call("))
  assert.ok(!text.includes('Authorization'))
  assert.ok(!text.includes('inbox_claim'))
  assert.ok(!text.includes('inbox_complete'))
  assert.ok(!text.includes('localStorage'))
})

test('the dock component renders the bound inbox count and hides when unbound', async () => {
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

  const states = [
    [{ data: { bound: true, inboxId: 'app-a', available: 3, sse: 'connected' }, error: false }, () => {}],
    [0, () => {}],
  ]
  let cursor = 0
  hooksReact.useState = () => states[cursor++] ?? [undefined, () => {}]
  hooksReact.useEffect = () => {}
  const tree = component({ sessionId: 'session-a', t: (key) => key })
  assert.ok(tree)
  const text = JSON.stringify(tree)
  assert.ok(text.includes('app-a'))
  assert.ok(text.includes('InboxMosire'))
  assert.ok(text.includes('panel.pending'))
  const bar = tree.children.find((child) => child?.props?.className === 'ims-bar')
  assert.ok(bar)
  const count = bar.children.find((child) => child?.props?.className === 'ims-count')
  assert.equal(count.children, 3)

  states[0] = [
    {
      data: {
        bound: true,
        inboxId: 'app-a',
        available: 3,
        sse: 'connected',
        programMcp: 'missing',
      },
      error: false,
    },
    () => {},
  ]
  cursor = 0
  const noMcp = component({ sessionId: 'session-a', t: (key) => key })
  assert.ok(JSON.stringify(noMcp).includes('panel.status.no-mcp'))

  states[0] = [{ data: { bound: false }, error: false }, () => {}]
  cursor = 0
  const hidden = component({ sessionId: 'session-a', t: (key) => key })
  assert.equal(hidden, null)

  Object.assign(hooksReact, saved)
})
