import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, parse } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBridge } from '../server.mjs'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'openstarry-full-disk-test-'))
  const workspace = join(dir, 'project'), stateDir = join(dir, 'control'), external = join(dir, 'outside-project')
  let bridge, client
  t.after(async () => { await client?.close(); await bridge?.close(); await rm(dir, { recursive: true, force: true }) })
  await Promise.all([mkdir(workspace), mkdir(external)])
  const profile = join(external, 'service-profile'); await mkdir(profile)
  await writeFile(join(profile, 'credentials.txt'), 'fixture private state')
  await writeFile(join(external, 'hello.txt'), 'original\n')
  await writeFile(join(external, '.hidden.txt'), 'hidden fixture')
  await mkdir(join(external, 'folder'))
  bridge = await startBridge({ workspace, stateDir, fileScope: 'all-disks', protectedPaths: [profile], port: 0 })
  client = new Client({ name: 'disk-scope-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.mcpUrl)))
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    if (result.isError) throw Error(result.content[0].text)
    return JSON.parse(result.content[0].text)
  }
  return { dir, workspace, stateDir, external, profile, bridge, call }
}

test('full disk MCP lists drive roots and browses an external directory by bounded pages', async t => {
  const f = await fixture(t)
  assert.equal((await f.call('get_status')).fileScope, 'all-disks')
  const roots = await f.call('list_files')
  assert.ok(roots.roots.includes(parse(f.dir).root.replaceAll('\\', '/')))
  const first = await f.call('list_files', { path: f.external, limit: 2 })
  assert.equal(first.files.length + first.directories.length, 2)
  assert.equal(first.nextOffset, 2)
  const second = await f.call('list_files', { path: f.external + '/', offset: first.nextOffset, limit: 2 })
  assert.equal(second.nextOffset, null)
  const found = [...first.files, ...first.directories, ...second.files, ...second.directories]
  assert.equal(new Set(found).size, 3)
  assert.ok(found.some(path => path.endsWith('/.hidden.txt')))
  assert.ok(!found.some(path => path.includes('service-profile')))
})

test('full disk reads an absolute path without a task and keeps internal state private', async t => {
  const f = await fixture(t)
  assert.equal((await f.call('read_file', { path: join(f.external, 'hello.txt') })).content, 'original\n')
  assert.equal((await f.call('read_file', { path: join(f.external, '.hidden.txt') })).content, 'hidden fixture')
  for (const path of [join(f.stateDir, 'keys.json'), join(f.profile, 'credentials.txt'), f.external + '/../control/keys.json']) {
    await assert.rejects(f.call('read_file', { path }), /PATH_DENIED/)
  }
  await symlink(f.profile, join(f.external, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.call('read_file', { path: join(f.external, 'alias', 'credentials.txt') }), /PATH_DENIED/)
  if (process.platform === 'win32') for (const path of ['C:relative.txt', '//server/share/file.txt', '//?/C:/file.txt', 'C:/file.txt:stream', 'C:/CON', 'C:/trailing.']) {
    await assert.rejects(f.call('read_file', { path }), /PATH_DENIED/)
  }
})

test('absolute-path edits outside the project remain pending, detect conflicts and back up on local acceptance', async t => {
  const f = await fixture(t), path = join(f.external, 'hello.txt')
  const task = await f.bridge.store.submitTask('Full disk proposal fixture')
  const file = await f.call('read_file', { path })
  const proposal = await f.call('propose_file', { task_id: task.id, path, content: 'updated\n', expected_version: file.version, request_id: 'external-edit' })
  assert.equal(proposal.status, 'pending')
  assert.equal(await readFile(path, 'utf8'), 'original\n')
  await writeFile(path, 'local change')
  await assert.rejects(f.bridge.store.decide(proposal.id, 'accept'), /VERSION_CONFLICT/)
  await writeFile(path, 'original\n')
  await f.bridge.store.decide(proposal.id, 'accept')
  assert.equal(await readFile(path, 'utf8'), 'updated\n')
  const backup = JSON.parse(await readFile(join(f.stateDir, 'backups', proposal.id + '.json'), 'utf8'))
  assert.equal(backup.before, 'original\n'); assert.equal(backup.path, path)
})
