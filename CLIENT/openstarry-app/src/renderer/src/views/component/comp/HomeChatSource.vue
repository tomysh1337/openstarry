<template>
  <div class="home-chat-source" data-testid="home-chat-source">
    <div class="source-row">
      <div class="source-picker" role="group" aria-label="首页对话来源">
        <button :aria-pressed="source === 'api'" :disabled="switching" @click="$emit('change', 'api')">API</button>
        <button :aria-pressed="source === 'chatgpt-web'" :disabled="!ready || switching" @click="$emit('change', 'chatgpt-web')">GPT 网页版</button>
      </div>
      <template v-if="source === 'chatgpt-web'">
        <span class="local-label">本机历史</span>
        <button :disabled="connecting" @click="$emit('login')">连接 Edge / 复制配对码</button>
        <button :disabled="connecting" @click="$emit('refresh')">刷新连接</button>
        <button v-if="resume" :disabled="busy" @click="$emit('resume')">恢复回复</button>
        <button v-if="resume" :disabled="busy" @click="$emit('stop')">停止网页回复</button>
      </template>
    </div>
    <template v-if="source === 'chatgpt-web'">
      <p class="source-hint">使用普通 Edge 的 OpenStarry Bridge 扩展 · 模型在网页中选择 · 深度思考由输入框开关控制 · 本机历史</p>
      <p class="connection-state" role="status">{{ connecting ? '正在准备扩展连接…' : connection?.message || '点击连接 Edge，将配对码粘贴到扩展中' }}</p>
      <p v-if="status" role="status">{{ status }}</p>
      <p v-if="storageError" role="alert">本机保存失败：{{ storageError }}</p>
    </template>
  </div>
</template>
<script setup>
defineProps(['source', 'ready', 'switching', 'connection', 'connecting', 'resume', 'busy', 'status', 'storageError'])
defineEmits(['change', 'login', 'refresh', 'resume', 'stop'])
</script>
<style scoped>
.home-chat-source { width: min(840px, calc(100% - 32px)); box-sizing: border-box; color: var(--OpenStarry-default-button-text); font-size: 12px; }
.source-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.source-picker { display: flex; padding: 3px; border-radius: 9px; background: var(--OpenStarry-panel-layer-3-background); border: 1px solid var(--OpenStarry-default-light-color); }
button { cursor: pointer; border: 0; border-radius: 6px; padding: 6px 10px; background: transparent; color: inherit; font: inherit; transition: background .16s ease; }
button:hover, button[aria-pressed="true"] { background: var(--OpenStarry-primary-light); color: var(--OpenStarry-primary-color); }
button:focus-visible { outline: 2px solid var(--OpenStarry-primary-color); outline-offset: 2px; }
button:disabled { opacity: .5; cursor: default; }
.local-label { opacity: .7; padding: 0 4px; }
p { margin: 5px 0 0; line-height: 1.5; overflow-wrap: anywhere; }
.source-hint { opacity: .65; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
