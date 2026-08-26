# KREA2 Vision Suite: friend quick start

KREA2 Vision Suite adds a private Vision magnifier, an Interrogate upload tab, a live queue, and three detailed prompt variations inside Discord.

## Install

1. Use Windows 10 or 11 with a current NVIDIA driver and at least 25 GB of free disk space for the recommended 8B installation.
2. Open **Windows PowerShell**, paste the command below, and press Enter. It downloads the complete release, verifies its size and SHA-256, and starts setup without propagating browser SmartScreen metadata:

   ```powershell
   $p="$env:TEMP\Install-KREA2VisionSuite.ps1"; Invoke-WebRequest "https://raw.githubusercontent.com/pixelgraple/KREA2-Vision-Suite/main/Install-KREA2VisionSuite.ps1" -OutFile $p; powershell -NoProfile -ExecutionPolicy Bypass -File $p
   ```

3. Accept the clearly listed program and model downloads. Do not download only the `.plugin.js` file.
4. Let setup install or repair Discord Stable, BetterDiscord, Python, Ollama, the local Vision backend, and the recommended Qwen3-VL 8B Heretic model pair.
5. When Discord opens, enable **Krea2DiscordCollector** under **User Settings → BetterDiscord → Plugins** if prompted.
6. Open a server channel, complete the first-run disclosure, choose **Local GPU**, and allow the current server.
7. Click the magnifier on an image, or open **Prompt History → Interrogate** to upload one. You can queue multiple images; each enters the shared FIFO and runs one at a time.

Manual ZIP alternative: download the complete [v0.13.16 ZIP](https://raw.githubusercontent.com/pixelgraple/KREA2-Vision-Suite/main/releases/Krea2VisionSuite-v0.13.16-win64.zip), right-click the ZIP, select **Properties**, enable **Unblock**, and select **Apply before extracting it**. Then extract it and run **`START HERE - INSTALL.bat`**. If the ZIP was already extracted while blocked, delete only that extracted copy, unblock the original ZIP, and extract it again.

If setup is interrupted, double-click **Repair KREA2 Vision Suite.bat** on the desktop. The installer resumes verified downloads instead of starting them over.

The plugin checks the official stable release manifest shortly after startup and every six hours. Its default setting shows a one-click **Install update** prompt. Users who prefer unattended maintenance can select **Install verified updates automatically** under the plugin's KREA2 Vision Suite update setting. Active Vision jobs finish before the matching plugin/backend update begins.

## What to expect

- The recommended 8B model needs an admission target of 17,408 MiB free VRAM, including the separate 4,096 MiB reserve. Smaller 2B and 4B choices are available in setup.
- Prompt History refreshes queued and running jobs every second and shows the exact model that completed each result.
- Each completed image produces three grounded prompt variations.
- Pose is checked twice against the image before the three final prompts are returned, including support contacts, limb paths, torso bend, head/neck direction and camera-relative proof.
- Full-resolution images and prompt text are not cached locally. A bounded 640 px thumbnail cache preserves Prompt History previews.
- Successful prompt text is contributed to the Krea2 dataset under the disclosure shown during first-run setup; image bytes and Discord identifiers are not uploaded with that contribution.
- Required privacy-minimal operational errors send only an anonymous installation digest, model/pipeline, sanitized error/stage, runtime, and software versions. They never send images, image hashes, prompts, Discord identity, URLs, filenames, or local paths. Optional rich failure diagnostics remain separate and off by default; after explicit disclosure they may include the failed image, Discord username, and an available partial prompt for owner-only maintenance.

## Online API

Online API is an operator feature, not a shared key embedded in the release. It is selectable only when the local Vision broker reports a privately configured remote worker. Friends should use Local GPU unless they operate their own endpoint or the project later provides a central account-based gateway.

## Important BetterDiscord notice

BetterDiscord is an unofficial Discord client modification. Review the current BetterDiscord installation guide and FAQ before installing it:

- https://betterdiscord.app/
- https://docs.betterdiscord.app/users/getting-started/installation
- https://docs.betterdiscord.app/users/getting-started/faq

Project source, checksums, security policy, and advanced setup documentation are at:

- https://github.com/pixelgraple/KREA2-Vision-Suite
