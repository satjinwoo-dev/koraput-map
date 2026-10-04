// Step 7: the service worker (public/sw.js) precaches My bike and serves the bike
// catalogue offline. sw.js runs here in a sandbox against a real static server for
// public/, with an in-memory Cache Storage and a switch to go offline.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC = path.join(ROOT, "public");
const express = require("express");
const Store = require("../../public/js/garage/store.js");
const catalog = JSON.parse(fs.readFileSync(path.join(PUBLIC, "bikedb", "catalog.json"), "utf8"));

let server, ORIGIN, overrides = new Map(), requests = [];
before(async () => {
    const app = express();
    app.use((req, res, next) => { requests.push(req.path); const o = overrides.get(req.path); if (o) return res.type("application/json").send(o); next(); });
    app.use(express.static(PUBLIC));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    ORIGIN = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));

/** In-memory Cache Storage (keys: absolute URL, query ignored like the shell's keys). */
function fakeCaches() {
    const stores = new Map();
    const keyOf = (k) => new URL(typeof k === "string" ? k : k.url, ORIGIN).href;
    const open = async (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        const m = stores.get(name);
        return {
            async match(k) { const e = m.get(keyOf(k)); return e ? new Response(e.body.slice(0), { status: e.status, headers: e.headers }) : undefined; },
            async put(k, res) { m.set(keyOf(k), { body: await res.arrayBuffer(), status: res.status, headers: [...res.headers] }); },
            async keys() { return [...m.keys()].map((url) => ({ url })); },
            async delete(k) { return m.delete(keyOf(k)); }
        };
    };
    return { stores, open, keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n), has: async (n) => stores.has(n) };
}

/** Load sw.js into a sandbox. */
function loadSw() {
    const handlers = {};
    const caches = fakeCaches();
    const net = { online: true };
    const toUrl = (i) => new URL(typeof i === "string" ? i : i.url, ORIGIN).href;
    const RequestR = class extends Request { constructor(input, init) { super(typeof input === "string" ? new URL(input, ORIGIN).href : input, init); } };
    const self = {
        location: new URL(`${ORIGIN}/sw.js`), registration: { navigationPreload: null }, clients: { claim: async () => {} }, skipWaiting() {},
        crypto: globalThis.crypto, addEventListener: (t, fn) => { handlers[t] = fn; }
    };
    const ctx = vm.createContext({
        self, caches, console, URL, Response, Headers, Request: RequestR, Promise, setTimeout, clearTimeout, Uint8Array, Array, Map, Error, JSON,
        fetch: async (input, init) => { if (!net.online) throw new TypeError("Failed to fetch"); return fetch(toUrl(input), init && init.mode ? { mode: "cors" } : undefined); }
    });
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, "sw.js"), "utf8"), ctx, { filename: "sw.js" });
    const run = (code) => vm.runInContext(code, ctx);
    /** Dispatch a fetch event; resolves to the Response, or null when the worker doesn't intercept. */
    const fetchEvent = async (p, { mode = "cors", destination = "" } = {}) => {
        const waits = [];
        let responded = null;
        const request = { url: `${ORIGIN}${p}`, method: "GET", mode, destination, headers: new Headers() };
        handlers.fetch({ request, respondWith: (r) => { responded = Promise.resolve(r); }, waitUntil: (w) => waits.push(w), preloadResponse: undefined });
        if (!responded) return null;
        const res = await responded;
        await Promise.allSettled(waits);
        return res;
    };
    const lifecycle = async (type) => { const waits = []; handlers[type]({ waitUntil: (w) => waits.push(w) }); await Promise.all(waits); };
    return { run, caches, net, fetchEvent, lifecycle };
}
const sha16 = (buf) => crypto.createHash("sha256").update(Buffer.from(buf)).digest("hex").slice(0, 16);
const cachedPaths = async (sw, name) => (await (await sw.caches.open(name)).keys()).map((k) => new URL(k.url).pathname);

