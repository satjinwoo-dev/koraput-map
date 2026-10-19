#!/usr/bin/env node
/*
 * Road perception P1: puts the MapUnitePerception Kotlin plugin into android/.
 *
 *   node scripts/setup-perception-android.mjs            (do it)
 *   node scripts/setup-perception-android.mjs --dry-run  (show what would change)
 *
 * Run after `npx cap add android`, from the MapUnite project folder. Safe to run
 * again: every edit carries a "MapUnite perception" marker and is skipped when present.
 *
 *  1. copies native/android/perception/*.kt  → android/app/src/main/java/com/mapunite/app/perception/
 *     and    native/android/voice/*.kt       → android/app/src/main/java/com/mapunite/app/voice/  (MapUniteVoice)
 *     and    native/android/radar/*.kt       → android/app/src/main/java/com/mapunite/app/radar/  (MapUniteRadio, MapUniteMedia)
 *     and    native/android/nav/*.kt         → android/app/src/main/java/com/mapunite/app/nav/    (MapUniteNavPip: minimized navigation)
 *  2. copies native/android/MainActivity.java (registers the plugin) when the appId is com.mapunite.app
 *  3. android/build.gradle      adds the Kotlin Gradle plugin to buildscript (if Kotlin isn't there yet)
 *  4. android/app/build.gradle  applies Kotlin, adds CameraX, matches Kotlin's JVM target to Java's
 *  5. android/app/src/main/AndroidManifest.xml  declares the Master AI's media listener service, the navigation
 *     notification's service, and picture-in-picture on MainActivity
 *
 * If a Gradle file doesn't look like Capacitor's template, the script changes
 * nothing in it and prints the exact lines to add by hand.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARK = "MapUnite perception";
export const KOTLIN_VERSION = "2.1.21";
export const CAMERAX_VERSION = "1.4.2";
/** native/android/<pkg>/*.kt → android/app/src/main/java/com/mapunite/app/<pkg>/ */
export const KOTLIN_PACKAGES = ["perception", "voice", "radar", "nav"];

export const DEPS_BLOCK = [
    `    // ${MARK} (scripts/setup-perception-android.mjs): CameraX for the road camera`,
    `    implementation "androidx.camera:camera-core:${CAMERAX_VERSION}"`,
    `    implementation "androidx.camera:camera-camera2:${CAMERAX_VERSION}"`,
    `    implementation "androidx.camera:camera-lifecycle:${CAMERAX_VERSION}"`
].join("\n");

export const JVM_BLOCK = [
    "",
    `// ${MARK}: Kotlin compiles for the same JVM version as Java (Capacitor sets Java's)`,
    "tasks.withType(org.jetbrains.kotlin.gradle.tasks.KotlinCompile).configureEach {",
    "    compilerOptions {",
    "        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.fromTarget(android.compileOptions.targetCompatibility.toString())",
    "    }",
    "}",
    ""
].join("\n");

const hasKotlin = (s) => /kotlin-android|org\.jetbrains\.kotlin\.android/.test(s);

/**
 * android/app/build.gradle → { text, changes, manual }
 * @param {string} src
 */
