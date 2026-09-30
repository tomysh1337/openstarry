@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0opensandbox-setup.ps1" -InstallDocker
pause
