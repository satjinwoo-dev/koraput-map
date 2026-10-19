// The Android app's web bundle (scripts/build-native.mjs) builds from today's public/index.html:
// every tag it rewrites is found, and the app scripts land in the right order.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("build-native makes www/ from the current index.html (no server needed)", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "mu-www-"));
    try {
        const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/build-native.mjs", "--origin", "https://maps.example.test", "--skip-check", "--no-vendor", "--out", out], { cwd: ROOT, encoding: "utf8" });
        assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
        const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
        assert.match(html, /window\.MU_SERVER_ORIGIN = "https:\/\/maps\.example\.test"/);
        assert.match(html, /<script src="vendor\/socket\.io\.min\.js"><\/script>/);
        assert.ok(!html.includes('src="/socket.io/socket.io.js"'), "the server's Socket.IO tag is replaced");
        assert.ok(!html.includes('src="/config.js"'), "the server's config tag is replaced");
        const at = (s) => html.indexOf(s);
        assert.ok(at("js/native/shims.js") > 0 && at("js/native/shims.js") < at('src="/shell.js"'), "shims before shell.js");
        assert.ok(at("js/native/bridge.js") > at("js/boot.js"), "bridge after boot.js");
        assert.ok(!fs.existsSync(path.join(out, "sw.js")), "no service worker inside the app");
        // every script the page loads from js/ exists in the bundle
        for (const m of html.matchAll(/<script src="(js\/[^"?]+)/g)) assert.ok(fs.existsSync(path.join(out, m[1])), `missing ${m[1]}`);
        for (const m of html.matchAll(/<link rel="stylesheet" href="(js\/[^"?]+)/g)) assert.ok(fs.existsSync(path.join(out, m[1])), `missing ${m[1]}`);
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
