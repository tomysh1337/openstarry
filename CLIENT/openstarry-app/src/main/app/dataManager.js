import { cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync } from 'fs'
import { basename, join, relative } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { createGzip } from 'zlib'
import { pipeline } from 'stream/promises'

function walk(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name)
    return entry.isDirectory() ? walk(fullPath) : [fullPath]
  })
}

export class DataManager {
  constructor(paths, settingsStore, ntpClock) {
    this.paths = paths
    this.settingsStore = settingsStore
    this.ntpClock = ntpClock
  }

  async maintain() {
    await this.createDailyBackup()
    this.pruneDiagnostics()
    return this.retentionStatus()
  }

  async createDailyBackup(force = false) {
    mkdirSync(this.paths.backups, { recursive: true })
    const day = new Date(this.ntpClock.now()).toISOString().slice(0, 10)
    const databases = walk(this.paths.data).filter((filePath) => /\.(sqlite3?|db)$/i.test(filePath))
    const created = []
    for (const database of databases) {
      const safeName = relative(this.paths.data, database).replace(/[\\/:*?"<>|]/g, '_')
      const destination = join(this.paths.backups, `${day}-${safeName}.gz`)
      if (!force && existsSync(destination)) continue
      await pipeline(createReadStream(database), createGzip({ level: 9 }), createWriteStream(destination))
      created.push(destination)
    }
    this._pruneBackups()
    return created
  }

  _pruneBackups() {
    const maximum = this.settingsStore.get().retention.backupCount
    const files = walk(this.paths.backups)
      .filter((filePath) => filePath.endsWith('.gz'))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    for (const filePath of files.slice(maximum)) unlinkSync(filePath)
  }

  pruneDiagnostics() {
    const maximumAge = this.settingsStore.get().retention.diagnosticLogDays * 86400000
    const cutoff = this.ntpClock.now() - maximumAge
    for (const filePath of walk(this.paths.logs)) {
      if (statSync(filePath).mtimeMs < cutoff) unlinkSync(filePath)
    }
  }

  retentionStatus() {
    const reminderAge = this.settingsStore.get().retention.trashReminderDays * 86400000
    const cutoff = this.ntpClock.now() - reminderAge
    const expired = walk(this.paths.trash).filter((filePath) => statSync(filePath).mtimeMs <= cutoff)
    return {
      reminderDays: this.settingsStore.get().retention.trashReminderDays,
      expiredCount: expired.length,
      expiredItems: expired.slice(0, 100).map((filePath) => basename(filePath))
    }
  }

  _powershell(script) {
    return new Promise((resolve, reject) => {
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded
      ], { windowsHide: true, stdio: 'ignore' })
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`PowerShell exited with code ${code}`)))
    })
  }

  async exportArchive(destination) {
    const staging = mkdtempSync(join(tmpdir(), 'openstarry-export-'))
    try {
      for (const name of ['data', 'backups', 'settings.json', 'vault.json', 'trusted-time.json']) {
        const source = join(this.paths.root, name)
        if (existsSync(source)) cpSync(source, join(staging, name), { recursive: true })
      }
      const sourcePattern = join(staging, '*').replaceAll("'", "''")
      const destinationPath = destination.replaceAll("'", "''")
      await this._powershell(`Compress-Archive -Path '${sourcePattern}' -DestinationPath '${destinationPath}' -CompressionLevel Optimal -Force`)
      return destination
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  async restoreArchive(source) {
    const staging = mkdtempSync(join(tmpdir(), 'openstarry-restore-'))
    try {
      const sourcePath = source.replaceAll("'", "''")
      const destinationPath = staging.replaceAll("'", "''")
      await this._powershell(`Expand-Archive -LiteralPath '${sourcePath}' -DestinationPath '${destinationPath}' -Force`)
      for (const name of ['data', 'backups', 'settings.json', 'vault.json', 'trusted-time.json']) {
        const restored = join(staging, name)
        if (existsSync(restored)) cpSync(restored, join(this.paths.root, name), { recursive: true, force: true })
      }
      return true
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
}
