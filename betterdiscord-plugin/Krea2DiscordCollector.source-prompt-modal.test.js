"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Plugin = require("./Krea2DiscordCollector.plugin.js");

class FakeElement {
    constructor(tagName, ownerDocument) {
        this.tagName = String(tagName).toUpperCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.parentElement = null;
        this.attributes = new Map();
        this.listeners = new Map();
        this.dataset = {};
        this.style = {};
        this.className = "";
        this.textContent = "";
        this.value = "";
        this.hidden = false;
        this.isConnected = true;
    }

    append(...children) {
        for (const child of children) {
            child.parentElement = this;
            child.isConnected = true;
            this.children.push(child);
        }
    }

    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
        this.isConnected = false;
    }

    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    async dispatch(type, event = {}) {
        for (const listener of this.listeners.get(type) || []) await listener({target: this, ...event});
    }
    focus() { this.ownerDocument.activeElement = this; }
}

class FakeDocument {
    constructor() {
        this.activeElement = null;
        this.listeners = new Map();
        this.body = new FakeElement("body", this);
        this.clipboardText = "";
        this.defaultView = {
            navigator: {
                clipboard: {
                    writeText: async value => { this.clipboardText = value; }
                }
            }
        };
    }

    createElement(tagName) { return new FakeElement(tagName, this); }
    getElementById(id) { return findElement(this.body, element => element.id === id); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
}

function findElement(root, predicate) {
    if (predicate(root)) return root;
    for (const child of root.children || []) {
        const found = findElement(child, predicate);
        if (found) return found;
    }
    return null;
}

function findAll(root, predicate, found = []) {
    if (predicate(root)) found.push(root);
    for (const child of root.children || []) findAll(child, predicate, found);
    return found;
}

async function run() {
    const modalDocument = new FakeDocument();
    const collector = new Plugin();
    collector.historyRoot = {ownerDocument: modalDocument};
    collector.api = {
        UI: {
            showConfirmationModal() {
                throw new Error("native DOM must never be passed into BetterDiscord's React confirmation modal");
            }
        }
    };
    collector.toast = () => {};
    const prompt = "A detailed Krea2 source prompt preserving pose, outfit, light, shadow, and camera angle.";

    const overlay = collector.showMetadataPromptModal([{prompt, source: "embedded image metadata"}]);
    assert.equal(overlay.id, "krea2-discord-source-prompt-modal");
    assert.equal(modalDocument.body.children.includes(overlay), true);
    const dialog = findElement(overlay, element => element.getAttribute?.("role") === "dialog");
    assert.ok(dialog);
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.equal(dialog.getAttribute("aria-label"), "Source prompt found");
    const textarea = findElement(overlay, element => element.tagName === "TEXTAREA");
    assert.ok(textarea);
    assert.equal(textarea.value, prompt);
    assert.equal(textarea.readOnly, true);
    assert.equal(findAll(overlay, element => element.className === "krea2-product-tab").length, 0);
    assert.equal(findElement(overlay, element => element.className === "krea2-product-tabs"), null, "one source prompt must not show a redundant tab strip");
    assert.equal(typeof collector.sourcePromptModalCleanup, "function");
    assert.equal(modalDocument.listeners.has("keydown"), true);

    const copy = findElement(overlay, element => element.tagName === "BUTTON" && element.textContent === "Copy prompt");
    assert.ok(copy);
    await copy.dispatch("click");
    assert.equal(modalDocument.clipboardText, prompt);
    assert.equal(copy.textContent, "Copied");

    const escape = modalDocument.listeners.get("keydown");
    escape({key: "Escape"});
    assert.equal(modalDocument.body.children.includes(overlay), false);
    assert.equal(collector.sourcePromptModalCleanup, null);
    assert.equal(modalDocument.listeners.has("keydown"), false);

    const second = `${prompt} Warm rim light and a lower three-quarter camera position.`;
    const multi = collector.showMetadataPromptModal([
        {prompt, source: "embedded image metadata"},
        {prompt: second, source: "parameters.yaml"}
    ]);
    const tabs = findAll(multi, element => element.className === "krea2-product-tab");
    assert.equal(tabs.length, 2);
    await tabs[1].dispatch("click");
    assert.equal(findElement(multi, element => element.tagName === "TEXTAREA").value, second);
    assert.equal(findElement(multi, element => element.dataset?.primary === "true").textContent, "Copy prompt 2");
    collector.sourcePromptModalCleanup();

    const built = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.js"), "utf8");
    const start = built.indexOf("    showMetadataPromptModal(");
    const end = built.indexOf("\n    queueMetadataProbe(", start);
    const method = built.slice(start, end);
    assert.ok(method.length > 0);
    assert.doesNotMatch(method, /showConfirmationModal/);
    assert.match(method, /SOURCE_PROMPT_MODAL_ID/);
    assert.match(method, /No Vision model ran, no credits were used/);
    assert.doesNotMatch(method, /requestVisionPrompt|issueVisionSession|enqueueVisionAnalysisAfterMetadata/);
    console.log("Krea2DiscordCollector native source-prompt modal tests passed.");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
