"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Plugin = require("./Krea2DiscordCollector.plugin.js");

const {
    evaluatePromptValue,
    extractMetadataDocumentPrompt,
    selectMetadataPromptCandidates,
    selectCompanionMetadataAttachment
} = Plugin.helpers;

const flatParametersAttachment = `parameters:
A realistic vertical smartphone photograph of one adult woman seated in a black styling chair, viewed from a high canted angle. She wears a fitted black faux-leather camisole mini-dress with narrow straps, a copper-toned zipper, visible seams, and a subtle sheen. Her knees and thighs press together, her right hand rests on the curved chair arm, and cool window light mixes with warm salon lighting.
Negative prompt: blurry, watermark, distorted hands
Steps: 5, Sampler: Euler, CFG scale: 1.0`;

assert.deepEqual(evaluatePromptValue(flatParametersAttachment), {
    classification: "usable",
    prompt: "A realistic vertical smartphone photograph of one adult woman seated in a black styling chair, viewed from a high canted angle. She wears a fitted black faux-leather camisole mini-dress with narrow straps, a copper-toned zipper, visible seams, and a subtle sheen. Her knees and thighs press together, her right hand rests on the curved chair arm, and cool window light mixes with warm salon lighting."
});
assert.equal(evaluatePromptValue("scene:\n  subject: woman\n  lighting: soft").classification, "structured");
assert.equal(evaluatePromptValue('{"prompt":{"nodes":[]}}').classification, "structured");
assert.equal(evaluatePromptValue(`base64:${"A".repeat(128)}`).classification, "encoded_or_unknown");
assert.equal(evaluatePromptValue("美しい女性の肖像、柔らかな光").classification, "non_english");

const sourcePrompt = "A realistic portrait with a precise seated pose, a red tailored outfit, side lighting, and a long cast shadow.";
assert.deepEqual(selectMetadataPromptCandidates(
    {classification: "usable", prompt: sourcePrompt},
    null,
    "none"
), {
    status: "usable",
    classification: "usable",
    prompts: [{prompt: sourcePrompt, source: "embedded image metadata"}]
});
assert.deepEqual(selectMetadataPromptCandidates(
    {classification: "usable", prompt: sourcePrompt},
    {classification: "usable", prompt: `  ${sourcePrompt.replace(/ /g, "  ")}  `, source: "parameters.yaml"},
    "found"
).prompts, [{prompt: sourcePrompt, source: "embedded image metadata"}]);
assert.deepEqual(selectMetadataPromptCandidates(
    {classification: "usable", prompt: sourcePrompt},
    {classification: "usable", prompt: `${sourcePrompt} A second source adds warm backlight.`, source: "parameters.yaml"},
    "found"
).prompts.map(item => item.source), ["embedded image metadata", "parameters.yaml"]);
assert.deepEqual(selectMetadataPromptCandidates(
    {classification: "encoded_or_unknown"},
    {classification: "non_english"},
    "found"
), {status: "none", classification: "non_english", prompts: []});
assert.equal(selectMetadataPromptCandidates(
    {classification: "no_metadata"},
    null,
    "ambiguous"
).classification, "structured");

const comfyGraphDocument = `prompt:
{
  "8": {
    "inputs": {"text": "A candid beach photograph with bright sunlight and clear shadows.", "clip": ["2", 0]},
    "class_type": "CLIPTextEncode",
    "_meta": {"title": "CLIP Text Encode (Prompt)"}
  },
  "6": {
    "inputs": {"positive": ["8", 0], "negative": ["7", 0], "latent_image": ["10", 0]},
    "class_type": "KSampler",
    "_meta": {"title": "KSampler"}
  },
  "7": {
    "inputs": {"conditioning": ["8", 0]},
    "class_type": "ConditioningZeroOut",
    "_meta": {"title": "Conditioning Zero Out"}
  },
  "10": {
    "inputs": {"width": 832, "height": 1216},
    "class_type": "EmptyLatentImage",
    "_meta": {"title": "Empty Latent Image"}
  },
  "9443": {
    "inputs": {"text1": "add sharp details without changing skin tone"},
    "class_type": "TextBox1",
    "_meta": {"title": "Positive"}
  },
  "9449": {
    "inputs": {"text": ["9443", 0], "clip": ["2", 0]},
    "class_type": "CLIPTextEncode",
    "_meta": {"title": "CLIP Text Encode (Positive Prompt)"}
  },
  "9452": {
    "inputs": {"pixels": ["20", 0]},
    "class_type": "VAEEncode",
    "_meta": {"title": "VAE Encode"}
  },
  "9455": {
    "inputs": {"conditioning": ["9449", 0], "latent": ["9452", 0]},
    "class_type": "ReferenceLatent",
    "_meta": {"title": "ReferenceLatent (Positive)"}
  },
  "9439": {
    "inputs": {"positive": ["9455", 0], "negative": ["7", 0], "latent_image": ["11", 0]},
    "class_type": "KSampler",
    "_meta": {"title": "KSampler refiner"}
  },
  "11": {
    "inputs": {"width": 832, "height": 1216},
    "class_type": "EmptyLatentImage",
    "_meta": {"title": "Empty Latent Image"}
  }
}
workflow:
{"nodes":[{"widgets_values":["do not scrape this workflow string"]}]}`;

