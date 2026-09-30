import { expect } from '@playwright/test'
import assert from 'node:assert/strict'

// Start while the first conversation is streaming, with its tool details open.
export async function verifyChatTabs(page, finishReply, shots, host) {
  const list = page.getByRole('tablist', { name: '聊天标签页' })
  const input = page.getByLabel('项目 Agent 消息')
  const chat = page.getByLabel('项目 Agent 对话')
  const add = page.getByRole('button', { name: '新的项目对话' })
  const activeId = () => list.getByRole('tab', { selected: true }).getAttribute('data-chat-id')
  const tab = id => list.locator(`[role=tab][data-chat-id="${id}"]`)
  const close = id => tab(id).locator('..').getByRole('button', { name: /^关闭对话 / }).click()
  const first = await activeId()
  await expect(list.getByRole('tab')).toHaveCount(1)
  await add.click(); const second = await activeId()
  await input.fill('第二个聊天的草稿')
  await page.getByRole('combobox', { name: 'Agent 工作模式' }).click()
  await page.getByRole('option', { name: /^仅提问/ }).click()
  await page.getByRole('button', { name: '引用当前文件' }).click()
  await expect(list.getByRole('tab')).toHaveCount(2)
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  await expect(chat).not.toContainText('第一段已经流式到达')
  await expect(tab(first).locator('..')).toHaveAttribute('data-state', 'running')

  await add.click(); const third = await activeId(); await input.fill('第三个聊天的草稿')
  await tab(second).click(); await expect(input).toHaveValue('第二个聊天的草稿')
  await expect(page.getByRole('combobox', { name: 'Agent 工作模式' })).toHaveAttribute('data-value', 'ask')
  await expect(page.locator('.os-context-chips')).toContainText('main.js')
  await tab(third).click(); await expect(input).toHaveValue('第三个聊天的草稿')
  await expect(page.getByRole('combobox', { name: 'Agent 工作模式' })).toHaveAttribute('data-value', 'agent')
  await expect(page.locator('.os-context-chips')).toBeEmpty()

  // Closing a running tab keeps its stream attached to that conversation.
  await close(first); await expect(list.getByRole('tab')).toHaveCount(2)
  finishReply()
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  await expect(chat).not.toContainText('第二段结束')
  await expect(input).toHaveValue('第三个聊天的草稿')
  await page.getByRole('button', { name: '会话历史' }).click()
  await page.locator('.os-chat-history').getByRole('button', { name: '运行并说明结果', exact: true }).click()
  await expect(list.getByRole('tab')).toHaveCount(3)
  await expect(chat).toContainText('第二段结束')
  await expect(page.locator('.os-tool-event').last()).toHaveAttribute('open', '')
  assert.equal(await chat.evaluate(element => element.scrollTop), 0, 'tab switching restores the reader position')

  // Roving keyboard focus, and reopening an already-open history entry.
  await tab(first).focus(); await tab(first).press('Home')
  await expect(tab(second)).toBeFocused(); await expect(tab(second)).toHaveAttribute('aria-selected', 'true')
  await tab(second).press('ArrowRight'); await expect(tab(third)).toBeFocused()
  await page.getByRole('button', { name: '会话历史' }).click()
  await page.locator('.os-chat-history').getByRole('button', { name: '运行并说明结果', exact: true }).click()
  await expect(list.getByRole('tab')).toHaveCount(3)

  const viewport = page.viewportSize()
  await chat.evaluate(element => { element.style.maxHeight = '' })
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    await page.getByRole('navigation', { name: 'IDE 面板' }).getByRole('button', { name: 'Agent', exact: true }).click()
    assert.ok(await page.locator('.os-ide').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'chat tabs fit ' + width)
    await expect(add).toBeInViewport()
    await expect(page.getByRole('button', { name: '会话历史' })).toBeInViewport()
    await expect.poll(async () => {
      const visible = await list.boundingBox(), selected = await tab(first).locator('..').boundingBox()
      return selected.x >= visible.x - 1 && selected.x + selected.width <= visible.x + visible.width + 1
    }).toBe(true)
    if (width === 390 || width === 1440) await page.screenshot({ path: `${shots}/${host}-chat-tabs-${width}.png`, animations: 'disabled' })
  }
  await page.setViewportSize(viewport)
  console.log('PASS: browser-style tabs, separate drafts/references/modes, close/reopen, background stream routing, stable details/scroll, keyboard, 4 widths')
}

export async function verifyQuestionTabs(page) {
  const add = page.getByRole('button', { name: '新的项目对话' })
  const input = page.getByLabel('项目 Agent 消息')
  const list = page.getByRole('tablist', { name: '聊天标签页' })
  const question = page.locator('.os-question-dock .os-dialog')
  await add.click(); await input.fill('标签提问测试')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(question).toContainText('继续当前标签的任务吗？')
  const first = list.getByRole('tab', { name: '标签提问测试', exact: true })
  await expect(first.locator('..')).toHaveAttribute('data-state', 'waiting')
  await add.click(); await input.fill('提问期间的另一份草稿')
  await expect(question).toBeHidden(); await expect(input).toBeFocused()
  await first.click(); await expect(question).toBeVisible()
  await question.getByRole('button', { name: '继续', exact: true }).click()
  await question.getByRole('button', { name: '提交回答' }).click()
  await expect(page.getByLabel('项目 Agent 对话')).toContainText('已收到标签内回答')
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  await list.getByRole('tab', { name: '提问期间的另一份草稿', exact: true }).click()
  await expect(input).toHaveValue('提问期间的另一份草稿')
  await expect(page.getByLabel('项目 Agent 对话')).not.toContainText('已收到标签内回答')
  console.log('PASS: question cards stay with their chat, hidden questions do not steal focus, answers resume the original task')
}
