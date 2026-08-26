"use strict";

const assert = require("node:assert/strict");
const {test} = require("node:test");
const {deflateSync} = require("node:zlib");
const {parsePngPromptMetadata} = require("../Krea2DiscordCollector.parser.js");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload = Buffer.alloc(0)) {
    const typeBytes = Buffer.from(type, "ascii");
    const output = Buffer.alloc(payload.length + 12);
    output.writeUInt32BE(payload.length, 0);
    typeBytes.copy(output, 4);
    payload.copy(output, 8);
    output.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), payload.length + 8);
    return output;
}

function minimalPng(...chunks) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
        PNG_SIGNATURE,
        pngChunk("IHDR", ihdr),
        ...chunks,
        pngChunk("IEND")
    ]);
}

function textPayload(key, text, encoding = "utf8") {
    return Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0]), Buffer.from(text, encoding)]);
}

function ztxtPayload(key, text) {
    return Buffer.concat([
        Buffer.from(key, "latin1"),
        Buffer.from([0, 0]),
        deflateSync(Buffer.from(text, "utf8"))
    ]);
}

function itxtPayload(key, text, compressed) {
    const textBytes = Buffer.from(text, "utf8");
    return Buffer.concat([
        Buffer.from(key, "latin1"),
        Buffer.from([0, compressed ? 1 : 0, 0]),
        Buffer.from("en-US\0Prompt\0", "utf8"),
        compressed ? deflateSync(textBytes) : textBytes
    ]);
}

function assertStableShape(output) {
    assert.deepEqual(Object.keys(output), ["status", "prompt", "sourceKey", "reason", "diagnostics"]);
    assert.equal(typeof output.reason, "string");
    assert.equal(typeof output.diagnostics, "object");
    assert.ok(["found", "none", "metadata_no_prompt", "encoded_or_unknown", "structured", "non_english"].includes(output.status));
    if (output.status !== "found") assert.equal(output.prompt, null);
}

test("returns none for a PNG without a parameters or prompt key", async () => {
    const output = await parsePngPromptMetadata(minimalPng(pngChunk("tEXt", textPayload("Comment", "a cat"))));
    assertStableShape(output);
    assert.equal(output.status, "none");
    assert.equal(output.reason, "no_supported_metadata");
});

test("reads mixed-case tEXt parameters and splits the first inline negative prompt", async () => {
    const output = await parsePngPromptMetadata(minimalPng(pngChunk(
        "tEXt",
        textPayload("PaRaMeTeRs", "cinematic portrait, warm rim light nEgAtIvE PrOmPt: blur, text")
    )));
    assert.equal(output.status, "found");
    assert.equal(output.sourceKey, "parameters");
    assert.equal(output.prompt, "cinematic portrait, warm rim light");
    assert.equal(output.diagnostics.negativePromptFound, true);
});

test("HTML-decodes exactly once, applies NFKC, and normalizes line endings", async () => {
    const output = await parsePngPromptMetadata(minimalPng(pngChunk(
        "tEXt",
        textPayload("prompt", "Prompt: Ａ cat &amp;lt;tag&gt;\r\nsoft light")
    )));
    assert.equal(output.status, "found");
    assert.equal(output.prompt, "A cat &lt;tag>\nsoft light");
    assert.equal(output.diagnostics.htmlDecoded, true);
    assert.equal(output.diagnostics.wrapperStripped, true);
});

test("reads uncompressed UTF-8 iTXt", async () => {
    const output = await parsePngPromptMetadata(minimalPng(pngChunk(
        "iTXt",
        itxtPayload("Prompt", "a fox in a moonlit forest", false)
    )));
    assert.equal(output.status, "found");
    assert.equal(output.prompt, "a fox in a moonlit forest");
    assert.equal(output.diagnostics.selectedCompressed, false);
    assert.equal(output.diagnostics.selectedEncoding, "utf8");
});

test("reads compressed UTF-8 iTXt", async () => {
    const output = await parsePngPromptMetadata(minimalPng(pngChunk(
        "iTXt",
        itxtPayload("parameters", "studio portrait, softbox lighting", true)
    )));
    assert.equal(output.status, "found");
    assert.equal(output.prompt, "studio portrait, softbox lighting");
    assert.equal(output.diagnostics.selectedCompressed, true);
});

