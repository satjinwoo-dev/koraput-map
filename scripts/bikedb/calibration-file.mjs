// Fleet calibration proposals (data/bikes/calibration/<class-key>.json): written by
// scripts/bikedb/calibrate.mjs from a fit (lib/bikedb/calibration.js), reviewed like
// any other data change, and applied by the build to the class default's priors.
//
// A proposal is applied only if the class default's priors are still exactly the ones
// it was fitted against (`basedOn`). If a curator changed them since, it is stale:
// skipped with a warning, until the fleet is re-fitted. A malformed proposal stops
// the build, like a malformed bike file.
//
// Values are in the units the data files use (published units: m2, 1, kPa), so the
// diff reads like the bike files; the build converts to SI with everything else.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Contract = require("../../public/js/bikedb/bundle-contract.js");
const { CAL_PARAMS } = require("../../lib/bikedb/calibration.js");

export const CALIBRATION_FORMAT = "mapunite-calibration/1";
export const CALIBRATION_SOURCE_ID = "fleet-calibration";
export const CALIBRATION_DIR = "calibration";
const KEYS = CAL_PARAMS.map((c) => c.prior);
const field = (key) => Contract.FIELDS.find((f) => f.path === `priors.${key}`);
/** SI value → the field's published unit (linear conversions only). */
const fromSI = (v, unit) => v / Contract.toSI(1, unit);
const sig = (x, d = 4) => Number(Number(x).toPrecision(d));

export class CalibrationError extends Error {}

/**
 * A proposal file from a fit result (SI) and the class default's SOURCE bundle (published units).
 * @param {any} fit         fitClass() result with proposed: true
 * @param {any} classDefault the class default as in data/bikes/class-defaults/ (published units)
 * @param {string} date     YYYY-MM-DD
 */
export function makeProposal(fit, classDefault, date) {
    if (!fit || !fit.proposed) throw new CalibrationError(`${fit && fit.classKey}: not a proposed fit (${fit && fit.reason})`);
    const priors = {}, basedOn = {};
    for (const k of KEYS) {
        const unit = field(k).unit;
        const src = classDefault.priors[k];
        if (!src || src.u !== unit) throw new CalibrationError(`${classDefault.id}: prior ${k} must be in ${unit}`);
        // the fit's basedOn (SI, from the built bundle) must be this file's prior — else the build is stale
        const b = fit.basedOn.priors[k];
        if (Math.abs(fromSI(b.mean, unit) - src.mean) > 1e-9 * Math.abs(src.mean) || Math.abs(fromSI(b.sigma, unit) - src.sigma) > 1e-9 * Math.abs(src.sigma)) {
            throw new CalibrationError(`${classDefault.id}: the fit used ${k} = ${fromSI(b.mean, unit)} ± ${fromSI(b.sigma, unit)} ${unit}, the file now says ${src.mean} ± ${src.sigma}: rebuild the catalogue and re-fit`);
        }
        basedOn[k] = { mean: src.mean, sigma: src.sigma, u: unit };
        const p = fit.priors[k];
        priors[k] = { mean: sig(fromSI(p.mean, unit)), sigma: sig(fromSI(p.sigma, unit), 3), u: unit, conf: p.conf };
    }
    return {
        format: CALIBRATION_FORMAT,
        classKey: fit.classKey,
        classDefault: classDefault.id,
        date,
        basedOn,
        priors,
        overhead: { mean: fit.overhead.mean, sigma: fit.overhead.sigma, u: "1" },
        evidence: { tanks: fit.evidence.tanks, riders: fit.evidence.riders, km: fit.evidence.km, litres: fit.evidence.litres, noise: fit.noise, cv: fit.cv },
        method: "Bayesian MAP fit of class-level multipliers on drag area, rolling resistance, indicated efficiency and friction MEP A, plus a separate real-riding overhead, to anonymous full-to-full tanks (Student-t residuals, rider-capped weights, Laplace posterior; cross-validated by rider). lib/bikedb/calibration.js"
    };
}

