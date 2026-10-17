// RoadSense Live step 4: the Route Truth Card (roadsense/truth.js), its agent (agents/truth-agent.js), the words
// (phrases-desi.js road.truth*, road.route-truth) and the card on screen (roadsense/truth-card.js viewModel)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const RS = require("../../public/js/master/roadsense/roadsense.js");
const TR = require("../../public/js/master/roadsense/truth.js");
const CARD = require("../../public/js/master/roadsense/truth-card.js");
const AGENT = require("../../public/js/master/agents/truth-agent.js");
const P = require("../../public/js/master/persona.js");
const PH = require("../../public/js/master/phrases-desi.js");
const B = require("../../public/js/master/bus.js");
const C = require("../../public/js/master/contracts.js");
const K = require("../../public/js/master/kernel.js");
const CAPS = require("../../public/js/master/capabilities.js");
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const T0 = Date.UTC(2026, 9, 16, 6, 0, 0), MIN = 60000, H = 3600000, D = 24 * H;
const LAT = 18.81, LNG = 82.71;
const M_LNG = 1 / (111320 * Math.cos(LAT * Math.PI / 180)), M_LAT = 1 / 111320;
const at = (east, north = 0) => ({ lat: LAT + north * M_LAT, lng: LNG + east * M_LNG });
/** a 5 km road due east, as OSRM would give it (a few vertices) */
const ROUTE = [[LAT, LNG], [LAT, LNG + 2000 * M_LNG], [LAT, LNG + 5000 * M_LNG]];
const ob = (east, o = {}) => ({ type: "bump", t: T0, ...at(east, o.north || 0), source: "imu", rider: "self", present: true, conf: 0.7, peakMs2: 14, ...o });

/** A log with: a pothole at 1200 m felt here and by 2 others (verified), a single report at 3000 m (candidate),
    a bump 40 m off the road (not on the route), and rough road at 4500 m felt twice by this phone yesterday. */
function seeded() {
    const log = RS.createLog();
    log.addAll([
        ob(1200), ob(1203, { rider: "r1aaaaaaaaaaaaaa", t: T0 + 2 * H }), ob(1198, { rider: "r2bbbbbbbbbbbbbb", t: T0 + 3 * H }),
        ob(3000, { rider: "r3cccccccccccccc", t: T0 + H }),
        ob(2500, { north: 40 }), ob(2500, { north: 40, t: T0 + 5 * MIN }),
        ob(4500, { type: "rough", t: T0 - D, peakMs2: undefined }), ob(4500, { type: "rough", t: T0 - D + 5 * MIN, peakMs2: undefined })
    ]);
    return log;
}

test("the card: events on the route in order, with their evidence; off-road and behind-the-rider events left out", () => {
    const log = seeded();
    const now = T0 + 4 * H;
    const c = TR.buildTruth({ log, path: ROUTE, now });
    assert.ok(Math.abs(c.lengthM - 5000) < 5, `${c.lengthM}`);
    assert.deepEqual(c.rows.map((r) => [r.type, r.status]), [["bump", "verified"], ["bump", "candidate"], ["rough", "verified"]]);
    const [pothole, single, rough] = c.rows;
    assert.ok(Math.abs(pothole.alongM - 1200) < 5 && pothole.offsetM < 1);
    assert.equal(pothole.riders, 3);
    assert.equal(pothole.felt, true);
    assert.deepEqual(pothole.sources, { imu: 3 });
    assert.equal(pothole.ageS, 3600, "last seen an hour ago");
    assert.ok(pothole.expiresAt > now, "valid until is measured");
    assert.equal(single.riders, 1);
    assert.equal(single.felt, false);
    assert.equal(rough.ageS, Math.round((now - (T0 - D + 5 * MIN)) / 1000));
    assert.deepEqual(c.byKind, { bump: 1, rough: 1 }, "candidates aren't counted as known hazards");
    assert.equal(c.verified, 2);
    assert.equal(c.candidates, 1);
    assert.equal(c.unknown, false);
    // the rider is 2 km in: the pothole is behind, distances count from here
    const ahead = TR.buildTruth({ log, path: ROUTE, now, fromM: 2000 });
    assert.deepEqual(ahead.rows.map((r) => r.aheadM), [1000, 2500]);
    // an empty road is UNKNOWN, never clear
    const empty = TR.buildTruth({ log: RS.createLog(), path: ROUTE, now });
    assert.equal(empty.unknown, true);
    assert.deepEqual(empty.rows, []);
});

