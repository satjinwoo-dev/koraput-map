// Master AI cognitive engines (public/js/master/: geo, remote, providers, cognition, phrases-radar, the radar agents …)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../../public/js/master/contracts.js");
const B = require("../../public/js/master/bus.js");
const K = require("../../public/js/master/kernel.js");
const CAPS = require("../../public/js/master/capabilities.js");
const P = require("../../public/js/master/persona.js");
const PH = require("../../public/js/master/phrases-desi.js");
const O = require("../../public/js/master/output.js");
const BR = require("../../public/js/master/brain.js");
const GEO = require("../../public/js/master/geo.js");
const REMOTE = require("../../public/js/master/remote.js");
const PROV = require("../../public/js/master/providers.js");
const COG = require("../../public/js/master/cognition.js");
const PR = require("../../public/js/master/phrases-radar.js");
const A = {
    corridor: require("../../public/js/master/agents/corridor-agent.js"),
    weather: require("../../public/js/master/agents/weather-agent.js"),
    traffic: require("../../public/js/master/agents/traffic-agent.js"),
    topology: require("../../public/js/master/agents/topology-agent.js"),
    blackspot: require("../../public/js/master/agents/blackspot-agent.js"),
    poi: require("../../public/js/master/agents/poi-agent.js"),
    link: require("../../public/js/master/agents/link-agent.js"),
    search: require("../../public/js/master/agents/search-agent.js"),
    mood: require("../../public/js/master/agents/mood-agent.js"),
    destination: require("../../public/js/master/agents/destination-agent.js"),
    context: require("../../public/js/master/agents/context-agent.js")
};
const NET = require("../../public/js/master/agents/network-agent.js");

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const quietLog = { info() {}, warn() {}, error() {} };

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
function emitter() {
    const fns = new Set();
    return { on(fn) { fns.add(fn); return () => fns.delete(fn); }, emit(v) { for (const fn of [...fns]) fn(v); } };
}

/** A fake server: routes { "/weather": (body) => data } → { ok, data }. */
function fakeApi(routes = {}) {
    const calls = [];
    const samplers = new Set();
    return {
        calls, offline: false,
        available: () => true,
        async post(path, body) {
            calls.push({ path, body });
            const fn = routes[path];
            if (!fn) return { ok: false, status: 404, data: null, reason: "no-route" };
            const r = await fn(body);
            return r && r.__fail ? { ok: false, status: r.status || 502, data: r, reason: r.reason || "x" } : { ok: true, status: 200, data: r, bytes: 1000, ms: 50 };
        },
        async get(path) { calls.push({ path }); const fn = routes[path.split("?")[0]]; return fn ? { ok: true, status: 200, data: null, bytes: 65536, ms: 2000 } : { ok: false, status: 404 }; },
        onSample(fn) { samplers.add(fn); return () => samplers.delete(fn); },
        sample(s) { for (const fn of samplers) fn(s); },
        setOffline(v) { this.offline = v; }
    };
}

/** A whole Master with fake time, recording speech, fake sensors. */
function harness({ api = fakeApi(), route = null, extraCaps = {}, agents = [], style = "desi" } = {}) {
    const clock = fakeClock();
    const bus = B.createBus({ now: clock.now, timers: clock.timers });
    const caps = CAPS.createCapabilities();
    caps.provide("store", CAPS.createStoreProvider({}));
    const fixes = emitter(), routes = emitter(), drives = emitter();
    let current = null, currentRoute = route, drive = { driving: true, navigating: Boolean(route) };
    caps.provide("location", { available: () => true, current: () => current, onFix: fixes.on });
    caps.provide("route", { available: () => true, current: () => currentRoute, onChange: routes.on });
    caps.provide("drive", { available: () => true, current: () => drive, onChange: drives.on });
    caps.provide("master-api", api);
    for (const [k, v] of Object.entries(extraCaps)) caps.provide(k, v);
    const persona = PR.install(PH.install(P.createPersona({ style, rng: () => 0 })));
    const said = [];
    const output = O.createOutput({ window: {}, voice: (text, o) => { said.push({ text, ...o }); return true; }, island: () => true, busy: () => false, emit: () => {} });
    const brain = BR.createBrain({ bus, contracts: C, persona, output, now: clock.now, timers: clock.timers, config: { gapMs: 0 } });
    const kernel = K.createKernel({ bus, caps, contracts: C, now: clock.now, timers: clock.timers, log: quietLog });
    const reports = [];
    bus.subscribe("report.**", (d, env) => reports.push({ ...d, source: env.source }));
    for (const a of agents) kernel.define(a);
    kernel.start();
    return {
        clock, bus, caps, kernel, brain, persona, said, reports, api,
        ride(active = true, extra = {}) { bus.publish("state.ride", { active, ridingSec: 600, speedMs: 15, ...extra }, { sticky: true, source: "ride" }); },
        fix(lat, lng, speedMs = 15) { current = { lat, lng, speedMs, accuracyM: 5, confidence: 1, accepted: true, t: clock.now() }; fixes.emit(current); },
        setRoute(r) { currentRoute = r; drive = { driving: true, navigating: Boolean(r) }; routes.emit(r); },
        kinds: () => reports.map((r) => r.kind)
    };
}

