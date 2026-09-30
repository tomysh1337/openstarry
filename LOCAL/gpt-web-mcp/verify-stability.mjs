// Read-only checks of the public file MCP. This is an SDK probe, not a ChatGPT conversation.
import assert from 'node:assert/strict'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const { values } = parseArgs({ options: {
  'duration-ms': { type: 'string', default: '600000' },
  'interval-ms': { type: 'string', default: '30000' }
} })
const duration = Number(values['duration-ms']), interval = Number(values['interval-ms'])
assert.ok(Number.isFinite(duration) && duration >= 0 && duration <= 3600000)
assert.ok(Number.isFinite(interval) && interval >= 1000 && interval <= 60000)
const stateDir = join(dirname(fileURLToPath(import.meta.url)), '.state/control')
const readConnection = async () => JSON.parse(await readFile(join(stateDir, 'public-connection.json'), 'utf8'))
const first = await readConnection()
assert.equal(first.status, 'connected', 'The tunnel must connect before stability verification')
const started = Date.now(), logOffset = (await stat(join(stateDir, 'cloudflared.log'))).size
const report = { kind: 'public-mcp-read-only-sdk-probe', passed: false, publicOrigin: first.publicOrigin,
  startedAt: new Date(started).toISOString(), requiredDurationMs: duration, checksPerRound: 7, rounds: [] }
const save = () => writeFile(join(stateDir, 'public-stability.json'), JSON.stringify(report, null, 2), { mode: 0o600 })

async function probe() {
  const before = Date.now(), current = await readConnection()
  assert.equal(current.status, 'connected', 'Tunnel lost its edge connection')
  assert.equal(current.publicOrigin, first.publicOrigin, 'Tunnel URL changed during verification')
  const health = await fetch(current.publicOrigin + '/health', { signal: AbortSignal.timeout(15000) })
  assert.equal(health.status, 200, 'Public health failed')
  assert.equal((await health.json()).status, 'ok')
  const client = new Client({ name: 'OpenStarry-read-only-stability-probe', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(current.mcpUrl), {
      fetch: (url, options) => fetch(url, { ...options, signal: options?.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
    }))
    const tools = await client.listTools(); assert.equal(tools.tools.length, 7)
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15000 })
      assert.ok(!result.isError, name + ' failed')
      return JSON.parse(result.content[0].text)
    }
    await call('get_status')
    const tasks = await call('list_tasks'); assert.ok(Array.isArray(tasks.tasks))
    const task = tasks.tasks.find(task => task.id === '83ad42f6-7c89-4881-8fb9-cd1aa95a6f8b')
    assert.ok(task, 'Preserved test task is missing')
    const detail = await call('get_task', { task_id: task.id }); assert.equal(detail.id, task.id)
    const file = await call('read_file', { task_id: task.id, path: 'hello.txt' })
    assert.equal(file.content, 'Hello from OpenStarry.\n', 'Preserved test file changed')
  } finally { await client.close() }
  const after = await readConnection(); assert.equal(after.status, 'connected')
  assert.equal(after.publicOrigin, first.publicOrigin)
  const newLog = (await readFile(join(stateDir, 'cloudflared.log'))).subarray(logOffset).toString('utf8')
  assert.ok(!/Serve tunnel error|Retrying connection|Tunnel not found|Connection terminated|Failed to dial/i.test(newLog), 'Tunnel disconnected during verification')
  return { checkedAt: new Date().toISOString(), elapsedMs: Date.now() - started, latencyMs: Date.now() - before, passed: true }
}

try {
  for (;;) {
    const result = await probe(); report.rounds.push(result); await save()
    console.log(JSON.stringify({ round: report.rounds.length, elapsedSeconds: Math.round(result.elapsedMs / 1000), checks: report.checksPerRound, passed: true }))
    if (Date.now() - started >= duration) break
    await delay(Math.min(interval, duration - (Date.now() - started)))
  }
  report.passed = true; report.finishedAt = new Date().toISOString()
  report.durationMs = Date.now() - started; await save()
  console.log(JSON.stringify({ passed: true, rounds: report.rounds.length, durationSeconds: Math.round(report.durationMs / 1000), publicOrigin: report.publicOrigin }))
} catch (error) {
  // Transport errors can contain capability URLs. Keep them out of console and reports.
  report.error = String(error.message).replace(/https?:\/\/[^\s"'<>]+/g, '[private endpoint]')
  report.finishedAt = new Date().toISOString(); await save()
  console.error(JSON.stringify({ passed: false, rounds: report.rounds.length, error: report.error }))
  process.exitCode = 1
}
