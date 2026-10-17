// RoadSense Live step 3: opt-in sync (public/js/master/roadsense/sync.js) against the real server handlers
// (lib/master/roadsense.js on in-memory SQLite), several phones, offline, privacy, and the agent that drives it
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const RS = require("../../public/js/master/roadsense/roadsense.js");
const SY = require("../../public/js/master/roadsense/sync.js");
const AGENT = require("../../public/js/master/agents/roadsense-agent.js");
const { openServerDatabase } = require("../../lib/server-db.js");
const { createRoadsense } = require("../../lib/master/roadsense.js");
const B = require("../../public/js/master/bus.js");
const C = require("../../public/js/master/contracts.js");
const K = require("../../public/js/master/kernel.js");
const CAPS = require("../../public/js/master/capabilities.js");
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const T0 = Date.UTC(2026, 9, 15, 6, 0, 0), MIN = 60000, H = 3600000, D = 24 * H;
const LAT = 18.81, LNG = 82.71;
const M_LNG = 1 / (111320 * Math.cos(LAT * Math.PI / 180)), M_LAT = 1 / 111320;
const memStore = () => { const m = new Map(); return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)), raw: m }; };

/** One server, one clock, any number of phones talking to it in-process (JSON round-trips, like the wire). */
function world() {
    let t = T0;
    const { db } = openServerDatabase(":memory:");
    const server = createRoadsense({ db: () => db, secret: () => "server-secret", now: () => t });
    const calls = [];
    function phone(name) {
        let online = true;
        const api = {
            async post(path, body) {
                calls.push({ phone: name, path, body: JSON.parse(JSON.stringify(body)) });
                if (!online) return { ok: false, status: 0, data: null, reason: "offline" };
                const fn = { "/roadsense/upload": server.upload, "/roadsense/area": server.area, "/roadsense/forget": server.forget }[path];
                const r = await fn(JSON.parse(JSON.stringify(body)));
                return { ok: r.status === 200 && r.json.ok !== false, status: r.status, data: JSON.parse(JSON.stringify(r.json)), reason: r.json.reason };
            }
        };
        const logStore = memStore(), syncStore = memStore();
        const log = RS.createLog({ store: logStore });
        const sync = SY.createSync({ RS, log, store: syncStore, api, now: () => t });
        /** this phone feels something `east` metres along the road */
        const feel = (o = {}) => log.add({ type: "bump", t, lat: LAT, lng: LNG + (o.east || 0) * M_LNG, source: "imu", rider: "self", present: true, conf: 0.7, peakMs2: 14, ...o });
        return { name, log, sync, api, logStore, syncStore, feel, offline: (v = true) => { online = !v; } };
    }
    return { db, server, phone, calls, at: (v) => { t = v; }, now: () => t };
}
const tile = RS.tileOf(LAT, LNG);
const truth = (p, now, east = 0) => p.log.truthAt({ lat: LAT, lng: LNG + east * M_LNG, now });

test("off by default: nothing is queued, sent or fetched until the rider turns it on", async () => {
    const w = world();
    const a = w.phone("A");
    assert.equal(a.sync.consent(), false);
    a.feel();
    w.at(T0 + H);
    assert.equal(await a.sync.flush(), 0);
    assert.deepEqual(await a.sync.fetchTiles([tile]), { fetched: 0, added: 0, skipped: 0 });
    assert.equal(w.calls.length, 0, "not one request");
    assert.equal(a.sync.status().queued, 0, "turning it on later doesn't send the past");
});

