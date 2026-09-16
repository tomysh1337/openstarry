import { timeoutSignal } from './signals.js'
const CONFIG_KEY = 'openstarry.mobile.config'
const BASE_DB = 'openstarry-mobile'
let activeSync = null
let lastTime = 0
const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
export function loadConfig() { try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null') } catch { return null } }
export function databaseName(config = loadConfig()) { return config?.database || BASE_DB }
async function openDatabase(name) {
  const req = indexedDB.open(name, 2)
  req.onupgradeneeded = () => {
    for (const store of ['records', 'queue', 'meta']) if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store, { keyPath: store === 'meta' ? 'key' : 'id' })
  }
  return request(req)
}
async function transaction(stores, mode, action, name = databaseName()) {
  const db = await openDatabase(name)
  try {
    const tx = db.transaction(stores, mode)
    const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || Error('本地保存中断')); tx.onerror = () => reject(tx.error) })
    try {
      const result = await action(Object.fromEntries(stores.map(key => [key, tx.objectStore(key)])))
      await done
      return result
    } catch (error) {
      try { tx.abort() } catch {}
      await done.catch(() => {})
      throw error
    }
  } finally { db.close() }
}
export async function allRecords(name = databaseName()) { return transaction(['records'], 'readonly', s => request(s.records.getAll()), name) }
export async function meta(key, value, name = databaseName()) {
  return transaction(['meta'], value === undefined ? 'readonly' : 'readwrite', async s => {
    if (value !== undefined) s.meta.put({ key, value })
    return (await request(s.meta.get(key)))?.value
  }, name)
}
export function validateConfig(config) {
  const url = new URL(config.serverUrl.trim())
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error('同步服务器请使用 HTTPS')
  if (url.username || url.password || url.search || url.hash) throw Error('请填写不含凭据及参数的同步地址')
  if (!config.userId.trim() || !config.token.trim()) throw Error('请填写用户 ID 和访问令牌')
  return { serverUrl: url.href.replace(/\/+$/, ''), userId: config.userId.trim(), token: config.token.trim() }
}
export async function saveConfig(value) {
  const previous = loadConfig()
  const config = validateConfig(value)
  config.database = BASE_DB + ':' + encodeURIComponent(config.serverUrl + '/' + config.userId)
  const sameAccount = previous && previous.serverUrl === config.serverUrl && previous.userId === config.userId
  if ((!previous || sameAccount) && databaseName(previous) !== config.database) {
    const records = await allRecords(databaseName(previous))
    const queue = await transaction(['queue'], 'readonly', s => request(s.queue.getAll()), databaseName(previous))
    await transaction(['records', 'queue'], 'readwrite', s => {
      records.forEach(record => s.records.put(record)); queue.forEach(op => s.queue.put(op))
    }, config.database)
    const oldKeys = localStorage.getItem('openstarry.mobile.keys.' + databaseName(previous))
    if (oldKeys) localStorage.setItem('openstarry.mobile.keys.' + config.database, oldKeys)
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
  return config
}
// Disconnect removes only the access token; the account cache and API keys remain on this device.
export function clearConfig() { const value = loadConfig(); if (value) localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...value, token: '' })) }
export async function clearRecords() { await transaction(['records', 'queue', 'meta'], 'readwrite', s => { Object.values(s).forEach(store => store.clear()) }) }
export async function putRecords(records, name = databaseName()) {
  const deviceId = await meta('deviceId', undefined, name) || crypto.randomUUID()
  const offset = await meta('clockOffset', undefined, name) || 0
  lastTime = Math.max(lastTime + 1, Date.now() + offset)
  const now = lastTime
  await transaction(['records', 'queue', 'meta'], 'readwrite', s => {
    s.meta.put({ key: 'deviceId', value: deviceId })
    for (const value of records) {
      const record = { id: value.id, kind: value.kind, deleted: Boolean(value.deleted), payload: value.payload }
      s.records.put({ ...record, modifiedAt: now, deviceId })
      s.queue.put({ id: record.id, opId: crypto.randomUUID(), modifiedAt: now, deviceId, record })
    }
  }, name)
}
export async function pendingCount() { return transaction(['queue'], 'readonly', s => request(s.queue.count())) }
export function synchronize(config = loadConfig(), forceFull = false) {
  if (activeSync) return activeSync
  activeSync = runSync(config, forceFull).finally(() => { activeSync = null })
  return activeSync
}
async function runSync(config, forceFull) {
  if (!config?.token) throw Error('本地记录已保留，请在设置中连接同步服务器')
  validateConfig(config)
  const name = databaseName(config)
  let cursor = forceFull ? 0 : await meta('cursor', undefined, name) || 0
  let received = 0, uploaded = 0, more = true
  for (let page = 0; page < 200; page++) {
    const outgoing = (await transaction(['queue'], 'readonly', s => request(s.queue.getAll()), name)).slice(0, 500)
    if (!more && !outgoing.length) break
    const response = await fetch(config.serverUrl + '/v1/sync', {
      method: 'POST', signal: timeoutSignal(30000),
      headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json', 'X-OpenStarry-User': config.userId },
      body: JSON.stringify({ protocolVersion: 1, userId: config.userId, cursor, limit: 500, operations: outgoing.map(({ id, ...operation }) => operation) })
    })
    const data = await response.json().catch(() => { throw Error('同步响应格式错误，本地队列已保留') })
    if (!response.ok) throw Error('同步失败：HTTP ' + response.status)
    if (!Number.isSafeInteger(data.cursor) || data.cursor < 0 || (data.hasMore && data.cursor <= cursor) || !Array.isArray(data.records) || !Array.isArray(data.acknowledgedIds)) throw Error('同步响应不完整，本地队列已保留')
    const sent = new Map(outgoing.map(op => [op.opId, op]))
    const ack = new Set(data.acknowledgedIds.filter(id => sent.has(id)))
    if (outgoing.length && !ack.size) throw Error('服务器未确认写入，请更新同步服务')
    await transaction(['records', 'queue', 'meta'], 'readwrite', async s => {
      for (const id of ack) {
        const op = sent.get(id)
        const current = await request(s.queue.get(op.id))
        if (current?.opId === id) s.queue.delete(op.id)
      }
      for (const record of data.records) {
        if (!record.id || !record.payload) throw Error('同步记录格式错误')
        const pending = await request(s.queue.get(record.id))
        // A local edit made while this request was in flight belongs to the next request.
        if (!pending) s.records.put(record)
      }
      s.meta.put({ key: 'cursor', value: data.cursor })
      if (Number.isFinite(data.serverTime)) s.meta.put({ key: 'clockOffset', value: data.serverTime - Date.now() })
    }, name)
    cursor = data.cursor; more = Boolean(data.hasMore)
    uploaded += ack.size; received += data.records.length
    if (page === 199 && more) throw Error('记录较多，请继续同步；已接收内容已保存')
  }
  await meta('lastSync', new Date().toISOString(), name)
  return { received, uploaded }
}
export async function conversations(query = '') {
  return (await allRecords()).filter(r => r.kind === 'conversation' && !r.deleted).map(r => r.payload)
    .filter(r => !query || String(r.title || '').toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => String(b.last_active_at || '').localeCompare(String(a.last_active_at || '')))
}
export async function messages(id) {
  return (await allRecords()).filter(r => r.kind === 'message' && !r.deleted && r.payload.conversation_uid === id).map(r => r.payload)
    .sort((a, b) => Number(a.msg_timestamp || 0) - Number(b.msg_timestamp || 0) || Number(a.msg_cursor || 0) - Number(b.msg_cursor || 0) || String(a.sync_id).localeCompare(String(b.sync_id)))
}
const presets = {
  openai: ['OpenAI', 'https://api.openai.com/v1'], deepseek: ['DeepSeek', 'https://api.deepseek.com/v1'],
  ollama: ['Ollama', 'http://localhost:11434/v1'], moonshot: ['Moonshot', 'https://api.moonshot.cn/v1'],
  qwen: ['Qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1'], google: ['Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai']
}
export async function providers() {
  const records = await allRecords()
  const list = records.filter(r => r.kind === 'provider' && !r.deleted).map(r => r.payload)
  const prefs = Object.fromEntries(records.filter(r => r.kind === 'preference' && !r.deleted).map(r => [r.payload.key, r.payload.value]))
  const builtin = presets[prefs.modelProvider]
  if (builtin && prefs.modelName && !list.some(p => p.provider_id === 'builtin:' + prefs.modelProvider)) list.push({ provider_id: 'builtin:' + prefs.modelProvider, provider_name: builtin[0], is_builtin: true, endpoint: builtin[1], type: 'openai', model_list: [prefs.modelName], description: '', is_deleted: 0 })
  return list
}
export async function preferences() { return Object.fromEntries((await allRecords()).filter(r => r.kind === 'preference' && !r.deleted).map(r => [r.payload.key, r.payload.value])) }
export async function savePreferences(values) {
  const allowed = ['dark_theme', 'modelTemp', 'modelName', 'modelProvider', 'activeProvider', 'rolePrompt', 'deepThink']
  await putRecords(Object.entries(values).filter(([key]) => allowed.includes(key)).map(([key, value]) => ({ id: 'preference:' + key, kind: 'preference', payload: { key, value: key === 'activeProvider' ? { provider_id: value?.provider_id || '', name: value?.name || '' } : key === 'rolePrompt' ? { name: value?.name || '', definition: value?.definition || '' } : value } })))
}
export function apiKey(providerId, value) {
  const key = 'openstarry.mobile.keys.' + databaseName()
  let keys; try { keys = JSON.parse(localStorage.getItem(key) || '{}') } catch { keys = {} }
  if (value !== undefined) { keys[providerId] = value; localStorage.setItem(key, JSON.stringify(keys)) }
  return keys[providerId] || ''
}
