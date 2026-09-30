import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBridge } from '../server.mjs'

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'openstarry-chat-test-'))
  const workspace = join(dir, 'workspace'), stateDir = join(dir, 'private')
  await mkdir(workspace)
  let bridge = await startBridge({ workspace, stateDir, port: 0, chatOptions: options })
  const clients = [], controllers = []
  t.after(async () => {
    controllers.forEach(c => c.abort())
    await Promise.allSettled(clients.map(c => c.close()))
    await bridge.close()
    await rm(dir, { recursive: true, force: true })
  })
  const admin = async (path, data, headers = {}) => {
    const response = await fetch(bridge.origin + '/admin/chat/' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + bridge.adminToken, 'content-type': 'application/json', ...headers },
      body: data === undefined ? undefined : JSON.stringify(data)
    })
    const result = await response.json()
    if (!response.ok) throw Object.assign(Error(result.error), { status: response.status })
    return result
  }
  const reconnect = async registration => {
    const client = new Client({ name: registration.adapterId, version: '1.0.0' }); clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL(new URL(registration.mcpUrl).pathname, bridge.origin)))
    return { client, registration, call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args })
      if (result.isError) throw Error(result.content[0].text)
      return JSON.parse(result.content[0].text)
    } }
  }
  const adapter = async (id = 'fixture-adapter') => reconnect(await admin('adapters', { adapterId: id, source: 'fixture' }))
  const create = (overrides = {}) => admin('tasks', { clientId: 'desktop-test', adapterId: 'fixture-adapter', sessionId: 'session-1', messageId: 'message-1', requestId: 'request-1', prompt: '用中文回答', ...overrides })
  const stream = async (taskId, after = 0, headers = {}) => {
    const controller = new AbortController(); controllers.push(controller)
    const response = await fetch(`${bridge.origin}/admin/chat/tasks/${taskId}/events?after=${after}`, {
      headers: { authorization: 'Bearer ' + bridge.adminToken, ...headers }, signal: controller.signal
    })
    if (!response.ok) throw Object.assign(Error((await response.json()).error), { status: response.status })
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = ''
    return { close: () => controller.abort(), next: async () => {
      const read = async () => {
        while (true) {
          const boundary = buffer.indexOf('\n\n')
          if (boundary >= 0) {
            const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
            const data = block.split('\n').find(line => line.startsWith('data: '))
            if (data) return JSON.parse(data.slice(6))
            continue
          }
          const chunk = await reader.read()
          if (chunk.done) throw Error('Stream ended before an event')
          buffer += decoder.decode(chunk.value, { stream: true })
        }
      }
      let timer
      try { return await Promise.race([read(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Event timeout')), 2500) })]) }
      finally { clearTimeout(timer) }
    } }
  }
  return { admin, adapter, reconnect, create, stream, get bridge() { return bridge }, restart: async () => {
    controllers.forEach(c => c.abort()); await Promise.allSettled(clients.map(c => c.close()))
    await bridge.close(); bridge = await startBridge({ workspace, stateDir, port: 0, chatOptions: options })
  } }
}

async function claimed(f, overrides = {}) {
  const a = await f.adapter(), task = await f.create(overrides)
  const claim = await a.call('claim_chat_task', { taskId: task.id, claimRequestId: 'worker-1' })
  let seq = 0
  const append = (type, payload = {}, extra = {}) => a.call('append_chat_event', {
    taskId: task.id, claimToken: claim.claimToken, clientSeq: ++seq, eventId: 'event-' + seq, type, payload, ...extra
  })
  return { a, task, claim, append }
}

test('chat protocol: authenticated SDK delta arrives before completion, replay and Chinese revision', async t => {
  const f = await fixture(t), c = await claimed(f)
  const stream = await f.stream(c.task.id)
  assert.equal((await stream.next()).type, 'queued')
  assert.equal((await stream.next()).type, 'claimed')
  await c.append('dispatching'); await c.append('started', { webConversationId: 'web-1' })
  await c.append('text_delta', { text: '你' })
  assert.equal((await stream.next()).type, 'dispatching')
  assert.equal((await stream.next()).type, 'started')
  const first = await stream.next()
  assert.equal(first.payload.text, '你')
  assert.equal((await f.admin('tasks/' + c.task.id)).status, 'generating')
  stream.close()
  await c.append('text_delta', { text: '好' })
  await c.append('text_snapshot', { text: '你好，世界' })
  const resumed = await f.stream(c.task.id, first.seq)
  assert.equal((await resumed.next()).payload.text, '好')
  assert.equal((await resumed.next()).payload.text, '你好，世界')
  await c.append('completed')
  const done = await resumed.next()
  assert.equal(done.type, 'completed'); assert.equal(done.source, 'fixture')
  assert.equal(done.sessionId, 'session-1'); assert.equal(done.messageId, 'message-1')
  assert.equal((await f.admin('tasks/' + c.task.id)).text, '你好，世界')
})

test('file references stream through MCP and survive task snapshots without carrying arbitrary URLs', async t => {
  const f = await fixture(t), c = await claimed(f)
  await c.append('dispatching'); await c.append('started', { webConversationId: 'file-conversation' })
  const artifacts = [{ path: 'sandbox:/mnt/data/README.md', name: 'README.md', messageId: 'answer-one' }]
  await c.append('file_links', { artifacts })
  const task = await f.admin('tasks/' + c.task.id)
  assert.deepEqual(task.artifacts, artifacts)
  await assert.rejects(c.append('file_links', { artifacts: [{ ...artifacts[0], path: 'file:///C:/private.txt' }] }), /INVALID_INPUT/)
})

test('thinking is optional for legacy tasks and part of task idempotency', async t => {
  const f = await fixture(t); await f.adapter()
  const task = await f.create({ thinking: true })
  assert.equal(task.thinking, true)
  assert.equal((await f.create({ thinking: true })).id, task.id)
  await assert.rejects(f.create({ thinking: false }), /REQUEST_CONFLICT/)
  await assert.rejects(f.create({ thinking: 'true' }), /INVALID_INPUT/)
})

test('task and event retries are idempotent; different payload, out of order and foreign claims fail', async t => {
  const f = await fixture(t), c = await claimed(f), other = await f.adapter('other-adapter')
  assert.equal((await f.create()).id, c.task.id)
  await assert.rejects(f.create({ prompt: 'different' }), /REQUEST_CONFLICT/)
  await assert.rejects(f.create({ requestId: 'other-request' }), /MESSAGE_CONFLICT/)
  await assert.rejects(other.call('claim_chat_task', { taskId: c.task.id, claimRequestId: 'steal' }), /ADAPTER_DENIED/)
  await assert.rejects(c.a.call('claim_chat_task', { taskId: c.task.id, claimRequestId: 'worker-2' }), /CLAIM_CONFLICT/)
  assert.equal((await c.a.call('claim_chat_task', { taskId: c.task.id, claimRequestId: 'worker-1' })).claimToken, c.claim.claimToken)
  const args = { taskId: c.task.id, claimToken: c.claim.claimToken, clientSeq: 1, eventId: 'first', type: 'dispatching', payload: {} }
  const first = await c.a.call('append_chat_event', args)
  assert.deepEqual(await c.a.call('append_chat_event', args), first)
  await assert.rejects(c.a.call('append_chat_event', { ...args, type: 'error', payload: { message: 'oops' } }), /EVENT_CONFLICT/)
  await assert.rejects(c.a.call('append_chat_event', { ...args, eventId: 'third', clientSeq: 3 }), /EVENT_ORDER/)
  await assert.rejects(other.call('append_chat_event', args), /ADAPTER_DENIED/)
  await assert.rejects(c.a.call('append_chat_event', { ...args, claimToken: 'incorrect' }), /CLAIM_DENIED/)
})

test('expired pre-send claim can transfer; dispatch marker prevents duplicate sends even after restart', async t => {
  let now = Date.now()
  const f = await fixture(t, { now: () => now, leaseMs: 100 }), c = await claimed(f)
  now += 101
  const next = await c.a.call('claim_chat_task', { taskId: c.task.id, claimRequestId: 'worker-2' })
  assert.notEqual(next.claimToken, c.claim.claimToken)
  await assert.rejects(c.append('dispatching'), /CLAIM_DENIED/)
  await c.a.call('append_chat_event', { taskId: c.task.id, claimToken: next.claimToken, clientSeq: 1, eventId: 'dispatch', type: 'dispatching', payload: {} })
  now += 101
  await assert.rejects(c.a.call('claim_chat_task', { taskId: c.task.id, claimRequestId: 'worker-3' }), /DELIVERY_UNCERTAIN/)
  await f.restart()
  const task = await f.admin('tasks/' + c.task.id)
  assert.equal(task.status, 'interrupted'); assert.equal(task.delivery, 'dispatching')
  assert.equal(task.claimToken, undefined)
  assert.equal(task.text, '')
})

test('cancellation waits for webpage confirmation and preserves received text; queued cancel needs no webpage', async t => {
  const f = await fixture(t), c = await claimed(f)
  await c.append('dispatching'); await c.append('started', { webConversationId: 'web-stop' })
  await c.append('text_delta', { text: '已收到' })
  assert.equal((await f.admin(`tasks/${c.task.id}/cancel`, {})).status, 'cancel_requested')
  assert.equal((await c.a.call('heartbeat_chat_task', { taskId: c.task.id, claimToken: c.claim.claimToken })).cancelRequested, true)
  await c.append('cancelled')
  assert.equal((await f.admin('tasks/' + c.task.id)).status, 'cancelled')
  assert.equal((await f.admin('tasks/' + c.task.id)).text, '已收到')
  await assert.rejects(c.append('text_delta', { text: 'late' }), /TASK_CLOSED/)
  const queued = await f.create({ messageId: 'message-2', requestId: 'request-2' })
  assert.equal((await f.admin(`tasks/${queued.id}/cancel`, {})).status, 'cancelled')
})

test('session mapping and task filters isolate tabs; a session runs messages in order', async t => {
  const f = await fixture(t), c = await claimed(f)
  const same = await f.create({ messageId: 'message-2', requestId: 'request-2' })
  const other = await f.create({ sessionId: 'session-2', messageId: 'message-3', requestId: 'request-3' })
  await assert.rejects(c.a.call('claim_chat_task', { taskId: same.id, claimRequestId: 'next' }), /SESSION_BUSY/)
  await c.append('dispatching'); await c.append('started', { webConversationId: 'web-session-1' }); await c.append('completed')
  const claim = await c.a.call('claim_chat_task', { taskId: same.id, claimRequestId: 'next' })
  assert.equal(claim.task.webConversationId, 'web-session-1')
  assert.equal((await f.admin('tasks/' + other.id)).webConversationId, null)
  const events = await f.stream(other.id)
  assert.equal((await events.next()).taskId, other.id)
})

test('retention returns snapshot reset; receipts still deduplicate pruned events; body and state limits', async t => {
  const f = await fixture(t, { retainEvents: 3, maxTextBytes: 32 }), c = await claimed(f)
  const first = await c.append('dispatching')
  await c.append('started', { webConversationId: 'web-limit' })
  await c.append('text_delta', { text: '第一段' }); await c.append('text_delta', { text: '第二段' })
  const stream = await f.stream(c.task.id)
  const reset = await stream.next()
  assert.equal(reset.type, 'reset'); assert.equal(reset.snapshot.text, '第一段第二段')
  assert.equal(reset.seq, reset.snapshot.lastSeq)
  assert.deepEqual(await c.a.call('append_chat_event', { taskId: c.task.id, claimToken: c.claim.claimToken, clientSeq: 1, eventId: 'event-1', type: 'dispatching', payload: {} }), first)
  await assert.rejects(c.append('text_delta', { text: '文'.repeat(100) }), /TEXT_LIMIT/)
  assert.equal((await f.admin('tasks/' + c.task.id)).text, '第一段第二段')
  await assert.rejects(f.stream(c.task.id, 9999), /CURSOR_AHEAD/)
})

test('chat and adapter endpoints reject missing credentials, cross origin and file-connector privileges', async t => {
  const f = await fixture(t), c = await claimed(f)
  await assert.rejects(f.admin('tasks', undefined, { authorization: '' }), { status: 401 })
  await assert.rejects(f.admin('tasks', undefined, { origin: 'https://chatgpt.com' }), { status: 403 })
  await assert.rejects(f.stream(c.task.id, 0, { authorization: '' }), { status: 401 })
  const response = await fetch(f.bridge.origin + '/adapter-mcp/bad', { method: 'POST', body: '{}' })
  assert.equal(response.status, 401)
  assert.ok(!(await c.a.client.listTools()).tools.some(tool => /propose_file|report_result|accept/.test(tool.name)))
  const client = new Client({ name: 'file-connector-test', version: '1.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(f.bridge.mcpUrl)))
    assert.ok(!(await client.listTools()).tools.some(tool => /chat/.test(tool.name)))
  } finally { await client.close() }
})

test('a restarted adapter resumes the mapped webpage and durable text without creating a second task', async t => {
  const f = await fixture(t), c = await claimed(f)
  await c.append('dispatching'); await c.append('started', { webConversationId: 'persisted-web' })
  await c.append('text_delta', { text: '重启之前' })
  await f.restart()
  const a = await f.reconnect(c.a.registration)
  assert.equal((await f.admin('tasks/' + c.task.id)).text, '重启之前')
  await assert.rejects(a.call('claim_chat_task', { taskId: c.task.id, claimRequestId: 'different-worker' }), /DELIVERY_UNCERTAIN/)
  await a.call('append_chat_event', { taskId: c.task.id, claimToken: c.claim.claimToken, eventId: 'resume-4', clientSeq: 4, type: 'resumed', payload: { webConversationId: 'persisted-web' } })
  await a.call('append_chat_event', { taskId: c.task.id, claimToken: c.claim.claimToken, eventId: 'resume-5', clientSeq: 5, type: 'text_snapshot', payload: { text: '重启之前，继续之后' } })
  await a.call('append_chat_event', { taskId: c.task.id, claimToken: c.claim.claimToken, eventId: 'resume-6', clientSeq: 6, type: 'completed', payload: {} })
  assert.equal((await f.admin('tasks')).tasks.length, 1)
  assert.equal((await f.admin('tasks/' + c.task.id)).text, '重启之前，继续之后')
})

test('tool details, proposal references and errors survive snapshots independently of answer text', async t => {
  const f = await fixture(t), c = await claimed(f)
  await c.append('dispatching'); await c.append('started', { webConversationId: 'tools-web' })
  await c.append('tool_started', { toolId: 'read-file', name: '读取文件', input: 'hello.txt' })
  await c.append('tool_updated', { toolId: 'read-file', output: '读取中' })
  await c.append('tool_completed', { toolId: 'read-file', output: 'Hello from fixture.' })
  const proposalId = '00000000-0000-4000-8000-000000000001'
  await c.append('proposal_pending', { proposalId })
  await c.append('text_delta', { text: '正文' })
  await c.append('error', { code: 'PAGE_CHANGED', message: '页面结构改变，请检查网页' })
  const task = await f.admin('tasks/' + c.task.id)
  assert.equal(task.text, '正文'); assert.equal(task.tools['read-file'].status, 'completed')
  assert.deepEqual(task.proposals, [proposalId]); assert.equal(task.error.code, 'PAGE_CHANGED')
  assert.equal(task.status, 'error')
})

test('simultaneous workers get one claim, bad input and oversized requests leave the task unchanged', async t => {
  const f = await fixture(t), a = await f.adapter(), task = await f.create()
  const results = await Promise.allSettled(['a', 'b'].map(claimRequestId => a.call('claim_chat_task', { taskId: task.id, claimRequestId })))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected').length, 1)
  await assert.rejects(f.create({ extra: 'unexpected' }), /INVALID_INPUT/)
  await assert.rejects(f.create({ prompt: 'x'.repeat(256 * 1024) }), { status: 413 })
  assert.equal((await f.admin('tasks')).tasks.length, 1)
})

test('SSE last-event-id resumes exactly and service shutdown closes a live subscription', async t => {
  const f = await fixture(t), c = await claimed(f)
  const stream = await f.stream(c.task.id, 0, { 'last-event-id': '1' })
  assert.equal((await stream.next()).type, 'claimed')
  await f.bridge.close()
  await assert.rejects(stream.next(), /Stream ended|terminated/)
})
