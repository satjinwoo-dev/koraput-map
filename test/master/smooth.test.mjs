// RoadSense Live: "ridden, nothing found" (smooth passes) and the feeds groundwork (official lists, model predictions):
// the coverage store, the dynamics agent recording passes, the Truth Card and voice saying "clear", the server's
// unlinkable per-cell labels, and feed ingestion
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const RS = require("../../public/js/master/roadsense/roadsense.js");
const TR = require("../../public/js/master/roadsense/truth.js");
const SY = require("../../public/js/master/roadsense/sync.js");
const CARD = require("../../public/js/master/roadsense/truth-card.js");
const DY = require("../../public/js/master/perception/dynamics.js");
const DYN = require("../../public/js/master/agents/dynamics-agent.js");
const P = require("../../public/js/master/persona.js");
const PH = require("../../public/js/master/phrases-desi.js");
const B = require("../../public/js/master/bus.js");
const C = require("../../public/js/master/contracts.js");
const K = require("../../public/js/master/kernel.js");
const CAPS = require("../../public/js/master/capabilities.js");
const RIDE = require("../../public/js/master/agents/ride-agent.js");
const { openServerDatabase } = require("../../lib/server-db.js");
const { createRoadsense } = require("../../lib/master/roadsense.js");
const FEEDS = require("../../lib/master/roadsense-feeds.js");
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const T0 = Date.UTC(2026, 9, 16, 6, 0, 0), MIN = 60000, H = 3600000, D = 24 * H;
const LAT = 18.81, LNG = 82.71;
const M_LNG = 1 / (111320 * Math.cos(LAT * Math.PI / 180));
const at = (east) => ({ lat: LAT, lng: LNG + east * M_LNG });
const ROUTE = [[LAT, LNG], [LAT, LNG + 5000 * M_LNG]];
/** smooth passes by these riders over every cell of the first `m` metres of ROUTE */
function ride(cover, rider, t, fromM = 0, toM = 5000) {
    for (let e = fromM; e <= toM; e += 50) cover.add({ ...at(e), t, rider });
}

test("coverage: the latest smooth pass per rider and cell, fresh for a week, saved compactly; bad input refused", () => {
    const m = new Map();
    const store = { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)) };
    const cv = RS.createCoverage({ store });
    const cell = cv.add({ ...at(50), t: T0, rider: "self" });
    assert.match(cell, /^\d+:\d+$/);
    assert.equal(cv.add({ ...at(80), t: T0 + MIN, rider: "self" }), cell, "30 m on: the same ≈ 220 m cell");
    cv.add({ cell, t: T0 + 2 * MIN, rider: "cabc" });
    assert.deepEqual(cv.at(cell, T0 + 3 * MIN), { riders: 2, last: T0 + 2 * MIN, self: true });
    assert.equal(cv.at(cell, T0 + 8 * D).riders, 0, "older than a week says nothing");
    for (let i = 0; i < 6; i++) cv.add({ cell, t: T0 + (3 + i) * MIN, rider: `r${i}` });
    assert.equal(cv.at(cell, T0 + H).riders, 4, "the newest 4 riders per cell");
    for (const bad of [{ cell: "x", t: T0, rider: "a" }, { lat: NaN, lng: 1, t: T0, rider: "a" }, { cell, t: -1, rider: "a" }, { cell, t: T0, rider: "" }]) assert.equal(cv.add(bad), null);
    assert.equal(cv.save(), true);
    const again = RS.createCoverage({ store });
    assert.equal(again.load(), 1);
    assert.deepEqual(again.at(cell, T0 + H), cv.at(cell, T0 + H));
    assert.equal(again.prune(T0 + 8 * D), 1);
    assert.equal(again.size(), 0);
});

