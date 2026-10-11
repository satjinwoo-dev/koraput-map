// Roadmap Step 8: the road-conditions model, the speed-advice badge and the HUD scale
// (js/advice/conditions.js, overlay.js, advice-ui.js; js/hud/hud.js), wired to the safety
// gate of js/advice/advice.js + advice-app.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT } from "../smartdrive/harness.mjs";

const require = createRequire(import.meta.url);
const C = require("../../public/js/advice/conditions.js");
const HUD = require("../../public/js/hud/hud.js");

const KMH = 1 / 3.6, MM = 1e-3, MMH = MM / 3600;

test("conditions: classification from SI readings, most severe wins", () => {
    const k = (w) => C.classify(w).kind;
    assert.equal(k(null), "unknown");
    assert.equal(k({}), "unknown");
    assert.equal(k({ rate: 0, recent: 0, code: 1, temperature: 300 }), "dry");
    assert.equal(k({ rate: 0.6 * MMH, recent: 0.2 * MM, code: 61, temperature: 298 }), "wet");
    assert.equal(k({ rate: 0, recent: 1.2 * MM, code: 3, temperature: 298 }), "wet");      // it rained an hour ago
    assert.equal(k({ rate: 0, recent: 0.1 * MM, code: 3, temperature: 298 }), "dry");
    assert.equal(k({ rate: 6 * MMH, code: 63, temperature: 298 }), "heavy");
    assert.equal(k({ rate: 0, code: 82, temperature: 298 }), "heavy");
    assert.equal(k({ rate: 0, code: 45, temperature: 290 }), "fog");
    assert.equal(k({ rate: 2 * MMH, code: 95, temperature: 300 }), "storm");
    assert.equal(k({ rate: 0.5 * MMH, code: 61, temperature: C.ZERO_C + 1 }), "ice");
    assert.equal(k({ rate: 0, code: 2, temperature: C.ZERO_C + 1 }), "dry");               // cold but dry is not ice
    assert.equal(k({ rate: 0, code: 2, temperature: 300, gust: 60 * KMH }), "wind");
    assert.equal(k({ rate: 0.5 * MMH, code: 61, temperature: 300, gust: 60 * KMH }), "wet"); // equal severity: the slower factor wins
    const wet = C.classify({ rate: 0.6 * MMH, code: 61, temperature: 298 });
    assert.equal(wet.factor, 0.85); assert.equal(wet.severity, 1);
    assert.match(wet.detail, /0\.6 mm an hour/);
});

test("conditions: Open-Meteo JSON → SI (mm → m, °C → K, interval-aware rate, last 2 hours)", () => {
    const t = 1_760_000_000;
    const w = C.parseOpenMeteo({
        current: { time: t, interval: 900, precipitation: 0.3, weather_code: 61, temperature_2m: 24, wind_gusts_10m: 7.5 },
        hourly: { time: [t - 3 * 3600, t - 2 * 3600, t - 3600, t, t + 3600], precipitation: [5, 1, 0.4, 0.2, 9] }
    });
    assert.ok(Math.abs(w.rate - (0.3e-3 / 900)) < 1e-15);
    assert.ok(Math.abs(w.recent - 0.6e-3) < 1e-12);                 // the two hourly sums ending in the last 2 h
    assert.equal(w.code, 61); assert.ok(Math.abs(w.temperature - 297.15) < 1e-9); assert.equal(w.gust, 7.5);
    assert.equal(C.parseOpenMeteo({}), null);
    const partial = C.parseOpenMeteo({ current: { time: t, temperature_2m: null } });
    assert.equal(partial.rate, null); assert.equal(partial.temperature, null); assert.equal(partial.recent, null);
});

