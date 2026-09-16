import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'
import { saveConfig, loadConfig, clearConfig, allRecords, putRecords, synchronize, pendingCount, conversations, messages, apiKey, savePreferences, preferences, providers } from '../src/syncClient.js'
import { newConversation, sendMessage, parseExtra } from '../src/chatSession.js'
const serverUrl = 'http://127.0.0.1:8766'
const nativeFetch = globalThis.fetch
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  const map = new Map()
  globalThis.localStorage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) }
  globalThis.fetch = nativeFetch
})
const configure = () => saveConfig({ serverUrl, userId: crypto.randomUUID(), token: 'fixture-only' })
const provider = { provider_id: 'provider-fixture', provider_name: 'Fixture', type: 'openai', endpoint: serverUrl + '/v1', model_list: ['fixture-model'], description: '', created_at: '2026-09-16T00:00:00Z', is_deleted: 0 }
test('mobile chat persists then round trips through the real desktop SQLite and cloud, including preferences without keys', async () => {
  const config = await configure()
  await putRecords([{ id: 'provider:' + provider.provider_id, kind: 'provider', payload: provider }])
  apiKey(provider.provider_id, 'LOCAL-KEY-NEVER-SYNC')
  await savePreferences({ modelTemp: 35, dark_theme: true, modelName: 'fixture-model', activeProvider: { provider_id: provider.provider_id, name: provider.provider_name } })
  const conversation = await newConversation()
  await sendMessage({ conversationId: conversation.conversation_uid, text: '你好跨端', provider, model: 'fixture-model', signal: new AbortController().signal })
  const saved = await messages(conversation.conversation_uid)
  assert.ok(Math.abs(saved[1].msg_timestamp - Date.now()) < 60000, 'chat timestamps must use milliseconds')
  assert.equal(saved.length, 2); assert.equal(saved[1].content, '收到：你好跨端'); assert.equal(parseExtra(saved[1]).status, 'complete')
  await synchronize(config)
  assert.equal(await pendingCount(), 0)
  const remote = await nativeFetch(serverUrl + '/v1/sync', { method: 'POST', body: JSON.stringify({userId: config.userId, cursor: 0, operations: []}) }).then(r => r.json())
  assert.ok(!JSON.stringify(remote).includes('LOCAL-KEY-NEVER-SYNC'))
  const desktop = await nativeFetch(serverUrl + '/fixture/desktop-apply', { method: 'POST', body: JSON.stringify({ records: remote.records }) }).then(r => r.json())
  assert.equal(desktop.find(r => r.id === 'provider:' + provider.provider_id).payload.model_list[0], 'fixture-model')
  assert.equal(desktop.find(r => r.id === 'preference:modelTemp').payload.value, 35)
  assert.equal(desktop.find(r => r.kind === 'message' && r.payload.sync_id === saved[1].sync_id).payload.content, '收到：你好跨端')
  const incoming = { id: 'message:' + conversation.conversation_uid + ':desktop-answer', kind: 'message', payload: { ...saved[1], sync_id: 'desktop-answer', node_id: 'desktop-node', content: '电脑接着回复', msg_cursor: 3, msg_timestamp: saved[1].msg_timestamp + 1 } }
  await nativeFetch(serverUrl + '/v1/sync', { method: 'POST', body: JSON.stringify({userId:config.userId, operations:[{opId:'desktop-write', deviceId:'desktop',modifiedAt:Date.now()+100,record:incoming}]}) })
  await synchronize(config)
  assert.equal((await messages(conversation.conversation_uid)).at(-1).content, '电脑接着回复')
  await sendMessage({ conversationId: conversation.conversation_uid, text: '手机继续', provider, model: 'fixture-model', signal: new AbortController().signal })
  const continued = await messages(conversation.conversation_uid)
  assert.deepEqual(continued.slice(-3).map(item => item.content), ['电脑接着回复', '手机继续', '收到：手机继续'])
  assert.ok(continued.at(-1).msg_timestamp < Date.now() + 60000)
  clearConfig(); assert.equal((await conversations()).length, 1); assert.equal(apiKey(provider.provider_id), 'LOCAL-KEY-NEVER-SYNC')
})
test('offline errors and full rescan retain unsent local messages', async () => {
  await configure(); const c = await newConversation()
  globalThis.fetch = async () => { throw Error('offline') }
  await assert.rejects(synchronize(loadConfig(), true), /offline/)
  assert.equal((await conversations())[0].conversation_uid, c.conversation_uid); assert.equal(await pendingCount(), 1)
  globalThis.fetch = nativeFetch; await synchronize(); assert.equal(await pendingCount(), 0)
})
test('editing a record while a sync is in flight preserves the new write', async () => {
  await configure(); const c = await newConversation()
  let injected = false
  globalThis.fetch = async (...args) => {
    const result = await nativeFetch(...args)
    if (!injected) { injected = true; await putRecords([{id:'conversation:'+c.conversation_uid,kind:'conversation',payload:{...c,title:'Edited during sync'}}]) }
    return result
  }
  await synchronize(); assert.equal((await conversations())[0].title, 'Edited during sync'); assert.equal(await pendingCount(), 0)
})
test('failed provider response retains the human message and explicit error for retry', async () => {
  const c = await newConversation()
  await assert.rejects(sendMessage({conversationId:c.conversation_uid,text:'retain me',provider,model:'failure',signal:new AbortController().signal}), /503/)
  const list = await messages(c.conversation_uid)
  assert.equal(list[0].content,'retain me'); assert.equal(parseExtra(list[1]).status,'error')
  await sendMessage({conversationId:c.conversation_uid,provider,model:'fixture-model',signal:new AbortController().signal,retry:true})
  assert.equal((await messages(c.conversation_uid)).at(-1).content,'收到：retain me')
})
test('account change selects an isolated cache without erasing prior data', async () => {
  const one = await configure(); await newConversation()
  await saveConfig({serverUrl,userId:'second-account',token:'fixture-only'}); assert.equal((await conversations()).length,0)
  await saveConfig(one); assert.equal((await conversations()).length,1)
})
test('malformed sync responses never advance cursor or discard the queue', async () => {
  await configure(); await newConversation()
  globalThis.fetch = async () => new Response(JSON.stringify({cursor:0,hasMore:true,acknowledgedIds:[],records:[]}))
  await assert.rejects(synchronize(),/响应不完整/); assert.equal(await pendingCount(),1)
})
