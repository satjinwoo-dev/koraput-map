// @ts-check
/* ============================================================================
   MapUnite garage — physics visualizer
   ==============================================================================
   One shared speed axis tells the whole story:
     - the curve: km/L at each steady speed (EV: energy use in Wh/km, which stays
       linear and goes below zero when the motor recharges; range is in the
       headline and the tooltip), with its ±1σ "likely range" as a ribbon;
     - the eco window: the speeds within 10 % of the best, lit on the speed scale;
     - the gear ribbon under the chart: the gear the physics would pick at each
       speed, with the upshift points;
     - speeds the bike can't hold on this road, hatched.
   Riders can change the road (flat, climbs, descent) and the load (solo,
   pillion) and the chart recomputes instantly (< 1 ms).

   prepareChart() is pure (tested in Node); render() draws SVG with DOM APIs
   only: every label goes in via textContent.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory(require("./units.js"));
    else { const ns = /** @type {any} */ (root).MUGarage || (/** @type {any} */ (root).MUGarage = {}); ns.visualizer = factory(ns.units); }
})(typeof globalThis !== "undefined" ? globalThis : this, function (/** @type {typeof import("./units.js")} */ U) {
    "use strict";

    /** Why the physics refused gear advice (model.gearAdviceReason), in the rider's words. */
    const NO_GEAR_ADVICE = Object.freeze({
        "typical-bike": "Gear advice is off: these are a typical bike's gears, not yours.",
        "borrowed-gearing": "Gear advice is off for this bike: its gear ratios aren't published, so the chart uses ratios from similar bikes.",
        "gear-count-mismatch": "Gear advice is off for this bike: its published gear ratios don't match its number of gears.",
        "uncertain-gearing": "Gear advice is off for this bike: its published gear ratios aren't reliable enough yet."
    });

    const SVG_NS = "http://www.w3.org/2000/svg";
    /** Gear ribbon colours: one hue, dark → light (validated ordinal ramp on the app's dark surface). */
    const GEAR_RAMP = ["#1c5cab", "#2a78d6", "#5598e7", "#86b6ef", "#b7d3f6", "#e9f2fd"];
    const GEAR_INK = ["#ffffff", "#ffffff", "#0e1724", "#0e1724", "#0e1724", "#0e1724"];
    const ROADS = [
        { id: "flat", label: "Flat", grade: 0 },
        { id: "up3", label: "Climb 3 %", grade: 0.03 },
        { id: "up6", label: "Climb 6 %", grade: 0.06 },
        { id: "down3", label: "Downhill 3 %", grade: -0.03 }
    ];

    // ------------------------------------------------------------------
    // Pure: table → chart model, in display units
    // ------------------------------------------------------------------
    /**
     * @typedef {{ kmh: number, value: number, lo: number, hi: number, feasible: boolean, gear: number, rpm: number, wheelKw: number, perKm: number, free: boolean,
     *   range: number, rangeLo: number, rangeHi: number }} ChartRow
     * @typedef {{ ev: boolean, metric: string, unit: string, rows: ChartRow[], eco: { from: number, to: number, best: number, value: number } | null,
     *   gears: Array<{ gear: number, from: number, to: number }>, blocked: Array<{ from: number, to: number }>, free: Array<{ from: number, to: number }>,
     *   xMax: number, yMin: number, yMax: number, yTicks: number[], xTicks: number[] }} ChartModel
     */
    /**
     * @param {any} table  MUPhysics.cruiseTable() result
     * @param {any} model  MUPhysics bike model
     * The gear ribbon follows the physics' own decision (model.gearAdvice): the core refuses
     * gear advice for typical bikes and borrowed or untrustworthy gearing, so nothing here
     * has to remember to hide it.
     * @returns {ChartModel}
     */
    function prepareChart(table, model) {
        const ev = model.powertrain === "ev";
        /** @type {ChartRow[]} */
        const rows = [];
        for (let i = 0; i < table.speed.length; i++) {
            if (table.speed[i] <= 0) continue;
            const pm = table.perMetre[i];
            let value, lo, hi, perKm, range = NaN, rangeLo = NaN, rangeHi = NaN;
            if (ev) {
                value = U.whPerKm(pm); lo = U.whPerKm(table.perMetreLo[i]); hi = U.whPerKm(table.perMetreHi[i]);
                perKm = value;
                range = U.km(table.range[i]); rangeLo = U.km(table.rangeLo[i]); rangeHi = U.km(table.rangeHi[i]);
            } else {
                value = U.kmPerLitre(pm); lo = U.kmPerLitre(table.perMetreHi[i]); hi = U.kmPerLitre(table.perMetreLo[i]);
                perKm = pm * 1e9;                                   // mL per km
            }
            rows.push({
                kmh: U.kmh(table.speed[i]), value, lo, hi, perKm, range, rangeLo, rangeHi,
                feasible: table.feasible[i] === 1, gear: table.gear[i], rpm: U.rpm(table.omega[i]), wheelKw: U.kw(table.wheelPower[i]),
                free: ev ? value < 0 : !Number.isFinite(value)        // EV recharging / petrol fuel cut: nothing spent
            });
        }
        const xMax = rows.length ? rows[rows.length - 1].kmh : 0;
        const half = rows.length > 1 ? (rows[1].kmh - rows[0].kmh) / 2 : 0;
        const runs = (pred) => {
            const out = [];
            let start = -1;
            rows.forEach((r, i) => {
                if (pred(r) && start < 0) start = i;
                if ((!pred(r) || i === rows.length - 1) && start >= 0) {
                    const end = pred(r) ? i : i - 1;
                    out.push({ from: Math.max(0, rows[start].kmh - half), to: Math.min(xMax, rows[end].kmh + half), startIndex: start, endIndex: end });
                    start = -1;
                }
            });
            return out;
        };
        const gears = [];
        if (model.drive && model.drive.kind === "manual" && model.gearAdvice === true) {
            let cur = null;
            for (const r of rows) {
                if (!r.feasible || r.gear < 1) { cur = null; continue; }
                if (cur && cur.gear === r.gear) cur.to = Math.min(xMax, r.kmh + half);
                else { cur = { gear: r.gear, from: Math.max(0, r.kmh - half), to: Math.min(xMax, r.kmh + half) }; gears.push(cur); }
            }
        }
        const blocked = runs((r) => !r.feasible).map(({ from, to }) => ({ from, to }));
        const free = runs((r) => r.feasible && r.free).map(({ from, to }) => ({ from, to }));
        let yTop = 0, yBottom = 0;
        for (const r of rows) if (r.feasible && Number.isFinite(r.hi)) yTop = Math.max(yTop, r.hi);
        if (yTop === 0) for (const r of rows) if (Number.isFinite(r.value)) yTop = Math.max(yTop, r.value);
        if (ev) for (const r of rows) if (r.feasible && Number.isFinite(r.lo)) yBottom = Math.min(yBottom, r.lo);
        // km/L grows without bound as consumption nears zero (gentle descents): keep the
        // scale readable by capping it at 2.2 × the 75th percentile; taller values leave the top edge
        // (the tooltip and the table still give them exactly).
        const vals = rows.filter((r) => r.feasible && Number.isFinite(r.value) && r.value > 0).map((r) => r.value).sort((a, b) => a - b);
        if (!ev && vals.length >= 4) {
            const cap = 2.2 * vals[Math.floor(0.75 * (vals.length - 1))];
            if (yTop > cap) yTop = cap;
        }
        const yTicks = niceTicks(yBottom, yTop || 1, 5);
        const eco = table.eco ? {
            from: U.kmh(table.eco.speedLow), to: U.kmh(table.eco.speedHigh), best: U.kmh(table.eco.speedBest),
            value: ev ? rangeAt(rows, U.kmh(table.eco.speedBest)) : U.kmPerLitre(table.eco.perMetreBest)
        } : null;
        return {
            ev, metric: ev ? "Energy use" : "Mileage", unit: ev ? "Wh/km" : "km/L",
            rows, eco, gears, blocked, free, xMax,
            yMin: yTicks[0], yMax: yTicks[yTicks.length - 1], yTicks, xTicks: niceTicks(0, xMax, xMax > 120 ? 7 : 6)
        };
    }

    const rangeAt = (rows, kmh) => { let best = rows[0]; for (const r of rows) if (Math.abs(r.kmh - kmh) < Math.abs(best.kmh - kmh)) best = r; return best ? best.range : NaN; };

    /** Round ticks covering [lo, hi]: steps of 1, 2, 2.5 or 5 × 10^k. */
    function niceTicks(lo, hi, count) {
        const span = hi - lo;
        if (!(span > 0)) return [lo, lo + 1];
        const raw = span / Math.max(1, count);
        const p = Math.pow(10, Math.floor(Math.log10(raw)));
        const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || 10 * p;
        const out = [];
        for (let v = Math.floor(lo / step) * step; v < hi + step * 0.999; v += step) out.push(Math.round(v * 1e9) / 1e9);
        return out;
    }

    /** The row nearest a speed. @param {ChartModel} c @param {number} kmh */
    function nearestRow(c, kmh) {
        let lo = 0, hi = c.rows.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c.rows[mid].kmh < kmh) lo = mid; else hi = mid; }
        return Math.abs(c.rows[lo].kmh - kmh) <= Math.abs(c.rows[hi].kmh - kmh) ? lo : hi;
    }

    /**
     * Words for the headline. @param {ChartModel} c
     * @returns {{ lead: string, range: string, detail: string }}
     */
    function headline(c, grade = 0) {
        if (!c.eco) {
            if (c.free.length) return { lead: c.ev ? "Charging all the way down" : "No fuel used downhill", range: "", detail: c.ev ? "The motor recovers energy at these speeds." : "The engine cuts fuel while it brakes the bike." };
            return { lead: "Too steep to cruise efficiently", range: "", detail: "Change the road to see the bike's best speeds." };
        }
        const from = Math.round(c.eco.from), to = Math.round(c.eco.to);
        const where = grade > 0 ? " on this climb" : grade < 0 ? " on this descent" : "";
        const range = from === to ? `${from} km/h` : `${from}–${to} km/h`;
        if (c.ev) {
            // range per charge only makes sense on the flat; on slopes, say what the battery spends
            const best = c.rows[nearestRow(c, c.eco.best)];
            return grade === 0
                ? { lead: "Longest range", range, detail: `About ${U.smart(c.eco.value)} km per charge at ${Math.round(c.eco.best)} km/h` }
                : { lead: "Easiest on the battery", range, detail: `About ${U.num(best.value, 0)} Wh/km at ${Math.round(c.eco.best)} km/h${where}` };
        }
        return { lead: "Best mileage", range, detail: `About ${U.smart(c.eco.value)} km/L at ${Math.round(c.eco.best)} km/h${where}` };
    }

    // ------------------------------------------------------------------
    // DOM helpers
    // ------------------------------------------------------------------
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
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c !== null && c !== false) el.append(c);
        return el;
    }
    /** @param {string} tag @param {Record<string, any>} [attrs] */
    function s(tag, attrs = {}) {
        const el = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
        return el;
    }

    // ------------------------------------------------------------------
    // The component
    // ------------------------------------------------------------------
    /**
     * @param {HTMLElement} root
     * @param {{ physics: any, bundle: any, classDefault?: any, settings?: any, env?: any, estimated?: boolean }} o
     */
    function createVisualizer(root, o) {
        const P = o.physics;
        let road = ROADS[0];
        let pillion = !!(o.settings && o.settings.pillionMass);
        let model, table, chart, shift;
        let hover = -1;
        let uid = `viz${Math.random().toString(36).slice(2, 8)}`;

        root.classList.add("mu-viz");
        root.replaceChildren();

        const head = h("div", { class: "mu-viz-head" });
        const controls = h("div", { class: "mu-viz-controls", role: "group", "aria-label": "Riding conditions" });
        const plot = h("div", { class: "mu-viz-plot" });
        const tip = h("div", { class: "mu-viz-tip", role: "status", "aria-live": "polite", hidden: true });
        const ribbonNote = h("p", { class: "mu-viz-note" });
        const shifts = h("section", { class: "mu-viz-shifts", "aria-label": "Shift guide" });
        const tableBox = h("details", { class: "mu-viz-table" });
        plot.append(tip);
        root.append(head, controls, plot, ribbonNote, shifts, tableBox);

        // what-if controls: road and load, one row above the chart
        const roadGroup = h("div", { class: "mu-seg", role: "radiogroup", "aria-label": "Road" });
        for (const r of ROADS) {
            roadGroup.append(h("button", {
                type: "button", role: "radio", class: "mu-seg-btn", "aria-checked": String(r === road), "data-road": r.id, text: r.label,
                onclick: () => { road = r; syncControls(); recompute(); }
            }));
        }
        const loadGroup = h("div", { class: "mu-seg", role: "radiogroup", "aria-label": "Load" });
        for (const [id, label] of [["solo", "Solo"], ["pillion", "With pillion"]]) {
            loadGroup.append(h("button", {
                type: "button", role: "radio", class: "mu-seg-btn", "aria-checked": String((id === "pillion") === pillion), "data-load": id, text: label,
                onclick: () => { pillion = id === "pillion"; syncControls(); recompute(); }
            }));
        }
        controls.append(roadGroup, loadGroup);
        function syncControls() {
            for (const b of roadGroup.children) b.setAttribute("aria-checked", String(b.getAttribute("data-road") === road.id));
            for (const b of loadGroup.children) b.setAttribute("aria-checked", String((b.getAttribute("data-load") === "pillion") === pillion));
        }

        function settingsNow() {
            const st = { ...(o.settings || {}) };
            if (pillion) { if (!st.pillionMass) st.pillionMass = (o.bundle.priors && o.bundle.priors.riderMass && o.bundle.priors.riderMass.mean) || 72; }
            else delete st.pillionMass;
            return st;
        }

        function recompute() {
            model = P.createBikeModel(o.bundle, { classDefault: o.classDefault, settings: settingsNow() });
            const env = { ...(o.env || {}), grade: road.grade };
            table = P.cruiseTable(model, env);
            shift = P.shiftPoints(model, env);
            chart = prepareChart(table, model);
            renderHead();
            renderPlot();
            renderShifts();
            renderTable();
        }

        // ---------------- headline ----------------
        function renderHead() {
            const hl = headline(chart, road.grade);
            head.replaceChildren(
                h("p", { class: "mu-viz-lead", text: hl.lead }),
                hl.range ? h("p", { class: "mu-viz-range", text: hl.range }) : null,
                h("p", { class: "mu-viz-detail", text: hl.detail })
            );
        }

        // ---------------- chart ----------------
        let svg = null, geom = null;
        function renderPlot() {
            const W = Math.max(280, Math.round(plot.clientWidth || 360));
            const H = Math.round(Math.min(300, Math.max(200, W * 0.56)));
            const strip = chart.gears.length ? 30 : 0;
            const longest = Math.max(...chart.yTicks.map((t) => U.num(t, t % 1 ? 1 : 0).length), chart.unit.length);
            const m = { l: Math.max(46, 18 + 7.5 * longest), r: 14, t: 26, b: 26 + strip };
            const iw = W - m.l - m.r, ih = H - m.t - m.b;
            const x = (k) => m.l + (chart.xMax > 0 ? (k / chart.xMax) * iw : 0);
            const y = (v) => m.t + ih - ((Math.max(chart.yMin, Math.min(v, chart.yMax)) - chart.yMin) / (chart.yMax - chart.yMin)) * ih;
            geom = { W, H, m, iw, ih, x, y, strip };

            const old = svg;
            svg = s("svg", { class: "mu-viz-svg", viewBox: `0 0 ${W} ${H + 6}`, width: W, height: H + 6, role: "img", tabindex: "0", "aria-describedby": `${uid}-desc` });
            const desc = s("desc", { id: `${uid}-desc` });
            desc.textContent = summary();
            svg.append(desc);

            // hatch pattern for speeds the bike can't hold
            const defs = s("defs");
            const pat = s("pattern", { id: `${uid}-hatch`, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
            pat.append(s("line", { x1: 0, y1: 0, x2: 0, y2: 6, class: "mu-viz-hatch" }));
            const clip = s("clipPath", { id: `${uid}-clip` });
            clip.append(s("rect", { x: m.l, y: m.t - 2, width: iw, height: ih + 2 }));
            defs.append(pat, clip);
            svg.append(defs);

            // grid + y ticks
            const grid = s("g", { class: "mu-viz-grid" });
            for (const t of chart.yTicks) {
                grid.append(s("line", { x1: m.l, x2: m.l + iw, y1: y(t), y2: y(t), class: t === 0 && chart.yMin < 0 ? "is-zero" : null }));
                const lab = s("text", { x: m.l - 8, y: y(t) + 4, "text-anchor": "end", class: "mu-viz-tick" });
                lab.textContent = U.num(t, t % 1 ? 1 : 0);
                grid.append(lab);
            }
            const unit = s("text", { x: m.l - 8, y: m.t - 10, "text-anchor": "end", class: "mu-viz-axis-unit" });
            unit.textContent = chart.unit;
            grid.append(unit);
            svg.append(grid);

            // eco window: a lit stretch of the speed scale
            if (chart.eco) {
                const ex = x(chart.eco.from), ew = Math.max(2, x(chart.eco.to) - x(chart.eco.from));
                svg.append(s("rect", { x: ex, y: m.t, width: ew, height: ih, class: "mu-viz-eco-wash" }));
                svg.append(s("rect", { x: ex, y: m.t + ih - 1, width: ew, height: 4, rx: 2, class: "mu-viz-eco-bar" }));
                const lab = s("text", { x: ex + ew / 2, y: m.t - 10, "text-anchor": ex + ew / 2 < m.l + 40 ? "start" : "middle", class: "mu-viz-eco-label" });
                lab.textContent = "Eco band";
                svg.append(lab);
            }
            // speeds the bike can't hold on this road
            for (const b of chart.blocked) {
                svg.append(s("rect", { x: x(b.from), y: m.t, width: Math.max(1, x(b.to) - x(b.from)), height: ih, fill: `url(#${uid}-hatch)`, class: "mu-viz-blocked" }));
            }

            // ribbon (±1σ) and curve, broken where nothing is spent (fuel cut / charging) or the speed can't be held
            const body = s("g", { "clip-path": `url(#${uid}-clip)` });
            const segments = [];
            let cur = [];
            for (const r of chart.rows) {
                if (!r.feasible || !Number.isFinite(r.value)) { if (cur.length) segments.push(cur); cur = []; continue; }
                cur.push(r);
            }
            if (cur.length) segments.push(cur);
            for (const seg of segments) {
                if (seg.length < 2) continue;
                const top = seg.map((r) => `${x(r.kmh).toFixed(1)},${y(Number.isFinite(r.hi) ? r.hi : chart.yMax).toFixed(1)}`);
                const bottom = seg.slice().reverse().map((r) => `${x(r.kmh).toFixed(1)},${y(chart.ev ? r.lo : Math.max(0, r.lo)).toFixed(1)}`);
                body.append(s("polygon", { points: [...top, ...bottom].join(" "), class: "mu-viz-ribbon" }));
                body.append(s("polyline", { points: seg.map((r) => `${x(r.kmh).toFixed(1)},${y(r.value).toFixed(1)}`).join(" "), class: "mu-viz-line" }));
            }
            svg.append(body);

            // fuel cut / charging stretches: say so on the chart instead of drawing infinity
            for (const f of chart.free) {
                const t = s("text", { x: (x(f.from) + x(f.to)) / 2, y: chart.ev ? y(chart.yMin) - 8 : m.t + 16, "text-anchor": "middle", class: "mu-viz-free" });
                t.textContent = chart.ev ? "charging" : "no fuel";
                if (x(f.to) - x(f.from) > 44) svg.append(t);
            }

            // x axis
            const xa = s("g", { class: "mu-viz-xaxis" });
            xa.append(s("line", { x1: m.l, x2: m.l + iw, y1: m.t + ih, y2: m.t + ih }));
            for (const t of chart.xTicks) {
                if (t > chart.xMax + 1e-9 || t === 0) continue;
                const lab = s("text", { x: x(t), y: m.t + ih + 16, "text-anchor": "middle", class: "mu-viz-tick" });
                lab.textContent = U.num(t, 0);
                xa.append(lab);
            }
            const xu = s("text", { x: m.l - 8, y: m.t + ih + 16, "text-anchor": "end", class: "mu-viz-axis-unit" });
            xu.textContent = "km/h";
            xa.append(xu);
            svg.append(xa);

            // gear ribbon, aligned to the same speed axis
            if (chart.gears.length) {
                const gy = m.t + ih + 24;
                const g = s("g", { class: "mu-viz-gears" });
                const gl = s("text", { x: m.l - 8, y: gy + 14, "text-anchor": "end", class: "mu-viz-tick" });
                gl.textContent = "Gear";
                g.append(gl);
                for (const seg of chart.gears) {
                    const gx = x(seg.from) + 1, gw = Math.max(0, x(seg.to) - x(seg.from) - 2);   // 2px surface gap between gears
                    if (gw <= 0) continue;
                    const ci = Math.min(GEAR_RAMP.length - 1, seg.gear - 1);
                    g.append(s("rect", { x: gx, y: gy, width: gw, height: 20, rx: 4, fill: GEAR_RAMP[ci] }));
                    if (gw >= 18) {
                        const t = s("text", { x: gx + gw / 2, y: gy + 14, "text-anchor": "middle", class: "mu-viz-gear-n", fill: GEAR_INK[ci] });
                        t.textContent = String(seg.gear);
                        g.append(t);
                    }
                }
                svg.append(g);
            }

            // crosshair layer
            const cross = s("g", { class: "mu-viz-cross", visibility: "hidden" });
            cross.append(s("line", { x1: 0, x2: 0, y1: m.t, y2: m.t + ih, class: "mu-viz-cross-line" }));
            cross.append(s("circle", { cx: 0, cy: 0, r: 5, class: "mu-viz-cross-dot" }));
            svg.append(cross);
            const hit = s("rect", { x: m.l, y: m.t, width: iw, height: ih + strip + 4, class: "mu-viz-hit" });
            svg.append(hit);

            const move = (clientX) => {
                const rect = svg.getBoundingClientRect();
                const px = ((clientX - rect.left) / rect.width) * W;
                const kmh = ((px - m.l) / iw) * chart.xMax;
                setHover(nearestRow(chart, Math.max(0, Math.min(chart.xMax, kmh))));
            };
            hit.addEventListener("pointermove", (e) => move(e.clientX));
            hit.addEventListener("pointerdown", (e) => move(e.clientX));
            hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") setHover(-1); });
            svg.addEventListener("keydown", (e) => {
                const n = chart.rows.length;
                if (!n) return;
                const stepRows = Math.max(1, Math.round(5 / (chart.rows[1] ? chart.rows[1].kmh - chart.rows[0].kmh : 5)));
                if (e.key === "ArrowRight") { setHover(Math.min(n - 1, (hover < 0 ? -1 : hover) + stepRows)); e.preventDefault(); }
                else if (e.key === "ArrowLeft") { setHover(Math.max(0, (hover < 0 ? n : hover) - stepRows)); e.preventDefault(); }
                else if (e.key === "Home") { setHover(0); e.preventDefault(); }
                else if (e.key === "End") { setHover(n - 1); e.preventDefault(); }
                else if (e.key === "Escape") setHover(-1);
            });
            svg.addEventListener("focus", () => { if (hover < 0 && chart.eco) setHover(nearestRow(chart, chart.eco.best)); });
            svg.addEventListener("blur", () => setHover(-1));

            if (old) old.replaceWith(svg); else plot.prepend(svg);
            if (hover >= chart.rows.length) hover = -1;
            setHover(hover);
        }

        // Narrow screens: the readout is docked above the chart and always shows a speed
        // (the best one until the rider touches the chart), so it never covers the curve.
        const DOCK_BELOW = 560;
        function setHover(i) {
            hover = i;
            const cross = svg && svg.querySelector(".mu-viz-cross");
            if (!cross || !geom) return;
            const docked = plot.clientWidth > 0 && plot.clientWidth < DOCK_BELOW;
            tip.classList.toggle("is-docked", docked);
            if (docked && (i < 0 || !chart.rows[i]) && chart.rows.length) {
                const fallback = chart.eco ? nearestRow(chart, chart.eco.best) : 0;
                fillTip(chart.rows[fallback]);
                tip.hidden = false;
                tip.style.left = ""; tip.style.top = "";
                cross.setAttribute("visibility", "hidden");
                return;
            }
            if (i < 0 || !chart.rows[i]) { cross.setAttribute("visibility", "hidden"); tip.hidden = true; return; }
            const r = chart.rows[i];
            const cx = geom.x(r.kmh);
            const cy = Number.isFinite(r.value) ? geom.y(r.value) : geom.m.t;
            cross.setAttribute("visibility", "visible");
            const [line, dot] = cross.children;
            line.setAttribute("x1", String(cx)); line.setAttribute("x2", String(cx));
            dot.setAttribute("cx", String(cx)); dot.setAttribute("cy", String(cy));
            dot.setAttribute("visibility", r.feasible && Number.isFinite(r.value) ? "visible" : "hidden");
            fillTip(r);
            tip.hidden = false;
            if (docked) { tip.style.left = ""; tip.style.top = ""; return; }
            // keep the tooltip inside the plot
            const rect = svg.getBoundingClientRect(), scale = rect.width / geom.W;
            const tw = tip.offsetWidth || 160;
            let left = cx * scale + 12;
            if (left + tw > rect.width) left = cx * scale - tw - 12;
            tip.style.left = `${Math.max(0, left)}px`;
            tip.style.top = `${Math.max(0, geom.m.t * scale)}px`;
        }

        function fillTip(r) {
            const rows = [];
            rows.push(h("p", { class: "mu-tip-speed", text: `${U.num(r.kmh, 0)} km/h` }));
            if (!r.feasible) rows.push(h("p", { class: "mu-tip-value", text: "Can't hold this speed here" }));
            else if (!chart.ev && !Number.isFinite(r.value)) rows.push(h("p", { class: "mu-tip-value", text: "No fuel used" }));
            else if (chart.ev) {
                rows.push(h("p", { class: "mu-tip-value" }, [h("span", { class: "mu-tip-key" }), r.value < 0 ? `Charging ${U.num(-r.value, 0)} Wh/km` : `${U.num(r.value, 0)} Wh/km`]));
                rows.push(h("p", { class: "mu-tip-sub", text: `likely ${U.num(r.lo, 0)} to ${U.num(r.hi, 0)}` }));
                if (r.value > 0 && Number.isFinite(r.range)) rows.push(h("p", { class: "mu-tip-sub", text: `range about ${U.smart(r.range)} km (${U.smart(r.rangeLo)}–${Number.isFinite(r.rangeHi) ? U.smart(r.rangeHi) : "∞"})` }));
            } else {
                rows.push(h("p", { class: "mu-tip-value" }, [h("span", { class: "mu-tip-key" }), `${U.smart(r.value)} ${chart.unit}`]));
                rows.push(h("p", { class: "mu-tip-sub", text: `likely ${U.smart(r.lo)}–${Number.isFinite(r.hi) ? U.smart(r.hi) : "∞"}` }));
            }
            const facts = [];
            if (model.drive.kind === "manual" && r.gear > 0) facts.push(`gear ${r.gear}`);
            if (!chart.ev && r.rpm > 0) facts.push(`${U.num(Math.round(r.rpm / 50) * 50, 0)} rpm`);
            facts.push(`${U.num(r.wheelKw, 1)} kW at the wheel`);
            rows.push(h("p", { class: "mu-tip-sub", text: facts.join(", ") }));
            tip.replaceChildren(...rows);
        }

        function summary() {
            const hl = headline(chart, road.grade);
            return `${chart.metric} by steady speed on a ${road.label.toLowerCase()} road. ${hl.lead}${hl.range ? ` at ${hl.range}` : ""}. ${hl.detail}.`;
        }

        // ---------------- shift guide ----------------
        function renderShifts() {
            shifts.replaceChildren();
            ribbonNote.textContent = chart.ev
                ? "The shaded band is the likely range: drag area, rolling resistance, efficiencies, rider mass and tyre size are uncertain until the app learns your riding."
                : "The shaded band is the likely range: drag area, rolling resistance, engine friction and efficiency, rider mass and tyre size are uncertain until the app learns your riding.";
            if (model.drive.kind !== "manual") {
                shifts.append(h("p", { class: "mu-viz-muted", text: chart.ev ? "Single-speed drive: nothing to shift." : "Automatic (CVT): no gear changes to advise." }));
                return;
            }
            shifts.append(h("h3", { text: "When to change gear" }));
            if (!shift || !shift.advisory) {
                shifts.append(h("p", { class: "mu-viz-muted", text: NO_GEAR_ADVICE[(shift && shift.reason) || model.gearAdviceReason] || NO_GEAR_ADVICE["borrowed-gearing"] }));
                return;
            }
            const tbl = h("table", { class: "mu-shift-table" });
            tbl.append(h("thead", {}, [h("tr", {}, [h("th", { scope: "col", text: "Change" }), h("th", { scope: "col", text: "Easy riding" }), h("th", { scope: "col", text: "Full throttle" })])]));
            const tb = h("tbody");
            shift.ecoUp.forEach((e, i) => {
                const p = shift.perfUp[i];
                const cell = (sp) => h("td", {}, [
                    h("span", { class: "mu-shift-speed", text: `${U.num(U.kmh(sp.speed), 0)} km/h` }),
                    h("span", { class: "mu-shift-rpm", text: `${U.num(Math.round(U.rpm(sp.omegaFrom) / 50) * 50, 0)} rpm${sp.atRedline ? ", at the redline" : ""}` })
                ]);
                tb.append(h("tr", {}, [h("th", { scope: "row" }, [gearChip(e.from), h("span", { class: "mu-shift-arrow", "aria-label": "to", text: "›" }), gearChip(e.to)]), cell(e), cell(p)]));
            });
            tbl.append(tb);
            shifts.append(tbl);
        }
        const gearChip = (g) => {
            const ci = Math.min(GEAR_RAMP.length - 1, g - 1);
            const el = h("span", { class: "mu-gear-chip", text: String(g) });
            el.style.background = GEAR_RAMP[ci];
            el.style.color = GEAR_INK[ci];
            return el;
        };

        // ---------------- table view (the chart's accessible twin) ----------------
        function renderTable() {
            const open = tableBox.open;
            tableBox.replaceChildren(h("summary", { text: "Show the numbers" }));
            const tbl = h("table", { class: "mu-num-table" });
            const manual = model.drive.kind === "manual";
            tbl.append(h("thead", {}, [h("tr", {}, [
                h("th", { scope: "col", text: "km/h" }),
                manual ? h("th", { scope: "col", text: "Gear" }) : null,
                h("th", { scope: "col", text: chart.unit }),
                h("th", { scope: "col", text: "Likely" }),
                chart.ev ? h("th", { scope: "col", text: "Range km" }) : null
            ])]));
            const tb = h("tbody");
            let nextKmh = 10;
            for (const r of chart.rows) {
                if (r.kmh + 0.5 < nextKmh) continue;
                nextKmh += 10;
                tb.append(h("tr", { class: r.feasible ? "" : "is-blocked" }, [
                    h("td", { text: U.num(r.kmh, 0) }),
                    manual ? h("td", { text: r.gear > 0 ? String(r.gear) : "–" }) : null,
                    h("td", { text: !r.feasible ? "can't hold" : chart.ev ? U.num(r.value, 0) : Number.isFinite(r.value) ? U.smart(r.value) : "no fuel" }),
                    h("td", { text: !r.feasible ? "" : chart.ev ? `${U.num(r.lo, 0)} to ${U.num(r.hi, 0)}` : Number.isFinite(r.value) ? `${U.smart(r.lo)}–${Number.isFinite(r.hi) ? U.smart(r.hi) : "∞"}` : "" }),
                    chart.ev ? h("td", { text: r.feasible && r.value > 0 && Number.isFinite(r.range) ? U.smart(r.range) : r.feasible ? "charging" : "" }) : null
                ]));
            }
            tbl.append(tb);
            tableBox.append(tbl);
            tableBox.open = open;
        }

        // responsive: redraw on width changes
        let ro = null, lastW = 0;
        if (typeof ResizeObserver !== "undefined") {
            ro = new ResizeObserver(() => { const w = Math.round(plot.clientWidth); if (w && Math.abs(w - lastW) > 2) { lastW = w; renderPlot(); } });
            ro.observe(plot);
        }
        recompute();

        return {
            /** Replace the bike, settings or conditions. */
            update(next) { Object.assign(o, next); if (next.settings) pillion = !!next.settings.pillionMass || pillion; syncControls(); recompute(); },
            get chart() { return chart; },
            get model() { return model; },
            destroy() { if (ro) ro.disconnect(); root.replaceChildren(); root.classList.remove("mu-viz"); }
        };
    }

    return { GEAR_RAMP, ROADS, prepareChart, niceTicks, nearestRow, headline, createVisualizer };
});
