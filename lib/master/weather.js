// @ts-check
"use strict";
/* ============================================================================
   MapUnite Master AI (server) — weather along the corridor (Open-Meteo)
   ==============================================================================
   POST /api/master/weather  { points: [[lat, lng, sAheadM], …] }  (≤ 12 points, ≤ 6 km)
     → { ok, samples: [{ sAheadM, at, tempC, feelsC, rhPct, precipMmH, rainProb1hPct,
                          gustMs, visibilityM, pm10, dust, code, hazards: [...] }] }

   Sources (no API key, free for non-commercial use; commercial use needs an
   Open-Meteo plan, set OPEN_METEO_API_KEY and the customer endpoints):
     forecast     api.open-meteo.com/v1/forecast        current + next 2 hours
     air quality  air-quality-api.open-meteo.com/v1/air-quality   PM10 and dust (µg/m³)
   Air quality is best-effort: if it fails, samples come back without dust.

   Model resolution is 1–11 km, so points are snapped to a 0.01° grid
   (≈ 1.1 km) and fetched once per grid cell for 10 minutes, shared by every
   rider in that cell. A 2 km corridor is 1–3 upstream locations, one request.

   UNITS: SI throughout — °C (SI derived), m/s, metres, mm/h of rain
   (= kg m⁻² h⁻¹), µg/m³. Open-Meteo is asked for m/s directly.

   HAZARDS are classified here (pure: classify()), so every client and the
   tests see the same thresholds. Each hazard: { type, level: "warning"|"advice",
   value, unit }. Thresholds and why:
     storm        WMO 95/96/99 (thunderstorm, with hail)        warning
     heavy-rain   WMO 65/82, or ≥ 7.6 mm/h (WMO "heavy")        warning
     rain         WMO 61/63/80/81, or ≥ 0.5 mm/h                advice
     drizzle      WMO 51–57 (roads get slick before they look wet) advice
     freezing     WMO 66/67, 56/57; snow 71–77/85/86             warning
     fog          WMO 45/48 or visibility < 1000 m              advice; < 200 m warning
     wind         gusts ≥ 12 m/s advice, ≥ 17 m/s warning (a loaded bike gets pushed a lane)
     heat         feels-like ≥ 37 °C advice, ≥ 41 °C warning (heat-stroke band)
     cold         feels-like ≤ 3 °C advice (black ice possible below that on bridges)
     dust         PM10 or dust ≥ 250 µg/m³ advice ("poor"), ≥ 430 warning (India AQI "severe")
     dry          RH ≤ 20 % and ≥ 30 °C: dehydration                advice
     rain-soon    next-hour precipitation probability ≥ 70 %       advice
   ============================================================================ */

const { createCache } = require("./cache");
const { createUpstream } = require("./upstream");
const { isCoord } = require("./geo");

const T = Object.freeze({
    heavyRainMmH: 7.6, rainMmH: 0.5,
    gustAdviceMs: 12, gustWarnMs: 17,
    heatAdviceC: 37, heatWarnC: 41, coldAdviceC: 3,
    fogAdviceM: 1000, fogWarnM: 200,
    dustAdviceUg: 250, dustWarnUg: 430,
    dryRhPct: 20, dryMinC: 30,
    rainSoonPct: 70
});

/** @param {number} c */
const isStorm = (c) => c === 95 || c === 96 || c === 99;

/**
 * @param {{ code?: number|null, precipMmH?: number|null, gustMs?: number|null, feelsC?: number|null, tempC?: number|null,
 *   visibilityM?: number|null, pm10?: number|null, dust?: number|null, rhPct?: number|null, rainProb1hPct?: number|null }} s
 * @returns {Array<{ type: string, level: "warning"|"advice", value: number|null, unit: string }>}
 */
