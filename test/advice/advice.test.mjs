// Roadmap Step 8: the advice layer and its safety gate (js/advice/advice.js), wired into
// the ride (js/advice/advice-app.js) and VoiceAssistant's priorities (js/voice.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { buildArtifacts } from "../../scripts/bikedb/catalog-build.mjs";
import { loadCatalog } from "../../scripts/bikedb/load-catalog.mjs";
import { ROOT } from "../smartdrive/harness.mjs";

const require = createRequire(import.meta.url);
const A = require("../../public/js/advice/advice.js");
const Physics = require("../../public/js/physics/index.js");
const FB = require("../../public/js/garage/fuel-baseline.js");
const art = buildArtifacts(loadCatalog());
const HUNTER = "royal-enfield-hunter-350-metro-in";
const hb = art.bundles.find((b) => b.id === HUNTER);
const cd = art.bundles.find((b) => b.kind === "class_default" && b.classKey === hb.classKey);
const snap = FB.buildFuelBaseline(Physics, Physics.createBikeModel(hb.runtime, { classDefault: cd.runtime }), { bikeId: HUNTER, classKey: hb.classKey, bundle: hb.hash, title: "Hunter 350" });
const kmPerLAt = (kmh) => FB.kmPerLAt(snap, kmh);
const kmh = (x) => x / 3.6;

/** Feed the gate `secs` seconds of steady riding at v (m/s) from t0; returns the last result. */
function ride(st, t0, secs, v, extra = {}) {
    let r;
    for (let t = t0; t <= t0 + secs; t++) r = A.evaluateGate(st, { t, v, gpsOk: true, accuracy: 5, riding: true, ...(typeof extra === "function" ? extra(t) : extra) });
    return r;
}

// ---------------------------------------------------------------------------- the gate
test("gate: off when not riding, quiet when the rider asked, ready after 10 s of steady riding", () => {
    const st = A.createGateState();
    assert.equal(A.evaluateGate(st, { t: 0, v: kmh(60), riding: false }).state, "off");
    assert.deepEqual(A.evaluateGate(st, { t: 1, v: kmh(60), riding: true, quiet: true }), { state: "quiet", reasons: ["quiet-ride"], until: null, canAdvise: false, accel: 0, steadySd: 0 });
    const early = A.evaluateGate(A.createGateState(), { t: 0, v: kmh(60), riding: true, gpsOk: true });
    assert.deepEqual([early.state, early.reasons], ["hold", ["unsteady"]], "not 10 s of samples yet");
    const r = ride(A.createGateState(), 0, 12, kmh(60));
    assert.deepEqual([r.state, r.canAdvise, r.reasons], ["ready", true, []]);
});

test("gate: slow, untrusted GPS, a turn coming up and an unsteady speed each hold advice", () => {
    assert.ok(ride(A.createGateState(), 0, 15, kmh(12)).reasons.includes("slow"));
    assert.ok(ride(A.createGateState(), 0, 15, kmh(60), { gpsOk: false }).reasons.includes("gps"));
    assert.ok(ride(A.createGateState(), 0, 15, kmh(60), { accuracy: 40 }).reasons.includes("gps"));
    assert.ok(ride(A.createGateState(), 0, 15, kmh(60), { maneuverDistance: 300 }).reasons.includes("maneuver"));
    assert.ok(!ride(A.createGateState(), 0, 15, kmh(60), { maneuverDistance: 900 }).reasons.includes("maneuver"));
    // ±8 km/h stop-and-go weaving around 50 km/h
    const st = A.createGateState();
    let r;
    for (let t = 0; t <= 25; t++) r = A.evaluateGate(st, { t, v: kmh(50 + (t % 4 < 2 ? 8 : -8)), gpsOk: true, riding: true });
    assert.ok(r.reasons.includes("unsteady"), JSON.stringify(r));
    assert.ok(r.steadySd > A.GATE.steadySd);
});

