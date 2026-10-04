// The bike curator's admin API (lib/bikedb/admin-api.js): bearer ADMIN_TOKEN, the request
// queue as the curator sees it, drafts, reject / duplicate, and approve — with the picture
// rule (image.url required) enforced on the server whatever the browser sends.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { drivers, quiet, tmpDir, memoryDb, raw, express, listen, RequestQueue, validateRequest, ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { createAdminApi, pictureErrors, curatorStatus } = require("../../lib/bikedb/admin-api.js");
const Contract = require("../../public/js/bikedb/bundle-contract.js");

const TOKEN = "test-admin-token-0123456789";
const AUTH = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const HUNTER = "royal-enfield-hunter-350-metro-in";
const NEW_ID = "royal-enfield-hunter-350-rebel-test-in";

let dir, dataDir, outDir, db, queue, srv, builds, buildResult;
const api = (p, { method = "GET", body, headers = AUTH } = {}) =>
    raw(srv.url + "/api/admin" + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

/** A new variant made from the Hunter's file: a different id and name, a picture from a source it lists. */
function newBike(o = {}) {
    const b = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "bikes", "variants", `${HUNTER}.json`), "utf8"));
    b.id = NEW_ID;
    b.identity = { ...b.identity, variant: "Rebel (test)", aliases: [] };
    b.image = { url: "https://cdn.example.com/bikes/hunter-rebel.jpg", src: b.sources[0].id };
    return Object.assign(b, o);
}

function submit(make, model, variant, requester = "r1") {
    const v = validateRequest({ market: "IN", make, model, variant }, {});
    assert.ok(v.ok, JSON.stringify(v.errors));
    return queue.submit(v.value, requester).request.id;
}

