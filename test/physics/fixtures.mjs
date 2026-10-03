// Synthetic runtime bundles with round numbers, for hand-checked known-answer
// tests (independent of the seed catalogue), plus loaders for the real one.
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildArtifacts } from "../../scripts/bikedb/catalog-build.mjs";
import { loadCatalog } from "../../scripts/bikedb/load-catalog.mjs";

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const P = require("../../public/js/physics/index.js");
export const RPM = Math.PI / 30;

const q = (v) => ({ v, conf: 0.9, src: "test" });
const prior = (mean, sigma) => ({ mean, sigma, conf: 0.5, src: "test" });
const FUEL_GRADES = {
    grades: [
        { code: "E20", lhv: { v: 30.14e9 }, density: { v: 755.8 } },
        { code: "E10", lhv: { v: 31.248e9 }, density: { v: 751.7 } }
    ]
};

/** 155 cc single, 13.5 kW @ 10000 rpm, 14.1 N*m @ 7500 rpm, 5 speeds: 3 × (2.8 … 0.9) × 3. */
export function iceBundle(over = {}) {
    return {
        id: "test-ice", kind: "variant", classKey: "ice_manual.commuter", powertrain: "ice_manual", units: "SI",
        chassis: { mass: { ...q(120), basis: "kerb" }, rearTyre: q("100/80-17"), frontTyre: q("90/80-17"), fuelTank: q(0.01) },
        engine: {
            displacement: q(1.55e-4), strokes: q(4), fuelSystem: q("fi"),
            peakPower: q(13500), peakPowerRpm: q(10000 * RPM), peakTorque: q(14.1), peakTorqueRpm: q(7500 * RPM),
            idleRpm: q(150), redlineRpm: q(1172.9)
        },
        transmission: {
            kind: q("manual"), speeds: q(5),
            primaryRatio: { v: 3, conf: 0.8, src: "test" }, gearRatios: { v: [2.8, 1.8, 1.3, 1.05, 0.9], conf: 0.8, src: "test" }, finalRatio: { v: 3, conf: 0.8, src: "test" }
        },
        priors: {
            cda: prior(0.5, 0.1), crr: prior(0.02, 0.004), drivetrainEfficiency: prior(0.9, 0.03), riderMass: prior(80, 10),
            indicatedEfficiency: prior(0.31, 0.04), fmepA: prior(1e5, 3e4), fmepB: prior(0, 1), fmepC: prior(0, 0.01), redlineFactor: prior(1.12, 0.06)
        },
        reference: { fuelGrades: FUEL_GRADES },
        ...over
    };
}

/** 110 cc CVT scooter. */
export function cvtBundle(over = {}) {
    const b = iceBundle();
    return {
        ...b, id: "test-cvt", classKey: "ice_cvt.scooter", powertrain: "ice_cvt",
        chassis: { mass: { ...q(106), basis: "kerb" }, rearTyre: q("90/100-10"), frontTyre: q("90/90-12"), fuelTank: q(0.0053) },
        engine: {
            displacement: q(1.0951e-4), strokes: q(4), fuelSystem: q("fi"),
            peakPower: q(5880), peakPowerRpm: q(8000 * RPM), peakTorque: q(9.05), peakTorqueRpm: q(5500 * RPM), idleRpm: q(1700 * RPM)
        },
        transmission: { kind: q("cvt"), cvtRatioMax: q(2.55), cvtRatioMin: q(0.8), finalRatio: q(10.208) },
        ...over
    };
}

/** EV scooter: 6.4 kW peak, 3.7 kWh gross. */
export function evBundle(over = {}) {
    return {
        id: "test-ev", kind: "variant", classKey: "ev.scooter", powertrain: "ev", units: "SI",
        chassis: { mass: { ...q(111.6), basis: "kerb" }, rearTyre: q("100/80-12"), frontTyre: q("90/90-12"), topSpeed: q(25) },
        motor: { peakPower: q(6400) },
        battery: { grossCapacity: q(3.7 * 3.6e6) },
        transmission: { kind: q("single_speed") },
        priors: {
            cda: prior(0.52, 0.094), crr: prior(0.021, 0.0046), drivetrainEfficiency: prior(0.95, 0.02), riderMass: prior(72, 12),
            motorEfficiency: prior(0.85, 0.05), regenEfficiency: prior(0.5, 0.15)
        },
        ...over
    };
}

// ---- the real catalogue, compiled in memory exactly as the build compiles it ----
let real = null;
/** @returns {Array<{ bundle: any, classDefault: any }>} every runtime bundle with its class default */
export function realBundles() {
    if (real) return real;
    const all = buildArtifacts(loadCatalog()).bundles.map((b) => JSON.parse(b.bytes));
    const defaults = Object.fromEntries(all.filter((b) => b.kind === "class_default").map((b) => [b.classKey, b]));
    real = all.sort((a, b) => (a.id < b.id ? -1 : 1)).map((bundle) => ({ bundle, classDefault: defaults[bundle.classKey] }));
    return real;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
