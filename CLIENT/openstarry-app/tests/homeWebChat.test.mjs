import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { IDBFactory } from '../../../SHARED/workbench/node_modules/fake-indexeddb/build/esm/index.js'
import { HomeWebChat, createHomeWebStore, homeWebMessages } from '../src/renderer/src/chat/homeWebChat.mjs'
import { GptWebService } from '../src/main/app/gptWebService.mjs'
import { IdeWorkspace } from '../src/main/app/ideWorkspace.mjs'
import { ref, reactive, watch } from 'vue'
import { useHomeWebChat } from '../src/renderer/src/chat/useHomeWebChat.mjs'

test('homepage web reply projects actual duration and tool data without a model id', () => {
  const tool = { type: 'tool', id: 'tool', name: 'read_file', input: '{}', output: 'actual', phase: 'complete' }
  const session = { id: 's', busy: false, turns: [{ id: 't', text: 'hello', createdAt: Date.parse('2026-09-26T00:00:00Z'), answer: { content: 'answer', status: 'complete', parts: [tool], web: { startedAt: '2026-09-26T00:00:01Z', finishedAt: '2026-09-26T00:00:03.500Z' } } }] }
  const [, answer] = homeWebMessages(session, 'owner', {})
  assert.equal(answer.info.total_duration, 2500); assert.equal(answer.info.model, undefined)
  assert.deepEqual(answer.extra.gptWeb.tools, [tool])
  delete session.turns[0].answer.web.finishedAt
  assert.equal(homeWebMessages(session, 'owner', {})[1].info.total_duration, undefined, 'legacy history must not accumulate fake elapsed time')
})

async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'openstarry-home-web-fixture-'))
  const service = new GptWebService({ baseDir: dir, scriptPath: resolve('../../LOCAL/gpt-web-mcp/test/desktop-fixture-worker.mjs'), nodePaths: [process.execPath], workspace: new IdeWorkspace() })
  const api = {
    submit: value => service.submit(value), cancel: value => service.cancel(value),
    watch: async ({ signal, onEvent, ...value }) => {
      signal.throwIfAborted(); const watchId = crypto.randomUUID(), abort = () => service.unwatch(watchId)
      signal.addEventListener('abort', abort, { once: true })
      try { return await service.watch({ ...value, watchId }, onEvent) } finally { signal.removeEventListener('abort', abort) }
    }
  }
  const store = createHomeWebStore(new IDBFactory()), client = new HomeWebChat({ api, store })
  await client.load('fixture-user')
  t.after(async () => { await client.close(); await service.stop(); await fs.rm(dir, { recursive: true, force: true }) })
  return { service, api, store, client }
}
async function until(condition) { for (let i = 0; i < 250; i++) { if (condition()) return; await delay(20) }; throw Error('fixture wait timed out') }

test('homepage stores drafts per user and soft-deletes local history', async () => {
  const store = createHomeWebStore(new IDBFactory()), client = new HomeWebChat({ api: {}, store })
  await client.load('one'); const chat = await client.create()
  client.draft(chat.id, '尚未发送的草稿'); await client.persist(chat)
  await client.update(chat.id, { title: '网页历史', star: true })
  const restored = new HomeWebChat({ api: {}, store }); await restored.load('one')
  assert.equal(restored.get(chat.id).draft, '尚未发送的草稿'); assert.equal(restored.get(chat.id).star, true)
  const other = new HomeWebChat({ api: {}, store }); await other.load('two'); assert.equal(other.state.sessions.length, 0)
  assert.notEqual(client.project.id, other.project.id)
  await restored.update(chat.id, { deleted: true }); assert.equal((await store.list('one')).length, 0)
  await client.close(); await restored.close(); await other.close()
})