// A straight road due north from (20.0, 85.0), 10 km, a vertex every ~111 m.
const ROAD = Array.from({ length: 91 }, (_, i) => [20 + i * 0.001, 85]);
const ROUTE = { path: ROAD, distanceM: 10000 };
/** Ride north along ROAD, one fix per step metres. */
function rideNorth(h, fromM, toM, step = 50, speed = 15) {
    for (let m = fromM; m <= toM; m += step) { h.clock.advance(Math.round((step / speed) * 1000)); h.fix(20 + m / 111195, 85, speed); }
}

// ================================================================ geo
test("geo: cursor + slice give exactly the road ahead; resample; project; hairpins from geometry", () => {
    const cur = GEO.createCursor();
    const p = cur.locate(ROAD, 20.00505, 85.0001);
    const sl = GEO.slice(ROAD, p.cum, p.i, p.t, 2000);
    const len = GEO.cumulative(sl.line).at(-1);
    assert.ok(Math.abs(len - 2000) < 1, `len ${len}`);
    assert.ok(Math.abs(sl.line[0][0] - 20.00505) < 1e-5);
    const rs = GEO.resample(sl.line, 200);
    assert.equal(rs.length, 11);
    assert.equal(rs.at(-1)[2], 2000);
    const pr = GEO.project(20.0105, 85.001, sl.line);
    assert.ok(Math.abs(pr.s - 611) < 5 && Math.abs(pr.d - 104) < 3, JSON.stringify(pr));
    // a hairpin: up 200 m, a tight U-turn, back down a parallel road 30 m away
    const hp = [[20, 85], [20.0018, 85], [20.00195, 85.00007], [20.002, 85.00015], [20.00195, 85.00023], [20.0018, 85.0003], [20, 85.0003]];
    const turns = GEO.turnRate(hp, 80).filter((r) => r.turnDeg >= 100);
    assert.ok(turns.length > 0);
    assert.equal(GEO.light(20.3, 85.8, Date.UTC(2026, 9, 11, 6, 30)), "day");      // Bhubaneswar, noon IST
    assert.equal(GEO.light(20.3, 85.8, Date.UTC(2026, 9, 11, 16, 30)), "dark");    // 22:00 IST
    assert.equal(GEO.tileCentre(GEO.tileOf(20.011, 85.019)).join(), "20.01,85.01");
});

// ================================================================ corridor
test("corridor agent: route mode follows the route 2 km ahead; heading mode without one; inactive when not riding", () => {
    const h = harness({ route: ROUTE, agents: [A.corridor] });
    h.ride(true);
    h.fix(20.0005, 85);
    let c = h.bus.last("state.corridor");
    assert.equal(c.mode, "route");
    assert.equal(c.active, true);
    assert.ok(Math.abs(c.lengthM - 2000) < 2);
    assert.ok(c.line.length <= 40 && c.samples.length === 11);
    assert.ok(Math.abs(c.sOnRouteM - 56) < 3);
    h.setRoute(null);
    rideNorth(h, 100, 300);
    c = h.bus.last("state.corridor");
    assert.equal(c.mode, "heading");
    assert.ok(Math.abs(c.ego.headingDeg) < 2 || Math.abs(c.ego.headingDeg - 360) < 2);
    assert.ok(c.line.at(-1)[0] > c.ego.lat + 0.017);                 // 2 km north
    h.ride(false); h.setRoute(null);
    h.bus.publish("state.ride", { active: false }, { sticky: true });
    h.caps.get("drive").current = () => ({ driving: false, navigating: false });
    h.clock.advance(6000); h.fix(20.0031, 85, 0);
    assert.equal(h.bus.last("state.corridor").active, false);
    assert.ok(["day", "dusk", "dark"].includes(h.bus.last("state.light")));
});

