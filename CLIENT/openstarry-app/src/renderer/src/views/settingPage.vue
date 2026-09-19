<template>
  <el-container>
    <el-aside class="aside-area">
      <HomePage />
    </el-aside>

    <el-main
      v-if="showPage"
      ref="page"
      class="main-area"
    >
    <div class="setting-page-wrapper">
      <div class="title-tag-wrapper">
        <div style="width: 100%; max-width: 1000px; margin-bottom: 40px;">
          <div class="OpenStarry-banner">
            <div class="corner-accent"></div>

            <div class="banner-content">

              <div class="banner-text">
                <div class="banner-title-wrapper">
                  <h1 class="banner-title">OpenStarry NextGen</h1>
                  <span class="version-tag">{{ OpenStarry_client_version }}</span>
                </div>

                <div class="divider"></div>

                <p class="banner-subtitle">
                  一款<strong>兼容多引擎</strong>的 Agent 平台，支持处理
                  <strong>网页制作</strong>、<strong>代码编写</strong>、<strong>文档处理</strong>、<strong>海报设计</strong> 等复杂任务
                </p>

                <div class="banner-meta">
                  <a class="dev-badge" href="https://github.com/tomysh1337/openstarry">GitHub</a>

                  <div class="engine-tags">
                    <span class="engine-tag">Ollama</span>
                    <span class="engine-tag">OpenAI</span>
                    <span class="engine-tag">DeepSeek</span>
                    <span class="engine-tag">MoonShot</span>
                    <span class="engine-tag">更多引擎等待兼容...</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        class="app-layout"
      >
        <div class="setting-group">
          <div class="group-divider">
            <span class="group-label">OpenStarry NextGen</span>
          </div>

          <div class="setting-card">
            <div class="setting-title">关闭主窗口时</div>
            <div class="setting-control">
              <div class="setting-info">缩小到系统托盘可让未完成任务继续运行。</div>
              <el-select class="select-input compact-control" v-model="desktopSettings.closeBehavior" @change="saveDesktopSettings">
                <el-option label="缩小到系统托盘" value="tray" />
                <el-option label="退出软件" value="quit" />
              </el-select>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">开机静默启动</div>
            <div class="setting-control">
              <div class="setting-info">登录 Windows 后自动在系统托盘启动。</div>
              <el-switch v-model="desktopSettings.launchAtLogin" @change="saveDesktopSettings" />
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">API 密钥保护</div>
            <div class="setting-control">
              <div class="setting-info">使用 Windows 凭据加密，可优先通过 Windows Hello 解锁。</div>
              <el-switch v-model="desktopSettings.vault.enabled" @change="saveDesktopSettings" />
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">本地数据与备份</div>
            <div class="setting-control">
              <div class="setting-info">聊天、附件和配置保存在本机；每日压缩备份并保留 30 份。</div>
              <div class="button-row">
                <el-button @click="openLocalData">打开</el-button>
                <el-button @click="exportLocalData">导出</el-button>
                <el-button @click="restoreLocalData">恢复</el-button>
              </div>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">组件状态</div>
            <div class="setting-control">
              <div class="setting-info">{{ runtimeStatus.message || '正在读取状态' }}</div>
              <div class="button-row">
                <el-button @click="openDiagnostics">诊断</el-button>
                <el-button @click="retryComponents">重试</el-button>
                <el-button @click="checkUpdates">检查更新</el-button>
              </div>
            </div>
          </div>
        </div>

        <div class="setting-group">
          <div class="group-divider"><span class="group-label">手机与跨设备同步</span></div>
          <div class="setting-card sync-setting-card">
            <div class="setting-title">跨设备聊天同步</div>
            <div class="sync-form">
              <div class="setting-info">
                手机和电脑互通聊天、供应商、模型与通用偏好。API 密钥各设备单独保存；离线记录会在联网后续传。
              </div>
              <div class="sync-row">
                <el-switch v-model="desktopSettings.sync.enabled" />
                <el-input
                  v-model="desktopSettings.sync.serverUrl"
                  placeholder="https://同步服务器"
                  class="sync-url-input"
                />
                <el-input
                  v-model="desktopSettings.sync.userId"
                  placeholder="用户 ID"
                  class="sync-user-input"
                />
              </div>
              <div class="sync-row">
                <el-input
                  v-model="syncToken"
                  type="password"
                  show-password
                  :placeholder="syncStatus.credentialStored ? '访问令牌已安全保存' : '访问令牌'"
                  class="sync-token-input"
                />
                <span class="setting-info">间隔（分钟）</span>
                <el-input-number
                  v-model="desktopSettings.sync.intervalMinutes"
                  :min="1"
                  :max="1440"
                  controls-position="right"
                />
              </div>
              <div class="sync-row">
                <el-button type="primary" @click="saveSyncSettings">保存并同步</el-button>
                <el-button @click="runCloudSync">立即同步</el-button>
                <el-button @click="resetCloudSync">重新全量核对</el-button>
                <span class="setting-info" :class="{ danger_info: syncStatus.phase === 'offline' }">
                  {{ syncStatus.message }}
                  <template v-if="syncStatus.queued">（待同步 {{ syncStatus.queued }} 项）</template>
                </span>
              </div>
            </div>
          </div>

        </div>

        <!-- 组1: 界面设置 -->
        <div class="setting-group">
          <div class="group-divider">
            <span class="group-label">界面设置</span>
          </div>

          <div class="setting-card">
            <div class="setting-title">在AI消息中显示工具调用标签</div>
            <div class="setting-control">
              <div class="setting-info">
                开启后实时显示AI当前正在调用的工具名称。
              </div>
              <div class="mode-switch">
                <div class="slider" :class="{ right: store.config.showToolLabels }" />

                <button
                  class="off-select"
                  :class="{ active: !store.config.showToolLabels }"
                  @click="switchMode('showToolLabels', 'off')"
                >
                  Off
                </button>

                <button
                  class="on-select"
                  :class="{ active: store.config.showToolLabels }"
                  @click="switchMode('showToolLabels', 'on')"
                >
                  On
                </button>
              </div>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">启用深色主题   <span class="setting-label">Beta</span></div>
            <div class="setting-control">
              <div class="setting-info">
                开启有颜色主题可能适配不佳。
              </div>
              <div class="mode-switch">
                <div class="slider" :class="{ right: store.config.dark_theme }" />

                <button
                  class="off-select"
                  :class="{ active: !store.config.dark_theme }"
                  @click="switchMode('dark_theme', 'off')"
                >
                  Off
                </button>

                <button
                  class="on-select"
                  :class="{ active: store.config.dark_theme }"
                  @click="switchMode('dark_theme', 'on')"
                >
                  On
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 组2: 数据管理 -->
        <div class="setting-group">
          <div class="group-divider">
            <span class="group-label">数据管理</span>
          </div>
          <!-- Reset -->
          <div class="setting-card">
            <div class="setting-title">重载预设卡片</div>
            <div class="setting-control">
              <div class="setting-info">
                恢复预设卡片到初始状态，已修改或新增的卡片不会被删除。
              </div>
              <el-button
                type="primary"
                off
                size="default"
                @click="resetPresetCard"
                class="confirm-button"
              >
                恢复
              </el-button>
            </div>
          </div>

          <!-- Clear cache -->
          <div class="setting-card">
            <div class="setting-title">打开缓存文件夹</div>
            <div class="setting-control">
              <div class="setting-info">
                打开保存卡片以及任务的文件夹位置。
              </div>
              <el-button
                type="primary"
                off
                size="default"
                @click="openCacheDir"
                class="confirm-button"
              >
                打开
              </el-button>
            </div>
          </div>
        </div>

        <!-- 组3: 网络代理 -->
        <div class="setting-group">
          <div class="group-divider">
            <span class="group-label">网络代理</span>
          </div>
          <!-- Port -->
          <div class="setting-card">
            <div class="setting-title">为AI服务设置全局网络代理</div>
            <div class="setting-control">
              <el-input
                placeholder="http://expmale.com:7890 ,http://expmale.com:7890 "
                v-model="store.config.httpProxyUrl"
                class="line-input"
              >
              </el-input>
              <el-button
                type="primary"
                off
                size="default"
                @click="setNetProxy"
                class="confirm-button"
              >
                保存
              </el-button>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">全局代理排除以下地址</div>
            <div class="setting-control">
              <el-input
                placeholder="localhost,127.0.0.1,expmale.com"
                v-model="store.config.excludeUrl"
                class="line-input"
              >
              </el-input>
              <el-button
                type="primary"
                off
                size="default"
                @click="setNetProxy"
                class="confirm-button"
              >
                保存
              </el-button>
            </div>
          </div>
        </div>

        <div class="setting-group"><div ref="ideToolsHost" /></div>
        <!-- 组4: AI设置 -->
        <div class="setting-group">
          <div class="group-divider">
            <span class="group-label">Agent 设置</span>
          </div>
          <div class="setting-card">
            <div class="setting-title">电脑控制模式</div>
            <div class="setting-control">
              <div class="setting-info">明确提到电脑控制或任务确有需要时，可自动操作桌面与浏览器。</div>
              <el-select class="select-input compact-control" v-model="desktopSettings.computerControlMode" @change="saveDesktopSettings">
                <el-option label="自动允许" value="auto" />
                <el-option label="每次询问" value="ask" />
                <el-option label="关闭" value="off" />
              </el-select>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">自动续写与长任务</div>
            <div class="setting-control">
              <div class="setting-info">让 Agent 在工具调用后继续执行，直到任务完成或达到运行上限。</div>
              <el-switch v-model="desktopSettings.autoContinue.enabled" @change="saveDesktopSettings" />
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">不可逆操作确认</div>
            <div class="setting-control">
              <div class="setting-info">付款、永久删除、外部发送、账号与系统设置等操作执行前询问。</div>
              <el-switch v-model="desktopSettings.confirmIrreversibleActions" @change="saveDesktopSettings" />
            </div>
          </div>


          <div class="setting-card">
            <div class="setting-title">允许 Agent 操作文件</div>
            <div class="setting-control">
              <div class="setting-info">允许Agent对工作区文件进行修改，包括读取用户上传文件、查看工作区目录、新建或<strong>删改</strong>工作区文件。</div>
              <div class="mode-switch">
                <div class="slider" :class="{ right: store.config.fileOpration }" />

                <button
                  class="off-select"
                  :class="{ active: !store.config.fileOpration }"
                  @click="switchMode('fileOpration', 'off')"
                >
                  Off
                </button>

                <button
                  class="on-select"
                  :class="{ active: store.config.fileOpration }"
                  @click="switchMode('fileOpration', 'on')"
                >
                  On
                </button>
              </div>
            </div>
          </div>
          <div class="setting-card">
            <div class="setting-title">允许 Agent 执行命令</div>
            <div class="setting-control">
              <div class="setting-info">开放命令行权限给Agent，允许Agent在沙箱内执行命令。</div>
              <div class="mode-switch">
                <div class="slider" :class="{ right: store.config.commandOpration }" />

                <button
                  class="off-select"
                  :class="{ active: !store.config.commandOpration }"
                  @click="switchMode('commandOpration', 'off')"
                >
                  Off
                </button>

                <button
                  class="on-select"
                  :class="{ active: store.config.commandOpration }"
                  @click="switchMode('commandOpration', 'on')"
                >
                  On
                </button>
              </div>
            </div>
          </div>
          <div class="setting-card">
            <div class="setting-title">允许 Agent 浏览网页</div>
            <div class="setting-control">
              <div class="setting-info" :class="{ danger_info: store.config.webSearch && store.config.knowledgeRetrieval}">
                允许Agent使用网络搜索工具在互联网上搜索信息。
              </div>
              <div class="mode-switch">
                <div class="slider" :class="{ right: store.config.webSearch }" />

                <button
                  class="off-select"
                  :class="{ active: !store.config.webSearch }"
                  @click="switchMode('webSearch', 'off')"
                >
                  Off
                </button>

                <button
                  class="on-select"
                  :class="{ active: store.config.webSearch }"
                  @click="switchMode('webSearch', 'on')"
                >
                  On
                </button>
              </div>
            </div>
          </div>
          <div class="setting-card">
            <div class="setting-title">允许 Agent 访问知识库</div>
            <div class="setting-control">
              <div class="setting-info" :class="{ danger_info: store.config.webSearch && store.config.knowledgeRetrieval }">
                允许Agent使用知识库检索工具在知识库中搜索信息。与网络搜索能力同时开启时，会降低模型知识库检索表现。
              </div>
              <div class="mode-switch">
                <div class="slider" :class="{ right: store.config.knowledgeRetrieval }" />

                <button
                  class="off-select"
                  :class="{ active: !store.config.knowledgeRetrieval }"
                  @click="switchMode('knowledgeRetrieval', 'off')"
                >
                  Off
                </button>

                <button
                  class="on-select"
                  :class="{ active: store.config.knowledgeRetrieval }"
                  @click="switchMode('knowledgeRetrieval', 'on')"
                >
                  On
                </button>
              </div>
            </div>
          </div>
          <div class="setting-card">
            <div class="setting-title">允许 Agent 使用技能包</div>
            <div class="setting-control">
              <div class="setting-info">允许Agent加载技能包，获取技能包扩展。</div>
              <div class="mode-switch">
                <div class="slider" :class="{ right: store.config.skillLoad }" />

                <button
                  class="off-select"
                  :class="{ active: !store.config.skillLoad }"
                  @click="switchMode('skillLoad', 'off')"
                >
                  Off
                </button>

                <button
                  class="on-select"
                  :class="{ active: store.config.skillLoad }"
                  @click="switchMode('skillLoad', 'on')"
                >
                  On
                </button>
              </div>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">启用模型视觉输入</div>
            <div class="setting-control">
              <div class="setting-info">
                开启后，图片将发送给模型进行理解，而不使用OCR工具提取文字。系统会自动检测模型是否具备视觉处理能力。
              </div>
              <div class="mode-switch">
                <div class="slider" :class="{ right: store.config.visionOn }" />

                <button
                  class="off-select"
                  :class="{ active: !store.config.visionOn }"
                  @click="switchMode('visionOn', 'off')"
                >
                  Off
                </button>

                <button
                  class="on-select"
                  :class="{ active: store.config.visionOn }"
                  @click="switchMode('visionOn', 'on')"
                >
                  On
                </button>
              </div>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">启用 Agent 子代理</div>
            <div class="setting-control">
              <div class="setting-info" :class="{ danger_info: store.config.agentAssign }">
                开启智能体子代理模式，提供异步任务处理能力，不推荐在个人PC本地部署时开启。
              </div>
              <div class="mode-switch">
                <div class="slider" :class="{ right: store.config.agentAssign }" />

                <button
                  class="off-select"
                  :class="{ active: !store.config.agentAssign }"
                  @click="switchMode('agentAssign', 'off')"
                >
                  Off
                </button>

                <button
                  class="on-select"
                  :class="{ active: store.config.agentAssign }"
                  @click="switchMode('agentAssign', 'on')"
                >
                  On
                </button>
              </div>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">启用 Agent-Term 蜂群模式</div>
            <div class="setting-control">
              <div class="setting-info" :class="{ danger_info: store.config.agentSwarm }">
                开启多智能体协作模式，不推荐在个人PC本地部署时开启。开启此项默认将 <strong>Agent 子代理</strong> 视为已开启。
              </div>
              <div class="mode-switch">
                <div class="slider" :class="{ right: store.config.agentSwarm }" />

                <button
                  class="off-select"
                  :class="{ active: !store.config.agentSwarm }"
                  @click="switchMode('agentSwarm', 'off')"
                >
                  Off
                </button>

                <button
                  class="on-select"
                  :class="{ active: store.config.agentSwarm }"
                  @click="switchMode('agentSwarm', 'on')"
                >
                  On
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 组4: AI设置 -->
        <div class="setting-group">
          <div class="group-divider">
            <span class="group-label">记忆设置</span>
          </div>

          <div class="setting-card">
            <div class="setting-title">自动整理会话或工作区中的记忆  <span class="setting-label">施工中</span></div>
            <div class="setting-control">
              <div class="setting-info"  :class="{ danger_info: store.config.longtermMemory }">
                让Agent自动整理会话中或工作区中保存的记忆，开启后，当记忆数量达到一定阈值时将自动触发。
              </div>
              <div class="mode-switch">
                <div class="slider" :class="{ right: store.config.longtermMemory }" />

                <button
                  class="off-select"
                  :class="{ active: !store.config.longtermMemory }"
                  @click="switchMode('longtermMemory', 'off')"
                >
                  Off
                </button>

                <button
                  class="on-select"
                  :class="{ active: store.config.longtermMemory }"
                  @click="switchMode('longtermMemory', 'on')"
                >
                  On
                </button>
              </div>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">当上下文达到窗口大小限制时自动总结上下文</div>
            <div class="setting-control">
              <div class="setting-info">需同步设置上下文总结触发阈值与保留的窗口长度，若不进行设置，系统将在上下文达到窗口大小供应商限制时自动触发总结。</div>
              <div class="mode-switch">
                <div class="slider" :class="{ right: store.config.shorttermMemory }" />

                <button
                  class="off-select"
                  :class="{ active: !store.config.shorttermMemory }"
                  @click="switchMode('shorttermMemory', 'off')"
                >
                  Off
                </button>

                <button
                  class="on-select"
                  :class="{ active: store.config.shorttermMemory }"
                  @click="switchMode('shorttermMemory', 'on')"
                >
                  On
                </button>
              </div>
            </div>
          </div>

          <div class="setting-card" title="过小的触发阈值可能导致Agent陷入死循环，最小生效值为16">
            <div v-if="store.config.shorttermMemory" class="setting-title">上下文总结触发阈值</div>
            <div v-else class="setting-title">上下文截断触发阈值</div>
            <div class="setting-control">
              <el-input-number
                v-model="summaryMessages"
                controls-position="right"
                class="number-input"
              />
              <el-button
                type="primary"
                off
                size="default"
                @click="storeMessageSummary"
                class="confirm-button"
              >
                保存
              </el-button>
            </div>
          </div>

          <div class="setting-card" title="过小的保留长度可能导致Agent陷入死循环，最小生效值为4">
            <div v-if="store.config.shorttermMemory" class="setting-title">总结时保留的上下文长度</div>
            <div v-else class="setting-title">截断时保留的上下文长度</div>
            <div class="setting-control">
              <el-input-number
                v-model="keepMessages"
                controls-position="right"
                class="number-input"
              />
              <el-button
                type="primary"
                off
                size="default"
                @click="storeKeepNotSummary"
                class="confirm-button"
              >
                保存
              </el-button>
            </div>
          </div>
        </div>

        <!-- 组5: 联网搜索配置 -->
        <div class="setting-group">
          <div class="group-divider">
            <span class="group-label">联网搜索</span>
          </div>
          <!-- Online search -->
          <div class="setting-card">
            <div class="setting-title">配置关键词搜索引擎</div>
            <div class="setting-control">
              <el-select v-model="linkProvider" placeholder="Auto" class="select-input">
                <el-option
                  v-for="item in linkProviderOptions"
                  :key="item.value"
                  :label="item.label"
                  :value="item.value"
                  :disabled="item.disabled"
                />
              </el-select>
              <el-button
                type="primary"
                off
                size="default"
                @click="storeLinkProvider"
                class="confirm-button"
              >
                保存
              </el-button>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">配置关键词搜索引擎API-Key</div>
            <div class="setting-control">
              <el-input
                v-model="linkApiKey"
                type="password"
                placeholder="Your API key"
                show-password
                class="line-input"
              />
              <el-button
                type="primary"
                off
                size="default"
                @click="storeLinkApiKey"
                class="confirm-button"
              >
                保存
              </el-button>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">配置网页内容搜索引擎</div>
            <div class="setting-control">
              <el-select v-model="contentProvider" placeholder="Auto" class="select-input">
                <el-option
                  v-for="item in contentPoviderOptions"
                  :key="item.value"
                  :label="item.label"
                  :value="item.value"
                />
              </el-select>
              <el-button
                type="primary"
                off
                size="default"
                @click="storeContentPovider"
                class="confirm-button"
              >
                保存
              </el-button>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">配置网页内容搜索API-Key</div>
            <div class="setting-control">
              <el-input
                v-model="contentApiKey"
                type="password"
                placeholder="Your API key"
                show-password
                class="line-input"
              />
              <el-button
                type="primary"
                off
                size="default"
                @click="storeContentApiKey"
                class="confirm-button"
              >
                保存
              </el-button>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">配置AI联网搜索内容过滤规则</div>
            <div class="setting-control">
              <el-select v-model="webContentFilter" placeholder="规则过滤 (默认)" class="select-input">
                <el-option
                  v-for="item in webContentFilterOptions"
                  :key="item.value"
                  :label="item.label"
                  :value="item.value"
                />
              </el-select>
              <el-button
                type="primary"
                off
                size="default"
                @click="storeWebContentFilter"
                class="confirm-button"
              >
                保存
              </el-button>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">允许的域名关键字  <span class="setting-label">施工中</span></div>
            <div class="setting-control">
              <el-input
                placeholder="选择一个配置文件或直接输入 e.g: wiki,github,arxiv"
                v-model="store.config.excludeWebUrl"
                class="line-input"
              >
              </el-input>
              <el-button
                type="primary"
                off
                size="default"
                @click=""
                class="confirm-button"
              >
                打开
              </el-button>
            </div>
          </div>
        </div>

        <!-- 组6: 功能开关 -->
        <div class="setting-group">
          <div class="group-divider">
            <span class="group-label">其他设置</span>
          </div>
          <div class="setting-card">
            <div class="setting-title">单轮生成中LLM调用轮次预警值</div>
            <div class="setting-control">
              <div class="setting-info">超出阈值时将提醒Agent加快处理进度</div>
              <el-input-number
                v-model="tokenLimit"
                controls-position="right"
                class="number-input"
              />
              <el-button
                type="primary"
                off
                size="default"
                @click="storeTokenLimit"
                class="confirm-button"
              >
                保存
              </el-button>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">将过去的思维链以及工具返回内容回传接口</div>
            <div class="setting-control">
              <div class="setting-info">
                工具的返回结果通常会携带大量的文本信息，极大增加Token消耗，如果是本地模型，将同时增加GPU的计算负担，某些供应商需要开启此选项。
              </div>
              <div class="mode-switch">
                <div class="slider" :class="{ right: store.config.remainToolsCache }" />

                <button
                  class="off-select"
                  :class="{ active: !store.config.remainToolsCache }"
                  @click="switchMode('remainToolsCache', 'off')"
                >
                  Off
                </button>

                <button
                  class="on-select"
                  :class="{ active: store.config.remainToolsCache }"
                  @click="switchMode('remainToolsCache', 'on')"
                >
                  On
                </button>
              </div>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">重置模型能力缓存</div>
            <div class="setting-control">
              <div class="setting-info">
                重置本地保存的模型能力信息。如果支持视觉输入的模型错误使用了 OCR，可尝试此功能。
              </div>
              <el-button
                type="primary"
                off
                size="default"
                @click="clearVisionCache()"
                class="confirm-button"
              >
                重置
              </el-button>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">开启纯对话模式</div>
            <div class="setting-control">
              <div class="setting-info" :class="{ danger_info: store.config.pureChat }">
                开启此选项将禁用Agent全部工具（含生成计划、多模态、联网搜索、文件操作等），适用于无工具调用能力的模型。
              </div>
              <div class="mode-switch">
                <div class="slider" :class="{ right: store.config.pureChat }" />

                <button
                  class="off-select"
                  :class="{ active: !store.config.pureChat }"
                  @click="switchMode('pureChat', 'off')"
                >
                  Off
                </button>

                <button
                  class="on-select"
                  :class="{ active: store.config.pureChat }"
                  @click="switchMode('pureChat', 'on')"
                >
                  On
                </button>
              </div>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-title">自动保存当前设置</div>
            <div class="setting-control">
              <div class="setting-info" :class="{ danger_info: store.config.autoSaveConfig }">
                开启后，每次对话时将当前工具权限、记忆、联网搜索和模型设置保存到本机。
              </div>
              <div class="mode-switch">
                <div class="slider" :class="{ right: store.config.autoSaveConfig }" />

                <button
                  class="off-select"
                  :class="{ active: !store.config.autoSaveConfig }"
                  @click="switchMode('autoSaveConfig', 'off')"
                >
                  Off
                </button>

                <button
                  class="on-select"
                  :class="{ active: store.config.autoSaveConfig }"
                  @click="switchMode('autoSaveConfig', 'on')"
                >
                  On
                </button>
              </div>
            </div>
          </div>

          <div class="setting-card" title="模型温度越高，其输出的下一个Token越随机">
            <div class="setting-title">模型温度百分比</div>
            <div class="setting-control">
              <el-slider
                v-model="store.config.modelTemp"
                :min="0"
                :max="100"
                @change="changeModelTemp"
              />
              <span class="setting-value">{{ (store.config.modelTemp * 0.02).toFixed(2) }}</span>
            </div>
          </div>
        </div>

      </div>

      </div>
    </el-main>
