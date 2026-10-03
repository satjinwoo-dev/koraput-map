// @ts-check
"use strict";

/* ============================================================================
   MapUnite physics — js/physics/engine.js
   ==============================================================================
   1. Full-load torque curve T(ω) built from the four published figures:
      peak power Pmax at ωP, peak torque Tmax at ωT (plus idle and redline).

      Above ωT the curve is a cubic in u = ω − ωT with zero slope at ωT:
          T(ω) = Tmax − a·u² − b·u³
      a and b are solved so that
          T(ωP) = Pmax / ωP                 (it passes through the power peak)
          d(T·ω)/dω = 0 at ωP               (and power PEAKS there)
      With A = a·Δ², B = b·Δ³, Δ = ωP − ωT, D = Tmax − Pmax/ωP, S = Δ·Pmax/ωP²:
          A + B = D,   2A + 3B = S   ⇒   A = 3D − S,   B = S − 2D.
      When A, B ≥ 0 the fit is exact and torque falls monotonically ("fit_exact").
      Otherwise the published figures can't all hold on a smooth monotone curve
      (e.g. a long-stroke engine whose power keeps climbing after its torque
      peak): the negative term is dropped and the curve is capped at Pmax/ω, so
      power never exceeds the published peak ("fit_capped").
      Below ωT: T = Tmax·(1 − (1 − r)·s²), s = (ωT − ω)/(ωT − ωidle), where r is
      the torque fraction left at idle — a MODEL ASSUMPTION (0.7 ± 0.1).
      Everywhere: T ≤ Tmax and T·ω ≤ Pmax; T = 0 above the limiter.
      A published curve (bundle.curves.torque), when present, is used instead.

   2. Fuel by the Willans line (Guzzella & Sciarretta, Vehicle Propulsion
      Systems): fuel power = indicated power / ηi, indicated = brake + friction,
          friction power = FMEP(ω)·Vd·ω / (2π·nR),  FMEP = A + B·ω + C·ω²,
      nR = 2 crank revolutions per cycle for a four-stroke, 1 for a two-stroke.
      Below idle demand the engine still burns its idle flow. On the overrun
      (closed throttle, the road turning the engine) a fuel-injected engine cuts
      fuel completely above OVERRUN_CUT × idle speed; a carburettor keeps
      feeding its idle circuit. So a long descent costs no fuel on an FI bike.
   ============================================================================ */

