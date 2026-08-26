# Privacy and diagnostics

## Principles

KREA2 is designed around data minimization, explicit feature boundaries, and local inference by default.

- No advertising telemetry or behavioral analytics.
- No contact list, friend list, server membership, or general message collection.
- No full-resolution image library.
- Discord Prompt History is the intentional local exception: generated prompts and sanitized job metadata remain in private local SQLite until the user selects **Clear history**.
- Optional network features are separately named and disclosed.
- Required operational error reporting is limited to technical fields and excludes user content.
- Credentials, logs, runtime data, models, and user content are excluded from the public repository.

## Local inference

The plugin sends the selected image only to the literal loopback Vision service. The service validates and processes it in a request-scoped workspace. Temporary full-resolution processing files are deleted before request completion. Generated prompt text and sanitized job metadata are written to the local Prompt History database so results survive restart; source-image bytes, Discord IDs/URLs, tokens, raw evidence, queue secrets, and full paths are not written there.

The plugin keeps 640 px preview thumbnails, each capped at 2 MiB, in the user's chosen local folder until Prompt History is cleared. This exists so completed history cards retain a preview. It is not a full-resolution source-image cache.

## Online inference

Online mode is disabled unless an operator configures an approved endpoint and private credential in the local broker environment. The image must leave the PC for remote inference. The included Vast worker is designed to process request content in memory and does not intentionally persist images or prompts to worker disk.

An operator exposing online mode to other users must add per-user authentication, quotas, revocation, rate limits, transport security, abuse controls, and a published retention policy. The included local-first configuration is not by itself a public SaaS gateway.

## KREA2 guidance and contribution

Guidance fetches approved prompt text and opaque metadata, not source images. Optional contribution sends generated prompt text and bounded model/pipeline provenance, not the source image or Discord identity/location fields. See [KREA2 guidance and data](KREA2_GUIDANCE_AND_DATA.md).

## Required operational error reports

Every installation reports terminal Vision failures so launch, queue, GPU-capacity, model, and transport defects can be repaired. The automatic record contains only:

- a one-way anonymous installation digest derived from the private local Vision token;
- a random event identifier;
- requested model and pipeline identifiers;
- bounded error code, sanitized error message, and stage;
- local or remote runtime classification;
- plugin and backend versions.

It never contains image bytes, an image hash, generated or partial prompts, Discord username or IDs, server/channel/message identifiers, Discord or attachment URLs, filenames, local paths, credentials, or opaque model output. Errors are sent to the canonical Seedframe receiver and are visible only in its owner console. The plugin first asks the authenticated loopback broker to submit the record. If the broker is unavailable, the plugin can submit the same digest-bound record directly. Undelivered records remain in a bounded in-memory retry queue only and disappear when Discord exits; nothing is written to disk.

No software can guarantee delivery during a total Internet outage. Reporting is therefore mandatory and best-effort: it retries while the plugin is running, but it never blocks Discord indefinitely or stores a hidden offline telemetry file.

## Optional rich failure diagnostics

Failure diagnostics are off by default and require separate current consent. When enabled, a failed job may submit:

- the failed image;
- Discord username;
- model, pipeline, provider, stage, status, and bounded timing/state fields;
- the error type/message;
- a partial or generated prompt when one exists;
- an image SHA-256 and bounded job identifiers.

This evidence is user data and can be sensitive. It is sent only to the canonical Seedframe diagnostic endpoint for owner-only maintenance review. Transport is bounded and rate-limited. A rich diagnostic upload failure never changes the Vision job result or disables the required privacy-minimal operational record.

Do not enable diagnostics if you do not want failed images and related evidence submitted. Do not paste diagnostic payloads into a public GitHub issue. Use synthetic or redacted reproductions for public reports.

## Crash logs

Local service logs may contain operational errors, model IDs, stages, durations, and stack traces. They should not intentionally log image bytes, model weights, tokens, or full prompt corpora. Before sharing a log, review it for local paths, hostnames, identifiers, and accidental model output.

## Source-control exclusions

The release process must reject or exclude `.env` files, API keys, tokens, BetterDiscord settings, models, logs, crash dumps, databases, datasets, caches, runtime receipts, images, thumbnails, prompt sidecars, exports, feedback, and deployment snapshots.

## Deletion and control

Local prompts, sanitized job records, and thumbnails can be cleared together through the Prompt History **Clear** control. The preview folder can also be removed manually after closing Discord. Disabling contribution or rich diagnostics prevents future submissions of those optional records, but required privacy-minimal operational errors remain enabled. Already accepted server-side records cannot be removed automatically; deletion requests are governed by the current Seedframe policy and operator process.
