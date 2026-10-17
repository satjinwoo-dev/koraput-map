// RoadPulse reputation (lib/master/roadpulse-reputation.js + /roadsense/me): badges from accuracy that OTHER riders
// confirmed — not from report counts, repeated reports, the same phone, or kilometres.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openServerDatabase } = require("../../lib/server-db.js");
const { createRoadsense } = require("../../lib/master/roadsense.js");
const REP = require("../../lib/master/roadpulse-reputation.js");

// the phone confirmed the rider passed the spot, in its direction, with a good fix (passage attestation)
const PASSED = { passed: true, quality: "good", felt: null };
const H = 3600000, D = 24 * H;
const T0 = Date.UTC(2026, 5, 1, 6);
const tok = (c) => `contributor-${c}`.padEnd(24, c);
const LAT = 18.81, LNG = 82.71, M_LNG = 1 / (111320 * Math.cos(LAT * Math.PI / 180));
let n = 0;

function setup() {
    const { db } = openServerDatabase(":memory:");
    let t = T0;
    const rs = createRoadsense({ db: () => db, secret: () => "s", now: () => t, limits: { lowTrafficRiders: 0 } });   // privacy holds: their own tests
    return { rs, db, at: (v) => { t = v; }, now: () => t };
}
/** A reports a pothole k (500 m apart each) at time t; returns the hazard id */
async function report(w, who, k, t, dev = `dev-${who}`) {
    w.at(t + H);
    const r = await w.rs.publish({ v: 1, contributor: tok(who), device: tok(dev), reports: [{ id: `report-${++n}`, type: "pothole", severity: 2, lat: LAT, lng: LNG + k * 500 * M_LNG, sigmaM: 4, heading: 90, t, source: "sensor" }] });
    return r.json.results[0].hazard;
}
async function vote(w, who, hazard, verdict, t, dev = `dev-${who}`) {
    w.at(t + H);
    await w.rs.publish({ v: 1, contributor: tok(who), device: tok(dev), votes: [{ hazard, verdict, passage: PASSED, t }] });
}
const me = async (w, who) => (await w.rs.me({ v: 1, contributor: tok(who) })).json;

test("nothing confirmed, no badge: 30 reports nobody else found earn nothing", async () => {
    const w = setup();
    for (let k = 0; k < 30; k++) await report(w, "a", k, T0 + k * D);
    const r = await me(w, "a");
    assert.equal(r.reports, 30);
    assert.equal(r.confirmed, 0);
    assert.deepEqual(r.badges, []);
    assert.equal(r.next.id, "rasta_scout");
    assert.equal(r.next.needConfirmed, 5);
});

test("Rasta Scout: 5 reports another rider found; the same rider on the same phone, or a second account on it, doesn't count", async () => {
    const w = setup();
    const ids = [];
    for (let k = 0; k < 5; k++) ids.push(await report(w, "a", k, T0 + k * D));
    // a's second account on a's phone "confirms" everything: not independent
    for (const id of ids) await vote(w, "a2", id, "found", T0 + 6 * D, "dev-a");
    assert.equal((await me(w, "a")).confirmed, 0);
    // a friend riding together, 10 minutes later: not yet independent
    await vote(w, "b", ids[0], "found", T0 + 10 * 60000);
    assert.equal((await me(w, "a")).confirmed, 0);
    // other riders on other days
    for (const id of ids) await vote(w, "c", id, "found", T0 + 7 * D);
    const r = await me(w, "a");
    assert.equal(r.confirmed, 5);
    assert.equal(r.accuracy, 0.86);           // (5+1)/(5+0+2)
    assert.deepEqual(r.badges.map((b) => b.name), ["Rasta Scout"]);
});

test("accuracy falls with refuted reports and the badge goes by itself; a later 'not found' (repaired) doesn't refute", async () => {
    const w = setup();
    const good = [], bad = [];
    for (let k = 0; k < 5; k++) good.push(await report(w, "a", k, T0 + k * D));
    for (let k = 5; k < 9; k++) bad.push(await report(w, "a", k, T0 + k * D));
    for (const id of good) await vote(w, "c", id, "found", T0 + 10 * D);
    assert.deepEqual((await me(w, "a")).badges.map((b) => b.id), ["rasta_scout"]);
    // 4 reports two other riders didn't find within days: refuted → accuracy (5+1)/(5+4+2) = 0.55
    for (let i = 0; i < bad.length; i++) { await vote(w, "x", bad[i], "not_found", T0 + (5 + i) * D + 3 * H); await vote(w, "y", bad[i], "not_found", T0 + (5 + i) * D + 5 * H); }
    let r = await me(w, "a");
    assert.equal(r.refuted, 4);
    assert.equal(r.accuracy, 0.55);
    assert.deepEqual(r.badges, [], "revoked without anyone revoking it");
    // a confirmed pothole that riders later don't find (repaired) stays confirmed
    for (const id of good) { await vote(w, "x", id, "not_found", T0 + 40 * D); await vote(w, "y", id, "not_found", T0 + 41 * D); }
    r = await me(w, "a");
    assert.equal(r.confirmed, 5);
});

