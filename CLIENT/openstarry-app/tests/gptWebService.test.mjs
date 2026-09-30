import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '../../../LOCAL/gpt-web-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StreamableHTTPClientTransport } from '../../../LOCAL/gpt-web-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js'
import { GptWebService } from '../src/main/app/gptWebService.mjs'
import { IdeWorkspace } from '../src/main/app/ideWorkspace.mjs'
import { parsePairingCode } from '../../../LOCAL/gpt-web-mcp/edge-extension/protocol.mjs'

test('local safety selection updates the real worker without restarting and keeps sandbox settings private', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'openstarry-safety-service-')), sandboxDir = join(dir, 'sandbox'), baseDir = join(dir, 'private')
  await fs.mkdir(sandboxDir); await fs.mkdir(baseDir)
  await fs.writeFile(join(baseDir, 'file-access.json'), JSON.stringify({ fileScope: 'all-disks', newFilePolicy: 'direct' }))
  await fs.writeFile(join(sandboxDir, 'connection.json'), JSON.stringify({ domain: '127.0.0.1:49330', apiKey: 'fixture'.repeat(8) }))
  const service = new GptWebService({ baseDir, sandboxDir, scriptPath: resolve('../../LOCAL/gpt-web-mcp/desktop-worker.mjs'), nodePaths: [process.execPath], workspace: new IdeWorkspace() })
  const client = new Client({ name: 'safety-fixture', version: '1' })
  t.after(async () => { await client.close(); await service.stop(); await fs.rm(dir, { recursive: true, force: true }) })
  const first = await service.services({ action: 'safety-set', safetyMode: 'ask' }); assert.equal(first.bridge.safetyMode, 'ask'); assert.equal(service.current, undefined)
  await service.ensure({ id: 'home' }); const origin = service.current.origin
  await client.connect(new StreamableHTTPClientTransport(new URL(service.current.mcpUrl)))
  assert.equal((await client.callTool({ name: 'create_file', arguments: { path: join(dir, 'new.txt'), content: 'test', request_id: 'new' } })).isError, true)
  await service.services({ action: 'safety-set', safetyMode: 'full' }); assert.equal(service.current.origin, origin)
  const status = JSON.parse((await client.callTool({ name: 'get_status', arguments: {} })).content[0].text)
  assert.equal(status.safetyMode, 'full'); assert.equal(status.existingFileReviewRequired, false)
  assert.equal((await client.callTool({ name: 'read_file', arguments: { path: join(sandboxDir, 'connection.json') } })).isError, true)
  const toolNames = (await client.listTools()).tools.map(t => t.name)
  assert.ok(toolNames.includes('sandbox_run')); assert.ok(toolNames.includes('sandbox_result')); assert.ok(toolNames.includes('spawn_subagent'))
  assert.ok(!toolNames.includes('sandbox_approve')); assert.ok(!toolNames.includes('safety_set'))
  await assert.rejects(service.services({ action: 'sandbox-read', projectId: 'other', executionId: 'x' }), /工作区已改变/)
  await assert.rejects(service.services({ action: 'subagent-read', projectId: 'other', subagentId: 'x' }), /工作区已改变/)
})

test('real worker starts without a browser and copies pairing only inside the main process', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'openstarry-extension-service-'))
  const service = new GptWebService({ baseDir: dir, scriptPath: resolve('../../LOCAL/gpt-web-mcp/desktop-worker.mjs'), nodePaths: [process.execPath], workspace: new IdeWorkspace() })
  t.after(async () => { await service.stop(); await fs.rm(dir, { recursive: true, force: true }) })
  let copied
  const first = await service.show({ id: 'home' }, code => { copied = code })
  const pairing = parsePairingCode(copied)
  assert.equal(first.browser, 'closed')
  assert.equal(first.extensionConnected, false)
  assert.equal(first.pairingCode, undefined)
  assert.ok(!JSON.stringify(first).includes(pairing.token))
  assert.equal((await service.admin('chat/tasks')).tasks.length, 0)
  const status = await service.status({ id: 'home' })
  assert.ok(!JSON.stringify(status).includes(pairing.token))
  const second = await service.show({ id: 'ide' }, code => { copied = code })
  assert.deepEqual(parsePairingCode(copied), pairing, 'switching projects preserves the ordinary Edge pairing')
  assert.equal(second.pairingCode, undefined)
  assert.equal(second.extensionConnected, false)
})

