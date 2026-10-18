// @ts-check
"use strict";
/* ============================================================================
   MapUnite (server) — MET Norway forecasts, fetched by our server only
   ==============================================================================
   The phone never calls MET Norway: it asks our server (the Ride Plan,
   /api/master/ride-plan), and this module fetches and caches.

   Source: MET Norway's Locationforecast 2.0, "complete" product
   (https://api.met.no/weatherapi/locationforecast/2.0/complete). Free,
   commercial use included, with attribution: "Weather forecast from MET
   Norway" (data CC BY 4.0 / NLOD 2.0). Its terms (api.met.no/doc/TermsOfService):
     - every request names the app and a contact in User-Agent
       (MET_NO_USER_AGENT; default names this project's repository);
     - coordinates with at most 4 decimals (we use 2: ≈ 1.1 km cells, shared
       by every rider and route through that cell);
     - don't hammer it: answers are cached per cell for 30 minutes (MET updates
       hourly), and a plan asks a few cells at a time.
   Range: hourly for about 2½ days, then 6-hourly, to about 9–10 days ahead.

   forecastAt([{ lat, lng, at }]) → for each point, the step nearest `at`:
     { available, at, tempC, rhPct, windMs, gustMs, precipMmH, rainProbPct,
       symbol, code, fogPct, hazards, updatedAt (when MET made this forecast) }
   Missing figures stay null (gusts and rain probability aren't given
   everywhere); nothing is filled in. `code` maps MET's symbol to the WMO
   weather code weather.js classify() already understands, so the thresholds
   for warnings are the same everywhere in the app.
   Pure and tested: symbolToWmo(), pickStep().
   ============================================================================ */

const { createCache } = require("./cache");
const { createUpstream } = require("./upstream");
const { classify } = require("./weather");

const DEFAULT_UA = "MapUnite/1.0 (+https://github.com/satjinwoo-dev/koraput-map)";

/**
 * MET Norway's symbol code ("heavyrainandthunder", "lightrainshowers_day", "fog", …) → a WMO weather code. Pure.
 * @param {string|null|undefined} sym @returns {number|null}
 */
function symbolToWmo(sym) {
    if (!sym) return null;
    const s = String(sym).replace(/_(day|night|polartwilight)$/, "");
    if (/thunder/.test(s)) return /heavy/.test(s) ? 96 : 95;
    if (/sleet|snow/.test(s)) return /heavy/.test(s) ? 75 : /light/.test(s) ? 71 : 73;
    if (/rain/.test(s)) {
        const shower = /showers/.test(s);
        if (/heavy/.test(s)) return shower ? 82 : 65;
        if (/light/.test(s)) return shower ? 80 : 61;
        return shower ? 81 : 63;
    }
    if (s === "fog") return 45;
    if (s === "clearsky") return 0;
    if (s === "fair") return 1;
    if (s === "partlycloudy") return 2;
    if (s === "cloudy") return 3;
    return null;
}

/**
 * The forecast step for a moment: the nearest step in time, its next-1-hour block when there is one (else the
 * 6-hour block, as an hourly rate). Null past the forecast's end. Pure.
 * @param {any[]} series MET's properties.timeseries @param {number} at ms
 */
function pickStep(series, at) {
    if (!Array.isArray(series) || !series.length) return null;
    const times = series.map((x) => Date.parse(x.time));
    const last = times[times.length - 1];
    if (!Number.isFinite(at) || at > last + 3 * 3600000) return null;
    let k = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - at) < Math.abs(times[k] - at)) k = i;
    const d = (series[k].data || {});
    const inst = (d.instant && d.instant.details) || {};
    const n1 = d.next_1_hours, n6 = d.next_6_hours;
    const block = n1 || n6 || null, hours = n1 ? 1 : 6;
    const num = (/** @type {any} */ v) => (Number.isFinite(v) ? v : null);
    const precip = block && block.details && Number.isFinite(block.details.precipitation_amount) ? Math.round(block.details.precipitation_amount / hours * 10) / 10 : null;
    const symbol = block && block.summary ? block.summary.symbol_code || null : null;
    return {
        at: times[k], hourly: Boolean(n1), tempC: num(inst.air_temperature), rhPct: num(inst.relative_humidity), windMs: num(inst.wind_speed), gustMs: num(inst.wind_speed_of_gust),
        fogPct: num(inst.fog_area_fraction), precipMmH: precip, rainProbPct: block && block.details ? num(block.details.probability_of_precipitation) : null, symbol
    };
}

/**
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, userAgent?: string, url?: string }} [o]
 */
function createMetNo(o = {}) {
    const now = o.now || (() => Date.now());
    const url = o.url || "https://api.met.no/weatherapi/locationforecast/2.0/complete";
    const ua = o.userAgent || DEFAULT_UA;
    const up = createUpstream({ name: "met-norway", fetchImpl: o.fetchImpl, now });
    /** @type {ReturnType<typeof createCache<any>>} */ const cache = createCache({ max: 4000, ttlMs: 30 * 60000, staleMs: 3 * 3600000, now });

    /** @param {string} cell "lat,lng" with 2 decimals */
    const series = (cell) => cache.wrap(cell, async () => {
        const [lat, lng] = cell.split(",");
        const j = await up.json(`${url}?lat=${lat}&lon=${lng}`, { headers: { accept: "application/json", "user-agent": ua } }, { timeoutMs: 9000 });
        const meta = (j && j.properties && j.properties.meta) || {};
        return { updatedAt: Date.parse(meta.updated_at) || null, ts: j && j.properties && Array.isArray(j.properties.timeseries) ? j.properties.timeseries : [] };
    });

    /**
     * @param {Array<{ lat: number, lng: number, at: number }>} points
     * @returns {Promise<Array<any>>} one entry per point
     */
    async function forecastAt(points) {
        const cells = [...new Set(points.map((p) => `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`))];
        /** @type {Map<string, { updatedAt: number|null, ts: any[] }|null>} */ const got = new Map();
        // a few at a time: polite to MET, and a long route is still only a handful of rounds
        for (let i = 0; i < cells.length; i += 4) {
            const part = cells.slice(i, i + 4);
            const res = await Promise.allSettled(part.map((c) => series(c)));
            part.forEach((c, k) => got.set(c, res[k].status === "fulfilled" ? /** @type {any} */ (res[k]).value : null));
        }
        return points.map((p) => {
            const s = got.get(`${p.lat.toFixed(2)},${p.lng.toFixed(2)}`);
            const st = s ? pickStep(s.ts, p.at) : null;
            if (!st) return { available: false, reason: s ? "beyond-forecast" : "unavailable" };
            const code = symbolToWmo(st.symbol) ?? (st.fogPct !== null && st.fogPct >= 50 ? 45 : null);
            const hazards = classify({ tempC: st.tempC, feelsC: null, rhPct: st.rhPct, precipMmH: st.precipMmH, code, gustMs: st.gustMs, visibilityM: null, rainProb1hPct: st.rainProbPct });
            return { available: true, ...st, code, hazards, updatedAt: s ? s.updatedAt : null };
        });
    }

    return { forecastAt, stats: () => ({ upstream: up.state(), cache: cache.stats() }), source: "MET Norway", attribution: "Weather forecast from MET Norway" };
}

module.exports = { createMetNo, symbolToWmo, pickStep, DEFAULT_UA };
