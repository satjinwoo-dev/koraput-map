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

   HyperVisionCore.schedule(o) → { items, totals, warnings }   (o.pinned: the rider's own stops; o.auto: false → only theirs)
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

    /** The sunrise (elevation crossing 0, going up) on the local day of `t`, or null (polar). */
    function sunrise(lat, lng, t, tz) {
        const day0 = Math.floor((t + tz * MIN) / 86400000) * 86400000 - tz * MIN;
        let lo = day0 + 0.1 * H, hi = day0 + 12 * H;
        if (elevationDeg(lat, lng, lo) > 0 || elevationDeg(lat, lng, hi) < 0) return null;
        for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (elevationDeg(lat, lng, m) < 0) lo = m; else hi = m; }
        return Math.round(hi / MIN) * MIN;
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

    /** "Break", "Lunch", "Break + fuel", "Lunch + fuel"… from what happens at a stop. */
    function labelOf(kinds, meal) {
        const k = new Set(kinds);
        const base = k.has("meal") ? (meal ? (DEFAULTS.meals.find((m) => m.meal === meal) || { label: "Meal" }).label : "Meal") : k.has("rest") ? "Break" : k.has("fuel") ? "Fuel" : "Stop";
        return k.has("fuel") && base !== "Fuel" ? `${base} + fuel` : base;
    }
    /** Which meal a stop at time t is (in a window, or up to an hour before one), or null. */
    function mealAt(t, tz) {
        const h = localHours(t, tz);
        const m = DEFAULTS.meals.find((x) => h >= x.from - 1 && h < x.to + 0.5);
        return m ? m.meal : null;
    }

    /**
     * The schedule. Pure.
     * MapUnite's plan by default. With `pinned`, the rider's own stops are kept exactly where and as long as they
     * set them; with `auto: false` nothing is added (their plan, timed and checked); with `auto` (the default)
     * MapUnite fills the gaps around them ("Fill the gaps for me").
     * @param {{ departAt: number, distanceM: number, routeS: number, cruiseKmh?: number|null, maxRideMin?: number, tz?: number,
     *   line?: number[][], places?: { food?: any[], fuel?: any[] },
     *   fuel?: { rangeKm?: number|null, startShare?: number|null, kmPerL?: number|null },
     *   pinned?: Array<{ id: string, sM: number, kinds: string[], minutes: number, meal?: string|null, place?: any, note?: string }>,
     *   auto?: boolean, restMin?: number }} o
     */
    function schedule(o) {
        const D = Math.max(1, o.distanceM), tz = Number.isFinite(o.tz) ? o.tz : 330;
        const rideS = ridingSeconds(D, o.routeS, o.cruiseKmh || null);
        const v = D / rideS;                                       // m/s, the rider's average
        const maxRideS = Math.max(30, Math.min(300, o.maxRideMin || 120)) * 60;
        const restMin = o.restMin || DEFAULTS.restMin, auto = o.auto !== false;
        const pins = (o.pinned || []).filter((p) => p && p.sM > 0 && p.sM < D).slice().sort((a, b) => a.sM - b.sM);
        const food = (o.places && o.places.food) || [], pumps = (o.places && o.places.fuel) || [];
        const range = o.fuel && o.fuel.rangeKm > 0 ? o.fuel.rangeKm * 1000 : null;
        let tank = range !== null ? range * Math.max(0, Math.min(1, o.fuel && Number.isFinite(o.fuel.startShare) ? /** @type {number} */ (o.fuel.startShare) : 1)) : null;
        const reserve = range !== null ? range * DEFAULTS.reserveShare : 0;

        let s = 0, t = o.departAt, since = 0, longest = 0, pi = 0, lastStopS = 0, n = { rest: 0, fuel: 0 };
        const done = new Set(), warnings = [], items = [{ type: "start", id: "start", sM: 0, arriveAt: o.departAt, departAt: o.departAt, minutes: 0, reasons: [] }];
        const endRideS = 20 * 60;                                  // no stop in the last 20 minutes of riding
        const fromText = (x) => (x < 1000 ? "the start" : `km ${Math.round(x / 1000)}`);
        let reserveWarned = false, afterPin = false;
        // the rider's own meal stops cover their meal (MapUnite doesn't add another breakfast before theirs)
        for (const p of pins) if (p.kinds && p.kinds.includes("meal")) { const m = p.meal || mealAt(o.departAt + p.sM / v * 1000, tz); if (m) done.add(m); }
        /** Ride on to x: time, tiredness, fuel (with a warning when the tank would reach reserve or run dry first). */
        function rideTo(x) {
            const d = x - s, rode = d / v;
            if (tank !== null && range !== null) {
                if (tank - d < 0) { warnings.push({ level: "warning", text: `Fuel: you'd run out around km ${Math.round((s + tank) / 1000)}, before ${x >= D - 1 ? "you arrive" : "your next fuel stop"}. Add a fuel stop before then.` }); tank = null; }
                else if (tank - d < reserve && !reserveWarned) { reserveWarned = true; warnings.push({ level: "warning", text: `Fuel: you'd be on reserve from around km ${Math.round((s + tank - reserve) / 1000)}, before ${x >= D - 1 ? "you arrive" : "your next fuel stop"}.` }); }
                if (tank !== null) tank -= d;
            }
            t += rode * 1000; since += rode; s = x;
            if (since > maxRideS + 5 * 60) {
                if (!auto) warnings.push({ level: "advice", text: `From ${fromText(lastStopS)} to ${x >= D - 1 ? "the destination" : `km ${Math.round(x / 1000)}`}: ${fmtDur(since)} without a stop (your limit is ${fmtDur(maxRideS)}).` });
            }
            longest = Math.max(longest, since);
        }

        for (let guard = 0; guard < 60 && s < D - 1; guard++) {
            const cands = [];
            if (auto) {
                // a break: when the riding since the last stop reaches the rider's limit
                const restAt = s + v * (maxRideS - since);
                if (restAt < D - v * endRideS) cands.push({ kind: "rest", at: Math.max(s + 1, restAt) });
                // meals: the first meal window the ride is in, at its start (or 30 min after leaving, when leaving inside it)
                for (const m of DEFAULTS.meals) {
                    if (done.has(m.meal)) continue;
                    for (let d = 0; d < 3; d++) {
                        const day0 = Math.floor((o.departAt + tz * MIN) / 86400000) * 86400000 - tz * MIN + d * 86400000;
                        const from = day0 + m.from * H, to = day0 + m.to * H;
                        // (not straight after the rider's own stop: half an hour of riding first)
                        const when = Math.max(from, o.departAt + 30 * MIN, t + (afterPin ? 30 * MIN : 0));
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
                cands.sort((a, b) => a.at - b.at);
            }
            const pin = pins[pi];
            // the rider's own stop comes first when it's before (or within 20 min of riding after) MapUnite's next one
            if (pin && (!cands.length || pin.sM <= cands[0].at + v * 20 * 60)) {
                pi++;
                rideTo(pin.sM);
                const kinds = new Set(pin.kinds && pin.kinds.length ? pin.kinds : ["rest"]);
                const meal = kinds.has("meal") ? pin.meal || mealAt(t, tz) : null;
                const reasons = ["Your stop."];
                if (pin.note) reasons.push(`Your note: ${pin.note}`);
                if (since > 0) reasons.push(`${fmtDur(since)} of riding since ${items.length > 1 ? "your last stop" : "you set off"} (your limit is ${fmtDur(maxRideS)}).`);
                if (kinds.has("fuel") && !(pin.place && pin.place.cat === "fuel") && !pumps.some((p) => Math.abs(p.sM - pin.sM) <= 1500)) reasons.push("No mapped fuel pump here: make sure there is one.");
                const mins = Math.max(5, Math.min(240, Math.round(pin.minutes || restMin)));
                const arriveAt = t;
                t += mins * MIN;
                items.push({ type: kinds.has("meal") ? "meal" : kinds.has("rest") ? "rest" : kinds.has("fuel") ? "fuel" : "rest", id: pin.id, mine: true, kinds: [...kinds], meal, label: labelOf([...kinds], meal), note: pin.note || "", sM: Math.round(pin.sM), place: pin.place || null, arriveAt, departAt: t, minutes: mins, reasons });
                if (meal) done.add(meal);
                if (kinds.has("meal") || kinds.has("rest") || mins >= restMin) { since = 0; lastStopS = s; }
                if (kinds.has("fuel") && range !== null) { tank = range; reserveWarned = false; }
                afterPin = true;
                continue;
            }
            if (!cands.length) break;
            const ev = cands[0];
            const stopBefore = pin ? pin.sM - 1000 : D - 1;        // MapUnite's stops stay before the rider's next one

            // where: a real place near the moment it's due
            let place = null, pos = ev.at, onReserve = false;
            if (ev.kind === "fuel") {
                const ok = pumps.filter((p) => p.sM > s + 1000 && p.sM <= ev.at).sort((a, b) => b.sM - a.sM);
                place = ok[0] || null;
                const from = s < 1000 ? "you set off" : `km ${Math.round(s / 1000)}`;
                if (!place && tank !== null) {
                    // none before the reserve: the first pump the reserve still reaches, said plainly
                    const after = pumps.filter((p) => p.sM > ev.at && p.sM < s + /** @type {number} */ (tank) - 0.05 * /** @type {number} */ (range)).sort((a, b) => a.sM - b.sM)[0];
                    if (after) { place = after; onReserve = true; reserveWarned = true; warnings.push({ level: "warning", text: `No mapped fuel pump between ${from} and km ${Math.round(ev.at / 1000)}, where your tank reaches its reserve: you'd ride on reserve to km ${Math.round(after.sM / 1000)}. Better: fill up before ${s < 1000 ? "you set off" : from}.` }); }
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
            if (pos > stopBefore) { place = null; pos = Math.max(s + 1, stopBefore); }
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

            rideTo(pos);
            afterPin = false;
            const reasons = [];
            if (kinds.has("rest") || type === "meal") reasons.push(`${fmtDur(since)} of riding since ${items.length > 1 ? "your last stop" : "you set off"} (your limit is ${fmtDur(maxRideS)}).`);
            if (meal) reasons.push(early ? `${meal.label} a little early (usual ${hhmm(meal.from)}–${hhmm(meal.to)}), so you stop once instead of twice.` : `${meal.label} time (${hhmm(meal.from)}–${hhmm(meal.to)}).`);
            if (kinds.has("fuel") && range !== null && tank !== null) reasons.push(onReserve ? `Fuel: your tank reaches its reserve around km ${Math.round(ev.at / 1000)}, with no mapped pump before it; this is the first one after, on reserve.` : `Fuel: your tank would reach its reserve (a fifth of a full tank) around km ${Math.round((pos + tank - reserve) / 1000)}${type === "fuel" ? "; this is the last mapped pump before that" : place && place.cat === "fuel" ? "" : "; a mapped pump within 3 km"}.`);
            if (place && place.riders && place.riders.up + place.riders.down >= 3) reasons.push(`Riders rated it 👍 ${place.riders.up} · 👎 ${place.riders.down}.`);
            else if (place) reasons.push(place.cat === "fuel" ? (type === "fuel" ? "A mapped fuel pump on the route." : "A mapped fuel pump: a place to pull over off the road.") : "The nearest mapped place; no rider ratings yet.");
            else reasons.push("No mapped place here: stop somewhere safe, off the road.");
            let mins = type === "meal" ? /** @type {any} */ (meal).min : type === "rest" ? restMin : DEFAULTS.fuelMin;
            if (kinds.has("fuel") && type !== "fuel") mins += 5;
            const arriveAt = t;
            t += mins * MIN;
            items.push({ type, id, mine: false, kinds: [...kinds], meal: meal ? meal.meal : null, label: labelOf([...kinds], meal ? meal.meal : null), note: "", sM: Math.round(pos), place, arriveAt, departAt: t, minutes: mins, reasons });
            if (meal) done.add(meal.meal);
            if (type === "meal" || type === "rest" || mins >= restMin) { since = 0; lastStopS = s; }
            if (kinds.has("fuel") && range !== null) { tank = range; reserveWarned = false; }
        }
        rideTo(D);
        items.push({ type: "end", id: "end", sM: Math.round(D), arriveAt: t, departAt: t, minutes: 0, reasons: [] });
        // a meal time spent riding, with no meal stop (the rider's plan, or one MapUnite couldn't fit)
        for (const m of DEFAULTS.meals) {
            if (done.has(m.meal)) continue;
            for (let d = 0; d < 3; d++) {
                const day0 = Math.floor((o.departAt + tz * MIN) / 86400000) * 86400000 - tz * MIN + d * 86400000;
                const a = Math.max(day0 + m.from * H, o.departAt + 30 * MIN), b = Math.min(day0 + m.to * H, t - 20 * MIN);
                if (b - a >= 45 * MIN) { warnings.push({ level: "advice", text: `No ${m.label.toLowerCase()} stop: you'd be riding through ${m.label.toLowerCase()} time (${hhmm(m.from)}–${hhmm(m.to)}).` }); break; }
            }
        }
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
        const ref = now || T.departAt;
        const darkMin = darkMinutes(plan, posOn);
        if (darkMin >= 10 && end && start) {
            // the daylight window: leave after first light, early enough to arrive before sunset even with delays
            let w = daylight(o, start, end, tz);
            if (w && w.latest !== null && w.latest <= now) w = daylight({ ...o, departAt: o.departAt + 86400000 }, start, end, tz);
            out.push({ level: "warning", text: `About ${fmtDur(darkMin * 60)} of riding in this plan is in the dark.${
                !w ? "" : w.latest === null ? " It's longer than one day's daylight: plan an overnight stop, or ride part of it in the dark with extra care."
                    : ` To ride it all in daylight, leave between ${between(w.earliest, w.latest, ref, tz)}.`}` });
        }
        if (Number.isFinite(o.arriveBy)) {
            const by = /** @type {number} */ (o.arriveBy);
            if (T.arriveRange[1] <= by) out.push({ level: "ok", text: `You should arrive by ${clock(by, tz)} even with delays (latest estimate ${clock(T.arriveRange[1], tz)}).` });
            else {
                const latest = latestDeparture(o, by);
                out.push({ level: "warning", text: `This plan's latest estimate is ${clock(T.arriveRange[1], tz)}. ${latest > now ? `To arrive by ${clock(by, tz)} allowing for delays, leave by ${clock(latest, tz)}.` : `Arriving by ${clock(by, tz)} with room for delays isn't possible from now: drop a stop or move your time.`}` });
            }
        }
        // the way back, after the stay (MapUnite's plan for it: the rider's stops are for the way there)
        if (Number.isFinite(o.stayMin) && /** @type {number} */ (o.stayMin) > 0 && start && end) {
            const bo = { ...o, departAt: T.arriveAt + /** @type {number} */ (o.stayMin) * MIN, pinned: undefined, auto: true, places: mirror(o.places, T.distanceM), line: line ? line.slice().reverse() : undefined, fuel: o.fuel ? { ...o.fuel, startShare: 1 } : undefined };
            const back = schedule(bo), B = back.totals;
            const backDark = darkMinutes(back, posFn(bo.line || null, start, B.distanceM));
            let tip = "";
            if (backDark >= 10) {
                // start back after first light (and not before arriving + 30 min), early enough to be home before sunset
                let w = daylight(bo, end, start, tz), nextDay = false;
                if (w && w.latest !== null && w.latest < T.arriveAt + 30 * MIN) { w = daylight({ ...bo, departAt: bo.departAt + 86400000 }, end, start, tz); nextDay = true; }
                const from = w ? Math.max(w.earliest, Math.ceil((T.arriveAt + 30 * MIN) / (5 * MIN)) * 5 * MIN) : 0;
                tip = !(w && w.latest !== null && from <= w.latest) ? " Riding back in daylight doesn't fit: consider staying the night."
                    : nextDay ? ` Riding back in daylight the same day doesn't fit: stay the night and start back between ${between(from, w.latest, ref, tz)}.`
                    : ` To ride back in daylight, start back between ${between(from, w.latest, ref, tz)}.`;
            }
            out.push({ level: backDark >= 10 ? "warning" : "ok", text: `Way back: leaving at ${when(B.departAt, ref, tz)}, after ${fmtDur(/** @type {number} */ (o.stayMin) * 60)} there, you'd be home around ${when(B.arriveAt, ref, tz)} (${B.stops} stop${B.stops === 1 ? "" : "s"}${backDark >= 10 ? `, about ${fmtDur(backDark * 60)} of it in the dark` : ""}).${tip}` });
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
    /**
     * Day and dark along the plan, for drawing: pieces of the route ridden in daylight or in the dark, and for each
     * riding leg (stop to stop) the share of it in the dark. Pure.
     * @param {any} o the schedule's input (line, end) @param {ReturnType<typeof schedule>} plan
     */
    function light(o, plan) {
        const T = plan.totals, posOn = posFn(o.line && o.line.length > 1 ? o.line : null, o.end, T.distanceM);
        const pieces = [], legs = [];
        for (let i = 0; i < plan.items.length - 1; i++) {
            const a = plan.items[i], b = plan.items[i + 1], span = b.arriveAt - a.departAt;
            const steps = Math.max(1, Math.ceil(span / (5 * MIN)));
            let dark = 0;
            for (let k = 0; k < steps; k++) {
                const w = a.departAt + (k + 0.5) * span / steps, sx = a.sM + (b.sM - a.sM) * (k + 0.5) / steps, p = posOn(sx);
                const d = Boolean(p && isDark(p[0], p[1], w));
                if (d) dark++;
                const from = a.sM + (b.sM - a.sM) * k / steps, to = a.sM + (b.sM - a.sM) * (k + 1) / steps, last = pieces[pieces.length - 1];
                if (last && last.dark === d) last.b = to; else pieces.push({ a: from, b: to, dark: d });
            }
            legs.push({ from: a.sM, to: b.sM, rideS: Math.round(span / 1000), darkShare: dark / steps });
        }
        return { pieces, legs };
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
    /**
     * The departures that ride all in daylight on the ride's day (the next day when it leaves after sunset):
     * from 10 min after sunrise at the start, to the latest whose late arrival estimate is 15 min before sunset at the end.
     * latest null: the ride is longer than the day's daylight.
     */
    function daylight(o, start, end, tz) {
        let day = o.departAt;
        const ss0 = sunset(start[0], start[1], day, tz);
        if (ss0 && o.departAt > ss0) day += 86400000;
        const sr = sunrise(start[0], start[1], day, tz), ss = sunset(end[0], end[1], day, tz);
        if (!sr || !ss) return null;
        const earliest = Math.ceil((sr + 10 * MIN) / (5 * MIN)) * 5 * MIN;
        const latest = latestDeparture({ ...o, departAt: earliest }, ss - 15 * MIN);
        return { earliest, latest: latest >= earliest ? latest : null };
    }
    const dayNo = (t, tz) => Math.floor((t + tz * MIN) / 86400000);
    /** "10:45 am", "10:45 am tomorrow", "10:45 am on Mon" (from `ref`'s day). */
    function when(t, ref, tz) { const d = dayNo(t, tz) - dayNo(ref, tz); return d === 0 ? clock(t, tz) : `${clock(t, tz)} ${d === 1 ? "tomorrow" : `on ${dayWord(t, d, tz)}`}`; }
    function dayWord(t, d, tz) { return d === 1 ? "tomorrow" : new Date(t + tz * MIN).toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" }); }
    /** "6:05 am and 10:45 am tomorrow" (one day word when both are on the same day). */
    function between(a, b, ref, tz) {
        const da = dayNo(a, tz) - dayNo(ref, tz);
        if (dayNo(a, tz) !== dayNo(b, tz)) return `${when(a, ref, tz)} and ${when(b, ref, tz)}`;
        return `${clock(a, tz)} and ${clock(b, tz)}${da === 0 ? "" : da === 1 ? " tomorrow" : ` on ${dayWord(a, da, tz)}`}`;
    }
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

    return { DEFAULTS, schedule, advise, progress, planTimeAt, ridingSeconds, sunset, sunrise, daylight, light, elevationDeg, localHours, fmtDur, clock, when, labelOf, mealAt, mirror };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).HyperVisionCore = HyperVisionCore;
if (typeof module === "object" && module.exports) module.exports = { HyperVisionCore };
