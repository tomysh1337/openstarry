import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBridge } from '../server.mjs'
import { WebAdapter } from '../web-adapter.mjs'

class Pages {
  constructor() { this.pages = new Map(); this.sends = []; this.holdChildren = false; this.holdRoot = false }
  async page(key) {
    if (!this.pages.has(key)) this.pages.set(key, { key, turns: 0, reads: 0, webConversationId: 'web-' + key })
    return this.pages.get(key)
  }
  async ready(page) { return { userCount: page.turns, assistantCount: page.turns, webConversationId: page.turns ? page.webConversationId : null } }
  async send(page, prompt) { page.turns++; page.prompt = prompt; page.child = page.key.startsWith('mcp-subagent-'); this.sends.push(page.key) }
  async inspect(page) {
    page.reads++
    const busy = !page.stopped && (page.child ? this.holdChildren : this.holdRoot)
    return { userCount: page.turns, assistantCount: page.turns, lastUser: page.prompt, webConversationId: page.webConversationId,
      text: page.child ? 'child:' + page.key : 'parent waiting', busy, finished: !busy, alert: '' }
  }
  async stop(page) { page.stopped = true; return true }
  async close() {}
}
async function until(fn) {
  for (let i = 0; i < 300; i++) { if (await fn()) return; await delay(10) }
  throw Error('Subagent fixture timed out')
}
async function fixture(t, { adapter: enabled = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'openstarry-subagents-')), workspace = join(dir, 'workspace'), stateDir = join(dir, 'private')
  await mkdir(workspace)
  let bridge, adapter, client
  const driver = new Pages()
  const start = async () => {
    bridge = await startBridge({ workspace, stateDir, port: 0 })
    if (enabled) {
      adapter = new WebAdapter({ origin: bridge.origin, adminToken: bridge.adminToken, stateDir, pageDriver: driver, source: 'fixture', pollMs: 10, timeoutMs: 10000 })
      await adapter.start()
    }
    client = new Client({ name: 'subagent-fixture', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.mcpUrl)))
  }
  await start()
  const close = async () => { await adapter?.close(); await client?.close(); await bridge.close() }
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }) })
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    if (result.isError) throw Error(result.content[0].text)
    return JSON.parse(result.content[0].text)
  }
  const admin = async (route, body) => {
    const response = await fetch(bridge.origin + '/admin/' + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + bridge.adminToken, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const result = await response.json(); assert.ok(response.ok, result.error); return result
  }
  const parent = await call('create_task', { prompt: 'parent fixture context that must not be inherited', request_id: 'parent' })
  const spawn = (request_id = 'one') => call('spawn_subagent', { task_id: parent.id, name: request_id, prompt: 'Return the child fixture result', request_id })
  const get = (child, extra = {}) => call('get_subagent', { task_id: parent.id, subagent_id: child.id, ...extra })
  return { driver, parent, call, admin, spawn, get, stateDir, get adapter() { return adapter }, get bridge() { return bridge }, restart: async () => { await close(); await start() } }
}

test('SDK subagents deduplicate, use independent contexts, return actual results and survive restart', async t => {
  const f = await fixture(t)
  const [one, duplicate] = await Promise.all([f.spawn(), f.spawn()])
  assert.equal(one.id, duplicate.id)
  await assert.rejects(f.call('spawn_subagent', { task_id: f.parent.id, name: 'changed', prompt: 'Return the child fixture result', request_id: 'one' }), /REQUEST_CONFLICT/)
  const two = await f.spawn('two')
  const first = await f.admin('chat/tasks/' + one.id), second = await f.admin('chat/tasks/' + two.id)
  assert.notEqual(first.sessionId, second.sessionId)
  assert.ok(!first.prompt.includes(f.parent.prompt)); assert.equal(first.kind, 'subagent')
  await f.adapter.tick()
  const result = await f.get(one, { limit: 5 })
  assert.equal(result.status, 'completed'); assert.equal(result.source, 'fixture'); assert.equal(result.text, 'child'); assert.equal(result.next_offset, 5)
  const rest = await f.get(one, { offset: result.next_offset })
  assert.equal(result.text + rest.text, (await f.admin('chat/tasks/' + one.id)).text)
  assert.equal(rest.claimToken, undefined)
  await f.restart()
  assert.equal((await f.spawn()).id, one.id)
  assert.equal((await f.get(one)).done, true)
  await f.adapter.tick(); assert.equal(f.driver.sends.length, 2)
  const privateState = JSON.parse(await readFile(join(f.stateDir, 'web-adapter-private.json'), 'utf8'))
  assert.equal(Object.keys(privateState.jobs).length, 2)
})

test('subagent list exposes live partial output and tools, then retains failure details without full payloads', async t => {
  const f = await fixture(t); f.driver.holdChildren = true
  const child = await f.spawn(), running = f.adapter.tick()
  await until(async () => (await f.get(child)).total_characters > 0)
  await f.call('read_file', { path: 'missing-fixture.txt', task_id: child.file_task_id })
  const listed = (await f.admin('subagents')).subagents.find(item => item.id === child.id)
  assert.equal(listed.status, 'generating'); assert.ok(listed.progress.characters > 0)
  assert.match(listed.progress.preview, /^child:/)
  assert.equal(listed.progress.toolCount, 1); assert.equal(listed.progress.activeTool, null)
  assert.equal(listed.text, undefined); assert.equal(listed.prompt, undefined); assert.equal(listed.tools, undefined)
  const inspect = f.driver.inspect.bind(f.driver)
  f.driver.inspect = async page => ({ ...await inspect(page), webConversationId: 'changed-conversation' })
  await running
  const failed = (await f.admin('subagents')).subagents.find(item => item.id === child.id)
  assert.equal(failed.done, true); assert.equal(failed.error.code, 'SESSION_CHANGED')
  assert.equal(failed.progress.preview, listed.progress.preview)
  await f.restart()
  const persisted = (await f.admin('subagents')).subagents.find(item => item.id === child.id)
  assert.equal(persisted.error.code, 'SESSION_CHANGED'); assert.equal(persisted.progress.characters, failed.progress.characters)
})

