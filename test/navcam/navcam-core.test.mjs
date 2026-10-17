// Navigation camera (public/js/navcam/): the maths, and how it's wired into the app
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../../public/js/navcam/navcam-core.js");
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ""} ${a} vs ${b} (±${tol})`);

test("angles: shortest turn across north; bearings of the four directions", () => {
    assert.equal(C.angleDiff(350, 10), 20);
    assert.equal(C.angleDiff(10, 350), -20);
    assert.equal(C.angleDiff(0, 180), 180);
    near(C.bearing(20, 85, 20.01, 85), 0, 0.01, "north");
    near(C.bearing(20, 85, 20, 85.01), 90, 0.01, "east");
    near(C.bearing(20, 85, 19.99, 85), 180, 0.01, "south");
    near(C.bearing(20, 85, 20, 84.99), 270, 0.01, "west");
});

test("which way is ahead: GPS course while moving, else the route, else movement, else the last", () => {
    assert.deepEqual(C.courseFrom({ gpsHeading: 95, speedMs: 6, routeBearing: 80 }, 10), { deg: 95, source: "gps" });
    assert.deepEqual(C.courseFrom({ gpsHeading: 95, speedMs: 1, routeBearing: 80 }, 10), { deg: 80, source: "route" }, "a slow phone's course is noise");
    assert.deepEqual(C.courseFrom({ gpsHeading: null, speedMs: 9, routeBearing: null, moveBearing: 200, moveM: 12 }, 10), { deg: 200, source: "movement" });
    assert.deepEqual(C.courseFrom({ moveBearing: 200, moveM: 3 }, 10), { deg: 10, source: "last" }, "3 m isn't enough to tell");
    assert.deepEqual(C.courseFrom({}, null), { deg: null, source: "none" });
    assert.equal(C.courseFrom({ gpsHeading: -90, speedMs: 5 }, null).deg, 270);
});

test("the map turns smoothly, the short way round, never faster than 90°/s, and ignores shimmer", () => {
    let b = 350;
    for (let t = 0; t < 4000; t += 16) b = C.stepBearing(b, 20, 16);
    near(b, 20, 0.5, "settles on the target");
    // the short way: from 350 to 20 passes through 0, never through 180
    let x = 350, seen = [];
    for (let t = 0; t < 600; t += 16) { x = C.stepBearing(x, 20, 16); seen.push(x); }
    assert.ok(seen.every((v) => v >= 349 || v <= 21), "never swings the long way");
    // rate limit: a U-turn takes at least 2 s
    let u = 0;
    for (let t = 0; t < 1000; t += 16) u = C.stepBearing(u, 180, 16);
    assert.ok(Math.abs(C.angleDiff(0, u)) <= 91, `after 1 s: ${u}`);
    assert.equal(C.shouldRetarget(100, 101), false);
    assert.equal(C.shouldRetarget(100, 103), true);
    assert.equal(C.shouldRetarget(null, 0), true);
});

test("zoom follows speed with hysteresis: no pumping at a band edge", () => {
    assert.equal(C.zoomForSpeed(0, null), 18);
    assert.equal(C.zoomForSpeed(12, null), 17);
    assert.equal(C.zoomForSpeed(25, null), 16);
    assert.equal(C.zoomForSpeed(9, 18), 18, "just over 30 km/h: stays close");
    assert.equal(C.zoomForSpeed(10.5, 18), 17, "clearly faster: out");
    assert.equal(C.zoomForSpeed(7.5, 17), 17, "just under: stays");
    assert.equal(C.zoomForSpeed(6, 17), 18, "clearly slower: in");
    assert.equal(C.zoomForSpeed(NaN, 17), 17);
});

test("route direction: the segment under the rider, looking 30 m ahead round a corner; null off the route", () => {
    // north 200 m, then east 200 m
    const path = [[20, 85], [20.0018, 85], [20.0018, 85.0019]];
    near(C.routeBearing(path, 20.0005, 85.0001), 0, 1, "on the northbound leg");
    near(C.routeBearing(path, 20.0018, 85.001), 90, 1, "on the eastbound leg");
    const corner = C.routeBearing(path, 20.0016, 85);                 // 22 m before the corner: looks round it
    assert.ok(corner > 5 && corner < 90, `corner ${corner}`);
    assert.equal(C.routeBearing(path, 20.001, 85.001), null, "100 m off the route");
    assert.equal(C.routeBearing([], 20, 85), null);
});

/** Where a screen point lands on the tilted map (inverse of the CSS transform), in map px from the rider. */
function screenToPlane(g, sx, sy) {
    const th = g.pitchDeg * Math.PI / 180, P = g.perspective;
    const ys = sy - g.ay, xs = sx - g.ax;
    // forward: y_s = d cos θ · P / (P + d sin θ) for d ahead (negative y), x scaled by the same factor
    // inverse for a point at screen offset ys (negative = above the rider)
    const up = -ys;
    const d = up >= 0 ? (up * P) / (P * Math.cos(th) - up * Math.sin(th)) : -((-up) * P) / (P * Math.cos(th) + (-up) * Math.sin(th));
    const scale = P / (P + d * Math.sin(th));
    return { x: xs / scale, y: -d };
}

test("geometry: the rider sits in the lower third of the visible map, and the drawn square covers the screen at every heading", () => {
    // a phone in a drive: the turn banner ends at 140 px, the speed dial starts at 562 px
    const g = C.geometry({ vw: 390, vh: 844, top: 140, bottom: 562 });
    assert.equal(g.ax, 195);
    assert.equal(g.ay, Math.round(140 + (2 / 3) * (562 - 140)));
    assert.ok(g.pitchDeg >= 45 && g.pitchDeg <= 60, "tilt asked for: 45–60°");
    assert.equal(g.horizonY, 0, "no horizon: the map reaches the screen's top edge, like Google Maps' navigation");
    // every screen point, up to the top edge under the glass banner, maps inside the drawn disc, whatever the bearing
    for (const [sx, sy] of [[0, 0], [390, 0], [0, 844], [390, 844], [195, 0]]) {
        const p = screenToPlane(g, sx, sy);
        assert.ok(Math.hypot(p.x, p.y) <= g.radius, `screen (${sx}, ${sy}) → ${Math.round(Math.hypot(p.x, p.y))} px > radius ${g.radius}`);
    }
    // north-up is flat, centred in the visible map, and only needs the screen itself
    const f = C.geometry({ vw: 390, vh: 844, top: 140, bottom: 562, flat: true }, { ...C.DEFAULTS, anchorFrac: 0.5 });
    assert.equal(f.pitchDeg, 0);
    assert.equal(f.ay, 351);
    assert.ok(f.radius >= Math.hypot(195, 844 - 351) && f.radius < g.radius);
    // a cramped layout still leaves the rider on screen
    const c = C.geometry({ vw: 390, vh: 600, top: 500, bottom: 520 });
    assert.ok(c.ay > 500 && c.ay < 600);
});

test("tilt fitted to the screen: the map always reaches the top edge, never further ahead than maxAheadPx, never flatter than minPitchDeg", () => {
    const D = C.DEFAULTS;
    // a phone with the drive panel up, a full-height screen, a tall phone, landscape, a tablet
    for (const v of [{ vw: 390, vh: 844, top: 140, bottom: 562 }, { vw: 390, vh: 844, top: 0, bottom: 844 }, { vw: 412, vh: 915, top: 120, bottom: 915 },
        { vw: 844, vh: 390, top: 90, bottom: 390 }, { vw: 820, vh: 1180, top: 140, bottom: 1180 }]) {
        const g = C.geometry(v);
        const label = `${v.vw}×${v.vh} ${v.top}–${v.bottom}: pitch ${g.pitchDeg}, ahead ${g.aheadPx}`;
        assert.ok(g.pitchDeg >= D.minPitchDeg && g.pitchDeg <= D.pitchDeg, label);
        assert.equal(g.horizonY, 0, label);
        assert.ok(g.aheadPx <= D.maxAheadPx, label);
        const top = screenToPlane(g, v.vw / 2, 0);
        assert.ok(top.y < 0 && -top.y <= D.maxAheadPx + 1, `${label}: the top edge is ${Math.round(-top.y)} px ahead`);
        // the steepest that fits: half a degree more would need more than maxAheadPx
        if (g.pitchDeg < D.pitchDeg) {
            const th = (g.pitchDeg + 0.5) * Math.PI / 180, P = g.perspective, up = g.ay;
            const den = P * Math.cos(th) - up * Math.sin(th);
            assert.ok(den <= 0 || up * P / den > D.maxAheadPx, label);
        }
    }
    // short screens keep the full tilt asked for
    assert.equal(C.geometry({ vw: 390, vh: 844, top: 140, bottom: 562 }).pitchDeg, D.pitchDeg);
    // only if even minPitchDeg can't fill the screen does the horizon (and the sky fallback) show
    const low = C.geometry({ vw: 390, vh: 844, top: 0, bottom: 844 }, { ...D, maxAheadPx: 300 });
    assert.equal(low.pitchDeg, D.minPitchDeg);
    assert.ok(low.horizonY > 0);
    assert.equal(C.fitPitch(0, 500, 1000, D), 0);
});

test("the CSS transform: perspective, tilt, then the map turned against the course", () => {
    const g = C.geometry({ vw: 390, vh: 844, top: 140, bottom: 562 });
    assert.equal(C.cssTransform(g, 90), `perspective(${g.perspective}px) rotateX(${g.pitchDeg}deg) rotateZ(-90deg)`);
    assert.equal(C.cssTransform({ perspective: 900, pitchDeg: 0 }, 370), "rotateZ(-10deg)");
});

test("wiring: scripts load in order, offline precache, navigation hands its fixes to the camera, the Maps tag is untouched", () => {
    const html = read("public/index.html");
    const core = html.indexOf('<script src="js/navcam/navcam-core.js'), cam = html.indexOf('<script src="js/navcam/navcam.js'), nav = html.indexOf('<script src="js/navigation.js');
    assert.ok(core > 0 && cam > core && nav > cam, "navcam-core → navcam → navigation");
    assert.match(html, /<link rel="stylesheet" href="js\/navcam\/navcam\.css/);
    assert.match(html, /<script src="https:\/\/maps\.googleapis\.com\/maps\/api\/js\?key=[^"]+&libraries=places&loading=async"><\/script>/);
    const sw = read("public/sw.js");
    for (const f of ["/js/navcam/navcam-core.js", "/js/navcam/navcam.js", "/js/navcam/navcam.css"]) assert.ok(sw.includes(`"${f}"`), f);
    const navjs = read("public/js/navigation.js");
    assert.match(navjs, /NavCamera\.start\(\{ map, route: \(\) => fullPath/);
    assert.match(navjs, /NavCamera\.follow\(\{ lat: currentLat, lng: currentLng, speedMs: speedMps, headingDeg \}\)/);
    assert.match(navjs, /pos\.coords\.heading/);
    assert.ok(navjs.indexOf("NavCamera.stop()") > navjs.indexOf("function stopDrive"));
});

test("box: the drawn rectangle covers every visible screen point at every heading in its 15° band, and is far smaller than a square for every heading", () => {
    const g = C.geometry({ vw: 390, vh: 844, top: 140, bottom: 562 });
    const pts = [];
    for (let sy = 0; sy <= 844; sy += 37) for (let sx = 0; sx <= 390; sx += 39) pts.push(screenToPlane(g, sx, sy));
    let maxArea = 0, sumArea = 0, n = 0;
    for (let b = 0; b < 360; b += 3) {
        const bx = C.box(g, b);
        maxArea = Math.max(maxArea, bx.w * bx.h); sumArea += bx.w * bx.h; n++;
        // the heading can drift anywhere in the band before the box is re-measured
        for (const actual of [b, bx.band - 7.5, bx.band + 7.5]) {
            const c = Math.cos(actual * Math.PI / 180), s = Math.sin(actual * Math.PI / 180);
            for (const p of pts) {
                const mx = p.x * c - p.y * s + bx.ox, my = p.x * s + p.y * c + bx.oy;   // display → the map's north-up frame, from the box's corner
                assert.ok(mx >= 0 && mx <= bx.w && my >= 0 && my <= bx.h, `bearing ${actual}: (${Math.round(mx)}, ${Math.round(my)}) outside ${bx.w}×${bx.h}`);
            }
        }
    }
    // the drive panel is frosted glass, so the box reaches the screen's bottom too: measured 0.42 of the square
    // heading N/S/E/W, 0.57 on average, 0.67 at the worst diagonal
    const square = (2 * g.radius) ** 2;
    assert.ok(sumArea / n < square * 0.6, `average ${Math.round(sumArea / n / 1e3)}k px² vs square ${Math.round(square / 1e3)}k`);
    assert.ok(maxArea < square * 0.7, `worst heading ${Math.round(maxArea / 1e3)}k px² vs square ${Math.round(square / 1e3)}k`);
    assert.ok(C.box(g, 0).w * C.box(g, 0).h < square * 0.45);
    const ahead = C.box(g, 0);
    assert.ok(ahead.oy > ahead.h / 2, "heading north: the rider sits low in the box, most of it is ahead (Leaflet loads from the centre)");
    assert.equal(C.box(g, 0).band, C.box(g, 7).band);
    assert.notEqual(C.box(g, 0).band, C.box(g, 8).band);
    assert.equal(C.box(g, 355).band, 0, "wraps round north");
});
