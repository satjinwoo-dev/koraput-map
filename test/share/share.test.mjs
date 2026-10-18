// Step 11: the post-ride share card — what goes on it (honest savings, privacy) and where it's drawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";

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
    // top speed is never on a card
    for (const b of [n, R.bannerText(M.buildCard({ trip: { startedAt: 0, points: [] }, live: live({}) }), U, true)]) assert.ok(!/top speed/i.test(b.title + b.sub), b.sub);
});

test("recap: caption, the town only when asked, report counts (never 'confirmed'), templates", () => {
    const sum = { trip: { startedAt: 0, points: [], place: "Koraput" }, live: live({}), reports: { reviewed: 3, published: 2 } };
    const off = M.buildCard(sum, { caption: "  Ghat\nride  " });
    assert.equal(off.place, "", "the town is hidden by default");
    assert.equal(off.caption, "Ghat ride");
    assert.equal(M.buildCard(sum, { showPlace: true }).place, "Koraput");
    assert.equal(M.buildCard(sum, { caption: "x".repeat(200) }).caption.length, 80);
    assert.deepEqual(off.reports, { reviewed: 3, published: 2 });
    assert.equal(M.buildCard({ ...sum, reports: { reviewed: 0, published: 0 } }).reports, null);
    const foot = R.footText(off);
    assert.match(foot, /3 road reports reviewed, 2 published/);
    assert.ok(!/confirm/i.test(foot));
    assert.deepEqual(R.TEMPLATES, ["lens", "gauge", "poster", "bento", "glass", "verse", "minimal"]);
    // the photo fills the card (cover), centred
    assert.deepEqual(R.cover(4000, 3000, 1080, 1920), { x: -740, y: 0, w: 2560, h: 1920 });
    assert.deepEqual(R.cover(1000, 4000, 1080, 1350), { x: 0, y: -1485, w: 1080, h: 4320 });
});

test("share sheet helpers: file name and remembered choices", () => {
    assert.equal(S.fileName({ title: "Evening ride", startedAt: new Date(2026, 9, 4, 18).getTime() }), "mapunite-evening-ride-2026-10-04.png");
    const st = { v: JSON.stringify({ format: "square", privacy: false, showCost: "yes", auto: false }), getItem() { return this.v; } };
    assert.deepEqual(S.loadPrefs(/** @type {any} */ (st)), { format: "story", template: "lens", privacy: false, trimStart: 400, trimEnd: 400, map: true, showPlace: false, showCost: true, auto: false });
    // the rider's own start / finish choice, kept in 100 m steps within 0–3 km
    assert.deepEqual((({ trimStart, trimEnd }) => ({ trimStart, trimEnd }))(S.loadPrefs(/** @type {any} */ ({ getItem: () => JSON.stringify({ trimStart: 1234, trimEnd: -50 }) }))), { trimStart: 1200, trimEnd: 0 });
    // the town name is off unless the rider turned it on; a bad template falls back to classic
    const st2 = { v: JSON.stringify({ template: "photo", showPlace: true }), getItem() { return this.v; } };
    assert.equal(S.loadPrefs(/** @type {any} */ (st2)).template, "glass", "the old Photo template is now Glass");
    assert.equal(S.loadPrefs(/** @type {any} */ ({ getItem: () => JSON.stringify({ template: "classic" }) })).template, "bento");
    assert.equal(S.loadPrefs(/** @type {any} */ ({ getItem: () => JSON.stringify({ template: "verse" }) })).template, "verse");
    assert.equal(S.loadPrefs(/** @type {any} */ (st2)).showPlace, true);
    assert.equal(S.loadPrefs(/** @type {any} */ ({ getItem: () => JSON.stringify({ template: "neon" }) })).template, "lens");
});

