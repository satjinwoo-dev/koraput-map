// RoadSense Live (public/js/master/roadsense/roadsense.js): the road event log and its verification and expiry rules
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const RS = require("../../public/js/master/roadsense/roadsense.js");
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const T0 = 1791700000000, MIN = 60000, H = 3600000, D = 24 * H;
const LAT = 18.81, LNG = 82.71;                                // Koraput
const M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos(LAT * Math.PI / 180));
/** an observation `east` metres east of the spot */
const ob = (o = {}) => ({ type: "bump", t: T0, lat: LAT, lng: LNG + (o.east || 0) * M_LNG, source: "imu", rider: "self", present: true, conf: 0.7, ...o });
const memStore = () => { const m = new Map(); return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)), raw: m }; };

test("observations: bad ones are refused, never guessed; a missing conf takes the source's prior", () => {
    assert.equal(RS.validateObservation(ob()).ok, true);
    for (const [o, why] of [
        [{ type: "unicorn" }, /unknown type/], [{ source: "rumour" }, /unknown source/], [{ t: 0 }, /t is required/],
        [{ lat: NaN }, /lat, lng/], [{ lat: 95 }, /lat, lng/], [{ present: "yes" }, /present/], [{ rider: "" }, /rider/],
        [{ conf: 1.4 }, /conf/], [{ peakMs2: "big" }, /peakMs2/]
    ]) {
        const v = RS.validateObservation(ob(o));
        assert.equal(v.ok, false, JSON.stringify(o));
        assert.match(v.error, why);
    }
    const r = RS.validateObservation(ob({ source: "rider", conf: undefined, peakMs2: -14.2 }));
    assert.equal(r.obs.conf, RS.SOURCES.rider.defaultConf);
    assert.equal(r.obs.peakMs2, 14.2, "a shock's size, not its sign");
    for (const t of Object.values(RS.TYPES)) assert.ok(t.halfLifeMs > 0 && t.maxAgeMs > t.halfLifeMs && t.clearPasses >= 1 && t.basis === "prior");
});

test("the log: sightings within 12 m are one spot; further apart, or a different kind of thing, are separate", () => {
    const log = RS.createLog();
    const a = log.add(ob());
    assert.equal(log.add(ob({ east: 8, t: T0 + 2 * MIN })).id, a.id, "8 m away: GNSS error, same pothole");
    assert.notEqual(log.add(ob({ east: 30 })).id, a.id, "30 m away: another one");
    assert.notEqual(log.add(ob({ type: "waterlogging", source: "camera" })).id, a.id, "water on the same spot is a different event");
    assert.equal(log.size(), 3);
    // the spot is the mean of the sightings
    const e = log.get(a.id, T0 + 3 * MIN);
    assert.ok(Math.abs((e.lng - LNG) / M_LNG - 4) < 0.1, `${(e.lng - LNG) / M_LNG} m`);
    // a camera naming it makes the IMU's "bump" a pothole (same group, more specific)
    assert.equal(log.add(ob({ type: "pothole", source: "camera", east: 2 })).id, a.id);
    assert.equal(log.get(a.id, T0 + 3 * MIN).type, "pothole");
    // "not there" never creates an event
    assert.deepEqual(log.add(ob({ present: false, east: 500 })), { ok: true, id: null, error: null });
    assert.equal(log.size(), 3);
    assert.equal(log.add({ ...ob(), type: "nope" }).ok, false);
});

test("verification: one pass is a candidate; a second pass, another rider, or a second sensor verifies", () => {
    const at = (list, now) => { const log = RS.createLog(); let id; for (const o of list) id = log.add(o).id || id; return log.get(id, now); };
    // one pass: two jolts 20 s apart from the same rider are still one pass
    const one = at([ob(), ob({ t: T0 + 20000 })], T0 + MIN);
    assert.equal(one.status, "candidate");
    assert.equal(one.passes, 1);
    // the same phone, 2 separate passes (≥ 60 s apart): the old dynamics rule, kept
    const two = at([ob(), ob({ t: T0 + 5 * MIN })], T0 + 6 * MIN);
    assert.equal(two.status, "verified");
    assert.equal(two.passes, 2);
    assert.ok(Math.abs(two.confidence - 0.91) < 0.001, `noisy-OR of two fresh 0.7s: ${two.confidence}`);
    // two riders at the same moment
    const riders = at([ob({ rider: "a" }), ob({ rider: "b", t: T0 + 1000 })], T0 + MIN);
    assert.equal(riders.status, "verified");
    assert.equal(riders.riders, 2);
    // IMU felt it and the camera saw it on the same pass: two independent sensors
    const sensors = at([ob(), ob({ type: "pothole", source: "camera", t: T0 + 500 })], T0 + MIN);
    assert.equal(sensors.status, "verified");
    assert.deepEqual(sensors.sources, { imu: 1, camera: 1 });
    // a weak single report stays a candidate; an official feed verifies alone
    assert.equal(at([ob({ source: "rider", rider: "a", conf: undefined })], T0 + MIN).status, "candidate");
    assert.equal(at([ob({ type: "waterlogging", source: "official", rider: "imd", conf: undefined, ref: "IMD nowcast" })], T0 + MIN).status, "verified");
    // two passes of near-zero confidence aren't enough: confidence must reach verifyConf too
    assert.equal(at([ob({ conf: 0.2 }), ob({ conf: 0.2, t: T0 + 5 * MIN })], T0 + 6 * MIN).status, "candidate");
});

