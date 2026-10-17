// @ts-check
/* ============================================================================
   MapUnite Master AI — RoadSense sync agent ("roadsense-sync"): shares and
   receives road evidence (opt-in), so warnings work without signal
   ==============================================================================
   Drives js/master/roadsense/sync.js (capability "roadsense-sync"); does nothing
   at all while "Community road reports" is off.

     every minute        upload this phone's observations that are ≥ 10 min old
     a route is set      fetch the live evidence in every ≈ 5.5 km tile along it
                         (≤ 200 tiles), while there's signal, into the phone's log
     while riding        every 5 minutes, the tiles around the rider (signal
                         permitting): covers rides without a route
     a ride starts/ends  that spot becomes a private zone: nothing within 250 m
                         is ever uploaded (so does the first fix after the app
                         opens: a ride the phone died in never "ended")

   It says nothing to the rider: the dynamics agent warns from the log, which
   now also holds other riders' evidence. state.roadsense = sync.status().
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

    return {
        id: "roadsense-sync",
        version: "1.0.0",
        apiVersion: 1,
        description: "Opt-in: shares this phone's anonymous road observations and downloads other riders' along the route, for offline warnings.",
        requires: ["roadsense-sync"],
        optional: ["route", "location"],
        defaults: {
            flushEveryMs: 60000,
            longStopMs: 10 * 60000, stopRadiusM: 60,
            aroundEveryMs: 300000,       // while riding: refresh the tiles around the rider
            aroundMarginM: 6000          // ≈ one tile each way
        },

        /** @param {any} ctx */
        start(ctx) {
            const cfg = ctx.config;
            const sync = ctx.caps.get("roadsense-sync");
            const route = ctx.caps.has("route") ? ctx.caps.get("route") : null;
            const location = ctx.caps.has("location") ? ctx.caps.get("location") : null;
            let riding = false, lastAround = -Infinity, busy = false;
            /** @type {any} */ let lastFix = null;

            const share = () => ctx.setState("roadsense", sync.status());
            const offStatus = sync.onChange(ctx.wrap(share));
            share();

            /** one network job at a time (a slow link must not stack requests) */
            async function job(/** @type {() => Promise<any>} */ fn) {
                if (busy) return;
                busy = true;
                try { await fn(); } catch (e) { ctx.log.warn("sync failed:", e); } finally { busy = false; }
            }

            function fetchRoute(/** @type {any} */ r) {
                if (!sync.consent() || !r || !Array.isArray(r.path) || r.path.length < 2) return;
                job(() => sync.fetchTiles(sync.tilesAlong(r.path)));
            }

            function tick() {
                ctx.heartbeat();
                if (!sync.consent()) return;
                const t = ctx.now();
                job(async () => {
                    await sync.flush();
                    const here = location && location.current();
                    if (riding && here && Number.isFinite(here.lat) && Number.isFinite(here.lng) && t - lastAround >= cfg.aroundEveryMs) {
                        lastAround = t;
                        await sync.fetchTiles(sync.tilesAlong([[here.lat, here.lng]], cfg.aroundMarginM));
                    }
                });
            }

            if (route) {
                const offRoute = route.onChange(ctx.wrap(fetchRoute));
                ctx.onStop(offRoute);
            }
            if (location) {
                // the first fix after the app opens is private too: if the phone died mid-ride, the ride's end
                // (often home) was never marked, and its last observations would otherwise go up
                let first = true;
                // a long stop (10 min within 60 m: a shop, a friend's place, an office) is private too
                /** @type {{ lat: number, lng: number, t: number, marked: boolean }|null} */ let stop = null;
                const M = 111320;
                const offFix = location.onFix(ctx.wrap((/** @type {any} */ f) => {
                    if (!f || !Number.isFinite(f.lat) || !Number.isFinite(f.lng)) return;
                    lastFix = f;
                    if (first) { first = false; sync.markPrivate(f.lat, f.lng); }
                    const t = Number.isFinite(f.t) ? f.t : ctx.now();
                    const away = stop ? Math.hypot((f.lat - stop.lat) * M, (f.lng - stop.lng) * M * Math.cos(f.lat * Math.PI / 180)) : Infinity;
                    if (!stop || away > cfg.stopRadiusM) stop = { lat: f.lat, lng: f.lng, t, marked: false };
                    else if (!stop.marked && t - stop.t >= cfg.longStopMs) { stop.marked = true; sync.markPrivate(stop.lat, stop.lng); }
                }));
                ctx.onStop(offFix);
            }
            // where a ride starts and ends is private (home, work): nothing near it is ever uploaded
            ctx.bus.subscribe("state.ride", (/** @type {any} */ r) => {
                const active = Boolean(r && r.active);
                if (active === riding) return;
                riding = active;
                const here = (location && location.current()) || lastFix;
                if (here && Number.isFinite(here.lat) && Number.isFinite(here.lng)) sync.markPrivate(here.lat, here.lng);
                if (!active) tick();                                   // a ride just ended: its leftovers can go once old enough
            });
            // turned on now, or a route already on screen: fetch it
            let wasOn = sync.consent();
            const offConsent = sync.onChange(ctx.wrap((/** @type {any} */ s) => {
                const turnedOn = s.consent && !wasOn;
                wasOn = s.consent;
                if (turnedOn && route) fetchRoute(route.current());
            }));
            ctx.timers.setInterval(tick, cfg.flushEveryMs);
            ctx.onStop(() => { offStatus(); offConsent(); });
            if (route) fetchRoute(route.current());
            tick();
        }
    };
});
