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
                                    spot on 2 separate passes is ahead
     road.bump-reported    warning  a hazard other riders published (RoadPulse,
                                    with how many confirmed it), or verified by
                                    their synced evidence, where this phone felt nothing
     road.hazards-ahead    warning  several of them within 300 m: one line
     road.hazards-stretch  warning  hazards ahead but the fix is poor: no distance
   WHEN (roadsense/alerts.js): earlier the faster the rider goes (≈ 50 m at
   20 km/h, 135 m at 60), on the rider's line and direction only, never beyond
   the next turn of the route, once per hazard, 15 s apart at least, and never
   "brake": "slow down gradually and watch the road".

   Why braking is never said while riding: the rider is busy braking, and a
   voice then is a distraction. It's useful afterwards, when stopped.
   Why a bump needs 2 passes: one jolt can be a stone or a pothole already
   fixed; the same strong jolt at the same place twice is a real feature.

   Smooth passes ("ridden, nothing found"): every ≈ 220 m cell ridden at ≥ 3 m/s
   with the IMU working and a good fix, where nothing was felt, goes into the
   RoadSense coverage (capability "roadsense-cover"), so the Truth Card can say
   "clear, no bumps felt by N riders" instead of "unknown".
   Every strong jolt and rough 20 m stretch goes into the RoadSense log
   (js/master/roadsense/roadsense.js, capability "roadsense"): one record of the
   road on the phone, with source, time, confidence and expiry. The log's rules
   decide when a bump is verified (2 independent pieces: a second pass, another
   rider, or the camera) and when it's gone. This agent also tells the log
   when the bike rode over a known bump WITHOUT a jolt, which is how a repaired
   pothole stops being warned about. (Before RoadSense, jolts lived in the
   agent's own store "dynamics.cells"; that key is removed on start.)

   Detector v2 jolts (DynamicsCore: speed-scaled, contrast, rear-wheel double hit,
   placed at the hit's onset) carry hazard (pothole / speed_breaker / bump),
   cls (impact / unknown / minor) and severity. Minor ones (small unevenness) and
   unknown ones (strong but one wheel only: the sensor can't tell what it was)
   never reach the log, a warning or the public: they are kept only for the
   rider's post-ride review, where only the rider can confirm them.
   Every ride's own detections, and the hazards it was warned about, are kept in
   the store "review.ride" for that review (js/master/roadsense/review.js): the
   phone's own detections are private until the rider publishes them.
   PASSAGE: for each hazard it warned about, the agent follows the pass on the
   phone (closest approach, direction, speed, fix, whether a jolt was felt there)
   and keeps only { passed, quality, felt }: what makes the rider's later "found"
   or "not found" count (sync.js publish); no coordinates or times leave with it.
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

    function alertsLib() {
        const g = /** @type {any} */ (globalThis);
        if (g.MUMaster && g.MUMaster.roadAlerts) return g.MUMaster.roadAlerts;
        // @ts-ignore: node (tests) only
        if (typeof module === "object" && typeof require === "function") return require("../roadsense/alerts.js");
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
        version: "1.2.0",
        apiVersion: 1,
        description: "Hard braking, road shocks and roughness from the phone's motion sensors and GPS, only while riding.",
        requires: ["dynamics"],
        optional: ["roadsense", "roadsense-cover", "roadsense-community", "nav-turn"],
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
            strongJoltMs2: 9,            // only strong jolts make a bump worth a warning (speed-scaled peakRef, detector v2)
            reviewMaxItems: 200,         // a ride's detections kept for the post-ride review
            passMinM: 12,                // passed = the closest approach within max(this, 2σ of the hazard) …
            passHeadingDeg: 45,          // … in its direction …
            passSettleM: 40,             // … settled once the bike is this much farther away again (or 2 min later)
            dupM: 15,                    // a published hazard this close to one of the phone's own is the same one
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
            const AL = alertsLib();
            const planner = AL.createPlanner();
            const community = ctx.caps.has("roadsense-community") ? ctx.caps.get("roadsense-community") : null;
            const navTurn = ctx.caps.has("nav-turn") ? ctx.caps.get("nav-turn") : null;
            const shared = ctx.caps.has("roadsense") ? ctx.caps.get("roadsense") : null;
            const log = shared || RS.createLog({ store: ctx.store });
            if (!shared) log.load();
            ctx.store.remove("cells");                // the pre-RoadSense jolt cells: replaced by the log
            // smooth passes ("ridden, nothing found"): the shared coverage, else this agent's own
            const sharedCover = ctx.caps.has("roadsense-cover") ? ctx.caps.get("roadsense-cover") : null;
            const cover = sharedCover || RS.createCoverage({ store: ctx.store });
            if (!sharedCover) cover.load();
            /** the coverage cells of this ride not yet settled: cell → { last, smooth } */
            /** @type {Map<string, { last: number, smooth: boolean }>} */ const inCell = new Map();
            const stats = { hardBrakes: 0, veryHardBrakes: 0, hardAccels: 0, jolts: 0, distM: 0, roughM: 0, bumpsWarned: 0, tips: 0, frames: 0, cleanPasses: 0, smoothCells: 0 };
            /** @type {number[]} */ let brakeTimes = [];
            /** @type {any} */ let veryHard = null;
            let stillSince = /** @type {number|null} */ (null);
            let roughRun = 0, lastRoughAt = -Infinity, lastSaveAt = -Infinity, lastPruneAt = -Infinity;
            let logStats = log.stats(ctx.now());                 // refreshed on each save (it assesses every event)
            /** bumps the bike just rode over: id → when; a jolt there around then cancels it, else it becomes a clean pass */
            /** @type {Map<string, { t: number, lat: number, lng: number, type: string }>} */ const overBump = new Map();
            /** @type {Map<string, number>} */ const feltAt = new Map();      // bump id → last jolt felt there
            /** @type {any} */ let prevEgo = null;
            // the post-ride review: this ride's own detections and the hazards it was warned about (private, on the phone)
            /** @type {{ startedAt: number, endedAt: number|null, items: any[], warned: any[] }} */
            const ride = { startedAt: ctx.now(), endedAt: null, items: [], warned: [] };
            /** @type {any} */ let roughOpen = null;
            /** recent jolts (any class), for "was it felt on this pass?" */
            /** @type {{ t: number, lat: number, lng: number }[]} */ let recentJolts = [];
            const distTo = (/** @type {any} */ a, /** @type {any} */ b) => Math.hypot((b.lat - a.lat) * M_PER_DEG, (b.lng - a.lng) * M_PER_DEG * Math.cos(a.lat * Math.PI / 180));
            const angle = (/** @type {number} */ a, /** @type {number} */ b) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };
            /** Follows each warned hazard's pass; settles it into { passed, quality, felt }. @param {any} f @param {boolean} [final] */
            function trackPassages(f, final = false) {
                const e = f.ego;
                for (const w of ride.warned) {
                    if (w.passage) continue;
                    const tr = w.track || (w.track = { dmin: Infinity, at: 0, headingOk: false, speed: 0, sigma: Infinity, imuHz: 0 });
                    if (!final && hasPos(e)) {
                        const d = distTo(e, w);
                        if (d < tr.dmin) {
                            tr.dmin = d; tr.at = f.t; tr.speed = e.speedMs; tr.imuHz = f.imuHz || 0;
                            tr.sigma = Number.isFinite(e.posSigmaM) ? e.posSigmaM : 15;
                            tr.headingOk = w.bothWays || !Number.isFinite(w.heading) || (Number.isFinite(e.headingDeg) && angle(e.headingDeg, w.heading) <= cfg.passHeadingDeg);
                        }
                        if (!(d > tr.dmin + cfg.passSettleM) && f.t - w.t < 120000) continue;
                    }
                    const reach = Math.max(cfg.passMinM, 2 * (Number.isFinite(w.sigmaM) ? w.sigmaM : 5));
                    const passed = tr.dmin <= reach && tr.headingOk && tr.speed >= cfg.cleanMinSpeedMs;
                    const quality = tr.sigma <= 10 && tr.imuHz >= cfg.cleanMinImuHz ? "good" : tr.sigma <= 20 ? "fair" : "poor";
                    const felt = passed ? recentJolts.some((j) => Math.abs(j.t - tr.at) <= 3000 && distTo(j, w) <= 15) : null;
                    w.passage = { passed, quality, felt };
                    delete w.track;
                }
                recentJolts = recentJolts.filter((j) => f.t - j.t <= 10000);
            }
            const keepReview = () => ctx.store.set("review.ride", ride);

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
                if (force || t - lastPruneAt >= cfg.pruneEveryMs) { lastPruneAt = t; log.prune(t); cover.prune(t); }
                log.save();
                cover.save();
                logStats = log.stats(t);
            }

            const reviewItem = (/** @type {any} */ x) => { if (ride.items.length < cfg.reviewMaxItems) ride.items.push(x); };

            function addJolt(/** @type {any} */ e) {
                if (!hasPos(e)) return;
                recentJolts.push({ t: e.t, lat: e.lat, lng: e.lng });
                const v2 = typeof e.hazard === "string";
                const sev = v2 ? e.severity : 2;
                const posSigmaM = Number.isFinite(e.posSigmaM) ? e.posSigmaM : null;
                const heading = Number.isFinite(e.headingDeg) ? e.headingDeg : null;
                if (v2 && e.minor) {               // small unevenness or unknown: the rider's review only; never warned, never public on its own
                    const unknown = e.cls === "unknown";
                    reviewItem({ id: `${unknown ? "u" : "m"}${e.id}.${e.t}`, kind: "impact", hazard: e.hazard, severity: 1, minor: !unknown, unknown, t: e.t, lat: e.lat, lng: e.lng, posSigmaM, heading });
                    return;
                }
                const type = v2 && (e.hazard === "pothole" || e.hazard === "speed_breaker") ? e.hazard : "bump";
                const peak = v2 && Number.isFinite(e.peakRefMs2) ? e.peakRefMs2 : e.peakMs2;
                const r = log.add({ type, t: e.t, lat: e.lat, lng: e.lng, source: "imu", rider: "self", present: true, conf: e.conf, peakMs2: peak });
                if (r.id) feltAt.set(r.id, e.t);      // it was felt: this pass isn't a clean one
                reviewItem({ id: `j${e.id}.${e.t}`, kind: "impact", hazard: type, severity: sev, minor: false, t: e.t, lat: e.lat, lng: e.lng, posSigmaM, heading, logId: r.id || null });
            }

            function markRough(/** @type {any} */ s) {
                if (!hasPos(s)) return;
                log.add({ type: "rough", t: s.t, lat: s.lat, lng: s.lng, source: "imu", rider: "self", present: true, conf: cfg.roughSegmentConf });
                // consecutive rough 20 m segments make one rough section for the review (a line, not a point)
                if (roughOpen && s.t - roughOpen.tEnd <= 5000) { roughOpen.points.push([s.lat, s.lng]); roughOpen.tEnd = s.t; roughOpen.lengthM += s.distM; }
                else {
                    roughOpen = { id: `r${s.t}`, kind: "rough", hazard: "rough", severity: s.cls === "very_rough" ? 3 : 2, minor: false, t: s.t, tEnd: s.t, lat: s.lat, lng: s.lng, points: [[s.lat, s.lng]], lengthM: s.distM, heading: Number.isFinite(s.headingDeg) ? s.headingDeg : null };
                    reviewItem(roughOpen);
                }
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

            /** The hazards that may be warned about: the phone's own verified strong bumps, and the published ones riders still confirm. */
            function candidates(/** @type {any} */ f) {
                const e = f.ego;
                const own = log.query({ lat: e.lat, lng: e.lng, radiusM: 700, now: f.t, group: "shock" }).filter(strong)
                    .map((/** @type {any} */ c) => ({ id: c.id, lat: c.lat, lng: c.lng, heading: null, bothWays: true, severity: Number.isFinite(c.peakMs2) && c.peakMs2 >= 14 ? 3 : 2, alertable: true, ptype: "impact", source: "log", ev: c }));
                const pub = community ? community.near(e.lat, e.lng, 700).filter((/** @type {any} */ h) => h.alertable)
                    .filter((/** @type {any} */ h) => !own.some((o) => Math.hypot((o.lat - h.lat) * M_PER_DEG, (o.lng - h.lng) * M_PER_DEG * Math.cos(h.lat * Math.PI / 180)) <= cfg.dupM))
                    .map((/** @type {any} */ h) => ({ ...h, source: "community" })) : [];
                return [...own, ...pub];
            }

            function lookAhead(/** @type {any} */ f) {
                const e = f.ego;
                if (!Number.isFinite(e.lat) || !Number.isFinite(e.lng) || !Number.isFinite(e.headingDeg)) return;
                const nextTurnM = navTurn ? navTurn.nextTurnM() : null;
                // how long the voice's warning line takes (master-app measures it per style and tone)
                const persona = ctx.bus && typeof ctx.bus.last === "function" ? ctx.bus.last("state.persona") : null;
                const speechS = persona && Number.isFinite(persona.warnSpeechS) ? persona.warnSpeechS : null;
                const a = planner.plan({ lat: e.lat, lng: e.lng, headingDeg: e.headingDeg, speedMs: e.speedMs, posSigmaM: e.posSigmaM, nextTurnM, speechS }, candidates(f), f.t);
                if (!a) return;
                stats.bumpsWarned++;
                for (const h of a.hazards) {
                    // "did you find it?" after the ride: only hazards other riders reported (the rider's own are already theirs)
                    const theirs = h.source === "community" ? !h.mine : !h.ev.felt;
                    if (theirs && !ride.warned.some((w) => w.roadsenseId === h.id)) ride.warned.push({
                        roadsenseId: h.id, t: f.t, lat: h.lat, lng: h.lng, kind: h.source === "community" ? h.type : h.ev.type, community: h.source === "community",
                        heading: Number.isFinite(h.heading) ? h.heading : null, bothWays: Boolean(h.bothWays), sigmaM: Number.isFinite(h.sigmaM) ? h.sigmaM : null
                    });
                }
                const key = `road.bump.${a.first.id}`;
                if (a.kind === "generic") {
                    ctx.report("road.hazards-stretch", { severity: "warning", priority: AL.PRIORITY, key: "road.hazards-stretch", category: "road", ridingOnly: true, ttlMs: 4000, confidence: 0.7, data: { count: a.count } });
                    return;
                }
                if (a.kind === "cluster") {
                    const words = a.hazards.map((/** @type {any} */ h) => (h.source === "community" ? TR.communityEvidence(h, f.t).shortPlain : TR.screenEvidence({ ...h.ev, ageS: Math.max(0, Math.round((f.t - h.ev.lastSeen) / 1000)) })));
                    ctx.report("road.hazards-ahead", {
                        severity: "warning", priority: AL.PRIORITY, key, category: "road", ridingOnly: true, ttlMs: 4000, confidence: 0.75,
                        data: { count: a.count, spanM: a.spanM, distanceM: a.distanceM, detail: words[0], screen: { detail: `first in ${a.distanceM} m` } }
                    });
                    return;
                }
                const h = a.first;
                if (h.source === "community") {
                    const w = TR.communityEvidence(h, f.t);
                    if (h.ptype === "rough") {
                        ctx.report("road.rough-stretch", { severity: "advice", key, category: "road", ridingOnly: true, ttlMs: 8000, confidence: 0.75, data: { distanceM: a.distanceM, evidence: w.shortDesi, screen: { evidence: w.shortPlain } } });
                        return;
                    }
                    ctx.report("road.bump-reported", {
                        severity: "warning", priority: AL.PRIORITY, key, category: "road", ridingOnly: true, ttlMs: 4000, confidence: 0.75,
                        data: {
                            distanceM: a.distanceM, riders: h.found, kind: h.type, severity: h.severity, roadsenseId: h.id, community: true,
                            agreementPct: h.agreementPct, found: h.found, notFound: h.notFound,
                            evidence: w.shortDesi, evidenceTu: w.shortDesi, detail: w.screen,
                            screen: { evidence: w.shortPlain }
                        }
                    });
                    return;
                }
                // the phone's own log: felt here before → "where you hit one before"; only other riders' synced evidence → say so
                const c = h.ev;
                const row = { ...c, ageS: Math.max(0, Math.round((f.t - c.lastSeen) / 1000)) };
                const w = TR.evidence(row);
                ctx.report(c.felt ? "road.bump-ahead" : "road.bump-reported", {
                    severity: "warning", priority: AL.PRIORITY, key, category: "road", ridingOnly: true, ttlMs: 4000, confidence: c.confidence,
                    data: {
                        distanceM: a.distanceM, passes: c.passes, riders: c.riders, peakMs2: c.peakMs2 === null ? null : Math.round(c.peakMs2),
                        kind: c.type, sources: c.sources, lastSeenAgoS: row.ageS, confidence: c.confidence, roadsenseId: c.id,
                        evidence: w.shortDesi, detail: TR.screenEvidence(row),
                        screen: { evidence: w.shortPlain }
                    }
                });
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

            /**
             * Smooth passes. A coverage cell (≈ 220 m) counts only if EVERY frame in it could have felt a bump
             * (≥ 3 m/s, IMU ≥ 50 Hz, a good fix) and nothing was felt there: no jolt, no rough 20 m segment.
             * Committed once the bike has left the cell and cleanSettleMs has passed (a late jolt can still spoil it).
             */
            function noteSmooth(/** @type {any} */ f) {
                const e = f.ego;
                const spoil = (/** @type {any} */ x) => { if (!hasPos(x)) return; const c = cover.cellOf(x.lat, x.lng); const v = inCell.get(c); if (v) v.smooth = false; else inCell.set(c, { last: f.t, smooth: false }); };
                for (const ev of f.events) if (ev.type === "jolt") spoil(ev);
                for (const sg of f.segments) if (sg.cls === "rough" || sg.cls === "very_rough") spoil(sg);
                if (hasPos(e)) {
                    const good = e.speedMs >= cfg.cleanMinSpeedMs && f.imuHz >= cfg.cleanMinImuHz && !(Number.isFinite(e.posSigmaM) && e.posSigmaM > cfg.cleanMaxPosSigmaM);
                    const c = cover.cellOf(e.lat, e.lng);
                    const v = inCell.get(c) || { last: f.t, smooth: true };
                    v.last = f.t;
                    if (!good) v.smooth = false;
                    inCell.set(c, v);
                    for (const [cell, x] of inCell) {
                        if (cell === c || f.t - x.last < cfg.cleanSettleMs) continue;
                        inCell.delete(cell);
                        if (x.smooth && cover.add({ cell, t: x.last, rider: RS.SELF })) stats.smoothCells++;
                    }
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
                trackPassages(f);
                noteSmooth(f);
                if (f.events.length || f.segments.length) { save(f.t); keepReview(); }

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
            ctx.onStop(() => { off(); overBump.clear(); inCell.clear(); save(ctx.now(), true); ride.endedAt = ctx.now(); trackPassages({ t: ride.endedAt, ego: {} }, true); keepReview(); P.stop().catch(() => {}); });
            return P.start();
        }
    };
});
