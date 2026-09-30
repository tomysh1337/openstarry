<template>
  <details
    ref="menu"
    class="mcp-services"
    data-testid="mcp-services"
    @keydown.esc.stop.prevent="closeMenu"
  >
    <summary aria-label="MCP Bridge 和 Cloudflare Tunnel 服务管理">
      <span class="service-badge"><i :class="{ online: bridgeReady }" />MCP Bridge</span>
      <span class="service-badge"
        ><i
          :class="{ online: tunnelConnected, pending: tunnelRunning && !tunnelConnected }"
        />Cloudflare Tunnel</span
      >
      <span v-if="pending.length" class="review-badge">待审查 {{ pending.length }}</span>
      <span v-if="children.length" class="review-badge"
        >子 Agent {{ children.length }} · {{ activeChildren }} 进行中</span
      >
      <span class="chevron" aria-hidden="true">⌄</span>
    </summary>
    <div class="services-panel" :aria-busy="Boolean(busy)">
      <div class="panel-heading">
        <strong>网页连接服务</strong
        ><button type="button" :disabled="Boolean(busy) || refreshing" @click="refresh">
          刷新
        </button>
      </div>
      <section class="service-row">
        <div>
          <strong>MCP Bridge</strong><small>{{ bridgeReady ? '本地服务已就绪' : '已关闭' }}</small>
        </div>
        <button
          class="service-switch"
          type="button"
          role="switch"
          aria-label="MCP Bridge"
          :aria-checked="bridgeReady"
          :disabled="locked || (bridgeReady && state.bridge.busy)"
          @click="run(bridgeReady ? 'bridge-stop' : 'bridge-start')"
        >
          <span />
        </button>
      </section>
      <p class="scope">
        文件范围：{{
          state.bridge.fileScope === 'all-disks' ? '全盘（当前 Windows 用户权限）' : '当前工作区'
        }}
      </p>
      <p v-if="bridgeReady" class="scope">当前任务工作区：{{ state.bridge.projectName }}</p>
      <p class="hint">
        {{
          state.bridge.safetyMode === 'full'
            ? '文件按版本检查直接保存；显式提交的提议仍需审查。'
            : state.bridge.newFilePolicy === 'direct'
              ? '新文件直接保存，覆盖已有文件需审查。'
              : '新建和修改文件均需本机审查。'
        }}
      </p>
      <p v-if="state.bridge.busy" class="hint">
        有回复或子 Agent 尚未结束，先停止对应任务，再关闭 Bridge。
      </p>
      <section class="service-row">
        <div>
          <strong>Cloudflare Tunnel</strong><small>{{ tunnelLabel }}</small>
        </div>
        <button
          class="service-switch"
          type="button"
          role="switch"
          aria-label="Cloudflare Tunnel"
          :aria-checked="tunnelRunning"
          :disabled="locked"
          @click="run(tunnelRunning ? 'tunnel-stop' : 'tunnel-start')"
        >
          <span />
        </button>
      </section>
      <p class="hint">开启 Tunnel 会同时启动 Bridge。关闭 Bridge 会一并关闭 Tunnel。</p>
      <p v-if="tunnelConnected && state.tunnel.origin" class="public-origin">
        {{ state.tunnel.origin }}
      </p>
      <div class="service-actions">
        <button type="button" :disabled="locked || !tunnelConnected" @click="run('copy-address')">
          复制 MCP 公网地址
        </button>
        <button type="button" :disabled="locked" @click="run('pair')">复制 Edge 配对码</button>
      </div>
      <p class="hint">临时公网地址在重开 Tunnel 后可能变化；完整地址仅复制到剪贴板。</p>
      <p v-if="state.browser" class="hint">
        {{ state.browser.extensionConnected ? 'Edge 扩展已连接' : 'Edge 扩展待连接' }}
      </p>
      <section v-if="children.length" class="file-review" aria-label="子 Agent">
        <strong>子 Agent · {{ activeChildren }} 个进行中</strong>
        <p class="hint">独立 ChatGPT 会话，最多同时运行两个。点击任务查看结果或停止。</p>
        <div class="proposal-list">
          <button
            v-for="child in children"
            :key="child.id"
            type="button"
            :disabled="locked"
            @click="readChild(child)"
          >
            {{ child.name }} · {{ childLabel(child.status) }}
          </button>
        </div>
        <article v-if="selectedChild" class="proposal-detail">
          <strong>{{ selectedChild.name }} · {{ childLabel(selectedChild.status) }}</strong>
          <p v-if="selectedChild.error" class="error">{{ selectedChild.error.message }}</p>
          <pre>{{
            selectedChild.text ||
            (selectedChild.done ? '此任务未返回正文。' : '等待子 Agent 返回内容…')
          }}</pre>
          <p v-if="selectedChild.pending_proposals?.length" class="hint">
            有 {{ selectedChild.pending_proposals.length }} 个文件提议等待本机审查。
          </p>
          <p v-if="selectedChild.total_characters" class="hint">
            第 {{ selectedChild.offset + 1 }}–{{
              selectedChild.offset + selectedChild.text.length
            }}
            字 / 共 {{ selectedChild.total_characters }} 字
          </p>
          <div class="service-actions">
            <button
              v-if="selectedChild.offset"
              type="button"
              :disabled="locked"
              @click="readChild(selectedChild)"
            >
              从头查看
            </button>
            <button
              v-if="selectedChild.next_offset !== null"
              type="button"
              :disabled="locked"
              @click="readChild(selectedChild, selectedChild.next_offset)"
            >
              后续内容
            </button>
            <button
              type="button"
              :disabled="
                locked || selectedChild.done || selectedChild.status === 'cancel_requested'
              "
              @click="readChild(selectedChild, selectedChild.offset, 'subagent-cancel')"
            >
              停止子 Agent
            </button>
          </div>
        </article>
      </section>
      <section v-if="pending.length" class="file-review" aria-label="待审查文件">
        <strong>待审查文件 · {{ pending.length }}</strong>
        <div class="proposal-list">
          <button
            v-for="proposal in pending"
            :key="proposal.id"
            type="button"
            :disabled="locked"
            :aria-pressed="selected?.id === proposal.id"
            @click="
              run('review-read', { proposalId: proposal.id, projectId: state.bridge.projectId })
            "
          >
            {{ proposal.absolutePath || proposal.path }}
          </button>
        </div>
        <article v-if="selected" class="proposal-detail">
          <p class="review-path">{{ selected.absolutePath || selected.path }}</p>
          <strong>当前内容</strong>
          <pre class="before">{{
            selected.before === null ? '（新文件）' : selected.before || '（空文件）'
          }}</pre>
          <strong>提议内容</strong>
          <pre class="after">{{ selected.after || '（空文件）' }}</pre>
          <div class="service-actions">
            <button type="button" :disabled="locked" @click="decide('accept')">接受并保存</button>
            <button type="button" :disabled="locked" @click="decide('reject')">拒绝提议</button>
          </div>
        </article>
      </section>
      <p v-if="busy" class="feedback" role="status">{{ busyLabel }}</p>
      <p v-else-if="feedback" class="feedback" role="status">{{ feedback }}</p>
      <p v-if="error || pollError || state.tunnel.message" class="error" role="alert">
        {{ error || pollError || state.tunnel.message }}
      </p>
      <SandboxExecutions :state="state.sandbox" :project-id="state.bridge.projectId" />
    </div>
  </details>
  <section v-if="children.length" class="child-progress" aria-label="子 Agent 进度">
    <div class="child-progress-heading">
      <strong>子 Agent · {{ activeChildren }} 个进行中</strong>
      <small>{{ state.bridge.projectName }}</small>
    </div>
    <div class="child-progress-list">
      <button
        v-for="child in orderedChildren"
        :key="child.id"
        type="button"
        :disabled="locked"
        @click="openChild(child)"
      >
        <strong>{{ child.name }}</strong>
        <small>{{ subagentProgress(child) }}</small>
        <span v-if="child.error" class="error"
          >{{ child.error.code }} · {{ child.error.message }}</span
        >
        <span v-else-if="child.progress?.preview" class="child-preview">{{
          child.progress.preview
        }}</span>
      </button>
    </div>
  </section>
