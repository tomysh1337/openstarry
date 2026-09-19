import { normalizeSettings, serviceUrl } from './settings.js'
const tool = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } })
const string = description => ({ type: 'string', description })
export function projectTools(settings) {
  const tools = [tool('ask_user', 'Ask the user a clarifying question before proceeding.', { question: string('Question'), options: { type: 'array', items: { type: 'string' }, maxItems: 5 } }, ['question'])]
  if (settings.files) tools.push(tool('list_files', 'List the current project files.'), tool('read_file', 'Read a project file.', { path: string('Project-relative path') }, ['path']), tool('propose_file', 'Propose the full replacement text for a project file. The user reviews a red/green diff before saving. This does not change the saved file.', { path: string('Project-relative path'), content: string('Full proposed file text') }, ['path', 'content']))
  if (settings.knowledge) tools.push(tool('search_project', 'Search text across the current project.', { query: string('Literal text') }, ['query']))
  if (settings.skills) tools.push(tool('read_project_skills', 'Read project AGENTS.md or .openstarry/skills.md instructions.'))
  if (settings.execute) tools.push(tool('run_project', 'Run saved project code. Pending proposals and editor drafts are not executed. Browser runtime accepts a JavaScript file path; server/desktop accepts a command.', { command: string('Command, or JavaScript file path for local browser execution') }, ['command']))
  if (settings.web) tools.push(tool('read_web', 'Read a public HTTP(S) web page as text.', { url: string('Web URL') }, ['url']), tool('search_web', 'Search public webpages.', { query: string('Search query') }, ['query']))
  return tools
}
export function readablePage(text) { return String(text).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 18000) }
function parseRpc(text) {
  if (typeof text !== 'string') return text
  try { return JSON.parse(text) } catch {}
  const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => { try { return JSON.parse(line.slice(5)) } catch { return null } }).findLast(value => value && ('result' in value || 'error' in value))
  if (!data) throw Error('MCP 响应格式不正确'); return data
}
export async function connectMcp(settings, request, signal) {
  const url = serviceUrl(settings.mcpUrl); let session = '', seq = 0
  const call = async (method, params = {}, notification = false) => {
    signal?.throwIfAborted()
    const response = await request({ url, method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26', ...(settings.mcpToken ? { Authorization: 'Bearer ' + settings.mcpToken } : {}), ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id: ++seq } : {}), method, params }), signal })
    if (response.status >= 400) throw Error('MCP 请求失败：HTTP ' + response.status)
    session = response.headers?.['mcp-session-id'] || session
    if (notification || response.status === 202) return {}
    const result = parseRpc(response.text)
    if (result.error) throw Error(result.error.message || 'MCP 调用失败')
    return result.result
  }
  await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'OpenStarry', version: '1.0.0' } })
  await call('notifications/initialized', {}, true)
  const listing = await call('tools/list')
  const mapping = new Map(); const tools = (listing.tools || []).slice(0, 32).map((entry, index) => { const name = 'mcp_' + index; mapping.set(name, entry.name); return { type: 'function', function: { name, description: String(entry.description || entry.name).slice(0, 2000), parameters: entry.inputSchema || { type: 'object', properties: {} } } } })
  return { tools, label: name => mapping.get(name), invoke: (name, args) => call('tools/call', { name: mapping.get(name), arguments: args }) }
}
export async function runAgent({ messages, settings, workspace, complete, request, execute, ask, signal, onEvent = () => {}, onProposal = async () => {} }) {
  settings = normalizeSettings(settings)
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
  const timer = setTimeout(() => controller.abort(Error('已达到运行时间上限')), settings.maxMinutes * 60000)
  const runSignal = controller.signal
  let failures = 0, finalText = ''
  const context = [...messages]
  try {
    let mcp
    if (settings.enabled && settings.mcp) mcp = await connectMcp(settings, request, runSignal)
    const tools = settings.enabled ? [...projectTools(settings), ...(mcp?.tools || [])] : []
    const allowed = new Set(tools.map(entry => entry.function.name))
    for (let turn = 0; turn < settings.maxTurns; turn++) {
      runSignal.throwIfAborted()
      const answer = await complete({ messages: context, tools, signal: runSignal })
      runSignal.throwIfAborted()
      const calls = answer.tool_calls || []
      if (calls.length > 16) throw Error('单回合工具调用超过上限')
      if (answer.content) { finalText += (finalText ? '\n\n' : '') + answer.content; onEvent({ type: 'text', text: answer.content }) }
      if (!calls.length) return { content: finalText, turns: turn + 1 }
      context.push({ role: 'assistant', content: answer.content || null, tool_calls: calls })
      for (const call of calls) {
        runSignal.throwIfAborted(); let result
        const name = call.function.name
        const event = { type: 'tool', id: `${turn}:${call.id}`, name, label: mcp?.label(name) || name }
        try {
          if (!allowed.has(name)) throw Error('此工具未开启')
          const args = JSON.parse(call.function.arguments || '{}')
          event.path = args.path; event.detail = String(args.path || args.command || args.query || args.question || '')
          onEvent({ ...event, phase: 'running' })
          switch (name) {
            case 'ask_user': result = await ask(args, runSignal); break
            case 'list_files': result = workspace.paths(); break
            case 'read_file': if (!workspace.paths().includes(args.path)) throw Error('文件不存在'); result = workspace.content(args.path); break
            case 'propose_file': workspace.propose(args.path, args.content); await onProposal(args.path); result = { status: 'awaiting_review', path: args.path, message: 'Saved file unchanged until user accepts this proposal.' }; break
            case 'search_project': result = workspace.search(args.query); break
            case 'read_project_skills': result = workspace.paths().filter(path => /(^|\/)(AGENTS\.md|SKILL\.md)$|^\.openstarry\/skills\.md$/i.test(path)).slice(0, 8).map(path => ({ path, content: workspace.content(path).slice(0, 12000) })); break
            case 'run_project': result = await execute(args.command, runSignal); break
            case 'read_web': case 'search_web': {
              const url = new URL(name === 'read_web' ? args.url : 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(args.query))
              if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('网页地址格式错误')
              const response = await request({ url: url.href, method: 'GET', headers: {}, signal: runSignal })
              if (response.status >= 400) throw Error('网页请求失败：HTTP ' + response.status)
              result = readablePage(response.text); break
            }
            default: result = await mcp.invoke(name, args); if (result?.isError) throw Error((result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n') || 'MCP 工具执行失败')
          }
          failures = 0; onEvent({ ...event, phase: 'complete' })
        } catch (error) {
          runSignal.throwIfAborted(); failures++; result = { error: error.message }; onEvent({ ...event, phase: 'error', text: error.message })
          if (failures >= settings.errorLimit) throw Error('连续工具调用失败，已停止：' + error.message)
        }
        context.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 40000) })
      }
      if (!settings.autoContinue) { onEvent({ type: 'text', text: '工具调用已完成；自动续写已关闭。' }); return { content: finalText, turns: turn + 1 } }
    }
    throw Error('已达到工具回合上限，当前修改已保留供审查')
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
