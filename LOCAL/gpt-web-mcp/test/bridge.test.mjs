import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBridge } from '../server.mjs'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'openstarry-mcp-test-'))
  const workspace = join(dir, 'project'), stateDir = join(dir, 'private')
  await mkdir(workspace); await writeFile(join(workspace, 'hello.txt'), 'before\n')
  const bridge = await startBridge({ workspace, stateDir, port: 0 })
  const client = new Client({ name: 'OpenStarry-regression', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.mcpUrl)))
  t.after(async () => { await client.close(); await bridge.close(); await rm(dir, { recursive: true, force: true }) })
  const admin = async (path, body, overrides = {}) => {
    const response = await fetch(bridge.origin + '/admin/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + bridge.adminToken, 'content-type': 'application/json', ...overrides },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, data: await response.json() }
  }
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    if (result.isError) throw Error(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'))
    return JSON.parse(result.content[0].text)
  }
  return { dir, workspace, stateDir, bridge, client, admin, call }
}

test('official SDK: send task, read, propose, review, accept, receive result', async t => {
  const f = await fixture(t)
  const listing = await f.client.listTools()
  assert.ok(listing.tools.some(tool => tool.name === 'propose_file'))
  assert.ok(!listing.tools.some(tool => /accept|run_command|delete/.test(tool.name)))
  const task = (await f.admin('tasks', { prompt: 'Change the greeting' })).data
  assert.equal((await f.call('list_tasks')).tasks[0].id, task.id)
  const file = await f.call('read_file', { task_id: task.id, path: 'hello.txt' })
  const proposal = await f.call('propose_file', { task_id: task.id, path: 'hello.txt', content: 'after\n', expected_version: file.version, request_id: 'edit-1' })
  assert.equal(proposal.status, 'pending')
  assert.equal(await readFile(join(f.workspace, 'hello.txt'), 'utf8'), 'before\n')
  assert.equal((await f.admin('proposals')).data.proposals[0].after, 'after\n')
  assert.equal((await f.admin(`proposals/${proposal.id}/accept`, {})).data.status, 'accepted')
  assert.equal(await readFile(join(f.workspace, 'hello.txt'), 'utf8'), 'after\n')
  await f.call('report_result', { task_id: task.id, text: 'Greeting updated', status: 'completed' })
  assert.equal((await f.admin('tasks')).data.tasks[0].result, 'Greeting updated')
})

test('stale revisions, duplicate requests, and terminal proposals protect user edits', async t => {
  const f = await fixture(t), task = (await f.admin('tasks', { prompt: 'Test conflicts' })).data
  const file = await f.call('read_file', { task_id: task.id, path: 'hello.txt' })
  const args = { task_id: task.id, path: 'hello.txt', content: 'proposed', expected_version: file.version, request_id: 'same-id' }
  const p = await f.call('propose_file', args)
  assert.equal((await f.call('propose_file', args)).id, p.id)
  await assert.rejects(f.call('propose_file', { ...args, content: 'different' }), /REQUEST_CONFLICT/)
  await writeFile(join(f.workspace, 'hello.txt'), 'user edit')
  assert.equal((await f.admin(`proposals/${p.id}/accept`, {})).status, 409)
  assert.equal(await readFile(join(f.workspace, 'hello.txt'), 'utf8'), 'user edit')
  assert.equal((await f.admin(`proposals/${p.id}/reject`, {})).data.status, 'rejected')
  assert.equal((await f.admin(`proposals/${p.id}/accept`, {})).status, 409)
})

test('path bounds, private state, authentication and cross-origin requests', async t => {
  const f = await fixture(t), task = (await f.admin('tasks', { prompt: 'Path test' })).data
  for (const path of ['../outside.txt', 'C:/Windows/win.ini', '.git/config', '.env', 'sub/../../escape', 'hello.txt:stream', 'CON', 'sub\\evil']) {
    await assert.rejects(f.call('propose_file', { task_id: task.id, path, content: 'bad', expected_version: null, request_id: path }), /PATH_DENIED/)
  }
  const response = await fetch(f.bridge.origin + '/mcp/not-a-token', { method: 'POST', body: '{}' })
  assert.equal(response.status, 401)
  assert.equal((await f.admin('tasks', undefined, { authorization: 'Bearer bad' })).status, 401)
  assert.equal((await f.admin('tasks', undefined, { origin: 'https://evil.example' })).status, 403)
  const rejected = await fetch(f.bridge.mcpUrl, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(rejected.status, 403)
})

test('proposals and tasks survive a service restart without being auto-applied', async t => {
  const f = await fixture(t), task = (await f.admin('tasks', { prompt: 'Persist' })).data
  const p = await f.call('propose_file', { task_id: task.id, path: 'new.txt', content: 'new file', expected_version: null, request_id: 'new-file' })
  await f.client.close(); await f.bridge.close()
  const next = await startBridge({ workspace: f.workspace, stateDir: f.stateDir, port: 0 })
  try {
    const response = await fetch(next.origin + '/admin/proposals', { headers: { authorization: 'Bearer ' + next.adminToken } })
    assert.equal((await response.json()).proposals[0].id, p.id)
    assert.equal(next.adminToken, f.bridge.adminToken)
    await assert.rejects(readFile(join(f.workspace, 'new.txt')), { code: 'ENOENT' })
  } finally { await next.close() }
})

test('new files require review; pending review blocks a completed result', async t => {
  const f = await fixture(t), task = (await f.admin('tasks', { prompt: 'Create a file' })).data
  const p = await f.call('propose_file', { task_id: task.id, path: 'src/new.txt', content: 'new\n', expected_version: null, request_id: 'create-1' })
  await assert.rejects(f.call('report_result', { task_id: task.id, text: 'Done', status: 'completed' }), /REVIEW_PENDING/)
  assert.equal((await f.admin(`proposals/${p.id}/accept`, {})).status, 200)
  assert.equal(await readFile(join(f.workspace, 'src/new.txt'), 'utf8'), 'new\n')
  const backup = JSON.parse(await readFile(join(f.stateDir, 'backups', p.id + '.json'), 'utf8'))
  assert.equal(backup.beforeVersion, null)
  assert.equal((await f.admin(`proposals/${p.id}/accept`, {})).status, 409)
})

test('directory junctions are excluded and private state cannot live in the workspace', async t => {
  const f = await fixture(t), task = (await f.admin('tasks', { prompt: 'Bounds' })).data
  const external = join(f.dir, 'external'); await mkdir(external)
  await writeFile(join(external, 'private.txt'), 'outside')
  await symlink(external, join(f.workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.call('read_file', { task_id: task.id, path: 'linked/private.txt' }), /PATH_DENIED/)
  assert.deepEqual((await f.call('list_files')).files, ['hello.txt'])
  await assert.rejects(startBridge({ workspace: f.workspace, stateDir: join(f.workspace, 'private'), port: 0 }), /outside/)
})