export function patchAppGradle(src) {
    let s = src;
    const changes = [], manual = [];
    // a) apply Kotlin
    if (!hasKotlin(s)) {
        if (/apply plugin:\s*['"]com\.android\.application['"]/.test(s)) {
            s = s.replace(/(apply plugin:\s*['"]com\.android\.application['"][^\n]*\n)/, `$1apply plugin: 'kotlin-android'   // ${MARK}\n`);
            changes.push("applies the Kotlin plugin");
        } else if (/plugins\s*\{[^}]*id\s*['"]com\.android\.application['"]/.test(s)) {
            s = s.replace(/(plugins\s*\{[^}]*id\s*['"]com\.android\.application['"][^\n]*\n)/, `$1    id 'org.jetbrains.kotlin.android'   // ${MARK}\n`);
            changes.push("applies the Kotlin plugin");
        } else manual.push("apply plugin: 'kotlin-android'    (next to apply plugin: 'com.android.application')");
    }
    // b) CameraX
    if (!s.includes(`${MARK} (scripts/setup-perception-android.mjs): CameraX`)) {
        const m = /\ndependencies\s*\{[^\n]*\n/.exec(s);
        if (m) {
            s = s.slice(0, m.index + m[0].length) + DEPS_BLOCK + "\n" + s.slice(m.index + m[0].length);
            changes.push(`adds CameraX ${CAMERAX_VERSION}`);
        } else manual.push(`inside dependencies { … }:\n${DEPS_BLOCK}`);
    }
    // c) JVM target
    if (!s.includes(`${MARK}: Kotlin compiles for the same JVM`)) {
        s = s.replace(/\s*$/, "\n") + JVM_BLOCK;
        changes.push("matches Kotlin's JVM target to Java's");
    }
    return { text: s, changes, manual };
}

/**
 * android/build.gradle (root) → { text, changes, manual }
 * @param {string} src
 */
export function patchRootGradle(src) {
    const changes = [], manual = [];
    if (/kotlin-gradle-plugin/.test(src) || /org\.jetbrains\.kotlin\.android['"]\s*version/.test(src)) return { text: src, changes, manual };
    const line = `        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}'   // ${MARK}`;
    const agp = /(\n[ \t]*classpath\s*['"]com\.android\.tools\.build:gradle:[^'"]+['"][^\n]*)/.exec(src);
    if (agp) return { text: src.replace(agp[1], `${agp[1]}\n${line}`), changes: ["adds the Kotlin Gradle plugin " + KOTLIN_VERSION], manual };
    manual.push(`inside buildscript { dependencies { … } }:\n${line.trim()}`);
    return { text: src, changes, manual };
}

/** The Master AI mood agent's NotificationListenerService, inside <application>. */
export const MEDIA_SERVICE = [
    `        <!-- ${MARK}: Master AI mood agent (native/android/radar/MediaListenerService.kt) -->`,
    `        <service android:name="com.mapunite.app.radar.MediaListenerService" android:label="@string/app_name" android:exported="true" android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE">`,
    `            <intent-filter><action android:name="android.service.notification.NotificationListenerService" /></intent-filter>`,
    `        </service>`
].join("\n");
/** The live navigation notification's foreground service (native/android/nav/NavService.kt), inside <application>. */
export const NAV_SERVICE = [
    `        <!-- ${MARK}: navigation, minimized (native/android/nav/NavService.kt) -->`,
    `        <service android:name="com.mapunite.app.nav.NavService" android:exported="false" android:foregroundServiceType="location" />`
].join("\n");
/**
 * android/app/src/main/AndroidManifest.xml → { text, changes, manual }
 * @param {string} src
 */
export function patchManifest(src) {
    let s = src;
    const changes = [], manual = [];
    const addService = (/** @type {string} */ marker, /** @type {string} */ block, /** @type {string} */ what) => {
        if (s.includes(marker)) return;
        const i = s.lastIndexOf("</application>");
        if (i < 0) { manual.push(`inside <application>:\n${block}`); return; }
        s = `${s.slice(0, i)}${block}\n    ${s.slice(i)}`;
        changes.push(what);
    };
    addService("com.mapunite.app.radar.MediaListenerService", MEDIA_SERVICE, "declares the Master AI media listener service");
    addService("com.mapunite.app.nav.NavService", NAV_SERVICE, "declares the navigation notification service");
    // picture-in-picture on MainActivity (the small window while navigating)
    const act = s.match(/<activity\b[^>]*android:name="(?:\.|[\w.]*\.)MainActivity"[^>]*>/);
    if (!act) manual.push('on the MainActivity <activity> tag: android:supportsPictureInPicture="true"');
    else if (!/supportsPictureInPicture/.test(act[0])) {
        s = s.replace(act[0], act[0].replace(/<activity\b/, '<activity\n            android:supportsPictureInPicture="true"'));
        changes.push("allows picture-in-picture on MainActivity");
    }
    return { text: s, changes, manual };
}

// ---------------------------------------------------------------- run

function main() {
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const dry = process.argv.includes("--dry-run");
    const say = (m) => console.log(`setup-perception: ${m}`);
    const ANDROID = path.join(ROOT, "android");
    if (!fs.existsSync(path.join(ANDROID, "app"))) {
        console.error("setup-perception: no android/app folder. Run `npx cap add android` first (ANDROID.md step 5).");
        process.exit(1);
    }
    let appId = "com.mapunite.app";
    try { appId = JSON.parse(fs.readFileSync(path.join(ROOT, "capacitor.config.json"), "utf8")).appId || appId; } catch { /* default */ }

    // 1. Kotlin sources (perception + the Master AI's voice)
    for (const pkg of KOTLIN_PACKAGES) {
        const srcDir = path.join(ROOT, "native/android", pkg);
        const dstDir = path.join(ANDROID, "app/src/main/java/com/mapunite/app", pkg);
        const kts = fs.readdirSync(srcDir).filter((f) => f.endsWith(".kt"));
        if (!dry) { fs.mkdirSync(dstDir, { recursive: true }); for (const f of kts) fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f)); }
        say(`${dry ? "would copy" : "copied"} ${kts.length} Kotlin files → ${path.relative(ROOT, dstDir)}`);
    }

    // 2. MainActivity
    const maDst = path.join(ANDROID, "app/src/main/java", ...appId.split("."), "MainActivity.java");
    if (appId === "com.mapunite.app") {
        if (!dry) fs.copyFileSync(path.join(ROOT, "native/android/MainActivity.java"), maDst);
        say(`${dry ? "would copy" : "copied"} MainActivity.java (registers MapUniteNative + MapUnitePerception + MapUniteVoice + MapUniteRadio + MapUniteMedia + MapUniteNavPip)`);
    } else {
        say(`appId is ${appId}: add these lines to your MainActivity.onCreate, before super.onCreate():\n    registerPlugin(com.mapunite.app.perception.PerceptionPlugin.class);\n    registerPlugin(com.mapunite.app.voice.VoicePlugin.class);\n    registerPlugin(com.mapunite.app.radar.RadioPlugin.class);\n    registerPlugin(com.mapunite.app.radar.MediaPlugin.class);\n    registerPlugin(com.mapunite.app.nav.NavPipPlugin.class);\nand forward onUserLeaveHint / onPictureInPictureModeChanged as native/android/MainActivity.java does.`);
    }

    // 3 + 4. Gradle
    const manualAll = [];
    for (const [rel, fn] of [["build.gradle", patchRootGradle], ["app/build.gradle", patchAppGradle], ["app/src/main/AndroidManifest.xml", patchManifest]]) {
        const f = path.join(ANDROID, rel);
        if (!fs.existsSync(f)) { manualAll.push(`android/${rel} not found (Kotlin DSL .kts? add Kotlin + CameraX by hand, see ANDROID.md)`); continue; }
        const before = fs.readFileSync(f, "utf8");
        const r = fn(before);
        if (r.text !== before && !dry) fs.writeFileSync(f, r.text);
        say(`android/${rel}: ${r.changes.length ? (dry ? "would " : "") + r.changes.join("; ") : "already set up"}`);
        for (const m of r.manual) manualAll.push(`android/${rel}: ${m}`);
    }
    if (manualAll.length) {
        console.warn("\nsetup-perception: add these by hand (the file didn't match Capacitor's template):");
        for (const m of manualAll) console.warn(`  - ${m}`);
    }
    say(dry ? "dry run, nothing changed." : "done. Next: npx cap sync android, then build and open Smart Drive Settings → Road data recorder.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
