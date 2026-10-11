// Master AI: break-time fatigue check (js/master/vision/, agents/vision-agent.js)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const F = require("../../public/js/master/vision/fatigue.js");
const C = require("../../public/js/master/contracts.js");
const B = require("../../public/js/master/bus.js");
const K = require("../../public/js/master/kernel.js");
const CAPS = require("../../public/js/master/capabilities.js");
const P = require("../../public/js/master/persona.js");
const PH = require("../../public/js/master/phrases-desi.js");
const O = require("../../public/js/master/output.js");
const BR = require("../../public/js/master/brain.js");
const RIDE = require("../../public/js/master/agents/ride-agent.js");
const VISION = require("../../public/js/master/agents/vision-agent.js");
const FS = require("../../public/js/master/vision/face-scan.js");

const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------- synthetic faces
/**
 * 10 s at 15 fps. events: [{ at, ms, closure }] eye closures, [{ at, ms, jaw }] yawns, [{ at, ms, pitch }] nods.
 */
function face({ seconds = 10, fps = 15, open = 0.05, closures = [], yawns = [], nods = [], pitch = 4, missing = 0 } = {}) {
    const out = [];
    const t0 = 1000;
    for (let i = 0; i < seconds * fps; i++) {
        const t = t0 + (i * 1000) / fps, rel = t - t0;
        if (missing && i % Math.round(1 / missing) === 0) { out.push({ t, face: false }); continue; }
        const c = closures.find((e) => rel >= e.at && rel < e.at + e.ms);
        const y = yawns.find((e) => rel >= e.at && rel < e.at + e.ms);
        const n = nods.find((e) => rel >= e.at && rel < e.at + e.ms);
        out.push({ t, face: true, closure: c ? c.closure ?? 0.85 : open + ((i * 7) % 5) / 100, jaw: y ? 0.8 : 0.05, pitch: n ? pitch - n.pitch : pitch + ((i * 3) % 3) / 2 });
    }
    return out;
}
const blinksEvery = (ms, dur, from = 500, to = 9800) => { const b = []; for (let at = from; at < to; at += ms) b.push({ at, ms: dur }); return b; };

test("fatigue: an alert face scores low with good confidence", () => {
    const r = F.analyzeSession(face({ closures: blinksEvery(3000, 140) }), { ridingSec: 5400 });
    assert.equal(r.level, "low");
    assert.ok(r.score < 30, `score ${r.score}`);
    assert.equal(r.confidence, "good");
    assert.equal(r.metrics.blinks, 4);
    assert.ok(r.metrics.perclos < 0.08);
    assert.deepEqual(r.signals, []);
});

test("fatigue: a long closure, a yawn and a nod score high, with the signs named", () => {
    const r = F.analyzeSession(face({
        open: 0.15,
        closures: [...blinksEvery(2000, 400, 300, 4000), { at: 5000, ms: 1300 }],
        yawns: [{ at: 6500, ms: 1600 }],
        nods: [{ at: 8200, ms: 800, pitch: 20 }]
    }), { ridingSec: 7200 });
    assert.equal(r.level, "high");
    assert.ok(r.score >= 55);
    assert.ok(r.metrics.maxClosureMs >= 1200);
    assert.equal(r.metrics.yawns, 1);
    assert.equal(r.metrics.nods, 1);
    const ids = r.signals.map((s) => s.id);
    assert.equal(ids[0], "long-closure");
    for (const id of ["yawn", "nod"]) assert.ok(ids.includes(id), id);
    assert.equal(F.signalWords(r.signals.filter((s) => s.id !== "eyes-closing")), "aankh 1.3 second tak band rahi aur ubaasi aa rahi hai");
    assert.equal(F.signalWords(r.signals.filter((s) => s.id !== "eyes-closing"), "plain"), "your eyes stayed shut for 1.3 seconds and you're yawning");
});

test("fatigue: heavy-lidded eyes aren't read as sleepy (the 'shut' line adapts); slow blinks are moderate", () => {
    const heavy = F.analyzeSession(face({ open: 0.4, closures: blinksEvery(3000, 140).map((b) => ({ ...b, closure: 0.95 })) }));
    assert.equal(heavy.level, "low");
    assert.ok(heavy.metrics.threshold >= 0.7);
    const slow = F.analyzeSession(face({ closures: blinksEvery(1200, 420) }), { ridingSec: 7200 });
    assert.ok(["moderate", "high"].includes(slow.level), `${slow.level} ${slow.score}`);
    assert.ok(slow.signals.some((s) => s.id === "slow-blinks" || s.id === "eyes-closing"));
});

