/**
 * @name Krea2DiscordCollector
 * @author uroligh
 * @version 0.13.21
 * @description Local Discord Vision with three grounded prompt variants and automatic online Krea2 prompt contribution.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const {createHash, randomBytes} = require("crypto");

let parseHardenedPngPromptMetadata = null;
try {
    ({parsePngPromptMetadata: parseHardenedPngPromptMetadata} = require(
        path.join(__dirname, "Krea2DiscordCollector.parser.js")
    ));
}
catch {
    // The single-file fallback below remains fail-closed for ambiguous metadata.
}

const PLUGIN_NAME = "Krea2DiscordCollector";
const PLUGIN_VERSION = "0.13.21";
const STYLE_ID = "krea2-discord-collector-style";
const BUTTON_CLASS = "krea2-discord-collector-button";
const VISION_BUTTON_CLASS = "krea2-discord-vision-button";
const HOST_CLASS = "krea2-discord-collector-host";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_SAVED_HASHES = 5000;
const MAX_DIAGNOSTIC_SUMMARIES = 250;
const MAX_DIAGNOSTIC_CHUNKS = 96;
const MAX_CACHED_ORIGINALS = 1;
const HISTORY_THUMBNAIL_DIRECTORY = ".krea2-history-thumbnails";
const HISTORY_THUMBNAIL_MAX_SIDE = 640;
const HISTORY_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_PROBES = 250;
const METADATA_PROBE_RETRY_MS = 60 * 1000;
const MAX_VISION_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_VISION_PROMPT_CHARS = 100000;
const VISION_TIMEOUT_MS = 60 * 60 * 1000;
const GPU_AVAILABILITY_TIMEOUT_MS = 30 * 1000;
const MAX_PENDING_OPERATIONAL_ERRORS = 50;
const HISTORY_POLL_MS = 5000;
const HISTORY_DETAIL_POLL_MS = 1000;
const HISTORY_LIMIT = 100;
const HISTORY_PAGE_SIZE = 20;
const HISTORY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PRODUCT_FAVORITES = 500;
const MAX_EDITED_PROMPTS = 250;
const MAX_VISUAL_EMBEDDINGS = 250;
const MAX_REVIEW_RECORDS = 1000;
const MAX_MODEL_EVALUATIONS = 500;
const MAX_PROMPT_FEEDBACK_RECORDS = 500;
const FEEDBACK_SCHEMA = "krea2-local-feedback.v1";
const FEEDBACK_LIKED_COUNT = 4;
const FEEDBACK_DISLIKED_COUNT = 3;
const MAX_BLOCKED_SAMPLE_DIGESTS = 128;
const PRIVACY_RECEIPT_VERSION = 1;

function isCurrentPrivacyReceipt(receipt) {
    return Boolean(
        receipt &&
        Number(receipt.version) === PRIVACY_RECEIPT_VERSION &&
        Number.isFinite(Number(receipt.acceptedAt)) &&
        Number(receipt.acceptedAt) > 0
    );
}
const VISUAL_EMBEDDING_SIZE = 8;
const VISION_PIPELINE_ID = "discord-faithful-v9-external-support-wardrobe-lock";
const KREA2_CONTRIBUTION_TERMS_VERSION = "seedframe-krea2-vision-2026-08-25";
const KREA2_DIAGNOSTIC_TERMS_VERSION = "seedframe-krea2-vision-diagnostics-2026-08-25";
const KREA2_OPERATIONAL_ERROR_SCHEMA = "seedframe.krea2-vision-operational-error.v1";
const KREA2_OPERATIONAL_ERROR_NOTICE_VERSION = "seedframe-krea2-vision-operational-errors-2026-08-26";
const KREA2_OPERATIONAL_ERROR_ENDPOINT = "https://seedframe.xyz/api/diagnostics/krea2-vision";
const DIAGNOSTIC_RECEIPT_VERSION = 1;

function sanitizeOperationalErrorText(value, maximum = 600) {
    const normalized = String(value || "")
        .normalize("NFKC")
        .replace(/\b(?:token|secret|password|authorization|api[_ -]?key)\s*[:=]\s*\S+/gi, "[credential removed]")
        .replace(/https?:\/\/[^\s]+/gi, "[URL removed]")
        .replace(/\b[A-Za-z]:\\[^\r\n\t]+/g, "[path removed]")
        .replace(/\b[0-9a-f]{24,}\b/gi, "[identifier removed]")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return (normalized || "Unspecified operational error").slice(0, maximum);
}

function buildOperationalErrorReport(item, visionToken) {
    const token = String(visionToken || "");
    if (Buffer.byteLength(token, "utf8") < 32) throw new Error("A configured Vision token is required for error provenance.");
    const sourceInstance = createHash("sha256")
        .update(Buffer.concat([Buffer.from("Krea2VisionOperationalSource/v1\0", "utf8"), Buffer.from(token, "utf8")]))
        .digest("hex");
    const eventId = /^[a-f0-9]{32}$/.test(String(item?.event_id || "")) ? String(item.event_id) : randomBytes(16).toString("hex");
    const modelId = String(item?.model_id || "unknown").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200) || "unknown";
    const errorCode = String(item?.error_code || "operational_error").replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 80) || "operational_error";
    const errorMessage = sanitizeOperationalErrorText(item?.error_message, 600);
    const stage = sanitizeOperationalErrorText(item?.stage, 200);
    const runtime = modelId.startsWith("vast::") ? "remote" : "local";
    const payload = {
        schema: KREA2_OPERATIONAL_ERROR_SCHEMA,
        notice_version: KREA2_OPERATIONAL_ERROR_NOTICE_VERSION,
        source_instance_sha256: sourceInstance,
        event_id: eventId,
        model_id: modelId,
        pipeline_id: VISION_PIPELINE_ID,
        error_code: errorCode,
        error_message: errorMessage,
        stage,
        runtime,
        plugin_version: PLUGIN_VERSION,
        backend_version: "unavailable"
    };
    payload.report_sha256 = createHash("sha256").update(JSON.stringify([
        payload.schema, payload.notice_version, payload.source_instance_sha256, payload.event_id,
        payload.model_id, payload.pipeline_id, payload.error_code, payload.error_message,
        payload.stage, payload.runtime, payload.plugin_version, payload.backend_version
    ]), "utf8").digest("hex");
    return payload;
}

function isCurrentDiagnosticReceipt(receipt) {
    return Boolean(
        receipt &&
        Number(receipt.version) === DIAGNOSTIC_RECEIPT_VERSION &&
        receipt.termsVersion === KREA2_DIAGNOSTIC_TERMS_VERSION &&
        Number.isFinite(Number(receipt.acceptedAt)) &&
        Number(receipt.acceptedAt) > 0
    );
}
const VISION_SIDECAR_SCHEMA_VERSION = 2;
const KREA2_GUIDANCE_SAMPLE_COUNT = 8;
const HISTORY_ROOT_ID = "krea2-discord-history-root";
const HISTORY_MODAL_ID = "krea2-discord-history-modal";
const PRODUCT_MODAL_ID = "krea2-discord-product-modal";
const ONBOARDING_MODAL_ID = "krea2-discord-onboarding-modal";
const ONBOARDING_VERSION = 9;
const DEFAULT_SAVE_FOLDER = path.join(String(process.env.USERPROFILE || process.env.HOME || "."), "Pictures", "Krea2Vision");
const HERETIC_MODEL_SPECS = Object.freeze([
    Object.freeze({
        public_id: "llamacpp::heretic-2b-f16",
        label: "Heretic — Qwen3-VL 2B F16",
        short_label: "2B F16",
        estimated_vram_mb: 6144,
        last_measured_peak_mb: 15085,
        safety_reserve_mb: 4096,
        admission_required_mb: 19181,
        allocation_target_mb: 12288,
        over_allocation_target: false,
        parameter_size_b: 2,
        download_bytes: 3892404928,
        model_download_url: "https://huggingface.co/mradermacher/Qwen-3-VL-2B-Instruct-heretic-GGUF/resolve/ef376dc99d248134d412ad5b84039c81a3d9a01e/Qwen-3-VL-2B-Instruct-heretic.f16.gguf?download=true",
        projector_download_url: "https://huggingface.co/mradermacher/Qwen-3-VL-2B-Instruct-heretic-GGUF/resolve/ef376dc99d248134d412ad5b84039c81a3d9a01e/Qwen-3-VL-2B-Instruct-heretic.mmproj-Q8_0.gguf?download=true",
        model_card_url: "https://huggingface.co/mradermacher/Qwen-3-VL-2B-Instruct-heretic-GGUF"
    }),
    Object.freeze({
        public_id: "llamacpp::heretic-4b-q8_0",
        label: "Heretic — Qwen3-VL 4B Q8_0",
        short_label: "4B Q8_0",
        estimated_vram_mb: 7680,
        last_measured_peak_mb: 16840,
        safety_reserve_mb: 4096,
        admission_required_mb: 20936,
        allocation_target_mb: 12288,
        over_allocation_target: false,
        parameter_size_b: 4,
        download_bytes: 4734381856,
        model_download_url: "https://huggingface.co/mradermacher/Qwen3-VL-4B-Instruct-heretic-GGUF/resolve/fc66f488427738c8a4ed90a9a3e2c959ea86b0b9/Qwen3-VL-4B-Instruct-heretic.Q8_0.gguf?download=true",
        projector_download_url: "https://huggingface.co/mradermacher/Qwen3-VL-4B-Instruct-heretic-GGUF/resolve/fc66f488427738c8a4ed90a9a3e2c959ea86b0b9/Qwen3-VL-4B-Instruct-heretic.mmproj-Q8_0.gguf?download=true",
        model_card_url: "https://huggingface.co/mradermacher/Qwen3-VL-4B-Instruct-heretic-GGUF"
    }),
    Object.freeze({
        public_id: "llamacpp::heretic-8b-q8_0",
        label: "Heretic — Qwen3-VL 8B Q8_0",
        short_label: "8B Q8_0",
        estimated_vram_mb: 13312,
        last_measured_peak_mb: 10522,
        safety_reserve_mb: 4096,
        admission_required_mb: 17408,
        allocation_target_mb: 12288,
        over_allocation_target: true,
        parameter_size_b: 8,
        download_bytes: 9461810784,
        model_download_url: "https://huggingface.co/mradermacher/Qwen-3-VL-8B-Instruct-heretic-GGUF/resolve/ee9e0de47684c84abba6e420f5f89625813a08f4/Qwen-3-VL-8B-Instruct-heretic.Q8_0.gguf?download=true",
        projector_download_url: "https://huggingface.co/mradermacher/Qwen-3-VL-8B-Instruct-heretic-GGUF/resolve/ee9e0de47684c84abba6e420f5f89625813a08f4/Qwen-3-VL-8B-Instruct-heretic.mmproj-Q8_0.gguf?download=true",
        model_card_url: "https://huggingface.co/mradermacher/Qwen-3-VL-8B-Instruct-heretic-GGUF"
    }),
    Object.freeze({
        public_id: "llamacpp::glm4-9b-abliterated-q5_k_m",
        label: "Abliterated — GLM-4.6V Flash 9B Q5_K_M",
        short_label: "9B GLM Q5_K_M",
        estimated_vram_mb: 12288,
        last_measured_peak_mb: 0,
        safety_reserve_mb: 4096,
        admission_required_mb: 16384,
        allocation_target_mb: 12288,
        over_allocation_target: false,
        parameter_size_b: 9,
        download_bytes: 8081308800,
        model_download_url: "https://huggingface.co/AliBilge/Huihui-GLM-4.6V-Flash-abliterated/resolve/a59894e6bca5a86d601faf654587d1353f5f8f0f/Huihui-GLM-4.6V-Flash-abliterated-Q5_K_M.gguf?download=true",
        projector_download_url: "https://huggingface.co/mradermacher/Huihui-GLM-4.6V-Flash-abliterated-GGUF/resolve/9360ea4a6160764032619ef680d34ef4620961e9/Huihui-GLM-4.6V-Flash-abliterated.mmproj-Q8_0.gguf?download=true",
        model_card_url: "https://huggingface.co/AliBilge/Huihui-GLM-4.6V-Flash-abliterated"
    }),
    Object.freeze({
        public_id: "llamacpp::gemma4-12b-opus-uncensored-q8_0",
        label: "Uncensored — Gemma 4 12B Opus 4.7 CoT Q8_0",
        short_label: "12B Opus Q8_0",
        estimated_vram_mb: 20992,
        last_measured_peak_mb: 0,
        safety_reserve_mb: 4096,
        admission_required_mb: 25088,
        allocation_target_mb: 12288,
        over_allocation_target: true,
        parameter_size_b: 12,
        download_bytes: 12828633440,
        model_download_url: "https://huggingface.co/Rangle2/gemma-4-12B-it-uncensored-opus4.7-cot/resolve/5b87c4f821f79d0b2a9bbf4ccbb3d260f302517a/gemma-4-12B-it-uncensored-opus4.7-cot-Q8_0.gguf?download=true",
        projector_download_url: "https://huggingface.co/ggml-org/gemma-4-12B-it-GGUF/resolve/e3e681731089efaa3f0917336944ac64752db8ba/mmproj-gemma-4-12B-it-Q8_0.gguf?download=true",
        model_card_url: "https://huggingface.co/Rangle2/gemma-4-12B-it-uncensored-opus4.7-cot"
    }),
    Object.freeze({
        public_id: "llamacpp::gemma4-12b-heretic-q8_0",
        label: "Heretic — Gemma 4 12B Q8_0",
        short_label: "12B Heretic Q8_0",
        estimated_vram_mb: 20992,
        last_measured_peak_mb: 0,
        safety_reserve_mb: 4096,
        admission_required_mb: 25088,
        allocation_target_mb: 12288,
        over_allocation_target: true,
        parameter_size_b: 12,
        download_bytes: 12844764384,
        model_download_url: "https://huggingface.co/llmfan46/gemma-4-12B-it-uncensored-heretic-GGUF/resolve/e169171d3f2d19734afc1fb6521daa4da1c0a5bd/gemma-4-12B-it-uncensored-heretic-Q8_0.gguf?download=true",
        projector_download_url: "https://huggingface.co/llmfan46/gemma-4-12B-it-uncensored-heretic-GGUF/resolve/e169171d3f2d19734afc1fb6521daa4da1c0a5bd/gemma-4-12B-it-uncensored-heretic-mmproj-BF16.gguf?download=true",
        model_card_url: "https://huggingface.co/llmfan46/gemma-4-12B-it-uncensored-heretic-GGUF"
    }),
    Object.freeze({
        public_id: "llamacpp::gemma4-26b-a4b-heretic-q3_k_l",
        label: "Heretic — Gemma 4 26B-A4B Q3_K_L",
        short_label: "26B-A4B Q3_K_L",
        estimated_vram_mb: 24576,
        last_measured_peak_mb: 0,
        safety_reserve_mb: 4096,
        admission_required_mb: 28672,
        allocation_target_mb: 12288,
        over_allocation_target: true,
        parameter_size_b: 26,
        download_bytes: 15019315424,
        model_download_url: "https://huggingface.co/llmfan46/gemma-4-26B-A4B-it-uncensored-heretic-GGUF/resolve/ea0259bf66bcd33b5f3425eb223932abaa0f4f07/gemma-4-26B-A4B-it-uncensored-heretic-Q3_K_L.gguf?download=true",
        projector_download_url: "https://huggingface.co/llmfan46/gemma-4-26B-A4B-it-uncensored-heretic-GGUF/resolve/ea0259bf66bcd33b5f3425eb223932abaa0f4f07/gemma-4-26B-A4B-it-mmproj-BF16.gguf?download=true",
        model_card_url: "https://huggingface.co/llmfan46/gemma-4-26B-A4B-it-uncensored-heretic-GGUF"
    }),
    Object.freeze({
        public_id: "llamacpp::qwen3-vl-30b-a3b-abliterated-q2_k",
        label: "Abliterated — Qwen3-VL 30B-A3B Q2_K",
        short_label: "30B-A3B Q2_K",
        estimated_vram_mb: 18432,
        last_measured_peak_mb: 0,
        safety_reserve_mb: 4096,
        admission_required_mb: 22528,
        allocation_target_mb: 12288,
        over_allocation_target: true,
        parameter_size_b: 30,
        download_bytes: 11970760960,
        model_download_url: "https://huggingface.co/mradermacher/Qwen3-VL-30B-A3B-Instruct-abliterated-GGUF/resolve/06c53e7f17a17f3614ace0c5fcceceedd673e582/Qwen3-VL-30B-A3B-Instruct-abliterated.Q2_K.gguf?download=true",
        projector_download_url: "https://huggingface.co/mradermacher/Qwen3-VL-30B-A3B-Instruct-abliterated-GGUF/resolve/06c53e7f17a17f3614ace0c5fcceceedd673e582/Qwen3-VL-30B-A3B-Instruct-abliterated.mmproj-Q8_0.gguf?download=true",
        model_card_url: "https://huggingface.co/mradermacher/Qwen3-VL-30B-A3B-Instruct-abliterated-GGUF"
    }),
    Object.freeze({
        public_id: "llamacpp::gemma4-31b-heretic-q4_k_m",
        label: "Heretic — Gemma 4 31B Q4_K_M",
        short_label: "31B Q4_K_M",
        estimated_vram_mb: 24576,
        last_measured_peak_mb: 0,
        safety_reserve_mb: 4096,
        admission_required_mb: 28672,
        allocation_target_mb: 12288,
        over_allocation_target: true,
        parameter_size_b: 31,
        download_bytes: 19887789376,
        model_download_url: "https://huggingface.co/llmfan46/gemma-4-31B-it-uncensored-heretic-GGUF/resolve/eee61b81461ac75eb920a24ca9e5d420bb66e33d/gemma-4-31B-it-uncensored-heretic-Q4_K_M.gguf?download=true",
        projector_download_url: "https://huggingface.co/llmfan46/gemma-4-31B-it-uncensored-heretic-GGUF/resolve/eee61b81461ac75eb920a24ca9e5d420bb66e33d/gemma-4-31B-it-mmproj-BF16.gguf?download=true",
        model_card_url: "https://huggingface.co/llmfan46/gemma-4-31B-it-uncensored-heretic-GGUF"
    }),
    Object.freeze({
        public_id: "llamacpp::qwen3-vl-32b-heretic-q4_k_m",
        label: "Heretic — Qwen3-VL 32B Q4_K_M",
        short_label: "32B Q4_K_M",
        estimated_vram_mb: 26624,
        last_measured_peak_mb: 0,
        safety_reserve_mb: 4096,
        admission_required_mb: 30720,
        allocation_target_mb: 12288,
        over_allocation_target: true,
        parameter_size_b: 32,
        download_bytes: 20983456064,
        model_download_url: "https://huggingface.co/llmfan46/Qwen3-VL-32B-Instruct-ultra-uncensored-heretic-GGUF/resolve/1d2008adce22f0b1793be2d7b8cc960c0264d149/Qwen3-VL-32B-Instruct-ultra-uncensored-heretic-Q4_K_M.gguf?download=true",
        projector_download_url: "https://huggingface.co/llmfan46/Qwen3-VL-32B-Instruct-ultra-uncensored-heretic-GGUF/resolve/1d2008adce22f0b1793be2d7b8cc960c0264d149/Qwen3-VL-32B-Instruct-mmproj-BF16.gguf?download=true",
        model_card_url: "https://huggingface.co/llmfan46/Qwen3-VL-32B-Instruct-ultra-uncensored-heretic-GGUF"
    })
]);
const VISION_MODEL_OPTIONS = Object.freeze([
    ["Heretic — Qwen3-VL 2B F16 (6,144 MiB estimate)", "llamacpp::heretic-2b-f16"],
    ["Heretic — Qwen3-VL 4B Q8_0 (7,680 MiB estimate)", "llamacpp::heretic-4b-q8_0"],
    ["Heretic — Qwen3-VL 8B Q8_0 (preferred; 13,312 MiB estimate)", "llamacpp::heretic-8b-q8_0"],
    ["Abliterated — GLM-4.6V Flash 9B Q5_K_M (12,288 MiB estimate)", "llamacpp::glm4-9b-abliterated-q5_k_m"],
    ["Uncensored — Gemma 4 12B Opus 4.7 CoT Q8_0 (20,992 MiB estimate)", "llamacpp::gemma4-12b-opus-uncensored-q8_0"],
    ["Heretic — Gemma 4 12B Q8_0 (20,992 MiB estimate)", "llamacpp::gemma4-12b-heretic-q8_0"],
    ["Heretic — Gemma 4 26B-A4B Q3_K_L (24,576 MiB estimate)", "llamacpp::gemma4-26b-a4b-heretic-q3_k_l"],
    ["Abliterated — Qwen3-VL 30B-A3B Q2_K (18,432 MiB estimate)", "llamacpp::qwen3-vl-30b-a3b-abliterated-q2_k"],
    ["Heretic — Gemma 4 31B Q4_K_M (24,576 MiB estimate)", "llamacpp::gemma4-31b-heretic-q4_k_m"],
    ["Heretic — Qwen3-VL 32B Q4_K_M (26,624 MiB estimate)", "llamacpp::qwen3-vl-32b-heretic-q4_k_m"],
    ["Legacy Ollama hybrid", "discord::legacy-ollama-hybrid"]
]);
const ONLINE_VISION_MODEL_ID = "vast::gemma4-26b-a4b-heretic-q3_k_l";
const ONLINE_VISION_MODEL_LABEL = "Online API — Gemma 4 26B-A4B Heretic Q3_K_L (24 GB remote GPU)";
const REMOTE_GATEWAY_URL = "https://seedframe.xyz/api/krea2-vision";
const VISION_EXECUTION_OPTIONS = Object.freeze([
    ["Local GPU — use an installed model on this computer", "local"],
    ["Online API — Gemma 4 26B-A4B on the private remote worker (Discord sign-in required)", "online"]
]);
const LOCAL_VISION_MODEL_IDS = new Set(VISION_MODEL_OPTIONS.map(([, id]) => id));
const VISION_MODEL_IDS = new Set([...LOCAL_VISION_MODEL_IDS, ONLINE_VISION_MODEL_ID]);

const DEFAULT_SETTINGS = Object.freeze({
    visionEndpoint: "http://127.0.0.1:7870/api/discord-describe",
    visionToken: "",
    visionExecutionMode: "local",
    visionModel: "llamacpp::heretic-8b-q8_0",
    remoteLicense: null,
    allowedGuildIds: "",
    saveFolder: DEFAULT_SAVE_FOLDER,
    shareDatasetContributions: false,
    shareFailureDiagnostics: false,
    historyCollapsed: false,
    historyWidth: 330,
    completionToasts: true,
    completionSound: false,
    preferredPreset: "dataset-detailed",
    useKrea2DatasetGuidance: false,
    historyReviewFilter: "all"
});

function normalizeVisionExecutionMode(value) {
    return String(value || "").trim().toLowerCase() === "online" ? "online" : "local";
}

function effectiveVisionModel(settings = {}) {
    if (normalizeVisionExecutionMode(settings.visionExecutionMode) === "online") return ONLINE_VISION_MODEL_ID;
    const selected = String(settings.visionModel || "").trim();
    return LOCAL_VISION_MODEL_IDS.has(selected) ? selected : DEFAULT_SETTINGS.visionModel;
}

const PROMPT_PRESETS = Object.freeze([
    ["Detailed dataset caption", "dataset-detailed"],
    ["Short KREA2 prompt", "krea2-short"],
    ["Photorealistic recreation", "photorealistic"],
    ["Character & clothing", "character-clothing"],
    ["Environment only", "environment"],
    ["Product photography", "product"]
]);
const PROMPT_PRESET_IDS = new Set(PROMPT_PRESETS.map(([, id]) => id));

function normalizePromptPreset(raw) {
    const preset = String(raw || "").trim();
    return PROMPT_PRESET_IDS.has(preset) ? preset : DEFAULT_SETTINGS.preferredPreset;
}

function disabledDatasetGuidanceState() {
    return Object.freeze({
        enabled: false,
        status: "disabled",
        corpus_digest: null,
        sample_digest: null,
        sample_count: 0,
        feedback_digest: null,
        liked_count: 0,
        disliked_count: 0,
        blocked_sample_count: 0
    });
}

function normalizeDatasetGuidanceState(raw, {expectedEnabled = null, expectedFeedbackDigest = null} = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Vision Prompt Studio did not return Krea2 dataset-guidance metadata.");
    }
    const enabled = raw.enabled === true;
    const status = String(raw.status || "");
    const corpusDigest = raw.corpus_digest === null ? null : String(raw.corpus_digest || "").toLowerCase();
    const sampleDigest = raw.sample_digest === null ? null : String(raw.sample_digest || "").toLowerCase();
    const sampleCount = Number(raw.sample_count);
    const feedbackDigest = raw.feedback_digest === null || raw.feedback_digest === undefined
        ? null
        : String(raw.feedback_digest || "").toLowerCase();
    const likedCount = Number(raw.liked_count || 0);
    const dislikedCount = Number(raw.disliked_count || 0);
    const blockedSampleCount = Number(raw.blocked_sample_count || 0);
    if (expectedEnabled !== null && enabled !== (expectedEnabled === true)) {
        throw new Error("Vision Prompt Studio returned the wrong Krea2 dataset-guidance state.");
    }
    if (!enabled) {
        if (status !== "disabled" || corpusDigest !== null || sampleDigest !== null || sampleCount !== 0) {
            throw new Error("Vision Prompt Studio returned inconsistent disabled dataset-guidance metadata.");
        }
        if (feedbackDigest !== null || likedCount !== 0 || dislikedCount !== 0 || blockedSampleCount !== 0) {
            throw new Error("Vision Prompt Studio returned inconsistent disabled local-feedback metadata.");
        }
    }
    else if (
        status !== "applied" ||
        !/^[a-f0-9]{64}$/.test(corpusDigest || "") ||
        !/^[a-f0-9]{64}$/.test(sampleDigest || "") ||
        sampleCount !== KREA2_GUIDANCE_SAMPLE_COUNT
        || !/^[a-f0-9]{64}$/.test(feedbackDigest || "")
        || !Number.isInteger(likedCount) || likedCount < 0 || likedCount > FEEDBACK_LIKED_COUNT
        || !Number.isInteger(dislikedCount) || dislikedCount < 0 || dislikedCount > FEEDBACK_DISLIKED_COUNT
        || !Number.isInteger(blockedSampleCount) || blockedSampleCount < 0 || blockedSampleCount > MAX_BLOCKED_SAMPLE_DIGESTS
    ) {
        throw new Error(`Vision Prompt Studio did not confirm exactly ${KREA2_GUIDANCE_SAMPLE_COUNT} Krea2 guidance examples.`);
    }
    if (expectedFeedbackDigest !== null && feedbackDigest !== String(expectedFeedbackDigest || "").toLowerCase()) {
        throw new Error("Vision Prompt Studio did not confirm the exact local-feedback guidance context sent for this request.");
    }
    return Object.freeze({
        enabled,
        status,
        corpus_digest: corpusDigest,
        sample_digest: sampleDigest,
        sample_count: sampleCount,
        feedback_digest: feedbackDigest,
        liked_count: likedCount,
        disliked_count: dislikedCount,
        blocked_sample_count: blockedSampleCount
    });
}

function normalizePromptFeedbackText(raw) {
    try {
        return String(raw || "")
            .normalize("NFKC")
            .replace(/\r\n?/g, "\n")
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
            .split("\n")
            .map(line => line.trimEnd())
            .join("\n")
            .trim()
            .slice(0, 8000);
    }
    catch { return ""; }
}

function sanitizePromptFeedbackRecord(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const prompt = normalizePromptFeedbackText(raw.prompt);
    if (prompt.length < 120) return null;
    const id = sha256Hex(Buffer.from(prompt, "utf8"));
    const vote = raw.vote === "liked" ? "liked" : raw.vote === "disliked" ? "disliked" : "";
    if (!vote) return null;
    const reason = vote === "disliked"
        ? String(raw.reason || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 600)
        : "";
    if (vote === "disliked" && reason.length < 3) return null;
    const sampleDigest = /^[a-f0-9]{64}$/.test(String(raw.sample_digest || "").toLowerCase())
        ? String(raw.sample_digest).toLowerCase()
        : "";
    return Object.freeze({
        id,
        prompt,
        vote,
        reason,
        sample_digest: sampleDigest,
        updated: Math.max(0, Math.trunc(Number(raw.updated) || 0))
    });
}

function shuffledFeedback(records, random = Math.random) {
    const values = [...records];
    for (let index = values.length - 1; index > 0; index -= 1) {
        const target = Math.max(0, Math.min(index, Math.floor(Number(random()) * (index + 1))));
        [values[index], values[target]] = [values[target], values[index]];
    }
    return values;
}

function buildPromptFeedbackContext(rawRecords, random = Math.random) {
    const records = Object.values(rawRecords && typeof rawRecords === "object" && !Array.isArray(rawRecords) ? rawRecords : {})
        .map(sanitizePromptFeedbackRecord)
        .filter(Boolean);
    const liked = shuffledFeedback(records.filter(record => record.vote === "liked"), random).slice(0, FEEDBACK_LIKED_COUNT);
    const disliked = shuffledFeedback(records.filter(record => record.vote === "disliked"), random).slice(0, FEEDBACK_DISLIKED_COUNT);
    const blocked = [...new Set(records.filter(record => record.vote === "disliked").map(record => record.sample_digest).filter(Boolean))]
        .slice(-MAX_BLOCKED_SAMPLE_DIGESTS)
        .sort();
    const payload = {
        schema: FEEDBACK_SCHEMA,
        liked: liked.map(record => ({id: record.id, prompt: record.prompt})),
        disliked: disliked.map(record => ({id: record.id, prompt: record.prompt, reason: record.reason})),
        blocked_sample_digests: blocked
    };
    const canonical = {
        blocked_sample_digests: blocked,
        disliked: disliked.map(record => ({
            id: record.id,
            prompt_sha256: record.id,
            reason_sha256: sha256Hex(Buffer.from(record.reason, "utf8"))
        })),
        liked: liked.map(record => ({id: record.id, prompt_sha256: record.id}))
    };
    return Object.freeze({
        payload: JSON.stringify(payload),
        digest: sha256Hex(Buffer.from(JSON.stringify(canonical), "utf8")),
        liked_count: liked.length,
        disliked_count: disliked.length,
        blocked_sample_count: blocked.length
    });
}

function normalizeVisionCacheProfile(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Vision cache profile is invalid.");
    const requestedModel = String(raw.requested_model || "").trim();
    if (!requestedModel || requestedModel.length > 200) throw new Error("Vision cache profile model is invalid.");
    const pipelineId = String(raw.pipeline_id || "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,119}$/i.test(pipelineId)) throw new Error("Vision cache profile pipeline is invalid.");
    const guidanceSha256 = String(raw.guidance_sha256 || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(guidanceSha256)) throw new Error("Vision cache profile guidance digest is invalid.");
    return Object.freeze({
        requested_model: requestedModel,
        prompt_preset: normalizePromptPreset(raw.prompt_preset),
        pipeline_id: pipelineId,
        guidance_sha256: guidanceSha256,
        dataset_guidance: normalizeDatasetGuidanceState(raw.dataset_guidance)
    });
}

function buildVisionCacheProfile({model, preset, pipelineId = VISION_PIPELINE_ID, guidance = "", datasetGuidance} = {}) {
    const normalizedGuidance = String(guidance || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 600);
    return normalizeVisionCacheProfile({
        requested_model: model,
        prompt_preset: normalizePromptPreset(preset),
        pipeline_id: pipelineId,
        guidance_sha256: sha256Hex(Buffer.from(normalizedGuidance, "utf8")),
        dataset_guidance: datasetGuidance
    });
}

function visionCacheProfileDigest(raw) {
    const profile = normalizeVisionCacheProfile(raw);
    return sha256Hex(Buffer.from(JSON.stringify(profile), "utf8"));
}

function visionRequestCacheKey(imageSha256, {model, preset, guidance = "", datasetGuidance = false, feedbackDigest = "", jobId = "", pipelineId = VISION_PIPELINE_ID, contributionEnabled = false, diagnosticsEnabled = false} = {}) {
    const hash = String(imageSha256 || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Vision request image hash is invalid.");
    const selectedModel = String(model || "").trim();
    if (!selectedModel || selectedModel.length > 200) throw new Error("Vision request model is invalid.");
    const normalizedGuidance = String(guidance || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 600);
    const enabled = datasetGuidance === true;
    const normalizedFeedbackDigest = enabled ? String(feedbackDigest || "").toLowerCase() : "";
    if (enabled && !/^[a-f0-9]{64}$/.test(normalizedFeedbackDigest)) {
        throw new Error("Krea2 dataset guidance requires a valid local-feedback context digest.");
    }
    const nonce = enabled && /^[a-f0-9]{32}$/.test(String(jobId || "")) ? String(jobId) : "";
    if (enabled && !nonce) throw new Error("Krea2 dataset guidance requires a stable request job ID.");
    return createHash("sha256").update([
        hash,
        selectedModel,
        normalizePromptPreset(preset),
        String(pipelineId || ""),
        sha256Hex(Buffer.from(normalizedGuidance, "utf8")),
        enabled ? "1" : "0",
        normalizedFeedbackDigest,
        nonce,
        contributionEnabled === true ? "1" : "0",
        diagnosticsEnabled === true ? "1" : "0"
    ].join("\u0000")).digest("hex");
}

function mergeHereticModelTelemetry(payload) {
    const liveModels = Array.isArray(payload?.models) ? payload.models : [];
    const liveById = new Map(liveModels.map(model => [String(model?.public_id || ""), model]));
    return HERETIC_MODEL_SPECS.map(fallback => {
        const live = liveById.get(fallback.public_id);
        const merged = live && typeof live === "object" ? {...fallback, ...live} : {...fallback};
        merged.model_card_url = fallback.model_card_url;
        merged.model_download_url = fallback.model_download_url;
        merged.projector_download_url = fallback.projector_download_url;
        merged.download_bytes = fallback.download_bytes;
        merged.parameter_size_b = fallback.parameter_size_b;
        merged.short_label = fallback.short_label;
        merged.context_cap = Number.isFinite(Number(live?.context_cap))
            ? Number(live.context_cap)
            : fallback.public_id === "llamacpp::heretic-8b-q8_0" ? 6144 : 8192;
        merged.admission_tolerance_mb = Number.isFinite(Number(live?.admission_tolerance_mb))
            ? Number(live.admission_tolerance_mb)
            : 64;
        merged.telemetry_live = Boolean(live);
        merged.available_vram_mb = Number.isFinite(Number(live?.available_vram_mb)) ? Number(live.available_vram_mb) : null;
        merged.total_vram_mb = Number.isFinite(Number(live?.total_vram_mb)) ? Number(live.total_vram_mb) : null;
        merged.admission_passes_now = live?.admission_passes_now === true;
        return Object.freeze(merged);
    }).sort((left, right) =>
        Number(left.parameter_size_b) - Number(right.parameter_size_b) ||
        Number(left.download_bytes) - Number(right.download_bytes)
    );
}

function formatVramMiB(value) {
    if (value === null || value === undefined || value === "") return "Unavailable";
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? `${Math.trunc(number).toLocaleString()} MiB` : "Unavailable";
}

function formatDownloadGiB(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? `${(number / (1024 ** 3)).toFixed(1)} GiB` : "Size unavailable";
}

const IMAGE_EXTENSION_RE = /\.(?:apng|avif|bmp|gif|jpe?g|jfif|png|tiff?|webp)$/i;
const EXCLUDED_CDN_PATH_RE = /\/(?:avatars?|banners?|emojis?|guild-icons?|icons?|role-icons?|app-icons?|stickers?)\//i;
const EXCLUDED_CONTEXT_RE = /avatar|emoji|sticker|reaction|badge|authoricon|embedauthor|embedprovider|guildicon|roleicon/i;

const CSS = `
.${HOST_CLASS} {
    position: relative !important;
}

.${BUTTON_CLASS},
.${VISION_BUTTON_CLASS} {
    position: absolute;
    z-index: 20;
    top: 6px;
    left: 6px;
    width: 28px;
    height: 28px;
    min-width: 28px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.7);
    border-radius: 8px;
    background: rgba(17, 18, 20, 0.84);
    color: #fff;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.42);
    cursor: pointer;
    font: 700 18px/26px system-ui, sans-serif;
    text-align: center;
    opacity: 0.72;
    transition: opacity 120ms ease, transform 120ms ease, background 120ms ease;
}

.${VISION_BUTTON_CLASS} {
    right: 6px;
    left: auto;
    font-size: 15px;
}

.${HOST_CLASS}:hover > .${BUTTON_CLASS},
.${HOST_CLASS}:hover > .${VISION_BUTTON_CLASS},
.${BUTTON_CLASS}:focus-visible,
.${VISION_BUTTON_CLASS}:focus-visible {
    opacity: 1;
    transform: scale(1.04);
}

.${BUTTON_CLASS}[data-state="downloading"],
.${BUTTON_CLASS}[data-state="hashing"],
.${BUTTON_CLASS}[data-state="saving"],
.${BUTTON_CLASS}[data-state="uploading"],
.${VISION_BUTTON_CLASS}[data-state="downloading"],
.${VISION_BUTTON_CLASS}[data-state="hashing"],
.${VISION_BUTTON_CLASS}[data-state="saving"],
.${VISION_BUTTON_CLASS}[data-state="vision-queued"],
.${VISION_BUTTON_CLASS}[data-state="uploading"],
.${VISION_BUTTON_CLASS}[data-state="vision-requesting"] {
    background: rgba(58, 113, 193, 0.95);
    cursor: wait;
    font-size: 12px;
}

.${BUTTON_CLASS}[data-state="done"],
.${BUTTON_CLASS}[data-state="duplicate"],
.${VISION_BUTTON_CLASS}[data-state="done"] {
    background: rgba(35, 145, 79, 0.95);
    cursor: default;
}

.${BUTTON_CLASS}[data-state="no-metadata"] {
    background: rgba(86, 92, 101, 0.96);
}

.${VISION_BUTTON_CLASS}[data-state="vision-unsupported"] {
    background: rgba(86, 92, 101, 0.96);
}

.${BUTTON_CLASS}[data-state="metadata-no-prompt"],
.${BUTTON_CLASS}[data-state="saved-prompt-only"],
.${VISION_BUTTON_CLASS}[data-state="vision-local-only"],
.${VISION_BUTTON_CLASS}[data-state="vision-not-configured"] {
    background: rgba(190, 133, 28, 0.97);
}

.${BUTTON_CLASS}[data-state="encoded-or-unknown"],
.${BUTTON_CLASS}[data-state="structured"],
.${BUTTON_CLASS}[data-state="non-english"] {
    background: rgba(103, 65, 164, 0.97);
    font-size: 13px;
}

.${BUTTON_CLASS}[data-state="error"],
.${VISION_BUTTON_CLASS}[data-state="error"] {
    background: rgba(190, 48, 48, 0.96);
}

#${HISTORY_ROOT_ID} {
    --krea2-history-width: 330px;
    --krea2-surface: #111318;
    --krea2-surface-raised: #171a21;
    --krea2-surface-hover: #1c2028;
    --krea2-border: #2b303a;
    --krea2-text: #f3f5f7;
    --krea2-muted: #a8b0bd;
    --krea2-subtle: #828c9b;
    box-sizing: border-box;
    width: var(--krea2-history-width);
    min-width: 268px;
    max-width: min(440px, 38vw);
    position: fixed;
    z-index: 100;
    top: 0;
    right: 0;
    bottom: 0;
    height: auto;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    color: var(--krea2-text);
    -webkit-text-fill-color: var(--krea2-text);
    background: var(--krea2-surface);
    border-left: 1px solid var(--krea2-border);
    border-right: 1px solid var(--krea2-border);
    font: 500 12px/1.4 Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

#${HISTORY_ROOT_ID} button,
#${HISTORY_MODAL_ID} button,
#${HISTORY_MODAL_ID} textarea {
    color: inherit;
    -webkit-text-fill-color: currentColor;
}

#${HISTORY_ROOT_ID}[data-floating="true"] {
    position: fixed;
    z-index: 100;
    top: 0;
    right: 0;
    bottom: 0;
    height: auto;
    min-height: 0;
    box-shadow: -14px 0 32px rgba(0, 0, 0, .28);
}

#${HISTORY_ROOT_ID}[data-collapsed="true"] {
    width: 44px;
    min-width: 44px;
    max-width: 44px;
}

#${HISTORY_ROOT_ID}[data-collapsed="true"] .krea2-history-expanded { display: none !important; }
#${HISTORY_ROOT_ID}:not([data-collapsed="true"]) .krea2-history-collapsed { display: none !important; }

.krea2-history-resizer {
    position: absolute;
    z-index: 2;
    left: -3px;
    top: 0;
    bottom: 0;
    width: 7px;
    cursor: ew-resize;
}

.krea2-history-header {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 62px;
    padding: 0 12px 0 16px;
    border-bottom: 1px solid var(--krea2-border);
}

.krea2-history-heading { min-width: 0; flex: 1; }
.krea2-history-title { color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); font-size: 15px; font-weight: 700; letter-spacing: -.012em; }
.krea2-history-subtitle { margin-top: 2px; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.krea2-history-actions { display: flex; gap: 4px; }

.krea2-history-icon,
.krea2-history-collapse-launcher {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 0;
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--krea2-muted);
    -webkit-text-fill-color: var(--krea2-muted);
    background: transparent;
    cursor: pointer;
    font: 700 15px/1 system-ui, sans-serif;
}
.krea2-history-icon:hover,
.krea2-history-collapse-launcher:hover { color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); border-color: var(--krea2-border); background: var(--krea2-surface-raised); }
.krea2-history-collapse-launcher { margin: 10px auto; writing-mode: vertical-rl; height: auto; min-height: 118px; justify-content: start; gap: 9px; color: var(--krea2-muted); font-size: 10px; letter-spacing: .08em; }

.krea2-history-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
    padding: 10px 12px 6px;
}
.krea2-history-average-queue {
    margin: 0 12px;
    padding: 5px 4px 9px;
    border-bottom: 1px solid var(--krea2-border);
    color: var(--krea2-muted);
    -webkit-text-fill-color: var(--krea2-muted);
    font-size: 9.5px;
    font-weight: 650;
    line-height: 1.35;
    text-align: center;
}
.krea2-history-stat { min-width: 0; padding: 8px 3px; border: 1px solid var(--krea2-border); border-radius: 8px; text-align: center; background: var(--krea2-surface-raised); }
.krea2-history-stat strong { display: block; color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); font-size: 14px; font-weight: 700; }
.krea2-history-stat span { color: var(--krea2-subtle); -webkit-text-fill-color: var(--krea2-subtle); font-size: 8px; font-weight: 650; text-transform: uppercase; letter-spacing: .055em; }

.krea2-history-scheduler { margin: 10px 12px; padding: 9px 10px; border: 1px solid var(--krea2-border); border-radius: 8px; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); background: var(--krea2-surface-raised); font-size: 9.5px; line-height: 1.45; }
.krea2-history-scheduler strong { color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); font-weight: 650; }

.krea2-history-tabs { display: flex; gap: 3px; margin: 0 12px 10px; padding: 3px; border: 1px solid var(--krea2-border); border-radius: 9px; background: #0d0f13; }
.krea2-history-tab { flex: 1; min-width: 0; padding: 7px 3px; border: 0; border-radius: 6px; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); background: transparent; cursor: pointer; font: 650 9.5px/1 system-ui, sans-serif; }
.krea2-history-tab:hover { color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); background: var(--krea2-surface-hover); }
.krea2-history-tab[aria-selected="true"] { color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); background: #2a303a; box-shadow: 0 1px 2px rgba(0,0,0,.3); }

.krea2-history-list { flex: 1; min-height: 0; overflow: auto; padding: 0 10px 12px; scrollbar-width: thin; scrollbar-color: #3a414d transparent; }
.krea2-history-pagination { display: flex; align-items: center; gap: 6px; padding: 8px 12px 12px; border-top: 1px solid var(--krea2-border); }
.krea2-history-pagination[hidden] { display: none !important; }
.krea2-history-page-label { min-width: 0; flex: 1; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); font-size: 9px; text-align: center; }
.krea2-history-page-button { min-width: 28px; height: 28px; padding: 0 8px; border: 1px solid var(--krea2-border); border-radius: 7px; color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); background: var(--krea2-surface-raised); cursor: pointer; font: 700 10px/1 system-ui,sans-serif; }
.krea2-history-page-button:hover:not(:disabled) { border-color: #6670dd; background: var(--krea2-surface-hover); }
.krea2-history-page-button:disabled { opacity: .4; cursor: default; }
.krea2-history-page-clear { color: #ffb4ba; -webkit-text-fill-color: #ffb4ba; }
.krea2-history-empty { padding: 32px 18px; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); text-align: center; font-size: 11px; }
.krea2-interrogate-panel { flex: 1; min-height: 0; overflow: auto; padding: 0 12px 14px; scrollbar-width: thin; scrollbar-color: #3a414d transparent; }
.krea2-interrogate-card { display: grid; gap: 11px; padding: 13px; border: 1px solid var(--krea2-border); border-radius: 11px; background: var(--krea2-surface-raised); }
.krea2-interrogate-title { color: var(--krea2-text); font-size: 14px; font-weight: 750; letter-spacing: -.01em; }
.krea2-interrogate-copy { margin-top: -5px; color: var(--krea2-muted); font-size: 10px; line-height: 1.5; }
.krea2-interrogate-drop { display: grid; place-items: center; min-height: 142px; padding: 12px; overflow: hidden; border: 1px dashed #485161; border-radius: 10px; color: var(--krea2-muted); background: #101216; text-align: center; cursor: pointer; }
.krea2-interrogate-drop:hover,
.krea2-interrogate-drop[data-dragging="true"] { border-color: #7c87ff; background: #151928; }
.krea2-interrogate-preview { display: block; width: 100%; max-height: 220px; object-fit: contain; border-radius: 7px; }
.krea2-interrogate-drop-copy strong { display: block; margin-bottom: 4px; color: var(--krea2-text); font-size: 11px; }
.krea2-interrogate-drop-copy span { display: block; color: var(--krea2-subtle); font-size: 9px; }
.krea2-interrogate-file { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 8px 9px; border: 1px solid var(--krea2-border); border-radius: 8px; background: #12151a; }
.krea2-interrogate-file span { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--krea2-muted); font-size: 9.5px; }
.krea2-interrogate-file button { flex: none; width: 24px; height: 24px; padding: 0; border: 1px solid var(--krea2-border); border-radius: 6px; background: #1d2129; cursor: pointer; }
.krea2-interrogate-field { display: grid; gap: 6px; }
.krea2-interrogate-field label { color: var(--krea2-subtle); font-size: 8.5px; font-weight: 750; letter-spacing: .065em; text-transform: uppercase; }
.krea2-interrogate-model { box-sizing: border-box; width: 100%; min-height: 38px; padding: 7px 9px; border: 1px solid var(--krea2-border); border-radius: 8px; color: var(--krea2-text); background: #101216; font: 600 10px/1.3 system-ui, sans-serif; }
.krea2-interrogate-note { box-sizing: border-box; width: 100%; min-height: 72px; resize: vertical; padding: 9px; border: 1px solid var(--krea2-border); border-radius: 8px; color: var(--krea2-text); background: #101216; font: 500 10px/1.45 system-ui, sans-serif; }
.krea2-interrogate-note::placeholder { color: var(--krea2-subtle); }
.krea2-interrogate-note-help { color: var(--krea2-subtle); font-size: 8.5px; line-height: 1.45; }
.krea2-interrogate-actions { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.krea2-interrogate-start,
.krea2-interrogate-refresh { min-height: 38px; padding: 8px 12px; border: 1px solid #626de5; border-radius: 8px; color: #fff; background: #5865f2; cursor: pointer; font: 750 10.5px/1 system-ui, sans-serif; }
.krea2-interrogate-refresh { width: 38px; padding: 0; border-color: var(--krea2-border); color: var(--krea2-muted); background: #1b1f27; font-size: 15px; }
.krea2-interrogate-start:hover:not(:disabled) { background: #6571f5; }
.krea2-interrogate-refresh:hover:not(:disabled) { color: var(--krea2-text); background: #242933; }
.krea2-interrogate-start:disabled,
.krea2-interrogate-refresh:disabled { cursor: not-allowed; opacity: .48; }
.krea2-interrogate-status { padding: 9px 10px; border: 1px solid var(--krea2-border); border-radius: 8px; color: var(--krea2-muted); background: #11141a; font-size: 9.5px; line-height: 1.45; }
.krea2-interrogate-status[data-state="error"] { border-color: #663238; color: #ffb4b8; background: #2b181c; }
.krea2-interrogate-status[data-state="success"] { border-color: #315c47; color: #b8f2cf; background: #14261d; }
.krea2-interrogate-queue { color: var(--krea2-subtle); font-size: 9px; text-align: center; }
.krea2-history-job { display: block; width: 100%; margin-bottom: 8px; padding: 11px; border: 1px solid var(--krea2-border); border-radius: 10px; color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); background: var(--krea2-surface-raised); text-align: left; cursor: pointer; transition: border-color .15s ease, background .15s ease, transform .15s ease; }
.krea2-history-job:hover { border-color: #3a424f; background: var(--krea2-surface-hover); transform: translateY(-1px); }
.krea2-history-job:focus-visible { outline: 2px solid #6d7cff; outline-offset: 1px; }
.krea2-history-job-top { display: flex; align-items: center; gap: 7px; }
.krea2-history-job-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); font-size: 12px; font-weight: 650; }
.krea2-history-badge { flex: none; padding: 3px 7px; border-radius: 999px; color: #d6dbe3; -webkit-text-fill-color: #d6dbe3; background: #2a3039; font-size: 8px; font-weight: 750; letter-spacing: .03em; text-transform: uppercase; }
.krea2-history-badge[data-status="completed"] { color: #9fe6b8; -webkit-text-fill-color: #9fe6b8; background: #173324; }
.krea2-history-badge[data-status="queued"], .krea2-history-badge[data-status="running"] { color: #b8c2ff; -webkit-text-fill-color: #b8c2ff; background: #242c50; }
.krea2-history-badge[data-status="rejected"], .krea2-history-badge[data-status="error"] { color: #ffb4b8; -webkit-text-fill-color: #ffb4b8; background: #412327; }
.krea2-history-job-meta { display: flex; gap: 8px; margin-top: 6px; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); font-size: 9px; }
.krea2-history-job-meta span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.krea2-history-job-preview { margin-top: 7px; display: -webkit-box; overflow: hidden; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); font-size: 9.5px; line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }

#${HISTORY_MODAL_ID} { --krea2-text: #f3f5f7; --krea2-muted: #a8b0bd; position: fixed; z-index: 10000; inset: 0; display: grid; place-items: center; padding: 24px; color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); background: rgba(5, 7, 10, .78); backdrop-filter: blur(4px); }
.krea2-history-dialog { width: min(760px, 92vw); max-height: min(760px, 88vh); display: flex; flex-direction: column; overflow: hidden; border: 1px solid #343a45; border-radius: 14px; color: var(--krea2-text); background: #17191f; box-shadow: 0 28px 90px rgba(0,0,0,.62); }
.krea2-history-dialog-head { display: flex; align-items: center; gap: 12px; padding: 17px 20px; border-bottom: 1px solid #2c313a; }
.krea2-history-dialog-head h2 { min-width: 0; flex: 1; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); font-size: 16px; font-weight: 700; letter-spacing: -.01em; }
.krea2-history-dialog-body { overflow: auto; padding: 20px; }
.krea2-history-detail-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 16px; }
.krea2-history-detail { min-width: 0; padding: 10px 11px; border: 1px solid #2c313a; border-radius: 9px; background: #1d2027; }
.krea2-history-detail span { display: block; margin-bottom: 4px; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); font-size: 8.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .06em; }
.krea2-history-detail strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); font-size: 11px; font-weight: 600; }
.krea2-history-model-proof { margin: 0 0 16px; padding: 13px 15px; border: 1px solid #3b465c; border-radius: 10px; background: #1a2130; }
.krea2-history-model-proof[data-confirmed="true"] { border-color: #315c47; background: #14261d; }
.krea2-history-model-proof-label { margin-bottom: 5px; color: #9ca8bb; -webkit-text-fill-color: #9ca8bb; font-size: 8.5px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.krea2-history-model-proof strong { display: block; color: #f5f7fa; -webkit-text-fill-color: #f5f7fa; font-size: 13px; line-height: 1.4; }
.krea2-history-model-proof-id { margin-top: 5px; color: #bec7d4; -webkit-text-fill-color: #bec7d4; font: 600 10px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
.krea2-history-model-proof-note { margin-top: 6px; color: #9ca8bb; -webkit-text-fill-color: #9ca8bb; font-size: 9px; line-height: 1.4; }
.krea2-history-result { display: grid; grid-template-columns: 176px minmax(0, 1fr); align-items: start; gap: 14px; }
.krea2-history-source { min-width: 0; }
.krea2-history-source-frame { display: grid; place-items: center; width: 100%; aspect-ratio: 1 / 1; overflow: hidden; border: 1px solid #343a45; border-radius: 10px; background: #101216; }
.krea2-history-source-image { display: block; width: 100%; height: 100%; object-fit: cover; }
.krea2-history-source-missing { padding: 14px; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); font-size: 10px; line-height: 1.45; text-align: center; }
.krea2-history-output { min-width: 0; }
.krea2-history-prompt-label { margin-bottom: 8px; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; }
.krea2-history-prompt { box-sizing: border-box; width: 100%; min-height: 230px; max-height: 46vh; resize: vertical; padding: 14px; border: 1px solid #343a45; border-radius: 10px; color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); caret-color: #fff; background: #101216; font: 500 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; }
.krea2-prompt-feedback { display: grid; gap: 7px; margin: 10px 0; padding: 10px; border: 1px solid #303642; border-radius: 10px; background: #15181e; }
.krea2-prompt-feedback-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
.krea2-prompt-feedback-button { min-height: 34px; padding: 7px 11px; border: 1px solid #3a414e; border-radius: 8px; color: var(--krea2-text); background: #1e222a; cursor: pointer; font-weight: 700; }
.krea2-prompt-feedback-button:hover { border-color: #697386; background: #252a34; }
.krea2-prompt-feedback-button[data-active="true"] { border-color: #7c87ff; background: rgba(88,101,242,.24); box-shadow: inset 0 0 0 1px rgba(124,135,255,.25); }
.krea2-prompt-feedback-status { color: var(--krea2-muted); font-size: 11px; line-height: 1.45; }
.krea2-feedback-overlay { position: fixed; inset: 0; z-index: 1000003; display: grid; place-items: center; padding: 24px; background: rgba(5,7,10,.78); backdrop-filter: blur(5px); }
.krea2-feedback-dialog { box-sizing: border-box; width: min(520px, 100%); padding: 22px; border: 1px solid #353c48; border-radius: 14px; color: var(--krea2-text); background: #171a20; box-shadow: 0 24px 80px rgba(0,0,0,.55); }
.krea2-feedback-dialog h3 { margin: 0 0 8px; font-size: 18px; }
.krea2-feedback-dialog p { margin: 0 0 14px; color: var(--krea2-muted); line-height: 1.5; }
.krea2-feedback-reason { box-sizing: border-box; width: 100%; min-height: 125px; resize: vertical; padding: 12px; border: 1px solid #3b4350; border-radius: 9px; color: var(--krea2-text); background: #0f1115; font: inherit; }
.krea2-feedback-reason[aria-invalid="true"] { border-color: #f06a76; }
.krea2-feedback-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.krea2-history-error { padding: 13px; border: 1px solid #563038; border-radius: 9px; color: #ffb4b8; -webkit-text-fill-color: #ffb4b8; background: #29181c; }
.krea2-history-stage { padding: 13px; border: 1px solid #354056; border-radius: 9px; color: #cbd4e4; -webkit-text-fill-color: #cbd4e4; background: #1b2230; }
.krea2-history-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 13px 20px; border-top: 1px solid #2c313a; }
.krea2-history-action { padding: 9px 13px; border: 1px solid #343a45; border-radius: 8px; color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); background: #232730; cursor: pointer; font: 650 11px/1 system-ui, sans-serif; }
.krea2-history-action:hover { border-color: #48515f; background: #2b303a; }
.krea2-history-action[data-primary="true"] { border-color: #6574e8; color: #fff; -webkit-text-fill-color: #fff; background: #5865d8; }
.krea2-history-action:disabled { opacity: .45; cursor: not-allowed; }

.krea2-history-library-tools { display: grid; grid-template-columns: minmax(0, 1fr) 104px; gap: 6px; margin: 0 12px 10px; }
.krea2-history-search,
.krea2-history-model-filter,
.krea2-workshop-select { box-sizing: border-box; min-width: 0; width: 100%; padding: 8px 9px; border: 1px solid var(--krea2-border, #343a45); border-radius: 8px; color: var(--krea2-text, #f3f5f7); -webkit-text-fill-color: var(--krea2-text, #f3f5f7); background: #0d0f13; font: 550 10px/1.2 system-ui, sans-serif; }
.krea2-history-utility-row { display: flex; gap: 6px; margin: 0 12px 10px; }
.krea2-history-utility { min-width: 0; flex: 1; padding: 7px 8px; border: 1px solid var(--krea2-border); border-radius: 8px; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); background: var(--krea2-surface-raised); cursor: pointer; font: 650 9.5px/1 system-ui, sans-serif; }
.krea2-history-utility:hover,
.krea2-history-utility[data-active="true"] { color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); border-color: #4d5870; background: #252b36; }
.krea2-history-completion { display: block; margin: 0 12px 10px; padding: 9px 10px; border: 1px solid #315c47; border-radius: 8px; color: #b8f2cf; -webkit-text-fill-color: #b8f2cf; background: #14261d; cursor: pointer; font: 600 10px/1.35 system-ui, sans-serif; text-align: left; }
.krea2-history-job { position: relative; }
.krea2-history-job-layout { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 9px; align-items: start; }
.krea2-history-job-thumb { width: 42px; height: 42px; border: 1px solid var(--krea2-border); border-radius: 8px; object-fit: cover; background: #0d0f13; }
.krea2-history-job-thumb-missing { display: grid; place-items: center; color: var(--krea2-subtle); font-size: 16px; }
.krea2-history-job-controls { display: flex; gap: 4px; margin-top: 8px; }
.krea2-history-mini { width: 27px; height: 25px; padding: 0; border: 1px solid var(--krea2-border); border-radius: 7px; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); background: #111318; cursor: pointer; font: 650 12px/1 system-ui, sans-serif; }
.krea2-history-mini[data-active="true"] { color: #ffd66b; -webkit-text-fill-color: #ffd66b; border-color: #665625; background: #2a2515; }

.krea2-history-dialog[data-product="true"] { width: min(1120px, 95vw); max-height: 92vh; }
.krea2-product-tabs { display: flex; gap: 4px; padding: 0 20px; border-bottom: 1px solid #2c313a; background: #12151a; overflow-x: auto; }
.krea2-product-tab { padding: 12px 10px 10px; border: 0; border-bottom: 2px solid transparent; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); background: transparent; cursor: pointer; font: 650 10px/1 system-ui, sans-serif; white-space: nowrap; }
.krea2-product-tab[aria-selected="true"] { color: #fff; -webkit-text-fill-color: #fff; border-bottom-color: #7d8cff; }
.krea2-product-panel { display: none; }
.krea2-product-panel[data-active="true"] { display: block; }
.krea2-workshop-grid { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 16px; }
.krea2-workshop-image { width: 100%; max-height: 360px; border: 1px solid #343a45; border-radius: 11px; object-fit: contain; background: #0d0f13; }
.krea2-workshop-toolbar { display: flex; flex-wrap: wrap; gap: 7px; margin: 8px 0; }
.krea2-workshop-prompt { box-sizing: border-box; width: 100%; min-height: 300px; resize: vertical; padding: 14px; border: 1px solid #343a45; border-radius: 10px; color: #f3f5f7; -webkit-text-fill-color: #f3f5f7; caret-color: #fff; background: #101216; font: 500 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; }
.krea2-workshop-note { margin-top: 8px; color: #a8b0bd; -webkit-text-fill-color: #a8b0bd; font-size: 10px; line-height: 1.45; }
.krea2-compare-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.krea2-compare-card { min-width: 0; padding: 12px; border: 1px solid #343a45; border-radius: 10px; background: #1d2027; }
.krea2-compare-card h3 { margin: 0 0 8px; color: #f3f5f7; -webkit-text-fill-color: #f3f5f7; font-size: 11px; }
.krea2-compare-meta { margin-bottom: 8px; color: #a8b0bd; -webkit-text-fill-color: #a8b0bd; font-size: 9px; }
.krea2-compare-text { max-height: 240px; overflow: auto; color: #dfe3e9; -webkit-text-fill-color: #dfe3e9; font: 500 10px/1.5 system-ui, sans-serif; white-space: pre-wrap; }
.krea2-region-stage { position: relative; display: inline-block; max-width: 100%; margin: 10px 0; cursor: crosshair; }
.krea2-region-canvas { display: block; max-width: 100%; max-height: 460px; border: 1px solid #343a45; border-radius: 10px; background: #0d0f13; }
.krea2-region-note { color: #a8b0bd; -webkit-text-fill-color: #a8b0bd; font-size: 10px; }
.krea2-meta-grid,
.krea2-health-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.krea2-info-card { padding: 11px; border: 1px solid #343a45; border-radius: 9px; color: #dfe3e9; -webkit-text-fill-color: #dfe3e9; background: #1d2027; font-size: 10px; line-height: 1.5; }
.krea2-info-card strong { display: block; margin-bottom: 3px; color: #fff; -webkit-text-fill-color: #fff; }
.krea2-batch-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px 0; border-bottom: 1px solid #2c313a; }
.krea2-batch-actions { display: flex; gap: 5px; }
.krea2-similar-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 9px; margin-top: 12px; }
.krea2-similar-card { padding: 8px; border: 1px solid #343a45; border-radius: 9px; color: #dfe3e9; -webkit-text-fill-color: #dfe3e9; background: #1d2027; cursor: pointer; text-align: left; font: 600 10px/1.4 system-ui, sans-serif; }
.krea2-review-form { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
.krea2-review-form label { display: grid; gap: 5px; color: #a8b0bd; -webkit-text-fill-color: #a8b0bd; font-size: 10px; font-weight: 700; }
.krea2-review-form input, .krea2-review-form select, .krea2-review-form textarea, .krea2-score-select { box-sizing: border-box; width: 100%; padding: 9px; border: 1px solid #343a45; border-radius: 8px; color: #f3f5f7; -webkit-text-fill-color: #f3f5f7; background: #101216; font: 600 11px/1.35 system-ui, sans-serif; }
.krea2-review-form textarea { min-height: 100px; resize: vertical; }
.krea2-review-form .krea2-review-wide { grid-column: 1 / -1; }
.krea2-review-tag { display: inline-flex; margin-top: 6px; padding: 3px 6px; border: 1px solid #3a4250; border-radius: 999px; color: #b8c2d0; -webkit-text-fill-color: #b8c2d0; font-size: 8px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
.krea2-score-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; margin-top: 10px; }
.krea2-score-grid label { color: #a8b0bd; -webkit-text-fill-color: #a8b0bd; font-size: 9px; }
.krea2-repro-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.krea2-privacy-receipt { padding: 14px; border: 1px solid #394563; border-radius: 10px; color: #dfe5f3; -webkit-text-fill-color: #dfe5f3; background: #192131; font-size: 11px; line-height: 1.55; }

#${ONBOARDING_MODAL_ID} { position: fixed; inset: 0; z-index: 100000; display: grid; place-items: center; padding: 24px; color: #f5f7fa; -webkit-text-fill-color: #f5f7fa; background: rgba(5, 7, 10, .78); backdrop-filter: blur(8px); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
.krea2-onboarding-dialog { box-sizing: border-box; width: min(980px, 100%); max-height: min(860px, calc(100vh - 48px)); overflow: auto; border: 1px solid #343a45; border-radius: 18px; background: #15181e; box-shadow: 0 28px 90px rgba(0,0,0,.55); }
.krea2-onboarding-head { display: flex; justify-content: space-between; gap: 24px; padding: 24px 26px 18px; border-bottom: 1px solid #2b3039; }
.krea2-onboarding-eyebrow { margin-bottom: 6px; color: #8ea1ff; -webkit-text-fill-color: #8ea1ff; font-size: 11px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.krea2-onboarding-head h2 { margin: 0; color: #fff; -webkit-text-fill-color: #fff; font-size: 25px; line-height: 1.2; }
.krea2-onboarding-head p { max-width: 720px; margin: 8px 0 0; color: #aeb6c3; -webkit-text-fill-color: #aeb6c3; font-size: 13px; line-height: 1.55; }
.krea2-onboarding-close { align-self: flex-start; width: 34px; height: 34px; border: 1px solid #363c46; border-radius: 9px; color: #e8ebef; -webkit-text-fill-color: #e8ebef; background: #20242c; cursor: pointer; font-size: 17px; }
.krea2-onboarding-body { padding: 20px 26px 24px; }
.krea2-onboarding-note { margin-bottom: 16px; padding: 13px 15px; border: 1px solid #4a426f; border-radius: 11px; color: #dfe2ff; -webkit-text-fill-color: #dfe2ff; background: #211e32; font-size: 12px; line-height: 1.55; }
.krea2-onboarding-note strong { color: #fff; -webkit-text-fill-color: #fff; }
.krea2-onboarding-server { display: flex; align-items: flex-start; gap: 10px; margin: 0 0 16px; padding: 12px 14px; border: 1px solid #343a45; border-radius: 10px; color: #dce1e8; -webkit-text-fill-color: #dce1e8; background: #1a1e25; font-size: 12px; line-height: 1.45; }
.krea2-onboarding-server input { width: 17px; height: 17px; margin-top: 1px; accent-color: #5865f2; }
.krea2-onboarding-server span { display: block; color: #99a3b1; -webkit-text-fill-color: #99a3b1; margin-top: 2px; }
.krea2-onboarding-execution { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin: 0 0 14px; }
.krea2-onboarding-mode { padding: 13px 14px; border: 1px solid #343a45; border-radius: 10px; color: #c4cbd5; -webkit-text-fill-color: #c4cbd5; background: #1a1e25; cursor: pointer; font: 750 12px/1.35 system-ui, sans-serif; text-align: left; }
.krea2-onboarding-mode strong { display: block; margin-bottom: 3px; color: #fff; -webkit-text-fill-color: #fff; font-size: 13px; }
.krea2-onboarding-mode[data-selected="true"] { border-color: #7289ff; background: #20253a; box-shadow: 0 0 0 1px rgba(114,137,255,.2); }
.krea2-onboarding-online { display: none; margin-bottom: 14px; padding: 13px 15px; border: 1px solid #3f4b70; border-radius: 10px; color: #cfd6ee; -webkit-text-fill-color: #cfd6ee; background: #1b2234; font-size: 12px; line-height: 1.5; }
.krea2-onboarding-online[data-visible="true"] { display: block; }
.krea2-onboarding-online strong { color: #fff; -webkit-text-fill-color: #fff; }
.krea2-onboarding-vram[data-disabled="true"], .krea2-onboarding-grid[data-disabled="true"] { opacity: .42; filter: grayscale(.35); }
.krea2-onboarding-grid[data-disabled="true"] .krea2-onboarding-card { cursor: not-allowed; pointer-events: none; transform: none; }
.krea2-onboarding-vram { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; margin-bottom: 14px; color: #aeb6c3; -webkit-text-fill-color: #aeb6c3; font-size: 12px; }
.krea2-onboarding-vram strong { color: #f5f7fa; -webkit-text-fill-color: #f5f7fa; }
.krea2-onboarding-refresh { border: 0; padding: 7px 10px; border-radius: 7px; color: #dfe4ff; -webkit-text-fill-color: #dfe4ff; background: #2b3152; cursor: pointer; font: 700 11px/1 system-ui, sans-serif; }
.krea2-onboarding-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.krea2-onboarding-card { position: relative; display: flex; min-width: 0; flex-direction: column; gap: 11px; padding: 16px; border: 1px solid #343a45; border-radius: 13px; background: #1c2027; cursor: pointer; transition: border-color 120ms ease, transform 120ms ease, background 120ms ease; }
.krea2-onboarding-card:hover { transform: translateY(-1px); border-color: #596273; }
.krea2-onboarding-card[data-selected="true"] { border-color: #7289ff; background: #20253a; box-shadow: 0 0 0 1px rgba(114,137,255,.22); }
.krea2-onboarding-card input { position: absolute; top: 16px; right: 16px; width: 17px; height: 17px; accent-color: #7289ff; }
.krea2-onboarding-card h3 { margin: 0; padding-right: 26px; color: #fff; -webkit-text-fill-color: #fff; font-size: 15px; }
.krea2-onboarding-modelmeta { color: #98a2b1; -webkit-text-fill-color: #98a2b1; font-size: 10px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
.krea2-onboarding-install { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #aeb6c3; -webkit-text-fill-color: #aeb6c3; font-size: 10px; font-weight: 700; }
.krea2-onboarding-install strong { color: #a9efc2; -webkit-text-fill-color: #a9efc2; }
.krea2-onboarding-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.krea2-onboarding-metric { padding: 9px; border: 1px solid #303641; border-radius: 8px; background: #171a20; }
.krea2-onboarding-metric span { display: block; margin-bottom: 2px; color: #929cab; -webkit-text-fill-color: #929cab; font-size: 9px; font-weight: 750; letter-spacing: .05em; text-transform: uppercase; }
.krea2-onboarding-metric strong { color: #f2f4f8; -webkit-text-fill-color: #f2f4f8; font-size: 11px; }
.krea2-onboarding-admission { padding: 9px 10px; border-radius: 8px; font-size: 11px; font-weight: 720; line-height: 1.4; }
.krea2-onboarding-admission[data-pass="true"] { color: #a9efc2; -webkit-text-fill-color: #a9efc2; background: #173226; }
.krea2-onboarding-admission[data-pass="false"] { color: #ffd2a2; -webkit-text-fill-color: #ffd2a2; background: #352719; }
.krea2-onboarding-target-warning { color: #ffb7bf; -webkit-text-fill-color: #ffb7bf; font-size: 10px; font-weight: 700; line-height: 1.4; }
.krea2-onboarding-downloads { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.krea2-onboarding-download { display: flex; min-height: 34px; align-items: center; justify-content: center; padding: 7px 9px; border: 1px solid #46506a; border-radius: 8px; color: #e8ebff; -webkit-text-fill-color: #e8ebff; background: #272e46; font-size: 10px; font-weight: 800; line-height: 1.25; text-align: center; text-decoration: none; }
.krea2-onboarding-download:hover { border-color: #7688ff; background: #30395b; }
.krea2-onboarding-link { align-self: flex-start; margin-top: auto; color: #aebaff; -webkit-text-fill-color: #aebaff; font-size: 11px; font-weight: 750; text-decoration: none; }
.krea2-onboarding-link:hover { text-decoration: underline; }
.krea2-onboarding-status { min-height: 18px; margin-top: 14px; color: #aeb6c3; -webkit-text-fill-color: #aeb6c3; font-size: 11px; }
.krea2-onboarding-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 18px; }
.krea2-onboarding-action { padding: 10px 14px; border: 1px solid #363c46; border-radius: 9px; color: #e7eaf0; -webkit-text-fill-color: #e7eaf0; background: #22262e; cursor: pointer; font: 750 12px/1 system-ui, sans-serif; }
.krea2-onboarding-action[data-primary="true"] { border-color: #7289ff; color: #fff; -webkit-text-fill-color: #fff; background: #5865f2; }

@media (max-width: 1120px) {
    #${HISTORY_ROOT_ID}:not([data-collapsed="true"]) { --krea2-history-width: 292px !important; min-width: 268px; }
}
@media (max-width: 920px) {
    #${HISTORY_ROOT_ID} { width: 44px !important; min-width: 44px !important; max-width: 44px !important; }
    #${HISTORY_ROOT_ID} .krea2-history-expanded { display: none !important; }
    #${HISTORY_ROOT_ID} .krea2-history-collapsed { display: flex !important; }
    .krea2-history-detail-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .krea2-history-result { grid-template-columns: 132px minmax(0, 1fr); }
    .krea2-onboarding-grid { grid-template-columns: 1fr; }
}
@media (max-width: 620px) {
    .krea2-onboarding-execution { grid-template-columns: 1fr; }
    .krea2-history-result { grid-template-columns: 1fr; }
    .krea2-history-source-frame { max-width: 220px; }
    .krea2-workshop-grid,
    .krea2-compare-grid,
    .krea2-meta-grid,
    .krea2-health-grid { grid-template-columns: 1fr; }
    .krea2-review-form, .krea2-score-grid, .krea2-repro-grid { grid-template-columns: 1fr; }
}
`;

function parseDiscordRoute(pathname) {
    const match = String(pathname || "").match(/^\/channels\/([^/]+)\/([^/]+)/);
    if (!match) return {guildId: null, channelId: null};
    return {guildId: match[1], channelId: match[2]};
}

function parseGuildAllowlist(raw) {
    return new Set(
        String(raw || "")
            .split(/[\s,]+/)
            .map(value => value.trim())
            .filter(value => /^\d{5,25}$/.test(value))
    );
}

function invalidGuildAllowlistEntries(raw) {
    return String(raw || "")
        .split(/[\s,]+/)
        .map(value => value.trim())
        .filter(Boolean)
        .filter(value => !/^\d{5,25}$/.test(value));
}

function isGuildAllowed(guildId, rawAllowlist) {
    if (!guildId || guildId === "@me") return false;
    return parseGuildAllowlist(rawAllowlist).has(String(guildId));
}

function validateEndpoint(raw) {
    let parsed;
    try {
        parsed = new URL(String(raw || "").trim());
    }
    catch {
        return {ok: false, error: "Candidate endpoint is not a valid URL."};
    }

    const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    const isHttps = parsed.protocol === "https:";
    const isLoopbackHttp = parsed.protocol === "http:" && loopbackHosts.has(parsed.hostname);
    if (!isHttps && !isLoopbackHttp) {
        return {ok: false, error: "Use HTTPS, or HTTP only for a loopback endpoint."};
    }

    if (parsed.username || parsed.password) {
        return {ok: false, error: "Put the scoped token in the token setting, not in the URL."};
    }

    parsed.hash = "";
    return {ok: true, url: parsed.toString()};
}

function validateVisionLoopbackEndpoint(raw) {
    const source = String(raw || "").trim();
    let parsed;
    try {
        parsed = new URL(source);
    }
    catch {
        return {ok: false, error: "Vision Prompt Studio endpoint is not a valid URL."};
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return {ok: false, error: "Vision Prompt Studio must use HTTP or HTTPS on loopback."};
    }
    const authority = source.match(/^https?:\/\/([^/?#]+)/i)?.[1] || "";
    if (!/^(?:127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(authority)) {
        return {ok: false, error: "Vision Prompt Studio requires the literal host 127.0.0.1 or [::1]."};
    }
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") {
        return {ok: false, error: "Vision Prompt Studio is loopback-only; use 127.0.0.1 or [::1]."};
    }
    if (parsed.username || parsed.password) {
        return {ok: false, error: "Put a Vision token in its token setting, not in the URL."};
    }
    if (parsed.pathname !== "/api/discord-describe" || parsed.search || parsed.hash) {
        return {ok: false, error: "Vision Prompt Studio endpoint must be the exact /api/discord-describe route without a query or fragment."};
    }

    return {ok: true, url: parsed.toString(), origin: parsed.origin};
}

function isExcludedAssetUrl(raw) {
    try {
        return EXCLUDED_CDN_PATH_RE.test(new URL(String(raw)).pathname);
    }
    catch {
        return true;
    }
}

function normalizeMediaUrl(raw) {
    let parsed;
    try {
        parsed = new URL(String(raw || ""));
    }
    catch {
        return null;
    }

    if (parsed.protocol !== "https:") return null;
    if (parsed.hostname !== "cdn.discordapp.com" && parsed.hostname !== "media.discordapp.net") return null;
    if (isExcludedAssetUrl(parsed.toString())) return null;

    parsed.hash = "";
    const isDiscordAttachment = /^\/(?:ephemeral-)?attachments\/\d+\/\d+\/[^/]+$/.test(parsed.pathname);
    if (!isDiscordAttachment) return null;
    if (isDiscordAttachment && parsed.hostname === "media.discordapp.net") {
        parsed.hostname = "cdn.discordapp.com";
    }

    if (isDiscordAttachment) {
        parsed.searchParams.delete("");
        for (const key of ["width", "height", "quality", "format"]) parsed.searchParams.delete(key);
    }

    return parsed.toString();
}

function mediaCandidateScore(raw) {
    let parsed;
    try {
        parsed = new URL(String(raw || ""));
    }
    catch {
        return -1;
    }

    if (parsed.protocol !== "https:" || isExcludedAssetUrl(parsed.toString())) return -1;
    if (parsed.hostname !== "cdn.discordapp.com" && parsed.hostname !== "media.discordapp.net") return -1;
    if (/^\/(?:ephemeral-)?attachments\//.test(parsed.pathname)) return 100;
    return -1;
}

function chooseBestMediaUrl(candidates) {
    let best = null;
    let bestScore = -1;

    for (const candidate of candidates || []) {
        const raw = typeof candidate === "string" ? candidate : candidate?.url;
        const source = typeof candidate === "string" ? "image" : candidate?.source;
        const normalized = normalizeMediaUrl(raw);
        if (!normalized) continue;

        let score = mediaCandidateScore(normalized);
        if (score < 0) continue;
        if (source === "anchor" && IMAGE_EXTENSION_RE.test(new URL(normalized).pathname)) score += 5;

        if (score > bestScore) {
            best = normalized;
            bestScore = score;
        }
    }

    return best;
}

function recoverOriginalImageUrl(image) {
    if (!image) return null;

    const candidates = [];
    const anchor = image.closest?.("a[href]");
    if (anchor?.href) candidates.push({url: anchor.href, source: "anchor"});
    if (anchor?.dataset?.href) candidates.push({url: anchor.dataset.href, source: "anchor"});
    if (image.dataset?.original) candidates.push({url: image.dataset.original, source: "data"});
    if (image.dataset?.url) candidates.push({url: image.dataset.url, source: "data"});
    if (image.currentSrc) candidates.push({url: image.currentSrc, source: "image"});
    if (image.src) candidates.push({url: image.src, source: "image"});

    const picture = image.closest?.("picture");
    if (picture) {
        for (const source of picture.querySelectorAll("source[srcset]")) {
            const first = String(source.srcset).split(",", 1)[0].trim().split(/\s+/, 1)[0];
            if (first) candidates.push({url: first, source: "image"});
        }
    }

    return chooseBestMediaUrl(candidates);
}

function extractMediaProvenance(raw) {
    const normalized = normalizeMediaUrl(raw);
    if (!normalized) return null;
    const parsed = new URL(normalized);
    const attachment = parsed.pathname.match(/^\/(attachments|ephemeral-attachments)\/(\d+)\/(\d+)\/([^/]+)$/);
    if (attachment) {
        return {
            kind: attachment[1] === "ephemeral-attachments" ? "ephemeral_attachment" : "attachment",
            path: parsed.pathname,
            attachmentChannelId: attachment[2],
            attachmentId: attachment[3]
        };
    }
    return null;
}

function sameMediaProvenance(left, right) {
    if (!left || !right) return false;
    return ["kind", "path", "attachmentChannelId", "attachmentId"]
        .every(key => String(left[key] || "") === String(right[key] || ""));
}

function sanitizeFilename(raw, mimeType = "") {
    let filename = String(raw || "image");
    try {
        filename = decodeURIComponent(filename);
    }
    catch {
        // Keep the undecoded name if a URL contains malformed percent escapes.
    }

    filename = filename
        .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_")
        .replace(/\s+/g, " ")
        .replace(/^\.+|\.+$/g, "")
        .trim()
        .slice(0, 180);

    if (!filename) filename = "image";
    if (!IMAGE_EXTENSION_RE.test(filename)) {
        const extension = {
            "image/avif": ".avif",
            "image/gif": ".gif",
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/tiff": ".tiff",
            "image/webp": ".webp"
        }[String(mimeType).toLowerCase()];
        if (extension) filename += extension;
    }
    return filename;
}

function filenameFromUrl(raw, mimeType = "") {
    try {
        const pathname = new URL(String(raw)).pathname;
        const lastSegment = pathname.split("/").filter(Boolean).pop() || "image";
        return sanitizeFilename(lastSegment, mimeType);
    }
    catch {
        return sanitizeFilename("image", mimeType);
    }
}

function filenameFromContentDisposition(raw) {
    const value = String(raw || "");
    const encoded = value.match(/filename\*=UTF-8''([^;]+)/i);
    if (encoded) {
        try {
            return decodeURIComponent(encoded[1].trim());
        }
        catch {
            return encoded[1].trim();
        }
    }
    const plain = value.match(/filename="([^"]+)"|filename=([^;]+)/i);
    return plain ? (plain[1] || plain[2] || "").trim() : "";
}

function inferMimeType(raw, filename) {
    const headerType = String(raw || "").split(";", 1)[0].trim().toLowerCase();
    if (headerType.startsWith("image/")) return headerType;
    const extension = String(filename || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    return {
        apng: "image/apng",
        avif: "image/avif",
        bmp: "image/bmp",
        gif: "image/gif",
        jfif: "image/jpeg",
        jpeg: "image/jpeg",
        jpg: "image/jpeg",
        png: "image/png",
        tif: "image/tiff",
        tiff: "image/tiff",
        webp: "image/webp"
    }[extension] || "application/octet-stream";
}

function sha256Hex(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return createHash("sha256")
        .update(Buffer.from(view.buffer, view.byteOffset, view.byteLength))
        .digest("hex");
}

function detectImageFormat(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const has = (...values) => values.every((value, index) => data[index] === value);
    if (data.length >= 8 && has(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
        return {extension: ".png", mimeType: "image/png", kind: "png"};
    }
    if (data.length >= 3 && has(0xff, 0xd8, 0xff)) {
        return {extension: ".jpg", mimeType: "image/jpeg", kind: "jpeg"};
    }
    if (data.length >= 12 && Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(data.subarray(8, 12)).toString("ascii") === "WEBP") {
        return {extension: ".webp", mimeType: "image/webp", kind: "webp"};
    }
    if (data.length >= 6) {
        const signature = Buffer.from(data.subarray(0, 6)).toString("ascii");
        if (signature === "GIF87a" || signature === "GIF89a") return {extension: ".gif", mimeType: "image/gif", kind: "gif"};
    }
    if (data.length >= 2 && has(0x42, 0x4d)) return {extension: ".bmp", mimeType: "image/bmp", kind: "bmp"};
    if (data.length >= 4 && (has(0x49, 0x49, 0x2a, 0x00) || has(0x4d, 0x4d, 0x00, 0x2a))) {
        return {extension: ".tif", mimeType: "image/tiff", kind: "tiff"};
    }
    if (data.length >= 12 && Buffer.from(data.subarray(4, 8)).toString("ascii") === "ftyp") {
        const brand = Buffer.from(data.subarray(8, 12)).toString("ascii");
        if (brand === "avif" || brand === "avis") return {extension: ".avif", mimeType: "image/avif", kind: "avif"};
    }
    return null;
}

function validateSaveFolder(raw) {
    const value = String(raw || "").trim();
    if (!value || value.includes("\u0000") || !path.win32.isAbsolute(value)) {
        return {ok: false, error: "The local save folder must be an absolute Windows path."};
    }
    const normalized = path.win32.normalize(value);
    const root = path.win32.parse(normalized).root;
    if (!root || normalized.toLowerCase() === root.toLowerCase()) {
        return {ok: false, error: "Choose a folder below a drive root."};
    }
    return {ok: true, path: normalized};
}

function callFileSystem(fileSystem, asyncMethod, syncMethod, args) {
    return new Promise((resolve, reject) => {
        try {
            if (typeof fileSystem?.[syncMethod] === "function") {
                resolve(fileSystem[syncMethod](...args));
                return;
            }
            if (typeof fileSystem?.[asyncMethod] === "function") {
                fileSystem[asyncMethod](...args, (error, value) => {
                    if (error) reject(error);
                    else resolve(value);
                });
                return;
            }
            reject(new Error(`BetterDiscord's filesystem shim does not provide ${asyncMethod} or ${syncMethod}.`));
        }
        catch (error) {
            reject(error);
        }
    });
}

function isFileSystemError(error, expectedCode) {
    const code = String(expectedCode || "").trim().toUpperCase();
    if (!code) return false;
    if (String(error?.code || "").trim().toUpperCase() === code) return true;

    // Electron/BetterDiscord can preserve the native fs message while dropping
    // custom Error fields such as `code` as the error crosses its bridge.
    const message = String(error?.message || error || "").trim();
    return new RegExp(`(?:^|\\s)${code}(?::|\\b)`, "i").test(message);
}

function readFileCompat(fileSystem, filePath, encoding) {
    const args = [filePath, encoding ?? null];
    return callFileSystem(fileSystem, "readFile", "readFileSync", args);
}

function writeFileCompat(fileSystem, filePath, value, options = {}) {
    return callFileSystem(fileSystem, "writeFile", "writeFileSync", [filePath, value, options]);
}

function isFileCompat(fileSystem, filePath) {
    for (const method of ["statSync", "lstatSync"]) {
        try {
            if (typeof fileSystem?.[method] !== "function") continue;
            const stat = fileSystem[method](filePath);
            return typeof stat?.isFile === "function" ? stat.isFile() : Boolean(stat);
        }
        catch {}
    }
    try {
        if (typeof fileSystem?.existsSync === "function") return Boolean(fileSystem.existsSync(filePath));
    }
    catch {}
    try {
        if (typeof fileSystem?.accessSync === "function") {
            fileSystem.accessSync(filePath);
            return true;
        }
    }
    catch {}
    try {
        if (typeof fileSystem?.readFileSync === "function") {
            const bytes = fileSystem.readFileSync(filePath);
            return bytes !== undefined && bytes !== null;
        }
    }
    catch {}
    return false;
}

function mkdirCompat(fileSystem, folderPath) {
    return callFileSystem(fileSystem, "mkdir", "mkdirSync", [folderPath, {recursive: true}]);
}

function unlinkCompat(fileSystem, filePath) {
    return callFileSystem(fileSystem, "unlink", "unlinkSync", [filePath]);
}

function writeFileExclusiveCompat(fileSystem, filePath, bytes) {
    return callFileSystem(fileSystem, "writeFile", "writeFileSync", [filePath, bytes, {flag: "wx"}]);
}

async function hashFile(filePath, fileSystem = fs) {
    return sha256Hex(await readFileCompat(fileSystem, filePath));
}

async function writeExclusive(filePath, bytes, fileSystem = fs) {
    try {
        const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        await writeFileExclusiveCompat(fileSystem, filePath, buffer);
        return true;
    }
    catch (error) {
        if (isFileSystemError(error, "EEXIST")) return false;
        await unlinkCompat(fileSystem, filePath).catch(() => {});
        throw error;
    }
}

async function saveOriginalImage(folder, bytes, sha256, format, fileSystem = fs) {
    const validated = validateSaveFolder(folder);
    if (!validated.ok) throw new Error(validated.error);
    await mkdirCompat(fileSystem, validated.path);

    const canonicalName = `${sha256}${format.extension}`;
    const canonicalPath = path.win32.join(validated.path, canonicalName);
    if (await writeExclusive(canonicalPath, bytes, fileSystem)) {
        return {filePath: canonicalPath, filename: canonicalName, deduplicated: false};
    }

    if (await hashFile(canonicalPath, fileSystem) === sha256) {
        return {filePath: canonicalPath, filename: canonicalName, deduplicated: true};
    }

    for (let counter = 1; counter <= 999; counter += 1) {
        const collisionName = `${sha256}-collision-${counter}${format.extension}`;
        const collisionPath = path.win32.join(validated.path, collisionName);
        if (await writeExclusive(collisionPath, bytes, fileSystem)) {
            return {filePath: collisionPath, filename: collisionName, deduplicated: false, collision: true};
        }
        if (await hashFile(collisionPath, fileSystem) === sha256) {
            return {filePath: collisionPath, filename: collisionName, deduplicated: true, collision: true};
        }
    }
    throw new Error("Could not choose a collision-safe local filename.");
}

function historyThumbnailCacheDirectory(folder) {
    const validated = validateSaveFolder(folder);
    if (!validated.ok) throw new Error(validated.error);
    return path.win32.join(validated.path, HISTORY_THUMBNAIL_DIRECTORY);
}

function historyThumbnailCacheCandidates(folder, hash) {
    const key = String(hash || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("A full image SHA-256 is required for the thumbnail cache.");
    const directory = historyThumbnailCacheDirectory(folder);
    return [".webp", ".png", ".jpg", ".jpeg"].map(extension => path.win32.join(directory, `${key}${extension}`));
}

function clearHistoryThumbnailCache(directory, fileSystem = fs) {
    let removed = 0;
    try {
        const entries = fileSystem.readdirSync(directory, {withFileTypes: true});
        for (const entry of entries) {
            if (!entry?.isFile?.() || !/^[a-f0-9]{64}\.(?:webp|png|jpe?g)$/i.test(entry.name)) continue;
            try {
                fileSystem.unlinkSync(path.win32.join(directory, entry.name));
                removed += 1;
            }
            catch {}
        }
    }
    catch {}
    return removed;
}

async function savePromptSidecar(imagePath, prompt, fileSystem = fs) {
    const parsed = path.win32.parse(imagePath);
    const sidecarPath = path.win32.join(parsed.dir, `${parsed.name}.txt`);
    const content = `${String(prompt).trim()}\r\n`;
    const bytes = Buffer.from(content, "utf8");
    if (await writeExclusive(sidecarPath, bytes, fileSystem)) return sidecarPath;
    const existing = await readFileCompat(fileSystem, sidecarPath, "utf8");
    if (existing === content) return sidecarPath;

    const promptHash = sha256Hex(Buffer.from(content)).slice(0, 12);
    const alternate = path.win32.join(parsed.dir, `${parsed.name}-prompt-${promptHash}.txt`);
    if (!(await writeExclusive(alternate, bytes, fileSystem))) {
        const alternateExisting = await readFileCompat(fileSystem, alternate, "utf8");
        if (alternateExisting !== content) throw new Error("A different prompt sidecar already uses the collision-safe name.");
    }
    return alternate;
}

function visionPromptSidecarPath(imagePath, canonicalHash = "", cacheProfile = null) {
    const parsed = path.win32.parse(imagePath);
    const baseName = /^[a-f0-9]{64}$/i.test(String(canonicalHash)) ? String(canonicalHash).toLowerCase() : parsed.name;
    const suffix = cacheProfile ? `.${visionCacheProfileDigest(cacheProfile)}` : "";
    return path.win32.join(parsed.dir, `${baseName}.vision${suffix}.txt`);
}

async function saveVisionPromptSidecar(imagePath, prompt, fileSystem = fs, canonicalHash = "", promptVariants = [], cacheProfile = null) {
    const normalizedProfile = cacheProfile ? normalizeVisionCacheProfile(cacheProfile) : null;
    const sidecarPath = visionPromptSidecarPath(imagePath, canonicalHash, normalizedProfile);
    const content = `${String(prompt).trim()}\r\n`;
    const bytes = Buffer.from(content, "utf8");
    let savedPath = sidecarPath;
    if (!(await writeExclusive(sidecarPath, bytes, fileSystem))) {
        const existing = await readFileCompat(fileSystem, sidecarPath, "utf8");
        if (existing !== content) {
            const promptHash = sha256Hex(Buffer.from(content)).slice(0, 12);
            const parsedSidecar = path.win32.parse(sidecarPath);
            const alternate = path.win32.join(parsedSidecar.dir, `${parsedSidecar.name}-${promptHash}.txt`);
            if (!(await writeExclusive(alternate, bytes, fileSystem))) {
                const alternateExisting = await readFileCompat(fileSystem, alternate, "utf8");
                if (alternateExisting !== content) throw new Error("A different Vision prompt sidecar already uses the collision-safe name.");
            }
            savedPath = alternate;
        }
    }
    if (Array.isArray(promptVariants) && promptVariants.length === 3) {
        const normalizedVariants = promptVariants.map(normalizeVisionPrompt);
        if (normalizedVariants[0] !== normalizeVisionPrompt(prompt) || new Set(normalizedVariants).size !== 3) {
            throw new Error("Vision prompt variations did not match the primary prompt contract.");
        }
        const bundlePath = savedPath.replace(/\.txt$/i, ".prompts.json");
        const bundleRecord = {
            schema_version: normalizedProfile ? VISION_SIDECAR_SCHEMA_VERSION : 1,
            image_sha256: /^[a-f0-9]{64}$/i.test(String(canonicalHash)) ? String(canonicalHash).toLowerCase() : "",
            prompt: normalizedVariants[0],
            prompt_variants: normalizedVariants
        };
        if (normalizedProfile) {
            bundleRecord.cache_key = visionCacheProfileDigest(normalizedProfile);
            bundleRecord.cache_identity = normalizedProfile;
        }
        const bundle = `${JSON.stringify(bundleRecord, null, 2)}\r\n`;
        await writeFileCompat(fileSystem, bundlePath, bundle, {encoding: "utf8", flag: "w"});
    }
    return savedPath;
}

async function readReusableVisionPrompt(imagePath, fileSystem = fs, canonicalHash = "", expectedCacheProfile = null) {
    const normalizedExpected = expectedCacheProfile ? normalizeVisionCacheProfile(expectedCacheProfile) : null;
    const expectedCacheKey = normalizedExpected ? visionCacheProfileDigest(normalizedExpected) : "";
    const sidecarPath = visionPromptSidecarPath(imagePath, canonicalHash, normalizedExpected);
    let content;
    try {
        content = await readFileCompat(fileSystem, sidecarPath, "utf8");
    }
    catch (error) {
        if (isFileSystemError(error, "ENOENT")) return null;
        throw error;
    }
    try {
        const prompt = normalizeVisionPrompt(content);
        const bundlePath = sidecarPath.replace(/\.txt$/i, ".prompts.json");
        let promptVariants = [prompt];
        try {
            const rawBundle = await readFileCompat(fileSystem, bundlePath, "utf8");
            const bundle = JSON.parse(rawBundle);
            const expectedHash = /^[a-f0-9]{64}$/i.test(String(canonicalHash)) ? String(canonicalHash).toLowerCase() : "";
            if (normalizedExpected) {
                if (
                    bundle?.schema_version !== VISION_SIDECAR_SCHEMA_VERSION ||
                    bundle.cache_key !== expectedCacheKey ||
                    visionCacheProfileDigest(bundle.cache_identity) !== expectedCacheKey
                ) return null;
            }
            if (
                (bundle?.schema_version === 1 || bundle?.schema_version === VISION_SIDECAR_SCHEMA_VERSION) &&
                (!expectedHash || bundle.image_sha256 === expectedHash) &&
                Array.isArray(bundle.prompt_variants) &&
                bundle.prompt_variants.length === 3
            ) {
                const normalized = bundle.prompt_variants.map(normalizeVisionPrompt);
                if (normalized[0] === prompt && new Set(normalized).size === 3) promptVariants = normalized;
            }
        }
        catch (error) {
            if (!isFileSystemError(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
        }
        if (normalizedExpected && promptVariants.length !== 3) return null;
        return {
            prompt,
            prompt_variants: promptVariants,
            sidecarPath,
            ...(normalizedExpected ? {cache_identity: normalizedExpected, cache_key: expectedCacheKey} : {})
        };
    }
    catch {
        return null;
    }
}

function isVisionSupportedFormat(format) {
    return format?.kind === "png" || format?.kind === "jpeg" || format?.kind === "webp";
}

function decodeTextBytes(bytes, encoding = "utf8") {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (encoding === "latin1") return buffer.toString("latin1");
    const utf8 = buffer.toString("utf8");
    const replacementCount = (utf8.match(/\ufffd/g) || []).length;
    return replacementCount > Math.max(2, utf8.length * 0.02) ? buffer.toString("latin1") : utf8;
}

function decodeHtmlEntities(raw) {
    const named = {amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"'};
    return String(raw || "").replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (whole, entity) => {
        if (entity[0] === "#") {
            const hexadecimal = entity[1]?.toLowerCase() === "x";
            const value = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
            if (Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff) {
                try { return String.fromCodePoint(value); }
                catch { return whole; }
            }
            return whole;
        }
        return named[entity.toLowerCase()] ?? whole;
    });
}

function extractNamedEntriesFromText(raw, sourceKey = "") {
    const text = String(raw || "").replace(/\u0000+$/g, "");
    const entries = [];
    if (/^(?:parameters|prompt)$/i.test(String(sourceKey).trim())) entries.push({key: sourceKey, value: text});

    const wrapper = text.match(/^\s*(parameters|prompt)\s*:\s*([\s\S]+)$/i);
    if (wrapper) entries.push({key: wrapper[1], value: wrapper[2]});

    const tagPattern = /<(?:[\w.-]+:)?(parameters|prompt)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?\1\s*>/gi;
    for (const match of text.matchAll(tagPattern)) entries.push({key: match[1], value: match[2]});
    const attributePattern = /\b(?:[\w.-]+:)?(parameters|prompt)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    for (const match of text.matchAll(attributePattern)) entries.push({key: match[1], value: match[2] ?? match[3] ?? ""});
    return entries;
}

function parsePngMetadata(bytes) {
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = [];
    const entries = [];
    let hasMetadata = false;
    let parseIssues = 0;
    let offset = 8;

    while (offset + 12 <= data.length) {
        const length = data.readUInt32BE(offset);
        const type = data.subarray(offset + 4, offset + 8).toString("ascii");
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (!/^[A-Za-z]{4}$/.test(type) || dataEnd + 4 > data.length) {
            parseIssues += 1;
            break;
        }
        if (chunks.length < MAX_DIAGNOSTIC_CHUNKS) chunks.push({name: type, size: length});
        const payload = data.subarray(dataStart, dataEnd);

        try {
            if (type === "tEXt") {
                hasMetadata = true;
                const separator = payload.indexOf(0);
                if (separator > 0) {
                    const key = payload.subarray(0, separator).toString("latin1");
                    const value = payload.subarray(separator + 1).toString("latin1");
                    entries.push(...extractNamedEntriesFromText(value, key));
                }
                else parseIssues += 1;
            }
            else if (type === "zTXt") {
                hasMetadata = true;
                // The reviewed companion parser handles compressed PNG text through
                // Chromium's bounded DecompressionStream. The fallback stays fail-closed.
                parseIssues += 1;
            }
            else if (type === "iTXt") {
                hasMetadata = true;
                const keyEnd = payload.indexOf(0);
                if (keyEnd <= 0 || keyEnd + 3 > payload.length) throw new Error("Malformed iTXt");
                const key = payload.subarray(0, keyEnd).toString("latin1");
                const compressed = payload[keyEnd + 1] === 1;
                let cursor = keyEnd + 3;
                const languageEnd = payload.indexOf(0, cursor);
                if (languageEnd < 0) throw new Error("Malformed iTXt language");
                cursor = languageEnd + 1;
                const translatedEnd = payload.indexOf(0, cursor);
                if (translatedEnd < 0) throw new Error("Malformed iTXt translated keyword");
                cursor = translatedEnd + 1;
                if (compressed) parseIssues += 1;
                else entries.push(...extractNamedEntriesFromText(decodeTextBytes(payload.subarray(cursor)), key));
            }
            else if (type === "eXIf") hasMetadata = true;
        }
        catch {
            parseIssues += 1;
        }

        offset = dataEnd + 4;
        if (type === "IEND") break;
    }
    return {chunks, entries, hasMetadata, parseIssues};
}

function parseJpegMetadata(bytes) {
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = [];
    const entries = [];
    let hasMetadata = false;
    let parseIssues = 0;
    let offset = 2;

    while (offset + 4 <= data.length) {
        if (data[offset] !== 0xff) { parseIssues += 1; break; }
        while (data[offset] === 0xff) offset += 1;
        const marker = data[offset++];
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker >= 0xd0 && marker <= 0xd7) continue;
        if (offset + 2 > data.length) break;
        const segmentLength = data.readUInt16BE(offset);
        if (segmentLength < 2 || offset + segmentLength > data.length) { parseIssues += 1; break; }
        const payload = data.subarray(offset + 2, offset + segmentLength);
        const name = marker === 0xfe ? "COM" : marker >= 0xe0 && marker <= 0xef ? `APP${marker - 0xe0}` : `FF${marker.toString(16).toUpperCase()}`;
        if (chunks.length < MAX_DIAGNOSTIC_CHUNKS) chunks.push({name, size: payload.length});
        if (marker === 0xfe || marker === 0xe1 || marker === 0xed) {
            hasMetadata = true;
            const text = decodeTextBytes(payload);
            entries.push(...extractNamedEntriesFromText(text, marker === 0xfe ? "comment" : name));
        }
        offset += segmentLength;
    }
    return {chunks, entries, hasMetadata, parseIssues};
}

function parseWebpMetadata(bytes) {
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = [];
    const entries = [];
    let hasMetadata = false;
    let parseIssues = 0;
    let offset = 12;
    while (offset + 8 <= data.length) {
        const name = data.subarray(offset, offset + 4).toString("ascii");
        const size = data.readUInt32LE(offset + 4);
        const start = offset + 8;
        const end = start + size;
        if (end > data.length) { parseIssues += 1; break; }
        if (chunks.length < MAX_DIAGNOSTIC_CHUNKS) chunks.push({name: name.trim() || name, size});
        if (name === "XMP " || name === "EXIF") {
            hasMetadata = true;
            if (name === "XMP ") entries.push(...extractNamedEntriesFromText(decodeTextBytes(data.subarray(start, end)), "XMP"));
        }
        offset = end + (size % 2);
    }
    return {chunks, entries, hasMetadata, parseIssues};
}

function parseImageMetadata(bytes, format) {
    if (format.kind === "png") return parsePngMetadata(bytes);
    if (format.kind === "jpeg") return parseJpegMetadata(bytes);
    if (format.kind === "webp") return parseWebpMetadata(bytes);
    return {chunks: [{name: format.kind.toUpperCase(), size: bytes.byteLength}], entries: [], hasMetadata: false, parseIssues: 0};
}

function shannonEntropy(raw) {
    const text = String(raw || "");
    if (!text.length) return 0;
    const counts = new Map();
    for (const character of text) counts.set(character, (counts.get(character) || 0) + 1);
    let entropy = 0;
    for (const count of counts.values()) {
        const probability = count / text.length;
        entropy -= probability * Math.log2(probability);
    }
    return entropy;
}

function looksLikeJsonObjectOrArray(raw) {
    const text = String(raw || "").trim();
    if (!text || !["{", "["].includes(text[0])) return false;
    try {
        const parsed = JSON.parse(text);
        return parsed !== null && typeof parsed === "object";
    }
    catch {
        return true;
    }
}

function looksLikeStructuredYaml(raw) {
    const text = String(raw || "").trim();
    if (/^---(?:\s|$)|^!!(?:map|seq|str)\b/i.test(text)) return true;
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) return false;
    const mappingLines = lines.filter(line => /^\s*(?:-\s*)?[A-Za-z_][\w .-]{0,50}:\s*(?:\S.*)?$/.test(line));
    const listLines = lines.filter(line => /^\s*-\s+\S/.test(line));
    return mappingLines.length >= 2 || (mappingLines.length >= 1 && listLines.length >= 2);
}

function looksEncodedOrEncrypted(raw) {
    const text = String(raw || "").trim();
    if (!text) return false;
    if (/-----BEGIN [A-Z0-9 ]+-----|\b(?:ciphertext|encrypted payload|aes-(?:128|192|256)|nonce|initialization vector)\b/i.test(text)) return true;
    if (/^(?:enc(?:rypted)?|ciphertext|base64|data:[^;]+;base64)\s*:/i.test(text)) return true;
    const compact = text.replace(/\s+/g, "");
    const whitespaceRatio = (text.match(/\s/g) || []).length / text.length;
    if (compact.length >= 64 && /^[A-Fa-f0-9]+$/.test(compact)) return true;
    if (compact.length >= 96 && whitespaceRatio < 0.06 && /^[A-Za-z0-9+/_=-]+$/.test(compact) && compact.length % 4 <= 1) return true;
    return text.length >= 120 && whitespaceRatio < 0.035 && shannonEntropy(text) >= 5.15;
}

function isSubstantiallyNonEnglish(raw) {
    const text = String(raw || "");
    const letters = text.match(/\p{L}/gu) || [];
    if (letters.length < 4) return false;
    const latinCount = letters.filter(letter => /\p{Script=Latin}/u.test(letter)).length;
    const nonLatinCount = letters.length - latinCount;
    if (nonLatinCount >= 4 && nonLatinCount / letters.length > 0.22) return true;

    const words = (text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").match(/[a-z]{2,}/g) || []);
    if (!words.length) return true;
    const englishFunctionWords = new Set("a about above across after against all along also an and another any around as at away back be because been before behind below beneath beside between both but by can could down during each even every few for from had has have he her here hers him his how if in into is it its may more most near no not of off on one only or other our out over she should since so some than that the their them then there these they this those through to too under up upon very was we were what when where which while who will with within without would you your".split(" "));
    const englishVisualWords = new Set("animal architecture background beach beautiful black blonde blue body brown candid cinematic closeup clothing couch dark detailed detail dog dress editorial eyes face fantasy female film freckles fullbody girl glossy gray green hair high indoor light lighting long makeup man minimalist natural orange photo photograph photographic photorealistic portrait realistic red sharp short skin soft studio style sunlight tattoo texture ultra white woman young".split(" "));
    const foreignSignals = new Set("avec beau belle cabello cabelos cheveux chica con donna eine frau fille garcon hombre homme jeune jolie jungen lange licht mujer menina olhos para pelo ragazza ragazzo rouge schoen una une yeux".split(" "));
    const functionCount = words.filter(word => englishFunctionWords.has(word)).length;
    const visualCount = words.filter(word => englishVisualWords.has(word)).length;
    const englishCount = functionCount + visualCount;
    const foreignCount = words.filter(word => foreignSignals.has(word)).length;
    const requiredSignals = words.length <= 5 ? 1 : words.length <= 12 ? 2 : Math.max(3, Math.ceil(words.length * 0.06));
    const confidentlyEnglish = englishCount >= requiredSignals
        && (functionCount >= 1 || visualCount >= 2 || words.length <= 5);
    return !confidentlyEnglish || (foreignCount >= 3 && foreignCount > englishCount * 1.5);
}

function evaluatePromptValue(raw) {
    let text = decodeHtmlEntities(String(raw || ""))
        .normalize("NFKC")
        .replace(/^\uFEFF/, "")
        .replace(/\u0000/g, "")
        .replace(/\r\n?/g, "\n")
        .trim();
    text = text.replace(/^\s*(?:parameters|prompt)\s*:\s*/i, "").trim();
    if (!text) return {classification: "metadata_no_prompt"};
    if (looksLikeJsonObjectOrArray(text)) return {classification: "structured"};

    const negativeIndex = text.search(/negative\s+prompt\s*:/i);
    let positive = (negativeIndex >= 0 ? text.slice(0, negativeIndex) : text).trim();
    positive = positive.split(/\n(?=(?:Steps|Sampler|CFG scale|Seed|Size|Model(?: hash)?)\s*:)/i, 1)[0].trim();
    if (!positive) return {classification: "metadata_no_prompt"};
    if (looksLikeStructuredYaml(positive)) return {classification: "structured"};
    if (looksEncodedOrEncrypted(positive)) return {classification: "encoded_or_unknown"};
    if (isSubstantiallyNonEnglish(positive)) return {classification: "non_english"};
    if (positive.length > 100000) return {classification: "encoded_or_unknown"};
    return {classification: "usable", prompt: positive};
}

function classifyPromptMetadata(metadata) {
    if (!metadata.hasMetadata && !metadata.entries.length) {
        return {
            classification: metadata.parseIssues ? "encoded_or_unknown" : "no_metadata",
            chunks: metadata.chunks
        };
    }
    if (!metadata.entries.length) {
        return {
            classification: metadata.parseIssues ? "encoded_or_unknown" : "metadata_no_prompt",
            chunks: metadata.chunks
        };
    }

    const rejected = [];
    for (const entry of metadata.entries) {
        const result = evaluatePromptValue(entry.value);
        if (result.classification === "usable") return {...result, chunks: metadata.chunks};
        rejected.push(result.classification);
    }
    const priority = ["non_english", "structured", "encoded_or_unknown", "metadata_no_prompt"];
    return {classification: priority.find(value => rejected.includes(value)) || "metadata_no_prompt", chunks: metadata.chunks};
}

async function extractConfidentPrompt(bytes, format) {
    if (format.kind === "png" && parseHardenedPngPromptMetadata) {
        const hardened = await parseHardenedPngPromptMetadata(bytes, {
            maxFileBytes: MAX_IMAGE_BYTES,
            maxMetadataChunkBytes: 2 * 1024 * 1024,
            maxTextBytes: 1024 * 1024,
            maxTotalTextBytes: 2 * 1024 * 1024
        });
        const container = scanPngChunkSummary(bytes);
        const classification = {
            found: "usable",
            none: container.hasMetadata ? "metadata_no_prompt" : "no_metadata",
            metadata_no_prompt: "metadata_no_prompt",
            encoded_or_unknown: "encoded_or_unknown",
            structured: "structured",
            non_english: "non_english"
        }[hardened.status] || "encoded_or_unknown";
        return {
            classification,
            prompt: classification === "usable" ? hardened.prompt : undefined,
            chunks: container.chunks
        };
    }
    if (format.kind === "png") {
        const container = scanPngChunkSummary(bytes);
        return {
            classification: container.hasMetadata ? "encoded_or_unknown" : "no_metadata",
            chunks: container.chunks
        };
    }
    // JPEG/WebP metadata containers need their own bounded, keyed parsers before
    // they are eligible for prompt submission. The original is still saved.
    return {
        classification: "encoded_or_unknown",
        chunks: [{name: format.kind.toUpperCase(), size: bytes.byteLength}]
    };
}

function scanPngChunkSummary(bytes) {
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = [];
    let hasMetadata = false;
    let offset = 8;
    for (let count = 0; count < MAX_DIAGNOSTIC_CHUNKS && offset + 12 <= data.length; count += 1) {
        const length = data.readUInt32BE(offset);
        const type = data.subarray(offset + 4, offset + 8).toString("ascii");
        const dataEnd = offset + 8 + length;
        if (!/^[A-Za-z]{4}$/.test(type) || dataEnd + 4 > data.length) break;
        chunks.push({name: type, size: length});
        if (["tEXt", "zTXt", "iTXt", "eXIf"].includes(type)) hasMetadata = true;
        offset = dataEnd + 4;
        if (type === "IEND") break;
    }
    return {chunks, hasMetadata};
}

function sanitizeDiagnosticChunks(chunks) {
    return (Array.isArray(chunks) ? chunks : []).slice(0, MAX_DIAGNOSTIC_CHUNKS).map(chunk => ({
        name: String(chunk?.name || "unknown").replace(/[^A-Za-z0-9_. -]/g, "_").slice(0, 40),
        size: Number.isSafeInteger(Number(chunk?.size)) && Number(chunk.size) >= 0 ? Number(chunk.size) : null
    }));
}

function submissionKey(sha256, promptSource) {
    const hash = String(sha256 || "").toLowerCase();
    const source = String(promptSource || "");
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Submission hash is invalid.");
    if (source !== "embedded_metadata" && source !== "vision_ai") throw new Error("Prompt source is invalid.");
    return `${hash}:${source}`;
}

function normalizeStoredSubmissionKey(raw) {
    const value = String(raw || "").toLowerCase();
    if (/^[a-f0-9]{64}$/.test(value)) return `${value}:embedded_metadata`;
    if (/^[a-f0-9]{64}:(?:embedded_metadata|vision_ai)$/.test(value)) return value;
    return null;
}

function escapeMultipartHeader(raw) {
    return String(raw).replace(/[\r\n"]/g, "_");
}

function buildVisionMultipartBody(bytes, {filename, mimeType, model, guidance, datasetGuidance = false, feedbackContext = "", jobId, contributionTerms = "", diagnosticTerms = "", diagnosticUsername = ""} = {}) {
    const imageBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const boundary = `----Krea2Vision${randomBytes(18).toString("hex")}`;
    const chunks = [];
    const appendText = value => chunks.push(Buffer.from(String(value), "utf8"));

    appendText(`--${boundary}\r\n`);
    appendText(`Content-Disposition: form-data; name="image"; filename="${escapeMultipartHeader(filename || "image.bin")}"\r\n`);
    appendText(`Content-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`);
    chunks.push(Buffer.from(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength));
    if (model) {
        appendText(`\r\n--${boundary}\r\n`);
        appendText('Content-Disposition: form-data; name="model"\r\n\r\n');
        appendText(model);
    }
    if (guidance) {
        appendText(`\r\n--${boundary}\r\n`);
        appendText('Content-Disposition: form-data; name="guidance"\r\n\r\n');
        appendText(String(guidance).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 600));
    }
    appendText(`\r\n--${boundary}\r\n`);
    appendText('Content-Disposition: form-data; name="dataset_guidance"\r\n\r\n');
    appendText(datasetGuidance === true ? "1" : "0");
    if (contributionTerms === KREA2_CONTRIBUTION_TERMS_VERSION) {
        appendText(`\r\n--${boundary}\r\n`);
        appendText('Content-Disposition: form-data; name="contribution_terms"\r\n\r\n');
        appendText(contributionTerms);
    }
    const safeDiagnosticUsername = String(diagnosticUsername || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80);
    if (diagnosticTerms === KREA2_DIAGNOSTIC_TERMS_VERSION && safeDiagnosticUsername) {
        appendText(`\r\n--${boundary}\r\n`);
        appendText('Content-Disposition: form-data; name="diagnostic_terms"\r\n\r\n');
        appendText(diagnosticTerms);
        appendText(`\r\n--${boundary}\r\n`);
        appendText('Content-Disposition: form-data; name="diagnostic_username"\r\n\r\n');
        appendText(safeDiagnosticUsername);
    }
    if (datasetGuidance === true && feedbackContext) {
        appendText(`\r\n--${boundary}\r\n`);
        appendText('Content-Disposition: form-data; name="feedback_context"\r\n\r\n');
        appendText(String(feedbackContext).slice(0, 65536));
    }
    if (/^[a-f0-9]{32}$/.test(String(jobId || ""))) {
        appendText(`\r\n--${boundary}\r\n`);
        appendText('Content-Disposition: form-data; name="job_id"\r\n\r\n');
        appendText(jobId);
    }
    appendText(`\r\n--${boundary}--\r\n`);

    return {
        body: Buffer.concat(chunks),
        contentType: `multipart/form-data; boundary=${boundary}`
    };
}

function normalizeVisionPrompt(raw) {
    if (typeof raw !== "string") throw new Error("Vision Prompt Studio did not return prompt as plain text.");
    let prompt;
    try {
        prompt = raw.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
    }
    catch {
        throw new Error("Vision Prompt Studio returned text that could not be normalized safely.");
    }
    if (!prompt) throw new Error("Vision Prompt Studio returned an empty positive prompt.");
    if (prompt.length > MAX_VISION_PROMPT_CHARS) throw new Error("Vision Prompt Studio returned an oversized positive prompt.");

    const negativeIndex = prompt.search(/negative\s+prompt\s*:/i);
    if (negativeIndex >= 0) prompt = prompt.slice(0, negativeIndex).trim();
    if (!prompt) throw new Error("Vision Prompt Studio returned only a negative prompt.");
    if (looksLikeJsonObjectOrArray(prompt) || looksLikeStructuredYaml(prompt) || looksEncodedOrEncrypted(prompt)) {
        throw new Error("Vision Prompt Studio returned structured or encoded output instead of a safe plain-text prompt.");
    }
    if (/^(?:i\s+(?:am\s+)?sorry\b|i\s+(?:cannot|can't|won't)\b|as\s+an\s+ai\b|unable\s+to\b|request\s+refused\b)/i.test(prompt.slice(0, 300))) {
        throw new Error("Vision Prompt Studio returned a refusal instead of a prompt.");
    }

    const wordCount = (prompt.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu) || []).length;
    if (wordCount < 80 && prompt.length < 500) {
        throw new Error("Vision Prompt Studio output was too short for Obsessive Detail.");
    }
    return prompt;
}

function normalizeVisionPromptVariants(raw, {requireThree = true, fallbackPrompt = ""} = {}) {
    if (!Array.isArray(raw)) {
        if (!requireThree && fallbackPrompt) return [normalizeVisionPrompt(fallbackPrompt)];
        throw new Error("Vision Prompt Studio did not return prompt variations as an array.");
    }
    const prompts = raw.map(normalizeVisionPrompt);
    if (requireThree && prompts.length !== 3) {
        throw new Error("Vision Prompt Studio did not return exactly three prompt variations.");
    }
    if (!prompts.length || prompts.length > 3 || new Set(prompts).size !== prompts.length) {
        throw new Error("Vision Prompt Studio returned duplicate or invalid prompt variations.");
    }
    return prompts;
}

function parseVisionPromptResponse(rawText, {expectedDatasetGuidance = null, expectedFeedbackDigest = null} = {}) {
    const text = String(rawText || "");
    if (!text || Buffer.byteLength(text, "utf8") > MAX_VISION_RESPONSE_BYTES) {
        throw new Error("Vision Prompt Studio returned an empty or oversized response.");
    }
    let state;
    try {
        state = JSON.parse(text);
    }
    catch {
        throw new Error("Vision Prompt Studio did not return valid JSON.");
    }
    if (!state || typeof state !== "object" || Array.isArray(state)) {
        throw new Error("Vision Prompt Studio returned an invalid state object.");
    }
    if (state.classification !== "usable") {
        throw new Error("Vision Prompt Studio did not classify its output as usable.");
    }
    if (typeof state.model !== "string" || !state.model.trim() || state.model.length > 200) {
        throw new Error("Vision Prompt Studio returned an invalid model identifier.");
    }
    if (!Number.isSafeInteger(state.prompt_words) || state.prompt_words < 0) {
        throw new Error("Vision Prompt Studio returned an invalid prompt word count.");
    }
    const model = state.model.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (!model) throw new Error("Vision Prompt Studio returned an invalid model identifier.");
    const prompt = normalizeVisionPrompt(state.prompt);
    const promptVariants = normalizeVisionPromptVariants(state.prompt_variants);
    if (promptVariants[0] !== prompt) {
        throw new Error("Vision Prompt Studio returned a primary prompt that did not match Prompt 1.");
    }
    const pipelineId = String(state.pipeline_id || "").trim();
    if (pipelineId !== VISION_PIPELINE_ID) {
        throw new Error("Vision Prompt Studio returned an incompatible prompt pipeline identity.");
    }
    const datasetGuidance = normalizeDatasetGuidanceState(state.dataset_guidance, {
        expectedEnabled: expectedDatasetGuidance,
        expectedFeedbackDigest
    });
    return {
        prompt,
        prompt_variants: promptVariants,
        model,
        prompt_words: state.prompt_words,
        pipeline_id: pipelineId,
        dataset_guidance: datasetGuidance
    };
}

function parseStudioErrorDetail(rawText) {
    let body;
    try {
        body = JSON.parse(String(rawText || ""));
    }
    catch {
        return "";
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.detail !== "string") return "";
    let detail;
    try {
        detail = body.detail.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    }
    catch {
        return "";
    }
    return detail.slice(0, 500);
}

function normalizeClassification(raw) {
    const value = String(raw || "").trim().toLowerCase().replace(/[ -]+/g, "_");
    return {
        added: "added",
        created: "added",
        duplicate: "duplicate",
        already_exists: "duplicate",
        no_metadata: "no_metadata",
        saved_no_metadata: "no_metadata",
        metadata_no_prompt: "metadata_no_prompt",
        no_prompt: "metadata_no_prompt",
        encoded_or_unknown: "encoded_or_unknown",
        encoded: "encoded_or_unknown",
        encrypted: "encoded_or_unknown",
        structured: "structured",
        non_english: "non_english"
    }[value] || null;
}

function parseUploadResponse(status, rawText) {
    if (Number(status) === 409) return {classification: "duplicate"};
    let body;
    try {
        body = JSON.parse(String(rawText || ""));
    }
    catch {
        throw new Error("The candidate endpoint did not return a JSON classification.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("The candidate endpoint returned an invalid classification object.");
    }
    const classification = body.duplicate === true
        ? "duplicate"
        : normalizeClassification(body.classification ?? body.status ?? body.result);
    if (!classification) throw new Error("The candidate endpoint response did not contain a recognized classification.");
    return {classification};
}

async function readResponseBytes(response, onProgress, maxBytes = MAX_IMAGE_BYTES) {
    const announcedSize = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(announcedSize) && announcedSize > maxBytes) {
        throw new Error(`Image is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
    }

    if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let loaded = 0;

        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            if (!value?.byteLength) continue;
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            loaded += chunk.byteLength;
            if (loaded > maxBytes) {
                await reader.cancel("Image size limit exceeded").catch(() => {});
                throw new Error(`Image is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
            }
            chunks.push(chunk);
            onProgress?.(loaded, Number.isFinite(announcedSize) ? announcedSize : null);
        }

        const bytes = new Uint8Array(loaded);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
        throw new Error(`Image is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
    }
    onProgress?.(bytes.byteLength, Number.isFinite(announcedSize) ? announcedSize : bytes.byteLength);
    return bytes;
}

async function readBoundedResponseText(response, maxBytes = MAX_VISION_RESPONSE_BYTES) {
    const announcedSize = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(announcedSize) && announcedSize > maxBytes) {
        throw new Error("Vision Prompt Studio returned an oversized response.");
    }

    let bytes;
    if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let loaded = 0;
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            if (!value?.byteLength) continue;
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            loaded += chunk.byteLength;
            if (loaded > maxBytes) {
                await reader.cancel("Vision response size limit exceeded").catch(() => {});
                throw new Error("Vision Prompt Studio returned an oversized response.");
            }
            chunks.push(chunk);
        }
        bytes = new Uint8Array(loaded);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
    }
    else {
        bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > maxBytes) throw new Error("Vision Prompt Studio returned an oversized response.");
    }
    return new TextDecoder("utf-8", {fatal: false}).decode(bytes);
}

function findMessageRoot(image) {
    return image?.closest?.(
        'li[id^="chat-messages-"], [data-list-item-id^="chat-messages___"], [role="article"][data-list-item-id*="chat-messages"]'
    ) || null;
}

function messageIdFromRoot(root) {
    const source = `${root?.id || ""} ${root?.dataset?.listItemId || ""}`;
    const values = source.match(/\d{5,25}/g);
    return values?.at(-1) || "";
}

function historyBaseUrlFromVisionEndpoint(rawEndpoint) {
    const validated = validateVisionLoopbackEndpoint(rawEndpoint);
    if (!validated.ok) throw new Error(validated.error);
    return validated.origin;
}

function normalizeHistoryJob(raw, includePrompt = false) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Vision history returned an invalid job.");
    const id = String(raw.id || "").trim();
    if (!/^[a-f0-9]{16,64}$/i.test(id)) throw new Error("Vision history returned an invalid job identifier.");
    const status = String(raw.status || "unknown").trim().toLowerCase().slice(0, 32);
    const numberOrNull = value => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
    const job = {
        id,
        created: numberOrNull(raw.created),
        updated: numberOrNull(raw.updated),
        started: numberOrNull(raw.started),
        finished: numberOrNull(raw.finished),
        duration_seconds: numberOrNull(raw.duration_seconds),
        image_hash: /^[a-f0-9]{64}$/i.test(String(raw.image_hash || "")) ? String(raw.image_hash).toLowerCase() : "",
        filename: String(raw.filename || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 260),
        status,
        stage: String(raw.stage || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500),
        queue_ahead: Math.max(0, Math.trunc(Number(raw.queue_ahead) || 0)),
        model: String(raw.model || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200),
        requested_model: String(raw.requested_model || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200),
        prompt_words: Math.max(0, Math.trunc(Number(raw.prompt_words) || 0)),
        prompt_count: Math.max(0, Math.min(3, Math.trunc(Number(raw.prompt_count) || 0))),
        prompt_preview: String(raw.prompt_preview || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 1000),
        has_prompt: raw.has_prompt === true,
        public_error: String(raw.public_error || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 1000),
        cancel_requested: raw.cancel_requested === true,
        has_reproducibility: raw.has_reproducibility === true
    };
    if (includePrompt) {
        job.prompt = String(raw.prompt || "").normalize("NFKC").replace(/\r\n?/g, "\n").slice(0, MAX_VISION_PROMPT_CHARS);
        try {
            job.prompt_variants = normalizeVisionPromptVariants(raw.prompt_variants, {
                requireThree: false,
                fallbackPrompt: job.prompt
            });
        }
        catch {
            job.prompt_variants = job.prompt ? [normalizeVisionPrompt(job.prompt)] : [];
        }
        job.reproducibility = safeReproducibility(raw.reproducibility);
    }
    return job;
}

function parseHistoryListResponse(rawText) {
    let state;
    try { state = JSON.parse(String(rawText || "")); }
    catch { throw new Error("Vision history did not return valid JSON."); }
    if (!state || typeof state !== "object" || Array.isArray(state) || !Array.isArray(state.jobs)) {
        throw new Error("Vision history returned an invalid list.");
    }
    const summary = state.summary && typeof state.summary === "object" && !Array.isArray(state.summary) ? state.summary : {};
    const scheduler = state.scheduler && typeof state.scheduler === "object" && !Array.isArray(state.scheduler) ? state.scheduler : {};
    const rawPagination = state.pagination && typeof state.pagination === "object" && !Array.isArray(state.pagination) ? state.pagination : {};
    const jobs = state.jobs.slice(0, HISTORY_LIMIT).map(job => normalizeHistoryJob(job));
    const totalItems = Math.max(jobs.length, Math.trunc(Number(rawPagination.total_items) || jobs.length));
    const pageSize = Math.max(1, Math.min(HISTORY_LIMIT, Math.trunc(Number(rawPagination.page_size) || Math.max(1, jobs.length))));
    const totalPages = Math.max(1, Math.trunc(Number(rawPagination.total_pages) || Math.ceil(totalItems / pageSize) || 1));
    const page = Math.max(1, Math.min(totalPages, Math.trunc(Number(rawPagination.page) || 1)));
    return {
        summary: {
            queued: Math.max(0, Math.trunc(Number(summary.queued) || 0)),
            running: Math.max(0, Math.trunc(Number(summary.running) || 0)),
            completed_24h: Math.max(0, Math.trunc(Number(summary.completed_24h) || 0)),
            total: Math.max(0, Math.trunc(Number(summary.total) || totalItems)),
            rejected: Math.max(0, Math.trunc(Number(summary.rejected) || 0)),
            errors: Math.max(0, Math.trunc(Number(summary.errors) || 0))
            ,cancelled: Math.max(0, Math.trunc(Number(summary.cancelled) || 0))
        },
        scheduler,
        pagination: {
            page,
            page_size: pageSize,
            total_items: totalItems,
            total_pages: totalPages,
            has_previous: rawPagination.has_previous === true || page > 1,
            has_next: rawPagination.has_next === true || page < totalPages
        },
        jobs
    };
}

function parseHistoryDetailResponse(rawText) {
    let state;
    try { state = JSON.parse(String(rawText || "")); }
    catch { throw new Error("Vision history detail did not return valid JSON."); }
    return normalizeHistoryJob(state, true);
}

function filterHistoryJobs(jobs, filter) {
    const list = Array.isArray(jobs) ? jobs : [];
    if (filter === "completed") return list.filter(job => job.status === "completed");
    if (filter === "queued") return list.filter(job => job.status === "queued" || job.status === "running");
    if (filter === "errors") return list.filter(job => job.status === "error" || job.status === "rejected" || job.status === "cancelled");
    return list;
}

function historyJobMatchesModel(job, modelId) {
    if (!modelId || modelId === "all") return true;
    const model = String(job?.model || "").toLowerCase();
    if (model === String(modelId).toLowerCase()) return true;
    if (modelId === "llamacpp::heretic-8b-q8_0") return /\b8b\b/.test(model) && /heretic|qwen/.test(model);
    if (modelId === "llamacpp::heretic-4b-q8_0") return /\b4b\b/.test(model) && /heretic|qwen/.test(model);
    if (modelId === "llamacpp::heretic-2b-f16") return /\b2b\b/.test(model) && /heretic|qwen/.test(model);
    if (modelId === "llamacpp::gemma4-12b-opus-uncensored-q8_0") return /\b12b\b/.test(model) && /gemma/.test(model) && /opus/.test(model);
    if (modelId === "llamacpp::gemma4-12b-heretic-q8_0") return /\b12b\b/.test(model) && /gemma/.test(model) && /heretic/.test(model) && !/opus/.test(model);
    if (modelId === "llamacpp::gemma4-31b-heretic-q4_k_m") return /\b31b\b/.test(model) && /gemma/.test(model);
    if (modelId === "llamacpp::qwen3-vl-32b-heretic-q4_k_m") return /\b32b\b/.test(model) && /qwen/.test(model);
    if (modelId === "discord::legacy-ollama-hybrid") return /legacy|trueinterrogate|babegen/.test(model);
    return false;
}

function historyModelEvidence(job) {
    const status = String(job?.status || "").trim().toLowerCase();
    const requested = String(job?.requested_model || (!job?.has_prompt ? job?.model : "") || "").trim();
    const reproducibility = job?.reproducibility && typeof job.reproducibility === "object" ? job.reproducibility : {};
    const completed = status === "completed" && Boolean(job?.has_prompt || job?.prompt);
    if (!completed) {
        return Object.freeze({
            confirmed: false,
            label: requested || "Pending",
            model_id: requested || "Pending",
            quantization: "",
            note: status === "queued" || status === "running"
                ? "Requested only — the completed backend result will confirm the model that actually ran."
                : "No completed model result is available for this job."
        });
    }
    const actualLabel = String(job?.model || reproducibility.model_label || requested || "Unknown model").trim();
    const actualId = String(reproducibility.model_id || requested || actualLabel).trim();
    const quantization = String(reproducibility.quantization || "").trim();
    return Object.freeze({
        confirmed: true,
        label: actualLabel,
        model_id: actualId,
        quantization,
        note: reproducibility.model_id
            ? "Confirmed by the completed loopback backend result and its verified reproducibility record."
            : "Confirmed by the completed loopback backend result."
    });
}

function isHistoryJobActive(job) {
    const status = String(job?.status || "").trim().toLowerCase();
    return status === "queued" || status === "running";
}

function visionModelDisplayName(modelId) {
    const normalized = String(modelId || "").trim();
    if (normalized === ONLINE_VISION_MODEL_ID) return ONLINE_VISION_MODEL_LABEL.replace(/^Online API — /, "Remote Serverless — ").replace(/\s*\(24 GB remote GPU\)$/, "");
    const spec = HERETIC_MODEL_SPECS.find(model => model.public_id === normalized);
    if (spec?.label) return spec.label;
    const option = VISION_MODEL_OPTIONS.find(([, id]) => id === normalized);
    return option ? option[0].replace(/\s*\([^)]*estimate\)\s*$/i, "").trim() : normalized || "selected Vision model";
}

function historyJobTitle(job) {
    const filename = path.basename(String(job?.filename || "")).trim();
    if (filename && !/^[a-f0-9]{64}(?:\.[a-z0-9]+)?$/i.test(filename)) return filename;
    const hash = String(job?.image_hash || "");
    return hash ? `Image ${hash.slice(0, 10)}` : `Vision job ${String(job?.id || "").slice(0, 8)}`;
}

function formatHistoryDuration(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    if (value < 60) return `${value.toFixed(value < 10 ? 1 : 0)}s`;
    const minutes = Math.floor(value / 60);
    const remainder = Math.round(value % 60);
    return `${minutes}m ${remainder}s`;
}

function historyQueueWaitSeconds(job, nowSeconds = Date.now() / 1000) {
    const created = Number(job?.created);
    if (!Number.isFinite(created)) return null;
    const started = job?.started === null || job?.started === undefined ? null : Number(job.started);
    const finished = job?.finished === null || job?.finished === undefined ? null : Number(job.finished);
    const end = Number.isFinite(started) ? started : Number.isFinite(finished) ? finished : nowSeconds;
    return Math.max(0, end - created);
}

function historyAverageQueueWait(jobs, nowSeconds = Date.now() / 1000) {
    const parsedNow = Number(nowSeconds);
    const now = Number.isFinite(parsedNow) ? parsedNow : Date.now() / 1000;
    const cutoff = now - 86400;
    const waits = [];
    for (const job of Array.isArray(jobs) ? jobs : []) {
        if (String(job?.status || "").toLowerCase() !== "completed") continue;
        if (job?.finished === null || job?.finished === undefined || job?.started === null || job?.started === undefined) continue;
        const finished = Number(job?.finished);
        const created = Number(job?.created);
        const started = Number(job?.started);
        if (!Number.isFinite(finished) || finished < cutoff) continue;
        if (!Number.isFinite(created) || !Number.isFinite(started)) continue;
        waits.push(Math.max(0, started - created));
    }
    return Object.freeze({
        seconds: waits.length ? waits.reduce((sum, value) => sum + value, 0) / waits.length : null,
        sample_count: waits.length
    });
}

function formatAverageQueueTime(seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) {
        return "Average queue time: —";
    }
    const rounded = Math.max(0, Math.round(Number(seconds)));
    return `Average queue time: ${rounded} ${rounded === 1 ? "second" : "seconds"}`;
}

function promptPresetGuidance(preset) {
    return {
        "dataset-detailed": "Preserve exhaustive visible detail in one cohesive dataset-quality paragraph.",
        "krea2-short": "Prioritize the defining subject, environment, composition, lighting, materials, and color treatment; keep the final prompt concise and directly usable in KREA2.",
        photorealistic: "Prioritize faithful photographic appearance, natural skin and material texture, plausible lighting, lens-like composition, and visible imperfections without inventing camera metadata.",
        "character-clothing": "Prioritize every visible character separately, including face, expression, hair, anatomy, pose, hands, clothing layers, materials, colors, footwear, jewelry, accessories, tattoos, and markings.",
        environment: "Prioritize the environment, architecture, terrain, objects, spatial relationships, background depth, atmosphere, lighting, materials, and color; mention subjects only as needed for composition.",
        product: "Prioritize the primary object, shape, construction, materials, surface finish, branding or readable text, condition, placement, background, lighting, reflections, shadows, and commercial composition."
    }[String(preset || "")] || "Preserve exhaustive visible detail in one cohesive dataset-quality paragraph.";
}

function applyPromptPreset(prompt, preset) {
    const source = String(prompt || "").replace(/\s+/g, " ").trim();
    if (!source) return "";
    if (preset !== "krea2-short") return source;
    const sentences = source.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [source];
    const selected = [];
    const keywords = /\b(subject|wear|hair|scene|background|composition|light|shadow|color|material|texture|camera|view|foreground|environment)\b/i;
    for (const sentence of sentences) {
        if (selected.length < 6 || keywords.test(sentence)) selected.push(sentence.trim());
        if (selected.join(" ").length >= 1200) break;
    }
    return selected.join(" ").slice(0, 1400).trim();
}

function promptDiffSummary(left, right) {
    const words = text => new Set(String(text || "").toLowerCase().match(/[a-z0-9'’-]{3,}/g) || []);
    const a = words(left);
    const b = words(right);
    const added = [...b].filter(word => !a.has(word)).slice(0, 24);
    const removed = [...a].filter(word => !b.has(word)).slice(0, 24);
    return {added, removed};
}

function cosineSimilarity(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return 0;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index += 1) {
        const a = Number(left[index]) || 0;
        const b = Number(right[index]) || 0;
        dot += a * b;
        leftNorm += a * a;
        rightNorm += b * b;
    }
    if (!leftNorm || !rightNorm) return 0;
    return Math.max(-1, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
}

function safeModelFilePart(model) {
    return String(model || "vision").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "vision";
}

function editedPromptSidecarPath(imagePath) {
    const parsed = path.parse(imagePath);
    return path.join(parsed.dir, `${parsed.name}.vision.edited.txt`);
}

function comparisonPromptSidecarPath(imagePath, model) {
    const parsed = path.parse(imagePath);
    return path.join(parsed.dir, `${parsed.name}.vision.${safeModelFilePart(model)}.txt`);
}

function reproducibilitySidecarPath(imagePath) {
    const parsed = path.parse(imagePath);
    return path.join(parsed.dir, `${parsed.name}.vision.repro.json`);
}

function evaluationSidecarPath(imagePath) {
    const parsed = path.parse(imagePath);
    return path.join(parsed.dir, `${parsed.name}.vision.evaluation.json`);
}

function sanitizeReviewRecord(raw) {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const allowed = new Set(["unreviewed", "training-ready", "needs-correction", "excluded"]);
    return {
        collection: String(value.collection || "Unsorted").normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80) || "Unsorted",
        status: allowed.has(value.status) ? value.status : "unreviewed",
        rating: Math.max(0, Math.min(5, Math.trunc(Number(value.rating) || 0))),
        notes: String(value.notes || "").normalize("NFKC").replace(/\r\n?/g, "\n").slice(0, 2000),
        updated: Math.max(0, Number(value.updated) || 0)
    };
}

function safeReproducibility(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const clean = {};
    for (const key of ["schema_version", "pipeline_id", "provider", "model_id", "model_label", "quantization", "model_sha256", "model_bytes", "mmproj_sha256", "mmproj_bytes", "artifact_revision", "runtime_bundle_id", "runtime_release", "context_cap", "max_output_cap", "estimated_vram_mb", "measured_peak_vram_mb", "safety_reserve_mb", "full_image_passes", "detail_crops", "image_audit"]) {
        const value = raw[key];
        if (typeof value === "string") clean[key] = value.slice(0, 200);
        else if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
        else if (typeof value === "boolean") clean[key] = value;
    }
    if (raw.dataset_guidance && typeof raw.dataset_guidance === "object" && !Array.isArray(raw.dataset_guidance)) {
        try { clean.dataset_guidance = normalizeDatasetGuidanceState(raw.dataset_guidance); }
        catch { /* Older history rows may predate dataset-guidance receipts. */ }
    }
    return clean;
}

function isMetadataPlusOwner(currentUserId, configuredOwnerUserId) {
    const current = String(currentUserId || "").trim();
    const configured = String(configuredOwnerUserId || "").trim();
    return /^\d{5,25}$/.test(current) && current === configured;
}

function metadataProbeCacheKey(provenance) {
    if (!provenance?.kind || !provenance?.attachmentChannelId || !provenance?.attachmentId || !provenance?.path) return null;
    return `${provenance.kind}:${provenance.attachmentChannelId}:${provenance.attachmentId}:${provenance.path}`;
}

function hasExcludedImageContext(image, messageRoot) {
    const alt = `${image?.alt || ""} ${image?.getAttribute?.("aria-label") || ""}`;
    if (/avatar|emoji|sticker|reaction|badge|server icon|role icon/i.test(alt)) return true;

    let current = image;
    for (let depth = 0; current && current !== messageRoot && depth < 6; depth += 1) {
        const classText = typeof current.className === "string" ? current.className : "";
        if (EXCLUDED_CONTEXT_RE.test(classText)) return true;
        current = current.parentElement;
    }
    return false;
}

function hasSpoilerContext(image, messageRoot) {
    let current = image;
    for (let depth = 0; current && current !== messageRoot && depth < 10; depth += 1) {
        const classText = typeof current.className === "string" ? current.className : "";
        if (/spoiler/i.test(classText)) return true;
        current = current.parentElement;
    }
    return false;
}

class Krea2DiscordCollector {
    constructor() {
        this.api = null;
        this.settings = {...DEFAULT_SETTINGS};
        this.sentHashes = new Set();
        this.sentHashOrder = [];
        this.diagnosticSummaries = [];
        this.inflightByHash = new Map();
        this.controllers = new Set();
        this.buttons = new Set();
        this.buttonByImage = new WeakMap();
        this.visionButtons = new Set();
        this.visionButtonByImage = new WeakMap();
        this.originalCache = new Map();
        this.metadataProbeByKey = new Map();
        this.metadataProbeQueue = Promise.resolve();
        this.visionFlowQueue = Promise.resolve();
        this.visionQueue = Promise.resolve();
        this.visionInflightByRequest = new Map();
        this.localVisionSubmissions = new Map();
        this.localVisionSubmissionTimers = new Map();
        this.pendingOperationalErrors = [];
        this.operationalErrorFlush = null;
        this.imageLoadHandlers = new Map();
        this.observer = null;
        this.scanFrame = null;
        this.scanTimer = null;
        this.routeTimer = null;
        this.onboardingTimer = null;
        this.shortcutHandler = null;
        this.historyPollTimer = null;
        this.historyRequestController = null;
        this.historySearchTimer = null;
        this.historyRoot = null;
        this.historyJobs = [];
        this.historySummary = null;
        this.historyScheduler = null;
        this.historyPage = 1;
        this.historyPagination = {page: 1, page_size: HISTORY_PAGE_SIZE, total_items: 0, total_pages: 1, has_previous: false, has_next: false};
        this.historyFilter = "recent";
        this.historySearch = "";
        this.historyModelFilter = "all";
        this.historyFavoritesOnly = false;
        this.interrogateSelection = null;
        this.interrogatePreviewUrl = null;
        this.interrogateModels = [];
        this.interrogateModelsLoading = false;
        this.interrogateModelsError = "";
        this.interrogateSelectedModel = "";
        this.interrogateIdentityNote = "";
        this.interrogatePreparing = false;
        this.interrogatePendingCount = 0;
        this.interrogateStatus = "Choose a PNG, JPEG, or WebP image to begin.";
        this.interrogateStatusState = "idle";
        this.historyLoading = false;
        this.historyError = "";
        this.historyFavorites = new Set();
        this.editedPrompts = {};
        this.historyStatusById = new Map();
        this.lastCompletionJobId = "";
        this.historyOriginalPaths = new Map();
        this.historyThumbnailUrls = new Map();
        this.historyThumbnailLoads = new Map();
        this.visualEmbeddingCache = new Map();
        this.batchSelected = new Set();
        this.batchItems = [];
        this.batchPaused = false;
        this.batchRunning = false;
        this.historyReviews = {};
        this.modelEvaluations = {};
        this.promptFeedback = {};
        this.historyReviewFilter = "all";
        this.contextMenuUnpatches = [];
        this.lastContextImage = null;
        this.contextTargetHandler = null;
        this.historyResizeCleanup = null;
        this.historyModalCleanup = null;
        this.lastPathname = "";
        this.running = false;
        this.generation = 0;
        this.channelStore = null;
        this.userStore = null;
    }

    start() {
        this.api = new BdApi(PLUGIN_NAME);
        const storedSettings = this.api.Data.load("settings") || {};
        this.settings = {...DEFAULT_SETTINGS, ...storedSettings};
        // Releases before 0.13.4 exposed an obsolete direct-upload endpoint and
        // token. Contributions now pass only through the authenticated loopback
        // Vision broker, so never retain or reuse those legacy values.
        delete this.settings.endpoint;
        delete this.settings.token;
        this.settings.visionExecutionMode = normalizeVisionExecutionMode(this.settings.visionExecutionMode);
        this.settings.shareDatasetContributions = this.settings.shareDatasetContributions === true;
        this.settings.shareFailureDiagnostics = this.settings.shareFailureDiagnostics === true;
        this.settings.historyCollapsed = this.settings.historyCollapsed === true;
        this.settings.useKrea2DatasetGuidance = this.settings.useKrea2DatasetGuidance === true;
        this.settings.historyWidth = Math.min(440, Math.max(268, Math.trunc(Number(this.settings.historyWidth) || 330)));
        if (
            Object.prototype.hasOwnProperty.call(storedSettings, "endpoint")
            || Object.prototype.hasOwnProperty.call(storedSettings, "token")
        ) this.api.Data.save("settings", this.settings);
        const onboardingState = this.api.Data.load("onboardingState");
        const privacyReceipt = this.api.Data.load("privacyReceipt");
        if (
            this.settings.shareDatasetContributions === true
            && !isCurrentPrivacyReceipt(privacyReceipt)
            && onboardingState?.contributionTermsVersion === KREA2_CONTRIBUTION_TERMS_VERSION
            && Number(onboardingState?.completedAt) > 0
        ) {
            this.api.Data.save("privacyReceipt", {
                version: PRIVACY_RECEIPT_VERSION,
                acceptedAt: Number(onboardingState.completedAt)
            });
        }
        // User-derived content is session-only. Clear legacy plugin records left by
        // older releases and never reload hashes, prompts, reviews, or feedback.
        for (const key of ["sentHashes", "diagnosticSummaries", "historyFavorites", "editedPrompts", "historyReviews", "modelEvaluations", "promptFeedback"]) {
            try { this.api.Data.delete?.(key); }
            catch {}
        }
        this.sentHashOrder = [];
        this.sentHashes = new Set(this.sentHashOrder);
        this.diagnosticSummaries = [];
        this.historyFavorites = new Set();
        this.editedPrompts = {};
        this.historyReviews = {};
        this.modelEvaluations = {};
        this.promptFeedback = {};
        this.historyReviewFilter = "all";
        this.channelStore = this.api.Webpack.getStore("ChannelStore") || null;
        this.userStore = this.api.Webpack.getStore("UserStore") || null;
        this.running = true;
        this.generation += 1;
        this.api.Data.save("runtimeState", {
            version: PLUGIN_VERSION,
            startedAt: Date.now(),
            productSuite: true,
            sharedQueueOnly: true
        });
        this.installStyle();
        if (
            !onboardingState
            || Number(onboardingState.version) < ONBOARDING_VERSION
            || onboardingState.contributionTermsVersion !== KREA2_CONTRIBUTION_TERMS_VERSION
        ) {
            this.onboardingTimer = setTimeout(() => {
                this.onboardingTimer = null;
                if (this.running) void this.openOnboarding();
            }, 1200);
        }
        this.installContextMenus();
        this.ensureHistoryRail();
        void this.refreshHistory();
        this.historyPollTimer = setInterval(() => {
            if (this.historyRoot?.isConnected && this.settings.historyCollapsed !== true) void this.refreshHistory();
        }, HISTORY_POLL_MS);
        this.observer = new MutationObserver(mutations => {
            const hasPotentialMessageImage = mutations.some(mutation => {
                if (mutation.type === "attributes") return mutation.target instanceof HTMLImageElement;
                return [...mutation.addedNodes].some(node =>
                    node.nodeType === Node.ELEMENT_NODE &&
                    (node.matches?.("img") || node.querySelector?.("img"))
                );
            });
            if (hasPotentialMessageImage) this.scheduleScan();
        });
        this.observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["src", "href"]
        });

        this.lastPathname = location.pathname;
        this.routeTimer = setInterval(() => {
            if (location.pathname === this.lastPathname) return;
            this.lastPathname = location.pathname;
            this.removeAllButtons();
            this.scheduleScan();
            this.ensureHistoryRail();
            void this.refreshHistory();
        }, 1000);

        this.scheduleScan();
        this.log("info", "Started. Images appear only in guild IDs listed in plugin settings.");
    }

    stop() {
        this.running = false;
        this.generation += 1;
        this.observer?.disconnect();
        this.observer = null;

        if (this.scanFrame !== null) cancelAnimationFrame(this.scanFrame);
        this.scanFrame = null;
        if (this.scanTimer !== null) clearTimeout(this.scanTimer);
        this.scanTimer = null;
        if (this.routeTimer !== null) clearInterval(this.routeTimer);
        this.routeTimer = null;
        if (this.onboardingTimer !== null) clearTimeout(this.onboardingTimer);
        this.onboardingTimer = null;
        if (this.shortcutHandler) window.removeEventListener("keydown", this.shortcutHandler);
        this.shortcutHandler = null;
        this.removeContextMenus();
        if (this.historyPollTimer !== null) clearInterval(this.historyPollTimer);
        this.historyPollTimer = null;
        if (this.historySearchTimer !== null) clearTimeout(this.historySearchTimer);
        this.historySearchTimer = null;
        this.historyRequestController?.abort();
        this.historyRequestController = null;
        this.historyResizeCleanup?.();
        this.historyResizeCleanup = null;
        this.historyModalCleanup?.();
        this.historyModalCleanup = null;
        for (const objectUrl of this.historyThumbnailUrls.values()) this.revokeObjectUrl(objectUrl);
        this.historyOriginalPaths.clear();
        this.historyThumbnailUrls.clear();
        this.historyThumbnailLoads.clear();
        for (const timer of this.localVisionSubmissionTimers.values()) clearTimeout(timer);
        this.localVisionSubmissionTimers.clear();
        this.pendingOperationalErrors = [];
        this.localVisionSubmissions.clear();
        if (this.interrogatePreviewUrl) this.revokeObjectUrl(this.interrogatePreviewUrl);
        this.interrogatePreviewUrl = null;
        this.interrogateSelection = null;
        this.interrogateModels = [];
        this.interrogateIdentityNote = "";
        this.interrogatePendingCount = 0;
        this.visualEmbeddingCache.clear();
        this.batchSelected.clear();
        this.batchItems = [];
        this.historyRoot?.remove();
        this.historyRoot = null;
        document.getElementById(HISTORY_ROOT_ID)?.remove();
        document.getElementById(HISTORY_MODAL_ID)?.remove();
        document.getElementById(PRODUCT_MODAL_ID)?.remove();
        document.getElementById(ONBOARDING_MODAL_ID)?.remove();
        for (const controller of this.controllers) controller.abort();
        this.controllers.clear();
        this.inflightByHash.clear();
        this.originalCache.clear();
        this.metadataProbeByKey.clear();
        this.visionInflightByRequest.clear();

        for (const [image, handler] of this.imageLoadHandlers) image.removeEventListener("load", handler);
        this.imageLoadHandlers.clear();
        this.removeAllButtons();
        this.buttonByImage = new WeakMap();
        this.visionButtonByImage = new WeakMap();
        document.getElementById(STYLE_ID)?.remove();
        this.log("info", "Stopped and removed collector UI.");
    }

    installStyle() {
        document.getElementById(STYLE_ID)?.remove();
        const style = Object.assign(document.createElement("style"), {id: STYLE_ID, textContent: CSS});
        document.head.append(style);
    }

    installContextMenus() {
        this.removeContextMenus();
        this.contextTargetHandler = event => {
            const image = event.target?.closest?.("img");
            this.lastContextImage = image && this.isEligibleImage(image) ? {image, at: Date.now()} : null;
        };
        document.addEventListener("contextmenu", this.contextTargetHandler, true);
        const menu = this.api.ContextMenu;
        if (!menu?.patch || !menu?.buildItem) return;
        const patchMenu = navId => {
            try {
                const unpatch = menu.patch(navId, tree => {
                    const recent = this.lastContextImage;
                    const image = recent && Date.now() - recent.at < 3000 && recent.image?.isConnected ? recent.image : null;
                    if (!image || !this.isEligibleImage(image)) return;
                    this.enhanceImage(image);
                    const visionButton = this.visionButtonByImage.get(image);
                    const items = [
                        {label: "Describe image", action: () => visionButton && this.queueVisionAnalysis(image, visionButton)},
                        {label: "Open Prompt History", action: () => this.setHistoryCollapsed(false)}
                    ];
                    const item = menu.buildItem({type: "submenu", label: "KREA2 Vision", items});
                    const findChildren = node => {
                        if (!node || typeof node !== "object") return null;
                        if (Array.isArray(node)) return node;
                        const children = node.props?.children;
                        if (Array.isArray(children)) return children;
                        if (children) {
                            const found = findChildren(children);
                            if (found) return found;
                        }
                        return null;
                    };
                    findChildren(tree)?.push(item);
                });
                if (typeof unpatch === "function") this.contextMenuUnpatches.push(unpatch);
            }
            catch (error) { this.log("warning", `Context menu ${navId} could not be patched: ${error instanceof Error ? error.message : String(error)}`); }
        };
        for (const navId of ["message", "image-context"]) patchMenu(navId);
    }

    removeContextMenus() {
        if (this.contextTargetHandler) document.removeEventListener("contextmenu", this.contextTargetHandler, true);
        this.contextTargetHandler = null;
        this.lastContextImage = null;
        for (const unpatch of this.contextMenuUnpatches || []) {
            try { unpatch(); }
            catch {}
        }
        this.contextMenuUnpatches = [];
    }

    async openOnboarding() {
        document.getElementById(ONBOARDING_MODAL_ID)?.remove();
        const overlay = document.createElement("div");
        overlay.id = ONBOARDING_MODAL_ID;
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-labelledby", "krea2-onboarding-title");

        const dialog = document.createElement("section");
        dialog.className = "krea2-onboarding-dialog";
        const head = document.createElement("header");
        head.className = "krea2-onboarding-head";
        const headingCopy = document.createElement("div");
        const eyebrow = document.createElement("div");
        eyebrow.className = "krea2-onboarding-eyebrow";
        eyebrow.textContent = "First-time setup";
        const heading = document.createElement("h2");
        heading.id = "krea2-onboarding-title";
        heading.textContent = "Choose where Vision runs";
        const intro = document.createElement("p");
        intro.textContent = "Use an installed model on this computer, or send the request through the authenticated local broker to the private online Gemma worker. The remote address and provider credential are never stored in BetterDiscord. Prompt History and generated prompts remain in the private local Vision database until you choose Clear history. Small local thumbnails are kept under the configured save folder for matching previews; full-resolution source images are not copied into history.";
        headingCopy.append(eyebrow, heading, intro);
        const close = document.createElement("button");
        close.type = "button";
        close.className = "krea2-onboarding-close";
        close.setAttribute("aria-label", "Close setup for now");
        close.title = "Close for now; setup will return next startup";
        close.textContent = "×";
        head.append(headingCopy, close);

        const body = document.createElement("div");
        body.className = "krea2-onboarding-body";
        const note = document.createElement("div");
        note.className = "krea2-onboarding-note";
        const noteStrong = document.createElement("strong");
        noteStrong.textContent = "Heretic models and project guardrails. ";
        const noteText = document.createTextNode("These model variants are designed not to refuse an image-description or prompt request. KREA2 Vision still applies its own local input validation, output-format and quality checks, shared-GPU admission checks, and security limits. If the backend is unavailable, use the Repair KREA2 Vision Suite shortcut created on your desktop. Optional buttons below open the exact revision-pinned body and matching projector downloads; both files are required. Technical failures are automatically sent to the owner-only Seedframe error console with an anonymous installation digest, model, pipeline, stage, error and software versions. Mandatory error telemetry never contains image bytes or hashes, prompts, Discord identity or IDs, URLs, filenames, or local paths. Optional rich failure diagnostics remain a separate opt-in setting.");
        note.append(noteStrong, noteText);

        const contributionChoice = document.createElement("label");
        contributionChoice.className = "krea2-onboarding-server";
        const contributionCheckbox = document.createElement("input");
        contributionCheckbox.type = "checkbox";
        contributionCheckbox.checked = this.settings.shareDatasetContributions === true;
        const contributionCopy = document.createElement("div");
        const contributionTitle = document.createElement("strong");
        contributionTitle.textContent = "Contribute my three generated prompts to Krea2";
        const contributionHelp = document.createElement("span");
        contributionHelp.append(
            document.createTextNode("Optional. When enabled, every successful Vision request contributes its three generated prompt texts to Seedframe's Krea2 dataset. It sends only prompt text, model/pipeline context, and an anonymous installation digest. No image bytes, image hashes, Discord IDs, Discord URLs, filenames, or local paths are sent. Entries remain review-required and are not training-ready until curated. ")
        );
        const contributionTermsLink = document.createElement("a");
        contributionTermsLink.href = "https://seedframe.xyz/policies/terms";
        contributionTermsLink.target = "_blank";
        contributionTermsLink.rel = "noopener noreferrer";
        contributionTermsLink.textContent = "Read the Seedframe Terms ↗";
        contributionTermsLink.addEventListener("click", event => event.stopPropagation());
        contributionHelp.append(contributionTermsLink);
        contributionCopy.append(contributionTitle, contributionHelp);
        contributionChoice.append(contributionCheckbox, contributionCopy);

        const verifiedRoute = this.getChannelVerifiedRoute();
        const serverChoice = document.createElement("label");
        serverChoice.className = "krea2-onboarding-server";
        const serverCheckbox = document.createElement("input");
        serverCheckbox.type = "checkbox";
        serverCheckbox.checked = Boolean(verifiedRoute);
        serverCheckbox.disabled = !verifiedRoute;
        const serverCopy = document.createElement("div");
        const serverTitle = document.createElement("strong");
        serverTitle.textContent = verifiedRoute
            ? `Enable image buttons in this server (${verifiedRoute.guildId})`
            : "Open a server channel to enable image buttons";
        const serverHelp = document.createElement("span");
        serverHelp.textContent = verifiedRoute
            ? "Only explicitly allowed server IDs receive the in-memory Vision action."
            : "Direct messages and unverified routes cannot be added to the server allowlist.";
        serverCopy.append(serverTitle, serverHelp);
        serverChoice.append(serverCheckbox, serverCopy);

        let executionMode = normalizeVisionExecutionMode(this.settings.visionExecutionMode);
        const modeChoice = document.createElement("div");
        modeChoice.className = "krea2-onboarding-execution";
        const localMode = document.createElement("button");
        localMode.type = "button";
        localMode.className = "krea2-onboarding-mode";
        localMode.innerHTML = "<strong>Local GPU</strong>Use an installed model and the exact shared Forge FIFO.";
        const onlineMode = document.createElement("button");
        onlineMode.type = "button";
        onlineMode.className = "krea2-onboarding-mode";
        onlineMode.innerHTML = "<strong>Online API</strong>Use Gemma 4 26B-A4B on the private 24 GB worker.";
        modeChoice.append(localMode, onlineMode);
        const onlineNotice = document.createElement("div");
        onlineNotice.className = "krea2-onboarding-online";

        const vramBar = document.createElement("div");
        vramBar.className = "krea2-onboarding-vram";
        const grid = document.createElement("div");
        grid.className = "krea2-onboarding-grid";
        const status = document.createElement("div");
        status.className = "krea2-onboarding-status";
        status.setAttribute("aria-live", "polite");
        const actions = document.createElement("div");
        actions.className = "krea2-onboarding-actions";
        const later = document.createElement("button");
        later.type = "button";
        later.className = "krea2-onboarding-action";
        later.textContent = "Not now";
        later.title = "Setup will appear again the next time the plugin starts";
        const save = document.createElement("button");
        save.type = "button";
        save.className = "krea2-onboarding-action";
        save.dataset.primary = "true";
        save.textContent = "Save selected model";
        save.disabled = true;
        contributionCheckbox.addEventListener("change", () => {
            render();
        });
        actions.append(later, save);
        body.append(note, contributionChoice, serverChoice, modeChoice, onlineNotice, vramBar, grid, status, actions);
        dialog.append(head, body);
        overlay.append(dialog);
        document.body.append(overlay);

        let selected = HERETIC_MODEL_SPECS.some(model => model.public_id === this.settings.visionModel)
            ? this.settings.visionModel
            : DEFAULT_SETTINGS.visionModel;
        let models = mergeHereticModelTelemetry(null);
        let onlineAvailable = null;
        let refreshing = false;
        const installStatuses = new Map();
        let installPollToken = 0;

        const dismiss = () => {
            installPollToken += 1;
            overlay.remove();
        };
        const monitorInstall = async publicId => {
            const token = ++installPollToken;
            while (overlay.isConnected && token === installPollToken) {
                try {
                    const current = await this.fetchVisionModelInstallStatus(publicId);
                    installStatuses.set(publicId, current);
                    status.textContent = `${current.stage || "Installing model pair"}${current.bytes_total ? ` — ${Number(current.progress_percent || 0).toFixed(1)}%` : ""}`;
                    render();
                    if (["completed", "error"].includes(current.state)) {
                        if (current.state === "completed") {
                            status.textContent = "Model body and projector are installed together and SHA-256 verified.";
                            await refreshTelemetry();
                        }
                        else status.textContent = current.error || "Model pair installation stopped.";
                        return;
                    }
                }
                catch (error) {
                    status.textContent = error instanceof Error ? error.message : String(error);
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        };
        const render = () => {
            if (!overlay.isConnected) return;
            const usesLocalGpu = executionMode === "local";
            localMode.dataset.selected = String(usesLocalGpu);
            onlineMode.dataset.selected = String(!usesLocalGpu);
            vramBar.dataset.disabled = String(!usesLocalGpu);
            grid.dataset.disabled = String(!usesLocalGpu);
            onlineNotice.dataset.visible = String(!usesLocalGpu);
            onlineNotice.replaceChildren();
            const onlineStrong = document.createElement("strong");
            onlineStrong.textContent = "Gemma 4 26B-A4B Heretic Q3_K_L — remote serverless. ";
            const onlineState = onlineAvailable === true
                ? "The local broker reports the private worker is configured and ready. No local model or VRAM is used."
                : onlineAvailable === false
                    ? "The local broker is reachable, but its private remote worker is not configured. Online requests will remain unavailable until the operator adds credentials."
                    : "Start or refresh the local Vision broker to verify private worker availability. No provider address or credential is exposed to BetterDiscord.";
            onlineNotice.append(onlineStrong, document.createTextNode(onlineState));
            save.textContent = usesLocalGpu ? "Save selected local model" : "Save Online API";
            save.disabled = !usesLocalGpu && onlineAvailable !== true;
            grid.replaceChildren();
            const available = models.find(model => model.available_vram_mb !== null)?.available_vram_mb ?? null;
            const total = models.find(model => model.total_vram_mb !== null)?.total_vram_mb ?? null;
            vramBar.replaceChildren();
            const liveSummary = document.createElement("span");
            const liveStrong = document.createElement("strong");
            liveStrong.textContent = available === null ? "Live VRAM unavailable" : `${formatVramMiB(available)} available`;
            liveSummary.append(liveStrong, document.createTextNode(total === null ? " — start Vision Studio to check capacity" : ` of ${formatVramMiB(total)} total`));
            const reserveSummary = document.createElement("span");
            reserveSummary.textContent = "Each admission requirement includes a separate 4,096 MiB safety reserve. A bounded 64 MiB NVML observation tolerance does not reduce that reserve.";
            const refresh = document.createElement("button");
            refresh.type = "button";
            refresh.className = "krea2-onboarding-refresh";
            refresh.disabled = refreshing || !usesLocalGpu;
            refresh.textContent = refreshing ? "Checking…" : "Check VRAM again";
            refresh.addEventListener("click", () => void refreshTelemetry());
            vramBar.append(liveSummary, reserveSummary, refresh);

            for (const model of models) {
                const card = document.createElement("label");
                card.className = "krea2-onboarding-card";
                card.dataset.selected = String(model.public_id === selected);
                const radio = document.createElement("input");
                radio.type = "radio";
                radio.name = "krea2-onboarding-model";
                radio.value = model.public_id;
                radio.checked = model.public_id === selected;
                radio.disabled = !usesLocalGpu;
                radio.addEventListener("change", () => { selected = model.public_id; render(); });
                const title = document.createElement("h3");
                title.textContent = model.short_label;
                const meta = document.createElement("div");
                meta.className = "krea2-onboarding-modelmeta";
                meta.textContent = model.public_id === DEFAULT_SETTINGS.visionModel
                    ? "8B · recommended default"
                    : model.parameter_size_b <= 2
                        ? "2B · smallest and fastest"
                        : model.parameter_size_b <= 4
                            ? "4B · balanced"
                            : `${model.parameter_size_b}B · larger detail model`;
                const install = document.createElement("div");
                install.className = "krea2-onboarding-install";
                const installState = document.createElement("strong");
                installState.textContent = model.telemetry_live ? "Installed and verified" : "Not detected locally";
                const downloadSize = document.createElement("span");
                downloadSize.textContent = `${formatDownloadGiB(model.download_bytes)} total download`;
                install.append(installState, downloadSize);
                const metrics = document.createElement("div");
                metrics.className = "krea2-onboarding-metrics";
                for (const [label, value] of [
                    ["Context cap", Number.isFinite(Number(model.context_cap)) ? `${Number(model.context_cap).toLocaleString()} tokens` : "Unavailable"],
                    ["Estimate", formatVramMiB(model.estimated_vram_mb)],
                    ["Measured peak", formatVramMiB(model.last_measured_peak_mb)],
                    ["Safety reserve", formatVramMiB(model.safety_reserve_mb)],
                    ["NVML tolerance", formatVramMiB(model.admission_tolerance_mb)],
                    ["Admission", formatVramMiB(model.admission_required_mb)]
                ]) {
                    const metric = document.createElement("div");
                    metric.className = "krea2-onboarding-metric";
                    const metricLabel = document.createElement("span");
                    metricLabel.textContent = label;
                    const metricValue = document.createElement("strong");
                    metricValue.textContent = value;
                    metric.append(metricLabel, metricValue);
                    metrics.append(metric);
                }
                const admission = document.createElement("div");
                admission.className = "krea2-onboarding-admission";
                const passes = model.telemetry_live && model.admission_passes_now === true;
                admission.dataset.pass = String(passes);
                admission.textContent = !model.telemetry_live
                    ? "Live capacity unknown — install/start the local Vision backend"
                    : passes
                        ? "Can run now at the reported free VRAM"
                        : "Not enough free VRAM now — the shared queue will wait and recheck";
                card.append(radio, title, meta, install, metrics, admission);
                if (model.over_allocation_target) {
                    const warning = document.createElement("div");
                    warning.className = "krea2-onboarding-target-warning";
                    warning.textContent = "This model exceeds the 12 GiB model-allocation target. It remains selectable when the authoritative post-Forge-unload check passes.";
                    card.append(warning);
                }
                const downloads = document.createElement("div");
                downloads.className = "krea2-onboarding-downloads";
                const pairInstall = document.createElement("button");
                pairInstall.type = "button";
                pairInstall.className = "krea2-onboarding-download";
                const installStatus = installStatuses.get(model.public_id);
                const activeInstall = ["queued", "downloading", "verifying"].includes(installStatus?.state);
                pairInstall.disabled = activeInstall || !usesLocalGpu;
                pairInstall.textContent = activeInstall
                    ? `${installStatus.stage || "Installing pair"} · ${Number(installStatus.progress_percent || 0).toFixed(1)}%`
                    : model.telemetry_live
                        ? "Verify installed model + projector"
                        : "Install model + projector together";
                pairInstall.addEventListener("click", async event => {
                    event.preventDefault();
                    event.stopPropagation();
                    pairInstall.disabled = true;
                    status.textContent = `Preparing ${model.short_label} body and projector…`;
                    try {
                        const started = await this.startVisionModelInstall(model.public_id);
                        installStatuses.set(model.public_id, started);
                        render();
                        void monitorInstall(model.public_id);
                    }
                    catch (error) {
                        status.textContent = error instanceof Error ? error.message : String(error);
                        pairInstall.disabled = false;
                    }
                });
                downloads.append(pairInstall);
                card.append(downloads);
                const link = document.createElement("a");
                link.className = "krea2-onboarding-link";
                link.href = model.model_card_url;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                link.textContent = "Read model card and license ↗";
                link.addEventListener("click", event => event.stopPropagation());
                card.append(link);
                grid.append(card);
            }
        };

        localMode.addEventListener("click", () => {
            executionMode = "local";
            status.textContent = "Local GPU selected. Choose an installed model below.";
            render();
        });
        onlineMode.addEventListener("click", () => {
            executionMode = "online";
            status.textContent = onlineAvailable === true
                ? "Online API selected. The private Gemma worker will be used through the local authenticated broker."
                : "Online API selected. Refreshing the local broker status now…";
            render();
            if (onlineAvailable === null) void refreshTelemetry();
        });

        const refreshTelemetry = async () => {
            if (refreshing) return;
            refreshing = true;
            status.textContent = "Checking the local Vision backend and current GPU capacity…";
            render();
            try {
                const payload = await this.fetchProductJson("/api/discord-models");
                models = mergeHereticModelTelemetry(payload);
                onlineAvailable = Array.isArray(payload?.models) && payload.models.some(model =>
                    String(model?.public_id || "") === ONLINE_VISION_MODEL_ID && model?.admission_passes_now === true
                );
                const available = models.find(model => model.available_vram_mb !== null)?.available_vram_mb;
                status.textContent = executionMode === "online"
                    ? onlineAvailable
                        ? "Online API ready: the private Gemma worker is configured through the local broker."
                        : "Online API is not configured on this local broker."
                    : available == null
                        ? "The backend responded, but current GPU memory was unavailable."
                        : `Live capacity updated: ${formatVramMiB(available)} currently available.`;
            }
            catch (error) {
                models = mergeHereticModelTelemetry(null);
                onlineAvailable = null;
                status.textContent = `Vision backend is not available yet. You can still choose a model now; finish the local setup before using it. ${error instanceof Error ? error.message : String(error)}`;
            }
            finally {
                refreshing = false;
                render();
            }
        };

        close.addEventListener("click", dismiss);
        later.addEventListener("click", dismiss);
        save.addEventListener("click", () => {
            if (executionMode === "online" && onlineAvailable !== true) {
                status.textContent = "Online API is not configured on this local broker. Choose Local GPU or ask the operator to configure a private worker.";
                render();
                return;
            }
            this.settings.visionExecutionMode = executionMode;
            this.settings.visionModel = selected;
            this.settings.shareDatasetContributions = contributionCheckbox.checked;
            if (contributionCheckbox.checked) {
                this.api.Data.save("privacyReceipt", {version: PRIVACY_RECEIPT_VERSION, acceptedAt: Date.now()});
            }
            else {
                this.api.Data.delete?.("privacyReceipt");
                this.api.Data.save("privacyReceipt", null);
            }
            if (serverCheckbox.checked && verifiedRoute) {
                const ids = parseGuildAllowlist(this.settings.allowedGuildIds);
                ids.add(verifiedRoute.guildId);
                this.settings.allowedGuildIds = [...ids].join(", ");
            }
            this.saveSettings();
            const completedAt = Date.now();
            this.api.Data.save("onboardingState", {
                version: ONBOARDING_VERSION,
                completedAt,
                model: selected,
                executionMode,
                contributionTermsVersion: KREA2_CONTRIBUTION_TERMS_VERSION
            });
            const runtime = this.api.Data.load("runtimeState") || {};
            this.api.Data.save("runtimeState", {...runtime, onboardingCompletedAt: completedAt, onboardingModel: selected});
            const selectedLabel = executionMode === "online"
                ? "Online API · Gemma 4 26B-A4B"
                : HERETIC_MODEL_SPECS.find(model => model.public_id === selected)?.short_label || selected;
            this.toast(
                `Setup complete. ${selectedLabel} selected; automatic three-prompt contribution ${contributionCheckbox.checked ? "enabled" : "disabled"}.`,
                "success"
            );
            dismiss();
        });
        const runtime = this.api.Data.load("runtimeState") || {};
        this.api.Data.save("runtimeState", {...runtime, onboardingOpenedAt: Date.now()});
        render();
        await refreshTelemetry();
    }

    scheduleScan() {
        if (!this.running || this.scanFrame !== null || this.scanTimer !== null) return;
        this.scanTimer = setTimeout(() => {
            this.scanTimer = null;
            if (!this.running || this.scanFrame !== null) return;
            this.scanFrame = requestAnimationFrame(() => {
                this.scanFrame = null;
                this.scan();
            });
        }, 160);
    }

    ensureHistoryRail() {
        if (!this.running || !document.body) return;
        if (this.historyRoot?.isConnected && this.historyRoot.parentElement === document.body) return;
        this.historyRoot?.remove();
        document.getElementById(HISTORY_ROOT_ID)?.remove();
        const root = this.createHistoryRail();
        root.dataset.floating = "true";
        root.dataset.detached = "true";
        document.body.append(root);
        this.historyRoot = root;
        this.renderHistoryRail(root);
    }

    createHistoryRail() {
        const root = document.createElement("aside");
        root.id = HISTORY_ROOT_ID;
        root.dataset.collapsed = this.settings.historyCollapsed ? "true" : "false";
        root.dataset.floating = "true";
        root.style.setProperty("--krea2-history-width", `${this.settings.historyWidth}px`);
        root.setAttribute("aria-label", "KREA2 prompt history");

        const collapsed = document.createElement("button");
        collapsed.type = "button";
        collapsed.className = "krea2-history-collapse-launcher krea2-history-collapsed";
        collapsed.title = "Open KREA2 prompt history";
        collapsed.setAttribute("aria-label", collapsed.title);
        collapsed.append(document.createTextNode("◀"), document.createTextNode("PROMPT HISTORY"));
        collapsed.addEventListener("click", () => this.setHistoryCollapsed(false));

        const expanded = document.createElement("div");
        expanded.className = "krea2-history-expanded";
        expanded.style.cssText = "display:flex;min-height:0;flex:1;flex-direction:column";

        const header = document.createElement("header");
        header.className = "krea2-history-header";
        const heading = document.createElement("div");
        heading.className = "krea2-history-heading";
        const title = document.createElement("div");
        title.className = "krea2-history-title";
        title.textContent = "Prompt History";
        const subtitle = document.createElement("div");
        subtitle.className = "krea2-history-subtitle";
        subtitle.textContent = "All local Vision jobs";
        heading.append(title, subtitle);
        const actions = document.createElement("div");
        actions.className = "krea2-history-actions";
        const refresh = document.createElement("button");
        refresh.type = "button";
        refresh.className = "krea2-history-icon";
        refresh.textContent = "↻";
        refresh.title = "Refresh prompt history";
        refresh.setAttribute("aria-label", refresh.title);
        refresh.addEventListener("click", () => void this.refreshHistory(true));
        const close = document.createElement("button");
        close.type = "button";
        close.className = "krea2-history-icon";
        close.textContent = "×";
        close.title = "Collapse Prompt History";
        close.setAttribute("aria-label", close.title);
        close.addEventListener("click", () => {
            this.setHistoryCollapsed(true);
        });
        actions.append(refresh, close);
        header.append(heading, actions);

        const summary = document.createElement("div");
        summary.className = "krea2-history-summary";
        summary.dataset.role = "summary";
        const averageQueue = document.createElement("div");
        averageQueue.className = "krea2-history-average-queue";
        averageQueue.dataset.role = "average-queue";
        averageQueue.setAttribute("role", "status");
        const scheduler = document.createElement("div");
        scheduler.className = "krea2-history-scheduler";
        scheduler.dataset.role = "scheduler";

        const tabs = document.createElement("div");
        tabs.className = "krea2-history-tabs";
        tabs.setAttribute("role", "tablist");
        for (const [label, filter] of [["Interrogate", "interrogate"], ["Recent", "recent"], ["Done", "completed"], ["Queue", "queued"], ["Errors", "errors"]]) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "krea2-history-tab";
            button.dataset.filter = filter;
            button.textContent = label;
            button.setAttribute("role", "tab");
            button.setAttribute("aria-selected", filter === this.historyFilter ? "true" : "false");
            button.addEventListener("click", () => {
                this.historyFilter = filter;
                this.historyPage = 1;
                this.renderHistoryRail();
                if (filter !== "interrogate") void this.refreshHistory(true);
            });
            tabs.append(button);
        }

        const libraryTools = document.createElement("div");
        libraryTools.className = "krea2-history-library-tools";
        const search = document.createElement("input");
        search.type = "search";
        search.className = "krea2-history-search";
        search.placeholder = "Search prompts";
        search.value = this.historySearch;
        search.setAttribute("aria-label", "Search Vision prompt history");
        search.addEventListener("input", () => {
            this.historySearch = search.value;
            this.historyPage = 1;
            this.renderHistoryRail();
            if (this.historySearchTimer !== null) clearTimeout(this.historySearchTimer);
            this.historySearchTimer = setTimeout(() => {
                this.historySearchTimer = null;
                if (this.running) void this.refreshHistory(true);
            }, 250);
        });
        const modelFilter = document.createElement("select");
        modelFilter.className = "krea2-history-model-filter";
        modelFilter.setAttribute("aria-label", "Filter Vision history by model");
        for (const [label, value] of [["All models", "all"], ...VISION_MODEL_OPTIONS.map(([label, id]) => [label.replace(/^Heretic — /, "").split(" (")[0], id])]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            modelFilter.append(option);
        }
        modelFilter.value = this.historyModelFilter;
        modelFilter.addEventListener("change", () => {
            this.historyModelFilter = modelFilter.value;
            this.historyPage = 1;
            this.renderHistoryRail();
            void this.refreshHistory(true);
        });
        libraryTools.append(search, modelFilter);

        const completion = document.createElement("button");
        completion.type = "button";
        completion.className = "krea2-history-completion";
        completion.dataset.role = "completion";
        completion.hidden = true;
        completion.addEventListener("click", () => {
            const jobId = this.lastCompletionJobId;
            if (jobId) void this.openHistoryDetail(jobId);
        });

        const list = document.createElement("div");
        list.className = "krea2-history-list";
        list.dataset.role = "list";
        list.setAttribute("role", "tabpanel");
        const pagination = document.createElement("div");
        pagination.className = "krea2-history-pagination";
        pagination.dataset.role = "pagination";
        const interrogate = document.createElement("div");
        interrogate.className = "krea2-interrogate-panel";
        interrogate.dataset.role = "interrogate";
        interrogate.setAttribute("role", "tabpanel");
        this.buildInterrogatePanel(interrogate);
        expanded.append(header, summary, averageQueue, scheduler, tabs, libraryTools, completion, interrogate, list, pagination);

        const resizer = document.createElement("div");
        resizer.className = "krea2-history-resizer krea2-history-expanded";
        resizer.title = "Drag to resize prompt history";
        resizer.addEventListener("pointerdown", event => this.beginHistoryResize(event));
        root.append(resizer, collapsed, expanded);
        this.renderHistoryRail(root);
        return root;
    }

    buildInterrogatePanel(panel) {
        panel.replaceChildren();
        const card = document.createElement("section");
        card.className = "krea2-interrogate-card";

        const title = document.createElement("div");
        title.className = "krea2-interrogate-title";
        title.textContent = "Interrogate an image";
        const copy = document.createElement("div");
        copy.className = "krea2-interrogate-copy";
        copy.textContent = "Upload one image, choose the exact Vision model, and add it to the same authenticated shared queue used by Discord image magnifiers. Files remain in session memory.";

        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp";
        input.hidden = true;
        input.dataset.role = "interrogate-input";

        const drop = document.createElement("div");
        drop.className = "krea2-interrogate-drop";
        drop.tabIndex = 0;
        drop.setAttribute("role", "button");
        drop.setAttribute("aria-label", "Choose an image to interrogate");
        drop.dataset.role = "interrogate-drop";
        const preview = document.createElement("img");
        preview.className = "krea2-interrogate-preview";
        preview.alt = "Selected image preview";
        preview.hidden = true;
        preview.dataset.role = "interrogate-preview";
        const dropCopy = document.createElement("div");
        dropCopy.className = "krea2-interrogate-drop-copy";
        dropCopy.dataset.role = "interrogate-drop-copy";
        const dropStrong = document.createElement("strong");
        dropStrong.textContent = "Upload image";
        const dropHint = document.createElement("span");
        dropHint.textContent = "Click or drop PNG, JPEG, or WebP · 20 MiB max";
        dropCopy.append(dropStrong, dropHint);
        drop.append(preview, dropCopy);

        const fileRow = document.createElement("div");
        fileRow.className = "krea2-interrogate-file";
        fileRow.hidden = true;
        fileRow.dataset.role = "interrogate-file";
        const fileName = document.createElement("span");
        fileName.dataset.role = "interrogate-file-name";
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.title = "Remove selected image";
        remove.setAttribute("aria-label", remove.title);
        fileRow.append(fileName, remove);

        const field = document.createElement("div");
        field.className = "krea2-interrogate-field";
        const modelLabel = document.createElement("label");
        modelLabel.textContent = "Vision model";
        const model = document.createElement("select");
        model.className = "krea2-interrogate-model";
        model.dataset.role = "interrogate-model";
        model.setAttribute("aria-label", "Select the Vision model for this image");
        model.disabled = true;
        const loading = document.createElement("option");
        loading.textContent = "Loading verified models…";
        loading.value = "";
        model.append(loading);
        field.append(modelLabel, model);

        const noteField = document.createElement("div");
        noteField.className = "krea2-interrogate-field";
        const noteLabel = document.createElement("label");
        noteLabel.textContent = "Optional identity or role notes";
        const note = document.createElement("textarea");
        note.className = "krea2-interrogate-note";
        note.dataset.role = "interrogate-identity-note";
        note.maxLength = 400;
        note.rows = 3;
        note.placeholder = "Example: Subject A is a trans woman, she/her; Subject B is a man, he/him.";
        note.setAttribute("aria-label", "Optional uploader-supplied identity or role notes");
        const noteHelp = document.createElement("div");
        noteHelp.className = "krea2-interrogate-note-help";
        noteHelp.textContent = "Identity is never inferred from pixels or anatomy. This session-only note supplies known labels or pronouns; visible presentation, anatomy, pose and contacts remain image-grounded.";
        noteField.append(noteLabel, note, noteHelp);

        const actions = document.createElement("div");
        actions.className = "krea2-interrogate-actions";
        const start = document.createElement("button");
        start.type = "button";
        start.className = "krea2-interrogate-start";
        start.dataset.role = "interrogate-start";
        start.textContent = "Start interrogation";
        start.disabled = true;
        const refresh = document.createElement("button");
        refresh.type = "button";
        refresh.className = "krea2-interrogate-refresh";
        refresh.dataset.role = "interrogate-refresh";
        refresh.textContent = "↻";
        refresh.title = "Refresh installed models";
        refresh.setAttribute("aria-label", refresh.title);
        actions.append(start, refresh);

        const status = document.createElement("div");
        status.className = "krea2-interrogate-status";
        status.dataset.role = "interrogate-status";
        status.setAttribute("role", "status");
        const queue = document.createElement("div");
        queue.className = "krea2-interrogate-queue";
        queue.dataset.role = "interrogate-queue";

        const choose = () => {
            if (!this.interrogatePreparing) input.click();
        };
        drop.addEventListener("click", choose);
        drop.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                choose();
            }
        });
        for (const eventName of ["dragenter", "dragover"]) {
            drop.addEventListener(eventName, event => {
                event.preventDefault();
                drop.dataset.dragging = "true";
            });
        }
        for (const eventName of ["dragleave", "drop"]) {
            drop.addEventListener(eventName, event => {
                event.preventDefault();
                drop.dataset.dragging = "false";
            });
        }
        drop.addEventListener("drop", event => {
            const file = event.dataTransfer?.files?.[0];
            if (file) void this.selectInterrogateFile(file);
        });
        input.addEventListener("change", () => {
            const file = input.files?.[0];
            input.value = "";
            if (file) void this.selectInterrogateFile(file);
        });
        remove.addEventListener("click", () => {
            this.clearInterrogateSelection();
            this.interrogateStatus = "Choose a PNG, JPEG, or WebP image to begin.";
            this.interrogateStatusState = "idle";
            this.renderInterrogatePanel();
        });
        model.addEventListener("change", () => {
            this.interrogateSelectedModel = model.value;
            this.renderInterrogatePanel();
        });
        note.addEventListener("input", () => {
            this.interrogateIdentityNote = note.value.slice(0, 400);
        });
        refresh.addEventListener("click", () => void this.refreshInterrogateModels(true));
        start.addEventListener("click", () => void this.queueInterrogateSelection());

        card.append(title, copy, input, drop, fileRow, field, noteField, actions, status, queue);
        panel.append(card);
        this.renderInterrogatePanel(panel);
        if (!this.interrogateModels.length) void this.refreshInterrogateModels();
    }

    renderInterrogatePanel(panel = this.historyRoot?.querySelector('[data-role="interrogate"]')) {
        if (!panel) return;
        const preview = panel.querySelector('[data-role="interrogate-preview"]');
        const dropCopy = panel.querySelector('[data-role="interrogate-drop-copy"]');
        const fileRow = panel.querySelector('[data-role="interrogate-file"]');
        const fileName = panel.querySelector('[data-role="interrogate-file-name"]');
        const model = panel.querySelector('[data-role="interrogate-model"]');
        const note = panel.querySelector('[data-role="interrogate-identity-note"]');
        const start = panel.querySelector('[data-role="interrogate-start"]');
        const refresh = panel.querySelector('[data-role="interrogate-refresh"]');
        const status = panel.querySelector('[data-role="interrogate-status"]');
        const queue = panel.querySelector('[data-role="interrogate-queue"]');
        if (!preview || !dropCopy || !fileRow || !fileName || !model || !note || !start || !refresh || !status || !queue) return;

        const selection = this.interrogateSelection;
        preview.hidden = !selection || !this.interrogatePreviewUrl;
        if (selection && this.interrogatePreviewUrl) preview.src = this.interrogatePreviewUrl;
        else preview.removeAttribute("src");
        dropCopy.hidden = Boolean(selection);
        fileRow.hidden = !selection;
        fileName.textContent = selection
            ? `${selection.displayName} · ${(selection.bytes.byteLength / (1024 * 1024)).toFixed(1)} MiB · ${selection.format.kind.toUpperCase()}`
            : "";

        const currentOptions = [...model.options].map(option => option.value).filter(Boolean);
        const expectedOptions = this.interrogateModels.map(item => item.public_id);
        if (currentOptions.join("\u0000") !== expectedOptions.join("\u0000")) {
            model.replaceChildren();
            if (!this.interrogateModels.length) {
                const option = document.createElement("option");
                option.value = "";
                option.textContent = this.interrogateModelsLoading ? "Loading verified models…" : "No verified models available";
                model.append(option);
            }
            else {
                for (const item of this.interrogateModels) {
                    const option = document.createElement("option");
                    option.value = item.public_id;
                    const remote = item.local_gpu === false;
                    const estimate = Number(item.estimated_vram_mb || 0);
                    option.textContent = `${item.label}${remote ? " · Online API" : estimate ? ` · ${estimate.toLocaleString()} MiB` : ""}`;
                    model.append(option);
                }
            }
        }
        if (this.interrogateSelectedModel && expectedOptions.includes(this.interrogateSelectedModel)) model.value = this.interrogateSelectedModel;
        model.disabled = this.interrogateModelsLoading || !this.interrogateModels.length || this.interrogatePreparing;
        if (note.value !== this.interrogateIdentityNote) note.value = this.interrogateIdentityNote;
        note.disabled = this.interrogatePreparing;
        refresh.disabled = this.interrogateModelsLoading || this.interrogatePreparing;
        start.disabled = !selection || !model.value || this.interrogatePreparing;
        status.textContent = this.interrogateModelsError || this.interrogateStatus;
        status.dataset.state = this.interrogateModelsError ? "error" : this.interrogateStatusState;
        queue.textContent = this.interrogatePendingCount
            ? `${this.interrogatePendingCount} uploaded image${this.interrogatePendingCount === 1 ? "" : "s"} waiting or running. You may queue another.`
            : "No uploaded images are waiting. Shared FIFO status remains visible above.";
    }

    clearInterrogateSelection() {
        if (this.interrogatePreviewUrl) this.revokeObjectUrl(this.interrogatePreviewUrl);
        this.interrogatePreviewUrl = null;
        this.interrogateSelection = null;
    }

    async selectInterrogateFile(file) {
        if (!file || this.interrogatePreparing) return;
        this.interrogatePreparing = true;
        this.interrogateStatus = "Reading and validating the selected image in session memory…";
        this.interrogateStatusState = "idle";
        this.interrogateModelsError = "";
        this.renderInterrogatePanel();
        try {
            const size = Number(file.size || 0);
            if (!size) throw new Error("The selected image is empty.");
            if (size > MAX_IMAGE_BYTES) throw new Error("The selected image exceeds the 20 MiB limit.");
            const bytes = Buffer.from(await file.arrayBuffer());
            if (!bytes.byteLength || bytes.byteLength !== size) throw new Error("The selected image could not be read completely.");
            const format = detectImageFormat(bytes);
            if (!format || !isVisionSupportedFormat(format)) throw new Error("Interrogate supports PNG, JPEG, and WebP images only.");
            const sha256 = sha256Hex(bytes);
            const displayName = String(file.name || `image${format.extension}`).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 140) || `image${format.extension}`;
            this.clearInterrogateSelection();
            const view = this.historyRoot?.ownerDocument?.defaultView || window;
            this.interrogatePreviewUrl = view.URL.createObjectURL(new view.Blob([bytes], {type: format.mimeType}));
            this.interrogateSelection = Object.freeze({bytes, sha256, format, displayName});
            this.interrogateStatus = `Ready to queue image ${sha256.slice(0, 10)}.`;
            this.interrogateStatusState = "success";
        }
        catch (error) {
            this.clearInterrogateSelection();
            this.interrogateStatus = error instanceof Error ? error.message : String(error);
            this.interrogateStatusState = "error";
            this.toast(this.interrogateStatus, "error");
        }
        finally {
            this.interrogatePreparing = false;
            this.renderInterrogatePanel();
        }
    }

    async refreshInterrogateModels(force = false) {
        if (this.interrogateModelsLoading && !force) return;
        this.interrogateModelsLoading = true;
        this.interrogateModelsError = "";
        this.renderInterrogatePanel();
        try {
            const payload = await this.fetchProductJson("/api/discord-models");
            const order = new Map([
                ...HERETIC_MODEL_SPECS.map((item, index) => [item.public_id, index]),
                [ONLINE_VISION_MODEL_ID, HERETIC_MODEL_SPECS.length],
                ["discord::legacy-ollama-hybrid", HERETIC_MODEL_SPECS.length + 1]
            ]);
            this.interrogateModels = (Array.isArray(payload?.models) ? payload.models : [])
                .filter(item => item && VISION_MODEL_IDS.has(String(item.public_id || "")))
                .map(item => ({
                    public_id: String(item.public_id),
                    label: String(item.label || item.public_id),
                    local_gpu: item.local_gpu !== false,
                    estimated_vram_mb: Math.max(0, Number(item.estimated_vram_mb) || 0),
                    admission_passes_now: item.admission_passes_now === true
                }))
                .sort((left, right) => (order.get(left.public_id) ?? 9999) - (order.get(right.public_id) ?? 9999));
            if (!this.interrogateModels.length) throw new Error("The local Vision broker reported no selectable models.");
            const availableIds = new Set(this.interrogateModels.map(item => item.public_id));
            const preferred = effectiveVisionModel(this.settings);
            if (!availableIds.has(this.interrogateSelectedModel)) {
                this.interrogateSelectedModel = availableIds.has(preferred)
                    ? preferred
                    : availableIds.has(String(payload?.preferred || ""))
                        ? String(payload.preferred)
                        : this.interrogateModels[0].public_id;
            }
        }
        catch (error) {
            this.interrogateModels = [];
            this.interrogateSelectedModel = "";
            this.interrogateModelsError = error instanceof Error ? error.message : String(error);
        }
        finally {
            this.interrogateModelsLoading = false;
            this.renderInterrogatePanel();
        }
    }

    queueInterrogateSelection() {
        if (!this.running || this.interrogatePreparing || !this.interrogateSelection) return;
        const selectedModel = String(this.interrogateSelectedModel || "").trim();
        const availableModel = this.interrogateModels.find(item => item.public_id === selectedModel);
        if (!availableModel || !VISION_MODEL_IDS.has(selectedModel)) {
            this.interrogateStatus = "Refresh the model list and choose an available Vision model.";
            this.interrogateStatusState = "error";
            this.renderInterrogatePanel();
            return;
        }

        let visionConfig;
        try {
            const configured = this.getVisionConfig();
            if (!configured) throw new Error("Configure the local Vision endpoint and token before starting an interrogation.");
            visionConfig = Object.freeze({...configured, model: selectedModel});
        }
        catch (error) {
            this.interrogateStatus = error instanceof Error ? error.message : String(error);
            this.interrogateStatusState = "error";
            this.renderInterrogatePanel();
            this.toast(this.interrogateStatus, "error");
            return;
        }

        const original = this.interrogateSelection;
        const identityNote = String(this.interrogateIdentityNote || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 400);
        const requestGuidance = identityNote ? `Uploader-supplied identity or role metadata (not inferred from pixels): ${identityNote}` : "";
        const queuedGeneration = this.generation;
        const localSubmissionId = this.addLocalVisionSubmission({config: {visionModel: selectedModel}});
        this.armLocalVisionSubmissionTimeout(localSubmissionId, null, selectedModel);
        const requestImage = {filename: `${original.sha256}${original.format.extension}`};
        const retainedPreview = this.interrogatePreviewUrl;
        if (!this.historyThumbnailUrls.has(original.sha256) && retainedPreview) {
            this.storeHistoryThumbnailUrl(original.sha256, retainedPreview);
            this.interrogatePreviewUrl = null;
        }
        this.rememberHistoryThumbnail(original, true);
        this.updateLocalVisionSubmission(localSubmissionId, {
            image_hash: original.sha256,
            filename: requestImage.filename,
            local_title: original.displayName,
            model: selectedModel,
            stage: "Queued from Interrogate — waiting for its turn in the shared GPU FIFO."
        });
        this.clearInterrogateSelection();
        this.interrogateIdentityNote = "";
        this.interrogatePendingCount += 1;
        this.interrogateStatus = `${original.displayName} was added to the shared queue with ${availableModel.label}.`;
        this.interrogateStatusState = "success";
        this.renderInterrogatePanel();
        this.toast("Image added to the KREA2 Vision queue.", "success");

        const flow = this.visionFlowQueue.then(async () => {
            const localState = this.localVisionSubmissions.get(localSubmissionId);
            if (localState?.timed_out || localState?.status === "error") {
                this.interrogatePendingCount = Math.max(0, this.interrogatePendingCount - 1);
                this.interrogateStatus = "GPU not available";
                this.interrogateStatusState = "error";
                this.renderInterrogatePanel();
                return;
            }
            this.clearLocalVisionSubmissionTimeout(localSubmissionId);
            this.updateLocalVisionSubmission(localSubmissionId, {submission_started: true});
            if (!this.running || queuedGeneration !== this.generation) {
                this.removeLocalVisionSubmission(localSubmissionId);
                return;
            }
            const controller = new AbortController();
            this.controllers.add(controller);
            try {
                const preset = normalizePromptPreset(this.settings.preferredPreset);
                const datasetGuidance = this.settings.useKrea2DatasetGuidance === true;
                const feedbackContext = datasetGuidance ? buildPromptFeedbackContext(this.promptFeedback) : null;
                const requestCacheKey = visionRequestCacheKey(original.sha256, {
                    model: selectedModel,
                    preset,
                    guidance: requestGuidance,
                    datasetGuidance,
                    feedbackDigest: feedbackContext?.digest || "",
                    jobId: localSubmissionId,
                    pipelineId: VISION_PIPELINE_ID
                });
                const queued = this.getOrQueueVisionJob(requestCacheKey, () => {
                    if (!this.running || queuedGeneration !== this.generation) {
                        const abortError = new Error("Vision analysis was cancelled because the plugin stopped.");
                        abortError.name = "AbortError";
                        throw abortError;
                    }
                    return this.requestVisionPrompt(
                        original,
                        requestImage,
                        visionConfig,
                        controller.signal,
                        elapsed => this.updateLocalVisionSubmission(localSubmissionId, {
                            stage: `Interrogating with ${availableModel.label} (${elapsed}) — shared FIFO ownership is exclusive.`
                        }),
                        {
                            model: selectedModel,
                            guidance: requestGuidance,
                            preset,
                            datasetGuidance,
                            feedbackContext,
                            jobId: localSubmissionId
                        }
                    );
                });
                this.updateLocalVisionSubmission(localSubmissionId, {
                    stage: queued.shared
                        ? "Waiting for the already-running request for these exact in-memory bytes."
                        : "Submitted from memory — waiting for the shared GPU FIFO."
                });
                const result = await queued.job;
                this.removeLocalVisionSubmission(localSubmissionId);
                this.lastCompletionJobId = localSubmissionId;
                this.interrogateStatus = `${original.displayName} finished with ${result.model || availableModel.label}.`;
                this.interrogateStatusState = "success";
                await this.finishVisionPrompt({button: null, model: result.model});
                await this.refreshHistory(true);
                if (this.historyJobs.some(job => job.id === localSubmissionId)) void this.openHistoryDetail(localSubmissionId);
            }
            catch (error) {
                if (!this.running || queuedGeneration !== this.generation || error?.name === "AbortError") return;
                const message = error instanceof Error ? error.message : String(error);
                this.updateLocalVisionSubmission(localSubmissionId, {status: "error", stage: message, public_error: message});
                this.interrogateStatus = message;
                this.interrogateStatusState = "error";
                this.toast(message, "error");
                this.log("error", message);
                this.queueOperationalError({eventId: localSubmissionId, modelId: selectedModel, errorCode: "interrogate_failed", errorMessage: message, stage: "Interrogate image request"});
                await this.refreshHistory(true);
            }
            finally {
                this.controllers.delete(controller);
                this.interrogatePendingCount = Math.max(0, this.interrogatePendingCount - 1);
                this.renderInterrogatePanel();
            }
        });
        this.visionFlowQueue = flow.catch(() => {});
    }

    setHistoryCollapsed(collapsed) {
        this.settings.historyCollapsed = collapsed === true;
        if (this.historyRoot) this.historyRoot.dataset.collapsed = this.settings.historyCollapsed ? "true" : "false";
        this.api.Data.save("settings", this.settings);
        if (!this.settings.historyCollapsed) void this.refreshHistory(true);
    }

    beginHistoryResize(event) {
        if (event.button !== 0 || !this.historyRoot) return;
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = this.historyRoot.getBoundingClientRect().width;
        const move = moveEvent => {
            const width = Math.min(440, Math.max(268, Math.round(startWidth + startX - moveEvent.clientX)));
            this.settings.historyWidth = width;
            this.historyRoot?.style.setProperty("--krea2-history-width", `${width}px`);
        };
        const finish = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", finish);
            this.historyResizeCleanup = null;
            this.api.Data.save("settings", this.settings);
        };
        this.historyResizeCleanup?.();
        this.historyResizeCleanup = finish;
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish, {once: true});
    }

    async refreshHistory(force = false) {
        if (!this.running || (this.historyLoading && !force)) return;
        this.historyRequestController?.abort();
        const controller = new AbortController();
        this.historyRequestController = controller;
        this.historyLoading = true;
        this.historyError = "";
        this.renderHistoryRail();
        try {
            const baseUrl = historyBaseUrlFromVisionEndpoint(this.settings.visionEndpoint);
            const requestUrl = new URL(`${baseUrl}/api/discord-jobs`);
            requestUrl.searchParams.set("page", String(this.historyPage));
            requestUrl.searchParams.set("page_size", String(HISTORY_PAGE_SIZE));
            requestUrl.searchParams.set("view", this.historyFilter === "interrogate" ? "recent" : this.historyFilter);
            if (this.historySearch.trim()) requestUrl.searchParams.set("q", this.historySearch.trim().slice(0, 200));
            if (this.historyModelFilter !== "all") requestUrl.searchParams.set("model", this.historyModelFilter);
            const expectedUrl = requestUrl.toString();
            const response = await this.api.Net.fetch(expectedUrl, {
                method: "GET",
                headers: {Accept: "application/json"},
                redirect: "manual",
                maxRedirects: 0,
                signal: controller.signal,
                timeout: 15000
            });
            if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error("Vision history attempted a redirect.");
            if (!response.ok) throw new Error(`Vision history failed with HTTP ${response.status}.`);
            if (response.url && response.url !== expectedUrl) throw new Error("Vision history response changed its loopback URL.");
            const state = parseHistoryListResponse(await readBoundedResponseText(response, HISTORY_MAX_RESPONSE_BYTES));
            if (!this.running || controller.signal.aborted) return;
            for (const job of state.jobs) {
                const previous = this.historyStatusById.get(job.id);
                if (previous && (previous === "queued" || previous === "running") && !isHistoryJobActive(job)) {
                    this.notifyJobCompletion(job);
                }
                this.historyStatusById.set(job.id, job.status);
            }
            this.historyJobs = state.jobs;
            this.historySummary = state.summary;
            this.historyScheduler = state.scheduler;
            this.historyPagination = state.pagination;
            this.historyPage = state.pagination.page;
        }
        catch (error) {
            if (error?.name !== "AbortError") this.historyError = error instanceof Error ? error.message : String(error);
        }
        finally {
            if (this.historyRequestController === controller) this.historyRequestController = null;
            this.historyLoading = false;
            this.renderHistoryRail();
            void this.flushOperationalErrors();
        }
    }

    renderHistoryRail(root = this.historyRoot) {
        if (!root) return;
        const heading = root?.querySelector(".krea2-history-title");
        const subtitle = root?.querySelector(".krea2-history-subtitle");
        const summaryNode = root?.querySelector('[data-role="summary"]');
        const averageQueueNode = root?.querySelector('[data-role="average-queue"]');
        const schedulerNode = root?.querySelector('[data-role="scheduler"]');
        const libraryTools = root?.querySelector(".krea2-history-library-tools");
        const interrogateNode = root?.querySelector('[data-role="interrogate"]');
        const listNode = root?.querySelector('[data-role="list"]');
        const paginationNode = root?.querySelector('[data-role="pagination"]');
        const favoritesFilter = root?.querySelector('[data-role="favorites-filter"]');
        const batchOpen = root?.querySelector('[data-role="batch-open"]');
        const completion = root?.querySelector('[data-role="completion"]');
        if (!summaryNode || !averageQueueNode || !schedulerNode || !interrogateNode || !listNode || !paginationNode) return;

        const isInterrogate = this.historyFilter === "interrogate";
        if (heading) heading.textContent = isInterrogate ? "Interrogate" : "Prompt History";
        if (subtitle) subtitle.textContent = isInterrogate ? "Upload · choose model · queue" : "All local Vision jobs";
        if (libraryTools) libraryTools.hidden = isInterrogate;
        interrogateNode.hidden = !isInterrogate;
        listNode.hidden = isInterrogate;
        paginationNode.hidden = isInterrogate;

        for (const tab of root.querySelectorAll(".krea2-history-tab")) {
            tab.setAttribute("aria-selected", tab.dataset.filter === this.historyFilter ? "true" : "false");
        }

        summaryNode.replaceChildren();
        const summary = this.historySummary || {};
        const localQueueCount = [...this.localVisionSubmissions.values()].filter(isHistoryJobActive).length;
        for (const [label, value] of [["Queued", (summary.queued || 0) + localQueueCount], ["Running", summary.running || 0], ["Done 24h", summary.completed_24h || 0], ["Errors", (summary.rejected || 0) + (summary.errors || 0) + (summary.cancelled || 0)]]) {
            const stat = document.createElement("div");
            stat.className = "krea2-history-stat";
            const strong = document.createElement("strong");
            strong.textContent = String(value);
            const span = document.createElement("span");
            span.textContent = label;
            stat.append(strong, span);
            summaryNode.append(stat);
        }

        const queueAverage = historyAverageQueueWait(this.historyJobs);
        averageQueueNode.textContent = formatAverageQueueTime(queueAverage.seconds);
        averageQueueNode.title = queueAverage.sample_count
            ? `Based on ${queueAverage.sample_count} completed Vision ${queueAverage.sample_count === 1 ? "job" : "jobs"} from the last 24 hours.`
            : "No completed Vision jobs are available from the last 24 hours.";

        schedulerNode.replaceChildren();
        const warm = this.historyScheduler?.warm;
        const next = this.historyScheduler?.next_eligible_job;
        const schedulerStrong = document.createElement("strong");
        if (warm?.active) schedulerStrong.textContent = `Warm ${Math.max(0, Number(warm.seconds_remaining) || 0).toFixed(0)}s`;
        else schedulerStrong.textContent = next?.eligible_now ? "GPU ready" : "Shared GPU waiting";
        const schedulerText = document.createTextNode(` · ${String(next?.reason || "Shared FIFO status unavailable").slice(0, 220)}`);
        schedulerNode.append(schedulerStrong, schedulerText);

        if (favoritesFilter) favoritesFilter.dataset.active = this.historyFavoritesOnly ? "true" : "false";
        if (batchOpen) batchOpen.textContent = `Batch (${this.batchSelected.size})`;
        if (completion) {
            const completedJob = this.historyJobs.find(job => job.id === this.lastCompletionJobId);
            completion.hidden = isInterrogate || !completedJob;
            if (completedJob) completion.textContent = `${completedJob.status === "completed" ? "Prompt ready" : "Vision job finished"}: ${historyJobTitle(completedJob)} — open result`;
        }

        if (isInterrogate) {
            this.renderInterrogatePanel(interrogateNode);
            return;
        }

        listNode.replaceChildren();
        this.renderHistoryPagination(paginationNode);
        if (this.historyError) {
            const empty = document.createElement("div");
            empty.className = "krea2-history-empty";
            empty.textContent = `${this.historyError} The panel will retry automatically.`;
            listNode.append(empty);
            return;
        }
        const search = this.historySearch.trim().toLowerCase();
        const visibleJobs = [...this.getLocalVisionHistoryJobs(), ...this.historyJobs];
        const jobs = filterHistoryJobs(visibleJobs, this.historyFilter).filter(job => {
            if (!historyJobMatchesModel(job, this.historyModelFilter)) return false;
            if (this.historyReviewFilter !== "all" && this.getHistoryReview(job.image_hash).status !== this.historyReviewFilter) return false;
            if (this.historyFavoritesOnly && (job.local_submission || !this.historyFavorites.has(job.image_hash))) return false;
            if (!search) return true;
            return `${historyJobTitle(job)} ${job.filename} ${job.model} ${job.status} ${job.prompt_preview} ${job.public_error} ${job.stage}`.toLowerCase().includes(search);
        });
        if (!jobs.length) {
            const empty = document.createElement("div");
            empty.className = "krea2-history-empty";
            empty.textContent = this.historyLoading ? "Loading local Vision history…" : "No jobs in this view yet.";
            listNode.append(empty);
            return;
        }
        for (const job of jobs) listNode.append(this.createHistoryJobRow(job));
    }

    renderHistoryPagination(container) {
        if (!container) return;
        container.replaceChildren();
        const pagination = this.historyPagination || {};
        const page = Math.max(1, Number(pagination.page) || 1);
        const totalPages = Math.max(1, Number(pagination.total_pages) || 1);
        const totalItems = Math.max(0, Number(pagination.total_items) || 0);

        const previous = document.createElement("button");
        previous.type = "button";
        previous.className = "krea2-history-page-button";
        previous.textContent = "‹";
        previous.title = "Previous history page";
        previous.setAttribute("aria-label", previous.title);
        previous.disabled = this.historyLoading || page <= 1;
        previous.addEventListener("click", () => {
            if (page <= 1) return;
            this.historyPage = page - 1;
            void this.refreshHistory(true);
        });

        const label = document.createElement("div");
        label.className = "krea2-history-page-label";
        label.textContent = `Page ${page} of ${totalPages} · ${totalItems} ${totalItems === 1 ? "job" : "jobs"}`;

        const next = document.createElement("button");
        next.type = "button";
        next.className = "krea2-history-page-button";
        next.textContent = "›";
        next.title = "Next history page";
        next.setAttribute("aria-label", next.title);
        next.disabled = this.historyLoading || page >= totalPages;
        next.addEventListener("click", () => {
            if (page >= totalPages) return;
            this.historyPage = page + 1;
            void this.refreshHistory(true);
        });

        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "krea2-history-page-button krea2-history-page-clear";
        clear.textContent = "Clear";
        clear.title = "Clear all finished prompt history and local history thumbnails";
        const allHistoryItems = Math.max(totalItems, Number(this.historySummary?.total) || 0);
        clear.disabled = this.historyLoading || allHistoryItems <= 0;
        clear.addEventListener("click", async () => {
            const view = this.historyRoot?.ownerDocument?.defaultView || window;
            if (!view.confirm("Clear all finished KREA2 Vision history? Completed prompts, errors, cancelled jobs, and their local thumbnails will be removed. Active jobs will remain.")) return;
            clear.disabled = true;
            try {
                const result = await this.postVisionControl("/api/discord-jobs-clear-terminal");
                let removedThumbnails = 0;
                try { removedThumbnails = clearHistoryThumbnailCache(historyThumbnailCacheDirectory(this.settings.saveFolder)); }
                catch {}
                for (const objectUrl of this.historyThumbnailUrls.values()) this.revokeObjectUrl(objectUrl);
                this.historyThumbnailUrls.clear();
                this.historyThumbnailLoads.clear();
                this.historyOriginalPaths.clear();
                this.historyPage = 1;
                this.toast(`Cleared ${Number(result.cleared) || 0} finished Vision jobs and ${removedThumbnails} local thumbnails.`, "success");
                await this.refreshHistory(true);
            }
            catch (error) {
                this.toast(error instanceof Error ? error.message : String(error), "error");
            }
            finally { clear.disabled = false; }
        });

        container.append(previous, label, next, clear);
    }

    createHistoryJobRow(job) {
        const localSubmission = job.local_submission === true;
        const row = document.createElement("div");
        row.className = "krea2-history-job";
        row.tabIndex = localSubmission ? -1 : 0;
        row.setAttribute("role", localSubmission ? "status" : "button");
        row.addEventListener("click", event => {
            if (localSubmission || event.target?.closest?.("button")) return;
            void this.openHistoryDetail(job.id);
        });
        row.addEventListener("keydown", event => {
            if (!localSubmission && (event.key === "Enter" || event.key === " ") && !event.target?.closest?.("button")) {
                event.preventDefault();
                void this.openHistoryDetail(job.id);
            }
        });
        const layout = document.createElement("div");
        layout.className = "krea2-history-job-layout";
        const thumbnailUrl = this.getHistoryThumbnailUrl(job.image_hash);
        let thumbnail;
        if (thumbnailUrl) {
            thumbnail = document.createElement("img");
            thumbnail.className = "krea2-history-job-thumb";
            thumbnail.src = thumbnailUrl;
            thumbnail.alt = "";
        }
        else {
            thumbnail = document.createElement("div");
            thumbnail.className = "krea2-history-job-thumb krea2-history-job-thumb-missing";
            thumbnail.textContent = "◇";
        }
        const content = document.createElement("div");
        const top = document.createElement("div");
        top.className = "krea2-history-job-top";
        const title = document.createElement("div");
        title.className = "krea2-history-job-title";
        title.textContent = job.local_title || historyJobTitle(job);
        const badge = document.createElement("span");
        badge.className = "krea2-history-badge";
        badge.dataset.status = job.status;
        badge.textContent = localSubmission ? "LOCAL QUEUE" : job.status;
        top.append(title, badge);
        const meta = document.createElement("div");
        meta.className = "krea2-history-job-meta";
        const date = document.createElement("span");
        date.textContent = this.formatHistoryDate(job.created);
        const model = document.createElement("span");
        const modelEvidence = historyModelEvidence(job);
        model.textContent = modelEvidence.confirmed
            ? `Used: ${modelEvidence.label}`
            : `Requested: ${modelEvidence.model_id || (job.status === "queued" ? `Queue +${job.queue_ahead}` : "Pending")}`;
        model.title = modelEvidence.confirmed
            ? `Model actually used: ${modelEvidence.label} (${modelEvidence.model_id})`
            : modelEvidence.note;
        meta.append(date, model);
        content.append(top, meta);
        const previewText = job.prompt_preview || job.public_error || job.stage;
        if (previewText) {
            const preview = document.createElement("div");
            preview.className = "krea2-history-job-preview";
            preview.textContent = previewText;
            content.append(preview);
        }
        if (localSubmission) {
            const localNote = document.createElement("div");
            localNote.className = "krea2-history-job-meta";
            localNote.textContent = "Will appear as a shared-GPU job automatically.";
            content.append(localNote);
            if (isHistoryJobActive(job)) {
                const controls = document.createElement("div");
                controls.className = "krea2-history-job-controls";
                const cancel = document.createElement("button");
                cancel.type = "button";
                cancel.className = "krea2-history-mini";
                cancel.textContent = "×";
                cancel.title = "Cancel this queued Vision job";
                cancel.addEventListener("click", () => void this.cancelVisionJob(job));
                controls.append(cancel);
                content.append(controls);
            }
            layout.append(thumbnail, content);
            row.append(layout);
            return row;
        }
        if (isHistoryJobActive(job)) {
            const controls = document.createElement("div");
            controls.className = "krea2-history-job-controls";
            const cancel = document.createElement("button");
            cancel.type = "button";
            cancel.className = "krea2-history-mini";
            cancel.textContent = "×";
            cancel.title = job.cancel_requested ? "Cancellation already requested" : "Cancel this Vision job";
            cancel.disabled = job.cancel_requested;
            cancel.addEventListener("click", () => void this.cancelVisionJob(job));
            controls.append(cancel);
            content.append(controls);
        }
        layout.append(thumbnail, content);
        row.append(layout);
        if (!thumbnailUrl && job.image_hash) {
            void this.loadHistoryThumbnailUrl(job.image_hash).then(url => {
                if (!url || !thumbnail.isConnected) return;
                const image = document.createElement("img");
                image.className = "krea2-history-job-thumb";
                image.src = url;
                image.alt = "";
                thumbnail.replaceWith(image);
                thumbnail = image;
            }).catch(() => {});
        }
        return row;
    }

    revokeObjectUrl(url) {
        try { (this.historyRoot?.ownerDocument?.defaultView || window)?.URL?.revokeObjectURL(url); }
        catch {}
    }

    getHistoryThumbnailUrl(hash) {
        const key = String(hash || "").toLowerCase();
        return key ? this.historyThumbnailUrls.get(key) || null : null;
    }

    storeHistoryThumbnailUrl(hash, objectUrl) {
        const key = String(hash || "").toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(key) || !objectUrl) return null;
        const existing = this.historyThumbnailUrls.get(key);
        if (existing) {
            if (existing !== objectUrl) this.revokeObjectUrl(objectUrl);
            this.historyThumbnailUrls.delete(key);
            this.historyThumbnailUrls.set(key, existing);
            return existing;
        }
        this.historyThumbnailUrls.set(key, objectUrl);
        while (this.historyThumbnailUrls.size > HISTORY_LIMIT) {
            const oldestKey = this.historyThumbnailUrls.keys().next().value;
            const oldestUrl = this.historyThumbnailUrls.get(oldestKey);
            this.historyThumbnailUrls.delete(oldestKey);
            if (oldestUrl) this.revokeObjectUrl(oldestUrl);
        }
        return objectUrl;
    }

    rememberHistoryThumbnail(original, persist = true) {
        const key = String(original?.sha256 || "").toLowerCase();
        const bytes = original?.bytes;
        const format = original?.format;
        if (!/^[a-f0-9]{64}$/.test(key) || !bytes?.byteLength || !format?.mimeType) return null;
        let objectUrl = this.historyThumbnailUrls.get(key) || null;
        if (!objectUrl) {
            const view = this.historyRoot?.ownerDocument?.defaultView || window;
            objectUrl = view.URL.createObjectURL(new view.Blob([bytes], {type: format.mimeType}));
            this.storeHistoryThumbnailUrl(key, objectUrl);
        }
        if (persist) {
            void this.persistHistoryThumbnail(original).catch(error => {
                this.log("warn", `Could not persist history thumbnail ${key.slice(0, 10)}: ${error instanceof Error ? error.message : String(error)}`);
            });
        }
        return objectUrl;
    }

    async encodeHistoryThumbnail(original) {
        const view = this.historyRoot?.ownerDocument?.defaultView || window;
        const sourceUrl = view.URL.createObjectURL(new view.Blob([original.bytes], {type: original.format.mimeType}));
        try {
            const image = new view.Image();
            await new Promise((resolve, reject) => {
                image.onload = () => resolve();
                image.onerror = () => reject(new Error("The source image could not be decoded for its local thumbnail."));
                image.src = sourceUrl;
            });
            const sourceWidth = Math.max(1, Number(image.naturalWidth || image.width || 0));
            const sourceHeight = Math.max(1, Number(image.naturalHeight || image.height || 0));
            const scale = Math.min(1, HISTORY_THUMBNAIL_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
            const canvas = (this.historyRoot?.ownerDocument || document).createElement("canvas");
            canvas.width = Math.max(1, Math.round(sourceWidth * scale));
            canvas.height = Math.max(1, Math.round(sourceHeight * scale));
            const context = canvas.getContext("2d", {alpha: true});
            if (!context) throw new Error("Discord could not create the thumbnail canvas.");
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = "high";
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise((resolve, reject) => {
                canvas.toBlob(value => value ? resolve(value) : reject(new Error("Discord could not encode the local thumbnail.")), "image/webp", 0.82);
            });
            const bytes = Buffer.from(await blob.arrayBuffer());
            if (!bytes.byteLength || bytes.byteLength > HISTORY_THUMBNAIL_MAX_BYTES) {
                throw new Error("The encoded thumbnail exceeded the 2 MiB cache limit.");
            }
            return {bytes, extension: ".webp", mimeType: "image/webp"};
        }
        catch (error) {
            if (original.bytes.byteLength <= HISTORY_THUMBNAIL_MAX_BYTES) {
                return {bytes: Buffer.from(original.bytes), extension: original.format.extension, mimeType: original.format.mimeType};
            }
            throw error;
        }
        finally {
            view.URL.revokeObjectURL(sourceUrl);
        }
    }

    async persistHistoryThumbnail(original) {
        const key = String(original?.sha256 || "").toLowerCase();
        const candidates = historyThumbnailCacheCandidates(this.settings.saveFolder, key);
        for (const candidate of candidates) {
            if (!isFileCompat(fs, candidate)) continue;
            try {
                const existing = await readFileCompat(fs, candidate);
                const format = detectImageFormat(existing);
                if (existing.byteLength && existing.byteLength <= HISTORY_THUMBNAIL_MAX_BYTES && format && isVisionSupportedFormat(format)) return candidate;
            }
            catch {}
        }
        const encoded = await this.encodeHistoryThumbnail(original);
        const directory = historyThumbnailCacheDirectory(this.settings.saveFolder);
        await mkdirCompat(fs, directory);
        const destination = path.win32.join(directory, `${key}${encoded.extension}`);
        await writeFileCompat(fs, destination, encoded.bytes, {flag: "w"});
        return destination;
    }

    async findCachedHistoryThumbnailPath(hash) {
        let candidates;
        try { candidates = historyThumbnailCacheCandidates(this.settings.saveFolder, hash); }
        catch { return null; }
        for (const candidate of candidates) {
            if (!isFileCompat(fs, candidate)) continue;
            try {
                const bytes = await readFileCompat(fs, candidate);
                const format = detectImageFormat(bytes);
                if (bytes.byteLength && bytes.byteLength <= HISTORY_THUMBNAIL_MAX_BYTES && format && isVisionSupportedFormat(format)) return candidate;
            }
            catch {}
        }
        return null;
    }

    addLocalVisionSubmission(selection) {
        const id = randomBytes(16).toString("hex");
        const ordinal = this.localVisionSubmissions.size + 1;
        this.localVisionSubmissions.set(id, {
            id,
            created: Date.now() / 1000,
            status: "queued",
            local_title: `Discord image #${ordinal}`,
            filename: `Discord image #${ordinal}`,
            model: String(selection?.config?.visionModel || effectiveVisionModel(this.settings)),
            stage: `Queued locally — waiting to submit after ${Math.max(0, ordinal - 1)} earlier Discord image${ordinal === 2 ? "" : "s"}.`,
            prompt_preview: "",
            public_error: "",
            image_hash: "",
            local_submission: true,
            cancel_requested: false,
            submission_started: false
        });
        this.renderHistoryRail();
        return id;
    }

    updateLocalVisionSubmission(id, patch) {
        const current = this.localVisionSubmissions.get(id);
        if (!current) return;
        this.localVisionSubmissions.set(id, {...current, ...(patch || {})});
        this.renderHistoryRail();
    }

    removeLocalVisionSubmission(id) {
        const timer = this.localVisionSubmissionTimers.get(id);
        if (timer !== undefined) clearTimeout(timer);
        this.localVisionSubmissionTimers.delete(id);
        if (this.localVisionSubmissions.delete(id)) this.renderHistoryRail();
    }

    clearLocalVisionSubmissionTimeout(id) {
        const timer = this.localVisionSubmissionTimers.get(id);
        if (timer !== undefined) clearTimeout(timer);
        this.localVisionSubmissionTimers.delete(id);
    }

    armLocalVisionSubmissionTimeout(id, button, model) {
        this.clearLocalVisionSubmissionTimeout(id);
        const timer = setTimeout(() => {
            this.localVisionSubmissionTimers.delete(id);
            const current = this.localVisionSubmissions.get(id);
            if (!this.running || !current || current.status !== "queued" || current.submission_started) return;
            this.updateLocalVisionSubmission(id, {
                status: "error",
                stage: "GPU not available",
                public_error: "GPU not available",
                queue_ahead: 0,
                timed_out: true
            });
            if (button) button.dataset.busy = "false";
            this.setButtonState(button, "error", "!", "GPU not available. Click to retry.");
            this.toast("GPU not available", "error");
            this.log("error", "GPU not available");
            this.queueOperationalError({
                eventId: id,
                modelId: model,
                errorCode: "gpu_not_available",
                errorMessage: "GPU not available",
                stage: "Waiting to submit the Discord image"
            });
        }, GPU_AVAILABILITY_TIMEOUT_MS);
        this.localVisionSubmissionTimers.set(id, timer);
    }

    async cancelVisionJob(job) {
        if (!job?.id) return;
        const local = this.localVisionSubmissions.get(job.id);
        if (local) {
            this.updateLocalVisionSubmission(job.id, {cancel_requested: true, status: "cancelled", stage: "Cancelled before submission"});
        }
        if (!job.local_submission || job.status === "running" || (job.status === "queued" && job.image_hash)) {
            try {
                await this.postVisionControl(`/api/discord-jobs/${job.id}/cancel`);
            }
            catch (error) {
                if (!local) throw error;
            }
        }
        this.toast(`${historyJobTitle(job)} cancellation requested.`, "success");
        void this.refreshHistory(true);
    }

    getLocalVisionHistoryJobs() {
        return [...this.localVisionSubmissions.values()]
            .sort((left, right) => Number(right.created || 0) - Number(left.created || 0));
    }

    async loadHistoryThumbnailUrl(hash) {
        const key = String(hash || "").toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(key)) return null;
        if (this.historyThumbnailUrls.has(key)) return this.historyThumbnailUrls.get(key);
        if (this.historyThumbnailLoads.has(key)) return this.historyThumbnailLoads.get(key);
        const loading = (async () => {
            const filePath = await this.findCachedHistoryThumbnailPath(key);
            if (!filePath) return null;
            const bytes = await readFileCompat(fs, filePath);
            if (!bytes?.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) return null;
            const format = detectImageFormat(bytes);
            if (!format) return null;
            const view = this.historyRoot?.ownerDocument?.defaultView || window;
            const url = view.URL.createObjectURL(new view.Blob([bytes], {type: format.mimeType}));
            return this.storeHistoryThumbnailUrl(key, url);
        })().finally(() => this.historyThumbnailLoads.delete(key));
        this.historyThumbnailLoads.set(key, loading);
        return loading;
    }

    toggleHistoryFavorite(hash) {
        const key = String(hash || "").toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(key)) return;
        if (this.historyFavorites.has(key)) this.historyFavorites.delete(key);
        else this.historyFavorites.add(key);
        while (this.historyFavorites.size > MAX_PRODUCT_FAVORITES) this.historyFavorites.delete(this.historyFavorites.values().next().value);
        this.renderHistoryRail();
    }

    getHistoryReview(hash) {
        const key = String(hash || "").toLowerCase();
        return sanitizeReviewRecord(/^[a-f0-9]{64}$/.test(key) ? this.historyReviews[key] : null);
    }

    saveHistoryReview(hash, review) {
        const key = String(hash || "").toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("A full image SHA-256 is required to save review state.");
        this.historyReviews[key] = sanitizeReviewRecord({...review, updated: Date.now()});
        const ordered = Object.entries(this.historyReviews)
            .sort((left, right) => Number(right[1]?.updated || 0) - Number(left[1]?.updated || 0))
            .slice(0, MAX_REVIEW_RECORDS);
        this.historyReviews = Object.fromEntries(ordered);
        this.renderHistoryRail();
        return this.historyReviews[key];
    }

    saveModelEvaluation(imageHash, modelId, evaluation) {
        const hash = String(imageHash || "").toLowerCase();
        const model = String(modelId || "").slice(0, 160);
        if (!/^[a-f0-9]{64}$/.test(hash) || !model) return;
        const record = {};
        for (const key of ["pose", "subject", "clothing", "scene", "lighting"]) record[key] = Math.max(0, Math.min(5, Math.trunc(Number(evaluation?.[key]) || 0)));
        record.note = String(evaluation?.note || "").normalize("NFKC").replace(/\r\n?/g, "\n").slice(0, 1000);
        record.winner = evaluation?.winner === true;
        record.updated = Date.now();
        this.modelEvaluations[hash] ||= {};
        if (record.winner) for (const existing of Object.values(this.modelEvaluations[hash])) if (existing && typeof existing === "object") existing.winner = false;
        this.modelEvaluations[hash][model] = record;
        const orderedHashes = Object.entries(this.modelEvaluations)
            .sort((left, right) => Math.max(...Object.values(right[1] || {}).map(item => Number(item?.updated || 0)), 0) - Math.max(...Object.values(left[1] || {}).map(item => Number(item?.updated || 0)), 0))
            .slice(0, MAX_MODEL_EVALUATIONS);
        this.modelEvaluations = Object.fromEntries(orderedHashes);
    }

    async exportReviewedDataset() {
        throw new Error("Disk exports are disabled by strict privacy mode. Copy a prompt from the current session instead.");
    }

    toggleBatchSelection(jobId) {
        if (this.batchSelected.has(jobId)) this.batchSelected.delete(jobId);
        else this.batchSelected.add(jobId);
        this.renderHistoryRail();
    }

    formatHistoryDate(seconds) {
        const date = new Date(Number(seconds) * 1000);
        if (!Number.isFinite(date.getTime())) return "Unknown date";
        return date.toLocaleString([], {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});
    }

    async fetchHistoryDetail(jobId, signal) {
        if (!/^[a-f0-9]{16,64}$/i.test(String(jobId || ""))) throw new Error("Invalid Vision history job ID.");
        const baseUrl = historyBaseUrlFromVisionEndpoint(this.settings.visionEndpoint);
        const expectedUrl = `${baseUrl}/api/discord-jobs/${jobId}`;
        const response = await this.api.Net.fetch(expectedUrl, {
            method: "GET",
            headers: {Accept: "application/json"},
            redirect: "manual",
            maxRedirects: 0,
            signal,
            timeout: 15000
        });
        if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error("Vision history detail attempted a redirect.");
        if (!response.ok) throw new Error(`Vision history detail failed with HTTP ${response.status}.`);
        if (response.url && response.url !== expectedUrl) throw new Error("Vision history detail changed its loopback URL.");
        return parseHistoryDetailResponse(await readBoundedResponseText(response, HISTORY_MAX_RESPONSE_BYTES));
    }

    async openHistoryDetail(jobId) {
        this.historyModalCleanup?.();
        const modalDocument = this.historyRoot?.ownerDocument || document;
        modalDocument.getElementById(HISTORY_MODAL_ID)?.remove();
        const controller = new AbortController();
        let detailPollTimer = null;
        let detailPollInFlight = false;
        let currentJob = null;
        let savedOriginal = null;
        let thumbnailObjectUrl = null;
        let regionPreviewObjectUrl = null;
        const overlay = modalDocument.createElement("div");
        overlay.id = HISTORY_MODAL_ID;
        overlay.setAttribute("role", "presentation");
        const dialog = modalDocument.createElement("section");
        dialog.className = "krea2-history-dialog";
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-label", "Vision prompt details");
        const head = modalDocument.createElement("div");
        head.className = "krea2-history-dialog-head";
        const heading = modalDocument.createElement("h2");
        heading.textContent = "Loading prompt…";
        const close = modalDocument.createElement("button");
        close.type = "button";
        close.className = "krea2-history-icon";
        close.textContent = "×";
        close.setAttribute("aria-label", "Close prompt details");
        head.append(heading, close);
        const body = modalDocument.createElement("div");
        body.className = "krea2-history-dialog-body";
        body.textContent = "Loading local Vision job details…";
        const actions = modalDocument.createElement("div");
        actions.className = "krea2-history-dialog-actions";
        dialog.append(head, body, actions);
        overlay.append(dialog);
        modalDocument.body.append(overlay);
        const onKey = event => { if (event.key === "Escape") cleanup(); };
        const cleanup = () => {
            if (detailPollTimer !== null) clearInterval(detailPollTimer);
            detailPollTimer = null;
            controller.abort();
            thumbnailObjectUrl = null;
            if (regionPreviewObjectUrl) this.revokeObjectUrl(regionPreviewObjectUrl);
            regionPreviewObjectUrl = null;
            modalDocument.removeEventListener("keydown", onKey);
            overlay.remove();
            if (this.historyModalCleanup === cleanup) this.historyModalCleanup = null;
        };
        this.historyModalCleanup = cleanup;
        close.addEventListener("click", cleanup);
        overlay.addEventListener("click", event => { if (event.target === overlay) cleanup(); });
        modalDocument.addEventListener("keydown", onKey);
        close.focus();

        const retry = modalDocument.createElement("button");
        retry.type = "button";
        retry.className = "krea2-history-action";
        retry.textContent = "Retry image";
        retry.disabled = true;
        const copy = modalDocument.createElement("button");
        copy.type = "button";
        copy.className = "krea2-history-action";
        copy.dataset.primary = "true";
        copy.textContent = "Copy prompt";
        copy.disabled = true;
        const cancelJob = modalDocument.createElement("button");
        cancelJob.type = "button";
        cancelJob.className = "krea2-history-action";
        cancelJob.textContent = "Cancel job";
        cancelJob.disabled = true;
        const done = modalDocument.createElement("button");
        done.type = "button";
        done.className = "krea2-history-action";
        done.textContent = "Close";
        done.addEventListener("click", cleanup);
        actions.append(cancelJob, retry, copy, done);

        const renderCurrentJob = async () => {
            if (!currentJob || controller.signal.aborted) return;
            if (regionPreviewObjectUrl) this.revokeObjectUrl(regionPreviewObjectUrl);
            regionPreviewObjectUrl = null;
            heading.textContent = historyJobTitle(currentJob);
            savedOriginal = await this.findSavedOriginalPathAsync(currentJob.image_hash);
            thumbnailObjectUrl = await this.loadHistoryThumbnailUrl(currentJob.image_hash);
            if (controller.signal.aborted) return;
            body.replaceChildren(this.createHistoryDetailBody(currentJob, modalDocument, thumbnailObjectUrl, objectUrl => {
                if (regionPreviewObjectUrl && regionPreviewObjectUrl !== objectUrl) this.revokeObjectUrl(regionPreviewObjectUrl);
                regionPreviewObjectUrl = objectUrl;
            }));
            const active = isHistoryJobActive(currentJob);
            cancelJob.disabled = !active || currentJob.cancel_requested;
            cancelJob.textContent = currentJob.cancel_requested ? "Cancellation requested" : "Cancel job";
            retry.disabled = active || !savedOriginal;
            retry.title = active
                ? "Wait for this Vision job to finish before retrying it"
                : savedOriginal
                    ? "Run the locally saved original through the selected Vision model again"
                    : "Unavailable because the original image is not in the configured local save folder";
            copy.disabled = !currentJob.prompt;
            if (!active && detailPollTimer !== null) {
                clearInterval(detailPollTimer);
                detailPollTimer = null;
                void this.refreshHistory(true);
            }
        };

        retry.addEventListener("click", async () => {
            if (!currentJob || isHistoryJobActive(currentJob) || !savedOriginal) return;
            const retryModel = effectiveVisionModel(this.settings);
            const retryModelName = visionModelDisplayName(retryModel);
            retry.disabled = true;
            retry.textContent = `Retrying with ${retryModelName}…`;
            cancelJob.disabled = true;
            const retryingJob = {
                ...currentJob,
                status: "running",
                public_error: "",
                stage: `Retrying with ${retryModelName}…`,
                prompt: "",
                prompt_variants: [],
                prompt_words: 0,
                has_prompt: false,
                requested_model: retryModel,
                model: retryModel
            };
            body.replaceChildren(this.createHistoryDetailBody(retryingJob, modalDocument, thumbnailObjectUrl, objectUrl => {
                if (regionPreviewObjectUrl && regionPreviewObjectUrl !== objectUrl) this.revokeObjectUrl(regionPreviewObjectUrl);
                regionPreviewObjectUrl = objectUrl;
            }));
            try {
                const generated = await this.retrySavedHistoryImage(currentJob, savedOriginal, elapsed => { retry.textContent = `Running ${elapsed} · ${retryModelName}`; }, retryModel);
                currentJob = {
                    ...currentJob,
                    prompt: generated.prompt,
                    prompt_variants: generated.prompt_variants,
                    prompt_words: generated.prompt_words,
                    model: generated.model,
                    requested_model: retryModel,
                    has_prompt: true,
                    status: "completed"
                };
                await renderCurrentJob();
                this.toast("Vision prompt regenerated from the saved original.", "success");
                void this.refreshHistory(true);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                currentJob = {
                    ...currentJob,
                    status: "error",
                    public_error: message,
                    stage: "",
                    prompt: "",
                    prompt_variants: [],
                    prompt_words: 0,
                    has_prompt: false,
                    requested_model: retryModel,
                    model: retryModel
                };
                this.toast(message, "error");
            }
            finally {
                retry.textContent = "Retry image";
                void renderCurrentJob();
            }
        });
        cancelJob.addEventListener("click", async () => {
            if (!currentJob || !isHistoryJobActive(currentJob)) return;
            cancelJob.disabled = true;
            try { await this.cancelVisionJob(currentJob); }
            catch (error) { this.toast(error instanceof Error ? error.message : String(error), "error"); }
        });
        copy.addEventListener("click", async () => {
            if (!currentJob?.prompt) return;
            try {
                await (modalDocument.defaultView?.navigator || navigator).clipboard.writeText(currentJob.prompt);
                copy.textContent = "Copied";
                setTimeout(() => { if (copy.isConnected) copy.textContent = "Copy prompt"; }, 1400);
            }
            catch { this.toast("Discord could not copy the prompt to the clipboard.", "error"); }
        });

        const refreshOpenJob = async () => {
            if (controller.signal.aborted || detailPollInFlight) return;
            detailPollInFlight = true;
            try {
                currentJob = await this.fetchHistoryDetail(jobId, controller.signal);
                await renderCurrentJob();
            }
            catch (error) {
                if (error?.name === "AbortError") return;
                if (!currentJob) body.textContent = `${error instanceof Error ? error.message : String(error)} Retrying…`;
            }
            finally {
                detailPollInFlight = false;
            }
        };

        detailPollTimer = setInterval(() => void refreshOpenJob(), HISTORY_DETAIL_POLL_MS);
        await refreshOpenJob();
    }

    createHistoryDetailBody(job, modalDocument = document, thumbnailUrl = null, onRegionPreview = null) {
        const fragment = modalDocument.createDocumentFragment();
        const modelEvidence = historyModelEvidence(job);
        const grid = modalDocument.createElement("div");
        grid.className = "krea2-history-detail-grid";
        const details = [
            ["Status", job.status],
            ["Requested model", job.requested_model || (!modelEvidence.confirmed ? modelEvidence.model_id : "Unavailable")],
            ["Queue wait", formatHistoryDuration(historyQueueWaitSeconds(job))],
            ["Processing", job.duration_seconds === null ? "Pending" : formatHistoryDuration(job.duration_seconds)],
            ["Created", this.formatHistoryDate(job.created)],
            ["Words", String(job.prompt_words || 0)],
            ["Queue ahead", String(job.queue_ahead || 0)],
            ["Image hash", job.image_hash ? job.image_hash.slice(0, 12) : "Unavailable"]
        ];
        for (const [label, value] of details) {
            const item = modalDocument.createElement("div");
            item.className = "krea2-history-detail";
            const span = modalDocument.createElement("span");
            span.textContent = label;
            const strong = modalDocument.createElement("strong");
            strong.textContent = value;
            strong.title = value;
            item.append(span, strong);
            grid.append(item);
        }
        fragment.append(grid);
        const modelProof = modalDocument.createElement("section");
        modelProof.className = "krea2-history-model-proof";
        modelProof.dataset.confirmed = String(modelEvidence.confirmed);
        const modelProofLabel = modalDocument.createElement("div");
        modelProofLabel.className = "krea2-history-model-proof-label";
        modelProofLabel.textContent = modelEvidence.confirmed ? "Model that actually described this image" : "Model requested for this image";
        const modelProofName = modalDocument.createElement("strong");
        modelProofName.textContent = modelEvidence.label;
        modelProofName.title = modelEvidence.label;
        const modelProofId = modalDocument.createElement("div");
        modelProofId.className = "krea2-history-model-proof-id";
        modelProofId.textContent = `Exact model ID: ${modelEvidence.model_id}${modelEvidence.quantization ? ` · Quantization: ${modelEvidence.quantization}` : ""}`;
        const modelProofNote = modalDocument.createElement("div");
        modelProofNote.className = "krea2-history-model-proof-note";
        modelProofNote.textContent = modelEvidence.note;
        modelProof.append(modelProofLabel, modelProofName, modelProofId, modelProofNote);
        fragment.append(modelProof);
        const result = modalDocument.createElement("div");
        result.className = "krea2-history-result";
        const source = modalDocument.createElement("div");
        source.className = "krea2-history-source";
        const sourceLabel = modalDocument.createElement("div");
        sourceLabel.className = "krea2-history-prompt-label";
        sourceLabel.textContent = "Source image";
        const sourceFrame = modalDocument.createElement("div");
        sourceFrame.className = "krea2-history-source-frame";
        if (thumbnailUrl) {
            const thumbnail = modalDocument.createElement("img");
            thumbnail.className = "krea2-history-source-image";
            thumbnail.src = thumbnailUrl;
            thumbnail.alt = `Source image for ${historyJobTitle(job)}`;
            sourceFrame.append(thumbnail);
        }
        else {
            const missing = modalDocument.createElement("div");
            missing.className = "krea2-history-source-missing";
            missing.textContent = "The locally cached history thumbnail is unavailable.";
            sourceFrame.append(missing);
        }
        const showSelectedRegion = objectUrl => {
            if (!objectUrl) return;
            const thumbnail = modalDocument.createElement("img");
            thumbnail.className = "krea2-history-source-image";
            thumbnail.src = objectUrl;
            thumbnail.alt = `Selected region for ${historyJobTitle(job)}`;
            sourceLabel.textContent = "Selected region";
            sourceFrame.replaceChildren(thumbnail);
            onRegionPreview?.(objectUrl);
        };
        source.append(sourceLabel, sourceFrame);
        const output = modalDocument.createElement("div");
        output.className = "krea2-history-output";
        if (job.prompt) {
            const variants = Array.isArray(job.prompt_variants) && job.prompt_variants.length
                ? job.prompt_variants
                : [job.prompt];
            const label = modalDocument.createElement("div");
            label.className = "krea2-history-prompt-label";
            label.textContent = variants.length === 3 ? "Generated prompt variations" : "Generated prompt";
            const variantTabs = modalDocument.createElement("div");
            variantTabs.className = "krea2-product-tabs";
            const prompt = modalDocument.createElement("textarea");
            prompt.className = "krea2-history-prompt";
            prompt.readOnly = true;
            const copyVariant = modalDocument.createElement("button");
            copyVariant.type = "button";
            copyVariant.className = "krea2-history-action";
            copyVariant.dataset.primary = "true";
            const feedback = modalDocument.createElement("div");
            feedback.className = "krea2-prompt-feedback";
            const feedbackButtons = modalDocument.createElement("div");
            feedbackButtons.className = "krea2-prompt-feedback-buttons";
            const like = modalDocument.createElement("button");
            like.type = "button";
            like.className = "krea2-prompt-feedback-button";
            like.textContent = "👍 Like";
            const dislike = modalDocument.createElement("button");
            dislike.type = "button";
            dislike.className = "krea2-prompt-feedback-button";
            dislike.textContent = "👎 Needs work";
            const feedbackStatus = modalDocument.createElement("div");
            feedbackStatus.className = "krea2-prompt-feedback-status";
            let selectedVariant = 0;
            const variantLabels = ["Prompt 1 · Balanced", "Prompt 2 · Subject & pose", "Prompt 3 · Scene & light"];
            const refreshFeedback = () => {
                const selected = this.getPromptFeedback(variants[selectedVariant]);
                like.dataset.active = selected?.vote === "liked" ? "true" : "false";
                dislike.dataset.active = selected?.vote === "disliked" ? "true" : "false";
                like.setAttribute("aria-pressed", like.dataset.active);
                dislike.setAttribute("aria-pressed", dislike.dataset.active);
                feedbackStatus.textContent = selected?.vote === "liked"
                    ? "Liked locally. This prompt may guide future opt-in generations."
                    : selected?.vote === "disliked"
                        ? `Saved locally: ${selected.reason}`
                        : "Feedback stays in session memory and is used only when Krea2 dataset guidance is enabled.";
            };
            const selectVariant = index => {
                selectedVariant = index;
                prompt.value = variants[index] || variants[0];
                copyVariant.textContent = `Copy Prompt ${index + 1}`;
                for (const [buttonIndex, button] of [...variantTabs.children].entries()) {
                    button.setAttribute("aria-selected", buttonIndex === index ? "true" : "false");
                }
                refreshFeedback();
            };
            variants.forEach((_, index) => {
                const tab = modalDocument.createElement("button");
                tab.type = "button";
                tab.className = "krea2-product-tab";
                tab.textContent = variantLabels[index] || `Prompt ${index + 1}`;
                tab.addEventListener("click", () => selectVariant(index));
                variantTabs.append(tab);
            });
            copyVariant.addEventListener("click", async () => {
                try {
                    await (modalDocument.defaultView?.navigator || navigator).clipboard.writeText(variants[selectedVariant]);
                    copyVariant.textContent = "Copied";
                    setTimeout(() => { if (copyVariant.isConnected) copyVariant.textContent = `Copy Prompt ${selectedVariant + 1}`; }, 1400);
                }
                catch { this.toast("Discord could not copy the selected prompt.", "error"); }
            });
            like.addEventListener("click", () => {
                try {
                    this.savePromptFeedback(variants[selectedVariant], "liked", "", job);
                    refreshFeedback();
                    this.toast("Prompt liked for this session.", "success");
                }
                catch (error) { this.toast(error instanceof Error ? error.message : String(error), "error"); }
            });
            dislike.addEventListener("click", async () => {
                const reason = await this.requestDislikeReason(variants[selectedVariant], modalDocument);
                if (reason === null) return;
                try {
                    this.savePromptFeedback(variants[selectedVariant], "disliked", reason, job);
                    refreshFeedback();
                    this.toast("Feedback kept for this session. This exact eight-prompt sample will not be reused during the session.", "success");
                }
                catch (error) { this.toast(error instanceof Error ? error.message : String(error), "error"); }
            });
            feedbackButtons.append(like, dislike);
            feedback.append(feedbackButtons, feedbackStatus);
            selectVariant(0);
            output.append(label, variantTabs, prompt, feedback, copyVariant);
        }
        else {
            const message = modalDocument.createElement("div");
            message.className = isHistoryJobActive(job) ? "krea2-history-stage" : "krea2-history-error";
            message.textContent = job.public_error || job.stage || (isHistoryJobActive(job) ? "Waiting for the local Vision worker…" : "This job has no saved prompt.");
            output.append(message);
        }
        result.append(source, output);
        fragment.append(result);
        return fragment;
    }

    createJobProductTabs(job, modalDocument, thumbnailUrl, showSelectedRegion = null) {
        const root = modalDocument.createElement("div");
        root.style.marginTop = "18px";
        const tabList = modalDocument.createElement("div");
        tabList.className = "krea2-product-tabs";
        const panels = modalDocument.createElement("div");
        const panelMap = new Map();
        const addTab = (label, key) => {
            const tab = modalDocument.createElement("button");
            tab.type = "button";
            tab.className = "krea2-product-tab";
            tab.textContent = label;
            tab.setAttribute("aria-selected", key === "workshop" ? "true" : "false");
            const panel = modalDocument.createElement("section");
            panel.className = "krea2-product-panel";
            panel.dataset.active = key === "workshop" ? "true" : "false";
            panel.style.paddingTop = "14px";
            tab.addEventListener("click", () => {
                for (const item of tabList.children) item.setAttribute("aria-selected", item === tab ? "true" : "false");
                for (const item of panels.children) item.dataset.active = item === panel ? "true" : "false";
            });
            tabList.append(tab);
            panels.append(panel);
            panelMap.set(key, panel);
        };
        for (const [label, key] of [["Workshop", "workshop"], ["Review", "review"], ["Compare models", "compare"], ["Reproducibility", "repro"], ["Describe region", "region"], ["Metadata", "metadata"], ["Similar", "similar"]]) addTab(label, key);

        const savedPath = this.findSavedOriginalPath(job.image_hash);
        const storedEdit = this.editedPrompts[job.image_hash];
        const originalPrompt = String(job.prompt_variants?.[0] || job.prompt || "");
        const workshop = panelMap.get("workshop");
        const editor = modalDocument.createElement("textarea");
        editor.className = "krea2-workshop-prompt";
        editor.value = typeof storedEdit?.prompt === "string" ? storedEdit.prompt : originalPrompt;
        editor.placeholder = "A completed prompt will appear here.";
        const preset = modalDocument.createElement("select");
        preset.className = "krea2-workshop-select";
        preset.style.maxWidth = "260px";
        for (const [label, value] of PROMPT_PRESETS) {
            const option = modalDocument.createElement("option");
            option.value = value;
            option.textContent = label;
            preset.append(option);
        }
        preset.value = this.settings.preferredPreset || DEFAULT_SETTINGS.preferredPreset;
        const toolbar = modalDocument.createElement("div");
        toolbar.className = "krea2-workshop-toolbar";
        const history = [editor.value];
        const makeButton = (label, handler, primary = false) => {
            const button = modalDocument.createElement("button");
            button.type = "button";
            button.className = "krea2-history-action";
            if (primary) button.dataset.primary = "true";
            button.textContent = label;
            button.addEventListener("click", handler);
            toolbar.append(button);
            return button;
        };
        const remember = value => {
            if (history.at(-1) !== value) history.push(value);
            while (history.length > 25) history.shift();
            editor.value = value;
        };
        makeButton("Apply preset", () => {
            this.settings.preferredPreset = preset.value;
            this.api.Data.save("settings", this.settings);
            remember(applyPromptPreset(editor.value, preset.value));
        });
        makeButton("Shorter", () => remember(applyPromptPreset(editor.value, "krea2-short")));
        makeButton("Lighting only", () => {
            const sentences = editor.value.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
            remember(sentences.filter(sentence => /\b(light|shadow|glow|sun|color|tone|contrast|reflection|atmosphere)\b/i.test(sentence)).join(" ").trim() || editor.value);
        });
        makeButton("Remove selected", () => {
            if (editor.selectionStart === editor.selectionEnd) return;
            remember(`${editor.value.slice(0, editor.selectionStart)}${editor.value.slice(editor.selectionEnd)}`.replace(/\s{2,}/g, " ").trim());
        });
        makeButton("More literal", () => {
            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            if (start === end) return;
            const selected = editor.value.slice(start, end).replace(/\b(?:stunning|beautiful|gorgeous|amazing|perfect|masterpiece|best quality|ultra[- ]?detailed)\b/gi, "").replace(/\s{2,}/g, " ").trim();
            remember(`${editor.value.slice(0, start)}${selected}${editor.value.slice(end)}`);
        });
        makeButton("Undo", () => {
            if (history.length <= 1) return;
            history.pop();
            editor.value = history.at(-1);
        });
        makeButton("Reset", () => remember(originalPrompt));
        const detailButton = makeButton("Regenerate with preset", async () => {
            if (!savedPath) return;
            detailButton.disabled = true;
            const started = Date.now();
            try {
                const generated = await this.runSavedImageModel(savedPath, job.image_hash, effectiveVisionModel(this.settings), elapsed => { detailButton.textContent = `Running ${elapsed}`; }, {
                    guidance: promptPresetGuidance(preset.value),
                    preset: preset.value,
                    datasetGuidance: this.settings.useKrea2DatasetGuidance === true
                });
                remember(generated.prompt);
                this.toast(`Prompt regenerated in ${formatHistoryDuration((Date.now() - started) / 1000)}.`, "success");
            }
            catch (error) { this.toast(error instanceof Error ? error.message : String(error), "error"); }
            finally { detailButton.disabled = false; detailButton.textContent = "Regenerate with preset"; }
        }, true);
        detailButton.disabled = !savedPath;
        makeButton("Keep edit this session", async () => {
            if (!editor.value.trim()) return;
            const clean = editor.value.normalize("NFKC").replace(/\r\n?/g, "\n").trim().slice(0, MAX_VISION_PROMPT_CHARS);
            this.editedPrompts[job.image_hash] = {prompt: clean, updated: Date.now()};
            const ordered = Object.entries(this.editedPrompts).sort((a, b) => Number(b[1]?.updated || 0) - Number(a[1]?.updated || 0)).slice(0, MAX_EDITED_PROMPTS);
            this.editedPrompts = Object.fromEntries(ordered);
            this.toast("Edited prompt is available for this Discord session only.", "success");
        }, true);
        makeButton("Copy KREA2", () => void this.copyProductText(editor.value, modalDocument));
        makeButton("Copy Forge", () => void this.copyProductText(editor.value.replace(/\s+/g, " ").trim(), modalDocument));
        const note = modalDocument.createElement("div");
        note.className = "krea2-workshop-note";
        note.textContent = "Strict privacy mode keeps edits in memory for this Discord session only. Nothing is written beside the image.";
        workshop.append(preset, toolbar, editor, note);

        const compare = panelMap.get("compare");
        const compareIntro = modalDocument.createElement("div");
        compareIntro.className = "krea2-workshop-note";
        compareIntro.textContent = "Runs 2B, 4B, then 8B sequentially. Each run releases the shared ticket before the next enters at the tail.";
        const compareRun = modalDocument.createElement("button");
        compareRun.type = "button";
        compareRun.className = "krea2-history-action";
        compareRun.dataset.primary = "true";
        compareRun.textContent = "Compare all three Heretic models";
        compareRun.disabled = !savedPath;
        const compareGrid = modalDocument.createElement("div");
        compareGrid.className = "krea2-compare-grid";
        compareRun.addEventListener("click", async () => {
            compareRun.disabled = true;
            compareGrid.replaceChildren();
            let modelTelemetry = new Map();
            try {
                const modelState = await this.fetchProductJson("/api/discord-models");
                modelTelemetry = new Map((modelState.models || []).map(item => [item.public_id, item]));
            }
            catch {}
            let previousPrompt = "";
            for (const [label, model] of [...VISION_MODEL_OPTIONS].filter(([, id]) => id.startsWith("llamacpp::")).reverse()) {
                const card = modalDocument.createElement("article");
                card.className = "krea2-compare-card";
                const title = modalDocument.createElement("h3");
                title.textContent = label;
                const meta = modalDocument.createElement("div");
                meta.className = "krea2-compare-meta";
                meta.textContent = "Waiting for shared FIFO…";
                const textNode = modalDocument.createElement("div");
                textNode.className = "krea2-compare-text";
                card.append(title, meta, textNode);
                compareGrid.append(card);
                const started = Date.now();
                try {
                    const generated = await this.runSavedImageModel(savedPath, job.image_hash, model, elapsed => { meta.textContent = `Running ${elapsed}`; }, {
                        guidance: promptPresetGuidance(preset.value),
                        preset: preset.value,
                        datasetGuidance: this.settings.useKrea2DatasetGuidance === true
                    });
                    const duration = (Date.now() - started) / 1000;
                    const diff = previousPrompt ? promptDiffSummary(previousPrompt, generated.prompt) : {added: [], removed: []};
                    const telemetry = modelTelemetry.get(model) || {};
                    const peak = Number(telemetry.last_measured_peak_mb || 0);
                    const estimate = Number(telemetry.estimated_vram_mb || 0);
                    meta.textContent = `${generated.prompt_words || generated.prompt.split(/\s+/).length} words · ${formatHistoryDuration(duration)} · peak ${peak ? `${peak.toLocaleString()} MiB` : "not measured"} · estimate ${estimate.toLocaleString()} MiB${diff.added.length ? ` · + ${diff.added.slice(0, 6).join(", ")}` : ""}`;
                    textNode.textContent = generated.prompt;
                    const choose = modalDocument.createElement("button");
                    choose.type = "button";
                    choose.className = "krea2-history-action";
                    choose.textContent = "Use this result";
                    choose.style.marginTop = "9px";
                    choose.addEventListener("click", () => remember(generated.prompt));
                    const savedScore = this.modelEvaluations[job.image_hash]?.[model] || {};
                    const scoreGrid = modalDocument.createElement("div");
                    scoreGrid.className = "krea2-score-grid";
                    const scoreInputs = {};
                    for (const key of ["pose", "subject", "clothing", "scene", "lighting"]) {
                        const wrapper = modalDocument.createElement("label");
                        wrapper.textContent = key[0].toUpperCase() + key.slice(1);
                        const select = modalDocument.createElement("select");
                        select.className = "krea2-score-select";
                        for (let value = 0; value <= 5; value += 1) {
                            const option = modalDocument.createElement("option");
                            option.value = String(value);
                            option.textContent = value ? String(value) : "—";
                            select.append(option);
                        }
                        select.value = String(savedScore[key] || 0);
                        wrapper.append(select);
                        scoreGrid.append(wrapper);
                        scoreInputs[key] = select;
                    }
                    const scoreNote = modalDocument.createElement("input");
                    scoreNote.className = "krea2-score-select";
                    scoreNote.placeholder = "Evaluation note";
                    scoreNote.value = String(savedScore.note || "");
                    scoreNote.style.marginTop = "8px";
                    const saveScore = modalDocument.createElement("button");
                    saveScore.type = "button";
                    saveScore.className = "krea2-history-action";
                    saveScore.textContent = "Save score";
                    saveScore.style.margin = "8px 6px 0 0";
                    const winner = modalDocument.createElement("button");
                    winner.type = "button";
                    winner.className = "krea2-history-action";
                    winner.textContent = savedScore.winner ? "Winner ✓" : "Mark winner";
                    winner.style.marginTop = "8px";
                    const persistScore = async winnerValue => {
                        const record = Object.fromEntries(Object.entries(scoreInputs).map(([key, input]) => [key, Number(input.value)]));
                        record.note = scoreNote.value;
                        record.winner = winnerValue;
                        this.saveModelEvaluation(job.image_hash, model, record);
                        winner.textContent = winnerValue ? "Winner ✓" : "Mark winner";
                        this.toast("Model evaluation is available for this session only.", "success");
                    };
                    saveScore.addEventListener("click", () => void persistScore(savedScore.winner === true));
                    winner.addEventListener("click", () => void persistScore(true));
                    card.append(choose, scoreGrid, scoreNote, saveScore, winner);
                    previousPrompt = generated.prompt;
                }
                catch (error) {
                    meta.textContent = "Run failed";
                    textNode.textContent = error instanceof Error ? error.message : String(error);
                }
            }
            compareRun.disabled = false;
            compareRun.textContent = "Run comparison again";
        });
        compare.append(compareIntro, compareRun, compareGrid);

        this.buildReviewPanel(panelMap.get("review"), {job, savedPath, modalDocument});
        this.buildReproducibilityPanel(panelMap.get("repro"), {job, savedPath, modalDocument});

        const region = panelMap.get("region");
        this.buildRegionPanel(region, {job, savedPath, thumbnailUrl, editor, modalDocument, showSelectedRegion});
        const metadata = panelMap.get("metadata");
        void this.buildMetadataPanel(metadata, {job, savedPath, modalDocument});
        const similar = panelMap.get("similar");
        this.buildSimilarPanel(similar, {job, savedPath, modalDocument});
        root.append(tabList, panels);
        return root;
    }

    buildReviewPanel(panel, {job, savedPath, modalDocument}) {
        const current = this.getHistoryReview(job.image_hash);
        const form = modalDocument.createElement("div");
        form.className = "krea2-review-form";
        const field = (label, control, wide = false) => {
            const wrapper = modalDocument.createElement("label");
            if (wide) wrapper.classList.add("krea2-review-wide");
            wrapper.append(document.createTextNode(label), control);
            form.append(wrapper);
            return control;
        };
        const collection = field("Collection", modalDocument.createElement("input"));
        collection.value = current.collection;
        collection.placeholder = "Unsorted";
        const status = field("Review state", modalDocument.createElement("select"));
        for (const [label, value] of [["Unreviewed", "unreviewed"], ["Training ready", "training-ready"], ["Needs correction", "needs-correction"], ["Excluded", "excluded"]]) {
            const option = modalDocument.createElement("option");
            option.value = value;
            option.textContent = label;
            status.append(option);
        }
        status.value = current.status;
        const rating = field("Dataset rating", modalDocument.createElement("select"));
        for (let value = 0; value <= 5; value += 1) {
            const option = modalDocument.createElement("option");
            option.value = String(value);
            option.textContent = value ? `${value} / 5` : "Not rated";
            rating.append(option);
        }
        rating.value = String(current.rating);
        const notes = field("Correction notes", modalDocument.createElement("textarea"), true);
        notes.value = current.notes;
        notes.placeholder = "Record pose, subject, clothing, scene, or lighting corrections before export.";
        const toolbar = modalDocument.createElement("div");
        toolbar.className = "krea2-workshop-toolbar krea2-review-wide";
        const save = modalDocument.createElement("button");
        save.type = "button";
        save.className = "krea2-history-action";
        save.dataset.primary = "true";
        save.textContent = "Save review";
        save.addEventListener("click", async () => {
            this.saveHistoryReview(job.image_hash, {collection: collection.value, status: status.value, rating: rating.value, notes: notes.value});
            this.toast("Dataset review is available for this session only.", "success");
        });
        toolbar.append(save);
        form.append(toolbar);
        panel.append(form);
    }

    buildReproducibilityPanel(panel, {job, savedPath, modalDocument}) {
        const record = safeReproducibility(job.reproducibility);
        const keys = Object.keys(record);
        if (!keys.length) {
            panel.textContent = "This older job has no exact model/runtime receipt. Retry it to create one.";
            return;
        }
        const grid = modalDocument.createElement("div");
        grid.className = "krea2-repro-grid";
        for (const key of keys) {
            const card = modalDocument.createElement("div");
            card.className = "krea2-info-card";
            const strong = modalDocument.createElement("strong");
            strong.textContent = key.replaceAll("_", " ");
            const value = modalDocument.createElement("div");
            value.textContent = String(record[key]);
            card.append(strong, value);
            grid.append(card);
        }
        const toolbar = modalDocument.createElement("div");
        toolbar.className = "krea2-workshop-toolbar";
        const copy = modalDocument.createElement("button");
        copy.type = "button";
        copy.className = "krea2-history-action";
        copy.dataset.primary = "true";
        copy.textContent = "Copy exact receipt JSON";
        copy.addEventListener("click", () => void this.copyProductText(JSON.stringify(record, null, 2), modalDocument));
        toolbar.append(copy);
        panel.append(grid, toolbar);
    }

    async copyProductText(value, modalDocument = document) {
        const text = String(value || "").trim();
        if (!text) return;
        try {
            await (modalDocument.defaultView?.navigator || navigator).clipboard.writeText(text);
            this.toast("Prompt copied.", "success");
        }
        catch { this.toast("Discord could not copy the prompt.", "error"); }
    }

    async buildMetadataPanel(panel, {job, savedPath, modalDocument}) {
        panel.textContent = "Inspecting the locally saved source…";
        if (!savedPath) {
            panel.textContent = "The locally saved source image is unavailable.";
            return;
        }
        try {
            const bytes = await readFileCompat(fs, savedPath);
            const format = detectImageFormat(bytes);
            if (!format) throw new Error("Unsupported saved-image format.");
            const extracted = await extractConfidentPrompt(bytes, format);
            const grid = modalDocument.createElement("div");
            grid.className = "krea2-meta-grid";
            const cards = [
                ["File", path.basename(savedPath)],
                ["Format", `${format.kind.toUpperCase()} · ${format.mimeType}`],
                ["Size", `${bytes.byteLength.toLocaleString()} bytes`],
                ["SHA-256", job.image_hash],
                ["Prompt metadata", extracted.classification],
                ["Container chunks", (extracted.chunks || []).map(chunk => `${chunk.name} (${chunk.size ?? "?"})`).join(", ") || "None detected"]
            ];
            for (const [label, value] of cards) {
                const card = modalDocument.createElement("div");
                card.className = "krea2-info-card";
                const strong = modalDocument.createElement("strong");
                strong.textContent = label;
                const textNode = modalDocument.createElement("div");
                textNode.textContent = value;
                card.append(strong, textNode);
                grid.append(card);
            }
            if (extracted.prompt) {
                const card = modalDocument.createElement("div");
                card.className = "krea2-info-card";
                card.style.gridColumn = "1 / -1";
                const strong = modalDocument.createElement("strong");
                strong.textContent = "Embedded positive prompt";
                const textNode = modalDocument.createElement("div");
                textNode.textContent = extracted.prompt;
                const copy = modalDocument.createElement("button");
                copy.type = "button";
                copy.className = "krea2-history-action";
                copy.style.marginTop = "9px";
                copy.textContent = "Copy embedded prompt";
                copy.addEventListener("click", () => void this.copyProductText(extracted.prompt, modalDocument));
                card.append(strong, textNode, copy);
                grid.append(card);
            }
            panel.replaceChildren(grid);
        }
        catch (error) { panel.textContent = error instanceof Error ? error.message : String(error); }
    }

    buildSimilarPanel(panel, {job, savedPath, modalDocument}) {
        const note = modalDocument.createElement("div");
        note.className = "krea2-workshop-note";
        note.textContent = "Finds visually related saved originals using a private 8×8 color-and-luminance embedding computed locally. Exact SHA duplicates are listed separately.";
        const run = modalDocument.createElement("button");
        run.type = "button";
        run.className = "krea2-history-action";
        run.dataset.primary = "true";
        run.textContent = "Find similar images";
        run.disabled = !savedPath;
        const list = modalDocument.createElement("div");
        list.className = "krea2-similar-list";
        run.addEventListener("click", async () => {
            run.disabled = true;
            list.textContent = "Computing local visual embeddings…";
            try {
                const target = await this.computeVisualEmbedding(savedPath, modalDocument);
                const candidates = [];
                const seen = new Set([job.image_hash]);
                for (const candidate of this.historyJobs) {
                    if (!candidate.image_hash || seen.has(candidate.image_hash)) continue;
                    seen.add(candidate.image_hash);
                    const candidatePath = this.findSavedOriginalPath(candidate.image_hash);
                    if (!candidatePath) continue;
                    try {
                        const embedding = await this.computeVisualEmbedding(candidatePath, modalDocument);
                        candidates.push({job: candidate, similarity: cosineSimilarity(target, embedding)});
                    }
                    catch {}
                    if (candidates.length >= 60) break;
                }
                candidates.sort((a, b) => b.similarity - a.similarity);
                list.replaceChildren();
                const duplicates = this.historyJobs.filter(candidate => candidate.id !== job.id && candidate.image_hash === job.image_hash);
                if (duplicates.length) {
                    const duplicate = modalDocument.createElement("div");
                    duplicate.className = "krea2-info-card";
                    duplicate.textContent = `${duplicates.length} additional job${duplicates.length === 1 ? "" : "s"} use the exact same SHA-256 source.`;
                    list.append(duplicate);
                }
                for (const candidate of candidates.slice(0, 8)) {
                    const card = modalDocument.createElement("button");
                    card.type = "button";
                    card.className = "krea2-similar-card";
                    card.textContent = `${Math.round(candidate.similarity * 100)}% · ${historyJobTitle(candidate.job)}`;
                    card.addEventListener("click", () => void this.openHistoryDetail(candidate.job.id));
                    list.append(card);
                }
                if (!list.children.length) list.textContent = "No other locally saved history images are available.";
            }
            catch (error) { list.textContent = error instanceof Error ? error.message : String(error); }
            finally { run.disabled = false; }
        });
        panel.append(note, run, list);
    }

    async computeVisualEmbedding(filePath, modalDocument = document) {
        const cacheKey = String(filePath);
        if (this.visualEmbeddingCache.has(cacheKey)) return this.visualEmbeddingCache.get(cacheKey);
        const bytes = await readFileCompat(fs, filePath);
        const format = detectImageFormat(bytes);
        if (!format) throw new Error("Cannot embed an unsupported image format.");
        const view = modalDocument.defaultView || window;
        const objectUrl = view.URL.createObjectURL(new view.Blob([bytes], {type: format.mimeType}));
        try {
            const image = await new Promise((resolve, reject) => {
                const element = new view.Image();
                element.onload = () => resolve(element);
                element.onerror = () => reject(new Error("The saved image could not be decoded for similarity."));
                element.src = objectUrl;
            });
            const canvas = modalDocument.createElement("canvas");
            canvas.width = VISUAL_EMBEDDING_SIZE;
            canvas.height = VISUAL_EMBEDDING_SIZE;
            const context = canvas.getContext("2d", {willReadFrequently: true});
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            const embedding = [];
            for (let index = 0; index < pixels.length; index += 4) {
                const r = pixels[index] / 255;
                const g = pixels[index + 1] / 255;
                const b = pixels[index + 2] / 255;
                embedding.push(r, g, b, (r * .299) + (g * .587) + (b * .114));
            }
            this.visualEmbeddingCache.set(cacheKey, embedding);
            while (this.visualEmbeddingCache.size > MAX_VISUAL_EMBEDDINGS) this.visualEmbeddingCache.delete(this.visualEmbeddingCache.keys().next().value);
            return embedding;
        }
        finally { view.URL.revokeObjectURL(objectUrl); }
    }

    buildRegionPanel(panel, {job, savedPath, thumbnailUrl, editor, modalDocument, showSelectedRegion}) {
        const note = modalDocument.createElement("div");
        note.className = "krea2-region-note";
        note.textContent = "Drag a box over the image, then analyze only that crop. The crop enters the same shared FIFO; after it runs, it replaces the source preview for this open result.";
        panel.append(note);
        if (!savedPath || !thumbnailUrl) {
            const missing = modalDocument.createElement("div");
            missing.className = "krea2-history-error";
            missing.style.marginTop = "10px";
            missing.textContent = "The locally saved source is unavailable for region analysis.";
            panel.append(missing);
            return;
        }
        const stage = modalDocument.createElement("div");
        stage.className = "krea2-region-stage";
        const canvas = modalDocument.createElement("canvas");
        canvas.className = "krea2-region-canvas";
        stage.append(canvas);
        const toolbar = modalDocument.createElement("div");
        toolbar.className = "krea2-workshop-toolbar";
        const analyze = modalDocument.createElement("button");
        analyze.type = "button";
        analyze.className = "krea2-history-action";
        analyze.dataset.primary = "true";
        analyze.textContent = "Describe selected region";
        analyze.disabled = true;
        const clear = modalDocument.createElement("button");
        clear.type = "button";
        clear.className = "krea2-history-action";
        clear.textContent = "Clear selection";
        toolbar.append(analyze, clear);
        const output = modalDocument.createElement("div");
        output.className = "krea2-workshop-note";
        panel.append(stage, toolbar, output);
        const view = modalDocument.defaultView || window;
        const image = new view.Image();
        let selection = null;
        let dragStart = null;
        const redraw = () => {
            if (!canvas.width || !canvas.height) return;
            const context = canvas.getContext("2d");
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            if (selection) {
                context.save();
                context.fillStyle = "rgba(10, 14, 22, .46)";
                context.fillRect(0, 0, canvas.width, canvas.height);
                context.clearRect(selection.x, selection.y, selection.w, selection.h);
                context.drawImage(image, selection.x, selection.y, selection.w, selection.h, selection.x, selection.y, selection.w, selection.h);
                context.strokeStyle = "#8b98ff";
                context.lineWidth = Math.max(2, canvas.width / 450);
                context.strokeRect(selection.x, selection.y, selection.w, selection.h);
                context.restore();
            }
        };
        image.onload = () => {
            const scale = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight));
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            redraw();
        };
        image.src = thumbnailUrl;
        const point = event => {
            const rect = canvas.getBoundingClientRect();
            return {
                x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
                y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height))
            };
        };
        canvas.addEventListener("pointerdown", event => {
            dragStart = point(event);
            selection = {x: dragStart.x, y: dragStart.y, w: 0, h: 0};
            canvas.setPointerCapture?.(event.pointerId);
            redraw();
        });
        canvas.addEventListener("pointermove", event => {
            if (!dragStart) return;
            const current = point(event);
            selection = {
                x: Math.min(dragStart.x, current.x),
                y: Math.min(dragStart.y, current.y),
                w: Math.abs(current.x - dragStart.x),
                h: Math.abs(current.y - dragStart.y)
            };
            analyze.disabled = selection.w < 24 || selection.h < 24;
            redraw();
        });
        const finishDrag = () => { dragStart = null; };
        canvas.addEventListener("pointerup", finishDrag);
        canvas.addEventListener("pointercancel", finishDrag);
        clear.addEventListener("click", () => {
            selection = null;
            analyze.disabled = true;
            output.textContent = "";
            redraw();
        });
        analyze.addEventListener("click", async () => {
            if (!selection || selection.w < 24 || selection.h < 24) return;
            analyze.disabled = true;
            try {
                const crop = modalDocument.createElement("canvas");
                crop.width = Math.max(24, Math.round(selection.w));
                crop.height = Math.max(24, Math.round(selection.h));
                crop.getContext("2d").drawImage(canvas, selection.x, selection.y, selection.w, selection.h, 0, 0, crop.width, crop.height);
                const blob = await new Promise((resolve, reject) => crop.toBlob(value => value ? resolve(value) : reject(new Error("Could not encode the selected crop.")), "image/png"));
                const cropPreviewUrl = view.URL.createObjectURL(blob);
                showSelectedRegion?.(cropPreviewUrl);
                const bytes = Buffer.from(await blob.arrayBuffer());
                const generated = await this.runVisionBytes(bytes, ".png", effectiveVisionModel(this.settings), elapsed => { output.textContent = `Region analysis running ${elapsed}`; }, "Describe this cropped region exhaustively and literally. Focus on details that may be easy to miss in the full image.");
                output.textContent = generated.prompt;
                editor.value = `${editor.value.trim()}\n\nSelected region detail: ${generated.prompt}`.trim();
                this.toast("Region detail added to the workshop prompt.", "success");
            }
            catch (error) {
                output.textContent = error instanceof Error ? error.message : String(error);
                this.toast(output.textContent, "error");
            }
            finally { analyze.disabled = false; }
        });
    }

    async runVisionBytes(bytes, extension, model, onElapsed, guidance = "") {
        const visionConfig = this.getVisionConfig();
        if (!visionConfig) throw new Error("Configure the local Vision endpoint and token first.");
        if (!VISION_MODEL_IDS.has(model)) throw new Error("The selected Vision model is unavailable.");
        const format = detectImageFormat(bytes);
        if (!format || !isVisionSupportedFormat(format)) throw new Error("The selected region is not a supported image.");
        const sha256 = sha256Hex(bytes);
        const queuedGeneration = this.generation;
        const flow = this.visionFlowQueue.then(async () => {
            if (!this.running || queuedGeneration !== this.generation) throw new Error("The plugin stopped before region analysis began.");
            const controller = new AbortController();
            this.controllers.add(controller);
            try {
                return await this.requestVisionPrompt(
                    {bytes, sha256, format},
                    {filePath: "", filename: `${sha256}${extension || format.extension}`},
                    visionConfig,
                    controller.signal,
                    onElapsed,
                    {
                        model,
                        guidance,
                        preset: this.settings.preferredPreset,
                        datasetGuidance: this.settings.useKrea2DatasetGuidance === true
                    }
                );
            }
            finally { this.controllers.delete(controller); }
        });
        this.visionFlowQueue = flow.catch(() => {});
        return flow;
    }

    async openProductTools(initialTab = "batch") {
        const runtime = this.api.Data.load("runtimeState") || {};
        this.api.Data.save("runtimeState", {...runtime, toolsOpenedAt: Date.now(), toolsInitialTab: initialTab});
        this.historyModalCleanup?.();
        const modalDocument = this.historyRoot?.ownerDocument || document;
        modalDocument.getElementById(PRODUCT_MODAL_ID)?.remove();
        const overlay = modalDocument.createElement("div");
        overlay.id = PRODUCT_MODAL_ID;
        overlay.setAttribute("role", "presentation");
        overlay.style.cssText = "position:fixed;z-index:10000;inset:0;display:grid;place-items:center;padding:24px;color:#f3f5f7;-webkit-text-fill-color:#f3f5f7;background:rgba(5,7,10,.78);backdrop-filter:blur(4px)";
        const dialog = modalDocument.createElement("section");
        dialog.className = "krea2-history-dialog";
        dialog.dataset.product = "true";
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-label", "KREA2 Vision product tools");
        const head = modalDocument.createElement("div");
        head.className = "krea2-history-dialog-head";
        const heading = modalDocument.createElement("h2");
        heading.textContent = "KREA2 Vision Tools";
        const close = modalDocument.createElement("button");
        close.type = "button";
        close.className = "krea2-history-icon";
        close.textContent = "×";
        close.setAttribute("aria-label", "Close Vision tools");
        head.append(heading, close);
        const tabs = modalDocument.createElement("div");
        tabs.className = "krea2-product-tabs";
        const body = modalDocument.createElement("div");
        body.className = "krea2-history-dialog-body";
        const panels = new Map();
        const switchTab = key => {
            for (const button of tabs.children) button.setAttribute("aria-selected", button.dataset.key === key ? "true" : "false");
            for (const [panelKey, panel] of panels) panel.dataset.active = panelKey === key ? "true" : "false";
            if (key === "health") void this.renderHealthPanel(panels.get("health"), modalDocument);
            if (key === "collections") this.renderCollectionsPanel(panels.get("collections"), modalDocument);
            if (key === "privacy") this.renderPrivacyPanel(panels.get("privacy"), modalDocument);
            if (key === "repair") void this.renderRepairPanel(panels.get("repair"), modalDocument);
        };
        for (const [label, key] of [["Batch queue", "batch"], ["Collections & export", "collections"], ["Models & GPU health", "health"], ["Repair center", "repair"], ["Privacy receipt", "privacy"], ["Presets", "presets"]]) {
            const tab = modalDocument.createElement("button");
            tab.type = "button";
            tab.className = "krea2-product-tab";
            tab.dataset.key = key;
            tab.textContent = label;
            tab.addEventListener("click", () => switchTab(key));
            tabs.append(tab);
            const panel = modalDocument.createElement("section");
            panel.className = "krea2-product-panel";
            body.append(panel);
            panels.set(key, panel);
        }
        this.renderBatchPanel(panels.get("batch"), modalDocument);
        this.renderPresetsPanel(panels.get("presets"), modalDocument);
        switchTab(panels.has(initialTab) ? initialTab : "batch");
        dialog.append(head, tabs, body);
        overlay.append(dialog);
        modalDocument.body.append(overlay);
        const cleanup = () => {
            modalDocument.removeEventListener("keydown", onKey);
            overlay.remove();
            if (this.historyModalCleanup === cleanup) this.historyModalCleanup = null;
        };
        const onKey = event => { if (event.key === "Escape") cleanup(); };
        this.historyModalCleanup = cleanup;
        close.addEventListener("click", cleanup);
        overlay.addEventListener("click", event => { if (event.target === overlay) cleanup(); });
        modalDocument.addEventListener("keydown", onKey);
        close.focus();
    }

    renderCollectionsPanel(panel, modalDocument) {
        panel.replaceChildren();
        const records = Object.values(this.historyReviews).map(sanitizeReviewRecord);
        const collections = new Map();
        for (const record of records) collections.set(record.collection, (collections.get(record.collection) || 0) + 1);
        const grid = modalDocument.createElement("div");
        grid.className = "krea2-health-grid";
        const cards = [
            ["Reviewed", String(records.filter(item => item.status !== "unreviewed").length)],
            ["Training ready", String(records.filter(item => item.status === "training-ready").length)],
            ["Needs correction", String(records.filter(item => item.status === "needs-correction").length)],
            ["Excluded", String(records.filter(item => item.status === "excluded").length)],
            ["Collections", [...collections.entries()].map(([name, count]) => `${name} (${count})`).join("\n") || "No collections yet"]
        ];
        for (const [label, value] of cards) {
            const card = modalDocument.createElement("div");
            card.className = "krea2-info-card";
            const strong = modalDocument.createElement("strong");
            strong.textContent = label;
            const text = modalDocument.createElement("div");
            text.style.whiteSpace = "pre-wrap";
            text.textContent = value;
            card.append(strong, text);
            grid.append(card);
        }
        const note = modalDocument.createElement("div");
        note.className = "krea2-workshop-note";
        note.textContent = "Review individual results in their Review tab. Export contains prompt, hash, review state, model evaluation, and exact reproducibility receipt—never an absolute local path, token, signed Discord URL, or image bytes.";
        const exportButton = modalDocument.createElement("button");
        exportButton.type = "button";
        exportButton.className = "krea2-history-action";
        exportButton.dataset.primary = "true";
        exportButton.style.marginTop = "12px";
        exportButton.textContent = "Export reviewed JSONL";
        exportButton.addEventListener("click", async () => {
            exportButton.disabled = true;
            try {
                const result = await this.exportReviewedDataset();
                this.toast(`Exported ${result.count} reviewed item${result.count === 1 ? "" : "s"} to ${result.filePath}`, "success");
            }
            catch (error) { this.toast(error instanceof Error ? error.message : String(error), "error"); }
            finally { exportButton.disabled = false; }
        });
        panel.append(grid, note, exportButton);
    }

    renderPrivacyPanel(panel, modalDocument) {
        panel.replaceChildren();
        const receipt = this.api.Data.load("privacyReceipt");
        const box = modalDocument.createElement("div");
        box.className = "krea2-privacy-receipt";
        box.textContent = this.settings.shareDatasetContributions === true
            ? `Automatic three-prompt contribution is enabled${receipt?.acceptedAt ? `; consent recorded ${new Date(receipt.acceptedAt).toLocaleString()}` : ", but no current receipt is recorded"}. It uses the authenticated local Vision broker; no Seedframe token is stored in BetterDiscord.`
            : "Automatic three-prompt contribution is off. Vision still works, but generated prompts are not submitted to Krea2.";
        const fields = modalDocument.createElement("div");
        fields.className = "krea2-info-card";
        fields.style.marginTop = "10px";
        fields.innerHTML = "<strong>What automatic contribution sends</strong>The three generated prompts, model and pipeline identifiers, contribution contract version, and anonymous installation provenance. It does not send image bytes, image hashes, signed CDN URLs, Discord identifiers, filenames, local file paths, Vision tokens, queue tickets, reviews, or model evidence.";
        const revoke = modalDocument.createElement("button");
        revoke.type = "button";
        revoke.className = "krea2-history-action";
        revoke.style.marginTop = "12px";
        revoke.textContent = "Revoke shared contribution consent";
        revoke.disabled = this.settings.shareDatasetContributions !== true && !receipt;
        revoke.addEventListener("click", () => {
            this.settings.shareDatasetContributions = false;
            this.api.Data.delete?.("privacyReceipt");
            this.api.Data.save("privacyReceipt", null);
            this.saveSettings();
            this.renderPrivacyPanel(panel, modalDocument);
            this.toast("Automatic prompt contribution disabled. Vision will continue without submitting generated prompts.", "success");
        });
        panel.append(box, fields, revoke);
    }

    async renderRepairPanel(panel, modalDocument) {
        panel.textContent = "Running local repair scan…";
        const report = {
            checked_at: new Date().toISOString(),
            plugin: {version: PLUGIN_VERSION, file: path.basename(__filename), source_directory: __dirname},
            settings: {
                save_folder_valid: validateSaveFolder(this.settings.saveFolder).ok,
                vision_endpoint_valid: validateVisionLoopbackEndpoint(this.settings.visionEndpoint).ok,
                vision_token_present: String(this.settings.visionToken || "").length >= 32,
                allowed_servers: parseGuildAllowlist(this.settings.allowedGuildIds).size
            },
            backend: null
        };
        try { report.backend = await this.fetchProductJson("/health"); }
        catch (error) { report.backend = {ok: false, error: error instanceof Error ? error.message : String(error)}; }
        panel.replaceChildren();
        const card = modalDocument.createElement("div");
        card.className = "krea2-info-card";
        const passed = report.settings.save_folder_valid && report.settings.vision_endpoint_valid && report.settings.vision_token_present && report.backend?.ok;
        card.innerHTML = `<strong>${passed ? "Repair scan passed" : "Repair attention needed"}</strong>${passed ? "Plugin settings, local storage, and Vision backend are reachable." : "Copy the report below; the Windows installer can repair plugin/backend files without downloading models again."}`;
        const copy = modalDocument.createElement("button");
        copy.type = "button";
        copy.className = "krea2-history-action";
        copy.dataset.primary = "true";
        copy.style.marginTop = "12px";
        copy.textContent = "Copy repair report";
        copy.addEventListener("click", () => void this.copyProductText(JSON.stringify(report, null, 2), modalDocument));
        const folder = modalDocument.createElement("div");
        folder.className = "krea2-workshop-note";
        folder.textContent = `Installer and repair files are distributed with the open-source suite. Plugin folder: ${__dirname}`;
        panel.append(card, copy, folder);
    }

    renderPresetsPanel(panel, modalDocument) {
        panel.replaceChildren();
        const intro = modalDocument.createElement("div");
        intro.className = "krea2-workshop-note";
        intro.textContent = "Choose the default emphasis used by Prompt Workshop, model comparison, and batch interrogation. The model remains evidence-grounded.";
        const grid = modalDocument.createElement("div");
        grid.className = "krea2-health-grid";
        grid.style.marginTop = "12px";
        for (const [label, value] of PROMPT_PRESETS) {
            const card = modalDocument.createElement("button");
            card.type = "button";
            card.className = "krea2-info-card";
            card.style.textAlign = "left";
            card.style.cursor = "pointer";
            const strong = modalDocument.createElement("strong");
            strong.textContent = `${this.settings.preferredPreset === value ? "✓ " : ""}${label}`;
            const description = modalDocument.createElement("div");
            description.textContent = promptPresetGuidance(value);
            card.append(strong, description);
            card.addEventListener("click", () => {
                this.settings.preferredPreset = value;
                this.api.Data.save("settings", this.settings);
                this.renderPresetsPanel(panel, modalDocument);
            });
            grid.append(card);
        }
        panel.append(intro, grid);
    }

    renderBatchPanel(panel, modalDocument) {
        panel.replaceChildren();
        const selectedJobs = this.historyJobs.filter(job => this.batchSelected.has(job.id));
        const intro = modalDocument.createElement("div");
        intro.className = "krea2-workshop-note";
        intro.textContent = `${selectedJobs.length} history image${selectedJobs.length === 1 ? "" : "s"} selected. Batch jobs run one at a time and each re-enters the shared FIFO independently.`;
        const toolbar = modalDocument.createElement("div");
        toolbar.className = "krea2-workshop-toolbar";
        const add = modalDocument.createElement("button");
        add.type = "button";
        add.className = "krea2-history-action";
        add.dataset.primary = "true";
        add.textContent = "Add selected to batch";
        add.disabled = !selectedJobs.length;
        add.addEventListener("click", () => {
            const existing = new Set(this.batchItems.filter(item => item.status === "pending" || item.status === "running").map(item => item.jobId));
            for (const job of selectedJobs) {
                if (existing.has(job.id)) continue;
                const filePath = this.findSavedOriginalPath(job.image_hash);
                if (filePath) this.batchItems.push({id: randomBytes(8).toString("hex"), jobId: job.id, imageHash: job.image_hash, title: historyJobTitle(job), filePath, status: "pending", prompt: "", error: "", elapsed: ""});
            }
            this.batchSelected.clear();
            this.renderHistoryRail();
            this.renderBatchPanel(panel, modalDocument);
        });
        const start = modalDocument.createElement("button");
        start.type = "button";
        start.className = "krea2-history-action";
        start.textContent = this.batchPaused ? "Resume batch" : this.batchRunning ? "Batch running" : "Start batch";
        start.disabled = this.batchRunning && !this.batchPaused;
        start.addEventListener("click", () => {
            this.batchPaused = false;
            void this.processBatchQueue(panel, modalDocument);
            this.renderBatchPanel(panel, modalDocument);
        });
        const pause = modalDocument.createElement("button");
        pause.type = "button";
        pause.className = "krea2-history-action";
        pause.textContent = "Pause after current";
        pause.disabled = !this.batchRunning || this.batchPaused;
        pause.addEventListener("click", () => {
            this.batchPaused = true;
            this.renderBatchPanel(panel, modalDocument);
        });
        const cancel = modalDocument.createElement("button");
        cancel.type = "button";
        cancel.className = "krea2-history-action";
        cancel.textContent = "Cancel pending";
        cancel.addEventListener("click", () => {
            for (const item of this.batchItems) if (item.status === "pending") item.status = "cancelled";
            this.renderBatchPanel(panel, modalDocument);
        });
        const cancelVision = modalDocument.createElement("button");
        cancelVision.type = "button";
        cancelVision.className = "krea2-history-action";
        cancelVision.textContent = "Cancel active Vision jobs";
        cancelVision.disabled = ![...this.getLocalVisionHistoryJobs(), ...this.historyJobs].some(isHistoryJobActive);
        cancelVision.addEventListener("click", async () => {
            cancelVision.disabled = true;
            const jobs = [...this.getLocalVisionHistoryJobs(), ...this.historyJobs].filter(isHistoryJobActive);
            for (const job of jobs) {
                try { await this.cancelVisionJob(job); }
                catch {}
            }
            void this.refreshHistory(true);
        });
        const clearFinished = modalDocument.createElement("button");
        clearFinished.type = "button";
        clearFinished.className = "krea2-history-action";
        clearFinished.textContent = "Clear finished history";
        clearFinished.addEventListener("click", () => {
            const clearButton = this.historyRoot?.querySelector(".krea2-history-page-clear");
            if (clearButton instanceof HTMLButtonElement) clearButton.click();
            else this.toast("Open Prompt History to clear saved history.", "info");
        });
        toolbar.append(add, start, pause, cancel, cancelVision, clearFinished);
        const list = modalDocument.createElement("div");
        for (const [index, item] of this.batchItems.entries()) {
            const row = modalDocument.createElement("div");
            row.className = "krea2-batch-row";
            const textNode = modalDocument.createElement("div");
            textNode.textContent = `${item.title} · ${item.status}${item.elapsed ? ` · ${item.elapsed}` : ""}${item.error ? ` · ${item.error}` : ""}`;
            const actions = modalDocument.createElement("div");
            actions.className = "krea2-batch-actions";
            for (const [symbol, delta] of [["↑", -1], ["↓", 1]]) {
                const move = modalDocument.createElement("button");
                move.type = "button";
                move.className = "krea2-history-mini";
                move.textContent = symbol;
                move.disabled = item.status !== "pending" || index + delta < 0 || index + delta >= this.batchItems.length;
                move.addEventListener("click", () => {
                    const target = index + delta;
                    [this.batchItems[index], this.batchItems[target]] = [this.batchItems[target], this.batchItems[index]];
                    this.renderBatchPanel(panel, modalDocument);
                });
                actions.append(move);
            }
            row.append(textNode, actions);
            list.append(row);
        }
        if (!this.batchItems.length) list.textContent = "Choose + on history cards, then add those saved originals here.";
        const completed = this.batchItems.filter(item => item.status === "completed").length;
        const failed = this.batchItems.filter(item => item.status === "error").length;
        const summary = modalDocument.createElement("div");
        summary.className = "krea2-workshop-note";
        summary.textContent = `Completed ${completed} · Failed ${failed} · Pending ${this.batchItems.filter(item => item.status === "pending").length}`;
        panel.append(intro, toolbar, list, summary);
    }

    async processBatchQueue(panel, modalDocument) {
        if (this.batchRunning) return;
        this.batchRunning = true;
        try {
            while (!this.batchPaused) {
                const item = this.batchItems.find(candidate => candidate.status === "pending");
                if (!item) break;
                item.status = "running";
                item.elapsed = "0:00";
                this.renderBatchPanel(panel, modalDocument);
                try {
                    const generated = await this.runSavedImageModel(item.filePath, item.imageHash, effectiveVisionModel(this.settings), elapsed => {
                        item.elapsed = elapsed;
                        if (panel.isConnected) this.renderBatchPanel(panel, modalDocument);
                    }, {
                        guidance: promptPresetGuidance(this.settings.preferredPreset),
                        preset: this.settings.preferredPreset,
                        datasetGuidance: this.settings.useKrea2DatasetGuidance === true
                    });
                    item.prompt = generated.prompt;
                    item.model = generated.model;
                    item.status = "completed";
                }
                catch (error) {
                    item.status = "error";
                    item.error = error instanceof Error ? error.message : String(error);
                }
                if (panel.isConnected) this.renderBatchPanel(panel, modalDocument);
            }
        }
        finally {
            this.batchRunning = false;
            if (panel.isConnected) this.renderBatchPanel(panel, modalDocument);
            const completed = this.batchItems.filter(item => item.status === "completed").length;
            const failed = this.batchItems.filter(item => item.status === "error").length;
            if (!this.batchPaused && (completed || failed)) this.toast(`Batch finished: ${completed} completed, ${failed} failed.`, failed ? "warning" : "success");
        }
    }

    async fetchProductJson(relativePath) {
        const baseUrl = historyBaseUrlFromVisionEndpoint(this.settings.visionEndpoint);
        const expectedUrl = `${baseUrl}${relativePath}`;
        const response = await this.api.Net.fetch(expectedUrl, {method: "GET", headers: {Accept: "application/json"}, redirect: "manual", maxRedirects: 0, timeout: 15000});
        if (response.redirected || !response.ok || (response.url && response.url !== expectedUrl)) throw new Error(`${relativePath} returned HTTP ${response.status}.`);
        return JSON.parse(await readBoundedResponseText(response, HISTORY_MAX_RESPONSE_BYTES));
    }

    async ensureRemoteLicense(signal) {
        const saved = this.settings.remoteLicense;
        if (saved && Number(saved.authVersion) === 2 && /^lic_[A-Za-z0-9_-]{12,64}$/.test(String(saved.licenseId || "")) && /^[\x21-\x7e]{43,160}$/.test(String(saved.licenseToken || ""))) return saved;
        let installationId = String(this.api.Data.load("remoteVisionInstallationId") || "");
        if (!/^[A-Za-z0-9_-]{24,128}$/.test(installationId)) {
            installationId = randomBytes(32).toString("base64url");
            this.api.Data.save("remoteVisionInstallationId", installationId);
        }
        const enrollmentId = `enr_${randomBytes(32).toString("base64url")}`;
        const enrollmentSecret = randomBytes(48).toString("base64url");
        let response;
        try {
            response = await this.api.Net.fetch(`${REMOTE_GATEWAY_URL}/v1/oauth/start`, {method:"POST",headers:{Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify({installation_id:installationId,enrollment_id:enrollmentId,enrollment_secret:enrollmentSecret}),redirect:"manual",maxRedirects:0,timeout:15000,signal});
        }
        catch (error) { throw new Error("The Online API Discord sign-in service is unavailable. Retry shortly."); }
        const responseText = await readBoundedResponseText(response, 64 * 1024);
        if (!response.ok) throw new Error(`Online API Discord sign-in failed with HTTP ${response.status}${parseStudioErrorDetail(responseText) ? `: ${parseStudioErrorDetail(responseText)}` : "."}`);
        let issued;
        try { issued = JSON.parse(responseText); }
        catch { throw new Error("The Online API Discord sign-in service returned invalid JSON."); }
        const authorizeUrl = String(issued?.authorize_url || "");
        if (!/^https:\/\/discord\.com\/oauth2\/authorize\?/.test(authorizeUrl) || String(issued?.enrollment_id || "") !== enrollmentId) throw new Error("The Online API Discord sign-in service returned an invalid authorization link.");
        const accepted = await this.confirmRemoteOAuth();
        if (!accepted) throw new Error("Discord sign-in was cancelled. Local GPU mode remains available without an account.");
        try {
            const external = this.api.Webpack.getModule?.(module => typeof module?.openExternal === "function", {searchExports:true});
            if (external?.openExternal) external.openExternal(authorizeUrl);
            else window.open(authorizeUrl, "_blank", "noopener,noreferrer");
        }
        catch { throw new Error("Could not open Discord sign-in. Allow Discord to open links, then retry."); }
        const deadline = Date.now() + Math.max(60, Math.min(Number(issued?.expires_in_seconds || 600), 600)) * 1000;
        while (Date.now() < deadline) {
            if (signal?.aborted) throw new Error("Discord sign-in was cancelled.");
            await new Promise(resolve => setTimeout(resolve, 1500));
            let statusResponse;
            try {
                statusResponse = await this.api.Net.fetch(`${REMOTE_GATEWAY_URL}/v1/oauth/status/${encodeURIComponent(enrollmentId)}`, {method:"GET",headers:{Accept:"application/json","X-Krea2-Enrollment-Secret":enrollmentSecret},redirect:"manual",maxRedirects:0,timeout:15000,signal});
            }
            catch { continue; }
            const statusText = await readBoundedResponseText(statusResponse, 64 * 1024);
            let status;
            try { status = JSON.parse(statusText); }
            catch { throw new Error("The Online API Discord sign-in service returned invalid JSON."); }
            if (!statusResponse.ok) throw new Error(String(status?.detail || `Discord sign-in failed with HTTP ${statusResponse.status}.`));
            if (status?.status === "pending") continue;
            if (status?.status !== "complete") throw new Error(status?.status === "denied" ? "Discord sign-in was denied. Local GPU mode remains available without an account." : "Discord sign-in expired. Start Online API again.");
            const license = Object.freeze({authVersion:2,licenseId:String(status?.license_id || ""),licenseToken:String(status?.license_token || ""),discordUsername:String(status?.discord_username || "").slice(0,80)});
            if (!/^lic_[A-Za-z0-9_-]{12,64}$/.test(license.licenseId) || !/^[\x21-\x7e]{43,160}$/.test(license.licenseToken)) throw new Error("The Online API Discord sign-in service returned invalid credentials.");
            this.settings.remoteLicense = license;
            this.saveSettings();
            return license;
        }
        throw new Error("Discord sign-in timed out. Start Online API again.");
    }

    async remoteCreditStatus(license, signal) {
        let response;
        try {
            response = await this.api.Net.fetch(`${REMOTE_GATEWAY_URL}/v1/credits/balance`, {
                method: "GET", redirect: "manual", maxRedirects: 0, timeout: 15000, signal,
                headers: {Accept:"application/json", Authorization:`Krea2License ${license.licenseId}.${license.licenseToken}`}
            });
        }
        catch { throw new Error("The Online API credit service is unavailable. Retry shortly."); }
        const text = await readBoundedResponseText(response, 64 * 1024);
        let status;
        try { status = JSON.parse(text); }
        catch { throw new Error("The Online API credit service returned invalid JSON."); }
        if (!response.ok) throw new Error(String(status?.detail || `Online API credit check failed with HTTP ${response.status}.`));
        if (!Number.isInteger(status?.available_credits) || !Number.isInteger(status?.credits_per_image) || status.credits_per_image !== 3) throw new Error("The Online API credit balance is invalid.");
        return status;
    }

    async ensureRemoteCredits(signal) {
        const license = await this.ensureRemoteLicense(signal);
        let status = await this.remoteCreditStatus(license, signal);
        if (status.available_credits >= status.credits_per_image) return license;
        if (!status.payments_configured) throw new Error("Online API credits are exhausted and Bitcoin checkout is not configured yet. Select Local GPU or retry later.");
        const accepted = await this.confirmCreditPurchase(status);
        if (!accepted) throw new Error("Online API credits are required. Select Local GPU or purchase credits to continue.");
        let invoiceResponse;
        try {
            invoiceResponse = await this.api.Net.fetch(`${REMOTE_GATEWAY_URL}/v1/credits/purchase`, {
                method:"POST", redirect:"manual", maxRedirects:0, timeout:15000, signal,
                headers:{Accept:"application/json", "Content-Type":"application/json", Authorization:`Krea2License ${license.licenseId}.${license.licenseToken}`},
                body:JSON.stringify({confirmation:"buy-1200-credits"})
            });
        }
        catch { throw new Error("Bitcoin checkout is unavailable. Retry shortly."); }
        const invoiceText = await readBoundedResponseText(invoiceResponse, 64 * 1024);
        let invoice;
        try { invoice = JSON.parse(invoiceText); }
        catch { throw new Error("Bitcoin checkout returned invalid JSON."); }
        if (!invoiceResponse.ok) throw new Error(String(invoice?.detail || `Bitcoin checkout failed with HTTP ${invoiceResponse.status}.`));
        const checkoutUrl = String(invoice?.checkout_url || "");
        if (!/^https:\/\//.test(checkoutUrl)) throw new Error("Bitcoin checkout returned an invalid payment link.");
        try {
            const external = this.api.Webpack.getModule?.(module => typeof module?.openExternal === "function", {searchExports:true});
            if (external?.openExternal) external.openExternal(checkoutUrl);
            else window.open(checkoutUrl, "_blank", "noopener,noreferrer");
        }
        catch { throw new Error("Could not open Bitcoin checkout. Allow Discord to open links, then retry."); }
        const deadline = Date.now() + 30 * 60 * 1000;
        while (Date.now() < deadline) {
            if (signal?.aborted) throw new Error("Bitcoin payment wait was cancelled.");
            await new Promise(resolve => setTimeout(resolve, 4000));
            status = await this.remoteCreditStatus(license, signal);
            if (status.available_credits >= status.credits_per_image) {
                this.toast(`Online API credits added: ${status.available_credits} available.`, "success");
                return license;
            }
        }
        throw new Error("Bitcoin payment is still awaiting settlement. Credits will appear automatically after the invoice settles.");
    }

    confirmCreditPurchase(status) {
        return new Promise(resolve => {
            const content = document.createElement("div");
            content.style.cssText = "line-height:1.55;color:var(--text-normal)";
            const lead = document.createElement("p");
            lead.textContent = `Online API needs 3 credits per image. You have ${status.available_credits} credits remaining.`;
            const detail = document.createElement("p");
            detail.textContent = "Purchase 1,200 credits for $20 USD paid in Bitcoin. That covers 400 successful images; a failed or cancelled image is automatically refunded.";
            content.append(lead, detail);
            this.api.UI.showConfirmationModal("Purchase Online API credits", content, {
                confirmText: "Open Bitcoin checkout", cancelText: "Use Local GPU", danger: false,
                onConfirm: () => resolve(true), onCancel: () => resolve(false)
            });
        });
    }

    confirmRemoteOAuth() {
        return new Promise(resolve => {
            const content = document.createElement("div");
            content.style.cssText = "line-height:1.55;color:var(--text-normal)";
            const lead = document.createElement("p");
            lead.textContent = "Online API uses KREA2's remote Gemma worker. Connect Discord once so the service can issue a revocable account license, grant 120 introductory credits, and enforce its terms and rate limits.";
            const list = document.createElement("ul");
            for (const text of [
                "Discord handles the sign-in. KREA2 never receives your Discord password.",
                "Only Discord's basic identify permission is requested to verify the account.",
                "Local GPU mode remains private and never requires a Discord sign-in."
            ]) { const item = document.createElement("li"); item.textContent = text; list.append(item); }
            content.append(lead, list);
            this.api.UI.showConfirmationModal("Connect Discord for Online API", content, {
                confirmText: "Connect Discord", cancelText: "Use Local GPU", danger: false,
                onConfirm: () => resolve(true), onCancel: () => resolve(false)
            });
        });
    }

    async issueVisionSession(visionConfig, idempotencyKey, model, signal, sourceUrl = "") {
        const expectedUrl = `${visionConfig.origin}/api/discord-session`;
        const remoteLicense = model === ONLINE_VISION_MODEL_ID ? await this.ensureRemoteCredits(signal) : null;
        const response = await this.api.Net.fetch(expectedUrl, {
            method: "POST",
            redirect: "manual",
            maxRedirects: 0,
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-Krea2-Collector-Version": PLUGIN_VERSION,
                "X-Krea2-Vision-Token": visionConfig.token
            },
            body: JSON.stringify({
                idempotency_key: idempotencyKey,
                model,
                remote_license_id: remoteLicense?.licenseId || "",
                remote_license_token: remoteLicense?.licenseToken || "",
                source_url: String(sourceUrl || "").slice(0, 2048)
            }),
            signal,
            timeout: 15000
        });
        if (response.redirected || (response.url && response.url !== expectedUrl)) {
            throw new Error("The local Vision session broker attempted a redirect.");
        }
        const responseText = await readBoundedResponseText(response, 64 * 1024);
        if (!response.ok) {
            const detail = parseStudioErrorDetail(responseText);
            throw new Error(`Vision session authorization failed with HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
        }
        let payload;
        try { payload = JSON.parse(responseText); }
        catch { throw new Error("The local Vision session broker returned malformed JSON."); }
        const sessionToken = String(payload?.session_token || "").trim();
        if (!payload?.one_time || !/^[\x21-\x7e]{32,512}$/.test(sessionToken)) {
            throw new Error("The local Vision session broker returned an invalid one-use session.");
        }
        return sessionToken;
    }

    async requestVisionModelInstall(publicId, method) {
        if (!VISION_MODEL_IDS.has(publicId) || !publicId.startsWith("llamacpp::")) throw new Error("Unsupported pinned Vision model.");
        const vision = this.getVisionConfig();
        if (!vision) throw new Error("Configure the local Vision endpoint and token first.");
        const relativePath = method === "POST"
            ? "/api/discord-models/install"
            : `/api/discord-models/install/${encodeURIComponent(publicId)}`;
        const expectedUrl = `${vision.origin}${relativePath}`;
        const headers = {Accept: "application/json", "X-Krea2-Vision-Token": vision.token};
        const options = {method, headers, redirect: "manual", maxRedirects: 0, timeout: 15000};
        if (method === "POST") {
            headers["Content-Type"] = "application/json";
            options.body = JSON.stringify({model: publicId});
        }
        const response = await this.api.Net.fetch(expectedUrl, options);
        const text = await readBoundedResponseText(response, HISTORY_MAX_RESPONSE_BYTES);
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; }
        catch { throw new Error("The local Vision installer returned malformed JSON."); }
        if (response.redirected || (response.url && response.url !== expectedUrl)) throw new Error("The local Vision installer attempted a redirect.");
        if (!response.ok) throw new Error(String(payload.detail || `Model installation returned HTTP ${response.status}.`));
        return payload;
    }

    async startVisionModelInstall(publicId) {
        return this.requestVisionModelInstall(publicId, "POST");
    }

    async fetchVisionModelInstallStatus(publicId) {
        return this.requestVisionModelInstall(publicId, "GET");
    }

    async postVisionControl(relativePath) {
        const vision = this.getVisionConfig();
        if (!vision) throw new Error("Configure the local Vision endpoint and token first.");
        if (!/^\/api\/discord-jobs(?:\/[a-f0-9]{32}\/cancel|-clear-terminal)$/.test(relativePath)) throw new Error("Unsupported Vision control route.");
        const expectedUrl = `${vision.origin}${relativePath}`;
        const response = await this.api.Net.fetch(expectedUrl, {
            method: "POST",
            headers: {Accept: "application/json", "X-Krea2-Vision-Token": vision.token},
            redirect: "manual",
            maxRedirects: 0,
            timeout: 15000
        });
        if (response.redirected || !response.ok || (response.url && response.url !== expectedUrl)) throw new Error(`Vision control failed with HTTP ${response.status}.`);
        return JSON.parse(await readBoundedResponseText(response, HISTORY_MAX_RESPONSE_BYTES));
    }

    queueOperationalError({eventId = "", modelId = "", errorCode = "operational_error", errorMessage = "", stage = ""} = {}) {
        const normalizedEvent = /^[a-f0-9]{32}$/.test(String(eventId || "")) ? String(eventId) : randomBytes(16).toString("hex");
        const item = {
            event_id: normalizedEvent,
            model_id: String(modelId || effectiveVisionModel(this.settings)).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200) || "unknown",
            error_code: String(errorCode || "operational_error").replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 80) || "operational_error",
            error_message: String(errorMessage || "Unspecified operational error").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 2000),
            stage: String(stage || "KREA2 Vision operation").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200)
        };
        const existing = this.pendingOperationalErrors.findIndex(entry => entry.event_id === item.event_id && entry.error_code === item.error_code);
        if (existing >= 0) this.pendingOperationalErrors.splice(existing, 1);
        this.pendingOperationalErrors.push(item);
        if (this.pendingOperationalErrors.length > MAX_PENDING_OPERATIONAL_ERRORS) {
            this.pendingOperationalErrors.splice(0, this.pendingOperationalErrors.length - MAX_PENDING_OPERATIONAL_ERRORS);
        }
        void this.flushOperationalErrors();
    }

    async submitOperationalErrorDirect(item, visionToken) {
        const payload = buildOperationalErrorReport(item, visionToken);
        const response = await this.api.Net.fetch(KREA2_OPERATIONAL_ERROR_ENDPOINT, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "User-Agent": `Krea2VisionPlugin/${PLUGIN_VERSION}`,
                "X-Krea2-Diagnostic-Contract": KREA2_OPERATIONAL_ERROR_SCHEMA,
                "X-Krea2-Diagnostic-Notice": KREA2_OPERATIONAL_ERROR_NOTICE_VERSION
            },
            body: JSON.stringify(payload),
            redirect: "manual",
            maxRedirects: 0,
            timeout: 10000
        });
        if (response.redirected || (response.url && response.url !== KREA2_OPERATIONAL_ERROR_ENDPOINT) || !response.ok) return false;
        const raw = await readBoundedResponseText(response, 64 * 1024);
        let receipt;
        try { receipt = JSON.parse(raw); }
        catch { return false; }
        return receipt?.accepted === true && receipt?.report_sha256 === payload.report_sha256;
    }

    async flushOperationalErrors() {
        if (this.operationalErrorFlush || !this.running || !this.pendingOperationalErrors.length) return this.operationalErrorFlush;
        let vision;
        try { vision = this.getVisionConfig(); }
        catch { return null; }
        if (!vision) return null;
        const run = (async () => {
            while (this.running && this.pendingOperationalErrors.length) {
                const item = this.pendingOperationalErrors[0];
                const expectedUrl = `${vision.origin}/api/discord-errors`;
                let accepted = false;
                try {
                    const response = await this.api.Net.fetch(expectedUrl, {
                        method: "POST",
                        headers: {
                            Accept: "application/json",
                            "Content-Type": "application/json",
                            "X-Krea2-Collector-Version": PLUGIN_VERSION,
                            "X-Krea2-Vision-Token": vision.token
                        },
                        body: JSON.stringify(item),
                        redirect: "manual",
                        maxRedirects: 0,
                        timeout: 10000
                    });
                    accepted = !response.redirected && (!response.url || response.url === expectedUrl) && response.ok;
                }
                catch {}
                if (!accepted) {
                    try { accepted = await this.submitOperationalErrorDirect(item, vision.token); }
                    catch { accepted = false; }
                }
                if (!accepted) return;
                this.pendingOperationalErrors.shift();
            }
        })();
        this.operationalErrorFlush = run;
        try { await run; }
        finally { if (this.operationalErrorFlush === run) this.operationalErrorFlush = null; }
        return null;
    }

    async renderHealthPanel(panel, modalDocument) {
        panel.textContent = "Checking Vision, model, GPU queue, and local storage health…";
        const diagnostics = {checked_at: new Date().toISOString(), plugin_version: PLUGIN_VERSION};
        try {
            const [health, settingsState, modelState, queueState] = await Promise.all([
                this.fetchProductJson("/health"),
                this.fetchProductJson("/api/settings"),
                this.fetchProductJson("/api/discord-models"),
                this.fetchProductJson(`/api/discord-jobs?limit=10`)
            ]);
            Object.assign(diagnostics, {health, settings: settingsState, models: modelState, queue: queueState.queue, scheduler: queueState.scheduler});
        }
        catch (error) { diagnostics.backend_error = error instanceof Error ? error.message : String(error); }
        const folder = validateSaveFolder(this.settings.saveFolder);
        diagnostics.save_folder = {configured: folder.ok, writable: false, error: folder.ok ? "" : folder.error};
        if (folder.ok) {
            const probePath = path.join(folder.path, `.krea2-health-${randomBytes(8).toString("hex")}.tmp`);
            try {
                if (!fs.statSync(folder.path).isDirectory()) throw new Error("Configured save location is not a directory.");
                await callFileSystem(fs, "writeFile", "writeFileSync", [probePath, Buffer.alloc(0), {flag: "wx"}]);
                await callFileSystem(fs, "unlink", "unlinkSync", [probePath]);
                diagnostics.save_folder.writable = true;
            }
            catch { diagnostics.save_folder.error = "Folder is not readable and writable by Discord."; }
            finally {
                try { if (fs.existsSync?.(probePath)) await callFileSystem(fs, "unlink", "unlinkSync", [probePath]); }
                catch {}
            }
        }
        panel.replaceChildren();
        const grid = modalDocument.createElement("div");
        grid.className = "krea2-health-grid";
        const modelItems = Array.isArray(diagnostics.models?.models) ? diagnostics.models.models : [];
        const cards = [
            ["Vision backend", diagnostics.health?.ok ? "Online on literal loopback" : diagnostics.backend_error || "Offline"],
            ["Shared GPU queue", diagnostics.settings?.queue_enabled ? String(diagnostics.scheduler?.next_eligible_job?.reason || "Enabled") : "Disabled"],
            ["Warm residency", diagnostics.scheduler?.warm?.active ? `${diagnostics.scheduler.warm.seconds_remaining || 0}s remaining` : String(diagnostics.scheduler?.warm?.reason || "Inactive")],
            ["Save folder", diagnostics.save_folder.writable ? "Readable and writable" : diagnostics.save_folder.error],
            ["Installed Heretic models", modelItems.map(item => `${item.label}: context ${Number(item.context_cap || 0).toLocaleString()} tokens · estimate ${Number(item.estimated_vram_mb || 0).toLocaleString()} MiB · measured ${Number(item.last_measured_peak_mb || 0).toLocaleString()} MiB · reserve ${Number(item.safety_reserve_mb || 0).toLocaleString()} MiB · tolerance ${Number(item.admission_tolerance_mb || 0).toLocaleString()} MiB · admission ${Number(item.admission_required_mb || 0).toLocaleString()} MiB${item.over_allocation_target ? " · OVER 12 GiB TARGET" : ""}`).join("\n") || "None reported"],
            ["Current VRAM", modelItems[0]?.available_vram_mb == null ? "Unavailable" : `${Number(modelItems[0].available_vram_mb).toLocaleString()} MiB free of ${Number(modelItems[0].total_vram_mb || 0).toLocaleString()} MiB`],
            ["Next eligible job", String(diagnostics.scheduler?.next_eligible_job?.reason || "Unavailable")]
        ];
        for (const [label, value] of cards) {
            const card = modalDocument.createElement("div");
            card.className = "krea2-info-card";
            const strong = modalDocument.createElement("strong");
            strong.textContent = label;
            const textNode = modalDocument.createElement("div");
            textNode.style.whiteSpace = "pre-wrap";
            textNode.textContent = value;
            card.append(strong, textNode);
            grid.append(card);
        }
        const copy = modalDocument.createElement("button");
        copy.type = "button";
        copy.className = "krea2-history-action";
        copy.dataset.primary = "true";
        copy.style.marginTop = "12px";
        copy.textContent = "Copy diagnostics";
        copy.addEventListener("click", () => void this.copyProductText(JSON.stringify(diagnostics, null, 2), modalDocument));
        panel.append(grid, copy);
    }

    findSavedOriginalPath(hash) {
        void hash;
        return null;
    }

    async findSavedOriginalPathAsync(hash) {
        void hash;
        return null;
    }

    async retrySavedHistoryImage(job, filePath, onElapsed, model = null) {
        return this.runSavedImageModel(filePath, job.image_hash, model || effectiveVisionModel(this.settings), onElapsed, {
            preset: this.settings.preferredPreset,
            datasetGuidance: this.settings.useKrea2DatasetGuidance === true
        });
    }

    async runSavedImageModel(filePath, expectedHash, model, onElapsed, options = {}) {
        if (!filePath) throw new Error("The original image is no longer available in the configured local folder.");
        const visionConfig = this.getVisionConfig();
        if (!visionConfig) throw new Error("Configure the local Vision endpoint and token before retrying.");
        if (!VISION_MODEL_IDS.has(model)) throw new Error("The selected Vision model is not supported by the configured execution mode.");
        const queuedGeneration = this.generation;
        const flow = this.visionFlowQueue.then(async () => {
            if (!this.running || queuedGeneration !== this.generation) throw new Error("The plugin stopped before the retry began.");
            const bytes = await readFileCompat(fs, filePath);
            if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("The saved original is empty or exceeds the 20 MB limit.");
            const sha256 = sha256Hex(bytes);
            if (sha256 !== expectedHash) throw new Error("The saved original no longer matches the history SHA-256.");
            const format = detectImageFormat(bytes);
            if (!format || !isVisionSupportedFormat(format)) throw new Error("The saved original format is not supported by the Vision route.");
            const controller = new AbortController();
            this.controllers.add(controller);
            try {
                const generated = await this.requestVisionPrompt(
                    {bytes, sha256, format},
                    {filePath, filename: path.basename(filePath)},
                    visionConfig,
                    controller.signal,
                    onElapsed,
                    {
                        model,
                        guidance: options.guidance || "",
                        preset: options.preset || this.settings.preferredPreset,
                        datasetGuidance: options.datasetGuidance === undefined
                            ? this.settings.useKrea2DatasetGuidance === true
                            : options.datasetGuidance === true
                    }
                );
                return generated;
            }
            finally { this.controllers.delete(controller); }
        });
        this.visionFlowQueue = flow.catch(() => {});
        return flow;
    }

    scan() {
        if (!this.running) return;
        if (!this.getVerifiedRoute()) {
            this.removeAllButtons();
            return;
        }

        const messageArea = document.querySelector('[data-list-id="chat-messages"]')?.closest('[class*="chatContent_"]')
            || document.querySelector('[class*="chatContent_"]');
        if (!messageArea) {
            this.removeAllButtons();
            return;
        }
        for (const image of messageArea.querySelectorAll("img")) this.enhanceImage(image);
        for (const [image, handler] of this.imageLoadHandlers) {
            if (image.isConnected) continue;
            image.removeEventListener("load", handler);
            this.imageLoadHandlers.delete(image);
        }
        for (const button of [...this.buttons]) {
            if (!button.isConnected || !this.isEligibleImage(button.__krea2Image)) this.removeButton(button);
        }
        for (const button of [...this.visionButtons]) {
            if (!button.isConnected || !this.isEligibleImage(button.__krea2Image)) this.removeButton(button);
        }
    }

    isEligibleImage(image) {
        if (!image?.isConnected) return false;
        const messageRoot = findMessageRoot(image);
        if (!messageRoot || hasExcludedImageContext(image, messageRoot) || hasSpoilerContext(image, messageRoot)) return false;
        const mediaUrl = recoverOriginalImageUrl(image);
        if (!mediaUrl) return false;
        const route = this.getVerifiedRoute();
        const provenance = extractMediaProvenance(mediaUrl);
        if (!route || !this.attachmentBelongsToGuild(provenance, route.guildId)) return false;

        if (image.complete && image.naturalWidth && image.naturalHeight) {
            if (image.naturalWidth < 48 || image.naturalHeight < 48) return false;
        }
        return true;
    }

    enhanceImage(image) {
        const existing = this.buttonByImage.get(image);
        const existingVision = this.visionButtonByImage.get(image);
        const currentUrl = recoverOriginalImageUrl(image);
        const currentPath = extractMediaProvenance(currentUrl)?.path || "";
        if (existing && (!existing.isConnected || existing.dataset.sourceKey !== currentPath)) this.removeButton(existing);
        if (existingVision && (!existingVision.isConnected || existingVision.dataset.sourceKey !== currentPath)) this.removeButton(existingVision);

        if (!image.complete && !this.imageLoadHandlers.has(image)) {
            const handler = () => {
                this.imageLoadHandlers.delete(image);
                this.scheduleScan();
            };
            this.imageLoadHandlers.set(image, handler);
            image.addEventListener("load", handler, {once: true});
        }

        if (!this.isEligibleImage(image)) return;
        const messageRoot = findMessageRoot(image);
        const mediaUrl = recoverOriginalImageUrl(image);
        const provenance = extractMediaProvenance(mediaUrl);
        const anchor = image.closest("a[href]");
        let host = anchor?.parentElement || image.parentElement;
        while (host && ["A", "BUTTON", "LABEL", "PICTURE"].includes(host.tagName)) host = host.parentElement;
        if (!host || !messageRoot?.contains(host)) return;

        host.classList.add(HOST_CLASS);
        const blockNavigation = event => {
            event.preventDefault();
            event.stopPropagation();
        };
        const hostRect = host.getBoundingClientRect();
        const imageRect = image.getBoundingClientRect();

        let visionButton = this.visionButtonByImage.get(image);
        if (!visionButton?.isConnected) {
            visionButton = document.createElement("button");
            visionButton.type = "button";
            visionButton.className = VISION_BUTTON_CLASS;
            visionButton.textContent = "🔍";
            visionButton.dataset.state = "idle";
            visionButton.dataset.sourceKey = provenance?.path || "";
            visionButton.title = "Describe this image with KREA2 Vision without saving it to disk";
            visionButton.setAttribute("aria-label", visionButton.title);
            visionButton.__krea2Image = image;
            visionButton.addEventListener("pointerdown", blockNavigation);
            visionButton.addEventListener("dblclick", blockNavigation);
            visionButton.addEventListener("click", event => {
                blockNavigation(event);
                this.queueVisionAnalysis(image, visionButton);
            });
            host.append(visionButton);
            this.visionButtons.add(visionButton);
            this.visionButtonByImage.set(image, visionButton);
        }
        visionButton.style.right = `${Math.max(0, hostRect.right - imageRect.right + 6)}px`;
        visionButton.style.top = `${Math.max(0, imageRect.top - hostRect.top + 6)}px`;
    }

    removeButton(button) {
        if (!button) return;
        const host = button.parentElement;
        const isVision = button.classList?.contains(VISION_BUTTON_CLASS);
        const buttonSet = isVision ? this.visionButtons : this.buttons;
        const buttonMap = isVision ? this.visionButtonByImage : this.buttonByImage;
        buttonSet.delete(button);
        if (button.__krea2Image && buttonMap.get(button.__krea2Image) === button) {
            buttonMap.delete(button.__krea2Image);
        }
        button.remove();
        if (host && !host.querySelector(`:scope > .${BUTTON_CLASS}, :scope > .${VISION_BUTTON_CLASS}`)) host.classList.remove(HOST_CLASS);
    }

    removeAllButtons() {
        for (const button of [...this.buttons]) this.removeButton(button);
        for (const button of [...this.visionButtons]) this.removeButton(button);
        for (const button of document.querySelectorAll(`.${BUTTON_CLASS}`)) this.removeButton(button);
        for (const button of document.querySelectorAll(`.${VISION_BUTTON_CLASS}`)) this.removeButton(button);
        for (const host of document.querySelectorAll(`.${HOST_CLASS}`)) host.classList.remove(HOST_CLASS);
    }

    setButtonState(button, state, text, title) {
        if (!button?.isConnected) return;
        button.dataset.state = state;
        button.textContent = text;
        button.title = title;
        button.setAttribute("aria-label", title);
        button.setAttribute("aria-busy", ["downloading", "hashing", "saving", "uploading", "vision-queued", "vision-requesting"].includes(state) ? "true" : "false");
    }

    getChannelVerifiedRoute() {
        const route = parseDiscordRoute(location.pathname);
        if (!route.guildId || !route.channelId || route.guildId === "@me") return null;

        try {
            this.channelStore ||= this.api.Webpack.getStore("ChannelStore") || null;
            const channel = this.channelStore?.getChannel?.(route.channelId);
            const actualGuildId = channel?.guild_id ?? channel?.guildId ?? channel?.getGuildId?.();
            if (!channel || String(actualGuildId || "") !== String(route.guildId)) return null;
        }
        catch {
            return null;
        }
        return route;
    }

    getVerifiedRoute() {
        const route = this.getChannelVerifiedRoute();
        if (!route || !isGuildAllowed(route.guildId, this.settings.allowedGuildIds)) return null;
        if (invalidGuildAllowlistEntries(this.settings.allowedGuildIds).length) return null;
        return route;
    }

    attachmentBelongsToGuild(provenance, guildId) {
        if (!provenance?.attachmentChannelId || !guildId) return false;
        try {
            this.channelStore ||= this.api.Webpack.getStore("ChannelStore") || null;
            const channel = this.channelStore?.getChannel?.(provenance.attachmentChannelId);
            const actualGuildId = channel?.guild_id ?? channel?.guildId ?? channel?.getGuildId?.();
            return Boolean(channel) && String(actualGuildId || "") === String(guildId);
        }
        catch {
            return false;
        }
    }

    validateLocalCollectionSettings() {
        const route = this.getVerifiedRoute();
        if (!route) throw new Error("The current channel/server could not be verified against the allowlist.");

        const invalidEntries = invalidGuildAllowlistEntries(this.settings.allowedGuildIds);
        if (invalidEntries.length) throw new Error(`Invalid server ID in allowlist: ${invalidEntries[0]}`);

        return route;
    }

    async ensureContributionConsent() {
        if (this.settings.shareDatasetContributions !== true) return false;
        if (isCurrentPrivacyReceipt(this.api.Data.load("privacyReceipt"))) return true;

        const accepted = await this.confirmPrivacyReceipt();
        if (accepted && isCurrentPrivacyReceipt(this.api.Data.load("privacyReceipt"))) return true;

        this.settings.shareDatasetContributions = false;
        this.saveSettings();
        return false;
    }

    async ensureDiagnosticConsent() {
        if (this.settings.shareFailureDiagnostics !== true) return {enabled: false, username: ""};
        this.userStore ||= this.api.Webpack.getStore("UserStore") || null;
        const username = String(this.userStore?.getCurrentUser?.()?.username || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80);
        if (!username) return {enabled: false, username: ""};
        if (isCurrentDiagnosticReceipt(this.api.Data.load("diagnosticPrivacyReceipt"))) return {enabled: true, username};

        const accepted = await this.confirmDiagnosticReceipt();
        if (accepted && isCurrentDiagnosticReceipt(this.api.Data.load("diagnosticPrivacyReceipt"))) return {enabled: true, username};

        this.settings.shareFailureDiagnostics = false;
        this.saveSettings();
        return {enabled: false, username: ""};
    }

    confirmDiagnosticReceipt() {
        return new Promise(resolve => {
            const content = document.createElement("div");
            content.style.cssText = "line-height:1.55;color:var(--text-normal)";
            const lead = document.createElement("p");
            lead.textContent = "When enabled, only failed KREA2 Vision requests send a diagnostic report to Seedframe so the product owner can reproduce and repair launch failures.";
            const list = document.createElement("ul");
            for (const text of [
                "Sends on failure only: the source image, your current Discord username, requested model and pipeline, error code/message/stage, plugin/backend versions, an anonymous installation digest, and a partial or audited prompt only when one exists.",
                "Never sends: Discord account, server, channel or message IDs; Discord URLs; filenames; local paths; Vision tokens; queue credentials; successful images; or successful prompts.",
                "Reports and images are restricted to the Seedframe owner console. Turn this setting off at any time to stop future reports."
            ]) {
                const item = document.createElement("li");
                item.textContent = text;
                list.append(item);
            }
            content.append(lead, list);
            this.api.UI.showConfirmationModal("Share failed Vision diagnostics with Krea2?", content, {
                confirmText: "I agree",
                cancelText: "Keep failures local",
                danger: false,
                onConfirm: () => {
                    try {
                        this.api.Data.save("diagnosticPrivacyReceipt", {
                            version: DIAGNOSTIC_RECEIPT_VERSION,
                            termsVersion: KREA2_DIAGNOSTIC_TERMS_VERSION,
                            acceptedAt: Date.now()
                        });
                        resolve(true);
                    }
                    catch (error) {
                        this.log("error", error);
                        this.toast("Diagnostic consent could not be saved; failures will remain local.", "error");
                        resolve(false);
                    }
                },
                onCancel: () => resolve(false)
            });
        });
    }

    confirmPrivacyReceipt() {
        return new Promise(resolve => {
            const content = document.createElement("div");
            content.style.cssText = "line-height:1.55;color:var(--text-normal)";
            const lead = document.createElement("p");
            lead.textContent = "When enabled, every successful Vision request contributes its three generated prompt texts to Krea2. The local Vision broker submits them without exposing a reusable Seedframe credential to BetterDiscord.";
            const list = document.createElement("ul");
            for (const text of [
                "Sends: the three generated prompts, model and pipeline identifiers, contribution contract version, and anonymous installation provenance.",
                "Never sends: image bytes, image hashes, signed CDN URLs, Discord IDs, filenames, local paths, Vision tokens, queue tickets, reviews, collections, or model evidence.",
                "You can revoke this receipt at any time in Vision Tools → Privacy receipt."
            ]) {
                const item = document.createElement("li");
                item.textContent = text;
                list.append(item);
            }
            content.append(lead, list);
            this.api.UI.showConfirmationModal("Contribute generated prompts to Krea2?", content, {
                confirmText: "I agree",
                cancelText: "Keep local only",
                danger: false,
                onConfirm: () => {
                    try {
                        this.api.Data.save("privacyReceipt", {version: PRIVACY_RECEIPT_VERSION, acceptedAt: Date.now()});
                        resolve(true);
                    }
                    catch (error) {
                        this.log("error", error);
                        this.toast("Contribution consent could not be saved; generated prompts will not be submitted.", "error");
                        resolve(false);
                    }
                },
                onCancel: () => resolve(false)
            });
        });
    }

    getVisionConfig() {
        const rawEndpoint = String(this.settings.visionEndpoint || "").trim();
        const token = String(this.settings.visionToken || "").trim();
        if (!rawEndpoint || !token) return null;
        const endpoint = validateVisionLoopbackEndpoint(rawEndpoint);
        if (!endpoint.ok) throw new Error(endpoint.error);
        if (!/^[\x21-\x7e]{32,512}$/.test(token)) {
            throw new Error("Vision token must be a 32-512 character printable-ASCII local secret.");
        }
        const model = effectiveVisionModel(this.settings);
        if (!VISION_MODEL_IDS.has(model)) throw new Error("Select a supported Vision execution mode and model.");
        return {endpoint: endpoint.url, origin: endpoint.origin, token, model};
    }

    originalCacheKey(provenance) {
        if (!provenance?.attachmentChannelId || !provenance?.attachmentId || !provenance?.kind) return null;
        return `${provenance.kind}:${provenance.attachmentChannelId}:${provenance.attachmentId}`;
    }

    getCachedOriginal(provenance) {
        const key = this.originalCacheKey(provenance);
        if (!key) return null;
        const cached = this.originalCache.get(key);
        if (!cached) return null;
        this.originalCache.delete(key);
        this.originalCache.set(key, cached);
        return cached;
    }

    cacheOriginal(provenance, original) {
        const key = this.originalCacheKey(provenance);
        if (!key || !original?.bytes || !original?.sha256 || !original?.format) return;
        this.originalCache.delete(key);
        this.originalCache.set(key, original);
        while (this.originalCache.size > MAX_CACHED_ORIGINALS) {
            this.originalCache.delete(this.originalCache.keys().next().value);
        }
    }

    getOrQueueVisionJob(requestCacheKey, factory) {
        const key = String(requestCacheKey || "").toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Vision request cache key is invalid.");
        const existing = this.visionInflightByRequest.get(key);
        if (existing) return {job: existing, shared: true};

        const job = this.visionQueue.then(() => factory());
        this.visionQueue = job.catch(() => {});
        this.visionInflightByRequest.set(key, job);
        void job.finally(() => {
            if (this.visionInflightByRequest.get(key) === job) this.visionInflightByRequest.delete(key);
        }).catch(() => {});
        return {job, shared: false};
    }

    captureVisionSelection(image, config) {
        if (!image?.isConnected) throw new Error("The selected Discord image is no longer connected.");
        const sourceUrlAtClick = recoverOriginalImageUrl(image);
        const provenance = extractMediaProvenance(sourceUrlAtClick);
        if (!provenance || !this.attachmentBelongsToGuild(provenance, config.guildId)) {
            throw new Error("The image attachment could not be verified in the allowlisted Discord server.");
        }
        return Object.freeze({
            sourceUrlAtClick,
            provenance: Object.freeze({...provenance}),
            messageId: messageIdFromRoot(findMessageRoot(image)),
            config: Object.freeze({...config})
        });
    }

    resolveQueuedVisionSelection(image, selection) {
        if (!image?.isConnected) {
            throw new Error("The queued Discord image is no longer connected; nothing was downloaded or analyzed.");
        }

        const currentConfig = this.validateLocalCollectionSettings();
        if (
            String(currentConfig.guildId) !== String(selection.config.guildId) ||
            String(currentConfig.channelId) !== String(selection.config.channelId)
        ) {
            throw new Error("The queued image is no longer in the Discord channel selected at click; nothing was downloaded or analyzed.");
        }

        const sourceUrl = recoverOriginalImageUrl(image);
        const provenance = extractMediaProvenance(sourceUrl);
        if (!sameMediaProvenance(provenance, selection.provenance)) {
            throw new Error("The queued image no longer matches the Discord attachment selected at click; nothing was downloaded or analyzed.");
        }
        if (!this.attachmentBelongsToGuild(provenance, selection.config.guildId)) {
            throw new Error("The queued attachment channel no longer belongs to the allowlisted Discord server.");
        }

        const currentMessageId = messageIdFromRoot(findMessageRoot(image));
        if (selection.messageId && currentMessageId !== selection.messageId) {
            throw new Error("The queued image no longer matches the Discord message selected at click; nothing was downloaded or analyzed.");
        }

        return Object.freeze({
            sourceUrl,
            sourceUrlAtClick: selection.sourceUrlAtClick,
            provenance: selection.provenance,
            messageId: selection.messageId,
            config: selection.config
        });
    }

    queueVisionAnalysis(image, button) {
        if (!this.running || !image?.isConnected || !button?.isConnected || button.dataset?.busy === "true") return;
        let selection;
        try {
            const route = this.validateLocalCollectionSettings();
            const config = {
                ...route,
                visionModel: effectiveVisionModel(this.settings),
                visionExecutionMode: normalizeVisionExecutionMode(this.settings.visionExecutionMode)
            };
            selection = this.captureVisionSelection(image, config);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.setButtonState(button, "error", "!", `${message} Click to retry.`);
            this.toast(message, "error");
            return;
        }
        const queuedGeneration = this.generation;
        const localSubmissionId = this.addLocalVisionSubmission(selection);
        this.armLocalVisionSubmissionTimeout(localSubmissionId, button, selection.config.visionModel);
        button.dataset.busy = "true";
        this.setButtonState(button, "vision-queued", "Q", "Queued locally; it will appear in Discord Jobs as soon as Vision Studio receives it");
        const flow = this.visionFlowQueue.then(async () => {
            const localState = this.localVisionSubmissions.get(localSubmissionId);
            if (localState?.timed_out || localState?.status === "error") return;
            this.clearLocalVisionSubmissionTimeout(localSubmissionId);
            this.updateLocalVisionSubmission(localSubmissionId, {submission_started: true});
            if (!this.running || queuedGeneration !== this.generation || !button?.isConnected) {
                if (button) button.dataset.busy = "false";
                this.removeLocalVisionSubmission(localSubmissionId);
                return;
            }
            try {
                const resolvedSelection = this.resolveQueuedVisionSelection(image, selection);
                this.updateLocalVisionSubmission(localSubmissionId, {stage: "Submitting in-memory image bytes to the shared GPU FIFO…"});
                await this.analyzeWithVision(resolvedSelection, button, queuedGeneration, original => {
                    this.updateLocalVisionSubmission(localSubmissionId, {
                        image_hash: original.sha256,
                        filename: `${original.sha256}${original.format.extension}`,
                        local_title: `Image ${original.sha256.slice(0, 10)}`,
                        stage: "Submitted from memory; waiting for the shared GPU job to appear…"
                    });
                }, localSubmissionId);
                this.removeLocalVisionSubmission(localSubmissionId);
            }
            catch (error) {
                if (!this.running || queuedGeneration !== this.generation || error?.name === "AbortError") return;
                const message = error instanceof Error ? error.message : String(error);
                this.setButtonState(button, "error", "!", `${message} Click to retry.`);
                this.toast(message, "error");
                this.log("error", message);
                if (button) button.dataset.busy = "false";
                this.updateLocalVisionSubmission(localSubmissionId, {
                    status: "error",
                    stage: message,
                    public_error: message
                });
                this.queueOperationalError({
                    eventId: localSubmissionId,
                    modelId: selection.config.visionModel,
                    errorCode: "plugin_queue_failed",
                    errorMessage: message,
                    stage: "Submitting the queued Discord image"
                });
            }
        });
        this.visionFlowQueue = flow.catch(() => {});
    }

    async analyzeWithVision(selection, button, queuedGeneration = this.generation, onOriginalSaved = null, jobId = "") {
        if (!this.running || queuedGeneration !== this.generation) {
            if (button) button.dataset.busy = "false";
            return;
        }

        const controller = new AbortController();
        this.controllers.add(controller);
        let requestImage = null;

        try {
            const config = selection?.config;
            const sourceUrl = selection?.sourceUrl;
            if (!sourceUrl) throw new Error("Could not recover an original image URL from this message.");
            const provenance = selection?.provenance;
            const sourceProvenance = extractMediaProvenance(sourceUrl);
            if (!provenance || !sameMediaProvenance(sourceProvenance, provenance)) {
                throw new Error("The selected image is not the exact Discord attachment captured at click.");
            }
            if (!this.attachmentBelongsToGuild(provenance, config.guildId)) {
                throw new Error("The attachment channel does not belong to the allowlisted Discord server.");
            }
            const messageId = selection.messageId;

            let original = this.getCachedOriginal(provenance);
            if (!original) {
                this.setButtonState(button, "downloading", "↓", "Downloading the original image for local Vision analysis");
                const download = await this.api.Net.fetch(sourceUrl, {
                    method: "GET",
                    headers: {Accept: "image/*,application/octet-stream;q=0.8"},
                    redirect: "follow",
                    signal: controller.signal,
                    timeout: 60000
                });
                if (!download.ok) throw new Error(`Image download failed with HTTP ${download.status}.`);

                const finalProvenance = extractMediaProvenance(download.url || sourceUrl);
                if (
                    !finalProvenance ||
                    finalProvenance.attachmentId !== provenance.attachmentId ||
                    finalProvenance.attachmentChannelId !== provenance.attachmentChannelId ||
                    finalProvenance.kind !== provenance.kind
                ) {
                    throw new Error("The attachment redirect changed identity; the image was not analyzed.");
                }

                const contentTypeHeader = download.headers.get("content-type") || "";
                if (/^(?:text\/html|application\/(?:json|xml))/i.test(contentTypeHeader)) {
                    throw new Error(`The image URL returned ${contentTypeHeader.split(";", 1)[0]} instead of image bytes.`);
                }

                const bytes = await readResponseBytes(download, (loaded, total) => {
                    if (!total || !button.isConnected) return;
                    const percent = Math.min(99, Math.max(1, Math.round((loaded / total) * 100)));
                    this.setButtonState(button, "downloading", String(percent), `Downloading original image: ${percent}%`);
                });
                if (!bytes.byteLength) throw new Error("The downloaded image was empty.");

                this.setButtonState(button, "hashing", "#", "Checking SHA-256 duplicate hash");
                const sha256 = sha256Hex(bytes);
                const format = detectImageFormat(bytes);
                if (!format) throw new Error("The downloaded bytes are not a supported image format, so no false extension was used.");
                original = {bytes, sha256, format};
                this.cacheOriginal(provenance, original);
            }

            requestImage = {filename: `${original.sha256}${original.format.extension}`};
            this.rememberHistoryThumbnail(original, true);
            onOriginalSaved?.(original);

            if (!isVisionSupportedFormat(original.format)) {
                const kind = String(original.format.kind || "unknown").toUpperCase();
                this.setButtonState(button, "vision-unsupported", "–", `Vision supports PNG, JPEG, and WebP, not ${kind}; nothing was saved.`);
                this.toast(`${kind} is not supported by the Vision endpoint; nothing was saved.`, "warning");
                return;
            }

            const selectedModel = String(selection?.config?.visionModel || effectiveVisionModel(this.settings));
            const preset = normalizePromptPreset(this.settings.preferredPreset);
            const datasetGuidance = this.settings.useKrea2DatasetGuidance === true;
            const feedbackContext = datasetGuidance ? buildPromptFeedbackContext(this.promptFeedback) : null;
            const requestJobId = /^[a-f0-9]{32}$/.test(String(jobId || "")) ? String(jobId) : randomBytes(16).toString("hex");
            const visionConfig = this.getVisionConfig();
            if (!visionConfig) {
                this.setButtonState(button, "vision-not-configured", "?", "Configure the loopback Vision endpoint and required local token; nothing was saved.");
                this.toast("Vision endpoint/token is not configured; nothing was saved.", "warning");
                return;
            }

            const requestCacheKey = visionRequestCacheKey(original.sha256, {
                model: selectedModel,
                preset,
                guidance: "",
                datasetGuidance,
                feedbackDigest: feedbackContext?.digest || "",
                jobId: requestJobId,
                pipelineId: VISION_PIPELINE_ID
            });
            const queued = this.getOrQueueVisionJob(requestCacheKey, async () => {
                if (!this.running || queuedGeneration !== this.generation) {
                    const abortError = new Error("Vision analysis was cancelled because the plugin stopped.");
                    abortError.name = "AbortError";
                    throw abortError;
                }
                return this.requestVisionPrompt(
                    original,
                    requestImage,
                    visionConfig,
                    controller.signal,
                    elapsed => this.setButtonState(button, "vision-requesting", "AI", `KREA2 hybrid Vision is analyzing (${elapsed})`),
                    {
                        model: selectedModel,
                        preset,
                        datasetGuidance,
                        feedbackContext,
                        jobId: requestJobId,
                        // This is retained only for the optional server-side
                        // completion record.  It is never sent for local models.
                        sourceUrl
                    }
                );
            });
            this.setButtonState(
                button,
                "vision-queued",
                "Q",
                queued.shared
                    ? "Waiting for the already-running analysis of these same in-memory image bytes"
                    : "Queued behind any earlier KREA2 Vision request"
            );
            const visionResult = await queued.job;

            await this.finishVisionPrompt({
                button,
                model: visionResult.model
            });
        }
        catch (error) {
            if (!this.running || queuedGeneration !== this.generation || error?.name === "AbortError") return;
            const message = error instanceof Error ? error.message : String(error);
            this.setButtonState(button, "error", "!", `${message} Nothing was saved. Click to retry.`);
            this.toast(message, "error");
            this.log("error", message);
            this.queueOperationalError({
                eventId: jobId,
                modelId: selection?.config?.visionModel || effectiveVisionModel(this.settings),
                errorCode: "plugin_vision_request_failed",
                errorMessage: message,
                stage: "Downloading or submitting the Discord image"
            });
        }
        finally {
            this.controllers.delete(controller);
            if (button) button.dataset.busy = "false";
        }
    }

    async requestVisionPrompt(original, localSave, visionConfig, signal, onElapsed, options = {}) {
        const onboardingState = this.api.Data.load("onboardingState");
        if (
            !onboardingState
            || Number(onboardingState.version) < ONBOARDING_VERSION
            || onboardingState.contributionTermsVersion !== KREA2_CONTRIBUTION_TERMS_VERSION
        ) {
            void this.openOnboarding();
            throw new Error("Complete the current KREA2 Vision setup before using Vision.");
        }
        const contributionEnabled = await this.ensureContributionConsent();
        const diagnosticConsent = await this.ensureDiagnosticConsent();
        const selectedModel = String(options.model || visionConfig.model || "").trim();
        const guidance = String(options.guidance || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 600);
        const preset = normalizePromptPreset(options.preset || this.settings.preferredPreset);
        const datasetGuidance = options.datasetGuidance === undefined
            ? this.settings.useKrea2DatasetGuidance === true
            : options.datasetGuidance === true;
        const feedbackContext = datasetGuidance
            ? options.feedbackContext || buildPromptFeedbackContext(this.promptFeedback)
            : null;
        const jobId = /^[a-f0-9]{32}$/.test(String(options.jobId || "")) ? String(options.jobId) : randomBytes(16).toString("hex");
        const requestCacheKey = visionRequestCacheKey(original.sha256, {
            model: selectedModel,
            preset,
            guidance,
            datasetGuidance,
            feedbackDigest: feedbackContext?.digest || "",
            jobId,
            pipelineId: VISION_PIPELINE_ID,
            contributionEnabled,
            diagnosticsEnabled: diagnosticConsent.enabled
        });
        const multipart = buildVisionMultipartBody(original.bytes, {
            filename: localSave.filename,
            mimeType: original.format.mimeType,
            model: selectedModel,
            guidance,
            datasetGuidance,
            feedbackContext: feedbackContext?.payload || "",
            jobId,
            contributionTerms: contributionEnabled ? KREA2_CONTRIBUTION_TERMS_VERSION : "",
            diagnosticTerms: diagnosticConsent.enabled ? KREA2_DIAGNOSTIC_TERMS_VERSION : "",
            diagnosticUsername: diagnosticConsent.username
        });
        const startedAt = Date.now();
        const updateElapsed = () => {
            const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
            const minutes = Math.floor(elapsedSeconds / 60);
            const seconds = elapsedSeconds % 60;
            onElapsed?.(`${minutes}:${String(seconds).padStart(2, "0")}`);
        };
        updateElapsed();
        const elapsedTimer = setInterval(updateElapsed, 5000);

        try {
            const sessionToken = await this.issueVisionSession(visionConfig, requestCacheKey, selectedModel, signal, options.sourceUrl || "");
            const response = await this.api.Net.fetch(visionConfig.endpoint, {
                method: "POST",
                redirect: "manual",
                maxRedirects: 0,
                headers: {
                    Accept: "application/json",
                    "Content-Type": multipart.contentType,
                    "X-Idempotency-Key": requestCacheKey,
                    "X-Krea2-Collector-Version": PLUGIN_VERSION,
                    "X-Krea2-Vision-Session": sessionToken
                },
                body: multipart.body,
                signal,
                timeout: VISION_TIMEOUT_MS
            });
            if (response.redirected || (response.status >= 300 && response.status < 400)) {
                throw new Error("Vision Prompt Studio attempted a redirect; redirects are disabled.");
            }
            if (response.url) {
                const finalEndpoint = validateVisionLoopbackEndpoint(response.url);
                if (!finalEndpoint.ok || finalEndpoint.origin !== visionConfig.origin || finalEndpoint.url !== visionConfig.endpoint) {
                    throw new Error("Vision Prompt Studio response did not remain on the configured loopback endpoint.");
                }
            }

            const responseType = response.headers?.get?.("content-type") || "";
            if (!response.ok) {
                const responseText = await readBoundedResponseText(response);
                const detail = parseStudioErrorDetail(responseText);
                throw new Error(`Vision Prompt Studio failed with HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
            }
            if (responseType && !/^application\/json(?:\s*;|$)/i.test(responseType)) {
                throw new Error("Vision Prompt Studio did not return a JSON response.");
            }
            const parsed = parseVisionPromptResponse(await readBoundedResponseText(response), {
                expectedDatasetGuidance: datasetGuidance,
                expectedFeedbackDigest: datasetGuidance ? feedbackContext.digest : null
            });
            return {
                ...parsed,
                request_cache_key: requestCacheKey,
                cache_identity: buildVisionCacheProfile({
                    model: selectedModel,
                    preset,
                    pipelineId: parsed.pipeline_id,
                    guidance,
                    datasetGuidance: parsed.dataset_guidance
                })
            };
        }
        finally {
            clearInterval(elapsedTimer);
        }
    }

    async finishVisionPrompt({button, model = ""}) {
        const suffix = model ? ` Model: ${model}.` : "";
        const contributed = this.settings.shareDatasetContributions === true;
        const contributionCopy = contributed
            ? " All three prompts were accepted by the online Krea2 dataset."
            : " Prompt contribution is disabled; nothing was submitted to Krea2.";
        this.setButtonState(button, "vision-ready", "✓", `Detailed Vision prompts are ready.${suffix}${contributionCopy} The prompts and a small local thumbnail remain in Prompt History until you clear it; no full-resolution source image was copied into history.`);
        this.toast(
            contributed
                ? "Three prompts are ready in session memory and were added to the online Krea2 dataset."
                : "Three prompts are ready in session memory. Krea2 contribution is off.",
            "success"
        );
    }

    showClassification(button, classification) {
        const states = {
            added: ["done", "✓", "Prompt metadata was added to the Krea2 dataset; no image or sidecar was saved.", "Prompt metadata added to Krea2. Nothing was saved locally.", "success"],
            duplicate: ["duplicate", "✓", "Krea2 already has this metadata contribution; nothing was saved locally.", "Krea2 already has this contribution.", "success"],
            no_metadata: ["no-metadata", "–", "No prompt metadata was present; nothing was saved.", "No metadata was found and nothing was saved.", "info"],
            metadata_no_prompt: ["metadata-no-prompt", "?", "Metadata existed but contained no usable positive prompt; nothing was saved.", "Metadata had no usable positive prompt.", "warning"],
            encoded_or_unknown: ["encoded-or-unknown", "🔒", "Encoded, encrypted, or high-entropy metadata was skipped; nothing was saved.", "Encoded or unknown metadata was not submitted.", "warning"],
            structured: ["structured", "🔒", "JSON/object/array/YAML-style prompt metadata was skipped; nothing was saved.", "Structured metadata was not submitted.", "warning"],
            non_english: ["non-english", "🔒", "The positive prompt was substantially non-English and was skipped; nothing was saved.", "Substantially non-English metadata was not submitted.", "warning"]
        };
        const [state, text, title, toast, type] = states[classification] || states.encoded_or_unknown;
        this.setButtonState(button, state, text, title);
        this.toast(toast, type);
    }

    recordDiagnosticSummary(hash, classification, chunks) {
        const summary = {
            sha256: String(hash),
            classification: String(classification),
            chunks: sanitizeDiagnosticChunks(chunks)
        };
        this.diagnosticSummaries = this.diagnosticSummaries.filter(item => item?.sha256 !== summary.sha256);
        this.diagnosticSummaries.push(summary);
        if (this.diagnosticSummaries.length > MAX_DIAGNOSTIC_SUMMARIES) {
            this.diagnosticSummaries.splice(0, this.diagnosticSummaries.length - MAX_DIAGNOSTIC_SUMMARIES);
        }
    }

    recordSentHash(hash, promptSource) {
        const key = submissionKey(hash, promptSource);
        if (this.sentHashes.has(key)) return;
        this.sentHashes.add(key);
        this.sentHashOrder.push(key);
        if (this.sentHashOrder.length > MAX_SAVED_HASHES) {
            const removed = this.sentHashOrder.splice(0, this.sentHashOrder.length - MAX_SAVED_HASHES);
            for (const oldHash of removed) this.sentHashes.delete(oldHash);
        }
    }

    getPromptFeedback(prompt) {
        const normalized = normalizePromptFeedbackText(prompt);
        if (!normalized) return null;
        return this.promptFeedback[sha256Hex(Buffer.from(normalized, "utf8"))] || null;
    }

    savePromptFeedback(prompt, vote, reason = "", job = null) {
        const sampleDigest = String(job?.reproducibility?.dataset_guidance?.sample_digest || "").toLowerCase();
        const record = sanitizePromptFeedbackRecord({
            prompt,
            vote,
            reason,
            sample_digest: /^[a-f0-9]{64}$/.test(sampleDigest) ? sampleDigest : "",
            updated: Date.now()
        });
        if (!record) throw new Error(vote === "disliked" ? "Please explain what the model should avoid in at least three characters." : "This prompt could not be saved as feedback.");
        this.promptFeedback[record.id] = record;
        const retained = Object.values(this.promptFeedback)
            .map(sanitizePromptFeedbackRecord)
            .filter(Boolean)
            .sort((left, right) => left.updated - right.updated)
            .slice(-MAX_PROMPT_FEEDBACK_RECORDS);
        this.promptFeedback = Object.fromEntries(retained.map(item => [item.id, item]));
        return record;
    }

    requestDislikeReason(prompt, modalDocument = document) {
        const existing = this.getPromptFeedback(prompt);
        return new Promise(resolve => {
            const overlay = modalDocument.createElement("div");
            overlay.className = "krea2-feedback-overlay";
            const dialog = modalDocument.createElement("section");
            dialog.className = "krea2-feedback-dialog";
            dialog.setAttribute("role", "dialog");
            dialog.setAttribute("aria-modal", "true");
            dialog.setAttribute("aria-label", "Explain prompt feedback");
            const title = modalDocument.createElement("h3");
            title.textContent = "What should the model avoid next time?";
            const note = modalDocument.createElement("p");
            note.textContent = "Write a short plain-English reason. It stays in memory for this Discord session and guides prompts only when Krea2 dataset guidance is enabled.";
            const textarea = modalDocument.createElement("textarea");
            textarea.className = "krea2-feedback-reason";
            textarea.maxLength = 600;
            textarea.placeholder = "Example: The pose was too generic and the camera angle was not preserved.";
            textarea.value = existing?.vote === "disliked" ? existing.reason : "";
            const actions = modalDocument.createElement("div");
            actions.className = "krea2-feedback-dialog-actions";
            const cancel = modalDocument.createElement("button");
            cancel.type = "button";
            cancel.className = "krea2-history-action";
            cancel.textContent = "Cancel";
            const save = modalDocument.createElement("button");
            save.type = "button";
            save.className = "krea2-history-action";
            save.dataset.primary = "true";
            save.textContent = "Save feedback";
            const finish = value => {
                modalDocument.removeEventListener("keydown", onKey);
                overlay.remove();
                resolve(value);
            };
            const onKey = event => {
                if (event.key === "Escape") finish(null);
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && textarea.value.trim().length >= 3) finish(textarea.value.trim());
            };
            cancel.addEventListener("click", () => finish(null));
            save.addEventListener("click", () => {
                const reason = textarea.value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
                if (reason.length < 3) {
                    textarea.setAttribute("aria-invalid", "true");
                    textarea.focus();
                    return;
                }
                finish(reason);
            });
            overlay.addEventListener("click", event => { if (event.target === overlay) finish(null); });
            modalDocument.addEventListener("keydown", onKey);
            actions.append(cancel, save);
            dialog.append(title, note, textarea, actions);
            overlay.append(dialog);
            modalDocument.body.append(overlay);
            textarea.focus();
            textarea.select();
        });
    }

    saveSettings() {
        this.api.Data.save("settings", this.settings);
        this.removeAllButtons();
        this.scheduleScan();
    }

    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.style.cssText = "padding:16px;max-width:760px;color:var(--text-normal);line-height:1.45";

        const intro = document.createElement("p");
        intro.textContent = "Inside allowlisted Discord servers, the image magnifier sends request-scoped image bytes to the authenticated local KREA2 Vision endpoint and returns three grounded prompt variations. If automatic Krea2 contribution is enabled, all three generated prompt texts are submitted with model/pipeline IDs and an anonymous installation digest. Contributions never include image bytes or Discord identifiers. Technical failures always submit privacy-minimal operational fields to the owner-only Seedframe error console: anonymous installation digest, model, pipeline, stage, error code/message, and software versions. Mandatory error telemetry never includes an image, image hash, prompt, Discord identity or IDs, URL, filename, or local path. The separate rich failure-diagnostic option remains opt-in. Generated prompts and sanitized job metadata remain in the private local Prompt History database until you select Clear history. Small local thumbnails are retained under the configured save folder for previews; full-resolution source images are not copied into history; feedback lasts only for this Discord session.";
        panel.append(intro);

        const addField = ({label, note, key, type = "text", placeholder = "", browseFolder = false}) => {
            const wrapper = document.createElement("label");
            wrapper.style.cssText = "display:block;margin:18px 0";
            const title = document.createElement("div");
            title.textContent = label;
            title.style.cssText = "font-weight:700;margin-bottom:4px";
            const description = document.createElement("div");
            description.textContent = note;
            description.style.cssText = "font-size:12px;color:var(--text-muted);margin-bottom:7px";
            const input = document.createElement("input");
            input.type = type;
            input.value = this.settings[key] || "";
            input.placeholder = placeholder;
            input.autocomplete = "off";
            input.spellcheck = false;
            input.style.cssText = "box-sizing:border-box;width:100%;min-width:0;padding:10px;border:1px solid var(--input-border);border-radius:6px;background:var(--input-background);color:var(--text-normal)";
            input.addEventListener("change", () => {
                this.settings[key] = input.value.trim();
                this.saveSettings();
            });
            const controls = document.createElement("div");
            controls.style.cssText = "display:flex;align-items:stretch;gap:8px";
            controls.append(input);
            if (browseFolder) {
                const browse = document.createElement("button");
                browse.type = "button";
                browse.textContent = "+";
                browse.title = "Choose a local save folder";
                browse.setAttribute("aria-label", "Choose a local save folder");
                browse.style.cssText = "flex:0 0 44px;min-height:42px;border:1px solid var(--button-filled-brand-background);border-radius:7px;background:var(--button-filled-brand-background);color:var(--white-500);font-size:24px;font-weight:500;line-height:1;cursor:pointer";
                browse.addEventListener("click", async event => {
                    event.preventDefault();
                    browse.disabled = true;
                    try {
                        const current = validateSaveFolder(input.value);
                        const result = await this.api.UI.openDialog({
                            title: "Choose KREA2 local save folder",
                            defaultPath: current.ok ? current.path : DEFAULT_SAVE_FOLDER,
                            mode: "open",
                            openDirectory: true,
                            openFile: false,
                            promptToCreate: true,
                            multiSelections: false,
                            modal: true
                        });
                        if (result?.canceled === true || result?.cancelled === true) return;
                        const selected = result?.filePaths?.[0];
                        if (!selected) return;
                        const validated = validateSaveFolder(selected);
                        if (!validated.ok) throw new Error(validated.error);
                        input.value = validated.path;
                        this.settings[key] = validated.path;
                        this.historyOriginalPaths.clear();
                        for (const objectUrl of this.historyThumbnailUrls.values()) this.revokeObjectUrl(objectUrl);
                        this.historyThumbnailUrls.clear();
                        this.historyThumbnailLoads.clear();
                        this.saveSettings();
                        this.toast(`Local save folder changed to ${validated.path}`, "success");
                    }
                    catch (error) {
                        this.toast(error instanceof Error ? error.message : String(error), "error");
                    }
                    finally { browse.disabled = false; }
                });
                controls.append(browse);
            }
            wrapper.append(title, description, controls);
            panel.append(wrapper);
            return input;
        };

        const addSelect = ({label, note, key, options}) => {
            const wrapper = document.createElement("label");
            wrapper.style.cssText = "display:block;margin:18px 0";
            const title = document.createElement("div");
            title.textContent = label;
            title.style.cssText = "font-weight:700;margin-bottom:4px";
            const description = document.createElement("div");
            description.textContent = note;
            description.style.cssText = "font-size:12px;color:var(--text-muted);margin-bottom:7px";
            const select = document.createElement("select");
            select.style.cssText = "box-sizing:border-box;width:100%;padding:10px;border:1px solid var(--input-border);border-radius:6px;background:var(--input-background);color:var(--text-normal)";
            for (const [optionLabel, value] of options) {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = optionLabel;
                select.append(option);
            }
            select.value = this.settings[key] || DEFAULT_SETTINGS[key];
            select.addEventListener("change", () => {
                this.settings[key] = select.value;
                this.saveSettings();
            });
            wrapper.append(title, description, select);
            panel.append(wrapper);
            return select;
        };

        const addCheckbox = ({label, note, key}) => {
            const wrapper = document.createElement("label");
            wrapper.style.cssText = "display:flex;align-items:flex-start;gap:10px;margin:18px 0";
            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = this.settings[key] === true;
            input.style.marginTop = "4px";
            const copy = document.createElement("div");
            const title = document.createElement("div");
            title.textContent = label;
            title.style.fontWeight = "700";
            const description = document.createElement("div");
            description.textContent = note;
            description.style.cssText = "font-size:12px;color:var(--text-muted);margin-top:3px";
            copy.append(title, description);
            input.addEventListener("change", async () => {
                if (key === "shareDatasetContributions" && input.checked) {
                    const accepted = await this.confirmPrivacyReceipt();
                    if (!accepted) input.checked = false;
                }
                if (key === "shareFailureDiagnostics" && input.checked) {
                    const accepted = await this.confirmDiagnosticReceipt();
                    if (!accepted) input.checked = false;
                }
                if (key === "shareFailureDiagnostics" && !input.checked) {
                    this.api.Data.delete?.("diagnosticPrivacyReceipt");
                    this.api.Data.save("diagnosticPrivacyReceipt", null);
                }
                this.settings[key] = input.checked;
                this.saveSettings();
            });
            wrapper.append(input, copy);
            panel.append(wrapper);
        };

        addField({
            label: "Allowed Discord server IDs",
            note: "Comma- or space-separated numeric server IDs. An empty list disables the Discord image magnifier.",
            key: "allowedGuildIds",
            placeholder: "123456789012345678"
        });

        const route = parseDiscordRoute(location.pathname);
        const bindButton = document.createElement("button");
        bindButton.type = "button";
        bindButton.textContent = route.guildId && route.guildId !== "@me" ? `Allow current server (${route.guildId})` : "Open a server channel to bind it";
        bindButton.disabled = !this.getChannelVerifiedRoute();
        bindButton.style.cssText = "padding:8px 12px;border:0;border-radius:6px;background:var(--button-positive-background);color:var(--white-500);cursor:pointer";
        bindButton.addEventListener("click", () => {
            const verified = this.getChannelVerifiedRoute();
            if (!verified) return;
            const ids = parseGuildAllowlist(this.settings.allowedGuildIds);
            ids.add(verified.guildId);
            this.settings.allowedGuildIds = [...ids].join(", ");
            this.saveSettings();
            this.toast(`Allowed Discord server ${verified.guildId}. Reopen settings to see the updated field.`, "success");
        });
        panel.append(bindButton);

        addField({
            label: "Local KREA2 Vision broker endpoint",
            note: "Both Local GPU and Online API modes connect only to this literal-loopback broker. The private remote address and provider credential never enter BetterDiscord.",
            key: "visionEndpoint",
            type: "url",
            placeholder: "http://127.0.0.1:7870/api/discord-describe"
        });
        addField({
            label: "Required local Vision token",
            note: "This long-lived local secret is sent only to the loopback session exchange. Every image POST uses a request-bound, short-lived, one-use session instead, preventing captured request replay.",
            key: "visionToken",
            type: "password",
            placeholder: "32+ character local Vision secret"
        });
        const executionSelect = addSelect({
            label: "Vision execution",
            note: "Local GPU uses the model selected below and the exact shared Forge FIFO. Online API uses the private Gemma 4 26B-A4B worker and consumes no local VRAM.",
            key: "visionExecutionMode",
            options: VISION_EXECUTION_OPTIONS
        });
        const modelSelect = addSelect({
            label: "Local GPU Vision model",
            note: "The 8B Heretic model is preferred after live testing. Its 13,312 MiB estimate exceeds the 12 GiB allocation target, so Vision Studio still performs the authoritative post-Forge-unload admission check before every run.",
            key: "visionModel",
            options: VISION_MODEL_OPTIONS
        });
        const syncExecutionControls = () => {
            const online = normalizeVisionExecutionMode(executionSelect.value) === "online";
            modelSelect.disabled = online;
            modelSelect.parentElement.style.opacity = online ? ".45" : "1";
            modelSelect.parentElement.title = online
                ? "Disabled because Online API always uses Gemma 4 26B-A4B Heretic Q3_K_L."
                : "";
        };
        executionSelect.addEventListener("change", syncExecutionControls);
        syncExecutionControls();
        const onboardingButton = document.createElement("button");
        onboardingButton.type = "button";
        onboardingButton.textContent = "Review model & VRAM setup";
        onboardingButton.style.cssText = "padding:8px 12px;border:1px solid var(--input-border);border-radius:7px;background:var(--background-modifier-accent);color:var(--text-normal);cursor:pointer;font-weight:700";
        onboardingButton.addEventListener("click", () => void this.openOnboarding());
        panel.append(onboardingButton);
        addCheckbox({
            label: "Automatically contribute my three generated prompts to Krea2",
            note: "Off by default for new installs. When enabled after consent, every successful interrogation submits its three generated prompts through the authenticated local Vision broker. No image bytes, image hashes, Discord identifiers, filenames, paths, or reusable Seedframe credential leave the plugin.",
            key: "shareDatasetContributions"
        });
        addCheckbox({
            label: "Share failed Vision diagnostics with Krea2",
            note: "Optional and off by default. After explicit consent, failed requests may additionally attach the source image, your Discord username, and an available partial or audited prompt to the owner-only Seedframe diagnostics console. This is separate from mandatory privacy-minimal technical error logging, which never contains images, prompts, Discord identity, URLs, filenames, or paths.",
            key: "shareFailureDiagnostics"
        });
        addCheckbox({
            label: "Guide prompts with the Krea2 example dataset",
            note: "Off by default. When enabled, Vision Studio randomly selects exactly eight Krea2 prompts plus up to four session-liked prompts and three session-disliked prompts with your reasons. The three results target 60% structural/style likeness and 40% fresh wording while every image fact stays grounded in what the model can see.",
            key: "useKrea2DatasetGuidance"
        });
        addCheckbox({
            label: "Show completion notifications",
            note: "Displays a BetterDiscord toast and a clickable result banner when a queued image finishes.",
            key: "completionToasts"
        });
        addCheckbox({
            label: "Play a short completion sound",
            note: "Uses a brief local tone only when a queued Vision job changes to a terminal state.",
            key: "completionSound"
        });
        const status = document.createElement("div");
        const allowed = Boolean(this.getVerifiedRoute());
        status.textContent = route.guildId
            ? `Current server ${route.guildId}: ${allowed ? "channel verified and allowed" : "not allowed or ChannelStore verification failed"}`
            : "Open a Discord server channel to see its server ID here.";
        status.style.cssText = `margin-top:18px;padding:10px;border-radius:6px;background:${allowed ? "rgba(35,145,79,.18)" : "rgba(190,48,48,.15)"}`;
        panel.append(status);

        return panel;
    }

    toast(message, type = "info") {
        try {
            this.api.UI.showToast(String(message), {type, timeout: 5000});
        }
        catch {
            this.log(type === "error" ? "error" : "info", message);
        }
    }

    notifyJobCompletion(job) {
        this.lastCompletionJobId = job.id;
        if (this.settings.completionToasts !== false) {
            const message = job.status === "completed"
                ? `${historyJobTitle(job)} is ready. Open Prompt History to view it.`
                : `${historyJobTitle(job)} finished with ${job.status}.`;
            this.toast(message, job.status === "completed" ? "success" : "warning");
        }
        if (this.settings.completionSound === true) {
            try {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                const context = new AudioContext();
                const oscillator = context.createOscillator();
                const gain = context.createGain();
                oscillator.frequency.value = job.status === "completed" ? 740 : 330;
                gain.gain.setValueAtTime(.035, context.currentTime);
                gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + .18);
                oscillator.connect(gain).connect(context.destination);
                oscillator.start();
                oscillator.stop(context.currentTime + .18);
                oscillator.addEventListener("ended", () => void context.close(), {once: true});
            }
            catch {}
        }
        this.renderHistoryRail();
    }

    log(level, ...args) {
        const logger = this.api?.Logger;
        if (logger && typeof logger[level] === "function") logger[level](...args);
        else console[level === "error" ? "error" : "log"](`[${PLUGIN_NAME}]`, ...args);
    }
}

Krea2DiscordCollector.helpers = Object.freeze({
    applyPromptPreset,
    buildPromptFeedbackContext,
    buildOperationalErrorReport,
    buildVisionCacheProfile,
    buildVisionMultipartBody,
    classifyPromptMetadata,
    comparisonPromptSidecarPath,
    cosineSimilarity,
    chooseBestMediaUrl,
    clearHistoryThumbnailCache,
    decodeHtmlEntities,
    DEFAULT_SETTINGS,
    formatDownloadGiB,
    formatVramMiB,
    detectImageFormat,
    effectiveVisionModel,
    evaluatePromptValue,
    extractConfidentPrompt,
    extractMediaProvenance,
    filenameFromContentDisposition,
    filenameFromUrl,
    filterHistoryJobs,
    formatAverageQueueTime,
    formatHistoryDuration,
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
    isMetadataPlusOwner,
    isCurrentPrivacyReceipt,
    isCurrentDiagnosticReceipt,
    isVisionSupportedFormat,
    KREA2_CONTRIBUTION_TERMS_VERSION,
    KREA2_DIAGNOSTIC_TERMS_VERSION,
    mediaCandidateScore,
    metadataProbeCacheKey,
    mergeHereticModelTelemetry,
    normalizeDatasetGuidanceState,
    normalizePromptFeedbackText,
    normalizeMediaUrl,
    normalizePromptPreset,
    normalizeStoredSubmissionKey,
    normalizeVisionCacheProfile,
    normalizeVisionExecutionMode,
    normalizeVisionPrompt,
    ONLINE_VISION_MODEL_ID,
    ONLINE_VISION_MODEL_LABEL,
    parseImageMetadata,
    parseDiscordRoute,
    parseGuildAllowlist,
    parseHistoryDetailResponse,
    parseHistoryListResponse,
    parseUploadResponse,
    parseStudioErrorDetail,
    parseVisionPromptResponse,
    PRIVACY_RECEIPT_VERSION,
    DIAGNOSTIC_RECEIPT_VERSION,
    promptDiffSummary,
    promptPresetGuidance,
    readBoundedResponseText,
    readFileCompat,
    readReusableVisionPrompt,
    saveOriginalImage,
    savePromptSidecar,
    saveVisionPromptSidecar,
    safeModelFilePart,
    sanitizePromptFeedbackRecord,
    sanitizeOperationalErrorText,
    sanitizeFilename,
    sha256Hex,
    submissionKey,
    validateSaveFolder,
    validateEndpoint,
    validateVisionLoopbackEndpoint,
    visionCacheProfileDigest,
    visionModelDisplayName,
    visionPromptSidecarPath,
    visionRequestCacheKey,
    VISION_PIPELINE_ID,
    writeFileCompat
});

module.exports = Krea2DiscordCollector;
