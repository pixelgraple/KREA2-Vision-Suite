"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Plugin = require("./Krea2DiscordCollector.plugin.source.js");
const BuiltPlugin = require("./Krea2DiscordCollector.plugin.js");
const {
    buildPromptFeedbackContext,
    buildVisionCacheProfile,
    buildVisionMultipartBody,
    DEFAULT_SETTINGS,
    detectImageFormat,
    parseVisionPromptResponse,
    readReusableVisionPrompt,
    saveVisionPromptSidecar,
    sha256Hex,
    visionCacheProfileDigest,
    visionRequestCacheKey,
    VISION_PIPELINE_ID
} = Plugin.helpers;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_FORMAT = detectImageFormat(PNG);
const IMAGE_HASH = sha256Hex(PNG);
const MODEL = "llamacpp::heretic-8b-q8_0";
const CORPUS_DIGEST = "c".repeat(64);
const SAMPLE_DIGEST_A = "a".repeat(64);
const SAMPLE_DIGEST_B = "b".repeat(64);
const JOB_A = "1".repeat(32);
const JOB_B = "2".repeat(32);
const EMPTY_FEEDBACK = buildPromptFeedbackContext({});
const PROMPTS = ["balanced", "subject", "scene"].map((focus, promptIndex) => (
    Array.from({length: 180}, (_, index) => `${focus} visible detail ${promptIndex}-${index}`).join(" ")
));

