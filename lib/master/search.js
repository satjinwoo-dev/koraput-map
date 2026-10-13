// @ts-check
"use strict";
/* ============================================================================
   MapUnite Master AI (server) — the Deep Search sub-agent's brain
   ==============================================================================
   POST /api/master/search
     { query, context?: { lat, lng, place, riding, speedMs, bike, destination, localTime, style,
                          live?: { weather, nearby } } }
     → { ok, answer: { spoken, title, summary, bullets[], confidence, timeSensitive },
         sources: [{ title, url }], engine: "gemini"|"ollama", grounded, cached }

   No paid dependency. The reasoning runs on lib/master/llm.js's engines, in
   MASTER_LLM_ORDER (default "gemini,ollama"):
     gemini  Google Gemini (free tier, GEMINI_API_KEY), grounded with Google Search:
             it searches, reads, cross-checks and answers; sources are the
             grounding chunks Google returns.
     ollama  a local model on this machine (Ollama, e.g. Llama 3 on the RTX 3050):
             free and private. No web of its own, so it gets Wikipedia
             excerpts first; for live facts (weather, traffic, opening hours)
             it says it can't check them live instead of guessing.
   Both answer the SAME strict JSON (Ollama is held to it with a JSON schema,
   Gemini by the prompt and a lenient parser), so the phone, the persona and
   the voice can't tell which engine answered, except for `engine` and
   `grounded` (shown on screen as the answer's source).

   The phone also sends what it already KNOWS live (context.live: the weather
   at the rider from the weather agent, the best places nearby from the POI
   agent), so even the local model can answer "kahan rukein?" from real data.

   RIDER SAFETY is in the system prompt and re-checked here:
     - the spoken line is ≤ 320 characters and carries no URLs or phone digits
       read out at speed (numbers go on screen, for when the rider stops);
     - nothing asks the rider to look at or touch the phone while moving;
     - medical / police / fire emergencies always mention 112 (India's ERSS).

   COST / ABUSE CONTROL: answers cached 30 min per (normalised query, ~1 km
   cell, style); MASTER_SEARCH_DAILY_MAX (default 1000) per server per day;
   Gemini's own GEMINI_DAILY_MAX; the route's rate limit. Only the question,
   a ~1 km position and the context fields above are sent: no name, no device id.
   ============================================================================ */

const { createCache } = require("./cache");
const { isCoord } = require("./geo");

/** The answer's shape, for Ollama's structured outputs (format: <schema>). */
const ANSWER_SCHEMA = Object.freeze({
    type: "object",
    properties: {
        spoken: { type: "string" }, title: { type: "string" }, summary: { type: "string" },
        bullets: { type: "array", items: { type: "string" } },
        confidence: { type: "number" }, time_sensitive: { type: "boolean" }
    },
    required: ["spoken", "title", "summary", "bullets", "confidence", "time_sensitive"]
});

const SYSTEM = `You are the research sub-agent of "MapUnite Master AI", a riding companion app for motorcyclists in India.
Your job: answer the rider's question accurately. When you can search the web, plan the searches you need, read several sources, and cross-check every fact that matters (numbers, opening hours, rules, prices, road status). Prefer official and recent sources. If sources disagree or are old, say so and lower your confidence. Facts given to you under "Live data from the rider's phone" are current and measured: prefer them for anything about right here, right now. Never invent facts, places, phone numbers or URLs.
If the rider is just chatting (a greeting like "hello" or "kaise ho", thanks, small talk), reply like a warm riding buddy in one or two short sentences: no research, title "Chat", summary = the same reply, bullets [], confidence 1, time_sensitive false.

The rider may be riding right now. Rules for the spoken line:
- At most 45 words. No URLs. No long digit strings (phone numbers, PIN codes) — say "number screen pe hai" / "the number is on screen" instead.
- Never tell the rider to look at, tap or use the phone while moving; any action with the phone starts with stopping safely first ("ruk ke…" / "once you've stopped…").
- For any medical, fire, crime or road-accident emergency, mention calling 112.
- Style "desi": friendly big-brother Hinglish in Roman script (e.g. "Bhai, …"), no insults, nothing about caste, religion, region or looks. Style "plain": plain English.

Return ONLY one JSON object, no prose before or after, no code fences:
{"spoken": string, "title": string (English, ≤ 60 chars), "summary": string (English, ≤ 700 chars), "bullets": string[] (English, ≤ 5 items, each ≤ 140 chars), "confidence": number (0..1), "time_sensitive": boolean}`;

