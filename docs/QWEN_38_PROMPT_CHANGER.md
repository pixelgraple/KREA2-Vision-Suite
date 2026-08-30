# Qwen 3.8 Prompt Editor and Text-to-Prompt Creator

The **Qwen 3.8 Prompt Editor** is a conversational AI tool with two tabs:

- **Edit existing prompt** revises complete KREA2 image-generation prompts with ordinary language.
- **Text to prompt** turns a few plain-language sentences about what you want to see into one complete, detailed KREA2-ready prompt.

You do not need to learn prompt syntax or manually rewrite a long description. Give Qwen the current prompt and say what should change:

> Keep everything else, but make her stand with only her left foot on the skateboard and her right foot on the pavement.

Qwen returns a complete prompt. You can continue with another instruction, adopt any editing reply as the current prompt, or copy the result into Krea2. Text-to-Prompt replies are placed into the current-prompt box automatically.

The editor uses the pinned cloud model ID `heretic-3.8-q4-cloud`. It is separate from image interrogation: the Prompt Changer reads the supplied **text prompt**, not the source image.

## What it is for

Use **Edit existing prompt** when a prompt is already close but one or more details need work. Use **Text to prompt** when you have an image concept but no finished prompt yet. Both workflows can develop:

- subject count, apparent adult age, appearance, hairstyle, proportions, and distinguishing details;
- facial expression, gaze direction, head rotation, neck angle, and shoulder position;
- standing, sitting, kneeling, crouching, reclining, balancing, walking, or action poses;
- individual arm, hand, finger, leg, knee, foot, hip, torso, and spine placement;
- contact points, support surfaces, weight-bearing limbs, and interactions between subjects;
- clothing type, construction, fit, fabric, color, pattern, trim, fasteners, layering, and accessories;
- camera height, azimuth, tilt, roll, distance, shot scale, crop, composition, and viewpoint;
- lens character, perspective distortion, depth of field, focus falloff, and photographic look;
- key, fill, rim, practical, ambient, reflected, and environmental lighting;
- light direction, softness, intensity, color temperature, contrast, highlights, and shadows;
- room, street, landscape, architecture, props, foreground, midground, and background;
- palette, texture, weather, atmosphere, film grain, noise, motion blur, flare, and other imperfections;
- wording, length, organization, repetition, tone, density, and KREA2 compatibility.

It can make one precise edit or coordinate several related changes in the same reply.

## Where to open it

The editor is available from several places in the BetterDiscord interface:

1. Click **Qwen Prompt Editor** in the KREA2 Vision header to paste a prompt manually.
2. Open a completed Vision result and select **Edit this prompt with Qwen**.
3. Open a prompt from **Prompt History**, then send that prompt to Qwen.
4. Use the **+** metadata action on a Discord image. If a valid embedded or companion YAML prompt is found, open it directly in Qwen without running Vision first.

The metadata-first route is useful because an existing source prompt can be edited immediately. It does not spend the three credits required for image interrogation; only successful Prompt Changer replies use credits.

## Basic workflow

1. Open **Qwen Prompt Editor**.
2. Confirm that **Current KREA2 prompt** contains the complete prompt you want to revise.
3. In **What should Qwen change?**, describe the requested change in normal language.
4. Select **Send to Qwen**, or press `Ctrl+Enter` on Windows/Linux or `Command+Enter` on macOS.
5. Review the returned complete prompt.
6. Select **Use as current prompt** to continue editing that revision.
7. Select **Copy reply** for one response or **Copy current prompt** for the active version.
8. Select **New chat** when you want to discard the conversation context while retaining the current prompt.

Every assistant reply has its own **Use as current prompt** and **Copy reply** actions. Earlier replies remain visible during the current session, so you can compare alternatives before choosing one.

## Text-to-Prompt workflow

1. Open **Qwen Prompt Editor** and select **Text to prompt**.
2. In **Describe what you want to see**, enter a few sentences covering the essential subject, action or pose, setting, mood, and any must-keep camera or lighting idea.
3. Select **Create prompt**, or press `Ctrl+Enter` on Windows/Linux or `Command+Enter` on macOS.
4. Review the completed prompt that appears automatically in **Generated KREA2 prompt**.
5. Continue in the same conversation with requests such as `make the camera lower`, `keep the pose but change the dress`, or `add harder sunset shadows`.
6. Select **Copy current prompt** when ready.

Example concept:

```text
A confident adult woman in a silver evening gown stands on a rain-soaked neon rooftop at night. The camera is low and close, with wind moving her hair and hard magenta and cyan reflections across the wet concrete.
```

