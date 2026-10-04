// @ts-check
/* ============================================================================
   MapUnite HUD — the live estimator behind the SmartDrive head-up display
   ==============================================================================
   createLiveEstimator(physics, model, opts).push(fix) → state

   Pure (no DOM, no timers), strict SI in and out: speed m/s, acceleration m/s²,
   fuel m³ (petrol) or battery energy J (EV), distance m, time s, money in the
   rider's currency. The HUD converts at its edge.

   Each accepted GPS fix (≈ 1 Hz) gives a speed and the distance since the last
   one. From that:
     - acceleration: least-squares slope of speed over the last ~4 s, clamped to
       ±4 m/s² (GPS speed is noisy; one sample can't make a 1 g launch);
     - fuel (or battery) RATE right now: the physics operating point at this
       speed, acceleration and road grade (overrun fuel cut and EV regeneration
       included); a demand beyond the engine's power is capped at full throttle;
       standing still = idling, until 3 min (then the engine is assumed off);
     - live km/L (Wh/km): distance ÷ fuel over the last ~6 s, so it reads steady;
     - eco band: the bike's best-economy speeds on THIS grade (cruise table,
       cached per 1 % grade bucket), clamped to the posted limit when known;
     - eco score, per metre: the best fuel per metre possible on this grade ÷
       what this metre actually cost (1 = as efficient as the bike can be),
       averaged over the trip by distance;
     - harsh events: accelerating > 2.5 m/s² or braking < −3.5 m/s² for ≥ 1 s;
     - trip totals, cost, what's left in the tank and the range it gives
       (recent consumption, ~5 km memory).
   A learned correction (real ÷ physics from the fuel learner) can scale every
   fuel figure; the HUD says when it does.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUHud || (/** @type {any} */ (root).MUHud = {}); ns.live = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const LIVE_DEFAULTS = Object.freeze({
        accelWindow: 4,         // s of speed history for the acceleration slope
        accelMax: 4,            // m/s² clamp
        displayWindow: 6,       // s for the live km/L
        maxGap: 5,              // s: a longer gap between fixes isn't integrated across (tunnel, phone asleep)
        idleCutoff: 180,        // s standing still before the engine is assumed off
        moving: 0.8,            // m/s: below this the bike is standing
        steadyAccel: 0.6,       // m/s²: |a| below this counts as steady riding
        harshAccel: 2.5, harshBrake: -3.5, harshHold: 1,
        rangeMemory: 5000,      // m of recent riding behind the range figure
        gradeStep: 0.01,
        chargeEfficiency: 0.88
    });

    /**
     * @typedef {{ t: number, v: number|null, dist?: number, grade?: number, accepted?: boolean, limit?: number|null }} Fix
     *   t: ms timestamp; v: speed m/s; dist: m since the previous fix; grade: rise/run here (route profile);
     *   limit: posted speed limit m/s (OpenStreetMap), if known.
     * @typedef {{ low: number, high: number, best: number, bestPm: number }} EcoBand
     */

    /**
     * @param {any} physics MUPhysics
     * @param {any} model   BikeModel
     * @param {{ price?: number|null, correction?: number, capacity?: number|null, level?: number|null, altitude?: number }} [o]
     *   price: currency per m³ of fuel, or per J from the wall (EV) — already SI;
     *   correction: learned real ÷ physics (1 = physics as is); capacity: tank m³ / usable battery J;
     *   level: share of capacity at the start.
     */
    function createLiveEstimator(physics, model, o = {}) {
        const D = LIVE_DEFAULTS;
        const ev = model.powertrain === "ev";
        const k = Number.isFinite(o.correction) && /** @type {number} */ (o.correction) > 0 ? /** @type {number} */ (o.correction) : 1;
        const env0 = { altitude: Number.isFinite(o.altitude) ? o.altitude : 0 };
        const capacity = Number.isFinite(o.capacity) && /** @type {number} */ (o.capacity) > 0 ? /** @type {number} */ (o.capacity) : null;
        const startLevel = capacity && Number.isFinite(o.level) ? Math.max(0, Math.min(1, /** @type {number} */ (o.level))) : null;
        /** @type {Map<number, EcoBand|null>} */ const bands = new Map();
        const hist = [];                      // { t (s), v }
        const recent = [];                    // { t (s), d, e } for the live figure
        let last = null;                      // previous fix
        let idleFor = 0;
        let harsh = { accel: 0, brake: 0 }, harshRun = 0, harshKind = "";
        const trip = { distance: 0, time: 0, moving: 0, energy: 0, ecoMetres: 0, ecoWeighted: 0, maxSpeed: 0, idleTime: 0, startedAt: null, endedAt: null };
        let rangePm = null;                   // recent average energy per metre (EMA over rangeMemory)
        let state = null;
        let idleRate = null;

        /**
         * Eco band on this grade (cached per bucket). Downhill the engine is mostly on overrun (fuel
         * cut) or regenerating, so "best speed" stops meaning anything: descents use the flat band.
         */
        function band(grade) {
            const key = Math.round(Math.max(0, grade) / D.gradeStep);
            if (!bands.has(key)) {
                let b = null;
                try {
                    const t = physics.cruiseTable(model, { ...env0, grade: key * D.gradeStep }, { sigma: false, step: 0.5 });
                    if (t.eco) b = { low: t.eco.speedLow, high: t.eco.speedHigh, best: t.eco.speedBest, bestPm: t.eco.perMetreBest };
                } catch { b = null; }
                bands.set(key, b);
            }
            return bands.get(key);
        }

        /** Energy rate (m³/s or W) at v, a, grade — the physics, capped at full throttle. */
        function rateAt(v, a, grade) {
            if (v < D.moving) {
                if (idleRate === null) { const op0 = physics.operatingPoint(model, 0, env0); idleRate = ev ? op0.batteryPower : op0.fuelRate; }
                return idleRate;
            }
            const op = physics.operatingPoint(model, v, { ...env0, accel: a, grade });
            let r = ev ? op.batteryPower : op.fuelRate;
            if (!op.feasible && op.reason === "power") {
                const need = ev ? op.batteryPower : op.enginePower;
                if (need > 0 && op.availablePower > 0) r *= Math.min(1, op.availablePower / need);   // full throttle, not more
            }
            return Math.max(ev ? -Infinity : 0, r);
        }

        /** Least-squares slope of speed over the window. */
        function slope() {
            const n = hist.length;
            if (n < 2) return 0;
            let st = 0, sv = 0, stt = 0, stv = 0;
            for (const p of hist) { st += p.t; sv += p.v; stt += p.t * p.t; stv += p.t * p.v; }
            const den = n * stt - st * st;
            if (Math.abs(den) < 1e-9) return 0;
            const a = (n * stv - st * sv) / den;
            return Math.max(-D.accelMax, Math.min(D.accelMax, a));
        }

        /**
         * One fix in, the new state out.
         * @param {Fix} f
         */
        function push(f) {
            if (!f || f.accepted === false || !Number.isFinite(f.t)) return state;
            const ts = f.t / 1000;
            const v = Number.isFinite(f.v) && /** @type {number} */ (f.v) >= 0 ? /** @type {number} */ (f.v) : (last ? last.v : 0);
            const grade = Number.isFinite(f.grade) ? Math.max(-0.25, Math.min(0.25, /** @type {number} */ (f.grade))) : 0;
            if (trip.startedAt === null) trip.startedAt = f.t;
            const dtRaw = last ? ts - last.ts : 0;
            const dt = dtRaw > 0 && dtRaw <= D.maxGap ? dtRaw : 0;
            hist.push({ t: ts, v });
            while (hist.length && ts - hist[0].t > D.accelWindow) hist.shift();
            const a = slope();
            const r = rateAt(v, a, grade) * k;
            // integrate (trapezoid on rate, distance as reported or v·dt)
            let e = 0, d = 0;
            if (dt > 0) {
                const rPrev = last ? last.r : r;
                const standing = v < D.moving && last.v < D.moving;
                if (standing) {
                    idleFor += dt;
                    if (idleFor <= D.idleCutoff) { e = r * dt; trip.idleTime += dt; }
                } else {
                    idleFor = 0;
                    e = 0.5 * (r + rPrev) * dt;
                }
                d = Number.isFinite(f.dist) && /** @type {number} */ (f.dist) >= 0 ? /** @type {number} */ (f.dist) : 0.5 * (v + last.v) * dt;
                if (d > 120 * dt) d = 0.5 * (v + last.v) * dt;                       // a teleport: trust speed instead
                trip.time += dt;
                if (!standing) trip.moving += dt;
                trip.distance += d;
                trip.energy += e;
            }
            if (v > trip.maxSpeed) trip.maxSpeed = v;
            trip.endedAt = f.t;
            // eco band (posted limit wins) + this stretch's eco score
            let eb = band(grade);
            const limit = Number.isFinite(f.limit) && /** @type {number} */ (f.limit) > 0 ? /** @type {number} */ (f.limit) : null;
            if (eb && limit !== null && eb.high > limit) eb = limit < eb.low ? { ...eb, low: limit, high: limit } : { ...eb, high: limit };
            if (d > 0 && eb && eb.bestPm > 0) {
                const pm = e / d;
                const score = pm <= 0 ? 1 : Math.max(0, Math.min(1, (eb.bestPm * k) / pm));
                trip.ecoWeighted += score * d; trip.ecoMetres += d;
            }
            // harsh events (held for ≥ harshHold s)
            const kind = a >= D.harshAccel ? "accel" : a <= D.harshBrake ? "brake" : "";
            if (kind && kind === harshKind) { const before = harshRun; harshRun += dt; if (before < D.harshHold && harshRun >= D.harshHold) harsh[kind]++; }
            else { harshKind = kind; harshRun = kind ? dt : 0; if (kind && harshRun >= D.harshHold) harsh[kind]++; }
            // live figure
            recent.push({ t: ts, d, e });
            while (recent.length && ts - recent[0].t > D.displayWindow) recent.shift();
            const rd = recent.reduce((s, x) => s + x.d, 0), re = recent.reduce((s, x) => s + x.e, 0);
            // range memory
            if (d > 0) {
                const pm = e / d;
                const w = Math.min(1, d / D.rangeMemory);
                rangePm = rangePm === null ? pm : rangePm + (pm - rangePm) * w;
            }
            const left = capacity !== null && startLevel !== null ? Math.max(0, startLevel * capacity - trip.energy) : null;
            const mode = v < D.moving ? (idleFor > D.idleCutoff ? "off" : "idle") : r <= 0 ? (ev && r < 0 ? "regen" : "coast") : a > D.steadyAccel ? "accel" : a < -D.steadyAccel ? "slow" : "cruise";
            state = {
                t: f.t, v, a, grade, mode, rate: r,
                perMetre: v >= D.moving ? r / v : null,
                live: rd > 5 ? re / rd : null,                    // m³/m or J/m over the display window
                eco: eb ? { low: eb.low, high: eb.high, best: eb.best, bestPm: eb.bestPm * k, inBand: v >= eb.low - 0.3 && v <= eb.high + 0.3, steady: Math.abs(a) < D.steadyAccel, above: v > eb.high + 0.3, below: v < eb.low - 0.3 } : null,
                limit,
                trip: {
                    ...trip,
                    ecoScore: trip.ecoMetres > 50 ? trip.ecoWeighted / trip.ecoMetres : null,
                    perMetre: trip.distance > 50 ? trip.energy / trip.distance : null,
                    harsh: { ...harsh },
                    cost: Number.isFinite(o.price) ? (ev ? Math.max(0, trip.energy) / D.chargeEfficiency : trip.energy) * /** @type {number} */ (o.price) : null
                },
                tank: capacity !== null && startLevel !== null ? { left, share: left / capacity, range: rangePm && rangePm > 0 ? left / rangePm : null } : null,
                corrected: k !== 1, correction: k, powertrain: model.powertrain
            };
            last = { ts, v, r };
            return state;
        }

        return { push, band, get state() { return state; } };
    }

    /**
     * The pitstop line for the HUD (pure).
     * @param {{ progress: number|null, remaining: number|null, range: number|null, stops?: Array<{ s: number, name: string, mine: boolean }> }} x
     *   progress: m along the route; remaining: m to the destination; range: m to the reserve; stops: planned (convoy) stops on this route
     * @returns {null | { level: "info"|"warn"|"critical", kind: "stop"|"refuel"|"reserve", distance: number, name: string|null, mine: boolean }}
     */
    function pitstopAlert(x) {
        const next = x.progress !== null && x.stops ? x.stops.filter((st) => st.s > x.progress + 50).sort((a, b) => a.s - b.s)[0] : null;
        if (x.range !== null && x.range < 3000) return { level: "critical", kind: "reserve", distance: Math.max(0, x.range), name: next ? next.name : null, mine: true };
        if (next && x.progress !== null) {
            const dd = next.s - x.progress;
            if (dd < 60000) return { level: dd < 5000 ? "warn" : "info", kind: "stop", distance: dd, name: next.name, mine: next.mine };
        }
        if (x.range !== null && (x.remaining === null || x.range < x.remaining)) {
            if (x.range < 50000) return { level: x.range < 15000 ? "critical" : x.range < 30000 ? "warn" : "info", kind: "refuel", distance: x.range, name: null, mine: true };
        }
        return null;
    }

    return { LIVE_DEFAULTS, createLiveEstimator, pitstopAlert };
});
