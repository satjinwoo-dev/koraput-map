// @ts-check
/* ============================================================================
   MapUnite Master AI — Dynamics agent ("dynamics"): how the bike is ridden,
   and what the road does to it
   ==============================================================================
   Consumes DynamicsFrames (1 per second) from the "dynamics" capability (the
   native DynamicsCore: IMU 100 Hz + GNSS; no camera needed) while riding, and
   reports to the Master. Every word goes through the brain → persona → the
   ask-first gate → the one voice, like every other agent:

     ride.braking-pattern  advice   3+ hard brakes within 10 min: one tip, said
                                    only once the bike has stood still for 15 s
     ride.hard-brake-check advice   one very hard brake (≤ −6 m/s²): a check-in,
                                    also only when stopped
     road.rough-stretch    advice   60 m+ of rough road while riding (once per 10 min)
     road.bump-ahead       warning  a strong jolt this phone has felt at the same
                                    spot on 2 separate passes is ahead, 2–8 s away

   Why braking is never said while riding: the rider is busy braking, and a
   voice then is a distraction. It's useful afterwards, when stopped.
   Why a bump needs 2 passes: one jolt can be a stone or a pothole already
   fixed; the same strong jolt at the same place twice is a real feature.

   Jolts are kept on the phone in ~20 m cells (store "dynamics.cells"), merged
   with neighbouring cells within 12 m (GNSS error), so later rides warn ahead.
   ============================================================================ */
