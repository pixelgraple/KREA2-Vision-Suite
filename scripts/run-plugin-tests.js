"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {spawnSync} = require("node:child_process");

const repositoryRoot = path.resolve(__dirname, "..");
const pluginRoot = path.join(repositoryRoot, "betterdiscord-plugin");
const tests = fs.readdirSync(pluginRoot)
    .filter(name => /^Krea2DiscordCollector.*\.test\.js$/.test(name))
    .sort();

if (!tests.length) throw new Error("No BetterDiscord plugin tests were found.");

for (const name of tests) {
    process.stdout.write(`\n=== ${name} ===\n`);
    const result = spawnSync(process.execPath, [path.join(pluginRoot, name)], {
        cwd: repositoryRoot,
        stdio: "inherit"
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write(`\n${tests.length} BetterDiscord test files passed.\n`);
