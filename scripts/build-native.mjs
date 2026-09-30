#!/usr/bin/env node
/*
 * Builds www/ — the web files bundled into the Android app — from public/.
 *
 *   MU_SERVER_ORIGIN=https://maps.example.com node scripts/build-native.mjs
 *   (or: node scripts/build-native.mjs --origin https://maps.example.com)
 *
 * public/ stays exactly what the website serves. In the app the pages load
 * from https://localhost, so this build:
 *   - points Socket.IO and /config.js at your server (MU_SERVER_ORIGIN),
 *   - adds the Capacitor runtime and the plugins' browser bundles
 *     (www/vendor/), plus js/native/shims.js (speech + Bluetooth on native
 *     plugins) before the app scripts and js/native/bridge.js (background
 *     location, Bluetooth proximity) after them,
 *   - leaves the service worker out (the files are inside the app already).
 * Then run `npx cap sync android`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const WWW = path.join(ROOT, "www");
const argOrigin = (() => { const i = process.argv.indexOf("--origin"); return i > 0 ? process.argv[i + 1] : null; })();
const origin = String(argOrigin || process.env.MU_SERVER_ORIGIN || "").replace(/\/+$/, "");
const allowHttp = process.argv.includes("--allow-http");

function fail(msg) { console.error(`build-native: ${msg}`); process.exit(1); }
if (!origin) fail("set MU_SERVER_ORIGIN (e.g. https://maps.example.com) or pass --origin");
let u;
try { u = new URL(origin); } catch { fail(`"${origin}" is not a URL`); }
if (u.pathname !== "/" || u.search || u.hash) fail("MU_SERVER_ORIGIN must be just scheme://host[:port], no path");
if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) fail("MU_SERVER_ORIGIN must be https:// (Android blocks plain http by default; --allow-http is for local testing only)");

// Browser bundles of @capacitor/core and the plugins (no bundler needed).
const VENDOR = [
    { from: "@capacitor/core/dist/capacitor.js", to: "capacitor.js", required: true },
    { from: "@capgo/background-geolocation/dist/plugin.js", to: "background-geolocation.js", required: true },
    { from: "@capacitor-community/bluetooth-le/dist/plugin.js", to: "bluetooth-le.js", required: true },
    { from: "@capacitor-community/text-to-speech/dist/plugin.js", to: "text-to-speech.js", required: true },
    { from: "@capacitor-community/speech-recognition/dist/plugin.js", to: "speech-recognition.js", required: false }
];

// ---- 1. fresh copy of public/ -------------------------------------------
fs.rmSync(WWW, { recursive: true, force: true });
fs.cpSync(PUBLIC, WWW, { recursive: true, filter: (src) => path.basename(src) !== "sw.js" });

// ---- 2. vendor bundles ----------------------------------------------------
const vendorDir = path.join(WWW, "vendor");
fs.mkdirSync(vendorDir, { recursive: true });
const vendorTags = [];
for (const v of VENDOR) {
    const src = path.join(ROOT, "node_modules", v.from);
    if (!fs.existsSync(src)) {
        if (v.required) fail(`missing node_modules/${v.from} — run the npm install step from ANDROID.md`);
        console.warn(`build-native: optional ${v.from} not installed — skipping (voice commands stay off in the app)`);
        continue;
    }
    fs.copyFileSync(src, path.join(vendorDir, v.to));
    vendorTags.push(`<script src="vendor/${v.to}"></script>`);
}

// ---- 3. index.html --------------------------------------------------------
const htmlPath = path.join(WWW, "index.html");
let html = fs.readFileSync(htmlPath, "utf8");
const tagMatch = /<script src="js\/core\.js\?v=([^"]+)"><\/script>/.exec(html);
if (!tagMatch) fail("index.html: <script src=\"js/core.js?v=…\"> not found — has the page layout changed?");
const version = tagMatch[1];
function replaceOnce(find, repl, what) {
    const n = html.split(find).length - 1;
    if (n !== 1) fail(`index.html: expected exactly one ${what}, found ${n}`);
    html = html.replace(find, repl);
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
replaceOnce('<script src="/socket.io/socket.io.js"></script>',
    `<script>window.MU_SERVER_ORIGIN = ${JSON.stringify(origin)};</script>\n<script src="${esc(origin)}/socket.io/socket.io.js"></script>`,
    "Socket.IO client tag");
replaceOnce('<script src="/config.js"></script>', `<script src="${esc(origin)}/config.js"></script>`, "/config.js tag");
replaceOnce('<script src="/shell.js"></script>',
    `<!-- Android app: Capacitor runtime + plugin bundles + browser-API shims (scripts/build-native.mjs) -->\n${vendorTags.join("\n")}\n<script src="js/native/shims.js?v=${version}"></script>\n<script src="/shell.js"></script>`,
    "shell.js tag");
replaceOnce(`<script src="js/boot.js?v=${version}"></script>`,
    `<script src="js/boot.js?v=${version}"></script>\n<script src="js/native/bridge.js?v=${version}"></script>`,
    "boot.js tag");
fs.writeFileSync(htmlPath, html);

fs.writeFileSync(path.join(WWW, "native-build.json"), JSON.stringify({ origin, version, builtAt: new Date().toISOString(), vendor: vendorTags.length }, null, 2));
console.log(`build-native: www/ ready for ${origin} (app scripts v=${version}, ${vendorTags.length} native bundles). Next: npx cap sync android`);