test("gate: hard braking holds advice for 30 s; one noisy fix doesn't count as braking", () => {
    const st = A.createGateState();
    ride(st, 0, 15, kmh(60));
    // one bad fix: −4 m/s² then straight back (two-sample average halves it)
    let r = A.evaluateGate(st, { t: 16, v: kmh(60) - 4, gpsOk: true, riding: true });
    r = A.evaluateGate(st, { t: 17, v: kmh(60), gpsOk: true, riding: true });
    assert.ok(!(st.holds.braking > 17), "a single noisy fix isn't a brake");
    // a real stop from 60: −4.5 m/s² for 3 s
    const s2 = A.createGateState();
    ride(s2, 0, 15, kmh(60));
    for (let i = 1; i <= 3; i++) r = A.evaluateGate(s2, { t: 15 + i, v: Math.max(0, kmh(60) - 4.5 * i), gpsOk: true, riding: true });
    assert.ok(r.accel <= -3, `accel ${r.accel}`);
    r = ride(s2, 19, 20, kmh(40));
    assert.ok(r.reasons.includes("braking") && r.until >= 46 && r.until <= 50, JSON.stringify(r));
    r = ride(s2, 40, 15, kmh(40));
    assert.equal(r.state, "ready", "30 s after the brake, steady again: advice may resume");
});

test("gate: cornering — from the gyroscope, from the GPS heading, from the route — holds advice 6 s past the corner", () => {
    // gyroscope: 0.35 rad/s sweep for 4 s
    let st = A.createGateState();
    ride(st, 0, 15, kmh(50));
    let r = ride(st, 16, 4, kmh(50), { yawRate: 0.35 });
    assert.ok(r.reasons.includes("cornering"));
    r = ride(st, 21, 4, kmh(50), { yawRate: 0.02 });
    assert.ok(r.reasons.includes("cornering"), "still within 6 s");
    r = ride(st, 26, 4, kmh(50), { yawRate: 0.02 });
    assert.equal(r.state, "ready");
    // GPS course: turning 90° in 9 s, a heading every ~1.5 s
    st = A.createGateState();
    ride(st, 0, 15, kmh(40), { heading: 0 });
    r = ride(st, 16, 9, kmh(40), (t) => ({ heading: ((t - 16) / 9) * Math.PI / 2 }));
    assert.ok(r.reasons.includes("cornering"));
    // a straight road, headings within GPS scatter (±2°): no hold
    st = A.createGateState();
    r = ride(st, 0, 30, kmh(60), (t) => ({ heading: (t % 2 ? 1 : -1) * 2 * Math.PI / 180 / 3 }));
    assert.equal(r.state, "ready", JSON.stringify(r));
    // the route bends right here (radius 60 m at 50 km/h: 3.2 m/s² lateral), and a hairpin ahead
    assert.ok(ride(A.createGateState(), 0, 15, kmh(50), { curvatureHere: 1 / 60 }).reasons.includes("cornering"));
    assert.ok(ride(A.createGateState(), 0, 15, kmh(50), { radiusAhead: 80 }).reasons.includes("curve-ahead"));
    assert.equal(ride(A.createGateState(), 0, 15, kmh(50), { radiusAhead: 900, curvatureHere: 1 / 2000 }).state, "ready");
});

test("gate: a wet road holds advice while it's wet and for 30 minutes after the last wet report", () => {
    const st = A.createGateState();
    let r = ride(st, 0, 15, kmh(60), { wet: true });
    assert.ok(r.reasons.includes("wet"));
    r = ride(st, 16, 600, kmh(60), { wet: false });
    assert.ok(r.reasons.includes("wet"), "drying roads stay slippery");
    r = ride(st, 617, 1200, kmh(60), { wet: null });
    assert.equal(r.state, "ready");
    assert.deepEqual([A.isWetWeather(0), A.isWetWeather(3), A.isWetWeather(61), A.isWetWeather(95), A.isWetWeather(73), A.isWetWeather(null), A.isWetWeather("x")], [false, false, true, true, true, null, null]);
});

