// Run with Electron after `npm run build`. Only the renderer/preload are real;
// IPC fixtures never touch installed settings, backends, login items or browsers.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'

const artifacts = resolve(process.env.OPENSTARRY_SETTINGS_ARTIFACTS || '../../tmp/settings-ui')
mkdirSync(artifacts, { recursive: true })
app.setPath('userData', mkdtempSync(join(tmpdir(), 'openstarry-settings-test-')))
app.disableHardwareAcceleration()
const settings = {
  closeBehavior: 'tray',
  launchAtLogin: false,
  computerControlMode: 'auto',
  confirmIrreversibleActions: true,
  autoContinue: { enabled: true, maxTurns: 50, maxMinutes: 120, repeatedErrorLimit: 3 },
  vault: { enabled: false, helloPreferred: true, masterPasswordFallback: false },
  sync: {
    enabled: false,
    serverUrl: 'https://sync.example.test',
    userId: 'fixture',
    intervalMinutes: 5
  }
}
const calls = [],
  data = new Map(),
  preferences = {},
  errors = [],
  results = []
let failSave = false,
  holdSave = false
const pendingSaves = []
const fixture = (name, handler) =>
  ipcMain.handle(name, async (_event, ...args) => {
    calls.push({ name, args })
    return handler(...args)
  })
fixture('voice:status', () => ({ phase: 'stopped', message: 'Fixture voice', config: { preset: 'laomushi', referenceText: '', speed: 1, language: 'all_zh' } }))
fixture('readData', (key) => data.get(key) || [])
fixture('writeData', (key, value) => data.set(key, value) && true)
fixture('runtime:status:get', () => ({
  phase: 'ready',
  progress: 100,
  message: 'Settings fixture'
}))
fixture('retention:status:get', () => ({ expiredCount: 0 }))
fixture('system:settings:get', () => settings)
fixture('system:settings:update', async (patch) => {
  if (failSave) throw Error('Fixture: settings write failed')
  Object.assign(settings, patch)
  const response = structuredClone(settings)
  if (holdSave) await new Promise((resolve) => pendingSaves.push(resolve))
  return response
})
fixture('sync:preferences', (value) => ({ values: Object.assign(preferences, value || {}) }))
fixture('sync:status:get', () => ({ phase: 'idle', message: 'Fixture sync disabled', queued: 0 }))
fixture('api:set_proxy', () => true)

