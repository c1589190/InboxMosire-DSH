import test from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_ERROR, InboxClient } from '../lib/inbox-client.js'
import { resolveConfig } from '../lib/config.js'
import { renderWakeTemplate } from '../lib/template.js'
import {
  createFakeHost,
  createTestAdapter,
  createTestManager,
  delay,
  waitFor,
  writeBindingDescriptor,
} from './helpers/fake-host.mjs'
import { startFakeInbox } from './helpers/fake-server.mjs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Start a fake inbox and a client with a short timeout.
 * @param {import('node:test').TestContext} t - test context.
 * @param {object} [options] - client overrides.
 * @returns {Promise<Record<string, any>>} handles.
 */
async function clientSetup(t, options = {}) {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const client = new InboxClient({
    apiUrl: server.url,
    inboxId: server.inbox,
    channels: ['ticket'],
    token: server.token,
    requestTimeoutMs: 150,
    maxResponseBytes: 4096,
    ...options,
  })
  return { server, client }
}

/**
 * Start an adapter on a fake inbox and fake host.
 * @param {import('node:test').TestContext} t - test context.
 * @param {object} [options] - setup options.
 * @returns {Promise<Record<string, any>>} handles.
 */
async function adapterSetup(t, options = {}) {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const host = createFakeHost()
  const agent = host.createAgent('session-test')
  const created = await createTestAdapter({
    server,
    host,
    overrides: { requestTimeoutMs: 1000, ...options.overrides },
  })
  t.after(() => created.adapter.stop())
  await created.adapter.start()
  await waitFor(() => server.connectionCount === 1, { label: 'SSE connection' })
  return { server, host, agent, ...created }
}

/**
 * Render one summary item line.
 * @param {Record<string, string>} item - item fields.
 * @returns {string} rendered line.
 */
function line(item) {
  return `- ${JSON.stringify(item)}`
}

test('client getItems sends the header, channel filter, and limit and returns safe summaries', async (t) => {
  const { server, client } = await clientSetup(t)
  server.push({ channel: 'ticket', title: '工单更新' })
  server.push({ channel: 'other', title: '不应可见' })
  const result = await client.getItems({ limit: 3 })
  assert.equal(result.inbox, 'smoke')
  assert.equal(result.count, 1)
  assert.deepEqual(result.items, [
    {
      itemId: 'itm_fake_1',
      channel: 'ticket',
      kind: 'reply',
      summary: '工单更新',
    },
  ])
  const request = server.requests.at(-1)
  assert.equal(request.path, '/v1/inboxes/smoke/items')
  assert.match(request.search, /limit=3/)
  assert.match(request.search, /channel=ticket/)
  assert.ok(!request.search.includes(server.token))
})

test('client getItems drops payload-like fields even if a server sends them', async (t) => {
  const { server, client } = await clientSetup(t)
  server.setItemsMode('payload')
  server.push({ channel: 'ticket', title: '标题' })
  const result = await client.getItems({ limit: 3 })
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['channel', 'itemId', 'kind', 'summary'])
  assert.ok(!JSON.stringify(result).includes('SECRET-BODY'))
  assert.ok(!JSON.stringify(result).includes('SECRET-CONTENT'))
  assert.ok(!JSON.stringify(result).includes('/secret/content-ref'))
  assert.ok(!JSON.stringify(result).includes('/secret/ref'))
})

test('client getItems rejects an invalid limit before any request', async (t) => {
  const { server, client } = await clientSetup(t)
  await assert.rejects(
    () => client.getItems({ limit: 0 }),
    (error) => error.code === CLIENT_ERROR.INVALID_ARGUMENT,
  )
  await assert.rejects(
    () => client.getItems({ limit: 101 }),
    (error) => error.code === CLIENT_ERROR.INVALID_ARGUMENT,
  )
  assert.equal(server.itemsCalls.length, 0)
})

