/**
 * @name Krea2DiscordCollector
 * @author uroligh
 * @version 0.16.1
 * @description Local or online Discord Vision, metadata-first prompts, and a private Qwen 3.8 cloud prompt editor.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const {createHash, randomBytes} = require("crypto");

const {parsePngPromptMetadata: parseHardenedPngPromptMetadata, extractPromptFromMetadataDocument: extractMetadataDocumentPrompt} = (() => {
    const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const SUPPORTED_KEYS = new Set(["parameters", "prompt"]);
    const STATUS_PRIORITY = Object.freeze([
        "structured",
        "encoded_or_unknown",
        "non_english",
        "metadata_no_prompt"
    ]);

    const DEFAULT_LIMITS = Object.freeze({
        maxFileBytes: 64 * 1024 * 1024,
        maxChunks: 4096,
        maxMetadataChunkBytes: 2 * 1024 * 1024,
        maxTextBytes: 1024 * 1024,
        maxTotalTextBytes: 2 * 1024 * 1024,
        maxNormalizedChars: 1024 * 1024,
        maxCandidates: 32,
        maxKeywordBytes: 79,
        maxAncillaryFieldBytes: 4096
    });

    const STRUCTURED_PROMPT_LIMITS = Object.freeze({
        maxDocumentChars: 5 * 1024 * 1024,
        maxNodes: 10000,
        maxReferences: 50000,
        maxTraversalDepth: 64,
        maxPromptChars: 64 * 1024
    });

    const UTF8_FATAL_DECODER = new TextDecoder("utf-8", {fatal: true});

    function boundedInteger(value, fallback, minimum, maximum) {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < minimum) return fallback;
        return Math.min(number, maximum);
    }

    function resolveLimits(options) {
        const source = options && typeof options === "object" ? options : {};
        return {
            maxFileBytes: boundedInteger(source.maxFileBytes, DEFAULT_LIMITS.maxFileBytes, 64, 512 * 1024 * 1024),
            maxChunks: boundedInteger(source.maxChunks, DEFAULT_LIMITS.maxChunks, 1, 100000),
            maxMetadataChunkBytes: boundedInteger(source.maxMetadataChunkBytes, DEFAULT_LIMITS.maxMetadataChunkBytes, 16, 32 * 1024 * 1024),
            maxTextBytes: boundedInteger(source.maxTextBytes, DEFAULT_LIMITS.maxTextBytes, 16, 16 * 1024 * 1024),
            maxTotalTextBytes: boundedInteger(source.maxTotalTextBytes, DEFAULT_LIMITS.maxTotalTextBytes, 16, 32 * 1024 * 1024),
            maxNormalizedChars: boundedInteger(source.maxNormalizedChars, DEFAULT_LIMITS.maxNormalizedChars, 16, 16 * 1024 * 1024),
            maxCandidates: boundedInteger(source.maxCandidates, DEFAULT_LIMITS.maxCandidates, 1, 1024),
            maxKeywordBytes: boundedInteger(source.maxKeywordBytes, DEFAULT_LIMITS.maxKeywordBytes, 1, 79),
            maxAncillaryFieldBytes: boundedInteger(source.maxAncillaryFieldBytes, DEFAULT_LIMITS.maxAncillaryFieldBytes, 1, 64 * 1024)
        };
    }

    function toBuffer(input) {
        if (Buffer.isBuffer(input)) return input;
        if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
        if (input instanceof ArrayBuffer) return Buffer.from(input);
        if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
        return null;
    }

    function createDiagnostics(inputBytes) {
        return {
            isPng: false,
            inputBytes,
            chunksScanned: 0,
            textChunksSeen: 0,
            recognizedEntries: 0,
            candidatesEvaluated: 0,
            decodedTextBytes: 0,
            malformedChunks: 0,
            malformedTextChunks: 0,
            oversizedTextChunks: 0,
            decompressionFailures: 0,
            limitHit: null,
            sawIend: false,
            selectedChunkType: null,
            selectedCompressed: null,
            selectedEncoding: null,
            htmlDecoded: false,
            wrapperStripped: false,
            negativePromptFound: false,
            normalizedChars: null,
            promptChars: null,
            nonLatinLetterRatio: null,
            rejectionCounts: {
                metadata_no_prompt: 0,
                encoded_or_unknown: 0,
                structured: 0,
                non_english: 0
            }
        };
    }

    function result(status, prompt, sourceKey, reason, diagnostics, selected) {
        const chosen = selected || {};
        return {
            status,
            prompt: status === "found" ? prompt : null,
            sourceKey: sourceKey || null,
            reason,
            diagnostics: {
                ...diagnostics,
                selectedChunkType: chosen.chunkType || null,
                selectedCompressed: typeof chosen.compressed === "boolean" ? chosen.compressed : null,
                selectedEncoding: chosen.encoding || null,
                htmlDecoded: Boolean(chosen.htmlDecoded),
                wrapperStripped: Boolean(chosen.wrapperStripped),
                negativePromptFound: Boolean(chosen.negativePromptFound),
                normalizedChars: Number.isSafeInteger(chosen.normalizedChars) ? chosen.normalizedChars : null,
                promptChars: Number.isSafeInteger(chosen.promptChars) ? chosen.promptChars : null,
                nonLatinLetterRatio: Number.isFinite(chosen.nonLatinLetterRatio)
                    ? Number(chosen.nonLatinLetterRatio.toFixed(4))
                    : null,
                rejectionCounts: {...diagnostics.rejectionCounts}
            }
        };
    }

    function canonicalKeyword(payload, limits) {
        const searchLength = Math.min(payload.length, limits.maxKeywordBytes + 1);
        const separator = payload.subarray(0, searchLength).indexOf(0);
        if (separator < 1 || separator > limits.maxKeywordBytes) return {key: null, separator: -1};
        const keyword = payload.subarray(0, separator).toString("latin1").toLowerCase();
        return {key: SUPPORTED_KEYS.has(keyword) ? keyword : null, separator};
    }

    function findBoundedNul(payload, start, maximumBytes) {
        if (start < 0 || start >= payload.length) return -1;
        const end = Math.min(payload.length, start + maximumBytes + 1);
        const relative = payload.subarray(start, end).indexOf(0);
        return relative < 0 ? -1 : start + relative;
    }

    function decodeUtf8(bytes) {
        return UTF8_FATAL_DECODER.decode(bytes);
    }

    function decodePngLatinText(bytes) {
        if (!bytes.some(byte => byte >= 0x80)) return {text: bytes.toString("ascii"), encoding: "ascii"};
        try {
            return {text: decodeUtf8(bytes), encoding: "utf8"};
        }
        catch {
            return {text: bytes.toString("latin1"), encoding: "latin1"};
        }
    }

    async function inflateBounded(bytes, maxOutputLength) {
        if (typeof DecompressionStream !== "function" || typeof Blob !== "function") {
            throw new Error("Deflate decompression is unavailable in this renderer.");
        }
        const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
        const chunks = [];
        let total = 0;
        try {
            while (true) {
                const {done, value} = await reader.read();
                if (done) break;
                if (!value?.byteLength) continue;
                total += value.byteLength;
                if (total > maxOutputLength) {
                    await reader.cancel("Metadata decompression limit exceeded").catch(() => {});
                    throw new Error("Metadata decompression limit exceeded.");
                }
                chunks.push(Buffer.from(value));
            }
        }
        finally {
            reader.releaseLock?.();
        }
        return Buffer.concat(chunks, total);
    }

    function makeRejected(sourceKey, reason, chunkType, compressed, encoding, extra) {
        return {
            status: "encoded_or_unknown",
            sourceKey,
            reason,
            chunkType,
            compressed,
            encoding: encoding || null,
            ...(extra || {})
        };
    }

    async function parseTextChunk(type, payload, limits) {
        const keyword = canonicalKeyword(payload, limits);
        if (!keyword.key) return {recognized: false};

        const compressed = type === "zTXt";
        if (payload.length > limits.maxMetadataChunkBytes) {
            return {
                recognized: true,
                rejection: makeRejected(keyword.key, "metadata_chunk_too_large", type, compressed)
            };
        }

        if (type === "tEXt") {
            const textBytes = payload.subarray(keyword.separator + 1);
            if (textBytes.length > limits.maxTextBytes) {
                return {
                    recognized: true,
                    rejection: makeRejected(keyword.key, "metadata_text_too_large", type, false)
                };
            }
            const decoded = decodePngLatinText(textBytes);
            return {
                recognized: true,
                candidate: {
                    sourceKey: keyword.key,
                    text: decoded.text,
                    decodedBytes: textBytes.length,
                    chunkType: type,
                    compressed: false,
                    encoding: decoded.encoding
                }
            };
        }

        if (type === "zTXt") {
            if (keyword.separator + 2 > payload.length) {
                return {
                    recognized: true,
                    malformed: true,
                    rejection: makeRejected(keyword.key, "malformed_metadata_chunk", type, true)
                };
            }
            if (payload[keyword.separator + 1] !== 0) {
                return {
                    recognized: true,
                    rejection: makeRejected(keyword.key, "unsupported_compression", type, true)
                };
            }
            try {
                const inflated = await inflateBounded(payload.subarray(keyword.separator + 2), limits.maxTextBytes);
                const decoded = decodePngLatinText(inflated);
                return {
                    recognized: true,
                    candidate: {
                        sourceKey: keyword.key,
                        text: decoded.text,
                        decodedBytes: inflated.length,
                        chunkType: type,
                        compressed: true,
                        encoding: decoded.encoding
                    }
                };
            }
            catch {
                return {
                    recognized: true,
                    decompressionFailure: true,
                    rejection: makeRejected(keyword.key, "decompression_failed_or_too_large", type, true)
                };
            }
        }

        if (keyword.separator + 3 > payload.length) {
            return {
                recognized: true,
                malformed: true,
                rejection: makeRejected(keyword.key, "malformed_metadata_chunk", type, null)
            };
        }

        const compressionFlag = payload[keyword.separator + 1];
        const compressionMethod = payload[keyword.separator + 2];
        if ((compressionFlag !== 0 && compressionFlag !== 1) || compressionMethod !== 0) {
            return {
                recognized: true,
                rejection: makeRejected(keyword.key, "unsupported_compression", type, compressionFlag === 1)
            };
        }

        let cursor = keyword.separator + 3;
        const languageEnd = findBoundedNul(payload, cursor, limits.maxAncillaryFieldBytes);
        if (languageEnd < 0) {
            return {
                recognized: true,
                malformed: true,
                rejection: makeRejected(keyword.key, "malformed_or_oversized_itxt_header", type, compressionFlag === 1)
            };
        }
        cursor = languageEnd + 1;
        const translatedEnd = findBoundedNul(payload, cursor, limits.maxAncillaryFieldBytes);
        if (translatedEnd < 0) {
            return {
                recognized: true,
                malformed: true,
                rejection: makeRejected(keyword.key, "malformed_or_oversized_itxt_header", type, compressionFlag === 1)
            };
        }
        cursor = translatedEnd + 1;
        const encodedText = payload.subarray(cursor);

        let textBytes = encodedText;
        if (compressionFlag === 1) {
            try {
                textBytes = await inflateBounded(encodedText, limits.maxTextBytes);
            }
            catch {
                return {
                    recognized: true,
                    decompressionFailure: true,
                    rejection: makeRejected(keyword.key, "decompression_failed_or_too_large", type, true)
                };
            }
        }
        if (textBytes.length > limits.maxTextBytes) {
            return {
                recognized: true,
                rejection: makeRejected(keyword.key, "metadata_text_too_large", type, compressionFlag === 1)
            };
        }
        try {
            return {
                recognized: true,
                candidate: {
                    sourceKey: keyword.key,
                    text: decodeUtf8(textBytes),
                    decodedBytes: textBytes.length,
                    chunkType: type,
                    compressed: compressionFlag === 1,
                    encoding: "utf8"
                }
            };
        }
        catch {
            return {
                recognized: true,
                rejection: makeRejected(keyword.key, "invalid_utf8_text", type, compressionFlag === 1)
            };
        }
    }

    function decodeHtmlEntitiesOnce(raw) {
        const named = Object.freeze({
            amp: "&", apos: "'", bull: "•", copy: "©", divide: "÷", gt: ">", hellip: "…",
            ldquo: "“", lsquo: "‘", lt: "<", mdash: "—", middot: "·", nbsp: " ", ndash: "–",
            plusmn: "±", quot: '"', rdquo: "”", reg: "®", rsquo: "’", times: "×", trade: "™"
        });
        return String(raw).replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (whole, entity) => {
            if (entity[0] !== "#") return named[entity.toLowerCase()] || whole;
            const hexadecimal = entity[1] && entity[1].toLowerCase() === "x";
            const value = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
            if (!Number.isSafeInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
                return whole;
            }
            try {
                return String.fromCodePoint(value);
            }
            catch {
                return whole;
            }
        });
    }

    function isPlainRecord(value) {
        return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    }

    function repairKnownUtf8Mojibake(raw) {
        const replacements = Object.freeze({
            "â€”": "—",
            "â€“": "–",
            "â€™": "’",
            "â€˜": "‘",
            "â€œ": "“",
            "â€�": "”",
            "Â ": " "
        });
        return String(raw).replace(/â€”|â€“|â€™|â€˜|â€œ|â€�|Â /g, match => replacements[match] || match);
    }

    function normalizeStructuredPromptText(raw) {
        let text;
        try {
            text = decodeHtmlEntitiesOnce(String(raw || ""))
                .normalize("NFKC")
                .replace(/^\uFEFF+/, "")
                .replace(/\r\n?|\u2028|\u2029/g, "\n")
                .trim();
        }
        catch {
            return "";
        }
        return repairKnownUtf8Mojibake(text).trim();
    }

    function scanBalancedJsonPrefix(raw, start) {
        const text = String(raw || "");
        const first = Number.isSafeInteger(start) ? start : 0;
        if (text[first] !== "{" && text[first] !== "[") return null;
        const stack = [];
        let quoted = false;
        let escaped = false;
        for (let index = first; index < text.length; index += 1) {
            const character = text[index];
            if (quoted) {
                if (escaped) escaped = false;
                else if (character === "\\") escaped = true;
                else if (character === '"') quoted = false;
                continue;
            }
            if (character === '"') {
                quoted = true;
                continue;
            }
            if (character === "{" || character === "[") stack.push(character);
            else if (character === "}" || character === "]") {
                const expected = character === "}" ? "{" : "[";
                if (stack.pop() !== expected) return null;
                if (!stack.length) return {json: text.slice(first, index + 1), end: index + 1};
            }
        }
        return null;
    }

    function comfyNodeMap(value, maximumNodes) {
        const possible = isPlainRecord(value?.prompt) ? value.prompt : value;
        if (!isPlainRecord(possible)) return null;
        const entries = Object.entries(possible);
        if (!entries.length || entries.length > maximumNodes) return null;
        const nodes = new Map();
        for (const [id, node] of entries) {
            if (!isPlainRecord(node) || !isPlainRecord(node.inputs) || typeof node.class_type !== "string") continue;
            nodes.set(String(id), node);
        }
        return nodes.size ? nodes : null;
    }

    function directReferenceId(value, nodes) {
        if (!Array.isArray(value) || value.length < 1) return null;
        const id = String(value[0]);
        return nodes.has(id) ? id : null;
    }

    function collectInputReferences(value, nodes, output, state, depth = 0) {
        if (depth > 12) {
            state.truncated = true;
            return;
        }
        if (state.references >= state.maxReferences) return;
        const direct = directReferenceId(value, nodes);
        if (direct) {
            output.add(direct);
            state.references += 1;
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) collectInputReferences(item, nodes, output, state, depth + 1);
            return;
        }
        if (!isPlainRecord(value)) return;
        for (const item of Object.values(value)) collectInputReferences(item, nodes, output, state, depth + 1);
    }

    function collectUpstreamNodeIds(startValue, nodes, limits, sharedState) {
        const roots = new Set();
        collectInputReferences(startValue, nodes, roots, sharedState);
        const visited = new Set();
        const queue = [...roots].map(id => ({id, depth: 0}));
        while (queue.length && sharedState.references < limits.maxReferences) {
            const current = queue.shift();
            if (!current || visited.has(current.id)) continue;
            if (current.depth > limits.maxTraversalDepth) {
                sharedState.truncated = true;
                continue;
            }
            visited.add(current.id);
            const node = nodes.get(current.id);
            if (!node) continue;
            const references = new Set();
            collectInputReferences(node.inputs, nodes, references, sharedState);
            for (const id of references) {
                if (!visited.has(id)) queue.push({id, depth: current.depth + 1});
            }
        }
        return visited;
    }

    function resolvePromptInput(value, nodes, limits, sharedState, depth = 0, visited = new Set()) {
        if (depth > 16) {
            sharedState.truncated = true;
            return [];
        }
        if (sharedState.references >= limits.maxReferences) return [];
        if (typeof value === "string") return [value];
        const reference = directReferenceId(value, nodes);
        if (!reference || visited.has(reference)) return [];
        visited.add(reference);
        sharedState.references += 1;
        const node = nodes.get(reference);
        if (!node) return [];
        const values = [];
        for (const key of ["text", "text1", "value", "string", "prompt", "positive_prompt"]) {
            if (!(key in node.inputs)) continue;
            values.push(...resolvePromptInput(node.inputs[key], nodes, limits, sharedState, depth + 1, visited));
        }
        return values;
    }

    function nodeLooksImageConditioned(node) {
        const label = `${node?.class_type || ""} ${node?._meta?.title || ""}`;
        return /\b(?:VAE\s*Encode|Reference\s*Latent|Load\s*Image|IPAdapter|ControlNet|Image\s*(?:Encode|Condition))\b/i.test(label);
    }

    function candidateTextsFromNode(id, node, nodes, limits, sharedState) {
        const label = `${node?.class_type || ""} ${node?._meta?.title || ""}`;
        if (/negative/i.test(label)) return [];
        if (!/(?:CLIP.*Text.*Encode|Text.*Encode)/i.test(label)) return [];
        const values = [];
        let direct = false;
        for (const key of ["text", "text_g", "text_l", "prompt", "positive_prompt"]) {
            if (!(key in node.inputs)) continue;
            if (typeof node.inputs[key] === "string") direct = true;
            for (const raw of resolvePromptInput(node.inputs[key], nodes, limits, sharedState)) {
                const prompt = normalizeStructuredPromptText(raw);
                if (!prompt || prompt.length > limits.maxPromptChars) continue;
                values.push({id, prompt, direct});
            }
        }
        return values;
    }

    function extractComfyPositivePrompt(graph, options = {}) {
        const limits = {
            ...STRUCTURED_PROMPT_LIMITS,
            ...(options && typeof options === "object" ? options : {})
        };
        const nodes = comfyNodeMap(graph, limits.maxNodes);
        if (!nodes) return {status: "invalid", reason: "not_comfyui_prompt_graph"};

        const samplers = [...nodes.entries()].filter(([, node]) => /sampler/i.test(String(node.class_type || "")) && node.inputs.positive !== undefined);
        if (!samplers.length) return {status: "no_prompt", reason: "comfyui_sampler_not_found"};

        const sharedState = {references: 0, maxReferences: limits.maxReferences, truncated: false};
        const candidates = [];
        for (const [samplerId, sampler] of samplers) {
            const positiveNodes = collectUpstreamNodeIds(sampler.inputs.positive, nodes, limits, sharedState);
            const latentNodes = collectUpstreamNodeIds(sampler.inputs.latent_image, nodes, limits, sharedState);
            const imageConditioned = [...positiveNodes, ...latentNodes].some(id => nodeLooksImageConditioned(nodes.get(id)));
            for (const id of positiveNodes) {
                const node = nodes.get(id);
                for (const candidate of candidateTextsFromNode(id, node, nodes, limits, sharedState)) {
                    candidates.push({...candidate, samplerId, imageConditioned});
                }
            }
        }
        if (sharedState.truncated) return {status: "invalid", reason: "comfyui_traversal_limit"};
        if (sharedState.references >= limits.maxReferences) return {status: "invalid", reason: "comfyui_reference_limit"};
        if (!candidates.length) return {status: "no_prompt", reason: "comfyui_positive_text_not_found"};

        const baseCandidates = candidates.filter(candidate => !candidate.imageConditioned);
        let pool = baseCandidates.length ? baseCandidates : candidates;
        if (!baseCandidates.length) {
            const directCandidates = pool.filter(candidate => candidate.direct);
            if (directCandidates.length) pool = directCandidates;
        }
        const unique = new Map();
        for (const candidate of pool) {
            const key = candidate.prompt.replace(/\s+/g, " ").trim();
            if (!unique.has(key)) unique.set(key, candidate);
        }
        if (unique.size !== 1) {
            return {status: "ambiguous", reason: "multiple_comfyui_positive_prompts", candidateCount: unique.size};
        }
        const selected = [...unique.values()][0];
        return {
            status: "found",
            reason: "comfyui_positive_prompt_extracted",
            prompt: selected.prompt,
            nodeId: selected.id,
            samplerId: selected.samplerId
        };
    }

    function extractPromptFromMetadataDocument(raw, options = {}) {
        const text = String(raw || "").replace(/^\uFEFF+/, "").replace(/\r\n?/g, "\n").trim();
        const maximum = Number.isSafeInteger(options.maxDocumentChars)
            ? Math.min(options.maxDocumentChars, STRUCTURED_PROMPT_LIMITS.maxDocumentChars)
            : STRUCTURED_PROMPT_LIMITS.maxDocumentChars;
        if (!text || text.length > maximum) return {status: "invalid", reason: text ? "structured_document_too_large" : "empty_document"};

        let start = -1;
        let recognized = false;
        const wrapper = text.match(/^prompt\s*:\s*/i);
        const wrapped = Boolean(wrapper);
        if (wrapper) {
            recognized = true;
            start = wrapper[0].length;
            while (/\s/.test(text[start] || "")) start += 1;
        }
        else if (options.allowBareComfyJson === true && (text[0] === "{" || text[0] === "[")) {
            recognized = true;
            start = 0;
        }
        if (!recognized || (text[start] !== "{" && text[start] !== "[")) {
            return {status: "not_structured", reason: "comfyui_prompt_wrapper_not_found"};
        }
        const scanned = scanBalancedJsonPrefix(text, start);
        if (!scanned) {
            return wrapped
                ? {status: "invalid", reason: "malformed_comfyui_prompt_json"}
                : {status: "not_structured", reason: "bare_value_not_comfyui_json"};
        }
        let graph;
        try { graph = JSON.parse(scanned.json); }
        catch {
            return wrapped
                ? {status: "invalid", reason: "malformed_comfyui_prompt_json"}
                : {status: "not_structured", reason: "bare_value_not_comfyui_json"};
        }
        const extracted = extractComfyPositivePrompt(graph, options);
        if (!wrapped && extracted.status === "invalid" && extracted.reason === "not_comfyui_prompt_graph") {
            return {status: "not_structured", reason: "bare_value_not_comfyui_graph"};
        }
        return extracted;
    }

    function looksLikeJsonContainer(raw) {
        const text = String(raw).trim();
        if (!text || (text[0] !== "{" && text[0] !== "[")) return false;
        try {
            const parsed = JSON.parse(text);
            return parsed !== null && typeof parsed === "object";
        }
        catch {
            if (text[0] === "{") return text.endsWith("}") && /["'}\w-]+\s*:/.test(text);
            return text.endsWith("]")
                && /(?:["'{\[]|\b(?:true|false|null)\b|(?:^|,)\s*-?\d+(?:\.\d+)?\s*(?:,|$))/i.test(text.slice(1, -1));
        }
    }

    function looksLikeStructuredDocument(raw) {
        const text = String(raw).trim();
        if (!text) return false;
        if (/^(?:---|\.\.\.|%YAML\b|%TAG\b|!!(?:map|seq|str)\b|!<[^>]+>|```(?:ya?ml|json)?\b)/i.test(text)) return true;

        const lines = text.split("\n").filter(line => line.trim());
        if (lines.length < 2) return false;
        const mappings = lines.filter(line => /^\s*(?:-\s*)?[A-Za-z_][\w .-]{0,50}:\s*(?:\S.*)?$/.test(line));
        const structuredLists = lines.filter(line => /^\s*-\s+(?:[A-Za-z_][\w .-]{0,40}:|[\[{])/.test(line));
        const indentedValues = lines.filter(line => /^\s{2,}\S/.test(line));
        return mappings.length >= 2
            || (mappings.length >= 1 && structuredLists.length >= 1)
            || (mappings.length >= 1 && indentedValues.length >= 2);
    }

    function shannonEntropy(raw) {
        const text = String(raw);
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

    function looksEncodedOrEncrypted(raw) {
        const text = String(raw).trim();
        if (!text) return false;
        if (/^-----BEGIN [A-Z0-9 ][A-Z0-9 -]*-----/i.test(text)) return true;
        if (/^(?:enc(?:rypted)?|ciphertext|base64|data:[^;\s]+;base64|age-encryption\.org\/v1)\s*[:;]/i.test(text)) return true;
        if (/^(?:U2FsdGVkX1|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.)/.test(text)) return true;

        const compact = text.replace(/\s+/g, "");
        if (compact.length >= 64 && /^[A-Fa-f0-9]+$/.test(compact)) return true;

        const wordCount = (text.match(/[A-Za-z]{2,}/g) || []).length;
        const hasWordSpaces = /[ \t]/.test(text) && wordCount >= 3;
        const standardBase64 = compact.length >= 64
            && compact.length % 4 === 0
            && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
        const urlBase64 = compact.length >= 80
            && /^[A-Za-z0-9_-]+={0,2}$/.test(compact);
        if ((standardBase64 || urlBase64) && !hasWordSpaces) return true;

        const percentEscapes = text.match(/%[0-9A-Fa-f]{2}/g) || [];
        if (text.length >= 72 && percentEscapes.length * 3 >= text.length * 0.45) return true;

        const whitespaceRatio = (text.match(/\s/g) || []).length / text.length;
        return text.length >= 96 && whitespaceRatio < 0.035 && shannonEntropy(text) >= 4.75;
    }

    function languageAssessment(raw) {
        const text = String(raw);
        const letters = text.match(/\p{L}/gu) || [];
        if (letters.length < 4) return {nonEnglish: false, nonLatinLetterRatio: 0};

        const latinCount = letters.filter(letter => /\p{Script=Latin}/u.test(letter)).length;
        const nonLatinCount = letters.length - latinCount;
        const nonLatinLetterRatio = nonLatinCount / letters.length;
        if (nonLatinCount >= 4 && nonLatinLetterRatio >= 0.3) {
            return {nonEnglish: true, nonLatinLetterRatio};
        }

        const words = (text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").match(/[a-z]{2,}/g) || []);
        if (!words.length) return {nonEnglish: true, nonLatinLetterRatio};

        const englishFunctionWords = new Set(
            "a about above across after against all along also an and another any around as at away back be because been before behind below beneath beside between both but by can could down during each even every few for from had has have he her here hers him his how if in into is it its may more most near no not of off on one only or other our out over she should since so some than that the their them then there these they this those through to too under up upon very was we were what when where which while who will with within without would you your".split(" ")
        );
        const englishVisualWords = new Set(
            "analog animal architecture award background beach beautiful best black blonde blue body bokeh brown candid cinematic closeup clothing composition couch dark depth detailed details detail digital dog dramatic dress dynamic editorial environment eyes face fantasy female field film freckles fullbody girl glossy gray green hair high highly indoor intricate lens light lighting long makeup man masterpiece minimalist natural orange photo photograph photographic photorealistic portrait quality raw rays realistic red resolution scene sharp short shot skin soft studio style sunlight tattoo texture ultra vibrant volumetric white winning woman young".split(" ")
        );
        const foreignSignals = new Set(
            "avec bella bellissima belle bonita cabello cabelos capelli cheveux chica com con dai dans de del della des die donna eine el ella en est et femme fille frau haar hermosa hombre homme il jeune la las le les lo los lunghi madchen menina mujer mulher occhi ojos olhos para pelo por que ragazza ragazzo ritratto rouge schoen scuri uma un una und une yeux".split(" ")
        );
        const functionCount = words.filter(word => englishFunctionWords.has(word)).length;
        const visualCount = words.filter(word => englishVisualWords.has(word)).length;
        const englishCount = functionCount + visualCount;
        const foreignCount = words.filter(word => foreignSignals.has(word)).length;
        const requiredSignals = words.length <= 5 ? 1 : words.length <= 12 ? 2 : Math.max(3, Math.ceil(words.length * 0.06));
        const confidentlyEnglish = englishCount >= requiredSignals
            && (functionCount >= 1 || visualCount >= 2 || words.length <= 5);
        const confidentlyForeign = foreignCount >= 2 && foreignCount > englishCount;
        return {
            nonEnglish: confidentlyForeign,
            uncertain: !confidentlyEnglish && !confidentlyForeign,
            nonLatinLetterRatio
        };
    }

    function evaluateCandidate(candidate, limits) {
        let text = String(candidate.text);
        try {
            text = text.normalize("NFKC");
        }
        catch {
            return makeRejected(candidate.sourceKey, "unicode_normalization_failed", candidate.chunkType, candidate.compressed, candidate.encoding);
        }

        text = text
            .replace(/^\uFEFF+/, "")
            .replace(/\r\n?|\u2028|\u2029/g, "\n")
            .trim();

        const common = {
            sourceKey: candidate.sourceKey,
            chunkType: candidate.chunkType,
            compressed: candidate.compressed,
            encoding: candidate.encoding,
            htmlDecoded: false,
            wrapperStripped: false,
            negativePromptFound: false,
            normalizedChars: text.length,
            promptChars: null,
            nonLatinLetterRatio: null
        };

        if (text.length > limits.maxNormalizedChars) {
            return {...common, status: "encoded_or_unknown", reason: "normalized_text_too_large"};
        }
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
            return {...common, status: "encoded_or_unknown", reason: "binary_control_characters"};
        }
        if (!text) return {...common, status: "metadata_no_prompt", reason: "empty_metadata_value"};
        const structuredPrompt = extractPromptFromMetadataDocument(text, {
            allowBareComfyJson: candidate.sourceKey === "prompt",
            maxDocumentChars: limits.maxNormalizedChars
        });
        if (structuredPrompt.status === "found") {
            text = structuredPrompt.prompt;
            common.wrapperStripped = true;
            common.normalizedChars = text.length;
            common.structuredReason = structuredPrompt.reason;
        }
        else if (structuredPrompt.status !== "not_structured") {
            return {...common, status: "structured", reason: structuredPrompt.reason};
        }
        else {
            const decoded = decodeHtmlEntitiesOnce(text);
            common.htmlDecoded = decoded !== text;
            try { text = decoded.normalize("NFKC").trim(); }
            catch { return {...common, status: "encoded_or_unknown", reason: "unicode_normalization_failed"}; }
            common.normalizedChars = text.length;
        }
        if (text.length > limits.maxNormalizedChars) {
            return {...common, status: "encoded_or_unknown", reason: "normalized_text_too_large"};
        }
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
            return {...common, status: "encoded_or_unknown", reason: "binary_control_characters"};
        }
        if (!text) return {...common, status: "metadata_no_prompt", reason: "empty_metadata_value"};
        if (looksLikeJsonContainer(text)) return {...common, status: "structured", reason: "structured_json"};
        if (/^(?:---|\.\.\.|%YAML\b|%TAG\b|!!(?:map|seq|str)\b|!<[^>]+>)/i.test(text)) {
            return {...common, status: "structured", reason: "structured_yaml_or_document"};
        }

        const wrapper = common.wrapperStripped ? null : text.match(/^\s*(?:parameters|prompt)\s*:\s*/i);
        if (wrapper) {
            text = text.slice(wrapper[0].length).trim();
            common.wrapperStripped = true;
            common.normalizedChars = text.length;
        }

        if (!text) return {...common, status: "metadata_no_prompt", reason: "empty_metadata_value"};
        if (looksLikeJsonContainer(text)) return {...common, status: "structured", reason: "structured_json"};

        const negativeIndex = text.search(/negative[ \t]+prompt[ \t]*:/i);
        if (negativeIndex >= 0) {
            text = text.slice(0, negativeIndex).trim();
            common.negativePromptFound = true;
        }
        const settingsIndex = text.search(/\n\s*(?:Steps|Sampler|CFG scale|Seed|Size|Clip skip|Model(?: hash)?|Hashes|Version)\s*:/i);
        if (settingsIndex >= 0) text = text.slice(0, settingsIndex).trim();
        common.promptChars = text.length;

        if (!text) return {...common, status: "metadata_no_prompt", reason: "positive_prompt_empty"};
        if (looksLikeStructuredDocument(text)) {
            return {...common, status: "structured", reason: "structured_yaml_or_document"};
        }
        if (looksEncodedOrEncrypted(text)) {
            return {...common, status: "encoded_or_unknown", reason: "encoded_encrypted_or_high_entropy"};
        }

        const language = languageAssessment(text);
        common.nonLatinLetterRatio = language.nonLatinLetterRatio;
        if (language.nonEnglish) {
            return {...common, status: "non_english", reason: "positive_prompt_non_english"};
        }
        if (language.uncertain) {
            return {...common, status: "encoded_or_unknown", reason: "positive_prompt_language_uncertain"};
        }

        return {...common, status: "found", reason: common.structuredReason || "positive_prompt_extracted", prompt: text};
    }

    function candidateOrder(left, right) {
        const leftPriority = left.sourceKey === "parameters" ? 0 : 1;
        const rightPriority = right.sourceKey === "parameters" ? 0 : 1;
        return leftPriority - rightPriority || left.order - right.order;
    }

    function rejectedOrder(left, right) {
        return STATUS_PRIORITY.indexOf(left.status) - STATUS_PRIORITY.indexOf(right.status)
            || candidateOrder(left, right);
    }

    async function parsePngPromptMetadata(input, options) {
        const bytes = toBuffer(input);
        const diagnostics = createDiagnostics(bytes ? bytes.length : null);
        if (!bytes) return result("none", null, null, "invalid_input", diagnostics);

        const limits = resolveLimits(options);
        if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
            return result("none", null, null, "not_png", diagnostics);
        }
        diagnostics.isPng = true;
        if (bytes.length > limits.maxFileBytes) {
            diagnostics.limitHit = "file_bytes";
            return result("encoded_or_unknown", null, null, "input_too_large", diagnostics);
        }

        const candidates = [];
        const rejected = [];
        let order = 0;
        let offset = PNG_SIGNATURE.length;

        while (offset + 12 <= bytes.length) {
            if (diagnostics.chunksScanned >= limits.maxChunks) {
                diagnostics.limitHit = "chunk_count";
                break;
            }

            const length = bytes.readUInt32BE(offset);
            const dataStart = offset + 8;
            const dataEnd = dataStart + length;
            const nextOffset = dataEnd + 4;
            if (dataEnd < dataStart || nextOffset > bytes.length) {
                diagnostics.malformedChunks += 1;
                const damagedType = bytes.subarray(offset + 4, offset + 8).toString("ascii");
                if (damagedType === "tEXt" || damagedType === "zTXt" || damagedType === "iTXt") {
                    diagnostics.malformedTextChunks += 1;
                }
                break;
            }

            const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
            diagnostics.chunksScanned += 1;
            if (type === "IEND") {
                diagnostics.sawIend = true;
                break;
            }

            if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
                diagnostics.textChunksSeen += 1;
                const parsed = await parseTextChunk(type, bytes.subarray(dataStart, dataEnd), limits);
                if (parsed.recognized) {
                    diagnostics.recognizedEntries += 1;
                    if (parsed.malformed) diagnostics.malformedTextChunks += 1;
                    if (parsed.decompressionFailure) diagnostics.decompressionFailures += 1;
                    if (parsed.rejection && /too_large|oversized/.test(parsed.rejection.reason)) {
                        diagnostics.oversizedTextChunks += 1;
                    }

                    if (parsed.candidate) {
                        const wouldExceedTotal = diagnostics.decodedTextBytes + parsed.candidate.decodedBytes > limits.maxTotalTextBytes;
                        const wouldExceedCount = candidates.length >= limits.maxCandidates;
                        if (wouldExceedTotal || wouldExceedCount) {
                            diagnostics.limitHit = wouldExceedTotal ? "total_text_bytes" : "candidate_count";
                            rejected.push({
                                ...makeRejected(
                                    parsed.candidate.sourceKey,
                                    "metadata_collection_limit_exceeded",
                                    parsed.candidate.chunkType,
                                    parsed.candidate.compressed,
                                    parsed.candidate.encoding
                                ),
                                order: order++
                            });
                        }
                        else {
                            diagnostics.decodedTextBytes += parsed.candidate.decodedBytes;
                            candidates.push({...parsed.candidate, order: order++});
                        }
                    }
                    else if (parsed.rejection) rejected.push({...parsed.rejection, order: order++});
                }
            }

            offset = nextOffset;
        }

        if (!diagnostics.sawIend && !diagnostics.limitHit && !diagnostics.malformedChunks) {
            diagnostics.malformedChunks += 1;
        }

        if (!diagnostics.sawIend || diagnostics.limitHit || diagnostics.malformedChunks) {
            return result("encoded_or_unknown", null, null, "png_scan_incomplete", diagnostics);
        }

        if (!diagnostics.recognizedEntries) {
            return result("none", null, null, "no_supported_metadata", diagnostics);
        }

        for (const candidate of candidates.sort(candidateOrder)) {
            diagnostics.candidatesEvaluated += 1;
            const evaluated = evaluateCandidate(candidate, limits);
            if (evaluated.status === "found") {
                return result("found", evaluated.prompt, evaluated.sourceKey, evaluated.reason, diagnostics, evaluated);
            }
            rejected.push({...evaluated, order: candidate.order});
        }

        for (const rejectedCandidate of rejected) {
            if (diagnostics.rejectionCounts[rejectedCandidate.status] !== undefined) {
                diagnostics.rejectionCounts[rejectedCandidate.status] += 1;
            }
        }

        const selected = rejected.sort(rejectedOrder)[0];
        if (!selected) {
            return result("metadata_no_prompt", null, null, "recognized_metadata_without_text", diagnostics);
        }
        return result(selected.status, null, selected.sourceKey, selected.reason, diagnostics, selected);
    }

    return Object.freeze({DEFAULT_LIMITS, extractComfyPositivePrompt, extractPromptFromMetadataDocument, parsePngPromptMetadata});

})();

const PLUGIN_NAME = "Krea2DiscordCollector";
const PLUGIN_VERSION = "0.16.1";
const STYLE_ID = "krea2-discord-collector-style";
const BUTTON_CLASS = "krea2-discord-collector-button";
const VISION_BUTTON_CLASS = "krea2-discord-vision-button";
const HOST_CLASS = "krea2-discord-collector-host";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_METADATA_SIDECAR_BYTES = 5 * 1024 * 1024;
const MAX_SAVED_HASHES = 5000;
const MAX_DIAGNOSTIC_SUMMARIES = 250;
const MAX_DIAGNOSTIC_CHUNKS = 96;
const MAX_CACHED_ORIGINALS = 1;
const HISTORY_THUMBNAIL_DIRECTORY = ".krea2-history-thumbnails";
const HISTORY_THUMBNAIL_MAX_SIDE = 640;
const HISTORY_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_PROBES = 250;
const METADATA_PROBE_RETRY_MS = 60 * 1000;
const METADATA_PREFLIGHT_TIMEOUT_MS = 8 * 1000;
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
const VISION_PIPELINE_ID = "discord-faithful-v12-interaction-locked-v2";
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
const VISION_SIDECAR_SCHEMA_VERSION = 3;
const KREA2_GUIDANCE_SAMPLE_COUNT = 8;
const HISTORY_ROOT_ID = "krea2-discord-history-root";
const HISTORY_MODAL_ID = "krea2-discord-history-modal";
const SOURCE_PROMPT_MODAL_ID = "krea2-discord-source-prompt-modal";
const PROMPT_EDITOR_MODAL_ID = "krea2-discord-prompt-editor-modal";
const PROMPT_AUDIT_MODAL_ID = "krea2-discord-prompt-audit-modal";
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
const TRUSTED_CHECKOUT_HOSTS = new Set(["bitcoin.seedframe.xyz", "bitcoin.zoo-chat.org"]);
const PROJECT_LINKS = Object.freeze({
    github: "https://github.com/pixelgraple/KREA2-Vision-Suite",
    babegenerator: "https://babegenerator.ink/"
});
const VISION_EXECUTION_OPTIONS = Object.freeze([
    ["Local GPU — use an installed model on this computer", "local"],
    ["Online API — Gemma 4 26B-A4B on the private remote worker (Discord sign-in required)", "online"]
]);
const VISION_ANALYSIS_OPTIONS = Object.freeze([
    ["Fast — one direct image pass (recommended)", "fast"],
    ["V2 Direct Fidelity — closer pose, action, and framing", "v2"],
    ["Maximum detail — multi-pass audit", "maximum"]
]);
const LOCAL_VISION_MODEL_IDS = new Set(VISION_MODEL_OPTIONS.map(([, id]) => id));
const VISION_MODEL_IDS = new Set([...LOCAL_VISION_MODEL_IDS, ONLINE_VISION_MODEL_ID]);

const DEFAULT_SETTINGS = Object.freeze({
    visionEndpoint: "http://127.0.0.1:7870/api/discord-describe",
    visionToken: "",
    visionExecutionMode: "local",
    visionAnalysisProfile: "v2",
    visionAnalysisProfileVersion: 3,
    v2ThreePromptVariations: false,
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

function normalizeVisionAnalysisProfile(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "v2" || normalized === "maximum" ? normalized : "fast";
}

function normalizeVisionPromptCount(value, analysisProfile = "fast") {
    const profile = normalizeVisionAnalysisProfile(analysisProfile);
    if (profile !== "v2") return 3;
    return Number(value) === 3 ? 3 : 1;
}

function effectiveVisionPromptCount(settings = {}, analysisProfile = settings.visionAnalysisProfile) {
    const profile = normalizeVisionAnalysisProfile(analysisProfile);
    return normalizeVisionPromptCount(profile === "v2" && settings.v2ThreePromptVariations === true ? 3 : 1, profile);
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
        analysis_profile: normalizeVisionAnalysisProfile(raw.analysis_profile),
        prompt_count: normalizeVisionPromptCount(raw.prompt_count, raw.analysis_profile),
        prompt_preset: normalizePromptPreset(raw.prompt_preset),
        pipeline_id: pipelineId,
        guidance_sha256: guidanceSha256,
        dataset_guidance: normalizeDatasetGuidanceState(raw.dataset_guidance)
    });
}

function buildVisionCacheProfile({model, analysisProfile = "fast", promptCount, preset, pipelineId = VISION_PIPELINE_ID, guidance = "", datasetGuidance} = {}) {
    const normalizedGuidance = String(guidance || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 600);
    return normalizeVisionCacheProfile({
        requested_model: model,
        analysis_profile: normalizeVisionAnalysisProfile(analysisProfile),
        prompt_count: normalizeVisionPromptCount(promptCount, analysisProfile),
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

function visionRequestCacheKey(imageSha256, {model, analysisProfile = "fast", promptCount, preset, guidance = "", datasetGuidance = false, feedbackDigest = "", jobId = "", pipelineId = VISION_PIPELINE_ID, contributionEnabled = false, diagnosticsEnabled = false} = {}) {
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
        normalizeVisionAnalysisProfile(analysisProfile),
        String(normalizeVisionPromptCount(promptCount, analysisProfile)),
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

.${BUTTON_CLASS}[data-state="done"] {
    cursor: pointer;
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
#${HISTORY_MODAL_ID} textarea,
#${SOURCE_PROMPT_MODAL_ID} button,
#${SOURCE_PROMPT_MODAL_ID} textarea,
#${PROMPT_EDITOR_MODAL_ID} button,
#${PROMPT_AUDIT_MODAL_ID} button,
#${PROMPT_EDITOR_MODAL_ID} textarea,
#${PROMPT_AUDIT_MODAL_ID} textarea {
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

#${HISTORY_ROOT_ID}[data-overlay="true"] {
    z-index: 9990;
    inset: 0;
    width: 100vw;
    min-width: 0;
    max-width: none;
    height: 100vh;
    padding: clamp(10px, 1.8vw, 28px);
    overscroll-behavior: contain;
    background:
        radial-gradient(circle at 18% 0%, rgba(207, 109, 48, .10), transparent 31%),
        radial-gradient(circle at 86% 100%, rgba(88, 101, 242, .09), transparent 34%),
        #090a0c;
    border: 0;
    box-shadow: none;
}

#${HISTORY_ROOT_ID}[data-overlay="true"] > .krea2-history-resizer,
#${HISTORY_ROOT_ID}[data-overlay="true"] > .krea2-history-collapsed { display: none !important; }

#${HISTORY_ROOT_ID}[data-overlay="true"] > .krea2-history-workspace {
    display: grid !important;
    grid-template-columns: minmax(0, 2.2fr) minmax(260px, .8fr);
    grid-template-rows: auto auto auto auto auto auto auto minmax(0, 1fr) auto;
    grid-template-areas:
        "brand brand"
        "header header"
        "summary summary"
        "average scheduler"
        "tabs tabs"
        "tools tools"
        "completion completion"
        "content content"
        "pagination pagination";
    width: min(1480px, 100%);
    min-height: 0;
    margin: 0 auto;
    overflow: hidden;
    border: 1px solid #302d2a;
    border-radius: 18px;
    background: linear-gradient(145deg, #111214 0%, #0d0f12 100%);
    box-shadow: 0 28px 90px rgba(0, 0, 0, .62);
}

#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-brand-bar { grid-area: brand; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-header { grid-area: header; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-summary { grid-area: summary; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-average-queue { grid-area: average; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-scheduler { grid-area: scheduler; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-tabs { grid-area: tabs; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-library-tools { grid-area: tools; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-completion { grid-area: completion; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-interrogate-panel,
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-list { grid-area: content; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-pagination { grid-area: pagination; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-interrogate-panel[hidden],
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-list[hidden] { display: none !important; }

.krea2-history-resizer {
    position: absolute;
    z-index: 2;
    left: -3px;
    top: 0;
    bottom: 0;
    width: 7px;
    cursor: ew-resize;
}

.krea2-history-brand-bar {
    flex: none;
    display: flex;
    height: 34px;
    min-height: 34px;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 0 12px;
    border-bottom: 1px solid #202329;
    color: #f7f8fa;
    -webkit-text-fill-color: #f7f8fa;
    background: #070809;
    font: 700 12px/1 Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    letter-spacing: .01em;
}
.krea2-history-brand-mark {
    position: relative;
    width: 13px;
    height: 13px;
    flex: none;
    border-radius: 4px;
    background: conic-gradient(from 215deg, #2ac8c5, #6372ec, #e78142, #2ac8c5);
    box-shadow: 0 0 0 1px rgba(255,255,255,.12), 0 0 10px rgba(67,167,192,.16);
}
.krea2-history-brand-mark::after {
    content: "";
    position: absolute;
    inset: 3px;
    border-radius: 2px;
    background: #070809;
}
.krea2-history-brand-title { white-space: nowrap; }

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

.krea2-history-expand,
.krea2-history-hide-overlay {
    display: inline-flex;
    min-height: 30px;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 9px;
    border: 1px solid #3b424e;
    border-radius: 8px;
    color: var(--krea2-text);
    -webkit-text-fill-color: var(--krea2-text);
    background: #20242c;
    cursor: pointer;
    font: 700 9.5px/1 system-ui, sans-serif;
    white-space: nowrap;
}
.krea2-history-expand:hover { border-color: #6570dc; background: #292f46; }
.krea2-history-hide-overlay {
    display: none;
    min-height: 38px;
    padding: 0 15px;
    border-color: #e58a4b;
    color: #fff;
    -webkit-text-fill-color: #fff;
    background: linear-gradient(135deg, #c86428, #df7a38);
    box-shadow: 0 7px 22px rgba(202, 99, 39, .25);
    font-size: 11px;
}
.krea2-history-hide-overlay:hover { background: linear-gradient(135deg, #d56e2f, #ec8946); }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-expand,
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-rail-close { display: none !important; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-hide-overlay { display: inline-flex; }

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

#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-header {
    position: sticky;
    z-index: 3;
    top: 0;
    min-height: 78px;
    padding: 0 22px 0 26px;
    background: rgba(17, 18, 20, .96);
    backdrop-filter: blur(14px);
}
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-brand-bar {
    height: 36px;
    min-height: 36px;
    border-radius: 17px 17px 0 0;
    font-size: 12.5px;
}
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-title { font-size: clamp(20px, 2vw, 30px); font-weight: 760; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-subtitle { margin-top: 4px; font-size: 11px; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-actions { align-items: center; gap: 8px; }

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

#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-summary { gap: 12px; padding: 16px 22px 10px; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-stat { padding: 13px 10px; border-radius: 11px; text-align: left; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-stat strong { font-size: 21px; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-stat span { font-size: 9px; }

.krea2-history-scheduler { margin: 10px 12px; padding: 9px 10px; border: 1px solid var(--krea2-border); border-radius: 8px; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); background: var(--krea2-surface-raised); font-size: 9.5px; line-height: 1.45; }
.krea2-history-scheduler strong { color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); font-weight: 650; }

#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-average-queue { margin: 0 6px 10px 22px; padding: 10px 12px; border: 1px solid var(--krea2-border); border-radius: 9px; text-align: left; background: var(--krea2-surface-raised); }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-scheduler { margin: 0 22px 10px 6px; padding: 10px 12px; }

.krea2-history-tabs { display: flex; gap: 3px; margin: 0 12px 10px; padding: 3px; border: 1px solid var(--krea2-border); border-radius: 9px; background: #0d0f13; }
.krea2-history-tab { flex: 1; min-width: 0; padding: 7px 3px; border: 0; border-radius: 6px; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); background: transparent; cursor: pointer; font: 650 9.5px/1 system-ui, sans-serif; }
.krea2-history-tab:hover { color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); background: var(--krea2-surface-hover); }
.krea2-history-tab[aria-selected="true"] { color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); background: #2a303a; box-shadow: 0 1px 2px rgba(0,0,0,.3); }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-tabs { margin: 0 22px 12px; padding: 4px; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-tab { min-height: 38px; padding: 9px 10px; font-size: 10.5px; }

.krea2-history-list { flex: 1; min-height: 0; overflow: auto; padding: 0 10px 12px; scrollbar-width: thin; scrollbar-color: #3a414d transparent; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    align-content: start;
    gap: 12px;
    padding: 4px 22px 22px;
}
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-job { height: 100%; margin: 0; padding: 14px; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-job-layout { grid-template-columns: 58px minmax(0, 1fr); gap: 12px; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-job-thumb { width: 58px; height: 58px; }
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
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-interrogate-panel { padding: 8px 22px 22px; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-interrogate-card { width: min(920px, 100%); box-sizing: border-box; margin: 0 auto; padding: 22px; }
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

#${HISTORY_MODAL_ID},
#${SOURCE_PROMPT_MODAL_ID},
#${PROMPT_EDITOR_MODAL_ID} { --krea2-text: #f3f5f7; --krea2-muted: #a8b0bd; position: fixed; z-index: 10000; inset: 0; display: grid; place-items: center; padding: 24px; color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); background: rgba(5, 7, 10, .78); backdrop-filter: blur(4px); }
#${PROMPT_AUDIT_MODAL_ID} { --krea2-text: #f3f5f7; --krea2-muted: #a8b0bd; position: fixed; z-index: 10001; inset: 0; display: grid; place-items: center; padding: 24px; color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); background: rgba(5, 7, 10, .78); backdrop-filter: blur(4px); }
.krea2-history-dialog { width: min(760px, 92vw); max-height: min(760px, 88vh); display: flex; flex-direction: column; overflow: hidden; border: 1px solid #343a45; border-radius: 14px; color: var(--krea2-text); background: #17191f; box-shadow: 0 28px 90px rgba(0,0,0,.62); }
.krea2-history-dialog[data-source-prompt="true"] { width: min(900px, 94vw); }
.krea2-history-dialog[data-prompt-editor="true"] { width: min(920px, 94vw); max-height: min(860px, 92vh); }
.krea2-prompt-editor-body { display: grid; min-height: 0; gap: 12px; overflow: auto; }
.krea2-prompt-editor-explanation { padding: 11px 13px; border: 1px solid #313949; border-radius: 9px; color: #c8d1df; background: #171d28; font-size: 11px; line-height: 1.55; }
.krea2-prompt-editor-field { display: grid; gap: 6px; }
.krea2-prompt-editor-field > label { color: #a8b0bd; font-size: 9px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }
.krea2-prompt-editor-prompt,
.krea2-prompt-editor-instruction { box-sizing: border-box; width: 100%; resize: vertical; border: 1px solid #343b48; border-radius: 9px; color: #f3f5f7; -webkit-text-fill-color: #f3f5f7; background: #0f1217; font: 500 11px/1.55 system-ui,sans-serif; }
.krea2-prompt-editor-prompt { min-height: 150px; padding: 12px; }
.krea2-prompt-editor-instruction { min-height: 74px; padding: 10px 12px; }
.krea2-prompt-editor-transcript { display: grid; max-height: 250px; gap: 8px; overflow: auto; padding: 2px; }
.krea2-prompt-editor-turn { padding: 10px 12px; border: 1px solid #303744; border-radius: 10px; color: #dfe4ec; background: #1a1e25; font-size: 11px; line-height: 1.52; white-space: pre-wrap; }
.krea2-prompt-editor-turn[data-role="user"] { margin-left: 12%; border-color: #3e4978; background: #202641; }
.krea2-prompt-editor-turn[data-role="assistant"] { margin-right: 6%; border-color: #315c47; background: #14261d; }
.krea2-prompt-editor-turn-actions { display: flex; gap: 7px; margin-top: 8px; }
.krea2-prompt-editor-turn-actions button { min-height: 28px; padding: 5px 9px; border: 1px solid #3a4352; border-radius: 7px; color: #e9edf3; background: #20252d; cursor: pointer; font-size: 9px; font-weight: 700; }
.krea2-prompt-editor-compose { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; align-items: end; }
.krea2-prompt-editor-send { min-height: 74px; padding: 9px 15px; border: 1px solid #6977f4; border-radius: 9px; color: #fff; background: #5865f2; cursor: pointer; font-weight: 750; }
.krea2-prompt-editor-send:disabled { cursor: wait; opacity: .55; }
.krea2-prompt-editor-status { min-height: 18px; color: #a8b0bd; font-size: 10px; line-height: 1.45; }
.krea2-prompt-editor-status[data-state="error"] { color: #ffb4b8; }
.krea2-prompt-editor-status[data-state="success"] { color: #a9edc1; }
.krea2-history-brand-editor { margin-left: auto; min-height: 24px; padding: 3px 8px; border: 1px solid #394252; border-radius: 7px; color: #dfe6f0; background: #171b22; cursor: pointer; font: 700 9px/1 system-ui,sans-serif; }
.krea2-history-brand-editor:hover { border-color: #6977f4; background: #20263a; }
.krea2-source-prompt-body { display: grid; gap: 14px; }
.krea2-source-prompt-explanation { margin: 0; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); font-size: 11px; line-height: 1.55; }
#${SOURCE_PROMPT_MODAL_ID} .krea2-product-tabs { padding: 0; border: 1px solid #2c313a; border-radius: 9px 9px 0 0; }
#${SOURCE_PROMPT_MODAL_ID} .krea2-history-prompt { min-height: 260px; max-height: 55vh; }
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
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-library-tools { grid-template-columns: minmax(0, 1fr) minmax(180px, 260px); gap: 10px; margin: 0 22px 12px; }
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-search,
#${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-model-filter { min-height: 40px; font-size: 11px; }
.krea2-history-search,
.krea2-history-model-filter,
.krea2-workshop-select { box-sizing: border-box; min-width: 0; width: 100%; padding: 8px 9px; border: 1px solid var(--krea2-border, #343a45); border-radius: 8px; color: var(--krea2-text, #f3f5f7); -webkit-text-fill-color: var(--krea2-text, #f3f5f7); background: #0d0f13; font: 550 10px/1.2 system-ui, sans-serif; }
.krea2-history-utility-row { display: flex; gap: 6px; margin: 0 12px 10px; }
.krea2-history-utility { min-width: 0; flex: 1; padding: 7px 8px; border: 1px solid var(--krea2-border); border-radius: 8px; color: var(--krea2-muted); -webkit-text-fill-color: var(--krea2-muted); background: var(--krea2-surface-raised); cursor: pointer; font: 650 9.5px/1 system-ui, sans-serif; }
.krea2-history-utility:hover,
.krea2-history-utility[data-active="true"] { color: var(--krea2-text); -webkit-text-fill-color: var(--krea2-text); border-color: #4d5870; background: #252b36; }
.krea2-history-completion { display: block; margin: 0 12px 10px; padding: 9px 10px; border: 1px solid #434b5a; border-radius: 8px; color: #e7ebf2; -webkit-text-fill-color: #e7ebf2; background: #1c212a; cursor: pointer; font: 600 10px/1.35 system-ui, sans-serif; text-align: left; }
.krea2-history-completion[data-status="completed"] { border-color: #315c47; color: #b8f2cf; -webkit-text-fill-color: #b8f2cf; background: #14261d; }
.krea2-history-completion[data-status="error"],
.krea2-history-completion[data-status="rejected"] { border-color: #713e46; color: #ffb5bd; -webkit-text-fill-color: #ffb5bd; background: #321a1f; }
.krea2-history-completion[data-status="cancelled"] { border-color: #756134; color: #ffe0a0; -webkit-text-fill-color: #ffe0a0; background: #302713; }
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
.krea2-region-inpaint { display: grid; gap: 11px; margin-top: 12px; padding: 13px; border: 1px solid #364052; border-radius: 12px; background: #11151c; }
.krea2-region-inpaint[hidden] { display: none; }
.krea2-region-inpaint-title { margin: 0; color: #f3f5f7; font-size: 14px; }
.krea2-region-inpaint-instruction { box-sizing: border-box; width: 100%; min-height: 76px; resize: vertical; padding: 10px 12px; border: 1px solid #343b48; border-radius: 9px; color: #f3f5f7; -webkit-text-fill-color: #f3f5f7; background: #0d1015; font: 500 11px/1.5 system-ui,sans-serif; }
.krea2-region-inpaint-results { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.krea2-region-inpaint-results[hidden],
.krea2-region-inpaint-result[hidden],
.krea2-region-inpaint .krea2-workshop-toolbar[hidden] { display: none; }
.krea2-region-inpaint-result { min-width: 0; padding: 10px; border: 1px solid #303744; border-radius: 9px; background: #0d1015; }
.krea2-region-inpaint-result > strong { display: block; margin-bottom: 7px; color: #aeb7c6; font-size: 9px; letter-spacing: .05em; text-transform: uppercase; }
.krea2-region-inpaint-text { max-height: 260px; overflow: auto; color: #e7ebf1; font: 500 10px/1.52 ui-monospace,SFMono-Regular,Consolas,monospace; white-space: pre-wrap; }
.krea2-region-inpaint-status { min-height: 17px; color: #a8b0bd; font-size: 10px; line-height: 1.45; }
.krea2-region-inpaint-status[data-state="error"] { color: #ffb4b8; }
.krea2-region-inpaint-status[data-state="success"] { color: #a9edc1; }
.krea2-quality-panel { display: grid; gap: 10px; margin-top: 14px; padding: 13px; border: 1px solid #354153; border-radius: 11px; background: #111720; }
.krea2-quality-panel h3 { margin: 0; color: #f2f5f8; font-size: 13px; }
.krea2-quality-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px; }
.krea2-quality-fact { min-width: 0; padding: 8px 9px; border: 1px solid #2d3542; border-radius: 8px; background: #171c24; }
.krea2-quality-fact span { display: block; color: #8f99a9; font-size: 8px; font-weight: 750; letter-spacing: .055em; text-transform: uppercase; }
.krea2-quality-fact strong { display: block; margin-top: 4px; overflow-wrap: anywhere; color: #e8edf3; font-size: 10px; line-height: 1.4; }
.krea2-audit-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.krea2-audit-item { padding: 8px 10px; border: 1px solid #604b2c; border-radius: 8px; color: #f5d49b; background: #282015; font-size: 10px; line-height: 1.45; }
.krea2-audit-item[data-severity="error"] { border-color: #6e343b; color: #ffb8bd; background: #2b171b; }
.krea2-audit-clear { color: #a9edc1; font-size: 10px; }
.krea2-provenance { margin-top: 12px; border: 1px solid #303946; border-radius: 10px; background: #141920; }
.krea2-provenance summary { padding: 10px 12px; color: #d9e0e9; cursor: pointer; font-size: 10px; font-weight: 750; }
.krea2-provenance-body { display: grid; gap: 7px; padding: 0 12px 12px; color: #aab4c2; font-size: 9.5px; line-height: 1.45; }
.krea2-provenance-links { display: flex; flex-wrap: wrap; gap: 7px; }
.krea2-provenance-links button { min-height: 28px; padding: 5px 9px; border: 1px solid #3a4352; border-radius: 7px; color: #e9edf3; background: #20252d; cursor: pointer; font-size: 9px; font-weight: 700; }
.krea2-diagnostic-center { display: grid; gap: 11px; padding: 14px; border: 1px solid #65363d; border-radius: 11px; background: #27171b; }
.krea2-diagnostic-center[data-synthetic="true"] { border-color: #5b4a2d; background: #261f15; }
.krea2-diagnostic-title { color: #ffccd0; font-size: 14px; font-weight: 800; }
.krea2-diagnostic-center[data-synthetic="true"] .krea2-diagnostic-title { color: #f2d49b; }
.krea2-diagnostic-row { display: grid; grid-template-columns: 120px minmax(0,1fr); gap: 10px; color: #d7dce4; font-size: 10px; line-height: 1.45; }
.krea2-diagnostic-row span { color: #9ba5b4; font-weight: 700; }
.krea2-diagnostic-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.krea2-preflight { padding: 9px 11px; border: 1px solid #35513f; border-radius: 8px; color: #b9e8c9; background: #132219; font-size: 10px; line-height: 1.45; }
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
    #${HISTORY_ROOT_ID}:not([data-collapsed="true"]):not([data-overlay="true"]) { --krea2-history-width: 292px !important; min-width: 268px; }
}
@media (max-width: 920px) {
    #${HISTORY_ROOT_ID}:not([data-overlay="true"]) { width: 44px !important; min-width: 44px !important; max-width: 44px !important; }
    #${HISTORY_ROOT_ID}:not([data-overlay="true"]) .krea2-history-expanded { display: none !important; }
    #${HISTORY_ROOT_ID}:not([data-overlay="true"]) .krea2-history-collapsed { display: flex !important; }
    #${HISTORY_ROOT_ID}[data-overlay="true"] { width: 100vw !important; min-width: 0 !important; max-width: none !important; padding: 8px; }
    #${HISTORY_ROOT_ID}[data-overlay="true"] > .krea2-history-workspace { grid-template-columns: 1fr; grid-template-rows: auto auto auto auto auto auto auto auto minmax(0, 1fr) auto; grid-template-areas: "brand" "header" "summary" "average" "scheduler" "tabs" "tools" "completion" "content" "pagination"; }
    #${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-average-queue,
    #${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-scheduler { margin: 0 14px 8px; }
    .krea2-history-detail-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .krea2-history-result { grid-template-columns: 132px minmax(0, 1fr); }
    .krea2-onboarding-grid { grid-template-columns: 1fr; }
}
@media (max-width: 620px) {
    #${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 12px 14px 8px; }
    #${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-header { padding: 0 12px 0 15px; }
    #${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-hide-overlay { padding: 0 10px; }
    #${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-tabs { margin: 0 14px 10px; overflow-x: auto; }
    #${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-tab { flex: 0 0 auto; min-width: 92px; }
    #${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-list { grid-template-columns: 1fr; padding: 4px 14px 16px; }
    #${HISTORY_ROOT_ID}[data-overlay="true"] .krea2-history-library-tools { grid-template-columns: 1fr; margin: 0 14px 10px; }
    .krea2-onboarding-execution { grid-template-columns: 1fr; }
    .krea2-history-result { grid-template-columns: 1fr; }
    .krea2-history-source-frame { max-width: 220px; }
    .krea2-workshop-grid,
    .krea2-compare-grid,
    .krea2-meta-grid,
    .krea2-health-grid,
    .krea2-region-inpaint-results { grid-template-columns: 1fr; }
    .krea2-quality-grid { grid-template-columns: 1fr; }
    .krea2-diagnostic-row { grid-template-columns: 1fr; gap: 3px; }
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

function filterExternalUrl(raw, purpose) {
    let parsed;
    try {
        parsed = new URL(String(raw || "").trim());
    }
    catch {
        return {ok: false, error: "The external link is not a valid URL."};
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hash) {
        return {ok: false, error: "The external link must be a direct HTTPS URL without credentials, a port, or a fragment."};
    }
    if (purpose === "discord-oauth") {
        if (parsed.hostname !== "discord.com" || parsed.pathname !== "/oauth2/authorize") {
            return {ok: false, error: "The Discord sign-in link is not an approved Discord OAuth URL."};
        }
    }
    else if (purpose === "checkout") {
        if (!TRUSTED_CHECKOUT_HOSTS.has(parsed.hostname)) {
            return {ok: false, error: "The payment link is not from an approved Krea2 checkout host."};
        }
    }
    else if (purpose === "project") {
        const approved = new Set(Object.values(PROJECT_LINKS));
        if (!approved.has(parsed.toString())) {
            return {ok: false, error: "The project link is not on the KREA2 Vision allowlist."};
        }
    }
    else {
        return {ok: false, error: "The external-link purpose is not approved."};
    }
    return {ok: true, url: parsed.toString()};
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

function base64Url(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
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

function localPathApi(raw) {
    const value = String(raw || "").trim();
    if (value.startsWith("/") && path.posix.isAbsolute(value)) return path.posix;
    if (path.win32.isAbsolute(value)) return path.win32;
    if (path.posix.isAbsolute(value)) return path.posix;
    return null;
}

function validateSaveFolder(raw) {
    const value = String(raw || "").trim();
    const pathApi = localPathApi(value);
    if (!value || value.includes("\u0000") || !pathApi) {
        return {ok: false, error: "The local save folder must be an absolute Windows, Linux, or macOS path."};
    }
    const normalized = pathApi.normalize(value);
    const root = pathApi.parse(normalized).root;
    const rootOnly = pathApi === path.win32
        ? normalized.toLowerCase() === root.toLowerCase()
        : normalized === root;
    if (!root || rootOnly) {
        return {ok: false, error: "Choose a folder below the filesystem root."};
    }
    return {ok: true, path: normalized, pathStyle: pathApi === path.win32 ? "windows" : "posix"};
}

function localPathJoin(base, ...parts) {
    const pathApi = localPathApi(base);
    if (!pathApi) throw new Error("A platform-absolute local path is required.");
    return pathApi.join(base, ...parts);
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
    const canonicalPath = localPathJoin(validated.path, canonicalName);
    if (await writeExclusive(canonicalPath, bytes, fileSystem)) {
        return {filePath: canonicalPath, filename: canonicalName, deduplicated: false};
    }

    if (await hashFile(canonicalPath, fileSystem) === sha256) {
        return {filePath: canonicalPath, filename: canonicalName, deduplicated: true};
    }

    for (let counter = 1; counter <= 999; counter += 1) {
        const collisionName = `${sha256}-collision-${counter}${format.extension}`;
        const collisionPath = localPathJoin(validated.path, collisionName);
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
    return localPathJoin(validated.path, HISTORY_THUMBNAIL_DIRECTORY);
}

function historyThumbnailCacheCandidates(folder, hash) {
    const key = String(hash || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("A full image SHA-256 is required for the thumbnail cache.");
    const directory = historyThumbnailCacheDirectory(folder);
    return [".webp", ".png", ".jpg", ".jpeg"].map(extension => localPathJoin(directory, `${key}${extension}`));
}

function clearHistoryThumbnailCache(directory, fileSystem = fs) {
    let removed = 0;
    try {
        const entries = fileSystem.readdirSync(directory, {withFileTypes: true});
        for (const entry of entries) {
            if (!entry?.isFile?.() || !/^[a-f0-9]{64}\.(?:webp|png|jpe?g)$/i.test(entry.name)) continue;
            try {
                fileSystem.unlinkSync(localPathJoin(directory, entry.name));
                removed += 1;
            }
            catch {}
        }
    }
    catch {}
    return removed;
}

async function savePromptSidecar(imagePath, prompt, fileSystem = fs) {
    const pathApi = localPathApi(imagePath);
    if (!pathApi) throw new Error("A platform-absolute image path is required.");
    const parsed = pathApi.parse(imagePath);
    const sidecarPath = pathApi.join(parsed.dir, `${parsed.name}.txt`);
    const content = `${String(prompt).trim()}\r\n`;
    const bytes = Buffer.from(content, "utf8");
    if (await writeExclusive(sidecarPath, bytes, fileSystem)) return sidecarPath;
    const existing = await readFileCompat(fileSystem, sidecarPath, "utf8");
    if (existing === content) return sidecarPath;

    const promptHash = sha256Hex(Buffer.from(content)).slice(0, 12);
    const alternate = pathApi.join(parsed.dir, `${parsed.name}-prompt-${promptHash}.txt`);
    if (!(await writeExclusive(alternate, bytes, fileSystem))) {
        const alternateExisting = await readFileCompat(fileSystem, alternate, "utf8");
        if (alternateExisting !== content) throw new Error("A different prompt sidecar already uses the collision-safe name.");
    }
    return alternate;
}

function visionPromptSidecarPath(imagePath, canonicalHash = "", cacheProfile = null) {
    const pathApi = localPathApi(imagePath);
    if (!pathApi) throw new Error("A platform-absolute image path is required.");
    const parsed = pathApi.parse(imagePath);
    const baseName = /^[a-f0-9]{64}$/i.test(String(canonicalHash)) ? String(canonicalHash).toLowerCase() : parsed.name;
    const suffix = cacheProfile ? `.${visionCacheProfileDigest(cacheProfile)}` : "";
    return pathApi.join(parsed.dir, `${baseName}.vision${suffix}.txt`);
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
            const pathApi = localPathApi(sidecarPath);
            if (!pathApi) throw new Error("A platform-absolute prompt sidecar path is required.");
            const parsedSidecar = pathApi.parse(sidecarPath);
            const alternate = pathApi.join(parsedSidecar.dir, `${parsedSidecar.name}-${promptHash}.txt`);
            if (!(await writeExclusive(alternate, bytes, fileSystem))) {
                const alternateExisting = await readFileCompat(fileSystem, alternate, "utf8");
                if (alternateExisting !== content) throw new Error("A different Vision prompt sidecar already uses the collision-safe name.");
            }
            savedPath = alternate;
        }
    }
    if (Array.isArray(promptVariants) && (promptVariants.length === 1 || promptVariants.length === 3)) {
        const normalizedVariants = promptVariants.map(normalizeVisionPrompt);
        if (normalizedVariants[0] !== normalizeVisionPrompt(prompt) || new Set(normalizedVariants).size !== normalizedVariants.length) {
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
                (bundle.prompt_variants.length === 1 || bundle.prompt_variants.length === 3)
            ) {
                const normalized = bundle.prompt_variants.map(normalizeVisionPrompt);
                if (normalized[0] === prompt && new Set(normalized).size === normalized.length) promptVariants = normalized;
            }
        }
        catch (error) {
            if (!isFileSystemError(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
        }
        if (normalizedExpected && promptVariants.length !== normalizedExpected.prompt_count) return null;
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
    let text = String(raw || "")
        .normalize("NFKC")
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n")
        .trim();
    const structuredPrompt = extractMetadataDocumentPrompt?.(text, {
        allowBareComfyJson: false,
        maxDocumentChars: MAX_METADATA_SIDECAR_BYTES
    });
    if (structuredPrompt?.status === "found") text = structuredPrompt.prompt;
    else if (structuredPrompt && structuredPrompt.status !== "not_structured") {
        return {classification: "structured"};
    }
    else {
        text = decodeHtmlEntities(text)
            .normalize("NFKC")
            .replace(/\u0000/g, "")
            .trim();
    }
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

function selectMetadataPromptCandidates(embedded = {}, sidecar = null, companionStatus = "none") {
    const candidates = [];
    if (embedded?.classification === "usable" && embedded.prompt) {
        candidates.push({prompt: embedded.prompt, source: "embedded image metadata"});
    }
    if (sidecar?.classification === "usable" && sidecar.prompt) {
        candidates.push({prompt: sidecar.prompt, source: sidecar.source || "same-message YAML"});
    }

    const unique = new Map();
    for (const candidate of candidates) {
        const prompt = String(candidate.prompt || "").replace(/\s+/g, " ").trim();
        if (!prompt || unique.has(prompt)) continue;
        unique.set(prompt, Object.freeze({prompt: String(candidate.prompt).trim(), source: String(candidate.source)}));
    }
    if (unique.size) {
        return Object.freeze({
            status: "usable",
            classification: "usable",
            prompts: Object.freeze([...unique.values()])
        });
    }

    const classifications = [embedded?.classification, sidecar?.classification];
    if (companionStatus === "ambiguous") classifications.push("structured");
    const classification = ["non_english", "structured", "encoded_or_unknown", "metadata_no_prompt", "no_metadata"]
        .find(value => classifications.includes(value)) || "no_metadata";
    return Object.freeze({status: "none", classification, prompts: Object.freeze([])});
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

function buildVisionMultipartBody(bytes, {filename, mimeType, model, guidance, analysisProfile = "fast", promptCount, datasetGuidance = false, feedbackContext = "", jobId, contributionTerms = "", diagnosticTerms = "", diagnosticUsername = ""} = {}) {
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
    appendText('Content-Disposition: form-data; name="analysis_profile"\r\n\r\n');
    appendText(normalizeVisionAnalysisProfile(analysisProfile));
    appendText(`\r\n--${boundary}\r\n`);
    appendText('Content-Disposition: form-data; name="prompt_count"\r\n\r\n');
    appendText(String(normalizeVisionPromptCount(promptCount, analysisProfile)));
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

function visibleHistoryPromptVariants(job, settings = {}) {
    const storedVariants = Array.isArray(job?.prompt_variants) && job.prompt_variants.length
        ? job.prompt_variants
        : job?.prompt
            ? [job.prompt]
            : [];
    if (!storedVariants.length) return [];
    const variants = normalizeVisionPromptVariants(storedVariants, {
        requireThree: false,
        fallbackPrompt: job?.prompt || ""
    });
    const analysisProfile = String(job?.reproducibility?.analysis_profile || "").trim().toLowerCase();
    const isV2Result = analysisProfile === "v2" || /V2 Direct Fidelity/i.test(String(job?.model || ""));
    if (!isV2Result) return variants;
    return settings?.v2ThreePromptVariations === true && variants.length === 3
        ? variants
        : [variants[0]];
}

function parseVisionPromptResponse(rawText, {expectedPromptCount = null, expectedDatasetGuidance = null, expectedFeedbackDigest = null} = {}) {
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
    const expectedCount = expectedPromptCount === null ? null : Number(expectedPromptCount);
    if (expectedCount !== null && expectedCount !== 1 && expectedCount !== 3) {
        throw new Error("Vision Prompt Studio expected an invalid prompt count.");
    }
    const promptVariants = normalizeVisionPromptVariants(state.prompt_variants, {requireThree: expectedCount === null || expectedCount === 3});
    if (expectedCount !== null && promptVariants.length !== expectedCount) {
        throw new Error(`Vision Prompt Studio returned ${promptVariants.length} prompts when ${expectedCount} were requested.`);
    }
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
    const poseCheck = state.pose_check === null || state.pose_check === undefined
        ? null
        : normalizePoseCheck(state.pose_check);
    const result = {
        prompt,
        prompt_variants: promptVariants,
        model,
        prompt_words: state.prompt_words,
        pipeline_id: pipelineId,
        dataset_guidance: datasetGuidance
    };
    if (poseCheck) result.pose_check = poseCheck;
    return result;
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

function normalizePoseCheck(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Vision pose receipt is invalid.");
    const text = (value, maximum = 120) => String(value ?? "").normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
    const posture = text(raw.primary_posture, 32).toLowerCase().replace(/\s+/g, "_");
    const postureValues = new Set(["standing", "sitting", "kneeling", "crouching", "squatting", "on_all_fours", "reclining", "lying", "visually_uncertain"]);
    if (!postureValues.has(posture)) throw new Error("Vision pose receipt has an invalid posture.");
    const pelvisSupport = text(raw.pelvis_support, 32).toLowerCase().replace(/\s+/g, "_");
    if (!["supported", "not_supported", "not_visible"].includes(pelvisSupport)) throw new Error("Vision pose receipt has invalid pelvic support.");
    const optionalBoolean = value => value === true ? true : value === false ? false : null;
    return Object.freeze({
        subject_count: Math.max(0, Math.min(12, Math.trunc(Number(raw.subject_count) || 0))),
        primary_posture: posture,
        pelvis_support: pelvisSupport,
        pelvis_support_surface: text(raw.pelvis_support_surface),
        left_foot_weight_bearing: optionalBoolean(raw.left_foot_weight_bearing),
        left_foot_surface: text(raw.left_foot_surface),
        right_foot_weight_bearing: optionalBoolean(raw.right_foot_weight_bearing),
        right_foot_surface: text(raw.right_foot_surface),
        knee_flexion: text(raw.knee_flexion, 24).toLowerCase().replace(/\s+/g, "_"),
        hip_height_relative_to_knees: text(raw.hip_height_relative_to_knees, 24).toLowerCase().replace(/\s+/g, "_"),
        other_weight_bearing_support: text(raw.other_weight_bearing_support),
        camera_view: text(raw.camera_view)
    });
}

function auditPromptContradictions(prompt, poseCheck = null) {
    const text = String(prompt || "").normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!text) return [];
    const lower = text.toLowerCase();
    const issues = [];
    const add = (code, message, severity = "warning") => {
        if (!issues.some(item => item.code === code)) issues.push(Object.freeze({code, message, severity}));
    };
    const has = pattern => pattern.test(lower);
    const receipt = poseCheck ? normalizePoseCheck(poseCheck) : null;

    if (receipt?.subject_count === 1 && has(/\b(?:standing|stands)\b/) && has(/\b(?:sitting|seated|sits)\b/)) {
        add("standing-and-sitting", "One subject is described as both standing and sitting.", "error");
    }
    if (receipt?.primary_posture === "standing" && has(/\b(?:sitting|seated|sits)\b/)) {
        add("pose-vs-receipt", "Prompt says sitting, but the image pose receipt says standing.", "error");
    }
    if (receipt?.primary_posture === "sitting" && has(/\b(?:standing|stands)\b/)) {
        add("pose-vs-receipt", "Prompt says standing, but the image pose receipt says sitting.", "error");
    }
    if (receipt?.primary_posture === "sitting" && receipt.pelvis_support !== "supported") {
        add("unsupported-sitting", "Sitting is claimed without visible pelvic support.", "error");
    }
    if (receipt?.primary_posture === "standing" && receipt.pelvis_support === "supported") {
        add("supported-standing", "Standing conflicts with the receipt's supported pelvis.", "error");
    }
    if (has(/\b(?:facing away|back (?:toward|to) (?:the )?camera)\b/) && has(/\b(?:looking directly at|direct eye contact with|gazing directly at) (?:the )?camera\b/)) {
        add("view-gaze-conflict", "The body faces away while the prompt also claims direct camera gaze; verify the head turn.");
    }
    if (has(/\b(?:high-angle|high angle|overhead|bird'?s-eye)\b/) && has(/\b(?:low-angle|low angle|worm'?s-eye)\b/)) {
        add("camera-angle-conflict", "Both high-angle and low-angle camera positions are specified.", "error");
    }
    if (has(/\b(?:midday|bright daylight|daytime|sunlit day)\b/) && has(/\b(?:midnight|nighttime|moonlit night|after dark)\b/)) {
        add("time-light-conflict", "Daylight and nighttime lighting are both specified.");
    }
    if (has(/\b(?:fully clothed|completely clothed)\b/) && has(/\b(?:fully nude|completely nude|naked)\b/)) {
        add("clothing-state-conflict", "The same prompt specifies both fully clothed and fully nude.", "error");
    }
    if (has(/\b(?:three arms|four arms|three legs|four legs|extra arm|extra leg|extra limb)\b/)) {
        add("extra-limb-language", "The prompt contains extra-limb language; verify that it is intentional.");
    }
    if (receipt?.subject_count > 0) {
        const subjectMatches = lower.match(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:adult )?(?:people|persons|subjects|women|men)\b/g) || [];
        for (const match of subjectMatches) {
            const token = match.split(/\s+/)[0];
            const numbers = {one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10};
            const count = Number(token) || numbers[token];
            if (count && count !== receipt.subject_count) add("subject-count-conflict", `Prompt subject count (${count}) conflicts with the image receipt (${receipt.subject_count}).`, "error");
        }
    }
    return issues;
}

function diagnosticForHistoryJob(job) {
    const id = /^[a-f0-9]{16,64}$/i.test(String(job?.id || "")) ? String(job.id).toLowerCase() : "unavailable";
    const message = String(job?.public_error || job?.stage || "No public error was recorded.").replace(/\s+/g, " ").trim().slice(0, 1000);
    const stage = String(job?.stage || "Unknown stage").replace(/\s+/g, " ").trim().slice(0, 300);
    const requestedModel = String(job?.requested_model || job?.model || "Unknown model").replace(/\s+/g, " ").trim().slice(0, 200);
    const combined = `${stage} ${message}`.toLowerCase();
    let code = "vision_job_failed";
    let recommendation = "Retry once. If it fails again, download this redacted report and send the support ID.";
    if (/ready|warming|cold|capacity|gpu/.test(combined)) {
        code = "remote_gpu_capacity";
        recommendation = "The remote worker was unavailable or warming. Wait for Ready/Cold standby, then retry; no successful image charge should remain.";
    }
    else if (/unusable|validation|schema|prompt/.test(combined)) {
        code = "output_validation_failed";
        recommendation = "Retry once with V2. If repeated, keep the support ID so the model output validator can be reviewed.";
    }
    else if (/cancel/.test(combined)) {
        code = "cancelled";
        recommendation = "No action is needed. Start a new request when ready.";
    }
    else if (/request id|different image|idempot/.test(combined)) {
        code = "request_identity_conflict";
        recommendation = "Retry the image; the plugin will issue a fresh request ID. Repeated failures should be reported with this support ID.";
    }
    const synthetic = /synthetic|smoke[_ -]?test|route proof|plugin_transport_smoke_test/.test(combined);
    const remote = requestedModel.startsWith("vast::") || /remote|online api/.test(combined);
    return Object.freeze({
        support_id: id,
        error_code: synthetic ? "synthetic_test" : code,
        stage,
        message,
        model: requestedModel,
        worker_state: /warming|cold|ready|capacity|gpu/.test(combined) ? "See failure stage; live state may have changed" : "Not implicated by this error",
        credit_outcome: remote ? "Protected: failed/cancelled remote requests are refunded automatically; successful requests alone are charged" : "Local GPU request: no Online API image credits",
        recommendation,
        synthetic
    });
}

function buildRedactedDiagnosticReport(job) {
    const diagnostic = diagnosticForHistoryJob(job);
    return [
        "KREA2 Vision local diagnostic report",
        "====================================",
        `Generated UTC: ${new Date().toISOString()}`,
        `Support ID: ${diagnostic.support_id}`,
        `Error code: ${diagnostic.error_code}`,
        `Stage: ${diagnostic.stage}`,
        `Model: ${diagnostic.model}`,
        `Worker state: ${diagnostic.worker_state}`,
        `Credit outcome: ${diagnostic.credit_outcome}`,
        `Message: ${diagnostic.message}`,
        `Recommendation: ${diagnostic.recommendation}`,
        `Synthetic test: ${diagnostic.synthetic ? "yes" : "no"}`,
        "",
        "Redaction: image bytes, prompts, Discord identity, credentials, URLs, filenames, image hashes, and local paths are excluded."
    ].join("\r\n");
}

function remotePreflightSummary(status, purpose = "image") {
    const state = String(status?.worker_state || "checking").replace(/[^a-z0-9 -]/gi, " ").trim() || "checking";
    const minimum = Math.max(0, Math.trunc(Number(status?.estimated_wait_seconds_min) || 0));
    const maximum = Math.max(minimum, Math.trunc(Number(status?.estimated_wait_seconds_max) || minimum));
    const imageCost = Math.max(0, Math.trunc(Number(status?.credits_per_image) || 3));
    const editCost = Math.max(0, Math.trunc(Number(status?.credits_per_prompt_chat) || 1));
    const cost = purpose === "region-inpaint" ? imageCost + editCost : purpose === "prompt-chat" ? editCost : imageCost;
    const wait = maximum ? `${minimum}–${maximum}s estimate` : "wait estimate unavailable";
    const refund = status?.failed_or_cancelled_refunded === false
        ? "Review credit terms before submitting."
        : "Failed or cancelled work is refunded; only successful work is charged.";
    return Object.freeze({
        worker_state: state,
        wait_min_seconds: minimum,
        wait_max_seconds: maximum,
        cost,
        available_credits: Math.max(0, Math.trunc(Number(status?.available_credits) || 0)),
        text: `Remote worker: ${state} · ${wait} · ${cost} credit${cost === 1 ? "" : "s"} on success · ${Math.max(0, Math.trunc(Number(status?.available_credits) || 0))} available. ${refund}`
    });
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
    for (const key of ["schema_version", "pipeline_id", "analysis_profile", "prompt_variant_count", "provider", "model_id", "model_label", "quantization", "model_sha256", "model_bytes", "mmproj_sha256", "mmproj_bytes", "artifact_revision", "runtime_bundle_id", "runtime_release", "context_cap", "max_output_cap", "estimated_vram_mb", "measured_peak_vram_mb", "safety_reserve_mb", "full_image_passes", "detail_crops", "image_audit"]) {
        const value = raw[key];
        if (typeof value === "string") clean[key] = value.slice(0, 200);
        else if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
        else if (typeof value === "boolean") clean[key] = value;
    }
    if (raw.dataset_guidance && typeof raw.dataset_guidance === "object" && !Array.isArray(raw.dataset_guidance)) {
        try { clean.dataset_guidance = normalizeDatasetGuidanceState(raw.dataset_guidance); }
        catch { /* Older history rows may predate dataset-guidance receipts. */ }
    }
    if (raw.pose_check && typeof raw.pose_check === "object" && !Array.isArray(raw.pose_check)) {
        try { clean.pose_check = normalizePoseCheck(raw.pose_check); }
        catch { /* Older rows may not have a valid V2 support ledger. */ }
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

function attachmentRecords(raw) {
    if (Array.isArray(raw)) return raw;
    if (typeof raw?.toArray === "function") {
        try { return raw.toArray(); }
        catch { return []; }
    }
    if (raw && typeof raw.values === "function") {
        try { return [...raw.values()]; }
        catch { return []; }
    }
    if (raw && typeof raw === "object") return Object.values(raw);
    return [];
}

function normalizedAttachmentRecord(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id || "").trim();
    const filename = String(raw.filename || raw.name || "")
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .trim()
        .slice(0, 260);
    const url = String(raw.url || raw.proxy_url || raw.proxyUrl || "").trim();
    const size = Math.max(0, Math.trunc(Number(raw.size) || 0));
    const contentType = String(raw.content_type || raw.contentType || "").toLowerCase();
    if (!/^\d{5,25}$/.test(id) || !filename || !url) return null;
    return {
        id,
        filename,
        url,
        size,
        contentType,
        width: Math.max(0, Math.trunc(Number(raw.width) || 0)),
        height: Math.max(0, Math.trunc(Number(raw.height) || 0))
    };
}

function attachmentStem(filename) {
    return path.parse(String(filename || "")).name.normalize("NFKC").trim().toLowerCase();
}

function isImageAttachmentRecord(record) {
    return Boolean(record) && (
        record.width > 0 && record.height > 0
        || /^image\//i.test(record.contentType)
        || /\.(?:png|jpe?g|webp|gif|avif)$/i.test(record.filename)
    );
}

function isYamlAttachmentRecord(record) {
    return Boolean(record)
        && /\.ya?ml$/i.test(record.filename)
        && (!record.size || record.size <= MAX_METADATA_SIDECAR_BYTES);
}

function selectCompanionMetadataAttachment(imageProvenance, rawAttachments) {
    const imageId = String(imageProvenance?.attachmentId || "");
    if (!/^\d{5,25}$/.test(imageId)) return {status: "none", reason: "image_attachment_unverified"};
    const records = attachmentRecords(rawAttachments).map(normalizedAttachmentRecord).filter(Boolean);
    const selectedImage = records.find(record => record.id === imageId && isImageAttachmentRecord(record));
    if (!selectedImage) return {status: "none", reason: "image_attachment_not_in_message"};
    const images = records.filter(isImageAttachmentRecord);
    const yaml = records.filter(isYamlAttachmentRecord);
    if (!yaml.length) return {status: "none", reason: "yaml_attachment_not_found"};

    const selectedStem = attachmentStem(selectedImage.filename);
    const sameStemImages = images.filter(record => attachmentStem(record.filename) === selectedStem);
    const sameStem = yaml.filter(record => attachmentStem(record.filename) === selectedStem);
    if (sameStem.length === 1 && sameStemImages.length === 1) {
        return {status: "found", attachment: sameStem[0], reason: "matching_filename_stem"};
    }
    if (sameStem.length === 1 && sameStemImages.length > 1) {
        return {status: "ambiguous", reason: "multiple_images_share_yaml_filename_stem"};
    }
    if (sameStem.length > 1) return {status: "ambiguous", reason: "multiple_matching_yaml_attachments"};
    if (images.length === 1 && yaml.length === 1) {
        return {status: "found", attachment: yaml[0], reason: "single_image_single_yaml"};
    }
    return {status: "ambiguous", reason: "yaml_image_pairing_ambiguous"};
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
        this.historyOverlayOpen = false;
        this.historyOverlayReturnFocus = null;
        this.historyOverlayDocument = null;
        this.historyOverlayKeyHandler = event => this.handleHistoryOverlayKeydown(event);
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
        this.sourcePromptModalCleanup = null;
        this.promptEditorCleanup = null;
        this.promptAuditCleanup = null;
        this.promptEditorDraft = null;
        this.feedbackModalCleanup = null;
        this.lastPathname = "";
        this.running = false;
        this.generation = 0;
        this.channelStore = null;
        this.messageStore = null;
        this.userStore = null;
    }

    start() {
        this.api = new BdApi(PLUGIN_NAME);
        const storedSettings = this.api.Data.load("settings") || {};
        this.settings = {...DEFAULT_SETTINGS, ...storedSettings};
        const migrateV2Profile = Math.trunc(Number(storedSettings.visionAnalysisProfileVersion) || 0) < 3;
        // Releases before 0.13.4 exposed an obsolete direct-upload endpoint and
        // token. Contributions now pass only through the authenticated loopback
        // Vision broker, so never retain or reuse those legacy values.
        delete this.settings.endpoint;
        delete this.settings.token;
        this.settings.visionExecutionMode = normalizeVisionExecutionMode(this.settings.visionExecutionMode);
        this.settings.visionAnalysisProfile = normalizeVisionAnalysisProfile(this.settings.visionAnalysisProfile);
        if (migrateV2Profile) this.settings.visionAnalysisProfile = "v2";
        this.settings.visionAnalysisProfileVersion = 3;
        // The magnifier is prompt-only. Metadata collection remains on the
        // separate + action; a stale legacy opt-in must never make Vision
        // prompts or source images into dataset contributions.
        this.settings.shareDatasetContributions = false;
        this.settings.shareFailureDiagnostics = this.settings.shareFailureDiagnostics === true;
        this.settings.historyCollapsed = this.settings.historyCollapsed === true;
        this.settings.useKrea2DatasetGuidance = this.settings.useKrea2DatasetGuidance === true;
        this.settings.historyWidth = Math.min(440, Math.max(268, Math.trunc(Number(this.settings.historyWidth) || 330)));
        if (
            Object.prototype.hasOwnProperty.call(storedSettings, "endpoint")
            || Object.prototype.hasOwnProperty.call(storedSettings, "token")
            || storedSettings.shareDatasetContributions === true
            || migrateV2Profile
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
        this.messageStore = this.api.Webpack.getStore("MessageStore") || null;
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
            if (this.historyRoot?.isConnected && (this.historyOverlayOpen || this.settings.historyCollapsed !== true)) void this.refreshHistory();
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
        this.sourcePromptModalCleanup?.();
        this.sourcePromptModalCleanup = null;
        this.promptEditorCleanup?.();
        this.promptEditorCleanup = null;
        this.promptAuditCleanup?.();
        this.promptAuditCleanup = null;
        this.promptEditorDraft = null;
        this.feedbackModalCleanup?.();
        this.feedbackModalCleanup = null;
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
        this.setHistoryOverlay(false, {restoreFocus: false});
        this.historyRoot?.remove();
        this.historyRoot = null;
        this.historyOverlayReturnFocus = null;
        document.getElementById(HISTORY_ROOT_ID)?.remove();
        document.getElementById(HISTORY_MODAL_ID)?.remove();
        document.getElementById(SOURCE_PROMPT_MODAL_ID)?.remove();
        document.getElementById(PROMPT_EDITOR_MODAL_ID)?.remove();
        document.getElementById(PROMPT_AUDIT_MODAL_ID)?.remove();
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
                        {label: "Get prompt (metadata first)", action: () => visionButton && this.queueVisionAnalysis(image, visionButton)},
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
        const noteText = document.createTextNode("These model variants are designed not to refuse an image-description or prompt request. KREA2 Vision still applies its own local input validation, output-format and quality checks, shared-GPU admission checks, and security limits. If the backend is unavailable, use the Repair KREA2 Vision Suite shortcut created on your desktop. Optional buttons below open the exact revision-pinned body and matching projector downloads; both files are required. Technical failures automatically post one downloadable, redacted .txt traceback to the owner-only Discord error webhook and retain privacy-minimal fields in Seedframe. The report never contains image bytes or hashes, prompts, Discord identity or IDs, credentials, URLs, image filenames, or local user paths. Optional rich failure diagnostics remain a separate opt-in setting.");
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
        root.dataset.overlay = this.historyOverlayOpen ? "true" : "false";
        root.dataset.floating = "true";
        root.style.setProperty("--krea2-history-width", `${this.settings.historyWidth}px`);
        root.setAttribute("aria-label", "KREA2 prompt history");

        const collapsed = document.createElement("button");
        collapsed.type = "button";
        collapsed.className = "krea2-history-collapse-launcher krea2-history-collapsed";
        collapsed.title = "Open KREA2 prompt history or the full Vision Inbox";
        collapsed.setAttribute("aria-label", collapsed.title);
        collapsed.append(document.createTextNode("◀"), document.createTextNode("PROMPT HISTORY"));
        collapsed.addEventListener("click", () => {
            const view = root.ownerDocument?.defaultView || window;
            if (view.matchMedia?.("(max-width: 920px)")?.matches) this.setHistoryOverlay(true);
            else this.setHistoryCollapsed(false);
        });

        const expanded = document.createElement("div");
        expanded.className = "krea2-history-expanded krea2-history-workspace";
        expanded.style.cssText = "display:flex;min-height:0;flex:1;flex-direction:column";

        const brandBar = document.createElement("div");
        brandBar.className = "krea2-history-brand-bar";
        brandBar.setAttribute("aria-label", "Krea2 Vision");
        const brandMark = document.createElement("span");
        brandMark.className = "krea2-history-brand-mark";
        brandMark.setAttribute("aria-hidden", "true");
        const brandTitle = document.createElement("span");
        brandTitle.className = "krea2-history-brand-title";
        brandTitle.textContent = "Krea2 Vision";
        const brandPromptEditor = document.createElement("button");
        brandPromptEditor.type = "button";
        brandPromptEditor.className = "krea2-history-brand-editor";
        brandPromptEditor.textContent = "✦ Qwen Prompt Editor";
        brandPromptEditor.title = "Paste or open a KREA2 prompt and ask Qwen 3.8 Cloud to revise it";
        brandPromptEditor.setAttribute("aria-label", "Open Qwen Prompt Editor");
        brandPromptEditor.addEventListener("click", () => this.openPromptEditor("", root.ownerDocument || document));
        brandBar.append(brandMark, brandTitle, brandPromptEditor);

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
        const expandOverlay = document.createElement("button");
        expandOverlay.type = "button";
        expandOverlay.className = "krea2-history-expand";
        expandOverlay.dataset.action = "expand-overlay";
        expandOverlay.textContent = "⛶ Expand";
        expandOverlay.title = "Expand Discord Vision Inbox over Discord";
        expandOverlay.setAttribute("aria-label", "Expand Discord Vision Inbox");
        expandOverlay.setAttribute("aria-controls", HISTORY_ROOT_ID);
        expandOverlay.setAttribute("aria-expanded", "false");
        expandOverlay.addEventListener("click", () => this.setHistoryOverlay(true));
        const refresh = document.createElement("button");
        refresh.type = "button";
        refresh.className = "krea2-history-icon";
        refresh.textContent = "↻";
        refresh.title = "Refresh prompt history";
        refresh.setAttribute("aria-label", refresh.title);
        refresh.addEventListener("click", () => void this.refreshHistory(true));
        const close = document.createElement("button");
        close.type = "button";
        close.className = "krea2-history-icon krea2-history-rail-close";
        close.textContent = "×";
        close.title = "Collapse Prompt History";
        close.setAttribute("aria-label", close.title);
        close.addEventListener("click", () => {
            this.setHistoryCollapsed(true);
        });
        const hideOverlay = document.createElement("button");
        hideOverlay.type = "button";
        hideOverlay.className = "krea2-history-hide-overlay";
        hideOverlay.dataset.action = "hide-overlay";
        hideOverlay.textContent = "↘ Hide overlay";
        hideOverlay.title = "Hide Discord Vision Inbox and return to Discord";
        hideOverlay.setAttribute("aria-label", "Hide Discord Vision Inbox overlay");
        hideOverlay.setAttribute("aria-controls", HISTORY_ROOT_ID);
        hideOverlay.hidden = true;
        hideOverlay.addEventListener("click", () => this.setHistoryOverlay(false));
        actions.append(expandOverlay, refresh, hideOverlay, close);
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
        for (const [label, filter] of [["Interrogate", "interrogate"], ["Recent", "recent"], ["Done", "completed"], ["Queue", "queued"], ["Diagnostics", "errors"]]) {
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
        expanded.append(brandBar, header, summary, averageQueue, scheduler, tabs, libraryTools, completion, interrogate, list, pagination);

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
        title.dataset.role = "interrogate-title";
        title.textContent = "Interrogate an image";
        const copy = document.createElement("div");
        copy.className = "krea2-interrogate-copy";
        copy.dataset.role = "interrogate-copy";
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

        const profileField = document.createElement("div");
        profileField.className = "krea2-interrogate-field";
        const profileLabel = document.createElement("label");
        profileLabel.textContent = "Prompt system";
        const profile = document.createElement("select");
        profile.className = "krea2-interrogate-model";
        profile.dataset.role = "interrogate-profile";
        profile.setAttribute("aria-label", "Select the prompt system for this image");
        for (const [label, value] of VISION_ANALYSIS_OPTIONS) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            profile.append(option);
        }
        profile.value = normalizeVisionAnalysisProfile(this.settings.visionAnalysisProfile);
        profileField.append(profileLabel, profile);

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
        profile.addEventListener("change", () => {
            this.settings.visionAnalysisProfile = normalizeVisionAnalysisProfile(profile.value);
            this.api.Data.save("settings", this.settings);
            this.renderInterrogatePanel();
        });
        note.addEventListener("input", () => {
            this.interrogateIdentityNote = note.value.slice(0, 400);
        });
        refresh.addEventListener("click", () => void this.refreshInterrogateModels(true));
        start.addEventListener("click", () => void this.queueInterrogateSelection());

        card.append(title, copy, input, drop, fileRow, field, profileField, noteField, actions, status, queue);
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
        const profile = panel.querySelector('[data-role="interrogate-profile"]');
        const title = panel.querySelector('[data-role="interrogate-title"]');
        const copy = panel.querySelector('[data-role="interrogate-copy"]');
        const note = panel.querySelector('[data-role="interrogate-identity-note"]');
        const start = panel.querySelector('[data-role="interrogate-start"]');
        const refresh = panel.querySelector('[data-role="interrogate-refresh"]');
        const status = panel.querySelector('[data-role="interrogate-status"]');
        const queue = panel.querySelector('[data-role="interrogate-queue"]');
        if (!preview || !dropCopy || !fileRow || !fileName || !model || !profile || !note || !start || !refresh || !status || !queue) return;

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
        if (title) title.textContent = "Interrogate an image";
        if (copy) copy.textContent = "Upload one image, choose the exact Vision model, and add it to the same authenticated shared queue used by Discord image magnifiers. Files remain in session memory.";
        profile.value = normalizeVisionAnalysisProfile(this.settings.visionAnalysisProfile);
        profile.disabled = this.interrogatePreparing;
        start.textContent = "Start interrogation";
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
        const analysisProfile = normalizeVisionAnalysisProfile(this.settings.visionAnalysisProfile);
        const promptCount = effectiveVisionPromptCount(this.settings, analysisProfile);
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
                    analysisProfile,
                    promptCount,
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
                            analysisProfile,
                            promptCount,
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
                await this.finishVisionPrompt({button: null, model: result.model, promptCount: result.prompt_variants.length});
                await this.refreshHistory(true);
                // Completion is background activity. Keep the result available in
                // Prompt History and the clickable completion banner, but never
                // mount a new result dialog over an editor the user is typing in.
            }
            catch (error) {
                if (!this.running || queuedGeneration !== this.generation || error?.name === "AbortError") return;
                const message = error instanceof Error ? error.message : String(error);
                this.updateLocalVisionSubmission(localSubmissionId, {status: "error", stage: message, public_error: message});
                this.interrogateStatus = message;
                this.interrogateStatusState = "error";
                this.toast(message, "error");
                this.log("error", message);
                this.queueOperationalError({eventId: localSubmissionId, modelId: selectedModel, errorCode: "interrogate_failed", errorMessage: message, stage: "Interrogate image request", technicalTrace: error instanceof Error ? error.stack || message : message});
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

    setHistoryOverlay(open, {restoreFocus = true} = {}) {
        const root = this.historyRoot;
        if (!root) {
            this.historyOverlayDocument?.removeEventListener?.("keydown", this.historyOverlayKeyHandler, true);
            this.historyOverlayDocument = null;
            this.historyOverlayOpen = false;
            this.historyOverlayReturnFocus = null;
            return false;
        }
        const next = open === true;
        if (next === this.historyOverlayOpen && root.dataset.overlay === (next ? "true" : "false")) return false;
        const modalDocument = root.ownerDocument || document;
        if (next) {
            const activeElement = modalDocument.activeElement;
            this.historyOverlayReturnFocus = activeElement && typeof activeElement.focus === "function" ? activeElement : null;
            this.historyOverlayOpen = true;
            root.dataset.overlay = "true";
            root.setAttribute("role", "dialog");
            root.setAttribute("aria-modal", "true");
            root.setAttribute("aria-label", "Discord Vision Inbox overlay");
            this.historyOverlayDocument = modalDocument;
            modalDocument.addEventListener("keydown", this.historyOverlayKeyHandler, true);
            this.renderHistoryRail(root);
            const hideButton = root.querySelector('[data-action="hide-overlay"]');
            try { hideButton?.focus({preventScroll: true}); }
            catch { hideButton?.focus(); }
            return true;
        }

        const returnFocus = this.historyOverlayReturnFocus;
        this.historyOverlayDocument?.removeEventListener?.("keydown", this.historyOverlayKeyHandler, true);
        this.historyOverlayDocument = null;
        this.historyOverlayOpen = false;
        this.historyOverlayReturnFocus = null;
        root.dataset.overlay = "false";
        root.removeAttribute("role");
        root.removeAttribute("aria-modal");
        root.setAttribute("aria-label", "KREA2 prompt history");
        this.renderHistoryRail(root);
        if (restoreFocus) {
            const fallback = this.settings.historyCollapsed
                ? root.querySelector(".krea2-history-collapse-launcher")
                : root.querySelector('[data-action="expand-overlay"]');
            const focusTarget = this.settings.historyCollapsed ? fallback : (returnFocus || fallback);
            if (focusTarget && focusTarget.isConnected !== false && typeof focusTarget.focus === "function") {
                try { focusTarget.focus({preventScroll: true}); }
                catch { focusTarget.focus(); }
            }
        }
        return true;
    }

    handleHistoryOverlayKeydown(event) {
        const root = this.historyRoot;
        if (!this.historyOverlayOpen || !root || root.dataset.overlay !== "true") return false;
        const modalDocument = root.ownerDocument || document;
        const blockingModal = [...modalDocument.querySelectorAll('[aria-modal="true"]')]
            .some(element => element !== root && !root.contains(element));
        if (blockingModal) return false;
        if (event.key === "Escape") {
            event.preventDefault?.();
            event.stopPropagation?.();
            this.setHistoryOverlay(false);
            return true;
        }
        if (event.key !== "Tab") return false;
        const focusable = [...root.querySelectorAll([
            "button:not([disabled]):not([hidden])",
            "input:not([disabled]):not([hidden])",
            "select:not([disabled]):not([hidden])",
            "textarea:not([disabled]):not([hidden])",
            "a[href]:not([hidden])",
            '[tabindex]:not([tabindex="-1"]):not([hidden])'
        ].join(","))].filter(element => {
            if (element.hidden || element.getAttribute?.("aria-hidden") === "true") return false;
            return typeof element.getClientRects !== "function" || element.getClientRects().length > 0;
        });
        if (!focusable.length) return false;
        const active = modalDocument.activeElement;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const moveTo = event.shiftKey
            ? (active === first || !root.contains(active) ? last : null)
            : (active === last || !root.contains(active) ? first : null);
        if (!moveTo) return false;
        event.preventDefault?.();
        event.stopPropagation?.();
        try { moveTo.focus({preventScroll: true}); }
        catch { moveTo.focus(); }
        return true;
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
        root.dataset.overlay = this.historyOverlayOpen ? "true" : "false";
        const heading = root?.querySelector(".krea2-history-title");
        const subtitle = root?.querySelector(".krea2-history-subtitle");
        const expandOverlay = root?.querySelector('[data-action="expand-overlay"]');
        const hideOverlay = root?.querySelector('[data-action="hide-overlay"]');
        const railClose = root?.querySelector(".krea2-history-rail-close");
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
        const overlayOpen = this.historyOverlayOpen === true;
        if (heading) heading.textContent = overlayOpen ? "Discord Vision Inbox" : isInterrogate ? "Interrogate" : "Prompt History";
        if (subtitle) subtitle.textContent = overlayOpen
            ? (isInterrogate ? "Interrogate images · choose model · shared queue" : "Review prompts, queue state, and completed Vision jobs")
            : isInterrogate ? "Upload · choose model · queue" : "All local Vision jobs";
        if (expandOverlay) {
            expandOverlay.hidden = overlayOpen;
            expandOverlay.setAttribute("aria-expanded", overlayOpen ? "true" : "false");
        }
        if (hideOverlay) hideOverlay.hidden = !overlayOpen;
        if (railClose) railClose.hidden = overlayOpen;
        if (libraryTools) libraryTools.hidden = isInterrogate;
        interrogateNode.hidden = !isInterrogate;
        listNode.hidden = isInterrogate;
        paginationNode.hidden = isInterrogate;

        for (const tab of root.querySelectorAll(".krea2-history-tab")) {
            tab.setAttribute("aria-selected", tab.dataset.filter === this.historyFilter ? "true" : "false");
        }
        this.renderInterrogatePanel(interrogateNode);

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
            if (completedJob) {
                completion.dataset.status = completedJob.status;
                const resultLabel = completedJob.status === "completed"
                    ? "Prompt ready"
                    : completedJob.status === "cancelled"
                        ? "Vision job cancelled"
                        : "Vision job failed";
                completion.textContent = `${resultLabel}: ${historyJobTitle(completedJob)} — open details`;
            }
            else delete completion.dataset.status;
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
        const destination = localPathJoin(directory, `${key}${encoded.extension}`);
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
        // An on-demand Online API worker must be allowed to cold-start.  A
        // local 30-second submission timer incorrectly marked the image as a
        // GPU failure before Vision Studio could submit it to Serverless.
        if (String(model || "").trim() !== ONLINE_VISION_MODEL_ID) return;
        this.updateLocalVisionSubmission(id, {
            status: "queued",
            stage: "Queued online — waking the remote GPU if it is asleep. The first request can take several minutes.",
            public_error: ""
        });
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
        const editWithQwen = modalDocument.createElement("button");
        editWithQwen.type = "button";
        editWithQwen.className = "krea2-history-action";
        editWithQwen.textContent = "✦ Edit with Qwen";
        editWithQwen.disabled = true;
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
        actions.append(cancelJob, retry, editWithQwen, copy, done);

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
            }, controller.signal));
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
            editWithQwen.disabled = !currentJob.prompt;
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
            }, controller.signal));
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
        editWithQwen.addEventListener("click", () => {
            if (currentJob?.prompt) this.openPromptEditor(currentJob.prompt, modalDocument);
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

    createHistoryDetailBody(job, modalDocument = document, thumbnailUrl = null, onRegionPreview = null, parentSignal = null) {
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
            const variants = visibleHistoryPromptVariants(job, this.settings);
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
            const editVariant = modalDocument.createElement("button");
            editVariant.type = "button";
            editVariant.className = "krea2-history-action";
            editVariant.textContent = "✦ Edit this prompt with Qwen";
            const auditVariant = modalDocument.createElement("button");
            auditVariant.type = "button";
            auditVariant.className = "krea2-history-action";
            auditVariant.textContent = "? Ask Qwen about this prompt · 1 credit";
            const inpaintVariant = modalDocument.createElement("button");
            inpaintVariant.type = "button";
            inpaintVariant.className = "krea2-history-action";
            inpaintVariant.textContent = "◎ Inpaint prompt region";
            inpaintVariant.disabled = !thumbnailUrl;
            inpaintVariant.title = thumbnailUrl
                ? "Mask one image region, inspect its pixels, and surgically correct this prompt"
                : "The local source preview is unavailable for region correction";
            const inpaintPanel = modalDocument.createElement("section");
            inpaintPanel.className = "krea2-region-inpaint";
            inpaintPanel.hidden = true;
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
            const variantLabels = variants.length === 1
                ? ["Prompt"]
                : ["Prompt 1 · Balanced", "Prompt 2 · Subject & pose", "Prompt 3 · Scene & light"];
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
                copyVariant.textContent = variants.length === 1 ? "Copy prompt" : `Copy Prompt ${index + 1}`;
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
                    setTimeout(() => {
                        if (copyVariant.isConnected) copyVariant.textContent = variants.length === 1 ? "Copy prompt" : `Copy Prompt ${selectedVariant + 1}`;
                    }, 1400);
                }
                catch { this.toast("Discord could not copy the selected prompt.", "error"); }
            });
            editVariant.addEventListener("click", () => this.openPromptEditor(variants[selectedVariant], modalDocument));
            auditVariant.addEventListener("click", () => this.openPromptAudit(variants[selectedVariant], modalDocument));
            inpaintVariant.addEventListener("click", () => {
                if (!thumbnailUrl) return;
                if (!inpaintPanel.hidden) {
                    inpaintPanel.hidden = true;
                    inpaintVariant.textContent = "◎ Inpaint prompt region";
                    return;
                }
                inpaintPanel.hidden = false;
                inpaintVariant.textContent = "Hide region inpaint";
                inpaintPanel.replaceChildren();
                const targetVariantIndex = selectedVariant;
                this.buildRegionInpaintPanel(inpaintPanel, {
                    sourceUrl: thumbnailUrl,
                    modalDocument,
                    parentSignal,
                    getCurrentPrompt: () => variants[targetVariantIndex],
                    onAdopt: revised => {
                        variants[targetVariantIndex] = revised;
                        if (selectedVariant === targetVariantIndex) {
                            prompt.value = revised;
                            refreshFeedback();
                        }
                    },
                    showSelectedRegion
                });
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
            output.append(label);
            output.append(variantTabs, prompt, feedback, editVariant, auditVariant, inpaintVariant, copyVariant, inpaintPanel);
        }
        else {
            if (isHistoryJobActive(job)) {
                const message = modalDocument.createElement("div");
                message.className = "krea2-history-stage";
                message.textContent = job.stage || "Waiting for the local Vision worker…";
                output.append(message);
            }
            else {
                output.append(this.createDiagnosticCenter(job, modalDocument));
            }
        }
        result.append(source, output);
        fragment.append(result);
        if (job.prompt) {
            fragment.append(this.createPoseAndContradictionPanel(job, modalDocument));
            fragment.append(this.createPromptProvenancePanel(job, modalDocument));
        }
        return fragment;
    }

    createPoseAndContradictionPanel(job, modalDocument = document) {
        const panel = modalDocument.createElement("section");
        panel.className = "krea2-quality-panel";
        const title = modalDocument.createElement("h3");
        title.textContent = "Pose Inspector & contradiction check";
        panel.append(title);
        const pose = job?.reproducibility?.pose_check || null;
        if (pose) {
            const receipt = normalizePoseCheck(pose);
            const grid = modalDocument.createElement("div");
            grid.className = "krea2-quality-grid";
            const facts = [
                ["Subjects", String(receipt.subject_count)],
                ["Body state", receipt.primary_posture.replaceAll("_", " ")],
                ["Pelvis support", `${receipt.pelvis_support.replaceAll("_", " ")}${receipt.pelvis_support_surface ? ` · ${receipt.pelvis_support_surface}` : ""}`],
                ["Left foot", `${receipt.left_foot_weight_bearing === true ? "weight-bearing" : receipt.left_foot_weight_bearing === false ? "not weight-bearing" : "not visible"} · ${receipt.left_foot_surface || "unknown surface"}`],
                ["Right foot", `${receipt.right_foot_weight_bearing === true ? "weight-bearing" : receipt.right_foot_weight_bearing === false ? "not weight-bearing" : "not visible"} · ${receipt.right_foot_surface || "unknown surface"}`],
                ["Knees / hips", `${receipt.knee_flexion.replaceAll("_", " ")} · hips ${receipt.hip_height_relative_to_knees.replaceAll("_", " ")} knees`],
                ["Other support", receipt.other_weight_bearing_support || "none"],
                ["Camera view", receipt.camera_view || "not recorded"]
            ];
            for (const [label, value] of facts) {
                const item = modalDocument.createElement("div");
                item.className = "krea2-quality-fact";
                const span = modalDocument.createElement("span");
                span.textContent = label;
                const strong = modalDocument.createElement("strong");
                strong.textContent = value;
                item.append(span, strong);
                grid.append(item);
            }
            panel.append(grid);
        }
        else {
            const note = modalDocument.createElement("div");
            note.className = "krea2-history-model-proof-note";
            note.textContent = "A structured pose receipt was not stored for this older or non-V2 job. New V2 results preserve it automatically.";
            panel.append(note);
        }
        const issues = auditPromptContradictions(job.prompt, pose);
        if (!issues.length) {
            const clear = modalDocument.createElement("div");
            clear.className = "krea2-audit-clear";
            clear.textContent = "✓ No obvious deterministic contradictions found. This is a local consistency check, not a second image interpretation.";
            panel.append(clear);
        }
        else {
            const list = modalDocument.createElement("ul");
            list.className = "krea2-audit-list";
            for (const issue of issues) {
                const item = modalDocument.createElement("li");
                item.className = "krea2-audit-item";
                item.dataset.severity = issue.severity;
                item.textContent = issue.message;
                list.append(item);
            }
            panel.append(list);
        }
        return panel;
    }

    createPromptProvenancePanel(job, modalDocument = document) {
        const details = modalDocument.createElement("details");
        details.className = "krea2-provenance";
        const summary = modalDocument.createElement("summary");
        summary.textContent = "Prompt provenance (visible; never injected into the prompt)";
        const body = modalDocument.createElement("div");
        body.className = "krea2-provenance-body";
        const profile = String(job?.reproducibility?.analysis_profile || "unknown");
        const pipeline = String(job?.reproducibility?.pipeline_id || VISION_PIPELINE_ID);
        const origin = profile === "v2" ? "Vision V2 Direct Fidelity" : profile === "maximum" ? "Vision Maximum detail" : profile === "fast" ? "Vision Fast" : "Vision result or imported metadata";
        const text = modalDocument.createElement("div");
        text.textContent = `Origin: ${origin} · Pipeline: ${pipeline} · Model: ${job.model || job.requested_model || "unknown"}. Qwen edits and region corrections remain explicit user actions; no hidden text, links, or settings are added to copied prompts.`;
        const links = modalDocument.createElement("div");
        links.className = "krea2-provenance-links";
        for (const [label, url] of [["GitHub source", PROJECT_LINKS.github], ["BabeGenerator.ink", PROJECT_LINKS.babegenerator]]) {
            const button = modalDocument.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.addEventListener("click", () => {
                try { this.openVerifiedExternal(url, "project"); }
                catch (error) { this.toast(error instanceof Error ? error.message : String(error), "error"); }
            });
            links.append(button);
        }
        body.append(text, links);
        details.append(summary, body);
        return details;
    }

    createDiagnosticCenter(job, modalDocument = document) {
        const diagnostic = diagnosticForHistoryJob(job);
        const panel = modalDocument.createElement("section");
        panel.className = "krea2-diagnostic-center";
        panel.dataset.synthetic = diagnostic.synthetic ? "true" : "false";
        const title = modalDocument.createElement("div");
        title.className = "krea2-diagnostic-title";
        title.textContent = diagnostic.synthetic ? "Synthetic route test — no user image failed" : "Failure diagnostics";
        panel.append(title);
        for (const [label, value] of [
            ["Support ID", diagnostic.support_id],
            ["Error code", diagnostic.error_code],
            ["Failed stage", diagnostic.stage],
            ["Explanation", diagnostic.message],
            ["Worker state", diagnostic.worker_state],
            ["Credits / refund", diagnostic.credit_outcome],
            ["Recommended next step", diagnostic.recommendation]
        ]) {
            const row = modalDocument.createElement("div");
            row.className = "krea2-diagnostic-row";
            const span = modalDocument.createElement("span");
            span.textContent = label;
            const valueNode = modalDocument.createElement("div");
            valueNode.textContent = value;
            row.append(span, valueNode);
            panel.append(row);
        }
        const actions = modalDocument.createElement("div");
        actions.className = "krea2-diagnostic-actions";
        const copyId = modalDocument.createElement("button");
        copyId.type = "button";
        copyId.className = "krea2-history-action";
        copyId.textContent = "Copy support ID";
        copyId.addEventListener("click", async () => {
            try {
                await (modalDocument.defaultView?.navigator || navigator).clipboard.writeText(diagnostic.support_id);
                copyId.textContent = "Copied";
                setTimeout(() => { if (copyId.isConnected) copyId.textContent = "Copy support ID"; }, 1200);
            }
            catch { this.toast("Discord could not copy the support ID.", "error"); }
        });
        const download = modalDocument.createElement("button");
        download.type = "button";
        download.className = "krea2-history-action";
        download.textContent = "Download redacted .txt";
        download.addEventListener("click", () => {
            const view = modalDocument.defaultView || window;
            const url = view.URL.createObjectURL(new view.Blob([buildRedactedDiagnosticReport(job)], {type: "text/plain;charset=utf-8"}));
            const anchor = modalDocument.createElement("a");
            anchor.href = url;
            anchor.download = `krea2-diagnostic-${diagnostic.support_id.slice(0, 12)}.txt`;
            anchor.click();
            setTimeout(() => view.URL.revokeObjectURL(url), 1000);
        });
        actions.append(copyId, download);
        panel.append(actions);
        return panel;
    }

    buildRegionInpaintPanel(panel, {sourceUrl, modalDocument, parentSignal = null, getCurrentPrompt, onAdopt, showSelectedRegion = null}) {
        const title = modalDocument.createElement("h3");
        title.className = "krea2-region-inpaint-title";
        title.textContent = "Region Inpaint Prompt Correction";
        const selectedModel = effectiveVisionModel(this.settings);
        const onlineVision = selectedModel === ONLINE_VISION_MODEL_ID;
        const note = modalDocument.createElement("div");
        note.className = "krea2-region-note";
        note.textContent = onlineVision
            ? "Drag a box over the pixels that are wrong, explain the correction, then review the proposed full prompt. Online mode uses 3 credits for the crop inspection plus 1 credit only after the Qwen rewrite succeeds. Nothing is adopted automatically."
            : "Drag a box over the pixels that are wrong, explain the correction, then review the proposed full prompt. Local Vision inspects the crop through the shared GPU FIFO; only the successful Qwen rewrite costs 1 Online API credit. Nothing is adopted automatically.";
        const stage = modalDocument.createElement("div");
        stage.className = "krea2-region-stage";
        const canvas = modalDocument.createElement("canvas");
        canvas.className = "krea2-region-canvas";
        stage.append(canvas);
        const instruction = modalDocument.createElement("textarea");
        instruction.className = "krea2-region-inpaint-instruction";
        instruction.maxLength = 800;
        instruction.placeholder = "What is wrong here? Example: She is standing with her left foot on the skateboard and her right foot on the pavement; do not describe her as sitting.";
        const toolbar = modalDocument.createElement("div");
        toolbar.className = "krea2-workshop-toolbar";
        const run = modalDocument.createElement("button");
        run.type = "button";
        run.className = "krea2-history-action";
        run.dataset.primary = "true";
        run.textContent = "Inspect region and rewrite prompt";
        run.disabled = true;
        const clear = modalDocument.createElement("button");
        clear.type = "button";
        clear.className = "krea2-history-action";
        clear.textContent = "Clear mask";
        toolbar.append(run, clear);
        const status = modalDocument.createElement("div");
        status.className = "krea2-region-inpaint-status";
        status.textContent = "Draw a region mask and describe the correction. The original prompt remains unchanged until you select Adopt correction.";
        const results = modalDocument.createElement("div");
        results.className = "krea2-region-inpaint-results";
        results.hidden = true;
        const beforeCard = modalDocument.createElement("article");
        beforeCard.className = "krea2-region-inpaint-result";
        const beforeLabel = modalDocument.createElement("strong");
        beforeLabel.textContent = "Current prompt";
        const beforeText = modalDocument.createElement("div");
        beforeText.className = "krea2-region-inpaint-text";
        beforeCard.append(beforeLabel, beforeText);
        const afterCard = modalDocument.createElement("article");
        afterCard.className = "krea2-region-inpaint-result";
        const afterLabel = modalDocument.createElement("strong");
        afterLabel.textContent = "Proposed corrected prompt";
        const afterText = modalDocument.createElement("div");
        afterText.className = "krea2-region-inpaint-text";
        afterCard.append(afterLabel, afterText);
        results.append(beforeCard, afterCard);
        const evidenceCard = modalDocument.createElement("article");
        evidenceCard.className = "krea2-region-inpaint-result";
        evidenceCard.hidden = true;
        const evidenceLabel = modalDocument.createElement("strong");
        evidenceLabel.textContent = "Vision evidence from selected pixels";
        const evidenceText = modalDocument.createElement("div");
        evidenceText.className = "krea2-region-inpaint-text";
        evidenceCard.append(evidenceLabel, evidenceText);
        const resultActions = modalDocument.createElement("div");
        resultActions.className = "krea2-workshop-toolbar";
        resultActions.hidden = true;
        const adopt = modalDocument.createElement("button");
        adopt.type = "button";
        adopt.className = "krea2-history-action";
        adopt.dataset.primary = "true";
        adopt.textContent = "Adopt correction";
        const copy = modalDocument.createElement("button");
        copy.type = "button";
        copy.className = "krea2-history-action";
        copy.textContent = "Copy proposed prompt";
        const continueEditing = modalDocument.createElement("button");
        continueEditing.type = "button";
        continueEditing.className = "krea2-history-action";
        continueEditing.textContent = "Continue in Qwen Editor";
        resultActions.append(adopt, copy, continueEditing);
        panel.append(title, note, stage, instruction, toolbar, status, results, evidenceCard, resultActions);

        const view = modalDocument.defaultView || window;
        const image = new view.Image();
        let selection = null;
        let dragStart = null;
        let proposedPrompt = "";
        const setStatus = (text, state = "idle") => {
            status.textContent = text;
            status.dataset.state = state;
        };
        const refreshRunState = () => {
            run.disabled = !selection || selection.w < 24 || selection.h < 24 || instruction.value.trim().length < 2;
        };
        const redraw = () => {
            if (!canvas.width || !canvas.height || !image.complete) return;
            const context = canvas.getContext("2d");
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            if (!selection) return;
            context.save();
            context.fillStyle = "rgba(7, 10, 16, .54)";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.clearRect(selection.x, selection.y, selection.w, selection.h);
            context.drawImage(image, selection.x, selection.y, selection.w, selection.h, selection.x, selection.y, selection.w, selection.h);
            context.strokeStyle = "#ff9d57";
            context.lineWidth = Math.max(2, canvas.width / 450);
            context.setLineDash([Math.max(5, canvas.width / 100), Math.max(3, canvas.width / 160)]);
            context.strokeRect(selection.x, selection.y, selection.w, selection.h);
            context.restore();
        };
        image.onload = () => {
            const scale = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight));
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            redraw();
        };
        image.onerror = () => setStatus("The source preview could not be decoded for region inpaint.", "error");
        image.src = sourceUrl;
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
            refreshRunState();
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
            refreshRunState();
            redraw();
        });
        const finishDrag = () => { dragStart = null; };
        canvas.addEventListener("pointerup", finishDrag);
        canvas.addEventListener("pointercancel", finishDrag);
        instruction.addEventListener("input", refreshRunState);
        clear.addEventListener("click", () => {
            selection = null;
            dragStart = null;
            proposedPrompt = "";
            results.hidden = true;
            evidenceCard.hidden = true;
            resultActions.hidden = true;
            setStatus("Mask cleared. Draw a new region and describe the correction.");
            refreshRunState();
            redraw();
        });
        adopt.addEventListener("click", () => {
            if (!proposedPrompt) return;
            onAdopt?.(proposedPrompt);
            beforeText.textContent = proposedPrompt;
            adopt.disabled = true;
            setStatus("The corrected prompt is now active for this result. It remains session-only until copied.", "success");
        });
        copy.addEventListener("click", () => void this.copyProductText(proposedPrompt, modalDocument));
        continueEditing.addEventListener("click", () => {
            if (proposedPrompt) this.openPromptEditor(proposedPrompt, modalDocument);
        });
        run.addEventListener("click", async () => {
            const currentPrompt = String(getCurrentPrompt?.() || "").trim().slice(0, 18000);
            const request = instruction.value.trim().slice(0, 800);
            if (!selection || selection.w < 24 || selection.h < 24 || request.length < 2) return;
            if (currentPrompt.length < 20) return setStatus("A complete current prompt is required before region correction.", "error");
            const controller = new AbortController();
            const abortFromParent = () => controller.abort();
            if (parentSignal?.aborted) controller.abort();
            else parentSignal?.addEventListener?.("abort", abortFromParent, {once: true});
            this.controllers.add(controller);
            run.disabled = true;
            clear.disabled = true;
            instruction.disabled = true;
            adopt.disabled = false;
            proposedPrompt = "";
            results.hidden = true;
            evidenceCard.hidden = true;
            resultActions.hidden = true;
            try {
                setStatus(`Checking the ${onlineVision ? "4-credit online" : "1-credit local-Vision"} region-inpaint contract…`);
                await this.ensureRemoteCredits(controller.signal, onlineVision ? "region-inpaint" : "prompt-chat");
                const scaleX = image.naturalWidth / canvas.width;
                const scaleY = image.naturalHeight / canvas.height;
                const selectedX = selection.x * scaleX;
                const selectedY = selection.y * scaleY;
                const selectedWidth = selection.w * scaleX;
                const selectedHeight = selection.h * scaleY;
                const padding = Math.max(8, Math.round(Math.max(selectedWidth, selectedHeight) * 0.1));
                const sourceX = Math.max(0, Math.floor(selectedX - padding));
                const sourceY = Math.max(0, Math.floor(selectedY - padding));
                const sourceRight = Math.min(image.naturalWidth, Math.ceil(selectedX + selectedWidth + padding));
                const sourceBottom = Math.min(image.naturalHeight, Math.ceil(selectedY + selectedHeight + padding));
                const sourceWidth = Math.max(24, sourceRight - sourceX);
                const sourceHeight = Math.max(24, sourceBottom - sourceY);
                const outputScale = Math.min(1, 1600 / Math.max(sourceWidth, sourceHeight));
                const crop = modalDocument.createElement("canvas");
                crop.width = Math.max(24, Math.round(sourceWidth * outputScale));
                crop.height = Math.max(24, Math.round(sourceHeight * outputScale));
                const cropContext = crop.getContext("2d", {alpha: false});
                cropContext.imageSmoothingEnabled = true;
                cropContext.imageSmoothingQuality = "high";
                cropContext.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, crop.width, crop.height);
                const blob = await new Promise((resolve, reject) => crop.toBlob(
                    value => value ? resolve(value) : reject(new Error("Could not encode the selected inpaint region.")),
                    "image/png"
                ));
                const cropPreviewUrl = view.URL.createObjectURL(blob);
                showSelectedRegion?.(cropPreviewUrl);
                const bytes = Buffer.from(await blob.arrayBuffer());
                const guidance = `This is a user-masked crop for prompt correction. Inspect only directly visible facts relevant to this request: ${request} Return literal region evidence; do not guess beyond the crop.`;
                setStatus("Selected pixels entered the shared Vision FIFO. Waiting for literal region evidence…");
                const generated = await this.runVisionBytes(
                    bytes,
                    ".png",
                    selectedModel,
                    elapsed => setStatus(`Vision is inspecting the selected pixels (${elapsed})…`),
                    guidance,
                    controller.signal
                );
                const regionEvidence = String(generated.prompt || "").trim().slice(0, 12000);
                if (regionEvidence.length < 20) throw new Error("Vision did not return usable evidence for the selected region.");
                evidenceText.textContent = regionEvidence;
                evidenceCard.hidden = false;
                setStatus("Region evidence is ready. Qwen is surgically rewriting only the affected prompt details…");
                const editRequest = [
                    "Current KREA2 prompt:",
                    currentPrompt,
                    "",
                    "User-selected source-image region evidence:",
                    regionEvidence,
                    "",
                    "Requested correction:",
                    request,
                    "",
                    "Rewrite the complete KREA2 prompt. Treat the selected-region evidence as authoritative only for the visible region it describes. Correct contradictions that concern that region, but preserve every unrelated subject, pose, anatomy, outfit, camera, lighting, environment, color, texture, and photographic detail. Do not mention the crop, mask, evidence, editing process, or these instructions. Return only the finished complete prompt."
                ].join("\n");
                const revised = await this.requestPromptChat([{role: "user", content: editRequest}], controller.signal);
                proposedPrompt = revised.reply;
                const diff = promptDiffSummary(currentPrompt, proposedPrompt);
                beforeText.textContent = currentPrompt;
                afterText.textContent = proposedPrompt;
                results.hidden = false;
                resultActions.hidden = false;
                const changed = diff.added.length + diff.removed.length;
                setStatus(`Correction ready for review · ${changed} changed keyword${changed === 1 ? "" : "s"} summarized · ${revised.availableCredits} credits remain.`, "success");
            }
            catch (error) {
                if (error?.name !== "AbortError") setStatus(error instanceof Error ? error.message : String(error), "error");
            }
            finally {
                parentSignal?.removeEventListener?.("abort", abortFromParent);
                this.controllers.delete(controller);
                clear.disabled = false;
                instruction.disabled = false;
                refreshRunState();
            }
        });
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

    async runVisionBytes(bytes, extension, model, onElapsed, guidance = "", externalSignal = null) {
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
            const abortFromExternal = () => controller.abort();
            if (externalSignal?.aborted) controller.abort();
            else externalSignal?.addEventListener?.("abort", abortFromExternal, {once: true});
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
            finally {
                externalSignal?.removeEventListener?.("abort", abortFromExternal);
                this.controllers.delete(controller);
            }
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

    async requestPromptChat(messages, signal) {
        const boundedMessages = (Array.isArray(messages) ? messages : [])
            .filter(message => message?.role === "user" || message?.role === "assistant")
            .map(message => ({role: message.role, content: String(message.content || "").trim().slice(0, 24000)}))
            .filter(message => message.content);
        if (!boundedMessages.length || boundedMessages.at(-1)?.role !== "user") {
            throw new Error("Qwen Prompt Editor requires a final user instruction.");
        }
        if (boundedMessages.reduce((total, message) => total + message.content.length, 0) > 48000) {
            throw new Error("The Qwen Prompt Editor conversation is too large. Start a new chat.");
        }
        const license = await this.ensureRemoteCredits(signal, "prompt-chat");
        const requestId = createHash("sha256").update(randomBytes(48)).digest("hex");
        const response = await this.api.Net.fetch(`${REMOTE_GATEWAY_URL}/v1/prompt-chat/completions`, {
            method: "POST",
            redirect: "manual",
            maxRedirects: 0,
            timeout: 8 * 60 * 1000,
            signal,
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: `Krea2License ${license.licenseId}.${license.licenseToken}`,
                "X-Krea2-Request-Id": requestId,
                "X-Krea2-Collector-Version": PLUGIN_VERSION
            },
            body: JSON.stringify({model: "heretic-3.8-q4-cloud", messages: boundedMessages, temperature: 0.35, max_tokens: 1536, stream: false})
        });
        const responseText = await readBoundedResponseText(response, 128 * 1024);
        let result;
        try { result = JSON.parse(responseText); }
        catch { throw new Error("Qwen Prompt Editor returned invalid JSON."); }
        if (!response.ok) throw new Error(String(result?.detail || `Qwen Prompt Editor failed with HTTP ${response.status}.`));
        const reply = String(result?.reply || "").trim();
        if (!reply || reply.length > 24000 || result?.model !== "heretic-3.8-q4-cloud" || result?.credits_charged !== 1) {
            throw new Error("Qwen Prompt Editor returned an invalid reply.");
        }
        return Object.freeze({
            reply,
            model: result.model,
            creditsCharged: 1,
            availableCredits: Number(result.available_credits)
        });
    }

    openPromptAudit(initialPrompt, modalDocument = document) {
        const auditedPrompt = String(initialPrompt || "").trim().slice(0, 18000);
        if (auditedPrompt.length < 20) {
            this.toast("Open a completed prompt before asking Qwen to audit it.", "error");
            return;
        }
        this.promptAuditCleanup?.();
        modalDocument.getElementById(PROMPT_AUDIT_MODAL_ID)?.remove();
        const controller = new AbortController();
        let busy = false;
        const overlay = modalDocument.createElement("div");
        overlay.id = PROMPT_AUDIT_MODAL_ID;
        const dialog = modalDocument.createElement("section");
        dialog.className = "krea2-history-dialog";
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-label", "Ask Qwen about this prompt");
        const head = modalDocument.createElement("div");
        head.className = "krea2-history-dialog-head";
        const heading = modalDocument.createElement("h2");
        heading.textContent = "Ask Qwen about this prompt";
        const close = modalDocument.createElement("button");
        close.type = "button";
        close.className = "krea2-history-icon";
        close.textContent = "×";
        close.setAttribute("aria-label", "Close prompt audit");
        head.append(heading, close);
        const body = modalDocument.createElement("div");
        body.className = "krea2-history-dialog-body krea2-prompt-editor-body";
        const explanation = modalDocument.createElement("div");
        explanation.className = "krea2-prompt-editor-explanation";
        explanation.textContent = "Ask a question about the current prompt without rewriting it. Qwen can identify the pose, contradictions, weak details, or missing reconstruction facts. Each successful answer costs 1 credit; opening, typing, and failed requests are free.";
        const preflight = modalDocument.createElement("div");
        preflight.className = "krea2-preflight";
        preflight.textContent = "Checking worker, wait estimate, and credit protection…";
        const presets = modalDocument.createElement("div");
        presets.className = "krea2-workshop-toolbar";
        const question = modalDocument.createElement("textarea");
        question.className = "krea2-prompt-editor-instruction";
        question.maxLength = 4000;
        question.placeholder = "What pose does this prompt specify?";
        for (const text of [
            "What exact body pose and support geometry does this prompt specify?",
            "Find contradictions or physically impossible details in this prompt.",
            "What important KREA2 reconstruction details are missing?",
            "Does the camera, lighting, shadow, and depth-of-field description agree?"
        ]) {
            const button = modalDocument.createElement("button");
            button.type = "button";
            button.className = "krea2-history-action";
            button.textContent = text.split(" ").slice(0, 4).join(" ") + "…";
            button.title = text;
            button.addEventListener("click", () => { question.value = text; question.focus(); });
            presets.append(button);
        }
        const answer = modalDocument.createElement("div");
        answer.className = "krea2-prompt-editor-turn";
        answer.dataset.role = "assistant";
        answer.hidden = true;
        const status = modalDocument.createElement("div");
        status.className = "krea2-prompt-editor-status";
        status.textContent = "No credit has been used.";
        const actions = modalDocument.createElement("div");
        actions.className = "krea2-history-dialog-actions";
        const send = modalDocument.createElement("button");
        send.type = "button";
        send.className = "krea2-history-action";
        send.dataset.primary = "true";
        send.textContent = "Ask Qwen · 1 credit";
        const copy = modalDocument.createElement("button");
        copy.type = "button";
        copy.className = "krea2-history-action";
        copy.textContent = "Copy answer";
        copy.disabled = true;
        const done = modalDocument.createElement("button");
        done.type = "button";
        done.className = "krea2-history-action";
        done.textContent = "Close";
        actions.append(send, copy, done);
        body.append(explanation, preflight, presets, question, answer, status);
        dialog.append(head, body, actions);
        overlay.append(dialog);
        modalDocument.body.append(overlay);

        const cleanup = () => {
            controller.abort();
            modalDocument.removeEventListener("keydown", onKey, true);
            overlay.remove();
            if (this.promptAuditCleanup === cleanup) this.promptAuditCleanup = null;
        };
        const onKey = event => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopImmediatePropagation?.();
                cleanup();
            }
            else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void submit();
        };
        const submit = async () => {
            if (busy) return;
            const request = question.value.trim();
            if (request.length < 2) {
                status.textContent = "Ask a question first.";
                status.dataset.state = "error";
                return;
            }
            busy = true;
            send.disabled = true;
            send.textContent = "Qwen is auditing…";
            status.textContent = "Waiting safely; a failed answer is automatically refunded.";
            status.dataset.state = "";
            try {
                const instruction = [
                    "Audit the supplied KREA2 generation prompt. Answer the user's question directly and concisely.",
                    "Do not rewrite the prompt, do not output a replacement prompt, and do not claim to see the source image.",
                    "Base every conclusion only on the prompt text. Explicitly label uncertainty.",
                    `KREA2 prompt:\n${auditedPrompt}`,
                    `User question:\n${request}`
                ].join("\n\n");
                const result = await this.requestPromptChat([{role: "user", content: instruction}], controller.signal);
                answer.textContent = result.reply;
                answer.hidden = false;
                copy.disabled = false;
                status.textContent = `Audit complete · 1 credit used · ${result.availableCredits} credits remaining.`;
                status.dataset.state = "success";
            }
            catch (error) {
                if (error?.name !== "AbortError") {
                    status.textContent = error instanceof Error ? error.message : String(error);
                    status.dataset.state = "error";
                }
            }
            finally {
                busy = false;
                send.disabled = false;
                send.textContent = "Ask Qwen · 1 credit";
            }
        };
        this.promptAuditCleanup = cleanup;
        modalDocument.addEventListener("keydown", onKey, true);
        close.addEventListener("click", cleanup);
        done.addEventListener("click", cleanup);
        overlay.addEventListener("click", event => { if (event.target === overlay) cleanup(); });
        send.addEventListener("click", () => void submit());
        copy.addEventListener("click", async () => {
            try {
                await (modalDocument.defaultView?.navigator || navigator).clipboard.writeText(answer.textContent || "");
                copy.textContent = "Copied";
                setTimeout(() => { if (copy.isConnected) copy.textContent = "Copy answer"; }, 1200);
            }
            catch { this.toast("Discord could not copy the audit answer.", "error"); }
        });
        void (async () => {
            try {
                const license = await this.ensureRemoteLicense(controller.signal);
                const creditStatus = await this.remoteCreditStatus(license, controller.signal, "prompt-chat");
                preflight.textContent = remotePreflightSummary(creditStatus, "prompt-chat").text;
            }
            catch (error) {
                if (error?.name !== "AbortError") preflight.textContent = error instanceof Error ? error.message : String(error);
            }
        })();
        question.focus();
    }

    openPromptEditor(initialPrompt = "", modalDocument = document) {
        const suppliedPrompt = String(initialPrompt || "").trim().slice(0, 18000);
        this.promptEditorCleanup?.();
        const restoredDraft = suppliedPrompt ? null : this.promptEditorDraft;
        modalDocument.getElementById(PROMPT_EDITOR_MODAL_ID)?.remove();
        const controller = new AbortController();
        let messages = Array.isArray(restoredDraft?.messages)
            ? restoredDraft.messages
                .filter(message => message?.role === "user" || message?.role === "assistant")
                .map(message => ({role: message.role, content: String(message.content || "").slice(0, 24000)}))
            : [];
        let turns = Array.isArray(restoredDraft?.turns)
            ? restoredDraft.turns
                .filter(turn => turn?.role === "user" || turn?.role === "assistant")
                .map(turn => ({role: turn.role, text: String(turn.text || "").slice(0, 24000)}))
            : [];
        let busy = false;
        let latestReply = String(restoredDraft?.latestReply || "").slice(0, 24000);

        const overlay = modalDocument.createElement("div");
        overlay.id = PROMPT_EDITOR_MODAL_ID;
        overlay.setAttribute("role", "presentation");
        const dialog = modalDocument.createElement("section");
        dialog.className = "krea2-history-dialog";
        dialog.dataset.promptEditor = "true";
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-label", "Qwen Prompt Editor");

        const head = modalDocument.createElement("div");
        head.className = "krea2-history-dialog-head";
        const heading = modalDocument.createElement("h2");
        heading.textContent = "Qwen 3.8 Cloud · Prompt Editor";
        const close = modalDocument.createElement("button");
        close.type = "button";
        close.className = "krea2-history-icon";
        close.textContent = "×";
        close.setAttribute("aria-label", "Close Qwen Prompt Editor");
        head.append(heading, close);

        const body = modalDocument.createElement("div");
        body.className = "krea2-history-dialog-body krea2-prompt-editor-body";
        const explanation = modalDocument.createElement("div");
        explanation.className = "krea2-prompt-editor-explanation";
        explanation.textContent = "Paste a KREA2 prompt, then describe the change you want—pose, outfit, camera, lighting, setting, wording, or anything else. Qwen preserves details you did not ask to change. Each successful reply costs 1 Online API credit; failures are refunded. This conversation is sent to the private cloud model for inference and is not stored by the KREA2 gateway. A recovery draft stays only in this running Discord session until you choose New chat or reload the plugin.";

        const promptField = modalDocument.createElement("div");
        promptField.className = "krea2-prompt-editor-field";
        const promptLabel = modalDocument.createElement("label");
        promptLabel.textContent = "Current KREA2 prompt";
        const promptBox = modalDocument.createElement("textarea");
        promptBox.className = "krea2-prompt-editor-prompt";
        promptBox.placeholder = "Paste the prompt you want to revise…";
        promptBox.maxLength = 18000;
        promptBox.value = suppliedPrompt || String(restoredDraft?.prompt || "").slice(0, 18000);
        promptField.append(promptLabel, promptBox);

        const transcript = modalDocument.createElement("div");
        transcript.className = "krea2-prompt-editor-transcript";
        transcript.setAttribute("aria-live", "polite");

        const compose = modalDocument.createElement("div");
        compose.className = "krea2-prompt-editor-compose";
        const instructionField = modalDocument.createElement("div");
        instructionField.className = "krea2-prompt-editor-field";
        const instructionLabel = modalDocument.createElement("label");
        instructionLabel.textContent = "What should Qwen change?";
        const instruction = modalDocument.createElement("textarea");
        instruction.className = "krea2-prompt-editor-instruction";
        instruction.placeholder = "Example: Keep everything else, but turn her head toward the camera and make the lighting warmer.";
        instruction.maxLength = 3000;
        instruction.value = String(restoredDraft?.instruction || "").slice(0, 3000);
        instructionField.append(instructionLabel, instruction);
        const send = modalDocument.createElement("button");
        send.type = "button";
        send.className = "krea2-prompt-editor-send";
        send.textContent = "Send to Qwen";
        compose.append(instructionField, send);
        const status = modalDocument.createElement("div");
        status.className = "krea2-prompt-editor-status";
        status.textContent = String(restoredDraft?.statusText || "Ready · 1 credit is charged only after a successful reply.");
        status.dataset.state = String(restoredDraft?.statusState || "idle");
        body.append(explanation, promptField, transcript, compose, status);

        const actions = modalDocument.createElement("div");
        actions.className = "krea2-history-dialog-actions";
        const clear = modalDocument.createElement("button");
        clear.type = "button";
        clear.className = "krea2-history-action";
        clear.textContent = "New chat";
        const copyPrompt = modalDocument.createElement("button");
        copyPrompt.type = "button";
        copyPrompt.className = "krea2-history-action";
        copyPrompt.dataset.primary = "true";
        copyPrompt.textContent = "Copy current prompt";
        const done = modalDocument.createElement("button");
        done.type = "button";
        done.className = "krea2-history-action";
        done.textContent = "Close";
        actions.append(clear, copyPrompt, done);
        dialog.append(head, body, actions);
        overlay.append(dialog);
        modalDocument.body.append(overlay);

        const syncDraft = () => {
            this.promptEditorDraft = {
                prompt: promptBox.value.slice(0, promptBox.maxLength),
                instruction: instruction.value.slice(0, instruction.maxLength),
                messages: messages.map(message => ({role: message.role, content: message.content})),
                turns: turns.map(turn => ({role: turn.role, text: turn.text})),
                latestReply,
                statusText: status.textContent,
                statusState: status.dataset.state || "idle"
            };
        };
        const setStatus = (text, state = "idle") => {
            status.textContent = text;
            status.dataset.state = state;
            syncDraft();
        };
        const appendTurn = (role, text, record = true) => {
            if (record) turns.push({role, text: String(text)});
            const turn = modalDocument.createElement("div");
            turn.className = "krea2-prompt-editor-turn";
            turn.dataset.role = role;
            const copy = modalDocument.createElement("div");
            copy.textContent = text;
            turn.append(copy);
            if (role === "assistant") {
                const turnActions = modalDocument.createElement("div");
                turnActions.className = "krea2-prompt-editor-turn-actions";
                const use = modalDocument.createElement("button");
                use.type = "button";
                use.textContent = "Use as current prompt";
                use.addEventListener("click", () => {
                    promptBox.value = text.slice(0, promptBox.maxLength);
                    latestReply = text;
                    setStatus("Qwen reply is now the current prompt.", "success");
                });
                const copyReply = modalDocument.createElement("button");
                copyReply.type = "button";
                copyReply.textContent = "Copy reply";
                copyReply.addEventListener("click", async () => {
                    try {
                        await (modalDocument.defaultView?.navigator || navigator).clipboard.writeText(text);
                        copyReply.textContent = "Copied";
                        setTimeout(() => { if (copyReply.isConnected) copyReply.textContent = "Copy reply"; }, 1200);
                    }
                    catch { this.toast("Discord could not copy the Qwen reply.", "error"); }
                });
                turnActions.append(use, copyReply);
                turn.append(turnActions);
            }
            transcript.append(turn);
            transcript.scrollTop = transcript.scrollHeight;
        };
        const cleanup = () => {
            if (busy) {
                status.textContent = "The in-flight edit was cancelled; your prompt and typed instruction were recovered.";
                status.dataset.state = "idle";
            }
            syncDraft();
            controller.abort();
            modalDocument.removeEventListener("keydown", onKey, true);
            overlay.remove();
            if (this.promptEditorCleanup === cleanup) this.promptEditorCleanup = null;
        };
        const onKey = event => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopImmediatePropagation?.();
                cleanup();
            }
            else if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !busy) {
                event.preventDefault();
                void submit();
            }
        };
        this.promptEditorCleanup = cleanup;
        modalDocument.addEventListener("keydown", onKey, true);
        close.addEventListener("click", cleanup);
        done.addEventListener("click", cleanup);
        overlay.addEventListener("click", event => { if (event.target === overlay) cleanup(); });
        clear.addEventListener("click", () => {
            messages = [];
            turns = [];
            latestReply = "";
            transcript.replaceChildren();
            instruction.value = "";
            setStatus("New session started. The current prompt is still available above.");
            instruction.focus();
        });
        promptBox.addEventListener("input", syncDraft);
        instruction.addEventListener("input", syncDraft);
        copyPrompt.addEventListener("click", async () => {
            const value = promptBox.value.trim() || latestReply;
            if (!value) return setStatus("Paste or generate a prompt first.", "error");
            try {
                await (modalDocument.defaultView?.navigator || navigator).clipboard.writeText(value);
                copyPrompt.textContent = "Copied";
                setTimeout(() => { if (copyPrompt.isConnected) copyPrompt.textContent = "Copy current prompt"; }, 1200);
            }
            catch { this.toast("Discord could not copy the current prompt.", "error"); }
        });

        const submit = async () => {
            if (busy) return;
            const currentPrompt = promptBox.value.trim();
            const request = instruction.value.trim();
            if (currentPrompt.length < 20) return setStatus("Paste a complete KREA2 prompt first.", "error");
            if (request.length < 2) return setStatus("Describe the change you want Qwen to make.", "error");
            if (messages.length >= 14) {
                messages = [];
                turns = [];
                transcript.replaceChildren();
                setStatus("The long chat was compacted around the current prompt.");
            }
            const userContent = messages.length
                ? request
                : `Current KREA2 prompt:\n\n${currentPrompt}\n\nRequested revision:\n${request}`;
            messages.push({role: "user", content: userContent});
            appendTurn("user", request);
            instruction.value = "";
            busy = true;
            send.disabled = true;
            clear.disabled = true;
            send.textContent = "Qwen is working…";
            setStatus("Connecting to Qwen 3.8 Cloud. A cold worker may take a little longer…");
            try {
                const result = await this.requestPromptChat(messages, controller.signal);
                const reply = result.reply;
                messages.push({role: "assistant", content: reply});
                latestReply = reply;
                appendTurn("assistant", reply);
                setStatus(`Reply complete · 1 credit used · ${result.availableCredits} credits remaining.`, "success");
            }
            catch (error) {
                messages.pop();
                if (error?.name !== "AbortError") setStatus(error instanceof Error ? error.message : String(error), "error");
            }
            finally {
                busy = false;
                send.disabled = false;
                clear.disabled = false;
                send.textContent = "Send to Qwen";
            }
        };
        send.addEventListener("click", () => void submit());
        for (const turn of turns.slice()) appendTurn(turn.role, turn.text, false);
        syncDraft();
        (promptBox.value ? instruction : promptBox).focus();
    }

    openVerifiedExternal(rawUrl, purpose) {
        const checked = filterExternalUrl(rawUrl, purpose);
        if (!checked.ok) throw new Error(checked.error);
        // Do not depend on Discord's private, frequently renamed Webpack
        // modules for a basic browser launch.  The allowlist above is the
        // security boundary; the standard browser API is stable in Discord's
        // renderer and lets Discord/Electron apply its normal external-link
        // handling.
        if (typeof window?.open !== "function") {
            throw new Error("Discord cannot open a browser window in this client.");
        }
        window.open(checked.url, "_blank", "noopener,noreferrer");
    }

    async ensureRemoteLicense(signal) {
        const saved = this.settings.remoteLicense;
        if (
            saved
            && Number(saved.authVersion) === 2
            && /^lic_[A-Za-z0-9_-]{12,64}$/.test(String(saved.licenseId || ""))
            && /^[\x21-\x7e]{43,160}$/.test(String(saved.licenseToken || ""))
            && /^[1-9][0-9]{16,21}$/.test(String(saved.discordUserId || ""))
            && String(saved.discordUsername || "").trim().length > 0
        ) return saved;
        let installationId = String(this.api.Data.load("remoteVisionInstallationId") || "");
        if (!/^[A-Za-z0-9_-]{24,128}$/.test(installationId)) {
            installationId = base64Url(randomBytes(32));
            this.api.Data.save("remoteVisionInstallationId", installationId);
        }
        const enrollmentId = `enr_${base64Url(randomBytes(32))}`;
        const enrollmentSecret = base64Url(randomBytes(48));
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
        const approvedAuthorizeUrl = filterExternalUrl(authorizeUrl, "discord-oauth");
        if (!approvedAuthorizeUrl.ok || !approvedAuthorizeUrl.url.includes("?") || String(issued?.enrollment_id || "") !== enrollmentId) throw new Error("The Online API Discord sign-in service returned an invalid authorization link.");
        const accepted = await this.confirmRemoteOAuth();
        if (!accepted) throw new Error("Discord sign-in was cancelled. Local GPU mode remains available without an account.");
        try {
            this.openVerifiedExternal(approvedAuthorizeUrl.url, "discord-oauth");
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
            const license = Object.freeze({
                authVersion: 2,
                licenseId: String(status?.license_id || ""),
                licenseToken: String(status?.license_token || ""),
                discordUserId: String(status?.discord_user_id || ""),
                discordUsername: String(status?.discord_username || "").trim().slice(0,80)
            });
            if (
                !/^lic_[A-Za-z0-9_-]{12,64}$/.test(license.licenseId)
                || !/^[\x21-\x7e]{43,160}$/.test(license.licenseToken)
                || !/^[1-9][0-9]{16,21}$/.test(license.discordUserId)
                || !license.discordUsername
            ) throw new Error("The Online API Discord sign-in service returned invalid credentials.");
            this.settings.remoteLicense = license;
            this.saveSettings();
            return license;
        }
        throw new Error("Discord sign-in timed out. Start Online API again.");
    }

    async remoteCreditStatus(license, signal, purpose = "image") {
        const fetchStatus = async cacheBust => {
            let response;
            try {
                const suffix = cacheBust ? `?contract=prompt-chat-v1&nonce=${Date.now()}` : "";
                response = await this.api.Net.fetch(`${REMOTE_GATEWAY_URL}/v1/credits/balance${suffix}`, {
                    method: "GET", redirect: "manual", maxRedirects: 0, timeout: 15000, signal,
                    headers: {
                        Accept: "application/json",
                        "Cache-Control": "no-cache",
                        Authorization: `Krea2License ${license.licenseId}.${license.licenseToken}`
                    }
                });
            }
            catch { throw new Error("The Online API credit service is unavailable. Retry shortly; no credits were charged."); }
            const text = await readBoundedResponseText(response, 64 * 1024);
            let status;
            try { status = JSON.parse(text); }
            catch { throw new Error("The Online API credit service returned invalid JSON; no credits were charged."); }
            if (!response.ok) throw new Error(String(status?.detail || `Online API credit check failed with HTTP ${response.status}.`));
            return status;
        };

        let status = await fetchStatus(false);
        const validImageBalance = value => (
            Number.isInteger(value?.available_credits)
            && value.available_credits >= 0
            && Number.isInteger(value?.credits_per_image)
            && value.credits_per_image === 3
        );
        if (!validImageBalance(status)) {
            throw new Error("The Online API credit service returned an incomplete image balance; retry shortly. No credits were charged.");
        }

        if (purpose === "prompt-chat" || purpose === "region-inpaint") {
            const validPromptBalance = value => (
                Number.isInteger(value?.credits_per_prompt_chat)
                && value.credits_per_prompt_chat === 1
                && Number.isInteger(value?.prompt_chat_turns_available)
                && value.prompt_chat_turns_available >= 0
            );
            if (!validPromptBalance(status)) status = await fetchStatus(true);
            if (!validImageBalance(status) || !validPromptBalance(status)) {
                throw new Error("Qwen Prompt Editor credit information is still updating. Retry shortly; no credit was charged.");
            }
        }
        return status;
    }

    async ensureRemoteCredits(signal, purpose = "image") {
        const license = await this.ensureRemoteLicense(signal);
        const promptChat = purpose === "prompt-chat";
        const regionInpaint = purpose === "region-inpaint";
        let status = await this.remoteCreditStatus(license, signal, purpose);
        const required = regionInpaint
            ? status.credits_per_image + status.credits_per_prompt_chat
            : promptChat
                ? status.credits_per_prompt_chat
                : status.credits_per_image;
        if (status.available_credits >= required) {
            this.toast(remotePreflightSummary(status, purpose).text, "info");
            return license;
        }
        if (!status.payments_configured) throw new Error("Online API credits are exhausted and Bitcoin checkout is not configured yet. Retry later.");
        const accepted = await this.confirmCreditPurchase(status, purpose);
        if (!accepted) throw new Error("Online API credits are required. Purchase credits to continue.");
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
        const approvedCheckoutUrl = filterExternalUrl(checkoutUrl, "checkout");
        if (!approvedCheckoutUrl.ok) throw new Error("Bitcoin checkout returned an invalid payment link.");
        try {
            this.openVerifiedExternal(approvedCheckoutUrl.url, "checkout");
        }
        catch { throw new Error("Could not open Bitcoin checkout. Allow Discord to open links, then retry."); }
        const deadline = Date.now() + 30 * 60 * 1000;
        while (Date.now() < deadline) {
            if (signal?.aborted) throw new Error("Bitcoin payment wait was cancelled.");
            await new Promise(resolve => setTimeout(resolve, 4000));
            status = await this.remoteCreditStatus(license, signal, purpose);
            if (status.available_credits >= required) {
                this.toast(`Online API credits added: ${status.available_credits} available.`, "success");
                this.toast(remotePreflightSummary(status, purpose).text, "info");
                return license;
            }
        }
        throw new Error("Bitcoin payment is still awaiting settlement. Credits will appear automatically after the invoice settles.");
    }

    confirmCreditPurchase(status, purpose = "image") {
        return new Promise(resolve => {
            const content = document.createElement("div");
            content.style.cssText = "line-height:1.55;color:var(--text-normal)";
            const lead = document.createElement("p");
            const promptChat = purpose === "prompt-chat";
            const regionInpaint = purpose === "region-inpaint";
            lead.textContent = regionInpaint
                ? `Online region inpaint needs 4 credits: 3 for the selected-region Vision inspection and 1 for the successful Qwen rewrite. You have ${status.available_credits} credits remaining.`
                : promptChat
                ? `Qwen Prompt Editor needs 1 credit per successful reply. You have ${status.available_credits} credits remaining.`
                : `Online API needs 3 credits per image. You have ${status.available_credits} credits remaining.`;
            const detail = document.createElement("p");
            detail.textContent = regionInpaint
                ? "Purchase 1,200 credits for $20 USD paid in Bitcoin. A failed Vision inspection refunds its 3-credit reservation, and a failed Qwen rewrite refunds its separate 1-credit reservation."
                : promptChat
                ? "Purchase 1,200 credits for $20 USD paid in Bitcoin. That covers 1,200 successful Prompt Editor replies; a failed reply is automatically refunded."
                : "Purchase 1,200 credits for $20 USD paid in Bitcoin. That covers 400 successful images; a failed or cancelled image is automatically refunded.";
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
                remote_discord_user_id: remoteLicense?.discordUserId || "",
                remote_discord_username: remoteLicense?.discordUsername || "",
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

    queueOperationalError({eventId = "", modelId = "", errorCode = "operational_error", errorMessage = "", stage = "", technicalTrace = ""} = {}) {
        const normalizedEvent = /^[a-f0-9]{32}$/.test(String(eventId || "")) ? String(eventId) : randomBytes(16).toString("hex");
        const item = {
            event_id: normalizedEvent,
            model_id: String(modelId || effectiveVisionModel(this.settings)).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200) || "unknown",
            error_code: String(errorCode || "operational_error").replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 80) || "operational_error",
            error_message: String(errorMessage || "Unspecified operational error").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 2000),
            stage: String(stage || "KREA2 Vision operation").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200),
            technical_trace: String(technicalTrace || "No plugin traceback was supplied.")
                .replace(/\u0000/g, "")
                .replace(/\r\n?/g, "\n")
                .slice(0, 131072)
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

    async submitOperationalErrorWebhookDirect(item) {
        const license = this.settings?.remoteLicense;
        if (
            !license
            || !/^lic_[A-Za-z0-9_-]{12,64}$/.test(String(license.licenseId || ""))
            || !/^[\x21-\x7e]{43,160}$/.test(String(license.licenseToken || ""))
        ) return false;
        const response = await this.api.Net.fetch(`${REMOTE_GATEWAY_URL}/v1/audit/error`, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: `Krea2License ${license.licenseId}.${license.licenseToken}`
            },
            body: JSON.stringify({...item, pipeline_id: VISION_PIPELINE_ID, runtime: String(item.model_id || "").startsWith("vast::") ? "remote" : "local", plugin_version: PLUGIN_VERSION, backend_version: "unavailable"}),
            redirect: "manual",
            maxRedirects: 0,
            timeout: 12000
        });
        if (response.redirected || (response.url && response.url !== `${REMOTE_GATEWAY_URL}/v1/audit/error`) || !response.ok) return false;
        const raw = await readBoundedResponseText(response, 64 * 1024);
        try { return JSON.parse(raw)?.accepted === true; }
        catch { return false; }
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
                    const license = this.settings?.remoteLicense;
                    const remoteHeaders = (
                        license
                        && /^lic_[A-Za-z0-9_-]{12,64}$/.test(String(license.licenseId || ""))
                        && /^[\x21-\x7e]{43,160}$/.test(String(license.licenseToken || ""))
                    ) ? {
                        "X-Krea2-Remote-License-Id": license.licenseId,
                        "X-Krea2-Remote-License-Token": license.licenseToken
                    } : {};
                    const response = await this.api.Net.fetch(expectedUrl, {
                        method: "POST",
                        headers: {
                            Accept: "application/json",
                            "Content-Type": "application/json",
                            "X-Krea2-Collector-Version": PLUGIN_VERSION,
                            "X-Krea2-Vision-Token": vision.token,
                            ...remoteHeaders
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
                    try { accepted = await this.submitOperationalErrorWebhookDirect(item); }
                    catch { accepted = false; }
                }
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

        let plusButton = this.buttonByImage.get(image);
        if (!plusButton?.isConnected) {
            plusButton = document.createElement("button");
            plusButton.type = "button";
            plusButton.className = BUTTON_CLASS;
            plusButton.textContent = "+";
            plusButton.dataset.state = "idle";
            plusButton.dataset.sourceKey = provenance?.path || "";
            plusButton.title = "Extract an embedded or same-message parameters YAML prompt (no GPU, credits, dataset submission, or automatic save)";
            plusButton.setAttribute("aria-label", plusButton.title);
            plusButton.__krea2Image = image;
            plusButton.addEventListener("pointerdown", blockNavigation);
            plusButton.addEventListener("dblclick", blockNavigation);
            plusButton.addEventListener("click", event => {
                blockNavigation(event);
                this.queueMetadataProbe(image, plusButton);
            });
            host.append(plusButton);
            this.buttons.add(plusButton);
            this.buttonByImage.set(image, plusButton);
        }
        plusButton.style.left = `${Math.max(0, imageRect.left - hostRect.left + 6)}px`;
        plusButton.style.top = `${Math.max(0, imageRect.top - hostRect.top + 6)}px`;

        let visionButton = this.visionButtonByImage.get(image);
        if (!visionButton?.isConnected) {
            visionButton = document.createElement("button");
            visionButton.type = "button";
            visionButton.className = VISION_BUTTON_CLASS;
            visionButton.textContent = "🔍";
            visionButton.dataset.state = "idle";
            visionButton.dataset.sourceKey = provenance?.path || "";
            visionButton.title = "Get the source prompt from metadata, or describe with KREA2 Vision only when no usable prompt exists";
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

    metadataCompanionForMessage(messageRoot, imageProvenance, route) {
        const messageId = messageIdFromRoot(messageRoot);
        if (!messageId || !route?.channelId) return {status: "none", reason: "message_identity_unavailable"};
        this.messageStore ||= this.api?.Webpack?.getStore?.("MessageStore") || null;
        let message = null;
        try { message = this.messageStore?.getMessage?.(route.channelId, messageId) || null; }
        catch { message = null; }
        if (!message) return {status: "none", reason: "message_record_unavailable"};

        const selected = selectCompanionMetadataAttachment(imageProvenance, message.attachments);
        if (selected.status !== "found") return selected;
        const provenance = extractMediaProvenance(selected.attachment.url);
        if (
            !provenance
            || provenance.attachmentId !== selected.attachment.id
            || provenance.attachmentChannelId !== imageProvenance.attachmentChannelId
            || !this.attachmentBelongsToGuild(provenance, route.guildId)
        ) return {status: "none", reason: "yaml_attachment_provenance_unverified"};
        return {
            status: "found",
            reason: selected.reason,
            attachment: Object.freeze({...selected.attachment}),
            provenance: Object.freeze({...provenance})
        };
    }

    captureMetadataSelection(image) {
        if (!image?.isConnected) throw new Error("The selected Discord image is no longer connected.");
        const route = this.validateLocalCollectionSettings();
        const messageRoot = findMessageRoot(image);
        const sourceUrlAtClick = recoverOriginalImageUrl(image);
        const provenance = extractMediaProvenance(sourceUrlAtClick);
        if (!messageRoot || !provenance || !this.attachmentBelongsToGuild(provenance, route.guildId)) {
            throw new Error("The image attachment could not be verified in the allowlisted Discord server.");
        }
        const companion = this.metadataCompanionForMessage(messageRoot, provenance, route);
        return Object.freeze({
            sourceUrlAtClick,
            provenance: Object.freeze({...provenance}),
            messageId: messageIdFromRoot(messageRoot),
            route: Object.freeze({...route}),
            companion: Object.freeze(companion)
        });
    }

    async downloadMetadataOriginal(selection, button, signal) {
        const cached = this.getCachedOriginal(selection.provenance);
        if (cached) return cached;
        this.setButtonState(button, "downloading", "…", "Reading the original image metadata locally");
        const sourceUrl = selection.sourceUrl || selection.sourceUrlAtClick;
        const response = await this.api.Net.fetch(sourceUrl, {
            method: "GET",
            headers: {Accept: "image/*,application/octet-stream;q=0.8"},
            redirect: "follow",
            signal,
            timeout: 60000
        });
        if (!response.ok) throw new Error(`Image metadata download failed with HTTP ${response.status}.`);
        const finalProvenance = extractMediaProvenance(response.url || sourceUrl);
        if (!sameMediaProvenance(finalProvenance, selection.provenance)) {
            throw new Error("The image redirect changed attachment identity; metadata was not inspected.");
        }
        const bytes = await readResponseBytes(response, null, MAX_IMAGE_BYTES);
        if (!bytes.byteLength) throw new Error("The downloaded image was empty.");
        const format = detectImageFormat(bytes);
        if (!format) throw new Error("The downloaded bytes are not a supported image format.");
        const original = {bytes, sha256: sha256Hex(bytes), format};
        this.cacheOriginal(selection.provenance, original);
        return original;
    }

    async downloadCompanionMetadata(selection, signal) {
        if (selection.companion?.status !== "found") return null;
        const {attachment, provenance} = selection.companion;
        if (attachment.size && attachment.size > MAX_METADATA_SIDECAR_BYTES) {
            return {classification: "encoded_or_unknown", source: attachment.filename};
        }
        const response = await this.api.Net.fetch(attachment.url, {
            method: "GET",
            headers: {Accept: "text/yaml,text/x-yaml,text/plain,application/octet-stream;q=0.8"},
            redirect: "follow",
            signal,
            timeout: 30000
        });
        if (!response.ok) throw new Error(`YAML metadata download failed with HTTP ${response.status}.`);
        const finalProvenance = extractMediaProvenance(response.url || attachment.url);
        if (!sameMediaProvenance(finalProvenance, provenance)) {
            throw new Error("The YAML redirect changed attachment identity; it was not parsed.");
        }
        const contentType = String(response.headers?.get?.("content-type") || "");
        if (/^(?:text\/html|application\/(?:xml|xhtml\+xml))/i.test(contentType)) {
            throw new Error("The YAML attachment URL returned a webpage instead of metadata text.");
        }
        const bytes = await readResponseBytes(response, null, MAX_METADATA_SIDECAR_BYTES);
        let text;
        try { text = new TextDecoder("utf-8", {fatal: true}).decode(bytes); }
        catch { return {classification: "encoded_or_unknown", source: attachment.filename}; }
        if (/\u0000/.test(text)) return {classification: "encoded_or_unknown", source: attachment.filename};
        return {...evaluatePromptValue(text), source: attachment.filename};
    }

    async inspectPromptMetadata(selection, button, signal) {
        let original = null;
        let embedded = {classification: "no_metadata", chunks: []};
        try {
            original = await this.downloadMetadataOriginal(selection, button, signal);
            try { embedded = await extractConfidentPrompt(original.bytes, original.format); }
            catch { embedded = {classification: "encoded_or_unknown", chunks: []}; }
        }
        catch (error) {
            if (error?.name === "AbortError") throw error;
            embedded = {classification: "encoded_or_unknown", chunks: []};
        }

        let sidecar = null;
        try { sidecar = await this.downloadCompanionMetadata(selection, signal); }
        catch (error) {
            if (error?.name === "AbortError") throw error;
            sidecar = {
                classification: "encoded_or_unknown",
                source: selection.companion?.attachment?.filename || "same-message YAML"
            };
        }
        const decision = selectMetadataPromptCandidates(
            embedded,
            sidecar,
            selection.companion?.status || "none"
        );
        return {...decision, original, embedded, sidecar};
    }

    async inspectPromptMetadataBounded(selection, button, parentSignal) {
        const controller = new AbortController();
        const abortFromParent = () => controller.abort();
        if (parentSignal?.aborted) abortFromParent();
        else parentSignal?.addEventListener?.("abort", abortFromParent, {once: true});
        const timeoutMs = Math.max(1, Number(this.metadataPreflightTimeoutMs) || METADATA_PREFLIGHT_TIMEOUT_MS);
        let timer = null;
        let timedOut = false;
        const timeoutResult = {
            status: "none",
            classification: "metadata_timeout",
            prompts: [],
            original: null,
            embedded: {classification: "encoded_or_unknown", chunks: []},
            sidecar: null,
            timedOut: true
        };
        const timeout = new Promise(resolve => {
            timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
                resolve(timeoutResult);
            }, timeoutMs);
        });
        try {
            const result = await Promise.race([
                this.inspectPromptMetadata(selection, button, controller.signal),
                timeout
            ]);
            if (parentSignal?.aborted) {
                const error = new Error("Metadata inspection was cancelled.");
                error.name = "AbortError";
                throw error;
            }
            return result;
        }
        catch (error) {
            if (timedOut && error?.name === "AbortError") return timeoutResult;
            throw error;
        }
        finally {
            if (timer) clearTimeout(timer);
            parentSignal?.removeEventListener?.("abort", abortFromParent);
        }
    }

    showMetadataPromptModal(promptOrCandidates, source = "source metadata") {
        const candidates = (Array.isArray(promptOrCandidates)
            ? promptOrCandidates
            : [{prompt: promptOrCandidates, source}]
        ).map(candidate => ({
            prompt: String(candidate?.prompt || "").trim(),
            source: String(candidate?.source || source || "source metadata").trim()
        })).filter(candidate => candidate.prompt);
        if (!candidates.length) return;

        this.sourcePromptModalCleanup?.();
        const modalDocument = this.historyRoot?.ownerDocument || document;
        modalDocument.getElementById(SOURCE_PROMPT_MODAL_ID)?.remove();
        const overlay = modalDocument.createElement("div");
        overlay.id = SOURCE_PROMPT_MODAL_ID;
        overlay.setAttribute("role", "presentation");
        const dialog = modalDocument.createElement("section");
        dialog.className = "krea2-history-dialog";
        dialog.dataset.sourcePrompt = "true";
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-label", "Source prompt found");
        const head = modalDocument.createElement("div");
        head.className = "krea2-history-dialog-head";
        const heading = modalDocument.createElement("h2");
        heading.textContent = "Source prompt found";
        const closeIcon = modalDocument.createElement("button");
        closeIcon.type = "button";
        closeIcon.className = "krea2-history-icon";
        closeIcon.textContent = "×";
        closeIcon.setAttribute("aria-label", "Close source prompt");
        head.append(heading, closeIcon);
        const content = modalDocument.createElement("div");
        content.className = "krea2-history-dialog-body krea2-source-prompt-body";
        const explanation = modalDocument.createElement("p");
        explanation.className = "krea2-source-prompt-explanation";
        explanation.textContent = candidates.length === 1
            ? `Exact positive prompt extracted from ${candidates[0].source}. No Vision model ran, no credits were used, and nothing was submitted or saved.`
            : "Multiple distinct source prompts were found. They are shown separately instead of guessing. No Vision model ran, no credits were used, and nothing was submitted or saved.";
        const tabs = modalDocument.createElement("div");
        tabs.className = "krea2-product-tabs";
        tabs.setAttribute("role", "tablist");
        const textarea = modalDocument.createElement("textarea");
        textarea.className = "krea2-history-prompt";
        textarea.readOnly = true;
        textarea.setAttribute("aria-label", "Extracted source prompt");
        const actions = modalDocument.createElement("div");
        actions.className = "krea2-history-dialog-actions";
        const close = modalDocument.createElement("button");
        close.type = "button";
        close.className = "krea2-history-action";
        close.textContent = "Close";
        const copy = modalDocument.createElement("button");
        copy.type = "button";
        copy.className = "krea2-history-action";
        copy.dataset.primary = "true";
        const edit = modalDocument.createElement("button");
        edit.type = "button";
        edit.className = "krea2-history-action";
        edit.textContent = "✦ Edit with Qwen";
        let selectedIndex = 0;
        const selectPrompt = index => {
            selectedIndex = index;
            textarea.value = candidates[index].prompt;
            textarea.rows = Math.min(18, Math.max(8, Math.ceil(textarea.value.length / 90)));
            copy.textContent = candidates.length === 1 ? "Copy prompt" : `Copy prompt ${index + 1}`;
            for (const [buttonIndex, tab] of [...tabs.children].entries()) {
                tab.setAttribute("aria-selected", buttonIndex === index ? "true" : "false");
            }
        };
        candidates.forEach((candidate, index) => {
            const tab = modalDocument.createElement("button");
            tab.type = "button";
            tab.className = "krea2-product-tab";
            tab.setAttribute("role", "tab");
            tab.textContent = candidates.length === 1
                ? "Prompt"
                : `Prompt ${index + 1} · ${candidate.source === "embedded image metadata" ? "Embedded" : candidate.source.slice(0, 42)}`;
            tab.addEventListener("click", () => selectPrompt(index));
            tabs.append(tab);
        });
        selectPrompt(0);
        content.append(explanation);
        if (candidates.length > 1) content.append(tabs);
        content.append(textarea);
        actions.append(close, edit, copy);
        dialog.append(head, content, actions);
        overlay.append(dialog);
        modalDocument.body.append(overlay);
        const cleanup = () => {
            modalDocument.removeEventListener("keydown", onKey);
            overlay.remove();
            if (this.sourcePromptModalCleanup === cleanup) this.sourcePromptModalCleanup = null;
        };
        const onKey = event => { if (event.key === "Escape") cleanup(); };
        this.sourcePromptModalCleanup = cleanup;
        closeIcon.addEventListener("click", cleanup);
        close.addEventListener("click", cleanup);
        overlay.addEventListener("click", event => { if (event.target === overlay) cleanup(); });
        copy.addEventListener("click", async () => {
            await this.copyProductText(candidates[selectedIndex].prompt, modalDocument);
            copy.textContent = "Copied";
            setTimeout(() => {
                if (copy.isConnected) copy.textContent = candidates.length === 1 ? "Copy prompt" : `Copy prompt ${selectedIndex + 1}`;
            }, 1400);
        });
        edit.addEventListener("click", () => this.openPromptEditor(candidates[selectedIndex].prompt, modalDocument));
        modalDocument.addEventListener("keydown", onKey);
        closeIcon.focus();
        return overlay;
    }

    queueMetadataProbe(image, button) {
        if (!this.running || !image?.isConnected || !button?.isConnected || button.dataset?.busy === "true") return;
        let selection;
        try { selection = this.captureMetadataSelection(image); }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.setButtonState(button, "error", "!", `${message} Click to retry.`);
            this.toast(message, "error");
            return;
        }
        const key = metadataProbeCacheKey(selection.provenance);
        if (!key) return;
        button.dataset.busy = "true";
        this.setButtonState(button, "hashing", "…", "Checking embedded metadata and same-message YAML");
        const queuedGeneration = this.generation;
        const flow = (async () => {
            if (!this.running || queuedGeneration !== this.generation || !button.isConnected) return;
            const controller = new AbortController();
            this.controllers.add(controller);
            try {
                const inspected = await this.inspectPromptMetadataBounded(selection, button, controller.signal);
                if (inspected.status === "usable") {
                    this.showMetadataPromptModal(inspected.prompts);
                    const sourceSummary = inspected.prompts.length === 1
                        ? inspected.prompts[0].source
                        : `${inspected.prompts.length} source metadata records`;
                    this.setButtonState(button, "done", "✓", `Prompt extracted from ${sourceSummary}; no GPU, credits, submission, or automatic save. Click again to reopen.`);
                    this.toast("Source prompt extracted locally. No GPU or credits were used.", "success");
                    if (inspected.original?.sha256) {
                        this.recordDiagnosticSummary(inspected.original.sha256, "usable", [
                            ...(inspected.embedded.chunks || []),
                            ...(inspected.sidecar ? [{name: "YAML", size: selection.companion?.attachment?.size || 0}] : [])
                        ]);
                    }
                    return;
                }
                this.showClassification(button, inspected.classification);
                if (inspected.original?.sha256) {
                    this.recordDiagnosticSummary(inspected.original.sha256, inspected.classification, inspected.embedded.chunks || []);
                }
            }
            catch (error) {
                if (!this.running || queuedGeneration !== this.generation || error?.name === "AbortError") return;
                const message = error instanceof Error ? error.message : String(error);
                this.setButtonState(button, "error", "!", `${message} Click to retry.`);
                this.toast(message, "error");
                this.log("error", message);
            }
            finally {
                this.controllers.delete(controller);
                this.metadataProbeByKey.delete(key);
                if (button) button.dataset.busy = "false";
            }
        })();
        this.metadataProbeByKey.set(key, flow);
        this.metadataProbeQueue = flow.catch(() => {});
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
        const messageRoot = findMessageRoot(image);
        const companion = this.metadataCompanionForMessage(messageRoot, provenance, config);
        return Object.freeze({
            sourceUrlAtClick,
            provenance: Object.freeze({...provenance}),
            messageId: messageIdFromRoot(messageRoot),
            companion: Object.freeze({...companion}),
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
            companion: selection.companion,
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
                visionExecutionMode: normalizeVisionExecutionMode(this.settings.visionExecutionMode),
                visionAnalysisProfile: normalizeVisionAnalysisProfile(this.settings.visionAnalysisProfile),
                visionPromptCount: effectiveVisionPromptCount(this.settings, this.settings.visionAnalysisProfile)
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
        button.dataset.busy = "true";
        this.setButtonState(button, "hashing", "…", "Checking embedded metadata and same-message YAML before Vision");

        const probe = (async () => {
            if (!this.running || queuedGeneration !== this.generation || !button?.isConnected) {
                return {status: "cancelled"};
            }
            const controller = new AbortController();
            this.controllers.add(controller);
            try {
                const resolvedSelection = this.resolveQueuedVisionSelection(image, selection);
                const inspected = await this.inspectPromptMetadataBounded(resolvedSelection, button, controller.signal);
                return {status: "inspected", inspected};
            }
            finally {
                this.controllers.delete(controller);
            }
        })();
        this.metadataProbeQueue = probe.catch(() => {});

        const completion = probe.then(result => {
            if (result.status === "cancelled") {
                if (button) button.dataset.busy = "false";
                return result;
            }
            const inspected = result.inspected;
            if (inspected.status === "usable") {
                this.showMetadataPromptModal(inspected.prompts);
                const sourceSummary = inspected.prompts.length === 1
                    ? inspected.prompts[0].source
                    : `${inspected.prompts.length} source metadata records`;
                this.setButtonState(button, "done", "✓", `Prompt extracted from ${sourceSummary}; Vision was not queued and no credits were used. Click again to reopen.`);
                this.toast("Source prompt found locally. Vision was skipped and no credits were used.", "success");
                if (inspected.original?.sha256) {
                    this.recordDiagnosticSummary(inspected.original.sha256, "usable", [
                        ...(inspected.embedded.chunks || []),
                        ...(inspected.sidecar ? [{name: "YAML", size: selection.companion?.attachment?.size || 0}] : [])
                    ]);
                }
                button.dataset.busy = "false";
                return {status: "metadata", prompts: inspected.prompts};
            }
            if (inspected.timedOut) {
                this.toast("Source metadata check reached its 8-second limit; continuing to Vision now.", "warning");
            }
            return this.enqueueVisionAnalysisAfterMetadata(image, button, selection, queuedGeneration);
        }).catch(error => {
            if (!this.running || queuedGeneration !== this.generation || error?.name === "AbortError") return;
            const message = error instanceof Error ? error.message : String(error);
            this.setButtonState(button, "error", "!", `${message} Vision was not queued and no credits were used. Click to retry.`);
            this.toast(message, "error");
            this.log("error", message);
            if (button) button.dataset.busy = "false";
        });
        return completion;
    }

    enqueueVisionAnalysisAfterMetadata(image, button, selection, queuedGeneration = this.generation) {
        const localSubmissionId = this.addLocalVisionSubmission(selection);
        this.armLocalVisionSubmissionTimeout(localSubmissionId, button, selection.config.visionModel);
        button.dataset.busy = "true";
        this.setButtonState(button, "vision-queued", "Q", "No usable source prompt was found; queued locally for KREA2 Vision");
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
                    stage: "Submitting the queued Discord image",
                    technicalTrace: error instanceof Error ? error.stack || message : message
                });
            }
        });
        this.visionFlowQueue = flow.catch(() => {});
        return flow;
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
            const analysisProfile = normalizeVisionAnalysisProfile(
                selection?.config?.visionAnalysisProfile || this.settings.visionAnalysisProfile
            );
            const promptCount = normalizeVisionPromptCount(
                selection?.config?.visionPromptCount ?? effectiveVisionPromptCount(this.settings, analysisProfile),
                analysisProfile
            );
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
                analysisProfile,
                promptCount,
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
                        analysisProfile,
                        promptCount,
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
                model: visionResult.model,
                promptCount: visionResult.prompt_variants.length
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
                stage: "Downloading or submitting the Discord image",
                technicalTrace: error instanceof Error ? error.stack || message : message
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
        // Vision interrogation is intentionally prompt-only. Keep this hard
        // guard at the request boundary so cached UI/data state cannot attach
        // contribution terms to a magnifier request.
        const contributionEnabled = false;
        const diagnosticConsent = await this.ensureDiagnosticConsent();
        const selectedModel = String(options.model || visionConfig.model || "").trim();
        const guidance = String(options.guidance || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 600);
        const preset = normalizePromptPreset(options.preset || this.settings.preferredPreset);
        const analysisProfile = normalizeVisionAnalysisProfile(options.analysisProfile || this.settings.visionAnalysisProfile);
        const promptCount = normalizeVisionPromptCount(
            options.promptCount ?? effectiveVisionPromptCount(this.settings, analysisProfile),
            analysisProfile
        );
        const datasetGuidance = options.datasetGuidance === undefined
            ? this.settings.useKrea2DatasetGuidance === true
            : options.datasetGuidance === true;
        const feedbackContext = datasetGuidance
            ? options.feedbackContext || buildPromptFeedbackContext(this.promptFeedback)
            : null;
        const jobId = /^[a-f0-9]{32}$/.test(String(options.jobId || "")) ? String(options.jobId) : randomBytes(16).toString("hex");
        const requestCacheKey = visionRequestCacheKey(original.sha256, {
            model: selectedModel,
            analysisProfile,
            promptCount,
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
            analysisProfile,
            promptCount,
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
                expectedPromptCount: promptCount,
                expectedDatasetGuidance: datasetGuidance,
                expectedFeedbackDigest: datasetGuidance ? feedbackContext.digest : null
            });
            return {
                ...parsed,
                request_cache_key: requestCacheKey,
                cache_identity: buildVisionCacheProfile({
                    model: selectedModel,
                    analysisProfile,
                    promptCount,
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

    async finishVisionPrompt({button, model = "", promptCount = 1}) {
        const suffix = model ? ` Model: ${model}.` : "";
        const count = Number(promptCount) === 3 ? 3 : 1;
        const noun = count === 1 ? "prompt" : "prompts";
        const contributed = false;
        const contributionCopy = contributed
            ? ` ${count === 1 ? "The prompt was" : "All three prompts were"} accepted by the online Krea2 dataset.`
            : " Prompt contribution is disabled; nothing was submitted to Krea2.";
        this.setButtonState(button, "vision-ready", "✓", `Detailed Vision ${noun} ${count === 1 ? "is" : "are"} ready.${suffix}${contributionCopy} The ${noun} and a small local thumbnail remain in Prompt History until you clear it; no full-resolution source image was copied into history.`);
        this.toast(
            contributed
                ? `${count === 1 ? "One prompt is" : "Three prompts are"} ready in session memory and ${count === 1 ? "was" : "were"} added to the online Krea2 dataset.`
                : `${count === 1 ? "One prompt is" : "Three prompts are"} ready in session memory. Krea2 contribution is off.`,
            "success"
        );
    }

    showClassification(button, classification) {
        const states = {
            added: ["done", "✓", "Prompt metadata was added to the Krea2 dataset; no image or sidecar was saved.", "Prompt metadata added to Krea2. Nothing was saved locally.", "success"],
            duplicate: ["duplicate", "✓", "Krea2 already has this metadata contribution; nothing was saved locally.", "Krea2 already has this contribution.", "success"],
            no_metadata: ["no-metadata", "–", "No embedded or companion prompt metadata was present. No GPU, credits, submission, or save was used.", "No prompt metadata was found.", "info"],
            metadata_no_prompt: ["metadata-no-prompt", "?", "Metadata existed but contained no usable positive prompt. No GPU, credits, submission, or save was used.", "Metadata had no usable positive prompt.", "warning"],
            metadata_timeout: ["metadata-timeout", "⌛", "Metadata inspection reached its 8-second limit. No GPU, credits, submission, or save was used. Click to retry.", "Metadata inspection timed out safely; click again to retry.", "warning"],
            encoded_or_unknown: ["encoded-or-unknown", "🔒", "Encoded, encrypted, or high-entropy metadata was skipped. No GPU, credits, submission, or save was used.", "Encoded or unknown metadata was skipped.", "warning"],
            structured: ["structured", "🔒", "Structured metadata was unsupported, malformed, or ambiguous, so it was skipped safely. No GPU, credits, submission, or save was used.", "Unsupported or ambiguous structured metadata was skipped.", "warning"],
            non_english: ["non-english", "🔒", "The positive prompt was substantially non-English and was skipped. No GPU, credits, submission, or save was used.", "Substantially non-English metadata was skipped.", "warning"]
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
        this.feedbackModalCleanup?.();
        this.feedbackModalCleanup = null;
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
            let settled = false;
            let cleanup = null;
            const finish = value => {
                if (settled) return;
                settled = true;
                modalDocument.removeEventListener("keydown", onKey);
                overlay.remove();
                if (this.feedbackModalCleanup === cleanup) this.feedbackModalCleanup = null;
                resolve(value);
            };
            cleanup = () => finish(null);
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
            this.feedbackModalCleanup = cleanup;
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
        intro.textContent = "Inside allowlisted Discord servers, the image magnifier sends request-scoped image bytes to the authenticated local KREA2 Vision endpoint. V2 returns one grounded prompt by default, or three genuine variations when you enable that option below. Contributions never include image bytes or Discord identifiers. Technical failures automatically post one downloadable, redacted .txt traceback to the owner-only Discord error webhook and retain privacy-minimal operational fields in Seedframe. The report never includes an image, image hash, prompt, Discord identity or IDs, credential, URL, image filename, or local user path. The separate rich failure-diagnostic option remains opt-in. Generated prompts and sanitized job metadata remain in the private local Prompt History database until you select Clear history. Small local thumbnails are retained under the configured save folder for previews; full-resolution source images are not copied into history; feedback lasts only for this Discord session.";
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
            return input;
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
        const v2Section = document.createElement("section");
        v2Section.dataset.setting = "v2-direct-fidelity";
        v2Section.style.cssText = "margin:18px 0;padding:14px 15px;border:1px solid var(--input-border);border-radius:10px;background:var(--background-secondary)";
        const v2Label = document.createElement("label");
        v2Label.style.cssText = "display:flex;align-items:flex-start;gap:11px;cursor:pointer";
        const v2Toggle = document.createElement("input");
        v2Toggle.type = "checkbox";
        v2Toggle.setAttribute("role", "switch");
        v2Toggle.setAttribute("aria-label", "Use V2 Direct Fidelity for Discord image magnifiers");
        v2Toggle.checked = normalizeVisionAnalysisProfile(this.settings.visionAnalysisProfile) === "v2";
        v2Toggle.style.cssText = "margin-top:3px;width:18px;height:18px;accent-color:#5865f2";
        const v2Copy = document.createElement("div");
        v2Copy.style.cssText = "min-width:0;flex:1";
        const v2TitleRow = document.createElement("div");
        v2TitleRow.style.cssText = "display:flex;align-items:center;gap:8px";
        const v2Title = document.createElement("div");
        v2Title.textContent = "Use V2 Direct Fidelity";
        v2Title.style.fontWeight = "700";
        const v2Status = document.createElement("span");
        v2Status.style.cssText = "padding:2px 7px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.04em";
        v2TitleRow.append(v2Title, v2Status);
        const v2Description = document.createElement("div");
        v2Description.textContent = "On by default. V2 prioritizes the visible pose, action, contact, camera angle, framing, lighting, shadows, and outfit detail. Turn it off to use the faster direct one-pass prompt. Manual Interrogate uploads can still choose Maximum detail.";
        v2Description.style.cssText = "font-size:12px;color:var(--text-muted);margin-top:4px";
        v2Copy.append(v2TitleRow, v2Description);
        v2Label.append(v2Toggle, v2Copy);
        v2Section.append(v2Label);
        panel.append(v2Section);

        const v2VariationsToggle = addCheckbox({
            label: "Generate three V2 prompt variations",
            note: "Off by default: V2 returns one canonical prompt shown in one Prompt tab. Turn this on to ask the same one-pass image inference for three genuine tabs: Balanced, Subject & pose, and Scene & light. It remains one queued image and one Online API image charge, but the longer output may take more time.",
            key: "v2ThreePromptVariations"
        });
        const syncV2Toggle = () => {
            const active = normalizeVisionAnalysisProfile(this.settings.visionAnalysisProfile) === "v2";
            v2Toggle.checked = active;
            v2Section.dataset.enabled = active ? "true" : "false";
            v2Status.textContent = active ? "ON" : "OFF";
            v2Status.style.color = active ? "#a9efc2" : "var(--text-muted)";
            v2Status.style.background = active ? "#173226" : "var(--background-modifier-accent)";
            v2VariationsToggle.disabled = !active;
            v2VariationsToggle.parentElement.style.opacity = active ? "1" : ".5";
            v2VariationsToggle.parentElement.title = active ? "" : "Enable V2 Direct Fidelity to configure V2 prompt variations.";
        };
        v2Toggle.addEventListener("change", () => {
            this.settings.visionAnalysisProfile = v2Toggle.checked ? "v2" : "fast";
            this.settings.visionAnalysisProfileVersion = 3;
            this.saveSettings();
            syncV2Toggle();
        });
        syncV2Toggle();
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
            note: "Optional and off by default. After explicit consent, failed requests may additionally attach the source image, your Discord username, and an available partial or audited prompt to the owner-only Seedframe diagnostics console. This is separate from mandatory redacted .txt traceback logging, which never contains images, prompts, Discord identity, credentials, URLs, image filenames, or local user paths.",
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
            this.toast(
                message,
                job.status === "completed" ? "success" : job.status === "cancelled" ? "warning" : "error"
            );
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
    buildRedactedDiagnosticReport,
    auditPromptContradictions,
    buildOperationalErrorReport,
    base64Url,
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
    effectiveVisionPromptCount,
    effectiveVisionModel,
    evaluatePromptValue,
    extractMetadataDocumentPrompt,
    extractConfidentPrompt,
    extractMediaProvenance,
    filenameFromContentDisposition,
    filenameFromUrl,
    filterHistoryJobs,
    filterExternalUrl,
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
    selectCompanionMetadataAttachment,
    mergeHereticModelTelemetry,
    normalizeDatasetGuidanceState,
    normalizePoseCheck,
    normalizePromptFeedbackText,
    normalizeMediaUrl,
    normalizePromptPreset,
    normalizeStoredSubmissionKey,
    normalizeVisionCacheProfile,
    normalizeVisionExecutionMode,
    normalizeVisionAnalysisProfile,
    normalizeVisionPromptCount,
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
    diagnosticForHistoryJob,
    remotePreflightSummary,
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
    selectMetadataPromptCandidates,
    sha256Hex,
    submissionKey,
    validateSaveFolder,
    validateEndpoint,
    validateVisionLoopbackEndpoint,
    visibleHistoryPromptVariants,
    visionCacheProfileDigest,
    visionModelDisplayName,
    visionPromptSidecarPath,
    visionRequestCacheKey,
    VISION_PIPELINE_ID,
    writeFileCompat
});

module.exports = Krea2DiscordCollector;
