import { ipcMain, app } from 'electron'
import { isWin } from '../app/constants'

export function registerWindowIpc(win, settingsStore) {
  console.log('registerWindowIpc...')
  ipcMain.removeAllListeners('window-minimize')
  ipcMain.removeAllListeners('window-maximize')
  ipcMain.removeAllListeners('window-close')
  ipcMain.on('window-minimize', () => win.minimize())

  ipcMain.on('window-maximize', () => {
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })

  ipcMain.on('window-close', () => {
    if (isWin && settingsStore?.get().closeBehavior === 'tray') win.hide()
    else app.quit()
  })
}
