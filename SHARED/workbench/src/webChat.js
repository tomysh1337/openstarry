export const webStates = { queued: '等待网页领取…', waiting_web: '等待网页准备…', sending: '正在向网页发送…', generating: '正在接收网页回复…', cancel_requested: '正在等待网页停止确认…', cancelled: '网页已停止', completed: '网页回复完成', error: '网页回复遇到问题', interrupted: '网页任务中断，可恢复查看' }
export const webProject = (workspace, files = false) => ({ id: workspace.id, name: workspace.name, nativeRoot: workspace.nativeRoot, ...(files && !workspace.nativeRoot ? { files: workspace.files } : {}) })
export function applyWebEvent(answer, event) {
  answer.web ||= {}
  if (event.type === 'connection') return event.message
  if (answer.web.taskId && event.taskId !== answer.web.taskId) return ''
  if (event.type !== 'reset' && Number.isFinite(answer.web.seq) && event.seq <= answer.web.seq) return ''
  if (Number.isFinite(event.seq)) answer.web.seq = event.seq
  answer.parts ||= []
  const textPart = () => {
    let part = answer.parts.find(p => p.id === 'gpt-web-text')
    if (!part) { part = { type: 'text', id: 'gpt-web-text', text: '' }; answer.parts.push(part) }
    return part
  }
  const tool = value => {
    let part = answer.parts.find(p => p.type === 'tool' && p.id === value.toolId)
    if (!part) { part = { type: 'tool', id: value.toolId }; answer.parts.push(part) }
    Object.assign(part, { name: value.name || part.name, provider: value.provider || part.provider, input: value.input ?? part.input, output: value.output ?? part.output ?? '', durationMs: value.durationMs ?? part.durationMs, phase: value.status === 'completed' ? value.error ? 'error' : 'complete' : 'running' })
  }
  const status = value => {
    answer.web.status = value
    answer.status = ({ completed: 'complete', cancelled: 'stopped', error: 'error', interrupted: 'interrupted' })[value] || 'running'
    return webStates[value] || ''
  }
  if (event.type === 'reset') {
    const snapshot = event.snapshot
    answer.web.startedAt = snapshot.createdAt
    answer.web.finishedAt = snapshot.finishedAt || (['completed', 'error', 'cancelled'].includes(snapshot.status) ? snapshot.updatedAt : undefined)
    answer.content = snapshot.text; textPart().text = snapshot.text
    answer.web.artifacts = snapshot.artifacts || [];
    answer.web.webConversationId = snapshot.webConversationId; answer.web.taskId = snapshot.id; answer.web.source = snapshot.source
    for (const value of Object.values(snapshot.tools || {})) tool(value)
    if (snapshot.error?.message && !answer.parts.some(p => p.type === 'notice' && p.text === snapshot.error.message)) answer.parts.push({ type: 'notice', text: snapshot.error.message })
    return status(snapshot.status)
  }
  answer.web.startedAt ||= event.timestamp
  if (['completed', 'cancelled', 'error'].includes(event.type)) answer.web.finishedAt = event.timestamp
  if (event.type === 'text_delta') { answer.content += event.payload.text; textPart().text = answer.content }
  else if (event.type === 'text_snapshot') { answer.content = event.payload.text; textPart().text = answer.content }
  else if (event.type === 'file_links') answer.web.artifacts = event.payload.artifacts
  else if (event.type.startsWith('tool_')) tool({ ...event.payload, status: event.type === 'tool_completed' ? 'completed' : 'running' })
  else if (event.type === 'error') { answer.parts.push({ type: 'notice', text: event.payload.message }); return status('error') }
  else if (['completed', 'cancelled', 'cancel_requested', 'interrupted', 'queued'].includes(event.type)) return status(event.type)
  else if (event.type === 'claimed') return status('waiting_web')
  else if (event.type === 'dispatching') return status('sending')
  else if (['started', 'resumed'].includes(event.type)) { answer.web.webConversationId = event.payload.webConversationId; return status('generating') }
  return webStates[answer.web.status] || '正在接收网页回复…'
}
