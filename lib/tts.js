"use strict";
/* ============================================================================
   MapUnite server — premium neural voice (/api/tts)
   ==============================================================================
   The Master AI's voice, synthesised by a neural TTS on the server so no API
   key ever ships in the app. One provider at a time:

     TTS_PROVIDER=google       Google Cloud Text-to-Speech, Chirp 3 HD voices
       GOOGLE_TTS_API_KEY      key with the Text-to-Speech API enabled
                               (falls back to GOOGLE_MAPS_SERVER_KEY if that key allows TTS)
       GOOGLE_TTS_VOICE        voice name without the locale, default "Puck"
                               (used as hi-IN-Chirp3-HD-Puck and en-IN-Chirp3-HD-Puck,
                               the same speaker for Hinglish and English)
       GOOGLE_TTS_MARKUP=1     send relaxed lines as Chirp 3 "markup" with [pause short]
     TTS_PROVIDER=elevenlabs   ElevenLabs
       ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID (a Hindi/Hinglish voice from your library)
       ELEVENLABS_MODEL        default "eleven_multilingual_v2"

   GET /api/tts?lang=hi-IN|en-IN&rate=0.80..1.30&m=0|1&q=<text ≤ 400 chars>
     → audio/mpeg, Cache-Control: public, max-age 30 days, immutable (same line,
       same audio), ETag = the cache key. 503 { reason: "not-configured" } when no
       provider is set (the app then uses the phone's neural voice).

   Cost and latency: the Master repeats itself a lot ("Bhai, ek baat bolun?"), so
   every result is cached in memory (LRU, 32 MB) and on disk (TTS_CACHE_DIR,
   default data/tts-cache, newest 5000 files); identical requests in flight share
   one upstream call; each upstream call times out after 6 s.
   ============================================================================ */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const LANGS = new Set(["hi-IN", "en-IN"]);
const MAX_CHARS = 400;

/**
 * @param {{ env?: Record<string, string|undefined>, fetch?: Function, cacheDir?: string|null, log?: (m: string) => void }} [o]
 */
