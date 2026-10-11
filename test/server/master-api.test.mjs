// Master AI server engines (lib/master/): pure handlers with a fake fetch, no network
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCache } = require("../../lib/master/cache.js");
const { createUpstream } = require("../../lib/master/upstream.js");
const GEO = require("../../lib/master/geo.js");
const W = require("../../lib/master/weather.js");
const TR = require("../../lib/master/traffic.js");
const RD = require("../../lib/master/road.js");
const BS = require("../../lib/master/blackspots.js");
const POI = require("../../lib/master/poi.js");
const S = require("../../lib/master/search.js");
const LLM = require("../../lib/master/llm.js");
const SAFE = require("../../lib/master/safety.js");
const SUN = require("../../lib/master/sun.js");
const MU = require("../../lib/master/music.js");
const API = require("../../lib/master/http-api.js");
const IMP = await import("../../scripts/master/import-blackspots.mjs");

/** A fake fetch: route(url, init) → { status?, json } | throws. Records calls. */
function fakeFetch(route) {
    const calls = [];
    const f = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const r = await route(String(url), init);
        const status = r.status ?? 200;
        return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => r.json };
    };
    f.calls = calls;
    return f;
}
const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 11, 9, 0, 0);

// ---------------------------------------------------------------- infrastructure
test("cache: single-flight, TTL, stale-if-error, LRU bound", async () => {
    let t = 0, loads = 0;
    const c = createCache({ max: 2, ttlMs: 100, staleMs: 1000, now: () => t });
    const slow = () => new Promise((r) => setTimeout(() => r(++loads), 5));
    const [a, b] = await Promise.all([c.wrap("k", slow), c.wrap("k", slow)]);
    assert.equal(a, 1); assert.equal(b, 1); assert.equal(loads, 1);
    t = 150;                                                    // expired
    assert.equal(await c.wrap("k", async () => { throw new Error("down"); }), 1);   // stale served
    t = 5000;
    await assert.rejects(c.wrap("k", async () => { throw new Error("down"); }));      // too old: the error
    c.set("x", 1); c.set("y", 2); c.set("z", 3);
    assert.equal(c.stats().size, 2);
});

test("upstream: retries 503 once, never a 400; the circuit opens after repeated failures", async () => {
    let n = 0;
    const f = fakeFetch(() => { n++; return { status: 503, json: {} }; });
    let t = 0;
    const up = createUpstream({ name: "x", fetchImpl: f, now: () => t, sleep: async () => {}, failuresToOpen: 2 });
    await assert.rejects(up.json("https://a/?key=SECRET"), (e) => e.code === "HTTP_ERROR" && !String(e.message).includes("SECRET"));
    assert.equal(n, 2);                                         // one retry
    await assert.rejects(up.json("https://a/"));
    await assert.rejects(up.json("https://a/"), (e) => e.code === "CIRCUIT_OPEN");
    assert.equal(n, 4);                                         // open: no call made
    const bad = createUpstream({ name: "y", fetchImpl: fakeFetch(() => ({ status: 400, json: {} })), sleep: async () => {} });
    await assert.rejects(bad.json("https://b/"), (e) => e.status === 400);
    assert.equal(bad.state().failures, 0);                       // a 4xx isn't the upstream's fault
});

test("geo: distance to a polyline and its along-line position; line validation", () => {
    const line = [[20, 85], [20, 85.01]];                       // ~1045 m due east
    const r = GEO.distanceToLine(20.001, 85.005, line);
    assert.ok(Math.abs(r.d - 111) < 3, `d=${r.d}`);
    assert.ok(Math.abs(r.s - 523) < 5, `s=${r.s}`);
    assert.equal(GEO.cleanLine([[0, 0], [1, 1]]), null);        // null island
    assert.equal(GEO.cleanLine([[20, 85], [21, 85]]), null);    // 111 km: too long
    assert.equal(GEO.cleanLine(Array.from({ length: 41 }, () => [20, 85])), null);
    assert.equal(GEO.cleanLine([[20, 85], [20.001, 85]]).length, 2);
});

