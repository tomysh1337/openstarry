import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
const maxFile = 1024 * 1024, maxProject = 12 * maxFile
const skipped = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.idea'])
export class IdeWorkspace {
  constructor() { this.roots = new Set(); this.jobs = new Map() }
  async authorize(root) { const real = await fs.realpath(root); if (!(await fs.stat(real)).isDirectory()) throw Error('请选择项目目录'); this.roots.add(real); return real }
  async root(value) { const real = await fs.realpath(value); if (!this.roots.has(real)) throw Error('请重新选择项目目录'); return real }
  async resolve(root, relative, create = false) {
    root = await this.root(root)
    if (typeof relative !== 'string' || !relative || /[\x00-\x1f:]/.test(relative) || path.isAbsolute(relative) || relative.replaceAll('\\', '/').split('/').some(part => !part || part === '..' || part === '.' || /[. ]$/.test(part))) throw Error('文件路径必须位于项目目录内')
    const target = path.resolve(root, relative)
    if (!target.startsWith(root + path.sep)) throw Error('文件路径越过项目边界')
    let cursor = root
    const parts = path.relative(root, target).split(path.sep)
    for (let index = 0; index < parts.length; index++) {
      cursor = path.join(cursor, parts[index]); const stat = await fs.lstat(cursor).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (stat?.isSymbolicLink()) throw Error('项目符号链接暂不支持编辑')
      if (!stat && create && index < parts.length - 1) await fs.mkdir(cursor)
    }
    return target
  }
  async readProject(root) {
    root = await this.root(root); const files = Object.create(null); let total = 0, count = 0, omitted = 0
    const visit = async (folder, prefix = '') => {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || skipped.has(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.')) { omitted++; continue }
        const relative = prefix + entry.name, full = path.join(folder, entry.name)
        if (entry.isDirectory()) { await visit(full, relative + '/'); continue }
        if (!entry.isFile()) continue
        const stat = await fs.stat(full); if (stat.size > maxFile) { omitted++; continue }
        const bytes = await fs.readFile(full); let text
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { omitted++; continue }
        if (text.includes('\0')) { omitted++; continue }
        if (++count > 1000 || (total += bytes.length) > maxProject) throw Error('项目过大，请打开更小的子目录（1000 个文本文件 / 12 MB）')
        files[relative] = text
      }
    }
    await visit(root)
    return { name: path.basename(root), nativeRoot: root, files, diskFiles: { ...files }, omitted }
  }
  async check(root, relative, expected) {
    const target = await this.resolve(root, relative, true)
    let actual = null
    try { actual = await fs.readFile(target, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (actual !== expected) throw Error('磁盘文件已经改变，请重新打开目录核对后保存')
    return target
  }
  async write({ root, path: relative, content, expected }) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > maxFile || content.includes('\0')) throw Error('文件内容超过限制')
    const target = await this.check(root, relative, expected)
    const temp = target + '.openstarry-' + randomUUID() + '.tmp'
    try { await fs.writeFile(temp, content, { flag: 'wx' }); await fs.rename(temp, target) }
    finally { await fs.rm(temp, { force: true }).catch(() => {}) }
    return { saved: true }
  }
  async rename({ root, path: relative, next, expected }) {
    const target = await this.check(root, relative, expected), destination = await this.resolve(root, next, true)
    if (await fs.lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) throw Error('目标文件已存在')
    await fs.rename(target, destination); return { renamed: true }
  }
  async run({ root, command }, onOutput = () => {}) {
    root = await this.root(root)
    if (typeof command !== 'string' || !command.trim() || command.length > 4000) throw Error('请输入运行命令')
    if (this.jobs.size >= 2) throw Error('请先停止正在运行的命令')
    const id = randomUUID()
    const child = spawn(command, { cwd: root, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', finished = false
    const timer = setTimeout(() => this.stop(id), 120000)
    const done = new Promise(resolve => {
      const finish = exitCode => { if (finished) return; finished = true; clearTimeout(timer); this.jobs.delete(id); resolve({ output, exitCode }) }
      const append = chunk => { const text = chunk.toString(); output = (output + text).slice(-100000); onOutput({ id, text: text.slice(0, 20000) }) }
      child.stdout.on('data', append); child.stderr.on('data', append)
      child.on('error', error => { append(error.message); finish(-1) }); child.on('close', code => finish(code ?? -1))
    })
    this.jobs.set(id, { child, done }); return { id, done }
  }
  stop(id) {
    const child = this.jobs.get(id)?.child; if (!child?.pid) return
    if (process.platform === 'win32') { const stop = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); stop.on('error', () => child.kill()) }
    else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill() } }
  }
  stopAll() { for (const id of this.jobs.keys()) this.stop(id) }
}
