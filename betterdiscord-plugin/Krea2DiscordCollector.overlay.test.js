"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Plugin = require("./Krea2DiscordCollector.plugin.js");

function focusable(name) {
    return {
        name,
        hidden: false,
        isConnected: true,
        attributes: new Map(),
        focusCount: 0,
        focus() {
            this.focusCount += 1;
            this.ownerDocument.activeElement = this;
        },
        getAttribute(key) { return this.attributes.get(key) ?? null; },
        setAttribute(key, value) { this.attributes.set(key, String(value)); },
        getClientRects() { return this.hidden ? [] : [{}]; }
    };
}

function overlayHarness({collapsed = false} = {}) {
    const collector = new Plugin();
    const attributes = new Map([["aria-label", "KREA2 prompt history"]]);
    const document = {
        activeElement: null,
        modals: [],
        listeners: new Map(),
        addEventListener(type, listener, capture) { this.listeners.set(type, {listener, capture}); },
        removeEventListener(type, listener, capture) {
            const current = this.listeners.get(type);
            if (current?.listener === listener && current.capture === capture) this.listeners.delete(type);
        },
        querySelectorAll(selector) { return selector === '[aria-modal="true"]' ? this.modals : []; }
    };
    const launcher = focusable("launcher");
    const expand = focusable("expand");
    const refresh = focusable("refresh");
    const hide = focusable("hide");
    const close = focusable("close");
    const firstTab = focusable("first-tab");
    const lastTab = focusable("last-tab");
    for (const element of [launcher, expand, refresh, hide, close, firstTab, lastTab]) element.ownerDocument = document;
    const root = {
        dataset: {collapsed: collapsed ? "true" : "false", overlay: "false"},
        ownerDocument: document,
        setAttribute(key, value) { attributes.set(key, String(value)); },
        getAttribute(key) { return attributes.get(key) ?? null; },
        removeAttribute(key) { attributes.delete(key); },
        querySelector(selector) {
            if (selector === '.krea2-history-collapse-launcher') return launcher;
            if (selector === '[data-action="expand-overlay"]') return expand;
            if (selector === '[data-action="hide-overlay"]') return hide;
            if (selector === '.krea2-history-rail-close') return close;
            return null;
        },
        querySelectorAll() { return [refresh, hide, firstTab, lastTab]; },
        contains(element) { return [launcher, expand, refresh, hide, close, firstTab, lastTab].includes(element); }
    };
    collector.settings = {...Plugin.helpers.DEFAULT_SETTINGS, historyCollapsed: collapsed, historyWidth: 337};
    collector.historyRoot = root;
    collector.api = {Data: {save() { throw new Error("overlay must not persist settings"); }}};
    collector.renderHistoryRail = currentRoot => {
        currentRoot.dataset.overlay = collector.historyOverlayOpen ? "true" : "false";
        expand.hidden = collector.historyOverlayOpen;
        expand.setAttribute("aria-expanded", collector.historyOverlayOpen ? "true" : "false");
        hide.hidden = !collector.historyOverlayOpen;
        close.hidden = collector.historyOverlayOpen;
    };
    const prohibitedCalls = [
        "refreshHistory",
        "requestVisionPrompt",
        "issueVisionSession",
        "queueInterrogateSelection",
        "analyzeWithVision"
    ];
    const callCounts = Object.fromEntries(prohibitedCalls.map(name => [name, 0]));
    for (const name of prohibitedCalls) collector[name] = () => { callCounts[name] += 1; };
    return {collector, root, document, launcher, expand, refresh, hide, close, firstTab, lastTab, callCounts};
}