// ---------------------------------------------------------------- weather
test("weather: hazard thresholds", () => {
    const types = (s) => W.classify(s).map((h) => `${h.type}:${h.level}`);
    assert.deepEqual(types({ code: 95 }), ["storm:warning"]);
    assert.deepEqual(types({ code: 63, precipMmH: 3 }), ["rain:advice"]);
    assert.deepEqual(types({ code: 3, precipMmH: 9 }), ["heavy-rain:warning"]);
    assert.deepEqual(types({ code: 45, visibilityM: 150 }), ["fog:warning"]);
    assert.deepEqual(types({ gustMs: 18 }), ["wind:warning"]);
    assert.deepEqual(types({ feelsC: 42, tempC: 39, rhPct: 15 }), ["heat:warning", "dry:advice"]);
    assert.deepEqual(types({ pm10: 300 }), ["dust:advice"]);
    assert.deepEqual(types({ dust: 500 }), ["dust:warning"]);
    assert.deepEqual(types({ code: 2, rainProb1hPct: 80 }), ["rain-soon:advice"]);
    assert.deepEqual(types({ code: 1, tempC: 28, feelsC: 30, rhPct: 60, gustMs: 5, visibilityM: 20000 }), []);
});

test("weather: one multi-location request per corridor, SI units, 15-min rain scaled to mm/h, cell cache shared", async () => {
    const f = fakeFetch((url) => {
        if (url.includes("air-quality")) return { json: [{ current: { pm10: 40, dust: 0 } }, { current: { pm10: 320, dust: 10 } }] };
        assert.match(url, /wind_speed_unit=ms/);
        return { json: [
            { current: { time: "2026-10-11T09:00", interval: 900, temperature_2m: 30, apparent_temperature: 33, relative_humidity_2m: 70, precipitation: 0, weather_code: 1, wind_gusts_10m: 4 }, hourly: { visibility: [24000, 24000], precipitation_probability: [10, 20] } },
            { current: { time: "2026-10-11T09:00", interval: 900, temperature_2m: 26, apparent_temperature: 28, relative_humidity_2m: 95, precipitation: 1, weather_code: 63, wind_gusts_10m: 9 }, hourly: { visibility: [5000, 4000], precipitation_probability: [90, 95] } }
        ] };
    });
    const w = W.createWeather({ fetchImpl: f, now: () => NOW });
    const body = { points: [[20.0001, 85.0001, 0], [20.0002, 85.0003, 400], [20.0151, 85.0001, 1700]] };
    const r = await w.handle(body);
    assert.equal(r.status, 200);
    assert.equal(f.calls.length, 2);                              // forecast + air, 2 cells in one request each
    const far = r.json.samples[2];
    assert.equal(far.precipMmH, 4);                               // 1 mm in 15 min → 4 mm/h
    assert.deepEqual(far.hazards.map((h) => h.type), ["rain", "dust"]);
    assert.equal(r.json.samples[0].hazards.length, 0);
    await w.handle(body);
    assert.equal(f.calls.length, 2);                              // cached per cell
    assert.equal((await w.handle({ points: [[95, 85, 0]] })).status, 400);
});

// ---------------------------------------------------------------- traffic
test("traffic: not configured → 503; km/h → m/s; levels from the speed ratio", async () => {
    assert.equal((await TR.createTraffic({}).handle({ points: [[20, 85, 0]] })).status, 503);
    const f = fakeFetch((url) => {
        assert.match(url, /key=TT/);
        return url.includes("20.01000") ? { json: { flowSegmentData: { currentSpeed: 9, freeFlowSpeed: 45, currentTravelTime: 300, freeFlowTravelTime: 60, confidence: 0.9 } } }
            : { json: { flowSegmentData: { currentSpeed: 40, freeFlowSpeed: 45, currentTravelTime: 60, freeFlowTravelTime: 55, confidence: 0.9 } } };
    });
    const t = TR.createTraffic({ apiKey: "TT", fetchImpl: f });
    const r = await t.handle({ points: [[20, 85, 500], [20.01, 85, 1500]] });
    assert.equal(r.json.segments[0].level, "free");
    assert.equal(r.json.segments[1].level, "jam");
    assert.equal(r.json.segments[1].speedMs, 2.5);
    assert.equal(r.json.segments[1].delayS, 240);
    assert.equal(TR.levelOf({ speedMs: 10, freeFlowMs: 12, closed: true, confidence: 1 }), "closed");
    assert.equal(TR.levelOf({ speedMs: 2, freeFlowMs: 12, closed: false, confidence: 0.3 }), "unknown");
});

