// Roadmap Step 9: bridges and tunnels clamped on a route's height profile
// (js/trip/structures.js, applied by js/trip/profile.js buildProfile).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../../public/js/trip/structures.js");
const P = require("../../public/js/trip/profile.js");

/** A straight route north from (20, 85), sampled every `ds` m, with heights z(s). */
function road(lengthM, ds, zf) {
    const n = Math.round(lengthM / ds) + 1;
    const s = new Float64Array(n), z = new Float64Array(n), lat = new Float64Array(n), lng = new Float64Array(n);
    for (let i = 0; i < n; i++) { s[i] = i * ds; z[i] = zf(s[i]); lat[i] = 20 + s[i] / 110540; lng[i] = 85; }
    return { s, z, lat, lng, length: s[n - 1] };
}
const GRADE = 0.02;                                       // the real road: a steady 2 % climb
const bridgeDem = (s) => 100 + GRADE * s - (s > 2000 && s < 2400 ? 32 : 0);          // a 400 m bridge over a 32 m gully
const tunnelDem = (s) => 100 + GRADE * s + (s > 3000 && s < 3700 ? 45 : 0);          // a 700 m tunnel under a 45 m ridge
const trueAscent = (L) => GRADE * L;

test("detect: the DEM's gully under a bridge and ridge over a tunnel are found; the deepest span wins", () => {
    const r = road(6000, 90, (s) => bridgeDem(s) + (tunnelDem(s) - 100 - GRADE * s));
    const spans = S.detect(r.s, r.z);
    assert.deepEqual(spans.map((x) => x.kind), ["bridge", "tunnel"]);
    for (const sp of spans) assert.equal(sp.source, "dem");
    const [b, t] = spans;
    assert.ok(b.s0 >= 1900 && b.s0 <= 2100 && b.s1 >= 2300 && b.s1 <= 2500, JSON.stringify(b));
    assert.ok(t.s0 >= 2900 && t.s0 <= 3100 && t.s1 >= 3600 && t.s1 <= 3800, JSON.stringify(t));
});

test("detect: real roads aren't touched — steady grades, a 6 % valley, a gentle crest, noise", () => {
    let seed = 3;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const cases = {
        steady: (s) => 100 + 0.05 * s,
        valley: (s) => 300 - 0.06 * Math.min(s, 1500) + 0.06 * Math.max(0, s - 1500),        // 6 % down 1.5 km, 6 % up
        crest: (s) => 100 + 25 * Math.exp(-(((s - 2000) / 600) ** 2)),
        noisy: (s) => 100 + 0.01 * s + (rnd() - 0.5) * 4
    };
    for (const [name, f] of Object.entries(cases)) assert.deepEqual(S.detect(road(4000, 90, f).s, road(4000, 90, f).z), [], name);
});

test("apply: across a span the heights become a straight grade from just beyond one end to the other", () => {
    const r = road(5000, 90, bridgeDem);
    const z = Float64Array.from(r.z);
    const { clamped } = S.apply(r.s, z, [{ s0: 2050, s1: 2350, kind: "bridge", source: "osm" }]);
    for (let i = 0; i < r.s.length; i++) assert.ok(Math.abs(z[i] - (100 + GRADE * r.s[i])) < 1e-9, `s=${r.s[i]}: ${z[i]}`);
    assert.ok(clamped >= 300 && clamped <= 500);
    // at the route's ends: clamped from the side that's known
    const z2 = Float64Array.from(r.z);
    S.apply(r.s, z2, [{ s0: 0, s1: 200, kind: "tunnel", source: "osm" }]);
    assert.ok(z2.every(Number.isFinite));
});

test("buildProfile: the bridge's phantom 32 m descent and climb are gone, and it says what it clamped", () => {
    const r = road(5000, 90, bridgeDem);
    const raw = P.buildProfile(r.s, r.z, { detectStructures: false });
    const fixed = P.buildProfile(r.s, r.z);
    assert.ok(raw.ascent > trueAscent(5000) + 20, `without clamping: ${raw.ascent} m of climbing`);
    assert.ok(Math.abs(fixed.ascent - trueAscent(5000)) < 3, `clamped: ${fixed.ascent} m (true ${trueAscent(5000)})`);
    assert.ok(fixed.descent < 1, `no phantom descent: ${fixed.descent}`);
    assert.deepEqual(fixed.structures.map((x) => [x.kind, x.source]), [["bridge", "dem"]]);
    assert.ok(fixed.structureShare > 0.05 && fixed.structureShare < 0.15);
    // known spans (OpenStreetMap) are used as given, in the resample's metres, scaled with the route distance
    const known = P.buildProfile(r.s, r.z, { structures: [{ s0: 2050, s1: 2350, kind: "bridge", source: "osm", name: "Kolab bridge" }], distance: 5100 });
    assert.deepEqual(known.structures.map((x) => [x.kind, x.source, x.name]), [["bridge", "osm", "Kolab bridge"]]);
    assert.ok(Math.abs(known.structures[0].s0 - 2050 * 5100 / r.s[r.s.length - 1]) < 1e-6);
    assert.ok(Math.abs(known.ascent - trueAscent(5000)) < 3);
    // a flat profile (no DEM) has nothing to clamp
    assert.deepEqual(P.buildProfile(r.s, null).structures, []);
});

