"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Plugin = require("./Krea2DiscordCollector.plugin.js");
const {
    applyPromptPreset,
    buildOperationalErrorReport,
    buildVisionMultipartBody,
    chooseBestMediaUrl,
    clearHistoryThumbnailCache,
    decodeHtmlEntities,
    DEFAULT_SETTINGS,
    detectImageFormat,
    effectiveVisionModel,
    evaluatePromptValue,
    extractConfidentPrompt,
    extractMediaProvenance,
    filenameFromContentDisposition,
    filenameFromUrl,
    filterHistoryJobs,
    formatAverageQueueTime,
    formatDownloadGiB,
    formatHistoryDuration,
    formatVramMiB,
    historyBaseUrlFromVisionEndpoint,
    historyThumbnailCacheCandidates,
    historyThumbnailCacheDirectory,
    historyJobMatchesModel,
    historyModelEvidence,
    historyJobTitle,
    historyAverageQueueWait,
    historyQueueWaitSeconds,
    inferMimeType,
    invalidGuildAllowlistEntries,
    isFileCompat,
    isExcludedAssetUrl,
    isGuildAllowed,
    isHistoryJobActive,
    isCurrentPrivacyReceipt,
    isMetadataPlusOwner,
    isVisionSupportedFormat,
    metadataProbeCacheKey,
    mergeHereticModelTelemetry,
    normalizeMediaUrl,
    normalizeUpdateMode,
    normalizeVisionExecutionMode,
    normalizeStoredSubmissionKey,
    normalizeVisionPrompt,
    parseDiscordRoute,
    parseGuildAllowlist,
    parseHistoryDetailResponse,
    parseHistoryListResponse,
    parseStudioErrorDetail,
    parseUploadResponse,
    parseVisionPromptResponse,
    ONLINE_VISION_MODEL_ID,
    PRIVACY_RECEIPT_VERSION,
    promptDiffSummary,
    promptPresetGuidance,
    readBoundedResponseText,
    readFileCompat,
    readReusableVisionPrompt,
    saveOriginalImage,
    savePromptSidecar,
    saveVisionPromptSidecar,
    safeModelFilePart,
    sanitizeFilename,
    sanitizeOperationalErrorText,
    sha256Hex,
    submissionKey,
    validateSaveFolder,
    validateEndpoint,
    validateVisionLoopbackEndpoint,
    visionModelDisplayName,
    VISION_PIPELINE_ID,
    writeFileCompat
} = Plugin.helpers;

function pngChunk(type, payload = Buffer.alloc(0)) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    return Buffer.concat([length, Buffer.from(type, "ascii"), payload, Buffer.alloc(4)]);
}

function pngWithText(keyword, value) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = pngChunk("IHDR", Buffer.alloc(13));
    const text = keyword === null
        ? Buffer.alloc(0)
        : pngChunk("tEXt", Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(value, "latin1")]));
    return Buffer.concat([signature, ihdr, text, pngChunk("IEND")]);
}

