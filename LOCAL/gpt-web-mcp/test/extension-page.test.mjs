import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { EdgeExtensionPage } from '../extension-page.mjs'
import { parsePairingCode, validateCommand, executeOnce, isChatGPT } from '../edge-extension/protocol.mjs'
import { startBridge } from '../server.mjs'
import { WebAdapter } from '../web-adapter.mjs'
import { contentFixture } from './content-fixture.mjs'

const initial = () => ({ contentVersion: 3, input: true, login: false, challenge: false, busy: false, text: '', assistantCount: 0, userCount: 0, assistantMessageId: '', userMessageId: '', lastUser: '', finished: false, alert: '', webConversationId: null })
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'openstarry-extension-'))
  const driver = new EdgeExtensionPage({ profile: join(dir, 'browser'), ...options })
  const shown = await driver.show(), pairing = parsePairingCode(shown.pairingCode), clientId = randomUUID()
  const cleanup = []
  t.after(async () => { for (const close of cleanup) await close(); await driver.close(); await rm(dir, { recursive: true, force: true }) })
  const call = async (route, body = {}, headers = {}) => fetch(pairing.origin + route, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + pairing.token, ...headers },
    body: JSON.stringify({ clientId, ...body })
  })
  const poll = async () => (await call('/poll', { login: 'ready' })).json()
  const respond = async (command, result) => {
    const response = await call('/result', { id: command.id, result })
    assert.equal(response.status, 200)
  }
  return { dir, driver, shown, pairing, call, poll, respond, cleanup }
}

