import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VIEW_ACK_BODY,
  VIEW_ACK_SUMMARY_BODY,
  WAKE_BODY,
  buildWakeMessage,
  renderWakeTemplate,
  sanitizeChannels,
  wakeKey,
  wakeMessageId,
} from '../lib/template.js'

test('wake template is the contract text, field for field', () => {
  const text = renderWakeTemplate({
    inboxId: 'main',
    revision: 42,
    available: 3,
    channels: ['ticket', 'tweet-review'],
  })
  assert.equal(
    text,
    [
      '[INBOX_HOST_EVENT]',
      'inbox=main revision=42 available=3 channels=[ticket,tweet-review]',
      '',
      WAKE_BODY,
    ].join('\n'),
  )
  assert.ok(text.endsWith('如果当前没有可处理项，结束本回合，不要轮询。'))
})

test('wake template includes only controlled fields', () => {
  const text = renderWakeTemplate({
    inboxId: 'main',
    revision: 1,
    available: 1,
    channels: ['ticket', 'bad channel', '../../etc/passwd', 'clm_secret', 'ticket'],
  })
  assert.match(text, /channels=\[ticket\]/)
  assert.ok(!text.includes('bad channel'))
  assert.ok(!text.includes('passwd'))
  assert.ok(!text.includes('clm_secret'))
})

test('wake template rejects an invalid inbox id, revision, or available count', () => {
  assert.throws(() => renderWakeTemplate({ inboxId: 'bad inbox', revision: 1, available: 1 }))
  assert.throws(() => renderWakeTemplate({ inboxId: 'main', revision: -1, available: 1 }))
  assert.throws(() => renderWakeTemplate({ inboxId: 'main', revision: 1.5, available: 1 }))
  assert.throws(() => renderWakeTemplate({ inboxId: 'main', revision: 1, available: -2 }))
})

test('sanitizeChannels keeps contract-shaped ids only', () => {
  assert.deepEqual(
    sanitizeChannels(['a', 'a', 'b', '', null, 'x y', 'clm_1', 'a.b-c_9']),
    ['a', 'b', 'a.b-c_9'],
  )
  assert.deepEqual(sanitizeChannels(undefined), [])
})

test('wake key follows the recommended inbox/revision/session shape', () => {
  assert.equal(
    wakeKey({ inboxId: 'main', revision: 42, sessionRef: 'session-abc' }),
    'inbox:main:revision:42:session:session-abc',
  )
})

test('wake message id is stable per key and distinct per revision', () => {
  const key = wakeKey({ inboxId: 'main', revision: 42, sessionRef: 'session-abc' })
  const first = wakeMessageId(key)
  const second = wakeMessageId(key)
  assert.equal(first, second)
  assert.match(first, /^msg_inbox_[0-9a-f]{24}$/)
  assert.notEqual(
    first,
    wakeMessageId(wakeKey({ inboxId: 'main', revision: 43, sessionRef: 'session-abc' })),
  )
})

test('wake message is an immutable user message with an adapter-owned source', () => {
  const message = buildWakeMessage({ id: 'msg_inbox_x', text: 'hello' })
  assert.equal(message.role, 'user')
  assert.equal(message.id, 'msg_inbox_x')
  assert.equal(message.source.kind, 'inbox-mosire')
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }])
  assert.ok(Object.isFrozen(message))
  assert.ok(Object.isFrozen(message.content))
  assert.ok(Object.isFrozen(message.content[0]))
})


test('view-ack wake mode never instructs the agent to claim', () => {
  const text = renderWakeTemplate({
    inboxId: 'iibot-bot-sim',
    revision: 7,
    available: 1,
    channels: ['qq'],
    summary: {
      items: [
        { itemId: 'itm_1', channel: 'qq', kind: 'digest', summary: '群聊更新' },
      ],
      remaining: 0,
      maxItems: 3,
      maxTitleChars: 80,
      maxTotalChars: 600,
    },
    programMcpMissing: true,
    wakeMode: 'view-ack',
  })
  assert.ok(!text.includes('inbox_claim'))
  assert.ok(!text.includes('inbox_list'))
  assert.ok(!text.includes('inbox_view'))
  assert.match(text, /qq_conversation_read\(source\)/)
  assert.match(text, /qq_conversation_ack\(source\)/)
  assert.match(text, /处理时以通知板为准/)
  assert.ok(!text.includes('claim 时以通知板为准'))
  assert.equal(VIEW_ACK_SUMMARY_BODY.includes('inbox_claim'), false)
  assert.equal(VIEW_ACK_BODY.includes('inbox_claim'), false)
  assert.equal(VIEW_ACK_SUMMARY_BODY.includes('inbox_list'), false)
  assert.equal(VIEW_ACK_SUMMARY_BODY.includes('inbox_view'), false)
  assert.equal(VIEW_ACK_BODY.includes('inbox_list'), false)
  assert.equal(VIEW_ACK_BODY.includes('inbox_view'), false)
})
