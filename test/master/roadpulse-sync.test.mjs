// RoadPulse on the phone (public/js/master/roadsense/sync.js): nothing detected leaves the phone until the rider
// reviews and publishes it; published reports wait a random 0–2 h; hazards come back with what riders said.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const RS = require("../../public/js/master/roadsense/roadsense.js");
const SY = require("../../public/js/master/roadsense/sync.js");
const { openServerDatabase } = require("../../lib/server-db.js");
const { createRoadsense } = require("../../lib/master/roadsense.js");

// the phone confirmed the rider passed the spot, in its direction, with a good fix (passage attestation)
const PASSED = { passed: true, quality: "good", felt: null };
const T0 = Date.UTC(2026, 9, 17, 6), MIN = 60000, H = 3600000, D = 24 * H;
const LAT = 18.81, LNG = 82.71, M_LNG = 1 / (111320 * Math.cos(LAT * Math.PI / 180));
const memStore = () => { const m = new Map(); return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)) }; };
const tile = RS.tileOf(LAT, LNG);

function world() {
    let t = T0;
    const { db } = openServerDatabase(":memory:");
    const server = createRoadsense({ db: () => db, secret: () => "server-secret", now: () => t });
    const calls = [];
    function phone(name) {
        const api = {
            async post(path, body) {
                calls.push({ phone: name, path, body: JSON.parse(JSON.stringify(body)) });
                const fn = { "/roadsense/upload": server.upload, "/roadsense/area": server.area, "/roadsense/forget": server.forget, "/roadsense/publish": server.publish, "/roadsense/cover": server.cover, "/roadsense/me": server.me }[path];
                const r = await fn(JSON.parse(JSON.stringify(body)), { ip: name });
                return { ok: r.status === 200 && r.json.ok !== false, status: r.status, data: JSON.parse(JSON.stringify(r.json)), reason: r.json.reason };
            }
        };
        const log = RS.createLog(), cover = RS.createCoverage();
        const sync = SY.createSync({ RS, log, cover, store: memStore(), api, now: () => t });
        return { name, log, cover, sync };
    }
    return { db, server, phone, calls, at: (v) => { t = v; }, now: () => t };
}
let n = 0;
const report = (o = {}) => ({ id: `review-${++n}-abcdef`, type: "pothole", severity: 2, lat: LAT, lng: LNG + (o.east || 0) * M_LNG, sigmaM: 4, heading: 90, t: T0, source: "sensor", ...o });

test("the phone's detections never go up on their own: no raw upload, even with sharing on", async () => {
    const w = world();
    const a = w.phone("A");
    a.sync.setConsent(true);
    a.log.add({ type: "pothole", t: T0, lat: LAT, lng: LNG, source: "imu", rider: "self", present: true, conf: 0.85, peakMs2: 15 });
    a.cover.add({ cell: a.cover.cellOf(LAT, LNG), t: T0, rider: RS.SELF });
    w.at(T0 + 3 * H);
    await a.sync.flush();
    assert.deepEqual(w.calls.filter((c) => c.path !== "/roadsense/area").map((c) => c.path), [], "nothing sent");
    const st = w.server.stats();
    assert.equal(st.stored, 0);
    assert.equal(st.coverStored, 0, "smooth passes wait for the rider's approval");
    // publishing while sharing is off: refused, nothing queued
    const b = w.phone("B");
    assert.deepEqual(b.sync.publish({ reports: [report()] }), { ok: false, reason: "sharing-off", queued: 0 });
});

test("published after review: waits a random 0–2 h, then lands as a hazard; other phones get it with its counts", async () => {
    const w = world();
    const a = w.phone("A"), b = w.phone("B");
    a.sync.setConsent(true); b.sync.setConsent(true);
    w.at(T0 + 30 * MIN);                                     // the review, after the ride
    assert.equal(a.sync.publish({ reports: [report()] }).queued, 1);
    assert.equal(a.sync.status().publishQueued, 1);
    // never at once: the delay is drawn per item (0..2 h); after 2 h it has surely gone
    w.at(T0 + 30 * MIN + 2 * H + MIN);
    await a.sync.flush();
    const pub = w.calls.find((c) => c.path === "/roadsense/publish");
    assert.ok(pub, "sent");
    assert.match(pub.body.contributor, /^[A-Za-z0-9_-]{16,64}$/);
    assert.equal(a.sync.status().publishQueued, 0);
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM roadsense_hazard").get().n, 1);
    // B fetches the tile: the hazard, as "1 rider reported"
    await b.sync.fetchTiles([tile]);
    const [h] = b.sync.hazards();
    assert.equal(h.status, "reviewed_report");
    assert.equal(h.found, 1);
    assert.equal(h.agreementPct, null);
    assert.equal(h.mine, false);
    // A gets its own back, marked as its own (no "did you find it?" on your own report)
    await a.sync.fetchTiles([tile]);
    assert.equal(a.sync.hazards()[0].mine, true);
    // B rode past it the next day and found it: a vote → active
    w.at(T0 + D);
    b.sync.publish({ votes: [{ hazard: h.id, verdict: "found", passage: PASSED, t: T0 + D - H }] });
    w.at(T0 + D + 2 * H + MIN);
    await b.sync.flush();
    w.at(T0 + D + 3 * H);                                    // the tile is fetched again after 15 min
    await b.sync.fetchTiles([tile]);
    const [h2] = b.sync.hazards();
    assert.equal(h2.status, "community_confirmed");
    assert.equal(h2.found, 2);
});