test("share: only this phone's own, only once 10 minutes old, rounded, under a daily pseudonym; private zones never leave the phone", async () => {
    const w = world();
    const a = w.phone("A");
    a.sync.setConsent(true);
    a.sync.markPrivate(LAT, LNG + 2000 * M_LNG);                       // home: where the ride started
    a.feel(); w.at(T0 + 5 * MIN); a.feel();                            // a pothole, 2 passes
    a.feel({ east: 2100 });                                            // a speed breaker outside home
    a.log.add({ type: "bump", t: T0, lat: LAT, lng: LNG, source: "imu", rider: "r0123456789abcde", present: true, conf: 0.7 });   // another rider's: never re-shared
    assert.equal(a.sync.status().queued, 3);
    w.at(T0 + 8 * MIN);
    assert.equal(await a.sync.flush(), 0, "the newest is under 10 minutes old");
    assert.equal(w.calls.length, 0);
    w.at(T0 + 16 * MIN);
    assert.equal(await a.sync.flush(), 2);
    const st = a.sync.status();
    assert.equal(st.privateDropped, 1);
    assert.equal(st.queued, 0);
    const sent = w.calls[0].body;
    assert.equal(sent.obs.length, 2);
    assert.match(sent.rider, /^[A-Za-z0-9_-]{16,64}$/);
    assert.ok(sent.obs.every((o) => o.t % 10000 === 0 && Math.abs(o.lng - Math.round(o.lng * 1e5) / 1e5) < 1e-12 && !("rider" in o)));
    // the next day is a new pseudonym; the server never sees either, only their labels
    w.at(T0 + D); a.feel({ east: 50 }); w.at(T0 + D + 11 * MIN);
    await a.sync.flush();
    assert.notEqual(w.calls.at(-1).body.rider, sent.rider);
    const labels = w.db.prepare("SELECT DISTINCT rider FROM roadsense_obs").all().map((r) => r.rider);
    assert.equal(labels.length, 2);
    assert.ok(!labels.includes(sent.rider));
    // turning it off empties the queue
    a.feel({ east: 80 });
    assert.equal(a.sync.status().queued, 1);
    a.sync.setConsent(false);
    assert.equal(a.sync.status().queued, 0);
});

test("receive: other riders' evidence along the route lands in the log; two riders verify; one alone stays a candidate", async () => {
    const w = world();
    const [a, b, c] = ["A", "B", "C"].map((n) => w.phone(n));
    for (const p of [a, b, c]) p.sync.setConsent(true);
    a.feel(); w.at(T0 + 5 * MIN); a.feel();                            // A: 2 passes (verified on A's phone)
    w.at(T0 + 20 * MIN);
    await a.sync.flush();
    // B has a route through here and has never ridden it
    const route = [[LAT, LNG - 20000 * M_LNG], [LAT, LNG + 20000 * M_LNG]];
    const tiles = b.sync.tilesAlong(route);
    assert.ok(tiles.includes(tile) && tiles.length >= 9 && tiles.length <= 40, `${tiles.length} tiles`);
    const got = await b.sync.fetchTiles(tiles);
    assert.equal(got.added, 2);
    let tb = truth(b, T0 + 21 * MIN);
    assert.equal(tb.status, "candidate", "one other rider, however many passes, can't verify alone");
    assert.equal(tb.events[0].riders, 1);
    w.at(T0 + 30 * MIN);
    assert.deepEqual(await b.sync.fetchTiles(tiles), { fetched: 0, added: 0, skipped: tiles.length }, "fetched 10 min ago: still fresh");
    // C rides over it too and shares
    w.at(T0 + 30 * MIN); c.feel({ east: 3 });
    w.at(T0 + 45 * MIN); await c.sync.flush();
    w.at(T0 + 61 * MIN);
    assert.equal((await b.sync.fetchTiles([tile])).added, 1);
    tb = truth(b, T0 + 61 * MIN);
    assert.equal(tb.status, "verified");
    assert.equal(tb.events[0].riders, 2);
    // A gets its own back: duplicates, not "another rider"
    const back = await a.sync.fetchTiles([tile]);
    assert.equal(back.added, 1, "only C's");
    const ta = truth(a, T0 + 61 * MIN).events[0];
    assert.equal(ta.riders, 2);
    assert.deepEqual(ta.sources, { imu: 3 });
});

