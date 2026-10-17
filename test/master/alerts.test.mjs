// RoadPulse speed-aware alerts (public/js/master/roadsense/alerts.js): earlier when faster, once per hazard, grouped,
// direction-aware, quiet with a poor fix or beyond the next turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AL = require("../../public/js/master/roadsense/alerts.js");

const KMH = 1 / 3.6;
const LAT = 18.81, LNG = 82.71, M_LNG = 1 / (111320 * Math.cos(LAT * Math.PI / 180));
const hz = (id, east, o = {}) => ({ id, lat: LAT, lng: LNG + east * M_LNG, heading: 90, severity: 3, alertable: true, ...o });
const ego = (east, kmh, o = {}) => ({ lat: LAT, lng: LNG + east * M_LNG, headingDeg: 90, speedMs: kmh * KMH, posSigmaM: 4, ...o });

test("alert distance grows with speed: ≈ 50 m at 20 km/h, 75 at 40, 140 at 60, 230 at 80 (severity 3, a 2 s line + 1 s); 50–300 m", () => {
    const d = (kmh, severity = 3, posSigmaM = 4, speechS) => AL.alertDistanceM({ speedMs: kmh * KMH, severity, posSigmaM, speechS });
    assert.equal(d(20), 50);
    assert.ok(Math.abs(d(40) - 74) <= 2, `${d(40)}`);
    assert.ok(Math.abs(d(60) - 142) <= 2, `${d(60)}`);
    assert.ok(Math.abs(d(80) - 231) <= 2, `${d(80)}`);
    // a longer warning line (an 18+ one takes ~6 s) starts that much earlier: 4 s more at 60 km/h ≈ 67 m
    assert.ok(Math.abs(d(60, 3, 4, 6) - d(60, 3, 4, 2) - 67) <= 2);
    assert.equal(AL.speechSeconds("x".repeat(84)), 6);
    assert.equal(AL.speechSeconds("short"), 1.5);
    assert.ok(AL.PRIORITY < 70, "below navigation's turn prompts (70–72): a turn instruction is never pushed back");
    assert.ok(d(60, 2) < d(60, 3), "a milder hazard needs less slowing");
    assert.ok(d(60, 3, 20) > d(60, 3, 4), "a poorer fix warns earlier");
    assert.equal(d(140), 300, "never more than 300 m ahead");
});

test("said once, at the right distance, on the rider's line and direction only", () => {
    const p = AL.createPlanner();
    const H = [hz("a", 500)];
    assert.equal(p.plan(ego(200, 60), H, 0), null, "300 m away at 60 km/h: not yet");
    const a = p.plan(ego(380, 60), H, 1000);
    assert.equal(a.kind, "single");
    assert.equal(a.distanceM, 120);
    assert.equal(p.plan(ego(400, 60), H, 2000), null, "once");
    // the other direction, or the other carriageway's hazard: nothing
    const q = AL.createPlanner();
    assert.equal(q.plan(ego(380, 60), [hz("b", 500, { heading: 270 })], 0), null);
    assert.ok(q.plan(ego(380, 60), [hz("c", 500, { heading: 270, bothWays: true })], 0), "marked both ways");
    assert.equal(AL.createPlanner().plan(ego(380, 60), [{ ...hz("d", 500), lat: LAT + 40 / 111320 }], 0), null, "40 m to the side: another road");
    // disputed / maybe fixed: never
    assert.equal(AL.createPlanner().plan(ego(380, 60), [hz("e", 500, { alertable: false })], 0), null);
});

test("slow riders get a close, gentle alert; faster ones an early one", () => {
    const slow = AL.createPlanner(), fast = AL.createPlanner();
    const at = (pl, kmh) => { for (let x = 0; x < 500; x += 5) { const a = pl.plan(ego(x, kmh), [hz("a", 500)], x * 100); if (a) return 500 - x; } return null; };
    const s = at(slow, 20), f = at(fast, 60);
    assert.ok(s <= 50 && s >= 40, `20 km/h: warned ${s} m before`);
    assert.ok(f >= 135 && f <= 145, `60 km/h: warned ${f} m before`);
});

test("no spam: hazards within 300 m become one alert; 15 s between alerts; nothing below 8 km/h", () => {
    const p = AL.createPlanner();
    const H = [hz("a", 500), hz("b", 620), hz("c", 760), hz("d", 1400)];
    const a = p.plan(ego(380, 60), H, 0);
    assert.equal(a.kind, "cluster");
    assert.equal(a.count, 3);
    assert.deepEqual(a.hazards.map((h) => h.id), ["a", "b", "c"]);
    assert.ok(a.spanM >= 350 && a.spanM <= 400, `span ${a.spanM}`);
    // d comes into range 10 s later: held until 15 s have passed
    assert.equal(p.plan(ego(1280, 60), H, 10000), null);
    assert.equal(p.plan(ego(1285, 60), H, 15000).first.id, "d");
    assert.equal(AL.createPlanner().plan(ego(470, 6), H, 0), null, "walking pace: nothing");
});

test("too close to act on: quiet; beyond the next turn: wait; poor fix: one generic line, no distance", () => {
    const p = AL.createPlanner();
    assert.equal(p.plan(ego(490, 60), [hz("a", 500)], 0), null, "10 m at 60 km/h: too late, stay quiet");
    assert.equal(p.plan(ego(495, 60), [hz("a", 500)], 20000), null, "and not repeated");
    assert.equal(AL.createPlanner().plan(ego(400, 60, { nextTurnM: 50 }), [hz("t", 500)], 0), null, "after a turn 50 m ahead: wait");
    const g = AL.createPlanner().plan(ego(400, 60, { posSigmaM: 45 }), [hz("a", 500), hz("b", 800)], 0);
    assert.equal(g.kind, "generic");
    assert.equal(g.distanceM, 0);
    assert.equal(g.count, 1, "only those within 300 m");
});
