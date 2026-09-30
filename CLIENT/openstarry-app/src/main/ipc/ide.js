import { app, dialog, ipcMain, clipboard } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import trash from 'trash'
import { IdeWorkspace } from '../app/ideWorkspace.mjs'
import { GptWebService } from '../app/gptWebService.mjs'
export function registerIdeIpc(getWindow, { webService } = {}) {
  const workspace = new IdeWorkspace(), requests = new Map(), jobs = new Map()
  const web = webService || new GptWebService({ workspace, baseDir: path.join(app.getPath('userData'), 'gpt-web'),
    scriptPath: app.isPackaged ? path.join(process.resourcesPath, 'gpt-web-mcp', 'desktop-worker.mjs') : path.resolve(app.getAppPath(), '../../LOCAL/gpt-web-mcp/desktop-worker.mjs'),
    nodePaths: [path.join(process.resourcesPath, 'runtime', 'node.exe'), path.join(app.getAppPath(), 'vendor/runtime-tools/node.exe'), path.join(process.env.ProgramFiles || 'C:/Program Files', 'nodejs', 'node.exe')],
    cloudflaredPaths: [path.join(process.resourcesPath, 'runtime', 'cloudflared.exe'), path.join(app.getAppPath(), 'vendor/runtime-tools/cloudflared.exe'), 'C:/Program Files (x86)/cloudflared/cloudflared.exe'] })
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
  handle('http', async ({ id, url, method, headers, body, stream }, event) => {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('请求地址格式错误')
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 180000); requests.set(id, controller)
    try {
      const response = await fetch(parsed, { method, headers, body, signal: controller.signal }); const reader = response.body.getReader(); const parts = []; let total = 0
      const streamed = stream && response.ok && /text\/event-stream/i.test(response.headers.get('content-type') || '')
      const decoder = new TextDecoder()
      const emit = text => { if (text && !event.sender.isDestroyed()) event.sender.send('ide:http-chunk', { id, text }) }
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break
          total += value.length; if (total > 4 * 1024 * 1024) throw Error('响应超过大小上限')
          if (streamed) emit(decoder.decode(value, { stream: true })); else parts.push(Buffer.from(value))
        }
        if (streamed) emit(decoder.decode())
      }
      finally { await reader.cancel().catch(() => {}) }
      return { status: response.status, headers: Object.fromEntries(response.headers), streamed, text: Buffer.concat(parts).toString('utf8') }
    } finally { clearTimeout(timer); requests.delete(id) }
  })
  handle('cancel-http', ({ id }) => requests.get(id)?.abort())
  handle('gpt-status', ({ project }) => web.status(project))
  handle('gpt-services', value => web.services(value, text => clipboard.writeText(text)))
  handle('gpt-show', ({ project }) => web.show(project, code => clipboard.writeText(code)))
  handle('gpt-submit', value => web.submit(value))
  handle('gpt-download', value => web.download(value))
  handle('gpt-watch', async (value, event) => {
    const sender = event.sender, detach = () => web.unwatch(value.watchId)
    const navigating = (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) detach() }
    sender.on('did-start-navigation', navigating); sender.once('destroyed', detach); sender.once('render-process-gone', detach)
    try { return await web.watch(value, update => { if (!sender.isDestroyed()) sender.send('ide:gpt-event', { watchId: value.watchId, ...update }) }) }
    finally { sender.off('did-start-navigation', navigating); sender.off('destroyed', detach); sender.off('render-process-gone', detach) }
  })
  handle('gpt-unwatch', ({ watchId }) => web.unwatch(watchId))
  handle('gpt-cancel', value => web.cancel(value))
  handle('gpt-proposals', ({ project }) => web.proposals(project))
  handle('gpt-review', value => web.review(value))
  handle('gpt-tunnel-status', ({ project }) => web.tunnelStatus(project))
  handle('gpt-tunnel-start', ({ project }) => web.startTunnel(project))
  handle('gpt-tunnel-stop', ({ project }) => web.stopTunnel(project))
  handle('gpt-copy-address', async ({ project }) => { clipboard.writeText(await web.connectionAddress(project)); return { copied: true } })
  return { stop: async () => {
    workspace.stopAll(); for (const request of requests.values()) request.abort()
    await web.stop()
  } }
}
