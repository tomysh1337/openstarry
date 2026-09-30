// Actual compiled renderer and preload; unrelated API services use isolated fixtures.
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { GptWebService } from '../src/main/app/gptWebService.mjs'
import { IdeWorkspace } from '../src/main/app/ideWorkspace.mjs'
import { registerIdeIpc } from '../src/main/ipc/ide.js'

const manual = process.env.OPENSTARRY_WEB_ACCEPTANCE === 'manual'
const live = manual || process.env.OPENSTARRY_WEB_ACCEPTANCE === 'live'
const profile =
  process.env.OPENSTARRY_WEB_TEST_PROFILE || mkdtempSync(join(tmpdir(), 'openstarry-home-ui-'))
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
app.setName('OpenStarry GUI acceptance')
const apiHistoryId = 'api-home-ui-fixture',
  now = new Date().toISOString()
const data = new Map(),
  preferences = {},
  calls = []
const fixture = (name, action) =>
  ipcMain.handle(name, (_event, ...args) => {
    calls.push({
      name,
      historyId:
        args.find((value) => typeof value === 'string' && value.startsWith('home-web-')) || ''
    })
    return action(...args)
  })
fixture('readData', (key) => data.get(key) || [])
fixture('writeData', (key, value) => {
  data.set(key, value)
  return true
})
fixture('runtime:status:get', () => ({
  phase: 'ready',
  progress: 100,
  message: 'GUI fixture services'
}))
fixture('retention:status:get', () => ({ expiredCount: 0 }))
fixture('sync:preferences', (values) => ({ values: Object.assign(preferences, values || {}) }))
fixture('api:fetch_chat_list', () => ({
  messages: [
    {
      conversation_uid: apiHistoryId,
      title: 'API 验收历史',
      last_active_at: now,
      create_at: now,
      work_space: '',
      latest_cursor: 0
    }
  ]
}))
fixture('api:fetch_chat_messages', () => ({ messages: [] }))
fixture('api:get_chat_meta', () => ({ messages: [{ work_space: '' }] }))
fixture('api:update_conversation', () => ({ success: true }))
fixture('api:get_models_list', () => [])
fixture('api:get_llm_providers', () => [])
fixture('api:get_mcp_servers', () => [])
fixture('api:get_available_skills', () => [])
fixture('api:get_available_documents', () => [])
fixture('api:get_ai_task_list', () => [])
fixture('api:get_cron_task_list', () => [])
fixture('question:notify', () => ({ shown: false }))
globalThis.homeAcceptance = { profile, calls }

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    show: true,
    title: manual ? 'OpenStarry 手动验收' : 'OpenStarry GUI acceptance',
    webPreferences: {
      preload: resolve('out/preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  const service = new GptWebService({
    workspace: new IdeWorkspace(),
    baseDir: join(profile, 'gpt-web'),
    scriptPath: resolve(
      '../../LOCAL/gpt-web-mcp/' + (live ? 'desktop-worker.mjs' : 'test/desktop-fixture-worker.mjs')
    ),
    nodePaths: [resolve('vendor/runtime-tools/node.exe')],
    cloudflaredPaths: live ? [resolve('vendor/runtime-tools/cloudflared.exe'), 'C:/Program Files (x86)/cloudflared/cloudflared.exe'] : []
  })
  globalThis.homeAcceptance.service = service
  const runtime = registerIdeIpc(() => window, { webService: service })
  let exiting = false
  app.on('before-quit', (event) => {
    if (exiting) return
    exiting = true
    event.preventDefault()
    void runtime.stop().finally(() => app.exit())
  })
  ipcMain.on('window-close', () => app.quit())
  ipcMain.on('window-minimize', () => window.minimize())
  ipcMain.on('window-maximize', () =>
    window.isMaximized() ? window.unmaximize() : window.maximize()
  )
  window.webContents.on('did-finish-load', () => {
    void window.webContents.executeJavaScript(`(() => {
      const notice = document.createElement('div'); notice.id = 'acceptance-banner'; notice.textContent = ${JSON.stringify((manual ? '手动验收 · 由你操作' : 'GUI 验收') + ' · API 后端为 fixture · 网页来源：' + (live ? '真实 ChatGPT' : 'fixture'))};
      notice.style.cssText = 'position:fixed;bottom:0;left:0;z-index:999999;padding:3px 9px;background:#fff0be;color:#533e00;font:11px system-ui;pointer-events:none'; document.body.append(notice);
    })()`)
  })
  await window.loadFile(resolve('out/renderer/index.html'), { hash: '/assistPage' })
})
