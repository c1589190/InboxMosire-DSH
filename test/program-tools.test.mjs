import test from 'node:test'
import assert from 'node:assert/strict'
import { renderWakeTemplate } from '../lib/template.js'
import { hasBusinessTools, isBusinessToolName } from '../lib/program-mcp.js'
import {
  createFakeHost,
  createTestAdapter,
  waitFor,
} from './helpers/fake-host.mjs'
import { startFakeInbox } from './helpers/fake-server.mjs'

test('view-ack wake never renders a program-MCP warning or tool names', () => {
  const text = renderWakeTemplate({
    inboxId: 'app-a',
    revision: 1,
    available: 1,
    channels: ['ticket'],
    summary: {
      items: [
        { itemId: 'itm_1', channel: 'ticket', kind: 'reply', source: 'ticket/1',
          summary: '工单更新' },
      ],
      remaining: 0,
      maxItems: 3,
      maxTitleChars: 80,
      maxTotalChars: 600,
    },
    wakeMode: 'view-ack',
  })
  assert.ok(!text.includes('未检测到'))
  assert.ok(!text.includes('qq_conversation'))
  assert.ok(!text.includes('inbox_claim'))
  assert.match(text, /available=0 时结束本回合，不要轮询/)
})

test('claim mode records programMcp=missing without blocking or warning the wake', async (t) => {
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
  assert.ok(!text.includes('未检测到'))
  assert.match(text, /"summary":"需要程序 MCP"/)
  assert.equal(created.adapter.snapshot().health.programMcp.state, 'missing')
  assert.match(created.adapter.snapshot().health.programMcp.at, /^\d{4}-/)
  assert.equal(created.adapter.snapshot().programMcp.state, 'missing')
})

test('claim mode records programMcp=available when claim tools are visible', async (t) => {
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
  assert.equal(created.adapter.snapshot().programMcp.state, 'available')
})

test('claim-mode detection accepts prefixed inbox_view without inbox_claim', () => {
  assert.equal(isBusinessToolName('inbox_view', 'claim'), true)
  assert.equal(isBusinessToolName('mcp__iibot__inbox_view', 'claim'), true)
  assert.equal(isBusinessToolName('mcp__iibot__inbox_claim', 'claim'), true)
  assert.equal(isBusinessToolName('mcp__iibot__bot_reply', 'claim'), false)
  assert.equal(isBusinessToolName('inbox_view', 'view-ack'), false)
  const agent = {
    ctx: {
      tools: {
        schemas: () => [{ name: 'mcp__iibot__inbox_view' }, { name: 'bot_reply' }],
      },
    },
  }
  assert.equal(hasBusinessTools(agent, 'claim'), true)
  assert.equal(hasBusinessTools(agent, 'view-ack'), undefined)
})
