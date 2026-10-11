// Voice engine: Hinglish preparation, route choice (cloud / native / web), latency budgets,
// cancellation, the cloud circuit breaker, the server's /api/tts (Google / ElevenLabs), and
// VoiceAssistant (voice.js) running on the engine with a fake MapUniteVoice plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const H = require("../../public/js/voice/hinglish.js");
const E = require("../../public/js/voice/engine.js");
const P = require("../../public/js/master/phrases-desi.js");
const ASK = require("../../public/js/advice/ask.js");
const { createTts } = require("../../lib/tts.js");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const MP3 = () => new Uint8Array(400).fill(7).buffer;

// ------------------------------------------------------------------ Hinglish

test("hinglish: desi lines become Devanagari for a Hindi voice, English stays en-IN", () => {
    const a = H.prepare("Bhai, 800 metre aage gaddha hai. Dheere kar.");
    assert.equal(a.lang, "hi-IN");
    assert.equal(a.text, "भाई, 800 मीटर आगे गड्ढा है. धीरे कर.");
    const b = H.prepare("Speed breaker in 200 metres.");
    assert.equal(b.lang, "en-IN");
    assert.equal(b.text, "Speed breaker in 200 metres.");
    // relaxed lines breathe between sentences (Chirp 3 HD markup); warnings don't
    assert.match(H.prepare("Bhai, ek baat bolun? Break le le.", { relaxed: true }).markup, /\[pause short\]/);
    assert.doesNotMatch(H.prepare("Bhai, ek baat bolun? Break le le.").markup, /\[pause/);
});

/** Every phrase the Master can say in desi style, with template slots filled the way the persona fills them. */
function desiLines() {
    const out = [];
    for (const kind of Object.values(P.desi)) for (const level of Object.values(kind)) for (const p of level) {
        out.push(p.say.replace(/\{\{name\}\}/g, "Rahul").replace(/\{\{[^}]+\}\}/g, "800 metre"));
    }
    return out;
}

test("hinglish: every Hinglish word of the desi phrase pack and the ask-first questions is in the lexicon", () => {
    const unknown = new Set();
    let hinglish = 0;
    for (const line of [...desiLines(), ...ASK.allPrompts("desi")]) {
        const r = H.prepare(line);
        if (r.lang !== "hi-IN") continue;
        hinglish++;
        for (const w of r.unknown) if (w !== "Rahul") unknown.add(w);
    }
    assert.ok(hinglish > 40, `expected most desi lines to be Hinglish, got ${hinglish}`);
    assert.deepEqual([...unknown], [], `words with no Devanagari spelling: ${[...unknown].join(", ")}`);
});

test("hinglish: the ask-first questions all go to the Hindi voice", () => {
    for (const q of ASK.allPrompts("desi")) assert.equal(H.prepare(q).lang, "hi-IN", q);
    for (const q of ASK.allPrompts("plain")) assert.equal(H.prepare(q).lang, "en-IN", q);
    assert.ok(ASK.allPrompts("desi").includes("Bhai, ek baat bolun?"));
});

// ------------------------------------------------------------------ engine

/** A fake world for the engine: server, native plugin, cache, clock. */
function world(o = {}) {
    const calls = { fetch: [], speak: [], play: [], stop: 0 };
    let serverDelay = o.serverDelay ?? 10;
    let serverStatus = o.serverStatus ?? 200;
    const fetch = async (url) => {
        calls.fetch.push(url);
        await tick(serverDelay);
        if (serverStatus === "throw") throw new Error("offline");
        return { ok: serverStatus === 200, status: serverStatus, headers: { get: () => "audio/mpeg" }, arrayBuffer: async () => MP3() };
    };
    const pending = [];
    const native = {
        speak: (a) => { calls.speak.push(a); return new Promise((r) => pending.push(r)); },
        playAudio: (a) => { calls.play.push(a); return new Promise((r) => pending.push(r)); },
        stop: () => { calls.stop++; while (pending.length) pending.shift()({ result: "cancelled" }); }
    };
    const finishNative = (result = "ended") => { const r = pending.shift(); if (r) r({ result }); };
    const engine = E.createVoiceEngine({
        hinglish: H, serverOrigin: "https://mu.example", fetch, native: o.noNative ? null : native,
        web: o.web || null, caches: null, budgets: o.budgets, now: o.now
    });
    return { engine, calls, finishNative, setServer: (s, d) => { serverStatus = s; if (d != null) serverDelay = d; } };
}