test("buildProfile: a tunnel's 45 m ridge isn't climbed", () => {
    const r = road(6000, 90, tunnelDem);
    const fixed = P.buildProfile(r.s, r.z);
    assert.ok(Math.abs(fixed.ascent - trueAscent(6000)) < 3, `${fixed.ascent}`);
    assert.deepEqual(fixed.structures.map((x) => x.kind), ["tunnel"]);
});

// ---------------------------------------------------------------------------- OpenStreetMap
const route = road(5000, 100, () => 0);
const node = (s, dx = 0) => ({ lat: 20 + s / 110540, lon: 85 + dx / (111320 * Math.cos(20 * Math.PI / 180)) });
const osmJson = {
    elements: [
        { type: "way", id: 1, tags: { highway: "primary", bridge: "yes", name: "Kolab bridge" }, geometry: [node(2000, 3), node(2200, 4)] },
        { type: "way", id: 2, tags: { highway: "primary", bridge: "yes" }, geometry: [node(2195, 2), node(2400, 2)] },             // the same bridge, split
        { type: "way", id: 3, tags: { highway: "residential", bridge: "yes" }, geometry: [node(3000, -200), node(3000, 200)] },     // a flyover crossing OVER the route
        { type: "way", id: 4, tags: { highway: "primary", tunnel: "yes" }, geometry: [node(4000, 0), node(4300, 0), node(4600, 1)] },
        { type: "way", id: 5, tags: { highway: "primary", bridge: "no" }, geometry: [node(100, 0), node(300, 0)] },
        { type: "node", id: 6, lat: 20, lon: 85 }
    ]
};

test("fromOsm: bridges and tunnels ALONG the route, split ways merged, crossings and bridge=no ignored", () => {
    const spans = S.fromOsm(osmJson, route);
    assert.deepEqual(spans.map((x) => [x.kind, Math.round(x.s0), Math.round(x.s1), x.name || null, x.source]), [
        ["bridge", 2000, 2400, "Kolab bridge", "osm"],
        ["tunnel", 4000, 4600, null, "osm"]
    ]);
    assert.deepEqual(S.fromOsm({}, route), []);
    assert.deepEqual(S.fromOsm(osmJson, { s: [0], lat: [20], lng: [85] }), []);
});

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

test("along: one Overpass query with only the route's coordinates, cached for 30 days, stale beats nothing offline", async () => {
    const calls = [];
    let mode = "ok", t = Date.parse("2026-10-04T10:00:00Z");
    const fetch = async (url, init) => {
        calls.push({ url, init });
        if (mode === "offline") throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify(osmJson), { status: 200 });
    };
    const cs = fakeCaches();
    const api = S.createStructures({ fetch, caches: /** @type {any} */ (cs), now: () => t });
    let r = await api.along(route);
    assert.equal(r.source, "osm");
    assert.equal(r.spans.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, S.ENDPOINT);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.credentials, "omit");
    const q = decodeURIComponent(calls[0].init.body.replace(/^data=/, ""));
    assert.match(q, /way\["highway"\]\["bridge"\]\["bridge"!="no"\]\(around:25,/);
    assert.match(q, /\["tunnel"~"\^\(yes\|avalanche_protector\)\$"\]/);
    assert.doesNotMatch(q, /[a-zA-Z]{3,}=[^"]*@|device|user|token/i);
    assert.ok([...cs.stores.get("mu-trip-v1").keys()].every((k) => k.startsWith("/__mu/trip/structures/")));
    r = await api.along(route);
    assert.deepEqual([r.source, calls.length], ["cache", 1]);
    t += 31 * 86400000; mode = "offline";
    r = await api.along(route);
    assert.deepEqual([r.source, r.spans.length], ["stale", 2]);
    r = await S.createStructures({ fetch, caches: null }).along(route);
    assert.deepEqual([r.source, r.spans], ["none", []]);
    assert.ok(S.thin(route.lat, route.lng, 300).length <= 301);
});
