// Step 11: the post-ride share card — what goes on it (honest savings, privacy) and where it's drawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const U = require("../../public/js/garage/units.js");
const M = require("../../public/js/share/card-model.js");
const R = require("../../public/js/share/card-render.js");
const S = require("../../public/js/share/share-ui.js");

/** A track heading east then north-east, ~1 point per 50 m. */
function track(km, lat0 = 28.5, lng0 = 77.1) {
    const pts = [], k = 1 / (111320 * Math.cos((lat0 * Math.PI) / 180));
    for (let d = 0; d <= km * 1000; d += 50) pts.push({ lat: lat0 + (d > km * 500 ? (d - km * 500) / 111320 : 0), lng: lng0 + Math.min(d, km * 500) * k, ts: d, speedKmh: 40 });
    return pts;
}
const live = (o = {}) => ({ distance: 20000, energy: 0.0005, moving: 1800, time: 2000, maxSpeed: 22, ecoScore: 0.84, harsh: { accel: 1, brake: 0 }, cost: 50, ...o });

test("privacy: the first and last 400 m are cut; a ride too short to hide them shows no route", () => {
    const pts = track(5);
    const cut = M.trimEnds(pts, 400);
    assert.ok(cut.length < pts.length - 14 && cut.length > 50);
    assert.ok(Math.abs(cut[0].lng - pts[0].lng) * 111320 * Math.cos(28.5 * Math.PI / 180) >= 399);
    assert.deepEqual(M.trimEnds(track(0.8), 400), []);
    const card = M.buildCard({ trip: { startedAt: Date.UTC(2026, 9, 4, 13), points: track(0.8) }, live: live() });
    assert.equal(card.route, null);
});

test("route projection: unit box, north up, simplified, aspect kept", () => {
    const p = M.project(track(10), 50);
    assert.ok(p.pts.length <= 50 && p.pts.length >= 3);
    for (const [x, y] of p.pts) { assert.ok(x >= -1e-9 && x <= 1 + 1e-9 && y >= -1e-9 && y <= 1 + 1e-9); }
    assert.ok(Math.max(...p.pts.map((q) => q[0])) > 0.999 || Math.max(...p.pts.map((q) => q[1])) > 0.999);
    assert.ok(Math.abs(p.aspect - 1) < 0.05, `east 5 km then north 5 km → square-ish: ${p.aspect}`);
    assert.ok(p.pts[p.pts.length - 1][1] < p.pts[0][1], "north is up (smaller y)");
    assert.equal(M.project([{ lat: 1, lng: 1 }, { lat: 1, lng: 1.00001 }]), null);
});

test("savings are claimed only against real tanks, only when real, never for an EV", () => {
    const base = { trip: { startedAt: Date.UTC(2026, 9, 4, 2), points: track(20) }, live: live() };
    assert.equal(M.buildCard(base).saved, null, "no tanks → no claim");
    const usual = { perMetre: 0.0005 / 20000 * 1.2, tanks: 5 };          // usual is 20 % thirstier
    const c = M.buildCard({ ...base, usual });
    assert.ok(Math.abs(c.saved.share - (1 - 1 / 1.2)) < 1e-9);
    assert.ok(Math.abs(c.saved.energy - 0.0001) < 1e-12);
    assert.ok(Math.abs(c.saved.cost - 10) < 1e-9);
    assert.equal(M.buildCard({ ...base, usual: { perMetre: 0.0005 / 20000 * 1.02, tanks: 5 } }).saved, null, "2 % isn't a claim");
    assert.equal(M.buildCard({ ...base, usual: { perMetre: 0.0005 / 20000 * 0.9, tanks: 5 } }).saved, null, "worse than usual → no claim");
    assert.equal(M.buildCard({ ...base, powertrain: "ev", usual }).saved, null);
    assert.equal(M.buildCard({ ...base, live: live({ distance: 1500 }), usual }).saved, null, "too short to claim");
});

test("card basics: title by hour, eco word, fallbacks when the HUD wasn't running", () => {
    const at = (h) => new Date(2026, 9, 4, h).getTime();
    assert.equal(M.rideTitle(at(7)), "Morning ride");
    assert.equal(M.rideTitle(at(13)), "Afternoon ride");
    assert.equal(M.rideTitle(at(18)), "Evening ride");
    assert.equal(M.rideTitle(at(23)), "Night ride");
    assert.equal(M.ecoWord(0.93), "Featherlight");
    assert.equal(M.ecoWord(0.5), "Room to save");
    const c = M.buildCard({ trip: { startedAt: at(9), endedAt: at(10), totalDistKm: 30, fuelUsedL: 0.8, maxSpeed: 72, points: track(30) }, bike: "Hunter 350" });
    assert.equal(c.estimated, true);
    assert.equal(c.distance, 30000);
    assert.ok(Math.abs(c.energy - 0.0008) < 1e-15);
    assert.ok(Math.abs(c.maxSpeed - 20) < 1e-12);
    assert.equal(c.ecoScore, null);
    assert.equal(c.matched, false);
    assert.equal(M.buildCard({ trip: { startedAt: at(9), points: [] }, live: live(), correction: 1.18 }).matched, true);
});