</el-container>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { ElMessage } from 'element-plus'

import HomePage from './homePage.vue'
import { mountToolSettings } from '@openstarry/workbench/settings'
import '@openstarry/workbench/style.css'
import { useAppCacheData } from '../store/app'
import { OpenStarry_client_version, defaultCards, setHighlightTheme } from '../store/globalData.js'
import { ConfirmDialog } from './component/comp/confirmDialog.js'

const store = useAppCacheData()
const ideToolsHost = ref(null)
watch(ideToolsHost, element => { if (element) mountToolSettings(element, { desktop: true, notify: message => ElMessage({ message, duration: 5000 }), request: async ({ signal, ...value }) => {
  signal?.throwIfAborted(); const id = crypto.randomUUID(); const abort = () => window.api.ide.cancelHttp({ id }); signal?.addEventListener('abort', abort, { once: true })
  try { return await window.api.ide.http({ id, ...value }) } finally { signal?.removeEventListener('abort', abort) }
} }) })
const desktopSettings = ref({
  closeBehavior: 'tray',
  launchAtLogin: false,
  computerControlMode: 'auto',
  confirmIrreversibleActions: true,
  autoContinue: {
    enabled: true,
    maxTurns: 50,
    maxMinutes: 120,
    repeatedErrorLimit: 3
  },
  vault: { enabled: false, helloPreferred: true, masterPasswordFallback: false },
  sync: {
    enabled: false,
    serverUrl: 'https://openstarry.154-219-110-177.sslip.io',
    userId: 'tomysh',
    intervalMinutes: 5
  }
})
const runtimeStatus = ref({ phase: 'starting', message: '正在初始化' })
const syncToken = ref('')
const syncStatus = ref({
  phase: 'idle',
  message: '云端同步未启用',
  queued: 0,
  credentialStored: false
})
let unsubscribeSyncStatus = null

