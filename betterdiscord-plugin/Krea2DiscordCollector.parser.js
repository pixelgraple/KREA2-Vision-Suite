"use strict";

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
    const decoded = decodeHtmlEntitiesOnce(text);
    const htmlDecoded = decoded !== text;
    text = decoded;

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
        htmlDecoded,
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
    if (looksLikeJsonContainer(text)) return {...common, status: "structured", reason: "structured_json"};
    if (/^(?:---|\.\.\.|%YAML\b|%TAG\b|!!(?:map|seq|str)\b|!<[^>]+>)/i.test(text)) {
        return {...common, status: "structured", reason: "structured_yaml_or_document"};
    }

    const wrapper = text.match(/^\s*(?:parameters|prompt)\s*:\s*/i);
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

    return {...common, status: "found", reason: "positive_prompt_extracted", prompt: text};
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

module.exports = Object.freeze({
    DEFAULT_LIMITS,
    parsePngPromptMetadata
});
