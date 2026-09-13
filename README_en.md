# OpenStarry NextGen

OpenStarry NextGen is a local AI desktop application for Windows 10 and Windows 11. Chat, tasks, knowledge, files, and computer control run as one application without separate terminals or database setup.

## Download

Get a build from [GitHub Releases](https://github.com/tomysh1337/openstarry/releases):

- `OpenStarry-NextGen-1.0.0-Setup.exe`: installer with a selectable destination, desktop shortcut, and an uninstall option to retain local data.
- `OpenStarry-NextGen-1.0.0-Portable.exe`: portable executable.

The first launch prepares the AI runtime and may take several minutes. Closing the main window minimizes the app to the system tray by default.

## Highlights

- Providers compatible with OpenAI, Ollama, DeepSeek, MoonShot, and similar APIs.
- Conversations, task flows, knowledge, skills, and scheduled tasks.
- Automatic continuation for long tasks.
- Automatic computer control when the user explicitly requests it, with ask-every-time and disabled modes in Settings.
- Local chat history, attachments, and settings with content-addressed attachment deduplication.
- Daily compressed backups, 30-backup retention, and manual ZIP export and restore.
- A reminder when items remain in trash for more than 45 days.
- Time verification through Alibaba Cloud, Tencent Cloud, and Windows NTP sources.
- Windows credential encryption for API keys, with optional Windows Hello or master password.
- Update checks through GitHub Releases.

## Local data

User data is stored in:

```text
%LOCALAPPDATA%\OpenStarry NextGen
```

The uninstaller lets the user retain or delete conversations, attachments, settings, vault data, and task history. Release packages contain no development test data.

## Build from source

Node.js 22 and the bundled `uv.exe` are required:

```powershell
cd CLIENT\openstarry-app
npm.cmd ci
npm.cmd start
```

Build the Windows installer and portable executable:

```powershell
cd CLIENT\openstarry-app
npm.cmd run build:release
```

Artifacts are written to `CLIENT\openstarry-app\dist`.

## Roadmap

Cross-device chat synchronization will be added after the self-hosted cloud endpoint is ready. See [TODO.md](TODO.md).

## License

[GPL-3.0](LICENSE)