/* Layout */
const pageHeight = ref(window.innerHeight - 30)
const showPage = ref(false)

const updatePageHeight = () => {
  pageHeight.value = window.innerHeight - 30
}

onMounted(async () => {
  window.addEventListener('resize', updatePageHeight)
  showPage.value = true
  desktopSettings.value = await window.api.system.getSettings()
  runtimeStatus.value = await window.api.system.runtimeStatus()

  let syncEventSeen = false
  unsubscribeSyncStatus = window.api.system.onSyncStatus((status) => {
    syncEventSeen = true
    syncStatus.value = status
  })

  const initialSyncStatus = await window.api.system.syncStatus()
  if (!syncEventSeen) {
    syncStatus.value = initialSyncStatus
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updatePageHeight)
  unsubscribeSyncStatus?.()
})

const saveDesktopSettings = async () => {
  const desktopOnlySettings = JSON.parse(JSON.stringify(desktopSettings.value))
  delete desktopOnlySettings.sync
  desktopSettings.value = await window.api.system.updateSettings(desktopOnlySettings)
  ElMessage.success('设置已保存')
}

const openLocalData = () => window.api.system.showData()

const exportLocalData = async () => {
  const exported = await window.api.system.exportBackup()
  if (exported) ElMessage.success('本地数据已导出')
}

