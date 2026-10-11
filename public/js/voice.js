"use strict";

/* ============================================================================
   MapUnite client — js/voice.js
   ==============================================================================
   Spoken output and hands-free voice control: voiceAnnounce() and the shared
   drive/navigation state it reads, plus VoiceAssistant (priority speech
   queue, voice command grammar, push-to-talk and hands-free listening).

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

// ---- Voice bridge (Phase 3) ------------------------------------------------
// Every spoken cue in app.js goes through here. features.js's VoiceAssistant
// owns the policy (priority queue, mute, "spoken alerts" setting, echo guard
// for hands-free listening). If features.js failed to load, fall back to a
// plain utterance so safety-critical cues still get through.
//   opts: { priority 0..100, key (dedupe), cooldownMs, category,
//           drivingOnly (skip unless a drive is active), force (user-asked
//           replies / SOS: bypass the settings toggle and mute), maxAgeMs,
//           onResult({ spoken, reason }) (optional: the final outcome, also
//           after an ask-first question) }
// Returns true (spoken or queued), false (held back / voice off), or "ask"
// (truthy: a "Bhai, ek baat bolun?" question is running; onResult reports
// whether the cue was spoken in the end).
function voiceAnnounce(text, opts = {}) {
    const report = (spoken, reason) => { try { if (typeof opts.onResult === "function") opts.onResult({ spoken, reason }); } catch (e) { /* caller's problem */ } };
    // Step 8: the advice gate (js/advice/) may hold a cue back: quiet ride, weak GPS,
    // right after a turn or a hard brake, bad weather, or too soon after another tip.
    // It never holds back a safety-critical cue (priority ≥ 85, "sos", force).
    // With "Ask before tips" it may say ask: speak only after the rider says yes.
    let d = null;
    try {
        const live = window.MUAdvice && window.MUAdvice.live;
        if (live && typeof live.decide === "function") d = live.decide(text, opts);
        else if (live && typeof live.allowVoice === "function") d = { speak: Boolean(live.allowVoice(text, opts)) };
    } catch (e) { d = null; /* the gate is optional: speak as before */ }
    const VA = window.VoiceAssistant;
    if (d && d.ask) {
        // One question at a time: a second tip arriving mid-question is dropped, not spoken unasked.
        if (VA && VA.asking) { report(false, "asking"); return false; }
        if (VA && typeof VA.askThenSay === "function" && VA.canAsk()) { VA.askThenSay(text, opts, d); return "ask"; }
        // The phone can't listen right now (no mic, a call, muted …): behave as before the setting.
        if (!d.fallbackSpeak) { report(false, d.reason || "quiet"); return false; }
    } else if (d && !d.speak) { report(false, d.reason || "held"); return false; }
    if (VA && typeof VA.announce === "function") {
        const ok = VA.announce(text, opts);
        report(Boolean(ok), ok ? "spoken" : "voice-off");
        return ok;
    }
    try {
        if (!("speechSynthesis" in window) || !text) { report(false, "voice-off"); return false; }
        if ((opts.priority ?? 50) < 60 && !opts.force) { report(false, "voice-off"); return false; }
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(String(text)));
        report(true, "spoken");
        return true;
    } catch (e) { report(false, "voice-off"); return false; }
}

// Live navigation state, read by voice commands ("how far?") and by
// isDriving(). Updated only inside startSearchNavigation()/stopDrive().
const navState = { ready: false, active: false, destName: "", remainingM: null, etaSec: null, nextManeuver: "", routePath: null };

// Broadcast drive start/stop so features.js can arm hands-free listening and
// the convoy loop without app.js knowing about either.
function isDriving() {
    return Boolean((typeof SmartDrive !== "undefined" && SmartDrive.trip && SmartDrive.trip.active) || navState.active);
}
function emitDriveState() {
    document.dispatchEvent(new CustomEvent("mu:drive-state", { detail: { driving: isDriving(), navigating: navState.active } }));
}

