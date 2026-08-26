# KREA2 Vision Suite

## Start here: what this does

KREA2 Vision Suite adds an image-description tool to Discord. Install BetterDiscord, install this plugin, choose which Discord servers may use it, and then click the magnifier in the top-right corner of an image. KREA2 Vision examines that image and gives you three detailed prompts you can use to recreate a similar image in Krea2 or another image generator.

During first-run setup, choose one of two Vision modes:

- **Local GPU Vision** runs a Heretic vision-language model (VLM) on your own NVIDIA GPU. The installer downloads the selected model once, then your image analysis runs from your computer.
- **Online Cloud Vision** sends the image securely to the KREA2 online Vision service, which runs the pinned Heretic model in the cloud. This is useful when you do not have enough GPU VRAM for a local model.

The plugin setup itself is designed to take about a minute. A local model download can take longer, depending on the model size and your internet connection. Once setup is complete, every image in a Discord server that you explicitly allow gets a magnifier action. You can queue several images, watch their progress in Prompt History, see the exact model used for each result, or open **Interrogate** to upload an image manually.

KREA2 Vision Suite is in beta. It is already useful, but bugs and occasional errors can still happen while the project is being improved. Join the new community server for updates, help, and bug reports: [discord.gg/gdxCYCWd8g](https://discord.gg/gdxCYCWd8g).

KREA2 Vision Suite is a free, open-source Windows application that adds detailed image interrogation to Discord through BetterDiscord. Select an image, choose a supported local or remote Vision model, and receive three distinct, evidence-grounded image-generation prompts.

The project is local-first. The BetterDiscord plugin talks to a private Vision service on `127.0.0.1:7870`; local models run on the user's own NVIDIA GPU. Seedframe prompt contribution, KREA2 guidance, and rich failure attachments are separately disclosed and controlled. Privacy-minimal operational error reporting is required so launch and GPU-capacity failures can be repaired across installations.

The **Online API** is an optional alternative for users who do not want to run a large Vision model on their own GPU. Local GPU mode remains account-free. On first Online API use, the plugin opens Discord's OAuth sign-in with only the `identify` scope. The KREA2 gateway verifies the account with Discord, issues a revocable remote license bound to that account and local installation, and grants 120 introductory credits. Online Vision reserves three credits once per image, regardless of its internal evidence passes; it charges those credits only after the completed image audit and automatically refunds them when the image fails or is cancelled. Additional credits are sold as 1,200 credits for $20 USD paid in Bitcoin (400 successful images); BTCPay quotes the Bitcoin amount at checkout. The plugin never receives a Discord password, BTCPay API key, gateway Discord client secret, or worker credential. For each image, the plugin exchanges its license through a short-lived, request-bound, one-use local session. The local service then sends the image over HTTPS to the private KREA2 gateway, which checks both license and available credits before it forwards the request to the configured Vast Serverless worker. The gateway currently pins Gemma 4 26B-A4B Heretic on a 24 GB GPU. Selecting Online API disables local execution for that request; the completed job records the exact remote model that actually ran.

Online inference means the selected image and bounded request metadata must leave the user's PC. The included worker is designed to process that content in memory, return the three generated prompts, and avoid intentionally writing images or prompts to worker disk. It can recruit up to five workers when demand increases and stop active GPU compute after the configured eight-second idle window. Dataset contribution and rich failure attachments are separate settings with their own disclosures; enabling Online API does not automatically enable either one. Privacy-minimal technical error reporting remains active in every mode and never contains an image, image hash, prompt, Discord identity, URL, filename, or local path.

> BetterDiscord is an unofficial Discord client modification. Review [BetterDiscord's documentation](https://docs.betterdiscord.app/users/getting-started/installation) and Discord's current terms before using it. Consider using a separate Windows account, virtual machine, and nonessential Discord account if you want stronger isolation.

## Contents

- [What it does](#what-it-does)
- [Download and install](#download-and-install)
- [How the Vision pipeline works](#how-the-vision-pipeline-works)
- [How the three prompts are written](#how-the-three-prompts-are-written)
- [Optional eight-example KREA2 guidance](#optional-eight-example-krea2-guidance)
- [Optional Seedframe contribution](#optional-seedframe-contribution)
- [Privacy and diagnostics](#privacy-and-diagnostics)
- [Models and hardware](#models-and-hardware)
- [Repository map](#repository-map)
- [Development and testing](#development-and-testing)
- [Security](#security)
- [License](#license)

## What it does

- Adds a magnifier action to supported Discord image attachments.
- Adds an **Interrogate** tab for uploading an image manually.
- Queues multiple jobs and reports queued, running, completed, and failed work.
- Shows the exact requested and completed model for every result.
- Produces three different prompts that reconstruct the same visible image with balanced, subject/pose, and scene/light emphasis.
- Audits subject count, pose, visible anatomy, clothing, expression, camera placement, lighting, and scene layout before returning prompts.
- Supports local llama.cpp multimodal models and an optional operator-configured Vast Serverless worker.
- Provides optional KREA2 writing-style guidance, local likes/dislikes, and optional prompt contribution.
- Checks for signed, hash-verified suite updates and repairs BetterDiscord after Discord client updates.

The supported product is intentionally focused on Discord image interrogation. The older Prompt Assistant and photo-editing experiments are not part of the installed release.

## Download and install

### Recommended PowerShell installer

Open **Windows PowerShell**, paste this command, and press Enter:

```powershell
$p="$env:TEMP\Install-KREA2VisionSuite.ps1"; Invoke-WebRequest "https://raw.githubusercontent.com/pixelgraple/KREA2-Vision-Suite/main/Install-KREA2VisionSuite.ps1" -OutFile $p; powershell -NoProfile -ExecutionPolicy Bypass -File $p
```

The bootstrap downloads the stable manifest and release, verifies the exact byte count and SHA-256, and starts the guided installer without copying browser Mark-of-the-Web metadata into every extracted script.

### Manual package

Download [Krea2VisionSuite-v0.13.18-win64.zip](releases/Krea2VisionSuite-v0.13.18-win64.zip), right-click the ZIP, choose **Properties**, enable **Unblock**, apply the change, extract it, and run:

```text
START HERE - INSTALL.bat
```

Do not install only `Krea2DiscordCollector.plugin.js`. The complete package contains the BetterDiscord plugin, private loopback broker, Vision backend, model runtime installer, startup tasks, updater, and repair tools.

The installer can:

1. install or repair BetterDiscord for the current Discord Stable version;
2. install Python and the isolated Vision environment;
3. install the pinned llama.cpp CUDA runtime;
4. download and hash-verify the recommended Qwen3-VL 8B Heretic model and projector;
5. install the BetterDiscord plugin;
6. generate private local credentials;
7. create Start and Repair shortcuts;
8. configure hidden login startup;
9. health-check the local service before opening Discord.

See [Windows installation](docs/INSTALL_WINDOWS.md), [friend quick start](docs/QUICK_START_FRIENDS.md), and [troubleshooting](docs/TROUBLESHOOTING.md).

## How the Vision pipeline works

KREA2 does not ask a model for one casual caption. It builds and audits structured visual evidence first.

```text
Discord image or Interrogate upload
             |
             v
Attachment validation + one-use local session
             |
             v
Shared GPU FIFO and VRAM admission check
             |
             v
Validated in-memory image + detail crops
             |
             v
Subject evidence -> scene evidence -> visual-craft evidence -> pose evidence
             |
             v
Pose verification + reconstruction audit
             |
             v
One image-grounded draft
             |
             v
Final image audit
             |
             v
Three distinct 350-850 word prompts
```

The evidence contract requires the model to distinguish observation from inference. It records:

- every visible participant with stable Subject A/B/C labels;
- presentation and directly visible anatomy as separate facts, without inferring identity;
- face geometry, gaze, eye openness/color, brows, nose, lips, expression, freckles, makeup, and visible marks;
- hair color, roots, texture, length, parting, style, wetness, and loose strands;
- each visible arm and leg, joint bends, hand placement, foot/knee/hip support, torso pitch, spine, pelvis, head, and neck;
- standing, sitting, kneeling, crouching, reclining, or uncertain support state only when visible geometry proves it;
- garments and accessories by body region, including exact visible placement;
- foreground, midground, background, props, weather, architecture, and spatial relationships;
- shot scale, apparent distance, camera height/angle, crop boundaries, focus, lighting, material texture, and color.

Crop boundaries are evidence boundaries. If the pixels needed to prove a posture, garment, support surface, or anatomy claim are outside the frame, the pipeline marks that fact uncertain instead of inventing it.

Full details are in [Vision and prompting](docs/VISION_AND_PROMPTING.md) and [architecture](docs/ARCHITECTURE.md).

## How the three prompts are written

Modern Qwen3-VL and Gemma Heretic models perform both visual analysis and final prompt writing. Their final writing stage receives the merged evidence, pose verification, reconstruction audit, optional guidance, and strict output contract. It must return exactly three natural-language prompt variants:

1. **Balanced reconstruction** — distributes attention across subject, pose, camera, scene, and light.
2. **Subject and pose** — gives additional wording priority to participant geometry, expression, wardrobe, and contact points.
3. **Scene and light** — gives additional wording priority to composition, environment, materials, atmosphere, and lighting.

The three prompts may vary in sentence rhythm and emphasis, but they must describe the same image. A validator rejects malformed JSON, refusals, negative prompts, duplicated variants, unsupported facts, overly short output, and LoRA syntax enclosed in angle brackets. A bounded repair or per-variant fallback can recover usable model output without discarding the audited image evidence.

The optional `babegen-prompter:9b-q5` model exists only for the explicitly selected legacy compatibility route. Modern Qwen/Gemma Vision output is not automatically rewritten by that legacy prompter.

## Optional eight-example KREA2 guidance

This feature is **off by default**.

When enabled, each job reads the current approved KREA2 text dataset and randomly selects exactly eight unique prompt examples. These are prompt texts, not source images. The model is instructed to use them only for:

- wording rhythm;
- detail order and density;
- sentence and paragraph structure;
- layout conventions;
- KREA2-compatible prompt style.

The target is approximately 60% resemblance to the examples' writing structure and 40% fresh composition, while remaining 100% grounded in the current image evidence. Example people, anatomy, clothing, objects, actions, and settings may never leak into the new prompt.

The sample identity and dataset revision are included in cache/idempotency keys. A disliked eight-example combination is blocked from reuse even if the same examples are returned in a different order. Up to four locally liked prompts and three locally disliked prompts plus plain-English dislike reasons can guide later jobs. The model receives those preferences as style feedback, never as image facts.

See [KREA2 guidance and data](docs/KREA2_GUIDANCE_AND_DATA.md).

## Optional Seedframe contribution

Prompt contribution is separate from guidance and is controlled by a disclosed plugin setting.

When **Automatically contribute my three generated prompts to KREA2** is enabled and the current terms are accepted, a successful job submits:

- the three generated prompt texts;
- the completed model identifier;
- the pipeline identifier;
- bounded anonymous provenance and an idempotency digest.

It does **not** submit the source image, Discord username, Discord URL, filename, local path, or image hash. Contributions remain candidates until separately reviewed/curated in Seedframe. Turning contribution off does not disable Vision or eight-example read-only guidance.

## Privacy and diagnostics

There is no advertising telemetry, behavioral analytics, contact list collection, message scraping, or routine upload of Discord content.

| Feature | Default | Leaves the PC? | Data involved |
|---|---:|---:|---|
| Local Vision inference | On | No | Request image and generated prompts are processed by the local service |
| Prompt History | Local | No | Paginated local SQLite job/prompt history plus 640 px previews, retained until **Clear history**; no full-resolution source-image cache |
| Eight-example KREA2 guidance | Off | Yes, read-only | Eight approved prompt texts and opaque sample metadata are fetched from Seedframe |
| KREA2 prompt contribution | User choice | Yes | Three generated prompt texts plus bounded model/pipeline provenance; no image or Discord identity |
| Vast Online API | Off/operator-configured | Yes | Requires one Discord OAuth `identify` sign-in; image and request metadata are sent to the licensed KREA2 gateway and configured worker for inference; the worker is designed for memory-only processing |
| Operational error reports | Required | Yes | Anonymous installation digest, model/pipeline, stage, error code/message, runtime, and software versions; no image, image hash, prompt, Discord identity, URL, filename, or path |
| Rich failure attachments | Off/separate consent | Yes | A failed image, partial prompt, Discord username, model/stage/status, error details, and bounded identifiers may be sent to Seedframe for debugging |

The suite does not persist uploaded full-resolution images, feedback examples, or exports. Request-scoped processing files are deleted before a request completes. Prompt History intentionally persists generated prompt text and sanitized job metadata in a private local SQLite database, plus small preview thumbnails in the user's configured folder, until the user selects **Clear history**. The history database excludes source-image bytes, Discord IDs/URLs, tokens, queue secrets, raw evidence, and full local paths.

Automatic operational errors are mandatory, bounded, and privacy-minimal. They first use the authenticated loopback broker; if that broker cannot deliver the report, the plugin can submit the same digest-bound technical record directly to the canonical Seedframe receiver. Failed delivery stays only in a bounded in-memory retry queue and is never written to disk. Rich failure attachments are deliberately separate because they can contain user data, and remain disabled unless the user accepts their additional disclosure. Never attach real rich diagnostic payloads to public GitHub issues.

See [Privacy and diagnostics](docs/PRIVACY_AND_DIAGNOSTICS.md) for the complete data-flow explanation.

## Models and hardware

The installer displays model parameter size, quantization, expected download size, conservative VRAM allocation, measured peak where available, a separate 4,096 MiB safety reserve, and admission requirement.

The recommended default is Qwen3-VL 8B Heretic for users near a 12 GiB model-allocation target. Smaller 2B and 4B choices reduce memory pressure; larger Gemma/Qwen/GLM variants require substantially more VRAM or an optional 24 GB remote worker.

Model bodies and multimodal projectors are downloaded from their original model repositories and hash-verified. They are not relicensed under MIT and are not embedded as source files in this repository. Review each model card and license before downloading.

See [models and VRAM](docs/MODELS.md).

## Queue and GPU ownership

Local Discord jobs use the same FIFO handoff as configured Forge/KREA work. Discord processes exactly one image per queue turn and releases the ticket immediately. It may keep a selected model warm for up to 15 seconds only while the shared GPU is idle. Any non-Discord ticket cancels the warm window and evicts the model before the waiting work runs.

A Discord image that cannot begin GPU submission or acquire the shared GPU within 30 seconds becomes a visible terminal error reading **GPU not available**. It is removed from the active queue, does not block later submissions, and emits a privacy-minimal operational report. Other failures show their sanitized actionable error instead of remaining indefinitely queued.

The optional Vast worker may scale from zero to five workers. `min_load=0` avoids paying for permanently idle GPU compute. The deployed eight-second idle timeout lets a worker finish its current request before active compute scales down; one cold worker may retain model storage for faster wake-up, so storage charges can remain while GPU compute is stopped.

## Repository map

```text
betterdiscord-plugin/     BetterDiscord source, generated plugin, parser, and tests
installer/                Windows install, update, repair, startup, and health checks
vision-studio/            FastAPI loopback broker and Vision pipeline
vast-serverless-gemma26/  Optional 24 GB GPU worker container
docs/                     Product, privacy, architecture, model, and setup documentation
releases/                 Current verified Windows release and stable manifest
scripts/                  Release builder and verification automation
.github/                  Release workflow and public issue templates
```

## Development and testing

Requirements for development:

- Windows 10/11 for installer and live BetterDiscord testing;
- Python 3.12;
- Node.js for plugin build/tests;
- an NVIDIA GPU for real local model validation.

Run the backend suite:

```powershell
cd vision-studio
python -m unittest discover -s tests -v
```

Run plugin checks:

```powershell
cd betterdiscord-plugin
node .\build-inline-plugin.js
node .\Krea2DiscordCollector.test.js
node --test .\Krea2DiscordCollector.dataset-guidance.test.js
node --test .\Krea2DiscordCollector.feedback.test.js
node --test .\parser\png-prompt-metadata.test.js
node --check .\Krea2DiscordCollector.plugin.source.js
node --check .\Krea2DiscordCollector.plugin.js
```

Build a release:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Build-Release.ps1
```

Every published release must keep source, generated plugin, ZIP, checksum, and `releases/latest.json` in the same commit. See [release and updates](docs/RELEASE_AND_UPDATES.md) and [contributing](CONTRIBUTING.md).

## Security

- The supported local broker binds only to literal loopback.
- A random long-lived token is used only to obtain short-lived, request-bound, one-use image sessions.
- BetterDiscord never receives the operator's Vast account API key.
- Remote license and Discord audit-webhook credentials live only in the HTTPS gateway, never in the plugin or release ZIP. A revoked remote license is denied before a worker receives its next request; local-only use remains under the user's control.
- Model/runtime downloads are pinned and hash-verified.
- Update installation accepts only the pinned repository location, expected byte count, and SHA-256.
- `.env`, tokens, model files, runtime receipts, logs, images, prompts, databases, caches, and deployment snapshots are excluded from source control.

Do not expose port `7870` directly to a LAN or the internet. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Third-party software

KREA2 Vision Suite integrates with independently licensed projects and models, including BetterDiscord, Discord, llama.cpp, Ollama, Qwen, Gemma, GLM, Hugging Face model repositories, Vast.ai, and Seedframe. Their names do not imply endorsement. Their software, services, model weights, and terms remain governed by their respective licenses and policies.

## License

KREA2 Vision Suite source code is available under the [MIT License](LICENSE).

Copyright (c) 2026 uroligh.