test('pairing is loopback-only, private, authenticated and persistent across helper restarts', async t => {
  const f = await fixture(t)
  assert.equal(f.shown.extensionConnected, false)
  assert.equal(f.driver.commands.size, 0, 'show must not open or control a browser')
  await assert.rejects(f.driver.page('session'), /请先连接/)
  assert.equal((await f.call('/poll', { login: 'ready' }, { authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await f.call('/poll', { login: 'ready' }, { origin: 'https://chatgpt.com' })).status, 403)
  const wrongHost = await new Promise((resolve, reject) => {
    const req = httpRequest(f.pairing.origin + '/poll', { method: 'POST', headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode) })
    req.on('error', reject); req.end()
  })
  assert.equal(wrongHost, 403)
  const valid = await f.call('/poll', { login: 'ready' }, { origin: 'chrome-extension://' + 'a'.repeat(32) })
  assert.equal(valid.status, 200)
  assert.equal(valid.headers.get('access-control-allow-origin'), 'chrome-extension://' + 'a'.repeat(32))
  const publicState = await f.driver.status()
  assert.equal(publicState.extensionConnected, true)
  assert.ok(!JSON.stringify(publicState).includes(f.pairing.token))
  await f.driver.close()
  await f.driver.start()
  assert.deepEqual(parsePairingCode((await f.driver.show()).pairingCode), f.pairing)
})

test('commands have one consumer, stable IDs until acknowledgement and strict page snapshots', async t => {
  const f = await fixture(t)
  await f.poll()
  const opening = f.driver.page('session')
  await delay(1)
  const { command } = await f.poll()
  assert.equal(command.method, 'page')
  assert.equal((await f.poll()).command.id, command.id)
  assert.equal((await f.call('/poll', { login: 'ready', clientId: randomUUID() })).status, 409)
  assert.equal((await f.call('/result', { id: command.id, result: true, clientId: randomUUID() })).status, 409)
  await f.respond(command, true)
  assert.equal(await opening, 'session')
  assert.equal((await f.poll()).command, null)
  const reading = f.driver.ready('session')
  const next = (await f.poll()).command
  await f.respond(next, initial())
  assert.equal((await reading).input, true)
  const malformed = assert.rejects(f.driver.inspect('session'))
  await f.respond((await f.poll()).command, { text: 'missing observation fields' })
  await malformed
})

test('expired sends are not queued again and stale results cannot acknowledge a later command', async t => {
  const f = await fixture(t, { commandTimeout: 35 })
  await f.poll()
  f.driver.baselines.set('session', initial())
  const pending = assert.rejects(f.driver.send('session', 'test'), error => error.code === 'DELIVERY_UNCERTAIN')
  const { command } = await f.poll()
  await pending
  assert.equal((await f.poll()).command, null)
  assert.equal((await f.call('/result', { id: command.id, result: true })).status, 409)
})

test('send returns the validated content-script receipt for durable adapter identity', async t => {
  const f = await fixture(t); await f.poll(); f.driver.baselines.set('session', initial())
  const receipt = { sent: true, userMessageId: 'user-1', userCount: 1, webConversationId: 'conversation-1' }
  const sending = f.driver.send('session', 'fixture prompt')
  await f.respond((await f.poll()).command, receipt)
  assert.deepEqual(await sending, receipt)
  const malformed = assert.rejects(f.driver.send('session', 'fixture prompt'))
  await f.respond((await f.poll()).command, { ...receipt, userCount: -1 }); await malformed
})

test('a slow successful page operation refreshes extension liveness', async t => {
  let now = 100000
  const f = await fixture(t, { clock: () => now })
  await f.poll()
  const opening = f.driver.page('slow-page')
  await delay(1)
  const { command } = await f.poll()
  now += 12500
  await f.respond(command, true)
  await opening
  assert.equal(f.driver.state.extensionConnected, true)
})

test('extension rejects off-host pairing, unsupported commands and expired execution', () => {
  const encode = value => 'osb1.' + Buffer.from(JSON.stringify(value)).toString('base64url')
  for (const origin of ['https://example.com', 'http://localhost:1234', 'http://127.0.0.1:1234/path', 'http://127.0.0.1:70000', 'http://127.0.0.1:80']) {
    assert.throws(() => parsePairingCode(encode({ version: 1, token: 'a'.repeat(43), origin })))
  }
  const command = { id: randomUUID(), method: 'page', args: { key: 'session', webConversationId: null }, expiresAt: Date.now() + 1000 }
  assert.equal(validateCommand(command), command)
  assert.throws(() => validateCommand({ ...command, method: 'eval' }))
  assert.throws(() => validateCommand({ ...command, expiresAt: 0 }))
  assert.throws(() => validateCommand({ ...command, args: { key: 'session', webConversationId: '../../settings' } }))
  assert.equal(isChatGPT('https://chatgpt.com/c/test'), true)
  assert.equal(isChatGPT('https://chatgpt.com.evil.example/'), false)
})

test('send journal prevents duplicate submission after a lost result or worker restart', async () => {
  let journal = {}, sends = 0
  const command = { id: randomUUID(), method: 'send', args: { key: 'session', text: 'hello', baseline: { userCount: 0 } }, expiresAt: Date.now() + 5000 }
  const store = { load: async () => structuredClone(journal), save: async value => { journal = structuredClone(value) }, execute: async () => { sends++; return { sent: true } } }
  await executeOnce(command, store)
  assert.deepEqual(await executeOnce(command, store), { sent: true })
  assert.equal(sends, 1)
  await assert.rejects(executeOnce({ ...command, args: { ...command.args, text: 'changed' } }, store), /内容已改变/)
  const uncertain = { ...command, id: randomUUID() }
  await assert.rejects(executeOnce(uncertain, { ...store, execute: async () => { sends++; throw Error('worker stopped after click') } }))
  await assert.rejects(executeOnce(uncertain, store), error => error.code === 'DELIVERY_UNCERTAIN')
  assert.equal(sends, 2)
  assert.equal(JSON.stringify(journal).includes('hello'), false)
})

test('extension peer fixture crosses MCP with text before completion and one send', async t => {
  const f = await fixture(t)
  await mkdir(join(f.dir, 'workspace'))
  const bridge = await startBridge({ workspace: join(f.dir, 'workspace'), stateDir: join(f.dir, 'control'), port: 0 })
  const adapter = new WebAdapter({ origin: bridge.origin, adminToken: bridge.adminToken, stateDir: join(f.dir, 'control'), pageDriver: f.driver, source: 'fixture', pollMs: 10 })
  const page = contentFixture(t)
  const thinking = page.document.createElement('button'); thinking.type = 'button'; thinking.textContent = '思考'; thinking.setAttribute('aria-pressed', 'false')
  thinking.onclick = () => thinking.setAttribute('aria-pressed', 'true'); page.input.after(thinking)
  let running = true, busy = false, peerError, sends = 0, reads = 0, downloads = 0
  const peer = setInterval(async () => {
    if (busy || !running) return
    busy = true
    try {
      const { command } = await f.poll()
      if (command) {
        let result = true
        if (command.method === 'inspect') {
          if (sends) {
            reads++
            if (reads === 1) { page.answer('你'); await Promise.resolve(); page.answer('你好'); await Promise.resolve() }
            else page.answer(reads > 2 ? '你好，扩展回传完成' : '你好', { finished: reads > 2, busy: reads <= 2 })
            if (reads > 2) {
              const link = page.document.createElement('a'); link.href = 'sandbox:/mnt/data/README.md'
              link.onclick = event => { event.preventDefault(); downloads++ }
              page.document.querySelector('[data-message-author-role="assistant"]').append(link)
            }
          }
          result = (await page.invoke({ method: 'inspect' })).result
        } else if (['send', 'download'].includes(command.method)) {
          if (command.method === 'send') sends++
          const response = await page.invoke({ method: command.method, ...command.args })
          if (response.error) throw Error(response.error.message)
          result = response.result
        }
        await f.respond(command, result)
      }
    } catch (error) { peerError = error }
    finally { busy = false }
  }, 10)
  f.cleanup.push(async () => { running = false; clearInterval(peer); while (busy) await delay(5); await adapter.close(); await bridge.close() })
  await f.poll(); await adapter.start()
  const admin = async (route, body) => {
    const response = await fetch(bridge.origin + '/admin/chat/' + route, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + bridge.adminToken, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return response.json()
  }
  const task = await admin('tasks', { clientId: 'fixture', adapterId: 'desktop-web', sessionId: 'test', messageId: 'one', requestId: 'one', prompt: '请回答', thinking: true })
  let firstBeforeComplete = false, streamedWhileGenerating = false
  const response = await fetch(bridge.origin + '/admin/chat/tasks/' + task.id + '/events', { headers: { authorization: 'Bearer ' + bridge.adminToken }, signal: AbortSignal.timeout(8000) })
  const events = [], decoder = new TextDecoder()
  const receiving = (async () => {
    let buffer = ''
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        const line = block.split('\n').find(value => value.startsWith('data: '))
        if (line) {
          const event = JSON.parse(line.slice(6)); events.push(event)
          if (event.type === 'text_delta' && events.filter(value => value.type === 'text_delta').length === 1) {
            streamedWhileGenerating = (await admin('tasks/' + task.id)).status === 'generating'
          }
        }
      }
    }
  })()
  const work = adapter.tick()
  for (let i = 0; i < 100; i++) {
    const value = await admin('tasks/' + task.id)
    if (value.text && value.status === 'generating') firstBeforeComplete = true
    if (value.status === 'completed') break
    await delay(10)
  }
  await work; await receiving
  const result = await admin('tasks/' + task.id)
  assert.equal(peerError, undefined)
  assert.equal(result.status, 'completed')
  assert.equal(result.source, 'fixture')
  assert.equal(result.text, '你好，扩展回传完成')
  assert.equal(result.webConversationId, 'fixture-conversation')
  assert.equal(firstBeforeComplete, true)
  assert.equal(streamedWhileGenerating, true, 'SSE text must reach the subscriber while the task is still generating')
  assert.ok(events.filter(event => event.type === 'text_delta').length >= 2)
  assert.deepEqual(events.filter(event => event.type === 'text_delta').slice(0, 2).map(event => event.payload.text), ['你', '好'])
  assert.ok(events.findIndex(event => event.type === 'text_delta') < events.findIndex(event => event.type === 'completed'))
  assert.equal(thinking.getAttribute('aria-pressed'), 'true')
  assert.equal(page.clicks, 1)
  assert.equal(result.artifacts[0].name, 'README.md')
  assert.ok(events.some(event => event.type === 'file_links'))
  const requested = await f.driver.download({ key: 'fixture-test', webConversationId: result.webConversationId, path: result.artifacts[0].path, messageId: result.artifacts[0].messageId })
  assert.equal(requested.requested, true); assert.equal(downloads, 1)
  await adapter.tick()
  assert.equal(sends, 1)
})

test('extension manifest only exposes ChatGPT and local bridge access', async () => {
  const manifest = JSON.parse(await readFile(new URL('../edge-extension/manifest.json', import.meta.url)))
  assert.deepEqual(manifest.permissions, ['storage', 'alarms'])
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*', 'http://127.0.0.1/*'])
  assert.equal(manifest.externally_connectable, undefined)
  assert.equal(manifest.web_accessible_resources, undefined)
  assert.equal(manifest.content_scripts[0].all_frames, false)
})
