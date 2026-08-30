"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const source = fs.readFileSync(path.join(root, "Krea2DiscordCollector.plugin.source.js"), "utf8");
const built = fs.readFileSync(path.join(root, "Krea2DiscordCollector.plugin.js"), "utf8");
const Plugin = require(path.join(root, "Krea2DiscordCollector.plugin.js"));

assert.equal(Plugin.helpers.VISION_PIPELINE_ID, "discord-faithful-v12-interaction-locked-v2");
for (const text of [source, built]) {
    assert.match(text, /const PLUGIN_VERSION = "0\.17\.1"/);
    assert.match(text, /technical_trace/);
    assert.match(text, /technicalTrace: error instanceof Error \? error\.stack \|\| message : message/);
    assert.match(text, /\/v1\/audit\/error/);
    assert.match(text, /X-Krea2-Remote-License-Token/);
    assert.match(text, /submitOperationalErrorWebhookDirect/);
    assert.match(text, /downloadable, redacted \.txt traceback/);
}

console.log("Krea2DiscordCollector redacted Discord error-webhook tests passed.");