function datasetState(enabled, sampleDigest = SAMPLE_DIGEST_A, feedback = EMPTY_FEEDBACK) {
    return enabled
        ? {
            enabled: true,
            status: "applied",
            corpus_digest: CORPUS_DIGEST,
            sample_digest: sampleDigest,
            sample_count: 8,
            feedback_digest: feedback.digest,
            liked_count: feedback.liked_count,
            disliked_count: feedback.disliked_count,
            blocked_sample_count: feedback.blocked_sample_count
        }
        : {
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
}

function responsePayload(enabled, sampleDigest = SAMPLE_DIGEST_A) {
    return {
        classification: "usable",
        prompt: PROMPTS[0],
        prompt_variants: PROMPTS,
        model: "Heretic Qwen3-VL 8B Q8_0",
        prompt_words: 720,
        pipeline_id: VISION_PIPELINE_ID,
        dataset_guidance: datasetState(enabled, sampleDigest)
    };
}

function multipartValue(body, field) {
    const match = body.toString("latin1").match(new RegExp(`name="${field}"\\r\\n\\r\\n([^\\r]*)`));
    return match?.[1] ?? null;
}

function exactArrayBuffer(buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

test("Krea2 guidance is an opt-in with session-only preference feedback", () => {
    assert.equal(DEFAULT_SETTINGS.useKrea2DatasetGuidance, false);
    assert.equal(DEFAULT_SETTINGS.shareFailureDiagnostics, false);
    const source = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.source.js"), "utf8");
    const modelIndex = source.indexOf('label: "Local GPU Vision model"');
    const toggleIndex = source.indexOf('label: "Guide prompts with the Krea2 example dataset"');
    const notificationIndex = source.indexOf('label: "Show completion notifications"');
    assert.ok(modelIndex >= 0 && toggleIndex > modelIndex && notificationIndex > toggleIndex);
    assert.match(source, /exactly eight Krea2 prompts plus up to four session-liked prompts and three session-disliked prompts/);
    assert.doesNotMatch(source, /label: "Default Prompt Workshop preset"/);
    assert.doesNotMatch(source, /label: "Share accepted metadata with Krea2"/);
});

test("generated single-file plugin contains the same default and multipart contract", () => {
    assert.equal(BuiltPlugin.helpers.DEFAULT_SETTINGS.useKrea2DatasetGuidance, false);
    assert.equal(BuiltPlugin.helpers.DEFAULT_SETTINGS.shareFailureDiagnostics, false);
    assert.equal(BuiltPlugin.helpers.VISION_PIPELINE_ID, VISION_PIPELINE_ID);
    const multipart = BuiltPlugin.helpers.buildVisionMultipartBody(PNG, {
        datasetGuidance: true,
        feedbackContext: EMPTY_FEEDBACK.payload,
        contributionTerms: BuiltPlugin.helpers.KREA2_CONTRIBUTION_TERMS_VERSION,
        diagnosticTerms: BuiltPlugin.helpers.KREA2_DIAGNOSTIC_TERMS_VERSION,
        diagnosticUsername: "garlicjr2"
    });
    assert.equal(multipartValue(multipart.body, "dataset_guidance"), "1");
    assert.equal(multipartValue(multipart.body, "feedback_context"), EMPTY_FEEDBACK.payload);
    assert.equal(multipartValue(multipart.body, "contribution_terms"), BuiltPlugin.helpers.KREA2_CONTRIBUTION_TERMS_VERSION);
    assert.equal(multipartValue(multipart.body, "diagnostic_terms"), BuiltPlugin.helpers.KREA2_DIAGNOSTIC_TERMS_VERSION);
    assert.equal(multipartValue(multipart.body, "diagnostic_username"), "garlicjr2");
    const built = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.js"), "utf8");
    assert.doesNotMatch(built, /Krea2DiscordCollector\.parser\.js/);
});

test("multipart always sends an explicit dataset_guidance value", () => {
    const off = buildVisionMultipartBody(PNG, {filename: `${IMAGE_HASH}.png`, mimeType: "image/png", model: MODEL});
    const on = buildVisionMultipartBody(PNG, {filename: `${IMAGE_HASH}.png`, mimeType: "image/png", model: MODEL, datasetGuidance: true, feedbackContext: EMPTY_FEEDBACK.payload});
    assert.equal(multipartValue(off.body, "dataset_guidance"), "0");
    assert.equal(multipartValue(on.body, "dataset_guidance"), "1");
    assert.equal((off.body.toString("latin1").match(/name="dataset_guidance"/g) || []).length, 1);
    assert.equal((on.body.toString("latin1").match(/name="dataset_guidance"/g) || []).length, 1);
    assert.equal(multipartValue(off.body, "feedback_context"), null);
    assert.equal(multipartValue(on.body, "feedback_context"), EMPTY_FEEDBACK.payload);
});

test("failure diagnostics are absent by default and require the exact separate terms", () => {
    const off = buildVisionMultipartBody(PNG, {filename: "image.png", mimeType: "image/png"});
    const stale = buildVisionMultipartBody(PNG, {diagnosticTerms: "old", diagnosticUsername: "garlicjr2"});
    const on = buildVisionMultipartBody(PNG, {
        diagnosticTerms: Plugin.helpers.KREA2_DIAGNOSTIC_TERMS_VERSION,
        diagnosticUsername: "garlicjr2"
    });
    assert.equal(multipartValue(off.body, "diagnostic_terms"), null);
    assert.equal(multipartValue(stale.body, "diagnostic_terms"), null);
    assert.equal(multipartValue(on.body, "diagnostic_terms"), Plugin.helpers.KREA2_DIAGNOSTIC_TERMS_VERSION);
    assert.equal(multipartValue(on.body, "diagnostic_username"), "garlicjr2");
});

test("successful responses require the v8 skin-pose-surface pipeline and a consistent eight-sample receipt", () => {
    const applied = parseVisionPromptResponse(JSON.stringify(responsePayload(true)), {
        expectedDatasetGuidance: true,
        expectedFeedbackDigest: EMPTY_FEEDBACK.digest
    });
    assert.equal(applied.prompt_variants.length, 3);
    assert.deepEqual(applied.dataset_guidance, datasetState(true));
    assert.equal(applied.pipeline_id, VISION_PIPELINE_ID);

    assert.throws(
        () => parseVisionPromptResponse(JSON.stringify(responsePayload(true)), {expectedDatasetGuidance: false}),
        /wrong Krea2 dataset-guidance state/
    );
    assert.throws(() => {
        const payload = responsePayload(true);
        payload.dataset_guidance.sample_count = 7;
        parseVisionPromptResponse(JSON.stringify(payload), {expectedDatasetGuidance: true});
    }, /exactly 8 Krea2 guidance examples/);
    assert.throws(() => {
        const payload = responsePayload(false);
        payload.pipeline_id = "discord-faithful-v2";
        parseVisionPromptResponse(JSON.stringify(payload), {expectedDatasetGuidance: false});
    }, /incompatible prompt pipeline identity/);
});

test("request keys vary by opt-in, model, preset, pipeline and fresh guided job", () => {
    const base = {model: MODEL, preset: "dataset-detailed", datasetGuidance: false, jobId: JOB_A};
    const offA = visionRequestCacheKey(IMAGE_HASH, base);
    const offB = visionRequestCacheKey(IMAGE_HASH, {...base, jobId: JOB_B});
    assert.equal(offA, offB, "OFF requests remain stable across client job IDs");
    assert.notEqual(offA, visionRequestCacheKey(IMAGE_HASH, {...base, model: "llamacpp::heretic-4b-q8_0"}));
    assert.notEqual(offA, visionRequestCacheKey(IMAGE_HASH, {...base, preset: "photorealistic"}));
    assert.notEqual(offA, visionRequestCacheKey(IMAGE_HASH, {...base, pipelineId: "discord-faithful-v4"}));
    assert.notEqual(offA, visionRequestCacheKey(IMAGE_HASH, {...base, contributionEnabled: true}));
    assert.notEqual(offA, visionRequestCacheKey(IMAGE_HASH, {...base, diagnosticsEnabled: true}));
    const onA = visionRequestCacheKey(IMAGE_HASH, {...base, datasetGuidance: true, feedbackDigest: EMPTY_FEEDBACK.digest, jobId: JOB_A});
    const onB = visionRequestCacheKey(IMAGE_HASH, {...base, datasetGuidance: true, feedbackDigest: EMPTY_FEEDBACK.digest, jobId: JOB_B});
    assert.notEqual(offA, onA);
    assert.notEqual(onA, onB, "each fresh guided job receives a distinct sample identity seed");
    assert.throws(() => visionRequestCacheKey(IMAGE_HASH, {...base, datasetGuidance: true, feedbackDigest: EMPTY_FEEDBACK.digest, jobId: ""}), /stable request job ID/);
});

test("variant sidecars require an exact OFF or ON result identity", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "krea2-guidance-test-"));
    const imagePath = path.join(folder, `${IMAGE_HASH}.png`);
    fs.writeFileSync(imagePath, PNG);
    const offProfile = buildVisionCacheProfile({
        model: MODEL,
        preset: "dataset-detailed",
        pipelineId: VISION_PIPELINE_ID,
        datasetGuidance: datasetState(false)
    });
    const onProfileA = buildVisionCacheProfile({
        model: MODEL,
        preset: "dataset-detailed",
        pipelineId: VISION_PIPELINE_ID,
        datasetGuidance: datasetState(true, SAMPLE_DIGEST_A)
    });
    const onProfileB = buildVisionCacheProfile({
        model: MODEL,
        preset: "dataset-detailed",
        pipelineId: VISION_PIPELINE_ID,
        datasetGuidance: datasetState(true, SAMPLE_DIGEST_B)
    });
    try {
        const offPath = await saveVisionPromptSidecar(imagePath, PROMPTS[0], fs, IMAGE_HASH, PROMPTS, offProfile);
        assert.equal(path.basename(offPath), `${IMAGE_HASH}.vision.${visionCacheProfileDigest(offProfile)}.txt`);
        const bundle = JSON.parse(fs.readFileSync(offPath.replace(/\.txt$/i, ".prompts.json"), "utf8"));
        assert.equal(bundle.schema_version, 2);
        assert.deepEqual(bundle.cache_identity.dataset_guidance, datasetState(false));
        assert.equal((await readReusableVisionPrompt(imagePath, fs, IMAGE_HASH, offProfile))?.prompt_variants.length, 3);
        assert.equal(await readReusableVisionPrompt(imagePath, fs, IMAGE_HASH, onProfileA), null);

        const onPathA = await saveVisionPromptSidecar(imagePath, PROMPTS[0], fs, IMAGE_HASH, PROMPTS, onProfileA);
        const onPathB = await saveVisionPromptSidecar(imagePath, PROMPTS[0], fs, IMAGE_HASH, PROMPTS, onProfileB);
        assert.notEqual(onPathA, onPathB);
        assert.notEqual(onPathA, offPath);
        assert.equal(JSON.parse(fs.readFileSync(onPathA.replace(/\.txt$/i, ".prompts.json"), "utf8")).cache_identity.dataset_guidance.sample_count, 8);

        await saveVisionPromptSidecar(imagePath, PROMPTS[0], fs, IMAGE_HASH, PROMPTS);
        assert.equal((await readReusableVisionPrompt(imagePath, fs, IMAGE_HASH, offProfile))?.sidecarPath, offPath);
    }
    finally {
        fs.rmSync(folder, {recursive: true, force: true});
    }
});

