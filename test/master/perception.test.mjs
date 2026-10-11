// Master AI: unified road model integration (js/master/perception/, agents/road-agent.js)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PC = require("../../public/js/master/perception/contract.js");
const GV = require("../../public/js/master/perception/governor.js");
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

// ---------------------------------------------------------------- a tiny world simulator → PerceptionFrames
/**
 * The bike rides north at `speed` from (20, 85). Static hazards sit at a road position `at` metres from
 * the start; objects have their own speed. Distances get Gaussian-free deterministic noise.
 */
function world({ speed = 12, hz = 10, seconds = 10, t0 = 1_000_000, hazards = [], objects = [], relations = [], thermal = "none", usable = 0.9, startSeq = 0 } = {}) {
    const frames = [];
    for (let i = 0; i < seconds * hz; i++) {
        const tS = i / hz, ego = speed * tS;
        const f = {
            v: 1, t: t0 + Math.round(tS * 1000), seq: startSeq + i, model: { id: "mu-road", version: "0.0.1-sim", calib: "sim" },
            perf: { fps: hz, latencyMs: 40, thermal: typeof thermal === "function" ? thermal(tS) : thermal, delegate: "npu" },
            ego: { speedMs: speed, speedSigma: 0.3, headingDeg: 0, pitchDeg: 0, rollDeg: 0, lat: 20 + ego / 111320, lng: 85, posSigmaM: 3 },
            quality: { usable, reasons: [] },
            objects: [], hazards: [], relations: []
        };
        for (const h of hazards) {
            if (h.from !== undefined && tS < h.from) continue;
            const d = (h.at - ego) + (h.drift ? h.drift * tS : 0) + (((i * 7) % 5) - 2) * 0.15;
            if (d < 2 || d > 120 || (h.flicker && i % 2)) continue;
            f.hazards.push({ id: h.id, cls: h.cls, conf: h.conf ?? 0.82, box: [0.45, 0.7, 0.1, 0.05], distM: d, distSigma: Math.max(0.8, d * 0.08), lateralM: h.lateral ?? 0.2, lateralSigma: 0.3, sizeM: 0.6 });
        }
        for (const o of objects) {
            const d = o.at + (o.speed - speed) * tS;
            if (d < 1) continue;
            const closing = speed - o.speed;
            f.objects.push({ id: o.id, cls: o.cls, conf: o.conf ?? 0.88, box: [0.4, 0.4, 0.2, 0.2], distM: d, distSigma: Math.max(0.6, d * 0.07), closingMs: closing, closingSigma: o.closingSigma ?? 0.6, ttcS: closing > 0 ? d / closing : null, lane: o.lane ?? "ego" });
        }
        for (const r of relations) if (f.objects.some((x) => x.id === r.subj)) f.relations.push(r);
        frames.push(f);
    }
    return frames;
}

// ---------------------------------------------------------------- contract
test("contract: a good frame passes; items without uncertainty are dropped, not the frame", () => {
    const [f] = world({ hazards: [{ id: 1, cls: "pothole", at: 50 }], objects: [{ id: 7, cls: "truck", at: 30, speed: 8 }] });
    const ok = PC.validateFrame(f);
    assert.equal(ok.ok, true); assert.equal(ok.frame.hazards.length, 1); assert.equal(ok.dropped, 0);
    const bad = JSON.parse(JSON.stringify(f));
    delete bad.hazards[0].distSigma;
    bad.objects.push({ id: 9, cls: "spaceship", conf: 0.9, box: [0, 0, 0.1, 0.1], distM: 5, distSigma: 1, closingMs: 0, closingSigma: 0 });
    bad.relations.push({ subj: 404, rel: "wrong_side", conf: 0.9 });
    bad.quality.reasons = ["glare", "made-up"];
    const v = PC.validateFrame(bad);
    assert.equal(v.ok, true);
    assert.equal(v.frame.hazards.length, 0); assert.equal(v.frame.objects.length, 1); assert.equal(v.frame.relations.length, 0);
    assert.equal(v.dropped, 3);
    assert.deepEqual(v.frame.quality.reasons, ["glare"]);
    assert.equal(PC.validateFrame({ ...f, v: 2 }).ok, false);
    assert.equal(PC.validateFrame({ ...f, ego: { speedMs: 3 } }).ok, false);           // speed without its sigma
});

