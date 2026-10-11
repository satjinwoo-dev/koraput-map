// @ts-check
/* ============================================================================
   MapUnite physics — engine and motor (strict SI: rad/s, N·m, W, m3, J, Pa)
   ==============================================================================
   1. Full-throttle torque curve built from the published peaks
      (peak power P̂ at ω_P, peak torque T̂ at ω_T, idle ω_I, top ω_max).
      Guarantees (for consistent peaks, T̂·ω_T ≤ P̂ ≤ T̂·ω_P, which the data contract enforces):
        T(ω_T) = T̂ and T ≤ T̂ everywhere;  P(ω_P) = P̂ and P ≤ P̂ everywhere;  zero outside [ω_I, ω_max];
        continuous everywhere; dP/dω = 0 at ω_P; dT/dω = 0 at ω_T when κ > 1 (κ = 1 leaves a
        corner there; κ < 1 is the clamped case below). Contradictory peaks are repaired, flagged,
        and still never exceed either peak.
      Pieces:
        ω_I…ω_T   T = T̂ − (T̂ − r·T̂)·(1 − y)²,  y = (ω − ω_I)/(ω_T − ω_I)
                  (r = torque at idle ÷ peak, default 0.65)
        ω_T…ω_P   T = T̂ − D·g(x),  x = (ω − ω_T)/(ω_P − ω_T),  D = T̂ − P̂/ω_P
                  A power peak at ω_P needs dT/dω = −T_P/ω_P there, so g'(1) = κ with
                  κ = T_P·(ω_P − ω_T) / (ω_P·D). For κ ≥ 1, g = x^κ. Proof that P ≤ P̂ there:
                  T' ≤ 0 and T'' ≤ 0 on the segment, so P'' = 2T' + ω·T'' ≤ 0: P' falls
                  monotonically to its value 0 at ω_P, hence P' ≥ 0 and P rises to P̂ at ω_P.
                  (The property tests check it on 7,000 random engines.) For κ < 1 (peaks that
                  barely fit together) a cubic Hermite is clamped at P̂/ω, and the curve is flagged.
        ω_P…ω_max P = P̂·(1 − c·z²),  z = (ω − ω_P)/ω_P   (c = 3: about 96 % of P̂ at 1.12·ω_P)
   2. Willans-line fuel model:
        P_fuel = (P_brake + P_friction(ω)) / η_ind
        P_friction = FMEP(ω)·V_d·ω / (2π·n_R),  FMEP = A + B·ω + C·ω²  (Pa, Pa·s/rad, Pa·s²/rad²)
        n_R = 2 crank revolutions per cycle for a 4-stroke, 1 for a 2-stroke
        fuel volume flow = P_fuel / LHV_vol  (J/m3 → m3/s)
      Overrun (negative brake power): a fuel-injected engine cuts fuel above the
      cut-off speed; a carburettor keeps feeding its idle circuit.
   3. Electric motor: wheel force ≤ min(T_wheel / r, P̂ / v) (constant torque,
      then constant power), and battery power with drivetrain, motor and
      regeneration efficiencies plus a constant auxiliary load.
   ============================================================================ */