test("conditions: roads stay 'may still be wet' for 30 min; offline keeps the last reading for 20 min", () => {
    const tr = C.createTracker();
    const wet = C.classify({ rate: 1 * MMH, code: 61, temperature: 298 }), dry = C.classify({ rate: 0, recent: 0, code: 1, temperature: 298 });
    let u = tr.update(wet, 0);
    assert.deepEqual([u.condition.kind, u.changed, u.worsened], ["wet", true, true]);
    u = tr.update(dry, 10 * 60000);
    assert.equal(u.condition.kind, "drying"); assert.match(u.condition.detail, /10 min ago/); assert.equal(u.worsened, false);
    u = tr.update(C.classify(null), 15 * 60000);                     // offline: keep the last reading, still drying
    assert.equal(u.condition.kind, "drying"); assert.match(u.condition.detail, /15 min ago/);
    u = tr.update(C.classify(null), 29 * 60000);                     // reading 19 min old, rain 29 min ago: still drying
    assert.equal(u.condition.kind, "drying");
    u = tr.update(C.classify(null), 31 * 60000);                     // reading 21 min old: stale
    assert.equal(u.condition.kind, "unknown");
    u = tr.update(dry, 41 * 60000);
    assert.equal(u.condition.kind, "dry");
    u = tr.update(C.classify(null), 70 * 60000);
    assert.equal(u.condition.kind, "unknown");                       // too old to trust
});

test("advice: 5 km/h steps below the limit, GPS grace, nothing claimed on untrusted GPS", () => {
    const wet = C.classify({ rate: 1 * MMH, code: 61, temperature: 298 });
    const heavy = C.classify({ rate: 6 * MMH, code: 65, temperature: 298 });
    const r = (o) => C.advise(o);
    assert.equal(Math.round(r({ limit: 60 * KMH, condition: wet, speed: 40 * KMH }).advised / KMH), 50);   // 51 → 50
    assert.equal(Math.round(r({ limit: 60 * KMH, condition: heavy, speed: 40 * KMH }).advised / KMH), 40); // 42 → 40
    assert.equal(Math.round(r({ limit: 30 * KMH, condition: heavy }).advised / KMH), 20);
    assert.equal(Math.round(r({ limit: 10 * KMH, condition: heavy }).advised / KMH), 10);                 // floor of 10 km/h
    assert.equal(r({ limit: 60 * KMH, condition: C.classify({ rate: 0, code: 1, temperature: 298 }) }).advised, null);
    assert.equal(r({ limit: null, condition: wet }).advised, null);
    // over the limit: 5 % / 3 km/h grace
    assert.equal(r({ limit: 60 * KMH, speed: 62 * KMH }).overLimit, 0);
    assert.ok(Math.abs(r({ limit: 60 * KMH, speed: 70 * KMH }).overLimit / KMH - 10) < 1e-9);
    assert.equal(r({ limit: 60 * KMH, speed: 90 * KMH, confidence: 0.3 }).overLimit, 0);
    // over the advice: more than 5 km/h above it
    assert.equal(r({ limit: 60 * KMH, condition: wet, speed: 54 * KMH }).overAdvised, 0);
    assert.ok(r({ limit: 60 * KMH, condition: wet, speed: 58 * KMH }).overAdvised > 0);
});

test("overlay model: one message at a time, words + numbers, nothing when there's nothing to add", () => {
    const wet = C.classify({ rate: 1 * MMH, code: 61, temperature: 298 }), fog = C.classify({ code: 45, temperature: 290 });
    assert.equal(C.overlayModel({ limit: 60 * KMH, speed: 50 * KMH }), null);
    assert.equal(C.overlayModel({ limit: null, speed: 50 * KMH, condition: C.classify(null) }), null);
    let m = C.overlayModel({ limit: 60 * KMH, speed: 50 * KMH, condition: wet });
    assert.deepEqual([m.kicker, Math.round(m.value / KMH), m.word, m.tone], ["Advised", 50, "Wet", "info"]);
    assert.match(m.detail, /not a legal limit/);
    m = C.overlayModel({ limit: 60 * KMH, speed: 60 * KMH, condition: wet });
    assert.equal(m.tone, "warn");                                    // 10 over the advice
    m = C.overlayModel({ limit: null, speed: 50 * KMH, condition: fog });
    assert.deepEqual([m.kicker, m.value, m.word, m.tone], ["Fog", null, "Ease off", "warn"]);
    m = C.overlayModel({ limit: 40 * KMH, speed: 52 * KMH });
    assert.deepEqual([m.kicker, Math.round(m.value / KMH), m.tone], ["Over by", 12, "warn"]);
    assert.equal(C.overlayModel({ limit: 40 * KMH, speed: 52 * KMH, enabled: false }), null);
    assert.equal(C.overlayModel({ limit: 40 * KMH, speed: 52 * KMH, quiet: true }).quiet, true);
});