// ---------------------------------------------------------------- the dynamics agent records smooth passes
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
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/** 2 km east at 10 m/s, DynamicsFrames 1 Hz with smooth 20 m segments; a jolt at `joltAt` metres and a slow crawl from `slowFrom` */
function frames({ joltAt = null, slowFrom = Infinity } = {}) {
    const out = [];
    for (let i = 0; i <= 200; i++) {
        const x = i * 10, slow = x >= slowFrom && x < slowFrom + 100;
        const t = T0 + i * 1000;
        const p = at(x);
        out.push({
            v: 1, kind: "dynamics", t, seq: i, ego: { speedMs: slow ? 1 : 10, speedSigma: 0.4, headingDeg: 90, ...p, posSigmaM: 4 },
            longMs2: 0, longMinMs2: -0.2, longMaxMs2: 0.2, vertRmsMs2: 0.4, braking: false, imuHz: 100,
            events: joltAt !== null && Math.abs(x - joltAt) < 5 ? [{ id: `j${i}`, type: "jolt", t, durS: 0.1, peakMs2: 14, speedFromMs: 10, speedToMs: 10, dvImuMs: 0, ...p, headingDeg: 90, conf: 0.7, source: "imu+gnss" }] : [],
            segments: [{ t, distM: 10, rmsMs2: 0.4, refRmsMs2: 0.4, cls: "smooth", speedMs: 10, ...p, headingDeg: 90 }]
        });
    }
    return out;
}
async function rideAgent(list) {
    const clock = fakeClock(list[0].t - 500);
    const bus = B.createBus({ now: clock.now, timers: clock.timers });
    const caps = CAPS.createCapabilities();
    const m = new Map();
    caps.provide("store", CAPS.createStoreProvider({ localStorage: { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } } }));
    const drives = emitter();
    let drive = { driving: false, navigating: false };
    const cover = RS.createCoverage();
    caps.provide("roadsense", RS.createLog());
    caps.provide("roadsense-cover", cover);
    caps.provide("location", { available: () => true, current: () => null, onFix: emitter().on });
    caps.provide("drive", { available: () => true, current: () => drive, onChange: drives.on });
    caps.provide("dynamics", DY.createDynamicsProvider({ replay: list, timers: clock.timers }));
    const kernel = K.createKernel({ bus, caps, contracts: C, now: clock.now, timers: clock.timers, log: { info() {}, warn() {}, error() {} } });
    kernel.define(RIDE); kernel.define(DYN); kernel.start();
    drive = { driving: true, navigating: false }; drives.emit(drive);
    await tick();
    clock.advance(list[list.length - 1].t - list[0].t + 2000);
    return { cover, state: bus.last("state.dynamics") };
}

test("dynamics agent: every cell ridden at speed with nothing felt is a smooth pass; a jolt, or crawling, spoils that cell only", async () => {
    const cellAt = (cv, x) => cv.cellOf(at(x).lat, at(x).lng);
    const clean = await rideAgent(frames());
    const cells = new Set(Array.from({ length: 41 }, (_, k) => cellAt(clean.cover, k * 50)));
    const smooth = [...cells].filter((c) => clean.cover.at(c, T0 + H).self);
    assert.ok(smooth.length >= cells.size - 1, `${smooth.length} of ${cells.size} cells (the last one is never left, so never settled)`);
    assert.equal(clean.state.smoothCells, smooth.length);
    // a jolt at 700 m: its cell isn't smooth; the others still are
    const bumpy = await rideAgent(frames({ joltAt: 700 }));
    assert.equal(bumpy.cover.at(cellAt(bumpy.cover, 700), T0 + H).self, false);
    assert.equal(bumpy.cover.at(cellAt(bumpy.cover, 1200), T0 + H).self, true);
    // crawling at 1 m/s through 1400–1500 m: the IMU couldn't have felt a bump there
    const slow = await rideAgent(frames({ slowFrom: 1400 }));
    assert.equal(slow.cover.at(cellAt(slow.cover, 1450), T0 + H).self, false);
    assert.equal(slow.cover.at(cellAt(slow.cover, 200), T0 + H).self, true);
});

