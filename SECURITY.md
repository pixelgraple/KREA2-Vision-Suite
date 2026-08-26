# Security policy

## Update trust boundary

KREA2's updater is authenticated on literal loopback and code-pins the `pixelgraple/KREA2-Vision-Suite` stable manifest and release paths. Redirects, alternate hosts, malformed semantic versions, unexpected package sizes, SHA-256 mismatches, encrypted archives, symbolic links, path traversal, and oversized extraction are rejected before installer launch. Automatic updates are optional; the default requires one click in BetterDiscord. Protecting the GitHub maintainer account is therefore part of the release trust boundary.

## Supported deployment

KREA2 Vision Suite is designed for a single trusted Windows user on literal loopback addresses. Do not expose port 7870, llama.cpp, Ollama, or Forge unload endpoints directly to a LAN or the public internet.

## Secrets

Never commit `.env`, BetterDiscord settings, bearer tokens, the Vision token, Forge handoff tokens, Seedframe/provenance tokens, logs, history databases, saved originals, prompt sidecars, or model runtime receipts. The repository `.gitignore` excludes these, but contributors must inspect staged changes before every commit.

The BetterDiscord Vision token is stored locally in BetterDiscord plugin data in plaintext. Treat the Windows account as the security boundary. It is used only to obtain a request-bound, short-lived, one-use session from literal loopback; image POSTs do not carry the long-lived token. The Vast endpoint and account API key remain in the local broker environment and must never be bundled into the plugin or installer.

An open-source plugin cannot cryptographically prove that BetterDiscord is installed because another local program can reproduce its protocol. Do not authorize requests based on a user-agent, plugin name, or hidden URL. The supported boundary is: literal loopback, a local secret, one-use sessions bound to the request idempotency key/model/plugin version, and the provider's private account credential. A future public multi-user service must add independently provisioned per-user credentials, quotas, revocation, and abuse controls at a central gateway.

## Privacy

Strict privacy mode is mandatory for routine user content. Vision Studio does not persist uploaded source images, generated prompts, feedback, reviews, exports, or prompt-history databases; request-scoped processing files are deleted before the request completes. BetterDiscord keeps only a bounded local Prompt History thumbnail cache (at most 250 previews, 640 px and 2 MiB each) under the user's configured save folder so completed results retain their image preview. It does not cache full-resolution source images or prompt text. The optional Krea2 contribution endpoint receives prompt text but never image bytes or Discord identity/location fields.

Separately consented failure diagnostics can contain a failed image, Discord username, partial prompt, model/stage/error data, image hash, and bounded job identifiers. Diagnostics are off by default, owner-review only, rate-limited, and nonblocking. Never attach diagnostic payloads to public issues. See [Privacy and diagnostics](docs/PRIVACY_AND_DIAGNOSTICS.md).

## Reporting a vulnerability

Do not disclose an unpatched vulnerability in a public issue. Contact the repository owner privately with the affected version, reproduction steps, impact, and a minimal proof of concept that contains no real user images, prompts, tokens, or server identifiers.