test("weather fetch: one request per ~5 km cell per 10 min, SI out, offline → unknown", async () => {
    const calls = [];
    const fakeFetch = async (url) => { calls.push(url); return { ok: true, json: async () => ({ current: { time: 1, interval: 900, precipitation: 0.5, weather_code: 61, temperature_2m: 25 }, hourly: { time: [1], precipitation: [0.5] } }) }; };
    const wx = C.createWeather({ fetch: /** @type {any} */ (fakeFetch), online: () => true });
    const a = await wx.get(18.8121, 82.7106, 0);
    assert.equal(a.ok, true); assert.equal(a.condition.kind, "wet"); assert.equal(a.cached, false);
    assert.match(calls[0], /latitude=18\.80&longitude=82\.70/);        // rounded: the exact position never leaves
    assert.match(calls[0], /wind_speed_unit=ms/); assert.match(calls[0], /past_hours=2/);
    const b = await wx.get(18.8139, 82.7121, 60000);
    assert.equal(b.cached, true); assert.equal(calls.length, 1);
    await wx.get(18.8139, 82.7121, 11 * 60000);
    assert.equal(calls.length, 2);
    const off = C.createWeather({ fetch: /** @type {any} */ (fakeFetch), online: () => false });
    const o = await off.get(10, 10, 0);
    assert.deepEqual([o.ok, o.condition.kind], [false, "unknown"]);
    const broken = C.createWeather({ fetch: /** @type {any} */ (async () => { throw new Error("net"); }), online: () => true });
    assert.equal((await broken.get(10, 10, 0)).condition.kind, "unknown");
});

test("HUD scale shows the advised speed only when it's below the limit", () => {
    const s = { v: 50 * KMH, eco: { low: 30 * KMH, high: 45 * KMH }, limit: 60 * KMH };
    const g1 = HUD.scaleGeometry(s, 50 * KMH);
    assert.ok(g1.advised !== null && g1.advised < g1.limit);
    assert.equal(HUD.scaleGeometry(s, 60 * KMH).advised, null);
    assert.equal(HUD.scaleGeometry(s).advised, null);
    assert.ok(HUD.scaleGeometry({ v: 10 * KMH, eco: null, limit: null }, 50 * KMH).advised > 0);
});

test("HUD scale: the red line is the POSTED limit even when the eco band is clamped to the advised speed", () => {
    const s = { v: 63 * KMH, eco: { low: 31 * KMH, high: 43 * KMH }, limit: 50 * KMH };   // estimator limit = advised (clamp)
    const g = HUD.scaleGeometry(s, 50 * KMH, 60 * KMH);
    assert.ok(Math.abs(g.limit / 100 * g.max - 60) < 1e-9);
    assert.ok(Math.abs(g.advised / 100 * g.max - 50) < 1e-9);
    assert.equal(HUD.scaleGeometry(s, 50 * KMH, null).limit, null);                 // no posted limit: no red line
});