const restoreLocalData = async () => {
  try {
    await ConfirmDialog.confirm('恢复备份会覆盖同名的本地数据，是否继续？', '恢复本地数据', {
      confirmButtonText: '恢复', cancelButtonText: '取消', type: 'warning'
    })
    const restored = await window.api.system.restoreBackup()
    if (restored) ElMessage.success('数据已恢复')
  } catch {}
}

const openDiagnostics = () => window.api.system.showLogs()

const saveSyncSettings = async () => {
  try {
    syncStatus.value = await window.api.system.configureSync(
      JSON.parse(JSON.stringify(desktopSettings.value.sync)),
      syncToken.value
    )
    syncToken.value = ''
    ElMessage.success('同步设置已保存')
    if (desktopSettings.value.sync.enabled) await runCloudSync()
  } catch (error) {
    ElMessage.error(error?.message || '同步设置保存失败')
  }
}

const runCloudSync = async () => {
  try {
    syncStatus.value = await window.api.system.runSync()
    ElMessage.success('聊天记录同步完成')
  } catch (error) {
    ElMessage.warning(error?.message || '当前网络不可用，稍后将自动重试')
  }
}

const resetCloudSync = async () => {
  try {
    await ConfirmDialog.confirm(
      '下次同步会重新核对全部聊天和附件，本地数据不会被清除。是否继续？',
      '重新全量核对',
      { confirmButtonText: '继续', cancelButtonText: '取消', type: 'warning' }
    )
    syncStatus.value = await window.api.system.resetSync()
    await runCloudSync()
  } catch {}
}

