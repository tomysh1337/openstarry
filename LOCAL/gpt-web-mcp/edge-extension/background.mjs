import { parsePairingCode, isChatGPT, executeOnce } from './protocol.mjs'

const storageReady = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
])
let polling = false, generation = 0, activeUntil = 0
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const status = text => chrome.storage.session.set({ status: text })
const saveCommandError = commandError => chrome.storage.session.set({ commandError })
const errorValue = error => ({ code: /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'EXTENSION_ERROR', message: String(error.message).slice(0, 2000) })

async function api(connection, route, value) {
  const response = await fetch(connection.origin + route, {
    method: 'POST', headers: { authorization: 'Bearer ' + connection.token, 'content-type': 'application/json' },
    body: JSON.stringify({ ...value, clientId: connection.clientId }), signal: AbortSignal.timeout(8000),
    redirect: 'error', credentials: 'omit', cache: 'no-store'
  })
  if (!response.ok) throw Error(response.status === 401 ? '配对码已失效，请从应用重新复制' : response.status === 409 ? '另一个 Edge 实例已连接，或操作已过期' : '本机服务响应异常：' + response.status)
  return response.json()
}

async function pageMessage(tabId, message) {
  const tab = await chrome.tabs.get(tabId)
  if (!isChatGPT(tab.url)) throw Object.assign(Error('扩展关联的标签页已离开 ChatGPT'), { code: 'SESSION_CHANGED' })
  const response = await chrome.tabs.sendMessage(tabId, { type: 'openstarry-page', ...message })
  if (!response) throw Error('ChatGPT 页面仍在加载，请稍后刷新连接')
  if (response.contentVersion !== 3) throw Object.assign(Error('扩展已更新，请刷新此 ChatGPT 标签页后重试'), { code: 'EXTENSION_RELOAD_REQUIRED' })
  if (response.error) throw Object.assign(Error(response.error.message), { code: response.error.code })
  return response.result
}

async function loginState() {
  const { lastTab } = await chrome.storage.session.get('lastTab')
  if (!Number.isInteger(lastTab)) return 'unknown'
  try {
    const value = await pageMessage(lastTab, { method: 'inspect', consumeUpdates: false })
    return value.challenge ? 'challenge' : value.login ? 'required' : value.input ? 'ready' : 'unknown'
  } catch { return 'unknown' }
}

async function execute(command, connection, epoch) {
  if (epoch !== generation) throw Error('浏览器连接已改变，请重新发送')
  const { pages = {} } = await chrome.storage.session.get('pages')
  const key = connection.origin + '/' + command.args.key
  let tabId = pages[key]
  if (command.method === 'page') {
    const existing = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null
    if (!existing) {
      if (epoch !== generation || Date.now() >= command.expiresAt) throw Error('浏览器操作已过期')
      const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/' + (command.args.webConversationId ? 'c/' + command.args.webConversationId : ''), active: true })
      tabId = tab.id; pages[key] = tabId
      await chrome.storage.session.set({ pages, lastTab: tabId })
    } else if (!isChatGPT(existing.url)) throw Object.assign(Error('该会话标签页已离开 ChatGPT，请新建应用会话'), { code: 'SESSION_CHANGED' })
    await chrome.storage.session.set({ lastTab: tabId })
    while (Date.now() < command.expiresAt - 500 && epoch === generation) {
      try {
        const state = await pageMessage(tabId, { method: 'inspect' })
        if (state.input || state.login || state.challenge) return true
      } catch (error) { if (error.code === 'EXTENSION_RELOAD_REQUIRED') throw error }
      await pause(300)
    }
    throw Error('ChatGPT 标签页加载超时，请在普通 Edge 查看页面')
  }
  if (!Number.isInteger(tabId)) throw Object.assign(Error('网页会话标签页已关闭，请恢复会话后再试'), { code: 'PAGE_CLOSED' })
  if (epoch !== generation || Date.now() >= command.expiresAt) throw Error('浏览器操作已过期')
  await chrome.storage.session.set({ lastTab: tabId })
  const result = await pageMessage(tabId, { method: command.method, ...command.args, expiresAt: command.expiresAt })
  if (command.method === 'download') await chrome.tabs.update(tabId, { active: true })
  return result
}

async function poll() {
  if (polling) return
  polling = true
  const epoch = generation
  try {
    await storageReady
    while (epoch === generation) {
      const { connection } = await chrome.storage.local.get('connection')
      if (!connection) return
      try {
        const login = await loginState()
        const { command } = await api(connection, '/poll', { login })
        if (epoch !== generation) return
        const { commandError } = await chrome.storage.session.get('commandError')
        await status(commandError || (login === 'ready' ? '已连接 · ChatGPT 已就绪' : login === 'challenge' ? '已连接 · 请在 ChatGPT 标签页查看验证' : login === 'required' ? '已连接 · 请在 ChatGPT 标签页登录' : '已连接 · 等待 ChatGPT 页面就绪'))
        if (command) {
          activeUntil = Date.now() + 10000
          // Keep pairing alive while a slow page/send holds the serial command lane.
          let heartbeatBusy = false
          const heartbeat = setInterval(() => {
            if (heartbeatBusy || epoch !== generation) return
            heartbeatBusy = true
            void api(connection, '/poll', { login }).catch(() => {}).finally(() => { heartbeatBusy = false })
          }, 2000)
          let response
          try {
            const result = await executeOnce(command, {
              load: async () => (await chrome.storage.local.get('sendJournal')).sendJournal || {},
              save: sendJournal => chrome.storage.local.set({ sendJournal }),
              execute: value => execute(value, connection, epoch)
            })
            if (['send', 'download'].includes(command.method)) await saveCommandError('')
            response = { id: command.id, result }
          } catch (error) { await saveCommandError(errorValue(error).message); await status(errorValue(error).message); response = { id: command.id, error: errorValue(error) } }
          finally { clearInterval(heartbeat) }
          await api(connection, '/result', response)
          await pause(20)
          continue
        }
      } catch (error) {
        if (epoch !== generation) return
        await status(error.message === 'Failed to fetch' ? '应用未连接，请保持 OpenStarry 运行并刷新连接' : String(error.message).slice(0, 300))
      }
      await pause(Date.now() < activeUntil ? 100 : 750)
    }
  } finally {
    polling = false
    // A popup may replace the connection while the old request is completing.
    if (epoch !== generation) void poll()
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false
  const handle = async () => {
    await storageReady
    if (message?.type === 'connect') {
      const value = parsePairingCode(message.code)
      const { clientId: saved } = await chrome.storage.local.get('clientId')
      const clientId = saved || crypto.randomUUID()
      const connection = { ...value, clientId }
      await api(connection, '/poll', { login: 'unknown' })
      generation++; await saveCommandError('')
      await chrome.storage.local.set({ connection, clientId })
      const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true })
      await chrome.storage.session.set({ lastTab: tab.id, status: '已配对，请在 ChatGPT 标签页确认登录' })
      void poll()
      return { ok: true }
    }
    if (message?.type === 'disconnect') {
      generation++
      await chrome.storage.local.remove('connection')
      await chrome.storage.session.set({ status: '已断开；ChatGPT 标签页和聊天记录保留' })
      return { ok: true }
    }
    throw Error('未知操作')
  }
  void handle().then(respond, error => respond({ error: errorValue(error) }))
  return true
})
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'openstarry-poll') void poll() })
chrome.runtime.onStartup.addListener(() => { void poll() })
chrome.alarms.create('openstarry-poll', { periodInMinutes: 0.5 })
void poll()
