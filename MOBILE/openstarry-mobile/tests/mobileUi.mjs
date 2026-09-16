import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const base = process.env.OPENSTARRY_MOBILE_URL || 'http://127.0.0.1:5178'
await mkdir('../../tmp/qa-ui', { recursive: true })
try {
  await page.goto(base)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '＋ 添加供应商', exact: true }).click()
  const editor = page.getByRole('dialog').last()
  await editor.getByLabel('供应商名称').fill('QA Mobile')
  await editor.getByLabel('OpenAI 兼容接口地址').fill('http://127.0.0.1:8766/v1')
  await editor.getByLabel('模型 ID（每行一个）').fill('fixture-model')
  await editor.getByRole('button', { name: '获取并合并模型列表' }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(node => node.value.includes('second-model')))
  await editor.getByRole('button', { name: '保存供应商' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await page.getByRole('dialog').last().getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByLabel('消息', { exact: true }).fill('手机界面验收')
  await page.getByRole('button', { name: '发送 ↑' }).click()
  await page.getByText('收到：手机界面验收', { exact: true }).waitFor()
  await page.getByRole('button', { name: '发送 ↑' }).waitFor()
  await page.screenshot({ path: '../../tmp/qa-ui/mobile-chat.png' })
  await page.reload()
  await page.getByRole('button', { name: '☰', exact: true }).click()
  await page.getByRole('button', { name: '手机界面验收', exact: true }).click()
  await page.getByText('收到：手机界面验收', { exact: true }).waitFor()
  assert.equal(await page.locator('.message-new').count(), 0, 'restored messages do not replay arrival motion')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: /QA Mobile.*编辑/ }).click()
  const edit = page.getByRole('dialog').last()
  await edit.getByLabel('模型 ID（每行一个）').fill('fixture-model\nsecond-model\nmanual-model')
  await edit.getByRole('button', { name: '保存供应商' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await page.getByRole('dialog').last().getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  assert.ok((await page.getByLabel('聊天模型').textContent()).includes('manual-model'))
  for (const width of [360, 390, 768]) {
    await page.setViewportSize({ width, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no overflow at ${width}`)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    assert.ok(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `settings at ${width}`)
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  assert.ok(await page.getByRole('dialog').evaluate(el => parseFloat(getComputedStyle(el).animationDuration) < .01))
  assert.deepEqual(errors, [])
  console.log('PASS: phone chat, persisted history, provider/model editing, 3 responsive widths, reduced motion, no renderer errors')
} catch (error) {
  console.log(await page.locator('body').innerText());
  await page.screenshot({path:'../../tmp/qa-ui/mobile-failure.png'}); throw error
} finally { await browser.close() }