test("engine: a tip waits for the premium voice and plays it natively; the line is cached for next time", async () => {
    const w = world();
    const h = w.engine.speak("Bhai, thoda break le le.", { priority: 40 });
    await tick(40);
    assert.equal(h.route, "cloud");
    assert.equal(w.calls.play.length, 1);
    assert.match(w.calls.fetch[0], /^https:\/\/mu\.example\/api\/tts\?lang=hi-IN&rate=1\.00&m=1&q=/);
    assert.ok(decodeURIComponent(w.calls.fetch[0]).includes("भाई"), "the server gets the Devanagari text");
    w.finishNative("ended");
    assert.equal(await h.done, "ended");
    // same line again: from memory, no new download
    const h2 = w.engine.speak("Bhai, thoda break le le.", { priority: 40 });
    await tick(5);
    assert.equal(h2.route, "cloud");
    assert.equal(w.calls.fetch.length, 1);
    w.finishNative();
    assert.equal(await h2.done, "ended");
});

test("engine: an urgent line never waits for the network: device voice now, premium download for next time", async () => {
    const w = world({ serverDelay: 300 });
    const h = w.engine.speak("Bhai, aage gaddha hai, dheere kar.", { priority: 90 });
    await tick(5);
    assert.equal(h.route, "native");
    assert.equal(w.calls.speak.length, 1);
    assert.equal(w.calls.speak[0].lang, "hi-IN");
    assert.ok(w.calls.speak[0].rate >= 1.05, "urgent lines are a touch quicker");
    assert.equal(w.calls.fetch.length, 1, "downloaded in the background");
    w.finishNative();
    assert.equal(await h.done, "ended");
    await tick(320);
    const h2 = w.engine.speak("Bhai, aage gaddha hai, dheere kar.", { priority: 90 });
    await tick(5);
    assert.equal(h2.route, "cloud", "cached now, so even urgent lines get the premium voice");
    w.finishNative();
    await h2.done;
});

test("engine: a warning gives the cloud 700 ms, then speaks on the device", async () => {
    const w = world({ serverDelay: 2000, budgets: { warningMs: 50 } });
    const h = w.engine.speak("Network gaya Rahul! Ghabra mat.", { priority: 70 });
    await tick(20);
    assert.equal(h.route, "pending");
    await tick(60);
    assert.equal(h.route, "native");
    w.finishNative();
    assert.equal(await h.done, "ended");
    assert.equal(w.engine.status().counts.cloudMisses, 1);
});

test("engine: a new line cancels the old one, which reports cancelled exactly once", async () => {
    const w = world();
    const a = w.engine.speak("Bhai, aage gaddha hai.", { priority: 90 });
    await tick(5);
    const b = w.engine.speak("Bhai, left le.", { priority: 95 });
    assert.equal(await a.done, "cancelled");
    assert.ok(w.calls.stop >= 1);
    await tick(5);
    assert.equal(b.route, "native");
    w.finishNative();
    assert.equal(await b.done, "ended");
    assert.equal(w.engine.speaking, false);
});

test("engine: premium audio that fails to play is said again by the device voice", async () => {
    const w = world();
    const h = w.engine.speak("Bhai, ek baat bolun?", { priority: 40 });
    await tick(40);
    assert.equal(h.route, "cloud");
    w.finishNative("failed");
    await tick(5);
    assert.equal(h.route, "native");
    assert.equal(w.calls.speak.length, 1);
    w.finishNative("ended");
    assert.equal(await h.done, "ended");
});

