<template>
  <el-container class="ide-page-layout">
    <el-aside class="aside-area"><HomePage /></el-aside>
    <el-main class="ide-page-main"><div ref="host" class="ide-page-host" /></el-main>
  </el-container>
</template>
<script setup>
import { ref, onMounted, onActivated, onBeforeUnmount, watch } from 'vue'
import { ElMessage } from 'element-plus'
import HomePage from './homePage.vue'
import { useAppCacheData } from '../store/app'
import { useAuthStore } from '../store/auth'
import { mountWorkbench } from '@openstarry/workbench'
import '@openstarry/workbench/style.css'
const store = useAppCacheData(), auth = useAuthStore(), host = ref(null)
let workbench
const endpoints = { openai: 'https://api.openai.com/v1', deepseek: 'https://api.deepseek.com/v1', ollama: 'http://localhost:11434/v1', moonshot: 'https://api.moonshot.cn/v1', qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1', google: 'https://generativelanguage.googleapis.com/v1beta/openai' }
async function getModel() {
  const config = store.config; let endpoint = endpoints[config.modelProvider], key = config.apiKey || store.apiKeyCache[config.modelProvider] || ''
  if (config.modelProvider === 'custom') {
    const providers = await window.api.getLlmProviders(auth.user.user_uid)
    endpoint = providers.find(item => item.provider_id === config.activeProvider.provider_id)?.endpoint
    key = store.providers.find(item => item.provider_id === config.activeProvider.provider_id)?.api_key || config.activeProvider.api_key || ''
  }
  return { endpoint, key, model: config.modelName, temperature: config.modelTemp * .02, rolePrompt: config.rolePrompt?.definition || '' }
}
async function getModels() {
  const config = store.config, current = await getModel()
  let models
  if (config.modelProvider === 'custom') {
    const providers = await window.api.getLlmProviders(auth.user.user_uid)
    models = providers.find(item => item.provider_id === config.activeProvider.provider_id)?.model_list || []
  } else {
    try { models = await window.api.getModelsList(config.modelProvider, current.key, {}) } catch { models = [] }
  }
  if (current.model && !models.includes(current.model)) models.unshift(current.model)
  return models.map(value => ({ value, label: value, selected: value === current.model }))
}
async function request({ signal, ...value }) {
  signal?.throwIfAborted(); const id = crypto.randomUUID()
  const abort = () => window.api.ide.cancelHttp({ id })
  signal?.addEventListener('abort', abort, { once: true })
  try { const result = await window.api.ide.http({ id, ...value }); signal?.throwIfAborted(); return result }
  finally { signal?.removeEventListener('abort', abort) }
}
async function run({ signal, onOutput, ...value }) {
  signal?.throwIfAborted(); const requestId = crypto.randomUUID()
  const unsubscribe = window.api.ide.onOutput(event => { if (event.requestId === requestId) onOutput?.(event.text) })
  const abort = () => window.api.ide.stop({ requestId })
  signal?.addEventListener('abort', abort, { once: true })
  try { const result = await window.api.ide.run({ ...value, requestId }); signal?.throwIfAborted(); return result }
  finally { unsubscribe(); signal?.removeEventListener('abort', abort) }
}
function normalizeProviderEndpoint(value) {
  const url = new URL(String(value || '').trim().replace(/\/(chat\/completions|models)\/?$/, '').replace(/\/+$/, ''))
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('请填写不含凭据和参数的 HTTP(S) 接口地址')
  return url.href.replace(/\/+$/, '')
}
function providerField(content, label, value, type = 'text') {
  const wrap = document.createElement('label'); wrap.className = 'os-provider-field'; wrap.textContent = label
  const input = document.createElement(type === 'textarea' ? 'textarea' : 'input'); input.setAttribute('aria-label', label); input.value = value || ''
  if (type !== 'textarea') { input.type = type; input.autocomplete = type === 'password' ? 'off' : 'on' }
  wrap.append(input); content.append(wrap); return input
}
async function configureProvider({ parent } = {}) {
  const host = parent || document.body
  const cid = auth.user.user_uid
  const providers = await window.api.getLlmProviders(cid)
  const selectedId = store.config.activeProvider?.provider_id || ''
  const provider = providers.find(item => item.provider_id === selectedId)
  const local = provider && store.providers.find(item => item.provider_id === provider.provider_id)
  const dialog = document.createElement('dialog'); dialog.className = 'os-provider-dialog'; dialog.setAttribute('aria-label', provider ? '编辑供应商与模型' : '添加供应商')
  const head = document.createElement('header'); head.className = 'os-provider-head'; const title = document.createElement('h3'); title.textContent = provider ? '编辑供应商与模型' : '添加供应商'; const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭'; close.onclick = () => dialog.close(); head.append(title, close)
  const content = document.createElement('div'); content.className = 'os-provider-content'
  const name = providerField(content, '供应商名称', provider?.provider_name)
  const endpoint = providerField(content, 'OpenAI 兼容接口地址', provider?.endpoint || 'https://api.openai.com/v1', 'url')
  const key = providerField(content, 'API 密钥（仅保存在本设备）', local?.api_key || store.config.activeProvider?.api_key || '', 'password')
  const models = providerField(content, '模型 ID（每行一个）', (provider?.model_list || []).join('\n'), 'textarea')
  const feedback = document.createElement('p'); feedback.className = 'os-provider-feedback'; feedback.setAttribute('role', 'alert'); content.append(feedback)
  const footer = document.createElement('footer'); footer.className = 'os-provider-footer'; const test = document.createElement('button'); test.type = 'button'; test.className = 'os-provider-test'; test.textContent = '测试连接并获取模型'; const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消'; cancel.onclick = () => dialog.close(); const save = document.createElement('button'); save.type = 'button'; save.className = 'os-primary'; save.textContent = '保存'; footer.append(test, cancel, save)
  dialog.append(head, content, footer); host.append(dialog); dialog.show()
  const modelIds = () => [...new Set(models.value.split(/[\n,，]+/).map(item => item.trim()).filter(Boolean))]
  test.onclick = async () => {
    test.disabled = true; feedback.textContent = '正在连接…'
    try { const ids = await window.api.autoFetchModelList(normalizeProviderEndpoint(endpoint.value), key.value.trim()); models.value = [...new Set([...modelIds(), ...ids])].join('\n'); feedback.textContent = `连接成功，获取 ${ids.length} 个模型` }
    catch (error) { feedback.textContent = error?.message || '连接失败，也可以手动填写模型 ID' }
    finally { test.disabled = false }
  }
  save.onclick = async () => {
    save.disabled = true; feedback.textContent = ''
    try {
      const list = modelIds(); if (!name.value.trim() || !list.length) throw Error('请填写名称和至少一个模型 ID')
      const meta = { provider_name: name.value.trim(), type: 'openai', endpoint: normalizeProviderEndpoint(endpoint.value), model_list: list, description: provider?.description || '' }
      const id = provider?.provider_id || (await window.api.createLlmProvider(cid, meta)).provider_id
      if (provider?.provider_id) await window.api.updateLlmProvider(id, cid, meta)
      const target = store.providers.find(item => item.provider_id === id)
      if (target) { target.provider_name = meta.provider_name; target.api_key = key.value.trim() } else store.providers.push({ provider_id: id, provider_name: meta.provider_name, api_key: key.value.trim(), enabled: true })
      store.providers.forEach(item => { item.enabled = item.provider_id === id })
      store.saveAppConfig('modelProvider', 'custom'); store.saveAppConfig('activeProvider', { provider_id: id, name: meta.provider_name, api_key: key.value.trim() }); store.saveAppConfig('modelName', list.includes(store.config.modelName) ? store.config.modelName : list[0]); store.persistState('providers')
      feedback.textContent = '已保存，正在刷新模型菜单…'; dialog.close()
    } catch (error) { feedback.textContent = error?.message || '保存失败'; save.disabled = false }
  }
  await new Promise(resolve => {
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close() })
    dialog.addEventListener('close', () => { dialog.remove(); resolve() }, { once: true })
  })
}
onMounted(async () => {
  try {
    workbench = await mountWorkbench(host.value, { theme: store.config.dark_theme ? 'dark' : 'light', getModel, getModels, selectModel: value => store.saveAppConfig('modelName', value), request,
      configureProvider,
      notify: message => ElMessage({ message, duration: 5000 }),
      notifyQuestion: question => window.api.system.notifyQuestion({ id: crypto.randomUUID(), question, title: 'IDE Agent 需要你的回答' }),
      native: { open: () => window.api.ide.open(), write: value => window.api.ide.write(value), rename: value => window.api.ide.rename(value), remove: value => window.api.ide.remove(value), run },
      exportFile: (name, bytes) => window.api.ide.export({ name, bytes: Array.from(bytes) })
    })
  } catch (error) { ElMessage.error(error.message) }
})
watch(() => store.config.dark_theme, value => workbench?.setTheme(value ? 'dark' : 'light'))
onActivated(() => workbench?.refresh())
onBeforeUnmount(() => workbench?.destroy())
</script>
<style scoped>
.ide-page-layout { height:100%; min-height:0; }
.ide-page-main { padding:8px 10px 10px 0; min-width:0; overflow:hidden; }
.ide-page-host { height:100%; min-height:0; }
</style>
