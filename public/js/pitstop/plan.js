// @ts-check
/* ============================================================================
   MapUnite pitstops — who needs fuel or charge first, and where the group stops
   ==============================================================================
   Pure, strict SI: route positions in m, energy in m³ (petrol) or J (battery),
   energy per metre in m³/m or J/m. No DOM, no network.

     cumulative(perMetre, ds, scale)  a rider's energy used from the route start
                                      to every route sample (from their own bike's
                                      per-segment cost, MUTrip.energy)
     reach(s, C, from, budget)        how far a budget gets them from `from`
     planConvoy(input, opts)          every rider's status and the communal stops

   The plan, in words:
     1. Each rider's budget is what's in their tank or battery now, minus a
        reserve (12 % of a tank, 10 % of a battery) that we never plan into.
     2. If anyone can't reach the destination, the most urgent deadline D is the
        earliest point where somebody would hit their reserve.
     3. The group stops at the LAST suitable station before D (stopping later
        means fewer stops), preferring one that serves everyone who's short
        (petrol and charging); a pump and a charger within 3 km of each other
        count as one stop. Stations closer than 3 km to the previous stop are
        skipped. A rider already on reserve gets the nearest station ahead.
     4. At the stop, every rider of that kind who still couldn't reach the
        destination refuels: a full tank, or a battery to 80 %. Riders with
        enough just wait (or top up — their choice).
     5. Repeat from that stop until everyone reaches the destination.
     6. No station data (offline, or none mapped)? The stop becomes a stretch of
        road ("refuel between km 120 and 135") and says so.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUPitstop || (/** @type {any} */ (root).MUPitstop = {}); ns.plan = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const PLAN_DEFAULTS = Object.freeze({
        reserveFuel: 0.12,        // share of the tank kept as reserve
        reserveEv: 0.10,          // share of the battery
        chargeTo: 0.8,            // EVs charge to 80 % at a stop (the fast part of the curve)
        chargerPower: 3000,       // W: a portable / AC charger, the common case for two-wheelers (labelled in the UI)
        fuelStopS: 6 * 60,        // s for a fuel stop, plus …
        fuelPerRiderS: 90,        // … per rider who fills
        minGap: 3000,             // m between stops
        pairWithin: 3000,         // m: a pump and a charger this close count as ONE stop for the group
        zone: 15000,              // m: length of a "refuel somewhere here" stretch when there's no station
        urgentLook: 25000,        // m ahead to look for a station when someone is already on reserve
        soon: 40000,              // m: "needs fuel soon"
        tight: 0.15,              // arriving with less than this above the reserve = "tight"
        maxStops: 8
    });

    /**
     * Energy used from the route start to every sample.
     * @param {ArrayLike<number>} perMetre  per segment (n − 1)  @param {ArrayLike<number>} ds  per segment
     * @param {number} [scale]  e.g. total ÷ cruise, to fold stops and idling in evenly
     * @returns {Float64Array} length n
     */
    function cumulative(perMetre, ds, scale = 1) {
        const n = ds.length + 1, C = new Float64Array(n);
        for (let i = 0; i < ds.length; i++) C[i + 1] = C[i] + perMetre[i] * ds[i] * scale;
        return C;
    }

    /** C at position x (linear between samples; clamped to the route). @param {ArrayLike<number>} s @param {ArrayLike<number>} C @param {number} x */
    function at(s, C, x) {
        const n = s.length;
        if (x <= s[0]) return C[0];
        if (x >= s[n - 1]) return C[n - 1];
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= x) lo = m; else hi = m; }
        const w = (x - s[lo]) / (s[hi] - s[lo] || 1);
        return C[lo] + (C[hi] - C[lo]) * w;
    }

    /**
     * How far `budget` gets a rider from position `from`: the first point where the energy used
     * since `from` exceeds the budget (energy can go DOWN on an EV descent; the first crossing counts).
     * @param {ArrayLike<number>} s @param {ArrayLike<number>} C @param {number} from @param {number} budget
     * @returns {{ s: number, ok: boolean }}  ok: reaches the end of the route
     */
    function reach(s, C, from, budget) {
        const n = s.length, end = s[n - 1];
        if (budget < 0) return { s: Math.max(s[0], Math.min(end, from)), ok: false };
        const c0 = at(s, C, from), target = c0 + budget;
        let k = 0;
        while (k < n && s[k] <= from) k++;
        let prevS = from, prevC = c0;
        for (; k < n; k++) {
            if (C[k] > target) {
                const w = (target - prevC) / (C[k] - prevC || 1);
                return { s: prevS + (s[k] - prevS) * Math.min(1, Math.max(0, w)), ok: false };
            }
            prevS = s[k]; prevC = C[k];
        }
        return { s: end, ok: true };
    }

    /**
     * @typedef {{ id: string, kind: "fuel"|"ev", startS: number, joinCost?: number, energy: number, capacity: number, C: Float64Array }} PlanMember
     *   startS: where the rider joins the route (m); joinCost: energy to get there from where they are now.
     * @typedef {{ id: string, s: number, kinds: string[], name?: string, lat?: number, lng?: number, offRoute?: number }} Station
     * @typedef {{ id: string, kind: string, energyAdded: number, waitS: number }} StopRider
     * @typedef {{ s: number, station: Station|null, partner?: Station|null, window: [number, number], kinds: string[], riders: StopRider[], waiting: string[],
     *   noStation: boolean, urgent: boolean, waitS: number }} Stop
     * @typedef {{ id: string, kind: string, status: "reserve"|"soon"|"stop"|"tight"|"ok", share: number, reachS: number, reachesEnd: boolean,
     *   needBy: number|null, needIn: number|null, arriveShare: number, energyToEnd: number, rank: number, stops: number }} MemberResult
     */

    /**
     * @param {{ s: ArrayLike<number>, members: PlanMember[], stations?: Station[] }} input
     * @param {Partial<typeof PLAN_DEFAULTS>} [opts]
     * @returns {{ members: MemberResult[], stops: Stop[], end: number, complete: boolean, extraS: number }}
     */
    function planConvoy(input, opts = {}) {
        const O = { ...PLAN_DEFAULTS, ...opts };
        const S = input.s, n = S.length;
        if (n < 2) throw new Error("planConvoy needs a route with at least two samples");
        const end = S[n - 1];
        const stations = (input.stations || []).filter((x) => Number.isFinite(x.s) && x.s >= 0 && x.s <= end).slice().sort((a, b) => a.s - b.s);
        const reserveOf = (m) => m.capacity * (m.kind === "ev" ? O.reserveEv : O.reserveFuel);

        // ---- each rider without stopping ----
        const results = input.members.map((m) => {
            const e0 = m.energy - (m.joinCost || 0);
            const start = Math.min(end, Math.max(0, m.startS));
            const toEnd = at(S, m.C, end) - at(S, m.C, start) + (m.joinCost || 0);
            const r = reach(S, m.C, start, e0 - reserveOf(m));
            const share = m.capacity > 0 ? m.energy / m.capacity : 0;
            const arriveShare = m.capacity > 0 ? (m.energy - toEnd) / m.capacity : 0;
            const reserveShare = m.kind === "ev" ? O.reserveEv : O.reserveFuel;
            /** @type {MemberResult["status"]} */
            let status;
            if (share <= reserveShare + 1e-9) status = "reserve";
            else if (!r.ok && r.s - start < O.soon) status = "soon";
            else if (!r.ok) status = "stop";
            else if (arriveShare < reserveShare + O.tight) status = "tight";
            else status = "ok";
            return { id: m.id, kind: m.kind, status, share, reachS: r.s, reachesEnd: r.ok, needBy: r.ok ? null : r.s, needIn: r.ok ? null : r.s - start, arriveShare, energyToEnd: toEnd, rank: 0, stops: 0 };
        });
        const order = { reserve: 0, soon: 1, stop: 2, tight: 3, ok: 4 };
        const ranked = results.slice().sort((a, b) => order[a.status] - order[b.status]
            || (a.needIn !== null && b.needIn !== null ? a.needIn - b.needIn : 0)
            || a.arriveShare - b.arriveShare);
        ranked.forEach((r, i) => { r.rank = i + 1; });

        // ---- communal stops ----
        const st = input.members.map((m) => ({ m, pos: Math.min(end, Math.max(0, m.startS)), e: m.energy - (m.joinCost || 0) }));
        /** @type {Stop[]} */ const stops = [];
        let cursor = 0, complete = true, guard = 0;
        while (guard++ < O.maxStops) {
            const need = st.map((x) => ({ x, r: reach(S, x.m.C, x.pos, x.e - reserveOf(x.m)) })).filter((y) => !y.r.ok);
            if (!need.length) break;
            need.sort((a, b) => a.r.s - b.r.s);
            const urgentOne = need[0];
            const D = urgentOne.r.s;
            const kindsShort = [...new Set(need.map((y) => y.x.m.kind))];
            const from = cursor + (stops.length ? O.minGap : 0);
            const serves = (stn, kinds) => kinds.every((k) => stn.kinds.includes(k));
            let pick = null, urgent = false;
            if (D - from < O.minGap || D <= urgentOne.x.pos + 1) {
                // already at (or nearly at) reserve: the nearest suitable station ahead
                urgent = true;
                pick = stations.find((x) => x.s >= Math.max(from, urgentOne.x.pos) && x.s <= Math.max(from, urgentOne.x.pos) + O.urgentLook && x.kinds.includes(urgentOne.x.m.kind)) || null;
            } else {
                const window = stations.filter((x) => x.s > from && x.s <= D);
                pick = [...window].reverse().find((x) => serves(x, kindsShort)) || [...window].reverse().find((x) => x.kinds.includes(urgentOne.x.m.kind)) || null;
            }
            const stopS = pick ? pick.s : Math.max(from, Math.min(D, end));
            // the station doesn't serve everyone who's short? a partner station of the missing kind
            // within a short ride makes it one group stop (the pump next to the charger)
            let partner = null;
            if (pick) {
                const missing = kindsShort.filter((k) => !pick.kinds.includes(k));
                if (missing.length) {
                    const due = Math.min(...need.filter((y) => missing.includes(y.x.m.kind)).map((y) => y.r.s));
                    partner = stations.find((x) => x !== pick && x.s > cursor && x.s <= due && Math.abs(x.s - pick.s) <= O.pairWithin && missing.every((k) => x.kinds.includes(k))) || null;
                }
            }
            // a station serves the kinds it has; a stretch of road with no station is planned for the
            // most urgent rider's kind only (riders of the other kind may still have a real station ahead)
            const kinds = pick ? kindsShort.filter((k) => pick.kinds.includes(k) || (partner !== null && partner.kinds.includes(k))) : [urgentOne.x.m.kind];
            /** @type {StopRider[]} */ const riders = [];
            /** @type {string[]} */ const waiting = [];
            for (const x of st) {
                if (x.pos > stopS + 1) continue;                                      // already past this point
                x.e -= at(S, x.m.C, stopS) - at(S, x.m.C, x.pos);
                x.pos = stopS;
                const ok = reach(S, x.m.C, stopS, x.e - reserveOf(x.m)).ok;
                if (!ok && kinds.includes(x.m.kind)) {
                    const target = x.m.kind === "ev" ? Math.max(x.e, O.chargeTo * x.m.capacity) : x.m.capacity;
                    const added = Math.max(0, target - x.e);
                    const waitS = x.m.kind === "ev" ? added / O.chargerPower : O.fuelPerRiderS;
                    x.e = target;
                    riders.push({ id: x.m.id, kind: x.m.kind, energyAdded: added, waitS });
                } else waiting.push(x.m.id);
            }
            if (!riders.length) { complete = false; break; }                        // nobody can be helped here: stop planning
            const fuelers = riders.filter((r) => r.kind === "fuel").length;
            const waitS = Math.max(fuelers ? O.fuelStopS + fuelers * O.fuelPerRiderS : 0, ...riders.filter((r) => r.kind === "ev").map((r) => r.waitS));
            stops.push({
                s: stopS, station: pick, partner, window: pick ? [stopS, stopS] : [Math.max(cursor, stopS - O.zone), stopS],
                kinds, riders, waiting, noStation: !pick, urgent, waitS
            });
            for (const r of riders) { const res = results.find((x) => x.id === r.id); if (res) res.stops++; }
            cursor = stopS;
        }
        if (guard > O.maxStops) complete = false;
        return { members: results, stops, end, complete, extraS: stops.reduce((a, x) => a + x.waitS, 0) };
    }

    /**
     * Money per rider (pure). Prices in SI denominators: currency per m³ of fuel, per J from the wall.
     * @param {MemberResult[]} members @param {{ fuelPerM3: number, energyPerJ: number, chargeEfficiency?: number }} prices
     */
    function costs(members, prices) {
        const eff = prices.chargeEfficiency || 0.88;
        const rows = members.map((m) => ({ id: m.id, cost: m.kind === "ev" ? (Math.max(0, m.energyToEnd) / eff) * prices.energyPerJ : Math.max(0, m.energyToEnd) * prices.fuelPerM3 }));
        const total = rows.reduce((a, r) => a + r.cost, 0);
        return { rows, total, even: rows.length ? total / rows.length : 0 };
    }

    return { PLAN_DEFAULTS, cumulative, at, reach, planConvoy, costs };
});