// ---------------------------------------------------------------------------
test("the worker and the app agree: precache lists, script order, and the shared bike cache name", () => {
    const sw = loadSw();
    const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
    const pageScripts = [...html.matchAll(/<script src="(js\/[^"?]+)\?v=[^"]+"><\/script>/g)].map((m) => `/${m[1]}`);
    const appScripts = JSON.parse(JSON.stringify(sw.run("APP_SCRIPTS")));
    assert.deepEqual(appScripts, pageScripts.slice(0, appScripts.length), "the app scripts index.html loads, in its order (the bike and trip scripts follow boot.js)");
    assert.equal(appScripts.at(-1), "/js/boot.js");
    // everything the map loads on demand for the garage sheet (js/trip/trip-app.js) and garage.html is precached
    const tripApp = fs.readFileSync(path.join(PUBLIC, "js", "trip", "trip-app.js"), "utf8");
    const onDemand = [...tripApp.matchAll(/"(js\/garage\/[a-z-]+\.(?:js|css))"/g)].map((m) => `/${m[1]}`);
    const garageHtml = fs.readFileSync(path.join(PUBLIC, "garage.html"), "utf8");
    const garagePage = [...garageHtml.matchAll(/<script src="(js\/[^"]+)"/g)].map((m) => `/${m[1]}`);
    assert.ok(onDemand.length >= 5 && garagePage.length >= 10);
    const pre = JSON.parse(JSON.stringify(sw.run("BIKE_SCRIPTS")));
    const appList = JSON.parse(JSON.stringify(sw.run("APP_SCRIPTS")));
    for (const f of [...onDemand, ...garagePage, ...pageScripts.filter((x) => !appList.includes(x))]) assert.ok(pre.includes(f), `${f} is precached`);
    assert.equal(sw.run("OFFLINE_PAGES")["/garage.html"], "/garage.html");
    for (const f of [...pre, ...pageScripts]) assert.ok(fs.existsSync(path.join(PUBLIC, f)), `${f} exists`);
    assert.equal(sw.run("BIKEDB_CACHE"), Store.CACHE_NAME, "the worker and the garage share one bike cache");
    assert.ok(!Store.CACHE_NAME.startsWith("mapunite-"), "so activate() never deletes it");
});

test("install precaches My bike (page, scripts, styles), the bike list and every class default's bundle", async () => {
    const sw = loadSw();
    await sw.lifecycle("install");
    const shell = await cachedPaths(sw, sw.run("SHELL_CACHE"));
    for (const f of [...sw.run("BIKE_SCRIPTS"), ...sw.run("APP_SCRIPTS"), "/garage.html"]) assert.ok(shell.includes(f), `${f} in the shell cache`);
    const bikes = await cachedPaths(sw, Store.CACHE_NAME);
    assert.ok(bikes.includes("/bikedb/catalog.json"));
    for (const c of catalog.classes) assert.ok(bikes.includes(`/bikedb/bundles/${c.bundle}.json`), `${c.key}'s typical bike`);
    assert.equal(bikes.length, 1 + catalog.classes.length, "variant bundles are fetched when a rider picks one, not all upfront");
});

test("offline: My bike's page, code, bike list and typical bikes all come from the caches", async () => {
    const sw = loadSw();
    await sw.lifecycle("install");
    await sw.lifecycle("activate");
    sw.net.online = false;
    const page = await sw.fetchEvent("/garage.html", { mode: "navigate", destination: "document" });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /garage-page\.js/);
    for (const f of sw.run("BIKE_SCRIPTS").filter((x) => x.endsWith(".js"))) {
        const r = await sw.fetchEvent(`${f}?v=20261003-garage`, { destination: "script" });
        assert.equal(r.status, 200, f);
    }
    const cat = await sw.fetchEvent("/bikedb/catalog.json");
    assert.equal((await cat.json()).version, catalog.version);
    for (const c of catalog.classes) {
        const r = await sw.fetchEvent(`/bikedb/bundles/${c.bundle}.json`);
        assert.equal(sha16(await r.arrayBuffer()), c.bundle, `${c.key} intact`);
    }
});

