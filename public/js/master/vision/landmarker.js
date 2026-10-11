// @ts-check
/* ============================================================================
   MapUnite Master AI — MediaPipe Face Landmarker loader (on-device)
   ==============================================================================
   Loads Google's MediaPipe Tasks Vision (WASM) and the face_landmarker model
   only when a fatigue check actually starts: nothing is downloaded at app
   start. Everything runs on the phone; no frame leaves it.

   Where the files come from, first that works:
     1. window.MU_MEDIAPIPE = { bundle, wasm, model }   (your own override)
     2. /vendor/mediapipe/…  bundled with the app (scripts/fetch-mediapipe.mjs
        puts them there; then it works offline, and in the Android app too)
     3. jsDelivr + Google's model bucket (needs a connection the first time;
        the browser caches them afterwards)

   load() → { detectVideo(video, tMs), detectImage(img), close(), delegate, source }
   GPU first, CPU if the GPU delegate fails. One instance at a time; close()
   frees it (face-scan.js closes it after every check: checks are ~1.5 h apart).
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory(root);
    else { const W = /** @type {any} */ (root); const M = W.MUMaster || (W.MUMaster = {}); (M.vision || (M.vision = {})).landmarker = factory(root); }
})(typeof globalThis !== "undefined" ? globalThis : this, function (/** @type {any} */ W) {
    "use strict";

    const VERSION = "0.10.14";
    const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
    const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
    const LOCAL = { bundle: "/vendor/mediapipe/vision_bundle.mjs", wasm: "/vendor/mediapipe/wasm", model: "/vendor/mediapipe/face_landmarker.task" };

    function sources() {
        const list = [];
        const o = W.MU_MEDIAPIPE;
        if (o && o.bundle && o.wasm && o.model) list.push({ name: "custom", ...o });
        list.push({ name: "bundled", ...LOCAL });
        list.push({ name: "cdn", bundle: `${CDN}/vision_bundle.mjs`, wasm: `${CDN}/wasm`, model: MODEL });
        return list;
    }

    /** Is a URL there? (HEAD; never throws) @param {string} url */
    async function exists(url) {
        try { const r = await W.fetch(url, { method: "HEAD", cache: "no-store" }); return Boolean(r && r.ok); } catch (e) { return false; }
    }

    /** @type {Promise<any>|null} */ let current = null;

    /**
     * @param {{ onStatus?: (s: string) => void }} [o]
     */
    function load(o = {}) {
        if (current) return current;
        current = (async () => {
            const say = (/** @type {string} */ s) => { try { o.onStatus && o.onStatus(s); } catch (e) { /* UI only */ } };
            /** @type {any} */ let lastErr = null;
            for (const src of sources()) {
                if (src.name === "bundled" && !(await exists(src.model))) continue;
                try {
                    say(src.name === "cdn" ? "download" : "load");
                    const mod = await import(/* webpackIgnore: true */ src.bundle);
                    const fileset = await mod.FilesetResolver.forVisionTasks(src.wasm);
                    /** @type {any} */ let lm = null, delegate = "GPU";
                    for (const d of ["GPU", "CPU"]) {
                        try {
                            lm = await mod.FaceLandmarker.createFromOptions(fileset, {
                                baseOptions: { modelAssetPath: src.model, delegate: d },
                                runningMode: "VIDEO", numFaces: 1,
                                outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
                                minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5
                            });
                            delegate = d;
                            break;
                        } catch (e) { lastErr = e; }
                    }
                    if (!lm) continue;
                    let mode = "VIDEO";
                    return {
                        delegate, source: src.name,
                        /** @param {HTMLVideoElement} video @param {number} t */
                        detectVideo(video, t) {
                            if (mode !== "VIDEO") { lm.setOptions({ runningMode: "VIDEO" }); mode = "VIDEO"; }
                            return lm.detectForVideo(video, t);
                        },
                        /** @param {HTMLImageElement|HTMLCanvasElement} img */
                        async detectImage(img) {
                            if (mode !== "IMAGE") { await lm.setOptions({ runningMode: "IMAGE" }); mode = "IMAGE"; }
                            return lm.detect(img);
                        },
                        close() { try { lm.close(); } catch (e) { /* already closed */ } current = null; }
                    };
                } catch (e) { lastErr = e; }
            }
            current = null;
            throw Object.assign(new Error(`face model unavailable: ${String((lastErr && lastErr.message) || lastErr || "no source")}`), { code: "MODEL" });
        })();
        current.catch(() => { current = null; });
        return current;
    }

    return { load, sources, VERSION };
});