The protected creation instruction asks Qwen to expand relevant subject details, apparent adult age, expression, proportions, clothing, pose, hands, camera, lens character, framing, lighting, shadows, setting, colors, materials, texture, photographic imperfections, and depth of field. It also tells Qwen not to contradict the user's concept and to return only the finished prompt.

Switching between **Edit existing prompt** and **Text to prompt** starts a clean saved conversation in the selected workflow. The conversation being left remains available in local history; creation context is never silently mixed into an existing revision conversation.

## How to ask for accurate changes

The most reliable instruction has three parts:

```text
Preserve: details that must remain unchanged.
Change: the exact visual or writing change.
Constraint: relationships or mistakes that must be avoided.
```

For example:

```text
Preserve her face, hairstyle, outfit, skateboard, street, warm sunlight, and overhead selfie framing.
Change her body to a standing balance pose with her left foot planted on the skateboard and her right foot on the pavement.
Her pelvis is elevated and unsupported; do not describe her as sitting, crouching, or kneeling.
```

This is usually stronger than a vague request such as `fix the pose`.

### Useful instruction patterns

**Single replacement**

```text
Keep everything else unchanged. Replace the red leather jacket with a cropped black denim jacket with silver buttons and frayed cuffs.
```

**Pose correction**

```text
Correct only the pose. She is standing upright in contrapposto, weight on her right leg, left knee relaxed, left foot resting lightly on the step. Her pelvis is not supported by the step, so do not call this sitting.
```

**Camera correction**

```text
Preserve the subject and scene. Rewrite the camera description as a close, high-angle smartphone selfie held above and slightly left of her face, with wide-angle perspective and the near arm enlarged by foreshortening.
```

**Lighting correction**

```text
Keep the composition unchanged. Replace flat studio lighting with hard late-afternoon sunlight from camera right, sharp nose and jaw shadows, warm highlights, cool open-shade fill, and bright rim light along the hair.
```

**Detailed wardrobe pass**

```text
Expand only the outfit description. Identify every visible garment, layer, neckline, sleeve, hem, closure, material, color, pattern, trim, accessory, shoe, and how each item fits or folds. Do not change the pose or setting.
```

**Interaction correction**

```text
Preserve both adult subjects and the camera angle. Make their contact geometry explicit: identify which limbs belong to Subject A and Subject B, where each hand rests, which body supports the other, their facing directions, and every visible contact point. Do not merge their anatomy.
```

**Make a prompt shorter**

```text
Reduce this to about 220 words. Preserve the subject count, pose, contact points, outfit, camera angle, lighting direction, and setting. Remove repetition before removing visible details.
```

**Increase detail without changing content**

```text
Expand this into a highly detailed KREA2 prompt. Add precise camera, lighting, shadow, material, texture, wardrobe-construction, and depth-of-field language, but do not add new people, objects, actions, or scenery.
```

**Change style while preserving geometry**

```text
Keep all subjects, anatomy, pose, framing, and spatial relationships identical. Change only the photographic treatment to a candid 1990s consumer-film snapshot with direct flash, slight underexposure, visible grain, mild color shift, and imperfect focus.
```

## Multi-turn editing

Qwen receives the current conversation, so a large revision can be developed in smaller steps:

```text
User: Make the pose more precise, especially her hips, knees, and feet.
Qwen: [complete revised prompt]

User: Use that version, but keep the original warm window lighting.
Qwen: [complete revised prompt]

User: Now shorten it by 20 percent without removing wardrobe details.
Qwen: [complete revised prompt]
```

After a reply, select **Use as current prompt** before the next turn when that reply should become the working version. This makes your intent explicit and keeps later changes anchored to the correct text.

The active request carries at most 16 bounded conversation messages. Before the 32K model window is exceeded, older inference context is summarized locally and editing continues around the current prompt. The complete raw transcript remains available in paginated local history.

## What Qwen preserves automatically

The server gives Qwen a fixed editing contract. Unless the user requests otherwise, it is instructed to preserve:

- subject identity and count;
- pose, anatomy, and interactions;
- clothing and accessories;
- camera and composition;
- lighting and shadows;
- setting and background;
- color, texture, and photographic character.

For rewrite requests, Qwen is instructed to return only the complete revised prompt—without a preface, Markdown fence, negative prompt, or explanation. If you ask a direct question instead of requesting a rewrite, it may answer briefly.

Automatic preservation is a strong instruction, not a mathematical guarantee. Always review high-impact details such as participant count, left/right limbs, support state, contact points, camera direction, and exact text printed on clothing.

