import { chromium, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { verifyReasoningMotion } from './reasoningMotion.mjs'
import { verifyChatTabs, verifyQuestionTabs } from './chatTabs.mjs'

const event = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
const bodies = [], errors = []
let continueFinal, connectionClosed = false
const fixture = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', '*')
  if (request.method === 'OPTIONS') { response.end(); return }
  let text = ''; for await (const chunk of request) text += chunk
  const body = JSON.parse(text); bodies.push(body)
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const prompt = body.messages.findLast(message => message.role === 'user')?.content || ''
  if (prompt.includes('标签提问测试')) {
    if (body.messages.at(-1).role === 'tool') response.end(event({ content: '已收到标签内回答' }, 'stop') + 'data: [DONE]\n\n')
    else response.end(event({ tool_calls: [{ index: 0, id: 'fixture-question', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '继续当前标签的任务吗？', options: ['继续'] }) } }] }, 'tool_calls') + 'data: [DONE]\n\n')
    return
  }
  if (prompt.includes('停止测试')) {
    response.on('close', () => { connectionClosed = true })
    response.write(event({ content: '这一段已保留。' })); return
  }
  if (body.messages.at(-1).role === 'tool') {
    response.write(event({ content: '第一段已经流式到达。\n\n' }))
    await new Promise(resolve => { continueFinal = resolve; response.on('close', resolve) })
    if (!response.destroyed) response.end(event({ content: '第二段结束，结果可在工具详情查看。' }, 'stop') + 'data: [DONE]\n\n')
  } else {
    response.write(event({ reasoning_content: '先检查运行结果。' }))
    response.write(event({ content: '我会运行当前项目。' }))
    response.write(event({ tool_calls: [{ index: 0, id: 'fixture-run', type: 'function', function: { name: 'run_project', arguments: '{"command":' } }] }))
    await delay(80)
    response.end(event({ tool_calls: [{ index: 0, function: { arguments: '"main.js"}' } }] }, 'tool_calls') + 'data: [DONE]\n\n')
  }
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${fixture.address().port}/v1`
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', error => errors.push(error.message))
const baseUrl = process.env.OPENSTARRY_STREAM_UI_URL || 'http://127.0.0.1:5180'
const mobileHost = process.env.OPENSTARRY_STREAM_MOBILE === '1'
const shots = '../../tmp/ide-streaming-20260921'; await mkdir(shots, { recursive: true })
const panel = name => page.getByRole('navigation', { name: 'IDE 面板' }).getByRole('button', { name, exact: true }).click()
const send = async text => { await page.getByLabel('项目 Agent 消息').fill(text); await page.getByRole('button', { name: '发送', exact: true }).click() }
try {
  await page.goto(baseUrl)
  await page.evaluate(({ endpoint, mobileHost }) => {
    localStorage.setItem('openstarry.agent.tools.v1', JSON.stringify({ enabled: true, files: true, execute: true, autoContinue: true, showTools: true }))
    localStorage.setItem('openstarry.ide.theme', 'light')
    if (!mobileHost) localStorage.setItem('openstarry.ide.demo.provider', JSON.stringify({ name: 'Stream fixture', endpoint, models: ['6 Astra', 'second-model'], model: '6 Astra' }))
  }, { endpoint, mobileHost })
  await page.reload()
  if (mobileHost) {
    await page.getByRole('navigation', { name: '主要导航' }).getByRole('button', { name: '供应商', exact: true }).click()
    await page.getByRole('button', { name: '添加供应商', exact: true }).click()
    await page.getByLabel('供应商名称').fill('Stream fixture')
    await page.getByLabel('OpenAI 兼容接口地址').fill(endpoint)
    await page.getByLabel('模型 ID（每行一个）').fill('6 Astra\nsecond-model')
    await page.getByRole('button', { name: '保存供应商' }).click()
    await page.getByRole('navigation', { name: '主要导航' }).getByRole('button', { name: 'IDE', exact: true }).click()
  }
  await page.getByRole('button', { name: '新建项目', exact: true }).first().click()
  await page.getByRole('dialog').getByLabel('回答或补充说明').fill('流式与工具验证')
  await page.getByRole('dialog').getByRole('button', { name: '提交回答' }).click()
  await panel('项目'); await expect(page.locator('.os-center')).toBeHidden(); await expect(page.getByLabel('打开文件 main.js')).toBeVisible()
  await panel('代码'); await expect(page.locator('.cm-content')).toContainText('Hello, OpenStarry!')
  await panel('审查'); await expect(page.locator('.os-review-empty')).toContainText('没有待审查修改')
  await panel('代码'); await page.locator('.cm-content').fill('console.log("LIVE_TOOL_OUTPUT");\n')
  await panel('审查'); await expect(page.locator('.os-diff-count')).toContainText('+1'); await expect(page.locator('.os-review-file')).toContainText('main.js')
  await page.getByRole('button', { name: '保存修改', exact: true }).click(); await expect(page.locator('.os-review-empty')).toBeVisible()
  await panel('Agent')
  const effort = page.getByRole('button', { name: '思考等级', exact: true })
  await expect(effort).toHaveAttribute('data-value', 'medium')
  await effort.click(); await page.getByRole('button', { name: 'Ultra', exact: true }).click()
  await expect(page.getByRole('slider', { name: '思考等级滑杆' })).toHaveAttribute('aria-valuetext', 'Ultra')
  await verifyReasoningMotion(page, shots, mobileHost ? 'mobile-host' : 'desktop')
  await page.screenshot({ path: `${shots}/${mobileHost ? 'mobile-host' : 'desktop'}-ultra.png`, animations: 'disabled' })
  await page.getByRole('slider').press('Escape'); await expect(effort).toBeFocused()
  await send('运行并说明结果')
  await expect(page.getByLabel('项目 Agent 对话')).toContainText('第一段已经流式到达', { timeout: 15000 })
  await expect(page.locator('.os-agent').getByRole('button', { name: '停止', exact: true })).toBeVisible()
  assert.equal(bodies[0].stream, true); assert.equal(bodies[0].reasoning_effort, 'ultra')
  assert.equal(bodies[1].reasoning_effort, 'ultra')
  const tool = page.locator('.os-tool-event').last()
  await tool.locator('summary').click(); await expect(tool.locator('.os-tool-details')).toContainText('输入参数')
  await expect(tool.locator('.os-tool-details')).toContainText('LIVE_TOOL_OUTPUT'); await expect(tool.locator('.os-tool-details')).toContainText('exitCode')
  await tool.evaluate(element => { element.dataset.identityCheck = 'same-node' })
  await page.getByLabel('项目 Agent 对话').evaluate(element => { element.style.maxHeight = '160px'; element.scrollTop = 0 })
  await verifyChatTabs(page, continueFinal, shots, mobileHost ? 'mobile-host' : 'desktop')
  continueFinal()
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
  await expect(tool).toHaveAttribute('open', ''); await expect(tool).toHaveAttribute('data-identity-check', 'same-node')
  await expect(page.getByLabel('项目 Agent 对话')).toContainText('第二段结束')
  assert.equal(await page.getByLabel('项目 Agent 对话').evaluate(element => element.scrollTop), 0, 'streaming preserves a reader scrolling up')
  await page.getByLabel('项目 Agent 对话').evaluate(element => { element.style.maxHeight = '' })
  await page.screenshot({ path: `${shots}/${mobileHost ? 'mobile-host' : 'desktop'}-tools.png`, animations: 'disabled' })
  await page.getByLabel('项目 Agent 消息').fill('会话草稿保留')
  await page.getByRole('button', { name: '新的项目对话' }).click()
  await page.getByRole('button', { name: '会话历史' }).click()
  await page.locator('.os-chat-history').getByRole('button', { name: '运行并说明结果', exact: true }).click()
  await expect(page.getByLabel('项目 Agent 消息')).toHaveValue('会话草稿保留')
  await page.reload()
  if (mobileHost) await page.getByRole('navigation', { name: '主要导航' }).getByRole('button', { name: 'IDE', exact: true }).click()
  await panel('Agent')
  await expect(page.getByRole('tablist', { name: '聊天标签页' }).getByRole('tab')).toHaveCount(4)
  await expect(page.getByLabel('项目 Agent 消息')).toHaveValue('会话草稿保留')
  await expect(effort).toHaveAttribute('data-value', 'ultra')
  await expect(page.getByLabel('项目 Agent 对话')).toContainText('第二段结束')
  await page.getByRole('combobox', { name: '项目 Agent 模型' }).click(); await page.getByRole('option', { name: 'second-model', exact: true }).click()
  await expect(effort).toHaveAttribute('data-value', 'medium')
  await send('停止测试')
  await expect(page.getByLabel('项目 Agent 对话')).toContainText('这一段已保留')
  await page.locator('.os-agent').getByRole('button', { name: '停止', exact: true }).click()
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
  await expect(page.getByLabel('项目 Agent 对话')).toContainText('Agent 已停止')
  await expect.poll(() => connectionClosed).toBe(true)
  await verifyQuestionTabs(page)
  for (const width of [320, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    for (const name of ['项目', '代码', '审查', '输出', 'Agent']) {
      await panel(name)
      assert.ok(await page.locator('.os-ide').evaluate(element => element.scrollWidth <= element.clientWidth + 1), name + ' fits ' + width)
    }
    await effort.click()
    const rect = await page.locator('.os-reasoning-popup').boundingBox()
    assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1 && rect.y >= 0 && rect.y + rect.height <= 845, 'effort popup fits ' + width)
    await page.getByRole('slider').press('End'); await page.getByRole('slider').press('Escape')
    const strip = await page.locator('.os-agent-sessionbar').boundingBox(), history = await page.getByRole('button', { name: '会话历史' }).boundingBox()
    assert.ok(history.y >= strip.y && history.y + history.height <= strip.y + strip.height + 1)
    if (width === 390) {
      await effort.click(); await page.screenshot({ path: `${shots}/${mobileHost ? 'mobile-host' : 'shared'}-390.png`, animations: 'disabled' }); await page.getByRole('slider').press('Escape')
    }
  }
  await page.setViewportSize({ width: 390, height: 420 }); await panel('Agent')
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport()
  await page.emulateMedia({ reducedMotion: 'reduce' }); await effort.click()
  assert.equal(await page.locator('.os-reasoning-track').evaluate(element => getComputedStyle(element).animationName), 'none')
  assert.deepEqual(errors, [])
  console.log('PASS: live SSE before EOF, real tool results, stable details, cancellation, local history/drafts, per-model effort, 5 widths, reduced motion; host=' + baseUrl)
} finally { continueFinal?.(); await browser.close(); fixture.closeAllConnections(); fixture.close() }
