// Navigation motion (public/js/navcam/navmotion-core.js): the rider's arrow held to the road and gliding along it
// between fixes, never sliding back for GPS shimmer, following the fixes off the road; the route cut at the arrow;
// zoom closer near a turn; the arrow drawn on the road through a turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../../public/js/navcam/navmotion-core.js");
const N = require("../../public/js/navcam/navcam-core.js");

const DEG = 1 / 111195;                       // ≈ degrees of latitude per metre
// 1 km north, then 1 km east (a right turn at the corner)
const line = [];
for (let i = 0; i <= 10; i++) line.push([18.8 + i * 100 * DEG, 82.7]);
const kx = 1 / (111195 * Math.cos(18.8 * Math.PI / 180) * Math.cos(0));
for (let i = 1; i <= 10; i++) line.push([18.8 + 1000 * DEG, 82.7 + i * 100 * DEG / Math.cos((18.8 + 1000 * DEG) * Math.PI / 180)]);
const ix = M.index(line);

test("the route with distances; the nearest point on it, searched near the last one first", () => {
    assert.ok(Math.abs(ix.length - 2000) < 5, `${ix.length}`);
    // 12 m east of the road at 500 m
    const p = M.project(ix, 18.8 + 500 * DEG, 82.7 + 12 * kx);
    assert.ok(Math.abs(p.s - 500) < 2 && Math.abs(p.offM - 12) < 1);
    const q = M.project(ix, 18.8 + 500 * DEG, 82.7, 15);           // a far-off hint still finds it
    assert.ok(Math.abs(q.s - 500) < 2);
    const a = M.pointAt(ix, 1500);
    assert.ok(Math.abs(a.lat - (18.8 + 1000 * DEG)) < 1e-6);
    assert.ok(Math.abs(M.bearingAt(ix, 300) - 0) < 1, "north on the first leg");
    assert.ok(Math.abs(M.bearingAt(ix, 1500) - 90) < 1, "east on the second");
    const sl = M.slice(ix, 950, 1050);
    assert.equal(sl.length, 3, "the corner vertex inside");
});

test("on the route: the arrow glides between fixes at the rider's speed, catches up smoothly, never slides back", () => {
    const m = M.createMotion(ix);
    m.fix({ lat: 18.8 + 100 * DEG, lng: 82.7 + 5 * kx, speedMs: 10, t: 0 });
    assert.equal(m.mode, "snap");
    let d = m.frame(0);
    assert.ok(Math.abs(d.s - 100) < 1 && d.onRoute);
    assert.ok(Math.abs(d.lng - 82.7) < 1e-9, "held to the road, not the fix 5 m off it");
    // frames over the next second: it moves on at ~10 m/s without a new fix
    for (let t = 16; t <= 1000; t += 16) d = m.frame(t);
    assert.ok(d.s > 105 && d.s < 111, `${d.s}`);
    // a fix slightly BEHIND (shimmer): no sliding back
    const before = d.s;
    m.fix({ lat: 18.8 + 104 * DEG, lng: 82.7, speedMs: 10, t: 1000 });
    d = m.frame(1016);
    assert.ok(d.s >= before - 1e-9);
    // it stops gliding 2 s after the last fix
    for (let t = 1032; t <= 6000; t += 16) d = m.frame(t);
    assert.ok(d.s < 104 + 10 * 2 + 1, `${d.s}`);
    // a real jump back (40 m+): taken
    m.fix({ lat: 18.8 + 50 * DEG, lng: 82.7, speedMs: 0, t: 6000 });
    assert.ok(Math.abs(m.frame(6016).s - 50) < 1);
});

test("round the corner the arrow turns with the road", () => {
    const m = M.createMotion(ix);
    m.fix({ lat: 18.8 + 990 * DEG, lng: 82.7, speedMs: 10, t: 0 });
    m.frame(0);
    const b0 = m.frame(16).bearing;
    for (let t = 32; t <= 3000; t += 16) m.frame(t);
    m.fix({ lat: 18.8 + 1000 * DEG, lng: 82.7 + 40 * kx, speedMs: 10, t: 3000 });
    let d; for (let t = 3016; t <= 3600; t += 16) d = m.frame(t);
    assert.ok(b0 < 60, `before the corner ${b0}`);
    assert.ok(Math.abs(d.bearing - 90) < 5, `after it ${d.bearing}`);
});