// ---------------------------------------------------------------- the card and the voice
test("Truth Card: 2+ riders with smooth passes → 'Clear · no bumps felt by N riders' (a sensor signal); one → 'ridden once'; reports still win", () => {
    const now = T0 + 3 * H;
    const log = RS.createLog();
    const cover = RS.createCoverage();
    ride(cover, "self", T0);
    ride(cover, "c1111111111111111", T0 + H);
    ride(cover, "c2222222222222222", T0 + 2 * H, 0, 3000);
    const card = TR.buildTruth({ log, cover, path: ROUTE, now });
    assert.equal(card.unknown, false);
    assert.equal(card.coverage.clearM, 5000);
    assert.equal(card.coverage.clearRiders, 2, "the weakest stretch: 2 riders over the last 2 km");
    assert.equal(card.coverage.clearLastSeen, T0 + H);
    assert.equal(TR.phraseKind(card), "road.truth-clear");
    const desi = PH.install(P.createPersona({ style: "desi", name: "Asha", rng: () => 0 }));
    const plain = PH.install(P.createPersona({ style: "plain", rng: () => 0 }));
    const say = (p, kind, c, scope = "route") => p.phrase({ kind, key: kind, severity: "advice", data: TR.phraseData(c, scope) });
    const a = say(desi, "road.truth-clear", card);
    assert.equal(a.text, "Asha, is raaste saaf hai: 2 riders ne koi jhatka feel nahi kiya, aakhri baar 2 ghante pehle. Par phone paani ya bajri feel nahi kar sakta, dhyan rakhna.");
    assert.equal(a.display.title, "Clear · no bumps felt by 2 riders");
    assert.equal(a.display.sub, "Phone sensors · last 2 hours ago");
    assert.equal(say(plain, "road.truth-clear", card).text, "This route is clear: no bumps felt by 2 riders, last 2 hours ago. A phone can't feel water or gravel, so stay alert.");
    const vm = CARD.viewModel({ hasRoute: true, card, sources: { community: true, lastFetch: now - MIN } }, now);
    assert.deepEqual(vm.pill, { text: "Clear · no bumps felt by 2 riders", tone: "clear" });
    assert.equal(vm.summary, "No bumps or rough road felt on this route by 2 riders' phone sensors, last 2 h ago.");
    assert.deepEqual(vm.bar, [{ state: "clear", pct: 100 }]);
    assert.equal(vm.coverage, "5.0 km clear");
    assert.match(vm.feel, /can't feel water, gravel or animals/);
    assert.equal(vm.note, "", "nothing unknown on it");
    assert.doesNotMatch(CARD.viewModel({ hasRoute: true, card, sources: { community: false } }, now).source, /own sensors only/, "'clear' needs other riders: never 'own sensors only'");
    // one rider only: not "clear"
    const once = RS.createCoverage(); ride(once, "c1111111111111111", T0);
    const c1 = TR.buildTruth({ log, cover: once, path: ROUTE, now });
    assert.equal(TR.phraseKind(c1), "road.truth-ridden");
    assert.match(say(desi, "road.truth-ridden", c1).text, /sirf ek rider guzra hai, 3 ghante pehle, aur koi jhatka nahi laga\. Abhi pakka nahi/);
    assert.equal(CARD.viewModel({ hasRoute: true, card: c1, sources: {} }, now).pill.text, "Ridden once, nothing felt");
    // part clear, part unknown
    const part = RS.createCoverage(); ride(part, "self", T0, 0, 2000); ride(part, "c1111111111111111", T0, 0, 2000);
    const c2 = TR.buildTruth({ log, cover: part, path: ROUTE, now });
    assert.equal(TR.phraseKind(c2), "road.truth-partly-clear");
    assert.match(say(plain, "road.truth-partly-clear", c2).text, /^2(\.\d)? kilometres of this route is clear: no bumps felt by 2 riders, last 3 hours ago\. The rest: condition unknown\.$/);
    const v2 = CARD.viewModel({ hasRoute: true, card: c2, sources: {} }, now);
    assert.deepEqual(v2.bar.map((b) => b.state), ["clear", "unknown"]);
    assert.equal(v2.note, "No report doesn't mean the road is clear.");
    // a report on a ridden road: the report leads, the clear part follows as an extra sentence
    const withBump = RS.createLog();
    withBump.addAll([{ type: "bump", t: T0, ...at(4000), source: "imu", rider: "c1111111111111111", present: true, conf: 0.7 }, { type: "bump", t: T0 + MIN, ...at(4000), source: "imu", rider: "c2222222222222222", present: true, conf: 0.7 }]);
    const c3 = TR.buildTruth({ log: withBump, cover, path: ROUTE, now });
    assert.equal(TR.phraseKind(c3), "road.truth");
    assert.deepEqual(TR.phraseExtras(c3), ["road.truth-also-clear"]);
    assert.deepEqual(c3.stretches.map((s) => s.state), ["clear", "hazard", "clear"]);
    // stale passes (8 days) say nothing: back to unknown
    assert.equal(TR.phraseKind(TR.buildTruth({ log, cover, path: ROUTE, now: T0 + 8 * D })), "road.truth-unknown");
});

// ---------------------------------------------------------------- server + phones
function world() {
    let t = T0;
    const { db } = openServerDatabase(":memory:");
    const server = createRoadsense({ db: () => db, secret: () => "server-secret", now: () => t });
    function phone(name, ip = `10.0.0.${name.charCodeAt(0)}`) {
        const api = {
            async post(p, body) {
                const fn = { "/roadsense/upload": server.upload, "/roadsense/area": server.area, "/roadsense/forget": server.forget, "/roadsense/cover": server.cover }[p];
                const r = await fn(JSON.parse(JSON.stringify(body)), { ip });
                return { ok: r.status === 200 && r.json.ok !== false, status: r.status, data: JSON.parse(JSON.stringify(r.json)), reason: r.json.reason };
            }
        };
        const log = RS.createLog(), cover = RS.createCoverage();
        const sync = SY.createSync({ RS, log, cover, store: (() => { const m = new Map(); return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)) }; })(), api, now: () => t });
        sync.setConsent(true);
        sync.approveCover(T0 - D, T0 + D);         // the rider approved these rides' smooth passes in their review
        return { log, cover, sync };
    }
    return { db, server, phone, at: (v) => { t = v; } };
}
const tile = RS.tileOf(LAT, LNG);

