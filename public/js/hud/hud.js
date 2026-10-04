// @ts-check
/* ============================================================================
   MapUnite HUD — the SmartDrive head-up display (view)
   ==============================================================================
   MUHud.view.createHud(root, { units }) → { update, setAlert, show, hide, focus, destroy }

   Two layouts, one data feed:
     - Strip (default while riding): one glass instrument row beside the speed
       dial — live km/L, the eco band (score ring + one plain instruction), the
       trip cost. A pitstop alert sits above it only when there's one.
     - Focus (tap the strip): a full-screen riding dashboard for a mounted phone
       — huge live km/L, an eco-band speed scale with your speed, the trip cost,
       fuel used, eco score, range left and the next pitstop. Landscape puts the
       hero and the tiles side by side.

   Distraction rules (riding, not reading):
     - Big tabular numerals, ≥ 4.5:1 contrast, nothing that moves for its own sake;
       values update at most once a second and only by changing text.
     - One instruction at a time, and never "speed up": below the eco band the
       HUD just says so (traffic, limits and safety come first); above it, "ease
       off". The band is clamped to the posted limit when it's known.
     - State is always icon + words, never colour alone.
     - Alerts: shown once, spoken by the app's voice if allowed, critical ones
       stay until dismissed; others clear themselves.
     - Nothing needs a tap while moving; the only control is "focus" / "exit".
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUHud || (/** @type {any} */ (root).MUHud = {}); ns.view = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

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
    const ICON = {
        leaf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z"/><path d="M5 19 13 11"/></svg>`,
        down: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>`,
        dash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 12h12"/></svg>`,
        fuel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M3 21h12M7 8h4"/><path d="M14 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V8.5L18 5"/></svg>`,
        bolt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>`,
        alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18h.01"/></svg>`,
        expand: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`,
        x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
        bellOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M13.7 21a2 2 0 0 1-3.4 0"/><path d="M18.6 13A17.9 17.9 0 0 1 18 8M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.3-5"/><path d="m2 2 20 20"/></svg>`,
        bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>`,
        drop: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.7s6 6.4 6 11.3a6 6 0 0 1-12 0c0-4.9 6-11.3 6-11.3z"/></svg>`
    };

    // ------------------------------------------------------------------ pure helpers (tested)
    /**
     * The live figure in people's units.
     * @param {any} s live state @param {any} U units
     * @returns {{ value: string, unit: string, note: string, tone: "good"|"neutral"|"warn" }}
     */
    function liveFigure(s, U) {
        const ev = s.powertrain === "ev";
        if (!s || s.mode === "off") return { value: "–", unit: ev ? "Wh/km" : "km/L", note: "Engine off", tone: "neutral" };
        if (s.mode === "idle") {
            return ev ? { value: U.num(Math.max(0, s.rate), 0), unit: "W", note: "Standing", tone: "neutral" }
                : { value: U.num(s.rate * 3.6e6, 2), unit: "L/h", note: "Idling", tone: "neutral" };
        }
        if (s.mode === "coast" && !ev) return { value: "∞", unit: "km/L", note: "Fuel cut · coasting", tone: "good" };
        if (s.mode === "regen") return { value: `+${U.num(-s.rate / 1000, 1)}`, unit: "kW", note: "Charging · regen", tone: "good" };
        const pm = s.live !== null ? s.live : s.perMetre;
        if (pm === null || !Number.isFinite(pm)) return { value: "–", unit: ev ? "Wh/km" : "km/L", note: "Reading…", tone: "neutral" };
        const note = s.mode === "accel" ? "Accelerating" : s.mode === "slow" ? "Slowing" : "Steady";
        if (ev) return { value: U.num(Math.max(0, pm / 3.6), 0), unit: "Wh/km", note, tone: s.eco && s.eco.inBand && s.eco.steady ? "good" : s.mode === "accel" ? "warn" : "neutral" };
        const k = pm > 0 ? 1 / (pm * 1e6) : Infinity;
        return { value: k > 999 ? "∞" : U.num(k, k < 100 ? 1 : 0), unit: "km/L", note, tone: s.eco && s.eco.inBand && s.eco.steady ? "good" : s.mode === "accel" ? "warn" : "neutral" };
    }

    /**
     * One plain instruction about the eco band (never "speed up").
     * @param {any} s @param {any} U
     * @returns {{ text: string, short: string, tone: "good"|"warn"|"neutral", icon: keyof typeof ICON }}
     */
    function ecoGuidance(s, U) {
        if (!s || !s.eco || s.mode === "idle" || s.mode === "off") return { text: "Eco band appears once you're moving", short: "Eco", tone: "neutral", icon: "leaf" };
        const e = s.eco;
        const band = e.low === e.high ? `${U.num(e.low * 3.6, 0)} km/h` : `${U.num(e.low * 3.6, 0)}–${U.num(e.high * 3.6, 0)} km/h`;
        if (e.above) {
            const over = Math.max(1, Math.round((s.v - e.high) * 3.6));
            // a small, doable change gets an instruction; far above the band (open road, traffic
            // flow) the HUD only says what the speed costs, and leaves the riding to the rider
            if (over <= 15) return { text: `Ease off ${over} km/h · eco band ${band}`, short: `Ease off ${over}`, tone: "warn", icon: "down" };
            const pm = s.live !== null && s.live !== undefined ? s.live : s.perMetre;
            const extra = pm && e.bestPm > 0 ? Math.round((pm / e.bestPm - 1) * 100) : null;
            return { text: `Above the eco band (${band})${extra !== null && extra > 0 ? ` · ${extra} % more fuel per km` : ""}`, short: extra !== null && extra > 0 ? `+${extra} % per km` : "Above band", tone: "warn", icon: "down" };
        }
        if (e.below) return { text: `Below the eco band (${band})`, short: "Below band", tone: "neutral", icon: "dash" };
        return { text: e.steady ? `In the eco band · ${band}` : `In the band · hold it steady`, short: e.steady ? "In eco band" : "Hold steady", tone: "good", icon: "leaf" };
    }

    /**
     * Positions (0–100 %) on the speed scale: band, needle, limit, and (Step 8) the
     * speed advised for the road conditions when it's below the limit.
     * @param {any} s @param {number|null} [advised] m/s
     * @param {number|null} [posted] m/s: the posted limit when the estimator's own limit is the
     *   advised speed (Step 8 clamps the eco band to it); the red line is always the POSTED limit
     * @returns {{ max: number, low: number|null, high: number|null, needle: number, limit: number|null, advised: number|null, ticks: number[] }} max in km/h
     */
    function scaleGeometry(s, advised = null, posted) {
        const kmh = (x) => x * 3.6;
        const lim = posted !== undefined ? posted : s.limit;
        const top = Math.max(60, kmh(s.v) + 15, s.eco ? kmh(s.eco.high) + 25 : 0, lim ? kmh(lim) + 10 : 0, advised ? kmh(advised) + 10 : 0);
        const max = Math.ceil(top / 20) * 20;
        const P = (x) => Math.max(0, Math.min(100, (kmh(x) / max) * 100));
        const ticks = [];
        for (let t = 0; t <= max; t += max > 120 ? 40 : 20) ticks.push(t);
        const adv = advised && advised > 0 && (!lim || advised < lim - 0.1) ? P(advised) : null;
        return { max, low: s.eco ? P(s.eco.low) : null, high: s.eco ? P(s.eco.high) : null, needle: P(s.v), limit: lim ? P(lim) : null, advised: adv, ticks };
    }

    /** Pitstop alert text. @param {any} a  from MUHud.live.pitstopAlert @param {any} U @param {boolean} ev */
    function alertText(a, U, ev) {
        if (!a) return null;
        const km = `${U.num(a.distance / 1000, a.distance < 10000 ? 1 : 0)} km`;
        const what = ev ? "charge" : "fuel";
        if (a.kind === "reserve") return { title: ev ? "Battery on reserve" : "On reserve", sub: a.name ? `Next stop: ${a.name}` : `${what === "fuel" ? "Refuel" : "Charge"} at the next chance`, icon: "alert" };
        if (a.kind === "stop") return { title: `${a.mine ? (ev ? "Charge" : "Fuel") : "Group"} stop in ${km}`, sub: a.mine ? a.name : `${a.name} · you can wait`, icon: ev ? "bolt" : "fuel" };
        return { title: `${ev ? "Charge" : "Refuel"} within ${km}`, sub: "Your range won't reach the destination", icon: ev ? "bolt" : "fuel" };
    }

    // ------------------------------------------------------------------ the view
    /**
     * @param {HTMLElement} root
     * @param {{ units: any, onFocusChange?: (on: boolean) => void, onDismissAlert?: () => void, onQuiet?: (on: boolean) => void }} deps
     */
    function createHud(root, deps) {
        const U = deps.units;
        root.classList.add("hud");
        root.setAttribute("role", "region");
        root.setAttribute("aria-label", "SmartDrive live economy");
        let focused = false, lastState = null, lastExtras = {}, alertNow = null, quiet = false;

        // ---------------- strip ----------------
        const sLiveV = h("span", { class: "hud-big" }), sLiveU = h("span", { class: "hud-unit" }), sLiveN = h("span", { class: "hud-note" });
        const sRing = ring(44, 4.5);
        const sEcoT = h("span", { class: "hud-eco-t" }), sEcoI = h("span", { class: "hud-i", "aria-hidden": "true" });
        const sCostV = h("span", { class: "hud-big" }), sCostN = h("span", { class: "hud-note" });
        const strip = h("button", { type: "button", class: "hud-strip", "aria-label": "Open the riding dashboard", onclick: () => setFocus(true) }, [
            h("span", { class: "hud-cell hud-cell-live" }, [h("span", { class: "hud-row" }, [sLiveV, sLiveU]), sLiveN]),
            h("span", { class: "hud-cell hud-cell-eco" }, [sRing.el, h("span", { class: "hud-eco-txt" }, [h("span", { class: "hud-row hud-eco-row" }, [sEcoI, sEcoT]), h("span", { class: "hud-note", text: "eco score" })])]),
            h("span", { class: "hud-cell hud-cell-cost" }, [h("span", { class: "hud-row" }, [sCostV]), sCostN]),
            h("span", { class: "hud-expand", "aria-hidden": "true", html: ICON.expand })
        ]);
        const alertEl = h("div", { class: "hud-alert", role: "alert", hidden: true });

        // ---------------- focus ----------------
        const fLiveV = h("span", { class: "hudf-hero-v" }), fLiveU = h("span", { class: "hudf-hero-u" }), fLiveN = h("span", { class: "hudf-hero-n" });
        const fChip = h("span", { class: "hudf-chip", hidden: true });
        const scale = h("div", { class: "hudf-scale", role: "img" });
        const fGuide = h("p", { class: "hudf-guide" });
        const fAdv = h("p", { class: "hudf-adv", hidden: true });           // Step 8: road conditions / advised speed
        const tiles = {
            cost: tile("Trip cost"), fuel: tile("Fuel used"), eco: tile("Eco score"), range: tile("Range left")
        };
        const fRing = ring(64, 6);
        const ringWrap = h("span", { class: "hudf-ring-wrap" }, [fRing.el]);
        tiles.eco.v.before(ringWrap); ringWrap.append(tiles.eco.v);
        const fStop = h("section", { class: "hudf-stop", hidden: true, "aria-live": "polite" });
        const quietI = h("span", { class: "hudf-quiet-i", "aria-hidden": "true", html: ICON.bell }), quietT = h("span", { text: "Voice on" });
        const quietBtn = h("button", { type: "button", class: "hudf-quiet", "aria-pressed": "false", title: "Quiet ride: only safety warnings are spoken", onclick: () => { setQuiet(!quiet); if (deps.onQuiet) deps.onQuiet(quiet); } }, [quietI, quietT]);
        const fFoot = h("p", { class: "hudf-foot" });
        const focus = h("div", { class: "hudf", hidden: true, role: "dialog", "aria-modal": "true", "aria-label": "Riding dashboard" }, [
            h("header", { class: "hudf-top" }, [
                h("span", { class: "hudf-brand" }, [h("span", { class: "hudf-dot", "aria-hidden": "true" }), "SmartDrive"]),
                deps.onQuiet ? quietBtn : null,
                h("button", { type: "button", class: "hudf-exit", "aria-label": "Back to the map", html: ICON.x, onclick: () => setFocus(false) })
            ]),
            h("div", { class: "hudf-main" }, [
                h("section", { class: "hudf-hero", "aria-label": "Live economy" }, [
                    h("span", { class: "hudf-label", text: "Live" }),
                    h("span", { class: "hudf-hero-row" }, [fLiveV, fLiveU]),
                    fLiveN, fChip,
                    scale, fGuide, fAdv
                ]),
                h("section", { class: "hudf-tiles", "aria-label": "This trip" }, [tiles.cost.el, tiles.fuel.el, tiles.eco.el, tiles.range.el])
            ]),
            fStop, fFoot
        ]);
        root.replaceChildren(alertEl, strip, focus);

        function tile(label) {
            const v = h("span", { class: "hudf-tile-v" }), s2 = h("span", { class: "hudf-tile-s" });
            return { el: h("div", { class: "hudf-tile" }, [h("span", { class: "hudf-tile-l", text: label }), v, s2]), v, s: s2 };
        }
        function ring(size, stroke) {
            const NS = "http://www.w3.org/2000/svg";
            const r = (size - stroke) / 2, c = 2 * Math.PI * r;
            const svg = document.createElementNS(NS, "svg");
            svg.setAttribute("viewBox", `0 0 ${size} ${size}`); svg.setAttribute("width", String(size)); svg.setAttribute("height", String(size));
            svg.setAttribute("class", "hud-ring"); svg.setAttribute("aria-hidden", "true");
            const bg = document.createElementNS(NS, "circle"), fg = document.createElementNS(NS, "circle"), tx = document.createElementNS(NS, "text");
            for (const el of [bg, fg]) { el.setAttribute("cx", String(size / 2)); el.setAttribute("cy", String(size / 2)); el.setAttribute("r", String(r)); el.setAttribute("fill", "none"); el.setAttribute("stroke-width", String(stroke)); }
            bg.setAttribute("class", "hud-ring-bg"); fg.setAttribute("class", "hud-ring-fg");
            fg.setAttribute("stroke-dasharray", `${c} ${c}`); fg.setAttribute("stroke-dashoffset", String(c));
            fg.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`); fg.setAttribute("stroke-linecap", "round");
            tx.setAttribute("x", String(size / 2)); tx.setAttribute("y", String(size / 2 + size * 0.12)); tx.setAttribute("text-anchor", "middle"); tx.setAttribute("class", "hud-ring-t");
            tx.setAttribute("font-size", String(Math.round(size * 0.34)));
            svg.append(bg, fg, tx);
            return { el: svg, set(score) {
                const s = score === null || !Number.isFinite(score) ? null : Math.max(0, Math.min(1, score));
                fg.setAttribute("stroke-dashoffset", String(s === null ? c : c * (1 - s)));
                tx.textContent = s === null ? "–" : String(Math.round(s * 100));
                svg.setAttribute("data-band", s === null ? "none" : s >= 0.8 ? "high" : s >= 0.6 ? "mid" : "low");
            } };
        }

        function setFocus(on) {
            focused = !!on;
            focus.hidden = !focused;
            strip.hidden = focused;
            root.classList.toggle("is-focus", focused);
            if (deps.onFocusChange) deps.onFocusChange(focused);
            if (focused) { const x = focus.querySelector(".hudf-exit"); if (x) /** @type {HTMLElement} */ (x).focus(); }
            if (lastState) update(lastState, lastExtras);
        }

        /**
         * @param {any} s live state
     * @param {{ priceUnit?: string, priceExample?: boolean, remaining?: number|null, matched?: boolean, advised?: number|null, adviceText?: string, adviceIcon?: string, limitPosted?: number|null }} [x]
     *   advised (m/s) / adviceText: Step 8 road conditions, from "mu:advice"
         */
        function update(s, x = {}) {
            lastState = s; lastExtras = x;
            if (!s) return;
            const ev = s.powertrain === "ev";
            const lf = liveFigure(s, U), g = ecoGuidance(s, U);
            const score = s.trip.ecoScore;
            const cost = s.trip.cost;
            const used = ev ? `${U.num(Math.max(0, s.trip.energy) / 3.6e6, 2)} kWh` : `${U.num(s.trip.energy * 1000, 2)} L`;
            // strip
            sLiveV.textContent = lf.value; sLiveU.textContent = ` ${lf.unit}`; sLiveN.textContent = lf.note;
            strip.dataset.tone = lf.tone;
            sRing.set(score);
            sEcoT.textContent = g.short; sEcoI.innerHTML = ICON[g.icon];
            strip.dataset.eco = g.tone;
            sCostV.textContent = cost === null ? "–" : `₹${U.num(cost, cost < 100 ? 1 : 0)}`;
            sCostN.textContent = used;
            if (!focused) return;
            // focus
            fLiveV.textContent = lf.value; fLiveU.textContent = lf.unit; fLiveN.textContent = lf.note;
            focus.dataset.tone = lf.tone;
            fChip.hidden = !x.matched;
            fChip.textContent = x.matched ? `Matched to your fill-ups · ${s.correction > 1 ? "+" : "−"}${U.num(Math.abs(s.correction - 1) * 100, 0)} %` : "";
            const geo = scaleGeometry(s, x.advised ?? null, x.limitPosted);
            scale.replaceChildren(...[
                h("span", { class: "hudf-scale-track" }),
                geo.low !== null ? h("span", { class: "hudf-scale-band", style: `left:${geo.low}%;width:${Math.max(1.2, geo.high - geo.low)}%` }) : null,
                geo.limit !== null ? h("span", { class: "hudf-scale-limit", style: `left:${geo.limit}%`, title: "Speed limit" }) : null,
                geo.advised !== null ? h("span", { class: "hudf-scale-adv", style: `left:${geo.advised}%`, title: "Advised for the conditions" }) : null,
                h("span", { class: `hudf-needle is-${g.tone}`, style: `left:${geo.needle}%` }, [h("span", { class: "hudf-needle-v", text: `${U.num(s.v * 3.6, 0)}` })]),
                ...geo.ticks.map((t) => h("span", { class: "hudf-tick", style: `left:${(t / geo.max) * 100}%`, text: String(t) }))
            ].filter(Boolean));
            scale.setAttribute("aria-label", `Speed ${U.num(s.v * 3.6, 0)} km/h. ${g.text}.`);
            fGuide.replaceChildren(h("span", { class: `hudf-guide-i is-${g.tone}`, "aria-hidden": "true", html: ICON[g.icon] }), h("span", { text: g.text }));
            fGuide.dataset.tone = g.tone;
            fAdv.hidden = !x.adviceText;
            if (x.adviceText) fAdv.replaceChildren(h("span", { class: "hudf-adv-i", "aria-hidden": "true", html: ICON.drop }), h("span", { text: x.adviceText }));
            tiles.cost.v.textContent = cost === null ? "–" : `₹${U.num(cost, cost < 100 ? 1 : 0)}`;
            tiles.cost.s.textContent = x.priceUnit ? `at ${x.priceUnit}${x.priceExample ? " (example)" : ""}` : "";
            tiles.fuel.v.textContent = used;
            const km = s.trip.distance / 1000;
            tiles.fuel.s.textContent = s.trip.perMetre ? (ev ? `${U.num(s.trip.perMetre / 3.6, 0)} Wh/km average` : `${U.smart(1 / (s.trip.perMetre * 1e6))} km/L average`) : "average after a few metres";
            fRing.set(score);
            tiles.eco.v.textContent = "";
            tiles.eco.s.textContent = score === null ? "after a few metres" : `${s.trip.harsh.accel + s.trip.harsh.brake ? `${s.trip.harsh.accel + s.trip.harsh.brake} harsh ${s.trip.harsh.accel + s.trip.harsh.brake === 1 ? "moment" : "moments"}` : "smooth so far"}`;
            if (s.tank) {
                tiles.range.v.textContent = s.tank.range !== null ? `${U.num(s.tank.range / 1000, 0)} km` : `${U.num(s.tank.share * 100, 0)} %`;
                tiles.range.s.textContent = `${U.num(Math.max(0, s.tank.share) * 100, 0)} % ${ev ? "battery" : "tank"} left${x.remaining ? ` · ${U.num(x.remaining / 1000, 0)} km to go` : ""}`;
            } else { tiles.range.v.textContent = "–"; tiles.range.s.textContent = "set your level in the fuel plan"; }
            fFoot.textContent = `${U.num(km, km < 10 ? 2 : 1)} km · ${Math.round(s.trip.time / 60)} min · top ${U.num(s.trip.maxSpeed * 3.6, 0)} km/h`;
            renderStop();
        }

        function renderStop() {
            const a = alertNow;
            const ev = lastState && lastState.powertrain === "ev";
            const t = alertText(a, U, !!ev);
            fStop.hidden = !t;
            if (!t) { fStop.replaceChildren(); return; }
            fStop.dataset.level = a.level;
            fStop.replaceChildren(h("span", { class: "hudf-stop-i", "aria-hidden": "true", html: ICON[t.icon] }), h("span", { class: "hudf-stop-t" }, [h("strong", { text: t.title }), t.sub ? h("span", { text: t.sub }) : null]));   // h() drops nulls
        }

        /** @param {any} a pitstop alert (MUHud.live.pitstopAlert) or null */
        function setAlert(a) {
            const ev = lastState && lastState.powertrain === "ev";
            alertNow = a;
            const t = alertText(a, U, !!ev);
            alertEl.hidden = !t;
            if (t) {
                alertEl.dataset.level = a.level;
                alertEl.replaceChildren(...[
                    h("span", { class: "hud-alert-i", "aria-hidden": "true", html: ICON[t.icon] }),
                    h("span", { class: "hud-alert-t" }, [h("strong", { text: t.title }), t.sub ? h("span", { text: t.sub }) : null]),
                    a.level !== "critical" ? null : h("button", { type: "button", class: "hud-alert-x", "aria-label": "Dismiss", html: ICON.x, onclick: () => { setAlert(null); if (deps.onDismissAlert) deps.onDismissAlert(); } })
                ].filter(Boolean));
            }
            renderStop();
        }

        /** Reflect quiet ride on the dashboard's toggle. @param {boolean} on */
        function setQuiet(on) {
            quiet = Boolean(on);
            quietBtn.setAttribute("aria-pressed", String(quiet));
            quietI.innerHTML = quiet ? ICON.bellOff : ICON.bell;
            quietT.textContent = quiet ? "Quiet ride" : "Voice on";
        }

        return {
            update, setAlert, setFocus, setQuiet,
            show() { root.hidden = false; },
            hide() { root.hidden = true; setFocus(false); },
            get focused() { return focused; },
            destroy() { root.replaceChildren(); root.classList.remove("hud", "is-focus"); }
        };
    }

    return { liveFigure, ecoGuidance, scaleGeometry, alertText, createHud };
});
