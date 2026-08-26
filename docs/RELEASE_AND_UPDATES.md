# Release and updates

## Version contract

The root `VERSION`, `vision-studio/VERSION`, plugin metadata, release ZIP filename, and `releases/latest.json` version must match.

## Required release artifacts

Each release commit contains complete source, the generated plugin built from that source, the current Windows ZIP, its SHA-256 checksum, and the stable manifest with exact version, URL, byte length, and hash.

Old ZIPs should live in GitHub Releases or outside the default source branch so the main checkout remains small.

## Build

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Build-Release.ps1
```

The builder must exclude user/runtime data and audit the ZIP. A release is not publishable until backend tests, plugin tests, syntax checks, checksum verification, and an archive privacy scan pass.

## Manual updates

The published BetterDiscord plugin contains no update checker, downloader, or installer. Publish a complete, versioned GitHub Release with its checksum and direct users to download the ZIP manually. The installer preserves their existing models and settings; Repair detects whether BetterDiscord is injected into the current Discord `app-*` directory and reinstalls the official BetterDiscord build when necessary.

## Rollback

Before local deployment, create a versioned snapshot of the plugin and backend version metadata. Git tags and GitHub Releases should identify every public version. Never restore `.env`, model, database, or user-content files from a public archive.
