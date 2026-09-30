import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBridge } from '../server.mjs'
import { toolObserver } from '../tool-observer.mjs'

test('real MCP request/reply telemetry reaches its chat and preserves adapter event ordering', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openstarry-tool-observer-')), workspace = join(root, 'work')
  await mkdir(workspace)
  const bridge = await startBridge({ workspace, stateDir: join(root, 'private'), port: 0 }), clients = []
  t.after(async () => { await Promise.all(clients.map(c => c.close())); await bridge.close(); await rm(root, { recursive: true, force: true }) })
  const admin = async (route, data) => { const r = await fetch(bridge.origin + '/admin/' + route, { method: data ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + bridge.adminToken, 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined }); assert.equal(r.ok, true); return r.json() }
  async function client(url) { const client = new Client({ name: 'fixture', version: '1' }); clients.push(client); await client.connect(new StreamableHTTPClientTransport(new URL(url))); return async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.equal(Boolean(result.isError), false, result.content[0].text); return JSON.parse(result.content[0].text) } }
  const adapter = await admin('chat/adapters', { adapterId: 'desktop-web', source: 'fixture' }), appendTool = await client(adapter.mcpUrl), tool = await client(bridge.mcpUrl)
  const parent = await admin('chat/tasks', { clientId: 'desktop', adapterId: 'desktop-web', sessionId: 'one', messageId: 'one', requestId: 'one', prompt: 'test' })
  const claim = await appendTool('claim_chat_task', { taskId: parent.id, claimRequestId: 'claim' })
  const append = (seq, type, payload = {}) => appendTool('append_chat_event', { taskId: parent.id, claimToken: claim.claimToken, clientSeq: seq, eventId: 'event-' + seq, type, payload })
  await append(1, 'dispatching'); await append(2, 'started', { webConversationId: 'parent-web' })
  const fileTask = await tool('create_task', { prompt: 'owned files', request_id: 'file-task' })
  await tool('read_file', { task_id: fileTask.id, path: 'hello.txt' })
  const task = await admin('chat/tasks/' + parent.id)
  assert.deepEqual(task.connectorTaskIds, [fileTask.id])
  const events = Object.values(task.tools)
  assert.deepEqual(events.map(e => e.name), ['create_task', 'read_file'])
  assert.equal(events[1].provider, 'OpenStarry MCP'); assert.match(events[1].input, /hello\.txt/)
  assert.equal(JSON.parse(events[1].output).version, null); assert.equal(events[1].status, 'completed'); assert.ok(events[1].durationMs >= 0)
  await append(3, 'text_delta', { text: 'live' })
  const child = await tool('spawn_subagent', { task_id: fileTask.id, name: 'child', prompt: 'test child', request_id: 'child' })
  const childClaim = await appendTool('claim_chat_task', { taskId: child.id, claimRequestId: 'child-claim' })
  await appendTool('append_chat_event', { taskId: child.id, claimToken: childClaim.claimToken, clientSeq: 1, eventId: 'child-event', type: 'dispatching', payload: {} })
  const before = Object.keys((await admin('chat/tasks/' + parent.id)).tools).length
  await tool('get_status')
  assert.equal(Object.keys((await admin('chat/tasks/' + parent.id)).tools).length, before, 'ambiguous tools must not be assigned to the parent')
  await tool('read_file', { task_id: child.file_task_id, path: 'child.txt' })
  assert.equal(Object.values((await admin('chat/tasks/' + child.id)).tools)[0].name, 'read_file')
  await append(4, 'completed')
  assert.ok((await admin('chat/tasks/' + parent.id)).finishedAt)
})
test('telemetry storage failure does not change a successful tool result; credentials are redacted', () => {
  const payloads = [], warnings = [], task = { id: 'one', status: 'generating' }
  const chat = { list: () => ({ tasks: [task] }), observeTool: (_id, type, payload) => { payloads.push(payload); if (type === 'tool_completed') throw Error('fixture'); return true } }
  const finish = toolObserver(chat, () => warnings.push('failed'))('fixture', { token: 'secret', apiKey: 'secret', nested: { password: 'secret' }, address: 'https://fixture/mcp/secret' })
  assert.doesNotThrow(() => finish({ saved: true }))
  assert.equal(warnings.length, 1); assert.ok(!payloads[0].input.includes('secret'))
})
