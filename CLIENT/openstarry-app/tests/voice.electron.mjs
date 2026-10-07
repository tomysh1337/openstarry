// Production renderer/preload, synthetic microphone, fixture model and voice IPC.
// Does not request a real microphone or contact a provider.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
const artifacts = resolve(process.env.OPENSTARRY_VOICE_ARTIFACTS || 'tmp/voice-ui')
mkdirSync(artifacts, { recursive: true })
app.setPath('userData', mkdtempSync(join(tmpdir(), 'openstarry-voice-test-')))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
const calls = [],
  errors = [],
  results = [],
  data = new Map(),
  waiting = new Map()
let hold = false
const state = {
  phase: 'stopped',
  installed: true,
  message: 'Fixture voice ready',
  hasReference: true,
  config: { preset: 'laomushi', referenceText: '参考音频', speed: 1, language: 'all_zh' }
}
const fixture = (name, handler) =>
  ipcMain.handle(name, (event, ...args) => {
    calls.push({ name, args })
    return handler(...args, event)
  })
fixture('readData', (key) => data.get(key) || [])
fixture('writeData', (key, value) => {
  data.set(key, value)
  return true
})
fixture('runtime:status:get', () => ({ phase: 'ready', progress: 100 }))
fixture('system:settings:get', () => ({
  autoContinue: {},
  vault: {},
  sync: {},
  updates: {},
  retention: {}
}))
fixture('retention:status:get', () => ({}))
fixture('sync:preferences', () => ({}))
fixture('api:get_models_list', () => ['voice-fixture'])
fixture('ide:gpt-status', () => ({ message: 'fixture', state: 'idle' }))
fixture('ide:gpt-services', () => ({ bridge: { safetyMode: 'ask' }, subagents: [], sandbox: {} }))
fixture('voice:status', () => state)
fixture('voice:configure', (patch) => {
  Object.assign(state.config, patch)
  return state
})
fixture('voice:start', () => {
  state.phase = 'ready'
  return state
})
fixture('voice:stop', () => {
  state.phase = 'stopped'
  return state
})
fixture('voice:transcribe', (bytes) => {
  const data = Buffer.from(bytes)
  assert.equal(data.subarray(0, 4).toString(), 'RIFF')
  assert.ok(data.length > 3200)
  return { text: '测试语音对话' }
})
const wav = Buffer.alloc(44 + 3200)
wav.write('RIFF')
wav.writeUInt32LE(wav.length - 8, 4)
wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(16000, 24)
wav.writeUInt32LE(32000, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(3200, 40)
fixture('voice:synthesize', () => ({
  audio: wav.toString('base64'),
  seconds: 0.1,
  sampleRate: 16000
}))
fixture('ide:http', async (value, event) => {
  const body = JSON.parse(value.body)
  assert.equal(body.messages.at(-1).content, '测试语音对话')
  let lastSeq = 0
  const emit = (delta, finish_reason) =>
    event.sender.send('ide:http-chunk', {
      id: value.id,
      seq: ++lastSeq,
      text: 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
    })
  emit({ reasoning_content: '不应朗读思考内容' })
  if (hold) await new Promise((resolve, reject) => waiting.set(value.id, { resolve, reject }))
  emit({ content: '你好，语音已接通。' })
  emit({}, 'stop')
  return {
    status: 200,
    lastSeq,
    streamed: true,
    headers: { 'content-type': 'text/event-stream' },
    text: ''
  }
})
fixture('ide:cancel-http', ({ id }) => {
  waiting.get(id)?.reject(Error('fixture cancelled'))
  waiting.delete(id)
})
let window
const evaluate = (fn, ...args) =>
  window.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`, true)
const waitFor = async (fn) => {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw Error('UI condition timed out')
}
const click = (text) =>
  evaluate(
    (text) =>
      [...document.querySelectorAll('.os-voice-panel button')]
        .find((button) => button.textContent === text)
        .click(),
    text
  )
const speak = async () => {
  await evaluate(() => {
    window.voiceGain.gain.value = 0.13
  })
  await new Promise((resolve) => setTimeout(resolve, 600))
  await evaluate(() => {
    window.voiceGain.gain.value = 0
  })
}
const check = async (name, fn) => {
  await fn()
  results.push(name)
  console.log('PASS:', name)
}
app.whenReady().then(async () => {
  try {
    window = new BrowserWindow({
      width: 1440,
      height: 1000,
      show: false,
      webPreferences: {
        preload: resolve('out/preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        backgroundThrottling: false,
        offscreen: true
      }
    })
    window.webContents.on('console-message', ({ level, message }) => {
      if (level === 3) errors.push(message)
    })
    await window.loadFile(resolve('out/renderer/index.html'), { hash: '/idePage' })
    await evaluate(() => {
      localStorage.setItem('modelProvider', 'openai')
      localStorage.setItem('modelName', 'voice-fixture')
    })
    await new Promise((resolve) => {
      window.webContents.once('did-finish-load', resolve)
      window.reload()
    })
    await waitFor(() =>
      evaluate(
        () => document.querySelector('.os-voice-panel') && document.querySelector('.os-agent-input')
      )
    )
    await evaluate(() => {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        value: async () => {
          const context = new AudioContext({ sampleRate: 16000 }),
            oscillator = context.createOscillator(),
            gain = context.createGain(),
            destination = context.createMediaStreamDestination()
          gain.gain.value = 0
          oscillator.connect(gain)
          gain.connect(destination)
          oscillator.start()
          window.voiceGain = gain
          window.voiceStream = destination.stream
          window.voiceFixtureContext = context
          return destination.stream
        }
      })
    })
    await check(
      'voice UI exposes engine choice and receives speech without accessing microphone',
      async () => {
        await click('开始语音对话')
        await waitFor(() =>
          evaluate(() =>
            document.querySelector('.os-voice-status').textContent.includes('正在聆听')
          )
        )
        assert.equal(
          await evaluate(() => document.querySelectorAll('.os-voice-panel option').length),
          2
        )
      }
    )
    await check('speech sends one model turn and speaks the answer, never reasoning', async () => {
      await speak()
      await waitFor(() => calls.some((call) => call.name === 'voice:synthesize'))
      assert.deepEqual(
        calls.filter((call) => call.name === 'voice:synthesize').map((call) => call.args[0]),
        ['你好，语音已接通。']
      )
      await waitFor(() =>
        evaluate(() => document.querySelector('.os-voice-status').textContent.includes('正在聆听'))
      )
      assert.equal(calls.filter((call) => call.name === 'ide:http').length, 1)
    })
    await check('interrupt cancels an in-flight reasoning turn and resumes listening', async () => {
      hold = true
      await speak()
      await waitFor(() => waiting.size === 1)
      await click('打断并说话')
      await waitFor(() => calls.some((call) => call.name === 'ide:cancel-http'))
      assert.ok(
        await evaluate(() =>
          document.querySelector('.os-voice-status').textContent.includes('正在聆听')
        )
      )
    })
    await check('hangup releases microphone tracks', async () => {
      await click('挂断')
      await waitFor(() =>
        evaluate(() =>
          window.voiceStream.getTracks().every((track) => track.readyState === 'ended')
        )
      )
      assert.ok(
        await evaluate(() =>
          document.querySelector('.os-voice-status').textContent.includes('麦克风已关闭')
        )
      )
    })
    await evaluate(() => {
      document.querySelector('.os-voice-panel details').open = true
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    writeFileSync(
      join(artifacts, 'voice-panel.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    assert.deepEqual(errors, [])
    writeFileSync(join(artifacts, 'results.json'), JSON.stringify({ results, errors }, null, 2))
    app.exit(0)
  } catch (error) {
    console.error(error)
    console.error('Renderer errors:', errors)
    if (window) console.error(await evaluate(() => document.body.innerText.slice(-2200)))
    writeFileSync(
      join(artifacts, 'results.json'),
      JSON.stringify({ results, errors, error: error.stack }, null, 2)
    )
    app.exit(1)
  }
})