test("fatigue: no face → poor confidence; a photo can't say high on eyes alone", () => {
    assert.equal(F.analyzeSession(face({ seconds: 2 })).confidence, "poor");
    assert.equal(F.analyzeSession([]).confidence, "poor");
    assert.equal(F.analyzeSession(face({ missing: 0.5 })).confidence, "fair");
    const shut = F.analyzeSnapshot({ t: 1, face: true, closure: 0.9, jaw: 0.1 }, { ridingSec: 14400 });
    assert.equal(shut.confidence, "low"); assert.ok(shut.score < 55);
    const shutYawn = F.analyzeSnapshot({ t: 1, face: true, closure: 0.9, jaw: 0.9 });
    assert.equal(shutYawn.level, "high");
    assert.equal(F.analyzeSnapshot({ t: 1, face: false }).confidence, "poor");
});

test("fatigue: MediaPipe results → frames (blendshapes, EAR fallback, head pose)", () => {
    const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    const eye = (idx, h) => { const [c1, t1, t2, c2, b2, b1] = idx; lm[c1] = { x: 0.40, y: 0.4 }; lm[c2] = { x: 0.50, y: 0.4 }; lm[t1] = { x: 0.43, y: 0.4 - h / 2 }; lm[b1] = { x: 0.43, y: 0.4 + h / 2 }; lm[t2] = { x: 0.47, y: 0.4 - h / 2 }; lm[b2] = { x: 0.47, y: 0.4 + h / 2 }; };
    eye(F.LEFT_EYE, 0.03); eye(F.RIGHT_EYE, 0.03);                         // EAR 0.3: open
    const a = 20 * Math.PI / 180;                                           // rotation about x by 20°
    const m = [1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1];
    const withBs = F.frameFromResult({ faceLandmarks: [lm], faceBlendshapes: [{ categories: [{ categoryName: "eyeBlinkLeft", score: 0.7 }, { categoryName: "eyeBlinkRight", score: 0.9 }, { categoryName: "jawOpen", score: 0.6 }] }], facialTransformationMatrixes: [{ data: m }] }, 5);
    assert.equal(withBs.face, true);
    assert.ok(Math.abs(withBs.closure - 0.8) < 1e-9);
    assert.equal(withBs.jaw, 0.6);
    assert.ok(Math.abs(Math.abs(withBs.pitch) - 20) < 1e-6);
    const noBs = F.frameFromResult({ faceLandmarks: [lm] }, 6);
    assert.ok(Math.abs(noBs.ear - 0.3) < 1e-6);
    assert.equal(noBs.closure, 0);                                          // open eyes from EAR
    eye(F.LEFT_EYE, 0.01); eye(F.RIGHT_EYE, 0.01);
    assert.ok(F.frameFromResult({ faceLandmarks: [lm] }, 7).closure > 0.9);
    assert.deepEqual(F.frameFromResult({ faceLandmarks: [] }, 8), { t: 8, face: false });
});

// ---------------------------------------------------------------- the agent, with the real ride agent and Master
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

function setup({ voice, scanResult } = {}) {
    const clock = fakeClock();
    const bus = B.createBus({ now: clock.now, timers: clock.timers });
    const caps = CAPS.createCapabilities();
    caps.provide("store", CAPS.createStoreProvider({}));
    const fixes = emitter(), drives = emitter();
    let last = null, drive = { driving: false, navigating: false };
    caps.provide("location", { available: () => true, current: () => last, onFix: fixes.on });
    caps.provide("drive", { available: () => true, current: () => drive, onChange: drives.on });
    const scan = {
        offers: [], scans: [], results: [], cards: [],
        available: () => true, busy: () => false,
        offer(o) { const card = { o, closed: false, close() { this.closed = true; } }; this.offers.push(card); return card; },
        async scan(o) {
            this.scans.push(o);
            if (typeof scanResult === "function") return scanResult(o);
            return scanResult || { ok: true, result: F.analyzeSession(face({ closures: blinksEvery(3000, 140) }), { ridingSec: o.ridingSec }) };
        },
        showResult(r, o) { this.results.push({ r, o }); return { close() {} }; },
        cancel() {}
    };
    caps.provide("face-scan", scan);
    const said = [];
    const persona = PH.install(P.createPersona({ style: "desi", rng: () => 0 }));
    const output = O.createOutput({ window: {}, voice: voice || ((text, o) => { said.push({ text, ...o }); return true; }), island: () => true, busy: () => false, emit: () => {} });
    const brain = BR.createBrain({ bus, contracts: C, persona, output, now: clock.now, timers: clock.timers });
    const kernel = K.createKernel({ bus, caps, contracts: C, now: clock.now, timers: clock.timers, log: { info() {}, warn() {}, error() {} } });
    const decisions = [], reports = [];
    bus.subscribe("master.decision", (d) => decisions.push(d));
    bus.subscribe("report.vision.**", (d) => reports.push(`${d.kind}:${d.severity}`));
    kernel.define(RIDE); kernel.define(VISION);
    kernel.start();
    let t = clock.now();
    const env = {
        clock, bus, kernel, brain, scan, said, decisions, reports,
        startRide() { drive = { driving: true, navigating: false }; drives.emit(drive); },
        endRide() { drive = { driving: false, navigating: false }; drives.emit(drive); },
        /** fixes every 2 s for `sec` seconds at `speedMs` (no lat/lng: nobody needs them here) */
        ride(sec, speedMs) { for (let i = 0; i < sec / 2; i++) { clock.advance(2000); t = clock.now(); last = { t, speedMs, lat: 20, lng: 85 }; fixes.emit(last); } },
        noFixes(sec) { clock.advance(sec * 1000); },
        breakDue() { bus.publish("report.ride.ride.break-due", { kind: "ride.break-due", severity: "advice", ridingOnly: true, data: { ridingSec: 5400 } }, { source: "ride" }); }
    };
    return env;
}

