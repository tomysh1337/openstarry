import { readFile } from 'node:fs/promises'
import { JSDOM } from '../../../CLIENT/openstarry-app/node_modules/jsdom/lib/api.js'
const source = await readFile(new URL('../edge-extension/content.js', import.meta.url), 'utf8')

export function contentFixture(t, { draft = '', button = 'id="composer-submit-button" aria-label="发送提示"', textarea = false } = {}) {
  const dom = new JSDOM('<main></main><form>' + (textarea ? '<textarea id="prompt-textarea"></textarea>' : '<div id="prompt-textarea" contenteditable="true"></div>') + '<button type="button" ' + button + '></button></form>', { url: 'https://chatgpt.com/', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom, { document } = window
  let listener, clicks = 0, now = Date.now(), confirm = true
  window.Date.now = () => now
  window.setTimeout = (callback, ms) => setTimeout(() => { now += ms; callback() }, 0)
  window.HTMLElement.prototype.getClientRects = function () { return this.hidden || this.closest('[hidden]') ? [] : [1] }
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent }, set(value) { this.textContent = value } })
  const input = document.querySelector('#prompt-textarea'), send = document.querySelector('button')
  if (textarea) input.value = draft; else input.textContent = draft
  document.execCommand = (_name, _ui, value) => { document.querySelector('#prompt-textarea').textContent = value; return true }
  window.chrome = { runtime: { id: 'fixture-extension', onMessage: { addListener: value => { listener = value } } } }
  window.eval(source)
  const addUser = value => {
    const user = document.createElement('div')
    user.dataset.messageAuthorRole = 'user'; user.dataset.messageId = 'user-' + (document.querySelectorAll('[data-message-author-role="user"]').length + 1)
    user.textContent = value; document.querySelector('main').append(user)
    window.history.replaceState(null, '', '/c/fixture-conversation')
  }
  send.addEventListener('click', () => {
    clicks++
    if (!confirm) return
    const active = document.querySelector('#prompt-textarea')
    addUser(active.value ?? active.textContent)
    if (textarea) active.value = ''; else active.textContent = ''
  })
  const invoke = value => new Promise(resolve => listener({ type: 'openstarry-page', expiresAt: now + 15000, ...value }, { id: 'fixture-extension' }, resolve))
  const answer = (value, { busy = true, finished = false, action = '复制回复', streaming = false } = {}) => {
    let turn = document.querySelector('article')
    if (!turn) {
      turn = document.createElement('article'); turn.dataset.testid = 'conversation-turn-2'
      const message = document.createElement('div'); message.dataset.messageAuthorRole = 'assistant'; message.dataset.messageId = 'answer-one'
      turn.append(message); document.querySelector('main').append(turn)
    }
    turn.querySelector('[data-message-author-role]').textContent = value
    turn.querySelectorAll('button').forEach(el => el.remove())
    if (finished) { const copy = document.createElement('button'); copy.setAttribute('aria-label', action); turn.append(copy) }
    turn.dataset.isStreaming = String(streaming)
    if (!streaming) delete turn.dataset.isStreaming
    send.setAttribute('aria-label', busy ? '停止生成' : '发送提示')
  }
  return { document, window, input, send, invoke, listener, addUser, answer,
    get clicks() { return clicks }, get now() { return now }, set confirm(value) { confirm = value } }
}