test("expiry: evidence fades with each kind's half-life; water on the road is gone in hours, a pothole in weeks", () => {
    const log = RS.createLog();
    const w = log.add(ob({ type: "waterlogging", source: "camera" })).id;
    log.add(ob({ type: "waterlogging", source: "camera", rider: "b", t: T0 + MIN }));
    const p = log.add(ob({ east: 100 })).id;
    log.add(ob({ east: 100, t: T0 + 5 * MIN }));
    assert.equal(log.get(w, T0 + 10 * MIN).status, "verified");
    assert.equal(log.get(w, T0 + 6 * H).status, "candidate", "two half-lives on: faded below verifyConf");
    assert.equal(log.get(w, T0 + 12 * H).status, "expired");
    assert.equal(log.get(p, T0 + 7 * D).status, "verified", "a pothole a week later");
    assert.equal(log.get(p, T0 + 200 * D).status, "expired", "past its maxAge");
    // "valid until": the estimate agrees with the rule
    const until = log.get(w, T0 + 10 * MIN).expiresAt;
    assert.ok(until > T0 + 6 * H && until < T0 + 12 * H, `${(until - T0) / H} h`);
    assert.notEqual(log.get(w, until - 2 * MIN).status, "expired");
    assert.equal(log.get(w, until + 2 * MIN).status, "expired");
    assert.equal(RS.weight({ t: T0, conf: 0.8 }, H, T0 + H), 0.4);
});

test("riding over it with nothing felt: clean passes after the last sighting lower belief, and enough of them clear it", () => {
    const log = RS.createLog();
    const id = log.add(ob()).id;
    log.add(ob({ t: T0 + 5 * MIN }));
    const clean = (t, o = {}) => log.add(ob({ present: false, t, ...o }));
    const c0 = log.get(id, T0 + 10 * MIN).confidence;
    clean(T0 + 10 * MIN);
    const c1 = log.get(id, T0 + 10 * MIN);
    assert.ok(c1.confidence < c0 && c1.confidence > 0.5, `${c0} → ${c1.confidence}`);
    assert.equal(c1.status, "verified", "one clean pass isn't proof: the rider may have gone round it");
    clean(T0 + 10 * MIN + 20000);                                  // the same pass again: counts once
    assert.equal(log.get(id, T0 + 11 * MIN).absentPasses, 1);
    clean(T0 + 20 * MIN, { rider: "b" });
    clean(T0 + 30 * MIN);
    const gone = log.get(id, T0 + 31 * MIN);
    assert.equal(gone.status, "cleared");
    assert.equal(gone.absentPasses, 3);
    // it came back: a new jolt makes the old clean passes irrelevant
    log.add(ob({ t: T0 + 40 * MIN }));
    const back = log.get(id, T0 + 41 * MIN);
    assert.equal(back.absentPasses, 0);
    assert.equal(back.status, "verified");
    // an IMU can't feel water: its clean passes don't clear waterlogging
    const w = log.add(ob({ type: "waterlogging", source: "camera", east: 200 })).id;
    log.add(ob({ type: "waterlogging", source: "camera", east: 200, rider: "b" }));
    for (let i = 1; i <= 3; i++) log.add(ob({ type: "waterlogging", source: "imu", present: false, east: 200, t: T0 + i * 5 * MIN }));
    assert.equal(log.get(w, T0 + 20 * MIN).absentPasses, 0);
    for (let i = 1; i <= 2; i++) log.add(ob({ type: "waterlogging", source: "camera", present: false, east: 200, t: T0 + i * 5 * MIN }));
    assert.equal(log.get(w, T0 + 20 * MIN).status, "cleared", "two clean camera passes clear it");
});