test('client getItems classifies 403, 500, malformed JSON, and timeout without the token', async (t) => {
  const { server, client } = await clientSetup(t)
  server.setItemsMode('403')
  await assert.rejects(
    () => client.getItems({ limit: 3 }),
    (error) => {
      assert.equal(error.code, CLIENT_ERROR.AUTH)
      assert.equal(error.status, 403)
      assert.ok(!error.message.includes(server.token))
      return true
    },
  )
  server.setItemsMode('500')
  await assert.rejects(
    () => client.getItems({ limit: 3 }),
    (error) => error.code === CLIENT_ERROR.HTTP && error.status === 500 && error.retryable,
  )
  server.setItemsMode('malformed')
  await assert.rejects(
    () => client.getItems({ limit: 3 }),
    (error) => error.code === CLIENT_ERROR.PROTOCOL,
  )
  server.setItemsMode('ok')
  server.setHoldItems(true)
  await assert.rejects(
    () => client.getItems({ limit: 3 }),
    (error) => error.code === CLIENT_ERROR.TIMEOUT,
  )
})

test('summary template renders bounded JSON lines and remaining count', () => {
  const text = renderWakeTemplate({
    inboxId: 'app-a',
    revision: 42,
    available: 4,
    channels: ['ticket'],
    summary: {
      items: [
        { itemId: 'itm_1', channel: 'ticket', kind: 'reply', summary: '工单更新' },
        { itemId: 'itm_2', channel: 'tweet-review', kind: 'review', summary: '待审推文' },
        { itemId: 'itm_3', channel: 'ticket', kind: 'reply', summary: '第三条' },
      ],
      remaining: 1,
      maxItems: 3,
      maxTitleChars: 80,
      maxTotalChars: 600,
    },
  })
  assert.equal(
    text,
    [
      '[INBOX_HOST_EVENT]',
      'inbox=app-a revision=42 available=4 channels=[ticket]',
      '',
      '摘要（最多 3 条；可能已变化，claim 时以通知板为准）:',
      line({ itemId: 'itm_1', channel: 'ticket', kind: 'reply', summary: '工单更新' }),
      line({ itemId: 'itm_2', channel: 'tweet-review', kind: 'review', summary: '待审推文' }),
      line({ itemId: 'itm_3', channel: 'ticket', kind: 'reply', summary: '第三条' }),
      '- 还有 1 条未展示',
      '',
      '请直接通过你的程序 MCP 调用 inbox_claim 选择本回合要处理的 itemId；',
      '如果摘要不足，再调用 inbox_list。',
      '如果当前没有可处理项，结束本回合，不要轮询。',
    ].join('\n'),
  )
})

test('summary template cleans untrusted summary text and JSON-escapes it', () => {
  const text = renderWakeTemplate({
    inboxId: 'main',
    revision: 1,
    available: 1,
    channels: ['ticket'],
    summary: {
      items: [
        {
          itemId: 'itm_1',
          channel: 'ticket',
          kind: 'reply',
          summary: 'He said "hi"\nnext\tline\u0000end',
        },
      ],
      remaining: 0,
      maxItems: 3,
      maxTitleChars: 80,
      maxTotalChars: 600,
    },
  })
  const summaryLine = text.split('\n').find((row) => row.startsWith('- {"itemId"'))
  assert.ok(summaryLine)
  assert.ok(!summaryLine.includes('\n'))
  assert.ok(!summaryLine.includes('\u0000'))
  const parsed = JSON.parse(summaryLine.slice(2))
  assert.equal(parsed.summary, 'He said "hi" next line end')
})

test('summary template bounds summary length, item count, and total summary chars', () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    itemId: `itm_${index}`,
    channel: 'ticket',
    kind: 'reply',
    summary: `长标题${'字'.repeat(100)}${index}`,
  }))
  const text = renderWakeTemplate({
    inboxId: 'main',
    revision: 5,
    available: 9,
    channels: ['ticket'],
    summary: { items, remaining: 6, maxItems: 3, maxTitleChars: 10, maxTotalChars: 150 },
  })
  const summaryLines = text.split('\n').filter((row) => row.startsWith('- {"itemId"'))
  assert.equal(summaryLines.length, 1, 'the budget drops later item lines')
  const parsed = JSON.parse(summaryLines[0].slice(2))
  assert.ok([...parsed.summary].length <= 10)
  assert.ok(parsed.summary.endsWith('…'))
  const summaryStart = text.indexOf('摘要（最多')
  const footerStart = text.indexOf('请直接通过你的程序 MCP')
  const summarySection = text.slice(summaryStart, footerStart)
  assert.ok(summarySection.length <= 150, `summary section is ${summarySection.length} chars`)
  assert.ok(text.includes('如果当前没有可处理项，结束本回合，不要轮询。'))
})