const retryComponents = async () => {
  runtimeStatus.value = { phase: 'starting', message: '正在重新初始化' }
  try {
    runtimeStatus.value = await window.api.system.retryRuntime()
    ElMessage.success('组件已恢复')
  } catch (error) {
    runtimeStatus.value = { phase: 'error', message: error?.message || '组件恢复失败' }
    ElMessage.error('组件恢复失败')
  }
}

const checkUpdates = async () => {
  await window.api.system.checkForUpdates()
  ElMessage.info('正在检查更新')
}

/* Settings */
const changeModelTemp = (value) => {
  store.saveAppConfig('modelTemp', value)
}

/* Proxy */
const setNetProxy = async () => {
  store.saveAppConfig('httpProxyUrl', store.config.httpProxyUrl)
  try {
    const res = await window.api.setProxy(
      store.config.httpProxyUrl,
      store.config.httpsProxyUrl,
      store.config.excludeUrl
    )
    ElMessage.success('代理已保存')
  } catch (err) {
    ElMessage.error('代理保存失败')
    console.error(err)
  }
}

/* Reset cards */
const resetPresetCard = async () => {
  const presets = defaultCards
  const cardMap = new Map(store.cards.map(c => [c.id, c]))

  let index = 0
  presets.forEach(preset => {
    if (cardMap.has(preset.id)) {
      const exist = cardMap.get(preset.id)
      Object.assign(exist, preset)

      const oldIndex = store.cards.indexOf(exist)
      if (oldIndex !== index) {
        store.cards.splice(oldIndex, 1)
        store.cards.splice(index, 0, exist)
      }
    } else {
      store.cards.splice(index, 0, preset)
    }
    index++
  })

  await store.saveCards()
  ElMessage.success('已恢复预设')
}

const openCacheDir = async () => {
  try {
    await window.api.openCacheDir()
  }catch (err) {
    ElMessage.error('打开失败')
    console.error("error to open cache directory: ", err)
  }
}

const clearVisionCache = async () => {
  try {
    await ConfirmDialog.confirm(
      `确定模型能力清除缓存？`,
      '重置确认',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning',
      }
    )

    try {
      await window.api.clearVisionCache()
      ElMessage.success('已重置')
    }catch (err) {
      ElMessage.error('重置失败')
      console.error("error to restore vision_cache: ", err)
    }
  } catch (err) {
  }
}

/* Token limit */
const tokenLimit = ref(store.config.tokenLimit || 0)
function storeTokenLimit() {
  store.config.tokenLimit = tokenLimit.value
  store.saveAppConfig('tokenLimit', tokenLimit.value)
  ElMessage.success('保存成功')
}

/* Summary messages */
const summaryMessages = ref(store.config.messageSummary || 0)
function storeMessageSummary() {
  store.config.messageSummary = summaryMessages.value
  store.saveAppConfig('messageSummary', summaryMessages.value)
  ElMessage.success('保存成功')
}
const keepMessages = ref(store.config.keepNotSummary || 0)
function storeKeepNotSummary() {
  store.config.keepNotSummary = keepMessages.value
  store.saveAppConfig('keepNotSummary', keepMessages.value)
  ElMessage.success('保存成功')
}

/* Search Links (Urls) Provider */
const linkProvider = ref(store.config.linkProvider || '')
const linkProviderOptions = [
  {
    value: '',
    label: 'Auto',
  },
  {
    value: 'duckduckgo',
    label: 'DuckDuckGo',
  },
  {
    value: 'bing',
    label: 'Bing',
  },
  {
    value: 'bocha',
    label: 'Bocha',
  },
  {
    value: 'google',
    label: 'Google',
    disabled: true,
  },
  {
    value: 'searxng',
    label: 'Searxng',
    disabled: true,
  },
  {
    value: 'tavily',
    label: 'Tavily',
  },
  {
    value: 'uniFuncs',
    label: 'UniFuncs',
  }
]
function storeLinkProvider() {
  store.config.linkProvider = linkProvider.value
  store.saveAppConfig('linkProvider', linkProvider.value)
  ElMessage.success('保存成功')
}
const linkApiKey = ref(store.config.linkApiKey || '')
function storeLinkApiKey() {
  store.config.linkApiKey = linkApiKey.value
  store.saveAppConfig('linkApiKey', linkApiKey.value)
  ElMessage.success('保存成功')
}

/* Search Contents Provider */
const contentProvider = ref(store.config.contentProvider || '')
const contentPoviderOptions = [
  {
    value: '',
    label: 'Auto',
  },
  {
    value: 'tavily',
    label: 'Tavily',
  },
  {
    value: 'crawl4ai',
    label: 'Crawl4AI',
  },
  {
    value: 'jina',
    label: 'Jina',
  }
]
function storeContentPovider() {
  store.config.contentProvider = contentProvider.value
  store.saveAppConfig('contentProvider', contentProvider.value)
  ElMessage.success('保存成功')
}

const contentApiKey = ref(store.config.contentApiKey || '')
function storeContentApiKey() {
  store.config.contentApiKey = contentApiKey.value
  store.saveAppConfig('contentApiKey', contentApiKey.value)
  ElMessage.success('保存成功')
}

/* Search Contents filter */
const webContentFilter = ref(store.config.webContentFilter || '')
const webContentFilterOptions = [
  {
    value: 'rule',
    label: '规则过滤 (默认)',
  },
  {
    value: 'llm',
    label: '大模型过滤',
  },
  {
    value: 'none',
    label: '无过滤',
  }
]
function storeWebContentFilter() {
  store.config.webContentFilter = webContentFilter.value
  store.saveAppConfig('webContentFilter', webContentFilter.value)
  ElMessage.success('保存成功')
}

/* Generic boolean mode switch */
const switchMode = (key: keyof typeof store.config, target: 'on' | 'off') => {
  const value = target === 'on'

  // Update reactive config
  store.config[key] = value as any

  // Persist to local storage / backend
  store.saveAppConfig(key as string, value)
}

</script>

<style scoped>
:deep(.el-select__wrapper .el-tooltip__trigger .el-tooltip__trigger) {
  display: block !important;
  opacity: 1 !important;
}

