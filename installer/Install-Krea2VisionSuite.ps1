#requires -Version 5.1

[CmdletBinding()]
param(
    [ValidateSet('Install','Repair','PluginOnly')]
    [string] $Mode = 'Install',
    [ValidateSet('Ask','2B','4B','8B','9B-GLM-Abliterated','12B-Opus','12B-Heretic','26B-A4B-Heretic','30B-A3B-Abliterated','31B','32B','None')]
    [string] $Model = '8B',
    [switch] $PlanOnly,
    [switch] $NonInteractive,
    [switch] $NoStartup,
    [switch] $NoDiscordRestart,
    [switch] $SkipPythonPackages,
    [switch] $SkipLlamaCppRuntime,
    # Retained as a no-op so older automatic updaters can install this release.
    [switch] $SkipPromptTextModel,
    [ValidateRange(0,2147483647)]
    [int] $PreviousVisionPid = 0
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$suiteSourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pluginSourceRoot = Join-Path $suiteSourceRoot 'betterdiscord-plugin'
$pluginSource = Join-Path $pluginSourceRoot 'Krea2DiscordCollector.plugin.js'
$visionSource = Join-Path $suiteSourceRoot 'vision-studio'
$installRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Krea2VisionSuite'
$visionTarget = Join-Path $installRoot 'vision-studio'
$installedInstallerRoot = Join-Path $installRoot 'installer'
$installedPluginSourceRoot = Join-Path $installRoot 'betterdiscord-plugin'
$pluginFolder = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'BetterDiscord\plugins'
$pluginTarget = Join-Path $pluginFolder 'Krea2DiscordCollector.plugin.js'
$pluginConfig = Join-Path $pluginFolder 'Krea2DiscordCollector.config.json'
$betterDiscordRoot = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'BetterDiscord'
$forgeTokenFile = Join-Path $installRoot 'forge-handoff-token'
$receiptPath = Join-Path $installRoot 'install-receipt.json'
$desktop = [Environment]::GetFolderPath('Desktop')
$startup = [Environment]::GetFolderPath('Startup')
$suiteVersionPath = Join-Path $suiteSourceRoot 'VERSION'
if (-not (Test-Path -LiteralPath $suiteVersionPath -PathType Leaf)) { throw 'The release VERSION file is missing.' }
$suiteVersion = ([IO.File]::ReadAllText($suiteVersionPath)).Trim()
if ($suiteVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'The release VERSION value is invalid.' }

$script:PythonBootstrap = $null
$script:OllamaExecutable = $null
$script:DiscordWasRunning = $false

$models = [ordered]@{
    '2B' = [pscustomobject]@{Name='Qwen3-VL 2B Heretic F16';PublicId='llamacpp::heretic-2b-f16';Estimate=6144;Reserve=4096;Required=10240;DownloadBytes=[long]3892404928;Card='https://huggingface.co/mradermacher/Qwen-3-VL-2B-Instruct-heretic-GGUF'}
    '4B' = [pscustomobject]@{Name='Qwen3-VL 4B Heretic Q8_0';PublicId='llamacpp::heretic-4b-q8_0';Estimate=7680;Reserve=4096;Required=11776;DownloadBytes=[long]4734381856;Card='https://huggingface.co/mradermacher/Qwen3-VL-4B-Instruct-heretic-GGUF'}
    '8B' = [pscustomobject]@{Name='Qwen3-VL 8B Heretic Q8_0 (recommended)';PublicId='llamacpp::heretic-8b-q8_0';Estimate=13312;Reserve=4096;Required=17408;DownloadBytes=[long]9461810784;Card='https://huggingface.co/mradermacher/Qwen-3-VL-8B-Instruct-heretic-GGUF'}
    '9B-GLM-Abliterated' = [pscustomobject]@{Name='GLM-4.6V Flash 9B Abliterated Q5_K_M';PublicId='llamacpp::glm4-9b-abliterated-q5_k_m';Estimate=12288;Reserve=4096;Required=16384;DownloadBytes=[long]8081308800;Card='https://huggingface.co/AliBilge/Huihui-GLM-4.6V-Flash-abliterated'}
    '12B-Opus' = [pscustomobject]@{Name='Gemma 4 12B Opus 4.7 CoT Uncensored Q8_0';PublicId='llamacpp::gemma4-12b-opus-uncensored-q8_0';Estimate=20992;Reserve=4096;Required=25088;DownloadBytes=[long]12828633440;Card='https://huggingface.co/Rangle2/gemma-4-12B-it-uncensored-opus4.7-cot'}
    '12B-Heretic' = [pscustomobject]@{Name='Gemma 4 12B Heretic Q8_0';PublicId='llamacpp::gemma4-12b-heretic-q8_0';Estimate=20992;Reserve=4096;Required=25088;DownloadBytes=[long]12844764384;Card='https://huggingface.co/llmfan46/gemma-4-12B-it-uncensored-heretic-GGUF'}
    '26B-A4B-Heretic' = [pscustomobject]@{Name='Gemma 4 26B-A4B Heretic Q3_K_L';PublicId='llamacpp::gemma4-26b-a4b-heretic-q3_k_l';Estimate=24576;Reserve=4096;Required=28672;DownloadBytes=[long]15019315424;Card='https://huggingface.co/llmfan46/gemma-4-26B-A4B-it-uncensored-heretic-GGUF'}
    '30B-A3B-Abliterated' = [pscustomobject]@{Name='Qwen3-VL 30B-A3B Abliterated Q2_K';PublicId='llamacpp::qwen3-vl-30b-a3b-abliterated-q2_k';Estimate=18432;Reserve=4096;Required=22528;DownloadBytes=[long]11970760960;Card='https://huggingface.co/mradermacher/Qwen3-VL-30B-A3B-Instruct-abliterated-GGUF'}
    '31B' = [pscustomobject]@{Name='Gemma 4 31B Heretic Q4_K_M';PublicId='llamacpp::gemma4-31b-heretic-q4_k_m';Estimate=24576;Reserve=4096;Required=28672;DownloadBytes=[long]19887789376;Card='https://huggingface.co/llmfan46/gemma-4-31B-it-uncensored-heretic-GGUF'}
    '32B' = [pscustomobject]@{Name='Qwen3-VL 32B Heretic Q4_K_M';PublicId='llamacpp::qwen3-vl-32b-heretic-q4_k_m';Estimate=26624;Reserve=4096;Required=30720;DownloadBytes=[long]20983456064;Card='https://huggingface.co/llmfan46/Qwen3-VL-32B-Instruct-ultra-uncensored-heretic-GGUF'}
}

function Write-Step { param([string] $Text); Write-Host ''; Write-Host ("== {0}" -f $Text) -ForegroundColor Cyan }

function Confirm-DefaultYes {
    param([string] $Prompt)
    if ($NonInteractive) { return $true }
    $answer = (Read-Host ("{0} [Y/n]" -f $Prompt)).Trim()
    return -not ($answer -match '^(?i)n(?:o)?$')
}

function Invoke-Checked {
    param([string] $FilePath, [string[]] $Arguments, [string] $WorkingDirectory = '')
    if ($WorkingDirectory) { Push-Location $WorkingDirectory }
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) { throw ('Command failed with exit code {0}: {1}' -f $LASTEXITCODE, $FilePath) }
    }
    finally { if ($WorkingDirectory) { Pop-Location } }
}

