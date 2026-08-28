# Krea2 Discord Vision v0.14.6

The public plugin does not check for, download, or install updates. To update, download the next complete Windows ZIP from the official GitHub repository, verify its published SHA-256 when available, extract it, and run **`START HERE - INSTALL.bat`**. Existing verified models and local settings are preserved.

This BetterDiscord plugin adds two independent tools to exact Discord image attachments inside explicitly allowlisted servers:

- the top-left **+** reads embedded image metadata and, when present on the same Discord message, a `.yaml` or `.yml` companion. It opens the exact positive prompt locally without running Vision, using credits, submitting to a dataset, or saving anything;
- the top-right image magnifier holds request bytes in memory, queues one shared-GPU Vision job, and returns one grounded V2 prompt by default or three variations when enabled, without saving the full-resolution image.

The Krea2 Vision header and every usable prompt result also expose **Qwen Prompt Editor**. Paste or open a complete KREA2 prompt, describe the pose, wardrobe, camera, lighting, setting, or wording change you want, and adopt or copy Qwen's revised prompt. Each successful edit reply costs one Online API credit. Opening, closing, copying, or clearing the editor costs nothing, and a failed request is refunded automatically. A recovery draft exists only in memory for the current Discord session, so a background image completion cannot destroy work in progress; it is never written to disk or stored by the KREA2 gateway.

## Source metadata +

The metadata action supports ordinary `parameters:` exports and ComfyUI exports whose `prompt:` field contains the workflow's JSON prompt graph. For ComfyUI files it follows a sampler's positive-conditioning edge to the actual text encoder, ignores negative conditioning and image-conditioned refiner branches, and refuses ambiguous or traversal-limited graphs instead of guessing. It does not load the large `workflow:` editor graph as prompt text.

A companion YAML is used only when its filename stem uniquely matches the selected image, or when the Discord message contains exactly one image and one YAML attachment. Multiple possible pairings fail closed. Encoded, encrypted, substantially non-English, malformed, generic JSON, and unsupported structured content remain skipped.