:deep(.el-slider__bar) {
  background-color:var(--OpenStarry-primary-color);
}

:deep(.el-slider__button) {
  background-color:var(--OpenStarry-primary-light);
  border: 2px solid var(--OpenStarry-primary-active);
  border-radius: var(--OpenStarry-button-border-radius);
}

:deep(.el-slider__button:hover) {
  width: 24px;
  transform: none;
}

:deep(.el-popper:deep(*)) {
  color: transparent;
}

span.el-popper__arrow {
  display: none;
}

:deep(.el-slider__button:active) {
  transform: scale(1.2);
  overflow: hidden;
  border: 2px solid color-mix(in srgb, var(--OpenStarry-primary-color) 25%, transparent);
  -webkit-backdrop-filter: saturate(180%) blur(16px);
  backdrop-filter: saturate(180%) blur(3px);
  transition: all 0.3s var(--OpenStarry-cubic-bezier);
  background-color: color-mix(in srgb, var(--OpenStarry-panel-base-layer-background) 30%, transparent);
  color: var(--OpenStarry-info-dark-text);
}

.setting-page-wrapper {
  position: relative;
  padding: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  overflow: auto;
  overscroll-behavior: contain;
  max-height: calc(100vh - 32px - 36px);
}

.title-tag-wrapper {
  position: relative;
  width: 100%;
  height: fit-content;
  justify-content: center;
  display: flex;
  align-items: center;
  opacity: 0.95;
}

.app-layout {
  padding: 24px 32px;
  padding-bottom: 100px;
  display: flex;
  flex-direction: column;
  gap: 24px;
  background: transparent;
  width: 100%;
  max-width: 1064px;
  box-sizing: border-box;
}

.setting-group {
  display: grid;
  width: 100%;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 18px;
  width: 100%;
  padding-top: 8px;
  margin-top: 8px;
}

.group-divider {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  margin-bottom: 4px;
  gap: 6px
}

.group-label {
  position: relative;
  width: 100%;
  height: 30px;
  font-size: 18px;
  font-weight: 600;
  color: var(--OpenStarry-primary-color);
  text-transform: uppercase;
  letter-spacing: 0.8px;
  padding: 0 12px;
  border-left: 3px solid var(--OpenStarry-primary-color);
}

.setting-card {
  position: relative;
  padding: 16px 18px;
  border-radius: var(--OpenStarry-border-radius-base);
  min-height: 108px;
  min-width: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--OpenStarry-panel-layer-3-background);
  box-shadow: var(--OpenStarry-shadow-layer-1);
  transition: transform 0.2s var(--OpenStarry-cubic-bezier),
    box-shadow 0.2s var(--OpenStarry-cubic-bezier);
}

.setting-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--OpenStarry-shadow-layer-3);
}

.sync-setting-card {
  grid-column: 1 / -1;
  height: auto;
  min-height: 156px;
}

.sync-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}

.sync-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  flex-wrap: wrap;
}

.sync-url-input {
  min-width: 280px;
  flex: 1;
}

.sync-user-input {
  width: 150px;
}

.sync-token-input {
  min-width: 260px;
  flex: 1;
}

.setting-label {
  margin-right: 6px;
  padding: 2px 6px;
  color: #059669;
  border: 1px solid rgba(5, 150, 105, 0.1);
  background: rgba(5, 150, 105, 0.05);
  border-radius: 16px;
  font-size: 10px;
}

.danger-label {
  margin-right: 6px;
  padding: 2px 6px;
  color: #960505;
  border: 1px solid rgba(150, 22, 5, 0.1);
  background: rgba(150, 22, 5, 0.05);
  border-radius: 16px;
  font-size: 10px;
}

.setting-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--OpenStarry-darkest-color);
  position: relative;
}

.setting-control {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 16px;
  width: 100%;
  min-width: 0;
  flex-wrap: wrap;
}

.setting-info {
  font-size: 12px;
  color: var(--OpenStarry-secondary-dark-color);
  position: relative;
  transition: color 0.25s var(--OpenStarry-cubic-bezier);
}

.danger_info {
  color: var(--OpenStarry-danger-color);
}

.confirm-button {
  position: static;
  flex-shrink: 0;
  margin-left: auto;
  width: 64px;
  color: var(--OpenStarry-primary-color);
  border: 2px solid var(--OpenStarry-primary-light);
  transition: color 0.22s var(--OpenStarry-cubic-bezier),
    border 0.22s var(--OpenStarry-cubic-bezier);
  background-color: var(--OpenStarry-primary-lighter);
  border-radius: var(--OpenStarry-button-border-radius);
}

.confirm-button:hover {
  color: var(--OpenStarry-primary-active);
  border: 2px solid var(--OpenStarry-primary-light-dark);
}

.setting-value {
  width: 44px;
  text-align: right;
  font-size: 13px;
  color: #5a6a6a;
}

.line-input {
  width: 100%;
}

.line-input :deep(.el-input) {
  flex: 1;
  min-width: 0;
  height: 38px !important;
  transform-origin: center;
  transform: scale(1);
  transition: transform 0.22s var(--OpenStarry-cubic-bezier);
}

.line-input :deep(.el-input__wrapper) {
  height: 38px !important;
  padding: 0 12px 0 10px;
  background: transparent;
  background-color: var(--OpenStarry-panel-layer-4-background);
  border: none;
  border-radius: var(--OpenStarry-border-radius-base);
  box-shadow: none;
  transition: all 0.13s var(--OpenStarry-cubic-bezier);
}

.number-input {
  width: 100%;
}

/* 输入框基础样式 - 青绿色主题边框 */
.number-input:deep(.el-input__wrapper) {
  background: color-mix(in srgb, var(--OpenStarry-primary-color) 5%, transparent);
  border: 2px solid color-mix(in srgb, var(--OpenStarry-primary-color) 25%, transparent);
  border-radius: 999px;
  padding: 0 12px;
  box-shadow: none;
  transition: all 0.3s cubic-bezier(0.215, 0.61, 0.355, 1);
}

.number-input:deep(.el-input__wrapper:hover),
.number-input:deep(.el-input__wrapper.is-hover) {
  border-color: color-mix(in srgb, var(--OpenStarry-primary-color) 50%, transparent) !important;
  background: color-mix(in srgb, var(--OpenStarry-primary-active) 8%, transparent) !important;
  box-shadow: none !important;
}

.number-input:deep(.el-input__wrapper:has(.el-input-number__increase:hover)),
.number-input:deep(.el-input__wrapper:has(.el-input-number__decrease:hover)) {
  border-color: color-mix(in srgb, var(--OpenStarry-primary-color) 50%, transparent) !important;
  box-shadow: none !important;
}

.number-input:deep(.el-input__wrapper.is-focus) {
  border-color: color-mix(in srgb, var(--OpenStarry-primary-active) 53%, transparent) !important;
  background: color-mix(in srgb, var(--OpenStarry-primary-color) 10%, transparent);
  box-shadow: none !important;
}

/* 输入文字左对齐 */
.number-input:deep(.el-input__inner) {
  text-align: left;
  color: var(--OpenStarry-link-color);
  font-weight: 500;
  height: 34px;
  line-height: 34px;
  padding-right: 70px;
}

