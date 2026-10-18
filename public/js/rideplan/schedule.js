/* ============================================================================
   MapUnite Hyper-Vision — the rider's own stop-by-stop schedule (pure)
   ==============================================================================
   From the rider's inputs and the Ride Plan's route data, a plan made BEFORE the
   ride, which the rider can edit and then follow:
     inputs   when they leave, how long they ride without a break, their usual
              cruising speed, fuel in the tank now, full-tank range, km/L (from
              My bike, which already counts their pillion and luggage), how
              long they stay at the destination (for the way back), and an
              optional "arrive by".
     data     the route (distance, the router's time, the line), the places on
              it (food, tea, dhabas, fuel) with riders' ratings, weather
              samples, riders' road reports — all from /api/master/ride-plan.
   Out: a timeline of stops — breaks, breakfast / lunch / dinner, fuel, or
   several at one place — each with a suggested place, arrival and departure
   time, and the REASONS ("1 h 55 min of riding since your last stop, your limit
   is 2 h"; "lunch time, 12:30–14:30"; "fuel: about 60 km left before reserve").
   Then totals (riding, stopped, arrival as a RANGE), fuel needed, and advice:
   riding in the dark, the latest departure for a daylight arrival or for the
   rider's "arrive by", the way back, the forecast and confirmed hazards.
   Everything is an ESTIMATE and says so: traffic, weather and the rider's real
   stops change it. Nothing here asks a server: edits recompute at once.

   HyperVisionCore.schedule(o) → { items, totals, warnings }
   HyperVisionCore.advise(o, plan) → [{ level, text }]
   HyperVisionCore.progress(plan, sM, now) → { next, behindMin } during the ride
   ============================================================================ */
"use strict";