test("reads zTXt with bounded zlib decompression", async () => {
    const output = await parsePngPromptMetadata(minimalPng(pngChunk(
        "zTXt",
        ztxtPayload("prompt", "wide landscape photograph, morning fog")
    )));
    assert.equal(output.status, "found");
    assert.equal(output.prompt, "wide landscape photograph, morning fog");
    assert.equal(output.diagnostics.selectedChunkType, "zTXt");
});

test("rejects JSON objects and arrays instead of treating them as prompts", async () => {
    for (const value of [
        '{"prompt":"a cat","nodes":[]}',
        '[{"prompt":"a cat"}]'
    ]) {
        const output = await parsePngPromptMetadata(minimalPng(pngChunk("iTXt", itxtPayload("prompt", value, false))));
        assert.equal(output.status, "structured");
        assert.equal(output.reason, "structured_json");
    }
});

test("rejects structured YAML and document markers", async () => {
    for (const value of [
        "---\nprompt: a cat\nsteps: 25",
        "workflow:\n  nodes:\n    - type: sampler"
    ]) {
        const output = await parsePngPromptMetadata(minimalPng(pngChunk("tEXt", textPayload("parameters", value))));
        assert.equal(output.status, "structured");
        assert.equal(output.reason, "structured_yaml_or_document");
    }
});

test("does not mistake a natural-language colon for YAML", async () => {
    const output = await parsePngPromptMetadata(minimalPng(pngChunk(
        "tEXt",
        textPayload("prompt", "portrait of a woman: cinematic lighting, shallow depth of field")
    )));
    assert.equal(output.status, "found");
});

test("does not mistake ordinary bracket emphasis for a JSON array", async () => {
    for (const value of [
        "[masterpiece] portrait, detailed eyes",
        "[masterpiece, best quality] portrait, detailed eyes"
    ]) {
        const output = await parsePngPromptMetadata(minimalPng(pngChunk("tEXt", textPayload("prompt", value))));
        assert.equal(output.status, "found");
        assert.equal(output.prompt, value);
    }
});

test("rejects explicit encryption and base64 or hexadecimal blobs", async () => {
    const values = [
        "encrypted: aes-256 ciphertext follows",
        Buffer.from("this is deliberately encoded rather than a plain scalar prompt".repeat(3)).toString("base64"),
        "0123456789abcdef".repeat(8),
        Array.from({length: 160}, (_, index) => String.fromCharCode(33 + ((index * 37) % 94))).join("")
    ];
    for (const value of values) {
        const output = await parsePngPromptMetadata(minimalPng(pngChunk("tEXt", textPayload("prompt", value))));
        assert.equal(output.status, "encoded_or_unknown");
        assert.equal(output.reason, "encoded_encrypted_or_high_entropy");
    }
});

test("returns metadata_no_prompt for empty or negative-only values", async () => {
    const empty = await parsePngPromptMetadata(minimalPng(pngChunk("tEXt", textPayload("prompt", "  "))));
    assert.equal(empty.status, "metadata_no_prompt");
    assert.equal(empty.reason, "empty_metadata_value");

    const negativeOnly = await parsePngPromptMetadata(minimalPng(pngChunk(
        "tEXt",
        textPayload("parameters", "Negative prompt: low quality")
    )));
    assert.equal(negativeOnly.status, "metadata_no_prompt");
    assert.equal(negativeOnly.reason, "positive_prompt_empty");
});

test("rejects a substantially non-English positive prompt", async () => {
    const output = await parsePngPromptMetadata(minimalPng(pngChunk(
        "iTXt",
        itxtPayload("prompt", "月光下森林里的美丽女孩", false)
    )));
    assert.equal(output.status, "non_english");
    assert.equal(output.reason, "positive_prompt_non_english");
});

test("does not inspect Chinese negative text after the split", async () => {
    const output = await parsePngPromptMetadata(minimalPng(pngChunk(
        "iTXt",
        itxtPayload("parameters", "beautiful woman in moonlight Negative prompt: 模糊，低质量，文字", false)
    )));
    assert.equal(output.status, "found");
    assert.equal(output.prompt, "beautiful woman in moonlight");
});

test("strips an A1111 settings tail when no negative prompt is present", async () => {
    const output = await parsePngPromptMetadata(minimalPng(pngChunk(
        "tEXt",
        textPayload("parameters", "cinematic portrait\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 42, Size: 512x512")
    )));
    assert.equal(output.status, "found");
    assert.equal(output.prompt, "cinematic portrait");
});