</template>

<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import SandboxExecutions from './SandboxExecutions.vue'
import {
  subagentLabel as childLabel,
  subagentProgress,
  orderSubagents
} from '../../../../../../../../SHARED/workbench/src/subagentProgress.js'

const props = defineProps({ project: Object, ready: Boolean })
const emit = defineEmits(['changed'])
const menu = ref(null),
  state = ref({ bridge: { status: 'stopped', busy: false }, tunnel: { status: 'stopped' } })
const busy = ref(''),
  refreshing = ref(false),
  feedback = ref(''),
  error = ref(''),
  pollError = ref('')
const bridgeReady = computed(() => state.value.bridge.status === 'ready')
const pending = computed(() => state.value.pendingProposals || [])
const selected = ref(null)
const children = computed(() => state.value.subagents?.subagents || [])
const activeChildren = computed(() => children.value.filter((child) => !child.done).length)
const orderedChildren = computed(() => orderSubagents(children.value))
const selectedChild = ref(null)
let childProjectId
let selectedProjectId
const tunnelConnected = computed(() => state.value.tunnel.status === 'connected')
const tunnelRunning = computed(() => Boolean(state.value.tunnel.running))
const locked = computed(() => !props.ready || Boolean(busy.value) || refreshing.value)
const tunnelLabel = computed(
  () =>
    ({
      stopped: '已关闭',
      starting: '正在启动…',
      connecting: '正在连接…',
      connected: '隧道已连接',
      reconnecting: '正在重连…',
      expired: '地址已失效，请关闭后重开',
      error: '启动失败'
    })[state.value.tunnel.status] || '状态待确认'
)
const busyLabel = computed(
  () =>
    ({
      'bridge-start': '正在启动 MCP Bridge…',
      'bridge-stop': '正在关闭服务…',
      'tunnel-start': '正在启动公网隧道…',
      'tunnel-stop': '正在关闭公网隧道…',
      pair: '正在准备配对码…',
      'review-read': '正在读取文件提议…',
      'review-accept': '正在核对文件版本并保存…',
      'review-reject': '正在拒绝提议…',
      'subagent-read': '正在读取子 Agent 结果…',
      'subagent-cancel': '正在停止子 Agent…',
      'copy-address': '正在复制公网地址…'
    })[busy.value]
)
let timer,
  active = false,
  disposed = false
