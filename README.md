# KREA2 Vision Suite

[![Cross-platform tests](https://github.com/pixelgraple/KREA2-Vision-Suite/actions/workflows/cross-platform-tests.yml/badge.svg)](https://github.com/pixelgraple/KREA2-Vision-Suite/actions/workflows/cross-platform-tests.yml)
![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows11&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-supported-FCC624?logo=linux&logoColor=111)
![macOS](https://img.shields.io/badge/macOS-supported-000000?logo=apple&logoColor=white)

## Start here: what this does

KREA2 Vision Suite adds an image-description tool to Discord. Install BetterDiscord, install this plugin, choose which Discord servers may use it, and then click the magnifier in the top-right corner of an image. KREA2 Vision examines that image and gives you three detailed prompts you can use to recreate a similar image in Krea2 or another image generator.

During first-run setup, choose one of two Vision modes:

- **Local GPU Vision** runs a Heretic vision-language model (VLM) on your own NVIDIA GPU. The installer downloads the selected model once, then your image analysis runs from your computer.
- **Online Cloud Vision** sends the image securely to the KREA2 online Vision service, which runs the pinned Heretic model in the cloud. This is useful when you do not have enough GPU VRAM for a local model.

The plugin setup itself is designed to take about a minute. A local model download can take longer, depending on the model size and your internet connection. Once setup is complete, every image in a Discord server that you explicitly allow gets a magnifier action. You can queue several images, watch their progress in Prompt History, see the exact model used for each result, or open **Interrogate** to upload an image manually.

KREA2 Vision Suite is a free, open-source Windows, Linux, and macOS application in beta. Windows has the fully automated installer and verified local CUDA/Forge workflow. Linux and macOS use the portable shell installer and default to Online API; Linux local inference is available through manual Ollama or native llama.cpp configuration, while macOS local inference remains experimental. Bugs and occasional errors can still happen while the project is being improved. Join the community server for updates, help, and bug reports: [discord.gg/gdxCYCWd8g](https://discord.gg/gdxCYCWd8g).

The project is local-first. The BetterDiscord plugin talks to a private Vision service on `127.0.0.1:7870`; local models run on the user's own NVIDIA GPU. KREA2 guidance, dataset contribution, and rich failure attachments are separately disclosed and controlled. Mandatory technical failures post one owner-only, redacted `.txt` traceback per unique failed image so launch, transport, and GPU-capacity failures can be repaired across installations.

The **Online API** is an optional alternative for users who do not want to run a large Vision model on their own GPU. Local GPU mode remains account-free. On first Online API use, the plugin opens Discord's OAuth sign-in with only the `identify` scope; after approval, the browser returns the result to the plugin automatically. The KREA2 gateway verifies the account with Discord, issues a revocable remote license bound to that account and local installation, and grants 120 introductory credits. Online Vision reserves three credits once per image, regardless of its internal evidence passes; it charges those credits only after the completed image audit and automatically refunds them when the image fails or is cancelled. The planned paid pack is 1,200 credits for $20 USD paid in Bitcoin (400 successful images). The purchase option remains hidden until the operator finishes and verifies the BTCPay configuration. The plugin never receives a Discord password, BTCPay API key, gateway Discord client secret, or worker credential. For each image, the plugin exchanges its license through a short-lived, request-bound, one-use local session. The local service then sends the image over HTTPS to the private KREA2 gateway, which checks both license and available credits before it forwards the request to the configured Vast Serverless worker. The gateway currently pins Gemma 4 26B-A4B Heretic on a 24 GB GPU. Selecting Online API disables local execution for that request; the completed job records the exact remote model that actually ran.

Online inference means the selected image and bounded request metadata must leave the user's PC. The included worker is designed to process that content in memory, return the three generated prompts, and avoid intentionally writing images or prompts to worker disk. It can recruit up to five workers when demand increases and stop active GPU compute after the configured eight-second idle window. Dataset contribution and rich failure attachments are separate settings with their own disclosures; enabling Online API does not automatically enable either one. Privacy-minimal technical error reporting remains active in every mode and never contains an image, image hash, prompt, Discord identity, URL, filename, or local path.

> BetterDiscord is an unofficial Discord client modification. Review [BetterDiscord's documentation](https://docs.betterdiscord.app/users/getting-started/installation) and Discord's current terms before using it. Consider using a separate Windows account, virtual machine, and nonessential Discord account if you want stronger isolation.

## Contents

- [What it does](#what-it-does)
- [Platform support](#platform-support)
- [Download and install](#download-and-install)
- [Qwen 3.8 Prompt Changer](#qwen-38-prompt-changer)
- [Prompt quality, audit, and diagnostics](#prompt-quality-audit-and-diagnostics)
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
- Includes a conversational **Qwen 3.8 Prompt Changer** that can revise any part of an existing prompt through natural-language instructions.
- Produces one V2 prompt by default or three optional reconstruction variations.
- Audits subject count, pose, visible anatomy, clothing, expression, camera placement, lighting, and scene layout before returning prompts.
- Supports local llama.cpp multimodal models and an optional operator-configured Vast Serverless worker.
- Provides optional KREA2 writing-style guidance, local likes/dislikes, and optional prompt contribution.
- Includes Repair for a Discord update that removes BetterDiscord, damaged local prerequisites, or an interrupted verified model download.
- Preserves a V2 pose/support receipt, checks prompt contradictions locally, and provides a redacted failure diagnostics center.

The supported product is intentionally focused on Discord image interrogation. The older Prompt Assistant and photo-editing experiments are not part of the installed release.

## Platform support

| Feature | Windows 10/11 | Linux | macOS |
|---|---:|---:|---:|
| BetterDiscord magnifier, metadata/YAML prompts, Prompt History, Qwen Prompt Editor, and region description | Supported | Supported | Supported |
| Online API Vision | Supported | Supported | Supported |
| Automated installation | Full PowerShell installer | Portable shell installer | Portable shell installer |
| Local Ollama/llama.cpp Vision | Supported and verified | Supported with manual configuration | Experimental/manual |
| Shared Forge/KreaForge FIFO and CUDA handoff | Supported and verified | Manual configuration | Not applicable |
| Automated in-app suite update | Supported | Manual update | Manual update |

Every push and pull request runs the Python broker and BetterDiscord test suites on GitHub-hosted Windows, Ubuntu, and macOS runners. The badges above report the current matrix result. Platform support does not imply that Discord or BetterDiscord officially endorses this project.

## Download and install

### Windows

Download [Krea2VisionSuite-v0.17.0-win64.zip](releases/Krea2VisionSuite-v0.17.0-win64.zip). Right-click the ZIP, choose **Properties**, enable **Unblock**, apply the change, extract it, and run:

```text
START HERE - INSTALL.bat
```

Do not install only `Krea2DiscordCollector.plugin.js`. The complete package contains the BetterDiscord plugin, private loopback broker, Vision backend, model runtime installer, startup tasks, and repair tools. Updates are manual: download the next complete ZIP from this repository, verify its published SHA-256 when available, extract it, and run the same installer. Existing models and settings are preserved.

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

### Linux and macOS

Install BetterDiscord first, clone or download the complete repository, then run:

```bash
chmod +x installer/Install-Krea2VisionSuite.sh installer/Start-Krea2VisionSuite.sh
./installer/Install-Krea2VisionSuite.sh
```

The portable installer creates an isolated Python environment, installs the generated plugin in the current user's BetterDiscord plugin directory, creates matching private loopback credentials, selects V2 Online API by default, starts port `7870`, and verifies its health. It does not require a local GPU or model download. Restart Discord completely after installation.

See [Linux and macOS installation](docs/INSTALL_LINUX_MACOS.md) for default paths, local-inference options, limitations, startup, and manual updates.

## Qwen 3.8 Prompt Changer

The Discord-native **Qwen Prompt Editor** lets users paste or open a complete KREA2 prompt and change any part of it with ordinary language. Ask it to correct a pose, preserve one foot on a skateboard, redesign an outfit, rotate the camera, change the lighting, expand texture detail, shorten repetitive wording, or coordinate several changes at once. Each reply is a complete revised prompt, and the conversation can continue across several edits.

The editor is available from the KREA2 Vision header, completed Vision results, Prompt History, and locally extracted metadata/YAML prompts. It uses the pinned `heretic-3.8-q4-cloud` model and costs exactly **1 Online API credit per successful reply**. Opening, typing, copying, selecting a revision, or starting a new chat is free; failed, cancelled, invalid, or timed-out requests refund the reservation automatically.

Qwen edits text only—it does not receive the source image. Users should explicitly correct any image fact the original prompt got wrong. Conversation content is forwarded for inference but is not stored in the KREA2 gateway database. Complete Prompt Editor conversations are stored privately on the user's computer, survive modal/Discord/plugin restarts, and can be resumed through paginated history. A visible 32K-token meter tracks the active inference window; once it fills, older model context is summarized locally and removed from the request while the complete raw conversation remains in local history.

See the complete [Qwen 3.8 Prompt Changer guide](docs/QWEN_38_PROMPT_CHANGER.md) for workflows, dozens of editable attributes, example instructions, multi-turn usage, credit behavior, privacy, reliability controls, cold-start behavior, troubleshooting, the technical request contract, and the difference between Prompt Changer and Vision interrogation.

## Prompt quality, audit, and diagnostics

New V2 jobs retain the compact pose/support ledger produced in the same image call. The result viewer exposes subject count, body state, pelvic support and surface, separate left/right foot weight-bearing surfaces, knee and hip geometry, other support, and camera view. A deterministic local check then highlights obvious conflicts such as standing and sitting simultaneously, unsupported sitting, receipt/prompt posture disagreement, contradictory camera angles, incompatible day/night lighting, and mismatched subject counts. This check does not spend credits and does not pretend to inspect the image a second time.

**Ask Qwen about this prompt** is a read-only natural-language audit. Users can ask what pose the prompt specifies, which statements conflict, what reconstruction detail is missing, or whether camera/light/depth-of-field language agrees. Opening and typing are free; each valid answer costs one credit, while failed or cancelled work is refunded. The audit never rewrites or adopts the prompt.

Before Online API work, the plugin shows the worker state, bounded wait estimate, cost on success, available balance, and failure/cancellation refund rule. Completion notifications remain available, and queued/running jobs retain cancellation controls.

The **Diagnostics** view turns failed jobs into actionable support records: failed stage, sanitized explanation, support ID, worker/credit guidance, retry recommendation, synthetic-test label, Copy support ID, and a downloadable redacted `.txt` report. The report excludes images, prompts, Discord identity, credentials, URLs, filenames, image hashes, and local paths.

Prompt provenance is displayed in a visible collapsible panel with the profile, pipeline, model, and official project links. KREA2 Vision deliberately does not inject invisible tracking, settings, links, or provenance into generated or copied prompts.

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

Every selectable local or Online API model is multimodal and writes its own KREA2 prompt from the supplied image. The retired legacy Ollama hybrid and its separate `babegen-prompter:9b-q5` rewrite pass are no longer installed or offered, avoiding an unnecessary model download and a second pass that could dilute visual evidence. The separately opened Qwen Prompt Editor remains available for deliberate user-requested edits.

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

Automatic technical error reports are mandatory, bounded, and privacy-minimal. They first use the authenticated loopback broker; if that broker is unavailable, a verified KREA2 license can submit the same redacted report directly to the remote gateway. The gateway owns the Discord webhook token and attaches the exception chain as a `.txt` file without charging credits. Reports exclude image bytes and hashes, prompts/model output, Discord identity, credentials, URLs, image filenames, and local user paths; duplicate image events are suppressed for 15 minutes. Failed delivery stays only in a bounded in-memory retry queue and is never written to disk. Rich failure attachments are deliberately separate because they can contain user data, and remain disabled unless the user accepts their additional disclosure. Never attach real rich diagnostic payloads to public GitHub issues.

See [Privacy and diagnostics](docs/PRIVACY_AND_DIAGNOSTICS.md) for the complete data-flow explanation.

## Models and hardware

The installer displays model parameter size, quantization, expected download size, conservative VRAM allocation, measured peak where available, a separate 4,096 MiB safety reserve, and admission requirement.

The recommended default is Qwen3-VL 8B Heretic for users near a 12 GiB model-allocation target. Smaller 2B and 4B choices reduce memory pressure. Local Gemma 4 12B models use llama.cpp's adaptive CPU/GPU layer fitting: after the shared Forge handoff, the runtime chooses a safe split while retaining the separate 4,096 MiB reserve. The model card reports both its lower adaptive admission requirement and its full-GPU requirement. Larger Gemma/Qwen/GLM variants still require substantially more VRAM or an optional 24 GB remote worker.

Model bodies and multimodal projectors are downloaded from their original model repositories and hash-verified. They are not relicensed under MIT and are not embedded as source files in this repository. Review each model card and license before downloading.

See [models and VRAM](docs/MODELS.md).

## Queue and GPU ownership

Local Discord jobs use the same FIFO handoff as configured Forge/KREA work. Discord processes exactly one image per queue turn and releases the ticket immediately. It may keep a selected model warm for up to 15 seconds only while the shared GPU is idle. Any non-Discord ticket cancels the warm window and evicts the model before the waiting work runs.

Local Discord images remain in the exact Forge/KREA FIFO until their turn or until the user cancels them. Waiting behind real local work is not reported as a GPU failure. When a local Vision ticket reaches the head, Vision holds the lock, pauses/unloads both configured Forge endpoints and resident Ollama models, completes all evidence passes, audits and three prompts, unloads, then releases the queue. Online API capacity remains separately bounded; a remote worker-capacity timeout becomes **GPU not available** and emits a privacy-minimal operational report.

The optional Vast worker may scale from zero to five workers. `min_load=0` avoids paying for permanently idle GPU compute. The deployed eight-second idle timeout lets a worker finish its current request before active compute scales down; one cold worker may retain model storage for faster wake-up, so storage charges can remain while GPU compute is stopped.

## Repository map

```text
betterdiscord-plugin/     BetterDiscord source, generated plugin, parser, and tests
installer/                Windows and portable Linux/macOS install/start tools
vision-studio/            FastAPI loopback broker and Vision pipeline
vast-serverless-gemma26/  Optional 24 GB GPU worker container
docs/                     Product, privacy, architecture, model, and setup documentation
releases/                 Current verified Windows release and stable manifest
scripts/                  Release builder and verification automation
.github/                  Release workflow and public issue templates
```

## Development and testing

Requirements for development:

- Windows 10/11, Linux, or macOS;
- Python 3.12;
- Node.js 22 for plugin build/tests;
- an NVIDIA GPU only for real local CUDA model validation.

Run the backend suite:

```powershell
cd vision-studio
python -m unittest discover -s tests -v
```

Run every plugin check on any supported OS:

```text
node scripts/run-plugin-tests.js
```

Build the generated plugin after changing its source:

```powershell
cd betterdiscord-plugin
node .\build-inline-plugin.js
node --check .\Krea2DiscordCollector.plugin.source.js
node --check .\Krea2DiscordCollector.plugin.js
```

GitHub Actions repeats the backend and plugin suites on `windows-latest`, `ubuntu-latest`, and `macos-latest` through [.github/workflows/cross-platform-tests.yml](.github/workflows/cross-platform-tests.yml).

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
- Published release ZIPs include a SHA-256 checksum for manual verification before installation.
- `.env`, tokens, model files, runtime receipts, logs, images, prompts, databases, caches, and deployment snapshots are excluded from source control.

Do not expose port `7870` directly to a LAN or the internet. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Third-party software

KREA2 Vision Suite integrates with independently licensed projects and models, including BetterDiscord, Discord, llama.cpp, Ollama, Qwen, Gemma, GLM, Hugging Face model repositories, Vast.ai, and Seedframe. Their names do not imply endorsement. Their software, services, model weights, and terms remain governed by their respective licenses and policies.

## License

KREA2 Vision Suite source code is available under the [MIT License](LICENSE).

Copyright (c) 2026 uroligh.
