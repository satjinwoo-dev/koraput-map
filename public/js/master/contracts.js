// @ts-check
/* ============================================================================
   MapUnite Master AI — contracts (load first)
   ==============================================================================
   The shared language of the Master AI and every sub-agent. Nothing here does
   anything: it defines shapes, numbers and names, and checks them. Agents and
   the Master only ever talk through these shapes, so a new agent never needs
   to know how another one works.

   - API_VERSION     the agent contract version. An agent declares the version
                     it was written for; the kernel refuses a mismatch instead
                     of half-running it.
   - SEVERITY        critical / warning / advice / info, mapped onto the
                     numeric priorities the advice gate (js/advice/gate.js)
                     already understands: critical ≥ 85, warning 60–84,
                     advice 20–59, info < 20.
   - TOPIC           bus topic names (see bus.js for the pattern syntax).
   - normalizeReport an agent's loose report → one frozen, complete Report.
   - validateAgent   checks an agent definition before the kernel accepts it.

   Also installs MUMaster.define() as a buffer, so agent files can load in any
   order before master-app.js boots the kernel.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else {
        const W = /** @type {any} */ (root);
        const ns = W.MUMaster || (W.MUMaster = {});
        ns.contracts = factory();
        if (typeof ns.define !== "function") {
            const pending = ns._pending || (ns._pending = []);
            ns.define = (/** @type {any} */ def) => { pending.push(def); return true; };
        }
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const API_VERSION = 1;

    /** Default numeric priority per severity (the gate's language). */
    const SEVERITY = Object.freeze({ critical: 90, warning: 70, advice: 45, info: 10 });
    /** Allowed priority band per severity: [min, max]. */
    const BANDS = Object.freeze({ critical: [85, 100], warning: [60, 84], advice: [20, 59], info: [0, 19] });
    const SEVERITIES = Object.freeze(["critical", "warning", "advice", "info"]);
    const RANK = Object.freeze({ critical: 3, warning: 2, advice: 1, info: 0 });

    /** How long a report stays worth saying (ms). A stale warning is noise. */
    const DEFAULT_TTL = Object.freeze({ critical: 15000, warning: 60000, advice: 180000, info: 30000 });
    /** How long before the same key may be said again (ms). */
    const DEFAULT_COOLDOWN = Object.freeze({ critical: 10000, warning: 120000, advice: 300000, info: 60000 });

    const TOPIC = Object.freeze({
        /** An agent's report: report.<agentId>.<kind> (kind may contain dots). */
        report: (/** @type {string} */ agentId, /** @type {string} */ kind) => `report.${agentId}.${kind}`,
        /** Shared world state, sticky (latest value kept): state.<name>. */
        state: (/** @type {string} */ name) => `state.${name}`,
        /** A delegated job with one responder: task.<name>. */
        task: (/** @type {string} */ name) => `task.${name}`,
        lifecycle: "agent.lifecycle",
        decision: "master.decision",
        said: "master.said",
        busError: "bus.error"
    });

    const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
    const KIND_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
    const SEMVER_RE = /^\d+\.\d+\.\d+([-+].*)?$/;

    /** @param {number} p @returns {"critical"|"warning"|"advice"|"info"} */
    function severityOf(p) {
        if (p >= 85) return "critical";
        if (p >= 60) return "warning";
        if (p >= 20) return "advice";
        return "info";
    }
    const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.min(hi, Math.max(lo, v));
    const isObj = (/** @type {any} */ v) => v !== null && typeof v === "object" && !Array.isArray(v);

    /**
     * @typedef {{
     *   id: string, kind: string, source: string, severity: "critical"|"warning"|"advice"|"info",
     *   priority: number, key: string, category: string, data: Record<string, any>, text: string|null,
     *   confidence: number, speak: boolean, ridingOnly: boolean, at: number, ttlMs: number,
     *   expiresAt: number, cooldownMs: number
     * }} Report
     */

    let seq = 0;
    /**
     * Turns what an agent sent into a complete, frozen Report.
     *   required: kind ("network.weak")
     *   optional: severity | priority, key, category, data, text, confidence,
     *             speak, ridingOnly, ttlMs, cooldownMs
     * @param {any} input
     * @param {{ source?: string, now?: number }} [o]
     * @returns {{ ok: true, report: Report, errors: string[] } | { ok: false, report: null, errors: string[] }}
     */
    function normalizeReport(input, o = {}) {
        const errors = [];
        if (!isObj(input)) return { ok: false, report: null, errors: ["report must be an object"] };
        const kind = typeof input.kind === "string" ? input.kind : "";
        if (!KIND_RE.test(kind)) errors.push(`bad kind "${kind}" (lowercase, dotted: "network.weak")`);
        let severity = SEVERITIES.includes(input.severity) ? input.severity : null;
        if (input.severity != null && !severity) errors.push(`bad severity "${input.severity}"`);
        const p = Number(input.priority);
        if (!severity) severity = Number.isFinite(p) ? severityOf(p) : "info";
        const band = BANDS[/** @type {keyof typeof BANDS} */ (severity)];
        const priority = Number.isFinite(p) ? clamp(Math.round(p), band[0], band[1]) : SEVERITY[/** @type {keyof typeof SEVERITY} */ (severity)];
        if (input.data != null && !isObj(input.data)) errors.push("data must be an object");
        if (errors.length) return { ok: false, report: null, errors };
        const now = Number.isFinite(o.now) ? /** @type {number} */ (o.now) : Date.now();
        const ttlMs = Number.isFinite(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : DEFAULT_TTL[/** @type {keyof typeof DEFAULT_TTL} */ (severity)];
        const cooldownMs = Number.isFinite(input.cooldownMs) && input.cooldownMs >= 0 ? input.cooldownMs : DEFAULT_COOLDOWN[/** @type {keyof typeof DEFAULT_COOLDOWN} */ (severity)];
        /** @type {Report} */
        const report = Object.freeze({
            id: `r${++seq}`,
            kind,
            source: String(o.source || input.source || "unknown"),
            severity: /** @type {Report["severity"]} */ (severity),
            priority,
            key: typeof input.key === "string" && input.key ? input.key : kind,
            category: typeof input.category === "string" && input.category ? input.category : kind.split(".")[0],
            data: Object.freeze({ ...(input.data || {}) }),
            text: typeof input.text === "string" && input.text.trim() ? input.text.trim().slice(0, 240) : null,
            confidence: Number.isFinite(input.confidence) ? clamp(input.confidence, 0, 1) : 1,
            speak: typeof input.speak === "boolean" ? input.speak : severity !== "info",
            ridingOnly: Boolean(input.ridingOnly),
            at: now,
            ttlMs,
            expiresAt: now + ttlMs,
            cooldownMs
        });
        return { ok: true, report, errors: [] };
    }

    /**
     * Checks an agent definition (see agents/_template.js for every field).
     * @param {any} def
     * @returns {{ ok: boolean, errors: string[] }}
     */
    function validateAgent(def) {
        const errors = [];
        if (!isObj(def)) return { ok: false, errors: ["agent definition must be an object"] };
        if (!ID_RE.test(def.id || "")) errors.push(`bad id "${def.id}" (lowercase letters, digits, dashes)`);
        if (!SEMVER_RE.test(def.version || "")) errors.push(`bad version "${def.version}" (semver: "1.0.0")`);
        if (def.apiVersion !== API_VERSION) errors.push(`apiVersion ${def.apiVersion} is not supported (this build speaks ${API_VERSION})`);
        if (typeof def.start !== "function") errors.push("start(ctx) is required");
        if (def.stop != null && typeof def.stop !== "function") errors.push("stop must be a function");
        for (const k of ["requires", "optional", "depends"]) {
            if (def[k] != null && (!Array.isArray(def[k]) || def[k].some((/** @type {any} */ x) => typeof x !== "string"))) errors.push(`${k} must be an array of strings`);
        }
        if (def.runWhen != null && !(isObj(def.runWhen) && typeof def.runWhen.topic === "string" && typeof def.runWhen.test === "function")) errors.push("runWhen must be { topic, test(value) }");
        if (def.heartbeatMs != null && !(Number.isFinite(def.heartbeatMs) && def.heartbeatMs >= 1000)) errors.push("heartbeatMs must be ≥ 1000");
        if (def.defaults != null && !isObj(def.defaults)) errors.push("defaults must be an object");
        return { ok: errors.length === 0, errors };
    }

    return {
        API_VERSION, SEVERITY, BANDS, SEVERITIES, RANK, DEFAULT_TTL, DEFAULT_COOLDOWN, TOPIC,
        ID_RE, KIND_RE, severityOf, normalizeReport, validateAgent
    };
});
