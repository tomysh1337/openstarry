# OpenStarry NextGen

OpenStarry NextGen 是一款面向 Windows 10、Windows 11 和 Android 的本地 AI 软件。桌面端把聊天、任务、知识库、文件与电脑控制整合在同一个窗口；Android 端用于随时查看已同步的会话和消息。

## 下载与使用

请从 [GitHub Releases](https://github.com/tomysh1337/openstarry/releases) 下载最新版本：

- `OpenStarry-NextGen-1.1.2-Setup.exe`：Windows 安装版，可选择安装目录。
- `OpenStarry-NextGen-1.1.2-Portable.exe`：Windows 便携版。
- `OpenStarry-Mobile-1.1.2.apk`：Android 6.0 及以上版本。

也可以直接打开 [OpenStarry 移动网页版](https://openstarry.154-219-110-177.sslip.io)。移动端输入同步用户 ID 和访问令牌后，会把会话与消息保存在设备的离线缓存中。

首次启动 Windows 客户端会准备 AI 运行环境，所需时间取决于网络与电脑性能；后续启动会直接复用已安装环境。窗口关闭后默认缩小到系统托盘，可在设置中改为直接退出。

## 主要功能

- 多模型 Provider，兼容 OpenAI、Ollama、DeepSeek、MoonShot 等接口。
- 对话、任务流、知识库、技能与定时任务。
- 自动续写与长任务执行。
- 用户明确提出电脑控制时自动允许操作，也可在设置中选择每次询问或关闭。
- 聊天记录、附件和设置保存在本机，附件按 SHA-256 去重。
- Windows 与 Android 聊天历史同步，支持首次全量、游标增量、离线续传和附件校验。
- 每日压缩备份，默认保留 30 份；支持手动导出和恢复 ZIP。
- 回收站内容保存超过 45 天时仅提醒用户。
- 阿里云、腾讯云和 Windows NTP 校时。
- API 密钥使用 Windows 凭据加密，可选 Windows Hello 或主密码。
- 自动检查 GitHub Release 更新。

## 开启聊天同步

在 Windows 客户端打开“设置 → 跨设备聊天同步”，填写：

- 服务器：`https://openstarry.154-219-110-177.sslip.io`
- 用户 ID：服务器为你分配的 ID
- 访问令牌：服务器为你分配的令牌

保存后客户端会先上传本地历史，之后默认每 5 分钟增量同步。断网时变更进入 gzip 压缩队列，网络恢复后自动重试。多设备冲突按 NTP 校准后的修改时间与设备 ID 决定；附件按 SHA-256 去重并在下载后校验。

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
npm.cmd start
```

构建 Windows 安装版和便携版：

```powershell
cd CLIENT\openstarry-app
npm.cmd run build:release
```

Android 构建与调试说明见 [移动端说明](MOBILE/openstarry-mobile/README.md)。交付清单及验收结果见 [TODO.md](TODO.md)。

## License

[GPL-3.0](LICENSE)
