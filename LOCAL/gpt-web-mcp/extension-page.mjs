import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { artifactList } from './artifacts.mjs'

const fail = (code, message) => Object.assign(Error(message), { code })
const identifier = /^[a-zA-Z0-9_-]{1,220}$/
const equal = (a, b) => {
  const left = Buffer.from(a || ''), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
const snapshot = z.object({
  contentVersion: z.literal(3), artifacts: artifactList.default([]),
  input: z.boolean(), login: z.boolean(), challenge: z.boolean(), busy: z.boolean(),
  text: z.string().max(1024 * 1024), assistantCount: z.number().int().nonnegative(),
  textUpdates: z.array(z.object({ messageId: z.string().max(220), text: z.string().max(1024 * 1024), offset: z.number().int().nonnegative(), replace: z.boolean(), observedAt: z.number().finite() }).strict()).max(256).optional(),
  userCount: z.number().int().nonnegative(), assistantMessageId: z.string().max(220),
  userMessageId: z.string().max(220), lastUser: z.string().max(100000),
  finished: z.boolean(), alert: z.string().max(2000),
  webConversationId: z.string().regex(identifier).nullable()
})

// This transport only carries fixed page operations. Chat data still enters/leaves
// the application through WebAdapter's MCP events and the existing authenticated SSE.
export class EdgeExtensionPage {
  constructor({ profile, commandTimeout = 15000, clock = Date.now }) {
    Object.assign(this, { profile, commandTimeout, clock })
    this.commands = new Map()
    this.lastPoll = 0
    this.baselines = new Map()
  }
  get state() {
    const connected = Boolean(this.clientId && this.clock() - this.lastPoll < 12000)
    const login = connected ? this.login || 'unknown' : 'unknown'
    return {
      browser: connected ? 'open' : 'closed', login, extensionConnected: connected,
      message: !connected ? '在普通 Edge 的 OpenStarry Bridge 扩展中粘贴配对码并连接' :
        login === 'ready' ? 'Edge 扩展已连接，沿用当前浏览器的 ChatGPT 登录与网页模型设置' :
          login === 'challenge' ? 'ChatGPT 页面正在验证，请在普通 Edge 查看；验证期间不会发送' :
            login === 'required' ? '请在扩展打开的普通 Edge 标签页登录 ChatGPT' :
              '扩展已连接，请在它打开的 ChatGPT 标签页完成加载后刷新状态'
    }
  }
  async start() {
    if (this.http) return
    if (this.starting) return this.starting
    this.starting = this.startNow().finally(() => { this.starting = null })
    return this.starting
  }
  async startNow() {
    await mkdir(this.profile, { recursive: true })
    const file = join(this.profile, 'edge-extension.json')
    let saved
    try { saved = JSON.parse(await readFile(file, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (saved && (saved.version !== 1 || !/^[\w-]{43}$/.test(saved.token) || !Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535)) throw Error('Edge 扩展配对配置格式错误')
    this.token = saved?.token || randomBytes(32).toString('base64url')
    const http = createServer((req, res) => {
      void this.handle(req, res).catch(error => {
        if (!res.headersSent) this.reply(res, error.httpStatus || 400, { error: error.httpStatus ? error.message : 'Invalid extension request' })
        else res.end()
      })
    })
    http.requestTimeout = 10000
    http.headersTimeout = 10000
    http.maxConnections = 8
    await new Promise((resolve, reject) => { http.once('error', reject); http.listen(saved?.port || 0, '127.0.0.1', resolve) })
    this.origin = 'http://127.0.0.1:' + http.address().port
    this.http = http
    try {
      await writeFile(file + '.tmp', JSON.stringify({ version: 1, port: http.address().port, token: this.token }), { mode: 0o600 })
      await rename(file + '.tmp', file)
    } catch (error) { await this.close(); throw error }
  }
  reply(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(JSON.stringify(value))
  }
  async handle(req, res) {
    if (req.headers.host !== new URL(this.origin).host) return this.reply(res, 403, { error: 'Invalid Host' })
    const origin = req.headers.origin
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return this.reply(res, 403, { error: 'Extension origin required' })
    if (origin) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'Origin')
    }
    if (req.method === 'OPTIONS' && origin && ['/poll', '/result'].includes(req.url)) {
      res.setHeader('access-control-allow-methods', 'POST')
      res.setHeader('access-control-allow-headers', 'authorization, content-type')
      res.writeHead(204); res.end(); return
    }
    if (!equal(req.headers.authorization, 'Bearer ' + this.token)) return this.reply(res, 401, { error: 'Pairing authentication required' })
    if (req.method !== 'POST' || !['/poll', '/result'].includes(req.url)) return this.reply(res, 404, { error: 'Unknown extension operation' })
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return this.reply(res, 415, { error: 'JSON required' })
    const chunks = []; let bytes = 0
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > 6 * 1024 * 1024) return this.reply(res, 413, { error: 'Extension result too large' })
      chunks.push(chunk)
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || !/^[\w-]{20,100}$/.test(value.clientId)) return this.reply(res, 400, { error: 'Invalid client' })
    const now = this.clock()
    if (req.url === '/poll') {
      if (this.clientId && this.clientId !== value.clientId && (now - this.lastPoll < 30000 || this.commands.size)) return this.reply(res, 409, { error: 'Another Edge instance is connected' })
      if (!['ready', 'required', 'challenge', 'unknown'].includes(value.login)) return this.reply(res, 400, { error: 'Invalid login state' })
      this.clientId = value.clientId; this.lastPoll = now; this.login = value.login
      const command = [...this.commands.values()].find(item => item.expiresAt > now)
      if (command) {
        command.clientId = value.clientId
        if (!command.dispatched) {
          command.dispatched = true; command.expiresAt = now + command.timeout
          clearTimeout(command.timer); command.timer = setTimeout(command.expire, command.timeout)
        }
      }
      return this.reply(res, 200, { command: command ? { id: command.id, method: command.method, args: command.args, expiresAt: command.expiresAt } : null })
    }
    const command = this.commands.get(value.id)
    if (!command || command.clientId !== value.clientId || value.clientId !== this.clientId) return this.reply(res, 409, { error: 'Command expired or belongs to another instance' })
    this.lastPoll = now
    this.commands.delete(value.id); clearTimeout(command.timer)
    if (value.error) command.reject(fail(/^[A-Z_]{1,80}$/.test(value.error.code) ? value.error.code : 'EXTENSION_ERROR', String(value.error.message || 'Edge 扩展操作失败').slice(0, 2000)))
    else command.resolve(value.result)
    this.reply(res, 200, { accepted: true })
  }
  request(method, args) {
    if (!this.state.extensionConnected) return Promise.reject(fail('EXTENSION_OFFLINE', '请先连接普通 Edge 中的 OpenStarry Bridge 扩展'))
    if (this.commands.size >= 8) return Promise.reject(fail('EXTENSION_BUSY', '浏览器操作尚未完成，请稍后重试'))
    return new Promise((resolve, reject) => {
      const timeout = method === 'page' && this.commandTimeout === 15000 ? 45000 : method === 'send' && this.commandTimeout === 15000 ? 25000 : this.commandTimeout
      // Page operations remain serial in Edge; queue time must not consume the execution budget.
      const id = randomUUID(), queueTimeout = this.commandTimeout === 15000 ? 180000 : this.commandTimeout, expiresAt = this.clock() + queueTimeout
      const expire = () => {
        this.commands.delete(id)
        reject(fail(method === 'send' ? 'DELIVERY_UNCERTAIN' : 'EXTENSION_TIMEOUT', method === 'send' ? '网页发送确认超时，请核对网页；此消息不会自动重发' : 'Edge 扩展响应超时，请确认浏览器和扩展仍在运行'))
      }
      const timer = setTimeout(expire, queueTimeout)
      this.commands.set(id, { id, method, args, expiresAt, timeout, expire, resolve, reject, timer })
    })
  }
  async show() {
    await this.start()
    const pairingCode = 'osb1.' + Buffer.from(JSON.stringify({ version: 1, origin: this.origin, token: this.token })).toString('base64url')
    return { ...await this.status(), pairingCode }
  }
  async page(key, webConversationId) {
    if (!identifier.test(key) || webConversationId && !identifier.test(webConversationId)) throw Error('Invalid webpage session')
    await this.start()
    await this.request('page', { key, webConversationId: webConversationId || null })
    return key
  }
  async inspect(key) {
    const state = await this.request('inspect', { key })
    if (state?.contentVersion !== 3) throw fail('EXTENSION_RELOAD_REQUIRED', '请在 Edge 扩展页重新加载 OpenStarry Bridge，并刷新 ChatGPT 标签页')
    return snapshot.parse(state)
  }
  async ready(key) {
    const state = await this.inspect(key)
    if (state.challenge) throw fail('VERIFICATION_REQUIRED', '请在普通 Edge 中完成页面验证')
    if (state.login) throw fail('LOGIN_REQUIRED', '请在普通 Edge 中登录 ChatGPT')
    if (!state.input) throw fail('PAGE_CHANGED', '未找到网页输入框，请检查该标签页')
    if (state.busy) throw fail('PAGE_BUSY', '网页会话仍在生成，请先等待或停止')
    this.baselines.set(key, { userCount: state.userCount, userMessageId: state.userMessageId, webConversationId: state.webConversationId })
    return state
  }
  async send(key, text, { thinking } = {}) {
    if (!this.baselines.has(key)) throw Error('Missing page baseline')
    const result = await this.request('send', { key, text, ...(thinking === undefined ? {} : { thinking }), baseline: this.baselines.get(key) })
    if (result?.sent !== true) throw fail('DELIVERY_UNCERTAIN', '网页未确认消息送达，请核对标签页；此消息不会自动重发')
    return z.object({ sent: z.literal(true), userMessageId: snapshot.shape.userMessageId.optional(), userCount: snapshot.shape.userCount.optional(), webConversationId: snapshot.shape.webConversationId.optional() }).parse(result)
  }
  async download(value) {
    const result = await this.request('download', value)
    if (result?.requested !== true) throw fail('DOWNLOAD_UNCONFIRMED', '网页下载请求尚未确认，请查看普通 Edge')
    return result
  }
  async stop(key) { return (await this.request('stop', { key })) === true }
  async status() { return { ...this.state, model: '网页当前模型', reasoning: '输入框深度思考开关', reasoningSelectable: true } }
  async close() {
    for (const item of this.commands.values()) { clearTimeout(item.timer); item.reject(fail('EXTENSION_CLOSED', '应用网页服务已关闭')) }
    this.commands.clear(); this.baselines.clear(); this.clientId = null
    const http = this.http; this.http = null
    if (http) { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)) }
  }
}
