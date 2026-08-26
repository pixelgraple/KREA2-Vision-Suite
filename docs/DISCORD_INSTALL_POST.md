# KREA2 Vision Suite for Discord

KREA2 Vision Suite adds image interrogation directly to Discord. It analyzes an image and generates three detailed, grounded prompts using local Vision models. It includes a live queue, prompt history, exact model reporting, model selection, and an Interrogate tab for uploading images manually.

## System requirements

- Windows 10 or Windows 11
- Discord Stable
- A current NVIDIA graphics driver
- At least 25 GB of free disk space for the recommended 8B model
- An internet connection during installation

## 1. Install BetterDiscord

Download BetterDiscord only from the official website:

https://betterdiscord.app/

Close Discord, run the BetterDiscord installer, select **Install BetterDiscord**, choose **Discord Stable**, and finish the installation. Restart Discord when prompted.

BetterDiscord is an unofficial Discord modification. Review its documentation and Discord's current terms before installing it:

https://docs.betterdiscord.app/users/getting-started/installation
https://docs.betterdiscord.app/users/getting-started/faq

## 2. Install KREA2 Vision Suite

Download the complete Windows ZIP below. Do not download only the `Krea2DiscordCollector.plugin.js` file: the plugin requires the included local Vision backend and model runtime.

Before extracting it, right-click the ZIP, select **Properties**, enable **Unblock**, and select **Apply**. Then extract it and double-click `START HERE - INSTALL.bat`.

https://github.com/pixelgraple/KREA2-Vision-Suite/raw/main/releases/Krea2VisionSuite-v0.13.23-win64.zip

The installer will:

- Install or repair BetterDiscord if necessary
- Install the KREA2 Discord plugin
- Install the local Vision backend and required runtime
- Download and verify the recommended Qwen3-VL 8B Heretic model
- Create Start and Repair shortcuts
- Configure automatic startup
- Restart Discord when installation is complete

Large model downloads can take some time. Interrupted downloads can be resumed by running the Repair shortcut.

## 3. Configure the plugin

Open Discord and go to:

**User Settings > BetterDiscord > Plugins**

Enable **Krea2DiscordCollector**.

Complete the first-run disclosure, select **Local GPU**, and choose a Vision model. The 8B Heretic model is recommended. Smaller 2B and 4B models are available for computers with less VRAM.

Open the Discord server where the plugin should operate and select **Allow current server** in the plugin setup.

To use the plugin:

- Hover over an image and click the magnifier button to describe it.
- Open Prompt History to view queued, running, and completed jobs.
- Open **Prompt History > Interrogate** to upload an image manually.
- Multiple images may be queued and will process automatically.

## Privacy and dataset notice

Full-resolution source images are not uploaded as part of dataset contribution. If the user enables automatic contribution during setup, successful generated prompt text is submitted to the Krea2 dataset under the disclosure shown during setup. Discord usernames, Discord URLs, filenames, local paths, image hashes, and source image bytes are not included. If contribution is disabled, no generated prompt is submitted.

Privacy-minimal operational error reporting is required so GPU, model, launch, and transport failures can be repaired across installations. It sends only an anonymous installation digest, model/pipeline, sanitized error/stage, runtime, and versions; it never sends images, image hashes, prompts, Discord identity, URLs, filenames, or local paths. Rich failure diagnostics are a different, default-off option with a separate disclosure and may include a failed image, Discord username, and partial prompt only after explicit consent.

If installation fails or a required service stops, run **Repair KREA2 Vision Suite** from the desktop.

Project source and documentation:

https://github.com/pixelgraple/KREA2-Vision-Suite
