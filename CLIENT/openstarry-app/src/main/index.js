import { app, Menu, Tray } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import log from 'electron-log/main'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { closeWS, initWS } from './ws/wsClient'
import { createMainWindow } from './app/app'
import { BackendManager } from './app/backendManager'
import { ComputerUseManager } from './app/computerUseManager'
import { DataManager } from './app/dataManager'
import { NtpClock } from './app/ntpClock'
import { SecretVault } from './app/vault'
import { SettingsStore } from './app/settingsStore'
import { registerSystemIpc } from './ipc/systemIpc'

const localDataRoot = process.env.LOCALAPPDATA || app.getPath('appData')
app.setPath('userData', join(localDataRoot, 'OpenStarry NextGen'))
app.setName('OpenStarry NextGen')

log.initialize()
log.transports.file.resolvePathFn = () => join(app.getPath('userData'), 'logs', 'desktop.log')
Object.assign(console, log.functions)

let mainWindow = null
let tray = null
let quitting = false
let cleanupStarted = false

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

function createTray() {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'branding', 'OpenStarry.png')
    : join(process.cwd(), 'resources', 'OpenStarry.png')
  tray = new Tray(iconPath)
  tray.setToolTip('OpenStarry NextGen')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 OpenStarry NextGen', click: showMainWindow },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ]))
  tray.on('double-click', showMainWindow)
  return tray
}

async function startApplication() {
  electronApp.setAppUserModelId('com.tomysh.openstarry-nextgen')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  const bridgeToken = randomUUID()
  const settingsStore = new SettingsStore()
  const backendManager = new BackendManager(settingsStore, bridgeToken)
  const ntpClock = new NtpClock()
  const dataManager = new DataManager(backendManager.paths, settingsStore, ntpClock)
  const vault = new SecretVault(settingsStore)
  const computerUseManager = new ComputerUseManager(settingsStore, bridgeToken)

  createTray()
  mainWindow = createMainWindow({
    settingsStore,
    isQuitting: () => quitting,
    onWindowChanged: (window) => { mainWindow = window }
  })

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }
  backendManager.on('status', (status) => send('runtime:status', status))
  computerUseManager.on('approval', (request) => send('computer:approval', request))
  computerUseManager.on('active', (status) => send('computer:active', status))

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () => send('update:status', { phase: 'checking' }))
  autoUpdater.on('update-available', (info) => send('update:status', { phase: 'available', info }))
  autoUpdater.on('update-not-available', (info) => send('update:status', { phase: 'current', info }))
  autoUpdater.on('download-progress', (progress) => send('update:status', { phase: 'downloading', progress }))
  autoUpdater.on('update-downloaded', (info) => send('update:status', { phase: 'downloaded', info }))
  autoUpdater.on('error', (error) => send('update:status', { phase: 'error', message: error.message }))

  registerSystemIpc({
    settingsStore,
    backendManager,
    ntpClock,
    dataManager,
    vault,
    computerUseManager,
    autoUpdater,
    getMainWindow: () => mainWindow,
    requestQuit: () => {
      quitting = true
      app.quit()
    }
  })

  computerUseManager.startBridge()
  ntpClock.synchronize()
    .then(() => dataManager.maintain())
    .then((retention) => send('retention:status', retention))
    .catch((error) => console.warn('Local maintenance warning:', error))

  backendManager.start()
    .then(() => initWS('local-user'))
    .catch((error) => {
      console.error('Runtime initialization failed:', error)
      send('runtime:status', {
        ...backendManager.getStatus(),
        phase: 'error',
        message: error.message
      })
    })

  if (app.isPackaged && settingsStore.get().updates.enabled) {
    setTimeout(() => autoUpdater.checkForUpdates().catch((error) => {
      console.warn('Update check failed:', error)
    }), 10000)
  }

  app.on('second-instance', showMainWindow)
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow({
        settingsStore,
        isQuitting: () => quitting,
        onWindowChanged: (window) => { mainWindow = window }
      })
    } else {
      showMainWindow()
    }
  })

  app.on('before-quit', (event) => {
    quitting = true
    if (cleanupStarted) return
    cleanupStarted = true
    event.preventDefault()
    Promise.allSettled([backendManager.stop(), computerUseManager.stop()]).finally(() => {
      closeWS()
      tray?.destroy()
      app.exit(0)
    })
  })
}

if (hasSingleInstanceLock) {
  app.whenReady().then(startApplication).catch((error) => {
    console.error('OpenStarry NextGen startup failed:', error)
    app.quit()
  })
}

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return
  if (quitting) app.quit()
})