function Test-Endpoint {
    param([string] $Uri, [int] $TimeoutSeconds = 3)
    try { $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSeconds; return $response.StatusCode -eq 200 }
    catch { return $false }
}

function Wait-Endpoint {
    param([string] $Name, [string] $Uri, [int] $TimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do { if (Test-Endpoint -Uri $Uri) { return }; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $deadline)
    throw ("{0} did not become healthy at {1}." -f $Name, $Uri)
}

function Get-PythonBootstrap {
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($null -ne $py) {
        & $py.Source -3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>$null
        if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{File=$py.Source;Prefix=@('-3')} }
    }
    $candidates = @()
    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($null -ne $python) { $candidates += $python.Source }
    $candidates += @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe')
    )
    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        & $candidate -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>$null
        if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{File=$candidate;Prefix=@()} }
    }
    return $null
}

function Require-Winget {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($null -eq $winget) {
        Start-Process 'https://aka.ms/getwinget'
        throw 'Windows App Installer (winget) is required. Install it from the page that opened, then run Repair.'
    }
    return $winget.Source
}

function Install-WingetPackage {
    param([string] $Id, [string] $Label)
    $winget = Require-Winget
    Write-Host ("Installing {0}..." -f $Label) -ForegroundColor Yellow
    Invoke-Checked -FilePath $winget -Arguments @('install','--id',$Id,'--exact','--silent','--accept-package-agreements','--accept-source-agreements')
}

