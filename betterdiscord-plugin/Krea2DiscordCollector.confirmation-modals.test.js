"use strict";

const assert = require("node:assert/strict");
const Plugin = require("./Krea2DiscordCollector.plugin.js");

function fakeReact() {
    return {
        createElement(type, props, ...children) {
            return {type, props: {...(props || {}), children}};
        }
    };
}

async function capture(method, ...args) {
    const collector = new Plugin();
    let captured = null;
    collector.api = {
        React: fakeReact(),
        UI: {
            showConfirmationModal(title, content, options) {
                captured = {title, content, options};
                options.onCancel();
            }
        },
        Data: {save() {}}
    };
    await collector[method](...args);
    assert.ok(captured, `${method} must open a confirmation modal`);
    assert.equal(captured.content?.type, "div", `${method} must pass a React element`);
    assert.equal(captured.content instanceof HTMLElement, false, `${method} must not pass a native DOM node`);
    return captured;
}

async function run() {
    global.HTMLElement ||= class HTMLElement {};

    const contribution = await capture("confirmPrivacyReceipt");
    assert.equal(contribution.title, "Contribute generated prompts to Krea2?");
    assert.equal(contribution.options.confirmText, "I agree");
    assert.equal(contribution.options.cancelText, "Keep local only");

    const diagnostics = await capture("confirmDiagnosticReceipt");
    assert.equal(diagnostics.title, "Share failed Vision diagnostics with Krea2?");

    const oauth = await capture("confirmRemoteOAuth");
    assert.equal(oauth.title, "Connect Discord for Online API");

    const purchase = await capture("confirmCreditPurchase", {available_credits: 0}, "image");
    assert.equal(purchase.title, "Purchase Online API credits");
    assert.equal(purchase.options.confirmText, "Open Bitcoin checkout");

    const fallback = Plugin.helpers.buildConfirmationModalContent(
        {},
        ["Paragraph"],
        ["Bullet"]
    );
    assert.deepEqual(fallback, ["Paragraph", "• Bullet"]);

    console.log("Krea2DiscordCollector confirmation modal React-contract tests passed.");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
