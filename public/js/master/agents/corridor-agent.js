// @ts-check
/* ============================================================================
   MapUnite Master AI — Corridor agent ("corridor"): what "2 km ahead" means
   ==============================================================================
   The 2 km Ultra-Radar is several agents (weather, traffic, terrain,
   blackspot, POI). They must all look at the SAME road ahead, so one agent
   computes it and shares it as state.corridor; the others only read it.

   Every accepted GPS fix (≈ 1 s), moved ≥ 10 m or 5 s since the last one:
     mode "route"    on a route (navigation): the route itself from the rider's
                     projection, lookAheadM long (default 2000 m);
     mode "heading"  riding without a route: a straight line along the current
                     heading (from fixes ≥ 15 m apart). Weather and blackspots
                     still make sense; traffic and road features are best effort;
     mode "here"     stopped / heading unknown: just the position.

   state.corridor = {
     active,                    riding or navigating → the radar agents run (their runWhen)
     mode, at, seq,
     ego: { lat, lng, speedMs, headingDeg, accuracyM },
     line: [[lat, lng], …]      the road ahead, ≤ 40 vertices (thinned), metres-exact ends
     samples: [[lat, lng, s], …] every sampleM (default 200 m), s = metres ahead
     lengthM, sOnRouteM, routeRemainingM, routeId, offRouteM
   }
   Also state.light = "day" | "dusk" | "dark" (sun elevation at the rider), on change.

   A consumer re-queries its server only when the corridor's far end has moved
   far enough for IT (weather: 1 km; traffic: 300 m …), not on every update.
   ============================================================================ */
