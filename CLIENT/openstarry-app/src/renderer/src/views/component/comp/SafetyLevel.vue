<template>
  <details
    ref="menu"
    class="safety-level"
    @toggle="positionMenu"
    @keydown.esc.stop="menu.open = false"
  >
    <summary :aria-disabled="busy" aria-label="安全等级">
      ♢ {{ selected.label }} <span>⌄</span>
    </summary>
    <Teleport to="body"
      ><div
        v-if="open"
        ref="panel"
        class="safety-options"
        :style="position"
        role="radiogroup"
        aria-label="安全等级"
        @keydown.esc.stop="menu.open = false"
      >
        <small>作用于本应用的 MCP 和子 Agent</small>
        <button
          v-for="level in safetyLevels"
          :key="level.value"
          type="button"
          role="radio"
          :aria-checked="mode === level.value"
          :disabled="busy"
          @click="change(level.value)"
        >
          <strong>{{ level.label }} <span v-if="mode === level.value">✓</span></strong
          ><small>{{ level.description }}</small>
        </button>
        <p v-if="error" role="alert">{{ error }}</p>
      </div></Teleport
    >
  </details>
</template>
<script setup>
import { computed, ref, onMounted, onBeforeUnmount, onActivated, onDeactivated } from 'vue'
import { safetyLevels } from '../../../../../../../../SHARED/workbench/src/safetyLevels.js'
const menu = ref(null),
  mode = ref('ask'),
  busy = ref(false),
  error = ref('')
const panel = ref(null),
  open = ref(false),
  position = ref({})
function positionMenu() {
  open.value = Boolean(menu.value?.open)
  if (!open.value) return
  const rect = menu.value.getBoundingClientRect()
  position.value = {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - 332)) + 'px',
    bottom: Math.max(8, window.innerHeight - rect.top + 8) + 'px'
  }
}
const selected = computed(
  () => safetyLevels.find((level) => level.value === mode.value) || safetyLevels[0]
)
let timer,
  active = false,
  disposed = false,
  revision = 0
async function refresh() {
  const run = revision
  try {
    const state = await window.api.ide.gpt.services({ action: 'status' })
    if (!disposed && run === revision && !busy.value) {
      mode.value = state.bridge.safetyMode || 'ask'
      error.value = ''
    }
  } catch (cause) {
    if (!disposed) error.value = cause.message
  } finally {
    if (active && !disposed) timer = setTimeout(refresh, 2000)
  }
}
async function change(value) {
  if (busy.value) return
  busy.value = true
  revision++
  try {
    const state = await window.api.ide.gpt.services({ action: 'safety-set', safetyMode: value })
    if (!disposed) {
      mode.value = state.bridge.safetyMode
      error.value = ''
      menu.value.open = false
    }
  } catch (cause) {
    if (!disposed) error.value = cause.message
  } finally {
    busy.value = false
  }
}
function outside(event) {
  if (menu.value && !menu.value.contains(event.target) && !panel.value?.contains(event.target))
    menu.value.open = false
}
function activate() {
  if (!active) {
    active = true
    void refresh()
  }
}
function deactivate() {
  active = false
  clearTimeout(timer)
}
onMounted(() => {
  document.addEventListener('pointerdown', outside)
  window.addEventListener('resize', positionMenu)
  activate()
})
onActivated(activate)
onDeactivated(deactivate)
onBeforeUnmount(() => {
  disposed = true
  deactivate()
  document.removeEventListener('pointerdown', outside)
  window.removeEventListener('resize', positionMenu)
})
</script>
<style scoped>
.safety-level {
  position: relative;
  font-size: 12px;
  color: var(--OpenStarry-default-dark-color);
}
summary {
  cursor: pointer;
  list-style: none;
  padding: 7px 10px;
  border-radius: 8px;
  white-space: nowrap;
}
summary:hover {
  background: #8882;
}
summary span {
  margin-left: 6px;
}
.safety-options {
  position: fixed;
  z-index: 10000;
  width: 300px;
  max-width: calc(100vw - 32px);
  padding: 8px;
  border: 1px solid #8884;
  background: var(--OpenStarry-panel-layer-2-background, #25262a);
  color: var(--OpenStarry-default-dark-color, #eee);
  border-radius: 12px;
  box-shadow: 0 8px 28px #0004;
}
.safety-options > small {
  display: block;
  padding: 6px 8px;
  opacity: 0.7;
}
button {
  display: block;
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: 8px;
  padding: 9px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
button:hover,
button[aria-checked='true'] {
  background: #8882;
}
strong {
  display: flex;
  justify-content: space-between;
  font-weight: 500;
}
button small {
  display: block;
  margin-top: 5px;
  line-height: 1.5;
  opacity: 0.65;
}
p {
  color: #e77;
  margin: 6px;
}
</style>
