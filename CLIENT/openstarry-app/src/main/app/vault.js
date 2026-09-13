import { app, safeStorage } from 'electron'
import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'

const HELLO_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$verifier = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
$operation = $verifier::RequestVerificationAsync('解锁 OpenStarry NextGen 密码库')
$task = [System.WindowsRuntimeSystemExtensions]::AsTask($operation)
$result = $task.GetAwaiter().GetResult()
if ($result.ToString() -eq 'Verified') { exit 0 }
exit 1
`

function runHelloVerification() {
  return new Promise((resolve) => {
    const encoded = Buffer.from(HELLO_SCRIPT, 'utf16le').toString('base64')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: 'ignore'
    })
    child.once('error', () => resolve(false))
    child.once('exit', (code) => resolve(code === 0))
  })
}

function encryptWithPassword(value, password) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(password, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  }
}

function decryptWithPassword(value, password) {
  const key = scryptSync(password, Buffer.from(value.salt, 'base64'), 32)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8')
}

export class SecretVault {
  constructor(settingsStore) {
    this.settingsStore = settingsStore
    this.filePath = join(app.getPath('userData'), 'vault.json')
    this.unlockedUntil = 0
  }

  _read() {
    if (!existsSync(this.filePath)) return { version: 1, entries: {} }
    return JSON.parse(readFileSync(this.filePath, 'utf8'))
  }

  _write(value) {
    writeFileSync(this.filePath, JSON.stringify(value, null, 2), 'utf8')
  }

  async unlock(masterPassword = '') {
    const settings = this.settingsStore.get().vault
    if (!settings.enabled) {
      this.unlockedUntil = Date.now() + 5 * 60 * 1000
      return true
    }
    if (settings.helloPreferred && await runHelloVerification()) {
      this.unlockedUntil = Date.now() + 5 * 60 * 1000
      return true
    }
    const vault = this._read()
    if (settings.masterPasswordFallback && vault.passwordCheck && masterPassword) {
      try {
        const result = decryptWithPassword(vault.passwordCheck, masterPassword)
        if (result === 'openstarry-vault') {
          this.unlockedUntil = Date.now() + 5 * 60 * 1000
          return true
        }
      } catch { /* An invalid fallback password remains locked. */ }
    }
    return false
  }

  configureMasterPassword(password) {
    const vault = this._read()
    vault.passwordCheck = password ? encryptWithPassword('openstarry-vault', password) : null
    this._write(vault)
    return true
  }

  _requireUnlocked() {
    if (Date.now() > this.unlockedUntil) throw new Error('密码库已锁定')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据保护当前不可用')
  }

  set(name, secret) {
    this._requireUnlocked()
    const vault = this._read()
    vault.entries[name] = {
      value: safeStorage.encryptString(secret).toString('base64'),
      fingerprint: createHash('sha256').update(secret).digest('hex').slice(0, 12),
      updatedAt: new Date().toISOString()
    }
    this._write(vault)
    return { name, fingerprint: vault.entries[name].fingerprint }
  }

  get(name) {
    this._requireUnlocked()
    const entry = this._read().entries[name]
    if (!entry) return null
    return safeStorage.decryptString(Buffer.from(entry.value, 'base64'))
  }

  remove(name) {
    this._requireUnlocked()
    const vault = this._read()
    delete vault.entries[name]
    this._write(vault)
    return true
  }

  list() {
    return Object.entries(this._read().entries).map(([name, value]) => ({
      name,
      fingerprint: value.fingerprint,
      updatedAt: value.updatedAt
    }))
  }
}
