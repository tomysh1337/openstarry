<template>
  <ProviderEditDialog v-if="visible" v-model="visible" :provider="provider" :saving="saving" @save="save" />
</template>
<script setup>
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useAppCacheData } from '../../../store/app.js'
import ProviderEditDialog from './ProviderEditDialog.vue'
const emit = defineEmits(['saved'])
const store = useAppCacheData()
const visible = ref(false), saving = ref(false), provider = ref(null)
const presets = {
  openai: ['OpenAI', 'https://api.openai.com/v1'], deepseek: ['DeepSeek', 'https://api.deepseek.com/v1'],
  ollama: ['Ollama', 'http://localhost:11434/v1'], moonshot: ['Moonshot', 'https://api.moonshot.cn/v1'],
  qwen: ['Qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1'], google: ['Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai']
}
async function open() {
  try {
    const current = store.config
    const all = await window.api.getLlmProviders('local-user')
    const selected = current.modelProvider === 'custom' && all.find(item => item.provider_id === current.activeProvider.provider_id)
    const preset = presets[current.modelProvider] || ['自定义供应商', '']
    provider.value = selected ? { ...selected, name: selected.provider_name, api_key: current.apiKey || '' } : {
      name: preset[0], endpoint: preset[1], model_list: current.modelName ? [current.modelName] : [], api_key: current.apiKey || ''
    }
    visible.value = true
  } catch (err) { ElMessage.error(err.message || '供应商读取失败') }
}
async function save(payload) {
  saving.value = true
  try {
    const meta = { provider_name: payload.name, endpoint: payload.endpoint, model_list: payload.model_list, description: payload.description, type: 'openai' }
    const id = payload.provider_id || (await window.api.createLlmProvider('local-user', meta)).provider_id
    if (payload.provider_id) await window.api.updateLlmProvider(id, 'local-user', meta)
    store.providers.forEach(item => { item.enabled = false })
    let local = store.providers.find(item => item.provider_id === id)
    if (!local) { local = { provider_id: id }; store.providers.push(local); local = store.providers.at(-1) }
    Object.assign(local, { provider_name: payload.name, api_key: payload.api_key, enabled: true })
    store.persistState('providers')
    store.saveAppConfig('activeProvider', { provider_id: id, name: payload.name, api_key: payload.api_key })
    store.saveAppConfig('modelProvider', 'custom')
    store.saveAppConfig('apiKey', payload.api_key)
    store.saveAppConfig('modelName', payload.model_list.includes(store.config.modelName) ? store.config.modelName : payload.model_list[0])
    visible.value = false
    emit('saved')
    ElMessage.success('供应商与模型已保存')
  } catch (err) { ElMessage.error(err.message || '保存失败，填写的内容已保留') }
  finally { saving.value = false }
}
defineExpose({ open })
</script>
