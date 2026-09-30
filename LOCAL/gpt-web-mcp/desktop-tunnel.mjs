import { readFile, writeFile } from 'node:fs/promises'
import { fork } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const privateError = error => String(error?.message || error).replace(/\/(?:adapter-)?mcp\/[\w-]+/g, '/mcp/[private]').slice(0, 500)

// Owns only the tunnel created by this worker; external test tunnels are untouched.
export class DesktopTunnel {
  constructor({ stateDir, cloudflared, createChild = fork }) {
    Object.assign(this, { stateDir, cloudflared, createChild })
    this.chain = Promise.resolve()
    this.last = { status: 'stopped' }
  }
  exclusive(action) {
    const next = this.chain.catch(() => {}).then(action)
    this.chain = next
    return next
  }
  async status() {
    if (!this.child || this.child.exitCode !== null) return { status: this.error ? 'error' : 'stopped', message: this.error || '', running: false }
    try {
      const value = JSON.parse(await readFile(join(this.stateDir, 'public-connection.json'), 'utf8'))
      this.last = { status: value.status || 'starting', origin: value.publicOrigin || '', updatedAt: value.updatedAt || '', message: value.reason || '' }
    } catch (error) {
      // The child may be replacing this small status file while it is being read.
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    return this.error ? { status: 'error', message: this.error, running: true } : { ...this.last, running: true }
  }
  start() { return this.exclusive(async () => {
    if (this.child && this.child.exitCode === null) return this.status()
    if (!this.cloudflared) throw Error('未找到 cloudflared，请检查应用运行时文件')
    this.error = ''
    this.last = { status: 'starting', updatedAt: new Date().toISOString() }
    await writeFile(join(this.stateDir, 'public-connection.json'), JSON.stringify(this.last), { mode: 0o600 })
    const child = this.createChild(fileURLToPath(new URL('./tunnel.mjs', import.meta.url)),
      ['--cloudflared', this.cloudflared, '--state-dir', this.stateDir, '--port', '0'],
      { execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    this.child = child
    child.on('message', message => { if (this.child === child && message?.type === 'tunnel-error') this.error = privateError(message.error) })
    child.once('error', error => { if (this.child === child) { this.error = privateError(error); this.child = null } })
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = null
      if (!this.stopping) this.error ||= 'Cloudflare Tunnel 已退出，请重新开启'
    })
    return this.status()
  }) }
  stop() { return this.exclusive(async () => {
    const child = this.child
    this.stopping = true
    try {
      if (child && child.exitCode === null) await new Promise((resolve, reject) => {
        let forceTimer
        const finish = error => {
          clearTimeout(timer); clearTimeout(forceTimer); child.off('exit', exited)
          error ? reject(error) : resolve()
        }
        const exited = () => finish()
        const timer = setTimeout(() => {
          forceTimer = setTimeout(() => finish(Error('隧道关闭超时，请刷新服务状态')), 2000)
          child.kill()
        }, 5000)
        child.once('exit', exited)
        if (child.connected) child.send({ type: 'shutdown' }, error => { if (error && child.exitCode === null) child.kill() })
        else child.kill()
      })
      if (this.child === child) this.child = null
      this.error = ''
      this.last = { status: 'stopped' }
      return this.status()
    } finally { this.stopping = false }
  }) }
}