test("vision agent: break due while riding → nothing until the bike has stood still ≥ 15 s → offer → card → check → desi advice", async () => {
    const e = setup({ scanResult: { ok: true, result: F.analyzeSession(face({ open: 0.15, closures: [{ at: 4000, ms: 1300 }], yawns: [{ at: 6000, ms: 1500 }] }), { ridingSec: 5400 }) } });
    assert.equal(e.kernel.get("vision").state, "running");
    e.startRide();
    e.ride(60, 14);
    e.breakDue();
    e.ride(30, 14);
    assert.equal(e.scan.offers.length, 0);                                  // moving: no card, no camera
    assert.ok(!e.decisions.some((d) => d.kind === "vision.offer"));
    e.ride(10, 0);                                                          // stopped 10 s: not yet
    assert.equal(e.scan.offers.length, 0);
    e.ride(10, 0);                                                          // stopped ~20 s
    assert.ok(e.decisions.some((d) => d.kind === "vision.offer" && d.action === "spoken"));
    assert.match(e.said.at(-1).text, /10 second ka fatigue check/);
    assert.equal(e.scan.offers.length, 1);
    e.scan.offers[0].o.onStart();                                           // the rider taps Start
    await flush(); await flush();
    assert.equal(e.scan.scans.length, 1);
    assert.equal(e.scan.scans[0].guard(), null);                            // still standing: the check may run
    assert.equal(e.scan.scans[0].durationMs, 10000);
    assert.ok(e.reports.includes("fatigue.high:warning"));
    e.clock.advance(3000);
    assert.match(e.said.at(-1).text, /aage mat badh/);
    assert.match(e.said.at(-1).text, /aankh 1\.3 second tak band rahi/);
    assert.equal(e.bus.last("state.fatigue").level, "high");
    assert.equal(e.scan.results.length, 1);
    assert.equal(e.kernel.get("vision").state, "running");
});

test("vision agent: the bike rolling away closes the card, and stops a running check", async () => {
    let guardSeen = null;
    const e = setup({ scanResult: (o) => { e.ride(4, 6); guardSeen = o.guard(); return { ok: false, reason: guardSeen || "cancelled" }; } });
    e.startRide(); e.ride(30, 14); e.breakDue(); e.ride(20, 0);
    assert.equal(e.scan.offers.length, 1);
    e.ride(4, 6);                                                           // rolls off before tapping
    assert.equal(e.scan.offers[0].closed, true);
    e.ride(20, 0);                                                          // next stop: offered again
    assert.equal(e.scan.offers.length, 2);
    e.scan.offers[1].o.onStart();
    await flush(); await flush();
    assert.equal(guardSeen, "moving");                                      // the check saw the movement
    assert.ok(!e.reports.some((r) => r.startsWith("fatigue.")));            // and nothing is said about it
});

