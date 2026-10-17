// lib/map-detail.js: OSM place names for the map (Overpass tiles, cached, shared) and the optional Google Map Tiles proxy
// (key stays on the server; off without a key).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createMapDetail, kindOf, compactPlace, placesQuery, tileBounds } = require("../../lib/map-detail.js");

/** A tiny Express-like response. */
function res() {
    const r = { code: 200, headers: {}, body: null, ended: false };
    return Object.assign(r, {
        status(c) { r.code = c; return r; }, json(b) { r.body = b; r.ended = true; return r; }, setHeader(k, v) { r.headers[k.toLowerCase()] = v; },
        end(b) { r.body = b ?? r.body; r.ended = true; return r; }
    });
}
const okJson = (j) => ({ ok: true, status: 200, json: async () => j, headers: new Map() });

test("kinds from OSM tags, and what isn't labelled", () => {
    assert.equal(kindOf({ place: "suburb" }), "area");
    assert.equal(kindOf({ amenity: "hospital" }), "health");
    assert.equal(kindOf({ amenity: "fuel" }), "fuel");
    assert.equal(kindOf({ amenity: "place_of_worship", religion: "hindu" }), "worship");
    assert.equal(kindOf({ leisure: "fitness_centre" }), "gym");
    assert.equal(kindOf({ amenity: "school" }), "education");
    assert.equal(kindOf({ shop: "mobile_phone" }), "shop");
    assert.equal(kindOf({ tourism: "hotel" }), "lodging");
    assert.equal(kindOf({ amenity: "restaurant" }), "food");
    assert.equal(kindOf({ highway: "residential" }), null, "roads are the label layer's job");
});

test("a place carries only what the map draws; an English name only when it differs", () => {
    const p = compactPlace({ type: "node", id: 42, lat: 22.2475123456, lon: 84.8418, tags: { name: "ଶ୍ରୀ ଶନି ମନ୍ଦିର", "name:en": "Sree Shani Temple", amenity: "place_of_worship", phone: "123" } });
    assert.deepEqual(p, { id: "n42", lat: 22.247512, lng: 84.8418, name: "ଶ୍ରୀ ଶନି ମନ୍ଦିର", kind: "worship", rank: 3, en: "Sree Shani Temple" });
    const w = compactPlace({ type: "way", id: 7, center: { lat: 22.25, lon: 84.84 }, tags: { name: "SharkFit Gym", "name:en": "sharkfit gym", leisure: "fitness_centre" } });
    assert.equal(w.id, "w7");
    assert.equal(w.en, undefined);
    assert.equal(compactPlace({ type: "node", id: 1, lat: 1, lon: 1, tags: { amenity: "bench" } }), null, "no name, no label");
});

test("tile bounds and the Overpass query (named things only, ways by their centre)", () => {
    assert.deepEqual(tileBounds("2224:8484"), { s: 22.24, w: 84.84, n: 22.25, e: 84.85 });
    const q = placesQuery("2224:8484");
    assert.match(q, /node\(22\.24,84\.84,22\.25,84\.85\)\[name\]/);
    assert.match(q, /out center tags;$/);
});

test("places: fetched once per tile and shared; bad input refused; Overpass failures retried later, not cached for a day", async () => {
    let calls = 0, t = 1e6, fail = false;
    const fetchFake = async (url, init) => {
        calls++;
        assert.match(url, /overpass/);
        assert.match(decodeURIComponent(init.body), /\[out:json\]/);
        if (fail) return { ok: false, status: 504 };
        return okJson({ elements: [
            { type: "node", id: 1, lat: 22.245, lon: 84.845, tags: { name: "Sai Fast Food", amenity: "fast_food" } },
            { type: "node", id: 2, lat: 22.246, lon: 84.846, tags: { name: "Sector 7", place: "suburb" } },
            { type: "node", id: 2, lat: 22.246, lon: 84.846, tags: { name: "Sector 7", place: "suburb" } },
            { type: "node", id: 3, lat: 22.247, lon: 84.847, tags: { amenity: "bench" } }
        ] });
    };
    const md = createMapDetail({ env: {}, fetch: fetchFake, now: () => t, log: () => {} });
    const r1 = res();
    await md.placesHandler({ query: { tiles: "2224:8484" } }, r1);
    assert.equal(r1.code, 200);
    assert.deepEqual(r1.body.tiles["2224:8484"].places.map((p) => p.name), ["Sector 7", "Sai Fast Food"], "deduplicated, most important first");
    assert.equal(r1.headers["cache-control"], "public, max-age=3600");
    await md.placesHandler({ query: { tiles: "2224:8484" } }, res());
    assert.equal(calls, 1, "second rider: from the cache");

    for (const bad of ["", "x:y", "1:2,3", Array.from({ length: 13 }, (_, i) => `1:${i}`).join(",")]) {
        const r = res();
        await md.placesHandler({ query: { tiles: bad } }, r);
        assert.equal(r.code, 400, bad);
    }

    fail = true;
    const r2 = res();
    await md.placesHandler({ query: { tiles: "2225:8484" } }, r2);
    assert.deepEqual(r2.body.tiles["2225:8484"], { failed: true });
    assert.equal(r2.headers["cache-control"], "no-store");
    t += 61e3;                                    // a minute later it's tried again
    fail = false;
    const r3 = res();
    await md.placesHandler({ query: { tiles: "2225:8484" } }, r3);
    assert.ok(Array.isArray(r3.body.tiles["2225:8484"].places));
});