test("smooth passes through the server: unlinkable per-cell labels, recognised as one's own on the way back, two riders make it clear", async () => {
    const w = world();
    const [a, b, c] = ["A", "B", "C"].map((n) => w.phone(n));
    ride(a.cover, "self", T0, 1000, 3000);
    ride(b.cover, "self", T0 + 5 * MIN, 1000, 3000);
    w.at(T0 + 20 * MIN);
    await a.sync.flush(); await b.sync.flush();
    const n = new Set(Array.from({ length: 41 }, (_, k) => a.cover.cellOf(at(1000 + k * 50).lat, at(1000 + k * 50).lng))).size;
    assert.equal(a.sync.status().coverUploaded, n, `the ${n} cells over 2 km`);
    const rows = w.db.prepare("SELECT cell, label, t FROM roadsense_cover").all();
    assert.equal(rows.length, 2 * n);
    assert.equal(new Set(rows.map((r) => r.label)).size, 2 * n, "every (rider, cell) has its own label: no route can be joined from them");
    assert.ok(rows.every((r) => r.t % H === 0), "the hour only");
    // C has never ridden it: downloads A's and B's passes → clear
    await c.sync.fetchTiles([tile]);
    const card = TR.buildTruth({ log: c.log, cover: c.cover, path: ROUTE, now: T0 + 30 * MIN });
    assert.equal(card.coverage.clearM >= 1900, true, `${card.coverage.clearM} m clear`);
    assert.equal(card.coverage.clearRiders, 2);
    // A gets its own passes back: recognised, not counted as another rider
    await a.sync.fetchTiles([tile]);
    const mine = a.cover.at(a.cover.cellOf(at(2000).lat, at(2000).lng), T0 + 30 * MIN);
    assert.deepEqual([mine.riders, mine.self], [2, true], "self + B, not self + self");
    // one network address counts once per cell per day (CGNAT undercounts: the safe direction)
    const twin = w.phone("A2", "10.0.0.65");                      // the same address as A
    ride(twin.cover, "self", T0 + 6 * MIN, 1000, 3000);
    w.at(T0 + 40 * MIN);
    await twin.sync.flush();
    assert.equal(w.server.stats().coverRepeat, n);
    // delete: A's labels go, B's stay
    const r = await a.sync.forgetAll();
    assert.equal(r.ok, true);
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM roadsense_cover").get().n, n);
});

