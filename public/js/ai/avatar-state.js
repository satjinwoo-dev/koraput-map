// @ts-check
/* ============================================================================
   MapUnite Master AI avatar: which face to show, and when to pulse
   ==============================================================================
   Pure (no DOM, no Three.js), so it runs in node tests. avatar-app.js feeds it
   what the app is doing and hands the result to the particle core
   (ai-particle-core.js: setMode, pulse, setLevel).

   INPUTS (handle(event, nowMs)):
     { type: "voice", phase: "start", priority, route }   VoiceAssistant started a line (js/voice.js
                                                           "mu:voice-state"); route "pending" while the
                                                           premium voice is still being fetched
     { type: "voice", phase: "route", route }             the engine picked a route (cloud / native / web)
     { type: "voice", phase: "end" }                      the line finished, was cut off or silenced
     { type: "mic", on, mode }                            the mic opened / closed ("ask" | "ptt" | "handsfree")
     { type: "task", phase: "start" | "end", task }       brain.delegate(): Deep Search, nearest place, …
                                                           ("master.delegated" / "master.task-done")
     { type: "decision", severity, kind, action }         the Master's decision on a report ("master.decision")

   OUTPUT:
     mode(nowMs)       idle | listening | thinking | speaking | alert   (the core's MODES)
     handle() returns  { pulse: 0 | strength }                         a shockwave from the brain now
     nextChange(nowMs) when mode() can change without a new event (alert hold ends, a task
                       times out), so the caller can set one timer instead of polling

   PRECEDENCE (first that holds):
     alert      a critical or warning hazard the Master delivered, held ALERT_HOLD_MS[severity];
                or a line with priority ≥ CRITICAL_PRIORITY being spoken (speed danger, SOS …)
     speaking   a line is playing (route known)
     listening  the mic is open for an answer ("Bhai, ek baat bolun?") or a push-to-talk command.
                Hands-free listening runs the whole ride, so it isn't shown as listening.
     thinking   a delegated task is running (capped at THINK_MAX_MS), or the premium voice is
                still being fetched for the line about to be spoken
     idle
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); (W.MUAvatar || (W.MUAvatar = {})).state = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const MODES = Object.freeze(["idle", "listening", "thinking", "speaking", "alert"]);
    /** How long a delivered hazard keeps the face in alert. */
    const ALERT_HOLD_MS = Object.freeze({ critical: 6000, warning: 2500 });
    /** Shockwave strength (the core clamps to 0..1.5). */
    const PULSE = Object.freeze({ critical: 1.2, warning: 1.0, criticalLine: 1.0 });
    /** The same hazard kind doesn't pulse again within this window (a radar re-confirming every second). */
    const REPEAT_MS = 20000;
    /** Lines at or above this voice priority are safety calls (output.js maps critical to 85–100). */
    const CRITICAL_PRIORITY = 85;
    /** A task that never reports back stops "thinking" after this. */
    const THINK_MAX_MS = 20000;
    /** Decisions that mean the hazard reached the rider's pipeline (not dropped, superseded or rejected). */
    const DELIVERED = Object.freeze(["spoken", "shown", "held", "asking"]);
    /** Mic modes shown as listening. */
    const LISTEN_MODES = Object.freeze(["ask", "ptt"]);

    function createAvatarState() {
        /** @type {{ priority: number, route: string } | null} */ let speaking = null;
        /** @type {string|null} */ let listening = null;
        /** @type {Map<string, number>} task → started at */ const tasks = new Map();
        let alertUntil = 0;
        /** @type {Map<string, number>} hazard kind → last pulse */ const lastPulse = new Map();

        /** @param {number} t */
        function expireTasks(t) { for (const [k, at] of tasks) if (t - at >= THINK_MAX_MS) tasks.delete(k); }

        /**
         * @param {any} ev @param {number} t
         * @returns {{ pulse: number }}
         */
        function handle(ev, t) {
            let pulse = 0;
            if (!ev || typeof ev !== "object") return { pulse };
            switch (ev.type) {
                case "voice":
                    if (ev.phase === "start") {
                        const priority = Number.isFinite(ev.priority) ? ev.priority : 50;
                        speaking = { priority, route: typeof ev.route === "string" ? ev.route : "" };
                        if (priority >= CRITICAL_PRIORITY) pulse = PULSE.criticalLine;
                    } else if (ev.phase === "route") {
                        if (speaking) speaking = { ...speaking, route: String(ev.route || "") };
                    } else if (ev.phase === "end") speaking = null;
                    break;
                case "mic":
                    listening = ev.on && LISTEN_MODES.includes(ev.mode) ? ev.mode : null;
                    break;
                case "task": {
                    const k = String(ev.task || "task");
                    if (ev.phase === "start") tasks.set(k, t);
                    else if (ev.phase === "end") tasks.delete(k);
                    break;
                }
                case "decision": {
                    const sev = ev.severity;
                    if ((sev !== "critical" && sev !== "warning") || !DELIVERED.includes(ev.action)) break;
                    const kind = String(ev.kind || sev);
                    const last = lastPulse.get(kind);
                    if (last !== undefined && t - last < REPEAT_MS) break;
                    lastPulse.set(kind, t);
                    if (lastPulse.size > 200) for (const [k, at] of lastPulse) if (t - at >= REPEAT_MS) lastPulse.delete(k);
                    alertUntil = Math.max(alertUntil, t + ALERT_HOLD_MS[sev]);
                    pulse = PULSE[sev];
                    break;
                }
                default: break;
            }
            return { pulse };
        }

        /** @param {number} t @returns {"idle"|"listening"|"thinking"|"speaking"|"alert"} */
        function mode(t) {
            expireTasks(t);
            if (t < alertUntil || (speaking && speaking.priority >= CRITICAL_PRIORITY)) return "alert";
            if (speaking && speaking.route !== "pending") return "speaking";
            if (listening) return "listening";
            if (tasks.size || speaking) return "thinking";
            return "idle";
        }

        /** @param {number} t @returns {number} the next time mode() can change on its own (Infinity = only on an event) */
        function nextChange(t) {
            let n = Infinity;
            if (alertUntil > t) n = alertUntil;
            for (const at of tasks.values()) n = Math.min(n, at + THINK_MAX_MS);
            return n;
        }

        return {
            handle, mode, nextChange,
            /** True while a line is being spoken (the voice level should move). */
            get speaking() { return Boolean(speaking && speaking.route !== "pending"); },
            snapshot: () => ({ speaking, listening, tasks: [...tasks.keys()], alertUntil })
        };
    }

    /**
     * A speech-like level for the brain while a line plays, 0..1. Neither the native voice
     * nor the browser's speechSynthesis exposes loudness, so this is a visual rhythm
     * (syllables ~4.5 per second, phrases ~0.6 per second), not a measurement.
     * @param {number} tMs time since the line started
     */
    function speechLevel(tMs) {
        const s = tMs / 1000;
        const syll = 0.5 + 0.5 * Math.sin(s * 2 * Math.PI * 4.5 + Math.sin(s * 7.3) * 1.4);
        const phrase = 0.62 + 0.38 * Math.sin(s * 2 * Math.PI * 0.6 + 1.1);
        const attack = Math.min(1, s / 0.12);
        return Math.max(0, Math.min(1, (0.18 + 0.82 * syll * syll) * phrase * attack));
    }

    return { createAvatarState, speechLevel, MODES, ALERT_HOLD_MS, PULSE, REPEAT_MS, CRITICAL_PRIORITY, THINK_MAX_MS, DELIVERED, LISTEN_MODES };
});
