# Changelog

## Unreleased

## 0.17.1 - 2026-08-30

- Makes the $1.50 / 1,200-credit starter pack a server-enforced one-time purchase.
- Replaces the starter offer after settlement with $5 / 2,667-credit, $10 / 5,333-credit, and $20 / 10,667-credit packs at 1.5 times the starter per-credit price.
- Adds a server-advertised Bitcoin pack selector to BetterDiscord and reuses an unpaid starter invoice so duplicate discounted invoices cannot be opened.
- Preserves exact-once BTCPay settlement, charge/refund accounting, Local GPU use, and all existing private plugin settings.

## 0.17.0 - 2026-08-30

- Makes Qwen Prompt Editor conversations durable local history that survives closing the modal, Discord restarts, and plugin reloads; the private gateway still stores no conversation text.
- Closing the editor now hides it without cancelling an in-flight cloud edit, and reopening it resumes the same working conversation.
- Fixes Discord theme CSS overriding the editor's hidden state, so the close icon, Close button, Escape, and backdrop click visibly dismiss the modal without deleting its session.
- Adds paginated conversation history and paginated message transcripts, with any prior session available to resume.
- Shows the active `32,768`-token model-context budget at all times, including reserved system/reply capacity.
- Replaces destructive 14-message resets with local rolling-context compaction: older model context is summarized and deleted from the inference window while the full raw conversation remains in paginated local history.
- Adds an independent Open WebUI bridge guard that compacts oversized outbound conversations to a 12K working set inside the cloud model's 32K allocation while leaving Open WebUI's stored history unchanged.

## 0.16.3 - 2026-08-29

- Removes the retired Legacy Ollama hybrid from BetterDiscord and the loopback model catalog.
- Stops downloading or verifying the separate `babegen-prompter:9b-q5` model; every selectable local or Online API Vision model now writes its own prompt directly from the image.
- Preserves the separately opened Qwen Prompt Editor and forward-ports its asynchronous cloud job submission and polling transport.

## 0.16.2 - 2026-08-29

- Removes Region Inpaint Prompt Correction, its mask-and-rewrite interface, and its combined four-credit preflight path.
- Keeps ordinary full-image interrogation, Qwen Prompt Editor, and the separate Describe region inspection tool unchanged.

## 0.16.1 - 2026-08-29

- Fixed V2 Online API results that placed a JSON/checklist, YAML-style fields, Markdown headings, or bullets inside the returned prompt string.
- The local recovery now deterministically preserves and joins the model's existing textual image facts instead of re-running the same strict validator against unchanged structured text.
- Recovery performs no second model inference and therefore adds no second Vision charge.

## 0.16.0 - 2026-08-28

- Adds a V2 **Pose Inspector** backed by the model's same-call subject/support ledger: posture, pelvic support, left/right foot weight-bearing surfaces, knee/hip geometry, other support, and camera view.
- Preserves the bounded pose receipt in private local history without storing raw evidence, pixels, Discord identity, URLs, or paths.
- Adds deterministic prompt contradiction checks for pose/support, subject count, camera angle, gaze/facing, day/night light, clothing state, and accidental extra-limb language.
- Adds **Ask Qwen about this prompt**, a read-only natural-language audit for pose, contradictions, and missing detail. It costs one credit only after a valid answer and never rewrites or adopts a prompt.
- Adds visible prompt provenance and official GitHub/BabeGenerator links. No hidden text, tracking, settings, or links are injected into generated or copied prompts.
- Adds remote preflight receipts with worker state, bounded wait estimate, successful cost, current balance, and explicit automatic failure/cancellation refund behavior.
- Renames the Errors view to **Diagnostics** and adds failure stage, explanation, support ID, worker/credit guidance, retry recommendation, synthetic-test labeling, Copy support ID, and a downloadable privacy-redacted report.

## 0.15.0 - 2026-08-28

