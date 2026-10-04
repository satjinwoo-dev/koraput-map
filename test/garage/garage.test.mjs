// Step 6: the garage's logic (data layer, settings, chart preparation, units), tested in Node.
// The DOM components are exercised in a real browser (see the README); everything they
// decide is computed by the functions tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildArtifacts } from "../../scripts/bikedb/catalog-build.mjs";
import { loadCatalog } from "../../scripts/bikedb/load-catalog.mjs";

const require = createRequire(import.meta.url);
const Search = require("../../public/js/bikedb/catalog-search.js");
const Physics = require("../../public/js/physics/index.js");
const U = require("../../public/js/garage/units.js");
const Store = require("../../public/js/garage/store.js");
const Settings = require("../../public/js/garage/settings.js");
const Viz = require("../../public/js/garage/visualizer.js");
const Sil = require("../../public/js/garage/silhouettes.js");

const art = buildArtifacts(loadCatalog());
const files = new Map([["bikedb/catalog.json", art.catalog.bytes], ...art.bundles.map((b) => [`bikedb/bundles/${b.hash}.json`, b.bytes])]);
const byId = new Map(art.bundles.map((b) => [b.id, b]));
const index = new Search.CatalogIndex(JSON.parse(art.catalog.bytes));

// ---------------------------------------------------------------------------
// Fakes: network, Cache Storage, localStorage
// ---------------------------------------------------------------------------
function fakeNet(serve = files) {
    const calls = [];
    let online = true;
    const fetch = async (url, init = {}) => {
        calls.push({ url, method: init.method || "GET", body: init.body });
        if (!online) throw new TypeError("Failed to fetch");
        if (typeof serve === "function") return serve(url, init);
        const key = String(url).replace(/^https?:\/\/[^/]+\/(api\/bikes\/bundles\/)?/, (m, api) => (api ? "bikedb/bundles/" : ""));
        const k = key.startsWith("bikedb/bundles/") && !key.endsWith(".json") ? `${key}.json` : key;
        const body = serve.get(k);
        return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200 });
    };
    return { fetch, calls, setOnline: (v) => { online = v; } };
}
function fakeCaches() {
    const stores = new Map();
    return {
        stores,
        async open(name) {
            if (!stores.has(name)) stores.set(name, new Map());
            const m = stores.get(name);
            return { async match(k) { return m.has(k) ? new Response(m.get(k)) : undefined; }, async put(k, res) { m.set(k, await res.text()); } };
        }
    };
}
function fakeStorage() {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
const mkStore = (o = {}) => Store.createStore({ search: Search, physics: Physics, fetch: o.net ? o.net.fetch : fakeNet().fetch, caches: "caches" in o ? o.caches : fakeCaches(), storage: o.storage ?? fakeStorage(), apiBase: o.apiBase ?? null, now: () => 1_700_000_000_000 });

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------
test("units: the only place SI becomes km/h, rpm, km/L and Wh/km", () => {
    assert.equal(U.kmh(10), 36);
    assert.equal(U.fromKmh(36), 10);
    assert.ok(Math.abs(U.rpm(Math.PI * 100) - 3000) < 1e-9);
    assert.ok(Math.abs(U.kmPerLitre(2.316730e-8) - 43.164) < 1e-3);    // the physics known-answer bike
    assert.equal(U.kmPerLitre(0), Infinity);
    assert.equal(U.whPerKm(36), 10);
    assert.equal(U.num(Infinity), "∞");
    assert.equal(U.num(null), "–");
    assert.equal(U.num(-3.25, 1), "−3.3");
    assert.equal(U.num(123456), "1,23,456");                            // Indian grouping
    assert.equal(U.size({ size: 0.00034934, sizeUnit: "m3" }), "349 cc");
    assert.equal(U.size({ size: 2.9 * 3.6e6, sizeUnit: "J" }), "2.9 kWh");
    assert.equal(U.years({ yearFrom: 2022, yearTo: null }), "2022–");
    assert.equal(U.years({ yearFrom: 2019, yearTo: 2026 }), "2019–2026");
});

// ---------------------------------------------------------------------------
// Store: catalogue
// ---------------------------------------------------------------------------
test("catalogue: network first and cached; offline next time from the cache; a clear message with neither", async () => {
    const caches = fakeCaches();
    const online = mkStore({ caches });
    const a = await online.catalog();
    assert.equal(a.source, "network");
    assert.equal(a.index.size, index.size);
    const net = fakeNet(); net.setOnline(false);
    const offline = mkStore({ caches, net });
    const b = await offline.catalog();
    assert.equal(b.source, "cache");
    assert.equal(b.index.version, a.index.version);
    const nothing = mkStore({ caches: fakeCaches(), net });
    await assert.rejects(nothing.catalog(), /isn't on this phone yet/);
    // online, but the server has no catalog.json (never built there): say so, not "connect to the internet"
    const warn = console.warn; console.warn = () => {};
    try {
        await assert.rejects(mkStore({ caches: fakeCaches(), net: fakeNet(new Map()) }).catalog(), (e) => /isn't available from the server right now \(HTTP 404\)/.test(e.message) && !/Connect to the internet/.test(e.message));
    } finally { console.warn = warn; }
    // the failure isn't remembered: a later attempt can succeed
    net.setOnline(true);
    assert.equal((await nothing.catalog()).source, "network");
});

test("catalogue: a malformed download never replaces the cached copy", async () => {
    const caches = fakeCaches();
    await mkStore({ caches }).catalog();
    const broken = new Map(files); broken.set("bikedb/catalog.json", JSON.stringify({ format: "mapunite-bike-catalog/9" }));
    const r = await mkStore({ caches, net: fakeNet(broken) }).catalog();
    assert.equal(r.source, "cache");
});

// ---------------------------------------------------------------------------
// Store: bundles
// ---------------------------------------------------------------------------
test("bundles: checked against their name, cached, then served offline", async () => {
    const caches = fakeCaches(), net = fakeNet();
    const s = mkStore({ caches, net });
    const h = byId.get("royal-enfield-hunter-350-metro-in").hash;
    const b = await s.bundle(h);
    assert.equal(b.id, "royal-enfield-hunter-350-metro-in");
    assert.equal(b.units, "SI");
    net.setOnline(false);
    const again = await mkStore({ caches, net }).bundle(h);
    assert.equal(again.id, b.id);
    await assert.rejects(s.bundle("not-a-hash"), /not a bundle hash/);
});

test("bundles: tampered content is refused and never cached", async () => {
    const h = byId.get("tvs-raider-125-split-seat-in").hash;
    const evil = new Map(files);
    evil.set(`bikedb/bundles/${h}.json`, files.get(`bikedb/bundles/${h}.json`).replace('"conf":0.95', '"conf":0.96'));
    const caches = fakeCaches();
    await assert.rejects(mkStore({ caches, net: fakeNet(evil) }).bundle(h), /isn't on this phone yet/);
    assert.equal([...(caches.stores.get(Store.CACHE_NAME) || new Map()).keys()].filter((k) => k.includes(h)).length, 0);
});

test("bundles: the shipped/static copy first, the Step 5 endpoint (GET /api/bikes/bundles/<hash>) for bikes newer than the app", async () => {
    const h = byId.get("hero-splendor-plus-obd2b-in").hash;
    const shipped = fakeNet();
    assert.equal((await mkStore({ net: shipped, apiBase: "https://maps.example.com/" }).bundle(h)).id, "hero-splendor-plus-obd2b-in");
    assert.deepEqual(shipped.calls.map((c) => c.url), [`bikedb/bundles/${h}.json`], "offline-capable copy, no server round trip");
    const newer = fakeNet((url) => (String(url).startsWith("bikedb/") ? new Response("not found", { status: 404 }) : new Response(files.get(`bikedb/bundles/${h}.json`))));
    assert.equal((await mkStore({ net: newer, apiBase: "https://maps.example.com/" }).bundle(h)).id, "hero-splendor-plus-obd2b-in");
    assert.deepEqual(newer.calls.map((c) => c.url), [`bikedb/bundles/${h}.json`, `https://maps.example.com/api/bikes/bundles/${h}`]);
    const lying = fakeNet((url) => (String(url).startsWith("bikedb/") ? new Response("not found", { status: 404 }) : new Response(files.get(`bikedb/bundles/${h}.json`).replace("Splendor", "Splendour"))));
    await assert.rejects(mkStore({ net: lying, apiBase: "https://maps.example.com" }).bundle(h), /isn't on this phone yet/, "the server's copy is hash-checked too");
});

test("bundles: without Cache Storage they fall back to localStorage", async () => {
    const storage = fakeStorage();
    const h = byId.get("tvs-iqube-3-5kwh-in").hash;
    await mkStore({ caches: null, storage }).bundle(h);
    const net = fakeNet(); net.setOnline(false);
    assert.equal((await mkStore({ caches: null, storage, net }).bundle(h)).id, "tvs-iqube-3-5kwh-in");
});

// ---------------------------------------------------------------------------
// Store: the rider's bike
// ---------------------------------------------------------------------------
test("garage: saved on the phone, follows data corrections, keeps only valid settings", async () => {
    const storage = fakeStorage();
    const s = mkStore({ storage });
    const { index: idx } = await s.catalog();
    assert.equal(s.garage(), null);
    const g = s.saveGarage(s.garageFromPick(idx, { bikeId: "royal-enfield-hunter-350-metro-in", year: 2024, settings: { riderMass: 80, frontSprocket: 15, rearSprocket: 42, rearTyre: " 140/70-17 ", fuelCode: "E10", junk: 1, luggageMass: -5 } }));
    assert.deepEqual(g.settings, { riderMass: 80, frontSprocket: 15, rearSprocket: 42, rearTyre: "140/70-17", fuelCode: "E10" });
    assert.equal(mkStore({ storage }).garage().title, idx.get("royal-enfield-hunter-350-metro-in").title);
    // the catalogue gets a corrected bundle for the same bike: the garage follows it
    const stale = JSON.parse(storage.getItem(Store.GARAGE_KEY)); stale.bundle = "0123456789abcdef";
    storage.setItem(Store.GARAGE_KEY, JSON.stringify(stale));
    assert.equal(s.refreshGarage(idx).bundle, idx.get("royal-enfield-hunter-350-metro-in").bundle);
    // an estimate from a class
    const est = s.garageFromPick(idx, { classKey: "ice_cvt.scooter" });
    assert.equal(est.estimated, true);
    assert.equal(est.bundle, idx.classes.find((c) => c.key === "ice_cvt.scooter").bundle);
    assert.throws(() => s.garageFromPick(idx, { bikeId: "nope" }), /no bike/);
    s.clearGarage();
    assert.equal(s.garage(), null);
});

test("garage → physics model: the bike, its class default and the rider's settings", async () => {
    const s = mkStore();
    const { index: idx } = await s.catalog();
    const g = s.saveGarage(s.garageFromPick(idx, { bikeId: "honda-shine-125-obd2b-in", settings: { riderMass: 90 } }));
    const { model } = await s.model(g, idx);
    assert.equal(model.id, "honda-shine-125-obd2b-in");
    assert.equal(model.drive.source, "class_default", "the Shine's gearing comes from its class default");
    assert.deepEqual(model.params.riderMass, { mean: 90, sigma: 2 });
});

// ---------------------------------------------------------------------------
// Store: requests for missing bikes
// ---------------------------------------------------------------------------
test("missing-bike requests wait offline and are sent to POST /api/bikes/requests once there's a server", async () => {
    const storage = fakeStorage();
    const s0 = mkStore({ storage });
    assert.throws(() => s0.requestBike({ make: " ", model: "Avenger" }), /make and the model/);
    assert.throws(() => s0.requestBike({ make: "Bajaj", model: "x".repeat(61) }), /under 60/);
    assert.throws(() => s0.requestBike({ make: "Bajaj", model: "---" }), /letter or number/);
    assert.throws(() => s0.requestBike({ make: "Bajaj", model: "Avenger", year: 1900 }), /between 1950/);
    s0.requestBike({ make: " Bajaj ", model: "Avenger  220 Street", year: 2023, classKey: "ice_manual.cruiser" });
    assert.equal(await s0.flushRequests(), 1, "no server configured yet: stays queued");
    for (const status of [503, 429, 404, 403]) {
        const net = fakeNet(() => new Response("{}", { status }));
        assert.equal(await mkStore({ storage, net, apiBase: "https://m.example" }).flushRequests(), 1, `HTTP ${status}: keep it for later`);
    }
    const ok = fakeNet(() => new Response(JSON.stringify({ ok: true, status: "queued" }), { status: 202 }));
    assert.equal(await mkStore({ storage, net: ok, apiBase: "https://m.example" }).flushRequests(), 0);
    assert.equal(ok.calls[0].url, "https://m.example/api/bikes/requests");
    assert.equal(ok.calls[0].method, "POST");
    assert.deepEqual(JSON.parse(ok.calls[0].body), { make: "Bajaj", model: "Avenger 220 Street", year: 2023, powertrain: "ice_manual", note: "Closest type picked in the app: ice_manual.cruiser" });
    // invalid in the server's eyes: dropped, never retried forever
    s0.requestBike({ make: "Bajaj", model: "Avenger" });
    assert.equal(await mkStore({ storage, net: fakeNet(() => new Response("{}", { status: 400 })), apiBase: "https://m.example" }).flushRequests(), 0);
    // an outbox entry from an older app version (free-text only) is dropped, not sent malformed
    storage.setItem(Store.OUTBOX_KEY, JSON.stringify([{ id: "x", description: "Bajaj Avenger", classKey: null, at: 1 }]));
    const legacy = fakeNet(() => new Response("{}", { status: 202 }));
    assert.equal(await mkStore({ storage, net: legacy, apiBase: "https://m.example" }).flushRequests(), 0);
    assert.equal(legacy.calls.length, 0);
});

test("a requested bike the server already lists is offered to the rider", async () => {
    const storage = fakeStorage();
    const hunter = index.get("royal-enfield-hunter-350-metro-in");
    const net = fakeNet(() => new Response(JSON.stringify({ ok: true, status: "listed", matches: [hunter] }), { status: 200 }));
    const s = mkStore({ storage, net, apiBase: "https://m.example" });
    const req = s.requestBike({ make: "Royal Enfield", model: "Hunter", year: 2024 });
    assert.equal(await s.flushRequests(), 0, "answered: not queued again");
    assert.deepEqual(s.listed().map((x) => [x.request.id, x.matches[0].id]), [[req.id, "royal-enfield-hunter-350-metro-in"]]);
    s.dismissListed(req.id);
    assert.deepEqual(s.listed(), []);
});

// ---------------------------------------------------------------------------
// Store: search (GET /api/bikes/search)
// ---------------------------------------------------------------------------
const searchServer = (catalogVersion, results) => fakeNet((url) => {
    if (String(url).includes("/api/bikes/search?")) return new Response(JSON.stringify({ ok: true, catalogVersion, total: results.length, results }), { status: 200 });
    return new Response(files.get(String(url)) ?? "not found", { status: files.has(String(url)) ? 200 : 404 });
});

test("search: no server → the offline index, no network at all", async () => {
    const net = fakeNet();
    const s = mkStore({ net });
    const { index: idx } = await s.catalog();
    const before = net.calls.length;
    const a = await s.search(idx, "hunter");
    assert.equal(a.source, "local");
    assert.deepEqual(a.results.map((r) => r.id), ["royal-enfield-hunter-350-metro-in"]);
    assert.equal(net.calls.length, before);
});

test("search: same catalogue on the server → identical answers, so the server isn't asked again this session", async () => {
    const net = searchServer(index.version, index.search("hunter"));
    const s = mkStore({ net, apiBase: "https://m.example" });
    const { index: idx } = await s.catalog();
    const a = await s.search(idx, "hunter");
    assert.equal(a.source, "local");
    const asked = net.calls.filter((c) => c.url.includes("/api/bikes/search")).map((c) => c.url);
    assert.deepEqual(asked, ["https://m.example/api/bikes/search?q=hunter&limit=30"]);
    await s.search(idx, "pulsar");
    assert.equal(net.calls.filter((c) => c.url.includes("/api/bikes/search")).length, 1, "not asked again");
});

test("search: a newer catalogue on the server → its results, and a bike the phone doesn't know yet can be picked", async () => {
    const newBike = { ...index.get("royal-enfield-hunter-350-metro-in"), id: "royal-enfield-guerrilla-450-in", model: "Guerrilla 450", variant: null, title: "Royal Enfield Guerrilla 450" };
    const net = searchServer("ffffffffffffffff", [newBike]);
    const s = mkStore({ net, apiBase: "https://m.example" });
    const { index: idx } = await s.catalog();
    const a = await s.search(idx, "guerrilla");
    assert.equal(a.source, "server");
    assert.deepEqual(a.results.map((r) => r.id), ["royal-enfield-guerrilla-450-in"]);
    assert.equal(idx.get("royal-enfield-guerrilla-450-in"), null, "not in the phone's list");
    const g = s.saveGarage(s.garageFromPick(idx, { bikeId: "royal-enfield-guerrilla-450-in", year: 2025 }));
    assert.equal(g.title, "Royal Enfield Guerrilla 450");
    assert.equal(g.bundle, newBike.bundle);
    assert.equal(s.row(idx, "royal-enfield-guerrilla-450-in").model, "Guerrilla 450");
    assert.equal(s.refreshGarage(idx).bundle, newBike.bundle, "an unknown-to-the-phone bike keeps its bundle");
});

test("search: offline, slow, failing or malformed server → the offline answer, never an error", async () => {
    for (const serve of [() => { throw new TypeError("Failed to fetch"); }, () => new Response("down", { status: 503 }), () => new Response("{not json", { status: 200 }), () => new Response(JSON.stringify({ ok: false, reason: "rate-limited" }), { status: 429 })]) {
        const s = mkStore({ net: fakeNet((url) => (String(url).includes("/api/") ? serve() : new Response(files.get(String(url)) ?? "", { status: 200 }))), apiBase: "https://m.example" });
        const { index: idx } = await s.catalog();
        const a = await s.search(idx, "activa");
        assert.equal(a.source, "local");
        assert.deepEqual(a.results.map((r) => r.id), index.search("activa", { limit: 30 }).map((r) => r.id));
    }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
test("fuel choices: approval comes only from the contract's decision; flex blends hidden unless certified", () => {
    const hunter = byId.get("royal-enfield-hunter-350-metro-in").runtime;
    const activa = byId.get("honda-activa-110-dlx-obd2b-in").runtime;
    assert.deepEqual(Settings.fuelChoices(hunter).map((f) => f.code), ["E0", "E10", "E20"]);
    assert.deepEqual(Settings.fuelChoices(hunter).filter((f) => f.approved).map((f) => f.code), hunter.fuelAdvice.advisable);
    assert.ok(Settings.fuelChoices(activa).every((f) => !f.approved), "the Activa has no fuel at the advice threshold");
    const flex = structuredClone(hunter);
    flex.engine.flexFuel = { v: true, src: "x", conf: 0.9 };
    assert.ok(Settings.fuelChoices(flex).some((f) => f.code === "E85"));
});

test("settings validation: ranges, sprocket pairs, tyre sizes", () => {
    const ctx = { manual: true, ev: false, parseTyre: Physics.tyre.parseTyre, fuels: ["E0", "E10", "E20"] };
    assert.deepEqual(Settings.validate({ riderMass: "78", pillionMass: "", luggageMass: "5", frontSprocket: "15", rearSprocket: "45", rearTyre: "140/70-17", fuelCode: "E10" }, ctx),
        { settings: { riderMass: 78, luggageMass: 5, frontSprocket: 15, rearSprocket: 45, rearTyre: "140/70-17", fuelCode: "E10" }, errors: {} });
    const bad = Settings.validate({ riderMass: "500", frontSprocket: "15", rearSprocket: "", rearTyre: "fat", fuelCode: "E85" }, ctx);
    assert.deepEqual(Object.keys(bad.errors).sort(), ["rearTyre", "riderMass", "sprockets"]);
    assert.equal(bad.settings.fuelCode, undefined, "a fuel that isn't offered is ignored");
    assert.deepEqual(Settings.validate({ frontSprocket: "15", rearSprocket: "45" }, { ...ctx, manual: false }).settings, {}, "no sprockets on a scooter");
    assert.deepEqual(Settings.validate({ riderMass: "72,5" }, ctx).settings, { riderMass: 72.5 }, "a decimal comma is accepted");
});

// ---------------------------------------------------------------------------
// Chart preparation
// ---------------------------------------------------------------------------
const modelOf = (id, settings) => {
    const b = byId.get(id).runtime;
    const cd = art.bundles.find((x) => x.kind === "class_default" && x.classKey === b.classKey).runtime;
    return Physics.createBikeModel(b, { classDefault: b.kind === "variant" ? cd : undefined, settings });
};
const chartOf = (id, env = {}, opts) => { const m = modelOf(id); return { m, c: Viz.prepareChart(Physics.cruiseTable(m, env), m, opts) }; };

test("chart: petrol bike on the flat — km/L, an eco window inside the data, gears in order, nothing NaN", () => {
    const { c } = chartOf("royal-enfield-hunter-350-metro-in", { altitude: 0 });
    assert.equal(c.unit, "km/L");
    assert.ok(c.rows.length > 50 && c.rows[0].kmh > 0);
    for (const r of c.rows) for (const k of ["kmh", "rpm", "wheelKw"]) assert.ok(Number.isFinite(r[k]), k);
    for (const r of c.rows) if (r.feasible) assert.ok(r.lo <= r.value && r.value <= r.hi, `ribbon at ${r.kmh}`);
    assert.ok(c.eco && c.eco.from <= c.eco.best && c.eco.best <= c.eco.to);
    assert.ok(c.eco.from >= 30 - 1e-9, "eco band starts at practical speeds");
    assert.ok(c.gears.length >= 5);
    for (let i = 1; i < c.gears.length; i++) assert.ok(c.gears[i].from >= c.gears[i - 1].to - 1e-9, "gear segments don't overlap");
    assert.ok(c.yTicks[0] === 0 && c.yMax >= Math.max(...c.rows.filter((r) => r.feasible).map((r) => r.value)) * 0.99);
    const hl = Viz.headline(c, 0);
    assert.equal(hl.lead, "Best mileage");
    assert.match(hl.range, /^\d+–\d+ km\/h$/);
});

test("chart: speeds the bike can't hold are marked, and a climb downshifts", () => {
    const flat = chartOf("royal-enfield-hunter-350-metro-in").c;
    const climb = chartOf("royal-enfield-hunter-350-metro-in", { grade: 0.06 }).c;
    assert.ok(flat.blocked.length >= 1 && climb.blocked[0].from < flat.blocked[0].from, "a climb lowers the top speed");
    const topGear = (c) => Math.max(...c.gears.map((g) => g.gear));
    assert.ok(climb.gears[climb.gears.length - 1].gear < topGear(climb), "near its limit on a climb the bike drops a gear");
});

test("chart: gear ribbon only when the physics allows gear advice (C4) — the UI never has to hide it", () => {
    assert.equal(chartOf("honda-activa-110-dlx-obd2b-in").c.gears.length, 0, "CVT");
    assert.equal(chartOf("ather-450x-2-9kwh-2025-in").c.gears.length, 0, "EV");
    assert.equal(chartOf("honda-shine-125-obd2b-in").c.gears.length, 0, "gearing estimated from the class default");
    assert.ok(chartOf("royal-enfield-hunter-350-metro-in").c.gears.length >= 5, "the bike's own gearing");
    // a typical bike (what "My bike isn't listed" picks): the class default bundle itself
    const typical = Physics.createBikeModel(art.bundles.find((x) => x.id === "default-ice-manual-commuter").runtime);
    assert.equal(typical.gearAdvice, false);
    assert.equal(typical.gearAdviceReason, "typical-bike");
    assert.equal(Viz.prepareChart(Physics.cruiseTable(typical), typical).gears.length, 0, "a typical bike's gears are never shown as advice");
    assert.deepEqual(Physics.shiftPoints(typical).ecoUp, [], "and the core gives no shift speeds for it");
});

test("chart: EVs plot energy use, which goes below zero (charging) downhill; range stays in the headline", () => {
    const flat = chartOf("ather-450x-2-9kwh-2025-in").c;
    assert.equal(flat.unit, "Wh/km");
    assert.ok(flat.rows.every((r) => r.value > 0));
    assert.ok(Number.isFinite(flat.eco.value) && flat.eco.value > 20, "range per charge in km");
    assert.match(Viz.headline(flat, 0).detail, /km per charge/);
    const down = chartOf("ather-450x-2-9kwh-2025-in", { grade: -0.06 }).c;
    assert.ok(down.yMin < 0 && down.free.length >= 1, "charging stretches");
    assert.ok(down.rows.some((r) => r.value < 0));
    if (down.eco) assert.match(Viz.headline(down, -0.06).detail, /Wh\/km/);
});

test("chart: petrol descents show the fuel cut instead of an infinite km/L, and the scale stays readable", () => {
    const { c } = chartOf("royal-enfield-hunter-350-metro-in", { grade: -0.08 });
    assert.ok(c.free.length >= 1, "fuel-cut stretch");
    assert.ok(Number.isFinite(c.yMax));
    const finite = c.rows.filter((r) => r.feasible && Number.isFinite(r.value) && r.value > 0).map((r) => r.value).sort((a, b) => a - b);
    if (finite.length >= 4) assert.ok(c.yMax <= Math.max(...Viz.niceTicks(0, 2.2 * finite[Math.floor(0.75 * (finite.length - 1))], 5)) + 1e-9);
});

test("niceTicks and nearestRow", () => {
    assert.deepEqual(Viz.niceTicks(0, 57, 5), [0, 20, 40, 60]);
    assert.deepEqual(Viz.niceTicks(0, 100, 5), [0, 20, 40, 60, 80, 100]);
    assert.deepEqual(Viz.niceTicks(-12, 80, 5), [-20, 0, 20, 40, 60, 80]);
    const { c } = chartOf("royal-enfield-hunter-350-metro-in");
    assert.ok(Math.abs(c.rows[Viz.nearestRow(c, 60)].kmh - 60) <= 1);
});

test("silhouettes: one for every class, with a bolt on EVs", () => {
    for (const cls of index.classes) {
        const svg = Sil.silhouette(cls.key);
        assert.match(svg, /^<svg class="sil"/);
        assert.equal(svg.includes("sil-bolt"), cls.key.startsWith("ev."));
    }
    assert.match(Sil.silhouette("nonsense"), /<svg/);
    assert.ok(!Sil.silhouette("ice_cvt.scooter", { label: "<b>x</b>" }).includes("<b>"), "labels can't inject markup");
});
