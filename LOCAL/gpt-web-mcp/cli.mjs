import { parseArgs } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startBridge } from './server.mjs'

const folder = dirname(fileURLToPath(import.meta.url))
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  demo: { type: 'boolean' }, workspace: { type: 'string' }, 'state-dir': { type: 'string' }, port: { type: 'string', default: '49321' }
} })
const stateDir = resolve(values['state-dir'] || join(folder, '.state/control'))
async function main() {
  const [command, ...args] = positionals
  if (command === 'serve') {
    if (!values.demo && !values.workspace) throw Error('Specify --workspace PATH, or use npm run demo for an isolated project')
    const workspace = values.demo ? join(folder, '.state/workspace') : resolve(values.workspace)
    if (values.demo) {
      await mkdir(workspace, { recursive: true })
      try { await writeFile(join(workspace, 'hello.txt'), 'Hello from OpenStarry.\n', { flag: 'wx' }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    const bridge = await startBridge({ workspace, stateDir, port: Number(values.port) })
    await writeFile(join(stateDir, 'connection.json'), JSON.stringify({ origin: bridge.origin, mcpUrl: bridge.mcpUrl, adminToken: bridge.adminToken }), { mode: 0o600 })
    console.log(`OpenStarry local MCP is ready: ${bridge.origin}/health\nWorkspace: ${workspace}\nPrivate connection settings: ${join(stateDir, 'connection.json')}\nChat protocol v1 is ready. Use the desktop GPT Web source to start the visible webpage adapter; connector connectivity is separate.`)
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void bridge.close().then(() => process.exit(0)) })
    return
  }
  const connection = JSON.parse(await readFile(join(stateDir, 'connection.json'), 'utf8'))
  const admin = async (path, body) => {
    const response = await fetch(connection.origin + '/admin/' + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + connection.adminToken, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) })
    const result = await response.json(); if (!response.ok) throw Error(result.error); return result
  }
  let result
  if (command === 'task') result = await admin('tasks', { prompt: args.join(' ') })
  else if (['tasks', 'proposals'].includes(command)) result = await admin(command)
  else if (['accept', 'reject'].includes(command)) {
    if (!/^[a-f0-9-]{36}$/.test(args[0] || '')) throw Error('Supply the proposal id shown by proposals')
    result = await admin(`proposals/${args[0]}/${command}`, {})
  } else if (command === 'simulate') {
    // Explicit first-stage smoke task: a real MCP client stands in for the webpage.
    const client = new Client({ name: 'OpenStarry-local-test-client', version: '0.1.0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(connection.mcpUrl)))
      const task = await admin('tasks', { prompt: 'Local MCP test: propose a new greeting in hello.txt; wait for review.' })
      const call = async (name, args) => {
        const reply = await client.callTool({ name, arguments: args })
        if (reply.isError) throw Error(reply.content[0].text)
        return JSON.parse(reply.content[0].text)
      }
      const current = await call('read_file', { task_id: task.id, path: 'hello.txt' })
      result = await call('propose_file', { task_id: task.id, path: 'hello.txt', content: '你好，GPT 网页端 MCP 收发测试。\n', expected_version: current.version, request_id: 'smoke-greeting' })
      await call('report_result', { task_id: task.id, status: 'awaiting_review', text: '本地测试客户端已提交修改，等待你接受；这不是 ChatGPT 的真实回复。' })
    } finally { await client.close() }
  } else throw Error('Commands: serve, task TEXT, tasks, proposals, accept ID, reject ID, simulate')
  console.log(JSON.stringify(result, null, 2))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
