// Step 5: the queue of requests for bikes that aren't listed. A request is only a
// name plus hints; it is deduplicated by normalised name and counts each
// requester once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { drivers, memoryDb, RequestQueue, validateRequest, requestKey } from "./helpers.mjs";

const NOW = Date.UTC(2026, 9, 3, 12);
const ok = (body) => { const v = validateRequest(body, { now: NOW }); assert.ok(v.ok, JSON.stringify(v)); return v.value; };
const fields = (body) => { const v = validateRequest(body, { now: NOW }); assert.equal(v.ok, false, JSON.stringify(body)); return v.errors.map((e) => e.field); };

test("validation: names are required, trimmed, bounded and free of control characters and markup", () => {
    assert.deepEqual(ok({ make: "  Kawasaki ", model: "Ninja\t300 " }),
        { make: "Kawasaki", model: "Ninja 300", variant: null, market: "IN", year: null, powertrain: null, note: null, force: false });
    assert.deepEqual(fields({}), ["make", "model"]);
    assert.deepEqual(fields({ make: "", model: "   " }), ["make", "model"]);
    assert.deepEqual(fields({ make: 42, model: ["x"] }), ["make", "model"]);
    assert.deepEqual(fields({ make: "K".repeat(61), model: "N" }), ["make"]);
    assert.deepEqual(fields({ make: "Kawasaki\u0000", model: "N" }), ["make"]);
    assert.deepEqual(fields({ make: "<script>", model: "N" }), ["make"]);
    assert.deepEqual(fields({ make: "---", model: "!!!" }), ["make", "model"], "a name needs a letter or digit");
    for (const body of [null, [], "Kawasaki", 7]) assert.deepEqual(fields(body), [""]);
});

test("validation: optional hints are checked, unknown keys ignored", () => {
    const v = ok({ make: "TVS", model: "Ronin", variant: "TD", market: "in", year: 2026, powertrain: "ice_manual", note: "dual-channel ABS\nmatte", force: true, extra: { anything: 1 } });
    assert.equal(v.market, "IN");
    assert.equal(v.year, 2026);
    assert.equal(v.note, "dual-channel ABS\nmatte");
    assert.equal(v.force, true);
    assert.ok(!("extra" in v));
    assert.deepEqual(fields({ make: "TVS", model: "R", market: "IND" }), ["market"]);
    assert.deepEqual(fields({ make: "TVS", model: "R", year: 1949 }), ["year"]);
    assert.deepEqual(fields({ make: "TVS", model: "R", year: 2029 }), ["year"], "at most 2 years ahead");
    assert.deepEqual(fields({ make: "TVS", model: "R", year: 2024.5 }), ["year"]);
    assert.deepEqual(fields({ make: "TVS", model: "R", year: "2024" }), ["year"]);
    assert.deepEqual(fields({ make: "TVS", model: "R", powertrain: "hybrid" }), ["powertrain"]);
    assert.deepEqual(fields({ make: "TVS", model: "R", note: "n".repeat(281) }), ["note"]);
    assert.deepEqual(fields({ make: "TVS", model: "R", note: "bell\u0007" }), ["note"]);
    assert.deepEqual(fields({ make: "TVS", model: "R", force: "yes" }), ["force"]);
});

test("the dedup key ignores case, punctuation, spacing and letter/digit joins", () => {
    const k = (make, model, variant = null, market = "IN") => requestKey({ make, model, variant, market });
    assert.equal(k("Royal Enfield", "Hunter 350"), k("royal-enfield", "HUNTER350"));
    assert.equal(k("Honda", "H'ness CB350"), k("honda", "Hness CB 350"));
    assert.equal(k("Bajaj", "Pulsar NS200", "ABS"), k("BAJAJ", "pulsar ns 200", "abs"));
    assert.notEqual(k("Bajaj", "Pulsar NS200", "ABS"), k("Bajaj", "Pulsar NS200"));
    assert.notEqual(k("Bajaj", "Pulsar NS200", null, "IN"), k("Bajaj", "Pulsar NS200", null, "NP"));
});