// ================================================================ weather
/** hazardAt(metres north of the road's start) → hazards: the weather is fixed on the ground, not relative to the rider */
function wxApi(hazardAt) {
    return fakeApi({ "/weather": (body) => ({ ok: true, samples: body.points.map((p) => ({ sAheadM: p[2], tempC: 27, hazards: hazardAt(Math.round((p[0] - 20) * 111195)) })) }) });
}
test("weather agent: rain 1.2 km ahead is said once with its distance, again only when worse; weather already here: heat as 'abhi', rain left to the advice module", async () => {
    let level = "advice";
    const api = wxApi((m) => [...(m >= 1200 ? [{ type: "rain", level, value: 3, unit: "mm/h" }] : []), ...(m >= 2500 ? [{ type: "heat", level: "warning", value: 42, unit: "°C" }] : [])]);
    const h = harness({ api, route: ROUTE, agents: [A.corridor, A.weather] });
    h.ride(true);
    h.fix(20, 85);
    await flush();
    const r1 = h.reports.filter((r) => r.kind === "weather.rain");
    assert.equal(r1.length, 1);
    assert.equal(r1[0].severity, "advice");
    assert.equal(r1[0].data.distanceM, 1200);
    assert.match(h.said.at(-1).text, /1\.2 km aage baarish hai/);
    // the same rain on the next answer: silent
    rideNorth(h, 50, 900);
    await flush();
    assert.equal(h.reports.filter((r) => r.kind === "weather.rain").length, 1);
    // worse now, still ahead
    level = "warning";
    rideNorth(h, 950, 1000);
    h.clock.advance(300000); h.fix(20 + 1000 / 111195, 85);          // refresh after 5 min
    await flush();
    const r3 = h.reports.filter((r) => r.kind === "weather.rain");
    assert.equal(r3.length, 2);
    assert.equal(r3[1].severity, "warning");
    // into the rain and the heat: heat is said as "abhi", the rain here is the advice module's line
    rideNorth(h, 1050, 2600);
    await flush();
    const heat = h.reports.find((r) => r.kind === "weather.heat");
    assert.ok(heat, h.kinds().join());
    assert.equal(h.reports.filter((r) => r.kind === "weather.rain").length, 2);
    assert.ok(api.calls.length <= 6, `calls ${api.calls.length}`);   // not one per fix
    assert.ok(h.bus.last("state.weather").hazards.some((x) => x.type === "rain"));
});

// ================================================================ traffic
test("traffic agent: a jam ahead is one report per episode; not configured → degraded and silent", async () => {
    const api = fakeApi({ "/traffic": (b) => ({ ok: true, segments: b.points.map((p) => ({ sAheadM: p[2], level: p[2] >= 1500 ? "jam" : "free", delayS: p[2] >= 1500 ? 240 : 0 })) }) });
    const h = harness({ api, route: ROUTE, agents: [A.corridor, A.traffic] });
    h.ride(true);
    h.fix(20, 85);
    await flush();
    const j = h.reports.filter((r) => r.kind === "traffic.jam-ahead");
    assert.equal(j.length, 1);
    assert.deepEqual([j[0].data.distanceM, j[0].data.delayMin], [1500, 8]);
    h.clock.advance(61000); h.fix(20.0005, 85);
    await flush();
    assert.equal(h.reports.filter((r) => r.kind === "traffic.jam-ahead").length, 1);
    const off = fakeApi({ "/traffic": () => ({ __fail: true, status: 503, reason: "not-configured" }) });
    const h2 = harness({ api: off, route: ROUTE, agents: [A.corridor, A.traffic] });
    h2.ride(true); h2.fix(20, 85);
    await flush();
    assert.equal(h2.kernel.get("traffic").state, "degraded");
    assert.equal(h2.reports.filter((r) => r.kind.startsWith("traffic.")).length, 0);
});

