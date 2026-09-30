(() => {
  const version = 3
  const promptSelector = '#prompt-textarea,textarea[data-testid="prompt-textarea"]'
  const visible = el => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
  const all = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible)
  const find = selector => all(selector)[0]
  const text = el => el?.innerText ?? el?.textContent ?? ''
  const normalize = value => value.replace(/\s+/g, ' ').trim()
  const label = el => normalize(el.getAttribute('aria-label') || el.getAttribute('title') || text(el))
  const enabled = el => el && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
  const fail = (code, message) => Object.assign(Error(message), { code })
  const pause = () => new Promise(resolve => setTimeout(resolve, 100))
  const composer = () => find(promptSelector)?.closest('form') || find(promptSelector)?.closest('[data-type="unified-composer"]') || find(promptSelector)?.parentElement
  const isStop = el => el.getAttribute('data-testid') === 'stop-button' || /^(stop(?: generating| streaming| response)?|停止(?:生成|回答|回复|流式传输)?)$/i.test(label(el))
  const stopButton = () => all('button').find(isStop)
  function sendButton() {
    const root = composer()
    if (!root) return null
    return all('button', root).find(el => !isStop(el) && !/voice|语音|dictat|听写/i.test(label(el)) && (
      el.id === 'composer-submit-button' || el.getAttribute('data-testid') === 'send-button' ||
      /^(send(?: message| prompt)?|发送(?:消息|提示)?)$/i.test(label(el)) || el.getAttribute('type') === 'submit'
    ))
  }
  const isArtifactPath = path => typeof path === 'string' && path.length <= 1200 && /^sandbox:\/mnt\/data\/[^\u0000-\u001f?#]+$/.test(path)
  function artifacts(message) {
    const messageId = message?.getAttribute('data-message-id')
    if (!messageId) return []
    const links = new Map()
    for (const anchor of all('a[href]', message)) {
      const path = anchor.getAttribute('href')
      if (!isArtifactPath(path)) continue
      let name = path.split('/').at(-1)
      try { name = decodeURIComponent(name) } catch { /* Keep the page's encoded filename. */ }
      links.set(path, { path, name: name.slice(0, 200) || '网页文件', messageId })
      if (links.size === 32) break
    }
    return [...links.values()]
  }
  let observedMessage, observedText = '', updates = [], updateBytes = 0
  function observeText() {
    if (!document?.documentElement) return
    const last = all('[data-message-author-role="assistant"]').at(-1)
    if (!last) return
    const value = text(last)
    if (last === observedMessage && value === observedText) return
    const replace = last !== observedMessage || !value.startsWith(observedText)
    if (last !== observedMessage) { updates = []; updateBytes = 0 }
    const delta = replace ? value : value.slice(observedText.length)
    const update = { messageId: last.getAttribute('data-message-id') || '', text: delta, offset: replace ? 0 : observedText.length, replace, observedAt: Date.now() }
    updates.push(update); updateBytes += delta.length * 3
    if (updates.length > 256 || updateBytes > 128 * 1024) {
      updates = [{ ...update, text: value, offset: 0, replace: true }]; updateBytes = value.length * 3
    }
    observedMessage = last; observedText = value
  }
  // Retain changes between bridge polls, including single-character DOM updates.
  // Observing text never submits messages or changes the page.
  const observer = new MutationObserver(observeText)
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true })
  function inspect(consumeUpdates = false) {
    observeText()
    const textUpdates = consumeUpdates ? updates : []
    if (consumeUpdates) { updates = []; updateBytes = 0 }
    const answers = all('[data-message-author-role="assistant"]'), users = all('[data-message-author-role="user"]')
    const last = answers.at(-1), turn = last?.closest('[data-testid^="conversation-turn-"],article,[data-turn="assistant"]') || last?.parentElement
    // Turn actions can be siblings of the message body. Code-block Copy buttons
    // are not evidence that the whole answer has finished.
    const finished = turn && all('button', turn).some(el => !el.closest('pre,code') && !last?.contains(el) && (
      /^(copy-turn-action-button|copy-turn-action|good-response(?:-turn-action-button)?|bad-response(?:-turn-action-button)?)$/.test(el.getAttribute('data-testid') || '') ||
      /^(Copy(?: response| answer)?|复制(?:回复|回答|回应)?|Good response|Bad response|好的回复|不好的回复|Read aloud|朗读)$/i.test(label(el))
    ))
    const streaming = turn?.matches('[data-is-streaming="true"],[aria-busy="true"]') || (turn && all('[data-is-streaming="true"],.result-streaming,[aria-busy="true"]', turn).length > 0)
    const busy = Boolean(stopButton() || streaming)
    const login = all('button,a').some(el => /^(Log in|Sign in|登录)$/i.test(text(el).trim()))
    const challenge = all('iframe').some(el => /challenges\.cloudflare\.com/.test(el.getAttribute('src') || '')) || /verify you are human|验证您是人类|请完成人机验证|just a moment/i.test(text(document.body).slice(0, 1500))
    // Read the body on every observation, including while Stop is visible.
    // Never wait for the turn toolbar before forwarding partial text.
    return {
      contentVersion: version, input: Boolean(find(promptSelector)), login, challenge, busy,
      text: text(last), textUpdates, artifacts: artifacts(last), assistantCount: answers.length, userCount: users.length,
      assistantMessageId: last?.getAttribute('data-message-id') || '',
      userMessageId: users.at(-1)?.getAttribute('data-message-id') || '', lastUser: text(users.at(-1)),
      finished: Boolean(last && !busy && (finished || turn?.getAttribute('data-is-streaming') === 'false')),
      alert: all('[role="alert"]').map(text).join('\n').slice(0, 2000),
      webConversationId: /^\/c\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(location.pathname)?.[1] || null
    }
  }
  const isThinking = el => /^(思考|深度思考|Think|Thinking|Think longer)$/i.test(label(el))
  function selectionState(el) {
    for (const name of ['aria-pressed', 'aria-checked', 'data-state']) {
      const value = el?.getAttribute(name)
      if (['true', 'checked', 'on', 'active'].includes(value)) return true
      if (['false', 'unchecked', 'off', 'inactive'].includes(value)) return false
    }
    if (el?.querySelector('[data-state="checked"],[data-state="on"],[data-testid="checkmark"],[data-testid="check-icon"]')) return true
    return null
  }
  const thinkingChip = () => {
    const root = composer()
    return root && all('button', root).find(el => /^(移除|取消|关闭|Remove|Disable|Turn off).*(思考|Thinking|Think)/i.test(label(el)) ||
      (isThinking(el) && el.querySelector('[aria-label="Remove"],[aria-label="移除"],[aria-label="关闭"],[data-testid="remove-chip"]')))
  }
  function thinkingControl() {
    const root = composer()
    return root && all('button,[role="switch"]', root).find(isThinking)
  }
  async function setThinking(wanted, deadline) {
    if (wanted === undefined) return
    let control = thinkingControl(), chip = thinkingChip(), state = chip ? true : selectionState(control)
    if (state === wanted) return
    let opener
    if (state === null) {
      const root = composer()
      opener = root && all('button', root).find(el => /^(工具|更多工具|添加文件和更多|添加照片和文件|Tools|More tools|Add files and more|Add photos & files)$/i.test(label(el)) || el.id === 'composer-plus-btn')
      if (opener) {
        opener.click()
        while (Date.now() < deadline) {
          control = all('[role="menuitemcheckbox"],[role="menuitemradio"],[role="menuitem"],button').find(isThinking)
          if (control) break
          await pause()
        }
        state = chip ? true : selectionState(control)
        if (state === null && control?.getAttribute('role') === 'menuitem') state = false
      }
    }
    if (state === wanted) { if (opener?.getAttribute('aria-expanded') === 'true') opener.click(); return }
    const target = !wanted && chip ? chip : control
    if (!target || state === null || !enabled(target)) throw fail('THINKING_UNAVAILABLE', '未识别到网页“思考”开关的状态，请刷新 ChatGPT 标签页并确认该选项可用')
    if (Date.now() >= deadline) throw fail('THINKING_UNAVAILABLE', '网页“思考”选项加载超时，请检查标签页')
    target.click()
    while (Date.now() < deadline) {
      chip = thinkingChip()
      const current = thinkingControl() || all('[role="menuitemcheckbox"],[role="menuitemradio"]').find(isThinking)
      const selected = chip ? true : selectionState(current)
      if (selected === wanted || (!wanted && !chip && !current && state === true)) {
        if (opener?.getAttribute('aria-expanded') === 'true') opener.click()
        return
      }
      await pause()
    }
    throw fail('THINKING_UNCONFIRMED', '网页“思考”切换尚未确认，消息保留待发送，请查看标签页')
  }
  function checkBaseline(state, expected) {
    if (!expected || expected.userCount !== state.userCount || expected.userMessageId !== state.userMessageId || expected.webConversationId !== state.webConversationId) throw fail('SESSION_CHANGED', '网页会话内容已改变，请核对后重试')
    if (state.challenge || state.login || !state.input || state.busy) throw fail('PAGE_NOT_READY', '请确认 ChatGPT 已登录、验证完成且未在生成')
  }
  async function act(message) {
    if (location.origin !== 'https://chatgpt.com') throw Error('标签页来源已改变')
    if (message.method === 'inspect') return inspect(message.consumeUpdates !== false)
    if (message.method === 'download') {
      if (!isArtifactPath(message.path) || !Number.isFinite(message.expiresAt) || Date.now() >= message.expiresAt) throw fail('FILE_REQUEST_INVALID', '下载请求已过期或文件标识无效')
      const state = inspect()
      if (!message.webConversationId || state.webConversationId !== message.webConversationId) throw fail('SESSION_CHANGED', '原网页会话已切换，请打开生成这个文件的 ChatGPT 会话')
      if (state.login || state.challenge) throw fail('PAGE_NOT_READY', '请先在普通 Edge 完成 ChatGPT 登录或验证')
      const messages = all('[data-message-author-role="assistant"]')
      const response = message.messageId ? messages.find(el => el.getAttribute('data-message-id') === message.messageId) : messages.at(-1)
      if (!message.messageId && (!message.expectedPrompt || normalize(state.lastUser) !== normalize(message.expectedPrompt))) throw fail('FILE_NOT_FOUND', '请在生成这个文件的原网页回复中下载')
      const anchor = response && all('a[href]', response).find(el => el.getAttribute('href') === message.path)
      if (!anchor) throw fail('FILE_NOT_FOUND', '原回复中的文件链接已变化或未加载，请在普通 Edge 查看该回复')
      anchor.click()
      return { requested: true, message: '已在普通 Edge 发起下载，请查看浏览器下载列表；若网页提示文件过期，请重新生成' }
    }
    if (message.method === 'stop') {
      const stop = stopButton()
      if (enabled(stop)) { stop.click(); return true }
      return false
    }
    if (message.method !== 'send' || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 16000 || (message.thinking !== undefined && typeof message.thinking !== 'boolean') || !Number.isFinite(message.expiresAt)) throw Error('消息格式错误')
    if (Date.now() >= message.expiresAt) throw fail('SEND_EXPIRED', '发送操作已过期')
    checkBaseline(inspect(), message.baseline)
    let input = find(promptSelector)
    if ((input.value ?? text(input)).trim()) throw fail('PAGE_DRAFT', '网页输入框有未发送草稿，请先保存或自行清空')
    await setThinking(message.thinking, Math.min(message.expiresAt - 1000, Date.now() + 4000))
    checkBaseline(inspect(), message.baseline)
    input = find(promptSelector)
    if ((input.value ?? text(input)).trim()) throw fail('PAGE_DRAFT', '网页输入框有未发送草稿，请先保存或自行清空')
    input.focus()
    if (input instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, message.text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      const selection = getSelection(), range = document.createRange()
      range.selectNodeContents(input); selection.removeAllRanges(); selection.addRange(range)
      if (!document.execCommand('insertText', false, message.text)) throw fail('INPUT_REJECTED', '网页输入框未接受文本')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const sendDeadline = Math.min(message.expiresAt - 1000, Date.now() + 5000)
    let clicked = false
    while (Date.now() < sendDeadline) {
      checkBaseline(inspect(), message.baseline)
      input = find(promptSelector)
      if (normalize(input.value ?? text(input)) !== normalize(message.text)) throw fail('PAGE_DRAFT_CHANGED', '网页输入内容与任务不一致，已停止发送')
      const send = sendButton()
      if (enabled(send)) { send.click(); clicked = true; break }
      await pause()
    }
    if (!clicked) throw fail('SEND_BUTTON_MISSING', '未找到可用的发送按钮，消息保留在网页输入框；请刷新扩展和 ChatGPT 标签页')
    const confirmationDeadline = Math.min(message.expiresAt - 300, Date.now() + 6000)
    while (Date.now() < confirmationDeadline) {
      const state = inspect()
      const newUser = state.userMessageId ? state.userMessageId !== message.baseline.userMessageId : state.userCount > message.baseline.userCount
      if (newUser) {
        if (normalize(state.lastUser) !== normalize(message.text)) throw fail('SESSION_CHANGED', '网页出现了其他消息，请核对会话')
        return { sent: true, userMessageId: state.userMessageId, userCount: state.userCount, webConversationId: state.webConversationId }
      }
      await pause()
    }
    throw fail('DELIVERY_UNCERTAIN', '点击发送后未检测到新消息，请核对网页；此消息不会自动重发')
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'openstarry-page') return false
    void act(message).then(result => respond({ contentVersion: version, result }), error => respond({ contentVersion: version, error: { code: error.code || 'PAGE_ERROR', message: error.message } }))
    return true
  })
})()
