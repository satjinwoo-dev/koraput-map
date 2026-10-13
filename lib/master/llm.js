// @ts-check
"use strict";
/* ============================================================================
   MapUnite Master AI (server) — reasoning engines: Gemini, Groq, local Ollama
   ==============================================================================
   One interface, three engines, all free, none needing a credit card:

     const r = await engines.reason({ system, prompt, schema, wantWeb, deadlineMs });
     r → { ok, engine: "gemini"|"groq"|"ollama", text, sources: [{ title, url }], grounded, live, ms, tried: [...] }
         grounded: sources were read (Google Search, or Wikipedia notes); live: the web was searched
         just now (only Gemini with grounding on), so current facts were checked

   ORDER: MASTER_LLM_ORDER, default "gemini,groq,ollama". The first engine that
   answers (with a reply the caller accepts) wins; a 429 / quota / 5xx / timeout /
   open circuit / unusable reply hands over to the next, inside one shared
   deadline (default 48 s, under the phone's 55 s).

   GEMINI (cloud, GEMINI_API_KEY)
     REST: POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
     header x-goog-api-key (server only). Model GEMINI_MODEL, default
     "gemini-flash-lite-latest" (Google's alias for the newest Flash-Lite: no code
     change when they ship a new one). Measured on a free key: about 1 s per answer,
     against 6–28 s for "gemini-flash-latest", which also "thinks" first and is the
     one Google sheds first under load (503 "high demand"). A voice needs the fast one.
     GEMINI_THINKING "low" (default: thinkingConfig.thinkingLevel low, no long
     reasoning before the answer) | "model" (leave it to the model). A model that
     rejects the setting (400) is asked once more without it.
     GEMINI_GROUNDING "off" (default) | "auto":
       off   plain answers only. On a key without billing, Google Search grounding
             answers 429 ("quota exceeded") while plain answers work, so grounding
             is never asked for unless you turn it on.
       auto  tools: [{ google_search: {} }] (sources from groundingMetadata, never
             from text the model wrote). The first 429 on a grounded call turns
             grounding off until the next UTC day and the same question is asked
             again without it, so a quota on Search never costs an answer.
     GEMINI_DAILY_MAX (default 200) keeps a margin under the free tier's per-day quota.

   GROQ (cloud, GROQ_API_KEY: free tier, no card)
     OpenAI-compatible: POST <GROQ_BASE_URL>/chat/completions (default
     https://api.groq.com/openai/v1), Authorization: Bearer <key> (server only).
     Model GROQ_MODEL (default "llama-3.3-70b-versatile": a large open model, good
     Hinglish). Groq retires models over time: GET /models (cached 10 min) says
     whether the configured one is still served; start-up and /api/master/status
     show it. JSON mode (response_format json_object) when a schema is asked for;
     a 400 to that is retried once without it. GROQ_DAILY_MAX (default 500) is our
     own margin: set it to your plan's limit.

   OLLAMA (local, on the same machine as this server: free, private, offline-capable)
     REST: POST <OLLAMA_URL>/api/chat (default http://127.0.0.1:11434), stream: false,
     format: <JSON schema> (Ollama's structured outputs), keep_alive "30m" so the
     model stays in GPU memory between questions. Model OLLAMA_MODEL, default
     "llama3.2:3b" (fits a 4 GB RTX 3050 laptop GPU; with 6–8 GB use
     "llama3.1:8b" or "qwen2.5:7b", noticeably better Hinglish).
     Health: GET /api/tags (cached 30 s) tells whether Ollama is up AND the model
     is pulled; /api/master/status shows it.

   NO LIVE WEB: every engine except Gemini with grounding on answers from what it
   knows. For a wantWeb question those engines get a small, free, keyless
   retrieval step first: Wikipedia's search (MASTER_RETRIEVAL=wikipedia, the
   default; "none" to switch off; OLLAMA_RETRIEVAL is the old name). It runs at
   most once per question, shared by the fallbacks. The excerpts become the
   answer's sources and it's marked grounded only if retrieval found something;
   either way the engine is told it can't check live facts (weather, traffic,
   opening hours) and must say so instead of guessing.
   ============================================================================ */

