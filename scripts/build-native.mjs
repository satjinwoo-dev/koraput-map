#!/usr/bin/env node
/*
 * Builds www/ — the web files bundled into the Android app — from public/.
 *
 *   MU_SERVER_ORIGIN=https://maps.example.com node scripts/build-native.mjs
 *   (or: node scripts/build-native.mjs --origin https://maps.example.com)
 *   add --skip-check to build without contacting the server.
 *
 * public/ stays exactly what the website serves. In the app the pages load
 * from https://localhost, so this build:
 *   - bundles the Socket.IO client (from the server's own socket.io package)
 *     and points the connection at your server (MU_SERVER_ORIGIN) — the app
 *     always starts, even when the server can't be reached yet,
 *   - bakes the server's public settings (/api/config) into the page, so
 *     start-up never waits on the network,
 *   - adds the Capacitor runtime and the plugins' browser bundles
 *     (www/vendor/), plus js/native/shims.js (speech + Bluetooth on native
 *     plugins) before the app scripts and js/native/bridge.js (background
 *     location, Bluetooth proximity, server-link notice) after them,
 *   - rebuilds the bike catalogue first (public/bikedb/: catalog.json and
 *     the per-bike bundles, from data/bikes/), so the app ships the current one,
 *   - leaves the service worker out (the files are inside the app already),
 *   - checks that the server answers and allows the app's origin, and says
 *     exactly what to fix if not.
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
const skipCheck = process.argv.includes("--skip-check");

function fail(msg) { console.error(`build-native: ${msg}`); process.exit(1); }
const warn = (msg) => console.warn(`build-native: WARNING — ${msg}`);
if (!origin) fail("set MU_SERVER_ORIGIN (e.g. https://maps.example.com) or pass --origin");
let u;
try { u = new URL(origin); } catch { fail(`"${origin}" is not a URL`); }
if (u.pathname !== "/" || u.search || u.hash) fail("MU_SERVER_ORIGIN must be just scheme://host[:port], no path");
if (u.protocol !== "https:") {
    fail([
        `MU_SERVER_ORIGIN must be https:// — got ${origin}`,
        "  The app's pages run on https://localhost, and Android blocks an https page from",
        "  talking to a plain-http server (mixed content), so the app could never connect.",
        "  Use your deployed https server, or, to test against a server on your computer,",
        "  give it a temporary https address with a tunnel, e.g.:",
        "      npx cloudflared tunnel --url http://localhost:3000     (prints https://….trycloudflare.com)",
        "      ngrok http 3000                                          (prints https://….ngrok-free.app)",
        "  and build with that address."
    ].join("\n"));
}
if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)) {
    warn(`${u.hostname} is a local address — the phone can only reach it on the same network, and it needs a certificate the phone trusts. A tunnel (see ANDROID.md) or your deployed server is easier.`);
}

// The app's own origin as Capacitor serves it (capacitor.config.json server.*).
const appOrigin = (() => {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "capacitor.config.json"), "utf8"));
        const scheme = (cfg.server && cfg.server.androidScheme) || "https";
        const host = (cfg.server && cfg.server.hostname) || "localhost";
        return `${scheme}://${host}`;
    } catch { return "https://localhost"; }
})();

// Browser bundles of @capacitor/core and the plugins (no bundler needed).
const VENDOR = [
    { from: "@capacitor/core/dist/capacitor.js", to: "capacitor.js", required: true },
    { from: "@capgo/background-geolocation/dist/plugin.js", to: "background-geolocation.js", required: true },
    { from: "@capacitor-community/bluetooth-le/dist/plugin.js", to: "bluetooth-le.js", required: true },
    { from: "@capacitor-community/text-to-speech/dist/plugin.js", to: "text-to-speech.js", required: true },
    { from: "@capacitor-community/speech-recognition/dist/plugin.js", to: "speech-recognition.js", required: false }
];
// The Socket.IO client that matches the server (same package, same version).
const SOCKET_CLIENT = ["socket.io/client-dist/socket.io.min.js", "socket.io-client/dist/socket.io.min.js"];

// Find node_modules/<rel> the way Node does: this folder, then each parent.
// (Run in a folder without its own package.json, npm installs into the
// nearest parent project — the files are there, not here.)
const searchedDirs = [];
function findModuleFile(rel) {
    let dir = ROOT;
    for (;;) {
        const nmDir = path.join(dir, "node_modules");
        if (!searchedDirs.includes(nmDir)) searchedDirs.push(nmDir);
        const f = path.join(nmDir, rel);
        if (fs.existsSync(f)) return f;
        const up = path.dirname(dir);
        if (up === dir) return null;
        dir = up;
    }
}
function nearestPackageJson() {
    let dir = ROOT;
    for (;;) {
        if (fs.existsSync(path.join(dir, "package.json"))) return dir;
        const up = path.dirname(dir);
        if (up === dir) return null;
        dir = up;
    }
}
const pkgDir = nearestPackageJson();
if (pkgDir !== ROOT) {
    warn(pkgDir
        ? `there's no package.json in ${ROOT}, so npm installs into ${path.join(pkgDir, "node_modules")} instead. Building still works, but run this in your MapUnite project folder (the one with package.json and server.js) — npx cap needs it too.`
        : `there's no package.json in ${ROOT} or any folder above it. Run this in your MapUnite project folder (the one with package.json and server.js).`);
}

// ---- 0. talk to the server (non-fatal) ------------------------------------
async function getWithTimeout(url, opts = {}, ms = 10000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctl.signal, redirect: "manual" }); }
    finally { clearTimeout(t); }
}
let bakedConfig = null;
const check = { reachable: null, corsOk: null, config: "defaults" };
if (!skipCheck) {
    try {
        const r = await getWithTimeout(`${origin}/api/config`);
        check.reachable = true;
        if (r.ok) {
            const j = await r.json().catch(() => null);
            if (j && j.ok === true) { bakedConfig = j; check.config = "server"; }
            else warn(`${origin}/api/config didn't return MapUnite settings — is MU_SERVER_ORIGIN your MapUnite server?`);
        } else if (r.status >= 300 && r.status < 400) {
            warn(`${origin}/api/config redirects to ${r.headers.get("location")} — use the final address as MU_SERVER_ORIGIN.`);
        } else {
            warn(`${origin}/api/config answered HTTP ${r.status} — is MU_SERVER_ORIGIN your MapUnite server?`);
        }
    } catch (e) {
        check.reachable = false;
        const why = e.name === "AbortError" ? "no answer in 10 s — a sleeping free-tier server can take a minute to wake" : (e.cause && e.cause.code) || e.message;
        warn(`couldn't reach ${origin} (${why}). Building anyway with default settings; the app connects once the server is up.`);
    }
    if (check.reachable) {
        try {
            const r = await getWithTimeout(`${origin}/socket.io/?EIO=4&transport=polling&t=build`, { headers: { Origin: appOrigin } });
            const allow = r.headers.get("access-control-allow-origin");
            check.corsOk = r.ok && (allow === appOrigin || allow === "*");
            if (!r.ok) warn(`${origin}/socket.io/ answered HTTP ${r.status} — the app needs Socket.IO there.`);
            else if (!check.corsOk) warn(`the server doesn't allow the app's origin ${appOrigin} (Access-Control-Allow-Origin: ${allow || "none"}). Deploy this batch's server.js, and if you set NATIVE_APP_ORIGINS, include ${appOrigin}.`);
        } catch (e) {
            warn(`Socket.IO check failed (${e.message}).`);
        }
    }
}

// ---- 0. bike catalogue (data/bikes → public/bikedb) ----------------------
// Rebuilt every time, so the app never ships a missing or stale catalogue; the
// bundles inside the app let the bike picker work offline. No SQLite needed.
try {
    const { buildPublicOnly } = await import("./bikedb/catalog-build.mjs");
    const { art } = buildPublicOnly();
    console.log(`build-native: bike catalogue ${art.catalog.version} (${art.counts.variants} bikes, ${art.bundles.length} bundles)`);
} catch (e) {
    fail(`bike catalogue: ${e.message}`);
}

// ---- 1. fresh copy of public/ -------------------------------------------
fs.rmSync(WWW, { recursive: true, force: true });
fs.cpSync(PUBLIC, WWW, { recursive: true, filter: (src) => path.basename(src) !== "sw.js" });

// ---- 2. vendor bundles ----------------------------------------------------
const vendorDir = path.join(WWW, "vendor");
fs.mkdirSync(vendorDir, { recursive: true });
let sioFrom = null;
const sioSrc = SOCKET_CLIENT.map((p) => findModuleFile(p)).find(Boolean);
if (sioSrc) {
    fs.copyFileSync(sioSrc, path.join(vendorDir, "socket.io.min.js"));
    sioFrom = sioSrc;
} else if (!skipCheck) {
    // Not installed locally: take it from your server, which serves the exact
    // client that matches its own Socket.IO version.
    try {
        const r = await getWithTimeout(`${origin}/socket.io/socket.io.min.js`, {}, 15000);
        const body = r.ok ? await r.text() : "";
        if (r.ok && body.length > 10000 && /\bio\b/.test(body)) {
            fs.writeFileSync(path.join(vendorDir, "socket.io.min.js"), body);
            sioFrom = `${origin}/socket.io/socket.io.min.js`;
        }
    } catch { /* falls through to the error below */ }
}
if (!sioFrom) {
    fail([
        "couldn't find the Socket.IO client (socket.io/client-dist/socket.io.min.js).",
        "  Looked in:",
        ...searchedDirs.map((d) => `    ${d}`),
        skipCheck ? "  (and --skip-check stopped it fetching the client from your server)" : `  and couldn't download it from ${origin}/socket.io/socket.io.min.js either.`,
        "  Fix: in your MapUnite project folder (the one with package.json), run `npm install`,",
        "  or run `npm install socket.io@4` in this folder after `npm init -y`."
    ].join("\n"));
}
const vendorTags = [];
for (const v of VENDOR) {
    const src = findModuleFile(v.from);
    if (!src) {
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
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
replaceOnce('<script src="/socket.io/socket.io.js"></script>',
    `<script>window.MU_SERVER_ORIGIN = ${jsonForScript(origin)};</script>\n<script src="vendor/socket.io.min.js"></script>`,
    "Socket.IO client tag");
replaceOnce('<script src="/config.js"></script>',
    `<script>window.MU_CONFIG = Object.freeze(${jsonForScript(bakedConfig || {})});</script>`,
    "/config.js tag");
replaceOnce('<script src="/shell.js"></script>',
    `<!-- Android app: Capacitor runtime + plugin bundles + browser-API shims (scripts/build-native.mjs) -->\n${vendorTags.join("\n")}\n<script src="js/native/shims.js?v=${version}"></script>\n<script src="/shell.js"></script>`,
    "shell.js tag");
replaceOnce(`<script src="js/boot.js?v=${version}"></script>`,
    `<script src="js/boot.js?v=${version}"></script>\n<script src="js/native/bridge.js?v=${version}"></script>`,
    "boot.js tag");
fs.writeFileSync(htmlPath, html);

fs.writeFileSync(path.join(WWW, "native-build.json"), JSON.stringify({ origin, appOrigin, version, builtAt: new Date().toISOString(), vendor: vendorTags.length, check }, null, 2));
const settings = check.config === "server" ? "settings from server" : "default settings";
console.log(`build-native: Socket.IO client from ${sioFrom}`);
console.log(`build-native: www/ ready for ${origin} (app scripts v=${version}, ${vendorTags.length} native bundles, ${settings}${check.corsOk ? ", server allows the app ✓" : ""}). Next: npx cap sync android`);
