import { mountWorkbench } from '../src/index.js'
import '../src/style.css'
const api = window.api.ide.gpt
const web = { ...api, async watch({ signal, onEvent, ...value }) {
  const watchId = crypto.randomUUID(), off = api.onEvent(e => { if (e.watchId === watchId && !signal.aborted) onEvent(e) })
  const abort = () => api.unwatch({ watchId }); signal.addEventListener('abort', abort, { once: true })
  try { return await api.watch({ ...value, watchId }) } finally { off(); signal.removeEventListener('abort', abort) }
} }
const notice = document.createElement('output'); notice.id = 'qa-notice'; notice.textContent = 'fixture · 本页使用模拟网页适配器'; document.body.append(notice)
await mountWorkbench(document.querySelector('#workbench'), { web, getModel: () => ({}), getModels: () => [], notify: text => { notice.textContent = 'fixture · ' + text } })