// Spoken-distance/time helpers shared with features.js.
function spokenDistance(meters) {
    if (!Number.isFinite(meters)) return "";
    if (meters < 100) return `${Math.max(10, Math.round(meters / 10) * 10)} metres`;
    if (meters < 1000) return `${Math.round(meters / 50) * 50} metres`;
    const km = meters / 1000;
    return `${km >= 10 ? Math.round(km) : km.toFixed(1).replace(/\.0$/, "")} kilometres`;
}
function spokenMinutes(min) {
    const m = Math.max(0, Math.round(min));
    if (m < 1) return "less than a minute";
    if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
    const h = Math.floor(m / 60), r = m % 60;
    return `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} minute${r === 1 ? "" : "s"}` : ""}`;
}

// ============================================================================
// 5. VOICE ASSISTANT (Phase 3) — voice-first Safe Drive (roadmap Sections 4, 25)
// ============================================================================
// Speaking: SpeechSynthesis behind a small priority queue.
//   - a higher-priority cue pre-empts a lower one (a speed warning never
//     waits behind "Rahul is moving again");
//   - equal/lower cues queue (max 4) and EXPIRE — a turn prompt heard ten
//     seconds late is worse than none;
//   - `key` + `cooldownMs` de-duplicates repeats;
//   - the "Spoken alerts" setting and "mute" apply to everything except
//     `force` (replies to a command the rider just gave, and SOS).
// Listening: SpeechRecognition, two modes.
//   - push-to-talk (tap a mic button, say one command) — the default;
//   - hands-free (opt-in setting): listens continuously ONLY while a drive
//     is active and the app is visible, pauses while it's speaking (so it
//     can't hear its own "say start navigation"), ignores long utterances
//     (conversation, not commands), and never runs during a call.
// Honesty note surfaced in settings: in Chrome, SpeechRecognition audio is
// processed by Google's speech service while the mic is listening.
function normalizeSpeech(t) {
    return String(t || "")
        .toLowerCase()
        .replace(/[’`]/g, "'")
        .replace(/[^\p{L}\p{N}'\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Small Levenshtein for fuzzy rider names ("Rahool" -> "Rahul").
function editDistance(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[n];
}

// Ordered: first match wins. `ctx` = {mode:"ptt"|"handsfree", pendingSos:boolean}.
const VOICE_COMMANDS = [
    { name: "confirmSos", test: (t, ctx) => ctx.pendingSos && /\b(confirm|confirmed|yes|haan|send it|do it)\b/.test(t) },
    { name: "cancelPending", test: (t, ctx) => ctx.pendingSos && /\b(cancel|no|nahi|stop|don'?t)\b/.test(t) },
    { name: "sos", test: (t) => /\b(send|trigger|raise|call)\b.*\b(sos|s o s|emergency)\b|\bemergency\b|\bhelp me\b|\bsos\b|\bs o s\b/.test(t) },
    { name: "help", test: (t) => /\b(help|what can i say|commands|options)\b/.test(t) },
    { name: "unmute", test: (t) => /\b(unmute|un mute|voice on|alerts on|sound on|speak again)\b/.test(t) },
    { name: "mute", test: (t) => /\b(mute|quiet|silence|shut up|chup|alerts off|voice off)\b/.test(t) },
    { name: "stopNav", test: (t, ctx) => /\b(stop|end|cancel|exit|finish)\b.*\b(navigation|navigating|drive|ride|trip|route|directions)\b/.test(t) || (ctx.mode === "ptt" && /^(stop|ruko|band karo|end)$/.test(t)) },
    { name: "routeAvoid", test: (t) => {
        const R = "(tolls?|toll roads?|highways?|motorways?|expressways?)";
        const m = new RegExp(`^(?:please\\s+)?(avoid|no|skip|allow|use)\\s+(?:the\\s+)?${R}(?:\\s+(?:and|or)\\s+${R})?$`).exec(t);
        if (!m) return false;
        const cls = (w) => (w && /^toll/.test(w) ? "toll" : w ? "motorway" : null);
        const list = [cls(m[2]), cls(m[3])].filter(Boolean);
        return `${/^(allow|use)$/.test(m[1]) ? "allow" : "avoid"}:${[...new Set(list)].join(",")}`;
    } },
    { name: "navigateTo", test: (t) => { const m = /\b(?:navigate|take me|directions|route me|drive me|go|get me|chalo)\s+to\s+(.+)$/.exec(t); return m ? m[1] : false; } },
    { name: "startNav", test: (t) => /\b(start|begin|resume)\b.*\b(navigation|navigating|drive|ride|route|trip)\b|\blet'?s go\b|\bchalo\b|^go$/.test(t) },
    { name: "whereAmI", test: (t) => /\bwhere am i\b|\bmain kahan hu\b/.test(t) },
    { name: "convoy", test: (t) => /\b(squad|convoy|group|team)\b.*\b(status|update|check|report)\b|\bwhere is everyone\b|\bwhere's everyone\b|\beveryone ok\b|\bsab kahan hai\b/.test(t) },
    { name: "regroup", test: (t) => /\b(regroup|re group|close up|should i (slow down|wait|speed up|stop))\b/.test(t) },
    { name: "approaching", test: (t) => /\b(who'?s|who is) (approaching|coming|closing in|getting closer)\b|\banyone (approaching|coming|close)\b/.test(t) },
    { name: "radio", test: (t) => /\b(radio|mesh|lora)\b.*\b(status|check|update|report|anyone|who)\b|\bwho can (you|i) hear\b|^(radio|mesh|lora)$/.test(t) },
    { name: "whereIs", test: (t) => { const m = /\bwhere(?:'s| is)\s+(.+)$/.exec(t) || /^(.+?)\s+kahan hai$/.exec(t); return m ? m[1] : false; } },
    { name: "howFar", test: (t) => /\b(how far|how long|eta|time left|distance left|remaining|kitna door|kitni der|when will i (arrive|get there))\b/.test(t) },
    { name: "speedLimit", test: (t) => /\b(speed limit|what'?s the limit|limit here|how fast can i go)\b/.test(t) },
    { name: "speed", test: (t) => /\b(my speed|how fast|what speed|current speed)\b/.test(t) },
    { name: "recenter", test: (t) => /\b(re ?cent(er|re)|locate me|center map|centre map|show my location)\b/.test(t) }
];

function matchVoiceCommand(text, ctx) {
    for (const c of VOICE_COMMANDS) {
        const r = c.test(text, ctx);
        if (r) return { name: c.name, arg: typeof r === "string" ? r.trim() : null };
    }
    return null;
}

const VoiceAssistant = {
    KEY_ALERTS: "mu_voice_alerts",
    KEY_HANDSFREE: "mu_voice_handsfree",
    MUTE_MS: 30 * 60 * 1000,
    MAX_QUEUE: 4,
    ECHO_GUARD_MS: 700,

    alertsEnabled: true,
    handsFree: false,
    mutedUntil: 0,
    synth: ("speechSynthesis" in window) ? window.speechSynthesis : null,
    voice: null,
    current: null,
    queue: [],
    recentKeys: new Map(),
    watchdog: null,
    unlocked: false,
    lastTtsEndTs: 0,

    Recognition: window.SpeechRecognition || window.webkitSpeechRecognition || null,
    recognizer: null,
    listenMode: null,              // "ptt" | "handsfree" | null
    restartTimer: null,
    resumeTimer: null,
    errorTimes: [],
    handsFreePausedUntil: 0,
    suspendedForTts: false,
    pendingConfirm: null,          // { type: "sos", until }

    // Ask first ("Bhai, ek baat bolun?" → listen → speak only after a yes; js/advice/ask.js)
    ASK_LISTEN_MS: 3500,           // the answer window, from the moment the mic is open
    ASK_EXTEND_MS: 2500,           // more time once the rider has started talking
    ASK_ECHO_MS: 200,              // let the question's last syllable die away before listening
    asking: null,                  // { text, opts, phase: "prompt" | "listen", abort(reason) }
    askOffUntil: 0,                // the recognizer kept failing: don't ask for a while
    micBlocked: false,
    lastPrompt: "",

    init() {
        try {
            this.alertsEnabled = localStorage.getItem(this.KEY_ALERTS) !== "0";
            this.handsFree = localStorage.getItem(this.KEY_HANDSFREE) === "1";
        } catch (e) { /* storage blocked: keep defaults */ }

        if (this.synth) {
            // Chrome can keep a stuck utterance across reloads; start clean.
            try { this.synth.cancel(); } catch (e) { /* ignore */ }
            this.pickVoice();
            if (typeof this.synth.addEventListener === "function") this.synth.addEventListener("voiceschanged", () => this.pickVoice());
            else this.synth.onvoiceschanged = () => this.pickVoice();
        }

        // iOS only allows speech after speak() has run inside a user gesture once.
        const unlock = () => this.unlock();
        document.addEventListener("pointerdown", unlock, { once: true, capture: true });
        document.addEventListener("keydown", unlock, { once: true, capture: true });

        this.bindUI();
        document.addEventListener("mu:drive-state", () => this.updateHandsFree());
        document.addEventListener("visibilitychange", () => this.updateHandsFree());
    },

    bindUI() {
        const alertsToggle = document.getElementById("voice-alerts-toggle");
        if (alertsToggle) {
            alertsToggle.checked = this.alertsEnabled;
            alertsToggle.addEventListener("change", () => {
                this.alertsEnabled = alertsToggle.checked;
                try { localStorage.setItem(this.KEY_ALERTS, this.alertsEnabled ? "1" : "0"); } catch (e) { /* ignore */ }
                if (!this.alertsEnabled) this.silence();
            });
        }

        const hfToggle = document.getElementById("voice-handsfree-toggle");
        if (hfToggle) {
            hfToggle.checked = this.handsFree && Boolean(this.Recognition);
            hfToggle.disabled = !this.Recognition;
            hfToggle.addEventListener("change", () => {
                this.handsFree = hfToggle.checked;
                this.handsFreePausedUntil = 0;
                try { localStorage.setItem(this.KEY_HANDSFREE, this.handsFree ? "1" : "0"); } catch (e) { /* ignore */ }
                if (this.handsFree && !this.driving()) showToast("Hands-free listening starts automatically when a drive begins.", 4000);
                this.updateHandsFree();
            });
        }

        const hint = document.getElementById("voice-support-hint");
        if (hint) {
            const parts = [];
            if (!this.synth) parts.push("This browser can't speak alerts.");
            if (!this.Recognition) parts.push("Voice commands aren't supported in this browser — Chrome on Android supports them.");
            else parts.push("While the mic is listening, your browser's speech service turns speech into text — in Chrome that audio is sent to Google.");
            parts.push("Emergency SOS alerts are always spoken.");
            hint.textContent = parts.join(" ");
        }

        const testBtn = document.getElementById("voice-test-btn");
        if (testBtn) testBtn.addEventListener("click", () => {
            this.unlock();
            this.announce(this.Recognition
                ? "Voice alerts are on. Tap the microphone and say help to hear the commands."
                : "Voice alerts are on.", { priority: 80, force: true });
        });

        ["voice-cmd-btn", "voice-cmd-map-btn"].forEach((id) => {
            const b = document.getElementById(id);
            if (!b) return;
            if (!this.Recognition) b.title = "Voice commands aren't supported in this browser";
            b.addEventListener("click", () => this.togglePushToTalk());
        });
    },

    // ---------------------------------------------------------------- speaking
    pickVoice() {
        if (!this.synth) return;
        const voices = this.synth.getVoices() || [];
        if (!voices.length) return;
        const region = ((navigator.language || "en-IN").split("-")[1] || "IN").toLowerCase();
        // All cues are English: prefer English in the rider's region (en-IN),
        // then any English, then an on-device voice (works offline, keeps
        // text on the phone).
        const score = (v) => {
            const lang = String(v.lang || "").toLowerCase().replace("_", "-");
            let s = 0;
            if (lang.startsWith("en")) s += 2;
            if (lang === `en-${region}`) s += 2;
            if (v.localService) s += 1;
            if (v.default) s += 0.5;
            return s;
        };
        this.voice = voices.slice().sort((a, b) => score(b) - score(a))[0] || null;
    },

    unlock() {
        if (!this.synth || this.unlocked) return;
        try {
            const u = new SpeechSynthesisUtterance(" ");
            u.volume = 0;
            this.synth.speak(u);
            this.unlocked = true;
        } catch (e) { /* ignore */ }
    },

    driving() { return typeof isDriving === "function" ? isDriving() : false; },
    isMuted() { return Date.now() < this.mutedUntil; },

    silence() {
        for (const q of this.queue) this.settle(q, false);
        this.queue = [];
        if (this.asking && typeof this.asking.abort === "function") this.asking.abort("interrupted");
        if (this.current) { const c = this.current; this.current = null; this.lastTtsEndTs = Date.now(); clearTimeout(this.watchdog); this.settle(c, false); }
        try { if (this.synth) this.synth.cancel(); } catch (e) { /* ignore */ }
        // The cancelled utterance's onend is ignored (done() checks identity),
        // so hand hands-free listening back here instead.
        this.resumeRecognitionAfterTts();
    },

    announce(text, opts = {}) {
        if (!this.synth || !text) return false;
        const priority = Number.isFinite(opts.priority) ? opts.priority : 50;
        const force = Boolean(opts.force);
        if (!force) {
            if (!this.alertsEnabled) return false;
            if (this.isMuted() && priority < 100) return false;
            if (opts.drivingOnly && !this.driving() && priority < 90) return false;
        }
        const now = Date.now();
        if (opts.key) {
            const last = this.recentKeys.get(opts.key);
            if (last && now - last < (Number.isFinite(opts.cooldownMs) ? opts.cooldownMs : 20000)) return false;
            this.recentKeys.set(opts.key, now);
            if (this.recentKeys.size > 200) {
                for (const [k, t] of this.recentKeys) if (now - t > 10 * 60 * 1000) this.recentKeys.delete(k);
            }
        }
        const item = {
            text: String(text), priority, createdAt: now, maxAgeMs: Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : 12000,
            onDone: typeof opts.onDone === "function" ? opts.onDone : null,     // (finished: boolean) once it's over
            isAskPrompt: Boolean(opts.askPrompt)
        };

        // While a question waits for its answer, only something that matters
        // (warnings, directions, safety: priority ≥ 60) may speak over it;
        // the rest queues until the answer is in.
        const holdForAsk = Boolean(this.asking && this.asking.phase === "listen" && priority < 60);
        if (!this.current && !holdForAsk) { this.speakNow(item); return true; }
        if (this.current && priority > this.current.priority) {
            // Pre-empt. Chrome can drop an utterance queued in the same tick
            // as cancel(), so the new one starts a moment later.
            const old = this.current;
            this.current = item;
            clearTimeout(this.watchdog);
            this.settle(old, false);
            try { this.synth.cancel(); } catch (e) { /* ignore */ }
            setTimeout(() => { if (this.current === item) this.utter(item); }, 60);
            return true;
        }
        this.queue.push(item);
        this.queue.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
        if (this.queue.length > this.MAX_QUEUE) for (const dropped of this.queue.splice(this.MAX_QUEUE)) this.settle(dropped, false);
        return true;
    },

    /** Tell whoever waits on an utterance that it's over (once). */
    settle(item, finished) {
        if (!item || !item.onDone) return;
        const fn = item.onDone;
        item.onDone = null;
        try { fn(Boolean(finished)); } catch (e) { /* ignore */ }
    },

    speakNow(item) {
        this.current = item;
        this.utter(item);
    },

    utter(item) {
        // Something that matters is about to be spoken while the mic waits for an answer:
        // stop listening (the mic would hear the speaker) and drop that question.
        if (this.asking && this.asking.phase === "listen" && typeof this.asking.abort === "function") this.asking.abort("interrupted");
        this.suspendRecognitionForTts();
        let u;
        try { u = new SpeechSynthesisUtterance(item.text); } catch (e) { this.done(item, false); return; }
        if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; } else u.lang = "en-IN";
        u.rate = 1; u.pitch = 1; u.volume = 1;
        u.onend = () => this.done(item, true);
        u.onerror = () => this.done(item, false);
        clearTimeout(this.watchdog);
        // Some engines never fire onend; don't let the queue wedge.
        this.watchdog = setTimeout(() => this.done(item, true), Math.max(4000, item.text.length * 110));
        try { this.synth.speak(u); } catch (e) { this.done(item, false); }
    },

    done(item, finished = true) {
        if (this.current !== item) return;          // a pre-empted utterance's late onend/onerror
        clearTimeout(this.watchdog);
        this.current = null;
        this.lastTtsEndTs = Date.now();
        this.settle(item, finished);
        // After a question, the mic needs the floor: the queue waits for the answer
        // (askThenSay calls kickQueue() when it's over).
        if (item.isAskPrompt || (this.asking && this.asking.phase === "listen")) return;
        this.kickQueue(120);
    },

    /** Start the next queued utterance, or hand the mic back to hands-free listening. */
    kickQueue(delayMs = 0) {
        if (this.current) return;
        const now = Date.now();
        this.queue = this.queue.filter((q) => { const fresh = now - q.createdAt <= q.maxAgeMs; if (!fresh) this.settle(q, false); return fresh; });
        const next = this.queue.shift();
        if (next) {
            if (delayMs > 0) setTimeout(() => {
                const askListening = this.asking && this.asking.phase === "listen" && next.priority < 60;
                if (!this.current && !askListening) this.speakNow(next); else this.queue.unshift(next);
            }, delayMs);
            else this.speakNow(next);
        } else this.resumeRecognitionAfterTts();
    },

    reply(text, extra = {}) {
        return this.announce(text, { priority: 80, force: true, ...extra });
    },

    // ------------------------------------------------------------ ask first
    // "Bhai, ek baat bolun?" → listen ~3.5 s → speak the cue only after a yes.
    // The gate decides WHEN to ask (js/advice/gate.js, "Ask before tips");
    // js/advice/ask.js runs the conversation and reads the answer.

    /** Can the phone ask and listen right now? If not, voiceAnnounce falls back to the old behaviour. */
    canAsk() {
        return Boolean(this.Recognition && this.synth && window.MUAdvice && window.MUAdvice.ask
            && !this.micBlocked && !this.asking && Date.now() > this.askOffUntil
            && this.alertsEnabled && !this.isMuted() && !this.callActive()
            && this.listenMode !== "ptt" && document.visibilityState === "visible");
    },

    /**
     * Ask, listen, then speak `text` only if the rider says yes.
     * @param {string} text the cue, already approved by the gate
     * @param {object} opts voiceAnnounce opts (priority, category, key, onResult …)
     * @param {{ fallbackSpeak?: boolean }} [decision] the gate's decision
     * @returns {Promise<boolean>} spoken?
     */
    async askThenSay(text, opts = {}, decision = {}) {
        const A = window.MUAdvice || {};
        const category = opts.category || "general";
        const M = window.MUMaster && window.MUMaster.live;
        const style = M && M.persona && M.persona.style === "plain" ? "plain" : "desi";
        const prompt = A.ask.promptFor({ category, style, avoid: this.lastPrompt });
        this.lastPrompt = prompt;
        const session = { text, opts, phase: "prompt", abort: null };
        this.asking = session;
        // On screen it's always English (the spoken question may be Hinglish).
        islandShow({ id: "voice-ask", kind: "info", icon: "🎙️", title: A.ask.promptFor({ category, style: "plain", rng: () => 0 }), sub: "Listening: say “yes” or “no”", ttl: 8000, haptic: false });
        let res;
        try {
            res = await A.ask.runAsk({
                prompt,
                speak: (t) => this.speakAndWait(t, opts.priority),
                listen: (ms) => { session.phase = "listen"; return this.listenOnce(ms, session); },
                listenMs: this.ASK_LISTEN_MS
            });
        } catch (e) { res = { answer: "unavailable", heard: "" }; }
        if (this.asking === session) this.asking = null;
        islandHide("voice-ask");
        try { if (A.live && typeof A.live.noteAnswer === "function") A.live.noteAnswer(category, res.answer); } catch (e) { /* optional */ }

        let spoken = false;
        if (res.answer === "yes" || (res.answer === "unavailable" && decision.fallbackSpeak)) {
            // Already approved by the gate: speak it now without asking again.
            const { onResult, key, ...rest } = opts;
            spoken = Boolean(this.announce(text, { ...rest, maxAgeMs: 8000 }));
        } else if (res.answer === "no") {
            islandShow({ id: "voice-ask", kind: "safe", title: "OK, maybe later", sub: "", ttl: 1500, haptic: false });
        }
        if (res.answer === "unavailable" && res.error !== "not-allowed") this.askOffUntil = Date.now() + 10 * 60 * 1000;
        this.kickQueue();                                   // anything that waited for the answer goes now
        try { document.dispatchEvent(new CustomEvent("mu:voice-ask", { detail: { prompt, answer: res.answer, heard: res.heard, category, spoken } })); } catch (e) { /* optional */ }
        try { if (typeof opts.onResult === "function") opts.onResult({ spoken, reason: `asked:${res.answer}` }); } catch (e) { /* caller's problem */ }
        return spoken;
    },

    /** Speak a line and resolve when it has finished (true) or was cut off / dropped (false). */
    speakAndWait(text, priority = 50) {
        return new Promise((resolve) => {
            const ok = this.announce(text, { priority, maxAgeMs: 4000, onDone: resolve, askPrompt: true });
            if (!ok) resolve(false);
        });
    },

    /**
     * Open the mic for one short answer.
     * Resolves null (silence), { text, alternatives } or { error }.
     */
    listenOnce(ms, session = {}) {
        return new Promise((resolve) => {
            if (!this.Recognition) { resolve({ error: "unavailable" }); return; }
            if (this.listenMode === "ptt") { resolve({ error: "busy" }); return; }
            // hands-free steps aside; it comes back when the ask is over (kickQueue → resumeRecognitionAfterTts)
            this.stopRecognizerOnly();
            clearTimeout(this.restartTimer);
            clearTimeout(this.resumeTimer);
            this.listenMode = "ask";
            let r = null, timer = null, finished = false, talking = false;
            const finish = (value) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                session.abort = null;
                if (this.recognizer === r) this.recognizer = null;
                if (this.listenMode === "ask") this.listenMode = null;
                if (r) { try { r.abort(); } catch (e) { /* ignore */ } }
                this.setMicUi(false);
                resolve(value);
            };
            session.abort = (why) => finish({ error: why || "interrupted" });
            const arm = (waitMs) => { clearTimeout(timer); timer = setTimeout(() => finish(null), waitMs); };
            const start = () => {
                if (finished) return;
                try { r = new this.Recognition(); } catch (e) { finish({ error: "unavailable" }); return; }
                r.lang = this.recognitionLang();
                r.continuous = false;
                r.interimResults = true;                       // the browser tells us as soon as the rider starts talking
                r.maxAlternatives = 3;
                r.onstart = () => { if (!talking) arm(ms); };  // count the window from when the mic is really open
                r.onresult = (e) => {
                    const alts = [];
                    let final = false;
                    for (let i = e.resultIndex; i < e.results.length; i++) {
                        const res = e.results[i];
                        if (!res.isFinal) continue;
                        final = true;
                        for (let k = 0; k < res.length; k++) if (res[k] && res[k].transcript) alts.push(res[k].transcript);
                    }
                    if (final && alts.length) finish({ text: alts[0], alternatives: alts });
                    else if (!talking) { talking = true; arm(this.ASK_EXTEND_MS); }   // let them finish the sentence
                };
                r.onerror = (e) => {
                    const err = e && e.error;
                    if (err === "not-allowed" || err === "service-not-allowed") { this.micBlocked = true; finish({ error: "not-allowed" }); }
                    else if (err === "no-speech" || err === "aborted") finish(null);
                    else finish({ error: err || "error" });                       // network, audio-capture …
                };
                r.onend = () => finish(null);
                this.recognizer = r;
                try { r.start(); } catch (e) { finish({ error: "unavailable" }); return; }
                this.setMicUi(true, "ask");
                arm(ms + 1500);          // if onstart never fires (the native shim fires it after its permission check)
            };
            timer = setTimeout(start, this.ASK_ECHO_MS);
        });
    },

    // --------------------------------------------------------------- listening
    recognitionLang() {
        const l = navigator.language || "en-IN";
        // Indian English recognises Hinglish commands ("chalo", "ruko") better
        // than hi-IN does for our English grammar.
        return /^(en|hi)\b/i.test(l) ? "en-IN" : l;
    },

    callActive() {
        const oneToOne = typeof peerConnection !== "undefined" && Boolean(peerConnection);
        const squad = typeof VoiceSquad !== "undefined" && VoiceSquad.active;
        return oneToOne || squad;
    },

    shouldHandsFree() {
        return Boolean(this.handsFree && this.Recognition && this.driving()
            && document.visibilityState === "visible" && !this.callActive()
            && Date.now() > this.handsFreePausedUntil);
    },

    updateHandsFree() {
        const want = this.shouldHandsFree();
        if (want && !this.listenMode && !this.current) this.startListening("handsfree");
        else if (!want && this.listenMode === "handsfree") this.stopListening();
    },

    togglePushToTalk() {
        this.unlock();
        if (!this.Recognition) {
            showToast("Voice commands aren't supported in this browser — try Chrome on Android.", 4500);
            return;
        }
        if (this.listenMode === "ptt") { this.stopListening(); return; }
        if (this.callActive()) { showToast("Voice commands are paused during a call.", 3500); return; }
        if (this.asking && typeof this.asking.abort === "function") this.asking.abort("interrupted");   // the rider wants to give a command
        if (this.current) this.silence();           // the rider wants to talk, not listen
        this.startListening("ptt");
    },

    startListening(mode) {
        this.stopRecognizerOnly();
        let r;
        try { r = new this.Recognition(); } catch (e) { return false; }
        r.lang = this.recognitionLang();
        r.interimResults = false;
        r.maxAlternatives = 3;
        r.continuous = mode === "handsfree";
        r.onresult = (e) => this.onResult(e, mode);
        r.onerror = (e) => this.onError(e, mode);
        r.onend = () => this.onEnd(r, mode);
        this.recognizer = r;
        this.listenMode = mode;
        try { r.start(); } catch (e) {
            this.recognizer = null;
            this.listenMode = null;
            return false;
        }
        this.setMicUi(true, mode);
        if (mode === "ptt") {
            const pending = this.pendingConfirm && this.pendingConfirm.until > Date.now();
            islandShow({ id: "voice-listen", kind: "info", icon: "🎙️", title: pending ? "Say “confirm SOS”" : "Listening…", sub: pending ? "Or say “cancel”" : "Try “how far?” or “where is …”", ttl: 9000, haptic: false });
        }
        return true;
    },

    stopRecognizerOnly() {
        const r = this.recognizer;
        this.recognizer = null;
        this.listenMode = null;
        if (r) { try { r.abort(); } catch (e) { /* ignore */ } }
    },

    stopListening() {
        this.stopRecognizerOnly();
        clearTimeout(this.restartTimer);
        islandHide("voice-listen");
        this.setMicUi(false);
    },

    setMicUi(on, mode) {
        ["voice-cmd-btn", "voice-cmd-map-btn"].forEach((id) => {
            const b = document.getElementById(id);
            if (!b) return;
            b.classList.toggle("listening", Boolean(on));
            b.setAttribute("aria-pressed", on ? "true" : "false");
            b.setAttribute("aria-label", on ? (mode === "handsfree" ? "Hands-free listening — tap to give a command now" : mode === "ask" ? "Listening for your answer" : "Listening — tap to stop") : "Voice command");
        });
    },

    onResult(e, mode) {
        // Echo guard: never act on something heard while (or just after) we spoke.
        if (this.current || Date.now() - this.lastTtsEndTs < this.ECHO_GUARD_MS) return;
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            if (!res.isFinal) continue;
            const alts = [];
            for (let k = 0; k < res.length; k++) alts.push({ transcript: res[k].transcript, confidence: res[k].confidence });
            this.handleAlternatives(alts, mode);
        }
    },

    handleAlternatives(alts, mode) {
        const ctx = { mode, pendingSos: Boolean(this.pendingConfirm && this.pendingConfirm.type === "sos" && this.pendingConfirm.until > Date.now()) };
        for (const a of alts) {
            const text = normalizeSpeech(a.transcript);
            if (!text) continue;
            if (mode === "handsfree") {
                if (text.split(" ").length > 8) continue;                 // conversation, not a command
                if (a.confidence > 0 && a.confidence < 0.45) continue;
            }
            const cmd = matchVoiceCommand(text, ctx);
            if (cmd) {
                if (mode === "ptt") islandHide("voice-listen");
                this.execute(cmd);
                return true;
            }
        }
        if (mode === "ptt") {
            islandHide("voice-listen");
            this.reply("Sorry, I didn't catch a command. Say help to hear what I can do.");
        }
        return false;
    },

    onError(e, mode) {
        const err = e && e.error;
        if (err === "no-speech" || err === "aborted") return;    // normal; onend decides what's next
        const now = Date.now();
        this.errorTimes = this.errorTimes.filter((t) => now - t < 60000);
        this.errorTimes.push(now);
        if (err === "not-allowed" || err === "service-not-allowed") {
            this.micBlocked = true;                  // ask-first falls back to speaking tips as before
            this.handsFree = false;
            try { localStorage.setItem(this.KEY_HANDSFREE, "0"); } catch (x) { /* ignore */ }
            const t = document.getElementById("voice-handsfree-toggle");
            if (t) t.checked = false;
            showToast("Microphone access is blocked, so voice commands are off. Allow the mic in site settings to use them.", 6000);
        } else if (err === "audio-capture") {
            showToast("No microphone was found for voice commands.", 4000);
        } else if (err === "network") {
            if (mode === "ptt") showToast("Voice commands need a connection in this browser.", 4000);
        }
        if (mode === "handsfree" && this.errorTimes.length >= 5) {
            this.handsFreePausedUntil = now + 2 * 60 * 1000;
            islandShow({ id: "voice-paused", kind: "sensor", title: "Hands-free paused", sub: "Voice recognition kept failing — retrying in 2 min", ttl: 5000, haptic: false });
        }
    },

    onEnd(r, mode) {
        if (this.recognizer !== r) return;          // superseded or aborted on purpose
        this.recognizer = null;
        this.listenMode = null;
        this.setMicUi(false);
        if (mode === "ptt") islandHide("voice-listen");
        if (this.suspendedForTts) return;           // resumes after the utterance
        if (this.shouldHandsFree()) {
            // Continuous recognition still ends after silence; pick it back up.
            clearTimeout(this.restartTimer);
            this.restartTimer = setTimeout(() => { if (!this.listenMode && !this.current && this.shouldHandsFree()) this.startListening("handsfree"); }, 350);
        }
    },

    suspendRecognitionForTts() {
        if (this.listenMode === "handsfree" && this.recognizer) {
            this.suspendedForTts = true;
            this.stopRecognizerOnly();
            this.setMicUi(false);
        }
    },

    resumeRecognitionAfterTts() {
        this.suspendedForTts = false;
        clearTimeout(this.resumeTimer);
        this.resumeTimer = setTimeout(() => {
            if (this.current || this.listenMode) return;
            const pending = this.pendingConfirm && this.pendingConfirm.until > Date.now();
            if (this.shouldHandsFree()) this.startListening("handsfree");
            else if (pending) this.startListening("ptt");        // listen once more for "confirm SOS"
        }, 600);
    },

    // ---------------------------------------------------------------- commands
    execute(cmd) {
        switch (cmd.name) {
            case "help":
                this.reply("You can say: how far, where is, then a name, squad status, radio status, regroup, who's approaching, speed limit, avoid tolls, navigate to, then a place, start navigation, stop navigation, where am I, mute, or send S O S.");
                break;
            case "mute":
                this.mutedUntil = Date.now() + this.MUTE_MS;
                this.queue = [];
                this.reply("Alerts muted for 30 minutes. Emergency alerts still come through.");
                islandShow({ id: "voice-muted", kind: "info", icon: "🔇", title: "Voice alerts muted", sub: "30 minutes · say “unmute” to undo", ttl: 4000, haptic: false });
                break;
            case "unmute":
                this.mutedUntil = 0;
                this.reply("Voice alerts are back on.");
                break;
            case "stopNav": {
                if (navState.active || navState.ready) {
                    const wasActive = navState.active;
                    stopDrive(!wasActive);
                    this.reply(wasActive ? "Navigation ended." : "Route cancelled.");
                } else this.reply("You're not navigating right now.");
                break;
            }
            case "startNav":
                this.startNavigation();
                break;
            case "navigateTo":
                this.navigateTo(cmd.arg || "");
                break;
            case "whereAmI":
                this.whereAmI();
                break;
            case "whereIs":
                this.whereIs(cmd.arg || "");
                break;
            case "convoy":
                this.reply(typeof ConvoyIntelligence !== "undefined" ? ConvoyIntelligence.summary() : "Convoy status isn't available.");
                break;
            case "radio":
                this.reply(ConvoyRelay.summary());
                break;
            case "regroup":
                this.reply(Phase5UI.regroupSummary());
                break;
            case "speedLimit":
                this.reply(typeof SpeedLimits !== "undefined" ? SpeedLimits.describe() : "I don't know the speed limit here.");
                break;
            case "routeAvoid": {
                if (typeof RoutePrefs === "undefined" || !cmd.arg) { this.reply("Route options aren't available right now."); break; }
                const [verb, list] = cmd.arg.split(":");
                const on = verb === "avoid";
                list.split(",").forEach((c) => { if (c === "toll") RoutePrefs.avoidTolls = on; if (c === "motorway") RoutePrefs.avoidHighways = on; });
                RoutePrefs.lastNoticeAt = 0;
                RoutePrefs.save();
                const what = RoutePrefs.describe(list.split(","));
                const later = typeof navState !== "undefined" && navState.active ? " Your current route stays as it is; the next route will follow this." : "";
                this.reply(on ? `OK. Routes will avoid ${what}.${later}` : `OK. Routes can use ${what} again.${later}`);
                break;
            }
            case "approaching":
                this.reply(Phase5UI.motionSummary());
                break;
            case "howFar":
                if ((navState.active || navState.ready) && Number.isFinite(navState.remainingM)) {
                    const next = navState.nextManeuver ? ` Next, ${lowerFirst(navState.nextManeuver)}.` : "";
                    this.reply(`${spokenDistance(navState.remainingM)} to ${navState.destName || "go"}, about ${spokenMinutes((navState.etaSec || 0) / 60)}.${next}`);
                } else this.reply("You're not navigating right now.");
                break;
            case "speed": {
                const v = typeof GpsFilter !== "undefined" ? GpsFilter.lastSmoothed : (myCoords && myCoords.speedKmh) || 0;
                this.reply(v > 3 ? `You're doing ${Math.round(v)} kilometres per hour.` : "You're not moving.");
                break;
            }
            case "recenter": {
                const b = document.getElementById("my-location-btn");
                if (myCoords) { map.flyTo([myCoords.lat, myCoords.lng], 16, { animate: true, duration: 0.8 }); this.reply("Centred on you."); }
                else if (b) { b.click(); this.reply("Still waiting for your GPS position."); }
                break;
            }
            case "sos":
                if (!myCoords) { this.reply("I can't send an S O S yet — waiting for your GPS position."); break; }
                this.pendingConfirm = { type: "sos", until: Date.now() + 10000 };
                islandShow({
                    id: "voice-sos", kind: "sos", title: "Say “confirm SOS”", sub: "Or tap to send · expires in 10 s", ttl: 10000,
                    action: { label: "Send", onClick: () => this.confirmSos() }
                });
                this.reply("Say confirm S O S within 10 seconds to alert your squad, or say cancel.", { priority: 95 });
                break;
            case "confirmSos":
                this.confirmSos();
                break;
            case "cancelPending":
                this.pendingConfirm = null;
                islandHide("voice-sos");
                this.reply("Cancelled.");
                break;
            default:
                break;
        }
    },

    confirmSos() {
        const valid = this.pendingConfirm && this.pendingConfirm.type === "sos" && this.pendingConfirm.until > Date.now();
        this.pendingConfirm = null;
        islandHide("voice-sos");
        if (!valid) { this.reply("That request expired. Say send S O S again if you need help."); return; }
        const how = typeof sendSOS === "function" ? sendSOS() : false;
        if (how === "radio") this.reply("No mobile data here. S O S sent over the radio — I'll tell you when a rider confirms it.", { priority: 100 });
        else if (how === "queued") this.reply("No connection right now. Your S O S will send the moment you're back online.", { priority: 100 });
        else if (how) this.reply("S O S sent. Your squad has your location.", { priority: 100 });
        else this.reply("I couldn't send the S O S — no GPS position yet.");
    },

    startNavigation() {
        if (navState.active) { this.reply("You're already navigating."); return; }
        const startBtn = document.getElementById("btn-start-nav");
        if (navState.ready && startBtn && startBtn.style.display !== "none") { startBtn.click(); return; }   // it announces itself
        const searchBtn = document.getElementById("search-nav-btn");
        if (searchBtn && !searchBtn.disabled) {
            searchBtn.click();
            setTimeout(() => { const b = document.getElementById("btn-start-nav"); if (b && b.style.display !== "none") b.click(); }, 300);
            return;
        }
        this.reply("Search for a destination first, or say navigate to, then a place.");
    },

    async navigateTo(query) {
        const q = String(query || "").replace(/\b(please|now|right now)\b/g, " ").replace(/\s+/g, " ").trim();
        if (!q) { this.reply("Where to? Say navigate to, then a place."); return; }
        if (navState.active) { this.reply("Say stop navigation first, then ask again."); return; }
        if (!myCoords) { this.reply("I need your GPS position first."); return; }
        this.reply(`Looking for ${q}.`, { priority: 70 });
        let place = null;
        try { place = await this.findPlace(q); } catch (e) { place = null; }
        if (!place) { this.reply(`I couldn't find ${q}.`); return; }
        let route = null;
        try {
            // Honours the rider's avoid-highways/tolls setting (app.js RoutePrefs).
            const url = `${OSRM_BASE}/route/v1/driving/${myCoords.lng},${myCoords.lat};${place.lng},${place.lat}?overview=full&geometries=geojson&steps=true`;
            const data = typeof RoutePrefs !== "undefined" ? await RoutePrefs.fetchRoute(url) : await (await fetch(url)).json();
            route = data && data.routes && data.routes[0];
            if (route) route.avoidInfo = data.avoid || null;
        } catch (e) { route = null; }
        if (!route) { this.reply(`I found ${place.name}, but couldn't get a road route there.`); return; }
        startSearchNavigation(place.lat, place.lng, place.name, route);
        // The rider isn't looking at a toast: SAY when the avoid setting couldn't be met.
        const av = route.avoidInfo;
        let caveat = "";
        if (av && av.requested.length) {
            const missed = av.requested.filter((c) => !av.applied.includes(c));
            caveat = missed.length ? ` This route can't avoid ${RoutePrefs.describe(missed)}.` : ` Avoiding ${RoutePrefs.describe(av.requested)}.`;
        }
        this.reply(`${place.name}. ${spokenDistance(route.distance)}, about ${spokenMinutes(route.duration / 60)}.${caveat} Say start navigation to go.`);
    },

    // Google Places (already loaded, key referrer-restricted) first; free
    // Nominatim as the fallback so the command still works if Places isn't up.
    findPlace(query) {
        const near = myCoords ? { lat: myCoords.lat, lng: myCoords.lng } : null;
        const viaGoogle = () => new Promise((resolve) => {
            try {
                if (!(window.google && google.maps && google.maps.places && google.maps.places.PlacesService)) return resolve(null);
                const svc = new google.maps.places.PlacesService(document.createElement("div"));
                const req = { query, fields: ["name", "geometry", "formatted_address"] };
                if (near) req.locationBias = { center: near, radius: 50000 };
                const timer = setTimeout(() => resolve(null), 6000);
                svc.findPlaceFromQuery(req, (results, status) => {
                    clearTimeout(timer);
                    const p = results && results[0];
                    if (status === google.maps.places.PlacesServiceStatus.OK && p && p.geometry && p.geometry.location) {
                        resolve({ name: p.name || query, lat: p.geometry.location.lat(), lng: p.geometry.location.lng() });
                    } else resolve(null);
                });
            } catch (e) { resolve(null); }
        });
        const viaNominatim = async () => {
            try {
                const box = near ? `&viewbox=${near.lng - 0.5},${near.lat + 0.5},${near.lng + 0.5},${near.lat - 0.5}` : "";
                const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}${box}`, { headers: { "Accept-Language": navigator.language || "en" } });
                if (!r.ok) return null;
                const j = await r.json();
                const p = j && j[0];
                if (!p) return null;
                const lat = Number(p.lat), lng = Number(p.lon);
                if (!validCoord(lat, lng)) return null;
                return { name: p.name || String(p.display_name || query).split(",")[0], lat, lng };
            } catch (e) { return null; }
        };
        return viaGoogle().then((g) => g || viaNominatim());
    },

    whereAmI() {
        if (!myCoords) { this.reply("I don't have your GPS position yet."); return; }
        const v = typeof GpsFilter !== "undefined" ? GpsFilter.lastSmoothed : 0;
        let s = `You're near ${cityName || "an unnamed area"}`;
        if (v > 3) s += `, moving at ${Math.round(v)} kilometres per hour`;
        s += ".";
        if (myCoords.est) s += ` GPS is lost, so that's an estimate, good to about ${spokenDistance(myCoords.accuracy || 0)}.`;
        if ((navState.active || navState.ready) && Number.isFinite(navState.remainingM)) s += ` ${spokenDistance(navState.remainingM)} from ${navState.destName}.`;
        this.reply(s);
    },

    findRider(query) {
        const q = normalizeSpeech(query).replace(/\b(right now|now|please|at)\b/g, " ").replace(/\s+/g, " ").trim();
        if (!q) return null;
        let best = null;
        Object.values(friendData).forEach((f) => {
            const full = normalizeSpeech(f.name);
            if (!full) return;
            const first = full.split(" ")[0];
            let score = Infinity;
            if (full === q || first === q) score = 0;
            else if (full.includes(q) || q.includes(first)) score = 1;
            else {
                const d = Math.min(editDistance(first, q), editDistance(full, q));
                if (d <= Math.max(1, Math.floor(q.length / 4))) score = 1 + d;
            }
            if (score < Infinity && (!best || score < best.score)) best = { f, score };
        });
        return best ? best.f : null;
    },

    whereIs(query) {
        const f = this.findRider(query);
        if (!f) { this.reply(`I don't see anyone called ${normalizeSpeech(query) || "that"} on the map.`); return; }
        const radio = f.online === false && typeof friendIsLive === "function" && friendIsLive(f);
        if (f.online === false && !radio) { this.reply(`${f.name} is offline.`); return; }
        if (!validCoord(f.lat, f.lng)) { this.reply(`${f.name} isn't sharing a location right now.`); return; }
        if (!myCoords) { this.reply(`${f.name} is on the map, but I don't have your position yet.`); return; }
        const dist = map.distance([myCoords.lat, myCoords.lng], [f.lat, f.lng]);
        const dir = compassWord(myCoords.lat, myCoords.lng, f.lat, f.lng);
        let s = `${f.name} is ${f.approx || f.est ? "roughly " : ""}${spokenDistance(dist)} ${dir} of you`;
        if (!f.approx) s += Number(f.speedKmh) > 3 ? `, moving at ${Math.round(f.speedKmh)} kilometres per hour` : ", not moving";
        s += ".";
        if (radio) s += ` They have no mobile data; that position came over the radio ${agoText(f.fixAt || f.viaAt)}.`;
        // Phase 5: how you're moving relative to each other.
        const mo = Phase5UI.motionFor(f.id);
        if (mo && mo.rel.status === "meeting") s += ` You're closing at ${Math.round(mo.rel.closingMs * 3.6)} kilometres per hour and should meet in about ${spokenMinutes(mo.rel.meetInS / 60)}.`;
        else if (mo && mo.rel.status === "approaching") s += ` You're getting closer, but on this heading you'll pass about ${spokenDistance(mo.rel.cpaM)} apart.`;
        else if (mo && mo.rel.status === "passed") s += " You passed each other a moment ago.";
        else if (mo && mo.rel.status === "moving-away") s += " You're moving apart.";
        const extra = typeof ConvoyIntelligence !== "undefined" ? ConvoyIntelligence.sentenceFor(f.id) : "";
        if (extra) s += ` ${extra}`;
        this.reply(s);
    }
};
