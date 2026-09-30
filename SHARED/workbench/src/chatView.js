import { createTextReveal } from './textReveal.js'

const node = (tag, cls = '', text = '') => { const value = document.createElement(tag); value.className = cls; value.textContent = text; return value }
const setText = (element, text = '') => { if (element.textContent !== text) element.textContent = text }
const toolNames = { list_files: '浏览项目文件', read_file: '读取文件', propose_file: '生成修改提案', search_project: '搜索项目', run_project: '运行项目', read_web: '读取网页', search_web: '搜索网页', read_project_skills: '读取项目说明', ask_user: '向你提问' }
const phases = { running: '进行中', complete: '完成', error: '失败', stopped: '已停止' }

// Keep message and details elements mounted while deltas arrive.
export function createChatMessage(item, { markdown, icon, openFile, hasProposal, download, onResize = () => {} }) {
  const article = node('article', 'os-chat-message os-role-' + item.role)
  const label = node('div', 'os-message-label', item.role === 'user' ? '你' : item.web ? 'GPT 网页版' : 'OpenStarry')
  if (item.role !== 'user') label.prepend(icon('agent'))
  const sourceBadge = node('small', 'os-message-source', '模拟测试'); sourceBadge.hidden = true; label.append(sourceBadge)
  const elapsed = node('small', 'os-message-elapsed'); label.append(elapsed)
  article.append(label)
  for (const path of item.references || []) { const ref = node('span', 'os-message-reference', path); ref.prepend(icon('editor')); article.append(ref) }
  const thinking = node('div', 'os-thinking', '正在思考'), cursor = node('span', 'os-stream-cursor')
  cursor.setAttribute('aria-hidden', 'true')
  const files = node('div', 'os-web-files'), downloadStatus = node('p', 'os-message-notice')
  downloadStatus.setAttribute('role', 'status'); downloadStatus.hidden = true
  let fileSignature = '', downloading = false
  async function downloadFile(path) {
    if (downloading) return
    downloading = true; downloadStatus.hidden = false; setText(downloadStatus, '正在请求普通 Edge 下载…')
    try {
      if (!download || !item.web) throw Error('请在生成这个文件的原网页会话中下载')
      const result = await download(path); setText(downloadStatus, result.message)
    } catch (error) { setText(downloadStatus, error.message) }
    finally { downloading = false }
  }
  const views = new Map(), fallback = { type: 'text', text: item.content }
  function createPart(part) {
    if (part.type === 'tool') {
      const element = node('details', 'os-tool-event'), summary = node('summary')
      const indicator = node('span', 'os-tool-indicator'), title = node('span'), state = node('small')
      summary.append(indicator, title, state)
      const body = node('div', 'os-tool-details'), identity = node('div', 'os-tool-identity')
      body.append(identity)
      const fields = {}
      for (const [name, text] of [['input', '输入参数'], ['output', '实时输出'], ['result', '执行结果'], ['text', '错误信息']]) {
        const field = node('section'), pre = node('pre'); field.append(node('h4', '', text), pre); body.append(field); fields[name] = { field, pre }
      }
      const review = node('button', '', '审查修改'); review.type = 'button'; review.onclick = () => openFile(part.path); body.append(review)
      element.append(summary, body)
      return { element, update() {
        element.dataset.phase = part.phase
        setText(title, (part.provider ? part.provider + ' · ' : '') + (toolNames[part.name] || part.label || part.name))
        setText(indicator, part.phase === 'complete' ? '✓' : part.phase === 'error' ? '!' : part.phase === 'stopped' ? '■' : '·')
        const duration = part.durationMs ?? part.duration
        setText(state, (phases[part.phase] || '') + (Number.isFinite(duration) ? ` · ${(duration / 1000).toFixed(1)}s` : ''))
        setText(identity, `${part.label || part.name} · ${part.id}`)
        for (const [name, { field, pre }] of Object.entries(fields)) {
          const value = part[name] || (name === 'result' && part.phase === 'complete' ? part.detail || '工具已完成（旧记录未保存完整结果）' : '')
          field.hidden = !value; setText(pre, value)
        }
        review.hidden = part.name !== 'propose_file' || !hasProposal(part.path)
      } }
    }
    if (part.type === 'reasoning') {
      const element = node('details', 'os-reasoning-content'), body = node('div', 'os-reasoning-text')
      element.append(node('summary', '', '思考摘要'), body)
      return { element, update: () => setText(body, part.text) }
    }
    const element = node('div', part.type === 'notice' ? 'os-message-notice' : 'os-message-content')
    const render = text => {
      if (item.role === 'user' || part.type === 'notice') setText(element, text)
      else {
        element.innerHTML = markdown.render(text || '')
        for (const link of element.querySelectorAll('a')) {
          const href = link.getAttribute('href') || ''
          if (href.startsWith('sandbox:')) {
            link.removeAttribute('href'); link.classList.add('os-web-download'); link.tabIndex = 0; link.setAttribute('role', 'button')
            link.onclick = event => { event.preventDefault(); void downloadFile(href) }
            link.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); void downloadFile(href) } }
          } else if (!/^https?:\/\//i.test(href)) link.removeAttribute('href')
          else { link.target = '_blank'; link.rel = 'noopener noreferrer' }
        }
      }
      onResize()
    }
    const reveal = createTextReveal({ onText: render, visible: () => article.isConnected && !document.hidden })
    return { element, update() { reveal.update(part.text, { streaming: false }) }, close: () => reveal.close(), flush: () => reveal.flush() }
  }
  return { element: article, close() { for (const view of views.values()) view.close?.() }, flush() { for (const view of views.values()) view.flush?.() }, update() {
    sourceBadge.hidden = item.web?.source !== 'fixture'
    const start = Date.parse(item.web?.startedAt), finish = item.web?.finishedAt ? Date.parse(item.web.finishedAt) : item.status === 'running' ? Date.now() : NaN
    elapsed.hidden = !Number.isFinite(start) || !Number.isFinite(finish)
    setText(elapsed, !elapsed.hidden ? `耗时 ${Math.max(0, (finish - start) / 1000).toFixed(1)}s` : '')
    const artifacts = item.web?.artifacts || [], signature = JSON.stringify(artifacts)
    if (signature !== fileSignature) {
      fileSignature = signature
      files.replaceChildren(...artifacts.map(file => {
        const button = node('button', '', '下载 ' + file.name); button.type = 'button'
        button.onclick = () => { void downloadFile(file.path) }; return button
      }))
    }
    files.hidden = !artifacts.length
    fallback.text = item.content
    let parts = item.parts?.length ? item.parts : item.content ? [fallback] : []
    if (item.web) {
      fallback.text = parts.find(part => part.type === 'text')?.text || item.content || ''
      parts = [...parts.filter(part => part.type === 'tool'), fallback, ...parts.filter(part => !['text', 'tool'].includes(part.type))]
    }
    for (const part of parts) {
      let view = views.get(part)
      if (!view) { view = createPart(part); views.set(part, view) }
      article.append(view.element)
      view.update()
    }
    const running = item.status === 'running'
    article.dataset.status = item.status || 'complete'
    if (item.status === 'interrupted') {
      let notice = article.querySelector('.os-interrupted')
      if (!notice) { notice = node('div', 'os-message-notice os-interrupted', '上次运行已中断，已接收内容保留在本机。'); article.append(notice) }
    }
    thinking.hidden = !running || parts.some(part => part.type === 'text' || part.type === 'tool')
    cursor.hidden = !running || !parts.some(part => part.type === 'text')
    article.append(thinking, cursor, files, downloadStatus)
  } }
}
