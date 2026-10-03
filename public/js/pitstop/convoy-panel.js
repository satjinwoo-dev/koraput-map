// @ts-check
/* ============================================================================
   MapUnite pitstops — the Convoy & Pitstop planner overlay
   ==============================================================================
   MUPitstop.panel.createConvoyPanel(root, deps) → { setModel, setLevel, highlight, destroy }

   For a group ride to one destination:
     - Who needs fuel or charge first: a banner for the most urgent rider, and
       every rider ranked by urgency with a status (icon + words, never colour
       alone): on reserve / needs fuel soon / needs a stop / tight / fine.
     - The fuel timeline: one lane per rider along the route, their tank or
       battery level from where they are to the destination, the planned
       refills, the reserve line, and the communal stops across all lanes.
       Crosshair readout of everyone's level at any km (tap on phones).
     - Communal pitstops: the station (from OpenStreetMap), where and when, who
       fills up or charges (and roughly how long), who just waits. Show it on
       the map or navigate to it.
     - Each rider's bike, level (and where that number came from: shared,
       estimated from fill-ups, set here, or assumed), energy to the
       destination and trip cost; "Split evenly" shows the settle-up.
     - Levels can be set here for anyone ("Arjun says half a tank"): the plan
       updates instantly.

   Identity colours are the group-trip route colours (the same as each rider's
   route line on the map), always paired with the rider's name. SI in, people's
   units out (garage/units.js).
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUPitstop || (/** @type {any} */ (root).MUPitstop = {}); ns.panel = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const SVG_NS = "http://www.w3.org/2000/svg";
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
            else if (k === "html") el.innerHTML = v;                 // static, trusted markup only (icons, silhouettes)
            else if (k === "style") el.setAttribute("style", v);
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c !== null && c !== false) el.append(c);
        return el;
    }
    /** @param {string} tag @param {Record<string, string|number>} [attrs] */
    function s(tag, attrs = {}) {
        const el = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
        return el;
    }
    const ICON = {
        fuel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M3 21h12M7 8h4"/><path d="M14 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V8.5L18 5"/></svg>`,
        bolt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>`,
        alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18h.01"/></svg>`,
        check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`,
        clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
        pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>`,
        nav: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 11 21 3l-8 18-2-8-8-2z"/></svg>`,
        flag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>`,
        x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
        chev: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`
    };
    const STATUS = {
        reserve: { tone: "critical", icon: "alert" },
        soon: { tone: "warn", icon: "fuel" },
        stop: { tone: "serious", icon: "fuel" },
        tight: { tone: "caution", icon: "alert" },
        ok: { tone: "good", icon: "check" }
    };

    // ------------------------------------------------------------------ pure helpers (tested)
    /** km text: "96 km", "4.2 km". */
    function kmText(m, U) { return `${U.num(m / 1000, m < 10000 ? 1 : 0)} km`; }
    /** Duration: "45 min", "1 h 20 min". */
    function durText(sec, U) {
        const min = Math.max(1, Math.round(sec / 60));
        return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
    }
    /** Energy in people's units. */
    function energyText(q, kind, U) { return kind === "ev" ? `${U.num(q / 3.6e6, q < 3.6e7 ? 2 : 1)} kWh` : `${U.num(q * 1000, q < 0.01 ? 2 : 1)} L`; }

    /**
     * The status line for one rider (pure). @param {any} r plan member @param {any} rider model rider @param {any} U
     * @returns {{ label: string, detail: string, tone: string, icon: string }}
     */
    function statusFor(r, rider, U) {
        const what = rider.kind === "ev" ? "charge" : "fuel";
        const base = { ...STATUS[r.status] };
        if (rider.kind === "ev" && base.icon === "fuel") base.icon = "bolt";
        if (r.status === "reserve") return { ...base, label: rider.kind === "ev" ? "Battery on reserve" : "On reserve now", detail: `${U.num(r.share * 100, 0)} % left: ${what} at the first chance` };
        if (r.status === "soon") return { ...base, label: `Needs ${what} soon`, detail: `within ${kmText(r.needIn, U)}, by km ${U.num(r.needBy / 1000, 0)}` };
        if (r.status === "stop") return { ...base, label: `Needs a ${what} stop`, detail: `by km ${U.num(r.needBy / 1000, 0)} (${kmText(r.needIn, U)} from here)` };
        if (r.status === "tight") return { ...base, label: "Tight", detail: `arrives with about ${U.num(Math.max(0, r.arriveShare) * 100, 0)} % left` };
        return { ...base, label: "Fine to the destination", detail: `arrives with about ${U.num(r.arriveShare * 100, 0)} % left` };
    }

    /**
     * Each rider's level (share of capacity) along the route under the plan (pure).
     * @param {any} rider model rider (C, startS, energy, capacity, joinCost)  @param {any} plan  @param {ArrayLike<number>} S route samples  @param {any} P plan module
     * @param {number} [points]
     * @returns {Array<[number, number]>}  [s (m), share]
     */
    function levelSeries(rider, plan, S, P, points = 160) {
        const n = S.length, end = S[n - 1];
        const start = Math.min(end, Math.max(0, rider.startS));
        const refills = plan.stops.map((st) => ({ s: st.s, add: (st.riders.find((x) => x.id === rider.id) || { energyAdded: 0 }).energyAdded })).filter((x) => x.add > 0);
        const e0 = rider.energy - (rider.joinCost || 0), c0 = P.at(S, rider.C, start);
        const xs = [];
        for (let i = 0; i <= points; i++) xs.push(start + ((end - start) * i) / points);
        for (const rf of refills) if (rf.s > start && rf.s < end) xs.push(rf.s, rf.s + 1e-3);
        xs.sort((a, b) => a - b);
        return xs.map((x) => {
            let e = e0 - (P.at(S, rider.C, x) - c0);
            for (const rf of refills) if (x > rf.s) e += rf.add;
            return /** @type {[number, number]} */ ([x, rider.capacity > 0 ? e / rider.capacity : 0]);
        });
    }

    // ------------------------------------------------------------------ the panel
    /**
     * @param {HTMLElement} root
     * @param {{ units: any, plan: any, silhouettes?: any, onClose?: () => void, onFocusRider?: (id: string) => void,
     *   onFocusStop?: (stop: any, index: number) => void, onNavigateStop?: (stop: any) => void,
     *   onLevelChange?: (id: string, share: number) => void, onPlan?: (plan: any, model: any) => void }} deps
     */
    function createConvoyPanel(root, deps) {
        const U = deps.units, P = deps.plan;
        const uid = `cp${Math.random().toString(36).slice(2, 8)}`;
        let model = null, plan = null, split = false, focus = null, expanded = new Set(), cursorS = null, ro = null, lastW = 0;
        root.classList.add("cp");
        root.setAttribute("role", "region");
        root.setAttribute("aria-label", "Convoy and pitstop planner");

        const head = h("header", { class: "cp-head" });
        const body = h("div", { class: "cp-body" });
        root.replaceChildren(head, body);

        /** @param {any} m */
        function setModel(m) { model = m; replan(); }
        function replan() {
            if (!model) return;
            if (model.state && model.state !== "ready") { renderState(); return; }
            plan = P.planConvoy({
                s: model.route.s,
                members: model.riders.map((r) => ({ id: r.id, kind: r.kind, startS: r.startS, joinCost: r.joinCost || 0, energy: r.energy, capacity: r.capacity, C: r.C })),
                stations: model.stations ? model.stations.list : []
            });
            if (deps.onPlan) deps.onPlan(plan, model);
            render();
        }

        function renderHead(sub) {
            head.replaceChildren(
                h("span", { class: "cp-grip", "aria-hidden": "true" }),
                h("div", { class: "cp-head-main" }, [
                    h("h2", { class: "cp-title", id: `${uid}-t`, text: "Convoy fuel plan" }),
                    h("p", { class: "cp-sub", text: sub })
                ]),
                deps.onClose ? h("button", { type: "button", class: "cp-close", "aria-label": "Close the fuel plan", html: ICON.x, onclick: deps.onClose }) : null
            );
        }
        function renderState() {
            if (ro) { ro.disconnect(); ro = null; }                         // the old timeline mustn't redraw against a model without a route
            renderHead(model && model.destName ? `To ${model.destName}` : "Group ride");
            body.replaceChildren(h("div", { class: "cp-state" }, [
                model.state === "loading" ? h("span", { class: "cp-spinner", "aria-hidden": "true" }) : null,
                h("p", { text: model.message || "Working out everyone's fuel…" })
            ]));
        }

        function render() {
            const riders = model.riders;
            const byId = new Map(riders.map((r) => [r.id, r]));
            const res = new Map(plan.members.map((m) => [m.id, m]));
            const ranked = [...plan.members].sort((a, b) => a.rank - b.rank);
            const L = model.route.distance;
            const avgSpeed = model.route.duration > 0 ? L / model.route.duration : 40 / 3.6;
            renderHead(`${riders.length} rider${riders.length === 1 ? "" : "s"} · ${kmText(L, U)} to ${model.destName || "the destination"}`);
            body.replaceChildren();

            // ---- banner: the most urgent rider ----
            const first = ranked[0] && byId.get(ranked[0].id);
            if (first && ranked[0].status !== "ok") {
                const st = statusFor(ranked[0], first, U);
                const who = first.me ? "You" : first.name;
                const need = ranked[0].status === "tight" ? `${who} ${first.me ? "arrive" : "arrives"} tight` : `${who} ${first.me ? "need" : "needs"} ${first.kind === "ev" ? "charge" : "fuel"} first`;
                body.append(h("div", { class: `cp-banner is-${st.tone}`, role: "status" }, [
                    h("span", { class: "cp-banner-i", "aria-hidden": "true", html: ICON[st.icon] }),
                    h("span", { class: "cp-banner-t" }, [h("strong", { text: need }), h("span", { text: st.detail })])
                ]));
            } else if (first) {
                body.append(h("div", { class: "cp-banner is-good", role: "status" }, [
                    h("span", { class: "cp-banner-i", "aria-hidden": "true", html: ICON.check }),
                    h("span", { class: "cp-banner-t" }, [h("strong", { text: "Everyone reaches the destination" }), h("span", { text: "No fuel or charging stop needed." })])
                ]));
            }

            // ---- timeline ----
            const tl = h("section", { class: "cp-card cp-timeline", "aria-labelledby": `${uid}-tl` });
            const plot = h("div", { class: "cp-plot" });
            const readout = h("p", { class: "cp-readout", "aria-live": "polite" });
            tl.append(h("div", { class: "cp-card-head" }, [h("h3", { id: `${uid}-tl`, text: "Fuel timeline" }), h("span", { class: "cp-key" }, [h("span", { class: "cp-key-res", "aria-hidden": "true" }), "reserve"])]), plot, readout);
            body.append(tl);
            const drawTimeline = () => {
                if (!model || model.state !== "ready" || !model.route) return;
                const W = Math.max(280, plot.clientWidth || 360);
                const m = { l: 76, r: 14, t: 24, b: 22 }, laneH = 30, gap = 8;
                const order = ranked.map((r) => byId.get(r.id)).filter(Boolean);
                const X = (sv) => m.l + (sv / L) * (W - m.l - m.r);
                // stop numbers that would touch go on a second row
                const pinRow = [];
                plan.stops.forEach((st, i) => { pinRow[i] = i > 0 && X(st.s) - X(plan.stops[i - 1].s) < 20 && pinRow[i - 1] === 0 ? 1 : 0; });
                if (pinRow.includes(1)) m.t = 44;
                const H = m.t + order.length * (laneH + gap) - gap + m.b;
                const svg = s("svg", { class: "cp-svg", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", tabindex: "0", "aria-label": "Fuel timeline: each rider's tank or battery level along the route. Use the arrow keys to move along it." });
                // km ticks
                const step = L > 300000 ? 100000 : L > 120000 ? 50000 : L > 40000 ? 20000 : L > 15000 ? 5000 : 2000;
                for (let k = 0; k <= L + 1; k += step) {
                    svg.append(s("line", { class: "cp-tick-line", x1: X(k), x2: X(k), y1: m.t - 4, y2: H - m.b }));
                    const t = s("text", { class: "cp-tick", x: X(k), y: H - 6, "text-anchor": k === 0 ? "start" : "middle" }); t.textContent = k === 0 ? "0" : U.num(k / 1000, 0); svg.append(t);
                }
                const kl = s("text", { class: "cp-tick", x: m.l - 8, y: H - 6, "text-anchor": "end" }); kl.textContent = "km"; svg.append(kl);
                // zone stops (no station): shaded stretch; station stops: line + number
                plan.stops.forEach((st, i) => {
                    if (st.noStation) svg.append(s("rect", { class: "cp-zone", x: X(st.window[0]), y: m.t - 4, width: Math.max(2, X(st.window[1]) - X(st.window[0])), height: H - m.b - m.t + 4 }));
                    svg.append(s("line", { class: `cp-stop-line${st.noStation ? " is-zone" : ""}`, x1: X(st.s), x2: X(st.s), y1: m.t - 6, y2: H - m.b }));
                    const g = s("g", { class: "cp-stop-pin", transform: `translate(${X(st.s)},${m.t - 13 - pinRow[i] * 20})` });
                    g.append(s("circle", { r: 9 }));
                    const t = s("text", { y: 3.6, "text-anchor": "middle" }); t.textContent = String(i + 1); g.append(t);
                    svg.append(g);
                });
                // lanes
                order.forEach((rider, li) => {
                    const r = res.get(rider.id);
                    const y0 = m.t + li * (laneH + gap), y1 = y0 + laneH;
                    const Y = (sh) => y1 - Math.max(-0.05, Math.min(1, sh)) * laneH;
                    const g = s("g", { class: `cp-lane${focus === rider.id ? " is-focus" : ""}`, "data-id": rider.id });
                    g.append(s("rect", { class: "cp-lane-bg", x: m.l, y: y0, width: W - m.l - m.r, height: laneH, rx: 6 }));
                    const resv = rider.kind === "ev" ? P.PLAN_DEFAULTS.reserveEv : P.PLAN_DEFAULTS.reserveFuel;
                    g.append(s("line", { class: "cp-res-line", x1: m.l, x2: W - m.r, y1: Y(resv), y2: Y(resv) }));
                    const ser = levelSeries(rider, plan, model.route.s, P);
                    const line = ser.map(([x, sh], i) => `${i ? "L" : "M"}${X(x).toFixed(1)} ${Y(sh).toFixed(1)}`).join("");
                    g.append(s("path", { class: "cp-lane-area", d: `${line}L${X(ser[ser.length - 1][0]).toFixed(1)} ${y1}L${X(ser[0][0]).toFixed(1)} ${y1}Z`, style: `fill:${rider.color}` }));
                    g.append(s("path", { class: "cp-lane-line", d: line, style: `stroke:${rider.color}` }));
                    // below reserve (a plan that couldn't help them): red overlay
                    const low = ser.map(([x, sh], i) => (sh < resv ? `${i && ser[i - 1][1] < resv ? "L" : "M"}${X(x).toFixed(1)} ${Y(sh).toFixed(1)}` : "")).join("");
                    if (low) g.append(s("path", { class: "cp-lane-low", d: low }));
                    // where they are now
                    g.append(s("circle", { class: "cp-lane-dot", cx: X(Math.max(0, Math.min(L, rider.startS))), cy: Y(ser[0][1]), r: 4.5, style: `fill:${rider.color}` }));
                    // name
                    const nm = s("text", { class: "cp-lane-name", x: m.l - 8, y: y0 + laneH / 2 + 4, "text-anchor": "end" }); nm.textContent = rider.me ? "You" : rider.name.slice(0, 10); g.append(nm);
                    if (r && (r.status === "reserve" || r.status === "soon")) {
                        const w = s("text", { class: `cp-lane-flag is-${STATUS[r.status].tone}`, x: m.l - 8, y: y0 + laneH / 2 + 15, "text-anchor": "end" }); w.textContent = r.status === "reserve" ? "reserve" : "soon"; g.append(w);
                    }
                    g.addEventListener("click", () => setFocus(rider.id, true));
                    svg.append(g);
                });
                // destination flag
                const flag = s("g", { class: "cp-dest", transform: `translate(${W - m.r - 2},${m.t - 20})` });
                flag.append(s("path", { d: "M0 0v14M0 0h9l-2 3.5 2 3.5H0", fill: "none" }));
                svg.append(flag);
                const cross = s("line", { class: "cp-cross", x1: 0, x2: 0, y1: m.t - 4, y2: H - m.b, visibility: "hidden" });
                svg.append(cross);
                plot.replaceChildren(svg);
                const show = (sv) => {
                    cursorS = sv;
                    if (sv === null) { cross.setAttribute("visibility", "hidden"); readout.textContent = "Tap the timeline to read everyone's level at any point."; return; }
                    cross.setAttribute("x1", String(X(sv))); cross.setAttribute("x2", String(X(sv))); cross.setAttribute("visibility", "visible");
                    const parts = order.map((rider) => {
                        if (sv < rider.startS - 1) return `${rider.me ? "You" : rider.name}: not joined yet`;
                        const ser = levelSeries(rider, plan, model.route.s, P, 80);
                        let sh = ser[0][1];
                        for (const [x, v] of ser) { if (x > sv) break; sh = v; }
                        return `${rider.me ? "You" : rider.name} ${U.num(Math.max(0, sh) * 100, 0)} %`;
                    });
                    readout.textContent = `km ${U.num(sv / 1000, 0)} · ${parts.join(" · ")}`;
                };
                const toS = (clientX) => {
                    const box = svg.getBoundingClientRect();
                    const x = (clientX - box.left) * (W / box.width);
                    return Math.max(0, Math.min(L, ((x - m.l) / (W - m.l - m.r)) * L));
                };
                svg.addEventListener("pointermove", (e) => show(toS(e.clientX)));
                svg.addEventListener("pointerdown", (e) => show(toS(e.clientX)));
                svg.addEventListener("keydown", (e) => {
                    const stp = L / 40;
                    if (e.key === "ArrowRight") show(Math.min(L, (cursorS === null ? -stp : cursorS) + stp));
                    else if (e.key === "ArrowLeft") show(Math.max(0, (cursorS === null ? L + stp : cursorS) - stp));
                    else if (e.key === "Home") show(0);
                    else if (e.key === "End") show(L);
                    else if (e.key === "Escape") show(null);
                    else return;
                    e.preventDefault();
                });
                show(cursorS);
            };
            drawTimeline();
            if (ro) ro.disconnect();
            if (typeof ResizeObserver === "function") {
                ro = new ResizeObserver(() => { const w = plot.clientWidth; if (Math.abs(w - lastW) > 4) { lastW = w; drawTimeline(); } });
                ro.observe(plot);
            }

            // ---- pitstops ----
            const stopsSec = h("section", { class: "cp-stops", "aria-labelledby": `${uid}-st` });
            stopsSec.append(h("div", { class: "cp-sec-head" }, [
                h("h3", { id: `${uid}-st`, text: plan.stops.length ? `Pitstops (${plan.stops.length})` : "Pitstops" }),
                model.stations ? h("span", { class: "cp-src", text: model.stations.source === "none" ? "No station data (offline?)" : model.stations.source === "loading" ? "Finding stations…" : `${model.stations.list.length} stations on the route · OpenStreetMap` }) : null
            ]));
            if (!plan.stops.length) stopsSec.append(h("p", { class: "cp-muted", text: "No stop needed: everyone reaches the destination above their reserve." }));
            const strip = h("div", { class: "cp-stop-list", role: "list" });
            plan.stops.forEach((st, i) => {
                const eta = st.s / avgSpeed;
                const name = st.station ? `${st.station.name}${st.partner ? ` + ${st.partner.name}` : ""}` : `Somewhere between km ${U.num(st.window[0] / 1000, 0)} and ${U.num(st.window[1] / 1000, 0)}`;
                const chips = h("div", { class: "cp-stop-riders" });
                for (const sr of st.riders) {
                    const rd = byId.get(sr.id);
                    if (!rd) continue;
                    chips.append(h("span", { class: "cp-rchip", style: `--c:${rd.color}` }, [
                        h("span", { class: "cp-rchip-i", "aria-hidden": "true", html: sr.kind === "ev" ? ICON.bolt : ICON.fuel }),
                        `${rd.me ? "You" : rd.name}${sr.kind === "ev" ? ` +${energyText(sr.energyAdded, "ev", U)} (~${durText(sr.waitS, U)})` : ` · ${energyText(sr.energyAdded, "fuel", U)}`}`
                    ]));
                }
                const waiting = st.waiting.map((id) => byId.get(id)).filter(Boolean).map((r) => (r.me ? "you" : r.name));
                strip.append(h("article", { class: `cp-stop${st.noStation ? " is-zone" : ""}${st.urgent ? " is-urgent" : ""}`, role: "listitem", "aria-label": `Stop ${i + 1} at km ${U.num(st.s / 1000, 0)}: ${name}` }, [
                    h("div", { class: "cp-stop-top" }, [
                        h("span", { class: "cp-stop-n", text: String(i + 1) }),
                        h("div", { class: "cp-stop-where" }, [
                            h("strong", { text: name }),
                            h("span", { text: `km ${U.num(st.s / 1000, 0)} · in about ${durText(eta, U)}${st.partner ? ` · ${st.partner.kinds.includes("ev") ? "charger" : "pump"} ${kmText(Math.abs(st.partner.s - st.s), U)} ${st.partner.s >= st.s ? "on" : "back"}` : ""}${st.station && st.station.offRoute > 150 ? ` · ${kmText(st.station.offRoute, U)} off the route` : ""}` })
                        ]),
                        h("span", { class: "cp-stop-kinds", "aria-label": st.kinds.map((k) => (k === "ev" ? "charging" : "fuel")).join(" and ") }, st.kinds.map((k) => h("span", { class: `cp-kind is-${k}`, "aria-hidden": "true", html: k === "ev" ? ICON.bolt : ICON.fuel })))
                    ]),
                    st.noStation ? h("p", { class: "cp-stop-warn", text: model.stations && model.stations.source === "none" ? "No station data here right now. Plan to refuel along this stretch." : "No mapped station in range. Plan to refuel along this stretch, or ask locally." } ) : null,
                    st.urgent ? h("p", { class: "cp-stop-warn", text: "Someone is already on reserve: this is the nearest stop ahead." }) : null,
                    chips,
                    h("p", { class: "cp-stop-meta" }, [h("span", { class: "cp-mi", "aria-hidden": "true", html: ICON.clock }), `about ${durText(st.waitS, U)} stop${waiting.length ? ` · ${waiting.join(", ")} just ${waiting.length === 1 && waiting[0] !== "you" ? "waits" : "wait"}` : ""}`]),
                    h("div", { class: "cp-stop-actions" }, [
                        deps.onFocusStop ? h("button", { type: "button", class: "cp-btn-ghost", onclick: () => deps.onFocusStop && deps.onFocusStop(st, i) }, [h("span", { class: "cp-mi", "aria-hidden": "true", html: ICON.pin }), "Show on map"]) : null,
                        deps.onNavigateStop && st.station ? h("button", { type: "button", class: "cp-btn", onclick: () => deps.onNavigateStop && deps.onNavigateStop(st) }, [h("span", { class: "cp-mi", "aria-hidden": "true", html: ICON.nav }), "Navigate"]) : null
                    ])
                ]));
            });
            if (!plan.complete) strip.append(h("p", { class: "cp-stop-warn", text: "Couldn't plan the whole way: check the levels, or plan a stop yourself." }));
            stopsSec.append(strip);
            body.append(stopsSec);

            // ---- riders ----
            const prices = model.prices || {};
            const priceSI = { fuelPerM3: (prices.fuelPerLitre || 100) * 1000, energyPerJ: (prices.energyPerKWh || 8) / 3.6e6 };
            const money = P.costs(plan.members, priceSI);
            const costOf = new Map(money.rows.map((r) => [r.id, r.cost]));
            const ridersSec = h("section", { class: "cp-riders", "aria-labelledby": `${uid}-rd` });
            const splitBtn = h("button", { type: "button", class: "cp-toggle", "aria-pressed": String(split), onclick: () => { split = !split; render(); } }, ["Split evenly"]);
            ridersSec.append(h("div", { class: "cp-sec-head" }, [h("h3", { id: `${uid}-rd`, text: "Riders, most urgent first" }), splitBtn]));
            const list = h("div", { class: "cp-rider-list", role: "list" });
            for (const r of ranked) {
                const rd = byId.get(r.id);
                if (!rd) continue;
                const st = statusFor(r, rd, U);
                const open = expanded.has(rd.id);
                const cost = costOf.get(rd.id) || 0;
                const share = Math.max(0, Math.min(1, r.share));
                const resv = rd.kind === "ev" ? P.PLAN_DEFAULTS.reserveEv : P.PLAN_DEFAULTS.reserveFuel;
                const av = h("span", { class: "cp-avatar", style: `--c:${rd.color}`, "aria-hidden": "true" });
                if (rd.avatar) {
                    const img = h("img", { src: rd.avatar, alt: "", decoding: "async", referrerpolicy: "no-referrer" });
                    img.addEventListener("error", () => { img.remove(); av.textContent = (rd.name || "?").slice(0, 1).toUpperCase(); });
                    av.append(img);
                } else av.textContent = (rd.name || "?").slice(0, 1).toUpperCase();
                const gauge = h("span", { class: `cp-gauge${share <= resv ? " is-low" : ""}`, role: "img", "aria-label": `${rd.kind === "ev" ? "Battery" : "Tank"} ${U.num(share * 100, 0)} %` }, [
                    h("span", { class: "cp-gauge-fill", style: `width:${(share * 100).toFixed(1)}%;--c:${rd.color}` }),
                    h("span", { class: "cp-gauge-res", style: `left:${resv * 100}%` })
                ]);
                const costText = split ? `₹${U.num(money.even, 0)}` : `₹${U.num(cost, cost < 100 ? 1 : 0)}`;
                const settle = split ? money.even - cost : 0;
                const row = h("article", { class: `cp-rider is-${st.tone}${focus === rd.id ? " is-focus" : ""}`, role: "listitem", "data-id": rd.id }, [
                    h("button", { type: "button", class: "cp-rider-main", "aria-expanded": String(open), "aria-controls": `${uid}-r-${rd.id}`, onclick: () => { if (open) expanded.delete(rd.id); else expanded.add(rd.id); setFocus(rd.id, false); render(); } }, [
                        av,
                        h("span", { class: "cp-rider-id" }, [
                            h("span", { class: "cp-rider-name", text: rd.me ? `${rd.name} (you)` : rd.name }),
                            h("span", { class: "cp-rider-bike" }, [
                                deps.silhouettes ? h("span", { class: "cp-sil", "aria-hidden": "true", html: deps.silhouettes.silhouette(rd.bike.classKey) }) : null,
                                h("span", { text: rd.bike.name }),
                                rd.bike.estimated ? h("span", { class: "cp-est", text: "est." }) : null
                            ])
                        ]),
                        h("span", { class: "cp-rider-level" }, [gauge, h("span", { class: "cp-level-t", text: `${U.num(share * 100, 0)} %` })]),
                        h("span", { class: `cp-status is-${st.tone}` }, [h("span", { class: "cp-status-i", "aria-hidden": "true", html: ICON[st.icon] }), h("span", { text: st.label })]),
                        h("span", { class: "cp-cost" }, [h("strong", { text: costText }), split && Math.abs(settle) >= 1 ? h("small", { text: settle > 0 ? `pays ₹${U.num(settle, 0)} more` : `gets ₹${U.num(-settle, 0)} back` }) : h("small", { text: energyText(r.energyToEnd, rd.kind, U) })]),
                        h("span", { class: "cp-chev", "aria-hidden": "true", html: ICON.chev })
                    ])
                ]);
                if (open) {
                    const det = h("div", { class: "cp-rider-more", id: `${uid}-r-${rd.id}` });
                    const range = r.reachesEnd ? `reaches the destination (${U.num(r.arriveShare * 100, 0)} % left)` : `${kmText(r.needIn, U)} before the reserve`;
                    det.append(
                        h("dl", { class: "cp-facts" }, [
                            h("dt", { text: "Status" }), h("dd", { text: `${st.label}: ${st.detail}` }),
                            h("dt", { text: "Range now" }), h("dd", { text: range }),
                            h("dt", { text: "To the destination" }), h("dd", { text: `${energyText(r.energyToEnd, rd.kind, U)} · ₹${U.num(cost, cost < 100 ? 1 : 0)}${r.stops ? ` · ${r.stops} stop${r.stops === 1 ? "" : "s"}` : ""}` }),
                            h("dt", { text: "Level" }), h("dd", { text: rd.levelNote || "" }),
                            rd.offRoute > 300 ? h("dt", { text: "Joins the route" }) : null,
                            rd.offRoute > 300 ? h("dd", { text: `at km ${U.num(rd.startS / 1000, 0)}, ${kmText(rd.offRoute, U)} from where they are` }) : null,
                            rd.bike.note ? h("dt", { text: "Bike" }) : null, rd.bike.note ? h("dd", { text: rd.bike.note }) : null
                        ])
                    );
                    if (deps.onLevelChange) {
                        const lid = `${uid}-lv-${rd.id}`;
                        const out = h("output", { class: "cp-level-out", for: lid, text: `${U.num(share * 100, 0)} %` });
                        const input = h("input", { id: lid, class: "cp-range", type: "range", min: "0", max: "100", step: "5", value: String(Math.round(share * 100 / 5) * 5), style: `--c:${rd.color};--v:${(share * 100).toFixed(0)}%` });
                        input.addEventListener("input", () => { out.textContent = `${input.value} %`; input.style.setProperty("--v", `${input.value}%`); });
                        input.addEventListener("change", () => deps.onLevelChange && deps.onLevelChange(rd.id, Number(input.value) / 100));
                        det.append(h("div", { class: "cp-level-set" }, [
                            h("label", { for: lid, text: rd.me ? `Fuel in your ${rd.kind === "ev" ? "battery" : "tank"}` : `${rd.name}'s ${rd.kind === "ev" ? "battery" : "tank"} (what they told you)` }),
                            h("div", { class: "cp-level-row" }, [input, out])
                        ]));
                    }
                    row.append(det);
                }
                list.append(row);
            }
            ridersSec.append(list);
            body.append(ridersSec);

            // ---- footer: totals ----
            body.append(h("footer", { class: "cp-foot" }, [
                h("div", { class: "cp-total" }, [
                    h("span", { class: "cp-total-l", text: "Group trip cost" }),
                    h("strong", { class: "cp-total-v", text: `₹${U.num(money.total, 0)}` }),
                    h("span", { class: "cp-total-s", text: `₹${U.num(money.even, 0)} each if split · ${plan.stops.length ? `stops add about ${durText(plan.extraS, U)}` : "no stops"}` })
                ]),
                h("p", { class: "cp-note", text: `At ₹${U.num(prices.fuelPerLitre || 100, 1)}/L${prices.fuelExample ? " (example)" : ""} and ₹${U.num(prices.energyPerKWh || 8, 1)}/kWh${prices.energyExample ? " (example)" : ""}. Each rider's own bike and load, this route's hills and traffic. Reserve kept: 12 % of a tank, 10 % of a battery. Charging times assume a 3 kW charger.` })
            ]));
        }

        function setFocus(id, toggle) {
            focus = toggle && focus === id ? null : id;
            root.querySelectorAll(".cp-lane, .cp-rider").forEach((el) => el.classList.toggle("is-focus", el.getAttribute("data-id") === focus));
            if (focus && deps.onFocusRider) deps.onFocusRider(focus);
        }

        return {
            setModel,
            /** Update one rider's level (share) and re-plan. @param {string} id @param {number} share */
            setLevel(id, share) { if (!model) return; const r = model.riders.find((x) => x.id === id); if (!r) return; r.energy = Math.max(0, Math.min(1, share)) * r.capacity; r.levelSource = "set"; r.levelNote = r.me ? "Set by you, just now" : "Set here, from what they told you"; replan(); },
            highlight(id) { setFocus(id, false); },
            get plan() { return plan; },
            destroy() { if (ro) ro.disconnect(); root.replaceChildren(); root.classList.remove("cp"); }
        };
    }

    return { STATUS, kmText, durText, energyText, statusFor, levelSeries, createConvoyPanel };
});
