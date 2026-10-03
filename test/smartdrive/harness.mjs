// Runs public/js/smartdrive.js (a classic browser script) in a sandbox with the few
// globals it touches stubbed, and drives it through a deterministic scenario:
// rides at varied speeds with stops, fill-ups between them, and the fill-up learner.
// Used to prove the no-bike path is unchanged (golden-legacy.json, recorded from the
// pre-Step-7 file) and to test the physics baseline.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function memoryStorage(init = {}) {
    const m = new Map(Object.entries(init));
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

/**
 * @param {{ source?: string, storage?: any, extraScripts?: string[], globals?: object }} [o]
 * @returns {{ ctx: any, run: (code: string) => any }}
 */
export function loadSmartDrive(o = {}) {
    const storage = o.storage || memoryStorage();
    const emitted = [];
    const ctx = vm.createContext({
        console, Math, JSON, Date, Number, Array, Object, String, Boolean, Map, Set, Promise, setTimeout, clearTimeout, Error, TypeError, RangeError, isFinite, parseFloat, Float64Array, Int8Array, Uint8Array,
        localStorage: storage,
        document: { addEventListener() {}, createElement: () => ({ appendChild() {}, setAttribute() {} }), querySelectorAll: () => [] },
        window: {}, navigator: {},
        socket: { connected: true, emit: (...a) => emitted.push(a) },
        $: () => null, showToast() {}, safeShow() {}, safeHide() {}, escapeHTML: (s) => String(s), islandShow() {}, voiceAnnounce() {},
        GpsFilter: { GATE: 0.4, reset() {} }, myCoords: null, cityName: "", emitDriveState() {},
        ...(o.globals || {})
    });
    ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
    for (const f of o.extraScripts || []) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
    vm.runInContext(o.source ?? fs.readFileSync(path.join(ROOT, "public/js/smartdrive.js"), "utf8"), ctx, { filename: "smartdrive.js" });
    vm.runInContext("SmartDrive.checkSafetyLimits = function () {}; SmartDrive.drawGraph = function () {};", ctx);
    return { ctx, emitted, run: (code) => vm.runInContext(code, ctx) };
}

/** mulberry32 */
function prng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * The scenario: 7 full-to-full tanks of riding (city, highway and mixed rides with
 * stops), the litres at each pump coming from a hidden "true" bike, then everything
 * the fuel model reports.
 * @param {{ run: (code: string) => any, ctx: any }} sd
 */
export function runScenario(sd, { seed = 7, trueKmPerL = (v) => 38 - Math.abs(v - 45) * 0.25, trueIdleLph = 0.3 } = {}) {
    const rnd = prng(seed);
    const T0 = Date.UTC(2026, 8, 1);
    let ts = T0;
    // top-level consts of a classic script live in the global lexical scope, not on the global object
    const S = new Proxy({}, { get: (_, k) => sd.run(String(k)) });
    sd.run("SmartDrive.trip = { active: true, startTime: 0, totalDist: 0, actualFuel: 0, maxSpeed: 0, sumSpeed: 0, ticks: 0, ranges: { efficient: 0, moderate: 0, inefficient: 0 }, stoppedTimeSec: 0, points: [], lastPointTs: 0, idleSec: 0, idleFuelL: 0, bandKm: [0, 0, 0, 0], fitSeg: null };");
    const out = { rides: [] };
    S.FuelCurve.logFill({ litres: 10, full: true, odometerKm: 1000, ts: ts++ });
    let odo = 1000;
    for (let tank = 0; tank < 7; tank++) {
        let trueL = 0, km = 0;
        for (let ride = 0; ride < 3; ride++) {
            const style = (tank + ride) % 3;                 // city, highway, mixed
            const before = S.SmartDrive.trip.actualFuel;
            for (let s = 0; s < 1500; s++) {
                let v;
                if (style === 0) v = s % 120 < 20 ? 0 : 20 + 25 * rnd();
                else if (style === 1) v = 70 + 30 * rnd();
                else v = s % 300 < 30 ? 0 : 35 + 30 * rnd();
                const d = v / 3600;
                S.SmartDrive.tick({ smoothedKmh: v, accepted: true, confidence: 0.9, dtSec: 1, distKm: d, accuracyM: 5 });
                km += d;
                trueL += v > 3 ? d / trueKmPerL(v) : trueIdleLph / 3600;
            }
            out.rides.push(+(S.SmartDrive.trip.actualFuel - before).toFixed(9));
            ts += 3600_000;
            S.SmartDrive.flushFitSegment(ts);
        }
        odo += km;
        ts += 60_000;
        S.FuelCurve.logFill({ litres: Math.round(trueL * 100) / 100, full: true, odometerKm: Math.round(odo), ts });
    }
    const f = S.FuelCurve.fit;
    return {
        ...out,
        totalFuel: +S.SmartDrive.trip.actualFuel.toFixed(9),
        idleFuel: +S.SmartDrive.trip.idleFuelL.toFixed(9),
        fit: { usable: f.usable, ready: f.ready, rated: f.rated, beta: f.beta && f.beta.map((b) => +b.toFixed(9)), mape: f.mape === null ? null : +f.mape.toFixed(9), priorMape: f.priorMape === null ? null : +f.priorMape.toFixed(9) },
        active: S.FuelCurve.active(),
        kmPerL: [10, 25, 50, 70, 95, 130].map((v) => S.FuelCurve.kmPerL(v)),
        idleLPerHour: S.FuelCurve.idleLPerHour(),
        efficientKmPerL: S.FuelCurve.efficientKmPerL(),
        status: S.FuelCurve.status(),
        rated: S.FuelCurve.rated(),
        generic: [0, 10, 30, 40, 50, 60, 61, 80, 100, 150, 400].map((v) => sd.run(`genericKmPerL(${v}, 18)`))
    };
}
