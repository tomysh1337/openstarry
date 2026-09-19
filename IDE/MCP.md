# MoonCode MCP 配置与部署

OpenStarry 支持 Streamable HTTP MCP。设置 → Agent 调用与 IDE：开启工具总开关及 MCP，填写服务地址，点击测试连接，再保存。

本次采用 [mooncode-mcp-source](https://github.com/tomysh1337/mooncode-mcp-source) 的 HTTP bridge。专属 URL 含 capability token，单独提供在仓库外的配置文件中；MCP 令牌栏留空。不要将完整地址提交到仓库或公开截图。

```json
{
  "mcpServers": {
    "mooncode": {
      "type": "http",
      "url": "https://mcp.example.com/mcp/CAPABILITY_TOKEN"
    }
  }
}
```

## 服务结构

- Caddy 终止 HTTPS，转发给 Docker 内的 48271 端口。
- 容器由非 root 的 node 用户运行，根文件系统只读，独立 `/tmp`，移除 Linux capabilities，限制 384 MB 内存、1 CPU 和 128 个进程。
- `/workspace` 映射到独立持久目录 `/opt/mooncode-workspace`；没有宿主根目录或 Docker socket 挂载。
- capability URL 限定该容器内的文件及命令权限。日志仅保留事件类型，避免打印秘密地址。
- 浏览器 Origin 仅允许配置的移动网页域名和 Android `https://localhost`。桌面通过 Electron HTTP 桥接连接。

服务端源码位于独立克隆仓库，部署入口是 `deploy.mjs`，环境变量 `MOONCODE_MCP_SECRET` 至少 32 个字符，保存在服务器受限权限的环境文件。构建时使用 Node 24、pnpm 11，并允许 `node-pty` 的依赖构建脚本。

## 管理与排查

```sh
docker ps --filter name=mooncode-mcp
docker logs --tail 30 mooncode-mcp
docker restart mooncode-mcp
systemctl status openstarry-ide
```

MCP 测试连接成功表示初始化与工具发现通过。实际文件读写、目录列表和 PTY 命令已验证；LSP / diagnostics 等依赖 IDE adapter 的工具需要另外接入相应插件。

IDE 编辑器项目与 MCP 服务器工作区是不同目录。IDE `propose_file` 修改经过本机红绿审查；MCP 文件工具按服务器自身机制直接操作其工作区。执行 Python、Node、Java 项目的独立服务说明见 [运行器](runtime/README.md)。