test('homepage service controls start and stop the real local worker without opening Edge', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'openstarry-service-controls-'))
  const service = new GptWebService({ baseDir: dir, scriptPath: resolve('../../LOCAL/gpt-web-mcp/desktop-worker.mjs'), nodePaths: [process.execPath], workspace: new IdeWorkspace() })
  t.after(async () => { await service.stop(); await fs.rm(dir, { recursive: true, force: true }) })
  assert.equal((await service.services()).bridge.status, 'stopped')
  assert.equal((await service.tunnelStatus({ id: 'home' })).status, 'stopped')
  assert.equal(service.child, undefined, 'status must not start a helper')
  await assert.rejects(service.services({ action: 'invalid' }), /格式错误/)
  const project = { id: 'home', name: '首页网页对话' }
  const started = await service.services({ action: 'bridge-start', project })
  assert.equal(started.bridge.status, 'ready'); assert.equal(started.bridge.projectName, project.name)
  assert.equal(started.browser.extensionConnected, false)
  const child = service.child, origin = service.current.origin
  const health = await fetch(origin + '/health'); assert.equal(health.status, 200)
  await service.services({ action: 'bridge-start', project: { id: 'other-project' } })
  assert.equal(service.child, child, 'toolbar retains the active workspace')
  await assert.rejects(service.services({ action: 'tunnel-start', project }), /cloudflared/)
  assert.equal((await service.services()).bridge.status, 'ready', 'tunnel failure retains local Bridge')
  let code
  const paired = await service.services({ action: 'pair', project }, value => { code = value })
  const token = parsePairingCode(code).token
  assert.ok(!JSON.stringify(paired).includes(token))
  await assert.rejects(service.services({ action: 'copy-address' }, () => assert.fail('No ready address')), /公网连接/)
  await service.services({ action: 'tunnel-stop' })
  assert.equal(service.child, child)
  const stopped = await service.services({ action: 'bridge-stop' })
  assert.equal(stopped.bridge.status, 'stopped'); assert.equal(stopped.tunnel.status, 'stopped')
  await assert.rejects(fetch(origin + '/health', { signal: AbortSignal.timeout(1000) }))
})

test('service controls protect unfinished replies and copy public capabilities only in main process', async t => {
  const f = await fixture(t)
  const task = await f.service.submit({ ...f.payload, prompt: '保持生成' })
  assert.equal((await f.service.services()).bridge.busy, true)
  await assert.rejects(f.service.services({ action: 'bridge-stop' }), /未完成/)
  assert.equal(f.service.current.projectId, f.project.id)
  await f.service.cancel({ project: f.project, taskId: task.id })
  await f.service.watch({ project: f.project, taskId: task.id, watchId: 'control-stop' }, () => {})
  const rpc = f.service.rpc.bind(f.service)
  f.service.rpc = type => type === 'tunnel-status' ? Promise.resolve({ status: 'connected', running: true, origin: 'https://fixture.example' }) : rpc(type)
  const mcpUrl = 'https://fixture.example/mcp/private-test-capability'
  await fs.writeFile(join(f.service.current.stateDir, 'public-connection.json'), JSON.stringify({ mcpUrl }))
  let copied
  const value = await f.service.services({ action: 'copy-address' }, text => { copied = text })
  assert.equal(copied, mcpUrl)
  assert.ok(!JSON.stringify(value).includes('private-test-capability'))
  assert.equal((await f.service.services({ action: 'bridge-stop' })).bridge.status, 'stopped')
})

