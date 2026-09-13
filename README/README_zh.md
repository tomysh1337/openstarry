# OpenStarry NextGen 源码说明

日常用户请直接使用 GitHub Release 中的安装版或便携版。软件会在首次启动时自行准备所需组件，聊天、任务、知识库、附件和设置都保存在本机。

## 本地开发

```powershell
cd CLIENT\openstarry-app
npm.cmd ci
npm.cmd start
```

## Windows 构建

```powershell
cd CLIENT\openstarry-app
npm.cmd run build:release
```

构建产物位于 `CLIENT\openstarry-app\dist`。Python 项目由随软件分发的 `uv.exe` 按锁文件准备独立运行环境。

默认数据目录为 `%LOCALAPPDATA%\OpenStarry NextGen`，请勿把运行数据、日志、虚拟环境或发布产物提交到 Git。