test("governor: heat, view, speed and battery decide the frame rate, with hysteresis", () => {
    assert.deepEqual(GV.decide({ thermal: "none", speedMs: 12 }), { fps: 30, reason: "full", paused: false });
    assert.equal(GV.decide({ thermal: "light", speedMs: 12 }).fps, 30);              // performance profile: no throttling
    assert.equal(GV.decide({ thermal: "moderate", speedMs: 12 }).fps, 30);           // up to "moderate"
    assert.equal(GV.decide({ thermal: "severe", speedMs: 12 }).fps, 15);
    const paused = GV.decide({ thermal: "critical", speedMs: 12 });
    assert.equal(paused.fps, 0);
    assert.equal(GV.decide({ thermal: "severe", speedMs: 12 }, paused).fps, 0);        // stays paused until it cools
    assert.equal(GV.decide({ thermal: "moderate", speedMs: 12 }, paused).fps, 30);
    assert.equal(GV.decide({ thermal: "none", speedMs: 0.2 }).fps, 10);
    assert.equal(GV.decide({ thermal: "none", speedMs: 12, usable: 0.2 }).fps, 10);
    assert.equal(GV.decide({ thermal: "none", speedMs: 12, batteryPct: 9, charging: false }).fps, 15);
});

// ---------------------------------------------------------------- confirmation
const run = (watch, frames) => frames.flatMap((f) => { const r = watch.update(PC.validateFrame(f).frame); return Array.isArray(r) ? r : [r]; });

test("confirm: a pothole approaching at our own speed is confirmed; a smudge that keeps its distance is rejected", () => {
    const c = CF.createHazardConfirmer();
    const out = run(c, world({ seconds: 2, hazards: [{ id: 1, cls: "pothole", at: 60 }, { id: 2, cls: "waterlogging", at: 40, drift: 12 }] }));
    const confirmed = out.flatMap((r) => r.confirmed), rejected = out.flatMap((r) => r.rejected);
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].id, "1"); assert.equal(confirmed[0].cls, "pothole");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].id, "2");                                             // moves with us: not on the road
    assert.match(rejected[0].reason, /expected 12.0 m\/s/);
});

test("confirm: flicker, low confidence, vague distance or a bad view never confirm", () => {
    const none = (opts, extra = {}) => run(CF.createHazardConfirmer(), world({ seconds: 2, ...extra, hazards: [{ id: 1, cls: "pothole", at: 60, ...opts }] })).flatMap((r) => r.confirmed).length;
    assert.equal(none({ flicker: true }), 0);                                      // seen in every other frame
    assert.equal(none({ conf: 0.45 }), 0);
    assert.equal(none({}, { usable: 0.2 }), 0);
    const vague = world({ seconds: 2, hazards: [{ id: 1, cls: "pothole", at: 60 }] }).map((f) => { f.hazards.forEach((h) => { h.distSigma = h.distM * 0.6; }); return f; });
    assert.equal(run(CF.createHazardConfirmer(), vague).flatMap((r) => r.confirmed).length, 0);
    assert.equal(none({}), 1);
});

test("closing / relation watches: 3 frames in a row, our lane, believable numbers, once per track", () => {
    const fast = run(CF.createClosingWatch(), world({ seconds: 2, objects: [{ id: 5, cls: "truck", at: 30, speed: 2 }] }));
    assert.equal(fast.length, 1); assert.equal(fast[0].cls, "truck"); assert.ok(fast[0].ttcS <= 4);
    assert.equal(run(CF.createClosingWatch(), world({ seconds: 2, objects: [{ id: 5, cls: "truck", at: 30, speed: 2, lane: "left" }] })).length, 0);
    assert.equal(run(CF.createClosingWatch(), world({ seconds: 2, objects: [{ id: 5, cls: "truck", at: 30, speed: 2, closingSigma: 9 }] })).length, 0);
    assert.equal(run(CF.createClosingWatch(), world({ seconds: 2, objects: [{ id: 5, cls: "truck", at: 30, speed: 11 }] })).length, 0);   // slowly closing: fine
    const rel = run(CF.createRelationWatch(), world({ seconds: 2, objects: [{ id: 3, cls: "bus", at: 60, speed: -10, lane: "oncoming" }], relations: [{ subj: 3, rel: "wrong_side", obj: "ego", conf: 0.86 }] }));
    assert.equal(rel.length, 1); assert.equal(rel[0].rel, "wrong_side"); assert.equal(rel[0].cls, "bus");
});

test("provider (replay): plays on recorded time, validates, pauses at 0 fps", async () => {
    const t = { q: [], setTimeout(fn, ms) { this.q.push(fn); return this.q.length; }, clearTimeout() {} };
    const frames = world({ seconds: 1, hazards: [{ id: 1, cls: "pothole", at: 60 }] });
    frames[3] = { ...frames[3], ego: {} };                                          // one broken frame
    const pv = PV.createPerceptionProvider({ contract: PC, replay: frames.map((f) => JSON.stringify(f)).join("\n"), timers: t });
    const got = [];
    pv.onFrame((f) => got.push(f.seq));
    await pv.start({ targetFps: 30 });
    for (let i = 0; i < 5; i++) t.q.shift()();
    await pv.setTargetFps(0);
    for (let i = 0; i < 3; i++) t.q.shift()();
    await pv.setTargetFps(10);
    while (t.q.length) t.q.shift()();
    assert.deepEqual(got.slice(0, 5), [0, 1, 2, 4, 5]);
    assert.equal(got.includes(6), false); assert.equal(got.includes(7), false);      // paused
    assert.equal(pv.status().framesDropped, 1);
    assert.equal(pv.status().backend, "replay");
});

