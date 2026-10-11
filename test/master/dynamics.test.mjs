// Phase 2, component 1: bike dynamics. DynamicsFrame contract, provider, and the
// dynamics agent riding fixtures/kotlin-dynamics-ride.jsonl, written by the real
// Kotlin DynamicsCore from a simulated 100 Hz ride (perception-jvmtest/GenDynamics.kt):
//   leg 1 east: rough stretch 100–200 m, pothole at 300 m, stop 20 s
//   leg 2 west: hard brake 5 m/s² at 350 m, very hard 7 m/s² at 200 m, pothole again, stop 20 s
//   leg 3 east: pothole ahead (now known from 2 passes), hard brake 4.5 m/s² at 420 m, stop 25 s
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const DY = require("../../public/js/master/perception/dynamics.js");
const C = require("../../public/js/master/contracts.js");
const B = require("../../public/js/master/bus.js");
const K = require("../../public/js/master/kernel.js");
const CAPS = require("../../public/js/master/capabilities.js");
const P = require("../../public/js/master/persona.js");
const PH = require("../../public/js/master/phrases-desi.js");
const O = require("../../public/js/master/output.js");
const BR = require("../../public/js/master/brain.js");
const RIDE = require("../../public/js/master/agents/ride-agent.js");
const DYN = require("../../public/js/master/agents/dynamics-agent.js");

const FIXTURE = fileURLToPath(new URL("./fixtures/kotlin-dynamics-ride.jsonl", import.meta.url));
const frames = () => fs.readFileSync(FIXTURE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const LNG0 = 73.8567, M_PER_DEG_LNG = 111320 * Math.cos(18.5204 * Math.PI / 180);
const xOf = (lng) => (lng - LNG0) * M_PER_DEG_LNG;
const tick = () => new Promise((r) => setImmediate(r));

test("DynamicsFrame contract: every Kotlin frame valid; bad events dropped, not the frame", () => {
    const all = frames();
    assert.ok(all.length > 200);
    for (const f of all) { const v = DY.validateDynamics(f); assert.ok(v.ok, v.errors.join("; ")); assert.equal(v.dropped, 0); }
    const types = all.flatMap((f) => f.events.map((e) => e.type));
    assert.equal(types.filter((t) => t === "hard_brake").length, 3);
    const brakes = all.flatMap((f) => f.events).filter((e) => e.type === "hard_brake");
    assert.deepEqual(brakes.map((e) => Math.round(xOf(e.lng) / 10) * 10), [350, 200, 420]);    // where the script braked
    assert.ok(brakes.every((e) => e.source === "imu+gnss"));
    assert.ok(Math.abs(brakes[1].peakMs2) >= 6.5, "the very hard one");
    const potholeHits = all.flatMap((f) => f.events).filter((e) => e.type === "jolt" && Math.abs(xOf(e.lng) - 300) < 6);
    assert.equal(potholeHits.length, 3);                                                      // one per pass
    const f = { ...all[50], events: [...all[50].events, { type: "wheelie", t: 1, peakMs2: 1, durS: 1, conf: 0.5 }, { type: "jolt", t: 1, peakMs2: 9, durS: 0.1, conf: 7 }] };
    const v = DY.validateDynamics(f);
    assert.equal(v.ok, true);
    assert.equal(v.dropped, 2);
    assert.equal(DY.validateDynamics({ ...all[0], v: 2 }).ok, false);
    assert.equal(DY.validateDynamics({ ...all[0], ego: { speedMs: 3 } }).ok, false);
});

test("dynamics provider: native plugin path (owner, JSON text, stop releases)", async () => {
    const calls = [], listeners = new Set();
    const plugin = {
        addListener: async (ev, fn) => { assert.equal(ev, "dynamics"); listeners.add(fn); return { remove: async () => listeners.delete(fn) }; },
        startDynamics: async (o) => { calls.push(["start", o]); }, stopDynamics: async (o) => { calls.push(["stop", o]); }
    };
    const pv = DY.createDynamicsProvider({ plugin, owner: "app" });
    const got = [];
    pv.onFrame((f) => got.push(f));
    await pv.start();
    for (const fn of listeners) { fn({ dynamics: JSON.stringify(frames()[3]) }); fn({ dynamics: "{oops" }); }
    assert.equal(got.length, 1);
    assert.equal(pv.status().framesDropped, 1);
    await pv.stop();
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["start", { owner: "app" }], ["stop", { owner: "app" }]]);
    assert.equal(listeners.size, 0);
});

// ---------------------------------------------------------------- the whole Master AI
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

function fakeWindow() {
    const m = new Map();
    return { localStorage: { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } } };
}

