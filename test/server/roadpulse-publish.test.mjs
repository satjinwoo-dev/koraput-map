// RoadPulse community reports, the server's half (lib/master/roadsense.js publish / area / forget): only what a rider
// reviewed and published; one hazard per pothole; one vote per rider; agreement from reviewers only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { express, listen } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { openServerDatabase } = require("../../lib/server-db.js");
const { createRoadsense } = require("../../lib/master/roadsense.js");
const { createMasterApi } = require("../../lib/master/http-api.js");
const RS = require("../../public/js/master/roadsense/roadsense.js");
const rateLimit = require("express-rate-limit");

// the phone confirmed the rider passed the spot, in its direction, with a good fix (passage attestation)
const PASSED = { passed: true, quality: "good", felt: null };
const H = 3600000, D = 24 * H;
const T0 = Date.UTC(2026, 9, 15, 6, 0, 0);
const LAT = 18.81, LNG = 82.71;
const M_LNG = 1 / (111320 * Math.cos(LAT * Math.PI / 180));
const tok = (c) => `contributor-${c}`.padEnd(24, c);
let n = 0;
const report = (o = {}) => ({ id: `report-${++n}`, type: "pothole", severity: 2, lat: LAT, lng: LNG + (o.east || 0) * M_LNG, sigmaM: 4, heading: 90, t: T0, source: "sensor", ...o });

function setup(limits = { lowTrafficRiders: 0 }) {       // these tests are about agreement: the low-traffic privacy rules have their own
    const { db } = openServerDatabase(":memory:");
    let t = T0 + H;
    const rs = createRoadsense({ db: () => db, secret: () => "test-secret", now: () => t, limits });
    const tile = RS.tileOf(LAT, LNG);
    const area = async () => (await rs.area({ v: 1, tiles: [tile] })).json.hazards;
    return { db, rs, area, at: (v) => { t = v; } };
}

test("publish: a reviewed report becomes a hazard; stored with the hour only, a keyed contributor label, no token", async () => {
    const { db, rs, area } = setup();
    const r = await rs.publish({ v: 1, contributor: tok("a"), device: tok("x"), reports: [report({ t: T0 + 17 * 60000 })] });
    assert.equal(r.status, 200);
    assert.equal(r.json.results[0].created, true);
    assert.match(r.json.results[0].hazard, /^h[0-9a-f]{16}$/);
    const rows = [...db.prepare("SELECT * FROM roadsense_report").all(), ...db.prepare("SELECT * FROM roadsense_vote").all(), ...db.prepare("SELECT * FROM roadsense_hazard").all()];
    assert.ok(!JSON.stringify(rows).includes(tok("a")) && !JSON.stringify(rows).includes(tok("x")), "tokens never stored");
    assert.equal(db.prepare("SELECT t FROM roadsense_report").get().t % H, 0, "the hour only");
    assert.equal(db.prepare("SELECT contributor FROM roadsense_report").get().contributor, rs.contributorOf(tok("a")));
    const [h] = await area();
    assert.equal(h.status, "reviewed_report");
    assert.equal(h.found, 1);
    assert.equal(h.agreementPct, null);
    assert.equal(h.ptype, "impact");
    assert.equal(h.alertable, true);
});

test("duplicates and independence: a report 8 m away is a vote, not a second hazard; the same rider again is still one rider", async () => {
    const { rs, area, at } = setup();
    await rs.publish({ v: 1, contributor: tok("a"), device: tok("x"), reports: [report()] });
    // the same rider, next day, same pothole: one rider
    at(T0 + D + H);
    await rs.publish({ v: 1, contributor: tok("a"), device: tok("x"), reports: [report({ t: T0 + D, east: 3 })] });
    let hz = await area();
    assert.equal(hz.length, 1);
    assert.equal(hz[0].found, 1);
    assert.equal(hz[0].status, "reviewed_report");
    // another rider, 8 m off (their GPS), a day later: the same hazard, now confirmed
    at(T0 + 2 * D + H);
    const r = await rs.publish({ v: 1, contributor: tok("b"), device: tok("y"), reports: [report({ t: T0 + 2 * D, east: 8, type: "bump" })] });
    assert.equal(r.json.results[0].created, false);
    hz = await area();
    assert.equal(hz.length, 1, "still one hazard");
    assert.equal(hz[0].found, 2);
    assert.equal(hz[0].status, "community_confirmed");
    assert.equal(hz[0].independent, true);
    // the marker moved between the reports
    const x = (hz[0].lng - LNG) / M_LNG;
    assert.ok(x > 0 && x < 8, `marker at ${x.toFixed(1)} m`);
    // the other carriageway (heading 270), 10 m away: its own hazard
    await rs.publish({ v: 1, contributor: tok("c"), reports: [report({ t: T0 + 2 * D, east: 10, heading: 270 })] });
    assert.equal((await area()).length, 2);
});

