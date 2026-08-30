"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.source.js"), "utf8");

assert.match(source, /@version 0\.16\.3/);
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
assert.match(source, /async requestPromptChat\(messages, signal\)/);
assert.match(source, /this\.ensureRemoteCredits\(signal, "prompt-chat"\)/);
assert.match(source, /\/v1\/prompt-chat\/jobs/);
assert.match(source, /\/v1\/prompt-chat\/jobs\/\$\{requestId\}/);
assert.doesNotMatch(source, /\/v1\/prompt-chat\/completions/);
assert.match(source, /"X-Krea2-Request-Id": requestId/);
assert.match(source, /model: "heretic-3\.8-q4-cloud"/);
assert.match(source, /result\?\.credits_charged !== 1/);
assert.match(source, /not stored by the KREA2 gateway/);
assert.match(source, /this\.promptEditorDraft = null/);
assert.match(source, /const restoredDraft = suppliedPrompt \? null : this\.promptEditorDraft/);
assert.match(source, /promptBox\.addEventListener\("input", syncDraft\)/);
assert.match(source, /instruction\.addEventListener\("input", syncDraft\)/);
assert.match(source, /A recovery draft stays only in this running Discord session/);
assert.doesNotMatch(source, /await this\.refreshHistory\(true\);\s*if \(this\.historyJobs\.some\(job => job\.id === localSubmissionId\)\) void this\.openHistoryDetail/);

const method = source.slice(source.indexOf("    openPromptEditor("), source.indexOf("    openVerifiedExternal("));
assert.ok(method.length > 5000, "Prompt Editor implementation should be present");
assert.doesNotMatch(method, /Data\.save|localStorage|sessionStorage|fs\.|writeFile|127\.0\.0\.1:7870/);
assert.match(method, /event\.stopImmediatePropagation\?\.\(\)/);
assert.match(method, /controller\.abort\(\)/);
assert.match(method, /this\.requestPromptChat\(messages, controller\.signal\)/);
const requestMethod = source.slice(source.indexOf("    async requestPromptChat("), source.indexOf("    openPromptEditor("));
assert.match(requestMethod, /const deadline = Date\.now\(\) \+ \(8 \* 60 \* 1000\)/);
assert.match(requestMethod, /timeout: 30000/);
assert.doesNotMatch(requestMethod, /Data\.save|localStorage|sessionStorage|fs\.|writeFile|127\.0\.0\.1:7870/);

console.log("Krea2DiscordCollector Qwen Prompt Editor tests passed.");
