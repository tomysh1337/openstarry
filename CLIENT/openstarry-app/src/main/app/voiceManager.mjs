import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const defaults = { preset: 'laomushi', referenceText: '', speed: 1, language: 'all_zh' }
export function voiceConfig(value = {}) {
  return {
    preset: value.preset === 'gpt-sovits' ? 'gpt-sovits' : 'laomushi',
    referenceText: String(value.referenceText || '').slice(0, 500),
    speed: Math.max(0.6, Math.min(1.5, Number(value.speed) || 1)),
    language: value.language === 'en' ? 'en' : 'all_zh'
  }
}

export class VoiceManager extends EventEmitter {
  constructor({ root, source, uv, logPath }) {
    super()
    Object.assign(this, { root, source, uv, logPath })
    this.python = join(root, 'venv', 'Scripts', 'python.exe')
    this.pending = new Map()
    this.phase = 'stopped'
    this.message = '语音引擎未启动'
    this.device = ''
    this.config = { ...defaults }
    try {
      this.config = voiceConfig(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')))
    } catch {
      /* New installs use the bundled defaults. */
    }
  }
  status() {
    return {
      phase: this.phase,
      message: this.message,
      device: this.device,
      config: this.config,
      installed: existsSync(join(this.root, 'installed.json')) && existsSync(this.python),
      hasReference: existsSync(join(this.root, 'reference.wav')),
      root: this.root
    }
  }
  update(phase, message) {
    this.phase = phase
    this.message = message
    this.emit('status', this.status())
  }
  configure(patch) {
    this.config = voiceConfig({ ...this.config, ...patch })
    mkdirSync(this.root, { recursive: true })
    writeFileSync(join(this.root, 'settings.json'), JSON.stringify(this.config, null, 2))
    return this.status()
  }
  environment() {
    const temporary = join(this.root, 'cache', 'temp')
    mkdirSync(temporary, { recursive: true })
    return {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      UV_HTTP_TIMEOUT: '1800',
      UV_LOCK_TIMEOUT: '7200',
      UV_CACHE_DIR: join(this.root, 'cache', 'uv'),
      UV_PYTHON_INSTALL_DIR: join(this.root, 'python'),
      HF_HOME: join(this.root, 'cache', 'huggingface'),
      HF_HUB_DISABLE_XET: '1',
      TEMP: temporary,
      TMP: temporary
    }
  }
  runSetup(exe, args) {
    if (this.stopping) throw Error('语音组件准备已取消')
    return new Promise((resolve, reject) => {
      const log = createWriteStream(this.logPath, { flags: 'a' })
      const child = spawn(exe, args, {
        cwd: this.source,
        env: this.environment(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      this.setupChild = child
      child.stdout.pipe(log)
      child.stderr.pipe(log)
      child.once('error', (error) => {
        log.end()
        reject(error)
      })
      child.once('exit', (code) => {
        log.end()
        if (this.setupChild === child) this.setupChild = null
        code === 0 ? resolve() : reject(Error('语音组件安装失败，请查看语音安装日志后重试'))
      })
    })
  }
  async install() {
    if (this.installing) return this.installing
    if (this.worker) throw Error('请先停止语音引擎')
    this.stopping = false
    this.installing = (async () => {
      mkdirSync(this.root, { recursive: true })
      this.update('installing', '正在准备 Python 语音环境…')
      if (!existsSync(this.python))
        await this.runSetup(this.uv, ['venv', '--python', '3.11', join(this.root, 'venv')])
      this.update('installing', '正在下载 PyTorch 和语音依赖，首次下载约 6 GB…')
      await this.runSetup(this.uv, [
        'pip',
        'install',
        '--python',
        this.python,
        'torch==2.7.1',
        'torchaudio==2.7.1',
        '--index-url',
        'https://download.pytorch.org/whl/cu128'
      ])
      await this.runSetup(this.uv, [
        'pip',
        'install',
        '--python',
        this.python,
        '-r',
        join(this.source, 'requirements.txt')
      ])
      this.update('installing', '正在下载 GPT-SoVITS、老牧师音色和本地识别模型…')
      await this.runSetup(this.python, [join(this.source, 'install.py'), '--root', this.root])
      this.update('stopped', '语音组件已安装，可以开始对话')
      return this.status()
    })()
      .catch((error) => {
        this.update('error', error.message)
        throw error
      })
      .finally(() => {
        this.installing = null
      })
    return this.installing
  }
  async start() {
    if (this.phase === 'ready' && this.worker) return this.status()
    if (this.starting) return this.starting
    this.stopping = false
    this.starting = (async () => {
      if (!this.status().installed) await this.install()
      if (this.stopping) throw Error('语音启动已取消')
      this.update('starting', '正在加载并预热语音模型，首次启动较慢…')
      await new Promise((resolve, reject) => {
        const child = spawn(this.python, [join(this.source, 'worker.py'), '--root', this.root], {
          cwd: this.root,
          env: this.environment(),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
        this.worker = child
        const log = createWriteStream(this.logPath, { flags: 'a' })
        child.stderr.pipe(log)
        const timer = setTimeout(() => {
          this.kill(child)
          reject(Error('语音模型加载超时，请检查语音安装日志'))
        }, 240000)
        const fail = (error) => {
          clearTimeout(timer)
          reject(error)
          this.rejectPending(error)
        }
        child.once('error', fail)
        child.once('exit', () => {
          log.end()
          clearTimeout(timer)
          if (this.worker === child) this.worker = null
          fail(Error('语音引擎已停止'))
          if (!this.stopping && this.phase === 'ready')
            this.update('error', '语音进程退出，请重新启动')
        })
        createInterface({ input: child.stdout }).on('line', (line) => {
          let message
          try {
            message = JSON.parse(line)
          } catch {
            return
          }
          if (message.event === 'ready') {
            clearTimeout(timer)
            this.device = message.device
            this.update('ready', '语音引擎就绪 · ' + (this.device === 'cuda' ? 'GPU' : 'CPU'))
            resolve()
          } else if (message.event === 'fatal') {
            fail(Error(message.error))
            this.kill(child)
          } else {
            const pending = this.pending.get(message.id)
            if (!pending) return
            this.pending.delete(message.id)
            clearTimeout(pending.timer)
            message.error ? pending.reject(Error(message.error)) : pending.resolve(message.result)
          }
        })
      })
      return this.status()
    })()
      .catch((error) => {
        this.update('error', error.message)
        throw error
      })
      .finally(() => {
        this.starting = null
      })
    return this.starting
  }
  async request(op, value) {
    await this.start()
    if (!this.worker?.stdin.writable) throw Error('语音引擎未就绪')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(Error('语音处理超时，请重新启动语音引擎'))
        this.stop()
      }, 120000)
      this.pending.set(id, { resolve, reject, timer })
      this.worker.stdin.write(JSON.stringify({ ...value, id, op }) + '\n', (error) => {
        if (error) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }
  transcribe(bytes) {
    const audio = Buffer.from(bytes)
    if (audio.length > 3 * 1024 * 1024) throw Error('录音过长')
    return this.request('transcribe', { audio: audio.toString('base64') })
  }
  synthesize(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 500)
      throw Error('朗读文本长度无效')
    return this.request('synthesize', { text, ...this.config })
  }
  reference(bytes) {
    if (bytes.length > 20 * 1024 * 1024) throw Error('参考音频超过 20 MB')
    return this.request('reference', { audio: Buffer.from(bytes).toString('base64') })
  }
  rejectPending(error) {
    for (const value of this.pending.values()) {
      clearTimeout(value.timer)
      value.reject(error)
    }
    this.pending.clear()
  }
  kill(child) {
    if (!child?.pid) return Promise.resolve()
    return new Promise((resolve) => {
      if (process.platform !== 'win32') {
        child.kill()
        resolve()
        return
      }
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.once('exit', resolve)
      killer.once('error', resolve)
    })
  }
  async stop() {
    this.stopping = true
    this.rejectPending(Error('语音引擎已停止'))
    await Promise.all([this.kill(this.worker), this.kill(this.setupChild)])
    this.worker = null
    this.update('stopped', '语音引擎已停止')
    return this.status()
  }
}