test("votes: 8 of 10 reviewing riders; unsure outside; maybe fixed after 3 not-found on 2 days; a new 'found' later is a new epoch", async () => {
    const { rs, area, at } = setup();
    const r = await rs.publish({ v: 1, contributor: tok("a"), device: tok("x"), reports: [report()] });
    const id = r.json.results[0].hazard;
    at(T0 + 3 * D);
    for (const c of ["b", "c", "d", "e", "f", "g", "h"]) await rs.publish({ v: 1, contributor: tok(c), device: tok(`dev${c}`), votes: [{ hazard: id, verdict: "found", passage: PASSED, t: T0 + 2 * D }] });
    for (const c of ["i", "j"]) await rs.publish({ v: 1, contributor: tok(c), device: tok(`dev${c}`), votes: [{ hazard: id, verdict: "not_found", passage: PASSED, t: T0 + 2 * D + H }] });
    await rs.publish({ v: 1, contributor: tok("k"), device: tok("devk"), votes: [{ hazard: id, verdict: "unsure", passage: PASSED, t: T0 + 2 * D + H }] });
    let [h] = await area();
    assert.deepEqual([h.found, h.notFound, h.unsure, h.reviewers, h.agreementPct, h.status], [8, 2, 1, 10, 80, "community_confirmed"]);
    // later riders don't find it: 3 more not-found over 2 days → maybe fixed, not warned
    at(T0 + 6 * D);
    for (const [c, day] of [["l", 4], ["m", 4], ["o", 5]]) await rs.publish({ v: 1, contributor: tok(c), device: tok(`dev${c}`), votes: [{ hazard: id, verdict: "not_found", passage: PASSED, t: T0 + day * D }] });
    [h] = await area();
    assert.equal(h.status, "possibly_repaired");
    assert.equal(h.recentDisagree, true);
    assert.equal(h.alertable, false);
    // a week later it's fixed (not served any more); a fresh report there opens a new epoch on the same hazard
    at(T0 + 13 * D);
    assert.equal((await area()).length, 0);
    const again = await rs.publish({ v: 1, contributor: tok("p"), device: tok("devp"), reports: [report({ t: T0 + 13 * D - H })] });
    assert.equal(again.json.results[0].hazard, id);
    [h] = await area();
    assert.equal(h.status, "reviewed_report");
    assert.equal(h.found, 1);
    assert.equal(h.notFound, 0, "the old votes are the old pothole's");
});

