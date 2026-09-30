import { subagentLabel as label, subagentProgress, orderSubagents } from './subagentProgress.js'
const element = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node }

export function createSubagentView({ services }) {
  const host = element('section'), list = element('div'), detail = element('div'), feedback = element('p'), text = element('pre')
  host.className = 'os-subagents'; host.setAttribute('aria-label', '子 Agent 任务'); feedback.setAttribute('role', 'status')
  list.className = 'os-subagent-list'
  text.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;user-select:text'
  host.append(element('strong', '子 Agent 任务'), list, detail, feedback)
  let projectId, children = [], selected, busy = false, disposed = false, revision = 0, signature = ''
  const button = (text, action, disabled = false) => { const node = element('button', text); node.type = 'button'; node.disabled = busy || disabled; node.onclick = action; return node }
  function render() {
    list.replaceChildren(...orderSubagents(children).map(child => {
      const item = button('', () => read(child)), progress = element('small', subagentProgress(child))
      item.setAttribute('aria-pressed', String(selected?.id === child.id))
      item.append(element('strong', child.name), progress)
      if (child.error) item.append(element('span', (child.error.code ? child.error.code + ' · ' : '') + child.error.message))
      else if (child.progress?.preview) item.append(element('span', child.progress.preview))
      return item
    }))
    const scrollTop = text.scrollTop
    detail.replaceChildren()
    if (!selected) return
    text.textContent = selected.text || (selected.done ? '此任务未返回正文。' : '等待子 Agent 返回内容…')
    detail.append(element('strong', selected.name + ' · ' + label(selected.status)), text)
    text.scrollTop = scrollTop
    if (selected.error) detail.append(element('p', selected.error.message))
    if (selected.pending_proposals?.length) detail.append(element('p', selected.pending_proposals.length + ' 个文件提议等待本机审查'))
    if (selected.offset) detail.append(button('从头查看', () => read(selected)))
    if (selected.next_offset !== null) detail.append(button('后续内容', () => read(selected, selected.next_offset)))
    detail.append(button('停止子 Agent', () => read(selected, selected.offset, 'subagent-cancel'), selected.done || selected.status === 'cancel_requested'))
  }
  async function read(child, offset = 0, action = 'subagent-read') {
    if (busy || disposed) return
    busy = true; feedback.textContent = ''; const current = revision
    render()
    try {
      const value = await services({ action, projectId, parentTaskId: child.task_id, subagentId: child.id, offset })
      if (!disposed && current === revision && children.some(item => item.id === child.id)) { selected = value.subagent; feedback.textContent = value.message || '' }
    } catch (error) { if (!disposed && current === revision) feedback.textContent = error.message }
    finally { busy = false; if (!disposed) render() }
  }
  return {
    element: host,
    update(next, owner) {
      if (disposed) return
      if (owner !== projectId) { projectId = owner; selected = null; feedback.textContent = ''; revision++ }
      children = next
      if (selected && !children.some(child => child.id === selected.id)) selected = null
      if (!selected && children.length) selected = { ...orderSubagents(children)[0], offset: 0, next_offset: null }
      else if (selected) selected = { ...selected, ...children.find(child => child.id === selected.id) }
      const encoded = JSON.stringify([owner, children, children.map(subagentProgress)])
      if (signature !== encoded) { signature = encoded; render() }
      host.hidden = !children.length
    },
    refresh: () => selected ? read(selected, selected.offset) : Promise.resolve(),
    close() { disposed = true; revision++; host.remove() }
  }
}