test('saved full-disk scope reaches the real worker and public file tools without opening Edge', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'openstarry-disk-scope-service-')), baseDir = join(dir, 'private')
  await fs.mkdir(baseDir)
  await fs.writeFile(join(baseDir, 'file-access.json'), JSON.stringify({ fileScope: 'all-disks', newFilePolicy: 'direct' }))
  const outside = join(dir, 'outside.txt'); await fs.writeFile(outside, 'disk fixture')
  const service = new GptWebService({ baseDir, scriptPath: resolve('../../LOCAL/gpt-web-mcp/desktop-worker.mjs'), nodePaths: [process.execPath], workspace: new IdeWorkspace() })
  const client = new Client({ name: 'disk-scope-service', version: '1' })
  t.after(async () => { await client.close(); await service.stop(); await fs.rm(dir, { recursive: true, force: true }) })
  assert.equal((await service.services()).bridge.fileScope, 'all-disks')
  const status = await service.services({ action: 'bridge-start', project: { id: 'home' } })
  assert.equal(status.bridge.fileScope, 'all-disks'); assert.equal(status.browser.extensionConnected, false)
  assert.equal(status.bridge.newFilePolicy, 'direct')
  await client.connect(new StreamableHTTPClientTransport(new URL(service.current.mcpUrl)))
  const result = await client.callTool({ name: 'read_file', arguments: { path: outside } })
  assert.equal(JSON.parse(result.content[0].text).content, 'disk fixture')
  const privateRead = await client.callTool({ name: 'read_file', arguments: { path: join(baseDir, 'file-access.json') } })
  assert.equal(privateRead.isError, true)
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, result.content[0].text)
    return JSON.parse(result.content[0].text)
  }
  assert.equal((await call('get_status')).newFilePolicy, 'direct')
  assert.equal((await call('list_tasks')).tasks.length, 0)
  const newPath = join(dir, 'created.txt')
  assert.equal((await call('create_file', { path: newPath, content: 'new', request_id: 'new' })).status, 'created')
  assert.equal(await fs.readFile(newPath, 'utf8'), 'new')
  const task = await call('create_task', { prompt: 'Review from homepage connector', request_id: 'connector-task' })
  const file = await call('read_file', { path: outside })
  const proposal = await call('propose_file', { task_id: task.id, path: outside, content: 'changed', expected_version: file.version, request_id: 'edit' })
  const pending = (await service.services()).pendingProposals
  assert.equal(pending.length, 1); assert.equal(pending[0].id, proposal.id)
  assert.equal(pending[0].after, undefined, 'polling returns summaries, not full file contents')
  const read = await service.services({ action: 'review-read', projectId: 'home', proposalId: proposal.id })
  assert.equal(read.proposal.before, 'disk fixture'); assert.equal(read.proposal.after, 'changed')
  assert.equal(read.proposal.absolutePath, outside.replaceAll('\\', '/'))
  await assert.rejects(service.services({ action: 'review-accept', projectId: 'stale-project', proposalId: proposal.id }), /工作区已改变/)
  await fs.writeFile(outside, 'user edit')
  await assert.rejects(service.services({ action: 'review-accept', projectId: 'home', proposalId: proposal.id }), /VERSION_CONFLICT/)
  assert.equal(await fs.readFile(outside, 'utf8'), 'user edit')
  await fs.writeFile(outside, 'disk fixture')
  const accepted = await service.services({ action: 'review-accept', projectId: 'home', proposalId: proposal.id, project: { id: 'different-home' } })
  assert.match(accepted.message, /已接受并保存/)
  assert.equal(accepted.pendingProposals.length, 0); assert.equal(service.current.projectId, 'home')
  assert.equal(await fs.readFile(outside, 'utf8'), 'changed')
  const backup = JSON.parse(await fs.readFile(join(service.current.stateDir, 'backups', proposal.id + '.json'), 'utf8'))
  assert.equal(backup.before, 'disk fixture')
  const local = await service.admin('tasks', { prompt: 'Unrelated old task' })
  await call('propose_file', { task_id: local.id, path: newPath, content: 'unrelated', expected_version: (await call('read_file', { path: newPath })).version, request_id: 'legacy' })
  assert.equal((await service.services()).pendingProposals.length, 0, 'unrelated old tasks are not silently adopted')
})

test('full-disk IDE proposals carry external paths to local review without becoming project files', async t => {
  const f = await fixture(t, true)
  await fs.mkdir(f.service.baseDir, { recursive: true })
  await fs.writeFile(join(f.service.baseDir, 'file-access.json'), JSON.stringify({ fileScope: 'all-disks' }))
  const outside = resolve(f.nativeRoot, '../outside.txt'); await fs.writeFile(outside, 'before')
  const task = await f.service.submit({ ...f.payload, mode: 'agent' })
  const client = new Client({ name: 'external-review-fixture', version: '1' })
  t.after(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(f.service.current.mcpUrl)))
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError)
    return JSON.parse(result.content[0].text)
  }
  const file = await call('read_file', { path: outside })
  const proposal = await call('propose_file', { task_id: task.fileTaskId, path: outside, content: 'after', expected_version: file.version, request_id: 'external' })
  const values = await f.service.proposals(f.project)
  assert.equal(values[0].external, true); assert.equal(values[0].path, outside.replaceAll('\\', '/'))
  assert.equal(await fs.readFile(outside, 'utf8'), 'before')
  await f.service.review({ project: f.project, proposalId: proposal.id, decision: 'accept' })
  assert.equal(await fs.readFile(outside, 'utf8'), 'after')
  assert.equal(await fs.readFile(join(f.nativeRoot, 'hello.txt'), 'utf8'), 'before\n')
})

