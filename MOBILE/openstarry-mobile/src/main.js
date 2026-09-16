import './style.css'
import { loadConfig, saveConfig, clearConfig, conversations, messages, providers, preferences, savePreferences, synchronize, putRecords, apiKey, pendingCount, meta } from './syncClient.js'
import { newConversation, sendMessage, parseExtra } from './chatSession.js'
import { fetchModels, normalizeEndpoint } from './chatClient.js'
const root = document.querySelector('#app')
const el = (tag, cls = '', text = '') => { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node }
const button = (text, run, cls = '') => { const node = el('button', cls, text); node.type = 'button'; node.onclick = () => Promise.resolve().then(run).catch(showError); return node }
function field(label, value = '', type = 'text') { const wrap = el('label', 'field-label', label); const input = el('input', 'field'); input.type = type; input.value = value; input.setAttribute('aria-label', label); wrap.append(input); return { wrap, input } }
function area(label, value = '') { const wrap = el('label', 'field-label', label); const input = el('textarea', 'field'); input.value = value; input.rows = 4; input.setAttribute('aria-label', label); wrap.append(input); return { wrap, input } }
let currentId = '', providerList = [], prefs = {}, controller = null, syncing = false
const drafts = new Map()
const shell = el('main', 'app-shell')
const sidebar = el('aside', 'history-pane')
sidebar.setAttribute('aria-label', '聊天记录')
const historyList = el('nav', 'history-list')
const search = field('搜索聊天')
search.input.oninput = () => refreshHistory()
sidebar.append(el('h2', '', '你的聊天'), button('＋ 新的聊天', createChat, 'primary'), search.wrap, historyList)
const screen = el('section', 'chat-screen')
const header = el('header', 'topbar')
const heading = el('h1', '', 'OpenStarry')
const status = el('div', 'sync-status', '记录保存在本机')
status.setAttribute('role', 'status')
const title = el('div', 'title-block'); title.append(heading, status)
header.append(button('☰', () => { shell.classList.toggle('history-open') }, 'icon-button history-toggle'), title,
  button('同步', () => syncNow(false), 'quiet'), button('设置', showSettings, 'quiet'))
