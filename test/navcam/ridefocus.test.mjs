// Ride Focus AMOLED (public/js/ridefocus.js): the route split at the rider and the next turn, looks that differ by
// width and fill (not colour alone), and the wiring: optional, switchable mid-drive, never an overlay, no battery promise.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RideFocusCore: C } = require("../../public/js/ridefocus.js");
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

// an L-shaped route: north 4 points, then east 4 points (the turn at [18.003, 82.0])
const path = [[18.000, 82.000], [18.001, 82.000], [18.002, 82.000], [18.003, 82.000], [18.003, 82.001], [18.003, 82.002], [18.003, 82.003]];

test("split: this road runs from the rider to the next turn, the rest is the route after it", () => {
    const s = C.splitRoute(path, [18.0015, 82.00002], [18.003, 82.0]);
    assert.ok(Math.abs(s.current[0][0] - 18.0015) < 1e-9 && Math.abs(s.current[0][1] - 82.0) < 1e-9, "starts at the rider, snapped onto the route");
    assert.deepEqual(s.current.slice(1), [[18.002, 82.0], [18.003, 82.0]]);
    assert.deepEqual(s.next, path.slice(3), "after the turn: from the corner to the end");
    // no turn left: the current road runs to the end
    const end = C.splitRoute(path, [18.003, 82.0015], null);
    assert.deepEqual(end.next, []);
    assert.deepEqual(end.current.at(-1), [18.003, 82.003]);
    // degenerate input
    assert.deepEqual(C.splitRoute([], [18, 82], null), { current: [], next: [] });
    assert.deepEqual(C.splitRoute(path, null, null), { current: [], next: [] });
});

test("split: a route that passes the same corner twice takes the turn AFTER the rider", () => {
    // out and back: north, then south over the same points
    const loop = [[18.000, 82.0], [18.002, 82.0], [18.004, 82.0], [18.002, 82.00001], [18.000, 82.00001]];
    const s = C.splitRoute(loop, [18.0035, 82.0], [18.002, 82.00001]);
    assert.equal(s.current.length, 3, "rider → the top → back down to the corner");
    assert.deepEqual(s.next[0], [18.002, 82.00001]);
});

test("looks: this road, the route after the turn and the ridden part differ by width, fill and brightness, not hue alone", () => {
    const L = C.LOOK;
    assert.ok(L.currentCasing.weight > L.nextCasing.weight && L.nextCasing.weight > L.next.weight, "widths step down");
    assert.equal(L.currentCore.color, "#ffffff", "this road: a white core");
    assert.notEqual(L.currentCore.color, L.next.color, "the route after the turn: no white core");
    assert.equal(L.nextCasing.color, "#000000");
    assert.ok(L.trail.weight >= L.next.weight, "ridden: covers the route under it, so nothing bright shows behind the rider");
    const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
    assert.ok(lum(L.trail.color) < lum(L.next.color) / 2, "ridden: much dimmer than the route ahead");
    assert.equal(L.next.dashArray, null, "solid route, no animation");
});

test("wiring: optional (off by default), switchable mid-drive, styles layers (never an overlay), the rider's style comes back", () => {
    const src = read("public/js/ridefocus.js");
    assert.match(src, /enabled = JSON\.parse\(localStorage\.getItem\(KEY\) \|\| "\{\}"\)\.on === true/, "off unless the rider chose it");
    assert.match(src, /dark_nolabels/);
    assert.match(src, /muOverlay: true/, "its labels aren't taken for the base map by the navigation camera");
    assert.ok(!/position:\s*fixed|inset:\s*0/.test(src), "no full-screen overlay element");
    assert.match(src, /W\.NavCamera\.rebase\(\)/);
    assert.match(src, /applied\.own\.layers\.forEach\(\(l\) => \{ if \(!m\.hasLayer\(l\)\) l\.addTo\(m\); \}\)/, "the rider's own base map is put back");
    const html = read("public/index.html");
    assert.match(html, /<input type="checkbox" id="ride-focus-toggle" class="switch">/);
    assert.ok(!/<input type="checkbox" id="ride-focus-toggle" class="switch" checked>/.test(html));
    assert.match(html, /#map\.mu-amoled \.mu-amoled-base, #map\.mu-amoled \.navcam-underlay \{ filter: contrast\(1\.3\); \}/, "the filter is on the tiles only");
    assert.ok(!/mu-amoled[^{]*(marker|popup|overlay-pane|tooltip)[^{]*\{[^}]*filter/.test(html), "markers, routes and popups are never filtered");
    // no promised battery number anywhere in the UI text
    const hint = html.slice(html.indexOf('id="ride-focus-toggle"'), html.indexOf('id="ride-focus-toggle"') + 900);
    assert.ok(!/\d+\s*%|hours? (more|longer)|saves? battery/i.test(hint), "no battery figure promised");
    assert.match(hint, /depends on your screen and brightness/);
    const ns = html.indexOf('<script src="js/ridefocus.js'), nav = html.indexOf('<script src="js/navigation.js');
    assert.ok(ns > 0 && nav > ns);
    assert.ok(read("public/sw.js").includes('"/js/ridefocus.js"'));
    const navjs = read("public/js/navigation.js");
    assert.match(navjs, /RideFocus\.start\(\{ map, ahead: dottedPath, trail: solidPath, route: \(\) => fullPath, turn: \(\) => maneuverLatLng\(nextManeuver\(\)\) \}\)/);
    assert.ok(navjs.indexOf("RideFocus.update(currentLat, currentLng)") > navjs.indexOf("if (d < 35) stepIdx++"), "redrawn after the step advances");
    assert.ok(navjs.indexOf("RideFocus.stop()") > navjs.indexOf("function stopDrive"));
    assert.match(read("public/js/navcam/navcam.js"), /start, follow, frame, stop, pause, resume, supported, toggleHeadingUp, rebase,/);
    assert.match(read("public/js/mapdetail.js"), /new Set\(\["satellite", "dark", "terrain", "amoled"\]\)/);
});