// ---------------------------------------------------------------- road topology
test("road: breakers and crossings near the line are kept; a flyover crossing above is dropped; a bridge along it is kept", () => {
    const line = [[20, 85], [20, 85.02]];                       // ~2.1 km east
    const json = { elements: [
        { type: "node", id: 1, lat: 20.0001, lon: 85.005, tags: { traffic_calming: "bump" } },
        { type: "node", id: 2, lat: 20.0001, lon: 85.0051, tags: { traffic_calming: "hump" } },     // same breaker mapped twice
        { type: "node", id: 3, lat: 20.002, lon: 85.01, tags: { railway: "level_crossing" } },      // 220 m off the line
        { type: "way", id: 4, tags: { highway: "primary", bridge: "yes", name: "Over" }, geometry: [{ lat: 19.995, lon: 85.012 }, { lat: 20.005, lon: 85.012 }] },   // crosses
        { type: "way", id: 5, tags: { highway: "primary", bridge: "yes", name: "River bridge" }, geometry: [{ lat: 20, lon: 85.015 }, { lat: 20, lon: 85.0175 }] },
        { type: "way", id: 6, tags: { highway: "primary", incline: "-12%" }, geometry: [{ lat: 20, lon: 85.001 }, { lat: 20, lon: 85.003 }] }
    ] };
    const f = RD.toFeatures(json, line);
    assert.deepEqual(f.map((x) => x.type), ["steep", "breaker", "bridge"]);
    const bridge = f.find((x) => x.type === "bridge");
    assert.ok(bridge.lengthM > 200 && bridge.sAlongM > 1500);
    assert.equal(RD.inclineOf("8°") > 0.14, true);
    assert.equal(RD.inclineOf("up"), null);
    assert.match(RD.query(line), /around:30,20,85,20,85.02/);
});

// ---------------------------------------------------------------- blackspots
test("blackspots: datasets load with their source, bad rows are dropped, corridor lookup uses each spot's radius", async () => {
    const b = BS.createBlackspots();
    const res = b.load([{ v: 1, source: { id: "test-src", name: "Test", retrieved: "2026-01-01" }, spots: [
        { id: "A", lat: 20.0005, lng: 85.01, radiusM: 200, fatalities: 4, accidents: 11 },
        { id: "B", lat: 20.02, lng: 85.01, radiusM: 300 },               // 2.2 km off
        { id: "C", lat: 0, lng: 0 }, { id: "D", lat: "x", lng: 85 }
    ] }, { v: 2, source: { id: "ignored" }, spots: [] }]);
    assert.equal(res.count, 2);
    const r = await b.handle({ line: [[20, 85], [20, 85.02]] });
    assert.equal(r.json.spots.length, 1);
    assert.equal(r.json.spots[0].id, "test-src:A");
    assert.ok(Math.abs(r.json.spots[0].sAlongM - 1046) < 10);
    assert.match(r.json.datasetVersion, /test-src@2026-01-01:2/);
    assert.equal(BS.createBlackspots().loadDir("/nonexistent").count, 0);
});

test("blackspot importer: quoted CSV, header detection, rows without coordinates skipped", () => {
    const rows = IMP.parseCsv('S No,Location,"NH No",Latitude,Longitude,Total Fatalities\r\n1,"Near ""Old"" bridge, km 4",NH16,20.1,85.2,7\n2,No coords,NH16,,,3\n');
    const { spots, skipped } = IMP.toSpots(rows, {}, { id: "x", radius: 500 });
    assert.equal(skipped, 1);
    assert.deepEqual(spots[0], { id: "1", lat: 20.1, lng: 85.2, name: 'Near "Old" bridge, km 4', road: "NH16", accidents: undefined, fatalities: 7, period: "", radiusM: 500 });
    assert.throws(() => IMP.toSpots([["a", "b"]], {}, { id: "x" }), /latitude/);
});

