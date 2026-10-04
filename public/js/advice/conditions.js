// @ts-check
/* ============================================================================
   MapUnite advice — road conditions and speed advice (Step 8)
   ==============================================================================
   Strict SI inside (m/s, m, K, m/s rates). Open-Meteo's published units (mm, °C)
   are converted once, in parseOpenMeteo().

     classify(w)              weather → { kind, severity 0–3, factor, label, detail, icon }
     createTracker()          hysteresis: roads stay "may still be wet" for 30 min after rain
     advise(...)              advised speed under the posted limit + over-limit / over-advice
     overlayModel(...)        what the speed-advice badge shows (pure, for the UI)
     parseOpenMeteo(json)     the forecast API's "current" + past hours → SI
     createWeather(o)         fetch + 10-minute cache per ~5 km cell; offline → unknown

   The advised speed is ADVICE, never a legal limit: it is only ever below the
   posted limit, it is labelled "advised", and road signs always win.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUAdvice || (/** @type {any} */ (root).MUAdvice = {}); ns.conditions = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const KMH = 1 / 3.6;                       // m/s per km/h
    const MM = 1e-3;                           // m per mm
    const MM_PER_H = MM / 3600;                // m/s per mm/h
    const ZERO_C = 273.15;                     // K

    const T = Object.freeze({
        wetRate: 0.1 * MM_PER_H,               // any measurable rain now
        heavyRate: 4 * MM_PER_H,               // heavy rain
        recentWet: 0.3 * MM,                   // rain in the last 2 h that leaves the road wet
        iceTemp: ZERO_C + 2,                   // K: at or below, wet roads can freeze
        gust: 50 * KMH,                        // strong gusts move a bike sideways
        holdWetMs: 30 * 60 * 1000,             // roads stay wet a while after rain
        staleMs: 20 * 60 * 1000                // keep the last reading this long when offline
    });

    /** Speed factor and words for each condition. */
    const KINDS = Object.freeze({
        unknown: { severity: 0, factor: 1, label: "Weather unknown", short: "", icon: "cloud" },
        dry: { severity: 0, factor: 1, label: "Dry", short: "Dry", icon: "sun" },
        wind: { severity: 1, factor: 0.9, label: "Strong gusts", short: "Gusts", icon: "wind" },
        drying: { severity: 1, factor: 0.9, label: "Roads may still be wet", short: "Damp", icon: "drop" },
        wet: { severity: 1, factor: 0.85, label: "Wet road", short: "Wet", icon: "drop" },
        fog: { severity: 2, factor: 0.7, label: "Fog", short: "Fog", icon: "fog" },
        heavy: { severity: 2, factor: 0.7, label: "Heavy rain", short: "Heavy rain", icon: "rain" },
        storm: { severity: 3, factor: 0.7, label: "Thunderstorm", short: "Storm", icon: "storm" },
        ice: { severity: 3, factor: 0.6, label: "Ice risk", short: "Ice", icon: "ice" }
    });

    const CODES = {
        fog: [45, 48],
        drizzleRain: [51, 53, 55, 61, 63, 80, 81],
        heavy: [65, 82],
        freezing: [56, 57, 66, 67, 71, 73, 75, 77, 85, 86],
        storm: [95, 96, 99]
    };

    /**
     * @typedef {{ rate?: number|null, recent?: number|null, code?: number|null, temperature?: number|null, gust?: number|null }} Weather
     *   rate: precipitation now (m/s); recent: rain in the last 2 h (m); temperature (K); gust (m/s)
     * @typedef {{ kind: string, severity: number, factor: number, label: string, short: string, icon: string, detail: string }} Condition
     */

    /** @param {string} kind @param {string} detail @returns {Condition} */
    const make = (kind, detail) => ({ kind, ...(/** @type {any} */ (KINDS)[kind]), detail });

    /** @param {number} m metres of rain → "0.6 mm" */
    const mmText = (m) => `${(m / MM).toFixed(m / MM < 10 ? 1 : 0)} mm`;

    /**
     * Road condition from one weather reading. The most severe match wins.
     * @param {Weather|null|undefined} w
     * @returns {Condition}
     */
    function classify(w) {
        if (!w) return make("unknown", "No weather reading (offline?)");
        const has = (x) => x !== null && x !== undefined && Number.isFinite(x);
        if (![w.rate, w.recent, w.code, w.temperature].some(has)) return make("unknown", "No weather reading");
        const rate = has(w.rate) ? /** @type {number} */ (w.rate) : 0;
        const recent = has(w.recent) ? /** @type {number} */ (w.recent) : 0;
        const code = has(w.code) ? /** @type {number} */ (w.code) : -1;
        const wetNow = rate >= T.wetRate || CODES.drizzleRain.includes(code) || CODES.heavy.includes(code);
        const wetRecent = recent >= T.recentWet;
        const out = [];
        if (CODES.storm.includes(code)) out.push(make("storm", "Thunderstorm nearby: lightning, sudden downpours and gusts"));
        if (has(w.temperature) && /** @type {number} */ (w.temperature) <= T.iceTemp && (wetNow || wetRecent || CODES.freezing.includes(code))) out.push(make("ice", `${Math.round(/** @type {number} */ (w.temperature) - ZERO_C)} °C on a wet road: it can freeze, especially on bridges`));
        if (CODES.heavy.includes(code) || rate >= T.heavyRate) out.push(make("heavy", `Heavy rain${rate > 0 ? `: ${mmText(rate * 3600)} an hour` : ""}`));
        if (CODES.fog.includes(code)) out.push(make("fog", "Fog: others see you late. Lights on."));
        if (wetNow) out.push(make("wet", rate > 0 ? `Raining: ${mmText(rate * 3600)} an hour` : "Light rain"));
        else if (wetRecent) out.push(make("wet", `${mmText(recent)} of rain in the last 2 hours`));
        if (has(w.gust) && /** @type {number} */ (w.gust) >= T.gust) out.push(make("wind", `Gusts up to ${Math.round(/** @type {number} */ (w.gust) / KMH)} km/h`));
        if (!out.length) return make("dry", "No rain now or in the last 2 hours");
        // most severe first; at equal severity the lower speed factor (more caution) wins
        out.sort((a, b) => b.severity - a.severity || a.factor - b.factor);
        return out[0];
    }

    /**
     * Hysteresis over readings: after rain, roads stay "may still be wet" for 30 min;
     * an unknown reading (offline) keeps the last known condition for 20 min.
     * @param {{ holdWetMs?: number, staleMs?: number }} [o]
     */
    function createTracker(o = {}) {
        const holdWetMs = o.holdWetMs ?? T.holdWetMs, staleMs = o.staleMs ?? T.staleMs;
        /** @type {Condition|null} */ let current = null;
        let lastWetAt = -Infinity, lastKnownAt = -Infinity;
        /** @type {Condition|null} */ let lastKnown = null;
        return {
            /**
             * @param {Condition} c @param {number} t ms
             * @returns {{ condition: Condition, changed: boolean, worsened: boolean }}
             */
            update(c, t) {
                const prev = current;
                let next = c;
                if (c.kind === "unknown") next = lastKnown && t - lastKnownAt <= staleMs ? lastKnown : c;
                else {
                    lastKnown = c; lastKnownAt = t;
                    if (["wet", "heavy", "storm", "ice"].includes(c.kind)) lastWetAt = t;
                }
                // the drying rule applies to a remembered reading too (offline right after the rain)
                if (next.kind === "dry" && t - lastWetAt <= holdWetMs) next = make("drying", `Rain stopped ${Math.max(1, Math.round((t - lastWetAt) / 60000))} min ago`);
                current = next;
                const changed = !prev || prev.kind !== next.kind;
                const worsened = Boolean(prev) ? next.severity > /** @type {Condition} */ (prev).severity : next.severity > 0;
                return { condition: next, changed, worsened };
            },
            get condition() { return current; }
        };
    }

    const STEP = 5 * KMH;                      // advice in 5 km/h steps

    /**
     * Advised speed and how the rider compares.
     * @param {{ limit?: number|null, condition?: Condition|null, speed?: number|null, confidence?: number }} o  m/s
     * @returns {{ advised: number|null, factor: number, overLimit: number, overAdvised: number, trusted: boolean }}
     *   overLimit / overAdvised: m/s above (0 when not over, or when GPS isn't trusted)
     */
    function advise(o) {
        const limit = o.limit && o.limit > 0 ? o.limit : null;
        const factor = o.condition ? o.condition.factor : 1;
        const trusted = (o.confidence ?? 1) >= 0.6 && Number.isFinite(o.speed);
        const v = trusted ? /** @type {number} */ (o.speed) : 0;
        const advised = limit && factor < 1 ? Math.max(2 * STEP, Math.floor((limit * factor) / STEP + 1e-9) * STEP) : null;
        const grace = limit ? Math.max(3 * KMH, limit * 0.05) : 0;
        const overLimit = trusted && limit && v > limit + grace ? v - limit : 0;
        const overAdvised = trusted && advised && v > advised + STEP ? v - advised : 0;
        return { advised, factor, overLimit, overAdvised, trusted };
    }

    /**
     * What the speed-advice badge shows. null → nothing to add to the limit sign.
     * @param {{ limit?: number|null, condition?: Condition|null, speed?: number|null, confidence?: number, quiet?: boolean, enabled?: boolean }} o
     * @returns {null | { tone: "info"|"warn", icon: string, kicker: string, value: number|null, word: string, title: string, detail: string, quiet: boolean, advised: number|null }}
     *   value: m/s to show big (advised speed, or how far over the limit), null → word only
     */
    function overlayModel(o) {
        if (o.enabled === false) return null;
        const c = o.condition && o.condition.severity > 0 ? o.condition : null;
        const a = advise(o);
        const quiet = Boolean(o.quiet);
        if (c) {
            if (a.advised) {
                return {
                    tone: c.severity >= 2 || a.overAdvised > 0 ? "warn" : "info", icon: c.icon, kicker: "Advised", value: a.advised, word: c.short,
                    title: `${c.label}: advised ${Math.round(a.advised / KMH)} km/h`,
                    detail: `${c.detail}. ${Math.round(a.advised / KMH)} km/h is advice for these conditions on this ${Math.round(/** @type {number} */ (o.limit) / KMH)} km/h road, not a legal limit.`,
                    quiet, advised: a.advised
                };
            }
            return { tone: c.severity >= 2 ? "warn" : "info", icon: c.icon, kicker: c.short, value: null, word: "Ease off", title: c.label, detail: `${c.detail}. Ride slower than usual and leave a bigger gap.`, quiet, advised: null };
        }
        if (a.overLimit > 0 && o.limit) {
            return {
                tone: "warn", icon: "over", kicker: "Over by", value: a.overLimit, word: "km/h",
                title: `${Math.round(a.overLimit / KMH)} km/h over the ${Math.round(o.limit / KMH)} limit`, detail: "Limit from OpenStreetMap. Road signs always win.", quiet, advised: null
            };
        }
        return null;
    }

    /**
     * Open-Meteo forecast JSON (current + hourly precipitation with past hours) → SI Weather.
     * Request: current=precipitation,weather_code,temperature_2m,wind_gusts_10m
     *          &hourly=precipitation&past_hours=2&forecast_hours=1&wind_speed_unit=ms&timeformat=unixtime
     * @param {any} j
     * @returns {Weather|null}
     */
    function parseOpenMeteo(j) {
        const c = j && j.current;
        if (!c) return null;
        const num = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Number(x));
        const interval = num(c.interval) || 900;                       // s the "precipitation" sum covers
        const pmm = num(c.precipitation);
        const t = num(c.time);
        let recent = null;
        const h = j.hourly;
        if (h && Array.isArray(h.time) && Array.isArray(h.precipitation) && t !== null) {
            recent = 0;
            for (let i = 0; i < h.time.length; i++) {
                const ht = num(h.time[i]), p = num(h.precipitation[i]);
                if (ht === null || p === null) continue;
                if (ht <= t && ht > t - 2 * 3600) recent += p * MM;          // hourly sums ending in the last 2 h
            }
        }
        const tc = num(c.temperature_2m);
        return {
            rate: pmm === null ? null : (pmm * MM) / interval,
            recent,
            code: num(c.weather_code),
            temperature: tc === null ? null : tc + ZERO_C,
            gust: num(c.wind_gusts_10m)                                     // m/s (wind_speed_unit=ms)
        };
    }

    /**
     * @param {{ fetch?: typeof fetch|null, endpoint?: string, ttlMs?: number, timeoutMs?: number, online?: () => boolean }} [o]
     */
    function createWeather(o = {}) {
        const doFetch = o.fetch !== undefined ? o.fetch : (typeof fetch === "function" ? fetch.bind(globalThis) : null);
        const endpoint = o.endpoint || "https://api.open-meteo.com/v1/forecast";
        const ttlMs = o.ttlMs ?? 10 * 60 * 1000, timeoutMs = o.timeoutMs ?? 8000;
        const online = o.online || (() => !(typeof navigator !== "undefined" && navigator.onLine === false));
        /** @type {Map<string, { at: number, w: Weather|null }>} */ const cache = new Map();
        const cell = (lat, lng) => `${(Math.round(lat * 20) / 20).toFixed(2)},${(Math.round(lng * 20) / 20).toFixed(2)}`;
        return {
            /**
             * @param {number} lat @param {number} lng @param {number} [now]
             * @returns {Promise<{ ok: boolean, weather: Weather|null, condition: Condition, cached: boolean }>}
             */
            async get(lat, lng, now = Date.now()) {
                const k = cell(lat, lng);
                const hit = cache.get(k);
                if (hit && now - hit.at < ttlMs) return { ok: Boolean(hit.w), weather: hit.w, condition: classify(hit.w), cached: true };
                if (!doFetch || !online()) return { ok: false, weather: null, condition: classify(null), cached: false };
                const [la, ln] = k.split(",");
                const url = `${endpoint}?latitude=${la}&longitude=${ln}&current=precipitation,weather_code,temperature_2m,wind_gusts_10m&hourly=precipitation&past_hours=2&forecast_hours=1&wind_speed_unit=ms&timeformat=unixtime`;
                const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
                const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
                try {
                    const res = await doFetch(url, { credentials: "omit", signal: ctl ? ctl.signal : undefined });
                    const w = res.ok ? parseOpenMeteo(await res.json()) : null;
                    if (w) cache.set(k, { at: now, w });
                    return { ok: Boolean(w), weather: w, condition: classify(w), cached: false };
                } catch { return { ok: false, weather: null, condition: classify(null), cached: false }; } finally { if (timer) clearTimeout(timer); }
            },
            cell
        };
    }

    return { KMH, MM, MM_PER_H, ZERO_C, T, KINDS, CODES, classify, createTracker, advise, overlayModel, parseOpenMeteo, createWeather };
});
