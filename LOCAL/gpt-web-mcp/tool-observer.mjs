import { randomUUID } from 'node:crypto'

function printable(value) {
  return JSON.stringify(value, (key, item) => /^(authorization|password|api_?key|token|claimToken|adminToken|mcpUrl|pairingCode)$/i.test(key) ? '[private]' : item)
    .replace(/\/(?:adapter-)?mcp\/[\w-]+/g, '/mcp/[private]').slice(0, 8000)
}
export function toolObserver(chat, onError = () => process.stderr.write('Tool activity could not be persisted.\n')) {
  const observe = (name, args) => {
    const active = chat.list().tasks.filter(t => ['sending', 'generating', 'interrupted'].includes(t.status))
    const related = args.task_id ? active.filter(t => t.fileTaskId === args.task_id || t.connectorTaskIds?.includes(args.task_id)) : active.length === 1 && active[0].kind !== 'subagent' ? active : []
    const task = related.length === 1 ? related[0] : null
    if (!task) return () => {}
    const toolId = randomUUID(), started = Date.now()
    if (!chat.observeTool(task.id, 'tool_started', { toolId, name, provider: 'OpenStarry MCP', input: printable(args), startedAt: new Date(started).toISOString() })) return () => {}
    return (result, error = false) => {
      try {
      if (name === 'create_task' && !error && result.id) chat.linkFileTask(task.id, result.id)
      chat.observeTool(task.id, 'tool_completed', { toolId, output: printable(result), error, durationMs: Date.now() - started })
      } catch { onError() }
    }
  }
  return (name, args) => { try { return observe(name, args) } catch { onError(); return () => {} } }
}
