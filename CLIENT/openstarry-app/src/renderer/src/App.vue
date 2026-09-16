<template>
  <div class="app-wrapper">
    <div v-if="runtimeStatus.phase !== 'ready'" class="startup-overlay">
      <img class="startup-logo" :src="appIcon" alt="OpenStarry NextGen" />
      <div class="startup-title">OpenStarry NextGen</div>
      <div class="startup-message">{{ runtimeStatus.message }}</div>
      <el-progress
        v-if="runtimeStatus.phase !== 'error'"
        class="startup-progress"
        :percentage="runtimeStatus.progress || 0"
        :show-text="false"
      />
      <el-button v-else type="primary" @click="retryRuntime">诊断并重试</el-button>
    </div>
    <el-config-provider :locale="lacale" :message="config">
      <div class="common-layout">
        <el-container class="root-container">
          <!-- 自定义标题栏 -->
          <el-header class="title-bar">
            <div class="window-controls">
              <button class="no-drag win-btn close-btn" type="danger" size="small" @click="close" >
              </button>
              <button class="no-drag win-btn minimize-btn" link size="small" @click="minimize">
              </button>
              <button class="no-drag win-btn maxmize-btn" link size="small" @click="maximize">
              </button>
            </div>
            <div class="drag-area">
              <button class="title no-drag" @click="showAppInfo">OpenStarry NextGen</button>
            </div>
            <div class="left-icon no-drag">
              <img
                ref="OpenStarryIcon"
                class="icon"
                :src="appIcon"
                @click="playSpin"
              />
            </div>
          </el-header>

          <el-main class="main-window">
            <div v-if="runtimeStatus.phase === 'ready'" class="page-content">
              <router-view v-slot="{ Component }">
                <keep-alive>
                  <component :is="Component" />
                </keep-alive>
              </router-view>
            </div>
          </el-main>
        </el-container>
      </div>
    </el-config-provider>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, getCurrentInstance, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { ConfirmDialog } from './views/component/comp/confirmDialog.js'
import { useAppCacheData } from './store/app.js';
import { OpenStarry_client_version, syncRevision, loadedHistorySet, generatingState } from './store/globalData.js';
import { animateNavigation } from './motion/navigation.js'
import { refreshPreferences } from './store/sharedPreferences.js'
import appIcon from './assets/background/OpenStarry.png'

const lacale = zhCn
const config = ({
  max: 1
})
const { proxy } = getCurrentInstance()
const minimize = () => window.electron.ipcRenderer.send('window-minimize')
const maximize = () => window.electron.ipcRenderer.send('window-maximize')
const close = () => window.electron.ipcRenderer.send('window-close')
const store = useAppCacheData()
const router = useRouter()
const OpenStarryIcon = ref<HTMLImageElement | null>(null)
function playSpin() {
  const el = OpenStarryIcon.value
  if (!el) {
    console.warn("el 为空")
    return
  }
  el.classList.remove('spin')
  void (el as HTMLElement).offsetWidth
  el.classList.add('spin')
  const handler = () => {
    el.classList.remove('spin')
    el.removeEventListener('animationend', handler)
  }
  el.addEventListener('animationend', handler)
}

async function showAppInfo() {
  await ConfirmDialog.confirm(
    '版本: ' + OpenStarry_client_version,
    '版本信息',
    {
      confirmButtonText: '确定',
      type: 'info',
    }
  )
}

const runtimeStatus = ref({
  phase: 'starting',
  message: '正在初始化 OpenStarry NextGen',
  progress: 0
})
const subscriptions: Array<() => void> = []
subscriptions.push(router.afterEach(async (to, from, failure) => {
  if (failure || to.path === from.path) return
  await nextTick()
  animateNavigation(document.querySelector('.page-content'), to.path, from.path)
}))

let preferencesReady = false
watch(() => runtimeStatus.value.phase, async phase => {
  if (phase !== 'ready' || preferencesReady) return
  preferencesReady = true
  try { await refreshPreferences(store, true) }
  catch { preferencesReady = false }
})

async function retryRuntime() {
  runtimeStatus.value = { phase: 'starting', message: '正在重新初始化', progress: 1 }
  try {
    runtimeStatus.value = await window.api.system.retryRuntime()
  } catch (error) {
    runtimeStatus.value = { phase: 'error', message: error.message || '初始化失败', progress: 0 }
  }
}