test("gate: after advice, a 3 min cooldown; the same advice not again for 10 min", () => {
    const st = A.createGateState();
    ride(st, 0, 15, kmh(70));
    A.noteAdvice(st, 15, "eco-60");
    let r = ride(st, 16, 100, kmh(70));
    assert.deepEqual([r.state, r.until], ["cooldown", 195]);
    r = ride(st, 117, 80, kmh(70));
    assert.equal(r.state, "ready");
    assert.equal(A.repeatedTooSoon(st, 300, "eco-60"), true);
    assert.equal(A.repeatedTooSoon(st, 300, "eco-55"), false);
    assert.equal(A.repeatedTooSoon(st, 616, "eco-60"), false);
});

// ---------------------------------------------------------------------------- the advice
test("ecoAdvice: on the Hunter at 75 km/h, ease off at most 15 km/h, in steps of 5, worth ≥ 8 %", () => {
    assert.ok(snap.eco && snap.eco.toKmh < 60, JSON.stringify(snap.eco));
    const a = A.ecoAdvice({ v: kmh(75), limit: null, kmPerLAt, eco: snap.eco });
    assert.ok(a, "advice at 75 km/h");
    assert.equal(Math.round(a.target * 3.6), 60);
    assert.ok(a.saving >= 0.08 && a.saving < 0.6, `${a.saving}`);
    assert.equal(a.text, `Easing to 60 would use about ${Math.round(a.saving * 100)} percent less fuel.`);
    assert.equal(a.key, "eco-60");
    // inside or just above the eco band: nothing worth saying
    assert.equal(A.ecoAdvice({ v: kmh(snap.eco.toKmh + 3), limit: null, kmPerLAt, eco: snap.eco }), null);
    assert.equal(A.ecoAdvice({ v: kmh(30), limit: null, kmPerLAt, eco: snap.eco }), null);
    assert.equal(A.ecoAdvice({ v: kmh(75), limit: null, kmPerLAt, eco: null }), null, "no bike, no advice");
});

test("ecoAdvice: never above the posted limit, and silent over it (the speed alerts own that moment)", () => {
    for (const L of [30, 40, 50, 60, 70, 80, 100]) {
        for (let v = 20; v <= 120; v += 1) {
            const a = A.ecoAdvice({ v: kmh(v), limit: kmh(L), kmPerLAt, eco: snap.eco });
            if (!a) continue;
            assert.ok(a.target <= kmh(L) + 1e-9, `limit ${L}, at ${v}: ${a.target * 3.6}`);
            assert.ok(v <= L + 1.8, `at ${v} over the ${L} limit there's no advice`);
            assert.ok(kmh(v) - a.target >= kmh(8) - 1e-9 && kmh(v) - a.target <= kmh(15) + kmh(5) + 1e-9);
        }
    }
    assert.equal(A.ecoAdvice({ v: kmh(75), limit: kmh(70), kmPerLAt, eco: snap.eco }), null);
    const capped = A.ecoAdvice({ v: kmh(68), limit: kmh(55), kmPerLAt, eco: snap.eco });
    assert.equal(capped, null, "68 in a 55 is over the limit");
    const under = A.ecoAdvice({ v: kmh(64), limit: kmh(65), kmPerLAt, eco: snap.eco });
    assert.ok(!under || under.target <= kmh(65));
});