(function (root, factory) {
    if (typeof module === "object" && module && module.exports) module.exports = factory(require("./core.js"));
    else { const ns = /** @type {any} */ (root).MUPhysics; ns.engine = factory(ns.core); }
})(typeof globalThis !== "undefined" ? globalThis : self, function (/** @type {any} */ core) {
    const { PhysicsError, finite, positive, inRange, TWO_PI } = core;

    /** Torque fraction left at idle (model assumption). */
    const IDLE_TORQUE_FRACTION = 0.7;
    const IDLE_TORQUE_FRACTION_SIGMA = 0.1;
    /** FI overrun fuel cut is active above this multiple of idle speed (model assumption). */
    const OVERRUN_CUT = 1.25;

    /**
     * @typedef {object} EngineMap
     * @property {number} peakPower         W
     * @property {number} peakPowerSpeed    rad/s
     * @property {number} peakTorque        N*m
     * @property {number} peakTorqueSpeed   rad/s
     * @property {number} idleSpeed         rad/s
     * @property {number} redlineSpeed      rad/s
     * @property {number} [limiterSpeed]    rad/s (default: redline)
     * @property {number} [idleTorqueFraction]
     * @property {{ omegaStart: number, omegaStep: number, values: number[] }} [curve]  published curve, SI
     */
    /**
     * @typedef {object} TorqueModel
     * @property {(omega: number) => number} torque   full-load torque, N*m
     * @property {(omega: number) => number} power    full-load power, W
     * @property {"published_curve" | "fit_exact" | "fit_capped"} method
     * @property {EngineMap} map
     */

    /**
     * @param {EngineMap} m
     * @returns {TorqueModel}
     */
    function torqueModel(m) {
        const Pm = positive(m.peakPower, "peakPower");
        const wP = positive(m.peakPowerSpeed, "peakPowerSpeed");
        const wT = positive(m.peakTorqueSpeed, "peakTorqueSpeed");
        const wI = positive(m.idleSpeed, "idleSpeed");
        const wR = positive(m.redlineSpeed, "redlineSpeed");
        const wL = m.limiterSpeed === undefined ? wR : positive(m.limiterSpeed, "limiterSpeed");
        const r = m.idleTorqueFraction === undefined ? IDLE_TORQUE_FRACTION : inRange(m.idleTorqueFraction, 0.2, 1, "idleTorqueFraction");
        if (!(wI < wT && wT <= wP && wP <= wR && wR <= wL)) {
            throw new PhysicsError(`engine speeds must satisfy idle < torque peak ≤ power peak ≤ redline ≤ limiter (got ${[wI, wT, wP, wR, wL].map((x) => x.toFixed(1)).join(", ")} rad/s)`);
        }
        // A published Tmax below Pmax/ωP can't be (power = torque × speed): honour the power figure.
        const Tm = Math.max(positive(m.peakTorque, "peakTorque"), Pm / wP);
        const TP = Pm / wP;

        if (m.curve) return publishedCurve(m, wI, wL);

        const delta = wP - wT;
        const D = Tm - TP;
        let a = 0, b = 0;
        /** @type {"fit_exact" | "fit_capped"} */
        let method = "fit_capped";
        if (delta > 1e-9 && D > 0) {
            const S = (delta * TP) / wP;
            let A = 3 * D - S, B = S - 2 * D;
            if (A >= 0 && B >= 0) method = "fit_exact";
            else if (A < 0) { A = 0; B = D; }
            else { B = 0; A = D; }
            a = A / (delta * delta);
            b = B / (delta * delta * delta);
        }
        const span = wT - wI;
        /** @param {number} w */
        const shape = (w) => {
            if (w >= wT) { const u = w - wT; return Math.max(0, Tm - a * u * u - b * u * u * u); }
            const s = Math.min(1, (wT - Math.max(w, wI)) / span); // below idle: hold the idle value
            return Tm * (1 - (1 - r) * s * s);
        };
        /** @param {number} w */
        const torque = (w) => {
            if (!(w > 0) || w > wL) return 0;
            return Math.min(shape(w), Pm / w);
        };
        return Object.freeze({ torque, power: (/** @type {number} */ w) => torque(w) * Math.max(0, w), method, map: m });
    }

    /**
     * @param {EngineMap} m @param {number} wI @param {number} wL
     * @returns {TorqueModel}
     */
    function publishedCurve(m, wI, wL) {
        const c = /** @type {NonNullable<EngineMap["curve"]>} */ (m.curve);
        const w0 = finite(c.omegaStart, "curve.omegaStart"), dw = positive(c.omegaStep, "curve.omegaStep");
        const vals = c.values.map((v, i) => finite(v, `curve.values[${i}]`));
        if (vals.length < 2) throw new PhysicsError("a torque curve needs at least 2 points");
        const wEnd = w0 + dw * (vals.length - 1);
        /** @param {number} w */
        const torque = (w) => {
            if (!(w > 0) || w > wL) return 0;
            const x = Math.max(w, wI, w0);
            if (x >= wEnd) return Math.max(0, vals[vals.length - 1]);
            const i = Math.floor((x - w0) / dw), f = (x - w0) / dw - i;
            return Math.max(0, vals[i] + (vals[i + 1] - vals[i]) * f);
        };
        return Object.freeze({ torque, power: (/** @type {number} */ w) => torque(w) * Math.max(0, w), method: "published_curve", map: m });
    }

    /**
     * @typedef {object} FuelMap
     * @property {number} displacement         m³
     * @property {number} strokes              2 or 4
     * @property {number} fmepA                Pa
     * @property {number} fmepB                Pa·s/rad
     * @property {number} fmepC                Pa·s²/rad²
     * @property {number} indicatedEfficiency  Willans slope ηi
     * @property {"fi" | "carb"} fuelSystem
     * @property {number} idleSpeed            rad/s
     */

    /**
     * Friction (and pumping) power at engine speed ω, W.
     * @param {number} omega @param {FuelMap} f
     */
    function frictionPower(omega, f) {
        if (!(omega > 0)) return 0;
        const fmep = Math.max(0, f.fmepA + f.fmepB * omega + f.fmepC * omega * omega);
        return (fmep * f.displacement * omega) / (TWO_PI * (f.strokes / 2));
    }

    /**
     * Rate of fuel energy burned, W (≥ 0 always).
     * @param {number} brakePower  W delivered at the crank; negative when the road drives the engine
     * @param {number} omega       engine speed, rad/s (≤ 0: engine stopped)
     * @param {FuelMap} f
     */
    function fuelPower(brakePower, omega, f) {
        finite(brakePower, "brakePower");
        if (!(finite(omega, "engine speed") > 0)) return 0;
        const indicated = brakePower + frictionPower(omega, f);
        if (indicated <= 0 && f.fuelSystem === "fi" && omega > OVERRUN_CUT * f.idleSpeed) return 0; // overrun fuel cut
        // An engine on any throttle (or a carburettor on the overrun) burns at least its idle flow.
        return Math.max(indicated, frictionPower(f.idleSpeed, f)) / f.indicatedEfficiency;
    }

    /**
     * @param {number} fuelPowerW @param {number} lhvVolume  J/m³ of the fuel in the tank
     * @returns {number} m³/s
     */
    const fuelVolumeRate = (fuelPowerW, lhvVolume) => fuelPowerW / positive(lhvVolume, "lhvVolume");

    return Object.freeze({
        torqueModel, frictionPower, fuelPower, fuelVolumeRate,
        IDLE_TORQUE_FRACTION, IDLE_TORQUE_FRACTION_SIGMA, OVERRUN_CUT
    });
});
