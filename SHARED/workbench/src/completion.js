export const reasoningLevels = [
  { value: 'low', label: '低' }, { value: 'medium', label: '中等' },
  { value: 'high', label: '高' }, { value: 'xhigh', label: '极高' },
  { value: 'ultra', label: 'Ultra' },
]

// Transports emit decoded UTF-8 chunks only for successful SSE responses.
export async function httpRequest({ url, method = 'GET', headers = {}, body, signal, onChunk }) {
  const response = await fetch(url, { method, headers, body, signal })
  const streamed = response.ok && Boolean(onChunk) && /text\/event-stream/i.test(response.headers.get('content-type') || '')
  const reader = response.body?.getReader(), decoder = new TextDecoder()
  let text = '', bytes = 0
  if (reader) {
    try {
      while (true) {
        signal?.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 4 * 1024 * 1024) throw Error('响应超过大小上限')
        const chunk = decoder.decode(value, { stream: true })
        if (streamed) onChunk(chunk); else text += chunk
      }
      const tail = decoder.decode()
      if (streamed) onChunk(tail); else text += tail
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  return { status: response.status, text, streamed, headers: Object.fromEntries(response.headers) }
}

export function createCompletionStream(onDelta = () => {}) {
  let buffer = '', completed = false, content = '', reasoning = '', finishReason = null
  const calls = new Map()
  function consume(block) {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim()
    if (!data || completed) return
    if (data === '[DONE]') { completed = true; return }
    let payload
    try { payload = JSON.parse(data) } catch { throw Error('流式响应格式不正确') }
    if (payload.error) throw Error('模型返回错误：' + (payload.error.message || '请求失败'))
    const choice = payload.choices?.find(item => (item.index ?? 0) === 0)
    if (!choice) return
    const delta = choice.delta || {}
    if (typeof delta.content === 'string') { content += delta.content; onDelta({ type: 'text', text: delta.content }) }
    const thought = delta.reasoning_content || delta.reasoning
    if (typeof thought === 'string') { reasoning += thought; onDelta({ type: 'reasoning', text: thought }) }
    for (const part of delta.tool_calls || []) {
      if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 16) throw Error('工具调用索引无效')
      const call = calls.get(part.index) || { id: '', type: 'function', function: { name: '', arguments: '' } }
      if (part.id) call.id = part.id
      if (part.function?.name) call.function.name += part.function.name
      if (part.function?.arguments) call.function.arguments += part.function.arguments
      calls.set(part.index, call)
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }
  return {
    push(chunk) {
      buffer += chunk
      // CRLF may itself be split across transport chunks.
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2) }
    },
    finish() {
      if (buffer.trim()) consume(buffer)
      if (!completed && !finishReason) throw Error('连接提前结束，已接收内容已保留')
      if (finishReason === 'length') throw Error('模型输出达到长度上限，已接收内容已保留')
      if (finishReason === 'content_filter') throw Error('模型中止了本次输出')
      const tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
      if (tool_calls.some(call => !call.id || !call.function.name)) throw Error('工具调用未完整接收')
      if (!content && !tool_calls.length) throw Error('模型返回空内容')
      return { role: 'assistant', content, reasoning_content: reasoning, ...(tool_calls.length ? { tool_calls } : {}) }
    },
  }
}

export async function openAIComplete({ request = httpRequest, endpoint, key, model, messages, tools = [], signal, temperature = 1, reasoningEffort = 'medium', onDelta, onNotice = () => {} }) {
  if (!endpoint || !model) throw Error('请先在供应商设置中选择模型')
  const url = new URL(endpoint.replace(/\/(chat\/completions|models)\/?$/, '').replace(/\/+$/, '') + '/chat/completions')
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('供应商接口地址格式错误')
  const effort = reasoningLevels.some(level => level.value === reasoningEffort) ? reasoningEffort : 'medium'
  const body = { model, messages, temperature, stream: true, reasoning_effort: effort, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }
  let parser = createCompletionStream(onDelta), received = false
  const send = () => request({ url: url.href, method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body), signal,
    onChunk: text => { received = true; parser.push(text) } })
  let response = await send()
  // Retry only an explicit parameter rejection, before any output or tool execution.
  if (!received && [400, 422].includes(response.status) && /reasoning[_ .-]?effort/i.test(response.text) && /unsupported|not supported|unknown|unrecognized|invalid|not permitted|extra inputs|不支持/i.test(response.text)) {
    delete body.reasoning_effort
    onNotice('当前接口未接受所选思考等级，本次使用模型默认设置。')
    parser = createCompletionStream(onDelta)
    response = await send()
  }
  signal?.throwIfAborted()
  if (response.status >= 400) throw Error('模型请求失败：HTTP ' + response.status)
  if (response.streamed || /text\/event-stream/i.test(response.headers?.['content-type'] || '')) {
    if (!received) parser.push(response.text)
    return parser.finish()
  }
  let data
  try { data = JSON.parse(response.text) } catch { throw Error('模型响应不是 JSON 或事件流') }
  if (data.error) throw Error('模型返回错误，请检查模型和账户额度')
  const message = data.choices?.[0]?.message
  if (!message || (!message.content && !message.tool_calls?.length)) throw Error('模型返回空内容')
  onNotice('当前接口返回整段回复，未提供流式数据。')
  if (message.reasoning_content) onDelta?.({ type: 'reasoning', text: message.reasoning_content })
  if (message.content) onDelta?.({ type: 'text', text: message.content })
  return message
}