## Important limitation: it cannot see the image

The Prompt Changer does **not** receive or inspect the source image. It works only from:

- the current prompt;
- your natural-language instructions;
- the earlier user and assistant turns in the open editor.

If the starting prompt incorrectly says that someone is sitting, Qwen cannot discover from the pixels that the person is standing. Tell it the correction explicitly, or rerun image interrogation and then edit the new result.

For image-grounded corrections, use this pattern:

```text
The current prompt is wrong about [detail]. In the source image, [direct visual correction]. Preserve [important unchanged details]. Rewrite the full prompt accordingly.
```

## Credits and charging

Prompt editing and Text to Prompt share the same output-based credit contract:

- each valid Qwen reply costs **1 Online API credit per started 350 output tokens**;
- 1–350 output tokens cost 1 credit, 351–700 cost 2 credits, 701–1,050 cost 3 credits, and so on;
- opening or closing the editor costs nothing;
- typing, pasting, copying, selecting a previous reply, or starting a new chat costs nothing;
- the credit is reserved immediately before the remote model request;
- a provider error, timeout, cancellation, invalid response, or failed settlement refunds that reservation;
- stale abandoned reservations are also eligible for automatic recovery;
- a unique request ID prevents the same edit from being charged twice through replay.

Image interrogation remains a different operation with its own three-credit-per-image contract. Editing an existing metadata/YAML prompt does not run image interrogation.

The plugin checks the server's signed credit contract before sending a request. It accepts a result only when the server reports exact output-token accounting, a 350-token billing step, and a matching calculated charge. Unused reserved credits are returned automatically.

## Privacy and data handling

Prompt Changer conversations must be sent to the private cloud inference service because the model runs remotely.

The KREA2 gateway:

- authenticates the user's revocable KREA2 remote license;
- forwards the bounded conversation to the pinned model for inference;
- does not store prompt or reply content in its accounting database;
- stores bounded operational/accounting metadata such as request ID, request digest, account/license association, model ID, credit state, and timestamps;
- returns the reply, confirmed model ID, exact credit charge, and remaining balance.

The BetterDiscord plugin stores each Prompt Editor conversation privately in its local plugin data. Closing the modal only hides it and does not cancel an in-flight edit. Conversations, the current prompt, typed instructions, full transcripts, and compaction receipts survive Discord and plugin restarts. The history sidebar and message transcript are both paginated, and selecting **New chat** archives the current conversation before opening a fresh session with the current prompt still available.

The local history is separate from the model's active context. The full raw conversation remains available for review, but only a bounded rolling context is sent for inference. No local Prompt Editor history is uploaded as a separate dataset or stored by the KREA2 gateway.

The source image is not sent to the Prompt Changer endpoint. If a prompt came from Vision, only the prompt text you place in the editor is used for the edit request.

## Reliability and safety controls

The editor and gateway enforce several boundaries:

- only the pinned `heretic-3.8-q4-cloud` model is accepted;
- streaming is disabled so the plugin can validate a complete result before charging is finalized;
- only `user` and `assistant` conversation roles are accepted from the client;
- the gateway supplies its own protected system instruction;
- model thinking is disabled and hidden reasoning tags are removed from returned text;
- the current prompt is limited to 18,000 characters;
- each editing instruction is limited to 3,000 characters;
- the model context is a visible 32,768-token window, with 1,536 tokens reserved for the reply and 1,024 reserved for protected system/chat formatting;
- when the working context approaches that boundary, older model messages are summarized locally and their raw copies are deleted from the inference context while the full paginated local transcript is retained;
- a returned reply must be nonempty and no larger than 24,000 characters;
- the plugin validates the response model ID, exact output-token count, 350-token billing step, and matching `credits_charged` value;
- a request ID is bound to one license and one exact request digest, preventing altered replay;
- remote failures return a generic user-facing error while the reserved credit is refunded.

These controls are intended to make billing predictable and prevent unverified or cross-account responses from being accepted as successful edits.

## Cold starts and waiting

The Qwen worker can scale down when idle to avoid continuous GPU charges. The first edit after an idle period may therefore take longer while a cloud worker is recruited, the model becomes ready, and the request enters inference.

While waiting:

- the editor may be closed safely; closing only hides it and the active request continues;
- do not repeatedly press **Send to Qwen**;
- the button remains disabled for the active request;
- reopen **Qwen Prompt Editor** to return to the same running or completed conversation;
- a failed or cancelled request is refunded if a credit was reserved.

The editor allows a bounded remote request window of up to eight minutes because cold infrastructure can be slower than a warm reply. A long wait does not itself mean that multiple credits are being charged.

