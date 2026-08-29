# Region Inpaint Prompt Correction

**Region Inpaint Prompt Correction** repairs a generated KREA2 prompt by grounding one requested change in a selected area of the source image. It changes prompt text; it does not alter image pixels or generate a replacement image.

## When to use it

Use region correction when the full prompt is mostly useful but Vision misunderstood a local fact, for example:

- standing versus sitting;
- which foot is on a skateboard and which foot bears weight on the ground;
- a hand gripping an object instead of resting beside it;
- the exact construction, trim, fabric, fasteners, or layering of an outfit;
- gaze, mouth shape, head rotation, neck angle, or shoulder position;
- a partially hidden prop, contact point, tattoo, accessory, shadow, reflection, or background object.

Use the ordinary Qwen Prompt Editor when the requested change is creative and does not need evidence from the image.

## Workflow

1. Open a completed image in **Prompt History**.
2. If three prompt variations are enabled, select the variation to correct.
3. Select **Inpaint prompt region**.
4. Drag a box tightly around the relevant pixels. The selection keeps a small context border when it is encoded.
5. Explain what the current prompt got wrong and what the visible relationship should be.
6. Select **Inspect region and rewrite prompt**.
7. Review **Current prompt**, **Vision evidence from selected pixels**, and **Proposed corrected prompt**.
8. Select **Adopt correction** only when the proposal is better. You can instead copy it or continue refining it in the Qwen Prompt Editor.

The target prompt variation is locked when the correction panel opens, so changing tabs cannot silently apply the result to a different variation.

## Writing an effective correction

Describe the relationship that distinguishes the correct interpretation. A strong request names the object, body part, contact point, and forbidden mistake:

```text
She is standing and balancing. Her left foot is planted on the skateboard, her right foot is on the pavement, and her pelvis is elevated with no seated support. Do not describe her as sitting or crouching.
```

For clothing:

```text
Correct the selected bodice: it is burgundy satin with black lace overlay, black ribbon lacing through metal eyelets, scalloped trim, and off-shoulder straps. Preserve the rest of the outfit and scene.
```

The selected pixels are treated as authoritative only for facts directly visible inside that crop. The rewrite instruction explicitly preserves unrelated subject, pose, anatomy, outfit, camera, lighting, environment, color, texture, and photographic details.

## Image handling and privacy

The plugin converts the on-screen selection back to the image's natural pixel coordinates, adds a ten-percent context border, and produces a high-quality PNG crop capped at 1,600 pixels on its longest side. Only that crop enters the new Vision request. The full source image is not resent for this correction step.

With Local GPU Vision, the crop follows the same local shared GPU FIFO as ordinary interrogation. With Online Cloud Vision, the selected crop is sent over the existing authenticated HTTPS Vision path. The Qwen rewrite receives the current text prompt, the returned region evidence, and the requested correction; it does not receive the source image directly.

Masks, region evidence, and proposed prompts are session-only and are not added to persistent plugin settings. Closing the result aborts pending region work. The ordinary privacy and optional dataset/diagnostic settings remain unchanged.

Current-session results normally retain a full-resolution in-memory preview. After Discord or the plugin restarts, older Prompt History entries may have only the bounded local history thumbnail, so very small details can be less precise.

## Credits and refunds

| Configuration | Successful region inspection | Successful Qwen rewrite | Total successful correction |
|---|---:|---:|---:|
| Online Cloud Vision | 3 credits | 1 credit | 4 credits |
| Local GPU Vision | 0 Online API credits | 1 credit | 1 credit |

The plugin checks that enough credits exist before starting the chain. Vision and Qwen retain separate request IDs and reservations. A failed or cancelled Vision stage refunds its three-credit reservation. A failed or cancelled Qwen stage refunds its one-credit reservation. If Vision succeeds but the later rewrite fails, the completed Vision inspection remains a valid three-credit result while the failed Qwen credit is refunded.

Drawing or clearing a mask, typing an instruction, reviewing evidence, copying a proposal, and adopting a proposal do not themselves use credits.

## Queue behavior

Crop inspection uses the existing Vision submission path and shared FIFO. It does not bypass Forge, KreaForge, or another Vision job. A local model follows the established GPU admission and unload rules. Online mode follows the established remote worker warm/cold lifecycle. The Qwen rewrite begins only after usable region evidence is returned.

## Failure behavior

The original prompt is never replaced on failure. Common messages mean:

- **source preview unavailable** — the history entry no longer has a usable local thumbnail;
- **draw a region mask** — the selected box is too small;
- **complete current prompt required** — the selected result has no usable prompt text;
- **Vision did not return usable evidence** — the crop could not be grounded reliably;
- **credits exhausted** — purchase credits or select a configured local Vision model;
- **GPU not available / warming** — the normal Vision provider is not ready yet.

Retry with a tighter but still contextual crop, a more relational instruction, or the original full-resolution result from the current Discord session.