test("accepts common English Stable Diffusion tag prompts", async () => {
    for (const prompt of [
        "masterpiece, best quality, intricate details",
        "volumetric rays, depth of field, masterpiece"
    ]) {
        const output = await parsePngPromptMetadata(minimalPng(pngChunk("tEXt", textPayload("prompt", prompt))));
        assert.equal(output.status, "found", prompt);
        assert.equal(output.prompt, prompt);
    }
});

test("conservatively rejects clearly foreign Latin-language prose", async () => {
    const output = await parsePngPromptMetadata(minimalPng(pngChunk(
        "iTXt",
        itxtPayload("prompt", "una mujer hermosa con cabello largo y ojos azules", false)
    )));
    assert.equal(output.status, "non_english");
});

test("rejects Italian prose without confident English signals", async () => {
    const output = await parsePngPromptMetadata(minimalPng(pngChunk(
        "tEXt",
        textPayload("prompt", "ritratto cinematografico di una bellissima donna dai lunghi capelli scuri")
    )));
    assert.equal(output.status, "non_english");
});

test("a usable prompt candidate wins over a structured candidate", async () => {
    const output = await parsePngPromptMetadata(minimalPng(
        pngChunk("iTXt", itxtPayload("prompt", '{"workflow":[]}', false)),
        pngChunk("tEXt", textPayload("parameters", "sharp editorial portrait, window light"))
    ));
    assert.equal(output.status, "found");
    assert.equal(output.sourceKey, "parameters");
    assert.equal(output.prompt, "sharp editorial portrait, window light");
});

test("malformed compressed metadata never throws and is encoded_or_unknown", async () => {
    const malformed = Buffer.concat([
        Buffer.from("prompt", "latin1"),
        Buffer.from([0, 0, 1, 2, 3, 4, 5])
    ]);
    const output = await parsePngPromptMetadata(minimalPng(pngChunk("zTXt", malformed)));
    assert.equal(output.status, "encoded_or_unknown");
    assert.equal(output.reason, "decompression_failed_or_too_large");
    assert.equal(output.diagnostics.decompressionFailures, 1);
});

test("limits decompressed output to stop compression bombs", async () => {
    const output = await parsePngPromptMetadata(
        minimalPng(pngChunk("zTXt", ztxtPayload("parameters", "a".repeat(5000)))),
        {maxTextBytes: 128}
    );
    assert.equal(output.status, "encoded_or_unknown");
    assert.equal(output.reason, "decompression_failed_or_too_large");
});

test("rejects an oversized recognized metadata chunk without decoding it", async () => {
    const output = await parsePngPromptMetadata(
        minimalPng(pngChunk("tEXt", textPayload("prompt", "ordinary words ".repeat(20)))),
        {maxMetadataChunkBytes: 64}
    );
    assert.equal(output.status, "encoded_or_unknown");
    assert.equal(output.reason, "metadata_chunk_too_large");
    assert.equal(output.diagnostics.oversizedTextChunks, 1);
});

test("truncated PNG chunk bounds are handled without throwing", async () => {
    const truncated = Buffer.concat([PNG_SIGNATURE, Buffer.from([0, 0, 1, 0, 0x74, 0x45, 0x58, 0x74])]);
    const output = await parsePngPromptMetadata(truncated);
    assert.equal(output.status, "encoded_or_unknown");
    assert.equal(output.reason, "png_scan_incomplete");
    assert.equal(output.prompt, null);
});

test("never accepts a prompt from a PNG that ends before IEND", async () => {
    const incomplete = Buffer.concat([
        PNG_SIGNATURE,
        pngChunk("tEXt", textPayload("prompt", "cinematic portrait"))
    ]);
    const output = await parsePngPromptMetadata(incomplete);
    assert.equal(output.status, "encoded_or_unknown");
    assert.equal(output.reason, "png_scan_incomplete");
    assert.equal(output.diagnostics.sawIend, false);
});

test("diagnostics contain no raw prompt text", async () => {
    const secret = "UNIQUE_DIAGNOSTIC_LEAK_SENTINEL cinematic portrait";
    const output = await parsePngPromptMetadata(minimalPng(pngChunk("tEXt", textPayload("prompt", secret))));
    assert.equal(output.status, "found");
    assert.equal(JSON.stringify(output.diagnostics).includes(secret), false);
});

test("non-PNG and unsupported input return a stable result", async () => {
    for (const input of [Buffer.from("not a png"), "not bytes", null]) {
        const output = await parsePngPromptMetadata(input);
        assertStableShape(output);
        assert.equal(output.status, "none");
    }
});