const HyperVisionCore = (() => {
    const MIN = 60000, H = 3600000, RAD = Math.PI / 180;
    const DEFAULTS = Object.freeze({
        restMin: 15, fuelMin: 10, reserveShare: 0.2,
        meals: Object.freeze([
            { meal: "breakfast", label: "Breakfast", from: 7.5, to: 9.5, min: 30 },
            { meal: "lunch", label: "Lunch", from: 12.5, to: 14.5, min: 45 },
            { meal: "dinner", label: "Dinner", from: 19.5, to: 21.5, min: 45 }
        ]),
        // the rider's average over a whole ride is below their cruising speed: towns, villages, overtaking, turns
        cruiseToAverage: 0.8
    });

    // ------------------------------------------------------------ sun (NOAA general solar position, as lib/master/sun.js)
    function elevationDeg(lat, lng, tMs) {
        const d = new Date(tMs);
        const doy = Math.floor((tMs - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000);
        const hour = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
        const g = (2 * Math.PI / 365) * (doy + (hour - 12) / 24);
        const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
        const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
        const ha = ((hour * 60 + eqtime + 4 * lng) / 4 - 180) * RAD;
        const cosZen = Math.sin(lat * RAD) * Math.sin(decl) + Math.cos(lat * RAD) * Math.cos(decl) * Math.cos(ha);
        return 90 - Math.acos(Math.max(-1, Math.min(1, cosZen))) / RAD;
    }
    const isDark = (lat, lng, t) => elevationDeg(lat, lng, t) < 0;
    /** The sunset (elevation crossing 0, going down) on the local day of `t`, or null (polar). */
    function sunset(lat, lng, t, tz) {
        const day0 = Math.floor((t + tz * MIN) / 86400000) * 86400000 - tz * MIN;
        let lo = day0 + 12 * H, hi = day0 + 23.9 * H;
        if (elevationDeg(lat, lng, lo) < 0 || elevationDeg(lat, lng, hi) > 0) return null;
        for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (elevationDeg(lat, lng, m) > 0) lo = m; else hi = m; }
        return Math.round(lo / MIN) * MIN;
    }

    // ------------------------------------------------------------ geometry
    const RE = 6371008.8;
    const hav = (a, b) => { const dLat = (b[0] - a[0]) * RAD, dLng = (b[1] - a[1]) * RAD; const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLng / 2) ** 2; return 2 * RE * Math.asin(Math.min(1, Math.sqrt(x))); };
    function cumulative(line) { const c = [0]; for (let i = 1; i < line.length; i++) c.push(c[i - 1] + hav(line[i - 1], line[i])); return c; }
    function pointAt(line, cum, s) {
        if (!line || line.length < 2) return line && line[0] ? line[0] : [0, 0];
        if (s <= 0) return line[0];
        const last = line.length - 1;
        if (s >= cum[last]) return line[last];
        let lo = 0, hi = last;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
        const f = (s - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]);
        return [line[lo][0] + (line[hi][0] - line[lo][0]) * f, line[lo][1] + (line[hi][1] - line[lo][1]) * f];
    }

    /** Riding seconds at the rider's pace: never quicker than the router; slower if their cruising speed says so. */
    function ridingSeconds(distanceM, routeS, cruiseKmh) {
        const base = routeS > 0 ? routeS : distanceM / 13.9;
        if (!(cruiseKmh > 0)) return base;
        return Math.max(base, distanceM / (cruiseKmh / 3.6 * DEFAULTS.cruiseToAverage));
    }
    /** Hours since local midnight. */
    const localHours = (t, tz) => (((t + tz * MIN) % 86400000) + 86400000) % 86400000 / H;

    /** The best place for a stop around `s`: rated by riders first (Wilson score), then the nearest (and least off the road). */
    function pickPlace(list, s, back, fwd, minS) {
        const c = (list || []).filter((p) => p.sM >= Math.max(minS, s - back) && p.sM <= s + fwd);
        if (!c.length) return null;
        c.sort((a, b) => {
            const ra = a.riders && Number.isFinite(a.riders.score) ? a.riders.score : -1, rb = b.riders && Number.isFinite(b.riders.score) ? b.riders.score : -1;
            if (ra !== rb) return rb - ra;
            return Math.abs(a.sM - s) + (a.offM || 0) - (Math.abs(b.sM - s) + (b.offM || 0));
        });
        return c[0];
    }

    /**
     * The schedule. Pure.
     * @param {{ departAt: number, distanceM: number, routeS: number, cruiseKmh?: number|null, maxRideMin?: number, tz?: number,
     *   line?: number[][], places?: { food?: any[], fuel?: any[] },
     *   fuel?: { rangeKm?: number|null, startShare?: number|null, kmPerL?: number|null },
     *   edits?: { removed?: string[], minutes?: Record<string, number> }, restMin?: number }} o
     */
    function schedule(o) {
        const D = Math.max(1, o.distanceM), tz = Number.isFinite(o.tz) ? o.tz : 330;
        const rideS = ridingSeconds(D, o.routeS, o.cruiseKmh || null);
        const v = D / rideS;                                       // m/s, the rider's average
        const maxRideS = Math.max(30, Math.min(300, o.maxRideMin || 120)) * 60;
        const restMin = o.restMin || DEFAULTS.restMin;
        const removed = new Set((o.edits && o.edits.removed) || []), minutes = (o.edits && o.edits.minutes) || {};
        const food = (o.places && o.places.food) || [], pumps = (o.places && o.places.fuel) || [];
        const range = o.fuel && o.fuel.rangeKm > 0 ? o.fuel.rangeKm * 1000 : null;
        let tank = range !== null ? range * Math.max(0, Math.min(1, o.fuel && Number.isFinite(o.fuel.startShare) ? /** @type {number} */ (o.fuel.startShare) : 1)) : null;
        const reserve = range !== null ? range * DEFAULTS.reserveShare : 0;

        let s = 0, t = o.departAt, since = 0, longest = 0, restDue = maxRideS, n = { rest: 0, fuel: 0 };
        const done = new Set(), warnings = [], items = [{ type: "start", id: "start", sM: 0, arriveAt: o.departAt, departAt: o.departAt, minutes: 0, reasons: [] }];
        const endRideS = 20 * 60;                                  // no stop in the last 20 minutes of riding

        for (let guard = 0; guard < 40 && s < D - 1; guard++) {
            const cands = [];
            // a break: when the riding since the last stop reaches the rider's limit
            // (when the rider removed the break that was due, the next one is a whole limit later, not right away)
            const restAt = s + v * (restDue - since);
            if (restAt < D - v * endRideS) cands.push({ kind: "rest", at: Math.max(s + 1, restAt) });
            // meals: the first meal window the ride is in, at its start (or 30 min after leaving, when leaving inside it)
            for (const m of DEFAULTS.meals) {
                if (done.has(m.meal)) continue;
                for (let d = 0; d < 3; d++) {
                    const day0 = Math.floor((o.departAt + tz * MIN) / 86400000) * 86400000 - tz * MIN + d * 86400000;
                    const from = day0 + m.from * H, to = day0 + m.to * H;
                    const when = Math.max(from, o.departAt + 30 * MIN, t);
                    if (when >= to) continue;
                    const at = s + (when - t) / 1000 * v;
                    if (at < D - v * endRideS) cands.push({ kind: "meal", meal: m, at: Math.max(s + 1, at) });
                    break;
                }
            }
            // fuel: before the tank reaches its reserve (a fifth of a full tank)
            if (tank !== null && range !== null) {
                const at = s + (tank - reserve);
                if (at < D) cands.push({ kind: "fuel", at: Math.max(s + 1, at) });
            }
            if (!cands.length) break;
            cands.sort((a, b) => a.at - b.at);
            const ev = cands[0];

            // where: a real place near the moment it's due
            let place = null, pos = ev.at, onReserve = false;
            if (ev.kind === "fuel") {
                const ok = pumps.filter((p) => p.sM > s + 1000 && p.sM <= ev.at).sort((a, b) => b.sM - a.sM);
                place = ok[0] || null;
                const from = s < 1000 ? "you set off" : `km ${Math.round(s / 1000)}`;
                if (!place && tank !== null) {
                    // none before the reserve: the first pump the reserve still reaches, said plainly
                    const after = pumps.filter((p) => p.sM > ev.at && p.sM < s + /** @type {number} */ (tank) - 0.05 * /** @type {number} */ (range)).sort((a, b) => a.sM - b.sM)[0];
                    if (after) { place = after; onReserve = true; warnings.push({ level: "warning", text: `No mapped fuel pump between ${from} and km ${Math.round(ev.at / 1000)}, where your tank reaches its reserve: you'd ride on reserve to km ${Math.round(after.sM / 1000)}. Better: fill up before ${s < 1000 ? "you set off" : from}.` }); }
                }
                if (!place) {
                    warnings.push({ level: "warning", text: `No mapped fuel pump between ${from} and km ${Math.round(ev.at / 1000)}, where your tank reaches its reserve, nor within the reserve after it. Fill up before ${s < 1000 ? "you set off" : from}, or carry fuel. The plan stops counting fuel from here.` });
                    tank = null;                                   // the plan can't promise fuel from here on
                    continue;
                }
                pos = place.sM;
            } else if (ev.kind === "meal") {
                place = pickPlace(food, ev.at, 10000, 10000, s + 2000);
                pos = place ? place.sM : ev.at;
            } else {
                place = pickPlace([...food, ...pumps], ev.at, 15000, 0, s + 3000);
                pos = place ? place.sM : ev.at;
            }
            pos = Math.min(Math.max(pos, s + 1), D - 1);

            // what happens there: this stop, plus anything else due within 20 minutes of riding (one stop, not two)
            const kinds = new Set([ev.kind]);
            let meal = ev.kind === "meal" ? ev.meal : null;
            let early = false;
            for (const c of cands.slice(1)) {
                // a meal a little early (up to 45 min of riding) rather than a break and then a meal soon after it
                if (c.kind === "meal" && ev.kind === "rest" && !meal && c.at - pos <= v * 45 * 60) { kinds.add("meal"); meal = c.meal; early = c.at - pos > v * 5 * 60; continue; }
                if (c.at - pos > v * 20 * 60) continue;
                if (c.kind === "fuel" && !kinds.has("fuel")) {
                    // fill here when a pump is within 3 km of this stop
                    const near = pumps.find((p) => Math.abs(p.sM - pos) <= 3000 && p.sM > s + 1000);
                    if (near) kinds.add("fuel");
                } else if (c.kind === "meal" && !meal) { kinds.add("meal"); meal = c.meal; }
                else if (c.kind === "rest") kinds.add("rest");
            }
            // a break due soon after a fuel stop: take it at the pump (one stop, not two)
            if (ev.kind === "fuel" && !kinds.has("rest") && !meal) {
                const r = cands.find((c) => c.kind === "rest");
                if (r && r.at - pos <= v * 45 * 60) kinds.add("rest");
            }
            const type = kinds.has("meal") ? "meal" : kinds.has("rest") ? "rest" : "fuel";
            const id = type === "meal" ? /** @type {any} */ (meal).meal : `${type}-${++n[type === "rest" ? "rest" : "fuel"]}`;

            // ride there
            const rodeS = (pos - s) / v;
            t += rodeS * 1000; since += rodeS; if (tank !== null) tank -= pos - s; s = pos;
            longest = Math.max(longest, since);

            if (removed.has(id)) {
                // the rider took this stop out: keep their choice, say what it means
                if (type === "meal") done.add(/** @type {any} */ (meal).meal);
                if (kinds.has("fuel")) { warnings.push({ level: "warning", text: "You removed a fuel stop: the plan no longer tracks your fuel. Make sure you fill up in time." }); tank = null; }
                if ((type === "rest" || type === "meal") && since >= restDue - 20 * 60) restDue = since + maxRideS;
                continue;
            }
            const reasons = [];
            if (kinds.has("rest") || type === "meal") reasons.push(`${fmtDur(since)} of riding since ${items.length > 1 ? "your last stop" : "you set off"} (your limit is ${fmtDur(maxRideS)}).`);
            if (meal) reasons.push(early ? `${meal.label} a little early (usual ${hhmm(meal.from)}–${hhmm(meal.to)}), so you stop once instead of twice.` : `${meal.label} time (${hhmm(meal.from)}–${hhmm(meal.to)}).`);
            if (kinds.has("fuel") && range !== null && tank !== null) reasons.push(onReserve ? `Fuel: your tank reaches its reserve around km ${Math.round(ev.at / 1000)}, with no mapped pump before it; this is the first one after, on reserve.` : `Fuel: your tank would reach its reserve (a fifth of a full tank) around km ${Math.round((pos + tank - reserve) / 1000)}${type === "fuel" ? "; this is the last mapped pump before that" : place && place.cat === "fuel" ? "" : "; a mapped pump within 3 km"}.`);
            if (place && place.riders && place.riders.up + place.riders.down >= 3) reasons.push(`Riders rated it 👍 ${place.riders.up} · 👎 ${place.riders.down}.`);
            else if (place) reasons.push(place.cat === "fuel" ? (type === "fuel" ? "A mapped fuel pump on the route." : "A mapped fuel pump: a place to pull over off the road.") : "The nearest mapped place; no rider ratings yet.");
            else reasons.push("No mapped place here: stop somewhere safe, off the road.");
            let mins = type === "meal" ? /** @type {any} */ (meal).min : type === "rest" ? restMin : DEFAULTS.fuelMin;
            if (kinds.has("fuel") && type !== "fuel") mins += 5;
            if (Number.isFinite(minutes[id])) mins = Math.max(5, Math.min(240, minutes[id]));
            const arriveAt = t;
            t += mins * MIN;
            items.push({ type, id, kinds: [...kinds], meal: meal ? meal.meal : null, label: meal ? meal.label : type === "rest" ? (kinds.has("fuel") ? "Break + fuel" : "Break") : "Fuel", sM: Math.round(pos), place, arriveAt, departAt: t, minutes: mins, reasons });
            if (meal) done.add(meal.meal);
            if (type === "meal" || type === "rest" || mins >= restMin) { since = 0; restDue = maxRideS; }
            if (kinds.has("fuel") && range !== null) tank = range;
        }
        const lastS = (D - s) / v;
        t += lastS * 1000; longest = Math.max(longest, since + lastS);
        items.push({ type: "end", id: "end", sM: Math.round(D), arriveAt: t, departAt: t, minutes: 0, reasons: [] });
        if (removed.size && longest > maxRideS + 300) warnings.push({ level: "advice", text: `With your changes, the longest stretch without a stop is ${fmtDur(longest)} (your limit is ${fmtDur(maxRideS)}).` });
        const stopS = items.reduce((a, x) => a + x.minutes * 60, 0);
        return {
            items, warnings, v,
            totals: {
                distanceM: D, rideS: Math.round(rideS), stopS, totalS: Math.round(rideS + stopS), departAt: o.departAt, arriveAt: t,
                // a range, not a promise: a little earlier at best, later with traffic and longer stops
                arriveRange: [Math.round(t - 0.05 * rideS * 1000), Math.round(t + (0.15 * rideS + 600) * 1000)],
                longestRideS: Math.round(longest),
                fuelL: o.fuel && o.fuel.kmPerL > 0 ? Math.round(D / 1000 / /** @type {number} */ (o.fuel.kmPerL) * 10) / 10 : null,
                stops: items.length - 2
            }
        };
    }

    /** Where the rider is at time `when`, by the plan (riding between stops, standing still at them). */
    function sAt(plan, when) {
        const it = plan.items;
        for (let i = 0; i < it.length - 1; i++) {
            const a = it[i], b = it[i + 1];
            if (when <= a.departAt) return a.sM;
            if (when < b.arriveAt) return a.sM + (when - a.departAt) / 1000 * plan.v;
        }
        return it[it.length - 1].sM;
    }

    /**
     * Advice from the plan: dark riding, the latest departure for daylight or for "arrive by", the way back,
     * the forecast and confirmed hazards. Pure.
     * @param {any} o the schedule's input, plus { end: [lat, lng], start: [lat, lng], arriveBy?: number, stayMin?: number|null,
     *   weather?: any[], hazards?: any[] }
     * @param {ReturnType<typeof schedule>} plan
     */
    function advise(o, plan) {
        const out = [], tz = Number.isFinite(o.tz) ? o.tz : 330, T = plan.totals;
        const now = Number.isFinite(o.now) ? o.now : 0;
        const line = o.line && o.line.length > 1 ? o.line : null;
        const posOn = posFn(line, o.end, T.distanceM);
        const end = o.end || posOn(T.distanceM), start = o.start || posOn(0);
        const darkMin = darkMinutes(plan, posOn);
        if (darkMin >= 10 && end) {
            const ss = sunset(end[0], end[1], T.arriveAt, tz);
            const latest = ss ? latestDeparture(o, ss - 15 * MIN) : null;
            const tooLong = latest !== null && start && isDark(start[0], start[1], latest);
            out.push({ level: "warning", text: `About ${fmtDur(darkMin * 60)} of riding in this plan is in the dark.${
                latest === null ? "" : tooLong ? " Even leaving at first light you'd arrive after dark: plan an overnight stop, or ride less of it today."
                    : latest > now ? ` Leave by ${clock(latest, tz)} to arrive in daylight, even with delays.` : " Arriving in daylight isn't possible any more today."}` });
        }
        if (Number.isFinite(o.arriveBy)) {
            const by = /** @type {number} */ (o.arriveBy);
            if (T.arriveRange[1] <= by) out.push({ level: "ok", text: `You should arrive by ${clock(by, tz)} even with delays (latest estimate ${clock(T.arriveRange[1], tz)}).` });
            else {
                const latest = latestDeparture(o, by);
                out.push({ level: "warning", text: `This plan's latest estimate is ${clock(T.arriveRange[1], tz)}. ${latest > now ? `To arrive by ${clock(by, tz)} allowing for delays, leave by ${clock(latest, tz)}.` : `Arriving by ${clock(by, tz)} with room for delays isn't possible from now: drop a stop or move your time.`}` });
            }
        }
        // the way back, after the stay
        if (Number.isFinite(o.stayMin) && /** @type {number} */ (o.stayMin) > 0 && start) {
            const bo = { ...o, departAt: T.arriveAt + /** @type {number} */ (o.stayMin) * MIN, edits: {}, places: mirror(o.places, T.distanceM), line: line ? line.slice().reverse() : undefined, fuel: o.fuel ? { ...o.fuel, startShare: 1 } : undefined };
            const back = schedule(bo), B = back.totals;
            const backDark = darkMinutes(back, posFn(bo.line || null, start, B.distanceM));
            const ss = sunset(start[0], start[1], B.departAt, tz);
            const latest = ss ? latestDeparture(bo, ss - 15 * MIN) : null;
            const canDay = latest !== null && latest >= T.arriveAt + 30 * MIN && !isDark(end[0], end[1], latest);
            out.push({ level: backDark >= 10 ? "warning" : "ok", text: `Way back: leaving at ${clock(B.departAt, tz)} after ${fmtDur(/** @type {number} */ (o.stayMin) * 60)} there, you'd be home around ${clock(B.arriveAt, tz)}${dayDiff(B.departAt, B.arriveAt, tz)} (${B.stops} stop${B.stops === 1 ? "" : "s"}${backDark >= 10 ? `, about ${fmtDur(backDark * 60)} of it in the dark` : ""}).${
                backDark < 10 ? "" : canDay ? ` To be home in daylight, start back by ${clock(/** @type {number} */ (latest), tz)}.` : " Getting home in daylight the same day isn't possible: consider staying the night."}` });
        }
        if (T.longestRideS > 3 * 3600) out.push({ level: "advice", text: `The longest stretch without a stop is ${fmtDur(T.longestRideS)}. Tiredness builds slowly: take a short break anyway.` });
        for (const w of (o.weather || []).filter((x) => x.available && x.hazards && x.hazards.some((h) => h.level === "warning")).slice(0, 3)) {
            out.push({ level: "warning", text: `Forecast near km ${Math.round(w.sM / 1000)}: ${w.hazards.filter((h) => h.level === "warning").map((h) => h.type.replace("-", " ")).join(", ")} around ${clock(w.hourAt || w.at, tz)}. By this plan you'd be there around ${clock(planTimeAt(plan, w.sM), tz)}.` });
        }
        const conf = (o.hazards || []).filter((z) => z.status === "community_confirmed");
        if (conf.length) out.push({ level: "advice", text: `Riders confirmed ${conf.length} road hazard${conf.length === 1 ? "" : "s"}: ${conf.slice(0, 4).map((z) => `${String(z.type).replace(/_/g, " ")} at km ${Math.round(z.sM / 1000)}`).join(", ")}${conf.length > 4 ? ", …" : ""}.` });
        return out.concat(plan.warnings);
    }
    /** Where the rider is at s metres along the route (on the drawn line, scaled to the router's distance). */
    function posFn(line, fallback, D) {
        if (!line) return () => fallback || null;
        const cum = cumulative(line), k = cum[cum.length - 1] / Math.max(1, D);
        return (s) => pointAt(line, cum, s * k);
    }
    /** Minutes of riding in the dark (stops not counted), in 5-minute steps. */
    function darkMinutes(plan, posOn) {
        let n = 0;
        const T = plan.totals;
        for (let w = T.departAt; w < T.arriveAt; w += 5 * MIN) {
            if (plan.items.some((x) => x.minutes > 0 && w >= x.arriveAt && w < x.departAt)) continue;
            const p = posOn(sAt(plan, w));
            if (p && isDark(p[0], p[1], w)) n += 5;
        }
        return n;
    }
    /** The latest departure whose late arrival estimate is at `target` (meal times move with it, so a few rounds). */
    function latestDeparture(o, target) {
        let dep = o.departAt;
        for (let i = 0; i < 5; i++) {
            const late = schedule({ ...o, departAt: dep }).totals.arriveRange[1];
            if (Math.abs(late - target) < MIN) break;
            dep += target - late;
        }
        return Math.floor(dep / (5 * MIN)) * 5 * MIN;
    }
    const dayDiff = (a, b, tz) => { const d = Math.floor((b + tz * MIN) / 86400000) - Math.floor((a + tz * MIN) / 86400000); return d > 0 ? (d === 1 ? " the next day" : ` ${d} days later`) : ""; };
    /** Places as seen from the other end (for the way back). */
    function mirror(places, D) {
        const flip = (l) => (l || []).map((p) => ({ ...p, sM: Math.round(D - p.sM) })).sort((a, b) => a.sM - b.sM);
        return places ? { food: flip(places.food), fuel: flip(places.fuel) } : places;
    }
    /** When the plan reaches s (m). */
    function planTimeAt(plan, s) {
        const it = plan.items;
        for (let i = 0; i < it.length - 1; i++) {
            const a = it[i], b = it[i + 1];
            if (s <= a.sM) return a.arriveAt;
            if (s < b.sM) return a.departAt + (s - a.sM) / plan.v * 1000;
        }
        return it[it.length - 1].arriveAt;
    }
    /**
     * During the ride: the next stop and how far ahead of / behind the plan the rider is. Pure.
     * @param {ReturnType<typeof schedule>} plan @param {number} s metres along the route @param {number} now
     */
    function progress(plan, s, now) {
        const next = plan.items.find((x) => x.type !== "start" && x.sM > s + 200) || null;
        return { next, distanceM: next ? next.sM - s : 0, behindMin: Math.round((now - planTimeAt(plan, s)) / MIN) };
    }

    function fmtDur(sec) { const m = Math.round(sec / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`; }
    function hhmm(h) { const hh = Math.floor(h), mm = Math.round((h - hh) * 60); const d = new Date(Date.UTC(2026, 0, 1, hh, mm)); return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }); }
    function clock(t, tz) { return new Date(t + tz * MIN).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }); }

    return { DEFAULTS, schedule, advise, progress, planTimeAt, ridingSeconds, sunset, elevationDeg, localHours, fmtDur, clock, mirror };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).HyperVisionCore = HyperVisionCore;
if (typeof module === "object" && module.exports) module.exports = { HyperVisionCore };