const comfyResult = extractMetadataDocumentPrompt(comfyGraphDocument);
assert.equal(comfyResult.status, "found");
assert.equal(comfyResult.nodeId, "8");
assert.equal(comfyResult.samplerId, "6");
assert.equal(comfyResult.prompt, "A candid beach photograph with bright sunlight and clear shadows.");
assert.deepEqual(evaluatePromptValue(comfyGraphDocument), {
    classification: "usable",
    prompt: "A candid beach photograph with bright sunlight and clear shadows."
});

const mojibakeGraph = `prompt:
{"57:27":{"inputs":{"text":"Mixed light â€” warm lamp â€” soft shadows."},"class_type":"CLIPTextEncode","_meta":{"title":"Prompt"}},"57:3":{"inputs":{"positive":["57:27",0],"latent_image":["57:13",0]},"class_type":"KSampler"},"57:13":{"inputs":{"width":832,"height":1216},"class_type":"EmptyLatentImage"}}
workflow:
{}`;
assert.equal(extractMetadataDocumentPrompt(mojibakeGraph).prompt, "Mixed light — warm lamp — soft shadows.");

const entityGraph = `prompt:
{"81":{"inputs":{"text":"A realistic photograph of a woman wearing &quot;red&quot; dress in soft studio light."},"class_type":"CLIPTextEncode"},"82":{"inputs":{"positive":["81",0],"latent_image":["83",0]},"class_type":"KSampler"},"83":{"inputs":{"width":832,"height":1216},"class_type":"EmptyLatentImage"}}
workflow:
{}`;
assert.equal(
    extractMetadataDocumentPrompt(entityGraph).prompt,
    'A realistic photograph of a woman wearing "red" dress in soft studio light.'
);
assert.deepEqual(evaluatePromptValue(entityGraph), {
    classification: "usable",
    prompt: 'A realistic photograph of a woman wearing "red" dress in soft studio light.'
});

const ambiguousGraph = `prompt:
{"1":{"inputs":{"text":"first distinct prompt"},"class_type":"CLIPTextEncode"},"2":{"inputs":{"text":"second distinct prompt"},"class_type":"CLIPTextEncode"},"3":{"inputs":{"positive":["1",0]},"class_type":"KSampler"},"4":{"inputs":{"positive":["2",0]},"class_type":"KSampler"}}
workflow:
{}`;
assert.equal(extractMetadataDocumentPrompt(ambiguousGraph).status, "ambiguous");
assert.equal(evaluatePromptValue(ambiguousGraph).classification, "structured");

const deepNodes = {
    sampler: {inputs: {positive: ["combine", 0], latent_image: ["latent", 0]}, class_type: "KSampler"},
    combine: {inputs: {conditioning_1: ["near", 0], conditioning_2: ["pass-0", 0]}, class_type: "ConditioningCombine"},
    near: {inputs: {text: "near prompt"}, class_type: "CLIPTextEncode"},
    latent: {inputs: {width: 832, height: 1216}, class_type: "EmptyLatentImage"}
};
for (let index = 0; index < 70; index += 1) {
    deepNodes[`pass-${index}`] = {
        inputs: {conditioning: [index === 69 ? "far" : `pass-${index + 1}`, 0]},
        class_type: "ConditioningSetArea"
    };
}
deepNodes.far = {inputs: {text: "far prompt"}, class_type: "CLIPTextEncode"};
const deepGraph = `prompt:\n${JSON.stringify(deepNodes)}\nworkflow:\n{}`;
assert.deepEqual(extractMetadataDocumentPrompt(deepGraph), {
    status: "invalid",
    reason: "comfyui_traversal_limit"
});
assert.equal(evaluatePromptValue(deepGraph).classification, "structured");

const imageProvenance = {attachmentId: "123456789012345678"};
const singlePair = selectCompanionMetadataAttachment(imageProvenance, [
    {id: "123456789012345678", filename: "scene.png", url: "https://cdn.discordapp.com/attachments/111111111111111111/123456789012345678/scene.png", content_type: "image/png", width: 1024, height: 1024},
    {id: "223456789012345678", filename: "parameters.yaml", url: "https://cdn.discordapp.com/attachments/111111111111111111/223456789012345678/parameters.yaml", content_type: "text/yaml", size: 200930}
]);
assert.equal(singlePair.status, "found");
assert.equal(singlePair.attachment.filename, "parameters.yaml");

