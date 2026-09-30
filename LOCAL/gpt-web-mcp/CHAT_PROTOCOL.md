# GPT 网页聊天协议 v1（2026-09-24）

## 2026-09-26 增补（优先于下方旧版本描述）

- 扩展 0.4.0 的 inspect 可返回 `textUpdates: [{messageId,text,offset,replace,observedAt}]`，只在实际文本观察时消费；连接检查使用 consumeUpdates=false。适配器按当前回复 ID/offset 校验，输出 text_delta 或 text_snapshot，再与最新正文对齐。网页实际 DOM 批次可能包含多个字符；应用即时显示，不做完成后的逐字重放。
- chat.sqlite 保存 finishedAt；tool_started/工具快照增加 provider、startedAt，tool_completed 增加 durationMs。服务观察的真实 MCP 调用使用独立服务器 seq，不占 adapter clientSeq。每字段 8k 字符，最多 32 个工具/回复；并发无唯一归属时不猜测。
- 子 Agent 公共工具为 spawn_subagent/list_subagents/get_subagent/cancel_subagent。task_id 指父文件任务；子任务 source=subagent、独立 ChatGPT session，返回 file_task_id。最多 2 个子任务与父任务并行，8 个/父、16 个未完成任务；get_subagent 支持 offset/limit 和最多 20 秒 wait_ms。结果及提议保留，父完成前检查子任务与待审查内容。
- 本机 file-access.json 可设置 safetyMode=ask/auto/full。缺省 direct→auto、review→ask；安全等级不由公共工具更改。write_file 输入与 propose_file 相同：ask 提议，auto 新建直存/覆盖提议，full 版本检查后保存并备份。propose_file 总是提议，旧 pending 不自动接受；get_status 返回实际策略。
- sandbox_run 输入 task_id/request_id/command/network=false/timeout_seconds=120，返回 execution ID；sandbox_result 按 task_id/execution_id/offset/limit 读取，sandbox_cancel 停止。后台临时容器无宿主挂载，网络默认 deny，审批仅本机 admin。记录在私有 sandbox-jobs.json；重启标记 interrupted，不自动重跑。部署说明见 OPENSANDBOX.md。
- 本地管理新增 policy、sandbox、sandbox/health、sandbox/:id/read|approve|reject|cancel、subagents 和 subagents/:id/read|cancel。公网网关仍只转发原精确 MCP capability，所有 admin/配对/适配器接口留在 loopback。
- 真实 OpenSandbox 密钥和日志在用户 LocalAppData 私有目录，受文件工具保护；当前仅安装 Python/server，缺 Docker/WSL，真实容器和 ChatGPT 接入仍待验收。

实现范围：聊天任务、适配器 MCP、事件日志、认证 SSE、普通 Edge 扩展适配器、Electron 来源/IPC 和服务管理。实际首页和 IDE 已通过网页 fixture GUI；扩展接入和实时 ChatGPT 页面仍待用户手动验收。`demo:chat` 和聊天自动测试使用 `source=fixture`；打包检查只启动空队列 helper，均不构成真实网页证据。

## 接入设计

实际桌面首页与 IDE Agent 均提供 GPT 网页版来源。网页适配器由本机应用进程管理，通过 OpenStarry Bridge 扩展使用**普通 Edge 的 ChatGPT 标签页**。此前持久化独立 Edge 方案在用户实测中遇到循环验证，启用沙箱未解决；desktop-worker 现默认使用 extension-page.mjs，保留原 web-page.mjs 作历史实现，不自行回退到独立浏览器。

已只读复核 MoonCode `hub/chatgpt.mjs` 的可见浏览器、会话页面映射、DOM 文本增量/替换思路，以及上一轮对 `hub/orchestrator.mjs` 的分层分析。已实现的适配器遵循以下约束：

