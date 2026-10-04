// @ts-check
/* ============================================================================
   MapUnite physics — bike model from a runtime bundle (strict SI)
   ==============================================================================
   createBikeModel(bundle, { classDefault?, settings? }) turns a runtime bundle
   (public/bikedb/bundles/<hash>.json, "units": "SI") into the plain numbers
   the physics needs, plus the uncertain parameters (mean ± σ) that the ±1σ ranges
   come from.

   It refuses anything that isn't an SI bundle, and checks every unit it reads.

   Missing data, in order of preference:
     1. the bike's own value;
     2. the rider's setting (sprockets, rear tyre, masses, fuel);
     3. the class default's value (pass its bundle as `classDefault`), flagged;
     4. a documented MODEL assumption with its own ±σ (tyre deflection, EV
        auxiliary load, usable battery share), flagged.
   Bike data is never invented: an idle speed, tank size or fuel grade that
   neither the bike nor its class default publishes is an error, not a guess.
   Gearing is all-or-nothing: primary + gears + final from one place, never
   mixed — except the rider's own sprockets, which replace the final drive
   (they describe the actual bike). Gear advice is only offered when the bike's
   own gearing is complete, consistent with its published number of gears, and
   at least GEAR_ADVICE_MIN_CONF trustworthy (C4: never for CVT scooters or EVs).
   A published torque curve (bundle.curves.torque) replaces the synthesized one.
   ============================================================================ */


