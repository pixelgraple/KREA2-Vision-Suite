# Troubleshooting

## BetterDiscord disappeared after Discord restarted

Discord client updates can create a new `app-*` directory and remove the previous BetterDiscord injection. Run **Repair KREA2 Vision Suite** from the desktop. The installer checks the active Discord version and reinjects BetterDiscord when needed; the plugin file itself is normally still present.

## Windows SmartScreen blocks the installer

Use the recommended PowerShell bootstrap from the README. For a manually downloaded ZIP, right-click it, choose **Properties**, enable **Unblock**, apply the change, and then extract it. Do not disable SmartScreen globally.

## HTTP 503 or local Vision unavailable

Run **Start KREA2 Vision Suite** or **Repair KREA2 Vision Suite**. Confirm `http://127.0.0.1:7870/health` reports healthy. The supported service is loopback-only; do not change it to a public bind address.

## Job waits for the GPU

The local provider shares a FIFO with configured Forge/KREA work. Local Vision remains queued until its turn or until you cancel it; a wait longer than 30 seconds is normal when Forge or KreaForge is ahead. At queue head, Vision pauses/unloads both configured Forge endpoints and resident Ollama models, runs the complete job under the lock, unloads, and yields. Check the displayed queue owner if progress stops changing, and do not start an independent second Vision service to bypass the queue. **GPU not available** is reserved for a real post-handoff capacity failure or bounded Online API worker-capacity failure.

## Model does not appear

A model appears only when its exact body and matching multimodal projector are installed and pass catalog validation. Quantization-specific files are not interchangeable. Use the plugin model installer or Repair, then refresh model status.

## Prompt output is malformed or unusable

Retry with the exact model shown in the result. The backend has bounded formatting repair and per-variant fallback, but a model can still fail. Privacy-minimal operational details are reported automatically. Optional rich diagnostics can additionally attach the failed image and partial prompt after separate consent. For public GitHub reports, use only a synthetic or redacted reproduction.

## Thumbnail is blank

The plugin stores only a bounded local preview, not the full-resolution source. Check that the configured preview folder exists and is writable. A result created before thumbnail caching cannot reconstruct a deleted source image.

## Updating the suite

The plugin intentionally has no automatic updater. Download a complete release ZIP from GitHub Releases, verify the published checksum when available, extract it, and run **`START HERE - INSTALL.bat`**. Use Repair only for a damaged local installation.
