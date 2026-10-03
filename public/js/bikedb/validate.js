// @ts-check
"use strict";

/* ============================================================================
   MapUnite bike database — js/bikedb/validate.js
   ==============================================================================
   The strict validator for bike profile bundles (data/schema/bundle.schema.json)
   and the two lookup tables (fuel_grade, emission_standard).

   One file, no dependencies, runs unchanged in three places:
     - the browser / Android app as a classic script (window.MUBikeValidator),
     - Node via require() (server, scripts/validate-bikes.mjs, tests),
     - the step-3 build that compiles data/ into bikes.sqlite + bundles.

   Structure is checked field by field, mirroring bundle.schema.json exactly
   (test/bikedb/schema-agreement.test.js proves the two agree on every seed
   file and on a corpus of broken bundles). On top of the structure it
   enforces what a JSON Schema cannot express:
     - SI units: every quantity names its unit (UCUM code) and must use the
       one SI unit for that field. "rpm", "kW", "cc", "km/h" ... are rejected
       with the converted value in the message.
     - Provenance: every value cites a source declared in the bundle, with a
       confidence in [0, 1] and a method; a "published" value quotes the
       published text verbatim; estimates carry an uncertainty and are capped
       in confidence.
     - Physics: idle < torque peak <= power peak <= redline; peak power can't
       exceed peak torque at that speed; bore x stroke matches displacement;
       BMEP, specific power and mean piston speed inside what any production
       engine reaches; gearing can reach the claimed top speed; an EV's
       claimed range can't beat the rolling-resistance floor; ...
     - Fuel safety: an engine must be certified for at least one fuel; only a
       manufacturer-published statement can certify a grade; blends above
       E20 only on a declared flex-fuel engine; an EV certifies no fuel.

   Result: { valid, errors: Issue[], warnings: Issue[] }; an Issue is
   { code, path (JSON Pointer), message }. Errors make a bundle unusable;
   warnings are sourcing debt a reviewer should see (low-confidence values on
   the physics path, implausible-but-possible figures).
   ============================================================================ */

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module && module.exports) module.exports = api;
    else /** @type {any} */ (root).MUBikeValidator = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {

    // ------------------------------------------------------------------------
    // Vocabulary
    // ------------------------------------------------------------------------
    const SCHEMA_VERSION = "1.0.0";
    const SCHEMA_VERSION_RE = /^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
    const POWERTRAINS = Object.freeze(["ice_manual", "ice_cvt", "ev"]);
    const SEGMENTS = Object.freeze(["commuter", "scooter", "cruiser", "naked", "sport", "adventure"]);
    const KINDS = Object.freeze(["variant", "class_default"]);
    const METHODS = Object.freeze(["published", "measured", "derived", "estimated", "class_default", "calibrated"]);
    const SOURCE_KINDS = Object.freeze([
        "oem_spec_sheet", "oem_owner_manual", "oem_press_release", "press", "regulation", "dataset",
        "standard", "reference_book", "peer_reviewed", "engineering_estimate", "class_default"
    ]);
    // Kinds that are web pages: they need a URL and the date it was read.
    const WEB_SOURCE_KINDS = Object.freeze(["oem_spec_sheet", "oem_owner_manual", "oem_press_release", "press", "regulation", "dataset"]);
    // Kinds that are documents: they need a bibliographic citation.
    const CITED_SOURCE_KINDS = Object.freeze(["standard", "reference_book", "peer_reviewed"]);
    const FUEL_STATUSES = Object.freeze(["certified", "not_certified", "unverified"]);
    const MASS_BASES = Object.freeze(["kerb_90pct_fuel", "kerb_full_fuel", "kerb_no_fuel", "dry", "unspecified"]);

    // Categorical facts (they carry provenance like any value).
    const ENUMS = Object.freeze({
        engine_cycle: ["four_stroke", "two_stroke"],
        aspiration: ["natural", "turbocharged", "supercharged"],
        cooling: ["air", "air_oil", "liquid"],
        fuel_system: ["carburettor", "port_injection", "direct_injection"],
        final_drive: ["chain", "belt", "shaft", "gear"],
        motor_type: ["pmsm", "bldc", "induction", "switched_reluctance"],
        motor_mounting: ["hub", "mid_drive"],
        torque_reference: ["motor_shaft", "wheel"],
        battery_chemistry: ["li_ion", "li_ion_nmc", "li_ion_lfp", "lead_acid"],
        ev_drive: ["hub", "belt", "chain", "gear"],
        range_cycle: ["IDC", "MIDC", "WMTC", "OEM_REAL_WORLD"]
    });

    /** Units are UCUM codes; one SI (coherent) unit per kind of quantity. */
    const SI_UNITS = Object.freeze({
        mass: "kg", length: "m", area: "m2", volume: "m3", power: "W", torque: "N.m",
        angular_speed: "rad/s", speed: "m/s", energy: "J", specific_energy: "J/kg",
        energy_density: "J/m3", density: "kg/m3", voltage: "V", pressure: "Pa",
        emission: "kg/m", ratio: "1"
    });

    // Non-SI units people will try, with the factor to the SI unit. Used only
    // to make the rejection message useful ("7500 rpm = 785.398 rad/s").
    /** @type {Record<string, [string, number]>} */
    const UNIT_HINTS = {
        "rpm": ["rad/s", (2 * Math.PI) / 60], "r/min": ["rad/s", (2 * Math.PI) / 60],
        "kW": ["W", 1e3], "PS": ["W", 735.49875], "hp": ["W", 745.699872], "bhp": ["W", 745.699872],
        "cc": ["m3", 1e-6], "cm3": ["m3", 1e-6], "L": ["m3", 1e-3], "l": ["m3", 1e-3],
        "mm": ["m", 1e-3], "cm": ["m", 1e-2], "in": ["m", 0.0254], "km": ["m", 1e3],
        "km/h": ["m/s", 1 / 3.6], "kmph": ["m/s", 1 / 3.6], "kph": ["m/s", 1 / 3.6], "mph": ["m/s", 0.44704],
        "kWh": ["J", 3.6e6], "Wh": ["J", 3600], "MJ": ["J", 1e6],
        "MJ/kg": ["J/kg", 1e6], "kJ/kg": ["J/kg", 1e3], "MJ/L": ["J/m3", 1e9],
        "g/cm3": ["kg/m3", 1e3], "kg/L": ["kg/m3", 1e3], "g/L": ["kg/m3", 1],
        "g": ["kg", 1e-3], "lb": ["kg", 0.45359237], "bar": ["Pa", 1e5], "kPa": ["Pa", 1e3],
        "g/km": ["kg/m", 1e-6], "mg/km": ["kg/m", 1e-9], "%": ["1", 0.01],
        "Nm": ["N.m", 1], "N·m": ["N.m", 1], "N m": ["N.m", 1], "kgf.m": ["N.m", 9.80665],
        "m^2": ["m2", 1], "m²": ["m2", 1], "m^3": ["m3", 1], "m³": ["m3", 1], "kg/m^3": ["kg/m3", 1]
    };

    // ------------------------------------------------------------------------
    // Physical limits. Hard limits are "no production two-wheeler can be
    // outside this" — crossing one is an error. Soft limits flag the unusual.
    // ------------------------------------------------------------------------
    const G = 9.80665;                    // m/s², standard gravity
    const RPM = (2 * Math.PI) / 60;       // rad/s per rpm
    const LIMITS = Object.freeze({
        kerbMass: { gt: 30, max: 600 },                 // kg
        displacement: { gt: 0, max: 2.6e-3 },           // m³ (largest production bike: 2.458 L)
        boreStroke: { gt: 0.02, max: 0.15 },            // m
        compressionRatio: { gt: 4, max: 16 },
        idle: { min: 500 * RPM, max: 3000 * RPM },      // rad/s
        engineSpeed: { gt: 0, max: 20000 * RPM },       // rad/s
        enginePower: { gt: 0, max: 250e3 },             // W
        engineTorque: { gt: 0, max: 300 },              // N·m at the crank
        motorPower: { gt: 0, max: 200e3 },              // W
        motorTorque: { gt: 0, max: 2000 },              // N·m (a hub motor's is wheel torque)
        cylinders: { min: 1, max: 6, integer: true },
        tank: { gt: 0, max: 0.04 },                     // m³ (40 L)
        topSpeed: { gt: 0, max: 120 },                  // m/s (432 km/h)
        cda: { min: 0.1, max: 1.5 },                    // m²
        crr: { min: 0.003, max: 0.05 },
        efficiency: { gt: 0, max: 1 },
        frictionMep: { min: 0.3e5, max: 4e5 },          // Pa
        auxPower: { min: 0, max: 2000 },                // W
        gearRatio: { min: 0.3, max: 6 },
        primaryRatio: { min: 1, max: 5 },
        sprocket: { min: 8, max: 80, integer: true },
        gearCount: { min: 1, max: 7, integer: true },
        cvtRatio: { min: 0.3, max: 5 },
        cvtFinal: { min: 2, max: 25 },
        evReduction: { min: 1, max: 25 },
        engagement: { min: 1000 * RPM, max: 6000 * RPM },// rad/s, CVT clutch-in
        rollingRadius: { min: 0.15, max: 0.4 },         // m
        batteryEnergy: { gt: 0, max: 100e6 },           // J (27.8 kWh)
        voltage: { gt: 0, max: 1000 },                  // V
        range: { gt: 0, max: 1e6 },                     // m
        ethanolFraction: { min: 0, max: 1 },
        ron: { min: 80, max: 120 },
        lhvMass: { min: 20e6, max: 50e6 },              // J/kg
        lhvVolume: { min: 15e9, max: 40e9 },            // J/m³
        fuelDensity: { min: 600, max: 900 },            // kg/m³
        emission: { min: 0, max: 1e-4 },                // kg/m (100 g/km)
        minRon: { min: 80, max: 110 }
    });
    const PHYS = Object.freeze({
        powerTorqueTol: 0.03,        // P_max <= T_max·ω_P·(1+tol): rounding in published figures
        displacementTol: 0.03,       // bore/stroke vs displacement
        bmepNaMax: 16e5,             // Pa — no production NA four-stroke exceeds this
        bmepNaWarn: 14e5,
        bmepForcedMax: 35e5,
        specificPowerNaMax: 220e6,   // W/m³ (220 kW/L)
        pistonSpeedMax: 27,          // m/s mean piston speed at redline
        pistonSpeedWarn: 24,
        gearingSlack: 1.05,          // top speed may exceed redline-in-top-gear by tyre growth etc.
        evRangeCrrFloor: 0.006,      // lowest plausible Crr on a test drum
        evRangeTestPayload: 75,      // kg rider on a range test
        massPriorTol: 0.30,          // prior mass within ±30 % of kerb mass
        maxEthanolWithoutFlex: 20,   // % ethanol certifiable on a non-flex engine
        certifyMinConfidence: 0.6,   // a fuel certification below this is not one
        estimateMaxConfidence: 0.6,  // an estimate can't claim more than this
        classDefaultMaxConfidence: 0.5,
        lowConfidenceWarn: 0.5,
        tyreRadiusMinFactor: 0.88,   // rolling radius vs unloaded radius from the tyre code
        tyreRadiusMaxFactor: 1.01
    });

    // Fields a bundle must never have: drag is CdA with uncertainty, never Cd.
    const FORBIDDEN_KEYS = Object.freeze({
        cd: "drag is modelled as CdA (priors.cda, m2) with an uncertainty, never as an exact Cd",
        drag_coefficient: "drag is modelled as CdA (priors.cda, m2) with an uncertainty, never as an exact Cd",
        frontal_area: "drag is modelled as one CdA prior (priors.cda, m2); Cd and frontal area are not separately identifiable"
    });

    const ID_RE = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
    const SOURCE_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/;
    const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
    const URL_RE = /^https?:\/\/[^\s/$.?#][^\s]*$/;
    const FUEL_GRADE_RE = /^E(0|[1-9]\d?|100)$/;
    const EMISSION_ID_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
    const MARKET_RE = /^[A-Z]{2}$/;

    // ------------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------------
    /** @typedef {{ code: string, path: string, message: string }} Issue */
    /** @typedef {{ valid: boolean, errors: Issue[], warnings: Issue[] }} Result */
    /** @typedef {Record<string, unknown>} Obj */
    /**
     * @typedef {object} Bounds
     * @property {number} [min]  inclusive lower bound
     * @property {number} [max]  inclusive upper bound
     * @property {number} [gt]   exclusive lower bound
     * @property {boolean} [integer]
     */
    /**
     * @typedef {object} Ctx
     * @property {Issue[]} errors
     * @property {Issue[]} warnings
     * @property {Map<string, string>} sources   source id -> source kind
     * @property {Set<string>} used               source ids actually cited
     * @property {Array<{ path: string, confidence: number }>} critical  physics-path values, for the low-confidence report
     */
    /** A checked quantity: its number and how much we trust it. */
    /** @typedef {{ v: number, c: number, method: string }} QV */

    // ------------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------------
    /** @param {unknown} v @returns {v is Obj} */
    function isObj(v) { return typeof v === "object" && v !== null && !Array.isArray(v); }
    /** @param {unknown} v @returns {v is number} */
    function isNum(v) { return typeof v === "number" && Number.isFinite(v); }
    /** @param {string} s */
    function esc(s) { return s.replace(/~/g, "~0").replace(/\//g, "~1"); }
    /** @param {string} path @param {string | number} key */
    function at(path, key) { return `${path}/${esc(String(key))}`; }
    /** @param {number} x */
    function fmt(x) { return Number(x.toPrecision(6)).toString(); }
    /** @param {number} radPerS */
    function rpm(radPerS) { return Math.round(radPerS / RPM); }

    /** @param {Ctx} ctx @param {string} code @param {string} path @param {string} message */
    function err(ctx, code, path, message) { ctx.errors.push({ code, path: path || "/", message }); }
    /** @param {Ctx} ctx @param {string} code @param {string} path @param {string} message */
    function warn(ctx, code, path, message) { ctx.warnings.push({ code, path: path || "/", message }); }

    /** @returns {Ctx} */
    function newCtx() { return { errors: [], warnings: [], sources: new Map(), used: new Set(), critical: [] }; }

    /** @param {Ctx} ctx @returns {Result} */
    function result(ctx) { return { valid: ctx.errors.length === 0, errors: ctx.errors, warnings: ctx.warnings }; }

    /**
     * Checks that v is an object with exactly the allowed keys.
     * @param {Ctx} ctx @param {unknown} v @param {string} path
     * @param {readonly string[]} required @param {readonly string[]} optional
     * @returns {Obj | null}
     */
    function object(ctx, v, path, required, optional) {
        if (v === undefined) return null; // a missing required field is reported by its parent
        if (!isObj(v)) { err(ctx, "E_TYPE", path, "must be an object"); return null; }
        for (const k of required) {
            if (!(k in v) || v[k] === undefined) err(ctx, "E_REQUIRED", at(path, k), `missing required field "${k}"`);
        }
        for (const k of Object.keys(v)) {
            if (required.includes(k) || optional.includes(k)) continue;
            const why = /** @type {Record<string, string>} */ (FORBIDDEN_KEYS)[k];
            if (why) err(ctx, "E_FORBIDDEN_FIELD", at(path, k), `"${k}" is not allowed: ${why}`);
            else err(ctx, "E_UNKNOWN_FIELD", at(path, k), `unknown field "${k}"`);
        }
        return v;
    }

    /** @param {Ctx} ctx @param {unknown} v @param {string} path @param {RegExp} [re] @returns {string | null} */
    function string(ctx, v, path, re) {
        if (v === undefined) return null;
        if (typeof v !== "string" || v.trim() === "") { err(ctx, "E_TYPE", path, "must be a non-empty string"); return null; }
        if (re && !re.test(v)) { err(ctx, "E_FORMAT", path, `"${v}" does not match ${re}`); return null; }
        return v;
    }

    /** @param {Ctx} ctx @param {unknown} v @param {string} path @param {readonly string[]} allowed @returns {string | null} */
    function oneOf(ctx, v, path, allowed) {
        if (v === undefined) return null;
        if (typeof v !== "string" || !allowed.includes(v)) {
            err(ctx, "E_ENUM", path, `must be one of ${allowed.join(", ")} (got ${JSON.stringify(v)})`);
            return null;
        }
        return v;
    }

    /** @param {Ctx} ctx @param {unknown} v @param {string} path @returns {string | null} */
    function date(ctx, v, path) {
        const s = string(ctx, v, path, DATE_RE);
        if (s && Number.isNaN(Date.parse(s + "T00:00:00Z"))) { err(ctx, "E_FORMAT", path, `"${s}" is not a calendar date`); return null; }
        return s;
    }

    /**
     * @param {Ctx} ctx @param {unknown} v @param {string} path @param {Bounds} b @param {string} what
     * @returns {boolean}
     */
    function inBounds(ctx, v, path, b, what) {
        if (v === undefined) return false;
        if (!isNum(v)) { err(ctx, "E_TYPE", path, `${what} must be a finite number`); return false; }
        if (b.integer && !Number.isInteger(v)) { err(ctx, "E_RANGE", path, `${what} must be an integer (got ${v})`); return false; }
        if (b.gt !== undefined && !(v > b.gt)) { err(ctx, "E_RANGE", path, `${what} ${fmt(v)} must be greater than ${fmt(b.gt)}`); return false; }
        if (b.min !== undefined && v < b.min) { err(ctx, "E_RANGE", path, `${what} ${fmt(v)} is below the physical minimum ${fmt(b.min)}`); return false; }
        if (b.max !== undefined && v > b.max) { err(ctx, "E_RANGE", path, `${what} ${fmt(v)} is above the physical maximum ${fmt(b.max)}`); return false; }
        return true;
    }

    // ------------------------------------------------------------------------
    // Provenance: shared by Quantity, QuantityArray, Fact and fuel entries
    // ------------------------------------------------------------------------
    const PROV_REQUIRED = Object.freeze(["source", "confidence", "method"]);
    const PROV_OPTIONAL = Object.freeze(["published", "note"]);

    /**
     * @param {Ctx} ctx @param {Obj} o @param {string} path
     * @returns {{ c: number, method: string } | null}
     */
    function provenance(ctx, o, path) {
        let ok = true;
        const src = o.source;
        if (src === undefined) ok = false; // already reported by object()
        else if (typeof src !== "string" || !SOURCE_ID_RE.test(src)) { err(ctx, "E_PROVENANCE", at(path, "source"), "source must be a source id"); ok = false; }
        else if (!ctx.sources.has(src)) { err(ctx, "E_PROVENANCE", at(path, "source"), `source "${src}" is not declared in /sources`); ok = false; }
        else ctx.used.add(src);

        const c = o.confidence;
        if (c === undefined) ok = false;
        else if (!isNum(c) || c < 0 || c > 1) { err(ctx, "E_CONFIDENCE", at(path, "confidence"), `confidence must be a number in [0, 1] (got ${JSON.stringify(c)})`); ok = false; }

        const m = o.method;
        if (m === undefined) ok = false;
        else if (typeof m !== "string" || !METHODS.includes(m)) { err(ctx, "E_ENUM", at(path, "method"), `method must be one of ${METHODS.join(", ")}`); ok = false; }

        if (o.published !== undefined && (typeof o.published !== "string" || o.published.trim() === "")) {
            err(ctx, "E_TYPE", at(path, "published"), "published must be the verbatim published text"); ok = false;
        }
        if (o.note !== undefined && (typeof o.note !== "string" || o.note.trim() === "")) {
            err(ctx, "E_TYPE", at(path, "note"), "note must be a non-empty string"); ok = false;
        }
        if (!ok || typeof m !== "string" || !isNum(c) || typeof src !== "string") return null;

        if (m === "published" && o.published === undefined) {
            err(ctx, "E_PROVENANCE", at(path, "published"), "a published value must quote the published text verbatim (e.g. \"13.5 kW @ 10000 r/min\") so a reviewer can check the SI conversion");
        }
        const kind = ctx.sources.get(src);
        if ((m === "published" || m === "measured") && (kind === "engineering_estimate" || kind === "class_default")) {
            err(ctx, "E_PROVENANCE", at(path, "method"), `a ${m} value can't cite a source of kind ${kind}`);
        }
        if (m === "class_default" && kind !== "class_default") {
            err(ctx, "E_PROVENANCE", at(path, "source"), "a class_default value must cite a source of kind class_default");
        }
        if (m === "estimated" && c > PHYS.estimateMaxConfidence) {
            err(ctx, "E_CONFIDENCE", at(path, "confidence"), `an estimate can't claim confidence above ${PHYS.estimateMaxConfidence} (got ${c})`);
        }
        if (m === "class_default" && c > PHYS.classDefaultMaxConfidence) {
            err(ctx, "E_CONFIDENCE", at(path, "confidence"), `a class default can't claim confidence above ${PHYS.classDefaultMaxConfidence} (got ${c})`);
        }
        return { c, method: m };
    }

    /**
     * @param {Ctx} ctx @param {unknown} u @param {string} path @param {boolean} arrayMode
     * @param {number | null} value  scalar value, to check a uniform interval contains it
     */
    function uncertainty(ctx, u, path, arrayMode, value) {
        if (!isObj(u)) { err(ctx, "E_TYPE", path, "uncertainty must be an object"); return; }
        const dist = u.dist;
        if (dist === "normal") {
            if (object(ctx, u, path, ["dist", "sd"], [])) inBounds(ctx, u.sd, at(path, "sd"), { gt: 0 }, "sd");
        } else if (dist === "lognormal") {
            if (object(ctx, u, path, ["dist", "sigma_ln"], [])) inBounds(ctx, u.sigma_ln, at(path, "sigma_ln"), { gt: 0, max: 3 }, "sigma_ln");
        } else if (dist === "uniform" && !arrayMode) {
            if (object(ctx, u, path, ["dist", "min", "max"], []) && isNum(u.min) && isNum(u.max)) {
                if (!(u.min < u.max)) err(ctx, "E_RANGE", path, "uniform min must be below max");
                else if (value !== null && (value < u.min || value > u.max)) err(ctx, "E_RANGE", path, `value ${fmt(value)} lies outside its own uniform interval`);
            } else if (isObj(u)) { inBounds(ctx, u.min, at(path, "min"), {}, "min"); inBounds(ctx, u.max, at(path, "max"), {}, "max"); }
        } else {
            err(ctx, "E_ENUM", at(path, "dist"), `dist must be one of normal, lognormal${arrayMode ? "" : ", uniform"}`);
        }
    }

    /** @param {Ctx} ctx @param {Obj} o @param {string} path @param {string} unit @returns {boolean} */
    function checkUnit(ctx, o, path, unit) {
        const u = o.unit;
        if (u === undefined) return false;
        if (u === unit) return true;
        const hint = typeof u === "string" ? UNIT_HINTS[u] : undefined;
        let msg = `unit ${JSON.stringify(u)} is not the SI unit for this field; expected "${unit}"`;
        if (hint && hint[0] === unit) {
            const sample = isNum(o.value) ? o.value : Array.isArray(o.values) && isNum(o.values[0]) ? o.values[0] : null;
            if (sample !== null) msg += ` (${fmt(sample)} ${u} = ${fmt(sample * hint[1])} ${unit})`;
            else msg += ` (multiply by ${fmt(hint[1])})`;
        }
        err(ctx, "E_UNIT", at(path, "unit"), msg);
        return false;
    }

    const Q_REQUIRED = Object.freeze(["value", "unit", ...PROV_REQUIRED]);
    const Q_OPTIONAL = Object.freeze([...PROV_OPTIONAL, "uncertainty"]);

    /**
     * A scalar quantity: { value, unit, source, confidence, method, published?, note?, uncertainty? }.
     * @param {Ctx} ctx @param {unknown} v @param {string} path @param {string} unit @param {Bounds} b
     * @param {{ critical?: boolean }} [opt]
     * @returns {QV | null}
     */
    function quantity(ctx, v, path, unit, b, opt) {
        const o = object(ctx, v, path, Q_REQUIRED, Q_OPTIONAL);
        if (!o) return null;
        const p = provenance(ctx, o, path);
        const unitOk = checkUnit(ctx, o, path, unit);
        const valOk = o.value !== undefined && inBounds(ctx, o.value, at(path, "value"), b, "value");
        if (o.uncertainty !== undefined) uncertainty(ctx, o.uncertainty, at(path, "uncertainty"), false, valOk ? /** @type {number} */ (o.value) : null);
        else if (p && (p.method === "estimated" || p.method === "class_default")) {
            err(ctx, "E_UNCERTAINTY", at(path, "uncertainty"), `an ${p.method} value must state its uncertainty`);
        }
        if (!p || !unitOk || !valOk) return null;
        if (opt && opt.critical) ctx.critical.push({ path, confidence: p.c });
        return { v: /** @type {number} */ (o.value), c: p.c, method: p.method };
    }

    /**
     * A vector quantity sharing one provenance: { values: number[], unit, ... }.
     * @param {Ctx} ctx @param {unknown} v @param {string} path @param {string} unit @param {Bounds} b
     * @returns {{ v: number[], c: number, method: string } | null}
     */
    function quantityArray(ctx, v, path, unit, b) {
        const o = object(ctx, v, path, ["values", "unit", ...PROV_REQUIRED], Q_OPTIONAL);
        if (!o) return null;
        const p = provenance(ctx, o, path);
        const unitOk = checkUnit(ctx, o, path, unit);
        let valOk = false;
        if (o.values !== undefined) {
            if (!Array.isArray(o.values) || o.values.length === 0) err(ctx, "E_TYPE", at(path, "values"), "values must be a non-empty array of numbers");
            else valOk = o.values.map((x, i) => inBounds(ctx, x, at(at(path, "values"), i), b, "value")).every(Boolean);
        }
        if (o.uncertainty !== undefined) uncertainty(ctx, o.uncertainty, at(path, "uncertainty"), true, null);
        else if (p && (p.method === "estimated" || p.method === "class_default")) {
            err(ctx, "E_UNCERTAINTY", at(path, "uncertainty"), `an ${p.method} value must state its uncertainty`);
        }
        if (!p || !unitOk || !valOk) return null;
        ctx.critical.push({ path, confidence: p.c });
        return { v: /** @type {number[]} */ (o.values), c: p.c, method: p.method };
    }

    /**
     * A categorical or textual fact with provenance: { value: string|boolean, source, ... }.
     * @param {Ctx} ctx @param {unknown} v @param {string} path
     * @param {{ allowed?: readonly string[], re?: RegExp, boolean?: boolean }} spec
     * @returns {{ v: string | boolean, c: number, method: string } | null}
     */
    function fact(ctx, v, path, spec) {
        const o = object(ctx, v, path, ["value", ...PROV_REQUIRED], PROV_OPTIONAL);
        if (!o) return null;
        const p = provenance(ctx, o, path);
        let val = null;
        if (o.value === undefined) { /* reported */ }
        else if (spec.boolean) {
            if (typeof o.value !== "boolean") err(ctx, "E_TYPE", at(path, "value"), "value must be true or false");
            else val = o.value;
        } else if (spec.allowed) val = oneOf(ctx, o.value, at(path, "value"), spec.allowed);
        else val = string(ctx, o.value, at(path, "value"), spec.re);
        if (!p || val === null) return null;
        return { v: val, c: p.c, method: p.method };
    }

    // ------------------------------------------------------------------------
    // Tyre codes ("80/100-18 M/C 47P", "140/70 R17", "2.75-17", "2.75 x 17")
    // ------------------------------------------------------------------------
    /**
     * Unloaded outer radius (m) from a tyre code, or null if it isn't one.
     * Inch-series codes ("2.75-17") are taken as full-profile (height = width).
     * @param {string} code
     * @returns {{ widthM: number, aspect: number, rimM: number, radiusM: number } | null}
     */
    function parseTyreCode(code) {
        const metric = /^(\d{2,3})\/(\d{2,3})\s*-?\s*(?:Z?R|B)?\s*-?\s*(\d{1,2})(?!\d)/i.exec(code.trim());
        if (metric) {
            const widthM = Number(metric[1]) / 1000, aspect = Number(metric[2]) / 100, rimIn = Number(metric[3]);
            if (rimIn < 8 || rimIn > 23 || aspect < 0.3 || aspect > 1.2) return null;
            const rimM = rimIn * 0.0254;
            return { widthM, aspect, rimM, radiusM: rimM / 2 + widthM * aspect };
        }
        const inch = /^(\d{1,2}\.\d{2})\s*(?:-|x|X)\s*(\d{1,2})(?!\d)/.exec(code.trim());
        if (inch) {
            const widthM = Number(inch[1]) * 0.0254, rimIn = Number(inch[2]);
            if (rimIn < 8 || rimIn > 23) return null;
            const rimM = rimIn * 0.0254;
            return { widthM, aspect: 1, rimM, radiusM: rimM / 2 + widthM };
        }
        return null;
    }

    // ------------------------------------------------------------------------
    // Quantised curves
    // ------------------------------------------------------------------------
    /**
     * Decodes a curve's data into SI values (value = q·scale + offset).
     * "array": data is an array of integers 0..65535.
     * "u16le-base64": data is base64 of little-endian uint16 samples — the
     * BLOB form the step-3 build writes into SQLite.
     * @param {{ encoding: string, data: unknown, scale: number, offset?: number }} curve
     * @returns {number[] | null}
     */
    function decodeCurve(curve) {
        /** @type {number[]} */
        let q;
        if (curve.encoding === "array") {
            if (!Array.isArray(curve.data)) return null;
            q = /** @type {number[]} */ (curve.data);
        } else if (curve.encoding === "u16le-base64") {
            if (typeof curve.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(curve.data)) return null;
            const bin = typeof atob === "function" ? atob(curve.data) : Buffer.from(curve.data, "base64").toString("latin1");
            if (bin.length % 2 !== 0) return null;
            q = [];
            for (let i = 0; i < bin.length; i += 2) q.push(bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8));
        } else return null;
        if (!q.every((x) => Number.isInteger(x) && x >= 0 && x <= 65535)) return null;
        const off = curve.offset || 0;
        return q.map((x) => x * curve.scale + off);
    }

    /**
     * @param {Ctx} ctx @param {unknown} v @param {string} path @param {"torque" | "power"} quantityName
     * @returns {{ speeds: number[], values: number[], c: number } | null}
     */
    function curve(ctx, v, path, quantityName) {
        const o = object(ctx, v, path,
            ["unit", "axis", "scale", "encoding", "data", ...PROV_REQUIRED],
            ["offset", ...Q_OPTIONAL]);
        if (!o) return null;
        const p = provenance(ctx, o, path);
        const unitOk = checkUnit(ctx, o, path, quantityName === "torque" ? SI_UNITS.torque : SI_UNITS.power);
        const axis = object(ctx, o.axis, at(path, "axis"), ["unit", "start", "step"], []);
        let axisOk = false;
        if (axis) {
            const aPath = at(path, "axis");
            const uOk = checkUnit(ctx, axis, aPath, SI_UNITS.angular_speed);
            const sOk = inBounds(ctx, axis.start, at(aPath, "start"), LIMITS.engineSpeed, "axis start");
            const stOk = inBounds(ctx, axis.step, at(aPath, "step"), { gt: 0 }, "axis step");
            axisOk = uOk && sOk && stOk;
        }
        const scaleOk = inBounds(ctx, o.scale, at(path, "scale"), { gt: 0 }, "scale");
        const offOk = o.offset === undefined || inBounds(ctx, o.offset, at(path, "offset"), {}, "offset");
        const encOk = oneOf(ctx, o.encoding, at(path, "encoding"), ["array", "u16le-base64"]) !== null;
        if (o.uncertainty !== undefined) uncertainty(ctx, o.uncertainty, at(path, "uncertainty"), true, null);
        else if (p && (p.method === "estimated" || p.method === "class_default")) err(ctx, "E_UNCERTAINTY", at(path, "uncertainty"), `an ${p.method} curve must state its uncertainty`);
        if (!p || !unitOk || !axisOk || !scaleOk || !offOk || !encOk) return null;
        const values = decodeCurve(/** @type {any} */ (o));
        if (!values) { err(ctx, "E_CURVE", at(path, "data"), "data does not decode as unsigned 16-bit samples for this encoding"); return null; }
        if (values.length < 4) { err(ctx, "E_CURVE", at(path, "data"), "a curve needs at least 4 samples"); return null; }
        if (values.some((x) => x < 0)) { err(ctx, "E_CURVE", at(path, "data"), `${quantityName} can't be negative anywhere on the curve`); return null; }
        const a = /** @type {{ start: number, step: number }} */ (/** @type {unknown} */ (axis));
        const speeds = values.map((_, i) => a.start + i * a.step);
        return { speeds, values, c: p.c };
    }

    // ------------------------------------------------------------------------
    // Sources
    // ------------------------------------------------------------------------
    /** @param {Ctx} ctx @param {unknown} v @param {string} path */
    function sources(ctx, v, path) {
        if (v === undefined) return;
        if (!Array.isArray(v) || v.length === 0) { err(ctx, "E_PROVENANCE", path, "sources must be a non-empty array: every value needs a source"); return; }
        v.forEach((s, i) => {
            const sp = at(path, i);
            const o = object(ctx, s, sp, ["id", "kind", "title"],
                ["publisher", "url", "accessed", "published_date", "citation", "rationale", "class_ref", "notes"]);
            if (!o) return;
            const id = string(ctx, o.id, at(sp, "id"), SOURCE_ID_RE);
            const kind = oneOf(ctx, o.kind, at(sp, "kind"), SOURCE_KINDS);
            string(ctx, o.title, at(sp, "title"));
            for (const k of ["publisher", "citation", "rationale", "notes"]) if (o[k] !== undefined) string(ctx, o[k], at(sp, k));
            if (o.url !== undefined) string(ctx, o.url, at(sp, "url"), URL_RE);
            if (o.accessed !== undefined) date(ctx, o.accessed, at(sp, "accessed"));
            if (o.published_date !== undefined) date(ctx, o.published_date, at(sp, "published_date"));
            if (o.class_ref !== undefined) string(ctx, o.class_ref, at(sp, "class_ref"), ID_RE);
            if (kind && WEB_SOURCE_KINDS.includes(kind)) {
                if (o.url === undefined) err(ctx, "E_PROVENANCE", at(sp, "url"), `a ${kind} source needs the URL it was read from`);
                if (o.accessed === undefined) err(ctx, "E_PROVENANCE", at(sp, "accessed"), `a ${kind} source needs the date it was accessed`);
            }
            if (kind && CITED_SOURCE_KINDS.includes(kind) && o.citation === undefined) err(ctx, "E_PROVENANCE", at(sp, "citation"), `a ${kind} source needs a citation`);
            if (kind === "engineering_estimate" && o.rationale === undefined) err(ctx, "E_PROVENANCE", at(sp, "rationale"), "an engineering estimate must state its rationale");
            if (kind === "class_default" && o.class_ref === undefined) err(ctx, "E_PROVENANCE", at(sp, "class_ref"), "a class_default source must name the class-default bundle id");
            if (id && kind) {
                if (ctx.sources.has(id)) err(ctx, "E_DUPLICATE", at(sp, "id"), `duplicate source id "${id}"`);
                else ctx.sources.set(id, kind);
            }
        });
    }

    // ------------------------------------------------------------------------
    // Sections
    // ------------------------------------------------------------------------
    /** @param {Ctx} ctx @param {unknown} v @param {string} path */
    function engine(ctx, v, path) {
        const o = object(ctx, v, path,
            ["cycle", "cylinders", "aspiration", "cooling", "fuel_system", "displacement", "idle_speed", "redline_speed", "max_power", "max_torque"],
            ["bore", "stroke", "compression_ratio"]);
        if (!o) return null;
        const cycle = fact(ctx, o.cycle, at(path, "cycle"), { allowed: ENUMS.engine_cycle });
        const cyl = quantity(ctx, o.cylinders, at(path, "cylinders"), SI_UNITS.ratio, LIMITS.cylinders);
        const asp = fact(ctx, o.aspiration, at(path, "aspiration"), { allowed: ENUMS.aspiration });
        fact(ctx, o.cooling, at(path, "cooling"), { allowed: ENUMS.cooling });
        fact(ctx, o.fuel_system, at(path, "fuel_system"), { allowed: ENUMS.fuel_system });
        const disp = quantity(ctx, o.displacement, at(path, "displacement"), SI_UNITS.volume, LIMITS.displacement, { critical: true });
        const bore = o.bore === undefined ? null : quantity(ctx, o.bore, at(path, "bore"), SI_UNITS.length, LIMITS.boreStroke);
        const stroke = o.stroke === undefined ? null : quantity(ctx, o.stroke, at(path, "stroke"), SI_UNITS.length, LIMITS.boreStroke);
        if (o.compression_ratio !== undefined) quantity(ctx, o.compression_ratio, at(path, "compression_ratio"), SI_UNITS.ratio, LIMITS.compressionRatio);
        const idle = quantity(ctx, o.idle_speed, at(path, "idle_speed"), SI_UNITS.angular_speed, LIMITS.idle, { critical: true });
        const red = quantity(ctx, o.redline_speed, at(path, "redline_speed"), SI_UNITS.angular_speed, LIMITS.engineSpeed, { critical: true });

        const mp = object(ctx, o.max_power, at(path, "max_power"), ["power", "speed"], []);
        const P = mp ? quantity(ctx, mp.power, at(at(path, "max_power"), "power"), SI_UNITS.power, LIMITS.enginePower, { critical: true }) : null;
        const wP = mp ? quantity(ctx, mp.speed, at(at(path, "max_power"), "speed"), SI_UNITS.angular_speed, LIMITS.engineSpeed, { critical: true }) : null;
        const mt = object(ctx, o.max_torque, at(path, "max_torque"), ["torque", "speed"], []);
        const T = mt ? quantity(ctx, mt.torque, at(at(path, "max_torque"), "torque"), SI_UNITS.torque, LIMITS.engineTorque, { critical: true }) : null;
        const wT = mt ? quantity(ctx, mt.speed, at(at(path, "max_torque"), "speed"), SI_UNITS.angular_speed, LIMITS.engineSpeed, { critical: true }) : null;

        // --- physics ---
        if (idle && red && !(red.v > idle.v)) {
            err(ctx, "E_PHYSICS_IDLE_REDLINE", at(path, "redline_speed"), `redline ${rpm(red.v)} rpm must be above idle ${rpm(idle.v)} rpm`);
        }
        if (wP && red && wP.v > red.v) err(ctx, "E_PHYSICS_PEAK_ORDER", at(at(path, "max_power"), "speed"), `peak power at ${rpm(wP.v)} rpm is beyond the redline ${rpm(red.v)} rpm`);
        if (wT && red && wT.v > red.v) err(ctx, "E_PHYSICS_PEAK_ORDER", at(at(path, "max_torque"), "speed"), `peak torque at ${rpm(wT.v)} rpm is beyond the redline ${rpm(red.v)} rpm`);
        if (wT && idle && wT.v < idle.v) err(ctx, "E_PHYSICS_PEAK_ORDER", at(at(path, "max_torque"), "speed"), `peak torque at ${rpm(wT.v)} rpm is below idle ${rpm(idle.v)} rpm`);
        // If torque peaked above the power-peak speed, power there would exceed "peak" power.
        if (wT && wP && wT.v > wP.v) err(ctx, "E_PHYSICS_PEAK_ORDER", at(at(path, "max_torque"), "speed"), `peak torque at ${rpm(wT.v)} rpm can't come after peak power at ${rpm(wP.v)} rpm (P = T·ω would exceed the stated peak power)`);
        if (P && T && wP && P.v > T.v * wP.v * (1 + PHYS.powerTorqueTol)) {
            err(ctx, "E_PHYSICS_POWER_TORQUE", at(at(path, "max_power"), "power"),
                `peak power ${fmt(P.v)} W at ${rpm(wP.v)} rpm needs ${fmt(P.v / wP.v)} N.m there, more than the peak torque ${fmt(T.v)} N.m`);
        }
        if (P && T && wT && T.v * wT.v > P.v * (1 + PHYS.powerTorqueTol)) {
            err(ctx, "E_PHYSICS_POWER_TORQUE", at(at(path, "max_torque"), "torque"),
                `peak torque ${fmt(T.v)} N.m at ${rpm(wT.v)} rpm is ${fmt(T.v * wT.v)} W, more than the peak power ${fmt(P.v)} W`);
        }
        if (disp && bore && stroke && cyl) {
            const geo = (Math.PI / 4) * bore.v * bore.v * stroke.v * cyl.v;
            if (Math.abs(geo - disp.v) / disp.v > PHYS.displacementTol) {
                err(ctx, "E_PHYSICS_DISPLACEMENT", at(path, "displacement"),
                    `bore ${fmt(bore.v)} m x stroke ${fmt(stroke.v)} m x ${cyl.v} cyl = ${fmt(geo)} m3, which is ${fmt(100 * (geo / disp.v - 1))} % off the stated ${fmt(disp.v)} m3`);
            }
        }
        const forced = asp && asp.v !== "natural";
        if (T && disp && cycle) {
            // BMEP = 2π·nR·T / Vd, nR = 2 for four-stroke, 1 for two-stroke.
            const nR = cycle.v === "four_stroke" ? 2 : 1;
            const bmep = (2 * Math.PI * nR * T.v) / disp.v;
            const max = forced ? PHYS.bmepForcedMax : PHYS.bmepNaMax;
            if (bmep > max) err(ctx, "E_PHYSICS_BMEP", at(at(path, "max_torque"), "torque"), `torque implies a BMEP of ${fmt(bmep / 1e5)} bar, above the ${fmt(max / 1e5)} bar any production ${forced ? "forced-induction" : "naturally aspirated"} engine reaches`);
            else if (!forced && cycle.v === "four_stroke" && bmep > PHYS.bmepNaWarn) warn(ctx, "W_PHYSICS_BMEP", at(at(path, "max_torque"), "torque"), `BMEP ${fmt(bmep / 1e5)} bar is unusually high for a naturally aspirated engine`);
        }
        if (P && disp && !forced && P.v / disp.v > PHYS.specificPowerNaMax) {
            err(ctx, "E_PHYSICS_SPECIFIC_POWER", at(at(path, "max_power"), "power"), `${fmt(P.v / disp.v / 1e6)} kW/L is beyond any naturally aspirated production engine`);
        }
        if (stroke && red) {
            const cm = (2 * stroke.v * red.v) / (2 * Math.PI);
            if (cm > PHYS.pistonSpeedMax) err(ctx, "E_PHYSICS_PISTON_SPEED", at(path, "redline_speed"), `mean piston speed at redline is ${fmt(cm)} m/s, beyond ${PHYS.pistonSpeedMax} m/s`);
            else if (cm > PHYS.pistonSpeedWarn) warn(ctx, "W_PHYSICS_PISTON_SPEED", at(path, "redline_speed"), `mean piston speed at redline is ${fmt(cm)} m/s, unusually high`);
        }
        return { red, wP };
    }

    /** @param {Ctx} ctx @param {unknown} v @param {string} path */
    function motor(ctx, v, path) {
        const o = object(ctx, v, path, ["type", "mounting", "rated_power", "peak_power", "peak_torque", "torque_reference"], ["max_speed"]);
        if (!o) return null;
        fact(ctx, o.type, at(path, "type"), { allowed: ENUMS.motor_type });
        const mount = fact(ctx, o.mounting, at(path, "mounting"), { allowed: ENUMS.motor_mounting });
        const rated = quantity(ctx, o.rated_power, at(path, "rated_power"), SI_UNITS.power, LIMITS.motorPower, { critical: true });
        const peak = quantity(ctx, o.peak_power, at(path, "peak_power"), SI_UNITS.power, LIMITS.motorPower, { critical: true });
        quantity(ctx, o.peak_torque, at(path, "peak_torque"), SI_UNITS.torque, LIMITS.motorTorque, { critical: true });
        const ref = fact(ctx, o.torque_reference, at(path, "torque_reference"), { allowed: ENUMS.torque_reference });
        const maxSpeed = o.max_speed === undefined ? null : quantity(ctx, o.max_speed, at(path, "max_speed"), SI_UNITS.angular_speed, LIMITS.engineSpeed);
        if (rated && peak && rated.v > peak.v) err(ctx, "E_PHYSICS_EV_POWER", at(path, "rated_power"), `rated (continuous) power ${fmt(rated.v)} W can't exceed peak power ${fmt(peak.v)} W`);
        if (mount && ref && mount.v === "hub" && ref.v !== "wheel") err(ctx, "E_PHYSICS_EV_HUB", at(path, "torque_reference"), "a hub motor's torque is wheel torque (torque_reference must be \"wheel\")");
        return { mount: mount ? mount.v : null, maxSpeed };
    }

    /** @param {Ctx} ctx @param {unknown} v @param {string} path */
    function battery(ctx, v, path) {
        const o = object(ctx, v, path, ["chemistry", "gross_energy", "usable_energy"], ["nominal_voltage"]);
        if (!o) return null;
        fact(ctx, o.chemistry, at(path, "chemistry"), { allowed: ENUMS.battery_chemistry });
        const gross = quantity(ctx, o.gross_energy, at(path, "gross_energy"), SI_UNITS.energy, LIMITS.batteryEnergy);
        const usable = quantity(ctx, o.usable_energy, at(path, "usable_energy"), SI_UNITS.energy, LIMITS.batteryEnergy, { critical: true });
        if (o.nominal_voltage !== undefined) quantity(ctx, o.nominal_voltage, at(path, "nominal_voltage"), SI_UNITS.voltage, LIMITS.voltage);
        if (gross && usable && usable.v > gross.v) err(ctx, "E_PHYSICS_EV_ENERGY", at(path, "usable_energy"), `usable energy ${fmt(usable.v)} J can't exceed gross energy ${fmt(gross.v)} J`);
        return { usable };
    }

    /**
     * @param {Ctx} ctx @param {unknown} v @param {string} path @param {string | null} powertrain
     * @returns {{ topOverall: number | null, c: number } | null}  overall reduction in the tallest ratio
     */
    function transmission(ctx, v, path, powertrain) {
        if (v === undefined) return null;
        if (!isObj(v)) { err(ctx, "E_TYPE", path, "must be an object"); return null; }
        const expected = powertrain === "ice_manual" ? "manual" : powertrain === "ice_cvt" ? "cvt" : powertrain === "ev" ? "direct" : null;
        const type = oneOf(ctx, v.type, at(path, "type"), ["manual", "cvt", "direct"]);
        if (type && expected && type !== expected) {
            err(ctx, "E_POWERTRAIN_MISMATCH", at(path, "type"), `a ${powertrain} bundle needs a "${expected}" transmission, not "${type}"`);
            return null;
        }
        if (type === "manual") {
            const o = object(ctx, v, path, ["type", "gear_count", "primary_ratio", "gear_ratios", "final_drive"], []);
            if (!o) return null;
            const n = quantity(ctx, o.gear_count, at(path, "gear_count"), SI_UNITS.ratio, LIMITS.gearCount);
            const prim = quantity(ctx, o.primary_ratio, at(path, "primary_ratio"), SI_UNITS.ratio, LIMITS.primaryRatio, { critical: true });
            const gears = quantityArray(ctx, o.gear_ratios, at(path, "gear_ratios"), SI_UNITS.ratio, LIMITS.gearRatio);
            if (n && gears && gears.v.length !== n.v) err(ctx, "E_PHYSICS_GEARS", at(path, "gear_ratios"), `${gears.v.length} ratios listed for a ${n.v}-speed gearbox`);
            if (gears) {
                for (let i = 1; i < gears.v.length; i++) {
                    if (!(gears.v[i] < gears.v[i - 1])) {
                        err(ctx, "E_PHYSICS_GEARS", at(at(path, "gear_ratios"), "values"), `gear ratios must strictly decrease from 1st to top (gear ${i + 1}: ${gears.v[i]} >= gear ${i}: ${gears.v[i - 1]})`);
                        break;
                    }
                }
            }
            const fdPath = at(path, "final_drive");
            const fd = object(ctx, o.final_drive, fdPath, ["type", "front_sprocket", "rear_sprocket"], []);
            let finalRatio = null;
            let fc = 1;
            if (fd) {
                fact(ctx, fd.type, at(fdPath, "type"), { allowed: ENUMS.final_drive });
                const f = quantity(ctx, fd.front_sprocket, at(fdPath, "front_sprocket"), SI_UNITS.ratio, LIMITS.sprocket, { critical: true });
                const r = quantity(ctx, fd.rear_sprocket, at(fdPath, "rear_sprocket"), SI_UNITS.ratio, LIMITS.sprocket, { critical: true });
                if (f && r) {
                    if (!(r.v > f.v)) err(ctx, "E_PHYSICS_GEARS", at(fdPath, "rear_sprocket"), `rear sprocket (${r.v}) must be larger than front (${f.v}) — the final drive reduces speed`);
                    else { finalRatio = r.v / f.v; fc = Math.min(f.c, r.c); }
                }
            }
            if (prim && gears && finalRatio !== null) {
                return { topOverall: prim.v * gears.v[gears.v.length - 1] * finalRatio, c: Math.min(prim.c, gears.c, fc) };
            }
            return null;
        }
        if (type === "cvt") {
            const o = object(ctx, v, path, ["type", "ratio_low", "ratio_high", "final_ratio", "engagement_speed"], []);
            if (!o) return null;
            const lo = quantity(ctx, o.ratio_low, at(path, "ratio_low"), SI_UNITS.ratio, LIMITS.cvtRatio, { critical: true });
            const hi = quantity(ctx, o.ratio_high, at(path, "ratio_high"), SI_UNITS.ratio, LIMITS.cvtRatio, { critical: true });
            const fin = quantity(ctx, o.final_ratio, at(path, "final_ratio"), SI_UNITS.ratio, LIMITS.cvtFinal, { critical: true });
            quantity(ctx, o.engagement_speed, at(path, "engagement_speed"), SI_UNITS.angular_speed, LIMITS.engagement, { critical: true });
            if (lo && hi && !(lo.v > hi.v)) err(ctx, "E_PHYSICS_CVT", at(path, "ratio_low"), `CVT low ratio ${lo.v} must be above its high (overdrive) ratio ${hi.v}`);
            if (hi && fin) return { topOverall: hi.v * fin.v, c: Math.min(hi.c, fin.c) };
            return null;
        }
        if (type === "direct") {
            const o = object(ctx, v, path, ["type", "drive", "reduction_ratio"], []);
            if (!o) return null;
            const drive = fact(ctx, o.drive, at(path, "drive"), { allowed: ENUMS.ev_drive });
            const red = quantity(ctx, o.reduction_ratio, at(path, "reduction_ratio"), SI_UNITS.ratio, LIMITS.evReduction, { critical: true });
            if (drive && red && drive.v === "hub" && red.v !== 1) err(ctx, "E_PHYSICS_EV_HUB", at(path, "reduction_ratio"), "a hub motor drives the wheel directly: reduction_ratio must be 1");
            if (red) return { topOverall: red.v, c: red.c };
            return null;
        }
        return null;
    }

    /** @param {Ctx} ctx @param {unknown} v @param {string} path */
    function tyre(ctx, v, path) {
        const f = fact(ctx, v, path, {});
        if (!f || typeof f.v !== "string") return null;
        const parsed = parseTyreCode(f.v);
        if (!parsed) { err(ctx, "E_FORMAT", at(path, "value"), `"${f.v}" is not a recognised tyre size code (e.g. "80/100-18", "140/70 R17", "2.75-17")`); return null; }
        return parsed;
    }

    /** @param {Ctx} ctx @param {unknown} v @param {string} path */
    function wheels(ctx, v, path) {
        const o = object(ctx, v, path, ["front_tyre", "rear_tyre", "rear_rolling_radius"], []);
        if (!o) return null;
        tyre(ctx, o.front_tyre, at(path, "front_tyre"));
        const rear = tyre(ctx, o.rear_tyre, at(path, "rear_tyre"));
        const r = quantity(ctx, o.rear_rolling_radius, at(path, "rear_rolling_radius"), SI_UNITS.length, LIMITS.rollingRadius, { critical: true });
        if (rear && r) {
            const lo = rear.radiusM * PHYS.tyreRadiusMinFactor, hi = rear.radiusM * PHYS.tyreRadiusMaxFactor;
            if (r.v < lo || r.v > hi) {
                err(ctx, "E_PHYSICS_TYRE", at(path, "rear_rolling_radius"),
                    `rolling radius ${fmt(r.v)} m doesn't fit the rear tyre (unloaded radius ${fmt(rear.radiusM)} m; expected ${fmt(lo)}–${fmt(hi)} m)`);
            }
        }
        return r;
    }

    /**
     * Fuel safety lives here. A variant's certifications are the manufacturer's
     * published word; a class default describes a class, not a vehicle, so it
     * certifies nothing (its grades are "unverified" and advice for an unknown
     * bike never names a fuel). reference_grade is the fuel the physics
     * assumes for energy content: on a variant it must be a certified grade.
     * @param {Ctx} ctx @param {unknown} v @param {string} path @param {boolean} isIce @param {boolean} isClass
     */
    function fuel(ctx, v, path, isIce, isClass) {
        const o = object(ctx, v, path, ["required", "compatibility"], ["tank_capacity", "min_ron", "flex_fuel", "reference_grade"]);
        if (!o) return;
        if (typeof o.required !== "boolean") err(ctx, "E_TYPE", at(path, "required"), "required must be true or false");
        else if (o.required !== isIce) err(ctx, "E_FUEL_REQUIRED", at(path, "required"), isIce ? "an engine requires fuel: required must be true" : "an EV requires no fuel: required must be false");

        let flex = false;
        if (isIce) {
            if (o.tank_capacity === undefined) err(ctx, "E_REQUIRED", at(path, "tank_capacity"), "an engine needs a fuel tank capacity");
            else quantity(ctx, o.tank_capacity, at(path, "tank_capacity"), SI_UNITS.volume, LIMITS.tank);
            if (o.min_ron !== undefined) quantity(ctx, o.min_ron, at(path, "min_ron"), SI_UNITS.ratio, LIMITS.minRon);
            if (o.flex_fuel === undefined) err(ctx, "E_REQUIRED", at(path, "flex_fuel"), "an engine must declare whether it is flex-fuel");
            else { const f = fact(ctx, o.flex_fuel, at(path, "flex_fuel"), { boolean: true }); flex = !!(f && f.v === true); }
            if (o.reference_grade === undefined) err(ctx, "E_REQUIRED", at(path, "reference_grade"), "an engine needs the reference fuel grade its energy figures assume");
        } else {
            for (const k of ["tank_capacity", "min_ron", "flex_fuel", "reference_grade"]) if (o[k] !== undefined) err(ctx, "E_FUEL_EV", at(path, k), `an EV has no ${k}`);
        }
        const refGrade = isIce && o.reference_grade !== undefined ? fact(ctx, o.reference_grade, at(path, "reference_grade"), { re: FUEL_GRADE_RE }) : null;

        if (!Array.isArray(o.compatibility)) { err(ctx, "E_TYPE", at(path, "compatibility"), "compatibility must be an array"); return; }
        /** @type {Map<string, string | null>} grade -> status */
        const seen = new Map();
        let certified = 0;
        let aboveE20 = 0;
        o.compatibility.forEach((e, i) => {
            const ep = at(at(path, "compatibility"), i);
            const c = object(ctx, e, ep, ["grade", "status", ...PROV_REQUIRED], PROV_OPTIONAL);
            if (!c) return;
            const p = provenance(ctx, c, ep);
            const grade = string(ctx, c.grade, at(ep, "grade"), FUEL_GRADE_RE);
            const status = oneOf(ctx, c.status, at(ep, "status"), FUEL_STATUSES);
            if (grade) {
                if (seen.has(grade)) err(ctx, "E_DUPLICATE", at(ep, "grade"), `grade ${grade} listed twice`);
                seen.set(grade, status);
            }
            if (status !== "certified" || !grade) return;
            if (!isIce) { err(ctx, "E_FUEL_EV", at(ep, "status"), "an EV can't be certified for a liquid fuel"); return; }
            if (isClass) { err(ctx, "E_FUEL_CERTIFICATION", at(ep, "status"), "a class default describes a class, not a vehicle: it can't certify a fuel (use \"unverified\")"); return; }
            // Fuel safety: only the manufacturer certifies a fuel.
            if (p && p.method !== "published") err(ctx, "E_FUEL_CERTIFICATION", at(ep, "method"), `a certification must be the manufacturer's published statement (method "published"), not "${p.method}"`);
            if (p && p.c < PHYS.certifyMinConfidence) err(ctx, "E_FUEL_CERTIFICATION", at(ep, "confidence"), `a certification with confidence ${p.c} is not one; use status "unverified"`);
            const ethanol = Number(grade.slice(1));
            if (ethanol > PHYS.maxEthanolWithoutFlex) {
                aboveE20++;
                if (!flex) err(ctx, "E_FUEL_FLEX", at(ep, "grade"), `${grade} can only be certified on a flex-fuel engine (fuel.flex_fuel must be true)`);
            }
            certified++;
        });
        if (refGrade && typeof refGrade.v === "string") {
            const st = seen.get(refGrade.v);
            if (st === undefined) err(ctx, "E_FUEL_REFERENCE", at(path, "reference_grade"), `reference grade ${refGrade.v} must be listed in compatibility`);
            else if (!isClass && st !== "certified") err(ctx, "E_FUEL_REFERENCE", at(path, "reference_grade"), `the physics can't assume ${refGrade.v}: this bike isn't certified for it`);
        }
        if (isIce && !isClass && certified === 0) err(ctx, "E_FUEL_NONE", at(path, "compatibility"), "this engine needs fuel but is certified for none: at least one grade must be \"certified\" by the manufacturer");
        if (isIce && flex && aboveE20 === 0) warn(ctx, "W_FUEL_FLEX", at(path, "flex_fuel"), "declared flex-fuel but no blend above E20 is certified");
    }

    /**
     * Priors are deliberately wide: cloud calibration narrows them per rider,
     * so they are not part of the low-confidence (sourcing debt) report.
     * @param {Ctx} ctx @param {unknown} v @param {string} path @param {boolean} isIce
     */
    function priors(ctx, v, path, isIce) {
        const req = ["cda", "crr", "mass", "drivetrain_efficiency"];
        const o = isIce
            ? object(ctx, v, path, [...req, "willans_efficiency", "friction_mep"], [])
            : object(ctx, v, path, req, ["regen_efficiency", "auxiliary_power"]);
        if (!o) return null;
        /** @param {string} k */
        const needU = (k) => {
            const q = o[k];
            if (isObj(q) && q.uncertainty === undefined) err(ctx, "E_UNCERTAINTY", at(at(path, k), "uncertainty"), "a prior must carry an uncertainty");
        };
        req.forEach(needU);
        const cda = quantity(ctx, o.cda, at(path, "cda"), SI_UNITS.area, LIMITS.cda);
        quantity(ctx, o.crr, at(path, "crr"), SI_UNITS.ratio, LIMITS.crr);
        const mass = quantity(ctx, o.mass, at(path, "mass"), SI_UNITS.mass, LIMITS.kerbMass);
        quantity(ctx, o.drivetrain_efficiency, at(path, "drivetrain_efficiency"), SI_UNITS.ratio, LIMITS.efficiency);
        if (isIce) {
            needU("willans_efficiency"); needU("friction_mep");
            quantity(ctx, o.willans_efficiency, at(path, "willans_efficiency"), SI_UNITS.ratio, { min: 0.1, max: 0.5 });
            quantity(ctx, o.friction_mep, at(path, "friction_mep"), SI_UNITS.pressure, LIMITS.frictionMep);
        } else {
            if (o.regen_efficiency !== undefined) { needU("regen_efficiency"); quantity(ctx, o.regen_efficiency, at(path, "regen_efficiency"), SI_UNITS.ratio, { min: 0, max: 1 }); }
            if (o.auxiliary_power !== undefined) { needU("auxiliary_power"); quantity(ctx, o.auxiliary_power, at(path, "auxiliary_power"), SI_UNITS.power, LIMITS.auxPower); }
        }
        return { cda, mass };
    }

    /** @param {Ctx} ctx @param {unknown} v @param {string} path @param {boolean} isIce */
    function performance(ctx, v, path, isIce) {
        const o = object(ctx, v, path, [], ["top_speed", "certified_range"]);
        if (!o) return { top: null, range: null };
        const top = o.top_speed === undefined ? null : quantity(ctx, o.top_speed, at(path, "top_speed"), SI_UNITS.speed, LIMITS.topSpeed);
        let range = null;
        if (o.certified_range !== undefined) {
            const rp = at(path, "certified_range");
            if (isIce) err(ctx, "E_FUEL_EV", rp, "certified_range is an EV figure");
            const r = object(ctx, o.certified_range, rp, ["distance", "cycle"], []);
            if (r) {
                range = quantity(ctx, r.distance, at(rp, "distance"), SI_UNITS.length, LIMITS.range);
                fact(ctx, r.cycle, at(rp, "cycle"), { allowed: ENUMS.range_cycle });
            }
        }
        return { top, range };
    }

    /** @param {Ctx} ctx @param {unknown} v @param {string} path @param {number | null} redline */
    function curves(ctx, v, path, redline) {
        const o = object(ctx, v, path, [], ["torque", "power"]);
        if (!o) return null;
        const t = o.torque === undefined ? null : curve(ctx, o.torque, at(path, "torque"), "torque");
        const p = o.power === undefined ? null : curve(ctx, o.power, at(path, "power"), "power");
        for (const [name, c] of /** @type {const} */ ([["torque", t], ["power", p]])) {
            if (c && redline !== null && c.speeds[c.speeds.length - 1] > redline * 1.02) {
                err(ctx, "E_CURVE", at(path, name), `${name} curve runs to ${rpm(c.speeds[c.speeds.length - 1])} rpm, past the redline ${rpm(redline)} rpm`);
            }
        }
        if (t && p) {
            // Where both are sampled, P must equal T·ω.
            for (let i = 0; i < p.speeds.length; i++) {
                const j = t.speeds.findIndex((s) => Math.abs(s - p.speeds[i]) < 1e-6);
                if (j < 0) continue;
                const tw = t.values[j] * t.speeds[j];
                if (Math.abs(tw - p.values[i]) > Math.max(0.05 * Math.max(tw, p.values[i]), 50)) {
                    err(ctx, "E_CURVE", at(path, "power"), `power ${fmt(p.values[i])} W at ${rpm(p.speeds[i])} rpm disagrees with torque x speed ${fmt(tw)} W`);
                    break;
                }
            }
        }
        return { t, p };
    }

    // ------------------------------------------------------------------------
    // Bundle
    // ------------------------------------------------------------------------
    const BUNDLE_KEYS = Object.freeze({
        required: ["schema_version", "id", "kind", "powertrain", "segment", "sources", "emission_standard",
            "transmission", "wheels", "mass", "fuel", "priors", "record"],
        optional: ["$schema", "identity", "class_default", "engine", "motor", "battery", "performance", "curves", "notes"]
    });

    /**
     * Validates one bike profile bundle.
     * @param {unknown} bundle  parsed JSON
     * @returns {Result}
     */
    function validateBundle(bundle) {
        const ctx = newCtx();
        if (!isObj(bundle)) { err(ctx, "E_TYPE", "", "a bundle must be a JSON object"); return result(ctx); }
        const o = object(ctx, bundle, "", BUNDLE_KEYS.required, BUNDLE_KEYS.optional);
        if (!o) return result(ctx);

        if (o.$schema !== undefined) string(ctx, o.$schema, "/$schema");
        const ver = string(ctx, o.schema_version, "/schema_version");
        if (ver && !SCHEMA_VERSION_RE.test(ver)) err(ctx, "E_VERSION", "/schema_version", `schema_version "${ver}" is not supported (this validator reads 1.x.y; current ${SCHEMA_VERSION})`);
        string(ctx, o.id, "/id", ID_RE);
        const kind = oneOf(ctx, o.kind, "/kind", KINDS);
        const pt = oneOf(ctx, o.powertrain, "/powertrain", POWERTRAINS);
        oneOf(ctx, o.segment, "/segment", SEGMENTS);
        if (o.notes !== undefined) string(ctx, o.notes, "/notes");

        // Sources first: every value below cites one.
        sources(ctx, o.sources, "/sources");

        const rec = object(ctx, o.record, "/record", ["created", "updated", "review_status"], ["reviewed_by"]);
        if (rec) {
            const c = date(ctx, rec.created, "/record/created");
            const u = date(ctx, rec.updated, "/record/updated");
            if (c && u && u < c) err(ctx, "E_RANGE", "/record/updated", "updated is before created");
            oneOf(ctx, rec.review_status, "/record/review_status", ["unreviewed", "reviewed"]);
            if (rec.reviewed_by !== undefined) string(ctx, rec.reviewed_by, "/record/reviewed_by");
            if (rec.review_status === "reviewed" && rec.reviewed_by === undefined) err(ctx, "E_REQUIRED", "/record/reviewed_by", "a reviewed record names its reviewer");
        }

        if (kind === "variant") {
            if (o.class_default !== undefined) err(ctx, "E_KIND", "/class_default", "a variant has identity, not class_default");
            if (o.identity === undefined) err(ctx, "E_REQUIRED", "/identity", "a variant needs identity (make, model, variant, market, model_years)");
            else {
                const id = object(ctx, o.identity, "/identity", ["make", "model", "variant", "market", "model_years"], ["aliases"]);
                if (id) {
                    string(ctx, id.make, "/identity/make");
                    string(ctx, id.model, "/identity/model");
                    string(ctx, id.variant, "/identity/variant");
                    string(ctx, id.market, "/identity/market", MARKET_RE);
                    const my = object(ctx, id.model_years, "/identity/model_years", ["from", "to"], []);
                    if (my) {
                        const fOk = inBounds(ctx, my.from, "/identity/model_years/from", { min: 1950, max: 2100, integer: true }, "from");
                        if (my.to !== null) {
                            const tOk = inBounds(ctx, my.to, "/identity/model_years/to", { min: 1950, max: 2100, integer: true }, "to");
                            if (fOk && tOk && /** @type {number} */ (my.to) < /** @type {number} */ (my.from)) err(ctx, "E_RANGE", "/identity/model_years/to", "model_years.to is before from");
                        }
                    }
                    if (id.aliases !== undefined) {
                        if (!Array.isArray(id.aliases)) err(ctx, "E_TYPE", "/identity/aliases", "aliases must be an array of strings");
                        else id.aliases.forEach((a, i) => string(ctx, a, at("/identity/aliases", i)));
                    }
                }
            }
        } else if (kind === "class_default") {
            if (o.identity !== undefined) err(ctx, "E_KIND", "/identity", "a class default describes a class, not a vehicle: no identity");
            if (o.class_default === undefined) err(ctx, "E_REQUIRED", "/class_default", "a class default needs class_default { label, basis }");
            else {
                const cd = object(ctx, o.class_default, "/class_default", ["label", "basis"], []);
                if (cd) { string(ctx, cd.label, "/class_default/label"); string(ctx, cd.basis, "/class_default/basis"); }
            }
            if (typeof o.id === "string" && pt && typeof o.segment === "string" && o.id !== classDefaultId(pt, o.segment)) {
                err(ctx, "E_FORMAT", "/id", `a class default's id must be "${classDefaultId(pt, o.segment)}"`);
            }
        }

        const isIce = pt === "ice_manual" || pt === "ice_cvt";
        const isEv = pt === "ev";

        // Emission standard: an engine has one; an EV has none.
        if (isIce) {
            if (o.emission_standard === null) err(ctx, "E_REQUIRED", "/emission_standard", "an engine needs its emission standard");
            else fact(ctx, o.emission_standard, "/emission_standard", { re: EMISSION_ID_RE });
        } else if (isEv && o.emission_standard !== null && o.emission_standard !== undefined) {
            err(ctx, "E_POWERTRAIN_MISMATCH", "/emission_standard", "an EV has no tailpipe emission standard: use null");
        }

        // Prime mover.
        /** @type {{ red: QV | null, wP: QV | null } | null} */
        let eng = null;
        /** @type {{ mount: string | boolean | null, maxSpeed: QV | null } | null} */
        let mot = null;
        /** @type {{ usable: QV | null } | null} */
        let bat = null;
        if (isIce) {
            if (o.engine === undefined) err(ctx, "E_REQUIRED", "/engine", `a ${pt} bundle needs an engine`);
            else eng = engine(ctx, o.engine, "/engine");
            for (const k of ["motor", "battery"]) if (o[k] !== undefined) err(ctx, "E_POWERTRAIN_MISMATCH", at("", k), `a ${pt} bundle has no ${k}`);
        } else if (isEv) {
            if (o.motor === undefined) err(ctx, "E_REQUIRED", "/motor", "an EV needs a motor");
            else mot = motor(ctx, o.motor, "/motor");
            if (o.battery === undefined) err(ctx, "E_REQUIRED", "/battery", "an EV needs a battery");
            else bat = battery(ctx, o.battery, "/battery");
            if (o.engine !== undefined) err(ctx, "E_POWERTRAIN_MISMATCH", "/engine", "an EV has no engine");
            if (o.curves !== undefined) err(ctx, "E_POWERTRAIN_MISMATCH", "/curves", "torque/power curves are engine curves; an EV has none in schema 1.x");
        }

        const tx = transmission(ctx, o.transmission, "/transmission", pt);
        if (tx && mot && mot.mount === "hub" && isObj(o.transmission) && isObj(o.transmission.drive) && o.transmission.drive.value !== "hub") {
            err(ctx, "E_PHYSICS_EV_HUB", "/transmission/drive", "a hub motor's drive must be \"hub\"");
        }
        const rr = wheels(ctx, o.wheels, "/wheels");

        const m = object(ctx, o.mass, "/mass", ["kerb", "basis"], []);
        const kerb = m ? quantity(ctx, m.kerb, "/mass/kerb", SI_UNITS.mass, LIMITS.kerbMass, { critical: true }) : null;
        if (m) {
            const basis = oneOf(ctx, m.basis, "/mass/basis", MASS_BASES);
            if (isEv && (basis === "kerb_90pct_fuel" || basis === "kerb_full_fuel")) err(ctx, "E_POWERTRAIN_MISMATCH", "/mass/basis", "an EV carries no fuel: basis can't include fuel");
        }

        fuel(ctx, o.fuel, "/fuel", isIce, kind === "class_default");
        const pr = pt ? priors(ctx, o.priors, "/priors", isIce) : null;
        const perf = o.performance === undefined ? { top: null, range: null } : performance(ctx, o.performance, "/performance", isIce);
        if (o.curves !== undefined && isIce) curves(ctx, o.curves, "/curves", eng && eng.red ? eng.red.v : null);

        // --- cross-section physics ---
        if (pr && pr.mass && kerb && Math.abs(pr.mass.v - kerb.v) / kerb.v > PHYS.massPriorTol) {
            err(ctx, "E_PHYSICS_MASS_PRIOR", "/priors/mass", `mass prior ${fmt(pr.mass.v)} kg is more than ${PHYS.massPriorTol * 100} % from the kerb mass ${fmt(kerb.v)} kg`);
        }
        if (perf.top && tx && tx.topOverall !== null && rr) {
            // Fastest the gearing allows: the prime mover's top speed through the tallest ratio.
            const wMax = isIce && eng ? eng.red : isEv && mot ? mot.maxSpeed : null;
            if (wMax) {
                const vGear = (wMax.v * rr.v) / tx.topOverall;
                if (perf.top.v > vGear * PHYS.gearingSlack) {
                    const msg = `claimed top speed ${fmt(perf.top.v * 3.6)} km/h is beyond what the gearing allows at ${rpm(wMax.v)} rpm (${fmt(vGear * 3.6)} km/h)`;
                    // Only a contradiction between well-sourced figures is an error.
                    if (Math.min(perf.top.c, tx.c, rr.c, wMax.c) >= PHYS.lowConfidenceWarn) err(ctx, "E_PHYSICS_TOP_SPEED", "/performance/top_speed", msg);
                    else warn(ctx, "W_PHYSICS_TOP_SPEED", "/performance/top_speed", msg + " — one of these is an estimate; fix the estimate");
                }
            }
        }
        if (perf.range && bat && bat.usable && kerb) {
            // The test can't use less energy than rolling resistance alone takes.
            const floor = PHYS.evRangeCrrFloor * (kerb.v + PHYS.evRangeTestPayload) * G; // J/m
            const implied = bat.usable.v / perf.range.v;
            if (implied < floor) {
                err(ctx, "E_PHYSICS_EV_RANGE", "/performance/certified_range/distance",
                    `range implies ${fmt(implied / 3.6)} Wh/km, below the rolling-resistance floor of ${fmt(floor / 3.6)} Wh/km`);
            }
        }

        // --- sourcing report ---
        for (const id of ctx.sources.keys()) if (!ctx.used.has(id)) warn(ctx, "W_UNUSED_SOURCE", "/sources", `source "${id}" is declared but never cited`);
        if (kind === "variant") {
            for (const c of ctx.critical) {
                if (c.confidence < PHYS.lowConfidenceWarn) warn(ctx, "W_LOW_CONFIDENCE", c.path, `physics input has confidence ${c.confidence}; replace with a sourced value`);
            }
        }
        return result(ctx);
    }

    /** @param {string} powertrain @param {string} segment */
    function classDefaultId(powertrain, segment) { return `class.${powertrain.replace(/_/g, "-")}.${segment}`; }

    // ------------------------------------------------------------------------
    // Lookup tables
    // ------------------------------------------------------------------------
    /**
     * @param {Ctx} ctx @param {unknown} table @param {string} name
     * @param {(row: Obj, path: string) => void} rowCheck @param {readonly string[]} rowRequired @param {readonly string[]} rowOptional
     */
    function lookupTable(ctx, table, name, rowCheck, rowRequired, rowOptional) {
        if (!isObj(table)) { err(ctx, "E_TYPE", "", "a lookup table must be a JSON object"); return; }
        const o = object(ctx, table, "", ["schema_version", "table", "sources", "rows"], ["$schema", "notes"]);
        if (!o) return;
        if (o.$schema !== undefined) string(ctx, o.$schema, "/$schema");
        const ver = string(ctx, o.schema_version, "/schema_version");
        if (ver && !SCHEMA_VERSION_RE.test(ver)) err(ctx, "E_VERSION", "/schema_version", `schema_version "${ver}" is not supported`);
        if (o.table !== name) err(ctx, "E_ENUM", "/table", `table must be "${name}"`);
        if (o.notes !== undefined) string(ctx, o.notes, "/notes");
        sources(ctx, o.sources, "/sources");
        if (!Array.isArray(o.rows) || o.rows.length === 0) { err(ctx, "E_TYPE", "/rows", "rows must be a non-empty array"); return; }
        const ids = new Set();
        o.rows.forEach((r, i) => {
            const p = at("/rows", i);
            const row = object(ctx, r, p, rowRequired, rowOptional);
            if (!row) return;
            if (typeof row.id === "string") {
                if (ids.has(row.id)) err(ctx, "E_DUPLICATE", at(p, "id"), `duplicate id "${row.id}"`);
                ids.add(row.id);
            }
            rowCheck(row, p);
        });
        for (const id of ctx.sources.keys()) if (!ctx.used.has(id)) warn(ctx, "W_UNUSED_SOURCE", "/sources", `source "${id}" is declared but never cited`);
    }

    /**
     * Validates data/lookups/fuel_grade.json.
     * @param {unknown} table @returns {Result}
     */
    function validateFuelGrades(table) {
        const ctx = newCtx();
        lookupTable(ctx, table, "fuel_grade", (row, p) => {
            const id = string(ctx, row.id, at(p, "id"), FUEL_GRADE_RE);
            string(ctx, row.label, at(p, "label"));
            const eth = quantity(ctx, row.ethanol_volume_fraction, at(p, "ethanol_volume_fraction"), SI_UNITS.ratio, LIMITS.ethanolFraction);
            quantity(ctx, row.ron_min, at(p, "ron_min"), SI_UNITS.ratio, LIMITS.ron);
            const lhvM = quantity(ctx, row.lhv_mass, at(p, "lhv_mass"), SI_UNITS.specific_energy, LIMITS.lhvMass);
            const rho = quantity(ctx, row.density, at(p, "density"), SI_UNITS.density, LIMITS.fuelDensity);
            const lhvV = quantity(ctx, row.lhv_volume, at(p, "lhv_volume"), SI_UNITS.energy_density, LIMITS.lhvVolume);
            if (row.standard !== undefined) string(ctx, row.standard, at(p, "standard"));
            if (row.notes !== undefined) string(ctx, row.notes, at(p, "notes"));
            if (id && eth && Math.abs(eth.v * 100 - Number(id.slice(1))) > 0.5) {
                err(ctx, "E_FUEL_GRADE", at(p, "ethanol_volume_fraction"), `${id} names ${id.slice(1)} % ethanol but the fraction is ${eth.v}`);
            }
            if (lhvM && rho && lhvV && Math.abs(lhvM.v * rho.v - lhvV.v) / lhvV.v > 0.01) {
                err(ctx, "E_FUEL_GRADE", at(p, "lhv_volume"), `lhv_volume ${fmt(lhvV.v)} J/m3 != lhv_mass x density ${fmt(lhvM.v * rho.v)} J/m3`);
            }
        }, ["id", "label", "ethanol_volume_fraction", "ron_min", "lhv_mass", "density", "lhv_volume"], ["standard", "notes"]);
        return result(ctx);
    }

    /**
     * Validates data/lookups/emission_standard.json.
     * @param {unknown} table @returns {Result}
     */
    function validateEmissionStandards(table) {
        const ctx = newCtx();
        lookupTable(ctx, table, "emission_standard", (row, p) => {
            string(ctx, row.id, at(p, "id"), EMISSION_ID_RE);
            string(ctx, row.label, at(p, "label"));
            const eff = fact(ctx, row.effective_from, at(p, "effective_from"), { re: DATE_RE });
            void eff;
            fact(ctx, row.test_cycle, at(p, "test_cycle"), { allowed: VOCAB.EMISSION_TEST_CYCLES });
            fact(ctx, row.obd_stage, at(p, "obd_stage"), { allowed: VOCAB.OBD_STAGES });
            if (row.notes !== undefined) string(ctx, row.notes, at(p, "notes"));
            if (row.limits !== undefined) {
                const lp = at(p, "limits");
                const lim = object(ctx, row.limits, lp, [], VOCAB.EMISSION_POLLUTANTS);
                if (lim) for (const k of Object.keys(lim)) quantity(ctx, lim[k], at(lp, k), SI_UNITS.emission, LIMITS.emission);
            }
        }, ["id", "label", "effective_from", "test_cycle", "obd_stage"], ["limits", "notes"]);
        return result(ctx);
    }

    // ------------------------------------------------------------------------
    // Catalog: cross-file rules
    // ------------------------------------------------------------------------
    /**
     * Rules that need every file at once: unique ids, a class default for
     * every powertrain x segment (so a search never comes back empty), fuel
     * grades and emission standards that exist, class-default references that
     * resolve, a certified fuel that meets the engine's minimum octane.
     * Run validateBundle on each bundle first; this assumes they are valid.
     * @param {{ bundles: Array<{ file?: string, bundle: any }>, fuelGrades: any, emissionStandards: any }} catalog
     * @returns {Result}
     */
    function validateCatalog(catalog) {
        const ctx = newCtx();
        /** @type {Map<string, string>} */
        const ids = new Map();
        /** @type {Map<string, any>} */
        const grades = new Map();
        for (const r of (catalog.fuelGrades && catalog.fuelGrades.rows) || []) grades.set(r.id, r);
        /** @type {Map<string, any>} */
        const standards = new Map();
        for (const r of (catalog.emissionStandards && catalog.emissionStandards.rows) || []) standards.set(r.id, r);
        const classIds = new Set();

        for (const { file, bundle: b } of catalog.bundles) {
            const where = file || (b && b.id) || "?";
            if (!isObj(b) || typeof b.id !== "string") { err(ctx, "E_CATALOG", where, "not a bundle"); continue; }
            if (ids.has(b.id)) err(ctx, "E_DUPLICATE", where, `id "${b.id}" is also used by ${ids.get(b.id)}`);
            ids.set(b.id, where);
            if (file) {
                const base = file.replace(/^.*[\\/]/, "").replace(/\.json$/, "");
                if (base !== b.id) err(ctx, "E_CATALOG", where, `file name must be the id: "${b.id}.json"`);
            }
            if (b.kind === "class_default") classIds.add(b.id);
        }

        for (const pt of POWERTRAINS) {
            for (const seg of SEGMENTS) {
                const id = classDefaultId(pt, seg);
                if (!classIds.has(id)) err(ctx, "E_CATALOG_COVERAGE", id, `no class default for ${pt} x ${seg}: a search for an unknown ${seg} would come back empty`);
            }
        }

        for (const { file, bundle: b } of catalog.bundles) {
            if (!isObj(b)) continue;
            const where = file || String(b.id);
            for (const s of Array.isArray(b.sources) ? b.sources : []) {
                if (s && s.kind === "class_default" && !classIds.has(s.class_ref)) {
                    err(ctx, "E_CATALOG_REF", where, `source "${s.id}" refers to class default "${s.class_ref}", which doesn't exist`);
                }
            }
            if (b.kind === "variant" && typeof b.powertrain === "string" && typeof b.segment === "string" && !classIds.has(classDefaultId(b.powertrain, b.segment))) {
                err(ctx, "E_CATALOG_REF", where, `no class default for its class ${b.powertrain} x ${b.segment}`);
            }
            const es = b.emission_standard;
            if (isObj(es) && typeof es.value === "string") {
                const std = standards.get(es.value);
                if (!std) err(ctx, "E_CATALOG_REF", where, `emission standard "${es.value}" is not in the emission_standard table`);
                else if (b.kind === "variant" && isObj(b.identity) && isObj(b.identity.model_years)) {
                    const to = b.identity.model_years.to;
                    const eff = isObj(std.effective_from) ? String(std.effective_from.value) : "";
                    if (typeof to === "number" && eff && to < Number(eff.slice(0, 4))) {
                        err(ctx, "E_CATALOG_REF", where, `model years end ${to}, before ${es.value} took effect (${eff})`);
                    }
                }
            }
            const f = isObj(b.fuel) ? b.fuel : null;
            if (!f || !Array.isArray(f.compatibility)) continue;
            let bestRon = -Infinity;
            for (const e of f.compatibility) {
                if (!isObj(e)) continue;
                const g = grades.get(String(e.grade));
                if (!g) { err(ctx, "E_CATALOG_REF", where, `fuel grade "${e.grade}" is not in the fuel_grade table`); continue; }
                if (e.status === "certified" && isObj(g.ron_min) && isNum(g.ron_min.value)) bestRon = Math.max(bestRon, g.ron_min.value);
            }
            if (isObj(f.min_ron) && isNum(f.min_ron.value) && bestRon !== -Infinity && bestRon < f.min_ron.value) {
                err(ctx, "E_FUEL_OCTANE", where, `the engine needs RON ${f.min_ron.value} but its best certified grade guarantees only RON ${bestRon}`);
            }
        }
        return result(ctx);
    }

    // Everything bundle.schema.json is generated from (scripts/build-bike-schema.mjs).
    const VOCAB = Object.freeze({
        KINDS, METHODS, SOURCE_KINDS, WEB_SOURCE_KINDS, CITED_SOURCE_KINDS, FUEL_STATUSES, MASS_BASES, ENUMS,
        BUNDLE_KEYS, EMISSION_TEST_CYCLES: ["IDC", "WMTC"], OBD_STAGES: ["none", "OBD-I", "OBD-II-A", "OBD-II-B"],
        EMISSION_POLLUTANTS: ["co", "thc", "nmhc", "nox", "hc_nox", "pm"],
        PATTERNS: Object.freeze({
            schemaVersion: SCHEMA_VERSION_RE.source, id: ID_RE.source, sourceId: SOURCE_ID_RE.source, date: DATE_RE.source,
            url: URL_RE.source, fuelGrade: FUEL_GRADE_RE.source, emissionId: EMISSION_ID_RE.source, market: MARKET_RE.source
        })
    });

    return Object.freeze({
        SCHEMA_VERSION, POWERTRAINS, SEGMENTS, SI_UNITS, LIMITS, PHYS, VOCAB,
        validateBundle, validateFuelGrades, validateEmissionStandards, validateCatalog,
        classDefaultId, parseTyreCode, decodeCurve
    });
});
