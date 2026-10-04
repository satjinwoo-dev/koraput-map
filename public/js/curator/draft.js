// @ts-check
/* ============================================================================
   MapUnite curator — drafts of bike data files (pure)
   ==============================================================================
   A draft IS a data/bikes source file: published units, every value with its
   source and confidence, exactly what scripts/bikedb/validate.mjs checks. The
   form is generated from the contract (BikeContract.FIELDS), so the curator can
   never offer a field, unit or value the contract would reject.

     formSections(contract, powertrain)   the editable fields, grouped, in order
     newDraft(contract, request, makes)   a skeleton from a rider's request
     guessIdentity(text, makes)           "Bajaj Avenger 220 Street, 2023" → make / model / year
     slugId(identity)                     the file id (lowercase slug, ≤ 80)
     getValue / setValue                  read and write a field (keeps src/conf/note)
     convertPower(v, unit)                PS / hp → kW, with the note the contract asks for
     toRuntime(contract, draft, classRt)  an SI runtime bundle for the physics preview
     preview(physics, runtime, classRt)   km/L at 40/60/80, eco band, top speed vs published,
                                          range, and how it compares with the class default
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUCurator || (/** @type {any} */ (root).MUCurator = {}); ns.draft = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const SECTION_ORDER = ["engine", "motor", "battery", "transmission", "chassis", "emission", "fuel"];
    const SECTION_TITLE = { engine: "Engine", motor: "Motor", battery: "Battery", transmission: "Transmission", chassis: "Chassis", emission: "Emission", fuel: "Fuel" };
    const LABELS = {
        "engine.displacement": "Displacement", "engine.cylinders": "Cylinders", "engine.strokes": "Strokes", "engine.bore": "Bore", "engine.stroke": "Stroke",
        "engine.compressionRatio": "Compression ratio", "engine.cooling": "Cooling", "engine.fuelSystem": "Fuel system", "engine.flexFuel": "Flex-fuel certified",
        "engine.peakPower": "Peak power", "engine.peakPowerRpm": "at", "engine.peakTorque": "Peak torque", "engine.peakTorqueRpm": "at", "engine.idleRpm": "Idle",
        "engine.redlineRpm": "Redline", "engine.limiterRpm": "Limiter", "motor.type": "Motor type", "motor.mount": "Mount", "motor.peakPower": "Peak power",
        "motor.ratedPower": "Rated power", "motor.peakTorque": "Peak torque", "battery.grossCapacity": "Installed capacity", "battery.usableCapacity": "Usable capacity",
        "battery.nominalVoltage": "Nominal voltage", "battery.chemistry": "Chemistry", "battery.certifiedRange": "Certified range", "transmission.kind": "Transmission",
        "transmission.speeds": "Gears", "transmission.primaryRatio": "Primary ratio", "transmission.gearRatios": "Gear ratios", "transmission.finalRatio": "Final ratio",
        "transmission.frontSprocket": "Front sprocket", "transmission.rearSprocket": "Rear sprocket", "transmission.cvtRatioMax": "CVT ratio (low)", "transmission.cvtRatioMin": "CVT ratio (high)",
        "transmission.drive": "Final drive", "transmission.reductionRatio": "Reduction ratio", "chassis.mass": "Mass", "chassis.fuelTank": "Fuel tank", "chassis.frontTyre": "Front tyre",
        "chassis.rearTyre": "Rear tyre", "chassis.topSpeed": "Top speed", "emission.standard": "Emission standard", "emission.obd": "OBD stage", "fuel.minRon": "Minimum octane"
    };
    const UNIT_LABEL = { cm3: "cc", "N*m": "Nm", "1": "", RON: "RON" };
    const SUGGEST = { "emission.standard": ["BS4", "BS6-P1", "BS6-P2"], "emission.obd": ["OBD-1", "OBD-2A", "OBD-2B"], "battery.chemistry": ["li_ion", "lfp", "nmc", "lead_acid"] };
    const FUELS = ["E0", "E10", "E20", "E85", "E100"];
    const CONF_DEFAULT = { manufacturer: 0.9, owners_manual: 0.8, service_manual: 0.8, homologation: 0.9, licensed_db: 0.85, aggregator: 0.6, press: 0.6, community: 0.4, regulation: 0.9, derived: 0.7, estimated: 0.4, class_prior: 0.35 };

    /**
     * The editable fields for a powertrain, grouped and ordered as in the contract.
     * @param {any} contract BikeContract  @param {string} powertrain
     * @returns {Array<{ key: string, title: string, fields: any[] }>}
     */
    function formSections(contract, powertrain) {
        const out = [];
        for (const sec of SECTION_ORDER) {
            const fields = contract.FIELDS.filter((f) => f.path.startsWith(`${sec}.`) && f.allow.includes(powertrain)).map((f) => ({
                path: f.path, type: f.type, unit: f.unit || "", unitLabel: f.unit in UNIT_LABEL ? UNIT_LABEL[f.unit] : f.unit || "",
                label: LABELS[f.path] || f.path.split(".")[1], doc: f.doc || "", range: f.range || null, int: !!f.int, enumV: f.enumV || null,
                required: !!(f.req && f.req.includes(powertrain)), recommended: !!(f.reqDefault && f.reqDefault.includes(powertrain)),
                extra: f.extra || null, suggest: SUGGEST[f.path] || null, fixed: f.path === "transmission.kind"
            }));
            if (fields.length || sec === "fuel") out.push({ key: sec, title: SECTION_TITLE[sec], fields });
        }
        return out;
    }

    /**
     * @param {string} text  @param {string[]} makes known makes (catalogue)
     * @returns {{ make: string, model: string, variant: string, yearFrom: number|null }}
     */
    function guessIdentity(text, makes) {
        let t = String(text || "").replace(/\s+/g, " ").trim();
        let yearFrom = null;
        const ym = t.match(/\b(19[89]\d|20[0-4]\d)\b/);
        if (ym) { yearFrom = Number(ym[1]); t = t.replace(ym[0], " ").replace(/\s*,\s*$/, "").replace(/\s+/g, " ").trim(); }
        const low = t.toLowerCase();
        const sorted = [...(makes || [])].sort((a, b) => b.length - a.length);
        let make = "";
        for (const m of sorted) {
            const ml = m.toLowerCase();
            if (low === ml || low.startsWith(`${ml} `)) { make = m; t = t.slice(m.length).trim(); break; }
        }
        if (!make) { const first = t.split(" ")[0] || ""; make = first ? first.charAt(0).toUpperCase() + first.slice(1) : ""; t = t.slice(first.length).trim(); }
        const parts = t.split(/\s*,\s*/);
        return { make, model: (parts[0] || "").trim(), variant: parts.slice(1).join(", ").trim(), yearFrom };
    }

    /** Lowercase slug id from the identity (make-model-variant-market). @param {any} idn */
    function slugId(idn) {
        const s = [idn.make, idn.model, idn.variant, idn.market].filter(Boolean).join(" ").toLowerCase()
            .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\+/g, " plus ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        return s.slice(0, 80).replace(/-+$/, "");
    }

    /** A source id from its publisher and title. @param {{ publisher?: string, title?: string, kind?: string }} s @param {string[]} taken */
    function sourceId(s, taken = []) {
        const base = [s.publisher, s.title].filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || s.kind || "source";
        let id = base, n = 2;
        while (taken.includes(id)) id = `${base}-${n++}`;
        return id;
    }

    /**
     * Skeleton draft for a request.
     * @param {any} contract @param {{ description?: string, classKey?: string|null }} req @param {string[]} makes @param {string} [today] YYYY-MM-DD
     */
    function newDraft(contract, req, makes, today) {
        const classKey = req.classKey && /^[a-z_]+\.[a-z_]+$/.test(req.classKey) ? req.classKey : "ice_manual.commuter";
        const [powertrain, segment] = classKey.split(".");
        const g = guessIdentity(req.description || "", makes);
        const identity = { make: g.make, model: g.model, variant: g.variant || "", market: "IN", yearFrom: g.yearFrom || Number((today || "2026").slice(0, 4)), yearTo: null, aliases: [] };
        const d = {
            $schema: "../../../lib/bikedb/bundle.schema.json", schemaVersion: contract.SCHEMA_VERSION, id: "", kind: "variant", classKey, segment, powertrain,
            identity, sources: [], notes: []
        };
        d.id = slugId(identity);
        d.transmission = { kind: { v: contract.TRANSMISSION_FOR[powertrain] } };
        if (powertrain !== "ev") d.fuel = { compat: [] };
        return d;
    }

    /** @param {any} d @param {string} path */
    function getValue(d, path) {
        const [g, k] = path.split(".");
        return d[g] ? d[g][k] : undefined;
    }

    /**
     * Write one field. value === "" / null removes it. Numbers stay numbers; gear ratios are an array.
     * @param {any} d @param {string} path @param {any} value @param {{ src?: string, conf?: number, note?: string, tol?: number|null, basis?: string, unit?: string }} [meta]
     */
    function setValue(d, path, value, meta = {}) {
        const [g, k] = path.split(".");
        const empty = value === "" || value === null || value === undefined || (Array.isArray(value) && !value.length);
        if (empty) {
            if (d[g]) { delete d[g][k]; if (!Object.keys(d[g]).length && g !== "transmission") delete d[g]; }
            return d;
        }
        d[g] = d[g] || {};
        const prev = d[g][k] || {};
        const cell = { v: value };
        if (meta.unit) cell.u = meta.unit;
        const src = meta.src !== undefined ? meta.src : prev.src;
        const conf = meta.conf !== undefined ? meta.conf : prev.conf;
        if (src) cell.src = src;
        if (Number.isFinite(conf)) cell.conf = conf;
        const tol = meta.tol !== undefined ? meta.tol : prev.tol;
        if (Number.isFinite(tol) && tol !== null) cell.tol = tol;
        const basis = meta.basis !== undefined ? meta.basis : prev.basis;
        if (basis) cell.basis = basis;
        const note = meta.note !== undefined ? meta.note : prev.note;
        if (note) cell.note = note;
        d[g][k] = cell;
        return d;
    }

    /**
     * Power as published in PS or hp → kW, and the note the contract wants.
     * @param {number} v @param {"kW"|"PS"|"hp"|"bhp"} unit
     */
    function convertPower(v, unit) {
        if (unit === "kW") return { kw: v, note: "" };
        const f = unit === "PS" ? 0.73549875 : 0.745699872;
        const kw = Math.round(v * f * 100) / 100;
        return { kw, note: `Published as ${v} ${unit}; converted at ${unit === "PS" ? "0.7355" : "0.7457"} kW/${unit}` };
    }

    /** Default confidence for a source kind (capped as the contract caps it). @param {any} contract @param {string} kind */
    function defaultConf(contract, kind) {
        const c = CONF_DEFAULT[kind] ?? 0.6;
        return Math.min(c, contract.CONF_CAP[kind] ?? 1);
    }

    /**
     * An SI runtime bundle from the draft, for the physics preview: values converted with the
     * contract's own toSI, priors and reference data taken from the class default's bundle.
     * @param {any} contract @param {any} d draft @param {any} classRt the class default runtime bundle (SI)
     */
    function toRuntime(contract, d, classRt) {
        const rt = { format: "mapunite-bike-bundle/1", schemaVersion: d.schemaVersion, id: d.id || "draft", kind: "variant", classKey: d.classKey, segment: d.segment, powertrain: d.powertrain, units: "SI", identity: d.identity, image_url: d.image ? d.image.url : null, sources: d.sources };
        const byPath = new Map(contract.FIELDS.map((f) => [f.path, f]));
        for (const g of ["engine", "motor", "battery", "transmission", "chassis", "emission", "fuel"]) {
            if (!d[g]) continue;
            const out = {};
            for (const [k, q] of Object.entries(d[g])) {
                const f = byPath.get(`${g}.${k}`);
                if (f && (f.type === "q" || f.type === "qa") && q && q.v !== undefined) {
                    try { out[k] = { ...q, v: contract.toSI(q.v, f.unit), u: contract.siUnit(f.unit), published: { v: q.v, u: f.unit } }; } catch { /* bad value: the validator says why */ }
                } else out[k] = q;
            }
            rt[g] = out;
        }
        rt.priors = {};
        if (classRt && classRt.priors) for (const [k, p] of Object.entries(classRt.priors)) rt.priors[k] = { ...p, inherited: true };
        if (classRt && classRt.reference) rt.reference = classRt.reference;
        rt.fuelAdvice = { minConf: contract.ADVISE_MIN_CONF, advisable: [] };
        rt.classDefault = classRt ? { id: classRt.id, sources: classRt.sources || [] } : null;
        return rt;
    }

    /**
     * What the physics makes of the draft.
     * @param {any} physics MUPhysics @param {any} rt toRuntime() @param {any} classRt
     * @returns {{ ok: boolean, error?: string, ev?: boolean, at?: Array<{ kmh: number, value: number|null }>, eco?: any, top?: number|null, published?: number|null,
     *   range?: number|null, classAt?: Array<{ kmh: number, value: number|null }>, curve?: Array<[number, number|null]>, flags?: string[] }}
     */
    function preview(physics, rt, classRt) {
        let m;
        try { m = physics.createBikeModel(rt, { classDefault: classRt }); } catch (e) { return { ok: false, error: /** @type {Error} */ (e).message }; }
        const ev = m.powertrain === "ev";
        const val = (pm) => (pm === null || !(pm > 0) ? null : ev ? pm / 3.6 : 1 / (pm * 1e6));        // Wh/km or km/L
        const t = physics.cruiseTable(m, { grade: 0 }, { sigma: false, step: 1 });
        const at = [40, 60, 80].map((kmh) => { const i = Math.round(kmh / 3.6); return { kmh, value: i < t.speed.length && t.feasible[i] ? val(t.perMetre[i]) : null }; });
        let classAt = null;
        try {
            if (classRt) { const cm = physics.createBikeModel(classRt); const ct = physics.cruiseTable(cm, { grade: 0 }, { sigma: false, step: 1 }); classAt = [40, 60, 80].map((kmh) => { const i = Math.round(kmh / 3.6); return { kmh, value: i < ct.speed.length && ct.feasible[i] ? val(ct.perMetre[i]) : null }; }); }
        } catch { classAt = null; }
        const top = physics.maxSpeed(m, { grade: 0 });
        const published = rt.chassis && rt.chassis.topSpeed ? rt.chassis.topSpeed.v : null;
        /** @type {Array<[number, number|null]>} */ const curve = [];
        for (let i = 2; i < t.speed.length; i++) curve.push([t.speed[i] * 3.6, t.feasible[i] ? val(t.perMetre[i]) : null]);
        let range = null;
        if (!ev && rt.chassis && rt.chassis.fuelTank && t.eco) range = rt.chassis.fuelTank.v / t.eco.perMetreBest;
        if (ev && m.battery && t.eco) range = (m.battery.usable !== null ? m.battery.usable : m.battery.gross * 0.92) / t.eco.perMetreBest;
        return { ok: true, ev, at, eco: t.eco ? { low: t.eco.speedLow * 3.6, high: t.eco.speedHigh * 3.6, best: val(t.eco.perMetreBest) } : null, top: top * 3.6, published: published !== null ? published * 3.6 : null, range, classAt, curve, flags: m.flags.slice() };
    }

    /**
     * Rules for APPROVAL on top of the bundle contract (which still allows a bundle without a
     * picture, e.g. class defaults and pending files). Approved bikes are the premium catalogue:
     * each must ship a real image_url, never the class silhouette. Pure.
     * @param {any} d the draft / bundle @returns {Array<{ path: string, code: string, message: string }>}
     */
    function approvalErrors(d) {
        const out = [];
        const url = d && d.image && typeof d.image.url === "string" ? d.image.url.trim() : "";
        if (!url) out.push({ path: "image.url", code: "picture_required", message: "A picture is required to approve: add an https image_url and the source that published it" });
        return out;
    }

    return { SECTION_ORDER, FUELS, LABELS, formSections, guessIdentity, slugId, sourceId, newDraft, getValue, setValue, convertPower, defaultConf, toRuntime, preview, approvalErrors };
});
