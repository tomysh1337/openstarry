# OpenStarry IDE 工作区

电脑左侧导航、手机底部导航选择 **IDE**。整体采用 IDEA 风格工具窗口，右上角可单独切换 IDE 深浅外观；宽屏可拖动项目栏与 Agent 栏的分隔线调整宽度。两端共用项目树、多标签编辑器、搜索、红绿代码审查、运行输出和项目 Agent。手机通过「项目 / 代码 / 审查 / 输出 / Agent」切换面板；大屏同时显示项目树、编辑器和 Agent。

## 项目与编辑

- 新建项目，或导入文本项目 ZIP。电脑也可直接打开本地目录。
- 文件树的「＋」创建文件，可填写 `src/main.py` 等相对路径。支持重命名、删除、多标签编辑、Ctrl+S 保存，编辑器内 Ctrl+F 搜索和替换。
- 提供 JavaScript、TypeScript、Python、HTML、CSS、JSON、Java 和 Markdown 高亮、行号、括号匹配、折叠及编辑器撤销重做。
- 未保存内容保留为本地草稿。关闭标签不会丢弃草稿；项目通过 IndexedDB 留在当前设备。ZIP 导出包含草稿，不包含待审查 Agent 提案。
- 目录项目保存时检查磁盘原内容，外部编辑产生冲突时先提示核对。删除目录中的文件进入系统回收站。
- ZIP 和本地工作区当前支持最多 1000 个 UTF-8 文本文件，单文件 1 MB、总计 12 MB。二进制文件不进入文本编辑器。打开目录跳过 `.git`、依赖、构建目录和 `.env` 文件。

## 红绿审查

「审查」显示红色删除行、绿色新增行和增减行数。Agent 的 `propose_file` 只产生提案，接受后才写入项目；「撤销提案」保留原文件。生成提案后手动改过文件，接受操作会检测冲突。

此审查针对 IDE 本地项目工具。外部 MCP 的文件工具操作它自己的服务端工作区，遵循该 MCP 服务的权限机制。

## Agent 调用设置

在 **设置 → Agent 调用与 IDE** 保存开关：项目文件、执行命令、网页浏览与搜索、项目知识检索、技能说明、MCP、自动续写、回合 / 时长 / 连续错误上限。

手机普通聊天和两端的 IDE Agent 使用这些开关。桌面原有智能体页面继续使用其已有的电脑控制、知识库和任务设置。项目知识检索搜索当前项目文本；技能说明读取项目中的 `AGENTS.md`、`SKILL.md` 和 `.openstarry/skills.md`。

选择供应商和模型后，在 IDE 的 Agent 面板描述任务。输入框下方可切换同一供应商模型（手机也可切换已配置供应商模型）、Agent / 仅提问模式；回形针引用当前文件的内容，最多 6 个文件、每个 12000 字符。工具调用以可展开记录显示，回复支持 Markdown。右上角新建对话会将原对话归入本机历史，可随时恢复。需要澄清时输入栏上方出现问题卡，选项可直接提交，补充说明选填；Windows 同时显示系统通知。取消问题会暂停当前任务，不再自动继续调用模型。

密钥、执行权限、MCP 和执行服务器连接仅在本设备保存，不加入通用偏好同步。原有普通聊天 / 通用设置同步继续工作；IDE 项目文件和 IDE 面板对话目前保存在本机，可通过 ZIP 交换项目。

## 运行和预览

| 环境 | 运行方式 |
| --- | --- |
| 手机 / 本地虚拟项目 JavaScript | 输出页填写 `main.js`，点击运行。执行环境与应用存储隔离，支持 console 和异步代码，10 秒上限。Node 模块需服务器运行。 |
| HTML 页面 | 打开 HTML，点击网页预览。同项目直接引用的 JS、CSS 会内联；外部网络资源和应用存储隔离。 |
| 桌面目录项目 | 填写 `python main.py`、`npm test` 等命令。在已选目录运行，输出留在软件内，支持停止。需要本机已安装对应语言环境。 |
| 手机 Python / Java / Node 项目 | 设置执行服务器、令牌与环境，再填写命令。已保存项目文件按次上传至临时容器，结束后清理。 |

服务器运行器位于 `runtime/server.py`。每项任务限制为 60 秒、512 MB 内存、1 CPU、128 个进程，不挂载宿主目录或 Docker socket，最多同时两项。当前预置 Python 3.12、Node 22、Java 21；不含依赖联网安装、调试器、语言服务器或 Git 分支管理。

## 开发与验证

首次先在 `SHARED/workbench` 执行 `npm ci`，再在桌面或手机包目录执行 `npm ci`。共享代码使用本地 npm 包链接，两端构建器会将其打包。

```powershell
cd SHARED/workbench
npm test
cd ../../CLIENT/openstarry-app
node --test tests/ideWorkspace.test.mjs
npm run build
cd ../../MOBILE/openstarry-mobile
npm run build
node tests/ideUi.mjs
```

`ideUi.mjs` 默认连接 `http://127.0.0.1:5178`，通过 `OPENSTARRY_MOBILE_URL` 指定地址。Android 的分享导出使用 Capacitor Filesystem / Share，原生键盘和系统分享面板需 Android 实机验证。
