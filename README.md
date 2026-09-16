# OpenStarry NextGen

OpenStarry NextGen 是一款面向 Windows 10、Windows 11 和 Android 的本地 AI 软件。桌面端把聊天、任务、知识库、文件与电脑控制整合在同一个窗口；Android 端可独立新建聊天、选择模型、发送消息，并与电脑互通历史和通用配置。

## 下载与使用

请从 [GitHub Releases](https://github.com/tomysh1337/openstarry/releases) 下载最新版本：

- `OpenStarry-NextGen-1.2.0-Setup.exe`：Windows 安装版，可选择安装目录。
- `OpenStarry-NextGen-1.2.0-Portable.exe`：Windows 便携版。
- `OpenStarry-Mobile-1.2.0.apk`：正式签名 Android 安装包，支持 Android 6.0 及以上。
- `OpenStarry-Mobile-1.2.0-Compat.apk`：使用旧版调试签名，供已安装 1.1.x 的用户保留应用数据直接升级。两个签名系列分别升级，请按已安装版本选择。

也可以直接打开 [OpenStarry 移动网页版](https://openstarry.154-219-110-177.sslip.io)。手机可先添加供应商、在本机填写 API 密钥后聊天；连接同步服务后，会话与配置会与电脑互通。记录保存在设备本地，断开同步仍然保留。

首次启动 Windows 客户端会准备 AI 运行环境，所需时间取决于网络与电脑性能；后续启动会直接复用已安装环境。窗口关闭后默认缩小到系统托盘，可在设置中改为直接退出。

## 主要功能

- 多模型 Provider，兼容 OpenAI、Ollama、DeepSeek、MoonShot 等接口。
- 对话、任务流、知识库、技能与定时任务。
- 自动续写与长任务执行。
- 用户明确提出电脑控制时自动允许操作，也可在设置中选择每次询问或关闭。
- 聊天记录、附件和设置保存在本机，附件按 SHA-256 去重。
- Windows 与 Android 双向同步聊天、供应商、模型、主题、温度和角色提示词；API 密钥只保存在各设备。
- 供应商与模型可从聊天栏直接新增、编辑和获取模型列表，也可手动填写模型 ID。
- Agent 提问卡自动出现在输入框上方，宽版选项和选填补充分开呈现，回答后继续原任务，并触发 Windows 通知。
- 连贯的导航选中反馈、弹窗进出与逐题过渡，尊重系统减少动态效果设置。
- 桌面端支持首次全量、游标增量、离线续传和附件校验；移动端支持离线保留文字聊天。
- 每日压缩备份，默认保留 30 份；支持手动导出和恢复 ZIP。
- 回收站内容保存超过 45 天时仅提醒用户。
- 阿里云、腾讯云和 Windows NTP 校时。
- API 密钥使用 Windows 凭据加密，可选 Windows Hello 或主密码。
- 自动检查 GitHub Release 更新。

## 开启聊天同步

在 Windows 客户端打开“设置 → 手机与跨设备同步”，填写：

- 服务器：`https://openstarry.154-219-110-177.sslip.io`
- 用户 ID：服务器为你分配的 ID
- 访问令牌：服务器为你分配的令牌

保存后客户端会先上传本地历史，之后默认每 5 分钟增量同步。断网时变更进入 gzip 压缩队列，网络恢复后自动重试。多设备冲突按 NTP 校准后的修改时间与设备 ID 决定；附件按 SHA-256 去重并在下载后校验。

两端在同一服务器使用相同用户 ID 和令牌；同步供应商信息后，在手机上单独补填 API 密钥即可继续聊天。网页调用模型接口受供应商 CORS 设置影响，Android APK 使用原生 HTTP 请求。桌面专属电脑控制权限不会同步到手机。

传输使用 HTTPS，桌面端令牌由 Windows 凭据保护。协议、数据结构和冲突规则见 [SYNC_PROTOCOL.md](SYNC_PROTOCOL.md)，自建服务器见 [同步服务说明](SYNC/sync_server/README.md)。

## 本地数据

Windows 数据默认保存在：

```text
%LOCALAPPDATA%\OpenStarry NextGen
```

卸载时可自行勾选是否保留聊天记录、附件、设置、密码库和任务历史。安装包不包含开发测试数据。

## 从源码运行

Windows 桌面端需要 Node.js 22 和项目内置的 `uv.exe`：

```powershell
cd CLIENT\openstarry-app
npm.cmd ci
npm.cmd run dev
```

构建 Windows 安装版和便携版：

```powershell
cd CLIENT\openstarry-app
npm.cmd run build:release
```

Android 构建与调试说明见 [移动端说明](MOBILE/openstarry-mobile/README.md)。交付清单及验收结果见 [TODO.md](TODO.md)。

## License

[GPL-3.0](LICENSE)