test("spam doesn't pay: the same pothole reported again counts once; more than 20 a day don't count", async () => {
    const w = setup();
    const id = await report(w, "a", 0, T0);
    for (let i = 1; i <= 5; i++) assert.equal(await report(w, "a", 0, T0 + i * D), id, "the same hazard");
    assert.equal((await me(w, "a")).reports, 1);
    const w2 = setup();
    for (let k = 0; k < 25; k++) {
        w2.at(T0 + H);
        await w2.rs.publish({ v: 1, contributor: tok("s"), reports: [{ id: `report-${++n}`, type: "pothole", severity: 2, lat: LAT, lng: LNG + k * 500 * M_LNG, sigmaM: 4, heading: 90, t: T0, source: "sensor" }] });
    }
    assert.equal((await me(w2, "s")).reports, 20);
});

test("the rules: Pakka Scout needs 3 months, Sadak Prahari 20 validated reviews, Ilaake ka Ustaad one area over 3 months; no Ghat Guardian on a guess", () => {
    const mk = (count, monthsSpan, area = 0) => Array.from({ length: count }, (_, i) => ({ hazard_id: `h${area}-${i}`, epoch: 0, device: "d", t: T0 + Math.floor(i * monthsSpan * 30 / count) * D, received: T0 + Math.floor(i * monthsSpan * 30 / count) * D + i, lat: LAT + area, lng: LNG }));
    const found = () => [{ contributor: "other", device: "o", verdict: "found", passage: PASSED, t: T0 + 400 * D, epoch: 0 }];
    // n reviews ("found" on others' hazards), each borne out by another rider later (found() returns one)
    const reviews = (n) => Array.from({ length: n }, (_, i) => ({ hazard_id: `x${i}`, epoch: 0, device: "d", verdict: "found", t: T0 }));
    const rep = (reports, reviewsGiven = 0) => REP.reputationOf({ contributor: "me", reports, votesOf: found, reviewsGiven, reviews: reviews(reviewsGiven) });
    assert.deepEqual(rep(mk(25, 1)).badges.map((b) => b.id), ["rasta_scout"], "25 in one month: not Pakka, not Ustaad yet");
    assert.ok(rep(mk(25, 3)).badges.some((b) => b.id === "pakka_scout"));
    assert.ok(rep(mk(25, 3)).badges.some((b) => b.id === "ilaake_ka_ustaad"), "20+ in one area over 3 months");
    assert.ok(!rep(mk(100, 4)).badges.some((b) => b.id === "sadak_prahari"), "100 confirmed but no validated reviews");
    assert.ok(rep(mk(100, 4), 20).badges.some((b) => b.id === "sadak_prahari"));
    assert.ok(!REP.RULES.badges.some((b) => b.id === "ghat_guardian"), "needs a ghat-road tag first");
    for (const b of REP.RULES.badges) assert.ok(!/km|speed|distance|like/i.test(JSON.stringify(b)), "never km, speed or likes");
});

test("reviews earn credit only when LATER evidence from others bears them out; a true 'not found' (repaired) counts too", async () => {
    const w = setup();
    const ids = [];
    for (let k = 0; k < 3; k++) ids.push(await report(w, "rep", k, T0));
    // me: found on 0, not found on 1, found on 2
    await vote(w, "me", ids[0], "found", T0 + D);
    await vote(w, "me", ids[1], "not_found", T0 + D);
    await vote(w, "me", ids[2], "found", T0 + D);
    // agreeing with what others said BEFORE earns nothing: only later evidence counts
    let r = await me(w, "me");
    assert.deepEqual([r.reviewsValidated, r.reviewsRefuted], [0, 0]);
    // later: another rider finds 0; two others don't find 1 (it was repaired) and nobody finds it; two others don't find 2
    await vote(w, "x", ids[0], "found", T0 + 2 * D);
    for (const who of ["y", "z"]) { await vote(w, who, ids[1], "not_found", T0 + 3 * D); await vote(w, who, ids[2], "not_found", T0 + 3 * D); }
    r = await me(w, "me");
    assert.deepEqual([r.reviewsValidated, r.reviewsRefuted], [2, 1], "0 and 1 borne out; 2 refuted");
});

test("community thanks: one per rider and hazard, shown to the reporter, never part of accuracy", async () => {
    const w = setup();
    const id = await report(w, "rep", 0, T0);
    for (const who of ["a", "b", "b"]) { w.at(T0 + D); await w.rs.publish({ v: 1, contributor: tok(who), thanks: [id] }); }
    await w.rs.publish({ v: 1, contributor: tok("rep"), thanks: [id] });            // thanking oneself: ignored
    const r = await me(w, "rep");
    assert.equal(r.thanksReceived, 2);
    assert.equal(r.confirmed, 0, "thanks confirm nothing");
    const [h] = (await w.rs.area({ v: 1, tiles: [require("../../public/js/master/roadsense/roadsense.js").tileOf(LAT, LNG)] })).json.hazards;
    assert.equal(h.thanks, 2);
    assert.equal(h.found, 1);
});
