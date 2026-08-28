"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.source.js"), "utf8");

assert.match(source, /@version 0\.14\.2/);
assert.match(source, /const PROMPT_EDITOR_MODAL_ID = "krea2-discord-prompt-editor-modal"/);
assert.match(source, /brandPromptEditor\.textContent = "✦ Qwen Prompt Editor"/);
assert.match(source, /brandPromptEditor\.addEventListener\("click", \(\) => this\.openPromptEditor\("", root\.ownerDocument \|\| document\)\)/);
assert.match(source, /editWithQwen\.textContent = "✦ Edit with Qwen"/);
assert.match(source, /editVariant\.textContent = "✦ Edit this prompt with Qwen"/);
assert.match(source, /edit\.addEventListener\("click", \(\) => this\.openPromptEditor\(candidates\[selectedIndex\]\.prompt, modalDocument\)\)/);
assert.match(source, /async ensureRemoteCredits\(signal, purpose = "image"\)/);
assert.match(source, /async remoteCreditStatus\(license, signal, purpose = "image"\)/);
assert.match(source, /if \(purpose === "prompt-chat"\)/);
assert.match(source, /if \(!validPromptBalance\(status\)\) status = await fetchStatus\(true\)/);
assert.match(source, /Qwen Prompt Editor credit information is still updating/);
assert.match(source, /this\.remoteCreditStatus\(license, signal, purpose\)/);
assert.match(source, /this\.ensureRemoteCredits\(controller\.signal, "prompt-chat"\)/);
assert.match(source, /\/v1\/prompt-chat\/completions/);
assert.match(source, /"X-Krea2-Request-Id": requestId/);
assert.match(source, /model: "heretic-3\.8-q4-cloud"/);
assert.match(source, /result\?\.credits_charged !== 1/);
assert.match(source, /not stored by the KREA2 gateway/);
assert.match(source, /messages = \[\];[\s\S]*?overlay\.remove\(\)/);

const method = source.slice(source.indexOf("    openPromptEditor("), source.indexOf("    openVerifiedExternal("));
assert.ok(method.length > 5000, "Prompt Editor implementation should be present");
assert.doesNotMatch(method, /Data\.save|localStorage|sessionStorage|fs\.|writeFile|127\.0\.0\.1:7870/);
assert.match(method, /event\.stopImmediatePropagation\?\.\(\)/);
assert.match(method, /controller\.abort\(\)/);
assert.match(method, /timeout: 8 \* 60 \* 1000/);

console.log("Krea2DiscordCollector Qwen Prompt Editor tests passed.");
