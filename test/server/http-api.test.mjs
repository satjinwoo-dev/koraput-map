// Step 5: the HTTP endpoints, as the website (same origin) and the Android app
// (https://localhost, cross-origin) call them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { art, realIndex, drivers, quiet, tmpDir, buildDb, memoryDb, serveApi, raw, bundleFile, express, createBikeApi, listen } from "./helpers.mjs";

const ANDROID = "https://localhost";
const EVIL = "https://evil.example";
const HUNTER = "royal-enfield-hunter-350-metro-in";
const hunterHash = art.bundles.find((b) => b.id === HUNTER).hash;
const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let dir, file, srv, queueDb;
before(async () => {
    dir = tmpDir();
    file = buildDb(dir, drivers[0]);
    queueDb = memoryDb(drivers[0]);
    srv = await serveApi({ catalog: file, queueDb, corsOrigins: [ANDROID, "capacitor://localhost"] });
});
after(async () => {
    await srv.close();
    srv.api.close();
    queueDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
});
const get = (p, headers = {}) => raw(srv.url + p, { headers });

// ---------------------------------------------------------------------------
// GET /api/bikes/search
// ---------------------------------------------------------------------------
test("search: ranked results identical to the app's offline index, with the catalogue version", async () => {
    for (const q of ["royal enf", "hunter", "mt15", "h'ness", "ns 200", "ather 450", "re", "pulsar", "zzz", ""]) {
        for (const limit of [undefined, 3]) {
            const r = await get(`/api/bikes/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ""}`);
            assert.equal(r.status, 200, q);
            assert.equal(r.json.ok, true);
            assert.deepEqual(r.json.results, JSON.parse(JSON.stringify(realIndex.search(q, { limit }))), q);
            assert.equal(r.json.total, realIndex.matchIds(q).length);
            assert.equal(r.json.catalogVersion, art.catalog.version);
            assert.equal(r.headers["x-catalog-version"], art.catalog.version);
            assert.equal(r.json.bundlePath, "/api/bikes/bundles/{hash}");
            assert.equal(r.headers["cache-control"], "public, max-age=60");
        }
    }
    const one = (await get("/api/bikes/search?q=hunter")).json.results[0];
    assert.equal(one.id, HUNTER);
    assert.equal(one.bundle, hunterHash);
    assert.equal(one.sizeUnit, "m3", "strict SI: displacement in m3");
    assert.equal(one.size, 0.00034934);
    assert.ok("image_url" in one);
});

test("search: bad parameters are 400s; FTS5 syntax and junk are just text", async () => {
    for (const p of ["", "?limit=5", "?q=a&q=b", "?q[x]=1", `?q=${"a".repeat(201)}`, "?q=re&limit=abc", "?q=re&limit=-1", "?q=re&limit=1.5", "?q=re&limit=99999"]) {
        const r = await get(`/api/bikes/search${p}`);
        assert.equal(r.status, 400, p);
        assert.equal(r.json.ok, false);
        assert.match(r.json.reason, /^bad-(query|limit)$/);
    }
    assert.equal((await get("/api/bikes/search?q=re&limit=5000")).json.results.length <= 200, true, "limit clamped to 200");
    for (const q of ['"', "*", "NEAR(royal hunter)", "hunter OR pulsar", "-pulsar", "^royal", "make:royal", "(", "\u0000", "%"]) {
        const r = await get(`/api/bikes/search?q=${encodeURIComponent(q)}`);
        assert.equal(r.status, 200, q);
        assert.deepEqual(r.json.results.map((x) => x.id), realIndex.search(q).map((x) => x.id), q);
    }
});

test("search: a conditional request for an unchanged answer is a 304", async () => {
    const first = await get("/api/bikes/search?q=hunter");
    assert.ok(first.headers.etag);
    const again = await get("/api/bikes/search?q=hunter", { "If-None-Match": first.headers.etag });
    assert.equal(again.status, 304);
    assert.equal(again.text, "");
});