test('summary template falls back to kind/channel for empty summary text and ignores content', () => {
  const text = renderWakeTemplate({
    inboxId: 'main',
    revision: 1,
    available: 1,
    channels: ['ticket'],
    summary: {
      items: [
        {
          itemId: 'itm_1',
          channel: 'ticket',
          kind: 'review',
          summary: '   ',
          payload: 'SECRET-PAYLOAD',
          payloadRef: '/secret/ref',
        },
      ],
      remaining: 0,
      maxItems: 3,
      maxTitleChars: 80,
      maxTotalChars: 600,
    },
  })
  const summaryLine = text.split('\n').find((row) => row.startsWith('- {"itemId"'))
  const parsed = JSON.parse(summaryLine.slice(2))
  assert.equal(parsed.summary, 'review/ticket')
  assert.ok(!text.includes('SECRET-PAYLOAD'))
  assert.ok(!text.includes('SECRET-CONTENT'))
  assert.ok(!text.includes('/secret/ref'))
})

test('a wake without a summary keeps the fixed no-summary template', () => {
  const text = renderWakeTemplate({
    inboxId: 'main',
    revision: 1,
    available: 1,
    channels: ['ticket'],
  })
  assert.ok(text.includes('请使用你的程序 MCP 的 inbox_list'))
  assert.ok(!text.includes('摘要（最多'))
})

test('summary configuration defaults are bounded and overridable', () => {
  const defaults = resolveConfig({}, {}, {}).value
  assert.equal(defaults.summaryEnabled, true)
  assert.equal(defaults.summaryMaxItems, 3)
  assert.equal(defaults.summaryMaxTitleChars, 80)
  assert.equal(defaults.summaryMaxTotalChars, 600)

  const tuned = resolveConfig(
    { summaryMaxItems: 99, summaryMaxTitleChars: 1, summaryMaxTotalChars: 99999 },
    {},
    {},
  ).value
  assert.equal(tuned.summaryMaxItems, 10)
  assert.equal(tuned.summaryMaxTitleChars, 16)
  assert.equal(tuned.summaryMaxTotalChars, 4000)

  assert.equal(resolveConfig({ summaryEnabled: 'false' }, {}, {}).value.summaryEnabled, false)
  assert.equal(resolveConfig({}, { INBOX_SUMMARY_MAX_ITEMS: '5' }, {}).value.summaryMaxItems, 5)
})

test('an empty board never requests items and never wakes', async (t) => {
  const { server, host } = await adapterSetup(t)
  await delay(200)
  assert.equal(server.itemsCalls.length, 0)
  assert.equal(host.followups.length, 0)
})

test('one push wakes once with up to three safe summary items and no payload', async (t) => {
  const { server, host } = await adapterSetup(t)
  server.setItemsMode('payload')
  server.push({ channel: 'ticket', kind: 'reply', title: '工单更新' })
  await waitFor(() => host.followups.length === 1, { label: 'summary wake' })
  const text = host.followups[0].message.content[0].text
  assert.match(text, /itemId":"itm_fake_1/)
  assert.match(text, /"channel":"ticket"/)
  assert.match(text, /"kind":"reply"/)
  assert.match(text, /"summary":"工单更新"/)
  assert.ok(!text.includes('SECRET-BODY'))
  assert.ok(!text.includes('/secret/ref'))
  assert.equal(server.itemsCalls.length, 1)
  assert.match(server.itemsCalls[0].search, /limit=3/)
  assert.match(server.itemsCalls[0].search, /channel=ticket/)
})

test('more than three available items show the remaining count', async (t) => {
  const { server, host } = await adapterSetup(t)
  for (let index = 0; index < 4; index += 1) {
    server.push({ channel: 'ticket', title: `条目 ${index + 1}` })
  }
  await waitFor(() => host.followups.length === 1, { label: 'summary wake' })
  const text = host.followups[0].message.content[0].text
  assert.equal(text.split('\n').filter((row) => row.startsWith('- {"itemId"')).length, 3)
  assert.match(text, /还有 1 条未展示/)
  assert.match(text, /available=4/)
})