{
    const harness = overlayHarness();
    harness.document.activeElement = harness.expand;
    assert.equal(harness.collector.setHistoryOverlay(true), true);
    assert.equal(harness.collector.historyOverlayOpen, true);
    assert.equal(harness.root.dataset.overlay, "true");
    assert.equal(harness.root.dataset.collapsed, "false");
    assert.equal(harness.root.getAttribute("role"), "dialog");
    assert.equal(harness.root.getAttribute("aria-modal"), "true");
    assert.equal(harness.root.getAttribute("aria-label"), "Discord Vision Inbox overlay");
    assert.equal(harness.hide.hidden, false);
    assert.equal(harness.hide.focusCount, 1);
    assert.equal(harness.expand.getAttribute("aria-expanded"), "true");
    assert.equal(harness.document.listeners.get("keydown")?.capture, true, "the owned keyboard trap must capture events outside the root");
    assert.equal(harness.collector.setHistoryOverlay(true), false, "repeated open must be idempotent");
    assert.deepEqual(Object.values(harness.callCounts), [0, 0, 0, 0, 0]);

    assert.equal(harness.collector.setHistoryOverlay(false), true);
    assert.equal(harness.collector.historyOverlayOpen, false);
    assert.equal(harness.root.dataset.overlay, "false");
    assert.equal(harness.root.getAttribute("role"), null);
    assert.equal(harness.root.getAttribute("aria-modal"), null);
    assert.equal(harness.root.getAttribute("aria-label"), "KREA2 prompt history");
    assert.equal(harness.document.listeners.has("keydown"), false, "Hide must remove the document-level keyboard trap");
    assert.equal(harness.expand.focusCount, 1, "Hide must restore focus to the opener");
    assert.equal(harness.root.dataset.collapsed, "false");
    assert.equal(harness.collector.settings.historyWidth, 337);
    assert.equal(harness.collector.setHistoryOverlay(false), false, "repeated hide must be idempotent");
}

{
    const harness = overlayHarness({collapsed: true});
    harness.document.activeElement = harness.launcher;
    harness.collector.setHistoryOverlay(true);
    assert.equal(harness.root.dataset.collapsed, "true", "fullscreen must not alter the compact rail preference");
    harness.collector.setHistoryOverlay(false);
    assert.equal(harness.launcher.focusCount, 1, "a previously collapsed rail returns focus to its launcher");
    assert.equal(harness.collector.settings.historyCollapsed, true);
}

{
    const harness = overlayHarness();
    harness.document.activeElement = harness.expand;
    harness.collector.setHistoryOverlay(true);
    const escape = {
        key: "Escape",
        prevented: 0,
        stopped: 0,
        preventDefault() { this.prevented += 1; },
        stopPropagation() { this.stopped += 1; }
    };
    assert.equal(harness.collector.handleHistoryOverlayKeydown(escape), true);
    assert.equal(harness.collector.historyOverlayOpen, false);
    assert.equal(escape.prevented, 1);
    assert.equal(escape.stopped, 1);
    assert.deepEqual(Object.values(harness.callCounts), [0, 0, 0, 0, 0]);

    harness.collector.setHistoryOverlay(true);
    assert.equal(harness.collector.handleHistoryOverlayKeydown({key: "ArrowDown"}), false);
    assert.equal(harness.collector.historyOverlayOpen, true);
}

{
    const harness = overlayHarness();
    harness.document.activeElement = harness.expand;
    harness.collector.setHistoryOverlay(true);
    harness.document.modals = [{name: "prompt-details-modal"}];
    const escape = {key: "Escape", preventDefault() { throw new Error("nested modal Escape must not be captured"); }};
    assert.equal(harness.collector.handleHistoryOverlayKeydown(escape), false);
    assert.equal(harness.collector.historyOverlayOpen, true, "a prompt-details dialog must close before the Inbox overlay");
    harness.document.modals = [];
    assert.equal(harness.collector.handleHistoryOverlayKeydown({key: "Escape", preventDefault() {}, stopPropagation() {}}), true);
    assert.equal(harness.collector.historyOverlayOpen, false);
}

