// @ts-check
"use strict";
/* ============================================================================
   MapUnite Master AI (server) — what the music says about the mood
   ==============================================================================
   POST /api/master/music  { title, artist, target?: "keep"|"energise"|"calm" }
     → { ok, mood: { label, valence, energy, confidence, tags[] }, suggestions: [{ title, artist }] }

   The phone sends only the title and artist of the track playing (no history,
   no account). Mood is a point on two axes, both −1…+1:
     valence  sad ↔ happy        energy  calm ↔ intense
   from the track's crowd tags (Last.fm, LASTFM_API_KEY), weighted by how often
   each tag was applied; without a key (or no tags) from words in the title
   (Hindi / Hinglish included: "dard", "bewafa", "lofi", "remix", "bhajan" …),
   with low confidence. Labels: happy, energetic, romantic, chill, sad, devotional, intense.

   Suggestions: "keep" → tracks similar to this one; "energise" (the rider is
   drowsy or it's a long boring stretch) or "calm" (stress is high) → top
   tracks of a tag for that mood, artists the rider just heard first.
   This infers mood from MUSIC, as a hint. The phone treats it as a suggestion
   only and never overrides what the rider says (agents/mood-agent.js).
   ============================================================================ */

const { createCache } = require("./cache");
const { createUpstream } = require("./upstream");

/** tag → [valence, energy] */
const LEXICON = Object.freeze({
    happy: [0.8, 0.4], party: [0.7, 0.9], dance: [0.6, 0.9], upbeat: [0.6, 0.7], fun: [0.7, 0.5], feelgood: [0.8, 0.4], "feel good": [0.8, 0.4],
    energetic: [0.4, 0.9], workout: [0.3, 0.9], gym: [0.3, 0.9], bhangra: [0.7, 0.9], punjabi: [0.5, 0.7], edm: [0.4, 0.9], electronic: [0.2, 0.6], hip_hop: [0.2, 0.7], "hip-hop": [0.2, 0.7], rap: [0.1, 0.7], rock: [0.1, 0.8], metal: [-0.2, 1], punk: [0, 0.9],
    romantic: [0.5, -0.3], love: [0.5, -0.2], romance: [0.5, -0.3],
    chill: [0.3, -0.6], chillout: [0.3, -0.6], lofi: [0.1, -0.7], "lo-fi": [0.1, -0.7], ambient: [0.1, -0.8], acoustic: [0.2, -0.4], mellow: [0.1, -0.6], relaxing: [0.3, -0.7], sufi: [0.3, -0.3], ghazal: [-0.1, -0.6], classical: [0.2, -0.5], instrumental: [0.1, -0.4],
    sad: [-0.8, -0.4], melancholy: [-0.7, -0.4], melancholic: [-0.7, -0.4], heartbreak: [-0.8, -0.2], depressing: [-0.9, -0.5], emotional: [-0.4, -0.2],
    devotional: [0.4, -0.4], bhajan: [0.4, -0.4], spiritual: [0.4, -0.5], qawwali: [0.4, 0.3], aarti: [0.4, -0.3],
    aggressive: [-0.4, 0.9], angry: [-0.6, 0.9], dark: [-0.5, 0.2], intense: [-0.2, 0.8],
    bollywood: [0.3, 0.3], "indian pop": [0.3, 0.4], indie: [0.1, 0.1]
});
const TITLE_WORDS = Object.freeze([
    { re: /\b(sad|dard|bewafa|judaai|tanha|alvida|tears?|aansoo|broken|dil toota|tadap)\b/i, m: [-0.7, -0.3], tag: "sad" },
    { re: /\b(lofi|lo-fi|slowed|reverb|chill)\b/i, m: [0.1, -0.7], tag: "lofi" },
    { re: /\b(remix|dj|party|dance|bhangra|nachde|thumka)\b/i, m: [0.7, 0.9], tag: "party" },
    { re: /\b(bhajan|aarti|mantra|chalisa|bhakti|shabad|naat)\b/i, m: [0.4, -0.4], tag: "devotional" },
    { re: /\b(pyaar|pyar|ishq|mohabbat|love|sanam|jaanam|dil)\b/i, m: [0.4, -0.2], tag: "romantic" },
    { re: /\b(workout|gym|power|beast|attitude)\b/i, m: [0.3, 0.9], tag: "workout" }
]);
/** mood target → Last.fm tag to draw suggestions from */
const TARGET_TAG = Object.freeze({ energise: ["bollywood dance", "bhangra", "upbeat"], calm: ["sufi", "acoustic", "chill"] });

/** @param {number} v @param {number} e */
function labelOf(v, e) {
    if (e >= 0.55 && v >= 0.3) return "energetic";
    if (e >= 0.55) return "intense";
    if (v >= 0.45 && e >= 0) return "happy";
    if (v >= 0.3 && e < 0 && e > -0.45) return "romantic";
    if (v <= -0.35) return "sad";
    if (e <= -0.45) return "chill";
    return v >= 0 ? "happy" : "sad";
}

/**
 * Tags (with counts) → mood. Pure.
 * @param {Array<{ name: string, count?: number }>} tags @param {string} [title]
 */
