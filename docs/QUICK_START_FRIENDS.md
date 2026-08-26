# KREA2 Vision Suite: friend quick start

KREA2 Vision Suite adds a private Vision magnifier, an Interrogate upload tab, a live queue, and three detailed prompt variations inside Discord.

## Install

1. Use Windows 10 or 11 with a current NVIDIA driver and at least 25 GB of free disk space for the recommended 8B installation.
2. Download the complete [v0.13.25 Windows ZIP](https://github.com/pixelgraple/KREA2-Vision-Suite/raw/main/releases/Krea2VisionSuite-v0.13.25-win64.zip). Do not download only the `.plugin.js` file.
3. Right-click the ZIP, select **Properties**, enable **Unblock**, select **Apply**, then extract it. If it was already extracted while blocked, delete only that extracted copy, unblock the original ZIP, and extract it again.
4. Double-click **`START HERE - INSTALL.bat`** and accept the clearly listed program and model downloads.
5. Let setup install or repair Discord Stable, BetterDiscord, Python, Ollama, the local Vision backend, and the recommended Qwen3-VL 8B Heretic model pair.
6. When Discord opens, enable **Krea2DiscordCollector** under **User Settings → BetterDiscord → Plugins** if prompted.
7. Open a server channel, complete the first-run disclosure, choose **Local GPU**, and allow the current server.
8. Click the magnifier on an image, or open **Prompt History → Interrogate** to upload one. You can queue multiple images; each enters the shared FIFO and runs one at a time.

If setup is interrupted, double-click **Repair KREA2 Vision Suite.bat** on the desktop. The installer resumes verified downloads instead of starting them over.

To update later, download the next complete Windows ZIP from the project GitHub page, verify the published SHA-256 when available, extract it, and run **`START HERE - INSTALL.bat`** again. The plugin does not check for or install updates automatically.

## What to expect

- The recommended 8B model needs an admission target of 17,408 MiB free VRAM, including the separate 4,096 MiB reserve. Smaller 2B and 4B choices are available in setup.
- Prompt History refreshes its rail every five seconds; an open queued or running job refreshes every second and shows the exact model that completed each result.
- Each completed image produces three grounded prompt variations.
- Pose is checked twice against the image before the three final prompts are returned, including support contacts, limb paths, torso bend, head/neck direction and camera-relative proof.
- Full-resolution images are not copied into history. Generated prompts, sanitized job metadata, and 640 px previews remain locally until the user selects **Clear history**.
- If the user opts in during setup, successful prompt text is contributed to the Krea2 dataset under the shown disclosure; image bytes and Discord identifiers are not uploaded with that contribution.
- Required privacy-minimal operational errors send only an anonymous installation digest, model/pipeline, sanitized error/stage, runtime, and software versions. They never send images, image hashes, prompts, Discord identity, URLs, filenames, or local paths. Optional rich failure diagnostics remain separate and off by default; after explicit disclosure they may include the failed image, Discord username, and an available partial prompt for owner-only maintenance.

## Online API

Online API is available without downloading a local model. Choose **Online API**, approve Discord's minimal `identify` sign-in in the browser, and return to Discord; the plugin finishes setup automatically and grants the new account 120 introductory credits. Each completed image costs three credits, while failed or cancelled jobs are refunded. No shared Vast, Discord, or gateway secret is embedded in the plugin. Bitcoin top-ups remain hidden until the project's BTCPay checkout is enabled and verified.

## Important BetterDiscord notice

BetterDiscord is an unofficial Discord client modification. Review the current BetterDiscord installation guide and FAQ before installing it:

- https://betterdiscord.app/
- https://docs.betterdiscord.app/users/getting-started/installation
- https://docs.betterdiscord.app/users/getting-started/faq

Project source, checksums, security policy, and advanced setup documentation are at:

- https://github.com/pixelgraple/KREA2-Vision-Suite
