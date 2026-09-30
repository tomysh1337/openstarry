# GPT 网页端接入：本地 MCP 与 Cloudflare 公网收发测试

源码 0.3.0 已实现文件 MCP、公网网关、聊天事件/SSE、普通 Edge 扩展适配器，以及 OpenStarry 桌面首页/IDE/IPC/审查入口。真实文件连接器已由用户贴回只读调用结果；首页与 IDE GUI 曾通过网页 fixture 验证，当前扩展方案的真实网页聊天仍待手动验收。`simulate` / `demo:chat` 均为模拟调用。当前待办和阻塞见根目录 TODO / HANDOFF。

下一阶段的唯一待办见 [TODO.md](../../TODO.md)，原理、测试证据和续接步骤见 [HANDOFF.md](../../HANDOFF.md)，产品约定见 [agent.md](../../agent.md)。

桌面入口现在包括实际首页普通对话与 IDE Agent。首页通过同一私有 helper/IPC/SSE 提交 ask 任务，项目为空且无目录；首页本机 IndexedDB 保存网页历史和草稿，暂不参与普通聊天云同步。SHARED/workbench/qa/gpt-web.html 仅为 IDE fixture，不是产品首页。

## 当前浏览器接入：普通 Edge 扩展

专用 Playwright Edge 在用户实测中仍遇到循环验证，启用 Chromium 沙箱也没有解决；桌面 worker 已改用 `extension-page.mjs` 和 [edge-extension](edge-extension/README.md)。助手不操作用户浏览器，由用户加载扩展、配对和验收。

在普通 Edge 的 `edge://extensions` 开启开发者模式并加载 `edge-extension` 目录；在应用选择 GPT 网页版，点击“连接 Edge / 复制配对码”，到扩展粘贴并连接。扩展仅在该普通浏览器中新建 ChatGPT 标签页，沿用它的登录；应用提交消息后才操作所关联标签页。无需重新配置已验证的独立公网文件连接器来测试普通聊天。

配对走单独的私有 loopback 端口，token 仅保存在应用私有目录与扩展本机存储；不经公网，不回传渲染层，不写日志。扩展没有 cookies/debugger 权限，不接管其他标签页，也不处理验证挑战。MCP 领取、增量事件、SSE、历史和本机文件审查沿用原实现。IDE 文件工具需绑定对应项目 helper 的连接器地址，不能复用独立 0922-A 工作区来假装完成项目操作。

文件工具继续使用无状态 POST + JSON 返回的 MCP。新增独立适配器 MCP 接收有序事件，同一服务的本地 SSE 提供快照与增量订阅；服务本身仍不操作 ChatGPT 输入框。完整协议、领取/去重/取消/恢复规则和接口见 [CHAT_PROTOCOL.md](CHAT_PROTOCOL.md)。原文件连接器的完整结果与聊天增量分别处理。

## 2026-09-24 本地流式阶段

- 需要 Node >=24，复用本机 v24.19.0；SQLite 内置。网页适配新增固定版本 playwright-core 1.63.0，使用本机 Edge。
- `npm.cmd test`：32 项通过，包含原 11 项、聊天/背压 13 项和适配器 fixture 8 项。
- `npm.cmd run demo:chat`：独立临时项目，官方 MCP SDK 写入测试中文，再从认证 SSE 逐段读取；不会连接或改动持久演示服务。一次实测首段比完成提前 636 ms，来源为 fixture。
- 本机 49321 已启动 0.2.0，健康检查通过；管理注册为每个适配器分配独立能力地址，适配器没有接受文件修改权限。
- 2026-09-24 23:56 公网 49323 已恢复：当前订阅更换后旧 Cloudflare 专用脚本缺失，引发 Fake-IP / QUIC 超时。专用 DNS 和 DIRECT 规则已恢复并写入全局 Script.js，连续 605 秒、18 轮只读公网 SDK 检查全部通过；不是仅根据 connected 作判断。当前地址在私有连接地址文件，完整证据见 HANDOFF。

真实提议 `154a6914-d8df-47cc-b9a6-99f5c755781a` 当前为 `pending`，对应任务 `83ad42f6-7c89-4881-8fb9-cd1aa95a6f8b` 为 `awaiting_review`。`hello.txt` 仍保留原文；等待用户明确接受。49321 旧进程仍是 0.2.0，其 `browserConnected: false` 是旧占位。新 0.3.0 helper 根据网页/登录观测生成健康状态，仍不代表公网连接器是否成功。

## Cloudflare 公网配置与历史测试

**依赖已安装，不需要用户重复安装。** 本机已有 cloudflared 2026.9.1，MCP SDK 与 Zod 已安装。下面的安装/启动命令仅用于日后重建或重启。