// ---------------------------------------------------------------- POI vetting
const rv = (rating, daysAgo, text) => ({ rating, publishTime: new Date(NOW - daysAgo * DAY).toISOString(), text });
test("poi vetting: Bayesian ranking, minimum volume, red flags, closed, bursts, copy-paste, category fit", () => {
    const big = POI.vet({ cat: "food", name: "Highway Dhaba", rating: 4.4, reviewsCount: 900, phone: "+91 1", types: ["restaurant"] }, NOW);
    const tiny = POI.vet({ cat: "food", name: "New Dhaba", rating: 4.9, reviewsCount: 6, phone: "+91 1", types: ["restaurant"] }, NOW);
    assert.ok(big.score > tiny.score);
    assert.equal(big.tier, "vetted");
    assert.notEqual(tiny.tier, "vetted");
    const flagged = POI.vet({ cat: "mechanic", name: "Raju Bike Works", rating: 4.3, reviewsCount: 120, types: ["car_repair"], reviews: [rv(1, 20, "Total fraud, overcharged me for fake parts"), rv(5, 40, "good")] }, NOW);
    assert.ok(flagged.flags.includes("red-flag") && flagged.tier !== "vetted");
    assert.equal(POI.vet({ cat: "food", name: "X", rating: 4.5, reviewsCount: 300, reviews: [rv(1, 10, "This place is permanently closed now")] }, NOW).ok, false);
    assert.equal(POI.vet({ cat: "food", name: "X", rating: 4.5, reviewsCount: 300, businessStatus: "CLOSED_TEMPORARILY" }, NOW).ok, false);
    const burst = POI.vet({ cat: "hotel", name: "Stay", rating: 4.8, reviewsCount: 40, types: ["lodging"], reviews: [rv(5, 1, "a"), rv(5, 3, "b"), rv(5, 5, "c"), rv(5, 7, "d")] }, NOW);
    assert.ok(burst.flags.includes("review-burst"));
    const dup = POI.vet({ cat: "food", name: "Y", rating: 4.6, reviewsCount: 200, reviews: [rv(5, 100, "very nice food and great service will come again for sure"), rv(5, 120, "very nice food and great service will come again for sure friends")] }, NOW);
    assert.ok(dup.flags.includes("duplicate-reviews"));
    assert.equal(POI.vet({ cat: "mechanic", name: "Sharma Sweets", rating: 4.6, reviewsCount: 80, types: ["bakery"] }, NOW).ok, false);
    assert.equal(POI.vet({ cat: "hospital", name: "OSM Hospital" }, NOW).tier, "unvetted");
});

test("poi: Google + OSM merged (twin keeps Google, borrows the OSM phone), Google fields marked not storable", async () => {
    const f = fakeFetch((url, init) => {
        if (url.includes("places.googleapis.com")) {
            assert.equal(init.headers["X-Goog-Api-Key"], "GK");
            return { json: { places: [{ id: "g1", displayName: { text: "City Care Hospital" }, location: { latitude: 20.001, longitude: 85.001 }, rating: 4.2, userRatingCount: 400, businessStatus: "OPERATIONAL", types: ["hospital"] }] } };
        }
        return { json: { elements: [
            { type: "node", id: 9, lat: 20.0012, lon: 85.0011, tags: { amenity: "hospital", name: "City Care Hospital", phone: "+91 6852 222222" } },
            { type: "way", id: 10, center: { lat: 20.01, lon: 85.01 }, tags: { amenity: "hospital", name: "District HQ Hospital", emergency: "yes" } }
        ] } };
    });
    const p = POI.createPoi({ googleKey: "GK", fetchImpl: f, now: () => NOW });
    const r = await p.handle({ lat: 20, lng: 85, radiusM: 2000, categories: ["hospital"] });
    assert.equal(r.status, 200);
    assert.equal(r.json.places.length, 2);
    const g = r.json.places.find((x) => x.source === "google");
    assert.equal(g.phone, "+91 6852 222222");
    assert.deepEqual(g.storable, ["placeId", "lat", "lng"]);
    assert.equal(r.json.places.find((x) => x.source === "osm").storable, true);
    assert.equal((await p.handle({ lat: 20, lng: 85, categories: ["casino"] })).status, 400);
});