- 本机适配进程只发固定 page / inspect / send / stop / download 动作，由已配对的扩展执行；页面本身没有本机管理或配对令牌。使用普通浏览器现有登录，不导入 Cookie，不操作验证挑战。
- 每个本机会话绑定网页 conversation ID；页面中从头覆盖的回答发 `text_snapshot`，仅追加内容发 `text_delta`。
- 发消息前，先确认输入框和会话归属，再提交 `dispatching` 并等待服务确认，之后执行一次发送。重启恢复要先查看已有网页消息，不按 queued 逻辑再次点击发送。
- 登录页、验证挑战、额度限制、页面选择器变化分别报告真实可见状态。完成需观察生成按钮/回答结束信号，固定等待时间只作辅助。停止需先请求网页停止，再观测结束后确认。
- 适配器在私有配置持久化 claimToken、eventId、clientSeq 与未确认事件，以支持相同内容重试。丢失发送凭据或页面归属时保持中断，留待显式核对。

```text
应用主进程 -- 本地 admin Bearer --> 聊天任务 / 取消 / SSE
网页适配进程 -- 独立适配器 MCP capability --> 领取 / 心跳 / 追加事件
                          ↕ 私有 loopback 配对 / 固定动作（不进公网）
                  普通 Edge 扩展 ↔ 所关联的 ChatGPT 标签页

ChatGPT guess 连接器 -- Cloudflare --> 原有 /mcp/<文件工具凭据>
                               任务/文件/修改提议/完整结果
```

以上接口都在同一个 `server.mjs` 服务内，独立演示默认 loopback 49321，应用 helper 使用临时 loopback 端口。公网网关只转发原文件工具 MCP 的精确路径和健康检查；适配器 MCP、管理接口和 SSE 均不经网关开放。普通聊天任务存于 `chat.sqlite`，原文件修改任务/提议仍存于 `state.json`，两者不会混用旧测试任务。

## 身份与接口

### 文件范围（2026-09-25）

本机私有 gpt-web/file-access.json 保存 `{ "version": 1, "fileScope": "all-disks", "newFilePolicy": "direct" }` 可启用全盘和新文件直接保存；缺省为 workspace/review。用户已确认并设置当前手动入口为全盘、新文件直存、覆盖仍审查，重开 helper 生效。get_status 返回 fileScope/newFilePolicy/existingFileReviewRequired，reviewRequired 保留为 true 表示既有修改审查仍在。公网转发范围仍只有文件 MCP，admin/适配器/配对端点继续只在本机。

- 全盘 list_files 无参数返回 roots；传绝对目录 path、offset/limit 返回 files/directories/nextOffset，默认一页 200 项、最多 500 项，末页 nextOffset=null。目录修改期间分页为当前目录视图，不建立全盘索引。
- 全盘 read_file 接受本机绝对路径，task_id 可省略；工作区模式仍需要任务与相对路径。单文件 UTF-8 / 128 KiB 上限保持一致，系统权限错误明确返回。
- propose_file 的本机任务、版本检查、pending 审查及接受备份机制保持一致。全盘路径不替换 state.json 的原 workspace 身份，历史提议不会因配置范围改变而被自动接受。
- 服务内部 control、配对 profile 与范围配置、旧原型 .state 不经文件工具公开；设备/UNC/ADS/父级跳转及链接路径排除。全盘是目录范围扩展，不包含管理员提权或新的命令执行工具。

### 新建与覆盖（2026-09-25）

