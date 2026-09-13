# OpenStarry NextGen source guide

End users should install a GitHub Release build. On first launch, the application prepares its required components and keeps conversations, tasks, knowledge, attachments, and settings on the local computer.

## Local development

```powershell
cd CLIENT\openstarry-app
npm.cmd ci
npm.cmd start
```

## Windows build

```powershell
cd CLIENT\openstarry-app
npm.cmd run build:release
```

Artifacts are written to `CLIENT\openstarry-app\dist`. The bundled `uv.exe` creates isolated Python environments from the committed lock files.

The default data directory is `%LOCALAPPDATA%\OpenStarry NextGen`. Keep runtime data, logs, virtual environments, and release artifacts out of Git.
