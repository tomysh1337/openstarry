import test from 'node:test'
import assert from 'node:assert/strict'
import { contentFixture } from './content-fixture.mjs'
const baseline = { userCount: 0, userMessageId: '', webConversationId: null }

test('DOM character changes are retained between inspections while the reply is still generating', async t => {
  const f = contentFixture(t)
  for (const text of ['字', '字字', '字字传']) { f.answer(text); await Promise.resolve() }
  const status = (await f.invoke({ method: 'inspect', consumeUpdates: false })).result
  assert.equal(status.busy, true); assert.equal(status.finished, false)
  const observed = (await f.invoke({ method: 'inspect' })).result
  assert.deepEqual(Array.from(observed.textUpdates, update => update.text), ['字', '字', '传'])
  assert.deepEqual(Array.from(observed.textUpdates, update => update.offset), [0, 1, 2])
  assert.equal((await f.invoke({ method: 'inspect' })).result.textUpdates.length, 0)
  f.answer('改写'); await Promise.resolve()
  assert.equal((await f.invoke({ method: 'inspect' })).result.textUpdates[0].replace, true)
})

test('content messaging rejects foreign senders and preserves existing page drafts', async t => {
  const f = contentFixture(t, { draft: '用户未发送的草稿' })
  assert.equal(f.listener({ type: 'openstarry-page', method: 'send' }, { id: 'foreign' }, () => {}), false)
  assert.equal((await f.invoke({ method: 'send', text: '新消息', baseline })).error.code, 'PAGE_DRAFT')
  assert.equal(f.input.textContent, '用户未发送的草稿'); assert.equal(f.clicks, 0)
})

test('artifact metadata preserves a real file link and download clicks that exact response only', async t => {
  const f = contentFixture(t); f.addUser('生成文件'); f.answer('文件已生成', { busy: false, finished: true })
  const message = f.document.querySelector('[data-message-author-role="assistant"]')
  const link = f.document.createElement('a'); link.href = 'sandbox:/mnt/data/README.md'; link.textContent = '下载 README.md'; message.append(link)
  let downloads = 0
  link.onclick = event => { event.preventDefault(); downloads++ }
  const snapshot = (await f.invoke({ method: 'inspect' })).result
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.artifacts)), [{ path: 'sandbox:/mnt/data/README.md', name: 'README.md', messageId: 'answer-one' }])
  const request = { method: 'download', path: snapshot.artifacts[0].path, messageId: 'answer-one', webConversationId: 'fixture-conversation' }
  assert.equal((await f.invoke(request)).result.requested, true); assert.equal(downloads, 1)
  assert.equal((await f.invoke({ ...request, messageId: 'other-answer' })).error.code, 'FILE_NOT_FOUND')
  assert.equal((await f.invoke({ ...request, webConversationId: 'other-chat' })).error.code, 'SESSION_CHANGED')
  assert.equal((await f.invoke({ ...request, path: 'https://example.com/file' })).error.code, 'FILE_REQUEST_INVALID')
  assert.equal(downloads, 1)
})
test('legacy inline download verifies its original prompt and never opens an unrelated file', async t => {
  const f = contentFixture(t); f.addUser('原来的问题'); f.answer('下载文件', { busy: false, finished: true })
  const link = f.document.createElement('a'); link.href = 'sandbox:/mnt/data/README.md'
  f.document.querySelector('[data-message-author-role="assistant"]').append(link)
  let clicks = 0; link.onclick = event => { event.preventDefault(); clicks++ }
  const request = { method: 'download', path: 'sandbox:/mnt/data/README.md', webConversationId: 'fixture-conversation' }
  assert.equal((await f.invoke({ ...request, expectedPrompt: '另一条问题' })).error.code, 'FILE_NOT_FOUND')
  assert.equal((await f.invoke({ ...request, expectedPrompt: '原来的问题' })).result.requested, true)
  assert.equal(clicks, 1)
})

test('current composer button submits multiline text and confirms a new user message', async t => {
  const f = contentFixture(t)
  assert.equal((await f.invoke({ method: 'send', text: 'new', baseline: { ...baseline, userCount: 4 } })).error.code, 'SESSION_CHANGED')
  const response = await f.invoke({ method: 'send', text: '中文第一行\n第二行', baseline })
  assert.equal(response.result.sent, true); assert.equal(f.clicks, 1)
  assert.equal(response.result.userMessageId, 'user-1'); assert.equal(response.result.userCount, 1)
  assert.equal(response.result.webConversationId, 'fixture-conversation')
  assert.equal((await f.invoke({ method: 'inspect' })).result.lastUser, '中文第一行\n第二行')
})

test('legacy send button and textarea remain supported', async t => {
  const f = contentFixture(t, { textarea: true, button: 'data-testid="send-button"' })
  assert.equal((await f.invoke({ method: 'send', text: 'hello', baseline })).result.sent, true)
  assert.equal(f.clicks, 1)
})

test('a click without delivery reports uncertainty and never clicks twice', async t => {
  const f = contentFixture(t); f.confirm = false
  assert.equal((await f.invoke({ method: 'send', text: '待发送', baseline })).error.code, 'DELIVERY_UNCERTAIN')
  assert.equal(f.clicks, 1); assert.equal(f.input.textContent, '待发送')
})

