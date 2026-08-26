# Release and updates

## Version contract

The root `VERSION`, `vision-studio/VERSION`, plugin metadata, backend update metadata, release ZIP filename, and `releases/latest.json` version must match.

## Required release artifacts

Each release commit contains complete source, the generated plugin built from that source, the current Windows ZIP, its SHA-256 checksum, and the stable manifest with exact version, URL, byte length, and hash.

Old ZIPs should live in GitHub Releases or outside the default source branch so the main checkout remains small.

## Build

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Build-Release.ps1
```

The builder must exclude user/runtime data and audit the ZIP. A release is not publishable until backend tests, plugin tests, syntax checks, checksum verification, and an archive privacy scan pass.

## Update checks

Installed plugins check after startup and every six hours. Users may choose notification-only one-click installation or verified automatic updates. The broker downloads only from the pinned repository URL and rejects an artifact whose byte length or SHA-256 differs from the manifest.

The updater waits for active Vision work to finish before replacing the matched plugin/backend set. Discord may update independently; Repair detects whether BetterDiscord is injected into the current Discord `app-*` directory and reinstalls the official BetterDiscord build when necessary.

## Rollback

Before local deployment, create a versioned snapshot of the plugin, backend version metadata, and updater files. Git tags and GitHub Releases should identify every public version. Never restore `.env`, model, database, or user-content files from a public archive.
