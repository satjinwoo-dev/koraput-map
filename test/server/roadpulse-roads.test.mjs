// RoadPulse road-aware merging (lib/master/roadpulse-roads.js + lib/master/roadsense.js): by road, direction and
// along-road distance, not a radius; hazards survive road-data updates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openServerDatabase } = require("../../lib/server-db.js");
const { createRoadsense } = require("../../lib/master/roadsense.js");
const RD = require("../../lib/master/roadpulse-roads.js");
const RS = require("../../public/js/master/roadsense/roadsense.js");

const H = 3600000, D = 24 * H;
const T0 = Date.UTC(2026, 9, 15, 6);
const LAT = 18.81, LNG = 82.70;
const M_LNG = 1 / (111320 * Math.cos(LAT * Math.PI / 180)), M_LAT = 1 / 111320;
const PASSED = { passed: true, quality: "good", felt: null };
const tok = (c) => `contributor-${c}`.padEnd(24, c);
// [lat, lng] east/north metres from the origin
const pt = (east, north = 0) => [LAT + north * M_LAT, LNG + east * M_LNG];
const line = (id, coords, props = {}) => ({ type: "Feature", properties: { osm_way_id: id, ...props }, geometry: { type: "LineString", coordinates: coords.map(([la, ln]) => [ln, la]) } });
// way 1: an undivided two-way road running east, 3 km
// ways 2 / 3: a divided highway 200 m north: the eastbound carriageway, and 12 m north of it the westbound one
const ROADS = [
    line(1, [pt(0), pt(3000)], { name: "Old road" }),
    line(2, [pt(0, 200), pt(3000, 200)], { oneway: "yes", ref: "NH26" }),
    line(3, [pt(3000, 212), pt(0, 212)], { oneway: "yes", ref: "NH26" })
];
let n = 0;
const report = (east, north = 0, o = {}) => { const [lat, lng] = pt(east, north); return { id: `report-${++n}`, type: "pothole", severity: 2, lat, lng, sigmaM: 4, heading: 90, t: T0, source: "sensor", ...o }; };

function setup(roads = RD.createRoadIndex(ROADS)) {
    const { db } = openServerDatabase(":memory:");
    let t = T0 + H, R = roads;
    const rs = createRoadsense({ db: () => db, secret: () => "s", now: () => t, roads: () => R, limits: { lowTrafficRiders: 0 } });
    const area = async () => (await rs.area({ v: 1, tiles: [RS.tileOf(LAT, LNG), RS.tileOf(...pt(0, 212))] })).json.hazards;
    const pub = (who, reports) => rs.publish({ v: 1, contributor: tok(who), device: tok(`d${who}`), reports });
    return { db, rs, area, pub, at: (v) => { t = v; }, setRoads: (r) => { R = r; } };
}

test("snapping: the road, direction, along-road metres and side; a oneway only along it", () => {
    const idx = RD.createRoadIndex(ROADS);
    assert.equal(idx.size(), 3);
    const a = idx.snap(...pt(1000, 3), 90);
    assert.deepEqual([a.wayId, a.dir, a.carriageway], ["1", 1, "undivided"]);
    assert.ok(Math.abs(a.alongM - 1000) < 1);
    assert.ok(Math.abs(a.lateralM + 3) < 0.5, `3 m north of an eastbound road is its left: ${a.lateralM}`);
    assert.equal(idx.snap(...pt(1000, -3), 270).dir, -1, "the other way on a two-way road");
    // the divided highway: heading east snaps to the eastbound carriageway even nearer the westbound one
    const e = idx.snap(...pt(1000, 207), 90);
    assert.deepEqual([e.wayId, e.carriageway], ["2", "divided"]);
    assert.equal(idx.snap(...pt(1000, 207), 270).wayId, "3");
    assert.equal(idx.snap(...pt(1000, 100), 90), null, "100 m from any road: not snapped");
});

test("one pothole, many GPS-scattered reports: one hazard", async () => {
    const w = setup();
    const scatter = [[0, 0], [5, 3], [-6, -2], [3, -4], [-4, 4], [7, 1]];
    for (const [i, [de, dn]] of scatter.entries()) { w.at(T0 + (i + 1) * D); await w.pub(`r${i}`, [report(1000 + de, dn, { t: T0 + (i + 1) * D - H, sigmaM: 6 })]); }
    const hz = await w.area();
    assert.equal(hz.length, 1);
    assert.equal(hz[0].found, 6);
    assert.equal(hz[0].roadStatus, "ok");
    assert.equal(hz[0].carriageway, "undivided");
});