let window
const evaluate = (fn, ...args) =>
  window.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`)
const waitFor = async (fn) => {
  const end = Date.now() + 7000
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw Error('Timed out waiting for renderer')
}
const test = async (name, fn) => {
  try {
    await fn()
    results.push({ name, passed: true })
    console.log('PASS:', name)
  } catch (error) {
    results.push({ name, passed: false, error: error.message })
    console.error(
      'FAIL:',
      name,
      error.message,
      await evaluate(() =>
        [...document.querySelectorAll('[role="alert"]')].map((el) => el.outerHTML)
      )
    )
  }
}
const fill = (selector, value) =>
  evaluate(
    (selector, value) => {
      const input = document.querySelector(selector)
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    },
    selector,
    value
  )
const clickCard = (title, selector) =>
  evaluate(
    (title, selector) => {
      const card = [...document.querySelectorAll('.setting-card')].find(
        (card) => card.querySelector('.setting-title')?.textContent === title
      )
      card.querySelector(selector).click()
    },
    title,
    selector
  )
const screenshotCard = async (title, name) => {
  const rect = await evaluate(async (title) => {
    await document.fonts.ready
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {}))
    )
    const card = [...document.querySelectorAll('.setting-card')].find(
      (card) => card.querySelector('.setting-title')?.textContent === title
    )
    card.scrollIntoView({ block: 'center', behavior: 'instant' })
    return new Promise((resolve) =>
      requestAnimationFrame(() => {
        const r = card.getBoundingClientRect()
        resolve({
          x: Math.floor(r.x),
          y: Math.floor(r.y),
          width: Math.ceil(r.width),
          height: Math.ceil(r.height)
        })
      })
    )
  }, title)
  const paint = () =>
    new Promise((resolve) => {
      window.webContents.once('paint', (_event, _dirty, image) => resolve(image))
      window.webContents.invalidate()
    })
  // Drain a pending paint from before scrolling before capturing the new frame.
  await paint()
  const frame = await paint()
  writeFileSync(join(artifacts, name + '.png'), frame.crop(rect).toPNG())
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
      if (level === 3 && !message.includes('Fixture: settings write failed')) errors.push(message)
    })
    await window.loadFile(resolve('out/renderer/index.html'), { hash: '/settingPage' })
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
      enabled: true
    })
    await waitFor(() =>
      evaluate(
        () => document.querySelector('.os-tools') && !document.querySelector('.startup-overlay')
      )
    )
    // A real card with enough description text to reproduce the overlap.
    const title = await evaluate(
      () =>
        [...document.querySelectorAll('.setting-card')]
          .find((card) => card.textContent.includes('允许Agent对工作区文件'))
          .querySelector('.setting-title').textContent
    )
    await test('switches do not overlap descriptions at wide/narrow widths and 200% zoom', async () => {
      const overlap = []
      for (const [width, zoom] of [
        [1440, 1],
        [1040, 1],
        [800, 1],
        [1440, 2]
      ]) {
        window.setSize(width, 1000)
        window.webContents.setZoomFactor(zoom)
        const bad = await evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() =>
                resolve(
                  [...document.querySelectorAll('.setting-control')].flatMap((row) => {
                    const info = row.querySelector('.setting-info'),
                      control = row.querySelector('.mode-switch, .setting-toggle')
                    if (!info || !control) return []
                    const a = info.getBoundingClientRect(),
                      b = control.getBoundingClientRect()
                    return Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
                      Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)
                      ? [row.closest('.setting-card').querySelector('.setting-title').textContent]
                      : []
                  })
                )
              )
            )
        )
        if (bad.length) overlap.push({ width, zoom, cards: bad })
      }
      assert.deepEqual(overlap, [])
    })
    window.setSize(1440, 1000)
    window.webContents.setZoomFactor(1)

    await test('all 15 switches expose a name/state and persist pointer changes', async () => {
      const values = await evaluate(() =>
        [...document.querySelectorAll('.setting-toggle')].map((el) => {
          const input = el.querySelector('[role="switch"]')
          const name = input?.getAttribute('aria-label')
          const before = input?.getAttribute('aria-checked')
          el.click()
          return { name, before }
        })
      )
      assert.equal(values.length, 15)
      const after = await evaluate(() =>
        [...document.querySelectorAll('.setting-toggle')].map((el) =>
          el.querySelector('[role="switch"]').getAttribute('aria-checked')
        )
      )
      assert.ok(values.every((value, index) => value.name && value.before !== after[index]))
      assert.equal(await evaluate(() => localStorage.getItem('fileOpration')), 'true')
      await screenshotCard(title, 'dark-on')
      await evaluate(() =>
        document.querySelector('[aria-label="启用深色主题"]').closest('.setting-toggle').click()
      )
      await screenshotCard(title, 'light-on')
    })
    await test('switches support keyboard input and visible focus', async () => {
      await evaluate(() => {
        const input = document.querySelector('[aria-label="允许 Agent 操作文件"]')
        input.scrollIntoView({ block: 'center' })
        input.focus()
      })
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
      await waitFor(() => evaluate(() => localStorage.getItem('fileOpration') === 'false'))
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      await waitFor(() => evaluate(() => localStorage.getItem('fileOpration') === 'true'))
      const focus = await evaluate(() => {
        const input = document.activeElement
        const style = getComputedStyle(
          input.closest('.setting-toggle').querySelector('.el-switch__core')
        )
        return {
          role: input.getAttribute('role'),
          visible: input.matches(':focus-visible'),
          outline: style.outlineStyle,
          shadow: style.boxShadow
        }
      })
      assert.ok(
        focus.role === 'switch' && (focus.outline !== 'none' || focus.shadow !== 'none'),
        JSON.stringify(focus)
      )
      await screenshotCard(title, 'keyboard-focus')
    })
    await test('pointer press and release keeps the switch readable', async () => {
      const point = await evaluate(() => {
        const core = document
          .querySelector('[aria-label="允许 Agent 操作文件"]')
          .closest('.setting-toggle')
          .querySelector('.el-switch__core')
        const rect = core.getBoundingClientRect()
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
      })
      window.webContents.sendInputEvent({
        type: 'mouseDown',
        button: 'left',
        clickCount: 1,
        ...point
      })
      await screenshotCard(title, 'pointer-pressed')
      window.webContents.sendInputEvent({
        type: 'mouseUp',
        button: 'left',
        clickCount: 1,
        ...point
      })
      await waitFor(() => evaluate(() => localStorage.getItem('fileOpration') === 'false'))
      await screenshotCard(title, 'light-off')
    })

    await test('proxy exclusions persist after renderer reload', async () => {
      await fill(
        'input[placeholder="localhost,127.0.0.1,expmale.com"]',
        'localhost,127.0.0.1,example.test'
      )
      await clickCard('全局代理排除以下地址', 'button')
      await waitFor(() => calls.some((call) => call.name === 'api:set_proxy'))
      assert.equal(
        await evaluate(() => localStorage.getItem('excludeUrl')),
        'localhost,127.0.0.1,example.test'
      )
      window.webContents.reload()
      await waitFor(() =>
        evaluate(
          () =>
            document.querySelector('input[placeholder="localhost,127.0.0.1,expmale.com"]')
              ?.value === 'localhost,127.0.0.1,example.test'
        )
      )
    })
    await test('saving a desktop switch preserves the unsaved sync form', async () => {
      await fill('input[placeholder="https://同步服务器"]', 'https://draft.example.test')
      await clickCard('开机静默启动', '.el-switch')
      await waitFor(() => calls.some((call) => call.name === 'system:settings:update'))
      assert.equal(
        await evaluate(
          () => document.querySelector('input[placeholder="https://同步服务器"]').value
        ),
        'https://draft.example.test'
      )
      assert.ok(
        calls
          .filter((call) => call.name === 'system:settings:update')
          .every((call) => !('sync' in call.args[0]))
      )
    })
    await test('out-of-order saves retain independent switch changes and sync drafts', async () => {
      holdSave = true
      await clickCard('开机静默启动', '.el-switch')
      await clickCard('自动续写与长任务', '.el-switch')
      await waitFor(() => pendingSaves.length === 2)
      pendingSaves.pop()()
      await waitFor(() =>
        evaluate(
          () =>
            [...document.querySelectorAll('.setting-card')]
              .find(
                (card) => card.querySelector('.setting-title')?.textContent === '自动续写与长任务'
              )
              .querySelector('[role="switch"]')
              .getAttribute('aria-disabled') === 'false'
        )
      )
      pendingSaves.pop()()
      await waitFor(() =>
        evaluate(
          () =>
            [...document.querySelectorAll('.setting-card')]
              .find((card) => card.querySelector('.setting-title')?.textContent === '开机静默启动')
              .querySelector('[role="switch"]')
              .getAttribute('aria-disabled') === 'false'
        )
      )
      assert.equal(
        await evaluate(() =>
          [...document.querySelectorAll('.setting-card')]
            .find(
              (card) => card.querySelector('.setting-title')?.textContent === '自动续写与长任务'
            )
            .querySelector('[role="switch"]')
            .getAttribute('aria-checked')
        ),
        'false'
      )
      assert.equal(
        await evaluate(
          () => document.querySelector('input[placeholder="https://同步服务器"]').value
        ),
        'https://draft.example.test'
      )
      holdSave = false
    })
    await test('failed desktop setting saves restore the saved state and show an error', async () => {
      failSave = true
      await clickCard('API 密钥保护', '.el-switch')
      await waitFor(() =>
        evaluate(() =>
          [...document.querySelectorAll('.el-message--error')].some((el) =>
            el.textContent.includes('设置保存失败')
          )
        )
      )
      assert.equal(
        await evaluate(() =>
          [...document.querySelectorAll('.setting-card')]
            .find((card) => card.querySelector('.setting-title')?.textContent === 'API 密钥保护')
            .querySelector('[role="switch"]')
            .getAttribute('aria-checked')
        ),
        'false'
      )
      failSave = false
    })
    await test('all switch states survive a renderer restart', async () => {
      const states = () =>
        evaluate(() =>
          [...document.querySelectorAll('.setting-toggle input')].map((input) => ({
            label: input.getAttribute('aria-label'),
            checked: input.getAttribute('aria-checked')
          }))
        )
      const before = await states()
      const loaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
      window.webContents.reload()
      await loaded
      await waitFor(() =>
        evaluate(() => document.querySelectorAll('.setting-toggle').length === 15)
      )
      assert.deepEqual(await states(), before)
    })
    await test('reduced motion disables switch transitions', async () => {
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
      })
      assert.ok(
        await evaluate(() => {
          const seconds = getComputedStyle(
            document.querySelector('.setting-toggle .el-switch__action')
          )
            .transitionDuration.split(',')
            .map(parseFloat)
          return (
            matchMedia('(prefers-reduced-motion: reduce)').matches &&
            seconds.every((value) => value <= 0.00001)
          )
        })
      )
    })
    await test('settings display the packaged version', async () => {
      const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
      assert.equal(
        await evaluate(() => document.querySelector('.version-tag').textContent),
        version
      )
    })
    await test('renderer has no unexpected errors', () => assert.deepEqual(errors, []))
  } catch (error) {
    results.push({ name: 'settings harness', passed: false, error: error.stack })
  } finally {
    writeFileSync(join(artifacts, 'results.json'), JSON.stringify({ results, errors }, null, 2))
    app.exit(results.some((result) => !result.passed) ? 1 : 0)
  }
})
