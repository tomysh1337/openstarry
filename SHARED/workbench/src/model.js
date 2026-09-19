// Projects and unsaved drafts stay local. Agent proposals never overwrite saved files.
export const MAX_FILE_BYTES = 1024 * 1024
export const MAX_PROJECT_BYTES = 12 * 1024 * 1024
export function projectPath(value) {
  const path = String(value || '').replaceAll('\\', '/')
  if (!path || path.length > 240 || /[\x00-\x1f:]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw Error('请输入项目内的相对文件路径')
  return path
}
export function validateFiles(files) {
  const next = Object.create(null); let bytes = 0
  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length > 1000) throw Error('项目最多包含 1000 个文本文件')
  const seen = new Set()
  for (const [path, content] of Object.entries(files)) {
    projectPath(path)
    if (typeof content !== 'string' || content.includes('\0')) throw Error('仅支持文本文件：' + path)
    const size = new TextEncoder().encode(content).length
    if (size > MAX_FILE_BYTES) throw Error('单文件上限为 1 MB：' + path)
    if (seen.has(path.toLowerCase())) throw Error('存在大小写重复路径：' + path)
    seen.add(path.toLowerCase()); bytes += size; next[path] = content
  }
  if (bytes > MAX_PROJECT_BYTES) throw Error('项目文本总大小上限为 12 MB')
  for (const path of Object.keys(next)) {
    const parts = path.split('/'); parts.pop()
    while (parts.length) { if (seen.has(parts.join('/').toLowerCase())) throw Error('文件与目录路径冲突：' + path); parts.pop() }
  }
  return next
}
export class Workspace {
  constructor(data = {}) {
    this.id = data.id || globalThis.crypto.randomUUID()
    this.name = data.name || '未命名项目'
    this.files = validateFiles(data.files || {})
    this.drafts = { ...(data.drafts || {}) }
    this.proposals = { ...(data.proposals || {}) }
    this.tabs = (data.tabs || []).filter(path => path in this.files || path in this.proposals)
    this.active = this.tabs.includes(data.active) ? data.active : this.tabs[0] || ''
    this.chat = data.chat || []
    this.chatSessions = data.chatSessions || []
    this.nativeRoot = data.nativeRoot || ''
    this.diskFiles = { ...(data.diskFiles || {}) }
    this.command = data.command || ''
  }
  paths() { return [...new Set([...Object.keys(this.files), ...Object.keys(this.proposals)])].sort() }
  content(path) { return this.drafts[path] ?? this.files[path] ?? '' }
  open(path) { if (!this.paths().includes(path)) throw Error('文件已不存在'); if (!this.tabs.includes(path)) this.tabs.push(path); this.active = path }
  edit(path, content) { projectPath(path); if (new TextEncoder().encode(content).length > MAX_FILE_BYTES) throw Error('文件超过 1 MB'); if (content === this.files[path]) delete this.drafts[path]; else this.drafts[path] = content }
  create(path, content = '') { path = projectPath(path); if (this.paths().includes(path)) throw Error('文件已存在'); validateFiles({ ...this.files, [path]: content }); this.files[path] = content; this.open(path) }
  save(path) { const value = this.content(path); validateFiles({ ...this.files, [path]: value }); this.files[path] = value; delete this.drafts[path] }
  propose(path, content, base = this.content(path)) {
    path = projectPath(path); validateFiles({ ...this.files, [path]: content })
    this.proposals[path] = { base, content, created: Date.now() }; this.open(path)
  }
  checkProposal(path) {
    const proposal = this.proposals[path]
    if (!proposal) throw Error('没有待审查修改')
    if (this.content(path) !== proposal.base) throw Error('文件在提案后发生变化，请撤销提案后重新生成，避免覆盖你的编辑')
    return proposal
  }
  accept(path) { const proposal = this.checkProposal(path); this.files[path] = proposal.content; delete this.drafts[path]; delete this.proposals[path] }
  reject(path) { delete this.proposals[path]; if (!(path in this.files)) this.close(path) }
  close(path) { this.tabs = this.tabs.filter(item => item !== path); if (this.active === path) this.active = this.tabs.at(-1) || '' }
  rename(path, next) {
    projectPath(next); if (this.paths().some(item => item.toLowerCase() === next.toLowerCase())) throw Error('目标文件已存在')
    const files = { ...this.files }; delete files[path]; files[next] = this.files[path]; validateFiles(files)
    this.files = files
    for (const collection of [this.drafts, this.proposals]) if (path in collection) { collection[next] = collection[path]; delete collection[path] }
    this.tabs = this.tabs.map(item => item === path ? next : item); if (this.active === path) this.active = next
  }
  remove(path) { delete this.files[path]; delete this.drafts[path]; delete this.proposals[path]; this.close(path) }
  search(query) {
    if (!query.trim()) return []
    const needle = query.toLocaleLowerCase(), results = []
    for (const path of this.paths()) {
      this.content(path).split('\n').forEach((text, index) => { if (results.length < 200 && text.toLocaleLowerCase().includes(needle)) results.push({ path, line: index + 1, text: text.slice(0, 220) }) })
    }
    return results
  }
  snapshot() { return JSON.parse(JSON.stringify(this)) }
}
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('openstarry-workbench', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('projects', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
}
async function transact(mode, action) {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('projects', mode); const request = action(tx.objectStore('projects'))
    tx.oncomplete = () => { db.close(); resolve(request.result) }
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || Error('项目保存失败')) }
  })
}
export const projectStore = {
  list: () => transact('readonly', store => store.getAll()),
  load: async id => { const value = await transact('readonly', store => store.get(id)); return value ? new Workspace(value) : null },
  save: workspace => transact('readwrite', store => store.put(workspace.snapshot()))
}
