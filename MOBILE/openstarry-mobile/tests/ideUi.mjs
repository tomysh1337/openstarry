import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const errors = []; page.on('pageerror', error => errors.push(error.message))
page.on('console', msg => { if (msg.type() === 'error') console.error(msg.text()) })
const navigate = name => page.getByRole('navigation', { name: '主要导航' }).getByRole('button', { name, exact: true }).click()
const panel = name => page.getByRole('navigation', { name: 'IDE 面板' }).getByRole('button', { name, exact: true }).click()
const question = async text => { const dialog = page.getByRole('dialog'); await dialog.getByLabel('回答或补充说明').fill(text); await dialog.getByRole('button', { name: '提交回答' }).click() }
const shots = '../../tmp/ide-20260919'; await mkdir(shots, { recursive: true })
try {
  await page.goto(process.env.OPENSTARRY_MOBILE_URL || 'http://127.0.0.1:5178')
  await page.getByText('这次想聊点什么？').waitFor()
  await navigate('IDE'); await page.getByRole('button', { name: '新建项目', exact: true }).first().click(); await question('IDE 验证项目')
  await expect(page.locator('.cm-content')).toContainText('Hello, OpenStarry!')
  await page.locator('.cm-content').fill('console.log("RUN_OK");\n')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await panel('输出'); await page.getByLabel('运行命令', { exact: true }).fill('main.js'); await page.getByRole('button', { name: '▶ 运行', exact: true }).click()
  await expect(page.getByLabel('运行输出')).toContainText('RUN_OK', { timeout: 15000 }); await expect(page.getByLabel('运行输出')).toContainText('退出码 0')
  await panel('代码'); await page.locator('.cm-content').fill('console.log("NEW_VALUE");\n')
  await panel('审查'); await expect(page.locator('.os-diff-count')).toContainText('+1'); await expect(page.locator('.os-diff-count')).toContainText('−1')
  assert.ok(await page.locator('.cm-deletedChunk').count() > 0)
  await page.screenshot({ path: shots + '/review-mobile.png' })
  await page.getByRole('button', { name: '保存修改', exact: true }).click(); await panel('代码')
  await panel('项目'); await page.getByRole('button', { name: '新建文件', exact: true }).click(); await question('index.html')
  await page.locator('.cm-content').fill('<h1>Preview works</h1><script>document.body.dataset.ready="yes"</script>'); await page.getByRole('button', { name: '保存', exact: true }).click()
  await panel('输出'); await page.getByRole('button', { name: '网页预览', exact: true }).click()
  await expect(page.frameLocator('.os-preview').getByRole('heading', { name: 'Preview works' })).toBeVisible()
  await expect(page.frameLocator('.os-preview').locator('body')).toHaveAttribute('data-ready', 'yes')
  for (let repeat = 0; repeat < 5; repeat++) {
    await page.getByRole('button', { name: '网页预览', exact: true }).click()
    await expect(page.frameLocator('.os-preview').getByRole('heading', { name: 'Preview works' })).toBeVisible({ timeout: 15000 })
  }
  await panel('项目'); await page.getByLabel('搜索项目内容').fill('NEW_VALUE'); await page.getByRole('button', { name: /main.js:1/ }).click(); await expect(page.locator('.cm-content')).toContainText('NEW_VALUE')
  await page.reload(); await navigate('IDE'); await expect(page.getByLabel('当前项目')).toHaveValue(/.+/); await expect(page.locator('.cm-content')).toContainText('NEW_VALUE')
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 })
    for (const name of ['项目', '代码', '审查', '输出', 'Agent']) {
      await panel(name)
      assert.ok(await page.locator('.os-ide').evaluate(element => element.scrollWidth <= element.clientWidth + 1), name + ' layout fits ' + width)
      assert.ok(await page.locator('.workspace').evaluate(element => element.getBoundingClientRect().right <= innerWidth + 1), 'screen fits')
    }
  }
  await panel('代码'); await page.screenshot({ path: shots + '/ide-wide.png' })
  await page.setViewportSize({ width: 390, height: 420 }); await expect(page.locator('.cm-content')).toBeVisible(); await page.screenshot({ path: shots + '/keyboard.png' })
  await navigate('设置'); await page.getByRole('switch', { name: '启用工具调用' }).check(); await page.getByRole('switch', { name: '项目文件读写' }).check(); await page.getByRole('button', { name: '保存 Agent 设置' }).click()
  await page.reload(); await navigate('设置'); await expect(page.getByRole('switch', { name: '项目文件读写' })).toBeChecked()
  await page.setViewportSize({ width: 390, height: 844 })
  await navigate('供应商'); await page.getByRole('button', { name: '添加供应商', exact: true }).click()
  await page.getByLabel('供应商名称').fill('IDE test'); await page.getByLabel('OpenAI 兼容接口地址').fill('http://127.0.0.1:9876/v1'); await page.getByLabel('模型 ID（每行一个）').fill('tool-model\nsecond-model'); await page.getByRole('button', { name: '保存供应商' }).click()
  await page.route('http://127.0.0.1:9876/v1/chat/completions', async route => {
    const request = route.request().postDataJSON()
    const message = request.messages.at(-1).role === 'tool' ? { role: 'assistant', content: '代码提案已经生成，请打开审查。' } : { role: 'assistant', content: null, tool_calls: [{ id: 'proposal-1', type: 'function', function: { name: 'propose_file', arguments: JSON.stringify({ path: 'main.js', content: 'console.log("AGENT_REVIEWED");\n' }) } }] }
    await route.fulfill({ json: { choices: [{ message }] } })
  })
  await navigate('IDE'); await panel('Agent'); await page.getByLabel('项目 Agent 消息').fill('修改 main.js 的输出内容'); await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByLabel('项目 Agent 对话')).toContainText('代码提案已经生成', { timeout: 15000 })
  await panel('审查'); await expect(page.locator('.cm-content')).toContainText('AGENT_REVIEWED'); await expect(page.locator('.cm-deletedChunk')).toContainText('NEW_VALUE')
  await page.screenshot({ path: shots + '/agent-review.png' })
  await page.getByRole('button', { name: '接受修改', exact: true }).click(); await panel('代码'); await expect(page.locator('.cm-content')).toContainText('AGENT_REVIEWED')
  await page.reload(); await navigate('IDE'); await expect(page.locator('.cm-content')).toContainText('AGENT_REVIEWED')
  await panel('Agent'); await expect(page.locator('.os-tool-event')).toContainText('生成修改提案')
  await page.getByRole('button', { name: '新的项目对话' }).click(); await expect(page.locator('.os-agent-welcome')).toBeVisible()
  await page.getByRole('button', { name: '会话历史' }).click(); await page.locator('.os-chat-history').getByRole('button', { name: '修改 main.js 的输出内容' }).click()
  await expect(page.getByLabel('项目 Agent 对话')).toContainText('代码提案已经生成')
  await page.getByLabel('项目 Agent 模型').selectOption({ label: 'second-model' }); await page.getByLabel('Agent 工作模式').selectOption('ask')
  await page.getByRole('button', { name: '引用当前文件' }).click(); await expect(page.locator('.os-context-chip')).toContainText('main.js')
  await page.unroute('http://127.0.0.1:9876/v1/chat/completions')
  let captured
  await page.route('http://127.0.0.1:9876/v1/chat/completions', async route => {
    captured = route.request().postDataJSON()
    await route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: '### 项目检查完成\n\n已读取 **main.js**。\n\n```js\nconsole.log("AGENT_REVIEWED");\n```\n\n- 修改已保存在本机。\n- 可以继续添加功能。\n\n<script>window.injected=true</script>' } }] } })
  })
  await page.getByLabel('项目 Agent 消息').fill('解释当前文件'); await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByLabel('项目 Agent 对话')).toContainText('项目检查完成')
  assert.equal(captured.model, 'second-model'); assert.ok(!captured.tools?.length, 'ask mode has no tools'); assert.ok(captured.messages.at(-1).content.includes('AGENT_REVIEWED'), 'referenced content reaches model')
  await expect(page.locator('.os-message-content h3')).toHaveText('项目检查完成'); assert.equal(await page.evaluate(() => window.injected), undefined)
  await page.getByLabel('Agent 工作模式').selectOption('agent')
  await page.unroute('http://127.0.0.1:9876/v1/chat/completions')
  let questionCalls = 0
  await page.route('http://127.0.0.1:9876/v1/chat/completions', async route => {
    questionCalls++
    const payload = route.request().postDataJSON(), answered = payload.messages.at(-1).role === 'tool'
    const message = answered ? { role: 'assistant', content: '已经收到选择，按该方案继续。' } : { role: 'assistant', content: null, tool_calls: [{ id: 'ask-1', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '希望先完善哪一部分？', options: ['完善界面', '补充功能'] }) } }] }
    await route.fulfill({ json: { choices: [{ message }] } })
  })
  await page.getByLabel('项目 Agent 消息').fill('请先确认需求'); await page.getByRole('button', { name: '发送', exact: true }).click()
  const dock = page.locator('.os-question-dock'); await dock.getByRole('button', { name: '完善界面' }).click(); await dock.getByRole('button', { name: '提交回答' }).click()
  await expect(page.getByLabel('项目 Agent 对话')).toContainText('已经收到选择'); assert.equal(questionCalls, 2)
  await page.getByLabel('项目 Agent 消息').fill('再次确认'); await page.getByRole('button', { name: '发送', exact: true }).click(); await dock.getByRole('button', { name: '取消' }).click()
  await expect(page.getByLabel('项目 Agent 对话')).toContainText('已暂停'); assert.equal(questionCalls, 3, 'cancel does not invoke another completion')
  await page.screenshot({ path: shots + '/agent-mobile.png' })
  await page.setViewportSize({ width: 1440, height: 900 }); await panel('代码')
  const grip = page.getByRole('separator', { name: '调整 Agent 栏宽度' }); await grip.focus(); await grip.press('ArrowLeft'); await expect(grip).toHaveAttribute('aria-valuenow', '366')
  await page.screenshot({ path: shots + '/agent-workbench.png' })
  await navigate('设置'); await page.getByRole('switch', { name: '深色外观' }).check(); await navigate('IDE'); await panel('代码'); await page.screenshot({ path: shots + '/agent-dark.png' })
  await page.setViewportSize({ width: 390, height: 420 }); await panel('Agent'); await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport(); await page.screenshot({ path: shots + '/agent-keyboard.png' })
  assert.deepEqual(errors, []); console.log('IDE UI checks passed: editor, reload, diff, local JS, HTML preview, search, settings, responsive layouts')
} catch (error) {
  console.error('Frames:', await Promise.all(page.frames().filter(frame => frame !== page.mainFrame()).map(async frame => ({ url: frame.url(), body: await frame.locator('body').innerText().catch(() => ''), html: (await frame.content().catch(() => '')).slice(0, 2200) }))))
  throw error
} finally { await browser.close() }