- 文件 MCP 共 9 个工具，文件工具协议版本 0.2.0，新增 create_file 和 create_task。连接器需刷新工具列表。
- create_file `{path, content, request_id, task_id?}`：仅 newFilePolicy=direct 时可调用，空任务队列可直接新建。绝对路径按全盘配置检查，相对路径按工作区检查；UTF-8 文本上限 128 KiB。创建父目录后再次核对路径，wx 独占创建，写入并 sync 成功后持久化 created 收据再返回。FILE_EXISTS 指向 read_file/propose_file，不隐式覆盖。review 配置使用 create_task/propose_file 审查新建。
- 新建收据以 request_id 唯一，保存 path/version/taskId/status/时间；同请求重试返回原结果及 replayed=true，不验证或重写后来变化的文件。参数变化返回 REQUEST_CONFLICT。creating 中断后转 recovery_required，重试报错要求核对磁盘文件。单个 worker 最多保留 1000 条创建收据，不自动淘汰。
- create_task `{prompt, request_id}`：为当前用户请求创建 source=connector 文件任务，返回 id 用于 read_file/propose_file/report_result；按请求 ID 幂等，任务上限继续为 200。没有任务时使用此工具，不借用旧测试任务。
- 已有文件流程：read_file 取得 version → create_task（若缺少适用任务）→ propose_file → awaiting_review → 本机接受/拒绝。版本校验、备份和 pending 阻止提前完成继续生效。

### 首页服务管理（2026-09-25）

- 首页右上方 `McpServiceControls` 经 `ide:gpt-services` 调用主进程，固定 action 为 status / bridge-start / bridge-stop / tunnel-start / tunnel-stop / copy-address / pair / review-read / review-accept / review-reject；沿用主窗口及主 frame 的来源检查。审查动作还需当前 projectId/proposalId，工作区改变后拒绝旧操作，不自动切换服务。轮询只传提议摘要，review-read 才返回前后全文；界面显示绝对路径和转义文本，接受后才显示已保存。
- status 仅读取当前自有 worker 状态。启动/配对仅在服务不存在时使用首页项目；服务已属于 IDE 项目时复用该项目，并回传 projectName 供界面显示。后台刷新不换项目、不启动进程。
- 启动 Tunnel 自动准备 Bridge。停止 Bridge 前核对所有聊天任务均为终态；退出时关闭 worker 自有 Tunnel、适配器与本地 HTTP。停止 Tunnel 单独保留 Bridge。旧独立服务不纳入此生命周期。
- `desktop-tunnel.mjs` 串行管理启停，返回状态、公共 origin、running 与错误，不回传私有 URL。配对码及完整公网地址仅由主进程复制到剪贴板。connected 表示 cloudflared 边缘连接已注册，真实 ChatGPT 工具调用需要单独验证。

Node >=24，内置 `node:sqlite`；网页操作使用 Manifest V3 扩展和普通 Edge。`playwright-core@1.63.0` 仍供历史 driver / 既有测试使用，桌面 worker 不通过它启动浏览器。私有状态目录位于工作区外。应用打包白名单包含扩展源码、Node、cloudflared 和生产依赖，排除状态和浏览器配置。

### 扩展传输与配对

- 扩展 0.3.0 的页面响应包含 contentVersion=3。旧版本需重新加载扩展并刷新 ChatGPT 标签页，未升级时拒绝发送并提示具体操作。
- file_links 事件保存 artifacts:[{path,name,messageId}]，上限 32 条。path 仅为已观测的 sandbox:/mnt/data/ 引用，不是本机路径或任意下载 URL。主进程根据 taskId 核对文件归属后发送固定 download；扩展在对应会话、对应 assistant message 中精确匹配 DOM 链接，由原网页处理登录和文件下载。返回 requested 表示点击请求已发起，不代表保存成功。旧任务的 Markdown 内联引用仅在原问题仍匹配时处理。
- 应用逐字显示属于收到 text_delta 后的展示队列：只呈现已收到的内容，队列最多约 1 秒追平，大批自适应加速；历史、修订、停止、完成立即同步全文。该动画本身不作为真实流式证据。
- 新任务可包含 thinking:boolean；省略时兼容旧任务沿用网页设置。新 UI 按会话保存开关，并固定到本次请求。此字段参与请求幂等，设置不同需使用新请求 ID；不是提示词前缀或模型五档参数。
- send 在输入前设置网页“思考”，验证状态后填写并点击一次，直到观察到对应的新用户消息才返回 sent=true；确认不明不重发。page 等待输入框就绪；完成用当前 turn 的明确标记结合非 busy 和稳定正文确认。
- 正文生成中每次观察都可追加 text_delta/text_snapshot，无需等待 finished。扩展活跃期间轮询 100ms，适配器观察间隔 80ms；实际端到端延迟由页面和传输共同决定。完成标记缺失会返回具体错误并保留正文。