// ---------------------------------------------------------------------------
// GET /api/bikes/bundles/:key
// ---------------------------------------------------------------------------
test("bundles by hash: the shipped bytes, immutable, ETag and 304; '.json' suffix and HEAD work", async () => {
    for (const b of art.bundles) {
        for (const p of [b.hash, `${b.hash}.json`]) {
            const r = await get(`/api/bikes/bundles/${p}`);
            assert.equal(r.status, 200, p);
            assert.equal(r.text, fs.readFileSync(bundleFile(b.hash), "utf8"), `${b.id}: same bytes as /bikedb/bundles/${b.hash}.json`);
            assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
            assert.equal(r.headers["cache-control"], "public, max-age=31536000, immutable");
            assert.equal(r.headers.etag, `"${b.hash}"`);
            assert.equal(r.headers["x-bundle-hash"], b.hash);
            assert.equal(r.headers["x-bundle-id"], b.id);
        }
    }
    const nm = await get(`/api/bikes/bundles/${hunterHash}`, { "If-None-Match": `"${hunterHash}"` });
    assert.equal(nm.status, 304);
    assert.equal(nm.text, "");
    const head = await raw(`${srv.url}/api/bikes/bundles/${hunterHash}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.text, "");
    assert.equal(Number(head.headers["content-length"]), Buffer.byteLength(fs.readFileSync(bundleFile(hunterHash), "utf8")));
});

test("bundles by bike id: same bytes, short cache, and Content-Location naming the immutable URL", async () => {
    const r = await get(`/api/bikes/bundles/${HUNTER}`);
    assert.equal(r.status, 200);
    assert.equal(r.text, fs.readFileSync(bundleFile(hunterHash), "utf8"));
    assert.equal(r.headers["cache-control"], "public, max-age=300");
    assert.equal(r.headers["content-location"], `/api/bikes/bundles/${hunterHash}`);
    assert.equal(r.headers.etag, `"${hunterHash}"`);
    assert.equal((await get(`/api/bikes/bundles/${HUNTER}`, { "If-None-Match": `"${hunterHash}"` })).status, 304);
    const cd = art.bundles.find((b) => b.kind === "class_default");
    assert.equal((await get(`/api/bikes/bundles/${cd.id}`)).json.kind, "class_default", "class defaults are served too");
});

test("bundles: unknown keys are 404, malformed keys 400, and nothing outside the database is reachable", async () => {
    for (const k of ["0000000000000000", "no-such-bike", "tvs-ntorq-125-pending"]) assert.equal((await get(`/api/bikes/bundles/${k}`)).status, 404, k);
    for (const k of ["ABCDEF0123456789", "-bad", "bad_id", "x".repeat(81), "%2e%2e%2fpackage.json", "..%2F..%2Fserver.js"]) {
        const r = await get(`/api/bikes/bundles/${k}`);
        assert.equal(r.status, 400, k);
        assert.equal(r.json.reason, "bad-key");
    }
    assert.equal((await get("/api/bikes/bundles/../../server.js")).status, 404);
    assert.equal((await get("/api/bikes/nothing-here")).json.reason, "not-found");
});

// ---------------------------------------------------------------------------
// POST /api/bikes/requests
// ---------------------------------------------------------------------------
test("requests: a missing bike is queued (202); asking again from the same client doesn't add a vote", async () => {
    const r = await raw(`${srv.url}/api/bikes/requests`, json({ make: "Kawasaki", model: "Ninja 300", year: 2025 }));
    assert.equal(r.status, 202);
    assert.equal(r.json.status, "queued");
    assert.equal(r.json.created, true);
    assert.equal(r.json.catalogChecked, true);
    assert.deepEqual(r.json.request, { id: r.json.request.id, market: "IN", make: "Kawasaki", model: "Ninja 300", variant: null, status: "queued", requesters: 1 });
    const again = await raw(`${srv.url}/api/bikes/requests`, json({ make: "KAWASAKI", model: "ninja300" }));
    assert.equal(again.status, 202);
    assert.equal(again.json.created, false);
    assert.equal(again.json.newVote, false);
    assert.equal(again.json.request.requesters, 1);
    assert.equal(srv.api.queue().list().length, 1);
});

test("requests: a bike that is already listed comes back as 'listed' with the matches — unless the rider insists", async () => {
    const before = srv.api.queue().list().length;
    const r = await raw(`${srv.url}/api/bikes/requests`, json({ make: "Royal Enfield", model: "Hunter 350" }));
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "listed");
    assert.equal(r.json.matches[0].id, HUNTER);
    assert.equal(srv.api.queue().list().length, before, "nothing queued");

    // a variant we don't have: queued, with the model's listed variants as suggestions
    const v = await raw(`${srv.url}/api/bikes/requests`, json({ make: "Royal Enfield", model: "Hunter 350", variant: "Retro Factory" }));
    assert.equal(v.status, 202);
    assert.ok(v.json.similar.some((s) => s.id === HUNTER), "suggests the listed variant");

    // the rider says theirs is different
    const f = await raw(`${srv.url}/api/bikes/requests`, json({ make: "Royal Enfield", model: "Hunter 350", force: true }));
    assert.equal(f.status, 202);
    assert.equal(f.json.status, "queued");

    // listed in India, not in Nepal: a Nepal request is queued
    const np = await raw(`${srv.url}/api/bikes/requests`, json({ make: "Royal Enfield", model: "Hunter 350", market: "NP" }));
    assert.equal(np.status, 202);
});

test("requests: invalid input is a 400 with field errors; wrong type 415; oversize 413; bad JSON 400", async () => {
    const bad = await raw(`${srv.url}/api/bikes/requests`, json({ make: "", model: "x".repeat(61), year: 1800 }));
    assert.equal(bad.status, 400);
    assert.equal(bad.json.reason, "invalid");
    assert.deepEqual(bad.json.errors.map((e) => e.field), ["make", "model", "year"]);
    const form = await raw(`${srv.url}/api/bikes/requests`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "make=A&model=B" });
    assert.equal(form.status, 415);
    const none = await raw(`${srv.url}/api/bikes/requests`, { method: "POST", body: "{}" });
    assert.equal(none.status, 415);
    const big = await raw(`${srv.url}/api/bikes/requests`, json({ make: "A", model: "B", note: "n".repeat(5000) }));
    assert.equal(big.status, 413);
    assert.equal(big.json.reason, "too-large");
    const broken = await raw(`${srv.url}/api/bikes/requests`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{make:" });
    assert.equal(broken.status, 400);
    assert.equal(broken.json.reason, "bad-json");
    assert.equal((await get("/api/bikes/requests")).status, 404, "GET isn't a way to read the queue");
});

// ---------------------------------------------------------------------------
// The two load paths
// ---------------------------------------------------------------------------
test("website load path: same origin, no CORS needed — and a same-origin POST (which carries Origin) is accepted", async () => {
    const s = await get("/api/bikes/search?q=hunter");
    assert.equal(s.status, 200);
    assert.equal(s.headers["access-control-allow-origin"], undefined, "no CORS header without an Origin");
    assert.match(s.headers.vary, /Origin/);
    const self = await raw(`${srv.url}/api/bikes/requests`, { ...json({ make: "Ola", model: "Roadster X" }), headers: { "Content-Type": "application/json", Origin: srv.url } });
    assert.equal(self.status, 202);
    assert.equal(self.headers["access-control-allow-origin"], srv.url);
    // behind a TLS proxy that doesn't send X-Forwarded-Proto: the page is https, the server sees http
    const proxied = await raw(`${srv.url}/api/bikes/requests`, { ...json({ make: "Ola", model: "Roadster X" }), headers: { "Content-Type": "application/json", Origin: srv.url.replace("http:", "https:") } });
    assert.equal(proxied.status, 202);
    // a different port on the same host name is a different site
    const otherPort = await raw(`${srv.url}/api/bikes/requests`, { ...json({ make: "Ola", model: "Roadster X" }), headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:1" } });
    assert.equal(otherPort.status, 403);
});

test("Android load path: https://localhost gets CORS on every route, a preflight for the JSON POST, and cross-origin resource policy", async () => {
    for (const p of ["/api/bikes/search?q=hunter", `/api/bikes/bundles/${hunterHash}`, `/api/bikes/bundles/${HUNTER}`, "/api/bikes/status"]) {
        const r = await get(p, { Origin: ANDROID });
        assert.equal(r.status, 200, p);
        assert.equal(r.headers["access-control-allow-origin"], ANDROID, p);
        assert.equal(r.headers["cross-origin-resource-policy"], "cross-origin", p);
        assert.match(r.headers["access-control-expose-headers"], /X-Catalog-Version/);
        assert.match(r.headers.vary, /Origin/);
        assert.equal(r.headers["access-control-allow-credentials"], undefined, "no cookies: the API is credential-free");
    }
    const pre = await raw(`${srv.url}/api/bikes/requests`, { method: "OPTIONS", headers: { Origin: ANDROID, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers["access-control-allow-origin"], ANDROID);
    assert.match(pre.headers["access-control-allow-methods"], /POST/);
    assert.match(pre.headers["access-control-allow-headers"], /Content-Type/i);
    assert.equal(pre.headers["access-control-max-age"], "600");
    const post = await raw(`${srv.url}/api/bikes/requests`, { ...json({ make: "Bajaj", model: "Dominar 400" }), headers: { "Content-Type": "application/json", Origin: ANDROID } });
    assert.equal(post.status, 202);
    assert.equal(post.headers["access-control-allow-origin"], ANDROID);
    const cap = await get("/api/bikes/search?q=re", { Origin: "capacitor://localhost" });
    assert.equal(cap.headers["access-control-allow-origin"], "capacitor://localhost");
});

test("other origins: no CORS grant on reads, no preflight grant, and their POSTs are refused", async () => {
    const r = await get("/api/bikes/search?q=hunter", { Origin: EVIL });
    assert.equal(r.status, 200, "the response exists, but a browser won't hand it to the page");
    assert.equal(r.headers["access-control-allow-origin"], undefined);
    const pre = await raw(`${srv.url}/api/bikes/requests`, { method: "OPTIONS", headers: { Origin: EVIL, "Access-Control-Request-Method": "POST" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers["access-control-allow-origin"], undefined);
    assert.equal(pre.headers["access-control-allow-methods"], undefined);
    const before = srv.api.queue().list().length;
    const post = await raw(`${srv.url}/api/bikes/requests`, { ...json({ make: "Spam", model: "Bot 9000" }), headers: { "Content-Type": "application/json", Origin: EVIL } });
    assert.equal(post.status, 403);
    assert.equal(post.json.reason, "origin-not-allowed");
    assert.equal(srv.api.queue().list().length, before);
});

test("development CORS ('*') echoes any origin", async () => {
    const s = await serveApi({ catalog: file, corsOrigins: "*" });
    const r = await raw(`${s.url}/api/bikes/search?q=re`, { headers: { Origin: "http://192.168.1.20:8080" } });
    assert.equal(r.headers["access-control-allow-origin"], "http://192.168.1.20:8080");
    await s.close();
    s.api.close();
});

// ---------------------------------------------------------------------------
// Availability, status and limits
// ---------------------------------------------------------------------------
test("no catalogue yet: search and bundles are 503 with Retry-After (no file paths leaked); requests still queue", async () => {
    const d = tmpDir();
    const q = memoryDb(drivers[0]);
    const s = await serveApi({ catalog: path.join(d, "bikes.sqlite"), queueDb: q });
    for (const p of ["/api/bikes/search?q=hunter", `/api/bikes/bundles/${hunterHash}`, "/api/bikes/status"]) {
        const r = await raw(s.url + p);
        assert.equal(r.status, 503, p);
        assert.equal(r.json.reason, "catalog-unavailable");
        assert.ok(!r.text.includes(d), "no server paths in public answers");
        if (p !== "/api/bikes/status") assert.equal(r.headers["retry-after"], "30");
    }
    const post = await raw(`${s.url}/api/bikes/requests`, json({ make: "Royal Enfield", model: "Hunter 350" }));
    assert.equal(post.status, 202, "queued without the catalogue check");
    assert.equal(post.json.catalogChecked, false);
    await s.close();
    s.api.close();
    q.close();
    fs.rmSync(d, { recursive: true, force: true });
});

test("status: catalogue version and size; requests need the queue database", async () => {
    const r = await get("/api/bikes/status");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, reason: null, catalogVersion: art.catalog.version, schemaVersion: art.schemaVersion, variants: 25, bundles: 35, bundlePath: "/api/bikes/bundles/{hash}", requests: true });
    assert.equal(r.headers["cache-control"], "no-cache");
    const s = await serveApi({ catalog: file });
    const post = await raw(`${s.url}/api/bikes/requests`, json({ make: "A", model: "B" }));
    assert.equal(post.status, 503);
    assert.equal(post.json.reason, "queue-unavailable");
    await s.close();
    s.api.close();
});

test("rate limits: each route has its own budget, answered as JSON 429", async () => {
    const q = memoryDb(drivers[0]);
    const s = await serveApi({ catalog: file, queueDb: q, limits: { search: { windowMs: 60_000, max: 3 }, requests: { windowMs: 60_000, max: 2 }, bundles: { windowMs: 60_000, max: 100 } } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await raw(`${s.url}/api/bikes/search?q=re`)).status);
    assert.deepEqual(codes, [200, 200, 200, 429]);
    const limited = await raw(`${s.url}/api/bikes/search?q=re`);
    assert.equal(limited.json.reason, "rate-limited");
    assert.equal((await raw(`${s.url}/api/bikes/bundles/${hunterHash}`)).status, 200, "bundles have their own budget");
    const posts = [];
    for (let i = 0; i < 3; i++) posts.push((await raw(`${s.url}/api/bikes/requests`, json({ make: "Make", model: `Model ${i}` }))).status);
    assert.deepEqual(posts, [202, 202, 429]);
    await s.close();
    s.api.close();
    q.close();
});

test("an unexpected failure is a JSON 500 without a stack trace", async () => {
    const errors = [];
    const api = createBikeApi({ catalog: file, queueDb: { exec() { throw new Error("disk on fire"); }, prepare() { throw new Error("disk on fire"); } }, limits: false, log: { warn() {}, error: (...a) => errors.push(a.join(" ")) } });
    const app = express();
    app.use("/api/bikes", api.router);
    const s = await listen(app);
    const r = await raw(`${s.url}/api/bikes/requests`, json({ make: "Kawasaki", model: "Versys 650" }));
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { ok: false, reason: "server-error" });
    assert.ok(errors.some((e) => /disk on fire/.test(e)), "logged on the server");
    await s.close();
    api.close();
});
