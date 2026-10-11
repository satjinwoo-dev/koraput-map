// @ts-check
"use strict";
/* ============================================================================
   MapUnite Master AI (server) — reasoning engines: Google Gemini + local Ollama
   ==============================================================================
   One interface, two engines, no paid dependency:

     const r = await engines.reason({ system, prompt, schema, wantWeb, deadlineMs });
     r → { ok, engine: "gemini"|"ollama", text, sources: [{ title, url }], grounded, ms, tried: [...] }

   GEMINI (cloud, primary when GEMINI_API_KEY is set)
     REST: POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
     header x-goog-api-key (server only). Model GEMINI_MODEL, default "gemini-flash-latest"
     (Google's alias for the newest Flash: no code change when they ship a new one).
     wantWeb → tools: [{ google_search: {} }] (grounding with Google Search). Sources
     come from the response's groundingMetadata.groundingChunks[].web { uri, title },
     never from text the model wrote. JSON is asked for in the prompt and parsed
     leniently (structured output isn't combined with the search tool).
     GEMINI_DAILY_MAX (default 200) keeps a margin under the free tier's per-day
     quota; past it, or on 429 / 5xx / timeout / open circuit, the request goes
     straight to Ollama.

   OLLAMA (local, on the same machine as this server: free, private, offline-capable)
     REST: POST <OLLAMA_URL>/api/chat (default http://127.0.0.1:11434), stream: false,
     format: <JSON schema> (Ollama's structured outputs), keep_alive "30m" so the
     model stays in GPU memory between questions. Model OLLAMA_MODEL, default
     "llama3.2:3b" (fits a 4 GB RTX 3050 laptop GPU; with 6–8 GB use
     "llama3.1:8b" or "qwen2.5:7b", noticeably better Hinglish).
     A local model has no web access. With wantWeb it gets a small, free,
     keyless retrieval step first: Wikipedia's search (OLLAMA_RETRIEVAL=wikipedia,
     the default; "none" to switch off). Those pages become its sources, and the
     answer is marked grounded only if retrieval found something.
     Health: GET /api/tags (cached 30 s) tells whether Ollama is up AND the model
     is pulled; /api/master/status shows it.

   ORDER: MASTER_LLM_ORDER, default "gemini,ollama". "ollama,gemini" = local first
   (cloud only when the GPU box is down), "ollama" = local only.
   A deadline (default 48 s, under the phone's 55 s) is shared across engines:
   the fallback only starts if there's time left for it to finish.
   ============================================================================ */

const { createUpstream } = require("./upstream");

