import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
const require = createRequire(new URL('../../../MOBILE/openstarry-mobile/package.json', import.meta.url))
const { chromium, expect } = require('@playwright/test')
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + (process.env.OPENSTARRY_CDP_PORT || 9229))
const page = browser.contexts()[0].pages()[0]
const errors = []
page.on('pageerror', error => errors.push(error.message))
const shots = '../../tmp/qa-ui'
await mkdir(shots, { recursive: true })
try {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.waitForFunction(() => !document.querySelector('.startup-overlay'))
  await page.evaluate(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')
    if (!location.href.includes('/out/')) throw Error('Run this test only against an isolated source QA profile')
    store.current_history_id = '-1'
    location.hash = '/assistPage'
  })
  await page.getByPlaceholder('Inputs...').fill('QA 提问测试：先确认平台，然后继续项目')
  await page.getByPlaceholder('Inputs...').press('Enter')
  const dock = page.getByRole('region', { name: 'Agent 需要你回答' })
  await dock.waitFor({ timeout: 45000 })
  const bounds = await page.evaluate(() => {
    const card = document.querySelector('.question-dock').getBoundingClientRect()
    const input = document.querySelector('.input-bar').getBoundingClientRect()
    return { card: { x: card.x, width: card.width }, input: { x: input.x, width: input.width } }
  })
  assert.ok(bounds.card.width >= 760, JSON.stringify(bounds))
  assert.ok(Math.abs(bounds.card.width - bounds.input.width) < 2 && Math.abs(bounds.card.x - bounds.input.x) < 2)
  await page.screenshot({ path: shots + '/desktop-question-wide.png' })
  await dock.getByRole('button', { name: /手机与电脑/ }).click()
  await dock.getByRole('button', { name: '下一题', exact: true }).click()
  await dock.getByText('还有什么需要补充？', { exact: true }).waitFor()
  await expect(dock.getByRole('button', { name: '提交回答并继续' })).toBeEnabled()
  await dock.getByRole('button', { name: '提交回答并继续' }).click()
  await page.getByText('已收到你的选择，继续制作项目。', { exact: true }).waitFor({ timeout: 45000 })
  await expect(dock).toHaveCount(0)
  for (const width of [1440, 1040, 800]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.getByRole('menuitem', { name: '设置', exact: true }).click()
    await page.getByText('手机与跨设备同步', { exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelectorAll('.page-content .main-area').length === 1)
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('.setting-container, .setting-card, .settings-banner')].every(el => el.scrollWidth <= el.clientWidth + 1)))
    assert.ok(await page.locator('.page-content').isVisible())
    await page.getByRole('menuitem', { name: '智能体', exact: true }).click()
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await page.screenshot({ path: shots + '/desktop-settings.png' })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('menuitem', { name: '智能体', exact: true }).click()
  assert.equal(await page.evaluate(() => document.querySelector('.main-area').getAnimations().length), 0)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  assert.deepEqual(errors, [])
  console.log('PASS: wide aligned question card, optional comments, task resumes, responsive settings, route continuity and reduced motion')
} catch (error) {
  console.log((await page.locator('body').innerText()).slice(-4000))
  await page.screenshot({ path: shots + '/desktop-failure.png' })
  throw error
} finally { await browser.close() }