// ---------------------------------------------------------------- deep search
const ANSWER = (spoken, extra = {}) => JSON.stringify({ spoken, title: "Fuel nearby", summary: "There is a pump.", bullets: ["Open 24h"], confidence: 0.8, time_sensitive: false, ...extra });
/** A fake world: Gemini, Ollama (/api/tags, /api/chat) and Wikipedia, each scriptable. */
function llmWorld({ gemini, chat, tags = ["llama3.2:3b"], wiki = [] } = {}) {
    const seen = { gemini: [], chat: [], wiki: 0, tags: 0 };
    const f = fakeFetch(async (url, init) => {
        if (url.includes("generativelanguage.googleapis.com")) { const body = JSON.parse(init.body); seen.gemini.push({ url, body, key: init.headers["x-goog-api-key"] }); return gemini(body); }
        if (url.endsWith("/api/tags")) { seen.tags++; return tags === null ? Promise.reject(new TypeError("fetch failed")) : { json: { models: tags.map((name) => ({ name })) } }; }
        if (url.endsWith("/api/chat")) { const body = JSON.parse(init.body); seen.chat.push(body); return chat(body); }
        if (url.includes("wikipedia.org")) { seen.wiki++; return { json: { pages: wiki } }; }
        throw new Error(`unexpected ${url}`);
    });
    return { f, seen };
}
const geminiOk = (text, chunks = [{ web: { uri: "https://b.example/y", title: "b.example" } }]) => () => ({ json: { candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text }] }, finishReason: "STOP", groundingMetadata: { webSearchQueries: ["petrol pump"], groundingChunks: chunks } }] } });

test("deep search on Gemini: grounded with Google Search, sources from grounding chunks, speech made safe, cache + budget", async () => {
    const { f, seen } = llmWorld({ gemini: geminiOk("```json\n" + ANSWER("Bhai, pump 2 km aage hai, number 9876543210 hai, details https://x.y pe. Emergency ho toh 112.") + "\n```") });
    const engines = LLM.enginesFromEnv({ GEMINI_API_KEY: "GK", OLLAMA_DISABLED: "1" }, { fetchImpl: f, now: () => NOW });
    const s = S.createSearch({ engines, now: () => NOW, dailyMax: 1 });
    const r = await s.handle({ query: "petrol pump kahan hai", context: { lat: 20.2, lng: 85.1, riding: true } });
    assert.equal(r.status, 200);
    assert.equal(seen.gemini[0].key, "GK");
    assert.match(seen.gemini[0].url, /models\/gemini-flash-latest:generateContent$/);
    assert.deepEqual(seen.gemini[0].body.tools, [{ google_search: {} }]);
    assert.match(seen.gemini[0].body.systemInstruction.parts[0].text, /Desi|desi/);
    assert.deepEqual([r.json.engine, r.json.grounded], ["gemini", true]);
    assert.doesNotMatch(r.json.answer.spoken, /9876543210|https?:|thinking/);
    assert.match(r.json.answer.spoken, /112/);
    assert.deepEqual(r.json.sources, [{ title: "b.example", url: "https://b.example/y" }]);
    const again = await s.handle({ query: "Petrol pump, kahan hai?", context: { lat: 20.204, lng: 85.1, riding: true } });
    assert.equal(again.json.cached, true);
    assert.equal((await s.handle({ query: "something new", context: {} })).status, 429);
    assert.equal(S.parseAnswer("no json"), null);
});

