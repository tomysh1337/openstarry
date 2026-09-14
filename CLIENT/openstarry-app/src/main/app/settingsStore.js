import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

const DEFAULT_SETTINGS = Object.freeze({
  closeBehavior: 'tray',
  launchAtLogin: false,
  computerControlMode: 'auto',
  confirmIrreversibleActions: true,
  autoContinue: {
    enabled: true,
    maxTurns: 50,
    maxMinutes: 120,
    repeatedErrorLimit: 3
  },
  vault: {
    enabled: false,
    helloPreferred: true,
    masterPasswordFallback: false
  },
  updates: {
    enabled: true,
    channel: 'stable'
  },
  sync: {
    enabled: false,
    serverUrl: 'https://openstarry.154-219-110-177.sslip.io',
    userId: 'tomysh',
    intervalMinutes: 5
  },
  retention: {
    trashReminderDays: 45,
    diagnosticLogDays: 30,
    backupCount: 30
  }
})

function mergeSettings(base, value) {
  const output = { ...base }
  for (const [key, nextValue] of Object.entries(value || {})) {
    if (
      nextValue &&
      typeof nextValue === 'object' &&
      !Array.isArray(nextValue) &&
      base[key] &&
      typeof base[key] === 'object'
    ) {
      output[key] = mergeSettings(base[key], nextValue)
    } else {
      output[key] = nextValue
    }
  }
  return output
}

export class SettingsStore {
  constructor() {
    this.filePath = join(app.getPath('userData'), 'settings.json')
    this.value = this._read()
  }

  _read() {
    try {
      if (existsSync(this.filePath)) {
        return mergeSettings(DEFAULT_SETTINGS, JSON.parse(readFileSync(this.filePath, 'utf8')))
      }
    } catch (error) {
      console.error('Unable to read settings:', error)
    }
    return mergeSettings(DEFAULT_SETTINGS, {})
  }

  get() {
    return structuredClone(this.value)
  }

  update(patch) {
    this.value = mergeSettings(this.value, patch)
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.value, null, 2), 'utf8')
    app.setLoginItemSettings({
      openAtLogin: Boolean(this.value.launchAtLogin),
      openAsHidden: Boolean(this.value.launchAtLogin),
      args: this.value.launchAtLogin ? ['--hidden'] : []
    })
    return this.get()
  }
}

export function createDataDirectories() {
  const root = app.getPath('userData')
  const paths = {
    root,
    data: join(root, 'data'),
    attachments: join(root, 'data', 'attachments'),
    trash: join(root, 'data', 'trash'),
    backups: join(root, 'backups'),
    cache: join(root, 'cache'),
    components: join(root, 'components'),
    logs: join(root, 'logs')
  }
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true })
  return paths
}
