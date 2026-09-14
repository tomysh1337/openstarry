# OpenStarry 同步服务

该目录提供 FastAPI、SQLite、Caddy 和移动网页组成的单机部署。默认站点为 `https://openstarry.154-219-110-177.sslip.io`，Caddy 自动申请和续期证书。

## 配置

复制环境变量示例并生成随机令牌：

```bash
cp .env.example .env
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

将生成结果写入 `.env` 的用户令牌映射。`.env` 已被 Git 忽略。

```dotenv
OPENSTARRY_SYNC_TOKENS={"USER_ID":"LONG_RANDOM_TOKEN"}
```

## 启动

从仓库中的 `SYNC/sync_server` 目录运行：

```bash
mkdir -p downloads
docker compose up -d --build
docker compose ps
curl https://openstarry.154-219-110-177.sslip.io/health
```

移动网页由同一个 Compose 项目构建。放在 `downloads` 目录中的 APK 可通过 `/downloads/文件名.apk` 下载。

## 数据与备份

SQLite 数据库与附件保存在 Docker 卷 `sync-data`。备份时先暂停写入，再导出该卷；恢复时把数据库、WAL 相关文件和附件目录作为同一批数据恢复。

```bash
docker compose stop sync-server
docker run --rm -v sync_server_sync-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/openstarry-sync-backup.tar.gz -C /data .
docker compose start sync-server
```

## 接口验证

健康检查不需要令牌。同步与附件接口需要 Bearer Token 和用户请求头。

```bash
curl -X POST https://openstarry.154-219-110-177.sslip.io/v1/sync \
  -H 'Authorization: Bearer TOKEN' \
  -H 'X-OpenStarry-User: USER_ID' \
  -H 'Content-Type: application/json' \
  --data '{"protocolVersion":1,"userId":"USER_ID","deviceId":"test","cursor":0,"limit":10,"operations":[]}'
```

服务端不会把令牌返回给客户端或写入同步数据库。生产环境应定期轮换令牌，并限制服务器管理端口的来源地址。
