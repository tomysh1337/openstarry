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
function showProviders() {
  settings.dataset.theme = host.querySelector('.os-ide')?.dataset.theme || 'dark'
  form.elements.providerName.value = provider?.name || ''
  form.elements.endpoint.value = provider?.endpoint || 'https://api.openai.com/v1'
  form.elements.apiKey.value = getKey()
  form.elements.models.value = models().join('\n')
  error.textContent = ''
  host.hidden = true; settings.hidden = false; form.elements.providerName.focus()
}
function returnToIde() {
  settings.hidden = true; host.hidden = false
  workbench.refresh()
  host.querySelector('.os-agent-input')?.focus()
}
const workbench = await mountWorkbench(host, {
  theme: 'dark', configureProvider: showProviders,
  getModel: () => ({ endpoint: provider?.endpoint, model: provider?.model, key: getKey() }),
  getModels: () => models().map(value => ({ value, label: value, selected: value === provider?.model })),
  selectModel: value => { provider.model = value; localStorage.setItem(configKey, JSON.stringify(provider)) },
})
document.querySelector('#back-to-ide').onclick = returnToIde
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
    provider = next; returnToIde()
  } catch (cause) { error.textContent = cause.message }
}
