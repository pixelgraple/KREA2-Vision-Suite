# Troubleshooting

## BetterDiscord disappeared after Discord restarted

Discord client updates can create a new `app-*` directory and remove the previous BetterDiscord injection. Run **Repair KREA2 Vision Suite** from the desktop. The installer checks the active Discord version and reinjects BetterDiscord when needed; the plugin file itself is normally still present.

## Windows SmartScreen blocks the installer

Use the recommended PowerShell bootstrap from the README. For a manually downloaded ZIP, right-click it, choose **Properties**, enable **Unblock**, apply the change, and then extract it. Do not disable SmartScreen globally.

## HTTP 503 or local Vision unavailable

Run **Start KREA2 Vision Suite** or **Repair KREA2 Vision Suite**. Confirm `http://127.0.0.1:7870/health` reports healthy. The supported service is loopback-only; do not change it to a public bind address.

## Job waits for the GPU

The local provider shares a FIFO with configured Forge/KREA work. Check the queue owner, free VRAM, selected model requirement, and any Ollama/Forge process occupying the GPU. Do not start an independent second Vision service to bypass the queue.

## Model does not appear

A model appears only when its exact body and matching multimodal projector are installed and pass catalog validation. Quantization-specific files are not interchangeable. Use the plugin model installer or Repair, then refresh model status.

## Prompt output is malformed or unusable

Retry with the exact model shown in the result. The backend has bounded formatting repair and per-variant fallback, but a model can still fail. If diagnostics are enabled and consented, the failure can be submitted for private maintenance review. Otherwise report version, model ID, stage, and exact error with a synthetic reproduction.

## Thumbnail is blank

The plugin stores only a bounded local preview, not the full-resolution source. Check that the configured preview folder exists and is writable. A result created before thumbnail caching cannot reconstruct a deleted source image.

## Update does not install

Verify internet access to GitHub, run Repair, and check that no Vision job is active. The updater refuses a ZIP whose repository origin, version, size, or SHA-256 differs from the stable manifest.
