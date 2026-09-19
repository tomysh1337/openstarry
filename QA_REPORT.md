# OpenStarry NextGen 1.2.0 复测报告

日期：2026-09-17。被测提交：`9e66ad514e757f6c6fc5969155da79b4ca279400`。

本次发现两处已复现的功能缺陷：电脑控制获取窗口状态时审批桥接报错，以及重新加载界面后已保存的模型选择被覆盖。另有启动耗时偏长的性能问题。以下结论针对未修改的 1.2.0 产物，发现项尚未修复。

## 2026-09-19 增补：供应商卡片溢出已修复

用户截图中的供应商卡片底部 Test 按钮和日期越过边框，已在 Windows 10 的浏览器渲染中复现：原卡片固定高 250 像素，两个控件底部超出约 13.39 像素。此问题与此前设置页的溢出测试属于不同组件。

修复文件：`CLIENT/openstarry-app/src/renderer/src/views/component/provider_card/providerCard.vue`。卡片改为最小高度，实际高度由内容撑开；底部信息区保留所需高度，名称与元数据网格允许收缩，长文本换行或省略。

验证使用实际供应商页面、全局样式和 Element Plus 组件，本地替身仅提供供应商数据与连接测试接口。1440/1040/800 像素宽度 × 100%/125%/150% 页面缩放 × 空描述/长文本，共 18 组检查通过，卡片控件及页面均无溢出；连接按钮与编辑入口正常，未出现渲染器异常。`npm run build` 通过。

证据：`tmp/provider-layout-20260919/before.json`、`after.json`、修复前后截图及 `build.log`。测试在 Edge 中运行源码页面，不替代发布安装包实机验收；本次提交未生成新 Release。

本次巡检时 OpenStarry 未运行，未将停止的端口作为故障。没有既有日志游标文件，按前次测试记录核对桌面日志的修改时间，未重读旧错误；已记录日志偏移供下轮增量巡检使用。下文的两处功能缺陷与启动性能问题继续保留。

## 环境与范围

- Windows 10 Pro 22H2，19045.6466。
- 实际运行 `CLIENT/openstarry-app/dist/win-unpacked/OpenStarry-NextGen.exe`，渲染器来自 `app.asar/out/`，不是开发服务器。
- 使用全新的隔离配置目录 `tmp/qa-v120-retest`，真实完成首次组件准备；测试数据与用户配置分开。
- 移动网页运行已构建的生产资源；聊天模型使用本地 OpenAI 协议测试服务，同步测试覆盖实际桌面 SQLite 和同步存储。
- 桌面 GUI 通过 Electron CDP 操作并截图。本轮不包含重新运行安装向导、覆盖安装或卸载测试。

## 已复现的问题

### 1. 电脑控制审批桥接错误（高优先级）

默认自动允许模式下，窗口枚举成功；对枚举到的 OpenStarry 窗口调用应用自身的 `computerAction('get_window_state', { window, include_screenshot: true, include_text: false })` 后失败：

```text
Error invoking remote method 'computer:perform':
Error: Computer Use requires app approval but elicitations are unavailable
```

定位：`CLIENT/openstarry-app/src/main/app/computerUseManager.js:26` 的 `_configureApprovalBridge()` 将回调写到 `nodeRepl.config.createElicitation`，随包分发的 `helper_transport.js` 实际从 `nodeRepl.createElicitation` 读取回调。

影响：窗口枚举成功不足以证明实际查看窗口、截图及后续输入操作可用。修复后应覆盖自动允许、每次询问、关闭三种模式，并重新执行窗口状态与真实输入测试。

证据：`tmp/retest-20260917/start.err.log`，以及隔离配置目录下的 `logs/desktop.log`。

### 2. 已保存的模型选择在重新加载后被覆盖（高优先级）

复现步骤：

1. 在聊天栏供应商 `QA Retest` 中准备 `fixture-model`、`second-model`、`manual-model` 三个模型。
2. 通过 GUI 下拉框选择 `second-model`，确认界面状态与共享偏好存储均已保存该值。
3. 重新加载打包应用的界面。
4. 模型变为列表第一项 `fixture-model`，共享偏好存储也被改写；温度仍为 37。

实际结果：

| 读取位置 | 重新加载前 | 重新加载后 |
| --- | --- | --- |
| 聊天栏模型 | second-model | fixture-model |
| 持久化模型偏好 | second-model | fixture-model |
| 温度 | 37 | 37 |

