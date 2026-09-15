import { app } from 'electron'
import { EventEmitter } from 'events'
import { createHash } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { spawn } from 'child_process'
import { createDataDirectories } from './settingsStore'

const SERVICE_SPECS = [
  { id: 'memory', label: '本地数据', folder: 'MEMORY', port: 5093, startupTimeoutMs: 90000 },
  { id: 'files', label: '文件与知识库', folder: 'FILE', port: 5094, startupTimeoutMs: 90000 },
  { id: 'tasks', label: '任务编排', folder: 'TASK', port: 5090, startupTimeoutMs: 90000 },
  { id: 'agent', label: '智能助手', folder: 'AGENT', port: 5091, startupTimeoutMs: 180000 }
]

const DEVELOPMENT_FOLDERS = {
  MEMORY: ['MEMORY', 'memory_module'],
  FILE: ['FILE', 'file_service'],
  TASK: ['TASK', 'task_flow_module'],
  AGENT: ['AGENT', 'agent_module']
}

const wait = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

export class BackendManager extends EventEmitter {
  constructor(settingsStore, bridgeToken = '') {
    super()
    this.settingsStore = settingsStore
    this.bridgeToken = bridgeToken
    this.paths = createDataDirectories()
    this.processes = new Map()
    this.restartCounts = new Map()
    this.stopping = false
    this.status = {
      phase: 'idle',
      message: '准备启动 OpenStarry NextGen',
      progress: 0,
      modules: Object.fromEntries(SERVICE_SPECS.map((item) => [item.id, 'waiting']))
    }
  }

  getStatus() {
    return structuredClone(this.status)
  }

  _setStatus(patch) {
    this.status = {
      ...this.status,
      ...patch,
      modules: { ...this.status.modules, ...(patch.modules || {}) }
    }
    this.emit('status', this.getStatus())
  }

  _sourceDirectory(spec) {
    if (app.isPackaged) return join(process.resourcesPath, 'backend', spec.folder)
    return resolve(process.cwd(), '..', '..', ...DEVELOPMENT_FOLDERS[spec.folder])
  }

  _uvExecutable() {
    if (app.isPackaged) return join(process.resourcesPath, 'runtime', 'uv.exe')
    return 'uv'
  }

  _environment(spec) {
    const componentEnvironment = join(this.paths.components, 'python', spec.id)
    const autoContinue = this.settingsStore?.get().autoContinue || {}
    mkdirSync(componentEnvironment, { recursive: true })
    return {
      ...process.env,
      OPENSTARRY_INTEGRATED: '1',
      OPENSTARRY_DATA_DIR: this.paths.data,
      OPENSTARRY_USER_ID: 'local-user',
      OPENSTARRY_COMPUTER_BRIDGE: 'http://127.0.0.1:5095',
      OPENSTARRY_BRIDGE_TOKEN: this.bridgeToken,
      OPENSTARRY_AUTO_CONTINUE: autoContinue.enabled === false ? '0' : '1',
      OPENSTARRY_AUTO_CONTINUE_MAX_TURNS: String(autoContinue.maxTurns || 50),
      OPENSTARRY_AUTO_CONTINUE_MAX_MINUTES: String(autoContinue.maxMinutes || 120),
      OPENSTARRY_REPEATED_ERROR_LIMIT: String(autoContinue.repeatedErrorLimit || 3),
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      UV_CACHE_DIR: join(this.paths.cache, 'uv'),
      UV_PROJECT_ENVIRONMENT: componentEnvironment,
      TASK_SERVER_BASE_URL: 'http://127.0.0.1:5090',
      AGENT_SERVICE_URL: 'http://127.0.0.1:5091',
      MEMORY_SERVICE_BASE_URL: 'http://127.0.0.1:5093',
      FILE_SERVICE_URL: 'http://127.0.0.1:5094',
      FILE_STORE_BASE_DIR: join(this.paths.attachments, 'files'),
      AGENT_BASE_DIR: join(this.paths.data, 'agent-runtime')
    }
  }

