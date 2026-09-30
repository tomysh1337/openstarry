import {
  _electron as electron,
  expect
} from '../../../MOBILE/openstarry-mobile/node_modules/@playwright/test/index.mjs'
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const artifacts = resolve('../../tmp/home-web-ui-20260925')
await mkdir(artifacts, { recursive: true })
const main = resolve(artifacts, 'main.cjs')
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
  cwd: process.cwd()
})
const errors = []
try {
  const page = await application.firstWindow()
  page.setDefaultTimeout(10000)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const source = page.getByTestId('home-chat-source'),
    input = page.getByPlaceholder('Inputs...')
  await expect(source.getByRole('button', { name: 'GPT 网页版', exact: true })).toBeEnabled()
  await input.fill('API 来源的草稿')
  await source.getByRole('button', { name: 'GPT 网页版', exact: true }).click()
  await expect(source.getByRole('button', { name: 'GPT 网页版', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.getByRole('button', { name: '供应商与模型设置', exact: true })).toBeHidden()
  await expect(page.getByRole('button', { name: '上传文件', exact: true })).toBeHidden()
  await input.fill('网页来源的草稿')
  await source.getByRole('button', { name: 'API', exact: true }).click()
  await expect(input).toHaveValue('API 来源的草稿')
  await source.getByRole('button', { name: 'GPT 网页版', exact: true }).click()
  await expect(input).toHaveValue('网页来源的草稿')
  await source.getByRole('button', { name: '连接 Edge / 复制配对码', exact: true }).click()
  await expect(source.getByRole('status').filter({ hasText: '模拟适配器' })).toBeVisible()
  await input.fill('保持生成，首页真实界面验收')
  await input.press('Enter')
  await expect(page.locator('.message-list')).toContainText('桌面链路的中文增量')
  await expect(page.locator('.stop-generate-button')).toBeVisible()
  await page.screenshot({ path: resolve(artifacts, 'home-streaming.png') })
  // Wait for a real IndexedDB commit before restarting the renderer.
  const stored = () =>
    page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('openstarry-home-web', 1)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const read = db.transaction('sessions').objectStore('sessions').getAll()
            read.onsuccess = () => {
              db.close()
              resolve(read.result)
            }
            read.onerror = () => {
              db.close()
              reject(read.error)
            }
          }
        })
    )
  await expect
    .poll(async () =>
      (await stored()).some(
        (row) =>
          row.kind === 'chat' && row.turns?.[0]?.answer?.content?.includes('桌面链路的中文增量')
      )
    )
    .toBe(true)
  await page.reload()
  await source.getByRole('button', { name: '恢复回复', exact: true }).click()
  await expect(page.locator('.stop-generate-button')).toBeVisible()
  await page.locator('.stop-generate-button').click()
  await expect(source.getByRole('status').filter({ hasText: '已停止' })).toBeVisible()
  await expect(page.locator('.message-list')).toContainText('桌面链路的中文增量')
  await page.locator('.ai-history-panel .melt-btn').click()
  const card = page.locator('.q-card-wrapper').filter({ hasText: '保持生成，首页真实界面验收' })
  await card.locator('.q-icon-btn-star').click()
  await expect(card.locator('.q-star-badge-inline')).toBeVisible()
  await card.locator('.q-icon-btn-more').click()
  await page.getByRole('button', { name: '重新命名', exact: true }).click()
  await page.locator('.cd-mask textarea').fill('首页网页验收记录')
  await page.locator('.cd-mask').getByRole('button', { name: '确定', exact: true }).click()
  await expect(
    page.locator('.q-preview-text').filter({ hasText: '首页网页验收记录' })
  ).toBeVisible()
  for (const width of [800, 1040, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(source.getByRole('button', { name: 'GPT 网页版', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeInViewport()
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const history = document.querySelector('.ai-history-panel').getBoundingClientRect()
            const selectors = [
              '.home-chat-source',
              '.input-bar',
              '.message-item.human',
              '.ai-bubble-wrapper'
            ]
            return selectors.every((selector) => {
              const rect = document.querySelector(selector).getBoundingClientRect()
              return rect.left >= history.right - 1 && rect.right <= innerWidth + 1
            })
          }),
        { message: 'Chat content and controls must fit beside the expanded history panel' }
      )
      .toBe(true)
    await page.screenshot({ path: resolve(artifacts, 'home-' + width + '.png') })
  }
  await page
    .locator('.q-card-wrapper')
    .filter({ hasText: '首页网页验收记录' })
    .locator('.q-icon-btn-more')
    .click()
  await page.getByRole('button', { name: '删除记录', exact: true }).click()
  await page.locator('.cd-mask').getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.locator('.q-preview-text').filter({ hasText: '首页网页验收记录' })).toHaveCount(
    0
  )
  await expect
    .poll(async () =>
      (await stored()).some(
        (row) => row.kind === 'chat' && row.title === '首页网页验收记录' && row.deleted
      )
    )
    .toBe(true)
  await page.locator('.q-card-wrapper').filter({ hasText: 'API 验收历史' }).click()
  await expect(source.getByRole('button', { name: 'API', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.getByRole('button', { name: '供应商与模型设置', exact: true })).toBeVisible()
  const forbidden = await application.evaluate(() =>
    globalThis.homeAcceptance.calls.filter((call) => call.historyId)
  )
  expect(forbidden).toEqual([])
  await page.getByTitle('IDE 工作区', { exact: true }).click()
  await page.getByLabel('代码编辑区').getByRole('button', { name: '新建项目', exact: true }).click()
  await page.getByLabel('回答或补充说明').fill('实际 IDE 页面验收')
  await page.getByRole('button', { name: '提交回答', exact: true }).click()
  await page
    .getByRole('navigation', { name: 'IDE 面板' })
    .getByRole('button', { name: 'Agent', exact: true })
    .click()
  await page.getByRole('combobox', { name: 'Agent 来源', exact: true }).click()
  await page.getByRole('option', { name: 'GPT 网页版', exact: true }).click()
  await page.getByLabel('项目 Agent 消息').fill('保持生成，实际 IDE 页面验收')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.os-role-assistant .os-message-content').last()).toContainText(
    '桌面链路的中文增量'
  )
  await expect(page.locator('.os-role-assistant').last()).toHaveAttribute('data-status', 'running')
  await page.locator('button[aria-label="停止"]').click()
  await expect(page.locator('.os-role-assistant').last()).toHaveAttribute('data-status', 'stopped')
  await page.screenshot({ path: resolve(artifacts, 'actual-ide-stopped.png') })
  expect(errors).toEqual([])
  await writeFile(
    resolve(artifacts, 'report.json'),
    JSON.stringify(
      {
        passed: true,
        finishedAt: new Date().toISOString(),
        renderer: 'actual homepage and IDE',
        webpage: 'fixture',
        apiBackend: 'fixture',
        checks: [
          'Enter send',
          'draft isolation',
          'streaming while running',
          'reload/resume',
          'confirmed stop',
          'star/rename/soft-delete',
          'API history isolation',
          '800/1040/1440 with no history overlap',
          'homepage-to-IDE project switch'
        ],
        errors
      },
      null,
      2
    )
  )
  console.log(
    'PASS: actual homepage and IDE renderers, production IPC/MCP/SSE with webpage fixture; Enter, source/draft isolation, streaming, reload/resume, stop, star/rename/soft-delete, API-history isolation, 3 widths and project switch'
  )
} catch (error) {
  const page = await application.firstWindow()
  await writeFile(
    resolve(artifacts, 'failure.txt'),
    JSON.stringify(
      { error: String(error), page: await page.locator('body').innerText(), errors },
      null,
      2
    )
  )
  await page.screenshot({ path: resolve(artifacts, 'failure.png') })
  throw error
} finally {
  await application.close()
}
