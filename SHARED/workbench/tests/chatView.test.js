import test from 'node:test'
import assert from 'node:assert/strict'
import MarkdownIt from 'markdown-it'
import { JSDOM } from '../../../CLIENT/openstarry-app/node_modules/jsdom/lib/api.js'
import { createChatMessage } from '../src/chatView.js'

test('IDE renders received text progressively and routes file buttons to their artifact', async t => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true }), { document } = dom.window
  const saved = Object.fromEntries(['document', 'requestAnimationFrame', 'cancelAnimationFrame'].map(name => [name, globalThis[name]]))
  let callback = null
  Object.assign(globalThis, { document, requestAnimationFrame: value => { callback = value; return 1 }, cancelAnimationFrame: () => { callback = null } })
  t.after(() => { Object.assign(globalThis, saved); dom.window.close() })
  const item = { role: 'assistant', content: '', parts: [], status: 'running', web: { taskId: 'task' } }, downloads = []
  const view = createChatMessage(item, { markdown: new MarkdownIt(), icon: () => document.createElement('i'), hasProposal: () => false,
    download: async path => { downloads.push(path); return { requested: true, message: '已发起下载' } } })
  t.after(() => view.close())
  document.querySelector('main').append(view.element); view.update()
  item.content = '你好，世界'; item.parts.push({ type: 'text', id: 'gpt-web-text', text: item.content }); view.update()
  const body = view.element.querySelector('.os-message-content')
  assert.equal(body.textContent.trim(), '你好，世界')
  assert.equal(item.status, 'running')
  item.parts[0].text += '，继续'; item.content = item.parts[0].text; view.update()
  assert.equal(body.textContent.trim(), item.content)
  item.status = 'complete'; view.update()
  assert.equal(body.textContent.trim(), item.content); assert.equal(callback, null)
  item.web.startedAt = '2026-09-26T01:00:00.000Z'; item.web.finishedAt = '2026-09-26T01:00:02.500Z'
  item.parts.push({ type: 'tool', id: 'tool', name: 'read_file', provider: 'OpenStarry MCP', input: '{}', output: 'actual output', phase: 'complete', durationMs: 23 })
  view.update()
  const tool = view.element.querySelector('details'); tool.open = true; view.update()
  assert.ok(tool.compareDocumentPosition(body) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING)
  assert.equal(tool.open, true); assert.match(view.element.querySelector('.os-message-elapsed').textContent, /2\.5s/)
  item.web.artifacts = [{ name: 'README.md', path: 'sandbox:/mnt/data/README.md', messageId: 'answer' }]
  view.update()
  view.element.querySelector('.os-web-files button').click()
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(downloads, ['sandbox:/mnt/data/README.md'])
  assert.equal(view.element.querySelector('[role="status"]').textContent, '已发起下载')
})
