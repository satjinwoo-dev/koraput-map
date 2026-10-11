// @ts-check
/* ============================================================================
   MapUnite Master AI — perception governor (how hard the camera AI may run)
   ==============================================================================
   Pure policy: phone state in, target frame rate out. JS decides, the native
   pipeline obeys (setTargetFps). Keeping the decision here means it's tested
   and tunable without an app release; native only reports what it measures.

   PERFORMANCE PROFILE (Phase 2): full rate whenever the phone can sustain it.
   Handlebar airflow keeps most rides at "none" to "moderate"; only the levels
   where Android itself throttles the CPU and may shut the camera slow it down.

   Rules (first match wins):
     critical heat         → 0 fps (paused) until it cools to "moderate"
     severe heat           → 15 fps
     quality.usable < 0.3  → 10 fps (night, rain on the lens: less to gain)
     standing still        → 10 fps (tracks stay alive at a signal)
     battery < 15 %, not charging → 15 fps (navigation must last the ride)
     otherwise (none, light, moderate heat) → target (30)
   Hysteresis: once paused for heat, it stays paused until "moderate" or
   cooler, so it doesn't flap at the edge.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); const M = W.MUMaster || (W.MUMaster = {}); (M.perception || (M.perception = {})).governor = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const RANK = { none: 0, light: 1, moderate: 2, severe: 3, critical: 4 };

    /**
     * @param {{ thermal?: string, speedMs?: number, usable?: number, batteryPct?: number|null, charging?: boolean, target?: number }} s
     * @param {{ paused?: boolean }} [prev] the previous decision (for hysteresis)
     * @returns {{ fps: number, reason: string, paused: boolean }}
     */
    function decide(s, prev = {}) {
        const target = Number.isFinite(s.target) ? /** @type {number} */ (s.target) : 30;
        const heat = /** @type {any} */ (RANK)[s.thermal || "none"] ?? 0;
        if (heat >= 4 || (prev.paused && heat >= 3)) return { fps: 0, reason: "heat-critical", paused: true };
        if (heat === 3) return { fps: Math.min(15, target), reason: "heat-severe", paused: false };
        if (Number.isFinite(s.usable) && /** @type {number} */ (s.usable) < 0.3) return { fps: Math.min(10, target), reason: "poor-view", paused: false };
        if (Number.isFinite(s.speedMs) && /** @type {number} */ (s.speedMs) < 1) return { fps: Math.min(10, target), reason: "standing", paused: false };
        if (Number.isFinite(s.batteryPct) && /** @type {number} */ (s.batteryPct) < 15 && !s.charging) return { fps: Math.min(15, target), reason: "battery", paused: false };
        return { fps: target, reason: "full", paused: false };
    }

    return { decide, RANK };
});