/**
 * @typedef {{ mean: number, sigma: number }} Uncertain
 * @typedef {{ riderMass?: number, pillionMass?: number, luggageMass?: number, frontSprocket?: number, rearSprocket?: number, rearTyre?: string, fuelCode?: string }} RiderSettings
 * @typedef {{
 *   id: string, title: string, kind: string, powertrain: "ice_manual"|"ice_cvt"|"ev", classKey: string,
 *   massFixed: number, vehicleMass: number,
 *   tyreCode: string, unloadedRadius: number,
 *   drive: { kind: "manual"|"cvt"|"ev", ratios: number[], gearRatios: number[], primary: number, final: number,
 *            cvt: { ratioMax: number, ratioMin: number, final: number, omegaEngage: number, omegaCruise: number } | null,
 *            evRatio: number, source: string },
 *   gearAdvice: boolean,
 *   gearAdviceReason: null | "cvt" | "single-speed" | "typical-bike" | "borrowed-gearing" | "gear-count-mismatch" | "uncertain-gearing",
 *   engine: null | { curve: import("./powertrain.js").TorqueCurve, displacement: number, revsPerCycle: number, fuelInjected: boolean,
 *            omegaIdle: number, omegaCut: number, omegaLug: number, omegaMax: number },
 *   motor: null | { peakPower: number, wheelTorque: number|null, torqueAtWheel: boolean, regenLimit: number, speedLimit: number|null },
 *   battery: null | { gross: number, usable: number|null },
 *   fuel: null | { code: string, lhv: number, density: number },
 *   topSpeed: number|null,
 *   params: Record<string, Uncertain>,
 *   flags: string[]
 * }} BikeModel
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory(require("./powertrain.js"), require("./tyre.js"));
    else { const ns = /** @type {any} */ (root).MUPhysics || (/** @type {any} */ (root).MUPhysics = {}); ns.model = factory(ns.powertrain, ns.tyre); }
})(typeof globalThis !== "undefined" ? globalThis : this, function (/** @type {typeof import("./powertrain.js")} */ powertrain, /** @type {typeof import("./tyre.js")} */ tyre) {
    "use strict";

    const BUNDLE_FORMAT = "mapunite-bike-bundle/1";
    /** SI unit of every prior the physics reads. */
    const PRIOR_UNITS = Object.freeze({
        cda: "m2", crr: "1", drivetrainEfficiency: "1", riderMass: "kg", indicatedEfficiency: "1",
        fmepA: "Pa", fmepB: "Pa*s/rad", fmepC: "Pa*s2/rad2", redlineFactor: "1", motorEfficiency: "1", regenEfficiency: "1"
    });
    /** Documented assumptions used when the data doesn't say. */
    const MODEL_DEFAULTS = Object.freeze({
        lugIdleFactor: 1.6,         // lowest comfortable engine speed in a gear: 1.6 × idle …
        lugTorqueFactor: 0.35,      // … and at least 35 % of the torque-peak speed
        fuelCutIdleFactor: 1.3,     // fuel injection cuts fuel on overrun above 1.3 × idle
        cvtEngageIdleFactor: 1.8,   // centrifugal clutch engages at 1.8 × idle …
        cvtEngageTorqueFactor: 0.5, // … or 50 % of the torque-peak speed, whichever is higher
        cvtCruiseTorqueFactor: 0.85,// steady-cruise variator speed: 85 % of the torque-peak speed
        dryMassFluids: 3,           // kg of oil/coolant added to a dry mass
        dryMassFuelShare: 0.9,      // and a 90 % full tank
        usableBatteryShare: { mean: 0.92, sigma: 0.03 },  // usable ÷ gross when only gross is published
        auxPower: { mean: 35, sigma: 15 },                // W: controller, display, lights (EV)
        regenLimitShare: 0.5,       // regen power limit = rated power, else 50 % of peak
        gearAdviceMinConf: 0.5,     // gear advice needs the bike's own gearing at least this trustworthy
        riderMassUserSigma: 2,      // kg, when the rider entered their own mass
        defaultFuel: "E20"          // the fuel Indian pumps sell since 2025, unless the rider says otherwise
    });


    /**
     * @param {any} bundle   runtime bundle (SI)
     * @param {{ classDefault?: any, settings?: RiderSettings }} [opts]
     * @returns {BikeModel}
     */
    function createBikeModel(bundle, opts = {}) {
        checkBundle(bundle, "bundle");
        const cd = opts.classDefault;
        if (cd !== undefined) {
            checkBundle(cd, "classDefault");
            if (cd.kind !== "class_default" || cd.classKey !== bundle.classKey) throw new Error(`classDefault must be the class default for ${bundle.classKey}`);
        }
        const s = opts.settings || {};
        const flags = [];
        const pt = bundle.powertrain;
        const get = reader(bundle);
        const getCd = cd ? reader(cd) : () => undefined;

        // ---- mass ----
        let vehicleMass = /** @type {number} */ (get("chassis", "mass", "kg", true));
        const basis = bundle.chassis.mass.basis;
        if (basis === "dry" && pt !== "ev") {
            const tank = get("chassis", "fuelTank", "m3") ?? getCd("chassis", "fuelTank", "m3");
            if (tank === undefined) throw new Error(`${bundle.id}: published mass is dry and no tank capacity is known (bike or class default) — can't add the fuel`);
            vehicleMass += MODEL_DEFAULTS.dryMassFluids + MODEL_DEFAULTS.dryMassFuelShare * tank * pickFuel(bundle, s.fuelCode).density;
            flags.push("published mass is dry: fuel and fluids added");
        } else if (basis === "unspecified") flags.push("mass basis not published: treated as kerb mass");
        const pillion = nonNeg(s.pillionMass, "pillionMass"), luggage = nonNeg(s.luggageMass, "luggageMass");

        // ---- tyre ----
        const tyreCode = s.rearTyre !== undefined ? s.rearTyre : bundle.chassis.rearTyre.v;
        const unloadedRadius = tyre.parseTyre(tyreCode).diameterM / 2;
        if (s.rearTyre !== undefined) flags.push("rear tyre from rider settings");

        // ---- priors → uncertain parameters ----
        /** @type {Record<string, Uncertain>} */
        const params = {};
        /** @param {keyof typeof PRIOR_UNITS} key @param {string} name */
        const prior = (key, name) => {
            const p = bundle.priors && bundle.priors[key];
            if (!p) throw new Error(`${bundle.id}: prior ${key} missing — the build resolves every prior, so this bundle is malformed`);
            if (p.u !== PRIOR_UNITS[key]) throw new Error(`${bundle.id}: prior ${key} must be in ${PRIOR_UNITS[key]} (got ${p.u}) — not an SI bundle?`);
            if (!(Number.isFinite(p.mean) && Number.isFinite(p.sigma) && p.sigma >= 0)) throw new Error(`${bundle.id}: prior ${key} needs a finite mean and sigma ≥ 0`);
            params[name] = { mean: p.mean, sigma: p.sigma };
        };
        prior("cda", "cda"); prior("crr", "crr"); prior("drivetrainEfficiency", "etaDt"); prior("riderMass", "riderMass");
        if (s.riderMass !== undefined) params.riderMass = { mean: pos(s.riderMass, "riderMass"), sigma: MODEL_DEFAULTS.riderMassUserSigma };
        params.deflection = { mean: tyre.DEFLECTION.mean, sigma: tyre.DEFLECTION.sigma };

        // ---- sprockets from the rider ----
        let riderFinal = null;
        if (s.frontSprocket !== undefined || s.rearSprocket !== undefined) {
            if (pt === "ice_cvt") throw new RangeError("a CVT scooter has no sprockets to set");
            const f = pos(s.frontSprocket, "frontSprocket"), r = pos(s.rearSprocket, "rearSprocket");
            if (!Number.isInteger(f) || !Number.isInteger(r)) throw new RangeError("sprocket teeth must be whole numbers");
            riderFinal = r / f;
            flags.push("final drive from the rider's sprockets");
        }

        /** @type {BikeModel["engine"]} */ let engine = null;
        /** @type {BikeModel["motor"]} */ let motor = null;
        /** @type {BikeModel["battery"]} */ let battery = null;
        /** @type {BikeModel["fuel"]} */ let fuel = null;
        /** @type {BikeModel["drive"]} */ let drive;
        let gearAdvice = false;
        /** @type {BikeModel["gearAdviceReason"]} */
        let gearAdviceReason = pt === "ev" ? "single-speed" : pt === "ice_cvt" ? "cvt" : null;

        if (pt === "ice_manual" || pt === "ice_cvt") {
            prior("indicatedEfficiency", "etaInd"); prior("fmepA", "fmepA"); prior("fmepB", "fmepB"); prior("fmepC", "fmepC"); prior("redlineFactor", "redlineFactor");
            const wP = /** @type {number} */ (get("engine", "peakPowerRpm", "rad/s", true));
            const wT = /** @type {number} */ (get("engine", "peakTorqueRpm", "rad/s", true));
            let wI = get("engine", "idleRpm", "rad/s");
            if (wI === undefined) {
                wI = getCd("engine", "idleRpm", "rad/s");
                if (wI === undefined) throw new Error(`${bundle.id}: no idle speed published — pass the class default bundle as opts.classDefault (idle speed is never guessed)`);
                flags.push("idle speed from the class default");
            }
            // Top engine speed for advice: the published redline, else the rev limiter, else redlineFactor × ω_P.
            const red = get("engine", "redlineRpm", "rad/s") ?? get("engine", "limiterRpm", "rad/s") ?? params.redlineFactor.mean * wP;
            const samples = publishedTorque(bundle);
            const curve = powertrain.buildTorqueCurve({
                peakPower: /** @type {number} */ (get("engine", "peakPower", "W", true)), omegaPower: wP,
                peakTorque: /** @type {number} */ (get("engine", "peakTorque", "N*m", true)), omegaTorque: wT,
                omegaIdle: /** @type {number} */ (wI), omegaMax: red,
                samples: samples ? samples.samples : undefined
            });
            if (samples) flags.push(samples.flag);
            for (const f of curve.flags) flags.push(`torque curve: ${f}`);
            const strokes = get("engine", "strokes", "1", true);
            engine = {
                curve,
                displacement: /** @type {number} */ (get("engine", "displacement", "m3", true)),
                revsPerCycle: strokes === 2 ? 1 : 2,
                fuelInjected: bundle.engine.fuelSystem.v === "fi",
                omegaIdle: curve.omegaIdle,
                omegaCut: MODEL_DEFAULTS.fuelCutIdleFactor * curve.omegaIdle,
                omegaLug: Math.max(MODEL_DEFAULTS.lugIdleFactor * curve.omegaIdle, MODEL_DEFAULTS.lugTorqueFactor * curve.omegaTorque),
                omegaMax: curve.omegaMax
            };
            fuel = pickFuel(bundle, s.fuelCode);

            if (pt === "ice_manual") {
                const own = manualGearing(get);
                let g = own, source = "bike";
                if (!g) {
                    g = cd ? manualGearing(getCd) : null;
                    source = "class_default";
                    if (!g) throw new Error(`${bundle.id}: gearing incomplete (needs primary, gear and final ratios) — pass the class default bundle as opts.classDefault`);
                    flags.push("gearing from the class default: gear advice off");
                }
                const final = riderFinal ?? g.final;
                drive = { kind: "manual", primary: g.primary, gearRatios: g.gears, final, ratios: g.gears.map((x) => g.primary * x * final), cvt: null, evRatio: 0, source };
                gearAdvice = source === "bike";
                if (!gearAdvice) gearAdviceReason = "borrowed-gearing";
                if (gearAdvice && bundle.kind === "class_default") { gearAdvice = false; gearAdviceReason = "typical-bike"; flags.push("class default (a typical bike, not this one): gear advice off"); }
                if (gearAdvice) {
                    const t = bundle.transmission;
                    // the final drive is the rider's own sprockets (exact), else the published ratio, else the published sprockets
                    const finalConf = riderFinal !== null ? 1 : t.finalRatio ? t.finalRatio.conf : Math.min(t.frontSprocket.conf, t.rearSprocket.conf);
                    const conf = Math.min(t.primaryRatio.conf, t.gearRatios.conf, finalConf);
                    const speeds = get("transmission", "speeds", "1");
                    if (speeds !== undefined && speeds !== g.gears.length) { gearAdvice = false; gearAdviceReason = "gear-count-mismatch"; flags.push(`${g.gears.length} gear ratios for a ${speeds}-speed gearbox: gear advice off`); }
                    else if (!(conf >= MODEL_DEFAULTS.gearAdviceMinConf)) { gearAdvice = false; gearAdviceReason = "uncertain-gearing"; flags.push(`gear ratios too uncertain for gear advice (confidence ${conf})`); }
                }
            } else {
                let c = cvtGearing(get), source = "bike";
                if (!c) {
                    c = cd ? cvtGearing(getCd) : null;
                    source = "class_default";
                    if (!c) throw new Error(`${bundle.id}: CVT ratios incomplete — pass the class default bundle as opts.classDefault`);
                    flags.push("CVT ratios from the class default");
                }
                const omegaEngage = Math.max(MODEL_DEFAULTS.cvtEngageIdleFactor * curve.omegaIdle, MODEL_DEFAULTS.cvtEngageTorqueFactor * curve.omegaTorque);
                drive = {
                    kind: "cvt", primary: 1, gearRatios: [], final: c.final, ratios: [c.ratioMax * c.final, c.ratioMin * c.final], evRatio: 0, source,
                    cvt: { ratioMax: c.ratioMax, ratioMin: c.ratioMin, final: c.final, omegaEngage,
                        omegaCruise: Math.max(MODEL_DEFAULTS.cvtCruiseTorqueFactor * curve.omegaTorque, omegaEngage) }
                };
            }
        } else if (pt === "ev") {
            prior("motorEfficiency", "etaMotor"); prior("regenEfficiency", "etaRegen");
            params.aux = { ...MODEL_DEFAULTS.auxPower };
            const peakPower = /** @type {number} */ (get("motor", "peakPower", "W", true));
            const mount = bundle.motor.mount ? bundle.motor.mount.v : "unspecified";
            // Motor → wheel ratio: the bike's, hub = 1, stock sprockets, else the class default.
            // Rider sprockets change only the chain/belt stage: the overall ratio scales by
            // (new sprocket ratio ÷ stock sprocket ratio). Without the stock sprockets that
            // stage can't be separated from the rest of the reduction, so it's refused.
            let ratio = get("transmission", "reductionRatio", "1");
            let source = "bike";
            const fs = get("transmission", "frontSprocket", "1"), rs = get("transmission", "rearSprocket", "1");
            if (riderFinal !== null) {
                if (mount === "hub") throw new RangeError("a hub motor has no sprockets to set");
                if (fs !== undefined && rs !== undefined) ratio = (ratio === undefined ? rs / fs : ratio) * (riderFinal / (rs / fs));
                else if (ratio === undefined) { ratio = riderFinal; flags.push("rider's sprockets taken as the whole motor-to-wheel reduction"); }
                else throw new RangeError(`${bundle.id}: stock sprockets unknown, so new sprockets can't be applied to the ${ratio}:1 reduction`);
                source = "rider";
            } else if (ratio === undefined) {
                if (fs !== undefined && rs !== undefined) ratio = rs / fs;
                else if (mount === "hub") ratio = 1;
                else {
                    ratio = getCd("transmission", "reductionRatio", "1");
                    source = "class_default";
                    if (ratio !== undefined) flags.push("motor reduction ratio from the class default");
                }
            }
            // Wheel torque: only when we know where the published torque is measured.
            let wheelTorque = null, torqueAtWheel = false;
            const tq = bundle.motor.peakTorque;
            if (tq) {
                if (tq.u !== "N*m") throw new Error(`${bundle.id}: motor.peakTorque must be in N*m`);
                const at = tq.at === "unspecified" ? (mount === "hub" ? "wheel" : ratio !== undefined ? "motor" : "unknown") : tq.at;
                if (at === "wheel") { wheelTorque = tq.v; torqueAtWheel = true; }
                else if (at === "motor" && ratio !== undefined) wheelTorque = tq.v * ratio;
                else flags.push("motor torque can't be placed (motor or wheel?): force limited by power only");
                if (tq.at === "unspecified" && at !== "unknown") flags.push(`motor torque taken as measured at the ${at}`);
            } else flags.push("no motor torque published: force limited by power only");
            const rated = get("motor", "ratedPower", "W");
            const topSpeed = get("chassis", "topSpeed", "m/s");
            motor = { peakPower, wheelTorque, torqueAtWheel, regenLimit: rated ?? MODEL_DEFAULTS.regenLimitShare * peakPower, speedLimit: topSpeed ?? null };
            const gross = /** @type {number} */ (get("battery", "grossCapacity", "J", true));
            const usable = get("battery", "usableCapacity", "J") ?? null;
            if (usable === null) { params.usableShare = { ...MODEL_DEFAULTS.usableBatteryShare }; flags.push("usable battery energy not published: 92 % ± 3 % of gross assumed"); }
            battery = { gross, usable };
            drive = { kind: "ev", primary: 1, gearRatios: [], final: 1, ratios: [], cvt: null, evRatio: ratio === undefined ? 0 : ratio, source };
        } else throw new Error(`${bundle.id}: unknown powertrain ${pt}`);

        const topSpeed = get("chassis", "topSpeed", "m/s") ?? null;
        return {
            id: bundle.id,
            title: [bundle.identity.make, bundle.identity.model, bundle.identity.variant].filter(Boolean).join(" "),
            kind: bundle.kind, powertrain: pt, classKey: bundle.classKey,
            massFixed: vehicleMass + pillion + luggage, vehicleMass,
            tyreCode, unloadedRadius,
            drive, gearAdvice, gearAdviceReason, engine, motor, battery, fuel, topSpeed,
            params, flags
        };
    }

    // ------------------------------------------------------------------
    /** @param {any} b @param {string} name */
    function checkBundle(b, name) {
        if (!b || typeof b !== "object") throw new TypeError(`${name} must be a runtime bundle object`);
        if (b.format !== BUNDLE_FORMAT) throw new Error(`${name}: expected format ${BUNDLE_FORMAT}, got ${JSON.stringify(b.format)}`);
        if (b.units !== "SI") throw new Error(`${name}: the physics core only reads strict-SI bundles ("units": "SI")`);
    }

    /** Reader for one bundle: value in the expected SI unit, or undefined. @param {any} b */
    function reader(b) {
        /**
         * @param {string} group @param {string} key @param {string} unit @param {boolean} [required]
         * @returns {any}  number (or number[] for gear ratios), undefined when absent
         */
        return (group, key, unit, required = false) => {
            const node = b[group] && b[group][key];
            if (!node) {
                if (required) throw new Error(`${b.id}: ${group}.${key} is required`);
                return undefined;
            }
            if (node.u !== unit) throw new Error(`${b.id}: ${group}.${key} must be in ${unit} (got ${node.u}) — not an SI bundle?`);
            const ok = Array.isArray(node.v) ? node.v.length > 0 && node.v.every((/** @type {unknown} */ x) => typeof x === "number" && Number.isFinite(x)) : typeof node.v === "number" && Number.isFinite(node.v);
            if (!ok) throw new Error(`${b.id}: ${group}.${key} is not a finite number`);
            return node.v;
        };
    }

    /** @param {(g: string, k: string, u: string) => any} get */
    function manualGearing(get) {
        const primary = get("transmission", "primaryRatio", "1");
        const gears = get("transmission", "gearRatios", "1");
        let final = get("transmission", "finalRatio", "1");
        if (final === undefined) {
            const f = get("transmission", "frontSprocket", "1"), r = get("transmission", "rearSprocket", "1");
            if (f !== undefined && r !== undefined) final = r / f;
        }
        if (primary === undefined || !Array.isArray(gears) || gears.length === 0 || final === undefined) return null;
        return { primary, gears, final };
    }

    /** @param {(g: string, k: string, u: string) => any} get */
    function cvtGearing(get) {
        const ratioMax = get("transmission", "cvtRatioMax", "1"), ratioMin = get("transmission", "cvtRatioMin", "1"), final = get("transmission", "finalRatio", "1");
        return ratioMax !== undefined && ratioMin !== undefined && final !== undefined ? { ratioMax, ratioMin, final } : null;
    }

    /**
     * A published curve as torque samples (SI). A torque curve is used as is; a power
     * curve is converted exactly (T = P/ω), so it needs ω > 0 at every sample.
     * Synthesized curves are skipped: the model synthesizes its own from the peaks.
     * @param {any} bundle
     * @returns {{ samples: { omegaStart: number, omegaStep: number, values: number[] }, flag: string } | null}
     */
    function publishedTorque(bundle) {
        const curves = bundle.curves || {};
        /** @param {string} kind @param {string} unit */
        const pick = (kind, unit) => {
            const c = curves[kind];
            if (!c || c.method === "synthesized") return null;
            if (c.u !== unit) throw new Error(`${bundle.id}: curves.${kind} must be in ${unit} (got ${c.u}) — not an SI bundle?`);
            return c;
        };
        const t = pick("torque", "N*m");
        if (t) return { samples: { omegaStart: t.omegaStart, omegaStep: t.omegaStep, values: t.data.map((/** @type {number} */ q) => q * t.scale) }, flag: `torque curve as published (${t.method})` };
        const p = pick("power", "W");
        if (!p) return null;
        if (!(p.omegaStart > 0)) throw new Error(`${bundle.id}: curves.power starts at 0 rad/s — torque = P/ω is undefined there`);
        return {
            samples: { omegaStart: p.omegaStart, omegaStep: p.omegaStep, values: p.data.map((/** @type {number} */ q, /** @type {number} */ i) => Math.max(0, q * p.scale) / (p.omegaStart + i * p.omegaStep)) },
            flag: `torque from the published power curve (${p.method}), T = P/ω`
        };
    }

    /** @param {any} bundle @param {string|undefined} code @returns {{ code: string, lhv: number, density: number }} */
    function pickFuel(bundle, code) {
        const grades = (bundle.reference && bundle.reference.fuelGrades && bundle.reference.fuelGrades.grades) || [];
        const want = code || MODEL_DEFAULTS.defaultFuel;
        const g = grades.find((/** @type {any} */ x) => x.code === want);   // never silently a different fuel
        if (!g) throw new Error(`${bundle.id}: fuel ${want} is not in the bundle's fuel-grade table`);
        if (g.lhv.u !== "J/m3" || g.density.u !== "kg/m3") throw new Error(`${bundle.id}: fuel grades must be SI (J/m3, kg/m3)`);
        return { code: g.code, lhv: g.lhv.v, density: g.density.v };
    }

    /** @param {unknown} x @param {string} name @returns {number} */
    function pos(x, name) {
        if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) throw new RangeError(`${name} must be a positive number`);
        return x;
    }
    /** @param {unknown} x @param {string} name @returns {number} */
    function nonNeg(x, name) {
        if (x === undefined) return 0;
        if (typeof x !== "number" || !Number.isFinite(x) || x < 0) throw new RangeError(`${name} must be a number ≥ 0`);
        return x;
    }

    return { BUNDLE_FORMAT, PRIOR_UNITS, MODEL_DEFAULTS, createBikeModel };
});
