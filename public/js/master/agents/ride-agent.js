// @ts-check
/* ============================================================================
   MapUnite Master AI — Ride agent ("ride")
   ==============================================================================
   Knows whether you're riding, for how long, and when you last took a break.
   Every other agent reads its shared state instead of re-deriving it:

     state.ride = { active, startedAt, ridingSec, movingSec, distanceM,
                    speedMs, stopped, stoppedForSec, lat, lng, at }

     ridingSec   moving time since the last real break (a stop of ≥ 10 min)
     movingSec   moving time since the ride started

   Reports
     ride.started / ride.ended / ride.break-taken   info (transcript only)
     ride.break-due  advice at 1 h 30 min of riding without a break,
                     warning at 2 h, repeated every 20 min after that.
   The Biometric Selfie engine (next step) will listen for ride.break-due and
   for the stop that follows it.

   Reads the app's own GPS pipeline (capability "location") and riding state
   ("drive"); no extra GPS watch.
   ============================================================================ */
(function (root, factory) {
    const def = factory();
    if (typeof module === "object" && module.exports) module.exports = def;
    else {
        // load order doesn't matter: before the kernel exists, definitions wait in a queue
        const M = /** @type {any} */ (root).MUMaster || (/** @type {any} */ (root).MUMaster = {});
        if (typeof M.define === "function") M.define(def); else (M._pending || (M._pending = [])).push(def);
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    return {
        id: "ride",
        version: "1.0.0",
        apiVersion: 1,
        description: "Ride session: riding time, breaks, distance. Shares state.ride.",
        requires: ["location", "drive"],
        defaults: {
            movingSpeedMs: 2,          // above ~7 km/h counts as riding
            breakAfterSec: 5400,       // 1 h 30 min → advice
            breakUrgentSec: 7200,      // 2 h → warning
            repeatUrgentSec: 1200,     // then every 20 min
            breakResetSec: 600,        // a 10-minute stop is a break
            maxGapSec: 10,             // a longer gap between fixes isn't counted as riding
            publishEveryMs: 2000
        },

        /** @param {any} ctx */
        start(ctx) {
            const cfg = ctx.config;
            const loc = ctx.caps.get("location");
            const drive = ctx.caps.get("drive");
            const s = {
                active: false, startedAt: /** @type {number|null} */ (null), ridingSec: 0, movingSec: 0, distanceM: 0,
                speedMs: 0, stoppedSince: /** @type {number|null} */ (null), lastT: /** @type {number|null} */ (null),
                lat: /** @type {number|null} */ (null), lng: /** @type {number|null} */ (null),
                level: 0, lastUrgentAt: 0, lastPublish: 0
            };

            const snapshot = (/** @type {number} */ t) => ({
                active: s.active, startedAt: s.startedAt, ridingSec: Math.round(s.ridingSec), movingSec: Math.round(s.movingSec),
                distanceM: Math.round(s.distanceM), speedMs: s.speedMs, stopped: s.stoppedSince !== null,
                stoppedForSec: s.stoppedSince !== null ? Math.round((t - s.stoppedSince) / 1000) : 0, lat: s.lat, lng: s.lng, at: t
            });
            const publish = (/** @type {number} */ t, force = false) => {
                if (!force && t - s.lastPublish < cfg.publishEveryMs) return;
                s.lastPublish = t;
                ctx.setState("ride", snapshot(t));
            };

            function begin(/** @type {number} */ t) {
                Object.assign(s, { active: true, startedAt: t, ridingSec: 0, movingSec: 0, distanceM: 0, speedMs: 0, stoppedSince: null, lastT: null, level: 0, lastUrgentAt: 0 });
                ctx.report("ride.started", { severity: "info" });
                publish(t, true);
            }
            function end(/** @type {number} */ t) {
                if (!s.active) return;
                s.active = false;
                ctx.report("ride.ended", { severity: "info", data: { movingSec: Math.round(s.movingSec), distanceM: Math.round(s.distanceM) } });
                publish(t, true);
            }

            function onFix(/** @type {any} */ f) {
                const t = Number.isFinite(f.t) ? f.t : ctx.now();
                if (Number.isFinite(f.lat) && Number.isFinite(f.lng)) { s.lat = f.lat; s.lng = f.lng; }
                if (!s.active) return;
                const dt = s.lastT === null ? 0 : (t - s.lastT) / 1000;
                s.lastT = t;
                s.speedMs = Number.isFinite(f.speedMs) ? f.speedMs : 0;
                const moving = s.speedMs >= cfg.movingSpeedMs;
                if (!moving && s.stoppedSince === null) s.stoppedSince = t;
                // A long stop counts as a break, and so does a long silence: parked, GPS asleep, app in the background.
                const stoppedFor = s.stoppedSince !== null ? (t - s.stoppedSince) / 1000 : 0;
                if (s.ridingSec > 0 && (dt >= cfg.breakResetSec || stoppedFor >= cfg.breakResetSec)) {
                    s.ridingSec = 0; s.level = 0;
                    ctx.report("ride.break-taken", { severity: "info", data: { stoppedForSec: Math.round(Math.max(dt, stoppedFor)) } });
                    publish(t, true);
                }
                if (moving) {
                    if (dt > 0 && dt <= cfg.maxGapSec) { s.ridingSec += dt; s.movingSec += dt; s.distanceM += s.speedMs * dt; }
                    s.stoppedSince = null;
                }
                // break reminders (only while moving: a rider who has just stopped is already resting)
                if (s.stoppedSince === null) {
                    const data = { ridingSec: Math.round(s.ridingSec) };
                    if (s.ridingSec >= cfg.breakUrgentSec && (s.level < 2 || t - s.lastUrgentAt >= cfg.repeatUrgentSec * 1000)) {
                        s.level = 2; s.lastUrgentAt = t;
                        ctx.report("ride.break-due", { severity: "warning", key: "ride.break", category: "fatigue", ridingOnly: true, data, cooldownMs: cfg.repeatUrgentSec * 1000 - 1000 });
                    } else if (s.ridingSec >= cfg.breakAfterSec && s.level < 1) {
                        s.level = 1;
                        ctx.report("ride.break-due", { severity: "advice", key: "ride.break", category: "fatigue", ridingOnly: true, data });
                    }
                }
                publish(t);
            }

            const offFix = loc.onFix(ctx.wrap(onFix));
            const offDrive = drive.onChange(ctx.wrap((/** @type {any} */ d) => { const t = ctx.now(); if (d.driving && !s.active) begin(t); else if (!d.driving && s.active) end(t); }));
            ctx.onStop(() => { offFix(); offDrive(); });
            if (drive.current().driving) begin(ctx.now()); else publish(ctx.now(), true);
        }
    };
});
