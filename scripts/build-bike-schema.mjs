#!/usr/bin/env node
/*
 * Writes the JSON Schemas for the bike database:
 *
 *   data/schema/bundle.schema.json            one bike profile bundle
 *   data/schema/fuel_grade.schema.json        the fuel_grade lookup table
 *   data/schema/emission_standard.schema.json the emission_standard lookup table
 *
 *   node scripts/build-bike-schema.mjs           (re)write them
 *   node scripts/build-bike-schema.mjs --check   exit 1 if a committed file is stale
 *
 * The schemas are generated from the validator's own vocabulary and physical
 * limits (public/js/bikedb/validate.js), so the two can't drift: the enums,
 * patterns and bounds below are read from it, never retyped. The schemas
 * carry everything JSON Schema 2020-12 can express — structure, SI unit per
 * field, provenance on every value, uncertainty on every estimate and prior,
 * fuel-certification rules. The physics cross-checks (redline above idle,
 * P <= T·ω, gearing vs top speed, ...) and source-reference resolution live
 * only in the validator; each schema's description says so.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const V = require(path.join(ROOT, "public/js/bikedb/validate.js"));
const { LIMITS: L, PHYS, SI_UNITS: U, VOCAB } = V;
const P = VOCAB.PATTERNS;

// --- building blocks --------------------------------------------------------
/** JSON Schema numeric keywords for a validator Bounds object. */
function bounds(b) {
    const s = { type: b.integer ? "integer" : "number" };
    if (b.gt !== undefined) s.exclusiveMinimum = b.gt;
    if (b.min !== undefined) s.minimum = b.min;
    if (b.max !== undefined) s.maximum = b.max;
    return s;
}
const ref = (name) => ({ $ref: `#/$defs/${name}` });
/** A scalar quantity in `unit` whose value obeys `b`. */
const q = (unit, b, description) => ({
    ...(description ? { description } : {}),
    type: "object",
    $ref: "#/$defs/quantity",
    properties: { unit: { const: unit }, value: bounds(b) }
});
/** A prior: a quantity that must carry an uncertainty. */
const prior = (unit, b, description) => ({ ...q(unit, b, description), required: ["uncertainty"] });
const fact = (values, description) => ({
    ...(description ? { description } : {}),
    type: "object",
    $ref: "#/$defs/fact",
    properties: { value: { enum: values } }
});
const factPattern = (pattern, description) => ({
    ...(description ? { description } : {}),
    type: "object",
    $ref: "#/$defs/fact",
    properties: { value: { type: "string", pattern } }
});
const obj = (required, properties, extra = {}) => ({ type: "object", required, properties, additionalProperties: false, ...extra });
const nonEmpty = { type: "string", minLength: 1, pattern: "\\S" };

const provenanceProps = {
    source: { type: "string", pattern: P.sourceId, description: "id of an entry in this file's sources" },
    confidence: { type: "number", minimum: 0, maximum: 1, description: "trust in this value, 0 (none) to 1 (certain)" },
    method: { enum: VOCAB.METHODS },
    published: { ...nonEmpty, description: "the published text verbatim, before SI conversion (required when method is published)" },
    note: nonEmpty
};
/** Provenance integrity rules shared by every value-carrying object. */
const provenanceRules = [
    { if: { properties: { method: { const: "published" } }, required: ["method"] }, then: { required: ["published"] } },
    { if: { properties: { method: { const: "estimated" } }, required: ["method"] }, then: { properties: { confidence: { type: "number", maximum: PHYS.estimateMaxConfidence } } } },
    { if: { properties: { method: { const: "class_default" } }, required: ["method"] }, then: { properties: { confidence: { type: "number", maximum: PHYS.classDefaultMaxConfidence } } } }
];
const needsUncertainty = { if: { properties: { method: { enum: ["estimated", "class_default"] } }, required: ["method"] }, then: { required: ["uncertainty"] } };