test("routeCurvature: straight roads, a 100 m bend, the rider off the route", () => {
    const north = Array.from({ length: 50 }, (_, i) => [20 + (i * 20) / 110540, 85]);
    let r = A.routeCurvature(north, 20 + 100 / 110540, 85, 300);
    assert.ok(r.curvatureHere < 1e-4 && r.radiusAhead > 1e4, JSON.stringify(r));
    // a quarter circle of radius 100 m, starting 200 m ahead
    const kx = 111320 * Math.cos(20 * Math.PI / 180), path = [];
    for (let i = 0; i <= 10; i++) path.push([20 + (i * 20) / 110540, 85]);
    for (let k = 1; k <= 30; k++) { const th = (k / 30) * Math.PI / 2; path.push([20 + (200 + 100 * Math.sin(th)) / 110540, 85 + (100 - 100 * Math.cos(th)) / kx]); }
    r = A.routeCurvature(path, 20 + 60 / 110540, 85, 300);
    assert.ok(Math.abs(r.radiusAhead - 100) < 15, `${r.radiusAhead}`);
    assert.ok(r.curvatureHere < 1e-3, "the rider's still on the straight");
    r = A.routeCurvature(path, 20 + 60 / 110540, 85, 100);
    assert.ok(r.radiusAhead > 1000, "the bend is beyond a 100 m lookahead");
    r = A.routeCurvature(path, 20, 85 + 200 / kx, 300);
    assert.deepEqual([r.curvatureHere, r.radiusAhead], [null, null]);
    assert.ok(r.offRoute > 150);
});

// ---------------------------------------------------------------------------- VoiceAssistant + the app
function loadVoice() {
    const spoken = [];
    const ctx = vm.createContext({
        console, Math, JSON, Date, Number, Array, Object, String, Map, Set, Promise, setTimeout, clearTimeout, RegExp, Error,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        document: { addEventListener() {}, dispatchEvent() {}, getElementById: () => null },
        SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
        islandShow() {}
    });
    ctx.window = ctx;
    ctx.speechSynthesis = { speak: (u) => spoken.push(u.text), cancel() {}, getVoices: () => [] };
    vm.runInContext(fs.readFileSync(path.join(ROOT, "public/js/voice.js"), "utf8") + "\nthis.VoiceAssistant = VoiceAssistant; this.navState = navState;", ctx, { filename: "voice.js" });
    ctx.navState.active = true;                                  // driving
    return { ctx, VA: ctx.VoiceAssistant, spoken };
}

test("VoiceAssistant: advice (priority 30, dropIfBusy) never queues behind or talks over another cue", () => {
    const { VA, spoken } = loadVoice();
    const advice = (k) => VA.announce("Easing to 60 would use about 12 percent less fuel.", { priority: 30, category: "advice", drivingOnly: true, dropIfBusy: true, maxAgeMs: 3000, key: k, cooldownMs: 600000 });
    assert.equal(advice("a1"), true, "idle: spoken at once");
    assert.equal(spoken.length, 1);
    VA.done(VA.current);
    assert.equal(VA.announce("Turn left in 200 metres.", { priority: 65 }), true);
    assert.equal(advice("a2"), false, "something is speaking: dropped, not queued");
    assert.equal(VA.queue.length, 0);
    VA.done(VA.current);
    assert.equal(advice("a2"), true, "the key wasn't burned by the drop");
    // a safety cue still pre-empts advice
    assert.equal(VA.announce("Slow down. The limit here is 50.", { priority: 90 }), true);
    assert.equal(VA.current.priority, 90);
    VA.done(VA.current);
    VA.mutedUntil = Date.now() + 60000;
    assert.equal(advice("a3"), false, "muted: no advice");
});

