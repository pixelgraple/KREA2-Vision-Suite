#requires -Version 5.1

[CmdletBinding()]
param(
    [string] $Version = '',
    [string] $OutputDirectory = ''
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

function Get-RelativePathCompat {
    param([string] $BasePath, [string] $TargetPath)
    $baseFull = [IO.Path]::GetFullPath($BasePath).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    $targetFull = [IO.Path]::GetFullPath($TargetPath)
    $baseUri = [Uri] $baseFull
    $targetUri = [Uri] $targetFull
    return [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace('/', [IO.Path]::DirectorySeparatorChar)
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Version) { $Version = ([IO.File]::ReadAllText((Join-Path $repoRoot 'VERSION'))).Trim() }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid release version: $Version" }
$backendVersion = ([IO.File]::ReadAllText((Join-Path $repoRoot 'vision-studio\VERSION'))).Trim()
if ($backendVersion -ne $Version) { throw "vision-studio/VERSION ($backendVersion) does not match release VERSION ($Version)." }
$pluginSourceText = [IO.File]::ReadAllText((Join-Path $repoRoot 'betterdiscord-plugin\Krea2DiscordCollector.plugin.source.js'))
if ($pluginSourceText -notmatch ('(?m)^ \* @version '+[regex]::Escape($Version)+'$')) { throw 'Plugin metadata version does not match release VERSION.' }
if ($pluginSourceText -notmatch ('const PLUGIN_VERSION = "'+[regex]::Escape($Version)+'";')) { throw 'Plugin runtime version does not match release VERSION.' }

$releaseRoot = if ($OutputDirectory) {
    [IO.Path]::GetFullPath($OutputDirectory)
}
else {
    [IO.Path]::GetFullPath((Join-Path $repoRoot 'releases'))
}
[IO.Directory]::CreateDirectory($releaseRoot) | Out-Null

$archiveName = "Krea2VisionSuite-v$Version-win64.zip"
$archivePath = [IO.Path]::GetFullPath((Join-Path $releaseRoot $archiveName))
if (-not $archivePath.StartsWith($releaseRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Release archive escaped the selected output directory.'
}
if (Test-Path -LiteralPath $archivePath -PathType Leaf) { Remove-Item -LiteralPath $archivePath -Force }

$rootFiles = @(
    '.gitignore',
    'CONTRIBUTING.md',
    'LICENSE',
    'README.md',
    'SECURITY.md',
    'START HERE - INSTALL.bat',
    'VERSION'
)
$sourceDirectories = @(
    'betterdiscord-plugin',
    'docs',
    'installer',
    'vision-studio',
    'vast-serverless-gemma26'
)
$excludedDirectoryNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($name in @('.git','.github','.venv','__pycache__','backups','data','logs','node_modules','release')) { $null = $excludedDirectoryNames.Add($name) }
$excludedExtensions = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($extension in @('.db','.gguf','.log','.partial','.pyc','.sqlite','.sqlite3','.wal','.zip')) { $null = $excludedExtensions.Add($extension) }

$files = [Collections.Generic.List[IO.FileInfo]]::new()
foreach ($relative in $rootFiles) {
    $path = Join-Path $repoRoot $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required release file is missing: $relative" }
    $files.Add((Get-Item -LiteralPath $path))
}
foreach ($relative in $sourceDirectories) {
    $directory = Join-Path $repoRoot $relative
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw "Required release directory is missing: $relative" }
    foreach ($file in Get-ChildItem -LiteralPath $directory -Recurse -File -Force) {
        $relativePath = Get-RelativePathCompat -BasePath $repoRoot -TargetPath $file.FullName
        $segments = $relativePath -split '[\\/]'
        if ($segments | Where-Object { $excludedDirectoryNames.Contains($_) }) { continue }
        if ($file.Name -ieq '.env' -or $file.Name -like '*.env.local') { continue }
        if ($excludedExtensions.Contains($file.Extension)) { continue }
        $files.Add($file)
    }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
try {
    $prefix = "Krea2VisionSuite-v$Version"
    foreach ($file in $files | Sort-Object FullName -Unique) {
        $relativePath = (Get-RelativePathCompat -BasePath $repoRoot -TargetPath $file.FullName).Replace('\','/')
        $entryName = "$prefix/$relativePath"
        $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive,
            $file.FullName,
            $entryName,
            [IO.Compression.CompressionLevel]::Optimal
        )
    }
}
finally {
    $archive.Dispose()
}

$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumPath = "$archivePath.sha256.txt"
[IO.File]::WriteAllText($checksumPath, "$hash  $archiveName`r`n", [Text.UTF8Encoding]::new($false))
$manifestPath = Join-Path $releaseRoot 'latest.json'
$manifest = [ordered]@{
    schema_version = 1
    product = 'krea2-vision-suite'
    channel = 'stable'
    version = $Version
    published_at = [DateTimeOffset]::UtcNow.ToString('o')
    download_url = "https://raw.githubusercontent.com/pixelgraple/KREA2-Vision-Suite/main/releases/$archiveName"
    sha256 = $hash
    bytes = (Get-Item -LiteralPath $archivePath).Length
    notes_url = 'https://github.com/pixelgraple/KREA2-Vision-Suite#download'
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4) + "`r`n", [Text.UTF8Encoding]::new($false))

[pscustomobject]@{
    version = $Version
    archive = $archivePath
    sha256 = $hash
    bytes = (Get-Item -LiteralPath $archivePath).Length
    files = $files.Count
    manifest = $manifestPath
    excludes_archived_prompt_assistant = $true
} | ConvertTo-Json
