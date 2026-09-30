// Opt-in acceptance against the visible ChatGPT page. Login stays with the user.
import {
  _electron as electron,
  expect
} from '../../../MOBILE/openstarry-mobile/node_modules/@playwright/test/index.mjs'
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const artifacts = resolve('../../tmp/home-web-live-20260925')
await mkdir(artifacts, { recursive: true })
const main = resolve(artifacts, 'main.cjs'),
  profile = resolve(artifacts, 'profile')
await build({
  entryPoints: ['tests/homeWeb.electron.mjs'],
  outfile: main,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'silent'
})
const application = await electron.launch({
  executablePath: resolve('node_modules/electron/dist/electron.exe'),
  args: [main],
  cwd: process.cwd(),
  env: {
    ...process.env,
    OPENSTARRY_WEB_ACCEPTANCE: 'live',
    OPENSTARRY_WEB_TEST_PROFILE: profile
  }
})
const report = {
  source: 'actual-homepage-renderer-with-real-chatgpt',
  unrelatedApiBackend: 'fixture',
  startedAt: new Date().toISOString(),
  steps: []
}
const record = async (step, evidence = {}) => {
  report.steps.push({ step, at: new Date().toISOString(), ...evidence })
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ step, ...evidence }))
}
try {
  const page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  const source = page.getByTestId('home-chat-source'),
    input = page.getByPlaceholder('Inputs...')
  await expect(source.getByRole('button', { name: 'GPT 网页版', exact: true })).toBeEnabled()
  await source.getByRole('button', { name: 'GPT 网页版', exact: true }).click()
  await source.getByRole('button', { name: '连接 Edge / 复制配对码', exact: true }).click()
  await expect(
    source.getByRole('button', { name: '连接 Edge / 复制配对码', exact: true })
  ).toBeEnabled({
    timeout: 80000
  })
  const connection = () =>
    application.evaluate(async () => {
      const service = globalThis.homeAcceptance.service
      if (!service.current) return { login: 'unknown' }
      const state = await service.status({ id: service.current.projectId })
      return { browser: state.browser, login: state.login, message: state.message }
    })
  let lastState
  // Login is user-paced. Keep the visible window open until login or explicit close.
  for (;;) {
    const state = await connection()
    if (state.login !== lastState) {
      await record('web-login-state', state)
      lastState = state.login
    }
    if (state.login === 'ready') break
    await delay(3000)
  }
  await source.getByRole('button', { name: '刷新连接', exact: true }).click()
  await page.locator('.ai-history-panel .create-btn').click()
  const prompt =
    '这是 OpenStarry 首页真实流式验收。请先写“首页连接测试开始”，然后用中文按编号写 20 条城市散步观察，每条约 30 字，最后写“首页连接测试结束”。只需正文。'
  await input.fill(prompt)
  await input.press('Enter')
  const answer = page.locator('.ai-bubble-wrapper .markdown-body.content').last()
  await expect(answer).toContainText('首页连接测试开始', { timeout: 180000 })
  const firstDeltaWhileRunning = await page.locator('.stop-generate-button').isVisible()
  await record('homepage-first-visible-delta', { whileRunning: firstDeltaWhileRunning })
  await page.screenshot({ path: resolve(artifacts, 'home-first-delta.png') })
  await expect(answer).toContainText('首页连接测试结束', { timeout: 180000 })
  await expect(page.locator('.web-reply-state').last()).toContainText('已完成', { timeout: 30000 })
  await record('homepage-completed', { characters: (await answer.innerText()).length })
  const tasks = await application.evaluate(async () => {
    const service = globalThis.homeAcceptance.service
    return (await service.admin('chat/tasks')).tasks.map((task) => ({
      id: task.id,
      status: task.status,
      delivery: task.delivery,
      webConversationId: task.webConversationId
    }))
  })
  await record('homepage-persisted-task', { tasks })
  expect(firstDeltaWhileRunning).toBe(true)
  await input.fill('请沿用刚才的散步话题，只回复“同一会话续聊成功”。')
  await input.press('Enter')
  await expect(answer).toContainText('同一会话续聊成功', { timeout: 180000 })
  await expect(page.locator('.web-reply-state').last()).toContainText('已完成', { timeout: 30000 })
  await record('homepage-followup-completed')
  await page.screenshot({ path: resolve(artifacts, 'home-complete.png') })
  report.passed = true
  await record('completed')
} catch (error) {
  report.passed = false
  await record('failed', {
    error: String(error).replace(/\/(?:adapter-)?mcp\/[\w-]+/g, '/mcp/[private]')
  })
  const page = application.windows().find((window) => !window.isClosed())
  if (page) {
    await writeFile(
      resolve(artifacts, 'failure.txt'),
      await page.locator('body').innerText()
    ).catch(() => {})
    await page.screenshot({ path: resolve(artifacts, 'failure.png') }).catch(() => {})
  }
  process.exitCode = 1
} finally {
  await application.close().catch(() => {})
}
