import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { startBridge } from '../server.mjs'
import { WebAdapter } from '../web-adapter.mjs'

class FixturePage {
  constructor() { this.sent = []; this.turns = 0; this.reads = 0; this.hold = false; this.stopped = false; this.fixture = true }
  async page(key, webId) { this.key = key; this.webId = webId; return this }
  async ready() { if (this.login) throw Object.assign(Error('请登录 fixture 页面'), { code: 'LOGIN_REQUIRED' }); return { assistantCount: this.turns, userCount: this.turns, webConversationId: this.webId } }
  async send(page, text) { this.sent.push(text); this.prompt = text; this.turns++; this.reads = 0; this.stopped = false }
  async inspect() {
    const index = this.reads++
    return { assistantCount: this.turns, userCount: this.turns, lastUser: this.prompt, webConversationId: 'fixture-web-conversation',
      busy: !this.stopped && (this.hold || index < 3), finished: this.stopped || !this.hold && index >= 3,
      text: this.stopped ? '停止前保留的最终文字' : index === 0 ? '你' : index === 1 ? '你好' : '你好，修订后的正文', alert: '' }
  }
  async stop() { this.stopped = true; return true }
  async close() {}
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'openstarry-web-adapter-test-')), workspace = join(dir, 'workspace'), stateDir = join(dir, 'private')
  await mkdir(workspace)
  let bridge = await startBridge({ workspace, stateDir, port: 0 }), adapter
  const driver = new FixturePage()
  const start = async () => { adapter = new WebAdapter({ origin: bridge.origin, adminToken: bridge.adminToken, stateDir, pageDriver: driver, source: 'fixture', pollMs: 5, timeoutMs: 5000 }); await adapter.start() }
  await start()
  t.after(async () => { await adapter.close(); await bridge.close(); await rm(dir, { recursive: true, force: true }) })
  const admin = async (route, body) => {
    const response = await fetch(bridge.origin + '/admin/chat/' + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + bridge.adminToken, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await response.json(); if (!response.ok) throw Error(data.error); return data
  }
  const create = requestId => admin('tasks', { clientId: 'desktop-fixture', adapterId: 'desktop-web', sessionId: 'fixture-session', messageId: requestId, requestId, prompt: '测试消息 ' + requestId })
  return { driver, create, admin, stateDir, get adapter() { return adapter }, restart: async () => {
    await adapter.close(); await bridge.close(); bridge = await startBridge({ workspace, stateDir, port: 0 }); await start()
  } }
}
async function until(fn) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(10) }; throw Error('Fixture wait timed out') }

function confirmedPage(driver) {
  const send = driver.send.bind(driver), inspect = driver.inspect.bind(driver)
  driver.send = async (page, prompt) => {
    await send(page, prompt)
    return { sent: true, userMessageId: 'confirmed-user', userCount: driver.turns, webConversationId: 'fixture-web-conversation' }
  }
  driver.inspect = async () => ({ ...await inspect(), userMessageId: 'confirmed-user', assistantMessageId: 'confirmed-answer' })
}

test('verified send identity survives collapsed rendered text and service restart without resending', async t => {
  const f = await fixture(t); confirmedPage(f.driver); f.driver.hold = true
  const inspect = f.driver.inspect.bind(f.driver)
  f.driver.inspect = async () => ({ ...await inspect(), lastUser: '折叠显示… 展开' })
  const task = await f.create('confirmed-restart'), running = f.adapter.tick()
  await until(async () => (await f.admin('tasks/' + task.id)).text.length > 0)
  await f.restart(); await running
  const journal = JSON.parse(await readFile(join(f.stateDir, 'web-adapter-private.json'), 'utf8'))
  assert.equal(journal.jobs[task.id].confirmedUser.messageId, 'confirmed-user')
  f.driver.hold = false; await f.adapter.tick()
  const result = await f.admin('tasks/' + task.id)
  assert.equal(result.status, 'completed'); assert.equal(result.text, '你好，修订后的正文'); assert.equal(f.driver.sent.length, 1)
})

