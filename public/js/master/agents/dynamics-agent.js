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
     road.bump-reported    warning  the same, verified by other riders' reports
                                    (RoadSense sync) where this phone felt nothing yet

   Why braking is never said while riding: the rider is busy braking, and a
   voice then is a distraction. It's useful afterwards, when stopped.
   Why a bump needs 2 passes: one jolt can be a stone or a pothole already
   fixed; the same strong jolt at the same place twice is a real feature.

   Every strong jolt and rough 20 m stretch goes into the RoadSense log
   (js/master/roadsense/roadsense.js, capability "roadsense"): one record of the
   road on the phone, with source, time, confidence and expiry. The log's rules
   decide when a bump is verified (2 independent pieces: a second pass, another
   rider, or the camera) and when it's gone. This agent also tells the log
   when the bike rode over a known bump WITHOUT a jolt, which is how a repaired
   pothole stops being warned about. (Before RoadSense, jolts lived in the
   agent's own store "dynamics.cells"; that key is removed on start.)
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

    function truthLib() {
        const g = /** @type {any} */ (globalThis);
        if (g.MUMaster && g.MUMaster.roadTruth) return g.MUMaster.roadTruth;
        // @ts-ignore: node (tests) only
        if (typeof module === "object" && typeof require === "function") return require("../roadsense/truth.js");
        return null;
    }

    function roadsenseLib() {
        const g = /** @type {any} */ (globalThis);
        if (g.MUMaster && g.MUMaster.roadsense) return g.MUMaster.roadsense;
        // @ts-ignore: node (tests) only
        if (typeof module === "object" && typeof require === "function") return require("../roadsense/roadsense.js");
        return null;
    }

    return {
        id: "dynamics",
        version: "1.1.0",
        apiVersion: 1,
        description: "Hard braking, road shocks and roughness from the phone's motion sensors and GPS, only while riding.",
        requires: ["dynamics"],
        optional: ["roadsense"],
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
            leadMinS: 2, leadMaxS: 8,
            halfWidthM: 12,              // |lateral| within this = on our line
            bumpCooldownMs: 60000,       // per spot: no repeat within one approach; every new approach is warned
            // "rode over it, no jolt": counted only when the phone could have felt it
            cleanMinSpeedMs: 3,          // DynamicsCore reports jolts only from 3 m/s
            cleanWidthM: 5,              // the bike's track passed this close to the spot (GNSS ≈ 5 m)
            cleanMaxPosSigmaM: 10,       // and the fix was this good
            cleanMinImuHz: 50,           // and the IMU was running properly
            cleanSettleMs: 3000,         // wait this long for a late jolt before calling the pass clean
            roughSegmentConf: 0.6,       // one rough 20 m segment as evidence (prior: calibrate in the pilot)
            saveEveryMs: 60000,          // the log is up to ≈ 0.5 MB: written once a minute and on stop, not every second
            pruneEveryMs: 300000
        },

        /** @param {any} ctx */
        start(ctx) {
            const cfg = ctx.config;
            const P = ctx.caps.get("dynamics");
            const RS = roadsenseLib();
            const TR = truthLib();
            const shared = ctx.caps.has("roadsense") ? ctx.caps.get("roadsense") : null;
            const log = shared || RS.createLog({ store: ctx.store });
            if (!shared) log.load();
            ctx.store.remove("cells");                // the pre-RoadSense jolt cells: replaced by the log
            const stats = { hardBrakes: 0, veryHardBrakes: 0, hardAccels: 0, jolts: 0, distM: 0, roughM: 0, bumpsWarned: 0, tips: 0, frames: 0, cleanPasses: 0 };
            /** @type {number[]} */ let brakeTimes = [];
            /** @type {any} */ let veryHard = null;
            let stillSince = /** @type {number|null} */ (null);
            let roughRun = 0, lastRoughAt = -Infinity, lastSaveAt = -Infinity, lastPruneAt = -Infinity;
            let logStats = log.stats(ctx.now());                 // refreshed on each save (it assesses every event)
            /** @type {Map<string, number>} */ const bumpSaidAt = new Map();
            /** bumps the bike just rode over: id → when; a jolt there around then cancels it, else it becomes a clean pass */
            /** @type {Map<string, { t: number, lat: number, lng: number, type: string }>} */ const overBump = new Map();
            /** @type {Map<string, number>} */ const feltAt = new Map();      // bump id → last jolt felt there
            /** @type {any} */ let prevEgo = null;

            const fmt = (/** @type {number} */ v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);
            /** metres from (lat, lng) to a point, as north / east */
            const offset = (/** @type {number} */ lat, /** @type {number} */ lng, /** @type {any} */ c) => ({
                north: (c.lat - lat) * M_PER_DEG,
                east: (c.lng - lng) * M_PER_DEG * Math.cos(lat * Math.PI / 180)
            });
            const hasPos = (/** @type {any} */ x) => x && Number.isFinite(x.lat) && Number.isFinite(x.lng);

            function save(/** @type {number} */ t, force = false) {
                if (!force && t - lastSaveAt < cfg.saveEveryMs) return;
                lastSaveAt = t;
                if (force || t - lastPruneAt >= cfg.pruneEveryMs) { lastPruneAt = t; log.prune(t); }
                log.save();
                logStats = log.stats(t);
            }

            function addJolt(/** @type {any} */ e) {
                if (!hasPos(e)) return;
                const r = log.add({ type: "bump", t: e.t, lat: e.lat, lng: e.lng, source: "imu", rider: "self", present: true, conf: e.conf, peakMs2: e.peakMs2 });
                if (r.id) feltAt.set(r.id, e.t);      // it was felt: this pass isn't a clean one
            }

            function markRough(/** @type {any} */ s) {
                if (!hasPos(s)) return;
                log.add({ type: "rough", t: s.t, lat: s.lat, lng: s.lng, source: "imu", rider: "self", present: true, conf: cfg.roughSegmentConf });
            }

            /** Known bumps this frame's track (previous fix → this fix) passed within cleanWidthM of, at a speed the IMU feels. */
            function noteRideOver(/** @type {any} */ f) {
                const e = f.ego, p = prevEgo;
                prevEgo = hasPos(e) ? { lat: e.lat, lng: e.lng } : null;
                if (!p || !hasPos(e) || e.speedMs < cfg.cleanMinSpeedMs || !(f.imuHz >= cfg.cleanMinImuHz)) return;
                if (Number.isFinite(e.posSigmaM) && e.posSigmaM > cfg.cleanMaxPosSigmaM) return;
                const b = offset(p.lat, p.lng, e);                        // the track, in metres from p
                const len = Math.hypot(b.north, b.east);
                const mid = { lat: (p.lat + e.lat) / 2, lng: (p.lng + e.lng) / 2 };
                for (const ev of log.query({ lat: mid.lat, lng: mid.lng, radiusM: len / 2 + cfg.cleanWidthM, now: f.t, group: "shock" })) {
                    const v = offset(p.lat, p.lng, ev);
                    const u = len > 0 ? Math.max(0, Math.min(1, (v.north * b.north + v.east * b.east) / (len * len))) : 0;
                    if (Math.hypot(v.north - u * b.north, v.east - u * b.east) <= cfg.cleanWidthM && !overBump.has(ev.id)) overBump.set(ev.id, { t: f.t, lat: ev.lat, lng: ev.lng, type: ev.type });
                }
            }

            /** Rode over it and nothing was felt within cleanSettleMs: evidence that it isn't there any more. */
            function settleRideOvers(/** @type {number} */ t) {
                for (const [id, o] of overBump) {
                    if (t - o.t < cfg.cleanSettleMs) continue;
                    overBump.delete(id);
                    if (Math.abs((feltAt.get(id) ?? -Infinity) - o.t) <= cfg.cleanSettleMs) continue;
                    const r = log.add({ type: o.type, t: o.t, lat: o.lat, lng: o.lng, source: "imu", rider: "self", present: false });
                    if (r.id) stats.cleanPasses++;
                }
            }

            const strong = (/** @type {any} */ ev) => ev.status === "verified" && (ev.peakMs2 === null || ev.peakMs2 >= cfg.strongJoltMs2);

            function lookAhead(/** @type {any} */ f) {
                const e = f.ego;
                if (!Number.isFinite(e.lat) || !Number.isFinite(e.lng) || !Number.isFinite(e.headingDeg) || e.speedMs < 3) return;
                const th = e.headingDeg * Math.PI / 180;
                for (const c of log.query({ lat: e.lat, lng: e.lng, radiusM: 200, now: f.t, group: "shock" })) {
                    if (!strong(c)) continue;
                    const o = offset(e.lat, e.lng, c);
                    const along = o.north * Math.cos(th) + o.east * Math.sin(th);
                    const lateral = -o.north * Math.sin(th) + o.east * Math.cos(th);
                    const lead = along / e.speedMs;
                    if (lead < cfg.leadMinS || lead > cfg.leadMaxS || Math.abs(lateral) > cfg.halfWidthM) continue;
                    if (f.t - (bumpSaidAt.get(c.id) ?? -Infinity) < cfg.bumpCooldownMs) continue;
                    bumpSaidAt.set(c.id, f.t);
                    stats.bumpsWarned++;
                    // felt here before → "where you hit one before"; only other riders' reports → say so. The evidence
                    // (who, when) is said in a short clause; the screen adds the sensors and the confidence.
                    const row = { ...c, ageS: Math.max(0, Math.round((f.t - c.lastSeen) / 1000)) };
                    const w = TR.evidence(row);
                    ctx.report(c.felt ? "road.bump-ahead" : "road.bump-reported", {
                        severity: "warning", key: `road.bump.${c.id}`, category: "road", ridingOnly: true, ttlMs: 4000, confidence: c.confidence,
                        data: {
                            distanceM: Math.max(10, Math.round(along / 10) * 10), passes: c.passes, riders: c.riders, peakMs2: c.peakMs2 === null ? null : Math.round(c.peakMs2),
                            kind: c.type, sources: c.sources, lastSeenAgoS: row.ageS, confidence: c.confidence, roadsenseId: c.id,
                            evidence: w.shortDesi, detail: TR.screenEvidence(row),
                            screen: { evidence: w.shortPlain }
                        }
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
                noteRideOver(f);
                settleRideOvers(f.t);
                if (f.events.length || f.segments.length) save(f.t);

                // stopped long enough? (speed known to ±3 m/s)
                const still = speed < cfg.stillSpeedMs && f.ego.speedSigma <= 3;
                if (!still) stillSince = null;
                else {
                    if (stillSince === null) stillSince = f.t;
                    if (f.t - stillSince >= cfg.stillForMs) deliverWhenStopped(f.t);
                }
                if (!still) lookAhead(f);

                ctx.setState("dynamics", { ...stats, distM: Math.round(stats.distM), roughM: Math.round(stats.roughM), roadEvents: logStats.events, verifiedEvents: logStats.verified, braking: f.braking, imuHz: f.imuHz });
                ctx.heartbeat();
            }

            const off = P.onFrame(ctx.wrap(onFrame));
            // unsettled ride-overs are dropped on stop: a late jolt may never arrive
            ctx.onStop(() => { off(); overBump.clear(); save(ctx.now(), true); P.stop().catch(() => {}); });
            return P.start();
        }
    };
});
