# KREA2 remote Vision gateway

This optional service is the public boundary for the KREA2 online Gemma model.
It owns the Vast Serverless API key and optional Discord audit webhook; neither
credential is distributed in the BetterDiscord plugin, local Studio, releases,
or Git history.

It issues a free random-token entitlement only after Discord OAuth verifies the
account with the minimal `identify` scope. Local GPU mode does not contact this
service or require a Discord account. An administrator may suspend or revoke an
entitlement immediately. This is an abuse-control mechanism, not a claim that
an open-source client can prove it is an unmodified BetterDiscord installation.

The gateway stores a bounded audit record for completed remote jobs only:
license ID, claimed Discord ID/display name, selected model, request ID, optional
Discord CDN attachment reference, and the three generated prompt variants. It
never stores image bytes. `KREA2_GATEWAY_AUDIT_RETENTION_DAYS` defaults to 30.

## Required private environment

Create `/data/krea2-vision-gateway/gateway.env` outside the repository:

```ini
KREA2_GATEWAY_VAST_ENDPOINT=your-vast-endpoint
KREA2_GATEWAY_VAST_API_KEY=private-vast-key
KREA2_GATEWAY_AUDIT_WEBHOOK_URL=private-discord-webhook-url
KREA2_GATEWAY_ADMIN_KEY=generate-a-random-32-byte-or-longer-secret
KREA2_GATEWAY_DB=/data/krea2-vision-gateway/krea2-vision.sqlite3
KREA2_GATEWAY_AUDIT_RETENTION_DAYS=30
KREA2_GATEWAY_DISCORD_CLIENT_ID=your-discord-application-client-id
KREA2_GATEWAY_DISCORD_CLIENT_SECRET=server-only-discord-oauth-client-secret
KREA2_GATEWAY_DISCORD_REDIRECT_URI=https://your-host.example/api/krea2-vision/v1/oauth/callback
KREA2_GATEWAY_LICENSE_SIGNING_KEY=generate-a-separate-random-32-byte-or-longer-secret
```

Register the exact redirect URI in the Discord Developer Portal. The plugin
starts a short-lived enrollment, opens Discord in the user's browser, and polls
the gateway with an enrollment secret. The callback verifies `/users/@me`, then
issues a license token exactly once; the raw token is deterministically derived
from the server-only signing key and is never persisted in SQLite. Use a random
`state` per enrollment and never enable the old client-claimed license route.

Run it behind HTTPS only. Do not put any of those values in BetterDiscord,
`vision-studio/.env`, an installer, a release ZIP, screenshots, or GitHub.
