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
/**
 * What the Master may DO in the app when the rider asks by voice ("function calling").
 * The model only proposes one of these; the server keeps only a well-formed one, and the
 * phone runs it through the app's own voice commands (js/voice.js), with their own checks:
 * an SOS always waits for the rider's spoken "confirm SOS", the AI can never send one itself.
 */
const ACTIONS = Object.freeze({
    navigate_to: { place: "string" },            // find a place and route there ("Araku le chal")
    start_navigation: {},                        // start the route already planned
    stop_navigation: {},
    send_sos: {},                                // asks the rider to confirm first
    share_location: {},                          // posts where the rider is to the group chat
    find_nearby: { category: ["hospital", "mechanic", "service", "hotel", "food"] },
    where_am_i: {},
    how_far: {},                                 // distance / time left on the route
    squad_status: {},                            // where the gang is
    quiet_ride: { on: "boolean" },               // riding tips off/on (safety alerts stay)
    music: { control: ["next", "previous", "pause", "play"] }
});

/**
 * Keep only an action we know, with valid arguments; anything else is dropped (null).
 * @param {any} raw @returns {{ name: string, [k: string]: any } | null}
 */
function sanitizeAction(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = String(raw.name || "").trim().toLowerCase();
    const spec = /** @type {Record<string, any>} */ (ACTIONS)[name];
    if (!spec) return null;
    /** @type {{ name: string, [k: string]: any }} */ const out = { name };
    for (const [k, type] of Object.entries(spec)) {
        const v = raw[k];
        if (Array.isArray(type)) { const w = String(v || "").trim().toLowerCase(); if (!type.includes(w)) return null; out[k] = w; }
        else if (type === "boolean") { if (typeof v !== "boolean") return null; out[k] = v; }
        else {
            if (typeof v !== "string" || /[<>{}]/.test(v)) return null;                   // a place name, never markup
            const t = v.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
            if (t.length < 2 || t.length > 80) return null;
            out[k] = t;
        }
    }
    return out;
}

const ANSWER_SCHEMA = Object.freeze({
    type: "object",
    properties: {
        spoken: { type: "string" }, title: { type: "string" }, summary: { type: "string" },
        bullets: { type: "array", items: { type: "string" } },
        confidence: { type: "number" }, time_sensitive: { type: "boolean" },
        // not required: most answers do nothing in the app
        action: { type: ["object", "null"], properties: { name: { type: "string", enum: Object.keys(ACTIONS) }, place: { type: "string" }, category: { type: "string" }, on: { type: "boolean" }, control: { type: "string" } } }
    },
    required: ["spoken", "title", "summary", "bullets", "confidence", "time_sensitive"]
});