async function run() {
const backendContract = fs.readFileSync(
    path.join(__dirname, "..", "vision-studio", "app", "services", "discord_vision.py"),
    "utf8"
);
const backendPipelineId = backendContract.match(/^PIPELINE_ID\s*=\s*["']([^"']+)["']/m)?.[1] || "";
assert.equal(
    VISION_PIPELINE_ID,
    backendPipelineId,
    "BetterDiscord and the Vision backend must ship with the same pipeline identity"
);
assert.deepEqual(parseDiscordRoute("/channels/123456789/987654321"), {
    guildId: "123456789",
    channelId: "987654321"
});
assert.deepEqual(parseDiscordRoute("/settings/plugins"), {guildId: null, channelId: null});

assert.deepEqual([...parseGuildAllowlist("123456, 987654\n123456")], ["123456", "987654"]);
assert.equal(isGuildAllowed("987654", "123456, 987654"), true);
assert.equal(isGuildAllowed("@me", "123456"), false);
assert.deepEqual(invalidGuildAllowlistEntries("123456, nope, 7"), ["nope", "7"]);
assert.equal(isMetadataPlusOwner("123456789012345678", "123456789012345678"), true);
assert.equal(isMetadataPlusOwner("123456789012345678", "987654321098765432"), false);
assert.equal(isMetadataPlusOwner("123456789012345678", ""), false);
assert.equal(isMetadataPlusOwner("", "123456789012345678"), false);
assert.equal(metadataProbeCacheKey({
    kind: "attachment",
    attachmentChannelId: "111111",
    attachmentId: "222222",
    path: "/attachments/111111/222222/image.png"
}), "attachment:111111:222222:/attachments/111111/222222/image.png");
assert.equal(metadataProbeCacheKey({kind: "attachment"}), null);

assert.equal(validateEndpoint("https://seedframe.example/candidates").ok, true);
assert.equal(validateEndpoint("http://127.0.0.1:8787/candidates").ok, true);
assert.equal(validateEndpoint("http://seedframe.example/candidates").ok, false);
assert.equal(validateEndpoint("https://token@seedframe.example/candidates").ok, false);
assert.equal(isCurrentPrivacyReceipt(null), false);
assert.equal(isCurrentPrivacyReceipt({version: PRIVACY_RECEIPT_VERSION}), false);
assert.equal(isCurrentPrivacyReceipt({version: PRIVACY_RECEIPT_VERSION - 1, acceptedAt: Date.now()}), false);
assert.equal(isCurrentPrivacyReceipt({version: PRIVACY_RECEIPT_VERSION, acceptedAt: Date.now()}), true);
assert.equal(visionModelDisplayName("llamacpp::heretic-8b-q8_0"), "Heretic — Qwen3-VL 8B Q8_0");
assert.equal(visionModelDisplayName("discord::legacy-ollama-hybrid"), "Legacy Ollama hybrid");
assert.equal(visionModelDisplayName("custom::model"), "custom::model");
assert.equal(normalizeVisionExecutionMode("ONLINE"), "online");
assert.equal(normalizeVisionExecutionMode("anything-else"), "local");
assert.equal(effectiveVisionModel({...DEFAULT_SETTINGS, visionExecutionMode: "online"}), ONLINE_VISION_MODEL_ID);
assert.equal(effectiveVisionModel({...DEFAULT_SETTINGS, visionExecutionMode: "local", visionModel: "llamacpp::heretic-4b-q8_0"}), "llamacpp::heretic-4b-q8_0");

async function testStaleContributionConsentRepromptsOrFallsBackToOptOut() {
    const collector = new Plugin();
    let receipt = null;
    let settingsSaves = 0;
    collector.settings = {
        ...DEFAULT_SETTINGS,
        shareDatasetContributions: true,
        visionEndpoint: "http://127.0.0.1:7870/api/discord-describe",
        visionToken: "v".repeat(48)
    };
    collector.api = {Data: {load: key => key === "privacyReceipt" ? receipt : null}};
    collector.saveSettings = () => { settingsSaves += 1; };
    collector.confirmPrivacyReceipt = async () => {
        receipt = {version: PRIVACY_RECEIPT_VERSION, acceptedAt: Date.now()};
        return true;
    };

    assert.equal(await collector.ensureContributionConsent(), true);
    assert.equal(settingsSaves, 0);

    receipt = null;
    collector.confirmPrivacyReceipt = async () => false;
    assert.equal(await collector.ensureContributionConsent(), false);
    assert.equal(collector.settings.shareDatasetContributions, false);
    assert.equal(settingsSaves, 1);

    const source = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.source.js"), "utf8");
    const consentIndex = source.indexOf("await this.ensureContributionConsent()");
    const requestIndex = source.indexOf("buildVisionMultipartBody", consentIndex);
    assert.ok(consentIndex >= 0 && requestIndex > consentIndex, "Vision must resolve opt-in consent before building the request");
}

await testStaleContributionConsentRepromptsOrFallsBackToOptOut();

const pluginSource = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.source.js"), "utf8");
assert.match(pluginSource, /Optional identity or role notes/);
assert.match(pluginSource, /Identity is never inferred from pixels or anatomy/);
assert.match(pluginSource, /Uploader-supplied identity or role metadata \(not inferred from pixels\)/);
assert.match(pluginSource, /guidance: requestGuidance/);
assert.match(pluginSource, /this\.interrogateIdentityNote = ""/);

assert.equal(validateVisionLoopbackEndpoint("http://127.0.0.1:7870/api/discord-describe").ok, true);
assert.equal(validateVisionLoopbackEndpoint("https://[::1]:7870/api/discord-describe").ok, true);
assert.equal(DEFAULT_SETTINGS.visionEndpoint, "http://127.0.0.1:7870/api/discord-describe");
assert.equal(DEFAULT_SETTINGS.visionModel, "llamacpp::heretic-8b-q8_0");
assert.equal(DEFAULT_SETTINGS.preferredPreset, "dataset-detailed");
assert.equal(DEFAULT_SETTINGS.useKrea2DatasetGuidance, false);
assert.equal(DEFAULT_SETTINGS.shareFailureDiagnostics, false);
assert.equal(DEFAULT_SETTINGS.completionToasts, true);
assert.equal(DEFAULT_SETTINGS.updateMode, "prompt");
assert.equal(normalizeUpdateMode("automatic"), "automatic");
assert.equal(normalizeUpdateMode("prompt"), "prompt");
assert.equal(normalizeUpdateMode("anything-else"), "prompt");
assert.equal(Object.hasOwn(DEFAULT_SETTINGS, "endpoint"), false);
assert.equal(Object.hasOwn(DEFAULT_SETTINGS, "token"), false);
assert.equal(DEFAULT_SETTINGS.saveFolder.endsWith(path.join("Pictures", "Krea2Vision")), true);
assert.equal(historyThumbnailCacheDirectory("C:\\Krea2Vision"), "C:\\Krea2Vision\\.krea2-history-thumbnails");
assert.deepEqual(historyThumbnailCacheCandidates("C:\\Krea2Vision", "a".repeat(64)), [
    `C:\\Krea2Vision\\.krea2-history-thumbnails\\${"a".repeat(64)}.webp`,
    `C:\\Krea2Vision\\.krea2-history-thumbnails\\${"a".repeat(64)}.png`,
    `C:\\Krea2Vision\\.krea2-history-thumbnails\\${"a".repeat(64)}.jpg`,
    `C:\\Krea2Vision\\.krea2-history-thumbnails\\${"a".repeat(64)}.jpeg`
]);
assert.throws(() => historyThumbnailCacheCandidates("C:\\Krea2Vision", "not-a-hash"), /SHA-256/);
{
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "krea2-thumbnail-cache-"));
    const cacheDirectory = historyThumbnailCacheDirectory(cacheRoot);
    try {
        fs.mkdirSync(cacheDirectory, {recursive: true});
        for (let index = 0; index < 252; index += 1) {
            const hash = index.toString(16).padStart(64, "0");
            fs.writeFileSync(path.join(cacheDirectory, `${hash}.webp`), Buffer.from("RIFF"));
        }
        fs.writeFileSync(path.join(cacheDirectory, "do-not-delete.txt"), "unrelated");
        assert.equal(clearHistoryThumbnailCache(cacheDirectory), 252);
        assert.deepEqual(fs.readdirSync(cacheDirectory), ["do-not-delete.txt"]);
    }
    finally {
        fs.rmSync(cacheRoot, {recursive: true, force: true});
    }
}
assert.equal(formatVramMiB(13312), "13,312 MiB");
assert.equal(formatVramMiB(null), "Unavailable");
assert.equal(formatDownloadGiB(9461810784), "8.8 GiB");
const fallbackOnboardingModels = mergeHereticModelTelemetry(null);
assert.deepEqual(fallbackOnboardingModels.map(model => model.public_id), [
    "llamacpp::heretic-2b-f16",
    "llamacpp::heretic-4b-q8_0",
    "llamacpp::heretic-8b-q8_0",
    "llamacpp::glm4-9b-abliterated-q5_k_m",
    "llamacpp::gemma4-12b-opus-uncensored-q8_0",
    "llamacpp::gemma4-12b-heretic-q8_0",
    "llamacpp::gemma4-26b-a4b-heretic-q3_k_l",
    "llamacpp::qwen3-vl-30b-a3b-abliterated-q2_k",
    "llamacpp::gemma4-31b-heretic-q4_k_m",
    "llamacpp::qwen3-vl-32b-heretic-q4_k_m"
]);
assert.equal(fallbackOnboardingModels[2].estimated_vram_mb, 13312);
assert.equal(fallbackOnboardingModels[2].last_measured_peak_mb, 10522);
assert.equal(fallbackOnboardingModels[2].admission_required_mb, 17408);
assert.equal(fallbackOnboardingModels[2].context_cap, 6144);
assert.equal(fallbackOnboardingModels[2].admission_tolerance_mb, 64);
assert.equal(fallbackOnboardingModels[2].over_allocation_target, true);
assert.match(fallbackOnboardingModels[2].model_card_url, /^https:\/\/huggingface\.co\//);
assert.equal(fallbackOnboardingModels[2].download_bytes, 9461810784);
assert.match(fallbackOnboardingModels[2].model_download_url, /\/resolve\/ee9e0de47684c84abba6e420f5f89625813a08f4\//);
assert.match(fallbackOnboardingModels[2].projector_download_url, /mmproj-Q8_0\.gguf\?download=true$/);
assert.deepEqual(fallbackOnboardingModels.map(model => model.parameter_size_b), [2, 4, 8, 9, 12, 12, 26, 30, 31, 32]);
assert.equal(fallbackOnboardingModels[4].estimated_vram_mb, 20992);
assert.equal(fallbackOnboardingModels[4].admission_required_mb, 25088);
assert.equal(fallbackOnboardingModels[5].estimated_vram_mb, 20992);
assert.equal(fallbackOnboardingModels[5].admission_required_mb, 25088);
const liveOnboardingModels = mergeHereticModelTelemetry({models: [{
    public_id: "llamacpp::heretic-4b-q8_0",
    available_vram_mb: 16000,
    total_vram_mb: 32607,
    admission_passes_now: true,
    last_measured_peak_mb: 7001,
    context_cap: 7168,
    admission_tolerance_mb: 32
}]});
assert.equal(liveOnboardingModels[1].telemetry_live, true);
assert.equal(liveOnboardingModels[1].available_vram_mb, 16000);
assert.equal(liveOnboardingModels[1].admission_passes_now, true);
assert.equal(liveOnboardingModels[1].last_measured_peak_mb, 7001);
assert.equal(liveOnboardingModels[1].context_cap, 7168);
assert.equal(liveOnboardingModels[1].admission_tolerance_mb, 32);
assert.equal(liveOnboardingModels[0].telemetry_live, false);
assert.equal(promptPresetGuidance("character-clothing").includes("clothing layers"), true);
assert.equal(applyPromptPreset("One plain sentence. Another sentence about lighting and shadows. A third detail. A fourth detail. A fifth detail. A sixth detail. A seventh environment sentence.", "krea2-short").includes("lighting"), true);
assert.deepEqual(promptDiffSummary("red dress soft light", "blue dress soft sunlight"), {added: ["blue", "sunlight"], removed: ["red", "light"]});
assert.equal(safeModelFilePart("llamacpp::heretic-8b-q8_0"), "llamacpp-heretic-8b-q8-0");
const builtPluginSource = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.js"), "utf8");
const artifactManifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vision-studio", "scripts", "heretic_llamacpp_artifacts.json"), "utf8"));
const suiteInstallerSource = fs.readFileSync(path.join(__dirname, "..", "installer", "Install-Krea2VisionSuite.ps1"), "utf8");
const suiteLauncherSource = fs.readFileSync(path.join(__dirname, "..", "installer", "Start-Krea2VisionSuite.ps1"), "utf8");
const rootInstallerSource = fs.readFileSync(path.join(__dirname, "..", "START HERE - INSTALL.bat"), "utf8");
assert.equal(artifactManifest.model_installation.mode, "recommended_auto_optional");
assert.equal(artifactManifest.model_installation.default_download, "8B");
assert.equal(artifactManifest.models.length, 10);
assert.deepEqual(artifactManifest.models.map(model => Number.parseInt(model.parameter_size, 10)), [2, 4, 8, 9, 12, 12, 26, 30, 31, 32]);
for (const model of artifactManifest.models) {
    assert.match(model.model.url, /^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\/.+\?download=true$/);
    assert.match(model.mmproj[0].url, /^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\/.+\?download=true$/);
}
assert.match(suiteInstallerSource, /\[string\] \$Model = '8B'/);
assert.match(suiteInstallerSource, /\$runtimeArguments\+=@\('-DownloadModels',\$Model\)/);
for (const packageId of ["Python.Python.3.12", "Ollama.Ollama", "Discord.Discord", "betterdiscord.cli"]) {
    assert.match(suiteInstallerSource, new RegExp(packageId.replaceAll(".", "\\.")));
}
assert.match(suiteInstallerSource, /Krea2DiscordCollector\.config\.json/);
assert.match(suiteInstallerSource, /babegen-prompter:9b-q5/);
assert.match(suiteInstallerSource, /KREA2_DISCORD_VISION_TOKEN/);
assert.match(suiteInstallerSource, /KREA2 Vision Suite\.lnk/);
assert.match(suiteInstallerSource, /Stop-OwnedSuiteProcesses/);
assert.match(suiteLauncherSource, /127\.0\.0\.1:11434\/api\/version/);
assert.match(suiteLauncherSource, /127\.0\.0\.1:7870\/health/);
assert.doesNotMatch(suiteLauncherSource, /127\.0\.0\.1:8795/);
assert.match(rootInstallerSource, /-Mode Install -Model 8B/);
assert.doesNotMatch(builtPluginSource, /krea2history:\/\/|window\.open\(/);
assert.match(builtPluginSource, /membersWrap_/);
assert.match(builtPluginSource, /membersColumn\.insertAdjacentElement\("afterend", root\)/);
assert.match(builtPluginSource, /--krea2-text: #f3f5f7/);
assert.match(builtPluginSource, /--krea2-muted: #a8b0bd/);
assert.match(builtPluginSource, /\.krea2-history-prompt[\s\S]*?-webkit-text-fill-color: var\(--krea2-text\)/);
assert.doesNotMatch(builtPluginSource, /#\$\{HISTORY_MODAL_ID\} \* \{/);
assert.match(builtPluginSource, /const HISTORY_DETAIL_POLL_MS = 1000/);
assert.match(builtPluginSource, /krea2-history-average-queue/);
assert.match(builtPluginSource, /Average queue time:/);
assert.match(builtPluginSource, /const ONBOARDING_VERSION = 9/);
assert.match(builtPluginSource, /Mandatory error telemetry never contains image bytes or hashes, prompts, Discord identity or IDs, URLs, filenames, or local paths/);
assert.match(builtPluginSource, /GPU_AVAILABILITY_TIMEOUT_MS = 30 \* 1000/);
assert.match(builtPluginSource, /\/api\/discord-errors/);
assert.match(builtPluginSource, /https:\/\/seedframe\.xyz\/api\/diagnostics\/krea2-vision/);
assert.match(builtPluginSource, /async submitOperationalErrorDirect\(item, visionToken\)/);
assert.match(builtPluginSource, /Install model \+ projector together/);
assert.match(builtPluginSource, /Verify installed model \+ projector/);
assert.match(builtPluginSource, /async requestVisionModelInstall\(publicId, method\)/);
assert.match(builtPluginSource, /async startVisionModelInstall\(publicId\)/);
assert.match(builtPluginSource, /async fetchVisionModelInstallStatus\(publicId\)/);
assert.match(builtPluginSource, /Use an installed model on this computer, or send the request through the authenticated local broker/);
assert.match(builtPluginSource, /Online API — Gemma 4 26B-A4B on the private remote worker/);
assert.match(builtPluginSource, /save\.disabled = !usesLocalGpu && onlineAvailable !== true/);
assert.match(builtPluginSource, /Online API is not configured on this local broker\. Choose Local GPU or ask the operator to configure a private worker\./);
assert.match(builtPluginSource, /X-Krea2-Vision-Session/);
assert.match(builtPluginSource, /Enable image buttons in this server/);
assert.match(builtPluginSource, /Repair KREA2 Vision Suite shortcut/);
assert.match(builtPluginSource, /Model that actually described this image/);
assert.match(builtPluginSource, /Exact model ID:/);
assert.match(builtPluginSource, /\["Interrogate", "interrogate"\]/);
assert.match(builtPluginSource, /buildInterrogatePanel\(panel\)/);
assert.match(builtPluginSource, /queueInterrogateSelection\(\)/);
assert.match(builtPluginSource, /input\.accept = "image\/png,image\/jpeg,image\/webp/);
assert.match(builtPluginSource, /fetchProductJson\("\/api\/discord-models"\)/);
const interrogateMethodSource = builtPluginSource.slice(
    builtPluginSource.indexOf("    queueInterrogateSelection()"),
    builtPluginSource.indexOf("    setHistoryCollapsed(collapsed)")
);
assert.match(interrogateMethodSource, /this\.visionFlowQueue\.then/);
assert.match(interrogateMethodSource, /this\.getOrQueueVisionJob/);
assert.match(interrogateMethodSource, /this\.requestVisionPrompt/);
assert.doesNotMatch(interrogateMethodSource, /writeFile|saveOriginalImage|savePromptSidecar/);

async function testInterrogateUploadUsesExistingQueue() {
    const collector = new Plugin();
    const model = "llamacpp::heretic-4b-q8_0";
    const bytes = Buffer.from("89504e470d0a1a0a", "hex");
    const sha256 = sha256Hex(bytes);
    let request = null;
    let openedJobId = "";
    let finishedModel = "";
    collector.running = true;
    collector.generation = 4;
    collector.settings = {...DEFAULT_SETTINGS};
    collector.interrogateModels = [{public_id: model, label: "Heretic — Qwen3-VL 4B Q8_0", local_gpu: true}];
    collector.interrogateSelectedModel = model;
    collector.interrogateSelection = Object.freeze({
        bytes,
        sha256,
        format: Object.freeze({kind: "png", extension: ".png", mimeType: "image/png"}),
        displayName: "manual-upload.png"
    });
    collector.getVisionConfig = () => ({
        endpoint: "http://127.0.0.1:7870/api/discord-describe",
        origin: "http://127.0.0.1:7870",
        token: "x".repeat(32),
        model: DEFAULT_SETTINGS.visionModel
    });
    collector.renderInterrogatePanel = () => {};
    collector.renderHistoryRail = () => {};
    collector.rememberHistoryThumbnail = () => null;
    collector.toast = () => {};
    collector.log = () => {};
    collector.getOrQueueVisionJob = (requestCacheKey, factory) => {
        assert.match(requestCacheKey, /^[a-f0-9]{64}$/);
        return {job: Promise.resolve().then(factory), shared: false};
    };
    collector.requestVisionPrompt = async (original, localSave, visionConfig, signal, onElapsed, options) => {
        request = {original, localSave, visionConfig, signal, options};
        onElapsed("0:01");
        return {model: "Heretic — Qwen3-VL 4B Q8_0"};
    };
    collector.finishVisionPrompt = async ({model: usedModel}) => { finishedModel = usedModel; };
    collector.refreshHistory = async () => {
        collector.historyJobs = [{id: collector.lastCompletionJobId, status: "completed"}];
    };
    collector.openHistoryDetail = async id => { openedJobId = id; };

    collector.queueInterrogateSelection();
    assert.equal(collector.interrogateSelection, null, "the form should clear immediately so another image can be queued");
    assert.equal(collector.interrogatePendingCount, 1);
    await collector.visionFlowQueue;

    assert.ok(request, "the uploaded image should reach the existing Vision request method");
    assert.equal(request.original.bytes, bytes);
    assert.equal(request.original.sha256, sha256);
    assert.equal(request.localSave.filename, `${sha256}.png`);
    assert.equal(request.visionConfig.model, model);
    assert.equal(request.options.model, model);
    assert.match(request.options.jobId, /^[a-f0-9]{32}$/);
    assert.equal(request.options.jobId, openedJobId);
    assert.equal(finishedModel, "Heretic — Qwen3-VL 4B Q8_0");
    assert.equal(collector.interrogatePendingCount, 0);
    assert.equal(collector.localVisionSubmissions.size, 0);
}

await testInterrogateUploadUsesExistingQueue();
assert.match(builtPluginSource, /Requested only — the completed backend result will confirm the model that actually ran/);
assert.match(builtPluginSource, /setInterval\(\(\) => void refreshOpenJob\(\), HISTORY_DETAIL_POLL_MS\)/);
assert.equal((builtPluginSource.match(/let detailPollTimer = null;/g) || []).length, 1);
assert.match(builtPluginSource, /async openHistoryDetail\(jobId\)[\s\S]*?const controller = new AbortController\(\);\s*let detailPollTimer = null;/);
assert.doesNotMatch(builtPluginSource, /async refreshHistory\(force = false\)[\s\S]*?let detailPollTimer = null;[\s\S]*?async openHistoryDetail/);
assert.match(builtPluginSource, /const retry = modalDocument\.createElement\("button"\)/);
assert.match(builtPluginSource, /stage: `Retrying with \$\{retryModelName\}…`/);
assert.match(builtPluginSource, /public_error: ""/);
assert.match(builtPluginSource, /retrySavedHistoryImage\(currentJob, savedOriginal, [\s\S]*?, retryModel\)/);
assert.match(builtPluginSource, /const done = modalDocument\.createElement\("button"\)/);
assert.doesNotMatch(builtPluginSource, /label: "Local save folder"/);
const inMemoryVisionFlow = builtPluginSource.match(/async analyzeWithVision\([\s\S]*?\n    async requestVisionPrompt\(/)?.[0] || "";
assert.ok(inMemoryVisionFlow);
assert.doesNotMatch(inMemoryVisionFlow, /saveOriginalImage|saveVisionPromptSidecar|readReusableVisionPrompt|writeFileCompat/);
assert.match(inMemoryVisionFlow, /requestImage = \{filename:/);
assert.match(inMemoryVisionFlow, /this\.rememberHistoryThumbnail\(original, true\)/);
assert.doesNotMatch(inMemoryVisionFlow, /contributeVisionPrompt\(\{/);
assert.match(builtPluginSource, /Contribute my three generated prompts to Krea2/);
assert.match(builtPluginSource, /all three generated prompt texts/);
assert.match(builtPluginSource, /No image bytes, image hashes, Discord IDs, Discord URLs, filenames, or local paths are sent/);
assert.doesNotMatch(builtPluginSource, /void this\.collectImage\(image, plusButton\)/);
assert.doesNotMatch(builtPluginSource, /plusButton\.textContent = "\+"/);
assert.match(builtPluginSource, /\.krea2-history-result \{ display: grid; grid-template-columns: 176px minmax\(0, 1fr\)/);
assert.match(builtPluginSource, /const url = view\.URL\.createObjectURL\(new view\.Blob/);
assert.match(builtPluginSource, /thumbnail\.alt = `Source image for \$\{historyJobTitle\(job\)\}`/);
assert.match(builtPluginSource, /like\.textContent = "👍 Like"/);
assert.match(builtPluginSource, /dislike\.textContent = "👎 Needs work"/);
assert.match(builtPluginSource, /What should the model avoid next time\?/);
assert.doesNotMatch(builtPluginSource, /this\.api\.Data\.save\("promptFeedback", this\.promptFeedback\)/);
for (const contentKey of ["sentHashes", "diagnosticSummaries", "historyFavorites", "editedPrompts", "historyReviews", "modelEvaluations", "promptFeedback"]) {
    assert.doesNotMatch(builtPluginSource, new RegExp(`this\\.api\\.Data\\.save\\("${contentKey}"`));
}
assert.doesNotMatch(builtPluginSource, /async contributeVisionPrompt\(/);
assert.doesNotMatch(builtPluginSource, /canUseMetadataPlus\(\)/);
assert.doesNotMatch(builtPluginSource, /fragment\.append\(this\.createJobProductTabs/);
assert.doesNotMatch(builtPluginSource, /label: "Default Prompt Workshop preset"/);
assert.match(builtPluginSource, /label: "Automatically contribute my three generated prompts to Krea2"/);
assert.doesNotMatch(builtPluginSource, /Authorization: `Bearer \$\{candidate\.token\}`/);
assert.doesNotMatch(builtPluginSource, /currentUserOwnsMetadataPlus\(/);
assert.match(builtPluginSource, /for \(const objectUrl of this\.historyThumbnailUrls\.values\(\)\) this\.revokeObjectUrl\(objectUrl\)/);
assert.match(builtPluginSource, /const ONBOARDING_VERSION = 9/);
assert.match(builtPluginSource, /\.krea2-history-thumbnails/);
assert.match(builtPluginSource, /async persistHistoryThumbnail\(original\)/);
assert.match(builtPluginSource, /async findCachedHistoryThumbnailPath\(hash\)/);
assert.equal(historyBaseUrlFromVisionEndpoint(DEFAULT_SETTINGS.visionEndpoint), "http://127.0.0.1:7870");
assert.throws(() => historyBaseUrlFromVisionEndpoint("http://localhost:7870/api/discord-describe"), /literal/);
for (const unsafeVisionEndpoint of [
    "http://localhost:7870/api/discord-describe",
    "http://127.1:7870/api/discord-describe",
    "http://2130706433:7870/api/discord-describe",
    "http://127.0.0.1.evil.example:7870/api/discord-describe",
    "https://example.com/api/discord-describe",
    "http://127.0.0.1:7870/api/discord-describe/",
    "http://127.0.0.1:7870/api/discord-describe?debug=1",
    "http://127.0.0.1:7870/api/discord-describe#fragment",
    "http://token@127.0.0.1:7870/api/discord-describe",
    "http://127.0.0.1:7870/api/analyze"
]) {
    assert.equal(validateVisionLoopbackEndpoint(unsafeVisionEndpoint).ok, false, unsafeVisionEndpoint);
}

const historyCompleted = {
    id: "a".repeat(32), created: 100, updated: 140, started: 110, finished: 140,
    duration_seconds: 30, image_hash: "b".repeat(64), filename: `${"b".repeat(64)}.png`,
    status: "completed", stage: "Prompt ready", queue_ahead: 0, model: "llamacpp::heretic-8b-q8_0",
    prompt_words: 120, prompt_preview: "Detailed photographic prompt", has_prompt: true, public_error: ""
};
const historyQueued = {...historyCompleted, id: "c".repeat(32), status: "queued", started: null, finished: null};
const historyCompletedSecond = {
    ...historyCompleted,
    id: "d".repeat(32),
    created: 200,
    started: 225,
    finished: 260
};
const parsedHistory = parseHistoryListResponse(JSON.stringify({
    summary: {queued: 1, running: 0, completed_24h: 1, total: 42, rejected: 0, errors: 0},
    scheduler: {warm: {active: true, seconds_remaining: 12}, next_eligible_job: {eligible_now: false, reason: "Waiting"}},
    pagination: {page: 2, page_size: 20, total_items: 42, total_pages: 3, has_previous: true, has_next: true},
    jobs: [historyCompleted, historyQueued]
}));
assert.equal(parsedHistory.jobs.length, 2);
assert.equal(parsedHistory.summary.queued, 1);
assert.equal(parsedHistory.summary.total, 42);
assert.equal(parsedHistory.pagination.page, 2);
assert.equal(parsedHistory.pagination.total_pages, 3);
assert.equal(parsedHistory.pagination.has_previous, true);
assert.deepEqual(filterHistoryJobs(parsedHistory.jobs, "completed").map(job => job.id), [historyCompleted.id]);
assert.deepEqual(filterHistoryJobs(parsedHistory.jobs, "queued").map(job => job.id), [historyQueued.id]);
assert.equal(historyJobTitle(parsedHistory.jobs[0]), `Image ${"b".repeat(10)}`);
assert.equal(formatHistoryDuration(30), "30s");
assert.equal(formatHistoryDuration(90), "1m 30s");
assert.equal(historyQueueWaitSeconds(parsedHistory.jobs[0], 999), 10);
assert.equal(historyQueueWaitSeconds(parsedHistory.jobs[1], 125), 25);
assert.deepEqual(historyAverageQueueWait([
    historyCompleted,
    historyCompletedSecond,
    historyQueued,
    {...historyCompleted, id: "f".repeat(32), started: null},
    {...historyCompleted, id: "e".repeat(32), status: "error"}
], 300), {seconds: 17.5, sample_count: 2});
assert.deepEqual(historyAverageQueueWait([historyCompleted], 86541), {seconds: null, sample_count: 0});
assert.equal(formatAverageQueueTime(null), "Average queue time: —");
assert.equal(formatAverageQueueTime(17.5), "Average queue time: 18 seconds");
assert.equal(formatAverageQueueTime(1), "Average queue time: 1 second");
const operationalReport = buildOperationalErrorReport({
    event_id: "9".repeat(32),
    model_id: "vast::gemma4-26b-a4b-heretic-q3_k_l",
    error_code: "worker_error",
    error_message: "Failed at https://private.example/path in C:\\Users\\person\\secret.png token=should-not-leak",
    stage: "Submitting image"
}, "v".repeat(32));
assert.equal(operationalReport.schema, "seedframe.krea2-vision-operational-error.v1");
assert.equal(operationalReport.runtime, "remote");
assert.equal(operationalReport.event_id, "9".repeat(32));
assert.match(operationalReport.report_sha256, /^[a-f0-9]{64}$/);
assert.doesNotMatch(JSON.stringify(operationalReport), /private\.example|secret\.png|should-not-leak/i);
assert.equal(sanitizeOperationalErrorText("GPU not available"), "GPU not available");
assert.equal(isHistoryJobActive({status: "queued"}), true);
assert.equal(isHistoryJobActive({status: "RUNNING"}), true);
assert.equal(isHistoryJobActive({status: "completed"}), false);
assert.equal(isHistoryJobActive({status: "rejected"}), false);
assert.equal(historyJobMatchesModel({model: "Qwen3-VL 8B Heretic — three image passes + composer"}, "llamacpp::heretic-8b-q8_0"), true);
assert.equal(historyJobMatchesModel({model: "llamacpp::heretic-4b-q8_0"}, "llamacpp::heretic-4b-q8_0"), true);
assert.equal(historyJobMatchesModel({model: "Qwen3-VL 2B Heretic"}, "llamacpp::heretic-8b-q8_0"), false);
assert.equal(historyJobMatchesModel({model: "Heretic — Gemma 4 31B Q4_K_M"}, "llamacpp::gemma4-31b-heretic-q4_k_m"), true);
assert.equal(historyJobMatchesModel({model: "Heretic — Qwen3-VL 32B Q4_K_M"}, "llamacpp::qwen3-vl-32b-heretic-q4_k_m"), true);
const historyDetailPrompt = Array.from({length: 100}, (_, index) => `Visible history detail ${index} remains grounded in the source image.`).join(" ");
const historyDetailVariants = [
    historyDetailPrompt,
    `${historyDetailPrompt} Subject-focused organization remains distinct.`,
    `${historyDetailPrompt} Scene-focused organization remains distinct.`
];
const detail = parseHistoryDetailResponse(JSON.stringify({...historyCompleted, prompt: historyDetailPrompt, prompt_variants: historyDetailVariants}));
assert.equal(detail.prompt, historyDetailPrompt);
assert.deepEqual(detail.prompt_variants, historyDetailVariants);
assert.throws(() => parseHistoryListResponse('{"jobs":"bad"}'), /invalid list/);
assert.throws(() => parseHistoryDetailResponse('{"id":"bad"}'), /identifier/);

const normalized = normalizeMediaUrl(
    "https://media.discordapp.net/attachments/123/456/example.png?ex=aa&is=bb&hm=cc&=&width=640&height=480&format=webp&quality=lossless"
);
assert.equal(
    normalized,
    "https://cdn.discordapp.com/attachments/123/456/example.png?ex=aa&is=bb&hm=cc"
);
assert.equal(isExcludedAssetUrl("https://cdn.discordapp.com/avatars/123/hash.png"), true);
assert.equal(normalizeMediaUrl("https://cdn.discordapp.com/emojis/123.webp"), null);
assert.equal(normalizeMediaUrl("http://cdn.discordapp.com/attachments/1/2/a.png"), null);
assert.equal(normalizeMediaUrl("https://evil.example/attachments/1/2/a.png"), null);
assert.equal(normalizeMediaUrl("https://cdn.discordapp.com/external/1/2/a.png"), null);
assert.equal(
    normalizeMediaUrl("https://media.discordapp.net/ephemeral-attachments/111/222/a.png?ex=a&is=b&hm=c&width=99"),
    "https://cdn.discordapp.com/ephemeral-attachments/111/222/a.png?ex=a&is=b&hm=c"
);
assert.deepEqual(extractMediaProvenance("https://cdn.discordapp.com/attachments/111/222/a.png?ex=a&is=b&hm=c"), {
    kind: "attachment",
    path: "/attachments/111/222/a.png",
    attachmentChannelId: "111",
    attachmentId: "222"
});

assert.equal(chooseBestMediaUrl([
    {url: "https://example.com/article", source: "anchor"},
    {url: "https://media.discordapp.net/attachments/1/2/photo.webp?width=500", source: "image"}
]), "https://cdn.discordapp.com/attachments/1/2/photo.webp");

assert.equal(filenameFromUrl("https://cdn.discordapp.com/attachments/1/2/my%20image.png?ex=a"), "my image.png");
assert.equal(filenameFromContentDisposition("attachment; filename*=UTF-8''forge%20output.png"), "forge output.png");
assert.equal(sanitizeFilename("../bad\r\nname", "image/jpeg"), "_bad_name.jpg");
assert.equal(inferMimeType("application/octet-stream", "sample.webp"), "image/webp");

assert.equal(
    sha256Hex(Buffer.from("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
);

assert.equal(decodeHtmlEntities("cats &amp; dogs &#33;"), "cats & dogs !");
assert.deepEqual(evaluatePromptValue(
    "parameters: beautiful woman &amp; cinematic lighting\nNegative Prompt: 日本語の否定\nNegative Prompt: duplicate"
), {classification: "usable", prompt: "beautiful woman & cinematic lighting"});
assert.equal(evaluatePromptValue('{"1":{"class_type":"KSampler"}}').classification, "structured");
assert.equal(evaluatePromptValue("scene:\n  subject: woman\n  lighting: soft").classification, "structured");
assert.equal(evaluatePromptValue(`base64:${"A".repeat(128)}`).classification, "encoded_or_unknown");
assert.equal(evaluatePromptValue("美しい女性の映画的な肖像、柔らかな光\nNegative prompt: ugly").classification, "non_english");
assert.equal(evaluatePromptValue("ritratto cinematografico di una bellissima donna dai lunghi capelli scuri").classification, "non_english");
assert.equal(evaluatePromptValue("beautiful cinematic woman\nNegative Prompt: 悪い低品質").classification, "usable");

const forgePng = pngWithText("parameters", "beautiful woman, cinematic light\nNegative Prompt: low quality");
const forgeFormat = detectImageFormat(forgePng);
assert.deepEqual(forgeFormat, {extension: ".png", mimeType: "image/png", kind: "png"});
assert.deepEqual((await extractConfidentPrompt(forgePng, forgeFormat)).prompt, "beautiful woman, cinematic light");

const wrappedPng = pngWithText("Comment", "parameters: photorealistic woman with long hair\nNegative prompt: blurry");
assert.equal((await extractConfidentPrompt(wrappedPng, detectImageFormat(wrappedPng))).classification, "metadata_no_prompt");
const comfyPng = pngWithText("prompt", '{"3":{"inputs":{"seed":1},"class_type":"KSampler"}}');
assert.equal((await extractConfidentPrompt(comfyPng, detectImageFormat(comfyPng))).classification, "structured");
const noPromptPng = pngWithText("Software", "Forge");
assert.equal((await extractConfidentPrompt(noPromptPng, detectImageFormat(noPromptPng))).classification, "metadata_no_prompt");
const noMetadataPng = pngWithText(null, "");
assert.equal((await extractConfidentPrompt(noMetadataPng, detectImageFormat(noMetadataPng))).classification, "no_metadata");

assert.deepEqual(parseUploadResponse(201, '{"classification":"added"}'), {classification: "added"});
assert.deepEqual(parseUploadResponse(409, ""), {classification: "duplicate"});
assert.throws(() => parseUploadResponse(201, '{"ok":true}'), /recognized classification/);
assert.equal(validateSaveFolder("C:\\Users\\Example\\Pictures\\Krea2Vision").ok, true);
assert.equal(validateSaveFolder("relative\\folder").ok, false);

const hashA = "a".repeat(64);
assert.equal(submissionKey(hashA, "embedded_metadata"), `${hashA}:embedded_metadata`);
assert.equal(submissionKey(hashA.toUpperCase(), "vision_ai"), `${hashA}:vision_ai`);
assert.equal(normalizeStoredSubmissionKey(hashA), `${hashA}:embedded_metadata`);
assert.equal(normalizeStoredSubmissionKey(`${hashA}:vision_ai`), `${hashA}:vision_ai`);
assert.equal(normalizeStoredSubmissionKey("invalid"), null);
assert.throws(() => submissionKey(hashA, "unknown"), /Prompt source is invalid/);

const detailedVisionPrompt = [
    "Ｆace framed by softly textured dark hair, a focused expression, relaxed shoulders, and a natural standing pose.",
    ...Array.from({length: 12}, (_, index) => `Visible detail ${index + 1} describes clothing material, color, lighting, perspective, background texture, composition, and natural imperfection with photographic precision.`)
].join(" ");
const normalizedDetailedVisionPrompt = detailedVisionPrompt.normalize("NFKC");
const detailedVisionPromptVariants = [
    normalizedDetailedVisionPrompt,
    `${normalizedDetailedVisionPrompt} A second evidence-grounded organization emphasizes the visible subject, pose, clothing construction, and interactions without changing any image fact.`,
    `${normalizedDetailedVisionPrompt} A third evidence-grounded organization emphasizes the visible setting, composition, light, color, materials, and spatial relationships without changing any image fact.`
];
const disabledDatasetGuidance = {
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
assert.equal(normalizeVisionPrompt(`${detailedVisionPrompt}\r\nNegative Prompt: unwanted artifacts`), normalizedDetailedVisionPrompt);
assert.deepEqual(
    parseVisionPromptResponse(JSON.stringify({
        classification: "usable",
        prompt: detailedVisionPrompt,
        prompt_variants: detailedVisionPromptVariants,
        model: "trueinterrogate-qwen25:latest + babegen-prompter:9b-q5",
        prompt_words: 384,
        pipeline_id: VISION_PIPELINE_ID,
        dataset_guidance: disabledDatasetGuidance,
        ignored: "x".repeat(8192)
    }), {expectedDatasetGuidance: false}),
    {
        prompt: normalizedDetailedVisionPrompt,
        prompt_variants: detailedVisionPromptVariants,
        model: "trueinterrogate-qwen25:latest + babegen-prompter:9b-q5",
        prompt_words: 384,
        pipeline_id: VISION_PIPELINE_ID,
        dataset_guidance: disabledDatasetGuidance
    }
);
assert.throws(() => normalizeVisionPrompt("too short"), /too short/);
assert.throws(() => normalizeVisionPrompt(`I cannot comply ${"with this request ".repeat(100)}`), /refusal/);
assert.throws(() => normalizeVisionPrompt(JSON.stringify({prompt: "detail ".repeat(100)})), /structured or encoded/);
assert.throws(() => normalizeVisionPrompt(`scene:\n  subject: detailed person\nlighting: ${"soft natural light ".repeat(100)}`), /structured or encoded/);
assert.throws(() => normalizeVisionPrompt(`base64:${"A".repeat(1024)}`), /structured or encoded/);
assert.throws(() => normalizeVisionPrompt("word ".repeat(25000)), /oversized/);
assert.throws(() => parseVisionPromptResponse(JSON.stringify({classification: "unsupported", prompt: detailedVisionPrompt, model: "x", prompt_words: 100})), /classify.*usable/);
assert.throws(() => parseVisionPromptResponse(JSON.stringify({classification: "usable", prompt: detailedVisionPrompt, model: "", prompt_words: 100})), /model identifier/);
assert.throws(() => parseVisionPromptResponse(JSON.stringify({classification: "usable", prompt: detailedVisionPrompt, model: "x", prompt_words: "100"})), /word count/);
assert.throws(() => parseVisionPromptResponse("x".repeat(4 * 1024 * 1024 + 1)), /oversized response/);
assert.deepEqual(historyModelEvidence({
    status: "running",
    requested_model: "llamacpp::heretic-8b-q8_0",
    model: "llamacpp::heretic-8b-q8_0"
}), {
    confirmed: false,
    label: "llamacpp::heretic-8b-q8_0",
    model_id: "llamacpp::heretic-8b-q8_0",
    quantization: "",
    note: "Requested only — the completed backend result will confirm the model that actually ran."
});
assert.deepEqual(historyModelEvidence({
    status: "completed",
    has_prompt: true,
    requested_model: "llamacpp::heretic-8b-q8_0",
    model: "Heretic — Qwen3-VL 8B Q8_0 — faithful recreation",
    reproducibility: {
        model_id: "llamacpp::heretic-8b-q8_0",
        model_label: "Heretic — Qwen3-VL 8B Q8_0",
        quantization: "Q8_0"
    }
}), {
    confirmed: true,
    label: "Heretic — Qwen3-VL 8B Q8_0 — faithful recreation",
    model_id: "llamacpp::heretic-8b-q8_0",
    quantization: "Q8_0",
    note: "Confirmed by the completed loopback backend result and its verified reproducibility record."
});
assert.equal(parseStudioErrorDetail('{"detail":"  GPU queue\\nfailed  ","debug":"secret"}'), "GPU queue failed");
assert.equal(parseStudioErrorDetail('{"detail":{"nested":"not exposed"}}'), "");
assert.equal(parseStudioErrorDetail("not json"), "");

const multipart = buildVisionMultipartBody(forgePng, {
    filename: `${sha256Hex(forgePng)}.png`,
    mimeType: "image/png",
    model: "llamacpp::heretic-8b-q8_0",
    guidance: "Prioritize literal clothing detail.\r\nDo not invent.",
    jobId: "1234567890abcdef1234567890abcdef",
    contributionTerms: Plugin.helpers.KREA2_CONTRIBUTION_TERMS_VERSION
});
assert.equal(Buffer.isBuffer(multipart.body), true);
assert.match(multipart.contentType, /^multipart\/form-data; boundary=----Krea2Vision[a-f0-9]+$/);
const multipartText = multipart.body.toString("latin1");
assert.match(multipartText, /name="image"; filename="[a-f0-9]{64}\.png"/);
assert.equal(multipart.body.includes(forgePng), true);
assert.equal(multipartText.includes('name="model"'), true);
assert.equal(multipartText.includes("llamacpp::heretic-8b-q8_0"), true);
assert.equal(multipartText.includes('name="guidance"'), true);
assert.equal(multipartText.includes('name="dataset_guidance"'), true);
assert.match(multipartText, /name="dataset_guidance"\r\n\r\n0\r\n/);
assert.equal(multipartText.includes('name="contribution_terms"'), true);
assert.equal(multipartText.includes(Plugin.helpers.KREA2_CONTRIBUTION_TERMS_VERSION), true);
assert.equal(multipartText.includes('name="job_id"'), true);
assert.equal(multipartText.includes("1234567890abcdef1234567890abcdef"), true);
assert.equal(multipartText.includes("Prioritize literal clothing detail. Do not invent."), true);
assert.equal(multipartText.includes('name="controls"'), false);
assert.equal(multipartText.includes("https://"), false);

const supportedVisionFormats = [
    forgeFormat,
    detectImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0x00])),
    detectImageFormat(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]))
];
for (const format of supportedVisionFormats) assert.equal(isVisionSupportedFormat(format), true, format?.kind);
const unsupportedVisionSamples = [
    Buffer.from("GIF89a", "ascii"),
    Buffer.from([0x42, 0x4d, 0x00, 0x00]),
    Buffer.from([0x49, 0x49, 0x2a, 0x00]),
    Buffer.concat([Buffer.alloc(4), Buffer.from("ftypavif", "ascii")])
];
const unsupportedVisionFormats = unsupportedVisionSamples.map(detectImageFormat);
assert.deepEqual(unsupportedVisionFormats.map(format => format?.kind), ["gif", "bmp", "tiff", "avif"]);
for (const format of unsupportedVisionFormats) assert.equal(isVisionSupportedFormat(format), false, format?.kind);

const boundedResponseBuffer = Buffer.from("hello vision");
assert.equal(await readBoundedResponseText({
    headers: {get: () => "12"},
    arrayBuffer: async () => boundedResponseBuffer.buffer.slice(
        boundedResponseBuffer.byteOffset,
        boundedResponseBuffer.byteOffset + boundedResponseBuffer.byteLength
    )
}, 32), "hello vision");
await assert.rejects(
    readBoundedResponseText({headers: {get: () => "33"}}, 32),
    /oversized response/
);

function exactArrayBuffer(buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function testVisionConfigSecurity() {
    const collector = new Plugin();
    assert.equal(collector.getVisionConfig(), null);
    collector.settings.visionToken = "v".repeat(32);
    assert.deepEqual(collector.getVisionConfig(), {
        endpoint: "http://127.0.0.1:7870/api/discord-describe",
        origin: "http://127.0.0.1:7870",
        token: "v".repeat(32),
        model: "llamacpp::heretic-8b-q8_0"
    });
    collector.settings.visionExecutionMode = "online";
    assert.equal(collector.getVisionConfig().model, ONLINE_VISION_MODEL_ID);
    collector.settings.visionToken = "too-short";
    assert.throws(() => collector.getVisionConfig(), /32-512 character/);
    collector.settings.visionToken = "v".repeat(32);
    collector.settings.visionEndpoint = "https://example.com/api/discord-describe";
    assert.throws(() => collector.getVisionConfig(), /literal host|loopback-only/);
}

testVisionConfigSecurity();

async function testVisionRequestContract() {
    const collector = new Plugin();
    const endpoint = "http://127.0.0.1:7870/api/discord-describe";
    const token = "s".repeat(48);
    const responseBuffer = Buffer.from(JSON.stringify({
        classification: "usable",
        prompt: detailedVisionPrompt,
        prompt_variants: detailedVisionPromptVariants,
        model: "hybrid-local",
        prompt_words: 384,
        pipeline_id: VISION_PIPELINE_ID,
        dataset_guidance: disabledDatasetGuidance
    }), "utf8");
    const captured = [];
    collector.settings = {...DEFAULT_SETTINGS, shareDatasetContributions: true};
    collector.api = {Data: {load: key => key === "onboardingState" ? {
        version: 9,
        contributionTermsVersion: Plugin.helpers.KREA2_CONTRIBUTION_TERMS_VERSION
    } : key === "privacyReceipt" ? {version: PRIVACY_RECEIPT_VERSION, acceptedAt: Date.now()} : null}, Net: {fetch: async (url, options) => {
        captured.push({url, options});
        if (url.endsWith("/api/discord-session")) {
            const sessionBuffer = Buffer.from(JSON.stringify({
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
                arrayBuffer: async () => exactArrayBuffer(sessionBuffer)
            };
        }
        return {
            ok: true,
            status: 200,
            redirected: false,
            url: endpoint,
            headers: {get: name => name.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : String(responseBuffer.byteLength)},
            arrayBuffer: async () => exactArrayBuffer(responseBuffer)
        };
    }}};
    const result = await collector.requestVisionPrompt(
        {bytes: forgePng, sha256: sha256Hex(forgePng), format: forgeFormat},
        {filename: `${sha256Hex(forgePng)}.png`},
        {endpoint, origin: "http://127.0.0.1:7870", token, model: "llamacpp::heretic-8b-q8_0"},
        new AbortController().signal
    );
    assert.equal(result.prompt, normalizedDetailedVisionPrompt);
    assert.deepEqual(result.prompt_variants, detailedVisionPromptVariants);
    assert.equal(result.model, "hybrid-local");
    assert.equal(result.prompt_words, 384);
    assert.equal(result.pipeline_id, VISION_PIPELINE_ID);
    assert.deepEqual(result.dataset_guidance, disabledDatasetGuidance);
    assert.equal(result.cache_identity.dataset_guidance.enabled, false);
    assert.match(result.request_cache_key, /^[a-f0-9]{64}$/);
    assert.equal(captured.length, 2);
    const sessionRequest = captured[0];
    const imageRequest = captured[1];
    assert.equal(sessionRequest.url, "http://127.0.0.1:7870/api/discord-session");
    assert.equal(sessionRequest.options.headers["X-Krea2-Vision-Token"], token);
    assert.equal(JSON.parse(sessionRequest.options.body).model, "llamacpp::heretic-8b-q8_0");
    assert.equal(imageRequest.url, endpoint);
    assert.equal(imageRequest.options.method, "POST");
    assert.equal(imageRequest.options.redirect, "manual");
    assert.equal(imageRequest.options.maxRedirects, 0);
    assert.equal(imageRequest.options.timeout, 60 * 60 * 1000);
    assert.equal(imageRequest.options.headers["X-Krea2-Vision-Token"], undefined);
    assert.equal(imageRequest.options.headers["X-Krea2-Vision-Session"], "q".repeat(64));
    assert.equal(imageRequest.options.headers.Authorization, undefined);
    assert.match(imageRequest.options.headers["Content-Type"], /^multipart\/form-data; boundary=/);
    assert.equal(Buffer.isBuffer(imageRequest.options.body), true);
    assert.equal(imageRequest.options.body.includes(forgePng), true);
    assert.equal(imageRequest.options.body.toString("latin1").includes("llamacpp::heretic-8b-q8_0"), true);
    assert.match(imageRequest.options.body.toString("latin1"), /name="dataset_guidance"\r\n\r\n0\r\n/);
    assert.equal(imageRequest.options.body.toString("latin1").includes('name="contribution_terms"'), true);
    assert.equal(imageRequest.options.body.toString("latin1").includes('name="controls"'), false);
    assert.equal(imageRequest.options.body.toString("latin1").includes("discordapp"), false);

    const errorBuffer = Buffer.from(JSON.stringify({detail: "GPU queue busy\ntry again", debug: "must not surface"}), "utf8");
    collector.api.Net.fetch = async url => {
        if (url.endsWith("/api/discord-session")) {
            const sessionBuffer = Buffer.from(JSON.stringify({
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
                arrayBuffer: async () => exactArrayBuffer(sessionBuffer)
            };
        }
        return {
            ok: false,
            status: 422,
            redirected: false,
            url: endpoint,
            headers: {get: name => name.toLowerCase() === "content-type" ? "application/json" : String(errorBuffer.byteLength)},
            arrayBuffer: async () => exactArrayBuffer(errorBuffer)
        };
    };
    await assert.rejects(
        collector.requestVisionPrompt(
            {bytes: forgePng, sha256: sha256Hex(forgePng), format: forgeFormat},
            {filename: `${sha256Hex(forgePng)}.png`},
            {endpoint, origin: "http://127.0.0.1:7870", token, model: "llamacpp::heretic-8b-q8_0"},
            new AbortController().signal
        ),
        error => /HTTP 422: GPU queue busy try again/.test(error.message) && !error.message.includes("must not surface")
    );
}

await testVisionRequestContract();

async function testVisionPromptStaysLocal() {
    const collector = new Plugin();
    collector.settings = {...DEFAULT_SETTINGS, shareDatasetContributions: false};
    collector.api = {Data: {save: () => {}}};
    collector.setButtonState = (button, state) => { button.state = state; };
    let toast;
    collector.toast = (message, level) => { toast = {message, level}; };
    const button = {};
    const imageHash = sha256Hex(forgePng);
    const args = {
        button,
        config: {guildId: "123456", channelId: "654321"},
        provenance: {attachmentId: "777777", attachmentChannelId: "654321", kind: "attachment"},
        messageId: "888888",
        original: {bytes: forgePng, sha256: imageHash, format: forgeFormat},
        prompt: normalizedDetailedVisionPrompt,
        sidecarPath: `C:\\dataset\\${imageHash}.vision.txt`,
        signal: new AbortController().signal
    };

    collector.getUploadConfig = () => { throw new Error("Magnifier must not inspect candidate-upload settings."); };
    collector.uploadCandidate = async () => { throw new Error("Magnifier must never upload a Vision prompt."); };
    await collector.finishVisionPrompt(args);
    assert.equal(button.state, "vision-ready");
    assert.deepEqual(toast, {message: "Three prompts are ready in session memory. Krea2 contribution is off.", level: "success"});
    assert.equal(collector.sentHashes.has(`${imageHash}:vision_ai`), false);
    assert.equal(collector.sentHashes.has(`${imageHash}:embedded_metadata`), false);
}

await testVisionPromptStaysLocal();

async function testVisionJobDedupeAndSerialization() {
    const collector = new Plugin();
    const hashB = "b".repeat(64);
    const started = [];
    let active = 0;
    let maxActive = 0;
    let finishFirst;
    const first = collector.getOrQueueVisionJob(hashA, async () => {
        started.push("a");
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => { finishFirst = resolve; });
        active -= 1;
        return "first-result";
    });
    const sameHash = collector.getOrQueueVisionJob(hashA, async () => {
        throw new Error("same-hash factory must never run");
    });
    const secondHash = collector.getOrQueueVisionJob(hashB, async () => {
        started.push("b");
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
        return "second-result";
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(first.shared, false);
    assert.equal(sameHash.shared, true);
    assert.equal(sameHash.job, first.job);
    assert.equal(secondHash.shared, false);
    assert.deepEqual(started, ["a"]);
    finishFirst();
    assert.deepEqual(await Promise.all([first.job, sameHash.job, secondHash.job]), ["first-result", "first-result", "second-result"]);
    assert.deepEqual(started, ["a", "b"]);
    assert.equal(maxActive, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(collector.visionInflightByRequest.size, 0);
}

await testVisionJobDedupeAndSerialization();

async function testEntireVisionFlowSerialization() {
    const collector = new Plugin();
    collector.running = true;
    collector.generation = 9;
    collector.validateLocalCollectionSettings = () => ({guildId: "123456", channelId: "654321"});
    collector.attachmentBelongsToGuild = () => true;
    collector.setButtonState = (button, state) => { button.state = state; };
    collector.toast = () => {};

    let activeDownloads = 0;
    let maxActiveDownloads = 0;
    let liveBodyBytes = 0;
    let maxLiveBodyBytes = 0;
    let completed = 0;
    collector.analyzeWithVision = async (_image, button) => {
        const simulatedDownloadedBody = Buffer.alloc(4096, button.id);
        activeDownloads += 1;
        liveBodyBytes += simulatedDownloadedBody.byteLength;
        maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
        maxLiveBodyBytes = Math.max(maxLiveBodyBytes, liveBodyBytes);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(simulatedDownloadedBody[0], button.id);
        liveBodyBytes -= simulatedDownloadedBody.byteLength;
        activeDownloads -= 1;
        completed += 1;
        button.dataset.busy = "false";
    };

    for (let index = 1; index <= 12; index += 1) {
        const image = {
            isConnected: true,
            closest: () => null,
            currentSrc: `https://cdn.discordapp.com/attachments/654321/${700000 + index}/image.png?ex=a&is=b&hm=c`,
            dataset: {}
        };
        const button = {dataset: {}, isConnected: true, id: index};
        collector.queueVisionAnalysis(image, button);
        assert.equal(button.state, "vision-queued");
    }
    await collector.visionFlowQueue;
    assert.equal(completed, 12);
    assert.equal(maxActiveDownloads, 1);
    assert.equal(maxLiveBodyBytes, 4096);
    assert.equal(liveBodyBytes, 0);
}

await testEntireVisionFlowSerialization();

function testLocalVisionQueueVisibility() {
    const collector = new Plugin();
    collector.renderHistoryRail = () => {};
    collector.settings.visionModel = "llamacpp::heretic-4b-q8_0";
    const first = collector.addLocalVisionSubmission({config: {visionModel: collector.settings.visionModel}});
    const second = collector.addLocalVisionSubmission({config: {visionModel: collector.settings.visionModel}});
    assert.equal(collector.getLocalVisionHistoryJobs().length, 2);
    assert.match(collector.localVisionSubmissions.get(second).stage, /1 earlier Discord image/);
    collector.updateLocalVisionSubmission(first, {image_hash: hashA, local_title: "Image aaaaaaaaaa"});
    assert.equal(collector.getLocalVisionHistoryJobs().find(job => job.id === first).image_hash, hashA);
    collector.removeLocalVisionSubmission(first);
    assert.equal(collector.getLocalVisionHistoryJobs().length, 1);
}

testLocalVisionQueueVisibility();

async function testLocalSubmissionTimesOutAfterThirtySecondsWithoutGpu() {
    const collector = new Plugin();
    collector.running = true;
    collector.generation = 12;
    collector.settings.visionExecutionMode = "online";
    collector.validateLocalCollectionSettings = () => ({guildId: "123456", channelId: "654321"});
    collector.attachmentBelongsToGuild = () => true;
    collector.renderHistoryRail = () => {};
    collector.toast = () => {};
    collector.log = () => {};
    const reports = [];
    collector.queueOperationalError = report => reports.push(report);
    let releaseEarlierFlow;
    collector.visionFlowQueue = new Promise(resolve => { releaseEarlierFlow = resolve; });
    const image = {
        isConnected: true,
        currentSrc: "https://cdn.discordapp.com/attachments/654321/777777/image.png?ex=a&is=b&hm=c",
        dataset: {},
        closest: () => null
    };
    const button = {dataset: {}, isConnected: true};
    collector.setButtonState = (_button, state, _text, title) => { button.state = state; button.title = title; };
    let timeoutCallback = null;
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    global.setTimeout = (callback, milliseconds) => {
        assert.equal(milliseconds, 30000);
        timeoutCallback = callback;
        return 1234;
    };
    global.clearTimeout = () => {};
    try {
        collector.queueVisionAnalysis(image, button);
        assert.equal(button.state, "vision-queued");
        assert.equal(typeof timeoutCallback, "function");
        timeoutCallback();
        const [job] = collector.getLocalVisionHistoryJobs();
        assert.equal(job.status, "error");
        assert.equal(job.public_error, "GPU not available");
        assert.equal(button.state, "error");
        assert.match(button.title, /GPU not available/);
        assert.equal(button.dataset.busy, "false");
        assert.equal(reports.length, 1);
        assert.equal(reports[0].errorCode, "gpu_not_available");
        releaseEarlierFlow();
        await collector.visionFlowQueue;
        assert.equal(collector.getLocalVisionHistoryJobs()[0].status, "error");
    }
    finally {
        global.setTimeout = realSetTimeout;
        global.clearTimeout = realClearTimeout;
    }
}

await testLocalSubmissionTimesOutAfterThirtySecondsWithoutGpu();

async function testOperationalErrorFallsBackDirectlyWhenBrokerCannotDeliver() {
    const collector = new Plugin();
    collector.running = true;
    collector.getVisionConfig = () => ({origin: "http://127.0.0.1:7870", token: "v".repeat(32)});
    collector.pendingOperationalErrors = [{
        event_id: "8".repeat(32),
        model_id: "vast::gemma4-26b-a4b-heretic-q3_k_l",
        error_code: "gpu_not_available",
        error_message: "GPU not available",
        stage: "Waiting for capacity"
    }];
    const calls = [];
    collector.api = {Net: {fetch: async (url, options) => {
        calls.push({url, options});
        if (url.startsWith("http://127.0.0.1")) {
            return {ok: false, status: 503, redirected: false, url};
        }
        const payload = JSON.parse(options.body);
        return {
            ok: true,
            status: 200,
            redirected: false,
            url,
            headers: {get: () => null},
            arrayBuffer: async () => Buffer.from(JSON.stringify({
                accepted: true,
                report_sha256: payload.report_sha256
            }))
        };
    }}};
    await collector.flushOperationalErrors();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "https://seedframe.xyz/api/diagnostics/krea2-vision");
    assert.equal(collector.pendingOperationalErrors.length, 0);
    const directPayload = JSON.parse(calls[1].options.body);
    for (const forbidden of ["image", "image_hash", "prompt", "discord_username", "filename", "local_path"]) {
        assert.equal(Object.hasOwn(directPayload, forbidden), false);
    }
}

await testOperationalErrorFallsBackDirectlyWhenBrokerCannotDeliver();

async function runQueuedVisionDomMutation({nextUrl, nextMessageRoot}) {
    const collector = new Plugin();
    collector.running = true;
    collector.generation = 11;
    collector.validateLocalCollectionSettings = () => ({
        guildId: "123456",
        channelId: "654321",
        saveFolder: "C:\\dataset"
    });
    collector.attachmentBelongsToGuild = () => true;
    collector.setButtonState = (button, state, _text, title) => {
        button.state = state;
        button.title = title;
    };
    collector.toast = () => {};
    collector.log = () => {};

    let releaseEarlierFlow;
    collector.visionFlowQueue = new Promise(resolve => { releaseEarlierFlow = resolve; });

    const root = {id: "chat-messages-654321-888888", dataset: {}};
    const clickedUrl = "https://cdn.discordapp.com/attachments/654321/777777/a.png?ex=old&is=old&hm=old";
    const image = {
        isConnected: true,
        currentSrc: clickedUrl,
        dataset: {},
        closest: selector => selector.includes("chat-messages") ? root : null
    };
    const button = {dataset: {}, isConnected: true};
    const downstreamSelections = [];
    collector.analyzeWithVision = async selection => {
        downstreamSelections.push(selection);
        button.dataset.busy = "false";
    };

    collector.queueVisionAnalysis(image, button);
    assert.equal(button.state, "vision-queued");
    assert.equal(button.dataset.busy, "true");
    image.currentSrc = nextUrl;
    root.id = nextMessageRoot;
    releaseEarlierFlow();
    await collector.visionFlowQueue;

    return {button, clickedUrl, downstreamSelections};
}

async function testVisionQueueRejectsRecycledDiscordDom() {
    const recycled = await runQueuedVisionDomMutation({
        nextUrl: "https://cdn.discordapp.com/attachments/654321/999999/b.png?ex=new&is=new&hm=new",
        nextMessageRoot: "chat-messages-654321-101010"
    });
    assert.equal(recycled.downstreamSelections.length, 0, "recycled image B must never reach download/save/Vision analysis");
    assert.equal(recycled.button.state, "error");
    assert.equal(recycled.button.dataset.busy, "false");
    assert.match(recycled.button.title, /no longer matches the Discord attachment selected at click/);

    const recycledMessageOnly = await runQueuedVisionDomMutation({
        nextUrl: recycled.clickedUrl,
        nextMessageRoot: "chat-messages-654321-202020"
    });
    assert.equal(recycledMessageOnly.downstreamSelections.length, 0, "a recycled message root must never reach downstream work");
    assert.equal(recycledMessageOnly.button.state, "error");
    assert.match(recycledMessageOnly.button.title, /no longer matches the Discord message selected at click/);
}

await testVisionQueueRejectsRecycledDiscordDom();

async function testVisionQueueRefreshesMatchingSignedUrl() {
    const refreshedUrl = "https://cdn.discordapp.com/attachments/654321/777777/a.png?ex=fresh&is=fresh&hm=fresh";
    const result = await runQueuedVisionDomMutation({
        nextUrl: refreshedUrl,
        nextMessageRoot: "chat-messages-654321-888888"
    });
    assert.equal(result.downstreamSelections.length, 1);
    const selection = result.downstreamSelections[0];
    assert.equal(selection.sourceUrlAtClick, result.clickedUrl);
    assert.equal(selection.sourceUrl, refreshedUrl);
    assert.equal(selection.messageId, "888888");
    assert.deepEqual(selection.provenance, {
        kind: "attachment",
        path: "/attachments/654321/777777/a.png",
        attachmentChannelId: "654321",
        attachmentId: "777777"
    });
    assert.equal(Object.isFrozen(selection), true);
    assert.equal(Object.isFrozen(selection.provenance), true);
    assert.equal(Object.isFrozen(selection.config), true);
}

await testVisionQueueRefreshesMatchingSignedUrl();

async function testLocalSaving() {
    const tempFolder = fs.mkdtempSync(path.join(__dirname, "collector-test-"));
    try {
        const hash = sha256Hex(forgePng);
        const first = await saveOriginalImage(tempFolder, forgePng, hash, forgeFormat);
        const second = await saveOriginalImage(tempFolder, forgePng, hash, forgeFormat);
        assert.equal(first.filename, `${hash}.png`);
        assert.equal(second.filePath, first.filePath);
        assert.equal(second.deduplicated, true);
        assert.deepEqual(fs.readFileSync(first.filePath), forgePng);
        const sidecar = await savePromptSidecar(first.filePath, "beautiful woman, cinematic light");
        assert.equal(fs.readFileSync(sidecar, "utf8"), "beautiful woman, cinematic light\r\n");
        const visionSidecar = await saveVisionPromptSidecar(first.filePath, detailedVisionPrompt);
        const sameVisionSidecar = await saveVisionPromptSidecar(first.filePath, detailedVisionPrompt);
        const alternateVisionSidecar = await saveVisionPromptSidecar(first.filePath, `${detailedVisionPrompt} extra supported detail`);
        assert.equal(path.basename(visionSidecar), `${hash}.vision.txt`);
        assert.equal(sameVisionSidecar, visionSidecar);
        assert.notEqual(alternateVisionSidecar, visionSidecar);
        assert.match(path.basename(alternateVisionSidecar), new RegExp(`^${hash}\\.vision-[a-f0-9]{12}\\.txt$`));
        assert.equal(fs.readFileSync(sidecar, "utf8"), "beautiful woman, cinematic light\r\n");
        assert.equal(fs.readFileSync(visionSidecar, "utf8"), `${detailedVisionPrompt}\r\n`);
        assert.deepEqual(await readReusableVisionPrompt(first.filePath, fs, hash), {
            prompt: normalizedDetailedVisionPrompt,
            prompt_variants: [normalizedDetailedVisionPrompt],
            sidecarPath: visionSidecar
        });

        for (let index = 0; index < unsupportedVisionSamples.length; index += 1) {
            const bytes = unsupportedVisionSamples[index];
            const format = unsupportedVisionFormats[index];
            const unsupportedHash = sha256Hex(bytes);
            const saved = await saveOriginalImage(tempFolder, bytes, unsupportedHash, format);
            assert.equal(fs.existsSync(saved.filePath), true);
            assert.equal(isVisionSupportedFormat(format), false);
        }

        fs.writeFileSync(visionSidecar, "too short\r\n", "utf8");
        assert.equal(await readReusableVisionPrompt(first.filePath, fs, hash), null);
    }
    finally {
        fs.rmSync(tempFolder, {recursive: true, force: true});
    }
}

await testLocalSaving();

async function testBetterDiscordFileSystemShimWithoutPromises() {
    const tempFolder = fs.mkdtempSync(path.join(__dirname, "collector-bd-fs-test-"));
    let unexpectedAsyncCalls = 0;
    const betterDiscordShapedFileSystem = {
        mkdir() { unexpectedAsyncCalls += 1; throw new Error("BetterDiscord async-named mkdir must not be used"); },
        readFile() { unexpectedAsyncCalls += 1; throw new Error("BetterDiscord async-named readFile must not be used"); },
        unlink() { unexpectedAsyncCalls += 1; throw new Error("BetterDiscord synchronous unlink alias must not be treated as callback-based"); },
        writeFile() { unexpectedAsyncCalls += 1; throw new Error("BetterDiscord async-named writeFile must not be used"); },
        mkdirSync: fs.mkdirSync.bind(fs),
        readFileSync(filePath, encoding = "utf8") { return fs.readFileSync(filePath, encoding); },
        unlinkSync: fs.unlinkSync.bind(fs),
        writeFileSync: fs.writeFileSync.bind(fs)
    };
    assert.equal(betterDiscordShapedFileSystem.promises, undefined);
    try {
        const hash = sha256Hex(forgePng);
        const first = await saveOriginalImage(tempFolder, forgePng, hash, forgeFormat, betterDiscordShapedFileSystem);
        const second = await saveOriginalImage(tempFolder, forgePng, hash, forgeFormat, betterDiscordShapedFileSystem);
        const missingSidecarFileSystem = {
            ...betterDiscordShapedFileSystem,
            readFileSync(filePath) {
                throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
            }
        };
        assert.equal(await readReusableVisionPrompt(first.filePath, missingSidecarFileSystem, hash), null);
        const firstSidecar = await savePromptSidecar(first.filePath, "beautiful woman, cinematic light", betterDiscordShapedFileSystem);
        const secondSidecar = await savePromptSidecar(first.filePath, "beautiful woman, cinematic light", betterDiscordShapedFileSystem);
        const firstVisionSidecar = await saveVisionPromptSidecar(first.filePath, detailedVisionPrompt, betterDiscordShapedFileSystem);
        const secondVisionSidecar = await saveVisionPromptSidecar(first.filePath, detailedVisionPrompt, betterDiscordShapedFileSystem);
        const overwritePath = path.join(tempFolder, "betterdiscord-overwrite.txt");
        await writeFileCompat(betterDiscordShapedFileSystem, overwritePath, "thumbnail-compatible", {encoding: "utf8", flag: "w"});
        assert.equal(await readFileCompat(betterDiscordShapedFileSystem, overwritePath, "utf8"), "thumbnail-compatible");
        assert.equal(isFileCompat({statSync() { throw new Error("shim stat unavailable"); }, existsSync: fs.existsSync}, overwritePath), true);
        assert.equal(isFileCompat({statSync() { throw new Error("shim stat unavailable"); }, existsSync: fs.existsSync}, path.join(tempFolder, "missing.png")), false);
        assert.equal(isFileCompat({readFileSync: fs.readFileSync.bind(fs)}, overwritePath), true);
        assert.equal(isFileCompat({readFileSync: fs.readFileSync.bind(fs)}, path.join(tempFolder, "missing.png")), false);
        const messageOnlyExistingFileSystem = {
            ...betterDiscordShapedFileSystem,
            writeFileSync(filePath) {
                throw new Error(`EEXIST: file already exists, open '${filePath}'`);
            }
        };
        assert.equal(
            await saveVisionPromptSidecar(first.filePath, detailedVisionPrompt, messageOnlyExistingFileSystem),
            firstVisionSidecar
        );
        assert.equal(second.deduplicated, true);
        assert.equal(secondSidecar, firstSidecar);
        assert.equal(secondVisionSidecar, firstVisionSidecar);
        assert.deepEqual(fs.readFileSync(first.filePath), forgePng);
        assert.equal(fs.readFileSync(firstSidecar, "utf8"), "beautiful woman, cinematic light\r\n");
        assert.equal(fs.readFileSync(firstVisionSidecar, "utf8"), `${detailedVisionPrompt}\r\n`);
        assert.equal(unexpectedAsyncCalls, 0);

        const cleanupFolder = path.join(tempFolder, "cleanup");
        let cleanupCalls = 0;
        const failingFileSystem = {
            ...betterDiscordShapedFileSystem,
            unlinkSync(filePath) {
                cleanupCalls += 1;
                fs.unlinkSync(filePath);
            },
            writeFileSync(filePath, bytes, options) {
                fs.writeFileSync(filePath, Buffer.from(bytes).subarray(0, 4), options);
                const error = new Error("simulated non-EEXIST write failure");
                error.code = "EIO";
                throw error;
            }
        };
        await assert.rejects(
            saveOriginalImage(cleanupFolder, forgePng, hash, forgeFormat, failingFileSystem),
            /simulated non-EEXIST write failure/
        );
        assert.equal(cleanupCalls, 1);
        assert.equal(fs.existsSync(path.join(cleanupFolder, `${hash}.png`)), false);
    }
    finally {
        fs.rmSync(tempFolder, {recursive: true, force: true});
    }
}

await testBetterDiscordFileSystemShimWithoutPromises();
assert.equal(fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.source.js"), "utf8").includes("fs.promises"), false);
console.log("Krea2DiscordCollector helper tests passed.");
}

run().catch(error => {
        console.error(error);
        process.exitCode = 1;
});
