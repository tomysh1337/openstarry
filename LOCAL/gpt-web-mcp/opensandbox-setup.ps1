param([switch]$PrepareOnly, [switch]$InstallDocker)
$ErrorActionPreference = 'Stop'
$sandboxRoot = Join-Path $env:LOCALAPPDATA 'OpenStarry/OpenSandbox'
New-Item -ItemType Directory -Path $sandboxRoot -Force | Out-Null

if ($InstallDocker) {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run install-opensandbox.cmd as administrator to enable WSL and install Docker. No restart is automatic.' }
  $needsRestart = $false
  foreach ($feature in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
    $state = Get-WindowsOptionalFeature -Online -FeatureName $feature
    if ($state.State -ne 'Enabled') {
      $result = Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart
      $needsRestart = $needsRestart -or $result.RestartNeeded
    }
  }
  if ($needsRestart) { Write-Host 'Windows features enabled. Restart Windows when ready, then run this installer again.'; exit 3010 }
  & winget install --id Microsoft.WSL --exact --silent --disable-interactivity --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -notin @(0, -1978335189)) { throw 'WSL installation did not finish. Check the installer output and retry after Windows initialization.' }
  & winget install --id Docker.DockerDesktop --exact --silent --disable-interactivity --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -notin @(0, -1978335189)) { throw 'Docker installation did not finish. Check Docker Desktop system requirements for this Windows version.' }
  Write-Host 'Open Docker Desktop, finish its first-run setup using Linux containers, then run start-opensandbox.cmd.'
  exit 0
}

$uvCommand = Get-Command uv -ErrorAction SilentlyContinue
$uvPath = if ($uvCommand) { $uvCommand.Source } else { Join-Path $env:USERPROFILE '.local/bin/uv.exe' }
if (-not (Test-Path -LiteralPath $uvPath)) { throw 'uv is required for the local Python runtime.' }
$python = Join-Path $sandboxRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  & $uvPath venv --python 3.12 (Join-Path $sandboxRoot '.venv')
  if ($LASTEXITCODE -ne 0) { throw 'Python runtime preparation failed.' }
}
& $uvPath pip install --python $python 'opensandbox-server==1.1.0' pywin32
if ($LASTEXITCODE -ne 0) { throw 'OpenSandbox server installation failed.' }
$connectionPath = Join-Path $sandboxRoot 'connection.json'
if (-not (Test-Path -LiteralPath $connectionPath)) {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $key = [Convert]::ToBase64String($bytes)
  $connection = @{ domain = '127.0.0.1:49330'; apiKey = $key; image = 'python:3.12-slim' }
  [IO.File]::WriteAllText($connectionPath, ($connection | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
}
$connection = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
if ($connection.domain -ne '127.0.0.1:49330') { throw 'Unexpected local connection address; inspect the private configuration.' }
$dbPath = (Join-Path $sandboxRoot 'server.db').Replace('\', '/')
$emptyMountRoot = (Join-Path $sandboxRoot 'no-host-mounts').Replace('\', '/')
$config = @"
[server]
host = "127.0.0.1"
port = 49330
api_key = "$($connection.apiKey)"
max_sandbox_timeout_seconds = 600
[proxy]
resolve_internal = false
[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.1.0"
[docker]
network_mode = "bridge"
publish_host = "127.0.0.1"
no_new_privileges = true
pids_limit = 256
drop_capabilities = ["AUDIT_WRITE", "MKNOD", "NET_ADMIN", "NET_RAW", "SYS_ADMIN", "SYS_MODULE", "SYS_PTRACE", "SYS_TIME", "SYS_TTY_CONFIG"]
[egress]
image = "opensandbox/egress:v1.1.7"
[store]
type = "sqlite"
path = "$dbPath"
[storage]
allowed_host_paths = ["$emptyMountRoot"]
"@
$configPath = Join-Path $sandboxRoot 'server.toml'
[IO.File]::WriteAllText($configPath, $config, (New-Object Text.UTF8Encoding($false)))
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $sandboxRoot /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Private directory permissions could not be applied.' }
if ($PrepareOnly) { Write-Host 'OpenSandbox 1.1.0 Python runtime and private local configuration prepared. Docker execution is not yet verified.'; exit 0 }

$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$dockerPath = if ($dockerCommand) { $dockerCommand.Source } else { Join-Path $env:ProgramFiles 'Docker/Docker/resources/bin/docker.exe' }
if (-not (Test-Path -LiteralPath $dockerPath)) { throw 'Docker is missing. Run install-opensandbox.cmd as administrator, then start Docker Desktop.' }
$engine = & $dockerPath info --format '{{.OSType}}'
if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop and wait for its Linux engine, then retry.' }
if (($engine -join '').Trim() -ne 'linux') { throw 'Switch Docker Desktop to Linux containers, then retry.' }
try {
  $reply = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:49330/sandboxes' -Headers @{ 'OPEN-SANDBOX-API-KEY' = $connection.apiKey } -TimeoutSec 3
  if ($reply.StatusCode -eq 200) { Write-Host 'OpenSandbox server is already running.'; exit 0 }
} catch { }
$entry = Join-Path $sandboxRoot '.venv/Scripts/opensandbox-server.exe'
$process = Start-Process -FilePath $entry -ArgumentList @('--config', ('"' + $configPath + '"')) -WorkingDirectory $sandboxRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $sandboxRoot 'server.stdout.log') -RedirectStandardError (Join-Path $sandboxRoot 'server.stderr.log')
$process.Id | Set-Content -LiteralPath (Join-Path $sandboxRoot 'server.pid')
Write-Host 'OpenSandbox server launch requested. Use the OpenStarry service panel to check the connection; successful container execution is a separate check.'