- 每个应用配置的 browser-profile/edge-extension.json 保存随机 token 和 loopback 端口，跨项目 helper 重启复用。`show` 在主进程把 osb1 配对码写入剪贴板，渲染层只获得状态。
- 扩展 popup 由用户粘贴配对码；仅接受 http://127.0.0.1 的明确端口。配对 token 只存在本机，扩展 local/session 存储限 TRUSTED_CONTEXTS。manifest 仅有 storage/alarms 与 ChatGPT/loopback host 权限。
- 独立扩展服务只有经过 Bearer 验证的 POST /poll 和 /result，检查 Host / 扩展 Origin / clientId，限制大小、队列和期限。普通网页跨来源访问拒绝，原 Cloudflare 网关不转发这些路由。
- 命令 ID 在确认前保持不变；扩展在发送前保存意图和内容摘要，重试只返回已存结果，未知结果不再次点击。观察动作可重试；页面发送还核对会话和旧消息基线，已有草稿保留。
- 扩展只关联自己创建的 ChatGPT 标签页；断开和应用退出保留这些页面。页面来源变化、登录、验证或发送结果不确定时给出明确错误，不声称已经完成。
- 网页增量仍由 WebAdapter 经适配器 MCP 写入同一聊天服务，再通过原 SSE/IPC 回应用；配对传输不替代聊天任务或事件持久化协议。

| 调用方 | 接口 | 行为 |
| --- | --- | --- |
| 本机应用 | `POST /admin/chat/adapters` | `{adapterId, source}` 注册适配器，返回一次独立 `mcpUrl`；重复 ID 为 409 |
| 本机应用 | `GET /admin/chat/adapters` | 读取 ID 与配置来源，无凭据 |
| 本机应用 | `POST /admin/chat/tasks` | 提交下方任务对象，相同请求幂等返回 |
| 本机应用 | `GET /admin/chat/tasks` | 任务路由/状态摘要，不批量返回正文和工具内容 |
| 本机应用 | `GET /admin/chat/tasks/<taskId>` | 当前完整任务快照，无 claimToken |
| 本机应用 | `POST /admin/chat/tasks/<taskId>/cancel` | 空对象，请求停止或取消尚未发送的任务 |
| 本机应用 | `GET /admin/chat/tasks/<taskId>/events?after=N` | 认证 SSE；`Last-Event-ID` 存在时优先使用该游标 |
| 网页适配器 | `POST /adapter-mcp/<独立凭据>` | 无状态 MCP 工具调用，来源身份从凭据确定 |

所有 `/admin/chat/*` 要求原本机管理 Bearer；浏览器页面跨来源访问被拒绝。适配器凭据只以 SHA-256 保存在 SQLite，注册响应交给本机适配进程私有保存。管理端凭据与文件连接器凭据不会获得相互替代的接口权限。

注册 `source` 为 `fixture` 或 `chatgpt-web`，服务写入每个任务及事件。它表示配置来源，**仅有这个字段不构成真实网页验收证据**；验收还需网页发送、首段和完成时间的独立记录。

```json
{
  "clientId": "desktop-device",
  "adapterId": "local-web-adapter",
  "sessionId": "local-session-1",
  "messageId": "local-message-1",
  "requestId": "send-request-1",
  "prompt": "用中文回答"
}
```