test("two potholes 12 m apart on the same road stay two hazards; the other carriageway is another road", async () => {
    const w = setup();
    for (const who of ["a", "b", "c"]) await w.pub(who, [report(1000, 0, { sigmaM: 3 })]);
    await w.pub("d", [report(1012, 0, { sigmaM: 3 })]);
    let hz = await w.area();
    assert.equal(hz.length, 2, "well-located reports clearly apart along the road");
    // a divided highway: a pothole on the eastbound side, and a report from the westbound side 12 m away
    await w.pub("e", [report(2000, 200)]);
    await w.pub("f", [report(2000, 212, { heading: 270 })]);
    hz = await w.area();
    assert.equal(hz.filter((h) => h.carriageway === "divided").length, 2);
    // without a road index the old rule (15 m + direction) would have made the first pair one hazard
    const flat = setup(null);
    for (const who of ["a", "b", "c"]) await flat.pub(who, [report(1000, 0, { sigmaM: 3 })]);
    await flat.pub("d", [report(1012, 0, { sigmaM: 3 })]);
    assert.equal((await flat.area()).length, 1);
});

test("road data updates: a new way id re-snaps the same hazard; a removed road leaves it on the map, quiet, never deleted", async () => {
    const w = setup();
    await w.pub("a", [report(1500)]);
    let [h] = await w.area();
    const id = h.id;
    // the OSM way was split and renumbered: same place, new id
    w.setRoads(RD.createRoadIndex([line(901, [pt(0), pt(1600)]), line(902, [pt(1600), pt(3000)]), ...ROADS.slice(1)]));
    let m = w.rs.maintain();
    assert.equal(m.needsResnap, 0);
    [h] = await w.area();
    assert.equal(h.id, id, "the same hazard");
    assert.equal(h.roadStatus, "ok");
    assert.equal(JSON.parse(w.db.prepare("SELECT road_ref FROM roadsense_hazard").get().road_ref).wayId, "901");
    // the road is gone from the data (moved, deleted, bad import)
    w.setRoads(RD.createRoadIndex(ROADS.slice(1)));
    m = w.rs.maintain();
    assert.equal(m.needsResnap, 1);
    [h] = await w.area();
    assert.equal(h.id, id, "still there");
    assert.equal(h.roadStatus, "needs_resnap");
    assert.equal(h.alertable, false, "quiet until it's re-snapped or reconfirmed");
});

test("maintenance: a legacy hazard holding two groups of reports is split; two hazards that are one are merged", async () => {
    const w = setup(null);                                        // created before the road index: by distance only
    // legacy state: one hazard whose reports sit in two well-located groups 30 m apart (2 riders each)
    w.db.exec(`SELECT 1`);
    await w.pub("a", [report(1000, 0, { sigmaM: 3 })]);
    const hid = (await w.area())[0].id;
    const ins = w.db.prepare(`INSERT INTO roadsense_report (id, hazard_id, epoch, contributor, device, type, severity, lat, lng, sigma, heading, t, source, received) VALUES (?,?,0,?,?,'pothole',2,?,?,3,90,?,'sensor',?)`);
    const vote = w.db.prepare(`INSERT INTO roadsense_vote (hazard_id, epoch, contributor, device, verdict, severity, t, received, counts, anon) VALUES (?,0,?,?, 'found', 2, ?, ?, 1, 0)`);
    for (const [who, east] of [["b", 1001], ["c", 1030], ["d", 1031]]) {
        const [lat, lng] = pt(east);
        const c = w.rs.contributorOf(tok(who));
        ins.run(`legacy-${who}`, hid, c, null, lat, lng, T0, T0); vote.run(hid, c, null, T0 + D, T0 + D);
    }
    // two hazards 5 m apart along the same road (created apart under the old rules, e.g. different headings unknown)
    for (const [id, east] of [["h00000000000000e1", 2000], ["h00000000000000e2", 2005]]) {
        const [lat, lng] = pt(east);
        w.db.prepare(`INSERT INTO roadsense_hazard (id, tile, type, lat, lng, sigma, heading, both_ways, severity, epoch, first_t, reporter, reporter_device, fixed_at, updated) VALUES (?,?,?,?,?,6,90,0,2,0,?,?,NULL,NULL,?)`)
            .run(id, RS.tileOf(lat, lng), "pothole", lat, lng, T0, w.rs.contributorOf(tok(id)), T0);
        ins.run(`legacy-${id}`, id, w.rs.contributorOf(tok(id)), null, lat, lng, T0, T0);
        vote.run(id, w.rs.contributorOf(tok(id)), null, T0, T0);
    }
    w.setRoads(RD.createRoadIndex(ROADS));
    const m = w.rs.maintain();
    assert.equal(m.split, 1);
    assert.equal(m.merged, 1);
    const hz = await w.area();
    const along = (h) => Math.round((h.lng - LNG) / M_LNG);
    const sorted = hz.map((h) => [along(h), h.found]).sort((x, y) => x[0] - y[0]);
    assert.equal(sorted.length, 3);
    assert.ok(Math.abs(sorted[0][0] - 1000) <= 2 && sorted[0][1] === 2, `group 1: ${sorted[0]}`);
    assert.ok(Math.abs(sorted[1][0] - 1030) <= 2 && sorted[1][1] === 2, `group 2: ${sorted[1]}`);
    assert.ok(Math.abs(sorted[2][0] - 2002) <= 4 && sorted[2][1] === 2, `merged: ${sorted[2]}`);
});
