"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Plugin = require("./Krea2DiscordCollector.plugin.js");

const {
    DEFAULT_SETTINGS,
    VISION_PIPELINE_ID,
    buildVisionMultipartBody,
    effectiveVisionPromptCount,
    parseVisionPromptResponse,
    visibleHistoryPromptVariants,
    visionRequestCacheKey
} = Plugin.helpers;

const disabledGuidance = {
    enabled: false,
    status: "disabled",
    corpus_digest: null,
    sample_digest: null,
    sample_count: 0,
    feedback_digest: null,
    liked_count: 0,
    disliked_count: 0,
    blocked_sample_count: 0
};
const prompt = suffix => (`A clearly adult subject is described with exact pose, clothing, camera geometry, directional light, cast shadows, materials, textures, foreground, midground, background, and faithful colors. `.repeat(12) + suffix).trim();
const response = variants => JSON.stringify({
    classification: "usable",
    pipeline_id: VISION_PIPELINE_ID,
    dataset_guidance: disabledGuidance,
    prompt: variants[0],
    prompt_variants: variants,
    model: "V2 test model",
    prompt_words: 180,
    pose_check: {
        subject_count: 1,
        primary_posture: "standing",
        pelvis_support: "not_supported",
        pelvis_support_surface: "none",
        left_foot_weight_bearing: true,
        left_foot_surface: "skateboard deck",
        right_foot_weight_bearing: true,
        right_foot_surface: "asphalt",
        knee_flexion: "slight",
        hip_height_relative_to_knees: "above",
        other_weight_bearing_support: "none",
        camera_view: "steep overhead selfie"
    }
});

assert.equal(DEFAULT_SETTINGS.v2ThreePromptVariations, false);
assert.equal(DEFAULT_SETTINGS.visionAnalysisProfile, "v2");
assert.equal(DEFAULT_SETTINGS.visionAnalysisProfileVersion, 3);
assert.equal(effectiveVisionPromptCount(DEFAULT_SETTINGS, "v2"), 1);
assert.equal(effectiveVisionPromptCount({...DEFAULT_SETTINGS, v2ThreePromptVariations: true}, "v2"), 3);
assert.equal(effectiveVisionPromptCount(DEFAULT_SETTINGS, "fast"), 3);

for (const count of [1, 3]) {
    const multipart = buildVisionMultipartBody(Buffer.from("image"), {
        filename: "test.jpg",
        mimeType: "image/jpeg",
        model: "vast::test",
        analysisProfile: "v2",
        promptCount: count
    });
    assert.match(multipart.body.toString("utf8"), new RegExp(`name="prompt_count"\\r\\n\\r\\n${count}`));
}

const imageHash = "a".repeat(64);
const commonKey = {model: "vast::test", analysisProfile: "v2", preset: "dataset-detailed"};
assert.notEqual(
    visionRequestCacheKey(imageHash, {...commonKey, promptCount: 1}),
    visionRequestCacheKey(imageHash, {...commonKey, promptCount: 3})
);

const one = [prompt("One.")];
const three = [prompt("Balanced."), prompt("Subject and pose."), prompt("Scene and light.")];
const parsedOne = parseVisionPromptResponse(response(one), {expectedPromptCount: 1});
assert.equal(parsedOne.prompt_variants.length, 1);
assert.equal(parsedOne.pose_check.primary_posture, "standing");
assert.equal(parseVisionPromptResponse(response(three), {expectedPromptCount: 3}).prompt_variants.length, 3);
assert.throws(() => parseVisionPromptResponse(response(one), {expectedPromptCount: 3}), /exactly three|when 3 were requested/);
assert.throws(() => parseVisionPromptResponse(response(three.slice(0, 2)), {expectedPromptCount: 1}), /when 1 were requested/);

const v2ThreePromptJob = {
    prompt: three[0],
    prompt_variants: three,
    model: "Dedicated RTX 3090 — V2 Direct Fidelity",
    reproducibility: {analysis_profile: "v2", prompt_variant_count: 3}
};
assert.deepEqual(visibleHistoryPromptVariants(v2ThreePromptJob, {v2ThreePromptVariations: false}), [three[0]]);
assert.deepEqual(visibleHistoryPromptVariants(v2ThreePromptJob, {v2ThreePromptVariations: true}), three);
assert.deepEqual(
    visibleHistoryPromptVariants({...v2ThreePromptJob, prompt: one[0], prompt_variants: one}, {v2ThreePromptVariations: true}),
    one
);
assert.deepEqual(
    visibleHistoryPromptVariants({...v2ThreePromptJob, model: "Maximum detail", reproducibility: {analysis_profile: "maximum"}}, {v2ThreePromptVariations: false}),
    three
);

const source = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.js"), "utf8");
assert.doesNotMatch(source, /\["V2", "v2"\]/);
assert.match(source, /v2Toggle\.setAttribute\("role", "switch"\)/);
assert.match(source, /Use V2 Direct Fidelity/);
assert.match(source, /storedSettings\.visionAnalysisProfileVersion\) \|\| 0\) < 3/);
assert.match(source, /output\.append\(variantTabs, prompt, feedback, editVariant, auditVariant, copyVariant\)/);
assert.match(source, /variants\.length === 1\s*\? \["Prompt"\]/);
assert.match(source, /Generate three V2 prompt variations/);

console.log("BetterDiscord V2 single/three-output tests passed.");