test("deep search falls back to local Ollama: Gemini over quota → Llama answers with Wikipedia grounding, same JSON, same persona rules", async () => {
    const { f, seen } = llmWorld({
        gemini: () => ({ status: 429, json: { error: { status: "RESOURCE_EXHAUSTED" } } }),
        chat: (body) => ({ json: { message: { role: "assistant", content: `<think>hmm</think>${ANSWER("Bhai, Deomali Odisha ki sabse oonchi choti hai, Koraput ke paas.")}` }, done: true } }),
        wiki: [{ key: "Deomali", title: "Deomali", description: "Mountain in Odisha", excerpt: 'Highest peak of <span class="searchmatch">Odisha</span>' }]
    });
    const engines = LLM.enginesFromEnv({ GEMINI_API_KEY: "GK" }, { fetchImpl: f, now: () => NOW });
    const s = S.createSearch({ engines, now: () => NOW });
    const r = await s.handle({ query: "Deomali kitna ooncha hai", context: { style: "desi", live: { weather: { tempC: 24, hazards: [{ type: "fog", distanceM: 800 }] }, nearby: [{ category: "food", name: "Sharma Dhaba", distanceM: 900, tier: "vetted" }] } } });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.engine, r.json.grounded, r.json.model], ["ollama", true, "llama3.2:3b"]);
    assert.equal(r.json.sources[0].url, "https://en.wikipedia.org/wiki/Deomali");
    const chat = seen.chat[0];
    assert.equal(chat.model, "llama3.2:3b");
    assert.equal(chat.stream, false);
    assert.deepEqual(chat.format.required, S.ANSWER_SCHEMA.required);       // held to the same JSON
    assert.equal(chat.keep_alive, "30m");
    assert.match(chat.messages[0].content, /Hinglish/);                       // the same persona rules
    assert.match(chat.messages[1].content, /Highest peak of Odisha/);
    assert.match(chat.messages[1].content, /Live data from the rider's phone:[\s\S]*fog at 800 m[\s\S]*Sharma Dhaba, 900 m away, well reviewed/);
    assert.doesNotMatch(r.json.answer.spoken, /think/);
    assert.equal(seen.gemini.length, 1);
    assert.equal(engines.stats().fallbacks, 1);
});

test("deep search: an unusable Gemini reply also falls back; a local model with nothing retrieved is honest and capped; nothing ready → clear failure", async () => {
    const w1 = llmWorld({ gemini: geminiOk("Sure! The pump is near."), chat: () => ({ json: { message: { content: ANSWER("Bhai, abhi live check nahi kar sakta.", { confidence: 0.95, time_sensitive: true }) } } }) });
    const s1 = S.createSearch({ engines: LLM.enginesFromEnv({ GEMINI_API_KEY: "GK", OLLAMA_RETRIEVAL: "none" }, { fetchImpl: w1.f, now: () => NOW }), now: () => NOW });
    const r1 = await s1.handle({ query: "aage traffic hai kya" });
    assert.deepEqual([r1.json.engine, r1.json.grounded], ["ollama", false]);
    assert.equal(r1.json.answer.confidence, 0.6);                             // unchecked knowledge never claims certainty
    assert.match(w1.seen.chat[0].messages[1].content, /NO live web access/);
    assert.equal(w1.seen.wiki, 0);
    // local only, Ollama up but the model was never pulled
    const w2 = llmWorld({ tags: ["mistral:latest"], chat: () => { throw new Error("must not be called"); } });
    const e2 = LLM.enginesFromEnv({ MASTER_LLM_ORDER: "ollama" }, { fetchImpl: w2.f, now: () => NOW });
    const r2 = await S.createSearch({ engines: e2, now: () => NOW }).handle({ query: "kuch bhi batao" });
    assert.equal(r2.status, 502);
    assert.deepEqual(r2.json.tried, [{ engine: "ollama", error: "NO_MODEL" }]);
    const h = await e2.health();
    assert.deepEqual([h.ready, h.ollama.up, h.ollama.hasModel], [false, true, false]);
    // Ollama not running at all, no Gemini key
    const w3 = llmWorld({ tags: null });
    const r3 = await S.createSearch({ engines: LLM.enginesFromEnv({}, { fetchImpl: w3.f, now: () => NOW }), now: () => NOW }).handle({ query: "kuch bhi batao" });
    assert.deepEqual(r3.json.tried.map((t) => t.error), ["not-configured", "UNREACHABLE"]);
    // only Ollama switched off and no key: nothing configured at all
    assert.equal((await S.createSearch({ engines: LLM.enginesFromEnv({ OLLAMA_DISABLED: "1" }) }).handle({ query: "hello" })).status, 503);
});

