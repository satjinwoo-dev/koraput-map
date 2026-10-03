// @ts-check
"use strict";

/* ============================================================================
   MapUnite physics — js/physics/profile.js
   ==============================================================================
   Turns a runtime bike bundle (public/bikedb/bundles/<hash>.json, strict SI)
   plus the rider's settings into the numbers the physics runs on.

     paramsFromBundle(bundle, { classDefault, rider })  ->  Params   (plain data)
     compileVehicle(params)                              ->  Vehicle  (models ready to evaluate)
     withPrior(params, key, value)                       ->  Params   (one prior moved; for ±1σ)

   Where each number comes from is recorded, never guessed:
     - published bundle values are used as they are;
     - a value the variant doesn't publish (idle speed, gearing, CVT ratios) is
       taken from its CLASS DEFAULT bundle and listed in `flags` — and gear
       advice is then off (plan C4: also always off for CVT scooters and EVs);
     - uncertain parameters are PRIORS { mean, sigma, origin }: the bundle's own
       priors, the rider's own settings, or a named model assumption. Every one
       of them is propagated into the ±1σ ranges (uncertainty.js).
   ============================================================================ */

(function (root, factory) {
    if (typeof module === "object" && module && module.exports) {
        module.exports = factory(require("./core.js"), require("./tyre.js"), require("./engine.js"), require("./roadload.js"));
    } else { const ns = /** @type {any} */ (root).MUPhysics; ns.profile = factory(ns.core, ns.tyre, ns.engine, ns.roadload); }
})(typeof globalThis !== "undefined" ? globalThis : self, function (/** @type {any} */ core, /** @type {any} */ tyre, /** @type {any} */ engine, /** @type {any} */ roadload) {
    const { PhysicsError, finite, positive, inRange, nonNegative } = core;

    /** Gear advice needs the variant's own gearing at least this trustworthy. */
    const GEAR_ADVICE_MIN_CONF = 0.5;
    /** Lowest engine speed a gear may be held at (lugging limit): max(1.3 × idle, 0.5 × torque-peak speed). Model assumption. */
    const LUG_IDLE_FACTOR = 1.3;
    const LUG_TORQUE_FACTOR = 0.5;
    /** CVT: engine speed held at light load, as a fraction of the torque-peak speed (model assumption). */
    const CVT_LIGHT_LOAD = 0.75;
    const CVT_LIGHT_LOAD_SIGMA = 0.1;
    /** EV: usable share of the pack when only the gross capacity is published (model assumption). */
    const USABLE_FRACTION = 0.9;
    const USABLE_FRACTION_SIGMA = 0.04;
    /** EV auxiliaries: headlamp (always on by law in India), tail lamp, display, controller standby, W (model assumption). */
    const AUX_POWER = 25;
    const AUX_POWER_SIGMA = 10;
    /** A rider's own mass is known far better than the class prior. */
    const RIDER_MASS_SIGMA = 2;
    const DEFAULT_FUEL = "E20";

    /**
     * Validity range of each prior, used to keep ±σ perturbations physical.
     * @type {Readonly<Record<string, [number, number]>>}
     */
    const PRIOR_RANGE = Object.freeze({
        cda: [0.05, 2], crr: [0.002, 0.08], drivetrainEfficiency: [0.4, 0.995], riderMass: [0, 250],
        massFactor: [1, 1.5], tyreDeflection: [0, 0.1], indicatedEfficiency: [0.1, 0.5],
        fmepA: [0, 1e6], fmepB: [0, 1e4], fmepC: [0, 10], idleTorqueFraction: [0.2, 1], redlineFactor: [1, 1.6],
        cvtLightLoad: [0.3, 1.2], motorEfficiency: [0.4, 0.99], regenEfficiency: [0, 0.95], usableFraction: [0.6, 1], auxPower: [0, 500]
    });

    /**
     * @typedef {{ mean: number, sigma: number, origin: "bundle" | "class_default" | "rider" | "model" }} Prior
     * @typedef {{ primary: number, gears: number[], final: number, origin: "variant" | "class_default" | "rider" }} Gearing
     * @typedef {{ ratioMax: number, ratioMin: number, final: number, origin: "variant" | "class_default" }} Cvt
     * @typedef {{ riderMass?: number, pillionMass?: number, luggageMass?: number, frontSprocket?: number, rearSprocket?: number, rearTyre?: string, fuelGrade?: string }} RiderSettings
     * @typedef {object} Params
     * @property {string} id
     * @property {"variant" | "class_default"} kind
     * @property {"ice_manual" | "ice_cvt" | "ev"} powertrain
     * @property {number} kerbMass        kg (with fuel, as the bike is ridden)
     * @property {number} extraMass       kg pillion + luggage
     * @property {string} rearTyre
     * @property {number | null} topSpeed m/s, published
     * @property {Record<string, Prior>} priors
     * @property {boolean} gearAdvice
     * @property {string[]} flags         plain-language caveats for the UI
     * @property {any} [ice]              ICE-only data (see paramsFromBundle)
     * @property {any} [ev]               EV-only data
     */

    const val = (/** @type {any} */ node, /** @type {string} */ _name) => (node && typeof node.v === "number" ? node.v : null);

    /**
     * @param {any} bundle   runtime bundle (units "SI")
     * @param {{ classDefault?: any, rider?: RiderSettings }} [opts]
     * @returns {Params}
     */
    function paramsFromBundle(bundle, opts = {}) {
        if (!bundle || bundle.units !== "SI") throw new PhysicsError("expected a runtime bike bundle in SI units (public/bikedb/bundles/*.json)");
        const cd = opts.classDefault || null;
        if (cd && (cd.kind !== "class_default" || cd.classKey !== bundle.classKey)) throw new PhysicsError(`classDefault must be the class default for ${bundle.classKey}`);
        const rider = opts.rider || {};
        /** @type {string[]} */
        const flags = [];
        const pt = bundle.powertrain;
        if (!["ice_manual", "ice_cvt", "ev"].includes(pt)) throw new PhysicsError(`unknown powertrain ${pt}`);
        if (bundle.kind === "class_default") flags.push("Estimated: this is the class default for an unlisted bike.");

        /** @type {Record<string, Prior>} */
        const priors = {};
        for (const [k, p] of Object.entries(bundle.priors || {})) {
            const q = /** @type {any} */ (p);
            priors[k] = { mean: finite(q.mean, `priors.${k}.mean`), sigma: positive(q.sigma, `priors.${k}.sigma`), origin: q.inherited ? "class_default" : "bundle" };
        }
        for (const k of ["cda", "crr", "drivetrainEfficiency", "riderMass"]) if (!priors[k]) throw new PhysicsError(`bundle ${bundle.id} has no ${k} prior`);
        priors.massFactor = { mean: roadload.MASS_FACTOR, sigma: roadload.MASS_FACTOR_SIGMA, origin: "model" };
        priors.tyreDeflection = { mean: tyre.DEFAULT_DEFLECTION, sigma: tyre.DEFLECTION_SIGMA, origin: "model" };
        if (rider.riderMass !== undefined) priors.riderMass = { mean: inRange(rider.riderMass, 30, 200, "riderMass"), sigma: RIDER_MASS_SIGMA, origin: "rider" };

        // ---- mass ----
        let kerbMass = positive(val(bundle.chassis && bundle.chassis.mass, "mass"), "chassis.mass");
        const basis = bundle.chassis.mass.basis;
        if (basis === "dry" && pt !== "ev") {
            const tank = val(bundle.chassis.fuelTank, "fuelTank");
            const grade = fuelGrade(bundle, rider.fuelGrade || DEFAULT_FUEL);
            if (tank !== null) kerbMass += 0.5 * tank * grade.density;
            flags.push("Published mass is dry: half a tank of fuel added.");
        } else if (basis === "unspecified") flags.push("Published mass doesn't say whether it is kerb or dry.");
        const extraMass = nonNegative(rider.pillionMass ?? 0, "pillionMass") + nonNegative(rider.luggageMass ?? 0, "luggageMass");
        if (extraMass > 250) throw new PhysicsError("pillion + luggage over 250 kg");

        // ---- wheel ----
        const rearTyre = rider.rearTyre || (bundle.chassis.rearTyre && bundle.chassis.rearTyre.v);
        if (!tyre.parseTyre(rearTyre)) throw new PhysicsError(`rear tyre "${rearTyre}" is not a recognised size`);
        const topSpeed = val(bundle.chassis.topSpeed, "topSpeed");

        /** @type {Params} */
        const params = { id: bundle.id, kind: bundle.kind, powertrain: pt, kerbMass, extraMass, rearTyre, topSpeed, priors, gearAdvice: false, flags };
        if (pt === "ev") params.ev = evParams(bundle, priors, flags);
        else params.ice = iceParams(bundle, cd, rider, priors, flags, params);
        return params;
    }

    /** @param {any} bundle @param {string} code */
    function fuelGrade(bundle, code) {
        const grades = bundle.reference && bundle.reference.fuelGrades && bundle.reference.fuelGrades.grades;
        const g = Array.isArray(grades) && grades.find((/** @type {any} */ x) => x.code === code);
        if (!g) throw new PhysicsError(`fuel grade ${code} is not in the bundle's reference table`);
        return { code, lhvVolume: positive(g.lhv.v, `${code}.lhv`), density: positive(g.density.v, `${code}.density`) };
    }

    /**
     * @param {any} b @param {any} cd @param {RiderSettings} rider @param {Record<string, Prior>} priors @param {string[]} flags @param {Params} params
     */
    function iceParams(b, cd, rider, priors, flags, params) {
        const e = b.engine || {};
        const need = (/** @type {string} */ k) => positive(val(e[k], k), `engine.${k}`);
        /** A value the variant may not publish: take it from the class default, and say so. */
        const fromClass = (/** @type {string} */ group, /** @type {string} */ k, /** @type {string} */ what) => {
            const own = val(b[group] && b[group][k], k);
            if (own !== null) return own;
            const c = cd && val(cd[group] && cd[group][k], k);
            if (c === null || c === undefined) throw new PhysicsError(`${b.id} doesn't publish ${what}: pass its class default bundle (${b.classKey})`);
            flags.push(`${what[0].toUpperCase()}${what.slice(1)} not published for this bike: class-default estimate used.`);
            return c;
        };
        for (const k of ["indicatedEfficiency", "fmepA", "fmepB", "fmepC"]) if (!priors[k]) throw new PhysicsError(`bundle ${b.id} has no ${k} prior`);
        priors.idleTorqueFraction = { mean: engine.IDLE_TORQUE_FRACTION, sigma: engine.IDLE_TORQUE_FRACTION_SIGMA, origin: "model" };

        const redline = val(e.redlineRpm, "redlineRpm");
        if (redline === null) {
            if (!priors.redlineFactor) throw new PhysicsError(`bundle ${b.id} publishes no redline and has no redlineFactor prior`);
            flags.push("Redline not published: estimated from the peak-power speed.");
        }
        const curve = b.curves && b.curves.torque
            ? { omegaStart: b.curves.torque.omegaStart, omegaStep: b.curves.torque.omegaStep, values: b.curves.torque.data.map((/** @type {number} */ q) => q * b.curves.torque.scale) }
            : null;
        const grade = fuelGrade(b, rider.fuelGrade || DEFAULT_FUEL);

        const ice = {
            displacement: need("displacement"),
            strokes: need("strokes"),
            fuelSystem: (e.fuelSystem && e.fuelSystem.v) === "carb" ? "carb" : "fi",
            peakPower: need("peakPower"), peakPowerSpeed: need("peakPowerRpm"),
            peakTorque: need("peakTorque"), peakTorqueSpeed: need("peakTorqueRpm"),
            idleSpeed: fromClass("engine", "idleRpm", "idle speed"),
            redlineSpeed: redline,
            limiterSpeed: val(e.limiterRpm, "limiterRpm"),
            curve,
            fuelGrade: grade.code, lhvVolume: grade.lhvVolume,
            /** @type {Gearing | null} */ gearing: null,
            /** @type {Cvt | null} */ cvt: null
        };

        const t = b.transmission || {};
        if (b.powertrain === "ice_manual") {
            const own = t.primaryRatio && t.gearRatios && t.finalRatio;
            const src = own ? t : cd && cd.transmission;
            if (!src || !src.primaryRatio || !src.gearRatios || !src.finalRatio) throw new PhysicsError(`${b.id} has no gearing and no class-default gearing was given`);
            /** @type {Gearing} */
            const g = { primary: positive(src.primaryRatio.v, "primaryRatio"), gears: src.gearRatios.v.map((/** @type {number} */ x, /** @type {number} */ i) => positive(x, `gearRatios[${i}]`)), final: positive(src.finalRatio.v, "finalRatio"), origin: own ? "variant" : "class_default" };
            for (let i = 1; i < g.gears.length; i++) if (!(g.gears[i] < g.gears[i - 1])) throw new PhysicsError("gear ratios must decrease from first to top");
            if (!own) flags.push("Gear ratios not published for this bike: fuel uses class-default gearing; gear advice is off.");
            const conf = own ? Math.min(t.primaryRatio.conf, t.gearRatios.conf, t.finalRatio.conf) : 0;
            const speeds = val(t.speeds, "speeds");
            params.gearAdvice = b.kind === "variant" && !!own && conf >= GEAR_ADVICE_MIN_CONF && (speeds === null || speeds === g.gears.length);
            if (own && !params.gearAdvice) flags.push(`Gear ratios are too uncertain (confidence ${conf}) for gear advice.`);
            if (rider.frontSprocket !== undefined || rider.rearSprocket !== undefined) {
                const f = inRange(rider.frontSprocket, 9, 25, "frontSprocket"), r = inRange(rider.rearSprocket, 25, 70, "rearSprocket");
                if (!Number.isInteger(f) || !Number.isInteger(r)) throw new PhysicsError("sprocket teeth must be whole numbers");
                g.final = r / f;
                if (g.origin === "variant") g.origin = "rider";
                flags.push(`Final drive set by the rider: ${f}/${r} teeth.`);
            }
            ice.gearing = g;
        } else {
            const own = t.cvtRatioMax && t.cvtRatioMin && t.finalRatio;
            const src = own ? t : cd && cd.transmission;
            if (!src || !src.cvtRatioMax || !src.cvtRatioMin || !src.finalRatio) throw new PhysicsError(`${b.id} has no CVT ratios and no class-default CVT was given`);
            ice.cvt = { ratioMax: positive(src.cvtRatioMax.v, "cvtRatioMax"), ratioMin: positive(src.cvtRatioMin.v, "cvtRatioMin"), final: positive(src.finalRatio.v, "finalRatio"), origin: own ? "variant" : "class_default" };
            if (!(ice.cvt.ratioMax > ice.cvt.ratioMin)) throw new PhysicsError("CVT ratioMax must exceed ratioMin");
            if (!own) flags.push("CVT ratios not published for this scooter: class-default estimate used.");
            priors.cvtLightLoad = { mean: CVT_LIGHT_LOAD, sigma: CVT_LIGHT_LOAD_SIGMA, origin: "model" };
        }
        return ice;
    }

    /** @param {any} b @param {Record<string, Prior>} priors @param {string[]} flags */
    function evParams(b, priors, flags) {
        const m = b.motor || {}, bat = b.battery || {};
        for (const k of ["motorEfficiency", "regenEfficiency"]) if (!priors[k]) throw new PhysicsError(`bundle ${b.id} has no ${k} prior`);
        const usable = val(bat.usableCapacity, "usableCapacity");
        const gross = positive(val(bat.grossCapacity, "grossCapacity"), "battery.grossCapacity");
        if (usable === null) {
            priors.usableFraction = { mean: USABLE_FRACTION, sigma: USABLE_FRACTION_SIGMA, origin: "model" };
            flags.push("Usable battery energy not published: estimated from the installed capacity.");
        }
        priors.auxPower = { mean: AUX_POWER, sigma: AUX_POWER_SIGMA, origin: "model" };
        return {
            peakPower: positive(val(m.peakPower, "peakPower"), "motor.peakPower"),
            usableEnergy: usable, grossEnergy: gross,
            certifiedRange: val(bat.certifiedRange, "certifiedRange")
        };
    }

    // ------------------------------------------------------------------------
    /**
     * @typedef {object} Vehicle
     * @property {Params} params
     * @property {number} mass            kg, all-up
     * @property {number} massFactor
     * @property {number} crr
     * @property {number} cda             m²
     * @property {number} rollingRadius   m
     * @property {number} drivetrainEfficiency
     * @property {any} [engine]           { torque: TorqueModel, fuel: FuelMap, redline, limiter, lugSpeed, lhvVolume }
     * @property {number[]} [overallRatios]  manual: engine rad/s per wheel rad/s, 1st..top
     * @property {Cvt} [cvt]
     * @property {number} [cvtLightLoad]
     * @property {any} [ev]               { maxWheelPower, motorEfficiency, regenEfficiency, auxPower, usableEnergy }
     */

    /**
     * @param {Params} p
     * @returns {Vehicle}
     */
    function compileVehicle(p) {
        const pr = (/** @type {string} */ k) => {
            const x = p.priors[k];
            if (!x) throw new PhysicsError(`missing prior ${k}`);
            return x.mean;
        };
        /** @type {Vehicle} */
        const v = {
            params: p,
            mass: p.kerbMass + pr("riderMass") + p.extraMass,
            massFactor: pr("massFactor"),
            crr: pr("crr"),
            cda: pr("cda"),
            rollingRadius: tyre.rollingRadius(p.rearTyre, pr("tyreDeflection")),
            drivetrainEfficiency: inRange(pr("drivetrainEfficiency"), 0.3, 1, "drivetrainEfficiency")
        };
        if (p.ice) {
            const i = p.ice;
            const redline = i.redlineSpeed !== null ? i.redlineSpeed : i.peakPowerSpeed * pr("redlineFactor");
            const limiter = i.limiterSpeed !== null ? Math.max(i.limiterSpeed, redline) : redline;
            const tq = engine.torqueModel({
                peakPower: i.peakPower, peakPowerSpeed: i.peakPowerSpeed, peakTorque: i.peakTorque, peakTorqueSpeed: i.peakTorqueSpeed,
                idleSpeed: i.idleSpeed, redlineSpeed: redline, limiterSpeed: limiter, idleTorqueFraction: pr("idleTorqueFraction"),
                ...(i.curve ? { curve: i.curve } : {})
            });
            v.engine = {
                torque: tq, redline, limiter,
                lugSpeed: Math.max(LUG_IDLE_FACTOR * i.idleSpeed, LUG_TORQUE_FACTOR * i.peakTorqueSpeed),
                lhvVolume: i.lhvVolume,
                fuel: {
                    displacement: i.displacement, strokes: i.strokes, fuelSystem: i.fuelSystem, idleSpeed: i.idleSpeed,
                    fmepA: pr("fmepA"), fmepB: pr("fmepB"), fmepC: pr("fmepC"),
                    indicatedEfficiency: inRange(pr("indicatedEfficiency"), 0.05, 0.6, "indicatedEfficiency")
                }
            };
            if (i.gearing) v.overallRatios = i.gearing.gears.map((/** @type {number} */ g) => i.gearing.primary * g * i.gearing.final);
            if (i.cvt) { v.cvt = i.cvt; v.cvtLightLoad = pr("cvtLightLoad"); }
        }
        if (p.ev) {
            const usable = p.ev.usableEnergy !== null ? p.ev.usableEnergy : p.ev.grossEnergy * pr("usableFraction");
            v.ev = {
                maxWheelPower: p.ev.peakPower * v.drivetrainEfficiency,
                motorEfficiency: inRange(pr("motorEfficiency"), 0.3, 1, "motorEfficiency"),
                regenEfficiency: inRange(pr("regenEfficiency"), 0, 1, "regenEfficiency"),
                auxPower: Math.max(0, pr("auxPower")),
                usableEnergy: usable
            };
        }
        return v;
    }

    /**
     * A copy of params with one prior's mean moved, clamped to its physical range.
     * @param {Params} p @param {string} key @param {number} mean
     * @returns {Params}
     */
    function withPrior(p, key, mean) {
        const old = p.priors[key];
        if (!old) throw new PhysicsError(`no prior ${key}`);
        const range = PRIOR_RANGE[key] || [-Infinity, Infinity];
        return { ...p, priors: { ...p.priors, [key]: { ...old, mean: Math.min(range[1], Math.max(range[0], mean)) } } };
    }

    return Object.freeze({
        paramsFromBundle, compileVehicle, withPrior, fuelGrade, PRIOR_RANGE,
        GEAR_ADVICE_MIN_CONF, LUG_IDLE_FACTOR, LUG_TORQUE_FACTOR, CVT_LIGHT_LOAD, USABLE_FRACTION, AUX_POWER, DEFAULT_FUEL
    });
});