test("advice UI → the safety gate: one quiet-ride setting and one road condition for tips AND the cue rules every spoken cue passes", () => {
    const store = new Map(), doc = {}, el = {};
    const mkEl = (id) => (el[id] ||= { id, checked: false, hidden: false, textContent: "", dataset: {}, style: {}, addEventListener(e, h) { (this._h ||= {})[e] = h; }, closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) });
    const ctx = vm.createContext({
        console, Math, JSON, Date, Number, Array, Object, String, Map, Set, Promise, setTimeout, clearTimeout, setInterval, clearInterval, Error,
        CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
        localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
        document: { readyState: "complete", getElementById: (id) => (["quiet-ride-toggle", "weather-alerts-toggle", "speed-advice-toggle", "ask-first-toggle", "advice-status", "advice-held"].includes(id) ? mkEl(id) : null),
            addEventListener: (e, h) => { (doc[e] ||= []).push(h); }, dispatchEvent: (e) => { for (const h of doc[e.type] || []) h(e); } },
        addEventListener() {}, removeEventListener() {}, getComputedStyle: () => ({ display: "block", visibility: "visible" }), MutationObserver: class { observe() {} }
    });
    ctx.window = ctx; ctx.globalThis = ctx;
    vm.runInContext("const SmartDrive = { trip: { active: true } };", ctx);           // riding
    for (const f of ["public/js/advice/advice.js", "public/js/advice/advice-app.js", "public/js/advice/gate.js", "public/js/advice/ask.js", "public/js/advice/conditions.js", "public/js/advice/overlay.js", "public/js/advice/advice-ui.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
    const app = ctx.MUAdvice.app, live = ctx.MUAdvice.live;
    assert.equal(live.gate, undefined, "no second gate object: the cue rules are one instance inside the advice layer");
    assert.equal(live.allowVoice, undefined);
    assert.equal(typeof live.decide, "function");
    assert.equal(live.cues.askFirst, true, "Ask before tips is on by default");
    // the settings switch drives the gate's quiet ride; the voice command's change comes back to the switch
    el["quiet-ride-toggle"].checked = true; el["quiet-ride-toggle"]._h.change();
    assert.equal(app.quiet, true);
    assert.equal(live.cues.quiet, true, "the cue rules follow the same switch");
    assert.equal(live.decide("Fuel stop in 2 km", { priority: 40, category: "fuel" }).reason, "quiet", "quiet ride holds a tip");
    const warn = live.decide("Over the limit", { priority: 70, category: "speed" });
    assert.equal(warn.speak, true, "quiet ride never mutes a safety warning");
    assert.equal(store.get("mu_quiet_ride"), "1");
    assert.equal(el["advice-status"].dataset.mode, "quiet");
    app.setQuiet(false);
    assert.equal(el["quiet-ride-toggle"].checked, false, "\"quiet ride\" by voice moves the switch");
    assert.equal(live.cues.quiet, false, "… and the cue rules");
    // the HUD's quiet button
    ctx.document.dispatchEvent(new ctx.CustomEvent("mu:advice-set", { detail: { quiet: true } }));
    assert.equal(app.quiet, true);
    app.setQuiet(false);
    // a wet reading from the tracker → the gate holds tips on a steady road
    live._applyWeather({ rate: 2 * MMH, recent: 3 * MM, code: 61, temperature: 300, gust: 3 });
    assert.equal(live.condition.kind, "wet");
    ctx.MUAdvice.app.reset();
    const r = app.onTick({ smoothedKmh: 60, accepted: true, accuracyM: 5 });
    assert.ok(r.reasons.includes("wet"), JSON.stringify(r));
    assert.equal(app.mode().key, "storm");
    // the same wet reading reaches the cue rules: heavy rain (severity ≥ 2) holds tips there too
    live._applyWeather({ rate: 8 * MMH, recent: 10 * MM, code: 65, temperature: 300, gust: 3 });
    assert.ok(live.cues.condition && live.cues.condition.severity >= 2, JSON.stringify(live.cues.condition));
    assert.equal(live.decide("Eco tip", { priority: 30, category: "eco" }).reason, "weather");
    // Ask before tips: the switch, stored on the phone
    el["ask-first-toggle"].checked = false; el["ask-first-toggle"]._h.change();
    assert.equal(live.cues.askFirst, false);
    assert.equal(JSON.parse(store.get("mu.advice.v1")).askFirst, false);
    live._applyWeather({ rate: 0, recent: 0, code: 0, temperature: 300, gust: 2 });
    assert.ok(["dry", "drying"].includes(live.condition.kind));
    assert.equal(JSON.parse(store.get("mu.advice.v1") || "{}").quiet, undefined, "quiet ride is stored once, by the gate");
});
