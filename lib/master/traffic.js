// @ts-check
"use strict";
/* ============================================================================
   MapUnite Master AI (server) — live traffic ahead (TomTom Flow Segment Data)
   ==============================================================================
   POST /api/master/traffic  { points: [[lat, lng, sAheadM], …] }   (≤ 6 points)
     → { ok, segments: [{ sAheadM, speedMs, freeFlowMs, ratio, delayS, closed,
                           confidence, level: "free"|"slow"|"jam"|"closed" }] }

   TOMTOM_API_KEY (server only). Without it the route answers 503
   { reason: "traffic-not-configured" } and the phone's traffic agent marks
   itself degraded; nothing else changes.

   The provider is behind one function (flowAt), so HERE / Mappls / Google Routes
   can replace it without touching the phone. TomTom reports km/h; it is
   converted to m/s here so the rest of the system stays SI.

   Levels, from the ratio current/free-flow speed (TomTom's own confidence
   below 0.5 is ignored: on Indian rural roads that's often a guess):
     closed  roadClosure = true
     jam     ratio ≤ 0.35
     slow    ratio ≤ 0.60
     free    otherwise
   Each point is cached 60 s at ~110 m, so a convoy of 10 costs the same as 1.
   ============================================================================ */

const { createCache } = require("./cache");
const { createUpstream } = require("./upstream");
const { isCoord } = require("./geo");

const KMH = 1 / 3.6;

/** @param {{ speedMs: number|null, freeFlowMs: number|null, closed: boolean, confidence: number|null }} f */
function levelOf(f) {
    if (f.closed) return "closed";
    if (!(Number.isFinite(f.speedMs) && Number.isFinite(f.freeFlowMs) && /** @type {number} */ (f.freeFlowMs) > 0)) return "unknown";
    if (Number.isFinite(f.confidence) && /** @type {number} */ (f.confidence) < 0.5) return "unknown";
    const r = /** @type {number} */ (f.speedMs) / /** @type {number} */ (f.freeFlowMs);
    return r <= 0.35 ? "jam" : r <= 0.6 ? "slow" : "free";
}

/**
 * @param {{ apiKey?: string, fetchImpl?: typeof fetch, now?: () => number, baseUrl?: string }} [o]
 */
function createTraffic(o = {}) {
    const apiKey = o.apiKey || "";
    const base = o.baseUrl || "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json";
    const now = o.now || (() => Date.now());
    const up = createUpstream({ name: "tomtom-flow", fetchImpl: o.fetchImpl, now });
    /** @type {ReturnType<typeof createCache<any>>} */ const cache = createCache({ max: 20000, ttlMs: 60000, staleMs: 300000, now });

    /** @param {number} lat @param {number} lng */
    function flowAt(lat, lng) {
        const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
        return cache.wrap(key, async () => {
            const url = `${base}?point=${lat.toFixed(5)},${lng.toFixed(5)}&unit=KMPH&openLr=false&key=${encodeURIComponent(apiKey)}`;
            const j = await up.json(url, {}, { timeoutMs: 5000, accept404: true });
            const f = j && j.flowSegmentData;
            if (!f) return null;                                     // no road segment here (off-road / not covered)
            const seg = {
                speedMs: Number.isFinite(f.currentSpeed) ? Math.round(f.currentSpeed * KMH * 10) / 10 : null,
                freeFlowMs: Number.isFinite(f.freeFlowSpeed) ? Math.round(f.freeFlowSpeed * KMH * 10) / 10 : null,
                delayS: Number.isFinite(f.currentTravelTime) && Number.isFinite(f.freeFlowTravelTime) ? Math.max(0, f.currentTravelTime - f.freeFlowTravelTime) : null,
                closed: f.roadClosure === true,
                confidence: Number.isFinite(f.confidence) ? f.confidence : null,
                frc: typeof f.frc === "string" ? f.frc : null
            };
            return { ...seg, level: levelOf(seg), ratio: seg.speedMs !== null && seg.freeFlowMs ? Math.round((seg.speedMs / seg.freeFlowMs) * 100) / 100 : null };
        });
    }

    /** @param {any} body @returns {Promise<{ status: number, json: any }>} */
    async function handle(body) {
        if (!apiKey) return { status: 503, json: { ok: false, reason: "traffic-not-configured" } };
        const pts = Array.isArray(body && body.points) ? body.points : null;
        if (!pts || !pts.length || pts.length > 6) return { status: 400, json: { ok: false, reason: "bad-points" } };
        const clean = [];
        for (const p of pts) {
            const lat = Number(p && p[0]), lng = Number(p && p[1]), s = Number(p && p[2]);
            if (!isCoord(lat, lng) || !(s >= 0 && s <= 6000)) return { status: 400, json: { ok: false, reason: "bad-points" } };
            clean.push({ lat, lng, s });
        }
        const res = await Promise.allSettled(clean.map((p) => flowAt(p.lat, p.lng)));
        if (res.every((r) => r.status === "rejected")) throw /** @type {PromiseRejectedResult} */ (res[0]).reason;
        const segments = clean.map((p, i) => {
            const r = res[i];
            const v = r.status === "fulfilled" ? r.value : null;
            return v ? { sAheadM: Math.round(p.s), ...v } : { sAheadM: Math.round(p.s), level: "unknown" };
        });
        return { status: 200, json: { ok: true, source: "tomtom", segments } };
    }

    return { handle, flowAt, configured: () => Boolean(apiKey), stats: () => ({ cache: cache.stats(), upstream: up.state() }) };
}

module.exports = { createTraffic, levelOf };