test('a summary with a newline and quotes is cleaned and escaped', async (t) => {
  const { server, host } = await adapterSetup(t)
  server.push({ channel: 'ticket', summary: 'a "quote"\nnext\tline' })
  await waitFor(() => host.followups.length === 1, { label: 'summary wake' })
  const text = host.followups[0].message.content[0].text
  const summaryLine = text.split('\n').find((row) => row.startsWith('- {"itemId"'))
  const parsed = JSON.parse(summaryLine.slice(2))
  assert.equal(parsed.summary, 'a "quote" next line')
})

test('items 500 degrades to a no-summary wake and records the warning', async (t) => {
  const { server, host, adapter } = await adapterSetup(t)
  server.setItemsMode('500')
  server.push({ channel: 'ticket' })
  await waitFor(() => host.followups.length === 1, { label: 'degraded wake' })
  const text = host.followups[0].message.content[0].text
  assert.ok(!text.includes('摘要（最多'))
  assert.match(text, /inbox_list/)
  assert.equal(adapter.snapshot().summary.state, 'degraded')
  assert.equal(adapter.snapshot().summary.code, CLIENT_ERROR.HTTP)
  assert.ok(host.logs.some((line) => line.level === 'warn' && line.message.includes('摘要')))
})

test('an items timeout still wakes without a summary', async (t) => {
  const { server, host, adapter } = await adapterSetup(t)
  server.setHoldItems(true)
  server.push({ channel: 'ticket' })
  await waitFor(() => host.followups.length === 1, { label: 'timeout degraded wake' })
  assert.equal(adapter.snapshot().summary.code, CLIENT_ERROR.TIMEOUT)
  assert.ok(!host.followups[0].message.content[0].text.includes('摘要（最多'))
})

test('items 403 records SUMMARY_FORBIDDEN and stops retrying, but still wakes', async (t) => {
  const { server, host, adapter, agent } = await adapterSetup(t)
  server.setItemsMode('403')
  server.push({ channel: 'ticket' })
  await waitFor(() => host.followups.length === 1, { label: 'first degraded wake' })
  assert.equal(adapter.snapshot().summary.state, 'forbidden')
  assert.equal(adapter.snapshot().summary.code, 'SUMMARY_FORBIDDEN')
  assert.equal(server.itemsCalls.length, 1)

  host.endTurn(agent)
  await delay(250)
  server.push({ channel: 'ticket' })
  await waitFor(() => host.followups.length === 2, { label: 'second wake without summary' })
  assert.equal(server.itemsCalls.length, 1, 'no repeated items request for a forbidden token')
  assert.ok(!host.followups[1].message.content[0].text.includes('摘要（最多'))
  assert.match(adapter.statusText(), /summary: enabled=true/)
  assert.match(adapter.statusText(), /SUMMARY_FORBIDDEN|forbidden/)
})

test('the same revision never fetches items or wakes twice', async (t) => {
  const { server, host, agent } = await adapterSetup(t)
  server.push({ channel: 'ticket' })
  await waitFor(() => host.followups.length === 1, { label: 'first wake' })
  host.endTurn(agent)
  await delay(400)
  server.push({ channel: 'ticket' })
  await waitFor(() => host.followups.length === 2, { label: 'new revision wake' })
  host.endTurn(agent)
  await delay(400)
  assert.equal(host.followups.length, 2)
  assert.equal(server.itemsCalls.length, 2, 'one items request per revision, not per turn end')
})

test('summary channels follow status/binding filters', async (t) => {
  const { server, host } = await adapterSetup(t)
  server.push({ channel: 'other', title: 'hidden' })
  server.push({ channel: 'ticket', title: 'visible' })
  await waitFor(() => host.followups.length === 1, { label: 'filtered wake' })
  const text = host.followups[0].message.content[0].text
  assert.match(text, /available=1/)
  assert.match(text, /"summary":"visible"/)
  assert.ok(!text.includes('hidden'))
  assert.match(server.itemsCalls[0].search, /channel=ticket/)
})