/* 控制按钮 - 圆形青绿色主题 */
.number-input:deep(.el-input-number__increase),
.number-input:deep(.el-input-number__decrease) {
  background: color-mix(in srgb, var(--OpenStarry-primary-color) 5%, transparent);
  border: none;
  color: var(--OpenStarry-link-color);
  width: 26px;
  height: 26px;
  font-size: 12px;
  font-weight: bold;
  display: flex;
  align-items: center;
  justify-content: center;
  position: absolute;
  right: 8px;
  transition: all 0.3s cubic-bezier(0.215, 0.61, 0.355, 1);
}

/* 增加按钮在上，减少按钮在下 */
.number-input:deep(.el-input-number__increase) {
  border-radius: 0px 16px 0px 0px;
  right: 3px;
  top: 3px;
  height: 16px;
}

.number-input:deep(.el-input-number__decrease) {
  border-radius: 0px 0px 16px 0px;
  right: 3px;
  bottom: 3px;
  height: 16px;
}

/* 按钮悬浮 */
.number-input:deep(.el-input-number__increase:hover),
.number-input:deep(.el-input-number__decrease:hover) {
  background: color-mix(in srgb, var(--OpenStarry-primary-active) 15%, transparent);
  border-color: color-mix(in srgb, var(--OpenStarry-primary-color) 50%, transparent);
}

/* 按钮点击 */
.number-input:deep(.el-input-number__increase:active),
.number-input:deep(.el-input-number__decrease:active) {
  background: color-mix(in srgb, var(--OpenStarry-primary-color) 24%, transparent);
  transform: scale(0.95);
}

/* 禁用状态 */
.number-input:deep(.el-input-number__increase.is-disabled),
.number-input:deep(.el-input-number__decrease.is-disabled) {
  background: transparent;
  border-color: color-mix(in srgb, var(--OpenStarry-border-disabled) 30%, transparent);
  color: var(--OpenStarry-secondary-light-color);
  cursor: not-allowed;
  transform: none;
}

.select-input {
  width: 100%;
}

/* 外层输入框 */
.select-input:deep(.el-select__wrapper) {
  background: color-mix(in srgb, var(--OpenStarry-primary-color) 5%, transparent);
  border: 2px solid color-mix(in srgb, var(--OpenStarry-primary-color) 25%, transparent);
  border-radius: 999px;
  padding: 0 14px;
  min-height: 36px;
  box-shadow: none;
  transition: all 0.3s cubic-bezier(0.215, 0.61, 0.355, 1);
}

/* hover */
.select-input:deep(.el-select__wrapper:hover) {
  border-color: color-mix(in srgb, var(--OpenStarry-primary-color) 50%, transparent) !important;
  background: color-mix(in srgb, var(--OpenStarry-primary-active) 8%, transparent) !important;
  box-shadow: none !important;
}

/* focus */
.select-input:deep(.el-select__wrapper.is-focused) {
  border-color: color-mix(in srgb, var(--OpenStarry-primary-active) 53%, transparent) !important;
  background: color-mix(in srgb, var(--OpenStarry-primary-color) 10%, transparent);
  box-shadow: none !important;
}

/* 文字区域 */
.select-input:deep(.el-select__selection) {
  color: var(--OpenStarry-link-color);
  font-weight: 500;
}

/* placeholder */
.select-input:deep(.el-select__placeholder) {
  color: color-mix(in srgb, var(--OpenStarry-link-color) 65%, transparent);
}

/* 选中值 */
.select-input:deep(.el-select__selected-item) {
  color: var(--OpenStarry-link-color);
  font-weight: 500;
}

/* 下拉箭头 */
.select-input:deep(.el-select__caret) {
  color: var(--OpenStarry-link-color);
  font-size: 14px;
  transition: transform 0.25s ease, color 0.25s ease;
}

/* hover 箭头颜色 */
.select-input:deep(.el-select__wrapper:hover .el-select__caret) {
  color: var(--OpenStarry-primary-active);
}

/* 打开时旋转 */
.select-input:deep(.is-reverse .el-select__caret) {
  transform: rotate(180deg);
}

/* disabled */
.select-input:deep(.is-disabled.el-select__wrapper) {
  background: color-mix(in srgb, var(--OpenStarry-border-disabled) 8%, transparent);
  border-color: color-mix(in srgb, var(--OpenStarry-border-disabled) 30%, transparent);
}

/* ---------------------------------- */
.mode-switch {
  position: absolute;
  right: 14px;
  display: flex;
  background: color-mix(in srgb, var(--OpenStarry-default-light-color) 32%, transparent);
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--OpenStarry-border-light) 31.8%, transparent);
  box-shadow: inset 1px -1px 16px color-mix(in srgb, var(--OpenStarry-primary-color) 8.3%, transparent);
}

.mode-switch button {
  flex: 1;
  height: 24px;
  border: none;
  background-color: transparent;
  cursor: pointer;
  z-index: 1;
  font-size: 12px;
  color: var(--OpenStarry-secondary-dark-color);
  transition: color 0.25s ease;
}

.mode-switch button.active {
  color: var(--OpenStarry-darkest-color);
}

/* 共用 active 时的光晕与背景效果（original used color-mix） */
.mode-switch:active .slider,
.mode-switch:active:deep(.slider) {
  z-index: 999;
  box-shadow:
    var(--OpenStarry-shadow-lg),
    0 0 0 2px color-mix(in srgb, var(--OpenStarry-primary-color) 14%, transparent);
  backdrop-filter: saturate(180%) blur(3px);
  transition: all 0.3s var(--OpenStarry-cubic-bezier);
  background-color: color-mix(in srgb, var(--OpenStarry-default-light-color) 1%, transparent);
}

.highlight-select {
  color: var(--OpenStarry-secondary-dark-color);
  transition: color 0.25s ease;
}

.highlight-select.right {
  color: var(--OpenStarry-darkest-color);
  transition: color 0.25s ease;
}

/* Slider */
.slider {
  position: absolute;
  width: calc(50% + 4px);
  height: calc(100% + 2px);
  margin-top: -1px;
  margin-left: -1px;
  border-radius: 32px;
  transition: all 0.3s var(--OpenStarry-cubic-bezier);
  box-shadow:
    var(--OpenStarry-shadow-md),
    0 0 0 2px color-mix(in srgb, var(--OpenStarry-primary-color) 47.1%, transparent);
  background-color: var(--OpenStarry-lightest-color);
}

.slider.right {
  transform: translateX(87%);
}
/* ---------------------------------- */

:deep(.el-slider__runway) {
  background-color: var(--OpenStarry-panel-layer-0-background);
}

/* Logout */
.logout-btn-wrapper {
  position: fixed;
  display: flex;
  flex-direction: row;
  gap: 12px;
  right: 36px;
  bottom: 22px;
  z-index: 999;
  border-radius: var(--OpenStarry-button-border-radius) !important;
}
.logout-btn-wrapper:deep(.el-button) {
  height: 36px;
  border: none;
  font-size: 14px;
  font-weight: 500;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08) !important;
  backdrop-filter: saturate(580%) blur(16px);
  border-radius: var(--OpenStarry-button-border-radius) !important;
  background-color: color-mix(in srgb, var(--OpenStarry-danger-color) 70%, transparent) !important;
}

