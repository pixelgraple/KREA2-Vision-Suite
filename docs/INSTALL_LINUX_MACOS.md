# Linux and macOS installation

KREA2 Vision Suite supports Discord image interrogation on Linux and macOS through the same BetterDiscord plugin and literal-loopback Vision broker used on Windows. The portable installer defaults to **Online API**, so an NVIDIA GPU, CUDA, Forge, and local model download are not required.

## Support level

| Capability | Linux | macOS |
|---|---:|---:|
| BetterDiscord image magnifier, Prompt History, metadata/YAML extraction, and Qwen Prompt Editor | Supported | Supported |
| Online API image interrogation | Supported | Supported |
| Local Ollama or llama.cpp Vision | Manual/advanced | Experimental/manual |
| Shared Forge/KreaForge GPU handoff | Manual configuration | Not applicable |
| One-click native desktop installer | Shell installer | Shell installer |
| Automatic suite updater | Manual update | Manual update |

Windows retains the most automated installer and the fully verified local CUDA/Forge workflow. Linux local inference can use a native executable named `llama-server`; macOS users should prefer Online API unless they are comfortable validating an Ollama or Metal llama.cpp configuration themselves.

## Prerequisites

1. Discord Stable and BetterDiscord installed for the current user.
2. Python 3.11 or newer with `venv` support.
3. Node.js is needed only for development tests, not normal use.
4. A complete KREA2 Vision Suite checkout or extracted release.

Review BetterDiscord's current installation instructions before modifying Discord: <https://docs.betterdiscord.app/users/getting-started/installation>

## Install

From the repository root:

```bash
chmod +x installer/Install-Krea2VisionSuite.sh installer/Start-Krea2VisionSuite.sh
./installer/Install-Krea2VisionSuite.sh
```

The installer:

- copies the Vision backend into the user data directory;
- creates an isolated Python virtual environment;
- installs the generated single-file BetterDiscord plugin;
- creates one private local broker token and stores it only in the backend and BetterDiscord configuration;
- selects Online API and V2 Direct Fidelity by default;
- uses `~/Pictures/Krea2Vision` as the portable save folder;
- starts the loopback service and requires `http://127.0.0.1:7870/health` to succeed.

Default locations:

| Platform | Application data | BetterDiscord plugin |
|---|---|---|
| Linux | `${XDG_DATA_HOME:-~/.local/share}/Krea2VisionSuite` | `${XDG_CONFIG_HOME:-~/.config}/BetterDiscord/plugins` |
| macOS | `~/Library/Application Support/Krea2VisionSuite` | `~/Library/Application Support/BetterDiscord/plugins` |

Override the application location with `KREA2_INSTALL_ROOT=/absolute/path` and Python with `PYTHON=/absolute/path/to/python3`.

After installation, restart Discord completely, enable **Krea2DiscordCollector**, open its settings, and allow the Discord server where magnifier actions should appear.

## Start again later

Linux:

```bash
"${XDG_DATA_HOME:-$HOME/.local/share}/Krea2VisionSuite/Start-Krea2VisionSuite.sh"
```

macOS:

```bash
"$HOME/Library/Application Support/Krea2VisionSuite/Start-Krea2VisionSuite.sh"
```

The service binds only to `127.0.0.1:7870`. Do not expose it on a LAN address.

## Optional local inference

Linux users may set `QWEN_BACKEND=ollama` for an installed Ollama vision model, or configure `LLAMA_CPP_SERVER_EXE` with an executable native `llama-server` plus the exact hash-verified model/projector files. Set `STUDIO_USE_SHARED_GENERATION_QUEUE=true` only if the other local generator uses the same queue protocol and token.

macOS local inference is not part of the verified release matrix yet. The Python broker is portable, but local model VRAM admission and the current model measurements are NVIDIA-oriented. Online API is the supported macOS path.

## Updates

Linux and macOS updates are manual: fetch/extract the new complete release and rerun `Install-Krea2VisionSuite.sh`. The script preserves the existing `.env`, local token, history database, and plugin settings. The in-app Windows updater is intentionally not invoked on other platforms.
