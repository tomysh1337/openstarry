# OpenStarry NextGen 交接记录

更新时间：2026-09-19  
当前分支：`codex/openstarry-nextgen`  
最近提交：`ae8a61c feat: refine IDEA-style agent tool window`

## 当前状态

- Agent 工具窗口已经按 IDEA 的组织方式整理：会话标签、平面消息时间线、工具执行行、底部输入区和任务状态条。
- 参考仓库只用于观察布局与交互节奏，OpenStarry 代码中没有引入参考项目的品牌名称、Logo 或图标资源。
- 共享工作区测试 9 项通过。
- 手机端 IDE 回归通过，覆盖编辑、审查、预览、Agent、历史和响应式布局。
- 手机生产构建和 Electron 桌面生产构建通过。
- 预览地址：`http://127.0.0.1:5180/`；手机端预览：`http://127.0.0.1:5179/`。

## 用户最新需求

当前供应商配置会打开独立的整页界面。后续需要把它改成 Agent 侧边栏内的小窗口，用户在当前项目对话中完成配置，聊天上下文和输入草稿保持原位置。

小窗口需要包含：

1. 供应商名称。
2. OpenAI 兼容接口地址。
3. 当前设备保存的 API 密钥。
4. 模型 ID 列表，每行一个。
5. 保存、取消和连接测试反馈。

保存成功后应关闭小窗口、刷新 Agent 的模型菜单，并保留当前项目会话；取消或关闭时保留原会话内容。窄屏时窗口使用底部抽屉或可滚动弹层，输入法弹出后保存按钮仍在视口内。API 密钥继续按设备保存，通用供应商和模型配置按既有同步约定处理。

## 实现入口

- 共享 Agent 面板：`SHARED/workbench/src/index.js`
  - `configureModel` 当前调用 `options.configureProvider`。
  - Agent 输入区、模型选择和问题卡都在 `mountWorkbench` 内创建。
- 共享 Agent 样式：`SHARED/workbench/src/workbench-ui.css`
- 桌面 IDE 适配：`CLIENT/openstarry-app/src/renderer/src/views/idePage.vue`
  - 当前 `configureProvider` 跳转 `/dataPage?section=providers`。
- 手机 IDE 适配：`MOBILE/openstarry-mobile/src/main.js`
  - 当前 `configureProvider` 调用 `showProviders()`。
- 桌面供应商页面：`CLIENT/openstarry-app/src/renderer/src/views/dataPage.vue` 及 `views/component/provider_card/`。
- 手机供应商页面与编辑弹窗：`MOBILE/openstarry-mobile/src/main.js` 的 `showProviders` / `editProvider`。

## 下一步验收

- 在桌面 Agent 面板点击“请先配置模型”后出现小窗口，页面路由保持在 IDE。
- 在手机 Agent 面板点击同一入口后出现适配窄屏的弹层或底部抽屉。
- 保存供应商后，Agent 模型菜单立即出现新的模型；第二次打开能读回名称、接口和模型列表。
- API 密钥输入和保存仍只作用于当前设备，并且界面显示清晰的保存结果或错误信息。
- 取消、点击关闭、切换 Agent 会话不会清空已有聊天记录或输入草稿。
- 回归 320、390、768、1280 像素宽度，运行共享测试、手机 IDE 测试和桌面构建。

本交接项只记录需求和实现入口，当前提交中的 IDEA 风格 Agent 改版保持原样。
