// Roadmap step 9: gradient from elevation, bridges and tunnels fixed (public/js/gradient/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../../public/js/gradient/gradient.js");
const ST = require("../../public/js/trip/structures.js");      // the ONE bridges/tunnels pipeline (roadmap Step 9)
const V = require("../../public/js/gradient/profile-chart.js");
const P = require("../../public/js/trip/profile.js");
const U = require("../../public/js/garage/units.js");

const LAT = 18.8, LNG0 = 82.7;
const mPerDegLng = Math.cos(LAT * Math.PI / 180) * 6371008.8 * Math.PI / 180;
const lngAt = (m) => LNG0 + m / mPerDegLng;
/** A straight route due east, `km` long, a point every 20 m. */
function straight(km) { const out = []; for (let m = 0; m <= km * 1000 + 1e-9; m += 20) out.push([LAT, lngAt(m)]); return out; }
/** Samples the way the trip card takes them. */
function samples(path, distance) { return P.resample(path, P.plan(distance)); }

test("analyze: the bridge dip disappears from the grades; steep sections are found and graded", () => {
    const path = straight(8);
    const rs = samples(path, 8000);
    const z = Array.from(rs.s, (x) => {
        let h = 400;
        if (x > 1000) h += 0.08 * Math.min(x - 1000, 1000);                   // 8 % for 1 km
        if (x > 2000) h += 0.13 * Math.min(x - 2000, 400);                    // 13 % for 400 m
        if (x > 5000) h -= 0.07 * Math.min(x - 5000, 900);                    // −7 % for 900 m
        if (x > 3300 && x < 3600) h -= 25;                                    // river under a bridge
        return h;
    });
    const osm = { elements: [{ type: "way", id: 9, tags: { highway: "primary", bridge: "yes", name: "Indravati bridge" }, geometry: [{ lat: LAT, lon: lngAt(3280) }, { lat: LAT, lon: lngAt(3620) }] }] };
    const spans = ST.fromOsm(osm, rs);
    const withOsm = core.analyze({ sample: rs, z, distance: 8000, spans, profileLib: P });
    const noOsm = core.analyze({ sample: rs, z, distance: 8000, spans: null, profileLib: P });
    const naive = P.buildProfile(rs.s, z, { distance: 8000, detectStructures: false });          // the DEM as it is
    const worst = (p, a, b) => { let w = 0; for (let i = 0; i < p.grade.length; i++) if (p.s[i] >= a && p.s[i] <= b) w = Math.max(w, Math.abs(p.grade[i])); return w; };
    assert.ok(worst(naive, 3100, 3800) > 0.06, "the raw DEM makes the bridge look steep");
    assert.ok(worst(withOsm.profile, 3100, 3800) < 0.02, "fixed with OpenStreetMap");
    assert.ok(worst(noOsm.profile, 3100, 3800) < 0.03, "fixed from the DEM alone");
    assert.equal(withOsm.structures[0].kind, "bridge"); assert.equal(withOsm.structures[0].source, "osm"); assert.equal(withOsm.structures[0].name, "Indravati bridge");
    assert.ok(withOsm.structures[0].deviation > 20 && withOsm.structures[0].deviation < 30, `the DEM was ${withOsm.structures[0].deviation} m off`);
    assert.ok(Math.abs(withOsm.structures[0].grade) < 0.02, "the deck's grade now");
    assert.equal(noOsm.structures[0].kind, "likely-bridge"); assert.equal(noOsm.structures[0].source, "dem");
    assert.equal(withOsm.structureSource, "osm"); assert.equal(noOsm.structureSource, "none");
    const kinds = withOsm.sections.map((x) => `${x.kind}${x.level}`);
    assert.deepEqual(kinds, ["climb2", "descent1"]);                         // 8 % then 13 % merge into one very steep climb
    const climb = withOsm.sections[0];
    assert.ok(climb.s0 > 800 && climb.s0 < 1250 && climb.s1 > 2250 && climb.s1 < 2600);
    assert.ok(climb.rise > 100 && climb.maxGrade > 0.1);
    assert.ok(withOsm.summary.ascent < naive.ascent, "the fake dip-and-climb no longer adds ascent");
    assert.equal(withOsm.summary.bridges, 1);
    assert.ok(Math.abs(withOsm.profile.distance - 8000) < 1e-6);
});

