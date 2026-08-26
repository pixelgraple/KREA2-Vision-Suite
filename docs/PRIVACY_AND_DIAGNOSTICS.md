# Privacy and diagnostics

## Principles

KREA2 is designed around data minimization, explicit feature boundaries, and local inference by default.

- No advertising telemetry or behavioral analytics.
- No contact list, friend list, server membership, or general message collection.
- No full-resolution image library.
- No durable prompt-history text database in strict privacy mode.
- Optional network features are separately named and disclosed.
- Credentials, logs, runtime data, models, and user content are excluded from the public repository.

## Local inference

The plugin sends the selected image only to the literal loopback Vision service. The service validates and processes it in a request-scoped workspace. Temporary processing files are deleted before request completion. Generated prompt text is returned to Discord and is not written to a durable local prompt database in strict privacy mode.

The plugin may keep bounded 640 px preview thumbnails, up to its configured count/size limits, in the user's chosen local folder. This exists so completed history cards retain a preview. It is not a full-resolution source-image cache.

## Online inference

Online mode is disabled unless an operator configures an approved endpoint and private credential in the local broker environment. The image must leave the PC for remote inference. The included Vast worker is designed to process request content in memory and does not intentionally persist images or prompts to worker disk.

An operator exposing online mode to other users must add per-user authentication, quotas, revocation, rate limits, transport security, abuse controls, and a published retention policy. The included local-first configuration is not by itself a public SaaS gateway.

## KREA2 guidance and contribution

Guidance fetches approved prompt text and opaque metadata, not source images. Optional contribution sends generated prompt text and bounded model/pipeline provenance, not the source image or Discord identity/location fields. See [KREA2 guidance and data](KREA2_GUIDANCE_AND_DATA.md).

## Failure diagnostics

Failure diagnostics are off by default and require separate current consent. When enabled, a failed job may submit:

- the failed image;
- Discord username;
- model, pipeline, provider, stage, status, and bounded timing/state fields;
- the error type/message;
- a partial or generated prompt when one exists;
- an image SHA-256 and bounded job identifiers.

This evidence is user data and can be sensitive. It is sent only to the canonical Seedframe diagnostic endpoint for owner-only maintenance review. Transport is bounded and rate-limited. A diagnostic upload failure never changes the Vision job result.

Do not enable diagnostics if you do not want failed images and related evidence submitted. Do not paste diagnostic payloads into a public GitHub issue. Use synthetic or redacted reproductions for public reports.

## Crash logs

Local service logs may contain operational errors, model IDs, stages, durations, and stack traces. They should not intentionally log image bytes, model weights, tokens, or full prompt corpora. Before sharing a log, review it for local paths, hostnames, identifiers, and accidental model output.

## Source-control exclusions

The release process must reject or exclude `.env` files, API keys, tokens, BetterDiscord settings, models, logs, crash dumps, databases, datasets, caches, runtime receipts, images, thumbnails, prompt sidecars, exports, feedback, and deployment snapshots.

## Deletion and control

Local thumbnails can be cleared through plugin/history controls or by removing the configured preview folder after closing Discord. Disabling contribution or diagnostics prevents future submissions but cannot automatically remove already accepted server-side records. Server-side deletion requests are governed by the current Seedframe policy and operator process.
