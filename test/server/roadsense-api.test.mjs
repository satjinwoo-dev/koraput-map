// RoadSense Live, the server's half (lib/master/roadsense.js): anonymous observations in SQLite, the phone's own
// rules run per tile, retention, forget, and the routes as server.js mounts them
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

const T0 = Date.UTC(2026, 9, 15, 6, 0, 0), MIN = 60000, H = 3600000, D = 24 * H;
const LAT = 18.81, LNG = 82.71;
const M_LNG = 1 / (111320 * Math.cos(LAT * Math.PI / 180));
const P_A = "pseudonym-aaaaaaaaaaaaaaaa", P_B = "pseudonym-bbbbbbbbbbbbbbbb", P_C = "pseudonym-cccccccccccccccc";
let n = 0;
const ob = (o = {}) => ({ id: `obs${String(++n).padStart(6, "0")}`, type: "bump", t: T0, lat: LAT, lng: LNG + (o.east || 0) * M_LNG, source: "imu", present: true, conf: 0.7, peakMs2: 14, ...o });

function setup(limits = {}) {
    const { db } = openServerDatabase(":memory:");
    let t = T0;
    const rs = createRoadsense({ db: () => db, secret: () => "test-secret", now: () => t, limits });
    return { db, rs, at: (v) => { t = v; } };
}

test("upload: stores anonymous observations under a keyed label, never the pseudonym; refuses what a phone mustn't send", async () => {
    const { db, rs } = setup();
    const r = await rs.upload({ v: 1, rider: P_A, obs: [
        ob(), ob({ t: T0 + 5 * MIN }),
        ob({ source: "official" }),                       // a phone can't claim to be IMD
        ob({ t: T0 - 40 * D }),                           // too old
        ob({ t: T0 + H }),                                // from the future
        { ...ob(), id: undefined },                       // no id
        ob({ type: "dragon" }),
        ob({ lat: 123 })
    ] });
    assert.equal(r.status, 200);
    assert.equal(r.json.accepted, 2);
    assert.deepEqual(r.json.rejected.map((x) => x.i), [2, 3, 4, 5, 6, 7]);
    assert.match(r.json.rejected[0].error, /source/);
    // again: the same ids are duplicates, not new evidence
    const again = await rs.upload({ v: 1, rider: P_A, obs: [ob({ id: "obs000001" })] });
    assert.equal(again.json.duplicate, 1);
    // what's stored: a label, not the pseudonym; position rounded to 1e-5°
    const rows = db.prepare("SELECT * FROM roadsense_obs").all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((x) => x.rider === rs.labelOf(P_A) && /^r[0-9a-f]{15}$/.test(x.rider)));
    assert.ok(!JSON.stringify(rows).includes(P_A), "the pseudonym is never stored");
    assert.equal(rows[0].lng, Math.round(rows[0].lng * 1e5) / 1e5);
    assert.equal(rows[0].tile, RS.tileOf(LAT, LNG));
    assert.notEqual(rs.labelOf(P_A), rs.labelOf(P_B));
    // whole-request refusals
    for (const body of [null, { v: 2, rider: P_A, obs: [ob()] }, { v: 1, rider: "short", obs: [ob()] }, { v: 1, rider: P_A, obs: [] }, { v: 1, rider: P_A, obs: Array.from({ length: 201 }, () => ob()) }]) {
        assert.equal((await rs.upload(body)).status, 400, JSON.stringify(body)?.slice(0, 60));
    }
});

test("upload: at most perRiderPerDay observations per label", async () => {
    const { rs } = setup({ perRiderPerDay: 5 });
    assert.equal((await rs.upload({ v: 1, rider: P_A, obs: [ob(), ob(), ob()] })).status, 200);
    const r = await rs.upload({ v: 1, rider: P_A, obs: [ob(), ob(), ob()] });
    assert.equal(r.status, 429);
    assert.equal(r.json.reason, "daily-limit");
    assert.equal((await rs.upload({ v: 1, rider: P_B, obs: [ob()] })).status, 200, "another rider isn't affected");
});