.sync-config-btn {
  height: 36px;
  padding: 8px 16px;
  background: var(--OpenStarry-primary-lighter);
  border: none;
  border-radius: var(--OpenStarry-button-border-radius) !important;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08) !important;
  color: var(--OpenStarry-primary-dark);
  font-size: 14px;
  font-weight: 500;
  backdrop-filter: saturate(280%) blur(16px);
  transition: all 0.3s var(--OpenStarry-cubic-bezier);
  background-color: color-mix(in srgb, var(--OpenStarry-panel-layer-5-background) 50%, transparent) !important;
}

.setting-control > .setting-info { flex: 1 1 160px; line-height: 1.65; overflow-wrap: anywhere; }
.setting-control > .compact-control { flex: 0 1 190px; min-width: 150px; }
.setting-control > .mode-switch, .setting-control > .el-switch { flex-shrink: 0; }
.setting-control > .line-input, .setting-control > .number-input, .setting-control > .el-slider { flex: 1 1 180px; min-width: 0; }
.button-row { display: flex; flex-wrap: wrap; gap: 8px; }
.button-row :deep(.el-button), .sync-row :deep(.el-button) { margin-left: 0; }
.sync-form, .sync-row { min-width: 0; }
.sync-url-input, .sync-token-input { min-width: min(260px, 100%); }
@media (max-width: 1050px) {
  .setting-group { grid-template-columns: minmax(0, 1fr); }
  .app-layout { padding: 8px 4px 60px; }
}

.banner-title-wrapper { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; width: 100%; }
.banner-title { font-size: clamp(30px, 4vw, 56px); overflow-wrap: anywhere; }
.version-tag { position: static; }
@media (max-width: 1050px) { .OpenStarry-banner { padding: 28px; } }
</style>


<style scoped>
/* 横幅容器 - 纯净深色基底 */
.OpenStarry-banner {
  box-sizing: border-box;
  width: 100%;
  max-width: 900px;
  border-radius: 20px;
  padding: 48px;
  position: relative;
  overflow: hidden;
  border: 1px solid rgba(136, 202, 197, 0.2);
  box-shadow: var(--OpenStarry-shadow-md);
  background-color: var(--OpenStarry-panel-layer-5-background);
}

/* 内容布局 - 关键修复：垂直居中对齐 */
.banner-content {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center; /* 改为center，解决对齐问题 */
  gap: 32px;
  flex-wrap: wrap;
}

/* Logo区域 - 扁平化设计，去除浑浊渐变 */
.banner-logo {
  flex-shrink: 0;
  width: 80px;
  height: 80px;
  background: rgb(136, 202, 197);
  border-radius: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow:
      0 12px 40px -8px rgba(136, 202, 197, 0.35),
      inset 0 1px 0 rgba(255, 255, 255, 0.3);
  position: relative;
  border: none;
}

/* 图标样式 - 关键修复：完美居中 */
.banner-logo .icon {
  width: 48px;
  height: 48px;
  fill: #0b1220; /* 深色填充，提高对比度 */
  display: block;
}

/* 文字区域 - 移除顶部padding，与图标对齐 */
.banner-text {
  flex: 1;
  min-width: 0;
  padding-top: 0; /* 移除8px padding */
  display: flex;
  flex-direction: column;
  justify-content: center; /* 垂直居中内容 */
}

.banner-title-wrapper {
  position: relative;
  display: inline-block;
  margin-bottom: 12px;
  width: 150px;
}

.banner-title {
  font-size: 56px;
  font-weight: 800;
  letter-spacing: 2px;
  margin: 0;
  color: rgb(136, 202, 197);
  line-height: 1;
  display: flex;
  align-items: center;
}

/* beta标签 - 绝对定位右上角 */
.version-tag {
  position: absolute;
  top: -8px;
  right: -50px;
  padding: 3px 8px;
  background: rgba(136, 202, 197, 0.05);
  border: 1px solid rgba(136, 202, 197, 0.2);
  border-radius: 18px;
  font-size: 10px;
  color: rgb(136, 202, 197);
  font-weight: 600;
  letter-spacing: 0.5px;
}

/* 简化分隔线 */
.divider {
  width: 40px;
  height: 2px;
  background: rgb(136, 202, 197);
  margin: 16px 0;
  border-radius: 1px;
  opacity: 0.6;
}

.banner-subtitle {
  font-size: 15px;
  color: #8b9aae; /* 更纯净的灰色 */
  line-height: 1.6;
  max-width: 550px;
  margin: 0;
}

.banner-subtitle strong {
  color: rgb(136, 202, 197);
  font-weight: 500;
}

/* 开发者标签 - 扁平化 */
.banner-meta {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-top: 20px;
  flex-wrap: wrap;
}

.dev-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px 6px 11px;
  background: rgba(136, 202, 197, 0.08);
  border: 1px solid rgba(136, 202, 197, 0.2);
  border-radius: 20px;
  font-size: 12px;
  color: #c4d0dc;
  transition: all 0.2s ease;
}

.dev-badge:hover {
  background: rgba(136, 202, 197, 0.15);
  border-color: rgba(136, 202, 197, 0.35);
}

.dev-badge::before {
  content: '◆';
  font-size: 10px;
  color: rgb(136, 202, 197);
}

/* 引擎标签 - 简化 */
.engine-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.engine-tag {
  padding: 5px 12px;
  background: rgba(136, 202, 197, 0.06);
  border: 1px solid rgba(136, 202, 197, 0.15);
  border-radius: 8px;
  font-size: 11px;
  color: #9ab;
  font-weight: 500;
  letter-spacing: 0.5px;
}

.engine-tag:hover {
  background: rgba(136, 202, 197, 0.12);
  border-color: rgba(136, 202, 197, 0.3);
  color: rgb(200, 235, 230);
}

/* 装饰元素 - 极简 */
.corner-accent {
  position: absolute;
  top: 0;
  right: 0;
  width: 120px;
  height: 120px;
  background: linear-gradient(225deg, rgba(136, 202, 197, 0.08) 0%, transparent 60%);
  pointer-events: none;
    }

.setting-control > .setting-info { flex: 1 1 160px; line-height: 1.65; overflow-wrap: anywhere; }
.setting-control > .compact-control { flex: 0 1 190px; min-width: 150px; }
.setting-control > .mode-switch, .setting-control > .el-switch { flex-shrink: 0; }
.setting-control > .line-input, .setting-control > .number-input, .setting-control > .el-slider { flex: 1 1 180px; min-width: 0; }
.button-row { display: flex; flex-wrap: wrap; gap: 8px; }
.button-row :deep(.el-button), .sync-row :deep(.el-button) { margin-left: 0; }
.sync-form, .sync-row { min-width: 0; }
.sync-url-input, .sync-token-input { min-width: min(260px, 100%); }
@media (max-width: 1050px) {
  .setting-group { grid-template-columns: minmax(0, 1fr); }
  .app-layout { padding: 8px 4px 60px; }
}

.banner-title-wrapper { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; width: 100%; }
.banner-title { font-size: clamp(30px, 4vw, 56px); overflow-wrap: anywhere; }
.version-tag { position: static; }
@media (max-width: 1050px) { .OpenStarry-banner { padding: 28px; } }
</style>
