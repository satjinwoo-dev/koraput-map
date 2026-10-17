// RoadPulse post-ride review (public/js/master/roadsense/review.js): what the rider is asked, and exactly what their
// answers publish (nothing unconfirmed, nothing of the route).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const RV = require("../../public/js/master/roadsense/review.js");
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const T0 = Date.UTC(2026, 9, 17, 6), MIN = 60000;
const ride = {
    startedAt: T0, endedAt: T0 + 60 * MIN,
    items: [
        { id: "j3.1", kind: "impact", hazard: "pothole", severity: 3, minor: false, t: T0 + 10 * MIN, lat: 18.81, lng: 82.71, posSigmaM: 4, heading: 92.4, logId: "e1" },
        { id: "j5.2", kind: "impact", hazard: "speed_breaker", severity: 2, minor: false, t: T0 + 20 * MIN, lat: 18.82, lng: 82.72, posSigmaM: 5, heading: 271 },
        { id: "r9", kind: "rough", hazard: "rough", severity: 2, minor: false, t: T0 + 30 * MIN, lat: 18.83, lng: 82.73, points: [[18.83, 82.73], [18.831, 82.731]], lengthM: 120, heading: 10 },
        { id: "m1.3", kind: "impact", hazard: "bump", severity: 1, minor: true, t: T0 + 40 * MIN, lat: 18.84, lng: 82.74, posSigmaM: 4 },
        { id: "u7.4", kind: "impact", hazard: "bump", severity: 1, minor: false, unknown: true, t: T0 + 45 * MIN, lat: 18.845, lng: 82.745, posSigmaM: 4 }
    ],
    warned: [
        { roadsenseId: "h00000000000000a1", t: T0 + 50 * MIN, lat: 18.85, lng: 82.75, kind: "pothole", community: true, passage: { passed: true, quality: "good", felt: false } },
        { roadsenseId: "h00000000000000c3", t: T0 + 50 * MIN, lat: 18.855, lng: 82.755, kind: "pothole", community: true, passage: { passed: false, quality: "good", felt: null } },   // warned, then turned off before it
        { roadsenseId: "h00000000000000b2", t: T0 + 51 * MIN, lat: 18.86, lng: 82.76, kind: "pothole", community: true },   // the rider's own report
        { roadsenseId: "e77", t: T0 + 52 * MIN, lat: 18.87, lng: 82.77, kind: "bump", community: false }                    // synced evidence: no vote possible
    ]
};
const hazards = [{ id: "h00000000000000a1", type: "pothole", mine: false }, { id: "h00000000000000b2", type: "pothole", mine: true }, { id: "h00000000000000c3", type: "pothole", mine: false }];

test("what the rider is asked: detections, minor ones apart, and 'did you find it?' only for other riders' published hazards", () => {
    const rv = RV.buildReview(ride, { hazards });
    assert.deepEqual(rv.items.map((x) => x.id), ["j3.1", "j5.2", "r9"]);
    assert.deepEqual(rv.minor.map((x) => x.id), ["m1.3"]);
    assert.deepEqual(rv.unknown.map((x) => x.id), ["u7.4"], "one-wheel hits: their own group, never published unless the rider confirms");
    assert.deepEqual(rv.asks.map((x) => x.hazard), ["h00000000000000a1"], "not the rider's own, not one the phone didn't see them pass");
    assert.equal(rv.empty, false);
    assert.equal(RV.buildReview({ startedAt: T0, endedAt: T0 + 1, items: [], warned: [] }).empty, true);
});

test("private by default: no answers → nothing published, nothing changed", () => {
    const out = RV.toPublish(RV.buildReview(ride, { hazards }), {});
    assert.deepEqual(out, { reports: [], votes: [], thanks: [], local: [], cover: null });
});

test("only what the rider confirmed and kept public is published; corrected spots and severities go as the rider set them", () => {
    const rv = RV.buildReview(ride, { hazards });
    const out = RV.toPublish(rv, {
        items: {
            "j3.1": { verdict: "found", severity: 2, lat: 18.8101, lng: 82.7102 },     // moved, milder than the sensor thought
            "j5.2": { verdict: "not_found" },                                          // a wrong detection
            "r9": { verdict: "found", publish: false },                                // true, but kept private
            "m1.3": { verdict: "found" },                                              // a minor one the rider says was real
            "u7.4": { verdict: "not_found" }                                           // an unknown one: nothing
        },
        asks: { h00000000000000a1: "not_found" },
        thanks: { h00000000000000a1: true },                                           // thanks only go with a "found"
        added: [{ type: "pothole", severity: 3, lat: 18.9, lng: 82.8 }, { type: "dragon", lat: 1, lng: 1 }],
        shareClear: true
    });
    assert.deepEqual(out.reports.map((r) => [r.type, r.severity, r.source]), [["pothole", 2, "sensor"], ["bump", 1, "sensor"], ["pothole", 3, "manual"]]);
    const moved = out.reports[0];
    assert.deepEqual([moved.lat, moved.lng, moved.sigmaM, moved.heading, moved.t], [18.8101, 82.7102, 10, 92, T0 + 10 * MIN]);
    assert.match(moved.id, /^r\d+\.j3\.1$/);
    for (const r of out.reports) assert.match(r.id, /^[A-Za-z0-9_.-]{6,64}$/, "ids the server accepts");
    assert.equal(out.reports[2].sigmaM, 15, "a hand-placed spot is less exact");
    assert.deepEqual(out.votes, [{ hazard: "h00000000000000a1", verdict: "not_found", t: T0 + 50 * MIN, passage: { passed: true, quality: "good", felt: false } }], "the vote carries its passage evidence, no coordinates");
    assert.deepEqual(out.cover, { from: T0, to: T0 + 60 * MIN });
    assert.deepEqual(out.thanks, [], "no thanks with a 'not found'");
    assert.deepEqual(RV.toPublish(rv, { asks: { h00000000000000a1: "found" }, thanks: { h00000000000000a1: true } }).thanks, ["h00000000000000a1"]);
    // the phone's own log: confirmed ones present (incl. the private one), the wrong one absent
    assert.deepEqual(out.local.map((x) => [x.type, x.present]), [["pothole", true], ["speed_breaker", false], ["rough", true], ["bump", false], ["bump", true], ["pothole", true]]);
    // nothing of the route: only the spots, no ride path, start or end
    const sent = JSON.stringify({ reports: out.reports, votes: out.votes });
    assert.ok(!sent.includes("82.731") && !/startedAt|endedAt|points/.test(sent));
});

test("wiring: loaded after the Truth Card, offline, type-checked; the ride's end reaches the screen", () => {
    const html = read("public/index.html");
    const pos = (s) => html.indexOf(`<script src="${s}`);
    assert.ok(pos("js/master/roadsense/review.js") > pos("js/master/roadsense/truth-card.js"));
    assert.ok(read("public/sw.js").includes('"/js/master/roadsense/review.js"'));
    assert.ok(JSON.parse(read("tsconfig.master.json")).files.includes("public/js/master/roadsense/review.js"));
    assert.match(read("public/js/master/master-app.js"), /toDom\("state\.ride", "mu:master-ride"\)/);
    assert.equal(RV.RIDE_KEY, "mu.master.dynamics.review.ride", "where the dynamics agent keeps the ride (store namespace dynamics, key review.ride)");
});