test('disabled Send waits for a rerender and uses the replacement editor', async t => {
  const f = contentFixture(t)
  f.send.setAttribute('aria-disabled', 'true')
  f.input.addEventListener('input', () => {
    setTimeout(() => { f.input.replaceWith(f.input.cloneNode(true)); f.send.setAttribute('aria-disabled', 'false') }, 5)
  })
  assert.equal((await f.invoke({ method: 'send', text: '重新渲染', baseline })).result.sent, true)
  assert.equal(f.clicks, 1)
})

test('challenge, expiry and a reused Stop button prevent submission', async t => {
  const f = contentFixture(t)
  f.send.setAttribute('aria-label', 'Stop generating')
  assert.equal((await f.invoke({ method: 'send', text: 'new', baseline })).error.code, 'PAGE_NOT_READY')
  f.send.setAttribute('aria-label', 'Send')
  assert.equal((await f.invoke({ method: 'send', text: 'new', baseline, expiresAt: 1 })).error.code, 'SEND_EXPIRED')
  const banner = f.document.createElement('div'); banner.textContent = 'Verify you are human'; f.document.body.prepend(banner)
  assert.equal((await f.invoke({ method: 'inspect' })).result.challenge, true)
  assert.ok((await f.invoke({ method: 'send', text: 'new', baseline })).error)
  assert.equal(f.clicks, 0)
})

test('thinking toggles before input and is verified, including already-selected and off states', async t => {
  for (const [initial, wanted, expectedClicks] of [[false, true, 1], [true, true, 0], [true, false, 1]]) {
    const f = contentFixture(t), control = f.document.createElement('button')
    control.type = 'button'; control.textContent = '思考'; control.setAttribute('aria-pressed', String(initial))
    f.input.after(control)
    let changes = 0
    control.onclick = () => { assert.equal(f.input.textContent, ''); changes++; control.setAttribute('aria-pressed', String(!initial)) }
    const result = await f.invoke({ method: 'send', text: '测试思考', thinking: wanted, baseline })
    assert.equal(result.result.sent, true); assert.equal(changes, expectedClicks)
    assert.equal(control.getAttribute('aria-pressed'), String(wanted))
  }
})

test('thinking menu selects 思考 and does not select 深度研究', async t => {
  const f = contentFixture(t), opener = f.document.createElement('button')
  opener.type = 'button'; opener.id = 'composer-plus-btn'; opener.setAttribute('aria-label', '添加文件和更多')
  f.input.after(opener)
  let researchClicks = 0
  opener.onclick = () => {
    const menu = f.document.createElement('div')
    const research = f.document.createElement('button'); research.textContent = '深度研究'; research.onclick = () => researchClicks++
    const think = f.document.createElement('button'); think.textContent = '思考'; think.setAttribute('role', 'menuitemcheckbox'); think.setAttribute('aria-checked', 'false')
    think.onclick = () => { think.setAttribute('aria-checked', 'true') }
    menu.append(research, think); f.document.body.append(menu)
  }
  assert.equal((await f.invoke({ method: 'send', text: '思考测试', thinking: true, baseline })).result.sent, true)
  assert.equal(researchClicks, 0)
})

test('unknown thinking controls produce an actionable error before typing or sending', async t => {
  const f = contentFixture(t)
  assert.equal((await f.invoke({ method: 'send', text: 'test', thinking: true, baseline })).error.code, 'THINKING_UNAVAILABLE')
  assert.equal(f.input.textContent, ''); assert.equal(f.clicks, 0)
})

test('partial response is observable before completion; new action labels end only an idle turn', async t => {
  const f = contentFixture(t)
  f.answer('第一段', { busy: true, finished: true })
  let state = (await f.invoke({ method: 'inspect' })).result
  assert.equal(state.text, '第一段'); assert.equal(state.finished, false); assert.equal(state.busy, true)
  f.answer('第一段，后续内容', { busy: false, finished: true, streaming: true })
  assert.equal((await f.invoke({ method: 'inspect' })).result.finished, false)
  for (const action of ['复制回复', 'Copy response', '复制', 'Good response']) {
    f.answer('完整内容', { busy: false, finished: true, action })
    state = (await f.invoke({ method: 'inspect' })).result
    assert.equal(state.finished, true); assert.equal(state.text, '完整内容')
  }
})

test('code Copy and older-turn controls never mark an unfinished response complete', async t => {
  const f = contentFixture(t)
  f.answer('代码尚在生成', { busy: false })
  const pre = f.document.createElement('pre'), copy = f.document.createElement('button')
  copy.setAttribute('aria-label', 'Copy'); pre.append(copy)
  f.document.querySelector('[data-message-author-role="assistant"]').append(pre)
  assert.equal((await f.invoke({ method: 'inspect' })).result.finished, false)
  const old = f.document.createElement('article'); old.innerHTML = '<button aria-label="Copy response"></button>'
  f.document.querySelector('main').prepend(old)
  assert.equal((await f.invoke({ method: 'inspect' })).result.finished, false)
})
