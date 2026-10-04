// Ride summaries' screens (js/rides/ride-model.js, rides-ui.js, consent-ui.js), wired to
// the ride log and fleet share of js/rides/ride-log.js (roadmap Step 10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../../public/js/rides/ride-model.js");
const UI = require("../../public/js/rides/rides-ui.js");
const CU = require("../../public/js/rides/consent-ui.js");
const RL = require("../../public/js/rides/ride-log.js");
const U = require("../../public/js/garage/units.js");

const NOW = new Date(2026, 9, 4, 9, 30).getTime();
const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };
/** A tank as FuelCurve.fleetTanks() makes it (and POST /api/bikes/fillups takes it). */
const tank = () => {
    const hist = new Array(40).fill(0);
    hist[5] = 74.2; hist[10] = 193.8; hist[13] = 119.6; hist[17] = 24.7;
    return { bundle: "0123456789abcdef", bike: "royal-enfield-hunter-350-metro-in", fuelCode: "E20", massKg: 80, litres: 11.45, km: 412.3, idleH: 0.717, hist };
};

test("ride model: SmartDrive's trip → a record; the HUD's totals make it richer; nothing absurd", () => {
    const pts = []; for (let i = 0; i < 600; i++) pts.push({ ts: NOW + i * 5000, lat: 18.81 + i * 0.0001, lng: 82.71 + Math.sin(i / 20) * 0.001, speedKmh: 40 });
    const d = { startedAt: NOW, endedAt: NOW + 3000 * 1000, totalDistKm: 7.2, avgSpeed: 36, maxSpeed: 62, fuelUsedL: 0.21, idleMin: 4, points: pts, place: "Koraput" };
    const r = M.fromTripEnd(d);
    assert.equal(r.id, `ride-${NOW}`); assert.equal(r.distance, 7200); assert.equal(r.duration, 3000); assert.equal(r.idleTime, 240);
    assert.ok(Math.abs(r.fuel - 0.00021) < 1e-12); assert.ok(Math.abs(r.maxSpeed - 62 / 3.6) < 1e-9);
    assert.ok(r.route.length <= M.MAX_ROUTE && r.route.length >= 10);
    assert.equal(r.source, "smartdrive");
    const live = { distance: 7350, time: 3000, moving: 2700, energy: 0.000198, perMetre: 2.7e-8, cost: 19.5, ecoScore: 0.82, harsh: { accel: 1, brake: 2 }, maxSpeed: 17.5, idleTime: 300 };
    const m = M.merge(r, { trip: d, live, powertrain: "ice", correction: 1.12, bike: "Hunter 350", priceUnit: "₹ 105/L" });
    assert.deepEqual([m.distance, m.moving, m.ecoScore, m.harsh, m.cost, m.bike, m.source, m.matched], [7350, 2700, 0.82, 3, 19.5, "Hunter 350", "hud", true]);
    assert.ok(Math.abs(m.avgSpeed - 7350 / 2700) < 1e-9);
    const e = M.economy(m);
    assert.equal(e.unit, "km/L"); assert.ok(Math.abs(e.value - 7.35 / 0.198) < 1e-9);
    const ev = M.merge(r, { trip: d, live: { ...live, energy: 3.6e6 }, powertrain: "ev" });
    assert.equal(ev.fuel, null); assert.equal(M.economy(ev).unit, "Wh/km"); assert.ok(Math.abs(M.economy(ev).value - 1000 / 7.35) < 1e-9);
    assert.equal(M.rideName(new Date(2026, 9, 4, 7).getTime()), "Morning ride");
    assert.equal(M.rideName(new Date(2026, 9, 4, 22).getTime()), "Night ride");
});

test("ride model: rollups bucket by local day / month and total honestly", () => {
    const at = (dDays, h = 9) => new Date(2026, 9, 4 - dDays, h).getTime();
    const rec = (dDays, km, o = {}) => ({ id: `r${dDays}-${km}`, startedAt: at(dDays), distance: km * 1000, moving: km * 100, fuel: km / 40 / 1000, evEnergy: null, cost: km * 2.5, ecoScore: 0.8, harsh: 1, ...o });
    const recs = [rec(0, 10), rec(0, 6, { cost: null, ecoScore: null }), rec(3, 20, { ecoScore: 0.6 }), rec(12, 40), rec(70, 15)];
    const w = M.rollup(recs, "7d", NOW);
    assert.equal(w.buckets.length, 7); assert.equal(w.buckets[6].rides, 2); assert.equal(w.buckets[3].distance, 20000);
    assert.equal(w.totals.rides, 3); assert.equal(w.totals.distance, 36000);
    assert.equal(w.totals.cost, 75); assert.equal(w.totals.costRides, 2);                 // the unpriced ride isn't counted as ₹0
    assert.ok(Math.abs(w.totals.eco - (0.8 * 10 + 0.6 * 20) / 30) < 1e-9);               // distance-weighted, only scored rides
    assert.ok(Math.abs(w.totals.economy - 40) < 1e-9);
    assert.equal(M.rollup(recs, "30d", NOW).totals.rides, 4);
    const y = M.rollup(recs, "12m", NOW);
    assert.equal(y.buckets.length, 12); assert.equal(y.buckets[11].key, "2026-10"); assert.equal(y.totals.rides, 5);
    assert.equal(M.rollup(recs, "all", NOW).buckets.length, 4);                           // July … October
    assert.equal(M.rollup([], "all", NOW).totals.eco, null);
    const p = M.routePath([[18.8, 82.7], [18.81, 82.72], [18.79, 82.73]], 56, 42, 5);
    assert.match(p.d, /^M[\d.]+,[\d.]+L/); assert.equal(p.start.length, 2);
    for (const [x, yy] of [p.start, p.end]) assert.ok(x >= 5 - 1e-9 && x <= 51 + 1e-9 && yy >= 5 - 1e-9 && yy <= 37 + 1e-9);
    assert.equal(M.routePath([], 10, 10).d, "");
});