定位：`CLIENT/openstarry-app/src/renderer/src/views/assistPage.vue:2332` 的供应商 watcher 在首次挂载时清空模型名；`ensureValidModel()` 随后保存列表第一项。这会与启动时恢复共享偏好的流程相互影响。完整重启和单独重新加载界面均观察到回退，单独加载的复现已保存前后状态和失败断言。

影响：供应商及模型列表编辑可以使用，当前选中模型的持久化仍有缺陷；同一运行会话内同步成功不代表重开后保持正确。

证据：`tmp/retest-20260917/model-persistence.cjs`、`model-persistence.json`。

### 3. 已安装组件的再次启动仍偏慢（性能观察）

正常退出测试应用后，以同一配置目录再次启动：

- 四份 `*-setup.log` 的大小、修改时间与 SHA-256 均未变化。
- 四份 `.openstarry-runtime.json` 的大小、修改时间与 SHA-256 均未变化。
- 四个组件最终全部就绪，启动提示明确显示组件已安装。
- 从发起启动到桌面聊天 WebSocket 连接成功约 **70.77 秒**。这是本机单次观测值，不是多轮性能基准。

本轮没有复现重复准备或重新下载组件；等待主要发生在组件启动阶段，尤其是智能助手。建议另行分析 Python 导入及服务初始化耗时。

证据：`tmp/retest-20260917/restart-before.json`、`restart-result.json`、`restart-start-ms.txt`、`restart.log`。

## 通过的验证

| 项目 | 实际结果 |
| --- | --- |
| 手机聊天与同步测试 | `MOBILE/openstarry-mobile` 的 `npm test`：6 项通过，覆盖真实 SQLite 双向聊天、离线队列、同步期间修改、错误重试、账号隔离及异常响应保护 |
| 桌面同步协议 | `CLIENT/openstarry-app` 的 `npm run test:sync`：4 项通过 |
| 同步服务器存储 | `SYNC/sync_server` 的 `python3.12 -m unittest test_store.py`：3 项通过 |
| 移动网页 GUI | 首次发送与回复、重新加载历史、模型列表编辑、360/390/768 像素宽度、减少动态效果；测试期间无渲染器异常 |
| 桌面供应商 GUI | 从聊天栏新增供应商、获取模型、重新打开编辑器、手动增改模型列表并保存；选中模型重开后回退见问题 2 |
| Agent 问题卡 | 实际 Agent 工具链触发双问题；宽版卡片与输入框对齐；选项可提交，补充可留空；提交后原任务继续 |
| 桌面实时接收同步 | 当前已打开的聊天显示手机来源的新消息，模型及温度偏好立即更新，无需重启；重开后的模型缺陷单独记录 |
| 历史保留 | 完整重启后从历史列表打开原会话，Agent 回答和手机同步消息均保留；启动默认进入新会话，不自动打开上一次历史 |
| 设置布局 | 1440/1040/800 像素宽度下，测试中的卡片没有水平内容溢出 |
| 主要页面 | 智能体、文件资源管理、数据中心、自动任务、设置五页均显示内容，启动遮罩正常结束 |
| 快速导航与输入 | 预热页面后连续切页 30 次；266 个动画帧采样中，内容区隐藏帧为 0；设置滚动 680 像素后输入响应正常；无渲染器异常 |
| 减少动态效果 | 对应偏好下页面动画停止，交互正常 |
| 更新检查 | 1.2.0 正确提示已是最新版本 |

快速导航采样验证内容是否保持显示及交互是否响应，不等同于帧率基准或动效审美验收。

## 尚待设备验收

- Android 真机或模拟器：本机没有已连接设备，原生输入法、安全区、后台恢复和原生网络请求仍待验证。移动网页 GUI 测试不替代 APK 真机测试。
- Windows 系统气泡：真实提问流程已执行通知触发路径，本轮未完成通知气泡的视觉确认。
- Windows 11 独立设备测试。
- 外部原生测试工具在这台 Windows 10 上截图时另报 `SetIsBorderRequired failed (0x80004002)`，继而缺少坐标输入几何信息。这与问题 1 的应用内部审批桥接错误分别记录；本轮桌面截图和 GUI 操作由 CDP 完成。
- 真实第三方模型供应商的联网对话与计费请求不在本轮测试范围内。

截图包括 `tmp/qa-ui/desktop-question-wide.png`、`tmp/retest-20260917/desktop-smoke.png`、`tmp/retest-20260917/desktop-after-restart.png`。临时证据位于被 Git 忽略的 `tmp/`，仅保留在本机。