const messageList = el('div', 'messages'); messageList.setAttribute('aria-label', '消息列表')
const welcome = el('div', 'welcome')
welcome.append(el('img', 'welcome-logo'), el('h2', '', '从一个想法开始'), el('p', '', '选择模型，随时接着电脑上的对话聊。'))
welcome.firstChild.src = '/OpenStarry.png'; welcome.firstChild.alt = ''
const composer = el('form', 'composer')
const modelSelect = el('select', 'model-select'); modelSelect.setAttribute('aria-label', '聊天模型')
const input = el('textarea', 'chat-input'); input.placeholder = '写下你的想法…'; input.setAttribute('aria-label', '消息'); input.rows = 2
input.oninput = () => { drafts.set(currentId, input.value); input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px' }
input.onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); submit() } }
const sendButton = button('发送 ↑', () => controller ? controller.abort() : submit(), 'primary')
const composerBar = el('div', 'composer-bar'); composerBar.append(modelSelect, sendButton)
composer.append(input, composerBar, el('small', 'composer-note', '聊天保存在本机 · 连接同步后与电脑互通'))
composer.onsubmit = event => { event.preventDefault(); submit() }
screen.append(header, messageList, composer)
const backdrop = button('', () => shell.classList.remove('history-open'), 'history-backdrop'); backdrop.setAttribute('aria-label', '关闭聊天列表')
shell.append(sidebar, backdrop, screen)
const toast = el('div', 'toast'); toast.setAttribute('role', 'status')
root.replaceChildren(shell, toast)
let toastTimer
function showError(error) { notify(error?.message || String(error)) }
function notify(text) { toast.textContent = text; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 5500) }
async function refreshModels() {
  providerList = await providers(); prefs = await preferences()
  document.documentElement.dataset.theme = prefs.dark_theme === false ? 'light' : 'dark'
  modelSelect.replaceChildren()
  for (const provider of providerList) {
    const group = el('optgroup'); group.label = provider.provider_name
    for (const model of provider.model_list || []) { const option = el('option', '', model); option.value = JSON.stringify([provider.provider_id, model]); group.append(option) }
    modelSelect.append(group)
  }
  const selected = JSON.stringify([prefs.modelProvider === 'custom' ? prefs.activeProvider?.provider_id : 'builtin:' + prefs.modelProvider, prefs.modelName])
  if ([...modelSelect.options].some(option => option.value === selected)) modelSelect.value = selected
  if (!modelSelect.options.length) { const option = el('option', '', '先添加供应商与模型'); option.value = ''; modelSelect.append(option) }
}
modelSelect.onchange = async () => {
  if (!modelSelect.value) return
  const [id, model] = JSON.parse(modelSelect.value)
  const builtin = providerList.find(item => item.provider_id === id)?.is_builtin
  await savePreferences({ modelProvider: builtin ? id.slice('builtin:'.length) : 'custom', modelName: model,
    ...(!builtin ? { activeProvider: { provider_id: id, name: providerList.find(item => item.provider_id === id).provider_name } } : {}) })
}
async function refreshHistory() {
  const list = await conversations(search.input.value)
  historyList.replaceChildren(...list.map(item => {
    const node = button(item.title || '新的聊天', () => selectChat(item.conversation_uid), 'history-item' + (currentId === item.conversation_uid ? ' selected' : ''))
    node.title = item.title || ''; return node
  }))
  if (!list.length) historyList.append(el('p', 'muted', '还没有聊天，点上方开始。'))
  const current = list.find(item => item.conversation_uid === currentId)
  heading.textContent = current?.title || 'OpenStarry'
}
async function selectChat(id) {
  drafts.set(currentId, input.value); currentId = id; input.value = drafts.get(id) || ''
  shell.classList.remove('history-open')
  await refreshHistory(); await renderMessages(true)
}
async function createChat() {
  if (controller) return notify('请先停止当前回答，再新建聊天')
  const value = await newConversation(); await selectChat(value.conversation_uid); input.focus()
}
function messageNode(item) {
  const article = el('article', 'message ' + (item.role === 'human' ? 'human' : 'assistant'))
  article.dataset.messageId = item.sync_id
  const metaInfo = el('div', 'message-meta', item.role === 'human' ? '你' : 'OpenStarry')
  const body = el('div', 'message-content', item.content || (parseExtra(item).status === 'generating' ? '正在回复…' : ''))
  if (item.think) { const details = el('details', 'reasoning'); details.append(el('summary', '', '思考过程'), el('div', '', item.think)); article.append(details) }
  article.append(metaInfo, body)
  const extra = parseExtra(item)
  if (extra.status === 'generating' && !controller) article.append(el('p', 'message-note', '上次生成已中断，已保留收到的内容。'), button('重新回答', () => submit(true), 'quiet'))
  if (['error', 'stopped'].includes(extra.status)) article.append(el('p', 'message-note', extra.error || '生成中断'), button('重试最近一条消息', () => submit(true), 'quiet'))
  return article
}
let renderedConversation = ''
const messageSnapshots = new WeakMap()
async function renderMessages(toBottom = false) {
  const id = currentId
  const list = id ? await messages(id) : []
  if (id !== currentId) return
  const nearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 100
  const sameConversation = renderedConversation === id
  const existing = new Map([...messageList.querySelectorAll('[data-message-id]')].map(node => [node.dataset.messageId, node]))
  const visible = list.filter(item => ['human', 'ai', 'info'].includes(item.role))
  const nodes = visible.map(item => {
    const previous = sameConversation ? existing.get(item.sync_id) : undefined
    const snapshot = JSON.stringify(item)
    if (previous && messageSnapshots.get(previous) === snapshot) return previous
    const node = messageNode(item)
    messageSnapshots.set(node, snapshot)
    if (previous?.querySelector('details')?.open && node.querySelector('details')) node.querySelector('details').open = true
    if (sameConversation && !previous) {
      node.classList.add('message-new')
      node.addEventListener('animationend', () => node.classList.remove('message-new'), { once: true })
    }
    return node
  })
  if (!nodes.length) nodes.push(welcome)
  const keep = new Set(nodes)
  for (const child of [...messageList.children]) if (!keep.has(child)) child.remove()
  nodes.forEach((node, index) => { if (messageList.children[index] !== node) messageList.insertBefore(node, messageList.children[index] || null) })
  renderedConversation = id
  if (nearBottom || toBottom) messageList.scrollTop = messageList.scrollHeight
}
async function submit(retry = false) {
  if (controller) return
  if (!modelSelect.value) return showSettings()
  if (!retry && !input.value.trim()) return
  const message = input.value
  if (!currentId) { await createChat(); input.value = message }
  const [id, model] = JSON.parse(modelSelect.value)
  const provider = providerList.find(item => item.provider_id === id)
  const conversationId = currentId
  let draftCleared = false
  controller = new AbortController(); sendButton.textContent = '停止'; modelSelect.disabled = true
  try {
    await sendMessage({ conversationId, text: message, provider, model, prefs, signal: controller.signal, retry,
      onChange: async (answer, persisted) => {
        if (conversationId !== currentId) return
        if (persisted) { if (!retry && !draftCleared) { if (input.value === message) input.value = ''; drafts.delete(conversationId); draftCleared = true }; await renderMessages(true); await refreshHistory() }
        else {
          const article = [...messageList.querySelectorAll('[data-message-id]')].find(node => node.dataset.messageId === answer.sync_id)
          if (article) { const near = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 100; article.querySelector('.message-content').textContent = answer.content || '正在思考…'; if (near) messageList.scrollTop = messageList.scrollHeight }
        }
      }
    })
  } catch (error) { if (!controller.signal.aborted) showError(error) }
  finally { controller = null; sendButton.textContent = '发送 ↑'; modelSelect.disabled = false; await renderMessages(); syncNow(true).catch(() => {}) }
}
async function syncNow(quiet = false) {
  if (syncing || controller) { if (!quiet) notify('当前任务完成后继续同步'); return }
  if (!loadConfig()?.token) { if (!quiet) showSettings(); return }
  syncing = true; status.textContent = '正在同步…'
  try {
    const result = await synchronize(); status.textContent = `已同步 · 上传 ${result.uploaded} / 接收 ${result.received}`
    await refreshModels(); await refreshHistory(); await renderMessages()
  } catch (error) { status.textContent = `离线保留 · 待同步 ${await pendingCount()} 项`; if (!quiet) showError(error) }
  finally { syncing = false }
}
function modal(title) {
  const dialog = el('dialog', 'settings-dialog'); const top = el('header', 'dialog-header'); top.append(el('h2', '', title), button('关闭', () => dialog.close(), 'quiet')); dialog.append(top)
  const close = dialog.close.bind(dialog)
  let closing = false
  dialog.close = async () => {
    if (closing) return
    closing = true
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await dialog.animate([{ opacity: 1, transform: 'translateY(0) scale(1)' }, { opacity: 0, transform: 'translateY(8px) scale(.985)' }], { duration: 140, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {})
    }
    close()
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close() })
  dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal(); return dialog
}
async function editProvider(provider, afterSave) {
  const dialog = modal(provider ? '编辑供应商与模型' : '添加供应商')
  const name = field('供应商名称', provider?.provider_name || '')
  const endpoint = field('OpenAI 兼容接口地址', provider?.endpoint || 'https://api.openai.com/v1', 'url')
  const key = field('API 密钥（仅本设备）', provider ? apiKey(provider.provider_id) : '', 'password'); key.input.autocomplete = 'off'
  const models = area('模型 ID（每行一个）', (provider?.model_list || []).join('\n'))
  const error = el('p', 'form-error'); error.setAttribute('role', 'alert')
  const getModels = button('获取并合并模型列表', async () => {
    getModels.disabled = true; error.textContent = '正在获取…'
    try { const ids = await fetchModels({ endpoint: endpoint.input.value }, key.input.value); models.input.value = [...new Set([...models.input.value.split('\n').filter(Boolean), ...ids])].join('\n'); error.textContent = `已获取 ${ids.length} 个模型` }
    catch (err) { error.textContent = err.message + '；也可手动填写' }
    finally { getModels.disabled = false }
  }, 'quiet')
  const save = button('保存供应商', async () => {
    try {
      const list = [...new Set(models.input.value.split(/[\n,，]+/).map(item => item.trim()).filter(Boolean))]
      if (!name.input.value.trim() || !list.length) throw Error('请填写名称和至少一个模型 ID')
      const value = { provider_id: provider?.provider_id || crypto.randomUUID(), provider_name: name.input.value.trim(), type: 'openai', endpoint: normalizeEndpoint(endpoint.input.value), model_list: list, description: provider?.description || '', created_at: provider?.created_at || new Date().toISOString(), is_deleted: 0 }
      await putRecords([{ id: 'provider:' + value.provider_id, kind: 'provider', payload: value }]); apiKey(value.provider_id, key.input.value.trim())
      await savePreferences({ modelProvider: 'custom', activeProvider: { provider_id: value.provider_id, name: value.provider_name }, modelName: list.includes(prefs.modelName) ? prefs.modelName : list[0] })
      await refreshModels(); await afterSave?.(); dialog.close(); notify('供应商与模型已保存')
    } catch (err) { error.textContent = err.message }
  }, 'primary')
  dialog.append(name.wrap, endpoint.wrap, key.wrap, models.wrap, getModels, error, save)
}
async function showSettings() {
  const dialog = modal('设置')
  const providerSection = el('section', 'settings-section'); providerSection.append(el('h3', '', '供应商与模型'))
  const list = el('div', 'provider-list')
  async function refresh() { list.replaceChildren(...(await providers()).map(provider => button(provider.provider_name + ' · ' + provider.model_list.length + ' 个模型　编辑 ›', () => editProvider(provider, refresh), 'provider-item'))) }
  await refresh(); providerSection.append(list, button('＋ 添加供应商', () => editProvider(null, refresh), 'quiet'))
  const general = el('section', 'settings-section'); general.append(el('h3', '', '通用聊天偏好'))
  const temp = field('温度（0–2）', String(Number(prefs.modelTemp ?? 50) * .02), 'number'); temp.input.min = 0; temp.input.max = 2; temp.input.step = .1
  const prompt = area('角色提示词', prefs.rolePrompt?.definition || '')
  const dark = field('深色外观', '', 'checkbox'); dark.input.checked = prefs.dark_theme !== false
  general.append(temp.wrap, prompt.wrap, dark.wrap, button('保存通用偏好', async () => {
    const value = Number(temp.input.value); if (!Number.isFinite(value) || value < 0 || value > 2) throw Error('温度范围为 0–2')
    await savePreferences({ modelTemp: value * 50, rolePrompt: { name: prefs.rolePrompt?.name || '自定义', definition: prompt.input.value }, dark_theme: dark.input.checked }); await refreshModels(); notify('偏好已保存，会随同步更新到电脑')
  }, 'quiet'))
  const syncSection = el('section', 'settings-section'); syncSection.append(el('h3', '', '手机与电脑同步'), el('p', 'muted', '同步聊天和通用配置。API 密钥各设备单独保存。'))
  const config = loadConfig()
  const server = field('同步服务器', config?.serverUrl || 'https://openstarry.154-219-110-177.sslip.io', 'url')
  const user = field('用户 ID', config?.userId || 'tomysh')
  const token = field('访问令牌', config?.token || '', 'password'); token.input.autocomplete = 'off'
  const syncHint = el('p', 'muted'); const last = await meta('lastSync'); syncHint.textContent = last ? '上次同步：' + new Date(last).toLocaleString() : '尚未同步，本地聊天可独立使用'
  const connect = button('保存并同步', async () => {
    if (controller || syncing) throw Error('请等当前任务结束后修改同步账号')
    connect.disabled = true
    try { await saveConfig({ serverUrl: server.input.value, userId: user.input.value, token: token.input.value }); await syncNow(); syncHint.textContent = status.textContent }
    finally { connect.disabled = false }
  }, 'primary')
  syncSection.append(server.wrap, user.wrap, token.wrap, syncHint, connect, button('断开同步并保留本地数据', () => { if (syncing) throw Error('正在同步，请稍后断开'); clearConfig(); token.input.value = ''; status.textContent = '同步已断开 · 数据保留在本机'; notify('本机聊天和供应商配置已保留') }, 'quiet'))
  dialog.append(providerSection, general, syncSection, el('p', 'muted', 'OpenStarry NextGen · tomysh · 1.2.0'))
}
await refreshModels(); await refreshHistory(); await renderMessages()
window.addEventListener('online', () => syncNow(true))
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(true) })
setInterval(() => { if (!document.hidden) syncNow(true) }, 60000)
syncNow(true)
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => {})