test('first exact observation binds an older receipt to the message ID before later rendering changes', async t => {
  const f = await fixture(t), inspect = f.driver.inspect.bind(f.driver)
  f.driver.inspect = async () => { const state = await inspect(); return { ...state, userMessageId: 'observed-user', lastUser: f.driver.reads === 1 ? state.lastUser : '展开' } }
  const task = await f.create('legacy-receipt'); await f.adapter.tick()
  assert.equal((await f.admin('tasks/' + task.id)).status, 'completed')
})

for (const [name, change] of Object.entries({
  conversation: { webConversationId: 'another-conversation' },
  home: { webConversationId: null },
  message: { userMessageId: 'another-user' },
  extraTurn: { userCount: 2 }
})) test('confirmed generation rejects real session changes: ' + name, async t => {
  const f = await fixture(t); confirmedPage(f.driver)
  const inspect = f.driver.inspect.bind(f.driver)
  f.driver.inspect = async () => { const state = await inspect(); return f.driver.reads === 1 ? state : { ...state, ...change, text: 'unrelated content' } }
  const task = await f.create('changed-' + name); await f.adapter.tick()
  const result = await f.admin('tasks/' + task.id)
  assert.equal(result.error.code, 'SESSION_CHANGED'); assert.equal(result.text, '你'); assert.equal(result.webConversationId, 'fixture-web-conversation')
})

test('without a confirmed identity, mismatched initial content and changed legacy text are rejected', async t => {
  for (const later of [false, true]) {
    const f = await fixture(t), inspect = f.driver.inspect.bind(f.driver)
    f.driver.inspect = async () => { const state = await inspect(); return { ...state, lastUser: later && f.driver.reads === 1 ? state.lastUser : 'another request' } }
    const task = await f.create('unverified-' + later); await f.adapter.tick()
    const result = await f.admin('tasks/' + task.id)
    assert.equal(result.error.code, 'SESSION_CHANGED'); assert.equal(result.text, later ? '你' : '')
  }
})

test('adapter sends once, observes Chinese updates and revision, continues the same web conversation', async t => {
  const f = await fixture(t), first = await f.create('request-one')
  await f.adapter.tick()
  const task = await f.admin('tasks/' + first.id)
  assert.equal(task.status, 'completed'); assert.equal(task.text, '你好，修订后的正文'); assert.equal(task.source, 'fixture')
  assert.deepEqual(f.driver.sent, ['测试消息 request-one'])
  await f.adapter.tick(); assert.equal(f.driver.sent.length, 1)
  const second = await f.create('request-two'); await f.adapter.tick()
  assert.equal((await f.admin('tasks/' + second.id)).webConversationId, task.webConversationId)
  assert.equal(f.driver.webId, 'fixture-web-conversation'); assert.equal(f.driver.sent.length, 2)
})

test('missing send confirmation fails promptly instead of waiting for a whole generation timeout', async t => {
  const f = await fixture(t)
  f.adapter.sendConfirmMs = 20
  f.driver.inspect = async () => ({ userCount: 0, assistantCount: 0, busy: false, text: '', lastUser: '', alert: '' })
  const task = await f.create('missing-send')
  await f.adapter.tick()
  const result = await f.admin('tasks/' + task.id)
  assert.equal(result.error.code, 'DELIVERY_UNCERTAIN'); assert.equal(f.driver.sent.length, 1)
})
test('unrecognized completion reports the problem and preserves received partial text', async t => {
  const f = await fixture(t), inspect = f.driver.inspect.bind(f.driver)
  f.adapter.finishConfirmMs = 20
  f.driver.inspect = async () => ({ ...await inspect(), busy: false, finished: false, text: '正文已收到' })
  const task = await f.create('missing-completion')
  await f.adapter.tick()
  const result = await f.admin('tasks/' + task.id)
  assert.equal(result.error.code, 'COMPLETION_UNCONFIRMED'); assert.equal(result.text, '正文已收到')
})

