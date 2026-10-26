import test from 'node:test'
import assert from 'node:assert/strict'
import { renderWakeTemplate } from '../lib/template.js'
import {
  createFakeHost,
  createTestAdapter,
  waitFor,
} from './helpers/fake-host.mjs'
import { startFakeInbox } from './helpers/fake-server.mjs'

test('a wake without a program MCP warns before the fixed instructions', () => {
  const text = renderWakeTemplate({
    inboxId: 'app-a',
    revision: 1,
    available: 1,
    channels: ['ticket'],
    summary: {
      items: [
        { itemId: 'itm_1', channel: 'ticket', kind: 'reply', summary: '工单更新' },
      ],
      remaining: 0,
      maxItems: 3,
      maxTitleChars: 80,
      maxTotalChars: 600,
    },
    programMcpMissing: true,
  })
  const warningIndex = text.indexOf('未检测到程序 MCP')
  const instructionIndex = text.indexOf('请直接通过你的程序 MCP')
  assert.ok(warningIndex > 0, text)
  assert.ok(instructionIndex > warningIndex, 'the warning comes before the instructions')
  assert.ok(text.includes('inbox_claim/inbox_list'))
})

test('adapter records programMcp=missing and warns without blocking the wake', async (t) => {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const host = createFakeHost()
  host.businessTools = false
  host.createAgent('session-test')
  const created = await createTestAdapter({ server, host })
  t.after(() => created.adapter.stop())
  await created.adapter.start()
  await waitFor(() => server.connectionCount === 1, { label: 'SSE' })
  server.push({ channel: 'ticket', summary: '需要程序 MCP' })
  await waitFor(() => host.followups.length === 1, { label: 'wake' })
  const text = host.followups[0].message.content[0].text
  assert.match(text, /未检测到程序 MCP/)
  assert.match(text, /"summary":"需要程序 MCP"/)
  assert.equal(created.adapter.snapshot().health.programMcp.state, 'missing')
  assert.match(created.adapter.snapshot().health.programMcp.at, /^\d{4}-/)
  assert.equal(created.adapter.snapshot().programMcp.state, 'missing')
})

test('adapter records programMcp=available and omits the warning', async (t) => {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const host = createFakeHost()
  host.businessTools = true
  host.createAgent('session-test')
  const created = await createTestAdapter({ server, host })
  t.after(() => created.adapter.stop())
  await created.adapter.start()
  await waitFor(() => server.connectionCount === 1, { label: 'SSE' })
  server.push({ channel: 'ticket', summary: '程序 MCP 已就绪' })
  await waitFor(() => host.followups.length === 1, { label: 'wake' })
  const text = host.followups[0].message.content[0].text
  assert.ok(!text.includes('未检测到程序 MCP'))
  assert.equal(created.adapter.snapshot().programMcp.state, 'available')
})
