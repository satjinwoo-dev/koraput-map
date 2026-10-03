#!/usr/bin/env node
/*
 * Builds the bike catalog (plan step 3) from the reviewed JSON in data/bikes/:
 *
 *   node --disable-warning=ExperimentalWarning scripts/build-bike-catalog.mjs [--data DIR] [--out DIR] [--quiet]
 *   npm run bikes:build
 *
 * Writes to --out (default dist/bikedb/):
 *   bikes.sqlite          normalised SQLite (lib/bikedb/schema.sql) with an FTS5 index — for the server
 *   catalog.json          compact list for the bike picker and the offline index, with image_url
 *   bundles/<hash>.json   one immutable bundle per variant and class default; <hash> is the first
 *                         16 hex digits of the SHA-256 of the file's bytes, so a URL never changes meaning
 *
 * Everything written is strict SI: the source JSON keeps the published units
 * (rpm, cm3, kW ...) for review, and lib/bikedb/si-units.js converts them here.
 * Each value keeps the published figure next to it.
 *
 * The build refuses to run on invalid data: every bundle and the catalog
 * rules must pass public/js/bikedb/bundle-contract.js first. data/bikes/pending/
 * is never compiled. The output is repeatable: the same input gives the same
 * bytes (no timestamps; fixed ordering; numbers rounded to 12 significant digits).
 *
 * Needs Node >= 22.13 (built-in node:sqlite with FTS5).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadCatalog, loadPending } from "./bikedb/load-catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Contract = require(path.join(ROOT, "public/js/bikedb/bundle-contract.js"));
const SearchKeys = require(path.join(ROOT, "public/js/bikedb/search-keys.js"));
const { TO_SI, toSI } = require(path.join(ROOT, "lib/bikedb/si-units.js"));
const { makeSearch } = require(path.join(ROOT, "lib/bikedb/search.js"));

export const BUILD_FORMAT = 1;
const HASH_HEX = 16;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const get = (o, p) => p.split(".").reduce((a, k) => (isObj(a) ? a[k] : undefined), o);
const hashOf = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** JSON with keys sorted at every level: the same data always serialises to the same bytes. */
export function canonicalJson(value) {
    const sort = (v) => {
        if (Array.isArray(v)) return v.map(sort);
        if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
        return v;
    };
    return JSON.stringify(sort(value));
}

class BuildError extends Error {}

function siOf(value, unit, where) {
    if (!TO_SI[unit]) throw new BuildError(`${where}: unit "${unit}" has no SI conversion (lib/bikedb/si-units.js)`);
    return toSI(value, unit);
}

// ---------------------------------------------------------------------------
// compile one bundle to SI
// ---------------------------------------------------------------------------
/**
 * @param {any} b               source bundle (valid)
 * @param {any|null} classDefault  its class default (for a variant), else null
 * @param {any} ref             reference tables
 */