test("engine: three cloud failures pause the cloud for 2 minutes; a 503 turns it off for the session", async () => {
    let t = 1_000_000;
    const w = world({ serverStatus: 500, now: () => t });
    for (let i = 0; i < 3; i++) {
        const h = w.engine.speak(`Bhai, tip number ${i} hai.`, { priority: 40 });
        await tick(30); w.finishNative(); await h.done;
    }
    assert.equal(w.engine.status().cloudPaused, true);
    const n = w.calls.fetch.length;
    const h = w.engine.speak("Bhai, chai pi le.", { priority: 40 });
    await tick(5);
    assert.equal(h.route, "native");
    assert.equal(w.calls.fetch.length, n, "no request while paused");
    w.finishNative(); await h.done;
    t += 121_000;
    assert.equal(w.engine.status().cloudPaused, false);

    const w2 = world({ serverStatus: 503 });
    const h2 = w2.engine.speak("Bhai, chai pi le.", { priority: 40 });
    await tick(30); w2.finishNative(); await h2.done;
    assert.equal(w2.engine.status().cloud, false);
});

test("engine: no server origin → device voice only; the website uses speechSynthesis with the best Hindi voice", async () => {
    const spoken = [];
    class Utt { constructor(t) { this.text = t; } }
    const synth = {
        getVoices: () => [{ name: "English US", lang: "en-US", localService: true }, { name: "Google हिन्दी", lang: "hi-IN", localService: false }],
        speak: (u) => { spoken.push(u); setTimeout(() => u.onend(), 5); },
        cancel: () => {}
    };
    const engine = E.createVoiceEngine({ hinglish: H, serverOrigin: null, web: { synth, Utterance: Utt } });
    const h = engine.speak("Bhai, thoda break le le.", { priority: 40 });
    assert.equal(await h.done, "ended");
    assert.equal(h.route, "web");
    assert.equal(spoken[0].voice.name, "Google हिन्दी");
    assert.equal(spoken[0].lang, "hi-IN");
    assert.equal(engine.status().cloud, false);
});

test("engine: prefetch warms the cache so the ask-first question plays instantly", async () => {
    const w = world();
    assert.equal(w.engine.prefetch(ASK.allPrompts("desi"), { priority: 50 }), ASK.allPrompts("desi").length);
    await tick(30);
    const h = w.engine.speak("Bhai, ek baat bolun?", { priority: 50 });
    await tick(2);
    assert.equal(h.route, "cloud");
    w.finishNative(); await h.done;
});

test("engine.forWindow: uses the MapUniteVoice plugin in the app and tries the server even if the baked config predates it", () => {
    const W = {
        MUVoice: { hinglish: H }, MU_SERVER_ORIGIN: "https://mu.example", MU_CONFIG: {},
        Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n) => n === "MapUniteVoice", registerPlugin: (n) => ({ name: n, speak() {}, stop() {} }) },
        navigator: { onLine: true }
    };
    const eng = E.forWindow(W);
    assert.equal(eng.status().native, true);
    assert.equal(eng.status().cloud, true);
    const web = E.forWindow({ MUVoice: { hinglish: H }, MU_CONFIG: { premiumVoice: false } });
    assert.equal(web.status().native, false);
    assert.equal(web.status().cloud, false);
    assert.equal(E.forWindow({}), null, "no hinglish script → no engine (voice.js falls back to speechSynthesis)");
});

// ------------------------------------------------------------------ server /api/tts

function fakeUpstream(kind) {
    const reqs = [];
    const fetch = async (url, init) => {
        reqs.push({ url, init, body: JSON.parse(init.body) });
        await tick(5);
        if (kind === "google") return { ok: true, status: 200, json: async () => ({ audioContent: Buffer.alloc(500, 1).toString("base64") }), text: async () => "" };
        return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(500).fill(2).buffer, text: async () => "" };
    };
    return { reqs, fetch };
}