function Ensure-Python {
    $script:PythonBootstrap = Get-PythonBootstrap
    if ($null -ne $script:PythonBootstrap) { Write-Host 'Python 3.11+ detected.' -ForegroundColor Green; return }
    Install-WingetPackage -Id 'Python.Python.3.12' -Label 'Python 3.12'
    $script:PythonBootstrap = Get-PythonBootstrap
    if ($null -eq $script:PythonBootstrap) { throw 'Python installed but was not detected. Sign out/in, then run Repair.' }
}

function Get-OllamaExecutable {
    $command = Get-Command ollama.exe -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }
    foreach ($candidate in @((Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),(Join-Path $env:LOCALAPPDATA 'Ollama\ollama.exe'))) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Ensure-Ollama {
    $script:OllamaExecutable = Get-OllamaExecutable
    if ($null -eq $script:OllamaExecutable) { Install-WingetPackage -Id 'Ollama.Ollama' -Label 'Ollama'; $script:OllamaExecutable = Get-OllamaExecutable }
    if ($null -eq $script:OllamaExecutable) { throw 'Ollama installed but its executable was not found. Run Repair after signing in again.' }
    if (-not (Test-Endpoint -Uri 'http://127.0.0.1:11434/api/version')) {
        [IO.Directory]::CreateDirectory((Join-Path $installRoot 'logs')) | Out-Null
        Start-Process -FilePath $script:OllamaExecutable -ArgumentList @('serve') -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $installRoot 'logs\ollama-install.out.log') `
            -RedirectStandardError (Join-Path $installRoot 'logs\ollama-install.err.log') | Out-Null
        Wait-Endpoint -Name 'Ollama' -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSeconds 90
    }
    Write-Host 'Ollama installed and responding on loopback.' -ForegroundColor Green
}

function Test-DiscordInstalled { return Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Discord\Update.exe') -PathType Leaf }

function Get-CurrentDiscordAppPath {
    $discordRoot = Join-Path $env:LOCALAPPDATA 'Discord'
    foreach ($process in @(Get-Process Discord -ErrorAction SilentlyContinue)) {
        try {
            $candidate = Split-Path -Parent $process.Path
            if ($candidate -and $candidate.StartsWith($discordRoot,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $candidate) -like 'app-*') {
                return $candidate
            }
        }
        catch {}
    }
    $apps = @(Get-ChildItem -LiteralPath $discordRoot -Directory -Filter 'app-*' -ErrorAction SilentlyContinue)
    if (-not $apps.Count) { return $null }
    return ($apps | Sort-Object @{Expression={
        try { [version]($_.Name.Substring(4)) }
        catch { [version]'0.0' }
    };Descending=$true} | Select-Object -First 1).FullName
}

function Test-BetterDiscordInjected {
    if (-not (Test-Path -LiteralPath (Join-Path $betterDiscordRoot 'data\betterdiscord.asar') -PathType Leaf)) { return $false }
    $appPath = Get-CurrentDiscordAppPath
    if (-not $appPath) { return $false }
    $modules = Join-Path $appPath 'modules'
    foreach ($coreModule in @(Get-ChildItem -LiteralPath $modules -Directory -Filter 'discord_desktop_core-*' -ErrorAction SilentlyContinue)) {
        $indexPath = Join-Path $coreModule.FullName 'discord_desktop_core\index.js'
        if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) { continue }
        try { $source = [IO.File]::ReadAllText($indexPath) }
        catch { continue }
        if ($source -match "BetterDiscord's Injection Script" -and $source -match 'betterdiscord\.asar') { return $true }
    }
    return $false
}

function Close-DiscordForInstallation {
    $processes = @(Get-Process Discord -ErrorAction SilentlyContinue)
    $script:DiscordWasRunning = $processes.Count -gt 0
    foreach ($process in $processes) { try { $null = $process.CloseMainWindow() } catch {} }
    if ($processes.Count) { Start-Sleep -Seconds 3 }
    foreach ($process in @(Get-Process Discord -ErrorAction SilentlyContinue)) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
}

function Get-BdCliExecutable {
    $command = Get-Command bdcli.exe -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }
    $linked = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\bdcli.exe'
    if (Test-Path -LiteralPath $linked -PathType Leaf) { return $linked }
    foreach ($packageRoot in @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'),
        (Join-Path $env:ProgramFiles 'WinGet\Packages')
    )) {
        foreach ($package in @(Get-ChildItem -LiteralPath $packageRoot -Directory -Filter 'betterdiscord.cli_*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)) {
            $candidate = Join-Path $package.FullName 'bdcli.exe'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }
    return $null
}

function Ensure-DiscordAndBetterDiscord {
    if (-not (Test-DiscordInstalled)) { Install-WingetPackage -Id 'Discord.Discord' -Label 'Discord Stable' }
    if ((Test-BetterDiscordInjected) -and $Mode -ne 'Repair') { Write-Host 'BetterDiscord injection is current.' -ForegroundColor Green; return }
    $bdcli = Get-BdCliExecutable
    if ($null -eq $bdcli) { Install-WingetPackage -Id 'betterdiscord.cli' -Label 'the official BetterDiscord CLI'; $bdcli = Get-BdCliExecutable }
    if ($null -eq $bdcli) { throw 'The BetterDiscord CLI installed but was not found. Run Repair after signing in again.' }
    Close-DiscordForInstallation
    Write-Host 'Installing or repairing BetterDiscord Stable...' -ForegroundColor Yellow
    Invoke-Checked -FilePath $bdcli -Arguments @('install','--channel','stable')
    if (-not (Test-BetterDiscordInjected)) { throw 'BetterDiscord finished, but the current Discord app version was not injected.' }
    Write-Host 'BetterDiscord installed.' -ForegroundColor Green
}

function Copy-CodeTree {
    param([string] $Source, [string] $Target)
    [IO.Directory]::CreateDirectory($Target) | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        if ($item.Name -in @('.git','.venv','data','logs','.env','__pycache__','backups')) { continue }
        Copy-Item -LiteralPath $item.FullName -Destination $Target -Recurse -Force
    }
}

function Ensure-Venv {
    param([string] $ApplicationRoot)
    if ($SkipPythonPackages) { return }
    $venvPython = Join-Path $ApplicationRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        $arguments = @($script:PythonBootstrap.Prefix) + @('-m','venv',(Join-Path $ApplicationRoot '.venv'))
        Invoke-Checked -FilePath $script:PythonBootstrap.File -Arguments $arguments
    }
    $requirements = Join-Path $ApplicationRoot 'requirements.txt'
    $requirementHash = (Get-FileHash -LiteralPath $requirements -Algorithm SHA256).Hash.ToLowerInvariant()
    $marker = Join-Path $ApplicationRoot '.venv\.krea2-requirements.sha256'
    $installedHash = if (Test-Path -LiteralPath $marker -PathType Leaf) { ([IO.File]::ReadAllText($marker)).Trim() } else { '' }
    if ($installedHash -ne $requirementHash) {
        Invoke-Checked -FilePath $venvPython -Arguments @('-m','pip','install','--disable-pip-version-check','-r',$requirements)
        [IO.File]::WriteAllText($marker,$requirementHash,[Text.UTF8Encoding]::new($false))
    }
}

function Ensure-EnvFile {
    param([string] $ApplicationRoot)
    $envPath = Join-Path $ApplicationRoot '.env'
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { Copy-Item -LiteralPath (Join-Path $ApplicationRoot '.env.example') -Destination $envPath }
    return $envPath
}

function Get-EnvValue {
    param([string] $Path,[string] $Key)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $match = [regex]::Match([IO.File]::ReadAllText($Path),('(?m)^'+[regex]::Escape($Key)+'=(.*)$'))
    if ($match.Success) { return $match.Groups[1].Value.Trim().Trim('"').Trim("'") }
    return ''
}

function Set-EnvValue {
    param([string] $Path,[string] $Key,[string] $Value)
    $content = if (Test-Path -LiteralPath $Path -PathType Leaf) { [IO.File]::ReadAllText($Path) } else { '' }
    $pattern = '(?m)^'+[regex]::Escape($Key)+'=.*$'; $replacement = $Key+'='+$Value
    if ([regex]::IsMatch($content,$pattern)) { $content = [regex]::Replace($content,$pattern,$replacement) }
    else { if ($content -and -not $content.EndsWith("`n")) { $content += "`r`n" }; $content += $replacement+"`r`n" }
    [IO.File]::WriteAllText($Path,$content,[Text.UTF8Encoding]::new($false))
}

