#!/usr/bin/env node
/*
 * Compiles MapUnite's native Android code without Android Studio, Gradle or
 * the Android SDK, to catch build errors before `npx cap run android`:
 *
 *   node scripts/android-compile-check.mjs            (needs a JDK 17+ and curl)
 *   node scripts/android-compile-check.mjs --min-api  (also lists calls above minSdk 24)
 *
 * What it compiles, in order:
 *   1. Capacitor's own Android sources (@capacitor/android from npm, the version
 *      in ANDROID.md), against the real Android framework;
 *   2. our Kotlin (native/android/{perception,voice,radar,nav}) and Java
 *      (MainActivity, MapUniteNativePlugin) against Capacitor + the framework.
 *
 * Where the pieces come from (downloaded once into --cache, default
 * ~/.cache/mapunite-android-check):
 *   - the Android framework: Robolectric's android-all for API 36 (and API 24 for
 *     --min-api), from Maven Central: the real android.* classes;
 *   - Apache Cordova's framework (Capacitor compiles against it), Maven Central;
 *   - the Kotlin compiler 2.1.21 (the version the setup script puts in Gradle),
 *     Maven Central;
 *   - @capacitor/android 8 from the npm registry.
 * androidx (AppCompat, core, activity, webkit, CameraX) is only published on
 * Google's Maven, so those classes are STUBS in native/android/compile-check/stubs:
 * the exact signatures this code and Capacitor call, nothing else. A wrong
 * androidx signature there would hide an error, so keep them to what the real
 * libraries declare.
 *
 * This is a compile check, not a build: resources, the manifest merge, lint and
 * the APK come from Gradle on a machine with the Android SDK. Exit code 1 on
 * any compile error.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const CACHE = path.resolve(arg("--cache") || path.join(os.homedir(), ".cache", "mapunite-android-check"));
const MIN_API = process.argv.includes("--min-api");
const MAVEN = "https://repo1.maven.org/maven2";
const KOTLIN = "2.1.21";
const CAP_VERSION = arg("--capacitor") || "8";
const SEP = path.delimiter;

const say = (m) => console.log(`android-check: ${m}`);
function die(m) { console.error(`android-check: ${m}`); process.exit(1); }
fs.mkdirSync(CACHE, { recursive: true });

/** Download once (curl follows the system proxy and CA settings). */
function fetchTo(url, file) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
    say(`downloading ${url.replace(MAVEN, "maven")}`);
    const tmp = `${file}.part`;
    const r = spawnSync("curl", ["-fsSL", "--retry", "3", "-o", tmp, url], { stdio: "inherit" });
    if (r.status !== 0) die(`couldn't download ${url}`);
    fs.renameSync(tmp, file);
    return file;
}
const maven = (g, a, v, ext = "jar") => fetchTo(`${MAVEN}/${g.replace(/\./g, "/")}/${a}/${v}/${a}-${v}.${ext}`, path.join(CACHE, `${a}-${v}.${ext}`));
function run(cmd, args, what) {
    const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout || ""}${r.stderr || ""}`.split("\n").filter((l) => l && !/JAVA_TOOL_OPTIONS|UnsupportedAppUsage|android-all-[\d.]+.*\.jar\(/.test(l)).join("\n");
    return { ok: r.status === 0, out, what };
}
const list = (dir, ext) => {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...list(p, ext)); else if (p.endsWith(ext)) out.push(p);
    }
    return out;
};
const fresh = (d) => { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };

// ---- tools -------------------------------------------------------------------
try { execFileSync("javac", ["-version"], { stdio: "ignore" }); } catch { die("javac not found: install a JDK 17 or newer"); }
try { execFileSync("curl", ["--version"], { stdio: "ignore" }); } catch { die("curl not found"); }

// ---- 1. what we compile against -----------------------------------------------
const android36 = maven("org.robolectric", "android-all", "16-robolectric-13921718");
const android24 = MIN_API ? maven("org.robolectric", "android-all", "7.0.0_r1-robolectric-r1") : null;
const cordovaAar = maven("org.apache.cordova", "framework", "14.0.1", "aar");
const cordova = path.join(CACHE, "cordova-framework-14.0.1.jar");
if (!fs.existsSync(cordova)) {
    const d = fresh(path.join(CACHE, "cordova-aar"));
    execFileSync("jar", ["xf", cordovaAar, "classes.jar"], { cwd: d, stdio: "ignore" });   // an .aar is a zip
    fs.renameSync(path.join(d, "classes.jar"), cordova);
}
const kotlinJars = [
    maven("org.jetbrains.kotlin", "kotlin-compiler-embeddable", KOTLIN), maven("org.jetbrains.kotlin", "kotlin-stdlib", KOTLIN),
    maven("org.jetbrains.kotlin", "kotlin-script-runtime", KOTLIN), maven("org.jetbrains.kotlin", "kotlin-reflect", "1.6.10"),
    maven("org.jetbrains.kotlin", "kotlin-daemon-embeddable", KOTLIN), maven("org.jetbrains.intellij.deps", "trove4j", "1.0.20200330"),
    maven("org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.0"), maven("org.jetbrains", "annotations", "13.0")
];
const stdlib = kotlinJars[1];

// Capacitor's Android sources, the version the app installs
let capDir = path.join(ROOT, "node_modules", "@capacitor", "android", "capacitor", "src", "main", "java");
if (!fs.existsSync(capDir)) {
    // the newest published version of that major (the registry doesn't resolve ranges by URL)
    const doc = JSON.parse(execFileSync("curl", ["-fsSL", "https://registry.npmjs.org/@capacitor%2fandroid"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
    const num = (v) => v.split(".").map(Number);
    const newest = Object.keys(doc.versions).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && v.startsWith(`${CAP_VERSION}.`))
        .sort((a, b) => { const x = num(a), y = num(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }).pop();
    if (!newest) die(`no @capacitor/android ${CAP_VERSION}.x on npm`);
    const meta = doc.versions[newest];
    const tgz = fetchTo(meta.dist.tarball, path.join(CACHE, `capacitor-android-${meta.version}.tgz`));
    const d = path.join(CACHE, `capacitor-android-${meta.version}`);
    if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); execFileSync("tar", ["-xzf", tgz, "-C", d]); }
    capDir = path.join(d, "package", "capacitor", "src", "main", "java");
    say(`Capacitor ${meta.version} (npm)`);
}

// ---- 2. compile ------------------------------------------------------------------
const OUT = fresh(path.join(CACHE, "out"));
const stubsOut = path.join(OUT, "stubs"), capOut = path.join(OUT, "capacitor"), ktOut = path.join(OUT, "kotlin"), javaOut = path.join(OUT, "java");
const steps = [];
const javac = (cp, out, files, what) => { fs.mkdirSync(out, { recursive: true }); const at = path.join(OUT, `${path.basename(out)}.txt`); fs.writeFileSync(at, files.join("\n")); return run("javac", ["-nowarn", "-proc:none", "-encoding", "UTF-8", "-d", out, "-cp", cp, `@${at}`], what); };
const kotlinc = (cp, out, files, what) => run("java", ["-Xmx2g", "-cp", kotlinJars.join(SEP), "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-cp", cp, "-d", out, ...files], what);

const NATIVE = path.join(ROOT, "native", "android");
const stubs = list(path.join(NATIVE, "compile-check", "stubs"), ".java");
const kt = ["perception", "voice", "radar", "nav"].flatMap((d) => list(path.join(NATIVE, d), ".kt"));
const java = ["MainActivity.java", "MapUniteNativePlugin.java"].map((f) => path.join(NATIVE, f));

function pass(fw) {
    const r = [];
    r.push(javac(fw, stubsOut, stubs, "androidx stubs"));
    if (!r[r.length - 1].ok) return r;
    r.push(javac([fw, cordova, stubsOut].join(SEP), capOut, list(capDir, ".java"), "Capacitor"));
    if (!r[r.length - 1].ok) return r;
    const cp = [fw, cordova, stubsOut, capOut, stdlib].join(SEP);
    r.push(kotlinc(cp, ktOut, [...kt, ...java], `Kotlin (${kt.length} files)`));
    if (!r[r.length - 1].ok) return r;
    r.push(javac([cp, ktOut].join(SEP), javaOut, java, "Java (MainActivity, MapUniteNativePlugin)"));
    return r;
}

say(`compiling against Android API 36 (cache: ${CACHE})`);
for (const s of pass(android36)) {
    steps.push(s);
    const errors = s.out.split("\n").filter((l) => /error/.test(l));
    console.log(`  ${s.ok ? "✓" : "✗"} ${s.what}${s.ok ? "" : `: ${errors.length} error line(s)`}`);
    if (!s.ok) { console.log(s.out.split("\n").filter((l) => /error|\^/.test(l)).slice(0, 80).join("\n")); process.exit(1); }
}

if (MIN_API) {
    // minSdk 24: everything newer must sit behind a Build.VERSION.SDK_INT check. This pass lists each call the
    // API 24 framework doesn't have; read the line to confirm its guard (a guarded call is fine).
    say("compiling against Android API 24 (minSdk): calls newer than API 24 —");
    // the stubs and Capacitor stay as compiled for API 36 (they're libraries); only our code meets API 24
    const cp24 = [/** @type {string} */ (android24), cordova, stubsOut, capOut, stdlib].join(SEP);
    const kt24 = fresh(path.join(OUT, "kotlin24")), java24 = fresh(path.join(OUT, "java24"));
    const r24 = [kotlinc(cp24, kt24, [...kt, ...java], "Kotlin, API 24"), javac([cp24, ktOut].join(SEP), java24, java, "Java, API 24")];
    const lines = r24.flatMap((s) => s.out.split("\n")).filter((l) => /error:|: error/.test(l))
        .map((l) => l.replace(`${NATIVE}${path.sep}`, "").replace(/^.*?(native\/android\/)/, ""));
    const ours = lines.filter((l) => !l.includes("@capacitor") && !l.includes("capacitor-android"));
    const byFile = new Map();
    for (const l of ours) { const f = l.split(":")[0]; byFile.set(f, (byFile.get(f) || 0) + 1); }
    for (const [f, n] of byFile) console.log(`  · ${f}: ${n}`);
    console.log("  Each is newer than API 24: check it's inside an SDK_INT guard.");
}
say("all native sources compile.");
