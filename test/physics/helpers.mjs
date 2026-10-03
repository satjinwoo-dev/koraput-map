// Shared fixtures for the physics tests: the real catalogue as runtime (SI) bundles,
// a hand-built bike with round numbers for known-answer tests, and a seeded PRNG.
import { createRequire } from "node:module";
import { buildArtifacts } from "../../scripts/bikedb/catalog-build.mjs";
import { loadCatalog } from "../../scripts/bikedb/load-catalog.mjs";

const require = createRequire(import.meta.url);
/** @type {typeof import("../../public/js/physics/index.js")} */
export const Physics = require("../../public/js/physics/index.js");
export const Contract = require("../../public/js/bikedb/bundle-contract.js");

const art = buildArtifacts(loadCatalog());
/** Runtime bundles exactly as shipped (strict SI). */
export const bundles = art.bundles.map((b) => b.runtime);
export const bundleById = new Map(bundles.map((b) => [b.id, b]));
export const classDefaultOf = (b) => bundles.find((x) => x.kind === "class_default" && x.classKey === b.classKey);
/** A model for every bike and class default in the catalogue. */
export const models = bundles.map((b) => Physics.createBikeModel(b, { classDefault: b.kind === "variant" ? classDefaultOf(b) : undefined }));
export const modelById = new Map(models.map((m) => [m.id, m]));

/** mulberry32: deterministic random numbers, same on every machine. */
export function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
export const between = (rnd, lo, hi) => lo + (hi - lo) * rnd();

export const RPM = Math.PI / 30;        // rad/s per rpm (for writing test inputs readably)
export const KMH = 1 / 3.6;             // m/s per km/h

/**
 * A runtime bundle with round numbers, so whole-chain results can be worked out by hand.
 * Vehicle 100 kg + rider prior 80 kg; tyre 2.75-18; gears 3/2/1.5/1.2/1.0, primary 3, final 3;
 * 150 cm3 4-stroke, idle 100 rad/s, 15 N·m at 500 rad/s, 10 kW at 800 rad/s; FMEP = 100 kPa flat;
 * η_ind 0.30, η_dt 0.90, CdA 0.5 m2, Crr 0.02; E20 at 3.014e10 J/m3.
 * @param {Partial<{ fuelSystem: string, strokes: number, kind: string }>} [o]
 */
export function handBike(o = {}) {
    const q = (v, u, extra = {}) => ({ v, u, src: "hand", conf: 0.9, ...extra });
    const c = (v) => ({ v, src: "hand", conf: 0.9 });
    const p = (mean, sigma, u) => ({ mean, sigma, u, src: "hand", conf: 0.5 });
    return {
        format: "mapunite-bike-bundle/1", units: "SI", schemaVersion: "1.0.0", id: "hand-bike", kind: o.kind || "variant",
        classKey: "ice_manual.commuter", segment: "commuter", powertrain: "ice_manual", image_url: null,
        identity: { make: "Test", model: "Hand", variant: "Round numbers", market: "IN", yearFrom: 2025, yearTo: null, aliases: [] },
        sources: [{ id: "hand", kind: "derived", title: "hand-calculated test values", retrieved: "2026-10-03", note: "round numbers for known-answer tests" }],
        engine: {
            displacement: q(1.5e-4, "m3"), cylinders: q(1, "1"), strokes: q(o.strokes || 4, "1"), bore: q(0.057, "m"), stroke: q(0.0588, "m"),
            cooling: c("air"), fuelSystem: c(o.fuelSystem || "fi"),
            peakPower: q(10000, "W"), peakPowerRpm: q(800, "rad/s"), peakTorque: q(15, "N*m"), peakTorqueRpm: q(500, "rad/s"), idleRpm: q(100, "rad/s")
        },
        transmission: { kind: c("manual"), speeds: q(5, "1"), primaryRatio: q(3, "1"), gearRatios: q([3, 2, 1.5, 1.2, 1.0], "1"), finalRatio: q(3, "1"), drive: c("chain") },
        chassis: { mass: q(100, "kg", { basis: "kerb" }), fuelTank: q(0.01, "m3"), frontTyre: c("2.75-18"), rearTyre: c("2.75-18") },
        emission: { standard: c("BS6-P2") },
        fuel: { compat: [{ fuel: "E20", status: "certified", src: "hand", conf: 0.9 }] },
        priors: {
            cda: p(0.5, 0.05, "m2"), crr: p(0.02, 0.002, "1"), drivetrainEfficiency: p(0.9, 0.02, "1"), riderMass: p(80, 10, "kg"),
            indicatedEfficiency: p(0.3, 0.03, "1"), fmepA: p(1e5, 2e4, "Pa"), fmepB: p(0, 1, "Pa*s/rad"), fmepC: p(0, 0.01, "Pa*s2/rad2"),
            redlineFactor: p(1.12, 0.05, "1")
        },
        fuelAdvice: { minConf: 0.7, advisable: ["E20"] },
        reference: { fuelGrades: { sources: [], grades: [
            { code: "E20", ethanolVolFraction: 0.2, flexFuelBlend: false, lhv: q(3.014e10, "J/m3"), density: q(755.8, "kg/m3") },
            { code: "E10", ethanolVolFraction: 0.1, flexFuelBlend: false, lhv: q(3.1248e10, "J/m3"), density: q(751.7, "kg/m3") }
        ] } }
    };
}

/** Every number in an object/array tree (to check for NaN). */
export function numbersIn(x, out = []) {
    if (typeof x === "number") out.push(x);
    else if (ArrayBuffer.isView(x)) out.push(...Array.from(/** @type {any} */ (x)));
    else if (Array.isArray(x)) x.forEach((y) => numbersIn(y, out));
    else if (x && typeof x === "object") Object.values(x).forEach((y) => numbersIn(y, out));
    return out;
}
