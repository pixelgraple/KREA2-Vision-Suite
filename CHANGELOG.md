# Changelog

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