test("loopback requests propagate OFF and ON and bind the response receipt to the sidecar identity", async () => {
    const collector = new Plugin();
    const endpoint = "http://127.0.0.1:7870/api/discord-describe";
    const token = "s".repeat(48);
    const captures = [];
    let responseEnabled = false;
    collector.api = {Data: {load: key => key === "onboardingState" ? {
        version: 9,
        contributionTermsVersion: BuiltPlugin.helpers.KREA2_CONTRIBUTION_TERMS_VERSION
    } : null}, Net: {fetch: async (url, options) => {
        captures.push({url, options});
        if (url.endsWith("/api/discord-session")) {
            const response = Buffer.from(JSON.stringify({
                session_token: "q".repeat(64),
                expires_in_seconds: 120,
                one_time: true
            }), "utf8");
            return {
                ok: true,
                status: 200,
                redirected: false,
                url,
                headers: {get: () => "application/json"},
                arrayBuffer: async () => exactArrayBuffer(response)
            };
        }
        const response = Buffer.from(JSON.stringify(responsePayload(responseEnabled)), "utf8");
        return {
            ok: true,
            status: 200,
            redirected: false,
            url: endpoint,
            headers: {get: name => name.toLowerCase() === "content-type" ? "application/json" : String(response.byteLength)},
            arrayBuffer: async () => exactArrayBuffer(response)
        };
    }}};
    const original = {bytes: PNG, sha256: IMAGE_HASH, format: PNG_FORMAT};
    const local = {filename: `${IMAGE_HASH}.png`};
    const config = {endpoint, origin: "http://127.0.0.1:7870", token, model: MODEL};
    collector.ensureContributionConsent = async () => collector.settings.shareDatasetContributions === true;

    collector.settings = {...DEFAULT_SETTINGS, useKrea2DatasetGuidance: false, shareDatasetContributions: false};
    const off = await collector.requestVisionPrompt(original, local, config, new AbortController().signal, null, {jobId: JOB_A});
    assert.equal(multipartValue(captures.at(-1).options.body, "dataset_guidance"), "0");
    assert.equal(multipartValue(captures.at(-1).options.body, "contribution_terms"), null);
    assert.equal(off.cache_identity.dataset_guidance.enabled, false);

    responseEnabled = true;
    collector.settings.useKrea2DatasetGuidance = true;
    collector.settings.shareDatasetContributions = true;
    const on = await collector.requestVisionPrompt(original, local, config, new AbortController().signal, null, {jobId: JOB_B});
    assert.equal(multipartValue(captures.at(-1).options.body, "dataset_guidance"), "1");
    assert.equal(multipartValue(captures.at(-1).options.body, "contribution_terms"), BuiltPlugin.helpers.KREA2_CONTRIBUTION_TERMS_VERSION);
    assert.equal(multipartValue(captures.at(-1).options.body, "feedback_context"), EMPTY_FEEDBACK.payload);
    assert.equal(on.cache_identity.dataset_guidance.sample_count, 8);
    assert.equal(on.cache_identity.dataset_guidance.feedback_digest, EMPTY_FEEDBACK.digest);
    const imageRequests = captures.filter(item => item.url === endpoint);
    assert.notEqual(imageRequests[0].options.headers["X-Idempotency-Key"], imageRequests[1].options.headers["X-Idempotency-Key"]);
    assert.equal(imageRequests.every(item => item.options.headers["X-Krea2-Vision-Token"] === undefined), true);
    assert.equal(imageRequests.every(item => item.options.headers["X-Krea2-Vision-Session"] === "q".repeat(64)), true);
});