// ---------------------------------------------------------------- feeds: official lists and predictions
test("feeds: official items need a source and an end date; GeoJSON lines are sampled; predictions stay off without real thresholds", () => {
    const ok = { id: "morth:42", type: "roadworks", source: "official", ref: "Example roadworks list", t: "2026-10-01T00:00:00Z", validUntil: "2026-11-01T00:00:00Z", ...at(1000) };
    assert.equal(FEEDS.validateFeedItem(ok).ok, true);
    assert.equal(FEEDS.validateFeedItem(ok).item.conf, RS.SOURCES.official.defaultConf);
    for (const [patch, why] of [[{ ref: "" }, /ref/], [{ validUntil: undefined }, /validUntil/], [{ validUntil: "2026-09-01T00:00:00Z" }, /after t/], [{ source: "imu" }, /source/],
        [{ source: "prediction" }, /own conf/], [{ url: "http://x.example" }, /https/], [{ type: "unicorn" }, /type/]]) {
        const v = FEEDS.validateFeedItem({ ...ok, ...patch });
        assert.equal(v.ok, false, JSON.stringify(patch));
        assert.match(v.error, why);
    }
    const fc = { type: "FeatureCollection", features: [
        { type: "Feature", geometry: { type: "LineString", coordinates: [[LNG, LAT], [LNG + 450 * M_LNG, LAT]] }, properties: { id: "w1", type: "roadworks", source: "official", ref: "Example list", published: "2026-10-01T00:00:00Z", valid_until: "2026-11-01T00:00:00Z" } },
        { type: "Feature", geometry: { type: "Polygon", coordinates: [] }, properties: {} }
    ] };
    const g = FEEDS.fromGeoJSON(fc);
    assert.deepEqual(g.items.map((i) => i.id), ["w1#0", "w1#1", "w1#2", "w1#3", "w1#4", "w1#5"], "every 100 m along 450 m");
    assert.equal(g.errors.length, 1);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-feeds-"));
    fs.writeFileSync(path.join(dir, "list.geojson"), JSON.stringify(fc));
    assert.equal(FEEDS.loadFeedDir(dir).items.length, 6);
    assert.deepEqual(FEEDS.loadFeedDir(path.join(dir, "missing")), { items: [], errors: [], files: 0 });
    // the predictor: off unless every threshold is given with its source
    assert.equal(FEEDS.createWaterloggingPredictor().enabled, false);
    assert.equal(FEEDS.createWaterloggingPredictor({ rule: { minRainMmPerHour: 1, maxReliefM: 1, conf: 0.5 } }).enabled, false, "no ref: off");
    const pr = FEEDS.createWaterloggingPredictor({ rule: { minRainMmPerHour: 1, maxReliefM: 1, conf: 0.5, ref: "test rule (not calibrated)" } });   // test values only
    const items = pr.predict({ cells: [{ ...at(500), reliefM: 0.5 }, { ...at(900), reliefM: 3 }], nowcast: { mmPerHour: 2, t: T0, validUntil: T0 + 2 * H } });
    assert.deepEqual(items.map((i) => [i.type, i.source, i.conf]), [["waterlogging", "prediction", 0.5]]);
    assert.deepEqual(pr.predict({ cells: [{ ...at(500), reliefM: 0.5 }], nowcast: { mmPerHour: 0.5, t: T0, validUntil: T0 + H } }), [], "light rain: nothing");
});