const commonDefs = {
    uncertainty: {
        description: "Spread of the value. normal: sd in the value's unit; lognormal: sigma of ln(value); uniform: hard interval in the value's unit.",
        oneOf: [
            obj(["dist", "sd"], { dist: { const: "normal" }, sd: { type: "number", exclusiveMinimum: 0 } }),
            obj(["dist", "sigma_ln"], { dist: { const: "lognormal" }, sigma_ln: { type: "number", exclusiveMinimum: 0, maximum: 3 } }),
            obj(["dist", "min", "max"], { dist: { const: "uniform" }, min: { type: "number" }, max: { type: "number" } })
        ]
    },
    uncertaintyArray: {
        description: "Per-element spread of a vector quantity.",
        oneOf: [
            obj(["dist", "sd"], { dist: { const: "normal" }, sd: { type: "number", exclusiveMinimum: 0 } }),
            obj(["dist", "sigma_ln"], { dist: { const: "lognormal" }, sigma_ln: { type: "number", exclusiveMinimum: 0, maximum: 3 } })
        ]
    },
    quantity: {
        description: "A number with its SI unit (UCUM code) and provenance. Each use site fixes the unit with a const.",
        ...obj(["value", "unit", "source", "confidence", "method"], {
            value: { type: "number" },
            unit: { type: "string" },
            ...provenanceProps,
            uncertainty: ref("uncertainty")
        }),
        allOf: [...provenanceRules, needsUncertainty]
    },
    quantityArray: {
        description: "Several numbers sharing one unit and one provenance (e.g. gear ratios).",
        ...obj(["values", "unit", "source", "confidence", "method"], {
            values: { type: "array", minItems: 1, items: { type: "number" } },
            unit: { type: "string" },
            ...provenanceProps,
            uncertainty: ref("uncertaintyArray")
        }),
        allOf: [...provenanceRules, needsUncertainty]
    },
    fact: {
        description: "A categorical, textual or boolean value with provenance.",
        ...obj(["value", "source", "confidence", "method"], { value: { type: ["string", "boolean"] }, ...provenanceProps }),
        allOf: provenanceRules
    },
    source: {
        description: "Where values came from. Web pages need url + accessed; documents need a citation; an engineering estimate states its rationale; a class_default source names the class-default bundle.",
        ...obj(["id", "kind", "title"], {
            id: { type: "string", pattern: P.sourceId },
            kind: { enum: VOCAB.SOURCE_KINDS },
            title: nonEmpty,
            publisher: nonEmpty,
            url: { type: "string", pattern: P.url },
            accessed: { type: "string", pattern: P.date },
            published_date: { type: "string", pattern: P.date },
            citation: nonEmpty,
            rationale: nonEmpty,
            class_ref: { type: "string", pattern: P.id },
            notes: nonEmpty
        }),
        allOf: [
            { if: { properties: { kind: { enum: VOCAB.WEB_SOURCE_KINDS } }, required: ["kind"] }, then: { required: ["url", "accessed"] } },
            { if: { properties: { kind: { enum: VOCAB.CITED_SOURCE_KINDS } }, required: ["kind"] }, then: { required: ["citation"] } },
            { if: { properties: { kind: { const: "engineering_estimate" } }, required: ["kind"] }, then: { required: ["rationale"] } },
            { if: { properties: { kind: { const: "class_default" } }, required: ["kind"] }, then: { required: ["class_ref"] } }
        ]
    },
    sources: { type: "array", minItems: 1, items: ref("source") }
};

const S = (title, id, description, body) => ({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    title,
    description,
    ...body
});
const write = [];

