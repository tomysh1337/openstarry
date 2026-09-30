import { chromium } from 'playwright-core'

const selectors = { prompt: '#prompt-textarea', send: '[data-testid="send-button"]', assistant: '[data-message-author-role="assistant"]', user: '[data-message-author-role="user"]', stop: '[data-testid="stop-button"]' }
const failure = (code, message) => Object.assign(Error(message), { code })

// Only rendered webpage state is observed; no private ChatGPT endpoints or cookie import.
export class ChatGPTPage {
  constructor({ profile, channel = 'msedge', url = 'https://chatgpt.com/', fixture = false }) {
    const origin = new URL(url)
    if (origin.origin !== 'https://chatgpt.com' && !(fixture && origin.hostname === '127.0.0.1' && origin.protocol === 'http:')) throw Error('Invalid webpage origin')
    this.profile = profile; this.channel = channel; this.url = origin.origin; this.pages = new Map(); this.state = { browser: 'closed', login: 'unknown', message: '打开网页并登录 ChatGPT' }
  }
  async start() {
    // Playwright defaults to disabling Chromium's sandbox; keep it enabled in Edge.
    this.starting ??= chromium.launchPersistentContext(this.profile, { channel: this.channel, headless: false, chromiumSandbox: true, acceptDownloads: false, viewport: null }).then(context => {
      this.context = context; this.state.browser = 'open'; context.setDefaultTimeout(10000)
      context.on('close', () => { this.starting = null; this.context = null; this.pages.clear(); this.state = { browser: 'closed', login: 'unknown', message: '网页窗口已关闭，打开网页后继续' } })
      return context
    }).catch(error => { this.starting = null; throw failure('BROWSER_START', '浏览器启动失败，请确认已安装 Microsoft Edge：' + error.message.split('\n')[0]) })
    return this.starting
  }
  async page(key, webConversationId) {
    await this.start()
    if (webConversationId && !/^[a-zA-Z0-9_-]{1,220}$/.test(webConversationId)) throw Error('Invalid web conversation id')
    let page = this.pages.get(key)
    if (!page || page.isClosed()) {
      page = await this.context.newPage(); this.pages.set(key, page)
      await page.goto(this.url + (webConversationId ? '/c/' + webConversationId : '/'), { waitUntil: 'domcontentloaded', timeout: 60000 })
    }
    return page
  }
  async show() { const page = await this.page('login'); await page.bringToFront(); return this.inspect(page) }
  async inspect(page) {
    if (page.isClosed()) throw failure('PAGE_CLOSED', '网页已关闭，请重新打开网页')
    const value = await page.evaluate(s => {
      const visible = el => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
      const answers = [...document.querySelectorAll(s.assistant)].filter(visible), users = [...document.querySelectorAll(s.user)].filter(visible)
      const last = answers.at(-1), turn = last?.closest('article') || last?.parentElement
      const input = document.querySelector(s.prompt), stop = [...document.querySelectorAll(s.stop)].some(visible)
      const alert = [...document.querySelectorAll('[role="alert"]')].filter(visible).map(el => el.innerText).join('\n').slice(0, 2000)
      const buttons = turn ? [...turn.querySelectorAll('button')].filter(visible) : []
      const finishedControl = buttons.some(el => /copy-turn-action|good-response|bad-response/.test(el.getAttribute('data-testid') || '') || /^(Copy|复制|Good response|Bad response|好的回复|不好的回复)$/i.test(el.getAttribute('aria-label') || ''))
      const login = [...document.querySelectorAll('button,a')].some(el => visible(el) && /^(Log in|Sign in|登录)$/i.test(el.innerText.trim()))
      const challenge = [...document.querySelectorAll('iframe')].some(el => visible(el) && /challenges\.cloudflare\.com/.test(el.getAttribute('src') || '')) || /verify you are human|验证您是人类|请完成人机验证/i.test(document.body.innerText.slice(0, 1500))
      const codeBlocks = last ? [...last.querySelectorAll('pre code')].map(el => ({ language: el.className, text: el.innerText })).filter(el => /language-openstarry-proposal/.test(el.language)) : []
      return { input: visible(input), login, challenge, busy: stop, text: last?.innerText || '', assistantCount: answers.length, userCount: users.length,
        assistantMessageId: last?.getAttribute('data-message-id') || '', userMessageId: users.at(-1)?.getAttribute('data-message-id') || '',
        lastUser: users.at(-1)?.innerText || '', finished: Boolean(last && finishedControl && !stop), alert, codeBlocks,
        webConversationId: /^\/c\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(location.pathname)?.[1] || null }
    }, selectors)
    this.state = { browser: 'open', login: value.challenge ? 'challenge' : value.login ? 'required' : value.input ? 'ready' : 'unknown',
      message: value.challenge ? '请在网页完成验证后重试' : value.login ? '请在网页登录 ChatGPT' : value.input ? '网页已就绪，模型与思考选项沿用网页当前设置' : '页面仍在加载，或页面结构发生变化' }
    return value
  }
  async ready(page) {
    await page.locator(selectors.prompt).waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})
    const state = await this.inspect(page)
    if (state.challenge) throw failure('VERIFICATION_REQUIRED', '请在网页完成验证后重试')
    if (state.login) throw failure('LOGIN_REQUIRED', '请先点击“打开网页 / 登录”并完成 ChatGPT 登录')
    if (!state.input) throw failure('PAGE_CHANGED', '未找到网页输入框，请检查登录、网络或页面布局')
    if (state.busy) throw failure('PAGE_BUSY', '这个网页会话仍在生成，请先等待或停止网页中的回复')
    return state
  }
  async send(page, text) {
    await page.locator(selectors.prompt).fill(text)
    await page.locator(selectors.send).click()
  }
  async stop(page) {
    const stop = page.locator(selectors.stop)
    if (await stop.isVisible()) { await stop.click(); return true }
    return false
  }
  async close() { const context = this.context; if (context) await context.close(); this.starting = null }
  async status() {
    const page = [...this.pages.values()].find(page => !page.isClosed())
    if (page) await this.inspect(page).catch(() => {})
    return { ...this.state, model: '网页当前模型', reasoning: '网页当前设置', reasoningSelectable: false }
  }
}