test("engines: Gemini's daily budget hands over to local; order 'ollama,gemini' keeps the cloud as the backup; think tags stripped", async () => {
    const { f, seen } = llmWorld({ gemini: geminiOk(ANSWER("Bhai, cloud.")), chat: () => ({ json: { message: { content: ANSWER("Bhai, local.") } } }) });
    const e = LLM.enginesFromEnv({ GEMINI_API_KEY: "GK", GEMINI_DAILY_MAX: "1", OLLAMA_RETRIEVAL: "none" }, { fetchImpl: f, now: () => NOW });
    const q = { system: "s", prompt: "p", accept: (t) => S.parseAnswer(t) !== null };
    assert.equal((await e.reason(q)).engine, "gemini");
    assert.equal((await e.reason(q)).engine, "ollama");                       // free quota margin used up
    assert.equal(seen.gemini.length, 1);
    const local = LLM.enginesFromEnv({ GEMINI_API_KEY: "GK", MASTER_LLM_ORDER: "ollama,gemini", OLLAMA_RETRIEVAL: "none" }, { fetchImpl: f, now: () => NOW });
    assert.equal((await local.reason(q)).engine, "ollama");
    assert.deepEqual(local.order, ["ollama", "gemini"]);
    assert.equal(LLM.stripThink("<think>a\nb</think> answer"), "answer");
});

// ---------------------------------------------------------------- destination safety, sun, music
test("destination safety: factors and levels; sun elevation", async () => {
    const good = SAFE.score({ light: "day", weather: { hazards: [] }, blackspots: 0, hospitalM: 3000, policeM: 1500, services: 20, etaS: 3600 });
    assert.deepEqual([good.score, good.level], [100, "good"]);
    const bad = SAFE.score({ light: "dark", weather: { hazards: [{ type: "heavy-rain", level: "warning" }] }, blackspots: 2, hospitalM: null, policeM: null, services: 1, etaS: 5 * 3600 });
    assert.equal(bad.level, "caution");
    assert.ok(bad.factors.some((x) => x.id === "dark") && bad.factors.some((x) => x.id === "weather-heavy-rain"));
    assert.ok(SUN.elevationDeg(28.6, 77.2, Date.UTC(2026, 5, 21, 6, 45)) > 75);          // Delhi, solstice noon (IST 12:15)
    assert.equal(SUN.light(28.6, 77.2, Date.UTC(2026, 5, 21, 19, 0)), "dark");            // 00:30 IST
    const safety = SAFE.createSafety({
        weather: { at: async () => ({ hazards: [] }) },
        blackspots: { nearPoint: () => [] },
        poi: { safetyAnchors: async () => { throw new Error("overpass down"); } },
        now: () => Date.UTC(2026, 5, 21, 5, 0)
    });
    const r = await safety.handle({ lat: 28.6, lng: 77.2, etaS: 1800 });
    assert.equal(r.json.partial, true);
    assert.equal(r.json.level, "good");                        // our outage doesn't make the place "unsafe"
});

test("music: mood from tags, from title words without a key; suggestions only with a key", async () => {
    assert.equal(MU.moodOf([{ name: "sad", count: 100 }, { name: "heartbreak", count: 40 }]).label, "sad");
    assert.equal(MU.moodOf([{ name: "bhangra", count: 100 }, { name: "party", count: 60 }]).label, "energetic");
    assert.equal(MU.moodOf([], "Hanuman Chalisa").label, "devotional");
    assert.equal(MU.moodOf([], "Untitled").label, "unknown");
    const r = await MU.createMusic({}).handle({ title: "Tum Hi Ho (Lofi Slowed)", artist: "Arijit Singh" });
    assert.equal(r.json.mood.label, "chill");
    assert.deepEqual(r.json.suggestions, []);
    const f = fakeFetch((url) => url.includes("gettoptags") ? { json: { toptags: { tag: [{ name: "romantic", count: 100 }] } } }
        : { json: { similartracks: { track: [{ name: "Agar Tum Saath Ho", artist: { name: "Alka Yagnik" } }] } } });
    const k = await MU.createMusic({ apiKey: "LF", fetchImpl: f }).handle({ title: "Tum Hi Ho", artist: "Arijit Singh" });
    assert.equal(k.json.mood.label, "romantic");
    assert.equal(k.json.suggestions[0].title, "Agar Tum Saath Ho");
});

