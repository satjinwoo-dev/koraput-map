/* ============================================================================
   MapUnite Ride Edit — finding the person in a photo or a frame (on the phone)
   ==============================================================================
   MUEditSegment.load()           → true when the person model is ready
   MUEditSegment.mask(source)     → { area, cx, cy, bbox, canvas } or null
   MUEditSegment.cutout(source)   → a canvas with only the person (feathered edge)

   MediaPipe's selfie segmenter (~250 KB, Apache-2.0), run with the
   @mediapipe/tasks-vision WebAssembly runtime, entirely on the phone: nothing
   is uploaded. Files come from /vendor/mediapipe/ (scripts/fetch-mediapipe.mjs
   puts them there, and the Android app ships them); without them, the CDN
   copy of the same pinned version, when online. If neither loads, the editor
   simply skips the effects that need a cut-out (clone, ghost, text behind the
   rider, 2.5D photos) and says so.
   ============================================================================ */
"use strict";

const MUEditSegment = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document) return {};
    const VERSION = "0.10.21";
    const LOCAL = "vendor/mediapipe/";
    const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/`;
    const MODEL_CDN = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
    let seg = null, loading = null, failed = false;
    const SIZE = 256;
    const work = document.createElement("canvas"), wctx = /** @type {CanvasRenderingContext2D} */ (work.getContext("2d", { willReadFrequently: true }));

    async function exists(url) { try { const r = await fetch(url, { method: "HEAD" }); return r.ok; } catch (e) { return false; } }

    async function load() {
        if (seg) return true;
        if (failed) return false;
        if (!loading) loading = (async () => {
            const local = await exists(`${LOCAL}vision_bundle.mjs`);
            const base = local ? new URL(LOCAL, W.location.href).href : CDN;
            const vision = await import(`${base}vision_bundle.mjs`);
            const files = await vision.FilesetResolver.forVisionTasks(`${base}wasm`);
            const model = local && await exists(`${LOCAL}selfie_segmenter.tflite`) ? new URL(`${LOCAL}selfie_segmenter.tflite`, W.location.href).href : MODEL_CDN;
            const make = (delegate) => vision.ImageSegmenter.createFromOptions(files, { baseOptions: { modelAssetPath: model, delegate }, runningMode: "IMAGE", outputConfidenceMasks: true, outputCategoryMask: false });
            try { seg = await make("GPU"); } catch (e) { seg = await make("CPU"); }
            return true;
        })().catch((e) => { failed = true; console.warn("[ride-edit] person model unavailable:", e && e.message ? e.message : e); return false; });
        return loading;
    }

    /** The person's mask on a SIZE-px copy of the source. */
    function mask(source, sw, sh) {
        if (!seg || !sw || !sh) return null;
        const k = SIZE / Math.max(sw, sh), w = Math.max(16, Math.round(sw * k)), h = Math.max(16, Math.round(sh * k));
        work.width = w; work.height = h;
        wctx.drawImage(source, 0, 0, w, h);
        let res;
        try { res = seg.segment(work); } catch (e) { return null; }
        const cm = res && res.confidenceMasks && res.confidenceMasks[0];
        if (!cm) return null;
        const conf = cm.getAsFloat32Array();
        const mw = cm.width, mh = cm.height;
        let n = 0, sx = 0, sy = 0, x0 = mw, y0 = mh, x1 = 0, y1 = 0;
        const out = document.createElement("canvas"); out.width = mw; out.height = mh;
        const octx = /** @type {CanvasRenderingContext2D} */ (out.getContext("2d"));
        const img = octx.createImageData(mw, mh);
        for (let i = 0; i < conf.length; i++) {
            const c = conf[i], x = i % mw, y = (i / mw) | 0;
            img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
            img.data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, (c - 0.35) / 0.3)) * 255);      // a soft ramp around 0.5: the feather
            if (c > 0.5) { n++; sx += x; sy += y; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
        }
        octx.putImageData(img, 0, 0);
        try { cm.close(); } catch (e) { /* older runtime */ }
        if (n < conf.length * 0.004) return { area: 0, cx: 0.5, cy: 0.5, bbox: null, canvas: null };
        return { area: n / conf.length, cx: sx / n / mw, cy: sy / n / mh, bbox: [x0 / mw, y0 / mh, (x1 + 1) / mw, (y1 + 1) / mh], canvas: out };
    }

    /** The person alone, at up to 720 px, its edge feathered by the mask's ramp. */
    function cutout(source, sw, sh, m) {
        const mm = m || mask(source, sw, sh);
        if (!mm || !mm.canvas || !mm.area) return null;
        const k = Math.min(1, 720 / Math.max(sw, sh)), w = Math.round(sw * k), h = Math.round(sh * k);
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        const x = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
        x.drawImage(source, 0, 0, w, h);
        x.globalCompositeOperation = "destination-in";
        x.filter = "blur(1px)";
        x.drawImage(mm.canvas, 0, 0, w, h);
        x.filter = "none"; x.globalCompositeOperation = "source-over";
        return { canvas: c, bbox: mm.bbox, area: mm.area, cx: mm.cx, cy: mm.cy };
    }

    return { load, mask, cutout, get ready() { return Boolean(seg); }, VERSION };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).MUEditSegment = MUEditSegment;
