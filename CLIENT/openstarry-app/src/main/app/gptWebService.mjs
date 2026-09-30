import fs from 'node:fs/promises'
import path from 'node:path'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const id = value => { if (typeof value !== 'string' || !/^[\w-]{1,128}$/.test(value)) throw Error('会话标识格式错误'); return value }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const terminal = status => ['completed', 'cancelled', 'error'].includes(status)

export class GptWebService {
  constructor({ baseDir, scriptPath, nodePaths, workspace, cloudflaredPaths = [], createChild = fork, sandboxDir = path.join(process.env.LOCALAPPDATA || baseDir, 'OpenStarry', 'OpenSandbox') }) {
    Object.assign(this, { baseDir, scriptPath, nodePaths, workspace, cloudflaredPaths, createChild, sandboxDir }); this.watchers = new Map(); this.pendingWatchers = new Map(); this.rpcs = new Map(); this.chain = Promise.resolve()
  }
  async nodePath() {
    for (const value of this.nodePaths.filter(Boolean)) if (await fs.stat(value).then(s => s.isFile(), () => false)) return value
    throw Error('未找到网页服务运行时，请重新安装包含 Node 运行时的 OpenStarry')
  }
  exclusive(operation) {
    const next = this.chain.catch(() => {}).then(operation); this.chain = next; return next
  }
  withProject(project, operation) { return this.exclusive(async () => { await this.ensureNow(project); return operation() }) }
  ensure(project) { return this.withProject(project, () => this.current) }
  async fileAccessSettings() {
    const settings = await fs.readFile(path.join(this.baseDir, 'file-access.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error })
    const fileScope = settings.fileScope || 'workspace'
    const newFilePolicy = settings.newFilePolicy || 'review'
    if (!['workspace', 'all-disks'].includes(fileScope)) throw Error('MCP 文件范围配置格式错误')
    if (!['review', 'direct'].includes(newFilePolicy)) throw Error('MCP 新建文件配置格式错误')
    const safetyMode = settings.safetyMode || (newFilePolicy === 'direct' ? 'auto' : 'ask')
    if (!['ask', 'auto', 'full'].includes(safetyMode)) throw Error('安全等级配置格式错误')
    return { fileScope, newFilePolicy: safetyMode === 'ask' ? 'review' : 'direct', safetyMode }
  }
  async protectedFilePaths() {
    const projects = await fs.readdir(path.join(this.baseDir, 'projects')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    return [this.sandboxDir, path.join(this.baseDir, 'file-access.json'), path.join(this.baseDir, 'browser-profile'),
      ...projects.map(project => path.join(this.baseDir, 'projects', project, 'control'))]
  }
  async ensureNow(project) {
    if (!project || typeof project !== 'object') throw Error('请等待对话工作区加载完成')
    const projectId = id(project.id)
    if (this.current?.projectId === projectId) {
      if (project.nativeRoot && await this.workspace.root(project.nativeRoot) !== this.current.workspace) throw Error('项目目录已经改变，请重新打开项目')
      return this.current
    }
    if (this.watchers.size) throw Error('请先等待或停止另一个项目中的网页任务')
    if (this.current) {
      if ((await this.admin('chat/tasks')).tasks.some(task => !terminal(task.status))) throw Error('另一个项目还有未完成的网页回复，请先恢复或停止该任务')
      await this.stopNow(false)
    }
    const projectDir = path.join(this.baseDir, 'projects', projectId), stateDir = path.join(projectDir, 'control')
    const workspace = project.nativeRoot ? await this.workspace.root(project.nativeRoot) : path.join(projectDir, 'workspace')
    await fs.mkdir(stateDir, { recursive: true }); await fs.mkdir(workspace, { recursive: true })
    const { fileScope, newFilePolicy } = await this.fileAccessSettings(), protectedPaths = await this.protectedFilePaths()
    const child = this.createChild(this.scriptPath, [], { execPath: await this.nodePath(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
    this.child = child
    const readiness = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('网页服务启动超时，请查看连接诊断')), 20000)
      child.on('message', message => {
        if (message.type === 'ready') { clearTimeout(timer); this.current = { ...message, projectId, projectName: String(project.name || projectId).slice(0, 160), workspace, stateDir, fileScope, newFilePolicy }; resolve(this.current) }
        else if (message.type === 'fatal') { clearTimeout(timer); reject(Error(message.error)) }
        else if (message.type === 'response') {
          const rpc = this.rpcs.get(message.id); if (!rpc) return
          this.rpcs.delete(message.id); clearTimeout(rpc.timer); message.error ? rpc.reject(Error(message.error)) : rpc.resolve(message.result)
        }
      })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', () => {
        clearTimeout(timer); reject(Error('网页服务已退出'))
        if (this.child === child) { this.child = null; this.current = null }
        for (const rpc of this.rpcs.values()) { clearTimeout(rpc.timer); rpc.reject(Error('网页服务已退出')) }; this.rpcs.clear()
      })
    })
    this.lastLog = ''
    // Keep logs private and bounded; capability URLs are never passed to the renderer.
    const log = chunk => { this.lastLog = (this.lastLog || '') + chunk.toString().replace(/\/(?:adapter-)?mcp\/[\w-]+/g, '/mcp/[private]'); this.lastLog = this.lastLog.slice(-4000) }
    child.stdout.on('data', log); child.stderr.on('data', log)
    let cloudflared
    for (const file of this.cloudflaredPaths.filter(Boolean)) if (await fs.stat(file).then(s => s.isFile(), () => false)) { cloudflared = file; break }
    child.send({ type: 'init', workspace, stateDir, profile: path.join(this.baseDir, 'browser-profile'), cloudflared, fileScope, newFilePolicy, protectedPaths, settingsPath: path.join(this.baseDir, 'file-access.json'), sandboxConfigPath: path.join(this.sandboxDir, 'connection.json') })
    try { return await readiness } catch (error) { child.kill(); if (this.child === child) this.child = null; throw error }
  }
  async rpc(type, payload) {
    if (!this.child?.connected) throw Error('网页服务尚未连接')
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.rpcs.delete(requestId); reject(Error('网页操作超时，请检查浏览器窗口')) }, 75000)
      this.rpcs.set(requestId, { resolve, reject, timer }); this.child.send({ type, id: requestId, payload })
    })
  }
  async admin(route, body) {
    if (!this.current) throw Error('网页服务未启动')
    const response = await fetch(this.current.origin + '/admin/' + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + this.current.adminToken, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) })
    const value = await response.json(); if (!response.ok) throw Error(value.error); return value
  }
  status(project) { return this.exclusive(async () => {
    if (!this.current || this.current.projectId !== id(project.id)) return { service: 'stopped', browser: 'closed', login: 'unknown', message: '点击连接 Edge，复制配对码到普通 Edge 的 OpenStarry Bridge 扩展', reasoningSelectable: false }
    return { service: 'ready', ...await this.rpc('status'), subagents: (await this.admin('subagents')).subagents, diagnostics: this.lastLog || '' }
  }) }
  show(project, copyPairing) { return this.withProject(project, async () => {
    const { pairingCode, ...state } = await this.rpc('show')
    if (pairingCode) {
      if (!copyPairing) throw Error('请通过应用的连接 Edge 按钮复制配对码')
      await copyPairing(pairingCode)
      state.message = '配对码已复制，请在普通 Edge 的 OpenStarry Bridge 扩展中粘贴并连接'
    }
    return { service: 'ready', ...state }
  }) }
  async syncVirtual(project) {
    if (project.nativeRoot) return
    const files = project.files || {}; if (Object.keys(files).length > 1000) throw Error('项目文件数量超过限制')
    let bytes = 0; const mirrored = []
    for (const [relative, text] of Object.entries(files)) {
      const parts = relative.split('/')
      if (!relative || /[\\:\x00-\x1f]/.test(relative) || parts.some(p => !p || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw Error('网页项目仅接受普通项目相对路径')
      if (parts.some(p => p.startsWith('.') || ['node_modules', 'dist', 'build'].includes(p))) continue
      if (typeof text !== 'string' || text.includes('\0')) throw Error('网页工作区只接受文本文件')
      if (Buffer.byteLength(text) > 128 * 1024) continue
      if ((bytes += Buffer.byteLength(text)) > 12 * 1024 * 1024) throw Error('网页工作区文本总计超过 12 MiB')
      let target = this.current.workspace
      for (let i = 0; i < parts.length; i++) {
        target = path.join(target, parts[i]); const stat = await fs.lstat(target).catch(e => { if (e.code !== 'ENOENT') throw e })
        if (stat?.isSymbolicLink() || stat?.isFile() && stat.nlink > 1) throw Error('网页工作区排除链接文件')
        if (i < parts.length - 1) await fs.mkdir(target, { recursive: true })
      }
      await fs.writeFile(target, text)
      mirrored.push(relative)
    }
    const manifest = path.join(this.current.stateDir, 'mirrored-files.json')
    const previous = await fs.readFile(manifest, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    for (const relative of previous) {
      if (mirrored.includes(relative)) continue
      const target = path.resolve(this.current.workspace, relative)
      if (!target.startsWith(path.resolve(this.current.workspace) + path.sep)) throw Error('镜像清理路径错误')
      let cursor = this.current.workspace
      for (const part of path.relative(this.current.workspace, target).split(path.sep)) {
        cursor = path.join(cursor, part)
        const stat = await fs.lstat(cursor).catch(error => { if (error.code !== 'ENOENT') throw error })
        if (stat?.isSymbolicLink()) throw Error('镜像目录包含链接，请重新核对项目')
      }
      await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
    await fs.writeFile(manifest, JSON.stringify(mirrored), { mode: 0o600 })
  }
  submit(value) { return this.withProject(value.project, async () => {
    id(value.sessionId); id(value.messageId); id(value.requestId)
    if (!['ask', 'agent'].includes(value.mode)) throw Error('网页任务模式错误')
    if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 15000) throw Error('网页消息与引用合计请控制在 15000 字符以内')
    if (value.thinking !== undefined && typeof value.thinking !== 'boolean') throw Error('思考开关格式错误')
    value = { ...value, prompt: value.prompt.trim() }
    const tasks = (await this.admin('chat/tasks')).tasks
    const existing = tasks.find(t => t.requestId === value.requestId)
    if (existing) {
      const task = await this.admin('chat/tasks/' + existing.id)
      const samePrompt = task.prompt === this.prompt(value.prompt, task.fileTaskId) || (task.fileTaskId && task.prompt.startsWith(value.prompt + '\n\n[OpenStarry 项目任务 ' + task.fileTaskId + '] '))
      if (task.thinking !== value.thinking || task.sessionId !== value.sessionId || task.messageId !== value.messageId || Boolean(task.fileTaskId) !== (value.mode === 'agent') || !samePrompt) throw Error('请求标识已用于不同消息')
      return task
    }
    if (tasks.some(t => !terminal(t.status))) throw Error('还有未完成的网页回复，请先恢复或停止该任务')
    if (value.mode === 'agent') await this.syncVirtual(value.project)
    let fileTaskId, prompt = value.prompt
    if (value.mode === 'agent') {
      const fileTask = await this.admin('tasks', { prompt: value.prompt }); fileTaskId = fileTask.id
      prompt = this.prompt(prompt, fileTaskId)
    }
    return this.admin('chat/tasks', { clientId: 'desktop', adapterId: 'desktop-web', sessionId: id(value.sessionId), messageId: id(value.messageId), requestId: id(value.requestId), prompt, ...(value.thinking === undefined ? {} : { thinking: value.thinking }), ...(fileTaskId ? { fileTaskId } : {}) })
  }) }
  download({ project, taskId, path: filePath }) { return this.withProject(project, async () => {
    id(taskId)
    if (typeof filePath !== 'string' || filePath.length > 1200 || !/^sandbox:\/mnt\/data\/[^\u0000-\u001f?#]+$/.test(filePath)) throw Error('网页文件标识错误')
    const task = await this.admin('chat/tasks/' + taskId)
    if (!task.webConversationId) throw Error('这条回复尚未关联原网页会话')
    const artifact = task.artifacts?.find(file => file.path === filePath)
    const legacyLinks = [...task.text.matchAll(/\[[^\]]*\]\((sandbox:\/mnt\/data\/[^)]+)\)/g)].map(match => match[1])
    if (!artifact && !legacyLinks.includes(filePath)) throw Error('这条回复没有记录该下载文件，请到生成文件的原网页回复查看')
    return this.rpc('download', { key: task.clientId + '-' + task.sessionId, webConversationId: task.webConversationId,
      path: filePath, ...(artifact ? { messageId: artifact.messageId } : { expectedPrompt: task.prompt }) })
  }) }
  prompt(text, fileTaskId) {
    return text + (fileTaskId ? '\n\n[OpenStarry 项目任务 ' + fileTaskId + '] 若需要工具，通过已配置的 OpenStarry MCP 连接器读取此任务。先 get_status 核对当前安全等级；新文件可用 create_file，读过版本后用 write_file 按本机策略保存或提议，propose_file 始终等待本机审查。保存以工具返回 accepted/created 为准。独立子任务可用 spawn_subagent；容器命令用 sandbox_run 并收集 sandbox_result。连接器尚未配置时请明确说明。' : '')
  }
  async servicesNow() {
    if (!this.current) return { bridge: { status: 'stopped', busy: false, ...await this.fileAccessSettings() }, tunnel: { status: 'stopped' }, pendingProposals: [] }
    const [browser, tunnel, { tasks }, proposals, subagents, policy, sandbox] = await Promise.all([this.rpc('status'), this.rpc('tunnel-status'), this.admin('chat/tasks'), this.proposalsNow(), this.admin('subagents'), this.admin('policy'), this.admin('sandbox')])
    return { bridge: { status: 'ready', projectId: this.current.projectId, projectName: this.current.projectName, fileScope: this.current.fileScope, ...policy,
      busy: tasks.some(task => !terminal(task.status)) || sandbox.jobs.some(job => !job.done && job.status !== 'awaiting_approval') }, tunnel, subagents, sandbox,
      pendingProposals: proposals.map(p => ({ id: p.id, path: p.path, absolutePath: p.absolutePath, external: Boolean(p.external), createdAt: p.createdAt })),
      browser: { extensionConnected: Boolean(browser.extensionConnected), message: browser.message || '' } }
  }
  // The homepage toolbar manages the running app-owned service, including an IDE project.
  // Merely opening the toolbar never starts a worker or replaces the selected workspace.
  services({ action = 'status', project, projectId, proposalId, parentTaskId, subagentId, executionId, safetyMode, offset = 0 } = {}, copyText) { return this.exclusive(async () => {
    if (!['status', 'safety-set', 'sandbox-health', 'sandbox-read', 'sandbox-approve', 'sandbox-reject', 'sandbox-cancel', 'bridge-start', 'bridge-stop', 'tunnel-start', 'tunnel-stop', 'copy-address', 'pair', 'review-read', 'review-accept', 'review-reject', 'subagent-read', 'subagent-cancel'].includes(action)) throw Error('服务操作格式错误')
    if (['bridge-start', 'tunnel-start', 'pair'].includes(action) && !this.current) await this.ensureNow(project)
    let message = '', proposal, subagent, execution
    if (action === 'safety-set') {
      if (!['ask', 'auto', 'full'].includes(safetyMode)) throw Error('安全等级格式错误')
      const settingsPath = path.join(this.baseDir, 'file-access.json')
      const settings = await fs.readFile(settingsPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error })
      await fs.mkdir(this.baseDir, { recursive: true })
      const temp = settingsPath + '.' + randomUUID() + '.tmp'
      try { await fs.writeFile(temp, JSON.stringify({ ...settings, version: 1, safetyMode, newFilePolicy: safetyMode === 'ask' ? 'review' : 'direct' }), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, settingsPath) }
      finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
      if (this.current) this.current.newFilePolicy = safetyMode === 'ask' ? 'review' : 'direct'
      message = '安全等级已保存，作用于此应用的 MCP 和子 Agent；已有待审查请求保持原样'
    } else if (action.startsWith('sandbox-')) {
      if (!this.current || projectId !== this.current.projectId) throw Error('服务工作区已改变，请刷新后重新查看执行请求')
      if (action === 'sandbox-health') { await this.admin('sandbox/health', {}); message = 'OpenSandbox 服务已连接，容器执行结果以任务返回为准' }
      else {
        const job = (await this.admin('sandbox')).jobs.find(job => job.id === executionId)
        if (!job) throw Error('当前工作区没有这条执行请求')
        if (action !== 'sandbox-read') await this.admin('sandbox/' + id(executionId) + '/' + action.slice(8), {})
        execution = await this.admin('sandbox/' + id(executionId) + '/read', { task_id: job.task_id, offset })
      }
    } else if (action.startsWith('subagent-')) {
      if (!this.current || projectId !== this.current.projectId) throw Error('服务工作区已改变，请刷新后重新查看子 Agent')
      const child = (await this.admin('subagents')).subagents.find(t => t.id === subagentId && t.task_id === parentTaskId)
      if (!child) throw Error('当前工作区没有这条子 Agent 任务')
      if (action === 'subagent-cancel') await this.admin('subagents/' + id(subagentId) + '/cancel', { task_id: parentTaskId })
      subagent = await this.admin('subagents/' + id(subagentId) + '/read', { task_id: parentTaskId, offset })
      if (action === 'subagent-cancel') message = subagent.done ? '子 Agent 已结束，已有结果保留' : '已请求停止子 Agent，等待网页确认'
    } else if (action.startsWith('review-')) {
      if (!this.current || projectId !== this.current.projectId) throw Error('服务工作区已改变，请刷新后重新审查')
      if (action === 'review-read') {
        proposal = (await this.proposalsNow()).find(p => p.id === id(proposalId))
        if (!proposal) throw Error('这条提议已处理，请刷新修改列表')
      } else {
        await this.reviewNow({ proposalId, decision: action === 'review-accept' ? 'accept' : 'reject' })
        message = action === 'review-accept' ? '修改已接受并保存' : '提议已拒绝，文件保持原样'
      }
    } else if (action === 'bridge-stop' && this.current) {
      if ((await this.admin('chat/tasks')).tasks.some(task => !terminal(task.status))) throw Error('仍有未完成的网页回复，请先恢复或停止回复，再关闭 MCP Bridge')
      await this.stopNow()
      message = 'MCP Bridge 和 Cloudflare Tunnel 已关闭'
    } else if (action === 'tunnel-start') {
      await this.rpc('tunnel-start')
    } else if (action === 'tunnel-stop' && this.current) {
      await this.rpc('tunnel-stop')
      message = 'Cloudflare Tunnel 已关闭，本地 MCP Bridge 保持运行'
    } else if (action === 'copy-address') {
      if (!copyText) throw Error('请通过应用复制连接器地址')
      await copyText(await this.connectionAddressNow())
      message = '连接器地址已复制，可粘贴到 ChatGPT 的 MCP 服务器设置中'
    } else if (action === 'pair') {
      if (!copyText) throw Error('请通过应用复制配对码')
      const state = await this.rpc('show')
      if (state.pairingCode) { await copyText(state.pairingCode); message = '配对码已复制，请粘贴到普通 Edge 的 OpenStarry Bridge 扩展中' }
      else message = state.message || 'Edge 扩展已连接'
    }
    return { ...await this.servicesNow(), message, ...(proposal ? { proposal } : {}), ...(subagent ? { subagent } : {}), ...(execution ? { execution } : {}) }
  }) }
  tunnelStatus(project) { return this.exclusive(() => this.current?.projectId === id(project.id) ? this.rpc('tunnel-status') : { status: 'stopped' }) }
  startTunnel(project) { return this.withProject(project, () => this.rpc('tunnel-start')) }
  stopTunnel(project) { return this.exclusive(() => this.current?.projectId === id(project.id) ? this.rpc('tunnel-stop') : { status: 'stopped' }) }
  connectionAddress(project) { return this.withProject(project, () => this.connectionAddressNow()) }
  async connectionAddressNow() {
    if (!this.current) throw Error('请先开启 MCP Bridge 和 Cloudflare Tunnel')
    if ((await this.rpc('tunnel-status')).status !== 'connected') throw Error('公网连接尚未就绪，请先启动并刷新状态')
    const value = JSON.parse(await fs.readFile(path.join(this.current.stateDir, 'public-connection.json'), 'utf8'))
    return value.mcpUrl
  }
  async watch({ project, taskId, watchId }, onEvent) {
    id(taskId); id(watchId)
    if (this.watchers.has(watchId) || this.pendingWatchers.has(watchId)) throw Error('重复订阅标识')
    const controller = new AbortController()
    this.pendingWatchers.set(watchId, controller)
    let cursor = 0, failures = 0
    try {
      const snapshot = await this.withProject(project, async () => {
        if (controller.signal.aborted) throw Error('事件订阅已关闭')
        const task = await this.admin('chat/tasks/' + taskId)
        if (controller.signal.aborted) throw Error('事件订阅已关闭')
        this.pendingWatchers.delete(watchId); this.watchers.set(watchId, controller); return task
      })
      onEvent({ type: 'reset', taskId, seq: snapshot.lastSeq, snapshot }); cursor = snapshot.lastSeq
      if (terminal(snapshot.status)) return snapshot
      while (!controller.signal.aborted) {
        try {
          if (!this.current) throw Error('网页服务已退出，请重新打开连接并恢复回复')
          const response = await fetch(`${this.current.origin}/admin/chat/tasks/${taskId}/events?after=${cursor}`, { headers: { authorization: 'Bearer ' + this.current.adminToken }, signal: controller.signal })
          if (!response.ok) throw Error('事件连接失败：HTTP ' + response.status)
          const decoder = new TextDecoder(); let pending = ''
          for await (const bytes of response.body) {
            pending += decoder.decode(bytes, { stream: true })
            if (pending.length > 2 * 1024 * 1024) throw Error('事件快照超过限制')
            while (pending.includes('\n\n')) {
              const end = pending.indexOf('\n\n'), block = pending.slice(0, end); pending = pending.slice(end + 2)
              const line = block.split('\n').find(value => value.startsWith('data: ')); if (!line) continue
              const event = JSON.parse(line.slice(6))
              if (event.taskId !== taskId || event.seq <= cursor) continue
              onEvent(event); cursor = event.seq; failures = 0
            }
          }
          const current = await this.admin('chat/tasks/' + taskId)
          if (terminal(current.status)) { onEvent({ type: 'reset', taskId, seq: current.lastSeq, snapshot: current }); return current }
        } catch (error) {
          if (controller.signal.aborted) throw Error('事件订阅已关闭，回复保留在本机，可恢复查看')
          if (++failures >= 3) throw error
          onEvent({ type: 'connection', taskId, status: 'reconnecting', message: '连接中断，正在从已接收位置恢复…' })
        }
        await wait(1000)
      }
      throw Error('事件订阅已关闭')
    } finally { this.watchers.delete(watchId); this.pendingWatchers.delete(watchId) }
  }
  unwatch(watchId) { (this.watchers.get(watchId) || this.pendingWatchers.get(watchId))?.abort() }
  cancel({ project, taskId }) { return this.withProject(project, () => this.admin('chat/tasks/' + id(taskId) + '/cancel', {})) }
  proposals(project) { return this.withProject(project, () => this.proposalsNow()) }
  async proposalsNow() {
    const [chat, files, pending] = await Promise.all([this.admin('chat/tasks'), this.admin('tasks'), this.admin('proposals')])
    const related = new Set([...chat.tasks.map(t => t.fileTaskId).filter(Boolean), ...files.tasks.filter(t => t.source === 'connector').map(t => t.id)])
    return pending.proposals.filter(p => related.has(p.taskId) && p.status === 'pending').map(value => {
      const proposal = { ...value, absolutePath: path.resolve(this.current.workspace, value.path).replaceAll('\\', '/') }
      if (!path.isAbsolute(proposal.path)) return proposal
      const relative = path.relative(this.current.workspace, proposal.path)
      if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) return { ...proposal, path: relative.replaceAll('\\', '/') }
      return { ...proposal, path: proposal.path.replaceAll('\\', '/'), external: true }
    })
  }
  review({ project, proposalId, decision }) { return this.withProject(project, () => this.reviewNow({ proposalId, decision })) }
  async reviewNow({ proposalId, decision }) {
    if (!['accept', 'reject'].includes(decision)) throw Error('审查选项错误')
    const proposal = (await this.proposalsNow()).find(p => p.id === proposalId)
    if (!proposal) throw Error('该项目没有这条待审查提议，请刷新修改列表')
    return this.admin('proposals/' + id(proposalId) + '/' + decision, {})
  }
  stop() { return this.exclusive(() => this.stopNow()) }
  async stopNow(abortPending = true) {
    for (const controller of this.watchers.values()) controller.abort()
    if (abortPending) for (const controller of this.pendingWatchers.values()) controller.abort()
    const child = this.child; if (!child) return
    if (child.connected) child.send({ type: 'shutdown' })
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve() }, 10000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      if (child.exitCode !== null) { clearTimeout(timer); resolve() }
    })
    if (this.child === child) { this.child = null; this.current = null }
  }
}
