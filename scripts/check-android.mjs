#!/usr/bin/env node
/*
 * Checks the Android project against what MapUnite needs, and says exactly
 * what to fix. Run it from the project folder after `npx cap sync android`:
 *
 *   node scripts/check-android.mjs          (or: npm run android:check)
 *
 * Reads only: capacitor.config.json, node_modules/*, android/… — changes nothing.
 * Exit code 1 if anything must be fixed (✗), 0 if only advice (!) or all good.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = { ok: 0, warn: 0, fail: 0 };
const ok = (msg) => { results.ok++; console.log(`  ✓ ${msg}`); };
const warn = (msg, fix) => { results.warn++; console.log(`  ! ${msg}${fix ? `\n      → ${fix}` : ""}`); };
const fail = (msg, fix) => { results.fail++; console.log(`  ✗ ${msg}${fix ? `\n      → ${fix}` : ""}`); };
const section = (t) => console.log(`\n${t}`);
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const rel = (p) => path.relative(ROOT, p) || ".";

// node_modules lookup the way Node does (this folder, then parents).
function findPkg(name) {
    let dir = ROOT;
    for (;;) {
        const f = path.join(dir, "node_modules", name, "package.json");
        if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
        const up = path.dirname(dir);
        if (up === dir) return null;
        dir = up;
    }
}
const major = (v) => Number(String(v || "").split(".")[0]) || 0;
const atLeast = (v, want) => {
    const a = String(v || "0").split(".").map(Number), b = want.split(".").map(Number);
    for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
    return true;
};

// ---------------------------------------------------------------------------
section("Capacitor config (capacitor.config.json)");
let cfg = null;
try { cfg = JSON.parse(read(path.join(ROOT, "capacitor.config.json")) || "null"); } catch { cfg = null; }
if (fs.existsSync(path.join(ROOT, "capacitor.config.ts"))) warn("capacitor.config.ts exists next to capacitor.config.json — the .ts file wins and ours is ignored", "delete capacitor.config.ts");
if (!cfg) fail("capacitor.config.json missing or not valid JSON", "copy it from the MapUnite Android kit");
const appId = (cfg && cfg.appId) || "com.mapunite.app";
if (cfg) {
    cfg.webDir === "www" ? ok("webDir is www") : fail(`webDir is "${cfg.webDir}"`, 'set "webDir": "www"');
    const scheme = cfg.server && cfg.server.androidScheme;
    !scheme || scheme === "https" ? ok("app origin is https://localhost") : warn(`androidScheme is "${scheme}"`, 'use "https" (the server, Maps key and NATIVE_APP_ORIGINS expect https://localhost)');
    cfg.android && cfg.android.useLegacyBridge === true ? ok("android.useLegacyBridge is true (background location updates keep reaching the page)")
        : fail("android.useLegacyBridge is not true", 'set "android": { "useLegacyBridge": true } — without it location updates to the page stop after ~5 min in the background');
    cfg.android && cfg.android.webContentsDebuggingEnabled ? warn("webContentsDebuggingEnabled is true", "fine for testing; set it to false before a release build") : ok("WebView debugging off");
}

// ---------------------------------------------------------------------------
section("npm packages");
const pk = (n) => findPkg(n);
const core = pk("@capacitor/core"), android = pk("@capacitor/android"), cli = pk("@capacitor/cli");
if (!core || !android || !cli) fail("Capacitor packages missing", "npm install @capacitor/core@^8 @capacitor/android@^8 && npm install -D @capacitor/cli@^8");
else if (major(core.version) !== 8 || major(android.version) !== 8 || major(cli.version) !== 8) fail(`Capacitor versions differ: core ${core.version}, android ${android.version}, cli ${cli.version}`, "install all three at ^8");
else ok(`Capacitor ${core.version}`);
const bg = pk("@capgo/background-geolocation");
if (!bg) fail("@capgo/background-geolocation not installed", "npm install @capgo/background-geolocation@^8");
else if (!atLeast(bg.version, "8.2.0")) fail(`@capgo/background-geolocation ${bg.version} is too old for native location POSTs`, "npm install @capgo/background-geolocation@^8");
else ok(`@capgo/background-geolocation ${bg.version}${atLeast(bg.version, "8.5.0") ? " (network fallback in tunnels: on)" : " (network fallback arrives with 8.5 — fine without)"}`);
const ble = pk("@capacitor-community/bluetooth-le");
!ble ? fail("@capacitor-community/bluetooth-le not installed", "npm install @capacitor-community/bluetooth-le@^8") : major(ble.version) < 8 ? fail(`bluetooth-le ${ble.version} is for an older Capacitor`, "npm install @capacitor-community/bluetooth-le@^8") : ok(`bluetooth-le ${ble.version}`);
const tts = pk("@capacitor-community/text-to-speech");
!tts ? fail("@capacitor-community/text-to-speech not installed (spoken alerts stay silent)", "npm install @capacitor-community/text-to-speech@^8") : ok(`text-to-speech ${tts.version}`);
const sr = pk("@capacitor-community/speech-recognition");
!sr ? warn("speech-recognition not installed — voice commands are off in the app", "optional: npm install @capacitor-community/speech-recognition@^7") : ok(`speech-recognition ${sr.version}${major(sr.version) < 8 ? " (built for Capacitor 7; works on 8)" : ""}`);
const sio = pk("socket.io");
sio ? ok(`socket.io ${sio.version} (client bundled into the app)`) : warn("socket.io not found in node_modules", "build-native.mjs will download the client from your server instead");

// ---------------------------------------------------------------------------
section("Android project (android/)");
const A = path.join(ROOT, "android");
const MAIN = path.join(A, "app", "src", "main");
if (!fs.existsSync(A)) {
    fail("android/ folder not found", "run: npx cap add android");
    finish();
}

// Java
const javaDir = path.join(MAIN, "java", ...appId.split("."));
const mainAct = read(path.join(javaDir, "MainActivity.java"));
const plugin = read(path.join(javaDir, "MapUniteNativePlugin.java"));
if (!plugin) fail(`MapUniteNativePlugin.java not in ${rel(javaDir)}`, `copy native/android/MapUniteNativePlugin.java there`);
else {
    const pkgLine = (plugin.match(/^\s*package\s+([\w.]+)\s*;/m) || [])[1];
    pkgLine === appId ? ok("MapUniteNativePlugin.java present, package matches appId") : fail(`MapUniteNativePlugin.java says package ${pkgLine}, appId is ${appId}`, `change its first line to: package ${appId};`);
    plugin.includes("stopBackgroundTracking") && plugin.includes("keepAwake")
        ? ok("MapUniteNativePlugin.java is the current version")
        : fail("MapUniteNativePlugin.java is an older version (no stopBackgroundTracking / keepAwake)", "copy the new native/android/MapUniteNativePlugin.java over it");
}
if (!mainAct) fail(`MainActivity.java not found in ${rel(javaDir)}`, "is appId in capacitor.config.json the same one you used for npx cap add android?");
else /registerPlugin\(\s*MapUniteNativePlugin\.class\s*\)/.test(mainAct) && mainAct.indexOf("registerPlugin") < mainAct.indexOf("super.onCreate")
    ? ok("MainActivity registers MapUniteNativePlugin before super.onCreate")
    : fail("MainActivity doesn't register MapUniteNativePlugin (before super.onCreate)", "copy native/android/MainActivity.java over it");

// Manifest
const manifest = read(path.join(MAIN, "AndroidManifest.xml"));
if (!manifest) fail("android/app/src/main/AndroidManifest.xml not found");
else {
    const has = (perm) => new RegExp(`<uses-permission[^>]+android:name="android\\.permission\\.${perm}"`).test(manifest);
    for (const [perm, why] of [["BLUETOOTH_ADVERTISE", "the trip proximity beacon"], ["ACCESS_NETWORK_STATE", "online/offline detection in the WebView"],
        ["RECORD_AUDIO", "voice squad, calls and voice commands"], ["CAMERA", "dashcam"], ["MODIFY_AUDIO_SETTINGS", "voice calls"], ["INTERNET", "everything"]]) {
        has(perm) ? ok(`${perm}`) : fail(`${perm} missing (${why})`, "paste PART A of native/android/AndroidManifest.additions.xml");
    }
    has("VIBRATE") ? ok("VIBRATE") : warn("VIBRATE missing — alert haptics won't buzz", "paste PART A of the additions");
    /android\.speech\.RecognitionService/.test(manifest) && /TTS_SERVICE/.test(manifest) ? ok("<queries> for speech recognizer + TTS engine") : warn("<queries> for RecognitionService / TTS_SERVICE missing", "paste PART A of the additions (the plugins add some, not all)");
    has("ACCESS_BACKGROUND_LOCATION") ? fail("ACCESS_BACKGROUND_LOCATION is declared", "remove it — not needed (foreground service) and it triggers Google Play's background-location review") : ok("no ACCESS_BACKGROUND_LOCATION (not needed)");
    /neverForLocation/.test(manifest) ? fail("a permission uses neverForLocation", "remove it — Android filters the trip beacons out of scans made with it") : ok("BLUETOOTH_SCAN without neverForLocation (beacons visible)");
    /xmlns:tools="http:\/\/schemas\.android\.com\/tools"/.test(manifest) ? ok("xmlns:tools declared") : fail("xmlns:tools missing on <manifest>", 'add xmlns:tools="http://schemas.android.com/tools" to the <manifest> tag');
    const svc = /<service[^>]*BackgroundGeolocationService[^>]*>/.exec(manifest);
    svc && /android:exported="false"/.test(svc[0]) && /tools:replace="[^"]*android:exported/.test(svc[0])
        ? ok("background-location service closed to other apps (exported=false)")
        : fail("background-location service is still exported to other apps", "paste PART B of the additions inside <application>");
    const appEnd = manifest.indexOf("</application>"), appStart = manifest.indexOf("<application");
    if (svc && appStart >= 0 && (svc.index < appStart || svc.index > appEnd)) fail("the <service> override is outside <application>", "move PART B inside <application> … </application>");
}

// Resources
const strings = read(path.join(MAIN, "res", "values", "strings.xml")) || "";
const iconRef = (strings.match(/name="capacitor_background_geolocation_notification_icon">\s*([^<\s]+)\s*</) || [])[1];
strings.includes("capacitor_background_geolocation_notification_channel_name") ? ok("notification channel name set") : warn("notification strings not added (the notification says “Background Tracking”)", "paste native/android/strings.additions.xml into res/values/strings.xml");
if (iconRef) {
    const [type, name] = iconRef.split("/");
    const resDir = path.join(MAIN, "res");
    const found = fs.existsSync(resDir) && fs.readdirSync(resDir).some((d) => d.startsWith(type) && fs.existsSync(path.join(resDir, d)) &&
        fs.readdirSync(path.join(resDir, d)).some((f) => f.replace(/\.(xml|png|webp)$/, "") === name));
    found ? ok(`notification icon ${iconRef} exists`)
        : fail(`strings.xml points the notification at ${iconRef}, which doesn't exist — Android stops the app when a ride starts`, `copy native/android/res/drawable/ic_stat_mapunite.xml to android/app/src/main/res/drawable/`);
} else ok("notification icon: plugin default (launcher icon)");

// SDK levels
const vars = read(path.join(A, "variables.gradle")) || "";
const num = (k) => Number((vars.match(new RegExp(`${k}\\s*=\\s*(\\d+)`)) || [])[1]) || 0;
if (vars) {
    num("minSdkVersion") >= 24 ? ok(`minSdkVersion ${num("minSdkVersion")}`) : fail(`minSdkVersion ${num("minSdkVersion")}`, "Capacitor 8 needs 24+");
    num("compileSdkVersion") >= 36 && num("targetSdkVersion") >= 35 ? ok(`compileSdk ${num("compileSdkVersion")}, targetSdk ${num("targetSdkVersion")}`)
        : warn(`compileSdk ${num("compileSdkVersion")}, targetSdk ${num("targetSdkVersion")}`, "Capacitor 8 expects 36 / 36; Google Play requires targetSdk 35+ for new releases");
} else warn("android/variables.gradle not found", "is this a Capacitor 8 android/ folder?");

// Synced web bundle + plugin registration
const assets = path.join(MAIN, "assets");
const pluginsJson = read(path.join(assets, "capacitor.plugins.json"));
if (!pluginsJson) fail("android/app/src/main/assets/capacitor.plugins.json missing", "run: npx cap sync android");
else {
    for (const [cls, label] of [["BackgroundGeolocation", "background location"], ["BluetoothLe", "Bluetooth"], ["TextToSpeech", "text-to-speech"]]) {
        pluginsJson.includes(cls) ? ok(`${label} plugin registered in the app`) : fail(`${label} plugin not registered in the app`, "npm install it, then npx cap sync android");
    }
    if (sr) pluginsJson.includes("SpeechRecognition") ? ok("speech-recognition plugin registered") : fail("speech-recognition installed but not registered", "npx cap sync android");
}
const builtMeta = read(path.join(ROOT, "www", "native-build.json"));
const syncedMeta = read(path.join(assets, "public", "native-build.json"));
if (!builtMeta) fail("www/ hasn't been built", "MU_SERVER_ORIGIN=https://… npm run build:native");
else if (!syncedMeta) fail("the built www/ isn't in the Android project yet", "npx cap sync android");
else {
    const b = JSON.parse(builtMeta), s = JSON.parse(syncedMeta);
    b.builtAt === s.builtAt ? ok(`app contains the latest web build (${s.origin}, scripts v=${s.version})`) : warn("android/ holds an older web build than www/", "npx cap sync android");
    if (s.check && s.check.corsOk === false) fail(`when built, ${s.origin} didn't allow the app's origin`, "deploy the current server.js, rebuild, sync");
    else if (s.check && s.check.reachable === false) warn(`when built, ${s.origin} couldn't be reached (default settings were used)`, "rebuild once the server is up");
    const syncedHtml = read(path.join(assets, "public", "index.html")) || "";
    syncedHtml.includes("vendor/socket.io.min.js") ? ok("Socket.IO client bundled") : fail("the app still loads Socket.IO from the server (old build script)", "update scripts/build-native.mjs, rebuild, sync");
}

finish();

function finish() {
    console.log(`\n${results.ok} ok, ${results.warn} advice, ${results.fail} to fix.`);
    if (results.fail) console.log("Fix the ✗ items, then run `npx cap sync android` and this check again.");
    process.exit(results.fail ? 1 : 0);
}
