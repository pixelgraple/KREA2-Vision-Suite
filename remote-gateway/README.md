# KREA2 remote Vision gateway

This optional service is the public boundary for the KREA2 online Gemma model
and Qwen Prompt Editor. Production uses a private dedicated RTX 3090 reached
through a restricted reverse SSH listener on VPS loopback. The gateway owns the
router bearer key and optional Discord audit webhook; neither credential is
distributed in the BetterDiscord plugin, local Studio, releases, or Git history.
Legacy Vast Serverless variables remain supported only as a migration fallback.

It issues a revocable random-token entitlement only after Discord OAuth verifies
the account with the minimal `identify` scope. A newly verified Discord account
receives 120 introductory Online API credits. Each image reserves three credits
exactly once, regardless of its internal evidence passes; it is charged only
after the final prompt audit succeeds and is automatically refunded if the
image fails or is cancelled. Local GPU mode does not contact this service or
require a Discord account or credits.

The same verified license can use the separate Qwen Prompt Editor route. Each
successful Qwen reply costs one credit; a failed, cancelled, timed-out, invalid,
or unsettled request is refunded automatically. The gateway stores only its
request digest and credit state, not the prompt, instructions, conversation, or
reply text.

The gateway stores a bounded audit record for completed remote jobs only:
license ID, claimed Discord ID/display name, selected model, request ID, optional
Discord CDN attachment reference, and the three generated prompt variants. It
never stores image bytes. `KREA2_GATEWAY_AUDIT_RETENTION_DAYS` defaults to 30.

Authenticated `POST /v1/audit/error` reports do not reserve or charge credits.
They create one owner-only Discord webhook message with a downloadable `.txt`
attachment per event ID. The report keeps the exception chain and software
stage/version data while removing images, prompts/model output, Discord IDs,
credentials, URLs, image filenames, and local user paths. Duplicate event IDs
are suppressed for 15 minutes and each license is limited to 30 new reports per
10 minutes.

## Required private environment

Create `/data/krea2-vision-gateway/gateway.env` outside the repository:

```ini
KREA2_GATEWAY_QWEN_TIMEOUT_SECONDS=300
KREA2_GATEWAY_AUDIT_WEBHOOK_URL=private-discord-webhook-url
KREA2_GATEWAY_ADMIN_KEY=generate-a-random-32-byte-or-longer-secret
KREA2_GATEWAY_DB=/data/krea2-vision-gateway/krea2-vision.sqlite3
KREA2_GATEWAY_AUDIT_RETENTION_DAYS=30
KREA2_GATEWAY_DISCORD_CLIENT_ID=your-discord-application-client-id
KREA2_GATEWAY_DISCORD_CLIENT_SECRET=server-only-discord-oauth-client-secret
KREA2_GATEWAY_DISCORD_REDIRECT_URI=https://your-host.example/api/krea2-vision/v1/oauth/callback
KREA2_GATEWAY_LICENSE_SIGNING_KEY=generate-a-separate-random-32-byte-or-longer-secret
KREA2_GATEWAY_BTCPAY_URL=https://bitcoin.seedframe.xyz
KREA2_GATEWAY_BTCPAY_STORE_ID=your-btcpay-store-id
KREA2_GATEWAY_BTCPAY_API_KEY=least-privilege-server-only-btcpay-api-key
KREA2_GATEWAY_BTCPAY_WEBHOOK_SECRET=separate-random-32-byte-or-longer-webhook-secret
```

Create a second root-readable file, `/data/krea2-vision-gateway/dedicated.env`:

```ini
KREA2_GATEWAY_DEDICATED_BASE_URL=http://127.0.0.1:18090
KREA2_GATEWAY_DEDICATED_API_KEY=dedicated-router-bearer-key
KREA2_GATEWAY_OPENWEBUI_BRIDGE_API_KEY=separate-private-bridge-key
```

The systemd unit may load both files. The dedicated URL must remain loopback;
never bind the llama.cpp router or reverse listener to a public interface.

Register the exact redirect URI in the Discord Developer Portal. The plugin
starts a short-lived enrollment, opens Discord in the user's browser, and polls
the gateway with an enrollment secret. The callback verifies `/users/@me`, then
issues a license token exactly once; the raw token is deterministically derived
from the server-only signing key and is never persisted in SQLite. Use a random
`state` per enrollment and never enable the old client-claimed license route.

Run it behind HTTPS only. Do not put any of those values in BetterDiscord,
`vision-studio/.env`, an installer, a release ZIP, screenshots, or GitHub.

## Bitcoin credit pack

The fixed pack is 1,200 credits for **$20 USD paid in Bitcoin**. BTCPay quotes
the Bitcoin amount at checkout, so the BTC amount changes with the exchange
rate. The gateway creates the BTCPay invoice server-side using an API key scoped
only to invoice creation for this store. It records only an opaque purchase
reference on the invoice, never a Discord name, image, prompt, URL, or local
path.

Configure a BTCPay webhook for `InvoiceSettled` only, pointing to
`https://your-gateway-host/v1/btcpay/webhook`, with the same private webhook
secret. The gateway validates the `BTCPay-Sig` HMAC over the raw request body,
deduplicates webhook delivery IDs, and credits an invoice once. Do not credit at
`InvoiceReceivedPayment` or `InvoiceProcessing`: those events are not final.