function loadAdviceApp({ limit = null, wetCode = null, quietStored = false } = {}) {
    const said = [], listeners = {}, doc = {};
    const store = new Map(quietStored ? [["mu_quiet_ride", "1"]] : []);
    const ctx = vm.createContext({
        console, Math, JSON, Date, Number, Array, Object, String, Map, Set, Promise, setTimeout, clearTimeout, Error, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
        localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
        document: { addEventListener: (e, h) => { (doc[e] ||= []).push(h); }, dispatchEvent() {} },
        addEventListener: (e, h) => { (listeners[e] ||= []).push(h); }, removeEventListener: (e, h) => { listeners[e] = (listeners[e] || []).filter((x) => x !== h); },
        DeviceMotionEvent: class {}
    });
    ctx.window = ctx; ctx.globalThis = ctx;
    vm.runInContext(`
        const SmartDrive = { trip: { active: true } };
        const BikeFuel = { snap: __snap, active: () => true, kmPerL: (k) => __kmPerLAt(k) };
        const FuelCurve = { kmPerL: () => null };
        const SpeedLimits = { known: () => __limit !== null, current: { limit: __limit } };
        const navState = { active: false, routePath: null, nextManeuverM: null };
        let myCoords = null; const myWeatherCode = __wet; const myWeatherCodeAt = __wet === null ? 0 : Date.now();
        const currentTravelMode = "bike";
        function voiceAnnounce(text, opts) { __said.push({ text, opts }); return true; }
        this.__setCoords = (c) => { myCoords = c; };
    `, Object.assign(ctx, { __snap: snap, __kmPerLAt: kmPerLAt, __limit: limit, __wet: wetCode, __said: said }));
    for (const f of ["public/js/advice/advice.js", "public/js/advice/advice-app.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
    return { ctx, said, listeners, app: ctx.MUAdvice.app };
}
/** Ride north at v km/h for secs seconds (one accepted fix a second), with the clock moved forward. */
function rideApp(env, v, secs, t0, opts = {}) {
    const realNow = Date.now;
    let r;
    try {
        for (let i = 0; i < secs; i++) {
            const t = t0 + i;
            env.ctx.Date.now = () => t * 1000;
            env.ctx.__setCoords({ lat: 20 + (t * v / 3.6) / 110540, lng: 85 });
            if (opts.gyro) for (const h of env.listeners.devicemotion || []) h({ rotationRate: { alpha: opts.gyro, beta: 0, gamma: 0 } });
            r = env.app.onTick({ smoothedKmh: v, accepted: true, accuracyM: 5 });
        }
    } finally { env.ctx.Date.now = realNow; }
    return r;
}

test("advice app: steady riding over the eco band → one advice through the voice, priority 30, dropIfBusy", () => {
    const env = loadAdviceApp();
    const r = rideApp(env, 75, 40, 1_000_000);
    assert.equal(env.said.length, 1, JSON.stringify(env.said));
    const { text, opts } = env.said[0];
    assert.match(text, /^Easing to 60 would use about \d+ percent less fuel\.$/);
    assert.deepEqual({ ...opts, key: undefined, cooldownMs: undefined }, { priority: 30, category: "advice", drivingOnly: true, dropIfBusy: true, maxAgeMs: 3000, key: undefined, cooldownMs: undefined });
    assert.equal(r.state, "cooldown");
    assert.equal(typeof env.listeners.devicemotion?.[0], "function", "the gyroscope is listened to while riding");
});

test("advice app: capped by the posted limit; silent in rain, while cornering (gyro) and on a quiet ride", () => {
    let env = loadAdviceApp({ limit: 65 });
    rideApp(env, 75, 40, 1_000_000);
    assert.equal(env.said.length, 0, "75 in a 65: the speed alerts speak, not advice");
    env = loadAdviceApp({ limit: 70 });
    rideApp(env, 68, 40, 1_000_000);
    assert.equal(env.said.length, 1, "68 in a 70: advice, to a speed within the limit");
    assert.ok(Number(/Easing to (\d+)/.exec(env.said[0].text)[1]) <= 70);
    env = loadAdviceApp({ wetCode: 63 });
    assert.ok(rideApp(env, 75, 40, 1_000_000).reasons.includes("wet"));
    assert.equal(env.said.length, 0);
    env = loadAdviceApp();
    assert.ok(rideApp(env, 75, 40, 1_000_000, { gyro: 25 }).reasons.includes("cornering"));
    assert.equal(env.said.length, 0);
    env = loadAdviceApp({ quietStored: true });
    assert.equal(rideApp(env, 75, 40, 1_000_000).state, "quiet");
    assert.equal(env.said.length, 0);
    env.app.setQuiet(false);
    rideApp(env, 75, 40, 1_000_100);
    assert.equal(env.said.length, 1, "quiet ride off: advice again");
});
