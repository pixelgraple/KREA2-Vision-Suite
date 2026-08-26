# KREA2 guidance and data

KREA2 includes three separate concepts:

1. read-only writing guidance from approved examples;
2. local feedback guidance from liked/disliked results;
3. optional contribution of newly generated prompt text.

## Eight-example writing guidance

This option is off by default. When enabled, the local broker reads the approved KREA2 prompt dataset and samples exactly eight unique prompt records using a cryptographically strong random source.

The samples are text prompts, not images. No dataset source images are downloaded by this feature.

The composer receives bounded excerpts and an explicit contract:

- imitate wording rhythm, density, detail order, layout, and sentence structure;
- target roughly 60% structural/style resemblance and 40% fresh composition;
- ground 100% of subjects, anatomy, objects, actions, setting, pose, camera, and lighting in the current image evidence;
- never copy factual content from examples into the current image;
- still produce the balanced, subject/pose, and scene/light variants.

## Dataset revision and sampling identity

The dataset response includes a revision. KREA2 canonicalizes the eight opaque record IDs and hashes them with the revision to produce a sample digest. The guidance setting, dataset revision, and sample identity participate in idempotency/cache identity so a guided result cannot be confused with an unguided result.

## Likes, dislikes, and blocked combinations

Feedback is local and session-oriented:

- up to four liked prompts may be supplied as positive style examples;
- up to three disliked prompts may be supplied with plain-English reasons;
- the digest of a downvoted eight-example combination is blocked;
- canonical ordering means the same eight examples remain blocked even if their order changes.

Feedback teaches wording preference only. It may not override current image evidence.

## Optional prompt contribution

If the user enables contribution and accepts the current disclosure, each successful generation submits exactly three prompt texts plus bounded model/pipeline provenance to the canonical Seedframe endpoint.

The contribution path excludes source image bytes, Discord identity, Discord URLs, attachment filename/URL, local filesystem paths, and source image hashes. Submissions are candidate records, not automatically approved training examples. Seedframe curation determines whether a candidate becomes part of the approved corpus.

## Independence of controls

- Guidance can be on while contribution is off.
- Contribution can be on while guidance is off.
- Turning both off leaves ordinary Vision inference fully functional.
- Required privacy-minimal operational errors are not prompt contribution. Optional rich failure diagnostics have separate consent.

## Future training

The eight-example system is in-context guidance, not model training and not a LoRA. A future LoRA would require a separately licensed, reviewed, deduplicated, quality-scored training dataset and its own privacy/consent process.