test("offline cache: what was fetched with signal warns in a dead zone, and survives the app restarting there", async () => {
    const w = world();
    const [a, c, b] = ["A", "C", "B"].map((n) => w.phone(n));
    for (const p of [a, b, c]) p.sync.setConsent(true);
    a.feel({ east: 5000 }); c.feel({ east: 5003 });
    w.at(T0 + 11 * MIN); await a.sync.flush(); await c.sync.flush();
    await b.sync.fetchTiles(b.sync.tilesAlong([[LAT, LNG], [LAT, LNG + 8000 * M_LNG]]));
    // into the ghats: no signal
    b.offline();
    w.at(T0 + 2 * H);
    assert.equal(truth(b, T0 + 2 * H, 5000).status, "verified");
    assert.deepEqual(await b.sync.fetchTiles([RS.tileOf(LAT, LNG + 5000 * M_LNG)]), { fetched: 0, added: 0, skipped: 0 });
    assert.ok(b.sync.status().backoffUntil > w.now(), "backs off instead of retrying every second");
    // the phone restarts in the dead zone: the log comes back from the phone's storage
    const again = RS.createLog({ store: b.logStore });
    assert.ok(again.load() >= 1);
    assert.equal(again.truthAt({ lat: LAT, lng: LNG + 5000 * M_LNG, now: T0 + 2 * H }).status, "verified");
    // an upload that fails stays queued for later
    b.feel({ east: 9000 });
    w.at(T0 + 3 * H);
    assert.equal(await b.sync.flush(), 0);
    assert.equal(b.sync.status().queued, 1);
    b.offline(false);
    w.at(T0 + 4 * H);
    assert.equal(await b.sync.flush(), 1);
});

test("abuse: one uploader can neither verify a fake pothole nor clear a real one on other phones", async () => {
    const w = world();
    const [x, b] = ["X", "B"].map((n) => w.phone(n));
    for (const p of [x, b]) p.sync.setConsent(true);
    // B felt a real pothole twice
    b.feel({ east: 300 }); w.at(T0 + 5 * MIN); b.feel({ east: 300 });
    w.at(T0 + 16 * MIN);
    assert.equal(await b.sync.flush(), 2, "B shares it");
    // X doesn't use the app: it posts straight to the server, a fake pothole 5 times and "B's is gone" 4 times
    w.at(T0 + 40 * MIN);
    const forged = [];
    for (let i = 0; i < 5; i++) forged.push({ id: `forged-yes-${i}`, type: "bump", t: T0 + 10 * MIN + i * 2 * MIN, lat: LAT, lng: LNG, source: "imu", present: true, conf: 1, peakMs2: 20 });
    for (let i = 0; i < 4; i++) forged.push({ id: `forged-gone-${i}`, type: "bump", t: T0 + 20 * MIN + i * 2 * MIN, lat: LAT, lng: LNG + 300 * M_LNG, source: "imu", present: false, conf: 1 });
    assert.equal((await x.api.post("/roadsense/upload", { v: 1, rider: "attacker-xxxxxxxxxxxxxxx", obs: forged })).data.accepted, 9);
    await b.sync.fetchTiles([tile]);
    const now = T0 + 41 * MIN;
    assert.equal(truth(b, now).status, "candidate", "the fake one");
    const real = truth(b, now, 300);
    assert.equal(real.status, "verified", "the real one");
    assert.equal(real.events[0].absentPasses, 1, "X's clean passes count once");
});

test("delete my road reports: the server forgets everything this phone sent, other riders' stay", async () => {
    const w = world();
    const [a, c] = ["A", "C"].map((n) => w.phone(n));
    for (const p of [a, c]) p.sync.setConsent(true);
    a.feel(); c.feel({ east: 400 });
    w.at(T0 + D); a.feel({ east: 100 });
    w.at(T0 + D + 11 * MIN); await a.sync.flush(); await c.sync.flush();
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM roadsense_obs").get().n, 3);
    const r = await a.sync.forgetAll();
    assert.deepEqual(r, { ok: true, deleted: 2 });
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM roadsense_obs").get().n, 1);
    assert.equal(a.sync.status().pseudonyms, 0);
});

// ---------------------------------------------------------------- the agent
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
    return { now: () => t, timers, advance, set: (v) => { t = v; } };
}
const flushAsync = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
function emitter() { const fns = new Set(); return { on(fn) { fns.add(fn); return () => fns.delete(fn); }, emit(v) { for (const fn of fns) fn(v); } }; }

