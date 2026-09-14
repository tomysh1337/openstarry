# OpenStarry 同步协议 v1

同步协议用于在桌面端、Android 和移动网页之间传递会话、消息、附件元数据与删除状态。服务地址必须使用 HTTPS，本机调试时允许 `http://127.0.0.1`。

## 认证

每个请求使用以下请求头：

```http
Authorization: Bearer TOKEN
X-OpenStarry-User: USER_ID
X-OpenStarry-Device: DEVICE_ID
```

`USER_ID` 只允许字母、数字、点、下划线和连字符，最长 64 个字符。服务端使用恒定时间比较访问令牌。

## 同步请求

`POST /v1/sync` 请求体：

```json
{
  "protocolVersion": 1,
  "userId": "USER_ID",
  "deviceId": "DEVICE_ID",
  "cursor": 0,
  "limit": 500,
  "operations": []
}
```

每个 operation 包含 `opId`、`modifiedAt`、`deviceId` 和 record。record 的公共字段为：

```json
{
  "id": "conversation:RECORD_ID",
  "kind": "conversation",
  "deleted": false,
  "payload": {}
}
```

支持三种 kind：

- `conversation`：会话标题、置顶状态、工作区、最后活动时间和消息游标。
- `message`：会话 ID、稳定的 `sync_id`、角色、正文、思考内容、创建时间和消息游标。
- `file`：文件 ID、文件名、大小、MIME 类型和 SHA-256。

硬删除会转换为 `deleted: true` 的墓碑记录，使其他设备能够同步删除状态。

响应返回服务器游标、是否还有下一页、已确认的操作 ID 以及从当前游标之后读取的记录：

```json
{
  "protocolVersion": 1,
  "cursor": 12,
  "serverCursor": 12,
  "serverTime": 1789400000000,
  "hasMore": false,
  "acknowledgedIds": [],
  "records": []
}
```

客户端只在服务器确认后删除离线队列中的操作。每页最多 1000 条，桌面端默认使用 500 条。

## 冲突规则

服务器对同一用户和 record ID 只保留获胜版本。版本顺序为 `(modifiedAt, deviceId)`：修改时间更大的版本获胜；时间相同时按设备 ID 字典序稳定决胜。服务器会把客户端时间限制在服务器当前时间之后 5 分钟以内，桌面端使用 NTP 校准后的时间。

## 附件

附件内容与元数据分开传输：

- `HEAD /v1/sync/attachments/{sha256}`：检查内容是否已经存在。
- `PUT /v1/sync/attachments/{sha256}`：上传附件，服务器重新计算 SHA-256。
- `GET /v1/sync/attachments/{sha256}`：下载附件，客户端再次校验 SHA-256。

相同用户下相同摘要的附件只保存一份，单个附件默认上限为 512 MiB。

## 本地保留

桌面端将同步游标和记录摘要保存在 `sync-state.json`，未发送操作保存在最高压缩级别的 `sync-queue.json.gz`。同步失败只更新状态并安排指数重试，不清除本地聊天。Android 与 PWA 使用 IndexedDB 保存记录，并在退出时提供本地清理。