// ---------------------------------------------------------------- the agent with the real Master
function fakeClock(start = 1_000_000) {
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

function setup(frames) {
    const clock = fakeClock();
    const bus = B.createBus({ now: clock.now, timers: clock.timers });
    const caps = CAPS.createCapabilities();
    caps.provide("store", CAPS.createStoreProvider({}));
    const fixes = emitter(), drives = emitter();
    let drive = { driving: false, navigating: false };
    caps.provide("location", { available: () => true, current: () => null, onFix: fixes.on });
    caps.provide("drive", { available: () => true, current: () => drive, onChange: drives.on });
    const fpsCalls = [];
    const provider = PV.createPerceptionProvider({ contract: PC, replay: frames, timers: clock.timers });
    const wrapped = { ...provider, setTargetFps: async (fps) => { fpsCalls.push(fps); return provider.setTargetFps(fps); } };
    caps.provide("perception", wrapped);
    const said = [], islands = [];
    const persona = PH.install(P.createPersona({ style: "desi", rng: () => 0 }));
    const output = O.createOutput({ window: {}, voice: (text, o) => { said.push({ text, ...o }); return true; }, island: (s) => { islands.push(s); return true; }, busy: () => false, emit: () => {} });
    const brain = BR.createBrain({ bus, contracts: C, persona, output, now: clock.now, timers: clock.timers });
    const kernel = K.createKernel({ bus, caps, contracts: C, now: clock.now, timers: clock.timers, log: { info() {}, warn() {}, error() {} } });
    const reports = [];
    bus.subscribe("report.road.**", (d) => reports.push(d));
    kernel.define(RIDE); kernel.define(ROAD); kernel.start();
    return {
        clock, bus, kernel, provider, said, islands, reports, fpsCalls, caps,
        ride() { drive = { driving: true, navigating: false }; drives.emit(drive); },
        stop() { drive = { driving: false, navigating: false }; drives.emit(drive); }
    };
}

test("road agent: idle until riding; a pothole is said inside the 2–8 s window, in desi, with an English screen", async () => {
    const e = setup(world({ seconds: 12, hazards: [
        { id: 1, cls: "pothole", at: 150 },                    // far: waits until ~96 m (8 s at 12 m/s)
        { id: 2, cls: "open_manhole", at: 15 },                // too close to be useful: mapped, not said
        { id: 3, cls: "waterlogging", at: 70, lateral: 3.2 }   // not in our path
    ] }));
    assert.equal(e.kernel.get("road").state, "waiting");
    assert.equal(e.provider.status().running, false);          // no camera AI while not riding
    e.ride();
    await new Promise((r) => setImmediate(r));
    assert.equal(e.kernel.get("road").state, "running");
    e.clock.advance(12000);
    const hz = e.reports.filter((r) => r.kind === "road.hazard");
    assert.equal(hz.length, 1);
    assert.equal(hz[0].data.cls, "pothole");
    assert.ok(hz[0].data.distanceM <= 100 && hz[0].data.distanceM >= 80, `said at ${hz[0].data.distanceM} m`);
    const line = e.said.find((s) => /gaddha/.test(s.text));
    assert.ok(line, "spoken in desi");
    assert.match(line.text, /metre aage gaddha hai/);
    assert.ok(e.islands.some((i) => i.title === "Pothole ahead"));             // screen in English
    const state = e.bus.last("state.road");
    assert.ok(state.confirmed >= 2);                                            // manhole confirmed and mapped too
    assert.ok(state.mappedCells >= 2);
    e.stop();
    await new Promise((r) => setImmediate(r));
    assert.equal(e.provider.status().running, false);
});

test("road agent: closing truck warns once; overheating lowers the frame rate and is said once", async () => {
    const e = setup(world({ seconds: 30, objects: [{ id: 9, cls: "truck", at: 40, speed: 1 }], thermal: (t) => (t > 5 ? "severe" : "none") }));
    e.ride();
    await new Promise((r) => setImmediate(r));
    e.clock.advance(30000);
    const closing = e.reports.filter((r) => r.kind === "traffic.closing-fast");
    assert.equal(closing.length, 1);
    assert.ok(e.said.some((s) => /truck bahut paas/.test(s.text)));
    assert.ok(e.islands.some((i) => i.title === "Truck close ahead"));
    assert.ok(e.fpsCalls.includes(15));                                          // governor: severe heat → 15 fps
    assert.equal(e.reports.filter((r) => r.kind === "perception.degraded").length, 1);
    assert.equal(e.kernel.get("road").state, "degraded");
});
