# 项目执行服务器

安装 Docker 与 Python 3.10+，预拉取 `python:3.12-alpine`、`node:22-alpine` 和 `eclipse-temurin:21-jdk`。生成独立令牌，设置环境变量后运行：

```sh
export OPENSTARRY_IDE_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export OPENSTARRY_IDE_HOST=127.0.0.1
export OPENSTARRY_IDE_PORT=5096
export OPENSTARRY_IDE_ORIGINS=https://YOUR_WEB_APP,https://localhost,http://localhost,capacitor://localhost
python3 server.py
```

在 HTTPS 反向代理下发布该服务。软件设置中输入公开服务根地址与令牌，例如 `https://ide.example.com`。`GET /health` 返回服务状态；`POST /v1/jobs` 提交 `{files, command, image}`，返回任务 ID；`GET /v1/jobs/{id}` 读取输出与退出码；`DELETE /v1/jobs/{id}` 停止任务。作业接口要求 `Authorization: Bearer TOKEN`。

这是个人服务器的执行器：令牌代表提交代码执行权限，应只保存在使用者的设备。容器不访问网络；工作区在每次运行后移除，输出最长保留 10 分钟，日志不记录令牌和源码。