// ================================================================ topology
test("topology: steep runs from heights; level crossing and breaker said at the right moment; a bridge only when wet", async () => {
    const z = Array.from({ length: 41 }, (_, i) => (i < 10 ? 500 : i < 30 ? 500 - (i - 10) * 5 : 400));   // 10 % descent over 1 km
    const runs = A.topology.steepRuns(z, 50);
    assert.equal(runs.length, 1);
    assert.ok(runs[0].avgGrade < -0.09 && runs[0].s1 - runs[0].s0 >= 900);
    const api = fakeApi({ "/road": () => ({ ok: true, features: [
        { id: "n1", type: "level-crossing", lat: 20.0045, lng: 85 },
        { id: "n2", type: "breaker", lat: 20.0081, lng: 85 },
        { id: "w3", type: "bridge", lat: 20.012, lng: 85, lengthM: 400 }
    ] }) });
    const terrain = { available: () => true, heights: async (pts) => pts.map((_, i) => (i < 10 ? 500 : i < 30 ? 500 - (i - 10) * 5 : 400)) };
    const h = harness({ api, route: ROUTE, agents: [A.corridor, A.topology], extraCaps: { terrain } });
    h.ride(true);
    h.fix(20, 85);
    await flush();
    rideNorth(h, 50, 150, 50, 12);
    const lc = h.reports.find((r) => r.kind === "road.level-crossing");
    assert.ok(lc && lc.data.distanceM >= 150 && lc.data.distanceM <= 600);
    rideNorth(h, 200, 800, 50, 12);
    const br = h.reports.find((r) => r.kind === "road.breaker-ahead");
    assert.ok(br, "breaker said");
    assert.ok(br.data.distanceM / 12 >= 4 && br.data.distanceM / 12 <= 10.5, `breaker at ${br.data.distanceM} m`);
    assert.ok(!h.reports.some((r) => r.kind === "road.bridge-ahead"), "dry: no bridge talk");
    assert.ok(h.reports.some((r) => r.kind === "terrain.ghat-ahead" && r.severity === "warning"), h.kinds().join());
});

// ================================================================ blackspot
test("blackspot agent: warned once at speed × 30 s, louder after dark, fatalities only when known", async (t) => {
    // the corridor agent works out state.light from the real clock (sun elevation at the rider): pin it to
    // night in India, or a CI run in the Indian daytime publishes "day" over the "dark" this test sets
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-11T18:00:00Z") });   // 23:30 IST
    const api = fakeApi({ "/blackspots": () => ({ ok: true, datasetVersion: "x@1:1", spots: [{ id: "x:1", lat: 20.009, lng: 85, radiusM: 200, fatalities: 5, source: "x" }] }) });
    const h = harness({ api, route: ROUTE, agents: [A.corridor, A.blackspot] });
    h.bus.publish("state.light", "dark", { sticky: true });
    h.ride(true);
    h.fix(20, 85, 20);                                              // 1 km away, lead at 20 m/s = 600 m
    await flush();
    assert.equal(h.reports.filter((r) => r.kind === "blackspot.ahead").length, 0);
    rideNorth(h, 50, 600, 50, 20);
    const b = h.reports.filter((r) => r.kind === "blackspot.ahead");
    assert.equal(b.length, 1);
    assert.equal(b[0].priority, 80);
    assert.equal(b[0].data.fatalities, 5);
    assert.ok(b[0].data.distanceM <= 600);
    assert.match(h.said.at(-1).text, /5 log jaan gawa chuke/);
    rideNorth(h, 650, 800, 50, 20);
    assert.equal(h.reports.filter((r) => r.kind === "blackspot.ahead").length, 1);
});

