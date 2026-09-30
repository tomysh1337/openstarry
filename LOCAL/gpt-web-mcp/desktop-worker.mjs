import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridge } from './server.mjs'
import { EdgeExtensionPage } from './extension-page.mjs'
import { WebAdapter } from './web-adapter.mjs'
import { DesktopTunnel } from './desktop-tunnel.mjs'

let bridge, adapter, driver, stateDir, cloudflared, tunnel, initialized = false, ready = false, closing
async function close() {
  return closing ??= (async () => {
    try { await tunnel?.stop() }
    finally { await adapter?.close(); await bridge?.close(); process.exit(0) }
  })()
}
process.on('disconnect', () => { void close() })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close() })
process.on('message', async message => {
  try {
    if (message.type === 'init' && !initialized) {
      initialized = true
      const { workspace, profile } = message; stateDir = message.stateDir; cloudflared = message.cloudflared
      tunnel = new DesktopTunnel({ stateDir, cloudflared })
      await mkdir(workspace, { recursive: true }); await mkdir(profile, { recursive: true })
      bridge = await startBridge({ workspace, stateDir, fileScope: message.fileScope, newFilePolicy: message.newFilePolicy, settingsPath: message.settingsPath, sandboxConfigPath: message.sandboxConfigPath, protectedPaths: [...(message.protectedPaths || []), profile, fileURLToPath(new URL('./.state', import.meta.url))], port: 0, getAdapterState: () => driver?.state || { browser: 'closed', login: 'unknown' } })
      await writeFile(join(stateDir, 'connection.json'), JSON.stringify({ origin: bridge.origin, adminToken: bridge.adminToken, mcpUrl: bridge.mcpUrl }), { mode: 0o600 })
      driver = new EdgeExtensionPage({ profile })
      await driver.start()
      adapter = new WebAdapter({ origin: bridge.origin, adminToken: bridge.adminToken, stateDir, pageDriver: driver })
      await adapter.start(); adapter.poll(); ready = true
      process.send?.({ type: 'ready', origin: bridge.origin, adminToken: bridge.adminToken, mcpUrl: bridge.mcpUrl })
      return
    }
    if (message.type === 'shutdown') { await close(); return }
    if (!adapter) throw Error('网页服务尚未启动')
    let result
    if (message.type === 'download') result = await driver.download(message.payload)
    else if (message.type === 'show') result = await driver.show()
    else if (message.type === 'status') result = { ...await driver.status(), activeTask: adapter.current || null, activeTasks: [...adapter.activeJobs.keys()], lastError: adapter.lastError || '' }
    else if (message.type === 'tunnel-start') result = await tunnel.start()
    else if (message.type === 'tunnel-stop') result = await tunnel.stop()
    else if (message.type === 'tunnel-status') result = await tunnel.status()
    else throw Error('Unknown worker request')
    process.send?.({ type: 'response', id: message.id, result })
  } catch (error) {
    process.send?.({ type: ready ? 'response' : 'fatal', id: message.id,
      error: String(error.message).replace(/\/(?:adapter-)?mcp\/[\w-]+/g, '/mcp/[private]').slice(0, 2000) })
    if (!ready) void close()
  }
})