for (const driver of drivers) {
    test(`[${driver.name}] one row per bike, one vote per requester, hints kept per requester`, () => {
        let t = NOW;
        const db = memoryDb(driver);
        const q = new RequestQueue(db, { now: () => t });
        const a = q.submit(ok({ make: "Kawasaki", model: "Ninja 300", year: 2024 }), "rider-a");
        assert.equal(a.created, true);
        assert.equal(a.newVote, true);
        assert.equal(a.request.requesters, 1);
        assert.equal(a.request.status, "queued");

        t += 1000;
        const again = q.submit(ok({ make: "kawasaki", model: "NINJA300", note: "KRT edition" }), "rider-a");
        assert.equal(again.created, false);
        assert.equal(again.newVote, false, "the same rider asking twice is one vote");
        assert.equal(again.request.id, a.request.id);
        assert.equal(again.request.requesters, 1);
        assert.deepEqual(q.votes(a.request.id), [{ requester: "rider-a", year: 2024, powertrain: null, note: "KRT edition", at: NOW + 1000 }], "latest hints merged, earlier ones kept");

        t += 1000;
        const b = q.submit(ok({ make: "Kawasaki", model: "Ninja 300" }), "rider-b");
        assert.equal(b.newVote, true);
        assert.equal(b.request.requesters, 2);
        assert.equal(b.request.firstAt, NOW);
        assert.equal(b.request.lastAt, NOW + 2000);
        assert.equal(b.request.make, "Kawasaki", "the first spelling is kept");

        q.submit(ok({ make: "Yamaha", model: "R3" }), "rider-a");
        q.submit(ok({ make: "Yamaha", model: "R3" }), "rider-b");
        q.submit(ok({ make: "Yamaha", model: "R3" }), "rider-c");
        q.submit(ok({ make: "Suzuki", model: "V-Strom SX" }), "rider-a");
        assert.deepEqual(q.list().map((r) => [r.model, r.requesters]), [["R3", 3], ["Ninja 300", 2], ["V-Strom SX", 1]], "most-wanted first");

        assert.equal(q.setStatus(a.request.id, "researching"), true);
        assert.deepEqual(q.list({ status: "researching" }).map((r) => r.id), [a.request.id]);
        assert.throws(() => q.setStatus(a.request.id, "done"), RangeError);
        assert.throws(() => q.submit(ok({ make: "A", model: "B" }), ""), TypeError);
        db.close();
    });

    test(`[${driver.name}] the queue survives a restart and its schema is created once`, () => {
        const db = memoryDb(driver);
        new RequestQueue(db).submit(ok({ make: "Hero", model: "Mavrick 440" }), "r1");
        const q2 = new RequestQueue(db);                 // a restarted server on the same database
        const r = q2.submit(ok({ make: "Hero", model: "Mavrick 440" }), "r2");
        assert.equal(r.created, false);
        assert.equal(r.request.requesters, 2);
        db.close();
    });

    test(`[${driver.name}] a failed vote rolls the whole submission back`, () => {
        const db = memoryDb(driver);
        const q = new RequestQueue(db);
        assert.throws(() => q.submit(ok({ make: "Hero", model: "Xoom 160" }), "x".repeat(65)), TypeError);
        // bypass validation to force a CHECK failure inside the transaction
        assert.throws(() => q.submit({ ...ok({ make: "Hero", model: "Xoom 160" }), year: 3000 }, "r1"));
        assert.deepEqual(q.list(), [], "no half-written request");
        const r = q.submit(ok({ make: "Hero", model: "Xoom 160" }), "r1");
        assert.equal(r.created, true, "the queue still works afterwards");
        db.close();
    });
}

test("curator script: lists the queue most-wanted first, shows hints, and changes a status", async () => {
    const { execFileSync } = await import("node:child_process");
    const { tmpDir, ROOT } = await import("./helpers.mjs");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = tmpDir("requests");
    const file = path.join(dir, "mapunite.db");
    const db = drivers[0].open(file);
    const q = new RequestQueue(db, { now: () => NOW });
    q.submit(ok({ make: "Yamaha", model: "R3", note: "please" }), "aaaaaaaa11");
    q.submit(ok({ make: "Yamaha", model: "R3" }), "bbbbbbbb22");
    q.submit(ok({ make: "KTM", model: "390 Adventure", year: 2025 }), "aaaaaaaa11");
    db.close();
    const run = (...args) => execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/bikedb/requests.mjs", ...args], { cwd: ROOT, env: { ...process.env, DB_PATH: file }, encoding: "utf8" });
    const list = run().trim().split("\n");
    assert.match(list[0], /^#1\s+2 × Yamaha R3 \[IN\]/);
    assert.match(list[1], /^#2\s+1 × KTM 390 Adventure \[IN\]/);
    assert.match(run("--votes", "1"), /aaaaaaaa .*"please"/);
    assert.match(run("--set", "1", "researching"), /request 1: researching/);
    assert.match(run("--status", "researching"), /Yamaha R3/);
    assert.doesNotMatch(run(), /Yamaha R3/);
    fs.rmSync(dir, { recursive: true, force: true });
});