// ================================================================ POI
const PLACES = [
    { cat: "hospital", source: "osm", osmId: "n1", name: "PHC Near", lat: 20.002, lng: 85, phone: "+91 1", score: 0.35, tier: "unvetted", storable: true },
    { cat: "hospital", source: "google", placeId: "g1", name: "City Hospital", lat: 20.0028, lng: 85, phone: "+91 2", score: 0.8, tier: "vetted", rating: 4.3, reviewsCount: 500, storable: ["placeId", "lat", "lng"] },
    { cat: "food", source: "google", placeId: "g2", name: "Sharma Dhaba", lat: 20.02, lng: 85, phone: null, score: 0.78, tier: "vetted", storable: ["placeId", "lat", "lng"] },
    { cat: "food", source: "google", placeId: "g3", name: "Behind Dhaba", lat: 19.99, lng: 85, phone: null, score: 0.9, tier: "vetted", storable: ["placeId", "lat", "lng"] }
];
test("poi agent: tiles fetched once, ranked every second, emergencies answered from memory, Google fields not persisted, dhaba ahead on a break", async () => {
    const api = fakeApi({ "/poi": () => ({ ok: true, places: PLACES }) });
    const h = harness({ api, route: ROUTE, agents: [A.corridor, A.poi] });
    h.ride(true);
    h.fix(20, 85);
    for (let i = 0; i < 3; i++) { h.clock.advance(1000); await flush(); }      // tick → fetch → next tick ranks
    const tilesAsked = api.calls.filter((c) => c.path === "/poi").length;
    assert.ok(tilesAsked >= 1 && tilesAsked <= 3);
    const st = h.bus.last("state.poi");
    assert.equal(st.best.hospital.name, "City Hospital");
    assert.match(st.best.hospital.navUrl, /destination=20\.0028/);
    const em = await h.bus.request("task.emergency", { kind: "medical" });
    assert.equal(em.primary.name, "City Hospital");                    // vetted and ≤ 1.5× the nearest's distance
    assert.equal(em.emergencyNumber, "112");
    const stored = h.caps.get("store").namespace("poi").get("tiles");
    const all = Object.values(stored).flatMap((t) => t.places);
    assert.ok(all.some((p) => p.name === "PHC Near"));                  // OSM kept whole
    assert.ok(all.filter((p) => p.source === "google").every((p) => !("name" in p) && !("phone" in p)));
    // a break is due: the best dhaba AHEAD, not the better one behind
    h.fix(20.0005, 85);
    h.bus.publish("report.ride.ride.break-due", { kind: "ride.break-due", severity: "advice" }, { source: "ride" });
    await flush();
    const rs = h.reports.find((r) => r.kind === "rest.stop");
    assert.equal(rs.data.place, "Sharma Dhaba");
    const ranked = A.poi.rank(PLACES, "food", { lat: 20, lng: 85, speedMs: 0, headingDeg: null }, GEO);
    assert.equal(ranked[0].name, "Behind Dhaba");                       // stopped: no "ahead" bonus, the better one wins
});

// ================================================================ link
test("link agent: a falling RSRP predicts the drop; slow passive throughput → network.slow", async () => {
    const samples = emitter();
    const radio = { available: () => true, native: true, snapshot: async () => null, onSample: samples.on };
    const net = { available: () => true, status: () => ({ connected: true, type: "4g" }), onChange: () => () => {}, probe: async () => ({ ok: true, rttMs: 100 }) };
    const api = fakeApi({});
    const h = harness({ api, agents: [NET, A.link], extraCaps: { radio, network: net } });
    h.ride(true);
    await flush();
    for (let i = 0; i < 15; i++) {
        h.clock.advance(2000);
        samples.emit({ t: h.clock.now(), transport: "cellular", gen: "4g", level: 1, rsrp: -100 - i * 0.8, dbm: -100 - i * 0.8 });
    }
    const d = h.reports.find((r) => r.kind === "network.degrading");
    assert.ok(d, h.kinds().join());
    assert.ok(d.data.inS > 0 && d.data.inS <= 45);
    for (let i = 0; i < 3; i++) api.sample({ bytes: 20000, ms: 1500, status: 200, path: "/poi" });   // ≈ 0.1 Mbit/s
    assert.ok(h.reports.some((r) => r.kind === "network.slow"));
    assert.ok(h.bus.last("state.link").trendDbmPerMin < -20);
    assert.ok(Math.abs(A.link.slope([[0, 0], [1, 2], [2, 4], [3, 6]]) - 2) < 1e-9);
});

