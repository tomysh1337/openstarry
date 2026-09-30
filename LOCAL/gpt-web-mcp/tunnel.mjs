import { spawn } from 'node:child_process'
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import { startPublicGateway } from './public-gateway.mjs'
import { TunnelLogState } from './tunnel-state.mjs'

const base = dirname(fileURLToPath(import.meta.url))
const { values } = parseArgs({ options: {
  cloudflared: { type: 'string', default: 'cloudflared' }, port: { type: 'string', default: '49323' },
  protocol: { type: 'string', default: 'auto' },
  'state-dir': { type: 'string', default: join(base, '.state/control') }
} })
const stateDir = resolve(values['state-dir'])
let gateway, child, closing, publicOrigin, saveConnection, writes = Promise.resolve()
const tunnelState = new TunnelLogState()
const publicFile = join(stateDir, 'public-connection.json')
const addressFile = join(stateDir, 'GPT-MCP连接地址.txt')
function reportError(message) {
  const error = String(message).replace(/\/(?:adapter-)?mcp\/[\w-]+/g, '/mcp/[private]').slice(0, 500)
  console.error(error)
  if (process.connected) process.send({ type: 'tunnel-error', error }, () => {})
}
function fail(message) {
  reportError(message); process.exitCode = 1
  void close().finally(() => { if (process.connected) process.exit(1) })
}
async function main() {
  if (!['auto', 'http2', 'quic'].includes(values.protocol)) throw Error('Protocol must be auto, http2 or quic')
  const local = JSON.parse(await readFile(join(stateDir, 'connection.json'), 'utf8'))
  const health = await fetch(local.origin + '/health', { signal: AbortSignal.timeout(5000) })
  if (!health.ok) throw Error('Start the local MCP service first')
  gateway = await startPublicGateway({ mcpUrl: local.mcpUrl, port: Number(values.port) })
  await writeFile(publicFile, JSON.stringify({ status: 'starting' }, null, 2), { mode: 0o600 })
  await writeFile(addressFile, '正在建立新的 Cloudflare 临时隧道。旧地址已停用，请等待此文件更新。\n', { mode: 0o600 })
  // Keep inherited cloudflared config out of this isolated Quick Tunnel.
  const config = join(stateDir, 'quick-tunnel.yml')
  await writeFile(config, '{}\n', { mode: 0o600 })
  const args = ['tunnel', '--config', config, '--no-autoupdate', '--protocol', values.protocol, '--edge-ip-version', '4', '--url', gateway.origin,
    '--http-host-header', new URL(gateway.origin).host, '--metrics', '127.0.0.1:0', '--loglevel', 'info']
  child = spawn(values.cloudflared, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  saveConnection = async ({ status, reason = '' }) => {
    const mcpUrl = publicOrigin + new URL(local.mcpUrl).pathname
    const updatedAt = new Date().toISOString()
    await writeFile(publicFile, JSON.stringify({ status, reason, publicOrigin, mcpUrl, tunnel: 'cloudflare-quick', updatedAt }, null, 2), { mode: 0o600 })
    await writeFile(addressFile, `OpenStarry GPT 网页端 MCP（Cloudflare 临时测试地址）\n\n${mcpUrl}\n\n隧道状态：${status}\n更新时间：${updatedAt}\n${reason ? '说明：' + reason + '\n' : ''}连接类型：Streamable HTTP\n认证：地址内包含随机凭据；如客户端询问额外认证，选择无额外认证。\n此完整链接相当于密钥，请勿公开。\n当前仅访问独立测试项目；修改先待审查，再由本机接受。\n这是临时地址：电脑、MCP 服务和 tunnel 都需保持运行；重启 tunnel 后请复制新地址。\n`, { mode: 0o600 })
  }
  const onOutput = chunk => {
    const text = chunk.toString().replace(/\/mcp\/[\w-]{32,}/g, '/mcp/[redacted]')
    writes = writes.then(async () => {
      await appendFile(join(stateDir, 'cloudflared.log'), text, { mode: 0o600 })
      for (const state of tunnelState.push(text)) {
        if (closing) continue
        if (state.publicOrigin && !publicOrigin) {
          publicOrigin = state.publicOrigin; gateway.setPublicOrigin(publicOrigin)
          console.log(`Cloudflare public origin: ${publicOrigin}\nPrivate MCP address: ${addressFile}`)
        }
        if (publicOrigin) await saveConnection(state)
        console.log(`Cloudflare Tunnel: ${state.status}${state.reason ? ' — ' + state.reason : ''}`)
      }
    }).catch(error => { fail('Tunnel state error: ' + error.message) })
  }
  child.stdout.on('data', onOutput); child.stderr.on('data', onOutput)
  child.once('error', error => { fail('cloudflared start failed: ' + error.message) })
  child.once('exit', (code, signal) => {
    if (!closing) fail(`cloudflared exited (${code ?? signal}); see the local cloudflared.log`)
  })
  console.log(`MCP-only gateway: ${gateway.origin}; connecting Cloudflare Tunnel…`)
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close() })
}
function close() {
  return closing ??= (async () => {
    if (child && child.exitCode === null && !child.killed) child.kill()
    await gateway?.close(); await writes
    if (publicOrigin) await saveConnection({ status: 'stopped', reason: 'Tunnel process stopped' })
  })()
}
main().catch(error => fail(error.message))
if (process.connected) {
  process.on('message', message => { if (message?.type === 'shutdown') void close().finally(() => process.exit(0)) })
  process.once('disconnect', () => { void close().finally(() => process.exit(0)) })
}
