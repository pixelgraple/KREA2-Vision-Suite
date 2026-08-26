# KREA2 Vision backend

KREA2 Vision is a backend-only local FastAPI service used by the BetterDiscord plugin. It holds the installed model catalog, schedules inference through the shared GPU queue, studies Discord images, and returns three detailed prompts. It does not expose a separate website or dashboard.

## Recommended RTX 5090 configuration

The preferred local model is the verified `llamacpp::heretic-8b-q8_0` body on the RTX 5090. Existing installed Ollama choices remain available alongside the exact Heretic 2B F16, 4B Q8_0, and 8B Q8_0 models. Set `QWEN_MODEL` to any available public selector ID or supported installed Ollama tag. [Ollama Qwen3-VL library](https://ollama.com/library/qwen3-vl)

Because this PC shares its GPU with Forge, every local GPU provider joins Forge's exact FIFO `SharedGenerationLock` queue. After the Studio owns the head ticket, the held-handoff endpoint unloads Forge, the Studio rechecks free VRAM, and only then may Ollama or an isolated llama.cpp child load. Ollama uses `keep_alive: 5m`; llama.cpp keeps one child for the complete multi-pass run. Both are explicitly unloaded before the queue lease is released.

## First-time Windows setup

For the easiest friend-share setup, unzip the project and double-click **`SETUP_AND_RUN_WINDOWS.bat`**. It installs Python/Ollama with Windows `winget` when required, then asks separately whether to download Fast 8B and Quality 30B. The app lists only models Ollama confirms are installed; use **Refresh installed models** after a manual download.

Manual setup:

1. Install Python 3.11+ and [Ollama](https://ollama.com/).
2. In PowerShell, pull your desired model, for example:

   ```powershell
   ollama pull qwen3-vl:30b
   ```

3. Double-click `start.bat`.
4. Use the KREA2 controls inside Discord. `http://127.0.0.1:7870/health` is only a backend health check.

`start.bat` creates `.venv`, installs the small application dependencies, writes `.env` from `.env.example`, and runs the local FastAPI server. Edit `.env` before first launch if you want another model/backend.

## Backends and settings

* Existing Ollama models and their installed-only picker behavior are preserved; set `QWEN_API_BASE` to your Ollama server.
* `QWEN_BACKEND=openai_compatible` supports a local OpenAI-compatible vision endpoint. Keep `QWEN_API_KEY` only in `.env`; it never reaches the browser.
* Verified Heretic GGUF models use an isolated CUDA `llama-server.exe` provider. The server binds only to `127.0.0.1`, stays alive across all passes in one run, and is terminated before Forge can regain the shared slot.
* Optional Vast Serverless support pins one remote worker to Gemma 4 26B-A4B Heretic Q3_K_L on a 24 GB GPU. BetterDiscord still calls only the authenticated loopback Studio; the Vast API key stays in `.env`. There is no silent model fallback.
* Temperatures, context length, output cap, upload limits, privacy, and shared queue behavior are all configurable in `.env`. `config.example.yaml` documents the defaults.

### Optional 24 GB Vast Serverless Gemma worker

Run `scripts\INSTALL VAST SERVERLESS CLIENT.bat`, then build/publish the worker in `..\vast-serverless-gemma26`. Configure each worker with exactly one 24 GB GPU (RTX 3090 or RTX 4090), at least 65 GB of disk, `max_workers=5`, `cold_workers=1`, `cold_mult=1`, `min_load=0`, `inactivity_timeout=8`, and `max_queue_time=30`. Five is a ceiling, not five always-running GPUs: extra workers start only under load. The one stopped cache worker preserves the verified 15 GB model/projector cache without keeping GPU compute active while idle. Vast still bills inactive-worker storage and bandwidth.

Set the six `VAST_SERVERLESS_*` values in `.env` only after the endpoint and scoped API key exist. Restart Vision Studio and refresh the BetterDiscord model list. The new choice appears as `Remote Serverless — Gemma 4 26B-A4B Heretic Q3_K_L (24 GB GPU)`. Remote jobs do not take the local Forge FIFO because they use a different physical GPU; Discord's own job worker still processes them one at a time.

### Manual Heretic llama.cpp folders

The Studio never downloads GGUF files. Put manually obtained files under these exact folders:

```text
%USERPROFILE%\Documents\KreaHereticModels\2B
%USERPROFILE%\Documents\KreaHereticModels\4B
%USERPROFILE%\Documents\KreaHereticModels\8B
```

The exact installed pairs are 2B F16 + Q8_0 projector, 4B Q8_0 + Q8_0 projector, and 8B Q8_0 + Q8_0 projector. Do not mix sizes or rename files. A llama.cpp model appears in the selector only when `llama-server.exe`, its quant-specific body, and its matching projector agree with the checked-in byte-size and SHA-256 manifest. Artifact paths, hashes, and the ephemeral loopback API key are never sent to the browser or stored in prompt history.

The BetterDiscord selector shows current available VRAM, the conservative model allocation estimate, last measured peak, the separate 4,096 MiB safety reserve, and the resulting admission requirement. The 8B estimate is 13,312 MiB, so it clearly warns that the model exceeds the advisory 12,288 MiB allocation target; it remains selectable. The current reading is advisory because Forge may still be loaded. After FIFO acquisition and verified Forge unload, the backend fails closed unless free VRAM is at least `max(estimate, last measured peak) + LLAMA_CPP_VRAM_HEADROOM_MB`. llama.cpp context/output are additionally capped by the selected model specification.

## Features

* Full-image Qwen3-VL analysis and a second full-image visual critic pass.
* Validated Pydantic JSON at every handoff, with extraction plus a strict repair attempt.
* Optional Deep Inspection crops for high-detail face/clothing/lower-body evidence.
* Optional WD14 evidence—explicitly supplemental, never a prompt replacement.
* Detail, style, realism, and ten prompt-composer controls; they guide model wording rather than appearing as numerical prompt text.
* Editable prompt/negative prompt, section locks, reference comparison scores, and Apply Missing Details.
* Manual-Studio presets remain session-only. Discord Prompt History is intentionally durable and user-cleared: generated prompts and sanitized job metadata are stored in local SQLite, while full-resolution source images, sidecars, raw evidence, tokens, Discord IDs/URLs, and full paths are not stored there.
* Privacy Mode defaults on: source images and thumbnails are not stored. Every processing copy is temporary and deleted after the request.

## Private Discord vision bridge

The local Studio exposes `POST /api/discord-describe` for the private BetterDiscord collector.

The route accepts multipart `image`, optional `model`, optional bounded `guidance`, explicit `dataset_guidance=0|1`, and the current required `contribution_terms` version. Guidance is normalized to one line, capped at 600 characters, and may affect emphasis or formatting only. BetterDiscord defaults to the verified `llamacpp::heretic-8b-q8_0` model while the safe model endpoint publishes every currently verified choice. A Heretic run keeps one isolated llama.cpp child for four independent full-image evidence passes (subjects, scene, image craft, and exact pose geometry), three detail crops, image-aware composition, an original-image audit, and repair. It records peak VRAM and releases or briefly retains the child under the exact shared FIFO rules. The legacy choice retains the existing `trueinterrogate-qwen25:latest` evidence passes, `babegen-prompter:9b-q5` composer, and its existing age gate.

Krea2 dataset guidance is off by default. When explicitly enabled, the Studio holds a bounded in-memory snapshot from Seedframe's read-only Krea2 prompt endpoint, randomly selects exactly eight unique prompts once for that image job, and supplies bounded excerpts only to the composer. BetterDiscord may additionally send up to four session-liked prompts, three session-disliked prompts with short avoidance reasons, and prior downvoted sample digests; these values are accepted only with the explicit guidance toggle. The examples are marked as untrusted style data: the composer targets roughly 60% shared wording/structure and 40% fresh composition, while every depicted fact must come from the image evidence. Examples and feedback never enter subject, scene, craft, pose, crop, or audit evidence calls. A refresh failure with no in-memory corpus returns a visible 503 instead of silently generating an unguided result. Disabled requests perform no dataset disk or network work and reject a non-empty feedback context.

Before success returns, the backend synchronously contributes all three prompt variants to Seedframe's quarantined Krea2 dataset lane using a token-derived anonymous installation digest. Only prompt text, model ID, pipeline ID, and the contribution contract version leave the machine; no image, Discord identifier/URL, image hash, filename, or local path is uploaded. Retries are bounded and memory-only. If Seedframe does not confirm all three entries, the route returns 503 and does not expose the generated prompts. Success then returns the three distinct variants plus the fixed `pipeline_id` and a path-free `dataset_guidance` receipt.

`GET /api/discord-models` is literal-loopback-only and publishes safe model IDs/labels plus current free/total VRAM, conservative estimate, measured peak, separate safety reserve, admission requirement, allocation-target warning, and current admission verdict without exposing local artifact paths or hashes. `GET /api/models` similarly returns every verified Studio model, including the preserved installed Ollama choices and all exact Heretic quants.

The endpoint fails closed unless all of these hold:

* The TCP client host is a literal loopback IP.
* `KREA2_DISCORD_VISION_TOKEN` is configured with at least 32 bytes and exactly matches `X-Krea2-Vision-Token` using a constant-time comparison.
* The shared queue lease owns the front ticket and carries its nonce.
* Forge's held-handoff endpoint confirms the ticket, nonce, and existing machine-local credential. A stopped Forge instance is allowed; an HTTP/protocol/read-timeout response from a reachable Forge instance is fatal.
* The subject pass begins with the exact clearly-adult presentation sentinel. Uncertain/minor presentation, missing sentinels, numeric-age inference, refusals, structured/non-English output, and out-of-bounds detail are rejected before dataset submission.

Queued requests retain only the bounded temporary image, not an additional base64 copy. Blocking queue/model work runs in a worker thread so health and settings routes remain responsive. Temporary image files are deleted on success and failure.

### Discord queue and prompt history

The BetterDiscord Prompt History rail shows the sanitized shared Forge/Ollama FIFO, queued/running stages, paginated results, and prompt details. Discord job history is stored at `data/history/discord_vision_jobs.sqlite3` and remains across Discord and Vision restarts until the user explicitly selects **Clear history**. Interrupted active jobs become retained error records after restart instead of disappearing. Request-scoped full-resolution image files are deleted before the API response returns. The database stores generated prompts, image hashes, sanitized filenames, model evidence, status/stage, timings, and bounded reproducibility metadata; it excludes source-image bytes, Discord IDs/URLs, tokens, queue tickets/secrets, raw evidence, and full filesystem paths.

## Optional WD14

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-wd14.txt
```

The default WD14 device is CPU, keeping it out of Forge's shared VRAM. The WD14 model is downloaded on first use.

## Queue behavior on this PC

`STUDIO_USE_SHARED_GENERATION_QUEUE=true` uses `%TEMP%\forge_shared_generation_queue`, with Forge-compatible tickets and `generation.lock` ownership. The Studio waits behind an image generation; if Studio owns the slot, Forge waits. The same `local_gpu` rule covers Ollama and llama.cpp. This is an ordered FIFO queue, not a race-prone process check. Do not change the queue directory unless your Forge configuration has also changed.

`KREA2_GPU_AVAILABILITY_TIMEOUT_SECONDS=30` bounds shared-GPU admission. A request that cannot acquire capacity in time exits with `GPU not available`, removes its ticket, and cannot strand later Discord jobs. The timeout does not cancel inference after the GPU has already been acquired.

## Troubleshooting

* **Ollama unavailable:** run `ollama list`; confirm the configured Qwen tag exists and Ollama is listening at `QWEN_API_BASE`.
* **llama.cpp model missing:** confirm the configured server executable plus exactly one body/projector pair in the matching `2B`, `4B`, or `8B` folder. Refresh the model list after correcting the files; a failed manifest check remains hidden.
* **Out of memory:** let current Forge work finish, use a smaller installed vision model, or reduce the configured context/image side. The pre-queue reading is advisory; the authoritative capacity check runs after Forge handoff, and the Studio performs an explicit model unload before releasing its queue lease.
* **Malformed JSON:** Studio attempts a strict repair once, then reports the problem instead of contaminating later passes. Retry with a larger Qwen3-VL model if it persists.
* **WD14 error:** install its optional requirements or leave the WD14 toggle off.

## Tests

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

The tests use mock model replies and cover upload processing, JSON repair, lock propagation, presets, queue serialization, held-handoff ownership, provider-specific caps, post-handoff VRAM gating, llama.cpp exact-child teardown, telemetry redaction/retention, private route authentication, temporary-file cleanup, strict output bounds, the adult-presentation gate, dashboard job lifecycle/restart recovery, bounded retention, loopback-only prompt access, and queue-secret redaction. Add privately owned evaluation images to `tests/reference_images/` to run the manual prompt-quality checklist before a production release.