test("view helpers: tiles, durations, day groups, eco words, consent example in words", () => {
    const tl = UI.tiles({ rides: 3, distance: 36000, moving: 3600 + 25 * 60, fuel: 0.0009, evEnergy: 0, cost: 75, costRides: 2, eco: 0.733, economy: 40 }, U);
    assert.deepEqual(tl.map((t) => t.key), ["rides", "distance", "time", "fuel", "cost", "eco"]);
    assert.equal(tl[2].value, "1:25"); assert.equal(tl[2].unit, "h");
    assert.equal(tl[4].note, "2 of 3 rides priced");
    assert.equal(tl[5].value, "73"); assert.equal(tl[5].note, "Steady");
    assert.equal(UI.tiles({ rides: 1, distance: 5000, moving: 600, fuel: 0, evEnergy: 7.2e6, cost: null, costRides: 0, eco: null, economy: null }, U)[3].key, "energy");
    assert.deepEqual(UI.dur(59 * 60), { value: "59", unit: "min" });
    const g = UI.byDay([{ startedAt: NOW }, { startedAt: NOW - 3600e3 }, { startedAt: NOW - 86400e3 }, { startedAt: NOW - 5 * 86400e3 }], NOW);
    assert.deepEqual(g.map((x) => [x.label, x.rides.length]).slice(0, 2), [["Today", 2], ["Yesterday", 1]]);
    assert.equal(g.length, 3);
    assert.equal(UI.ecoWord(0.9), "Smooth"); assert.equal(UI.ecoWord(0.4), "Rough"); assert.equal(UI.ecoWord(null), "");
    const w = CU.tankInWords(tank(), U);
    assert.equal(w.line, "412 km on 11.45 L");
    assert.equal(w.bands, "18 % under 40 km/h · 47 % at 40–60 · 29 % at 60–80 · 6 % over 80");
    assert.equal(w.idle, "43 min idling · 80 kg on the bike · E20");
    assert.equal(w.month, undefined, "no dates leave the phone, so none are shown");
});

test("consent bookkeeping on the fleet share: ask once after the first usable tank, 'Not now' = 60 days, the exact payload shown", () => {
    let t = NOW;
    const store = memStorage();
    const share = RL.createFleetShare({ storage: store, fetch: null, apiBase: "https://mapunite.example", now: () => t });
    assert.equal(share.shouldAsk(0), false, "no usable tank yet");
    assert.equal(share.shouldAsk(1), true);
    share.markAsked();
    assert.equal(share.shouldAsk(2), false, "asked once already");
    share.decline();
    t += 59 * 86400000; assert.equal(share.shouldAsk(2), false);
    t += 2 * 86400000; assert.equal(share.shouldAsk(2), true, "60 days after 'Not now'");
    const p = share.preview([tank(), tank(), tank(), tank()]);
    assert.equal(p.request, "POST https://mapunite.example/api/bikes/fillups");
    assert.equal(p.authorization, null);
    assert.equal(p.body.consent, "fleet-calibration-v1");
    assert.equal(p.body.tanks.length, 3);
    assert.doesNotMatch(p.body.contributor, /^[0-9a-f]{32}$/, "never the real token");
    const st = share.status();
    assert.deepEqual([st.optedIn, st.sentTotal, st.queued, st.pendingDelete, st.since], [false, 0, 0, false, null]);
    share.optIn();
    assert.equal(share.shouldAsk(5), false, "already on");
    assert.equal(share.status().since, t);
    share.wipeLocal();
    assert.equal(store.getItem(RL.SHARE_KEY), null, "wipeLocal forgets everything (no erasure owed here)");
    assert.equal(RL.createFleetShare({ storage: memStorage(), fetch: null, apiBase: null }).shouldAsk(3), false, "no server: never asks");
});

test("ride records: the log's record is what the dashboard and share card read, and the HUD's totals merge into it", () => {
    const a = RL.createAccumulator(NOW);
    for (let i = 0; i <= 600; i++) RL.step(a, { t: i, v: 12, dt: i ? 1 : 0, distance: i ? 12 : 0 });
    const rec = RL.finish(a, { endedAt: NOW + 601000, fuelL: 0.2, fuelSource: "physics", bike: "Hunter 350", place: "Koraput", route: [[18.8, 82.7], [18.85, 82.75]] });
    assert.equal(rec.id, `ride-${NOW}`);
    assert.ok(Math.abs(M.economy(rec).value - 7.2 / 0.2) < 0.01, "km/L from the record");
    const r = M.rollup([rec], "7d", NOW + 601000);
    assert.equal(r.totals.rides, 1);
    assert.ok(M.routePath(rec.route, 56, 42, 5).d.startsWith("M"));
    const merged = M.merge(rec, { trip: { startedAt: NOW }, live: { distance: 7300, moving: 600, energy: 0.00019, ecoScore: 0.8, harsh: { accel: 1, brake: 1 }, cost: 20 }, powertrain: "ice", correction: 1, bike: "Hunter 350" });
    assert.deepEqual([merged.source, merged.distance, merged.ecoScore, merged.harsh, merged.cost], ["hud", 7300, 0.8, 2, 20]);
    assert.ok(merged.bands && merged.coasting && merged.hist, "the log's own fields survive the merge");
});
