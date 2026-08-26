"use strict";

const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const Plugin = require("./Krea2DiscordCollector.plugin.source.js");
const {
    buildPromptFeedbackContext,
    buildVisionMultipartBody,
    DEFAULT_SETTINGS,
    normalizePromptFeedbackText,
    parseVisionPromptResponse,
    sanitizePromptFeedbackRecord,
    sha256Hex,
    VISION_PIPELINE_ID
} = Plugin.helpers;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PROMPTS = ["balanced", "subject", "scene"].map(focus => (
    Array.from({length: 180}, (_, index) => `${focus} visible grounded detail ${index}`).join(" ")
));

function record(label, vote, updated, reason = "") {
    const prompt = normalizePromptFeedbackText(
        `${label} detailed grounded prompt with subject pose camera framing clothing texture lighting and background. `.repeat(12)
    );
    return sanitizePromptFeedbackRecord({
        prompt,
        vote,
        reason,
        sample_digest: vote === "disliked" ? createHash("sha256").update(`sample-${label}`).digest("hex") : "",
        updated
    });
}

function multipartValue(body, field) {
    const match = body.toString("latin1").match(new RegExp(`name="${field}"\\r\\n\\r\\n([^\\r]*)`));
    return match?.[1] ?? null;
}

test("feedback is session-only and inert while Krea2 guidance remains default off", () => {
    assert.equal(DEFAULT_SETTINGS.useKrea2DatasetGuidance, false);
    const multipart = buildVisionMultipartBody(PNG, {
        datasetGuidance: false,
        feedbackContext: buildPromptFeedbackContext({}).payload
    });
    assert.equal(multipartValue(multipart.body, "dataset_guidance"), "0");
    assert.equal(multipartValue(multipart.body, "feedback_context"), null);
});

test("a guided request selects at most four liked and three disliked records", () => {
    const records = {};
    for (let index = 0; index < 7; index += 1) {
        const item = record(`liked-${index}`, "liked", index);
        records[item.id] = item;
    }
    for (let index = 0; index < 6; index += 1) {
        const item = record(`disliked-${index}`, "disliked", 100 + index, `avoid problem ${index}`);
        records[item.id] = item;
    }
    const context = buildPromptFeedbackContext(records, () => 0.25);
    const payload = JSON.parse(context.payload);
    assert.equal(payload.liked.length, 4);
    assert.equal(payload.disliked.length, 3);
    assert.equal(payload.blocked_sample_digests.length, 6);
    assert.equal(context.liked_count, 4);
    assert.equal(context.disliked_count, 3);
    assert.match(context.digest, /^[a-f0-9]{64}$/);
    assert.equal(context.payload.includes("avoid problem"), true);
});

test("feedback payload and digest are sent only for guided generation and must be echoed", () => {
    const liked = record("liked-one", "liked", 1);
    const disliked = record("disliked-one", "disliked", 2, "avoid losing the exact pose");
    const context = buildPromptFeedbackContext({[liked.id]: liked, [disliked.id]: disliked}, () => 0);
    const multipart = buildVisionMultipartBody(PNG, {datasetGuidance: true, feedbackContext: context.payload});
    assert.equal(multipartValue(multipart.body, "feedback_context"), context.payload);

    const response = {
        classification: "usable",
        prompt: PROMPTS[0],
        prompt_variants: PROMPTS,
        model: "Heretic Qwen3-VL 8B Q8_0",
        prompt_words: 540,
        pipeline_id: VISION_PIPELINE_ID,
        dataset_guidance: {
            enabled: true,
            status: "applied",
            corpus_digest: "c".repeat(64),
            sample_digest: "d".repeat(64),
            sample_count: 8,
            feedback_digest: context.digest,
            liked_count: 1,
            disliked_count: 1,
            blocked_sample_count: 1
        }
    };
    assert.equal(
        parseVisionPromptResponse(JSON.stringify(response), {
            expectedDatasetGuidance: true,
            expectedFeedbackDigest: context.digest
        }).dataset_guidance.feedback_digest,
        context.digest
    );
    assert.throws(
        () => parseVisionPromptResponse(JSON.stringify(response), {
            expectedDatasetGuidance: true,
            expectedFeedbackDigest: "0".repeat(64)
        }),
        /exact local-feedback guidance context/
    );
});

test("the visible result UI contains voting and omits the retired product tools", () => {
    const source = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.source.js"), "utf8");
    assert.match(source, /like\.textContent = "👍 Like"/);
    assert.match(source, /dislike\.textContent = "👎 Needs work"/);
    assert.match(source, /What should the model avoid next time\?/);
    assert.doesNotMatch(source, /this\.api\.Data\.save\("promptFeedback", this\.promptFeedback\)/);
    assert.match(source, /"promptFeedback"\]\) \{/);
    assert.match(source, /feedback lasts only for this Discord session/);
    assert.doesNotMatch(source, /fragment\.append\(this\.createJobProductTabs/);
    assert.doesNotMatch(source, /actions\.append\(tools, refresh, close\)/);
    assert.doesNotMatch(source, /label: "Default Prompt Workshop preset"/);
    assert.doesNotMatch(source, /label: "Share accepted metadata with Krea2"/);
    assert.equal(sha256Hex(Buffer.from(normalizePromptFeedbackText(likedPrompt()), "utf8")).length, 64);
});

function likedPrompt() {
    return "a grounded prompt with pose camera framing wardrobe texture lighting and background ".repeat(12);
}
