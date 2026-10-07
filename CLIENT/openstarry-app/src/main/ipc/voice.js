import { app, dialog, ipcMain } from 'electron'
import { join, resolve } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { VoiceManager } from '../app/voiceManager.mjs'

export function registerVoiceIpc(getWindow) {
  const manager = new VoiceManager({
    root: join(app.getPath('userData'), 'components', 'voice'),
    source: app.isPackaged
      ? join(process.resourcesPath, 'voice-runtime')
      : resolve(app.getAppPath(), '../../LOCAL/voice-runtime'),
    uv: app.isPackaged
      ? join(process.resourcesPath, 'runtime', 'uv.exe')
      : join(app.getAppPath(), 'vendor/runtime-tools/uv.exe'),
    logPath: join(app.getPath('userData'), 'logs', 'voice-setup.log')
  })
  const handle = (name, fn) =>
    ipcMain.handle('voice:' + name, (event, value) => {
      const window = getWindow()
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw Error('语音请求来源无效')
      return fn(value)
    })
  manager.on('status', (status) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('voice:status', status)
  })
  handle('status', () => manager.status())
  handle('configure', (value) => manager.configure(value))
  handle('install', () => manager.install())
  handle('start', () => manager.start())
  handle('stop', () => manager.stop())
  handle('transcribe', (bytes) => manager.transcribe(bytes))
  handle('synthesize', (text) => manager.synthesize(text))
  handle('reference', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择 3–10 秒参考音频',
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: ['wav', 'flac', 'ogg'] }]
    })
    if (result.canceled) return null
    if ((await stat(result.filePaths[0])).size > 20 * 1024 * 1024) throw Error('参考音频超过 20 MB')
    await manager.reference(await readFile(result.filePaths[0]))
    return manager.status()
  })
  return manager
}
