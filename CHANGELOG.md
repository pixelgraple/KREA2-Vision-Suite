# Changelog

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
