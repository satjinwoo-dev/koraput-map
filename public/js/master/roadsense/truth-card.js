// @ts-check
/* ============================================================================
   MapUnite RoadSense Live — the Route Truth Card on screen (route sheet)
   ==============================================================================
   Listens to "mu:master-truth" (state.truth from agents/truth-agent.js) and
   shows, under the route, what is KNOWN about the road and from what:

     ROAD TRUTH                                   [2 confirmed]  [🔊]
     2 confirmed, 1 unconfirmed on this route: 2 bumps or potholes.
     2.4 km  Pothole      Confirmed    8 of 10 reviewing riders found it · 80% rider agreement · last confirmed 3 hours ago
     5.1 km  Rough road   1 report     1 rider reported this yesterday
     6.0 km  Pothole      Confirmed    You + 1 rider · motion sensor · 2 hours ago   until 30 Oct
   No probabilities: published hazards show how many riders who reviewed them
   found them; the phone's own evidence shows who and which sensor.
     This phone's sensors and other riders' reports, updated 5 min ago.
     No report doesn't mean the road is clear.

   Ridden by 2+ riders with nothing felt (smooth passes, a SENSOR signal, not a
   review) → "Clear · no bumps felt by N riders", with what that can't cover
   (water, gravel, animals); one rider →
   "ridden once"; nothing at all → "Condition unknown", never "clear". Official
   items show their list's name; predictions are badged "Predicted". 🔊 says the same
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
        const cov = c.coverage || { clearM: 0, riddenM: 0, unknownM: 0, hazardM: 0, clearRiders: 0, clearLastSeen: null };
        const span = Math.max(1, (c.lengthM || 0) - (c.fromM || 0));
        let pill, summary;
        if (c.verified > 0) {
            pill = { text: `${c.verified} confirmed`, tone: "warn" };
            summary = `${c.verified} confirmed${c.candidates ? `, ${c.candidates} unconfirmed` : ""} on ${where}${kinds ? `: ${kinds}` : ""}.`;
        } else if (c.candidates > 0) {
            pill = { text: `${c.candidates} unconfirmed`, tone: "muted" };
            summary = `Nothing confirmed on ${where}, ${plural(c.candidates, "unconfirmed report", "unconfirmed reports")}. Ride with care.`;
        } else if (cov.clearM > 0 && cov.clearM >= 0.9 * span) {
            // "ridden, nothing found" by 2+ riders' phones: a sensor signal, said as such (not a review: nobody said "no hazard")
            pill = { text: `Clear · no bumps felt by ${cov.clearRiders} riders`, tone: "clear" };
            summary = `No bumps or rough road felt on ${where} by ${cov.clearRiders} riders' phone sensors${cov.clearLastSeen ? `, last ${since(now - cov.clearLastSeen)}` : ""}.`;
        } else if (cov.clearM > 0) {
            pill = { text: `Partly clear · ${cov.clearRiders} riders`, tone: "clear" };
            summary = `Nothing reported on ${where}. ${distance(cov.clearM)} ridden by ${cov.clearRiders}+ riders with no bumps felt; the rest is unknown.`;
        } else if (cov.riddenM > 0) {
            pill = { text: "Ridden once, nothing felt", tone: "muted" };
            summary = `Nothing reported on ${where}. Only one rider has been over ${distance(cov.riddenM)} of it, with no bumps felt: not confirmed yet.`;
        } else {
            pill = { text: "Condition unknown", tone: "unknown" };
            summary = `No sensor or rider reports on ${where}. Condition unknown: ride with care.`;
        }
        // the road at a glance: hazard / clear / ridden once / unknown, in proportion
        const bar = (c.stretches || []).filter((/** @type {any} */ x) => x.toM > x.fromM).map((/** @type {any} */ x) => ({
            state: x.state, pct: Math.max(0.5, Math.round(((x.toM - x.fromM) / span) * 1000) / 10)
        }));
        const parts = [];
        if (cov.clearM > 0) parts.push(`${distance(cov.clearM)} clear`);
        if (cov.riddenM > 0) parts.push(`${distance(cov.riddenM)} ridden once`);
        if (cov.hazardM > 0) parts.push(`${distance(cov.hazardM)} with reports`);
        if (cov.unknownM > 0) parts.push(`${distance(cov.unknownM)} unknown`);
        const coverage = bar.length && (cov.clearM > 0 || cov.riddenM > 0) ? parts.join(" · ") : "";
        const limit = o.expanded ? Infinity : state.navigating ? ROWS_COMPACT : ROWS_FULL;
        const badgeOf = (/** @type {any} */ r) => r.status === "predicted" ? ["Predicted", "info"] : r.status === "verified" && r.refs && r.refs.length && !r.felt && r.riders === 0 ? ["Official", "warn"]
            : r.status === "disputed" ? ["Riders disagree", "muted"] : r.status === "maybe_fixed" ? ["Maybe fixed", "muted"]
            : r.community && r.community.recentDisagree ? ["May have changed", "muted"]
            : r.status === "verified" ? ["Confirmed", "warn"] : r.community ? ["1 report", "muted"] : ["Unconfirmed", "muted"];
        const rows = c.rows.slice(0, limit).map((/** @type {any} */ r) => ({
            id: r.id,
            distance: distance(state.navigating ? r.aheadM : r.alongM),
            title: r.kind.one,
            badge: badgeOf(r)[0],
            tone: badgeOf(r)[1],
            evidence: r.screen,
            until: until(r.expiresAt, now)
        }));
        const s = state.sources || {};
        // describe the evidence actually on the card: other riders' reports saved before sharing was turned off still count
        // ("clear" always includes another rider: it takes 2)
        const othersShown = c.rows.some((/** @type {any} */ r) => r.riders - (r.felt ? 1 : 0) > 0) || cov.clearM > 0;
        let source;
        if (!s.community && othersShown) source = "This phone's sensors and other riders' reports saved earlier. Community road reports are off, so they won't update.";
        else if (!s.community) source = "From this phone's own sensors only. Turn on Community road reports in Settings to see other riders' reports.";
        else if (s.lastFetch) source = `This phone's sensors and other riders' reports, updated ${since(now - s.lastFetch)}${s.offline ? " (saved copy, no signal)" : ""}.`;
        else source = "This phone's sensors. Other riders' reports download when there's signal.";
        return {
            hidden: false, pill, summary, rows, more: Math.max(0, c.rows.length - rows.length), source, bar, coverage,
            // what "clear" can and can't mean, whenever a smooth pass is on the card; "no report ≠ clear" while any part is unknown
            feel: cov.clearM > 0 || cov.riddenM > 0 ? "Clear means no bumps or rough road were felt. A phone can't feel water, gravel or animals." : "",
            note: cov.unknownM > 0 || c.unknown || !bar.length ? "No report doesn't mean the road is clear." : "",
            navigating: Boolean(state.navigating)
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
            if (vm.coverage) {
                const bar = h("div", "rt-bar");
                bar.setAttribute("role", "img");
                bar.setAttribute("aria-label", vm.coverage);
                for (const b of vm.bar) { const seg = h("span", `rt-seg rt-${b.state}`); seg.style.width = `${b.pct}%`; bar.append(seg); }
                kids.push(bar, h("p", "rt-coverage", vm.coverage));
            }
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
            kids.push(h("p", "rt-source", vm.source));
            if (vm.feel) kids.push(h("p", "rt-note", vm.feel));
            if (vm.note) kids.push(h("p", "rt-note", vm.note));
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
