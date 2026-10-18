/* ============================================================================
   MapUnite Ride Plan — the whole route, before the ride
   ==============================================================================
   With a destination on screen (before Start), "Ride plan" in the bottom sheet
   opens the plan: the rider picks the day and time they'll leave, and the
   app asks the router for up to three routes and the server
   (/api/master/ride-plan, lib/master/rideplan.js) for everything along them:
     - which is FASTEST and which is BEST, and exactly why;
     - the weather on the ride day at about the time the rider reaches each
       stretch (Open-Meteo; up to 16 days ahead, "less certain" after 3);
     - a stop plan: breakfast / lunch / dinner where the ride crosses meal
       time and a break about every 2 h, each with well-reviewed places
       (Google ratings and reviews, vetted for red flags and fake-review
       tells) or, without reviews, the nearest OpenStreetMap places;
     - hospitals, mechanics and tyre shops, fuel, hotels, dhabas and tea,
       police and toilets: how many, where (km), and the longest stretch
       WITHOUT fuel / a hospital / a mechanic;
     - the road: speed breakers, level crossings, unpaved or bad km, mapped
       hazards, and the climb from the 30 m terrain model where it covers;
     - official accident blackspots, only from lists loaded on the server.
       Without one the plan says so; it never invents accident numbers.
   "Use this route" puts the chosen route on the map (the same preview, then
   Start). Nothing about the rider is stored: the plan asks with the route
   lines and the departure time only.
   RidePlanCore (pure, tested): thin(), labelFor(), fmtKm(), timeline(), localInput().
   ============================================================================ */
"use strict";