function New-RandomSecret {
    param([int] $Bytes=48)
    $buffer=New-Object byte[] $Bytes; $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    try {$rng.GetBytes($buffer)} finally {$rng.Dispose()}
    return ([BitConverter]::ToString($buffer)).Replace('-','').ToLowerInvariant()
}

function Ensure-ForgeToken {
    [IO.Directory]::CreateDirectory($installRoot)|Out-Null
    if (-not (Test-Path -LiteralPath $forgeTokenFile -PathType Leaf)) { [IO.File]::WriteAllText($forgeTokenFile,(New-RandomSecret -Bytes 48),[Text.UTF8Encoding]::new($false)) }
}

function Add-OrSetProperty {
    param([object]$Object,[string]$Name,[object]$Value)
    if ($Object.PSObject.Properties.Name -contains $Name) {$Object.$Name=$Value} else {$Object|Add-Member -NotePropertyName $Name -NotePropertyValue $Value}
}

function Read-PluginConfiguration {
    if (-not (Test-Path -LiteralPath $pluginConfig -PathType Leaf)) {return $null}
    try {return [IO.File]::ReadAllText($pluginConfig)|ConvertFrom-Json} catch {return $null}
}

function Configure-Plugin {
    param([string]$VisionToken,[string]$VisionModel)
    [IO.Directory]::CreateDirectory($pluginFolder)|Out-Null
    $configuration=Read-PluginConfiguration; if($null -eq $configuration){$configuration=[pscustomobject]@{}}
    if(-not($configuration.PSObject.Properties.Name -contains 'settings') -or $null -eq $configuration.settings){Add-OrSetProperty $configuration 'settings' ([pscustomobject]@{})}
    Add-OrSetProperty $configuration.settings 'visionEndpoint' 'http://127.0.0.1:7870/api/discord-describe'
    Add-OrSetProperty $configuration.settings 'visionToken' $VisionToken
    Add-OrSetProperty $configuration.settings 'visionModel' $VisionModel
    if($configuration.settings.PSObject.Properties.Name -contains 'saveFolder'){$configuration.settings.PSObject.Properties.Remove('saveFolder')}
    [IO.File]::WriteAllText($pluginConfig,($configuration|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
}

function Get-ExistingPluginVisionToken {
    $configuration=Read-PluginConfiguration
    if($null -eq $configuration -or $null -eq $configuration.settings){return ''}
    $property=$configuration.settings.PSObject.Properties['visionToken']; if($null -eq $property){return ''}
    $token=[string]$property.Value; if($token.Length -ge 32){return $token}; return ''
}

function Get-ExistingPluginVisionModel {
    $configuration=Read-PluginConfiguration
    if($null -eq $configuration -or $null -eq $configuration.settings){return ''}
    $property=$configuration.settings.PSObject.Properties['visionModel'];if($null -eq $property){return ''}
    $candidate=([string]$property.Value).Trim()
    foreach($value in $models.Values){if($value.PublicId -eq $candidate){return $candidate}}
    return ''
}

function Test-PinnedFile {
    param([string]$Path,[long]$ExpectedBytes,[string]$ExpectedHash)
    if(-not(Test-Path -LiteralPath $Path -PathType Leaf)){return $false}
    if((Get-Item -LiteralPath $Path).Length -ne $ExpectedBytes){return $false}
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $ExpectedHash
}

function Receive-PinnedFile {
    param([string]$Url,[string]$Destination,[long]$ExpectedBytes,[string]$ExpectedHash)
    if(Test-PinnedFile $Destination $ExpectedBytes $ExpectedHash){Write-Host ('Verified existing file: {0}' -f $Destination) -ForegroundColor Green;return}
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Destination))|Out-Null; $partial=$Destination+'.partial'
    $curl=Get-Command curl.exe -ErrorAction SilentlyContinue
    if($null -ne $curl){Invoke-Checked $curl.Source @('--location','--fail','--retry','3','--retry-delay','2','--continue-at','-','--output',$partial,$Url)}
    else {if(Test-Path -LiteralPath $partial -PathType Leaf){Remove-Item -LiteralPath $partial -Force};Import-Module BitsTransfer;Start-BitsTransfer -Source $Url -Destination $partial -DisplayName 'KREA2 verified model download'}
    if(-not(Test-PinnedFile $partial $ExpectedBytes $ExpectedHash)){throw ('Downloaded file failed exact size/SHA-256 verification: {0}' -f $Destination)}
    Move-Item -LiteralPath $partial -Destination $Destination -Force
}

