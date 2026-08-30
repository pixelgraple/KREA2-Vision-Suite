"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sourcePath = path.join(__dirname, "Krea2DiscordCollector.plugin.source.js");
const source = fs.readFileSync(sourcePath, "utf8");
const Plugin = require(sourcePath);
const {
    compactPromptEditorContext,
    estimatePromptEditorContextTokens,
    normalizePromptEditorHistoryIndex,
    normalizePromptEditorSession
} = Plugin.helpers;

assert.match(source, /@version 0\.17\.0/);
assert.match(source, /const PROMPT_EDITOR_MODAL_ID = "krea2-discord-prompt-editor-modal"/);
assert.match(source, /const PROMPT_EDITOR_CONTEXT_TOKENS = 32768/);
assert.match(source, /#\$\{PROMPT_EDITOR_MODAL_ID\}\[hidden\] \{ display: none !important; \}/);
assert.match(source, /const PROMPT_EDITOR_HISTORY_PAGE_SIZE = 6/);
assert.match(source, /const PROMPT_EDITOR_TURN_PAGE_SIZE = 8/);
assert.match(source, /brandPromptEditor\.textContent = "✦ Qwen Prompt Editor"/);
assert.match(source, /brandPromptEditor\.addEventListener\("click", \(\) => this\.openPromptEditor\("", root\.ownerDocument \|\| document\)\)/);
assert.match(source, /editWithQwen\.textContent = "✦ Edit with Qwen"/);
assert.match(source, /editVariant\.textContent = "✦ Edit this prompt with Qwen"/);
assert.match(source, /async requestPromptChat\(messages, signal\)/);
assert.match(source, /this\.ensureRemoteCredits\(signal, "prompt-chat"\)/);
assert.match(source, /\/v1\/prompt-chat\/jobs/);
assert.match(source, /\/v1\/prompt-chat\/jobs\/\$\{requestId\}/);
assert.doesNotMatch(source, /\/v1\/prompt-chat\/completions/);
assert.match(source, /model: "heretic-3\.8-q4-cloud"/);
assert.match(source, /result\?\.credits_charged !== 1/);
assert.match(source, /Conversations are stored privately on this computer and survive closing Discord/);
assert.match(source, /the KREA2 gateway still does not store them/);

const method = source.slice(source.indexOf("    openPromptEditor("), source.indexOf("    openVerifiedExternal("));
assert.ok(method.length > 10000, "durable Prompt Editor implementation should be present");
assert.match(method, /this\.api\.Data\.save\(PROMPT_EDITOR_ACTIVE_SESSION_KEY, session\.id\)/);
assert.match(method, /this\.persistPromptEditorSession/);
assert.match(method, /Conversation history/);
assert.match(method, /Messages \$\{turnPage\} \/ \$\{pageCount\}/);
assert.match(method, /32K model context/);
assert.match(method, /overlay\.hidden = true/);
assert.match(method, /if \(!destroy\)/);
assert.match(method, /if \(overlay\.hidden\) this\.toast\("Qwen Prompt Editor reply is ready/);
assert.match(method, /compactPromptEditorContext\(messages/);
assert.doesNotMatch(method, /if \(messages\.length >= 14\) \{\s*messages = \[\]/);
assert.doesNotMatch(method, /The in-flight edit was cancelled/);

const shortMessages = [
    {role: "user", content: "Current prompt: portrait in soft window light. Make the light warmer."},
    {role: "assistant", content: "A portrait in warm window light."}
];
const unchanged = compactPromptEditorContext(shortMessages, {upcomingUserContent: "Keep the pose."});
assert.equal(unchanged.compacted, false);
assert.deepEqual(unchanged.messages, shortMessages);

const longMessages = [];
for (let index = 0; index < 16; index += 1) {
    longMessages.push({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index % 2 === 0 ? "Requested revision" : "Revised prompt"} ${index}: ${"texture lighting pose ".repeat(900)}`
    });
}
const compacted = compactPromptEditorContext(longMessages, {
    currentPrompt: "A full-body editorial portrait with detailed clothing and dramatic lighting.",
    latestReply: "A full-body editorial portrait with the accumulated pose, clothing, and lighting edits.",
    upcomingUserContent: "Change only the camera angle to a low-angle view."
});
assert.equal(compacted.compacted, true);
assert.ok(compacted.removedMessages > 0);
assert.ok(compacted.messages.length + 1 <= 16);
assert.ok(estimatePromptEditorContextTokens([...compacted.messages, {role: "user", content: "Change only the camera angle to a low-angle view."}]) <= 30208);
assert.match(compacted.summary, /^\[Compacted Prompt Editor context\]/);
assert.match(compacted.summary, /Canonical KREA2 prompt/);

const normalizedSession = normalizePromptEditorSession({
    id: "session_1",
    prompt: "A durable prompt",
    turns: [{role: "user", text: "Make it warmer."}],
    statusState: "success"
});
assert.equal(normalizedSession.id, "session_1");
assert.equal(normalizedSession.turns.length, 1);
assert.equal(normalizedSession.version, 2);

const normalizedIndex = normalizePromptEditorHistoryIndex([
    {id: "older", title: "Older", updatedAt: 10},
    {id: "newer", title: "Newer", updatedAt: 20},
    {id: "newer", title: "Duplicate", updatedAt: 30}
]);
assert.deepEqual(normalizedIndex.map(item => item.id), ["newer", "older"]);

console.log("Krea2DiscordCollector durable Qwen Prompt Editor tests passed.");
