// @ts-check
/* ============================================================================
   MapUnite insights — the rider's learned fuel curve against the physics
   ==============================================================================
   Pure, strict SI: speeds in m/s, fuel in m³, fuel per metre in m³/m, distance
   in m, time in s, fuel rate in m³/s. The UI converts at its edge (km/h, km/L,
   L) through garage/units.js.

     snapshotFromLearner(FuelCurve, globals)  the SmartDrive learner (km/L, litres,
                                              km/h) turned into SI — the ONLY place
                                              that knows the learner's units
     physicsCurve(physics, model)             the bike's flat-road baseline + ±1σ
     compare(snapshot, physicsCurve)          everything the dashboard draws:
                                              curves, per-band ratios, each full
                                              tank predicted three ways (physics,
                                              starting curve, learned) against the
                                              pump, accuracy, and findings

   The learner (js/smartdrive.js FuelCurve) learns one multiplier β per speed band
   (and one for idling) on top of its starting curve: fuel per metre at speed v
   in band j = starting(v) × β_j. Its bands, starting curve and β are read from
   the learner itself, so a learner whose starting curve is the physics (Step 7)
   needs no change here.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUInsights || (/** @type {any} */ (root).MUInsights = {}); ns.fuel = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const KMH = 1 / 3.6;
    /** The learner's speed bands (m/s). `mid` is used when the data can't place the band's speed. */
    const DEFAULT_BANDS = Object.freeze([
        Object.freeze({ label: "Under 40", lo: 0, hi: 40 * KMH, mid: 25 * KMH }),
        Object.freeze({ label: "40–60", lo: 40 * KMH, hi: 60 * KMH, mid: 50 * KMH }),
        Object.freeze({ label: "60–80", lo: 60 * KMH, hi: 80 * KMH, mid: 70 * KMH }),
        Object.freeze({ label: "Over 80", lo: 80 * KMH, hi: 140 * KMH, mid: 95 * KMH })
    ]);
    const INSIGHT_DEFAULTS = Object.freeze({
        enoughDistance: 50000,   // m of usable riding in a band before we say anything about it
        gapWorth: 0.12,          // a band's real use must differ from physics by ≥ 12 % to be called out
        minSpeed: 2              // m/s: chart starts here (fuel per metre → ∞ at standstill)
    });

    /**
     * Band index for speed v (m/s), matching the learner's own rule (fuelBandIndex: <40, ≤60, ≤80, above).
     * @param {number} v @param {ReadonlyArray<{ hi: number }>} [bands]
     */
    function bandIndex(v, bands = DEFAULT_BANDS) {
        for (let j = 0; j < bands.length - 1; j++) {
            const upper = bands[j].hi;
            if (j === 0 ? v < upper - 1e-9 : v <= upper + 1e-9) return j;     // <40 | ≤60 | ≤80 | above
        }
        return bands.length - 1;
    }

    /**
     * The speed a band was actually ridden at, from the learner's per-band totals:
     * shapeKm = Σ km / shape(v), bandKm = Σ km  →  the distance-weighted harmonic mean
     * of shape(v) is bandKm / shapeKm; invert the starting curve's shape inside the band.
     * @param {(kmh: number) => number} shape  the learner's shape function (km/h → fraction)
     * @param {{ lo: number, hi: number, mid: number }} band  m/s
     * @param {number} bandKm  @param {number} shapeKm
     * @returns {number} m/s
     */
    function bandSpeed(shape, band, bandKm, shapeKm) {
        if (typeof shape !== "function" || !(bandKm > 0) || !(shapeKm > 0)) return band.mid;
        const target = bandKm / shapeKm;
        let a = Math.max(band.lo, 2), b = band.hi;
        const fa = shape(a * 3.6) - target, fb = shape(b * 3.6) - target;
        if (!Number.isFinite(fa) || !Number.isFinite(fb) || fa * fb > 0 || Math.abs(shape(a * 3.6) - shape(b * 3.6)) < 1e-6) return band.mid;
        for (let i = 0; i < 50; i++) {
            const m = 0.5 * (a + b), fm = shape(m * 3.6) - target;
            if ((fm > 0) === (fa > 0)) a = m; else b = m;
        }
        return 0.5 * (a + b);
    }

    /**
     * @typedef {{ fromTs: number, toTs: number, fuel: number, fuelAdj: number, distance: number, bandDistance: number[],
     *   bandSpeed: number[], idleTime: number, coverage: number|null, usable: boolean, reason: string,
     *   learnedFuel: number|null, startFuel: number }} Tank
     * @typedef {{
     *   bands: ReadonlyArray<{ label: string, lo: number, hi: number, mid: number }>,
     *   start: (v: number) => number, beta: number[]|null,
     *   startIdleRate: number, learnedIdleRate: number|null,
     *   status: { usable: number, needed: number, ready: boolean, enabled: boolean, active: boolean, mape: number|null, startMape: number|null },
     *   tanks: Tank[], fills: Array<{ ts: number, fuel: number, full: boolean, odometer: number|null }>,
     *   learned: (v: number) => number|null
     * }} Snapshot
     *  start(v): the learner's starting curve, fuel per metre (m³/m) at v (m/s).
     *  learned(v): start(v) × β of v's band; null before the learner has fitted anything.
     */

    /**
     * Read the SmartDrive learner (km/L, litres, km, hours) into SI.
     * @param {any} FC  the FuelCurve object
     * @param {any} [g]  where the learner's helpers live (fuelShape, FUEL_BANDS, IDLE_L_PER_HOUR); default globalThis
     * @returns {Snapshot}
     */
    function snapshotFromLearner(FC, g = globalThis) {
        if (!FC || typeof FC.intervals !== "function") throw new Error("snapshotFromLearner needs the FuelCurve learner");
        const shape = typeof g.fuelShape === "function" ? g.fuelShape : () => 1;
        const rated = typeof FC.rated === "function" ? Number(FC.rated()) || 18 : 18;            // km/L
        const idleLh = Number.isFinite(g.IDLE_L_PER_HOUR) ? g.IDLE_L_PER_HOUR : 0.4;            // L/h
        const bands = DEFAULT_BANDS;                                                             // = FUEL_BANDS in smartdrive.js
        // starting curve: the learner's own if it exposes one (km/L at km/h), else rated × shape
        const startKmPerL = typeof FC.priorKmPerL === "function" ? (kmh) => FC.priorKmPerL(kmh) : (kmh) => rated * shape(kmh);
        const start = (v) => { const k = startKmPerL(v * 3.6); return k > 0 ? 1 / (k * 1e6) : Infinity; };
        const fit = FC.fit || null;
        const beta = fit && Array.isArray(fit.beta) ? fit.beta.slice() : null;
        const ivs = fit && Array.isArray(fit.intervals) ? fit.intervals : FC.intervals();
        const design = (iv) => (typeof FC.design === "function" ? FC.design(iv, rated) : [0, 1, 2, 3].map((j) => (iv.shape[j] || 0) / rated).concat([(iv.idleH || 0) * idleLh]));
        const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
        /** @type {Tank[]} */
        const tanks = ivs.map((iv) => {
            const row = design(iv);
            const bandKm = [0, 1, 2, 3].map((j) => Number(iv.bandKm && iv.bandKm[j]) || 0);
            return {
                fromTs: iv.fromTs, toTs: iv.toTs,
                fuel: iv.litres / 1000, fuelAdj: (Number.isFinite(iv.litresAdj) ? iv.litresAdj : iv.litres) / 1000,
                distance: (iv.km || 0) * 1000,
                bandDistance: bandKm.map((k) => k * 1000),
                bandSpeed: bands.map((b, j) => bandSpeed(shape, b, bandKm[j], Number(iv.shape && iv.shape[j]) || 0)),
                idleTime: (iv.idleH || 0) * 3600,
                coverage: Number.isFinite(iv.coverage) ? iv.coverage : null,
                usable: !!iv.usable, reason: iv.reason || "",
                learnedFuel: beta ? dot(row, beta) / 1000 : null,
                startFuel: dot(row, [1, 1, 1, 1, 1]) / 1000
            };
        });
        const st = FC.state || {};
        return {
            bands, start, beta,
            startIdleRate: idleLh / 1000 / 3600,
            learnedIdleRate: beta ? (idleLh * beta[4]) / 1000 / 3600 : null,
            status: {
                usable: fit ? fit.usable || 0 : 0, needed: FC.MIN_INTERVALS || 3, ready: !!(fit && fit.ready),
                enabled: st.enabled !== false, active: typeof FC.active === "function" ? !!FC.active() : false,
                mape: fit && Number.isFinite(fit.mape) ? fit.mape : null, startMape: fit && Number.isFinite(fit.priorMape) ? fit.priorMape : null
            },
            tanks,
            fills: (Array.isArray(st.fills) ? st.fills : []).map((f) => ({ ts: f.ts, fuel: f.litres / 1000, full: f.full !== false, odometer: Number.isFinite(f.odometerKm) ? f.odometerKm * 1000 : null })),
            learned: (v) => (beta ? start(v) * beta[bandIndex(v, bands)] : null)
        };
    }

    /**
     * The bike's flat-road baseline from the physics core.
     * @param {any} physics  MUPhysics  @param {any} model  BikeModel (petrol)  @param {any} [env]
     */
    function physicsCurve(physics, model, env = {}) {
        if (model.powertrain === "ev") throw new Error("the fuel learner is for petrol bikes");
        const t = physics.cruiseTable(model, { grade: 0, ...env }, { step: 0.5, vMin: 0 });
        const idle = physics.operatingPoint(model, 0, { grade: 0, ...env });
        return { speed: t.speed, pm: t.perMetre, lo: t.perMetreLo, hi: t.perMetreHi, feasible: t.feasible, idleRate: idle.fuelRate || 0, eco: t.eco };
    }

    /** Linear interpolation of a table column at speed v (rows evenly spaced from speed[0]). */
    function at(speed, col, v) {
        const n = speed.length, step = n > 1 ? speed[1] - speed[0] : 1;
        let x = (v - speed[0]) / step;
        if (x <= 0) return col[0];
        if (x >= n - 1) return col[n - 1];
        const i = Math.floor(x), w = x - i;
        return col[i] + (col[i + 1] - col[i]) * w;
    }

    /**
     * Everything the dashboard needs, in SI.
     * @param {Snapshot} s  @param {ReturnType<typeof physicsCurve>|null} p  null when no bike is chosen
     * @param {Partial<typeof INSIGHT_DEFAULTS>} [o]
     */
    function compare(s, p, o = {}) {
        const O = { ...INSIGHT_DEFAULTS, ...o };
        const physAt = p ? (v) => at(p.speed, p.pm, v) : () => null;
        // ---- curves (chart rows) ----
        const rows = [];
        if (p) {
            for (let i = 0; i < p.speed.length; i++) {
                const v = p.speed[i];
                if (v < O.minSpeed - 1e-9) continue;
                rows.push({ v, phys: p.pm[i], physLo: p.lo[i], physHi: p.hi[i], feasible: !!p.feasible[i], start: s.start(v), learned: s.learned(v), band: bandIndex(v, s.bands) });
            }
        } else {
            for (let v = O.minSpeed; v <= 100 / 3.6 + 1e-9; v += 0.5) rows.push({ v, phys: null, physLo: null, physHi: null, feasible: true, start: s.start(v), learned: s.learned(v), band: bandIndex(v, s.bands) });
        }
        // ---- tanks: three predictions against the pump ----
        const tanks = s.tanks.map((t) => {
            let physics = null;
            if (p) {
                physics = t.idleTime * p.idleRate;
                for (let j = 0; j < t.bandDistance.length; j++) physics += t.bandDistance[j] * physAt(t.bandSpeed[j]);
            }
            const err = (x) => (x === null || !(t.fuelAdj > 0) ? null : (x - t.fuelAdj) / t.fuelAdj);
            return { ...t, physics, errPhysics: err(physics), errLearned: err(t.learnedFuel), errStart: err(t.startFuel) };
        });
        const usable = tanks.filter((t) => t.usable);
        const mape = (key) => {
            const xs = usable.map((t) => t[key]).filter((x) => x !== null && Number.isFinite(x));
            return xs.length ? xs.reduce((a, x) => a + Math.abs(x), 0) / xs.length : null;
        };
        const accuracy = { physics: p ? mape("errPhysics") : null, learned: s.beta ? mape("errLearned") : null, start: mape("errStart"), tanks: usable.length };
        // ---- bands ----
        const bandDist = s.bands.map((_, j) => usable.reduce((a, t) => a + (t.bandDistance[j] || 0), 0));
        const totalDist = bandDist.reduce((a, b) => a + b, 0);
        const bands = s.bands.map((b, j) => {
            // the speed this band was ridden at, weighted by distance; mid when there's no data
            let v = b.mid;
            if (bandDist[j] > 0) v = usable.reduce((a, t) => a + (t.bandDistance[j] || 0) * t.bandSpeed[j], 0) / bandDist[j];
            const phys = p ? physAt(v) : null, learned = s.learned(v), start = s.start(v);
            const ratio = phys && learned ? learned / phys : null;
            return { ...b, v, distance: bandDist[j], share: totalDist > 0 ? bandDist[j] / totalDist : 0, phys, learned, start, ratio, enough: bandDist[j] >= O.enoughDistance };
        });
        // overall: your real fuel ÷ physics fuel over the riding you actually did
        let overall = null;
        if (p && s.beta && totalDist > 0) {
            let a = 0, b = 0;
            for (const bd of bands) if (bd.distance > 0 && bd.phys && bd.learned) { a += bd.learned * bd.distance; b += bd.phys * bd.distance; }
            overall = b > 0 ? a / b : null;
        }
        // ---- findings (structured; the UI words them) ----
        /** @type {Array<{ kind: string, band?: number, ratio?: number, v?: number, value?: number, need?: number }>} */
        const findings = [];
        const st = s.status;
        if (st.usable < st.needed) findings.push({ kind: "need-tanks", need: st.needed - st.usable });
        if (overall !== null) findings.push({ kind: "overall", ratio: overall });
        if (p && s.beta) {
            const gaps = bands.map((b, j) => ({ b, j })).filter(({ b }) => b.enough && b.ratio !== null && Math.abs(b.ratio - 1) >= O.gapWorth);
            gaps.sort((x, y) => Math.abs(y.b.ratio - 1) - Math.abs(x.b.ratio - 1));
            for (const { b, j } of gaps.slice(0, 2)) findings.push({ kind: b.ratio > 1 ? "band-worse" : "band-better", band: j, ratio: b.ratio, v: b.v });
        }
        if (s.beta) {
            const ridden = bands.map((b, j) => ({ b, j })).filter(({ b }) => b.enough && b.learned);
            if (ridden.length >= 2) {
                const best = ridden.reduce((x, y) => (y.b.learned < x.b.learned ? y : x));
                findings.push({ kind: "best-band", band: best.j, value: best.b.learned, v: best.b.v });
            }
        }
        if (accuracy.physics !== null && accuracy.learned !== null && accuracy.tanks >= 2) findings.push({ kind: "accuracy", value: accuracy.learned, ratio: accuracy.physics });
        // idling: only when the learner actually pinned it down (a multiplier stuck at its bound means
        // the fill-ups couldn't separate idling from riding — saying "0 L/h" would be nonsense)
        const idleKnown = s.beta && s.beta[4] > 0.05 && s.beta[4] < 4.95;
        if (p && idleKnown && s.learnedIdleRate !== null && p.idleRate > 0) {
            const r = s.learnedIdleRate / p.idleRate;
            if (Math.abs(r - 1) >= 0.3) findings.push({ kind: "idle", ratio: r, value: s.learnedIdleRate });
        }
        return { rows, tanks, accuracy, bands, overall, findings, totalDistance: totalDist, physIdleRate: p ? p.idleRate : null, eco: p ? p.eco : null };
    }

    return { DEFAULT_BANDS, INSIGHT_DEFAULTS, bandIndex, bandSpeed, snapshotFromLearner, physicsCurve, compare, at };
});