function Install-Launchers {
    Copy-CodeTree $PSScriptRoot $installedInstallerRoot
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Start-Krea2VisionSuite.ps1') -Destination (Join-Path $installRoot 'Start-Krea2VisionSuite.ps1') -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Start-Krea2VisionSuite.cmd') -Destination (Join-Path $installRoot 'Start-Krea2VisionSuite.cmd') -Force
    $desktopStart=Join-Path $desktop 'Start KREA2 Vision Suite.bat';$desktopRepair=Join-Path $desktop 'Repair KREA2 Vision Suite.bat'
    $startText="@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$installRoot\Start-Krea2VisionSuite.ps1`"`r`nif errorlevel 1 pause`r`n"
    $repairText="@echo off`r`ncall `"$installedInstallerRoot\Krea2VisionSuite-Installer.cmd`" -Mode Repair`r`n"
    [IO.File]::WriteAllText($desktopStart,$startText,[Text.ASCIIEncoding]::new());[IO.File]::WriteAllText($desktopRepair,$repairText,[Text.ASCIIEncoding]::new())
    if(-not $NoStartup){
        [IO.Directory]::CreateDirectory($startup)|Out-Null;$shortcutPath=Join-Path $startup 'KREA2 Vision Suite.lnk';$shell=New-Object -ComObject WScript.Shell;$shortcut=$shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe';$shortcut.Arguments="-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$installRoot\Start-Krea2VisionSuite.ps1`"";$shortcut.WorkingDirectory=$installRoot;$shortcut.WindowStyle=7;$shortcut.Description='Starts the local KREA2 Vision backend and Ollama compatibility service only when needed.';$shortcut.Save()
    }
}