test('two bindings never mix their summaries', async (t) => {
  const serverA = await startFakeInbox({ inbox: 'app-a' })
  const serverB = await startFakeInbox({ inbox: 'app-b' })
  t.after(() => Promise.all([serverA.close(), serverB.close()]))
  const host = createFakeHost()
  host.createAgent('session-a')
  host.createAgent('session-b')
  const dir = await mkdtemp(join(tmpdir(), 'inbox-summary-two-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const created = await createTestManager({ host })
  t.after(() => created.manager.stop())
  await created.manager.start()
  await created.manager.bind({
    sessionId: 'session-a',
    descriptor: await writeBindingDescriptor(dir, serverA),
  })
  await created.manager.bind({
    sessionId: 'session-b',
    descriptor: await writeBindingDescriptor(dir, serverB),
  })
  await waitFor(
    () => serverA.connectionCount === 1 && serverB.connectionCount === 1,
    { label: 'both SSE' },
  )
  serverA.push({ channel: 'ticket', title: 'A-ONLY' })
  serverB.push({ channel: 'ticket', title: 'B-ONLY' })
  await waitFor(
    () => host.followups.length === 2,
    { label: 'both summary wakes' },
  )
  const wakeA = host.followups.find((entry) => entry.agentId === 'session-a')
  const wakeB = host.followups.find((entry) => entry.agentId === 'session-b')
  const textA = wakeA.message.content[0].text
  const textB = wakeB.message.content[0].text
  assert.match(textA, /inbox=app-a/)
  assert.match(textA, /A-ONLY/)
  assert.ok(!textA.includes('B-ONLY'))
  assert.match(textB, /inbox=app-b/)
  assert.match(textB, /B-ONLY/)
  assert.ok(!textB.includes('A-ONLY'))
  assert.match(textA, /itm_fake_1/)
  assert.match(textB, /itm_fake_1/)
})

test('summary wake text, state, and logs never contain the raw token', async (t) => {
  const { server, host, adapter } = await adapterSetup(t)
  server.push({ channel: 'ticket', title: 'ok' })
  await waitFor(() => host.followups.length === 1, { label: 'wake' })
  await adapter.whenSettled()
  const text = host.followups[0].message.content[0].text
  const stateText = await readFile(adapter.config.stateFile, 'utf8')
  const logText = await readFile(adapter.config.logFile, 'utf8')
  const loggerText = host.logs.map((entry) => entry.message).join('\n')
  for (const haystack of [text, stateText, logText, loggerText]) {
    assert.ok(!haystack.includes(server.token))
  }
})

test('summaryEnabled=false never requests items and falls back to the fixed body', async (t) => {
  const { server, host, adapter } = await adapterSetup(t, {
    overrides: { summaryEnabled: false },
  })
  server.push({ channel: 'ticket' })
  await waitFor(() => host.followups.length === 1, { label: 'no-summary wake' })
  assert.equal(server.itemsCalls.length, 0)
  const text = host.followups[0].message.content[0].text
  assert.ok(!text.includes('摘要（最多'))
  assert.match(text, /请使用你的程序 MCP 的 inbox_list/)
  assert.equal(adapter.snapshot().summary.state, 'disabled')
  assert.equal(adapter.snapshot().summaryConfig.enabled, false)
})

test('a persisted SUMMARY_FORBIDDEN survives restart and is not retried', async (t) => {
  const server = await startFakeInbox()
  t.after(() => server.close())
  const host = createFakeHost()
  host.createAgent('session-test')
  const dir = await mkdtemp(join(tmpdir(), 'inbox-summary-forbidden-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const stateFile = join(dir, 'state.json')
  await writeFile(
    stateFile,
    JSON.stringify({
      version: 1,
      inboxId: 'smoke',
      sessionRef: 'session-test',
      channels: ['ticket'],
      lastEventId: null,
      lastObservedRevision: 0,
      lastWokenRevision: 0,
      enabled: true,
      summary: {
        state: 'forbidden',
        at: '2026-10-26T00:00:00.000Z',
        shown: 0,
        remaining: 0,
        code: 'SUMMARY_FORBIDDEN',
        message: 'token 缺少 items:read',
      },
      wake: { attempts: 0, stalls: 0, nextWakeAllowedAt: null },
      health: {},
    }),
  )
  server.push({ channel: 'ticket' })
  const { adapter } = await createTestAdapter({ server, host, stateFile })
  t.after(() => adapter.stop())
  await adapter.start()
  await waitFor(() => host.followups.length === 1, { label: 'degraded wake after restart' })
  assert.equal(server.itemsCalls.length, 0, 'a forbidden token is not probed again')
  assert.ok(!host.followups[0].message.content[0].text.includes('摘要（最多'))
  assert.equal(adapter.snapshot().summary.state, 'forbidden')
})

test('client getItems prefers summary, falls back to legacy title, and drops content', async (t) => {
  const { server, client } = await clientSetup(t)
  server.setItemsMode('payload')
  server.push({ channel: 'ticket', summary: '新摘要', summaryOnly: true })
  server.push({ channel: 'ticket', legacyTitle: true, title: '旧标题' })
  server.push({ channel: 'ticket', summary: '优先摘要', aliasTitle: '旧别名' })
  const result = await client.getItems({ limit: 3 })
  assert.deepEqual(result.items, [
    { itemId: 'itm_fake_1', channel: 'ticket', kind: 'reply', summary: '新摘要' },
    { itemId: 'itm_fake_2', channel: 'ticket', kind: 'reply', summary: '旧标题' },
    { itemId: 'itm_fake_3', channel: 'ticket', kind: 'reply', summary: '优先摘要' },
  ])
  const serialized = JSON.stringify(result)
  assert.ok(!serialized.includes('SECRET-CONTENT'))
  assert.ok(!serialized.includes('/secret/content-ref'))
  assert.ok(!serialized.includes('SECRET-BODY'))
  assert.ok(!serialized.includes('旧别名'))
})

test('summary template emits the summary key and ignores content', () => {
  const text = renderWakeTemplate({
    inboxId: 'main',
    revision: 3,
    available: 1,
    channels: ['ticket'],
    summary: {
      items: [
        {
          itemId: 'itm_1',
          channel: 'ticket',
          kind: 'reply',
          summary: '新摘要',
          content: 'SECRET-CONTENT',
          contentRef: '/secret/content-ref',
        },
      ],
      remaining: 0,
      maxItems: 3,
      maxTitleChars: 80,
      maxTotalChars: 600,
    },
  })
  const summaryLine = text.split('\n').find((row) => row.startsWith('- {"itemId"'))
  assert.deepEqual(JSON.parse(summaryLine.slice(2)), {
    itemId: 'itm_1',
    channel: 'ticket',
    kind: 'reply',
    summary: '新摘要',
  })
  assert.ok(!text.includes('SECRET-CONTENT'))
  assert.ok(!text.includes('/secret/content-ref'))
  assert.ok(!text.includes('"title"'))
})

test('a legacy title-only item wakes with the fallback summary', async (t) => {
  const { server, host } = await adapterSetup(t)
  server.push({ channel: 'ticket', legacyTitle: true, title: '旧标题回退' })
  await waitFor(() => host.followups.length === 1, { label: 'legacy fallback wake' })
  const text = host.followups[0].message.content[0].text
  const summaryLine = text.split('\n').find((row) => row.startsWith('- {"itemId"'))
  const parsed = JSON.parse(summaryLine.slice(2))
  assert.equal(parsed.summary, '旧标题回退')
  assert.equal(Object.hasOwn(parsed, 'title'), false)
})

test('inbox_update changes the next revision wake summary without re-waking the old one', async (t) => {
  const { server, host, agent } = await adapterSetup(t)
  const pushed = server.push({ channel: 'ticket', summary: '旧摘要' })
  await waitFor(() => host.followups.length === 1, { label: 'first summary wake' })
  assert.match(host.followups[0].message.content[0].text, /"summary":"旧摘要"/)
  host.endTurn(agent)
  await delay(250)
  const updated = server.updateSummary(pushed.itemId, '新摘要')
  assert.ok(updated)
  await waitFor(() => host.followups.length === 2, { label: 'updated summary wake' })
  const text = host.followups[1].message.content[0].text
  assert.match(text, /"summary":"新摘要"/)
  assert.ok(!text.includes('旧摘要'))
  host.endTurn(agent)
  await delay(400)
  assert.equal(host.followups.length, 2, 'the updated revision is not re-woken')
})

test('an empty summary falls back to the legacy title alias', async (t) => {
  const { server, client } = await clientSetup(t)
  server.push({ channel: 'ticket', summary: '', aliasTitle: 'legacy-empty-summary' })
  const result = await client.getItems({ limit: 1 })
  assert.equal(result.items[0].summary, 'legacy-empty-summary')
})