test("usual consumption comes from usable full tanks only", () => {
    const FC = { fit: { intervals: [{ usable: true, km: 300, litresAdj: 8 }, { usable: true, km: 280, litres: 7.5 }, { usable: false, km: 30, litres: 9 }] } };
    const u = M.usualFromLearner(FC);
    assert.ok(Math.abs(u.perMetre - 15.5 / 1000 / 580000) < 1e-18);
    assert.equal(u.tanks, 2);
    assert.equal(M.usualFromLearner({ fit: { intervals: [] } }), null);
    assert.equal(M.usualFromLearner(null), null);
});

test("layout: every block sits inside the canvas, in order, for Story and Post", () => {
    for (const f of ["story", "post"]) {
        const L = R.layout(f);
        assert.equal(L.w, 1080);
        assert.equal(L.h, f === "story" ? 1920 : 1350);
        assert.ok(L.header < L.title && L.title < L.sub && L.sub < L.box.y);
        assert.ok(L.box.y + L.box.h < L.grid.y && L.box.y + L.box.h < L.ring.cy - L.ring.r);
        assert.ok(L.grid.y + 2 * L.grid.rowH <= L.banner.y + 4);
        assert.ok(L.banner.y + L.banner.h < L.foot && L.foot < L.h);
        assert.ok(L.ring.cx + L.ring.r < L.grid.x);
        // the eco word under the ring (baseline ring.word below the ring) clears the banner
        assert.ok(L.ring.cy + L.ring.r + L.ring.word + 8 < L.banner.y, `${f}: eco word overlaps the banner`);
        assert.ok(L.ring.cy + L.ring.r + L.ring.stroke / 2 < L.ring.cy + L.ring.r + L.ring.word - 0.8 * L.ring.r * 0.27, `${f}: eco word overlaps the ring`);
    }
    const pts = M.project(track(12)).pts;
    const box = { x: 84, y: 380, w: 912, h: 820 };
    for (const [x, y] of R.fitRoute(pts, box, 70)) { assert.ok(x >= box.x + 69 && x <= box.x + box.w - 69 && y >= box.y + 69 && y <= box.y + box.h - 69); }
});

test("stats and banner words", () => {
    const c = M.buildCard({ trip: { startedAt: Date.UTC(2026, 9, 4, 2), points: [] }, live: live({ moving: 72 * 60 }), usual: { perMetre: 0.0005 / 20000 * 1.25, tanks: 4 } });
    const st = R.stats(c, U, true);
    assert.deepEqual(st.map((x) => x.label), ["Distance", "Mileage", "Cost", "Moving time"]);
    assert.equal(st[0].value, "20.0");
    assert.equal(st[1].value, "40.0"); assert.equal(st[1].unit, "km/L");
    assert.equal(st[2].value, "₹50.0");
    assert.equal(st[3].value, "1:12"); assert.equal(st[3].unit, "h");
    assert.equal(R.stats(c, U, false)[2].label, "Fuel");
    const b = R.bannerText(c, U, true);
    assert.equal(b.tone, "good"); assert.match(b.title, /^Saved ₹\d/); assert.match(b.sub, /average over 4 full tanks \(−20 %\)/);
    assert.match(b.sub, /^\d[\d.,]* L less fuel/);
    // a tiny saving reads in mL, never "0.00 L"
    const tiny = R.bannerText({ ...c, saved: { ...c.saved, energy: 4e-6 } }, U, false);
    assert.match(tiny.sub, /^4 mL less fuel/); assert.match(tiny.title, /^4 mL less than usual$/);
    const n = R.bannerText(M.buildCard({ trip: { startedAt: 0, points: [] }, live: live({ harsh: { accel: 0, brake: 0 } }) }), U, true);
    assert.equal(n.title, "Smooth all the way");
});

test("share sheet helpers: file name and remembered choices", () => {
    assert.equal(S.fileName({ title: "Evening ride", startedAt: new Date(2026, 9, 4, 18).getTime() }), "mapunite-evening-ride-2026-10-04.png");
    const st = { v: JSON.stringify({ format: "square", privacy: false, showCost: "yes", auto: false }), getItem() { return this.v; } };
    assert.deepEqual(S.loadPrefs(/** @type {any} */ (st)), { format: "story", privacy: false, showCost: true, auto: false });
});
