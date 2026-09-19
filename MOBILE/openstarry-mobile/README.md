# OpenStarry Android 与移动网页

移动端是独立聊天客户端：新建会话、选择模型、发送消息、查看回复，以及管理供应商和通用偏好。记录写入 IndexedDB 后再同步到电脑；断网时仍可查看本地历史。Android 通过原生 HTTP 调用模型，网页支持流式回复且需要供应商允许跨域请求。

手机提供 IDE 项目工具、MCP 与独立执行服务器连接，不包含桌面电脑控制和任意桌面文件访问。聊天记录与通用配置双向同步，API 密钥仅保存在当前设备。

## 1.3.0 界面

与电脑端统一青绿色、浅灰背景、供应商卡片和圆角聊天栏，首次使用默认浅色；已有外观偏好继续生效。手机底部提供聊天、IDE、供应商、设置四个入口，平板宽屏可同时显示聊天历史。

聊天栏的设置按钮直接编辑当前供应商、接口和模型列表。供应商页显示接口、模型数量与当前选择；设置按界面、通用聊天偏好、跨设备同步分组。切换页面保留聊天草稿，编辑弹窗固定显示保存按钮，视口随软键盘调整，动效尊重系统的减少动态效果偏好。

本轮验证范围和 Android 安装包说明见 [QA_GUI.md](QA_GUI.md)。

IDE 采用 IDEA 风格工具窗口；Agent 支持上下文文件、模型选择、工具进度、问题卡和红绿代码审查。手机本地运行 JavaScript / 网页预览，Python、Node、Java 可连接服务器。[使用说明](../../IDE/README.md)。IDE 项目与专属对话本机保留；普通聊天和通用偏好同步到电脑。

## 网页开发

需要 Node.js 22：

```powershell
cd ../../SHARED/workbench
npm.cmd ci
cd ../../MOBILE/openstarry-mobile
npm.cmd ci
npm.cmd run dev
```

生产网页构建：

```powershell
npm.cmd run build
```

## Android 构建

需要 JDK 21、Android SDK 35 和 Build Tools 35。最低系统版本为 Android 6.0（API 23）。

```powershell
npm.cmd ci
npm.cmd run android:sync
cd android
.\gradlew.bat assembleDebug
```

调试 APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。

正式签名使用环境变量传入密钥信息，仓库不保存 keystore 和密码：

```powershell
$env:OPENSTARRY_ANDROID_KEYSTORE='C:\path\OpenStarry-Android-Release.jks'
$env:OPENSTARRY_ANDROID_STORE_PASSWORD='STORE_PASSWORD'
$env:OPENSTARRY_ANDROID_KEY_ALIAS='openstarry'
$env:OPENSTARRY_ANDROID_KEY_PASSWORD='KEY_PASSWORD'
.\gradlew.bat assembleRelease
```

正式 APK 位于 `android/app/build/outputs/apk/release/app-release.apk`。发布前使用 Android SDK 的 `apksigner verify --verbose --print-certs` 检查 v1/v2 签名。

## 使用

1. 打开底部“供应商” → 添加供应商，填写接口地址、设备自己的 API 密钥和模型 ID；也可从聊天栏的设置按钮直接进入。
2. 在供应商卡片中点“开始聊天”，或切换到底部“聊天”，选择模型并发送消息。
3. 要与电脑互通，在“设置” → “手机与电脑同步”中填写相同的服务器、用户 ID 和令牌，保存并同步。

首次连接会合并本地与云端历史；随后增量同步，网络恢复、回到前台和每分钟会尝试同步。生成回答时延后同步，避免正在输出的内容被刷新覆盖。断开同步保留本机聊天和密钥，切换账号使用独立本地数据库。

1.1.x 使用调试签名。升级旧安装请使用 `Compat.apk`，正式签名 APK 供新安装和已有正式签名用户；签名不同的包不可覆盖安装。

## 验证

`npm test` 运行聊天、离线队列、账号隔离和跨端 SQLite 集成测试。先用 MEMORY 的 Python 环境运行 `tests/fixture_server.py 8766`。`node tests/mobileUi.mjs` 在本地 Vite 服务与 Edge 上验证手机尺寸聊天界面。Android APK 的签名和清单经过构建检查，真机输入法与后台恢复仍需设备验收。
