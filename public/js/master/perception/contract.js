// @ts-check
/* ============================================================================
   MapUnite Master AI — perception contract v1 (the model ⇄ app boundary)
   ==============================================================================
   The unified multitask road model runs NATIVELY (camera → NPU → tracking →
   sensor fusion, all in Kotlin/Java; see PERCEPTION.md). The WebView never
   sees pixels. It receives one small JSON PerceptionFrame per tick, ~10 per
   second, in exactly this shape. Train any model, swap any backbone: as
   long as the native side emits this, nothing in JS changes.

   EVERY NUMBER CARRIES ITS UNCERTAINTY. A distance without a sigma, a class
   without a calibrated confidence, is rejected here. Agents decide on
   (value, uncertainty, persistence over frames), never on one frame.

   PerceptionFrame {
     v: 1,                       contract version
     t: ms epoch                 capture time of the camera frame (not emit time)
     seq: integer                increasing frame counter
     model: { id, version, calib }    which weights and which camera calibration
     perf: { fps, latencyMs, thermal: "none"|"light"|"moderate"|"severe"|"critical", delegate: "npu"|"gpu"|"cpu" }
     ego: { speedMs, speedSigma, headingDeg, pitchDeg, rollDeg, lat?, lng?, posSigmaM? }   fused (GNSS + IMU + visual odometry)
     quality: { usable: 0..1, reasons: string[] }   "night", "rain-on-lens", "glare", "blur", "occluded", "mount-moved"
     objects:   [{ id, cls, conf, box: [x, y, w, h] (0..1), distM, distSigma, closingMs, closingSigma, ttcS|null, lane: "ego"|"left"|"right"|"oncoming"|"unknown" }]
     hazards:   [{ id, cls, conf, box, distM, distSigma, lateralM, lateralSigma, sizeM?|null, lat?, lng?, posSigmaM? }]
     relations: [{ subj: objectId, rel, obj: objectId|"ego"|null, conf }]
   }
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); const M = W.MUMaster || (W.MUMaster = {}); (M.perception || (M.perception = {})).contract = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const VERSION = 1;

    /** Road users, bike-mount view, Indian roads. Order = the model's class index. */
    const OBJECTS = Object.freeze([
        "two_wheeler", "auto_rickshaw", "e_rickshaw", "car", "suv", "bus", "truck", "tractor", "lcv",
        "cyclist", "pedestrian", "handcart", "cattle", "dog", "other_animal"
    ]);
    /** Road surface and obstacles. */
    const HAZARDS = Object.freeze([
        "pothole", "waterlogging", "speed_breaker_marked", "speed_breaker_unmarked", "rumble_strip",
        "gravel_sand", "road_work", "open_manhole", "debris", "broken_edge", "wet_patch", "oil_or_mud"
    ]);
    /** Relations the relation head may emit (about traffic behaviour, never identity). */
    const RELATIONS = Object.freeze([
        "cutting_in", "wrong_side", "overtaking_ego", "braking_hard", "door_opening", "crossing_path",
        "stopped_in_lane", "reversing", "following_ego"
    ]);
    const THERMAL = Object.freeze(["none", "light", "moderate", "severe", "critical"]);
    const LANES = Object.freeze(["ego", "left", "right", "oncoming", "unknown"]);
    const QUALITY = Object.freeze(["night", "rain-on-lens", "glare", "blur", "occluded", "mount-moved", "low-light", "fog"]);

    const fin = (/** @type {any} */ v) => typeof v === "number" && Number.isFinite(v);
    const prob = (/** @type {any} */ v) => fin(v) && v >= 0 && v <= 1;
    const box = (/** @type {any} */ b) => Array.isArray(b) && b.length === 4 && b.every((x) => fin(x) && x >= -0.05 && x <= 1.05) && b[2] > 0 && b[3] > 0;
    const sigma = (/** @type {any} */ v) => fin(v) && v >= 0;

    /**
     * Strict check of one frame. Invalid items are dropped (with a reason) rather than
     * the whole frame, so one bad detection never blinds the agents.
     * @param {any} f
     * @returns {{ ok: boolean, frame: any, errors: string[], dropped: number }}
     */
    function validateFrame(f) {
        const errors = [];
        if (!f || typeof f !== "object") return { ok: false, frame: null, errors: ["frame must be an object"], dropped: 0 };
        if (f.v !== VERSION) errors.push(`contract v${f.v} is not v${VERSION}`);
        if (!fin(f.t) || f.t <= 0) errors.push("t (capture time, ms) is required");
        if (!Number.isInteger(f.seq) || f.seq < 0) errors.push("seq must be a non-negative integer");
        if (!f.model || typeof f.model.id !== "string" || typeof f.model.version !== "string") errors.push("model { id, version } is required");
        const perf = f.perf || {};
        if (!fin(perf.fps) || !fin(perf.latencyMs) || !THERMAL.includes(perf.thermal)) errors.push("perf { fps, latencyMs, thermal } is required");
        const ego = f.ego || {};
        if (!fin(ego.speedMs) || !sigma(ego.speedSigma)) errors.push("ego { speedMs, speedSigma } is required");
        const q = f.quality || {};
        if (!prob(q.usable)) errors.push("quality.usable must be 0..1");
        if (errors.length) return { ok: false, frame: null, errors, dropped: 0 };

        let dropped = 0;
        const keep = (/** @type {any[]} */ list, /** @type {(x: any) => string|null} */ check, /** @type {string} */ what) => (Array.isArray(list) ? list : []).filter((x) => {
            const why = check(x);
            if (why) { dropped++; if (errors.length < 20) errors.push(`${what}: ${why}`); return false; }
            return true;
        });
        const objects = keep(f.objects, (o) => {
            if (!o || (typeof o.id !== "number" && typeof o.id !== "string")) return "id required";
            if (!OBJECTS.includes(o.cls)) return `unknown class "${o.cls}"`;
            if (!prob(o.conf)) return "conf must be 0..1";
            if (!box(o.box)) return "box must be [x, y, w, h] in 0..1";
            if (!fin(o.distM) || !sigma(o.distSigma)) return "distM + distSigma required";
            if (!fin(o.closingMs) || !sigma(o.closingSigma)) return "closingMs + closingSigma required";
            if (o.ttcS !== null && o.ttcS !== undefined && !(fin(o.ttcS) && o.ttcS >= 0)) return "ttcS must be ≥ 0 or null";
            if (o.lane !== undefined && !LANES.includes(o.lane)) return `unknown lane "${o.lane}"`;
            return null;
        }, "object");
        const hazards = keep(f.hazards, (h) => {
            if (!h || (typeof h.id !== "number" && typeof h.id !== "string")) return "id required";
            if (!HAZARDS.includes(h.cls)) return `unknown class "${h.cls}"`;
            if (!prob(h.conf)) return "conf must be 0..1";
            if (!box(h.box)) return "box must be [x, y, w, h] in 0..1";
            if (!fin(h.distM) || !sigma(h.distSigma)) return "distM + distSigma required";
            if (!fin(h.lateralM) || !sigma(h.lateralSigma)) return "lateralM + lateralSigma required";
            return null;
        }, "hazard");
        const ids = new Set(objects.map((o) => String(o.id)));
        const relations = keep(f.relations, (r) => {
            if (!r || !RELATIONS.includes(r.rel)) return `unknown relation "${r && r.rel}"`;
            if (!ids.has(String(r.subj))) return "subj must be an object id in this frame";
            if (!prob(r.conf)) return "conf must be 0..1";
            return null;
        }, "relation");
        return {
            ok: true, errors, dropped,
            frame: {
                v: f.v, t: f.t, seq: f.seq, model: f.model, perf, ego,
                quality: { usable: q.usable, reasons: Array.isArray(q.reasons) ? q.reasons.filter((/** @type {any} */ r) => QUALITY.includes(r)) : [] },
                objects, hazards, relations
            }
        };
    }

    return { VERSION, OBJECTS, HAZARDS, RELATIONS, THERMAL, LANES, QUALITY, validateFrame };
});