/** Check a proposal's shape. Throws CalibrationError with every problem. @param {any} c @param {string} file */
export function validateProposal(c, file) {
    const errs = [];
    const fin = (x) => typeof x === "number" && Number.isFinite(x);
    if (!c || typeof c !== "object") throw new CalibrationError(`${file}: not a JSON object`);
    if (c.format !== CALIBRATION_FORMAT) errs.push(`format must be ${CALIBRATION_FORMAT}`);
    if (!(typeof c.classKey === "string" && /^(ice_manual|ice_cvt)\.[a-z_]+$/.test(c.classKey))) errs.push("classKey must be a petrol class key (fill-ups calibrate petrol classes)");
    if (path.basename(file) !== `${c.classKey}.json`) errs.push(`file must be named ${c.classKey}.json`);
    if (typeof c.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.date)) errs.push("date must be YYYY-MM-DD");
    for (const part of ["basedOn", "priors"]) {
        if (!c[part] || typeof c[part] !== "object") { errs.push(`${part} is required`); continue; }
        if (Object.keys(c[part]).sort().join() !== [...KEYS].sort().join()) errs.push(`${part} must have exactly ${KEYS.join(", ")}`);
        for (const k of KEYS) {
            const p = c[part][k], f = field(k);
            if (!p) continue;
            if (!fin(p.mean) || !(p.mean > 0) || !fin(p.sigma) || !(p.sigma > 0)) errs.push(`${part}.${k}: mean and sigma must be positive numbers`);
            if (p.u !== f.unit) errs.push(`${part}.${k}: unit must be ${f.unit}`);
            if (part === "priors" && f.range && !(p.mean >= f.range[0] && p.mean <= f.range[1])) errs.push(`priors.${k}: ${p.mean} ${f.unit} is outside the plausible range ${f.range.join("–")}`);
            if (part === "priors" && !(fin(p.conf) && p.conf >= 0 && p.conf <= 1)) errs.push(`priors.${k}: conf must be 0–1`);
        }
    }
    if (!c.overhead || !fin(c.overhead.mean) || !(c.overhead.mean > 0.5 && c.overhead.mean < 3) || !fin(c.overhead.sigma) || !(c.overhead.sigma >= 0) || c.overhead.u !== "1") errs.push("overhead: mean in 0.5–3, sigma ≥ 0, u \"1\"");
    const ev = c.evidence;
    if (!ev || !Number.isInteger(ev.tanks) || ev.tanks < 1 || !Number.isInteger(ev.riders) || ev.riders < 1) errs.push("evidence: tanks and riders must be positive integers");
    if (typeof c.method !== "string" || c.method.length < 20) errs.push("method must describe how the fit was made");
    if (errs.length) throw new CalibrationError(`${file}: ${errs.join("; ")}`);
}

/**
 * Apply data/bikes/calibration/*.json to the loaded source entries (class defaults).
 * Returns new entries (the originals aren't mutated), the runtime extras per class
 * (the overhead, for the bundles) and a report.
 * @param {Array<{ file?: string, bundle: any }>} entries
 * @param {string} dataDir
 */
export function applyCalibrations(entries, dataDir) {
    const dir = path.join(dataDir, CALIBRATION_DIR);
    const report = [];
    const calibrations = new Map();
    if (!fs.existsSync(dir)) return { entries, calibrations, report };
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    if (!files.length) return { entries, calibrations, report };
    const out = entries.map((e) => e);
    for (const f of files) {
        const file = path.join(dir, f);
        const rel = `data/bikes/${CALIBRATION_DIR}/${f}`;
        let c;
        try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new CalibrationError(`${rel}: invalid JSON — ${e.message}`); }
        validateProposal(c, rel);
        const i = out.findIndex((e) => e.bundle.kind === "class_default" && e.bundle.classKey === c.classKey);
        if (i < 0) throw new CalibrationError(`${rel}: no class default for ${c.classKey}`);
        const cd = out[i].bundle;
        if (cd.id !== c.classDefault) throw new CalibrationError(`${rel}: fitted for ${c.classDefault}, but the class default is ${cd.id}`);
        const stale = KEYS.filter((k) => {
            const now = cd.priors && cd.priors[k], was = c.basedOn[k];
            return !now || now.mean !== was.mean || now.sigma !== was.sigma || now.u !== was.u;
        });
        if (stale.length) {
            report.push({ file: rel, classKey: c.classKey, status: "stale", message: `the class default's ${stale.join(", ")} changed since this fit: not applied (re-fit the fleet)` });
            continue;
        }
        if ((cd.sources || []).some((s) => s.id === CALIBRATION_SOURCE_ID)) throw new CalibrationError(`${cd.id}: source id "${CALIBRATION_SOURCE_ID}" is reserved for fleet calibrations`);
        const next = structuredClone(cd);
        next.sources = [...(next.sources || []), {
            id: CALIBRATION_SOURCE_ID, kind: "derived", title: `MapUnite fleet calibration ${c.date}`, retrieved: c.date,
            note: `${c.method} ${c.evidence.tanks} anonymous full-to-full tanks from ${c.evidence.riders} riders` +
                (c.evidence.cv ? `; held-out riders' mean error ${Math.round(c.evidence.cv.prior * 100)} % → ${Math.round(c.evidence.cv.posterior * 100)} %.` : ".")
        }];
        for (const k of KEYS) {
            const was = c.basedOn[k], p = c.priors[k];
            next.priors[k] = { mean: p.mean, sigma: p.sigma, u: p.u, src: CALIBRATION_SOURCE_ID, conf: p.conf,
                note: `Fleet calibration ${c.date} (was ${was.mean} ± ${was.sigma} ${was.u})` };
        }
        out[i] = { ...out[i], bundle: next };
        calibrations.set(c.classKey, {
            date: c.date, tanks: c.evidence.tanks, riders: c.evidence.riders,
            overhead: { mean: c.overhead.mean, sigma: c.overhead.sigma, u: "1", src: CALIBRATION_SOURCE_ID }
        });
        report.push({ file: rel, classKey: c.classKey, status: "applied", message: `${c.evidence.tanks} tanks from ${c.evidence.riders} riders` });
    }
    return { entries: out, calibrations, report };
}