(function (root, factory) {
    // geo.js and phrases-radar.js load before this file (index.html); in Node they're required
    if (typeof module === "object" && module.exports) module.exports = factory(require("../geo.js"), require("../phrases-radar.js"));
    else {
        const M = /** @type {any} */ (root).MUMaster || (/** @type {any} */ (root).MUMaster = {});
        const def = factory(M.geo, M.phrasesRadar);
        if (typeof M.define === "function") M.define(def); else (M._pending || (M._pending = [])).push(def);
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function (/** @type {any} */ GEO, /** @type {any} */ PHRASES) {
    "use strict";

    /** @returns {any} */
    const geo = () => GEO;

    /** Thin a polyline to ≤ max vertices, keeping both ends (Douglas–Peucker would be nicer; even spacing is enough here). @param {Array<[number, number]>} line @param {number} max */
    function thin(line, max) {
        if (line.length <= max) return line;
        const out = [];
        const step = (line.length - 1) / (max - 1);
        for (let i = 0; i < max; i++) out.push(line[Math.round(i * step)]);
        return out;
    }

    return {
        id: "corridor",
        version: "1.0.0",
        apiVersion: 1,
        description: "The road ahead (2 km) that every radar agent looks at.",
        requires: ["location"],
        optional: ["route", "drive"],
        defaults: {
            lookAheadM: 2000,
            sampleM: 200,
            minMoveM: 10,
            minIntervalMs: 5000,
            offRouteM: 120,
            headingMinMoveM: 15,
            maxLineVertices: 40,
            stillSpeedMs: 1.5
        },

        /** @param {any} ctx */
        start(ctx) {
            const G = geo();
            const cfg = ctx.config;
            const loc = ctx.caps.get("location");
            const route = ctx.caps.get("route");
            const drive = ctx.caps.get("drive");
            const cursor = G.createCursor();
            let seq = 0, lastPub = { lat: NaN, lng: NaN, at: -Infinity, active: false, routeId: "" };
            /** @type {{ lat: number, lng: number }|null} */ let headingFrom = null;
            let headingDeg = /** @type {number|null} */ (null);
            /** @type {any} */ let routeRef = null;
            let routeId = "";
            let lastLight = "";

            const riding = () => { const r = ctx.bus.last("state.ride"); return Boolean(r && r.active); };
            const navigating = () => Boolean(drive && drive.current().navigating);

            function onFix(/** @type {any} */ f) {
                if (!f || !Number.isFinite(f.lat) || !Number.isFinite(f.lng)) return;
                const t = ctx.now();
                // heading from movement (GPS course is noisy below walking pace)
                if (!headingFrom) headingFrom = { lat: f.lat, lng: f.lng };
                else if (G.metres(headingFrom.lat, headingFrom.lng, f.lat, f.lng) >= cfg.headingMinMoveM) {
                    headingDeg = Math.round(G.bearing(headingFrom.lat, headingFrom.lng, f.lat, f.lng));
                    headingFrom = { lat: f.lat, lng: f.lng };
                }
                const active = riding() || navigating();
                const r = route ? route.current() : null;
                if (r !== routeRef) { routeRef = r; routeId = r ? `r${++seq}` : ""; cursor.reset(); }
                const moved = Number.isFinite(lastPub.lat) ? G.metres(lastPub.lat, lastPub.lng, f.lat, f.lng) : Infinity;
                const changed = active !== lastPub.active || routeId !== lastPub.routeId;
                if (!changed && moved < cfg.minMoveM && t - lastPub.at < cfg.minIntervalMs) return;

                /** @type {any} */ let out = null;
                if (r && Array.isArray(r.path) && r.path.length > 1) {
                    const p = cursor.locate(r.path, f.lat, f.lng);
                    if (p.d <= cfg.offRouteM) {
                        const sl = G.slice(r.path, p.cum, p.i, p.t, cfg.lookAheadM);
                        const total = p.cum[p.cum.length - 1];
                        out = { mode: "route", line: sl.line, lengthM: Math.round(sl.lengthM), sOnRouteM: Math.round(p.s), routeRemainingM: Math.round(total - p.s), offRouteM: Math.round(p.d) };
                    } else out = { offRouteM: Math.round(p.d) };
                }
                if (!out || !out.line) {
                    const speed = Number.isFinite(f.speedMs) ? f.speedMs : 0;
                    if (headingDeg !== null && speed >= cfg.stillSpeedMs) {
                        /** @type {Array<[number, number]>} */ const line = [[f.lat, f.lng]];
                        for (let s = 500; s <= cfg.lookAheadM; s += 500) line.push(G.offset(f.lat, f.lng, headingDeg, s));
                        out = { ...(out || {}), mode: "heading", line, lengthM: cfg.lookAheadM };
                    } else out = { ...(out || {}), mode: "here", line: [[f.lat, f.lng]], lengthM: 0 };
                }
                const line = thin(out.line, cfg.maxLineVertices);
                const samples = out.lengthM > 0 ? G.resample(out.line, cfg.sampleM) : [[f.lat, f.lng, 0]];
                seq++;
                ctx.setState("corridor", {
                    active, at: t, seq, routeId,
                    ego: { lat: f.lat, lng: f.lng, speedMs: Number.isFinite(f.speedMs) ? f.speedMs : 0, headingDeg, accuracyM: f.accuracyM ?? null },
                    mode: out.mode, line, samples, lengthM: out.lengthM,
                    sOnRouteM: out.sOnRouteM ?? null, routeRemainingM: out.routeRemainingM ?? null, offRouteM: out.offRouteM ?? null
                });
                lastPub = { lat: f.lat, lng: f.lng, at: t, active, routeId };
                // daylight, for the reasoning layer (night × blackspot) and the destination agent
                const lightNow = G.light(f.lat, f.lng, Date.now());
                if (lightNow !== lastLight) { lastLight = lightNow; ctx.setState("light", lightNow); }
                ctx.heartbeat();
            }

            const offs = [loc.onFix(ctx.wrap(onFix))];
            // a ride starting / ending must flip `active` without waiting for the next move
            ctx.bus.subscribe("state.ride", () => { const c = loc.current(); if (c) { lastPub.at = -Infinity; onFix(c); } });
            if (drive) offs.push(drive.onChange(ctx.wrap(() => { const c = loc.current(); if (c) { lastPub.at = -Infinity; onFix(c); } })));
            if (route) offs.push(route.onChange(ctx.wrap(() => { const c = loc.current(); if (c) onFix(c); })));
            ctx.onStop(() => offs.forEach((off) => off()));
            const c = loc.current();
            if (c) onFix(c);
        }
    };
});