/** @param {string} q */
const normalise = (q) => q.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Pull the JSON answer out of the final text (tolerates code fences and leading prose).
 * @param {string} text
 */
function parseAnswer(text) {
    const t = String(text || "").replace(/```(?:json)?/gi, "");
    const start = t.indexOf("{"), end = t.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        const j = JSON.parse(t.slice(start, end + 1));
        if (!j || typeof j.spoken !== "string" || typeof j.summary !== "string") return null;
        return j;
    } catch { return null; }
}

/** Make the spoken line safe to say at speed. @param {string} s */
function safeSpoken(s) {
    let out = String(s || "")
        .replace(/https?:\/\/\S+|www\.\S+/gi, "")
        .replace(/(?:\+?\d[\d\s-]{6,}\d)/g, (m) => (m.replace(/\D/g, "") === "112" ? m : ""))   // phone-like digit runs, except 112
        .replace(/\s+/g, " ").trim();
    if (out.length > 320) out = `${out.slice(0, 319).replace(/\s+\S*$/, "")}…`;
    return out;
}

/**
 * @param {{ engines: { reason: Function, configured: () => boolean, stats: () => any }, dailyMax?: number, now?: () => number }} o
 */
function createSearch(o) {
    const engines = o.engines;
    const dailyMax = o.dailyMax ?? 1000;
    const now = o.now || (() => Date.now());
    /** @type {ReturnType<typeof createCache<any>>} */ const cache = createCache({ max: 2000, ttlMs: 1800000, staleMs: 0, now });
    let day = "", used = 0;

    /** @param {any} ctx @param {string} style */
    function contextLines(ctx, style) {
        const lines = [`Answer style: ${style}.`];
        if (ctx.place) lines.push(`Rider is near: ${String(ctx.place).slice(0, 80)}, India.`);
        if (isCoord(ctx.lat, ctx.lng)) lines.push(`Approximate position: ${Number(ctx.lat).toFixed(2)}, ${Number(ctx.lng).toFixed(2)}.`);
        if (ctx.destination) lines.push(`Heading to: ${String(ctx.destination).slice(0, 80)}.`);
        if (ctx.bike) lines.push(`Motorcycle: ${String(ctx.bike).slice(0, 60)}.`);
        lines.push(ctx.riding ? "The rider is RIDING right now: keep the spoken line very short." : "The rider is stopped.");
        if (typeof ctx.localTime === "string") lines.push(`Local time: ${ctx.localTime.slice(0, 40)}.`);
        const live = ctx.live && typeof ctx.live === "object" ? ctx.live : null;
        if (live) {
            const facts = [];
            const w = live.weather;
            if (w && typeof w === "object") {
                const bits = [];
                if (Number.isFinite(w.tempC)) bits.push(`${Math.round(w.tempC)} °C`);
                if (Number.isFinite(w.feelsC)) bits.push(`feels like ${Math.round(w.feelsC)} °C`);
                if (Number.isFinite(w.rhPct)) bits.push(`humidity ${Math.round(w.rhPct)} %`);
                if (Array.isArray(w.hazards) && w.hazards.length) bits.push(`hazards in the next 2 km: ${w.hazards.slice(0, 4).map((/** @type {any} */ h) => `${String(h.type).slice(0, 20)} at ${Math.round(Number(h.distanceM) || 0)} m`).join(", ")}`);
                if (bits.length) facts.push(`Weather at the rider: ${bits.join("; ")}.`);
            }
            if (Array.isArray(live.nearby)) for (const p of live.nearby.slice(0, 5)) {
                if (p && typeof p.name === "string" && typeof p.category === "string") facts.push(`Nearby ${p.category.slice(0, 20)}: ${p.name.slice(0, 60)}, ${Math.round(Number(p.distanceM) || 0)} m away${p.tier === "vetted" ? ", well reviewed" : ""}.`);
            }
            if (facts.length) lines.push(`Live data from the rider's phone:\n- ${facts.join("\n- ")}`);
        }
        return lines.join("\n");
    }

    /** @param {any} a @param {any} r */
    function shape(a, r) {
        const conf = Number(a.confidence);
        let confidence = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5;
        if (!r.grounded) confidence = Math.min(confidence, 0.6);          // unchecked knowledge never claims certainty
        return {
            ok: true,
            answer: {
                spoken: safeSpoken(a.spoken),
                title: String(a.title || "Answer").slice(0, 60),
                summary: String(a.summary).slice(0, 700),
                bullets: (Array.isArray(a.bullets) ? a.bullets : []).filter((/** @type {any} */ x) => typeof x === "string").slice(0, 5).map((/** @type {string} */ x) => x.slice(0, 140)),
                confidence,
                timeSensitive: a.time_sensitive === true
            },
            sources: r.sources || [],
            engine: r.engine, model: r.model, grounded: Boolean(r.grounded), live: Boolean(r.live), ms: r.ms
        };
    }

    /** @param {any} body @returns {Promise<{ status: number, json: any }>} */
    async function handle(body) {
        if (!engines.configured()) return { status: 503, json: { ok: false, reason: "search-not-configured" } };
        const query = typeof (body && body.query) === "string" ? body.query.trim() : "";
        if (query.length < 2 || query.length > 500) return { status: 400, json: { ok: false, reason: "bad-query" } };
        // small talk from the mic ("hello"): answered at once, no web lookup (the phone sends chat: true for ≤ 3 words)
        const chat = body.chat === true;
        const ctx = body.context && typeof body.context === "object" ? body.context : {};
        const style = ctx.style === "plain" ? "plain" : "desi";
        const cell = isCoord(ctx.lat, ctx.lng) ? `${Number(ctx.lat).toFixed(2)},${Number(ctx.lng).toFixed(2)}` : "-";
        const key = `${chat ? "chat" : style}:${chat ? style : cell}:${normalise(query)}`;
        const hit = cache.get(key);
        if (hit) return { status: 200, json: { ...hit, cached: true } };

        const today = new Date(now()).toISOString().slice(0, 10);
        if (today !== day) { day = today; used = 0; }
        if (used >= dailyMax) return { status: 429, json: { ok: false, reason: "search-daily-budget" } };
        used++;

        const json = await cache.wrap(key, async () => {
            const r = await engines.reason({
                system: SYSTEM,
                prompt: `${contextLines(ctx, style)}\n\nRider's question: ${query}`,
                schema: ANSWER_SCHEMA, wantWeb: !chat, webQuery: query, deadlineMs: chat ? 20000 : 48000, maxTokens: chat ? 400 : 1200,
                accept: (/** @type {string} */ text) => parseAnswer(text) !== null
            });
            if (!r.ok) return { ok: false, reason: "no-engine-answered", tried: r.tried };
            return shape(/** @type {any} */ (parseAnswer(r.text)), r);
        }, { cacheIf: (v) => Boolean(v && v.ok && !(v.answer && v.answer.timeSensitive)) });
        return { status: json.ok ? 200 : 502, json: { ...json, cached: false } };
    }

    return { handle, configured: () => engines.configured(), stats: () => ({ usedToday: used, dailyMax, cache: cache.stats(), engines: engines.stats() }) };
}

module.exports = { createSearch, parseAnswer, safeSpoken, SYSTEM, ANSWER_SCHEMA };