function createTts(o = {}) {
    const env = o.env || process.env;
    const doFetch = o.fetch || globalThis.fetch;
    const log = o.log || (() => {});
    const provider = String(env.TTS_PROVIDER || "").toLowerCase();
    const googleKey = env.GOOGLE_TTS_API_KEY || env.GOOGLE_MAPS_SERVER_KEY || "";
    const googleVoice = String(env.GOOGLE_TTS_VOICE || "Puck").replace(/[^A-Za-z]/g, "") || "Puck";
    const googleMarkup = env.GOOGLE_TTS_MARKUP === "1";
    const elKey = env.ELEVENLABS_API_KEY || "";
    const elVoice = String(env.ELEVENLABS_VOICE_ID || "").replace(/[^A-Za-z0-9]/g, "");
    const elModel = env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

    const configured =
        (provider === "google" && Boolean(googleKey)) ||
        (provider === "elevenlabs" && Boolean(elKey) && Boolean(elVoice));
    const voiceId = provider === "google" ? `google:${googleVoice}${googleMarkup ? "+m" : ""}` : `elevenlabs:${elVoice}:${elModel}`;

    const cacheDir = o.cacheDir === null ? null : (o.cacheDir || env.TTS_CACHE_DIR || path.join(process.cwd(), "data", "tts-cache"));
    if (cacheDir && configured) { try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) { log(`tts: cache dir ${cacheDir}: ${e.message}`); } }

    /** @type {Map<string, Buffer>} */ const memory = new Map();
    let memoryBytes = 0;
    const MEMORY_MAX = 32 * 1024 * 1024;
    /** @type {Map<string, Promise<Buffer>>} */ const inflight = new Map();
    const stats = { requests: 0, memoryHits: 0, diskHits: 0, upstream: 0, upstreamErrors: 0 };

    /**
     * Checks and normalises a request.
     * @param {{ q?: any, lang?: any, rate?: any, m?: any }} p
     * @returns {{ ok: true, text: string, lang: string, rate: number, markup: boolean } | { ok: false, error: string }}
     */
    function parse(p) {
        const text = String(p.q || "").replace(/\s+/g, " ").trim();
        if (!text) return { ok: false, error: "q is required" };
        if (text.length > MAX_CHARS) return { ok: false, error: `q is longer than ${MAX_CHARS} characters` };
        const lang = String(p.lang || "hi-IN");
        if (!LANGS.has(lang)) return { ok: false, error: "lang must be hi-IN or en-IN" };
        const rate = Number(p.rate == null ? 1 : p.rate);
        if (!Number.isFinite(rate) || rate < 0.8 || rate > 1.3) return { ok: false, error: "rate must be 0.80 … 1.30" };
        return { ok: true, text, lang, rate: Math.round(rate * 100) / 100, markup: String(p.m) === "1" && /\[pause (short|long)\]|\[pause\]/.test(text) };
    }

    const keyOf = (/** @type {any} */ r) => crypto.createHash("sha256").update(`${voiceId}|${r.lang}|${r.rate}|${r.markup ? 1 : 0}|${r.text}`).digest("hex");

    function remember(/** @type {string} */ k, /** @type {Buffer} */ b) {
        if (memory.has(k)) return;
        memory.set(k, b); memoryBytes += b.length;
        for (const [old, ob] of memory) { if (memoryBytes <= MEMORY_MAX) break; memory.delete(old); memoryBytes -= ob.length; }
    }

    async function upstream(/** @type {any} */ r) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 6000);
        stats.upstream++;
        try {
            if (provider === "google") {
                // markup carries [pause short]; a provider that doesn't take it gets the plain text
                const input = r.markup && googleMarkup ? { markup: r.text } : { text: r.text.replace(/\s*\[pause(?: short| long)?\]\s*/g, " ") };
                const res = await doFetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(googleKey)}`, {
                    method: "POST", signal: ctl.signal,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        input,
                        voice: { languageCode: r.lang, name: `${r.lang}-Chirp3-HD-${googleVoice}` },
                        audioConfig: { audioEncoding: "MP3", speakingRate: r.rate }
                    })
                });
                if (!res.ok) throw new Error(`google tts HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
                const j = await res.json();
                if (!j || typeof j.audioContent !== "string") throw new Error("google tts: no audioContent");
                return Buffer.from(j.audioContent, "base64");
            }
            if (provider === "elevenlabs") {
                const res = await doFetch(`https://api.elevenlabs.io/v1/text-to-speech/${elVoice}?output_format=mp3_44100_64`, {
                    method: "POST", signal: ctl.signal,
                    headers: { "Content-Type": "application/json", "xi-api-key": elKey, Accept: "audio/mpeg" },
                    body: JSON.stringify({
                        text: r.text.replace(/\s*\[pause(?: short| long)?\]\s*/g, " "),
                        model_id: elModel,
                        // a warm, steady narrator: some expression, no drifting
                        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true }
                    })
                });
                if (!res.ok) throw new Error(`elevenlabs HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
                return Buffer.from(await res.arrayBuffer());
            }
            throw new Error("no provider");
        } finally { clearTimeout(timer); }
    }

    /**
     * @param {{ q?: any, lang?: any, rate?: any, m?: any }} params
     * @returns {Promise<{ status: number, audio?: Buffer, key?: string, source?: string, error?: string }>}
     */
    async function synthesize(params) {
        stats.requests++;
        if (!configured) return { status: 503, error: "not-configured" };
        const r = parse(params);
        if (!r.ok) return { status: 400, error: r.error };
        const k = keyOf(r);
        const m = memory.get(k);
        if (m) { stats.memoryHits++; memory.delete(k); memory.set(k, m); return { status: 200, audio: m, key: k, source: "memory" }; }
        if (cacheDir) {
            try {
                const b = await fs.promises.readFile(path.join(cacheDir, `${k}.mp3`));
                stats.diskHits++; remember(k, b);
                return { status: 200, audio: b, key: k, source: "disk" };
            } catch (e) { /* not cached */ }
        }
        let p = inflight.get(k);
        if (!p) {
            p = upstream(r).finally(() => inflight.delete(k));
            inflight.set(k, p);
        }
        try {
            const audio = await p;
            if (!audio || audio.length < 200) throw new Error("empty audio");
            remember(k, audio);
            if (cacheDir) writeDisk(k, audio);
            return { status: 200, audio, key: k, source: "upstream" };
        } catch (e) {
            stats.upstreamErrors++;
            log(`tts: ${e.message}`);
            return { status: 502, error: "upstream-failed" };
        }
    }

    let writes = 0;
    function writeDisk(/** @type {string} */ k, /** @type {Buffer} */ b) {
        fs.promises.writeFile(path.join(/** @type {string} */ (cacheDir), `${k}.mp3`), b).catch(() => {});
        if (++writes % 200 === 0) prune().catch(() => {});
    }
    /** Keeps the newest 5000 files. */
    async function prune() {
        const dir = /** @type {string} */ (cacheDir);
        const names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith(".mp3"));
        if (names.length <= 5000) return;
        const withTime = await Promise.all(names.map(async (n) => ({ n, t: (await fs.promises.stat(path.join(dir, n))).mtimeMs })));
        withTime.sort((a, b) => a.t - b.t);
        for (const f of withTime.slice(0, names.length - 5000)) await fs.promises.unlink(path.join(dir, f.n)).catch(() => {});
    }

    /**
     * Express handler. allowOrigin(origin) → true for origins allowed to fetch the audio (the Android app).
     * @param {{ allowOrigin?: (origin: string) => boolean }} [h]
     */
    function handler(h = {}) {
        return async (/** @type {any} */ req, /** @type {any} */ res) => {
            const origin = req.headers.origin;
            if (origin && h.allowOrigin && h.allowOrigin(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
            res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
            const out = await synthesize(req.query || {});
            if (out.status !== 200) return res.status(out.status).json({ ok: false, reason: out.error });
            const etag = `"${out.key}"`;
            if (req.headers["if-none-match"] === etag) return res.status(304).end();
            res.setHeader("Content-Type", "audio/mpeg");
            res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
            res.setHeader("ETag", etag);
            res.setHeader("X-TTS-Source", out.source);
            res.end(out.audio);
        };
    }

    return { configured, provider: configured ? provider : null, voiceId, parse, synthesize, handler, stats: () => ({ ...stats, memoryEntries: memory.size, memoryBytes }) };
}

module.exports = { createTts, LANGS, MAX_CHARS };
