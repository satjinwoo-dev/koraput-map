"use strict";

/* ============================================================================
   Broken-bundle corpus for the bike validator tests
   ==============================================================================
   Each case starts from a real seed file, breaks exactly one thing, and names
   the error code the validator must report. `structural: true` marks breakage
   that JSON Schema can express too: schema-agreement.test.js checks that
   bundle.schema.json rejects those as well (and that the validator rejects
   everything the schema rejects).
   ============================================================================ */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const RPM = (2 * Math.PI) / 60;

/** @param {string} rel @returns {any} */
function load(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")); }

const MT15 = "data/bikes/yamaha.mt-15-v2.2023.json";
const ACTIVA = "data/bikes/honda.activa-6g.2023.json";
const IQUBE = "data/bikes/tvs.iqube-3-4kwh.2024.json";
const CLASS_COMMUTER = "data/class-defaults/class.ice-manual.commuter.json";

const grade = (b, g) => b.fuel.compatibility.find((e) => e.grade === g);
const published = (value, unit, text) => ({ value, unit, source: "91w-mt15", confidence: 0.8, method: "published", published: text });

/** @type {Array<{ name: string, base: string, mutate: (b: any) => void, code: string, structural: boolean }>} */
const mutations = [
    // --- SI units ---
    { name: "engine speed in rpm", base: MT15, code: "E_UNIT", structural: true, mutate: (b) => { b.engine.redline_speed.unit = "rpm"; b.engine.redline_speed.value = 11500; } },
    { name: "power in kW", base: MT15, code: "E_UNIT", structural: true, mutate: (b) => { b.engine.max_power.power.unit = "kW"; b.engine.max_power.power.value = 13.5; } },
    { name: "displacement in cc", base: MT15, code: "E_UNIT", structural: true, mutate: (b) => { b.engine.displacement.unit = "cc"; b.engine.displacement.value = 155; } },
    { name: "top speed in km/h", base: MT15, code: "E_UNIT", structural: true, mutate: (b) => { b.performance = { top_speed: published(130, "km/h", "130 km/h") }; } },
    { name: "tank in litres", base: MT15, code: "E_UNIT", structural: true, mutate: (b) => { b.fuel.tank_capacity.unit = "L"; b.fuel.tank_capacity.value = 10; } },
    { name: "battery in kWh", base: IQUBE, code: "E_UNIT", structural: true, mutate: (b) => { b.battery.gross_energy.unit = "kWh"; b.battery.gross_energy.value = 3.4; } },
    { name: "unit missing", base: MT15, code: "E_REQUIRED", structural: true, mutate: (b) => { delete b.mass.kerb.unit; } },

    // --- provenance and confidence ---
    { name: "value without a source", base: MT15, code: "E_REQUIRED", structural: true, mutate: (b) => { delete b.engine.displacement.source; } },
    { name: "source not declared", base: MT15, code: "E_PROVENANCE", structural: false, mutate: (b) => { b.engine.displacement.source = "nowhere"; } },
    { name: "value without confidence", base: MT15, code: "E_REQUIRED", structural: true, mutate: (b) => { delete b.mass.kerb.confidence; } },
    { name: "confidence above 1", base: MT15, code: "E_CONFIDENCE", structural: true, mutate: (b) => { b.mass.kerb.confidence = 1.2; } },
    { name: "negative confidence", base: MT15, code: "E_CONFIDENCE", structural: true, mutate: (b) => { b.mass.kerb.confidence = -0.1; } },
    { name: "value without method", base: MT15, code: "E_REQUIRED", structural: true, mutate: (b) => { delete b.mass.kerb.method; } },
    { name: "fact without provenance", base: MT15, code: "E_REQUIRED", structural: true, mutate: (b) => { b.engine.cooling = { value: "liquid" }; } },
    { name: "published value without the published text", base: MT15, code: "E_PROVENANCE", structural: true, mutate: (b) => { delete b.engine.displacement.published; } },
    { name: "estimate without uncertainty", base: MT15, code: "E_UNCERTAINTY", structural: true, mutate: (b) => { delete b.engine.idle_speed.uncertainty; } },
    { name: "estimate claiming high confidence", base: MT15, code: "E_CONFIDENCE", structural: true, mutate: (b) => { b.engine.idle_speed.confidence = 0.9; } },
    { name: "prior without uncertainty", base: MT15, code: "E_UNCERTAINTY", structural: true, mutate: (b) => { delete b.priors.mass.uncertainty; } },
    { name: "no sources at all", base: MT15, code: "E_PROVENANCE", structural: true, mutate: (b) => { b.sources = []; } },
    { name: "web source without URL", base: MT15, code: "E_PROVENANCE", structural: true, mutate: (b) => { delete b.sources[0].url; } },
    { name: "engineering estimate without rationale", base: MT15, code: "E_PROVENANCE", structural: true, mutate: (b) => { delete b.sources.find((s) => s.kind === "engineering_estimate").rationale; } },
    { name: "published value citing an engineering estimate", base: MT15, code: "E_PROVENANCE", structural: false, mutate: (b) => { b.engine.displacement.source = "mu-estimate"; } },
    { name: "duplicate source id", base: MT15, code: "E_DUPLICATE", structural: false, mutate: (b) => { b.sources.push({ ...b.sources[0] }); } },
    { name: "uniform interval excluding its value", base: MT15, code: "E_RANGE", structural: false, mutate: (b) => { b.mass.kerb.uncertainty = { dist: "uniform", min: 150, max: 160 }; } },

    // --- impossible values ---
    { name: "negative mass", base: MT15, code: "E_RANGE", structural: true, mutate: (b) => { b.mass.kerb.value = -141; } },
    { name: "zero mass", base: MT15, code: "E_RANGE", structural: true, mutate: (b) => { b.mass.kerb.value = 0; } },
    { name: "negative displacement", base: MT15, code: "E_RANGE", structural: true, mutate: (b) => { b.engine.displacement.value = -1.55e-4; } },
    { name: "redline below idle", base: MT15, code: "E_PHYSICS_IDLE_REDLINE", structural: false, mutate: (b) => { b.engine.redline_speed.value = b.engine.idle_speed.value - 10; } },
    { name: "peak power beyond redline", base: MT15, code: "E_PHYSICS_PEAK_ORDER", structural: false, mutate: (b) => { b.engine.max_power.speed.value = 12500 * RPM; } },
    { name: "peak power above peak torque x speed", base: MT15, code: "E_PHYSICS_POWER_TORQUE", structural: false, mutate: (b) => { b.engine.max_power.power.value = 20000; } },
    { name: "torque peak after power peak", base: MT15, code: "E_PHYSICS_PEAK_ORDER", structural: false, mutate: (b) => { b.engine.max_torque.speed.value = 10500 * RPM; } },
    { name: "bore x stroke contradict displacement", base: MT15, code: "E_PHYSICS_DISPLACEMENT", structural: false, mutate: (b) => { b.engine.stroke.value = 0.07; } },
    { name: "impossible BMEP", base: MT15, code: "E_PHYSICS_BMEP", structural: false, mutate: (b) => { b.engine.max_torque.torque.value = 40; } },
    { name: "impossible piston speed", base: MT15, code: "E_PHYSICS_PISTON_SPEED", structural: false, mutate: (b) => { b.engine.redline_speed.value = 15000 * RPM; } },
    { name: "gear ratios not decreasing", base: MT15, code: "E_PHYSICS_GEARS", structural: false, mutate: (b) => { const g = b.transmission.gear_ratios.values; [g[1], g[2]] = [g[2], g[1]]; } },
    { name: "gear count contradicts ratios", base: MT15, code: "E_PHYSICS_GEARS", structural: false, mutate: (b) => { b.transmission.gear_count.value = 5; } },
    { name: "rear sprocket smaller than front", base: MT15, code: "E_PHYSICS_GEARS", structural: false, mutate: (b) => { b.transmission.final_drive.rear_sprocket.value = 12; } },
    {
        name: "top speed beyond gearing", base: MT15, code: "E_PHYSICS_TOP_SPEED", structural: false, mutate: (b) => {
            b.engine.redline_speed = published(11500 * RPM, "rad/s", "red zone from 11500 r/min");
            b.performance = { top_speed: published(250 / 3.6, "m/s", "250 km/h") };
        }
    },
    { name: "CVT low ratio below high ratio", base: ACTIVA, code: "E_PHYSICS_CVT", structural: false, mutate: (b) => { b.transmission.ratio_low.value = 0.5; } },
    { name: "mass prior far from kerb mass", base: MT15, code: "E_PHYSICS_MASS_PRIOR", structural: false, mutate: (b) => { b.priors.mass.value = 300; } },
    { name: "rolling radius that doesn't fit the tyre", base: MT15, code: "E_PHYSICS_TYRE", structural: false, mutate: (b) => { b.wheels.rear_rolling_radius.value = 0.2; } },
    { name: "unreadable tyre code", base: MT15, code: "E_FORMAT", structural: true, mutate: (b) => { b.wheels.rear_tyre.value = "fat one"; } },
    { name: "EV usable energy above gross", base: IQUBE, code: "E_PHYSICS_EV_ENERGY", structural: false, mutate: (b) => { b.battery.usable_energy.value = b.battery.gross_energy.value * 1.2; } },
    { name: "EV rated power above peak", base: IQUBE, code: "E_PHYSICS_EV_POWER", structural: false, mutate: (b) => { b.motor.rated_power.value = 6000; } },
    { name: "EV range beyond the rolling-resistance floor", base: IQUBE, code: "E_PHYSICS_EV_RANGE", structural: false, mutate: (b) => { b.performance.certified_range.distance.value = 999e3; } },
    { name: "hub motor with a reduction", base: IQUBE, code: "E_PHYSICS_EV_HUB", structural: true, mutate: (b) => { b.transmission.reduction_ratio.value = 5; } },

    // --- fuel safety ---
    { name: "engine certified for no fuel", base: MT15, code: "E_FUEL_NONE", structural: true, mutate: (b) => { for (const e of b.fuel.compatibility) { e.status = "not_certified"; e.method = "derived"; delete e.published; } } },
    { name: "engine with empty fuel list", base: MT15, code: "E_FUEL_NONE", structural: true, mutate: (b) => { b.fuel.compatibility = []; } },
    { name: "E85 certified on a non-flex engine", base: MT15, code: "E_FUEL_FLEX", structural: true, mutate: (b) => { Object.assign(grade(b, "E85"), { status: "certified", method: "published", published: "E85 ok", confidence: 0.8 }); } },
    { name: "E100 certified on a non-flex engine", base: ACTIVA, code: "E_FUEL_FLEX", structural: true, mutate: (b) => { Object.assign(grade(b, "E100"), { status: "certified", method: "published", published: "E100 ok", confidence: 0.8 }); } },
    { name: "certification that is only an estimate", base: MT15, code: "E_FUEL_CERTIFICATION", structural: true, mutate: (b) => { const e = grade(b, "E20"); e.method = "estimated"; e.confidence = 0.5; delete e.published; } },
    { name: "certification below the confidence floor", base: MT15, code: "E_FUEL_CERTIFICATION", structural: true, mutate: (b) => { grade(b, "E20").confidence = 0.5; } },
    { name: "class default certifying a fuel", base: CLASS_COMMUTER, code: "E_FUEL_CERTIFICATION", structural: true, mutate: (b) => { Object.assign(b.fuel.compatibility[2], { status: "certified", method: "published", published: "E20", confidence: 0.8 }); } },
    { name: "physics assuming an uncertified fuel", base: MT15, code: "E_FUEL_REFERENCE", structural: false, mutate: (b) => { b.fuel.reference_grade.value = "E10"; } },
    { name: "engine that says it needs no fuel", base: MT15, code: "E_FUEL_REQUIRED", structural: true, mutate: (b) => { b.fuel.required = false; } },
    { name: "EV certified for petrol", base: IQUBE, code: "E_FUEL_EV", structural: true, mutate: (b) => { b.fuel.compatibility.push({ grade: "E20", status: "certified", source: "tvs-iqube-spec", confidence: 0.8, method: "published", published: "E20" }); } },
    { name: "EV with a fuel tank", base: IQUBE, code: "E_FUEL_EV", structural: true, mutate: (b) => { b.fuel.tank_capacity = { value: 0.005, unit: "m3", source: "tvs-iqube-spec", confidence: 0.8, method: "published", published: "5 L" }; } },
    { name: "fuel grade that isn't a blend code", base: MT15, code: "E_FORMAT", structural: true, mutate: (b) => { grade(b, "E0").grade = "Premium"; } },

    // --- drag ---
    { name: "exact Cd instead of a CdA prior", base: MT15, code: "E_FORBIDDEN_FIELD", structural: true, mutate: (b) => { b.priors.cd = { value: 0.6, unit: "1", source: "class-default", confidence: 0.4, method: "class_default", uncertainty: { dist: "normal", sd: 0.1 } }; } },
    { name: "CdA in the wrong unit", base: MT15, code: "E_UNIT", structural: true, mutate: (b) => { b.priors.cda.unit = "1"; } },

    // --- shape ---
    { name: "unknown field", base: MT15, code: "E_UNKNOWN_FIELD", structural: true, mutate: (b) => { b.engine.turbo_boost = 1; } },
    { name: "unsupported schema version", base: MT15, code: "E_VERSION", structural: true, mutate: (b) => { b.schema_version = "2.0.0"; } },
    { name: "variant without identity", base: MT15, code: "E_REQUIRED", structural: true, mutate: (b) => { delete b.identity; } },
    { name: "class default with a vehicle identity", base: CLASS_COMMUTER, code: "E_KIND", structural: true, mutate: (b) => { b.identity = { make: "X", model: "Y", variant: "Z", market: "IN", model_years: { from: 2024, to: null } }; } },
    { name: "class default with a wrong id", base: CLASS_COMMUTER, code: "E_FORMAT", structural: false, mutate: (b) => { b.id = "class.commuter"; } },
    { name: "EV with an engine", base: IQUBE, code: "E_POWERTRAIN_MISMATCH", structural: true, mutate: (b) => { b.engine = load(MT15).engine; } },
    { name: "EV with an emission standard", base: IQUBE, code: "E_POWERTRAIN_MISMATCH", structural: true, mutate: (b) => { b.emission_standard = { value: "BS6-P2", source: "tvs-iqube-spec", confidence: 0.8, method: "derived" }; } },
    { name: "manual bike with a CVT", base: MT15, code: "E_POWERTRAIN_MISMATCH", structural: true, mutate: (b) => { b.transmission = load(ACTIVA).transmission; } },
    { name: "engine without an emission standard", base: MT15, code: "E_REQUIRED", structural: true, mutate: (b) => { b.emission_standard = null; } },
    { name: "bad date", base: MT15, code: "E_FORMAT", structural: true, mutate: (b) => { b.record.created = "03/10/2026"; } }
];

module.exports = { ROOT, RPM, load, mutations, MT15, ACTIVA, IQUBE, CLASS_COMMUTER };