test("refusals: bad input, inaccurate new hazards, unknown hazards, daily limits", async () => {
    const { rs } = setup();
    for (const body of [null, { v: 1, contributor: "short", reports: [report()] }, { v: 1, contributor: tok("a") }, { v: 1, contributor: tok("a"), reports: Array.from({ length: 51 }, () => report()) }]) {
        assert.equal((await rs.publish(body)).status, 400);
    }
    const r = await rs.publish({ v: 1, contributor: tok("a"), reports: [report({ type: "dragon" }), report({ severity: 5 }), report({ source: "official" }), report({ t: T0 - 40 * D }), report({ sigmaM: 45 })], votes: [{ hazard: "h0000000000000000", verdict: "found", passage: PASSED, t: T0 }, { hazard: "nope", verdict: "found", passage: PASSED, t: T0 }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.rejected.map((x) => `${x.kind}${x.i}`), ["report0", "report1", "report2", "report3", "report4", "vote0", "vote1"]);
    assert.match(r.json.rejected[4].error, /inaccurate/);
    // 100 reports a day per contributor
    const many = Array.from({ length: 50 }, (_, i) => report({ east: i * 40 }));
    assert.equal((await rs.publish({ v: 1, contributor: tok("z"), reports: many })).status, 200);
    assert.equal((await rs.publish({ v: 1, contributor: tok("z"), reports: Array.from({ length: 50 }, (_, i) => report({ east: 3000 + i * 40 })) })).status, 200);
    assert.equal((await rs.publish({ v: 1, contributor: tok("z"), reports: [report({ east: 9000 })] })).status, 429);
});

test("forget: a contributor's reports and votes go; a hazard only they reported goes with them, others keep their votes", async () => {
    const { rs, area, at } = setup();
    const a = await rs.publish({ v: 1, contributor: tok("a"), reports: [report(), report({ east: 500 })] });
    at(T0 + D);
    await rs.publish({ v: 1, contributor: tok("b"), votes: [{ hazard: a.json.results[0].hazard, verdict: "found", passage: PASSED, t: T0 + D - H }] });
    assert.equal((await area()).length, 2);
    const f = await rs.forget({ v: 1, riders: [], contributors: [tok("a")] });
    assert.equal(f.status, 200);
    assert.ok(f.json.deleted >= 4);
    const hz = await area();
    assert.equal(hz.length, 1, "the hazard b confirmed stays, with b's vote only");
    assert.equal(hz[0].found, 1);
    assert.equal((await rs.forget({ v: 1, riders: [], contributors: ["bad token!"] })).status, 400);
});

test("routes: /api/master/roadsense/publish is mounted", async () => {
    const { db } = openServerDatabase(":memory:");
    const rs = createRoadsense({ db: () => db, secret: () => "s" });
    const app = express();
    app.use("/api/master", createMasterApi({ express, rateLimit, roadsense: rs, providers: {} }).router);
    const { url, close } = await listen(app);
    try {
        const res = await fetch(`${url}/api/master/roadsense/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v: 1, contributor: tok("a"), reports: [report({ t: Date.now() - H })] }) });
        const j = await res.json();
        assert.equal(res.status, 200, JSON.stringify(j));
        assert.equal(j.results[0].created, true);
    } finally { await close(); }
});

test("a vote counts only with passage evidence; every answer stays in the audit history; the latest one counts", async () => {
    const { db, rs, area, at } = setup();
    const id = (await rs.publish({ v: 1, contributor: tok("a"), device: tok("x"), reports: [report()] })).json.results[0].hazard;
    at(T0 + D);
    // no passage: kept, outside the agreement
    let r = await rs.publish({ v: 1, contributor: tok("b"), votes: [{ hazard: id, verdict: "not_found", t: T0 + D - H }] });
    assert.equal(r.json.results[0].counts, false);
    // the phone wasn't sure the rider passed it (poor fix): same
    r = await rs.publish({ v: 1, contributor: tok("c"), votes: [{ hazard: id, verdict: "not_found", t: T0 + D - H, passage: { passed: true, quality: "poor", felt: false } }] });
    assert.equal(r.json.results[0].counts, false);
    let [h] = await area();
    assert.deepEqual([h.found, h.notFound], [1, 0], "neither counts");
    // b rides it again, with evidence, twice: one current row, two history rows for b
    await rs.publish({ v: 1, contributor: tok("b"), votes: [{ hazard: id, verdict: "found", t: T0 + D - 30 * 60000, passage: PASSED }] });
    at(T0 + 2 * D);
    await rs.publish({ v: 1, contributor: tok("b"), votes: [{ hazard: id, verdict: "not_found", t: T0 + 2 * D - H, passage: PASSED }] });
    [h] = await area();
    assert.deepEqual([h.found, h.notFound], [1, 1], "b's latest only");
    const b = rs.contributorOf(tok("b"));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM roadsense_vote WHERE contributor = ?").get(b).n, 1);
    assert.deepEqual(db.prepare("SELECT verdict, counts FROM roadsense_vote_history WHERE contributor = ? ORDER BY id").all(b).map((x) => [x.verdict, x.counts]), [["not_found", 0], ["found", 1], ["not_found", 1]]);
});

test("anonymous votes: unlinkable per-hazard tokens, one vote each, never confirm alone, never create a hazard", async () => {
    const { db, rs, area, at } = setup();
    const ids = [];
    for (const east of [0, 500]) ids.push((await rs.publish({ v: 1, contributor: tok("a"), reports: [report({ east })] })).json.results[0].hazard);
    at(T0 + D);
    const anon = (votes) => rs.publish({ v: 1, anonymous: true, votes }, { ip: "10.0.0.9" });
    let r = await anon([{ hazard: ids[0], verdict: "found", t: T0 + D - H, token: "per-hazard-token-aaaaaaa1", passage: PASSED }, { hazard: ids[1], verdict: "found", t: T0 + D - H, token: "per-hazard-token-bbbbbbb2", passage: PASSED }]);
    assert.equal(r.status, 200);
    // the same token again on the same hazard: still one vote
    await anon([{ hazard: ids[0], verdict: "found", t: T0 + D - 30 * 60000, token: "per-hazard-token-aaaaaaa1", passage: PASSED }]);
    let hz = await area();
    const first = hz.find((h) => h.id === ids[0]);
    assert.equal(first.found, 2);
    assert.equal(first.status, "reviewed_report", "anonymous votes alone never make it community-confirmed");
    // the two anonymous votes can't be joined: different stored voters
    const voters = db.prepare("SELECT contributor FROM roadsense_vote WHERE anon = 1").all().map((x) => x.contributor);
    assert.equal(new Set(voters).size, 2);
    // a new hazard needs a contributor; a token is required
    assert.equal((await rs.publish({ v: 1, anonymous: true, reports: [report()] }, { ip: "x" })).status, 400);
    r = await anon([{ hazard: ids[0], verdict: "found", t: T0 + D - H, passage: PASSED }]);
    assert.match(r.json.rejected[0].error, /token/);
    // an account rider confirming it does
    await rs.publish({ v: 1, contributor: tok("c"), votes: [{ hazard: ids[0], verdict: "found", t: T0 + D - H, passage: PASSED }] });
    hz = await area();
    assert.equal(hz.find((h) => h.id === ids[0]).status, "community_confirmed");
});

test("sensor evidence apart from testimony: felt by sensors on N rides, passed clean N times; never in the agreement", async () => {
    const { rs, area, at } = setup();
    const id = (await rs.publish({ v: 1, contributor: tok("a"), reports: [report()] })).json.results[0].hazard;     // sensor-origin: felt 1
    at(T0 + D);
    await rs.publish({ v: 1, contributor: tok("b"), votes: [{ hazard: id, verdict: "found", t: T0 + D - H, passage: { passed: true, quality: "good", felt: true } }] });
    await rs.publish({ v: 1, contributor: tok("c"), votes: [{ hazard: id, verdict: "unsure", t: T0 + D - H, passage: { passed: true, quality: "good", felt: false } }] });
    await rs.publish({ v: 1, contributor: tok("d"), votes: [{ hazard: id, verdict: "not_found", t: T0 + D - H, passage: { passed: true, quality: "fair", felt: false } }] });
    const [h] = await area();
    assert.deepEqual([h.sensorFelt, h.sensorClean], [2, 1], "felt on 2 rides; 1 clean pass with a good fix (the fair one isn't enough)");
    assert.deepEqual([h.found, h.notFound, h.unsure], [2, 1, 1], "the agreement is the riders' answers only");
});

test("route privacy: public times are days and buckets, never hours; hours become days after a month", async () => {
    const { db, rs, area, at } = setup();
    const IST = 5.5 * H;
    const id = (await rs.publish({ v: 1, contributor: tok("a"), reports: [report({ t: T0 + 17 * 60000 })] })).json.results[0].hazard;
    let [h] = await area();
    assert.equal(h.lastFoundBucket, "today");
    assert.equal((h.lastFoundAt + IST) % D, 0, "the start of the day (India time), not the hour");
    at(T0 + D + H);
    [h] = await area();
    assert.equal(h.lastFoundBucket, "yesterday");
    at(T0 + 4 * D);
    assert.equal((await area())[0].lastFoundBucket, "this_week");
    at(T0 + 9 * D);
    assert.equal((await area())[0].lastFoundBucket, "earlier");
    // a month later the stored hour itself is rounded down to the day (the purge runs with the next request)
    at(T0 + 31 * D + 2 * H);
    await rs.area({ v: 1, tiles: [RS.tileOf(LAT, LNG)] });
    assert.equal(db.prepare("SELECT t FROM roadsense_report").get().t % D, 0);
    assert.equal(db.prepare("SELECT t FROM roadsense_vote WHERE hazard_id = ?").get(id).t % D, 0);
});

test("low-traffic roads: one rider's report waits for a second rider or 48 h; few riders are shown as 'a few'", async () => {
    const { rs, area, at } = setup({});                          // the real rules
    const id = (await rs.publish({ v: 1, contributor: tok("a"), reports: [report()] })).json.results[0].hazard;
    assert.equal((await area()).length, 0, "held: on a quiet road one report can point at one person");
    // a second rider confirms it the next day: shown, with counts as "a few riders"
    at(T0 + D);
    await rs.publish({ v: 1, contributor: tok("b"), votes: [{ hazard: id, verdict: "found", t: T0 + D - H, passage: PASSED }] });
    let [h] = await area();
    assert.equal(h.lowTraffic, true);
    assert.equal(h.fewRiders, true);
    assert.equal(h.found, null, "no exact count");
    // another one-rider report: shown after 48 h even without a second rider
    const lone = (await rs.publish({ v: 1, contributor: tok("c"), reports: [report({ east: 800, t: T0 + D - H })] })).json.results[0].hazard;
    assert.ok(!(await area()).some((x) => x.id === lone));
    at(T0 + 3 * D + H);
    assert.ok((await area()).some((x) => x.id === lone));
    // a busy road (5+ riders in 30 days): normal counts, no hold
    for (const c of ["d", "e", "f"]) await rs.publish({ v: 1, contributor: tok(c), votes: [{ hazard: id, verdict: "found", t: T0 + 3 * D, passage: PASSED }] });
    const busy = (await area()).find((x) => x.id === id);
    assert.equal(busy.lowTraffic, false);
    assert.equal(busy.found, 5);
    const fresh = (await rs.publish({ v: 1, contributor: tok("g"), reports: [report({ east: 1600, t: T0 + 3 * D })] })).json.results[0].hazard;
    assert.ok((await area()).some((x) => x.id === fresh), "no hold on a busy road");
});

test("pilot scorecard (server part): states, independent confirmations and how fast, votes with passage", async () => {
    const { rs, at } = setup();
    const id = (await rs.publish({ v: 1, contributor: tok("a"), reports: [report()] })).json.results[0].hazard;
    await rs.publish({ v: 1, contributor: tok("a"), reports: [report({ east: 800 })] });
    at(T0 + 2 * D);
    await rs.publish({ v: 1, contributor: tok("b"), votes: [{ hazard: id, verdict: "found", t: T0 + 2 * D - H, passage: PASSED }] });
    await rs.publish({ v: 1, contributor: tok("c"), votes: [{ hazard: id, verdict: "not_found", t: T0 + 2 * D - H }] });   // no passage
    const sc = rs.scorecard();
    assert.deepEqual(sc.hazardsByState, { community_confirmed: 1, reviewed_report: 1 });
    assert.equal(sc.independentlyConfirmed, 1);
    assert.equal(sc.daysToIndependentConfirmation.median, 2);
    assert.deepEqual(sc.votes, { current: 4, withPassage: 3, anonymous: 0, history: 4 });
    assert.equal(sc.reportersLast30Days, 1);
});
