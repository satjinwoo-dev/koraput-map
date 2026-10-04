// @ts-check
/* ============================================================================
   MapUnite rides — the "Ride summaries" dashboard (roadmap step 10, view)
   ==============================================================================
   MURides.ui.createRidesView(root, deps) → { render(records, ctx), destroy() }
     deps: { units, model, onShare?(rec), onDelete?(id), onOpenConsent?(), onWipe?(), onClose?() }
     ctx:  { fleet: MUFleet status, storeKind: "indexeddb"|"memory" }

   Everything shown comes from this phone. One filter row (7 days · 30 days ·
   12 months · All) scopes the tiles, the chart and the list. The chart is one
   series (distance per day/month) in the app's mint; hover or focus a bar for
   its numbers, click it to narrow the list to that day; "Table" shows the same
   numbers as a table. Every ride opens to its own page: a north-up drawing of
   the route (no map tiles: nothing is fetched), its numbers, Share, Delete.
   The "Your data" card at the bottom: anonymous sharing status and the
   "Delete my history" button.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MURides || (/** @type {any} */ (root).MURides = {}); ns.ui = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const NS = "http://www.w3.org/2000/svg";
    const BAR = "#34e0b4", BAR_SEL = "#8ff2d6";
    const ICON = {
        x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
        back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>`,
        share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M16 6l-4-4-4 4M12 2v14"/></svg>`,
        trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>`,
        phone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>`,
        cloud: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.5A4 4 0 0 0 6 19z"/></svg>`,
        table: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/></svg>`,
        chart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>`,
        leaf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z"/><path d="M5 19 13 11"/></svg>`
    };

    // ------------------------------------------------------------------ pure helpers (tested)
    /** @param {number|null} s */
    function ecoWord(s) { return s === null || s === undefined ? "" : s >= 0.85 ? "Smooth" : s >= 0.7 ? "Steady" : s >= 0.5 ? "Mixed" : "Rough"; }
    /** h:mm for long, "N min" for short. @param {number} sec */
    function dur(sec) {
        const m = Math.round(Math.max(0, sec) / 60);
        if (m < 60) return { value: String(m), unit: "min" };
        return { value: `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`, unit: "h" };
    }
    /** The headline tiles for a rollup's totals. @param {any} t @param {any} U */
    function tiles(t, U) {
        const d = dur(t.moving);
        const out = [
            { key: "rides", label: "Rides", value: String(t.rides), unit: "", note: "" },
            { key: "distance", label: "Distance", value: U.num(t.distance / 1000, t.distance < 100000 ? 1 : 0), unit: "km", note: t.rides ? `${U.num(t.distance / 1000 / t.rides, 1)} km a ride` : "" },
            { key: "time", label: "Riding time", value: d.value, unit: d.unit, note: "" }
        ];
        if (t.evEnergy > 0 && !(t.fuel > 0)) out.push({ key: "energy", label: "Energy", value: U.num(t.evEnergy / 3.6e6, 1), unit: "kWh", note: "" });
        else out.push({ key: "fuel", label: "Fuel", value: U.num(t.fuel * 1000, t.fuel * 1000 < 10 ? 2 : 1), unit: "L", note: t.economy ? `${U.num(t.economy, 1)} km/L` : "" });
        out.push({ key: "cost", label: "Spent", value: t.cost === null ? "–" : `₹${U.num(t.cost, 0)}`, unit: "", note: t.cost === null ? "set a price in a trip" : t.costRides < t.rides ? `${t.costRides} of ${t.rides} rides priced` : "" });
        out.push({ key: "eco", label: "Eco score", value: t.eco === null ? "–" : String(Math.round(t.eco * 100)), unit: "", note: t.eco === null ? "from rides with the HUD on" : ecoWord(t.eco) });
        return out;
    }
    /** Group records by local day, newest first: [{ key, label, rides }]. @param {any[]} recs @param {number} [now] */
    function byDay(recs, now = Date.now()) {
        const out = [];
        const today = new Date(now); const y = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
        const k = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        for (const r of recs) {
            const d = new Date(r.startedAt);
            const key = k(d);
            let g = out[out.length - 1];
            if (!g || g.key !== key) {
                const label = key === k(today) ? "Today" : key === k(y) ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
                g = { key, label, rides: [] }; out.push(g);
            }
            g.rides.push(r);
        }
        return out;
    }

    // ------------------------------------------------------------------ DOM
    /**
     * @template {keyof HTMLElementTagNameMap} K
     * @param {K} tag @param {Record<string, any>} [attrs] @param {Array<Node|string|null|false|undefined>} [kids]
     * @returns {HTMLElementTagNameMap[K]}
     */
    function h(tag, attrs = {}, kids = []) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === "class") el.className = v;
            else if (k === "text") el.textContent = v;
            else if (k === "html") el.innerHTML = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c !== null && c !== false && c !== undefined) el.append(c);
        return el;
    }
    function s(tag, attrs = {}) { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v)); return el; }

    /**
     * @param {HTMLElement} root
     * @param {{ units: any, model: any, onShare?: (r: any) => void, onDelete?: (id: string) => Promise<void>|void, onOpenConsent?: () => void, onWipe?: () => void, onClose?: () => void, now?: () => number }} deps
     */
    function createRidesView(root, deps) {
        const U = deps.units, M = deps.model, now = deps.now || Date.now;
        root.classList.add("rds");
        let records = [], ctx = {}, range = "30d", bucket = null, openId = null, asTable = false, ro = null, roll = null;

        const sub = h("p", { class: "rds-sub" });
        const seg = h("div", { class: "rds-seg", role: "radiogroup", "aria-label": "Time range" });
        const tileBox = h("div", { class: "rds-tiles" });
        const chartTitle = h("h3", { class: "rds-h", text: "Distance" });
        const viewBtn = h("button", { type: "button", class: "rds-ghost rds-viewbtn", "aria-pressed": "false", onclick: () => { asTable = !asTable; renderChart(); } });
        const plot = h("div", { class: "rds-plot" });
        const tip = h("div", { class: "rds-tip", hidden: true, "aria-hidden": "true" });
        const chartTable = h("div", { class: "rds-chart-table", hidden: true });
        const chip = h("div", { class: "rds-chip-row" });
        const list = h("div", { class: "rds-list" });
        const detail = h("section", { class: "rds-detail", hidden: true, "aria-label": "Ride" });
        const dataCard = h("section", { class: "rds-data", "aria-labelledby": "rds-data-h" });
        const main = h("div", { class: "rds-main" }, [
            seg, tileBox,
            h("figure", { class: "rds-chart" }, [h("div", { class: "rds-chart-head" }, [chartTitle, viewBtn]), h("div", { class: "rds-plot-wrap" }, [plot, tip]), chartTable]),
            h("section", { class: "rds-rides", "aria-labelledby": "rds-rides-h" }, [h("div", { class: "rds-rides-head" }, [h("h3", { id: "rds-rides-h", class: "rds-h", text: "Rides" }), chip]), list]),
            dataCard
        ]);
        root.replaceChildren(
            h("header", { class: "rds-head" }, [
                h("div", {}, [h("h2", { class: "rds-title", id: "rds-title", text: "Ride summaries" }), sub]),
                deps.onClose ? h("button", { type: "button", class: "rds-close", "aria-label": "Close", html: ICON.x, onclick: () => deps.onClose && deps.onClose() }) : null
            ]),
            main, detail
        );
        for (const [k, label] of [["7d", "7 days"], ["30d", "30 days"], ["12m", "12 months"], ["all", "All"]]) {
            seg.append(h("button", { type: "button", role: "radio", class: "rds-seg-btn", "data-v": k, "aria-checked": String(k === range), text: label, onclick: () => { range = k; bucket = null; for (const b of seg.children) b.setAttribute("aria-checked", String(b.getAttribute("data-v") === range)); renderAll(); } }));
        }

        function renderAll() {
            roll = M.rollup(records, range, now());
            const first = records.length ? records[records.length - 1].startedAt : null;
            sub.textContent = records.length ? `On this phone · ${records.length} ride${records.length === 1 ? "" : "s"} since ${new Date(/** @type {number} */ (first)).toLocaleDateString(undefined, { month: "short", year: "numeric" })}${ctx.storeKind === "memory" ? " · not saved in this private window" : ""}` : "On this phone · nothing yet";
            tileBox.replaceChildren(...tiles(roll.totals, U).map((t) => h("div", { class: `rds-tile is-${t.key}` }, [h("span", { class: "rds-tile-l", text: t.label }), h("span", { class: "rds-tile-v" }, [t.value, t.unit ? h("small", { text: ` ${t.unit}` }) : null]), t.note ? h("span", { class: "rds-tile-n", text: t.note }) : null])));
            renderChart(); renderList(); renderData();
        }

        // ---------------- chart
        function renderChart() {
            const B = roll ? roll.buckets : [];
            viewBtn.replaceChildren(h("span", { class: "rds-i", "aria-hidden": "true", html: asTable ? ICON.chart : ICON.table }), asTable ? "Chart" : "Table");
            viewBtn.setAttribute("aria-pressed", String(asTable));
            chartTitle.textContent = range === "7d" || range === "30d" ? "Distance per day" : "Distance per month";
            plot.hidden = asTable; chartTable.hidden = !asTable;
            if (asTable) {
                chartTable.replaceChildren(h("table", { class: "rds-table" }, [
                    h("thead", {}, [h("tr", {}, ["When", "Rides", "Distance", "Riding time", "Fuel", "Spent"].map((x) => h("th", { scope: "col", text: x })))]),
                    h("tbody", {}, B.slice().reverse().map((b) => h("tr", {}, [h("td", { text: b.long }), h("td", { class: "num", text: String(b.rides) }), h("td", { class: "num", text: `${U.num(b.distance / 1000, 1)} km` }), h("td", { class: "num", text: `${dur(b.moving).value} ${dur(b.moving).unit}` }), h("td", { class: "num", text: b.fuel > 0 ? `${U.num(b.fuel * 1000, 2)} L` : "–" }), h("td", { class: "num", text: b.cost > 0 ? `₹${U.num(b.cost, 0)}` : "–" })])))
                ]));
                return;
            }
            const W = Math.round(plot.clientWidth || 600), H = W < 520 ? 170 : 200;
            const ml = 34, mr = 6, mt = 12, mb = 22, pw = W - ml - mr, ph = H - mt - mb;
            const maxKm = Math.max(1, ...B.map((b) => b.distance / 1000));
            const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find((x) => maxKm / x <= 4) || 10000;
            const top = Math.ceil(maxKm / step) * step;
            const Y = (km) => mt + ph - (km / top) * ph;
            const svg = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "rds-svg", role: "img", "aria-label": `${chartTitle.textContent}: ${B.filter((b) => b.rides).length} of ${B.length} with rides, longest ${U.num(maxKm, 1)} km. The table view lists every value.` });
            for (let v = 0; v <= top + 1e-9; v += step) {
                svg.append(s("line", { x1: ml, x2: ml + pw, y1: Y(v), y2: Y(v), stroke: v === 0 ? "rgba(255,255,255,.16)" : "rgba(255,255,255,.07)", "shape-rendering": "crispEdges" }));
                const t = s("text", { x: ml - 6, y: Y(v) + 4, "text-anchor": "end", class: "rds-ax" }); t.textContent = v === top ? `${U.num(v, 0)} km` : U.num(v, 0); svg.append(t);
            }
            const slot = pw / Math.max(1, B.length), bw = Math.max(2, Math.min(36, slot - 2));
            const every = B.length > 14 ? Math.ceil(B.length / (W < 520 ? 6 : 10)) : 1;
            B.forEach((b, i) => {
                const x = ml + i * slot + (slot - bw) / 2, km = b.distance / 1000;
                const y = Y(km), hgt = Math.max(0, mt + ph - y);
                const sel = bucket === b.key;
                if (hgt > 0) {
                    const r = Math.min(4, bw / 2, hgt);
                    svg.append(s("path", { d: `M${x},${mt + ph}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${mt + ph}Z`, fill: sel ? BAR_SEL : BAR, "fill-opacity": bucket && !sel ? 0.45 : 1 }));
                }
                const hit = s("rect", { x: ml + i * slot, y: mt, width: slot, height: ph + 4, fill: "transparent", tabindex: b.rides ? 0 : -1, role: "button", "aria-label": `${b.long}: ${b.rides} ride${b.rides === 1 ? "" : "s"}, ${U.num(km, 1)} km`, class: "rds-hit" });
                const show = () => { tip.replaceChildren(h("strong", { text: b.long }), h("span", { text: b.rides ? `${b.rides} ride${b.rides === 1 ? "" : "s"} · ${U.num(km, 1)} km` : "No rides" }), b.rides ? h("span", { text: `${dur(b.moving).value} ${dur(b.moving).unit}${b.fuel > 0 ? ` · ${U.num(b.fuel * 1000, 2)} L` : ""}${b.cost > 0 ? ` · ₹${U.num(b.cost, 0)}` : ""}` }) : null); tip.hidden = false; const tw = tip.offsetWidth || 150; const cx = x + bw / 2; tip.style.left = `${Math.max(2, Math.min(W - tw - 2, cx - tw / 2))}px`; tip.style.top = `${Math.max(0, y - (tip.offsetHeight || 50) - 8)}px`; };
                hit.addEventListener("pointerenter", show); hit.addEventListener("focus", show);
                hit.addEventListener("pointerleave", () => { tip.hidden = true; }); hit.addEventListener("blur", () => { tip.hidden = true; });
                const pick = () => { if (!b.rides) return; bucket = bucket === b.key ? null : b.key; renderChart(); renderList(); };
                hit.addEventListener("click", pick);
                hit.addEventListener("keydown", (e) => { if (/** @type {KeyboardEvent} */ (e).key === "Enter" || /** @type {KeyboardEvent} */ (e).key === " ") { e.preventDefault(); pick(); } });
                svg.append(hit);
                if (i % every === 0 || i === B.length - 1) { const t = s("text", { x: ml + i * slot + slot / 2, y: H - 6, "text-anchor": "middle", class: "rds-ax" }); t.textContent = b.label; svg.append(t); }
            });
            plot.replaceChildren(svg);
            if (!ro && typeof ResizeObserver !== "undefined") { let lastW = W; ro = new ResizeObserver(() => { const w = Math.round(plot.clientWidth); if (w && Math.abs(w - lastW) > 2 && !asTable) { lastW = w; renderChart(); } }); ro.observe(plot); }
        }

        // ---------------- list
        function rideRow(r) {
            const e = M.economy(r);
            const thumb = s("svg", { width: 56, height: 42, viewBox: "0 0 56 42", class: "rds-thumb", "aria-hidden": "true" });
            const p = M.routePath(r.route, 56, 42, 5);
            if (p.d) { thumb.append(s("path", { d: p.d, fill: "none", stroke: BAR, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" })); if (p.end) thumb.append(s("circle", { cx: p.end[0], cy: p.end[1], r: 2.6, fill: "#f2f6f8" })); }
            const d = dur(r.moving || r.duration);
            const time = new Date(r.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
            return h("button", { type: "button", class: "rds-ride", onclick: () => openRide(r.id) }, [
                thumb,
                h("span", { class: "rds-ride-t" }, [h("strong", { text: M.rideName(r.startedAt) }), h("span", { text: [time, r.place, r.bike].filter(Boolean).join(" · ") })]),
                h("span", { class: "rds-ride-s" }, [
                    h("span", { class: "rds-ride-km", text: `${U.num(r.distance / 1000, r.distance < 10000 ? 1 : 0)} km` }),
                    h("span", { text: [`${d.value} ${d.unit}`, e ? `${U.num(e.value, e.unit === "km/L" ? 1 : 0)} ${e.unit}` : ""].filter(Boolean).join(" · ") })
                ]),
                r.ecoScore !== null && r.ecoScore !== undefined ? h("span", { class: `rds-eco is-${ecoWord(r.ecoScore).toLowerCase()}`, "aria-label": `Eco score ${Math.round(r.ecoScore * 100)}, ${ecoWord(r.ecoScore)}` }, [h("span", { class: "rds-i", "aria-hidden": "true", html: ICON.leaf }), String(Math.round(r.ecoScore * 100))]) : h("span", { class: "rds-eco is-none", text: "–", "aria-label": "No eco score" })
            ]);
        }
        function renderList() {
            const recs = roll ? roll.records.filter((r) => !bucket || M.dayKey(new Date(r.startedAt)) === bucket || M.monthKey(new Date(r.startedAt)) === bucket) : [];
            chip.replaceChildren();
            if (bucket) {
                const b = roll.buckets.find((x) => x.key === bucket);
                chip.append(h("button", { type: "button", class: "rds-chip", onclick: () => { bucket = null; renderChart(); renderList(); } }, [b ? b.long : bucket, h("span", { class: "rds-i", "aria-hidden": "true", html: ICON.x }), h("span", { class: "rds-sr", text: "Show all" })]));
            }
            if (!recs.length) {
                list.replaceChildren(h("div", { class: "rds-empty" }, [
                    h("strong", { text: records.length ? "No rides in this range" : "Your rides will appear here" }),
                    h("span", { text: records.length ? "Try a longer range." : "Start a drive (Safe Drive) or navigate somewhere: when you stop, the ride is summarised here, on this phone." })
                ]));
                return;
            }
            list.replaceChildren(...byDay(recs, now()).map((g) => h("div", { class: "rds-day" }, [h("h4", { class: "rds-day-h", text: g.label }), ...g.rides.map(rideRow)])));
        }

        // ---------------- one ride
        function openRide(id) {
            const r = records.find((x) => x.id === id);
            if (!r) return;
            openId = id;
            main.hidden = true; detail.hidden = false;
            const e = M.economy(r), d = dur(r.moving || r.duration);
            const W = Math.min(640, Math.round((root.clientWidth || 600) - 4)), H = 190;
            const art = s("svg", { width: "100%", height: H, viewBox: `0 0 ${W} ${H}`, class: "rds-art", role: "img", "aria-label": `Route drawing of this ride, north up, ${U.num(r.distance / 1000, 1)} km` });
            const p = M.routePath(r.route, W, H, 16);
            if (p.d) {
                art.append(s("path", { d: p.d, fill: "none", stroke: BAR, "stroke-opacity": 0.25, "stroke-width": 10, "stroke-linejoin": "round", "stroke-linecap": "round" }));
                art.append(s("path", { d: p.d, fill: "none", stroke: BAR, "stroke-width": 3, "stroke-linejoin": "round", "stroke-linecap": "round" }));
                if (p.start) art.append(s("circle", { cx: p.start[0], cy: p.start[1], r: 6, fill: BAR, stroke: "#0e1724", "stroke-width": 2 }));
                if (p.end) art.append(s("circle", { cx: p.end[0], cy: p.end[1], r: 6, fill: "#0e1724", stroke: "#f2f6f8", "stroke-width": 2.5 }));
            } else { const t = s("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "rds-ax" }); t.textContent = "No route recorded"; art.append(t); }
            const stat = (label, value, unit) => h("div", { class: "rds-stat" }, [h("span", { class: "rds-stat-l", text: label }), h("span", { class: "rds-stat-v" }, [value, unit ? h("small", { text: ` ${unit}` }) : null])]);
            const ev = r.powertrain === "ev";
            detail.replaceChildren(
                h("div", { class: "rds-detail-head" }, [
                    h("button", { type: "button", class: "rds-back", onclick: closeRide }, [h("span", { class: "rds-i", "aria-hidden": "true", html: ICON.back }), "All rides"]),
                    h("div", {}, [h("h3", { class: "rds-detail-t", text: M.rideName(r.startedAt) }), h("p", { class: "rds-sub", text: [new Date(r.startedAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }), r.place, r.bike].filter(Boolean).join(" · ") })])
                ]),
                h("figure", { class: "rds-art-fig" }, [h("div", { class: "rds-art-wrap" }, [art]), h("figcaption", { class: "rds-art-note", text: "Drawn on this phone, no map tiles · north up · ● start ○ finish" })]),
                h("div", { class: "rds-stats" }, [
                    stat("Distance", U.num(r.distance / 1000, 1), "km"),
                    stat("Riding time", d.value, d.unit),
                    stat("Average", U.num((r.avgSpeed || 0) * 3.6, 0), "km/h"),
                    stat("Top speed", U.num((r.maxSpeed || 0) * 3.6, 0), "km/h"),
                    ev ? stat("Energy", r.evEnergy > 0 ? U.num(r.evEnergy / 3.6e6, 2) : "–", r.evEnergy > 0 ? "kWh" : "") : stat("Fuel", r.fuel > 0 ? U.num(r.fuel * 1000, 2) : "–", r.fuel > 0 ? "L" : ""),
                    stat(ev ? "Consumption" : "Mileage", e ? U.num(e.value, e.unit === "km/L" ? 1 : 0) : "–", e ? e.unit : ""),
                    stat("Cost", r.cost !== null && r.cost !== undefined ? `₹${U.num(r.cost, r.cost < 100 ? 1 : 0)}` : "–", ""),
                    stat("Eco score", r.ecoScore !== null && r.ecoScore !== undefined ? String(Math.round(r.ecoScore * 100)) : "–", r.ecoScore !== null && r.ecoScore !== undefined ? ecoWord(r.ecoScore) : ""),
                    stat("Harsh moments", r.harsh !== null && r.harsh !== undefined ? String(r.harsh) : "–", ""),
                    stat("Idling", dur(r.idleTime || 0).value, dur(r.idleTime || 0).unit)
                ]),
                h("p", { class: "rds-method", text: r.source === "hud" ? `Fuel and eco score from the physics model with live GPS${r.matched ? ", matched to your fill-ups" : ""}.` : "Estimated by Safe Drive from GPS speed (the riding dashboard wasn't on)." }),
                h("div", { class: "rds-actions" }, [
                    deps.onShare ? h("button", { type: "button", class: "rds-btn", onclick: () => deps.onShare && deps.onShare(r) }, [h("span", { class: "rds-i", "aria-hidden": "true", html: ICON.share }), "Share card"]) : null,
                    deps.onDelete ? h("button", { type: "button", class: "rds-ghost rds-danger", onclick: async () => { if (deps.onDelete) await deps.onDelete(r.id); } }, [h("span", { class: "rds-i", "aria-hidden": "true", html: ICON.trash }), "Delete this ride"]) : null
                ])
            );
            const b = detail.querySelector(".rds-back"); if (b) /** @type {HTMLElement} */ (b).focus();
        }
        function closeRide() { openId = null; detail.hidden = true; main.hidden = false; renderChart(); }

        // ---------------- your data
        function renderData() {
            const f = ctx.fleet || {};
            const on = Boolean(f.optedIn);
            const since = f.since ? new Date(f.since).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
            const line = on ? `On since ${since}. ${f.sentTotal || 0} tank${f.sentTotal === 1 ? "" : "s"} shared${f.queued ? `, ${f.queued} waiting to send` : ""}${f.lastError ? ` · last try: ${f.lastError}` : ""}.`
                : f.pendingDelete ? "Off. Deleting what you shared: it'll finish next time you're online." : "Off. Your fill-ups stay on this phone.";
            dataCard.replaceChildren(
                h("h3", { id: "rds-data-h", class: "rds-h", text: "Your data" }),
                h("div", { class: "rds-data-row" }, [h("span", { class: "rds-data-i", "aria-hidden": "true", html: ICON.phone }), h("span", { class: "rds-data-t" }, [h("strong", { text: "Ride summaries stay on this phone" }), h("span", { text: "Routes are drawn here without map tiles; nothing about these rides is uploaded." })])]),
                h("div", { class: "rds-data-row" }, [h("span", { class: `rds-data-i ${on ? "is-on" : ""}`, "aria-hidden": "true", html: ICON.cloud }), h("span", { class: "rds-data-t" }, [h("strong", { text: `Anonymous fuel data: ${on ? "On" : "Off"}` }), h("span", { text: line })]),
                    deps.onOpenConsent ? h("button", { type: "button", class: "rds-ghost", onclick: () => deps.onOpenConsent && deps.onOpenConsent(), text: on ? "Manage" : "Learn more" }) : null]),
                deps.onWipe ? h("button", { type: "button", class: "rds-wipe", onclick: () => deps.onWipe && deps.onWipe() }, [h("span", { class: "rds-i", "aria-hidden": "true", html: ICON.trash }), "Delete my history"]) : null
            );
        }

        return {
            /** @param {any[]} recs newest first @param {{ fleet?: any, storeKind?: string }} [c] */
            render(recs, c = {}) {
                records = (recs || []).slice().sort((a, b) => b.startedAt - a.startedAt); ctx = c;
                if (openId && !records.some((r) => r.id === openId)) closeRide();
                renderAll();
                if (openId) openRide(openId);
            },
            get openRideId() { return openId; },
            destroy() { if (ro) ro.disconnect(); root.replaceChildren(); root.classList.remove("rds"); }
        };
    }

    return { ecoWord, dur, tiles, byDay, createRidesView };
});
