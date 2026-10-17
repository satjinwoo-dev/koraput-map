// RoadPulse community agreement (public/js/master/roadsense/agreement.js): counts of riders who reviewed a hazard,
// never a probability; non-reviewers never count as "no".
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const A = require("../../public/js/master/roadsense/agreement.js");

const H = 3600000, D = 24 * H;
const T0 = Date.UTC(2026, 9, 17, 6);
const hz = (o = {}) => ({ type: "pothole", epoch: 0, firstReportedAt: T0, reporter: "rep", reporterDevice: "dRep", ...o });
const vote = (contributor, verdict, t, o = {}) => ({ contributor, device: `d${contributor}`, verdict, t, epoch: 0, ...o });
const reportVote = vote("rep", "found", T0, { device: "dRep" });

test("one report: 'reported', warned, no percentage", () => {
    const s = A.summarize(hz(), [reportVote], T0 + H);
    assert.equal(s.status, "reported");
    assert.equal(s.found, 1);
    assert.equal(s.reviewers, 1);
    assert.equal(s.agreement, null, "1 of 1 is never shown as 100%");
    assert.equal(s.alertable, true);
    assert.equal(s.independent, false);
});

test("independent confirmation: another rider, another device, 2 h later", () => {
    // the same rider again: still one rider, still 'reported'
    assert.equal(A.summarize(hz(), [reportVote, vote("rep", "found", T0 + 5 * H, { device: "dRep" })], T0 + 6 * H).status, "reported");
    // a second account on the reporter's phone: not independent
    assert.equal(A.summarize(hz(), [reportVote, vote("alt", "found", T0 + 5 * H, { device: "dRep" })], T0 + 6 * H).status, "reported");
    // another rider 10 minutes later (riding together): not yet independent
    assert.equal(A.summarize(hz(), [reportVote, vote("b", "found", T0 + 10 * 60000)], T0 + H).status, "reported");
    // another rider the next day: active
    const s = A.summarize(hz(), [reportVote, vote("b", "found", T0 + D)], T0 + D + H);
    assert.equal(s.status, "active");
    assert.equal(s.found, 2);
});

test("agreement = found / (found + not found); unsure kept but outside; non-reviewers never count", () => {
    const votes = [reportVote, ...["a", "b", "c", "d", "e", "f", "g"].map((c, i) => vote(c, "found", T0 + D + i * H)), vote("x", "not_found", T0 + D + 8 * H), vote("y", "not_found", T0 + D + 9 * H), vote("u1", "unsure", T0 + D + 10 * H), vote("u2", "unsure", T0 + D + 11 * H)];
    const s = A.summarize(hz(), votes, T0 + 2 * D);
    assert.equal(s.found, 8);
    assert.equal(s.notFound, 2);
    assert.equal(s.unsure, 2);
    assert.equal(s.reviewers, 10);
    assert.equal(s.agreementPct, 80, "8 of 10 reviewing riders");
    assert.equal(s.status, "active");
    // 2 reviewers only: counts, no percentage
    assert.equal(A.summarize(hz(), [reportVote, vote("x", "not_found", T0 + D)], T0 + D + H).agreement, null);
});

test("one vote per rider: the latest; repeated crossings don't add votes", () => {
    const votes = [reportVote, vote("b", "found", T0 + D), vote("b", "found", T0 + D + H), vote("b", "found", T0 + 2 * D), vote("b", "not_found", T0 + 3 * D)];
    const s = A.summarize(hz(), votes, T0 + 3 * D + H);
    assert.equal(s.found, 1);
    assert.equal(s.notFound, 1);
});