上述 ID 为 1–128 位字母、数字、下划线或连字符；提示文本最多 16000 字符。服务生成 UUID `taskId`。`clientId + requestId` 标识一次提交，变更内容复用请求会返回 `REQUEST_CONFLICT`；同一客户端/会话的 messageId 不重复。

本机会话绑定适配器和唯一网页会话。领取时读取最新 conversation ID，保证预先排队的下一条消息拿到前一条确认的映射。同一个会话按提交次序串行；不同会话协议允许独立执行，应用是否同时启动多个网页生成仍待产品验收，不把协议能力当作用户并发偏好。

## 四个适配器 MCP 工具

- `list_chat_tasks {}`：只返回当前适配器的任务摘要。
- `claim_chat_task {taskId, claimRequestId}`：领取任务，返回任务正文与 claimToken。同一 claimRequestId 可重试。未发送任务的领取租期为 30 秒；租期内其他 worker 冲突。未发送且过期可以重新领取，旧 token 随即失效。
- `heartbeat_chat_task {taskId, claimToken}`：续租，返回当前快照及 `cancelRequested`。适配器应在生成中每 10 秒以内检查一次，并据此请求网页停止。
- `append_chat_event {taskId, claimToken, clientSeq, eventId, type, payload}`：写入一次观测。`clientSeq` 从 1 严格递增；`eventId` 按任务唯一，相同序号与内容重试返回原 ack。乱序、不同内容复用 ID、外部适配器或失效领取凭据均被拒绝。

一旦收到 `dispatching`，服务永远不通过超时自动重新分配发送。既有 owner 可续租/恢复观察，其他 worker 收到 `DELIVERY_UNCERTAIN`。claimToken 只在领取响应返回，不写入 SSE、普通任务详情或日志。

## 事件与状态

事件包含 `protocolVersion/taskId/clientId/sessionId/messageId/requestId/source/seq/eventId/timestamp/type/payload`。服务端 `seq` 单调递增，包括 queued、claimed、取消请求、重启等服务事件；它与适配器 clientSeq 不同。

| 适配器事件 | payload | 含义 |
| --- | --- | --- |
| `dispatching` | `{}` | 持久化发送意图，成功确认后才操作网页 |
| `started` | `{webConversationId}` | 已观察到网页生成开始，绑定网页会话 |
| `resumed` | `{webConversationId}` | 重启中断后核对同一网页并恢复观察 |
| `text_delta` | `{text}` | 追加正文 |
| `text_snapshot` | `{text}` | 完整替换已观察正文，用于页面重绘/修订 |
| `tool_started` | `{toolId,name,input?}` | 保存页面真实提供的工具开始记录 |
| `tool_updated` | `{toolId,output}` | 替换该工具的当前可见输出 |
| `tool_completed` | `{toolId,output,error?}` | 结束工具记录 |
| `proposal_pending` | `{proposalId}` | 仅记录待审查引用，不赋予文件写入/接受权限 |
| `completed` | `{}` | 网页实际完成；文件提议仍独立待审查 |
| `error` | `{message,code?}` | 明确错误并保留已收到内容 |
| `cancelled` | `{}` | 收到本机取消请求后，确认网页已停止 |

`proposal_pending` 只保存引用。应用 Agent 模式另创建文件任务，通过聊天任务可选的 UUID `fileTaskId` 关联；待审查列表返回这些关联任务以及当前 worker 中 source=connector 任务的提议，未关联的历史本机任务不自动纳入。首页服务面板和 IDE 都可本机审查；接受前继续检查版本和备份。网页真实工具步骤尚待观测接入，不从正文推测工具执行。仅提问的聊天提交不自动创建文件任务，但连接器可按当前请求调用 create_file 或 create_task；网页自带工具仍遵循网页设置。