before(async () => {
    dir = tmpDir("admin");
    dataDir = path.join(dir, "bikes");
    outDir = path.join(dir, "out");
    fs.cpSync(path.join(ROOT, "data", "bikes"), dataDir, { recursive: true });
    db = memoryDb(drivers[0]);
    queue = new RequestQueue(db);
    builds = [];
    buildResult = { ok: true, output: { catalogVersion: "test" } };
    const admin = createAdminApi({
        queueDb: () => db, token: () => TOKEN, dataDir, log: quiet, limits: false,
        build: async (o) => { builds.push(o); return typeof buildResult === "function" ? buildResult(o) : buildResult; }
    });
    const app = express();
    app.use("/api/admin", admin.router);
    srv = await listen(app);
});
after(async () => {
    await srv.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("auth: no token configured = no admin API (404); wrong or missing token = 401; never cached", async () => {
    const off = express();
    off.use("/api/admin", createAdminApi({ queueDb: () => db, token: () => undefined, dataDir, log: quiet, limits: false }).router);
    const s = await listen(off);
    try {
        assert.equal((await raw(`${s.url}/api/admin/bike-requests`, { headers: AUTH })).status, 404);
    } finally { await s.close(); }
    const short = express();
    short.use("/api/admin", createAdminApi({ queueDb: () => db, token: "short", dataDir, log: quiet, limits: false }).router);
    const s2 = await listen(short);
    try {
        assert.equal((await raw(`${s2.url}/api/admin/bike-requests`, { headers: { Authorization: "Bearer short" } })).status, 404, "a token under 16 characters doesn't switch it on");
    } finally { await s2.close(); }
    assert.equal((await api("/bike-requests", { headers: {} })).status, 401);
    const bad = await api("/bike-requests", { headers: { Authorization: `Bearer ${TOKEN}x` } });
    assert.equal(bad.status, 401); assert.equal(bad.headers["www-authenticate"], "Bearer");
    assert.equal((await api("/bike-requests", { headers: { Authorization: TOKEN } })).status, 401, "Bearer scheme required");
    const ok = await api("/bike-requests");
    assert.equal(ok.status, 200); assert.equal(ok.headers["cache-control"], "no-store");
});

test("bike-requests: the riders' queue, most wanted first, in the curator's shape; status filter", async () => {
    const a = submit("Royal Enfield", "Hunter 350", "Rebel", "r1");
    submit("Royal Enfield", "Hunter 350", "Rebel", "r2");
    const b = submit("Hero", "Glamour", null, "r1");
    const r = await api("/bike-requests?status=all");
    assert.equal(r.status, 200);
    const [first, second] = r.json.requests;
    assert.deepEqual([first.id, first.description, first.count, first.status], [String(a), "Royal Enfield Hunter 350 Rebel", 2, "queued"]);
    assert.equal(typeof first.createdAt, "number");
    assert.equal(second.id, String(b));
    assert.equal((await api("/bike-requests?status=queued")).json.requests.length, 2);
    assert.equal((await api("/bike-requests?status=approved")).json.requests.length, 0);
    assert.equal((await api("/bike-requests?status=bogus")).status, 400);
});

test("reference: the fuel grades and emission standards the drafts are checked against", async () => {
    const r = await api("/bikedb/reference");
    assert.equal(r.status, 200);
    assert.ok(r.json.fuelGrades && r.json.emissionStandards);
    assert.deepEqual(r.json.fuelGrades, JSON.parse(fs.readFileSync(path.join(dataDir, "reference", "fuel-grades.json"), "utf8")));
});

test("draft: saved on the server, comes back with the request, status 'drafted'", async () => {
    const id = submit("TVS", "Ronin", "TD", "r3");
    const draft = { id: "tvs-ronin-td-in", identity: { make: "TVS", model: "Ronin" } };
    assert.equal((await api(`/bike-requests/${id}/draft`, { method: "PUT", body: { draft } })).json.ok, true);
    const row = (await api("/bike-requests?status=drafted")).json.requests.find((x) => x.id === String(id));
    assert.deepEqual(row.draft, draft);
    assert.equal(queue.get(id).status, "researching", "the queue's own status follows");
    assert.equal((await api(`/bike-requests/${id}/draft`, { method: "PUT", body: { draft: [1] } })).status, 400);
    assert.equal((await api("/bike-requests/99999/draft", { method: "PUT", body: { draft } })).status, 404);
    assert.equal((await api("/bike-requests/1e3/draft", { method: "PUT", body: { draft } })).status, 404);
});

test("reject and duplicate: a reason / a bike that exists; both close the request", async () => {
    const id = submit("Bajaj", "Platina", "110", "r4");
    assert.equal((await api(`/bike-requests/${id}/reject`, { method: "POST", body: { reason: "  " } })).status, 400);
    assert.equal((await api(`/bike-requests/${id}/reject`, { method: "POST", body: { reason: "Not sold in India\u0007" } })).json.ok, true);
    let row = (await api("/bike-requests?status=rejected")).json.requests.find((x) => x.id === String(id));
    assert.equal(row.resolution, "Not sold in India");
    assert.equal(queue.get(id).status, "rejected");

    const dup = submit("RE", "Hunter", null, "r5");
    assert.equal((await api(`/bike-requests/${dup}/duplicate`, { method: "POST", body: { bikeId: "no-such-bike-in" } })).status, 400);
    assert.equal((await api(`/bike-requests/${dup}/duplicate`, { method: "POST", body: { bikeId: "../etc/passwd" } })).status, 400);
    assert.equal((await api(`/bike-requests/${dup}/duplicate`, { method: "POST", body: { bikeId: HUNTER } })).json.ok, true);
    row = (await api("/bike-requests?status=duplicate")).json.requests.find((x) => x.id === String(dup));
    assert.equal(row.resolution, HUNTER);
    assert.equal(queue.get(dup).status, "added");
});

test("approve: THE PICTURE RULE — no image.url, an http picture, or an unsourced one never reaches variants/", async () => {
    const id = submit("Royal Enfield", "Hunter 350", "Rebel no picture", "r6");
    builds.length = 0;
    for (const [image, code] of [[undefined, "picture_required"], [{ url: "  ", src: "re-hunter-spec-2026" }, "picture_required"],
        [{ url: "http://cdn.example.com/x.jpg", src: "re-hunter-spec-2026" }, "picture_https"], [{ url: "https://cdn.example.com/x.jpg", src: "nobody" }, "picture_source"]]) {
        const b = newBike(); if (image === undefined) delete b.image; else b.image = image;
        const r = await api(`/bike-requests/${id}/approve`, { method: "POST", body: { bundle: b } });
        assert.equal(r.status, 422, code);
        assert.equal(r.json.location, "pending");
        assert.ok(r.json.errors.some((e) => e.code === code), `${code}: ${JSON.stringify(r.json.errors)}`);
        assert.ok(!fs.existsSync(path.join(dataDir, "variants", `${NEW_ID}.json`)), "never in variants/");
        assert.ok(fs.existsSync(path.join(dataDir, "pending", `${NEW_ID}.json`)), "kept in pending/ with its reasons");
    }
    assert.equal(builds.length, 0, "nothing rebuilt");
    assert.equal(queue.get(id).status, "researching", "the request stays open");
    assert.equal((await api("/bike-requests?status=drafted")).json.requests.find((x) => x.id === String(id)).location, "pending");
    // grandfathered ids don't help: the old bikes' exemption is never consulted on approve
    assert.ok(Contract.PICTURE_GRANDFATHERED.length > 0);
    assert.equal(pictureErrors({ ...newBike(), id: Contract.PICTURE_GRANDFATHERED[0], image: undefined })[0].code, "picture_required");
    fs.rmSync(path.join(dataDir, "pending", `${NEW_ID}.json`));
});

test("approve: the whole contract runs on the server (bad units, slug, kind, existing id)", async () => {
    const id = submit("Royal Enfield", "Hunter 350", "Rebel bad", "r7");
    const bad = newBike(); bad.engine = { ...bad.engine, displacement: { ...bad.engine.displacement, value: -1 } };
    const r = await api(`/bike-requests/${id}/approve`, { method: "POST", body: { bundle: bad } });
    assert.equal(r.status, 422); assert.equal(r.json.location, "pending");
    assert.ok(r.json.errors.some((e) => String(e.path).startsWith("engine.displacement")), JSON.stringify(r.json.errors));
    fs.rmSync(path.join(dataDir, "pending", `${NEW_ID}.json`));
    assert.equal((await api(`/bike-requests/${id}/approve`, { method: "POST", body: { bundle: newBike({ id: "../../evil" }) } })).status, 400);
    assert.equal((await api(`/bike-requests/${id}/approve`, { method: "POST", body: { bundle: newBike({ kind: "class_default" }) } })).status, 400);
    const ex = await api(`/bike-requests/${id}/approve`, { method: "POST", body: { bundle: newBike({ id: HUNTER }) } });
    assert.equal(ex.status, 409);
    assert.match(ex.json.error, /already in the catalogue/);
});

test("approve: a valid bike with a picture → variants/<id>.json, rebuilt; a failed rebuild takes it out again", async () => {
    const id = submit("Royal Enfield", "Hunter 350", "Rebel ok", "r8");
    buildResult = { ok: false, error: "disk full" };
    builds.length = 0;
    const fail = await api(`/bike-requests/${id}/approve`, { method: "POST", body: { bundle: newBike() } });
    assert.equal(fail.status, 500); assert.match(fail.json.error, /didn't rebuild/);
    assert.equal(builds.length, 1);
    assert.ok(!fs.existsSync(path.join(dataDir, "variants", `${NEW_ID}.json`)), "rolled back");
    assert.equal(queue.get(id).status, "queued");

    buildResult = (o) => ({ ok: fs.existsSync(path.join(o.dataDir, "variants", `${NEW_ID}.json`)), output: { catalogVersion: "v2" } });
    const r = await api(`/bike-requests/${id}/approve`, { method: "POST", body: { bundle: newBike() } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.ok, r.json.id, r.json.location, r.json.catalogVersion], [true, NEW_ID, "variants", "v2"]);
    const text = fs.readFileSync(path.join(dataDir, "variants", `${NEW_ID}.json`), "utf8");
    assert.deepEqual(JSON.parse(text), newBike());
    assert.ok(text.endsWith("}\n"));
    assert.equal(queue.get(id).status, "added");
    const row = (await api("/bike-requests?status=approved")).json.requests.find((x) => x.id === String(id));
    assert.deepEqual([row.resolution, row.location], [NEW_ID, "variants"]);
    assert.equal((await api(`/bike-requests/${id}/approve`, { method: "POST", body: { bundle: newBike() } })).status, 409, "approving twice");
    const late = await api(`/bike-requests/${id}/reject`, { method: "POST", body: { reason: "changed my mind" } });
    assert.equal(late.status, 409, "an approved request can't be reopened: the queue would disagree with data/bikes");
    assert.match(late.json.error, new RegExp(`Already approved as ${NEW_ID}`));
    assert.equal((await api(`/bike-requests/${id}/draft`, { method: "PUT", body: { draft: {} } })).status, 409);
    fs.rmSync(path.join(dataDir, "variants", `${NEW_ID}.json`));

    // one approve at a time: a second one while the first is still rebuilding is refused, not interleaved
    const other = submit("Royal Enfield", "Hunter 350", "Rebel concurrent", "r10");
    let release; const gate = new Promise((r) => { release = r; });
    buildResult = async () => { await gate; return { ok: true, output: { catalogVersion: "v3" } }; };
    const first = api(`/bike-requests/${other}/approve`, { method: "POST", body: { bundle: newBike() } });
    await new Promise((r) => setTimeout(r, 150));
    const second = await api(`/bike-requests/${other}/approve`, { method: "POST", body: { bundle: newBike({ id: "royal-enfield-hunter-350-other-test-in" }) } });
    assert.equal(second.status, 409); assert.match(second.json.error, /still rebuilding/);
    release();
    assert.equal((await first).status, 200);
    fs.rmSync(path.join(dataDir, "variants", `${NEW_ID}.json`));
    buildResult = { ok: true, output: { catalogVersion: "test" } };
});

test("approve with the real build: catalog.json, the bundles and bikes.sqlite carry the new bike's image_url", { timeout: 120000 }, async () => {
    const admin = createAdminApi({ queueDb: () => db, token: TOKEN, dataDir, publicDir: path.join(outDir, "public"), dbFile: path.join(outDir, "bikes.sqlite"), log: quiet, limits: false });
    const app = express(); app.use("/api/admin", admin.router);
    const s = await listen(app);
    try {
        const id = submit("Royal Enfield", "Hunter 350", "Rebel real", "r9");
        const r = await raw(`${s.url}/api/admin/bike-requests/${id}/approve`, { method: "POST", headers: AUTH, body: JSON.stringify({ bundle: newBike() }) });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.match(String(r.json.catalogVersion), /^[0-9a-f]{16}$/);
        const cat = JSON.parse(fs.readFileSync(path.join(outDir, "public", "catalog.json"), "utf8"));
        const text = JSON.stringify(cat);
        assert.ok(text.includes(NEW_ID) && text.includes("https://cdn.example.com/bikes/hunter-rebel.jpg"), "the picture ships as image_url");
        assert.ok(fs.statSync(path.join(outDir, "bikes.sqlite")).size > 0);
    } finally {
        await s.close();
        try { fs.rmSync(path.join(dataDir, "variants", `${NEW_ID}.json`)); } catch { /* not written */ }
    }
});

test("curator status: its decision first, then a draft, then the queue's status", () => {
    assert.equal(curatorStatus("queued", null), "queued");
    assert.equal(curatorStatus("researching", null), "drafted");
    assert.equal(curatorStatus("queued", { draft: "{}" }), "drafted");
    assert.equal(curatorStatus("added", { kind: "duplicate" }), "duplicate");
    assert.equal(curatorStatus("added", null), "approved");
});