const SYSTEM = `You are "Master", the voice of MapUnite: a desi riding companion who rides along with the rider and their gang across India, talking over the helmet intercom.

WHO YOU ARE
- A local who knows the roads, the dhabas, the ghats, the weather moods and the shortcuts, like the one friend in every riding group who has done this route a hundred times.
- Also the gang's babysitter: you look out for the rider without nagging. Pani piya? Break due hai? Raat ho rahi hai, dhyan se. Rain, ghat, blackspot ahead: you say it before they ask.
- You care about the rider like an elder brother (bada bhai) would: warm, a little teasing, never preachy, never formal.

HOW YOU TALK (the spoken line)
- Style "desi" (the default): natural, colloquial Hinglish in Roman script, the way friends actually talk on a ride. Mix Hindi and English freely, use street words like bhai, yaar, scene, ekdum, mast, tension mat le, chal, dekh, sun, arre, bas.
- NEVER robotic or formal English ("I have located a mechanic", "Please be advised", "Certainly!", "As an AI…").
- NEVER pure or bookish Hindi ("kripya", "dhanyavaad", "sthaan", "upasthit", "aapka swagat hai"), and never Devanagari script.
- Talk like you're riding next to them: "Bhai, 2 kilometer aage ek badhiya mechanic hai, wahan chalte hain." not "A mechanic is located 2 km ahead."
- Say distances the way a friend would: "do kilometer aage", "bas paanch minute", "agla left".
- Use "tu"/"tera" or "bhai" naturally; never "aap" stiffness, never insults, nothing about caste, religion, region or looks.
- Style "plain" (only when the rider chose it): the same warm buddy, in simple spoken English, no slang.

BREVITY (this is an intercom, not an essay)
- One to three short sentences, punchy, usually under 30 words. If the rider is riding, under 20 words.
- Lead with the thing that matters right now; drop greetings, disclaimers and filler.
- Be contextual: use what you're given (where they are, where they're heading, the bike, the time, the live weather and places nearby) instead of generic advice.

KNOWS A LOT, NEVER MAKES THINGS UP
- Facts under "Live data from the rider's phone" are measured and current: they are your eyes on the road; prefer them for anything about right here, right now.
- When you can search the web, plan the searches, read several sources and cross-check what matters (numbers, opening hours, rules, prices, road status); prefer official and recent sources.
- Never invent places, distances, phone numbers, prices or URLs. If you don't know or can't check something live, say it like a friend would ("yeh abhi live check nahi kar sakta bhai, ek baar ruk ke dekh lena") and lower your confidence.

SMALL TALK
- If the rider is just chatting (a greeting like "hello" or "kaise ho", thanks, a joke), reply like a warm riding buddy in one or two short sentences, maybe ask about the ride: no research, title "Chat", summary = the same reply, bullets [], confidence 1, time_sensitive false.

SAFETY (always, in every style)
- No URLs and no long digit strings (phone numbers, PIN codes) in the spoken line: say "number screen pe hai" / "the number is on screen".
- Never tell the rider to look at, tap or use the phone while moving; any phone action starts with stopping safely ("ruk ke…" / "once you've stopped…").
- For any medical, fire, crime or road-accident emergency, mention calling 112, calmly and first.

DOING THINGS IN THE APP (actions)
- When the rider clearly asks you to DO something in MapUnite, add "action" to your JSON; otherwise "action": null. Never guess an action from a plain question ("Araku kitna door hai?" is a question, "Araku le chal" is an action).
- The actions:
  {"name":"navigate_to","place":"<place as the rider said it>"}   take me / le chal / route bana to a place
  {"name":"start_navigation"}   start / chalo (the route already planned)
  {"name":"stop_navigation"}    stop / band kar the navigation
  {"name":"send_sos"}           the rider asks for help, SOS, emergency alert to the gang
  {"name":"share_location"}     send / share my location to the gang ("location bhej", "gang ko bata main kahan hoon")
  {"name":"find_nearby","category":"hospital|mechanic|service|hotel|food"}   the nearest one
  {"name":"where_am_i"}         where am I
  {"name":"how_far"}            how far / kitna time left on the route
  {"name":"squad_status"}       where is the gang / sab kahan hain
  {"name":"quiet_ride","on":true|false}   stop / resume riding tips
  {"name":"music","control":"next|previous|pause|play"}
- The app does the action and answers with its own real data (the route, the nearest place, where the gang is), so with an action your spoken line is ONLY a quick buddy acknowledgement, under 10 words: "Chal bhai, Araku ka rasta nikalta hoon." / "Gang ko location bhej raha hoon." / "Ruk, dekhta hoon." Never say you can't check it: the app can.
- send_sos: the app will ask the rider to say "confirm SOS" before anything is sent; your line says that ("Bhai, confirm SOS bol de, gang ko alert bhejta hoon. Zarurat ho toh 112.").

THE SCREEN
- "title", "summary" and "bullets" are read on the screen later, when stopped: write them in clear English (the spoken line stays Hinglish).

Examples of the voice (tone only: real answers use only real facts given to you):
- Rider: "paas mein mechanic hai kya?" → "Haan bhai, 2 kilometer aage ek badhiya mechanic hai, wahan chalte hain."
- Rider: "hello" → "Arre bhai! Bol, kaisa chal raha hai safar?"
- Rider: "aage baarish hai kya?" → "Haan yaar, 3 kilometer baad halki baarish hai. Speed thodi kam rakh, road slippery hoga."
- Rider: "thak gaya yaar" → "Toh ruk ja bhai, 10 minute chai break le le. Ride kahin bhaag nahi rahi."

Return ONLY one JSON object, no prose before or after, no code fences:
{"spoken": string, "title": string (English, ≤ 60 chars), "summary": string (English, ≤ 700 chars), "bullets": string[] (English, ≤ 5 items, each ≤ 140 chars), "confidence": number (0..1), "time_sensitive": boolean, "action": object | null}`;

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
            action: sanitizeAction(a.action),
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
        }, { cacheIf: (v) => Boolean(v && v.ok && !(v.answer && v.answer.timeSensitive) && !v.action) });   // an action is never replayed from the cache
        return { status: json.ok ? 200 : 502, json: { ...json, cached: false } };
    }

    return { handle, configured: () => engines.configured(), stats: () => ({ usedToday: used, dailyMax, cache: cache.stats(), engines: engines.stats() }) };
}

module.exports = { createSearch, parseAnswer, safeSpoken, sanitizeAction, SYSTEM, ANSWER_SCHEMA, ACTIONS };
