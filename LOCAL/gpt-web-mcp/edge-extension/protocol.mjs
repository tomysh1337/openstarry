export function parsePairingCode(code) {
  if (typeof code !== 'string' || code.length > 4096 || !/^osb1\.[A-Za-z0-9_-]+$/.test(code.trim())) throw Error('请粘贴应用复制的完整配对码')
  const encoded = code.trim().slice(5).replace(/-/g, '+').replace(/_/g, '/')
  const value = JSON.parse(atob(encoded))
  if (value.version !== 1 || typeof value.token !== 'string' || !/^[\w-]{43}$/.test(value.token) || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value.origin)) throw Error('配对码格式错误，仅接受本机 OpenStarry 地址')
  const url = new URL(value.origin)
  if (!url.port || Number(url.port) < 1 || Number(url.port) > 65535) throw Error('配对端口错误')
  return { origin: url.origin, token: value.token }
}

export function isChatGPT(url) {
  try { return new URL(url).origin === 'https://chatgpt.com' } catch { return false }
}

export function validateCommand(command, now = Date.now()) {
  if (!command || !/^[a-f0-9-]{36}$/.test(command.id) || !Number.isFinite(command.expiresAt) || command.expiresAt <= now || command.expiresAt > now + 120000) throw Error('浏览器操作已过期')
  if (!['page', 'inspect', 'send', 'stop', 'download'].includes(command.method)) throw Error('不支持的浏览器操作')
  const args = command.args
  if (!args || typeof args.key !== 'string' || !/^[\w-]{1,220}$/.test(args.key)) throw Error('会话标识错误')
  if (command.method === 'page' && args.webConversationId !== null && (typeof args.webConversationId !== 'string' || !/^[\w-]{1,220}$/.test(args.webConversationId))) throw Error('网页会话标识错误')
  if (command.method === 'send' && (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 16000 || !args.baseline || !Number.isInteger(args.baseline.userCount))) throw Error('消息格式错误')
  if (command.method === 'send' && args.thinking !== undefined && typeof args.thinking !== 'boolean') throw Error('思考开关格式错误')
  if (command.method === 'download' && (typeof args.path !== 'string' || args.path.length > 1200 || !/^sandbox:\/mnt\/data\/[^\u0000-\u001f?#]+$/.test(args.path) || !/^[\w-]{1,220}$/.test(args.webConversationId || '') || (args.messageId !== undefined && (typeof args.messageId !== 'string' || args.messageId.length > 220)) || (args.expectedPrompt !== undefined && (typeof args.expectedPrompt !== 'string' || args.expectedPrompt.length > 16000)))) throw Error('网页文件标识错误')
  return command
}

// Persist intent before a side effect. If the worker dies after dispatch, a retry
// reports uncertainty instead of clicking Send again.
export async function executeOnce(command, { load, save, execute }, now = Date.now()) {
  validateCommand(command, now)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ method: command.method, args: command.args })))
  const fingerprint = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
  const journal = await load()
  const previous = journal[command.id]
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw Error('操作标识对应的内容已改变')
    if (previous.done) return previous.result
    if (command.method === 'download') throw Object.assign(Error('此前下载操作的结果待核对，请查看普通 Edge 下载列表'), { code: 'DOWNLOAD_UNCONFIRMED' })
    throw Object.assign(Error('这条消息的发送结果待核对，已阻止自动重发'), { code: 'DELIVERY_UNCERTAIN' })
  }
  if (!['send', 'stop', 'download'].includes(command.method)) return execute(command)
  const compact = Object.fromEntries(Object.entries(journal).filter(([, value]) => value.at > now - 24 * 60 * 60 * 1000).slice(-127))
  compact[command.id] = { at: now, fingerprint, done: false }
  await save(compact)
  const result = await execute(command)
  compact[command.id] = { at: now, fingerprint, done: true, result }
  await save(compact)
  return result
}
