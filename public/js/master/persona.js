// @ts-check
/* ============================================================================
   MapUnite Master AI — the persona (how the Master talks)
   ==============================================================================
   Agents report facts ("network.lost", { navigating: true }). The persona turns
   a report into words: a spoken line plus a short on-screen title and subtitle.
   Words live in phrase packs (phrases-desi.js), not in agents, so:

     - the voice can change (desi Hinglish ↔ plain English) in one setting;
     - a writer can add or tune lines without touching any logic;
     - a new agent ships its own pack with persona.addPhrases(…).

   PACK FORMAT
     { "network.lost": {
         warning: [ { say: "Network gaya bhai! …", title: "No signal", sub: "Navigation works offline" }, … ],
         advice:  [ … ],
         any:     [ … ]                    // used when no list for that severity
     } }
   Templates use {{name}}, {{data.field}} or {{field}} (report.data first,
   then world values), with optional filters: {{distanceM|km}},
   {{ridingSec|min}}, {{value|round}}. A line whose placeholders can't all be
   filled is skipped; if none fits, the generic "*" lines of that severity are
   used, then report.text.

   LANGUAGE: the spoken line follows the voice's style (desi Hinglish by
   default); everything on SCREEN (status island titles and subtitles) is
   always plain English, taken from the plain pack for the same report.

   RULES THAT KEEP IT SAFE
     - Critical lines are short (≤ 140 characters spoken) and say what to do.
     - Lines rotate: the same report never repeats the line it used last time.
     - An agent's own report.text, if given, is used as-is.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); (W.MUMaster || (W.MUMaster = {})).persona = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const CRITICAL_MAX = 140;

    /** Spoken numbers, in the register of each style. */
    const FILTERS = {
        /** metres → "800 metre" / "1.5 km" (desi) or "800 metres" / "1.5 kilometres" (plain) */
        km: (/** @type {any} */ v, /** @type {string} */ style) => {
            const m = Number(v);
            if (!Number.isFinite(m)) return null;
            if (m < 1000) { const r = Math.max(50, Math.round(m / 50) * 50); return style === "plain" ? `${r} metres` : `${r} metre`; }
            const km = m / 1000;
            const s = km >= 10 ? String(Math.round(km)) : km.toFixed(1).replace(/\.0$/, "");
            return style === "plain" ? `${s} kilometres` : `${s} km`;
        },
        /** seconds → "1 ghante 30 minute" (desi, oblique) or "1 hour 30 minutes" (plain) */
        min: (/** @type {any} */ v, /** @type {string} */ style) => {
            const s = Number(v);
            if (!Number.isFinite(s)) return null;
            const total = Math.max(1, Math.round(s / 60));
            const h = Math.floor(total / 60), m = total % 60;
            if (style === "plain") {
                const hs = h ? `${h} hour${h === 1 ? "" : "s"}` : "", ms = m ? `${m} minute${m === 1 ? "" : "s"}` : "";
                return [hs, ms].filter(Boolean).join(" ");
            }
            // oblique form ("2 ghante se", "1 ghante 30 minute se"): the packs use these with "se"
            const hs = h ? `${h} ghante` : "", ms = m ? `${m} minute` : "";
            return [hs, ms].filter(Boolean).join(" ");
        },
        round: (/** @type {any} */ v) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : null)
    };

    /**
     * @param {{ style?: "desi"|"plain", name?: string, rng?: () => number }} [opts]
     */
    function createPersona(opts = {}) {
        let style = opts.style === "plain" ? "plain" : "desi";
        let name = typeof opts.name === "string" ? opts.name.trim() : "";
        const rng = opts.rng || Math.random;
        /** @type {Record<string, Record<string, Record<string, any[]>>>} */
        const books = { desi: {}, plain: {} };
        /** @type {Map<string, string>} last line used per report key */
        const lastUsed = new Map();

        /**
         * Add or extend lines. Lists are appended, so packs from several agents merge.
         * @param {"desi"|"plain"} styleName
         * @param {Record<string, Record<string, any[]>>} pack
         */
        function addPhrases(styleName, pack) {
            const book = books[styleName] || (books[styleName] = {});
            for (const [kind, bySeverity] of Object.entries(pack || {})) {
                const entry = book[kind] || (book[kind] = {});
                for (const [sev, list] of Object.entries(bySeverity || {})) {
                    entry[sev] = [...(entry[sev] || []), ...list.map((x) => (typeof x === "string" ? { say: x } : x)).filter((x) => x && typeof x.say === "string")];
                }
            }
        }

        /** @param {string} tpl @param {Record<string, any>} vars @param {string} [st] style for the filters @returns {string|null} null if a placeholder is missing */
        function render(tpl, vars, st = style) {
            let missing = false;
            const out = String(tpl).replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|\s*([a-z]+))?\s*\}\}/g, (_m, path, filter) => {
                let v = path.split(".").reduce((/** @type {any} */ o, /** @type {string} */ k) => (o == null ? undefined : o[k]), vars);
                if (v == null || v === "") { missing = true; return ""; }
                if (filter) {
                    const f = /** @type {any} */ (FILTERS)[filter];
                    v = f ? f(v, st) : v;
                    if (v == null) { missing = true; return ""; }
                }
                return String(v);
            });
            if (missing) return null;
            const clean = out.replace(/\s+/g, " ").trim();
            return clean.charAt(0).toUpperCase() + clean.slice(1);       // "{{name}}, …" starts a sentence
        }

        /** @param {any[]} list @param {string} key @param {Record<string, any>} vars @param {string} [st] */
        function pick(list, key, vars, st = style) {
            if (!list || !list.length) return null;
            const start = Math.floor(rng() * list.length);
            const prev = lastUsed.get(key);
            /** @type {any} */ let fallback = null;
            for (let i = 0; i < list.length; i++) {
                const e = list[(start + i) % list.length];
                const say = render(e.say, vars, st);
                if (say === null) continue;
                const line = { say, title: e.title ? render(e.title, vars, st) : null, sub: e.sub ? render(e.sub, vars, st) : null, icon: e.icon || null, entry: e };
                if (list.length > 1 && e.say === prev) { fallback = fallback || { line, raw: e.say }; continue; }
                lastUsed.set(key, e.say);
                return line;
            }
            if (fallback) { lastUsed.set(key, fallback.raw); return fallback.line; }
            return null;
        }

        /** Screen titles are always English. */
        const GENERIC_TITLE = { critical: "Careful!", warning: "Heads up", advice: "Tip", info: "Update" };

        /**
         * Words for one report: the SPOKEN line in the voice's style (desi Hinglish or plain
         * English), and the SCREEN title and subtitle, always in plain English.
         *   report.data.screen = { …English values } overrides template values on screen only
         *   (e.g. { detail: "eyes closed for 1.3 seconds" } next to a Hinglish data.detail),
         *   and { title, sub } give the screen words for an agent's own report.text.
         * @param {{ kind: string, key: string, severity: "critical"|"warning"|"advice"|"info", data?: Record<string, any>, text?: string|null }} report
         * @param {Record<string, any>} [world] shared state (state.* values by name)
         * @returns {{ text: string, display: { title: string, sub: string, icon: string|null }, style: string, source: "agent"|"pack"|"generic"|"none" }}
         */
        function phrase(report, world = {}) {
            const sev = report.severity;
            const data = report.data || {};
            const screenData = data.screen && typeof data.screen === "object" ? data.screen : {};
            const screenVars = { name: "", ...world, ...data, ...screenData, data };
            // English lines (plain style, or a desi kind with no Hinglish lines yet) use the English values too
            const varsFor = (/** @type {string} */ st) => (st === "plain" ? { ...screenVars, name } : { name: name || "bhai", ...world, ...data, data });
            const clip = (/** @type {string} */ s) => (sev === "critical" && s.length > CRITICAL_MAX ? `${s.slice(0, CRITICAL_MAX - 1).replace(/\s+\S*$/, "")}.` : s);

            // ---- spoken
            /** @type {any} */ let spoken = null;
            let source = /** @type {"agent"|"pack"|"generic"|"none"} */ ("none"), spokenStyle = style;
            if (report.text) { spoken = { say: report.text }; source = "agent"; }
            const order = style === "plain" ? ["plain"] : ["desi", "plain"];
            for (const st of order) {
                if (spoken) break;
                const entry = books[st] && books[st][report.kind];
                if (!entry) continue;
                const line = pick(entry[sev], `${st}:${report.key}:${sev}`, varsFor(st), st) || pick(entry.any, `${st}:${report.key}:any`, varsFor(st), st);
                if (line) { spoken = line; source = "pack"; spokenStyle = st; }
            }
            for (const st of order) {
                if (spoken) break;
                const generic = books[st] && books[st]["*"];
                const line = generic && pick(generic[sev], `${st}:*:${sev}`, varsFor(st), st);
                if (line) { spoken = line; source = "generic"; spokenStyle = st; }
            }

            // ---- screen (English): the spoken line itself when it was English, else the plain pack
            /** @type {{ title: string|null, sub: string|null, icon: string|null }} */
            let screen = { title: screenData.title || null, sub: screenData.sub || null, icon: null };
            if (!screen.sub) {
                if (spoken && spokenStyle === "plain" && source !== "agent") {
                    // the same English line that was spoken, rendered with the screen's values
                    const e = spoken.entry;
                    screen = { title: screen.title || (e.title ? render(e.title, screenVars, "plain") : null), sub: render(e.sub || e.say, screenVars, "plain") || spoken.sub || spoken.say, icon: spoken.icon };
                }
                else if (source === "agent" && style === "plain") screen.sub = report.text || null;
                else {
                    const entry = books.plain[report.kind] || (source === "agent" ? null : books.plain["*"]);
                    const list = entry ? (entry[sev] || entry.any) : null;
                    const line = list && pick(list, `screen:${report.kind}:${sev}`, screenVars, "plain");
                    if (line) screen = { title: screen.title || line.title, sub: line.sub || line.say, icon: line.icon };
                }
            }
            const display = { title: screen.title || GENERIC_TITLE[sev] || "", sub: screen.sub || "", icon: screen.icon || (spoken && spoken.icon) || null };
            return { text: spoken ? clip(spoken.say) : "", display, style: spokenStyle, source };
        }

        return {
            addPhrases, phrase, render,
            /** @param {"desi"|"plain"} s */ setStyle(s) { style = s === "plain" ? "plain" : "desi"; },
            /** @param {string} n */ setName(n) { name = typeof n === "string" ? n.trim().slice(0, 30) : ""; },
            get style() { return style; },
            get name() { return name; },
            /** Kinds that have lines, per style (for tooling and tests). */
            kinds() { return { desi: Object.keys(books.desi), plain: Object.keys(books.plain) }; }
        };
    }

    return { createPersona, FILTERS, CRITICAL_MAX };
});
