import { safeStorage } from 'electron'
import { EventEmitter } from 'events'
import { createHash, randomUUID } from 'crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { gzipSync, gunzipSync } from 'zlib'
import {
  collectLocalChanges,
  mergeQueue,
  networkOperation,
  recordHash,
  validateSyncConfig
} from './syncProtocol.mjs'

const MEMORY_SYNC_URL = 'http://127.0.0.1:5093/sync'
const FILE_SYNC_URL = 'http://127.0.0.1:5094/sync'
const MAX_BATCH = 500

function readJson(filePath, fallback) {
  try {
    return existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : fallback
  } catch {
    return fallback
  }
}

function atomicWrite(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true })
  const temporary = filePath + '.tmp'
  writeFileSync(temporary, data)
  renameSync(temporary, filePath)
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(30000)
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.detail || data.message || 'HTTP ' + response.status)
  return data
}

export class SyncManager extends EventEmitter {
  constructor(paths, settingsStore, ntpClock) {
    super()
    this.paths = paths
    this.settingsStore = settingsStore
    this.ntpClock = ntpClock
    this.statePath = join(paths.data, 'sync-state.json')
    this.queuePath = join(paths.data, 'sync-queue.json.gz')
    this.credentialPath = join(paths.root, 'sync-credential.json')
    this.timer = null
    this.activeSync = null
    this.failureCount = 0
    this.status = {
      phase: 'idle',
      message: '云端同步未启用',
      queued: this._readQueue().length,
      lastSyncAt: null,
      configured: this._isConfigured()
    }
  }

  _readState() {
    const state = readJson(this.statePath, {})
    return {
      version: 1,
      deviceId: state.deviceId || randomUUID(),
      cursor: Number(state.cursor) || 0,
      recordHashes: state.recordHashes || {},
      lastSyncAt: state.lastSyncAt || null
    }
  }

  _writeState(state) {
    atomicWrite(this.statePath, JSON.stringify(state))
  }

  _readQueue() {
    try {
      if (!existsSync(this.queuePath)) return []
      return JSON.parse(gunzipSync(readFileSync(this.queuePath)).toString('utf8'))
    } catch {
      return []
    }
  }

  _writeQueue(queue) {
    if (!queue.length) {
      rmSync(this.queuePath, { force: true })
      return
    }
    atomicWrite(this.queuePath, gzipSync(JSON.stringify(queue), { level: 9 }))
  }

