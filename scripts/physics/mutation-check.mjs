#!/usr/bin/env node
/*
 * Mutation check for the physics core: are the tests strong enough to notice a
 * plausible bug? Each mutant changes one line of public/js/physics/ the way a
 * real mistake would (a wrong sign, a dropped factor, a fallback number creeping
 * back in), then runs the physics tests. A mutant the tests still pass "survives",
 * and the check fails.
 *
 *   npm run physics:mutation             all mutants, 4 at a time
 *   node scripts/physics/mutation-check.mjs --only tyre   mutants whose id contains "tyre"
 *
 * Every mutant runs in its own throwaway copy of the physics and its tests (the
 * rest of the repo is symlinked in), so the working tree is never touched and
 * mutants can run in parallel. The timing test (perf.test.mjs) is left out: a
 * slow mutant must not count as caught.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** @type {{ id: string, file: string, find: string, replace: string }[]} */
const MUTANTS = [
    // atmosphere
    { id: "atmosphere.vapour-as-dry-air", file: "atmosphere.js", find: "pv / (R_VAPOUR * T)", replace: "pv / (R_DRY * T)" },
    { id: "atmosphere.no-lapse", file: "atmosphere.js", find: "T = ISA.T0 - ISA.LAPSE * h;", replace: "T = ISA.T0;" },
    { id: "atmosphere.buck-ice-branch", file: "atmosphere.js", find: "return t >= 0", replace: "return t >= -50" },
    // tyre
    { id: "tyre.deflection-sign", file: "tyre.js", find: "const r = r0 * (1 - deflection);", replace: "const r = r0 * (1 + deflection);" },
    { id: "tyre.one-sidewall", file: "tyre.js", find: "diameterM: rim * INCH + 2 * widthM * (a / 100)", replace: "diameterM: rim * INCH + widthM * (a / 100)" },
    // road load
    { id: "roadload.full-rho-cda", file: "roadload.js", find: "0.5 * rho * cda * va * Math.abs(va)", replace: "rho * cda * va * Math.abs(va)" },
    { id: "roadload.rolling-ignores-slope", file: "roadload.js", find: "(v > 0 ? crr * mass * G0 * cos : 0)", replace: "(v > 0 ? crr * mass * G0 : 0)" },
    { id: "roadload.grade-sign", file: "roadload.js", find: "+ mass * G0 * sin + inertiaForce", replace: "- mass * G0 * sin + inertiaForce" },
    { id: "roadload.traction-whole-weight", file: "roadload.js", find: "return grip * rearShare * mass * G0 * cos;", replace: "return grip * mass * G0 * cos;" },
    // powertrain
    { id: "powertrain.over-peak-linear", file: "powertrain.js", find: "(1 - k.overPeakDrop * z * z)", replace: "(1 - k.overPeakDrop * z)" },
    { id: "powertrain.friction-per-rev", file: "powertrain.js", find: "/ (TWO_PI * revsPerCycle)", replace: "/ TWO_PI" },
    { id: "powertrain.willans-drops-friction", file: "powertrain.js", find: "return (Math.max(0, brakePower) + frictionW) / etaIndicated;", replace: "return Math.max(0, brakePower) / etaIndicated;" },
    { id: "powertrain.regen-unlimited", file: "powertrain.js", find: "Math.max(wheelPower * p.etaRegen, -p.regenLimit)", replace: "wheelPower * p.etaRegen" },
    { id: "powertrain.regen-times-motor-eff", file: "powertrain.js", find: "return wheelPower / (p.etaDt * p.etaMotor) + p.aux;", replace: "return wheelPower * p.etaDt * p.etaMotor + p.aux;" },
    { id: "powertrain.published-interp-backwards", file: "powertrain.js", find: "return s.values[i] + (s.values[i + 1] - s.values[i]) * f;", replace: "return s.values[i] + (s.values[i + 1] - s.values[i]) * (1 - f);" },
    { id: "powertrain.ev-torque-ignores-power", file: "powertrain.js", find: "const f = Math.min(fromTorque, fromPower);", replace: "const f = fromTorque;" },
    // model: missing data must never be invented
    { id: "model.idle-guessed-again", file: "model.js", find: "if (wI === undefined) throw new Error(`${bundle.id}: no idle speed published", replace: "if (wI === undefined) wI = 0.18 * wP; if (false) throw new Error(`${bundle.id}: no idle speed published" },
    { id: "model.tank-guessed-again", file: "model.js", find: "if (tank === undefined) throw new Error(", replace: "if (false) throw new Error(" },
    { id: "model.fuel-silent-fallback", file: "model.js", find: "const g = grades.find((/** @type {any} */ x) => x.code === want);", replace: "const g = grades.find((/** @type {any} */ x) => x.code === want) || grades[0];" },
    { id: "model.gear-advice-ignores-confidence", file: "model.js", find: "else if (!(conf >= MODEL_DEFAULTS.gearAdviceMinConf))", replace: "else if (false)" },
    { id: "model.gear-advice-ignores-speeds", file: "model.js", find: "if (speeds !== undefined && speeds !== g.gears.length)", replace: "if (false)" },
    { id: "model.gear-advice-for-class-defaults", file: "model.js", find: "if (gearAdvice && bundle.kind === \"class_default\")", replace: "if (false)" },
    { id: "cruise.shift-advice-not-refused", file: "cruise.js", find: "if (!model.gearAdvice && !opts.diagnostic) return", replace: "if (false) return" },
    { id: "model.typical-bike-reason-lost", file: "model.js", find: "gearAdvice = false; gearAdviceReason = \"typical-bike\";", replace: "gearAdvice = false;" },
    { id: "model.two-stroke-as-four", file: "model.js", find: "revsPerCycle: strokes === 2 ? 1 : 2,", replace: "revsPerCycle: 2," },
    { id: "model.published-curve-ignored", file: "model.js", find: "samples: samples ? samples.samples : undefined", replace: "samples: undefined" },
    // cruise
    { id: "cruise.sigma-full-difference", file: "cruise.js", find: "const d = 0.5 * (a - b);", replace: "const d = a - b;" },
    { id: "cruise.sigma-linear-sum", file: "cruise.js", find: "const s = Math.sqrt(s2);", replace: "const s = s2;" },
    { id: "cruise.contribution-not-squared", file: "cruise.js", find: "contribSum[j] += (d / f) * (d / f);", replace: "contribSum[j] += Math.abs(d / f);" },
    { id: "cruise.no-fuel-cut", file: "cruise.js", find: "fuelW = indicated > 0 ? indicated / P.etaInd : 0;", replace: "fuelW = Math.max(indicated, frictionPower(eng.displacement, eng.revsPerCycle, fmep, eng.omegaIdle)) / P.etaInd;" },
    { id: "cruise.no-idle-feed", file: "cruise.js", find: "fuelW = Math.max(indicated / P.etaInd, idleFeed);", replace: "fuelW = Math.max(indicated / P.etaInd, 0 * idleFeed);" },
    { id: "cruise.lugging-ignored", file: "cruise.js", find: "const lugOk = tmp.omega >= eng.omegaLug || g === 0;", replace: "const lugOk = true;" },
    { id: "cruise.overrun-brake-power-sign", file: "cruise.js", find: "let Pb = Pw >= 0 ? Pw / P.etaDt : Pw * P.etaDt;", replace: "let Pb = Pw / P.etaDt;" },
    { id: "cruise.slipping-clutch-free", file: "cruise.js", find: "if (st.slipping && wOut > V_EPS) Pb *= w / wOut;", replace: "" },
    { id: "cruise.ev-no-traction-limit", file: "cruise.js", find: "else if (F > trac) { st.feasible = false; st.reason = \"traction\"; }\n        else if (F > fMax", replace: "else if (F > fMax" },
    { id: "cruise.range-band-swapped", file: "cruise.js", find: "rangeLo[i] = Number.isFinite(range[i]) ? range[i] / (1 + rel) : range[i];", replace: "rangeLo[i] = Number.isFinite(range[i]) ? range[i] / (1 - rel) : range[i];" }
];

