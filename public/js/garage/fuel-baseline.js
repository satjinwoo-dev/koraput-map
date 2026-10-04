// @ts-check
/* ============================================================================
   MapUnite garage — the rider's bike as SmartDrive's fuel baseline
   ==============================================================================
   SmartDrive (js/smartdrive.js) prices every kilometre of a ride in litres. Its
   starting point used to be one number for everyone (18 km/L, or the rider's
   own guess) bent by a generic U-curve. When the rider has picked their bike in
   "My bike", this module turns the physics core's cruise table for that bike
   (with the rider's settings) into the same kind of baseline:

     kmPerL(kmh)       km/L at a steady speed on a flat road (standard atmosphere),
                       linear between the table's speeds, held at the last
                       speed the bike can sustain above it
     idleLPerHour      the engine's fuel at idle (Willans friction power), L/h
     referenceKmPerL   km/L over 40–60 km/h (fuel-weighted: the harmonic mean),
                       the band SmartDrive's "efficient drive" comparison uses
     eco               the physics eco band (km/h) and its best km/L, for display
     sigmaRel          ±1σ of the reference figure, relative
     payloadKg         rider + pillion + luggage the physics used (kg; for fleet records)

   The fill-up learner (FuelCurve) then learns the rider's per-band corrections
   ON TOP of this baseline, exactly as it did on top of the generic curve.

   The result is a plain object (a "snapshot") that SmartDrive keeps in
   localStorage, so the app starts with it synchronously and offline, without
   loading the physics. Display units (km/h, km/L, L/h) appear only here and in
   the UI; the physics stays SI.

   Fleet calibration (roadmap Step 11): when the bike's bundle carries a reviewed fleet
   calibration (bundle.calibration, from riders' shared fill-ups), its real-riding
   overhead λ — acceleration, stops, hills, wind, warm-up that a steady, flat-road
   model can't see — scales the moving fuel (km/L ÷ λ; idle is fitted separately
   and stays). Its uncertainty is added to sigmaRel. The snapshot then says so
   (`fleet`); without a calibration the snapshot is exactly as before.

   EVs have no litres: buildFuelBaseline() returns { kind: "ev" } and SmartDrive
   keeps its previous behaviour for them.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUGarage || (/** @type {any} */ (root).MUGarage = {}); ns.fuelBaseline = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const SNAPSHOT_FORMAT = 1;
    const REF_BAND = [40, 60];          // km/h: SmartDrive's "efficient" reference band
    const GRID_STEP_KMH = 0.5;          // the snapshot's speed grid (fine enough for the step at a low-speed gear change)

    /**
     * @typedef {{ format: 1, kind: "petrol", key: string, bikeTag: string, title: string, estimated: boolean,
     *   step: number, kmPerL: number[], idleLPerHour: number, referenceKmPerL: number, sigmaRel: number,
     *   eco: { fromKmh: number, toKmh: number, bestKmh: number, bestKmPerL: number } | null, vMaxKmh: number,
     *   fuelCode: string, flags: string[], payloadKg?: number, fleet?: FleetNote }} PetrolBaseline
     * @typedef {{ overhead: number, overheadSigma: number, date: string, tanks: number, riders: number }} FleetNote
     * @typedef {{ format: 1, kind: "ev", key: string, bikeTag: string, title: string, estimated: boolean }} EvBaseline
     * @typedef {PetrolBaseline | EvBaseline} FuelBaseline
     */

    /**
     * Identity of a garage entry for the baseline: changes whenever the bike, its
     * data (bundle hash) or the rider's settings change.
     * @param {{ bikeId: string|null, classKey: string, bundle: string, settings?: any }} g
     */
    function garageKey(g) {
        const s = g.settings || {};
        const keys = Object.keys(s).sort();
        return `${g.bundle}|${keys.map((k) => `${k}=${s[k]}`).join(",")}`;
    }
    /** Which vehicle fill-ups belong to: the bike's id, or the class for a typical bike. @param {{ bikeId: string|null, classKey: string }} g */
    const bikeTag = (g) => (g.bikeId ? `bike:${g.bikeId}` : `class:${g.classKey}`);

    /**
     * Build the baseline from a physics model.
     * @param {any} physics  MUPhysics
     * @param {any} model    physics.createBikeModel() result for the rider's bike and settings
     * @param {{ bikeId: string|null, classKey: string, bundle: string, settings?: any, title: string, estimated?: boolean }} garage
     * @param {{ calibration?: any }} [opts]  calibration: the bundle's fleet calibration (bundle.calibration), if any
     * @returns {FuelBaseline}
     */
    function buildFuelBaseline(physics, model, garage, opts = {}) {
        const base = { format: /** @type {1} */ (SNAPSHOT_FORMAT), key: garageKey(garage), bikeTag: bikeTag(garage), title: garage.title, estimated: Boolean(garage.estimated) };
        if (model.powertrain === "ev") return { ...base, kind: "ev" };
        const fleet = fleetNote(opts.calibration);
        const lambda = fleet ? fleet.overhead : 1;
        // the grid: the physics sampled exactly at every grid speed (fuel only, no ±1σ: fast)
        const g = physics.cruiseTable(model, {}, { step: GRID_STEP_KMH / 3.6, sigma: false });
        /** @type {number[]} */
        const grid = [];
        let last = -1;
        for (let i = 0; i < g.speed.length; i++) {
            const pm = g.perMetre[i];
            if (g.feasible[i] && pm > 0 && Number.isFinite(pm)) last = i;
        }
        if (last < 2) throw new Error(`${model.id}: the physics found no steady speed this bike can hold`);
        for (let i = 0; i <= last; i++) {
            const pm = g.perMetre[i];
            grid.push(g.feasible[i] && pm > 0 && Number.isFinite(pm) ? 1e-6 / (pm * lambda) : NaN);
        }
        // standstill and any speed the bike can't hold steadily (first gear's clutch region): the nearest held speed
        for (let i = 0; i < grid.length; i++) if (!Number.isFinite(grid[i])) grid[i] = nearestFinite(grid, i);
        const vMaxKmh = last * GRID_STEP_KMH;
        // the ±1σ band and the eco band: the standard table
        const t = physics.cruiseTable(model, {}, { step: 0.25 });
        /** @type {{ kmh: number, kmPerL: number, lo: number, hi: number }[]} */
        const rows = [];
        for (let i = 0; i < t.speed.length; i++) {
            const kmh = t.speed[i] * 3.6, pm = t.perMetre[i];
            if (kmh < 1 || !t.feasible[i] || !(pm > 0) || !Number.isFinite(pm)) continue;
            rows.push({ kmh, kmPerL: 1e-6 / (pm * lambda), lo: t.perMetreLo[i] > 0 ? 1e-6 / (t.perMetreHi[i] * lambda) : NaN, hi: t.perMetreLo[i] > 0 ? 1e-6 / (t.perMetreLo[i] * lambda) : NaN });
        }
        const snapGrid = { step: GRID_STEP_KMH, kmPerL: grid };
        const at = (/** @type {number} */ kmh) => kmPerLAt(/** @type {any} */ (snapGrid), kmh);
        const idle = physics.operatingPoint(model, 0);
        const idleLPerHour = idle.fuelRate * 3.6e6;           // m3/s → L/h
        const reference = harmonicMean(rows, REF_BAND[0], REF_BAND[1], at);
        const refLo = harmonicMean(rows, REF_BAND[0], REF_BAND[1], (k) => interp(rows, k, "lo"));
        const refHi = harmonicMean(rows, REF_BAND[0], REF_BAND[1], (k) => interp(rows, k, "hi"));
        const sigmaPhys = Number.isFinite(refLo) && Number.isFinite(refHi) && reference > 0 ? (refHi - refLo) / (2 * reference) : NaN;
        const sigmaRel = fleet ? Math.hypot(sigmaPhys, fleet.overheadSigma / fleet.overhead) : sigmaPhys;
        const e = t.eco;
        /** @type {PetrolBaseline} */
        const out = {
            ...base, kind: "petrol", step: GRID_STEP_KMH, kmPerL: grid.map(round3),
            idleLPerHour: round3(idleLPerHour), referenceKmPerL: round3(reference), sigmaRel: round3(sigmaRel),
            eco: e ? { fromKmh: round1(e.speedLow * 3.6), toKmh: round1(e.speedHigh * 3.6), bestKmh: round1(e.speedBest * 3.6), bestKmPerL: round3(1e-6 / (e.perMetreBest * lambda)) } : null,
            vMaxKmh: round1(vMaxKmh), fuelCode: model.fuel ? model.fuel.code : "", flags: model.flags.slice(),
            payloadKg: round1(model.params.riderMass.mean + model.massFixed - model.vehicleMass)
        };
        if (fleet) out.fleet = fleet;
        return out;
    }

    /**
     * The fleet calibration's real-riding overhead, if the bundle has a usable one.
     * @param {any} c  bundle.calibration: { date, tanks, riders, overhead: { mean, sigma, u: "1" } }
     * @returns {FleetNote|null}
     */
    function fleetNote(c) {
        const o = c && c.overhead;
        if (!o || o.u !== "1" || !(typeof o.mean === "number" && o.mean > 0.5 && o.mean < 3)) return null;
        return {
            overhead: o.mean, overheadSigma: typeof o.sigma === "number" && o.sigma >= 0 ? o.sigma : 0,
            date: typeof c.date === "string" ? c.date : "", tanks: Number(c.tanks) || 0, riders: Number(c.riders) || 0
        };
    }

    /**
     * Check a stored snapshot (it comes from localStorage: anything could be there).
     * @param {unknown} s
     * @returns {FuelBaseline|null}
     */
    function readSnapshot(s) {
        const x = /** @type {any} */ (s);
        if (!x || typeof x !== "object" || x.format !== SNAPSHOT_FORMAT || typeof x.key !== "string" || typeof x.bikeTag !== "string" || typeof x.title !== "string") return null;
        if (x.kind === "ev") return x;
        if (x.kind !== "petrol" || !Array.isArray(x.kmPerL) || x.kmPerL.length < 2 || !x.kmPerL.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)) return null;
        if (!(x.step > 0) || !(x.idleLPerHour >= 0) || !(x.referenceKmPerL > 0)) return null;
        return x;
    }

    /**
     * km/L at a speed from a snapshot: linear on the grid, held at the ends.
     * @param {PetrolBaseline} b @param {number} kmh
     */
    function kmPerLAt(b, kmh) {
        const g = b.kmPerL, x = Math.max(0, kmh) / b.step, last = g.length - 1;
        if (x >= last) return g[last];
        const i = Math.floor(x), f = x - i;
        return g[i] + (g[i + 1] - g[i]) * f;
    }

    // ------------------------------------------------------------------
    /** The nearest finite value to index i (ties: the lower speed). @param {number[]} a @param {number} i */
    function nearestFinite(a, i) {
        for (let d = 1; d < a.length; d++) {
            if (i - d >= 0 && Number.isFinite(a[i - d])) return a[i - d];
            if (i + d < a.length && Number.isFinite(a[i + d])) return a[i + d];
        }
        return NaN;
    }
    /**
     * @param {{ kmh: number, kmPerL: number, lo: number, hi: number }[]} rows
     * @param {number} kmh @param {"kmPerL"|"lo"|"hi"} [k]
     */
    function interp(rows, kmh, k = "kmPerL") {
        if (kmh <= rows[0].kmh) return rows[0][k];
        const last = rows.length - 1;
        if (kmh >= rows[last].kmh) return rows[last][k];
        let lo = 0, hi = last;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (rows[mid].kmh <= kmh) lo = mid; else hi = mid; }
        const a = rows[lo], b = rows[hi], f = (kmh - a.kmh) / (b.kmh - a.kmh);
        return a[k] + (b[k] - a[k]) * f;
    }
    /** km/L over [a, b] km/h with every kilometre counted equally: 1 / mean(L per km). */
    function harmonicMean(/** @type {any[]} */ rows, /** @type {number} */ a, /** @type {number} */ b, /** @type {(kmh: number) => number} */ f) {
        let litres = 0, n = 0;
        for (let v = a; v <= b + 1e-9; v += 0.5) { const k = f(v); if (!(k > 0)) return NaN; litres += 1 / k; n++; }
        return rows.length && n ? n / litres : NaN;
    }
    const round1 = (/** @type {number} */ x) => Math.round(x * 10) / 10;
    const round3 = (/** @type {number} */ x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);

    return { SNAPSHOT_FORMAT, REF_BAND, garageKey, bikeTag, buildFuelBaseline, readSnapshot, kmPerLAt };
});
