import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export class WebAdapter {
  constructor({ origin, adminToken, stateDir, pageDriver, source = 'chatgpt-web', pollMs = 20, timeoutMs = 600000, sendConfirmMs = 15000, finishConfirmMs = 60000 }) {
    Object.assign(this, { origin, adminToken, stateDir, pageDriver, source, pollMs, timeoutMs, sendConfirmMs, finishConfirmMs })
    this.file = join(stateDir, 'web-adapter-private.json'); this.controller = new AbortController(); this.stopping = false
    this.activeJobs = new Map(); this.saveChain = Promise.resolve(); this.scheduling = false
  }
  get busy() { return this.scheduling || this.activeJobs.size > 0 }
  get current() { return [...this.activeJobs.values()].find(job => job.task.kind !== 'subagent')?.task.id || this.activeJobs.keys().next().value || null }
  save() {
    const encoded = JSON.stringify(this.data)
    const next = this.saveChain.catch(() => {}).then(async () => {
      const temporary = this.file + '.tmp'
      await writeFile(temporary, encoded, { mode: 0o600 }); await rename(temporary, this.file)
    })
    this.saveChain = next; return next
  }
  async start() {
    try { this.data = JSON.parse(await readFile(this.file, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const response = await fetch(this.origin + '/admin/chat/adapters', { method: 'POST', headers: { authorization: 'Bearer ' + this.adminToken, 'content-type': 'application/json' }, body: JSON.stringify({ adapterId: 'desktop-web', source: this.source }) })
      if (!response.ok) throw Error('网页适配器注册失败')
      const registration = await response.json()
      this.data = { version: 1, capabilityPath: new URL(registration.mcpUrl).pathname, jobs: {} }; await this.save()
    }
    if (this.data.version !== 1 || !/^\/adapter-mcp\/[\w-]{43}$/.test(this.data.capabilityPath)) throw Error('网页适配器配置格式错误')
    this.client = new Client({ name: 'OpenStarry-visible-web-adapter', version: '0.3.0' })
    await this.client.connect(new StreamableHTTPClientTransport(new URL(this.data.capabilityPath, this.origin)))
  }
  async call(name, args = {}) {
    const response = await this.client.callTool({ name, arguments: args })
    if (response.isError) {
      const message = response.content[0].text, code = /^([A-Z_]+):/.exec(message)?.[1]
      throw Object.assign(Error(message), { code, rejected: Boolean(code && code !== 'LOCAL_ERROR') })
    }
    return JSON.parse(response.content[0].text)
  }
  async emit(job, type, payload = {}) {
    if (!job.pending && Buffer.byteLength(JSON.stringify(payload)) > 64 * 1024) throw Object.assign(Error('网页内容修订超过单次事件上限，已保留此前内容；请在网页查看完整回复'), { code: 'EVENT_LIMIT' })
    job.pending ??= { taskId: job.taskId, claimToken: job.claimToken, clientSeq: job.nextSeq, eventId: randomUUID(), type, payload }
    await this.save()
    let ack
    try { ack = await this.call('append_chat_event', job.pending) }
    catch (error) {
      // A definite validation rejection did not commit. Transport failures remain replayable.
      if (error.rejected) { job.pending = null; await this.save() }
      throw error
    }
    job.nextSeq = ack.clientSeq + 1; job.pending = null; await this.save()
  }
  async text(job, text) {
    if (Buffer.byteLength(text) > 1024 * 1024) throw Object.assign(Error('网页回复超过 1 MiB，已保留此前内容；请在网页查看完整回复'), { code: 'TEXT_LIMIT' })
    if (!text.startsWith(job.text)) { await this.emit(job, 'text_snapshot', { text }); job.text = text; await this.save(); return }
    const remaining = Array.from(text.slice(job.text.length))
    // 8k code points also fit when JSON escapes every character; never split a surrogate pair.
    for (let index = 0; index < remaining.length; index += 8000) {
      const chunk = remaining.slice(index, index + 8000).join('')
      await this.emit(job, 'text_delta', { text: chunk }); job.text += chunk; await this.save()
    }
  }
  async confirmTurn(job, task, state) {
    const changed = () => Object.assign(Error('网页会话或最新消息已改变，请核对会话后继续'), { code: 'SESSION_CHANGED' })
    const expectedConversation = job.webConversationId || task.webConversationId || job.baseline.webConversationId
    if (expectedConversation && state.webConversationId !== expectedConversation) throw changed()
    const confirmed = job.confirmedUser
    if (confirmed?.messageId) {
      // Content was checked at send time. The same message may later be collapsed
      // or gain page controls; rendered text is not a reliable ongoing identity.
      if (state.userMessageId !== confirmed.messageId || (confirmed.count !== undefined && state.userCount > confirmed.count)) throw changed()
    } else {
      const newUser = state.userMessageId ? state.userMessageId !== job.baseline.userMessageId : state.userCount > job.baseline.userCount
      if (!newUser) {
        if (confirmed) throw changed()
        return false
      }
      // Legacy journals/drivers must still prove exact content and one new turn.
      if (state.userCount !== (confirmed?.count ?? job.baseline.userCount + 1) || state.lastUser.replace(/\s+/g, ' ').trim() !== task.prompt.replace(/\s+/g, ' ').trim()) throw changed()
      if (!confirmed || state.userMessageId) {
        job.confirmedUser = { messageId: state.userMessageId || '', count: state.userCount }
        await this.save()
      }
    }
    if (!job.webConversationId && state.webConversationId) { job.webConversationId = state.webConversationId; await this.save() }
    return true
  }
  async run(task) {
    let job = this.data.jobs[task.id]
    if (!job) {
      job = this.data.jobs[task.id] = { taskId: task.id, claimRequestId: randomUUID(), nextSeq: 1, text: '', baseline: null }
      await this.save()
    }
    if (!job.claimToken) {
      const claim = await this.call('claim_chat_task', { taskId: task.id, claimRequestId: job.claimRequestId })
      job.claimToken = claim.claimToken; task = claim.task; await this.save()
    } else task = (await this.call('heartbeat_chat_task', { taskId: task.id, claimToken: job.claimToken })).task
    if (job.pending) { await this.emit(job); task = (await this.call('heartbeat_chat_task', { taskId: task.id, claimToken: job.claimToken })).task }
    if (['completed', 'cancelled', 'error'].includes(task.status)) return
    job.text = task.text; job.artifacts = task.artifacts || []; job.nextSeq = task.clientSeq + 1; await this.save()
    let page
    let stopped = false, started = false, stable = 0, stopStable = 0, lastText = job.text, heartbeatAt = 0, idleSince = 0
    const deadline = Date.now() + this.timeoutMs
    try {
      if (task.delivery !== 'not_sent' && !job.webConversationId && !task.webConversationId) throw Object.assign(Error('发送结果尚未核对；请在网页查找该消息，避免重复发送'), { code: 'DELIVERY_UNCERTAIN' })
      page = await this.pageDriver.page(task.clientId + '-' + task.sessionId, job.webConversationId || task.webConversationId)
      if (task.delivery === 'not_sent') {
        job.baseline = await this.pageDriver.ready(page)
        if (task.webConversationId && job.baseline.webConversationId !== task.webConversationId) throw Object.assign(Error('网页会话已切换，请恢复原会话后继续'), { code: 'SESSION_CHANGED' })
        const check = await this.call('heartbeat_chat_task', { taskId: task.id, claimToken: job.claimToken })
        if (check.task.status === 'cancelled') return
        // The journal is saved before the server intent, which itself precedes the UI click.
        await this.save(); await this.emit(job, 'dispatching')
        const receipt = await this.pageDriver.send(page, task.prompt, { thinking: task.thinking })
        if (receipt?.sent && receipt.userMessageId) {
          const expectedConversation = task.webConversationId || job.baseline.webConversationId
          if (receipt.userMessageId === job.baseline.userMessageId || (receipt.userCount !== undefined && receipt.userCount !== job.baseline.userCount + 1) || (expectedConversation && receipt.webConversationId && receipt.webConversationId !== expectedConversation)) throw Object.assign(Error('网页发送确认与原会话不符，请核对标签页'), { code: 'SESSION_CHANGED' })
          job.confirmedUser = { messageId: receipt.userMessageId, ...(receipt.userCount === undefined ? {} : { count: receipt.userCount }) }
          job.webConversationId = receipt.webConversationId || expectedConversation || null
          await this.save()
        }
      } else if (!job.baseline) throw Object.assign(Error('发送记录缺少网页基线，请核对原会话后新建对话'), { code: 'DELIVERY_UNCERTAIN' })
      const sendDeadline = Date.now() + this.sendConfirmMs
      while (!this.stopping && Date.now() < deadline) {
        if (Date.now() - heartbeatAt > 1000) {
          const heartbeat = await this.call('heartbeat_chat_task', { taskId: task.id, claimToken: job.claimToken }); task = heartbeat.task; heartbeatAt = Date.now()
          if (task.status === 'cancelled') return
          if (heartbeat.cancelRequested && !stopped) stopped = Boolean(await this.pageDriver.stop(page))
        }
        const state = await this.pageDriver.inspect(page)
        if (state.challenge || state.login) throw Object.assign(Error(state.challenge ? '请在网页完成验证' : '网页登录已过期，请重新登录'), { code: state.challenge ? 'VERIFICATION_REQUIRED' : 'LOGIN_REQUIRED' })
        if (state.alert && /limit|try again|error|额度|上限|出错|重试/i.test(state.alert)) throw Object.assign(Error(state.alert), { code: 'WEB_ERROR' })
        const newUser = await this.confirmTurn(job, task, state)
        const newAnswer = state.assistantMessageId ? state.assistantMessageId !== job.baseline.assistantMessageId : state.assistantCount > job.baseline.assistantCount
        const hasAnswer = newAnswer && newUser
        if (newUser && state.webConversationId) {
          if (!started) {
            job.webConversationId = state.webConversationId; await this.save()
            const fresh = (await this.call('heartbeat_chat_task', { taskId: task.id, claimToken: job.claimToken })).task
            if (fresh.delivery === 'dispatching') await this.emit(job, 'started', { webConversationId: state.webConversationId })
            else if (fresh.status === 'interrupted') await this.emit(job, 'resumed', { webConversationId: state.webConversationId })
            started = true
          }
        }
        if (!started && Date.now() >= sendDeadline) throw Object.assign(Error('网页发送或会话确认超时，请核对标签页；此消息不会自动重发'), { code: 'DELIVERY_UNCERTAIN' })
        if (hasAnswer && started) {
          for (const update of state.textUpdates || []) {
            if (update.messageId !== (state.assistantMessageId || '')) continue
            if (!update.replace && update.offset !== job.text.length) continue
            const observed = update.replace ? update.text : job.text + update.text
            if (state.text.startsWith(observed) && observed !== job.text) await this.text(job, observed)
          }
          if (state.busy || state.finished || state.text !== job.text) idleSince = 0
          else idleSince ||= Date.now()
          if (idleSince && Date.now() - idleSince >= this.finishConfirmMs) throw Object.assign(Error('已接收正文，但网页未出现可识别的完成标记；请刷新扩展与 ChatGPT 标签页后检查'), { code: 'COMPLETION_UNCONFIRMED' })
          if (state.text !== job.text) await this.text(job, state.text)
          if (state.artifacts && JSON.stringify(state.artifacts) !== JSON.stringify(job.artifacts)) {
            await this.emit(job, 'file_links', { artifacts: state.artifacts }); job.artifacts = state.artifacts; await this.save()
          }
          stable = state.text === lastText && state.finished ? stable + 1 : 0; lastText = state.text
          if (state.finished && stable >= 2) {
            await this.emit(job, stopped ? 'cancelled' : 'completed'); return
          }
        }
        stopStable = stopped && newUser && !state.busy ? stopStable + 1 : 0
        if (stopStable >= 2) { await this.emit(job, 'cancelled'); return }
        await delay(this.pollMs, undefined, { signal: this.controller.signal })
      }
      if (!this.stopping) throw Object.assign(Error('网页回复超时；已接收内容已保留，请检查网页后继续'), { code: 'WEB_TIMEOUT' })
    } catch (error) {
      if (this.stopping) return
      // Unacknowledged events stay in the private journal for identical replay.
      if (job.pending) throw error
      await this.emit(job, 'error', { code: error.code && /^[\w-]{1,128}$/.test(error.code) ? error.code : 'WEB_ADAPTER_ERROR', message: String(error.message).slice(0, 2000) })
      throw error
    }
  }
  async tick() {
    if (this.scheduling || this.stopping) return
    this.scheduling = true
    const started = []
    try {
      const { tasks } = await this.call('list_chat_tasks')
      if (this.stopping) return
      const running = [...this.activeJobs.values()].map(job => job.task)
      let ordinary = running.filter(t => t.kind !== 'subagent').length, children = running.length - ordinary
      const sessions = new Set(running.map(t => t.clientId + '/' + t.sessionId))
      for (const task of tasks) {
        if (['completed', 'cancelled', 'error'].includes(task.status) || this.activeJobs.has(task.id)) continue
        const key = task.clientId + '/' + task.sessionId, child = task.kind === 'subagent'
        if (sessions.has(key) || (child ? children >= 2 : ordinary >= 1)) continue
        sessions.add(key); if (child) children++; else ordinary++
        const promise = this.run(task).catch(error => {
          this.lastError = String(error.message).replace(/\/adapter-mcp\/[\w-]+/g, '/adapter-mcp/[private]').slice(0, 2000)
        }).finally(() => this.activeJobs.delete(task.id))
        this.activeJobs.set(task.id, { task, promise }); started.push(promise)
      }
    } catch (error) { this.lastError = String(error.message).replace(/\/adapter-mcp\/[\w-]+/g, '/adapter-mcp/[private]').slice(0, 2000) }
    finally { this.scheduling = false }
    await Promise.all(started)
  }
  poll() { this.interval = setInterval(() => { void this.tick() }, 750); this.interval.unref(); void this.tick() }
  async close() {
    this.stopping = true; clearInterval(this.interval); this.controller.abort()
    await this.pageDriver.close()
    while (this.busy) await delay(20)
    await this.client?.close()
  }
}
