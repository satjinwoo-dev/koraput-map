// @ts-check
/* ============================================================================
   MapUnite Master AI — output (voice + screen), always through the safety gate
   ==============================================================================
   The Master never owns a second voice. Every spoken line goes through the
   app's existing voiceAnnounce() (js/voice.js), which:
     1. asks the advice gate (MUAdvice.live.decide: the cue rules of js/advice/gate.js,
        one instance in js/advice/advice-ui.js): quiet ride, weak GPS, right after a
        turn or a hard brake, storms, tip spacing; warnings and critical always pass;
     2. respects the rider's mute and "Spoken alerts" setting;
     3. queues behind, or pre-empts, whatever VoiceAssistant is saying.
   So the Master can never talk over a turn instruction or a speed warning.

   ASK FIRST: when the gate says a line should be asked ("Ask before tips"),
   voiceAnnounce() returns "ask" and voice.js says "Bhai, ek baat bolun?",
   listens, and speaks the line only after a yes. say() then returns
   reason "asking" with a `pending` promise for the final outcome; the status
   island waits for that outcome too, so the rider isn't shown a tip they
   just declined. Critical lines are never asked.

   On screen, warnings and advice use the app's status island (StatusIsland),
   which already has the right haptics per level. Every line is also sent as a
   "mu:master-say" DOM event, for a chat feed or a debug panel.

   Outside the app (tests, a standalone demo) it falls back to its own gate
   (MUAdvice.gate if loaded) and speechSynthesis / Capacitor TTS.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); (W.MUMaster || (W.MUMaster = {})).output = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const ISLAND_KIND = { critical: "speed-danger", warning: "speed-warn", advice: "info", info: "safe" };
    const ISLAND_TTL = { critical: 9000, warning: 6000, advice: 5000, info: 3000 };
    const MAX_AGE = { critical: 6000, warning: 12000, advice: 20000, info: 5000 };
    const ASK_TIMEOUT_MS = 20000;            // an ask that never reports back is treated as unanswered

    /**
     * @typedef {{
     *   text: string, display?: { title?: string, sub?: string, icon?: string|null },
     *   severity: "critical"|"warning"|"advice"|"info", priority: number, category?: string,
     *   key?: string, kind?: string, speak?: boolean
     * }} Utterance
     * @typedef {{ spoken: boolean, shown: boolean, reason: string, pending?: Promise<{ spoken: boolean, shown: boolean, reason: string }> }} SayResult
     */

    /**
     * @param {{
     *   window?: any,
     *   voice?: (text: string, opts: any) => boolean,    // default: the app's voiceAnnounce
     *   island?: (spec: any) => any,                     // default: StatusIsland.show
     *   busy?: () => boolean,                            // default: VoiceAssistant / speechSynthesis
     *   emit?: (detail: any) => void                     // default: "mu:master-say" DOM event
     * }} [opts]
     */
    function createOutput(opts = {}) {
        const W = opts.window || (typeof window !== "undefined" ? window : /** @type {any} */ ({}));

        function appVoice() {
            if (typeof W.voiceAnnounce === "function") return W.voiceAnnounce;
            try {
                // @ts-ignore: a global from voice.js
                if (typeof voiceAnnounce === "function") return voiceAnnounce;
            } catch (e) { /* not loaded */ }
            return null;
        }

        // ---- standalone fallback: own gate + plain TTS (only when the app's voice isn't there)
        /** @type {any} */ let ownGate = null;
        function fallbackVoice(/** @type {string} */ text, /** @type {any} */ o) {
            try {
                if (!ownGate && W.MUAdvice && W.MUAdvice.gate) ownGate = W.MUAdvice.gate.createGate();
                if (ownGate && !ownGate.decide({ text, ...o }, Date.now()).speak) return false;
                const TTS = W.capacitorTextToSpeech && W.capacitorTextToSpeech.TextToSpeech;
                if (TTS) { TTS.speak({ text, lang: "en-IN", rate: 1, pitch: 1, volume: 1, category: "playback" }).catch(() => {}); return true; }
                if (W.speechSynthesis && typeof W.SpeechSynthesisUtterance === "function") {
                    const u = new W.SpeechSynthesisUtterance(text); u.lang = "en-IN";
                    if (o.priority >= 85) W.speechSynthesis.cancel();
                    W.speechSynthesis.speak(u);
                    return true;
                }
            } catch (e) { /* no voice available */ }
            return false;
        }

        // returns true / false, or "ask" while voice.js asks "Bhai, ek baat bolun?" (the outcome arrives in o.onResult)
        const voice = opts.voice || ((/** @type {string} */ text, /** @type {any} */ o) => { const v = appVoice(); return v ? v(text, o) : fallbackVoice(text, o); });
        const island = opts.island || ((/** @type {any} */ spec) => { if (W.StatusIsland && typeof W.StatusIsland.show === "function") { W.StatusIsland.show(spec); return true; } return false; });
        const busy = opts.busy || (() => {
            try {
                if (W.VoiceAssistant && (W.VoiceAssistant.current || W.VoiceAssistant.asking)) return true;   // speaking, or waiting for an answer
                return Boolean(W.speechSynthesis && W.speechSynthesis.speaking);
            } catch (e) { return false; }
        });
        const emit = opts.emit || ((/** @type {any} */ detail) => {
            try { if (W.document && typeof W.CustomEvent === "function") W.document.dispatchEvent(new W.CustomEvent("mu:master-say", { detail })); } catch (e) { /* optional */ }
        });

        /**
         * @param {Utterance} u
         * @returns {SayResult}
         *   When voice.js asks first, the result is { spoken: false, shown: false, reason: "asking",
         *   pending: Promise<{ spoken, shown, reason: "asked:yes" | "asked:no" | "asked:silence" | … }> }.
         */
        function say(u) {
            const sev = u.severity;
            const d = u.display || {};
            const showIsland = () => {
                try {
                    return island({
                        id: `master-${u.category || "line"}`, kind: ISLAND_KIND[sev], title: d.title || "", sub: d.sub || u.text,
                        ...(d.icon ? { icon: d.icon } : {}), ttl: ISLAND_TTL[sev], haptic: sev === "critical" || sev === "warning"
                    }) !== false;
                } catch (e) { return false; }
            };
            /** @type {(r: any) => void} */ let settle = () => {};
            const outcome = new Promise((resolve) => { settle = resolve; });
            /** @type {any} */ let r = false;
            let reason = "ok";
            if (sev !== "info" && u.speak !== false && u.text) {
                // The gate and VoiceAssistant decide. Cooldowns are the Master's job, so the
                // voice's own per-key cooldown is kept short; the key keeps duplicates out of its queue.
                r = voice(u.text, {
                    priority: u.priority, category: u.category || "master", key: `master:${u.key || u.kind || "line"}`,
                    cooldownMs: 3000, maxAgeMs: MAX_AGE[sev], onResult: (/** @type {any} */ res) => settle(res)
                });
            } else reason = sev === "info" ? "info" : "silent";

            if (r === "ask") {
                // The one-second question is the only interruption: the line shows on screen
                // once the rider wants it (a warning shows either way, as it did in quiet ride).
                /** @type {any} */ let timer = null;
                const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ spoken: false, reason: "asked:timeout" }), ASK_TIMEOUT_MS); });
                const pending = Promise.race([outcome, timeout]).then((/** @type {any} */ res) => {
                    clearTimeout(timer);
                    const spoken = Boolean(res && res.spoken);
                    const shown = sev !== "info" && (spoken || sev === "warning") ? showIsland() : false;
                    emit({ ...u, spoken, shown, asked: (res && res.reason) || "asked", at: Date.now() });
                    return { spoken, shown, reason: (res && res.reason) || "asked" };
                });
                return { spoken: false, shown: false, reason: "asking", pending };
            }
            const spoken = Boolean(r);
            if (!spoken && reason === "ok") reason = "held";
            const shown = sev !== "info" ? showIsland() : false;
            emit({ ...u, spoken, shown, at: Date.now() });
            return { spoken, shown, reason: spoken ? "spoken" : reason };
        }

        return { say, busy: () => busy() };
    }

    return { createOutput, ISLAND_KIND };
});