/** Strip a model's chain-of-thought tags (some local models emit <think>…</think>). @param {string} t */
const stripThink = (t) => String(t || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

/**
 * @param {{ apiKey?: string, model?: string, dailyMax?: number, fetchImpl?: typeof fetch, now?: () => number, baseUrl?: string }} o
 */
function createGemini(o) {
    const apiKey = o.apiKey || "";
    const model = o.model || "gemini-flash-latest";
    const base = (o.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const now = o.now || (() => Date.now());
    const dailyMax = o.dailyMax ?? 200;
    const up = createUpstream({ name: "gemini", fetchImpl: o.fetchImpl, now, failuresToOpen: 4 });
    let day = "", used = 0;

    return {
        name: "gemini",
        configured: () => Boolean(apiKey),
        /** Free-tier budget left today. */
        available() {
            const d = new Date(now()).toISOString().slice(0, 10);
            if (d !== day) { day = d; used = 0; }
            return Boolean(apiKey) && used < dailyMax && !up.state().open;
        },
        /**
         * @param {{ system: string, prompt: string, wantWeb?: boolean, timeoutMs: number, maxTokens?: number }} q
         */
        async generate(q) {
            used++;
            const body = {
                systemInstruction: { parts: [{ text: q.system }] },
                contents: [{ role: "user", parts: [{ text: q.prompt }] }],
                generationConfig: { temperature: 0.3, maxOutputTokens: q.maxTokens || 1200 },
                ...(q.wantWeb ? { tools: [{ google_search: {} }] } : {})
            };
            const j = await up.json(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
                body: JSON.stringify(body)
            }, { timeoutMs: q.timeoutMs, retries: 0 });
            const cand = j && Array.isArray(j.candidates) ? j.candidates[0] : null;
            const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
            // "thought" parts (thinking models) are reasoning, not the answer
            const text = stripThink(parts.filter((/** @type {any} */ p) => typeof p.text === "string" && !p.thought).map((/** @type {any} */ p) => p.text).join(""));
            const gm = (cand && cand.groundingMetadata) || {};
            /** @type {Map<string, { title: string, url: string }>} */ const src = new Map();
            for (const c of Array.isArray(gm.groundingChunks) ? gm.groundingChunks : []) {
                const w = c && c.web;
                if (w && typeof w.uri === "string" && /^https?:\/\//.test(w.uri) && !src.has(w.uri)) src.set(w.uri, { title: String(w.title || w.uri).slice(0, 140), url: w.uri });
            }
            const blocked = cand && /SAFETY|BLOCKLIST|PROHIBITED/.test(String(cand.finishReason || ""));
            if (!text) { const e = new Error(blocked ? "gemini: blocked" : "gemini: empty answer"); /** @type {any} */ (e).code = blocked ? "BLOCKED" : "EMPTY"; throw e; }
            return { text, sources: [...src.values()].slice(0, 6), grounded: src.size > 0, model };
        },
        stats: () => ({ model, usedToday: used, dailyMax, upstream: up.state() })
    };
}

/**
 * Free, keyless retrieval for the local model: Wikipedia's search API.
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, lang?: string }} o
 */
function createWikipedia(o) {
    const up = createUpstream({ name: "wikipedia", fetchImpl: o.fetchImpl, now: o.now, failuresToOpen: 3 });
    const lang = o.lang || "en";
    return {
        /** @param {string} query @param {number} timeoutMs @returns {Promise<Array<{ title: string, url: string, text: string }>>} */
        async search(query, timeoutMs) {
            const url = `https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query.slice(0, 200))}&limit=3`;
            const j = await up.json(url, { headers: { "user-agent": "MapUnite/1.0 (master deep search; local model retrieval)", accept: "application/json" } }, { timeoutMs, retries: 0 });
            const pages = Array.isArray(j && j.pages) ? j.pages : [];
            return pages.map((/** @type {any} */ p) => ({
                title: String(p.title || "").slice(0, 140),
                url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(p.key || p.title || "").replace(/ /g, "_"))}`,
                // excerpts carry <span class="searchmatch"> markup
                text: `${String(p.description || "")} ${String(p.excerpt || "").replace(/<[^>]+>/g, "")}`.replace(/\s+/g, " ").trim().slice(0, 600)
            })).filter((/** @type {any} */ p) => p.title && p.text);
        },
        stats: () => up.state()
    };
}

/**
 * @param {{ url?: string, model?: string, retrieval?: "wikipedia"|"none", fetchImpl?: typeof fetch, now?: () => number, keepAlive?: string }} o
 */
function createOllama(o) {
    const url = (o.url || "http://127.0.0.1:11434").replace(/\/+$/, "");
    const model = o.model || "llama3.2:3b";
    const now = o.now || (() => Date.now());
    const up = createUpstream({ name: "ollama", fetchImpl: o.fetchImpl, now, failuresToOpen: 3, openMs: 15000 });
    const wiki = o.retrieval === "none" ? null : createWikipedia({ fetchImpl: o.fetchImpl, now });
    /** @type {{ at: number, up: boolean, hasModel: boolean, models: string[] }} */ let health = { at: -Infinity, up: false, hasModel: false, models: [] };

    /** Is Ollama running, and is the model pulled? Cached 30 s. */
    async function check() {
        if (now() - health.at < 30000) return health;
        try {
            const j = await up.json(`${url}/api/tags`, {}, { timeoutMs: 2000, retries: 0 });
            const models = (Array.isArray(j && j.models) ? j.models : []).map((/** @type {any} */ m) => String(m.name || m.model || ""));
            // "llama3.2:3b" matches "llama3.2:3b"; a bare "llama3.2" matches "llama3.2:latest"
            const want = model.includes(":") ? model : `${model}:latest`;
            health = { at: now(), up: true, hasModel: models.includes(want) || models.includes(model), models: models.slice(0, 20) };
        } catch { health = { at: now(), up: false, hasModel: false, models: [] }; }
        return health;
    }

    return {
        name: "ollama",
        configured: () => true,
        check,
        available: () => !up.state().open,
        /**
         * @param {{ system: string, prompt: string, schema?: any, wantWeb?: boolean, webQuery?: string, timeoutMs: number, maxTokens?: number }} q
         */
        async generate(q) {
            const h = await check();
            if (!h.up) { const e = new Error("ollama: not running"); /** @type {any} */ (e).code = "UNREACHABLE"; throw e; }
            if (!h.hasModel) { const e = new Error(`ollama: model ${model} not pulled (ollama pull ${model})`); /** @type {any} */ (e).code = "NO_MODEL"; throw e; }
            const t0 = now();
            /** @type {Array<{ title: string, url: string, text: string }>} */ let docs = [];
            if (q.wantWeb && wiki) { try { docs = await wiki.search(q.webQuery || q.prompt, Math.min(4000, q.timeoutMs / 4)); } catch { docs = []; } }
            const grounding = docs.length
                ? `\n\nReference notes (Wikipedia, retrieved just now; use them only if relevant, never invent beyond them):\n${docs.map((d, i) => `[${i + 1}] ${d.title}: ${d.text}`).join("\n")}`
                : "\n\nYou have NO live web access for this question. If it depends on current facts (weather, traffic, opening hours, prices, news, road status), say plainly that you can't check that live right now, and give general guidance instead. Set confidence ≤ 0.4 then.";
            const j = await up.json(`${url}/api/chat`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    model, stream: false, keep_alive: o.keepAlive || "30m",
                    ...(q.schema ? { format: q.schema } : {}),
                    options: { temperature: 0.3, num_ctx: 4096, num_predict: q.maxTokens || 700 },
                    messages: [{ role: "system", content: q.system }, { role: "user", content: `${q.prompt}${grounding}` }]
                })
            }, { timeoutMs: Math.max(1000, q.timeoutMs - (now() - t0)), retries: 0 });
            const text = stripThink(j && j.message && j.message.content);
            if (!text) { const e = new Error("ollama: empty answer"); /** @type {any} */ (e).code = "EMPTY"; throw e; }
            return { text, sources: docs.map((d) => ({ title: d.title, url: d.url })), grounded: docs.length > 0, model };
        },
        stats: () => ({ url, model, health: { up: health.up, hasModel: health.hasModel, models: health.models }, upstream: up.state(), retrieval: wiki ? "wikipedia" : "none" })
    };
}

/**
 * @param {{ order?: string[], gemini?: ReturnType<typeof createGemini>, ollama?: ReturnType<typeof createOllama>, now?: () => number, log?: { warn: Function } }} o
 */
function createEngines(o) {
    const now = o.now || (() => Date.now());
    const log = o.log || console;
    /** @type {Record<string, any>} */ const byName = { gemini: o.gemini, ollama: o.ollama };
    const order = (o.order && o.order.length ? o.order : ["gemini", "ollama"]).filter((n) => byName[n]);
    /** @type {Record<string, number>} */ const served = { gemini: 0, ollama: 0 };
    let fallbacks = 0;

    /**
     * Try each engine in order until one answers, inside one shared deadline.
     * @param {{ system: string, prompt: string, schema?: any, wantWeb?: boolean, webQuery?: string, deadlineMs?: number, maxTokens?: number,
     *   accept?: (text: string) => boolean }} q
     *   accept: a validator (e.g. "parses as our JSON"); a reply it rejects counts as a failure and the next engine is tried
     */
    async function reason(q) {
        const t0 = now();
        const deadline = t0 + (q.deadlineMs ?? 48000);
        /** @type {Array<{ engine: string, error: string }>} */ const tried = [];
        for (const name of order) {
            const e = byName[name];
            if (!e.configured()) { tried.push({ engine: name, error: "not-configured" }); continue; }
            if (!e.available()) { tried.push({ engine: name, error: "unavailable" }); continue; }
            const left = deadline - now();
            // leave the local model enough time: a cold model load on a 3050 takes several seconds
            if (left < (name === "ollama" ? 8000 : 4000)) { tried.push({ engine: name, error: "no-time-left" }); continue; }
            try {
                // an engine with a fallback after it doesn't get the whole budget: keep ~12 s for the next one
                const hasNext = order.slice(order.indexOf(name) + 1).some((n) => byName[n].configured());
                const timeoutMs = hasNext ? Math.max(6000, Math.min(25000, left - 12000)) : left;
                const r = await e.generate({ ...q, timeoutMs });
                if (q.accept && !q.accept(r.text)) throw Object.assign(new Error(`${name}: unusable answer`), { code: "UNUSABLE" });
                served[name]++;
                if (tried.length) fallbacks++;
                return { ok: true, engine: name, ...r, ms: now() - t0, tried };
            } catch (err) {
                const code = /** @type {any} */ (err).code || "ERROR";
                tried.push({ engine: name, error: code });
                log.warn(`[master] ${name} failed (${code}): ${/** @type {any} */ (err).message}`);
            }
        }
        return { ok: false, engine: null, text: "", sources: [], grounded: false, ms: now() - t0, tried };
    }

    return {
        reason, order,
        configured: () => order.some((n) => byName[n].configured()),
        /** Live readiness of each engine (Ollama is actually asked). */
        async health() {
            /** @type {Record<string, any>} */ const out = { order };
            if (o.gemini) out.gemini = { configured: o.gemini.configured(), available: o.gemini.available(), model: o.gemini.stats().model };
            if (o.ollama) { const h = await o.ollama.check(); out.ollama = { up: h.up, hasModel: h.hasModel, model: o.ollama.stats().model, models: h.models }; }
            out.ready = order.some((n) => (n === "gemini" ? out.gemini && out.gemini.available : out.ollama && out.ollama.up && out.ollama.hasModel));
            return out;
        },
        stats: () => ({ order, served, fallbacks, gemini: o.gemini ? o.gemini.stats() : null, ollama: o.ollama ? o.ollama.stats() : null })
    };
}

/** Engines from the environment. @param {Record<string, string|undefined>} env @param {{ fetchImpl?: typeof fetch, now?: () => number }} [o] */
function enginesFromEnv(env, o = {}) {
    const order = String(env.MASTER_LLM_ORDER || "gemini,ollama").split(",").map((s) => s.trim().toLowerCase()).filter((s) => s === "gemini" || s === "ollama");
    const gemini = createGemini({ apiKey: env.GEMINI_API_KEY || "", model: env.GEMINI_MODEL || undefined, dailyMax: Number(env.GEMINI_DAILY_MAX) || 200, fetchImpl: o.fetchImpl, now: o.now });
    const ollama = env.OLLAMA_DISABLED === "1" ? undefined : createOllama({ url: env.OLLAMA_URL || undefined, model: env.OLLAMA_MODEL || undefined, retrieval: env.OLLAMA_RETRIEVAL === "none" ? "none" : "wikipedia", fetchImpl: o.fetchImpl, now: o.now, keepAlive: env.OLLAMA_KEEP_ALIVE || undefined });
    return createEngines({ order, gemini, ollama, now: o.now });
}

module.exports = { createGemini, createOllama, createWikipedia, createEngines, enginesFromEnv, stripThink };
