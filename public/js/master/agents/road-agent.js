// @ts-check
/* ============================================================================
   MapUnite Master AI — Road agent ("road"): the unified road model's voice
   ==============================================================================
   Consumes PerceptionFrames from the "perception" capability (the native
   multitask model, or a replay) while riding, and turns CONFIRMED evidence
   into reports for the Master:

     road.hazard          warning   pothole / waterlogging / unmarked breaker … in our
                                    path, said 2–8 s before we reach it
     traffic.closing-fast warning   a road user in our lane, time-to-collision ≤ 4 s
     traffic.wrong-side   warning   oncoming vehicle on our side / cutting in
     perception.degraded  advice    the phone is too hot, or the view is unusable

   Why it's cautious:
     - Nothing is said from one frame (perception/confirm.js: persistence +
       a physics check that a static hazard approaches at our own speed).
     - A hazard closer than 2 s is NOT spoken: by the time speech starts the
       bike is on it, and a sudden voice is a distraction. It's still logged.
     - Voice alerts are advisory. A spoken line takes ~1 s end to end, so the
       system never claims to prevent collisions; it gives early warnings.

   Fusion → map: every confirmed hazard is placed on the map (ego position +
   heading + its distance and lateral offset) in ~20 m cells on the phone
   (store "road.hazards"). That memory warns on later rides even when the
   camera isn't running, and is what a crowd map would be built from.

   The governor (perception/governor.js) sets the frame rate from heat,
   speed, battery and view quality every few seconds.
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

    function lib(/** @type {string} */ name) {
        const g = /** @type {any} */ (globalThis);
        if (g.MUMaster && g.MUMaster.perception && g.MUMaster.perception[name]) return g.MUMaster.perception[name];
        // @ts-ignore: node (tests) only
        if (typeof module === "object" && typeof require === "function") return require(`../perception/${name}.js`);
        return null;
    }

    // spoken (desi) and screen (English) names for each hazard class
    const HAZARD_WORDS = {
        pothole: ["gaddha", "Pothole"], waterlogging: ["paani bhara hua", "Waterlogging"],
        speed_breaker_unmarked: ["bina nishaan ka speed breaker", "Unmarked speed breaker"], speed_breaker_marked: ["speed breaker", "Speed breaker"],
        rumble_strip: ["rumble strip", "Rumble strip"], gravel_sand: ["bajri aur ret", "Gravel or sand"], road_work: ["sadak ka kaam", "Road work"],
        open_manhole: ["khula manhole", "Open manhole"], debris: ["sadak pe malba", "Debris on the road"], broken_edge: ["tuta hua kinara", "Broken road edge"],
        wet_patch: ["geeli sadak", "Wet patch"], oil_or_mud: ["tel ya keechad", "Oil or mud"]
    };
    const VEHICLE_WORDS = {
        two_wheeler: ["bike", "Two-wheeler"], auto_rickshaw: ["auto", "Auto-rickshaw"], e_rickshaw: ["e-rickshaw", "E-rickshaw"], car: ["gaadi", "Car"], suv: ["gaadi", "SUV"],
        bus: ["bus", "Bus"], truck: ["truck", "Truck"], tractor: ["tractor", "Tractor"], lcv: ["tempo", "Light truck"], cyclist: ["cycle", "Cyclist"],
        pedestrian: ["koi paidal", "Pedestrian"], handcart: ["thela", "Handcart"], cattle: ["gaay ya bhains", "Cattle"], dog: ["kutta", "Dog"], other_animal: ["janwar", "Animal"]
    };

    return {
        id: "road",
        version: "1.0.0",
        apiVersion: 1,
        description: "Road hazards and traffic from the on-device multitask road model, confirmed over time, only while riding.",
        requires: ["perception"],
        optional: ["location"],
        depends: ["ride"],
        runWhen: { topic: "state.ride", test: (/** @type {any} */ r) => Boolean(r && r.active) },
        defaults: {
            targetFps: 30,
            leadMinS: 2,              // closer than this: too late to speak usefully
            leadMaxS: 8,              // farther than this: wait
            pathHalfWidthM: 1.5,      // |lateral| within this = in our path
            governEveryMs: 4000,
            degradedAfterMs: 20000,   // view unusable / overheated this long → tell the rider once
            cellDeg: 0.0002,          // ≈ 20 m map cells
            maxCells: 2000
        },

        /** @param {any} ctx */
        start(ctx) {
            const cfg = ctx.config;
            const P = ctx.caps.get("perception");
            const confirm = lib("confirm"), governor = lib("governor");
            if (!confirm || !governor) throw new Error("perception/confirm.js and governor.js must be loaded");
            const hazards = confirm.createHazardConfirmer();
            const closing = confirm.createClosingWatch();
            const relations = confirm.createRelationWatch();
            /** @type {Map<string, any>} confirmed hazards waiting for their 2–8 s window */ const pending = new Map();
            /** @type {Record<string, { cls: Record<string, number>, n: number, last: number, lat: number, lng: number }>} */
            const map = ctx.store.get("hazards", {}) || {};
            let lastFrame = /** @type {any} */ (null), gov = { fps: cfg.targetFps, reason: "full", paused: false };
            let badSince = /** @type {number|null} */ (null), degradedSaid = false;
            const stats = { frames: 0, confirmed: 0, rejected: 0, alerts: 0 };

            const words = (/** @type {any} */ table, /** @type {string} */ cls) => table[cls] || [cls.replace(/_/g, " "), cls.replace(/_/g, " ")];

            function place(/** @type {any} */ h) {
                const e = h.ego || {};
                if (!Number.isFinite(e.lat) || !Number.isFinite(e.lng) || !Number.isFinite(e.headingDeg)) return null;
                const th = e.headingDeg * Math.PI / 180;
                const north = h.distM * Math.cos(th) - h.lateralM * Math.sin(th);
                const east = h.distM * Math.sin(th) + h.lateralM * Math.cos(th);
                const lat = e.lat + north / 111320, lng = e.lng + east / (111320 * Math.cos(e.lat * Math.PI / 180));
                const key = `${Math.round(lat / cfg.cellDeg)}:${Math.round(lng / cfg.cellDeg)}`;
                const c = map[key] || { cls: {}, n: 0, last: 0, lat, lng };
                c.cls[h.cls] = (c.cls[h.cls] || 0) + 1; c.n++; c.last = h.t;
                map[key] = c;
                const keys = Object.keys(map);
                if (keys.length > cfg.maxCells) keys.sort((a, b) => map[a].last - map[b].last).slice(0, keys.length - cfg.maxCells).forEach((k) => delete map[k]);
                ctx.store.set("hazards", map);
                return { lat, lng, key };
            }

            function sayHazard(/** @type {any} */ h, /** @type {number} */ distM) {
                const [desi, en] = words(HAZARD_WORDS, h.cls);
                stats.alerts++;
                ctx.report("road.hazard", {
                    severity: "warning", key: `road.hazard.${h.id}`, category: "road", ridingOnly: true, ttlMs: 4000, confidence: h.conf,
                    data: { hazard: desi, cls: h.cls, distanceM: Math.max(10, Math.round(distM / 10) * 10), screen: { hazard: en } }
                });
            }

            function onFrame(/** @type {any} */ f) {
                stats.frames++;
                lastFrame = f;
                const v = f.ego.speedMs;
                // 1. hazards: confirm, place on the map, speak inside the lead window
                const res = hazards.update(f);
                stats.rejected += res.rejected.length;
                for (const h of res.confirmed) { stats.confirmed++; place(h); pending.set(h.id, h); }
                for (const [id, h] of pending) {
                    const p = hazards.project(id, f.t) || { distM: h.distM, lateralM: h.lateralM };
                    const lead = v > 1 ? p.distM / v : Infinity;
                    if (p.distM <= 0 || lead < cfg.leadMinS) { pending.delete(id); continue; }       // passed, or too late to help
                    if (Math.abs(p.lateralM) > cfg.pathHalfWidthM) { pending.delete(id); continue; }  // not in our path
                    if (lead <= cfg.leadMaxS) { sayHazard(h, p.distM); pending.delete(id); }
                }
                // 2. a road user closing in, in our lane
                for (const c of closing.update(f)) {
                    const [desi, en] = words(VEHICLE_WORDS, c.cls);
                    stats.alerts++;
                    ctx.report("traffic.closing-fast", { severity: "warning", key: `traffic.closing.${c.id}`, category: "traffic", ridingOnly: true, ttlMs: 2500, confidence: c.conf,
                        data: { vehicle: desi, cls: c.cls, ttcS: Math.round(c.ttcS * 10) / 10, distanceM: Math.round(c.distM), screen: { vehicle: en } } });
                }
                // 3. wrong side / cutting in
                for (const r of relations.update(f)) {
                    const [desi, en] = words(VEHICLE_WORDS, r.cls || "car");
                    ctx.report(r.rel === "wrong_side" ? "traffic.wrong-side" : "traffic.cutting-in", { severity: "warning", key: `traffic.${r.rel}.${r.subj}`, category: "traffic", ridingOnly: true, ttlMs: 3000, confidence: r.conf,
                        data: { vehicle: desi, cls: r.cls, distanceM: r.distM === null ? null : Math.round(r.distM), screen: { vehicle: en } } });
                }
                // 4. health: an unusable view or an overheating phone, for long, is said once
                const bad = f.quality.usable < 0.3 || f.perf.thermal === "severe" || f.perf.thermal === "critical";
                if (!bad) { badSince = null; degradedSaid = false; ctx.markDegraded(""); }
                else {
                    if (badSince === null) badSince = f.t;
                    if (!degradedSaid && f.t - badSince >= cfg.degradedAfterMs) {
                        degradedSaid = true;
                        const why = f.perf.thermal === "severe" || f.perf.thermal === "critical" ? "heat" : "view";
                        ctx.markDegraded(why === "heat" ? "phone overheating" : "camera view unusable");
                        ctx.report("perception.degraded", { severity: "advice", key: "perception.degraded", category: "road", data: { why, reasons: f.quality.reasons } });
                    }
                }
                ctx.heartbeat();
            }

            const offFrame = P.onFrame(ctx.wrap(onFrame));
            const offState = P.onState(ctx.wrap((/** @type {any} */ s) => { if (s && s.state === "error") ctx.markDegraded(`perception: ${s.message || "error"}`); }));
            ctx.timers.setInterval(() => {
                if (!lastFrame) return;
                const next = governor.decide({ thermal: lastFrame.perf.thermal, speedMs: lastFrame.ego.speedMs, usable: lastFrame.quality.usable, target: cfg.targetFps }, gov);
                if (next.fps !== gov.fps) P.setTargetFps(next.fps).catch(() => {});
                gov = next;
                ctx.setState("road", { fps: lastFrame.perf.fps, targetFps: gov.fps, governor: gov.reason, thermal: lastFrame.perf.thermal, model: lastFrame.model, ...stats, mappedCells: Object.keys(map).length });
            }, cfg.governEveryMs);
            ctx.onStop(() => { offFrame(); offState(); P.stop().catch(() => {}); });
            return P.start({ targetFps: cfg.targetFps });
        }
    };
});