- 本机 MCP：`127.0.0.1:49321`。
- MCP 专用公网转发入口：`127.0.0.1:49323`，只转发精确的 MCP 凭据路径及健康检查。
- Cloudflare Quick Tunnel：临时 HTTPS 域名。最新完整连接地址在 `.state/control/GPT-MCP连接地址.txt`，结构化信息在 `public-connection.json`。完整 URL 含访问凭据，仅复制给自己使用的 MCP 客户端，不公开分享。
- 公网没有 `/admin/*`；接受/拒绝修改仍走本机管理接口，独立管理令牌不经过公网转发层。
- 实测公网 SDK 握手、7 个工具列举、本机任务送出、公网修改建议接收和结果回传全部通过；测试提议已拒绝，原文件未变。记录在 `.state/control/public-verification.json`。
- 电脑、本机 MCP 和 tunnel 都需保持运行。Quick Tunnel 重启可能更换域名，不作为固定生产地址。
- 2026-09-23 已恢复一次临时隧道失效：本机服务未停，但旧公网地址已失效；客户端必须更新成地址文件中的最新完整 URL。`0922-A` 任务和修改历史均保留。
- 隧道现默认 `--protocol auto --edge-ip-version 4`，会选择可用传输；Cloudflare 专用 Clash 规则修复后，QUIC / HTTP/2 均已通过预检。需要明确指定时可向 tunnel 脚本传 `--protocol quic` 或 `--protocol http2`。
- 地址文件现在显示 `connecting`、`connected`、`reconnecting`、`expired`、`stopped` 状态。`connected` 表示最近的 edge 注册成功，不代替完整公网调用验证；`expired` 表示临时隧道已失效，需要重建并更新客户端 URL。

### 本机 Clash TUN 共存修复（2026-09-23）

用户已同意为本隧道设置专用规则。当前 Clash 订阅增强脚本中添加了 `cloudflared.exe` 和 `argotunnel.com`、`trycloudflare.com`、`cftunnel.com` 的 DIRECT 分流，并仅对这三个域名排除 Fake-IP、指定直连 DoH。TUN、现有节点与其他分流保留。

备份位于 `C:/Users/LP/AppData/Roaming/io.github.clash-verge-rev.clash-verge-rev/backups/openstarry-tunnel-20260923-223616`。规则通过当前订阅的增强脚本持久化；若换到另一个订阅，需要重新检查是否继承这些专用规则，不要直接复制覆盖其他订阅的自定义脚本。

配置校验、热加载和 DNS 实测通过，边缘域名恢复真实 `198.41.x.x` 地址；QUIC、HTTP/2 和公网 MCP 往返均已成功。还单独验证了用户报错的 `get_status` 和 `list_tasks`。本机实际服务端口是 49321，不是原 MoonCode 教程中的 48271。

2026-09-24 已处理换订阅后旧脚本被删除的问题：目前采用全局 profiles/Script.js，仅保留上述三域名与 cloudflared.exe 的专用变更。新备份目录为 backups/openstarry-tunnel-dns-2026-09-24T15-42-45-125Z。真实连接已确认走 DIRECT 与 198.41.*；如再次换订阅，应核对运行中的规则与系统 DNS，不仅检查保存的文件。

稳定性验证运行 `node verify-stability.mjs`：默认连续十分钟，只做健康检查、MCP 握手/工具列表和已有任务/文件读取，不创建或接受提议。任一公网失败、域名变化或日志出现断线都令本次验证失败；结果写入私有 public-stability.json。需要更长观测可传 `--duration-ms`，不能把短时成功描述为永久在线。

如需回滚，只恢复这次添加的字段和脚本片段，先核对期间是否有新的用户配置，避免用旧备份覆盖后续改动。备份含原代理配置，保持本机私密保存。

下次重启时，先启动本机服务，再在另一终端运行：

```powershell
npm.cmd run tunnel -- --cloudflared "C:/Program Files (x86)/cloudflared/cloudflared.exe"
```

重新验证公网收发：

```powershell
npm.cmd run verify:public
```

验证会创建一条独立测试任务、通过公网提交建议、在本机拒绝该测试建议并回报结果，不自动接受文件修改。它验证公网 MCP 通道，不代表你的 ChatGPT 账号已连接。

## 第一步怎么测

在 PowerShell 进入此目录。仅在新机器或清理依赖后重新安装：

```powershell
npm.cmd ci --ignore-scripts
```

终端 A 启动独立测试项目：

```powershell
npm.cmd run demo
```

仅监听 `127.0.0.1:49321`，健康检查是 `http://127.0.0.1:49321/health`。测试文件位于 `.state/workspace/hello.txt`，不访问 OpenStarry 的聊天资料或其他项目。重启不覆盖已有测试文件。

终端 B 每次执行一条：

```powershell
# 1. 模拟网页端，通过真实 MCP 协议收发一次任务和修改建议。
npm.cmd run client -- simulate

# 2. 查看任务结果和待审查内容，包含 before / after。
npm.cmd run client -- tasks
npm.cmd run client -- proposals

# 3. 这时原文件应仍为 Hello from OpenStarry.（首次运行）。
Get-Content -LiteralPath .state/workspace/hello.txt

# 4. 将 PROPOSAL_ID 替换为 proposals 输出中的 id；只执行你选择的一条。
npm.cmd run client -- accept PROPOSAL_ID
# 或：npm.cmd run client -- reject PROPOSAL_ID

# 5. 接受后重新读取，应该变为中文测试文本。
Get-Content -LiteralPath .state/workspace/hello.txt
```

