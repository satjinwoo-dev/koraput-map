// The free reasoning chain (lib/master/llm.js): Gemini without Search by default, Groq, local Ollama.
// No network: every engine and Wikipedia are scripted fakes; no real key appears here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const LLM = require("../../lib/master/llm.js");
const S = require("../../lib/master/search.js");

const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 13, 6, 0, 0);
const ANSWER = (spoken, extra = {}) => JSON.stringify({ spoken, title: "Answer", summary: "Summary.", bullets: [], confidence: 0.8, time_sensitive: false, ...extra });
const quiet = { warn() {} };

/**
 * A scripted world. Each engine is a function (body) → { status?, json }; omit one and calling it fails the test.
 * @param {{ gemini?: Function, groq?: Function, groqModels?: string[]|null, chat?: Function, tags?: string[]|null, wiki?: any[] }} w
 */
function world(w = {}) {
    const seen = { gemini: [], groq: [], groqModels: 0, chat: [], wiki: 0 };
    const reply = (r) => { const status = r.status ?? 200; return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => r.json }; };
    const fetchImpl = async (url, init = {}) => {
        url = String(url);
        if (url.includes("generativelanguage.googleapis.com")) { const body = JSON.parse(init.body); seen.gemini.push({ url, body, key: init.headers["x-goog-api-key"] }); return reply(w.gemini(body)); }
        if (url.endsWith("/openai/v1/models")) { seen.groqModels++; return w.groqModels === null ? reply({ status: 401, json: {} }) : reply({ json: { data: (w.groqModels || []).map((id) => ({ id })) } }); }
        if (url.endsWith("/openai/v1/chat/completions")) { const body = JSON.parse(init.body); seen.groq.push({ url, body, auth: init.headers.authorization }); return reply(w.groq(body)); }
        if (url.endsWith("/api/tags")) { if (w.tags === null) throw new TypeError("fetch failed"); return reply({ json: { models: (w.tags || ["llama3.2:3b"]).map((name) => ({ name })) } }); }
        if (url.endsWith("/api/chat")) { const body = JSON.parse(init.body); seen.chat.push(body); return reply(w.chat(body)); }
        if (url.includes("wikipedia.org")) { seen.wiki++; return reply({ json: { pages: w.wiki || [] } }); }
        throw new Error(`unexpected ${url}`);
    };
    return { fetchImpl, seen };
}
const geminiText = (text, grounded = false) => () => ({ json: { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP",
    ...(grounded ? { groundingMetadata: { groundingChunks: [{ web: { uri: "https://g.example/x", title: "g.example" } }] } } : {}) }] } });
const groqText = (text) => () => ({ json: { choices: [{ message: { role: "assistant", content: text } }] } });
const QUOTA = () => ({ status: 429, json: { error: { status: "RESOURCE_EXHAUSTED" } } });
const DEOMALI = [{ key: "Deomali", title: "Deomali", description: "Mountain in Odisha", excerpt: "Highest peak of Odisha" }];
const ask = (engines, query = "Deomali kitna ooncha hai") => S.createSearch({ engines, now: () => T0 }).handle({ query, context: { style: "desi" } });
const env = (extra) => ({ OLLAMA_DISABLED: "1", ...extra });

test("default chain is gemini → groq → ollama; MASTER_LLM_ORDER keeps known engines once, in its order", () => {
    assert.deepEqual(LLM.enginesFromEnv({}).order, ["gemini", "groq", "ollama"]);
    assert.deepEqual(LLM.enginesFromEnv({ MASTER_LLM_ORDER: " Groq, ollama , groq, gpt4, gemini" }).order, ["groq", "ollama", "gemini"]);
    assert.deepEqual(LLM.enginesFromEnv({ MASTER_LLM_ORDER: "groq", OLLAMA_DISABLED: "1" }).order, ["groq"]);
});

