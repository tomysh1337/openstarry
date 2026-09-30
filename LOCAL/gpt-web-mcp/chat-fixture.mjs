import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBridge } from './server.mjs'

// Standalone fixture: never reads the persistent service's credentials, tasks or proposals.
const tempRoot = await realpath(tmpdir())
const dir = await mkdtemp(join(tempRoot, 'openstarry-chat-demo-'))
let bridge, client
const controller = new AbortController()
try {
  const workspace = join(dir, 'workspace'); await mkdir(workspace)
  bridge = await startBridge({ workspace, stateDir: join(dir, 'private'), port: 0 })
  const admin = async (path, data) => {
    const response = await fetch(bridge.origin + '/admin/chat/' + path, {
      method: data === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + bridge.adminToken, 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(5000)
    })
    const value = await response.json(); if (!response.ok) throw Error(value.error); return value
  }
  const adapter = await admin('adapters', { adapterId: 'fixture', source: 'fixture' })
  const task = await admin('tasks', { clientId: 'demo', adapterId: 'fixture', sessionId: 'demo-session', messageId: 'demo-message', requestId: 'demo-request', prompt: '展示中文增量传输' })
  client = new Client({ name: 'OpenStarry-explicit-fixture', version: '0.2.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(adapter.mcpUrl)))
  const call = async (name, args) => {
    const reply = await client.callTool({ name, arguments: args })
    if (reply.isError) throw Error(reply.content[0].text)
    return JSON.parse(reply.content[0].text)
  }
  const claim = await call('claim_chat_task', { taskId: task.id, claimRequestId: 'demo-worker' })
  let clientSeq = 0, firstAt, completedAt
  const emit = (type, payload = {}) => call('append_chat_event', { taskId: task.id, claimToken: claim.claimToken, clientSeq: ++clientSeq, eventId: 'demo-' + clientSeq, type, payload })
  const response = await fetch(`${bridge.origin}/admin/chat/tasks/${task.id}/events`, {
    headers: { authorization: 'Bearer ' + bridge.adminToken }, signal: controller.signal
  })
  if (!response.ok) throw Error('Fixture subscription failed')
  console.log('模拟适配器 fixture：真实 MCP + 本地 SSE 传输；内容为测试文本，未访问 ChatGPT。')
  const reader = (async () => {
    const decoder = new TextDecoder(); let buffer = ''
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true })
      while (buffer.includes('\n\n')) {
        const end = buffer.indexOf('\n\n'), block = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        const line = block.split('\n').find(line => line.startsWith('data: '))
        if (!line) continue
        const event = JSON.parse(line.slice(6))
        if (event.type === 'text_delta') {
          firstAt ??= Date.now()
          if ((await admin('tasks/' + task.id)).status !== 'generating') throw Error('First text arrived after generation ended')
          process.stdout.write(event.payload.text)
        }
        if (event.type === 'completed') completedAt = Date.now()
      }
    }
  })()
  const writer = (async () => {
    await emit('dispatching'); await emit('started', { webConversationId: 'fixture-conversation' })
    for (const text of ['你好，', '这段中文通过 MCP 写入，', '再由同一服务的 SSE 逐段送达。']) { await emit('text_delta', { text }); await delay(180) }
    await emit('completed')
  })()
  try { await Promise.all([reader, writer]) } finally { controller.abort(); await Promise.allSettled([reader, writer]) }
  if (!firstAt || !completedAt || firstAt >= completedAt) throw Error('No evidence of text arriving before completion')
  console.log('\n' + JSON.stringify({ source: 'fixture', firstTextAt: new Date(firstAt).toISOString(), completedAt: new Date(completedAt).toISOString(), firstBeforeCompleteMs: completedAt - firstAt }))
} finally {
  controller.abort(); await client?.close(); await bridge?.close()
  const resolved = await realpath(dir)
  if (dirname(resolved) !== tempRoot || !basename(resolved).startsWith('openstarry-chat-demo-')) throw Error('Unexpected fixture cleanup path')
  await rm(resolved, { recursive: true, force: true })
}
