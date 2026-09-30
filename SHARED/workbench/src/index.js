import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { java } from '@codemirror/lang-java'
import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'
import { unifiedMergeView } from '@codemirror/merge'
import { diffLines } from 'diff'
import { zipSync, unzipSync, strToU8 } from 'fflate'
import MarkdownIt from 'markdown-it'
import { icon } from './icons.js'
import { createPicker } from './picker.js'
import { createReasoningPicker } from './reasoningPicker.js'
import { createChatMessage } from './chatView.js'
import { createChatTabs } from './chatTabs.js'
import { createSubagentView } from './subagentView.js'
import { createSandboxView } from './sandboxView.js'
import { safetyLevels } from './safetyLevels.js'
import { applyWebEvent, webProject, webStates } from './webChat.js'
import { Workspace, projectStore, validateFiles, MAX_FILE_BYTES, MAX_PROJECT_BYTES } from './model.js'
import { loadToolSettings } from './settings.js'
import { runAgent } from './agent.js'
import { runJavaScript, htmlPreview, showHtmlPreview, closeHtmlPreview, runRemote, openAIComplete, httpRequest } from './runtime.js'
export { Workspace, projectStore } from './model.js'
const node = (tag, cls = '', text = '') => { const value = document.createElement(tag); value.className = cls; value.textContent = text; return value }
const markdownRenderer = new MarkdownIt({ html: false, linkify: true, breaks: true })
markdownRenderer.renderer.rules.image = (tokens, index) => markdownRenderer.utils.escapeHtml(tokens[index].content || '[图片]')
let activeWorkspace, loading
export async function getWorkspace() {
  if (activeWorkspace) return activeWorkspace
  if (!loading) loading = (async () => {
    activeWorkspace = await projectStore.load(localStorage.getItem('openstarry.ide.active') || '') || new Workspace()
    return activeWorkspace
  })().finally(() => { loading = null })
  return loading
}
export async function saveWorkspace(workspace) { await projectStore.save(workspace); localStorage.setItem('openstarry.ide.active', workspace.id) }
export function askQuestion({ question, options = [] }, signal, parent = document.body) {
  return new Promise((resolve, reject) => {
    const dialog = node('dialog', 'os-dialog'); const title = node('h3', '', question); const choices = node('div', 'os-question-options')
    let selected = ''; const text = node('textarea'); text.placeholder = options.length ? '补充说明（选填）' : '填写你的回答'; text.setAttribute('aria-label', '回答或补充说明')
    for (const value of options.slice(0, 5)) { const choice = node('button', '', String(value)); choice.type = 'button'; choice.setAttribute('aria-pressed', 'false'); choice.onclick = () => { selected = String(value); for (const item of choices.children) item.setAttribute('aria-pressed', String(item === choice)) }; choices.append(choice) }
    const row = node('div', 'os-actions'), cancel = node('button', '', '取消'), submit = node('button', 'os-primary', '提交回答')
    const previous = document.activeElement
    const finish = (value, error) => { signal?.removeEventListener('abort', abort); const visible = parent.getClientRects().length; dialog.close(); dialog.remove(); if (visible && previous?.isConnected) previous.focus(); error ? reject(error) : resolve(value) }
    const abort = () => finish(null, signal.reason || Error('任务已停止'))
    cancel.onclick = () => finish(null); dialog.oncancel = event => { event.preventDefault(); finish(null) }
    submit.onclick = () => { if (!selected && !text.value.trim()) { text.focus(); return } finish([selected, text.value.trim()].filter(Boolean).join('\n')) }
    row.append(cancel, submit); dialog.append(title, choices, text, row); parent.append(dialog); parent === document.body ? dialog.showModal() : dialog.show(); if (parent.getClientRects().length) (choices.firstChild || text).focus()
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
  })
}
export async function executeProject(workspace, command, { settings = loadToolSettings(), request = httpRequest, native, signal, onOutput } = {}) {
  if (!command.trim()) throw Error('请输入运行命令或 JavaScript 文件路径')
  if (native?.run && workspace.nativeRoot) return native.run({ root: workspace.nativeRoot, command, signal, onOutput })
  if (settings.runtimeUrl) return runRemote({ settings, files: workspace.files, command, request, signal, onOutput })
  const path = command.replace(/^node\s+/, '').trim()
  if (!/\.(js|mjs)$/i.test(path) || !(path in workspace.files)) throw Error('本地运行请填写 JavaScript 文件路径；Python、Java 或完整项目请在设置中连接执行服务器')
  return runJavaScript(workspace.files[path], signal, onOutput)
}
function language(path) {
  const ext = path.split('.').at(-1).toLowerCase()
  return ({ js: () => javascript(), mjs: () => javascript(), ts: () => javascript({ typescript: true }), tsx: () => javascript({ typescript: true, jsx: true }), jsx: () => javascript({ jsx: true }), py: python, html, css, json, java, md: markdown })[ext]?.() || []
}
export async function mountWorkbench(host, options = {}) {
  let workspace = await getWorkspace(), editor, comparison = false, agentController, agentTask, runController, saveTimer, disposed = false
  let persistChain = Promise.resolve(), currentPanel = 'editor'
  let chatFrame, lastChatSave = 0, modelRevision = 0, configuredModel = false
  let subagentTimer, subagentProjectId, webChildren = [], subagentError = ''
  const subagentView = options.web?.services ? createSubagentView({ services: value => options.web.services(value) }) : null
  const sandboxView = options.web?.services ? createSandboxView({ services: value => options.web.services(value) }) : null
  let serviceState, safetyBusy = false
  const chatScroll = new Map()
  const currentTask = () => agentTask?.id === workspace.chatId ? agentTask : null
  const messageViews = new WeakMap(), activeMessageViews = new Set(), references = new Set(workspace.chatReferences)
  for (const item of [workspace.chat, ...workspace.chatSessions.map(session => session.chat)].flat()) {
    if (item?.status === 'running') item.status = 'interrupted'
    for (const part of item?.parts || []) if (part.phase === 'running') { part.phase = 'stopped'; part.text = '上次运行已中断，已接收内容保留在本机。' }
  }
  const notify = options.notify || (text => { status.textContent = text })
  const report = error => notify(error?.message || String(error))
  const button = (text, action, cls = '') => { const value = node('button', cls, text); value.type = 'button'; value.onclick = () => Promise.resolve().then(action).catch(report); return value }
  const iconButton = (label, symbol, action, cls = '') => { const value = button('', action, 'os-icon-button ' + cls); value.append(icon(symbol)); value.title = label; value.setAttribute('aria-label', label); return value }
  const root = node('section', 'os-ide'); root.setAttribute('aria-label', 'IDE 工作区')
  root.dataset.panel = currentPanel; root.dataset.theme = options.theme || 'light'
  const toolbar = node('header', 'os-toolbar'), brand = node('span', 'os-brand', 'OS')
  brand.title = 'OpenStarry IDE'
  const projectSelect = createPicker({ label: '当前项目', className: 'os-project-select', onChange: id => { projectSelect.value = workspace.id; projectStore.load(id).then(selectWorkspace).catch(report) } })
  const projectPicker = node('div', 'os-project-picker'); projectPicker.append(brand, projectSelect.element)
  const quickSearch = button('', () => { selectPanel('files'); query.focus() }, 'os-quick-search'); quickSearch.append(icon('search'), node('span', '', '搜索项目文件与代码')); quickSearch.setAttribute('aria-label', '搜索项目文件与代码')
  const nav = node('nav', 'os-panel-nav'); nav.setAttribute('aria-label', 'IDE 面板')
  const panels = new Map()
  for (const [id, title] of [['files', '项目'], ['editor', '代码'], ['review', '审查'], ['output', '输出'], ['agent', 'Agent']]) { const item = iconButton(title, id, () => selectPanel(id)); item.append(node('span', 'os-nav-label', title)); item.dataset.panel = id; nav.append(item); panels.set(id, item) }
  const projectActions = node('div', 'os-project-actions')
  projectActions.append(button('新建项目', createProject), button('导入', importProject), button('导出', exportProject))
  if (options.native?.open) projectActions.prepend(button('打开目录', openDirectory))
  const themeButton = iconButton('切换 IDE 深浅外观', 'theme', () => { root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('openstarry.ide.theme', root.dataset.theme); renderEditor() })
  root.dataset.theme = localStorage.getItem('openstarry.ide.theme') || options.theme || 'light'
  toolbar.append(projectPicker, quickSearch, projectActions, themeButton)
  const body = node('div', 'os-ide-body'), filesPane = node('aside', 'os-files'), center = node('section', 'os-center'), agentPane = node('aside', 'os-agent')
  const filesHead = node('div', 'os-pane-title'); filesHead.append(node('strong', '', '项目'), iconButton('新建文件', 'plus', createFile))
  const query = node('input', 'os-search'); query.placeholder = '搜索项目内容'; query.setAttribute('aria-label', '搜索项目内容'); query.oninput = renderTree
  const tree = node('div', 'os-tree'); tree.setAttribute('aria-label', '项目文件')
  const projectLabel = node('div', 'os-project-label'); filesPane.append(filesHead, query, projectLabel, tree)
  const reviewList = node('div', 'os-review-list'); reviewList.hidden = true; filesPane.append(reviewList)
  const tabs = node('div', 'os-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '打开的文件')
  const filebar = node('div', 'os-filebar'), breadcrumb = node('span', 'os-breadcrumb'), fileActions = node('div', 'os-actions')
  fileActions.append(button('保存', saveCurrent), button('重命名', renameFile), button('删除', deleteFile))
  filebar.append(breadcrumb, fileActions)
  const reviewbar = node('div', 'os-reviewbar'), reviewCount = node('span', 'os-diff-count'), reviewActions = node('div', 'os-actions')
  reviewbar.append(reviewCount, reviewActions); reviewbar.hidden = true
  const editorHost = node('div', 'os-editor'); editorHost.setAttribute('aria-label', '代码编辑区')
  const outputPane = node('section', 'os-output'), runbar = node('div', 'os-runbar'), command = node('input'); command.placeholder = options.native ? '运行命令，例如 python main.py' : 'main.js 或服务器运行命令'; command.setAttribute('aria-label', '运行命令')
  const runButton = button('▶ 运行', runCurrent, 'os-primary'), stopButton = button('停止', () => runController?.abort(Error('运行已停止'))); stopButton.disabled = true
  const output = node('pre', 'os-output-text'); output.setAttribute('aria-label', '运行输出'); output.textContent = '运行结果会显示在这里。'
  const preview = node('iframe', 'os-preview'); preview.title = '网页预览'; preview.setAttribute('sandbox', 'allow-scripts'); preview.hidden = true
  runbar.append(command, runButton, stopButton, button('网页预览', previewCurrent), button('清空', () => { output.textContent = ''; preview.hidden = true }))
  const outputHead = node('div', 'os-output-head'); outputHead.append(node('span', '', '输出'), node('small', '', '运行与预览'), iconButton('收起输出', 'close', () => { root.classList.add('os-output-collapsed'); selectPanel('editor') }))
  outputPane.append(outputHead, runbar, output, preview); center.append(tabs, filebar, reviewbar, editorHost, outputPane)
  const agentHead = node('div', 'os-pane-title os-agent-head'), agentTitle = node('strong', 'os-agent-title'); agentTitle.append(node('span', '', 'Agent'))
  const agentHeadActions = node('div', 'os-actions'), chatCount = node('small', 'os-chat-count'); agentHeadActions.append(chatCount); agentHead.append(agentTitle, agentHeadActions)
  const sessionBar = node('div', 'os-agent-sessionbar')
  const chatPanelId = 'os-chat-panel-' + crypto.randomUUID()
  const chatTabs = createChatTabs({ panelId: chatPanelId, onSelect: id => selectAgentChat(id).catch(report), onClose: id => closeAgentChat(id).catch(report) })
  const newChatButton = iconButton('新的项目对话', 'plus', newAgentChat, 'os-chat-new')
  const historyButton = button('历史记录', showHistory, 'os-history-trigger'); historyButton.prepend(icon('history')); historyButton.setAttribute('aria-label', '会话历史'); historyButton.setAttribute('aria-expanded', 'false')
  sessionBar.append(chatTabs.element, newChatButton, historyButton, node('span', 'os-agent-session-state', '本机'))
  const history = node('div', 'os-chat-history'); history.hidden = true
  const chat = node('div', 'os-agent-chat'); chat.id = chatPanelId; chat.setAttribute('role', 'tabpanel'); chat.setAttribute('aria-label', '项目 Agent 对话')
  const agentState = node('div', 'os-agent-state'); agentState.setAttribute('role', 'status')
  const questionDock = node('div', 'os-question-dock')
  const agentStatusbar = node('div', 'os-agent-statusbar'); agentStatusbar.setAttribute('aria-label', 'Agent 任务状态')
  const statusDetails = node('div', 'os-agent-status-details'); statusDetails.hidden = true
  const statusTask = button('', () => { statusDetails.hidden = !statusDetails.hidden; renderAgentStatus() }, 'os-agent-status-item')
  const statusSubagent = button('', () => { statusDetails.hidden = !statusDetails.hidden; renderAgentStatus() }, 'os-agent-status-item')
  const statusEdits = button('', () => { if (Object.keys(workspace.proposals).length) selectPanel('review'); else { statusDetails.hidden = !statusDetails.hidden; renderAgentStatus() } }, 'os-agent-status-item')
  agentStatusbar.append(statusTask, statusSubagent, statusEdits)
  const agentComposer = node('div', 'os-agent-composer'), contextChips = node('div', 'os-context-chips')
  const agentInput = node('textarea', 'os-agent-input'); agentInput.placeholder = '一起完成下一个想法…'; agentInput.setAttribute('aria-label', '项目 Agent 消息'); agentInput.rows = 3
  agentInput.value = workspace.chatDraft
  const agentSend = iconButton('发送', 'arrow', sendAgent, 'os-agent-send'), agentStop = iconButton('停止', 'stop', () => currentTask()?.cancel ? currentTask().cancel() : currentTask()?.controller.abort(Error('Agent 已停止')), 'os-agent-send'); agentStop.hidden = true
  const sourcePicker = createPicker({ label: 'Agent 来源', className: 'os-agent-source', placement: 'above', value: workspace.chatSource,
    items: [{ value: 'api', label: 'API' }, ...(options.web ? [{ value: 'gpt-web', label: 'GPT 网页版' }] : [])],
    onChange: value => { workspace.chatSource = value; laterPersist(); refreshModels().catch(report) } })
  const webBar = node('div', 'os-web-bar'), webStatus = node('span', 'os-web-status', '模型沿用网页设置 · 深度思考由下方开关控制')
  const sourceRow = node('div', 'os-source-row'); sourceRow.hidden = !options.web; sourceRow.append(node('span', '', '来源'), sourcePicker.element)
  webBar.hidden = true
  webBar.append(webStatus, button('连接 / 登录', showWebConnection), button('恢复回复', resumeWebChat))
  const agentMode = createPicker({ label: 'Agent 工作模式', className: 'os-agent-mode', placement: 'above', value: workspace.chatMode, onChange: () => laterPersist(), items: [
    { value: 'agent', label: 'Agent', icon: 'agent', description: '使用已启用的工具完成任务，代码修改先审查。' },
    { value: 'ask', label: '仅提问', icon: 'chat', description: '讨论和解释代码，不调用工具或修改文件。' },
  ] })
  const modelPicker = createPicker({ label: '项目 Agent 模型', className: 'os-agent-model', placement: 'above', onChange: value => Promise.resolve(options.selectModel?.(value)).then(refreshModels).catch(report) })
  const reasoningPicker = createReasoningPicker()
  const webThinking = button('深度思考', () => { workspace.chatThinking = !workspace.chatThinking; renderAgentControls(); laterPersist() }, 'os-web-thinking')
  webThinking.title = '发送前自动设置 ChatGPT 的“思考”选项'
  webThinking.hidden = true
  const safetyPicker = createPicker({ label: '安全等级', className: 'os-safety-picker', placement: 'above', items: safetyLevels, value: 'ask', onChange: async value => {
    if (!options.web?.services || safetyBusy) return
    safetyBusy = true; safetyPicker.disabled = true
    try { serviceState = await options.web.services({ action: 'safety-set', safetyMode: value }); safetyPicker.value = serviceState.bridge.safetyMode; renderAgentStatus() }
    catch (error) { safetyPicker.value = serviceState?.bridge.safetyMode || 'ask'; report(error) }
    finally { safetyBusy = false; safetyPicker.disabled = false }
  } })
  safetyPicker.element.hidden = true
  const configureModel = button('', async () => { await options.configureProvider?.({ parent: agentPane, current: await options.getModel?.() }); if (!disposed) await refreshModels() }, 'os-picker os-agent-model os-configure-model')
  configureModel.append(node('span', 'os-picker-caption', '请先配置模型'), icon('settings'))
  configureModel.title = '前往供应商配置'; configureModel.disabled = !options.configureProvider
  modelPicker.element.hidden = true
  const agentButtons = node('div', 'os-composer-actions'); agentButtons.append(iconButton('引用当前文件', 'attach', () => { if (workspace.active) { references.add(workspace.active); renderReferences(); laterPersist(); agentInput.focus() } }), agentMode.element, modelPicker.element, configureModel, reasoningPicker.element, webThinking, agentStop, agentSend)
  webThinking.after(safetyPicker.element)
  agentComposer.append(sourceRow, webBar, contextChips, agentInput, agentButtons)
  const agentFoot = node('div', 'os-agent-foot', '修改先审查，再保存'); agentFoot.append(node('span', '', 'Ctrl + Enter'))
  agentPane.append(agentHead, sessionBar, history, chat, agentState, questionDock, agentStatusbar, statusDetails, agentComposer, agentFoot)
  if (subagentView) agentPane.insertBefore(subagentView.element, agentStatusbar)
  const filesGrip = resizeGrip('files', '调整项目栏宽度', 160, 320, 210), agentGrip = resizeGrip('agent', '调整 Agent 栏宽度', 290, 560, 350)
  body.append(nav, filesPane, filesGrip, center, agentGrip, agentPane)
  const statusBar = node('footer', 'os-statusbar'), status = node('span', 'os-status', '项目保存在本机'), statusMeta = node('span', 'os-status-meta', 'UTF-8  ·  OpenStarry IDE'); status.setAttribute('role', 'status'); statusBar.append(icon('folder'), status, statusMeta)
  root.append(toolbar, body, statusBar); host.replaceChildren(root)
  const syncChatDraft = () => { workspace.chatDraft = agentInput.value; workspace.chatReferences = [...references]; workspace.chatMode = agentMode.value }
  const persist = () => { syncChatDraft(); const snapshot = workspace.snapshot(); persistChain = persistChain.catch(() => {}).then(() => saveWorkspace(new Workspace(snapshot))); persistChain.catch(report); return persistChain }
  const laterPersist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 300) }
  agentInput.oninput = () => { syncChatDraft(); renderChatTabs(); laterPersist() }
  command.oninput = () => { workspace.command = command.value; laterPersist() }
  function resizeGrip(name, label, min, max, initial) {
    const grip = node('div', 'os-resizer os-resizer-' + name); grip.tabIndex = 0; grip.setAttribute('role', 'separator'); grip.setAttribute('aria-label', label); grip.setAttribute('aria-orientation', 'vertical'); grip.setAttribute('aria-valuemin', min); grip.setAttribute('aria-valuemax', max)
    let size = initial
    try { size = Number(localStorage.getItem('openstarry.ide.width.' + name)) || initial } catch {}
    const update = value => { size = Math.min(max, Math.max(min, value)); root.style.setProperty('--' + name + '-width', size + 'px'); grip.setAttribute('aria-valuenow', size); editor?.requestMeasure() }
    update(size)
    const save = () => localStorage.setItem('openstarry.ide.width.' + name, size)
    grip.onpointerdown = event => { const start = event.clientX, original = size; grip.setPointerCapture(event.pointerId); root.classList.add('os-resizing'); grip.onpointermove = event => update(original + (event.clientX - start) * (name === 'agent' ? -1 : 1)) }
    grip.onlostpointercapture = () => { grip.onpointermove = null; root.classList.remove('os-resizing'); save() }
    grip.onkeydown = event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); update(size + (event.key === 'ArrowRight' ? 16 : -16) * (name === 'agent' ? -1 : 1)); save() } }
    return grip
  }
  async function refreshModels() {
    const revision = ++modelRevision, task = currentTask()
    const useWeb = (task?.source || workspace.chatSource) === 'gpt-web'
    sourcePicker.value = task?.source || workspace.chatSource
    webBar.hidden = !useWeb; reasoningPicker.element.hidden = useWeb; webThinking.hidden = !useWeb
    safetyPicker.element.hidden = !useWeb || !options.web?.services
    if (useWeb) { modelPicker.element.hidden = true; configureModel.hidden = true; configuredModel = false; renderAgentControls(); return }
    const current = task?.config || await options.getModel?.(), models = task?.config ? [{ value: task.modelValue, label: task.config.model, selected: true }] : await options.getModels?.() || (current?.model ? [{ value: current.model, label: current.model, selected: true }] : [])
    if (revision !== modelRevision || disposed) return
    modelPicker.setItems(models.length ? models : [{ value: '', label: '请先配置模型' }], models.find(model => model.selected)?.value ?? models[0]?.value ?? '')
    modelPicker.element.hidden = !models.length
    configureModel.hidden = Boolean(models.length)
    configuredModel = Boolean(current?.model); reasoningPicker.setModel(current); renderAgentControls()
  }
  function renderAgentControls() {
    const task = currentTask(), busy = Boolean(task)
    agentSend.hidden = busy; agentStop.hidden = !busy; agentSend.disabled = Boolean(agentController)
    agentSend.title = agentController && !busy ? '另一对话正在运行，可切回该标签停止任务后发送' : '发送'
    agentInput.disabled = Boolean(task?.preparing); agentMode.disabled = busy
    sourcePicker.disabled = busy
    webThinking.disabled = busy; webThinking.setAttribute('aria-pressed', String(workspace.chatThinking))
    agentStop.disabled = Boolean(task?.source === 'gpt-web' && (!task.cancel || task.cancelRequested))
    modelPicker.disabled = !options.selectModel || modelPicker.element.hidden || busy
    configureModel.disabled = !options.configureProvider || busy; reasoningPicker.disabled = !configuredModel || busy
    agentState.textContent = task?.state || (agentController ? '另一标签正在生成，当前草稿会保留。' : '')
    agentState.classList.toggle('is-working', busy); questionDock.hidden = Boolean(agentTask && !busy)
  }
  function renderReferences() {
    contextChips.replaceChildren(...[...references].map(path => { const chip = node('span', 'os-context-chip'); chip.append(icon('editor'), node('span', '', path), iconButton('移除引用 ' + path, 'close', () => { references.delete(path); renderReferences(); laterPersist() })); chip.title = path; return chip }))
  }
  function closeHistory() { history.hidden = true; historyButton.setAttribute('aria-expanded', 'false') }
  function rememberChat() {
    syncChatDraft(); chatScroll.set(workspace.chatId, chat.scrollTop)
  }
  function restoreChat() {
    agentInput.value = workspace.chatDraft; agentMode.value = workspace.chatMode
    references.clear(); for (const path of workspace.chatReferences) references.add(path)
    renderReferences(); closeHistory(); renderChat()
    chat.scrollTop = chatScroll.get(workspace.chatId) ?? chat.scrollHeight
    refreshModels().catch(report)
  }
  async function selectAgentChat(id) {
    if (id !== workspace.chatId) { rememberChat(); workspace.activateChat(id); restoreChat(); await persist() }
    else closeHistory()
  }
  async function closeAgentChat(id) {
    const focusInTabs = chatTabs.element.contains(document.activeElement)
    rememberChat(); workspace.closeChat(id); restoreChat()
    if (focusInTabs) chatTabs.focus(workspace.chatId)
    await persist()
  }
  async function newAgentChat() {
    rememberChat(); workspace.createChat(); restoreChat(); agentInput.focus(); await persist()
  }
  function renderChatTabs() {
    chatTabs.update(workspace.chatTabs.map(id => ({ id, title: workspace.chatTitle(id), state: agentTask?.id === id ? agentTask.waiting ? 'waiting' : 'running' : 'idle' })), workspace.chatId)
    chatCount.textContent = workspace.chatTabs.length + ' 个对话'
    chat.dataset.chatId = workspace.chatId
  }
  function showHistory() {
    history.hidden = !history.hidden; historyButton.setAttribute('aria-expanded', String(!history.hidden)); if (history.hidden) return
    history.replaceChildren(node('div', 'os-history-title', '本机项目会话'))
    history.append(node('p', 'os-hint', '关闭标签只收起对话，记录和草稿仍保留在本机。'))
    for (const session of [workspace.currentChat(), ...workspace.chatSessions]) {
      const current = session.id === workspace.chatId
      const entry = button((current ? '当前 · ' : '') + workspace.chatTitle(session.id), async () => { await selectAgentChat(session.id); closeHistory(); agentInput.focus() }, current ? 'is-current' : '')
      if (agentTask?.id === session.id) entry.append(node('small', 'os-history-running', agentTask.waiting ? '等待回答' : '生成中'))
      history.append(entry)
    }
  }
  async function selectWorkspace(next) {
    if (agentController || runController) throw Error('请先停止当前任务再切换项目')
    clearTimeout(saveTimer); await persist(); workspace = next; activeWorkspace = workspace; comparison = currentPanel === 'review'; restoreChat(); command.value = workspace.command; await persist(); await renderProjectSelect(); renderAll(); renderChat(true)
  }
  async function renderProjectSelect() { const list = await projectStore.list(); if (!list.some(item => item.id === workspace.id)) list.push(workspace); projectSelect.setItems(list.map(item => ({ value: item.id, label: item.name, icon: 'folder' })), workspace.id) }
  async function createProject() {
    const name = await askQuestion({ question: '新项目名称' }); if (!name) return
    const next = new Workspace({ name: name.slice(0, 80) }); next.create('main.js', 'console.log("Hello, OpenStarry!");\n'); await selectWorkspace(next); selectPanel('editor')
  }
  async function openDirectory() { const data = await options.native.open(); if (data) await selectWorkspace(new Workspace(data)) }
  async function createFile() { const path = await askQuestion({ question: '新文件路径，例如 src/main.py' }); if (!path) return; workspace.create(path); await persist(); renderAll(); selectPanel('editor') }
  async function renameFile() {
    if (!workspace.active) return
    const next = await askQuestion({ question: '新的文件路径' }); if (!next) return
    const path = workspace.active
    const check = new Workspace(workspace.snapshot()); check.rename(path, next)
    if (workspace.nativeRoot && path in workspace.diskFiles) { await options.native.rename({ root: workspace.nativeRoot, path, next, expected: workspace.diskFiles[path] }); workspace.diskFiles[next] = workspace.diskFiles[path]; delete workspace.diskFiles[path] }
    workspace.rename(workspace.active, next); await persist(); renderAll()
  }
  async function deleteFile() {
    if (!workspace.active) return
    const path = workspace.active, yes = await askQuestion({ question: '删除 ' + path + '？', options: ['删除文件', '保留文件'] }); if (yes !== '删除文件') return
    if (workspace.nativeRoot && path in workspace.diskFiles) { await options.native.remove({ root: workspace.nativeRoot, path, expected: workspace.diskFiles[path] }); delete workspace.diskFiles[path] }
    workspace.remove(path); await persist(); renderAll()
  }
  async function writeNative(path, content) { if (workspace.nativeRoot) { if (!options.native?.write) throw Error('请在电脑上打开这个目录项目'); await options.native.write({ root: workspace.nativeRoot, path, content, expected: workspace.diskFiles[path] ?? null }); workspace.diskFiles[path] = content } }
  async function saveCurrent() {
    const path = workspace.active; if (!path) return
    if (workspace.proposals[path] && comparison) { notify('Agent 修改请使用“接受修改”'); return }
    await writeNative(path, workspace.content(path), workspace.files[path] ?? null); workspace.save(path); await persist(); renderAll(); status.textContent = path + ' 已保存'
  }
  async function acceptProposal() {
    const path = workspace.active, proposal = workspace.checkProposal(path)
    if (proposal.webProposalId) { await options.web.review({ project: webProject(workspace), proposalId: proposal.webProposalId, decision: 'accept' }); if (workspace.nativeRoot && !proposal.external) workspace.diskFiles[path] = proposal.content }
    else await writeNative(path, proposal.content, workspace.files[path] ?? null)
    workspace.accept(path); await persist(); selectPanel('review'); renderAll()
  }
  async function rejectProposal() { const path = workspace.active; if (workspace.proposals[path]?.webProposalId) await options.web.review({ project: webProject(workspace), proposalId: workspace.proposals[path].webProposalId, decision: 'reject' }); workspace.reject(path); await persist(); selectPanel('review'); renderAll() }
  function reviewPaths() { return [...new Set([...Object.keys(workspace.proposals), ...Object.keys(workspace.drafts)])] }
  function renderReviewList() {
    const reviewing = currentPanel === 'review'
    reviewList.hidden = !reviewing; query.hidden = reviewing; tree.hidden = reviewing
    filesHead.querySelector('strong').textContent = reviewing ? '修改审查' : '项目'
    filesHead.querySelector('button').hidden = reviewing
    reviewList.replaceChildren()
    if (!reviewPaths().length) reviewList.append(node('p', 'os-hint', '没有待审查修改'))
    for (const path of reviewPaths()) {
      const entry = button('', () => { workspace.open(path); comparison = true; renderAll() }, 'os-review-file')
      entry.classList.toggle('active', workspace.active === path)
      entry.append(node('span', '', path), node('small', '', workspace.proposals[path]?.external ? '全盘文件提案' : workspace.proposals[path] ? 'Agent 提案' : '编辑草稿'))
      reviewList.append(entry)
    }
  }
  function renderTree() {
    renderReviewList()
    projectLabel.replaceChildren(icon('chevron'), node('span', '', workspace.name)); projectLabel.title = workspace.name
    tree.replaceChildren()
    if (query.value.trim()) { for (const item of workspace.search(query.value)) tree.append(button(`${item.path}:${item.line}  ${item.text}`, () => { openFile(item.path); const line = editor?.state.doc.line(Math.min(item.line, editor.state.doc.lines)); if (line) editor.dispatch({ selection: { anchor: line.from }, scrollIntoView: true }) }, 'os-search-result')); return }
    if (!workspace.paths().length) tree.append(node('p', 'os-hint', '新建或导入项目，开始编写代码。'))
    const folders = new Map([['', tree]])
    for (const path of workspace.paths()) {
      const parts = path.split('/'); const name = parts.pop(); let folder = ''
      for (const part of parts) { const parent = folder; folder = folder ? folder + '/' + part : part; if (!folders.has(folder)) { const details = node('details', 'os-folder'); details.open = true; details.append(node('summary', '', part)); folders.get(parent).append(details); folders.set(folder, details) } }
      const entry = button('', () => openFile(path), 'os-file'); entry.title = path; entry.setAttribute('aria-label', '打开文件 ' + path); entry.classList.toggle('active', path === workspace.active)
      entry.append(node('span', 'os-file-extension', name.split('.').at(-1).slice(0, 3).toUpperCase()), node('span', 'os-file-name', name))
      if (workspace.proposals[path]) entry.append(node('span', 'os-proposal-dot', '●')); else if (path in workspace.drafts) entry.append(node('span', 'os-draft-dot', '●'))
      folders.get(folder).append(entry)
    }
  }
  function renderTabs() {
    tabs.replaceChildren(...workspace.tabs.map(path => {
      const tab = node('div', 'os-tab'); tab.classList.toggle('active', path === workspace.active)
      const title = button(path.split('/').at(-1) + (path in workspace.drafts ? ' ●' : ''), () => openFile(path)); title.prepend(node('span', 'os-tab-extension', path.split('.').at(-1).toUpperCase())); title.setAttribute('role', 'tab'); title.setAttribute('aria-selected', String(path === workspace.active)); title.title = path
      const close = button('×', () => { workspace.close(path); laterPersist(); renderAll() }); close.setAttribute('aria-label', '关闭 ' + path)
      tab.append(title, close); return tab
    }))
  }
  function openFile(path) { workspace.open(path); comparison = Boolean(workspace.proposals[path]); persist(); renderAll(); selectPanel(comparison ? 'review' : 'editor') }
  function renderEditor() {
    editor?.destroy(); editor = null; editorHost.replaceChildren()
    const path = workspace.active; breadcrumb.textContent = path ? workspace.name + '  ›  ' + path.replaceAll('/', '  ›  ') : workspace.name; filebar.hidden = !path
    reviewbar.hidden = !path || !comparison
    if (currentPanel === 'review' && !reviewPaths().includes(path)) {
      filebar.hidden = true; reviewbar.hidden = true
      const empty = node('div', 'os-editor-empty os-review-empty'); empty.append(icon('check'), node('h2', '', '没有待审查修改'), node('p', '', 'Agent 提案和未保存的编辑会显示在这里。'), button('返回代码', () => selectPanel('editor'))); editorHost.append(empty); return
    }
    if (!path) { const empty = node('div', 'os-editor-empty'); empty.append(node('div', 'os-empty-symbol', '{ }'), node('h2', '', '让想法成为代码'), node('p', '', '打开项目文件，或让 Agent 帮你开始。'), button('新建项目', createProject, 'os-primary')); editorHost.append(empty); return }
    const proposal = workspace.proposals[path]
    if (proposal?.external) { comparison = true; reviewbar.hidden = false }
    const doc = comparison && proposal ? proposal.content : workspace.content(path), base = proposal?.base ?? workspace.files[path] ?? ''
    if (comparison) {
      const changes = diffLines(base, doc); const adds = changes.filter(item => item.added).reduce((sum, item) => sum + item.count, 0), deletes = changes.filter(item => item.removed).reduce((sum, item) => sum + item.count, 0)
      reviewCount.replaceChildren(node('span', 'os-add', '+' + adds), node('span', 'os-delete', '−' + deletes), node('span', '', proposal ? 'Agent 提案' : '未保存修改'))
      reviewActions.replaceChildren(...(proposal ? [button('撤销提案', rejectProposal), button('接受修改', acceptProposal, 'os-primary')] : [button('继续编辑', () => selectPanel('editor')), button('保存修改', saveCurrent, 'os-primary')]))
    }
    editor = new EditorView({ parent: editorHost, state: EditorState.create({ doc, extensions: [basicSetup, language(path), keymap.of([indentWithTab, { key: 'Mod-s', run: () => { saveCurrent().catch(report); return true } }]), EditorView.theme({ '&': { height: '100%', fontSize: '13px' }, '.cm-scroller': { overflow: 'auto', fontFamily: '"Cascadia Code", Consolas, monospace', lineHeight: '1.65' } }), ...(root.dataset.theme === 'dark' ? [oneDark] : []), ...(comparison ? [unifiedMergeView({ original: base, mergeControls: false, highlightChanges: true, gutter: true }), EditorState.readOnly.of(true), EditorView.editable.of(false)] : []), EditorView.updateListener.of(update => {
      if (update.docChanged && !comparison) { try { workspace.edit(path, update.state.doc.toString()); laterPersist(); renderTabs(); status.textContent = '草稿已在本机保留 · Ctrl+S 保存文件' } catch (error) { report(error) } }
      if (update.selectionSet) { const selection = update.state.selection.main; const line = update.state.doc.lineAt(selection.head); status.textContent = `${path} · ${line.number}:${selection.head - line.from + 1} · UTF-8` }
    })] }) })
  }
  function renderAgentStatus() {
    const changes = Object.values(workspace.proposals || {}).reduce((total, proposal) => {
      const diff = diffLines(proposal.base || '', proposal.content || '')
      return {
        additions: total.additions + diff.filter(item => item.added).reduce((sum, item) => sum + item.count, 0),
        deletions: total.deletions + diff.filter(item => item.removed).reduce((sum, item) => sum + item.count, 0),
      }
    }, { additions: 0, deletions: 0 })
    const toolCount = workspace.chat.reduce((total, item) => total + (item.parts || []).filter(part => part.type === 'tool').length, 0)
    const lastStatus = workspace.chat.at(-1)?.status
    const taskValue = currentTask() ? '运行中' : ({ stopped: '已停止', error: '失败', interrupted: '已中断' }[lastStatus] || (workspace.chat.length ? '已完成' : '空闲'))
    statusTask.replaceChildren(icon('check'), node('span', '', '任务'), node('b', '', taskValue))
    const children = subagentProjectId === workspace.id ? webChildren : []
    statusSubagent.replaceChildren(icon('agent'), node('span', '', '子 Agent'), node('b', '', `${children.length} 个 · ${children.filter(child => !child.done).length} 进行中`))
    statusEdits.replaceChildren(icon('review'), node('span', '', '修改'), node('b', '', `+${changes.additions} −${changes.deletions}`))
    statusDetails.replaceChildren(
      node('div', '', currentTask() ? '当前回合正在运行，工具记录会显示在消息时间线中。' : '当前回合已停止运行。'),
      node('div', '', `工具调用 ${toolCount} · 待审查文件 ${Object.keys(workspace.proposals || {}).length}`),
    )
    if (subagentError) statusDetails.append(node('div', '', subagentError))
    if (subagentView) subagentView.update(children, workspace.id)
    if (sandboxView) { sandboxView.update(serviceState?.bridge.projectId === workspace.id ? serviceState.sandbox : null, serviceState?.bridge.projectId === workspace.id ? workspace.id : undefined); statusDetails.append(sandboxView.element) }
  }
  async function refreshSubagents() {
    if (disposed || !options.web?.status || !subagentView) return
    const target = workspace
    try {
      const state = await options.web.status({ project: webProject(target) })
      if (disposed || target !== workspace) return
      const services = await options.web.services({ action: 'status' })
      if (disposed || target !== workspace) return
      serviceState = services
      if (!safetyBusy && safetyPicker.value !== (services.bridge.safetyMode || 'ask')) safetyPicker.value = services.bridge.safetyMode || 'ask'
      webChildren = state.subagents || []; subagentProjectId = target.id; subagentError = ''
      renderAgentStatus(); await subagentView.refresh(); await sandboxView?.refresh()
    } catch (error) { if (!disposed && target === workspace) { subagentError = error.message; renderAgentStatus() } }
    finally { if (!disposed) subagentTimer = setTimeout(refreshSubagents, 2000) }
  }
  function renderChat(forceScroll = false) {
    renderChatTabs(); renderAgentControls()
    const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 90
    if (!workspace.chat.length) {
      if (chat.querySelector('.os-agent-welcome')) { renderAgentStatus(); return }
      chat.replaceChildren()
      const empty = node('div', 'os-agent-welcome')
      empty.append(node('span', 'os-agent-kicker', 'PROJECT AGENT'), node('h2', '', '一起完成这个项目'), node('p', '', '从一段代码，或一个想法开始。'))
      const suggestions = node('div', 'os-agent-suggestions')
      for (const [symbol, title, prompt] of [['search', '梳理这个项目', '请阅读项目，说明主要结构和关键流程。'], ['review', '检查代码问题', '请审查当前项目，找出可复现的问题并提出修改建议。'], ['editor', '实现一个新功能', '我想为项目添加一个功能，请先问清楚关键需求。']]) { const item = button('', () => { agentInput.value = prompt; agentInput.focus() }); item.append(icon(symbol), node('span', '', title), icon('chevron')); suggestions.append(item) }
      empty.append(suggestions); chat.append(empty)
    }
    const elements = []
    for (const item of workspace.chat) {
      let view = messageViews.get(item)
      if (!view) { view = createChatMessage(item, { markdown: markdownRenderer, icon, openFile, hasProposal: path => Boolean(workspace.proposals[path]), download: path => downloadWebFile(item, path), onResize: () => { if (chat.scrollHeight - chat.scrollTop - chat.clientHeight < 110) chat.scrollTop = chat.scrollHeight } }); messageViews.set(item, view) }
      view.update(); elements.push(view.element); activeMessageViews.add(view)
    }
    if (workspace.chat.length) {
      const current = [...chat.children]
      if (elements.some((element, index) => current[index] !== element)) {
        const appendOnly = current.length > 0 && current.every((element, index) => element === elements[index])
        if (appendOnly) { for (const element of elements.slice(current.length)) { element.classList.add('os-message-new'); chat.append(element) } }
        else chat.replaceChildren(...elements)
      }
    }
    for (const view of activeMessageViews) if (!elements.includes(view.element)) { view.flush(); activeMessageViews.delete(view) }
    renderAgentStatus()
    if (nearBottom || forceScroll) chat.scrollTop = chat.scrollHeight
  }
  function scheduleChat() {
    if (!chatFrame) chatFrame = requestAnimationFrame(() => { chatFrame = null; if (!disposed) renderChat() })
    if (Date.now() - lastChatSave > 1000) { lastChatSave = Date.now(); persist() } else laterPersist()
  }
  function renderAll() { renderTree(); renderTabs(); renderEditor(); renderChat(); command.value = workspace.command }
  function selectPanel(panel) {
    const previousPanel = currentPanel
    currentPanel = panel; root.dataset.panel = panel
    if (panel === 'output') root.classList.remove('os-output-collapsed')
    if (panel === 'agent') refreshModels().catch(report)
    if (panel === 'review') { comparison = true; const pending = reviewPaths(); if (!pending.includes(workspace.active) && pending.length) workspace.open(pending[0]); renderTree(); renderTabs(); renderEditor() }
    if (panel === 'editor' && (comparison || previousPanel !== 'editor')) { comparison = false; renderEditor() }
    if (panel === 'files') { comparison = false; query.focus() }
    renderReviewList()
    for (const [id, button] of panels) button.setAttribute('aria-current', id === panel ? 'page' : 'false')
    if (panel !== previousPanel && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const target = panel === 'files' ? filesPane : panel === 'agent' ? agentPane : center
      target.getAnimations().forEach(animation => animation.cancel())
      target.animate([{ opacity: .55, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' })
    }
    editor?.requestMeasure()
  }
  function addOutput(text) { output.textContent = (output.textContent + String(text)).slice(-100000); output.scrollTop = output.scrollHeight }
  async function runCurrent() {
    if (runController) return
    const commandText = command.value; workspace.command = commandText; runController = new AbortController(); runButton.disabled = true; stopButton.disabled = false; output.textContent = ''; preview.hidden = true; selectPanel('output')
    try { await persist(); const result = await executeProject(workspace, commandText, { native: options.native, request: options.request, signal: runController.signal, onOutput: addOutput }); addOutput('\n进程结束 · 退出码 ' + result.exitCode) }
    catch (error) { addOutput('\n' + error.message) }
    finally { runController = null; runButton.disabled = false; stopButton.disabled = true }
  }
  async function previewCurrent() { const path = /\.html?$/i.test(workspace.active) ? workspace.active : workspace.paths().find(item => /(^|\/)index.html$/i.test(item)); if (!path) throw Error('请先创建或打开 HTML 文件'); preview.hidden = false; selectPanel('output'); await showHtmlPreview(preview, htmlPreview(path, { ...workspace.files, ...workspace.drafts })) }
  async function importProject() {
    const input = node('input'); input.type = 'file'; input.accept = '.zip'; input.onchange = async () => {
      try {
        const file = input.files[0]; if (!file) return; if (file.size > MAX_PROJECT_BYTES) throw Error('ZIP 上限为 12 MB')
        let bytes = 0, count = 0; const skipped = []
        const archive = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: item => { if (item.name.endsWith('/')) return false; if (++count > 1000 || item.originalSize > MAX_FILE_BYTES || (bytes += item.originalSize) > MAX_PROJECT_BYTES) throw Error('解压后的项目超过大小上限'); return true } })
        const files = Object.create(null)
        for (const [path, data] of Object.entries(archive)) { try { files[path] = new TextDecoder('utf-8', { fatal: true }).decode(data); if (files[path].includes('\0')) { delete files[path]; skipped.push(path) } } catch { skipped.push(path) } }
        validateFiles(files); const next = new Workspace({ name: file.name.replace(/\.zip$/i, ''), files }); if (next.paths().length) next.open(next.paths()[0]); await selectWorkspace(next); notify(skipped.length ? `项目已导入，跳过 ${skipped.length} 个二进制文件` : '项目已导入')
      } catch (error) { report(error) }
    }; input.click()
  }
  async function exportProject() {
    const bytes = zipSync(Object.fromEntries(Object.entries({ ...workspace.files, ...workspace.drafts }).map(([path, text]) => [path, strToU8(text)])))
    const name = workspace.name.replace(/[\\/:*?"<>|]/g, '-') + '.zip'
    if (options.exportFile) await options.exportFile(name, bytes)
    else { const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })); const link = node('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
  }
  async function sendAgent() {
    if (agentController || !agentInput.value.trim()) return
    rememberChat()
    const targetWorkspace = workspace, chatId = workspace.chatId, messages = workspace.chat, text = agentInput.value.trim()
    const useWeb = workspace.chatSource === 'gpt-web'
    const controller = new AbortController(), task = { id: chatId, controller, source: useWeb ? 'gpt-web' : 'api', preparing: true, state: useWeb ? '正在连接 GPT 网页版…' : '正在连接模型…', modelValue: modelPicker.value }
    const settings = loadToolSettings()
    if (agentMode.value === 'ask') settings.enabled = false
    const attachments = [...references].filter(path => workspace.paths().includes(path)).slice(0, 6)
    const attachedContent = attachments.map(path => `\n<file path=${JSON.stringify(path)}>\n${workspace.content(path).slice(0, 12000)}\n</file>`).join('')
    const reasoningEffort = reasoningPicker.value
    agentController = controller; agentTask = task; closeHistory(); renderChat()
    let answer
    const request = options.request || httpRequest
    try {
      const config = useWeb ? { model: '网页当前模型' } : await options.getModel?.(); controller.signal.throwIfAborted()
      if (useWeb && !options.web) throw Error('请在桌面端打开 GPT 网页版会话')
      if (!useWeb && (!config?.endpoint || !config?.model)) throw Error('请先在供应商设置中选择模型')
      task.config = config; task.preparing = false; task.state = useWeb ? '等待网页接收消息…' : settings.enabled ? '正在处理项目任务…' : '正在回答 · 工具未启用'
      if (workspace.chatId === chatId) { agentInput.value = ''; references.clear(); renderReferences() }
      else { const session = workspace.conversation(chatId); session.draft = ''; session.references = [] }
      messages.push({ role: 'user', content: text, references: attachments, context: attachedContent }); answer = { role: 'assistant', content: '', parts: [], status: 'running', reasoningEffort }; messages.push(answer)
      if (useWeb) answer.web = { requestId: crypto.randomUUID(), messageId: crypto.randomUUID(), sessionId: chatId, thinking: workspace.chatThinking, prompt: text + (attachedContent ? '\n引用的项目内容：' + attachedContent : ''), mode: settings.enabled ? 'agent' : 'ask', source: 'chatgpt-web' }
      renderChat(workspace.chatId === chatId); refreshModels().catch(report)
      await persist()
      if (useWeb) { await runWebChat(targetWorkspace, answer, task); return }
      await runAgent({ messages: [{ role: 'system', content: 'You are the OpenStarry project Agent. Use enabled tools to inspect the project. File changes are proposals requiring user review. Do not claim a proposal has been saved or executed. Project: ' + targetWorkspace.name + '\n' + (config.rolePrompt || '') }, ...messages.filter(item => item.content).slice(-30).map(item => ({ role: item.role, content: item.content + (item.context ? '\nAttached project context (file contents):' + item.context : '') }))], settings, workspace: targetWorkspace, request, signal: controller.signal,
        complete: args => openAIComplete({ ...config, ...args, reasoningEffort, request }),
        execute: (command, signal, onOutput) => executeProject(targetWorkspace, command, { native: options.native, request, settings, signal, onOutput: text => { addOutput(text); onOutput?.(text) } }),
        ask: async (question, signal) => {
          task.waiting = true; task.state = '等待你的回答…'; renderChat(); options.notifyQuestion?.(question.question)
          if (workspace.chatId === chatId) selectPanel('agent')
          try { const result = await askQuestion(question, signal, questionDock); if (!result) { controller.abort(Error('已暂停，等待你的下一条指示')); signal.throwIfAborted() } return result }
          finally { task.waiting = false; scheduleChat() }
        },
        onProposal: async () => { await persist(); renderTree(); renderTabs(); if (currentPanel === 'review') renderEditor() },
        onEvent: event => {
          if (['text', 'reasoning'].includes(event.type)) {
            let part = answer.parts.find(part => part.type === event.type && part.id === event.id && event.id)
            if (!part) { part = { type: event.type, id: event.id, text: '' }; answer.parts.push(part); if (event.type === 'text' && answer.content) answer.content += '\n\n' }
            part.text += event.text
            if (event.type === 'text') answer.content += event.text
            task.state = event.type === 'reasoning' ? '正在思考…' : '正在接收回复…'
          } else if (event.type === 'notice') { if (!answer.parts.some(part => part.type === 'notice' && part.text === event.text)) answer.parts.push({ ...event }) }
          else if (event.type === 'tool' && settings.showTools) {
            const previous = answer.parts.find(part => part.type === 'tool' && part.id === event.id); if (previous) Object.assign(previous, event); else answer.parts.push({ ...event })
            task.state = (event.label || event.name) + ' · ' + ({ running: '调用中', complete: '完成', error: '失败', stopped: '已停止' }[event.phase])
          }
          scheduleChat()
        }
      })
      answer.status = 'complete'
    } catch (error) {
      if (answer) { answer.status = useWeb ? 'interrupted' : controller.signal.aborted ? 'stopped' : 'error'; answer.parts.push({ type: 'notice', text: error.message }); for (const part of answer.parts) if (part.phase === 'running') { part.phase = 'stopped'; part.text = error.message } }
      else report(error)
    }
    finally { cancelAnimationFrame(chatFrame); chatFrame = null; agentController = agentTask = null; if (!disposed) renderChat(); await persist(); await options.onChat?.(targetWorkspace); if (!disposed) { renderTree(); refreshModels().catch(report) } }
  }
  async function downloadWebFile(answer, path) {
    if (!options.web?.download || !answer.web?.taskId) throw Error('请在生成这个文件的普通 Edge 会话中下载')
    return options.web.download({ project: webProject(workspace), taskId: answer.web.taskId, path })
  }
  async function pullWebProposals(target) {
    const values = await options.web.proposals({ project: webProject(target) })
    for (const proposal of values) {
      if (target.proposals[proposal.path]) continue
      if (proposal.external) { target.proposeExternal(proposal.path, proposal.after, proposal.before ?? '', proposal.id); continue }
      target.propose(proposal.path, proposal.after, proposal.before ?? ''); target.proposals[proposal.path].webProposalId = proposal.id
    }
    await persist(); if (target === workspace) { renderTree(); renderTabs(); if (currentPanel === 'review') renderEditor() }
  }
  async function runWebChat(target, answer, task) {
    if (!answer.web.taskId) {
      const created = await options.web.submit({ project: webProject(target, true), ...answer.web })
      answer.web.taskId = created.id; await persist()
    }
    task.preparing = false
    task.cancel = async () => {
      await options.web.cancel({ project: webProject(target), taskId: answer.web.taskId })
      task.cancelRequested = true; task.state = webStates.cancel_requested; scheduleChat()
    }
    renderAgentControls()
    const result = await options.web.watch({ project: webProject(target), taskId: answer.web.taskId, signal: task.controller.signal,
      onEvent: event => { const state = applyWebEvent(answer, event); if (state) task.state = state; scheduleChat() } })
    applyWebEvent(answer, { type: 'reset', taskId: result.id, seq: result.lastSeq, snapshot: result })
    await pullWebProposals(target)
  }
  async function resumeWebChat() {
    if (agentController) throw Error('请先等待当前任务完成')
    const answer = [...workspace.chat].reverse().find(item => item.web)
    if (!answer) { notify('当前会话还没有网页回复'); return }
    const target = workspace, controller = new AbortController(), task = { id: workspace.chatId, controller, source: 'gpt-web', preparing: true, state: '正在恢复网页回复…', config: { model: '网页当前模型' } }
    agentController = controller; agentTask = task; renderChat()
    try { await runWebChat(target, answer, task) }
    catch (error) { answer.status = 'interrupted'; report(error) }
    finally { agentController = agentTask = null; if (!disposed) renderChat(); await persist(); refreshModels().catch(report) }
  }
  async function showWebConnection() {
    if (!options.web) { notify('GPT 网页版先在桌面端连接'); return }
    const target = workspace, project = webProject(target), dialog = node('dialog', 'os-provider-dialog os-web-dialog')
    dialog.setAttribute('aria-label', 'GPT 网页版连接')
    const head = node('header', 'os-provider-head'); head.append(node('h3', '', 'GPT 网页版'), button('关闭', () => dialog.close()))
    const content = node('div', 'os-provider-content'), feedback = node('p', 'os-provider-feedback', '正在读取连接状态…'); feedback.setAttribute('role', 'status')
    content.append(node('p', '', '在普通 Edge 加载 OpenStarry Bridge 扩展，点击下方按钮复制配对码，再粘贴到扩展中连接。沿用该浏览器的 ChatGPT 登录；模型与思考在网页中选择。仅提问不创建项目文件任务。'), feedback)
    const refresh = async () => { try { const state = await options.web.status({ project }); feedback.textContent = state.message + (state.lastError ? '\n' + state.lastError : ''); webStatus.textContent = state.message; } catch (error) { feedback.textContent = error.message } }
    content.append(button('连接 Edge / 复制配对码', async () => { try { feedback.textContent = '正在准备扩展连接…'; const state = await options.web.show({ project }); feedback.textContent = state.message; } catch (error) { feedback.textContent = error.message } }), button('刷新连接状态', refresh), button('刷新待审查修改', async () => { try { await pullWebProposals(target); feedback.textContent = '待审查修改已刷新' } catch (error) { feedback.textContent = error.message } }))
    const details = node('details'), summary = node('summary', '', '项目文件工具与连接诊断'); details.append(summary, node('p', '', '项目文件工具需要 ChatGPT 中的 guess 连接器。启动公网连接后复制地址，在网页连接器设置中更新。项目或临时地址改变后需重新核对连接。地址包含访问凭据，请只用于自己的连接器。'))
    const tunnelFeedback = node('p', 'os-provider-feedback'); details.append(tunnelFeedback)
    const tunnelStatus = async () => { const state = await options.web.tunnelStatus({ project }); tunnelFeedback.textContent = '公网连接：' + state.status + (state.origin ? '\n' + state.origin : '') }
    details.append(button('启动公网连接', async () => { try { await options.web.startTunnel({ project }); await tunnelStatus() } catch (error) { tunnelFeedback.textContent = error.message } }), button('刷新公网状态', async () => { try { await tunnelStatus() } catch (error) { tunnelFeedback.textContent = error.message } }), button('复制连接器地址', async () => { try { await options.web.copyAddress({ project }); tunnelFeedback.textContent = '地址已复制，请粘贴到你自己的 ChatGPT 连接器设置中' } catch (error) { tunnelFeedback.textContent = error.message } }))
    content.append(details); dialog.append(head, content); agentPane.append(dialog)
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.show(); await refresh()
  }
  agentInput.onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); sendAgent().catch(report) } }
  const onHide = () => { clearTimeout(saveTimer); persist() }; document.addEventListener('visibilitychange', onHide)
  await renderProjectSelect(); renderAll(); renderReferences(); selectPanel('editor'); refreshModels().catch(report)
  void refreshSubagents()
  return { refresh: () => { renderAll(); renderProjectSelect().catch(report); refreshModels().catch(report) }, setTheme: theme => { const next = localStorage.getItem('openstarry.ide.theme') || theme; if (root.dataset.theme !== next) { root.dataset.theme = next; renderEditor() } }, destroy: () => { if (disposed) return; disposed = true; clearTimeout(subagentTimer); subagentView?.close(); sandboxView?.close(); safetyPicker.destroy(); for (const view of activeMessageViews) view.close(); activeMessageViews.clear(); clearTimeout(saveTimer); cancelAnimationFrame(chatFrame); agentController?.abort(Error('IDE 已关闭')); runController?.abort(Error('IDE 已关闭')); document.removeEventListener('visibilitychange', onHide); closeHtmlPreview(preview); projectSelect.destroy(); agentMode.destroy(); sourcePicker.destroy(); modelPicker.destroy(); reasoningPicker.destroy(); chatTabs.destroy(); persist(); editor?.destroy(); root.remove() } }
}
