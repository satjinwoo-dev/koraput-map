// Test helper: the REAL SmartDrive fuel learner (extracted from public/js/smartdrive.js and run in a
// sandbox), fed with a simulated rider whose true fuel use is the physics × a factor per speed band.
// Used by the insights tests and to make fixtures for the browser checks.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The learner's source: from the idle constant to the end of the FuelCurve object. */
export function learnerSource() {
    const src = fs.readFileSync(path.join(ROOT, "public/js/smartdrive.js"), "utf8");
    const a = src.indexOf("const IDLE_L_PER_HOUR");
    const b = src.indexOf("\nconst SmartDrive");
    if (a < 0 || b < 0) throw new Error("smartdrive.js layout changed: can't find the learner");
    return src.slice(a, b);
}

/** A fresh learner in its own sandbox. Returns { FC, g } where g holds its helpers (fuelShape, FUEL_BANDS…). */
export function makeLearner({ rated = 18, stored = null } = {}) {
    const store = new Map();
    if (stored) store.set("mu_fuel_curve", JSON.stringify(stored));
    const ctx = vm.createContext({
        localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
        $: () => null, escapeHTML: (s) => String(s), showToast: () => { }, console, Date, Math, JSON, Number, Array, Map, Set, Object, String, Boolean
    });
    vm.runInContext(learnerSource() + `
;globalThis.__g = { FuelCurve, fuelShape, FUEL_BANDS, IDLE_L_PER_HOUR, fuelBandIndex };
FuelCurve.rated = () => ${Number(rated)};`, ctx);
    const g = ctx.__g;
    g.FuelCurve.load();
    return { FC: g.FuelCurve, g, store };
}

/**
 * Ride `tanks` full-to-full tanks. Each day's ride mixes the four speed bands; the TRUE fuel per
 * metre at speed v is physicsPm(v) × truth[band] (+ idling at idleRate m³/s × truthIdle).
 * @param {{ FC: any, g: any }} L
 * @param {{ physicsPm: (v: number) => number, idleRate: number, truth: number[], truthIdle?: number, tanks?: number, seed?: number, noise?: number, startTs?: number }} o
 */
export function rideAndFill(L, o) {
    const { FC, g } = L;
    let seed = o.seed ?? 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const truthIdle = o.truthIdle ?? 1;
    let ts = o.startTs ?? Date.UTC(2026, 6, 1, 8);
    const day = 86400000;
    FC.logFill({ litres: 10, full: true, ts, odometerKm: 1000 });
    let odo = 1000;
    for (let t = 0; t < (o.tanks ?? 6); t++) {
        let litres = 0;
        for (let d = 0; d < 6; d++) {
            ts += day;
            // a ride: km per band, speeds drawn inside each band
            // tanks differ (city weeks, mixed, highway weeks) so the learner can tell the bands apart
            const pat = [[30, 12, 4, 1], [14, 16, 10, 6], [5, 10, 18, 22]][t % 3];
            const mix = pat.map((x) => x * (0.7 + 0.6 * rnd()));
            const shape = [0, 0, 0, 0], bandKm = [0, 0, 0, 0];
            let km = 0;
            mix.forEach((kmBand, j) => {
                const lo = [15, 40, 61, 81][j], hi = [39, 60, 80, 105][j];
                for (let k = 0; k < 4; k++) {
                    const kmh = lo + (hi - lo) * rnd(), dkm = kmBand / 4;
                    shape[j] += dkm / g.fuelShape(kmh); bandKm[j] += dkm; km += dkm;
                    litres += o.physicsPm(kmh / 3.6) * dkm * 1000 * o.truth[j] * 1000;
                }
            });
            const idleH = 0.05 + 0.1 * rnd();
            litres += o.idleRate * idleH * 3600 * truthIdle * 1000;
            FC.recordTrip({ startedAt: ts - 3600000, endedAt: ts, shape, bandKm, idleH, km });
            odo += km;
        }
        ts += 3600000;
        const noisy = litres * (1 + (o.noise ?? 0.02) * (rnd() * 2 - 1));
        FC.logFill({ litres: Math.round(noisy * 100) / 100, full: true, ts, odometerKm: Math.round(odo) });
    }
    return FC.fit;
}
