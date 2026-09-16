import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
const require = createRequire(new URL('../../../MOBILE/openstarry-mobile/package.json', import.meta.url))
const { chromium } = require('@playwright/test')
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + (process.env.OPENSTARRY_CDP_PORT || 9229))
const page = browser.contexts()[0].pages()[0]
const serverUrl = 'http://127.0.0.1:8766', userId = 'desktop-ui-local-fixture'
const post = (path, body) => fetch(serverUrl + path, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json())
try {
  const history = await page.evaluate(async config => {
    if (!location.href.includes('/out/')) throw Error('Use an isolated source QA profile')
    await window.api.system.configureSync(config, 'fixture-only-local-token')
    await window.api.system.runSync()
    return document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app').current_history_id
  }, { enabled: true, serverUrl, userId, intervalMinutes: 5 })
  const remote = await post('/v1/sync', { userId, cursor: 0, operations: [] })
  const historyMessages = remote.records.filter(record => record.kind === 'message' && record.payload.conversation_uid === history)
  assert.ok(historyMessages.length)
  const template = historyMessages.find(record => record.payload.role === 'human').payload
  const syncId = crypto.randomUUID(), text = '手机同步实时消息 ' + syncId.slice(0, 6)
  const parent = historyMessages.toSorted((a, b) => b.payload.msg_cursor - a.payload.msg_cursor)[0].payload.node_id
  const message = { ...template, sync_id: syncId, node_id: syncId, generation_id: syncId, content: text, parent_id: parent, msg_cursor: Math.max(...historyMessages.map(record => record.payload.msg_cursor)) + 1, msg_timestamp: Date.now(), created_at: new Date().toISOString(), extra: '{}', info: '{}' }
  const records = [
    { id: 'message:' + history + ':' + syncId, kind: 'message', payload: message },
    { id: 'preference:modelName', kind: 'preference', payload: { key: 'modelName', value: 'second-model' } },
    { id: 'preference:modelTemp', kind: 'preference', payload: { key: 'modelTemp', value: 37 } }
  ]
  await post('/v1/sync', { userId, operations: records.map(record => ({ opId: crypto.randomUUID(), deviceId: 'phone-test', modifiedAt: Date.now() + 2000, record })) })
  await page.evaluate(() => window.api.system.runSync())
  await page.getByText(text, { exact: true }).waitFor()
  await page.waitForFunction(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')
    return store.config.modelName === 'second-model' && store.config.modelTemp === 37
  })
  console.log('PASS: mobile-origin messages and general model preferences appear in the open desktop chat without restarting')
} finally {
  await page.evaluate(() => window.api.system.configureSync({ enabled: false }))
  await browser.close()
}
