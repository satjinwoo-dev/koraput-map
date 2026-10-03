// @ts-check
/* ============================================================================
   MapUnite trip — the trip-energy card in the route sheet
   ==============================================================================
   MUTrip.card.createTripCard(root, deps) → { setRoute, clear, refreshBike, setCompact, destroy }

   What the rider sees, under the route's distance and ETA:
     - fuel (L) or battery energy (kWh) for THIS route, with its likely range;
     - the cost at the rider's own price (an example price until they set one,
       and it says so);
     - the effective mileage (km/L) or consumption (Wh/km) on this route;
     - the elevation profile, with the climbs the bike can't take at traffic
       speed marked, and how much the hills add;
     - what-ifs: traffic (light / normal / heavy) and load (solo / pillion);
     - "How this is worked out": the breakdown (cruising, hills, stops, idling,
       regeneration) and every assumption that applied.
   No saved bike → a single call to action that opens "My bike".

   Progressive: the estimate appears at once on a flat profile ("checking
   hills…"), and is replaced when the terrain heights arrive. Offline, the flat
   estimate stays, labelled. All text goes in via textContent.

   SI stops at this file's edge: the core works in m³, J, m and m/s; this file
   turns them into L, kWh, km and ₹ through garage/units.js.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUTrip || (/** @type {any} */ (root).MUTrip = {}); ns.card = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const PREFS_KEY = "mu.trip.v1";
    /** Example prices shown (and labelled "example") until the rider enters theirs. Rider units: ₹/L, ₹/kWh. */
    const EXAMPLE_PRICES = Object.freeze({ fuelPerLitre: 100, energyPerKWh: 8 });
    const SVG_NS = "http://www.w3.org/2000/svg";
    const CHART_W = 320, CHART_H = 64, CHART_PAD = 4;

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
    const CHEVRON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
    const FUEL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M3 21h12M7 8h4"/><path d="M14 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V8.5L18 5"/></svg>`;
    const BOLT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>`;

    // ---------------------------------------------------------------- prefs
    /** @param {Storage|null} storage */
    function loadPrefs(storage) {
        /** @type {{ traffic: "light"|"normal"|"heavy", pillion: boolean|null, fuelPerLitre: number|null, energyPerKWh: number|null, expanded: boolean }} */
        const d = { traffic: "normal", pillion: null, fuelPerLitre: null, energyPerKWh: null, expanded: true };
        if (!storage) return d;
        try {
            const p = JSON.parse(storage.getItem(PREFS_KEY) || "{}") || {};
            if (p.traffic === "light" || p.traffic === "normal" || p.traffic === "heavy") d.traffic = p.traffic;
            if (typeof p.pillion === "boolean") d.pillion = p.pillion;
            if (Number.isFinite(p.fuelPerLitre) && p.fuelPerLitre > 0 && p.fuelPerLitre < 10000) d.fuelPerLitre = p.fuelPerLitre;
            if (Number.isFinite(p.energyPerKWh) && p.energyPerKWh > 0 && p.energyPerKWh < 10000) d.energyPerKWh = p.energyPerKWh;
            if (typeof p.expanded === "boolean") d.expanded = p.expanded;
        } catch { /* corrupt: defaults */ }
        return d;
    }
    /** @param {Storage|null} storage @param {any} p */
    function savePrefs(storage, p) { if (storage) { try { storage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* full or blocked */ } } }

    /**
     * Rider-unit price → SI denominators for energy.tripCost (₹/L → ₹/m³, ₹/kWh → ₹/J).
     * @param {{ fuelPerLitre: number|null, energyPerKWh: number|null }} p
     */
    function siPrices(p) {
        const fuel = p.fuelPerLitre ?? EXAMPLE_PRICES.fuelPerLitre, energy = p.energyPerKWh ?? EXAMPLE_PRICES.energyPerKWh;
        return { fuelPerM3: fuel * 1000, energyPerJ: energy / 3.6e6 };
    }

    // ---------------------------------------------------------------- formatting (pure, tested)
    /**
     * Everything the card prints for one estimate, as strings. Pure: no DOM.
     * @param {any} r  TripEnergy (SI)
     * @param {any} cost  Band in ₹, or null
     * @param {any} U  garage units
     * @param {{ fuelPerLitre: number|null, energyPerKWh: number|null }} prefs
     */
    function describe(r, cost, U, prefs) {
        const ev = r.unit === "J";
        const km = r.distance / 1000;
        const q = (x) => (ev ? x / 3.6e6 : x * 1000);                 // m³ → L, J → kWh
        const qd = (x) => (Math.abs(x) < 10 ? 2 : 1);
        const unit = ev ? "kWh" : "L";
        const amount = q(r.total.mean), lo = q(r.total.lo), hi = q(r.total.hi);
        const money = (x) => `₹${U.num(x, x < 100 ? 1 : 0)}`;
        const priceSet = ev ? prefs.energyPerKWh !== null : prefs.fuelPerLitre !== null;
        const price = ev ? (prefs.energyPerKWh ?? EXAMPLE_PRICES.energyPerKWh) : (prefs.fuelPerLitre ?? EXAMPLE_PRICES.fuelPerLitre);
        let rate, rateUnit;
        if (ev) { rate = km > 0 ? r.total.mean / 3.6 / r.distance : NaN; rateUnit = "Wh/km"; }  // J/m ÷ 3.6 = Wh/km
        else { rate = r.total.mean > 0 ? km / (r.total.mean * 1000) : Infinity; rateUnit = "km/L"; }
        const recharge = ev && amount < 0;
        return {
            ev, unit,
            amount: recharge ? `+${U.num(-amount, qd(amount))}` : U.num(amount, qd(amount)),
            amountLabel: recharge ? "kWh back into the battery" : ev ? "kWh from the battery" : "litres of fuel",
            range: `${U.num(lo, qd(lo))}–${U.num(hi, qd(hi))} ${unit} likely`,
            cost: cost ? money(cost.mean) : "–",
            costRange: cost && cost.hi - cost.lo >= 1 ? `${money(cost.lo)}–${money(cost.hi)}` : "",
            priceNote: `at ₹${U.num(price, Number.isInteger(price) ? 0 : Number.isInteger(Math.round(price * 1000) / 100) ? 1 : 2)}/${ev ? "kWh" : "L"}${priceSet ? "" : " (example)"}`,
            priceSet,
            rate: Number.isFinite(rate) ? U.num(rate, ev ? 0 : 1) : "∞",
            rateUnit,
            battery: ev && r.batteryShare ? `${U.num(Math.max(0, r.batteryShare.mean * 100), 0)} % of a full charge` : "",
            needsCharge: !!(ev && r.batteryShare && r.batteryShare.hi > 0.9),
            hills: r.profileSource === "flat" ? "" : `${r.hills >= 0 ? "+" : "−"}${U.num(Math.abs(q(r.hills)), qd(q(r.hills)))} ${unit}`,
            climb: r.profileSource === "flat" ? "" : `↑ ${U.num(r.ascent, 0)} m  ↓ ${U.num(r.descent, 0)} m`,
            summary: `${recharge ? "+" : ""}${U.num(Math.abs(amount), qd(amount))} ${unit} · ${cost ? money(cost.mean) : "–"}`,
            breakdown: [
                [ev ? "Riding (flat-road equivalent)" : "Cruising (flat-road equivalent)", `${U.num(q(r.cruise.mean - r.hills), 2)} ${unit}`],
                ...(r.profileSource === "flat" ? [] : [[`Hills (${r.ascent >= 1 ? `↑ ${U.num(r.ascent, 0)} m` : "flat"})`, `${r.hills >= 0 ? "+" : "−"}${U.num(Math.abs(q(r.hills)), 2)} ${unit}`]]),
                [`Stops (about ${U.num(r.stopCount, 0)})`, `+${U.num(q(r.stops), 2)} ${unit}`],
                [`${ev ? "Standing still" : "Idling"} (about ${U.num(r.idleTime / 60, 0)} min)`, `+${U.num(q(r.idle), 2)} ${unit}`],
                ...(ev && r.regen > 0 ? [["Recovered on the way (regeneration)", `${U.num(r.regen / 3600, 0)} Wh`]] : [])
            ]
        };
    }

    /** One line per assumption that applied. @param {any} r @param {any} U @param {{ estimated: boolean, classTitle: string }} bike */
    function flagLines(r, U, bike) {
        const km = (m) => `${U.num(m / 1000, m < 10000 ? 1 : 0)} km`;
        /** @type {Array<{ tone: "warn"|"info", text: string }>} */ const out = [];
        if (bike.estimated) out.push({ tone: "warn", text: `Your bike is set as a typical ${bike.classTitle.toLowerCase()}, so these are estimates.` });
        for (const f of r.flags) {
            if (f === "hills-unknown") out.push({ tone: "warn", text: "Hills not included: the elevation data couldn't be loaded (offline?). Costed as flat." });
            else if (f === "hills-partial") out.push({ tone: "info", text: "Some elevation data was missing; the gaps were filled in." });
            else if (f === "slowed") out.push({ tone: "warn", text: `On ${km(r.slowedDistance)} of climbs your bike can't hold the traffic's speed; costed at the speed it can hold.` });
            else if (f === "too-steep") out.push({ tone: "warn", text: `${km(r.steepDistance)} looks steeper than your bike can climb loaded like this.` });
            else if (f === "top-speed") out.push({ tone: "info", text: `Traffic on ${km(r.cappedDistance)} moves faster than your bike's top speed; costed at its top speed.` });
            else if (f === "speed-assumed") out.push({ tone: "info", text: "The route came without timings; 40 km/h assumed." });
        }
        out.push({ tone: "info", text: "Stops and idling are estimated from the traffic setting (±50 %). The range also covers the uncertainty in your bike's data." });
        if (r.unit === "J") out.push({ tone: "info", text: "Cost counts about 12 % charging loss from the wall to the battery." });
        return out;
    }

    // ---------------------------------------------------------------- elevation chart
    /**
     * SVG paths for the elevation chart (pure): area, line, and the slowed stretches.
     * @param {Float64Array} sArr @param {Float64Array} z @param {Uint8Array|null} slowed  per segment
     */
    function chartPaths(sArr, z, slowed, W = CHART_W, H = CHART_H, pad = CHART_PAD) {
        const n = sArr.length;
        if (n < 2) return { area: "", line: "", warn: "", zLo: 0, zHi: 0 };
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < n; i++) { if (z[i] < lo) lo = z[i]; if (z[i] > hi) hi = z[i]; }
        const span = Math.max(30, hi - lo);                         // a 30 m minimum: flat stays flat, not magnified noise
        const zLo = lo - (span - (hi - lo)) * 0.25, zHi = zLo + span;
        const L = sArr[n - 1] || 1;
        const step = Math.max(1, Math.floor(n / 240));
        const X = (i) => ((sArr[i] / L) * W).toFixed(1);
        const Y = (i) => (pad + (1 - (z[i] - zLo) / span) * (H - 2 * pad)).toFixed(1);
        let line = "";
        for (let i = 0; i < n; i += step) line += `${line ? "L" : "M"}${X(i)} ${Y(i)}`;
        if ((n - 1) % step) line += `L${X(n - 1)} ${Y(n - 1)}`;
        const area = `${line}L${W} ${H}L0 ${H}Z`;
        let warn = "";
        if (slowed) {
            let open = false;
            for (let i = 0; i < n - 1; i++) {
                if (slowed[i]) { warn += open ? `L${X(i + 1)} ${Y(i + 1)}` : `M${X(i)} ${Y(i)}L${X(i + 1)} ${Y(i + 1)}`; open = true; }
                else open = false;
            }
        }
        return { area, line, warn, zLo, zHi };
    }

    // ---------------------------------------------------------------- the card
    /**
     * @param {HTMLElement} root
     * @param {{
     *   physics: any, profile: any, energy: any, units: any, silhouettes?: any,
     *   elevation?: { lookup: (lat: ArrayLike<number>, lng: ArrayLike<number>) => Promise<{ z: Float64Array, source: string }> } | null,
     *   structures?: { along: (rs: any) => Promise<{ spans: any[], source: string }> } | null,
     *   loadBike: () => Promise<null | { name: string, variant?: string, estimated: boolean, classKey: string, classTitle: string, image_url?: string|null, bundle: any, classDefault?: any, settings: any }>,
     *   onOpenGarage?: () => void, storage?: Storage|null, schedule?: (fn: () => void) => void
     * }} deps
     */
    function createTripCard(root, deps) {
        const U = deps.units;
        const storage = deps.storage !== undefined ? deps.storage : (() => { try { return globalThis.localStorage; } catch { return null; } })();
        const schedule = deps.schedule || ((fn) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => setTimeout(fn, 0)) : setTimeout(fn, 0)));
        const prefs = loadPrefs(storage);
        const uid = `tc${Math.random().toString(36).slice(2, 8)}`;
        let token = 0, compact = false, compactOpen = false;
        /** @type {any} */ let route = null, bike = null, bikePromise = null, geo = null, lastResult = null;
        /** @type {Map<string, any>} */ const estimators = new Map();
        /** Pillion on? The rider's what-if choice, else whether their garage settings include one. */
        const pillionNow = () => (prefs.pillion !== null ? prefs.pillion : !!(bike && bike.settings && bike.settings.pillionMass));

        root.classList.add("trip-card");
        root.setAttribute("aria-label", "Fuel and cost for this trip");
        root.hidden = true;

        // ---- static skeleton (built once; updates only touch text and paths) ----
        const thumb = h("span", { class: "trip-thumb", "aria-hidden": "true" });
        const kicker = h("span", { class: "trip-kicker", text: "Trip energy" });
        const bikeName = h("span", { class: "trip-bike" });
        const summary = h("span", { class: "trip-summary", "aria-hidden": "true" });
        const chev = h("span", { class: "trip-chev", "aria-hidden": "true", html: CHEVRON });
        const head = h("button", { type: "button", class: "trip-head", "aria-expanded": "true", "aria-controls": `${uid}-body` }, [
            thumb, h("span", { class: "trip-head-main" }, [kicker, bikeName]), summary, chev
        ]);
        const status = h("p", { class: "trip-status", role: "status", "aria-live": "polite" });

        const figAmount = h("span", { class: "trip-fig-v" }), figAmountU = h("span", { class: "trip-fig-u" }), figAmountS = h("span", { class: "trip-fig-s" });
        const figCost = h("span", { class: "trip-fig-v" }), figCostS = h("button", { type: "button", class: "trip-fig-s trip-price-btn", "aria-controls": `${uid}-price` });
        const figRate = h("span", { class: "trip-fig-v" }), figRateU = h("span", { class: "trip-fig-u" }), figRateS = h("span", { class: "trip-fig-s" });
        const figIcon = h("span", { class: "trip-fig-icon", "aria-hidden": "true" });
        const figures = h("div", { class: "trip-figures" }, [
            h("div", { class: "trip-fig trip-fig-main" }, [h("span", { class: "trip-fig-row" }, [figIcon, figAmount, figAmountU]), figAmountS]),
            h("div", { class: "trip-fig" }, [h("span", { class: "trip-fig-row" }, [figCost]), figCostS]),
            h("div", { class: "trip-fig" }, [h("span", { class: "trip-fig-row" }, [figRate, figRateU]), figRateS])
        ]);

        // price editor
        const priceInput = h("input", { id: `${uid}-price-in`, class: "trip-price-input", type: "text", inputmode: "decimal", autocomplete: "off", maxlength: "8" });
        const priceUnit = h("span", { class: "trip-price-unit" });
        const priceErr = h("p", { class: "trip-price-err", role: "alert", hidden: true });
        const priceBox = h("form", { id: `${uid}-price`, class: "trip-price", hidden: true, novalidate: true }, [
            h("label", { for: `${uid}-price-in`, class: "trip-price-label", text: "Your price" }),
            h("span", { class: "trip-price-field" }, [h("span", { class: "trip-price-cur", "aria-hidden": "true", text: "₹" }), priceInput, priceUnit]),
            h("button", { type: "submit", class: "trip-btn", text: "Save" }),
            h("button", { type: "button", class: "trip-btn-ghost", text: "Cancel", onclick: () => togglePrice(false) }),
            priceErr
        ]);

        // elevation chart
        const svg = s("svg", { class: "trip-elev-svg", viewBox: `0 0 ${CHART_W} ${CHART_H}`, preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" });
        const gradId = `${uid}-g`;
        const defs = s("defs"), grad = s("linearGradient", { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 });
        grad.append(s("stop", { offset: "0", "stop-color": "#34e0b4", "stop-opacity": "0.32" }), s("stop", { offset: "1", "stop-color": "#34e0b4", "stop-opacity": "0.02" }));
        defs.append(grad);
        const pArea = s("path", { class: "trip-elev-area", fill: `url(#${gradId})` });
        const pLine = s("path", { class: "trip-elev-line", fill: "none", "vector-effect": "non-scaling-stroke" });
        const pWarn = s("path", { class: "trip-elev-warn", fill: "none", "vector-effect": "non-scaling-stroke" });
        const pCursor = s("line", { class: "trip-elev-cursor", x1: 0, x2: 0, y1: 0, y2: CHART_H, "vector-effect": "non-scaling-stroke", visibility: "hidden" });
        svg.append(defs, s("line", { class: "trip-elev-base", x1: 0, x2: CHART_W, y1: CHART_H - 0.5, y2: CHART_H - 0.5, "vector-effect": "non-scaling-stroke" }), pArea, pLine, pWarn, pCursor);
        const elevHi = h("span", { class: "trip-elev-tick trip-elev-hi" }), elevLo = h("span", { class: "trip-elev-tick trip-elev-lo" });
        const elevRead = h("span", { class: "trip-elev-read", "aria-hidden": "true" });
        const elevPlot = h("div", { class: "trip-elev-plot", tabindex: "0", role: "img" }, [svg, elevHi, elevLo, elevRead]);
        const elevCap = h("figcaption", { class: "trip-elev-cap" });
        const elev = h("figure", { class: "trip-elev" }, [elevPlot, elevCap]);

        // what-if controls
        const seg = (label, items, current, onPick) => {
            const g = h("div", { class: "trip-seg", role: "radiogroup", "aria-label": label });
            for (const [id, text] of items) {
                g.append(h("button", { type: "button", role: "radio", class: "trip-seg-btn", "data-v": id, "aria-checked": String(id === current()), text, onclick: () => { onPick(id); for (const b of g.children) b.setAttribute("aria-checked", String(b.getAttribute("data-v") === current())); } }));
            }
            return g;
        };
        const trafficSeg = seg("Traffic", [["light", "Light"], ["normal", "Normal"], ["heavy", "Heavy"]], () => prefs.traffic, (v) => { prefs.traffic = v; savePrefs(storage, prefs); recompute(); });
        const loadSeg = seg("Load", [["solo", "Solo"], ["pillion", "Pillion"]], () => (pillionNow() ? "pillion" : "solo"), (v) => { prefs.pillion = v === "pillion"; savePrefs(storage, prefs); recompute(); });
        const controls = h("div", { class: "trip-controls" }, [
            h("span", { class: "trip-ctl" }, [h("span", { class: "trip-ctl-l", text: "Traffic" }), trafficSeg]),
            h("span", { class: "trip-ctl" }, [h("span", { class: "trip-ctl-l", text: "Load" }), loadSeg])
        ]);

        const moreList = h("dl", { class: "trip-break" });
        const flagList = h("ul", { class: "trip-flags" });
        const changeBike = h("button", { type: "button", class: "trip-link", text: "Change bike or settings", onclick: () => deps.onOpenGarage && deps.onOpenGarage() });
        const more = h("details", { class: "trip-more" }, [h("summary", { text: "How this is worked out" }), moreList, flagList, changeBike]);
        const warnBar = h("p", { class: "trip-warnbar", hidden: true });

        const readyView = h("div", { class: "trip-ready" }, [figures, priceBox, warnBar, elev, controls, more]);
        const emptyView = h("div", { class: "trip-empty", hidden: true }, [
            h("p", { class: "trip-empty-t", text: "See the fuel and cost of this trip" }),
            h("p", { class: "trip-empty-s", text: "Choose your bike once: the estimate then uses its engine, gearing and weight, this route's hills and the traffic." }),
            h("button", { type: "button", class: "trip-btn", text: "Choose my bike", onclick: () => deps.onOpenGarage && deps.onOpenGarage() })
        ]);
        const errorView = h("div", { class: "trip-empty", hidden: true });
        const body = h("div", { class: "trip-body", id: `${uid}-body` }, [status, readyView, emptyView, errorView]);
        root.replaceChildren(head, body);

        head.addEventListener("click", () => {
            if (compact) compactOpen = !compactOpen;           // while driving: a peek, not a saved preference
            else { prefs.expanded = !prefs.expanded; savePrefs(storage, prefs); }
            syncExpanded();
        });
        figCostS.addEventListener("click", () => togglePrice(priceBox.hidden));
        priceBox.addEventListener("submit", (e) => {
            e.preventDefault();
            const t = priceInput.value.trim().replace(",", ".");
            const ev = !!(lastResult && lastResult.unit === "J");
            if (t === "") { if (ev) prefs.energyPerKWh = null; else prefs.fuelPerLitre = null; }
            else {
                const n = Number(t);
                const max = ev ? 200 : 1000;
                if (!Number.isFinite(n) || n <= 0 || n > max) { priceErr.hidden = false; priceErr.textContent = `Enter a price between 0 and ${max} ₹ per ${ev ? "kWh" : "litre"}, or leave it empty for the example.`; return; }
                if (ev) prefs.energyPerKWh = n; else prefs.fuelPerLitre = n;
            }
            savePrefs(storage, prefs);
            togglePrice(false);
            if (lastResult) paint(lastResult);
        });
        function togglePrice(open) {
            const ev = !!(lastResult && lastResult.unit === "J");
            priceBox.hidden = !open;
            figCostS.setAttribute("aria-expanded", String(open));
            priceErr.hidden = true;
            if (open) {
                const cur = ev ? prefs.energyPerKWh : prefs.fuelPerLitre;
                priceInput.value = cur === null ? "" : String(cur);
                priceInput.placeholder = String(ev ? EXAMPLE_PRICES.energyPerKWh : EXAMPLE_PRICES.fuelPerLitre);
                priceUnit.textContent = ev ? "per kWh" : "per litre";
                priceInput.focus();
            }
        }
        function syncExpanded() {
            const open = compact ? compactOpen : prefs.expanded;
            head.setAttribute("aria-expanded", String(open));
            body.hidden = !open;
            root.classList.toggle("is-collapsed", !open);
        }

        // elevation readout (pointer + keyboard)
        let cursorIdx = -1;
        function readout(i) {
            const r = lastResult, p = geo && geo.profile;
            if (!r || !p || i < 0 || i >= p.s.length) { pCursor.setAttribute("visibility", "hidden"); elevRead.textContent = ""; cursorIdx = -1; return; }
            cursorIdx = i;
            const x = (p.s[i] / p.distance) * CHART_W;
            pCursor.setAttribute("x1", x.toFixed(1)); pCursor.setAttribute("x2", x.toFixed(1)); pCursor.setAttribute("visibility", "visible");
            const g = p.grade[Math.min(i, p.grade.length - 1)] || 0;
            elevRead.textContent = `${U.num(p.s[i] / 1000, 1)} km · ${U.num(p.z[i], 0)} m · ${g >= 0 ? "+" : "−"}${U.num(Math.abs(g * 100), 0)} %`;
            elevRead.style.left = `${Math.min(70, Math.max(0, (p.s[i] / p.distance) * 100 - 15))}%`;
        }
        const idxAt = (clientX) => {
            const p = geo && geo.profile; if (!p) return -1;
            const box = elevPlot.getBoundingClientRect();
            const t = Math.min(1, Math.max(0, (clientX - box.left) / (box.width || 1)));
            let lo = 0, hi = p.s.length - 1;
            const target = t * p.distance;
            while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p.s[mid] < target) lo = mid; else hi = mid; }
            return target - p.s[lo] < p.s[hi] - target ? lo : hi;
        };
        elevPlot.addEventListener("pointermove", (e) => readout(idxAt(e.clientX)));
        elevPlot.addEventListener("pointerdown", (e) => readout(idxAt(e.clientX)));
        elevPlot.addEventListener("pointerleave", () => readout(-1));
        elevPlot.addEventListener("blur", () => readout(-1));
        elevPlot.addEventListener("keydown", (e) => {
            const p = geo && geo.profile; if (!p) return;
            const step = Math.max(1, Math.round(p.s.length / 40));
            if (e.key === "ArrowRight") readout(Math.min(p.s.length - 1, (cursorIdx < 0 ? -1 : cursorIdx) + step));
            else if (e.key === "ArrowLeft") readout(Math.max(0, (cursorIdx < 0 ? p.s.length : cursorIdx) - step));
            else if (e.key === "Home") readout(0);
            else if (e.key === "End") readout(p.s.length - 1);
            else if (e.key === "Escape") readout(-1);
            else return;
            e.preventDefault();
        });

        // ---- state views ----
        function view(which) {
            readyView.hidden = which !== "ready";
            emptyView.hidden = which !== "empty";
            errorView.hidden = which !== "error";
            root.dataset.state = which;
        }
        function paintBikeHead() {
            thumb.replaceChildren();
            if (!bike) { bikeName.textContent = "No bike chosen"; thumb.innerHTML = deps.silhouettes ? deps.silhouettes.silhouette("ice_manual.commuter") : ""; return; }
            bikeName.textContent = bike.estimated ? `Typical ${bike.classTitle.toLowerCase()}` : bike.name;
            if (deps.silhouettes) thumb.innerHTML = deps.silhouettes.silhouette(bike.classKey);
            if (bike.image_url) {
                const img = h("img", { src: bike.image_url, alt: "", decoding: "async", referrerpolicy: "no-referrer" });
                img.addEventListener("load", () => thumb.classList.add("has-photo"));
                img.addEventListener("error", () => img.remove());
                thumb.append(img);
            }
        }

        async function ensureBike() {
            if (bike) return bike;
            if (!bikePromise) bikePromise = deps.loadBike().then((b) => { bike = b; estimators.clear(); return b; }, (e) => { bikePromise = null; throw e; });
            return bikePromise;
        }

        /** The estimator for the current bike, load, altitude and speed ceiling (cached). */
        function estimatorFor(zMean, vMax) {
            const pill = pillionNow();
            const key = `${pill ? 1 : 0}|${Math.round(zMean / 100)}|${Math.ceil(vMax)}`;
            let est = estimators.get(key);
            if (!est) {
                const st = { ...(bike.settings || {}) };
                if (pill) { if (!st.pillionMass) st.pillionMass = (bike.bundle.priors && bike.bundle.priors.riderMass && bike.bundle.priors.riderMass.mean) || 72; }
                else delete st.pillionMass;
                const model = deps.physics.createBikeModel(bike.bundle, { classDefault: bike.classDefault, settings: st });
                est = deps.energy.createTripEstimator(deps.physics, model, { altitude: Math.round(zMean / 100) * 100, vMax });
                if (estimators.size > 8) estimators.clear();
                estimators.set(key, est);
            }
            return est;
        }

        /** Geometry for the route: samples, a flat profile, and speeds. */
        function prepare(rt) {
            const P = deps.profile;
            const spacing = P.plan(rt.distanceM);
            const rs = P.resample(rt.path, spacing);
            const profile = P.buildProfile(rs.s, null, { distance: rt.distanceM || rs.length });
            const speeds = P.segmentSpeeds(profile.edges, rt.steps, { distance: profile.distance, duration: rt.durationSec });
            return { rs, profile, speeds, terrain: "pending" };
        }

        function recompute() {
            if (!route || !bike || !geo) return;
            let r;
            try {
                let vMax = 0;
                for (let i = 0; i < geo.speeds.speed.length; i++) if (geo.speeds.speed[i] > vMax) vMax = geo.speeds.speed[i];
                r = estimatorFor(geo.profile.zMean, vMax || 15).estimate(geo.profile, geo.speeds, { traffic: prefs.traffic, routeDuration: route.durationSec });
            } catch (e) {
                showError(`The physics couldn't run for this bike: ${/** @type {Error} */ (e).message}`);
                return;
            }
            lastResult = r;
            paint(r);
        }

        function paint(r) {
            const d = describe(r, deps.energy.tripCost(r, siPrices(prefs)), U, prefs);
            view("ready");
            root.dataset.kind = d.ev ? "ev" : "fuel";
            figIcon.innerHTML = d.ev ? BOLT_ICON : FUEL_ICON;
            figAmount.textContent = d.amount;
            figAmountU.textContent = ` ${d.unit}`;
            figAmountS.textContent = d.ev && d.battery ? d.battery : d.range;
            figAmount.parentElement && figAmount.parentElement.setAttribute("aria-label", `${d.amount} ${d.amountLabel}`);
            figCost.textContent = d.cost;
            figCostS.textContent = `${d.priceNote.replace(" (example)", "")}\n${d.priceSet ? "your price" : "example"}`;
            figCostS.classList.toggle("is-example", !d.priceSet);
            figCostS.setAttribute("aria-label", `${d.priceNote}. Change the price`);
            figRate.textContent = d.rate;
            figRateU.textContent = ` ${d.rateUnit}`;
            figRateS.textContent = d.ev ? d.range : "on this route";
            summary.textContent = d.summary;
            warnBar.hidden = !d.needsCharge;
            warnBar.textContent = d.needsCharge ? "This trip may need most of a full charge or more. Plan a charging stop." : "";

            // chart
            const p = geo.profile;
            const terrainKnown = p.source !== "flat";
            elev.hidden = false;
            elev.classList.toggle("is-flat", !terrainKnown);
            const paths = chartPaths(p.s, p.z, terrainKnown ? r.slowed : null);
            pArea.setAttribute("d", terrainKnown ? paths.area : "");
            pLine.setAttribute("d", paths.line);
            pWarn.setAttribute("d", paths.warn);
            elevHi.textContent = terrainKnown ? `${U.num(p.zMax, 0)} m` : "";
            elevLo.textContent = terrainKnown ? `${U.num(p.zMin, 0)} m` : "";
            elevPlot.setAttribute("aria-label", terrainKnown
                ? `Elevation along the route, ${U.num(p.zMin, 0)} to ${U.num(p.zMax, 0)} metres. Use the arrow keys to read it.`
                : "Elevation not available");
            elevCap.replaceChildren();
            if (geo.terrain === "pending") elevCap.append(h("span", { class: "trip-pending", text: "Checking the hills…" }));
            else if (!terrainKnown) elevCap.append(h("span", { class: "trip-cap-warn", text: "Hills not included (no elevation data)" }));
            else {
                elevCap.append(h("span", { text: d.climb }));
                if (d.hills) elevCap.append(h("span", { class: "trip-cap-hills", text: `hills ${d.hills}` }));
                if (r.slowedDistance > 0 || r.steepDistance > 0) elevCap.append(h("span", { class: "trip-cap-warn", text: "slow climb" }));
            }

            // controls
            for (const b of loadSeg.children) b.setAttribute("aria-checked", String((b.getAttribute("data-v") === "pillion") === pillionNow()));
            for (const b of trafficSeg.children) b.setAttribute("aria-checked", String(b.getAttribute("data-v") === prefs.traffic));

            // breakdown + flags
            moreList.replaceChildren(...d.breakdown.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })]));
            flagList.replaceChildren(...flagLines(r, U, { estimated: !!bike.estimated, classTitle: bike.classTitle || "bike" })
                .map((f) => h("li", { class: `trip-flag is-${f.tone}`, text: f.text })));
            status.textContent = "";
            if (cursorIdx >= 0) readout(cursorIdx);
        }

        function showError(msg) {
            view("error");
            errorView.replaceChildren(
                h("p", { class: "trip-empty-s", text: msg }),
                h("button", { type: "button", class: "trip-btn-ghost", text: "Try again", onclick: () => { bikePromise = null; bike = null; if (route) setRoute(route); } })
            );
            summary.textContent = "";
        }

        /**
         * @param {{ path: Array<[number, number]>|number[][], distanceM: number, durationSec?: number, steps?: Array<{ distance?: number, duration?: number }>, reason?: string }} rt
         */
        async function setRoute(rt) {
            const my = ++token;
            route = rt;
            root.hidden = false;
            syncExpanded();
            if (!rt || !rt.path || rt.path.length < 2 || !(rt.distanceM > 0)) { root.hidden = true; return; }
            try { await ensureBike(); } catch (e) {
                if (my !== token) return;
                paintBikeHead();
                showError(/** @type {Error} */ (e).message || "Your bike's data couldn't be loaded.");
                return;
            }
            if (my !== token) return;
            paintBikeHead();
            if (!bike) { view("empty"); summary.textContent = "Choose your bike"; lastResult = null; return; }
            if (rt.reason !== "reroute" || !lastResult) status.textContent = "Working out fuel for this route…";
            // 1. immediately: flat profile (after a paint, so the sheet appears without waiting)
            schedule(() => {
                if (my !== token) return;
                geo = prepare(rt);
                recompute();
                // 2. terrain heights, then the real profile
                if (!deps.elevation) { geo.terrain = "none"; recompute(); return; }
                const g = geo;
                // bridges and tunnels from OpenStreetMap, if they come within 8 s (else the heights alone find them)
                const known = deps.structures
                    ? Promise.race([deps.structures.along(g.rs).catch(() => null), new Promise((r) => setTimeout(() => r(null), 8000))])
                    : Promise.resolve(null);
                Promise.all([deps.elevation.lookup(g.rs.lat, g.rs.lng), known]).then(([res, st]) => {
                    if (my !== token || geo !== g) return;
                    g.profile = deps.profile.buildProfile(g.rs.s, res.z, { distance: rt.distanceM || g.rs.length, structures: st ? /** @type {any} */ (st).spans : null });
                    g.speeds = deps.profile.segmentSpeeds(g.profile.edges, rt.steps, { distance: g.profile.distance, duration: rt.durationSec });
                    g.terrain = res.source;
                    recompute();
                }, () => { if (my === token && geo === g) { g.terrain = "none"; recompute(); } });
            });
        }

        function clear() { token++; route = null; geo = null; lastResult = null; root.hidden = true; togglePrice(false); }
        /** Bike or settings changed (garage closed, another tab): reload it and recompute. */
        function refreshBike() { bike = null; bikePromise = null; estimators.clear(); if (route) setRoute({ ...route, reason: "bike" }); }
        /** Compact (one line) while driving. @param {boolean} on */
        function setCompact(on) { compact = !!on; compactOpen = false; root.classList.toggle("is-compact", compact); syncExpanded(); }

        syncExpanded();
        return {
            setRoute, clear, refreshBike, setCompact,
            get result() { return lastResult; },
            get profile() { return geo ? geo.profile : null; },
            destroy() { token++; root.replaceChildren(); root.classList.remove("trip-card"); }
        };
    }

    return { PREFS_KEY, EXAMPLE_PRICES, loadPrefs, savePrefs, siPrices, describe, flagLines, chartPaths, createTripCard };
});
