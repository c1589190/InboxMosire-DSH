import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GENERIC_PROGRAM_MCP_WARNING,
  GENERIC_WAKE_PROFILE,
  apply,
  normalizeWakeProfile,
  WakeProfileRegistry,
} from '../lib/wake-profile.js'

test('the generic profile names no program tools', () => {
  assert.equal(GENERIC_WAKE_PROFILE.name, 'generic')
  assert.equal(GENERIC_WAKE_PROFILE.businessTools, null)
  assert.equal(GENERIC_WAKE_PROFILE.programMcpWarning, GENERIC_PROGRAM_MCP_WARNING)
  assert.ok(!GENERIC_WAKE_PROFILE.viewAckBody.includes('qq_'))
})

test('normalizeWakeProfile validates and freezes a named profile', () => {
  const profile = normalizeWakeProfile('iibot', {
    businessTools: ['qq_conversation_read', 'qq_conversation_read', 'qq_conversation_ack'],
    programMcpWarning: 'warning',
    viewAckBody: ['a', 'b'],
    viewAckSummaryBody: 'summary',
  })
  assert.equal(profile.name, 'iibot')
  assert.deepEqual(profile.businessTools, ['qq_conversation_read', 'qq_conversation_ack'])
  assert.equal(profile.programMcpWarning, 'warning')
  assert.equal(profile.viewAckBody, 'a\nb')
  assert.equal(profile.viewAckSummaryBody, 'summary')
  assert.ok(Object.isFrozen(profile))
  assert.ok(Object.isFrozen(profile.businessTools))
})

test('normalizeWakeProfile rejects bad names and tool names', () => {
  assert.throws(() => normalizeWakeProfile('bad name', {}), /name is invalid/)
  assert.throws(() => normalizeWakeProfile('ok', { businessTools: ['bad tool'] }), /tool name is invalid/)
})

test('the registry resolves generic by default and registers named profiles', () => {
  const registry = new WakeProfileRegistry()
  assert.equal(registry.resolve(undefined), GENERIC_WAKE_PROFILE)
  assert.equal(registry.resolve(''), GENERIC_WAKE_PROFILE)
  assert.equal(registry.resolve('missing'), undefined)
  const dispose = registry.register('iibot', { businessTools: ['qq_conversation_read'] })
  assert.equal(registry.resolve('iibot').businessTools[0], 'qq_conversation_read')
  assert.deepEqual(registry.names(), ['generic', 'iibot'])
  dispose()
  assert.equal(registry.resolve('iibot'), undefined)
})

test('apply provides the inboxWakeProfiles service', () => {
  let provided
  const ctx = {
    provide(name, value) {
      provided = { name, value }
      return () => {}
    },
  }
  const dispose = apply(ctx)
  assert.equal(provided.name, 'inboxWakeProfiles')
  assert.ok(provided.value instanceof WakeProfileRegistry)
  assert.equal(typeof dispose, 'function')
})
