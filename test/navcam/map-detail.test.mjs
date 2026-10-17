// js/mapdetail.js (phone): which tiles a view needs, which places show at a zoom and while driving, and labels that never
// overlap (the more important kept). Plus the wiring: script order, precache, the style switcher's Google choice.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MapDetailCore: C } = require("../../public/js/mapdetail.js");
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("tiles for a view: 0.01° keys, nearest the centre first, capped", () => {
    const keys = C.tilesFor({ s: 22.241, w: 84.835, n: 22.259, e: 84.858 });
    assert.ok(keys.includes("2224:8483") && keys.includes("2225:8485"));
    assert.equal(keys.length, 2 * 3);
    assert.equal(C.tilesFor({ s: 22.2, w: 84.8, n: 22.4, e: 85.0 }, 12).length, 12);
    const c = C.tilesFor({ s: 22.20, w: 84.80, n: 22.25, e: 84.85 }, 1)[0];
    assert.equal(c, "2222:8482", "the middle tile comes first");
    assert.deepEqual(C.tilesFor({ s: -0.005, w: -0.005, n: 0.004, e: 0.004 }).sort(), ["-1:-1", "-1:0", "0:-1", "0:0"]);
});

test("what shows at each zoom, and less while driving", () => {
    assert.equal(C.maxRank(14, false), 0, "too far out: nothing");
    assert.equal(C.maxRank(15, false), 3);
    assert.equal(C.maxRank(16, false), 5);
    assert.equal(C.maxRank(17, false), 7);
    assert.equal(C.maxRank(18, true), 3, "driving: areas, health, fuel, police, worship, schools, stations, sights");
});

test("declutter: labels never overlap; the more important wins; capped", () => {
    const places = [
        { name: "Sai Fast Food", rank: 4, x: 100, y: 100 },
        { name: "Sector 7", rank: 1, x: 110, y: 104 },
        { name: "Ganesh Mandir", rank: 3, x: 100, y: 200 },
        { name: "Bhola Gym", rank: 5, x: 300, y: 100 }
    ];
    const kept = C.declutter(places);
    assert.deepEqual(kept.map((p) => p.name).sort(), ["Bhola Gym", "Ganesh Mandir", "Sector 7"]);
    const many = Array.from({ length: 500 }, (_, i) => ({ name: `P${i}`, rank: 6, x: (i % 20) * 200, y: Math.floor(i / 20) * 40 }));
    assert.equal(C.declutter(many, 120).length, 120);
});

test("every kind has an icon and a colour", () => {
    for (const k of ["area", "health", "fuel", "police", "worship", "education", "transit", "attraction", "food", "lodging", "bank", "government", "gym", "park", "shop", "service", "other"]) {
        assert.ok(Array.isArray(C.LOOK[k]) && /^#[0-9a-f]{6}$/i.test(C.LOOK[k][1]), k);
    }
});

test("wiring: after core.js, precached; the style switcher knows Google; the server's config says when Google is on; no eval", () => {
    const html = read("public/index.html");
    const core = html.indexOf('<script src="js/core.js'), md = html.indexOf('<script src="js/mapdetail.js'), ctl = html.indexOf('<script src="js/controls.js');
    assert.ok(core > 0 && md > core && ctl > md);
    assert.ok(read("public/sw.js").includes('"/js/mapdetail.js"'));
    assert.match(read("public/js/controls.js"), /const layers = \{ satellite: satelliteLayer, street: streetLayer, dark: darkLayer, terrain: terrainLayer, google: googleLayer \};/);
    const src = read("public/js/mapdetail.js");
    assert.ok(!/\beval\(/.test(src), "the CSP has no unsafe-eval");
    assert.match(src, /\/api\/map\/gtile\/satellite\/\{z\}\/\{x\}\/\{y\}/);
    assert.match(src, /if \(cfg\.googleTiles\)/);
    const server = read("server.js");
    assert.match(server, /googleTiles: mapDetail\.googleEnabled/);
    assert.ok(server.indexOf('app.get("/api/map/places"') < server.indexOf("app.use(httpLimiter)"), "own limiter, before the general one");
});