test("vision agent: 'nahi' to the offer ends it; one check per 45 min; no GPS while riding → no offer", async () => {
    const asks = [];
    const e = setup({ voice: (text, o) => { asks.push({ text, o }); return "ask"; } });
    e.startRide(); e.ride(30, 14); e.breakDue();
    asks[0].o.onResult({ spoken: true, reason: "asked:yes" });            // the break reminder itself was asked first
    await flush();
    e.ride(20, 0);
    const offers = () => asks.filter((a) => /fatigue check/.test(a.text));
    assert.equal(offers().length, 1);
    offers()[0].o.onResult({ spoken: false, reason: "asked:no" });
    await flush();
    assert.equal(e.scan.offers.length, 0);                                  // declined: no card
    e.ride(10, 10); e.ride(30, 0);
    assert.equal(offers().length, 1);                                       // and not asked again for this break

    const g = setup();
    g.startRide();
    g.breakDue();
    g.noFixes(120);                                                         // riding, no GPS at all
    assert.equal(g.scan.offers.length, 0);
    g.ride(30, 14); g.ride(20, 0);
    assert.equal(g.scan.offers.length, 1);
    g.scan.offers[0].o.onStart();
    await flush(); await flush();
    g.ride(60, 14); g.breakDue(); g.ride(30, 0);
    assert.equal(g.scan.offers.length, 1);                                  // checked a few minutes ago
});

test("vision agent: manual check only when parked or stopped; a poor scan asks to retry; camera denied degrades", async () => {
    let next = { ok: true, result: F.analyzeSession(face({ seconds: 2 })) };
    const e = setup({ scanResult: () => next });
    assert.equal((await e.brain.delegate("fatigue-check")).result.ok, true);   // parked: allowed
    assert.ok(e.reports.includes("fatigue.retry:advice"));
    e.startRide(); e.ride(20, 12);
    assert.deepEqual((await e.brain.delegate("fatigue-check")).result, { ok: false, reason: "moving" });
    e.ride(20, 0);
    next = { ok: false, reason: "camera-denied" };
    await e.brain.delegate("fatigue-check");
    assert.equal(e.kernel.get("vision").state, "degraded");
    assert.ok(e.reports.includes("vision.unavailable:advice"));
});

// ---------------------------------------------------------------- face-scan provider (fake DOM, fake camera, fake model)
function fakeDom() {
    const nodes = [];
    const mk = (tag) => {
        const n = { tag, children: [], attrs: {}, listeners: {}, className: "", textContent: "", style: {}, classList: { set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); } },
            setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); c.parent = this; return c; },
            addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }, click() { for (const fn of this.listeners.click || []) fn(); },
            remove() { this.removed = true; }, readyState: 4, play: async () => {}, srcObject: null };
        nodes.push(n);
        return n;
    };
    return { nodes, document: { createElement: mk, createElementNS: (_ns, tag) => mk(tag), body: mk("body") } };
}

test("face-scan: live check with a fake camera and model; stops the camera; aborts when moving", async () => {
    const dom = fakeDom();
    let tracksStopped = 0, closed = 0, t = 0, moving = false;
    const W = {
        document: dom.document, performance: { now: () => t },
        navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => tracksStopped++ }] }) } }
    };
    const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
    const provider = FS.createFaceScanProvider(W, {
        fatigue: F,
        loadLandmarker: async () => ({ detectVideo: () => ({ faceLandmarks: [lm], faceBlendshapes: [{ categories: [{ categoryName: "eyeBlinkLeft", score: 0.05 }, { categoryName: "eyeBlinkRight", score: 0.05 }, { categoryName: "jawOpen", score: 0.05 }] }] }), close: () => closed++ }),
        now: () => (t += 40), fps: 25
    });
    assert.equal(provider.available(), true);
    const out = await provider.scan({ durationMs: 2000, ridingSec: 5400, guard: () => null });
    assert.equal(out.ok, true);
    assert.equal(out.result.mode, "video");
    assert.ok(out.result.metrics.frames >= 40);
    assert.equal(tracksStopped, 1); assert.equal(closed, 1);
    assert.equal(provider.busy(), false);
    const aborted = provider.scan({ durationMs: 5000, guard: () => (moving ? "moving" : null) });
    setTimeout(() => { moving = true; }, 20);
    assert.deepEqual(await aborted, { ok: false, reason: "moving" });
    assert.equal(tracksStopped, 2);
    assert.deepEqual(await provider.scan({ guard: () => "moving" }), { ok: false, reason: "moving" });   // never opens the camera
    assert.equal(tracksStopped, 2);
    const denied = FS.createFaceScanProvider({ ...W, navigator: { mediaDevices: { getUserMedia: async () => { throw Object.assign(new Error("no"), { name: "NotAllowedError" }); } } } }, { fatigue: F, loadLandmarker: async () => ({ close() {} }) });
    assert.deepEqual(await denied.scan({ guard: () => null }), { ok: false, reason: "camera-denied" });
    const noModel = FS.createFaceScanProvider(W, { fatigue: F, loadLandmarker: async () => { throw new Error("offline"); } });
    assert.deepEqual(await noModel.scan({ guard: () => null }), { ok: false, reason: "model" });
});