test('homepage thinking persists per session and a retry retains the original choice', async t => {
  const f = await fixture(t), chat = await f.client.create(), submit = f.api.submit
  await f.client.update(chat.id, { thinking: true })
  let loseAck = true
  f.api.submit = async value => { const result = await submit(value); if (loseAck) { loseAck = false; throw Error('lost acknowledgement') }; return result }
  await f.client.send(chat.id, '思考设置随本次发送保存')
  const turn = chat.turns[0]
  assert.equal(turn.answer.web.thinking, true)
  await f.client.update(chat.id, { thinking: false })
  await f.client.resume(chat.id)
  assert.equal(turn.answer.status, 'complete')
  const tasks = (await f.service.admin('chat/tasks')).tasks
  assert.equal(tasks.length, 1); assert.equal(tasks[0].thinking, true)
  const restored = new HomeWebChat({ api: {}, store: f.store }); await restored.load('fixture-user')
  assert.equal(restored.get(chat.id).thinking, false); await restored.close()
})

test('homepage sends without API setup, streams into normal message bubbles, and creates no file task', async t => {
  const f = await fixture(t), chat = await f.client.create()
  const sending = f.client.send(chat.id, '保持生成，首页中文消息')
  await until(() => Boolean(chat.turns[0]?.answer.content))
  assert.equal(chat.busy, true)
  const messages = homeWebMessages(chat, 'fixture-user')
  assert.equal(messages[0].role, 'human'); assert.equal(messages[1].role, 'ai')
  assert.equal(messages[1].extra.gptWeb.source, 'fixture'); assert.equal(messages[1].pending, true)
  assert.equal((await f.service.admin('tasks')).tasks.length, 0)
  await f.client.cancel(chat.id); await sending
  assert.equal(chat.turns[0].answer.status, 'stopped')
  assert.equal(homeWebMessages(chat, 'fixture-user')[1].pending, false)
})

test('homepage reload restores the same task and reply; another draft stays untouched', async t => {
  const f = await fixture(t), first = await f.client.create()
  const sending = f.client.send(first.id, '保持生成，关闭页面后恢复')
  await until(() => Boolean(first.turns[0]?.answer.content))
  const second = await f.client.create(); f.client.draft(second.id, '另一个对话的草稿')
  await f.client.close(); await sending
  const restored = new HomeWebChat({ api: f.api, store: f.store }); await restored.load('fixture-user')
  t.after(() => restored.close())
  assert.equal(restored.get(first.id).turns[0].answer.status, 'interrupted')
  assert.equal(restored.get(second.id).draft, '另一个对话的草稿')
  const resuming = restored.resume(first.id)
  await until(() => restored.get(first.id).busy)
  await restored.cancel(first.id); await resuming
  assert.equal(restored.get(first.id).turns[0].answer.status, 'stopped')
  assert.equal((await f.service.admin('chat/tasks')).tasks.length, 1)
  assert.equal(restored.get(second.id).turns.length, 0)
})

test('lost submit acknowledgement retries the identical request without duplicating a webpage send', async t => {
  const f = await fixture(t), chat = await f.client.create(), submit = f.api.submit
  let loseAck = true
  f.api.submit = async value => { const task = await submit(value); if (loseAck) { loseAck = false; throw Error('fixture: lost acknowledgement') }; return task }
  await f.client.send(chat.id, '测试确认丢失')
  assert.equal(chat.turns[0].answer.status, 'interrupted')
  await f.client.resume(chat.id)
  assert.equal(chat.turns[0].answer.status, 'complete')
  assert.equal((await f.service.admin('chat/tasks')).tasks.length, 1)
  assert.equal(chat.turns.length, 1)
})

