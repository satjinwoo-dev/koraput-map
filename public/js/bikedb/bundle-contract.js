// @ts-check
/* ============================================================================
   MapUnite — Bike profile bundle contract (schema v1) + validator
   ==============================================================================
   ONE source of truth for the bike data contract:
     - FIELDS: every technical field, its canonical unit, its plausible range and
       which powertrains require it.
     - validateBundle(): structural + unit + provenance + physics checks for one
       bundle (a variant or a class default).
     - validateCatalog(): cross-file checks (ids, class defaults coverage,
       priors resolution, reference tables).
     - buildJsonSchema(): emits lib/bikedb/bundle.schema.json from FIELDS, so the
       editor schema and this validator can never drift apart
       (scripts/bikedb/gen-schema.mjs; a test fails if the committed file is stale).

   Runs unchanged in the browser (window.BikeContract), the Android app and
   Node (require / import). No dependencies.

   Conventions (see data/bikes/README.md):
     Quantity    { v: number | number[], u: "<canonical unit>", src: "<source id>", conf: 0..1, tol?, note? }
     Categorical { v: string | boolean, src, conf, note? }
     Prior       { mean, sigma, u, src, conf, note? }   (uncertain model parameters)
   Data files use each field's canonical PUBLISHED unit (the one in FIELDS:
   rpm, cm3, kW, kWh, km/h, L, RON …), so a value can be checked against its
   document. Anything else ("hp", "PS", "Nm", "kgf*m") is rejected — convert
   when entering data and say so in `note`. Machines read strict SI only:
   SI_UNITS / toSI() below convert for bikes.sqlite, the runtime bundles,
   catalog.json and the physics core.
   ============================================================================ */