function Stop-OwnedSuiteProcesses {
    $owned = @{}
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" -ErrorAction SilentlyContinue)) {
        $commandLine = [string]$process.CommandLine
        if (-not $commandLine) { continue }
        $matchesInstalledRoot = $commandLine.IndexOf($visionTarget, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $matchesExactPrevious = $PreviousVisionPid -gt 0 -and [int]$process.ProcessId -eq $PreviousVisionPid -and $commandLine -match '(?i)(uvicorn|app\.main:app)' -and $commandLine -match '(?i)(7870|STUDIO_PORT)'
        if (-not $matchesInstalledRoot -and -not $matchesExactPrevious) { continue }
        $owned[[int]$process.ProcessId] = $process
    }
    foreach ($process in @($owned.Values)) {
        try {
            Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop
            Write-Host ("Stopped previous KREA2 companion process {0} before verification." -f $process.ProcessId) -ForegroundColor Yellow
        }
        catch {
            throw ("Could not stop previous KREA2 companion process {0}. Close it, then run Repair again." -f $process.ProcessId)
        }
    }
}

function Start-Discord {
    if($NoDiscordRestart){return}
    foreach($process in @(Get-Process Discord -ErrorAction SilentlyContinue)){try{$null=$process.CloseMainWindow()}catch{}}
    Start-Sleep -Seconds 2
    foreach($process in @(Get-Process Discord -ErrorAction SilentlyContinue)){Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue}
    $update=Join-Path $env:LOCALAPPDATA 'Discord\Update.exe';if(Test-Path -LiteralPath $update -PathType Leaf){Start-Process -FilePath $update -ArgumentList @('--processStart','Discord.exe')|Out-Null}
}

function Write-ModelTable {
    Write-Host '';Write-Host 'Local Heretic Vision choices' -ForegroundColor Cyan
    Write-Host 'Heretic weights are designed to avoid refusals. KREA2 still keeps local security, grounded-output, queue, and VRAM guardrails.' -ForegroundColor Yellow
    foreach($entry in $models.GetEnumerator()){$value=$entry.Value;Write-Host ('[{0}] {1}' -f $entry.Key,$value.Name) -ForegroundColor White;Write-Host ('    model {0:N0} MiB + reserve {1:N0} MiB = admission {2:N0} MiB; download {3:N1} GiB' -f $value.Estimate,$value.Reserve,$value.Required,($value.DownloadBytes/1GB));Write-Host ('    {0}' -f $value.Card) -ForegroundColor DarkCyan}
}

function Write-Inventory {
    Write-Step 'Current computer check';$python=Get-PythonBootstrap
    Write-Host ('Python 3.11+: '+$(if($null -ne $python){'ready'}else{'will install'}));Write-Host ('Discord Stable: '+$(if(Test-DiscordInstalled){'ready'}else{'will install'}));Write-Host ('BetterDiscord: '+$(if(Test-BetterDiscordInjected){'ready'}else{'will install or repair'}));Write-Host ('Ollama: '+$(if($null -ne(Get-OllamaExecutable)){'ready'}else{'will install'}));Write-Host ('NVIDIA runtime: '+$(if($null -ne(Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue)){'detected'}else{'not detected; a current NVIDIA driver is required'}));Write-Host ('Windows startup launcher: '+$(if($NoStartup){'disabled by option'}else{'will be registered'}))
}