async function ride(list, store = fakeWindow()) {
    const clock = fakeClock(list[0].t - 500);
    const bus = B.createBus({ now: clock.now, timers: clock.timers });
    const caps = CAPS.createCapabilities();
    caps.provide("store", CAPS.createStoreProvider(store));
    const drives = emitter();
    let drive = { driving: false, navigating: false };
    caps.provide("location", { available: () => true, current: () => null, onFix: emitter().on });
    caps.provide("drive", { available: () => true, current: () => drive, onChange: drives.on });
    caps.provide("dynamics", DY.createDynamicsProvider({ replay: list, timers: clock.timers }));
    const said = [], islands = [];
    const persona = PH.install(P.createPersona({ style: "desi", rng: () => 0 }));
    const output = O.createOutput({ window: {}, voice: (text, o) => { said.push({ text, at: clock.now(), ...o }); return true; }, island: (s) => { islands.push({ ...s, at: clock.now() }); return true; }, busy: () => false, emit: () => {} });
    BR.createBrain({ bus, contracts: C, persona, output, now: clock.now, timers: clock.timers });
    const kernel = K.createKernel({ bus, caps, contracts: C, now: clock.now, timers: clock.timers, log: { info() {}, warn() {}, error() {} } });
    const reports = [];
    bus.subscribe("report.**", (d) => reports.push({ ...d, at: clock.now() }));
    kernel.define(RIDE); kernel.define(DYN); kernel.start();
    drive = { driving: true, navigating: false }; drives.emit(drive);
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(kernel.get("dynamics").state, "running");
    clock.advance(list[list.length - 1].t - list[0].t + 2000);
    return { reports, said, islands, bus, kernel, store };
}

test("Kotlin ride → dynamics agent → Master AI: tips only when stopped, rough road once, the known pothole warned ahead", async () => {
    const list = frames();
    const speedAt = (t) => { let s = 0; for (const f of list) { if (f.t > t) break; s = f.ego.speedMs; } return s; };
    const e = await ride(list);
    const kinds = (k) => e.reports.filter((r) => r.kind === k);

    // braking: nothing while moving; the very hard one gets a check-in at the next stop, the pattern at the one after
    const check = kinds("ride.hard-brake-check"), pattern = kinds("ride.braking-pattern");
    assert.equal(check.length, 1);
    assert.equal(pattern.length, 1);
    assert.equal(pattern[0].data.count, 3);
    for (const r of [...check, ...pattern]) assert.ok(speedAt(r.at) < 0.8, `said while riding at ${speedAt(r.at)} m/s`);
    assert.ok(check[0].at < pattern[0].at);
    assert.ok(e.said.some((s) => /bahut zor ka brake/.test(s.text)), "desi check-in");
    assert.ok(e.said.some((s) => /3 baar/.test(s.text)), "desi pattern tip");
    assert.ok(e.islands.some((i) => i.title === "Very hard braking"));
    assert.ok(e.islands.some((i) => i.title === "Hard braking"));

    // rough stretch: once (10 min cooldown), while riding
    const rough = kinds("road.rough-stretch");
    assert.equal(rough.length, 1);
    assert.ok(speedAt(rough[0].at) > 5);
    assert.ok(e.islands.some((i) => i.title === "Rough road"));

    // the pothole: unknown on pass 1, confirmed by pass 2, warned 2–8 s ahead on pass 3 (and only there)
    const bumps = kinds("road.bump-ahead");
    assert.equal(bumps.length, 1, bumps.map((b) => b.data.distanceM).join(","));
    assert.ok(bumps[0].data.distanceM >= 20 && bumps[0].data.distanceM <= 100, `at ${bumps[0].data.distanceM} m`);
    assert.equal(bumps[0].data.passes, 2);
    const leg3 = list.findIndex((f, i) => i > 150 && f.ego.speedMs > 3);
    assert.ok(bumps[0].at >= list[leg3].t, "only on the third pass");
    assert.ok(e.said.some((s) => /aage jhatka|gaddha ya breaker/.test(s.text)));
    assert.ok(e.islands.some((i) => i.title === "Bump ahead"));

    // screen words are English; the spoken ones desi
    for (const i of e.islands) assert.doesNotMatch(`${i.title} ${i.sub}`, /\b(bhai|jhatka|gaddha|baar|aage)\b/i);

    const st = e.bus.last("state.dynamics");
    assert.equal(st.hardBrakes, 3);
    assert.equal(st.veryHardBrakes, 1);
    assert.ok(st.confirmedBumps >= 1);
    assert.ok(st.roughM >= 60);
});

test("dynamics agent: a known pothole is warned on the first pass of the next ride (memory on the phone)", async () => {
    const list = frames();
    const store = fakeWindow();                                   // the same phone storage for both rides
    await ride(list, store);                                      // ride 1 learns the spot
    const e2 = await ride(list.map((f) => ({ ...f, t: f.t + 86400000, events: f.events.map((x) => ({ ...x, t: x.t + 86400000 })), segments: f.segments.map((s) => ({ ...s, t: s.t + 86400000 })) })), store);
    const bumps = e2.reports.filter((r) => r.kind === "road.bump-ahead");
    assert.ok(bumps.length >= 2, `warned ${bumps.length} times`);   // every pass of the next day's ride
    const firstLegEnd = list.findIndex((f, i) => i > 20 && f.ego.speedMs < 0.5) ;
    assert.ok(bumps[0].at <= list[firstLegEnd].t + 86400000, "already on leg 1");
});
