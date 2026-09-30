import { applyWebEvent, webStates } from '@openstarry/workbench/webChat'

const clone = value => JSON.parse(JSON.stringify(value))
const done = status => ['complete', 'stopped', 'error'].includes(status)
export const isHomeWebId = value => typeof value === 'string' && /^home-web-[\w-]+$/.test(value)

export function createHomeWebStore(indexedDB = globalThis.indexedDB) {
  async function transact(mode, operation) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('openstarry-home-web', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'key' })
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('sessions', mode), request = operation(transaction.objectStore('sessions'))
      transaction.oncomplete = () => { db.close(); resolve(request.result) }
      transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error || Error('本机网页会话保存失败')) }
    })
  }
  return {
    list: async owner => (await transact('readonly', store => store.getAll())).filter(row => row.owner === owner && row.kind === 'chat' && !row.deleted),
    preferences: owner => transact('readonly', store => store.get(owner + ':preferences')),
    save: (owner, session) => transact('readwrite', store => store.put({ ...clone(session), owner, key: owner + ':' + session.id, kind: 'chat' })),
    savePreferences: (owner, values) => transact('readwrite', store => store.put({ ...clone(values), owner, key: owner + ':preferences', kind: 'preferences' }))
  }
}

// Homepage state is independent of the API backend and contains no browser credentials.
// The exact same local service and event reducer as the IDE handle delivery and recovery.
export class HomeWebChat {
  constructor({ api, store = createHomeWebStore(), state = { sessions: [], ready: false }, onChange = () => {} }) {
    Object.assign(this, { api, store, state, onChange }); this.active = new Map(); this.saves = new Map(); this.timers = new Map(); this.jobs = new Set()
  }
  async load(owner) {
    this.owner = String(owner)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.owner))
    this.project = { id: 'home-chat-' + [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('').slice(0, 24), name: '首页网页对话', nativeRoot: '', files: {} }
    this.state.sessions = await this.store.list(this.owner)
    for (const session of this.state.sessions) {
      session.busy = false
      for (const turn of session.turns) if (!done(turn.answer.status)) turn.answer.status = 'interrupted'
    }
    this.state.ready = true; this.onChange()
    return await this.store.preferences(this.owner) || { source: 'api' }
  }
  get(id) { return this.state.sessions.find(session => session.id === id && !session.deleted) }
  async create() {
    if (!this.state.ready) throw Error('本机网页历史仍在加载')
    const value = { id: 'home-web-' + crypto.randomUUID(), title: '新的网页对话', draft: '', thinking: false, turns: [], createdAt: Date.now(), updatedAt: Date.now(), star: false, busy: false }
    this.state.sessions.unshift(value)
    const session = this.get(value.id)
    try { await this.persist(session) } catch (error) { this.state.sessions.splice(this.state.sessions.indexOf(session), 1); throw error }
    this.onChange(); return session
  }
  persist(session) {
    clearTimeout(this.timers.get(session.id)); this.timers.delete(session.id)
    const snapshot = clone(session), owner = this.owner
    const pending = (this.saves.get(session.id) || Promise.resolve()).catch(() => {}).then(() => this.store.save(owner, snapshot))
    this.saves.set(session.id, pending); return pending
  }
  changed(session) {
    this.onChange()
    if (!this.timers.has(session.id)) this.timers.set(session.id, setTimeout(() => {
      void this.persist(session).catch(error => { session.storageError = error.message; this.onChange() })
    }, 250))
  }
  draft(id, text) { const session = this.get(id); if (session) { session.draft = text; this.changed(session) } }
  async update(id, values) {
    const session = this.get(id); if (!session) throw Error('网页对话已不存在')
    if (values.deleted && (session.busy || session.turns.some(turn => !done(turn.answer.status)))) throw Error('请先恢复并停止这条网页回复，再删除对话')
    if ('thinking' in values && typeof values.thinking !== 'boolean') throw Error('思考开关格式错误')
    for (const key of ['title', 'star', 'deleted', 'thinking']) if (key in values) session[key] = values[key]
    await this.persist(session); this.onChange()
  }
  track(operation) {
    if (this.closed) return Promise.reject(Error('页面已关闭，请重新打开对话'))
    const job = operation(); this.jobs.add(job)
    void job.finally(() => this.jobs.delete(job)).catch(() => {})
    return job
  }
  send(id, text, quote = '') { return this.track(() => this.sendNow(id, text, quote)) }
  async sendNow(id, text, quote = '') {
    const session = this.get(id)
    if (!session || session.busy) throw Error('请等待当前网页回复完成')
    if (session.turns.some(turn => !done(turn.answer.status))) throw Error('上次网页回复尚待核对，请先恢复回复')
    const prompt = text.trim() + (quote ? '\n\n引用内容：\n' + quote : '')
    if (!text.trim() || prompt.length > 15000) throw Error('网页消息与引用合计请控制在 15000 字符以内')
    const turn = { id: crypto.randomUUID(), text: text.trim(), quote, createdAt: Date.now(), answer: { content: '', parts: [], status: 'running', web: { requestId: crypto.randomUUID(), messageId: crypto.randomUUID(), sessionId: session.id, prompt, thinking: Boolean(session.thinking), mode: 'ask', source: 'chatgpt-web' } } }
    session.turns.push(turn); session.draft = ''; session.updatedAt = Date.now()
    if (session.turns.length === 1) session.title = text.trim().slice(0, 80)
    session.busy = true
    try { await this.persist(session) }
    catch (error) { session.busy = false; session.turns.pop(); session.draft = text; throw error }
    return this.run(session, session.turns.at(-1))
  }
  resume(id) { return this.track(() => this.resumeNow(id)) }
  async resumeNow(id) {
    const session = this.get(id), turn = session?.turns.at(-1)
    if (!turn) throw Error('当前对话还没有网页回复')
    if (this.active.has(id) || done(turn.answer.status)) return
    return this.run(session, turn)
  }
  async run(session, turn) {
    if (this.closed) { session.busy = false; turn.answer.status = 'interrupted'; await this.persist(session); return }
    const controller = new AbortController(), answer = turn.answer
    this.active.set(session.id, controller); session.busy = true; session.statusText = '正在连接网页…'; this.onChange()
    try {
      if (!answer.web.taskId) {
        const created = await this.api.submit({ project: this.project, ...answer.web, mode: 'ask' })
        answer.web.taskId = created.id; await this.persist(session)
      }
      if (turn.cancelRequested) await this.api.cancel({ project: this.project, taskId: answer.web.taskId })
      const result = await this.api.watch({ project: this.project, taskId: answer.web.taskId, signal: controller.signal,
        onEvent: event => { const status = applyWebEvent(answer, event); if (status) session.statusText = status; this.changed(session) } })
      applyWebEvent(answer, { type: 'reset', taskId: result.id, seq: result.lastSeq, snapshot: result })
      session.statusText = webStates[result.status] || ''
    } catch (error) {
      if (!done(answer.status)) answer.status = 'interrupted'
      session.statusText = error.message
      if (!answer.parts.some(part => part.type === 'notice' && part.text === error.message)) answer.parts.push({ type: 'notice', text: error.message })
    } finally {
      this.active.delete(session.id); session.busy = false; session.updatedAt = Date.now()
      await this.persist(session); this.onChange()
    }
  }
  async cancel(id) {
    const session = this.get(id), turn = session?.turns.at(-1)
    if (!turn || done(turn.answer.status)) return
    turn.cancelRequested = true; await this.persist(session)
    if (turn.answer.web.taskId) await this.api.cancel({ project: this.project, taskId: turn.answer.web.taskId })
    session.statusText = webStates.cancel_requested; this.onChange()
    if (!this.active.has(id)) return this.resume(id)
  }
  close() {
    if (this.closing) return this.closing
    this.closed = true
    for (const controller of this.active.values()) controller.abort(Error('页面已关闭，回复可恢复查看'))
    this.closing = (async () => {
      await Promise.allSettled([...this.jobs])
      await Promise.all(this.state.sessions.map(session => this.persist(session)))
    })()
    return this.closing
  }
}

