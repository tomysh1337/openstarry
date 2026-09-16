<template>
  <el-dialog v-model="visible" :title="provider ? '编辑供应商与模型' : '新建供应商'"
    width="min(600px, 92vw)" class="provider-dialog" append-to-body destroy-on-close
    :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving">
    <el-form label-position="top" @submit.prevent="handleSave">
      <el-form-item label="供应商名称"><el-input v-model="form.name" maxlength="50" aria-label="供应商名称" /></el-form-item>
      <el-form-item label="接口地址（OpenAI 兼容）"><el-input v-model="form.endpoint" placeholder="https://api.openai.com/v1" aria-label="接口地址" /></el-form-item>
      <el-form-item label="API 密钥（仅保存在本设备）"><el-input v-model="form.api_key" type="password" show-password autocomplete="off" placeholder="本地服务可留空" aria-label="API 密钥" /></el-form-item>
      <el-form-item label="模型 ID（每行一个，可直接增删修改）">
        <el-input v-model="modelText" type="textarea" :autosize="{minRows: 4, maxRows: 8}" placeholder="gpt-4.1&#10;deepseek-chat" aria-label="模型 ID" />
        <el-button :loading="fetching" :disabled="saving" @click="autoFetch">获取并合并模型列表</el-button>
      </el-form-item>
      <el-form-item label="描述"><el-input v-model="form.description" type="textarea" :rows="2" aria-label="描述" /></el-form-item>
      <p class="editor-error" role="alert">{{ error }}</p>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="visible=false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="fetching" @click="handleSave">保存</el-button>
    </template>
  </el-dialog>
</template>
<script setup>
import { reactive, ref, computed, watch } from 'vue'
const props = defineProps({ modelValue: Boolean, provider: Object, saving: Boolean })
const emit = defineEmits(['update:modelValue', 'save'])
const visible = computed({ get: () => props.modelValue, set: value => emit('update:modelValue', value) })
const form = reactive({ name: '', endpoint: '', api_key: '', description: '' })
const modelText = ref('')
const fetching = ref(false)
const error = ref('')
watch(() => props.provider, value => {
  Object.assign(form, { name: '', endpoint: '', api_key: '', description: '' }, value || {})
  modelText.value = (value?.model_list || []).join('\n')
}, { immediate: true })
const models = () => [...new Set(modelText.value.split(/[\n,，]+/).map(value => value.trim()).filter(Boolean))]
function endpoint() {
  const url = new URL(form.endpoint.trim().replace(/\/(chat\/completions|models)\/?$/, '').replace(/\/+$/, ''))
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('请填写不含凭据和参数的 HTTP(S) 接口地址')
  return url.href.replace(/\/+$/, '')
}
async function autoFetch() {
  fetching.value = true; error.value = ''
  try {
    const ids = await window.api.autoFetchModelList(endpoint(), form.api_key.trim())
    if (!ids.length) throw Error('接口未返回模型，可在上方手动填写')
    modelText.value = [...new Set([...models(), ...ids])].join('\n')
  } catch (err) { error.value = err.message || '获取失败，可手动填写模型 ID' }
  finally { fetching.value = false }
}
function handleSave() {
  if (props.saving || fetching.value) return
  error.value = ''
  try {
    if (!form.name.trim() || !models().length) throw Error('请填写供应商名称和至少一个模型 ID')
    emit('save', { is_editing: Boolean(props.provider?.provider_id), provider_id: props.provider?.provider_id,
      name: form.name.trim(), endpoint: endpoint(), api_key: form.api_key.trim(), description: form.description.trim(),
      type: 'openai', model_list: models() })
  } catch (err) { error.value = err.message }
}
</script>
<style>
.provider-dialog { max-height: 90dvh; overflow: auto; border-radius: 18px; }
.provider-dialog .el-form-item { margin-bottom: 16px; }
.provider-dialog .el-form-item .el-button { margin-top: 8px; }
.editor-error { color: #c43d50; font-size: 13px; min-height: 1em; overflow-wrap: anywhere; }
</style>