test("tts: Google Chirp 3 HD request shape, the same speaker for Hindi and English", async () => {
    const up = fakeUpstream("google");
    const tts = createTts({ env: { TTS_PROVIDER: "google", GOOGLE_TTS_API_KEY: "k1", GOOGLE_TTS_VOICE: "Charon" }, fetch: up.fetch, cacheDir: null });
    assert.equal(tts.configured, true);
    const r = await tts.synthesize({ q: "भाई, आगे गड्ढा है.", lang: "hi-IN", rate: "1.05" });
    assert.equal(r.status, 200);
    assert.equal(r.audio.length, 500);
    const q = up.reqs[0];
    assert.equal(q.url, "https://texttospeech.googleapis.com/v1/text:synthesize?key=k1");
    assert.deepEqual(q.body.voice, { languageCode: "hi-IN", name: "hi-IN-Chirp3-HD-Charon" });
    assert.deepEqual(q.body.audioConfig, { audioEncoding: "MP3", speakingRate: 1.05 });
    assert.deepEqual(q.body.input, { text: "भाई, आगे गड्ढा है." });
    await tts.synthesize({ q: "Turn left.", lang: "en-IN" });
    assert.equal(up.reqs[1].body.voice.name, "en-IN-Chirp3-HD-Charon");
});

test("tts: markup pauses go to Google only when enabled; other providers get plain text", async () => {
    const up = fakeUpstream("google");
    const tts = createTts({ env: { TTS_PROVIDER: "google", GOOGLE_TTS_API_KEY: "k", GOOGLE_TTS_MARKUP: "1" }, fetch: up.fetch, cacheDir: null });
    await tts.synthesize({ q: "भाई, एक बात बोलूँ? [pause short] Break ले ले.", lang: "hi-IN", m: "1" });
    assert.deepEqual(up.reqs[0].body.input, { markup: "भाई, एक बात बोलूँ? [pause short] Break ले ले." });
    const up2 = fakeUpstream("google");
    const plain = createTts({ env: { TTS_PROVIDER: "google", GOOGLE_TTS_API_KEY: "k" }, fetch: up2.fetch, cacheDir: null });
    await plain.synthesize({ q: "भाई, एक बात बोलूँ? [pause short] Break ले ले.", lang: "hi-IN", m: "1" });
    assert.deepEqual(up2.reqs[0].body.input, { text: "भाई, एक बात बोलूँ? Break ले ले." });
});

test("tts: ElevenLabs request shape", async () => {
    const up = fakeUpstream("elevenlabs");
    const tts = createTts({ env: { TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "xi", ELEVENLABS_VOICE_ID: "abc123" }, fetch: up.fetch, cacheDir: null });
    const r = await tts.synthesize({ q: "भाई, break ले ले.", lang: "hi-IN" });
    assert.equal(r.status, 200);
    const q = up.reqs[0];
    assert.equal(q.url, "https://api.elevenlabs.io/v1/text-to-speech/abc123?output_format=mp3_44100_64");
    assert.equal(q.init.headers["xi-api-key"], "xi");
    assert.equal(q.body.model_id, "eleven_multilingual_v2");
    assert.equal(q.body.text, "भाई, break ले ले.");
});

test("tts: identical requests share one upstream call; memory and disk caches; validation; not configured", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-tts-"));
    const up = fakeUpstream("google");
    const tts = createTts({ env: { TTS_PROVIDER: "google", GOOGLE_TTS_API_KEY: "k" }, fetch: up.fetch, cacheDir: dir });
    const [a, b] = await Promise.all([tts.synthesize({ q: "Turn left.", lang: "en-IN" }), tts.synthesize({ q: "Turn  left. ", lang: "en-IN" })]);
    assert.equal(up.reqs.length, 1, "in-flight dedupe (whitespace normalised)");
    assert.equal(a.key, b.key);
    assert.equal((await tts.synthesize({ q: "Turn left.", lang: "en-IN" })).source, "memory");
    await tick(30);
    assert.ok(fs.existsSync(path.join(dir, `${a.key}.mp3`)), "written to disk");
    const fresh = createTts({ env: { TTS_PROVIDER: "google", GOOGLE_TTS_API_KEY: "k" }, fetch: up.fetch, cacheDir: dir });
    assert.equal((await fresh.synthesize({ q: "Turn left.", lang: "en-IN" })).source, "disk");
    assert.equal(up.reqs.length, 1);

    assert.equal((await tts.synthesize({ q: "", lang: "en-IN" })).status, 400);
    assert.equal((await tts.synthesize({ q: "x".repeat(401), lang: "en-IN" })).status, 400);
    assert.equal((await tts.synthesize({ q: "hi", lang: "fr-FR" })).status, 400);
    assert.equal((await tts.synthesize({ q: "hi", lang: "en-IN", rate: "3" })).status, 400);
    const none = createTts({ env: {}, cacheDir: null });
    assert.equal(none.configured, false);
    assert.deepEqual(await none.synthesize({ q: "hi" }), { status: 503, error: "not-configured" });
    fs.rmSync(dir, { recursive: true, force: true });
});

