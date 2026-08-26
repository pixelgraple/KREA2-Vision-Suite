# Windows installation

## Normal installation: one guided setup

1. Download the complete [v0.13.26 Windows ZIP](https://github.com/pixelgraple/KREA2-Vision-Suite/raw/main/releases/Krea2VisionSuite-v0.13.26-win64.zip). Do not download only `Krea2DiscordCollector.plugin.js`.
2. Right-click the ZIP, select **Properties**, enable **Unblock**, select **Apply**, and only then extract it.
3. Double-click **`START HERE - INSTALL.bat`** in the extracted folder.
4. Accept the clearly listed program and model downloads. The default Vision choice is **Qwen3-VL 8B Heretic Q8_0**.
5. When Discord reopens, enable `Krea2DiscordCollector` if BetterDiscord asks, open a server channel, and use the first-run window to allow that server.
6. Click the magnifier on a Discord image. Prompt History shows the queue immediately, refreshes its rail every five seconds, and refreshes an open job every second.

## Manual updates

The BetterDiscord plugin does not check for, download, or install updates. When a new release is announced, download the complete Windows ZIP from the official GitHub Releases page, verify its published SHA-256 when available, extract it, and run **`START HERE - INSTALL.bat`**. Existing models and settings are preserved.

The installer needs a network connection, Windows 10/11, `winget` (Windows App Installer), and a supported NVIDIA GPU with a current driver. It installs missing user-scoped copies of:

- Discord Stable;
- the official BetterDiscord CLI and BetterDiscord Stable runtime;
- Python 3.12;
- Ollama;
- an isolated Python environment for the backend-only Vision service;
- pinned llama.cpp CUDA runtime files;
- the pinned Ollama compatibility composer used by the optional legacy model path;
- the recommended 8B Heretic Vision body and matching projector.

Every runtime/model download is pinned to an immutable source revision and accepted only after its exact byte length and SHA-256 match. Existing verified files are reused and interrupted `.partial` downloads resume.

## What setup configures automatically

Setup installs the suite under `%LOCALAPPDATA%\Krea2VisionSuite`, while Vision GGUF pairs live under `%USERPROFILE%\Documents\KreaHereticModels`. It:

- generates a private 32+ byte Vision token and writes the same value into Vision Studio and BetterDiscord's local configuration;
- generates the shared machine-local Forge handoff credential and configures the Vision backend;
- binds the Vision backend to `127.0.0.1:7870` and Ollama compatibility to its normal `127.0.0.1:11434` API;
- installs the BetterDiscord plugin and preserves existing plugin settings when updating;
- creates **Start KREA2 Vision Suite.bat** and **Repair KREA2 Vision Suite.bat** on the desktop;
- creates a hidden Windows-login shortcut that starts Ollama compatibility and the Vision backend only when needed;
- starts the backend and verifies health, the selected Vision model, plugin hash, compatibility model, and startup registration.

The only routine setup choice intentionally left to each Discord user is which server IDs may show image actions. The first-run window offers the current verified server as a checkbox.

## Models and VRAM

The setup window lists all ten supported choices from 2B through 32B. It shows current free/total VRAM, conservative model allocation, measured peak when available, a separate 4,096 MiB safety reserve, and the final admission requirement. Larger models are not assumed to fit merely because the GGUF file fits on disk.

The default 8B estimate is 13,312 MiB plus the 4,096 MiB reserve. It exceeds the project's 12 GiB model-allocation target but remains selectable when the authoritative post-Forge-unload check passes. The 12B choices use a 20,992 MiB estimate plus reserve.

Heretic/uncensored weights are designed to reduce model-level refusals. KREA2 still retains local input validation, grounded-output/quality checks, shared-GPU admission checks, and security limits. Every model card and exact body/projector download link remains visible in the first-run catalog.

To make a different model the automatic first install choice, open PowerShell in the extracted release and use one of `2B`, `4B`, `8B`, `9B-GLM-Abliterated`, `12B-Opus`, `12B-Heretic`, `26B-A4B-Heretic`, `30B-A3B-Abliterated`, `31B`, or `32B`:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\Install-Krea2VisionSuite.ps1 -Model 4B
```

## Starting and repairing

- Normal Windows login: required local services start hidden automatically.
- Manual start: double-click **Start KREA2 Vision Suite.bat** on the desktop, then use KREA2 inside Discord.
- Interrupted download, missing dependency, or unhealthy service: double-click **Repair KREA2 Vision Suite.bat**.
- If Discord updates itself and BetterDiscord disappears, use that same Repair shortcut. It checks the current Discord Stable app folder and reinjects BetterDiscord without deleting plugin settings.
- Read-only preflight:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\Install-Krea2VisionSuite.ps1 -PlanOnly -Model 8B
```

Runtime logs and the non-secret installation receipt are under `%LOCALAPPDATA%\Krea2VisionSuite`. The receipt intentionally excludes local tokens.

## Optional Online API mode

Online API is the no-local-model option. Select it during setup, approve Discord's minimal `identify` OAuth sign-in in the browser, and return to Discord; the plugin receives a revocable installation-bound license from the central HTTPS gateway and grants 120 introductory credits. Each completed interrogation costs three credits and terminal failures or cancellations are refunded.

The release never bundles the project owner's Vast, Discord, BTCPay, or gateway keys. Do not paste a provider key into a friend's copy. The loopback broker exchanges the user's license for a short-lived, request-bound, one-use session and sends the selected image to the central gateway only when Online API is selected. Bitcoin top-ups remain unavailable until the operator enables and verifies BTCPay.

## Shared Forge/KREA queue

The Vision backend uses `%TEMP%\forge_shared_generation_queue`. Discord takes exactly one image per turn, releases the FIFO immediately, and rejoins at the tail when more Discord work is waiting. Its selected model may remain warm for up to 15 seconds only while the shared GPU is idle. A Forge/KREA/other ticket immediately cancels that warm window and evicts the Vision model before the competing ticket runs.

Local Discord images stay in the shared FIFO until their turn or until the user cancels them; normal Forge/KreaForge contention has no 30-second failure deadline. Once local Vision owns the FIFO head, it keeps Forge/KreaForge paused for the full interrogation, unloads its model, and releases the slot. Online API worker-capacity timeouts remain bounded and appear as **GPU not available**. Other terminal failures show their sanitized provider error. Required privacy-minimal error reporting contains only anonymous technical fields; rich image diagnostics remain a separate opt-in setting.

At the head of a llama.cpp Vision turn, queue-owned handoff asks reachable queue-aware Forge instances to unload and unloads resident Ollama runners before the authoritative VRAM check. Model files and Ollama's installed model list are never deleted.

## Manual/developer installation

Manual setup is supported but is no longer the recommended user path:

1. Install Python 3.11+, Ollama, Discord, BetterDiscord, and a current NVIDIA driver.
2. Run `vision-studio\scripts\install_heretic_llamacpp.ps1 -DownloadModels 8B -VerifyManualModels`.
3. Copy each `.env.example` to `.env`, create private local tokens, and configure the same handoff-token file.
4. Install each `requirements.txt` into its own virtual environment.
5. Start the Vision backend on 7870.
6. Copy the generated plugin into `%APPDATA%\BetterDiscord\plugins` and configure its matching token/endpoint.

Use manual mode only when intentionally changing paths, models, or queue integration. Never expose ports 7870 or 11434 publicly.

## Verification

1. Open the plugin's **Health** panel and confirm backend, model, and queue status.
2. Submit an ordinary Discord image with the magnifier.
3. Confirm it appears immediately in Discord Prompt History.
4. Confirm the selected/requested model is shown while queued and the actual completed model identity is shown after inference.
5. If Forge is active, confirm Vision waits and never runs concurrently.

BetterDiscord is an unofficial Discord modification. Review BetterDiscord's documentation and Discord's current terms before use.