const ambiguousPair = selectCompanionMetadataAttachment(imageProvenance, [
    {id: "123456789012345678", filename: "one.png", url: "https://cdn.discordapp.com/attachments/111111111111111111/123456789012345678/one.png", content_type: "image/png", width: 1024, height: 1024},
    {id: "323456789012345678", filename: "two.png", url: "https://cdn.discordapp.com/attachments/111111111111111111/323456789012345678/two.png", content_type: "image/png", width: 1024, height: 1024},
    {id: "423456789012345678", filename: "parameters.yaml", url: "https://cdn.discordapp.com/attachments/111111111111111111/423456789012345678/parameters.yaml", size: 1000}
]);
assert.equal(ambiguousPair.status, "ambiguous");

const exactStemPair = selectCompanionMetadataAttachment({attachmentId: "523456789012345678"}, [
    {id: "523456789012345678", filename: "portrait.png", url: "https://cdn.discordapp.com/attachments/111111111111111111/523456789012345678/portrait.png", content_type: "image/png", width: 1024, height: 1024},
    {id: "623456789012345678", filename: "portrait.yaml", url: "https://cdn.discordapp.com/attachments/111111111111111111/623456789012345678/portrait.yaml", content_type: "text/yaml", size: 1500},
    {id: "723456789012345678", filename: "unrelated.yaml", url: "https://cdn.discordapp.com/attachments/111111111111111111/723456789012345678/unrelated.yaml", content_type: "text/yaml", size: 1600}
]);
assert.equal(exactStemPair.status, "found");
assert.equal(exactStemPair.attachment.filename, "portrait.yaml");

const duplicateImageStem = selectCompanionMetadataAttachment({attachmentId: "823456789012345678"}, [
    {id: "823456789012345678", filename: "scene.png", url: "https://cdn.discordapp.com/attachments/111111111111111111/823456789012345678/scene.png", content_type: "image/png", width: 1024, height: 1024},
    {id: "923456789012345678", filename: "scene.png", url: "https://cdn.discordapp.com/attachments/111111111111111111/923456789012345678/scene.png", content_type: "image/png", width: 1024, height: 1024},
    {id: "103456789012345678", filename: "scene.yaml", url: "https://cdn.discordapp.com/attachments/111111111111111111/103456789012345678/scene.yaml", content_type: "text/yaml", size: 1400}
]);
assert.equal(duplicateImageStem.status, "ambiguous");
assert.equal(duplicateImageStem.reason, "multiple_images_share_yaml_filename_stem");

const source = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.source.js"), "utf8");
const metadataStart = source.indexOf("    queueMetadataProbe(image, button) {");
const metadataEnd = source.indexOf("\n    removeButton(button) {", metadataStart);
assert.ok(metadataStart >= 0 && metadataEnd > metadataStart, "metadata-only + method must remain present");
const metadataMethod = source.slice(metadataStart, metadataEnd);
assert.doesNotMatch(metadataMethod, /\b(?:requestVisionPrompt|queueVisionAnalysis|runSavedImageModel|collectImage|saveOriginalAndSidecar|finishVisionPrompt)\s*\(/);
assert.doesNotMatch(metadataMethod, /\/api\/discord-describe|shareDatasetContributions|dataset_guidance/);

const magnifierStart = source.indexOf("    queueVisionAnalysis(image, button) {");
const magnifierEnd = source.indexOf("\n    enqueueVisionAnalysisAfterMetadata(", magnifierStart);
assert.ok(magnifierStart >= 0 && magnifierEnd > magnifierStart, "magnifier metadata preflight must remain separate from Vision enqueue");
const magnifierMethod = source.slice(magnifierStart, magnifierEnd);
assert.match(magnifierMethod, /inspectPromptMetadata\(/);
assert.match(magnifierMethod, /showMetadataPromptModal\(inspected\.prompts\)/);
assert.doesNotMatch(magnifierMethod, /addLocalVisionSubmission\(|armLocalVisionSubmissionTimeout\(|requestVisionPrompt\(|issueVisionSession\(/);
const enqueueStart = source.indexOf("    enqueueVisionAnalysisAfterMetadata(", magnifierEnd);
const enqueueEnd = source.indexOf("\n    async analyzeWithVision(", enqueueStart);
assert.ok(enqueueStart >= 0 && enqueueEnd > enqueueStart, "Vision enqueue helper must remain present");
assert.match(source.slice(enqueueStart, enqueueEnd), /addLocalVisionSubmission\(/);

console.log("BetterDiscord flat parameters, ComfyUI YAML, and attachment-pairing tests passed.");
