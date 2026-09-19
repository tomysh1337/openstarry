import test from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { Workspace, projectPath, validateFiles, projectStore } from '../src/model.js'
import { runAgent, connectMcp } from '../src/agent.js'
import { normalizeSettings, serviceUrl } from '../src/settings.js'

test('drafts and proposed changes persist without overwriting saved files', async () => {
  const workspace = new Workspace({ name: 'QA', files: { 'main.js': 'const a = 1;\n' } })
  workspace.open('main.js'); workspace.edit('main.js', 'const a = 2;\n'); workspace.propose('main.js', 'const a = 3;\n')
  await projectStore.save(workspace); const restored = await projectStore.load(workspace.id)
  assert.equal(restored.files['main.js'], 'const a = 1;\n'); assert.equal(restored.content('main.js'), 'const a = 2;\n')
  restored.accept('main.js'); assert.equal(restored.files['main.js'], 'const a = 3;\n'); assert.deepEqual(restored.proposals, {})
})
test('review refuses to overwrite an edit made after an Agent proposal', () => {
  const workspace = new Workspace({ files: { 'a.py': 'old' } }); workspace.propose('a.py', 'agent'); workspace.edit('a.py', 'manual')
  assert.throws(() => workspace.accept('a.py'), /发生变化/); assert.equal(workspace.content('a.py'), 'manual')
  workspace.reject('a.py'); assert.equal(workspace.content('a.py'), 'manual')
})
test('rejecting a new-file proposal removes its tab, renaming preserves drafts', () => {
  const workspace = new Workspace(); workspace.propose('src/new.js', 'hello'); workspace.reject('src/new.js')
  assert.deepEqual(workspace.paths(), []); assert.deepEqual(workspace.tabs, [])
  workspace.create('a.txt', 'a'); workspace.edit('a.txt', 'b'); workspace.rename('a.txt', 'docs/b.txt')
  assert.equal(workspace.content('docs/b.txt'), 'b'); assert.equal(workspace.active, 'docs/b.txt')
})
test('reject traversal, drive paths, binary content and cross-platform collisions', () => {
  for (const path of ['../a', 'C:/a', '/a', 'a//b', 'a/./b', 'CON', 'a.']) assert.throws(() => projectPath(path))
  assert.throws(() => validateFiles({ A: '', a: '' })); assert.throws(() => validateFiles({ a: '', 'a/b': '' })); assert.throws(() => validateFiles({ a: '\0' }))
})
test('file tool returns a review proposal then continues with the tool result', async () => {
  const workspace = new Workspace({ files: { 'a.js': 'old' } }); let count = 0
  const result = await runAgent({ settings: { enabled: true, files: true }, workspace, messages: [{ role: 'user', content: 'edit' }], complete: async ({ messages }) => {
    if (!count++) return { tool_calls: [{ id: '1', function: { name: 'propose_file', arguments: JSON.stringify({ path: 'a.js', content: 'new' }) } }] }
    assert.equal(messages.at(-1).role, 'tool'); assert.match(messages.at(-1).content, /awaiting_review/); return { content: '请审查修改' }
  } })
  assert.equal(workspace.files['a.js'], 'old'); assert.equal(workspace.proposals['a.js'].content, 'new'); assert.equal(result.turns, 2)
})
test('disabled execution tool is rejected and repeated failures stop the loop', async () => {
  let executed = false, calls = 0
  await assert.rejects(runAgent({ settings: { enabled: true, execute: false, errorLimit: 2 }, messages: [], workspace: new Workspace(), execute: () => { executed = true }, complete: async () => { calls++; return { tool_calls: [{ id: String(calls), function: { name: 'run_project', arguments: '{"command":"something"}' } }] } } }), /连续工具调用失败/)
  assert.equal(executed, false); assert.equal(calls, 2)
})
test('cancellation after model completion prevents queued writes', async () => {
  const controller = new AbortController(), workspace = new Workspace()
  await assert.rejects(runAgent({ settings: { enabled: true, files: true }, workspace, messages: [], signal: controller.signal, complete: async () => { controller.abort(Error('stop')); return { tool_calls: [{ id: '1', function: { name: 'propose_file', arguments: '{"path":"x","content":"new"}' } }] } } }), /stop/)
  assert.deepEqual(workspace.proposals, {})
})
test('MCP initializes a session and sends auth on list and calls', async () => {
  const methods = []
  const mcp = await connectMcp({ mcpUrl: 'https://example.com/mcp', mcpToken: 'test-token' }, async args => {
    const body = JSON.parse(args.body); methods.push(body.method); assert.equal(args.headers.Authorization, 'Bearer test-token')
    if (body.method !== 'initialize') assert.equal(args.headers['Mcp-Session-Id'], 'session')
    return { status: body.method === 'notifications/initialized' ? 202 : 200, headers: { 'mcp-session-id': 'session' }, text: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list' ? { tools: [{ name: 'list_files', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: 'done' }] } }) }
  })
  assert.equal(mcp.tools[0].function.name, 'mcp_0'); await mcp.invoke('mcp_0', {}); assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
})
test('settings clamp run limits and reject credentials embedded in service URLs', () => {
  assert.equal(normalizeSettings({ maxTurns: 900 }).maxTurns, 50); assert.equal(normalizeSettings({ execute: 'true' }).execute, false)
  assert.throws(() => serviceUrl('https://user:secret@example.com')); assert.throws(() => serviceUrl('http://example.com'))
})
