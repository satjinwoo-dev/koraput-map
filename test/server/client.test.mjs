// Step 5: public/js/bikedb/bike-api.js against the real endpoints, as the website
// (relative URLs on the server's own origin) and the Android app (pages from
// https://localhost/ with bundles packaged in www/, API on MU_SERVER_ORIGIN) use it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { art, realIndex, drivers, tmpDir, buildDb, memoryDb, serveApi, listen, express, BikeApi, ROOT, bundleFile } from "./helpers.mjs";

const HUNTER = "royal-enfield-hunter-350-metro-in";
const hunterHash = art.bundles.find((b) => b.id === HUNTER).hash;

let dir, srv, queueDb;
before(async () => {
    dir = tmpDir();
    queueDb = memoryDb(drivers[0]);
    srv = await serveApi({ catalog: buildDb(dir, drivers[0]), queueDb, corsOrigins: ["https://localhost"] });
});
after(async () => {
    await srv.close();
    srv.api.close();
    queueDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/** The website: the page is on the server, relative URLs resolve against it, static files come from public/. */
async function websiteFetch() {
    const app = express();
    app.use(express.static(path.join(ROOT, "public")));
    app.use((req, res) => res.redirect(307, srv.url + req.originalUrl));       // same server in production; two here
    const web = await listen(app);
    const seen = [];
    const f = (url, init) => { seen.push(String(url)); return fetch(new URL(url, `${web.url}/index.html`), { ...init, redirect: "follow" }); };
    return { f, seen, close: web.close };
}

/** The Android app: pages at https://localhost/, www/ packaged in the APK, API on the server origin. */
function androidFetch({ shipped = true } = {}) {
    const seen = [];
    const f = async (url, init) => {
        const u = String(url);
        seen.push(u);
        if (!/^https?:\/\//.test(u)) {                                          // a relative URL: the packaged www/
            const file = path.join(ROOT, "public", new URL(u, "https://localhost/").pathname);
            if (!shipped || !fs.existsSync(file)) return new Response("not found", { status: 404 });
            return new Response(fs.readFileSync(file), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return fetch(u, { ...init, headers: { ...(init && init.headers), Origin: "https://localhost" } });
    };
    return { f, seen };
}

test("website: relative API URLs; search answered by the server; bundles from the static files", async () => {
    const web = await websiteFetch();
    const api = BikeApi.createBikeClient({ origin: "", fetch: web.f, localIndex: realIndex });
    assert.equal(api.apiBase, "/api/bikes");
    const s = await api.search("royal enf", { limit: 3 });
    assert.equal(s.source, "server");
    assert.equal(s.catalogStale, false);
    assert.deepEqual(s.results, JSON.parse(JSON.stringify(realIndex.search("royal enf", { limit: 3 }))));
    const b = await api.bundle(hunterHash);
    assert.deepEqual(b, JSON.parse(fs.readFileSync(bundleFile(hunterHash), "utf8")));
    assert.deepEqual(web.seen, ["/api/bikes/search?q=royal+enf&limit=3", `bikedb/bundles/${hunterHash}.json`], "relative URLs only");
    await web.close();
});

test("Android: absolute API URLs on MU_SERVER_ORIGIN; packaged bundles first, the server for bikes newer than the APK", async () => {
    const app = androidFetch();
    const api = BikeApi.createBikeClient({ origin: srv.url, fetch: app.f, localIndex: realIndex });
    assert.equal(api.apiBase, `${srv.url}/api/bikes`);
    const s = await api.search("hunter");
    assert.equal(s.source, "server");
    assert.equal(s.results[0].id, HUNTER);
    assert.deepEqual(await api.bundle(hunterHash), JSON.parse(fs.readFileSync(bundleFile(hunterHash), "utf8")));
    assert.equal(app.seen.at(-1), `bikedb/bundles/${hunterHash}.json`, "served from the APK");

    const old = androidFetch({ shipped: false });                              // an APK packaged before this bike existed
    const api2 = BikeApi.createBikeClient({ origin: srv.url, fetch: old.f });
    assert.deepEqual(await api2.bundle(hunterHash), JSON.parse(fs.readFileSync(bundleFile(hunterHash), "utf8")));
    assert.deepEqual(old.seen, [`bikedb/bundles/${hunterHash}.json`, `${srv.url}/api/bikes/bundles/${hunterHash}`]);

    const q = await api.requestBike({ make: "Triumph", model: "Speed 400" });
    assert.equal(q.status, "queued");
    const listed = await api.requestBike({ make: "Royal Enfield", model: "Hunter 350" });
    assert.equal(listed.status, "listed");
    await assert.rejects(api.requestBike({ make: "", model: "" }), (e) => e instanceof BikeApi.BikeApiError && e.reason === "invalid" && e.status === 400);
});

test("offline (server unreachable): search falls back to catalog.json with identical results; bundles from the APK; requests say 'offline'", async () => {
    const gone = await listen(express());
    const dead = gone.url;
    await gone.close();
    const app = androidFetch();
    const api = BikeApi.createBikeClient({ origin: dead, fetch: app.f, localIndex: () => Promise.resolve(realIndex), timeoutMs: 2000 });
    for (const q of ["royal enf", "mt15", "zzz"]) {
        const s = await api.search(q, { limit: 5 });
        assert.equal(s.source, "offline");
        assert.equal(s.catalogVersion, art.catalog.version);
        assert.deepEqual(s.results, realIndex.search(q, { limit: 5 }));
        assert.equal(s.total, realIndex.matchIds(q).length);
    }
    assert.equal((await api.bundle(hunterHash)).id, HUNTER);
    await assert.rejects(api.requestBike({ make: "Triumph", model: "Speed 400" }), (e) => e.reason === "offline");
    const noIndex = BikeApi.createBikeClient({ origin: dead, fetch: app.f });
    await assert.rejects(noIndex.search("hunter"), (e) => e.reason === "offline");
});

test("server overloaded (503 / 429): search falls back offline; a 400 is a real error, not a fallback", async () => {
    const statusFetch = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    for (const status of [429, 500, 503]) {
        const api = BikeApi.createBikeClient({ origin: "https://maps.example.com", fetch: statusFetch(status, { ok: false, reason: "x" }), localIndex: realIndex });
        assert.equal((await api.search("hunter")).source, "offline", String(status));
    }
    const api = BikeApi.createBikeClient({ origin: "https://maps.example.com", fetch: statusFetch(400, { ok: false, reason: "bad-query" }), localIndex: realIndex });
    await assert.rejects(api.search("hunter"), (e) => e.reason === "bad-query" && e.status === 400);
});

test("a newer server catalogue is reported as catalogStale, so the app can refresh catalog.json", async () => {
    const stale = { search: () => [], matchIds: () => [], version: "0000000000000000" };
    const api = BikeApi.createBikeClient({ origin: srv.url, fetch: androidFetch().f, localIndex: stale });
    const s = await api.search("hunter");
    assert.equal(s.source, "server");
    assert.equal(s.catalogStale, true);
});

test("a bundle whose served hash doesn't match is rejected; bad hashes and origins are caught early", async () => {
    const lying = async (url) => String(url).startsWith("bikedb/")
        ? new Response("", { status: 404 })
        : new Response("{}", { status: 200, headers: { "X-Bundle-Hash": "ffffffffffffffff" } });
    const api = BikeApi.createBikeClient({ origin: "https://maps.example.com", fetch: lying });
    await assert.rejects(api.bundle(hunterHash), (e) => e.reason === "bundle-mismatch");
    await assert.rejects(api.bundle("../../etc/passwd"), TypeError);
    assert.throws(() => BikeApi.createBikeClient({ origin: "https://maps.example.com/app", fetch: lying }), TypeError);
    assert.throws(() => BikeApi.createBikeClient({ origin: "ftp://x", fetch: lying }), TypeError);
});

test("browser load: a plain <script> defines window.BikeApi and picks up window.MU_SERVER_ORIGIN (the Android build sets it)", () => {
    const src = fs.readFileSync(path.join(ROOT, "public", "js", "bikedb", "bike-api.js"), "utf8");
    const win = { MU_SERVER_ORIGIN: "https://maps.example.com", fetch: () => Promise.reject(new Error("unused")), AbortController, URLSearchParams, setTimeout, clearTimeout, Promise };
    win.self = win;
    vm.runInNewContext(src, win);
    assert.equal(typeof win.BikeApi.createBikeClient, "function");
    assert.equal(win.BikeApi.createBikeClient().apiBase, "https://maps.example.com/api/bikes");
    const webWin = { fetch: win.fetch, AbortController, URLSearchParams, setTimeout, clearTimeout, Promise };
    webWin.self = webWin;
    vm.runInNewContext(src, webWin);
    assert.equal(webWin.BikeApi.createBikeClient().apiBase, "/api/bikes", "website: same origin");
});
