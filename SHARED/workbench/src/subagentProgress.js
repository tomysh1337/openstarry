export const subagentLabel = status => ({ queued: '排队中', waiting_web: '准备网页', sending: '发送中', generating: '生成中', interrupted: '等待恢复', cancel_requested: '正在停止', completed: '已完成', cancelled: '已停止', error: '失败' })[status] || status

export function subagentProgress(child) {
  const progress = child.progress || {}
  const start = Date.parse(child.createdAt), end = child.done ? Date.parse(child.finishedAt || child.updatedAt) : Date.now()
  const elapsed = Number.isFinite(start) && Number.isFinite(end) ? ` · ${Math.max(0, Math.floor((end - start) / 1000))} 秒` : ''
  return `${subagentLabel(child.status)} · 已接收 ${progress.characters || 0} 字 · ${progress.toolCount || 0} 次工具调用${progress.activeTool && !child.done ? ' · 正在调用 ' + progress.activeTool : ''}${elapsed}`
}

export function orderSubagents(children) {
  return [...children].sort((a, b) => Number(a.done) - Number(b.done) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
}
