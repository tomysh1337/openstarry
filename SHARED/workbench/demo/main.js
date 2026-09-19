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
await mountWorkbench(document.querySelector('#workbench'), { theme: 'dark' })
