const key = 'openstarry.agent.tools.v1'
export const defaults = Object.freeze({ enabled: false, files: false, execute: false, web: false, knowledge: false, skills: false, mcp: false, autoContinue: true, maxTurns: 12, maxMinutes: 10, errorLimit: 3, showTools: true, runtimeUrl: '', runtimeToken: '', runtimeImage: 'python', mcpUrl: '', mcpToken: '' })
export function loadToolSettings() { try { return normalizeSettings(JSON.parse(localStorage.getItem(key) || '{}')) } catch { return { ...defaults } } }
export function normalizeSettings(value) {
  const next = { ...defaults }
  for (const name of Object.keys(defaults)) {
    if (typeof defaults[name] === 'boolean') next[name] = value[name] === undefined ? defaults[name] : value[name] === true
    else if (typeof defaults[name] === 'string') next[name] = typeof value[name] === 'string' ? value[name].trim() : defaults[name]
  }
  for (const [name, max] of [['maxTurns', 50], ['maxMinutes', 120], ['errorLimit', 10]]) next[name] = Math.max(1, Math.min(max, Math.floor(Number(value[name]) || defaults[name])))
  if (!['python', 'node', 'java'].includes(next.runtimeImage)) next.runtimeImage = 'python'
  return next
}
export function saveToolSettings(value) {
  const next = normalizeSettings({ ...loadToolSettings(), ...value })
  for (const name of ['runtimeUrl', 'mcpUrl']) if (next[name]) next[name] = serviceUrl(next[name])
  localStorage.setItem(key, JSON.stringify(next)); return next
}
export function serviceUrl(value) {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw Error('服务地址请使用 HTTPS；本机调试可使用 HTTP')
  return url.href.replace(/\/$/, '')
}
export function mountToolSettings(container, { notify = () => {}, desktop = false, request } = {}) {
  const value = loadToolSettings(); container.classList.add('os-tools')
  const heading = document.createElement('h3'); heading.textContent = 'Agent 调用与 IDE'; container.append(heading)
  const note = document.createElement('p'); note.className = 'os-hint'; note.textContent = '工具权限和连接凭据仅保存在本机。Agent 修改先进入红绿审查，接受后保存。'; container.append(note)
  const controls = {}
  for (const [name, label, detail] of [
    ['enabled', '启用工具调用', '对话中允许模型使用以下已开启的工具'],
    ['files', '项目文件读写', '读取项目、创建文件；代码修改生成待审查提案'],
    ['execute', '代码执行', desktop ? '在选中的项目目录执行命令，输出显示在 IDE 下方' : '本地运行 JavaScript；其他语言使用执行服务器'],
    ['web', '网页浏览与搜索', '读取网址、搜索公开网页；不携带供应商密钥'],
    ['knowledge', '项目知识检索', '搜索当前项目的文档和源代码'],
    ['skills', '项目技能说明', '加载项目中的 AGENTS.md 或 .openstarry/skills.md'],
    ['mcp', 'MCP 工具', '连接支持 Streamable HTTP 的 MCP 服务'],
    ['autoContinue', '自动续写', '工具返回后继续，直到完成或达到上限'],
    ['showTools', '显示工具调用', '在对话中显示执行中的工具和结果']
  ]) {
    const row = document.createElement('label'); row.className = 'os-tool-row'
    const words = document.createElement('span'); const title = document.createElement('strong'); title.textContent = label
    const hint = document.createElement('small'); hint.textContent = detail; words.append(title, hint)
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = value[name]; input.setAttribute('role', 'switch'); input.setAttribute('aria-label', label); controls[name] = input; row.append(words, input); container.append(row)
  }
  const fields = document.createElement('div'); fields.className = 'os-tool-fields'
  for (const [name, label, type] of [['maxTurns', '最大工具回合', 'number'], ['maxMinutes', '最长运行（分钟）', 'number'], ['errorLimit', '连续失败上限', 'number'], ['runtimeUrl', '执行服务器地址', 'url'], ['runtimeToken', '执行服务器令牌', 'password'], ['mcpUrl', 'MCP 服务地址', 'url'], ['mcpToken', 'MCP 令牌', 'password']]) {
    const wrap = document.createElement('label'); wrap.textContent = label; const input = document.createElement('input'); input.type = type; input.value = value[name]; input.setAttribute('aria-label', label); input.autocomplete = 'off'
    if (type === 'number') { input.min = 1; input.max = name === 'maxTurns' ? 50 : name === 'maxMinutes' ? 120 : 10 }
    controls[name] = input; wrap.append(input); fields.append(wrap)
  }
  const label = document.createElement('label'); label.textContent = '服务器运行环境'
  const runtime = document.createElement('select'); runtime.setAttribute('aria-label', '服务器运行环境')
  for (const [name, text] of [['python', 'Python 3.12'], ['node', 'Node.js 22'], ['java', 'Java 21']]) { const option = document.createElement('option'); option.value = name; option.textContent = text; runtime.append(option) }
  runtime.value = value.runtimeImage; label.append(runtime); fields.append(label); controls.runtimeImage = runtime
  const save = document.createElement('button'); save.type = 'button'; save.textContent = '保存 Agent 设置'
  save.onclick = () => { try { saveToolSettings(Object.fromEntries(Object.entries(controls).map(([name, input]) => [name, input.type === 'checkbox' ? input.checked : input.value]))); notify('Agent 设置已保存') } catch (error) { notify(error.message) } }
  const hint = document.createElement('p'); hint.className = 'os-hint'; hint.textContent = desktop ? '此处用于 IDE Agent。智能体页面原有的电脑控制、知识库和任务调度继续使用其对应设置。MCP 操作的文件以服务端工作区为准。' : '手机保留电脑控制之外的项目工具；知识检索使用当前项目。服务器运行会上传本次项目的已保存文本文件；MCP 操作的文件以服务端工作区为准。'
  const check = document.createElement('button'); check.type = 'button'; check.textContent = '测试 MCP 连接'; check.style.marginLeft = '8px'
  check.onclick = async () => {
    check.disabled = true; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(Error('连接超时')), 20000)
    try { const [{ connectMcp }, { httpRequest }] = await Promise.all([import('./agent.js'), import('./runtime.js')]); const mcp = await connectMcp({ mcpUrl: controls.mcpUrl.value, mcpToken: controls.mcpToken.value }, request || httpRequest, controller.signal); notify(`MCP 连接成功，共 ${mcp.tools.length} 个可用工具`); }
    catch (error) { notify(error.message) }
    finally { clearTimeout(timer); check.disabled = false }
  }
  container.append(fields, save, check, hint)
}
