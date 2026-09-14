# OpenStarry Android 与移动网页

移动端用于登录同步服务、搜索会话和查看聊天历史。记录存入 IndexedDB，断网后仍可读取最近一次同步内容；手动点击“同步”即可增量刷新。

## 网页开发

需要 Node.js 22：

```powershell
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

应用默认填写 OpenStarry 公共同步地址和用户 ID。首次登录必须输入访问令牌；登录成功后会下载全部历史，后续只拉取游标之后的变更。退出操作会清除令牌、游标和本机 IndexedDB 缓存。
