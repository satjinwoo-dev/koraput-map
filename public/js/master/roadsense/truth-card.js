// @ts-check
/* ============================================================================
   MapUnite RoadSense Live — the Route Truth Card on screen (route sheet)
   ==============================================================================
   Listens to "mu:master-truth" (state.truth from agents/truth-agent.js) and
   shows, under the route, what is KNOWN about the road and from what:

     ROAD TRUTH                                   [2 confirmed]  [🔊]
     2 confirmed, 1 unconfirmed on this route: 2 bumps or potholes.
     2.4 km  Pothole      Confirmed    You + 2 riders · motion sensor · 3 hours ago · 82%   until 30 Oct
     5.1 km  Rough road   Unconfirmed  1 rider · motion sensor · yesterday · 41%
     This phone's sensors and other riders' reports, updated 5 min ago.
     No report doesn't mean the road is clear.

   Nothing on the route → "Condition unknown", never "clear". 🔊 says the same
   card through the Master's fixed phrases (MUMaster.live.roadTruth).

   viewModel(state, now) is pure (tested in Node); mount() draws it with
   textContent only (no HTML from data).
   ============================================================================ */
(function (root, factory) {
    const lib = factory();
    if (typeof module === "object" && module.exports) module.exports = lib;
    else {
        const W = /** @type {any} */ (root);
        (W.MUMaster || (W.MUMaster = {})).truthCard = lib;
        if (W.document) {
            if (W.document.readyState === "loading") W.document.addEventListener("DOMContentLoaded", () => lib.mount(W));
            else lib.mount(W);
        }
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const ROWS_COMPACT = 2, ROWS_FULL = 5;

    /** "800 m" / "2.4 km" / "24 km" @param {number} m */
    function distance(m) {
        if (!Number.isFinite(m)) return "";
        if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
        return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
    }
    /** "just now" / "5 min ago" / "3 h ago" / "2 days ago" @param {number} ms */
    function since(ms) {
        const m = Math.max(0, Math.round(ms / 60000));
        if (m < 2) return "just now";
        if (m < 60) return `${m} min ago`;
        const h = Math.round(m / 60);
        if (h < 24) return `${h} h ago`;
        const d = Math.round(h / 24);
        return d === 1 ? "yesterday" : `${d} days ago`;
    }
    /** "until 6:30 pm" (within a day) / "until 30 Oct" @param {number|null} t @param {number} now */
    function until(t, now) {
        if (!Number.isFinite(t) || t === null || t <= now) return "";
        const d = new Date(t);
        if (t - now < 86400000) return `until ${d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`;
        return `until ${d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`;
    }
    const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many) => `${n} ${n === 1 ? one : many}`;

    /**
     * What the card shows, from state.truth. Pure.
     * @param {any} state { at, hasRoute, navigating, card, sources }
     * @param {number} now
     * @param {{ expanded?: boolean }} [o]
     */
    function viewModel(state, now, o = {}) {
        if (!state || !state.hasRoute || !state.card) return { hidden: true };
        const c = state.card;
        const where = state.navigating ? "the road ahead" : "this route";
        const kindOf = (/** @type {string} */ k) => (c.rows.find((/** @type {any} */ r) => r.type === k) || { kind: { plain: k, many: k } }).kind;
        const kinds = Object.entries(c.byKind || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => plural(n, kindOf(k).plain, kindOf(k).many)).join(", ");
        let pill, summary;
        if (c.unknown) {
            pill = { text: "Condition unknown", tone: "unknown" };
            summary = `No sensor or rider reports on ${where}. Condition unknown: ride with care.`;
        } else if (c.verified > 0) {
            pill = { text: `${c.verified} confirmed`, tone: "warn" };
            summary = `${c.verified} confirmed${c.candidates ? `, ${c.candidates} unconfirmed` : ""} on ${where}${kinds ? `: ${kinds}` : ""}. Everywhere else: condition unknown.`;
        } else {
            pill = { text: `${c.candidates} unconfirmed`, tone: "muted" };
            summary = `Nothing confirmed on ${where}, ${plural(c.candidates, "unconfirmed report", "unconfirmed reports")}. Condition unknown: ride with care.`;
        }
        const limit = o.expanded ? Infinity : state.navigating ? ROWS_COMPACT : ROWS_FULL;
        const rows = c.rows.slice(0, limit).map((/** @type {any} */ r) => ({
            id: r.id,
            distance: distance(state.navigating ? r.aheadM : r.alongM),
            title: r.kind.one,
            badge: r.status === "verified" ? "Confirmed" : "Unconfirmed",
            tone: r.status === "verified" ? "warn" : "muted",
            evidence: r.screen,
            until: until(r.expiresAt, now)
        }));
        const s = state.sources || {};
        // describe the evidence actually on the card: other riders' reports saved before sharing was turned off still count
        const othersShown = c.rows.some((/** @type {any} */ r) => r.riders - (r.felt ? 1 : 0) > 0);
        let source;
        if (!s.community && othersShown) source = "This phone's sensors and other riders' reports saved earlier. Community road reports are off, so they won't update.";
        else if (!s.community) source = "From this phone's own sensors only. Turn on Community road reports in Settings to see other riders' reports.";
        else if (s.lastFetch) source = `This phone's sensors and other riders' reports, updated ${since(now - s.lastFetch)}${s.offline ? " (saved copy, no signal)" : ""}.`;
        else source = "This phone's sensors. Other riders' reports download when there's signal.";
        return {
            hidden: false, pill, summary, rows, more: Math.max(0, c.rows.length - rows.length), source,
            note: "No report doesn't mean the road is clear.", navigating: Boolean(state.navigating)
        };
    }

    /** Draw the card into the route sheet and keep it current. @param {any} W */
    function mount(W) {
        const doc = W.document;
        let state = /** @type {any} */ (null), expanded = false, el = /** @type {HTMLElement|null} */ (null);
        const h = (/** @type {string} */ tag, /** @type {string} */ cls, /** @type {string} */ text = "") => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

        function host() {
            if (el && el.isConnected) return el;
            const sheet = doc.getElementById("nav-bottom-sheet");
            if (!sheet) return null;
            el = doc.getElementById("road-truth");
            if (!el) {
                el = h("section", "rt-card");
                el.id = "road-truth";
                el.setAttribute("aria-label", "Road reports on this route");
                el.setAttribute("aria-live", "polite");
                const controls = sheet.querySelector(".controls-row");
                sheet.insertBefore(el, controls || null);
            }
            return el;
        }

        function render() {
            const root = host();
            if (!root) return;
            const vm = viewModel(state, Date.now(), { expanded });
            root.hidden = vm.hidden;
            if (vm.hidden) { root.replaceChildren(); return; }
            const head = h("div", "rt-head");
            head.append(h("span", "rt-kicker", "Road truth"), h("span", `rt-pill rt-${vm.pill.tone}`, vm.pill.text));
            const hear = /** @type {HTMLButtonElement} */ (h("button", "rt-hear", "🔊"));
            hear.type = "button";
            hear.setAttribute("aria-label", "Hear the road reports");
            hear.addEventListener("click", async () => {
                const M = W.MUMaster && W.MUMaster.live;
                if (!M || typeof M.roadTruth !== "function") return;
                const ans = await M.roadTruth();
                // @ts-ignore: a global from voice.js
                if (typeof VoiceAssistant !== "undefined" && VoiceAssistant.masterSay) VoiceAssistant.masterSay(ans, { icon: "🛣️" });
            });
            head.append(hear);
            const kids = [head, h("p", "rt-summary", vm.summary)];
            if (vm.rows.length) {
                const list = h("ol", "rt-rows");
                for (const r of vm.rows) {
                    const li = h("li", "rt-row");
                    li.append(h("span", "rt-dist", r.distance), h("span", "rt-kind", r.title), h("span", `rt-badge rt-${r.tone}`, r.badge), h("span", "rt-ev", r.evidence));
                    if (r.until) li.append(h("span", "rt-until", r.until));
                    list.append(li);
                }
                kids.push(list);
            }
            if (vm.more) {
                const more = /** @type {HTMLButtonElement} */ (h("button", "rt-more", `Show all ${vm.more + vm.rows.length}`));
                more.type = "button";
                more.addEventListener("click", () => { expanded = true; render(); });
                kids.push(more);
            }
            kids.push(h("p", "rt-source", vm.source), h("p", "rt-note", vm.note));
            root.replaceChildren(...kids);
        }

        doc.addEventListener("mu:master-truth", (/** @type {any} */ e) => {
            const next = e && e.detail;
            if (!next || !next.hasRoute) expanded = false;         // a new route starts collapsed
            state = next;
            render();
        });
        doc.addEventListener("mu:route-clear", () => { state = null; expanded = false; render(); });
        doc.addEventListener("mu:route", () => { expanded = false; });
        // the bus keeps the last state: draw it if the agent was faster than this script
        const M = W.MUMaster && W.MUMaster.live;
        if (M && M.bus && typeof M.bus.last === "function") { state = M.bus.last("state.truth"); render(); }
        return { render, viewModel };
    }

    return { viewModel, mount, distance, since, until };
});