const { createUpstream } = require("./upstream");

/** Strip a model's chain-of-thought tags (some local models emit <think>…</think>). @param {string} t */
const stripThink = (t) => String(t || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

/** An error with a code the engine chain understands. @param {string} message @param {string} code */
const fail = (message, code) => Object.assign(new Error(message), { code });

/** UTC day, for the daily budgets. @param {number} t */
const utcDay = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * What an engine without live web is told after the question: the retrieved notes, or that it can't check live.
 * @param {Array<{ title: string, text: string }>} docs
 */
function offlineNotes(docs) {
    return docs.length
        ? `\n\nReference notes (Wikipedia, retrieved just now; use them only if relevant, never invent beyond them):\n${docs.map((d, i) => `[${i + 1}] ${d.title}: ${d.text}`).join("\n")}\n\nYou have NO live web access beyond these notes. If the question depends on current facts (weather, traffic, opening hours, prices, news, road status) that the notes or the live data above don't give, say plainly that you can't check that live right now.`
        : "\n\nYou have NO live web access for this question. If it depends on current facts (weather, traffic, opening hours, prices, news, road status), say plainly that you can't check that live right now, and give general guidance instead. Set confidence ≤ 0.4 then.";
}

/**
 * Gemini models tried in order, within one request. On 13 Oct 2026 the free tier was overloaded: every
 * model answered 503 "high demand" or hung on some calls (gemini-flash-lite-latest on all of them), while
 * gemini-3.5-flash answered 2 of 3 in ~3 s. A 503 comes back in under a second, so moving on is cheap;
 * a hung model is cut off by its share of the time. GEMINI_MODEL takes one model or a comma-separated list.
 */
const GEMINI_MODELS = Object.freeze(["gemini-3.5-flash", "gemini-3.6-flash", "gemini-flash-lite-latest"]);

/**
 * @param {{ apiKey?: string, model?: string, models?: string[], dailyMax?: number, grounding?: "off"|"auto", thinking?: "low"|"model",
 *   modelTimeoutMs?: number, fetchImpl?: typeof fetch, now?: () => number, baseUrl?: string }} o
 *   modelTimeoutMs: the most one model may take while another is still left to try (default 12 s; answers take 1–4 s)
 */
function createGemini(o) {
    const apiKey = o.apiKey || "";
    const listed = (o.models && o.models.length ? o.models : String(o.model || "").split(",")).map((m) => m.trim()).filter(Boolean);
    const models = listed.length ? [...new Set(listed)] : [...GEMINI_MODELS];
    const model = models[0];
    const thinking = o.thinking === "model" ? "model" : "low";
    const base = (o.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const now = o.now || (() => Date.now());
    const dailyMax = o.dailyMax ?? 200;
    const grounding = o.grounding === "auto" ? "auto" : "off";
    const modelTimeoutMs = o.modelTimeoutMs ?? 12000;
    // one circuit breaker per model: an overloaded model is paused without pausing the others
    const ups = new Map(models.map((m) => [m, createUpstream({ name: `gemini:${m}`, fetchImpl: o.fetchImpl, now, failuresToOpen: 4 })]));
    /** @type {Map<string, number>} a model Google says is gone (404): skipped until then */ const goneUntil = new Map();
    const usable = (/** @type {string} */ m) => !(/** @type {any} */ (ups.get(m)).state().open) && !((goneUntil.get(m) || 0) > now());
    let day = "", used = 0;
    /** Grounding answered 429 on this UTC day: plain answers until the next one. */
    let groundingOffDay = "";
    const liveWeb = () => grounding === "auto" && groundingOffDay !== utcDay(now());

    return {
        name: "gemini",
        configured: () => Boolean(apiKey),
        /** Free-tier budget left today. */
        available() {
            const d = utcDay(now());
            if (d !== day) { day = d; used = 0; }
            return Boolean(apiKey) && used < dailyMax && models.some(usable);
        },
        /** Does this call search the web itself (Google Search grounding on, and not over its quota today)? */
        liveWeb,
        /**
         * @param {{ system: string, prompt: string, wantWeb?: boolean, timeoutMs: number, maxTokens?: number }} q
         */
        async generate(q) {
            const search = Boolean(q.wantWeb) && liveWeb();
            const t0 = now();
            const todo = models.filter(usable);
            if (!todo.length) throw fail("gemini: every model is paused after repeated failures", "CIRCUIT_OPEN");
            /** @type {any} */ let lastErr = null;
            /** @type {string[]} */ const errors = [];
            for (let k = 0; k < todo.length; k++) {
                const m = todo[k];
                const left = q.timeoutMs - (now() - t0);
                if (left < 1500) break;
                // a model with others still to try gets at most modelTimeoutMs, and leaves ≥ 3 s for each of them
                const rest = todo.length - k - 1;
                const budget = rest ? Math.max(1500, Math.min(modelTimeoutMs, left - 3000 * rest)) : left;
                try {
                    const r = await once(m, q, search, budget);
                    return errors.length ? { ...r, modelFallbacks: errors } : r;
                } catch (err) {
                    const e = /** @type {any} */ (err);
                    // Search grounding has its own quota (none on a key without billing): stop asking for it
                    // today, and let the chain ask Gemini again without it
                    if (search && e.code === "RATE_LIMITED") { groundingOffDay = utcDay(now()); throw fail("gemini: Google Search grounding over quota, plain answers until tomorrow (UTC)", "GROUNDING_QUOTA"); }
                    if (e.code === "BLOCKED") throw err;                        // the content, not the model: another model won't differ
                    if (e.status === 404) goneUntil.set(m, now() + 86400000);   // "no longer available": skip it for a day
                    errors.push(`${m}: ${e.code || "ERROR"}`);
                    lastErr = err;
                }
            }
            if (!lastErr) throw fail("gemini: no time left to try a model", "TIMEOUT");
            throw Object.assign(new Error(`gemini: every model failed (${errors.join(", ")})`), { code: lastErr.code || "ERROR", status: lastErr.status });
        },
        stats: () => ({ model, models, usedToday: used, dailyMax, grounding, thinking, groundingToday: liveWeb(),
            upstream: /** @type {any} */ (ups.get(model)).state(), upstreams: models.map((m) => ({ ...(/** @type {any} */ (ups.get(m)).state()), gone: (goneUntil.get(m) || 0) > now() })) })
    };

    /** One model, one answer. @param {string} m @param {{ system: string, prompt: string, maxTokens?: number }} q @param {boolean} search @param {number} timeoutMs */
    async function once(m, q, search, timeoutMs) {
        used++;
        const t0 = now();
        /** @type {any} */ const generationConfig = { temperature: 0.3, maxOutputTokens: q.maxTokens || 1200 };
        if (thinking === "low") generationConfig.thinkingConfig = { thinkingLevel: "low" };
        const body = {
            systemInstruction: { parts: [{ text: q.system }] },
            contents: [{ role: "user", parts: [{ text: q.prompt }] }],
            generationConfig,
            ...(search ? { tools: [{ google_search: {} }] } : {})
        };
        const up = /** @type {any} */ (ups.get(m));
        const call = (/** @type {number} */ ms) => up.json(`${base}/models/${encodeURIComponent(m)}:generateContent`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify(body)
        }, { timeoutMs: ms, retries: 0 });
        let j;
        try { j = await call(timeoutMs); }
        catch (err) {
            // an older model doesn't know thinkingLevel (400): ask once more without it
            if (!(generationConfig.thinkingConfig && /** @type {any} */ (err).status === 400)) throw err;
            delete generationConfig.thinkingConfig;
            j = await call(Math.max(1000, timeoutMs - (now() - t0)));
        }
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
        return { text, sources: [...src.values()].slice(0, 6), grounded: src.size > 0, model: m };
    }
}

/**
 * Groq: an OpenAI-compatible chat API with a free tier (no card). Any OpenAI-compatible
 * server works with baseUrl + model (the engine keeps the name "groq" in the chain).
 * @param {{ apiKey?: string, model?: string, baseUrl?: string, dailyMax?: number, fetchImpl?: typeof fetch, now?: () => number }} o
 */
/**
 * Groq retires models (13 Oct 2026: llama-3.1-8b-instant was "no longer served" on a fresh key). When
 * GROQ_MODEL isn't in the account's live model list, the first of these that is gets used instead, else
 * any chat model the list offers. The list is asked for at start-up and every 10 min.
 */
const GROQ_PREFERRED = Object.freeze(["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3-32b",
    "meta-llama/llama-4-maverick-17b-128e-instruct", "meta-llama/llama-4-scout-17b-16e-instruct", "moonshotai/kimi-k2-instruct"]);
/** Not chat models: speech, guards, embeddings. @param {string} id */
const groqChat = (id) => !/whisper|tts|orpheus|playai|guard|embed|distil|compound/i.test(id);

function createGroq(o) {
    const apiKey = o.apiKey || "";
    const model = o.model || "llama-3.3-70b-versatile";
    /** the model actually asked: GROQ_MODEL, or a served replacement when Groq has retired it */
    let active = model;
    const base = (o.baseUrl || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
    const now = o.now || (() => Date.now());
    const dailyMax = o.dailyMax ?? 500;
    const up = createUpstream({ name: "groq", fetchImpl: o.fetchImpl, now, failuresToOpen: 4 });
    const auth = { authorization: `Bearer ${apiKey}` };
    let day = "", used = 0;
    /** @type {{ at: number, ok: boolean, hasModel: boolean|null, error: string, served: string[] }} */ let health = { at: -Infinity, ok: false, hasModel: null, error: "", served: [] };

    /** The served model to use: GROQ_MODEL if served, else a preferred one, else any chat model. @param {string[]} ids */
    function pick(ids) {
        if (ids.includes(model)) return model;
        return GROQ_PREFERRED.find((m) => ids.includes(m)) || ids.filter(groqChat).sort()[0] || model;
    }

    /** Is the key accepted, is GROQ_MODEL still served, and which model to ask? Cached 10 min. */
    async function check() {
        if (!apiKey) return { ok: false, hasModel: null, error: "no GROQ_API_KEY", served: [] };
        if (now() - health.at < 600000) return health;
        try {
            const j = await up.json(`${base}/models`, { headers: auth }, { timeoutMs: 4000, retries: 0 });
            const ids = (Array.isArray(j && j.data) ? j.data : []).map((/** @type {any} */ m) => String(m && m.id)).filter(Boolean);
            health = { at: now(), ok: true, hasModel: ids.includes(model), error: "", served: ids.filter(groqChat).sort().slice(0, 20) };
            if (ids.length) active = pick(ids);
        } catch (e) { health = { at: now(), ok: false, hasModel: null, error: String(/** @type {any} */ (e).code || "ERROR"), served: health.served }; }
        return health;
    }

    /** @param {any} body @param {number} timeoutMs */
    const call = (body, timeoutMs) => up.json(`${base}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body)
    }, { timeoutMs, retries: 0 });

    return {
        name: "groq",
        configured: () => Boolean(apiKey),
        available() {
            const d = utcDay(now());
            if (d !== day) { day = d; used = 0; }
            return Boolean(apiKey) && used < dailyMax && !up.state().open;
        },
        liveWeb: () => false,
        check,
        /**
         * @param {{ system: string, prompt: string, schema?: any, timeoutMs: number, maxTokens?: number }} q
         */
        async generate(q) {
            used++;
            const t0 = now();
            if (health.at === -Infinity) await check().catch(() => null);      // the model list, once, if start-up didn't get it
            const body = {
                model: active, temperature: 0.3, max_tokens: q.maxTokens || 1200,
                messages: [{ role: "system", content: q.system }, { role: "user", content: q.prompt }],
                ...(q.schema ? { response_format: { type: "json_object" } } : {})
            };
            let j;
            try { j = await call(body, q.timeoutMs); }
            catch (err) {
                const e = /** @type {any} */ (err);
                // the model was retired since the last list (404, or 400 model_decommissioned / model_not_found):
                // ask for the list now (at most once a minute: a model without JSON mode answers 400 too) and
                // try once on a model that's served
                if ((e.status === 404 || e.status === 400) && health.at > -Infinity && now() - health.at >= 60000) {
                    const was = active;
                    health.at = -Infinity;
                    await check().catch(() => null);
                    if (active !== was) { body.model = active; j = await call(body, Math.max(1000, q.timeoutMs - (now() - t0))); }
                }
                if (!j) {
                    // a model without JSON mode answers 400 to response_format: ask once more without it
                    // (the caller's accept() still checks the reply is our JSON)
                    if (!(q.schema && e.status === 400)) throw err;
                    const { response_format: _drop, ...plain } = body;
                    j = await call(plain, Math.max(1000, q.timeoutMs - (now() - t0)));
                }
            }
            const msg = j && Array.isArray(j.choices) && j.choices[0] ? j.choices[0].message : null;
            const text = stripThink(msg && msg.content);
            if (!text) throw fail("groq: empty answer", "EMPTY");
            return { text, sources: [], grounded: false, model: active };
        },
        stats: () => ({ model: active, configuredModel: model, baseUrl: base, usedToday: used, dailyMax, health: { ok: health.ok, hasModel: health.hasModel, error: health.error, served: health.served }, upstream: up.state() })
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
 * @param {{ url?: string, model?: string, fetchImpl?: typeof fetch, now?: () => number, keepAlive?: string }} o
 */
function createOllama(o) {
    const url = (o.url || "http://127.0.0.1:11434").replace(/\/+$/, "");
    const model = o.model || "llama3.2:3b";
    const now = o.now || (() => Date.now());
    const up = createUpstream({ name: "ollama", fetchImpl: o.fetchImpl, now, failuresToOpen: 3, openMs: 15000 });
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
        /** Not known to be down: false once a health check found it not running (the server checks at start-up). */
        likely: () => health.at === -Infinity || health.up,
        liveWeb: () => false,
        /**
         * @param {{ system: string, prompt: string, schema?: any, timeoutMs: number, maxTokens?: number }} q
         */
        async generate(q) {
            const h = await check();
            if (!h.up) throw fail("ollama: not running", "UNREACHABLE");
            if (!h.hasModel) throw fail(`ollama: model ${model} not pulled (ollama pull ${model})`, "NO_MODEL");
            const t0 = now();
            const j = await up.json(`${url}/api/chat`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    model, stream: false, keep_alive: o.keepAlive || "30m",
                    ...(q.schema ? { format: q.schema } : {}),
                    options: { temperature: 0.3, num_ctx: 4096, num_predict: q.maxTokens || 700 },
                    messages: [{ role: "system", content: q.system }, { role: "user", content: q.prompt }]
                })
            }, { timeoutMs: Math.max(1000, q.timeoutMs - (now() - t0)), retries: 0 });
            const text = stripThink(j && j.message && j.message.content);
            if (!text) throw fail("ollama: empty answer", "EMPTY");
            return { text, sources: [], grounded: false, model };
        },
        stats: () => ({ url, model, health: { up: health.up, hasModel: health.hasModel, models: health.models }, upstream: up.state() })
    };
}

const ENGINE_NAMES = Object.freeze(["gemini", "groq", "ollama"]);

/**
 * @param {{ order?: string[], gemini?: ReturnType<typeof createGemini>, groq?: ReturnType<typeof createGroq>, ollama?: ReturnType<typeof createOllama>,
 *   retrieval?: ReturnType<typeof createWikipedia>|null, now?: () => number, log?: { warn: Function } }} o
 */
function createEngines(o) {
    const now = o.now || (() => Date.now());
    const log = o.log || console;
    /** @type {Record<string, any>} */ const byName = { gemini: o.gemini, groq: o.groq, ollama: o.ollama };
    const order = (o.order && o.order.length ? o.order : ["gemini", "groq", "ollama"]).filter((n) => byName[n]);
    /** @type {Record<string, number>} */ const served = { gemini: 0, groq: 0, ollama: 0 };
    let fallbacks = 0;
    const wiki = o.retrieval || null;

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
        // Wikipedia notes for engines without live web: fetched at most once per question, on first need
        /** @type {Promise<Array<{ title: string, url: string, text: string }>>|null} */ let docsP = null;
        const docs = () => (docsP ||= (q.wantWeb && wiki ? wiki.search(q.webQuery || q.prompt, 4000).catch(() => []) : Promise.resolve([])));
        for (let i = 0; i < order.length; i++) {
            const name = order[i];
            const e = byName[name];
            if (!e.configured()) { tried.push({ engine: name, error: "not-configured" }); continue; }
            if (!e.available()) { tried.push({ engine: name, error: "unavailable" }); continue; }
            const left = deadline - now();
            // leave the local model enough time: a cold model load on a 3050 takes several seconds
            if (left < (name === "ollama" ? 8000 : 4000)) { tried.push({ engine: name, error: "no-time-left" }); continue; }
            try {
                const live = Boolean(q.wantWeb) && e.liveWeb();
                /** @type {Array<{ title: string, url: string, text: string }>} */ const notes = live ? [] : await docs();
                const prompt = live ? q.prompt : `${q.prompt}${offlineNotes(notes)}`;
                // an engine with a fallback after it doesn't get the whole budget: keep ~12 s for the next one
                // (not counting one known to be down: on Render, Ollama isn't running, and Gemini needs the time)
                const hasNext = order.slice(i + 1).some((n) => byName[n].configured() && byName[n].available() && (typeof byName[n].likely !== "function" || byName[n].likely()));
                const leftNow = deadline - now();
                const timeoutMs = hasNext ? Math.max(6000, Math.min(25000, leftNow - 12000)) : leftNow;
                const r = await e.generate({ ...q, prompt, timeoutMs });
                if (r.modelFallbacks) log.warn(`[master] ${name} answered on ${r.model} after: ${r.modelFallbacks.join(", ")}`);
                if (q.accept && !q.accept(r.text)) throw fail(`${name}: unusable answer`, "UNUSABLE");
                served[name]++;
                if (tried.length) fallbacks++;
                // live: the engine searched the web itself (Gemini with Google Search); otherwise the
                // answer stands on the model's knowledge plus the Wikipedia notes, if any
                const result = live ? { ...r, live: true } : { ...r, live: false, sources: notes.map((d) => ({ title: d.title, url: d.url })), grounded: notes.length > 0 };
                return { ok: true, engine: name, ...result, ms: now() - t0, tried };
            } catch (err) {
                const code = /** @type {any} */ (err).code || "ERROR";
                tried.push({ engine: name, error: code });
                log.warn(`[master] ${name} failed (${code}): ${/** @type {any} */ (err).message}`);
                // Gemini's Search quota is gone, not Gemini: ask it again, this time without Search
                if (code === "GROUNDING_QUOTA") i--;
            }
        }
        return { ok: false, engine: null, text: "", sources: [], grounded: false, live: false, ms: now() - t0, tried };
    }

    return {
        reason, order,
        configured: () => order.some((n) => byName[n].configured()),
        /** Live readiness of each engine (Ollama and Groq are actually asked). */
        async health() {
            /** @type {Record<string, any>} */ const out = { order };
            if (o.gemini) out.gemini = { configured: o.gemini.configured(), available: o.gemini.available(), model: o.gemini.stats().model, models: o.gemini.stats().models, grounding: o.gemini.stats().grounding };
            if (o.groq) {
                const h = await o.groq.check();
                const st = o.groq.stats();
                // hasModel: is the model we'll actually ask served (GROQ_MODEL, or the replacement picked for it)
                out.groq = { configured: o.groq.configured(), available: o.groq.available(), model: st.model, configuredModel: st.configuredModel, reachable: h.ok,
                    hasModel: h.ok ? (h.served || []).includes(st.model) || h.hasModel === true : null, configuredServed: h.hasModel, served: h.served, error: h.error || undefined };
            }
            if (o.ollama) { const h = await o.ollama.check(); out.ollama = { up: h.up, hasModel: h.hasModel, model: o.ollama.stats().model, models: h.models }; }
            const ready = {
                gemini: () => out.gemini && out.gemini.available,
                groq: () => out.groq && out.groq.available && out.groq.reachable && out.groq.hasModel !== false,
                ollama: () => out.ollama && out.ollama.up && out.ollama.hasModel
            };
            out.ready = order.some((n) => Boolean(ready[/** @type {"gemini"|"groq"|"ollama"} */ (n)]()));
            out.retrieval = wiki ? "wikipedia" : "none";
            return out;
        },
        stats: () => ({ order, served, fallbacks, retrieval: wiki ? "wikipedia" : "none", gemini: o.gemini ? o.gemini.stats() : null, groq: o.groq ? o.groq.stats() : null, ollama: o.ollama ? o.ollama.stats() : null })
    };
}

/** Engines from the environment. @param {Record<string, string|undefined>} env @param {{ fetchImpl?: typeof fetch, now?: () => number, log?: { warn: Function } }} [o] */
function enginesFromEnv(env, o = {}) {
    const order = String(env.MASTER_LLM_ORDER || "gemini,groq,ollama").split(",").map((s) => s.trim().toLowerCase()).filter((s, i, a) => ENGINE_NAMES.includes(s) && a.indexOf(s) === i);
    const gemini = createGemini({ apiKey: env.GEMINI_API_KEY || "", model: env.GEMINI_MODEL || undefined, dailyMax: Number(env.GEMINI_DAILY_MAX) || 200,
        grounding: String(env.GEMINI_GROUNDING || "").toLowerCase() === "auto" ? "auto" : "off",
        thinking: String(env.GEMINI_THINKING || "").toLowerCase() === "model" ? "model" : "low", fetchImpl: o.fetchImpl, now: o.now });
    const groq = createGroq({ apiKey: env.GROQ_API_KEY || "", model: env.GROQ_MODEL || undefined, baseUrl: env.GROQ_BASE_URL || undefined,
        dailyMax: Number(env.GROQ_DAILY_MAX) || 500, fetchImpl: o.fetchImpl, now: o.now });
    const ollama = env.OLLAMA_DISABLED === "1" ? undefined : createOllama({ url: env.OLLAMA_URL || undefined, model: env.OLLAMA_MODEL || undefined, fetchImpl: o.fetchImpl, now: o.now, keepAlive: env.OLLAMA_KEEP_ALIVE || undefined });
    const retrievalSetting = String(env.MASTER_RETRIEVAL || env.OLLAMA_RETRIEVAL || "wikipedia").toLowerCase();
    const retrieval = retrievalSetting === "none" ? null : createWikipedia({ fetchImpl: o.fetchImpl, now: o.now });
    return createEngines({ order, gemini, groq, ollama, retrieval, now: o.now, log: o.log });
}

module.exports = { GEMINI_MODELS, GROQ_PREFERRED, createGemini, createGroq, createOllama, createWikipedia, createEngines, enginesFromEnv, stripThink, offlineNotes };