(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else /** @type {any} */ (root).BikeContract = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const SCHEMA_VERSION = "1.0.0";
    const SUPPORTED_MAJOR = 1;

    // ------------------------------------------------------------------
    // Enumerations
    // ------------------------------------------------------------------
    const POWERTRAINS = ["ice_manual", "ice_cvt", "ev"];
    const SEGMENTS = ["commuter", "naked", "sport", "adventure", "cruiser", "scooter", "maxi_scooter"];
    /** Valid powertrain × segment combinations — each needs exactly one class default. */
    const CLASS_MATRIX = {
        ice_manual: ["commuter", "naked", "sport", "adventure", "cruiser"],
        ice_cvt: ["scooter", "maxi_scooter"],
        ev: ["scooter", "commuter", "sport"]
    };
    const TRANSMISSION_FOR = { ice_manual: "manual", ice_cvt: "cvt", ev: "single_speed" };

    const SOURCE_KINDS = ["manufacturer", "owners_manual", "service_manual", "homologation", "licensed_db",
        "aggregator", "press", "community", "regulation", "derived", "estimated", "class_prior"];
    /** Sources that can back fuel advice on their own. */
    const AUTHORITATIVE_KINDS = ["manufacturer", "owners_manual", "service_manual", "homologation", "licensed_db"];
    /** Kinds that must point at a document. */
    const URL_REQUIRED_KINDS = ["manufacturer", "owners_manual", "service_manual", "homologation", "aggregator", "press", "regulation"];
    /** Kinds that must explain how the value was obtained. */
    const NOTE_REQUIRED_KINDS = ["derived", "estimated", "class_prior", "community"];
    /** Honesty caps: a value can't be more certain than the kind of source behind it. */
    const CONF_CAP = { aggregator: 0.8, press: 0.8, community: 0.6, estimated: 0.6, class_prior: 0.5 };
    /**
     * Fuel safety has two thresholds, on purpose:
     *  - CERT_MIN_CONF: a VARIANT may enter the catalog only with at least one real manufacturer
     *    certification ("certified", authoritative source, conf ≥ 0.5) — even if it's from an older
     *    manual. Press reports, aggregators and "compatible" entries don't count. (validateBundle error)
     *  - ADVISE_MIN_CONF: the app only ADVISES a fuel at conf ≥ 0.7 (isFuelAdvisable). A variant with
     *    nothing advisable yet passes validation with a warning; the rider sees "check your manual".
     */
    const CERT_MIN_CONF = 0.5;
    const ADVISE_MIN_CONF = 0.7;

    const FUEL_STATUS = ["certified", "compatible", "not_approved", "unknown"];
    const COOLING = ["air", "oil", "air_oil", "liquid"];
    const FUEL_SYSTEM = ["fi", "carb"];
    const MOTOR_TYPES = ["pmsm", "bldc", "pmac", "ipm", "induction", "other"];
    const MOTOR_MOUNTS = ["hub", "mid_drive", "unspecified"];
    const DRIVES = ["chain", "belt", "shaft", "hub_direct", "gear"];
    const MASS_BASIS = ["kerb", "dry", "unspecified"];
    const TORQUE_AT = ["motor", "wheel", "unspecified"];
    const RANGE_CYCLES = ["IDC", "MIDC", "WMTC", "manufacturer_true_range", "other"];
    const CURVE_KINDS = ["torque", "power"];

    const ICE = ["ice_manual", "ice_cvt"];
    const EV = ["ev"];
    const ALL = ["ice_manual", "ice_cvt", "ev"];

    // ------------------------------------------------------------------
    // Strict SI. Data files keep the units the manufacturer published (rpm,
    // cm3, kW, kWh, km/h, L …) so every value can be checked against its
    // document. Everything a machine reads — bikes.sqlite, the runtime
    // bundles, catalog.json and the physics core — uses strict SI, converted
    // here and only here. A pure power-of-ten conversion (cm3 → m3, kW → W)
    // is an exact decimal shift, so 349.34 cm3 becomes 0.00034934 m3 with no
    // binary noise; the rest are exact ratios applied as v * num / den. No
    // unit here has an offset, so one rule converts values, tolerances and sigmas.
    // ------------------------------------------------------------------
    /** @type {Record<string, { si: string, exp10?: number, num?: number, den?: number }>} */
    const SI_UNITS = {
        "1": { si: "1", exp10: 0 },
        "RON": { si: "1", exp10: 0 },                       // octane is a dimensionless index
        "mm": { si: "m", exp10: -3 },
        "km": { si: "m", exp10: 3 },
        "m2": { si: "m2", exp10: 0 },
        "cm3": { si: "m3", exp10: -6 },
        "L": { si: "m3", exp10: -3 },
        "kg": { si: "kg", exp10: 0 },
        "km/h": { si: "m/s", num: 1000, den: 3600 },
        "rpm": { si: "rad/s", num: Math.PI, den: 30 },
        "N*m": { si: "N*m", exp10: 0 },
        "kW": { si: "W", exp10: 3 },
        "kWh": { si: "J", num: 3.6e6, den: 1 },
        "V": { si: "V", exp10: 0 },
        "kPa": { si: "Pa", exp10: 3 },
        // friction MEP terms per krpm: 1 krpm = 1000·π/30 rad/s
        "kPa/krpm": { si: "Pa*s/rad", num: 30, den: Math.PI },
        "kPa/krpm2": { si: "Pa*s2/rad2", num: 900, den: 1000 * Math.PI * Math.PI },
        // reference tables
        "MJ/L": { si: "J/m3", exp10: 9 },
        "kg/L": { si: "kg/m3", exp10: 3 }
    };

    /** x × 10^k as the double nearest the exact decimal result. */
    function shift10(x, k) {
        if (k === 0 || x === 0) return x;
        const [m, e] = x.toExponential().split("e");
        return Number(`${m}e${Number(e) + k}`);
    }

    /** SI unit for a published unit. Throws on a unit with no conversion, so nothing unconverted can slip through. */
    function siUnit(unit) {
        const c = SI_UNITS[unit];
        if (!c) throw new Error(`no SI conversion for unit "${unit}"`);
        return c.si;
    }

    /**
     * Convert a value (or an array of values) from a published unit to SI.
     * @template {number | number[]} T
     * @param {T} v
     * @param {string} unit
     * @returns {T}
     */
    function toSI(v, unit) {
        const c = SI_UNITS[unit];
        if (!c) throw new Error(`no SI conversion for unit "${unit}"`);
        const one = (x) => (c.exp10 !== undefined ? shift10(x, c.exp10) : (x * /** @type {number} */ (c.num)) / /** @type {number} */ (c.den));
        return /** @type {any} */ (Array.isArray(v) ? v.map(one) : one(v));
    }

    // ------------------------------------------------------------------
    // Field table — path, type, unit, [min, max], required-for, options
    //   type: q = quantity, qa = quantity array, c = categorical, p = prior
    //   req:  powertrains for which the field is REQUIRED (always), or
    //         "default" entries: required in class defaults only
    // ------------------------------------------------------------------
    /** @typedef {{ path: string, type: "q"|"qa"|"c"|"p", unit?: string, range?: [number, number], req?: string[], reqDefault?: string[], allow?: string[], int?: boolean, enumV?: (string|number|boolean)[], pattern?: string, extra?: Record<string, string[]>, len?: [number, number], doc: string }} FieldSpec */
    /** @type {FieldSpec[]} */
    const FIELDS = [
        // ---- engine (ICE) ----
        { path: "engine.displacement", type: "q", unit: "cm3", range: [40, 2500], req: ICE, allow: ICE, doc: "Swept volume" },
        { path: "engine.cylinders", type: "q", unit: "1", range: [1, 6], req: ICE, allow: ICE, int: true, doc: "Number of cylinders" },
        { path: "engine.strokes", type: "q", unit: "1", req: ICE, allow: ICE, int: true, enumV: [2, 4], doc: "2- or 4-stroke cycle" },
        { path: "engine.bore", type: "q", unit: "mm", range: [30, 120], req: ICE, allow: ICE, doc: "Cylinder bore" },
        { path: "engine.stroke", type: "q", unit: "mm", range: [30, 120], req: ICE, allow: ICE, doc: "Piston stroke" },
        { path: "engine.compressionRatio", type: "q", unit: "1", range: [6, 16], allow: ICE, doc: "Geometric compression ratio" },
        { path: "engine.cooling", type: "c", req: ICE, allow: ICE, enumV: COOLING, doc: "Cooling method" },
        { path: "engine.fuelSystem", type: "c", req: ICE, allow: ICE, enumV: FUEL_SYSTEM, doc: "fi = fuel injection (cuts fuel on overrun), carb = carburettor" },
        { path: "engine.flexFuel", type: "c", allow: ICE, enumV: [true, false], doc: "Manufacturer-certified flex-fuel engine (E85/E100 capable). Absent = false" },
        { path: "engine.peakPower", type: "q", unit: "kW", range: [1, 250], req: ICE, allow: ICE, doc: "Peak net power" },
        { path: "engine.peakPowerRpm", type: "q", unit: "rpm", range: [2000, 16000], req: ICE, allow: ICE, doc: "Engine speed at peak power" },
        { path: "engine.peakTorque", type: "q", unit: "N*m", range: [3, 250], req: ICE, allow: ICE, doc: "Peak net torque (engine only — no electric assist)" },
        { path: "engine.peakTorqueRpm", type: "q", unit: "rpm", range: [1000, 14000], req: ICE, allow: ICE, doc: "Engine speed at peak torque" },
        { path: "engine.idleRpm", type: "q", unit: "rpm", range: [600, 2500], allow: ICE, reqDefault: ICE, doc: "Warm idle speed (tol = ± from manual)" },
        { path: "engine.redlineRpm", type: "q", unit: "rpm", range: [3000, 17000], allow: ICE, doc: "Start of tachometer red zone" },
        { path: "engine.limiterRpm", type: "q", unit: "rpm", range: [3000, 18000], allow: ICE, doc: "Rev limiter" },

        // ---- motor + battery (EV) ----
        { path: "motor.type", type: "c", req: EV, allow: EV, enumV: MOTOR_TYPES, doc: "Motor technology" },
        { path: "motor.mount", type: "c", req: EV, allow: EV, enumV: MOTOR_MOUNTS, doc: "Hub motor or mid-drive" },
        { path: "motor.peakPower", type: "q", unit: "kW", range: [0.25, 150], req: EV, allow: EV, doc: "Peak motor power" },
        { path: "motor.ratedPower", type: "q", unit: "kW", range: [0.25, 150], allow: EV, doc: "Rated / nominal / continuous power" },
        { path: "motor.peakTorque", type: "q", unit: "N*m", range: [5, 2000], allow: EV, extra: { at: TORQUE_AT }, doc: "Peak torque; `at` says whether measured at the motor or the wheel" },
        { path: "battery.grossCapacity", type: "q", unit: "kWh", range: [0.5, 30], req: EV, allow: EV, doc: "Installed (gross) battery energy" },
        { path: "battery.usableCapacity", type: "q", unit: "kWh", range: [0.5, 30], allow: EV, doc: "Usable battery energy" },
        { path: "battery.nominalVoltage", type: "q", unit: "V", range: [24, 900], allow: EV, doc: "Nominal pack voltage" },
        { path: "battery.chemistry", type: "c", allow: EV, pattern: "^[A-Za-z0-9 ()/+.-]{2,40}$", doc: "Cell chemistry as published" },
        { path: "battery.certifiedRange", type: "q", unit: "km", range: [10, 1000], allow: EV, extra: { cycle: RANGE_CYCLES }, doc: "Certified range per charge; `cycle` names the test cycle" },

        // ---- transmission ----
        { path: "transmission.kind", type: "c", req: ALL, allow: ALL, enumV: ["manual", "cvt", "single_speed"], doc: "Must match the powertrain" },
        { path: "transmission.speeds", type: "q", unit: "1", range: [1, 7], req: ["ice_manual"], allow: ["ice_manual"], int: true, doc: "Number of gears" },
        { path: "transmission.primaryRatio", type: "q", unit: "1", range: [1, 5], allow: ["ice_manual"], reqDefault: ["ice_manual"], doc: "Crank → gearbox reduction" },
        { path: "transmission.gearRatios", type: "qa", unit: "1", range: [0.3, 5], allow: ["ice_manual"], reqDefault: ["ice_manual"], len: [1, 7], doc: "Gear ratios, 1st → top, strictly decreasing" },
        { path: "transmission.finalRatio", type: "q", unit: "1", range: [1, 16], allow: ALL, reqDefault: ["ice_manual", "ice_cvt"], doc: "Final / secondary reduction (sprockets on manual bikes, gear reduction on CVT scooters)" },
        { path: "transmission.frontSprocket", type: "q", unit: "1", range: [9, 25], allow: ["ice_manual", "ev"], int: true, doc: "Front sprocket teeth" },
        { path: "transmission.rearSprocket", type: "q", unit: "1", range: [25, 70], allow: ["ice_manual", "ev"], int: true, doc: "Rear sprocket teeth" },
        { path: "transmission.cvtRatioMax", type: "q", unit: "1", range: [1.2, 4], allow: ["ice_cvt"], reqDefault: ["ice_cvt"], doc: "CVT ratio at launch (largest)" },
        { path: "transmission.cvtRatioMin", type: "q", unit: "1", range: [0.5, 1.5], allow: ["ice_cvt"], reqDefault: ["ice_cvt"], doc: "CVT ratio at top speed (smallest)" },
        { path: "transmission.drive", type: "c", allow: ALL, enumV: DRIVES, doc: "Final drive type" },
        { path: "transmission.reductionRatio", type: "q", unit: "1", range: [1, 20], allow: EV, reqDefault: EV, doc: "Motor → wheel reduction (1 for direct hub motors)" },

        // ---- chassis ----
        { path: "chassis.mass", type: "q", unit: "kg", range: [50, 450], req: ALL, allow: ALL, extra: { basis: MASS_BASIS }, doc: "Vehicle mass; `basis` says kerb (fluids + fuel) or dry" },
        { path: "chassis.fuelTank", type: "q", unit: "L", range: [2, 35], req: ICE, allow: ICE, doc: "Fuel tank capacity" },
        { path: "chassis.frontTyre", type: "c", req: ALL, allow: ALL, pattern: "TYRE", doc: "Front tyre size, e.g. 100/90-19 57P" },
        { path: "chassis.rearTyre", type: "c", req: ALL, allow: ALL, pattern: "TYRE", doc: "Rear tyre size, e.g. 120/80-18 62P" },
        { path: "chassis.topSpeed", type: "q", unit: "km/h", range: [20, 350], allow: ALL, doc: "Manufacturer-published top speed" },

        // ---- emission ----
        { path: "emission.standard", type: "c", req: ICE, allow: ICE, pattern: "^[A-Z0-9-]{2,16}$", doc: "Code from data/bikes/reference/emission-standards.json" },
        { path: "emission.obd", type: "c", allow: ICE, pattern: "^OBD-[0-9A-Z]{1,4}$", doc: "OBD stage code from the same table" },

        // ---- fuel ----
        { path: "fuel.minRon", type: "q", unit: "RON", range: [80, 102], allow: ICE, doc: "Manufacturer's minimum research octane number" },

        // ---- priors (uncertain model parameters; class defaults carry the full set) ----
        { path: "priors.cda", type: "p", unit: "m2", range: [0.1, 1.2], allow: ALL, reqDefault: ALL, doc: "Effective drag area, bike + rider" },
        { path: "priors.crr", type: "p", unit: "1", range: [0.004, 0.05], allow: ALL, reqDefault: ALL, doc: "Rolling-resistance coefficient" },
        { path: "priors.drivetrainEfficiency", type: "p", unit: "1", range: [0.5, 0.99], allow: ALL, reqDefault: ALL, doc: "Gearbox/CVT/belt + final drive efficiency" },
        { path: "priors.riderMass", type: "p", unit: "kg", range: [40, 150], allow: ALL, reqDefault: ALL, doc: "Default rider + gear mass" },
        { path: "priors.indicatedEfficiency", type: "p", unit: "1", range: [0.15, 0.45], allow: ICE, reqDefault: ICE, doc: "Willans slope: indicated thermal efficiency" },
        { path: "priors.fmepA", type: "p", unit: "kPa", range: [20, 400], allow: ICE, reqDefault: ICE, doc: "Friction MEP = A + B·krpm + C·krpm²" },
        { path: "priors.fmepB", type: "p", unit: "kPa/krpm", range: [0, 60], allow: ICE, reqDefault: ICE, doc: "Friction MEP linear term" },
        { path: "priors.fmepC", type: "p", unit: "kPa/krpm2", range: [0, 10], allow: ICE, reqDefault: ICE, doc: "Friction MEP quadratic term" },
        { path: "priors.redlineFactor", type: "p", unit: "1", range: [1, 1.5], allow: ICE, reqDefault: ICE, doc: "Redline ÷ peak-power rpm, when redline isn't published" },
        { path: "priors.motorEfficiency", type: "p", unit: "1", range: [0.6, 0.98], allow: EV, reqDefault: EV, doc: "Battery → wheel efficiency (inverter + motor)" },
        { path: "priors.regenEfficiency", type: "p", unit: "1", range: [0, 0.9], allow: EV, reqDefault: EV, doc: "Share of braking energy recovered" }
    ];
    const FIELD_BY_PATH = Object.fromEntries(FIELDS.map((f) => [f.path, f]));
    const GROUPS = ["engine", "motor", "battery", "transmission", "chassis", "emission", "fuel", "priors"];
    const TOP_KEYS = ["$schema", "schemaVersion", "id", "kind", "classKey", "segment", "powertrain", "identity", "image", "sources", "engine", "motor", "battery", "transmission", "chassis", "emission", "fuel", "curves", "priors", "notes"];
    const IDENTITY_KEYS = ["make", "model", "variant", "market", "yearFrom", "yearTo", "aliases"];
    const IMAGE_KEYS = ["url", "src", "credit", "note"];
    const IMAGE_URL_RE = /^https:\/\/[^\s/$.?#][^\s]*$/i;

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------
    const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
    const isNum = (x) => typeof x === "number" && Number.isFinite(x);
    const get = (o, path) => path.split(".").reduce((a, k) => (a && isObj(a) ? a[k] : undefined), o);
    const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const SRC_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

    /**
     * Tyre size → rim, width, aspect, diameter. Accepts metric ("120/80-18 62P",
     * "140/70R17 M/C 66H", "150/60 ZR 17", "90/90 - R12") and numeric inch
     * sizes ("2.75-18", "3.00x18").
     * @param {string} s
     * @returns {{ widthMm: number, aspect: number|null, rimIn: number, diameterM: number } | null}
     */
    function parseTyre(s) {
        if (typeof s !== "string") return null;
        const t = s.replace(/["”]/g, "").replace(/\s+/g, " ").trim();
        let m = /^(\d{2,3})\s?\/\s?(\d{2,3})\s?(?:-|\s)?\s?(?:Z?R|B|-)?\s?-?\s?(\d{2})(?!\d)/i.exec(t);
        if (m) {
            const w = Number(m[1]), a = Number(m[2]), rim = Number(m[3]);
            if (w < 50 || w > 360 || a < 30 || a > 110 || rim < 8 || rim > 23) return null;
            return { widthMm: w, aspect: a, rimIn: rim, diameterM: (rim * 25.4 + 2 * w * (a / 100)) / 1000 };
        }
        m = /^(\d\.\d{2})\s?[-x×]\s?(\d{2})(?!\d)/i.exec(t);
        if (m) {
            const wIn = Number(m[1]), rim = Number(m[2]);
            if (wIn < 2 || wIn > 6 || rim < 8 || rim > 23) return null;
            // Numeric sizes are ~100 % aspect: section height ≈ section width.
            return { widthMm: wIn * 25.4, aspect: null, rimIn: rim, diameterM: (rim + 2 * wIn) * 0.0254 };
        }
        return null;
    }

    /** Swept volume (cm³) from bore and stroke (mm). */
    const sweptVolumeCm3 = (boreMm, strokeMm, cylinders) => (Math.PI / 4) * boreMm * boreMm * strokeMm * cylinders / 1000;
    const omega = (rpm) => (2 * Math.PI * rpm) / 60;

    // ------------------------------------------------------------------
    // Validation core
    // ------------------------------------------------------------------
    /** @typedef {{ path: string, code: string, message: string }} Issue */
    /** @typedef {{ ok: boolean, errors: Issue[], warnings: Issue[] }} Result */
    /** @typedef {{ fuelGrades?: { grades: Array<{ code: string, ethanolVolFraction: number, flexFuelBlend?: boolean }> }, emissionStandards?: { standards: Array<{ code: string }>, obdLevels: Array<{ code: string }> } }} RefTables */

    function makeReporter() {
        /** @type {Issue[]} */ const errors = [];
        /** @type {Issue[]} */ const warnings = [];
        return {
            errors, warnings,
            err: (path, code, message) => errors.push({ path, code, message }),
            warn: (path, code, message) => warnings.push({ path, code, message })
        };
    }

    /**
     * Validate one bundle (variant or class default).
     * @param {any} b       parsed JSON
     * @param {RefTables} [ref]  reference tables (fuel grades, emission standards); checks that need them are skipped without
     * @returns {Result}
     */
    function validateBundle(b, ref = {}) {
        const R = makeReporter();
        if (!isObj(b)) { R.err("", "type", "bundle must be a JSON object"); return done(R); }

        // ---- top level ----
        for (const k of Object.keys(b)) if (!TOP_KEYS.includes(k)) R.err(k, "unknown_key", `unknown top-level key "${k}"`);
        if (typeof b.schemaVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(b.schemaVersion)) R.err("schemaVersion", "required", "schemaVersion must be semver, e.g. \"1.0.0\"");
        else if (Number(b.schemaVersion.split(".")[0]) !== SUPPORTED_MAJOR) R.err("schemaVersion", "unsupported", `schema major ${b.schemaVersion.split(".")[0]} not supported (this validator: ${SUPPORTED_MAJOR}.x)`);
        if (typeof b.id !== "string" || !ID_RE.test(b.id) || b.id.length > 80) R.err("id", "format", "id must be a lowercase slug (a-z, 0-9, hyphens), ≤ 80 chars");
        if (b.kind !== "variant" && b.kind !== "class_default") R.err("kind", "enum", "kind must be \"variant\" or \"class_default\"");
        if (!POWERTRAINS.includes(b.powertrain)) R.err("powertrain", "enum", `powertrain must be one of ${POWERTRAINS.join(", ")}`);
        if (!SEGMENTS.includes(b.segment)) R.err("segment", "enum", `segment must be one of ${SEGMENTS.join(", ")}`);
        const pt = POWERTRAINS.includes(b.powertrain) ? b.powertrain : null;
        const isDefault = b.kind === "class_default";
        if (pt && SEGMENTS.includes(b.segment) && !CLASS_MATRIX[pt].includes(b.segment)) R.err("segment", "invalid_class", `${pt} × ${b.segment} is not a supported class (valid: ${CLASS_MATRIX[pt].join(", ")})`);
        const expectedKey = `${b.powertrain}.${b.segment}`;
        if (b.classKey !== expectedKey) R.err("classKey", "mismatch", `classKey must be "${expectedKey}" (powertrain.segment)`);
        if (isDefault && b.id !== `default-${String(b.powertrain).replace(/_/g, "-")}-${String(b.segment).replace(/_/g, "-")}`) R.err("id", "default_id", `class default id must be "default-${String(b.powertrain).replace(/_/g, "-")}-${String(b.segment).replace(/_/g, "-")}"`);

        // ---- identity ----
        const idn = b.identity;
        if (!isObj(idn)) R.err("identity", "required", "identity object is required");
        else {
            for (const k of Object.keys(idn)) if (!IDENTITY_KEYS.includes(k)) R.err(`identity.${k}`, "unknown_key", `unknown identity key "${k}"`);
            for (const k of ["make", "model"]) if (typeof idn[k] !== "string" || !idn[k].trim() || idn[k].length > 60) R.err(`identity.${k}`, "required", `identity.${k} must be a non-empty string ≤ 60 chars`);
            if (idn.variant !== undefined && (typeof idn.variant !== "string" || idn.variant.length > 120)) R.err("identity.variant", "type", "identity.variant must be a string ≤ 120 chars");
            if (typeof idn.market !== "string" || !/^[A-Z]{2}$/.test(idn.market)) R.err("identity.market", "format", "identity.market must be an ISO 3166-1 alpha-2 code, e.g. \"IN\"");
            if (!Number.isInteger(idn.yearFrom) || idn.yearFrom < 1950 || idn.yearFrom > 2100) R.err("identity.yearFrom", "range", "identity.yearFrom must be an integer year 1950–2100");
            if (idn.yearTo !== null && (!Number.isInteger(idn.yearTo) || idn.yearTo < idn.yearFrom || idn.yearTo > 2100)) R.err("identity.yearTo", "range", "identity.yearTo must be null (on sale) or an integer ≥ yearFrom");
            if (!Array.isArray(idn.aliases) || idn.aliases.some((a) => typeof a !== "string" || !a.trim() || a.length > 60)) R.err("identity.aliases", "type", "identity.aliases must be an array of non-empty strings ≤ 60 chars");
            else if (new Set(idn.aliases.map((a) => a.toLowerCase())).size !== idn.aliases.length) R.warn("identity.aliases", "duplicate", "duplicate aliases (case-insensitive)");
        }

        // ---- sources ----
        /** @type {Map<string, any>} */
        const sources = new Map();
        if (!Array.isArray(b.sources) || b.sources.length === 0) R.err("sources", "required", "sources must be a non-empty array — every value needs provenance");
        else b.sources.forEach((s, i) => {
            const p = `sources[${i}]`;
            if (!isObj(s)) return R.err(p, "type", "source must be an object");
            for (const k of Object.keys(s)) if (!["id", "kind", "title", "url", "publisher", "retrieved", "note"].includes(k)) R.err(`${p}.${k}`, "unknown_key", `unknown source key "${k}"`);
            if (typeof s.id !== "string" || !SRC_ID_RE.test(s.id)) R.err(`${p}.id`, "format", "source id must be a lowercase slug ≤ 48 chars");
            else if (sources.has(s.id)) R.err(`${p}.id`, "duplicate", `duplicate source id "${s.id}"`);
            else sources.set(s.id, s);
            if (!SOURCE_KINDS.includes(s.kind)) R.err(`${p}.kind`, "enum", `source kind must be one of ${SOURCE_KINDS.join(", ")}`);
            if (typeof s.title !== "string" || s.title.trim().length < 3) R.err(`${p}.title`, "required", "source title is required");
            if (URL_REQUIRED_KINDS.includes(s.kind) && (typeof s.url !== "string" || !URL_RE.test(s.url))) R.err(`${p}.url`, "required", `a ${s.kind} source needs an http(s) url`);
            if (s.url !== undefined && (typeof s.url !== "string" || !URL_RE.test(s.url))) R.err(`${p}.url`, "format", "url must be http(s)");
            if (NOTE_REQUIRED_KINDS.includes(s.kind) && (typeof s.note !== "string" || s.note.trim().length < 10)) R.err(`${p}.note`, "required", `a ${s.kind} source must explain its method in "note"`);
            if (typeof s.retrieved !== "string" || !DATE_RE.test(s.retrieved) || isNaN(Date.parse(s.retrieved))) R.err(`${p}.retrieved`, "format", "retrieved must be a date, YYYY-MM-DD");
        });
        /** @type {Set<string>} */ const usedSources = new Set();

        // ---- generic value checks ----
        const checkProv = (path, node) => {
            if (typeof node.src !== "string" || !node.src) return R.err(`${path}.src`, "provenance", "missing src (source id)");
            usedSources.add(node.src);
            const s = sources.get(node.src);
            if (!s) R.err(`${path}.src`, "provenance", `src "${node.src}" is not in sources[]`);
            if (!isNum(node.conf) || node.conf < 0 || node.conf > 1) return R.err(`${path}.conf`, "confidence", "conf must be a number 0–1");
            if (s && CONF_CAP[s.kind] !== undefined && node.conf > CONF_CAP[s.kind] + 1e-9) R.err(`${path}.conf`, "overclaim", `conf ${node.conf} exceeds the cap ${CONF_CAP[s.kind]} for a ${s.kind} source`);
            if (node.note !== undefined && (typeof node.note !== "string" || node.note.length > 400)) R.err(`${path}.note`, "type", "note must be a string ≤ 400 chars");
        };

        // ---- image (optional): shown in the bike picker; https only (the app's pages are https) ----
        if (b.image !== undefined) {
            const im = b.image;
            if (!isObj(im)) R.err("image", "type", "image must be an object { url, src, credit?, note? }");
            else {
                for (const k of Object.keys(im)) if (!IMAGE_KEYS.includes(k)) R.err(`image.${k}`, "unknown_key", `unknown image key "${k}"`);
                if (typeof im.url !== "string" || !IMAGE_URL_RE.test(im.url) || im.url.length > 500) R.err("image.url", "format", "image.url must be an https:// URL ≤ 500 chars (an http image is blocked inside the app)");
                if (typeof im.src !== "string" || !sources.has(im.src)) R.err("image.src", "provenance", "image.src must name a source in sources[] (who published the picture)");
                else usedSources.add(im.src);
                if (im.credit !== undefined && (typeof im.credit !== "string" || !im.credit.trim() || im.credit.length > 200)) R.err("image.credit", "type", "image.credit must be a non-empty string ≤ 200 chars");
                if (im.note !== undefined && (typeof im.note !== "string" || im.note.length > 400)) R.err("image.note", "type", "image.note must be a string ≤ 400 chars");
            }
        }

        // ---- groups ----
        for (const g of GROUPS) {
            const node = b[g];
            if (node === undefined || node === null) continue;
            if (!isObj(node)) { R.err(g, "type", `${g} must be an object`); continue; }
            for (const k of Object.keys(node)) {
                const path = `${g}.${k}`;
                if (g === "fuel" && k === "compat") continue;
                if (!FIELD_BY_PATH[path]) R.err(path, "unknown_key", `unknown field "${path}"`);
            }
        }
        if (b.emission === null && pt && ICE.includes(pt)) R.err("emission", "required", "an ICE vehicle needs an emission block");

        for (const f of FIELDS) {
            const v = get(b, f.path);
            const requiredHere = pt && ((f.req && f.req.includes(pt)) || (isDefault && f.reqDefault && f.reqDefault.includes(pt)));
            if (v === undefined || v === null) {
                if (requiredHere) R.err(f.path, "required", `${f.path} is required for ${isDefault && !(f.req || []).includes(pt) ? "class default " : ""}${pt}`);
                continue;
            }
            if (pt && f.allow && !f.allow.includes(pt)) { R.err(f.path, "not_applicable", `${f.path} does not apply to ${pt}`); continue; }
            if (!isObj(v)) { R.err(f.path, "type", `${f.path} must be an object`); continue; }
            const allowedKeys = f.type === "p" ? ["mean", "sigma", "u", "src", "conf", "note"]
                : f.type === "c" ? ["v", "src", "conf", "note"]
                    : ["v", "u", "src", "conf", "tol", "note", ...Object.keys(f.extra || {})];
            for (const k of Object.keys(v)) if (!allowedKeys.includes(k)) R.err(`${f.path}.${k}`, "unknown_key", `unknown key "${k}" in ${f.path}`);
            checkProv(f.path, v);

            if (f.type === "q" || f.type === "qa" || f.type === "p") {
                if (v.u !== f.unit) R.err(`${f.path}.u`, "unit", `unit must be "${f.unit}" (got ${JSON.stringify(v.u)})`);
            }
            if (f.type === "q") {
                if (!isNum(v.v)) { R.err(`${f.path}.v`, "type", "v must be a finite number"); continue; }
                if (f.int && !Number.isInteger(v.v)) R.err(`${f.path}.v`, "integer", "v must be an integer");
                if (f.enumV && !f.enumV.includes(v.v)) R.err(`${f.path}.v`, "enum", `v must be one of ${f.enumV.join(", ")}`);
                if (f.range && (v.v < f.range[0] || v.v > f.range[1])) R.err(`${f.path}.v`, "impossible", `${v.v} ${f.unit} is outside the physically plausible range ${f.range[0]}–${f.range[1]}`);
                if (v.tol !== undefined && (!isNum(v.tol) || v.tol < 0 || v.tol >= Math.abs(v.v))) R.err(`${f.path}.tol`, "range", "tol must be ≥ 0 and smaller than v");
            } else if (f.type === "qa") {
                if (!Array.isArray(v.v) || v.v.some((x) => !isNum(x))) { R.err(`${f.path}.v`, "type", "v must be an array of finite numbers"); continue; }
                if (f.len && (v.v.length < f.len[0] || v.v.length > f.len[1])) R.err(`${f.path}.v`, "length", `expected ${f.len[0]}–${f.len[1]} values`);
                v.v.forEach((x, i) => { if (f.range && (x < f.range[0] || x > f.range[1])) R.err(`${f.path}.v[${i}]`, "impossible", `${x} is outside ${f.range[0]}–${f.range[1]}`); });
            } else if (f.type === "c") {
                if (f.enumV) { if (!f.enumV.includes(v.v)) R.err(`${f.path}.v`, "enum", `v must be one of ${f.enumV.map((x) => JSON.stringify(x)).join(", ")}`); }
                else if (f.pattern === "TYRE") { if (!parseTyre(v.v)) R.err(`${f.path}.v`, "format", `"${v.v}" is not a recognised tyre size (e.g. 120/80-18 or 2.75-18)`); }
                else if (f.pattern && (typeof v.v !== "string" || !new RegExp(f.pattern).test(v.v))) R.err(`${f.path}.v`, "format", `v must match ${f.pattern}`);
            } else if (f.type === "p") {
                if (!isNum(v.mean) || !isNum(v.sigma)) { R.err(f.path, "type", "a prior needs numeric mean and sigma"); continue; }
                if (f.range && (v.mean < f.range[0] || v.mean > f.range[1])) R.err(`${f.path}.mean`, "impossible", `${v.mean} ${f.unit} is outside ${f.range[0]}–${f.range[1]}`);
                if (!(v.sigma > 0)) R.err(`${f.path}.sigma`, "range", "sigma must be > 0 — a prior with no uncertainty is a claim of exactness");
                else if (v.mean !== 0 && v.sigma >= Math.abs(v.mean)) R.err(`${f.path}.sigma`, "range", "sigma must be smaller than |mean|");
            }
            for (const [ek, evals] of Object.entries(f.extra || {})) {
                if (v[ek] === undefined) R.err(`${f.path}.${ek}`, "required", `${f.path} needs "${ek}" (one of ${evals.join(", ")})`);
                else if (!evals.includes(v[ek])) R.err(`${f.path}.${ek}`, "enum", `${ek} must be one of ${evals.join(", ")}`);
            }
        }

        // ---- powertrain consistency ----
        if (pt) {
            const tk = get(b, "transmission.kind.v");
            if (tk && tk !== TRANSMISSION_FOR[pt]) R.err("transmission.kind", "powertrain", `${pt} needs transmission.kind "${TRANSMISSION_FOR[pt]}" (got "${tk}")`);
            if (ICE.includes(pt)) {
                if (b.motor !== undefined) R.err("motor", "not_applicable", "motor applies to ev only");
                if (b.battery !== undefined) R.err("battery", "not_applicable", "battery applies to ev only");
            } else {
                for (const g of ["engine", "emission", "fuel"]) if (b[g] !== undefined && b[g] !== null) R.err(g, "not_applicable", `${g} does not apply to an electric vehicle`);
            }
        }

        // ---- physics / consistency ----
        physicsChecks(b, pt, R);
        fuelChecks(b, pt, sources, usedSources, ref, R);
        emissionChecks(b, pt, ref, R);
        curveChecks(b, pt, R, checkProv);

        // ---- notes ----
        if (b.notes !== undefined && (!Array.isArray(b.notes) || b.notes.some((n) => typeof n !== "string" || n.length > 1000))) R.err("notes", "type", "notes must be an array of strings ≤ 1000 chars");

        for (const id of sources.keys()) if (!usedSources.has(id)) R.warn(`sources`, "unused_source", `source "${id}" is not referenced by any value`);
        return done(R);
    }

    function done(R) { return { ok: R.errors.length === 0, errors: R.errors, warnings: R.warnings }; }

    /** Cross-field physical checks. */
    function physicsChecks(b, pt, R) {
        const n = (p) => { const x = get(b, p); return x && isNum(x.v) ? x.v : null; };
        if (pt && ICE.includes(pt)) {
            const cc = n("engine.displacement"), bore = n("engine.bore"), stroke = n("engine.stroke"), cyl = n("engine.cylinders");
            if (cc && bore && stroke && cyl) {
                const calc = sweptVolumeCm3(bore, stroke, cyl);
                const dev = Math.abs(calc - cc) / cc;
                if (dev > 0.02) R.err("engine.displacement", "inconsistent", `bore × stroke × cylinders gives ${calc.toFixed(1)} cm3, ${(dev * 100).toFixed(1)} % off the stated ${cc} cm3 — a typo in one of them`);
            }
            const P = n("engine.peakPower"), Pr = n("engine.peakPowerRpm"), T = n("engine.peakTorque"), Tr = n("engine.peakTorqueRpm");
            if (P && Pr && T && Tr) {
                // Power at the peak-torque rpm can't exceed peak power, and peak power implies at least P/ω torque.
                const pAtT = (T * omega(Tr)) / 1000;
                if (pAtT > P * 1.03) R.err("engine.peakTorque", "impossible", `${T} N*m at ${Tr} rpm is ${pAtT.toFixed(2)} kW — more than the stated peak power ${P} kW`);
                const tAtP = (P * 1000) / omega(Pr);
                if (tAtP > T * 1.03) R.err("engine.peakPower", "impossible", `${P} kW at ${Pr} rpm needs ${tAtP.toFixed(2)} N*m — more than the stated peak torque ${T} N*m`);
            }
            if (P && cc) {
                const kwPerL = P / (cc / 1000);
                if (kwPerL < 5 || kwPerL > 300) R.err("engine.peakPower", "impossible", `${kwPerL.toFixed(0)} kW per litre is not physically plausible for a road engine`);
            }
            const idle = n("engine.idleRpm"), red = n("engine.redlineRpm"), lim = n("engine.limiterRpm");
            if (idle && Tr && idle >= Tr) R.err("engine.idleRpm", "impossible", `idle ${idle} rpm must be below peak-torque rpm ${Tr}`);
            if (idle && Pr && idle >= Pr) R.err("engine.idleRpm", "impossible", `idle ${idle} rpm must be below peak-power rpm ${Pr}`);
            if (red && idle && red <= idle) R.err("engine.redlineRpm", "impossible", `redline ${red} rpm must be above idle ${idle} rpm`);
            if (red && Tr && red < Tr) R.err("engine.redlineRpm", "impossible", `redline ${red} rpm is below peak-torque rpm ${Tr}`);
            if (red && Pr && red < Pr * 0.95) R.err("engine.redlineRpm", "impossible", `redline ${red} rpm is well below peak-power rpm ${Pr}`);
            if (lim && red && lim < red) R.err("engine.limiterRpm", "impossible", `limiter ${lim} rpm is below redline ${red} rpm`);
            if (lim && idle && lim <= idle) R.err("engine.limiterRpm", "impossible", "limiter must be above idle");
        }
        // Gearbox
        const speeds = n("transmission.speeds");
        const gr = get(b, "transmission.gearRatios");
        if (gr && Array.isArray(gr.v)) {
            if (speeds && gr.v.length !== speeds) R.err("transmission.gearRatios", "inconsistent", `${gr.v.length} ratios for a ${speeds}-speed gearbox`);
            for (let i = 1; i < gr.v.length; i++) if (!(gr.v[i] < gr.v[i - 1])) { R.err(`transmission.gearRatios.v[${i}]`, "impossible", "gear ratios must strictly decrease from 1st to top gear"); break; }
        }
        const fr = n("transmission.frontSprocket"), rr = n("transmission.rearSprocket"), fin = n("transmission.finalRatio");
        if ((fr === null) !== (rr === null)) R.err("transmission", "inconsistent", "give both front and rear sprocket teeth, or neither");
        if (fr && rr && fin && Math.abs(rr / fr - fin) / fin > 0.01) R.err("transmission.finalRatio", "inconsistent", `rear/front sprockets ${rr}/${fr} = ${(rr / fr).toFixed(3)} ≠ finalRatio ${fin}`);
        if (pt === "ice_manual" && fin && (fin < 1.5 || fin > 6)) R.err("transmission.finalRatio", "impossible", `a chain/belt final drive of ${fin} is implausible (1.5–6)`);
        if (pt === "ice_cvt" && fin && fin < 5) R.err("transmission.finalRatio", "impossible", `a scooter final reduction of ${fin} is implausible (expected ≥ 5)`);
        const cmax = n("transmission.cvtRatioMax"), cmin = n("transmission.cvtRatioMin");
        if (cmax && cmin && cmin >= cmax) R.err("transmission.cvtRatioMin", "impossible", "CVT minimum ratio must be below its maximum");
        // Top-speed cross-check (warning only — published top speeds are often rounded or mode-dependent)
        const top = n("chassis.topSpeed"), tyre = parseTyre(get(b, "chassis.rearTyre.v"));
        if (top && tyre && pt && ICE.includes(pt)) {
            const prim = pt === "ice_manual" ? n("transmission.primaryRatio") : 1;
            const topRatio = pt === "ice_manual" ? (gr && Array.isArray(gr.v) ? gr.v[gr.v.length - 1] : null) : cmin;
            const Pr = n("engine.peakPowerRpm");
            if (prim && topRatio && fin && Pr) {
                const wheelRpm = (top / 3.6) / (Math.PI * tyre.diameterM * 0.97) * 60;   // 3 % rolling-radius loss under load
                const engRpm = wheelRpm * prim * topRatio * fin;
                const lim = n("engine.limiterRpm");
                if (engRpm < Pr * 0.6 || engRpm > Pr * 1.35 || (lim && engRpm > lim * 1.05)) R.warn("chassis.topSpeed", "inconsistent", `${top} km/h in top gear means ${engRpm.toFixed(0)} rpm against peak power at ${Pr} rpm — check the ratios, tyre or top speed`);
            }
        }
        // Tyres
        for (const p of ["chassis.frontTyre", "chassis.rearTyre"]) {
            const t = parseTyre(get(b, `${p}.v`));
            if (t && (t.diameterM < 0.35 || t.diameterM > 0.85)) R.err(p, "impossible", `tyre diameter ${t.diameterM.toFixed(3)} m is implausible for a two-wheeler`);
        }
        // Mass
        const mass = get(b, "chassis.mass");
        if (mass && mass.basis === "dry") R.warn("chassis.mass", "dry_mass", "dry mass: the physics adds fluids and fuel — prefer a kerb figure when one is published");
        if (mass && mass.basis === "unspecified") R.warn("chassis.mass", "mass_basis", "mass basis unspecified (kerb vs dry)");
        // EV
        if (pt === "ev") {
            const gross = n("battery.grossCapacity"), usable = n("battery.usableCapacity");
            if (gross && usable && usable > gross) R.err("battery.usableCapacity", "impossible", "usable capacity can't exceed installed capacity");
            const pk = n("motor.peakPower"), rated = n("motor.ratedPower");
            if (pk && rated && rated > pk) R.err("motor.ratedPower", "impossible", "rated power can't exceed peak power");
            const drive = get(b, "transmission.drive.v"), red = n("transmission.reductionRatio"), mount = get(b, "motor.mount.v");
            if (drive === "hub_direct" && red && red !== 1) R.err("transmission.reductionRatio", "inconsistent", "a direct hub motor has a reduction ratio of 1");
            if (mount === "hub" && drive && !["hub_direct", "gear"].includes(drive)) R.err("transmission.drive", "inconsistent", `a hub motor can't have a ${drive} drive`);
        }
    }

    /** Fuel compatibility matrix rules. */
    function fuelChecks(b, pt, sources, usedSources, ref, R) {
        const compat = get(b, "fuel.compat");
        if (!pt || !ICE.includes(pt)) {
            if (compat !== undefined) R.err("fuel.compat", "not_applicable", "an electric vehicle has no fuel compatibility");
            return;
        }
        if (!Array.isArray(compat)) { R.err("fuel.compat", "required", "an ICE vehicle needs fuel.compat (the manufacturer's fuel approvals)"); return; }
        const grades = ref.fuelGrades && Array.isArray(ref.fuelGrades.grades) ? new Map(ref.fuelGrades.grades.map((g) => [g.code, g])) : null;
        const seen = new Set();
        let usable = 0;
        let maxCertifiedEthanol = -1;
        compat.forEach((c, i) => {
            const p = `fuel.compat[${i}]`;
            if (!isObj(c)) return R.err(p, "type", "entry must be an object");
            for (const k of Object.keys(c)) if (!["fuel", "status", "src", "conf", "note"].includes(k)) R.err(`${p}.${k}`, "unknown_key", `unknown key "${k}"`);
            if (typeof c.fuel !== "string") return R.err(`${p}.fuel`, "required", "fuel code required");
            if (seen.has(c.fuel)) R.err(`${p}.fuel`, "duplicate", `${c.fuel} listed twice`);
            seen.add(c.fuel);
            if (grades && !grades.has(c.fuel)) R.err(`${p}.fuel`, "unknown_fuel", `fuel "${c.fuel}" is not in fuel-grades.json`);
            if (!FUEL_STATUS.includes(c.status)) R.err(`${p}.status`, "enum", `status must be one of ${FUEL_STATUS.join(", ")}`);
            // provenance
            if (typeof c.src !== "string" || !sources.has(c.src)) R.err(`${p}.src`, "provenance", "fuel approval needs a src that is in sources[]");
            else usedSources.add(c.src);
            if (!isNum(c.conf) || c.conf < 0 || c.conf > 1) R.err(`${p}.conf`, "confidence", "conf must be 0–1");
            const s = sources.get(c.src);
            if (s && CONF_CAP[s.kind] !== undefined && isNum(c.conf) && c.conf > CONF_CAP[s.kind] + 1e-9) R.err(`${p}.conf`, "overclaim", `conf exceeds the cap ${CONF_CAP[s.kind]} for a ${s.kind} source`);
            const g = grades && grades.get(c.fuel);
            if (c.status === "certified" || c.status === "compatible") {
                usable++;
                if (s && (s.kind === "estimated" || s.kind === "class_prior") && b.kind !== "class_default") R.err(`${p}.src`, "fuel_safety", "a fuel approval on a real vehicle can't rest on an estimate");
                if (g && g.flexFuelBlend && !(get(b, "engine.flexFuel.v") === true)) R.err(`${p}.status`, "fuel_safety", `${c.fuel} is a flex-fuel blend; it can only be approved for an engine certified as flex-fuel (engine.flexFuel = true)`);
                if (c.status === "certified" && g) maxCertifiedEthanol = Math.max(maxCertifiedEthanol, g.ethanolVolFraction);
            }
        });
        if (usable === 0) R.err("fuel.compat", "no_fuel", "this vehicle needs fuel but is approved for no fuel at all — at least one entry must be certified or compatible");
        if (b.kind === "class_default") {
            // A class can't hold a maker's certification: the app must tell the rider to check the manual.
            compat.forEach((c, i) => { if (isObj(c) && c.status === "certified") R.err(`fuel.compat[${i}].status`, "fuel_safety", "a class default can't be \"certified\" for a fuel — no manufacturer has certified an unknown bike; use \"compatible\" at class-prior confidence"); });
        } else if (usable > 0) {
            const certified = compat.filter((c) => isObj(c) && c.status === "certified" && isNum(c.conf) && c.conf >= CERT_MIN_CONF - 1e-9 &&
                sources.has(c.src) && AUTHORITATIVE_KINDS.includes(sources.get(c.src).kind));
            if (certified.length === 0) R.err("fuel.compat", "no_certified_fuel", `no manufacturer certification for any fuel: at least one entry must be "certified" by a ${AUTHORITATIVE_KINDS.join("/")} source at conf ≥ ${CERT_MIN_CONF}. Press reports, aggregators, foreign-market manuals at low confidence and "compatible" entries don't count — keep the bundle in data/bikes/pending/ until one is sourced`);
            else if (grades && !compat.some((c) => isObj(c) && isFuelAdvisable(b, c.fuel, ref))) R.warn("fuel.compat", "no_advisable_fuel", `no fuel reaches the advice threshold (authoritative source, conf ≥ ${ADVISE_MIN_CONF}): the app will show "check your owner's manual" instead of a fuel recommendation`);
        }
        // A "compatible" blend inferred (derived) from a certification may only go DOWN in ethanol, never up.
        if (grades) compat.forEach((c, i) => {
            if (!isObj(c) || c.status !== "compatible") return;
            const s = sources.get(c.src), g = grades.get(c.fuel);
            if (s && s.kind === "derived" && g && g.ethanolVolFraction > maxCertifiedEthanol) R.err(`fuel.compat[${i}]`, "fuel_safety", `${c.fuel} can't be derived as compatible: it has more ethanol than any certified blend`);
        });
    }

    function emissionChecks(b, pt, ref, R) {
        if (!pt || !ICE.includes(pt) || !ref.emissionStandards) return;
        const std = get(b, "emission.standard.v"), obd = get(b, "emission.obd.v");
        const table = ref.emissionStandards;
        const s = (table.standards || []).find((x) => x.code === std);
        if (std && !s) R.err("emission.standard", "unknown_standard", `"${std}" is not in emission-standards.json`);
        if (obd && !(table.obdLevels || []).some((x) => x.code === obd)) R.err("emission.obd", "unknown_obd", `"${obd}" is not in emission-standards.json`);
        if (s && /** @type {any} */ (s).supersededFrom && b.identity && b.identity.yearTo === null) {
            const until = Number(String(/** @type {any} */ (s).supersededFrom).slice(0, 4));
            if (until && until <= new Date().getUTCFullYear()) R.warn("emission.standard", "superseded", `${std} was superseded in ${until}, but the vehicle is marked as still on sale`);
        }
    }

    /** Quantised curves: Int16 values × scale on a regular rpm grid. */
    function curveChecks(b, pt, R, checkProv) {
        const curves = b.curves;
        if (curves === undefined) return;
        if (!isObj(curves)) return R.err("curves", "type", "curves must be an object");
        for (const [k, c] of Object.entries(curves)) {
            const p = `curves.${k}`;
            if (!CURVE_KINDS.includes(k)) { R.err(p, "unknown_key", `curve kind must be one of ${CURVE_KINDS.join(", ")}`); continue; }
            if (!isObj(c)) { R.err(p, "type", "curve must be an object"); continue; }
            for (const kk of Object.keys(c)) if (!["rpmStart", "rpmStep", "scale", "u", "data", "method", "src", "conf", "note"].includes(kk)) R.err(`${p}.${kk}`, "unknown_key", `unknown key "${kk}"`);
            checkProv(p, c);
            const unit = k === "torque" ? "N*m" : "kW";
            if (c.u !== unit) R.err(`${p}.u`, "unit", `unit must be "${unit}"`);
            if (!["manufacturer", "digitized_dyno", "measured", "synthesized"].includes(c.method)) R.err(`${p}.method`, "enum", "method must be manufacturer, digitized_dyno, measured or synthesized");
            if (!Number.isInteger(c.rpmStart) || c.rpmStart < 0 || c.rpmStart > 15000) R.err(`${p}.rpmStart`, "range", "rpmStart must be an integer 0–15000");
            if (!Number.isInteger(c.rpmStep) || c.rpmStep < 50 || c.rpmStep > 2000) R.err(`${p}.rpmStep`, "range", "rpmStep must be an integer 50–2000");
            if (!isNum(c.scale) || c.scale <= 0) R.err(`${p}.scale`, "range", "scale must be > 0");
            if (!Array.isArray(c.data) || c.data.length < 4 || c.data.length > 64 || c.data.some((x) => !Number.isInteger(x) || x < -32768 || x > 32767)) { R.err(`${p}.data`, "type", "data must be 4–64 Int16 integers"); continue; }
            if (!isNum(c.scale)) continue;
            const vals = c.data.map((x) => x * c.scale);
            if (vals.some((x) => x < 0)) R.err(`${p}.data`, "impossible", `negative ${k}`);
            const peakDecl = get(b, k === "torque" ? (pt === "ev" ? "motor.peakTorque.v" : "engine.peakTorque.v") : (pt === "ev" ? "motor.peakPower.v" : "engine.peakPower.v"));
            const peak = Math.max(...vals);
            if (isNum(peakDecl) && Math.abs(peak - peakDecl) / peakDecl > 0.05) R.err(`${p}.data`, "inconsistent", `curve peak ${peak.toFixed(2)} ${unit} is more than 5 % off the stated peak ${peakDecl} ${unit}`);
            const rpmEnd = c.rpmStart + c.rpmStep * (c.data.length - 1);
            const peakRpm = get(b, k === "torque" ? "engine.peakTorqueRpm.v" : "engine.peakPowerRpm.v");
            if (isNum(peakRpm) && (peakRpm < c.rpmStart || peakRpm > rpmEnd)) R.err(p, "inconsistent", `curve (${c.rpmStart}–${rpmEnd} rpm) doesn't cover the peak at ${peakRpm} rpm`);
        }
    }

    // ------------------------------------------------------------------
    // Reference tables
    // ------------------------------------------------------------------
    /** @param {any} t */
    function validateFuelGrades(t) {
        const R = makeReporter();
        if (!isObj(t) || !Array.isArray(t.grades)) { R.err("", "type", "fuel-grades.json must have a grades array"); return done(R); }
        const srcIds = new Set((t.sources || []).map((s) => s.id));
        const codes = new Set();
        t.grades.forEach((g, i) => {
            const p = `grades[${i}]`;
            if (!/^E\d{1,3}$/.test(g.code)) R.err(`${p}.code`, "format", "code must look like E0, E10, E20, E85, E100");
            if (codes.has(g.code)) R.err(`${p}.code`, "duplicate", `duplicate ${g.code}`);
            codes.add(g.code);
            if (!isNum(g.ethanolVolFraction) || g.ethanolVolFraction < 0 || g.ethanolVolFraction > 1) R.err(`${p}.ethanolVolFraction`, "range", "0–1");
            else if (Number(g.code.slice(1)) / 100 !== g.ethanolVolFraction) R.err(`${p}.ethanolVolFraction`, "inconsistent", `${g.code} must have ethanolVolFraction ${Number(g.code.slice(1)) / 100}`);
            if (typeof g.flexFuelBlend !== "boolean") R.err(`${p}.flexFuelBlend`, "required", "flexFuelBlend must be true/false");
            else if (g.flexFuelBlend !== (g.ethanolVolFraction >= 0.5)) R.err(`${p}.flexFuelBlend`, "inconsistent", "flexFuelBlend must be true exactly when ethanol ≥ 50 %");
            for (const [k, unit, lo, hi] of [["lhv", "MJ/L", 18, 36], ["density", "kg/L", 0.68, 0.82], ["typicalRon", "RON", 80, 115]]) {
                const q = g[k];
                if (q === undefined && k === "typicalRon") continue;
                if (!isObj(q)) { R.err(`${p}.${k}`, "required", `${k} is required`); continue; }
                if (q.u !== unit) R.err(`${p}.${k}.u`, "unit", `unit must be "${unit}"`);
                if (!isNum(q.v) || q.v < lo || q.v > hi) R.err(`${p}.${k}.v`, "range", `${lo}–${hi}`);
                if (!srcIds.has(q.src)) R.err(`${p}.${k}.src`, "provenance", "src must be in sources[]");
                if (!isNum(q.conf) || q.conf < 0 || q.conf > 1) R.err(`${p}.${k}.conf`, "confidence", "conf 0–1");
            }
        });
        // Energy content must fall monotonically with ethanol (ethanol carries ~1/3 less energy per litre).
        const sorted = t.grades.filter((g) => isObj(g.lhv) && isNum(g.lhv.v)).sort((a, b2) => a.ethanolVolFraction - b2.ethanolVolFraction);
        for (let i = 1; i < sorted.length; i++) if (!(sorted[i].lhv.v < sorted[i - 1].lhv.v)) R.err("grades", "impossible", `LHV must fall as ethanol rises (${sorted[i - 1].code} → ${sorted[i].code})`);
        return done(R);
    }

    /** @param {any} t */
    function validateEmissionStandards(t) {
        const R = makeReporter();
        if (!isObj(t) || !Array.isArray(t.standards) || !Array.isArray(t.obdLevels)) { R.err("", "type", "emission-standards.json needs standards[] and obdLevels[]"); return done(R); }
        const srcIds = new Set((t.sources || []).map((s) => s.id));
        for (const [list, name] of [[t.standards, "standards"], [t.obdLevels, "obdLevels"]]) {
            const codes = new Set();
            list.forEach((s, i) => {
                const p = `${name}[${i}]`;
                if (typeof s.code !== "string" || !s.code) R.err(`${p}.code`, "required", "code required");
                if (codes.has(s.code)) R.err(`${p}.code`, "duplicate", `duplicate ${s.code}`);
                codes.add(s.code);
                if (!DATE_RE.test(s.effectiveFrom || "")) R.err(`${p}.effectiveFrom`, "format", "effectiveFrom must be YYYY-MM-DD");
                if (s.supersededFrom !== undefined && s.supersededFrom !== null && !(DATE_RE.test(s.supersededFrom) && s.supersededFrom > s.effectiveFrom)) R.err(`${p}.supersededFrom`, "range", "supersededFrom must be a date after effectiveFrom");
                if (!srcIds.has(s.src)) R.err(`${p}.src`, "provenance", "src must be in sources[]");
                if (!isNum(s.conf) || s.conf < 0 || s.conf > 1) R.err(`${p}.conf`, "confidence", "conf 0–1");
            });
        }
        return done(R);
    }

    // ------------------------------------------------------------------
    // Catalog-level checks
    // ------------------------------------------------------------------
    /**
     * @param {Array<{ file?: string, bundle: any }>} entries
     * @param {RefTables} ref
     * @returns {{ ok: boolean, errors: Issue[], warnings: Issue[], perFile: Array<{ file: string, result: Result }> }}
     */
    function validateCatalog(entries, ref) {
        const R = makeReporter();
        const perFile = [];
        if (ref.fuelGrades) { const r = validateFuelGrades(ref.fuelGrades); r.errors.forEach((e) => R.err(`fuel-grades:${e.path}`, e.code, e.message)); }
        if (ref.emissionStandards) { const r = validateEmissionStandards(ref.emissionStandards); r.errors.forEach((e) => R.err(`emission-standards:${e.path}`, e.code, e.message)); }
        const ids = new Map();
        const defaults = new Map();
        const aliasOwner = new Map();
        for (const e of entries) {
            const file = e.file || (e.bundle && e.bundle.id) || "?";
            const result = validateBundle(e.bundle, ref);
            perFile.push({ file, result });
            const b = e.bundle;
            if (!isObj(b)) continue;
            if (ids.has(b.id)) R.err(file, "duplicate_id", `id "${b.id}" is also used by ${ids.get(b.id)}`);
            ids.set(b.id, file);
            if (e.file && typeof b.id === "string" && !e.file.replace(/\\/g, "/").endsWith(`/${b.id}.json`) && e.file !== `${b.id}.json`) R.err(file, "file_name", `file must be named ${b.id}.json`);
            if (b.kind === "class_default") {
                if (defaults.has(b.classKey)) R.err(file, "duplicate_default", `second class default for ${b.classKey}`);
                defaults.set(b.classKey, b);
            }
            if (b.kind === "variant" && b.identity && Array.isArray(b.identity.aliases)) {
                // Variants of the same make + model (e.g. two battery sizes) are meant to share names;
                // only a clash across DIFFERENT models is worth a warning.
                const model = `${b.identity.make} ${b.identity.model}`.toLowerCase().replace(/\s+/g, " ").trim();
                for (const a of [`${b.identity.make} ${b.identity.model}`, ...b.identity.aliases]) {
                    const key = String(a).toLowerCase().replace(/\s+/g, " ").trim();
                    const owner = aliasOwner.get(key);
                    if (owner && owner.model !== model) R.warn(file, "alias_clash", `alias "${a}" also matches ${owner.id} — search will show both`);
                    else if (!owner) aliasOwner.set(key, { id: b.id, model });
                }
            }
        }
        // Every valid class has exactly one default — so a search can always fall back.
        for (const [pt, segs] of Object.entries(CLASS_MATRIX)) for (const s of segs) if (!defaults.has(`${pt}.${s}`)) R.err("catalog", "missing_default", `no class default for ${pt}.${s}`);
        // Every variant's priors resolve completely through its class default.
        for (const e of entries) {
            const b = e.bundle;
            if (!isObj(b) || b.kind !== "variant") continue;
            const d = defaults.get(b.classKey);
            if (!d) { R.err(e.file || b.id, "no_class", `classKey ${b.classKey} has no class default`); continue; }
            const pri = resolvePriors(b, d);
            for (const f of FIELDS) if (f.path.startsWith("priors.") && f.allow && f.allow.includes(b.powertrain) && !pri[f.path.slice(7)]) R.err(e.file || b.id, "priors_unresolved", `${f.path} resolves neither from the variant nor from ${d.id}`);
        }
        const ok = R.errors.length === 0 && perFile.every((p) => p.result.ok);
        return { ok, errors: R.errors, warnings: R.warnings, perFile };
    }

    // ------------------------------------------------------------------
    // Runtime helpers used by the app
    // ------------------------------------------------------------------
    /** Variant priors override the class default's, field by field. */
    function resolvePriors(variant, classDefault) {
        return Object.assign({}, (classDefault && classDefault.priors) || {}, (variant && variant.priors) || {});
    }

    /**
     * May the app advise this fuel for this vehicle? Only with an approval from an
     * authoritative source (manufacturer, manual, homologation, licensed data) at
     * confidence ≥ minConf, and never a flex-fuel blend unless the engine is certified flex-fuel.
     * Everything else — aggregator-only, press-only, derived, unknown — is shown as
     * "not confirmed by the manufacturer" and never recommended.
     * @param {any} bundle
     * @param {string} fuelCode
     * @param {RefTables} ref
     * @param {number} [minConf]
     */
    function isFuelAdvisable(bundle, fuelCode, ref, minConf = ADVISE_MIN_CONF) {
        if (!isObj(bundle) || !ICE.includes(bundle.powertrain)) return false;
        const entry = (get(bundle, "fuel.compat") || []).find((c) => c && c.fuel === fuelCode);
        if (!entry || (entry.status !== "certified" && entry.status !== "compatible")) return false;
        if (!isNum(entry.conf) || entry.conf < minConf) return false;
        const src = (bundle.sources || []).find((s) => s.id === entry.src);
        if (!src || !AUTHORITATIVE_KINDS.includes(src.kind)) return false;
        const g = ref && ref.fuelGrades && (ref.fuelGrades.grades || []).find((x) => x.code === fuelCode);
        if (!g) return false;
        if (g.flexFuelBlend && get(bundle, "engine.flexFuel.v") !== true) return false;
        return true;
    }

    // ------------------------------------------------------------------
    // JSON Schema (draft 2020-12) generated from FIELDS
    // ------------------------------------------------------------------
    function buildJsonSchema() {
        const prov = { src: { type: "string", pattern: SRC_ID_RE.source }, conf: { type: "number", minimum: 0, maximum: 1 }, note: { type: "string", maxLength: 400 } };
        const fieldSchema = (f) => {
            if (f.type === "p") return { type: "object", additionalProperties: false, required: ["mean", "sigma", "u", "src", "conf"], description: f.doc, properties: { mean: { type: "number", minimum: f.range[0], maximum: f.range[1] }, sigma: { type: "number", exclusiveMinimum: 0 }, u: { const: f.unit }, ...prov } };
            if (f.type === "c") {
                const v = f.enumV ? { enum: f.enumV } : f.pattern === "TYRE" ? { type: "string", minLength: 4, maxLength: 40 } : { type: "string", pattern: f.pattern };
                return { type: "object", additionalProperties: false, required: ["v", "src", "conf"], description: f.doc, properties: { v, ...prov } };
            }
            const num = { type: f.int ? "integer" : "number" };
            if (f.range) Object.assign(num, { minimum: f.range[0], maximum: f.range[1] });
            if (f.enumV) Object.assign(num, { enum: f.enumV });
            const v = f.type === "qa" ? { type: "array", items: num, minItems: f.len[0], maxItems: f.len[1] } : num;
            const extra = Object.fromEntries(Object.entries(f.extra || {}).map(([k, vals]) => [k, { enum: vals }]));
            return { type: "object", additionalProperties: false, required: ["v", "u", "src", "conf", ...Object.keys(f.extra || {})], description: f.doc, properties: { v, u: { const: f.unit }, tol: { type: "number", minimum: 0 }, ...extra, ...prov } };
        };
        const group = (g) => {
            const fs = FIELDS.filter((f) => f.path.startsWith(`${g}.`));
            /** @type {Record<string, any>} */
            const props = Object.fromEntries(fs.map((f) => [f.path.slice(g.length + 1), fieldSchema(f)]));
            if (g === "fuel") props.compat = { type: "array", items: { $ref: "#/$defs/fuelCompat" } };
            return { type: "object", additionalProperties: false, properties: props };
        };
        const reqFor = (g, pt, isDefault) => FIELDS.filter((f) => f.path.startsWith(`${g}.`) && ((f.req || []).includes(pt) || (isDefault && (f.reqDefault || []).includes(pt)))).map((f) => f.path.slice(g.length + 1));
        const conditional = [];
        for (const pt of POWERTRAINS) for (const isDefault of [false, true]) {
            const then = { required: [], properties: {} };
            for (const g of GROUPS) {
                const r = reqFor(g, pt, isDefault);
                if (g === "fuel" && ICE.includes(pt)) r.push("compat");
                if (r.length) { then.required.push(g); then.properties[g] = { required: r }; }
            }
            const allowedGroups = ICE.includes(pt) ? ["motor", "battery"] : ["engine", "emission", "fuel"];
            for (const g of allowedGroups) then.properties[g] = false;
            conditional.push({ if: { properties: { powertrain: { const: pt }, kind: { const: isDefault ? "class_default" : "variant" } }, required: ["powertrain", "kind"] }, then });
        }
        return {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            $id: "https://mapunite.app/schemas/bike-bundle/1.json",
            title: "MapUnite bike profile bundle",
            description: `Schema ${SCHEMA_VERSION}. GENERATED from public/js/bikedb/bundle-contract.js by scripts/bikedb/gen-schema.mjs — do not edit by hand. Structural checks only; physics, provenance and fuel-safety rules live in validateBundle().`,
            type: "object",
            additionalProperties: false,
            required: ["schemaVersion", "id", "kind", "classKey", "segment", "powertrain", "identity", "sources", "transmission", "chassis"],
            properties: {
                $schema: { type: "string" },
                schemaVersion: { type: "string", pattern: `^${SUPPORTED_MAJOR}\\.\\d+\\.\\d+$` },
                id: { type: "string", pattern: ID_RE.source, maxLength: 80 },
                kind: { enum: ["variant", "class_default"] },
                classKey: { type: "string", pattern: "^[a-z_]+\\.[a-z_]+$" },
                segment: { enum: SEGMENTS },
                powertrain: { enum: POWERTRAINS },
                identity: {
                    type: "object", additionalProperties: false, required: ["make", "model", "market", "yearFrom", "yearTo", "aliases"],
                    properties: {
                        make: { type: "string", minLength: 1, maxLength: 60 }, model: { type: "string", minLength: 1, maxLength: 60 }, variant: { type: "string", maxLength: 120 },
                        market: { type: "string", pattern: "^[A-Z]{2}$" }, yearFrom: { type: "integer", minimum: 1950, maximum: 2100 }, yearTo: { type: ["integer", "null"], minimum: 1950, maximum: 2100 },
                        aliases: { type: "array", items: { type: "string", minLength: 1, maxLength: 60 } }
                    }
                },
                image: {
                    type: "object", additionalProperties: false, required: ["url", "src"], description: "Picture for the bike picker (https only), with its source",
                    properties: { url: { type: "string", pattern: "^https://", maxLength: 500 }, src: { type: "string", pattern: SRC_ID_RE.source }, credit: { type: "string", minLength: 1, maxLength: 200 }, note: { type: "string", maxLength: 400 } }
                },
                sources: { type: "array", minItems: 1, items: { $ref: "#/$defs/source" } },
                engine: group("engine"), motor: group("motor"), battery: group("battery"), transmission: group("transmission"), chassis: group("chassis"),
                emission: { oneOf: [{ type: "null" }, group("emission")] }, fuel: group("fuel"), priors: group("priors"),
                curves: { type: "object", additionalProperties: false, properties: Object.fromEntries(CURVE_KINDS.map((k) => [k, { $ref: "#/$defs/curve" }])) },
                notes: { type: "array", items: { type: "string", maxLength: 1000 } }
            },
            allOf: conditional,
            $defs: {
                source: {
                    type: "object", additionalProperties: false, required: ["id", "kind", "title", "retrieved"],
                    properties: { id: { type: "string", pattern: SRC_ID_RE.source }, kind: { enum: SOURCE_KINDS }, title: { type: "string", minLength: 3 }, url: { type: "string", pattern: "^https?://" }, publisher: { type: "string" }, retrieved: { type: "string", pattern: DATE_RE.source }, note: { type: "string" } },
                    allOf: [
                        { if: { properties: { kind: { enum: URL_REQUIRED_KINDS } } }, then: { required: ["url"] } },
                        { if: { properties: { kind: { enum: NOTE_REQUIRED_KINDS } } }, then: { required: ["note"] } }
                    ]
                },
                fuelCompat: { type: "object", additionalProperties: false, required: ["fuel", "status", "src", "conf"], properties: { fuel: { type: "string", pattern: "^E\\d{1,3}$" }, status: { enum: FUEL_STATUS }, ...prov } },
                curve: {
                    type: "object", additionalProperties: false, required: ["rpmStart", "rpmStep", "scale", "u", "data", "method", "src", "conf"],
                    properties: { rpmStart: { type: "integer", minimum: 0, maximum: 15000 }, rpmStep: { type: "integer", minimum: 50, maximum: 2000 }, scale: { type: "number", exclusiveMinimum: 0 }, u: { enum: ["N*m", "kW"] }, data: { type: "array", minItems: 4, maxItems: 64, items: { type: "integer", minimum: -32768, maximum: 32767 } }, method: { enum: ["manufacturer", "digitized_dyno", "measured", "synthesized"] }, ...prov }
                }
            }
        };
    }

    return {
        SCHEMA_VERSION, POWERTRAINS, SEGMENTS, CLASS_MATRIX, TRANSMISSION_FOR, SOURCE_KINDS, AUTHORITATIVE_KINDS, CONF_CAP, CERT_MIN_CONF, ADVISE_MIN_CONF, FUEL_STATUS, FIELDS, SI_UNITS, siUnit, toSI,
        validateBundle, validateCatalog, validateFuelGrades, validateEmissionStandards,
        resolvePriors, isFuelAdvisable, parseTyre, sweptVolumeCm3, buildJsonSchema
    };
});
