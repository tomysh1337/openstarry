import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
const errors = []; page.on('pageerror', error => errors.push(error.message))
const navigate = () => page.getByRole('navigation', { name: '主要导航' }).getByRole('button', { name: '设置', exact: true }).click()
const fits = input => input.evaluate(element => {
  const box = element.getBoundingClientRect(), row = element.closest('label').getBoundingClientRect()
  const track = getComputedStyle(element), thumb = getComputedStyle(element, '::after')
  const x = Number.parseFloat(thumb.left) + Number.parseFloat(track.borderLeftWidth) + new DOMMatrixReadOnly(thumb.transform).m41
  const y = Number.parseFloat(thumb.top) + Number.parseFloat(track.borderTopWidth)
  const w = Number.parseFloat(thumb.width), h = Number.parseFloat(thumb.height)
  return box.width > box.height && Number.parseFloat(track.borderRadius) >= box.height / 2
    && x >= 0 && y >= 0 && x + w <= box.width && y + h <= box.height
    && box.left >= row.left && box.right <= row.right && box.right <= innerWidth
})
try {
  await page.goto(process.env.OPENSTARRY_MOBILE_URL || 'http://127.0.0.1:5178')
  await navigate()
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 })
    for (const dark of [false, true]) {
      await page.getByRole('switch', { name: '深色外观' }).setChecked(dark)
      await expect(page.locator('html')).toHaveAttribute('data-theme', dark ? 'dark' : 'light')
      for (const input of await page.locator('.os-tool-row input').all()) {
        for (const checked of [false, true]) {
          await input.setChecked(checked)
          await expect.poll(() => fits(input)).toBe(true)
        }
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('switch', { name: '深色外观' }).uncheck()
  await page.getByRole('switch', { name: '启用工具调用' }).uncheck()
  await page.getByRole('switch', { name: '显示工具调用' }).focus()
  await page.getByRole('switch', { name: '显示工具调用' }).press('Space')
  await expect(page.getByRole('switch', { name: '显示工具调用' })).not.toBeChecked()
  await page.getByRole('button', { name: '保存 Agent 设置' }).click()
  await page.reload(); await navigate()
  await expect(page.getByRole('switch', { name: '启用工具调用' })).not.toBeChecked()
  await expect(page.getByRole('switch', { name: '显示工具调用' })).not.toBeChecked()
  await expect(page.getByRole('switch', { name: '自动续写' })).toBeChecked()
  await page.locator('.os-tool-row').filter({ has: page.getByRole('switch', { name: '启用工具调用' }) }).getByText('启用工具调用', { exact: true }).click()
  await expect(page.getByRole('switch', { name: '启用工具调用' })).toBeChecked()
  await mkdir('../../tmp/settings-switches', { recursive: true })
  await page.locator('.os-tools').evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: '../../tmp/settings-switches/mobile-light.png', animations: 'disabled' })
  assert.deepEqual(errors, [])
  console.log('PASS: switch thumbs remain inside pill tracks in both states, three widths and two themes; label/keyboard interaction and saved settings survive reload')
} finally { await browser.close() }