test("agent: fetches the route's tiles when a route is set, marks where rides start and end private, uploads every minute", async () => {
    const w = world();
    const clock = fakeClock(T0);
    const p = w.phone("A");
    const other = w.phone("C");
    other.sync.setConsent(true); other.feel({ east: 1500 }); w.at(T0 + 11 * MIN); await other.sync.flush(); w.at(T0);
    p.sync.setConsent(true);
    const bus = B.createBus({ now: clock.now, timers: clock.timers });
    const caps = CAPS.createCapabilities();
    const routes = emitter(), fixes = emitter();
    let here = { lat: LAT, lng: LNG, speedMs: 0 };
    caps.provide("roadsense-sync", p.sync);
    caps.provide("route", { available: () => true, current: () => null, onChange: routes.on });
    caps.provide("location", { available: () => true, current: () => here, onFix: fixes.on });
    const kernel = K.createKernel({ bus, caps, contracts: C, now: clock.now, timers: clock.timers, log: { info() {}, warn() {}, error() {} } });
    kernel.define(AGENT); kernel.start();
    await flushAsync();
    assert.equal(kernel.get("roadsense-sync").state, "running");
    // the first fix after the app opens is private
    fixes.emit({ lat: LAT + 0.01, lng: LNG, speedMs: 0 });
    assert.equal(p.sync.status().privateZones, 1);
    // a route appears: its tiles are fetched (C's report comes down)
    w.at(T0 + 12 * MIN); clock.set(T0 + 12 * MIN);
    routes.emit({ path: [[LAT, LNG], [LAT, LNG + 3000 * M_LNG]] });
    await flushAsync();
    assert.ok(w.calls.some((c) => c.phone === "A" && c.path === "/roadsense/area"));
    assert.equal(truth(p, T0 + 12 * MIN, 1500).status, "candidate");
    // a ride starts here, ends 3 km on: both private
    bus.publish("state.ride", { active: true }, { sticky: true });
    p.feel({ east: 1000 });
    here = { lat: LAT, lng: LNG + 3000 * M_LNG, speedMs: 0 };
    p.feel({ east: 2950 });                                             // near the end: never shared
    bus.publish("state.ride", { active: false }, { sticky: true });
    assert.equal(p.sync.status().privateZones, 3);
    await flushAsync();                                                  // the ride-end flush (nothing old enough yet)
    // the minute timer uploads once they're old enough
    w.at(T0 + 25 * MIN); clock.advance(13 * MIN);
    await flushAsync();
    const ups = w.calls.filter((c) => c.phone === "A" && c.path === "/roadsense/upload");
    assert.equal(ups.length, 1);
    assert.equal(ups[0].body.obs.length, 1, "the one in the middle of the ride");
    assert.equal(bus.last("state.roadsense").privateDropped, 1);
    kernel.stop?.("roadsense-sync");
});

test("wiring: scripts in order, offline precache, capabilities, the settings section, server routes, type-checked", () => {
    const html = read("public/index.html");
    const pos = (s) => html.indexOf(`<script src="${s}`);
    assert.ok(pos("js/master/roadsense/roadsense.js") < pos("js/master/roadsense/sync.js"));
    assert.ok(pos("js/master/roadsense/sync.js") < pos("js/master/master-app.js"));
    assert.ok(pos("js/master/agents/roadsense-agent.js") < pos("js/master/master-app.js"));
    assert.ok(pos("js/master/master-app.js") < pos("js/master/roadsense/roadsense-ui.js"));
    for (const id of ["roadsense-share-toggle", "roadsense-status", "roadsense-forget-btn"]) assert.ok(html.includes(`id="${id}"`), id);
    assert.doesNotMatch(html.match(/<input[^>]*id="roadsense-share-toggle"[^>]*>/)[0], /checked/, "off by default");
    assert.match(html, /<script src="https:\/\/maps\.googleapis\.com\/maps\/api\/js\?key=[^"]+&libraries=places&loading=async"><\/script>/);
    const sw = read("public/sw.js");
    for (const f of ["roadsense/roadsense.js", "roadsense/sync.js", "roadsense/roadsense-ui.js", "agents/roadsense-agent.js"]) assert.ok(sw.includes(`"/js/master/${f}"`), f);
    assert.match(read("public/js/master/master-app.js"), /caps\.provide\("roadsense-sync"/);
    const server = read("server.js");
    assert.match(server, /createRoadsense\(\{ db: \(\) => db, secret: \(\) => SERVER_SECRET \}\)/);
    assert.match(server, /createMasterApi\(\{\s*express, rateLimit, roadsense,/);
    const ts = JSON.parse(read("tsconfig.master.json")).files;
    for (const f of ["roadsense/sync.js", "roadsense/roadsense-ui.js", "agents/roadsense-agent.js"]) assert.ok(ts.includes(`public/js/master/${f}`), f);
    assert.ok(JSON.parse(read("tsconfig.master-server.json")).files.includes("lib/master/roadsense.js"));
});