  _setStatus(patch) {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.getStatus())
  }

  getStatus() {
    return structuredClone({
      ...this.status,
      credentialStored: existsSync(this.credentialPath),
      enabled: Boolean(this.settingsStore.get().sync?.enabled)
    })
  }

  _isConfigured() {
    const sync = this.settingsStore.get().sync || {}
    return Boolean(sync.serverUrl && sync.userId && existsSync(this.credentialPath))
  }

  _setCredential(token) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 凭据保护当前不可用')
    }
    const encrypted = safeStorage.encryptString(token).toString('base64')
    atomicWrite(this.credentialPath, JSON.stringify({ version: 1, value: encrypted }))
  }

  _getCredential() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 凭据保护当前不可用')
    }
    const saved = readJson(this.credentialPath, null)
    if (!saved?.value) throw new Error('请保存同步访问令牌')
    return safeStorage.decryptString(Buffer.from(saved.value, 'base64'))
  }

  async configure(patch = {}, token = '') {
    const current = this.settingsStore.get().sync || {}
    const next = validateSyncConfig({ ...current, ...patch })
    if (token) this._setCredential(String(token))
    if (patch.clearCredential) rmSync(this.credentialPath, { force: true })
    if (next.enabled && !existsSync(this.credentialPath)) {
      throw new Error('请填写同步访问令牌')
    }
    this.settingsStore.update({ sync: next })
    this._setStatus({
      phase: next.enabled ? 'idle' : 'disabled',
      message: next.enabled ? '同步配置已保存' : '云端同步未启用',
      configured: this._isConfigured()
    })
    this.start()
    return this.getStatus()
  }

  start() {
    this.stop()
    const config = this.settingsStore.get().sync || {}
    if (!config.enabled) return
    this._schedule(1000)
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  resetCursor() {
    const state = this._readState()
    state.cursor = 0
    state.recordHashes = {}
    this._writeState(state)
    this._writeQueue([])
    this._setStatus({ phase: 'idle', message: '下次同步将重新核对全部数据', queued: 0 })
    return this.getStatus()
  }

  _schedule(delay) {
    this.stop()
    this.timer = setTimeout(() => {
      this.syncNow().catch(() => {})
    }, delay)
    this.timer.unref?.()
  }

  async syncNow() {
    if (this.activeSync) return this.activeSync
    this.activeSync = this._synchronize().finally(() => {
      this.activeSync = null
      const config = this.settingsStore.get().sync || {}
      if (!config.enabled) return
      const interval = config.intervalMinutes * 60000
      const retry = Math.min(300000, 5000 * 2 ** Math.min(this.failureCount, 6))
      this._schedule(this.failureCount ? retry : interval)
    })
    return this.activeSync
  }

  async _localRecords() {
    const payload = JSON.stringify({ client_id: 'local-user' })
    const [memory, files] = await Promise.all([
      jsonRequest(MEMORY_SYNC_URL + '/export', { method: 'POST', body: payload }),
      jsonRequest(FILE_SYNC_URL + '/export', { method: 'POST', body: payload })
    ])
    return [...(memory.records || []), ...(files.records || [])]
  }

  _headers(config, token, deviceId) {
    return {
      Authorization: 'Bearer ' + token,
      'X-OpenStarry-User': config.userId,
      'X-OpenStarry-Device': deviceId
    }
  }

  _attachmentUrl(config, sha256) {
    return config.serverUrl + '/v1/sync/attachments/' + sha256
  }

  _validLocalAttachment(filePath) {
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) return false
    const root = resolve(this.paths.attachments)
    const candidate = resolve(filePath)
    return candidate === root || candidate.startsWith(root + sep)
  }

  async _uploadAttachment(operation, config, headers) {
    if (operation.record.kind !== 'file' || operation.record.deleted) return
    const sha256 = operation.record.payload.sha256
    if (!/^[a-f0-9]{64}$/i.test(sha256 || '')) return
    if (!this._validLocalAttachment(operation.localPath)) return
    const url = this._attachmentUrl(config, sha256)
    const existing = await fetch(url, {
      method: 'HEAD',
      headers,
      signal: AbortSignal.timeout(30000)
    })
    if (existing.ok) return
    if (existing.status !== 404) throw new Error('附件检查失败：HTTP ' + existing.status)
    const uploaded = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body: createReadStream(operation.localPath),
      duplex: 'half',
      signal: AbortSignal.timeout(300000)
    })
    if (!uploaded.ok) throw new Error('附件上传失败：HTTP ' + uploaded.status)
  }

  async _downloadAttachment(record, config, headers) {
    if (record.kind !== 'file' || record.deleted) return record
    const sha256 = record.payload?.sha256
    if (!/^[a-f0-9]{64}$/i.test(sha256 || '')) return record
    const target = join(
      this.paths.attachments,
      'files',
      'blobs',
      'local-user',
      sha256.slice(0, 2),
      sha256
    )
    if (existsSync(target)) return { ...record, localPath: target }
    mkdirSync(dirname(target), { recursive: true })
    const temporary = target + '.download'
    const response = await fetch(this._attachmentUrl(config, sha256), {
      headers,
      signal: AbortSignal.timeout(300000)
    })
    if (!response.ok || !response.body) {
      throw new Error('附件下载失败：HTTP ' + response.status)
    }
    const hasher = createHash('sha256')
    const hashingStream = new Transform({
      transform(chunk, _encoding, callback) {
        hasher.update(chunk)
        callback(null, chunk)
      }
    })
    try {
      await pipeline(response.body, hashingStream, createWriteStream(temporary))
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
    if (hasher.digest('hex') !== sha256.toLowerCase()) {
      rmSync(temporary, { force: true })
      throw new Error('附件完整性校验失败')
    }
    renameSync(temporary, target)
    return { ...record, localPath: target }
  }

  async _applyRemote(records, config, headers) {
    if (!records.length) return 0
    const memory = records.filter((item) => ['conversation', 'message'].includes(item.kind))
    const files = []
    for (const record of records.filter((item) => item.kind === 'file')) {
      files.push(await this._downloadAttachment(record, config, headers))
    }
    let applied = 0
    if (memory.length) {
      const result = await jsonRequest(MEMORY_SYNC_URL + '/apply', {
        method: 'POST',
        body: JSON.stringify({ client_id: 'local-user', records: memory })
      })
      applied += result.applied || 0
    }
    if (files.length) {
      const result = await jsonRequest(FILE_SYNC_URL + '/apply', {
        method: 'POST',
        body: JSON.stringify({ client_id: 'local-user', records: files })
      })
      applied += result.applied || 0
    }
    return applied
  }

  async _synchronize() {
    const config = validateSyncConfig(this.settingsStore.get().sync || {})
    if (!config.enabled) return this.getStatus()
    const token = this._getCredential()
    const state = this._readState()
    let queue = this._readQueue()
    this._setStatus({ phase: 'syncing', message: '正在核对本地与云端记录', queued: queue.length })
    try {
      const localRecords = await this._localRecords()
      const changes = collectLocalChanges(
        localRecords,
        state.recordHashes,
        this.ntpClock.now(),
        state.deviceId
      )
      queue = mergeQueue(queue, changes.operations)
      state.recordHashes = changes.hashes
      this._writeQueue(queue)
      this._writeState(state)

      const headers = this._headers(config, token, state.deviceId)
      let hasMore = true
      let uploaded = 0
      let downloaded = 0
      while (queue.length || hasMore) {
        const outgoing = queue.slice(0, MAX_BATCH)
        for (const operation of outgoing) {
          await this._uploadAttachment(operation, config, headers)
        }
        const response = await jsonRequest(config.serverUrl + '/v1/sync', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            protocolVersion: 1,
            userId: config.userId,
            deviceId: state.deviceId,
            cursor: state.cursor,
            limit: MAX_BATCH,
            operations: outgoing.map(networkOperation)
          })
        })
        const outgoingIds = new Set(outgoing.map((operation) => operation.opId))
        const acknowledged = new Set(
          (response.acknowledgedIds || []).filter((operationId) => outgoingIds.has(operationId))
        )
        queue = queue.filter((operation) => !acknowledged.has(operation.opId))
        uploaded += acknowledged.size
        downloaded += await this._applyRemote(response.records || [], config, headers)
        const previousCursor = state.cursor
        const responseCursor = Number(response.cursor)
        if (Number.isFinite(responseCursor) && responseCursor >= 0) state.cursor = responseCursor
        hasMore = Boolean(response.hasMore)
        this._writeQueue(queue)
        this._writeState(state)
        if (!outgoing.length && !hasMore) break
        if (outgoing.length && !acknowledged.size) {
          throw new Error('服务器未确认本次同步记录')
        }
        if (hasMore && state.cursor === previousCursor) {
          throw new Error('服务器同步游标未推进')
        }
      }

      const refreshed = await this._localRecords()
      state.recordHashes = Object.fromEntries(
        refreshed.map((record) => [record.id, recordHash(record)])
      )
      state.lastSyncAt = new Date(this.ntpClock.now()).toISOString()
      this._writeState(state)
      this.failureCount = 0
      this._setStatus({
        phase: 'synced',
        message: '同步完成：上传 ' + uploaded + '，接收 ' + downloaded,
        queued: queue.length,
        lastSyncAt: state.lastSyncAt,
        configured: true
      })
      return this.getStatus()
    } catch (error) {
      this.failureCount += 1
      this._setStatus({
        phase: 'offline',
        message: '同步暂缓：' + error.message,
        queued: queue.length,
        configured: this._isConfigured()
      })
      throw error
    }
  }
}
