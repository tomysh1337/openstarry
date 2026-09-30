import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from '../../../CLIENT/openstarry-app/node_modules/jsdom/lib/api.js'
import { createSubagentView } from '../src/subagentView.js'
import { createSandboxView } from '../src/sandboxView.js'
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function dom(t) { const dom = new JSDOM('<main></main>'), previous = globalThis.document; globalThis.document = dom.window.document; t.after(() => { globalThis.document = previous; dom.window.close() }); return dom.window.document }
test('child result, cancellation and late workspace changes keep ownership', async t => {
  const document = dom(t), calls = [], child = { id: 'child', task_id: 'parent', name: 'review', status: 'generating', done: false }, result = { ...child, text: '<script>result</script>', offset: 0, next_offset: null }, view = createSubagentView({ services: async args => { calls.push(args); return { subagent: result } } })
  t.after(() => view.close()); document.body.append(view.element); view.update([child], 'workspace')
  view.element.querySelector('button').click(); await settle()
  assert.equal(view.element.querySelector('pre').textContent, result.text); assert.equal(view.element.querySelector('script'), null)
  const stop = [...view.element.querySelectorAll('button')].find(b => b.textContent === '停止子 Agent'); stop.click(); await settle()
  assert.equal(calls.at(-1).action, 'subagent-cancel'); assert.equal(calls.at(-1).projectId, 'workspace')
  view.update([], 'other'); assert.equal(view.element.querySelector('pre'), null)
  let resolve
  const delayed = createSubagentView({ services: () => new Promise(done => { resolve = done }) }); t.after(() => delayed.close())
  delayed.update([child], 'workspace'); delayed.element.querySelector('button').click(); delayed.update([], 'other'); resolve({ subagent: result }); await settle()
  assert.equal(delayed.element.querySelector('pre'), null)
})

test('child progress is visible without a click and partial output refreshes before completion', async t => {
  dom(t)
  const child = { id: 'child', task_id: 'parent', name: '<b>读取项目</b>', status: 'generating', done: false, progress: { characters: 1, toolCount: 2, activeTool: 'read_file', preview: '首' } }
  let result = { ...child, text: '首', offset: 0, next_offset: null }
  const view = createSubagentView({ services: async () => ({ subagent: result }) }); t.after(() => view.close())
  view.update([child], 'workspace')
  assert.equal(view.element.hidden, false); assert.match(view.element.textContent, /已接收 1 字.*2 次工具调用.*read_file/)
  assert.equal(view.element.querySelector('b'), null)
  await view.refresh(); assert.equal(view.element.querySelector('pre').textContent, '首')
  result = { ...result, text: '首段继续到达', progress: { characters: 7, toolCount: 2, preview: '首段继续到达' } }
  view.update([result], 'workspace'); await view.refresh()
  assert.equal(view.element.querySelector('pre').textContent, '首段继续到达')
  result = { ...result, status: 'error', done: true, error: { code: 'SESSION_CHANGED', message: '网页会话已改变' } }
  view.update([result], 'workspace'); await view.refresh()
  assert.equal(view.element.hidden, false); assert.match(view.element.textContent, /SESSION_CHANGED/)
  assert.equal([...view.element.querySelectorAll('button')].find(b => b.textContent === '停止子 Agent').disabled, true)
  view.update([], 'other'); assert.equal(view.element.hidden, true); assert.equal(view.element.querySelector('pre'), null)
})
test('sandbox details escape command text and approval is a distinct local action', async t => {
  const document = dom(t), calls = [], job = { id: 'job', task_id: 'parent', command: '<b>echo</b>', status: 'awaiting_approval', network: true, timeout_seconds: 30 }, view = createSandboxView({ services: async args => { calls.push(args); return { execution: { ...job, output: '<script>output</script>', offset: 0, next_offset: null }, sandbox: { jobs: [job] } } } })
  t.after(() => view.close()); document.body.append(view.element); view.update({ configured: true, jobs: [job] }, 'work')
  const find = text => [...view.element.querySelectorAll('button')].find(b => b.textContent.includes(text))
  find('echo').click(); await settle(); assert.equal(calls[0].action, 'sandbox-read'); assert.equal(view.element.querySelector('script'), null)
  find('批准本次执行').click(); await settle(); assert.equal(calls[1].action, 'sandbox-approve'); assert.equal(calls[1].projectId, 'work')
  view.update({ jobs: [] }, 'other'); assert.equal(view.element.querySelector('pre'), null)
})
