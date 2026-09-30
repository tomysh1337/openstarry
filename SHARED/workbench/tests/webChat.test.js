import test from 'node:test'
import assert from 'node:assert/strict'
import { Workspace } from '../src/model.js'
import { applyWebEvent } from '../src/webChat.js'

test('web source persists per chat and new tabs inherit the selected source', () => {
  const workspace = new Workspace(); workspace.chatSource = 'gpt-web'; const first = workspace.chatId
  workspace.createChat(); assert.equal(workspace.chatSource, 'gpt-web'); workspace.chatSource = 'api'
  workspace.activateChat(first); assert.equal(workspace.chatSource, 'gpt-web')
  assert.equal(new Workspace(workspace.snapshot()).chatSource, 'gpt-web')
})

test('file links survive incremental events and reset snapshots', () => {
  const answer = { content: '', parts: [], web: { taskId: 'task' } }
  const artifacts = [{ name: 'README.md', path: 'sandbox:/mnt/data/README.md', messageId: 'answer' }]
  applyWebEvent(answer, { taskId: 'task', type: 'file_links', seq: 1, payload: { artifacts } })
  assert.deepEqual(answer.web.artifacts, artifacts)
  applyWebEvent(answer, { taskId: 'task', type: 'reset', seq: 2, snapshot: { id: 'task', text: '文件已生成', status: 'completed', artifacts } })
  assert.deepEqual(answer.web.artifacts, artifacts)
})

test('web event reducer isolates tasks, deduplicates deltas and replaces reset snapshots without duplicating text', () => {
  const answer = { content: '', parts: [], web: { taskId: 'task-one' } }
  applyWebEvent(answer, { taskId: 'task-two', seq: 1, type: 'text_delta', payload: { text: '串消息' } })
  assert.equal(answer.content, '')
  const event = { taskId: 'task-one', seq: 2, type: 'text_delta', payload: { text: '中文' } }
  applyWebEvent(answer, event); const part = answer.parts[0]; applyWebEvent(answer, event)
  assert.equal(answer.content, '中文')
  applyWebEvent(answer, { taskId: 'task-one', seq: 3, type: 'text_snapshot', payload: { text: '网页修订' } })
  assert.equal(answer.parts[0], part); assert.equal(part.text, '网页修订')
  applyWebEvent(answer, { taskId: 'task-one', seq: 6, type: 'reset', snapshot: { id: 'task-one', text: '重连后的完整文字', status: 'cancel_requested', tools: {}, source: 'fixture' } })
  assert.equal(answer.status, 'running'); assert.equal(answer.web.status, 'cancel_requested')
  applyWebEvent(answer, { taskId: 'task-one', seq: 7, type: 'cancelled', payload: {} })
  assert.equal(answer.status, 'stopped'); assert.equal(answer.parts[0], part)
})
