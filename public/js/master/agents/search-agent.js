// @ts-check
/* ============================================================================
   MapUnite Master AI — Deep Search agent ("deep-search")
   ==============================================================================
   The Master delegates questions it can't answer from what the agents know:
     MUMaster.live.delegate("deep-search", { query }, { timeoutMs: 60000 })
     → { ok, result: { spoken, title, summary, bullets, sources, confidence, cached } }

   The research itself runs on our server (/api/master/search, lib/master/search.js
   + llm.js), on a chain of free engines: Google Gemini (free tier, without
   Google Search unless GEMINI_GROUNDING=auto), then Groq (free tier), then a
   LOCAL model through Ollama on the server's own GPU. Either way the answer has
   the same shape; result.engine ("gemini" | "groq" | "ollama"), result.grounded
   (sources were read) and result.live (the web was searched just now) say which.
   This agent adds what only the phone knows, as CONTEXT for the answer:
   roughly where the rider is (2 decimals ≈ 1 km), the place name, riding or
   stopped, the bike, the destination, local time, the voice's style (desi /
   plain), and the LIVE facts the other agents already have: the weather at
   the rider and in the 2 km ahead (state.weather) and the best places nearby
   (state.poi). That lets even the offline local model answer "kahan rukein?"
   or "aage baarish hai kya?" from real data. Nothing else is sent.

   OFFLINE: the question is kept (up to 3, for 30 min) and answered when the
   network agent says the network is back; the answer then comes as
   search.answer (advice: "Bhai, ek baat bolun?" first, like any tip).

   Answers are kept in state.answer = { at, query, title, summary, bullets, sources }
   so the screen can show the full answer and sources when the rider stops.
   ============================================================================ */
(function (root, factory) {
    const def = factory();
    if (typeof module === "object" && module.exports) module.exports = def;
    else {
        const M = /** @type {any} */ (root).MUMaster || (/** @type {any} */ (root).MUMaster = {});
        if (typeof M.define === "function") M.define(def); else (M._pending || (M._pending = [])).push(def);
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    return {
        id: "deep-search",
        version: "1.0.0",
        apiVersion: 1,
        description: "Researches questions on the web (through our server) and answers in the Master's voice.",
        requires: ["master-api"],
        optional: ["location", "app-context"],
        defaults: { timeoutMs: 55000, maxPending: 3, pendingTtlMs: 1800000 },

        /** @param {any} ctx */
        start(ctx) {
            const cfg = ctx.config;
            const api = ctx.caps.get("master-api");
            const loc = ctx.caps.get("location");
            const app = ctx.caps.get("app-context");
            /** @type {Array<{ query: string, at: number }>} */ const pending = [];

            function context() {
                const f = loc ? loc.current() : null;
                const snap = app ? app.snapshot() : null;
                const ride = ctx.bus.last("state.ride");
                const persona = ctx.bus.last("state.persona");
                /** @type {Record<string, any>} */ const c = {
                    riding: Boolean(ride && ride.active && (ride.speedMs || 0) > 2),
                    style: persona && persona.style === "plain" ? "plain" : "desi",
                    localTime: new Date().toLocaleString("en-IN", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: true })
                };
                if (f && Number.isFinite(f.lat)) { c.lat = Math.round(f.lat * 100) / 100; c.lng = Math.round(f.lng * 100) / 100; }
                // live facts the agents already hold (small, no history)
                /** @type {Record<string, any>} */ const live = {};
                const wx = ctx.bus.last("state.weather");
                if (wx && wx.here) live.weather = { tempC: wx.here.tempC, feelsC: wx.here.feelsC, rhPct: wx.here.rhPct, hazards: (wx.hazards || []).slice(0, 4).map((/** @type {any} */ h) => ({ type: h.type, distanceM: h.distanceM })) };
                const poi = ctx.bus.last("state.poi");
                if (poi && poi.best) live.nearby = Object.values(poi.best).filter(Boolean).slice(0, 5).map((/** @type {any} */ p) => ({ category: p.category, name: p.name, distanceM: p.distanceM, tier: p.tier }));
                if (Object.keys(live).length) c.live = live;
                if (snap) {
                    if (snap.place) c.place = snap.place;
                    if (snap.bike) c.bike = snap.bike.title;
                    if (snap.destination && snap.destination.name) c.destination = snap.destination.name;
                }
                return c;
            }

            /** @param {string} query */
            async function ask(query) {
                const r = await api.post("/search", { query, context: context() }, { timeoutMs: cfg.timeoutMs, signal: ctx.signal });
                if (!r.ok) {
                    const err = new Error(r.reason || `http-${r.status}`);
                    /** @type {any} */ (err).code = r.reason === "offline" ? "OFFLINE" : r.status === 503 ? "NOT_CONFIGURED" : r.status === 429 ? "BUDGET" : "FAILED";
                    throw err;
                }
                const a = r.data.answer || {};
                const result = { spoken: a.spoken || "", title: a.title || "Answer", summary: a.summary || "", bullets: a.bullets || [], confidence: a.confidence ?? 0.5, sources: r.data.sources || [], cached: Boolean(r.data.cached), engine: r.data.engine || null, grounded: Boolean(r.data.grounded), live: Boolean(r.data.live) };
                ctx.setState("answer", { at: ctx.now(), query, ...result });
                return result;
            }

            ctx.bus.handle("task.deep-search", async (/** @type {any} */ payload) => {
                const query = String((payload && payload.query) || "").trim().slice(0, 500);
                if (query.length < 3) throw Object.assign(new Error("empty question"), { code: "BAD_QUERY" });
                try { return await ask(query); }
                catch (e) {
                    if (/** @type {any} */ (e).code === "OFFLINE" && pending.length < cfg.maxPending) pending.push({ query, at: ctx.now() });
                    throw e;
                }
            });

            // network back: answer what was asked offline
            ctx.bus.subscribe("state.network", async (/** @type {any} */ n) => {
                if (!n || n.level !== "good" || !pending.length) return;
                const jobs = pending.splice(0).filter((p) => ctx.now() - p.at < cfg.pendingTtlMs);
                for (const j of jobs) {
                    try {
                        const a = await ask(j.query);
                        ctx.report("search.answer", { severity: "advice", key: `search.${j.at}`, category: "search", text: a.spoken, data: { query: j.query, screen: { title: a.title, sub: a.summary.slice(0, 140) } }, ttlMs: 600000 });
                    } catch (e) {
                        ctx.report("search.failed", { severity: "advice", key: "search.failed", category: "search", data: { query: j.query } });
                    }
                }
            });
        }
    };
});