(function (root, factory) {
    const def = factory();
    if (typeof module === "object" && module.exports) module.exports = def;
    else {
        const M = /** @type {any} */ (root).MUMaster || (/** @type {any} */ (root).MUMaster = {});
        if (typeof M.define === "function") M.define(def); else (M._pending || (M._pending = [])).push(def);
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const M_PER_DEG = 111320;

    return {
        id: "dynamics",
        version: "1.0.0",
        apiVersion: 1,
        description: "Hard braking, road shocks and roughness from the phone's motion sensors and GPS, only while riding.",
        requires: ["dynamics"],
        depends: ["ride"],
        runWhen: { topic: "state.ride", test: (/** @type {any} */ r) => Boolean(r && r.active) },
        defaults: {
            veryHardMs2: 6,              // |peak| ≥ this: a check-in after stopping
            patternCount: 3,             // hard brakes …
            patternWindowMs: 600000,     // … within 10 min
            stillSpeedMs: 0.8,
            stillForMs: 15000,           // stopped this long → pending braking tips are said
            roughRunSegments: 3,         // 3 × 20 m rough/very rough in a row
            roughCooldownMs: 600000,
            roughMinSpeedMs: 5,
            strongJoltMs2: 12,           // only strong jolts make a bump worth a warning
            passGapMs: 60000,            // jolts this far apart in time are separate passes
            confirmPasses: 2,
            mergeRadiusM: 12,
            leadMinS: 2, leadMaxS: 8,
            halfWidthM: 12,              // |lateral| within this = on our line
            bumpCooldownMs: 60000,       // per spot: no repeat within one approach; every new approach is warned
            cellDeg: 0.0002,             // ≈ 20 m
            maxCells: 3000
        },

        /** @param {any} ctx */
        start(ctx) {
            const cfg = ctx.config;
            const P = ctx.caps.get("dynamics");
            /** @type {Record<string, { lat: number, lng: number, jolts: number, passes: number[], peak: number, last: number, rough: number }>} */
            const cells = ctx.store.get("cells", {}) || {};
            const stats = { hardBrakes: 0, veryHardBrakes: 0, hardAccels: 0, jolts: 0, distM: 0, roughM: 0, bumpsWarned: 0, tips: 0, frames: 0 };
            /** @type {number[]} */ let brakeTimes = [];
            /** @type {any} */ let veryHard = null;
            let stillSince = /** @type {number|null} */ (null);
            let roughRun = 0, lastRoughAt = -Infinity;
            /** @type {Map<string, number>} */ const bumpSaidAt = new Map();

            const fmt = (/** @type {number} */ v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);
            const keyOf = (/** @type {number} */ lat, /** @type {number} */ lng) => `${Math.round(lat / cfg.cellDeg)}:${Math.round(lng / cfg.cellDeg)}`;
            /** metres from (lat, lng) to a cell, as north / east */
            const offset = (/** @type {number} */ lat, /** @type {number} */ lng, /** @type {any} */ c) => ({
                north: (c.lat - lat) * M_PER_DEG,
                east: (c.lng - lng) * M_PER_DEG * Math.cos(lat * Math.PI / 180)
            });

            /** the existing cell within mergeRadiusM of a point, else a new key */
            function cellFor(/** @type {number} */ lat, /** @type {number} */ lng) {
                const [ky, kx] = keyOf(lat, lng).split(":").map(Number);
                let best = null, bestD = Infinity;
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                    const k = `${ky + dy}:${kx + dx}`;
                    const c = cells[k];
                    if (!c) continue;
                    const o = offset(lat, lng, c);
                    const d = Math.hypot(o.north, o.east);
                    if (d < bestD) { bestD = d; best = k; }
                }
                return best && bestD <= cfg.mergeRadiusM ? best : keyOf(lat, lng);
            }

            function save() {
                const keys = Object.keys(cells);
                if (keys.length > cfg.maxCells) keys.sort((a, b) => cells[a].last - cells[b].last).slice(0, keys.length - cfg.maxCells).forEach((k) => delete cells[k]);
                ctx.store.set("cells", cells);
            }

            function addJolt(/** @type {any} */ e) {
                if (e.lat === null || e.lng === null || e.lat === undefined || e.lng === undefined) return;
                const k = cellFor(e.lat, e.lng);
                const c = cells[k] || { lat: e.lat, lng: e.lng, jolts: 0, passes: [], peak: 0, last: 0, rough: 0 };
                const lastPass = c.passes.length ? c.passes[c.passes.length - 1] : -Infinity;
                if (e.t - lastPass >= cfg.passGapMs) c.passes = [...c.passes.slice(-9), e.t];
                c.jolts++;
                c.peak = Math.max(c.peak, Math.abs(e.peakMs2));
                c.lat += (e.lat - c.lat) / c.jolts; c.lng += (e.lng - c.lng) / c.jolts;   // running mean of the hit positions
                c.last = e.t;
                cells[k] = c;
            }

            function markRough(/** @type {any} */ s) {
                if (s.lat === null || s.lng === null || s.lat === undefined) return;
                const k = cellFor(s.lat, s.lng);
                const c = cells[k] || { lat: s.lat, lng: s.lng, jolts: 0, passes: [], peak: 0, last: 0, rough: 0 };
                c.rough = Math.max(c.rough || 0, s.refRmsMs2);
                c.last = s.t;
                cells[k] = c;
            }

            const confirmed = (/** @type {any} */ c) => c.passes.length >= cfg.confirmPasses && c.peak >= cfg.strongJoltMs2;

            function lookAhead(/** @type {any} */ f) {
                const e = f.ego;
                if (!Number.isFinite(e.lat) || !Number.isFinite(e.lng) || !Number.isFinite(e.headingDeg) || e.speedMs < 3) return;
                const th = e.headingDeg * Math.PI / 180;
                for (const [k, c] of Object.entries(cells)) {
                    if (!confirmed(c)) continue;
                    const o = offset(e.lat, e.lng, c);
                    if (Math.abs(o.north) > 200 || Math.abs(o.east) > 200) continue;
                    const along = o.north * Math.cos(th) + o.east * Math.sin(th);
                    const lateral = -o.north * Math.sin(th) + o.east * Math.cos(th);
                    const lead = along / e.speedMs;
                    if (lead < cfg.leadMinS || lead > cfg.leadMaxS || Math.abs(lateral) > cfg.halfWidthM) continue;
                    if (f.t - (bumpSaidAt.get(k) ?? -Infinity) < cfg.bumpCooldownMs) continue;
                    bumpSaidAt.set(k, f.t);
                    stats.bumpsWarned++;
                    ctx.report("road.bump-ahead", {
                        severity: "warning", key: `road.bump.${k}`, category: "road", ridingOnly: true, ttlMs: 4000, confidence: 0.8,
                        data: { distanceM: Math.max(10, Math.round(along / 10) * 10), passes: c.passes.length, peakMs2: Math.round(c.peak) }
                    });
                }
            }

            function deliverWhenStopped(/** @type {number} */ t) {
                if (veryHard) {
                    stats.tips++;
                    ctx.report("ride.hard-brake-check", {
                        severity: "advice", key: "ride.hard-brake-check", category: "riding", ttlMs: 120000, confidence: veryHard.conf,
                        data: { peakMs2: fmt(Math.abs(veryHard.peakMs2)), screen: { peak: `${fmt(Math.abs(veryHard.peakMs2))} m/s²` } }
                    });
                    veryHard = null;
                    return;                                   // one thing at a time; the pattern can wait for the next stop
                }
                const recent = brakeTimes.filter((x) => t - x <= cfg.patternWindowMs);
                if (recent.length >= cfg.patternCount) {
                    const minutes = Math.max(1, Math.round((t - recent[0]) / 60000));
                    stats.tips++;
                    ctx.report("ride.braking-pattern", {
                        severity: "advice", key: "ride.braking-pattern", category: "riding", ttlMs: 120000, confidence: 0.85,
                        data: { count: recent.length, minutes }
                    });
                    brakeTimes = [];                          // said: start counting afresh
                }
            }

            function onFrame(/** @type {any} */ f) {
                stats.frames++;
                const speed = f.ego.speedMs;
                for (const e of f.events) {
                    if (e.type === "hard_brake") {
                        stats.hardBrakes++;
                        brakeTimes.push(e.t);
                        if (Math.abs(e.peakMs2) >= cfg.veryHardMs2) { stats.veryHardBrakes++; veryHard = e; }
                    } else if (e.type === "hard_accel") stats.hardAccels++;
                    else if (e.type === "jolt") { stats.jolts++; addJolt(e); }
                }
                for (const s of f.segments) {
                    stats.distM += s.distM;
                    const rough = s.cls === "rough" || s.cls === "very_rough";
                    if (rough) { stats.roughM += s.distM; markRough(s); }
                    roughRun = rough ? roughRun + 1 : 0;
                    if (roughRun >= cfg.roughRunSegments && speed >= cfg.roughMinSpeedMs && f.t - lastRoughAt >= cfg.roughCooldownMs) {
                        lastRoughAt = f.t;
                        ctx.report("road.rough-stretch", { severity: "advice", key: "road.rough-stretch", category: "road", ridingOnly: true, ttlMs: 15000, confidence: 0.75, data: { lengthM: Math.round(roughRun * s.distM) } });
                    }
                }
                if (f.events.length || f.segments.length) save();

                // stopped long enough? (speed known to ±3 m/s)
                const still = speed < cfg.stillSpeedMs && f.ego.speedSigma <= 3;
                if (!still) stillSince = null;
                else {
                    if (stillSince === null) stillSince = f.t;
                    if (f.t - stillSince >= cfg.stillForMs) deliverWhenStopped(f.t);
                }
                if (!still) lookAhead(f);

                ctx.setState("dynamics", { ...stats, distM: Math.round(stats.distM), roughM: Math.round(stats.roughM), cells: Object.keys(cells).length, confirmedBumps: Object.values(cells).filter(confirmed).length, braking: f.braking, imuHz: f.imuHz });
                ctx.heartbeat();
            }

            const off = P.onFrame(ctx.wrap(onFrame));
            ctx.onStop(() => { off(); save(); P.stop().catch(() => {}); });
            return P.start();
        }
    };
});
