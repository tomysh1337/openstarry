<template><div ref="host" class="sandbox-executions" /></template>
<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { createSandboxView } from '../../../../../../../../SHARED/workbench/src/sandboxView.js'
const props = defineProps({ state: Object, projectId: String })
const host = ref(null)
let view
onMounted(() => {
  view = createSandboxView({ services: (value) => window.api.ide.gpt.services(value) })
  host.value.append(view.element)
  view.update(props.state, props.projectId)
})
watch(
  () => [props.state, props.projectId],
  () => {
    view?.update(props.state, props.projectId)
    void view?.refresh()
  }
)
onBeforeUnmount(() => view?.close())
</script>
<style scoped>
.sandbox-executions {
  border-top: 1px solid #8883;
  margin-top: 12px;
  padding-top: 12px;
}
:deep(p) {
  font-size: 12px;
  opacity: 0.8;
  white-space: pre-wrap;
}
:deep(button) {
  margin: 4px 5px 4px 0;
  padding: 5px 8px;
  border: 1px solid #8884;
  border-radius: 6px;
  color: inherit;
  background: #8881;
  cursor: pointer;
  text-align: left;
}
:deep(pre) {
  max-height: 220px;
  overflow: auto;
  padding: 8px;
  background: #8881;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
}
</style>
