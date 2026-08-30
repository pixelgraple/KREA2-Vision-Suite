# Qwen 3.8 Discord Chat

KREA2 Vision Suite includes a general-purpose Qwen 3.8 chat directly inside BetterDiscord. It is separate from image interrogation and Qwen Prompt Editor.

## Open Qwen Chat

The plugin places a circular **Q3.8** launcher above Discord's server icons. The launcher is pinned outside the scrolling server list, so it remains available when the server list scrolls and while Discord changes servers, channels, threads, or direct messages.

Select **Q3.8** to open the chat. Closing the window hides it without deleting the conversation. If a reply is running, it continues safely and a completion notification appears when it finishes.

## What it can do

Qwen Chat can help with:

- questions and explanations;
- writing, rewriting, brainstorming, and planning;
- code generation, review, debugging, and technical instructions;
- image prompts and creative direction;
- complete downloadable text, code, configuration, Markdown, JSON, YAML, HTML, CSS, JavaScript, Python, PHP, PowerShell, SQL, and similar files.

Qwen cannot see the active Discord channel, other messages, the computer, or an image unless the relevant text is included in the conversation. The first release does not upload binary attachments to the model.

## Receive files

Every assistant reply has:

- **Copy reply**;
- **Download reply (.md)**;
- a separate **Download _filename_** button for every fenced text/code block in that reply.

When a file is requested, the protected cloud instruction asks Qwen to return the complete contents in a fenced block whose header includes `filename=...`. The plugin sanitizes the suggested filename before downloading it. A code block without a filename receives a safe generated name such as `qwen-file-1.py`.

Use **Download chat** to save the full visible conversation as Markdown.

## Conversation history and 32K context

Complete transcripts, unfinished drafts, titles, status receipts, and conversation indexes are saved only in BetterDiscord's local plugin data. They survive closing the modal, Discord restarts, and plugin reloads. Select any saved conversation from paginated **Chat history** to resume it.

The active model window is 32,768 tokens. The meter includes protected system and reply capacity. When the next request would exceed the bounded 32K working set or message-count limit, older inference messages are summarized locally and removed from the outbound model context. Recent messages remain verbatim, and the complete raw transcript remains available in local pagination.

## Credits

Qwen Chat and Qwen Prompt Editor use the same server-enforced rate:

- 1–350 output tokens: 1 credit;
- 351–700 output tokens: 2 credits;
- 701–1,050 output tokens: 3 credits;
- and so on.

Opening, closing, typing, copying, browsing history, starting a new chat, and downloading local files cost nothing. Credits are reserved immediately before inference. Unused reserved credits are returned, and failed, invalid, cancelled, or timed-out work is refunded.

## Privacy and security

The bounded active conversation is sent over authenticated HTTPS to the private KREA2 gateway and dedicated Qwen worker for inference. Conversation content is not stored in the gateway database. The database retains only privacy-minimal job, license, request-digest, timing, and credit-ledger records required for authentication, replay protection, billing, settlement, and refunds.

The client accepts only `user` and `assistant` conversation roles. A protected server-owned system instruction selects the general-chat experience and cannot be replaced by a client-supplied system message. Prompt Editor uses a different protected mode, so its rewrite-only behavior cannot contaminate ordinary chat.

## Keyboard and background behavior

- `Ctrl+Enter` on Windows/Linux or `Command+Enter` on macOS sends the message.
- `Escape`, the close icon, the footer **Close** button, or selecting the backdrop hides the window.
- Closing during an active reply does not cancel it.
- The pinned icon changes color while Qwen is working.

## Troubleshooting

If Qwen reports that it is warming or temporarily unavailable, wait briefly and retry. No credit is charged for that failed attempt. The shared dedicated GPU can run Vision or Qwen, but not both models simultaneously; requests are serialized through one FIFO and the router unloads one model before loading the other.

If the pinned icon disappears after a Discord UI update, reload Discord once. The plugin watches Discord's server-sidebar DOM and restores the launcher automatically when that navigation is recreated.
