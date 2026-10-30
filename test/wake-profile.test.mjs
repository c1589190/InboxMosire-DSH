import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GENERIC_WAKE_PROFILE,
  apply,
  normalizeWakeProfile,
  WakeProfileRegistry,
} from '../lib/wake-profile.js'

test('the generic profile carries only generic view-ack bodies', () => {
  assert.equal(GENERIC_WAKE_PROFILE.name, 'generic')
  assert.deepEqual(Object.keys(GENERIC_WAKE_PROFILE).sort(),
    ['name', 'viewAckBody', 'viewAckSummaryBody'])
  assert.ok(!GENERIC_WAKE_PROFILE.viewAckBody.includes('qq_'))
  assert.ok(!GENERIC_WAKE_PROFILE.viewAckBody.includes('inbox_claim'))
  assert.match(GENERIC_WAKE_PROFILE.viewAckBody, /available=0/)
})

test('normalizeWakeProfile freezes generic bodies and ignores business fields', () => {
  const profile = normalizeWakeProfile('test', {
    viewAckBody: ['a', 'b'],
    viewAckSummaryBody: 'summary',
    businessTools: ['qq_conversation_read'],
    programMcpWarning: 'warning',
    completeKinds: ['digest_complete'],
    compactViewAckItems: true,
  })
  assert.equal(profile.name, 'test')
  assert.equal(profile.viewAckBody, 'a\nb')
  assert.equal(profile.viewAckSummaryBody, 'summary')
  assert.equal(Object.hasOwn(profile, 'businessTools'), false)
  assert.equal(Object.hasOwn(profile, 'programMcpWarning'), false)
  assert.equal(Object.hasOwn(profile, 'completeKinds'), false)
  assert.equal(Object.hasOwn(profile, 'compactViewAckItems'), false)
  assert.ok(Object.isFrozen(profile))
})

test('normalizeWakeProfile rejects a bad name', () => {
  assert.throws(() => normalizeWakeProfile('bad name', {}), /name is invalid/)
})

test('the registry resolves generic by default and registers named profiles', () => {
  const registry = new WakeProfileRegistry()
  assert.equal(registry.resolve(undefined), GENERIC_WAKE_PROFILE)
  assert.equal(registry.resolve(''), GENERIC_WAKE_PROFILE)
  assert.equal(registry.resolve('missing'), undefined)
  const dispose = registry.register('custom', { viewAckBody: 'hello' })
  assert.equal(registry.resolve('custom').viewAckBody, 'hello')
  assert.deepEqual(registry.names(), ['custom', 'generic'])
  dispose()
  assert.equal(registry.resolve('custom'), undefined)
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
