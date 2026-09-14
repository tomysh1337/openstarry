const CONFIG_KEY = 'openstarry.mobile.config'
const CURSOR_KEY = 'openstarry.mobile.cursor'
const DATABASE_NAME = 'openstarry-mobile'
const STORE_NAME = 'records'

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transaction(mode, action) {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, mode)
    const store = tx.objectStore(STORE_NAME)
    const result = action(store)
    tx.oncomplete = () => {
      database.close()
      resolve(result)
    }
    tx.onerror = () => reject(tx.error)
  })
}

export function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null')
  } catch {
    return null
  }
}

export function saveConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({
    serverUrl: config.serverUrl.trim().replace(/\/+$/, ''),
    userId: config.userId.trim(),
    token: config.token
  }))
}

export function clearConfig() {
  localStorage.removeItem(CONFIG_KEY)
  localStorage.removeItem(CURSOR_KEY)
}

export async function clearRecords() {
  await transaction('readwrite', (store) => store.clear())
}

export async function allRecords() {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).getAll()
    request.onsuccess = () => {
      database.close()
      resolve(request.result)
    }
    request.onerror = () => reject(request.error)
  })
}

async function saveRecords(records) {
  await transaction('readwrite', (store) => {
    for (const record of records) store.put(record)
  })
}

function requestHeaders(config) {
  return {
    Authorization: 'Bearer ' + config.token,
    'Content-Type': 'application/json',
    'X-OpenStarry-User': config.userId,
    'X-OpenStarry-Device': 'android-mobile'
  }
}

export async function synchronize(config, forceFull = false) {
  let cursor = forceFull ? 0 : Number(localStorage.getItem(CURSOR_KEY) || 0)
  let received = 0
  let hasMore = true
  if (forceFull) await clearRecords()
  while (hasMore) {
    const response = await fetch(config.serverUrl + '/v1/sync', {
      method: 'POST',
      headers: requestHeaders(config),
      body: JSON.stringify({
        protocolVersion: 1,
        userId: config.userId,
        deviceId: 'android-mobile',
        cursor,
        limit: 500,
        operations: []
      })
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(data.detail || '同步服务器返回 HTTP ' + response.status)
    }
    await saveRecords(data.records || [])
    received += (data.records || []).length
    cursor = Number(data.cursor) || cursor
    localStorage.setItem(CURSOR_KEY, String(cursor))
    hasMore = Boolean(data.hasMore)
  }
  localStorage.setItem('openstarry.mobile.lastSync', new Date().toISOString())
  return received
}

export async function conversations(query = '') {
  const normalized = query.trim().toLowerCase()
  const records = await allRecords()
  const values = records
    .filter((record) => record.kind === 'conversation' && !record.deleted)
    .map((record) => record.payload)
    .filter((item) => !normalized || String(item.title || '').toLowerCase().includes(normalized))
  values.sort((left, right) => String(right.last_active_at || '').localeCompare(String(left.last_active_at || '')))
  return values
}

export async function messages(conversationId) {
  const records = await allRecords()
  const values = records
    .filter((record) => (
      record.kind === 'message' &&
      !record.deleted &&
      record.payload?.conversation_uid === conversationId
    ))
    .map((record) => record.payload)
  values.sort((left, right) => (
    Number(left.msg_cursor || 0) - Number(right.msg_cursor || 0) ||
    String(left.created_at || '').localeCompare(String(right.created_at || ''))
  ))
  return values
}