桌面首页也复用上述聊天通道：本机用户标识的 SHA-256 前 24 位构成 `home-chat-*` 私有项目 ID，会话为 `home-web-*` UUID；固定 `mode: ask`、空 files、无 nativeRoot。首页消息/请求 ID 在提交前保存到本机 IndexedDB；确认丢失或刷新后使用同一请求核对，不新建重发。首页记录暂不参加 API 后端历史和云同步。IDE 与首页共享一个 helper 管理器和浏览器配置，另一个项目仍有未完成任务时须先恢复/停止该任务再切换服务。

状态路径：`queued -> waiting_web -> sending -> generating -> completed/error`。尚未 dispatch 的取消直接成为 `cancelled`；dispatch 后先成为 `cancel_requested`，只有网页确认停止才成为 `cancelled`。取消与自然结束竞争时，若网页已正常完成，记录 `completed`。

服务重启保留正文、工具、会话映射和领取凭据；已 dispatch 的活跃任务成为 `interrupted`，原取消请求继续保持 `cancel_requested`。适配器应根据已有页面状态报告 started/resumed、最终快照、完成、错误或取消确认，不再次发送。

## 续传、背压与保留

- SQLite 事务一次提交状态、事件和幂等收据，WAL + FULL synchronous；事务失败不发布事件。
- SSE 从 `after`/`Last-Event-ID` 之后读取。游标超前返回 409，非法游标返回 400。
- 每任务默认保留最近 256 个事件且窗口约 256 KiB；落后于窗口时返回 `event: reset`，数据为 `{type,taskId,seq,snapshot}`。客户端完整替换该消息快照并保存 seq，不拼接旧快照。
- 幂等收据保留至任务生命周期结束后仍可重试，不随事件窗口淘汰。每任务最多 10000 个适配器内容事件，达到上限仍允许报告终态。
- 正文快照最多 1 MiB；单事件 payload 最多 64 KiB；每消息最多 32 个工具、工具详情合计 256 KiB、32 个提议引用。更大的页面快照需报告明确错误，不静默截断。
- 总计最多 200 个聊天任务、32 个适配器。达到上限明确拒绝新任务，不自动删除用户历史；长期归档/清理 UI 后续接入。
- 每服务最多 16 个 SSE 订阅，每条连接只持有读取游标；write 背压时暂停读取日志，恢复 drain 后继续。写缓冲上限 2 MiB、持续阻塞 5 秒断开，事件保留供重连读取。空闲心跳为 15 秒，断开释放监听器与计时器。
- 终态事件送出后结束 SSE，完整服务退出会关闭所有订阅和数据库句柄。

## 验证与下一步

```powershell
npm.cmd test
npm.cmd run demo:chat
```

2026-09-24：32 项测试通过（原 11 项 + 聊天/背压 13 项 + 适配器 fixture 8 项）。新增 7 项核心验收曾在旧服务上全部因缺少接口失败，补齐实现后全部通过。测试覆盖实际 SDK/HTTP/SSE、中文分段、修订、首段早于结束、续传、凭据隔离、乱序/重复、并发领取、会话映射、取消、重启、工具、限额及慢客户端；背压测试使用真实 Node Writable 的 drain 行为。

独立 `demo:chat` 于 `2026-09-24T10:12:53.059Z` 收到首段，`10:12:53.695Z` 收到完成，提前 636 ms；内容明确为 fixture。测试临时目录与持久演示项目分离。

当前整套 MCP 43 项通过，含普通 Edge 扩展离线回归；桌面服务与首页 14 项、共享工作台 22 项通过。长回复按 8k 码点分段，超限修订报错并保留正文；取消前确认停止按钮及生成结束。发送恢复核对会话和最后用户消息，手动导航后不向错误会话发送。下一步由用户加载普通 Edge 扩展并配对，再手动验收真实页面与实际应用首段 / 完成 / 续聊 / 停止。助手按用户要求停止电脑和浏览器控制；历史工具认证错误、旧独立 Edge 和旧隧道审批不作为当前待执行步骤。详情见根目录 HANDOFF。
