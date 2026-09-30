<template>
  <div class="web-tool-calls" aria-label="GPT 插件调用">
    <details v-for="tool in tools" :key="tool.id" class="web-tool-call">
      <summary>
        <span class="tool-icon" aria-hidden="true">◇</span>
        <span
          ><small>{{ tool.provider || 'MCP' }}</small
          ><strong>{{ tool.name }}</strong></span
        >
        <span class="tool-state"
          >{{ labels[tool.phase] || tool.phase
          }}<span v-if="Number.isFinite(tool.durationMs)">
            · {{ (tool.durationMs / 1000).toFixed(2) }}s</span
          ></span
        >
      </summary>
      <section v-for="field in fields" :key="field.key" class="tool-field">
        <header>
          <span>{{ field.label }}</span
          ><button type="button" @click="copy(tool[field.key])">复制</button>
        </header>
        <pre>{{
          tool[field.key] ||
          (field.key === 'output' && tool.phase === 'running' ? '等待插件回复…' : '（空）')
        }}</pre>
      </section>
    </details>
    <p v-if="notice" role="status">{{ notice }}</p>
  </div>
</template>

<script setup>
import { ref } from 'vue'
defineProps({ tools: { type: Array, default: () => [] } })
const labels = { running: '调用中', complete: '已完成', error: '失败', stopped: '已停止' }
const fields = [
  { key: 'input', label: '请求' },
  { key: 'output', label: '回复' }
]
const notice = ref('')
async function copy(value) {
  try {
    await navigator.clipboard.writeText(value || '')
    notice.value = '已复制'
  } catch {
    notice.value = '复制失败，请选择文本后复制'
  }
}
</script>

<style scoped>
.web-tool-calls {
  display: grid;
  gap: 8px;
  margin: 8px 0 14px;
}
.web-tool-call {
  border: 1px solid var(--OpenStarry-default-light-color);
  border-radius: 12px;
  padding: 12px;
}
summary {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  list-style: none;
}
summary::after {
  content: '⌄';
  margin-left: 6px;
}
details[open] summary::after {
  transform: rotate(180deg);
}
.tool-icon {
  padding: 9px;
  border-radius: 9px;
  background: var(--OpenStarry-panel-layer-3-background);
}
small {
  display: block;
  opacity: 0.65;
  font-size: 11px;
}
strong {
  font-size: 13px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.tool-state {
  margin-left: auto;
  font-size: 11px;
  opacity: 0.65;
}
.tool-field {
  margin-top: 10px;
  padding: 10px;
  background: var(--OpenStarry-panel-layer-3-background);
  border-radius: 9px;
}
header {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  opacity: 0.8;
}
button {
  border: 0;
  background: transparent;
  color: inherit;
  font-size: inherit;
  cursor: pointer;
}
pre {
  margin: 8px 0 0;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  user-select: text;
}
p {
  font-size: 12px;
}
</style>
