// Straight-road focus (public/js/roadfocus.js): when the map focuses (a long straight with the next turn far away)
// and when it comes back (before the turn, before a bend, on a GPS estimate), measured on the route itself; the band
// and particle lines around the road; and the wiring: optional, on by default, never dims the route or markers.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RoadFocusCore: C } = require("../../public/js/roadfocus.js");
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const M_LAT = 1 / 110540;                       // degrees of latitude per metre
// a straight road north for 5 km, then a right turn east for 1 km
const north = Array.from({ length: 51 }, (_, i) => [18 + i * 100 * M_LAT, 82]);
const turnAt = north[50];
const east = Array.from({ length: 11 }, (_, i) => [turnAt[0], 82 + i * 100 / (Math.cos(18 * Math.PI / 180) * 111320)]);
const path = [...north, ...east.slice(1)];

test("distance to the turn is measured along the route from the rider", () => {
    assert.ok(Math.abs(C.toTurnM(path, north[0], turnAt) - 5000) < 2);
    assert.ok(Math.abs(C.toTurnM(path, north[30], turnAt) - 2000) < 2);
    // no turn left: to the end of the route (the destination)
    assert.ok(Math.abs(C.toTurnM(path, north[30], null) - 3000) < 5);
    // the first 1 km of the road ahead
    assert.ok(Math.abs(C.lengthM(C.cut(C.fromRider(path, north[0]).pts, 1000)) - 1000) < 1);
});

test("bends: a straight road has none, a right-angle turn and a ghat's hairpins do, small wiggles don't", () => {
    assert.equal(C.firstBendM(north), Infinity);
    const b = C.firstBendM(path);
    assert.ok(b > 4600 && b <= 5000, `the turn at 5 km, found at ${b}`);
    // gentle wiggle: ±3 m sideways every 100 m on a straight road — not a bend
    const wiggle = north.map(([la, ln], i) => [la, ln + (i % 2 ? 3 : -3) / 105900]);
    assert.equal(C.firstBendM(wiggle), Infinity);
    // a ghat: a hairpin every 400 m
    const ghat = [];
    for (let i = 0; i < 40; i++) { const a = i * 0.25 * Math.PI; ghat.push([18 + Math.sin(a) * 60 * M_LAT + i * 20 * M_LAT, 82 + Math.cos(a) * 60 / 105900]); }
    assert.ok(C.firstBendM(ghat) < 300, "a hairpin early on");
});

test("decide: focus on a long straight, back to normal before the turn and before a bend, with hysteresis", () => {
    const T = C.TUNE;
    const off = { focus: false, since: -Infinity };
    const now = 100000;
    const base = { toTurnM: 4000, bendM: Infinity, speedMps: 20, estimated: false, now };
    assert.equal(C.decide(off, base).focus, true, "4 km straight at 72 km/h");
    // not when the turn is near, the road bends soon, the rider is slow, or the fix is an estimate
    assert.equal(C.decide(off, { ...base, toTurnM: 1900 }).focus, false);
    assert.equal(C.decide(off, { ...base, toTurnM: 2100, speedMps: 40 }).focus, false, "at 144 km/h, 2.1 km is under a minute");
    assert.equal(C.decide(off, { ...base, bendM: 900 }).focus, false);
    assert.equal(C.decide(off, { ...base, speedMps: 2 }).focus, false, "crawling in traffic");
    assert.equal(C.decide(off, { ...base, estimated: true }).focus, false);
    // once on, it stays on until the exit point, not the entry point (no flicker between 800 m and 2 km)
    const on = C.decide(off, base);
    assert.equal(C.decide(on, { ...base, toTurnM: 1500, now: now + 1000 }).focus, true);
    const out = C.decide(on, { ...base, toTurnM: 790, now: now + 2000 });
    assert.deepEqual([out.focus, out.reason], [false, "turn ahead"]);
    assert.equal(C.decide(on, { ...base, toTurnM: 1000, speedMps: 40, now: now + 2000 }).focus, false, "at 144 km/h: 30 s before the turn is 1.2 km");
    assert.equal(C.decide(on, { ...base, bendM: 500, now: now + 2000 }).reason, "bend ahead");
    assert.equal(C.decide(on, { ...base, estimated: true, now: now + 2000 }).reason, "no GPS fix");
    // after coming back, at least holdS seconds of the normal map before focusing again
    assert.equal(C.decide(out, { ...base, now: out.since + (T.holdS - 1) * 1000 }).focus, false);
    assert.equal(C.decide(out, { ...base, now: out.since + T.holdS * 1000 }).focus, true);
});

test("the band around the road and the particle lines beside it", () => {
    const road = north.slice(0, 11);                        // 1 km north
    const left = C.offsetLine(road, 20), right = C.offsetLine(road, -20);
    const kx = Math.cos(18 * Math.PI / 180) * 111320;
    assert.ok(Math.abs((82 - left[3][1]) * kx - 20) < 0.01, "left of a northward road is west");
    assert.ok(Math.abs((right[3][1] - 82) * kx - 20) < 0.01);
    const ring = C.corridor(road, 50);
    assert.equal(ring.length, road.length * 2);
    assert.ok(ring.every(([, ln]) => Math.abs(ln - 82) * kx <= 50.01));
    assert.deepEqual(C.corridor([], 10), []);
    assert.ok(Math.abs(C.metresPerPx(0, 17) - 1.194) < 0.001);
});

test("wiring: optional and on by default, under the route and markers, reduced motion respected, started with navigation", () => {
    const src = read("public/js/roadfocus.js"), html = read("public/index.html"), nav = read("public/js/navigation.js");
    assert.match(src, /enabled = s\.on !== false/, "on unless the rider turned it off");
    // the layers' panes sit under the route lines (overlayPane 400 holds the route; the fx pane only holds the particles)
    assert.match(src, /pane\(m, "mu-focus-dim", 380\)/);
    assert.match(src, /pane\(m, "mu-focus-glow", 392\)/);
    assert.ok(!/markerPane|setOpacity\(|\.leaflet-marker/.test(src), "markers are never touched");
    assert.match(html, /id="road-focus-toggle"/);
    assert.match(html, /prefers-reduced-motion: reduce\) \{ \.mu-focus-dots \{ animation: none; \}/);
    const rs = html.indexOf('<script src="js/roadfocus.js'), ns = html.indexOf('<script src="js/navigation.js');
    assert.ok(rs > 0 && ns > 0 && rs < ns, "loaded before navigation.js");
    assert.match(nav, /RoadFocus\.start\(\{ map, route: \(\) => fullPath, turn: \(\) => maneuverLatLng\(nextManeuver\(\)\) \}\)/);
    assert.match(nav, /RoadFocus\.update\(currentLat, currentLng, speedMps, estimated\)/);
    assert.match(nav, /RoadFocus\.stop\(\)/);
    assert.ok(read("public/sw.js").includes('"/js/roadfocus.js"'));
});