function classify(s) {
    /** @type {Array<{ type: string, level: "warning"|"advice", value: number|null, unit: string }>} */ const out = [];
    const c = Number.isFinite(s.code) ? /** @type {number} */ (s.code) : -1;
    const fin = (/** @type {any} */ v) => Number.isFinite(v);
    const p = fin(s.precipMmH) ? /** @type {number} */ (s.precipMmH) : 0;
    if (isStorm(c)) out.push({ type: "storm", level: "warning", value: c, unit: "wmo" });
    if ([66, 67, 56, 57, 71, 73, 75, 77, 85, 86].includes(c)) out.push({ type: "freezing", level: "warning", value: c, unit: "wmo" });
    if (c === 65 || c === 82 || p >= T.heavyRainMmH) out.push({ type: "heavy-rain", level: "warning", value: p, unit: "mm/h" });
    else if ([61, 63, 80, 81].includes(c) || (p >= T.rainMmH && !isStorm(c))) out.push({ type: "rain", level: "advice", value: p, unit: "mm/h" });
    else if (c >= 51 && c <= 55) out.push({ type: "drizzle", level: "advice", value: p, unit: "mm/h" });
    const vis = fin(s.visibilityM) ? /** @type {number} */ (s.visibilityM) : null;
    if (vis !== null && vis < T.fogWarnM) out.push({ type: "fog", level: "warning", value: vis, unit: "m" });
    else if (c === 45 || c === 48 || (vis !== null && vis < T.fogAdviceM)) out.push({ type: "fog", level: "advice", value: vis, unit: "m" });
    if (fin(s.gustMs) && /** @type {number} */ (s.gustMs) >= T.gustAdviceMs) out.push({ type: "wind", level: /** @type {number} */ (s.gustMs) >= T.gustWarnMs ? "warning" : "advice", value: /** @type {number} */ (s.gustMs), unit: "m/s" });
    const feels = fin(s.feelsC) ? /** @type {number} */ (s.feelsC) : fin(s.tempC) ? /** @type {number} */ (s.tempC) : null;
    if (feels !== null && feels >= T.heatAdviceC) out.push({ type: "heat", level: feels >= T.heatWarnC ? "warning" : "advice", value: feels, unit: "°C" });
    if (feels !== null && feels <= T.coldAdviceC) out.push({ type: "cold", level: "advice", value: feels, unit: "°C" });
    const dust = Math.max(fin(s.pm10) ? /** @type {number} */ (s.pm10) : 0, fin(s.dust) ? /** @type {number} */ (s.dust) : 0);
    if (dust >= T.dustAdviceUg) out.push({ type: "dust", level: dust >= T.dustWarnUg ? "warning" : "advice", value: Math.round(dust), unit: "µg/m³" });
    const t = fin(s.tempC) ? /** @type {number} */ (s.tempC) : feels;
    if (fin(s.rhPct) && /** @type {number} */ (s.rhPct) <= T.dryRhPct && t !== null && t >= T.dryMinC) out.push({ type: "dry", level: "advice", value: /** @type {number} */ (s.rhPct), unit: "%" });
    const wet = out.some((h) => h.type === "rain" || h.type === "heavy-rain" || h.type === "storm" || h.type === "drizzle");
    if (!wet && fin(s.rainProb1hPct) && /** @type {number} */ (s.rainProb1hPct) >= T.rainSoonPct) out.push({ type: "rain-soon", level: "advice", value: /** @type {number} */ (s.rainProb1hPct), unit: "%" });
    return out;
}

const cellOf = (/** @type {number} */ lat, /** @type {number} */ lng) => `${lat.toFixed(2)},${lng.toFixed(2)}`;

/**
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, forecastUrl?: string, airUrl?: string, apiKey?: string }} [o]
 */