// --- bundle -----------------------------------------------------------------
{
    const E = VOCAB.ENUMS;
    const iceFuelGradeAboveE20 = "^E(2[1-9]|[3-9]\\d|100)$";
    const engine = obj(
        ["cycle", "cylinders", "aspiration", "cooling", "fuel_system", "displacement", "idle_speed", "redline_speed", "max_power", "max_torque"],
        {
            cycle: fact(E.engine_cycle),
            cylinders: q(U.ratio, L.cylinders),
            aspiration: fact(E.aspiration),
            cooling: fact(E.cooling),
            fuel_system: fact(E.fuel_system),
            displacement: q(U.volume, L.displacement, "swept volume, m3 (149.5 cc = 1.495e-4 m3)"),
            bore: q(U.length, L.boreStroke),
            stroke: q(U.length, L.boreStroke),
            compression_ratio: q(U.ratio, L.compressionRatio),
            idle_speed: q(U.angular_speed, L.idle, "rad/s (1 rpm = 2π/60 rad/s)"),
            redline_speed: q(U.angular_speed, L.engineSpeed),
            max_power: obj(["power", "speed"], { power: q(U.power, L.enginePower), speed: q(U.angular_speed, L.engineSpeed) }),
            max_torque: obj(["torque", "speed"], { torque: q(U.torque, L.engineTorque), speed: q(U.angular_speed, L.engineSpeed) })
        });
    const motor = obj(["type", "mounting", "rated_power", "peak_power", "peak_torque", "torque_reference"], {
        type: fact(E.motor_type),
        mounting: fact(E.motor_mounting),
        rated_power: q(U.power, L.motorPower, "continuous rating"),
        peak_power: q(U.power, L.motorPower),
        peak_torque: q(U.torque, L.motorTorque),
        torque_reference: fact(E.torque_reference, "where peak_torque is measured; a hub motor's is wheel torque"),
        max_speed: q(U.angular_speed, L.engineSpeed)
    }, { allOf: [{ if: { properties: { mounting: { properties: { value: { const: "hub" } } } } }, then: { properties: { torque_reference: { properties: { value: { const: "wheel" } } } } } }] });
    const battery = obj(["chemistry", "gross_energy", "usable_energy"], {
        chemistry: fact(E.battery_chemistry),
        gross_energy: q(U.energy, L.batteryEnergy, "J (1 kWh = 3.6e6 J)"),
        usable_energy: q(U.energy, L.batteryEnergy),
        nominal_voltage: q(U.voltage, L.voltage)
    });
    const manual = obj(["type", "gear_count", "primary_ratio", "gear_ratios", "final_drive"], {
        type: { const: "manual" },
        gear_count: q(U.ratio, L.gearCount),
        primary_ratio: q(U.ratio, L.primaryRatio),
        gear_ratios: { $ref: "#/$defs/quantityArray", properties: { unit: { const: U.ratio }, values: { items: bounds(L.gearRatio) } } },
        final_drive: obj(["type", "front_sprocket", "rear_sprocket"], {
            type: fact(E.final_drive),
            front_sprocket: q(U.ratio, L.sprocket, "teeth"),
            rear_sprocket: q(U.ratio, L.sprocket, "teeth")
        })
    });
    const cvt = obj(["type", "ratio_low", "ratio_high", "final_ratio", "engagement_speed"], {
        type: { const: "cvt" },
        ratio_low: q(U.ratio, L.cvtRatio, "variator ratio at launch"),
        ratio_high: q(U.ratio, L.cvtRatio, "variator ratio at full upshift"),
        final_ratio: q(U.ratio, L.cvtFinal, "fixed gear reduction after the variator"),
        engagement_speed: q(U.angular_speed, L.engagement, "centrifugal clutch engagement")
    });
    const direct = obj(["type", "drive", "reduction_ratio"], {
        type: { const: "direct" },
        drive: fact(E.ev_drive),
        reduction_ratio: q(U.ratio, L.evReduction, "motor to wheel; 1 for a hub motor")
    }, { allOf: [{ if: { properties: { drive: { properties: { value: { const: "hub" } } } } }, then: { properties: { reduction_ratio: { properties: { value: { const: 1 } } } } } }] });
    const tyre = factPattern("^(\\d{2,3}/\\d{2,3}\\s*-?\\s*(Z?R|B)?\\s*-?\\s*\\d{1,2}(?!\\d)|\\d{1,2}\\.\\d{2}\\s*(-|x|X)\\s*\\d{1,2}(?!\\d))", "tyre size code as moulded on the sidewall");
    const curveDef = (unit) => ({
        type: "object",
        required: ["unit", "axis", "scale", "encoding", "data", "source", "confidence", "method"],
        properties: {
            unit: { const: unit },
            axis: obj(["unit", "start", "step"], { unit: { const: U.angular_speed }, start: bounds(L.engineSpeed), step: { type: "number", exclusiveMinimum: 0 } }),
            scale: { type: "number", exclusiveMinimum: 0, description: "SI value = sample x scale + offset" },
            offset: { type: "number" },
            encoding: { enum: ["array", "u16le-base64"] },
            data: { description: "unsigned 16-bit samples: an array, or base64 of little-endian uint16 (the SQLite BLOB form)" },
            ...provenanceProps,
            uncertainty: ref("uncertaintyArray")
        },
        additionalProperties: false,
        allOf: [
            ...provenanceRules, needsUncertainty,
            { if: { properties: { encoding: { const: "array" } }, required: ["encoding"] }, then: { properties: { data: { type: "array", minItems: 4, items: { type: "integer", minimum: 0, maximum: 65535 } } } } },
            { if: { properties: { encoding: { const: "u16le-base64" } }, required: ["encoding"] }, then: { properties: { data: { type: "string", minLength: 12, pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" } } } }
        ]
    });
    const compat = obj(["grade", "status", "source", "confidence", "method"], {
        grade: { type: "string", pattern: P.fuelGrade, description: "E<n>: petrol with n % ethanol by volume; must exist in fuel_grade" },
        status: { enum: VOCAB.FUEL_STATUSES },
        ...provenanceProps
    }, {
        allOf: [
            ...provenanceRules,
            {
                description: "Fuel safety: only the manufacturer's published statement certifies a grade.",
                if: { properties: { status: { const: "certified" } }, required: ["status"] },
                then: { properties: { method: { const: "published" }, confidence: { type: "number", minimum: PHYS.certifyMinConfidence } } }
            }
        ]
    });
    const certifiedEntry = { type: "object", properties: { status: { const: "certified" } }, required: ["status"] };
    const fuelIce = {
        required: ["tank_capacity", "flex_fuel", "reference_grade"],
        properties: { required: { const: true } },
        if: { properties: { flex_fuel: { properties: { value: { const: false } } } } },
        $comment: "blends above E20 only on a flex-fuel engine",
        then: { properties: { compatibility: { not: { contains: { ...certifiedEntry, properties: { ...certifiedEntry.properties, grade: { pattern: iceFuelGradeAboveE20 } } } } } } }
    };
    const fuelEv = {
        properties: { required: { const: false }, compatibility: { items: { properties: { status: { not: { const: "certified" } } } } } },
        not: { anyOf: [{ required: ["tank_capacity"] }, { required: ["min_ron"] }, { required: ["flex_fuel"] }, { required: ["reference_grade"] }] }
    };
    const priorsIce = obj(["cda", "crr", "mass", "drivetrain_efficiency", "willans_efficiency", "friction_mep"], {
        cda: prior(U.area, L.cda, "drag area of bike + rider, m2 — never a bare Cd"),
        crr: prior(U.ratio, L.crr),
        mass: prior(U.mass, L.kerbMass, "vehicle mass the physics starts from (rider added in the app)"),
        drivetrain_efficiency: prior(U.ratio, L.efficiency, "crank to rear contact patch"),
        willans_efficiency: prior(U.ratio, { min: 0.1, max: 0.5 }, "Willans line: marginal brake power per unit fuel power"),
        friction_mep: prior(U.pressure, L.frictionMep, "Willans line offset as a mean effective pressure, Pa")
    });
    const priorsEv = obj(["cda", "crr", "mass", "drivetrain_efficiency"], {
        cda: prior(U.area, L.cda, "drag area of bike + rider, m2 — never a bare Cd"),
        crr: prior(U.ratio, L.crr),
        mass: prior(U.mass, L.kerbMass),
        drivetrain_efficiency: prior(U.ratio, L.efficiency, "battery to rear contact patch"),
        regen_efficiency: prior(U.ratio, { min: 0, max: 1 }),
        auxiliary_power: prior(U.power, L.auxPower)
    });
    const forbidden = { cd: false, drag_coefficient: false, frontal_area: false };

    const bundle = S("MapUnite bike profile bundle",
        "urn:mapunite:schema:bike-bundle:1",
        "One bike variant (kind=variant) or one powertrain x segment fallback (kind=class_default). All quantities are SI (UCUM unit codes) and carry provenance and confidence. " +
        "Structure only: physics cross-checks and source-id resolution are enforced by public/js/bikedb/validate.js. Generated by scripts/build-bike-schema.mjs — do not edit by hand.",
        {
            type: "object",
            required: VOCAB.BUNDLE_KEYS.required,
            properties: {
                $schema: { type: "string" },
                schema_version: { type: "string", pattern: P.schemaVersion },
                id: { type: "string", pattern: P.id },
                kind: { enum: VOCAB.KINDS },
                powertrain: { enum: V.POWERTRAINS },
                segment: { enum: V.SEGMENTS },
                identity: obj(["make", "model", "variant", "market", "model_years"], {
                    make: nonEmpty, model: nonEmpty, variant: nonEmpty,
                    market: { type: "string", pattern: P.market },
                    model_years: obj(["from", "to"], {
                        from: { type: "integer", minimum: 1950, maximum: 2100 },
                        to: { type: ["integer", "null"], minimum: 1950, maximum: 2100 }
                    }),
                    aliases: { type: "array", items: nonEmpty }
                }),
                class_default: obj(["label", "basis"], { label: nonEmpty, basis: nonEmpty }),
                sources: ref("sources"),
                emission_standard: { oneOf: [{ type: "null" }, factPattern(P.emissionId)] },
                engine,
                motor,
                battery,
                transmission: { oneOf: [manual, cvt, direct] },
                wheels: obj(["front_tyre", "rear_tyre", "rear_rolling_radius"], {
                    front_tyre: tyre, rear_tyre: tyre,
                    rear_rolling_radius: q(U.length, L.rollingRadius, "loaded rolling radius, m")
                }),
                mass: obj(["kerb", "basis"], { kerb: q(U.mass, L.kerbMass), basis: { enum: VOCAB.MASS_BASES } }),
                fuel: obj(["required", "compatibility"], {
                    required: { type: "boolean" },
                    tank_capacity: q(U.volume, L.tank, "m3 (10 L = 0.01 m3)"),
                    min_ron: q(U.ratio, L.minRon),
                    flex_fuel: { $ref: "#/$defs/fact", properties: { value: { type: "boolean" } } },
                    reference_grade: factPattern(P.fuelGrade, "the grade the energy figures assume; on a variant it must be certified"),
                    compatibility: { type: "array", items: compat }
                }),
                priors: { type: "object" },
                performance: obj([], {
                    top_speed: q(U.speed, L.topSpeed, "m/s (100 km/h = 27.78 m/s)"),
                    certified_range: obj(["distance", "cycle"], { distance: q(U.length, L.range), cycle: fact(E.range_cycle) })
                }),
                curves: obj([], { torque: curveDef(U.torque), power: curveDef(U.power) }),
                record: obj(["created", "updated", "review_status"], {
                    created: { type: "string", pattern: P.date },
                    updated: { type: "string", pattern: P.date },
                    review_status: { enum: ["unreviewed", "reviewed"] },
                    reviewed_by: nonEmpty
                }, { if: { properties: { review_status: { const: "reviewed" } } }, then: { required: ["reviewed_by"] } }),
                notes: nonEmpty,
                ...forbidden
            },
            additionalProperties: false,
            allOf: [
                {
                    if: { properties: { kind: { const: "variant" } } },
                    then: { required: ["identity"], not: { required: ["class_default"] } },
                    else: { required: ["class_default"], not: { required: ["identity"] } }
                },
                {
                    if: { properties: { powertrain: { enum: ["ice_manual", "ice_cvt"] } } },
                    then: {
                        required: ["engine"],
                        properties: {
                            motor: false, battery: false,
                            emission_standard: { type: "object" },
                            fuel: fuelIce,
                            priors: priorsIce,
                            performance: { properties: { certified_range: false } }
                        }
                    },
                    else: {
                        required: ["motor", "battery"],
                        properties: { engine: false, curves: false, emission_standard: { type: "null" }, fuel: fuelEv, priors: priorsEv }
                    }
                },
                {
                    description: "Fuel safety: a variant engine is certified for at least one grade; a class default certifies none.",
                    if: { properties: { powertrain: { enum: ["ice_manual", "ice_cvt"] }, kind: { const: "variant" } } },
                    then: { properties: { fuel: { properties: { compatibility: { contains: certifiedEntry } } } } }
                },
                {
                    if: { properties: { kind: { const: "class_default" } } },
                    then: { properties: { fuel: { properties: { compatibility: { items: { properties: { status: { not: { const: "certified" } } } } } } } } }
                },
                { if: { properties: { powertrain: { const: "ice_manual" } } }, then: { properties: { transmission: { properties: { type: { const: "manual" } } } } } },
                { if: { properties: { powertrain: { const: "ice_cvt" } } }, then: { properties: { transmission: { properties: { type: { const: "cvt" } } } } } },
                { if: { properties: { powertrain: { const: "ev" } } }, then: { properties: { transmission: { properties: { type: { const: "direct" } } } } } }
            ],
            $defs: commonDefs
        });
    write.push(["data/schema/bundle.schema.json", bundle]);
}

// --- lookup tables ----------------------------------------------------------
const table = (name, id, description, rowRequired, rowProps) => S(`MapUnite ${name} table`, id, description, {
    ...obj(["schema_version", "table", "sources", "rows"], {
        $schema: { type: "string" },
        schema_version: { type: "string", pattern: P.schemaVersion },
        table: { const: name },
        sources: ref("sources"),
        rows: { type: "array", minItems: 1, items: obj(rowRequired, rowProps) },
        notes: nonEmpty
    }),
    $defs: commonDefs
});
write.push(["data/schema/fuel_grade.schema.json", table("fuel_grade", "urn:mapunite:schema:fuel-grade:1",
    "Petrol-ethanol grades: E<n> holds n % ethanol by volume. lhv_volume must equal lhv_mass x density (checked by the validator). Generated by scripts/build-bike-schema.mjs — do not edit by hand.",
    ["id", "label", "ethanol_volume_fraction", "ron_min", "lhv_mass", "density", "lhv_volume"],
    {
        id: { type: "string", pattern: P.fuelGrade },
        label: nonEmpty,
        ethanol_volume_fraction: q(U.ratio, L.ethanolFraction),
        ron_min: q(U.ratio, L.ron),
        lhv_mass: q(U.specific_energy, L.lhvMass, "lower heating value, J/kg"),
        density: q(U.density, L.fuelDensity, "kg/m3 at 15 °C"),
        lhv_volume: q(U.energy_density, L.lhvVolume, "lower heating value, J/m3"),
        standard: nonEmpty,
        notes: nonEmpty
    })]);
write.push(["data/schema/emission_standard.schema.json", table("emission_standard", "urn:mapunite:schema:emission-standard:1",
    "Indian two-wheeler emission stages. Limits in kg/m (1 g/km = 1e-6 kg/m). Generated by scripts/build-bike-schema.mjs — do not edit by hand.",
    ["id", "label", "effective_from", "test_cycle", "obd_stage"],
    {
        id: { type: "string", pattern: P.emissionId },
        label: nonEmpty,
        effective_from: factPattern(P.date, "first date of manufacture/registration the stage applies to"),
        test_cycle: fact(VOCAB.EMISSION_TEST_CYCLES),
        obd_stage: fact(VOCAB.OBD_STAGES),
        limits: obj([], Object.fromEntries(VOCAB.EMISSION_POLLUTANTS.map((k) => [k, q(U.emission, L.emission)]))),
        notes: nonEmpty
    })]);

// --- write / check ----------------------------------------------------------
const check = process.argv.includes("--check");
let stale = 0;
for (const [rel, schema] of write) {
    const file = path.join(ROOT, rel);
    const text = JSON.stringify(schema, null, 2) + "\n";
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (current === text) continue;
    if (check) { console.error(`build-bike-schema: ${rel} is out of date — run node scripts/build-bike-schema.mjs`); stale++; continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`wrote ${rel}`);
}
process.exit(stale ? 1 : 0);