test("the evidence in words: who, when, confirmed or not; a short form for warnings; confidence in bands", () => {
    const base = { status: "verified", confidence: 0.9, sources: { imu: 2 }, ageS: 3 * 3600 };
    assert.deepEqual(TR.evidence({ ...base, riders: 1, felt: true }), {
        desi: "aapne khud feel kiya tha, 3 ghante pehle", plain: "you felt it yourself, 3 hours ago",
        shortDesi: "aapko 3 ghante pehle yahin laga tha", shortPlain: "you hit it here 3 hours ago"
    });
    const both = TR.evidence({ ...base, riders: 3, felt: true });
    assert.equal(both.desi, "aap aur 2 aur riders ne feel kiya, aakhri baar 3 ghante pehle");
    assert.equal(both.plain, "felt by you and 2 other riders, last 3 hours ago");
    assert.equal(both.shortPlain, "reported by 3 riders 3 hours ago");
    const others = TR.evidence({ ...base, riders: 2, felt: false, ageS: 26 * 3600 });
    assert.equal(others.plain, "reported by 2 riders, last yesterday");
    assert.equal(others.shortDesi, "2 riders ne bataya, kal");
    const unconfirmed = TR.evidence({ ...base, status: "candidate", riders: 1, felt: false });
    assert.match(unconfirmed.desi, /, abhi pakka nahi$/);
    assert.match(unconfirmed.plain, /^reported by 1 rider, .*, not confirmed$/);
    assert.equal(TR.evidence({ ...base, sources: { official: 1 }, riders: 0, felt: false, refs: ["MoRTH roadworks list"] }).plain, "official: MoRTH roadworks list");
    assert.equal(TR.evidence({ ...base, sources: { official: 1, imu: 1 }, riders: 1, felt: false, refs: [] }).plain, "official (official list) and 1 rider", "never an empty source name");
    assert.deepEqual([30, 600, 7200, 90000, 5 * 86400].map((s) => TR.ago(s).plain), ["just now", "10 minutes ago", "2 hours ago", "yesterday", "5 days ago"]);
    assert.deepEqual([0.95, 0.8, 0.6, 0.3].map((c) => TR.confidenceWords(c).band), ["high", "high", "medium", "low"]);
    assert.equal(TR.screenEvidence({ ...base, riders: 3, felt: true }), "You + 2 riders · motion sensor · 3 hours ago · 90%");
});