当前持久演示项目保留以前的任务与待审查提议。先查服务状态，避免在相同端口重复启动；服务停止后再运行 `npm.cmd run demo`。本轮流式演示使用单独的 `demo:chat` 临时项目，没有再次运行持久目录的 `simulate`。

提交自己的纯文本测试任务：

```powershell
npm.cmd run client -- task "读取 hello.txt，为它提出一处修改，等待我的确认"
```

任务会进入队列。真实 ChatGPT 连接器已经能在用户于网页触发后读取任务并回报结果，此处 CLI 创建的是文件任务，不触发网页聊天。应用创建独立的聊天任务并由 desktop-worker 管理网页适配器自动领取；两者通过 fileTaskId 关联。

## MCP 配置与权限

完整 MCP 地址和独立的本机审查凭据写入 `.state/control/connection.json`，不在终端打印，也已被 Git 忽略。连接文件包含凭据，请只在本机查看和使用；不要把它发到 GitHub、聊天或日志中。停止服务使用终端 A 的 Ctrl+C。

工具包括 `get_status`、`list_tasks`、`get_task`、`list_files`、`read_file`、`propose_file`、`report_result`。MCP 客户端没有“接受修改”或执行命令的工具；接受/拒绝使用本机独立管理令牌。

- 默认仅做 UTF-8 单文件新增/替换建议，128 KiB 上限；没有删除、重命名、终端或自动执行代码。
- 每个建议保存文件 SHA-256 版本。确认时再次核对，避免覆盖在外部刚改过的文件。
- 重复 request_id 只复用相同建议；携带不同内容会报冲突。
- 确认前保存备份；异常中断的 applying 状态在重启后标为 recovery_required，不自动再次写入。
- 排除项目外路径、链接/目录联接、隐藏文件、常见凭据文件和 Windows 特殊路径。
- 任务、建议、连接密钥及备份保存在项目范围之外的 `.state/control`；Windows 文件权限继承当前用户目录，适合本机单用户测试，不是多租户服务。
- 当前上限为 200 个任务/建议，不提供自动删除历史；MCP 地址只覆盖一个工作区，不做多用户授权隔离。
- 用户已要求开启 Cloudflare Tunnel，公网测试仅开放独立测试工作区的 MCP。当前账号的 ChatGPT 连接器已通过真实任务回传验证；这不代表网页自动发送、聊天流式或其他账号已经验证。

如果测试自己的独立目录，使用新的私有状态目录：

```powershell
npm.cmd start -- --workspace "D:/MyTestProject" --state-dir "D:/MyTestState" --port 49322
npm.cmd run client -- --state-dir "D:/MyTestState" tasks
```

## 源码参考与改造范围

用户提供：`D:/MoonCode/analysis/mooncode-mcp-github/artifacts/mooncode-subagents-source.tar.gz`。

压缩包 SHA-256：`53a92afb3a62f0635957eb6226bb1e19f87c218ed59cb7b6ba52997f91fa4ece`。

本实现参考了以下设计，重新编写为便于逐步测试的小型服务，没有执行压缩包里的安装脚本，也没有引入其账号导入、隧道、桌面控制或子代理：

| 原源码 | 本阶段采用的设计 |
| --- | --- |
| `hub/chatgpt.mjs` | 网页适配与本地文件服务分离；web-page / web-adapter 已实现，实时选择器待验收 |
| `hub/orchestrator.mjs` | 显式任务/动作标识，工具结果回传；不把普通回复自动当命令 |
| `runtime/bridge-http.ts`、`README.md` | Streamable HTTP、仅 loopback、随机 capability URL |
| `tool-gateway/workspace-patch.ts` | SHA-256 版本校验、变更备份与异常恢复状态 |

与原 Bridge 的区别：原 `apply_patch` 可直接提交事务；这里的 `propose_file` 仅生成建议，本地用户通过独立管理端确认后才保存。第一阶段不是原 MoonCode 15 个工具的完整兼容实现。

## 验证

```powershell
npm.cmd test
```

覆盖 SDK 互通、任务往返、审查确认、版本冲突、重复请求、路径限制、认证、跨来源请求、目录联接、备份和重启恢复。测试使用系统临时目录，并在结束时仅清理自行创建的测试目录。

32 项本地 MCP / 适配器测试、6 项桌面服务测试、7 项首页测试及 22 项共享工作台测试通过。桌面和手机构建、Windows unpacked 资源检查通过。用户已允许项目 Playwright/Electron，IDE fixture GUI 已通过；实际首页 GUI 和真实 ChatGPT 仍待测。Cloudflare 已恢复并完成 605 秒、18 轮只读公网检查。覆盖安装、推送和 Release 继续暂停。