test("tts: upstream failure → 502, and the Express handler sets audio, cache and CORS headers", async () => {
    const bad = createTts({ env: { TTS_PROVIDER: "google", GOOGLE_TTS_API_KEY: "k" }, fetch: async () => ({ ok: false, status: 403, text: async () => "denied" }), cacheDir: null });
    assert.equal((await bad.synthesize({ q: "hi", lang: "en-IN" })).status, 502);

    const up = fakeUpstream("google");
    const tts = createTts({ env: { TTS_PROVIDER: "google", GOOGLE_TTS_API_KEY: "k" }, fetch: up.fetch, cacheDir: null });
    const h = tts.handler({ allowOrigin: (o) => o === "https://localhost" });
    const res = () => {
        const r = { headers: {}, code: 200, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end(b) { this.body = b ?? null; return this; } };
        return r;
    };
    const r1 = res();
    await h({ headers: { origin: "https://localhost" }, query: { q: "Turn left.", lang: "en-IN" } }, r1);
    assert.equal(r1.code, 200);
    assert.equal(r1.headers["content-type"], "audio/mpeg");
    assert.equal(r1.headers["access-control-allow-origin"], "https://localhost");
    assert.match(r1.headers["cache-control"], /immutable/);
    const r2 = res();
    await h({ headers: { origin: "https://evil.example", "if-none-match": r1.headers.etag }, query: { q: "Turn left.", lang: "en-IN" } }, r2);
    assert.equal(r2.code, 304);
    assert.equal(r2.headers["access-control-allow-origin"], undefined);
    const r3 = res();
    await h({ headers: {}, query: { q: "", lang: "en-IN" } }, r3);
    assert.equal(r3.code, 400);
});

// ------------------------------------------------------------------ voice.js on the engine (app, MapUniteVoice plugin)
const src = (rel) => fs.readFileSync(fileURLToPath(new URL(`../../public/js/${rel}`, import.meta.url)), "utf8");

