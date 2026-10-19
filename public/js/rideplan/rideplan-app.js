/* ============================================================================
   MapUnite Ride Plan — the whole route, before the ride
   ==============================================================================
   With a destination on screen (before Start), "Ride plan" in the bottom sheet
   opens the plan: the rider picks the day and time they'll leave, and the
   app asks the router for up to three routes and the server
   (/api/master/ride-plan, lib/master/rideplan.js) for everything along them:
     - which is FASTEST and which is BEST, and exactly why;
     - the weather on the ride day at about the time the rider reaches each
       stretch (MET Norway, fetched by our server; about 9 days ahead,
       "less certain" after 3); further ahead, the month's USUAL weather
       (NASA POWER), never presented as a forecast;
     - MapUnite riders' own road reports (RoadPulse) on the route, each with
       its status and how many riders agree;
     - a stop plan: breakfast / lunch / dinner where the ride crosses meal
       time and a break about every 2 h, each with the places MapUnite riders
       rated after they said they stopped there (3 ratings or more), else
       the nearest OpenStreetMap places. No paid reviews;
     - hospitals, mechanics and tyre shops, fuel, hotels, dhabas and tea,
       police and toilets: how many, where (km), and the longest stretch
       WITHOUT fuel / a hospital / a mechanic; hospitals from a government
       directory are shown as KNOWN locations that may be out of date;
     - the road: speed breakers, level crossings, unpaved or bad km, mapped
       hazards, and the climb from the 30 m terrain model where it covers;
     - official accident blackspots, only from lists loaded on the server.
       Without one the plan says so; it never invents accident numbers.
   Every part carries its source, when its data was made, how far to trust it
   (high / medium / low / official / pattern) and an "estimate" tag where it
   is one. The rider's own choices: ride up to 1 to 3 h without a break, and their
   full-tank range (optional, for fuel warnings); kept on this phone
   ("mu.rideplan.v1"). A ride that starts or ends in the dark says so.
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
     * @param {any} picks the server's picks @returns {Array<{ type: string, label: string, sM: number, at: number, options: any[], ratings: boolean, fuelNearby?: any[], toiletsNearby?: number }>}
     */
    function timeline(picks) {
        if (!picks) return [];
        const meal = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" };
        const rows = [
            ...(picks.meals || []).map((m) => ({ type: "meal", label: /** @type {any} */ (meal)[m.meal] || "Meal", sM: m.sM, at: m.at, options: m.options || [], ratings: Boolean(m.ratings) })),
            ...(picks.restStops || []).map((r) => ({ type: "rest", label: `Break after ${Math.round(r.afterS / 3600)} h`, sM: r.sM, at: r.at, options: r.options || [], ratings: Boolean(r.ratings), fuelNearby: r.fuelNearby || [], toiletsNearby: r.toiletsNearby || 0 }))
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
    const PREFS = "mu.rideplan.v1";
    function loadPrefs() { try { const s = JSON.parse(localStorage.getItem(PREFS) || "{}"); return { breakEveryMin: [60, 90, 120, 150, 180].includes(s.breakEveryMin) ? s.breakEveryMin : 120, rangeKm: Number.isFinite(s.rangeKm) && s.rangeKm >= 30 ? s.rangeKm : null }; } catch (e) { return { breakEveryMin: 120, rangeKm: null }; } }
    function savePrefs(p) { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch (e) { /* private mode */ } }

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
        const prefs = loadPrefs();
        out.replaceChildren(h("p", { class: "rp-wait", role: "status", text: "Reading the routes: places, riders' ratings, ride-day weather, road and terrain… (up to a minute on a long route)" }));
        const from = route && route.path && route.path.length ? route.path[0] : (typeof myCoords !== "undefined" && myCoords ? [myCoords.lat, myCoords.lng] : null);
        if (!from || !dest) { out.replaceChildren(h("p", { class: "rp-err", text: "Pick a destination first." })); return; }
        if (!body.osrm) body.osrm = await alternatives(from, dest);
        const raw = body.osrm.length ? body.osrm : route ? [{ geometry: { coordinates: route.path.map(([a, b]) => [b, a]) }, distance: route.distanceM, duration: route.durationSec }] : [];
        if (!raw.length) { out.replaceChildren(h("p", { class: "rp-err", text: "No route found. Check your connection and try again." })); return; }
        const routes = raw.map((r, i) => ({ id: String(i), line: C.thin(r.geometry.coordinates.map(([lng, lat]) => [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]), 3000), distanceM: r.distance, durationS: r.duration }));
        let res = null;
        try {
            const r = await fetch(api(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ routes, departAt, focus, tzOffsetMin: -new Date(departAt).getTimezoneOffset(), prefs: { breakEveryMin: prefs.breakEveryMin, rangeKm: prefs.rangeKm } }) });
            res = await r.json();
        } catch (e) { res = null; }
        if (!res || !res.ok) { out.replaceChildren(h("p", { class: "rp-err", text: res && res.reason === "bad-length" ? "This route is too long for a plan (over 1500 km)." : "Couldn't make the plan right now (the server or a data source didn't answer). Try again in a minute." })); return; }
        render(body, out, leaveIn, res, raw);
    }

    function section(title, kids, open = false, meta = null) {
        return h("details", { class: "rp-sec", open }, [h("summary", { text: title }), meta ? metaLine(meta) : null, ...kids]);
    }
    const CONF = { high: "high", medium: "medium", low: "low", official: "official list", pattern: "usual pattern, not a forecast", varies: "varies: see each report", "no-reports": "no reports yet", none: "no data" };
    /** Where a part comes from, when its data was made, how far to trust it. */
    function metaLine(m) {
        const upd = m.updatedAt ? `updated ${new Date(m.updatedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}${Date.now() - m.updatedAt < 2 * 86400000 ? ` ${time(m.updatedAt)}` : ""}` : null;
        return h("div", { class: "rp-meta" }, [
            h("span", { text: [m.source ? `Source: ${m.source}` : "No data", upd, `confidence: ${CONF[m.confidence] || m.confidence}`].filter(Boolean).join(" · ") }),
            m.estimate ? h("span", { class: "rp-est", text: "estimate" }) : null,
            m.note ? h("span", { class: "rp-mnote", text: m.note }) : null
        ]);
    }
    const placeRow = (p) => h("div", { class: "rp-place" }, [
        h("div", { class: "rp-pn" }, [
            h("b", { text: p.name || ({ dhaba: "Dhaba", tea: "Tea stall", fuel: "Fuel pump", toilets: "Public toilets", police: "Police" })[p.kind] || "Unnamed place" }),
            h("span", { class: "rp-pm", text: [`km ${Math.round(p.sM / 1000)}`, p.offM > 150 ? `${C.fmtKm(p.offM)} off the road` : "on the road", p.brand].filter(Boolean).join(" · ") })
        ]),
        p.known ? h("span", { class: "rp-rate known", title: "From a government hospital directory: the location may be out of date. Call ahead.", text: "known location" })
            : p.riders ? h("span", { class: `rp-rate${p.riders.up >= p.riders.down * 3 ? " ok" : ""}`, title: "From MapUnite riders who said they stopped here", text: `👍 ${p.riders.up} · 👎 ${p.riders.down}` })
            : h("span", { class: "rp-rate none", text: "no rider ratings yet" }),
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
                    r.riders && r.riders.available ? h("li", { text: `${r.riders.hazards.length} rider report${r.riders.hazards.length === 1 ? "" : "s"} (${r.riders.confirmed} confirmed)` }) : null,
                    r.accidents.loaded ? h("li", { text: `${r.accidents.count} official blackspot${r.accidents.count === 1 ? "" : "s"}` }) : null,
                    r.light && r.light.arrive !== "day" ? h("li", { class: "rp-warn", text: r.light.arrive === "dark" ? "arrives after dark" : "arrives at dusk" }) : null
                ])
            ]);
        }));
        const why = h("p", { class: "rp-why", text: res.bestId === res.fastestId ? `${C.labelFor(idx(res.bestId))} is both the fastest and the best by these measures.` : `${C.labelFor(idx(res.bestId))} is best: ${res.best.why.join(", ")}.` });
        const startOn = (r) => { if (r && typeof startSearchNavigation === "function" && dest) { close(); startSearchNavigation(dest.lat, dest.lng, dest.name, r); } };
        const use = h("button", { type: "button", class: "btn-primary-nav rp-use", text: `Use ${C.labelFor(idx(fr.id))} on the map`, onclick: () => startOn(raw[idx(fr.id)]) });
        // Hyper-Vision: the rider's own stop-by-stop schedule for this route (hypervision-app.js)
        const hv = typeof HyperVision !== "undefined" && HyperVision.section ? HyperVision.section({ res, route: fr, raw: raw[idx(fr.id)], rangeKm: loadPrefs().rangeKm, maxRideMin: res.prefs.breakEveryMin, dest, start: startOn }) : null;

        // what the rider should know first
        const alerts = [];
        if (fr.light.depart === "dark") alerts.push("You'd set off in the dark: lights on, and watch for animals and unlit vehicles.");
        if (fr.light.arrive !== "day") alerts.push(`You'd arrive ${fr.light.arrive === "dark" ? "after dark" : "at dusk"} (about ${time(fr.arriveAt)}, estimate). Leaving earlier gives you daylight on the last stretch.`);
        if (fr.fuel && fr.fuel.beyondRange) alerts.push(`The longest stretch without fuel (${fr.fuel.maxGapKm} km, from km ${fr.fuel.fromKm}) is close to or beyond your tank's range (${fr.fuel.rangeKm} km). Fill up before km ${fr.fuel.fromKm}.`);
        const top = alerts.length ? h("div", { class: "rp-alerts", role: "note" }, alerts.map((a) => h("p", { text: a }))) : null;

        // weather
        const wx = fr.weather, cl = fr.climate, M = fr.meta;
        const MONTH = (m) => new Date(2026, m, 1).toLocaleDateString("en-IN", { month: "long" });
        const weather = wx.available ? section(`Weather on ${day(res.departAt)}${wx.certain ? "" : " · less certain (more than 3 days ahead)"}`, [
            h("div", { class: "rp-wx" }, wx.samples.filter((s) => s.available).map((s) => h("div", { class: `rp-wrow${s.hazards.some((z) => z.level === "warning") ? " warn" : s.hazards.length ? " adv" : ""}` }, [
                h("span", { class: "rp-wk", text: `km ${Math.round(s.sM / 1000)} · ${time(s.at)}` }),
                h("span", { text: [s.tempC !== null ? `${Math.round(s.tempC)}°C` : null, s.rainProb1hPct !== null && s.rainProb1hPct !== undefined ? `rain ${Math.round(s.rainProb1hPct)}%` : s.precipMmH ? `rain ${s.precipMmH} mm/h` : "dry", s.gustMs ? `gusts ${Math.round(s.gustMs * 3.6)} km/h` : s.windMs !== null && s.windMs !== undefined ? `wind ${Math.round(s.windMs * 3.6)} km/h` : null].filter(Boolean).join(" · ") }),
                s.hazards.length ? h("span", { class: "rp-hz", text: s.hazards.map((z) => HAZ[z.type] || z.type).join(", ") }) : null
            ]))),
            h("p", { class: "rp-note", text: "Weather forecast from MET Norway, for about the hour you reach each point at the route's usual pace (6-hour steps further ahead)." })
        ], true, M.weather) : section(cl && cl.available ? `Usual weather in ${MONTH(cl.month)} (not a forecast)` : "Weather", [
            h("p", { class: "rp-note", text: wx.reason === "too-far-ahead" ? `A forecast for that day isn't out yet. Check again from ${day(wx.checkFrom)}.` : "The forecast didn't load. Try again in a minute." }),
            ...(cl && cl.available ? cl.points.map((c) => h("div", { class: "rp-wrow" }, [
                h("span", { class: "rp-wk", text: c.sM === 0 ? "Start" : c.sM === fr.distanceM || c.sM > fr.distanceM * 0.9 ? "End" : `km ${Math.round(c.sM / 1000)}` }),
                h("span", { text: [c.lowC !== null && c.highC !== null ? `${Math.round(c.lowC)}–${Math.round(c.highC)}°C` : c.tempC !== null ? `${Math.round(c.tempC)}°C` : null, c.rainMmDay !== null ? `about ${c.rainMmDay} mm of rain a day` : null].filter(Boolean).join(" · ") }),
                c.notes && c.notes.length ? h("span", { class: "rp-hz", text: c.notes.join(", ") }) : null
            ])) : [])
        ], true, M.weather);

        // stops
        const tl = C.timeline(res.picks);
        const anyRatings = tl.some((r) => r.ratings);
        const stops = section(`Stops: meals and breaks (every ${(res.prefs.breakEveryMin / 60).toString().replace(".5", "½")} h)`, tl.length ? [
            ...tl.map((r) => h("div", { class: "rp-stop" }, [
                h("div", { class: "rp-sh" }, [h("b", { text: r.label }), h("span", { text: `~${time(r.at)} · km ${Math.round(r.sM / 1000)}` })]),
                ...(r.options.length ? r.options.slice(0, 3).map(placeRow) : [h("p", { class: "rp-note", text: "Nothing mapped near here: plan this stop a little earlier." })]),
                r.fuelNearby && r.fuelNearby.length ? h("p", { class: "rp-note", text: `Fuel nearby: ${r.fuelNearby.map((p) => `${p.name || p.brand || "pump"} (km ${Math.round(p.sM / 1000)})`).join(", ")}` }) : null
            ])),
            h("p", { class: "rp-note", text: anyRatings ? "Places MapUnite riders rated after saying they stopped there come first (3 ratings or more); then the nearest. Ratings are riders' opinions, not a guarantee." : "No rider ratings here yet: the nearest places from OpenStreetMap. After a ride, MapUnite asks you about places you stopped at." })
        ] : [h("p", { class: "rp-note", text: "A short ride: no meal or break stops needed." })], true, { source: "OpenStreetMap places, ranked by MapUnite riders' ratings", updatedAt: M.places.updatedAt, confidence: anyRatings ? "medium" : "low", estimate: true, note: "Stop times are estimates at the route's usual pace." });

        const P = fr.places;
        const gap = (g, what) => (g && g.maxM > 0 ? `Longest stretch without ${what}: ${C.fmtKm(g.maxM)} (km ${Math.round(g.fromM / 1000)}–${Math.round(g.toM / 1000)})` : "");
        // rated picks only: without ratings they would repeat the list below
        const pickBlock = (rows) => (rows || []).filter((x) => x.options.some((p) => p.riders) && x.options.length).map((x) => h("div", { class: "rp-stop" }, [h("div", { class: "rp-sh" }, [h("span", { text: `Around km ${Math.round(x.sM / 1000)}` })]), ...x.options.map(placeRow)]));
        const placeSecs = P.available ? [
            section(`Hospitals: ${P.counts.hospital}${P.counts.knownHospitals ? ` + ${P.counts.knownHospitals} known from a government directory` : ""}`, [
                M.knownHospitals ? metaLine(M.knownHospitals) : null,
                h("p", { class: "rp-note" + (P.gaps.hospital.maxM > 40000 ? " warn" : ""), text: gap(P.gaps.hospital, "a hospital") }),
                ...pickBlock(res.picks && res.picks.hospitals), ...P.lists.hospital.slice(0, 20).map(placeRow),
                P.knownHospitals && P.knownHospitals.length ? h("p", { class: "rp-note", text: "Known locations from a government hospital directory. Not verified: the directory can be out of date and positions approximate, so call ahead before relying on one." }) : null,
                ...(P.knownHospitals || []).slice(0, 20).map(placeRow)
            ], false, M.places),
            section(`Fuel pumps: ${P.counts.fuel}`, [h("p", { class: "rp-note" + (P.gaps.fuel.maxM > 60000 ? " warn" : ""), text: gap(P.gaps.fuel, "fuel") + (P.gaps.fuel.maxM > 60000 ? `. Fill up before km ${Math.round(P.gaps.fuel.fromM / 1000)}.` : "") }), ...P.lists.fuel.map(placeRow)], false, M.places),
            section(`Mechanics: ${P.counts.mechanic} (tyre shops ${P.counts.tyres})`, [h("p", { class: "rp-note", text: gap(P.gaps.mechanic, "a mechanic") }), ...pickBlock(res.picks && res.picks.mechanics), ...P.lists.mechanic.slice(0, 20).map(placeRow)], false, M.places),
            section(`Hotels: ${P.counts.hotel}`, [...pickBlock(res.picks && res.picks.hotels), ...P.lists.hotel.slice(0, 15).map(placeRow)], false, M.places),
            section(`Food: ${P.counts.dhaba} dhabas · ${P.counts.tea} tea · ${P.counts.food - P.counts.dhaba - P.counts.tea} restaurants`, P.lists.food.slice(0, 40).map(placeRow), false, M.places),
            section(`Police ${P.counts.police} · Toilets ${P.counts.toilets}`, [...P.lists.police.slice(0, 15).map(placeRow), ...P.lists.toilets.slice(0, 15).map(placeRow)], false, M.places)
        ] : [section("Places", [h("p", { class: "rp-note", text: "OpenStreetMap didn't answer. Try again in a minute." })], false, M.places)];

        const R = fr.road, T = fr.terrain;
        const road = section("Road", [
            R.available ? h("ul", { class: "rp-list" }, [
                h("li", { text: `${R.unpavedKm} km unpaved or tagged bad` }), h("li", { text: `${R.breakers} speed breakers mapped` }), h("li", { text: `${R.levelCrossings} railway level crossings` }),
                ...R.hazards.slice(0, 10).map((z) => h("li", { text: `Marked hazard: ${z.type.replace(/_/g, " ")} at km ${Math.round(z.sM / 1000)}` }))
            ]) : h("p", { class: "rp-note", text: "Road details didn't load from OpenStreetMap." }),
            T.available ? h("p", { text: `Climb ${T.climbM} m, descent ${T.descentM} m, steepest 200 m: ${T.maxGradePct} % (${T.lowM}–${T.highM} m above sea level).` }) : h("p", { class: "rp-note", text: "Hills: this route is outside our 30 m terrain model for now." }),
            T.available ? metaLine(M.terrain) : null
        ], false, M.road);
        // MapUnite riders' own reports (RoadPulse): what they reviewed and published, with how many agree
        const RR = fr.riders, STATUS = { community_confirmed: "Confirmed by riders", reviewed_report: "Reported, reviewed by the rider", disputed: "Disputed", possibly_repaired: "May be repaired" };
        const riders = section(`Rider reports: ${RR.available ? RR.hazards.length : "–"}`, RR.available ? (RR.hazards.length ? RR.hazards.slice(0, 30).map((z) => h("div", { class: "rp-place" }, [
            h("div", { class: "rp-pn" }, [h("b", { text: String(z.type).replace(/_/g, " ") }), h("span", { class: "rp-pm", text: [`km ${Math.round(z.sM / 1000)}`, STATUS[z.status] || z.status, z.fewRiders ? "few riders here" : z.found !== null && z.found !== undefined ? `${z.found} found · ${z.notFound} not found` : null, z.lastFound ? `last seen ${z.lastFound.replace("_", " ")}` : null].filter(Boolean).join(" · ") })]),
            h("span", { class: `rp-rate${z.confidence === "high" ? " ok" : z.confidence === "low" ? " none" : ""}`, text: `confidence ${z.confidence}` })
        ])) : [h("p", { class: "rp-note", text: "No rider reports on this route yet. That isn't a promise the road is clear." })]) : [h("p", { class: "rp-note", text: "Rider reports aren't available right now." })], false, M.riders);
        const A = fr.accidents;
        const accidents = section("Official blackspots", A.loaded ? [
            h("p", { text: A.count ? `${A.count} officially listed blackspot${A.count === 1 ? "" : "s"} on this route.` : "No officially listed blackspots on this route." }),
            ...A.spots.slice(0, 20).map((s) => h("div", { class: "rp-place" }, [h("div", { class: "rp-pn" }, [h("b", { text: s.name || s.road || "Blackspot" }), h("span", { class: "rp-pm", text: [`km ${Math.round(s.sAlongM / 1000)}`, s.accidents ? `${s.accidents} accidents` : "", s.fatalities ? `${s.fatalities} deaths` : "", s.period].filter(Boolean).join(" · ") })])]))
        ] : [h("p", { class: "rp-note", text: "No official accident data is loaded for this road yet, so the plan shows none rather than guessing. Ride every ghat and junction carefully." })], false, M.accidents);
        const src = res.sources;
        const sources = h("p", { class: "rp-src", text: `Sources: ${[src.places, src.ratings && `ratings from ${src.ratings}`, src.knownHospitals && `known hospitals: ${src.knownHospitals}`, src.weather, src.climate, src.riders && `rider reports from ${src.riders}`, src.terrain, src.accidents].filter(Boolean).join(" · ")}. Times assume the route's usual pace. Where there's no data, the plan says so.` });
        out.replaceChildren(top || "", cards, why, use, metaLine(M.route), hv || "", weather, stops, riders, ...placeSecs, road, accidents, sources);
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
        const prefs = loadPrefs();
        const breakSel = /** @type {HTMLSelectElement} */ (h("select", { class: "rp-input rp-half", "aria-label": "Ride without a break up to" }, [[60, "1 h"], [90, "1½ h"], [120, "2 h"], [150, "2½ h"], [180, "3 h"]].map(([v, l]) => h("option", { value: String(v), text: l }))));
        breakSel.value = String(prefs.breakEveryMin);
        const rangeIn = /** @type {HTMLInputElement} */ (h("input", { type: "number", class: "rp-input rp-half", min: "30", max: "1500", inputmode: "numeric", placeholder: "e.g. 350", "aria-label": "Your full-tank range in km" }));
        if (prefs.rangeKm) rangeIn.value = String(prefs.rangeKm);
        const savePrefsNow = () => { const r = Number(rangeIn.value); savePrefs({ breakEveryMin: Number(breakSel.value) || 120, rangeKm: r >= 30 && r <= 1500 ? r : null }); };
        breakSel.addEventListener("change", savePrefsNow); rangeIn.addEventListener("change", savePrefsNow);
        const go = h("button", { type: "button", class: "btn-primary-nav", text: "Make the plan", onclick: () => { savePrefsNow(); body.osrm = body.osrm || null; analyse(body, out, leaveIn, undefined); } });
        modal = h("div", { class: "modal rp-modal", role: "dialog", "aria-modal": "true", "aria-label": "Ride plan", onclick: (e) => { if (e.target === modal) close(); } }, [
            h("div", { class: "modal-card wide rp-card-wrap" }, [
                h("button", { class: "close-modal", type: "button", "aria-label": "Close", text: "✕", onclick: close }),
                h("h2", { text: `MapUnite Ride Plan${dest && dest.name ? `: ${dest.name}` : ""}` }),
                h("label", { class: "rp-label", text: "When will you leave?" }), leaveIn,
                h("div", { class: "rp-prefs" }, [
                    h("label", { class: "rp-label", text: "Ride without a break up to" }, []), h("label", { class: "rp-label", text: "Full-tank range (km, optional)" }),
                    breakSel, rangeIn
                ]),
                go, out
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
