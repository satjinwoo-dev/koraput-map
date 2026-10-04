#!/usr/bin/env node
/*
 * Print a bike's cruise table in everyday units, for reviewing the physics.
 * (The physics itself is strict SI; this script converts only for display.)
 *
 *   node scripts/physics/cruise-table.mjs royal-enfield-hunter-350-metro-in
 *   node scripts/physics/cruise-table.mjs tvs-iqube-3-5kwh-in --grade 0.04 --altitude 900 --temp 35 --rider 80
 *   node scripts/physics/cruise-table.mjs --list
 * Options: --grade <rise/run>  --altitude <m>  --temp <°C>  --rh <0–1>  --wind <m/s headwind>
 *          --rider <kg>  --pillion <kg>  --fuel <E10|E20…>  --step <km/h>
 */
import { createRequire } from "node:module";
import { buildArtifacts } from "../bikedb/catalog-build.mjs";
import { loadCatalog } from "../bikedb/load-catalog.mjs";

const require = createRequire(import.meta.url);
const Physics = require("../../public/js/physics/index.js");

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const num = (name) => { const v = opt(name); if (v === undefined) return undefined; const n = Number(v); if (!Number.isFinite(n)) { console.error(`${name} needs a number`); process.exit(2); } return n; };

const bundles = buildArtifacts(loadCatalog()).bundles.map((b) => b.runtime);
if (argv.includes("--list") || !argv[0] || argv[0].startsWith("--")) {
    console.log(bundles.map((b) => `${b.id}  (${b.powertrain})`).join("\n"));
    process.exit(argv.includes("--list") ? 0 : 2);
}
const bundle = bundles.find((b) => b.id === argv[0]);
if (!bundle) { console.error(`no bike "${argv[0]}" — try --list`); process.exit(2); }
const classDefault = bundles.find((b) => b.kind === "class_default" && b.classKey === bundle.classKey);
const settings = {};
if (num("--rider") !== undefined) settings.riderMass = num("--rider");
if (num("--pillion") !== undefined) settings.pillionMass = num("--pillion");
if (opt("--fuel")) settings.fuelCode = opt("--fuel");
const model = Physics.createBikeModel(bundle, { classDefault: bundle.kind === "variant" ? classDefault : undefined, settings });
const env = {
    grade: num("--grade") ?? 0,
    altitude: num("--altitude") ?? 0,
    temperature: (num("--temp") ?? 30) + 273.15,
    relativeHumidity: num("--rh") ?? 0.5,
    wind: num("--wind") ?? 0
};
const step = (num("--step") ?? 5) / 3.6;
const t0 = performance.now();
const t = Physics.cruiseTable(model, env, { step });
const ms = performance.now() - t0;

const ice = model.powertrain !== "ev";
console.log(`${model.title}  [${model.powertrain}]  ρ = ${t.env.rho.toFixed(3)} kg/m3, grade ${(env.grade * 100).toFixed(1)} %`);
if (model.flags.length) console.log(`  notes: ${model.flags.join("; ")}`);
console.log(ice ? "  km/h  gear    rpm   wheel kW      km/L  (±1σ range)" : "  km/h    wheel kW     Wh/km  (±1σ range)        range km");
for (let i = 1; i < t.speed.length; i++) {
    const kmh = (t.speed[i] * 3.6).toFixed(0).padStart(5);
    const kw = (t.wheelPower[i] / 1000).toFixed(2).padStart(9);
    const flag = t.feasible[i] ? "" : "  (can't hold this speed)";
    if (ice) {
        const kml = (x) => (x > 0 ? (1 / (x * 1e6)).toFixed(1) : "∞");
        const gear = model.drive.kind === "manual" ? String(t.gear[i]).padStart(4) : " CVT";
        console.log(`${kmh}  ${gear}  ${(t.omega[i] * 30 / Math.PI).toFixed(0).padStart(5)}  ${kw}  ${kml(t.perMetre[i]).padStart(8)}  (${kml(t.perMetreHi[i])}–${kml(t.perMetreLo[i])})${flag}`);
    } else {
        const wh = (x) => (x * 1000 / 3600).toFixed(1);
        const km = (x) => (Number.isFinite(x) ? (x / 1000).toFixed(0) : "∞");
        console.log(`${kmh}  ${kw}  ${wh(t.perMetre[i]).padStart(8)}  (${wh(t.perMetreLo[i])}–${wh(t.perMetreHi[i])})  ${km(t.range[i]).padStart(8)} (${km(t.rangeLo[i])}–${km(t.rangeHi[i])})${flag}`);
    }
}
if (t.contributions.length) console.log(`±1σ driven by: ${t.contributions.slice(0, 4).map((c) => `${c.param} ${(c.relative * 100).toFixed(1)} %`).join(", ")}`);
if (t.eco) console.log(`eco band ${(t.eco.speedLow * 3.6).toFixed(0)}–${(t.eco.speedHigh * 3.6).toFixed(0)} km/h (best ${(t.eco.speedBest * 3.6).toFixed(0)} km/h)`);
const sp = Physics.shiftPoints(model, env, { diagnostic: true });   // review tool: computed even when riders get no advice
if (sp) {
    console.log(`shift points${sp.advisory ? "" : ` (diagnostic only — riders get no gear advice: ${model.gearAdviceReason})`}:`);
    for (let i = 0; i < sp.ecoUp.length; i++) {
        const e = sp.ecoUp[i], p = sp.perfUp[i];
        console.log(`  ${e.from}→${e.to}: economy at ${(e.speed * 3.6).toFixed(0)} km/h (${(e.omegaFrom * 30 / Math.PI).toFixed(0)} rpm)${e.atRedline ? " [redline]" : ""}; full throttle at ${(p.speed * 3.6).toFixed(0)} km/h (${(p.omegaFrom * 30 / Math.PI).toFixed(0)} rpm)${p.atRedline ? " [redline]" : ""}`);
    }
}
console.log(`max speed ${(Physics.maxSpeed(model, env) * 3.6).toFixed(0)} km/h${model.topSpeed ? ` (published ${(model.topSpeed * 3.6).toFixed(0)})` : ""}; table computed in ${ms.toFixed(2)} ms`);