test("analyze: terrain still unbelievable after cleaning is capped and reported; no data → flat", () => {
    const path = straight(3);
    const rs = samples(path, 3000);
    const z = Array.from(rs.s, (x) => (x < 1000 ? 100 : x < 1600 ? 100 + 0.45 * (x - 1000) : 370));   // a 45 % "road" for 600 m
    const r = core.analyze({ sample: rs, z, distance: 3000, spans: [], profileLib: P });
    assert.ok(r.structures.some((x) => x.kind === "capped"));
    assert.ok(r.summary.capped >= 1);
    assert.ok(r.summary.maxClimb <= 0.25 + 1e-9);
    const flat = core.analyze({ sample: rs, z: null, distance: 3000, spans: null, profileLib: P });
    assert.equal(flat.profile.source, "flat"); assert.equal(flat.sections.length, 0); assert.equal(flat.raw, null);
});

test("chart helpers: nice ticks, a complete table (route order), provenance in words", () => {
    const t = V.niceTicks(412, 897, 4);
    assert.deepEqual([t.lo, t.hi, t.step], [400, 1000, 200]);
    assert.deepEqual(V.niceTicks(5, 5).ticks, [-5, 5, 15]);
    const res = {
        sections: [{ kind: "climb", level: 2, s0: 1000, s1: 2400, length: 1400, rise: 140, avgGrade: 0.1, maxGrade: 0.13 }, { kind: "descent", level: 1, s0: 5000, s1: 5900, length: 900, rise: -63, avgGrade: -0.07, maxGrade: -0.075 }],
        structures: [{ kind: "bridge", s0: 3300, s1: 3600, name: "Indravati bridge", source: "osm", deviation: 25, grade: 0.001 }, { kind: "likely-tunnel", s0: 7000, s1: 7300, name: "", source: "dem", deviation: 14, grade: 0 }]
    };
    const rows = V.tableRows(res, U);
    assert.deepEqual(rows.map((r) => r.type), ["climb", "fixed", "descent", "fixed"]);
    assert.equal(rows[0].what, "Very steep climb"); assert.equal(rows[0].where, "km 1.0–2.4"); assert.equal(rows[0].length, "1.4 km");
    assert.match(rows[0].detail, /10 % average, 13 % at most · ↑ 140 m/);
    assert.equal(rows[1].what, "Bridge: Indravati bridge");
    assert.match(rows[1].detail, /terrain model was 25 m off · now \+0\.1 % · OpenStreetMap/);
    assert.equal(rows[3].what, "Likely tunnel or cutting"); assert.match(rows[3].detail, /found in the terrain data/);
    assert.equal(rows[2].length, "900 m");
    const pv = V.provenance({ elevation: { source: "dem", fetched: 0 }, structureSource: "none" });
    assert.deepEqual(pv.map((x) => x.tone), ["ok", "info"]);
    assert.match(pv[0].text, /works offline/); assert.match(pv[1].text, /not checked \(offline\)/);
    assert.match(V.provenance({ elevation: { source: "none" }, offline: true, structureSource: "cache" })[0].text, /shown flat/);
});

test("sections: a short easing doesn't split a climb; a long one does; tiny runs are dropped", () => {
    const mk = (grades, ds = 90) => {
        const s = [0], z = [100];
        for (const g of grades) { s.push(s[s.length - 1] + ds); z.push(z[z.length - 1] + g * ds); }
        return { s: Float64Array.from(s), z: Float64Array.from(z), grade: Float64Array.from(grades) };
    };
    const one = core.sections(mk([0.08, 0.08, 0.08, 0.04, 0.08, 0.11, 0.11]));
    assert.equal(one.length, 1);
    assert.equal(one[0].level, 2); assert.equal(one[0].length, 630);
    assert.ok(Math.abs(one[0].maxGrade - 0.11) < 1e-12);
    const two = core.sections(mk([0.08, 0.08, 0.08, 0.02, 0.02, 0.02, 0.08, 0.08]));
    assert.equal(two.length, 2);                                               // 270 m of easing ends it
    assert.equal(core.sections(mk([0.02, 0.09, 0.02])).length, 0);            // 90 m < 150 m
    const down = core.sections(mk([-0.07, -0.07, 0.07, 0.07]));
    assert.deepEqual(down.map((x) => x.kind), ["descent", "climb"]);          // opposite kinds never merge
});

test("one pipeline: the sheet's profile is exactly the trip card's (buildProfile with the same spans)", () => {
    const path = straight(5);
    const rs = samples(path, 5000);
    const z = Array.from(rs.s, (x) => 200 + 0.02 * x - (x > 2000 && x < 2400 ? 30 : 0));
    const sheet = core.analyze({ sample: rs, z, distance: 5000, spans: null, profileLib: P });
    const card = P.buildProfile(rs.s, z, { distance: 5000 });
    assert.deepEqual(Array.from(sheet.profile.grade), Array.from(card.grade));
    assert.deepEqual(sheet.structures.map((x) => x.kind), ["likely-bridge"]);
    assert.ok(!("structureIntervals" in core) && !("detectSpikes" in core), "no second detector");
});