const RidePlanCore = (() => {
    /** At most `max` points, evenly picked, ends kept. @param {number[][]} line @param {number} max */
    function thin(line, max) {
        if (!Array.isArray(line) || line.length <= max) return line || [];
        const out = [], step = (line.length - 1) / (max - 1);
        for (let i = 0; i < max; i++) out.push(line[Math.round(i * step)]);
        return out;
    }
    const labelFor = (/** @type {number} */ i) => `Route ${"ABC"[i] || i + 1}`;
    /** "12 km", "1.4 km", "800 m". @param {number} m */
    function fmtKm(m) {
        if (!Number.isFinite(m)) return "–";
        if (m < 1000) return `${Math.round(m / 50) * 50} m`;
        return `${m < 10000 ? (Math.round(m / 100) / 10).toFixed(1) : Math.round(m / 1000)} km`;
    }
    /**
     * The stops in riding order: meals and breaks merged, by km. Pure.
     * @param {any} picks the server's picks @returns {Array<{ type: string, label: string, sM: number, at: number, options: any[], reviews: boolean, fuelNearby?: any[], toiletsNearby?: number }>}
     */
    function timeline(picks) {
        if (!picks) return [];
        const meal = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" };
        const rows = [
            ...(picks.meals || []).map((m) => ({ type: "meal", label: /** @type {any} */ (meal)[m.meal] || "Meal", sM: m.sM, at: m.at, options: m.options || [], reviews: Boolean(m.reviews) })),
            ...(picks.restStops || []).map((r) => ({ type: "rest", label: `Break after ${Math.round(r.afterS / 3600)} h`, sM: r.sM, at: r.at, options: r.options || [], reviews: Boolean(r.reviews), fuelNearby: r.fuelNearby || [], toiletsNearby: r.toiletsNearby || 0 }))
        ];
        return rows.sort((a, b) => a.sM - b.sM);
    }
    /** A <input type="datetime-local"> value for a time (the phone's local time). @param {number} ms */
    function localInput(ms) {
        const d = new Date(ms), p = (/** @type {number} */ n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    return { thin, labelFor, fmtKm, timeline, localInput };
})();

const RidePlan = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document) return { core: RidePlanCore };
    const C = RidePlanCore;
    let dest = null, route = null;           // the destination and the route on screen (mu:destination, mu:route)
    let modal = null;

    // ------------------------------------------------------------ helpers
    const h = (tag, a = {}, kids = []) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(a)) {
            if (v == null || v === false) continue;
            if (k === "class") el.className = v; else if (k === "text") el.textContent = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c != null && c !== false) el.append(c);
        return el;
    };
    const time = (ms) => new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
    const day = (ms) => new Date(ms).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
    const dur = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`; };
    const api = () => `${W.MU_SERVER_ORIGIN || W.location.origin}/api/master/ride-plan`;
    const osrm = () => { try { return typeof OSRM_BASE !== "undefined" ? OSRM_BASE : "https://router.project-osrm.org"; } catch (e) { return "https://router.project-osrm.org"; } };
    const HAZ = { storm: "Thunderstorm", "heavy-rain": "Heavy rain", rain: "Rain", drizzle: "Drizzle", freezing: "Ice / snow", fog: "Fog", wind: "Strong wind", heat: "Heat", cold: "Cold", dust: "Dust", dry: "Very dry", "rain-soon": "Rain likely" };

    /** Up to three routes from the router (the rider's road preferences applied, as for navigation). */
    async function alternatives(from, to) {
        const url = `${osrm()}/route/v1/driving/${from[1]},${from[0]};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true&alternatives=3`;
        let j = null;
        try { j = typeof RoutePrefs !== "undefined" && RoutePrefs.fetchRoute ? await RoutePrefs.fetchRoute(url) : await (await fetch(url)).json(); } catch (e) { j = null; }
        return j && Array.isArray(j.routes) ? j.routes.slice(0, 3) : [];
    }

    // ------------------------------------------------------------ the plan
    async function analyse(body, out, leaveIn, focus) {
        const departAt = leaveIn.value ? new Date(leaveIn.value).getTime() : Date.now();
        out.replaceChildren(h("p", { class: "rp-wait", role: "status", text: "Reading the routes: places, reviews, ride-day weather, road and terrain… (up to a minute on a long route)" }));
        const from = route && route.path && route.path.length ? route.path[0] : (typeof myCoords !== "undefined" && myCoords ? [myCoords.lat, myCoords.lng] : null);
        if (!from || !dest) { out.replaceChildren(h("p", { class: "rp-err", text: "Pick a destination first." })); return; }
        if (!body.osrm) body.osrm = await alternatives(from, dest);
        const raw = body.osrm.length ? body.osrm : route ? [{ geometry: { coordinates: route.path.map(([a, b]) => [b, a]) }, distance: route.distanceM, duration: route.durationSec }] : [];
        if (!raw.length) { out.replaceChildren(h("p", { class: "rp-err", text: "No route found. Check your connection and try again." })); return; }
        const routes = raw.map((r, i) => ({ id: String(i), line: C.thin(r.geometry.coordinates.map(([lng, lat]) => [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]), 3000), distanceM: r.distance, durationS: r.duration }));
        let res = null;
        try {
            const r = await fetch(api(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ routes, departAt, focus, tzOffsetMin: -new Date(departAt).getTimezoneOffset() }) });
            res = await r.json();
        } catch (e) { res = null; }
        if (!res || !res.ok) { out.replaceChildren(h("p", { class: "rp-err", text: res && res.reason === "bad-length" ? "This route is too long for a plan (over 1500 km)." : "Couldn't make the plan right now (the server or a data source didn't answer). Try again in a minute." })); return; }
        render(body, out, leaveIn, res, raw);
    }

    function section(title, kids, open = false) {
        return h("details", { class: "rp-sec", open }, [h("summary", { text: title }), ...kids]);
    }
    const placeRow = (p) => h("div", { class: "rp-place" }, [
        h("div", { class: "rp-pn" }, [
            h("b", { text: p.name || ({ dhaba: "Dhaba", tea: "Tea stall", fuel: "Fuel pump", toilets: "Public toilets", police: "Police" })[p.kind] || "Unnamed place" }),
            h("span", { class: "rp-pm", text: [`km ${Math.round(p.sM / 1000)}`, p.offM > 150 ? `${C.fmtKm(p.offM)} off the road` : "on the road", p.brand].filter(Boolean).join(" · ") })
        ]),
        p.rating ? h("span", { class: `rp-rate${p.tier === "vetted" ? " ok" : ""}`, title: p.tier === "vetted" ? "Well reviewed: enough reviews, no red flags found" : "Rated, fewer reviews or some red flags", text: `★ ${p.rating.toFixed(1)} (${p.reviewsCount})` }) : h("span", { class: "rp-rate none", text: "no reviews" }),
        p.phone ? h("a", { class: "rp-call", href: `tel:${String(p.phone).replace(/[^\d+]/g, "")}`, "aria-label": `Call ${p.name || "this place"}`, text: "Call" }) : null
    ]);

    function render(body, out, leaveIn, res, raw) {
        const routes = res.routes;
        const focus = res.picks ? res.picks.routeId : res.bestId;
        const fr = routes.find((r) => r.id === focus) || routes[0];
        const idx = (id) => routes.findIndex((r) => r.id === id);
        // the comparison
        const cards = h("div", { class: "rp-cards" }, routes.map((r, i) => {
            const f = r.factors;
            return h("button", { type: "button", class: `rp-card${r.id === fr.id ? " on" : ""}`, "aria-pressed": String(r.id === fr.id), onclick: () => { if (r.id !== fr.id) analyse(body, out, leaveIn, r.id); } }, [
                h("div", { class: "rp-ct" }, [h("b", { text: C.labelFor(i) }), r.id === res.fastestId ? h("span", { class: "rp-badge fast", text: "Fastest" }) : null, r.id === res.bestId ? h("span", { class: "rp-badge best", text: "Best" }) : null]),
                h("div", { class: "rp-cv", text: `${C.fmtKm(r.distanceM)} · ${dur(r.durationS)}` }),
                h("div", { class: "rp-cs", text: `Arrive ${time(r.arriveAt)}` }),
                h("ul", { class: "rp-facts" }, [
                    h("li", { text: r.weather.available ? `${f.weatherWarnings} weather warning${f.weatherWarnings === 1 ? "" : "s"}` : "weather: not yet" }),
                    h("li", { text: r.road.available ? `${f.unpavedKm} km unpaved/bad · ${f.levelCrossings} rail crossings · ${f.breakers} breakers` : "road details: not available" }),
                    h("li", { text: r.places.available ? `longest without fuel ${f.fuelGapKm} km · hospital ${f.hospitalGapKm} km` : "places: not available" }),
                    r.terrain.available ? h("li", { text: `climb ${r.terrain.climbM} m` }) : null,
                    r.accidents.loaded ? h("li", { text: `${r.accidents.count} official blackspot${r.accidents.count === 1 ? "" : "s"}` }) : null
                ])
            ]);
        }));
        const why = h("p", { class: "rp-why", text: res.bestId === res.fastestId ? `${C.labelFor(idx(res.bestId))} is both the fastest and the best by these measures.` : `${C.labelFor(idx(res.bestId))} is best: ${res.best.why.join(", ")}.` });
        const use = h("button", { type: "button", class: "btn-primary-nav rp-use", text: `Use ${C.labelFor(idx(fr.id))} on the map`, onclick: () => {
            const r = raw[idx(fr.id)];
            if (r && typeof startSearchNavigation === "function" && dest) { close(); startSearchNavigation(dest.lat, dest.lng, dest.name, r); }
        } });

        // weather
        const wx = fr.weather;
        const weather = wx.available ? section(`Weather on ${day(res.departAt)}${wx.certain ? "" : " · less certain (more than 3 days ahead)"}`, [
            h("div", { class: "rp-wx" }, wx.samples.filter((s) => s.available).map((s) => h("div", { class: `rp-wrow${s.hazards.some((z) => z.level === "warning") ? " warn" : s.hazards.length ? " adv" : ""}` }, [
                h("span", { class: "rp-wk", text: `km ${Math.round(s.sM / 1000)} · ${time(s.at)}` }),
                h("span", { text: `${Math.round(s.tempC)}°C · rain ${s.rainProb1hPct ?? "–"}% · gusts ${Math.round((s.gustMs || 0) * 3.6)} km/h` }),
                s.hazards.length ? h("span", { class: "rp-hz", text: s.hazards.map((z) => HAZ[z.type] || z.type).join(", ") }) : null
            ]))),
            h("p", { class: "rp-note", text: "Open-Meteo forecast for the hour you reach each point at the route's usual pace." })
        ], true) : section("Weather", [h("p", { class: "rp-note", text: wx.reason === "too-far-ahead" ? `A forecast for that day isn't out yet. Check again from ${day(wx.checkFrom)}.` : "The forecast didn't load. Try again in a minute." })], true);

        // stops
        const tl = C.timeline(res.picks);
        const anyReviews = tl.some((r) => r.reviews);
        const stops = section("Stops: meals and breaks", tl.length ? [
            ...tl.map((r) => h("div", { class: "rp-stop" }, [
                h("div", { class: "rp-sh" }, [h("b", { text: r.label }), h("span", { text: `~${time(r.at)} · km ${Math.round(r.sM / 1000)}` })]),
                ...(r.options.length ? r.options.slice(0, 3).map(placeRow) : [h("p", { class: "rp-note", text: "Nothing mapped near here: plan this stop a little earlier." })]),
                r.fuelNearby && r.fuelNearby.length ? h("p", { class: "rp-note", text: `Fuel nearby: ${r.fuelNearby.map((p) => `${p.name || p.brand || "pump"} (km ${Math.round(p.sM / 1000)})`).join(", ")}` }) : null
            ])),
            h("p", { class: "rp-note", text: anyReviews ? "Ranked by Google ratings and reviews, with red flags (fraud, food poisoning, closed) and fake-review patterns checked. Well reviewed is not a guarantee." : "Without reviews here: the nearest places from OpenStreetMap." })
        ] : [h("p", { class: "rp-note", text: "A short ride: no meal or break stops needed." })], true);

        const P = fr.places;
        const gap = (g, what) => (g && g.maxM > 0 ? `Longest stretch without ${what}: ${C.fmtKm(g.maxM)} (km ${Math.round(g.fromM / 1000)}–${Math.round(g.toM / 1000)})` : "");
        // reviewed picks only: without reviews they would repeat the list below
        const pickBlock = (rows) => (rows || []).filter((x) => x.reviews && x.options.length).map((x) => h("div", { class: "rp-stop" }, [h("div", { class: "rp-sh" }, [h("span", { text: `Around km ${Math.round(x.sM / 1000)}` })]), ...x.options.map(placeRow)]));
        const placeSecs = P.available ? [
            section(`Hospitals: ${P.counts.hospital}`, [h("p", { class: "rp-note" + (P.gaps.hospital.maxM > 40000 ? " warn" : ""), text: gap(P.gaps.hospital, "a hospital") }), ...pickBlock(res.picks && res.picks.hospitals), ...P.lists.hospital.slice(0, 20).map(placeRow)]),
            section(`Fuel pumps: ${P.counts.fuel}`, [h("p", { class: "rp-note" + (P.gaps.fuel.maxM > 60000 ? " warn" : ""), text: gap(P.gaps.fuel, "fuel") + (P.gaps.fuel.maxM > 60000 ? `. Fill up before km ${Math.round(P.gaps.fuel.fromM / 1000)}.` : "") }), ...P.lists.fuel.map(placeRow)]),
            section(`Mechanics: ${P.counts.mechanic} (tyre shops ${P.counts.tyres})`, [h("p", { class: "rp-note", text: gap(P.gaps.mechanic, "a mechanic") }), ...pickBlock(res.picks && res.picks.mechanics), ...P.lists.mechanic.slice(0, 20).map(placeRow)]),
            section(`Hotels: ${P.counts.hotel}`, [...pickBlock(res.picks && res.picks.hotels), ...P.lists.hotel.slice(0, 15).map(placeRow)]),
            section(`Food: ${P.counts.dhaba} dhabas · ${P.counts.tea} tea · ${P.counts.food - P.counts.dhaba - P.counts.tea} restaurants`, P.lists.food.slice(0, 40).map(placeRow)),
            section(`Police ${P.counts.police} · Toilets ${P.counts.toilets}`, [...P.lists.police.slice(0, 15).map(placeRow), ...P.lists.toilets.slice(0, 15).map(placeRow)])
        ] : [section("Places", [h("p", { class: "rp-note", text: "OpenStreetMap didn't answer. Try again in a minute." })])];

        const R = fr.road, T = fr.terrain;
        const road = section("Road", [
            R.available ? h("ul", { class: "rp-list" }, [
                h("li", { text: `${R.unpavedKm} km unpaved or tagged bad` }), h("li", { text: `${R.breakers} speed breakers mapped` }), h("li", { text: `${R.levelCrossings} railway level crossings` }),
                ...R.hazards.slice(0, 10).map((z) => h("li", { text: `Marked hazard: ${z.type.replace(/_/g, " ")} at km ${Math.round(z.sM / 1000)}` }))
            ]) : h("p", { class: "rp-note", text: "Road details didn't load from OpenStreetMap." }),
            T.available ? h("p", { text: `Climb ${T.climbM} m, descent ${T.descentM} m, steepest 200 m: ${T.maxGradePct} % (${T.lowM}–${T.highM} m above sea level).` }) : h("p", { class: "rp-note", text: "Hills: this route is outside our 30 m terrain model for now." }),
            h("p", { class: "rp-note", text: "From OpenStreetMap: what isn't mapped isn't counted, so fewer breakers here doesn't mean none." })
        ]);
        const A = fr.accidents;
        const accidents = section("Accidents (official data)", A.loaded ? [
            h("p", { text: A.count ? `${A.count} officially listed blackspot${A.count === 1 ? "" : "s"} on this route.` : "No officially listed blackspots on this route." }),
            ...A.spots.slice(0, 20).map((s) => h("div", { class: "rp-place" }, [h("div", { class: "rp-pn" }, [h("b", { text: s.name || s.road || "Blackspot" }), h("span", { class: "rp-pm", text: [`km ${Math.round(s.sAlongM / 1000)}`, s.accidents ? `${s.accidents} accidents` : "", s.fatalities ? `${s.fatalities} deaths` : "", s.period].filter(Boolean).join(" · ") })])]))
        ] : [h("p", { class: "rp-note", text: "No official accident data is loaded for this road yet, so the plan shows none rather than guessing. Ride every ghat and junction carefully." })]);
        const src = res.sources;
        const sources = h("p", { class: "rp-src", text: `Sources: ${[src.places, src.reviews, src.weather, src.terrain, src.accidents].filter(Boolean).join(" · ")}. Times assume the route's usual pace.` });
        out.replaceChildren(cards, why, use, weather, stops, ...placeSecs, road, accidents, sources);
    }

    // ------------------------------------------------------------ the sheet
    function close() { if (modal) { modal.remove(); modal = null; } }
    function open() {
        close();
        const body = { osrm: null };
        const leaveIn = /** @type {HTMLInputElement} */ (h("input", { type: "datetime-local", class: "rp-input", "aria-label": "When you'll leave" }));
        const start = Math.ceil(Date.now() / (15 * 60000)) * 15 * 60000;
        leaveIn.value = C.localInput(start);
        leaveIn.min = C.localInput(Date.now() - 60000);
        const out = h("div", { class: "rp-out" });
        const go = h("button", { type: "button", class: "btn-primary-nav", text: "Make the plan", onclick: () => analyse(body, out, leaveIn, undefined) });
        modal = h("div", { class: "modal rp-modal", role: "dialog", "aria-modal": "true", "aria-label": "Ride plan", onclick: (e) => { if (e.target === modal) close(); } }, [
            h("div", { class: "modal-card wide rp-card-wrap" }, [
                h("button", { class: "close-modal", type: "button", "aria-label": "Close", text: "✕", onclick: close }),
                h("h2", { text: `Ride plan${dest && dest.name ? `: ${dest.name}` : ""}` }),
                h("label", { class: "rp-label", text: "When will you leave?" }), leaveIn, go, out
            ])
        ]);
        document.body.append(modal);
        modal.style.display = "flex";
    }

    // the button in the route preview: shown with a destination, hidden once the drive starts
    let btn = null;
    function ensureBtn() {
        if (btn) return btn;
        const sheet = document.getElementById("nav-bottom-sheet");
        if (!sheet) return null;
        btn = h("button", { type: "button", id: "ride-plan-btn", class: "btn-secondary-nav", hidden: true, text: "Ride plan: weather, stops, fuel, hospitals", onclick: open });
        sheet.append(btn);
        return btn;
    }
    document.addEventListener("mu:destination", (e) => {
        const d = /** @type {CustomEvent} */ (e).detail || {};
        if (Number.isFinite(d.lat) && Number.isFinite(d.lng)) dest = { lat: d.lat, lng: d.lng, name: d.name || "" };
        const b = ensureBtn(); if (b) b.hidden = false;
    });
    document.addEventListener("mu:route", (e) => { const d = /** @type {CustomEvent} */ (e).detail || {}; if (Array.isArray(d.path) && d.path.length > 1) route = { path: d.path, distanceM: d.distanceM, durationSec: d.durationSec }; });
    document.addEventListener("mu:drive-state", (e) => { const d = /** @type {CustomEvent} */ (e).detail || {}; if (btn && (d.navigating || d.driving)) btn.hidden = true; });

    return { core: C, open, close };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).RidePlan = RidePlan;
if (typeof module === "object" && module.exports) module.exports = { RidePlanCore };
