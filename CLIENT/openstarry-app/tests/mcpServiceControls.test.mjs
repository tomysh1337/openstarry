import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { componentUrl } from './vueComponent.mjs'

const dom = new JSDOM('<!doctype html><body></body>')
for (const name of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node']) globalThis[name] = dom.window[name]
const { createApp, nextTick } = await import('vue')
const Component = (await import(await componentUrl(new URL('../src/renderer/src/views/component/comp/McpServiceControls.vue', import.meta.url)))).default
const stopped = () => ({ bridge: { status: 'stopped', busy: false }, tunnel: { status: 'stopped', running: false } })
const ready = () => ({ bridge: { status: 'ready', busy: false, projectName: '首页网页对话' }, tunnel: { status: 'connected', running: true, origin: 'https://fixture.example' }, browser: { extensionConnected: false } })
async function settle() { for (let i = 0; i < 5; i++) { await Promise.resolve(); await nextTick() } }
async function fixture(t, handler) {
  const host = document.createElement('div'); document.body.append(host)
  const calls = []
  window.api = { ide: { gpt: { services: async value => { calls.push(value); return handler(value) } } } }
  const app = createApp(Component, { ready: true, project: { id: 'home' } })
  app.mount(host); await settle()
  t.after(() => { app.unmount(); host.remove() })
  const button = label => [...host.querySelectorAll('button')].find(item => item.textContent.trim() === label)
  return { host, calls, button, click: async element => { element.click(); await settle() } }
}

test('toolbar refresh only reads; switches and copy buttons route to the real service contract', async t => {
  let state = stopped()
  const f = await fixture(t, ({ action }) => {
    if (action === 'tunnel-start') state = ready()
    if (action === 'bridge-stop') state = stopped()
    return { ...state, message: action === 'copy-address' ? '连接器地址已复制' : '' }
  })
  assert.deepEqual(f.calls.map(item => item.action), ['status'])
  const bridge = f.host.querySelector('[role="switch"][aria-label="MCP Bridge"]')
  const tunnel = f.host.querySelector('[role="switch"][aria-label="Cloudflare Tunnel"]')
  assert.equal(bridge.getAttribute('aria-checked'), 'false')
  assert.equal(f.button('复制 MCP 公网地址').disabled, true)
  await f.click(tunnel)
  assert.equal(f.calls.at(-1).action, 'tunnel-start')
  assert.equal(bridge.getAttribute('aria-checked'), 'true')
  assert.equal(tunnel.getAttribute('aria-checked'), 'true')
  assert.match(f.host.textContent, /隧道已连接/)
  await f.click(f.button('复制 MCP 公网地址'))
  assert.match(f.host.textContent, /连接器地址已复制/)
  await f.click(f.button('复制 Edge 配对码'))
  assert.equal(f.calls.at(-1).action, 'pair')
  await f.click(bridge)
  assert.equal(f.calls.at(-1).action, 'bridge-stop')
  assert.equal(tunnel.getAttribute('aria-checked'), 'false')
  const menu = f.host.querySelector('details'); menu.open = true
  menu.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.equal(menu.open, false)
})

test('busy replies prevent Bridge shutdown; operation failures remain visible after refresh', async t => {
  const f = await fixture(t, ({ action }) => {
    if (action === 'tunnel-stop') throw Error('隧道关闭失败 fixture')
    const state = ready(); state.bridge.busy = true; return state
  })
  const bridge = f.host.querySelector('[role="switch"][aria-label="MCP Bridge"]')
  assert.equal(bridge.disabled, true)
  await f.click(f.host.querySelector('[role="switch"][aria-label="Cloudflare Tunnel"]'))
  assert.match(f.host.querySelector('[role="alert"]').textContent, /隧道关闭失败/)
  await f.click(f.button('刷新'))
  assert.match(f.host.querySelector('[role="alert"]').textContent, /隧道关闭失败/)
})

test('a pending operation disables duplicate clicks and never paints success early', async t => {
  let finish
  const f = await fixture(t, ({ action }) => action === 'bridge-start' ? new Promise(resolve => { finish = resolve }) : stopped())
  const bridge = f.host.querySelector('[role="switch"][aria-label="MCP Bridge"]')
  await f.click(bridge)
  assert.equal(bridge.disabled, true)
  assert.equal(bridge.getAttribute('aria-checked'), 'false')
  await f.click(bridge)
  assert.equal(f.calls.filter(value => value.action === 'bridge-start').length, 1)
  finish(ready()); await settle()
  assert.equal(bridge.getAttribute('aria-checked'), 'true')
})

test('full-disk scope is shown separately from the active conversation workspace', async t => {
  const f = await fixture(t, () => { const state = ready(); state.bridge.fileScope = 'all-disks'; return state })
  assert.match(f.host.textContent, /文件范围：全盘/)
  assert.match(f.host.textContent, /当前任务工作区：首页网页对话/)
})

test('homepage reviews connector proposals with escaped content and only saves after explicit acceptance', async t => {
  let pending = true, conflict = false
  const proposal = { id: 'proposal-one', path: 'fixture.txt', absolutePath: 'C:/Fixture/fixture.txt', before: '<script>before</script>', after: '<b>after</b>' }
  const f = await fixture(t, ({ action, projectId, proposalId }) => {
    const state = ready(); state.bridge.projectId = 'active-ide'; state.bridge.newFilePolicy = 'direct'
    if (action.startsWith('review-')) {
      assert.equal(projectId, 'active-ide'); assert.equal(proposalId, proposal.id)
    }
    if (action === 'review-accept') {
      if (conflict) throw Error('VERSION_CONFLICT: 文件已改变')
      pending = false
    }
    return { ...state, pendingProposals: pending ? [proposal] : [], ...(action === 'review-read' ? { proposal } : {}), message: action === 'review-accept' ? '修改已接受并保存' : '' }
  })
  assert.match(f.host.textContent, /新文件直接保存/)
  assert.match(f.host.querySelector('summary').textContent, /待审查 1/)
  assert.equal(f.button('接受并保存'), undefined)
  await f.click(f.button(proposal.absolutePath))
  assert.equal(f.host.querySelector('.before').textContent, proposal.before)
  assert.equal(f.host.querySelector('.after').textContent, proposal.after)
  assert.equal(f.host.querySelector('.proposal-detail script'), null)
  await f.click(f.button('刷新'))
  assert.ok(f.button('接受并保存'), 'refresh retains the selected review')
  conflict = true
  await f.click(f.button('接受并保存'))
  assert.match(f.host.querySelector('[role="alert"]').textContent, /VERSION_CONFLICT/)
  assert.ok(f.button('接受并保存'), 'failed acceptance retains the proposal')
  conflict = false
  await f.click(f.button('接受并保存'))
  assert.match(f.host.textContent, /修改已接受并保存/)
  assert.equal(f.host.querySelector('.proposal-detail'), null)
  assert.equal(f.host.querySelector('.review-badge'), null)
})

test('homepage discards an open review after a project switch', async t => {
  let projectId = 'one'
  const proposal = { id: 'old', path: 'old.txt', before: 'before', after: 'after' }
  const f = await fixture(t, ({ action }) => ({ ...ready(), bridge: { status: 'ready', projectId }, pendingProposals: projectId === 'one' ? [proposal] : [], ...(action === 'review-read' ? { proposal } : {}) }))
  await f.click(f.button('old.txt'))
  assert.ok(f.button('拒绝提议'))
  projectId = 'two'
  await f.click(f.button('刷新'))
  assert.equal(f.button('接受并保存'), undefined)
})

test('homepage exposes live child progress outside the service menu and keeps failed tasks visible', async t => {
  let child = { id: 'child', task_id: 'parent', name: '<script>阅读项目</script>', status: 'generating', done: false, progress: { characters: 2, toolCount: 3, activeTool: 'read_file', preview: '首段' } }
  let projectId = 'one'
  const f = await fixture(t, ({ action }) => ({ ...ready(), bridge: { status: 'ready', projectId }, subagents: { subagents: projectId === 'one' ? [child] : [] }, ...(action === 'subagent-read' ? { subagent: { ...child, text: child.progress.preview, offset: 0, next_offset: null } } : {}) }))
  const progress = () => f.host.querySelector('[aria-label="子 Agent 进度"]')
  assert.equal(f.host.querySelector('details').open, false)
  assert.equal(progress().closest('details'), null)
  assert.match(progress().textContent, /已接收 2 字.*3 次工具调用.*read_file/)
  assert.match(progress().textContent, /首段/); assert.equal(progress().querySelector('script'), null)
  child = { ...child, status: 'error', done: true, progress: { ...child.progress, characters: 5, preview: '收到的内容' }, error: { code: 'SESSION_CHANGED', message: '网页会话已改变' } }
  await f.click(f.button('刷新'))
  assert.match(progress().textContent, /SESSION_CHANGED/)
  assert.match(f.host.querySelector('summary').textContent, /子 Agent 1 · 0 进行中/)
  await f.click(progress().querySelector('button'))
  assert.equal(f.host.querySelector('details').open, true)
  assert.equal(f.host.querySelector('.proposal-detail pre').textContent, '收到的内容')
  projectId = 'two'; await f.click(f.button('刷新'))
  assert.equal(progress(), null); assert.equal(f.host.querySelector('.proposal-detail'), null)
})

test('automatic polling discovers a child that failed between polls without opening the menu', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let children = []
  const f = await fixture(t, () => ({ ...ready(), subagents: { subagents: children } }))
  assert.equal(f.host.querySelector('[aria-label="子 Agent 进度"]'), null)
  children = [{ id: 'brief-child', task_id: 'parent', name: '读取项目', done: true, status: 'error', error: { code: 'SESSION_CHANGED', message: '网页消息已改变' } }]
  t.mock.timers.tick(2000); await settle()
  assert.equal(f.host.querySelector('details').open, false)
  assert.match(f.host.querySelector('[aria-label="子 Agent 进度"]').textContent, /SESSION_CHANGED/)
  assert.deepEqual(f.calls.map(value => value.action), ['status', 'status'])
})