test("the user-facing plugin removes image-level contribution and keeps all generation on the central request path", () => {
    const source = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.source.js"), "utf8");
    assert.doesNotMatch(source, /canUseMetadataPlus\(\)/);
    assert.doesNotMatch(source, /void this\.collectImage\(image, plusButton\)/);
    assert.match(source, /Automatically contribute my three generated prompts to Krea2/);
    assert.doesNotMatch(source, /fragment\.append\(this\.createJobProductTabs/);
    assert.doesNotMatch(source, /actions\.append\(tools, refresh, close\)/);
    assert.doesNotMatch(source, /label: "Default Prompt Workshop preset"/);
    assert.doesNotMatch(source, /label: "Share accepted metadata with Krea2"/);
    assert.match(source, /feedbackContext: feedbackContext\?\.payload \|\| ""/);
    assert.match(source, /expectedFeedbackDigest: datasetGuidance \? feedbackContext\.digest : null/);
    assert.match(source, /const queued = this\.getOrQueueVisionJob\(requestCacheKey,/);
    assert.doesNotMatch(source, /getOrQueueVisionJob\(original\.sha256,/);
    assert.match(source, /this\.visionInflightByRequest\.get\(key\)/);
    assert.doesNotMatch(source, /visionInflightByHash/);
});
