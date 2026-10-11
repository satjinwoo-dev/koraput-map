// @ts-check
/* ============================================================================
   MapUnite Master AI — cognition: learning, affect and reasoning policies
   ==============================================================================
   The brain (brain.js) runs every report through pluggable POLICIES. This file
   adds three that make the Master learn and reason instead of just relaying:

   1. INTEREST (continuous learning, order 45)
      Every tip that asked first ("Bhai, ek baat bolun?") ends as yes / no /
      silence (master.decision). Per category ("food", "music", "weather" …)
      the rider's acceptance is a Beta(α, β) posterior, prior Beta(2, 1)
      (we assume tips are welcome until shown otherwise). Evidence fades with a
      14-day half-life, so a phase ("no music tips this week") doesn't last
      forever. Once there is ≥ 6 answers of evidence and the mean acceptance is
      below 0.2, ADVICE in that category is dropped, except one exploratory tip
      every 6 h, so the model can notice the rider changed their mind.
      Warnings and critical reports are never touched by learning.
      Persisted on the phone only (store namespace "cognition").

   2. AFFECT (order 46)
      state.affect (agents/context-agent.js) carries irritation (from what the
      rider says to the app: "chup", "bas kar", "mat bol" …) and stress (hard
      braking, jams, night, rain). Irritation ≥ 0.6 or stress ≥ 0.75 → advice
      waits; safety still speaks.

   3. FUSION (reasoning, order 47)
      Some hazards are much worse together than apart. When two related
      reports arrive within 90 s, both about the next ~2 km (weather also counts
      when it's only in state.weather: rain already here isn't re-reported), the
      second one becomes ONE compound warning ("aage ghat bhi hai aur baarish bhi"):
        wet road (rain, heavy rain, drizzle, storm)  × ghat / hairpins / blackspot / bridge / level crossing
        fog                                           × blackspot / hairpins / ghat / level crossing
        strong wind                                   × bridge / ghat
        night (state.light = "dark")                  × blackspot / hairpins
      Rules are data (RULES below): explainable, testable, no black box.
      A pair is fused at most once per 10 min.

   install({ brain, bus, store, now, words }) → { interest(category), snapshot(), forget() }
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); (W.MUMaster || (W.MUMaster = {})).cognition = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const PRIOR = Object.freeze({ a: 2, b: 1 });
    const HALF_LIFE_MS = 14 * 86400000;
    const MIN_EVIDENCE = 6, DROP_BELOW = 0.2, EXPLORE_MS = 6 * 3600000;

    const WET = ["weather.rain", "weather.heavy-rain", "weather.drizzle", "weather.storm"];
    /** [groupA kinds, groupB kinds] — either order */
    const RULES = Object.freeze([
        { id: "wet-road", a: WET, b: ["terrain.ghat-ahead", "terrain.hairpins", "blackspot.ahead", "road.bridge-ahead", "road.level-crossing"] },
        { id: "fog", a: ["weather.fog"], b: ["blackspot.ahead", "terrain.hairpins", "terrain.ghat-ahead", "road.level-crossing"] },
        { id: "wind", a: ["weather.wind"], b: ["road.bridge-ahead", "terrain.ghat-ahead"] },
        { id: "night", a: ["light.dark"], b: ["blackspot.ahead", "terrain.hairpins"] }
    ]);
    /** words for the compound line: kind → [desi, plain] */
    const NAMES = Object.freeze({
        "weather.rain": ["baarish", "Rain"], "weather.heavy-rain": ["tez baarish", "Heavy rain"], "weather.drizzle": ["boonda-baandi", "Drizzle"],
        "weather.storm": ["toofan", "Storm"], "weather.fog": ["kohra", "Fog"], "weather.wind": ["tez hawa", "Strong wind"],
        "terrain.ghat-ahead": ["ghat", "Ghat"], "terrain.hairpins": ["hairpin mod", "Hairpins"], "blackspot.ahead": ["accident blackspot", "Blackspot"],
        "road.bridge-ahead": ["lamba pul", "Bridge"], "road.level-crossing": ["railway crossing", "Rail crossing"], "light.dark": ["andhera", "Darkness"]
    });

    /**
     * @param {{ brain: any, bus: any, store?: any, now?: () => number, windowMs?: number }} o
     */
    function install(o) {
        const { brain, bus } = o;
        const now = o.now || (() => Date.now());
        const store = o.store || null;
        const windowMs = o.windowMs ?? 90000;
        /** @type {Record<string, { a: number, b: number, at: number, lastExplore: number }>} */
        const beliefs = (store && store.get("beliefs", null)) || {};
        /** @type {Map<string, string>} report id → category, for asks still waiting for an answer */
        const asked = new Map();
        /** @type {Array<{ kind: string, at: number, distanceM: number }>} */ const recent = [];
        /** @type {Map<string, number>} */ const fused = new Map();
        const unsubs = [];

        const save = () => { try { store && store.set("beliefs", beliefs); } catch (e) { /* storage full */ } };
        function decayed(/** @type {string} */ cat) {
            const b = beliefs[cat] || { a: PRIOR.a, b: PRIOR.b, at: now(), lastExplore: 0 };
            const k = Math.pow(0.5, Math.max(0, now() - b.at) / HALF_LIFE_MS);
            return { a: PRIOR.a + (b.a - PRIOR.a) * k, b: PRIOR.b + (b.b - PRIOR.b) * k, at: now(), lastExplore: b.lastExplore || 0 };
        }
        /** @param {string} cat @param {number} accept 0..1 */
        function learn(cat, accept) {
            const b = decayed(cat);
            b.a += accept; b.b += 1 - accept;
            beliefs[cat] = b;
            save();
            bus.publish("state.cognition", snapshot(), { source: "master", sticky: true });
        }
        /** @param {string} cat */
        function interest(cat) {
            const b = decayed(cat);
            return { mean: b.a / (b.a + b.b), evidence: b.a + b.b - PRIOR.a - PRIOR.b };
        }
        function snapshot() {
            /** @type {Record<string, { mean: number, evidence: number }>} */ const out = {};
            for (const cat of Object.keys(beliefs)) { const i = interest(cat); out[cat] = { mean: Math.round(i.mean * 100) / 100, evidence: Math.round(i.evidence * 10) / 10 }; }
            return { interests: out };
        }

        // ---- learning from answers
        // brain decisions carry the report's id and kind, not its category: remember it from the report itself
        /** @type {Map<string, string>} "source:kind" → category of the latest such report */ const lastCategory = new Map();
        unsubs.push(bus.subscribe("report.**", (/** @type {any} */ r, /** @type {any} */ env) => {
            if (!r || typeof r.kind !== "string") return;
            lastCategory.set(`${env.source}:${r.kind}`, typeof r.category === "string" && r.category ? r.category : r.kind.split(".")[0]);
        }, { owner: "cognition", order: 10 }));
        unsubs.push(bus.subscribe("master.decision", (/** @type {any} */ d) => {
            if (!d || !d.id) return;
            if (d.action === "asking") { asked.set(d.id, lastCategory.get(`${d.source}:${d.kind}`) || String(d.kind || "").split(".")[0]); return; }
            const cat = asked.get(d.id);
            if (!cat) return;
            asked.delete(d.id);
            if (d.action === "spoken") learn(cat, 1);
            else if (d.action === "declined") learn(cat, 0);
            else if (d.action === "unanswered") learn(cat, 0.35);                 // silence: probably busy, mildly negative
        }, { owner: "cognition" }));

        // ---- 1. interest
        unsubs.push(brain.use("interest", (/** @type {any} */ r) => {
            if (r.severity !== "advice") return r;
            const i = interest(r.category);
            if (i.evidence < MIN_EVIDENCE || i.mean >= DROP_BELOW) return r;
            const b = beliefs[r.category];
            if (b && now() - (b.lastExplore || 0) >= EXPLORE_MS) { b.lastExplore = now(); save(); return r; }   // explore once in a while
            return { drop: `rider usually declines ${r.category} tips (${Math.round(i.mean * 100)}%)` };
        }, { order: 45 }));

        // ---- 2. affect
        unsubs.push(brain.use("affect", (/** @type {any} */ r, /** @type {any} */ api) => {
            if (r.severity !== "advice") return r;
            const a = api.world.affect;
            if (!a) return r;
            if (a.irritation >= 0.6) return { drop: "rider is irritated: advice waits" };
            if (a.stress >= 0.75) return { drop: "stressful moment: advice waits" };
            return r;
        }, { order: 46 }));

        // ---- 3. fusion
        unsubs.push(brain.use("fusion", (/** @type {any} */ r, /** @type {any} */ api) => {
            const t = now();
            for (let i = recent.length - 1; i >= 0; i--) if (t - recent[i].at > windowMs) recent.splice(i, 1);
            const dist = Number.isFinite(r.data && r.data.distanceM) ? r.data.distanceM : 0;
            if (r.kind === "radar.compound" || dist > 2000 || !(/** @type {any} */ (NAMES))[r.kind]) return r;
            const light = api.world.light;
            const others = [...recent];
            if (light === "dark") others.push({ kind: "light.dark", at: t, distanceM: 0 });
            // weather the rider is already in isn't always reported (the advice module speaks it): read the weather state too
            const wx = api.world.weather;
            if (wx && Array.isArray(wx.hazards)) for (const hz of wx.hazards) if (hz.distanceM <= 2000 && /** @type {any} */ (NAMES)[`weather.${hz.type}`]) others.push({ kind: `weather.${hz.type}`, at: t, distanceM: hz.distanceM });
            recent.push({ kind: r.kind, at: t, distanceM: dist });
            for (const rule of RULES) {
                const inA = rule.a.includes(r.kind), inB = rule.b.includes(r.kind);
                if (!inA && !inB) continue;
                const partner = others.find((x) => (inA ? rule.b : rule.a).includes(x.kind) && x.distanceM <= 2000);
                if (!partner) continue;
                const pairKey = `${rule.id}:${[r.kind, partner.kind].sort().join("+")}`;
                if (t - (fused.get(pairKey) || -Infinity) < 600000) return r;
                fused.set(pairKey, t);
                // hazard first, the condition that makes it worse second
                const [first, second] = inB ? [r.kind, partner.kind] : [partner.kind, r.kind];
                const N = /** @type {any} */ (NAMES);
                return {
                    kind: "radar.compound", severity: "warning", priority: Math.min(84, Math.max(r.priority, 70) + 5),
                    key: `radar.compound:${pairKey}`, category: "radar", ridingOnly: true, cooldownMs: 600000,
                    data: { first: N[first][0], second: N[second][0], distanceM: Math.max(100, Math.min(dist || 100, partner.distanceM || dist || 100)), rule: rule.id, screen: { first: N[first][1], second: N[second][1] } }
                };
            }
            return r;
        }, { order: 47 }));

        return {
            interest, snapshot,
            /** Forget everything learned (privacy: "Clear my history"). */
            forget() { for (const k of Object.keys(beliefs)) delete beliefs[k]; save(); },
            dispose() { for (const fn of unsubs.splice(0)) { try { fn(); } catch (e) { /* ignore */ } } }
        };
    }

    return { install, RULES, PRIOR };
});