function closeMenu() {
  if (menu.value) menu.value.open = false
}
function outside(event) {
  if (!menu.value?.contains(event.target)) closeMenu()
}
function schedule() {
  clearTimeout(timer)
  if (active && !disposed) timer = setTimeout(refresh, 2000)
}
function updateState(value) {
  state.value = value
  if (
    selectedChild.value &&
    (childProjectId !== value.bridge.projectId ||
      !children.value.some((child) => child.id === selectedChild.value.id))
  )
    selectedChild.value = null
  if (value.subagent && children.value.some((child) => child.id === value.subagent.id)) {
    selectedChild.value = value.subagent
    childProjectId = value.bridge.projectId
  }
  if (
    selected.value &&
    (selectedProjectId !== value.bridge.projectId ||
      !pending.value.some((p) => p.id === selected.value.id))
  ) {
    selected.value = null
  }
}
function openChild(child) {
  if (menu.value) menu.value.open = true
  return readChild(child)
}
function readChild(child, offset = 0, action = 'subagent-read') {
  return run(action, {
    parentTaskId: child.task_id,
    subagentId: child.id,
    projectId: state.value.bridge.projectId,
    offset
  })
}
function decide(decision) {
  if (selected.value)
    return run('review-' + decision, {
      proposalId: selected.value.id,
      projectId: selectedProjectId
    })
}
async function refresh() {
  if (disposed || !active) return
  if (busy.value || refreshing.value) {
    schedule()
    return
  }
  refreshing.value = true
  try {
    const child = selectedChild.value
    const value = await window.api.ide.gpt.services(
      child
        ? {
            action: 'subagent-read',
            parentTaskId: child.task_id,
            subagentId: child.id,
            projectId: childProjectId,
            offset: child.offset
          }
        : { action: 'status' }
    )
    if (!disposed) {
      updateState(value)
      pollError.value = ''
    }
  } catch (cause) {
    if (!disposed) {
      pollError.value = cause.message
      selectedChild.value = null
    }
  } finally {
    refreshing.value = false
    schedule()
  }
}
async function run(action, payload = {}) {
  if (locked.value) return
  busy.value = action
  feedback.value = ''
  error.value = ''
  try {
    const value = await window.api.ide.gpt.services({ action, project: props.project, ...payload })
    if (!disposed) {
      updateState(value)
      if (value.proposal) {
        selected.value = value.proposal
        selectedProjectId = value.bridge.projectId
      }
      pollError.value = ''
      feedback.value = value.message || ''
      emit('changed')
    }
  } catch (cause) {
    if (!disposed) error.value = cause.message
  } finally {
    busy.value = ''
    schedule()
  }
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
  closeMenu()
}
onMounted(() => {
  document.addEventListener('pointerdown', outside)
  activate()
})
onActivated(activate)
onDeactivated(deactivate)
onBeforeUnmount(() => {
  disposed = true
  deactivate()
  document.removeEventListener('pointerdown', outside)
})
</script>