test("the voice: fixed phrases filled with the card's values, in desi and plain; the screen always in English", () => {
    const log = seeded();
    const now = T0 + 4 * H;
    const card = TR.buildTruth({ log, path: ROUTE, now });
    const desi = PH.install(P.createPersona({ style: "desi", name: "Asha", rng: () => 0 }));
    const plain = PH.install(P.createPersona({ style: "plain", rng: () => 0 }));
    const say = (p, kind, data) => p.phrase({ kind, key: kind, severity: "advice", data });
    const d = TR.phraseData(card, "route");
    assert.equal(TR.phraseKind(card), "road.truth");
    const a = say(desi, "road.truth", d);
    assert.equal(a.text, "Asha, is raaste pe 2 pakki report hai: 1 gaddha ya breaker aur 1 kharab sadak. Pehli 1.2 km aage, gaddha ya breaker: aap aur 2 aur riders ne feel kiya, aakhri baar 1 ghante pehle, bharosa zyada.");
    assert.deepEqual(TR.phraseExtras(card), ["road.truth-rest-unknown"], "then: the rest of the road is unknown (no smooth passes)");
    assert.equal(say(desi, "road.truth-rest-unknown", d).text, "Baaki sadak ki haalat pata nahi.");
    assert.equal(a.display.title, "Road reports: 2 confirmed");
    assert.match(a.display.sub, /^First: bump or pothole in 1\.2 kilometres · felt by you and 2 other riders, last 1 hour ago$/);
    const b = say(plain, "road.truth", d);
    assert.match(b.text, /^Confirmed reports on this route: 2, 1 bump or pothole, 1 rough road\. The first, in 1\.2 kilometres: bump or pothole, felt by you and 2 other riders, last 1 hour ago, high confidence \(\d+%\)\.$/);
    // only an unconfirmed report: says so
    const lone = RS.createLog(); lone.add(ob(3000, { rider: "r3cccccccccccccc" }));
    const c2 = TR.buildTruth({ log: lone, path: ROUTE, now: T0 + H });
    assert.equal(TR.phraseKind(c2), "road.truth-unconfirmed");
    assert.match(say(desi, "road.truth-unconfirmed", TR.phraseData(c2, "route")).text, /koi pakki report nahi, sirf 1 kachchi report hai.*abhi pakka nahi\. Dhyan se chalao\.$/);
    // nothing: "condition unknown", never "clear"
    const c3 = TR.buildTruth({ log: RS.createLog(), path: ROUTE, now });
    assert.equal(TR.phraseKind(c3), "road.truth-unknown");
    const u = say(plain, "road.truth-unknown", TR.phraseData(c3, "ahead"));
    assert.equal(u.text, "No reports for the road ahead, from sensors or riders. Condition unknown, ride with care.");
    assert.equal(u.display.title, "Condition unknown");
    // "clear" / "saaf" is said only by the smooth-pass phrases (tested below), never by these
    for (const kind of ["road.truth", "road.truth-unconfirmed", "road.truth-unknown", "road.route-truth", "road.truth-rest-unknown", "road.truth-ridden", "road.truth-official", "road.truth-predicted"]) {
        for (const p of [desi, plain]) {
            const r = say(p, kind, d);
            assert.doesNotMatch(r.text, /\bclear\b|\bsaaf\b|\bsafe\b/i, `${kind}: never claims a clear road`);
            assert.doesNotMatch(`${r.display.title} ${r.display.sub}`, /\b(pakki|haalat|bharosa|gaddha|aage|riders ne)\b/, `${kind}: English on screen`);
        }
    }
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
    return { now: () => t, timers, advance };
}
function emitter() { const fns = new Set(); return { on(fn) { fns.add(fn); return () => fns.delete(fn); }, emit(v) { for (const fn of fns) fn(v); } }; }
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

async function boot(log, { route = null, here = null } = {}) {
    const clock = fakeClock(T0 + 4 * H);
    const bus = B.createBus({ now: clock.now, timers: clock.timers });
    const caps = CAPS.createCapabilities();
    const routes = emitter(), fixes = emitter(), drives = emitter();
    let current = route, drive = { driving: false, navigating: false }, pos = here;
    caps.provide("roadsense", log);
    caps.provide("route", { available: () => true, current: () => current, onChange: routes.on });
    caps.provide("location", { available: () => true, current: () => pos, onFix: fixes.on });
    caps.provide("drive", { available: () => true, current: () => drive, onChange: drives.on });
    const kernel = K.createKernel({ bus, caps, contracts: C, now: clock.now, timers: clock.timers, log: { info() {}, warn() {}, error() {} } });
    const reports = [];
    bus.subscribe("report.**", (r) => reports.push(r));
    kernel.define(AGENT); kernel.start();
    await tick();
    assert.equal(kernel.get("road-truth").state, "running");
    return {
        bus, clock, reports, kernel,
        setRoute: (r) => { current = r; routes.emit(r); },
        nav: (on) => { drive = { driving: on, navigating: on }; drives.emit(drive); },
        fix: (east) => { pos = { ...at(east), speedMs: 10 }; fixes.emit(pos); },
        ask: async () => ({ ok: true, result: await bus.request("task.road-truth", {}, { timeoutMs: 1000 }) })   // as brain.delegate wraps it
    };
}

test("agent: the card follows the route, the log and the rider; navigation starts with one honest summary", async () => {
    const log = seeded();
    const w = await boot(log);
    assert.equal(w.bus.last("state.truth").hasRoute, false);
    w.setRoute({ path: ROUTE });
    let st = w.bus.last("state.truth");
    assert.equal(st.hasRoute, true);
    assert.equal(st.card.rows.length, 3);
    assert.deepEqual(st.sources, { community: false }, "no sync: says it's this phone's sensors only");
    // a new jolt on the route shows up within the 5 s debounce
    log.add(ob(4000, { t: w.clock.now() }));
    assert.equal(w.bus.last("state.truth").card.rows.length, 3);
    w.clock.advance(5000);
    assert.equal(w.bus.last("state.truth").card.rows.length, 4);
    // navigation starts: one advice with the confirmed count; then the rows count from the rider
    w.nav(true);
    const ann = w.reports.filter((r) => r.kind === "road.route-truth");
    assert.equal(ann.length, 1);
    assert.equal(ann[0].severity, "advice");
    assert.equal(ann[0].data.verified, 2);
    w.fix(1500);
    st = w.bus.last("state.truth");
    assert.equal(st.navigating, true);
    assert.deepEqual(st.card.rows.map((r) => r.aheadM), [1500, 2500, 3000], "the pothole at 1.2 km is behind");
    w.nav(false); w.nav(true);
    assert.equal(w.reports.filter((r) => r.kind === "road.route-truth").length, 1, "once per route");
    // a route with nothing confirmed: no announcement (the card says "unknown")
    const quiet = await boot(RS.createLog(), { route: { path: ROUTE } });
    quiet.nav(true);
    assert.equal(quiet.reports.filter((r) => r.kind === "road.route-truth").length, 0);
    assert.equal(quiet.bus.last("state.truth").card.unknown, true);
});

test("agent: 'aage sadak kaisi hai?' — ahead on the route, around the rider without one, unknown without a position", async () => {
    const w = await boot(seeded(), { route: { path: ROUTE } });
    w.nav(true); w.fix(1500);
    let r = await w.ask();
    assert.equal(r.ok, true);
    assert.equal(r.result.kind, "road.truth");
    assert.equal(r.result.data.scope, "ahead");
    assert.equal(r.result.data.distanceM, 3000, "the first CONFIRMED one ahead: the rough road at 4.5 km (the report at 3 km is unconfirmed)");
    const near = await boot(seeded(), { here: at(1100) });
    r = await near.ask();
    assert.equal(r.result.data.scope, "near");
    assert.equal(r.result.kind, "road.truth");
    const lost = await boot(seeded());
    r = await lost.ask();
    assert.equal(r.result.kind, "road.truth-unknown");
});

test("the card on screen: hidden without a route, 'Condition unknown' with no evidence, rows with evidence, and where the data came from", () => {
    const now = T0 + 4 * H;
    assert.deepEqual(CARD.viewModel(null, now), { hidden: true });
    assert.deepEqual(CARD.viewModel({ hasRoute: false }, now), { hidden: true });
    const card = TR.buildTruth({ log: seeded(), path: ROUTE, now });
    const vm = CARD.viewModel({ hasRoute: true, navigating: false, card, sources: { community: true, lastFetch: now - 5 * MIN } }, now);
    assert.deepEqual(vm.pill, { text: "2 confirmed", tone: "warn" });
    assert.equal(vm.summary, "2 confirmed, 1 unconfirmed on this route: 1 bump or pothole, 1 rough road.");
    assert.deepEqual(vm.rows.map((r) => [r.distance, r.title, r.badge]), [["1.2 km", "Bump", "Confirmed"], ["3.0 km", "Bump", "Unconfirmed"], ["4.5 km", "Rough road", "Confirmed"]]);
    assert.equal(vm.rows[0].evidence, `You + 2 riders · motion sensor · 1 hour ago · ${Math.round(card.rows[0].confidence * 100)}%`);
    assert.match(vm.rows[0].until, /^until \d{1,2} [A-Z][a-z]{2}$/);
    assert.equal(vm.source, "This phone's sensors and other riders' reports, updated 5 min ago.");
    assert.equal(vm.note, "No report doesn't mean the road is clear.");
    // navigating: compact, distances from the rider
    const nav = CARD.viewModel({ hasRoute: true, navigating: true, card: TR.buildTruth({ log: seeded(), path: ROUTE, now, fromM: 1000 }), sources: { community: false } }, now);
    assert.equal(nav.rows.length, 2);
    assert.equal(nav.more, 1);
    assert.equal(nav.rows[0].distance, "200 m");
    assert.match(nav.summary, /on the road ahead/);
    assert.equal(nav.source, "This phone's sensors and other riders' reports saved earlier. Community road reports are off, so they won't update.", "never 'own sensors only' over other riders' rows");
    const mine = RS.createLog(); mine.addAll([ob(800), ob(800, { t: T0 + 5 * MIN })]);
    assert.match(CARD.viewModel({ hasRoute: true, card: TR.buildTruth({ log: mine, path: ROUTE, now }), sources: { community: false } }, now).source, /^From this phone's own sensors only/);
    // nothing known
    const none = CARD.viewModel({ hasRoute: true, card: TR.buildTruth({ log: RS.createLog(), path: ROUTE, now }), sources: { community: true, lastFetch: now - 2 * H, offline: true } }, now);
    assert.deepEqual(none.pill, { text: "Condition unknown", tone: "unknown" });
    assert.equal(none.summary, "No sensor or rider reports on this route. Condition unknown: ride with care.");
    assert.equal(none.source, "This phone's sensors and other riders' reports, updated 2 h ago (saved copy, no signal).");
    assert.deepEqual(none.rows, []);
});

test("sensors verify, language models talk: the truth path never calls a model or the network", () => {
    for (const f of ["public/js/master/roadsense/truth.js", "public/js/master/agents/truth-agent.js", "public/js/master/roadsense/truth-card.js"]) {
        const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        assert.doesNotMatch(src, /master-api|deep-search|\/search|\bfetch\(|\.ask\(/, f);
    }
    // the model's only part is routing a question to the solver: road_ahead is an action, with no fields
    assert.deepEqual(require("../../lib/master/search.js").ACTIONS.road_ahead, {});
    assert.match(require("../../lib/master/search.js").SYSTEM, /never describe potholes, water or the surface yourself, use this action/);
});

test("wiring: scripts in order, styles, offline precache, the DOM event, type-checked", () => {
    const html = read("public/index.html");
    const pos = (s) => html.indexOf(`<script src="${s}`);
    assert.ok(pos("js/master/roadsense/truth.js") > 0 && pos("js/master/roadsense/truth.js") < pos("js/master/agents/dynamics-agent.js"), "truth.js before the dynamics agent (it words the evidence)");
    assert.ok(pos("js/master/agents/truth-agent.js") < pos("js/master/master-app.js"));
    assert.ok(pos("js/master/master-app.js") < pos("js/master/roadsense/truth-card.js"));
    assert.match(html, /<link rel="stylesheet" href="js\/master\/roadsense\/roadsense\.css/);
    assert.match(html, /<script src="https:\/\/maps\.googleapis\.com\/maps\/api\/js\?key=[^"]+&libraries=places&loading=async"><\/script>/);
    const sw = read("public/sw.js");
    for (const f of ["roadsense/truth.js", "roadsense/truth-card.js", "roadsense/roadsense.css", "agents/truth-agent.js"]) assert.ok(sw.includes(`"/js/master/${f}"`), f);
    const app = read("public/js/master/master-app.js");
    assert.match(app, /toDom\("state\.truth", "mu:master-truth"\)/);
    assert.match(app, /async roadTruth\(\)/);
    const ts = JSON.parse(read("tsconfig.master.json")).files;
    for (const f of ["roadsense/truth.js", "roadsense/truth-card.js", "agents/truth-agent.js"]) assert.ok(ts.includes(`public/js/master/${f}`), f);
});