test("off the route: the arrow glides to each fix; back on, it joins the road where it is", () => {
    const m = M.createMotion(ix);
    m.fix({ lat: 18.8 + 200 * DEG, lng: 82.7, speedMs: 8, t: 0 });
    m.frame(0);
    m.fix({ lat: 18.8 + 210 * DEG, lng: 82.7 + 80 * kx, speedMs: 8, t: 1000 });
    assert.equal(m.mode, "free");
    const half = m.frame(1500), end = m.frame(2100);
    assert.ok(half.lng > 82.7 && half.lng < 82.7 + 80 * kx && !half.onRoute);
    assert.ok(Math.abs(end.lng - (82.7 + 80 * kx)) < 1e-7);
    m.fix({ lat: 18.8 + 300 * DEG, lng: 82.7 + 3 * kx, speedMs: 8, t: 3000 });
    assert.equal(m.mode, "snap");
    // a new route keeps the arrow where it is
    m.setRoute(M.index(line.slice(0, 11)));
    assert.equal(m.mode, "snap");
});

test("zoom: by speed, closer in near a turn (12 s of riding, 150–400 m), back out after", () => {
    const z = (v, toTurn) => M.zoomFor(v, toTurn, null, N.zoomForSpeed);
    assert.equal(z(25, null), 16, "fast, no turn near");
    assert.equal(z(25, 290), 18, "25 m/s × 12 s = 300 m: near");
    assert.equal(z(25, 450), 16);
    assert.equal(z(5, 140), 18);
    assert.equal(z(5, 300), 18, "slow: town zoom anyway");
    assert.equal(z(14, 180), 17, "14 m/s × 12 s = 168 m: 180 m isn't near yet (17 by speed)");
    assert.equal(z(14, 160), 18);
});

test("the turn arrow: a shaft along the road through the turn and a head pointing the new way", () => {
    const a = M.turnArrow(ix, 1000, 18, M.metresPerPx(18.8, 18));
    assert.ok(a && a.shaft.length >= 3, "the corner is inside the shaft");
    const first = a.shaft[0], last = a.shaft[a.shaft.length - 1];
    assert.ok(Math.abs(M.metres(first[0], first[1], line[10][0], line[10][1]) - 40) < 1, "40 m before");
    assert.ok(Math.abs(M.metres(last[0], last[1], line[10][0], line[10][1]) - 30) < 1, "30 m after");
    const [l, tip, r] = a.head;
    assert.ok(tip[1] > last[1], "the head points east, the new direction");
    assert.ok(Math.abs(l[0] - r[0]) > 0, "the head is across the road");
    const far = M.turnArrow(ix, 1000, 16, M.metresPerPx(18.8, 16));
    assert.ok(M.metres(far.shaft[0][0], far.shaft[0][1], line[10][0], line[10][1]) > 150, "longer when zoomed out, so it reads the same size");
});

test("a phone that reports no speed: the arrow still glides, at the speed the fixes show along the road", () => {
    const m = M.createMotion(ix);
    m.fix({ lat: 18.8 + 100 * DEG, lng: 82.7, speedMs: 0, t: 0 });
    m.fix({ lat: 18.8 + 112 * DEG, lng: 82.7, speedMs: null, t: 1000 });
    let d; for (let t = 1000; t <= 1900; t += 16) d = m.frame(t);
    assert.ok(d.s > 118 && d.s < 124, `glides on at ~12 m/s: ${d.s}`);
});

test("the wiring: loaded after the camera, cached offline, driven by navigation (start, every fix, reroutes, stop)", async () => {
    const fs = await import("node:fs");
    const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
    const html = read("public/index.html"), sw = read("public/sw.js"), nav = read("public/js/navigation.js");
    const i = (s) => html.indexOf(s);
    assert.ok(i("js/navcam/navcam.js?") > 0 && i("js/navcam/navcam.js?") < i("js/navcam/navmotion-core.js?") && i("js/navcam/navmotion-core.js?") < i("js/navcam/navmotion.js?"));
    for (const f of ["navmotion-core.js", "navmotion.js"]) assert.ok(sw.includes(`"/js/navcam/${f}"`));
    assert.match(nav, /NavMotion\.start\(\{ map, route: \(\) => fullPath, puck: userMarker/);
    assert.match(nav, /NavMotion\.fix\(currentLat, currentLng, speedMps, estimated\)/);
    assert.equal((nav.match(/NavMotion\.reroute\(\)/g) || []).length, 2, "both reroutes");
    assert.match(nav, /NavMotion\.stop\(\)/);
});