test("feeds end to end: an official item verifies by name until its date; a prediction is shown and said apart, never as evidence", async () => {
    const w = world();
    const off = FEEDS.validateFeedItem({ id: "list:7", type: "roadworks", source: "official", ref: "Example roadworks list", t: T0 - D, validUntil: T0 + 10 * D, ...at(2400) }).item;
    const pred = FEEDS.createWaterloggingPredictor({ rule: { minRainMmPerHour: 1, maxReliefM: 1, conf: 0.6, ref: "IMD nowcast + Bhuvan DEM (test rule)" } })
        .predict({ cells: [{ ...at(1800), reliefM: 0.4 }], nowcast: { mmPerHour: 3, t: T0, validUntil: T0 + 3 * H } });
    assert.equal(w.server.ingest([off, ...pred]), 2);
    const phone = w.phone("B");
    w.at(T0 + H);
    await phone.sync.fetchTiles([tile]);
    const card = TR.buildTruth({ log: phone.log, path: ROUTE, now: T0 + H });
    const [p, o] = card.rows;
    assert.deepEqual([p.type, p.status, p.riders], ["waterlogging", "predicted", 0]);
    assert.deepEqual([o.type, o.status, o.refs], ["roadworks", "verified", ["Example roadworks list"]]);
    assert.equal(card.verified, 1);
    assert.equal(card.predicted, 1);
    assert.equal(card.candidates, 0, "a prediction is never a candidate either");
    assert.equal(o.screen.startsWith("Official: Example roadworks list"), true);
    assert.match(p.screen, /^AI prediction · IMD nowcast \+ Bhuvan DEM \(test rule\) · not seen by anyone$/);
    const vm = CARD.viewModel({ hasRoute: true, card, sources: { community: true, lastFetch: T0 + H } }, T0 + H);
    assert.deepEqual(vm.rows.map((r) => r.badge), ["Predicted", "Official"]);
    // the voice: the official item by name, the prediction last and labelled
    const desi = PH.install(P.createPersona({ style: "desi", name: "Asha", rng: () => 0 }));
    const data = TR.phraseData(card, "route");
    assert.deepEqual(TR.phraseExtras(card), ["road.truth-rest-unknown", "road.truth-official", "road.truth-predicted"]);
    const lines = [TR.phraseKind(card), ...TR.phraseExtras(card)].map((k) => desi.phrase({ kind: k, key: k, severity: "advice", data }).text);
    assert.match(lines[2], /^Sarkari jaankari: 2\.4 km aage sadak ka kaam, Example roadworks list ke mutaabik\.$/);
    assert.match(lines[3], /^Ek anumaan bhi hai: 1\.8 km aage paani bhara hua ka khatra, IMD nowcast \+ Bhuvan DEM \(test rule\) se\. Kisi ne dekha nahi, pakka nahi\.$/);
    // after their dates, both are gone
    const later = TR.buildTruth({ log: phone.log, path: ROUTE, now: T0 + 11 * D });
    assert.equal(later.rows.length, 0);
    // a phone can never upload official or prediction items
    const up = await w.server.upload({ v: 1, rider: "pseudonym-aaaaaaaaaaaaaaaa", obs: [{ id: "fake000001", type: "roadworks", source: "official", ref: "x", t: T0, ...at(10), present: true }, { id: "fake000002", type: "waterlogging", source: "prediction", ref: "x", conf: 0.9, t: T0, ...at(10), present: true }] });
    assert.equal(up.json.accepted, 0);
});

test("wiring: the coverage capability, the cover route, feeds loaded by server.js, docs", () => {
    const app = read("public/js/master/master-app.js");
    assert.match(app, /caps\.provide\("roadsense-cover", cover\)/);
    assert.match(app, /cover: caps\.get\("roadsense-cover"\)/);
    assert.match(read("lib/master/http-api.js"), /post\("\/roadsense\/cover", 30, "64kb", o\.roadsense\.cover\)/);
    const server = read("server.js");
    assert.match(server, /loadRoadsenseFeeds\(process\.env\.ROADSENSE_FEEDS_DIR \|\| path\.join\(__dirname, "data", "roadsense", "feeds"\)\)/);
    assert.ok(fs.existsSync(new URL("../../data/roadsense/feeds/README.md", import.meta.url)));
    assert.ok(JSON.parse(read("tsconfig.master-server.json")).files.includes("lib/master/roadsense-feeds.js"));
});