function moodOf(tags, title = "") {
    let v = 0, e = 0, w = 0;
    const used = [];
    for (const t of tags.slice(0, 15)) {
        const k = String(t.name || "").toLowerCase().trim();
        const m = /** @type {any} */ (LEXICON)[k];
        if (!m) continue;
        const weight = Math.max(1, Number(t.count) || 1);
        v += m[0] * weight; e += m[1] * weight; w += weight;
        used.push(k);
    }
    let confidence = w ? Math.min(0.9, 0.4 + used.length * 0.1) : 0;
    if (!w) {
        for (const tw of TITLE_WORDS) if (tw.re.test(title)) { v += tw.m[0]; e += tw.m[1]; w += 1; used.push(tw.tag); }
        confidence = w ? 0.3 : 0;
    }
    if (!w) return { label: "unknown", valence: 0, energy: 0, confidence: 0, tags: [] };
    const val = Math.max(-1, Math.min(1, v / w)), en = Math.max(-1, Math.min(1, e / w));
    const label = used.some((u) => /^(devotional|bhajan|spiritual|aarti)$/.test(u)) ? "devotional" : labelOf(val, en);
    return { label, valence: Math.round(val * 100) / 100, energy: Math.round(en * 100) / 100, confidence, tags: used.slice(0, 6) };
}

/**
 * @param {{ apiKey?: string, fetchImpl?: typeof fetch, now?: () => number, baseUrl?: string }} [o]
 */
function createMusic(o = {}) {
    const apiKey = o.apiKey || "";
    const base = o.baseUrl || "https://ws.audioscrobbler.com/2.0/";
    const now = o.now || (() => Date.now());
    const up = createUpstream({ name: "lastfm", fetchImpl: o.fetchImpl, now });
    /** @type {ReturnType<typeof createCache<any>>} */ const cache = createCache({ max: 20000, ttlMs: 7 * 86400000, now });

    /** @param {Record<string, string>} params */
    const call = (params) => up.json(`${base}?${new URLSearchParams({ ...params, api_key: apiKey, format: "json", autocorrect: "1" })}`, { headers: { "user-agent": "MapUnite/1.0" } }, { timeoutMs: 5000 });

    /** @param {any} body @returns {Promise<{ status: number, json: any }>} */
    async function handle(body) {
        const title = typeof (body && body.title) === "string" ? body.title.trim().slice(0, 120) : "";
        const artist = typeof (body && body.artist) === "string" ? body.artist.trim().slice(0, 120) : "";
        if (!title) return { status: 400, json: { ok: false, reason: "bad-track" } };
        const target = body.target === "energise" || body.target === "calm" ? body.target : "keep";
        const key = `${artist.toLowerCase()}|${title.toLowerCase()}`;
        const tags = apiKey && artist ? await cache.wrap(`tags:${key}`, async () => {
            const j = await call({ method: "track.gettoptags", artist, track: title });
            const t = j && j.toptags && j.toptags.tag;
            return (Array.isArray(t) ? t : t ? [t] : []).map((/** @type {any} */ x) => ({ name: String(x.name || ""), count: Number(x.count) || 1 }));
        }).catch(() => []) : [];
        const mood = moodOf(tags, title);
        /** @type {Array<{ title: string, artist: string }>} */ let suggestions = [];
        if (apiKey) {
            try {
                if (target === "keep" && artist) {
                    suggestions = await cache.wrap(`sim:${key}`, async () => {
                        const j = await call({ method: "track.getsimilar", artist, track: title, limit: "20" });
                        const t = j && j.similartracks && j.similartracks.track;
                        return (Array.isArray(t) ? t : []).map((/** @type {any} */ x) => ({ title: String(x.name || ""), artist: String((x.artist && x.artist.name) || "") })).filter((x) => x.title);
                    });
                } else if (target !== "keep") {
                    const tag = /** @type {any} */ (TARGET_TAG)[target][Math.floor(now() / 3600000) % 3];
                    suggestions = await cache.wrap(`tag:${tag}`, async () => {
                        const j = await call({ method: "tag.gettoptracks", tag, limit: "30" });
                        const t = j && j.tracks && j.tracks.track;
                        return (Array.isArray(t) ? t : []).map((/** @type {any} */ x) => ({ title: String(x.name || ""), artist: String((x.artist && x.artist.name) || "") })).filter((x) => x.title);
                    }, { ttlMs: 86400000 });
                    if (artist) suggestions = [...suggestions.filter((s) => s.artist.toLowerCase() === artist.toLowerCase()), ...suggestions.filter((s) => s.artist.toLowerCase() !== artist.toLowerCase())];
                }
            } catch { suggestions = []; }
        }
        return { status: 200, json: { ok: true, mood, target, suggestions: suggestions.slice(0, 5), source: apiKey ? "lastfm" : "title-words" } };
    }

    return { handle, configured: () => Boolean(apiKey), stats: () => ({ cache: cache.stats(), upstream: up.state() }) };
}

module.exports = { createMusic, moodOf, labelOf, LEXICON };
