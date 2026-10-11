// @ts-check
/* ============================================================================
   MapUnite advice — the cue rules of the safety gate (Step 8)
   ==============================================================================
   Every spoken cue in the app passes through voiceAnnounce(), which asks
   MUAdvice.live.decide() (js/advice/advice-ui.js). That is one instance of the
   rules below, owned by the advice layer and fed from the same signals as the
   economy-tip gate (js/advice/advice-app.js): the one quiet-ride setting, the
   badge's road condition, GPS confidence, hard braking. It decides whether the
   cue is spoken, only shown, or held back, and says why. Pure state machine:
   no DOM, no timers, the clock is passed in.

   LEVELS (from the cue's own priority / category, see classify()):
     critical  SOS, far over the limit, a forced reply (priority ≥ 85, force, "sos")
     nav       turn-by-turn directions (category "nav")
     warning   over the limit, weather turning bad, low fuel (priority 60–84)
     advice    eco tips, fuel stops, convoy chatter, "speed limit 40" (priority < 60)

   RULES, in order (the first one that applies wins):
     1. critical            → always spoken. Nothing in this file can mute it.
     2. quiet ride          → advice held back. Warnings are still spoken (quiet ride
                              mutes riding advice, never a safety warning); with
                              quietMutesWarnings they're shown, not spoken. Nav is
                              spoken unless "keep directions" is off.
     3. GPS not trusted     → speed cues (category "speed"/"weather") below critical
                              are held back: the app can't tell how fast you are.
     4. busy window         → advice held back for 6 s after a turn prompt or a
                              harsh brake / swerve, so the rider isn't talked to
                              while they're handling the bike.
     5. stormy weather      → advice held back (heavy rain, fog, ice: eyes on the road).
     6. spacing             → at most one advice cue every 45 s.
     otherwise              → spoken.

   ASK FIRST (setAskFirst(true), the "Ask before tips" setting):
     - advice that would be spoken is ASKED instead: { ask: true } tells
       voice.js to say "Bhai, ek baat bolun?", listen ~3.5 s, and speak the cue
       only after a yes (js/advice/ask.js). Spacing counts the question.
     - with quietMutesWarnings, a quiet-ride warning (otherwise only shown) is asked.
     - critical cues and directions are never asked.
     - noteAnswer(): "nahi" snoozes that category for 20 min; 3 unanswered
       questions in a row pause asking for 15 min (tips are then only shown).
     - fallbackSpeak says what to do if the phone can't listen (no mic, a
       call): advice is spoken as before, a quiet-ride warning stays on screen.

   Apart from that one question, the gate never makes the app LOUDER than it
   already was: it only removes or demotes cues. The app's own mute and
   "Spoken alerts" setting still apply after it.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUAdvice || (/** @type {any} */ (root).MUAdvice = {}); ns.gate = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const DEFAULTS = Object.freeze({
        busyMs: 6000,           // after a turn prompt or a harsh event
        adviceGapMs: 45000,     // between two advice cues
        trustConfidence: 0.6,   // GpsFilter confidence below which speed cues are held
        askSnoozeMs: 20 * 60 * 1000,   // after "nahi", that category isn't asked again for this long
        askPauseAfter: 3,              // unanswered questions in a row before asking pauses
        askPauseMs: 15 * 60 * 1000,
        quietMutesWarnings: false,     // quiet ride: true = warnings only on screen; false (the app) = still spoken
        logSize: 30
    });

    /** Speed-related categories: these depend on knowing the rider's speed. */
    const SPEED_CATEGORIES = new Set(["speed", "weather"]);

    /**
     * The level of a cue, from what its caller already says about it.
     * @param {{ priority?: number, category?: string, force?: boolean }} [o]
     * @returns {"critical"|"nav"|"warning"|"advice"}
     */
    function classify(o = {}) {
        const p = Number.isFinite(o.priority) ? /** @type {number} */ (o.priority) : 50;
        const cat = o.category || "";
        if (o.force || cat === "sos" || p >= 85) return "critical";
        if (cat === "nav") return "nav";
        if (p >= 60) return "warning";
        return "advice";
    }

    /**
     * @typedef {{ speak: boolean, show: boolean, level: "critical"|"nav"|"warning"|"advice", reason: string, ask?: boolean, fallbackSpeak?: boolean }} Decision
     *   reason: "safety" | "ok" | "quiet" | "gps" | "busy" | "weather" | "spacing" | "ask" | "snoozed" | "ask-paused"
     *   ask: speak only after the rider says yes (voice.js asks); fallbackSpeak: what to do if it can't ask
     */

    /**
     * @param {{ busyMs?: number, adviceGapMs?: number, trustConfidence?: number, logSize?: number, askSnoozeMs?: number, askPauseAfter?: number, askPauseMs?: number, quietMutesWarnings?: boolean }} [opts]
     */
    function createGate(opts = {}) {
        const cfg = { ...DEFAULTS, ...opts };
        const st = {
            quiet: false, keepNav: true,
            confidence: 1,
            /** @type {{ kind: string, severity: number, label: string }|null} */ condition: null,
            lastNavAt: -Infinity, lastHarshAt: -Infinity, lastAdviceAt: -Infinity,
            /** @type {Record<string, number>} */ held: {},
            askFirst: false, askMisses: 0, askPausedUntil: -Infinity,
            /** @type {Record<string, number>} category → snoozed until */ snoozed: {},
            asks: { asked: 0, yes: 0, no: 0, silence: 0 },
            /** @type {Array<{ t: number, text: string, level: string, reason: string, speak: boolean }>} */ log: []
        };

        function record(t, text, d) {
            if (!d.speak && !d.ask) st.held[d.reason] = (st.held[d.reason] || 0) + 1;
            st.log.push({ t, text: String(text || "").slice(0, 120), level: d.level, reason: d.reason, speak: d.speak });
            if (st.log.length > cfg.logSize) st.log.splice(0, st.log.length - cfg.logSize);
        }

        /** May this category be asked about right now? */
        function askable(/** @type {number} */ t, /** @type {string} */ cat) {
            return st.askFirst && t >= st.askPausedUntil && !((st.snoozed[cat || "general"] || -Infinity) > t);
        }

        /**
         * How the rider answered a question (voice.js calls this).
         *   yes → reset the miss count; no → snooze that category;
         *   silence / unclear → a miss; enough misses in a row pause asking.
         * @param {string} category
         * @param {"yes"|"no"|"silence"|"unclear"|"interrupted"|"unavailable"} answer
         * @param {number} t
         */
        function noteAnswer(category, answer, t) {
            if (answer === "interrupted" || answer === "unavailable") return { pausedUntil: st.askPausedUntil };
            st.asks.asked++;
            if (answer === "yes") { st.asks.yes++; st.askMisses = 0; }
            else if (answer === "no") { st.asks.no++; st.askMisses = 0; st.snoozed[category || "general"] = t + cfg.askSnoozeMs; }
            else {
                st.asks.silence++;
                if (++st.askMisses >= cfg.askPauseAfter) { st.askPausedUntil = t + cfg.askPauseMs; st.askMisses = 0; }
            }
            return { pausedUntil: st.askPausedUntil, snoozedUntil: st.snoozed[category || "general"] || null };
        }

        /**
         * Decide what happens to one cue. Records it (counters + log) unless dryRun.
         * @param {{ text?: string, priority?: number, category?: string, force?: boolean }} msg
         * @param {number} t  ms
         * @param {{ dryRun?: boolean }} [o]
         * @returns {Decision}
         */
        function decide(msg, t, o = {}) {
            const level = classify(msg);
            const cat = msg.category || "";
            /** @type {Decision} */ let d;
            const untrusted = SPEED_CATEGORIES.has(cat) && st.confidence < cfg.trustConfidence;
            const busy = t - st.lastNavAt < cfg.busyMs || t - st.lastHarshAt < cfg.busyMs;
            const stormy = Boolean(st.condition && st.condition.severity >= 2);
            if (level === "critical") d = { speak: true, show: true, level, reason: "safety" };
            else if (level === "nav") d = st.quiet && !st.keepNav ? { speak: false, show: true, level, reason: "quiet" } : { speak: true, show: true, level, reason: "ok" };
            else if (level === "warning") {
                if (st.quiet && cfg.quietMutesWarnings) d = askable(t, cat) && !untrusted
                    ? { speak: false, show: true, level, reason: "quiet", ask: true, fallbackSpeak: false }
                    : { speak: false, show: true, level, reason: "quiet" };
                else if (untrusted) d = { speak: false, show: false, level, reason: "gps" };
                else d = { speak: true, show: true, level, reason: "ok" };
            } else {
                if (st.quiet) d = { speak: false, show: false, level, reason: "quiet" };
                else if (untrusted) d = { speak: false, show: false, level, reason: "gps" };
                else if (busy) d = { speak: false, show: false, level, reason: "busy" };
                else if (stormy) d = { speak: false, show: false, level, reason: "weather" };
                else if (t - st.lastAdviceAt < cfg.adviceGapMs) d = { speak: false, show: true, level, reason: "spacing" };
                else if (!st.askFirst) d = { speak: true, show: true, level, reason: "ok" };
                else if ((st.snoozed[cat || "general"] || -Infinity) > t) d = { speak: false, show: false, level, reason: "snoozed" };
                else if (t < st.askPausedUntil) d = { speak: false, show: true, level, reason: "ask-paused" };
                else d = { speak: false, show: true, level, reason: "ask", ask: true, fallbackSpeak: true };
            }
            if (!o.dryRun) {
                if (d.speak && level === "nav") st.lastNavAt = t;
                if ((d.speak || d.ask) && level === "advice") st.lastAdviceAt = t;
                record(t, msg.text, d);
            }
            return d;
        }

        /**
         * One summary of where the gate stands, for the settings line and the overlay.
         * @param {number} t
         * @returns {{ key: "open"|"quiet"|"degraded"|"busy"|"storm"|"ask"|"ask-paused", label: string, detail: string }}
         */
        function mode(t) {
            if (st.quiet) return { key: "quiet", label: "Quiet ride", detail: cfg.quietMutesWarnings
                ? (st.keepNav ? "Directions and safety-critical alerts are spoken; warnings show on screen; tips are held back." : "Only safety-critical alerts are spoken. Directions and warnings show on screen.")
                : (st.keepNav ? "Tips are held back. Directions and safety warnings are still spoken." : "Tips are held back and directions show on screen. Safety warnings are still spoken.") };
            if (st.condition && st.condition.severity >= 2) return { key: "storm", label: st.condition.label, detail: "Tips are held back so you can watch the road. Warnings still come through." };
            if (st.confidence < cfg.trustConfidence) return { key: "degraded", label: "GPS is weak", detail: "Speed tips and speed warnings pause until the signal is trusted again. Far over the limit still warns." };
            if (t - st.lastNavAt < cfg.busyMs || t - st.lastHarshAt < cfg.busyMs) return { key: "busy", label: "Holding tips", detail: "A moment after a turn or a hard brake, tips wait." };
            if (st.askFirst && t < st.askPausedUntil) return { key: "ask-paused", label: "Not asking for now", detail: "No answer to the last few questions, so tips only show on screen for a while." };
            if (st.askFirst) return { key: "ask", label: "Asks before tips", detail: "Tips start with a short spoken question: say yes to hear the tip. Safety warnings always come through." };
            return { key: "open", label: "All advice on", detail: "Tips at most every 45 s. Safety warnings always come through." };
        }

        return {
            decide, mode,
            /** @param {boolean} on */ setQuiet(on) { st.quiet = Boolean(on); },
            /** @param {boolean} on */ setKeepNav(on) { st.keepNav = Boolean(on); },
            /** @param {number} c 0..1 */ setConfidence(c) { st.confidence = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 1; },
            /** @param {{ kind: string, severity: number, label: string }|null} c */ setCondition(c) { st.condition = c && Number.isFinite(c.severity) ? { kind: c.kind, severity: c.severity, label: c.label } : null; },
            /** A harsh brake / swerve just happened. @param {number} t */ noteHarsh(t) { st.lastHarshAt = t; },
            /** A turn prompt was shown without voice (e.g. a banner). @param {number} t */ noteManeuver(t) { st.lastNavAt = t; },
            /** New ride: counters and log start over (settings persist). */
            /** "Ask before tips". @param {boolean} on */ setAskFirst(on) { st.askFirst = Boolean(on); },
            noteAnswer,
            resetRide() {
                st.held = {}; st.log = []; st.lastAdviceAt = -Infinity;
                st.asks = { asked: 0, yes: 0, no: 0, silence: 0 }; st.askMisses = 0; st.askPausedUntil = -Infinity; st.snoozed = {};
            },
            get state() {
                return {
                    quiet: st.quiet, keepNav: st.keepNav, confidence: st.confidence, condition: st.condition, held: { ...st.held }, log: st.log.slice(),
                    askFirst: st.askFirst, asks: { ...st.asks }, askPausedUntil: st.askPausedUntil, snoozed: { ...st.snoozed }
                };
            }
        };
    }

    /**
     * Plain words for what the gate held back this ride, or "" when nothing was.
     * @param {Record<string, number>} held
     */
    function heldSummary(held) {
        const words = { quiet: "quiet ride", gps: "weak GPS", busy: "right after a turn or hard brake", weather: "bad weather", spacing: "too soon after another tip", snoozed: "you said not now", "ask-paused": "no answer lately" };
        const parts = Object.entries(held || {}).filter(([k, n]) => n > 0 && k in words).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} (${/** @type {any} */ (words)[k]})`);
        if (!parts.length) return "";
        const total = Object.entries(held).filter(([k]) => k in words).reduce((a, [, n]) => a + n, 0);
        return `This ride: ${total} cue${total === 1 ? "" : "s"} held back: ${parts.join(", ")}.`;
    }

    /**
     * Plain words for this ride's questions, or "" when none were asked.
     * @param {{ asked: number, yes: number, no: number, silence: number }} asks
     */
    function askSummary(asks) {
        if (!asks || !asks.asked) return "";
        const parts = [asks.yes && `${asks.yes} yes`, asks.no && `${asks.no} not now`, asks.silence && `${asks.silence} no answer`].filter(Boolean);
        return `Asked ${asks.asked} time${asks.asked === 1 ? "" : "s"} this ride: ${parts.join(", ")}.`;
    }

    return { DEFAULTS, SPEED_CATEGORIES, classify, createGate, heldSummary, askSummary };
});
