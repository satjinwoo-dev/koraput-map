// @ts-check
/* ============================================================================
   MapUnite insights — the Fuel Learner dashboard
   ==============================================================================
   MUInsights.dashboard.createFuelDashboard(root, deps) → { refresh, destroy }

   One screen that answers "how does MY bike really do, against what the physics
   says it should?":

     - Status and three headline tiles: real world vs physics, your best speed,
       how well each curve predicts your tanks.
     - Mileage by speed: the physics baseline with its ±1σ ribbon, your learned
       curve, and the learner's starting curve (togglable), on one km/h axis,
       with the speed bands the learner works in and how much of your riding
       falls in each. Crosshair readout (docked on phones), keyboard-operable.
     - Real use vs physics by speed band: a diverging bar per band (less fuel
       than the physics ← → more), hatched where there isn't enough riding yet.
     - Every full tank: what the pump said against what the physics and your
       curve predicted, with the error of each. Tanks the learner couldn't use
       say why.
     - Findings in plain words, and "Show the numbers" (the accessible twin).

   Data comes from MUInsights.fuel.compare() (strict SI); this file is the edge
   where SI becomes km/h, km/L and litres (garage/units.js). Colour roles:
   physics = blue, yours = mint (brand), pump = primary ink, starting curve =
   muted dashed; diverging blue (less fuel) ↔ red (more) around a neutral axis.
   Identity is never colour-alone: legend chips, direct labels, the table.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUInsights || (/** @type {any} */ (root).MUInsights = {}); ns.dashboard = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const SVG_NS = "http://www.w3.org/2000/svg";
    const PHONE = 560;

    /**
     * @template {keyof HTMLElementTagNameMap} K
     * @param {K} tag @param {Record<string, any>} [attrs] @param {Array<Node|string|null|false>} [kids]
     * @returns {HTMLElementTagNameMap[K]}
     */
    function h(tag, attrs = {}, kids = []) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === "class") el.className = v;
            else if (k === "text") el.textContent = v;
            else if (k === "html") el.innerHTML = v;                 // static, trusted markup only (icons)
            else if (k === "style") el.setAttribute("style", v);
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c !== null && c !== false) el.append(c);
        return el;
    }
    /** @param {string} tag @param {Record<string, string|number>} [attrs] @param {Array<Node|null>} [kids] */
    function s(tag, attrs = {}, kids = []) {
        const el = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
        for (const c of kids) if (c) el.append(c);
        return el;
    }
    const ICON = {
        info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/></svg>`,
        up: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`,
        down: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>`,
        star: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>`,
        target: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>`,
        idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/></svg>`,
        pump: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M3 21h12M7 8h4"/><path d="M14 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V8.5L18 5"/></svg>`
    };

    // ------------------------------------------------------------------ pure helpers (tested)
    /** km/L from fuel per metre (m³/m); null stays null. */
    const kmpl = (pm) => (pm === null || pm === undefined ? null : pm > 0 && Number.isFinite(pm) ? 1 / (pm * 1e6) : null);

    /** "Nice" axis ticks covering [0, max]. */
    function niceTicks(max, count = 5) {
        if (!(max > 0)) return [0, 1];
        const raw = max / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) || 10 * mag;
        const ticks = [];
        for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
        if (ticks[ticks.length - 1] < max - 1e-9) ticks.push(Math.round((ticks[ticks.length - 1] + step) * 1e6) / 1e6);
        return ticks;
    }

    /** Signed percent text: +12 %, −8 %. */
    function pct(r, U, digits = 0) { const x = (r - 1) * 100; return `${x >= 0 ? "+" : "−"}${U.num(Math.abs(x), digits)} %`; }

    /**
     * Plain-language findings. @param {any} cmp  compare() result @param {any} U units
     * @returns {Array<{ tone: "good"|"warn"|"info", icon: keyof typeof ICON, text: string }>}
     */
    function describeFindings(cmp, U) {
        /** @type {Array<{ tone: "good"|"warn"|"info", icon: keyof typeof ICON, text: string }>} */ const out = [];
        const bandName = (j) => { const b = cmp.bands[j]; return j === 0 ? "under 40 km/h" : j === cmp.bands.length - 1 ? "over 80 km/h" : `${b.label} km/h`; };
        for (const f of cmp.findings) {
            if (f.kind === "need-tanks") out.push({ tone: "info", icon: "pump", text: `Log ${f.need} more full tank${f.need === 1 ? "" : "s"} (fill to full each time) and keep the app open while you ride. Then your own curve can take over.` });
            else if (f.kind === "overall") out.push({ tone: f.ratio > 1.03 ? "warn" : f.ratio < 0.97 ? "good" : "info", icon: f.ratio >= 1 ? "up" : "down", text: Math.abs(f.ratio - 1) < 0.03 ? "Over the riding you do, your bike burns what the physics predicts, within 3 %." : `Over the riding you do, your bike uses ${U.num(Math.abs(f.ratio - 1) * 100, 0)} % ${f.ratio > 1 ? "more" : "less"} fuel than the physics predicts.` });
            else if (f.kind === "band-worse") out.push({ tone: "warn", icon: "up", text: `At ${bandName(f.band)} (around ${U.num(f.v * 3.6, 0)} km/h) you use ${U.num((f.ratio - 1) * 100, 0)} % more than the physics expects. Tyre pressure, load, wind and riding style all show up here.` });
            else if (f.kind === "band-better") out.push({ tone: "good", icon: "down", text: `At ${bandName(f.band)} (around ${U.num(f.v * 3.6, 0)} km/h) you use ${U.num((1 - f.ratio) * 100, 0)} % less than the physics expects. Smooth riding pays.` });
            else if (f.kind === "best-band") out.push({ tone: "good", icon: "star", text: `Your best real-world mileage is at ${bandName(f.band)}: about ${U.smart(kmpl(f.value))} km/L.` });
            else if (f.kind === "accuracy") out.push({ tone: f.value <= f.ratio ? "good" : "info", icon: "target", text: `Your learned curve predicts your tanks within ±${U.num(f.value * 100, 0)} %; the physics alone within ±${U.num(f.ratio * 100, 0)} %.` });
            else if (f.kind === "idle") out.push({ tone: f.ratio > 1 ? "warn" : "info", icon: "idle", text: `Idling burns about ${U.num(f.value * 3.6e6, 2)} L/h on your bike (physics: ${U.num((f.value / f.ratio) * 3.6e6, 2)} L/h).` });
        }
        return out;
    }

    /** The three headline tiles. @param {any} cmp @param {any} snap @param {any} U @param {boolean} hasPhysics */
    function kpis(cmp, snap, U, hasPhysics) {
        const st = snap.status;
        const tiles = [];
        // 1. real world vs physics
        if (cmp.overall !== null) tiles.push({ key: "overall", label: "Real world vs physics", value: pct(cmp.overall, U), sub: `${cmp.overall > 1 ? "more" : "less"} fuel than predicted, over ${U.num(cmp.totalDistance / 1000, 0)} km of your riding`, tone: cmp.overall > 1.03 ? "warn" : cmp.overall < 0.97 ? "good" : "neutral" });
        else tiles.push({ key: "overall", label: "Real world vs physics", value: "–", sub: !hasPhysics ? "Choose your bike to compare with its physics" : `Needs ${Math.max(1, st.needed - st.usable)} more full tank${st.needed - st.usable === 1 ? "" : "s"}`, tone: "neutral" });
        // 2. best speed
        const best = cmp.findings.find((f) => f.kind === "best-band");
        if (best) tiles.push({ key: "best", label: "Your best speed", value: `${best.band === 0 ? "Under 40" : best.band === cmp.bands.length - 1 ? "Over 80" : cmp.bands[best.band].label}`, unit: "km/h", sub: `about ${U.smart(kmpl(best.value))} km/L in real riding`, tone: "good" });
        else if (cmp.eco) tiles.push({ key: "best", label: "Physics' best speed", value: `${U.num(cmp.eco.speedLow * 3.6, 0)}–${U.num(cmp.eco.speedHigh * 3.6, 0)}`, unit: "km/h", sub: `about ${U.smart(kmpl(cmp.eco.perMetreBest))} km/L on the flat`, tone: "neutral" });
        else tiles.push({ key: "best", label: "Your best speed", value: "–", sub: "Appears once a few tanks are logged", tone: "neutral" });
        // 3. accuracy
        const a = cmp.accuracy;
        if (a.learned !== null) tiles.push({ key: "acc", label: "Tank accuracy", value: `±${U.num(a.learned * 100, 0)} %`, sub: `your curve, on ${a.tanks} tank${a.tanks === 1 ? "" : "s"}${a.physics !== null ? ` · physics ±${U.num(a.physics * 100, 0)} %` : ""}`, tone: a.physics !== null && a.learned < a.physics ? "good" : "neutral" });
        else tiles.push({ key: "acc", label: "Tanks learned", value: `${st.usable}`, unit: `of ${st.needed}`, sub: "full-to-full tanks before your curve is used", tone: "neutral" });
        return tiles;
    }

    /**
     * Geometry for the mileage chart (pure). x: km/h, y: km/L.
     * @param {any} cmp @param {{ W: number, H: number, m: { l: number, r: number, t: number, b: number }, show: { physics: boolean, yours: boolean, start: boolean } }} o
     */
    function mileageGeometry(cmp, o) {
        const rows = cmp.rows;
        const { W, H, m } = o;
        const xMaxKmh = Math.max(60, Math.ceil((rows.length ? rows[rows.length - 1].v * 3.6 : 100) / 20) * 20);
        let yMax = 0;
        for (const r of rows) {
            if (r.v * 3.6 < 12) continue;                       // the slow end shoots up: don't let it set the scale
            const cands = [o.show.physics && r.feasible ? kmpl(r.physLo) : null, o.show.yours ? kmpl(r.learned) : null, o.show.start ? kmpl(r.start) : null];
            for (const c of cands) if (c !== null && c > yMax) yMax = c;
        }
        const ticksY = niceTicks((yMax || 50) * 1.06, 5), yTop = ticksY[ticksY.length - 1];
        const X = (kmh) => m.l + (kmh / xMaxKmh) * (W - m.l - m.r);
        const Y = (k) => m.t + (1 - Math.min(k, yTop) / yTop) * (H - m.t - m.b);
        /** One path; breaks where a value is missing, and (for the learned curve) at band edges. */
        const path = (get, keep, breakOnBand = false) => {
            let d = "", open = false, prevBand = -1;
            for (const r of rows) {
                const k = keep(r) ? get(r) : null;
                if (k === null) { open = false; continue; }
                if (breakOnBand && r.band !== prevBand) open = false;
                d += `${open ? "L" : "M"}${X(r.v * 3.6).toFixed(1)} ${Y(k).toFixed(1)}`;
                open = true; prevBand = r.band;
            }
            return d;
        };
        // ribbon: upper edge = low fuel (high km/L), lower edge = high fuel, feasible rows only (contiguous runs)
        let ribbon = "", run = [];
        const flush = () => {
            if (run.length > 1) {
                ribbon += `M${run.map((r) => `${X(r.v * 3.6).toFixed(1)} ${Y(kmpl(r.physLo)).toFixed(1)}`).join("L")}`;
                ribbon += `L${run.slice().reverse().map((r) => `${X(r.v * 3.6).toFixed(1)} ${Y(kmpl(r.physHi)).toFixed(1)}`).join("L")}Z`;
            }
            run = [];
        };
        for (const r of rows) { if (r.feasible && r.physLo !== null && kmpl(r.physLo) !== null && kmpl(r.physHi) !== null) run.push(r); else flush(); }
        flush();
        return {
            xMaxKmh, yTop, ticksY, ticksX: niceTicks(xMaxKmh, xMaxKmh > 100 ? 6 : 5).filter((t) => t <= xMaxKmh), X, Y,
            physics: path((r) => kmpl(r.phys), (r) => r.feasible), ribbon,
            yours: path((r) => kmpl(r.learned), () => true, true), start: path((r) => kmpl(r.start), () => true),
            bandEdges: cmp.bands.slice(1).map((b) => Math.round(b.lo * 3.6 * 1e6) / 1e6).filter((k) => k < xMaxKmh)
        };
    }

    // ------------------------------------------------------------------ the dashboard
    /**
     * @param {HTMLElement} root
     * @param {{ units: any, insights: any,
     *   getData: () => Promise<{ snapshot: any|null, physics: any|null, bike: null|{ name: string, powertrain: string, estimated?: boolean }, reason?: string }>,
     *   onLogFill?: () => void, onChooseBike?: () => void, storage?: Storage|null }} deps
     */
    function createFuelDashboard(root, deps) {
        const U = deps.units;
        const uid = `fd${Math.random().toString(36).slice(2, 8)}`;
        const show = { physics: true, yours: true, start: false };
        let data = null, cmp = null, ro = null, destroyed = false;
        root.classList.add("fd");
        root.replaceChildren(h("p", { class: "fd-loading", text: "Reading your fill-ups…" }));

        async function refresh() {
            try { data = await deps.getData(); } catch (e) { data = { snapshot: null, physics: null, bike: null, reason: /** @type {Error} */ (e).message }; }
            if (destroyed) return;
            render();
        }

        function render() {
            const snap = data && data.snapshot;
            const bike = data && data.bike;
            root.replaceChildren();
            // ---- header ----
            const st = snap ? snap.status : null;
            const pill = !snap ? null
                : st.active ? { t: "Using your curve", c: "is-on" }
                    : st.ready && !st.enabled ? { t: "Ready · switched off", c: "is-idle" }
                        : st.usable < st.needed ? { t: `Learning · ${st.usable} of ${st.needed} tanks`, c: "is-learn" }
                            : { t: "Starting curve fits better", c: "is-idle" };
            root.append(h("header", { class: "fd-head" }, [
                h("div", { class: "fd-head-main" }, [
                    h("h2", { class: "fd-title", id: `${uid}-title`, text: "Fuel learner" }),
                    h("p", { class: "fd-sub", text: bike ? `${bike.estimated ? "Typical bike: " : ""}${bike.name}` : "No bike chosen" })
                ]),
                pill ? h("span", { class: `fd-pill ${pill.c}`, text: pill.t }) : null
            ]));
            if (!snap) {
                root.append(empty(data && data.reason ? data.reason : "The fuel learner isn't available on this page.", null));
                return;
            }
            if (bike && bike.powertrain === "ev") {
                root.append(empty("Your bike is electric. The fuel learner learns from petrol fill-ups, so there's nothing to compare yet.", null));
                return;
            }
            if (!snap.fills.length) {
                root.append(howItWorks());
                return;
            }
            const physics = data.physics;
            cmp = deps.insights.compare(snap, physics);

            // ---- tiles ----
            const tiles = kpis(cmp, snap, U, !!physics);
            root.append(h("section", { class: "fd-tiles", "aria-label": "Summary" }, tiles.map((t) => h("div", { class: `fd-tile is-${t.tone}` }, [
                h("span", { class: "fd-tile-l", text: t.label }),
                h("span", { class: "fd-tile-v" }, [t.value, t.unit ? h("small", { text: ` ${t.unit}` }) : null]),
                h("span", { class: "fd-tile-s", text: t.sub })
            ]))));
            if (!physics) root.append(h("div", { class: "fd-callout" }, [
                h("p", { text: "Choose your bike to see its physics baseline next to your real-world curve." }),
                deps.onChooseBike ? h("button", { type: "button", class: "fd-btn", text: "Choose my bike", onclick: deps.onChooseBike }) : null
            ]));

            // ---- grid: chart + side ----
            const chartCard = h("section", { class: "fd-card fd-card-chart", "aria-labelledby": `${uid}-c1` });
            const bandCard = h("section", { class: "fd-card fd-card-bands", "aria-labelledby": `${uid}-c2` });
            const tankCard = h("section", { class: "fd-card fd-card-tanks", "aria-labelledby": `${uid}-c3` });
            const findCard = h("section", { class: "fd-card fd-card-find", "aria-labelledby": `${uid}-c4` });
            root.append(h("div", { class: "fd-grid" }, [chartCard, bandCard, tankCard, findCard]));
            renderChartCard(chartCard);
            renderBands(bandCard);
            renderTanks(tankCard);
            renderFindings(findCard);
            root.append(numbersTable());
            const foot = h("footer", { class: "fd-foot" }, [
                deps.onLogFill ? h("button", { type: "button", class: "fd-btn-ghost", text: "Log a fill-up", onclick: deps.onLogFill }) : null,
                deps.onChooseBike && physics ? h("button", { type: "button", class: "fd-btn-ghost", text: "Change bike", onclick: deps.onChooseBike }) : null,
                h("p", { class: "fd-foot-note", text: "Everything here is worked out on your phone from your own fill-ups. Physics: flat road, no wind, your weight and load from My bike." })
            ]);
            root.append(foot);
        }

        function empty(text, action) {
            return h("div", { class: "fd-empty" }, [h("p", { text }), action]);
        }
        function howItWorks() {
            const steps = [
                ["Fill to full", "At the pump, fill the tank to the brim and log the litres (and the odometer, if you can)."],
                ["Ride with the app", "Keep MapUnite open on your rides, so it sees how fast you go and for how long."],
                ["Fill to full again", "After three full-to-full tanks, your own curve is compared with the physics and takes over when it's better."]
            ];
            return h("section", { class: "fd-how" }, [
                h("h3", { text: "How the learner works" }),
                h("ol", { class: "fd-how-steps" }, steps.map(([t, d], i) => h("li", {}, [h("span", { class: "fd-how-n", text: String(i + 1) }), h("span", {}, [h("strong", { text: t }), h("span", { text: d })])]))),
                deps.onLogFill ? h("button", { type: "button", class: "fd-btn", text: "Log my first fill-up", onclick: deps.onLogFill }) : null
            ]);
        }

        // ---------------- mileage chart ----------------
        function renderChartCard(card) {
            const hasPhys = !!(data && data.physics);
            const chips = h("div", { class: "fd-legend", role: "group", "aria-label": "Show or hide curves" });
            const series = [
                ...(hasPhys ? [["physics", "Physics", "fd-sw-physics"]] : []),
                ...(cmp.rows.some((r) => r.learned !== null) ? [["yours", "Your curve", "fd-sw-yours"]] : []),
                ["start", "Starting curve", "fd-sw-start"]
            ];
            if (!series.some(([k]) => k === "yours")) show.start = true;
            for (const [key, label, sw] of series) {
                chips.append(h("button", { type: "button", class: "fd-chip", "aria-pressed": String(show[key]), onclick: (e) => {
                    show[key] = !show[key];
                    if (!show.physics && !show.yours && !show.start) show[key] = true;
                    /** @type {HTMLElement} */ (e.currentTarget).setAttribute("aria-pressed", String(show[key]));
                    draw();
                } }, [h("span", { class: `fd-sw ${sw}`, "aria-hidden": "true" }), label]));
            }
            const plot = h("div", { class: "fd-plot" });
            const readout = h("div", { class: "fd-readout", "aria-live": "polite" });
            const strip = h("div", { class: "fd-strip", "aria-label": "Where you ride" });
            card.append(
                h("div", { class: "fd-card-head" }, [h("h3", { id: `${uid}-c1`, text: "Mileage by speed" }), chips]),
                readout, plot, strip,
                h("p", { class: "fd-caption", text: hasPhys ? "Physics: flat road, with the likely range shaded. Your curve: learned from your full tanks, one level per speed band." : "Your curve against the learner's starting curve." })
            );
            let geo = null, cursor = -1;
            const draw = () => {
                const W = Math.max(280, plot.clientWidth || 600), phone = W < PHONE;
                const H = phone ? 220 : 280;
                const m = { l: 40, r: 14, t: 22, b: 26 };
                geo = mileageGeometry(cmp, { W, H, m, show });
                const svg = s("svg", { class: "fd-svg", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", tabindex: "0", "aria-label": "Mileage by speed. Use the arrow keys to read values." });
                const g = s("g");
                for (const t of geo.ticksY) {
                    g.append(s("line", { class: "fd-gridline", x1: m.l, x2: W - m.r, y1: geo.Y(t), y2: geo.Y(t) }));
                    const tx = s("text", { class: "fd-tick", x: m.l - 6, y: geo.Y(t) + 3.5, "text-anchor": "end" }); tx.textContent = U.num(t, 0); g.append(tx);
                }
                const yl = s("text", { class: "fd-axis-l", x: m.l - 6, y: 12, "text-anchor": "end" }); yl.textContent = "km/L"; g.append(yl);
                for (const t of geo.ticksX) {
                    if (t === 0) continue;                                   // the axis unit sits where "0" would
                    const tx = s("text", { class: "fd-tick", x: geo.X(t), y: H - m.b + 16, "text-anchor": "middle" }); tx.textContent = U.num(t, 0); g.append(tx);
                }
                const xl = s("text", { class: "fd-axis-l", x: m.l - 6, y: H - m.b + 16, "text-anchor": "end" }); xl.textContent = "km/h"; g.append(xl);
                // band edges + band names
                const edges = [0, ...geo.bandEdges, geo.xMaxKmh];
                for (const e of geo.bandEdges) g.append(s("line", { class: "fd-band-edge", x1: geo.X(e), x2: geo.X(e), y1: m.t - 6, y2: H - m.b }));
                cmp.bands.forEach((b, j) => {
                    if (j >= edges.length - 1) return;
                    const t = s("text", { class: "fd-band-name", x: (geo.X(edges[j]) + geo.X(edges[j + 1])) / 2, y: m.t - 9, "text-anchor": "middle" }); t.textContent = b.label; g.append(t);
                });
                g.append(s("line", { class: "fd-base", x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }));
                if (show.physics && geo.ribbon) g.append(s("path", { class: "fd-ribbon", d: geo.ribbon }));
                if (show.start && geo.start) g.append(s("path", { class: "fd-line fd-line-start", d: geo.start }));
                if (show.physics && geo.physics) g.append(s("path", { class: "fd-line fd-line-physics", d: geo.physics }));
                if (show.yours && geo.yours) g.append(s("path", { class: "fd-line fd-line-yours", d: geo.yours }));
                // direct labels at the right end of each visible line
                const last = [...cmp.rows].reverse();
                const label = (get, cls, text) => {
                    const r = last.find((x) => get(x) !== null && x.v * 3.6 <= geo.xMaxKmh);
                    if (!r) return;
                    const t = s("text", { class: `fd-dlabel ${cls}`, x: geo.X(r.v * 3.6) - 4, y: geo.Y(get(r)) - 7, "text-anchor": "end" }); t.textContent = text; g.append(t);
                };
                if (!phone) {
                    if (show.physics && data.physics) label((r) => (r.feasible ? kmpl(r.phys) : null), "is-physics", "Physics");
                    if (show.yours) label((r) => kmpl(r.learned), "is-yours", "Yours");
                }
                // crosshair layer
                const cross = s("line", { class: "fd-cross", x1: 0, x2: 0, y1: m.t, y2: H - m.b, visibility: "hidden" });
                const dots = s("g", { class: "fd-dots" });
                g.append(cross, dots);
                const hit = s("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" });
                g.append(hit);
                svg.append(g);
                const tip = h("div", { class: "fd-tip", hidden: true });
                plot.replaceChildren(svg, tip);
                const pick = (i) => {
                    cursor = i;
                    if (i < 0) { cross.setAttribute("visibility", "hidden"); dots.replaceChildren(); tip.hidden = true; readout.textContent = phone ? "Tap the chart to read a speed." : ""; return; }
                    const r = cmp.rows[i], x = geo.X(r.v * 3.6);
                    cross.setAttribute("x1", String(x)); cross.setAttribute("x2", String(x)); cross.setAttribute("visibility", "visible");
                    dots.replaceChildren();
                    const lines = [`${U.num(r.v * 3.6, 0)} km/h`];
                    const kp = r.feasible ? kmpl(r.phys) : null, ky = kmpl(r.learned), ks = kmpl(r.start);
                    if (show.physics && data.physics) {
                        if (kp !== null) { dots.append(s("circle", { class: "fd-dot is-physics", cx: x, cy: geo.Y(kp), r: 4.5 })); lines.push(`Physics ${U.smart(kp)} km/L (${U.smart(kmpl(r.physHi))}–${U.smart(kmpl(r.physLo))})`); }
                        else lines.push("Physics: the bike can't hold this speed");
                    }
                    if (show.yours && ky !== null) { dots.append(s("circle", { class: "fd-dot is-yours", cx: x, cy: geo.Y(ky), r: 4.5 })); lines.push(`Yours ${U.smart(ky)} km/L${kp ? ` (${pct(kp / ky, U)})` : ""}`); }
                    if (show.start && ks !== null) { dots.append(s("circle", { class: "fd-dot is-start", cx: x, cy: geo.Y(ks), r: 3.5 })); lines.push(`Starting ${U.smart(ks)} km/L`); }
                    if (phone) { readout.textContent = lines.join(" · "); tip.hidden = true; }
                    else {
                        tip.replaceChildren(...lines.map((t, k) => h(k ? "span" : "strong", { text: t })));
                        tip.hidden = false;
                        const right = x > W * 0.62;
                        tip.style.left = right ? "" : `${x + 12}px`;
                        tip.style.right = right ? `${W - x + 12}px` : "";
                        tip.style.top = `${m.t + 4}px`;
                    }
                };
                const nearest = (clientX) => {
                    const box = svg.getBoundingClientRect();
                    const kmh = ((clientX - box.left) * (W / box.width) - m.l) / (W - m.l - m.r) * geo.xMaxKmh;
                    let best = -1, bd = Infinity;
                    cmp.rows.forEach((r, i) => { const d = Math.abs(r.v * 3.6 - kmh); if (d < bd) { bd = d; best = i; } });
                    return best;
                };
                svg.addEventListener("pointermove", (e) => pick(nearest(e.clientX)));
                svg.addEventListener("pointerdown", (e) => pick(nearest(e.clientX)));
                svg.addEventListener("pointerleave", () => { if (!phone) pick(-1); });
                svg.addEventListener("keydown", (e) => {
                    const step = Math.max(1, Math.round((5 / 3.6) / 0.5));
                    if (e.key === "ArrowRight") pick(Math.min(cmp.rows.length - 1, cursor < 0 ? 0 : cursor + step));
                    else if (e.key === "ArrowLeft") pick(Math.max(0, cursor < 0 ? cmp.rows.length - 1 : cursor - step));
                    else if (e.key === "Home") pick(0);
                    else if (e.key === "End") pick(cmp.rows.length - 1);
                    else if (e.key === "Escape") pick(-1);
                    else return;
                    e.preventDefault();
                });
                if (cursor >= 0) pick(cursor); else pick(phone ? Math.min(cmp.rows.length - 1, Math.round(((cmp.eco ? cmp.eco.speedBest : 40 / 3.6) - cmp.rows[0].v) / 0.5)) : -1);
                // where you ride: aligned under the x axis
                strip.replaceChildren();
                strip.style.paddingLeft = `${m.l}px`; strip.style.paddingRight = `${m.r}px`;
                const inner = h("div", { class: "fd-strip-in" });
                cmp.bands.forEach((b, j) => {
                    if (j >= edges.length - 1) return;
                    const w = ((edges[j + 1] - edges[j]) / geo.xMaxKmh) * 100;
                    const share = b.share;
                    inner.append(h("div", { class: "fd-strip-cell", style: `width:${w}%;--a:${(0.1 + 0.55 * share).toFixed(3)}`, title: `${b.label} km/h: ${U.num(b.distance / 1000, 0)} km` }, [
                        h("span", { class: "fd-strip-v", text: `${U.num(share * 100, 0)} %` }),
                        h("span", { class: "fd-strip-k", text: `${U.num(b.distance / 1000, 0)} km` })
                    ]));
                });
                strip.append(h("span", { class: "fd-strip-title", text: "Where you ride" }), inner);
            };
            draw();
            if (typeof ResizeObserver === "function") {
                let lastW = 0;
                ro = new ResizeObserver(() => { const w = plot.clientWidth; if (Math.abs(w - lastW) > 4) { lastW = w; draw(); } });
                ro.observe(plot);
            }
        }

        // ---------------- bands: real vs physics, diverging ----------------
        function renderBands(card) {
            card.append(h("div", { class: "fd-card-head" }, [h("h3", { id: `${uid}-c2`, text: "Real use vs physics, by speed" })]));
            if (!data.physics || !cmp.rows.some((r) => r.learned !== null)) {
                card.append(h("p", { class: "fd-muted", text: !data.physics ? "Needs your bike's physics: choose your bike in My bike." : "Appears when the learner has fitted your tanks." }));
                return;
            }
            const maxAbs = Math.max(0.25, ...cmp.bands.filter((b) => b.ratio !== null).map((b) => Math.abs(b.ratio - 1)));
            const scale = Math.ceil(maxAbs * 10) / 10;
            const list = h("div", { class: "fd-div", role: "list" });
            for (const b of cmp.bands) {
                const r = b.ratio, d = r === null ? 0 : r - 1;
                const w = Math.min(50, (Math.abs(d) / scale) * 50);
                list.append(h("div", { class: `fd-div-row${b.enough ? "" : " is-thin"}`, role: "listitem", "aria-label": `${b.label} km/h: ${r === null ? "no data" : `${pct(r, U)} fuel vs physics`}${b.enough ? "" : ", not enough riding yet"}` }, [
                    h("span", { class: "fd-div-l", text: b.label }),
                    h("span", { class: "fd-div-track" }, [
                        h("span", { class: "fd-div-zero" }),
                        r === null ? null : h("span", { class: `fd-div-bar ${d > 0 ? "is-more" : "is-less"}`, style: d > 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%` })
                    ]),
                    h("span", { class: "fd-div-v", text: r === null ? "–" : b.enough ? pct(r, U) : `${pct(r, U)}*` })
                ]));
            }
            card.append(
                h("div", { class: "fd-div-axis", "aria-hidden": "true" }, [h("span", { text: "← less fuel" }), h("span", { text: "physics" }), h("span", { text: "more fuel →" })]),
                list
            );
            if (cmp.bands.some((b) => !b.enough && b.ratio !== null)) card.append(h("p", { class: "fd-muted", text: "* Fewer than 50 km in this band so far: hatched, not trusted yet." }));
        }

        // ---------------- tanks ----------------
        function renderTanks(card) {
            const tanks = [...cmp.tanks].reverse().slice(0, 12);
            const hasPhys = !!data.physics, hasYours = tanks.some((t) => t.learnedFuel !== null);
            card.append(h("div", { class: "fd-card-head" }, [
                h("h3", { id: `${uid}-c3`, text: "Every full tank" }),
                h("div", { class: "fd-legend fd-legend-static" }, [
                    h("span", { class: "fd-key" }, [h("span", { class: "fd-mk is-pump", "aria-hidden": "true" }), "Pump"]),
                    hasPhys ? h("span", { class: "fd-key" }, [h("span", { class: "fd-mk is-physics", "aria-hidden": "true" }), "Physics"]) : null,
                    hasYours ? h("span", { class: "fd-key" }, [h("span", { class: "fd-mk is-yours", "aria-hidden": "true" }), "Your curve"]) : null
                ])
            ]));
            if (!tanks.length) { card.append(h("p", { class: "fd-muted", text: "Your first full-to-full tank appears here after the next full fill-up." })); return; }
            let max = 0;
            for (const t of tanks) for (const x of [t.fuelAdj, t.physics, t.learnedFuel]) if (x !== null && x > max) max = x;
            const top = niceTicks(max * 1000 * 1.08, 4);
            const xMax = top[top.length - 1];
            const P = (litres) => `${(Math.min(litres, xMax) / xMax) * 100}%`;
            const dateFmt = new Intl.DateTimeFormat(U.LOCALE, { day: "numeric", month: "short" });
            const list = h("div", { class: "fd-tanks", role: "list" });
            for (const t of tanks) {
                const L = t.fuelAdj * 1000, Lp = t.physics !== null ? t.physics * 1000 : null, Ly = t.learnedFuel !== null ? t.learnedFuel * 1000 : null;
                const when = `${dateFmt.format(new Date(t.fromTs))} – ${dateFmt.format(new Date(t.toTs))}`;
                const track = h("span", { class: "fd-tank-track" });
                const seg = (a, b, cls) => track.append(h("span", { class: `fd-tank-seg ${cls}`, style: `left:${P(Math.min(a, b))};width:calc(${P(Math.max(a, b))} - ${P(Math.min(a, b))})` }));
                if (t.usable) {
                    if (Lp !== null) seg(L, Lp, "is-physics");
                    if (Ly !== null) seg(L, Ly, "is-yours");
                    if (Lp !== null) track.append(h("span", { class: "fd-mk is-physics", style: `left:${P(Lp)}` }));
                    if (Ly !== null) track.append(h("span", { class: "fd-mk is-yours", style: `left:${P(Ly)}` }));
                }
                track.append(h("span", { class: `fd-mk is-pump${t.usable ? "" : " is-off"}`, style: `left:${P(L)}` }));
                const errs = h("span", { class: "fd-tank-err" });
                if (t.usable) {
                    if (t.errPhysics !== null) errs.append(h("span", { class: "is-physics", text: `${t.errPhysics >= 0 ? "+" : "−"}${U.num(Math.abs(t.errPhysics) * 100, 0)} %` }));
                    if (t.errLearned !== null) errs.append(h("span", { class: "is-yours", text: `${t.errLearned >= 0 ? "+" : "−"}${U.num(Math.abs(t.errLearned) * 100, 0)} %` }));
                } else errs.append(h("span", { class: "fd-tank-why", text: "not used" }));
                const aria = t.usable
                    ? `${when}, ${U.num(t.distance / 1000, 0)} km: pump ${U.num(L, 2)} L${Lp !== null ? `, physics ${U.num(Lp, 2)} L` : ""}${Ly !== null ? `, your curve ${U.num(Ly, 2)} L` : ""}`
                    : `${when}: not used, ${t.reason}`;
                list.append(h("div", { class: `fd-tank${t.usable ? "" : " is-unused"}`, role: "listitem", tabindex: "0", "aria-label": aria, title: t.usable ? "" : t.reason }, [
                    h("span", { class: "fd-tank-l" }, [h("strong", { text: when }), h("span", { text: t.usable ? `${U.num(t.distance / 1000, 0)} km · ${U.num(L, 2)} L · ${U.smart(t.distance / 1000 / L)} km/L` : t.reason })]),
                    track, errs
                ]));
            }
            card.append(list, h("div", { class: "fd-tank-axis", "aria-hidden": "true" }, top.map((v) => h("span", { style: `left:${(v / xMax) * 100}%`, text: v === 0 ? "0 L" : U.num(v, Number.isInteger(v) ? 0 : 1) }))));
        }

        // ---------------- findings ----------------
        function renderFindings(card) {
            const items = describeFindings(cmp, U);
            card.append(h("div", { class: "fd-card-head" }, [h("h3", { id: `${uid}-c4`, text: "What your tanks say" })]));
            if (!items.length) { card.append(h("p", { class: "fd-muted", text: "Nothing stands out yet. Keep logging full tanks." })); return; }
            card.append(h("ul", { class: "fd-find" }, items.map((f) => h("li", { class: `is-${f.tone}` }, [h("span", { class: "fd-find-i", "aria-hidden": "true", html: ICON[f.icon] }), h("span", { text: f.text })]))));
        }

        // ---------------- the numbers ----------------
        function numbersTable() {
            const det = h("details", { class: "fd-numbers" }, [h("summary", { text: "Show the numbers" })]);
            const tbl = h("table", { class: "fd-table" });
            tbl.append(h("caption", { text: "Mileage by speed (km/L)" }), h("thead", {}, [h("tr", {}, [h("th", { scope: "col", text: "Speed" }), h("th", { scope: "col", text: "Physics" }), h("th", { scope: "col", text: "Likely range" }), h("th", { scope: "col", text: "Your curve" }), h("th", { scope: "col", text: "Starting curve" })])]));
            const body = h("tbody");
            for (let kmh = 10; kmh <= 120; kmh += 10) {
                const r = cmp.rows.find((x) => Math.abs(x.v * 3.6 - kmh) < 0.95);
                if (!r) continue;
                const kp = r.feasible ? kmpl(r.phys) : null;
                body.append(h("tr", {}, [
                    h("th", { scope: "row", text: `${kmh} km/h` }),
                    h("td", { text: kp !== null ? U.smart(kp) : data.physics ? "can't hold" : "–" }),
                    h("td", { text: kp !== null ? `${U.smart(kmpl(r.physHi))}–${U.smart(kmpl(r.physLo))}` : "–" }),
                    h("td", { text: kmpl(r.learned) !== null ? U.smart(kmpl(r.learned)) : "–" }),
                    h("td", { text: kmpl(r.start) !== null ? U.smart(kmpl(r.start)) : "–" })
                ]));
            }
            tbl.append(body);
            const t2 = h("table", { class: "fd-table" });
            t2.append(h("caption", { text: "Full tanks (litres)" }), h("thead", {}, [h("tr", {}, ["Tank", "Distance", "Pump", "Physics", "Your curve", "Used"].map((c) => h("th", { scope: "col", text: c })))]));
            const b2 = h("tbody");
            const df = new Intl.DateTimeFormat(U.LOCALE, { day: "numeric", month: "short" });
            for (const t of [...cmp.tanks].reverse()) b2.append(h("tr", {}, [
                h("th", { scope: "row", text: `${df.format(new Date(t.fromTs))} – ${df.format(new Date(t.toTs))}` }),
                h("td", { text: `${U.num(t.distance / 1000, 0)} km` }),
                h("td", { text: U.num(t.fuelAdj * 1000, 2) }),
                h("td", { text: t.physics !== null ? U.num(t.physics * 1000, 2) : "–" }),
                h("td", { text: t.learnedFuel !== null ? U.num(t.learnedFuel * 1000, 2) : "–" }),
                h("td", { text: t.usable ? "yes" : `no: ${t.reason}` })
            ]));
            t2.append(b2);
            det.append(h("div", { class: "fd-table-wrap" }, [tbl]), h("div", { class: "fd-table-wrap" }, [t2]));
            return det;
        }

        refresh();
        return {
            refresh,
            get comparison() { return cmp; },
            destroy() { destroyed = true; if (ro) ro.disconnect(); root.replaceChildren(); root.classList.remove("fd"); }
        };
    }

    return { kmpl, niceTicks, pct, describeFindings, kpis, mileageGeometry, createFuelDashboard };
});