test("recent riders disagree → 'condition may have changed'; 3 on 2 days → maybe fixed; 7 days more → fixed; not warned", () => {
    const base = [reportVote, vote("b", "found", T0 + D)];
    const two = [...base, vote("x", "not_found", T0 + 2 * D), vote("y", "not_found", T0 + 2 * D + H)];
    const s2 = A.summarize(hz(), two, T0 + 2 * D + 2 * H);
    assert.equal(s2.recentDisagree, true);
    assert.equal(s2.status, "active", "2 riders aren't enough to call it fixed");
    // 3 not found but all on one day: not yet
    const sameDay = [...two, vote("z", "not_found", T0 + 2 * D + 2 * H)];
    assert.equal(A.summarize(hz(), sameDay, T0 + 2 * D + 3 * H).status, "active");
    // the third on another day: maybe fixed, not warned
    const three = [...two, vote("z", "not_found", T0 + 3 * D)];
    const s3 = A.summarize(hz(), three, T0 + 3 * D + H);
    assert.equal(s3.status, "maybe_fixed");
    assert.equal(s3.alertable, false);
    assert.equal(A.summarize(hz(), three, T0 + 10 * D + H).status, "fixed");
    // official repair data: fixed at once
    assert.equal(A.summarize(hz({ fixedAt: T0 + D }), base, T0 + D + H).status, "fixed");
    // a "found" on a fixed hazard opens a new epoch, and the old votes don't count in it
    const fixed = A.summarize(hz(), three, T0 + 10 * D + H);
    assert.equal(A.epochFor(hz(), fixed, "found"), 1);
    assert.equal(A.epochFor(hz(), fixed, "not_found"), 0);
    const reborn = A.summarize(hz({ epoch: 1, firstReportedAt: T0 + 11 * D, reporter: "n" }), [...three, vote("n", "found", T0 + 11 * D, { epoch: 1 })], T0 + 11 * D + H);
    assert.equal(reborn.status, "reported");
    assert.equal(reborn.found, 1);
    assert.equal(reborn.notFound, 0);
});

test("disputed: 3+ reviewers and under 40% agreement — on the map, never warned", () => {
    const votes = [reportVote, vote("x", "not_found", T0 + D), vote("y", "not_found", T0 + D + H), vote("z", "not_found", T0 + D + 2 * H)];
    // these three are also "after the last found", on one day: maybe_fixed needs 2 days, so disputed
    const s = A.summarize(hz(), votes, T0 + D + 3 * H);
    assert.equal(s.agreementPct, 25);
    assert.equal(s.status, "disputed");
    assert.equal(s.alertable, false);
});

test("old reports expire by kind: a pothole after 30 days, a speed breaker after a year", () => {
    assert.equal(A.summarize(hz(), [reportVote], T0 + 31 * D).status, "expired");
    assert.equal(A.summarize(hz({ type: "speed_breaker" }), [reportVote], T0 + 31 * D).status, "reported");
    assert.equal(A.summarize(hz({ type: "speed_breaker" }), [reportVote], T0 + 366 * D).status, "expired");
    // a fresh "found" keeps it alive
    assert.equal(A.summarize(hz(), [reportVote, vote("b", "found", T0 + 25 * D)], T0 + 40 * D).status, "active");
});

test("duplicates: same type group, within 15 m (or 2σ), same direction; opposite directions stay separate", () => {
    const h = { id: "h1", type: "pothole", lat: 18.81, lng: 82.71, heading: 90 };
    const at = (m, heading, o = {}) => ({ type: "bump", lat: 18.81, lng: 82.71 + m / (111320 * Math.cos(18.81 * Math.PI / 180)), heading, sigmaM: 4, ...o });
    assert.equal(A.findMatch([h], at(10, 80)), h, "a bump 10 m away, same direction: the same impact hazard");
    assert.equal(A.findMatch([h], at(10, 270)), null, "the other carriageway");
    assert.equal(A.findMatch([{ ...h, bothWays: true }], at(10, 270)).id, "h1", "a rider said both sides");
    assert.equal(A.findMatch([h], at(25, 90)), null, "too far");
    assert.equal(A.findMatch([h], at(25, 90, { sigmaM: 14 })), h, "within 2σ of a poor fix");
    assert.equal(A.findMatch([h], at(5, 90, { type: "rough" })), null, "rough road is another kind");
    assert.equal(A.publicType("speed_breaker"), "impact");
    assert.equal(A.publicType("rough"), "rough");
});

test("the marker from many reports: accuracy-weighted, one bad fix can't drag it", () => {
    const lng = (m) => 82.71 + m / (111320 * Math.cos(18.81 * Math.PI / 180));
    const m = A.mergePosition([{ lat: 18.81, lng: lng(0), sigmaM: 3 }, { lat: 18.81, lng: lng(2), sigmaM: 3 }, { lat: 18.81, lng: lng(1), sigmaM: 3 }, { lat: 18.81, lng: lng(60), sigmaM: 3 }]);
    const x = (m.lng - 82.71) * 111320 * Math.cos(18.81 * Math.PI / 180);
    assert.ok(Math.abs(x - 1) < 0.5, `marker at ${x.toFixed(2)} m`);
    assert.equal(m.used, 3);
    assert.ok(m.sigmaM < 3, "more reports, a tighter marker");
});
