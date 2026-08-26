# Contributing

## Release rule

Every user-facing local change must be published to the GitHub source tree in the same release as its matching Windows package. Bump root `VERSION`, `vision-studio/VERSION`, the plugin metadata version, and `PLUGIN_VERSION` together. Run the complete backend and plugin suites, then run `scripts\Build-Release.ps1`. Publish the generated ZIP, checksum, and `latest.json` atomically with the source changes; never point `latest.json` at an unpublished or untested archive.

Contributions should preserve the suite's local-only, privacy-first behavior and exact shared FIFO semantics.

Before opening a pull request:

1. Run both Python suites and both BetterDiscord JavaScript suites listed in the root README.
2. Confirm no model weight, `.env`, token, database, prompt, image, local absolute path, or runtime log is staged.
3. Keep Discord jobs to one image per FIFO turn and preserve immediate yield to waiting Forge/KREA/other work.
4. Keep the 15-second Discord warm residency opportunistic: any non-Discord ticket must cancel it and trigger eviction before that ticket runs.
5. Keep model discovery quant-specific and checksum-verified; do not silently substitute Q4 for the documented F16/Q8_0 files.
6. Add focused tests for security, queue, parser, or API-contract changes.

Use synthetic or privately owned test fixtures only. Never submit Discord CDN URLs, real access tokens, or personally identifying prompt history.