function Verify-Installation {
    param([string]$SelectedPublicId)
    Write-Step 'Starting and verifying the BetterDiscord Vision backend';$launcher=Join-Path $installRoot 'Start-Krea2VisionSuite.ps1'
    Invoke-Checked 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File',$launcher)
    Wait-Endpoint 'Vision backend' 'http://127.0.0.1:7870/health' 180
    if(-not(Test-Endpoint 'http://127.0.0.1:11434/api/version')){throw 'Ollama health verification failed.'}
    if($SelectedPublicId){$catalog=Invoke-RestMethod -Uri 'http://127.0.0.1:7870/api/discord-models' -TimeoutSec 240;$installed=@($catalog.models|Where-Object{$_.public_id -eq $SelectedPublicId});if($installed.Count -ne 1){throw ('Selected Vision model was not reported as installed: {0}' -f $SelectedPublicId)}}
    $installedHash=(Get-FileHash -LiteralPath $pluginTarget -Algorithm SHA256).Hash.ToLowerInvariant();$sourceHash=(Get-FileHash -LiteralPath $pluginSource -Algorithm SHA256).Hash.ToLowerInvariant();if($installedHash -ne $sourceHash){throw 'Installed plugin hash does not match the release bundle.'}
    if(-not $NoStartup -and -not(Test-Path -LiteralPath (Join-Path $startup 'KREA2 Vision Suite.lnk') -PathType Leaf)){throw 'Windows startup registration was not created.'}
    return [ordered]@{vision_health='ok';ollama_health='ok';selected_model=$SelectedPublicId;plugin_sha256=$installedHash;startup_registered=-not $NoStartup}
}

Write-Host 'KREA2 Vision Suite installer and repair center' -ForegroundColor Cyan
Write-Host 'This installs missing user-scoped prerequisites, the local Vision backend, verified models, BetterDiscord, launchers, and automatic startup.'
Write-Host 'BetterDiscord is an unofficial Discord modification. Review Discord and BetterDiscord terms before continuing.' -ForegroundColor Yellow
Write-Host ('Mode: {0}' -f $Mode);Write-ModelTable;Write-Inventory

if($Model -eq 'Ask'){$answer=(Read-Host 'Choose 2B, 4B, 8B recommended, 9B-GLM-Abliterated, 12B-Opus, 12B-Heretic, 26B-A4B-Heretic, 30B-A3B-Abliterated, 31B, 32B, or None').Trim();$canonical=@{'2B'='2B';'4B'='4B';'8B'='8B';'9B-GLM-ABLITERATED'='9B-GLM-Abliterated';'12B-OPUS'='12B-Opus';'12B-HERETIC'='12B-Heretic';'26B-A4B-HERETIC'='26B-A4B-Heretic';'30B-A3B-ABLITERATED'='30B-A3B-Abliterated';'31B'='31B';'32B'='32B';'NONE'='None'};$key=$answer.ToUpperInvariant();if(-not $canonical.ContainsKey($key)){throw 'Model selection was not recognized.'};$Model=$canonical[$key]}
$selectedModel=if($Model -eq 'None'){$null}else{$models[$Model]}
if($PlanOnly){Write-Host '';Write-Host 'Plan only: no files, programs, models, processes, or startup settings were changed.' -ForegroundColor Green;if($null -ne $selectedModel){Write-Host ('Default Vision selection: {0}' -f $selectedModel.Name)};exit 0}
if(-not(Confirm-DefaultYes 'Continue with automatic setup? Discord may close and restart, and the default models require a large download')){Write-Host 'Setup cancelled; nothing was changed.';exit 2}
if(-not(Test-Path -LiteralPath $pluginSource -PathType Leaf)){throw ('Plugin bundle is missing: {0}' -f $pluginSource)}

if($Mode -ne 'PluginOnly'){
    if($null -eq(Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue)){Start-Process 'https://www.nvidia.com/Download/index.aspx';throw 'A supported NVIDIA driver was not detected. Install it, reboot if requested, then run Repair.'}
    Write-Step 'Installing required Windows programs';Ensure-Python;Ensure-Ollama
}
Write-Step 'Installing Discord integration';Ensure-DiscordAndBetterDiscord
[IO.Directory]::CreateDirectory($pluginFolder)|Out-Null
if(Test-Path -LiteralPath $pluginTarget -PathType Leaf){Copy-Item -LiteralPath $pluginTarget -Destination ('{0}.backup-{1}' -f $pluginTarget,(Get-Date -Format 'yyyyMMdd-HHmmss'))}
Copy-Item -LiteralPath $pluginSource -Destination $pluginTarget -Force

