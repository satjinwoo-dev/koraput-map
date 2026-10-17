// @ts-check
/* ============================================================================
   MapUnite RoadPulse — speed-aware hazard alerts (Confirmed Decision 4)
   ==============================================================================
   When to warn a rider about a hazard ahead, calmly and once:

     d_alert = v·(t_speech + t_react) + max(0, v² − v_t²) / (2·a_c) + max(10 m, 2σ_GNSS),  clamped 50 … 300 m
       t_speech  how long the warning line takes to say (the voice's own line, measured by
                 master-app from its length: an 18+ line is longer than a Family one); 2 s default
       t_react   1 s        reacting once it's said
       a_c       1.5 m/s²   gentle slowing, far below the 3.5 m/s² "hard brake" of DynamicsCore
       v_t       the speed to be down to at the hazard: 20 km/h (severity 3), 30 km/h (severity 2)

     → about 50 m at 20 km/h, 75 m at 40, 140 m at 60, 230 m at 80 (severity 3, a 2 s line).
     NOT FINAL: every constant here is a design prior until the pilot's field tests.
   Turn instructions come first: hazard lines are spoken at a lower priority (68) than
   navigation's turn prompts (70–72), so a queued turn prompt is never pushed back or cut
   off, and a hazard line that waited too long is dropped (the warning max age).

   A hazard is warned only when:
     - it's alertable (reported or active; never disputed, maybe fixed, fixed, expired);
     - it lies ahead on the rider's line: along the heading, |lateral| ≤ 25 m, and
       its direction matches (±45°, or it's marked both ways);
     - the fix is good (σ ≤ 30 m): with a poor fix, one generic "hazards reported
       on this stretch" instead of a distance that may be wrong;
     - it isn't beyond the next turn (the straight-line projection is wrong there;
       it's picked up after the turn);
     - the rider is moving (≥ 8 km/h) and it isn't already too close to act on
       (less than 1 s away: a voice then only startles).
   No spam: each hazard once per approach; the hazards within 300 m after the first
   become ONE alert ("3 hazards in the next 400 m"); at least 15 s between alerts.
   The words never say "brake": "slow down gradually and watch the road".
   All numbers are design priors (basis: prior), to be tuned in the pilot.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); const M = W.MUMaster || (W.MUMaster = {}); M.roadAlerts = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const KMH = 1 / 3.6;
    const POLICY = Object.freeze({
        speechS: 2.0, reactS: 1.0, comfortMs2: 1.5,
        targetMs: Object.freeze({ 3: 20 * KMH, 2: 30 * KMH, 1: 30 * KMH }),
        minM: 50, maxM: 300, gpsFloorM: 10,
        halfWidthM: 25, headingTolDeg: 45, maxPosSigmaM: 30,
        minSpeedMs: 8 * KMH, tooCloseS: 1,
        clusterM: 300, minGapMs: 15000, repeatMs: 60000
    });
    const M_PER_DEG = 111320;

    /** @param {{ speedMs: number, severity?: number, posSigmaM?: number|null, speechS?: number|null }} o @param {typeof POLICY} [P] */
    function alertDistanceM(o, P = POLICY) {
        const v = Math.max(0, o.speedMs || 0);
        const vt = /** @type {any} */ (P.targetMs)[o.severity || 2] ?? P.targetMs[2];
        const gps = Math.max(P.gpsFloorM, 2 * (Number.isFinite(o.posSigmaM) ? /** @type {number} */ (o.posSigmaM) : 0));
        const speech = Number.isFinite(o.speechS) && /** @type {number} */ (o.speechS) > 0 ? /** @type {number} */ (o.speechS) : P.speechS;
        const d = v * (speech + P.reactS) + Math.max(0, v * v - vt * vt) / (2 * P.comfortMs2) + gps;
        return Math.round(Math.min(P.maxM, Math.max(P.minM, d)));
    }

    const headingDiff = (/** @type {number} */ a, /** @type {number} */ b) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };

    /**
     * Where a hazard is relative to the rider: metres along the heading and to the side.
     * @param {{ lat: number, lng: number, headingDeg: number }} e @param {{ lat: number, lng: number }} h
     */
    function relative(e, h) {
        const north = (h.lat - e.lat) * M_PER_DEG, east = (h.lng - e.lng) * M_PER_DEG * Math.cos(e.lat * Math.PI / 180);
        const th = e.headingDeg * Math.PI / 180;
        return { along: north * Math.cos(th) + east * Math.sin(th), lateral: -north * Math.sin(th) + east * Math.cos(th) };
    }

    /**
     * A planner with memory (what was said, when). plan() is called once a second with the rider's state and the
     * candidate hazards; it returns at most one alert.
     * @param {{ policy?: Partial<typeof POLICY> }} [o]
     */
    function createPlanner(o = {}) {
        const P = /** @type {typeof POLICY} */ ({ ...POLICY, ...(o.policy || {}) });
        /** @type {Map<string, number>} */ const saidAt = new Map();
        let lastAlertAt = -Infinity, genericAt = -Infinity;

        /**
         * @param {{ lat: number, lng: number, headingDeg: number, speedMs: number, posSigmaM?: number|null, nextTurnM?: number|null, speechS?: number|null }} ego
         * @param {{ id: string, lat: number, lng: number, heading?: number|null, bothWays?: boolean, severity?: number, alertable?: boolean, ptype?: string }[]} hazards
         * @param {number} now
         * @returns {null | { kind: "single"|"cluster"|"generic", first: any, distanceM: number, count: number, spanM: number, hazards: any[], alertM: number }}
         */
        function plan(ego, hazards, now) {
            if (!ego || !Number.isFinite(ego.lat) || !Number.isFinite(ego.lng) || !Number.isFinite(ego.headingDeg)) return null;
            if (!(ego.speedMs >= P.minSpeedMs)) return null;
            if (now - lastAlertAt < P.minGapMs) return null;
            const poorFix = Number.isFinite(ego.posSigmaM) && /** @type {number} */ (ego.posSigmaM) > P.maxPosSigmaM;
            const ahead = [];
            for (const h of hazards || []) {
                if (!h || h.alertable === false || !Number.isFinite(h.lat) || !Number.isFinite(h.lng)) continue;
                if (!h.bothWays && Number.isFinite(h.heading) && headingDiff(/** @type {number} */ (h.heading), ego.headingDeg) > P.headingTolDeg) continue;
                const r = relative(ego, h);
                if (r.along <= 0 || r.along > P.maxM + P.clusterM || Math.abs(r.lateral) > P.halfWidthM) continue;
                if (Number.isFinite(ego.nextTurnM) && r.along > /** @type {number} */ (ego.nextTurnM)) continue;
                ahead.push({ h, along: r.along });
            }
            if (!ahead.length) return null;
            ahead.sort((a, b) => a.along - b.along);
            if (poorFix) {
                // one calm generic line per stretch, no distance that may be wrong
                if (now - genericAt < P.repeatMs * 5) return null;
                const near = ahead.filter((x) => x.along <= P.maxM);
                if (!near.length) return null;
                genericAt = now; lastAlertAt = now;
                for (const x of near) saidAt.set(x.h.id, now);
                return { kind: "generic", first: near[0].h, distanceM: 0, count: near.length, spanM: 0, hazards: near.map((x) => x.h), alertM: P.maxM };
            }
            // the nearest hazard not yet said whose alert distance has come
            const fresh = ahead.filter((x) => now - (saidAt.get(x.h.id) ?? -Infinity) >= P.repeatMs);
            if (!fresh.length) return null;
            const first = fresh[0];
            const alertM = alertDistanceM({ speedMs: ego.speedMs, severity: Math.max(...fresh.filter((x) => x.along - first.along <= P.clusterM).map((x) => x.h.severity || 2)), posSigmaM: ego.posSigmaM, speechS: ego.speechS }, P);
            if (first.along > alertM) return null;
            if (first.along < ego.speedMs * P.tooCloseS) { saidAt.set(first.h.id, now); return null; }      // too late to help: stay quiet
            const group = fresh.filter((x) => x.along - first.along <= P.clusterM);
            for (const x of group) saidAt.set(x.h.id, now);
            lastAlertAt = now;
            const distanceM = Math.max(10, Math.round(first.along / 10) * 10);
            const spanM = Math.round((group[group.length - 1].along - first.along + first.along) / 50) * 50;
            return { kind: group.length > 1 ? "cluster" : "single", first: first.h, distanceM, count: group.length, spanM: Math.max(spanM, distanceM), hazards: group.map((x) => x.h), alertM };
        }

        return { plan, POLICY: P, forget: () => { saidAt.clear(); lastAlertAt = -Infinity; genericAt = -Infinity; } };
    }

    /** How long a line takes to say: ≈ 14 characters a second (Hinglish or English TTS at normal rate). @param {string} text */
    const speechSeconds = (text) => Math.max(1.5, Math.round((String(text || "").length / 14) * 10) / 10);
    /** The voice priority of a hazard line: below navigation's turn prompts (70–72). */
    const PRIORITY = 68;

    return { POLICY, PRIORITY, alertDistanceM, createPlanner, relative, headingDiff, speechSeconds };
});
