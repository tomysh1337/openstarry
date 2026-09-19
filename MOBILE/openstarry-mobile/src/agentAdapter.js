import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { httpRequest, openAIComplete } from '@openstarry/workbench/runtime'
import { runAgent } from '@openstarry/workbench/agent'
import { loadToolSettings } from '@openstarry/workbench/settings'
import { getWorkspace, saveWorkspace, executeProject, askQuestion } from '@openstarry/workbench'
export async function mobileRequest({ signal, body, ...args }) {
  signal?.throwIfAborted()
  if (!Capacitor.isNativePlatform()) return httpRequest({ ...args, body, signal })
  const pending = CapacitorHttp.request({ ...args, data: body ? JSON.parse(body) : undefined, responseType: 'text', connectTimeout: 20000, readTimeout: 180000 })
  const response = await new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || Error('请求已停止'))
    signal?.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort))
  })
  signal?.throwIfAborted()
  const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
  if (text.length > 4 * 1024 * 1024) throw Error('响应超过大小上限')
  return { status: response.status, text, headers: Object.fromEntries(Object.entries(response.headers || {}).map(([name, value]) => [name.toLowerCase(), value])) }
}
export async function mobileAgent({ provider, key, model, messages, temperature, signal, onDelta }) {
  const workspace = await getWorkspace(), settings = loadToolSettings(); let content = ''
  await runAgent({ settings, workspace, messages: [{ role: 'system', content: 'You are OpenStarry Agent. Tools work on the current IDE project. File edits are proposals and require user review in IDE, not saved changes.' }, ...messages], signal, request: mobileRequest,
    complete: args => openAIComplete({ ...args, endpoint: provider.endpoint, key, model, temperature, request: mobileRequest }),
    execute: (command, signal) => executeProject(workspace, command, { settings, request: mobileRequest, signal }),
    ask: async (question, signal) => await askQuestion(question, signal) || '用户取消，请暂停任务。',
    onProposal: () => saveWorkspace(workspace),
    onEvent: event => { if (event.type === 'text') content += (content ? '\n\n' : '') + event.text; onDelta?.({ content, think: event.type === 'tool' && settings.showTools ? `${event.name} · ${event.phase}` : '' }) }
  })
  return { content, think: '' }
}
export async function exportMobileFile(name, bytes) {
  if (!Capacitor.isNativePlatform()) { const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return }
  let data = ''; for (let index = 0; index < bytes.length; index += 8192) data += String.fromCharCode(...bytes.subarray(index, index + 8192))
  const { uri } = await Filesystem.writeFile({ path: name, directory: Directory.Cache, data: btoa(data) })
  await Share.share({ title: name, url: uri, dialogTitle: '导出项目' })
}