test('download resolves task-owned file references before forwarding a fixed browser operation', async () => {
  const service = new GptWebService({}), calls = []
  service.withProject = async (_project, action) => action()
  service.admin = async () => ({ clientId: 'desktop', sessionId: 'session-one', webConversationId: 'web-one', prompt: '原问题', text: '',
    artifacts: [{ path: 'sandbox:/mnt/data/README.md', name: 'README.md', messageId: 'answer-one' }] })
  service.rpc = async (type, payload) => { calls.push({ type, payload }); return { requested: true } }
  const request = { project: { id: 'project' }, taskId: 'task-one', path: 'sandbox:/mnt/data/README.md' }
  assert.equal((await service.download(request)).requested, true)
  assert.deepEqual(calls[0], { type: 'download', payload: { key: 'desktop-session-one', webConversationId: 'web-one', path: request.path, messageId: 'answer-one' } })
  await assert.rejects(service.download({ ...request, path: 'sandbox:/mnt/data/other.md' }), /没有记录/)
  await assert.rejects(service.download({ ...request, path: 'https://example.com/private' }), /标识错误/)
  assert.equal(calls.length, 1)
})

test('thinking metadata is validated, forwarded and included in duplicate request identity', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.submit({ ...f.payload, thinking: 'true' }), /思考开关/)
  const task = await f.service.submit({ ...f.payload, thinking: true })
  assert.equal(task.thinking, true)
  assert.equal((await f.service.submit({ ...f.payload, thinking: true })).id, task.id)
  await assert.rejects(f.service.submit({ ...f.payload, thinking: false }), /不同消息/)
  await assert.rejects(f.service.submit(f.payload), /不同消息/)
})

async function fixture(t, native = false) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'openstarry-desktop-web-test-')), workspace = new IdeWorkspace()
  const nativeRoot = join(dir, 'project'); await fs.mkdir(nativeRoot)
  if (native) { await workspace.authorize(nativeRoot); await fs.writeFile(join(nativeRoot, 'hello.txt'), 'before\n') }
  const service = new GptWebService({ baseDir: join(dir, 'private'), scriptPath: resolve('../../LOCAL/gpt-web-mcp/test/desktop-fixture-worker.mjs'), nodePaths: [process.execPath], workspace })
  const project = { id: 'fixture-project', nativeRoot: native ? nativeRoot : '', files: { 'hello.txt': 'before\n' } }
  t.after(async () => { await service.stop(); await fs.rm(dir, { recursive: true, force: true }) })
  const payload = { project, sessionId: 'session', messageId: 'message', requestId: 'request', prompt: '请展示中文回复', mode: 'ask' }
  return { service, project, payload, nativeRoot }
}

test('desktop service starts privately, streams before completion and reuses the same send request', async t => {
  const f = await fixture(t), task = await f.service.submit(f.payload)
  assert.equal((await f.service.submit(f.payload)).id, task.id)
  assert.equal(task.adminToken, undefined)
  const events = []; let completed = false, firstBeforeCompletion = false
  const result = await f.service.watch({ project: f.project, taskId: task.id, watchId: 'watch-one' }, event => {
    events.push(event); if (event.type === 'text_delta') firstBeforeCompletion = !completed
    if (event.type === 'completed') completed = true
  })
  assert.ok(firstBeforeCompletion); assert.equal(result.status, 'completed'); assert.equal(result.source, 'fixture')
  assert.equal(result.text, '桌面链路的中文增量')
  assert.ok(events.every(e => e.taskId === task.id))
  await assert.rejects(f.service.submit({ ...f.payload, prompt: '不同内容' }), /不同消息/)
  const connection = await f.service.status(f.project)
  assert.equal(connection.adminToken, undefined); assert.equal(connection.mcpUrl, undefined)
})

