import { timeoutSignal, combineSignals } from './signals.js'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
export function normalizeEndpoint(value) {
  const url = new URL(String(value).trim().replace(/\/(chat\/completions|models)\/?$/, '').replace(/\/+$/, ''))
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('请填写不含密钥和参数的 HTTP(S) 接口地址')
  return url.href.replace(/\/+$/, '')
}
function headers(key) { return { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) } }
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
export async function fetchModels(provider, key) {
  const url = normalizeEndpoint(provider.endpoint) + '/models'
  let data
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({ url, headers: headers(key), connectTimeout: 20000, readTimeout: 20000 })
    if (response.status >= 400) throw Error('获取模型失败：HTTP ' + response.status)
    data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
  } else {
    const response = await fetch(url, { headers: headers(key), signal: timeoutSignal(20000) })
    if (!response.ok) throw Error('获取模型失败：HTTP ' + response.status)
    data = await response.json().catch(() => { throw Error('接口未返回 JSON，请检查地址') })
  }
  const list = Array.isArray(data) ? data : data.data || data.models
  if (!Array.isArray(list)) throw Error('接口未返回模型列表，可手动输入模型 ID')
  return [...new Set(list.map(item => typeof item === 'string' ? item : item.id || item.name).filter(Boolean))]
}
export async function completeChat({ provider, key, model, messages, temperature, signal, onDelta }) {
  const url = normalizeEndpoint(provider.endpoint) + '/chat/completions'
  const native = Capacitor.isNativePlatform()
  const body = { model, messages, stream: !native, ...(Number.isFinite(temperature) ? { temperature } : {}) }
  let content = '', think = ''
  const accept = data => {
    if (data.error) throw Error('供应商返回错误，请检查模型权限或额度')
    const choice = data.choices?.[0]
    const delta = choice?.delta || choice?.message || {}
    if (typeof delta.content === 'string') content += delta.content
    if (typeof delta.reasoning_content === 'string') think += delta.reasoning_content
    onDelta?.({ content, think })
  }
  const combined = combineSignals([signal, timeoutSignal(180000)])
  if (native) {
    const response = await abortable(CapacitorHttp.post({ url, headers: headers(key), data: body, connectTimeout: 20000, readTimeout: 180000 }), combined)
    if (response.status >= 400) throw Error('聊天请求失败：HTTP ' + response.status)
    accept(typeof response.data === 'string' ? JSON.parse(response.data) : response.data)
  } else {
    const response = await fetch(url, { method: 'POST', headers: headers(key), body: JSON.stringify(body), signal: combined })
    if (!response.ok) throw Error('聊天请求失败：HTTP ' + response.status)
    if (!response.headers.get('content-type')?.includes('text/event-stream')) accept(await response.json())
    else {
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = '', finished = false
      function consume(line) {
        if (!line.startsWith('data:')) return
        const value = line.slice(5).trim()
        if (!value) return
        if (value === '[DONE]') { finished = true; return }
        accept(JSON.parse(value))
      }
      try {
        while (!finished) {
          const { done, value } = await reader.read()
          buffer += decoder.decode(value, { stream: !done })
          const lines = buffer.split('\n'); buffer = lines.pop()
          for (const line of lines) consume(line.replace(/\r$/, ''))
          if (done) { if (buffer.trim()) consume(buffer); break }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    }
  }
  if (!content && !think) throw Error('模型返回空内容，请换一个模型重试')
  return { content, think }
}