test('two children run while the parent waits; excess children queue without blocking result retrieval', async t => {
  const f = await fixture(t); f.driver.holdRoot = true; f.driver.holdChildren = true
  const root = await f.admin('chat/tasks', { clientId: 'desktop', adapterId: 'desktop-web', sessionId: 'parent', messageId: 'root', requestId: 'root', prompt: 'main', fileTaskId: f.parent.id })
  const rootRunning = f.adapter.tick()
  await until(async () => (await f.admin('chat/tasks/' + root.id)).status === 'generating')
  const one = await f.spawn('one'), two = await f.spawn('two'), three = await f.spawn('three')
  const childrenRunning = f.adapter.tick()
  await until(async () => (await f.get(one)).status === 'generating' && (await f.get(two)).status === 'generating')
  assert.equal((await f.get(three)).status, 'queued')
  assert.equal(f.adapter.activeJobs.size, 3)
  await f.adapter.tick(); assert.equal(f.driver.sends.length, 3)
  assert.equal((await f.get(one, { wait_ms: 25 })).done, false)
  await assert.rejects(f.call('report_result', { task_id: f.parent.id, status: 'completed', text: 'too early' }), /SUBAGENT_PENDING/)
  const waiting = f.get(one, { wait_ms: 2000 })
  f.driver.holdChildren = false
  assert.equal((await waiting).done, true)
  await childrenRunning
  await f.adapter.tick(); assert.equal((await f.get(three)).done, true)
  assert.equal((await f.admin('chat/tasks/' + root.id)).status, 'generating')
  f.driver.holdRoot = false; await rootRunning
})

test('cancelling one child preserves siblings; parent cancellation cascades and prevents new children', async t => {
  const f = await fixture(t); f.driver.holdRoot = true; f.driver.holdChildren = true
  const root = await f.admin('chat/tasks', { clientId: 'desktop', adapterId: 'desktop-web', sessionId: 'parent', messageId: 'root', requestId: 'root', prompt: 'main', fileTaskId: f.parent.id })
  const one = await f.spawn('one'), two = await f.spawn('two'), three = await f.spawn('three')
  const running = f.adapter.tick()
  await until(async () => (await f.get(one)).status === 'generating')
  await f.call('cancel_subagent', { task_id: f.parent.id, subagent_id: one.id })
  await until(async () => (await f.get(one)).done)
  assert.equal((await f.get(one)).status, 'cancelled')
  assert.equal((await f.get(two)).status, 'generating')
  assert.equal((await f.admin('chat/tasks/' + root.id)).status, 'generating')
  await f.admin('chat/tasks/' + root.id + '/cancel', {})
  assert.equal((await f.get(three)).status, 'cancelled')
  await running
  assert.equal((await f.get(two)).status, 'cancelled')
  assert.ok((await f.get(two)).text.startsWith('child:'))
  await assert.rejects(f.spawn('late'), /TASK_CLOSED/)
})

test('ownership, adapter availability, child quotas and file reviews remain enforced', async t => {
  const offline = await fixture(t, { adapter: false })
  await assert.rejects(offline.spawn(), /SUBAGENT_UNAVAILABLE/)
  const f = await fixture(t), one = await f.spawn()
  await assert.rejects(f.call('get_subagent', { task_id: offline.parent.id, subagent_id: one.id }), /SUBAGENT_NOT_FOUND/)
  await assert.rejects(f.call('cancel_subagent', { task_id: offline.parent.id, subagent_id: one.id }), /SUBAGENT_NOT_FOUND/)
  await assert.rejects(f.call('spawn_subagent', { task_id: one.file_task_id, name: 'nested', prompt: 'nested', request_id: 'nested' }), /SUBAGENT_DEPTH/)
  const proposal = await f.call('propose_file', { task_id: one.file_task_id, path: 'child.txt', content: 'review me', expected_version: null, request_id: 'proposal' })
  await f.adapter.tick()
  assert.equal((await f.get(one)).pending_proposals[0].id, proposal.id)
  await assert.rejects(f.call('report_result', { task_id: f.parent.id, status: 'completed', text: 'premature' }), /REVIEW_PENDING/)
  await f.bridge.store.decide(proposal.id, 'reject')
  for (let i = 1; i < 8; i++) await f.spawn('limit-' + i)
  await assert.rejects(f.spawn('overflow'), /SUBAGENT_LIMIT/)
  assert.equal((await f.call('list_subagents', { task_id: f.parent.id })).subagents.length, 8)
})

test('interrupted children resume their existing webpages without sending again', async t => {
  const f = await fixture(t); f.driver.holdChildren = true
  const one = await f.spawn('one'), two = await f.spawn('two'), running = f.adapter.tick()
  await until(async () => (await f.get(one)).text && (await f.get(two)).text)
  await f.restart(); await running
  assert.equal((await f.get(one)).status, 'interrupted')
  f.driver.holdChildren = false; await f.adapter.tick()
  assert.equal((await f.get(one)).status, 'completed'); assert.equal((await f.get(two)).status, 'completed')
  assert.equal(f.driver.sends.length, 2)
})
