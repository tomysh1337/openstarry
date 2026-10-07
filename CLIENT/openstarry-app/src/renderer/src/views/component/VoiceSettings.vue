<template><div ref="host" class="voice-settings-host" /></template>
<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { createVoicePanel } from '@openstarry/workbench/voicePanel'
const host = ref(null)
let panel
onMounted(() => {
  if (!window.api.voice) return
  panel = createVoicePanel({ api: window.api.voice, settingsOnly: true })
  host.value.append(panel.element)
})
onBeforeUnmount(() => panel?.close())
</script>
