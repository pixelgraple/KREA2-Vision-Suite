# Security policy

## Manual release trust boundary

The public BetterDiscord plugin does not check for, download, or install updates. Users obtain a complete versioned ZIP from the official `pixelgraple/KREA2-Vision-Suite` repository, verify the published SHA-256 when available, extract it, and start the included installer themselves. Protecting the GitHub maintainer account and release artifacts is therefore part of the release trust boundary. Contributors must not replace release files through an alternate host, bundle secrets, or publish archives that contain symbolic links, path traversal, encrypted payloads, or unrelated executables.

## Supported deployment

KREA2 Vision Suite is designed for a single trusted Windows user on literal loopback addresses. Do not expose port 7870, llama.cpp, Ollama, or Forge unload endpoints directly to a LAN or the public internet.

## Secrets

Never commit `.env`, BetterDiscord settings, bearer tokens, the Vision token, Forge handoff tokens, Seedframe/provenance tokens, logs, history databases, saved originals, prompt sidecars, or model runtime receipts. The repository `.gitignore` excludes these, but contributors must inspect staged changes before every commit.

The BetterDiscord Vision token is stored locally in BetterDiscord plugin data in plaintext. Treat the Windows account as the security boundary. It is used only to obtain a request-bound, short-lived, one-use session from literal loopback; image POSTs do not carry the long-lived token. The Vast endpoint and account API key remain in the local broker environment and must never be bundled into the plugin or installer.

An open-source plugin cannot cryptographically prove that BetterDiscord is installed because another local program can reproduce its protocol. Do not authorize requests based on a user-agent, plugin name, or hidden URL. The supported boundary is: literal loopback, a local secret, one-use sessions bound to the request idempotency key/model/plugin version, and the provider's private account credential. A future public multi-user service must add independently provisioned per-user credentials, quotas, revocation, and abuse controls at a central gateway.

## Privacy

Routine user content is processed locally by default. Request-scoped full-resolution processing files are deleted before the request completes. Generated prompts and sanitized job metadata remain in the private local Prompt History database until the user selects **Clear history**. BetterDiscord keeps bounded 640 px preview thumbnails under the user's configured save folder so completed results retain their image preview. It does not cache full-resolution source images. The optional Krea2 contribution endpoint receives prompt text but never image bytes or Discord identity/location fields.

Separately consented failure diagnostics can contain a failed image, Discord username, partial prompt, model/stage/error data, image hash, and bounded job identifiers. Diagnostics are off by default, owner-review only, rate-limited, and nonblocking. Never attach diagnostic payloads to public issues. See [Privacy and diagnostics](docs/PRIVACY_AND_DIAGNOSTICS.md).

## Reporting a vulnerability

Do not disclose an unpatched vulnerability in a public issue. Contact the repository owner privately with the affected version, reproduction steps, impact, and a minimal proof of concept that contains no real user images, prompts, tokens, or server identifiers.
