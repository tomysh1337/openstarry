import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { openStore } from '../store.mjs'
import { safetyPolicy } from '../safety.mjs'
import { openSandboxRunner } from '../sandbox.mjs'
const delay = () => new Promise(resolve => setTimeout(resolve, 10))
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'openstarry-sandbox-test-')), workspace = join(dir, 'workspace'), stateDir = join(dir, 'private'), settingsPath = join(dir, 'policy.json'), configPath = join(dir, 'connection.json')
  await mkdir(workspace); await mkdir(stateDir)
  await writeFile(settingsPath, JSON.stringify({ safetyMode: 'ask' }))
  await writeFile(configPath, JSON.stringify({ domain: '127.0.0.1:49330', apiKey: 'fixture'.repeat(8) }))
  const policy = safetyPolicy({ settingsPath }), files = await openStore({ workspace, stateDir, getPolicy: policy }), task = await files.submitTask('sandbox fixture')
  const created = [], closed = []
  const create = async opts => {
    created.push(opts)
    return { id: randomUUID(), kill: async () => closed.push('kill'), close: async () => closed.push('close'), commands: { run: async (_command, _options, handlers, signal) => {
      await handlers.onStdout({ text: 'first\n' })
      if (options.large) await handlers.onStdout({ text: '界🙂'.repeat(50000) })
      if (options.hold) await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }) })
      else await handlers.onStderr({ text: 'last\n' })
      return { complete: {}, exitCode: 0 }
    } } }
  }
  const args = { stateDir, configPath, policy, files, create }, runner = await openSandboxRunner(args)
  t.after(async () => { await runner.close(); await files.flush(); await rm(dir, { recursive: true, force: true }) })
  const setMode = mode => writeFile(settingsPath, JSON.stringify({ safetyMode: mode }))
  const read = job => runner.get({ task_id: task.id, execution_id: job.id })
  const until = async (job, status) => { for (let n = 0; n < 200; n++) { const value = read(job); if (value.status === status) return value; await delay() }; assert.fail('execution did not reach ' + status) }
  return { dir, workspace, files, task, runner, args, policy, setMode, read, until, created, closed }
}
test('three approval levels enforce writes, versions, backups and old proposal review', async t => {
  const f = await fixture(t), args = { task_id: f.task.id, path: 'a.txt', content: 'one', expected_version: null, request_id: 'a' }
  const pending = await f.files.writeFile(args); assert.equal(pending.status, 'pending')
  await assert.rejects(f.files.createFile({ path: 'direct.txt', content: 'x', request_id: 'direct' }), /REVIEW_REQUIRED/)
  await f.setMode('full')
  assert.equal((await f.files.writeFile(args)).status, 'pending', 'changing policy must not accept old pending writes')
  await assert.rejects(readFile(join(f.workspace, 'a.txt')), { code: 'ENOENT' })
  await f.setMode('auto')
  const saved = await f.files.writeFile({ ...args, request_id: 'b', path: 'b.txt' }); assert.equal(saved.status, 'accepted')
  const current = await f.files.readFile({ task_id: f.task.id, path: 'b.txt' })
  const replacement = { ...args, request_id: 'edit', path: 'b.txt', content: 'two', expected_version: current.version }
  assert.equal((await f.files.writeFile(replacement)).status, 'pending')
  await f.setMode('full')
  const edited = await f.files.writeFile({ ...replacement, request_id: 'full-edit' }); assert.equal(edited.status, 'accepted')
  assert.equal(await readFile(join(f.workspace, 'b.txt'), 'utf8'), 'two')
  assert.equal(JSON.parse(await readFile(join(f.dir, 'private/backups', edited.id + '.json'))).before, 'one')
  assert.equal((await f.files.writeFile({ ...replacement, request_id: 'full-edit' })).id, edited.id)
  await assert.rejects(f.files.writeFile({ ...replacement, request_id: 'stale' }), /VERSION_CONFLICT/)
  const explicit = await f.files.propose({ ...args, request_id: 'explicit', path: 'proposal.txt' })
  assert.equal((await f.files.writeFile({ ...args, request_id: 'explicit', path: 'proposal.txt' })).id, explicit.id)
  assert.equal((await f.files.writeFile({ ...args, request_id: 'explicit', path: 'proposal.txt' })).status, 'pending')
})
test('sandbox approval, real streamed output contract, retry receipt and network options', async t => {
  const f = await fixture(t), args = { task_id: f.task.id, request_id: 'run', command: 'printf hello' }
  const job = await f.runner.run(args); assert.equal(job.status, 'awaiting_approval'); assert.equal(f.created.length, 0)
  assert.throws(() => f.runner.assertComplete(f.task.id), /SANDBOX_PENDING/)
  await f.setMode('full'); assert.equal((await f.runner.run(args)).status, 'awaiting_approval')
  await f.runner.decide(job.id, 'approve'); const result = await f.until(job, 'completed')
  assert.match(result.output, /first\n\[stderr\] last/)
  assert.equal(f.created[0].networkPolicy.defaultAction, 'deny'); assert.equal(f.created[0].volumes, undefined)
  assert.equal(f.created[0].privileged, undefined); assert.equal(f.created[0].timeoutSeconds, 240)
  await f.runner.close(); assert.deepEqual(f.closed, ['kill', 'close'])
  const next = await openSandboxRunner(f.args)
  try { assert.equal((await next.run(args)).replayed, true); assert.equal(f.created.length, 1); await assert.rejects(next.run({ ...args, command: 'other' }), /REQUEST_CONFLICT/) }
  finally { await next.close() }
})
test('auto mode gates networking; cancellation retains partial output and cleans only its container', async t => {
  const f = await fixture(t, { hold: true }); await f.setMode('auto')
  const args = { task_id: f.task.id, request_id: 'net', command: 'echo x', network: true }
  const network = await f.runner.run(args); assert.equal(network.status, 'awaiting_approval')
  const local = await f.runner.run({ ...args, request_id: 'local', network: false }); await f.until(local, 'running')
  for (let n = 0; n < 200 && !f.read(local).output; n++) await delay()
  assert.match(f.read(local).output, /first/)
  assert.throws(() => f.runner.get({ task_id: randomUUID(), execution_id: local.id }), /NOT_FOUND/)
  await f.runner.cancel(local.id, f.task.id); await f.until(local, 'cancelled'); await f.runner.close()
  assert.match(f.read(local).output, /first/); assert.equal(f.read(network).status, 'awaiting_approval')
  assert.deepEqual(f.closed, ['kill', 'close'])
})
test('restart never re-executes an interrupted command and full mode allows requested networking', async t => {
  const f = await fixture(t)
  const job = { id: randomUUID(), task_id: f.task.id, request_id: 'interrupted', status: 'running', command: 'old command', output: 'partial' }
  await f.runner.close(); await writeFile(join(f.dir, 'private/sandbox-jobs.json'), JSON.stringify([job]))
  await f.setMode('full'); const next = await openSandboxRunner(f.args)
  try {
    assert.equal(next.get({ task_id: f.task.id, execution_id: job.id }).status, 'interrupted'); assert.equal(f.created.length, 0)
    const run = await next.run({ task_id: f.task.id, request_id: 'net', command: 'echo test', network: true })
    for (let n = 0; n < 200 && !next.get({ task_id: f.task.id, execution_id: run.id }).done; n++) await delay()
    assert.equal(next.get({ task_id: f.task.id, execution_id: run.id }).status, 'completed')
    assert.equal(f.created[0].networkPolicy.defaultAction, 'allow')
  } finally { await next.close() }
})

test('sandbox output has a UTF-8 byte bound and paged Unicode remains intact', async t => {
  const f = await fixture(t, { large: true }); await f.setMode('auto')
  const job = await f.runner.run({ task_id: f.task.id, request_id: 'large', command: 'large output' })
  await f.until(job, 'completed')
  let output = '', offset = 0, page
  do { page = f.runner.get({ task_id: f.task.id, execution_id: job.id, offset, limit: 16000 }); output += page.output; offset = page.next_offset } while (offset !== null)
  assert.equal(page.truncated, true); assert.ok(Buffer.byteLength(output) <= 65536); assert.ok(!output.includes('\ufffd'))
})
