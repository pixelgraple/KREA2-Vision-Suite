"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sourcePath = path.join(__dirname, "Krea2DiscordCollector.plugin.source.js");
const source = fs.readFileSync(sourcePath, "utf8");
const Plugin = require(sourcePath);
const {
    compactQwenChatContext,
    extractQwenReplyFiles,
    normalizeQwenChatHistoryIndex,
    normalizeQwenChatSession,
    safeQwenDownloadFilename
} = Plugin.helpers;

assert.match(source, /const QWEN_CHAT_LAUNCHER_ID = "krea2-discord-qwen-chat-launcher"/);
assert.match(source, /querySelector\('nav\[aria-label="Servers sidebar"\]'\)/);
assert.match(source, /navigation\.prepend\(root\)/);
assert.match(source, /button\.textContent = "Q3\.8"/);
assert.match(source, /this\.ensureQwenLauncher\(\)/);
assert.match(source, /this\.openQwenChat\(document\)/);
assert.match(source, /experience: "general_chat"/);
assert.match(source, /1 credit per started 350 tokens/);
assert.match(source, /32K model context/);
assert.match(source, /Download chat/);
assert.match(source, /Download reply \(\.md\)/);
assert.match(source, /extractQwenReplyFiles\(turn\.text\)/);

const normalized = normalizeQwenChatSession({
    id: "chat_1",
    draft: "unfinished message",
    messages: [{role: "user", content: "Help me build a small app."}],
    turns: [{role: "user", text: "Help me build a small app.", createdAt: 10}]
});
assert.equal(normalized.id, "chat_1");
assert.equal(normalized.title, "Help me build a small app.");
assert.equal(normalized.draft, "unfinished message");
assert.equal(normalized.turns.length, 1);

const index = normalizeQwenChatHistoryIndex([
    {id: "older", title: "Older", updatedAt: 10},
    {id: "newer", title: "Newer", updatedAt: 20},
    {id: "newer", title: "Duplicate", updatedAt: 30}
]);
assert.deepEqual(index.map(item => item.id), ["newer", "older"]);

const longConversation = Array.from({length: 18}, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `${index}: ${"context ".repeat(700)}`
}));
const compacted = compactQwenChatContext(longConversation, {
    upcomingUserContent: "Continue from everything we discussed."
});
assert.equal(compacted.compacted, true);
assert.ok(compacted.messages.length <= 16);
assert.match(compacted.messages[0].content, /Compacted Qwen Chat context/);

const files = extractQwenReplyFiles([
    "Here are the files:",
    "```python filename=app.py",
    "print('hello')",
    "```",
    "```json",
    "{\"ready\": true}",
    "```"
].join("\n"));
assert.equal(files.length, 2);
assert.equal(files[0].filename, "app.py");
assert.equal(files[0].language, "python");
assert.equal(files[1].filename, "qwen-file-2.json");
assert.equal(safeQwenDownloadFilename("../../evil.ps1"), "evil.ps1");

console.log("Krea2DiscordCollector pinned Qwen Chat tests passed.");
