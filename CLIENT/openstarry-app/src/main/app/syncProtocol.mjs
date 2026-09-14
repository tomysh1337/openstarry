import { createHash } from 'crypto'

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])])
    )
  }
  return value
}

export function stableStringify(value) {
  return JSON.stringify(normalize(value))
}

export function recordHash(record) {
  return createHash('sha256')
    .update(
      stableStringify({
        id: record.id,
        kind: record.kind,
        deleted: Boolean(record.deleted),
        payload: record.payload || {}
      })
    )
    .digest('hex')
}

function tombstone(id) {
  const [kind, ...parts] = id.split(':')
  const payload = {}
  if (kind === 'conversation') payload.conversation_uid = parts.join(':')
  if (kind === 'message') {
    payload.conversation_uid = parts.shift() || ''
    payload.sync_id = parts.join(':')
  }
  if (kind === 'file') payload.file_id = parts.join(':')
  return { id, kind, deleted: true, payload }
}

export function collectLocalChanges(records, previousHashes, now, deviceId) {
  const hashes = {}
  const operations = []
  for (const record of records) {
    const hash = recordHash(record)
    hashes[record.id] = hash
    if (previousHashes[record.id] === hash) continue
    operations.push({
      opId: deviceId + ':' + now + ':' + record.id,
      modifiedAt: now,
      deviceId,
      localPath: record.localPath || '',
      record: {
        id: record.id,
        kind: record.kind,
        deleted: Boolean(record.deleted),
        payload: record.payload || {}
      }
    })
  }
  for (const id of Object.keys(previousHashes)) {
    if (Object.hasOwn(hashes, id)) continue
    operations.push({
      opId: deviceId + ':' + now + ':' + id,
      modifiedAt: now,
      deviceId,
      localPath: '',
      record: tombstone(id)
    })
  }
  return { hashes, operations }
}

export function mergeQueue(current, additions) {
  const byRecord = new Map()
  for (const operation of [...current, ...additions]) {
    const existing = byRecord.get(operation.record.id)
    if (
      !existing ||
      operation.modifiedAt > existing.modifiedAt ||
      (operation.modifiedAt === existing.modifiedAt &&
        operation.deviceId.localeCompare(existing.deviceId) >= 0)
    ) {
      byRecord.set(operation.record.id, operation)
    }
  }
  return [...byRecord.values()].sort(
    (left, right) =>
      left.modifiedAt - right.modifiedAt || left.record.id.localeCompare(right.record.id)
  )
}

export function validateSyncConfig(value) {
  const serverUrl = String(value?.serverUrl || '')
    .trim()
    .replace(/\/+$/, '')
  const userId = String(value?.userId || '').trim()
  const enabled = Boolean(value?.enabled)
  const intervalMinutes = Math.min(1440, Math.max(1, Number(value?.intervalMinutes) || 5))
  if (enabled) {
    if (!serverUrl) throw new Error('请填写同步服务器地址')
    const parsed = new URL(serverUrl)
    const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
    if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
      throw new Error('同步服务器必须使用 HTTPS')
    }
    if (!userId) throw new Error('请填写同步用户 ID')
  }
  return { enabled, serverUrl, userId, intervalMinutes }
}

export function networkOperation(operation) {
  return {
    opId: operation.opId,
    modifiedAt: operation.modifiedAt,
    deviceId: operation.deviceId,
    record: operation.record
  }
}