test('desktop cancellation is separate from closing a subscriber', async t => {
  const f = await fixture(t), task = await f.service.submit(f.payload)
  const seen = new Promise(resolve => { f.service.watch({ project: f.project, taskId: task.id, watchId: 'detach' }, e => { if (e.type === 'text_delta') resolve() }).catch(() => {}) })
  await seen; f.service.unwatch('detach')
  const state = await f.service.admin('chat/tasks/' + task.id)
  assert.equal(state.status, 'generating')
  const cancel = await f.service.cancel({ project: f.project, taskId: task.id })
  assert.equal(cancel.status, 'cancel_requested')
  const final = await f.service.watch({ project: f.project, taskId: task.id, watchId: 'cancel-confirmation' }, () => {})
  assert.ok(['completed', 'cancelled'].includes(final.status))
})

test('file connector proposals enter desktop review; conflict prevents overwrite and accepting creates a backup', async t => {
  const f = await fixture(t, true), task = await f.service.submit({ ...f.payload, mode: 'agent' })
  const client = new Client({ name: 'fixture-connector', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(f.service.current.mcpUrl)))
  t.after(() => client.close())
  const call = async (name, args) => {
    const value = await client.callTool({ name, arguments: args }); if (value.isError) throw Error(value.content[0].text); return JSON.parse(value.content[0].text)
  }
  const file = await call('read_file', { task_id: task.fileTaskId, path: 'hello.txt' })
  const proposal = await call('propose_file', { task_id: task.fileTaskId, path: 'hello.txt', content: 'after\n', expected_version: file.version, request_id: 'change' })
  assert.equal((await f.service.proposals(f.project))[0].id, proposal.id)
  await fs.writeFile(join(f.nativeRoot, 'hello.txt'), 'local edit')
  await assert.rejects(f.service.review({ project: f.project, proposalId: proposal.id, decision: 'accept' }), /VERSION_CONFLICT/)
  assert.equal(await fs.readFile(join(f.nativeRoot, 'hello.txt'), 'utf8'), 'local edit')
  await fs.writeFile(join(f.nativeRoot, 'hello.txt'), 'before\n')
  await f.service.review({ project: f.project, proposalId: proposal.id, decision: 'accept' })
  assert.equal(await fs.readFile(join(f.nativeRoot, 'hello.txt'), 'utf8'), 'after\n')
  const backup = JSON.parse(await fs.readFile(join(f.service.current.stateDir, 'backups', proposal.id + '.json'), 'utf8'))
  assert.equal(backup.before, 'before\n')
})

test('concurrent Agent retries create one chat task and one linked file task', async t => {
  const f = await fixture(t)
  const payload = { ...f.payload, mode: 'agent', prompt: '保持生成，检查重复请求' }
  const results = await Promise.all([f.service.submit(payload), f.service.submit(payload)])
  assert.equal(results[0].id, results[1].id)
  assert.equal((await f.service.admin('tasks')).tasks.length, 1)
  assert.equal((await f.service.admin('chat/tasks')).tasks.length, 1)
  await assert.rejects(f.service.submit({ ...payload, mode: 'ask' }), /不同消息/)
})

test('project switching cannot stop an active reply after its UI subscriber closes', async t => {
  const f = await fixture(t)
  const task = await f.service.submit({ ...f.payload, prompt: '保持生成，检查项目归属' })
  await assert.rejects(f.service.ensure({ ...f.project, id: 'another-project' }), /未完成/)
  assert.equal(f.service.current.projectId, f.project.id)
  await f.service.cancel({ project: f.project, taskId: task.id })
  await f.service.watch({ project: f.project, taskId: task.id, watchId: 'finish' }, () => {})
  await f.service.ensure({ ...f.project, id: 'another-project' })
  assert.equal(f.service.current.projectId, 'another-project')
})

test('closing a subscription while it is preparing leaves no live watcher or generation cancellation', async t => {
  const f = await fixture(t), task = await f.service.submit({ ...f.payload, prompt: '保持生成，检查订阅关闭' })
  const watching = f.service.watch({ project: f.project, taskId: task.id, watchId: 'early-detach' }, () => { assert.fail('Closed subscription delivered an event') })
  f.service.unwatch('early-detach')
  await assert.rejects(watching, /订阅已关闭/)
  assert.equal(f.service.watchers.size, 0); assert.equal(f.service.pendingWatchers.size, 0)
  assert.notEqual((await f.service.admin('chat/tasks/' + task.id)).status, 'cancelled')
})
