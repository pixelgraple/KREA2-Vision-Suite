#requires -Version 5.1

[CmdletBinding()]
param(
    [ValidateSet('Install', 'Repair', 'Update', 'PluginOnly')]
    [string] $Mode = 'Install',
    [ValidateSet('Ask', '2B', '4B', '8B', '9B-GLM-Abliterated', '12B-Opus', '12B-Heretic', '26B-A4B-Heretic', '30B-A3B-Abliterated', '31B', '32B', 'None')]
    [string] $Model = '8B',
    [switch] $PlanOnly,
    [switch] $KeepDownloadedFiles
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$manifestUri = 'https://raw.githubusercontent.com/pixelgraple/KREA2-Vision-Suite/main/releases/latest.json'
$allowedDownloadPrefix = 'https://raw.githubusercontent.com/pixelgraple/KREA2-Vision-Suite/main/releases/'
$workingRoot = Join-Path ([IO.Path]::GetTempPath()) ('Krea2VisionSuite-bootstrap-' + [guid]::NewGuid().ToString('N'))
$archivePath = Join-Path $workingRoot 'Krea2VisionSuite.zip'
$expandedRoot = Join-Path $workingRoot 'expanded'

function Stop-Setup {
    param([string] $Message)
    throw ('KREA2 setup stopped safely: ' + $Message)
}

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    [IO.Directory]::CreateDirectory($workingRoot) | Out-Null

    Write-Host 'Downloading the official KREA2 Vision Suite release manifest...' -ForegroundColor Cyan
    $manifest = Invoke-RestMethod -Uri $manifestUri -Method Get -TimeoutSec 30
    if ([int]$manifest.schema_version -ne 1 -or [string]$manifest.product -ne 'krea2-vision-suite' -or [string]$manifest.channel -ne 'stable') {
        Stop-Setup 'the release manifest identity is invalid.'
    }

    $version = ([string]$manifest.version).Trim()
    $downloadUri = ([string]$manifest.download_url).Trim()
    $expectedHash = ([string]$manifest.sha256).Trim().ToLowerInvariant()
    $expectedBytes = [long]$manifest.bytes
    if ($version -notmatch '^\d+\.\d+\.\d+$') { Stop-Setup 'the release version is invalid.' }
    if (-not $downloadUri.StartsWith($allowedDownloadPrefix, [StringComparison]::Ordinal)) {
        Stop-Setup 'the release points outside the pinned public repository.'
    }
    if ($expectedHash -notmatch '^[0-9a-f]{64}$' -or $expectedBytes -lt 1024) {
        Stop-Setup 'the release size or SHA-256 is invalid.'
    }

    Write-Host ("Downloading KREA2 Vision Suite v{0}..." -f $version) -ForegroundColor Cyan
    Invoke-WebRequest -Uri $downloadUri -OutFile $archivePath -UseBasicParsing -TimeoutSec 300
    $actualBytes = (Get-Item -LiteralPath $archivePath).Length
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualBytes -ne $expectedBytes) { Stop-Setup 'the downloaded archive length does not match the signed release manifest.' }
    if ($actualHash -ne $expectedHash) { Stop-Setup 'the downloaded archive failed SHA-256 verification.' }
    Write-Host ("Verified release SHA-256: {0}" -f $actualHash) -ForegroundColor Green

    Expand-Archive -LiteralPath $archivePath -DestinationPath $expandedRoot -Force
    $releaseDirectories = @(Get-ChildItem -LiteralPath $expandedRoot -Directory)
    if ($releaseDirectories.Count -ne 1) { Stop-Setup 'the verified archive does not contain exactly one release directory.' }
    $releaseRoot = [IO.Path]::GetFullPath($releaseDirectories[0].FullName)
    $expandedFull = [IO.Path]::GetFullPath($expandedRoot + [IO.Path]::DirectorySeparatorChar)
    if (-not $releaseRoot.StartsWith($expandedFull, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Setup 'the installer resolved outside the verified extraction directory.'
    }
    $installerPath = Join-Path $releaseRoot 'installer\Install-Krea2VisionSuite.ps1'
    if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) { Stop-Setup 'the verified archive installer is missing.' }
    $versionPath = Join-Path $releaseRoot 'VERSION'
    if (-not (Test-Path -LiteralPath $versionPath -PathType Leaf)) { Stop-Setup 'the release VERSION file is missing.' }
    if (([IO.File]::ReadAllText($versionPath)).Trim() -ne $version) { Stop-Setup 'the archive and manifest versions do not match.' }

    Write-Host 'Starting the verified guided installer...' -ForegroundColor Cyan
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installerPath, '-Mode', $Mode, '-Model', $Model)
    if ($PlanOnly) { $arguments += '-PlanOnly' }
    & powershell.exe @arguments
    if ($LASTEXITCODE -ne 0) { Stop-Setup ("the guided installer returned exit code {0}." -f $LASTEXITCODE) }
}
finally {
    if (-not $KeepDownloadedFiles -and (Test-Path -LiteralPath $workingRoot)) {
        $resolved = [IO.Path]::GetFullPath($workingRoot)
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -like 'Krea2VisionSuite-bootstrap-*') {
            Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