const only = (() => { const i = process.argv.indexOf("--only"); return i >= 0 ? process.argv[i + 1] : null; })();
const todo = only ? MUTANTS.filter((m) => m.id.includes(only)) : MUTANTS;
if (todo.length === 0) { console.error(`no mutant matches "${only}"`); process.exit(2); }

// every mutant must apply to exactly one place in the current source
for (const m of todo) {
    const src = readFileSync(join(ROOT, "public/js/physics", m.file), "utf8");
    const n = src.split(m.find).length - 1;
    if (n !== 1) { console.error(`mutant ${m.id}: pattern found ${n} times in ${m.file} — update the mutant`); process.exit(2); }
}

const tests = readdirSync(join(ROOT, "test/physics")).filter((f) => f.endsWith(".test.mjs") && f !== "perf.test.mjs").map((f) => join("test/physics", f));

/** A throwaway tree: physics + its tests copied, everything else symlinked. */
function makeTree() {
    const dir = mkdtempSync(join(tmpdir(), "mu-mutant-"));
    /** @param {string} rel @param {string[]} copy  sub-paths (relative to rel) to recurse into */
    const mirror = (rel, copy) => {
        mkdirSync(join(dir, rel), { recursive: true });
        for (const e of readdirSync(join(ROOT, rel))) {
            if (e === ".git") continue;
            const sub = rel ? `${rel}/${e}` : e;
            const next = copy.filter((c) => c === sub || c.startsWith(`${sub}/`));
            if (next.includes(sub)) cpSync(join(ROOT, sub), join(dir, sub), { recursive: true });
            else if (next.length) mirror(sub, next);
            else symlinkSync(join(ROOT, sub), join(dir, sub));
        }
    };
    mirror("", ["public/js/physics", "test/physics"]);
    return dir;
}

