// @ts-check
"use strict";
/* ============================================================================
   MapUnite (server) — the usual weather of a month, from NASA POWER
   ==============================================================================
   For a ride too far ahead for any forecast, the Ride Plan shows what the
   weather is USUALLY like there in that month: never a forecast, and labelled
   so. Fetched by our server only.

   Source: NASA POWER (Prediction Of Worldwide Energy Resources), climatology
   endpoint: https://power.larc.nasa.gov/api/temporal/climatology/point
   Free, no key, no registration; NASA asks to be credited ("Data from NASA
   POWER, power.larc.nasa.gov"). Long-term monthly means (the API's
   climatology period, given back in the answer's header), on a 0.5° × 0.625°
   grid (≈ 55 km): a regional picture, not the road.

   Asked for: T2M (mean air temperature at 2 m), T2M_MAX, T2M_MIN (°C, monthly
   means of the daily highs and lows), PRECTOTCORR (rain, mm/day), WS2M (wind
   at 2 m, m/s). monthAt() picks one month; cells are cached for 30 days (the
   numbers only change when NASA reprocesses the record).
   Pure and tested: monthAt(), summary().
   ============================================================================ */

const { createCache } = require("./cache");
const { createUpstream } = require("./upstream");

const MONTHS = Object.freeze(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]);
const PARAMS = "T2M,T2M_MAX,T2M_MIN,PRECTOTCORR,WS2M";

/**
 * One month out of a POWER climatology answer. Pure.
 * @param {any} j the JSON answer @param {number} month 0–11
 * @returns {{ tempC: number|null, highC: number|null, lowC: number|null, rainMmDay: number|null, windMs: number|null, period: string|null }|null}
 */
function monthAt(j, month) {
    const p = j && j.properties && j.properties.parameter;
    if (!p || month < 0 || month > 11) return null;
    const k = MONTHS[month];
    // POWER marks missing values with -999
    const v = (/** @type {string} */ name) => (p[name] && Number.isFinite(p[name][k]) && p[name][k] > -998 ? Math.round(p[name][k] * 10) / 10 : null);
    const h = j.header || {};
    const period = h.start && h.end ? `${String(h.start).slice(0, 4)}–${String(h.end).slice(0, 4)}` : null;
    const out = { tempC: v("T2M"), highC: v("T2M_MAX"), lowC: v("T2M_MIN"), rainMmDay: v("PRECTOTCORR"), windMs: v("WS2M"), period };
    return out.tempC === null && out.rainMmDay === null ? null : out;
}

/** Words for a month's numbers. Pure. @param {{ rainMmDay: number|null, highC: number|null, lowC: number|null }} m */
function summary(m) {
    const notes = [];
    if (m.rainMmDay !== null) notes.push(m.rainMmDay >= 8 ? "a very wet month: heavy rain is common" : m.rainMmDay >= 4 ? "a rainy month: carry rain gear" : m.rainMmDay >= 1 ? "some rainy days" : "usually dry");
    if (m.highC !== null && m.highC >= 38) notes.push("very hot afternoons");
    else if (m.highC !== null && m.highC >= 34) notes.push("hot afternoons");
    if (m.lowC !== null && m.lowC <= 8) notes.push("cold mornings and nights");
    return notes;
}

/**
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, url?: string }} [o]
 */
function createNasaPower(o = {}) {
    const now = o.now || (() => Date.now());
    const url = o.url || "https://power.larc.nasa.gov/api/temporal/climatology/point";
    const up = createUpstream({ name: "nasa-power", fetchImpl: o.fetchImpl, now, failuresToOpen: 3 });
    /** @type {ReturnType<typeof createCache<any>>} */ const cache = createCache({ max: 2000, ttlMs: 30 * 86400000, now });

    /** The month's usual weather at points (each snapped to POWER's 0.5° grid). @param {Array<{ lat: number, lng: number, month: number }>} pts */
    async function monthly(pts) {
        return Promise.all(pts.map(async (p) => {
            const la = Math.round(p.lat * 2) / 2, ln = Math.round(p.lng * 1.6) / 1.6;
            try {
                const j = await cache.wrap(`${la},${ln.toFixed(3)}`, () => up.json(`${url}?parameters=${PARAMS}&community=AG&longitude=${ln.toFixed(3)}&latitude=${la}&format=JSON`, { headers: { accept: "application/json" } }, { timeoutMs: 15000 }));
                const m = monthAt(j, p.month);
                return m ? { available: true, ...m, notes: summary(m) } : { available: false };
            } catch (e) { return { available: false }; }
        }));
    }
    return { monthly, stats: () => ({ upstream: up.state(), cache: cache.stats() }), attribution: "Data from NASA POWER (power.larc.nasa.gov)" };
}

module.exports = { createNasaPower, monthAt, summary, MONTHS };
