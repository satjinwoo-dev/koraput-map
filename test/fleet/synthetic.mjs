// A synthetic fleet with KNOWN true parameters, for testing the calibration:
// riders with their own riding mix (city / highway / mixed), masses and fuels,
// tanks whose litres come from the physics at the true parameters × the true
// overhead, plus fill-up noise. Deterministic for a given seed.
import { createRequire } from "node:module";
import { buildArtifacts } from "../../scripts/bikedb/catalog-build.mjs";
import { loadCatalog } from "../../scripts/bikedb/load-catalog.mjs";

const require = createRequire(import.meta.url);
export const Physics = require("../../public/js/physics/index.js");
export const Cal = require("../../lib/bikedb/calibration.js");
export const art = buildArtifacts(loadCatalog());
export const byId = new Map(art.bundles.map((b) => [b.id, b]));
export const classDefault = (classKey) => art.bundles.find((b) => b.kind === "class_default" && b.classKey === classKey);
export const bundlesById = new Map(art.bundles.map((b) => [b.id, b.runtime]));

export function prng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (rnd) => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());

/** km per 5 km/h bin for a riding style. */
function histogram(rnd, style, km) {
    const h = new Array(40).fill(0);
    const centre = style === "city" ? 28 : style === "highway" ? 72 : 48;
    const spread = style === "city" ? 9 : style === "highway" ? 12 : 16;
    for (let i = 0; i < 400; i++) {
        const v = Math.max(3, Math.min(130, centre + spread * gauss(rnd)));
        h[Math.min(39, Math.floor(v / 5))] += km / 400;
    }
    return h.map((x) => Math.round(x * 1000) / 1000);
}

/**
 * @param {{ classKey: string, bikes?: string[], riders?: number, tanksPerRider?: number, truth?: { cda?: number, crr?: number, indicatedEfficiency?: number, fmepA?: number, overhead?: number }, noise?: number, seed?: number }} o
 *   truth: multipliers on today's class priors (1 = today's prior is right)
 */
export function syntheticFleet(o) {
    const rnd = prng(o.seed ?? 1);
    const cd = classDefault(o.classKey);
    const bikes = (o.bikes || art.bundles.filter((b) => b.kind === "variant" && b.runtime.classKey === o.classKey).map((b) => b.id)).map((id) => byId.get(id)).concat([cd]);
    const truth = { cda: 1, crr: 1, indicatedEfficiency: 1, fmepA: 1, overhead: 1, ...(o.truth || {}) };
    const draft = [];
    for (let r = 0; r < (o.riders ?? 40); r++) {
        const contributor = `rider-${String(r).padStart(3, "0")}`;
        const bike = bikes[r % bikes.length];
        const style = ["city", "highway", "mixed"][Math.floor(rnd() * 3)];
        const massKg = 5 * Math.round((60 + 30 * rnd()) / 5);
        const n = o.tanksPerRider ?? 10;
        for (let t = 0; t < n; t++) {
            const km = 150 + 250 * rnd();
            const hist = histogram(rnd, t % 4 === 3 ? "mixed" : style, km);
            draft.push({ contributor, bike: bike.id, bundle: bike.hash, massKg, fuelCode: "E20", litres: 1, km: Math.round(km * 10) / 10, idleH: Math.round(rnd() * 3 * 100) / 100, hist });
        }
    }
    // litres at the TRUE parameters: the same forward model, θ = log(multipliers)
    const ev = Cal.evaluator(Physics, cd.runtime, bundlesById, draft);
    const theta = [...Cal.CAL_PARAMS.map((c) => Math.log(truth[c.prior])), Math.log(truth.overhead)];
    const trueL = ev.predict(theta, draft.map((_, i) => i));
    const noise = o.noise ?? 0.06;
    return draft.map((t, i) => ({ ...t, litres: Math.round(trueL[i] * Math.exp(noise * gauss(rnd)) * 100) / 100 }));
}

export const ranges = { cda: [0.1, 1.2], crr: [0.004, 0.05], indicatedEfficiency: [0.15, 0.45], fmepA: [20000, 400000] };
