// Road perception P1: native plugin JS interface, recorder page, Android setup script,
// and frames produced by the Kotlin plugin core (fixtures/kotlin-dummy-mixed.jsonl,
// written by FrameJson.kt + DummyModel("mixed") + FrameScheduler on a JVM).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const NP = require("../../public/js/master/perception/native.js");
const RP = require("../../public/js/master/perception/recorder-page.js");
const PC = require("../../public/js/master/perception/contract.js");
const CF = require("../../public/js/master/perception/confirm.js");
const PV = require("../../public/js/master/perception/provider.js");
const C = require("../../public/js/master/contracts.js");
const B = require("../../public/js/master/bus.js");
const K = require("../../public/js/master/kernel.js");
const CAPS = require("../../public/js/master/capabilities.js");
const P = require("../../public/js/master/persona.js");
const PH = require("../../public/js/master/phrases-desi.js");
const O = require("../../public/js/master/output.js");
const BR = require("../../public/js/master/brain.js");
const RIDE = require("../../public/js/master/agents/ride-agent.js");
const ROAD = require("../../public/js/master/agents/road-agent.js");
const SETUP = await import("../../scripts/setup-perception-android.mjs");

const FIXTURE = fileURLToPath(new URL("./fixtures/kotlin-dummy-mixed.jsonl", import.meta.url));
const kotlinFrames = () => fs.readFileSync(FIXTURE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------- fake plugin
function fakePlugin() {
    const calls = [];
    const listeners = { frame: new Set(), state: new Set() };
    const p = {
        calls, listeners,
        addListener: async (ev, fn) => { listeners[ev].add(fn); return { remove: async () => listeners[ev].delete(fn) }; },
        emit: (ev, data) => { for (const fn of listeners[ev]) fn(data); }
    };
    for (const m of ["start", "stop", "setTargetFps", "status", "calibrate", "startRecording", "stopRecording", "mark"]) {
        p[m] = async (arg) => { calls.push([m, arg]); return m === "mark" ? { ok: true } : m === "startRecording" ? { dir: "/x" } : {}; };
    }
    p.preview = async () => ({ jpeg: "QUJD", mime: "image/jpeg" });
    return p;
}
const tick = () => new Promise((r) => setImmediate(r));

test("native wrapper: owner on start/stop, inputs clamped, frames parsed from JSON text", async () => {
    const plugin = fakePlugin();
    const N = NP.createNativePerception({ plugin, owner: "recorder" });
    assert.equal(N.available, true);
    await N.start({ targetFps: 99, emitHz: 0, scenario: "nonsense" });
    assert.deepEqual(plain(plugin.calls[0]), ["start", { targetFps: 30, emitHz: 1, scenario: "none", owner: "recorder" }]);
    await N.setTargetFps(-4);
    assert.deepEqual(plain(plugin.calls[1]), ["setTargetFps", { fps: 0 }]);
    await N.calibrate({ mountHeightM: 9 });                         // out of range → not sent
    assert.deepEqual(plain(plugin.calls[2]), ["calibrate", {}]);
    await N.startRecording({ intervalMs: 10, note: "x".repeat(500) });
    assert.equal(plugin.calls[3][1].intervalMs, 200);
    assert.equal(plugin.calls[3][1].note.length, 200);
    assert.equal(await N.mark("pot<hole>!"), true);
    assert.deepEqual(plain(plugin.calls[4]), ["mark", { label: "pothole" }]);
    assert.equal(await N.preview(), "data:image/jpeg;base64,QUJD");
    const got = [];
    const off = N.onFrame((f) => got.push(f));
    await tick();
    const frame = kotlinFrames()[0];
    plugin.emit("frame", { frame: JSON.stringify(frame) });
    plugin.emit("frame", { frame: "{broken" });                    // ignored, never throws
    assert.equal(got.length, 1);
    assert.equal(got[0].seq, frame.seq);
    off();
    await tick();
    plugin.emit("frame", { frame: JSON.stringify(frame) });
    assert.equal(got.length, 1);
    await N.stop();
    assert.deepEqual(plain(plugin.calls.at(-1)), ["stop", { owner: "recorder" }]);
});

test("native wrapper: errors become PerceptionError with a code; no plugin = UNAVAILABLE", async () => {
    const plugin = fakePlugin();
    plugin.calibrate = async () => { const e = new Error("the phone moved during calibration"); e.code = "NOT_STILL"; throw e; };
    const N = NP.createNativePerception({ plugin });
    await assert.rejects(N.calibrate(), (e) => e instanceof NP.PerceptionError && e.code === "NOT_STILL");
    const none = NP.connect({});
    assert.equal(none.available, false);
    await assert.rejects(none.start(), (e) => e.code === "UNAVAILABLE" && /Android app/.test(e.message));
    assert.equal(NP.findPlugin({ Capacitor: { isNativePlatform: () => false } }), null);
    const W = { Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n) => n === "MapUnitePerception", registerPlugin: (n) => ({ name: n }) } };
    assert.deepEqual(NP.findPlugin(W), { name: "MapUnitePerception" });
});