function createWeather(o = {}) {
    const forecastUrl = o.forecastUrl || "https://api.open-meteo.com/v1/forecast";
    const airUrl = o.airUrl || "https://air-quality-api.open-meteo.com/v1/air-quality";
    const keyQs = o.apiKey ? `&apikey=${encodeURIComponent(o.apiKey)}` : "";
    const now = o.now || (() => Date.now());
    const up = createUpstream({ name: "open-meteo", fetchImpl: o.fetchImpl, now });
    const upAir = createUpstream({ name: "open-meteo-air", fetchImpl: o.fetchImpl, now });
    /** @type {ReturnType<typeof createCache<any>>} */ const cache = createCache({ max: 5000, ttlMs: 600000, now });

    /** Fetch every not-yet-cached cell in one multi-location request. @param {Array<[number, number]>} cells */
    async function loadCells(cells) {
        const lat = cells.map((c) => c[0].toFixed(2)).join(","), lng = cells.map((c) => c[1].toFixed(2)).join(",");
        const fq = `${forecastUrl}?latitude=${lat}&longitude=${lng}`
            + "&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_gusts_10m"
            + "&hourly=precipitation_probability,visibility&forecast_hours=2&wind_speed_unit=ms&precipitation_unit=mm&timezone=GMT" + keyQs;
        const aq = `${airUrl}?latitude=${lat}&longitude=${lng}&current=pm10,dust&timezone=GMT` + keyQs;
        const [fc, air] = await Promise.all([
            up.json(fq, { headers: { accept: "application/json" } }, { timeoutMs: 7000 }),
            upAir.json(aq, { headers: { accept: "application/json" } }, { timeoutMs: 5000, retries: 0 }).catch(() => null)
        ]);
        const fcs = Array.isArray(fc) ? fc : [fc];
        const airs = Array.isArray(air) ? air : air ? [air] : [];
        return cells.map((_c, i) => {
            const f = fcs[i] || {}, cur = f.current || {}, hr = f.hourly || {}, a = (airs[i] && airs[i].current) || {};
            const num = (/** @type {any} */ v) => (Number.isFinite(v) ? v : null);
            const vis = Array.isArray(hr.visibility) ? num(hr.visibility[0]) : null;
            const prob = Array.isArray(hr.precipitation_probability) ? Math.max(...hr.precipitation_probability.filter(Number.isFinite), -1) : -1;
            // "current" precipitation is the sum over the preceding interval (900 s for 15-minutely data): scale to mm/h
            const intervalS = Number.isFinite(cur.interval) && cur.interval > 0 ? cur.interval : 3600;
            const precip = num(cur.precipitation);
            return {
                at: typeof cur.time === "string" ? Date.parse(`${cur.time}Z`) || now() : now(),
                tempC: num(cur.temperature_2m), feelsC: num(cur.apparent_temperature), rhPct: num(cur.relative_humidity_2m),
                precipMmH: precip === null ? null : Math.round(precip * (3600 / intervalS) * 10) / 10, code: num(cur.weather_code), gustMs: num(cur.wind_gusts_10m),
                visibilityM: vis, rainProb1hPct: prob >= 0 ? prob : null, pm10: num(a.pm10), dust: num(a.dust)
            };
        });
    }

    /** @type {Map<string, Promise<any>>} batched loads in flight, per cell */
    const batch = new Map();
    /** @param {Array<[number, number]>} cells @returns {Promise<any[]>} */
    async function getCells(cells) {
        const keys = cells.map(([a, b]) => cellOf(a, b));
        const missing = [];
        for (let i = 0; i < cells.length; i++) if (cache.get(keys[i]) === undefined && !batch.has(keys[i])) missing.push(i);
        if (missing.length) {
            const p = loadCells(missing.map((i) => cells[i]));
            missing.forEach((i, j) => {
                const one = p.then((arr) => { cache.set(keys[i], arr[j]); return arr[j]; });
                one.catch(() => {}).finally(() => batch.delete(keys[i]));
                batch.set(keys[i], one);
            });
        }
        return Promise.all(keys.map((k) => { const v = cache.get(k); return v !== undefined ? v : batch.get(k); }));
    }

    /**
     * @param {any} body
     * @returns {Promise<{ status: number, json: any }>}
     */
    async function handle(body) {
        const pts = Array.isArray(body && body.points) ? body.points : null;
        if (!pts || !pts.length || pts.length > 12) return { status: 400, json: { ok: false, reason: "bad-points" } };
        /** @type {Array<{ lat: number, lng: number, s: number }>} */ const clean = [];
        for (const p of pts) {
            const lat = Number(p && p[0]), lng = Number(p && p[1]), s = Number(p && p[2]);
            if (!isCoord(lat, lng) || !(s >= 0 && s <= 6000)) return { status: 400, json: { ok: false, reason: "bad-points" } };
            clean.push({ lat, lng, s });
        }
        /** @type {Map<string, [number, number]>} */ const uniq = new Map();
        for (const p of clean) uniq.set(cellOf(p.lat, p.lng), [Number(p.lat.toFixed(2)), Number(p.lng.toFixed(2))]);
        const cells = [...uniq.values()];
        const vals = await getCells(cells);
        const byCell = new Map(cells.map((c, i) => [cellOf(c[0], c[1]), vals[i]]));
        const samples = clean.map((p) => {
            const v = byCell.get(cellOf(p.lat, p.lng)) || {};
            return { sAheadM: Math.round(p.s), ...v, hazards: classify(v) };
        });
        return { status: 200, json: { ok: true, source: "open-meteo", samples } };
    }

    /**
     * Weather at one place around a time (destination safety). Hourly, up to 48 h ahead.
     * @param {number} lat @param {number} lng @param {number} atMs
     */
    async function at(lat, lng, atMs) {
        const key = `at:${cellOf(lat, lng)}:${Math.floor(atMs / 3600000)}`;
        return cache.wrap(key, async () => {
            const q = `${forecastUrl}?latitude=${lat.toFixed(2)}&longitude=${lng.toFixed(2)}`
                + "&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,precipitation_probability,weather_code,wind_gusts_10m,visibility"
                + "&forecast_days=3&wind_speed_unit=ms&timezone=GMT" + keyQs;
            const f = await up.json(q, {}, { timeoutMs: 7000 });
            const h = (f && f.hourly) || {};
            const times = Array.isArray(h.time) ? h.time.map((/** @type {string} */ t) => Date.parse(`${t}Z`)) : [];
            if (!times.length) return null;
            let i = 0, bestD = Infinity;
            times.forEach((/** @type {number} */ t, /** @type {number} */ k) => { const d = Math.abs(t - atMs); if (d < bestD) { bestD = d; i = k; } });
            if (bestD > 2 * 3600000) return null;
            const g = (/** @type {string} */ k) => (Array.isArray(h[k]) && Number.isFinite(h[k][i]) ? h[k][i] : null);
            const s = { at: times[i], tempC: g("temperature_2m"), feelsC: g("apparent_temperature"), rhPct: g("relative_humidity_2m"), precipMmH: g("precipitation"), rainProb1hPct: g("precipitation_probability"), code: g("weather_code"), gustMs: g("wind_gusts_10m"), visibilityM: g("visibility") };
            return { ...s, hazards: classify(s) };
        }, { ttlMs: 1800000 });
    }

    return { handle, at, classify, stats: () => ({ cache: cache.stats(), upstream: up.state() }) };
}

module.exports = { createWeather, classify, THRESHOLDS: T };
