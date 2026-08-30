"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.source.js"), "utf8");
const built = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.js"), "utf8");

for (const text of [source, built]) {
    assert.doesNotMatch(text, /region[-_ ]inpaint/i);
    assert.doesNotMatch(text, /inpaint prompt region/i);
    assert.doesNotMatch(text, /clear mask/i);
    assert.doesNotMatch(text, /adopt correction/i);
    assert.doesNotMatch(text, /selected-region Vision inspection/i);
    assert.doesNotMatch(text, /purpose === "region-inpaint"/);
}

assert.match(source, /\["Describe region", "region"\]/);
assert.match(source, /analyze\.textContent = "Describe selected region"/);
assert.match(source, /async requestPromptChat\(messages, signal, options = \{\}\)/);

console.log("BetterDiscord region-inpaint removal regression passed.");
