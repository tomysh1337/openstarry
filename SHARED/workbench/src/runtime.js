import { serviceUrl } from './settings.js'
import runtimeDocument from '../public/ide-runtime.html?raw'
export async function httpRequest({ url, method = 'GET', headers = {}, body, signal }) {
  const response = await fetch(url, { method, headers, body, signal })
  const text = await response.text()
  if (text.length > 4 * 1024 * 1024) throw Error('响应超过大小上限')
  return { status: response.status, text, headers: Object.fromEntries(response.headers) }
}
export async function openAIComplete({ request = httpRequest, endpoint, key, model, messages, tools = [], signal, temperature = 1 }) {
  if (!endpoint || !model) throw Error('请先在供应商设置中选择模型')
  const url = new URL(endpoint.replace(/\/(chat\/completions|models)\/?$/, '').replace(/\/+$/, '') + '/chat/completions')
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('供应商接口地址格式错误')
  const response = await request({ url: url.href, method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify({ model, messages, temperature, stream: false, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }), signal })
  if (response.status >= 400) throw Error('模型请求失败：HTTP ' + response.status)
  let data; try { data = JSON.parse(response.text) } catch { throw Error('模型响应不是 JSON') }
  if (data.error) throw Error('模型返回错误，请检查模型和账户额度')
  const message = data.choices?.[0]?.message
  if (!message || (!message.content && !message.tool_calls?.length)) throw Error('模型返回空内容')
  return message
}
const encodeScript = value => JSON.stringify(value).replaceAll('<', '\\u003c')
export const runtimeFrameUrl = new URL('../public/ide-runtime.html', import.meta.url).href
function loadRuntimeFrame(frame, payload, onReady, onError) {
  const id = crypto.randomUUID()
  const cleanup = () => { clearTimeout(timer); removeEventListener('message', receive) }
  const receive = event => {
    if (event.source !== frame.contentWindow || event.data?.source !== 'openstarry-runtime' || event.data?.id !== id) return
    cleanup(); frame.contentWindow.postMessage(payload, '*'); onReady?.()
  }
  const timer = setTimeout(() => { cleanup(); onError?.(Error('预览环境加载超时，请重试')) }, 10000)
  addEventListener('message', receive)
  if (location.protocol === 'file:') frame.src = runtimeFrameUrl + '#' + id
  else frame.srcdoc = runtimeDocument.replace('<body>', '<body data-handshake="' + id + '">')
  return cleanup
}
const previews = new WeakMap()
export function showHtmlPreview(frame, content) {
  previews.get(frame)?.()
  return new Promise((resolve, reject) => {
    const cleanup = loadRuntimeFrame(frame, { type: 'preview', html: content }, resolve, reject)
    previews.set(frame, () => { cleanup(); resolve() })
  })
}
export function closeHtmlPreview(frame) { previews.get(frame)?.(); previews.delete(frame) }
export function runJavaScript(code, signal, onOutput = () => {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const frame = document.createElement('iframe'); frame.hidden = true; frame.setAttribute('sandbox', 'allow-scripts'); frame.title = 'JavaScript 执行环境'
    let timer, done = false, cleanupRuntime = () => {}; const lines = []
    const finish = error => { if (done) return; done = true; clearTimeout(timer); cleanupRuntime(); removeEventListener('message', receive); signal?.removeEventListener('abort', abort); frame.remove(); error ? reject(error) : resolve({ output: lines.join('\n'), exitCode: 0 }) }
    const abort = () => finish(signal.reason || Error('运行已停止'))
    const receive = event => {
      if (event.source !== frame.contentWindow || event.data?.source !== 'openstarry-run') return
      const data = event.data
      if (data.type === 'output') { const text = String(data.text).slice(0, 8000); if (lines.join('').length < 100000) { lines.push(text); onOutput(text) } }
      if (data.type === 'error') finish(Error(String(data.text)))
      if (data.type === 'done') finish()
    }
    const workerCode = `const send = (type, text) => self.postMessage({source:'openstarry-run', type, text}); const format = v => {try{return typeof v==='string'?v:JSON.stringify(v)}catch{return String(v)}}; const console = Object.fromEntries(['log','info','warn','error','debug'].map(k=>[k,(...args)=>send('output',args.map(format).join(' '))])); (async()=>{try{await (new (Object.getPrototypeOf(async function(){}).constructor)('console', ${encodeScript(code)}))(console);send('done')}catch(e){send('error',e.message)}})();`
    cleanupRuntime = loadRuntimeFrame(frame, { type: 'run', code: workerCode }, null, finish)
    addEventListener('message', receive); signal?.addEventListener('abort', abort, { once: true }); timer = setTimeout(() => finish(Error('本地 JavaScript 达到 10 秒运行上限')), 10000)
    document.body.append(frame)
  })
}
export function htmlPreview(path, files) {
  const base = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
  const resolve = target => { const parts = (base + target).split('/'), result = []; for (const part of parts) { if (part === '..') result.pop(); else if (part && part !== '.') result.push(part) } return result.join('/') }
  const html = (files[path] || '').replace(/<link\b([^>]*?)href=["']([^"']+)["']([^>]*?)>/gi, (all, before, href) => files[resolve(href)] !== undefined && /\.css$/i.test(href) ? '<style>' + files[resolve(href)].replace(/<\/style/gi, '<\\/style') + '</style>' : all)
    .replace(/<script\b([^>]*?)src=["']([^"']+)["']([^>]*?)>\s*<\/script>/gi, (all, before, src, after) => files[resolve(src)] !== undefined ? `<script ${before} ${after}>` + files[resolve(src)].replace(/<\/script/gi, '<\\/script') + '<\/script>' : all)
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none';">` + html
}
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
})
export async function runRemote({ settings, files, command, request = httpRequest, signal, onOutput = () => {} }) {
  const url = serviceUrl(settings.runtimeUrl)
  if (!settings.runtimeToken) throw Error('请先保存执行服务器令牌')
  const headers = { Authorization: 'Bearer ' + settings.runtimeToken, 'Content-Type': 'application/json' }
  const response = await request({ url: url + '/v1/jobs', method: 'POST', headers, body: JSON.stringify({ files, command, image: settings.runtimeImage }), signal })
  if (response.status !== 202) throw Error('执行服务器启动失败：HTTP ' + response.status)
  const { id } = JSON.parse(response.text)
  if (!/^[a-f0-9-]{20,40}$/.test(id)) throw Error('执行服务器响应格式错误')
  let offset = 0
  const cancel = () => request({ url: url + '/v1/jobs/' + id, method: 'DELETE', headers }).catch(() => {})
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    for (let i = 0; i < 180; i++) {
      signal?.throwIfAborted()
      const result = await request({ url: url + '/v1/jobs/' + id, method: 'GET', headers, signal })
      if (result.status !== 200) throw Error('执行状态读取失败：HTTP ' + result.status)
      const job = JSON.parse(result.text), output = String(job.output || '')
      if (output.length > offset) { onOutput(output.slice(offset)); offset = output.length }
      if (job.done) return { output, exitCode: job.exitCode }
      await pause(600, signal)
    }
    throw Error('服务器执行超时')
  } catch (error) { await cancel(); throw error }
  finally { signal?.removeEventListener('abort', cancel) }
}
