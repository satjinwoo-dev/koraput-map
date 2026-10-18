// The PIN pad (public/js/pin/): digits only, the row and the ring the digits fly to, and the wiring
// (page, offline cache, the Group menu, the trip panel, the map's one-bike markers, the rider's pillion load).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PinCore: P } = require("../../public/js/pin/pinpad.js");
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("digits only, four at most; a row round the centre; a ring with the first digit on top", () => {
    assert.equal(P.clean(" 4 7-1 9 2"), "4719");
    assert.equal(P.clean("ab"), "");
    const r = P.row(4, 52, 12);
    assert.deepEqual(r.map((p) => p.x), [-96, -32, 32, 96]);
    const g = P.ring(4, 62);
    assert.deepEqual(g[0], { x: 0, y: -62 });
    assert.deepEqual(g[1], { x: 62, y: 0 });
    assert.ok(Math.abs(g[2].y - 62) < 1e-9 && Math.abs(g[3].x + 62) < 1e-9);
});

test("the wiring", () => {
    const html = read("public/index.html"), sw = read("public/sw.js"), ctl = read("public/js/controls.js"), pres = read("public/js/presence.js"), app = read("public/js/trip/trip-app.js");
    for (const f of ["pinpad.js", "group-pin.js", "pillion.js"]) { assert.match(html, new RegExp(`js/pin/${f.replace(".", "\\.")}\\?v=`)); assert.ok(sw.includes(`"/js/pin/${f}"`)); }
    assert.ok(html.indexOf("js/pin/pinpad.js") < html.indexOf("js/pin/group-pin.js") && html.indexOf("js/pin/group-pin.js") < html.indexOf("js/pin/pillion.js"));
    assert.ok(sw.includes('"/js/pin/pinpad.css"'));
    assert.match(ctl, /GroupPin\.menu\(\{ start: startTripPick \}\)/);
    assert.match(ctl, /trip\.locked && typeof GroupPin !== "undefined"\) GroupPin\.join\(\{ tripId: trip\.id/);
    assert.match(ctl, /GroupPin\.renderRow\(trip\)/);
    assert.match(pres, /classList\.toggle\("pillion-hidden"/);
    assert.match(app, /addEventListener\("mu:pillion"[\s\S]*setPillion\(true\)/);
    const pp = read("public/js/pin/pinpad.js");
    assert.match(pp, /autocomplete: "one-time-code"/, "the phone can fill the code from a message");
    assert.match(pp, /inputmode: "numeric"/);
});
