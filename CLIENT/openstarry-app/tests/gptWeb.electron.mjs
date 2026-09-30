// Bundle with esbuild, then launch with Electron through tests/gptWeb.ui.mjs.
import { app, BrowserWindow } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { GptWebService } from '../src/main/app/gptWebService.mjs'
import { IdeWorkspace } from '../src/main/app/ideWorkspace.mjs'
import { registerIdeIpc } from '../src/main/ipc/ide.js'
const profile = mkdtempSync(join(tmpdir(), 'openstarry-web-ui-fixture-'))
app.setPath('userData', profile)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1440, height: 960, show: true, webPreferences: { preload: resolve('out/preload/index.js'), contextIsolation: true, sandbox: false } })
  const service = new GptWebService({ workspace: new IdeWorkspace(), baseDir: join(profile, 'gpt-web'), scriptPath: resolve('../../LOCAL/gpt-web-mcp/test/desktop-fixture-worker.mjs'), nodePaths: [resolve('vendor/runtime-tools/node.exe')] })
  const runtime = registerIdeIpc(() => window, { webService: service })
  let exiting = false
  app.on('before-quit', event => { if (exiting) return; exiting = true; event.preventDefault(); void runtime.stop().finally(() => app.exit()) })
  await window.loadURL('http://127.0.0.1:5180/qa/gpt-web.html')
})