// ================================================================ deep search
test("deep-search agent: delegated questions carry coarse context; offline questions are answered when the network is back", async () => {
    let offline = true;
    const api = fakeApi({ "/search": (b) => (offline ? { __fail: true, status: 0, reason: "offline" } : { ok: true, answer: { spoken: `Bhai, jawaab: ${b.query}`, title: "Answer", summary: "Summary", bullets: [], confidence: 0.9 }, sources: [{ title: "S", url: "https://s" }] }) });
    const h = harness({ api, agents: [A.search] });
    h.fix(20.12345, 85.6789);
    const r1 = await h.brain.delegate("deep-search", { query: "kal mausam kaisa rahega" });
    assert.equal(r1.ok, false);
    offline = false;
    h.bus.publish("state.weather", { at: 1, here: { tempC: 31, feelsC: 35, rhPct: 40 }, hazards: [{ type: "rain", level: "advice", distanceM: 1200 }] }, { sticky: true });
    h.bus.publish("state.poi", { at: 1, best: { hospital: null, food: { category: "food", name: "Sharma Dhaba", distanceM: 900, tier: "vetted", phone: "+91 1" } } }, { sticky: true });
    const r2 = await h.brain.delegate("deep-search", { query: "petrol pump kahan hai" });
    assert.equal(r2.ok, true);
    assert.equal(r2.result.sources[0].url, "https://s");
    const ctx = api.calls.at(-1).body.context;
    assert.deepEqual([ctx.lat, ctx.lng], [20.12, 85.68]);
    // what the agents already know goes along, so even the local model answers from real data (and nothing more: no phone numbers)
    assert.deepEqual(ctx.live, { weather: { tempC: 31, feelsC: 35, rhPct: 40, hazards: [{ type: "rain", distanceM: 1200 }] }, nearby: [{ category: "food", name: "Sharma Dhaba", distanceM: 900, tier: "vetted" }] });
    h.bus.publish("state.network", { level: "good" }, { sticky: true });
    await flush();
    const ans = h.reports.find((r) => r.kind === "search.answer");
    assert.match(ans.text, /kal mausam kaisa rahega/);
    assert.equal(h.bus.last("state.answer").query, "kal mausam kaisa rahega");
});

// ================================================================ mood
test("mood agent: drowsy rider → energising suggestion; muted on request; two 'nahi' silence it", async () => {
    const tracks = emitter();
    const media = { available: () => true, access: () => true, refresh: async () => true, current: () => null, onTrack: tracks.on, control: async () => true };
    const api = fakeApi({ "/music": (b) => ({ ok: true, mood: { label: "chill", valence: 0.1, energy: -0.6, confidence: 0.7 }, suggestions: [{ title: `Josh ${b.target}`, artist: "X" }] }) });
    const h = harness({ api, agents: [A.mood], extraCaps: { media } });
    h.bus.publish("state.fatigue", { level: "moderate", at: h.clock.now() }, { sticky: true });
    tracks.emit({ title: "Lofi 1", artist: "A", playing: true });
    await flush();
    assert.equal(api.calls[0].body.target, "energise");
    const s = h.reports.find((r) => r.kind === "music.energise");
    assert.equal(s.data.song, "Josh energise");
    await h.bus.request("task.music-mute", { minutes: 60 });
    h.clock.advance(1300000);
    tracks.emit({ title: "Lofi 2", artist: "A", playing: true });
    await flush();
    assert.equal(h.reports.filter((r) => r.kind.startsWith("music.")).length, 1);
    assert.equal((await h.bus.request("task.music-control", { action: "next" })).ok, true);
});

// ================================================================ destination
test("destination agent: a 'care' arrival is said with its main reason in Hinglish, English on screen", async () => {
    const api = fakeApi({ "/destination": () => ({ ok: true, score: 62, level: "care", factors: [{ id: "dark", weight: -20 }, { id: "police-far", weight: -6 }], facts: {}, arriveAt: 0 }) });
    const app = { available: () => true, snapshot: () => ({ destination: { name: "Daringbadi", etaS: 7200 }, place: "", bike: null, group: { size: 1 } }), onEvent: () => () => {} };
    const h = harness({ api, agents: [A.destination], extraCaps: { "app-context": app } });
    h.setRoute(ROUTE);
    await flush();
    const r = h.reports.find((x) => x.kind === "destination.care");
    assert.equal(r.data.reason, "pahunchte pahunchte andhera ho jayega");
    assert.equal(api.calls[0].body.etaS, 7200);
    const words = h.persona.phrase({ kind: r.kind, key: "k", severity: "advice", data: r.data });
    assert.match(words.text, /Daringbadi/);
    assert.match(words.display.sub, /after dark/);
});

