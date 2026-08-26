$ErrorActionPreference = "Stop"
$venv = Join-Path $env:LOCALAPPDATA "Krea2Vision\vastsdk"
if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) {
    python -m venv $venv
}
$python = Join-Path $venv "Scripts\python.exe"
& $python -m pip install --upgrade pip
& $python -m pip install "vastai==1.5.5"
& $python -m pip check
Write-Host "Vast Serverless client installed at $python"
