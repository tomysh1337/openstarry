import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parse } from './chat-store.mjs'
import { problem } from './store.mjs'

const terminal = task => ['completed', 'cancelled', 'error'].includes(task.status)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const parent = { task_id: z.string().uuid() }
export const spawnInput = z.object({ ...parent, name: z.string().trim().min(1).max(80), prompt: z.string().trim().min(1).max(14000), request_id: z.string().min(1).max(220), thinking: z.boolean().optional() }).strict()
export const childInput = z.object({ ...parent, subagent_id: z.string().uuid() }).strict()
export const resultInput = childInput.extend({ offset: z.number().int().min(0).max(1024 * 1024).default(0), limit: z.number().int().min(1).max(16000).default(8000), wait_ms: z.number().int().min(0).max(20000).default(0) })

// Child chats share the app-owned adapter and file policy, but never inherit parent history.
export function createSubagents({ chat, files, maxPerParent = 8, maxPending = 16 }) {
  let chain = Promise.resolve(), closed = false
  const waiters = new Set()
  const tasks = (progress = false) => chat.list(undefined, { progress }).tasks.filter(task => task.kind === 'subagent')
  const summary = task => ({ id: task.id, task_id: task.subagent.parentTaskId, file_task_id: task.fileTaskId, name: task.subagent.name,
    status: task.status, done: terminal(task), source: task.source, lastSeq: task.lastSeq, createdAt: task.createdAt, updatedAt: task.updatedAt, finishedAt: task.finishedAt,
    ...(task.progress || typeof task.text === 'string' ? { progress: task.progress || { characters: Array.from(task.text).length, preview: Array.from(task.text).slice(-240).join(''), toolCount: Object.keys(task.tools || {}).length, activeTool: Object.values(task.tools || {}).find(tool => tool.status === 'running')?.name || null } } : {}),
    ...(task.error ? { error: task.error } : {}) })
  function owned(value) {
    const input = parse(childInput, value), task = chat.get(input.subagent_id)
    if (task.kind !== 'subagent' || task.subagent.parentTaskId !== input.task_id) throw problem('SUBAGENT_NOT_FOUND', 'Subagent does not belong to this parent task', 404)
    return task
  }
  const serial = fn => { const next = chain.then(fn); chain = next.catch(() => {}); return next }
  function status() { return { available: chat.adapters().some(a => a.adapterId === 'desktop-web'), maxParallel: 2, maxPerParent, maxPending,
    active: tasks().filter(t => !terminal(t)).length, context: 'independent', filePolicy: 'shared-with-parent' } }
  function list(taskId) {
    if (taskId) files.getTask(taskId)
    return { ...status(), subagents: tasks(true).filter(t => !taskId || t.subagent.parentTaskId === taskId).map(summary) }
  }
  function get(value) {
    const input = parse(resultInput, value), { task_id, subagent_id, offset, limit } = input
    const task = owned({ task_id, subagent_id })
    const pending = files.listProposals().proposals.filter(p => p.taskId === task.fileTaskId && p.status === 'pending').map(p => ({ id: p.id, path: p.path }))
    // Offsets refer to this snapshot; a final read from zero handles streamed revisions.
    return { ...summary(task), text: task.text.slice(offset, offset + limit), offset, next_offset: offset + limit < task.text.length ? offset + limit : null,
      total_characters: task.text.length, pending_proposals: pending }
  }
  async function result(value, signal) {
    const input = parse(resultInput, value), initial = get(input)
    if (initial.done || !input.wait_ms || closed || signal?.aborted) return initial
    await new Promise(resolve => {
      let timer, unsubscribe = () => {}
      const finish = () => { clearTimeout(timer); unsubscribe(); waiters.delete(finish); signal?.removeEventListener('abort', finish); resolve() }
      waiters.add(finish)
      unsubscribe = chat.subscribe(id => { if (id === input.subagent_id && terminal(owned({ task_id: input.task_id, subagent_id: id }))) finish() })
      signal?.addEventListener('abort', finish, { once: true })
      timer = setTimeout(finish, input.wait_ms)
    })
    return closed ? initial : get(input)
  }
  function cancel(value) { const task = owned(value); return summary(chat.cancel(task.id)) }
  function cancelParent(taskId) { return serial(async () => {
    for (const task of tasks()) if (task.subagent.parentTaskId === taskId && !terminal(task)) chat.cancel(task.id)
  }) }
  function assertComplete(taskId) {
    const children = tasks().filter(t => t.subagent.parentTaskId === taskId)
    if (children.some(t => !terminal(t))) throw problem('SUBAGENT_PENDING', 'Wait for or cancel subagents before reporting parent completion', 409)
    const childIds = new Set(children.map(t => t.fileTaskId))
    if (files.listProposals().proposals.some(p => childIds.has(p.taskId) && ['pending', 'applying', 'recovery_required'].includes(p.status))) throw problem('REVIEW_PENDING', 'Subagent file changes still require local review', 409)
  }
  function checkParent(taskId) {
    const owner = files.getTask(taskId)
    if (owner.source === 'subagent') throw problem('SUBAGENT_DEPTH', 'Subagents do not spawn further subagents; return findings to the parent', 409)
    if (['completed', 'error'].includes(owner.status) || chat.list().tasks.some(t => (t.fileTaskId === taskId || t.connectorTaskIds?.includes(taskId)) && ['cancelled', 'cancel_requested'].includes(t.status))) throw problem('TASK_CLOSED', 'Parent task is closed or cancelled', 409)
    return owner
  }
  function spawn(value) { return serial(async () => {
    if (closed) throw problem('SERVICE_CLOSED', 'Subagent service is closing', 409)
    const input = parse(spawnInput, value), request = 'subagent-' + digest([input.task_id, input.request_id])
    const fingerprint = digest([input.task_id, input.name, input.prompt, input.thinking ?? null])
    const existing = tasks().find(t => t.clientId === 'mcp-subagent' && t.requestId === request)
    if (existing) {
      if (existing.subagent.fingerprint !== fingerprint) throw problem('REQUEST_CONFLICT', 'Subagent request id already has different content', 409)
      return summary(existing)
    }
    const owner = checkParent(input.task_id)
    if (!status().available) throw problem('SUBAGENT_UNAVAILABLE', 'Start the OpenStarry desktop Bridge and pair its ordinary Edge extension first', 409)
    if (tasks().filter(t => t.subagent.parentTaskId === owner.id).length >= maxPerParent || tasks().filter(t => !terminal(t)).length >= maxPending) throw problem('SUBAGENT_LIMIT', 'Subagent task limit reached; wait for or cancel current work', 409)
    const fileTask = await files.submitTask(input.prompt, { source: 'subagent', requestId: request })
    checkParent(input.task_id)
    const prompt = `你是 OpenStarry 子 Agent「${input.name}」。只完成下方分配的任务，返回结果、证据和未解决的问题，供主 Agent 汇总。此会话不包含主 Agent 历史，所需上下文必须来自本次任务。不要再次分派子 Agent。文件任务 ID：${fileTask.id}。如需文件工具且连接器可用，遵循 get_status 的新建/覆盖规则；已有文件只提交 propose_file 待本机审查，工具缺失时明确说明，不声称操作成功。\n\n子任务：\n${input.prompt}`
    const task = chat.submit({ clientId: 'mcp-subagent', adapterId: 'desktop-web', sessionId: request, messageId: request, requestId: request,
      prompt, fileTaskId: fileTask.id, ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
      subagent: { parentTaskId: owner.id, name: input.name, fingerprint } })
    return summary(task)
  }) }
  return { status, list, get, result, spawn, cancel, cancelParent, assertComplete, async close() { closed = true; for (const finish of waiters) finish(); await chain } }
}