export function compileBundle(b, classDefault, ref) {
    const out = {
        format: BUILD_FORMAT,
        schema_version: b.schemaVersion,
        units: "SI",
        id: b.id,
        kind: b.kind,
        class_key: b.classKey,
        powertrain: b.powertrain,
        segment: b.segment,
        identity: {
            make: b.identity.make,
            model: b.identity.model,
            variant: b.identity.variant ?? null,
            market: b.identity.market,
            year_from: b.identity.yearFrom,
            year_to: b.identity.yearTo,
            aliases: [...b.identity.aliases]
        },
        image_url: get(b, "media.image.v") ?? null,
        image_src: get(b, "media.image.src") ?? null,
        class_default_id: classDefault ? classDefault.id : null,
        sources: Object.fromEntries(b.sources.map((s) => [s.id, sourceOut(s)]))
    };

    // Numeric and categorical values, grouped as in the contract (engine.peakPower ...).
    for (const f of Contract.FIELDS) {
        if (f.path.startsWith("priors.") || f.path === "media.image") continue;
        const v = get(b, f.path);
        if (!isObj(v)) continue;
        const [group, key] = f.path.split(".");
        out[group] = out[group] || {};
        out[group][key] = valueOut(f, v, `${b.id}:${f.path}`);
    }

    // Priors: a variant's own, else its class default's (resolvePriors), SI.
    const own = b.priors || {};
    const merged = b.kind === "variant" ? Contract.resolvePriors(b, classDefault) : own;
    const priors = {};
    for (const name of Object.keys(merged).sort()) {
        const p = merged[name];
        const inherited = !Object.prototype.hasOwnProperty.call(own, name);
        const mean = siOf(p.mean, p.u, `${b.id}:priors.${name}`);
        const sigma = siOf(p.sigma, p.u, `${b.id}:priors.${name}`);
        const src = inherited ? `${classDefault.id}/${p.src}` : p.src;
        if (inherited && !out.sources[src]) out.sources[src] = sourceOut(classDefault.sources.find((s) => s.id === p.src));
        priors[name] = {
            mean: mean.value, sigma: sigma.value, u: mean.unit, conf: p.conf, src,
            origin: inherited ? "class_default" : b.kind,
            published: { mean: p.mean, sigma: p.sigma, u: p.u },
            ...(p.note ? { note: p.note } : {})
        };
    }
    if (Object.keys(priors).length) out.priors = priors;

    // Fuel: every row as the source says, plus the one flag the app may act on.
    if (Array.isArray(get(b, "fuel.compat"))) {
        out.fuel = out.fuel || {};
        out.fuel.compat = b.fuel.compat.map((c) => ({
            fuel: c.fuel, status: c.status, conf: c.conf, src: c.src,
            // A class default never certifies or advises a fuel; for a variant the contract decides.
            advisable: b.kind === "variant" && Contract.isFuelAdvisable(b, c.fuel, ref),
            ...(c.note ? { note: c.note } : {})
        }));
    }

    if (isObj(b.curves)) {
        out.curves = {};
        for (const kind of Object.keys(b.curves).sort()) {
            const c = b.curves[kind];
            const start = siOf(c.rpmStart, "rpm", `${b.id}:curves.${kind}`);
            const step = siOf(c.rpmStep, "rpm", `${b.id}:curves.${kind}`);
            const scale = siOf(c.scale, c.u, `${b.id}:curves.${kind}`);
            out.curves[kind] = {
                axis_start: start.value, axis_step: step.value, axis_u: start.unit,
                scale: scale.value, u: scale.unit, data: [...c.data],
                method: c.method, conf: c.conf, src: c.src,
                published: { rpmStart: c.rpmStart, rpmStep: c.rpmStep, scale: c.scale, u: c.u },
                ...(c.note ? { note: c.note } : {})
            };
        }
    }
    if (Array.isArray(b.notes) && b.notes.length) out.notes = [...b.notes];
    return out;
}

function sourceOut(s) {
    const o = { kind: s.kind, title: s.title, retrieved: s.retrieved };
    for (const k of ["url", "publisher", "note"]) if (s[k] !== undefined) o[k] = s[k];
    return o;
}