function loadApp() {
    const said = [], stops = [];
    let pending = null;
    const plugin = {
        speak: (a) => { said.push(a); return new Promise((r) => { pending = r; setTimeout(() => { if (pending === r) { pending = null; r({ result: "ended" }); } }, 15); }); },
        playAudio: async () => ({ result: "failed" }),
        stop: () => { stops.push(Date.now()); if (pending) { const r = pending; pending = null; r({ result: "cancelled" }); } }
    };
    let reply = { type: "silence" };
    class Recognition {
        start() { setTimeout(() => { if (this.aborted) return; this.onstart && this.onstart({}); if (reply.type === "say") setTimeout(() => { if (this.aborted) return; this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: reply.text, confidence: 0.9 }], { isFinal: true })] }); this.onend && this.onend({}); }, 20); }, 5); }
        abort() { this.aborted = true; } stop() { this.aborted = true; }
    }
    const doc = { visibilityState: "visible", readyState: "complete", addEventListener() {}, removeEventListener() {}, getElementById: () => null, dispatchEvent() {} };
    const sandbox = {
        console, Math, Date, JSON, Promise, Object, Array, String, Number, Boolean, Map, Set, Error, RegExp, Symbol, Infinity, NaN, Uint8Array, encodeURIComponent, decodeURIComponent,
        setTimeout, clearTimeout, setInterval, clearInterval,
        document: doc, navigator: { language: "en-IN", onLine: false }, localStorage: { getItem: () => null, setItem() {} },
        SpeechRecognition: Recognition, MU_CONFIG: {},
        Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n) => n === "MapUniteVoice", registerPlugin: () => plugin },
        CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } },
        islandShow() {}, islandHide() {}, showToast() {}
    };
    sandbox.window = sandbox; sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    for (const f of ["voice/hinglish.js", "voice/engine.js", "advice/gate.js", "advice/ask.js", "voice.js"]) vm.runInContext(src(f), ctx, { filename: f });
    const VA = vm.runInContext("VoiceAssistant", ctx);
    sandbox.VoiceAssistant = VA;
    VA.ASK_LISTEN_MS = 120; VA.ASK_EXTEND_MS = 80; VA.ASK_ECHO_MS = 5;
    const gate = sandbox.MUAdvice.gate.createGate({ adviceGapMs: 0 });
    gate.setAskFirst(true);
    sandbox.MUAdvice.live = { decide: (text, opts) => gate.decide({ text, ...opts }, Date.now()), noteAnswer: (c, a) => gate.noteAnswer(c, a, Date.now()) };
    return { VA, said, stops, announce: vm.runInContext("voiceAnnounce", ctx), setReply: (r) => { reply = r; } };
}

test("voice.js: with no speechSynthesis at all, the app speaks through MapUniteVoice in a Hindi voice", async () => {
    const v = loadApp();
    assert.equal(v.VA.synth, null);
    assert.equal(v.VA.canSpeak(), true);
    assert.ok(v.announce("Bhai, aage gaddha hai, dheere kar.", { priority: 90, category: "road" }));
    await tick(40);
    assert.equal(v.said.length, 1);
    assert.equal(v.said[0].lang, "hi-IN");
    assert.equal(v.said[0].text, "भाई, आगे गड्ढा है, धीरे कर.");
    assert.equal(v.VA.current, null, "settled when the plugin reported ended");
});

test("voice.js: ask first runs on the engine: question in Hindi → 'haan' → the tip", async () => {
    const v = loadApp();
    v.setReply({ type: "say", text: "haan bol" });
    let result = null;
    assert.equal(v.announce("Bhai, thoda break le le.", { priority: 45, category: "fatigue", onResult: (x) => { result = x; } }), "ask");
    await tick(300);
    assert.equal(v.said.length, 2);
    assert.match(v.said[0].text, /बात बोलूँ|बताऊँ|भाई/);
    assert.equal(v.said[1].text, "भाई, थोड़ा break ले ले.");
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { spoken: true, reason: "asked:yes" });
});

test("voice.js: a higher-priority line pre-empts at once; the cut line is settled once and the queue moves on", async () => {
    const v = loadApp();
    const doneA = [];
    v.VA.announce("Bhai, network thoda weak hai.", { priority: 50, onDone: (f) => doneA.push(f) });
    await tick(3);
    v.VA.announce("Speed breaker in 200 metres.", { priority: 90 });
    await tick(3);
    assert.deepEqual(doneA, [false]);
    assert.equal(v.said[1].lang, "en-IN");
    assert.ok(v.stops.length >= 1, "the plugin was told to stop the old line");
    await tick(40);
    assert.equal(v.VA.current, null);
    v.VA.silence();
    assert.deepEqual(doneA, [false], "settled exactly once");
});

test("engine: lines longer than the server takes go straight to the device voice (no failed request)", async () => {
    const w = world();
    const h = w.engine.speak("You can say: how far, where is, then a name. ".repeat(10), { priority: 80 - 1 });
    await tick(5);
    assert.equal(h.route, "native");
    assert.equal(w.calls.fetch.length, 0);
    w.finishNative(); await h.done;
});
