import { app, dialog, ipcMain } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import trash from 'trash'
import { IdeWorkspace } from '../app/ideWorkspace.mjs'
export function registerIdeIpc(getWindow) {
  const workspace = new IdeWorkspace(), requests = new Map(), jobs = new Map()
  const knownRoots = path.join(app.getPath('userData'), 'ide-project-roots.json')
  const ready = fs.readFile(knownRoots, 'utf8').then(text => Promise.allSettled(JSON.parse(text).map(root => workspace.authorize(root)))).catch(() => {})
  const handle = (name, fn) => ipcMain.handle('ide:' + name, async (event, payload) => {
    const window = getWindow()
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw Error('IDE 请求来源无效')
    await ready; return fn(payload, event)
  })
  handle('open', async () => {
    const result = await dialog.showOpenDialog(getWindow(), { title: '打开 IDE 项目目录', properties: ['openDirectory'] })
    if (result.canceled) return null
    const root = await workspace.authorize(result.filePaths[0]); await fs.writeFile(knownRoots, JSON.stringify([...workspace.roots]))
    return workspace.readProject(root)
  })
  handle('write', payload => workspace.write(payload))
  handle('rename', payload => workspace.rename(payload))
  handle('remove', async payload => { const target = await workspace.check(payload.root, payload.path, payload.expected); await trash(target); return { removed: true } })
  handle('export', async ({ name, bytes }) => { const result = await dialog.showSaveDialog(getWindow(), { defaultPath: name, filters: [{ name: '项目 ZIP', extensions: ['zip'] }] }); if (!result.canceled) await fs.writeFile(result.filePath, Buffer.from(bytes)); return !result.canceled })
  handle('run', async (payload, event) => {
    const { id, done } = await workspace.run(payload, ({ text }) => { if (!event.sender.isDestroyed()) event.sender.send('ide:output', { requestId: payload.requestId, text }) })
    jobs.set(payload.requestId, id)
    try { return await done } finally { jobs.delete(payload.requestId) }
  })
  handle('stop', ({ requestId }) => workspace.stop(jobs.get(requestId)))
  handle('http', async ({ id, url, method, headers, body }) => {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('请求地址格式错误')
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 180000); requests.set(id, controller)
    try {
      const response = await fetch(parsed, { method, headers, body, signal: controller.signal }); const reader = response.body.getReader(); const parts = []; let total = 0
      try { while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > 4 * 1024 * 1024) throw Error('响应超过大小上限'); parts.push(Buffer.from(value)) } }
      finally { await reader.cancel().catch(() => {}) }
      return { status: response.status, headers: Object.fromEntries(response.headers), text: Buffer.concat(parts).toString('utf8') }
    } finally { clearTimeout(timer); requests.delete(id) }
  })
  handle('cancel-http', ({ id }) => requests.get(id)?.abort())
  app.on('before-quit', () => { workspace.stopAll(); for (const request of requests.values()) request.abort() })
}
