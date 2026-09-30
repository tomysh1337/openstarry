import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBridge } from '../server.mjs'

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'openstarry-create-test-'))
  const workspace = join(dir, 'project'), stateDir = join(dir, 'private'), desktop = join(dir, 'Desktop')
  await Promise.all([mkdir(workspace), mkdir(desktop)])
  let bridge, client
  t.after(async () => { await client?.close(); await bridge?.close(); await rm(dir, { recursive: true, force: true }) })
  const start = async () => {
    bridge = await startBridge({ workspace, stateDir, fileScope: 'all-disks', newFilePolicy: 'direct', port: 0, ...options })
    client = new Client({ name: 'file-create-fixture', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.mcpUrl)))
  }
  await start()
  return { workspace, stateDir, desktop, get bridge() { return bridge },
    restart: async modify => { await client.close(); await bridge.close(); if (modify) await modify(); await start() },
    tools: () => client.listTools(),
    call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args })
      if (result.isError) throw Error(result.content[0].text)
      return JSON.parse(result.content[0].text)
    }
  }
}

test('SDK creates a desktop text file with an empty task queue and persists retry receipts', async t => {
  const f = await fixture(t), path = join(f.desktop, 'nested', 'test.txt')
  const args = { path, content: '新文件已保存。\n', request_id: 'create-one' }
  assert.equal((await f.call('get_status')).newFilePolicy, 'direct')
  assert.equal((await f.call('list_tasks')).tasks.length, 0)
  const tools = (await f.tools()).tools
  assert.ok(tools.find(t => t.name === 'create_file').annotations.idempotentHint)
  assert.ok(tools.some(t => t.name === 'create_task'))
  const result = await f.call('create_file', args)
  assert.equal(result.status, 'created'); assert.equal(result.replayed, false)
  assert.equal(await readFile(path, 'utf8'), args.content)
  assert.equal((await f.call('read_file', { path })).version, result.version)
  assert.equal((await f.call('list_tasks')).tasks.length, 0)
  await f.restart()
  assert.equal((await f.call('create_file', args)).id, result.id)
  await writeFile(path, 'local edit')
  assert.equal((await f.call('create_file', args)).replayed, true)
  assert.equal(await readFile(path, 'utf8'), 'local edit')
  await rm(path)
  assert.equal((await f.call('create_file', args)).replayed, true)
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  await assert.rejects(f.call('create_file', { ...args, content: 'other' }), /REQUEST_CONFLICT/)
})

test('existing and concurrent files are never overwritten; connector tasks enable reviewed changes', async t => {
  const f = await fixture(t), path = join(f.desktop, 'existing.txt')
  await writeFile(path, 'original')
  await assert.rejects(f.call('create_file', { path, content: 'overwrite', request_id: 'existing' }), /FILE_EXISTS/)
  const taskArgs = { prompt: 'Edit the existing fixture file', request_id: 'edit-task' }
  const task = await f.call('create_task', taskArgs)
  assert.equal(task.source, 'connector')
  assert.equal((await f.call('create_task', taskArgs)).id, task.id)
  await assert.rejects(f.call('create_task', { ...taskArgs, prompt: 'different' }), /REQUEST_CONFLICT/)
  const file = await f.call('read_file', { path })
  const proposal = await f.call('propose_file', { task_id: task.id, path, content: 'reviewed', expected_version: file.version, request_id: 'edit' })
  assert.equal(await readFile(path, 'utf8'), 'original')
  await assert.rejects(f.call('report_result', { task_id: task.id, status: 'completed', text: 'premature' }), /REVIEW_PENDING/)
  await f.bridge.store.decide(proposal.id, 'accept')
  assert.equal(await readFile(path, 'utf8'), 'reviewed')
  const other = join(f.desktop, 'race.txt')
  const results = await Promise.allSettled(['first', 'second'].map(content => f.call('create_file', { path: other, content, request_id: content })))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.match(results.find(r => r.status === 'rejected').reason.message, /FILE_EXISTS/)
  assert.equal(await readFile(other, 'utf8'), results[0].status === 'fulfilled' ? 'first' : 'second')
  await f.restart()
  assert.equal((await f.call('create_task', taskArgs)).id, task.id)
  assert.equal((await f.call('list_tasks')).tasks.length, 1)
})

test('review remains the default; direct workspace creation stays within its workspace', async t => {
  const reviewed = await fixture(t, { newFilePolicy: 'review' })
  await assert.rejects(reviewed.call('create_file', { path: join(reviewed.desktop, 'new.txt'), content: '', request_id: 'denied' }), /REVIEW_REQUIRED/)
  const f = await fixture(t, { fileScope: 'workspace' })
  await f.call('create_file', { path: 'new.txt', content: '', request_id: 'empty' })
  assert.equal(await readFile(join(f.workspace, 'new.txt'), 'utf8'), '')
  for (const path of ['../outside.txt', join(f.desktop, 'new.txt'), '.env']) {
    await assert.rejects(f.call('create_file', { path, content: 'x', request_id: path }), /PATH_DENIED/)
  }
})

test('direct creation retains size, private-state and junction checks', async t => {
  const f = await fixture(t)
  await symlink(f.stateDir, join(f.desktop, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const path of [join(f.stateDir, 'new.txt'), join(f.desktop, 'alias', 'new.txt')]) {
    await assert.rejects(f.call('create_file', { path, content: 'x', request_id: path }), /PATH_DENIED/)
  }
  for (const content of ['\0', '中'.repeat(45000)]) {
    await assert.rejects(f.call('create_file', { path: join(f.desktop, 'invalid.txt'), content, request_id: 'invalid' }), /FILE_LIMIT/)
  }
  assert.equal((await readFile(join(f.stateDir, 'state.json'), 'utf8')).includes('invalid.txt'), false)
})

test('interrupted create receipts never claim success or rewrite a partial file after restart', async t => {
  const f = await fixture(t), path = join(f.desktop, 'interrupted.txt')
  const args = { path, content: 'complete', request_id: 'interrupted' }
  await f.call('create_file', args)
  await f.restart(async () => {
    const statePath = join(f.stateDir, 'state.json'), data = JSON.parse(await readFile(statePath, 'utf8'))
    data.creations[0].status = 'creating'; delete data.creations[0].createdAt
    await writeFile(statePath, JSON.stringify(data)); await writeFile(path, 'partial')
  })
  await assert.rejects(f.call('create_file', args), /RECOVERY_REQUIRED/)
  assert.equal(await readFile(path, 'utf8'), 'partial')
  await assert.rejects(f.call('create_file', { ...args, request_id: 'new-attempt' }), /FILE_EXISTS/)
})
