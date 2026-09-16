import { app, dialog, ipcMain, shell, Notification } from 'electron'
import { join } from 'path'

function register(channel, handler) {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, handler)
}

export function registerSystemIpc({
  settingsStore,
  backendManager,
  ntpClock,
  dataManager,
  vault,
  computerUseManager,
  syncManager,
  autoUpdater,
  getMainWindow,
  requestQuit
}) {
  const questionNotifications = new Map()
  register('question:notify', (_event, value) => {
    const id = String(value?.id || '')
    if (!id || questionNotifications.has(id)) return false
    if (!Notification.isSupported()) return false
    const notification = new Notification({ title: 'OpenStarry NextGen 需要你回答', body: String(value.question || '请返回聊天确认项目需求').slice(0, 160), silent: false })
    questionNotifications.set(id, notification)
    if (questionNotifications.size > 100) questionNotifications.delete(questionNotifications.keys().next().value)
    notification.on('click', () => {
      const window = getMainWindow()
      if (!window || window.isDestroyed()) return
      if (window.isMinimized()) window.restore()
      window.show(); window.focus()
      window.webContents.send('question:focus', { historyId: String(value.historyId || '') })
    })
    notification.show()
    return true
  })
  register('system:info' , () => ({
    name: 'OpenStarry NextGen',
    version: app.getVersion(),
    publisher: 'tomysh',
    platform: process.platform,
    release: process.getSystemVersion(),
    dataPath: app.getPath('userData')
  }))
  register('system:settings:get', () => settingsStore.get())
  register('system:settings:update', (_event, patch) => settingsStore.update(patch || {}))
  register('system:show-data', () => shell.openPath(app.getPath('userData')))
  register('system:show-logs', () => shell.openPath(join(app.getPath('userData'), 'logs')))
  register('system:quit', () => requestQuit())

  register('runtime:status:get', () => backendManager.getStatus())
  register('runtime:retry', () => backendManager.retry().then(() => backendManager.getStatus()))
  register('time:status', () => ntpClock.status())
  register('time:sync', () => ntpClock.synchronize())
  register('retention:status:get', () => dataManager.retentionStatus())
  register('backup:create', () => dataManager.createDailyBackup(true))
  register('backup:export', async () => {
    const result = await dialog.showSaveDialog(getMainWindow(), {
      title: '导出 OpenStarry NextGen 本地数据',
      defaultPath: `OpenStarry-NextGen-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: 'OpenStarry 数据备份', extensions: ['zip'] }]
    })
    if (result.canceled || !result.filePath) return null
    return dataManager.exportArchive(result.filePath)
  })
  register('backup:restore', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: '恢复 OpenStarry NextGen 本地数据',
      properties: ['openFile'],
      filters: [{ name: 'OpenStarry 数据备份', extensions: ['zip'] }]
    })
    if (result.canceled || !result.filePaths[0]) return false
    await backendManager.stop()
    await dataManager.restoreArchive(result.filePaths[0])
    await backendManager.start()
    return true
  })

  register('vault:unlock', (_event, password) => vault.unlock(password || ''))
  register('vault:configure-password', (_event, password) => vault.configureMasterPassword(password || ''))
  register('vault:list', () => vault.list())
  register('vault:set', (_event, name, secret) => vault.set(name, secret))
  register('vault:get', (_event, name) => vault.get(name))
  register('vault:remove', (_event, name) => vault.remove(name))

  register('computer:perform', (_event, action, args, options) => computerUseManager.perform(action, args, options))
  register('computer:resolve-approval', (_event, id, accepted) => computerUseManager.resolveApproval(id, accepted))

  register('sync:status:get', () => syncManager.getStatus())
  register('sync:configure', (_event, config, token) => syncManager.configure(config || {}, token || ''))
  register('sync:preferences', (_event, values) => syncManager.sharedPreferences(values || {}))
  register('sync:run', () => syncManager.syncNow())
  register('sync:reset', () => syncManager.resetCursor())

  register('update:check', () => app.isPackaged ? autoUpdater.checkForUpdates() : ({ development: true }))
  register('update:download', () => autoUpdater.downloadUpdate())
  register('update:install', () => {
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return true
  })
}
