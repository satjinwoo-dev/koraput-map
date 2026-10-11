// @ts-check
/* ============================================================================
   MapUnite Master AI — fatigue signs from the face (pure maths)
   ==============================================================================
   Turns MediaPipe Face Landmarker results into fatigue signs. No DOM, no
   camera, no model: face-scan.js feeds frames in, this file does the maths, so
   every rule here is tested in node.

   PER FRAME  frameFromResult(result, t) → { t, face, closure, jaw, pitch, yaw, roll, ear, mar }
     closure  0 open … 1 shut: the eyeBlinkLeft/Right blendshapes, or the eye
              aspect ratio (EAR) from the landmarks when blendshapes are missing
     jaw      0 … 1: the jawOpen blendshape, or the mouth aspect ratio
     pitch…   head angles in degrees from the facial transformation matrix

   A SHORT VIDEO (about 10 s) analyzeSession(frames, { ridingSec })
     perclos       share of time the eyes are (nearly) shut. The "closed" line
                   adapts to the rider: 0.3 above their own open-eye level,
                   so heavy-lidded eyes aren't read as sleepy
     blinks        closures ≤ 500 ms: rate per minute and mean duration
     longClosures  closures > 500 ms (microsleep-like); 1 s or two of them → high
     yawns         mouth wide open ≥ 1.2 s
     nods          head moving ≥ 14° away from its own starting angle for
                   0.25–2.5 s; droop: how far it hangs in the second half
   → score 0–100 (85 % face signs, 15 % how long you've ridden), level
     low / moderate / high, confidence good / fair / poor, and the signals.

   ONE PHOTO (fallback) analyzeSnapshot(frame): eyes and mouth only; it can't
     see blinks or nods, so confidence is "low" and it never says "high" on
     eyes alone.

   This is a rough, on-device indicator, not a medical test. A low score
   never means "fit to ride": the advice always keeps the break.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); const M = W.MUMaster || (W.MUMaster = {}); (M.vision || (M.vision = {})).fatigue = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // MediaPipe face mesh (478 points) indices
    const LEFT_EYE = [33, 160, 158, 133, 153, 144];      // corner, top ×2, corner, bottom ×2
    const RIGHT_EYE = [362, 385, 387, 263, 373, 380];
    const MOUTH = { top: 13, bottom: 14, left: 78, right: 308 };

    const T = Object.freeze({
        closedAbove: 0.3,          // closure above the rider's own open level that counts as shut
        closedMin: 0.45, closedMax: 0.75,
        blinkMaxMs: 500,
        microsleepMs: 1000,
        yawnJaw: 0.55, yawnMinMs: 1200,
        nodDeg: 14, nodMinMs: 250, nodMaxMs: 2500,
        high: 55, moderate: 30
    });

    const clamp = (/** @type {number} */ v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
    const ramp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => clamp((v - lo) / (hi - lo));
    const fin = (/** @type {any} */ v) => typeof v === "number" && Number.isFinite(v);
    /** @param {number[]} xs @param {number} q */
    function quantile(xs, q) {
        if (!xs.length) return NaN;
        const s = xs.slice().sort((a, b) => a - b);
        const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
        return s[lo] + (s[hi] - s[lo]) * (i - lo);
    }
    const median = (/** @type {number[]} */ xs) => quantile(xs, 0.5);
    const avg = (/** @type {Array<number|null>} */ ...xs) => { const v = xs.filter(fin); return v.length ? /** @type {number[]} */ (v).reduce((a, b) => a + b, 0) / v.length : null; };

    /** @param {any[]} lm @param {number[]} idx */
    function eyeAspect(lm, idx) {
        const p = idx.map((i) => lm[i]);
        if (p.some((x) => !x)) return null;
        const d = (/** @type {any} */ a, /** @type {any} */ b) => Math.hypot(a.x - b.x, a.y - b.y);
        const w = d(p[0], p[3]);
        return w > 0 ? (d(p[1], p[5]) + d(p[2], p[4])) / (2 * w) : null;
    }
    /** Head angles (degrees) from a column-major 4×4 matrix. @param {ArrayLike<number>|null|undefined} m */
    function poseFromMatrix(m) {
        if (!m || m.length < 16) return null;
        const deg = 180 / Math.PI;
        return { pitch: Math.atan2(m[6], m[10]) * deg, yaw: Math.asin(clamp(-m[2], -1, 1)) * deg, roll: Math.atan2(m[1], m[0]) * deg };
    }

    /**
     * One Face Landmarker result → one frame of signs.
     * @param {any} result FaceLandmarkerResult (faceLandmarks, faceBlendshapes, facialTransformationMatrixes)
     * @param {number} t ms
     */
    function frameFromResult(result, t) {
        const lm = result && result.faceLandmarks && result.faceLandmarks[0];
        if (!lm || lm.length < 400) return { t, face: false };
        /** @type {Record<string, number>} */ const bs = {};
        const cats = (result.faceBlendshapes && result.faceBlendshapes[0] && result.faceBlendshapes[0].categories) || [];
        for (const c of cats) if (c && c.categoryName) bs[c.categoryName] = c.score;
        const earL = eyeAspect(lm, LEFT_EYE), earR = eyeAspect(lm, RIGHT_EYE);
        const fromEar = (/** @type {number|null} */ e) => (e === null ? null : clamp((0.29 - e) / 0.16));
        const closure = fin(bs.eyeBlinkLeft) && fin(bs.eyeBlinkRight) ? (bs.eyeBlinkLeft + bs.eyeBlinkRight) / 2 : avg(fromEar(earL), fromEar(earR));
        const m = MOUTH, a = lm[m.top], b = lm[m.bottom], l = lm[m.left], r = lm[m.right];
        const mar = a && b && l && r && Math.hypot(l.x - r.x, l.y - r.y) > 0 ? Math.hypot(a.x - b.x, a.y - b.y) / Math.hypot(l.x - r.x, l.y - r.y) : null;
        const jaw = fin(bs.jawOpen) ? bs.jawOpen : mar === null ? null : clamp((mar - 0.1) / 0.5);
        const mat = result.facialTransformationMatrixes && result.facialTransformationMatrixes[0];
        const pose = poseFromMatrix(mat && (mat.data || mat));
        return { t, face: closure !== null, closure, jaw, ear: avg(earL, earR), mar, pitch: pose ? pose.pitch : null, yaw: pose ? pose.yaw : null, roll: pose ? pose.roll : null };
    }

    /**
     * Runs where pred(frame) holds, with durations (each frame lasts until the next, capped).
     * @param {any[]} fs @param {(f: any) => boolean} pred @param {number} frameMs
     */
    function runs(fs, pred, frameMs) {
        /** @type {Array<{ start: number, end: number, ms: number }>} */ const out = [];
        let start = -1;
        for (let i = 0; i <= fs.length; i++) {
            const on = i < fs.length && pred(fs[i]);
            if (on && start < 0) start = i;
            if (!on && start >= 0) {
                const end = i - 1;
                const ms = fs[end].t - fs[start].t + frameMs;
                out.push({ start: fs[start].t, end: fs[end].t, ms });
                start = -1;
            }
        }
        return out;
    }

    const rideRiskOf = (/** @type {number|undefined} */ ridingSec) => ramp(Number(ridingSec) || 0, 3600, 4 * 3600);

    /** @param {number} score @returns {"low"|"moderate"|"high"} */
    const levelOf = (score) => (score >= T.high ? "high" : score >= T.moderate ? "moderate" : "low");

    /**
     * About 10 seconds of frames → fatigue signs.
     * @param {any[]} frames frameFromResult() outputs
     * @param {{ ridingSec?: number }} [o]
     */
    function analyzeSession(frames, o = {}) {
        const all = (frames || []).filter((f) => f && fin(f.t)).slice().sort((a, b) => a.t - b.t);
        const valid = all.filter((f) => f.face && fin(f.closure));
        const faceRatio = all.length ? valid.length / all.length : 0;
        const gaps = [];
        for (let i = 1; i < valid.length; i++) gaps.push(valid[i].t - valid[i - 1].t);
        const frameMs = gaps.length ? clamp(median(gaps), 16, 250) : 66;
        let validMs = 0;
        for (let i = 0; i < valid.length; i++) validMs += i + 1 < valid.length ? Math.min(valid[i + 1].t - valid[i].t, 3 * frameMs) : frameMs;

        // eyes: an adaptive "shut" line, PERCLOS, blinks and long closures
        const openLevel = quantile(valid.map((f) => f.closure), 0.3);
        const thr = clamp((fin(openLevel) ? openLevel : 0.1) + T.closedAbove, T.closedMin, T.closedMax);
        let closedMs = 0;
        for (let i = 0; i < valid.length; i++) {
            if (valid[i].closure < thr) continue;
            closedMs += i + 1 < valid.length ? Math.min(valid[i + 1].t - valid[i].t, 3 * frameMs) : frameMs;
        }
        const perclos = validMs > 0 ? closedMs / validMs : 0;
        const closures = runs(valid, (f) => f.closure >= thr, frameMs);
        const blinks = closures.filter((r) => r.ms <= T.blinkMaxMs);
        const long = closures.filter((r) => r.ms > T.blinkMaxMs);
        const maxClosureMs = closures.reduce((m, r) => Math.max(m, r.ms), 0);
        const blinkRate = validMs >= 3000 ? blinks.length / (validMs / 60000) : null;
        const meanBlinkMs = blinks.length ? blinks.reduce((a, r) => a + r.ms, 0) / blinks.length : null;

        // mouth: yawns
        const yawns = runs(valid.filter((f) => fin(f.jaw)), (f) => f.jaw >= T.yawnJaw, frameMs).filter((r) => r.ms >= T.yawnMinMs);

        // head: nods and droop, against the rider's own starting angle
        const posed = valid.filter((f) => fin(f.pitch));
        let nods = 0, droopDeg = null;
        if (posed.length >= 10) {
            const base = median(posed.slice(0, Math.max(3, Math.floor(posed.length * 0.3))).map((f) => f.pitch));
            const dev = posed.map((f) => ({ t: f.t, d: Math.abs(f.pitch - base) }));
            nods = runs(dev, (x) => x.d >= T.nodDeg, frameMs).filter((r) => r.ms >= T.nodMinMs && r.ms <= T.nodMaxMs).length;
            droopDeg = median(dev.slice(Math.floor(dev.length / 2)).map((x) => x.d));
        }

        // score
        const parts = {
            perclos: ramp(perclos, 0.08, 0.3),
            longClosure: maxClosureMs >= T.microsleepMs || long.length >= 2 ? 1 : long.length ? 0.7 : 0,
            blinkDuration: meanBlinkMs === null ? 0 : ramp(meanBlinkMs, 150, 350),
            blinkRate: blinkRate === null ? 0 : ramp(blinkRate, 20, 40),
            yawn: yawns.length ? 1 : 0,
            nod: nods ? 1 : droopDeg !== null && droopDeg > 8 ? 0.5 : 0
        };
        const W = { perclos: 0.3, longClosure: 0.25, blinkDuration: 0.15, blinkRate: 0.05, yawn: 0.15, nod: 0.1 };
        const faceScore = Object.entries(W).reduce((s, [k, w]) => s + w * /** @type {any} */ (parts)[k], 0);
        const rideRisk = rideRiskOf(o.ridingSec);
        let score = Math.round(100 * clamp(0.85 * faceScore + 0.15 * rideRisk));
        if (parts.longClosure === 1) score = Math.max(score, T.high);            // microsleep-like: always high
        if (yawns.length && nods) score = Math.max(score, T.moderate);
        const confidence = validMs >= 6000 && faceRatio >= 0.7 && valid.length >= 30 ? "good" : validMs >= 3000 && faceRatio >= 0.4 && valid.length >= 15 ? "fair" : "poor";

        /** @type {Array<{ id: string, value?: number }>} */ const signals = [];
        if (maxClosureMs > T.blinkMaxMs) signals.push({ id: "long-closure", value: Math.round(maxClosureMs) });
        if (perclos >= 0.15) signals.push({ id: "eyes-closing", value: Math.round(perclos * 100) });
        if (yawns.length) signals.push({ id: "yawn", value: yawns.length });
        if (nods) signals.push({ id: "nod", value: nods });
        else if (droopDeg !== null && droopDeg > 8) signals.push({ id: "droop", value: Math.round(droopDeg) });
        if (meanBlinkMs !== null && meanBlinkMs >= 300) signals.push({ id: "slow-blinks", value: Math.round(meanBlinkMs) });
        if (blinkRate !== null && blinkRate >= 35) signals.push({ id: "frequent-blinks", value: Math.round(blinkRate) });

        return {
            mode: "video", score, level: levelOf(score), confidence, faceScore: Math.round(faceScore * 100) / 100, rideRisk: Math.round(rideRisk * 100) / 100,
            metrics: {
                perclos: Math.round(perclos * 1000) / 1000, blinks: blinks.length, blinkRate: blinkRate === null ? null : Math.round(blinkRate),
                meanBlinkMs: meanBlinkMs === null ? null : Math.round(meanBlinkMs), longClosures: long.length, maxClosureMs: Math.round(maxClosureMs),
                yawns: yawns.length, nods, droopDeg: droopDeg === null ? null : Math.round(droopDeg), faceRatio: Math.round(faceRatio * 100) / 100,
                frames: all.length, validMs: Math.round(validMs), threshold: Math.round(thr * 100) / 100
            },
            signals
        };
    }

    /**
     * One photo → what it can show (eyes, mouth). Never "high" on eyes alone.
     * @param {any} frame @param {{ ridingSec?: number }} [o]
     */
    function analyzeSnapshot(frame, o = {}) {
        const rideRisk = rideRiskOf(o.ridingSec);
        if (!frame || !frame.face || !fin(frame.closure)) {
            return { mode: "photo", score: Math.round(15 * rideRisk), level: /** @type {"low"} */ ("low"), confidence: "poor", faceScore: 0, rideRisk, metrics: { closure: null, jaw: null }, signals: [] };
        }
        const shut = frame.closure >= 0.5, heavy = frame.closure >= 0.35, yawning = fin(frame.jaw) && frame.jaw >= T.yawnJaw;
        const face = clamp((shut ? 0.45 : heavy ? 0.25 : 0) + (yawning ? 0.35 : 0));
        let score = Math.round(100 * clamp(0.85 * face + 0.15 * rideRisk));
        if (!(shut && yawning)) score = Math.min(score, T.high - 1);
        /** @type {Array<{ id: string, value?: number }>} */ const signals = [];
        if (heavy) signals.push({ id: "heavy-eyes", value: Math.round(frame.closure * 100) });
        if (yawning) signals.push({ id: "yawn", value: 1 });
        return { mode: "photo", score, level: levelOf(score), confidence: "low", faceScore: Math.round(face * 100) / 100, rideRisk, metrics: { closure: Math.round(frame.closure * 100) / 100, jaw: fin(frame.jaw) ? Math.round(frame.jaw * 100) / 100 : null }, signals };
    }

    const WORDS = {
        desi: {
            "long-closure": (/** @type {number} */ v) => `aankh ${(v / 1000).toFixed(1).replace(/\.0$/, "")} second tak band rahi`,
            "eyes-closing": () => "aankhen baar-baar band ho rahi hain",
            yawn: () => "ubaasi aa rahi hai",
            nod: () => "sir jhuk raha hai",
            droop: () => "sir neeche latak raha hai",
            "slow-blinks": () => "palkein dheere jhapak rahi hain",
            "frequent-blinks": () => "palkein bahut jhapak rahi hain",
            "heavy-eyes": () => "aankhen bhaari lag rahi hain"
        },
        plain: {
            "long-closure": (/** @type {number} */ v) => `your eyes stayed shut for ${(v / 1000).toFixed(1).replace(/\.0$/, "")} seconds`,
            "eyes-closing": () => "your eyes keep closing",
            yawn: () => "you're yawning",
            nod: () => "your head is nodding",
            droop: () => "your head is drooping",
            "slow-blinks": () => "your blinks are slow",
            "frequent-blinks": () => "you're blinking a lot",
            "heavy-eyes": () => "your eyes look heavy"
        }
    };

    /**
     * The two strongest signs in words, for the spoken line ("aankh 1.2 second tak band rahi aur ubaasi aa rahi hai").
     * @param {Array<{ id: string, value?: number }>} signals @param {"desi"|"plain"} [style]
     */
    function signalWords(signals, style = "desi") {
        const w = WORDS[style === "plain" ? "plain" : "desi"];
        const said = (signals || []).filter((s) => /** @type {any} */ (w)[s.id]).slice(0, 2).map((s) => /** @type {any} */ (w)[s.id](s.value || 0));
        return said.join(style === "plain" ? " and " : " aur ");
    }

    const secs = (/** @type {number} */ ms) => (ms / 1000).toFixed(1).replace(/\.0$/, "");
    const LINES = {
        "long-closure": (/** @type {number} */ v) => `Eyes closed for ${secs(v)} s`,
        "eyes-closing": (/** @type {number} */ v) => `Eyes closed ${v}% of the time`,
        yawn: (/** @type {number} */ v) => (v > 1 ? `Yawning (${v} times)` : "Yawning"),
        nod: () => "Head nodding",
        droop: (/** @type {number} */ v) => `Head drooping (${v}°)`,
        "slow-blinks": (/** @type {number} */ v) => `Slow blinks (${v} ms)`,
        "frequent-blinks": (/** @type {number} */ v) => `Frequent blinks (${v}/min)`,
        "heavy-eyes": () => "Heavy eyelids"
    };

    /**
     * Every sign as a short English line for the screen ("Eyes closed for 1.3 s").
     * @param {Array<{ id: string, value?: number }>} signals
     * @returns {string[]}
     */
    function signalLines(signals) {
        return (signals || []).filter((s) => /** @type {any} */ (LINES)[s.id]).map((s) => /** @type {any} */ (LINES)[s.id](s.value || 0));
    }

    return { frameFromResult, analyzeSession, analyzeSnapshot, signalWords, signalLines, poseFromMatrix, eyeAspect, THRESHOLDS: T, LEFT_EYE, RIGHT_EYE };
});
