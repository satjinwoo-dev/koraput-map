// @ts-check
/* ============================================================================
   MapUnite voice — the Voice Engine (one voice, three routes)
   ==============================================================================
   Every spoken line of the app (VoiceAssistant: turns, speed alerts, the Master
   AI, ask-first questions) is played by this engine. It decides HOW, per line:

     cloud   premium neural voice from our server (/api/tts → Google Chirp 3 HD
             or ElevenLabs; keys never leave the server). Audio is cached on the
             phone (Cache Storage + memory), so a repeated line is instant and
             works offline.
     native  the MapUniteVoice plugin: Android's best installed neural voice
             (Google hi-IN / en-IN), navigation audio, ducking, Bluetooth pre-roll.
     web     the browser's speechSynthesis (website), best voice for the language.

   Text first goes through hinglish.prepare(): Hinglish lines become Devanagari
   for a hi-IN voice (natural, not robotic), English lines stay en-IN.

   Latency rules (a late warning is worse than a plain voice):
     urgent  (priority ≥ 80: safety, turns)  cloud only if already cached, else native now
     warning (60–79)                          cloud if it arrives within 700 ms, else native
     advice  (< 60)                           cloud if it arrives within 2.5 s, else native
   A cloud line that misses its budget still finishes downloading into the cache,
   so the next time it plays in the premium voice. After 3 cloud failures in a row
   the cloud is skipped for 2 minutes (no paying the wait on every line in a dead zone).

   speak(text, { priority }) → { route, done: Promise<"ended"|"cancelled"|"failed">, cancel() }
   One line plays at a time; speak() stops whatever was playing.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); (W.MUVoice || (W.MUVoice = {})).engine = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const CACHE_NAME = "mu-tts-v1";
    const MAX_CHARS = 400;                 // lib/tts.js MAX_CHARS

    /**
     * @param {{
     *   hinglish: any,
     *   serverOrigin?: string|null,           // "" = same origin (website); null = no cloud
     *   fetch?: (url: string, init?: any) => Promise<any>,
     *   native?: any,                         // MapUniteVoice plugin: speak, playAudio, stop
     *   web?: { synth: any, Utterance: any }|null,
     *   audio?: { play: (bytes: ArrayBuffer, mime: string) => { done: Promise<boolean>, stop: () => void } }|null,
     *   caches?: any,                         // CacheStorage
     *   online?: () => boolean,
     *   now?: () => number,
     *   timers?: { setTimeout: Function, clearTimeout: Function },
     *   cloud?: boolean,
     *   budgets?: { warningMs?: number, adviceMs?: number },
     *   rate?: number
     * }} o
     */
    function createVoiceEngine(o) {
        const H = o.hinglish;
        const now = o.now || (() => Date.now());
        const timers = o.timers || globalThis;
        const doFetch = o.fetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
        const online = o.online || (() => true);
        const budgets = { warningMs: 700, adviceMs: 2500, ...(o.budgets || {}) };
        const rate = Number.isFinite(o.rate) ? /** @type {number} */ (o.rate) : 1.0;
        let cloudOn = o.cloud !== false && o.serverOrigin !== null && o.serverOrigin !== undefined && Boolean(doFetch);
        let cloudFailures = 0, cloudPausedUntil = 0;
        /** @type {Map<string, { bytes: ArrayBuffer, mime: string }>} */ const memory = new Map();
        /** @type {Map<string, Promise<{ bytes: ArrayBuffer, mime: string }|null>>} */ const inflight = new Map();
        /** @type {any} */ let active = null;
        let gen = 0;
        const stats = { cloud: 0, cloudCached: 0, native: 0, web: 0, failed: 0, cloudMisses: 0 };

        const urlFor = (/** @type {any} */ p, /** @type {boolean} */ relaxed) =>
            `${o.serverOrigin || ""}/api/tts?lang=${p.lang}&rate=${rate.toFixed(2)}&m=${relaxed ? 1 : 0}&q=${encodeURIComponent(relaxed ? p.markup : p.text)}`;

        // ---------------------------------------------------------------- cloud audio (cache first)
        async function cached(/** @type {string} */ url) {
            const m = memory.get(url);
            if (m) { memory.delete(url); memory.set(url, m); return m; }                 // LRU touch
            if (!o.caches) return null;
            try {
                const c = await o.caches.open(CACHE_NAME);
                const r = await c.match(url);
                if (!r) return null;
                const v = { bytes: await r.arrayBuffer(), mime: r.headers.get("content-type") || "audio/mpeg" };
                remember(url, v);
                return v;
            } catch (e) { return null; }
        }
        function remember(/** @type {string} */ url, /** @type {{ bytes: ArrayBuffer, mime: string }} */ v) {
            memory.set(url, v);
            while (memory.size > 40) memory.delete(/** @type {string} */ (memory.keys().next().value));
        }
        /** Downloads (once per URL) into memory + Cache Storage. */
        function download(/** @type {string} */ url) {
            const running = inflight.get(url);
            if (running) return running;
            const p = (async () => {
                try {
                    const r = await /** @type {any} */ (doFetch)(url, { credentials: "omit" });
                    // the server has no voice provider set up: stop asking for this session
                    if (r && r.status === 503) { cloudOn = false; return null; }
                    if (!r || !r.ok) throw new Error(`tts ${r ? r.status : "no response"}`);
                    const mime = (r.headers && r.headers.get && r.headers.get("content-type")) || "audio/mpeg";
                    const bytes = await r.arrayBuffer();
                    if (!bytes || bytes.byteLength < 200) throw new Error("tts empty");
                    const v = { bytes, mime };
                    remember(url, v);
                    if (o.caches) {
                        try {
                            const c = await o.caches.open(CACHE_NAME);
                            await c.put(url, new (/** @type {any} */ (globalThis).Response)(bytes, { headers: { "content-type": mime } }));
                        } catch (e) { /* storage full: memory only */ }
                    }
                    cloudFailures = 0;
                    return v;
                } catch (e) {
                    cloudFailures++;
                    if (cloudFailures >= 3) { cloudPausedUntil = now() + 120000; cloudFailures = 0; }
                    return null;
                } finally { inflight.delete(url); }
            })();
            inflight.set(url, p);
            return p;
        }
        const cloudUsable = () => cloudOn && online() && now() >= cloudPausedUntil;
        /** The server takes lines up to MAX_CHARS (long replies like "help" go to the device voice). */
        const fitsServer = (/** @type {any} */ p, /** @type {boolean} */ relaxed) => String(relaxed ? p.markup : p.text).length <= MAX_CHARS;

        /** @param {Promise<any>} p @param {number} ms */
        function within(p, ms) {
            return new Promise((resolve) => {
                const t = timers.setTimeout(() => resolve(null), ms);
                p.then((v) => { timers.clearTimeout(t); resolve(v); }, () => { timers.clearTimeout(t); resolve(null); });
            });
        }

        // ---------------------------------------------------------------- players
        /** @returns {{ done: Promise<boolean>, stop: () => void }} */
        function playBytes(/** @type {{ bytes: ArrayBuffer, mime: string }} */ v, /** @type {number} */ id) {
            if (o.native && typeof o.native.playAudio === "function") {
                const done = Promise.resolve(o.native.playAudio({ base64: toBase64(v.bytes), mime: v.mime, id: String(id) }))
                    .then((/** @type {any} */ r) => Boolean(r && r.result === "ended"), () => false);
                return { done, stop: () => { try { o.native.stop(); } catch (e) { /* gone */ } } };
            }
            if (o.audio) return o.audio.play(v.bytes, v.mime);
            return { done: Promise.resolve(false), stop: () => {} };
        }
        /** @returns {{ done: Promise<boolean>, stop: () => void }} */
        function speakDevice(/** @type {any} */ p, /** @type {number} */ id, /** @type {number} */ priority) {
            if (o.native && typeof o.native.speak === "function") {
                const done = Promise.resolve(o.native.speak({ text: p.text, lang: p.lang, rate: priority >= 80 ? Math.max(rate, 1.05) : rate, id: String(id) }))
                    .then((/** @type {any} */ r) => Boolean(r && r.result === "ended"), () => false);
                return { done, stop: () => { try { o.native.stop(); } catch (e) { /* gone */ } } };
            }
            const web = o.web;
            if (web && web.synth && web.Utterance) {
                const done = new Promise((resolve) => {
                    try {
                        const u = new web.Utterance(p.text);
                        const voice = pickWebVoice(web.synth, p.lang);
                        if (voice) u.voice = voice;
                        u.lang = voice ? voice.lang : p.lang;
                        u.rate = rate; u.pitch = 1; u.volume = 1;
                        u.onend = () => resolve(true);
                        u.onerror = () => resolve(false);
                        web.synth.speak(u);
                    } catch (e) { resolve(false); }
                });
                return { done, stop: () => { try { web.synth.cancel(); } catch (e) { /* ignore */ } } };
            }
            return { done: Promise.resolve(false), stop: () => {} };
        }

        // ---------------------------------------------------------------- speak
        /**
         * @param {string} text
         * @param {{ priority?: number }} [opts]
         */
        function speak(text, opts = {}) {
            const priority = Number.isFinite(opts.priority) ? /** @type {number} */ (opts.priority) : 50;
            const relaxed = priority < 60;
            const p = H.prepare(text, { relaxed });
            stopActive();
            const id = ++gen;
            /** @type {(r: "ended"|"cancelled"|"failed") => void} */ let settle = () => {};
            const done = new Promise((resolve) => { settle = resolve; });
            const h = { id, route: "pending", done, cancelled: false, player: /** @type {any} */ (null), cancel() { if (h.cancelled) return; h.cancelled = true; if (h.player) h.player.stop(); settle("cancelled"); if (active === h) active = null; } };
            active = h;

            const run = async () => {
                const url = urlFor(p, relaxed);
                /** @type {{ bytes: ArrayBuffer, mime: string }|null} */ let audio = null;
                if (cloudUsable() && fitsServer(p, relaxed)) {
                    audio = await cached(url);
                    if (audio) stats.cloudCached++;
                    else if (priority >= 80) download(url);                                       // next time: premium
                    else audio = /** @type {any} */ (await within(download(url), priority >= 60 ? budgets.warningMs : budgets.adviceMs));
                    if (!audio && priority < 80) stats.cloudMisses++;
                }
                if (h.cancelled) return;
                if (audio) { h.route = "cloud"; stats.cloud++; h.player = playBytes(audio, id); }
                else { h.route = o.native ? "native" : "web"; stats[o.native ? "native" : "web"]++; h.player = speakDevice(p, id, priority); }
                const ok = await h.player.done;
                if (h.cancelled) return;
                if (!ok) {
                    // the premium audio failed to play: say it with the device voice rather than not at all
                    if (h.route === "cloud") {
                        h.route = o.native ? "native" : "web";
                        h.player = speakDevice(p, id, priority);
                        const ok2 = await h.player.done;
                        if (h.cancelled) return;
                        if (!ok2) stats.failed++;
                        settle(ok2 ? "ended" : "failed");
                    } else { stats.failed++; settle("failed"); }
                } else settle("ended");
                if (active === h) active = null;
            };
            run().catch(() => { if (!h.cancelled) { stats.failed++; settle("failed"); } });
            return h;
        }

        function stopActive() { if (active) active.cancel(); active = null; }

        /** Warm the cache with lines that will be needed (e.g. the ask-first questions). */
        function prefetch(/** @type {string[]} */ lines, /** @type {{ priority?: number }} */ opts = {}) {
            if (!cloudUsable()) return 0;
            const relaxed = (opts.priority ?? 50) < 60;
            let n = 0;
            for (const t of lines) {
                const p = H.prepare(t, { relaxed });
                if (!fitsServer(p, relaxed)) continue;
                const url = urlFor(p, relaxed);
                if (!memory.has(url)) { download(url); n++; }
            }
            return n;
        }

        return {
            speak, prefetch,
            stop: stopActive,
            get speaking() { return Boolean(active); },
            setCloud(/** @type {boolean} */ on) { cloudOn = Boolean(on) && o.serverOrigin !== null && o.serverOrigin !== undefined && Boolean(doFetch); },
            /** Which routes are available, plus how many lines each route has played. */
            status: () => ({ cloud: cloudOn, cloudPaused: now() < cloudPausedUntil, native: Boolean(o.native), cached: memory.size, counts: { ...stats } })
        };
    }

    /** The best browser voice for a language: same language, network (neural) voices first. @param {any} synth @param {string} lang */
    function pickWebVoice(synth, lang) {
        const voices = (synth && synth.getVoices && synth.getVoices()) || [];
        const want = lang.toLowerCase(), base = want.split("-")[0];
        const score = (/** @type {any} */ v) => {
            const l = String(v.lang || "").toLowerCase().replace("_", "-");
            let s = 0;
            if (l === want) s += 4; else if (l.split("-")[0] === base) s += 2; else return -1;
            if (/google|neural|natural|enhanced|premium/i.test(v.name || "")) s += 2;
            if (!v.localService) s += 0.5;
            return s;
        };
        const best = voices.map((v) => [score(v), v]).filter((x) => x[0] >= 0).sort((a, b) => b[0] - a[0])[0];
        return best ? best[1] : null;
    }

    /** @param {ArrayBuffer} buf */
    function toBase64(buf) {
        const bytes = new Uint8Array(buf);
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + 0x8000)));
        return typeof btoa === "function" ? btoa(s) : /** @type {any} */ (globalThis).Buffer.from(bytes).toString("base64");
    }

    /** Browser audio element player for the website (the app plays natively). @param {any} W */
    function htmlAudioPlayer(W) {
        return {
            play(/** @type {ArrayBuffer} */ bytes, /** @type {string} */ mime) {
                const url = W.URL.createObjectURL(new W.Blob([bytes], { type: mime }));
                const a = new W.Audio(url);
                const done = new Promise((resolve) => {
                    a.onended = () => resolve(true);
                    a.onerror = () => resolve(false);
                    a.play().catch(() => resolve(false));
                }).finally(() => W.URL.revokeObjectURL(url));
                return { done: /** @type {Promise<boolean>} */ (done), stop: () => { try { a.pause(); } catch (e) { /* ignore */ } } };
            }
        };
    }

    /**
     * The engine wired to this page: native plugin in the app, audio element + speechSynthesis on the web.
     * Server origin: window.MU_SERVER_ORIGIN in the app, same origin on the website.
     * Cloud voice: on the website when the server says premiumVoice; in the app whenever a
     * server origin is set (the first 503 "not-configured" turns it off for the session).
     * @param {any} W
     */
    function forWindow(W) {
        const H = W.MUVoice && W.MUVoice.hinglish;
        if (!H) return null;
        let native = null;
        try {
            const core = W.capacitorExports || null;
            const Cap = (core && core.Capacitor) || W.Capacitor;
            const register = (core && core.registerPlugin) || (Cap && Cap.registerPlugin);
            if (Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.isPluginAvailable && Cap.isPluginAvailable("MapUniteVoice") && typeof register === "function") native = register("MapUniteVoice");
        } catch (e) { native = null; }
        const cfg = W.MU_CONFIG || {};
        const origin = typeof W.MU_SERVER_ORIGIN === "string" && /^https?:\/\/[^/\s]+$/.test(W.MU_SERVER_ORIGIN) ? W.MU_SERVER_ORIGIN : "";
        // the app's config is baked at build time, so it may be older than the server's voice setup
        const cloud = cfg.premiumVoice === true || (Boolean(native) && Boolean(origin));
        return createVoiceEngine({
            hinglish: H,
            serverOrigin: cloud ? origin : null,
            native,
            web: W.speechSynthesis && W.SpeechSynthesisUtterance ? { synth: W.speechSynthesis, Utterance: W.SpeechSynthesisUtterance } : null,
            audio: native ? null : (W.Audio ? htmlAudioPlayer(W) : null),
            caches: W.caches || null,
            online: () => W.navigator ? W.navigator.onLine !== false : true
        });
    }

    return { createVoiceEngine, pickWebVoice, forWindow, htmlAudioPlayer, CACHE_NAME };
});