test("places: at most 2 Overpass queries in flight; the rest answer busy", async () => {
    const resolvers = [];
    const md = createMapDetail({ env: {}, log: () => {}, fetch: () => new Promise((r) => resolvers.push(() => r(okJson({ elements: [] })))) });
    const r = res();
    const p = md.placesHandler({ query: { tiles: "1:1,1:2,1:3" } }, r);
    await new Promise((s) => setImmediate(s));
    assert.equal(resolvers.length, 2);
    resolvers.forEach((f) => f());
    await p;
    assert.deepEqual(Object.values(r.body.tiles).filter((x) => x.busy).length, 1);
});

test("Google tiles: off without a key; the key never leaves the server; one session reused, renewed when Google says it expired", async () => {
    const off = createMapDetail({ env: {}, log: () => {} });
    assert.equal(off.googleEnabled, false);
    const r0 = res();
    await off.googleTileHandler({ params: { type: "satellite", z: "16", x: "1", y: "1" } }, r0);
    assert.equal(r0.code, 503);
    assert.equal(createMapDetail({ env: { GOOGLE_MAPS_SERVER_KEY: "k" } }).googleEnabled, false, "the Places key alone doesn't turn tiles on");
    assert.equal(createMapDetail({ env: { GOOGLE_MAPS_SERVER_KEY: "k", MAP_TILES_GOOGLE: "1" } }).googleEnabled, true);

    const seen = [];
    let sessionN = 0, expireNext = false;
    const fetchFake = async (url, init) => {
        seen.push({ url, init });
        if (url.includes("/v1/createSession")) {
            assert.deepEqual(JSON.parse(init.body), { mapType: "satellite", language: "en-US", region: "IN", layerTypes: ["layerRoadmap"] });
            sessionN++;
            return okJson({ session: `S${sessionN}`, expiry: String(Math.floor(Date.now() / 1000) + 14 * 86400) });
        }
        if (url.includes("/v1/2dtiles/")) {
            if (expireNext && url.includes("session=S1")) return { ok: false, status: 401, headers: new Map() };
            return { ok: true, status: 200, headers: new Map([["content-type", "image/jpeg"], ["cache-control", "private, max-age=86400"]]), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
        }
        if (url.includes("/tile/v1/viewport")) return okJson({ copyright: "Imagery ©2026 Airbus, Maxar Technologies, Map data ©2026 Google" });
        throw new Error(url);
    };
    const md = createMapDetail({ env: { GOOGLE_MAP_TILES_KEY: "SECRET" }, fetch: fetchFake, log: () => {} });
    assert.equal(md.googleEnabled, true);
    const r1 = res();
    await md.googleTileHandler({ params: { type: "satellite", z: "16", x: "47825", y: "29279" } }, r1);
    assert.equal(r1.code, 200);
    assert.equal(r1.headers["content-type"], "image/jpeg");
    assert.equal(r1.headers["cache-control"], "private, max-age=86400", "Google's own cache rule, passed through");
    assert.deepEqual([...r1.body], [1, 2, 3]);
    assert.match(seen[1].url, /^https:\/\/tile\.googleapis\.com\/v1\/2dtiles\/16\/47825\/29279\?session=S1&key=SECRET$/);
    await md.googleTileHandler({ params: { type: "satellite", z: "16", x: "47826", y: "29279" } }, res());
    assert.equal(sessionN, 1, "one session for many tiles");
    expireNext = true;
    const r2 = res();
    await md.googleTileHandler({ params: { type: "satellite", z: "16", x: "47827", y: "29279" } }, r2);
    assert.equal(r2.code, 200);
    assert.equal(sessionN, 2, "expired: renewed once");

    for (const p of [{ type: "hybrid", z: "1", x: "0", y: "0" }, { type: "satellite", z: "23", x: "0", y: "0" }, { type: "satellite", z: "2", x: "4", y: "0" }, { type: "satellite", z: "2", x: "-1", y: "0" }]) {
        const r = res();
        await md.googleTileHandler({ params: p }, r);
        assert.equal(r.code, 400, JSON.stringify(p));
    }
    const ra = res();
    await md.googleAttributionHandler({ query: { type: "satellite", zoom: "16", n: "22.26", s: "22.24", e: "84.85", w: "84.83" } }, ra);
    assert.equal(ra.body.copyright, "Imagery ©2026 Airbus, Maxar Technologies, Map data ©2026 Google");
    const rb = res();
    await md.googleAttributionHandler({ query: { type: "satellite", zoom: "16", n: "99", s: "22.24", e: "84.85", w: "84.83" } }, rb);
    assert.equal(rb.code, 400);
    // nothing the handlers send back contains the key
    for (const r of [r1, r2, ra]) assert.ok(!JSON.stringify(r.body).includes("SECRET") && !JSON.stringify(r.headers).includes("SECRET"));
});