{
    const harness = overlayHarness();
    harness.document.activeElement = harness.expand;
    harness.collector.setHistoryOverlay(true);
    harness.document.activeElement = harness.lastTab;
    const tab = {key: "Tab", shiftKey: false, preventDefault() {}, stopPropagation() {}};
    assert.equal(harness.collector.handleHistoryOverlayKeydown(tab), true);
    assert.equal(harness.refresh.focusCount, 1, "Tab from the last control wraps to the first visible control");
    harness.document.activeElement = harness.refresh;
    assert.equal(harness.collector.handleHistoryOverlayKeydown({...tab, shiftKey: true}), true);
    assert.equal(harness.lastTab.focusCount, 1, "Shift+Tab from the first control wraps to the last");
}

const built = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.js"), "utf8");
assert.match(built, /@version 0\.17\.0/);
assert.match(built, /brandBar\.className = "krea2-history-brand-bar"/);
assert.match(built, /brandBar\.setAttribute\("aria-label", "Krea2 Vision"\)/);
assert.match(built, /brandTitle\.textContent = "Krea2 Vision"/);
assert.match(built, /brandPromptEditor\.textContent = "✦ Qwen Prompt Editor"/);
assert.match(built, /brandBar\.append\(brandMark, brandTitle, brandPromptEditor\)/);
assert.match(built, /expanded\.append\(brandBar, header, summary, averageQueue, scheduler, tabs, libraryTools, completion, interrogate, list, pagination\)/);
assert.match(built, /actions\.append\(expandOverlay, refresh, hideOverlay, close\)/);
assert.match(built, /\.krea2-history-brand-bar \{[\s\S]*?height: 34px;[\s\S]*?background: #070809;/);
assert.match(built, /dataset\.action = "expand-overlay"/);
assert.match(built, /dataset\.action = "hide-overlay"/);
assert.match(built, /Expand Discord Vision Inbox/);
assert.match(built, /Hide Discord Vision Inbox overlay/);
assert.match(built, /#\$\{HISTORY_ROOT_ID\}\[data-overlay="true"\] \{/);
assert.match(built, /inset: 0;[\s\S]*?width: 100vw;[\s\S]*?background:/);
assert.match(built, /#\$\{HISTORY_ROOT_ID\}:not\(\[data-overlay="true"\]\) \.krea2-history-expanded/);
assert.match(built, /modalDocument\.addEventListener\("keydown", this\.historyOverlayKeyHandler, true\)/);
assert.match(built, /historyOverlayDocument\?\.removeEventListener\?\.\("keydown", this\.historyOverlayKeyHandler, true\)/);
assert.match(built, /view\.matchMedia\?\.\("\(max-width: 920px\)"\)\?\.matches[\s\S]*?this\.setHistoryOverlay\(true\)/);
assert.match(built, /grid-template-areas:\s*"brand brand"\s*"header header"/);
assert.match(built, /grid-template-rows: auto auto auto auto auto auto auto auto minmax\(0, 1fr\) auto; grid-template-areas: "brand" "header"/);
assert.match(built, /this\.setHistoryOverlay\(false, \{restoreFocus: false\}\);[\s\S]*?this\.historyRoot\?\.remove\(\)/);
assert.match(built, /this\.feedbackModalCleanup\?\.\(\);[\s\S]*?this\.feedbackModalCleanup = null;[\s\S]*?this\.historyRoot\?\.remove\(\)/);
assert.equal(Object.hasOwn(Plugin.helpers.DEFAULT_SETTINGS, "historyOverlayOpen"), false);

const overlayMethod = built.slice(
    built.indexOf("    setHistoryOverlay(open,"),
    built.indexOf("    beginHistoryResize(event)")
);
assert.ok(overlayMethod.length > 0);
for (const forbidden of ["Data.save", "refreshHistory", "requestVisionPrompt", "issueVisionSession", "queueInterrogateSelection", "analyzeWithVision"]) {
    assert.doesNotMatch(overlayMethod, new RegExp(forbidden.replace(".", "\\.")));
}

console.log("Krea2DiscordCollector fullscreen overlay tests passed.");
