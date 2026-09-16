# OpenStarry 同步协议 v1

同步协议用于在桌面端、Android 和移动网页之间传递会话、消息、附件元数据、供应商、通用偏好与删除状态。服务地址必须使用 HTTPS，本机调试时允许 `http://127.0.0.1`。

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

支持五种 kind（供应商与偏好从客户端 1.2.0 开始使用）：

- `conversation`：会话标题、置顶状态、工作区、最后活动时间和消息游标。
- `message`：会话 ID、稳定的 `sync_id`、角色、正文、思考内容、创建时间和消息游标。
- `file`：文件 ID、文件名、大小、MIME 类型和 SHA-256。
- `provider`：供应商 ID、名称、接口地址、协议类型、模型 ID 列表与描述，不包含 API 密钥。
- `preference`：白名单内的主题、温度、模型、供应商选择、角色提示词和思考偏好；不包含凭据或电脑权限。

聊天 `msg_timestamp` 与 `modifiedAt` 均使用 Unix 毫秒。客户端同步偏好前会过滤未知字段；供应商、通用偏好可以通过墓碑删除。

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

桌面端将同步游标和记录摘要保存在 `sync-state.json`，未发送操作保存在最高压缩级别的 `sync-queue.json.gz`。同步失败只更新状态并安排指数重试，不清除本地聊天。Android 与 PWA 使用 IndexedDB 保存记录，断开同步保留本机记录，切换账号隔离缓存。