function valueOut(f, v, where) {
    const o = { conf: v.conf, src: v.src };
    if (v.note) o.note = v.note;
    if (f.type === "c") return { v: v.v, ...o };
    const si = siOf(v.v, f.unit, where);
    Object.assign(o, { v: si.value, u: si.unit, published: { v: v.v, u: f.unit } });
    if (v.tol !== undefined) o.tol = siOf(v.tol, f.unit, where).value;
    for (const k of Object.keys(f.extra || {})) if (v[k] !== undefined) o[k] = v[k];
    return o;
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------
function writeDatabase(file, { bundles, ref, meta }) {
    let DatabaseSync;
    try { ({ DatabaseSync } = require("node:sqlite")); }
    catch { throw new BuildError(`node:sqlite is unavailable in Node ${process.version}; the build needs Node >= 22.13`); }
    fs.rmSync(file, { force: true });
    const db = new DatabaseSync(file);
    try {
        db.exec("PRAGMA page_size = 4096; PRAGMA journal_mode = DELETE;");
        db.exec(fs.readFileSync(path.join(ROOT, "lib/bikedb/schema.sql"), "utf8"));
        db.exec(`PRAGMA user_version = ${BUILD_FORMAT}`);
        db.exec("BEGIN");

        const ins = (sql) => { const st = db.prepare(sql); return (...a) => st.run(...a); };
        const insMeta = ins("INSERT INTO meta (key, value) VALUES (?, ?)");
        for (const [k, v] of Object.entries(meta)) insMeta(k, String(v));

        // fields: the contract's, plus the reference-table properties
        const insField = ins("INSERT INTO field (path, value_type, si_unit, source_unit, qualifier, doc) VALUES (?, ?, ?, ?, ?, ?)");
        const fieldRows = [
            ...Contract.FIELDS.map((f) => [f.path, f.type, f.unit, Object.keys(f.extra || {})[0] ?? null, f.doc]),
            ["fuel_grade.lhv", "q", "MJ/L", null, "Lower heating value per volume"],
            ["fuel_grade.density", "q", "kg/L", null, "Density"],
            ["fuel_grade.typicalRon", "q", "RON", null, "Typical / minimum research octane number"]
        ];
        for (const [p, t, unit, qual, doc] of fieldRows) insField(p, t, unit ? TO_SI[unit][0] : null, unit ?? null, qual, doc);

        // sources, shared across files
        const sourcePk = new Map();
        const insSource = db.prepare("INSERT INTO source (kind, title, url, publisher, retrieved, note) VALUES (?, ?, ?, ?, ?, ?)");
        const pkFor = (s) => {
            const key = canonicalJson([s.kind, s.title, s.url ?? null, s.publisher ?? null, s.retrieved, s.note ?? null]);
            if (!sourcePk.has(key)) sourcePk.set(key, Number(insSource.run(s.kind, s.title, s.url ?? null, s.publisher ?? null, s.retrieved, s.note ?? null).lastInsertRowid));
            return sourcePk.get(key);
        };

        // reference tables
        const refSrc = (table, id) => {
            const s = table.sources.find((x) => x.id === id);
            if (!s) throw new BuildError(`reference source "${id}" not found`);
            return pkFor(s);
        };
        const fg = ref.fuelGrades, es = ref.emissionStandards;
        const insGrade = ins("INSERT INTO fuel_grade (code, ethanol_vol_fraction, flex_fuel_blend) VALUES (?, ?, ?)");
        const insGradeProp = ins("INSERT INTO fuel_grade_property (code, path, value, source_value, source_pk, conf, note) VALUES (?, ?, ?, ?, ?, ?, ?)");
        for (const g of fg.grades) {
            insGrade(g.code, g.ethanolVolFraction, g.flexFuelBlend ? 1 : 0);
            for (const [prop, q] of [["lhv", g.lhv], ["density", g.density], ["typicalRon", g.typicalRon]]) {
                if (!q) continue;
                insGradeProp(g.code, `fuel_grade.${prop}`, siOf(q.v, q.u, `fuel-grades:${g.code}.${prop}`).value, q.v, refSrc(fg, q.src), q.conf, q.note ?? null);
            }
        }
        const insObd = ins("INSERT INTO obd_level (code, name, effective_from, source_pk, conf, note) VALUES (?, ?, ?, ?, ?, ?)");
        for (const o of es.obdLevels) insObd(o.code, o.name, o.effectiveFrom, refSrc(es, o.src), o.conf, o.note ?? null);
        const insStd = ins("INSERT INTO emission_standard (code, name, region, effective_from, superseded_from, obd_at_intro, source_pk, conf, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const s of es.standards) insStd(s.code, s.name, s.region, s.effectiveFrom, s.supersededFrom ?? null, s.obdAtIntro ?? null, refSrc(es, s.src), s.conf, s.note ?? null);

        // taxonomy
        const insClass = ins("INSERT INTO vehicle_class (class_key, powertrain, segment) VALUES (?, ?, ?)");
        for (const [pt, segs] of Object.entries(Contract.CLASS_MATRIX)) for (const seg of segs) insClass(`${pt}.${seg}`, pt, seg);
        const makePk = new Map(), modelPk = new Map();
        const insMake = db.prepare("INSERT INTO make (name) VALUES (?)");
        const insModel = db.prepare("INSERT INTO model (make_pk, name) VALUES (?, ?)");
        const modelFor = (make, model) => {
            const mk = make.toLowerCase();
            if (!makePk.has(mk)) makePk.set(mk, Number(insMake.run(make).lastInsertRowid));
            const key = `${mk}\u0000${model.toLowerCase()}`;
            if (!modelPk.has(key)) modelPk.set(key, Number(insModel.run(makePk.get(mk), model).lastInsertRowid));
            return modelPk.get(key);
        };

        const insBundle = ins(`INSERT INTO bundle (bundle_id, kind, class_key, model_pk, variant_name, class_label, market, year_from, year_to,
            image_url, image_source_pk, image_conf, content_hash, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const insBundleSource = ins("INSERT INTO bundle_source (bundle_id, local_id, source_pk) VALUES (?, ?, ?)");
        const insAlias = ins("INSERT OR IGNORE INTO alias (bundle_id, alias) VALUES (?, ?)");
        const insNote = ins("INSERT INTO bundle_note (bundle_id, seq, text) VALUES (?, ?, ?)");
        const insMeasure = ins("INSERT INTO measure (bundle_id, path, tol, qualifier, source_pk, conf, note) VALUES (?, ?, ?, ?, ?, ?, ?)");
        const insMeasureValue = ins("INSERT INTO measure_value (bundle_id, path, idx, value, source_value) VALUES (?, ?, ?, ?, ?)");
        const insCat = ins("INSERT INTO categorical (bundle_id, path, value, source_pk, conf, note) VALUES (?, ?, ?, ?, ?, ?)");
        const insPrior = ins("INSERT INTO prior (bundle_id, path, mean, sigma, source_mean, source_sigma, source_pk, conf, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        const insCurve = ins("INSERT INTO curve (bundle_id, kind, axis_start, axis_step, scale, sample_count, samples, method, source_pk, conf, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        const insFuel = ins("INSERT INTO fuel_compat (bundle_id, fuel_code, status, source_pk, conf, note, advisable) VALUES (?, ?, ?, ?, ?, ?, ?)");
        const insFts = ins("INSERT INTO bike_search (bundle_id, kind, title, aliases, keywords, make) VALUES (?, ?, ?, ?, ?, ?)");

        // Class defaults first (a variant's priors view joins to them), then variants; each sorted by id.
        for (const { source: b, compiled, hash } of bundles) {
            const srcPk = new Map(b.sources.map((s) => [s.id, pkFor(s)]));
            const isVariant = b.kind === "variant";
            const imgSrc = get(b, "media.image.src");
            insBundle(b.id, b.kind, b.classKey,
                isVariant ? modelFor(b.identity.make, b.identity.model) : null,
                isVariant ? b.identity.variant ?? null : null,
                isVariant ? null : [b.identity.model, b.identity.variant].filter(Boolean).join(" — "),
                b.identity.market, b.identity.yearFrom, b.identity.yearTo,
                compiled.image_url, imgSrc ? srcPk.get(imgSrc) : null, imgSrc ? get(b, "media.image.conf") : null,
                hash, b.schemaVersion);
            for (const [id, pk] of srcPk) insBundleSource(b.id, id, pk);
            for (const a of b.identity.aliases) insAlias(b.id, a);
            (b.notes || []).forEach((n, i) => insNote(b.id, i, n));

            for (const f of Contract.FIELDS) {
                const v = get(b, f.path);
                if (!isObj(v) || f.path === "media.image") continue;
                const where = `${b.id}:${f.path}`;
                if (f.type === "c") {
                    insCat(b.id, f.path, String(v.v), srcPk.get(v.src), v.conf, v.note ?? null);
                } else if (f.type === "q" || f.type === "qa") {
                    const qual = Object.keys(f.extra || {}).map((k) => v[k]).find((x) => x !== undefined) ?? null;
                    insMeasure(b.id, f.path, v.tol !== undefined ? siOf(v.tol, f.unit, where).value : null, qual, srcPk.get(v.src), v.conf, v.note ?? null);
                    const src = Array.isArray(v.v) ? v.v : [v.v];
                    const si = siOf(src, f.unit, where).value;
                    src.forEach((x, i) => insMeasureValue(b.id, f.path, i, si[i], x));
                } else if (f.type === "p") {
                    insPrior(b.id, f.path, siOf(v.mean, f.unit, where).value, siOf(v.sigma, f.unit, where).value, v.mean, v.sigma, srcPk.get(v.src), v.conf, v.note ?? null);
                }
            }
            for (const [kind, c] of Object.entries(compiled.curves || {})) {
                const blob = Buffer.alloc(c.data.length * 2);
                c.data.forEach((x, i) => blob.writeInt16LE(x, i * 2));
                insCurve(b.id, kind, c.axis_start, c.axis_step, c.scale, c.data.length, blob, c.method, srcPk.get(c.src), c.conf, c.note ?? null);
            }
            for (const c of (compiled.fuel && compiled.fuel.compat) || []) {
                insFuel(b.id, c.fuel, c.status, srcPk.get(c.src), c.conf, c.note ?? null, c.advisable ? 1 : 0);
            }
            const title = isVariant
                ? [b.identity.make, b.identity.model, b.identity.variant].filter(Boolean).join(" ")
                : [b.identity.model, b.identity.variant].filter(Boolean).join(" ");
            const names = [title, ...b.identity.aliases];
            insFts(b.id, b.kind, title, b.identity.aliases.join(" "),
                [...new Set(names.flatMap((n) => SearchKeys.keywordsFor(n)))].sort().join(" "),
                isVariant ? b.identity.make : "");
        }
        db.exec("COMMIT");

        const fk = db.prepare("PRAGMA foreign_key_check").all();
        if (fk.length) throw new BuildError(`foreign key violations: ${JSON.stringify(fk)}`);
        const bad = db.prepare("SELECT bundle_id, fuel_code, problem FROM fuel_compat_violation WHERE problem IS NOT NULL").all();
        if (bad.length) throw new BuildError(`fuel safety violations: ${JSON.stringify(bad)}`);
        db.exec("INSERT INTO bike_search (bike_search) VALUES ('optimize')");
        db.exec("VACUUM");
        const ok = db.prepare("PRAGMA integrity_check").get();
        if (!ok || Object.values(ok)[0] !== "ok") throw new BuildError(`integrity_check failed: ${JSON.stringify(ok)}`);
        return db;
    } catch (e) {
        db.close();
        fs.rmSync(file, { force: true });
        throw e;
    }
}

// ---------------------------------------------------------------------------
// catalog.json
// ---------------------------------------------------------------------------
const CATALOG_COLUMNS = ["id", "kind", "make", "model", "variant", "year_from", "year_to", "powertrain", "segment",
    "class_key", "image_url", "bundle", "displacement_m3", "peak_power_w", "battery_j", "mass_kg", "search"];

function catalogRow({ source: b, compiled, hash }) {
    const v = (p) => { const x = get(compiled, `${p}.v`); return typeof x === "number" ? x : null; };
    const isVariant = b.kind === "variant";
    return [
        b.id, b.kind,
        isVariant ? b.identity.make : null,
        b.identity.model,
        b.identity.variant ?? null,
        b.identity.yearFrom, b.identity.yearTo,
        b.powertrain, b.segment, b.classKey,
        compiled.image_url,
        hash,
        v("engine.displacement"),
        v("engine.peakPower") ?? v("motor.peakPower"),
        v("battery.grossCapacity"),
        v("chassis.mass"),
        SearchKeys.searchText([[isVariant ? b.identity.make : "", b.identity.model, b.identity.variant ?? ""].join(" "), ...b.identity.aliases])
    ];
}

function fuelGradesSI(fg) {
    return fg.grades.map((g) => ({
        code: g.code,
        ethanol_vol_fraction: g.ethanolVolFraction,
        flex_fuel_blend: !!g.flexFuelBlend,
        lhv_j_per_m3: siOf(g.lhv.v, g.lhv.u, `fuel-grades:${g.code}.lhv`).value,
        density_kg_per_m3: siOf(g.density.v, g.density.u, `fuel-grades:${g.code}.density`).value,
        typical_ron: g.typicalRon ? g.typicalRon.v : null
    }));
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------
const OUTPUT_ENTRIES = new Set(["bikes.sqlite", "catalog.json", "bundles"]);

/** The build replaces --out wholesale, so it must only ever be a previous build's output. */
function assertOwnOutput(outDir) {
    if (!fs.existsSync(outDir)) return;
    const foreign = fs.readdirSync(outDir).filter((f) => !OUTPUT_ENTRIES.has(f));
    if (foreign.length) throw new BuildError(`refusing to replace ${outDir}: it holds files the build didn't write (${foreign.slice(0, 5).join(", ")})`);
}
/**
 * @param {{ dataDir?: string, outDir?: string, log?: (s: string) => void }} [opts]
 */
export function build(opts = {}) {
    const dataDir = path.resolve(opts.dataDir || path.join(ROOT, "data/bikes"));
    const outDir = path.resolve(opts.outDir || path.join(ROOT, "dist/bikedb"));
    const log = opts.log || (() => {});

    // 1. load + validate: nothing invalid gets compiled
    const { entries, ref } = loadCatalog(dataDir);
    const pending = loadPending(dataDir);
    const report = Contract.validateCatalog(entries, ref);
    const errors = [...report.errors.map((e) => `catalog  ${e.code}  ${e.path}  ${e.message}`),
        ...report.perFile.flatMap((p) => p.result.errors.map((e) => `${p.file}  ${e.code}  ${e.path}  ${e.message}`))];
    if (errors.length) throw new BuildError(`validation failed — fix the data first (node scripts/bikedb/validate.mjs):\n  ${errors.join("\n  ")}`);
    const pendingIds = new Set(pending.map((p) => p.bundle && p.bundle.id));
    for (const e of entries) if (pendingIds.has(e.bundle.id)) throw new BuildError(`${e.bundle.id} is both in pending/ and in the catalog`);

    // 2. compile to SI and hash
    const defaults = new Map(entries.filter((e) => e.bundle.kind === "class_default").map((e) => [e.bundle.classKey, e.bundle]));
    const ordered = [...entries].sort((a, b) =>
        (a.bundle.kind === b.bundle.kind ? 0 : a.bundle.kind === "class_default" ? -1 : 1) || (a.bundle.id < b.bundle.id ? -1 : a.bundle.id > b.bundle.id ? 1 : 0));
    const bundles = ordered.map(({ bundle: b }) => {
        const compiled = compileBundle(b, b.kind === "variant" ? defaults.get(b.classKey) : null, ref);
        const bytes = Buffer.from(canonicalJson(compiled) + "\n");
        return { source: b, compiled, bytes, hash: hashOf(bytes).slice(0, HASH_HEX) };
    });
    const hashes = new Set(bundles.map((x) => x.hash));
    if (hashes.size !== bundles.length) throw new BuildError("two bundles hash to the same name");

    // 3. catalog.json (catalog_version = hash of everything else in it)
    const catalogBody = {
        format: BUILD_FORMAT,
        schema_version: Contract.SCHEMA_VERSION,
        units: "SI",
        columns: CATALOG_COLUMNS,
        rows: bundles.map(catalogRow),
        fuel_grades: fuelGradesSI(ref.fuelGrades)
    };
    const catalogVersion = hashOf(canonicalJson(catalogBody)).slice(0, HASH_HEX);
    const catalogBytes = Buffer.from(canonicalJson({ ...catalogBody, catalog_version: catalogVersion }) + "\n");

    // 4. write (into a staging dir, then swap, so a failed build never leaves a half-written catalog)
    assertOwnOutput(outDir);
    const stage = `${outDir}.tmp-${process.pid}`;
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(path.join(stage, "bundles"), { recursive: true });
    try {
        for (const x of bundles) fs.writeFileSync(path.join(stage, "bundles", `${x.hash}.json`), x.bytes);
        fs.writeFileSync(path.join(stage, "catalog.json"), catalogBytes);
        const db = writeDatabase(path.join(stage, "bikes.sqlite"), {
            bundles, ref,
            meta: {
                build_format: BUILD_FORMAT,
                schema_version: Contract.SCHEMA_VERSION,
                catalog_version: catalogVersion,
                unit_system: "SI",
                cert_min_conf: Contract.CERT_MIN_CONF,
                advise_min_conf: Contract.ADVISE_MIN_CONF
            }
        });
        // smoke-test the search the server will run
        const search = makeSearch(db);
        const probe = bundles.find((x) => x.source.kind === "variant");
        if (probe && !search(probe.source.identity.model).some((r) => r.id === probe.source.id)) {
            db.close();
            throw new BuildError(`search self-test failed: "${probe.source.identity.model}" doesn't find ${probe.source.id}`);
        }
        db.close();
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(outDir), { recursive: true });
        fs.renameSync(stage, outDir);
    } catch (e) {
        fs.rmSync(stage, { recursive: true, force: true });
        throw e;
    }

    const variants = bundles.filter((x) => x.source.kind === "variant");
    const withImage = variants.filter((x) => x.compiled.image_url).length;
    const summary = {
        outDir,
        catalogVersion,
        variants: variants.length,
        classDefaults: bundles.length - variants.length,
        pending: pending.length,
        withImage,
        catalogBytes: catalogBytes.length,
        catalogGzipBytes: zlib.gzipSync(catalogBytes, { level: 9 }).length,
        sqliteBytes: fs.statSync(path.join(outDir, "bikes.sqlite")).size,
        warnings: report.warnings.length + report.perFile.reduce((n, p) => n + p.result.warnings.length, 0)
    };
    log(`bike catalog ${catalogVersion} -> ${path.relative(process.cwd(), outDir) || "."}/`);
    log(`  ${summary.variants} variants, ${summary.classDefaults} class defaults (${summary.pending} pending, not compiled)`);
    log(`  catalog.json ${summary.catalogBytes} B (${summary.catalogGzipBytes} B gzipped), bikes.sqlite ${summary.sqliteBytes} B, ${bundles.length} bundles`);
    log(`  image_url sourced for ${withImage}/${variants.length} variants${withImage < variants.length ? " (the rest show the segment silhouette until one is sourced)" : ""}`);
    if (summary.warnings) log(`  ${summary.warnings} validation warning(s): node scripts/bikedb/validate.mjs`);
    return summary;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    try {
        build({ dataDir: opt("--data"), outDir: opt("--out"), log: args.includes("--quiet") ? () => {} : console.log });
    } catch (e) {
        console.error(`build-bike-catalog: ${e instanceof BuildError ? e.message : e.stack}`);
        process.exit(1);
    }
}