test("recorder page: status → plain English, SI units", () => {
    const off = RP.describe(null, 0);
    assert.equal(off.chip.text, "Camera off");
    assert.equal(off.recording, false);
    const st = {
        running: true, paused: false, cameraFps: 29.6, thermal: "moderate", thermalCapFps: 20, batteryPct: 64, charging: false,
        camera: { width: 1280, height: 720, focus: "fixed at infinity" },
        sensors: { gnss: true, gnssAgeMs: 400, speedMs: 12.34, speedSigma: 0.4 },
        quality: { usable: 0.45, reasons: ["low-light", "blur"] },
        calibration: { id: "cal-1", pitchDeg: 6.2, rollDeg: -0.4, mountHeightM: 1.05 },
        recording: { active: true, startedAtMs: 1000, frames: 240, bytes: 31457280, freeMB: 20480, imuRows: 36000, gnssRows: 120, events: 2, facesBlurred: 1 }
    };
    const v = RP.describe(st, 1000 + 125000);
    assert.equal(v.chip.text, "Recording");
    assert.equal(v.fps, "30 fps");
    assert.equal(v.thermal, "Hot");
    assert.match(v.battery, /capped at 20 fps/);
    assert.equal(v.speed, "12.3 m/s");
    assert.equal(v.gps, "± 0.4 m/s");
    assert.equal(v.quality, "Fair");
    assert.equal(v.qualityWhy, "Low light, blurry");
    assert.equal(v.duration, "2 min 05 s");
    assert.equal(v.size, "30.0 MB");
    assert.equal(v.free, "20.00 GB free");
    assert.equal(v.faces, "1 face");
    assert.match(v.calibration, /tilt 6\.2°, roll -0\.4°, height 1\.05 m/);
    // English only on screen (Hinglish is for the voice)
    const words = JSON.stringify(v);
    assert.doesNotMatch(words, /\b(bhai|gaddha|haan|nahi|aage|paas)\b/i);
    const noGps = RP.describe({ ...st, sensors: { gnss: false, gnssWhy: "location permission not granted" } }, 0);
    assert.equal(noGps.gps, "Location permission not granted");
    assert.equal(noGps.speed, "–");
});

test("Kotlin frames: every frame passes contract v1; pothole confirmed, smudge rejected, truck warned", () => {
    const frames = kotlinFrames();
    assert.ok(frames.length > 200);
    const hz = CF.createHazardConfirmer(), cw = CF.createClosingWatch();
    const confirmed = new Set(), rejected = new Set(), closing = new Set();
    let lastSeq = -1;
    for (const raw of frames) {
        const v = PC.validateFrame(raw);
        assert.ok(v.ok, v.errors.join("; "));
        assert.equal(v.dropped, 0);
        assert.ok(raw.seq > lastSeq); lastSeq = raw.seq;
        assert.equal(raw.ego.lat, undefined, "simulated frames never carry a position");
        const r = hz.update(v.frame);
        for (const h of r.confirmed) confirmed.add(String(h.id));
        for (const x of r.rejected) rejected.add(String(x.id));
        for (const c of cw.update(v.frame)) closing.add(String(c.id));
    }
    assert.deepEqual([...confirmed].sort(), ["1000", "1001", "1002", "1003"]);
    assert.deepEqual([...rejected].sort(), ["5000", "5001", "5002", "5003"]);
    assert.equal(closing.size, 4);
});

// ---------------------------------------------------------------- Kotlin frames through the whole Master AI
function fakeClock(start) {
    let t = start, id = 0;
    const q = new Map();
    const timers = {
        setTimeout(fn, ms) { const h = ++id; q.set(h, { at: t + Math.max(0, ms || 0), fn }); return h; },
        clearTimeout(h) { q.delete(h); },
        setInterval(fn, ms) { const h = ++id; q.set(h, { at: t + ms, fn, every: ms }); return h; },
        clearInterval(h) { q.delete(h); }
    };
    function advance(ms) {
        const end = t + ms;
        for (;;) {
            let next = null;
            for (const [h, e] of q) if (e.at <= end && (!next || e.at < next[1].at)) next = [h, e];
            if (!next) break;
            const [h, e] = next;
            t = e.at;
            if (e.every) e.at += e.every; else q.delete(h);
            e.fn();
        }
        t = end;
    }
    return { now: () => t, timers, advance };
}
function emitter() { const fns = new Set(); return { on(fn) { fns.add(fn); return () => fns.delete(fn); }, emit(v) { for (const fn of fns) fn(v); } }; }

