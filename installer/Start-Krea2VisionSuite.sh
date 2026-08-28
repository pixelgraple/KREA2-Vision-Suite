#!/usr/bin/env bash
set -euo pipefail

case "$(uname -s)" in
    Darwin) default_root="$HOME/Library/Application Support/Krea2VisionSuite" ;;
    Linux) default_root="${XDG_DATA_HOME:-$HOME/.local/share}/Krea2VisionSuite" ;;
    *) echo "This launcher supports Linux and macOS. Use START HERE - INSTALL.bat on Windows." >&2; exit 1 ;;
esac

install_root="${KREA2_INSTALL_ROOT:-$default_root}"
vision_root="$install_root/vision-studio"
python_exe="$vision_root/.venv/bin/python"

if [[ ! -x "$python_exe" || ! -f "$vision_root/app/main.py" ]]; then
    echo "KREA2 Vision is not installed at: $vision_root" >&2
    echo "Run installer/Install-Krea2VisionSuite.sh first." >&2
    exit 1
fi

mkdir -p "$vision_root/logs"
cd "$vision_root"
exec "$python_exe" -m uvicorn app.main:app --host 127.0.0.1 --port 7870