test("area: the phone's rules run per tile; only evidence of live events goes back, with labels, never pseudonyms", async () => {
    const { rs, at } = setup();
    at(T0 + 2 * H);                                                                                     // uploaded after the rides
    await rs.upload({ v: 1, rider: P_A, obs: [ob(), ob({ t: T0 + 5 * MIN })] });                         // a pothole, 2 passes by A
    await rs.upload({ v: 1, rider: P_B, obs: [ob({ east: 4, t: T0 + 20 * MIN })] });                   // B felt it too
    await rs.upload({ v: 1, rider: P_C, obs: [ob({ type: "animal", source: "rider", east: 300, t: T0 })] }); // a cow, long gone by the time we ask
    const gone = ob({ east: 600 });
    await rs.upload({ v: 1, rider: P_A, obs: [gone, ...[1, 2, 3].map((i) => ob({ east: 600, present: false, t: T0 + i * 10 * MIN }))] });
    await rs.upload({ v: 1, rider: P_B, obs: [ob({ east: 600, present: false, t: T0 + 50 * MIN })] });
    const last = await rs.upload({ v: 1, rider: P_C, obs: [ob({ east: 600, present: false, t: T0 + 60 * MIN })] });   // repaired: 3 riders rode over it clean
    assert.deepEqual(last.json.rejected, []);
    at(T0 + 3 * H);
    const r = await rs.area({ v: 1, tiles: [RS.tileOf(LAT, LNG)] });
    assert.equal(r.status, 200);
    assert.equal(r.json.tiles[RS.tileOf(LAT, LNG)], 1, "one live event: the pothole");
    assert.equal(r.json.obs.length, 3);
    assert.ok(r.json.obs.every((x) => x.type === "bump" && /^r[0-9a-f]{15}$/.test(x.rider)));
    assert.ok(!JSON.stringify(r.json).includes("pseudonym"));
    // the phone rebuilds the same verdict from what it got
    const phone = RS.createLog();
    phone.addAll(r.json.obs);
    const e = phone.list(T0 + 3 * H)[0];
    assert.equal(e.status, "verified");
    assert.equal(e.riders, 2);
    // refusals
    assert.equal((await rs.area({ v: 1, tiles: [] })).status, 400);
    assert.equal((await rs.area({ v: 1, tiles: ["nope"] })).status, 400);
    assert.equal((await rs.area({ v: 1, tiles: ["9999:0"] })).status, 400);
    assert.equal((await rs.area({ v: 1, tiles: Array.from({ length: 25 }, (_, i) => `${i}:0`) })).status, 400);
});

test("area: one uploader can't verify a fake pothole, however many passes they claim", async () => {
    const { rs, at } = setup();
    await rs.upload({ v: 1, rider: P_A, obs: [0, 2, 4, 6, 8].map((m) => ob({ t: T0 + m * MIN })) });
    at(T0 + 10 * MIN);
    const r = await rs.area({ v: 1, tiles: [RS.tileOf(LAT, LNG)] });
    const phone = RS.createLog();
    phone.addAll(r.json.obs);
    const e = phone.list(T0 + 10 * MIN)[0];
    assert.equal(e.status, "candidate");
    assert.equal(e.pieces, 1);
});

test("forget deletes everything a phone's pseudonyms sent, and nothing else; retention drops what's past its kind's maxAge", async () => {
    const { db, rs, at } = setup();
    await rs.upload({ v: 1, rider: P_A, obs: [ob(), ob({ east: 100 })] });
    await rs.upload({ v: 1, rider: P_B, obs: [ob({ east: 200 }), ob({ type: "animal", source: "rider", east: 300 })] });
    const f = await rs.forget({ v: 1, riders: [P_A, P_C] });
    assert.deepEqual(f.json, { ok: true, deleted: 2 });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM roadsense_obs").get().n, 2);
    assert.equal((await rs.forget({ v: 1, riders: ["x"] })).status, 400);
    // an hour and a bit later the cow (maxAge 1 h) is purged on the next request; the pothole stays
    at(T0 + 2 * H);
    await rs.area({ v: 1, tiles: [RS.tileOf(LAT, LNG)] });
    assert.deepEqual(db.prepare("SELECT type FROM roadsense_obs").all().map((x) => x.type), ["bump"]);
    assert.equal(rs.stats().purged, 1);
});

test("routes: mounted under /api/master/roadsense with their own body limits; /status reports it", async () => {
    const { rs } = setup();
    const api = createMasterApi({ express, rateLimit, roadsense: rs, log: { warn() {} } });
    const app = express();
    app.use("/api/master", api.router);
    const srv = await listen(app);
    try {
        const post = (p, body) => fetch(`${srv.url}/api/master/roadsense/${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const up = await post("upload", { v: 1, rider: P_A, obs: [ob(), ob({ t: T0 + 5 * MIN })] });
        assert.equal(up.status, 200);
        assert.equal((await up.json()).accepted, 2);
        const area = await (await post("area", { v: 1, tiles: [RS.tileOf(LAT, LNG)] })).json();
        assert.equal(area.obs.length, 2);
        assert.equal((await post("area", { v: 1, tiles: ["x".repeat(5000)] })).status, 413, "4 kB limit on /area");
        const st = await (await fetch(`${srv.url}/api/master/status`)).json();
        assert.equal(st.configured.roadsense, true);
        assert.equal(st.health.roadsense.accepted, 2);
    } finally { await srv.close(); }
    // without a database (server.js always passes one) the routes don't exist
    const bare = express();
    bare.use("/api/master", createMasterApi({ express, rateLimit, log: { warn() {} } }).router);
    const s2 = await listen(bare);
    try { assert.equal((await fetch(`${s2.url}/api/master/roadsense/area`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404); }
    finally { await s2.close(); }
});
