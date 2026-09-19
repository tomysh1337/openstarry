import { conversations, messages, putRecords, databaseName, apiKey } from './syncClient.js'
import { completeChat } from './chatClient.js'
import { loadToolSettings } from '@openstarry/workbench/settings'
export const conversationRecord = payload => ({ id: 'conversation:' + payload.conversation_uid, kind: 'conversation', payload })
export const messageRecord = payload => ({ id: 'message:' + payload.conversation_uid + ':' + payload.sync_id, kind: 'message', payload })
export function parseExtra(message) { try { return typeof message.extra === 'string' ? JSON.parse(message.extra) : message.extra || {} } catch { return {} } }
export async function newConversation() {
  const now = new Date().toISOString()
  const value = { conversation_uid: crypto.randomUUID(), title: '新的聊天', platform: 'default', work_space: '', created_at: now, last_active_at: now, latest_cursor: 0, latest_timestamp: 0, is_pinned: 0, is_cron: 0, is_deleted: 0 }
  await putRecords([conversationRecord(value)])
  return value
}
export async function sendMessage({ conversationId, text, provider, model, prefs, signal, onChange, retry = false }) {
  const name = databaseName()
  const conversation = (await conversations()).find(item => item.conversation_uid === conversationId)
  if (!conversation) throw Error('会话不存在，请新建聊天')
  if (!provider || !model) throw Error('请先在设置中添加供应商并选择模型')
  const history = await messages(conversationId)
  let context = history.filter(item => ['human', 'ai'].includes(item.role) && item.content && !['error', 'generating'].includes(parseExtra(item).status))
  let cursor = Math.max(conversation.latest_cursor || 0, ...history.map(item => Number(item.msg_cursor) || 0))
  // Chat timestamps use milliseconds on desktop as well as mobile.
  let stamp = Math.max(Date.now(), ...history.map(item => Number(item.msg_timestamp) || 0))
  const build = (role, content, parentId) => ({ conversation_uid: conversationId, sync_id: crypto.randomUUID(), generation_id: crypto.randomUUID(), node_id: crypto.randomUUID(), parent_id: parentId || '', role, content, think: '', extra: '{}', info: JSON.stringify({ model_name: model, model_provider: provider.provider_name }), created_at: new Date().toISOString(), msg_cursor: ++cursor, msg_timestamp: ++stamp, is_deleted: 0 })
  if (retry) {
    const last = context.findLastIndex(item => item.role === 'human')
    if (last < 0) throw Error('没有可重试的消息')
    context = context.slice(0, last + 1)
  } else {
    if (!text.trim()) throw Error('请输入消息')
    const human = build('human', text.trim(), context.at(-1)?.node_id)
    context.push(human)
    if (!history.length) conversation.title = text.trim().slice(0, 40)
    conversation.last_active_at = human.created_at
    conversation.latest_cursor = cursor; conversation.latest_timestamp = stamp
    await putRecords([conversationRecord(conversation), messageRecord(human)], name)
  }
  const answer = build('ai', '', context.at(-1)?.node_id)
  answer.extra = JSON.stringify({ status: 'generating' })
  await putRecords([messageRecord(answer)], name)
  await onChange?.(answer, true)
  let lastSave = 0, persistence = Promise.resolve()
  const snapshot = () => JSON.parse(JSON.stringify(messageRecord(answer)))
  try {
    const requestMessages = context.map(item => ({ role: item.role === 'human' ? 'user' : 'assistant', content: item.content }))
    if (prefs?.rolePrompt?.definition) requestMessages.unshift({ role: 'system', content: prefs.rolePrompt.definition })
    const complete = loadToolSettings().enabled ? (await import('./agentAdapter.js')).mobileAgent : completeChat
    await complete({ provider, key: apiKey(provider.provider_id), model, messages: requestMessages, temperature: Number(prefs?.modelTemp ?? 50) * 0.02, signal,
      onDelta: delta => {
        Object.assign(answer, delta); onChange?.(answer, false)
        if (Date.now() - lastSave > 800) { lastSave = Date.now(); const record = snapshot(); persistence = persistence.then(() => putRecords([record], name)); persistence.catch(() => {}) }
      }
    })
    answer.extra = JSON.stringify({ status: 'complete' })
  } catch (error) {
    answer.extra = JSON.stringify({ status: signal.aborted ? 'stopped' : 'error', error: signal.aborted ? '已停止生成' : (error.message || '请求失败') })
    throw error
  } finally {
    await persistence.catch(() => {})
    conversation.last_active_at = new Date().toISOString(); conversation.latest_cursor = cursor; conversation.latest_timestamp = stamp
    await putRecords([conversationRecord(conversation), snapshot()], name)
    await onChange?.(answer, true)
  }
  return answer
}