test('homepage source switches preserve API and web drafts without changing other pages backend history ID', async () => {
  const localStore = createHomeWebStore(new IDBFactory()), input = ref('API 草稿'), appStore = reactive({ current_history_id: 'api-history' })
  const options = { api: {}, appStore, owner: ref('fixture-user'), input, localStore }
  const home = useHomeWebChat(options); await home.load(); await home.setSource('chatgpt-web')
  const firstId = home.currentId.value
  input.value = '网页一草稿'
  await home.create(); const secondId = home.currentId.value; input.value = '网页二草稿'
  await home.setSource('api')
  assert.equal(input.value, 'API 草稿'); assert.equal(appStore.current_history_id, 'api-history')
  await home.setSource('chatgpt-web'); assert.equal(input.value, '网页二草稿')
  home.activate('-1'); input.value = 'API 新对话已发送的内容'
  home.currentId.value = 'api-created'
  home.activate('-1'); assert.equal(input.value, '')
  home.activate(secondId); assert.equal(input.value, '网页二草稿')
  home.activate(firstId); assert.equal(input.value, '网页一草稿')
  await home.close(); await home.close()
  const restored = useHomeWebChat({ ...options, input: ref('') }); await restored.load()
  assert.equal(restored.currentId.value, firstId); assert.equal(restored.session.value.draft, '网页一草稿')
  restored.activate(secondId); assert.equal(restored.session.value.draft, '网页二草稿')
  await restored.close()
})

test('homepage reactive stream stays with its original session after navigation and quote context survives', async t => {
  const f = await fixture(t), listeners = new Set(), errors = [], appStore = reactive({ current_history_id: 'api-history' })
  const api = {
    ...f.api,
    onEvent: callback => { listeners.add(callback); return () => listeners.delete(callback) },
    unwatch: async ({ watchId }) => f.service.unwatch(watchId),
    watch: value => f.service.watch(value, event => listeners.forEach(callback => callback({ ...event, watchId: value.watchId })))
  }
  const input = ref(''), home = useHomeWebChat({ api, appStore, input, owner: ref('fixture-user'), localStore: f.store, onError: error => errors.push(error) })
  await home.load(); await home.setSource('chatgpt-web')
  t.after(() => home.close())
  const firstId = home.currentId.value, seen = []
  const off = watch(() => home.messages.value.at(-1)?.chunks[0].content, value => seen.push(value), { flush: 'sync' })
  input.value = '保持生成，测试首页来源切换'
  const sending = home.send(input.value, '测试引用上下文')
  assert.equal(input.value, '')
  await until(() => home.messages.value.at(-1)?.chunks[0].content)
  assert.ok(seen.some(value => value?.includes('中文增量')))
  assert.ok(home.messages.value[0].chunks[0].content.includes('测试引用上下文'))
  await home.client.update(firstId, { title: 'fixture 首页标题', star: true })
  await assert.rejects(home.client.update(firstId, { deleted: true }), /先恢复并停止/)
  await home.create(); const secondId = home.currentId.value; input.value = '另一个首页草稿'
  await home.client.cancel(firstId); await sending
  assert.equal(home.currentId.value, secondId); assert.equal(input.value, '另一个首页草稿')
  assert.equal(home.messages.value.length, 0)
  home.activate(firstId); assert.equal(home.messages.value[1].extra.gptWeb.status, 'stopped')
  assert.equal(listeners.size, 0); assert.equal(errors.length, 0); off()
  await home.close()
})

test('multiple homepage conversations and follow-up turns keep distinct webpage identities', async t => {
  const f = await fixture(t), first = await f.client.create(), second = await f.client.create()
  await f.client.send(first.id, '第一条网页会话')
  await f.client.send(second.id, '第二条网页会话')
  await f.client.send(first.id, '第一条网页会话的追问')
  assert.equal(first.turns.length, 2); assert.equal(second.turns.length, 1)
  assert.equal(first.turns[0].answer.web.webConversationId, first.turns[1].answer.web.webConversationId)
  assert.notEqual(first.turns[0].answer.web.webConversationId, second.turns[0].answer.web.webConversationId)
  assert.ok([...first.turns, ...second.turns].every(turn => turn.answer.status === 'complete'))
  assert.equal((await f.service.admin('tasks')).tasks.length, 0)
})
