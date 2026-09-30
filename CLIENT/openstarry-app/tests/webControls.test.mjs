import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { componentUrl } from './vueComponent.mjs'
const dom = new JSDOM('<body></body>')
for (const name of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node']) globalThis[name] = dom.window[name]
const { createApp, nextTick, reactive } = await import('vue')
const Safety = (await import(await componentUrl(new URL('../src/renderer/src/views/component/comp/SafetyLevel.vue', import.meta.url)))).default
const Tools = (await import(await componentUrl(new URL('../src/renderer/src/views/component/msg_bubble_body/comp/WebToolCalls.vue', import.meta.url)))).default
async function settle() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
test('home approval dropdown loads the current policy and persists a selected level', async t => {
  const calls = []
  window.api = { ide: { gpt: { services: async args => { calls.push(args); return { bridge: { safetyMode: args.safetyMode || 'auto' } } } } } }
  const host = document.createElement('div'); document.body.append(host)
  const app = createApp(Safety); app.mount(host); await settle(); t.after(() => { app.unmount(); host.remove() })
  assert.match(host.textContent, /帮我批准/)
  const details = host.querySelector('details'); details.open = true; details.dispatchEvent(new window.Event('toggle')); await settle()
  const menu = document.querySelector('[role="radiogroup"]')
  assert.ok(!host.contains(menu), 'dropdown must escape the input bar clipping boundary')
  const options = [...menu.querySelectorAll('button')]; assert.equal(options.length, 3)
  options[2].click(); await settle()
  assert.deepEqual(calls.at(-1), { action: 'safety-set', safetyMode: 'full' }); assert.match(host.textContent, /完全访问权限/)
  assert.equal(details.open, false)
})
test('homepage tool dropdown renders actual request/result safely and preserves expansion', async t => {
  const props = reactive({ tools: [{ id: 'call', provider: 'OpenStarry MCP', name: 'read_file', input: '{"path":"hello.txt"}', output: '', phase: 'running' }] })
  const host = document.createElement('div'); document.body.append(host)
  const app = createApp(Tools, props); app.mount(host); await settle(); t.after(() => { app.unmount(); host.remove() })
  const details = host.querySelector('details'); details.open = true
  props.tools[0].output = '<script>tool output</script>'; props.tools[0].durationMs = 1234; props.tools[0].phase = 'complete'; await settle()
  assert.equal(details.open, true); assert.equal(host.querySelector('script'), null)
  assert.match(host.textContent, /OpenStarry MCP/); assert.match(host.textContent, /hello\.txt/); assert.match(host.textContent, /tool output/); assert.match(host.textContent, /1\.23s/)
})
