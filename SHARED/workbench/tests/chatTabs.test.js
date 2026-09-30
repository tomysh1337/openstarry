import test from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { Workspace, projectStore } from '../src/model.js'

test('migrates current and historical conversations without duplicating messages', () => {
  const current = [{ role: 'user', content: 'current' }], old = [{ role: 'user', content: 'old' }]
  const workspace = new Workspace({ chat: current, chatDraft: 'draft', chatReferences: ['a.js'], chatSessions: [{ id: 'legacy', title: 'old', chat: old }] })
  const id = workspace.chatId
  assert.deepEqual(workspace.chatTabs, [id])
  workspace.activateChat('legacy')
  assert.equal(workspace.chat, old); assert.equal(workspace.conversation(id).chat, current)
  assert.equal(workspace.conversation(id).draft, 'draft'); assert.deepEqual(workspace.conversation(id).references, ['a.js'])
  workspace.activateChat(id); workspace.activateChat(id)
  assert.equal(workspace.chat, current); assert.equal(workspace.chatSessions.length, 1)
  assert.deepEqual(workspace.chatTabs, [id, 'legacy'])
})

test('web thinking stays with its conversation when switching and reloading', () => {
  const workspace = new Workspace(), first = workspace.chatId
  assert.equal(workspace.chatThinking, false)
  workspace.chatThinking = true
  const second = workspace.createChat()
  assert.equal(workspace.chatThinking, true)
  workspace.chatThinking = false
  workspace.activateChat(first)
  assert.equal(workspace.chatThinking, true)
  const restored = new Workspace(workspace.snapshot())
  assert.equal(restored.chatThinking, true)
  restored.activateChat(second)
  assert.equal(restored.chatThinking, false)
})

test('open chat tabs retain drafts, references, mode and selection after persistence', async () => {
  const workspace = new Workspace(), first = workspace.chatId
  workspace.chat.push({ role: 'user', content: 'First chat' }); workspace.chatDraft = 'first draft'; workspace.chatReferences = ['first.js']; workspace.chatMode = 'ask'
  const second = workspace.createChat(); workspace.chatDraft = 'second draft'; workspace.chatReferences = ['second.js']
  await projectStore.save(workspace)
  const restored = await projectStore.load(workspace.id)
  assert.deepEqual(restored.chatTabs, [first, second]); assert.equal(restored.chatId, second); assert.equal(restored.chatDraft, 'second draft')
  restored.activateChat(first)
  assert.equal(restored.chatDraft, 'first draft'); assert.deepEqual(restored.chatReferences, ['first.js']); assert.equal(restored.chatMode, 'ask')
  assert.equal(restored.chatTitle(first), 'First chat')
})

test('closing tabs keeps history and reopening does not duplicate a tab', () => {
  const workspace = new Workspace(), first = workspace.chatId, firstMessages = workspace.chat
  const second = workspace.createChat(), third = workspace.createChat()
  workspace.closeChat(second); assert.deepEqual(workspace.chatTabs, [first, third]); assert.ok(workspace.conversation(second))
  workspace.closeChat(third); assert.equal(workspace.chatId, first)
  workspace.closeChat(first); assert.equal(workspace.chatTabs.length, 1); assert.notEqual(workspace.chatId, first)
  assert.equal(workspace.conversation(first).chat, firstMessages)
  workspace.activateChat(first); workspace.activateChat(first)
  assert.equal(workspace.chatTabs.filter(id => id === first).length, 1)
})

test('background message arrays stay attached to the original conversation', () => {
  const workspace = new Workspace(), first = workspace.chatId, messages = workspace.chat
  const second = workspace.createChat()
  messages.push({ role: 'assistant', content: 'background result' })
  assert.equal(workspace.chat.length, 0)
  assert.equal(workspace.conversation(first).chat[0].content, 'background result')
  workspace.closeChat(first); assert.equal(workspace.chatId, second)
  const restored = new Workspace(workspace.snapshot()); restored.activateChat(first)
  assert.equal(restored.chat[0].content, 'background result')
})
