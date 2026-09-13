# OpenStarry NextGen

OpenStarry NextGen 是一款面向 Windows 10 和 Windows 11 的本地 AI 桌面软件。聊天、任务、知识库、文件与电脑控制均集成在同一个应用中，打开软件即可使用，不需要单独打开终端或配置数据库。

## 下载

请从 [GitHub Releases](https://github.com/tomysh1337/openstarry/releases) 下载：

- `OpenStarry-NextGen-1.0.0-Setup.exe`：安装版，支持选择安装目录、桌面快捷方式和卸载时保留本地数据。
- `OpenStarry-NextGen-1.0.0-Portable.exe`：便携版，直接运行。

首次启动会准备 AI 运行环境，所需时间取决于网络与电脑性能。窗口关闭后默认缩小到系统托盘，可在设置中改为直接退出。

## 主要功能

- 多模型 Provider，兼容 OpenAI、Ollama、DeepSeek、MoonShot 等接口。
- 对话、任务流、知识库、技能与定时任务。
- 自动续写与长任务执行。
- 用户明确提出电脑控制时自动允许操作，也可在设置中选择每次询问或关闭。
- 聊天记录、附件和设置保存在本机，附件按内容去重。
- 每日压缩备份，默认保留 30 份；支持手动导出和恢复 ZIP。
- 回收站内容保存超过 45 天时仅提醒用户。
- 阿里云、腾讯云和 Windows NTP 校时。
- API 密钥使用 Windows 凭据加密，可选 Windows Hello 或主密码。
- 自动检查 GitHub Release 更新。

## 本地数据

所有用户数据保存在：

```text
%LOCALAPPDATA%\OpenStarry NextGen
```

卸载时可自行勾选是否保留聊天记录、附件、设置、密码库和任务历史。安装包不包含开发测试数据。

## 从源码运行

需要 Node.js 22 和项目内置的 `uv.exe`：

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

生成文件位于 `CLIENT\openstarry-app\dist`。

## 后续计划

跨设备聊天同步将在自建云端就绪后开发，具体事项见 [TODO.md](TODO.md)。

## License

[GPL-3.0](LICENSE)
