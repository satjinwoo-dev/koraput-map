// @ts-check
/* ============================================================================
   MapUnite Master AI — temporal confirmation (no single-frame alerts)
   ==============================================================================
   A detector, however good, is wrong on some frames: a shadow becomes a
   pothole, a patch of tar becomes water. The road model's raw output is never
   spoken. These pure filters turn frames into EVENTS only when the evidence
   holds up over time AND agrees with physics:

   createHazardConfirmer()  a road hazard is confirmed when, for the same track:
     - it has been followed for ≥ 1 s, seen in ≥ 2/3 of the frames meanwhile,
     - its mean confidence is ≥ 0.6,
     - its distance is known to ±30 % or better,
     - the view was usable (quality ≥ 0.4) on those frames,
     - AND it behaves like something lying on the road: the distance shrinks at
       our own speed (least-squares slope within 3 standard errors + the speed
       uncertainty, never tighter than ±25 %). A "pothole" that keeps its
       distance is a smudge on the lens, a reflection, or something moving:
       rejected.

   createClosingWatch()  a road user closing in on us in our lane is reported
     only after 3 frames in a row with time-to-collision ≤ 4 s, closing
     speed ≥ 2 m/s, confidence ≥ 0.7 and a believable distance.

   createRelationWatch()  "wrong_side", "cutting_in" … after 3 frames in a row ≥ 0.75.

   Each event fires once per track (then cools down), so nothing repeats.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); const M = W.MUMaster || (W.MUMaster = {}); (M.perception || (M.perception = {})).confirm = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const median = (/** @type {number[]} */ xs) => { const s = xs.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };

    /**
     * @param {{ spanS?: number, maxSpanS?: number, minSeenRatio?: number, minConf?: number, maxRelSigma?: number, minUsable?: number, forgetMs?: number }} [o]
     */
    function createHazardConfirmer(o = {}) {
        const cfg = { spanS: 1.0, maxSpanS: 2.0, minSeenRatio: 0.66, minConf: 0.6, maxRelSigma: 0.3, minUsable: 0.4, forgetMs: 2000, ...o };
        /** @type {Map<string, { obs: any[], confirmed: boolean, rejected: string|null, lastT: number }>} */
        const tracks = new Map();
        /** @type {number[]} capture times of recent usable frames */ const recent = [];

        /** Least-squares slope of distance over time, and its standard error. @param {any[]} obs */
        function slope(obs) {
            const n = obs.length, ts = obs.map((x) => (x.t - obs[0].t) / 1000), ds = obs.map((x) => x.d);
            const tm = ts.reduce((a, b) => a + b, 0) / n, dm = ds.reduce((a, b) => a + b, 0) / n;
            let sxx = 0, sxy = 0;
            for (let i = 0; i < n; i++) { sxx += (ts[i] - tm) ** 2; sxy += (ts[i] - tm) * (ds[i] - dm); }
            const b = sxy / sxx;
            let ss = 0;
            for (let i = 0; i < n; i++) ss += (ds[i] - (dm + b * (ts[i] - tm))) ** 2;
            return { b, se: n > 2 ? Math.sqrt(ss / (n - 2) / sxx) : Infinity };
        }

        /**
         * @param {any} frame a validated PerceptionFrame
         * @returns {{ confirmed: any[], rejected: Array<{ id: string, cls: string, reason: string }> }}
         */
        function update(frame) {
            const usable = frame.quality.usable >= cfg.minUsable;
            if (usable) recent.push(frame.t);
            while (recent.length && frame.t - recent[0] > cfg.maxSpanS * 1000) recent.shift();
            for (const h of frame.hazards) {
                const id = String(h.id);
                let tr = tracks.get(id);
                if (!tr) { tr = { obs: [], confirmed: false, rejected: null, lastT: frame.t }; tracks.set(id, tr); }
                tr.lastT = frame.t;
                if (!usable) continue;
                tr.obs.push({ t: frame.t, cls: h.cls, conf: h.conf, d: h.distM, ds: h.distSigma, lat: h.lateralM, ls: h.lateralSigma, v: frame.ego.speedMs, vs: frame.ego.speedSigma, ego: frame.ego, size: h.sizeM ?? null });
            }
            const confirmed = [], rejected = [];
            for (const [id, tr] of tracks) {
                if (frame.t - tr.lastT > cfg.forgetMs) { tracks.delete(id); continue; }
                tr.obs = tr.obs.filter((x) => frame.t - x.t <= cfg.maxSpanS * 1000);
                if (tr.confirmed || tr.rejected || tr.obs.length < 3) continue;
                const obs = tr.obs;
                const span = (obs[obs.length - 1].t - obs[0].t) / 1000;
                if (span < cfg.spanS) continue;                                   // not enough evidence yet
                const framesInSpan = recent.filter((t) => t >= obs[0].t).length;
                if (obs.length / Math.max(1, framesInSpan) < cfg.minSeenRatio) continue;   // flickering
                const meanConf = obs.reduce((a, x) => a + x.conf, 0) / obs.length;
                if (meanConf < cfg.minConf) continue;
                if (median(obs.map((x) => x.ds / Math.max(1, x.d))) > cfg.maxRelSigma) continue;
                // physics: a static hazard gets closer exactly as fast as we ride
                const v = obs.reduce((a, x) => a + x.v, 0) / obs.length;
                const vs = Math.max(...obs.map((x) => x.vs));
                const b = obs[obs.length - 1];
                if (v > 2) {
                    const fit = slope(obs);
                    const tol = Math.max(3 * fit.se + vs, 0.25 * v);
                    if (Math.abs(fit.b + v) > tol) {
                        tr.rejected = "not-static";
                        rejected.push({ id, cls: b.cls, reason: `closing at ${(-fit.b).toFixed(1)} m/s, expected ${v.toFixed(1)} m/s for something on the road` });
                        continue;
                    }
                }
                tr.confirmed = true;
                const cls = mode(obs.map((x) => x.cls));                    // the class most frames agreed on
                confirmed.push({ id, cls, conf: Math.round(meanConf * 100) / 100, distM: b.d, distSigma: b.ds, lateralM: b.lat, lateralSigma: b.ls, sizeM: b.size, t: b.t, ego: b.ego, seen: obs.length });
            }
            return { confirmed, rejected };
        }
        /** Latest distance of a track, projected to time t at our speed (for lead-time checks). @param {string} id @param {number} t */
        function project(id, t) {
            const tr = tracks.get(String(id));
            if (!tr || !tr.obs.length) return null;
            const b = tr.obs[tr.obs.length - 1];
            return { distM: b.d - b.v * Math.max(0, (t - b.t) / 1000), lateralM: b.lat, speedMs: b.v, seenAt: b.t };
        }
        return { update, project, get size() { return tracks.size; } };
    }

    /** @param {string[]} xs */
    function mode(xs) { const c = new Map(); for (const x of xs) c.set(x, (c.get(x) || 0) + 1); return [...c.entries()].sort((p, q) => q[1] - p[1])[0][0]; }

    /**
     * @param {{ runFrames?: number, maxTtcS?: number, minClosingMs?: number, minConf?: number, maxRelSigma?: number, cooldownMs?: number }} [o]
     */
    function createClosingWatch(o = {}) {
        const cfg = { runFrames: 3, maxTtcS: 4, minClosingMs: 2, minConf: 0.7, maxRelSigma: 0.3, cooldownMs: 15000, ...o };
        /** @type {Map<string, { run: number, firedAt: number }>} */ const s = new Map();
        /** @param {any} frame */
        function update(frame) {
            const out = [];
            const seen = new Set();
            for (const ob of frame.objects) {
                const id = String(ob.id);
                seen.add(id);
                const st = s.get(id) || { run: 0, firedAt: -Infinity };
                const ok = frame.quality.usable >= 0.4 && ob.lane === "ego" && ob.conf >= cfg.minConf && ob.ttcS !== null && ob.ttcS !== undefined && ob.ttcS <= cfg.maxTtcS
                    && ob.closingMs >= cfg.minClosingMs && ob.closingSigma <= 0.5 * ob.closingMs && ob.distSigma / Math.max(1, ob.distM) <= cfg.maxRelSigma;
                st.run = ok ? st.run + 1 : 0;
                if (st.run >= cfg.runFrames && frame.t - st.firedAt >= cfg.cooldownMs) { st.firedAt = frame.t; out.push({ id, cls: ob.cls, ttcS: ob.ttcS, distM: ob.distM, closingMs: ob.closingMs, conf: ob.conf, t: frame.t }); }
                s.set(id, st);
            }
            for (const [id, st] of s) if (!seen.has(id)) { st.run = 0; if (frame.t - st.firedAt > 60000) s.delete(id); }
            return out;
        }
        return { update };
    }

    /**
     * @param {{ rels?: string[], runFrames?: number, minConf?: number, cooldownMs?: number }} [o]
     */
    function createRelationWatch(o = {}) {
        const cfg = { rels: ["wrong_side", "cutting_in"], runFrames: 3, minConf: 0.75, cooldownMs: 30000, ...o };
        /** @type {Map<string, { run: number, firedAt: number }>} */ const s = new Map();
        /** @param {any} frame */
        function update(frame) {
            const out = [];
            const now = new Set();
            for (const r of frame.relations) {
                if (!cfg.rels.includes(r.rel) || r.conf < cfg.minConf || frame.quality.usable < 0.4) continue;
                const key = `${r.subj}:${r.rel}`;
                now.add(key);
                const st = s.get(key) || { run: 0, firedAt: -Infinity };
                st.run++;
                if (st.run >= cfg.runFrames && frame.t - st.firedAt >= cfg.cooldownMs) {
                    st.firedAt = frame.t;
                    const subj = frame.objects.find((x) => String(x.id) === String(r.subj));
                    out.push({ subj: String(r.subj), rel: r.rel, cls: subj ? subj.cls : null, distM: subj ? subj.distM : null, conf: r.conf, t: frame.t });
                }
                s.set(key, st);
            }
            for (const [k, st] of s) if (!now.has(k)) st.run = 0;
            return out;
        }
        return { update };
    }

    return { createHazardConfirmer, createClosingWatch, createRelationWatch };
});
