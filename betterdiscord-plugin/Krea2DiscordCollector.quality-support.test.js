"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Plugin = require("./Krea2DiscordCollector.plugin.js");

const {
    auditPromptContradictions,
    buildRedactedDiagnosticReport,
    diagnosticForHistoryJob,
    normalizePoseCheck,
    remotePreflightSummary
} = Plugin.helpers;

const pose = normalizePoseCheck({
    subject_count: 1,
    primary_posture: "standing",
    pelvis_support: "not_supported",
    pelvis_support_surface: "none",
    left_foot_weight_bearing: true,
    left_foot_surface: "skateboard deck",
    right_foot_weight_bearing: true,
    right_foot_surface: "asphalt",
    knee_flexion: "slight",
    hip_height_relative_to_knees: "above",
    other_weight_bearing_support: "none",
    camera_view: "steep overhead selfie"
});
assert.equal(pose.primary_posture, "standing");
assert.equal(pose.left_foot_surface, "skateboard deck");
assert.throws(() => normalizePoseCheck({...pose, primary_posture: "floating"}), /invalid posture/);

const contradictions = auditPromptContradictions(
    "One adult woman is sitting and standing. A high-angle and low-angle camera view shows bright daylight at midnight.",
    pose
);
assert.ok(contradictions.some(item => item.code === "standing-and-sitting"));
assert.ok(contradictions.some(item => item.code === "pose-vs-receipt"));
assert.ok(contradictions.some(item => item.code === "camera-angle-conflict"));

const job = {
    id: "a".repeat(32),
    status: "error",
    requested_model: "vast::gemma4-26b-a4b-heretic-q3_k_l",
    stage: "Remote GPU did not become ready",
    public_error: "Remote GPU capacity timed out."
};
const diagnostic = diagnosticForHistoryJob(job);
assert.equal(diagnostic.support_id, "a".repeat(32));
assert.equal(diagnostic.error_code, "remote_gpu_capacity");
assert.match(diagnostic.credit_outcome, /refunded automatically/);
const report = buildRedactedDiagnosticReport(job);
assert.match(report, /Support ID: a{32}/);
assert.doesNotMatch(report, /Source prompt:|Image SHA-256:/i);

const preflight = remotePreflightSummary({
    available_credits: 117,
    credits_per_image: 3,
    credits_per_prompt_chat: 1,
    worker_state: "cold-standby",
    estimated_wait_seconds_min: 25,
    estimated_wait_seconds_max: 120,
    failed_or_cancelled_refunded: true
}, "image");
assert.equal(preflight.cost, 3);
assert.match(preflight.text, /25–120s estimate/);
assert.match(preflight.text, /Failed or cancelled work is refunded/);

const source = fs.readFileSync(path.join(__dirname, "Krea2DiscordCollector.plugin.js"), "utf8");
assert.match(source, /Pose Inspector & contradiction check/);
assert.match(source, /Ask Qwen about this prompt · 1 credit/);
assert.match(source, /Download redacted \.txt/);
assert.match(source, /Prompt provenance \(visible; never injected into the prompt\)/);
assert.match(source, /\["Diagnostics", "errors"\]/);

console.log("BetterDiscord prompt quality, audit, preflight, provenance, and diagnostics tests passed.");