$verification=[ordered]@{};$visionToken=Get-ExistingPluginVisionToken
$selectedPublicId=if($null -ne $selectedModel){$selectedModel.PublicId}else{Get-ExistingPluginVisionModel}
if(-not $selectedPublicId){$selectedPublicId=Get-EnvValue (Join-Path $visionTarget '.env') 'QWEN_MODEL'}
if(-not $selectedPublicId){$selectedPublicId='llamacpp::heretic-8b-q8_0'}
if($Mode -ne 'PluginOnly'){
    Write-Step 'Installing the BetterDiscord Vision backend';Copy-CodeTree $visionSource $visionTarget;Copy-CodeTree $pluginSourceRoot $installedPluginSourceRoot
    [IO.Directory]::CreateDirectory($installRoot)|Out-Null;[IO.File]::WriteAllText((Join-Path $installRoot 'VERSION'),$suiteVersion+"`r`n",[Text.UTF8Encoding]::new($false))
    Ensure-Venv $visionTarget;Ensure-ForgeToken;$visionEnv=Ensure-EnvFile $visionTarget
    if(-not $visionToken){$visionToken=Get-EnvValue $visionEnv 'KREA2_DISCORD_VISION_TOKEN'};if(-not $visionToken -or $visionToken.Length -lt 32){$visionToken=New-RandomSecret -Bytes 48}
    Set-EnvValue $visionEnv 'KREA2_DISCORD_VISION_TOKEN' $visionToken;Set-EnvValue $visionEnv 'QWEN_BACKEND' 'llama_cpp';Set-EnvValue $visionEnv 'QWEN_MODEL' $selectedPublicId;Set-EnvValue $visionEnv 'LLAMA_CPP_MODEL_ROOT' (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'KreaHereticModels');Set-EnvValue $visionEnv 'STUDIO_FORGE_HANDOFF_TOKEN_FILE' $forgeTokenFile
    if(-not $SkipLlamaCppRuntime){Write-Step 'Installing the verified llama.cpp runtime and Vision model';$runtimeInstaller=Join-Path $visionTarget 'scripts\install_heretic_llamacpp.ps1';$runtimeArguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$runtimeInstaller,'-InstallRoot',(Join-Path $env:LOCALAPPDATA 'Krea2Vision\llama.cpp\b10590'),'-CacheRoot',(Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'KreaHereticModels\.downloads'),'-ModelRoot',(Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'KreaHereticModels'),'-VerifyManualModels');if($Model -ne 'None'){$runtimeArguments+=@('-DownloadModels',$Model)};Invoke-Checked 'powershell.exe' $runtimeArguments}
    Install-Launchers;Stop-OwnedSuiteProcesses
}elseif(-not $visionToken){$visionToken=New-RandomSecret -Bytes 48}

Configure-Plugin $visionToken $selectedPublicId
if($Mode -ne 'PluginOnly'){$verification=Verify-Installation $(if($Model -eq 'None'){''}else{$selectedPublicId})}
else{$installedHash=(Get-FileHash -LiteralPath $pluginTarget -Algorithm SHA256).Hash.ToLowerInvariant();$sourceHash=(Get-FileHash -LiteralPath $pluginSource -Algorithm SHA256).Hash.ToLowerInvariant();if($installedHash -ne $sourceHash){throw 'Installed plugin hash does not match the release bundle.'};$verification=[ordered]@{plugin_sha256=$installedHash;plugin_only=$true}}

[IO.Directory]::CreateDirectory($installRoot)|Out-Null
$receipt=[ordered]@{schema_version=1;release_version=$suiteVersion;installed_at=[DateTimeOffset]::Now.ToString('o');mode=$Mode;install_root=$installRoot;vision_model=$selectedPublicId;prompt_model=$null;plugin_path=$pluginTarget;verification=$verification}
[IO.File]::WriteAllText($receiptPath,($receipt|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
Start-Discord
Write-Host '';Write-Host 'KREA2 Vision Suite is installed, configured, running, and registered for Windows startup.' -ForegroundColor Green
Write-Host ('Start shortcut: {0}' -f (Join-Path $desktop 'Start KREA2 Vision Suite.bat'));Write-Host ('Repair shortcut: {0}' -f (Join-Path $desktop 'Repair KREA2 Vision Suite.bat'));Write-Host ('Installation receipt: {0}' -f $receiptPath)
Write-Host 'Open Discord, enable Krea2DiscordCollector if needed, allow the current server in its first-run window, and use the magnifier.'