test("private zones: a report near where a ride started or ended never leaves the phone", async () => {
    const w = world();
    const a = w.phone("A");
    a.sync.setConsent(true);
    a.sync.markPrivate(LAT, LNG);
    a.sync.publish({ reports: [report({ east: 100 }), report({ east: 1000 })] });
    w.at(T0 + 3 * H);
    await a.sync.flush();
    const sent = w.calls.filter((c) => c.path === "/roadsense/publish").flatMap((c) => c.body.reports);
    assert.equal(sent.length, 1);
    assert.ok(Math.abs((sent[0].lng - LNG) / M_LNG - 1000) < 1);
    assert.equal(a.sync.status().privateDropped, 1);
});

test("smooth passes go up only for a ride the rider approved", async () => {
    const w = world();
    const a = w.phone("A");
    a.sync.setConsent(true);
    a.cover.add({ cell: a.cover.cellOf(LAT, LNG), t: T0, rider: RS.SELF });
    a.cover.add({ cell: a.cover.cellOf(LAT, LNG + 3000 * M_LNG), t: T0 + 5 * H, rider: RS.SELF });   // another ride
    a.sync.approveCover(T0 - MIN, T0 + H);                    // the first ride's review: "share ridden-clean stretches"
    w.at(T0 + 6 * H);
    await a.sync.flush();
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM roadsense_cover").get().n, 1);
    assert.equal(a.sync.status().coverQueued, 1, "the other ride's pass waits for its own review (dropped after a week)");
    w.at(T0 + 8 * D);
    await a.sync.flush();
    assert.equal(a.sync.status().coverQueued, 0);
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM roadsense_cover").get().n, 1);
});

test("delete my road reports: the contributor's reports and votes go; a new contributor from then on", async () => {
    const w = world();
    const a = w.phone("A");
    a.sync.setConsent(true);
    a.sync.publish({ reports: [report()] });
    w.at(T0 + 3 * H);
    await a.sync.flush();
    const first = w.calls.find((c) => c.path === "/roadsense/publish").body.contributor;
    const r = await a.sync.forgetAll();
    assert.equal(r.ok, true);
    assert.ok(r.deleted >= 2);
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM roadsense_hazard").get().n, 0);
    const forget = w.calls.find((c) => c.path === "/roadsense/forget");
    assert.deepEqual(forget.body.contributors, [first]);
    a.sync.publish({ reports: [report({ east: 500 })] });
    w.at(T0 + 6 * H);
    await a.sync.flush();
    const second = w.calls.filter((c) => c.path === "/roadsense/publish").at(-1).body.contributor;
    assert.notEqual(second, first, "a fresh contributor token");
});

test("reputation: the rider's own reports, confirmed by others, from the server; nothing before the first publish", async () => {
    const w = world();
    const a = w.phone("A"), b = w.phone("B");
    a.sync.setConsent(true); b.sync.setConsent(true);
    assert.equal(await a.sync.reputation(), null, "no contributor yet: nothing to ask");
    a.sync.publish({ reports: [report()] });
    w.at(T0 + 3 * H);
    await a.sync.flush();
    let r = await a.sync.reputation();
    assert.deepEqual([r.reports, r.confirmed, r.pending, r.badges.length], [1, 0, 1, 0]);
    await b.sync.fetchTiles([tile]);
    b.sync.publish({ votes: [{ hazard: b.sync.hazards()[0].id, verdict: "found", passage: PASSED, t: T0 + D }] });
    w.at(T0 + D + 3 * H);
    await b.sync.flush();
    r = await a.sync.reputation();
    assert.equal(r.confirmed, 1);
    assert.equal(r.next.needConfirmed, 4);
});

test("anonymous answers: votes go without the contributor, each with its own per-hazard token; reports still under the contributor", async () => {
    const w = world();
    const a = w.phone("A"), b = w.phone("B");
    a.sync.setConsent(true); b.sync.setConsent(true);
    a.sync.publish({ reports: [report(), report({ east: 600 })] });
    w.at(T0 + 3 * H);
    await a.sync.flush();
    await b.sync.fetchTiles([tile]);
    assert.equal(b.sync.setVoteMode("anonymous"), "anonymous");
    const [h1, h2] = b.sync.hazards();
    b.sync.publish({ reports: [report({ east: 1500 })], votes: [{ hazard: h1.id, verdict: "found", t: T0 + D, passage: PASSED }, { hazard: h2.id, verdict: "not_found", t: T0 + D, passage: PASSED }] });
    w.at(T0 + D + 3 * H);
    await b.sync.flush();
    const calls = w.calls.filter((c) => c.phone === "B" && c.path === "/roadsense/publish");
    const anon = calls.find((c) => c.body.anonymous), acct = calls.find((c) => !c.body.anonymous);
    assert.equal(anon.body.contributor, undefined);
    assert.equal(anon.body.device, undefined);
    assert.equal(anon.body.votes.length, 2);
    assert.notEqual(anon.body.votes[0].token, anon.body.votes[1].token, "a different token per hazard: they can't be joined");
    assert.ok(anon.body.votes.every((v) => !v.token.includes(acct.body.contributor)));
    assert.equal(acct.body.reports.length, 1, "a new hazard goes under the contributor");
    assert.equal(acct.body.votes.length, 0);
    w.at(T0 + D + 4 * H);
    await b.sync.fetchTiles([tile]);
    const after = Object.fromEntries(b.sync.hazards().map((h) => [h.id, h]));
    assert.equal(after[h1.id].found, 2);
    assert.equal(after[h1.id].status, "reviewed_report", "anonymous alone doesn't confirm");
    assert.equal(after[h2.id].notFound, 1);
});
