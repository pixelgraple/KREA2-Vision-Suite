# Vision and prompting

## Why multiple passes exist

A single caption request often misses pose mechanics, swaps participant attributes, invents off-frame details, or spends too many words on generic quality language. KREA2 separates evidence collection from final writing so later stages can audit earlier claims against the image.

## Evidence stages

### 1. Subject census and appearance

The model counts every visible person and assigns stable Subject A/B/C labels. Each subject is described separately: presentation, directly visible anatomy, face, hair, skin, marks, wardrobe, accessories, visible limbs, expression, gaze, action, and contacts.

Identity is not inferred from presentation, clothing, body shape, or anatomy. An uploader note may supply known identity labels or pronouns for the current session; that note is preserved as supplied context, not presented as pixel evidence.

### 2. Scene inventory

Foreground, midground, and background are mapped independently. Objects receive frame-relative placement, depth, overlap, occlusion, and activity. Text is transcribed only when clearly readable.

### 3. Visual construction

The model records shot scale, apparent distance, camera height and direction, focus plane, depth of field, motion, light source/direction/softness/color, highlights, shadows, reflections, materials, texture, color palette, contrast, and visible processing.

### 4. Pose and interaction geometry

The pose pass starts with visible weight-bearing contacts and traces every visible limb independently. It records joint bends, hip-to-knee relation, stance width, foot offset, torso pitch, spine, abdominal compression/extension, pelvis, shoulders, head, neck, gaze, foreshortening, overlaps, and contact between subjects or props.

Conventional pose names never replace geometry. A label such as standing, kneeling, all fours, missionary, or rear-entry may be used only when visible support and participant geometry establish it.

### 5. Detail crops

Three region-specific crops provide higher-detail evidence for important areas while retaining a full-image reference. Crops are evidence aids, not permission to infer what lies outside their boundaries.

### 6. Pose verification

An independent check attempts to falsify the proposed support state and contact map. If feet, knees, pelvis, or support surfaces are not visible enough to distinguish standing from kneeling or sitting, the state remains uncertain.

### 7. Reconstruction audit

The merged evidence is compared with the original image for subject count, attribute binding, pose, wardrobe, anatomy, props, scene, camera, light, and unsupported additions.

## Draft, image audit, and three variants

The model writes one image-grounded draft. Exactly one final image audit returns concrete corrections. The corrected evidence then produces three 350-850 word variants with balanced, subject/pose, and scene/light emphasis.

The variants must remain semantically consistent. The pipeline strips angle-bracket LoRA syntax and rejects negative prompts, policy/refusal boilerplate, duplicate variants, malformed wrappers, insufficient visual detail, and unsupported categorical claims.

If batched structured output is malformed, a bounded fallback writes each variant separately from the same audited evidence. This is formatting recovery, not a second visual analysis.

## Modern models versus the legacy prompter

For modern multimodal Qwen/Gemma routes, the selected Vision model writes and audits its own final prompts. This avoids losing image evidence through a second unrelated text model.

`babegen-prompter:9b-q5` remains available only in the explicitly selected legacy Ollama hybrid. It is useful for compatibility with older setups but is not required for Gemma or Qwen Heretic routes.

## Output guarantees and limits

The system attempts to guarantee exactly three distinct 350-850 word variants, no angle-bracket LoRA tokens, no unsupported hidden anatomy or off-frame pose completion, stable participant binding, and positive image-generation prompt text.

No Vision model is perfectly reliable. The plugin exposes exact model identity, feedback, retries, and multiple variants so users can inspect and compare results.
