const node = (tag, text = '') => { const el = document.createElement(tag); el.textContent = text; return el }
const labels = { awaiting_approval: '等待批准', queued: '排队中', running: '执行中', completed: '已完成', error: '失败', cancelled: '已停止', cancel_requested: '正在停止', rejected: '已拒绝', interrupted: '执行已中断' }
export function createSandboxView({ services }) {
  const element = node('section'); element.className = 'os-sandbox-view'; element.setAttribute('aria-label', 'OpenSandbox')
  const heading = node('strong', 'OpenSandbox'), state = node('p'), check = node('button', '检查连接'), list = node('div'), detail = node('article'), feedback = node('p')
  check.type = 'button'; feedback.setAttribute('role', 'status'); element.append(heading, state, check, list, detail, feedback)
  let projectId, jobs = [], selected, disposed = false, busy = false, revision = 0, signature = ''
  async function run(action, job, offset = 0) {
    if (busy || !projectId || disposed) return
    const current = revision; busy = true; render()
    try {
      const result = await services({ action, projectId, ...(job ? { executionId: job.id, offset } : {}) })
      if (!disposed && current === revision) { selected = result.execution || selected; feedback.textContent = result.message || ''; if (result.sandbox) jobs = result.sandbox.jobs; signature = ''; render() }
    } catch (error) { if (!disposed && current === revision) feedback.textContent = error.message }
    finally { busy = false; if (!disposed) render() }
  }
  const actionButton = (text, action, job, offset = 0) => { const button = node('button', text); button.type = 'button'; button.disabled = busy; button.onclick = () => void run(action, job, offset); return button }
  function render() {
    check.disabled = busy || !projectId
    const next = JSON.stringify([jobs, busy])
    if (next !== signature) { signature = next; list.replaceChildren(...jobs.map(job => actionButton(`${job.command.slice(0, 60)} · ${labels[job.status] || job.status}`, 'sandbox-read', job))) }
    if (!selected) { detail.replaceChildren(); return }
    const title = node('strong', labels[selected.status] || selected.status), command = node('pre', selected.command), network = node('p', `网络：${selected.network ? '允许' : '禁止'} · 上限 ${selected.timeout_seconds} 秒`), output = node('pre', selected.output || '暂无输出')
    const controls = node('div')
    if (selected.status === 'awaiting_approval') controls.append(actionButton('批准本次执行', 'sandbox-approve', selected), actionButton('拒绝', 'sandbox-reject', selected))
    else if (!selected.done) controls.append(actionButton('停止执行', 'sandbox-cancel', selected))
    if (selected.offset) controls.append(actionButton('从头查看', 'sandbox-read', selected))
    if (selected.next_offset != null) controls.append(actionButton('后续输出', 'sandbox-read', selected, selected.next_offset))
    detail.replaceChildren(title, command, network, output, controls)
    if (selected.error || selected.cleanupError) detail.append(node('p', [selected.error, selected.cleanupError].filter(Boolean).join('\n')))
    if (selected.truncated) detail.append(node('p', '输出已达到 64 KiB 保存上限'))
  }
  check.onclick = () => void run('sandbox-health')
  return { element,
    update(value, currentProject) {
      if (projectId !== currentProject) { revision++; projectId = currentProject; selected = null; feedback.textContent = '' }
      jobs = value?.jobs || []; state.textContent = value?.configured ? '本机配置已准备 · 容器独立执行，无宿主目录挂载' : '待本机部署 Docker 和 OpenSandbox'
      if (selected && !jobs.some(job => job.id === selected.id)) selected = null
      render()
    },
    refresh() { if (selected && !busy) return run('sandbox-read', selected, selected.offset) },
    close() { disposed = true; revision++ }
  }
}
