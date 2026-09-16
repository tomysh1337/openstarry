import { createServer } from 'http'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'

const ALLOWED_ACTIONS = new Set([
  'list_apps', 'list_windows', 'get_window', 'launch_app', 'get_window_state',
  'activate_window', 'click', 'press_key', 'type_text', 'scroll', 'set_value',
  'drag', 'perform_secondary_action'
])
const MAX_REQUEST_BYTES = 1024 * 1024

export class ComputerUseManager extends EventEmitter {
  constructor(settingsStore, bridgeToken) {
    super()
    this.settingsStore = settingsStore
    this.bridgeToken = bridgeToken
    this.server = null
    this.pendingApprovals = new Map()
    this.sky = null
    this.skyPromise = null
  }

  _configureApprovalBridge() {
    globalThis.nodeRepl = globalThis.nodeRepl || {}
    globalThis.nodeRepl.config = {
      ...(globalThis.nodeRepl.config || {}),
      createElicitation: (request) => this._approveApplication(request)
    }
  }

  async _loadSky() {
    if (this.sky) return this.sky
    if (!this.skyPromise) {
      this.skyPromise = (async () => {
        const previousNodeRepl = globalThis.nodeRepl
        Reflect.deleteProperty(globalThis, 'nodeRepl')
        try {
          const module = app.isPackaged
            ? await import(pathToFileURL(join(
                process.resourcesPath,
                'computer-use',
                'node_modules',
                '@oai',
                'sky',
                'dist',
                'project',
                'cua',
                'sky_js',
                'src',
                'index.js'
              )).href)
            : await import('@oai/sky')
          return module.sky
        } finally {
          if (previousNodeRepl) globalThis.nodeRepl = previousNodeRepl
          this._configureApprovalBridge()
        }
      })().finally(() => {
        this.skyPromise = null
      })
    }
    this.sky = await this.skyPromise
    return this.sky
  }

  async _approveApplication(request) {
    const mode = this.settingsStore.get().computerControlMode
    if (mode === 'off') return { action: 'decline' }
    if (mode === 'auto') return { action: 'accept', _meta: { persist: 'always' } }
    return this._requestApproval({ kind: 'application', request })
  }

  _requestApproval(payload) {
    return new Promise((resolve) => {
      const id = randomUUID()
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(id)
        resolve({ action: 'decline' })
      }, 60000)
      this.pendingApprovals.set(id, (accepted) => {
        clearTimeout(timeout)
        resolve({ action: accepted ? 'accept' : 'decline' })
      })
      this.emit('approval', { id, ...payload })
    })
  }

  resolveApproval(id, accepted) {
    const resolver = this.pendingApprovals.get(id)
    if (!resolver) return false
    this.pendingApprovals.delete(id)
    resolver(Boolean(accepted))
    return true
  }

  async perform(action, args = {}, options = {}) {
    if (!ALLOWED_ACTIONS.has(action)) throw new Error(`Unsupported computer action: ${action}`)
    const mode = this.settingsStore.get().computerControlMode
    if (mode === 'off') throw new Error('电脑控制已在设置中关闭')
    if (options.irreversible && this.settingsStore.get().confirmIrreversibleActions) {
      const response = await this._requestApproval({
        kind: 'irreversible',
        request: { message: options.description || '此操作可能产生不可逆影响' }
      })
      if (response.action !== 'accept') throw new Error('用户取消了操作')
    }
    this.emit('active', { active: true, action })
    try {
      const sky = await this._loadSky()
      const method = sky[action]
      if (typeof method !== 'function') throw new Error(`Computer action unavailable: ${action}`)
      return await method(args)
    } finally {
      this.emit('active', { active: false, action })
    }
  }

  startBridge() {
    if (this.server) return
    const server = createServer(async (request, response) => {
      if (request.socket.remoteAddress !== '127.0.0.1' && request.socket.remoteAddress !== '::1') {
        response.writeHead(403).end()
        return
      }
      if (request.headers['x-openstarry-token'] !== this.bridgeToken) {
        response.writeHead(401).end()
        return
      }
      if (request.method !== 'POST' || request.url !== '/action') {
        response.writeHead(404).end()
        return
      }
      try {
        const chunks = []
        let receivedBytes = 0
        for await (const chunk of request) {
          receivedBytes += chunk.length
          if (receivedBytes > MAX_REQUEST_BYTES) {
            response.writeHead(413).end()
            return
          }
          chunks.push(chunk)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const result = await this.perform(body.action, body.args, body.options)
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ success: true, result }))
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ success: false, error: error.message }))
      }
    })
    this.server = server
    server.once('error', (error) => {
      console.error('Computer bridge failed:', error)
      if (this.server === server) this.server = null
    })
    server.listen(5095, '127.0.0.1')
  }

  async stop() {
    for (const resolver of this.pendingApprovals.values()) resolver(false)
    this.pendingApprovals.clear()
    if (this.server) await new Promise((resolve) => this.server.close(resolve))
    this.server = null
    if (typeof this.sky?.close === 'function') await this.sky.close()
    this.sky = null
  }
}