test("Gemini by default never asks for Google Search (the part that answers 429 without billing); it gets Wikipedia notes and is told it can't check live facts", async () => {
    const { fetchImpl, seen } = world({ gemini: geminiText(ANSWER("Bhai, Deomali 1672 m ooncha hai.")), wiki: DEOMALI });
    const engines = LLM.enginesFromEnv(env({ GEMINI_API_KEY: "GK" }), { fetchImpl, now: () => T0, log: quiet });
    const r = await ask(engines);
    assert.equal(r.status, 200);
    assert.equal(seen.gemini.length, 1);
    assert.equal(seen.gemini[0].body.tools, undefined, "no google_search tool");
    const prompt = seen.gemini[0].body.contents[0].parts[0].text;
    assert.match(prompt, /Reference notes \(Wikipedia[\s\S]*Highest peak of Odisha/);
    assert.match(prompt, /NO live web access beyond these notes/);
    assert.deepEqual([r.json.engine, r.json.grounded, r.json.live], ["gemini", true, false], "Wikipedia notes read, but nothing checked live");
    assert.deepEqual(r.json.sources, [{ title: "Deomali", url: "https://en.wikipedia.org/wiki/Deomali" }]);
    // nothing retrieved: honest, and capped like any unchecked answer
    const w2 = world({ gemini: geminiText(ANSWER("Bhai, live check nahi ho sakta.", { confidence: 0.9 })), wiki: [] });
    const r2 = await ask(LLM.enginesFromEnv(env({ GEMINI_API_KEY: "GK" }), { fetchImpl: w2.fetchImpl, now: () => T0, log: quiet }), "aage traffic hai kya");
    assert.match(w2.seen.gemini[0].body.contents[0].parts[0].text, /NO live web access for this question/);
    assert.deepEqual([r2.json.grounded, r2.json.answer.confidence], [false, 0.6]);
});

test("Gemini defaults to a list of models with low thinking; a model that rejects thinkingLevel (400) is asked once more without it; GEMINI_THINKING=model leaves it", async () => {
    const { fetchImpl, seen } = world({
        gemini: (body) => (body.generationConfig.thinkingConfig ? { status: 400, json: { error: { message: "Thinking level LOW is not supported for this model." } } } : geminiText(ANSWER("Bhai, ho gaya."))())
    });
    const r = await LLM.enginesFromEnv(env({ GEMINI_API_KEY: "GK", MASTER_RETRIEVAL: "none" }), { fetchImpl, now: () => T0, log: quiet }).reason({ system: "s", prompt: "p", accept: (x) => S.parseAnswer(x) !== null });
    assert.deepEqual([r.ok, r.engine, r.model], [true, "gemini", LLM.GEMINI_MODELS[0]]);
    assert.deepEqual(LLM.GEMINI_MODELS, ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-flash-lite-latest"]);
    assert.ok(seen.gemini[0].url.endsWith(`models/${LLM.GEMINI_MODELS[0]}:generateContent`));
    assert.deepEqual(seen.gemini.map((g) => g.body.generationConfig.thinkingConfig || null), [{ thinkingLevel: "low" }, null]);
    const w2 = world({ gemini: geminiText(ANSWER("x")) });
    await LLM.enginesFromEnv(env({ GEMINI_API_KEY: "GK", GEMINI_THINKING: "model", GEMINI_MODEL: "gemini-flash-latest", MASTER_RETRIEVAL: "none" }), { fetchImpl: w2.fetchImpl, now: () => T0, log: quiet }).reason({ system: "s", prompt: "p" });
    assert.equal(w2.seen.gemini[0].body.generationConfig.thinkingConfig, undefined);
    assert.match(w2.seen.gemini[0].url, /models\/gemini-flash-latest:generateContent$/);
});

test("GEMINI_GROUNDING=auto: a 429 on Search turns it off for the UTC day and the same question is asked again plainly; it comes back the next day", async () => {
    let t = T0;
    const { fetchImpl, seen } = world({
        gemini: (body) => (body.tools ? QUOTA() : geminiText(ANSWER("Bhai, plain answer."))()),
        wiki: DEOMALI
    });
    const engines = LLM.enginesFromEnv(env({ GEMINI_API_KEY: "GK", GEMINI_GROUNDING: "auto" }), { fetchImpl, now: () => t, log: quiet });
    const q = { system: "s", prompt: "p", wantWeb: true, webQuery: "Deomali", accept: (x) => S.parseAnswer(x) !== null };
    const r = await engines.reason(q);
    assert.equal(r.ok, true);
    assert.equal(r.engine, "gemini");
    assert.deepEqual(seen.gemini.map((g) => Boolean(g.body.tools)), [true, false], "grounded try, then plain");
    assert.match(seen.gemini[1].body.contents[0].parts[0].text, /Highest peak of Odisha/, "the plain retry gets the notes");
    assert.deepEqual(r.tried, [{ engine: "gemini", error: "GROUNDING_QUOTA" }]);
    assert.equal(r.grounded, true);
    // later the same day: straight to plain, no wasted Search call
    await engines.reason(q);
    assert.deepEqual(seen.gemini.slice(2).map((g) => Boolean(g.body.tools)), [false]);
    assert.equal(engines.stats().gemini.groundingToday, false);
    // next UTC day: Search is tried again
    t = T0 + DAY;
    await engines.reason(q);
    assert.equal(Boolean(seen.gemini[3].body.tools), true);
    // grounded answers keep Google's own sources
    const w2 = world({ gemini: geminiText(ANSWER("Bhai, grounded."), true) });
    const r2 = await LLM.enginesFromEnv(env({ GEMINI_API_KEY: "GK", GEMINI_GROUNDING: "auto" }), { fetchImpl: w2.fetchImpl, now: () => T0, log: quiet }).reason(q);
    assert.deepEqual([r2.grounded, r2.live, r2.sources], [true, true, [{ title: "g.example", url: "https://g.example/x" }]]);
    assert.equal(w2.seen.wiki, 0, "no Wikipedia when Google searched");
});

test("Groq takes over when Gemini is over quota: OpenAI-style request, bearer key, JSON mode, the same notes; Wikipedia fetched once for the whole chain", async () => {
    const { fetchImpl, seen } = world({ gemini: QUOTA, groq: groqText(`<think>plan</think>${ANSWER("Bhai, Deomali Odisha ki sabse oonchi choti hai.")}`), wiki: DEOMALI });
    const engines = LLM.enginesFromEnv(env({ GEMINI_API_KEY: "GK", GROQ_API_KEY: "QK" }), { fetchImpl, now: () => T0, log: quiet });
    const r = await ask(engines);
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.engine, r.json.model, r.json.grounded, r.json.live], ["groq", "llama-3.3-70b-versatile", true, false]);
    assert.doesNotMatch(r.json.answer.spoken, /plan|think/);
    const g = seen.groq[0];
    assert.equal(g.url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(g.auth, "Bearer QK");
    assert.equal(g.body.model, "llama-3.3-70b-versatile");
    assert.deepEqual(g.body.response_format, { type: "json_object" });
    assert.equal(g.body.messages[0].role, "system");
    assert.match(g.body.messages[0].content, /Hinglish/, "the same persona rules");
    assert.match(g.body.messages[1].content, /Highest peak of Odisha/);
    assert.equal(seen.wiki, 1, "one retrieval shared by gemini and groq");
    assert.deepEqual(engines.stats().served, { gemini: 0, groq: 1, ollama: 0 });
    assert.equal(engines.stats().fallbacks, 1);
});

test("Groq: a model without JSON mode (400) is asked once more plainly; GROQ_MODEL / GROQ_BASE_URL; its own daily budget hands over to Ollama", async () => {
    const { fetchImpl, seen } = world({
        groq: (body) => (body.response_format ? { status: 400, json: { error: { message: "json mode not supported" } } } : groqText(ANSWER("Bhai, ho gaya."))()),
        chat: () => ({ json: { message: { content: ANSWER("Bhai, local.") } } })
    });
    const e = LLM.enginesFromEnv({ GROQ_API_KEY: "QK", GROQ_MODEL: "some/other-model", GROQ_DAILY_MAX: "1", MASTER_LLM_ORDER: "groq,ollama", MASTER_RETRIEVAL: "none" }, { fetchImpl, now: () => T0, log: quiet });
    const q = { system: "s", prompt: "p", schema: S.ANSWER_SCHEMA, accept: (x) => S.parseAnswer(x) !== null };
    const r = await e.reason(q);
    assert.equal(r.engine, "groq");
    assert.deepEqual(seen.groq.map((x) => Boolean(x.body.response_format)), [true, false]);
    assert.equal(seen.groq[0].body.model, "some/other-model");
    assert.equal((await e.reason(q)).engine, "ollama", "Groq's daily margin used up");
    // any OpenAI-compatible server
    const w2 = world({ groq: groqText(ANSWER("x")) });
    const custom = LLM.createGroq({ apiKey: "K", baseUrl: "https://llm.example/openai/v1/", fetchImpl: w2.fetchImpl, now: () => T0 });
    await custom.generate({ system: "s", prompt: "p", timeoutMs: 5000 });
    assert.equal(w2.seen.groq[0].url, "https://llm.example/openai/v1/chat/completions");
});

test("health: Groq's model list says whether GROQ_MODEL is still served (cached); a bad key or retired model isn't 'ready'", async () => {
    const ok = world({ groqModels: ["llama-3.3-70b-versatile", "other"] });
    const e = LLM.enginesFromEnv({ GROQ_API_KEY: "QK", MASTER_LLM_ORDER: "groq" }, { fetchImpl: ok.fetchImpl, now: () => T0, log: quiet });
    const h = await e.health();
    assert.deepEqual([h.ready, h.groq.reachable, h.groq.hasModel, h.groq.model], [true, true, true, "llama-3.3-70b-versatile"]);
    await e.health();
    assert.equal(ok.seen.groqModels, 1, "cached");
    const retired = world({ groqModels: ["something-else"] });
    const h2 = await LLM.enginesFromEnv({ GROQ_API_KEY: "QK", MASTER_LLM_ORDER: "groq" }, { fetchImpl: retired.fetchImpl, now: () => T0, log: quiet }).health();
    assert.deepEqual([h2.ready, h2.groq.hasModel], [false, false]);
    const badKey = world({ groqModels: null });
    const h3 = await LLM.enginesFromEnv({ GROQ_API_KEY: "nope", MASTER_LLM_ORDER: "groq" }, { fetchImpl: badKey.fetchImpl, now: () => T0, log: quiet }).health();
    assert.deepEqual([h3.ready, h3.groq.reachable, h3.groq.error], [false, false, "HTTP_ERROR"]);
    const none = await LLM.enginesFromEnv({ MASTER_LLM_ORDER: "groq" }).health();
    assert.deepEqual([none.ready, none.groq.configured], [false, false]);
});

test("the whole chain down: Gemini 429, Groq 429, Ollama not running → one clear failure listing each", async () => {
    const { fetchImpl } = world({ gemini: QUOTA, groq: () => ({ status: 429, json: {} }), tags: null });
    const r = await ask(LLM.enginesFromEnv({ GEMINI_API_KEY: "GK", GROQ_API_KEY: "QK", MASTER_RETRIEVAL: "none" }, { fetchImpl, now: () => T0, log: quiet }));
    assert.equal(r.status, 502);
    assert.deepEqual(r.json.tried, [{ engine: "gemini", error: "RATE_LIMITED" }, { engine: "groq", error: "RATE_LIMITED" }, { engine: "ollama", error: "UNREACHABLE" }]);
});

test("offlineNotes: notes when there are some, the honest 'can't check live' line either way", () => {
    assert.match(LLM.offlineNotes([{ title: "A", text: "a" }]), /\[1\] A: a[\s\S]*NO live web access beyond these notes/);
    assert.match(LLM.offlineNotes([]), /NO live web access for this question[\s\S]*confidence ≤ 0\.4/);
});

test("chat from the mic ('hello', 'hi'): answered without a web lookup, a short budget, the small-talk rule in the prompt", async () => {
    const { fetchImpl, seen } = world({ gemini: geminiText(ANSWER("Namaste bhai! Bol, kya help karun?", { title: "Chat", confidence: 1 })), wiki: DEOMALI });
    const s = S.createSearch({ engines: LLM.enginesFromEnv(env({ GEMINI_API_KEY: "GK" }), { fetchImpl, now: () => T0, log: quiet }), now: () => T0 });
    const r = await s.handle({ query: "hello", chat: true, context: { style: "desi", lat: 18.81, lng: 82.71 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.answer.spoken, "Namaste bhai! Bol, kya help karun?");
    assert.equal(seen.wiki, 0, "no Wikipedia for a greeting");
    assert.equal(seen.gemini[0].body.generationConfig.maxOutputTokens, 400);
    assert.match(seen.gemini[0].body.systemInstruction.parts[0].text, /just chatting[\s\S]*warm riding buddy/);
    // two characters are enough now ("hi"); one still isn't
    assert.equal((await s.handle({ query: "hi", chat: true, context: {} })).status, 200);
    assert.equal((await s.handle({ query: "h", chat: true, context: {} })).status, 400);
    // the same words as a real question still get the lookup
    await s.handle({ query: "hello song kisne gaya", context: { style: "desi" } });
    assert.equal(seen.wiki, 1);
});

test("the Master's persona: a desi riding buddy and babysitter, colloquial Hinglish, intercom-short, still honest and safe", () => {
    const p = S.SYSTEM;
    // persona
    assert.match(p, /desi riding companion/);
    assert.match(p, /babysitter/);
    // language: colloquial Hinglish in Roman script, never robotic English or bookish Hindi
    assert.match(p, /colloquial Hinglish in Roman script/);
    assert.match(p, /NEVER robotic or formal English/);
    // SI only: a live answer once said "1,672 meters yaani 5,486 feet"
    assert.match(p, /metres, kilometres and °C only; never feet, miles, °F or mph/);
    assert.match(p, /NEVER pure or bookish Hindi[\s\S]*never Devanagari/);
    assert.match(p, /2 kilometer aage ek badhiya mechanic hai, wahan chalte hain/);
    // brevity
    assert.match(p, /intercom/);
    assert.match(p, /under 30 words[\s\S]*riding, under 20 words/);
    // what must never be lost: honesty, rider safety, English on screen, the JSON contract
    assert.match(p, /Never invent places, distances, phone numbers, prices or URLs/);
    assert.match(p, /Never tell the rider to look at, tap or use the phone while moving/);
    assert.match(p, /mention calling 112/);
    assert.match(p, /No URLs and no long digit strings/);
    assert.match(p, /"title", "summary" and "bullets" [\s\S]*clear English/);
    assert.match(p, /Style "plain"/);
    assert.match(p, /Return ONLY one JSON object/);
    for (const k of S.ANSWER_SCHEMA.required) assert.ok(p.includes(`"${k}"`), k);
});

test("actions: the model proposes one, the server keeps only a known action with valid arguments, and never caches it", async () => {
    const A = S.sanitizeAction;
    assert.deepEqual(A({ name: "navigate_to", place: "  Araku   Valley " }), { name: "navigate_to", place: "Araku Valley" });
    assert.deepEqual(A({ name: "SEND_SOS", extra: "ignored" }), { name: "send_sos" });
    assert.deepEqual(A({ name: "find_nearby", category: "Mechanic" }), { name: "find_nearby", category: "mechanic" });
    assert.deepEqual(A({ name: "quiet_ride", on: true }), { name: "quiet_ride", on: true });
    for (const bad of [null, "send_sos", { name: "format_disk" }, { name: "navigate_to" }, { name: "navigate_to", place: "x".repeat(81) }, { name: "navigate_to", place: "<script>" },
        { name: "find_nearby", category: "casino" }, { name: "quiet_ride", on: "true" }, { name: "music", control: "louder" }]) assert.equal(A(bad), null, JSON.stringify(bad));
    assert.ok(S.SYSTEM.includes('"name":"send_sos"') && S.SYSTEM.includes("confirm SOS"));
    assert.deepEqual(Object.keys(S.ACTIONS).sort(), ["find_nearby", "how_far", "music", "navigate_to", "quiet_ride", "send_sos", "share_location", "squad_status", "start_navigation", "stop_navigation", "where_am_i"]);
    // through the whole pipeline
    let reply = ANSWER("Chal bhai, Araku ka rasta nikalta hoon.", { action: { name: "navigate_to", place: "Araku Valley" } });
    const { fetchImpl, seen } = world({ gemini: () => geminiText(reply)() });
    const s = S.createSearch({ engines: LLM.enginesFromEnv(env({ GEMINI_API_KEY: "GK", MASTER_RETRIEVAL: "none" }), { fetchImpl, now: () => T0, log: quiet }), now: () => T0 });
    const r = await s.handle({ query: "Araku le chal", chat: true, context: { style: "desi" } });
    assert.deepEqual(r.json.action, { name: "navigate_to", place: "Araku Valley" });
    await s.handle({ query: "Araku le chal", chat: true, context: { style: "desi" } });
    assert.equal(seen.gemini.length, 2, "an action is never replayed from the cache");
    // an answer that does nothing, or proposes nonsense, carries action: null
    reply = ANSWER("Haan bhai, 3 ghante.", { action: null });
    assert.equal((await s.handle({ query: "Araku kitna door hai", context: {} })).json.action, null);
    reply = ANSWER("ok", { action: { name: "rm_rf" } });
    assert.equal((await s.handle({ query: "kuch bhi kar", context: {} })).json.action, null);
});

// ================================================================ Gemini overloaded (13 Oct 2026: 503 "high demand" and hangs on the free tier)
const modelOf = (url) => /models\/([^:]+):generateContent/.exec(url)[1];

test("Gemini tries the next model when one is overloaded (503) or retired (404, then skipped for a day); a blocked answer isn't retried elsewhere", async () => {
    const { fetchImpl, seen } = world({ gemini: (body) => body.__m === "gemini-3.5-flash" ? { status: 503, json: { error: { status: "UNAVAILABLE" } } } : geminiText(ANSWER("Haan bhai, bol!"))() });
    // the fake needs the model: tag each body with it from the URL
    const tagging = async (url, init = {}) => { if (String(url).includes("generativelanguage")) { const b = JSON.parse(init.body); b.__m = modelOf(String(url)); init = { ...init, body: JSON.stringify(b) }; } return fetchImpl(url, init); };
    const engines = LLM.enginesFromEnv(env({ GEMINI_API_KEY: "GK", MASTER_RETRIEVAL: "none" }), { fetchImpl: tagging, now: () => T0, log: quiet });
    const r = await engines.reason({ system: "s", prompt: "Hello", deadlineMs: 20000, accept: (x) => S.parseAnswer(x) !== null });
    assert.deepEqual([r.ok, r.engine, r.model], [true, "gemini", "gemini-3.6-flash"]);
    assert.deepEqual(seen.gemini.map((g) => modelOf(g.url)), ["gemini-3.5-flash", "gemini-3.6-flash"]);
    // a model Google has retired (404) is skipped for the rest of the day
    let t = T0;
    const w = world({ gemini: (body) => body.__m === "gemini-old" ? { status: 404, json: { error: { message: "no longer available to new users" } } } : geminiText(ANSWER("ok"))() });
    const tag2 = async (url, init = {}) => { if (String(url).includes("generativelanguage")) { const b = JSON.parse(init.body); b.__m = modelOf(String(url)); init = { ...init, body: JSON.stringify(b) }; } return w.fetchImpl(url, init); };
    const g = LLM.createGemini({ apiKey: "GK", model: "gemini-old, gemini-new", fetchImpl: tag2, now: () => t });
    assert.equal((await g.generate({ system: "s", prompt: "p", timeoutMs: 20000 })).model, "gemini-new");
    await g.generate({ system: "s", prompt: "p", timeoutMs: 20000 });
    assert.deepEqual(w.seen.gemini.map((x) => modelOf(x.url)), ["gemini-old", "gemini-new", "gemini-new"]);
    t += DAY + 1;
    await g.generate({ system: "s", prompt: "p", timeoutMs: 20000 });
    assert.equal(modelOf(w.seen.gemini.at(-2).url), "gemini-old", "asked again the next day");
    // blocked content: another model would block it too
    const b = world({ gemini: () => ({ json: { candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] } }) });
    const gb = LLM.createGemini({ apiKey: "GK", model: "a,b", fetchImpl: b.fetchImpl, now: () => T0 });
    await assert.rejects(gb.generate({ system: "s", prompt: "p", timeoutMs: 20000 }), (e) => e.code === "BLOCKED");
    assert.equal(b.seen.gemini.length, 1);
});

test("a model that hangs is cut off at its share of the time and the next model answers; each model has its own circuit breaker", async (t) => {
    // AbortSignal.timeout's timer doesn't hold the event loop open (the server's listener does): hold it here
    const hold = setInterval(() => {}, 1000);
    t.after(() => clearInterval(hold));
    const calls = [];
    const fetchImpl = (url, init) => {
        const m = modelOf(String(url)); calls.push(m);
        if (m === "hangs") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ candidates: [{ content: { parts: [{ text: ANSWER("Namaste bhai!") }] }, finishReason: "STOP" }] }) });
    };
    const g = LLM.createGemini({ apiKey: "GK", model: "hangs,works", modelTimeoutMs: 300, fetchImpl });
    const t0 = Date.now();
    const r = await g.generate({ system: "s", prompt: "Hello", timeoutMs: 8000 });
    const ms = Date.now() - t0;
    assert.equal(r.model, "works");
    assert.deepEqual(r.modelFallbacks, ["hangs: TIMEOUT"]);
    assert.ok(ms >= 1400 && ms < 4000, `cut off at the 1.5 s floor, not the 8 s budget (${ms} ms)`);
    // four timeouts pause "hangs" only; "works" keeps answering, straight away
    for (let i = 0; i < 3; i++) await g.generate({ system: "s", prompt: "Hello", timeoutMs: 8000 });
    const before = calls.length;
    const t1 = Date.now();
    assert.equal((await g.generate({ system: "s", prompt: "Hello", timeoutMs: 8000 })).model, "works");
    assert.deepEqual(calls.slice(before), ["works"], "the paused model isn't even asked");
    assert.ok(Date.now() - t1 < 500);
    assert.equal(g.available(), true);
    assert.deepEqual(g.stats().upstreams.map((u) => [u.name, u.open]), [["gemini:hangs", true], ["gemini:works", false]]);
});

test("the chain doesn't hold time back for an engine known to be down: with Ollama not running and no Groq key, Gemini gets the whole deadline", async () => {
    const got = [];
    const gemini = { name: "gemini", configured: () => true, available: () => true, liveWeb: () => false, stats: () => ({}),
        async generate(q) { got.push(q.timeoutMs); return { text: ANSWER("Haan bhai"), sources: [], grounded: false, model: "x" }; } };
    const groq = LLM.createGroq({ apiKey: "" });
    const { fetchImpl } = world({ tags: null });
    const ollama = LLM.createOllama({ fetchImpl });
    const engines = LLM.createEngines({ order: ["gemini", "groq", "ollama"], gemini, groq, ollama, log: quiet });
    await engines.reason({ system: "s", prompt: "p", deadlineMs: 20000 });
    assert.ok(got[0] <= 8000, `before Ollama has been checked it may still be there: ${got[0]} ms`);
    await ollama.check();                                            // what the server does at start-up
    await engines.reason({ system: "s", prompt: "p", deadlineMs: 20000 });
    assert.ok(got[1] > 19000, `known down: Gemini gets the whole 20 s (${got[1]} ms)`);
});
