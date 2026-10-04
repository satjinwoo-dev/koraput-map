// @ts-check
/* ============================================================================
   MapUnite advice — the safety gate and the economy advice (roadmap Step 8)
   ==============================================================================
   Pure logic, strict SI (m, s, m/s, m/s², rad/s). No DOM, no timers, no network:
   js/advice/advice-app.js feeds it and speaks through VoiceAssistant.

   The rule: economy advice is a luxury. It is spoken ONLY when the gate says the
   rider has attention to spare, and never above the posted speed limit.

   The gate (evaluateGate) is a state machine over plain data (so a ride restored
   from a backup keeps its holds):
     off        not riding
     quiet      the rider switched advice off ("quiet ride"); safety alerts are
                unaffected — they never pass through this gate
     hold       something needs the rider's attention; the reasons, and when the
                hold ends:
                  cornering    yaw rate from the gyroscope, or from the GPS heading,
                               or lateral acceleration v²·κ on the route (+6 s)
                  curve-ahead  a bend tighter than 200 m radius within the next
                               max(150 m, 8 s) of the planned route
                  braking      deceleration ≥ 3 m/s² (≈ 0.3 g) (+30 s)
                  wet          rain, drizzle, showers, snow or a thunderstorm reported
                               here (+30 min after the last report)
                  unsteady     speed varying more than 1.5 m/s (±5 km/h, 1 σ) over
                               the last 20 s, or not 10 s of samples yet
                  maneuver     a navigation turn within 500 m
                  gps          the fix isn't trusted (rejected, or worse than 25 m)
                  slow         under 15 km/h (stop-and-go: nothing useful to say)
     cooldown   advice was given recently (3 min; the same advice: 10 min)
     ready      advice may be spoken
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUAdvice || (/** @type {any} */ (root).MUAdvice = {}); ns.core = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const GATE = Object.freeze({
        minSpeed: 15 / 3.6,              // m/s
        yawRate: 0.20,                   // rad/s (≈ 11.5 °/s) from the gyroscope, low-passed
        headingRate: 0.15,               // rad/s (≈ 8.6 °/s) from consecutive GPS headings
        lateralAccel: 1.5,               // m/s² = v²·κ on the route right here
        curveRadius: 200,                // m: a tighter bend ahead holds advice
        lookaheadMin: 150, lookaheadTime: 8,   // m, s
        cornerHold: 6,                   // s after the corner ends
        brakeDecel: 3.0,                 // m/s²
        brakeHold: 30,                   // s
        wetHold: 1800,                   // s after the last wet weather report
        steadyWindow: 20, steadyMin: 10, // s
        steadySd: 1.5,                   // m/s (1 σ)
        maneuverDistance: 500,           // m
        gpsAccuracy: 25,                 // m
        cooldown: 180,                   // s between any two pieces of advice
        repeatCooldown: 600              // s before the same advice again
    });

    /** WMO weather codes (Open-Meteo `weather_code`) that mean a wet or slippery road. */
    const WET_CODES = Object.freeze([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]);
    /** @param {unknown} code @returns {boolean|null} null when unknown */
    function isWetWeather(code) {
        const c = Number(code);
        if (code === null || code === undefined || !Number.isFinite(c)) return null;
        return WET_CODES.includes(c);
    }

    /**
     * @typedef {{ t: number, v: number }} SpeedSample  t: s, v: m/s
     * @typedef {{
     *   v: 1, samples: SpeedSample[], lastHeading: number|null, lastHeadingT: number|null,
     *   holds: Record<string, number>, lastAdviceT: number|null, lastAdvice: Record<string, number>, aPrev: number|null
     * }} GateState
     * @typedef {{
     *   t: number, v: number, gpsOk?: boolean, accuracy?: number|null,
     *   yawRate?: number|null, heading?: number|null, curvatureHere?: number|null, radiusAhead?: number|null,
     *   wet?: boolean|null, maneuverDistance?: number|null, quiet?: boolean, riding?: boolean
     * }} GateInput
     *   t: seconds (any epoch, monotonic); v: smoothed speed (m/s); heading: radians, a NEW course measurement
 *   (null when there's none this moment);
     *   yawRate: |angular rate| from the gyroscope (rad/s, already low-passed), null without one;
     *   curvatureHere: 1/m of the planned route at the rider; radiusAhead: tightest radius (m) within the lookahead
     * @typedef {{ state: "off"|"quiet"|"hold"|"cooldown"|"ready", reasons: string[], until: number|null, canAdvise: boolean,
     *   accel: number|null, steadySd: number|null }} GateResult
     */

    /** @returns {GateState} */
    function createGateState() {
        return { v: 1, samples: [], lastHeading: null, lastHeadingT: null, holds: {}, lastAdviceT: null, lastAdvice: {}, aPrev: null };
    }

    /** Wrap an angle difference into (−π, π]. @param {number} d */
    function wrap(d) { while (d > Math.PI) d -= 2 * Math.PI; while (d <= -Math.PI) d += 2 * Math.PI; return d; }

    /**
     * Feed one moment of the ride; returns what the gate says now. Mutates `st`.
     * @param {GateState} st @param {GateInput} x @param {Partial<typeof GATE>} [o]
     * @returns {GateResult}
     */
    function evaluateGate(st, x, o = {}) {
        const G = { ...GATE, ...o };
        const t = x.t, v = Math.max(0, Number(x.v) || 0);
        // speed history (steadiness, longitudinal acceleration)
        const prev = st.samples.length ? st.samples[st.samples.length - 1] : null;
        if (!prev || t > prev.t) st.samples.push({ t, v });
        while (st.samples.length && t - st.samples[0].t > G.steadyWindow) st.samples.shift();
        let accel = null;
        if (prev && t > prev.t && t - prev.t <= 5) {
            const a = (v - prev.v) / (t - prev.t);
            accel = st.aPrev === null ? a : 0.5 * (a + st.aPrev);          // two-sample average: one noisy fix isn't a brake
            st.aPrev = a;
        } else st.aPrev = null;
        const span = st.samples.length > 1 ? st.samples[st.samples.length - 1].t - st.samples[0].t : 0;
        let steadySd = null;
        if (st.samples.length > 1) {
            const m = st.samples.reduce((s, p) => s + p.v, 0) / st.samples.length;
            steadySd = Math.sqrt(st.samples.reduce((s, p) => s + (p.v - m) ** 2, 0) / st.samples.length);
        }
        // heading rate from GPS: between two successive headings at most 8 s apart (no heading
        // this moment = the last one is kept; slow or stopped = forgotten)
        let headingRate = null;
        if (v < G.minSpeed) { st.lastHeading = null; st.lastHeadingT = null; }
        else if (Number.isFinite(x.heading)) {
            if (st.lastHeading !== null && st.lastHeadingT !== null && t > st.lastHeadingT && t - st.lastHeadingT <= 8) {
                headingRate = Math.abs(wrap(/** @type {number} */ (x.heading) - st.lastHeading)) / (t - st.lastHeadingT);
            }
            st.lastHeading = /** @type {number} */ (x.heading); st.lastHeadingT = t;
        }

        // holds that outlive their cause
        const holdUntil = (/** @type {string} */ k, /** @type {number} */ d) => { st.holds[k] = Math.max(st.holds[k] || 0, t + d); };
        const cornering = (Number.isFinite(x.yawRate) && /** @type {number} */ (x.yawRate) >= G.yawRate)
            || (headingRate !== null && headingRate >= G.headingRate)
            || (Number.isFinite(x.curvatureHere) && v * v * Math.abs(/** @type {number} */ (x.curvatureHere)) >= G.lateralAccel);
        if (cornering) holdUntil("cornering", G.cornerHold);
        if (accel !== null && accel <= -G.brakeDecel) holdUntil("braking", G.brakeHold);
        if (x.wet === true) holdUntil("wet", G.wetHold);

        if (x.riding === false) return { state: "off", reasons: [], until: null, canAdvise: false, accel, steadySd };
        if (x.quiet) return { state: "quiet", reasons: ["quiet-ride"], until: null, canAdvise: false, accel, steadySd };

        /** @type {string[]} */ const reasons = [];
        let until = null;
        for (const k of ["cornering", "braking", "wet"]) {
            if ((st.holds[k] || 0) > t) { reasons.push(k); until = Math.max(until || 0, st.holds[k]); }
            else delete st.holds[k];
        }
        if (Number.isFinite(x.radiusAhead) && /** @type {number} */ (x.radiusAhead) < G.curveRadius) reasons.push("curve-ahead");
        if (span < G.steadyMin || (steadySd !== null && steadySd > G.steadySd)) reasons.push("unsteady");
        if (Number.isFinite(x.maneuverDistance) && /** @type {number} */ (x.maneuverDistance) <= G.maneuverDistance) reasons.push("maneuver");
        if (x.gpsOk === false || (Number.isFinite(x.accuracy) && /** @type {number} */ (x.accuracy) > G.gpsAccuracy)) reasons.push("gps");
        if (v < G.minSpeed) reasons.push("slow");
        if (reasons.length) return { state: "hold", reasons, until, canAdvise: false, accel, steadySd };
        if (st.lastAdviceT !== null && t - st.lastAdviceT < G.cooldown) return { state: "cooldown", reasons: ["cooldown"], until: st.lastAdviceT + G.cooldown, canAdvise: false, accel, steadySd };
        return { state: "ready", reasons: [], until: null, canAdvise: true, accel, steadySd };
    }

    /**
     * Record that advice was spoken (starts the cooldowns).
     * @param {GateState} st @param {number} t s @param {string} key
     */
    function noteAdvice(st, t, key) {
        st.lastAdviceT = t;
        st.lastAdvice[key] = t;
        for (const k of Object.keys(st.lastAdvice)) if (t - st.lastAdvice[k] > 3600) delete st.lastAdvice[k];
    }
    /** @param {GateState} st @param {number} t @param {string} key @param {Partial<typeof GATE>} [o] */
    function repeatedTooSoon(st, t, key, o = {}) {
        const G = { ...GATE, ...o };
        return st.lastAdvice[key] !== undefined && t - st.lastAdvice[key] < G.repeatCooldown;
    }

    const ADVICE = Object.freeze({
        minSaving: 0.08,                 // speak only when easing off saves ≥ 8 % fuel per km
        minEase: 8 / 3.6,                // m/s: and the suggested speed is ≥ 8 km/h lower
        maxEase: 15 / 3.6,               // m/s: never suggest dropping more than 15 km/h at once
        roundTo: 5 / 3.6                 // m/s: suggested speeds are multiples of 5 km/h
    });

    /**
     * Economy advice at a steady speed, or null. Only ever suggests EASING OFF, and
     * never a speed above the posted limit; above the limit it says nothing at all
     * (the speed alerts own that moment).
     * @param {{ v: number, limit?: number|null, kmPerLAt: (kmh: number) => number, eco: { fromKmh: number, toKmh: number } | null }} x
     *   v: m/s; limit: m/s or null when unknown; kmPerLAt: the rider's km/L at a speed (km/h, the learner's own units)
     * @param {Partial<typeof ADVICE>} [o]
     * @returns {null | { key: string, target: number, saving: number, text: string }}  target m/s, saving 0–1
     */
    function ecoAdvice(x, o = {}) {
        const A = { ...ADVICE, ...o };
        const v = Number(x.v);
        if (!(v > 0) || !x.eco || typeof x.kmPerLAt !== "function") return null;
        const limit = Number.isFinite(x.limit) && /** @type {number} */ (x.limit) > 0 ? /** @type {number} */ (x.limit) : null;
        if (limit !== null && v > limit + 0.5) return null;
        const ecoTop = x.eco.toKmh / 3.6;
        if (!(v > ecoTop)) return null;
        let target = Math.max(ecoTop, v - A.maxEase);
        if (limit !== null) target = Math.min(target, limit);
        target = Math.floor(target / A.roundTo + 1e-9) * A.roundTo;
        if (v - target < A.minEase) return null;
        const now = x.kmPerLAt(v * 3.6), then = x.kmPerLAt(target * 3.6);
        if (!(now > 0) || !(then > 0)) return null;
        const saving = 1 - now / then;                 // fuel per km at v vs at the target
        if (!(saving >= A.minSaving)) return null;
        const kmh = Math.round(target * 3.6);
        return { key: `eco-${kmh}`, target, saving, text: `Easing to ${kmh} would use about ${Math.round(saving * 100)} percent less fuel.` };
    }

    /**
     * Curvature of the planned route at the rider and the tightest bend ahead.
     * Bends are measured as circumcircle radii of points ~25 m apart, so GPS-scale
     * zig-zags in the geometry don't read as corners.
     * @param {ArrayLike<ArrayLike<number>>} path [[lat, lng], …]
     * @param {number} lat @param {number} lng @param {number} lookahead m
     * @returns {{ curvatureHere: number|null, radiusAhead: number|null, offRoute: number }}
     */
    function routeCurvature(path, lat, lng, lookahead) {
        const out = { curvatureHere: null, radiusAhead: null, offRoute: Infinity };
        if (!path || path.length < 3 || !Number.isFinite(lat) || !Number.isFinite(lng)) return out;
        const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
        const P = [];
        for (let i = 0; i < path.length; i++) P.push([(Number(path[i][1]) - lng) * kx, (Number(path[i][0]) - lat) * ky]);
        // nearest segment to the rider
        let best = -1, bestD = Infinity, bestT = 0;
        for (let i = 0; i < P.length - 1; i++) {
            const [ax, ay] = P[i], [bx, by] = P[i + 1];
            const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
            const tt = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
            const d = Math.hypot(ax + tt * dx, ay + tt * dy);
            if (d < bestD) { bestD = d; best = i; bestT = tt; }
        }
        out.offRoute = bestD;
        if (best < 0 || bestD > 50) return out;
        // walk ahead, resampling every 25 m
        const step = 25, pts = [[P[best][0] + bestT * (P[best + 1][0] - P[best][0]), P[best][1] + bestT * (P[best + 1][1] - P[best][1])]];
        let i = best + 1, cur = pts[0], need = step, walked = 0;
        // one point behind the rider too, for the curvature right here
        const back = P[best];
        const behind = Math.hypot(cur[0] - back[0], cur[1] - back[1]) >= step / 2 ? back : (best > 0 ? P[best - 1] : null);
        while (i < P.length && walked < lookahead + 2 * step) {
            const nx = P[i][0], ny = P[i][1], seg = Math.hypot(nx - cur[0], ny - cur[1]);
            if (seg >= need) {
                const f = need / seg;
                cur = [cur[0] + f * (nx - cur[0]), cur[1] + f * (ny - cur[1])];
                pts.push(cur); walked += need; need = step;
            } else { need -= seg; walked += seg; cur = [nx, ny]; i++; }
        }
        const radius = (/** @type {number[]} */ a, /** @type {number[]} */ b, /** @type {number[]} */ c) => {
            const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
            const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
            return cross < 1e-9 ? Infinity : (ab * bc * ca) / (2 * cross);
        };
        if (behind && pts.length >= 2) { const r = radius(behind, pts[0], pts[1]); out.curvatureHere = Number.isFinite(r) ? 1 / r : 0; }
        let rMin = Infinity;
        for (let k = 1; k + 1 < pts.length; k++) rMin = Math.min(rMin, radius(pts[k - 1], pts[k], pts[k + 1]));
        out.radiusAhead = pts.length >= 3 ? rMin : null;
        return out;
    }

    return { GATE, ADVICE, WET_CODES, isWetWeather, createGateState, evaluateGate, noteAdvice, repeatedTooSoon, ecoAdvice, routeCurvature };
});