test("the Truth Card line: 'unknown' when there's no evidence, else the best-supported event with its sources and age", () => {
    const log = RS.createLog();
    assert.deepEqual(log.truthAt({ lat: LAT, lng: LNG, now: T0 }), { status: "unknown", events: [] });
    log.add(ob({ source: "rider", rider: "a", type: "pothole" }));
    log.add(ob({ type: "waterlogging", source: "camera", rider: "b" }));
    log.add(ob({ type: "waterlogging", source: "camera", rider: "c", t: T0 + MIN }));
    const card = log.truthAt({ lat: LAT, lng: LNG, now: T0 + 2 * MIN });
    assert.equal(card.status, "verified");
    assert.equal(card.events[0].type, "waterlogging");
    assert.equal(card.events[0].riders, 2);
    assert.equal(card.events[0].lastSeen, T0 + MIN);
    assert.ok(card.events[0].expiresAt > T0 + 2 * MIN);
    assert.equal(card.events[1].status, "candidate");
    // far away: unknown, never "clear"
    assert.equal(log.truthAt({ lat: LAT + 0.01, lng: LNG, now: T0 }).status, "unknown");
});

test("storage: saved and loaded intact; expired and cleared events pruned; least recently seen go first beyond the cap", () => {
    const store = memStore();
    const log = RS.createLog({ store });
    const id = log.add(ob()).id;
    log.add(ob({ t: T0 + 5 * MIN }));
    log.add(ob({ east: 100, type: "animal", source: "camera" }));
    assert.equal(log.save(), true);
    assert.equal(log.save(), false, "nothing changed");
    const again = RS.createLog({ store });
    assert.equal(again.load(), 2);
    assert.deepEqual(again.get(id, T0 + 6 * MIN), log.get(id, T0 + 6 * MIN));
    assert.equal(again.query({ lat: LAT, lng: LNG, radiusM: 5, now: T0 + 6 * MIN })[0].id, id, "the index is rebuilt");
    assert.equal(again.prune(T0 + 3 * H), 1, "the animal is long gone");
    assert.deepEqual(again.stats(T0 + 3 * H), { events: 1, candidate: 0, verified: 1, cleared: 0, expired: 0 });
    // corrupt or foreign data is skipped, not trusted
    store.set("events", { v: 1, events: [
        ["x", 99, 1, 1, 1, [[0, 0, "self", 1, 70, 0, -1, "obs-x-1"]]], null,
        ["z", 0, LAT, LNG, 1, [[0, 7, "self", 1, 70, 0, -1, "obs-z-1"]]],                 // unknown source
        ["w", 0, LAT, LNG, 1, [[0, 0, "self", 1, 70, 0, -1]]],                            // no observation id
        ["y", 0, LAT, LNG, T0 / 1000, [[0, 0, "self", 1, 70, 0, 130, "obs-y-1"]]]] });
    const ok = RS.createLog({ store });
    assert.equal(ok.load(), 1, "unknown kind, garbage, unknown source: skipped");
    assert.equal(ok.get("y", T0).peakMs2, 13);
    store.set("events", { v: 99, events: [] });
    assert.equal(RS.createLog({ store }).load(), 0);
    // the cap
    const small = RS.createLog({ policy: { maxEvents: 3 } });
    for (let i = 0; i < 5; i++) small.add(ob({ east: i * 50, t: T0 + i * MIN }));
    small.prune(T0 + 10 * MIN);
    assert.equal(small.size(), 3);
    assert.equal(small.query({ lat: LAT, lng: LNG, radiusM: 10, now: T0 + 10 * MIN }).length, 0, "the oldest went first");
    // one event keeps only the newest maxObs observations
    const busy = RS.createLog();
    const b = busy.add(ob()).id;
    for (let i = 1; i < 40; i++) busy.add(ob({ t: T0 + i * 2 * MIN }));
    assert.equal(busy.get(b, T0 + 90 * MIN).passes, RS.POLICY.maxObs);
});

test("wiring: loaded before the dynamics agent, precached offline, provided as the shared 'roadsense' capability, type-checked", () => {
    const html = read("public/index.html");
    const rs = html.indexOf('<script src="js/master/roadsense/roadsense.js'), dyn = html.indexOf('<script src="js/master/agents/dynamics-agent.js');
    assert.ok(rs > 0 && rs < dyn);
    assert.match(html, /<script src="https:\/\/maps\.googleapis\.com\/maps\/api\/js\?key=[^"]+&libraries=places&loading=async"><\/script>/, "the Maps tag is untouched");
    assert.ok(read("public/sw.js").includes('"/js/master/roadsense/roadsense.js"'));
    assert.match(read("public/js/master/master-app.js"), /caps\.provide\("roadsense"/);
    assert.ok(JSON.parse(read("tsconfig.master.json")).files.includes("public/js/master/roadsense/roadsense.js"));
});