onMounted(async () => {

  subscriptions.push(window.api.system.onQuestionFocus(({ historyId }) => {
    store.current_history_id = historyId
    router.push('/assistPage')
  }))
  subscriptions.push(window.api.system.onSyncStatus(async status => {
    if (status.phase !== 'synced') return
    try { await refreshPreferences(store) }
    catch (error) { console.warn('Synced preferences refresh failed:', error) }
    for (const id of loadedHistorySet) if (!generatingState[id]?.isGenerating) loadedHistorySet.delete(id)
    syncRevision.value++
  }))
  let runtimeEventSeen = false
  subscriptions.push(window.api.system.onRuntimeStatus((status) => {
    runtimeEventSeen = true
    runtimeStatus.value = status
  }))

  const initialRuntimeStatus = await window.api.system.runtimeStatus()
  if (!runtimeEventSeen) {
    runtimeStatus.value = initialRuntimeStatus
  }

  subscriptions.push(window.api.system.onComputerApproval(async (request) => {
    try {
      await ConfirmDialog.confirm(
        request.request?.message || '允许 OpenStarry NextGen 执行这项电脑操作吗？',
        request.kind === 'irreversible' ? '操作确认' : '电脑控制',
        { confirmButtonText: '允许', cancelButtonText: '取消', type: 'warning' }
      )
      await window.api.system.resolveComputerApproval(request.id, true)
    } catch {
      await window.api.system.resolveComputerApproval(request.id, false)
    }
  }))
  subscriptions.push(window.api.system.onUpdateStatus(async (status) => {
    if (status.phase === 'available') {
      try {
        await ConfirmDialog.confirm(`发现新版本 ${status.info?.version || ''}，现在下载吗？`, '软件更新', {
          confirmButtonText: '下载', cancelButtonText: '稍后', type: 'info'
        })
        await window.api.system.downloadUpdate()
      } catch {}
    } else if (status.phase === 'downloaded') {
      try {
        await ConfirmDialog.confirm('更新已下载，是否立即安装并重启？', '软件更新', {
          confirmButtonText: '立即安装', cancelButtonText: '稍后', type: 'info'
        })
        await window.api.system.installUpdate()
      } catch {}
    }
  }))
  const retention = await window.api.system.retentionStatus()
  if (retention.expiredCount > 0) {
    ConfirmDialog.confirm(
      `回收站中有 ${retention.expiredCount} 个项目已保存超过 ${retention.reminderDays} 天。它们仍会保留，您可在数据管理中处理。`,
      '回收站提醒',
      { confirmButtonText: '知道了', type: 'info' }
    ).catch(() => {})
  }
})

onBeforeUnmount(() => {
  subscriptions.splice(0).forEach((unsubscribe) => unsubscribe())
})
</script>

<style scoped>
@media (prefers-reduced-motion: reduce) {
  :deep(*), :deep(*::before), :deep(*::after) {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
.app-wrapper {
  background-color: transparent;
}

.startup-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  color: var(--OpenStarry-darkest-color);
  background: var(--OpenStarry-panel-base-layer-background);
}

.startup-logo {
  width: 88px;
  height: 88px;
  border-radius: 22px;
}

.startup-title {
  font-size: 25px;
  font-weight: 700;
}

.startup-message {
  color: var(--OpenStarry-secondary-dark-color);
}

.startup-progress {
  width: min(420px, 70vw);
}

.app-wrapper {
  position: relative;
  overflow: hidden;
}

.app-wrapper > * {
  position: relative;
  z-index: 1;
}

.top_window {
  padding: 0;
}

.common-layout {
  padding: 0;
}

.root-container {
  padding: 0;
}

.title-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: relative;
  height: 30px;
  padding: 0 8px;
  color: var(--OpenStarry-darkest-color);
  background-color: transparent;
  border-radius: var(--OpenStarry-border-radius-base) var(--OpenStarry-border-radius-base) 0 0;
  -webkit-app-region: drag;
}

.left-icon {
  display: flex;
  align-items: center;
  width: 20px;
  height: 20px;
}

.icon {
  cursor: pointer;
  display: inline-block;
  transform-origin: 50% 50%;
  width: 20px;
  height: 20px;
  border-radius: var(--OpenStarry-border-radius-base);
  object-fit: contain;
  overflow: hidden;
  opacity: 0.7;
  transition: opacity .25s var(--OpenStarry-cubic-bezier);
}

.icon:hover {
  opacity: 1;
}

.title {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  font-weight: bold;
  font-size: 14px;
  padding-left: 5px;
  padding-right: 5px;
  color: var(--OpenStarry-darkest-color);
  background-color: transparent;
  height: 24px;
  border: none;
}

.drag-area {
  flex: 1;
  display: flex;
  align-items: center;
  border-radius: var(--OpenStarry-border-radius-base);
}

.window-controls {
  margin-left: 5px;
  display: flex;
  gap: 6px;
}

.no-drag {
  -webkit-app-region: no-drag; /* 按钮区域不可拖拽 */
  /* color: white; */
}

.win-btn {
  border-radius: 100%;
  padding: 0;
  width: 14px;
  height: 14px;
  border: none;
}

.maxmize-btn {
  background-color: var(--OpenStarry-success-color);
}

.minimize-btn {
  background-color: var(--OpenStarry-warning-color);
}

.close-btn {
  background-color: var(--OpenStarry-danger-color);
}

.maxmize-btn:hover {
  background-color: var(--OpenStarry-success-hover);
}

.minimize-btn:hover {
  background-color: var(--OpenStarry-warning-hover);
}

.close-btn:hover {
  background-color: var(--OpenStarry-danger-hover);
}

.main-window {
  background-color: transparent;
  padding: 0%;
  border-radius: var(--OpenStarry-border-radius-base);
  position: relative;
  min-height: calc(100vh - 30px);
  max-height: calc(100vh - 30px);
}

.icon {
  cursor: pointer;
  display: inline-block;
  transform-origin: 50% 50%;
}

/* 动画类 */
.spin {
  animation: spin-one 800ms cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes spin-one {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
</style>
