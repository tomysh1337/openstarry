<template>
  <el-container class="ide-page-layout">
    <el-aside class="aside-area"><HomePage /></el-aside>
    <el-main class="ide-page-main"><div ref="host" class="ide-page-host" /></el-main>
  </el-container>
</template>
<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
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
onMounted(async () => {
  try {
    workbench = await mountWorkbench(host.value, { theme: store.config.dark_theme ? 'dark' : 'light', getModel, getModels, selectModel: value => store.saveAppConfig('modelName', value), request,
      notify: message => ElMessage({ message, duration: 5000 }),
      notifyQuestion: question => window.api.system.notifyQuestion({ id: crypto.randomUUID(), question, title: 'IDE Agent 需要你的回答' }),
      native: { open: () => window.api.ide.open(), write: value => window.api.ide.write(value), rename: value => window.api.ide.rename(value), remove: value => window.api.ide.remove(value), run },
      exportFile: (name, bytes) => window.api.ide.export({ name, bytes: Array.from(bytes) })
    })
  } catch (error) { ElMessage.error(error.message) }
})
watch(() => store.config.dark_theme, value => workbench?.setTheme(value ? 'dark' : 'light'))
onBeforeUnmount(() => workbench?.destroy())
</script>
<style scoped>
.ide-page-layout { height:100%; min-height:0; }
.ide-page-main { padding:8px 10px 10px 0; min-width:0; overflow:hidden; }
.ide-page-host { height:100%; min-height:0; }
</style>
