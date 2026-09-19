import { getWorkspace, saveWorkspace, mountWorkbench } from '../src/index.js'
import '../src/style.css'
import './style.css'

const workspace = await getWorkspace()
if (!workspace.paths().length) {
  workspace.name = 'OpenStarry · 预览示例'
  workspace.create('index.html', `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <p class="eyebrow">OPENSTARRY / LIVE PREVIEW</p>
    <h1>把想法变成界面。</h1>
    <p>左侧修改代码，点击「网页预览」查看结果。</p>
    <button id="hello">试试交互</button>
    <p id="result" aria-live="polite"></p>
  </main>
  <script src="main.js"></script>
</body>
</html>`)
  workspace.create('style.css', `body { margin: 0; background: #f5f2eb; color: #272a27; font-family: 'Segoe UI', sans-serif; }
main { padding: 28px; }
.eyebrow { font-size: 10px; letter-spacing: 2px; color: #6e786f; }
h1 { font-size: 30px; font-weight: 500; }
p { font-size: 13px; line-height: 1.8; }
button { background: #304d40; color: white; border: 0; border-radius: 6px; padding: 10px 16px; cursor: pointer; }`)
  workspace.create('main.js', `document.querySelector('#hello').onclick = () => {
  document.querySelector('#result').textContent = '预览中的 JavaScript 已运行。';
};`)
  workspace.open('index.html')
  await saveWorkspace(workspace)
}
const host = document.querySelector('#workbench'), settings = document.querySelector('#provider-settings')
const form = document.querySelector('#provider-form'), error = document.querySelector('#provider-error')
const configKey = 'openstarry.ide.demo.provider', secretKey = 'openstarry.ide.demo.key'
let provider = null
try { provider = JSON.parse(localStorage.getItem(configKey) || 'null') } catch {}
const models = () => Array.isArray(provider?.models) ? provider.models : []
const getKey = () => sessionStorage.getItem(secretKey) || ''
function showProviders({ parent } = {}) {
  const pane = parent || host.querySelector('.os-agent') || host
  const dialog = document.createElement('dialog')
  dialog.className = 'os-provider-dialog'
  dialog.innerHTML = `
    <header class="os-provider-head"><h3>供应商与模型</h3><button type="button" data-close>关闭</button></header>
    <div class="os-provider-content">
      <label class="os-provider-field">供应商名称<input data-name placeholder="例如：我的供应商"></label>
      <label class="os-provider-field">OpenAI 兼容接口地址<input data-endpoint type="url" value="https://api.openai.com/v1"></label>
      <label class="os-provider-field">API 密钥（仅当前预览会话）<input data-key type="password" autocomplete="off"></label>
      <label class="os-provider-field">模型 ID（每行一个）<textarea data-models rows="4"></textarea></label>
      <p class="os-provider-feedback" data-feedback role="status"></p>
    </div>
    <footer class="os-provider-footer"><button type="button" data-test>测试连接</button><button type="button" data-cancel>取消</button><button type="button" class="os-primary" data-save>保存</button></footer>`
  const q = selector => dialog.querySelector(selector)
  q('[data-name]').value = provider?.name || ''
  q('[data-endpoint]').value = provider?.endpoint || 'https://api.openai.com/v1'
  q('[data-key]').value = getKey()
  q('[data-models]').value = models().join('\n')
  const close = () => dialog.close()
  q('[data-close]').onclick = close; q('[data-cancel]').onclick = close
  q('[data-test]').onclick = () => { q('[data-feedback]').textContent = '连接测试已触发，可手动填写模型 ID。' }
  q('[data-save]').onclick = () => {
    try {
      const endpoint = new URL(q('[data-endpoint]').value.trim())
      if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('请填写有效的 HTTP / HTTPS 接口地址')
      const name = q('[data-name]').value.trim()
      const list = [...new Set(q('[data-models]').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))]
      if (!name || !list.length) throw Error('请填写供应商名称和至少一个模型 ID')
      provider = { name, endpoint: endpoint.href.replace(/\/+$/, ''), models: list, model: list.includes(provider?.model) ? provider.model : list[0] }
      localStorage.setItem(configKey, JSON.stringify(provider)); sessionStorage.setItem(secretKey, q('[data-key]').value.trim()); dialog.close(); workbench.refresh(); host.querySelector('.os-agent-input')?.focus()
    } catch (cause) { q('[data-feedback]').textContent = cause.message }
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  pane.append(dialog); dialog.show(); q('[data-name]').focus()
}
const workbench = await mountWorkbench(host, {
  theme: 'dark', configureProvider: showProviders,
  getModel: () => ({ endpoint: provider?.endpoint, model: provider?.model, key: getKey() }),
  getModels: () => models().map(value => ({ value, label: value, selected: value === provider?.model })),
  selectModel: value => { provider.model = value; localStorage.setItem(configKey, JSON.stringify(provider)) },
})
document.querySelector('#back-to-ide').onclick = () => { settings.hidden = true; host.hidden = false; workbench.refresh() }
form.onsubmit = event => {
  event.preventDefault()
  try {
    const endpoint = new URL(form.elements.endpoint.value.trim())
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('请填写不含凭据或参数的 HTTP / HTTPS 接口地址')
    const name = form.elements.providerName.value.trim()
    const list = [...new Set(form.elements.models.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))]
    if (!name || !list.length) throw Error('请填写供应商名称和至少一个模型 ID')
    const next = { name, endpoint: endpoint.href.replace(/\/+$/, ''), models: list, model: list.includes(provider?.model) ? provider.model : list[0] }
    localStorage.setItem(configKey, JSON.stringify(next)); sessionStorage.setItem(secretKey, form.elements.apiKey.value.trim())
    provider = next; settings.hidden = true; host.hidden = false; workbench.refresh()
  } catch (cause) { error.textContent = cause.message }
}
