import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const base = process.env.OPENSTARRY_MOBILE_URL || 'http://127.0.0.1:5178'
const shots = '../../tmp/mobile-gui-20260919'
await mkdir(shots, { recursive: true })
const navigate = name => page.getByRole('navigation', { name: '主要导航' }).getByRole('button', { name, exact: true }).click()
const fits = selector => page.locator(selector).evaluate(element => {
  const box = element.getBoundingClientRect()
  return element.scrollWidth <= element.clientWidth + 1 && box.left >= -1 && box.right <= innerWidth + 1
})
try {
  await page.goto(base)
  await page.getByText('这次想聊点什么？').waitFor()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.screenshot({ path: shots + '/welcome.png' })
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await page.getByRole('heading', { name: 'LLM 供应商' }).waitFor()
  await page.getByRole('button', { name: '添加供应商', exact: true }).click()
  const editor = page.getByRole('dialog')
  await editor.getByLabel('供应商名称').fill('QA Mobile')
  await editor.getByLabel('OpenAI 兼容接口地址').fill('http://127.0.0.1:8766/v1')
  await editor.getByLabel('模型 ID（每行一个）').fill('fixture-model')
  await editor.getByLabel('描述（选填）').fill('和电脑使用相同的模型，继续未完成的想法。')
  await editor.getByRole('button', { name: '获取并合并模型列表' }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(node => node.value.includes('second-model')))
  await editor.getByRole('button', { name: '保存供应商' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByText('QA Mobile', { exact: true }).waitFor()
  await expect(page.locator('.toast')).not.toHaveClass(/visible/, { timeout: 7000 })
  await page.screenshot({ path: shots + '/providers.png' })
  await page.getByRole('button', { name: '开始聊天', exact: true }).click()
  await page.getByLabel('消息', { exact: true }).fill('手机界面验收')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await page.getByText('收到：手机界面验收', { exact: true }).waitFor()
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor()
  await page.screenshot({ path: shots + '/chat.png' })

  // Navigation keeps the chat draft and composer configuration alive.
  await page.getByLabel('消息', { exact: true }).fill('留在聊天栏的草稿')
  await navigate('设置')
  await page.getByRole('heading', { name: '界面设置' }).waitFor()
  await page.screenshot({ path: shots + '/settings.png' })
  await page.getByRole('switch', { name: '深色外观' }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await navigate('聊天')
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('留在聊天栏的草稿')
  await page.screenshot({ path: shots + '/chat-dark.png' })
  await page.getByRole('button', { name: '供应商与模型设置' }).click()
  await page.getByRole('dialog').getByLabel('模型 ID（每行一个）').fill('fixture-model\nsecond-model\nmanual-model')
  await page.getByRole('dialog').getByRole('button', { name: '保存供应商' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  assert.ok((await page.getByLabel('聊天模型').textContent()).includes('manual-model'))
  await page.getByLabel('聊天模型').selectOption({ label: 'second-model' })
  await page.reload()
  await page.getByRole('button', { name: '打开聊天记录' }).click()
  await expect(page.locator('.workspace')).toHaveAttribute('inert', '')
  await page.getByRole('button', { name: '手机界面验收', exact: true }).click()
  await page.getByText('收到：手机界面验收', { exact: true }).waitFor()
  assert.equal(await page.locator('.message-new').count(), 0, 'history must not replay entry animations')
  assert.ok((await page.getByLabel('聊天模型').inputValue()).includes('second-model'))
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await navigate('设置')
  await page.getByRole('switch', { name: '深色外观' }).uncheck()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  for (const width of [320, 360, 390, 768, 1040]) {
    await page.setViewportSize({ width, height: 844 })
    for (const view of ['聊天', '供应商', '设置']) {
      await navigate(view)
      assert.ok(await fits('.view-panel:not([hidden])'), `${view} fits at ${width}`)
      assert.ok(await fits('.bottom-nav'), `navigation fits at ${width}`)
    }
    await navigate('供应商')
    await page.getByRole('button', { name: '编辑 QA Mobile' }).click()
    assert.ok(await fits('.settings-dialog'), `editor fits at ${width}`)
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }

  // Simulate the WebView resizing for an on-screen keyboard, without claiming native IME coverage.
  await page.setViewportSize({ width: 390, height: 844 })
  await navigate('聊天')
  await page.getByLabel('消息', { exact: true }).fill('键盘弹出后仍可输入')
  await page.setViewportSize({ width: 390, height: 420 })
  await expect(page.locator('.app-shell')).toHaveClass(/keyboard-open/)
  assert.ok(await page.locator('.composer').evaluate(node => node.getBoundingClientRect().bottom <= visualViewport.height + 1))
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '供应商与模型设置' }).click()
  await page.getByRole('dialog').getByLabel('模型 ID（每行一个）').fill('fixture-model\nsecond-model\nmanual-model')
  assert.ok(await page.locator('.dialog-footer').evaluate(node => node.getBoundingClientRect().bottom <= visualViewport.height + 1))
  await page.screenshot({ path: shots + '/editor-keyboard.png' })
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('消息', { exact: true }).fill('')
  await page.getByLabel('消息', { exact: true }).blur()
  const longMessage = Array.from({ length: 35 }, (_, i) => `滚动验证第 ${i + 1} 行：保留正在阅读的位置。`).join('\n')
  await page.getByLabel('消息', { exact: true }).fill(longMessage)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor()
  let releaseAnswer
  await page.route('**/v1/chat/completions', route => new Promise(resolve => {
    releaseAnswer = async () => {
      await route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ choices: [{ delta: { content: '延迟回答已完成' } }] }) + '\n\ndata: [DONE]\n\n' })
      resolve()
    }
  }))
  await page.getByLabel('消息', { exact: true }).fill('继续，但保留我的阅读位置')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect.poll(() => Boolean(releaseAnswer)).toBe(true)
  await page.locator('.messages').evaluate(node => { node.scrollTop = 0 })
  await releaseAnswer()
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor()
  assert.ok(await page.locator('.messages').evaluate(node => node.scrollTop < 10), 'completion does not interrupt reading older messages')
  await page.unroute('**/v1/chat/completions')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: '供应商与模型设置' }).click()
  assert.ok(await page.getByRole('dialog').evaluate(node => parseFloat(getComputedStyle(node).animationDuration) < .01))
  await page.getByRole('dialog').getByLabel('供应商名称').fill('很长的供应商名称'.repeat(5))
  await page.getByRole('dialog').getByLabel('描述（选填）').fill('较长的描述，用于检查卡片能否完整容纳内容。'.repeat(15))
  await page.getByRole('dialog').getByLabel('模型 ID（每行一个）').fill('model-with-an-extremely-long-name-for-small-phone-widths')
  await page.getByRole('dialog').getByRole('button', { name: '保存供应商' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.setViewportSize({ width: 320, height: 700 })
  assert.ok(await fits('.composer'), 'long model names stay inside the composer')
  await navigate('供应商')
  assert.ok(await fits('.provider-card'), 'long provider text stays inside the card')
  assert.ok(await page.locator('.provider-card').evaluate(card => {
    const bounds = card.getBoundingClientRect()
    return [...card.querySelectorAll('button, .provider-footer, .endpoint-tag')].every(node => {
      const rect = node.getBoundingClientRect()
      return rect.right <= bounds.right + 1 && rect.bottom <= bounds.bottom + 1
    })
  }))
  assert.deepEqual(errors, [])
  console.log('PASS: chat/history, composer and provider editing, theme/model persistence, drafts across tabs, 5 responsive widths, resized keyboard viewport, reduced motion; no renderer errors')
} catch (error) {
  await page.screenshot({ path: shots + '/failure.png' })
  console.log((await page.locator('body').innerText()).slice(0, 3000))
  throw error
} finally { await browser.close() }