test("api: upstream errors become precise statuses; bandwidth payload is bounded", () => {
    assert.equal(API.failure({ code: "CIRCUIT_OPEN" }).status, 503);
    assert.equal(API.failure({ code: "TIMEOUT" }).status, 504);
    assert.equal(API.failure(new Error("x")).status, 502);
    assert.equal(API.bandwidthPayload(10000).length, 512 * 1024);
    assert.equal(API.bandwidthPayload("abc").length, 64 * 1024);
    const req = { headers: { host: "app.example.com" } };
    assert.equal(API.isSameOrigin(req, "https://app.example.com"), true);
    assert.equal(API.isSameOrigin(req, "https://evil.example.com"), false);
    const svc = API.createMasterServices({ env: {}, blackspotsDir: "/nonexistent" });
    assert.equal(svc.traffic.configured(), false);
    assert.equal(svc.search.configured(), true);                 // the local Ollama engine needs no key
    assert.equal(API.createMasterServices({ env: { OLLAMA_DISABLED: "1" }, blackspotsDir: "/nonexistent" }).search.configured(), false);
});

test("router: every route is mounted with its own limit; CORS for the app, 403 for strangers, same-origin website allowed; errors mapped", async () => {
    const routes = [];
    const fakeExpress = {
        Router: () => {
            const mw = [];
            return {
                use: (fn) => mw.push(fn),
                post: (p, ...h) => routes.push({ m: "POST", p, h, mw }),
                get: (p, ...h) => routes.push({ m: "GET", p, h, mw })
            };
        },
        json: () => (_req, _res, next) => next()
    };
    const limits = [];
    const rateLimit = (o) => { limits.push(o.max); return (_req, _res, next) => next(); };
    const svc = API.createMasterServices({ env: { OLLAMA_DISABLED: "1" }, blackspotsDir: "/nonexistent" });
    svc.weather.handle = async () => { throw Object.assign(new Error("x"), { code: "CIRCUIT_OPEN" }); };
    const { router } = API.createMasterApi({ express: fakeExpress, rateLimit, services: svc, allowOrigin: (o) => o === "https://localhost", log: { warn() {} } });
    assert.ok(router);
    assert.deepEqual(routes.map((r) => `${r.m} ${r.p}`), ["POST /weather", "POST /traffic", "POST /road", "POST /blackspots", "POST /poi", "POST /search", "POST /destination", "POST /music", "GET /bw", "GET /status"]);
    assert.equal(limits.length, 10);
    const run = async (route, req) => {
        const res = { code: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, sendStatus(c) { this.code = c; return this; }, send(b) { this.body = b; return this; } };
        let i = 0;
        const chain = [...route.mw, ...route.h];
        const next = async () => { const fn = chain[i++]; if (fn) await fn(req, res, next); };
        await next();
        return res;
    };
    const weather = routes[0];
    const app = await run(weather, { method: "POST", headers: { origin: "https://localhost", host: "srv.example" }, body: {} });
    assert.equal(app.headers["Access-Control-Allow-Origin"], "https://localhost");
    assert.equal(app.code, 503);
    assert.equal(app.body.reason, "upstream-paused");
    const stranger = await run(weather, { method: "POST", headers: { origin: "https://evil.example", host: "srv.example" }, body: {} });
    assert.equal(stranger.code, 403);
    const site = await run(routes[2], { method: "POST", headers: { origin: "https://srv.example", host: "srv.example" }, body: { line: "bad" } });
    assert.equal(site.code, 400);
    const status = await run(routes[9], { method: "GET", headers: {}, query: {} });
    assert.equal(status.body.configured.traffic, false);
    assert.deepEqual([status.body.reasoning.order, status.body.reasoning.ready], [["gemini"], false]);
    const bw = await run(routes[8], { method: "GET", headers: {}, query: { kb: "8" } });
    assert.equal(bw.body.length, 8192);
});