/**
 * @typedef {{
 *   peakPower: number, omegaPower: number, peakTorque: number, omegaTorque: number,
 *   omegaIdle: number, omegaMax: number, idleTorque: number, torqueAtPowerPeak: number,
 *   drop: number, kappa: number, shape: "power-law"|"flat"|"clamped", overPeakDrop: number, capAll: boolean, flags: readonly string[]
 * }} TorqueCurve
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUPhysics || (/** @type {any} */ (root).MUPhysics = {}); ns.powertrain = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const TWO_PI = 2 * Math.PI;
    /** Shape constants of the synthesized curve; documented assumptions, not data. */
    const CURVE_DEFAULTS = Object.freeze({ idleTorqueRatio: 0.65, overPeakDrop: 3 });

    /** @param {unknown} x @param {string} name */
    function pos(x, name) {
        if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) throw new TypeError(`${name} must be a positive finite number (got ${String(x)})`);
        return x;
    }


    /**
     * Full-throttle torque curve from published peak figures (SI).
     * Inconsistent inputs are repaired the least-surprising way and flagged,
     * never turned into NaN.
     * @param {{ peakPower: number, omegaPower: number, peakTorque: number, omegaTorque: number, omegaIdle: number, omegaMax: number, idleTorqueRatio?: number, overPeakDrop?: number }} o
     * @returns {TorqueCurve}
     */
    function buildTorqueCurve(o) {
        const flags = [];
        const Pp = pos(o.peakPower, "peakPower");
        const wP = pos(o.omegaPower, "omegaPower");
        let Tp = pos(o.peakTorque, "peakTorque");
        let wT = pos(o.omegaTorque, "omegaTorque");
        let wI = pos(o.omegaIdle, "omegaIdle");
        let wMax = pos(o.omegaMax, "omegaMax");
        const r = o.idleTorqueRatio === undefined ? CURVE_DEFAULTS.idleTorqueRatio : o.idleTorqueRatio;
        const c = o.overPeakDrop === undefined ? CURVE_DEFAULTS.overPeakDrop : o.overPeakDrop;
        if (!(r > 0 && r <= 1)) throw new RangeError("idleTorqueRatio must be in (0, 1]");
        if (!(c >= 0 && c <= 50)) throw new RangeError("overPeakDrop must be in [0, 50]");
        if (wT > wP) { flags.push("torque peak above power peak: moved to the power peak"); wT = wP; }
        const TP = Pp / wP;
        if (TP > Tp) { flags.push("peak power needs more than the peak torque: peak torque raised to match"); Tp = TP; }
        if (wI >= wT) { flags.push("idle at or above the torque peak: idle lowered"); wI = 0.5 * wT; }
        if (wMax < wP) { flags.push("top speed below the power peak: raised to it"); wMax = wP; }
        // The power at the torque peak, T̂·ω_T, can't exceed the peak power. If the published
        // peaks say otherwise, keep P ≤ P̂ everywhere by capping torque at P̂/ω (T̂ is then not reached).
        const capAll = Tp * wT > Pp * (1 + 1e-12);
        if (capAll) flags.push("peak torque × its speed exceeds peak power: torque capped at peak power");
        const D = Tp - TP;
        const span = wP - wT;
        let kappa = Infinity, shape = /** @type {"power-law"|"flat"|"clamped"} */ ("flat");
        if (D > 0 && span > 0) {
            kappa = (TP * span) / (wP * D);
            shape = kappa >= 1 ? "power-law" : "clamped";
            if (shape === "clamped") flags.push("peaks barely compatible: curve clamped at peak power");
        } else if (D > 0 && span === 0) {
            flags.push("torque and power peak at the same speed: step at the peak");
        } else if (D <= 0 && span > 0) {
            flags.push("torque flat to the power peak: power still rising there");
        }
        return Object.freeze({
            peakPower: Pp, omegaPower: wP, peakTorque: Tp, omegaTorque: wT, omegaIdle: wI, omegaMax: wMax,
            idleTorque: r * Tp, torqueAtPowerPeak: TP, drop: D, kappa, shape, overPeakDrop: c, capAll, flags: Object.freeze(flags)
        });
    }

    /**
     * Full-throttle torque at engine speed ω (N·m); 0 below idle and above ω_max.
     * @param {TorqueCurve} k
     * @param {number} w  rad/s
     */
    function torqueAt(k, w) {
        if (!(w >= k.omegaIdle) || w > k.omegaMax) return 0;
        if (k.capAll) return Math.min(shapeTorque(k, w), k.peakPower / w);
        return shapeTorque(k, w);
    }

    /** @param {TorqueCurve} k @param {number} w  ω within [ω_I, ω_max] */
    function shapeTorque(k, w) {
        if (w <= k.omegaTorque) {
            const den = k.omegaTorque - k.omegaIdle;
            const u = den > 0 ? 1 - (w - k.omegaIdle) / den : 0;
            return k.peakTorque - (k.peakTorque - k.idleTorque) * u * u;
        }
        if (w <= k.omegaPower) {
            const x = (w - k.omegaTorque) / (k.omegaPower - k.omegaTorque);
            if (k.shape === "power-law") return k.peakTorque - k.drop * Math.pow(x, k.kappa);
            if (k.shape === "clamped") {
                const g = 3 * x * x - 2 * x * x * x + k.kappa * (x * x * x - x * x);
                return Math.min(k.peakTorque - k.drop * g, k.peakPower / w);
            }
            return k.peakTorque;                                  // flat
        }
        const z = (w - k.omegaPower) / k.omegaPower;
        const p = k.peakPower * (1 - k.overPeakDrop * z * z);
        return p > 0 ? p / w : 0;
    }

    /** Full-throttle power at ω (W). @param {TorqueCurve} k @param {number} w */
    const powerAt = (k, w) => torqueAt(k, w) * w;

    /**
     * Sampled curve for plots and inspection.
     * @param {TorqueCurve} k
     * @param {number} [n]  points (≥ 2)
     * @returns {{ omega: Float64Array, torque: Float64Array, power: Float64Array }}
     */
    function sampleCurve(k, n = 64) {
        const N = Math.max(2, Math.floor(n));
        const omega = new Float64Array(N), torque = new Float64Array(N), power = new Float64Array(N);
        for (let i = 0; i < N; i++) {
            const w = i === N - 1 ? k.omegaMax : k.omegaIdle + ((k.omegaMax - k.omegaIdle) * i) / (N - 1);
            omega[i] = w; torque[i] = torqueAt(k, w); power[i] = torque[i] * w;
        }
        return { omega, torque, power };
    }

    // ------------------------------------------------------------------
    // Willans line
    // ------------------------------------------------------------------
    /**
     * Friction mean effective pressure, Pa (never negative).
     * @param {{ A: number, B: number, C: number }} f  Pa, Pa·s/rad, Pa·s²/rad²
     * @param {number} w  rad/s
     */
    function frictionMep(f, w) {
        const v = f.A + f.B * w + f.C * w * w;
        return v > 0 ? v : 0;
    }

    /**
     * Friction (+ pumping) power of the engine at ω, W.
     * @param {number} displacement  m3
     * @param {number} revsPerCycle  2 for 4-stroke, 1 for 2-stroke
     * @param {{ A: number, B: number, C: number }} f
     * @param {number} w  rad/s
     */
    function frictionPower(displacement, revsPerCycle, f, w) {
        return w > 0 ? (frictionMep(f, w) * displacement * w) / (TWO_PI * revsPerCycle) : 0;
    }

    /**
     * Willans line: fuel (chemical) power for a brake power at engine speed ω, W.
     * Brake power must be ≥ 0; overrun is handled by the caller (fuel cut / idle feed).
     * @param {number} brakePower    W, ≥ 0
     * @param {number} frictionW     W
     * @param {number} etaIndicated  indicated efficiency, 0–1
     */
    function willansFuelPower(brakePower, frictionW, etaIndicated) {
        return (Math.max(0, brakePower) + frictionW) / etaIndicated;
    }

    /**
     * Brake-specific fuel consumption, kg/J (multiply by 3.6e9 for g/kWh in a UI).
     * @param {number} fuelPowerW  @param {number} brakePower  @param {number} lhvVolumetric J/m3  @param {number} density kg/m3
     */
    function bsfc(fuelPowerW, brakePower, lhvVolumetric, density) {
        return brakePower > 0 ? (fuelPowerW / lhvVolumetric) * density / brakePower : null;
    }

    // ------------------------------------------------------------------
    // Electric drive
    // ------------------------------------------------------------------
    /**
     * Largest tractive force at the tyre at road speed v, N. The drivetrain loss applies to the
     * motor's output; a torque published AT the wheel (torqueAtWheel) already includes it.
     * @param {{ peakPower: number, wheelTorque: number|null, torqueAtWheel?: boolean }} m  W, N·m at the wheel (null = unknown)
     * @param {number} v  m/s
     * @param {number} radius  rolling radius, m
     * @param {number} [etaDt]  drivetrain efficiency (default 1)
     */
    function motorForceMax(m, v, radius, etaDt = 1) {
        const fromTorque = m.wheelTorque !== null ? (m.wheelTorque * (m.torqueAtWheel ? 1 : etaDt)) / radius : Infinity;
        const fromPower = v > 0 ? (m.peakPower * etaDt) / v : Infinity;
        const f = Math.min(fromTorque, fromPower);
        return Number.isFinite(f) ? f : 0;                       // no torque figure at standstill: no claim
    }

    /**
     * Battery power for a wheel power, W (negative = charging).
     *   driving:  P_w / (η_dt·η_motor) + P_aux
     *   braking:  max(P_w·η_regen, −regenLimit) + P_aux   (η_regen = share of braking energy recovered)
     * @param {number} wheelPower W
     * @param {{ etaDt: number, etaMotor: number, etaRegen: number, aux: number, regenLimit: number }} p
     */
    function batteryPower(wheelPower, p) {
        if (wheelPower >= 0) return wheelPower / (p.etaDt * p.etaMotor) + p.aux;
        return Math.max(wheelPower * p.etaRegen, -p.regenLimit) + p.aux;
    }

    return { TWO_PI, CURVE_DEFAULTS, buildTorqueCurve, torqueAt, powerAt, sampleCurve, frictionMep, frictionPower, willansFuelPower, bsfc, motorForceMax, batteryPower };
});
