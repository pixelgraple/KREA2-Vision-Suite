$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $bridgeRoot '.venv\Scripts\python.exe'
$config = Join-Path $bridgeRoot 'config.json'

if (-not (Test-Path -LiteralPath $python)) {
    throw "Bridge Python environment is missing: $python"
}
if (-not (Test-Path -LiteralPath $config)) {
    throw "Bridge configuration is missing: $config"
}

$env:VAST_OPENWEBUI_BRIDGE_CONFIG = $config
& $python -m uvicorn bridge:app --app-dir $bridgeRoot --host 127.0.0.1 --port 11436 --log-level info
