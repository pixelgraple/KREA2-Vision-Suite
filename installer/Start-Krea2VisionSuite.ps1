#requires -Version 5.1

[CmdletBinding()]
param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$suiteRoot = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'vision-studio') -PathType Container) {
    [IO.Path]::GetFullPath($PSScriptRoot)
}
else {
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}
$visionRoot = Join-Path $suiteRoot 'vision-studio'
$logsRoot = Join-Path $suiteRoot 'logs'
$statusPath = Join-Path $suiteRoot 'runtime-status.json'
[IO.Directory]::CreateDirectory($logsRoot) | Out-Null

function Test-Endpoint {
    param([string] $Uri, [int] $TimeoutSeconds = 3)
    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSeconds
        return $response.StatusCode -eq 200
    }
    catch { return $false }
}

function Wait-Endpoint {
    param([string] $Name, [string] $Uri, [int] $TimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (Test-Endpoint -Uri $Uri) { return }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw ("{0} did not become healthy at {1}. Check {2}." -f $Name, $Uri, $logsRoot)
}

function Get-OllamaExecutable {
    $command = Get-Command ollama.exe -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }
    foreach ($candidate in @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),
        (Join-Path $env:LOCALAPPDATA 'Ollama\ollama.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw 'Ollama is not installed. Run Repair KREA2 Vision Suite from the desktop.'
}

function Start-LoggedProcess {
    param(
        [string] $Name,
        [string] $FilePath,
        [string[]] $Arguments,
        [string] $WorkingDirectory
    )
    $outLog = Join-Path $logsRoot ("{0}.out.log" -f $Name)
    $errLog = Join-Path $logsRoot ("{0}.err.log" -f $Name)
    $parameters = @{
        FilePath = $FilePath
        ArgumentList = $Arguments
        WorkingDirectory = $WorkingDirectory
        WindowStyle = 'Hidden'
        RedirectStandardOutput = $outLog
        RedirectStandardError = $errLog
        PassThru = $true
    }
    return Start-Process @parameters
}

$started = [ordered]@{}
try {
    if (-not (Test-Endpoint -Uri 'http://127.0.0.1:11434/api/version')) {
        $ollama = Get-OllamaExecutable
        $ollamaProcess = Start-LoggedProcess -Name 'ollama' -FilePath $ollama -Arguments @('serve') -WorkingDirectory $suiteRoot
        $started.ollama_pid = $ollamaProcess.Id
        Wait-Endpoint -Name 'Ollama' -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSeconds 90
    }

    if (-not (Test-Endpoint -Uri 'http://127.0.0.1:7870/health')) {
        $visionPython = Join-Path $visionRoot '.venv\Scripts\python.exe'
        if (-not (Test-Path -LiteralPath $visionPython -PathType Leaf)) {
            throw 'Vision Studio is not installed. Run Repair KREA2 Vision Suite from the desktop.'
        }
        $visionProcess = Start-LoggedProcess -Name 'vision' -FilePath $visionPython -Arguments @(
            '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '7870'
        ) -WorkingDirectory $visionRoot
        $started.vision_pid = $visionProcess.Id
        Wait-Endpoint -Name 'Vision Studio' -Uri 'http://127.0.0.1:7870/health' -TimeoutSeconds 180
    }

    $status = [ordered]@{
        ok = $true
        checked_at = [DateTimeOffset]::Now.ToString('o')
        ollama = 'http://127.0.0.1:11434'
        vision = 'http://127.0.0.1:7870'
        interface = 'BetterDiscord plugin'
        started = $started
    }
    [IO.File]::WriteAllText($statusPath, ($status | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
}
catch {
    $failure = [ordered]@{
        ok = $false
        checked_at = [DateTimeOffset]::Now.ToString('o')
        error = $_.Exception.Message
        logs = $logsRoot
    }
    [IO.File]::WriteAllText($statusPath, ($failure | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    Write-Error $_.Exception.Message
    exit 1
}