## Troubleshooting

### “Qwen Prompt Editor credit information is still updating”

The plugin could not verify the server's signed 350-output-token credit contract. Wait briefly and retry. No credit was charged.

### “Prompt Editor credits are exhausted”

The account has fewer than one available credit. Use the purchase flow when it is available, or contact the operator if the balance appears incorrect.

### “Qwen Prompt Editor is warming or temporarily unavailable”

The cloud worker did not become ready, timed out, returned unusable output, or had a provider error. The gateway refunds a reserved credit and returns HTTP 503.

### “Prompt Editor request ID was already used”

The server rejected a replay. Send the instruction again; the plugin creates a fresh random request ID for every send.

### The 32K context meter is nearly full

No manual action is normally required. Before the next request exceeds the model window, the plugin creates a bounded local summary around the latest canonical prompt, removes the older raw messages from inference context, and keeps every original message in paginated local history. Select **New chat** only when you intentionally want a separate conversation.

### The result changed details I wanted preserved

Use **Use as current prompt**, then issue a corrective instruction that lists the invariants explicitly:

```text
Restore the original black dress, gold necklace, low camera angle, and hard flash. Keep the new standing pose. Change nothing else.
```

### The result still reflects an incorrect image description

Qwen cannot see the source image. State the observed correction explicitly or rerun Vision interrogation before editing.

## Technical request contract

The BetterDiscord client sends an authenticated HTTPS request to the private gateway's prompt-chat route. Conceptually, the body is:

```json
{
  "model": "heretic-3.8-q4-cloud",
  "messages": [
    {
      "role": "user",
      "content": "Current KREA2 prompt: ... Requested revision: make the lighting warmer."
    }
  ],
  "temperature": 0.35,
  "max_tokens": 1536,
  "stream": false
}
```

A successful response must confirm the pinned model, exact output-token accounting, billing step, and calculated charge:

```json
{
  "reply": "A complete revised KREA2 prompt...",
  "model": "heretic-3.8-q4-cloud",
  "output_tokens": 486,
  "output_tokens_per_credit": 350,
  "credits_charged": 2,
  "available_credits": 119,
  "privacy": "conversation content is forwarded for inference and is not stored by the KREA2 gateway"
}
```

The route is not an anonymous public chatbot API. It requires a valid, revocable KREA2 remote license obtained through the Discord OAuth flow and a unique request ID for every message.

## Prompt Changer versus Vision interrogation

| Capability | Vision interrogation | Qwen 3.8 Prompt Changer |
|---|---|---|
| Input | PNG, JPEG, or WebP image | Existing prompt or a short image concept, plus instructions |
| Sees source pixels | Yes | No |
| Main purpose | Build a new prompt grounded in source-image pixels | Create a prompt from a written concept or revise an existing prompt |
| Default output | One V2 prompt, optionally three | One complete created or revised prompt per reply |
| Conversation | No | Yes, within the current editor session |
| Online credit cost | 3 credits per completed image | 1 credit per started 350 output tokens |
| Metadata/YAML shortcut | Can avoid Vision entirely | Can directly edit extracted prompt text |

The strongest workflow is often:

```text
Source metadata prompt, or Vision interrogation
                    -> review factual accuracy
                    -> Qwen Prompt Changer
                    -> one or more precise natural-language edits
                    -> copy final KREA2 prompt
```

## Design goals

The Prompt Changer is designed to be:

- **natural-language first** — no special commands are required;
- **surgical** — unchanged visual details should remain stable;
- **conversational** — refine the same prompt over several turns;
- **transparent** — the UI states the model, cost, remaining balance, and failure result;
- **recoverable** — background Vision completions do not replace the open editor, and session drafts survive accidental modal dismissal;
- **private by design** — conversation content is transient in the plugin and omitted from the gateway database;
- **fail-closed** — unexpected models, prices, roles, responses, or replayed request IDs are rejected.

It is not intended to replace image interrogation, verify that a prompt matches pixels, persist a permanent prompt library, or silently rewrite prompts without user review.

## Developer verification

The repository includes focused coverage for both editor tabs, creation-request framing, context separation, request routing, output-token contract checks, model-response validation, recovery behavior, and gateway settlement/refund rules:

```bash
node betterdiscord-plugin/Krea2DiscordCollector.prompt-editor.test.js
python -m unittest discover -s remote-gateway/tests -p test_prompt_chat.py -q
```

The complete repository test matrix runs on Windows, Ubuntu, and macOS through GitHub Actions.
