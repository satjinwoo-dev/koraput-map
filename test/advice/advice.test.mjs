// Roadmap step 8: advice layer & safety gate (public/js/advice/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const G = require("../../public/js/advice/gate.js");
const C = require("../../public/js/advice/conditions.js");
const HUD = require("../../public/js/hud/hud.js");

const KMH = 1 / 3.6, MM = 1e-3, MMH = MM / 3600;

test("cue levels come from what callers already say (priority, category, force)", () => {
    assert.equal(G.classify({ priority: 90, category: "speed" }), "critical");      // far over the limit
    assert.equal(G.classify({ priority: 40, category: "sos" }), "critical");
    assert.equal(G.classify({ priority: 10, force: true }), "critical");            // a reply to the rider
    assert.equal(G.classify({ priority: 65, category: "nav" }), "nav");
    assert.equal(G.classify({ priority: 62, category: "speed" }), "warning");       // over the limit
    assert.equal(G.classify({ priority: 58, category: "speed" }), "advice");        // "speed limit 40"
    assert.equal(G.classify({ priority: 40, category: "convoy" }), "advice");
    assert.equal(G.classify({}), "advice");
});

test("gate: safety-critical cues are spoken in every state", () => {
    const g = G.createGate();
    g.setQuiet(true); g.setConfidence(0.1); g.setCondition({ kind: "storm", severity: 3, label: "Thunderstorm" }); g.noteHarsh(1000);
    for (const msg of [{ priority: 90, category: "speed" }, { priority: 30, category: "sos" }, { force: true }]) {
        const d = g.decide(msg, 1500);
        assert.equal(d.speak, true); assert.equal(d.reason, "safety");
    }
});

test("gate: quiet ride keeps directions (by default), shows warnings, holds tips", () => {
    const g = G.createGate();
    g.setQuiet(true);
    assert.deepEqual(g.decide({ priority: 65, category: "nav" }, 0), { speak: true, show: true, level: "nav", reason: "ok" });
    assert.deepEqual(g.decide({ priority: 62, category: "speed" }, 10), { speak: false, show: true, level: "warning", reason: "quiet" });
    assert.deepEqual(g.decide({ priority: 45, category: "fuel" }, 20), { speak: false, show: false, level: "advice", reason: "quiet" });
    g.setKeepNav(false);
    assert.equal(g.decide({ priority: 65, category: "nav" }, 30).speak, false);
    assert.equal(g.state.held.quiet, 3);
    assert.match(G.heldSummary(g.state.held), /^This ride: 3 cues held back: 3 \(quiet ride\)\.$/);
});

test("gate: weak GPS holds speed cues but not directions; busy window after a turn or hard brake; spacing", () => {
    const g = G.createGate();
    g.setConfidence(0.4);
    assert.equal(g.decide({ priority: 62, category: "speed" }, 0).reason, "gps");
    assert.equal(g.decide({ priority: 58, category: "weather" }, 0).reason, "gps");
    assert.equal(g.decide({ priority: 45, category: "fuel" }, 0).reason, "ok");          // not a speed cue
    g.setConfidence(0.9);
    // a spoken turn prompt opens a 6 s window for tips
    assert.equal(g.decide({ priority: 65, category: "nav" }, 100000).speak, true);
    assert.equal(g.decide({ priority: 40, category: "convoy" }, 103000).reason, "busy");
    assert.equal(g.decide({ priority: 62, category: "speed" }, 103000).speak, true);   // warnings aren't held for "busy"
    assert.equal(g.decide({ priority: 40, category: "convoy" }, 106500).speak, true);
    // spacing: the next tip within 45 s is shown but not spoken
    const d = g.decide({ priority: 40, category: "fuel" }, 120000);
    assert.deepEqual([d.speak, d.show, d.reason], [false, true, "spacing"]);
    assert.equal(g.decide({ priority: 40, category: "fuel" }, 151600).speak, true);
    g.noteHarsh(200000);
    assert.equal(g.decide({ priority: 40, category: "fuel" }, 203000).reason, "busy");
    assert.equal(g.mode(203000).key, "busy");
});

test("gate: heavy weather holds tips; mode() names the state; resetRide clears the counters", () => {
    const g = G.createGate();
    g.setCondition({ kind: "heavy", severity: 2, label: "Heavy rain" });
    assert.equal(g.decide({ priority: 40 }, 0).reason, "weather");
    assert.equal(g.decide({ priority: 62, category: "speed" }, 0).speak, true);
    assert.deepEqual([g.mode(0).key, g.mode(0).label], ["storm", "Heavy rain"]);
    g.setCondition({ kind: "wet", severity: 1, label: "Wet road" });
    assert.equal(g.decide({ priority: 40 }, 1).speak, true);                       // wet roads alone don't silence tips
    g.setQuiet(true); assert.equal(g.mode(2).key, "quiet");
    g.setQuiet(false); g.setConfidence(0.3); assert.equal(g.mode(3).key, "degraded");
    assert.ok(g.state.log.length > 0);
    g.resetRide();
    assert.deepEqual(g.state.held, {}); assert.equal(g.state.log.length, 0);
    assert.equal(g.decide({ priority: 40 }, 4, { dryRun: true }).reason, "ok");
    assert.equal(g.state.log.length, 0);                                           // dry runs leave no trace
});

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