- Adds **Region Inpaint Prompt Correction** to every completed BetterDiscord Vision prompt.
- Lets the user draw a precise rectangular mask, explain the mistake, inspect only that crop through the configured Vision provider, and ask Qwen 3.8 to rewrite the complete prompt without changing unrelated details.
- Shows the current prompt, selected-pixel evidence, and proposed correction side by side, with explicit Adopt, Copy, and Continue in Qwen actions; no correction is adopted automatically.
- Uses natural-resolution crop coordinates, a ten-percent context border, high-quality resampling, and a 1,600-pixel bound for useful detail without resending the full source image.
- Preserves the shared Forge/KreaForge/Vision FIFO, aborts work when the result closes, and keeps masks, evidence, and proposals out of persistent plugin settings.
- Preflights and explains the exact credit contract: Online Vision region correction is three credits for the successful crop inspection plus one for the successful Qwen rewrite; local Vision uses only the one-credit Qwen rewrite. Each failed stage retains its own automatic refund.
- Adds a complete Region Inpaint guide and a complete Qwen 3.8 Prompt Changer guide covering workflows, billing, privacy, limits, and troubleshooting.

## 0.14.6 - 2026-08-28

- Adds visible Windows, Linux, and macOS support badges plus an explicit per-feature platform matrix.
- Adds a portable Linux/macOS installer and launcher that install the loopback broker and BetterDiscord plugin, create matching private credentials, default to Online API, and verify live health.
- Makes plugin save folders, image paths, prompt sidecars, and history thumbnails accept both Windows and POSIX absolute paths.
- Accepts a native executable `llama-server` on POSIX while retaining the `.exe` requirement on Windows.
- Marks automatic suite installation Windows-only and directs Linux/macOS users to the safe manual updater.
- Runs backend and BetterDiscord regression suites on Windows, Ubuntu, and macOS in GitHub Actions.

## 0.14.5 - 2026-08-28

- Makes V2 Direct Fidelity produce a compact pose/support ledger in the same paid image call, with no extra inference or credit.
- Distinguishes standing or balancing from sitting by requiring visible pelvis or buttock support before accepting a seated classification.
- Tracks left and right foot weight-bearing surfaces separately, including one foot on a skateboard and the other on pavement.
- Locally corrects contradictory single- and three-prompt results while preserving camera angle, body-joint geometry, wardrobe, lighting, and scene detail.
- Keeps legacy prompt-only model responses compatible and preserves deterministic format recovery.
- Adds exact regressions for false skateboard sitting, true supported sitting, all three V2 variations, and legacy response compatibility.

## 0.14.4 - 2026-08-28

- Prevents a completed background Vision image from auto-opening its result over the Qwen Prompt Editor.
- Keeps the completion toast, clickable result banner, and Prompt History update without stealing editor focus.
- Retains the current prompt, pending instruction, and chat turns in memory for the running Discord session so an accidentally dismissed editor can recover its draft.
- Keeps recovery text off disk and clears it when the plugin reloads.
- Adds regression coverage for the exact Interrogate-completion modal collision.

## 0.14.3 - 2026-08-28

- Posts one owner-only Discord webhook message with a downloadable, redacted `.txt` traceback for each unique failed Discord Vision image.
- Captures Python exception chains in Vision Studio and JavaScript stacks for plugin-only download, queue, session, and transport failures.
- Excludes image bytes and hashes, prompts/model output, Discord identity, credentials, URLs, image filenames, and local user paths from automatic reports.
- Suppresses duplicate backend/plugin reports for 15 minutes, rate-limits authenticated reporters, and keeps error reporting outside all Vision-credit accounting paths.
- Keeps the Discord webhook credential only on the remote gateway; neither BetterDiscord nor the local Studio receives or stores the webhook token.
- Advances BetterDiscord and Vision Studio to the V12 interaction-locked V2 prompt contract, including direct preservation of clearly visible adult interaction topology, pose, camera angle, lighting, shadows, and detailed wardrobe.

## 0.14.0 - 2026-08-28