  async _healthCheck(port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1200)
      })
      return response.ok
    } catch {
      return false
    }
  }

  _componentEnvironment(spec) {
    return join(this.paths.components, 'python', spec.id)
  }

  _dependencyFingerprint(sourceDirectory) {
    const hash = createHash('sha256')
    let dependencyFileCount = 0

    for (const fileName of ['pyproject.toml', 'uv.lock']) {
      const filePath = join(sourceDirectory, fileName)
      if (!existsSync(filePath)) continue
      hash.update(fileName)
      hash.update(readFileSync(filePath))
      dependencyFileCount += 1
    }

    if (dependencyFileCount === 0) {
      throw new Error(`组件依赖清单缺失：${sourceDirectory}`)
    }

    return hash.digest('hex')
  }

  _preparationMarker(spec) {
    return join(this._componentEnvironment(spec), '.openstarry-runtime.json')
  }

  _preparedPython(spec, sourceDirectory) {
    const pythonExecutable = join(this._componentEnvironment(spec), 'Scripts', 'python.exe')
    const markerPath = this._preparationMarker(spec)
    if (!existsSync(pythonExecutable) || !existsSync(markerPath)) return null

    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
      return marker.schema === 1 && marker.fingerprint === this._dependencyFingerprint(sourceDirectory)
        ? pythonExecutable
        : null
    } catch {
      return null
    }
  }

  _recordPreparation(spec, sourceDirectory) {
    const markerPath = this._preparationMarker(spec)
    const temporaryPath = `${markerPath}.tmp`
    writeFileSync(temporaryPath, JSON.stringify({
      schema: 1,
      fingerprint: this._dependencyFingerprint(sourceDirectory),
      preparedAt: new Date().toISOString()
    }))
    renameSync(temporaryPath, markerPath)
  }

  async _runPreparation(spec, sourceDirectory) {
    const developmentPython = join(sourceDirectory, '.venv', 'Scripts', 'python.exe')
    if (!app.isPackaged && existsSync(developmentPython)) return developmentPython

    const preparedPython = this._preparedPython(spec, sourceDirectory)
    if (preparedPython) {
      this._setStatus({ message: `${spec.label}组件已安装，正在启动…` })
      return preparedPython
    }

    const uvExecutable = this._uvExecutable()
    if (!existsSync(uvExecutable) && app.isPackaged) {
      throw new Error('核心运行组件缺失，请重新安装 OpenStarry NextGen')
    }

    this._setStatus({ message: `首次准备${spec.label}组件，正在下载所需文件…` })
    await this._spawnAndWait(
      uvExecutable,
      ['sync', '--frozen', '--no-install-project', '--project', sourceDirectory],
      sourceDirectory,
      this._environment(spec),
      join(this.paths.logs, `${spec.id}-setup.log`)
    )

    const pythonExecutable = join(this.paths.components, 'python', spec.id, 'Scripts', 'python.exe')
    if (!existsSync(pythonExecutable)) throw new Error(`${spec.label}组件准备失败`)
    this._recordPreparation(spec, sourceDirectory)
    return pythonExecutable
  }

  _spawnAndWait(executable, args, cwd, env, logPath) {
    return new Promise((resolvePromise, reject) => {
      const log = createWriteStream(logPath, { flags: 'a' })
      const child = spawn(executable, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child.stdout.pipe(log)
      child.stderr.pipe(log)
      child.once('error', reject)
      child.once('exit', (code) => {
        log.end()
        code === 0 ? resolvePromise() : reject(new Error(`${executable} exited with code ${code}`))
      })
    })
  }

  async _launch(spec, pythonExecutable, sourceDirectory) {
    const stdout = createWriteStream(join(this.paths.logs, `${spec.id}.out.log`), { flags: 'a' })
    const stderr = createWriteStream(join(this.paths.logs, `${spec.id}.err.log`), { flags: 'a' })
    const child = spawn(pythonExecutable, ['main.py'], {
      cwd: sourceDirectory,
      env: this._environment(spec),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.pipe(stdout)
    child.stderr.pipe(stderr)
    this.processes.set(spec.id, child)
    child.once('error', (error) => {
      this._setStatus({ phase: 'error', message: `${spec.label}组件启动失败：${error.message}` })
    })
    child.once('exit', async (code) => {
      stdout.end()
      stderr.end()
      this.processes.delete(spec.id)
      if (this.stopping) return
      const attempts = (this.restartCounts.get(spec.id) || 0) + 1
      this.restartCounts.set(spec.id, attempts)
      if (attempts <= 3) {
        this._setStatus({ message: `${spec.label}组件正在恢复（${attempts}/3）`, modules: { [spec.id]: 'restarting' } })
        await wait(1000 * attempts)
        try {
          await this._launch(spec, pythonExecutable, sourceDirectory)
        } catch (error) {
          this._setStatus({ phase: 'error', message: `${spec.label}组件恢复失败：${error.message}` })
        }
      } else {
        this._setStatus({
          phase: 'error',
          message: `${spec.label}组件连续异常退出，请打开诊断与修复`,
          modules: { [spec.id]: `failed:${code}` }
        })
      }
    })
  }

  async _waitUntilHealthy(spec, timeoutMs = spec.startupTimeoutMs || 90000) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (await this._healthCheck(spec.port)) return true
      const child = this.processes.get(spec.id)
      if (child?.exitCode != null) return false
      await wait(500)
    }
    return false
  }

  async start() {
    this.stopping = false
    this.restartCounts.clear()
    this._setStatus({ phase: 'starting', message: '正在初始化 OpenStarry NextGen', progress: 2 })
    for (let index = 0; index < SERVICE_SPECS.length; index += 1) {
      const spec = SERVICE_SPECS[index]
      if (await this._healthCheck(spec.port)) {
        this._setStatus({ modules: { [spec.id]: 'ready' }, progress: 15 + index * 20 })
        continue
      }
      this._setStatus({ message: `正在检查${spec.label}组件`, modules: { [spec.id]: 'preparing' } })
      const sourceDirectory = this._sourceDirectory(spec)
      const pythonExecutable = await this._runPreparation(spec, sourceDirectory)
      await this._launch(spec, pythonExecutable, sourceDirectory)
      const ready = await this._waitUntilHealthy(spec)
      if (!ready) throw new Error(`${spec.label}组件未能完成初始化`)
      this.restartCounts.set(spec.id, 0)
      this._setStatus({
        message: `${spec.label}已就绪`,
        modules: { [spec.id]: 'ready' },
        progress: 20 + index * 20
      })
    }
    this._setStatus({ phase: 'ready', message: 'OpenStarry NextGen 已就绪', progress: 100 })
    return this.getStatus()
  }

  async retry() {
    await this.stop()
    return this.start()
  }

  async stop() {
    this.stopping = true
    const children = [...this.processes.values()]
    this.processes.clear()
    await Promise.all(children.map((child) => new Promise((resolvePromise) => {
      if (child.exitCode != null) return resolvePromise()
      const timeout = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* The process has already exited. */ }
        resolvePromise()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolvePromise()
      })
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.once('error', () => {
          try { child.kill() } catch { /* The process has already exited. */ }
        })
      } else {
        try { child.kill() } catch { clearTimeout(timeout); resolvePromise() }
      }
    })))
    this._setStatus({ phase: 'stopped', message: 'OpenStarry NextGen 已停止', progress: 0 })
  }
}