During first-run setup, the user can enable **Automatically contribute my three generated prompts to Krea2** and accept the current [Seedframe Terms](https://seedframe.xyz/policies/terms). When enabled, every successful Vision request submits its three generated prompt texts through the authenticated loopback Vision broker. When disabled, Vision remains available and no generated prompt is submitted. A fresh installation never needs a Seedframe endpoint or token. Contributions never send image bytes, image hashes, Discord IDs or URLs, filenames, or local paths. Entries are quarantined as `review_required` and never become training-ready automatically.

**Share failed Vision diagnostics with Krea2** is a separate setting that defaults to **off** and has its own disclosure. If explicitly enabled, failed requests only may send the source image, Discord username, model/pipeline, error/stage, versions, anonymous installation digest, and an available partial or audited prompt to the owner-only Seedframe diagnostics console. Successful requests are never sent through this channel, and a diagnostic upload failure can never turn a Vision result into an error.

Mandatory technical error reporting is separate from that rich diagnostic option. Each unique failed image posts one downloadable, redacted `.txt` traceback to the owner-only Discord webhook and retains privacy-minimal operational fields in Seedframe. Reports contain the exception chain, event/model/pipeline, sanitized error and stage, runtime, and software versions; they never contain an image or image hash, prompt/model output, Discord identity, credentials, URL, image filename, or local user path. Delivery uses the authenticated loopback broker with a licensed remote-gateway fallback; pending retries are bounded and memory-only, duplicate backend/plugin reports are suppressed for 15 minutes, and reporting never spends Vision credits.

The model/VRAM installer, shared FIFO status, durable local job history, pagination, cancel, prompt copying, and model-used evidence remain. Legacy sidecars, exports, and unrelated persistent prompt tools are disabled.

## Discord-integrated prompt history

Prompt History is mounted as a detached right-side rail that does not change Discord's channel, forum, ticket, or thread layout. It provides live shared-GPU and warm-window status, the average queue wait across successful jobs completed in the last 24 hours, recent/completed/queued/error filters, prompt search, a model filter, exact model-used evidence, cancel controls, and full three-prompt results from the private local history database.

An open queued or running job refreshes every second without overlapping requests and automatically becomes the finished result. Closing the detail stops polling immediately.

## Interrogate tab

The right-side Discord rail now includes an **Interrogate** tab. It accepts a PNG, JPEG, or WebP by file picker or drag-and-drop, shows an in-memory preview, loads the currently available models from the local Vision broker, and lets the user choose the exact model before pressing **Start interrogation**.

An optional **Identity or role notes** field lets the uploader provide known labels and pronouns for that one request, such as `Subject A is a trans woman, she/her; Subject B is a man, he/him.` The Vision model never infers transgender, cisgender, femboy, tgirl, man, or woman identity from appearance or anatomy. Without a supplied note it uses pixel-grounded presentation wording, such as `feminine-presenting adult with a directly visible penis`, while keeping anatomy, pose and participant roles separate. The note remains in session memory only and is cleared after enqueueing.

Every press of Start creates one normal authenticated Vision job. Uploaded images join the same plugin submission chain and exact shared Forge/Krea FIFO as message magnifiers, so users may queue several images while each image still runs one at a time and yields correctly. The form clears immediately after enqueueing so another image can be selected. The completed job opens in the existing prompt-history result viewer with its retained local thumbnail and generated prompt result.

Local images remain queued until their shared Forge/KreaForge FIFO turn or until the user cancels them; local contention does not expire after 30 seconds. Online API worker-capacity waits remain bounded and may end as **GPU not available**. Other failures show the sanitized error returned by the local or remote provider.

Upload bytes remain in request memory. Prompt History stores sanitized job metadata and generated prompt text in the private local Vision SQLite database until the user selects **Clear history**. For reliable previews across reloads, the plugin stores one small local thumbnail per image under `<configured save folder>\.krea2-history-thumbnails`. It does not copy the full-resolution source image or create prompt sidecars.

## One prompt by default, optional three-prompt output

V2 returns one canonical prompt by default. **Generate three V2 prompt variations** can be enabled in settings to return:

1. **Balanced** — overall reconstruction.
2. **Subject & pose** — subject geometry, expression, wardrobe, anatomy, and interaction emphasis.
3. **Scene & light** — environment, framing, camera, materials, color, and lighting emphasis.

Each variation has:

- **👍 Like** — keeps that prompt in memory as a preferred example for this Discord session.
- **👎 Needs work** — asks for a short plain-English reason and keeps it in memory for this session.

Feedback is never written to BetterDiscord plugin data. It disappears when the plugin/Discord session ends and is inert while dataset guidance is off.

## Opt-in Krea2 dataset guidance

**Guide prompts with the Krea2 example dataset** defaults to **off**.

When enabled for a fresh generation:

- Vision Studio samples exactly eight random approved Krea2 prompts.
- The plugin adds up to four randomly selected session-liked prompts.
- The plugin adds up to three randomly selected session-disliked prompts and their reasons.
- A downvoted result's exact eight-example sample digest is blocked from reuse during that session.
- The composer targets approximately 60% exemplar structure/style and 40% fresh wording.
- Current-image evidence remains 100% authoritative; exemplar subjects and facts must never be copied.

Only the bounded selected examples and downvote reasons are sent to the authenticated loopback Vision route for that generation. Job history and reproducibility metadata retain only counts and SHA-256 digests, never the feedback prompt text or reasons.

Guided requests include the feedback-context digest in idempotency/cache identity. The plugin rejects a successful response unless the backend confirms the exact digest, example counts, corpus digest, random-eight sample digest, and pipeline identity.

## Model and VRAM setup

The first-run setup offers **Local GPU** and **Online API** execution. Local mode displays current available/total VRAM plus each model's runtime context cap, conservative allocation estimate, context-specific measured peak, separate 4,096 MiB reserve, bounded 64 MiB NVML observation tolerance, and admission requirement. Models are sorted by parameter size and link to immutable model/projector downloads and model cards. The verified 8B Q8_0 Heretic pair remains the local default recommendation with a 6,144-token runtime context. Online mode disables the local model controls, asks the user once to connect Discord with Discord's minimal `identify` OAuth scope, then requests the private Gemma 4 26B-A4B Heretic Q3_K_L worker through the loopback broker. It cannot be saved unless that broker reports a configured private remote worker. Local GPU use never asks the user to sign in.

Heretic/uncensored variants reduce model-level refusals. The local project still applies grounded-output validation, shared-GPU admission, and security limits.

## Strict privacy and queue security

- Exact Discord CDN attachment provenance is revalidated before download.
- Downloads are capped at 20 MiB and the real format is detected from magic bytes.
- Full-resolution images exist only in memory plus a request-scoped temporary processing directory that is deleted before the response returns.
- Prompt History is paginated and remains available across Discord and Vision restarts. Finished jobs and their small previews are retained until the user explicitly selects **Clear history**. Each preview is capped at 640 px and 2 MiB, keyed by the source SHA-256, and saved under the configured local folder's `.krea2-history-thumbnails` subfolder.
- Session feedback, review notes, legacy sidecars, exports, and the Krea2 example cache are never persisted locally. Prompt History intentionally persists sanitized job records and generated prompt text until the user selects **Clear history**.
- After the contribution disclosure is accepted, all three generated prompt texts are synchronously accepted by Seedframe before the local API returns success. The image and Discord attachment/account metadata are never sent with prompt contribution. Source images are eligible only for the separate, default-off failure-diagnostics feature after its own consent.
- Automatic three-prompt contribution is off by default for new installs and can be enabled only after consent. It rides the same request-bound one-use loopback Vision session; BetterDiscord stores no reusable Seedframe credential.
- Seedframe retries are bounded and memory-only. If the online dataset cannot confirm all three prompts, Discord receives a visible 503 and no prompt result.
- Model weights, runtime files, settings, and shared-FIFO ticket metadata remain on disk because they are operational files rather than user image/prompt content.
- Only PNG, JPEG, and WebP are sent to Vision.
- The only accepted Vision route is literal loopback `/api/discord-describe`.
- Redirects, alternate numeric loopback spellings, URL credentials, queries, fragments, and external hosts are rejected.
- A random 32+ character `X-Krea2-Vision-Token` is sent only to `/api/discord-session` on literal loopback.
- The session exchange returns an in-memory, request-bound, short-lived, one-use credential. `/api/discord-describe` accepts that credential in `X-Krea2-Vision-Session`; it rejects missing, expired, mismatched, and replayed sessions.
- BetterDiscord never receives the Vast endpoint or account API key. Open-source clients cannot prove that BetterDiscord itself is installed, so authorization relies on the local secret/session boundary rather than client-name claims.
- Every Discord image gets exactly one shared-FIFO turn before yielding; it never runs concurrently with Forge/Krea.

## Compact response receipt

```json
{
  "classification": "usable",
  "prompt": "...Prompt 1...",
  "prompt_variants": ["...Prompt 1...", "...Prompt 2...", "...Prompt 3..."],
  "model": "...",
  "prompt_words": 384,
  "pipeline_id": "discord-faithful-v12-interaction-locked-v2",
  "dataset_guidance": {
    "enabled": true,
    "status": "applied",
    "corpus_digest": "<sha256>",
    "sample_digest": "<sha256>",
    "sample_count": 8,
    "feedback_digest": "<sha256>",
    "liked_count": 4,
    "disliked_count": 3,
    "blocked_sample_count": 12
  }
}
```

## Build and verification

```powershell
node .\build-inline-plugin.js
node --check .\Krea2DiscordCollector.plugin.source.js
node --check .\Krea2DiscordCollector.plugin.js
node .\Krea2DiscordCollector.test.js
node --test .\Krea2DiscordCollector.dataset-guidance.test.js
node --test .\Krea2DiscordCollector.feedback.test.js
node .\Krea2DiscordCollector.metadata-yaml.test.js
node .\Krea2DiscordCollector.v2-output.test.js
node --test .\parser\png-prompt-metadata.test.js
```

For normal installation, run the suite's `START HERE - INSTALL.bat`. It installs the generated single-file plugin and matching loopback service configuration.
