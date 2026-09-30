# 本机 OpenSandbox

使用官方 [OpenSandbox](https://github.com/alibaba/OpenSandbox) 1.1.0 server 与 JavaScript SDK。2026-09-26 已安装 Python/server 并验证配置；本机还缺 Docker/WSL 初始化，真实容器尚未启动。

1. 右键本目录 `install-opensandbox.cmd`，选择“以管理员身份运行”。它启用 WSL/VirtualMachinePlatform，通过 winget 安装官方 WSL 和 Docker Desktop。若提示需要重启，自行重启后再次运行；脚本不会自动重启。
2. 打开 Docker Desktop 完成首次设置，使用 Linux containers，等待 engine ready。安装器检查 Windows/虚拟化条件，失败时保留提示继续排查。
3. 双击 `start-opensandbox.cmd`。它复用 Python 环境与密钥，检查 Docker 后隐藏启动 server。日志、数据库、PID、密钥在 `%LOCALAPPDATA%/OpenStarry/OpenSandbox`，请勿分享整个目录或配置。
4. 重开最新 OpenStarry，在首页服务面板或 IDE 任务详情中的 OpenSandbox 点“检查连接”。这确认服务器响应；随后从当前 ChatGPT MCP 执行 `printf 'OpenSandbox ready\n'` 并读取 sandbox_result，确认真实命令结束及容器清理。

server 只监听 `127.0.0.1:49330`，要求私有 API key。ChatGPT 经应用现有 MCP 间接调用，不需要另建公网 OpenSandbox 地址。每次命令使用新容器，无宿主目录/套接字挂载；容器不是 Windows 主机命令行，文件随容器删除。

| 输入区等级 | 文件写入 | 容器命令 |
| --- | --- | --- |
| 请示批准 | 全部审查 | 全部需本机批准 |
| 帮我批准 | 新文件直存，覆盖审查 | 禁网自动执行；联网需批准 |
| 完全访问权限 | 带版本检查直接保存，保留备份 | 按请求允许联网 |

等级是应用 MCP 的共用设置，子 Agent 同样适用。显式 propose_file 和已有待审查请求继续等待本机处理。公网工具只有执行/读取/取消，审批和等级变更留在本机 UI。

容器需要镜像下载与 Docker egress sidecar，默认 deny 策略创建失败时报告错误，不自动放宽。首次拉镜像可能耗时。命令上限 300 秒，容器 TTL 上限 420 秒，服务配置上限 600 秒；异常退出后不重放命令，残留容器由服务 TTL 清理并需核对。