test('adapter cancellation confirms the stop and captures the last visible text', async t => {
  const f = await fixture(t); f.driver.hold = true
  const task = await f.create('cancel'), running = f.adapter.tick()
  await until(async () => (await f.admin('tasks/' + task.id)).text.length > 0)
  assert.equal((await f.admin('tasks/' + task.id + '/cancel', {})).status, 'cancel_requested')
  await running
  const ended = await f.admin('tasks/' + task.id)
  assert.equal(ended.status, 'cancelled'); assert.equal(ended.text, '停止前保留的最终文字')
})

test('adapter and service restart recover persisted claims without sending the prompt again', async t => {
  const f = await fixture(t); f.driver.hold = true
  const task = await f.create('restart'), running = f.adapter.tick()
  await until(async () => (await f.admin('tasks/' + task.id)).text.length > 0)
  await f.restart(); await running
  assert.equal((await f.admin('tasks/' + task.id)).status, 'interrupted')
  f.driver.hold = false; await f.adapter.tick()
  assert.equal((await f.admin('tasks/' + task.id)).status, 'completed')
  assert.equal(f.driver.sent.length, 1)
  const privateState = JSON.parse(await readFile(join(f.stateDir, 'web-adapter-private.json'), 'utf8'))
  assert.ok(privateState.jobs[task.id].claimToken)
  assert.equal((await f.admin('tasks/' + task.id)).claimToken, undefined)
})

test('login failure becomes an actionable error before any webpage send', async t => {
  const f = await fixture(t); f.driver.login = true
  const task = await f.create('login'); await f.adapter.tick()
  const result = await f.admin('tasks/' + task.id)
  assert.equal(result.status, 'error'); assert.equal(result.error.code, 'LOGIN_REQUIRED'); assert.equal(f.driver.sent.length, 0)
})

test('long visible answers stream in bounded MCP events and retain Unicode', async t => {
  const f = await fixture(t), inspect = f.driver.inspect.bind(f.driver)
  const text = '中文🙂\\\n'.repeat(18000)
  f.driver.inspect = async () => ({ ...await inspect(), text })
  const task = await f.create('long'); await f.adapter.tick()
  const result = await f.admin('tasks/' + task.id)
  assert.equal(result.status, 'completed'); assert.equal(result.text, text)
})

test('oversized revisions report an error and preserve the last accepted text', async t => {
  const f = await fixture(t), inspect = f.driver.inspect.bind(f.driver)
  f.driver.inspect = async () => { const state = await inspect(); return { ...state, text: f.driver.reads === 1 ? '原始文字' : '新'.repeat(30000) } }
  const task = await f.create('revision-limit'); await f.adapter.tick()
  const result = await f.admin('tasks/' + task.id)
  assert.equal(result.status, 'error'); assert.equal(result.error.code, 'EVENT_LIMIT'); assert.equal(result.text, '原始文字')
  await f.adapter.tick(); assert.equal(f.driver.sent.length, 1)
})

test('cancelling before an assistant turn appears confirms the observed stop', async t => {
  const f = await fixture(t), inspect = f.driver.inspect.bind(f.driver)
  f.driver.hold = true
  f.driver.inspect = async () => ({ ...await inspect(), assistantCount: 0, text: '', finished: false })
  const task = await f.create('early-stop'), running = f.adapter.tick()
  await until(() => f.driver.reads > 0)
  await f.admin('tasks/' + task.id + '/cancel', {})
  await running
  const result = await f.admin('tasks/' + task.id)
  assert.equal(result.status, 'cancelled'); assert.equal(result.text, '')
})

test('manual webpage navigation is detected before sending a follow-up to the wrong conversation', async t => {
  const f = await fixture(t)
  await f.create('first'); await f.adapter.tick()
  const ready = f.driver.ready.bind(f.driver)
  f.driver.ready = async () => ({ ...await ready(), webConversationId: 'another-conversation' })
  const next = await f.create('next'); await f.adapter.tick()
  const result = await f.admin('tasks/' + next.id)
  assert.equal(result.error.code, 'SESSION_CHANGED'); assert.equal(f.driver.sent.length, 1)
})
