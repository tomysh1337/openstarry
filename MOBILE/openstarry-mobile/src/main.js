import './style.css'
import '@openstarry/workbench/style.css'
import { mountToolSettings } from '@openstarry/workbench/settings'
import { loadConfig, saveConfig, clearConfig, conversations, messages, providers, preferences, savePreferences, synchronize, putRecords, apiKey, pendingCount, meta } from './syncClient.js'
import { newConversation, sendMessage, parseExtra } from './chatSession.js'
import { fetchModels, normalizeEndpoint } from './chatClient.js'
import { icon } from './icons.js'
import { version } from '../package.json'
const root = document.querySelector('#app')
const el = (tag, cls = '', text = '') => { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node }
const button = (text, run, cls = '') => { const node = el('button', cls, text); node.type = 'button'; node.onclick = () => Promise.resolve().then(run).catch(showError); return node }
function iconButton(label, name, run, cls = '') { const node = button('', run, 'icon-button ' + cls); node.append(icon(name)); node.setAttribute('aria-label', label); node.title = label; return node }
function labeledButton(label, name, run, cls = '') { const node = button('', run, cls); node.append(icon(name), el('span', '', label)); return node }
function field(label, value = '', type = 'text') { const wrap = el('label', 'field-label', label); const input = el('input', 'field'); input.type = type; input.value = value; input.setAttribute('aria-label', label); wrap.append(input); return { wrap, input } }
function area(label, value = '') { const wrap = el('label', 'field-label', label); const input = el('textarea', 'field'); input.value = value; input.rows = 4; input.setAttribute('aria-label', label); wrap.append(input); return { wrap, input } }
let currentId = '', providerList = [], prefs = {}, controller = null, syncing = false, currentView = 'chat', currentTitle = 'OpenStarry NextGen'
const drafts = new Map()
const shell = el('main', 'app-shell')
const sidebar = el('aside', 'history-pane')
sidebar.setAttribute('aria-label', '聊天记录')
const historyList = el('nav', 'history-list')
const search = field('搜索聊天')
search.input.placeholder = '搜索聊天记录'
search.input.oninput = () => refreshHistory()
const sidebarHeader = el('div', 'sidebar-header'); sidebarHeader.append(el('h2', '', '聊天记录'), iconButton('关闭聊天记录', 'close', () => setHistoryOpen(false), 'history-close'))
sidebar.append(sidebarHeader, labeledButton('新的聊天', 'plus', createChat, 'primary new-chat'), search.wrap, historyList, el('p', 'sidebar-note', '记录保留在本机，随时接着聊。'))
const screen = el('section', 'workspace')
const header = el('header', 'topbar')
const heading = el('h1', '', 'OpenStarry NextGen')
const status = el('div', 'sync-status', '记录保存在本机')
status.setAttribute('role', 'status')
const title = el('div', 'title-block'); title.append(heading, status)
const historyToggle = iconButton('打开聊天记录', 'history', () => setHistoryOpen(true), 'history-toggle')
historyToggle.setAttribute('aria-expanded', 'false')
header.append(historyToggle, title, iconButton('同步', 'sync', () => syncNow(false), 'sync-button'), iconButton('新的聊天', 'plus', createChat))
const chatView = el('section', 'chat-screen view-panel'); chatView.setAttribute('aria-label', '聊天')
const providersView = el('section', 'content-page view-panel'); providersView.setAttribute('aria-label', '供应商'); providersView.hidden = true
const settingsView = el('section', 'content-page view-panel'); settingsView.setAttribute('aria-label', '设置'); settingsView.hidden = true
const ideView = el('section', 'ide-page view-panel'); ideView.setAttribute('aria-label', 'IDE'); ideView.hidden = true
let workbench = null
async function showIde() {
  showView('ide')
  if (!workbench) {
    const [{ mountWorkbench }, { mobileRequest, exportMobileFile }] = await Promise.all([import('@openstarry/workbench'), import('./agentAdapter.js')])
    workbench = await mountWorkbench(ideView, { theme: prefs.dark_theme ? 'dark' : 'light', notify, request: mobileRequest, exportFile: exportMobileFile,
      configureProvider: ({ parent } = {}) => {
        const id = modelSelect.value ? JSON.parse(modelSelect.value)[0] : ''
        return editProvider(providerList.find(provider => provider.provider_id === id), async () => { await refreshModels(); workbench?.refresh?.() }, parent || document.body)
      },
      getModel: async () => { await refreshModels(); if (!modelSelect.value) return {}; const [id, model] = JSON.parse(modelSelect.value); return { endpoint: providerList.find(item => item.provider_id === id)?.endpoint, key: apiKey(id), model, temperature: Number(prefs.modelTemp ?? 50) * .02, rolePrompt: prefs.rolePrompt?.definition || '' } },
      getModels: () => [...modelSelect.options].filter(option => option.value).map(option => ({ value: option.value, label: option.textContent, selected: option.selected })),
      selectModel: async value => { modelSelect.value = value; await modelSelect.onchange() }
    })
  } else workbench.refresh()
}
const messageList = el('div', 'messages'); messageList.setAttribute('aria-label', '消息列表')
const welcome = el('div', 'welcome')
welcome.append(el('img', 'welcome-logo'), el('span', 'eyebrow', 'OPENSTARRY NEXTGEN'), el('h2', '', '这次想聊点什么？'), el('p', '', '从一个想法开始，\n也可以接着电脑上的对话聊。'))
welcome.firstChild.src = '/OpenStarry.png'; welcome.firstChild.alt = ''
const composer = el('form', 'composer')
const modelSelect = el('select', 'model-select'); modelSelect.setAttribute('aria-label', '聊天模型')
const input = el('textarea', 'chat-input'); input.placeholder = '写下你的想法…'; input.setAttribute('aria-label', '消息'); input.rows = 2
function resizeInput() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 144) + 'px' }
input.oninput = () => { drafts.set(currentId, input.value); resizeInput() }
input.onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); submit() } }
const sendButton = iconButton('发送消息', 'arrow', () => controller ? controller.abort() : submit(), 'primary send-button')
function updateSendButton() { sendButton.replaceChildren(icon(controller ? 'stop' : 'arrow')); sendButton.setAttribute('aria-label', controller ? '停止生成' : '发送消息'); sendButton.title = controller ? '停止生成' : '发送消息'; sendButton.classList.toggle('is-generating', Boolean(controller)) }
const providerButton = iconButton('供应商与模型设置', 'settings', () => {
  const id = modelSelect.value ? JSON.parse(modelSelect.value)[0] : ''
  return editProvider(providerList.find(provider => provider.provider_id === id))
}, 'composer-provider')
const modelPicker = el('div', 'model-picker'); modelPicker.append(modelSelect)
const composerBar = el('div', 'composer-bar'); composerBar.append(providerButton, modelPicker, sendButton)
composer.append(input, composerBar)
composer.onsubmit = event => { event.preventDefault(); submit() }
const composerWrap = el('div', 'composer-wrap'); composerWrap.append(composer, el('small', 'composer-note', '聊天保存在本机 · 手机与电脑互通'))
chatView.append(messageList, composerWrap)
const navigation = el('nav', 'bottom-nav'); navigation.setAttribute('aria-label', '主要导航')
const navButtons = new Map()
for (const [id, label, symbol, action] of [['chat', '聊天', 'chat', () => showView('chat')], ['ide', 'IDE', 'code', showIde], ['providers', '供应商', 'provider', showProviders], ['settings', '设置', 'settings', showSettings]]) {
  const node = labeledButton(label, symbol, action, 'nav-item'); node.dataset.view = id
  if (id === currentView) node.setAttribute('aria-current', 'page')
  navButtons.set(id, node); navigation.append(node)
}
screen.append(header, chatView, ideView, providersView, settingsView, navigation)
const backdrop = button('', () => setHistoryOpen(false), 'history-backdrop'); backdrop.setAttribute('aria-label', '关闭聊天列表'); backdrop.tabIndex = -1
shell.append(sidebar, backdrop, screen)
const toast = el('div', 'toast'); toast.setAttribute('role', 'status')
root.replaceChildren(shell, toast)
function setHistoryOpen(open, restoreFocus = true) {
  shell.classList.toggle('history-open', open)
  historyToggle.setAttribute('aria-expanded', String(open))
  const compact = matchMedia('(max-width: 999px)').matches
  sidebar.inert = compact && !open
  screen.inert = compact && open
  if (open) { sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true'); sidebar.querySelector('button').focus() }
  else { sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal'); if (restoreFocus && compact) historyToggle.focus() }
}
function showView(view) {
  currentView = view; setHistoryOpen(false, false)
  shell.classList.toggle('ide-active', view === 'ide')
  heading.textContent = view === 'chat' ? currentTitle : 'OpenStarry NextGen'
  if (document.activeElement?.matches('input, textarea')) document.activeElement.blur()
  for (const [id, panel] of [['chat', chatView], ['ide', ideView], ['providers', providersView], ['settings', settingsView]]) panel.hidden = id !== view
  for (const [id, node] of navButtons) { if (id === view) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current') }
  if (view === 'chat') resizeInput()
}
document.addEventListener('keydown', event => {
  if (!shell.classList.contains('history-open')) return
  if (event.key === 'Escape') { event.preventDefault(); setHistoryOpen(false) }
  if (event.key === 'Tab') {
    const targets = [...sidebar.querySelectorAll('button, input')].filter(node => !node.disabled)
    const first = targets[0], last = targets.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
})
let viewportFrame = 0
function fitViewport() {
  cancelAnimationFrame(viewportFrame)
  viewportFrame = requestAnimationFrame(() => {
    const viewport = window.visualViewport
    const height = viewport?.height || innerHeight
    document.documentElement.style.setProperty('--app-height', `${height}px`)
    document.documentElement.style.setProperty('--viewport-top', `${viewport?.offsetTop || 0}px`)
    shell.classList.toggle('keyboard-open', Boolean(document.activeElement?.matches('input, textarea') && (innerHeight - height > 100 || height < 500)))
    if (shell.classList.contains('history-open') && !matchMedia('(max-width: 999px)').matches) setHistoryOpen(false, false)
    if (!shell.classList.contains('history-open')) sidebar.inert = matchMedia('(max-width: 999px)').matches
  })
}
window.visualViewport?.addEventListener('resize', fitViewport)
window.visualViewport?.addEventListener('scroll', fitViewport)
window.addEventListener('resize', fitViewport)
document.addEventListener('focusin', fitViewport)
document.addEventListener('focusout', fitViewport)
fitViewport()
let toastTimer
function showError(error) { notify(error?.message || String(error)) }
function notify(text) { toast.textContent = text; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 5500) }
async function refreshModels() {
  providerList = await providers(); prefs = await preferences()
  document.documentElement.dataset.theme = prefs.dark_theme === true ? 'dark' : 'light'
  workbench?.setTheme(prefs.dark_theme === true ? 'dark' : 'light')
  document.querySelector('meta[name="theme-color"]').content = prefs.dark_theme === true ? '#202126' : '#f5f5f9'
  modelSelect.replaceChildren()
  for (const provider of providerList) {
    const group = el('optgroup'); group.label = provider.provider_name
    for (const model of provider.model_list || []) { const option = el('option', '', model); option.value = JSON.stringify([provider.provider_id, model]); group.append(option) }
    modelSelect.append(group)
  }
  const selected = JSON.stringify([prefs.modelProvider === 'custom' ? prefs.activeProvider?.provider_id : 'builtin:' + prefs.modelProvider, prefs.modelName])
  if ([...modelSelect.options].some(option => option.value === selected)) modelSelect.value = selected
  if (!modelSelect.options.length) { const option = el('option', '', '先添加供应商与模型'); option.value = ''; modelSelect.append(option) }
  renderProviders()
}
modelSelect.onchange = async () => {
  if (!modelSelect.value) return
  const [id, model] = JSON.parse(modelSelect.value)
  const builtin = providerList.find(item => item.provider_id === id)?.is_builtin
  await savePreferences({ modelProvider: builtin ? id.slice('builtin:'.length) : 'custom', modelName: model,
    ...(!builtin ? { activeProvider: { provider_id: id, name: providerList.find(item => item.provider_id === id).provider_name } } : {}) })
  prefs = await preferences(); renderProviders()
}
async function refreshHistory() {
  const list = await conversations(search.input.value)
  historyList.replaceChildren(...list.map(item => {
    const node = button(item.title || '新的聊天', () => selectChat(item.conversation_uid), 'history-item' + (currentId === item.conversation_uid ? ' selected' : ''))
    node.title = item.title || ''; node.setAttribute('aria-current', currentId === item.conversation_uid ? 'true' : 'false'); return node
  }))
  if (!list.length) historyList.append(el('p', 'muted', '还没有聊天，点上方开始。'))
  const current = list.find(item => item.conversation_uid === currentId)
  currentTitle = current?.title || 'OpenStarry NextGen'
  heading.textContent = currentView === 'chat' ? currentTitle : 'OpenStarry NextGen'
}
async function selectChat(id) {
  drafts.set(currentId, input.value); currentId = id; input.value = drafts.get(id) || ''
  showView('chat'); resizeInput()
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
  if (!modelSelect.value) return showProviders()
  if (!retry && !input.value.trim()) return
  const message = input.value
  if (!currentId) { await createChat(); input.value = message }
  const [id, model] = JSON.parse(modelSelect.value)
  const provider = providerList.find(item => item.provider_id === id)
  const conversationId = currentId
  let draftCleared = false
  controller = new AbortController(); updateSendButton(); modelSelect.disabled = true
  try {
    await sendMessage({ conversationId, text: message, provider, model, prefs, signal: controller.signal, retry,
      onChange: async (answer, persisted) => {
        if (conversationId !== currentId) return
        if (persisted) { if (!retry && !draftCleared) { if (input.value === message) { input.value = ''; resizeInput() }; drafts.delete(conversationId); draftCleared = true }; await renderMessages(!draftCleared || !answer.content); await refreshHistory() }
        else {
          const article = [...messageList.querySelectorAll('[data-message-id]')].find(node => node.dataset.messageId === answer.sync_id)
          if (article) { const near = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 100; article.querySelector('.message-content').textContent = answer.content || '正在思考…'; if (near) messageList.scrollTop = messageList.scrollHeight }
        }
      }
    })
  } catch (error) { if (!controller.signal.aborted) showError(error) }
  finally { controller = null; updateSendButton(); modelSelect.disabled = false; await renderMessages(); syncNow(true).catch(() => {}) }
}
async function syncNow(quiet = false) {
  if (syncing || controller) { if (!quiet) notify('当前任务完成后继续同步'); return }
  if (!loadConfig()?.token) { if (!quiet) showSettings(); return }
  syncing = true; status.textContent = '正在同步…'; header.classList.add('is-syncing')
  try {
    const result = await synchronize(); status.textContent = `已同步 · 上传 ${result.uploaded} / 接收 ${result.received}`
    await refreshModels(); await refreshHistory(); await renderMessages()
  } catch (error) { status.textContent = `离线保留 · 待同步 ${await pendingCount()} 项`; if (!quiet) showError(error) }
  finally { syncing = false; header.classList.remove('is-syncing') }
}
function modal(title, parent = document.body, embedded = false) {
  const dialog = el('dialog', 'settings-dialog' + (embedded ? ' os-provider-dialog' : '')); const top = el('header', 'dialog-header'); const label = el('h2', '', title); label.id = 'dialog-' + crypto.randomUUID(); dialog.setAttribute('aria-labelledby', label.id)
  top.append(label, iconButton('关闭', 'close', () => dialog.close())); dialog.append(top)
  const close = dialog.close.bind(dialog)
  let closing = false
  dialog.close = async () => {
    if (closing) return
    closing = true
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await dialog.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.985)' }], { duration: 140, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {})
    }
    close()
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close() })
  dialog.addEventListener('close', () => dialog.remove()); parent.append(dialog); embedded ? dialog.show() : dialog.showModal(); return dialog
}
async function editProvider(provider, afterSave, parent = document.body) {
  const embedded = parent !== document.body
  const dialog = modal(provider ? '编辑供应商与模型' : '添加供应商', parent, embedded)
  const name = field('供应商名称', provider?.provider_name || '')
  name.input.maxLength = 50
  const endpoint = field('OpenAI 兼容接口地址', provider?.endpoint || 'https://api.openai.com/v1', 'url')
  const key = field('API 密钥（仅本设备）', provider ? apiKey(provider.provider_id) : '', 'password'); key.input.autocomplete = 'off'
  const models = area('模型 ID（每行一个）', (provider?.model_list || []).join('\n'))
  const description = area('描述（选填）', provider?.description || ''); description.input.rows = 2
  const error = el('p', 'form-error'); error.setAttribute('role', 'alert')
  const getModels = button('获取并合并模型列表', async () => {
    getModels.disabled = true; error.textContent = '正在获取…'
    try { const ids = await fetchModels({ endpoint: endpoint.input.value }, key.input.value); models.input.value = [...new Set([...models.input.value.split('\n').filter(Boolean), ...ids])].join('\n'); error.textContent = `连接成功，获取 ${ids.length} 个模型` }
    catch (err) { error.textContent = err.message + '；也可手动填写' }
    finally { getModels.disabled = false }
  }, 'quiet')
  const save = button('保存供应商', async () => {
    try {
      const list = [...new Set(models.input.value.split(/[\n,，]+/).map(item => item.trim()).filter(Boolean))]
      if (!name.input.value.trim() || !list.length) throw Error('请填写名称和至少一个模型 ID')
      const value = { provider_id: provider?.provider_id || crypto.randomUUID(), provider_name: name.input.value.trim(), type: 'openai', endpoint: normalizeEndpoint(endpoint.input.value), model_list: list, description: description.input.value.trim(), created_at: provider?.created_at || new Date().toISOString(), is_deleted: 0 }
      await putRecords([{ id: 'provider:' + value.provider_id, kind: 'provider', payload: value }]); apiKey(value.provider_id, key.input.value.trim())
      await savePreferences({ modelProvider: 'custom', activeProvider: { provider_id: value.provider_id, name: value.provider_name }, modelName: list.includes(prefs.modelName) ? prefs.modelName : list[0] })
      await refreshModels(); await afterSave?.(); dialog.close(); notify('供应商与模型已保存')
    } catch (err) { error.textContent = err.message }
  }, 'primary')
  getModels.textContent = '测试连接并获取模型'
  const content = el('div', 'dialog-content'); content.append(el('p', 'muted', '供应商和模型与电脑互通，API 密钥仅保存在本设备。'), name.wrap, endpoint.wrap, key.wrap, models.wrap, getModels, description.wrap, error)
  const footer = el('footer', 'dialog-footer'); footer.append(button('取消', () => dialog.close(), 'quiet'), save)
  dialog.append(content, footer)
}
function pageHeading(title, description) { const section = el('header', 'page-heading'); section.append(el('span', 'eyebrow', 'OPENSTARRY NEXTGEN'), el('h2', '', title), el('p', 'muted', description)); return section }
async function showProviders() { await refreshModels(); showView('providers') }
function renderProviders() {
  const title = pageHeading('LLM 供应商', '和电脑使用同一套模型，密钥留在当前设备。')
  title.append(labeledButton('添加供应商', 'plus', () => editProvider(null), 'primary'))
  const list = el('div', 'provider-list')
  const selected = modelSelect.value ? JSON.parse(modelSelect.value)[0] : ''
  for (const provider of providerList) {
    const card = el('article', 'provider-card')
    const top = el('div', 'provider-card-top')
    top.append(el('span', 'provider-state' + (selected === provider.provider_id ? ' active' : ''), selected === provider.provider_id ? '当前使用' : '已配置'), iconButton('编辑 ' + provider.provider_name, 'settings', () => editProvider(provider)))
    const name = el('div', 'provider-name'); name.append(icon('link'), el('h3', '', provider.provider_name))
    const description = el('p', 'provider-description', provider.description || 'OpenAI 兼容服务'); description.title = provider.description || ''
    const endpoint = el('div', 'endpoint-tag'); endpoint.title = provider.endpoint; endpoint.append(icon('link'), el('span', '', provider.endpoint))
    const footer = el('div', 'provider-footer'); footer.append(el('span', 'type-tag', provider.type || 'openai'), el('span', 'models-tag', `${provider.model_list.length} 个模型`))
    const use = button(selected === provider.provider_id ? '开始聊天' : '使用此供应商', async () => {
      if (controller) return notify('请先停止当前回答，再切换供应商')
      if (!provider.model_list.length) return editProvider(provider)
      const chosen = provider.model_list.includes(prefs.modelName) ? prefs.modelName : provider.model_list[0]
      await savePreferences({ modelProvider: provider.is_builtin ? provider.provider_id.slice(8) : 'custom', modelName: chosen,
        ...(!provider.is_builtin ? { activeProvider: { provider_id: provider.provider_id, name: provider.provider_name } } : {}) })
      await refreshModels(); showView('chat')
    }, 'quiet provider-use')
    card.append(top, name, description, endpoint, footer, use); list.append(card)
  }
  if (!providerList.length) { const empty = el('div', 'empty-card'); empty.append(icon('provider'), el('h3', '', '连接你的第一个模型'), el('p', 'muted', '添加供应商后，就可以在聊天栏选择模型。')); list.append(empty) }
  providersView.replaceChildren(title, list)
}
async function showSettings() {
  prefs = await preferences()
  const title = pageHeading('设置', '熟悉的设置，在每一台设备上。')
  const general = el('section', 'settings-section'); general.append(el('h3', '', '通用聊天偏好'))
  const temp = field('温度（0–2）', String(Number(prefs.modelTemp ?? 50) * .02), 'number'); temp.input.min = 0; temp.input.max = 2; temp.input.step = .1
  const prompt = area('角色提示词', prefs.rolePrompt?.definition || '')
  const appearance = el('section', 'settings-section'); appearance.append(el('h3', '', '界面设置'))
  const dark = field('深色外观', '', 'checkbox'); dark.wrap.classList.add('toggle-field'); dark.input.checked = prefs.dark_theme === true; dark.input.setAttribute('role', 'switch')
  dark.input.onchange = async () => { await savePreferences({ dark_theme: dark.input.checked }); await refreshModels() }
  appearance.append(dark.wrap, el('p', 'muted', '与电脑同步外观偏好，动效跟随系统设置。'))
  general.append(temp.wrap, prompt.wrap, button('保存通用偏好', async () => {
    const value = Number(temp.input.value); if (!Number.isFinite(value) || value < 0 || value > 2) throw Error('温度范围为 0–2')
    await savePreferences({ modelTemp: value * 50, rolePrompt: { name: prefs.rolePrompt?.name || '自定义', definition: prompt.input.value } }); await refreshModels(); notify('偏好已保存，会随同步更新到电脑')
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
  const toolsSection = el('section', 'settings-section'); mountToolSettings(toolsSection, { notify, request: async value => (await import('./agentAdapter.js')).mobileRequest(value) })
  settingsView.replaceChildren(title, appearance, general, toolsSection, syncSection, el('p', 'app-credit', `OpenStarry NextGen · tomysh · ${version}`))
  showView('settings')
}
await refreshModels(); await refreshHistory(); await renderMessages()
window.addEventListener('online', () => syncNow(true))
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(true) })
setInterval(() => { if (!document.hidden) syncNow(true) }, 60000)
syncNow(true)
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => {})
