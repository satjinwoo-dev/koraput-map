// @ts-check
/* ============================================================================
   MapUnite share — what goes on the post-ride card (pure)
   ==============================================================================
   buildCard(summary, opts) → everything the renderer draws, in SI plus the
   route already projected into a unit box. No DOM, no canvas.

     - Distance, time, speeds, fuel or battery energy, cost and the eco score come
       from the SmartDrive HUD's live estimate (physics × your learned correction);
       without it, from SmartDrive's own trip summary.
     - "Saved vs your usual" is only claimed against REAL data: your average over
       the full tanks the fuel learner has (litres pumped ÷ km). It's shown only
       when this ride beat it by 3 % or more over at least 2 km. No tanks → no
       savings claim, just the eco score.
     - Privacy (on by default): the first and last 400 m of the route are cut, so
       the card never shows where you started or finished (home, work).
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUShare || (/** @type {any} */ (root).MUShare = {}); ns.model = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const RAD = Math.PI / 180, R = 6371008.8;
    const CARD_DEFAULTS = Object.freeze({ trim: 400, maxPoints: 420, minSaving: 0.03, minSavingDistance: 2000 });

    function dist(a, b) {
        const x = (b.lng - a.lng) * RAD * Math.cos(((a.lat + b.lat) / 2) * RAD), y = (b.lat - a.lat) * RAD;
        return Math.hypot(x, y) * R;
    }

    /**
     * Drop the first and last `m` metres of a track (privacy).
     * @param {Array<{ lat: number, lng: number }>} pts @param {number} m
     */
    function trimEnds(pts, m) {
        const good = pts.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
        if (good.length < 2 || !(m > 0)) return good;
        const cum = [0];
        for (let i = 1; i < good.length; i++) cum.push(cum[i - 1] + dist(good[i - 1], good[i]));
        const L = cum[cum.length - 1];
        if (L <= 2 * m + 100) return [];                                        // too short to show without giving the ends away
        return good.filter((_, i) => cum[i] >= m && cum[i] <= L - m);
    }

    /** Douglas–Peucker on planar points [[x, y], …]. @param {number[][]} p @param {number} eps */
    function simplify(p, eps) {
        if (p.length <= 2) return p.slice();
        const keep = new Uint8Array(p.length); keep[0] = keep[p.length - 1] = 1;
        const stack = [[0, p.length - 1]];
        while (stack.length) {
            const [a, b] = /** @type {number[]} */ (stack.pop());
            const [ax, ay] = p[a], [bx, by] = p[b];
            const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
            let best = -1, bd = eps;
            for (let i = a + 1; i < b; i++) {
                const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[i][0] - ax) * dx + (p[i][1] - ay) * dy) / L2)) : 0;
                const d = Math.hypot(p[i][0] - (ax + t * dx), p[i][1] - (ay + t * dy));
                if (d > bd) { bd = d; best = i; }
            }
            if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
        }
        return p.filter((_, i) => keep[i]);
    }

    /**
     * Project a track into a unit box (aspect kept, north up), simplified for drawing.
     * @param {Array<{ lat: number, lng: number }>} pts @param {number} maxPoints
     * @returns {null | { pts: number[][], aspect: number, extent: number }}  aspect = width ÷ height; extent in m
     */
    function project(pts, maxPoints = CARD_DEFAULTS.maxPoints) {
        if (pts.length < 2) return null;
        const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
        const k = Math.cos(lat0 * RAD) * R * RAD, kl = R * RAD;
        let xy = pts.map((p) => [p.lng * k, -p.lat * kl]);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of xy) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        const w = maxX - minX, hgt = maxY - minY, ext = Math.max(w, hgt);
        if (!(ext > 20)) return null;                                           // standing still: nothing to draw
        let eps = ext * 0.002;
        let sp = simplify(xy, eps);
        while (sp.length > maxPoints) { eps *= 1.6; sp = simplify(xy, eps); }
        xy = sp;
        return { pts: xy.map(([x, y]) => [(x - minX) / ext, (y - minY) / ext]), aspect: hgt > 0 ? w / hgt : 10, extent: ext };
    }

    /** A modest word for the eco score. @param {number|null} s 0–1 */
    function ecoWord(s) {
        if (s === null || !Number.isFinite(s)) return "";
        return s >= 0.9 ? "Featherlight" : s >= 0.78 ? "Smooth" : s >= 0.62 ? "Steady" : "Room to save";
    }

    /** "Morning ride" etc. from the start time (local hours). @param {number} ts */
    function rideTitle(ts) {
        const hr = new Date(ts).getHours();
        return hr >= 5 && hr < 11 ? "Morning ride" : hr >= 11 && hr < 16 ? "Afternoon ride" : hr >= 16 && hr < 20 ? "Evening ride" : "Night ride";
    }

    /**
     * The usual fuel per metre from the learner's usable full tanks (real pump data), m³/m; null without.
     * @param {any} FC  js/smartdrive.js FuelCurve
     */
    function usualFromLearner(FC) {
        const ivs = FC && FC.fit && Array.isArray(FC.fit.intervals) ? FC.fit.intervals.filter((iv) => iv.usable) : [];
        const km = ivs.reduce((a, iv) => a + (iv.km || 0), 0), L = ivs.reduce((a, iv) => a + (Number.isFinite(iv.litresAdj) ? iv.litresAdj : iv.litres || 0), 0);
        return km > 20 && L > 0 ? { perMetre: L / 1000 / (km * 1000), tanks: ivs.length } : null;
    }

    /**
     * @param {{ trip: any, live?: any, powertrain?: string|null, bike?: string|null, correction?: number, usual?: { perMetre: number, tanks: number }|null }} sum
     * @param {{ privacy?: boolean, trim?: number }} [o]
     */
    function buildCard(sum, o = {}) {
        const O = { ...CARD_DEFAULTS, ...o };
        const trip = sum.trip || {};
        const live = sum.live || null;
        const ev = sum.powertrain === "ev";
        const startedAt = Number.isFinite(trip.startedAt) ? trip.startedAt : (live && live.startedAt) || Date.now();
        const endedAt = Number.isFinite(trip.endedAt) ? trip.endedAt : (live && live.endedAt) || startedAt;
        const distance = live && live.distance > 0 ? live.distance : (Number(trip.totalDistKm) || 0) * 1000;
        const energy = live ? live.energy : (Number(trip.fuelUsedL) || 0) / 1000;
        const perMetre = distance > 50 ? energy / distance : null;
        const duration = Math.max(0, (endedAt - startedAt) / 1000);
        const moving = live && live.moving > 0 ? live.moving : duration;
        const cost = live && Number.isFinite(live.cost) ? live.cost : null;
        // savings: only against real tanks, only when it's a real saving
        let saved = null;
        if (!ev && sum.usual && perMetre !== null && distance >= O.minSavingDistance) {
            const usualEnergy = sum.usual.perMetre * distance;
            const share = (usualEnergy - energy) / usualEnergy;
            if (share >= O.minSaving) saved = { energy: usualEnergy - energy, share, cost: cost !== null && energy > 0 ? (cost / energy) * (usualEnergy - energy) : null, usualPerMetre: sum.usual.perMetre, tanks: sum.usual.tanks };
        }
        const pts = Array.isArray(trip.points) ? trip.points : [];
        const shown = O.privacy !== false ? trimEnds(pts, O.trim) : pts.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
        const ecoScore = live && Number.isFinite(live.ecoScore) ? live.ecoScore : null;
        return {
            title: rideTitle(startedAt), startedAt, endedAt, place: trip.place || "", bike: sum.bike || "",
            powertrain: ev ? "ev" : "fuel",
            distance, duration, moving,
            avgSpeed: moving > 0 ? distance / moving : 0,
            maxSpeed: live && live.maxSpeed > 0 ? live.maxSpeed : (Number(trip.maxSpeed) || 0) / 3.6,
            energy, perMetre, cost, saved,
            ecoScore, ecoWord: ecoWord(ecoScore),
            harsh: live && live.harsh ? live.harsh.accel + live.harsh.brake : null,
            route: project(shown, O.maxPoints), privacy: O.privacy !== false,
            estimated: !live, matched: !!(live && Number.isFinite(sum.correction) && Math.abs(/** @type {number} */ (sum.correction) - 1) > 1e-6)
        };
    }

    return { CARD_DEFAULTS, trimEnds, simplify, project, ecoWord, rideTitle, usualFromLearner, buildCard };
});
