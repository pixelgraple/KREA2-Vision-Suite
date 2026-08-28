"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const sourcePath = path.join(root, "Krea2DiscordCollector.plugin.source.js");
const parserPath = path.join(root, "Krea2DiscordCollector.parser.js");
const outputPath = path.join(root, "Krea2DiscordCollector.plugin.js");

const source = fs.readFileSync(sourcePath, "utf8");
let parser = fs.readFileSync(parserPath, "utf8")
    .replace(/^\uFEFF?\s*"use strict";\s*/, "")
    .replace(
        /\nmodule\.exports = Object\.freeze\(\{\s*DEFAULT_LIMITS,\s*extractComfyPositivePrompt,\s*extractPromptFromMetadataDocument,\s*parsePngPromptMetadata\s*\}\);\s*$/,
        "\nreturn Object.freeze({DEFAULT_LIMITS, extractComfyPositivePrompt, extractPromptFromMetadataDocument, parsePngPromptMetadata});\n"
    );

if (!/return Object\.freeze\(\{DEFAULT_LIMITS, extractComfyPositivePrompt, extractPromptFromMetadataDocument, parsePngPromptMetadata\}\);/.test(parser)) {
    throw new Error("Could not transform the parser export into an inline factory return.");
}

const externalParserBlock = /let parseHardenedPngPromptMetadata = null;\s*let extractMetadataDocumentPrompt = null;\s*try \{[\s\S]*?\n\}\s*catch \{[\s\S]*?\n\}/;
if (!externalParserBlock.test(source)) {
    throw new Error("Could not find the external parser loader in the plugin source.");
}

const indentedParser = parser.split(/\r?\n/).map(line => line ? `    ${line}` : "").join("\n");
const inlineParserBlock = [
    "const {parsePngPromptMetadata: parseHardenedPngPromptMetadata, extractPromptFromMetadataDocument: extractMetadataDocumentPrompt} = (() => {",
    indentedParser,
    "})();"
].join("\n");

const bundled = source.replace(externalParserBlock, inlineParserBlock);
if (/Krea2DiscordCollector\.parser\.js/.test(bundled)) {
    throw new Error("The bundled plugin still references the external parser companion.");
}

fs.writeFileSync(outputPath, bundled, "utf8");
console.log(`Built ${path.basename(outputPath)} with the hardened PNG parser embedded.`);
