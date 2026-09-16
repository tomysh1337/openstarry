import { nextTick } from 'vue'
const keys = new Set(['dark_theme', 'modelTemp', 'modelName', 'modelProvider', 'activeProvider', 'rolePrompt', 'deepThink'])
let ready = false
let applying = false
let pending = {}
let chain = Promise.resolve()
export const isApplyingPreferences = () => applying
function clean(key, value) {
  if (key === 'activeProvider') return { provider_id: value?.provider_id || '', name: value?.name || '' }
  if (key === 'rolePrompt') return { name: value?.name || '', definition: value?.definition || '' }
  return value
}
export function queuePreference(key, value) {
  if (!keys.has(key) || applying) return
  pending[key] = clean(key, value)
  if (ready) flushPreferences()
}
export function flushPreferences() {
  chain = chain.catch(() => {}).then(async () => {
    if (!Object.keys(pending).length) return
    const batch = { ...pending }
    await window.api.system.sharedPreferences(batch)
    for (const [key, value] of Object.entries(batch)) if (pending[key] === value) delete pending[key]
  })
  chain.catch(() => {})
  return chain
}
export async function refreshPreferences(store, initialize = false) {
  if (initialize) {
    // Seed only preferences explicitly saved on this computer.
    const remote = (await window.api.system.sharedPreferences()).values || {}
    for (const key of keys) if (!(key in remote) && localStorage.getItem(key) !== null) pending[key] = clean(key, store.config[key])
    ready = true
  }
  await flushPreferences()
  const values = (await window.api.system.sharedPreferences()).values || {}
  applying = true
  try {
  for (const [key, value] of Object.entries(values)) {
    if (!keys.has(key) || key in pending) continue
    const next = key === 'activeProvider' ? { ...value, api_key: store.providers.find(item => item.provider_id === value.provider_id)?.api_key || '' } : value
    store.saveAppConfig(key, next, true)
  }
  await nextTick()
  if (values.modelName && !('modelName' in pending)) store.saveAppConfig('modelName', values.modelName, true)
  await nextTick()
  } finally { applying = false }
}
