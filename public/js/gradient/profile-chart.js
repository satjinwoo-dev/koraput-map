// @ts-check
/* ============================================================================
   MapUnite gradient — the elevation profile sheet (roadmap step 9, view)
   ==============================================================================
   MUGradient.view.createProfileView(root, { units, onFocusSection, onClose })
     → { render(result, ctx), setProgress(m|null), destroy() }

   One chart, one job: road height along the route, with
     - steep stretches drawn on the line itself (amber ≥ 6 %, red-orange ≥ 10 %)
       and in a lane under it with ▲ / ▼, so climb vs descent never rests on colour;
     - every section the gradient step FIXED (OSM bridge / tunnel, likely bridge or
       tunnel from the DEM, grade capped) as a grey band with an icon + word, and
       the raw terrain line it replaced drawn faintly inside it;
     - a crosshair + tooltip (pointer and keyboard: ← → Home End), your position
       while navigating;
     - the same information as a table ("Sections"), with a filter row above it,
       and "Show on map" for each row.
   The SVG is drawn at the container's real pixel size (ResizeObserver), so text
   stays crisp; numbers in table cells are tabular, the headline tiles are not.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUGradient || (/** @type {any} */ (root).MUGradient = {}); ns.view = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const NS = "http://www.w3.org/2000/svg";
    const COLORS = Object.freeze({ line: "#34e0b4", steep1: "#ffb020", steep2: "#ff6b5e", raw: "#8b9bab", band: "rgba(198,210,219,.13)", bandEdge: "rgba(198,210,219,.32)", grid: "rgba(255,255,255,.07)", axis: "#8b9bab", you: "#f2f6f8" });
    const ICON = {
        bridge: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8h20M4 8v10M20 8v10"/><path d="M4 18a8 8 0 0 1 16 0"/></svg>`,
        tunnel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20V12a9 9 0 0 1 18 0v8"/><path d="M8 20v-7a4 4 0 0 1 8 0v7"/><path d="M2 20h20"/></svg>`,
        likely: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6M12 17h.01"/></svg>`,
        capped: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18 12 6l8 12"/><path d="M3 10h18"/></svg>`,
        up: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`,
        down: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>`,
        map: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 4-6 2v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>`,
        offline: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 2 20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.7M19 12.9a10 10 0 0 0-2.3-1.6M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 11 5M12 20h.01"/></svg>`,
        check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>`,
        x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`
    };
    const KIND = {
        bridge: { word: "Bridge", icon: "bridge" }, tunnel: { word: "Tunnel", icon: "tunnel" },
        "likely-bridge": { word: "Likely bridge", icon: "likely" }, "likely-tunnel": { word: "Likely tunnel or cutting", icon: "likely" },
        capped: { word: "Terrain too steep, capped", icon: "capped" }
    };

    // ------------------------------------------------------------------ pure helpers (tested)
    /** Nice axis ticks covering [lo, hi]. @param {number} lo @param {number} hi @param {number} [count] */
    function niceTicks(lo, hi, count = 4) {
        if (!(hi > lo)) { const v = Math.round(lo); return { lo: v - 10, hi: v + 10, step: 10, ticks: [v - 10, v, v + 10] }; }
        const raw = (hi - lo) / Math.max(1, count);
        const p = 10 ** Math.floor(Math.log10(raw));
        const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw * 0.85) || 10 * p;   // one tick more beats a squashed plot
        const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
        const ticks = [];
        for (let v = a; v <= b + step * 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
        return { lo: a, hi: b, step, ticks };
    }

    /**
     * Rows for the sections table: climbs, descents and fixed sections in route order.
     * @param {any} result MUGradient.core.analyze() @param {any} U units
     * @returns {Array<{ key: string, type: "climb"|"descent"|"fixed", s0: number, s1: number, icon: string, what: string, where: string, length: string, detail: string, level: number, source?: string }>}
     */
    function tableRows(result, U) {
        const km = (m) => U.num(m / 1000, m < 100000 ? 1 : 0);
        const len = (m) => (m < 1000 ? `${U.num(Math.round(m / 10) * 10, 0)} m` : `${U.num(m / 1000, 1)} km`);
        const pct = (g) => `${U.num(Math.abs(g) * 100, Math.abs(g) < 0.1 ? 1 : 0)} %`;
        const rows = [];
        for (const x of result.sections || []) {
            const climb = x.kind === "climb";
            rows.push({
                key: `${x.kind}-${Math.round(x.s0)}`, type: climb ? "climb" : "descent", s0: x.s0, s1: x.s1, level: x.level,
                icon: climb ? "up" : "down", what: `${x.level === 2 ? "Very steep" : "Steep"} ${climb ? "climb" : "descent"}`,
                where: `km ${km(x.s0)}–${km(x.s1)}`, length: len(x.length),
                detail: `${pct(x.avgGrade)} average, ${pct(x.maxGrade)} at most · ${climb ? "↑" : "↓"} ${U.num(Math.abs(x.rise), 0)} m`
            });
        }
        for (const x of result.structures || []) {
            const k = /** @type {any} */ (KIND)[x.kind] || { word: x.kind, icon: "likely" };
            const off = x.deviation ? `terrain model was ${U.num(x.deviation, 0)} m off` : "";
            const g = Number.isFinite(x.grade) ? `now ${x.grade >= 0 ? "+" : "−"}${pct(x.grade)}` : "";
            const src = x.source === "osm" ? "OpenStreetMap" : x.source === "dem" ? "found in the terrain data" : "grade cap";
            rows.push({
                key: `${x.kind}-${Math.round(x.s0)}`, type: "fixed", s0: x.s0, s1: x.s1, level: 0, source: x.source,
                icon: k.icon, what: x.name ? `${k.word}: ${x.name}` : k.word,
                where: `km ${km(x.s0)}–${km(x.s1)}`, length: len(Math.max(0, x.s1 - x.s0)),
                detail: [off, g, src].filter(Boolean).join(" · ")
            });
        }
        return /** @type {any} */ (rows.sort((a, b) => a.s0 - b.s0 || (a.type === "fixed" ? 1 : -1)));
    }

    /** Header status lines (data provenance), words only. @param {any} meta */
    function provenance(meta) {
        const out = [];
        const e = meta.elevation || {};
        if (e.source === "none") out.push({ tone: "warn", icon: "offline", text: meta.offline ? "Offline and this route's hills aren't saved yet: shown flat" : "Terrain heights unavailable: shown flat" });
        else if (e.source === "partial") out.push({ tone: "info", icon: "offline", text: `Some heights missing (${Math.round((e.missing / Math.max(1, e.total)) * 100)} %): filled in between` });
        else out.push({ tone: "ok", icon: "check", text: e.fetched > 0 ? "Terrain: Copernicus 90 m (Open-Meteo), saved for offline" : "Terrain: saved on this phone (works offline)" });
        const s = meta.structureSource;
        if (s === "network") out.push({ tone: "ok", icon: "check", text: "Bridges & tunnels: OpenStreetMap, saved for 30 days" });
        else if (s === "cache") out.push({ tone: "ok", icon: "check", text: "Bridges & tunnels: saved on this phone" });
        else if (s === "stale") out.push({ tone: "info", icon: "offline", text: "Bridges & tunnels: saved copy older than 30 days" });
        else out.push({ tone: "info", icon: "offline", text: "Bridges & tunnels: not checked (offline). Terrain spikes still fixed." });
        return out;
    }

    // ------------------------------------------------------------------ DOM helpers
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
    /** @param {string} tag @param {Record<string, any>} [attrs] */
    function s(tag, attrs = {}) {
        const el = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
        return el;
    }

    /**
     * @param {HTMLElement} root
     * @param {{ units: any, core: any, onFocusSection?: (sec: { s0: number, s1: number, what: string }|null) => void, onClose?: () => void }} deps
     */
    function createProfileView(root, deps) {
        const U = deps.units, core = deps.core;
        root.classList.add("grd");
        let result = null, meta = {}, progress = null, cursor = null, selected = null, filter = "all", ro = null, W = 0;

        const title = h("h2", { class: "grd-title", id: "grd-title", text: "Elevation & gradient" });
        const sub = h("p", { class: "grd-sub" });
        const prov = h("ul", { class: "grd-prov", "aria-label": "Where the data comes from" });
        const tiles = h("div", { class: "grd-tiles" });
        const plot = h("div", { class: "grd-plot", tabindex: "0", role: "img", "aria-describedby": "grd-table-cap" });
        const tip = h("div", { class: "grd-tip", hidden: true, "aria-hidden": "true" });
        const legend = h("ul", { class: "grd-legend", "aria-label": "Legend" });
        const filters = h("div", { class: "grd-filters", role: "radiogroup", "aria-label": "Show in the table" });
        const tbody = h("tbody");
        const empty = h("p", { class: "grd-empty", hidden: true });
        const table = h("table", { class: "grd-table" }, [
            h("caption", { id: "grd-table-cap", class: "grd-sr", text: "Steep sections and fixed sections along the route" }),
            h("thead", {}, [h("tr", {}, [h("th", { scope: "col", text: "Where" }), h("th", { scope: "col", text: "What" }), h("th", { scope: "col", text: "Length" }), h("th", { scope: "col", text: "Details" }), h("th", { scope: "col" }, [h("span", { class: "grd-sr", text: "Map" })])])]),
            tbody
        ]);
        root.replaceChildren(
            h("header", { class: "grd-head" }, [
                h("div", {}, [title, sub]),
                deps.onClose ? h("button", { type: "button", class: "grd-close", "aria-label": "Close", html: ICON.x, onclick: () => deps.onClose && deps.onClose() }) : null
            ]),
            prov, tiles,
            h("figure", { class: "grd-fig" }, [h("div", { class: "grd-plot-wrap" }, [plot, tip]), legend]),
            h("section", { class: "grd-sections", "aria-labelledby": "grd-sec-h" }, [
                h("div", { class: "grd-sec-head" }, [h("h3", { id: "grd-sec-h", text: "Sections" }), filters]),
                h("div", { class: "grd-table-wrap" }, [table]), empty
            ])
        );

        // ---------------- legend + filters (static)
        const legendItem = (cls, text) => h("li", {}, [h("span", { class: `grd-sw ${cls}`, "aria-hidden": "true" }), text]);
        legend.append(legendItem("is-line", "Road height"), legendItem("is-steep1", "Steep (6–10 %)"), legendItem("is-steep2", "Very steep (10 % +)"), legendItem("is-band", "Fixed: bridge, tunnel or spike"), legendItem("is-raw", "Terrain model before fixing"));
        const FILTERS = [["all", "All"], ["climb", "Climbs"], ["descent", "Descents"], ["fixed", "Bridges & tunnels"]];
        for (const [k, label] of FILTERS) filters.append(h("button", { type: "button", role: "radio", class: "grd-filter", "data-v": k, "aria-checked": String(k === filter), text: label, onclick: () => { filter = k; for (const b of filters.children) b.setAttribute("aria-checked", String(b.getAttribute("data-v") === filter)); renderTable(); } }));

        // ---------------- interaction
        function sAtClientX(clientX) {
            const r = plot.getBoundingClientRect(), L = geom();
            if (!L || !result) return null;
            const x = Math.max(L.ml, Math.min(L.ml + L.pw, clientX - r.left));
            return ((x - L.ml) / L.pw) * result.profile.distance;
        }
        plot.addEventListener("pointermove", (e) => { const v = sAtClientX(e.clientX); if (v !== null) { cursor = v; drawCursor(); } });
        plot.addEventListener("pointerdown", (e) => { const v = sAtClientX(e.clientX); if (v !== null) { cursor = v; drawCursor(); } });
        plot.addEventListener("pointerleave", () => { if (document.activeElement !== plot) { cursor = null; drawCursor(); } });
        plot.addEventListener("blur", () => { cursor = null; drawCursor(); });
        plot.addEventListener("keydown", (e) => {
            if (!result) return;
            const D = result.profile.distance, step = D / 100;
            let v = cursor === null ? (progress ?? 0) : cursor;
            if (e.key === "ArrowRight") v += e.shiftKey ? step * 10 : step;
            else if (e.key === "ArrowLeft") v -= e.shiftKey ? step * 10 : step;
            else if (e.key === "Home") v = 0;
            else if (e.key === "End") v = D;
            else return;
            e.preventDefault();
            cursor = Math.max(0, Math.min(D, v)); drawCursor();
        });

        // ---------------- layout
        function geom() {
            if (!result || !W) return null;
            const narrow = W < 520;
            const ml = narrow ? 40 : 48, mr = 12, mt = 30, laneH = 10, mb = 26;
            const H = narrow ? 230 : 290;
            const pw = Math.max(40, W - ml - mr), ph = H - mt - mb - laneH - 8;
            const p = result.profile;
            const zs = [p.zMin, p.zMax];
            if (result.raw) for (const iv of result.structures) for (let i = 0; i < result.raw.s.length; i++) if (result.raw.s[i] >= iv.s0 && result.raw.s[i] <= iv.s1) zs.push(result.raw.z[i]);
            const zLo = Math.min(...zs), zHi = Math.max(...zs);
            const pad = Math.max(8, (zHi - zLo) * 0.08);
            const yt = niceTicks(zLo - pad, zHi + pad, narrow ? 3 : 4);
            const D = p.distance || 1;
            return {
                W, H, ml, mr, mt, pw, ph, laneY: mt + ph + 6, laneH, yt,
                X: (m) => ml + (m / D) * pw,
                Y: (z) => mt + ph - ((z - yt.lo) / (yt.hi - yt.lo || 1)) * ph
            };
        }

        let svg = null, cursorG = null;
        function draw() {
            if (!result) return;
            W = Math.round(plot.clientWidth || plot.getBoundingClientRect().width || 0);
            const L = geom();
            if (!L) return;
            const p = result.profile, D = p.distance;
            svg = s("svg", { width: L.W, height: L.H, viewBox: `0 0 ${L.W} ${L.H}`, class: "grd-svg", "aria-hidden": "true", focusable: "false" });
            // grid + y axis
            for (const t of L.yt.ticks) {
                const y = L.Y(t);
                svg.append(s("line", { x1: L.ml, x2: L.ml + L.pw, y1: y, y2: y, stroke: COLORS.grid, "stroke-width": 1, "shape-rendering": "crispEdges" }));
                const tx = s("text", { x: L.ml - 8, y: y + 4, "text-anchor": "end", class: "grd-ax" }); tx.textContent = U.num(t, 0); svg.append(tx);
            }
            { const u = s("text", { x: L.ml - 8, y: L.mt - 8, "text-anchor": "end", class: "grd-ax" }); u.textContent = "m"; svg.append(u); }
            // x axis: km ticks
            const xt = niceTicks(0, D / 1000, W < 520 ? 4 : 6);
            for (const k of xt.ticks) {
                if (k * 1000 > D + 1) continue;
                const x = L.X(k * 1000);
                const tx = s("text", { x, y: L.H - 6, "text-anchor": k === 0 ? "start" : "middle", class: "grd-ax" }); tx.textContent = `${U.num(k, xt.step < 1 ? 1 : 0)}${k === 0 ? " km" : ""}`; svg.append(tx);
            }
            // fixed sections: bands, icons, labels (a label only where it clears the next band's icon)
            let lastLabelRight = -Infinity;
            const centers = result.structures.map((q) => (L.X(q.s0) + Math.max(L.X(q.s1), L.X(q.s0) + 3)) / 2);
            for (const [bi, iv] of result.structures.entries()) {
                const x0 = L.X(iv.s0), x1 = Math.max(L.X(iv.s1), x0 + 3);
                const isSel = selected && selected.key === `${iv.kind}-${Math.round(iv.s0)}`;
                svg.append(s("rect", { x: x0, y: L.mt, width: x1 - x0, height: L.ph, fill: COLORS.band, stroke: isSel ? COLORS.you : COLORS.bandEdge, "stroke-width": isSel ? 1.5 : 1, rx: 2 }));
                const k = /** @type {any} */ (KIND)[iv.kind] || KIND["likely-bridge"];
                const cx = (x0 + x1) / 2;
                const ic = s("g", { transform: `translate(${cx - 7},${L.mt - 22})`, class: "grd-band-ic" });
                ic.innerHTML = ICON[k.icon].replace("<svg ", '<svg width="14" height="14" ');
                svg.append(ic);
                const label = k.word.split(" ")[0] === "Likely" ? "Likely" : k.word.split(",")[0];
                const lw = label.length * 6.4 + 4;
                const nextIcon = bi + 1 < centers.length ? centers[bi + 1] - 10 : Infinity;
                if (cx + 10 + lw < Math.min(L.ml + L.pw, nextIcon) && cx - 9 > lastLabelRight) {
                    const tx = s("text", { x: cx + 10, y: L.mt - 11, class: "grd-band-t" }); tx.textContent = label; svg.append(tx);
                    lastLabelRight = cx + 10 + lw;
                } else lastLabelRight = Math.max(lastLabelRight, cx + 9);
            }
            // area + line
            const n = p.s.length;
            let dLine = "", dArea = "";
            for (let i = 0; i < n; i++) { const x = L.X(p.s[i]), y = L.Y(p.z[i]); dLine += `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`; }
            dArea = `${dLine}L${L.X(p.s[n - 1]).toFixed(1)},${(L.mt + L.ph).toFixed(1)}L${L.X(p.s[0]).toFixed(1)},${(L.mt + L.ph).toFixed(1)}Z`;
            const gid = `grd-grad-${Math.random().toString(36).slice(2, 7)}`;
            const defs = s("defs"), lg = s("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
            lg.append(s("stop", { offset: "0", "stop-color": COLORS.line, "stop-opacity": "0.28" }), s("stop", { offset: "1", "stop-color": COLORS.line, "stop-opacity": "0.02" }));
            defs.append(lg); svg.append(defs);
            svg.append(s("path", { d: dArea, fill: `url(#${gid})` }));
            // raw terrain line inside fixed sections (what was removed)
            if (result.raw) for (const iv of result.structures) {
                if (iv.kind === "capped") continue;
                let d = "", started = false;
                for (let i = 0; i < result.raw.s.length; i++) {
                    const sm = result.raw.s[i];
                    if (sm < iv.s0 - 100 || sm > iv.s1 + 100) { started = false; continue; }
                    d += `${started ? "L" : "M"}${L.X(sm).toFixed(1)},${L.Y(result.raw.z[i]).toFixed(1)}`; started = true;
                }
                if (d) svg.append(s("path", { d, fill: "none", stroke: COLORS.raw, "stroke-width": 1.5, "stroke-opacity": 0.75, "stroke-linejoin": "round" }));
            }
            svg.append(s("path", { d: dLine, fill: "none", stroke: COLORS.line, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
            // steep stretches on the line + lane
            for (const sec of result.sections) {
                const col = sec.level === 2 ? COLORS.steep2 : COLORS.steep1;
                let d = `M${L.X(sec.s0).toFixed(1)},${L.Y(core.interp(p.s, p.z, sec.s0)).toFixed(1)}`;
                for (let i = 0; i < n; i++) if (p.s[i] > sec.s0 && p.s[i] < sec.s1) d += `L${L.X(p.s[i]).toFixed(1)},${L.Y(p.z[i]).toFixed(1)}`;
                d += `L${L.X(sec.s1).toFixed(1)},${L.Y(core.interp(p.s, p.z, sec.s1)).toFixed(1)}`;
                svg.append(s("path", { d, fill: "none", stroke: col, "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round" }));
                const x0 = L.X(sec.s0), x1 = Math.max(L.X(sec.s1), x0 + 2);
                const isSel = selected && selected.key === `${sec.kind}-${Math.round(sec.s0)}`;
                svg.append(s("rect", { x: x0 + 1, y: L.laneY, width: Math.max(1, x1 - x0 - 2), height: L.laneH, rx: 3, fill: col, "fill-opacity": isSel ? 1 : 0.85, stroke: isSel ? COLORS.you : "none", "stroke-width": 1.5 }));
                if (x1 - x0 >= 16) { const tx = s("text", { x: (x0 + x1) / 2, y: L.laneY + 8.5, "text-anchor": "middle", class: "grd-lane-t" }); tx.textContent = sec.kind === "climb" ? "▲" : "▼"; svg.append(tx); }
            }
            // baseline of the lane
            svg.append(s("line", { x1: L.ml, x2: L.ml + L.pw, y1: L.mt + L.ph + 0.5, y2: L.mt + L.ph + 0.5, stroke: "rgba(255,255,255,.14)", "stroke-width": 1, "shape-rendering": "crispEdges" }));
            cursorG = s("g", { class: "grd-cursor" });
            svg.append(cursorG);
            plot.replaceChildren(svg);
            plot.setAttribute("aria-label", `Elevation profile: ${U.num(D / 1000, 1)} km, climbing ${U.num(p.ascent, 0)} m and descending ${U.num(p.descent, 0)} m. ${result.sections.length} steep section${result.sections.length === 1 ? "" : "s"}, ${result.structures.length} fixed. Use the arrow keys to read heights; the table below lists every section.`);
            drawCursor();
        }

        function drawCursor() {
            if (!cursorG || !result) return;
            const L = geom(); if (!L) return;
            const p = result.profile;
            cursorG.replaceChildren();
            if (progress !== null && progress >= 0 && progress <= p.distance) {
                const x = L.X(progress), y = L.Y(core.interp(p.s, p.z, progress));
                cursorG.append(s("line", { x1: x, x2: x, y1: L.mt, y2: L.mt + L.ph, stroke: COLORS.you, "stroke-opacity": 0.35, "stroke-width": 1 }));
                cursorG.append(s("circle", { cx: x, cy: y, r: 6, fill: "#0e1724", stroke: COLORS.you, "stroke-width": 2.5 }));
                const tx = s("text", { x: Math.min(x + 9, L.ml + L.pw - 22), y: y - 9, class: "grd-you-t" }); tx.textContent = "You"; cursorG.append(tx);
            }
            if (cursor === null) { tip.hidden = true; return; }
            const z = core.interp(p.s, p.z, cursor), g = core.gradeAt(p, cursor);
            const x = L.X(cursor), y = L.Y(z);
            cursorG.append(s("line", { x1: x, x2: x, y1: L.mt, y2: L.laneY + L.laneH, stroke: COLORS.you, "stroke-opacity": 0.6, "stroke-width": 1 }));
            cursorG.append(s("circle", { cx: x, cy: y, r: 5, fill: COLORS.line, stroke: "#0e1724", "stroke-width": 2 }));
            const sec = result.sections.find((q) => cursor >= q.s0 && cursor <= q.s1);
            const st = result.structures.find((q) => cursor >= q.s0 && cursor <= q.s1);
            const lines = [h("strong", { text: `km ${U.num(cursor / 1000, 1)} · ${U.num(z, 0)} m` }), h("span", { class: "grd-tip-g", text: `${g >= 0 ? "+" : "−"}${U.num(Math.abs(g) * 100, 1)} % ${Math.abs(g) < 0.005 ? "(level)" : g > 0 ? "uphill" : "downhill"}` })];
            if (sec) lines.push(h("span", { class: `grd-tip-sec is-l${sec.level}`, text: `${sec.level === 2 ? "Very steep" : "Steep"} ${sec.kind}: ${U.num(Math.abs(sec.avgGrade) * 100, 0)} % for ${sec.length < 1000 ? `${U.num(Math.round(sec.length / 10) * 10, 0)} m` : `${U.num(sec.length / 1000, 1)} km`}` }));
            if (st) { const k = /** @type {any} */ (KIND)[st.kind] || { word: st.kind }; lines.push(h("span", { class: "grd-tip-st", text: `${k.word}${st.name ? `: ${st.name}` : ""}${st.deviation ? ` · terrain model ${U.num(st.deviation, 0)} m off, fixed` : ""}` })); }
            tip.replaceChildren(...lines);
            tip.hidden = false;
            const tw = tip.offsetWidth || 180;
            tip.style.left = `${x + 12 + tw > L.W ? Math.max(4, x - 12 - tw) : x + 12}px`;
            tip.style.top = `${Math.max(4, Math.min(L.H - (tip.offsetHeight || 60) - 4, y - 30))}px`;
        }

        function renderHeader() {
            const p = result.profile, sm = result.summary;
            const km = U.num(p.distance / 1000, p.distance < 10000 ? 1 : 0);
            sub.textContent = meta.routeName ? `${meta.routeName} · ${km} km` : `${km} km route`;
            prov.replaceChildren(...provenance(meta).map((x) => h("li", { "data-tone": x.tone }, [h("span", { class: "grd-prov-i", "aria-hidden": "true", html: /** @type {any} */ (ICON)[x.icon] }), x.text])));
            const tile = (label, value, unit, note) => h("div", { class: "grd-tile" }, [h("span", { class: "grd-tile-l", text: label }), h("span", { class: "grd-tile-v" }, [value, unit ? h("small", { text: unit }) : null]), note ? h("span", { class: "grd-tile-n", text: note }) : null]);
            const flat = p.source === "flat";
            tiles.replaceChildren(
                tile("Climb", flat ? "–" : `↑ ${U.num(sm.ascent, 0)}`, flat ? "" : " m", flat ? "unknown offline" : `${U.num(sm.zMin, 0)}–${U.num(sm.zMax, 0)} m high`),
                tile("Descent", flat ? "–" : `↓ ${U.num(sm.descent, 0)}`, flat ? "" : " m", null),
                tile("Steepest", flat ? "–" : `${U.num(sm.maxClimb * 100, sm.maxClimb < 0.1 ? 1 : 0)}`, flat ? "" : " %", flat ? null : Math.abs(sm.maxDescent) < 0.005 ? "no descents" : `down ${U.num(Math.abs(sm.maxDescent) * 100, Math.abs(sm.maxDescent) < 0.1 ? 1 : 0)} %`),
                tile("Steep stretches", flat ? "–" : `${U.num((sm.steepClimb + sm.steepDescent) / 1000, 1)}`, flat ? "" : " km", flat ? null : `${result.sections.filter((x) => x.kind === "climb").length} up · ${result.sections.filter((x) => x.kind === "descent").length} down`),
                tile("Fixed sections", String(result.structures.length), "", `${sm.bridges} bridge${sm.bridges === 1 ? "" : "s"} · ${sm.tunnels} tunnel${sm.tunnels === 1 ? "" : "s"}${sm.likely ? ` · ${sm.likely} likely` : ""}`)
            );
        }

        function renderTable() {
            if (!result) return;
            const rows = tableRows(result, U).filter((r) => filter === "all" || r.type === filter);
            empty.hidden = rows.length > 0;
            empty.textContent = filter === "fixed" ? "No bridges, tunnels or terrain spikes on this route." : filter === "all" ? "No steep or fixed sections: an easy ride." : `No steep ${filter === "climb" ? "climbs" : "descents"} (6 % or more).`;
            tbody.replaceChildren(...rows.map((r) => {
                const sel = selected && selected.key === r.key;
                const tr = h("tr", { class: `grd-row is-${r.type}${r.level === 2 ? " is-l2" : ""}${sel ? " is-sel" : ""}`, tabindex: "0", "aria-selected": String(Boolean(sel)),
                    onclick: () => pick(r), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(r); } } }, [
                    h("td", { class: "grd-num" }, [r.where, h("span", { class: "grd-where-len", text: r.length })]),
                    h("td", {}, [h("span", { class: "grd-what" }, [h("span", { class: `grd-what-i is-${r.type}${r.level === 2 ? " is-l2" : ""}`, "aria-hidden": "true", html: /** @type {any} */ (ICON)[r.icon] }), r.what]), h("span", { class: "grd-what-d", text: r.detail })]),
                    h("td", { class: "grd-num", text: r.length }),
                    h("td", { class: "grd-detail", text: r.detail }),
                    h("td", {}, [deps.onFocusSection ? h("button", { type: "button", class: "grd-map-btn", "aria-label": `Show ${r.what} on the map`, html: ICON.map, onclick: (e) => { e.stopPropagation(); pick(r); if (deps.onFocusSection) deps.onFocusSection({ s0: r.s0, s1: r.s1, what: r.what }); } }) : null])
                ]);
                return tr;
            }));
        }
        function pick(r) {
            selected = selected && selected.key === r.key ? null : r;
            cursor = selected ? (r.s0 + r.s1) / 2 : null;
            draw(); renderTable();
        }

        /**
         * @param {any} res MUGradient.core.analyze() result
         * @param {{ elevation?: { source: string, fetched: number, missing: number, total: number }, structureSource?: string, offline?: boolean, routeName?: string, progress?: number|null }} [m]
         */
        function render(res, m = {}) {
            result = res; meta = m; selected = null; cursor = null;
            progress = Number.isFinite(m.progress) ? /** @type {number} */ (m.progress) : null;
            renderHeader(); draw(); renderTable();
            if (!ro && typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(() => { const w = Math.round(plot.clientWidth); if (w && w !== W) draw(); }); ro.observe(plot); }
        }

        return {
            render,
            /** @param {number|null} m */ setProgress(m) { progress = Number.isFinite(m) ? m : null; drawCursor(); },
            get result() { return result; },
            destroy() { if (ro) ro.disconnect(); root.replaceChildren(); root.classList.remove("grd"); }
        };
    }

    return { COLORS, KIND, niceTicks, tableRows, provenance, createProfileView };
});