- Adds a Discord-native **Qwen Prompt Editor** popup backed by the pinned `heretic-3.8-q4-cloud` Vast model.
- Opens the editor from the Krea2 Vision header, generated prompt results, Prompt History, and locally extracted metadata/YAML prompts.
- Lets users paste a complete KREA2 prompt, request conversational changes, adopt the latest revision as the current prompt, and copy it without leaving Discord.
- Charges exactly one Online API credit only after each valid Qwen reply; provider, timeout, cancellation, invalid-output, and settlement failures refund the reservation automatically.
- Keeps editor conversations session-only in Discord and stores only bounded request/accounting metadata in the KREA2 gateway, never prompt or reply content.
- Rejects reused request IDs, cross-license ownership, unsupported roles, oversized conversations, and unverified model responses before returning a result.
- Preserves the existing three-credit image-interrogation contract, Bitcoin credit checkout, local Vision paths, Forge/KreaForge FIFO, and scale-to-zero Qwen worker behavior.

## 0.13.26 - 2026-08-26

- Fixes Online API Discord sign-in launch on current Discord Stable builds by removing the missing private `openExternal` Webpack lookup.
- Opens only the already-validated `https://discord.com/oauth2/authorize` URL through the normal renderer browser-window path, with `noopener,noreferrer` protections.

## 0.13.25 - 2026-08-26

- Completes the Discord OAuth-to-Vision identity contract by returning the verified Discord account ID with the one-time remote license.
- Stores that verified ID only in the local plugin license receipt and sends it, with the verified username, to the loopback session broker for remote jobs.
- Prevents Online API jobs from failing locally with `Discord account ID is invalid for remote Vision` after an otherwise successful Discord sign-in.
- Restores the terminal-failure audit call so an Online API job that fails after reserving credits immediately refunds its three-credit hold.
- Adds gateway and plugin regression coverage for the verified account fields while continuing to keep the Discord OAuth client secret on the private gateway only.
- Corrects the Vast template runtime so the bootstrap runs as an SSH on-start script instead of being passed to Docker as a nonexistent executable.
- Makes fresh worker dependency installation tolerate the Debian-provided `cryptography` package and avoids discarding healthy Hugging Face download segments solely for falling below 1 MiB/s.

## 0.13.24 - 2026-08-26

- Fixes false local Gemma 4 12B capacity failures caused by a fixed GPU-layer count competing with the measured full-GPU admission estimate.
- Uses llama.cpp's native adaptive layer fitting for both local Gemma 4 12B variants, with a 4,096 MiB fit target and the existing independent 4,096 MiB shared-machine safety reserve.
- Keeps fixed-profile Qwen and larger Gemma models on their existing full-GPU admission contract.
- Shows the adaptive minimum, full-GPU requirement, fit target, current free VRAM, measured peak and safety reserve separately in the model-status API.
- Preserves the actionable nested llama.cpp, local-capacity and remote-gateway failure reason instead of replacing it with the generic `selected Heretic vision pipeline is unavailable` message.
- Adds regression coverage for adaptive launch arguments, adaptive admission and nested public error reporting.
- Real production-path smoke verification completed with local Gemma 4 12B Heretic Q8_0: three prompt variants, 564-word primary result, 13,364 MiB measured peak allocation, and verified post-job unload.
- Removes the 30-second deadline from local plugin submissions and local shared-FIFO acquisition. Local Vision now remains queued until its turn or explicit cancellation, while Online API capacity remains separately bounded.
- Verifies that queue-head Vision ownership covers Forge/KreaForge handoff, the complete interrogation, model unload, and FIFO release in that order.
- Live contention smoke verified a local Gemma 4 12B request remained queued for 33.7 seconds, then completed with HTTP 200 and three prompt variants while Krea Forge waited behind Vision; Vision unloaded before Krea Forge became FIFO head.
- Keeps every post-acquisition progress update in the `running` state instead of incorrectly flipping an active interrogation back to `queued`.
- Accepts direct, grounded reclining support such as reclining on a couch, sofa cushions or an upholstered seat while retaining rejection of contradictory unsupported-pose claims.

## 0.13.18 - 2026-08-26

- Separates being near a wall, pillar or column from actually touching, resting on, bracing against or transferring weight into it.
- Requires the independent pose pass and pose audit to agree before external support, lateral torso lean or pelvis counter-shift becomes a machine-locked fact.
- Preserves the exact verified body region, anatomical side and support surface, and requires that contact geometry within the first 140 words of every final variation.
- Adds two-source wardrobe topology locks for a hand-held or lifted garment, sheer lace tops, long lace sleeves, exposed midriffs, low-rise sheer skirts and pale-blue garment color.
- Expands the torso/clothing crop and final image audit to retain separate garment layers, sleeve length, transparency, lace, ties, hem/rise and exact hand-to-garment actions.
- Advances the cache/reproducibility contract to `discord-faithful-v9-external-support-wardrobe-lock` so older prompt telemetry cannot be reused.