test("Kotlin frames → road agent → Master AI: pothole spoken in desi with an English screen, nothing mapped", async () => {
    const frames = kotlinFrames();
    const clock = fakeClock(frames[0].t);
    const bus = B.createBus({ now: clock.now, timers: clock.timers });
    const caps = CAPS.createCapabilities();
    caps.provide("store", CAPS.createStoreProvider({}));
    const drives = emitter();
    let drive = { driving: false, navigating: false };
    caps.provide("location", { available: () => true, current: () => null, onFix: emitter().on });
    caps.provide("drive", { available: () => true, current: () => drive, onChange: drives.on });
    // the native plugin path of provider.js, fed from the Kotlin frames (JSON text, as the plugin sends them)
    const plugin = fakePlugin();
    plugin.start = async () => {
        let i = 0;
        const step = () => { if (i >= frames.length) return; plugin.emit("frame", { frame: JSON.stringify(frames[i]) }); const next = frames[i + 1]; i++; if (next) clock.timers.setTimeout(step, next.t - frames[i - 1].t); };
        step();
    };
    caps.provide("perception", PV.createPerceptionProvider({ contract: PC, plugin, timers: clock.timers }));
    const said = [], islands = [];
    const persona = PH.install(P.createPersona({ style: "desi", rng: () => 0 }));
    const output = O.createOutput({ window: {}, voice: (text, o) => { said.push({ text, ...o }); return true; }, island: (s) => { islands.push(s); return true; }, busy: () => false, emit: () => {} });
    BR.createBrain({ bus, contracts: C, persona, output, now: clock.now, timers: clock.timers });
    const kernel = K.createKernel({ bus, caps, contracts: C, now: clock.now, timers: clock.timers, log: { info() {}, warn() {}, error() {} } });
    const reports = [];
    bus.subscribe("report.**", (d) => reports.push(d));
    kernel.define(RIDE); kernel.define(ROAD); kernel.start();
    drive = { driving: true, navigating: false }; drives.emit(drive);
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(kernel.get("road").state, "running");
    clock.advance(31000);
    const hz = reports.filter((r) => r.kind === "road.hazard");
    assert.ok(hz.length >= 3, `hazard reports: ${hz.length}`);
    assert.ok(hz.every((r) => r.data.cls === "pothole"));
    assert.ok(hz.every((r) => r.data.distanceM >= 20 && r.data.distanceM <= 80), hz.map((r) => r.data.distanceM).join(","));
    assert.ok(said.some((s) => /gaddha/.test(s.text)), "spoken in desi");
    assert.ok(islands.some((i) => i.title === "Pothole ahead"), "screen in English");
    assert.ok(reports.some((r) => r.kind === "traffic.closing-fast"));
    assert.equal(bus.last("state.road").mappedCells, 0);           // simulated: no position, never on the map
});

// ---------------------------------------------------------------- Android setup script
const APP_GRADLE = `apply plugin: 'com.android.application'

android {
    namespace "com.mapunite.app"
    compileSdk rootProject.ext.compileSdkVersion
}

repositories {
    google()
}

dependencies {
    implementation fileTree(include: ['*.jar'], dir: 'libs')
    implementation "androidx.appcompat:appcompat:$androidxAppCompatVersion"
    implementation project(':capacitor-android')
}

apply from: 'capacitor.build.gradle'
`;
const ROOT_GRADLE = `buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath 'com.android.tools.build:gradle:8.13.0'
        classpath 'com.google.gms:google-services:4.4.4'
    }
}
apply from: "variables.gradle"
`;

test("setup script: patches Capacitor's Gradle files once (idempotent), Kotlin + CameraX", () => {
    const a1 = SETUP.patchAppGradle(APP_GRADLE);
    assert.equal(a1.manual.length, 0);
    assert.equal(a1.changes.length, 3);
    assert.match(a1.text, /apply plugin: 'com\.android\.application'\napply plugin: 'kotlin-android'/);
    assert.match(a1.text, /dependencies \{\n    \/\/ MapUnite perception[^\n]*\n    implementation "androidx\.camera:camera-core:/);
    assert.match(a1.text, /JvmTarget\.fromTarget/);
    const a2 = SETUP.patchAppGradle(a1.text);
    assert.equal(a2.text, a1.text);
    assert.equal(a2.changes.length, 0);

    const r1 = SETUP.patchRootGradle(ROOT_GRADLE);
    assert.match(r1.text, /classpath 'com\.android\.tools\.build:gradle:8\.13\.0'\n        classpath 'org\.jetbrains\.kotlin:kotlin-gradle-plugin:/);
    assert.equal(SETUP.patchRootGradle(r1.text).text, r1.text);

    // plugins { } DSL and an unknown layout
    const dsl = SETUP.patchAppGradle("plugins {\n    id 'com.android.application'\n}\n\ndependencies {\n}\n");
    assert.match(dsl.text, /id 'org\.jetbrains\.kotlin\.android'/);
    const odd = SETUP.patchAppGradle("// nothing here\n");
    assert.equal(odd.manual.length, 2);
    assert.equal(SETUP.patchRootGradle("// empty\n").manual.length, 1);
});
