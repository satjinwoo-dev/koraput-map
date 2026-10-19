/* ============================================================================
   MapUnite Ride Story — the whole ride as a moving dashboard
   ==============================================================================
   RideStory.open(rideStartedAt | summary)   the story of a ride (full screen)
   RideStory.has(startedAt) / remove(startedAt) / clear()

   When a ride ends, the HUD's "mu:ride-summary" carries the ride journal
   (js/story/journal.js) and what it knew at the start (bike, tank, people). It
   is kept on this phone (localStorage "mu.story.v1", the last 12 rides) and
   built into the story by js/story/story-core.js every time it opens, so the
   numbers always follow the latest rules.

   Five chapters, each a stack of cards that animate in as they scroll into view
   (count-ups, charts that draw themselves, gauges, a draining tank, wind), and a
   glass dock with a sliding blob to jump between them; ▶ plays the chapters by
   itself. Opened from the ride recap ("📊 Full ride story") and from a ride in
   My rides. Place names (start, finish) are looked up once, when online.
   ============================================================================ */
"use strict";

const RideStory = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document) return {};
    const KEY = "mu.story.v1", KEEP = 12, ROAD_KEY = "mu.master.dynamics.review.ride";
    const NS = "http://www.w3.org/2000/svg";
    const core = () => (W.MUStory && W.MUStory.core) || null;
    const reduced = () => { try { return W.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };

    // ---------------------------------------------------------------- storage
    const read = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || "{}"); return v && Array.isArray(v.list) ? v : { list: [] }; } catch (e) { return { list: [] }; } };
    /** Numbers kept to 6 significant digits: a story is ~15–30 kB. */
    const round = (k, v) => (typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v) ? Number(v.toPrecision(6)) : v);
    function write(db) {
        for (let n = db.list.length; n >= 1; n--) {
            try { localStorage.setItem(KEY, JSON.stringify({ list: db.list.slice(0, n) }, round)); return true; } catch (e) { /* full: keep fewer */ }
        }
        return false;
    }
    const find = (id) => read().list.find((x) => Math.abs(x.id - id) < 1000) || null;
    function save(entry) {
        const db = read();
        db.list = [entry, ...db.list.filter((x) => Math.abs(x.id - entry.id) >= 1000)].slice(0, KEEP);
        write(db);
    }
    function patch(id, f) { const db = read(); const e = db.list.find((x) => Math.abs(x.id - id) < 1000); if (!e) return; f(e); write(db); }

    function usualKmL() {
        try {
            // @ts-ignore js/smartdrive.js
            const FC = typeof FuelCurve !== "undefined" ? FuelCurve : null;
            const u = W.MUShare && W.MUShare.model ? W.MUShare.model.usualFromLearner(FC) : null;
            return u && u.perMetre > 0 ? 1 / (u.perMetre * 1e6) : null;
        } catch (e) { return null; }
    }
    function roadRecord() { try { return JSON.parse(localStorage.getItem(ROAD_KEY) || "null"); } catch (e) { return null; } }

    function onSummary(e) {
        const s = e && e.detail;
        if (!s || !s.story || !s.story.journal) return;
        const j = s.story.journal;
        const id = Number(s.trip && s.trip.startedAt) || j.startedAt;
        if (!Number.isFinite(id) || !(j.distance >= 200)) return;
        save({ id, saved: Date.now(), journal: j, ctx: { ...s.story.ctx, usualKmL: s.powertrain === "ev" ? null : usualKmL() } });
        // the road sensor's record for this ride is written as the ride ends: take it a moment later
        setTimeout(() => { const r = roadRecord(); if (r && Number.isFinite(r.startedAt) && Math.abs(r.startedAt - id) < 30 * 60000) patch(id, (x) => { x.ctx.road = r; }); }, 6000);
        lastId = id;
        const b = document.getElementById("share-story-btn"); if (b) b.hidden = false;
    }
    let lastId = 0;

    // ---------------------------------------------------------------- formatting
    const n0 = (x) => Math.round(x).toLocaleString("en-IN");
    const n1 = (x) => (Math.round(x * 10) / 10).toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const n2 = (x) => (Math.round(x * 100) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const km = (m) => (m < 1000 ? `${n0(m)} m` : `${m < 100000 ? n1(m / 1000) : n0(m / 1000)} km`);
    const kmh = (v) => `${n0(v * 3.6)} km/h`;
    function dur(s) {
        s = Math.max(0, Math.round(s));
        if (s < 60) return `${s} s`;
        const m = Math.round(s / 60);
        return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
    }
    const fuelTxt = (m3, ev) => (ev ? `${n2(m3 / 3.6e6)} kWh` : m3 * 1000 < 1 ? `${n0(m3 * 1e6)} mL` : `${n2(m3 * 1000)} L`);
    const money = (x) => `₹${x < 100 ? n1(x) : n0(x)}`;
    const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const pct = (x) => `${Math.round(x * 100)}%`;

    // ---------------------------------------------------------------- DOM helpers
    const h = (tag, a = {}, kids = []) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(a)) {
            if (v == null || v === false) continue;
            if (k === "class") el.className = v; else if (k === "text") el.textContent = v; else if (k === "style") el.style.cssText = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of [].concat(kids)) if (c != null && c !== false) el.append(c);
        return el;
    };
    const s = (tag, a = {}, kids = []) => {
        const el = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(a)) if (v != null) el.setAttribute(k, String(v));
        for (const c of [].concat(kids)) if (c) el.append(c);
        return el;
    };

    /** A number that counts up when its card comes in. */
    function count(to, f, o = {}) {
        const el = h("span", { class: `rs-num${o.cls ? ` ${o.cls}` : ""}`, text: f(0) });
        el._play = () => {
            if (reduced()) { el.textContent = f(to); return; }
            const t0 = performance.now(), ms = o.ms || 1300;
            const step = (t) => { const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3); el.textContent = f(to * e); if (k < 1) requestAnimationFrame(step); };
            requestAnimationFrame(step);
        };
        return el;
    }
    /** A card: plays its animations once, when it scrolls in. */
    function card(cls, kids, label) {
        return h("section", { class: `rs-card ${cls || ""}`, "aria-label": label || null }, kids);
    }
    const head = (title, chip, tone) => h("div", { class: "rs-card-h" }, [h("span", { class: "rs-card-t", text: title }), chip ? h("span", { class: `rs-chip ${tone || ""}`, text: chip }) : null]);

    // ---------------------------------------------------------------- charts
    const TONES = { eco: "#3ddc84", normal: "#c6f432", thirsty: "#ff5a5f" };

    /** Area chart with a scrubber (speed, fuel per km, height). */
    function areaChart(series, ev) {
        const Wd = 640, Hd = 200, pad = { l: 8, r: 8, t: 14, b: 4 };
        const total = series.length ? series[series.length - 1].at : 0;
        const modes = [
            { key: "speed", label: "Speed", get: (p) => p.speed * 3.6, fmt: (v) => `${n0(v)} km/h`, color: "#c6f432" },
            { key: "fuel", label: ev ? "Energy" : "Fuel", get: (p) => (p.perMetre === null ? null : ev ? p.perMetre / 3.6 : p.perMetre * 1e9), fmt: (v) => (ev ? `${n0(v)} Wh/km` : `${n0(v)} mL/km`), color: "#ff8a3d" },
            { key: "elev", label: "Height", get: (p) => p.elev, fmt: (v) => `${v >= 0 ? "+" : ""}${n0(v)} m`, color: "#5ad1ff" }
        ];
        let mode = modes[0];
        const svg = s("svg", { viewBox: `0 0 ${Wd} ${Hd}`, class: "rs-area", role: "img", preserveAspectRatio: "none" });
        const defs = s("defs");
        const grad = s("linearGradient", { id: "rs-area-g", x1: 0, x2: 0, y1: 0, y2: 1 }, [s("stop", { offset: "0", "stop-color": mode.color, "stop-opacity": ".55" }), s("stop", { offset: "1", "stop-color": mode.color, "stop-opacity": "0" })]);
        const hatch = s("pattern", { id: "rs-hatch", width: 4, height: 4, patternUnits: "userSpaceOnUse" }, [s("rect", { width: 1.2, height: 4, fill: "rgba(198,244,50,.18)" })]);
        defs.append(grad, hatch);
        const grid = s("g", { class: "rs-grid" });
        for (let i = 1; i <= 3; i++) grid.append(s("line", { x1: pad.l, x2: Wd - pad.r, y1: pad.t + (Hd - pad.t - pad.b) * i / 4, y2: pad.t + (Hd - pad.t - pad.b) * i / 4 }));
        const bars = s("g", { class: "rs-bars" }), area = s("path", { fill: "url(#rs-area-g)" }), line = s("path", { class: "rs-line", fill: "none", "stroke-width": 2.6, "stroke-linejoin": "round", "stroke-linecap": "round" });
        const cursor = s("line", { class: "rs-cursor", y1: pad.t, y2: Hd - pad.b, visibility: "hidden" }), dot = s("circle", { r: 5, class: "rs-dot", visibility: "hidden" });
        const axis = h("div", { class: "rs-axis", "aria-hidden": "true" }, [0, 0.25, 0.5, 0.75, 1].map((k) => h("span", { text: km(total * k) })));
        svg.append(defs, grid, bars, area, line, cursor, dot);
        const tip = h("div", { class: "rs-tip", hidden: true });
        const big = h("div", { class: "rs-area-big" });
        let pts = [];
        function draw(animate) {
            const vals = series.map((p) => mode.get(p));
            const ok = vals.filter((v) => v !== null && Number.isFinite(v));
            const lo = mode.key === "elev" ? Math.min(0, ...ok) : 0, hi = Math.max(lo + 1, ...ok);
            const X = (at) => pad.l + (total > 0 ? at / total : 0) * (Wd - pad.l - pad.r), Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (Hd - pad.t - pad.b);
            pts = series.map((p, i) => ({ x: X(p.at), y: vals[i] === null ? null : Y(vals[i]), v: vals[i], p }));
            const good = pts.filter((q) => q.y !== null);
            const d = good.map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join("");
            line.setAttribute("d", d); line.setAttribute("stroke", mode.color);
            area.setAttribute("d", good.length ? `${d}L${good[good.length - 1].x.toFixed(1)},${Hd - pad.b}L${good[0].x.toFixed(1)},${Hd - pad.b}Z` : "");
            grad.querySelectorAll("stop").forEach((st) => st.setAttribute("stop-color", mode.color));
            bars.replaceChildren(...good.map((q) => s("line", { x1: q.x, x2: q.x, y1: q.y + 3, y2: Hd - pad.b, stroke: mode.color, "stroke-opacity": ".22", "stroke-width": Math.max(1, (Wd / Math.max(1, good.length)) * 0.35) })));
            const avg = ok.length ? ok.reduce((a, v) => a + v, 0) / ok.length : 0;
            big.replaceChildren(h("span", { class: "rs-area-l", text: mode.key === "elev" ? "Total climb" : `Average ${mode.label.toLowerCase()}` }), h("b", { text: mode.key === "elev" ? `+${n0(series.reduce((a, p, i) => a + Math.max(0, p.elev - (i ? series[i - 1].elev : 0)), 0))} m` : mode.fmt(avg) }));
            if (animate && !reduced()) {
                const L = line.getTotalLength ? line.getTotalLength() : 1000;
                line.style.transition = "none"; line.style.strokeDasharray = `${L}`; line.style.strokeDashoffset = `${L}`;
                area.style.transition = "none"; area.style.opacity = "0";
                bars.style.transition = "none"; bars.style.opacity = "0";
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    line.style.transition = "stroke-dashoffset 1.6s cubic-bezier(.2,.7,.2,1)"; line.style.strokeDashoffset = "0";
                    area.style.transition = "opacity 1s .6s"; area.style.opacity = "1";
                    bars.style.transition = "opacity 1s .9s"; bars.style.opacity = "1";
                }));
            }
        }
        function scrub(ev2) {
            const r = svg.getBoundingClientRect();
            const x = ((ev2.clientX - r.left) / r.width) * Wd;
            const q = pts.filter((p) => p.y !== null).reduce((b, p) => (b === null || Math.abs(p.x - x) < Math.abs(b.x - x) ? p : b), null);
            if (!q) return;
            cursor.setAttribute("x1", q.x); cursor.setAttribute("x2", q.x); cursor.setAttribute("visibility", "visible");
            dot.setAttribute("cx", q.x); dot.setAttribute("cy", q.y); dot.setAttribute("fill", mode.color); dot.setAttribute("visibility", "visible");
            tip.hidden = false;
            tip.replaceChildren(h("b", { text: mode.fmt(q.v) }), h("small", { text: `at ${km(q.p.at)} · ${q.p.kind === "eco" ? "🍃 eco" : q.p.kind === "thirsty" ? "🔥 thirsty" : "normal"}` }));
            tip.style.left = `${Math.max(8, Math.min(92, (q.x / Wd) * 100))}%`;
        }
        svg.addEventListener("pointermove", scrub); svg.addEventListener("pointerdown", scrub);
        svg.addEventListener("pointerleave", () => { cursor.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.hidden = true; });
        const chips = h("div", { class: "rs-seg", role: "radiogroup", "aria-label": "Chart" }, modes.map((m) => h("button", { type: "button", role: "radio", "aria-checked": String(m === mode), text: m.label, onclick: (e2) => { mode = m; for (const b of chips.children) b.setAttribute("aria-checked", String(b === e2.currentTarget)); draw(true); } })));
        const wrap = h("div", { class: "rs-area-wrap" }, [big, chips, h("div", { class: "rs-area-box" }, [svg, tip, axis])]);
        wrap._play = () => draw(true);
        draw(false);
        return wrap;
    }

    /** Donut with a legend; segments sweep in one after another. */
    function donut(items, centre, sub) {
        const R0 = 54, C = 2 * Math.PI * R0;
        const svg = s("svg", { viewBox: "0 0 140 140", class: "rs-donut", "aria-hidden": "true" });
        svg.append(s("circle", { cx: 70, cy: 70, r: R0, class: "rs-donut-bg" }));
        let acc = 0;
        const segs = items.map((it) => {
            const c = s("circle", { cx: 70, cy: 70, r: R0, stroke: it.color, "stroke-width": 16, fill: "none", "stroke-linecap": "butt", transform: `rotate(${-90 + acc * 360} 70 70)` });
            const len = Math.max(0, it.share * C - 2);
            c.style.strokeDasharray = `${len} ${C}`; c.style.strokeDashoffset = `${len}`;
            acc += it.share;
            svg.append(c);
            return c;
        });
        const mid = h("div", { class: "rs-donut-mid" }, [h("b", { text: centre }), h("small", { text: sub })]);
        const legend = h("ul", { class: "rs-legend" }, items.map((it) => h("li", {}, [h("i", { style: `background:${it.color}` }), h("span", { text: it.label }), h("b", { text: it.value })])));
        const el = h("div", { class: "rs-donut-wrap" }, [h("div", { class: "rs-donut-box" }, [svg, mid]), legend]);
        el._play = () => segs.forEach((c, i) => { c.style.transition = reduced() ? "none" : `stroke-dashoffset .9s cubic-bezier(.3,.8,.3,1) ${i * 0.22}s`; requestAnimationFrame(() => { c.style.strokeDashoffset = "0"; }); });
        return el;
    }

    /** Semicircle gauge with a knob (eco score). */
    function gauge(value, tone, label) {
        const v = Math.max(0, Math.min(1, value || 0));
        const R0 = 70, L = Math.PI * R0;
        const svg = s("svg", { viewBox: "0 0 180 104", class: "rs-gauge", "aria-hidden": "true" });
        const arc = `M20,92 A${R0},${R0} 0 0 1 160,92`;
        const ticks = s("g", { class: "rs-ticks" });
        for (let i = 0; i <= 20; i++) { const a = Math.PI * (1 - i / 20); ticks.append(s("line", { x1: 90 + Math.cos(a) * 84, y1: 92 - Math.sin(a) * 84, x2: 90 + Math.cos(a) * (i % 5 ? 80 : 77), y2: 92 - Math.sin(a) * (i % 5 ? 80 : 77) })); }
        const fg = s("path", { d: arc, class: "rs-gauge-fg", stroke: tone, fill: "none", "stroke-width": 14, "stroke-linecap": "round" });
        fg.style.strokeDasharray = `${L}`; fg.style.strokeDashoffset = `${L}`;
        const knob = s("circle", { r: 9, cx: 20, cy: 92, class: "rs-knob" });
        svg.append(s("path", { d: arc, class: "rs-gauge-bg", fill: "none", "stroke-width": 14, "stroke-linecap": "round" }), ticks, fg, knob);
        const num = count(v * 100, (x) => String(Math.round(x)), { cls: "rs-gauge-n" });
        const el = h("div", { class: "rs-gauge-wrap" }, [svg, h("div", { class: "rs-gauge-mid" }, [num, h("small", { text: "/100" })]), h("p", { class: "rs-gauge-l", text: label })]);
        el._play = () => {
            num._play();
            if (reduced()) { const a = Math.PI * (1 - v); fg.style.strokeDashoffset = `${L * (1 - v)}`; knob.setAttribute("cx", String(90 + Math.cos(a) * R0)); knob.setAttribute("cy", String(92 - Math.sin(a) * R0)); return; }
            const t0 = performance.now();
            const step = (t) => { const k = Math.min(1, (t - t0) / 1400), e = 1 - Math.pow(1 - k, 3), x = v * e, a = Math.PI * (1 - x); fg.style.strokeDashoffset = `${L * (1 - x)}`; knob.setAttribute("cx", String(90 + Math.cos(a) * R0)); knob.setAttribute("cy", String(92 - Math.sin(a) * R0)); if (k < 1) requestAnimationFrame(step); };
            requestAnimationFrame(step);
        };
        return el;
    }

    /** The route, drawn by itself, coloured by how thirsty each stretch was, with the moments on it. */
    function routeMap(st) {
        const Wd = 640, Hd = 300, pad = 26;
        const pts = st.route;
        const svg = s("svg", { viewBox: `0 0 ${Wd} ${Hd}`, class: "rs-map", role: "img", "aria-label": "The ride, north up" });
        if (!pts || pts.length < 2) { const t = s("text", { x: Wd / 2, y: Hd / 2, "text-anchor": "middle", class: "rs-map-none" }); t.textContent = "No route was recorded"; svg.append(t); return { el: svg, play: () => {} }; }
        const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length, kx = Math.cos(lat0 * Math.PI / 180);
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        const P = pts.map(([la, ln]) => { const x = ln * kx, y = -la; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); return [x, y]; });
        const sc = Math.min((Wd - 2 * pad) / Math.max(1e-9, x1 - x0), (Hd - 2 * pad) / Math.max(1e-9, y1 - y0));
        const ox = pad + (Wd - 2 * pad - (x1 - x0) * sc) / 2, oy = pad + (Hd - 2 * pad - (y1 - y0) * sc) / 2;
        const xy = (la, ln) => [ox + (ln * kx - x0) * sc, oy + (-la - y0) * sc];
        const Q = pts.map(([la, ln]) => xy(la, ln));
        const dOf = (arr) => arr.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
        // grid dots, like a radar
        const dots = s("g", { class: "rs-map-grid" });
        for (let x = 12; x < Wd; x += 24) for (let y = 12; y < Hd; y += 24) dots.append(s("circle", { cx: x, cy: y, r: 0.9 }));
        svg.append(dots, s("path", { d: dOf(Q), class: "rs-map-glow" }));
        // stretches → route indices (nearest point, moving forward)
        const near = (la, ln, from) => { let b = from, bd = Infinity; for (let i = from; i < pts.length; i++) { const d = (pts[i][0] - la) ** 2 + ((pts[i][1] - ln) * kx) ** 2; if (d < bd) { bd = d; b = i; } } return b; };
        const paths = [];
        let at = 0;
        for (const p of st.series) {
            if (p.lat === null) continue;
            const j = near(p.lat, p.lng, at);
            if (j > at) { const seg = s("path", { d: dOf(Q.slice(at, j + 1)), class: "rs-map-seg", stroke: TONES[p.kind] }); paths.push(seg); at = j; }
        }
        if (at < Q.length - 1) paths.push(s("path", { d: dOf(Q.slice(at)), class: "rs-map-seg", stroke: TONES.normal }));
        const g = s("g"); paths.forEach((p) => g.append(p)); svg.append(g);
        const marks = s("g", { class: "rs-marks" });
        const mark = (la, ln, cls, label, delay) => { if (!Number.isFinite(la) || !Number.isFinite(ln)) return; const [x, y] = xy(la, ln); const m = s("g", { class: `rs-mark ${cls}`, transform: `translate(${x.toFixed(1)},${y.toFixed(1)})` }, [s("circle", { r: 7 }), label ? s("text", { y: 3.5, "text-anchor": "middle" }) : null]); if (label) m.querySelector("text").textContent = label; m.style.setProperty("--d", `${delay}s`); marks.append(m); };
        (st.road.spots || []).forEach((x, i) => mark(x.lat, x.lng, x.type === "rough" ? "m-rough" : "m-hole", "", 1.6 + i * 0.03));
        st.behaviour.brakeList.forEach((b, i) => mark(b.lat, b.lng, "m-brake", "!", 1.8 + i * 0.05));
        st.stopList.forEach((x, i) => mark(x.lat, x.lng, x.rest ? "m-rest" : "m-stop", x.rest ? "☕" : "", 2 + i * 0.05));
        mark(pts[0][0], pts[0][1], "m-start", "", 0.1);
        mark(pts[pts.length - 1][0], pts[pts.length - 1][1], "m-end", "🏁", 2.2);
        svg.append(marks);
        const play = () => {
            let delay = 0;
            const total = paths.reduce((a, p) => a + (p.getTotalLength ? p.getTotalLength() : 0), 0) || 1;
            for (const p of paths) {
                const L = p.getTotalLength ? p.getTotalLength() : 0, ms = (L / total) * 1.8;
                if (reduced()) continue;
                p.style.strokeDasharray = `${L}`; p.style.strokeDashoffset = `${L}`;
                p.style.transition = `stroke-dashoffset ${ms}s linear ${delay}s`;
                delay += ms;
                requestAnimationFrame(() => requestAnimationFrame(() => { p.style.strokeDashoffset = "0"; }));
            }
            marks.classList.add("in");
        };
        return { el: svg, play };
    }

    /** A tank that drains from where the ride started to where it ended. */
    function tank(start, end, cap) {
        const k0 = cap ? Math.min(1, start / cap) : 1, k1 = cap ? Math.min(1, end / cap) : 0;
        const liquid = h("div", { class: "rs-liquid", style: `height:${k0 * 100}%` }, [h("i", { class: "rs-wave" }), h("i", { class: "rs-wave b" })]);
        const el = h("div", { class: "rs-tank" }, [liquid, h("div", { class: "rs-tank-ticks" }, [h("i"), h("i"), h("i")])]);
        el._play = () => { liquid.style.transition = reduced() ? "none" : "height 2.2s cubic-bezier(.5,0,.3,1) .4s"; requestAnimationFrame(() => requestAnimationFrame(() => { liquid.style.height = `${k1 * 100}%`; })); };
        return el;
    }

    // ---------------------------------------------------------------- the screen
    let root = null, io = null, playTimer = 0, keyH = null;
    function close() {
        clearTimeout(playTimer); playTimer = 0;
        if (io) { io.disconnect(); io = null; }
        if (keyH) { document.removeEventListener("keydown", keyH); keyH = null; }
        if (root) { const r = root; r.classList.remove("in"); setTimeout(() => r.remove(), 260); root = null; }
    }

    /**
     * @param {number|any} what a ride's startedAt, or a "mu:ride-summary" with .story
     */
    async function open(what) {
        const C = core();
        if (!C) return false;
        let entry = null;
        if (what && typeof what === "object" && what.story && what.story.journal) entry = find(Number(what.trip && what.trip.startedAt)) || { id: Number(what.trip && what.trip.startedAt), journal: what.story.journal, ctx: what.story.ctx };
        else if (Number.isFinite(Number(what))) entry = find(Number(what));
        if (!entry) { try { if (typeof showToast === "function") showToast("No ride story for this ride: it's made while the riding dashboard is on.", 4000); } catch (e) { /* no toast */ } return false; }
        close();
        const ctx = { ...(entry.ctx || {}) };
        if (!ctx.road) { const r = roadRecord(); if (r && Number.isFinite(r.startedAt) && Math.abs(r.startedAt - entry.id) < 30 * 60000) { ctx.road = r; patch(entry.id, (x) => { x.ctx.road = r; }); } }
        const st = C.build(entry.journal, ctx);
        render(st, entry);
        names(entry, st);
        return true;
    }

    /** Start and finish names (once, online; coordinates never leave the phone otherwise). */
    async function names(entry, st) {
        if (entry.ctx && entry.ctx.places && entry.ctx.places.start) return;
        if (!st.start || !st.end || (W.navigator && W.navigator.onLine === false) || typeof fetchCity !== "function") return;
        try {
            const [a, b] = await Promise.all([fetchCity(st.start.lat, st.start.lng), fetchCity(st.end.lat, st.end.lng)]);
            if (!a && !b) return;
            const places = { start: a && a !== "Local Area" ? a : null, end: b && b !== "Local Area" ? b : null };
            patch(entry.id, (x) => { x.ctx = { ...(x.ctx || {}), places }; });
            if (root) {
                const ps = root.querySelector(".rs-place-a"), pe = root.querySelector(".rs-place-b");
                if (ps && places.start) ps.textContent = places.start;
                if (pe && places.end) pe.textContent = places.end;
                const t = root.querySelector(".rs-title-sub"); if (t && places.start && places.end) t.textContent = places.start === places.end ? `Around ${places.start}` : `${places.start} → ${places.end}`;
            }
        } catch (e) { /* offline */ }
    }

    function render(st, entry) {
        const ev = st.ev, F = st.fuel, B = st.behaviour, T = st.time;
        const P = st.places;
        const tone = { green: "#3ddc84", teal: "#2ee6c5", amber: "#ffb020", red: "#ff4d6a" }[B.tone] || "#c6f432";
        const sub = P.start && P.end ? (P.start === P.end ? `Around ${P.start}` : `${P.start} → ${P.end}`) : new Date(st.startedAt).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

        // ------------------------------------------------ 1. the ride
        const map = routeMap(st);
        const journey = card("rs-journey", [
            head("Your ride", `${km(st.headline.distance)}`, "lime"),
            h("div", { class: "rs-map-box" }, [map.el, h("div", { class: "rs-map-key" }, [
                h("span", {}, [h("i", { style: `background:${TONES.eco}` }), "eco"]), h("span", {}, [h("i", { style: `background:${TONES.normal}` }), "normal"]), h("span", {}, [h("i", { style: `background:${TONES.thirsty}` }), "thirsty"]),
                h("span", {}, [h("i", { class: "k-brake" }), "hard brake"]), h("span", {}, [h("i", { class: "k-stop" }), "stop"]), st.road.sensor ? h("span", {}, [h("i", { class: "k-hole" }), "pothole"]) : null
            ])]),
            h("div", { class: "rs-ends" }, [
                h("div", { class: "rs-end" }, [h("span", { class: "rs-pin a" }), h("div", {}, [h("small", { text: `Start · ${clock(st.startedAt)}` }), h("b", { class: "rs-place-a", text: P.start || "Where you started" })])]),
                h("div", { class: "rs-end-line" }, [h("i"), h("span", { text: dur(T.duration) })]),
                h("div", { class: "rs-end" }, [h("span", { class: "rs-pin b" }), h("div", {}, [h("small", { text: `Finish · ${clock(st.endedAt)}` }), h("b", { class: "rs-place-b", text: P.end || "Where you finished" })])])
            ])
        ], "The route");
        journey._play = map.play;

        const kpi = (label, el, foot, cls) => h("div", { class: `rs-kpi ${cls || ""}` }, [h("small", { text: label }), el, foot ? h("span", { class: "rs-kpi-f", text: foot }) : null]);
        const kDist = count(st.headline.distance / 1000, (x) => n1(x), {}), kRide = count(T.riding, (x) => dur(x), {}), kFuel = count(F.used, (x) => fuelTxt(x, ev), {}), kCost = count(F.cost || 0, (x) => money(x), {});
        const kpis = card("rs-kpis", [
            kpi("Distance", h("div", { class: "rs-big" }, [kDist, h("small", { text: " km" })]), st.headline.avgMoving ? `avg ${kmh(st.headline.avgMoving)} moving` : null, "lime"),
            kpi("Riding time", h("div", { class: "rs-big" }, [kRide]), `of ${dur(T.duration)} in all`),
            kpi(ev ? "Energy used" : "Petrol burnt", h("div", { class: "rs-big" }, [kFuel]), F.economy ? `${n1(F.economy)} km/L this ride` : F.whPerKm ? `${n0(F.whPerKm)} Wh/km` : null, "orange"),
            kpi("Money spent", h("div", { class: "rs-big" }, [F.cost !== null ? kCost : h("span", { text: "–" })]), st.priceUnit ? `at ${st.priceUnit}${st.priceExample ? " (example price)" : ""}` : null, "pink")
        ], "Totals");
        kpis._play = () => [kDist, kRide, kFuel, kCost].forEach((x) => x._play());

        const chart = areaChart(st.series, ev);
        const chartCard = card("rs-chartcard", [head("Along the ride", "drag to explore"), chart], "Along the ride");
        chartCard._play = chart._play;

        // ------------------------------------------------ 2. fuel & money
        const fuelCards = [];
        if (!ev && F.tankStart !== null) {
            const tk = tank(F.tankStart, F.tankEnd, F.tank);
            const c = card("rs-tankcard", [head("Your tank", F.tank ? `${n1(F.tank * 1000)} L tank` : null),
                h("div", { class: "rs-tank-row" }, [tk, h("div", { class: "rs-tank-tx" }, [
                    h("div", {}, [h("small", { text: "At the start" }), h("b", { text: fuelTxt(F.tankStart, false) })]),
                    h("div", { class: "rs-burn" }, [h("small", { text: "Burnt" }), h("b", { text: `− ${fuelTxt(F.used, false)}` })]),
                    h("div", {}, [h("small", { text: "Left now" }), h("b", { class: "rs-left", text: fuelTxt(F.tankEnd, false) })])
                ])])
            ], "Tank");
            c._play = tk._play;
            fuelCards.push(c);
        } else if (!ev) fuelCards.push(card("rs-tankcard", [head("Your tank"), h("p", { class: "rs-muted", text: "How much was in the tank isn't known yet. Log a full fill-up (or set the level in the trip card) and the next story shows the tank." })]));

        if (!ev && F.economy) {
            const rows = [["This ride", F.economy, "#ff8a3d"], F.usualKmL ? ["Your usual (fill-ups)", F.usualKmL, "#9aa4b2"] : null, F.bestKmL ? ["Bike's best, flat road", F.bestKmL, "#3ddc84"] : null].filter(Boolean);
            const max = Math.max(...rows.map((r) => r[1]));
            const bars = rows.map(([l, v, c]) => h("div", { class: "rs-hbar" }, [h("span", { text: l }), h("div", { class: "rs-hbar-t" }, [h("i", { style: `--w:${(v / max) * 100}%;background:${c}` })]), h("b", { text: `${n1(v)} km/L` })]));
            const c = card("rs-mileage", [head("Mileage", F.vsUsual !== null ? `${F.vsUsual >= 0 ? "+" : ""}${pct(F.vsUsual)} vs usual` : null, F.vsUsual !== null ? (F.vsUsual >= 0 ? "green" : "red") : ""), ...bars], "Mileage");
            c._play = () => c.classList.add("bars-in");
            fuelCards.push(c);
        }
        if (st.parts.length) {
            const COL = { air: "#5ad1ff", rolling: "#c6f432", climb: "#ff8a3d", accel: "#ff5a8a", idle: "#a78bfa" };
            const tot = st.parts.reduce((a, p) => a + p.fuel, 0) || 1;
            const items = st.parts.map((p) => ({ label: p.label, color: COL[p.key], share: p.fuel / tot, value: `${pct(p.fuel / tot)} · ${fuelTxt(p.fuel, ev)}` }));
            const dn = donut(items, fuelTxt(F.used, ev), "≈ where it went");
            const c = card("rs-where", [head("Where the petrol went", "physics estimate"), dn], "Where the fuel went");
            if (ev) c.querySelector(".rs-card-t").textContent = "Where the energy went";
            c._play = dn._play;
            fuelCards.push(c);
        }
        // burn map: the ride as a strip of eco / normal / thirsty, and the three stretches worth knowing
        const strip = h("div", { class: "rs-strip" }, st.series.map((p, i) => h("i", { style: `flex:${Math.max(0.0001, (st.series[i + 1] ? st.series[i + 1].at : st.headline.distance) - (i ? st.series[i].at : 0))};background:${TONES[p.kind]};--i:${i}` })));
        const hl = (icon, title, x, cls, line) => x ? h("div", { class: `rs-hl ${cls}` }, [h("span", { class: "rs-hl-ic", text: icon }), h("div", {}, [h("b", { text: title }), h("small", { text: `km ${n1(x.from / 1000)} → ${n1(x.to / 1000)} · ${line(x)}` }), h("div", { class: "rs-tags" }, x.reasons.map((r) => h("span", { text: r.text })))])]) : null;
        const H = st.highlights;
        const burn = card("rs-burnmap", [
            head("Where you burnt more, where less", `${pct(st.mix.eco)} eco`, "green"),
            strip,
            h("div", { class: "rs-strip-ax" }, [h("span", { text: "start" }), h("span", { text: km(st.headline.distance) })]),
            hl("🔥", "Burnt the most", H.thirsty, "hot", (x) => `${fuelTxt(x.extra, ev)} more than needed`),
            hl("🍃", "Most eco stretch", H.eco, "eco", (x) => `${km(x.distance)} at ${pct(x.score)} eco`),
            hl("🪶", "Lightest on fuel", H.thrifty, "light", (x) => (ev ? `${n0(x.perMetre / 3.6)} Wh/km` : `${n0(x.perMetre * 1e9)} mL/km`)),
            !H.thirsty && !H.eco ? h("p", { class: "rs-muted", text: "The ride was too short to pick out stretches." }) : null
        ], "Burn map");
        burn._play = () => burn.classList.add("strip-in");
        fuelCards.push(burn);
        if (F.save > 0 && F.saveCost !== null) {
            const sv = count(F.saveCost, (x) => money(x));
            const c = card("rs-save", [h("span", { class: "rs-save-ic", text: "💰" }), h("div", {}, [h("small", { text: "Riding fully eco would have saved" }), h("div", { class: "rs-big" }, [sv]), h("small", { text: `${fuelTxt(F.save, ev)} on this ride · the bike's eco speed, steady throttle` })])], "Saving");
            c._play = sv._play;
            fuelCards.push(c);
        }

        // ------------------------------------------------ 3. rider & bike
        const g = gauge(B.ecoScore, tone, "Eco score");
        const met = (l, v) => (v === null || v === undefined ? null : h("li", {}, [h("span", { text: l }), h("b", { text: v })]));
        const mood = card(`rs-mood t-${B.tone}`, [
            h("div", { class: "rs-card-h" }, [h("span", { class: "rs-card-t", text: "Riding behaviour" }), h("span", { class: "rs-state", style: `--c:${tone}` }, [h("i"), B.label.toUpperCase()])]),
            h("div", { class: "rs-mood-hero", style: `--c:${tone}` }, [
                h("div", { class: "rs-mood-ring" }, [h("span", { text: B.icon }), h("i", { class: "rs-arc a" }), h("i", { class: "rs-arc b" }), h("i", { class: "rs-arc c" })]),
                h("div", {}, [h("b", { class: "rs-mood-l", text: B.label }), h("p", { class: "rs-mood-p", text: moodLine(B) })])
            ]),
            h("div", { class: "rs-mood-grid" }, [g, h("ul", { class: "rs-metrics" }, [
                met("In the eco speed band", B.inBand !== null ? pct(B.inBand) : null),
                met("Faster than eco speed", B.above !== null ? pct(B.above) : null),
                met("Over the speed limit", B.overLimit !== null ? `${pct(B.overLimit)} · ${dur(B.overLimitTime || 0)}` : null),
                met("Hard braking", String(B.hardBrakes)),
                met("Hard pick-ups", String(B.hardPulls)),
                met("Top speed", B.top ? `${kmh(B.top.speed)}${B.top.at !== null ? ` at km ${n1(B.top.at / 1000)}` : ""}` : null),
                met("Average while moving", B.avgMoving ? kmh(B.avgMoving) : null)
            ])])
        ], "Riding behaviour");
        mood._play = g._play;

        const ppl = st.people, bk = st.bike;
        const parts = [
            bk.mass ? { k: "bike", label: bk.name || "Bike", kg: bk.mass, color: "#9aa4b2", note: "with fuel" } : null,
            ppl.rider ? { k: "rider", label: ppl.rider.name, kg: ppl.rider.kg, color: "#c6f432", note: ppl.rider.typical ? "typical" : "", role: "Rider" } : null,
            ppl.pillion ? { k: "pillion", label: ppl.pillion.name, kg: ppl.pillion.kg, color: "#ff5a8a", note: ppl.pillion.typical ? "typical" : "", role: "Pillion" } : null,
            ppl.luggage > 0.5 ? { k: "bag", label: "Luggage", kg: ppl.luggage, color: "#5ad1ff", note: "" } : null
        ].filter(Boolean);
        const totKg = parts.reduce((a, p) => a + (p.kg || 0), 0) || 1;
        const wcount = count(ppl.total || totKg, (x) => `${n0(x)} kg`);
        const team = card("rs-team", [
            head("Who and what was on the road", ppl.pillion ? "2 up" : "solo"),
            h("div", { class: "rs-people" }, parts.filter((p) => p.role).map((p) => h("div", { class: `rs-person ${p.k}` }, [h("span", { class: "rs-av", text: (p.label || "?").slice(0, 1).toUpperCase() }), h("div", {}, [h("small", { text: p.role + (ppl.me === p.k ? " · you" : "") }), h("b", { text: p.label }), h("span", { text: p.kg ? `${n0(p.kg)} kg${p.note ? ` (${p.note})` : ""}` : "weight not set" })])]))),
            h("div", { class: "rs-bike" }, [h("span", { class: "rs-bike-ic", text: "🏍️" }), h("div", {}, [h("b", { text: bk.name || "Your bike" }), h("small", { text: [bk.mass ? `${n0(bk.mass)} kg ready to ride` : null, bk.tank ? `${n1(bk.tank * 1000)} L tank` : null, F.usualKmL ? `usually ${n1(F.usualKmL)} km/L` : null, bk.typical ? "typical bike (pick yours in My bike)" : null].filter(Boolean).join(" · ") })])]),
            h("div", { class: "rs-weigh" }, [h("small", { text: "Moving weight" }), wcount]),
            h("div", { class: "rs-wbar" }, parts.map((p) => h("i", { style: `--w:${((p.kg || 0) / totKg) * 100}%;background:${p.color}`, title: `${p.label} ${n0(p.kg || 0)} kg` }))),
            h("div", { class: "rs-wkey" }, parts.map((p) => h("span", {}, [h("i", { style: `background:${p.color}` }), `${p.role || p.label} ${n0(p.kg || 0)} kg`])))
        ], "People and bike");
        team._play = () => { wcount._play(); team.classList.add("bars-in"); };

        const Dg = st.drag, wind = Dg.wind;
        const windTxt = !wind ? "No wind data for this ride (offline)." : wind.kind === "calm" ? "Hardly any wind against or behind you." : wind.kind === "head" ? `Headwind of about ${kmh(wind.headwind)} at your height` : `Tailwind of about ${kmh(-wind.headwind)} pushing you`;
        const air = card(`rs-air ${wind ? `w-${wind.kind}` : ""}`, [
            head("Air drag", Dg.share !== null ? `${pct(Dg.share)} of your push` : null, "blue"),
            h("div", { class: "rs-air-art", "aria-hidden": "true" }, [
                ...Array.from({ length: 7 }, (_, i) => h("i", { class: "rs-stream", style: `--y:${12 + i * 12}%;--d:${(i % 3) * 0.4}s;--s:${wind && wind.kind === "head" ? 1.1 : wind && wind.kind === "tail" ? 2.6 : 1.7}s` })),
                h("span", { class: "rs-rider-ic", text: "🏍️" })
            ]),
            h("p", { class: "rs-air-p" }, [Dg.fuel !== null ? `≈ ${fuelTxt(Dg.fuel, ev)} went into pushing air aside. ` : "", windTxt]),
            wind && wind.fuel !== null && Math.abs(wind.fuel) > 1e-7 ? h("div", { class: `rs-windcost ${wind.fuel > 0 ? "bad" : "good"}` }, [h("b", { text: `${wind.fuel > 0 ? "+" : "−"}${fuelTxt(Math.abs(wind.fuel), ev)}${wind.cost !== null ? ` · ${money(Math.abs(wind.cost))}` : ""}` }), h("small", { text: wind.fuel > 0 ? "the wind cost you" : "the wind saved you" })]) : null,
            h("ul", { class: "rs-metrics small" }, [
                met("Frontal drag area (CdA)", Dg.cda ? `${n2(Dg.cda)} m²` : null),
                met("Air density", Dg.rho ? `${n2(Dg.rho)} kg/m³${st.weather && st.weather.densityVsStd !== null ? ` (${st.weather.densityVsStd >= 0 ? "+" : ""}${pct(st.weather.densityVsStd)} vs standard)` : ""}` : null)
            ])
        ], "Air drag");

        const Wx = st.weather;
        const wxCard = card("rs-wx", Wx ? [
            head("Weather on the ride", `${Wx.samples} reading${Wx.samples > 1 ? "s" : ""}`),
            h("div", { class: "rs-wx-hero" }, [h("span", { class: "rs-wx-ic", text: Wx.sky ? Wx.sky.icon : "🌡️" }), h("div", {}, [h("b", { class: "rs-wx-t", text: Wx.tempC !== null ? `${n0(Wx.tempC)}°C` : "–" }), h("small", { text: Wx.sky ? Wx.sky.text : "" })])]),
            h("ul", { class: "rs-metrics" }, [
                met("Humidity", Wx.rh !== null ? pct(Wx.rh) : null),
                met("Wind (10 m up)", Wx.wind !== null ? `${kmh(Wx.wind)}${Wx.windFromText ? ` from the ${Wx.windFromText}` : ""}` : null),
                met("Rain", Wx.precip > 0 ? `${n1(Wx.precip)} mm` : "none"),
            ]),
            h("p", { class: "rs-src", text: "Open-Meteo, sampled every 10 min while riding" })
        ] : [head("Weather on the ride"), h("p", { class: "rs-muted", text: "No weather was fetched for this ride (the phone was offline, or the ride was short)." })], "Weather");

        // ------------------------------------------------ 4. the road
        const R = st.road;
        const rcount = (icon, label, v, cls) => { const c = count(v, (x) => String(Math.round(x))); const el = h("div", { class: `rs-rc ${cls}` }, [h("span", { class: "rs-rc-ic", text: icon }), c, h("small", { text: label })]); el._c = c; return el; };
        const pl = (n, one, many) => (n === 1 ? one : many);
        const roadCounts = R.sensor ? [rcount("🕳️", pl(R.potholes, "pothole", "potholes"), R.potholes, "hole"), rcount("〰️", pl(R.breakers, "speed breaker", "speed breakers"), R.breakers, "breaker"), rcount("💥", pl(R.bumps, "bump", "bumps"), R.bumps, "bump"), rcount("🪨", `${pl(R.rough, "rough patch", "rough patches")}${R.roughM ? ` · ${km(R.roughM)}` : ""}`, R.rough, "rough")] : [];
        const road = card("rs-road", [
            head("The road", R.sensor ? "felt by your phone" : "sensor off", R.sensor ? "orange" : ""),
            R.sensor ? h("div", { class: "rs-rcs" }, roadCounts) : h("p", { class: "rs-muted", text: "The road sensor wasn't on for this ride (it runs in the Android app with the phone on the handlebar). Potholes and rough road aren't counted, so nothing is shown rather than a made-up zero." }),
            R.sensor && (R.small || R.unknown) ? h("p", { class: "rs-muted", text: `${R.small ? `${R.small} small bump${R.small > 1 ? "s" : ""}` : ""}${R.small && R.unknown ? " and " : ""}${R.unknown ? `${R.unknown} jolt${R.unknown > 1 ? "s" : ""} it couldn't name` : ""} too. Review them in “Review last ride”.` }) : null,
            h("div", { class: "rs-climb" }, [h("div", {}, [h("small", { text: "Climbed" }), h("b", { text: `↗ ${n0(st.headline.climb)} m` })]), h("div", {}, [h("small", { text: "Descended" }), h("b", { text: `↘ ${n0(st.headline.descent)} m` })])])
        ], "The road");
        road._play = () => roadCounts.forEach((x) => x._c._play());

        const brakeList = B.brakeList.slice(0, 6);
        const brakesCard = card("rs-brakes", [
            head("Hard braking", `${B.hardBrakes}×`, B.hardBrakes ? "red" : "green"),
            B.hardBrakes ? h("ol", { class: "rs-blist" }, brakeList.map((b, i) => h("li", { style: `--i:${i}` }, [h("span", { class: "rs-bnum", text: String(i + 1) }), h("span", { text: `at km ${n1(b.at / 1000)}` }), h("b", { text: `from ${kmh(b.from)}` })]))) : h("p", { class: "rs-muted", text: "No hard braking on this ride (harder than 3.5 m/s² for a second). Smooth!" }),
            B.hardPulls ? h("p", { class: "rs-muted", text: `And ${B.hardPulls} hard pick-up${B.hardPulls > 1 ? "s" : ""} (faster than 2.5 m/s²): each one burns extra.` }) : null
        ], "Hard braking");

        // ------------------------------------------------ 5. time
        const tItems = [
            { label: "Riding", color: "#c6f432", share: T.duration ? T.riding / T.duration : 0, value: dur(T.riding) },
            { label: "Traffic halts", color: "#ffb020", share: T.duration ? T.trafficTime / T.duration : 0, value: `${T.traffic}× · ${dur(T.trafficTime)}` },
            { label: "Breaks", color: "#a78bfa", share: T.duration ? T.restTime / T.duration : 0, value: `${T.rest}× · ${dur(T.restTime)}` }
        ];
        const other = Math.max(0, 1 - tItems.reduce((a, x) => a + x.share, 0));
        if (other > 0.01) tItems.push({ label: "Crawling, short halts", color: "#4b5563", share: other, value: dur(other * T.duration) });
        const tDonut = donut(tItems, dur(T.duration), "start to finish");
        const span = Math.max(1, st.endedAt - st.startedAt);
        const tl = h("div", { class: "rs-tl" });
        const blocks = (entry.journal.stops || []).map((x) => h("i", { class: x.rest ? "rest" : "halt", style: `left:${((x.t - st.startedAt) / span) * 100}%;width:${Math.max(0.6, (x.dur * 1000 / span) * 100)}%`, title: `${x.rest ? "Break" : "Halt"} · ${dur(x.dur)} at ${clock(x.t)}` }));
        tl.replaceChildren(h("b", { class: "rs-tl-fill" }), ...blocks);
        const timeCard = card("rs-time", [
            head("Riding vs resting", `${T.stops} stop${T.stops === 1 ? "" : "s"}`),
            tDonut,
            h("div", { class: "rs-tl-wrap" }, [tl, h("div", { class: "rs-tl-ax" }, [h("span", { text: clock(st.startedAt) }), h("span", { text: clock(st.endedAt) })])]),
            h("ul", { class: "rs-metrics" }, [
                met("Longest non-stop riding", T.longestRun ? `${dur(T.longestRun.time)} · ${km(T.longestRun.distance)}` : null),
                met("Longest break", T.longestRest ? dur(T.longestRest) : "no breaks"),
                met("Stops of 10 s or more", String(T.stops))
            ])
        ], "Time");
        timeCard._play = () => { tDonut._play(); timeCard.classList.add("tl-in"); };

        const facts = st.facts.filter((f) => ["floors", "air"].includes(f.key));
        const factCard = facts.length ? card("rs-facts", [head("Fun facts", null), ...facts.map((f, i) => h("p", { class: "rs-fact", style: `--i:${i}`, text: f.text }))], "Fun facts") : null;

        // ------------------------------------------------ layout
        const CH = [
            { id: "ride", label: "Ride", icon: "🗺️", color: "#c6f432", cards: [journey, kpis, chartCard] },
            { id: "fuel", label: ev ? "Energy" : "Fuel", icon: "⛽", color: "#ff8a3d", cards: fuelCards },
            { id: "rider", label: "Rider", icon: "🧑", color: "#ff5a8a", cards: [mood, team, air, wxCard] },
            { id: "road", label: "Road", icon: "🛣️", color: "#5ad1ff", cards: [road, brakesCard] },
            { id: "time", label: "Time", icon: "⏱️", color: "#a78bfa", cards: [timeCard, factCard].filter(Boolean) }
        ];
        const body = h("div", { class: "rs-body" }, CH.map((c) => h("div", { class: "rs-chapter", id: `rs-ch-${c.id}`, "data-ch": c.id }, [h("h3", { class: "rs-ch-t", style: `--c:${c.color}` }, [h("span", { text: c.icon }), c.label]), h("div", { class: "rs-grid" }, c.cards)])));
        const blob = h("span", { class: "rs-blob" });
        const dockLabel = h("span", { class: "rs-dock-l", text: CH[0].label });
        const dock = h("nav", { class: "rs-dock", "aria-label": "Chapters" }, [blob, ...CH.map((c, i) => h("button", { type: "button", class: "rs-dock-b", "data-ch": c.id, "aria-label": c.label, onclick: () => { stopPlay(); go(i); } }, [h("span", { text: c.icon })]))]);
        const playBtn = h("button", { type: "button", class: "rs-play", "aria-label": "Play the story", text: "▶", onclick: () => (playTimer ? stopPlay() : play()) });
        const shareBtn = h("button", { type: "button", class: "rs-hbtn", text: "Share card", onclick: () => { const m = W.MUShare && W.MUShare.app; if (m && m.last && Math.abs(Number(m.last.trip && m.last.trip.startedAt) - entry.id) < 1000) { close(); m.open(null); } else if (typeof showToast === "function") showToast("Open the ride in My rides → Share card.", 3500); } });
        root = h("div", { class: "rs-modal", role: "dialog", "aria-modal": "true", "aria-label": `Ride story: ${st.title}` }, [
            h("div", { class: "rs-bg", "aria-hidden": "true" }, [h("i", { class: "o1" }), h("i", { class: "o2" }), h("i", { class: "o3" })]),
            h("header", { class: "rs-top" }, [
                h("div", { class: "rs-brand" }, [h("span", { class: "rs-badge" }, [h("i"), "RIDE STORY"]), h("h2", { class: "rs-title", text: st.title }), h("p", { class: "rs-title-sub", text: sub })]),
                h("div", { class: "rs-top-r" }, [playBtn, h("button", { type: "button", class: "rs-x", "aria-label": "Close", text: "✕", onclick: close })])
            ]),
            h("div", { class: "rs-scroll" }, [body, h("div", { class: "rs-foot" }, [
                h("p", { class: "rs-src", text: `Fuel, eco score and hard moments: the physics model with your GPS${st.corrected ? ", matched to your fill-ups" : ""}. “≈” = estimated from the bike's drag and rolling figures. Everything stays on this phone.` }),
                shareBtn
            ])]),
            h("div", { class: "rs-dock-wrap" }, [dockLabel, dock])
        ]);
        document.body.append(root);
        requestAnimationFrame(() => root && root.classList.add("in"));
        const scroller = root.querySelector(".rs-scroll");
        keyH = (e) => { if (e.key === "Escape") close(); };
        document.addEventListener("keydown", keyH);

        // reveal + play each card once
        io = new IntersectionObserver((ents) => {
            for (const en of ents) {
                if (!en.isIntersecting) continue;
                const el = /** @type {any} */ (en.target);
                io.unobserve(el);
                el.classList.add("in");
                if (typeof el._play === "function") setTimeout(() => { try { el._play(); } catch (e) { /* one card */ } }, 180);
            }
        }, { root: scroller, threshold: 0.18 });
        root.querySelectorAll(".rs-card").forEach((c, i) => { /** @type {HTMLElement} */ (c).style.setProperty("--k", String(i % 3)); io.observe(c); });

        // the dock follows the chapter in view
        let cur = -1;
        function setCh(i) {
            if (i === cur) return;
            cur = i;
            const b = dock.querySelectorAll(".rs-dock-b")[i];
            if (!b) return;
            dock.querySelectorAll(".rs-dock-b").forEach((x, k) => x.classList.toggle("on", k === i));
            blob.style.transform = `translateX(${/** @type {HTMLElement} */ (b).offsetLeft}px)`;
            blob.style.background = CH[i].color;
            blob.style.boxShadow = `0 0 26px ${CH[i].color}aa`;
            root.style.setProperty("--glow", CH[i].color);
            dockLabel.classList.remove("swap"); void dockLabel.offsetWidth; dockLabel.classList.add("swap");
            dockLabel.textContent = CH[i].label;
        }
        function go(i) { const t = root && root.querySelector(`#rs-ch-${CH[i].id}`); if (t) t.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" }); setCh(i); }
        scroller.addEventListener("scroll", () => {
            const top = scroller.getBoundingClientRect().top + 90;
            let best = 0;
            root.querySelectorAll(".rs-chapter").forEach((c, i) => { if (c.getBoundingClientRect().top <= top) best = i; });
            setCh(best);
        }, { passive: true });
        requestAnimationFrame(() => setCh(0));

        // ▶ the chapters by themselves
        function play() {
            playBtn.textContent = "❚❚"; playBtn.classList.add("on");
            let i = Math.max(0, cur);
            const next = () => { if (!root) return; go(i); i++; playTimer = i <= CH.length ? setTimeout(() => (i < CH.length ? next() : stopPlay()), 4200) : 0; };
            next();
        }
        function stopPlay() { clearTimeout(playTimer); playTimer = 0; playBtn.textContent = "▶"; playBtn.classList.remove("on"); }
        root._go = go;
    }

    /** One plain sentence about the riding, from its numbers. */
    function moodLine(B) {
        const bits = [];
        if (B.ecoScore !== null) bits.push(`Eco score ${Math.round(B.ecoScore * 100)}`);
        if (B.inBand !== null) bits.push(`${pct(B.inBand)} of the way in the eco speed band`);
        bits.push(B.hardBrakes + B.hardPulls === 0 ? "no hard braking or pick-ups" : `${B.hardBrakes} hard brake${B.hardBrakes === 1 ? "" : "s"}, ${B.hardPulls} hard pick-up${B.hardPulls === 1 ? "" : "s"}`);
        const tip = { smooth: "Keep it up.", steady: "A steadier throttle would push the score higher.", fast: "Easing off to the eco speed saves the most here.", brakes: "Looking further ahead lets you roll off instead of braking.", throttle: "Rolling on gently saves fuel and the tyres.", mixed: "Steady speeds in the eco band would lift the score." }[B.key] || "";
        return `${bits.join(" · ")}. ${tip}`;
    }

    function has(id) { return Boolean(find(Number(id))); }
    function remove(id) { const db = read(); db.list = db.list.filter((x) => Math.abs(x.id - Number(id)) >= 1000); write(db); }
    function clear() { try { localStorage.removeItem(KEY); } catch (e) { /* private mode */ } }

    document.addEventListener("mu:ride-summary", onSummary);
    const boot = () => { const b = document.getElementById("share-story-btn"); if (b) b.addEventListener("click", () => open(lastId || (read().list[0] || {}).id)); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
    return { open, close, has, remove, clear, get list() { return read().list.map((x) => x.id); } };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).RideStory = RideStory;