<style scoped>
.child-progress {
  flex: 1 0 100%;
  min-width: 0;
  font-size: 12px;
  color: var(--OpenStarry-default-button-text);
  background: var(--OpenStarry-panel-layer-2-background);
  border: 1px solid var(--OpenStarry-default-light-color);
  border-radius: 10px;
  padding: 10px;
  box-sizing: border-box;
}
.child-progress-heading {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.child-progress-heading small {
  margin: 0;
}
.child-progress-list {
  display: grid;
  gap: 6px;
  max-height: 130px;
  overflow: auto;
  margin-top: 6px;
}
.child-progress-list button {
  text-align: left;
  min-width: 0;
}
.child-progress-list span {
  display: block;
  margin-top: 5px;
  overflow-wrap: anywhere;
}
.child-preview {
  overflow: hidden;
  white-space: pre-wrap;
  max-height: 3em;
  line-height: 1.5;
  opacity: 0.8;
}
.mcp-services {
  position: relative;
  margin-left: auto;
  flex: 0 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--OpenStarry-default-button-text);
}
summary {
  list-style: none;
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid var(--OpenStarry-default-light-color);
  border-radius: 18px;
  cursor: pointer;
  background: var(--OpenStarry-panel-layer-2-background);
}
summary::-webkit-details-marker {
  display: none;
}
.service-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.service-badge i {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: #8c919e;
}
.service-badge i.online {
  background: #339977;
}
.service-badge i.pending {
  background: #c58c24;
}
.chevron {
  opacity: 0.6;
}
.services-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: min(348px, calc(100vw - 132px));
  box-sizing: border-box;
  padding: 16px;
  border-radius: 14px;
  border: 1px solid var(--OpenStarry-default-light-color);
  background: var(--OpenStarry-panel-layer-2-background);
  box-shadow: var(--OpenStarry-shadow-md);
  max-height: calc(100vh - 120px);
  overflow-y: auto;
}
.panel-heading,
.service-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.panel-heading {
  margin-bottom: 12px;
}
.service-row {
  padding: 12px 0 8px;
  border-top: 1px solid var(--OpenStarry-default-light-color);
}
strong {
  font-weight: 600;
}
small {
  display: block;
  margin-top: 5px;
  opacity: 0.72;
  font-size: 12px;
}
button {
  font: inherit;
  color: inherit;
  cursor: pointer;
  border: 1px solid var(--OpenStarry-default-light-color);
  border-radius: 7px;
  background: var(--OpenStarry-panel-layer-3-background);
  padding: 6px 9px;
}
button:hover {
  color: var(--OpenStarry-primary-color);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--OpenStarry-primary-color);
  outline-offset: 3px;
}
.service-switch {
  width: 36px;
  height: 22px;
  padding: 3px;
  border: 0;
  border-radius: 12px;
  flex: 0 0 36px;
  background: #9499a8;
  transition: background 0.18s ease;
}
.service-switch[aria-checked='true'] {
  background: var(--OpenStarry-primary-color);
}
.service-switch span {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: white;
  transition: transform 0.18s ease;
}
.service-switch[aria-checked='true'] span {
  transform: translateX(14px);
}
p {
  margin: 6px 0 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.hint {
  opacity: 0.65;
}
.scope,
.public-origin {
  font-size: 11px;
  opacity: 0.8;
}
.service-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.feedback {
  color: var(--OpenStarry-primary-color);
  margin-bottom: 0;
}
.error {
  color: var(--OpenStarry-danger-dark-text);
  margin-bottom: 0;
}
.review-badge {
  color: var(--OpenStarry-primary-color);
  white-space: nowrap;
}
.file-review {
  border-top: 1px solid var(--OpenStarry-default-light-color);
  padding-top: 12px;
  margin-top: 12px;
}
.proposal-list {
  display: grid;
  gap: 6px;
  max-height: 150px;
  overflow-y: auto;
  margin: 10px 0;
}
.proposal-list button,
.review-path {
  text-align: left;
  overflow-wrap: anywhere;
}
.proposal-list button[aria-pressed='true'] {
  border-color: var(--OpenStarry-primary-color);
}
.proposal-detail pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 200px;
  overflow-y: auto;
  padding: 8px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  user-select: text;
}
.before {
  background: rgba(210, 70, 70, 0.12);
}
.after {
  background: rgba(45, 165, 100, 0.14);
}
@media (max-width: 820px) {
  summary {
    gap: 8px;
    padding: 0 9px;
    font-size: 11px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .service-switch,
  .service-switch span {
    transition: none;
  }
}
</style>
