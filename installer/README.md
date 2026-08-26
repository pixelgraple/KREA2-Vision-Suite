# Windows installer and repair center

Run `Krea2VisionSuite-Installer.cmd` from an extracted release or cloned repository.

For a normal installation, extract the complete release and double-click `..\START HERE - INSTALL.bat`. Do not copy only the `.plugin.js` file: BetterDiscord is the interface, and the local Vision backend performs model inference.

The installer:

- shows all ten pinned 2B–32B model choices, VRAM estimate, separate 4,096 MiB reserve, admission requirement, Heretic/uncensored note, and exact model-card links;
- detects or installs Discord Stable, the official BetterDiscord CLI/runtime, Python 3.12, and Ollama through `winget`;
- backs up and installs the generated BetterDiscord plugin;
- installs or repairs the backend-only Vision service while preserving `.env`, models, logs, and its virtual environment;
- creates private loopback Vision and Forge-handoff tokens and writes the matching plugin/service configuration automatically;
- installs the pinned, hash-verified llama.cpp runtime, automatically downloads the recommended 8B Heretic body/projector pair by default, and verifies all model files it finds;
- installs and verifies the pinned `babegen-prompter:9b-q5` Ollama model;
- creates desktop Start/Repair BAT files and a hidden Windows-login launcher that starts Ollama compatibility and the Vision backend only when needed;
- starts the backend and verifies its loopback health, selected Vision model, startup registration, and installed plugin SHA-256.

The installer clearly announces the default 8B download before network work begins. Downloads use immutable Hugging Face revisions, resumable `.partial` files, exact byte lengths, and pinned SHA-256 values; existing verified files are reused. Use `-Model 4B` (or another listed ID) for a different automatic pair, `-Model Ask` for an interactive choice, or `-Model None` to skip Vision-model downloads. Rerun the desktop Repair shortcut after an interrupted installation or download, or use `-Mode PluginOnly` to reinstall only BetterDiscord's plugin file.

The public plugin contains no update checker, downloader, or installer. Publish a complete versioned ZIP and its checksum, then have users run the installer from that ZIP manually. The installer preserves verified model files, local settings, and the Discord session where possible.

`-PlanOnly -Model 8B` performs a read-only prerequisite/model plan. Logs and the final non-secret installation receipt are stored under `%LOCALAPPDATA%\Krea2VisionSuite`.