test("bike list: network first (a rebuilt catalogue shows at once), the saved copy when offline or slow", async () => {
    const sw = loadSw();
    await sw.lifecycle("install");
    const newer = JSON.stringify({ ...catalog, version: "ffffffffffffffff" });
    overrides.set("/bikedb/catalog.json", newer);
    try {
        assert.equal((await (await sw.fetchEvent("/bikedb/catalog.json")).json()).version, "ffffffffffffffff");
        sw.net.online = false;
        assert.equal((await (await sw.fetchEvent("/bikedb/catalog.json")).json()).version, "ffffffffffffffff", "the newest copy was saved");
    } finally { overrides.delete("/bikedb/catalog.json"); }
});

test("bundles: cache first (immutable), fetched once; content that doesn't match its name is never cached", async () => {
    const sw = loadSw();
    const hunter = catalog.columns.bundle[catalog.columns.id.indexOf("royal-enfield-hunter-350-metro-in")];
    requests = [];
    for (let i = 0; i < 3; i++) assert.equal(sha16(await (await sw.fetchEvent(`/bikedb/bundles/${hunter}.json`)).arrayBuffer()), hunter);
    assert.equal(requests.filter((p) => p.includes(hunter)).length, 1, "fetched once, then from the cache");
    const other = catalog.columns.bundle[catalog.columns.id.indexOf("tvs-raider-125-split-seat-in")];
    overrides.set(`/bikedb/bundles/${other}.json`, JSON.stringify({ tampered: true }));
    try {
        const r = await sw.fetchEvent(`/bikedb/bundles/${other}.json`);
        assert.deepEqual(await r.json(), { tampered: true }, "passed through (the garage refuses it) …");
        assert.ok(!(await cachedPaths(sw, Store.CACHE_NAME)).includes(`/bikedb/bundles/${other}.json`), "… but never cached");
    } finally { overrides.delete(`/bikedb/bundles/${other}.json`); }
});

test("activate drops the previous release's shell cache but keeps the bike cache; the API is never intercepted", async () => {
    const sw = loadSw();
    await (await sw.caches.open("mapunite-shell-mu-2026-09-30.13")).put(`${ORIGIN}/index.html`, new Response("old"));
    await (await sw.caches.open(Store.CACHE_NAME)).put(`${ORIGIN}/bikedb/catalog.json`, new Response("{}"));
    await sw.lifecycle("install");
    await sw.lifecycle("activate");
    const names = await sw.caches.keys();
    assert.ok(!names.includes("mapunite-shell-mu-2026-09-30.13"));
    assert.ok(names.includes(Store.CACHE_NAME));
    assert.ok(names.includes(sw.run("SHELL_CACHE")));
    for (const p of ["/api/bikes/search?q=hunter", "/api/bikes/bundles/0123456789abcdef", "/socket.io/?EIO=4", "/socket.io/socket.io.js?EIO=4&transport=polling"]) assert.equal(await sw.fetchEvent(p), null, p);
});

test("the Socket.IO client library (only that file) is cached, so index.html can boot offline", async () => {
    const sw = loadSw();
    const lib = path.join(PUBLIC, "socket.io", "socket.io.js");
    overrides.set("/socket.io/socket.io.js", "/* socket.io client */ window.io = function () {};");
    try {
        await sw.lifecycle("install");
        assert.ok((await cachedPaths(sw, sw.run("SHELL_CACHE"))).includes("/socket.io/socket.io.js"));
        sw.net.online = false;
        const r = await sw.fetchEvent("/socket.io/socket.io.js", { destination: "script" });
        assert.equal(r.status, 200);
        assert.match(await r.text(), /socket\.io client/);
    } finally { overrides.delete("/socket.io/socket.io.js"); }
    assert.ok(!fs.existsSync(lib), "(the file is served by the server, not public/)");
});