const projectedTurns = new WeakMap()
export function homeWebMessages(session, owner, project) {
  return (session?.turns || []).flatMap(turn => {
    const common = { id: turn.id, cid: owner, hid: session.id, created_at: new Date(turn.createdAt).toISOString() }
    const startedAt = Date.parse(turn.answer.web.startedAt) || turn.createdAt
    const finishedAt = Date.parse(turn.answer.web.finishedAt) || (session.busy && turn.answer.status === 'running' ? Date.now() : NaN)
    const duration = Number.isFinite(finishedAt) ? Math.max(0, finishedAt - startedAt) : undefined
    const messages = [
      { ...common, role: 'human', node_id: turn.id + '-human', chunks: [{ label_type: 'content', content: turn.text + (turn.quote ? '\n\n引用内容：\n' + turn.quote : '') }], pending: false, extra: {} },
      { ...common, role: 'ai', node_id: turn.id + '-ai', parent_id: turn.id + '-human', chunks: [{ label_type: 'content', content: turn.answer.content }], pending: session.busy && !done(turn.answer.status), label: session.statusText,
        extra: { gptWeb: { project, taskId: turn.answer.web.taskId, artifacts: turn.answer.web.artifacts || [], tools: turn.answer.parts.filter(part => part.type === 'tool'), source: turn.answer.web.source, status: turn.answer.status, notices: turn.answer.parts.filter(part => part.type === 'notice').map(part => part.text) } }, info: { model_provider: 'GPT 网页版', total_duration: duration } }
    ]
    const previous = projectedTurns.get(turn)
    messages.forEach((message, index) => { message.selected = previous?.[index].selected || false })
    projectedTurns.set(turn, messages)
    return messages.filter(message => !turn.hiddenRoles?.includes(message.role))
  })
}
