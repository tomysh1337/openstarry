// Bundle with esbuild (--platform=node --external:electron), then run with Electron.
import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { rm } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { registerIdeIpc } from '../src/main/ipc/ide.js'

const profile = mkdtempSync(join(tmpdir(), 'openstarry-http-test-'))
app.setPath('userData', profile)
app.whenReady().then(async () => {
const window = new BrowserWindow({ show: false, webPreferences: { preload: resolve('out/preload/index.js'), contextIsolation: true, sandbox: false } })
let exitCode = 0
window.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message) })
window.webContents.on('preload-error', (_event, _path, error) => console.error(error))
registerIdeIpc(() => window)
let response, aborted = false
const server = createServer((request, res) => {
  response = res
  if (request.url === '/cancel') res.on('close', () => { aborted = true })
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"content":"桥接首段"}}]}\n\n')
})
const until = async condition => {
  for (let attempt = 0; attempt < 100; attempt++) { if (await condition()) return; await delay(50) }
  throw Error('Electron HTTP test timed out')
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  await window.loadURL('data:text/html,<title>IDE HTTP test</title>')
  await window.webContents.executeJavaScript(`
    window.chunks = []; window.completed = false;
    window.off = window.api.ide.onHttpChunk(event => window.chunks.push(event));
    window.pending = window.api.ide.http({ id: 'stream', url: ${JSON.stringify(url)}, method: 'POST', stream: true }).then(value => { window.completed = true; return value });
    true;
  `)
  await until(() => window.webContents.executeJavaScript('window.chunks.length > 0'))
  assert.equal(await window.webContents.executeJavaScript('window.completed'), false)
  assert.match(await window.webContents.executeJavaScript('window.chunks[0].text'), /桥接首段/)
  response.end('data: [DONE]\n\n')
  const result = await window.webContents.executeJavaScript('window.pending')
  assert.equal(result.streamed, true); assert.equal(result.text, '')
  await window.webContents.executeJavaScript(`
    window.pending = window.api.ide.http({ id: 'cancel', url: ${JSON.stringify(url + '/cancel')}, method: 'POST', stream: true }).then(() => false, () => true);
    true;
  `)
  await until(() => window.webContents.executeJavaScript('window.chunks.some(event => event.id === "cancel")'))
  await window.webContents.executeJavaScript('window.api.ide.cancelHttp({ id: "cancel" })')
  assert.equal(await window.webContents.executeJavaScript('window.pending'), true)
  await until(() => aborted)
  await window.webContents.executeJavaScript('window.off()')
  console.log('PASS: real Electron IPC streams before EOF, isolates request IDs and aborts the underlying connection')
} catch (error) { console.error(error); exitCode = 1 }
finally {
  server.closeAllConnections(); server.close(); window.destroy()
  // This is the exact fresh test profile created above, not an existing user profile.
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  app.exit(exitCode)
}
})
