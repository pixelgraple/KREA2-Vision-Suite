param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'OpenWebUI\VastBridge')
)

$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$vastApiKey = (Get-Clipboard -Raw).Trim()
if ($vastApiKey.Length -lt 24) {
    throw 'The clipboard does not contain the newly created Vast API key.'
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'bridge.py') -Destination $InstallRoot -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'requirements.txt') -Destination $InstallRoot -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'start-bridge.ps1') -Destination $InstallRoot -Force

$python = Join-Path $InstallRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    & py -3.12 -m venv (Join-Path $InstallRoot '.venv')
}
& $python -m pip install --disable-pip-version-check -r (Join-Path $InstallRoot 'requirements.txt')
& $python -m pip check

$randomBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($randomBytes)
$bridgeApiKey = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$configPath = Join-Path $InstallRoot 'config.json'
[ordered]@{
    vast_api_key = $vastApiKey
    endpoint = 'local-openwebui-coding'
    model = 'heretic-3.8-q4-cloud'
    bridge_api_key = $bridgeApiKey
    request_timeout = 240
    max_tokens_limit = 16384
    default_max_tokens = 8192
    auto_continue_max_segments = 3
    model_context_tokens = 32768
} | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM

# Keep the long-lived Vast credential readable only by the current Windows user.
& icacls.exe $configPath /inheritance:r /grant:r "${env:USERNAME}:(R,W)" | Out-Null

$taskName = 'OpenWebUI Vast Bridge'
$startScript = Join-Path $InstallRoot 'start-bridge.ps1'
$taskCommand = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
$taskCreated = $false
try {
    & schtasks.exe /Create /TN $taskName /SC ONLOGON /TR $taskCommand /F 2>$null | Out-Null
    $taskCreated = ($LASTEXITCODE -eq 0)
} catch {
    $taskCreated = $false
}
if (-not $taskCreated) {
    $startupDir = [Environment]::GetFolderPath('Startup')
    $shortcutPath = Join-Path $startupDir 'OpenWebUI Vast Bridge.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = 'powershell.exe'
    $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
    $shortcut.WorkingDirectory = $InstallRoot
    $shortcut.WindowStyle = 7
    $shortcut.Save()
}

$existing = Get-NetTCPConnection -State Listen -LocalPort 11436 -ErrorAction SilentlyContinue
if (-not $existing) {
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $startScript
    )
}

$healthy = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:11436/health' -TimeoutSec 2
        if ($health.ok -eq $true -and $health.model -eq 'heretic-3.8-q4-cloud') {
            $healthy = $true
            break
        }
    } catch {
        Start-Sleep -Milliseconds 500
    }
}
if (-not $healthy) {
    throw 'The local Vast bridge did not become healthy on port 11436.'
}

# Leave only the loopback bridge token on the clipboard for Open WebUI setup.
Set-Clipboard -Value $bridgeApiKey
Write-Host 'Local Vast bridge installed and healthy on http://127.0.0.1:11436'
Write-Host 'Per-user automatic startup is configured and the loopback API key is on the clipboard.'
