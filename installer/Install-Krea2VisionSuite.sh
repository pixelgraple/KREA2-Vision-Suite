#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_root="$(cd "$script_dir/.." && pwd)"

case "$(uname -s)" in
    Darwin)
        platform="macOS"
        default_root="$HOME/Library/Application Support/Krea2VisionSuite"
        plugin_root="$HOME/Library/Application Support/BetterDiscord/plugins"
        ;;
    Linux)
        platform="Linux"
        default_root="${XDG_DATA_HOME:-$HOME/.local/share}/Krea2VisionSuite"
        plugin_root="${XDG_CONFIG_HOME:-$HOME/.config}/BetterDiscord/plugins"
        ;;
    *)
        echo "This installer supports Linux and macOS. Use START HERE - INSTALL.bat on Windows." >&2
        exit 1
        ;;
esac

python_command="${PYTHON:-python3}"
"$python_command" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else "Python 3.11 or newer is required.")'

install_root="${KREA2_INSTALL_ROOT:-$default_root}"
vision_root="$install_root/vision-studio"
plugin_source="$source_root/betterdiscord-plugin/Krea2DiscordCollector.plugin.js"
plugin_target="$plugin_root/Krea2DiscordCollector.plugin.js"
plugin_config="$plugin_root/Krea2DiscordCollector.config.json"

if [[ ! -f "$plugin_source" || ! -f "$source_root/vision-studio/requirements.txt" ]]; then
    echo "Run this script from a complete KREA2 Vision Suite checkout or release." >&2
    exit 1
fi

model_root="$install_root/models"
mkdir -p "$vision_root" "$plugin_root" "$install_root/logs" "$model_root"
cp -R "$source_root/vision-studio/." "$vision_root/"
cp "$plugin_source" "$plugin_target"
cp "$script_dir/Start-Krea2VisionSuite.sh" "$install_root/Start-Krea2VisionSuite.sh"
chmod 700 "$install_root/Start-Krea2VisionSuite.sh"

if [[ ! -x "$vision_root/.venv/bin/python" ]]; then
    "$python_command" -m venv "$vision_root/.venv"
fi
"$vision_root/.venv/bin/python" -m pip install --disable-pip-version-check -r "$vision_root/requirements.txt"

vision_token="$(
"$vision_root/.venv/bin/python" - "$vision_root/.env" "$model_root" <<'PY'
from __future__ import annotations
import secrets
import sys
from pathlib import Path

path = Path(sys.argv[1])
lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
values: dict[str, str] = {}
for line in lines:
    if line and not line.lstrip().startswith("#") and "=" in line:
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
token = values.get("KREA2_DISCORD_VISION_TOKEN", "")
if len(token) < 32:
    token = secrets.token_hex(48)
updates = {
    "KREA2_DISCORD_VISION_TOKEN": token,
    "KREA2_REMOTE_GATEWAY_URL": "https://seedframe.xyz/api/krea2-vision",
    "VAST_SERVERLESS_ENABLED": "true",
    "STUDIO_HOST": "127.0.0.1",
    "STUDIO_PORT": "7870",
    "STUDIO_USE_SHARED_GENERATION_QUEUE": "false",
    "LLAMA_CPP_MODEL_ROOT": sys.argv[2],
}
kept = [line for line in lines if not any(line.startswith(f"{key}=") for key in updates)]
kept.extend(f"{key}={value}" for key, value in updates.items())
path.write_text("\n".join(kept).rstrip() + "\n", encoding="utf-8")
print(token)
PY
)"

save_folder="$HOME/Pictures/Krea2Vision"
mkdir -p "$save_folder"
"$vision_root/.venv/bin/python" - "$plugin_config" "$vision_token" "$save_folder" <<'PY'
from __future__ import annotations
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    payload = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
except (OSError, UnicodeError, json.JSONDecodeError):
    payload = {}
if not isinstance(payload, dict):
    payload = {}
settings = payload.get("settings")
if not isinstance(settings, dict):
    settings = {}
settings.update({
    "visionEndpoint": "http://127.0.0.1:7870/api/discord-describe",
    "visionToken": sys.argv[2],
    "visionExecutionMode": "online",
    "visionAnalysisProfile": "v2",
    "saveFolder": sys.argv[3],
})
payload["settings"] = settings
path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY
chmod 600 "$plugin_config" "$vision_root/.env"

if ! "$vision_root/.venv/bin/python" -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:7870/health", timeout=2)' >/dev/null 2>&1; then
    mkdir -p "$vision_root/logs"
    nohup "$install_root/Start-Krea2VisionSuite.sh" \
        >"$vision_root/logs/vision_uvicorn.stdout.log" \
        2>"$vision_root/logs/vision_uvicorn.stderr.log" &
    echo $! > "$install_root/vision.pid"
fi

ready="false"
for _ in $(seq 1 40); do
    if "$vision_root/.venv/bin/python" -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:7870/health", timeout=2)' >/dev/null 2>&1; then
        ready="true"
        break
    fi
    sleep 0.25
done
if [[ "$ready" != "true" ]]; then
    echo "KREA2 Vision did not become healthy. See $vision_root/logs/vision_uvicorn.stderr.log" >&2
    exit 1
fi

cat <<EOF
KREA2 Vision Suite is installed for $platform.
Backend: http://127.0.0.1:7870/health
Plugin:  $plugin_target
Mode:    Online API (no local GPU required)
Models:  $model_root

Restart Discord completely, enable Krea2DiscordCollector in BetterDiscord,
then allow the Discord server you want to use from the plugin settings.
EOF
