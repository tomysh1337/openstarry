import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { isChatGPT, parsePairingCode, executeOnce } from '../edge-extension/protocol.mjs'

const source = (await readFile(new URL('../edge-extension/background.mjs', import.meta.url), 'utf8')).replace(/^import .*?\n/, '')
function fixture(responses, url = 'https://chatgpt.com/') {
  const local = {}, session = { pages: { 'http://127.0.0.1:1234/test': 1 } }
  const storage = data => ({
    setAccessLevel: async () => {},
    get: async name => ({ [name]: data[name] }),
    set: async values => Object.assign(data, values),
    remove: async name => { delete data[name] }
  })
  let calls = 0
  const activated = []
  const context = {
    isChatGPT, parsePairingCode, executeOnce, URL, AbortSignal,
    setTimeout: callback => setTimeout(callback, 1),
    chrome: {
      storage: { local: storage(local), session: storage(session) },
      tabs: { get: async () => ({ url }), update: async id => { activated.push(id) }, sendMessage: async () => responses[Math.min(calls++, responses.length - 1)] },
      runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} } },
      alarms: { onAlarm: { addListener() {} }, create() {} }
    }
  }
  runInNewContext(source + '\nglobalThis.bridgeTest = { execute, pageMessage }', context)
  return { ...context.bridgeTest, activated, get calls() { return calls } }
}
const command = () => ({ method: 'page', args: { key: 'test' }, expiresAt: Date.now() + 2000 })

test('download uses the mapped ChatGPT tab and only activates it after the page accepts', async () => {
  const request = { ...command(), method: 'download', args: { key: 'test', path: 'sandbox:/mnt/data/README.md', webConversationId: 'chat' } }
  const f = fixture([{ contentVersion: 3, result: { requested: true } }])
  assert.equal((await f.execute(request, { origin: 'http://127.0.0.1:1234' }, 0)).requested, true)
  assert.deepEqual(f.activated, [1])
  const moved = fixture([{ contentVersion: 3, result: { requested: true } }], 'https://example.com/')
  await assert.rejects(moved.execute(request, { origin: 'http://127.0.0.1:1234' }, 0), error => error.code === 'SESSION_CHANGED')
  assert.equal(moved.calls, 0); assert.deepEqual(moved.activated, [])
})

test('page preparation waits for the composer, not just a responding content script', async () => {
  const f = fixture([
    { contentVersion: 3, result: { input: false, login: false, challenge: false } },
    { contentVersion: 3, result: { input: false, login: false, challenge: false } },
    { contentVersion: 3, result: { input: true, login: false, challenge: false } }
  ])
  assert.equal(await f.execute(command(), { origin: 'http://127.0.0.1:1234' }, 0), true)
  assert.equal(f.calls, 3)
})

test('an old content script gives explicit reload instructions instead of silently ignoring thinking', async () => {
  const f = fixture([{ result: { input: true } }])
  await assert.rejects(f.execute(command(), { origin: 'http://127.0.0.1:1234' }, 0), error => error.code === 'EXTENSION_RELOAD_REQUIRED')
  assert.equal(f.calls, 1)
})

test('page login and verification states return for actionable errors without waiting out readiness', async () => {
  for (const state of [{ login: true }, { challenge: true }]) {
    const f = fixture([{ contentVersion: 3, result: { input: false, ...state } }])
    assert.equal(await f.execute(command(), { origin: 'http://127.0.0.1:1234' }, 0), true)
    assert.equal(f.calls, 1)
  }
})