test("modern styles: bento tiles stay inside the card and never overlap; seeded glitches; posterise and channel split", async () => {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const ST = req("../../public/js/share/card-styles.js");
    assert.deepEqual(ST.STYLES, ["lens", "gauge", "poster", "bento", "glass", "verse", "minimal"]);
    for (const fmt of ["story", "post"]) {
        const L = ST.bentoLayout(fmt);
        const boxes = [L.hero, L.dist, L.time, L.eco, L.fuel, L.wide].filter(Boolean);
        for (const b of boxes) assert.ok(b.x >= L.m - 1 && b.y > L.caption && b.x + b.w <= L.W - L.m + 1 && b.y + b.h < L.foot - 20, `${fmt}: ${JSON.stringify(b)}`);
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${fmt}: tiles ${i} and ${j} overlap`);
        }
    }
    const a = ST.rng(42), b = ST.rng(42), c = ST.rng(43);
    const sa = [a(), a(), a()], sb = [b(), b(), b()];
    assert.deepEqual(sa, sb, "the same ride gives the same card");
    assert.notDeepEqual(sa, [c(), c(), c()]);
    assert.ok(sa.every((v) => v >= 0 && v < 1));
    const px = [10, 128, 250, 255, 200, 60, 128, 255];
    ST.posterize(px, 5, 1);
    assert.deepEqual(px, [0, 128, 255, 255, 191, 64, 128, 255]);
    // a 3×1 image: red comes from the right, blue from the left
    const img = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255];
    assert.deepEqual([...ST.splitChannels(img, 3, 1, 1)], [0, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255]);
    // no top speed in any style
    assert.ok(!/maxSpeed/.test(fs.readFileSync(new URL("../../public/js/share/card-styles.js", import.meta.url), "utf8")));
});

test("start and finish: the rider moves each end; the map gets the same trimmed points", async () => {
    const pts = track(40);                                     // the test file's straight track helper
    const both = M.buildCard({ trip: { startedAt: 0, points: pts }, live: live({}) }, { trimStart: 0, trimEnd: 0 });
    const startOnly = M.buildCard({ trip: { startedAt: 0, points: pts }, live: live({}) }, { trimStart: 1000, trimEnd: 0 });
    assert.equal(both.privacy, false, "0 m at both ends: the exact start and finish (the rider's choice)");
    assert.ok(startOnly.privacy);
    assert.deepEqual(startOnly.trim, { start: 1000, end: 0 });
    assert.deepEqual(startOnly.routeGeo.at(-1), { lat: pts.at(-1).lat, lng: pts.at(-1).lng }, "finish kept");
    assert.notDeepEqual(startOnly.routeGeo[0], { lat: pts[0].lat, lng: pts[0].lng }, "start moved");
    assert.ok(both.routeGeo.length <= 400);
    const def = M.buildCard({ trip: { startedAt: 0, points: pts }, live: live({}) });
    assert.deepEqual(def.trim, { start: 400, end: 400 }, "400 m each by default");
    assert.deepEqual(M.trimEnds(pts, 0, 0).length, pts.length);
    assert.equal(M.thin([1, 2, 3, 4, 5], 3).join(), "1,3,5");
});

test("map behind the route: Web Mercator, the zoom that fits, the tiles that cover it; motion counts up", async () => {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const B = req("../../public/js/share/basemap.js"), ST = req("../../public/js/share/card-styles.js");
    const [x0, y0] = B.mercator(0, 0, 0);
    assert.deepEqual([x0, y0], [128, 128]);
    const [x1] = B.mercator(0, 180, 1);
    assert.equal(x1, 512);
    const geo = [{ lat: 18.80, lng: 82.70 }, { lat: 18.84, lng: 82.74 }];
    const f = B.fitZoom(geo, 968, 760, 80);
    const xs = f.pts.map((p) => p[0]), ys = f.pts.map((p) => p[1]);
    assert.ok(Math.min(...xs) >= 80 - 1 && Math.max(...xs) <= 968 - 80 + 1 && Math.min(...ys) >= 80 - 1 && Math.max(...ys) <= 760 - 80 + 1, "inside the box");
    assert.ok(Math.max(...xs) - Math.min(...xs) > (968 - 160) / 2.1 || Math.max(...ys) - Math.min(...ys) > (760 - 160) / 2.1, "and as large as it can be");
    // between whole zooms: scaled up (1–2×) to fill the box, and every point still lands on its own spot of the tiles
    const v = B.scaled(f, 968, 760, 80);
    assert.ok(v.s >= 1 && v.s <= 2);
    const vx = v.pts.map((p) => p[0]), vy = v.pts.map((p) => p[1]);
    assert.ok(Math.abs(Math.max(...vx) - Math.min(...vx) - (968 - 160)) < 1 || Math.abs(Math.max(...vy) - Math.min(...vy) - (760 - 160)) < 1, "fills the box on one side");
    geo.forEach((g, i) => { const [wx, wy] = B.mercator(g.lat, g.lng, f.z); assert.ok(Math.abs(v.ox + v.pts[i][0] / v.s - wx) < 1e-6 && Math.abs(v.oy + v.pts[i][1] / v.s - wy) < 1e-6); });
    const tiles = B.tilesFor(f.z, f.ox, f.oy, 968, 760);
    assert.ok(tiles.length >= 12 && tiles.length <= 30);
    for (const t of tiles) assert.ok(t.dx > -256 && t.dx < 968 && t.dy > -256 && t.dy < 760);
    assert.match(B.THEMES.dark, /^https:\/\/\{s\}\.basemaps\.cartocdn\.com\//, "the provider the Dark style already uses");
    assert.match(B.ATTRIBUTION, /OpenStreetMap contributors © CARTO/);
    // which map each style wants
    assert.deepEqual(ST.mapSpec("bento", "story", false), { w: 968, h: 760, inset: 80, theme: "dark" });
    assert.equal(ST.mapSpec("glass", "story", true), null, "a photo replaces the map");
    const gl = ST.mapSpec("glass", "story", false);
    assert.ok(gl.focus.y >= 170 && gl.focus.y + gl.focus.h <= 1920 - 720 - 56, "the route sits above the glass panel");
    assert.equal(ST.mapSpec("minimal", "story", false), null);
    // motion: 0 → nothing counted yet, 1 → the card itself
    const c = { distance: 18400, moving: 2950, energy: 5e-4, cost: 54, ecoScore: 0.81, reports: { reviewed: 5, published: 3 } };
    assert.equal(ST.motionCard(c, 0).distance, 0);
    assert.equal(ST.motionCard(c, 1), c);
    const mid = ST.motionCard(c, 0.5);
    assert.ok(mid.distance > 0 && mid.distance < c.distance && mid.reports.published <= 3);
    assert.ok(ST.phase(0.95, 0.2, 0.3) === 1 && ST.phase(0, 0.2, 0.3) === 0);
});

test("liquid glass: the rounded-rect distance and normals, refraction strongest at the rim, seeded ribbon, poster word, speed shape", async () => {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const LQ = req("../../public/js/share/card-liquid.js");
    assert.deepEqual(LQ.STYLES, ["lens", "gauge", "poster"]);
    // a 200 × 100 box, radius 20: centre is 50 px inside; the right edge is the surface; a corner normal points diagonally
    const c = LQ.sdfRoundRect(0, 0, 100, 50, 20);
    assert.equal(c.d, -50);
    assert.ok(Math.abs(LQ.sdfRoundRect(100, 0, 100, 50, 20).d) < 1e-9);
    assert.ok(LQ.sdfRoundRect(110, 0, 100, 50, 20).d > 0);
    assert.deepEqual([LQ.sdfRoundRect(90, 0, 100, 50, 20).nx, LQ.sdfRoundRect(90, 0, 100, 50, 20).ny], [1, 0]);
    const corner = LQ.sdfRoundRect(95, 45, 100, 50, 20);
    assert.ok(corner.nx > 0.5 && corner.ny > 0.5, "corner normal is diagonal");
    // refraction: the bend is strongest at the rim and zero deep inside; inside, the view is magnified toward the centre
    const o = { band: 80, strength: 50, mag: 0.06 };
    const rim = LQ.refractSample(100, 0, 0, 1, 0, o), deep = LQ.refractSample(10, 0, 200, 1, 0, o);
    assert.equal(rim.k, 50);
    assert.equal(deep.k, 0);
    assert.ok(Math.abs(deep.x - 10 * 0.94) < 1e-9);
    assert.ok(LQ.refractSample(100, 0, 40, 1, 0, o).k < rim.k);
    // the ribbon art is the same for the same ride
    assert.deepEqual(LQ.ribbonPaths(42, 1080, 1920), LQ.ribbonPaths(42, 1080, 1920));
    assert.notDeepEqual(LQ.ribbonPaths(42, 1080, 1920), LQ.ribbonPaths(43, 1080, 1920));
    assert.equal(LQ.posterWord({ title: "Morning ride" }), "MORNING");
    assert.equal(LQ.posterWord({ title: "" }), "RIDE");
    // the speed shape: relative 0–1 values, never figures
    const sp = M.speedShape(Array.from({ length: 100 }, (_, i) => ({ speedKmh: 20 + (i % 10) })));
    assert.equal(sp.length, 48);
    assert.ok(sp.every((v) => v >= 0 && v <= 1) && Math.max(...sp) === 1);
    assert.equal(M.speedShape([{ speedKmh: 10 }]), null);
    assert.ok(!/maxSpeed/.test(fs.readFileSync(new URL("../../public/js/share/card-liquid.js", import.meta.url), "utf8")), "no top speed");
});