// ================================================================ context + cognition
test("context agent + affect policy: 'bas kar yaar' holds advice back, a safety warning still speaks", async () => {
    const ev = emitter();
    const app = { available: () => true, snapshot: () => ({ bike: { title: "Hunter 350" }, group: { inTrip: true, size: 4 }, destination: null, place: "Koraput" }), onEvent: ev.on };
    const h = harness({ agents: [A.context], extraCaps: { "app-context": app } });
    COG.install({ brain: h.brain, bus: h.bus, now: h.clock.now });
    ev.emit({ type: "place-search", detail: { name: "Deomali" }, t: 0 });
    assert.deepEqual(h.bus.last("state.user").recentSearches, ["Deomali"]);
    ev.emit({ type: "voice-heard", detail: { text: "bas kar yaar chup" }, t: 0 });
    assert.ok(h.bus.last("state.affect").irritation >= 0.6);
    const before = h.said.length;
    h.brain.tell({ kind: "rest.stop", severity: "advice", data: { place: "X", distanceM: 900 } });
    h.brain.tell({ kind: "blackspot.ahead", severity: "warning", data: { distanceM: 500 } });
    h.clock.advance(100);
    assert.equal(h.said.length, before + 1);
    assert.match(h.said.at(-1).text, /accident|blackspot/i);
    h.clock.advance(1200000);                                         // 20 min: irritation decayed
    h.brain.tell({ kind: "rest.stop", severity: "advice", data: { place: "Y", distanceM: 900 } });
    h.clock.advance(100);
    assert.equal(h.said.length, before + 2);
});

test("cognition: declined tips teach the Master to stop (with exploration); wet road × ghat becomes one compound warning", () => {
    const h = harness();
    const store = h.caps.get("store").namespace("cognition");
    const cog = COG.install({ brain: h.brain, bus: h.bus, store, now: h.clock.now });
    for (let i = 0; i < 8; i++) {
        h.bus.publish("report.mood.music.suggest", { kind: "music.suggest", category: "music" }, { source: "mood" });
        h.bus.publish("master.decision", { id: `x${i}`, kind: "music.suggest", source: "mood", action: "asking" });
        h.bus.publish("master.decision", { id: `x${i}`, kind: "music.suggest", source: "mood", action: "declined" });
    }
    assert.ok(cog.interest("music").mean < 0.2);
    assert.ok(store.get("beliefs").music);
    const decisions = [];
    h.bus.subscribe("master.decision", (d) => decisions.push(d));
    h.brain.tell({ kind: "music.suggest", severity: "advice", category: "music", data: { song: "A", mood: "chill" } });     // exploration
    h.brain.tell({ kind: "music.calm", severity: "advice", category: "music", key: "m2", data: { song: "B" } });
    assert.ok(decisions.some((d) => /rider usually declines music/.test(d.reason)));
    // evidence fades: 8 weeks later the prior is back
    h.clock.advance(56 * 86400000);
    assert.ok(cog.interest("music").mean > 0.5);
    // fusion
    const h2 = harness();
    COG.install({ brain: h2.brain, bus: h2.bus, now: h2.clock.now });
    h2.bus.publish("state.ride", { active: true }, { sticky: true });
    h2.brain.tell({ kind: "weather.rain", severity: "advice", data: { distanceM: 800 } });
    h2.clock.advance(10000);
    h2.brain.tell({ kind: "terrain.ghat-ahead", severity: "warning", data: { distanceM: 1200, gradePct: 9, dir: "utraai" } });
    h2.clock.advance(100);
    const last = h2.said.at(-1);
    assert.match(last.key, /^master:radar\.compound:wet-road:/);
    assert.match(last.text, /ghat bhi hai aur baarish bhi/);
});

