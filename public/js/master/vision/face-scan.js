// @ts-check
/* ============================================================================
   MapUnite Master AI — face scan (camera + on-screen check), capability "face-scan"
   ==============================================================================
   Everything that touches the camera or the screen for the fatigue check:

     offer({ onStart, onLater, timeoutMs })   a small card: "10-second fatigue
                                              check · Not now / Start check"
     scan({ durationMs, ridingSec, guard })   the check itself
     showResult(result)                       the result sheet
     cancel()                                 stop a running check

   LANGUAGE: everything on screen is plain English. The Master's VOICE may be
   desi Hinglish; that's persona.js / phrases-desi.js, never this file.

   THE CHECK
     1. The rider taps Start (the camera never opens by itself).
     2. The model loads (MediaPipe, on the phone: landmarker.js).
     3. Live front camera (getUserMedia in the WebView; Android asks for the
        camera permission once). The 10 s window starts once a face is found
        (up to 8 s to find one); a big countdown shows the seconds left.
     4. ~15 frames a second → fatigue.frameFromResult(); then
        fatigue.analyzeSession(). No frame is stored or sent.
     5. guard() is asked every frame: the moment it says "moving" (the bike
        started to roll), the camera closes and the check is dropped.
   PHOTO FALLBACK: no live camera (old WebView) but the Capacitor Camera
   plugin is bundled → one front photo → analyzeSnapshot() (less reliable,
   and the sheet says so). The photo stays in memory and is dropped.

   Result: { ok: true, result } or { ok: false, reason }
     reason: "moving" | "cancelled" | "no-face" | "camera-denied" | "camera" | "model" | "busy"
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); const M = W.MUMaster || (W.MUMaster = {}); (M.vision || (M.vision = {})).createFaceScanProvider = factory().createFaceScanProvider; }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const TEXT = Object.freeze({
        eyebrow: "Fatigue check",
        offerTitle: "10-second fatigue check",
        offerSub: "You've stopped. Look at the screen for 10 seconds. It runs on your phone and nothing is saved.",
        start: "Start check", later: "Not now",
        lookTitle: "Look at the screen",
        tips: ["Visor up", "No dark glasses", "Phone at eye level"],
        loading: "Loading the face model…", downloading: "Downloading the face model (about 10 MB, first time only)…", camera: "Opening the camera…",
        faceFound: "Face detected", faceMissing: "Looking for your face", secondsLeft: "seconds left", waiting: "Bring your face into the circle",
        moving: "The bike started moving. Check stopped.", photo: "Take a selfie: look straight at the camera",
        cancel: "Cancel", done: "Done",
        resultSub: { video: "10-second video", photo: "One photo" },
        levels: { low: "Low fatigue", moderate: "Moderate fatigue", high: "High fatigue" },
        advice: {
            high: "Don't ride on yet. Rest for 20 minutes, drink water or tea, and take a short nap if you can.",
            moderate: "Rest 10–15 more minutes and drink water before you ride on.",
            low: "Drink water before you go, and stop if you feel sleepy."
        },
        retryTitle: "Couldn't read your face", retryAdvice: "Face the light, lift your visor, take off dark glasses and try again.",
        seen: "What the check saw", nothingSeen: "No strong signs of fatigue",
        metrics: { perclos: "eyes closed", longest: "longest closure", blinks: "blinks / min" },
        confidence: { fair: "The light or angle wasn't ideal, so this result is less certain.", low: "From a single photo, so this result is less certain." },
        note: "Not a medical test. If you feel sleepy, stop, whatever the score."
    });

    const SVG_NS = "http://www.w3.org/2000/svg";
    const ICONS = {
        eye: "M12 5c5.5 0 9.5 4.6 10.6 6.4a1.1 1.1 0 0 1 0 1.2C21.5 14.4 17.5 19 12 19S2.5 14.4 1.4 12.6a1.1 1.1 0 0 1 0-1.2C2.5 9.6 6.5 5 12 5zm0 3.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z",
        dot: "M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10z",
        sign: "M5 12.5l4.2 4.2L19 7"
    };

    /**
     * @param {any} W window
     * @param {{ fatigue?: any, loadLandmarker?: (o: any) => Promise<any>, now?: () => number, fps?: number, findFaceMs?: number }} [opts]
     */
    function createFaceScanProvider(W, opts = {}) {
        const doc = W.document;
        const fatigue = opts.fatigue || (W.MUMaster && W.MUMaster.vision && W.MUMaster.vision.fatigue);
        const loadLandmarker = opts.loadLandmarker || ((/** @type {any} */ o) => W.MUMaster.vision.landmarker.load(o));
        const now = opts.now || (() => (W.performance && W.performance.now ? W.performance.now() : Date.now()));
        const frameGap = 1000 / (opts.fps || 15);
        const findFaceMs = opts.findFaceMs || 8000;
        const hasLive = () => Boolean(W.navigator && W.navigator.mediaDevices && typeof W.navigator.mediaDevices.getUserMedia === "function");
        const camPlugin = () => (W.capacitorCamera && W.capacitorCamera.Camera) || null;
        /** @type {any} */ let active = null;
        /** @type {any} */ let offerCard = null;

        // ------------------------------------------------------------------ tiny DOM helpers
        const el = (/** @type {string} */ tag, /** @type {Record<string, any>} */ attrs = {}, /** @type {any[]} */ kids = []) => {
            const e = doc.createElement(tag);
            for (const [k, v] of Object.entries(attrs)) {
                if (v == null) continue;
                if (k === "text") e.textContent = v; else if (k === "class") e.className = v; else e.setAttribute(k, v);
            }
            for (const c of kids) if (c) e.appendChild(c);
            return e;
        };
        const svg = (/** @type {string} */ tag, /** @type {Record<string, any>} */ attrs = {}, /** @type {any[]} */ kids = []) => {
            const e = doc.createElementNS(SVG_NS, tag);
            for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
            for (const c of kids) e.appendChild(c);
            return e;
        };
        const icon = (/** @type {keyof typeof ICONS} */ name, cls = "mu-fc-icon") => svg("svg", { viewBox: "0 0 24 24", class: cls, "aria-hidden": "true" }, [svg("path", { d: ICONS[name] })]);

        // ------------------------------------------------------------------ offer card
        /** @param {{ onStart: Function, onLater?: Function, timeoutMs?: number }} o */
        function offer(o) {
            if (offerCard) offerCard.close();
            const start = el("button", { class: "mu-fc-btn mu-fc-primary", type: "button", text: TEXT.start });
            const later = el("button", { class: "mu-fc-btn mu-fc-ghost", type: "button", text: TEXT.later });
            const card = el("div", { class: "mu-fc-offer", role: "dialog", "aria-label": TEXT.offerTitle }, [
                el("div", { class: "mu-fc-badge" }, [icon("eye")]),
                el("div", { class: "mu-fc-offer-text" }, [el("strong", { text: TEXT.offerTitle }), el("span", { text: TEXT.offerSub })]),
                el("div", { class: "mu-fc-actions" }, [later, start])
            ]);
            let closed = false;
            const close = () => { if (closed) return; closed = true; clearTimeout(timer); card.remove(); if (offerCard === api) offerCard = null; };
            const timer = setTimeout(() => { close(); o.onLater && o.onLater("timeout"); }, o.timeoutMs || 120000);
            start.addEventListener("click", () => { close(); o.onStart(); });
            later.addEventListener("click", () => { close(); o.onLater && o.onLater("later"); });
            doc.body.appendChild(card);
            const api = { close, get open() { return !closed; } };
            offerCard = api;
            return api;
        }

        // ------------------------------------------------------------------ the check screen
        function checkScreen() {
            const video = /** @type {HTMLVideoElement} */ (el("video", { playsinline: "", muted: "", autoplay: "" }));
            video.muted = true;
            // progress ring around (not over) the camera circle
            const ring = svg("circle", { cx: 60, cy: 60, r: 56, class: "mu-fc-ring-bar", pathLength: 100, "stroke-dasharray": 100, "stroke-dashoffset": 100 });
            const ringSvg = svg("svg", { viewBox: "0 0 120 120", class: "mu-fc-ring", "aria-hidden": "true" }, [svg("circle", { cx: 60, cy: 60, r: 56, class: "mu-fc-ring-track" }), ring]);
            const count = el("span", { class: "mu-fc-count-num", text: "10" });
            const countLabel = el("span", { class: "mu-fc-count-label", text: TEXT.secondsLeft });
            const countBox = el("div", { class: "mu-fc-count", "aria-hidden": "true" }, [count, countLabel]);
            const status = el("p", { class: "mu-fc-status", "aria-live": "polite", text: TEXT.loading });
            const chipText = el("span", { text: TEXT.faceMissing });
            const chip = el("div", { class: "mu-fc-chip" }, [icon("dot", "mu-fc-chip-dot"), chipText]);
            const cancel = el("button", { class: "mu-fc-btn mu-fc-ghost mu-fc-wide", type: "button", text: TEXT.cancel });
            const root = el("div", { class: "mu-fc mu-fc-check is-loading", role: "dialog", "aria-modal": "true", "aria-label": TEXT.offerTitle }, [
                el("div", { class: "mu-fc-sheet" }, [
                    el("p", { class: "mu-fc-eyebrow", text: TEXT.eyebrow }),
                    el("h2", { class: "mu-fc-h", text: TEXT.lookTitle }),
                    el("div", { class: "mu-fc-cam-wrap" }, [el("div", { class: "mu-fc-cam" }, [video]), ringSvg, el("div", { class: "mu-fc-spinner", "aria-hidden": "true" })]),
                    countBox,
                    chip,
                    status,
                    el("ul", { class: "mu-fc-tips", "aria-label": "Tips" }, TEXT.tips.map((t) => el("li", { text: t }))),
                    cancel
                ])
            ]);
            doc.body.appendChild(root);
            const setPhase = (/** @type {string} */ p) => { for (const c of ["is-loading", "is-finding", "is-measuring"]) root.classList.toggle(c, c === `is-${p}`); };
            return {
                root, video, cancel, setPhase,
                /** @param {string} s */ status(s) { status.textContent = s; },
                /** @param {number} p 0..1 @param {number} msLeft */
                progress(p, msLeft) {
                    ring.setAttribute("stroke-dashoffset", String(Math.round(100 - 100 * Math.max(0, Math.min(1, p)))));
                    count.textContent = String(Math.max(0, Math.ceil(msLeft / 1000)));
                },
                /** @param {boolean} on */
                face(on) { root.classList.toggle("has-face", on); chipText.textContent = on ? TEXT.faceFound : TEXT.faceMissing; },
                close() { root.remove(); }
            };
        }

        const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

        /**
         * @param {{ durationMs?: number, ridingSec?: number, guard?: () => string|null }} [o]
         * @returns {Promise<{ ok: true, result: any } | { ok: false, reason: string }>}
         */
        async function scan(o = {}) {
            if (active) return { ok: false, reason: "busy" };
            const guard = o.guard || (() => null);
            const durationMs = o.durationMs || 10000;
            if (offerCard) offerCard.close();
            const blocked = guard();
            if (blocked) return { ok: false, reason: blocked };
            const ui = checkScreen();
            /** @type {any} */ let stream = null, lm = null;
            const session = { cancelled: false };
            active = session;
            ui.cancel.addEventListener("click", () => { session.cancelled = true; });
            const stopReason = () => (session.cancelled ? "cancelled" : guard());
            const finish = (/** @type {any} */ out) => {
                try { if (stream) for (const tr of stream.getTracks()) tr.stop(); } catch (e) { /* ignore */ }
                try { ui.video.srcObject = null; } catch (e) { /* ignore */ }
                try { if (lm) lm.close(); } catch (e) { /* ignore */ }
                ui.close();
                active = null;
                return out;
            };
            try {
                try { lm = await loadLandmarker({ onStatus: (/** @type {string} */ s) => ui.status(s === "download" ? TEXT.downloading : TEXT.loading) }); }
                catch (e) { return finish({ ok: false, reason: "model" }); }
                let why = stopReason();
                if (why) return finish({ ok: false, reason: why });

                if (!hasLive()) return finish(await photoCheck(lm, ui, o, stopReason));
                ui.status(TEXT.camera);
                try {
                    stream = await W.navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
                } catch (e) {
                    const name = e && /** @type {any} */ (e).name;
                    if (name === "NotAllowedError" || name === "SecurityError") return finish({ ok: false, reason: "camera-denied" });
                    if (camPlugin()) return finish(await photoCheck(lm, ui, o, stopReason));
                    return finish({ ok: false, reason: "camera" });
                }
                ui.video.srcObject = stream;
                try { await ui.video.play(); } catch (e) { /* muted autoplay is allowed; frames still arrive */ }

                const frames = [];
                const t0 = now();
                let startedAt = null, lastT = -Infinity;
                ui.setPhase("finding");
                ui.status(TEXT.waiting);
                ui.progress(0, durationMs);
                for (;;) {
                    why = stopReason();
                    if (why) { if (why === "moving") ui.status(TEXT.moving); return finish({ ok: false, reason: why }); }
                    const tNow = now();
                    if (startedAt === null && tNow - t0 > findFaceMs) return finish({ ok: false, reason: "no-face" });
                    if (startedAt !== null && tNow - startedAt >= durationMs) break;
                    if (tNow - lastT >= frameGap && ui.video.readyState >= 2) {
                        lastT = tNow;
                        let f;
                        try { f = fatigue.frameFromResult(lm.detectVideo(ui.video, tNow), tNow); } catch (e) { f = { t: tNow, face: false }; }
                        ui.face(Boolean(f.face));
                        if (startedAt === null && f.face) { startedAt = tNow; ui.setPhase("measuring"); ui.status(""); }
                        if (startedAt !== null) { frames.push(f); ui.progress((tNow - startedAt) / durationMs, durationMs - (tNow - startedAt)); }
                    }
                    await wait(Math.max(5, Math.min(frameGap / 2, 30)));
                }
                return finish({ ok: true, result: fatigue.analyzeSession(frames, { ridingSec: o.ridingSec }) });
            } catch (e) {
                return finish({ ok: false, reason: "camera" });
            }
        }

        /** One front photo via the Capacitor Camera plugin. */
        async function photoCheck(/** @type {any} */ lm, /** @type {any} */ ui, /** @type {any} */ o, /** @type {() => string|null} */ stopReason) {
            const Camera = camPlugin();
            if (!Camera) return { ok: false, reason: "camera" };
            ui.status(TEXT.photo);
            let photo;
            try {
                photo = await Camera.getPhoto({ source: "CAMERA", direction: "FRONT", resultType: "dataUrl", quality: 70, width: 720, saveToGallery: false, correctOrientation: true });
            } catch (e) {
                const msg = String((e && /** @type {any} */ (e).message) || e);
                return { ok: false, reason: /denied|permission/i.test(msg) ? "camera-denied" : "cancelled" };
            }
            const why = stopReason();
            if (why) return { ok: false, reason: why };
            const img = /** @type {HTMLImageElement} */ (el("img"));
            await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; img.src = photo.dataUrl; });
            let frame = { t: now(), face: false };
            try { frame = fatigue.frameFromResult(await lm.detectImage(img), now()); } catch (e) { /* no face */ }
            img.src = "";                                                     // drop the photo
            return { ok: true, result: fatigue.analyzeSnapshot(frame, { ridingSec: o.ridingSec }) };
        }

        // ------------------------------------------------------------------ result sheet
        /** A semicircle gauge, 0–100. @param {number} score @param {string} level */
        function gauge(score, level) {
            const arc = "M 14 100 A 86 86 0 0 1 186 100";
            return svg("svg", { viewBox: "0 0 200 108", class: `mu-fc-gauge is-${level}`, role: "img", "aria-label": `Score ${score} out of 100` }, [
                svg("path", { d: arc, class: "mu-fc-gauge-track", pathLength: 100 }),
                svg("path", { d: arc, class: "mu-fc-gauge-bar", pathLength: 100, "stroke-dasharray": 100, "stroke-dashoffset": 100 - Math.max(2, Math.min(100, score)) })
            ]);
        }
        /** "1.3 s", "33%", "12" for the small facts row. */
        function facts(/** @type {any} */ result) {
            const m = result.metrics || {};
            if (result.mode !== "video") return [];
            const out = [];
            if (Number.isFinite(m.perclos)) out.push([`${Math.round(m.perclos * 100)}%`, TEXT.metrics.perclos]);
            if (Number.isFinite(m.maxClosureMs) && m.maxClosureMs > 500) out.push([`${(m.maxClosureMs / 1000).toFixed(1)} s`, TEXT.metrics.longest]);   // only when longer than a blink
            if (Number.isFinite(m.blinkRate)) out.push([String(m.blinkRate), TEXT.metrics.blinks]);
            return out;
        }

        /** @param {any} result @param {{ timeoutMs?: number, onClose?: Function }} [o] */
        function showResult(result, o = {}) {
            const poor = result.confidence === "poor";
            const lvl = poor ? "unknown" : result.level || "low";
            const done = el("button", { class: "mu-fc-btn mu-fc-primary mu-fc-wide", type: "button", text: TEXT.done });
            const lines = poor ? [] : fatigue.signalLines(result.signals || []);
            const confNote = /** @type {any} */ (TEXT.confidence)[result.confidence] || "";
            const kids = poor
                ? [
                    el("h2", { class: "mu-fc-h", text: TEXT.retryTitle }),
                    el("p", { class: "mu-fc-advice", text: TEXT.retryAdvice })
                ]
                : [
                    el("div", { class: "mu-fc-gauge-wrap" }, [
                        gauge(result.score, lvl),
                        el("div", { class: "mu-fc-score" }, [el("span", { class: "mu-fc-score-num", text: String(result.score) }), el("span", { class: "mu-fc-score-of", text: "/100" })])
                    ]),
                    el("p", { class: `mu-fc-pill is-${lvl}`, text: /** @type {any} */ (TEXT.levels)[lvl] }),
                    el("p", { class: "mu-fc-advice", text: /** @type {any} */ (TEXT.advice)[lvl] }),
                    el("div", { class: "mu-fc-section" }, [
                        el("p", { class: "mu-fc-label", text: TEXT.seen }),
                        lines.length
                            ? el("ul", { class: "mu-fc-seen" }, lines.map((t) => el("li", {}, [icon("dot", "mu-fc-seen-dot"), el("span", { text: t })])))
                            : el("p", { class: "mu-fc-none" }, [icon("sign", "mu-fc-none-icon"), el("span", { text: TEXT.nothingSeen })])
                    ]),
                    facts(result).length ? el("dl", { class: "mu-fc-facts" }, facts(result).map(([v, k]) => el("div", {}, [el("dt", { text: v }), el("dd", { text: k })]))) : null,
                    confNote ? el("p", { class: "mu-fc-conf", text: confNote }) : null
                ];
            const root = el("div", { class: `mu-fc mu-fc-result is-${lvl}`, role: "dialog", "aria-modal": "true", "aria-label": `${TEXT.eyebrow} result` }, [
                el("div", { class: "mu-fc-sheet" }, [
                    el("p", { class: "mu-fc-eyebrow", text: `${TEXT.eyebrow} · ${/** @type {any} */ (TEXT.resultSub)[result.mode] || TEXT.resultSub.video}` }),
                    ...kids,
                    el("p", { class: "mu-fc-note", text: TEXT.note }),
                    done
                ])
            ]);
            let closed = false;
            const close = () => { if (closed) return; closed = true; clearTimeout(timer); root.remove(); o.onClose && o.onClose(); };
            const timer = setTimeout(close, o.timeoutMs || 30000);
            done.addEventListener("click", close);
            doc.body.appendChild(root);
            return { close };
        }

        return {
            available: () => Boolean(fatigue) && (hasLive() || Boolean(camPlugin())),
            busy: () => Boolean(active),
            offer, scan, showResult,
            cancel() { if (active) active.cancelled = true; if (offerCard) offerCard.close(); },
            get offerOpen() { return Boolean(offerCard && offerCard.open); },
            closeOffer() { if (offerCard) offerCard.close(); }
        };
    }

    return { createFaceScanProvider, TEXT };
});
