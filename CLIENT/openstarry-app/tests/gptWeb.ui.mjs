import { _electron as electron, expect } from '../../../MOBILE/openstarry-mobile/node_modules/@playwright/test/index.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const shots = resolve('../../tmp/gpt-web-ui-20260924'); await mkdir(shots, { recursive: true })
const application = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('../../tmp/gpt-web-ui-20260924/main.cjs')], cwd: process.cwd() })
try {
  const page = await application.firstWindow(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByLabel('代码编辑区').getByRole('button', { name: '新建项目', exact: true }).click()
  await page.getByLabel('回答或补充说明').fill('GPT 网页版桌面验证')
  await page.getByRole('button', { name: '提交回答', exact: true }).click()
  await page.getByRole('navigation', { name: 'IDE 面板' }).getByRole('button', { name: 'Agent', exact: true }).click()
  await page.getByRole('combobox', { name: 'Agent 来源', exact: true }).click()
  await page.getByRole('option', { name: 'GPT 网页版', exact: true }).click()
  await expect(page.getByRole('button', { name: '思考等级', exact: true })).toBeHidden()
  await page.getByRole('button', { name: '连接 / 登录', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'GPT 网页版连接' })).toBeVisible()
  await page.getByRole('button', { name: '连接 Edge / 复制配对码' }).click()
  await expect(page.getByRole('status').filter({ hasText: '模拟适配器' })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  const input = page.getByLabel('项目 Agent 消息')
  await input.fill('保持生成，验证首段与停止')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.os-role-assistant .os-message-content').last()).toContainText('桌面链路的中文增量')
  await expect(page.locator('.os-role-assistant').last()).toHaveAttribute('data-status', 'running')
  await page.screenshot({ path: resolve(shots, 'streaming.png') })
  await page.getByRole('button', { name: '新的项目对话', exact: true }).click()
  await input.fill('第二个标签的草稿')
  await page.getByRole('tab', { name: /保持生成/ }).click()
  // Wait for the asynchronous IndexedDB commit before simulating a page restart.
  await expect.poll(() => page.evaluate(async () => {
    const { projectStore } = await import('/src/model.js')
    const value = await projectStore.load(localStorage.getItem('openstarry.ide.active'))
    return value?.chat?.some(message => message.web) && value.chatSessions.some(session => session.draft === '第二个标签的草稿')
  })).toBe(true)
  await page.reload()
  await page.getByRole('navigation', { name: 'IDE 面板' }).getByRole('button', { name: 'Agent', exact: true }).click()
  await page.getByRole('button', { name: '恢复回复', exact: true }).click()
  await expect(page.locator('button[aria-label="停止"]')).toBeEnabled()
  await page.locator('button[aria-label="停止"]').click()
  await expect(page.locator('.os-role-assistant').last()).toHaveAttribute('data-status', 'stopped')
  await page.getByRole('tab', { name: /第二个标签的草稿/ }).click()
  await expect(input).toHaveValue('第二个标签的草稿')
  for (const width of [800, 1040, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.getByRole('combobox', { name: 'Agent 来源', exact: true })).toBeVisible()
    await page.screenshot({ path: resolve(shots, 'layout-' + width + '.png') })
  }
  if (errors.length) throw Error(errors.join('\n'))
  console.log('PASS: Electron IPC -> MCP fixture -> authenticated SSE -> IDE; first delta, source selector, tabs, reload/resume, confirmed stop and 800/1040/1440 layouts')
} catch (error) {
  const page = await application.firstWindow()
  await writeFile(resolve(shots, 'failure.txt'), await page.locator('body').innerText())
  await page.screenshot({ path: resolve(shots, 'failure.png') })
  throw error
} finally { await application.close() }
