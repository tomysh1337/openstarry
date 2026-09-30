import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const stateDir = join(dirname(fileURLToPath(import.meta.url)), '.state/control')
const local = JSON.parse(await readFile(join(stateDir, 'connection.json'), 'utf8'))
const remote = JSON.parse(await readFile(join(stateDir, 'public-connection.json'), 'utf8'))
if (remote.status !== 'connected') throw Error('Wait for Cloudflare Tunnel to connect')
const health = await fetch(remote.publicOrigin + '/health', { signal: AbortSignal.timeout(30000) })
assert.equal(health.status, 200); assert.equal((await health.json()).status, 'ok')
const admin = async (path, body) => {
  const response = await fetch(local.origin + '/admin/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + local.adminToken }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) })
  assert.ok(response.ok); return response.json()
}
for (const path of ['/admin/tasks', '/admin/proposals']) {
  const denied = await fetch(remote.publicOrigin + path, { signal: AbortSignal.timeout(30000) })
  assert.equal(denied.status, 404)
}
const client = new Client({ name: 'OpenStarry-public-roundtrip', version: '0.1.0' })
let proposal
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(remote.mcpUrl)))
  const tools = await client.listTools(); assert.equal(tools.tools.length, 7)
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    if (result.isError) throw Error(result.content[0].text)
    return JSON.parse(result.content[0].text)
  }
  const marker = randomUUID()
  const task = await admin('tasks', { prompt: 'Cloudflare public roundtrip verification ' + marker })
  assert.equal((await call('get_task', { task_id: task.id })).prompt, task.prompt)
  const current = await call('read_file', { task_id: task.id, path: 'hello.txt' })
  proposal = await call('propose_file', { task_id: task.id, path: 'hello.txt', content: 'Public roundtrip ' + marker + '\n', expected_version: current.version, request_id: marker })
  assert.equal(proposal.status, 'pending')
  assert.ok((await admin('proposals')).proposals.some(p => p.id === proposal.id && p.after === proposal.after))
  assert.equal((await call('read_file', { task_id: task.id, path: 'hello.txt' })).version, current.version)
  await admin(`proposals/${proposal.id}/reject`, {})
  proposal = undefined
  await call('report_result', { task_id: task.id, status: 'completed', text: '公网 MCP 收发已验证；测试提议已拒绝，文件未改动。' })
  const received = (await admin('tasks')).tasks.find(t => t.id === task.id)
  assert.equal(received.status, 'completed')
  const report = { passed: true, checkedAt: new Date().toISOString(), publicOrigin: remote.publicOrigin, server: health.headers.get('server'), cloudflareRay: health.headers.get('cf-ray'), toolCount: tools.tools.length, taskId: task.id, checks: ['HTTPS health', 'MCP initialize/tools/list', 'local task -> public MCP', 'public proposal -> local review', 'public result -> local task', 'saved file unchanged', 'public admin routes blocked'] }
  await writeFile(join(stateDir, 'public-verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (proposal) await admin(`proposals/${proposal.id}/reject`, {}).catch(() => {})
  await client.close()
}
