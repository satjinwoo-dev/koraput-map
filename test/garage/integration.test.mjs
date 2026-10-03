// Step 6 × Step 5: the garage's data layer against the REAL /api/bikes endpoints, on
// both load paths — the website (page and API on one origin) and the Android app
// (packaged www/ at https://localhost, API cross-origin on MU_SERVER_ORIGIN).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { art, drivers, tmpDir, buildDb, addSynthetic, memoryDb, listen, express, createBikeApi, quiet, ROOT, Search } from "../server/helpers.mjs";

const require = createRequire(import.meta.url);
const Physics = require("../../public/js/physics/index.js");
const Store = require("../../public/js/garage/store.js");
const PUBLIC = path.join(ROOT, "public");
const ANDROID = "https://localhost";
const HUNTER = "royal-enfield-hunter-350-metro-in";

function fakeStorage() {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/** server.js in miniature: the static website and the bike API on one app. */
async function startServer(dbFile, queueDb) {
    const api = createBikeApi({ catalog: dbFile, queueDb, corsOrigins: [ANDROID], limits: false, log: quiet });
    const app = express();
    app.use("/api/bikes", api.router);
    app.use(express.static(PUBLIC));
    const srv = await listen(app);
    return { api, ...srv };
}

/** Website: relative URLs resolve against https://<server>/garage.html, apiBase = location.origin. */
function websiteStore(srv) {
    const calls = [];
    const f = (url, init) => { calls.push(String(url)); return fetch(new URL(String(url), `${srv.url}/garage.html`), init); };
    return { calls, store: Store.createStore({ search: Search, physics: Physics, fetch: f, caches: null, storage: fakeStorage(), apiBase: srv.url }) };
}

/**
 * Android: relative URLs are the packaged www/ (here: public/, optionally without some bundles,
 * like an APK built before a bike was added); absolute URLs go to the server with Origin:
 * https://localhost, and every API answer must carry the CORS grant a WebView needs.
 */
function androidStore(srv, { missingBundles = new Set() } = {}) {
    const calls = [];
    const f = async (url, init = {}) => {
        const u = String(url);
        calls.push(u);
        if (!/^https?:/.test(u)) {
            const p = new URL(u, "https://localhost/garage.html").pathname;
            const file = path.join(PUBLIC, p);
            const hash = /bundles\/([0-9a-f]{16})\.json$/.exec(p);
            if ((hash && missingBundles.has(hash[1])) || !fs.existsSync(file)) return new Response("not found", { status: 404 });
            return new Response(fs.readFileSync(file), { status: 200 });
        }
        const res = await fetch(u, { ...init, headers: { ...(init.headers || {}), Origin: ANDROID } });
        assert.equal(res.headers.get("access-control-allow-origin"), ANDROID, `CORS grant on ${init.method || "GET"} ${u}`);
        return res;
    };
    return { calls, store: Store.createStore({ search: Search, physics: Physics, fetch: f, caches: null, storage: fakeStorage(), apiBase: srv.url }) };
}

let dir, srv, queueDb, newer, newerQueue, newBike;
before(async () => {
    dir = tmpDir("garage");
    queueDb = memoryDb(drivers[0]);
    srv = await startServer(buildDb(dir, drivers[0]), queueDb);

    // A server whose catalogue is newer than the phone's: 50 more bikes, one of them with real bundle bytes.
    const file = buildDb(dir, drivers[0], "newer.sqlite");
    const { rows } = addSynthetic(file, drivers[0], 50);
    const hunterRuntime = art.bundles.find((b) => b.id === HUNTER).runtime;
    const r = rows.find((x) => !x.classKey.startsWith("ev.") && x.classKey.startsWith("ice_manual"));
    const body = JSON.stringify({ ...hunterRuntime, id: r.id, classKey: r.classKey });
    const hash = crypto.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
    const db = drivers[0].open(file);
    db.exec(`UPDATE bundle SET body = '${body.replace(/'/g, "''")}', hash = '${hash}' WHERE slug = '${r.id}'`);
    db.exec("UPDATE meta SET value = 'ffffffffffffffff' WHERE key = 'catalog_version'");
    db.close();
    newBike = { id: r.id, hash, make: r.make, model: r.model };
    newerQueue = memoryDb(drivers[0]);
    newer = await startServer(file, newerQueue);
});
after(async () => {
    for (const s of [srv, newer]) { await s.close(); s.api.close(); }
    queueDb.close();
    newerQueue.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

for (const [name, make] of [["website", websiteStore], ["Android app", androidStore]]) {
    test(`${name}: catalogue, GET /api/bikes/search (same catalogue: asked once), bundle, physics model`, async () => {
        const { store, calls } = make(srv);
        const { index } = await store.catalog();
        assert.equal(index.version, art.catalog.version);
        const a = await store.search(index, "hunter");
        assert.equal(a.source, "local", "same catalogue: the offline answer, which is identical");
        assert.deepEqual(a.results.map((r) => r.id), [HUNTER]);
        await store.search(index, "pulsar");
        assert.equal(calls.filter((u) => u.includes("/api/bikes/search?")).length, 1, "the server is asked once per session");
        const g = store.saveGarage(store.garageFromPick(index, { bikeId: HUNTER, year: 2024 }));
        const { model } = await store.model(g, index);
        assert.equal(model.id, HUNTER);
        assert.equal(model.gearAdvice, true);
        assert.ok(Physics.shiftPoints(model).ecoUp.length === 4);
    });

    test(`${name}: a newer server catalogue — search finds a bike the phone doesn't have, and its bundle comes from GET /api/bikes/bundles/<hash>`, async () => {
        const { store, calls } = make(newer);
        const { index } = await store.catalog();
        assert.equal(index.get(newBike.id), null, "not in the phone's list");
        const a = await store.search(index, `${newBike.make} ${newBike.model}`);
        assert.equal(a.source, "server");
        assert.ok(a.results.some((r) => r.id === newBike.id));
        const g = store.saveGarage(store.garageFromPick(index, { bikeId: newBike.id, year: null }));
        assert.equal(g.bundle, newBike.hash);
        const { model } = await store.model(g, index);
        assert.equal(model.id, newBike.id, "hash-checked bytes from the API, then the physics model");
        assert.ok(calls.includes(`${newer.url}/api/bikes/bundles/${newBike.hash}`));
    });

    test(`${name}: POST /api/bikes/requests queues a missing bike on the server; an already-listed one is offered back`, async () => {
        const { store } = make(srv);
        const before = srv.api.queue().list().length;
        store.requestBike({ make: "Kawasaki", model: `Ninja 300 ${name}`, year: 2025, classKey: "ice_manual.sport" });
        assert.equal(await store.flushRequests(), 0);
        const q = srv.api.queue().list();
        assert.equal(q.length, before + 1);
        const row = q.find((r) => r.model === `Ninja 300 ${name}`);
        assert.deepEqual(srv.api.queue().votes(row.id).map((v) => [v.year, v.powertrain, v.note]), [[2025, "ice_manual", "Closest type picked in the app: ice_manual.sport"]]);

        const req = store.requestBike({ make: "Royal Enfield", model: "Hunter 350", year: 2024 });
        assert.equal(await store.flushRequests(), 0);
        assert.equal(srv.api.queue().list().length, before + 1, "not queued: it is listed");
        const offer = store.listed();
        assert.equal(offer.length, 1);
        assert.equal(offer[0].request.id, req.id);
        assert.equal(offer[0].matches[0].id, HUNTER);
    });
}

test("Android app, packaged bundles: served from the APK, no server round trip — and offline it all still works", async () => {
    const { store, calls } = androidStore(srv);
    const { index } = await store.catalog();
    const h = index.get(HUNTER).bundle;
    await store.bundle(h);
    assert.ok(!calls.some((u) => u.includes("/api/bikes/bundles/")));
    // airplane mode: the packaged www/ still answers, the server doesn't
    const gone = await listen(express());
    await gone.close();
    const apk = async (u) => {
        if (/^https?:/.test(String(u))) throw new TypeError("Failed to fetch");
        const file = path.join(PUBLIC, new URL(String(u), "https://localhost/garage.html").pathname);
        return fs.existsSync(file) ? new Response(fs.readFileSync(file), { status: 200 }) : new Response("not found", { status: 404 });
    };
    const offline = Store.createStore({ search: Search, physics: Physics, fetch: apk, caches: null, storage: fakeStorage(), apiBase: gone.url });
    const { index: idx } = await offline.catalog();
    assert.equal((await offline.search(idx, "hunter")).source, "local");
    offline.requestBike({ make: "Triumph", model: "Speed 400" });
    assert.equal(await offline.flushRequests(), 1, "waits in the outbox");
    assert.equal((await offline.bundle(h)).id, HUNTER, "bundles from the APK");
});

// ---------------------------------------------------------------------------
// garage.html: which server the page talks to
// ---------------------------------------------------------------------------
function apiBaseOf(win) {
    // garage.html boots from js/garage/garage-page.js (the CSP has no 'unsafe-inline' for scripts)
    const boot = fs.readFileSync(path.join(PUBLIC, "js", "garage", "garage-page.js"), "utf8");
    let opts = null;
    const ctx = { ...win, MUGarage: { store: { createStore: (o) => { opts = o; return {}; }, resolveApiBase: Store.resolveApiBase }, mount: () => ({}) },
        document: { getElementById: () => ({ addEventListener() {} }), referrer: "" }, history: { length: 1 } };
    ctx.window = ctx;
    vm.runInNewContext(boot, ctx);
    return opts.apiBase;
}
const loc = (href) => { const u = new URL(href); return { origin: u.origin, protocol: u.protocol, hostname: u.hostname, port: u.port }; };

test("garage.html (garage-page.js): website → its own origin; Android → MU_GARAGE_API (or MU_SERVER_ORIGIN); the app's own origin is never used as the server", () => {
    assert.equal(apiBaseOf({ location: loc("https://maps.example.com/garage.html") }), "https://maps.example.com", "website: same origin");
    assert.equal(apiBaseOf({ location: loc("http://localhost:3000/garage.html") }), "http://localhost:3000", "local development");
    assert.equal(apiBaseOf({ location: loc("https://localhost/garage.html"), MU_GARAGE_API: "https://maps.example.com" }), "https://maps.example.com", "Android build");
    assert.equal(apiBaseOf({ location: loc("https://localhost/garage.html"), MU_SERVER_ORIGIN: "https://maps.example.com" }), "https://maps.example.com");
    assert.equal(apiBaseOf({ location: loc("https://localhost/garage.html") }), null, "Capacitor origin without a configured server: static only, requests wait");
    assert.equal(apiBaseOf({ location: loc("https://maps.example.com/garage.html"), MU_GARAGE_API: null }), null, "explicitly off");
    assert.equal(apiBaseOf({ location: loc("https://maps.example.com/garage.html"), MU_GARAGE_API: "" }), "https://maps.example.com");
});

test("build-native injects MU_GARAGE_API into garage.html at a tag that exists exactly once", () => {
    const html = fs.readFileSync(path.join(PUBLIC, "garage.html"), "utf8");
    const build = fs.readFileSync(path.join(ROOT, "scripts", "build-native.mjs"), "utf8");
    const anchor = /const anchor = '([^']+)';/.exec(build)[1];
    assert.equal(html.split(anchor).length, 2);
    assert.ok(html.indexOf(anchor) < html.indexOf('<script src="js/garage/garage-page.js">'), "set before the page reads it");
    assert.match(build, /window\.MU_GARAGE_API = \$\{jsonForScript\(origin\)\}/);
});