// ================================================================ phrases
test("radar phrase pack: every line renders, desi/plain cover the same kinds, the screen is always English", () => {
    const sample = { distanceM: 1200, lengthM: 400, now: "abhi", delayMin: 6, dir: "utraai", gradePct: 9, count: 3, hazard: "khatra", why: "fislan", fatalities: 4, first: "ghat", second: "baarish", place: "Sharma Dhaba", category: "dhaba", destination: "Daringbadi", reason: "andhera", mood: "chill", song: "Kesariya", condition: "baarish" };
    for (const [style, pack] of Object.entries({ desi: PR.desi, plain: PR.plain })) {
        const p = P.createPersona({ style, name: "Asha" });
        for (const [kind, bySev] of Object.entries(pack)) for (const [sev, lines] of Object.entries(bySev)) for (const line of lines) {
            const out = p.render(line.say, { name: "Asha", ...sample });
            assert.ok(out, `${style} ${kind}/${sev}: "${line.say}" has an unknown placeholder`);
            if (sev === "critical") assert.ok(out.length <= P.CRITICAL_MAX);
        }
    }
    assert.deepEqual(Object.keys(PR.desi).sort(), Object.keys(PR.plain).sort());
    for (const bySev of Object.values(PR.desi)) for (const lines of Object.values(bySev)) for (const l of lines) assert.equal("title" in l || "sub" in l, false);
    const HINGLISH = /\b(bhai|hai|hain|nahi|kar|karo|aage|ruk|chal|raha|rahi|gaya|thoda|thodi|bahut|aankh|kamzor|wapas|paani|abhi|baad|dhyan|baarish|utraai|andhera)\b/i;
    const persona = PR.install(PH.install(P.createPersona({ style: "desi", rng: () => 0 })));
    const data = { ...sample, screen: { now: "Now", dir: "descent", hazard: "Sharp bend", why: "wet bridge decks are slippery", first: "Ghat", second: "Rain", category: "Food stop", reason: "you'll arrive after dark", mood: "chilled", destination: "Daringbadi", condition: "Rain" } };
    for (const [kind, bySev] of Object.entries(PR.desi)) for (const sev of Object.keys(bySev)) {
        const out = persona.phrase({ kind, key: kind, severity: sev, data });
        assert.doesNotMatch(`${out.display.title} ${out.display.sub}`, HINGLISH, `${kind}/${sev}: ${out.display.title} / ${out.display.sub}`);
    }
    // weather here vs ahead pick different lines
    const ahead = persona.phrase({ kind: "weather.rain", key: "a", severity: "advice", data: { distanceM: 800 } });
    const here = persona.phrase({ kind: "weather.rain", key: "b", severity: "advice", data: { now: "abhi", screen: { now: "Now" } } });
    assert.match(ahead.text, /800 metre aage/);
    assert.match(here.text, /^Bhai, abhi /);
    assert.doesNotMatch(here.text, /metre|km/);
});

// ================================================================ capabilities
test("master-api provider: offline short-circuits, identical requests share one call, not-configured is remembered, samples feed bandwidth", async () => {
    let n = 0, online = true;
    const fetchImpl = async (url, init) => { n++; await new Promise((r) => setTimeout(r, 5)); return url.endsWith("/traffic") ? { ok: false, status: 503, text: async () => '{"ok":false,"reason":"traffic-not-configured"}' } : { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, echo: JSON.parse(init.body) }) }; };
    const api = REMOTE.createMasterApiProvider({ window: {}, fetchImpl, base: () => "https://srv/api/master", online: () => online });
    const seen = [];
    api.onSample((s) => seen.push(s));
    const [a, b] = await Promise.all([api.post("/weather", { x: 1 }), api.post("/weather", { x: 1 })]);
    assert.equal(n, 1);
    assert.deepEqual(a.data.echo, { x: 1 }); assert.equal(b.ok, true);
    assert.equal(seen.length, 1);
    await api.post("/traffic", {});
    const again = await api.post("/traffic", {});
    assert.equal(again.reason, "not-configured");
    assert.equal(n, 2);
    online = false;
    assert.equal((await api.post("/weather", { x: 2 })).reason, "offline");
    assert.equal(n, 2);
});

test("providers: radio and track samples are cleaned; the app context forwards the app's events", () => {
    const r = PROV.cleanRadio({ transport: "cellular", gen: "4g", level: 7, rsrp: -98, dbm: "x" });
    assert.deepEqual([r.level, r.rsrp, r.dbm], [4, -98, null]);
    assert.equal(PROV.cleanTrack({ title: "  " }), null);
    assert.equal(PROV.cleanTrack({ title: "Song", artist: "A", package: "com.spotify.music" }).app, "com.spotify.music");
    const listeners = {};
    const doc = { addEventListener: (t, fn) => { listeners[t] = fn; } };
    const W = { localStorage: { getItem: (k) => (k === "mu.garage.v1" ? JSON.stringify({ title: "Classic 350", classKey: "re-350" }) : null) } };
    const app = PROV.createAppContextProvider(W, doc);
    const got = [];
    app.onEvent((e) => got.push(e));
    listeners["mu:place-search"]({ detail: { name: "Araku", lat: 18.3, lng: 82.9 } });
    listeners["mu:voice-heard"]({ detail: { text: "bas kar", mode: "ptt" } });
    assert.deepEqual(got.map((e) => e.type), ["place-search", "voice-heard"]);
    assert.equal(app.snapshot().bike.title, "Classic 350");
});

test("every new agent passes the kernel's contract", () => {
    for (const [name, def] of Object.entries(A)) assert.equal(C.validateAgent(def).ok, true, name);
});