/** @param {string} cwd @returns {Promise<{ code: number|null, out: string }>} */
function runTests(cwd) {
    return new Promise((done) => {
        const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", "--test-reporter=dot", ...tests], { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        p.stdout.on("data", (d) => { out += d; });
        p.stderr.on("data", (d) => { out += d; });
        p.on("close", (code) => done({ code, out }));
    });
}

/** @param {typeof MUTANTS[number]} m */
async function runMutant(m) {
    const dir = makeTree();
    try {
        const path = join(dir, "public/js/physics", m.file);
        writeFileSync(path, readFileSync(path, "utf8").replace(m.find, m.replace));
        const { code } = await runTests(dir);
        return { ...m, killed: code !== 0 };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const t0 = Date.now();
// the unmutated tree must pass, or every mutant would look "caught"
const base = makeTree();
const baseline = await runTests(base).finally(() => rmSync(base, { recursive: true, force: true }));
if (baseline.code !== 0) { console.error("the unmutated physics tests fail — fix them before checking mutants\n" + baseline.out); process.exit(2); }

const results = [];
const queue = [...todo];
const workers = Array.from({ length: Math.max(1, Math.min(4, availableParallelism())) }, async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
        const r = await runMutant(m);
        results.push(r);
        console.log(`${r.killed ? "caught  " : "SURVIVED"}  ${r.id}`);
    }
});
await Promise.all(workers);

const survived = results.filter((r) => !r.killed);
console.log(`\n${results.length - survived.length}/${results.length} mutants caught in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (survived.length) {
    console.error(`survivors (the tests miss these bugs):\n${survived.map((r) => `  ${r.id}: ${r.file}: "${r.find}" → "${r.replace}"`).join("\n")}`);
    process.exit(1);
}
