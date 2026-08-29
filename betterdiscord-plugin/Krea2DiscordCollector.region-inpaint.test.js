"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.source.js"), "utf8");
const built = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.js"), "utf8");

function method(text, start, end) {
    const from = text.indexOf(start);
    const to = text.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `${start} implementation should be present`);
    return text.slice(from, to);
}

for (const text of [source, built]) {
    assert.match(text, /\.krea2-region-inpaint-results\[hidden\],[\s\S]*?\.krea2-region-inpaint \.krea2-workshop-toolbar\[hidden\] \{ display: none; \}/);
    assert.match(text, /inpaintVariant\.textContent = "◎ Inpaint prompt region"/);
    assert.match(text, /title\.textContent = "Region Inpaint Prompt Correction"/);
    assert.match(text, /instruction\.placeholder = "What is wrong here\?/);
    assert.match(text, /run\.textContent = "Inspect region and rewrite prompt"/);
    assert.match(text, /adopt\.textContent = "Adopt correction"/);
    assert.match(text, /continueEditing\.textContent = "Continue in Qwen Editor"/);
    assert.match(text, /this\.ensureRemoteCredits\(controller\.signal, onlineVision \? "region-inpaint" : "prompt-chat"\)/);
    assert.match(text, /this\.runVisionBytes\([\s\S]*?controller\.signal[\s\S]*?\)/);
    assert.match(text, /this\.requestPromptChat\(\[\{role: "user", content: editRequest\}\], controller\.signal\)/);
    assert.match(text, /image\.naturalWidth \/ canvas\.width/);
    assert.match(text, /1600 \/ Math\.max\(sourceWidth, sourceHeight\)/);
    assert.match(text, /Treat the selected-region evidence as authoritative only for the visible region it describes/);
    assert.match(text, /Do not mention the crop, mask, evidence, editing process, or these instructions/);
    assert.match(text, /Online region inpaint needs 4 credits/);
    assert.match(text, /failed Vision inspection refunds its 3-credit reservation/);

    const inpaint = method(text, "    buildRegionInpaintPanel(", "    createJobProductTabs(");
    assert.match(inpaint, /results\.hidden = true/);
    assert.match(inpaint, /resultActions\.hidden = true/);
    assert.match(inpaint, /adopt\.addEventListener\("click"/);
    assert.match(inpaint, /onAdopt\?\.\(proposedPrompt\)/);
    const runHandler = inpaint.slice(inpaint.indexOf("run.addEventListener"));
    const adoptHandlerIndex = inpaint.indexOf("adopt.addEventListener");
    const runHandlerIndex = inpaint.indexOf("run.addEventListener");
    assert.ok(adoptHandlerIndex >= 0 && adoptHandlerIndex < runHandlerIndex);
    assert.doesNotMatch(runHandler, /onAdopt\?\.\(/, "a completed inference must wait for explicit adoption");
    assert.match(inpaint, /parentSignal\?\.addEventListener\?\.\("abort", abortFromParent/);
    assert.match(inpaint, /parentSignal\?\.removeEventListener\?\.\("abort", abortFromParent\)/);
}

const promptChat = method(source, "    async requestPromptChat(", "    openPromptEditor(");
assert.match(promptChat, /boundedMessages\.reduce/);
assert.match(promptChat, /messages: boundedMessages/);
assert.match(promptChat, /result\?\.credits_charged !== 1/);
assert.match(promptChat, /return Object\.freeze/);

console.log("Krea2DiscordCollector region inpaint prompt-correction tests passed.");
