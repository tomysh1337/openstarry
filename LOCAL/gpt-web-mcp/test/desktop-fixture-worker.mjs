// This helper is only spawned by isolated Node service tests; it never opens a browser.
import { mkdir } from 'node:fs/promises'
import { startBridge } from '../server.mjs'
import { WebAdapter } from '../web-adapter.mjs'
let bridge, adapter
const driver = {
  pages: new Map(),
  async page(id) {
    if (!this.pages.has(id)) this.pages.set(id, { turns: 0, webConversationId: 'desktop-fixture-' + id })
    return this.pages.get(id)
  },
  async ready(page) { return { assistantCount: page.turns, userCount: page.turns, webConversationId: page.webConversationId } },
  async send(page, prompt) { page.prompt = prompt; page.turns++; page.at = Date.now(); page.stopped = false },
  async inspect(page) { const generating = page.prompt?.includes('保持生成') || Date.now() - page.at < 500; return { assistantCount: page.turns, userCount: page.turns, lastUser: page.prompt, webConversationId: page.webConversationId, text: '桌面链路的中文增量', busy: !page.stopped && generating, finished: page.stopped || !generating } },
  async stop(page) { page.stopped = true; return true }, async close() {}
}
async function close() { await adapter?.close(); await bridge?.close(); process.exit(0) }
process.on('disconnect', () => { void close() })
process.on('message', async message => {
  if (message.type === 'shutdown') return close()
  if (message.type === 'init') {
    await mkdir(message.workspace, { recursive: true })
    bridge = await startBridge({ workspace: message.workspace, stateDir: message.stateDir, fileScope: message.fileScope, newFilePolicy: message.newFilePolicy, protectedPaths: message.protectedPaths, port: 0 })
    adapter = new WebAdapter({ origin: bridge.origin, adminToken: bridge.adminToken, stateDir: message.stateDir, pageDriver: driver, source: 'fixture', pollMs: 15 })
    await adapter.start(); adapter.poll()
    process.send({ type: 'ready', origin: bridge.origin, adminToken: bridge.adminToken, mcpUrl: bridge.mcpUrl })
  } else process.send({ type: 'response', id: message.id, result: { browser: 'fixture', login: 'fixture', message: '模拟适配器，仅用于测试' } })
})