## 0.13.17 - 2026-08-26

- Replaces restart-volatile Discord Prompt History with a durable local SQLite database at `vision-studio/data/history/discord_vision_jobs.sqlite3`.
- Retains completed prompts, errors, cancellations, model evidence, and safe job metadata until the user explicitly selects **Clear history**; no automatic age/count pruning remains.
- Restores any compatible history already present in that database and preserves interrupted active jobs as actionable error records instead of silently dropping them.
- Adds server-side pagination, status/model/search filtering, page totals, Previous/Next controls, and a clear-history control to the BetterDiscord history rail.
- Adds pagination to the loopback Discord job dashboard and keeps small local thumbnails until history is cleared.
- Continues to exclude full-resolution source images, Discord URLs/IDs, tokens, queue secrets, raw evidence, and full filesystem paths from the history database.

## 0.13.16 - 2026-08-26

- Adds a dedicated fifth full-image evidence pass for visible skin condition, soft-tissue shape and broad age-related appearance without numeric-age guesses or medical diagnosis.
- Maps bruises, discoloration, pressure or friction marks, scratches, cuts, abrasions, scars, stretch marks, wrinkles, laxity, breast contour, abdominal folds and other positively visible surface details by subject and body region.
- Strengthens pose reconstruction with anatomical-left/right lean, lean depth, shoulder/hip asymmetry, center-of-mass shift, wall or furniture bracing, and weight-bearing versus merely-touching contacts.
- Separates standing, sitting, kneeling, crouching, squatting, on-all-fours, reclining and lying states, requiring matching visible support geometry and resolving raised-hand gestures that conflict with invented hand support.
- Extends all three detail crops and the final image audit to catch invented injuries, smoothed-away natural texture, unsupported injury causes, left/right lean reversals and incorrect support relationships.
- Caps repetitive `no visible` inventory so final prompts prioritize positively observed reconstruction detail.
- Advances the cache/reproducibility contract to `discord-faithful-v8-skin-pose-surface-lock` so older prompt telemetry cannot be reused for the new evidence contract.

## 0.13.15 - 2026-08-26

- Ends plugin-local, shared-FIFO, and Vast capacity waits after 30 seconds with the exact visible error `GPU not available`; other failures retain their sanitized actionable message.
- Removes timed-out tickets from the active queue so a stalled GPU cannot leave later Discord images indefinitely blocked.
- Adds required privacy-minimal operational error reporting with bounded in-memory retry and direct canonical Seedframe fallback when the local broker cannot deliver.
- Keeps images, image hashes, prompts, Discord identity, URLs, filenames, and local paths out of automatic error records; the existing rich image diagnostic remains separate, opt-in, and owner-only.
- Adds the owner-only Seedframe operational-error view and verifies both backend and direct-plugin receiver contracts.

## 0.13.14 - 2026-08-26

- Repairs the Vast Serverless readiness handshake so PyWorker observes the worker's private lifecycle event stream instead of `/dev/null`.
- Requires a successful local inference probe before publishing `KREA2_MODEL_READY`, bounds model download/startup, and exits a worker after repeated post-readiness health failures so Vast can replace it.
- Raises the remote endpoint ceiling to five one-job workers while preserving zero minimum load and the 8-second inactivity policy.
- Reports remote Serverless startup failures as remote capacity failures instead of incorrectly blaming the local GPU or shared Forge queue.

## 0.13.13 - 2026-08-25

- Repairs BetterDiscord injection after Discord creates a new application-version directory.
- Detects the WinGet BetterDiscord CLI package path when it is not on `PATH`.
- Verifies the current Discord installation after repair.
- Preserves the KREA2 v0.13.13 matched plugin/backend update contract.

Earlier development snapshots were consolidated into this fresh public repository. Full historical mirrors are retained privately for recovery; the public project begins with the supported release and a clean, secret-scanned history.
