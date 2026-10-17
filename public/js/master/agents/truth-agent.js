// @ts-check
/* ============================================================================
   MapUnite Master AI — Route Truth agent ("road-truth"): what is KNOWN about
   the road, with its evidence, for the screen and the voice
   ==============================================================================
   Builds the Route Truth Card (js/master/roadsense/truth.js) from the RoadSense
   log for the route on screen, and keeps it current:
     - a route is set or cleared              → rebuilt at once
     - the log changes (a jolt, a download)   → rebuilt within 5 s
     - navigating, every 100 m along the route → rows behind the rider drop off,
                                                 distances count from the rider
   state.truth = { at, hasRoute, navigating, card, sources } (the screen: js/master/roadsense/truth-card.js)

   Voice:
     task.road-truth   "aage sadak kaisi hai?" (js/voice.js, or the Deep Search
                       model's road_ahead action): the card ahead of the rider,
                       or within 2 km when there's no route, and the phrases to say
                       it with (truth.js phraseKind + phraseExtras): reports,
                       "clear" (smooth passes by 2+ riders), ridden once, unknown;
                       then official items by name and predictions, kept apart
     road.route-truth  advice, once per route when navigation starts, only when
                       the route has confirmed reports (the ask-first gate applies)

   "Sensors verify, language models talk": every number here comes from the
   log's rules; the words are fixed phrases filled with those numbers. No model
   is asked what the road is like.
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

    function truthLib() {
        const g = /** @type {any} */ (globalThis);
        if (g.MUMaster && g.MUMaster.roadTruth) return g.MUMaster.roadTruth;
        // @ts-ignore: node (tests) only
        if (typeof module === "object" && typeof require === "function") return require("../roadsense/truth.js");
        return null;
    }

    return {
        id: "road-truth",
        version: "1.0.0",
        apiVersion: 1,
        description: "The Route Truth Card: road reports on the route with their source, age and confidence, or 'condition unknown'.",
        requires: ["roadsense"],
        optional: ["route", "location", "drive", "roadsense-sync", "roadsense-cover", "roadsense-community"],
        defaults: {
            debounceMs: 5000,          // log changes → rebuilt at most this often
            moveStepM: 100,            // navigating: rebuilt every 100 m along the route
            offRouteM: 60,             // farther than this from the route: distances aren't counted from the rider
            nearRadiusM: 2000          // no route: what's within 2 km
        },

        /** @param {any} ctx */
        start(ctx) {
            const cfg = ctx.config;
            const T = truthLib();
            const log = ctx.caps.get("roadsense");
            const route = ctx.caps.has("route") ? ctx.caps.get("route") : null;
            const location = ctx.caps.has("location") ? ctx.caps.get("location") : null;
            const drive = ctx.caps.has("drive") ? ctx.caps.get("drive") : null;
            const sync = ctx.caps.has("roadsense-sync") ? ctx.caps.get("roadsense-sync") : null;
            const cover = ctx.caps.has("roadsense-cover") ? ctx.caps.get("roadsense-cover") : null;   // smooth passes: "ridden, nothing found"
            const communityCap = ctx.caps.has("roadsense-community") ? ctx.caps.get("roadsense-community") : null;   // RoadPulse: published hazards
            const community = () => (communityCap ? communityCap.list() : []);

            /** @type {number[][]|null} */ let path = null;
            /** @type {{ lat: number, lng: number, s: number }[]} */ let pts = [];
            let fromM = 0, builtFromM = -Infinity, navigating = false, announcedFor = /** @type {any} */ (null);
            /** @type {any} */ let card = null;
            /** @type {any} */ let pending = null;

            const sources = () => {
                const s = sync ? sync.status() : null;
                return s ? { community: s.consent, lastFetch: s.lastFetch, tilesCached: s.tilesCached, offline: s.backoffUntil > ctx.now(), lastError: s.lastError } : { community: false };
            };

            function rebuild() {
                pending = null;
                const t = ctx.now();
                card = path ? T.buildTruth({ log, cover, community: community(), path, now: t, fromM: navigating ? fromM : 0 }) : null;
                builtFromM = fromM;
                ctx.setState("truth", { at: t, hasRoute: Boolean(path), navigating, card, sources: sources() });
                ctx.heartbeat();
            }
            const soon = () => { if (!pending) pending = ctx.timers.setTimeout(rebuild, cfg.debounceMs); };

            function setRoute(/** @type {any} */ r) {
                path = r && Array.isArray(r.path) && r.path.length > 1 ? r.path : null;
                pts = path ? T.resample(path, 50) : [];
                fromM = 0;
                announcedFor = null;
                rebuild();
                maybeAnnounce();
            }

            /** navigation started on a route with confirmed reports: say what's on it, once */
            function maybeAnnounce() {
                if (!navigating || !path || announcedFor === path || !card) return;
                announcedFor = path;
                if (card.verified < 1) return;                         // nothing confirmed: the card on screen says "unknown"
                ctx.report("road.route-truth", {
                    severity: "advice", key: "road.route-truth", category: "road", ttlMs: 60000, confidence: 0.9,
                    data: T.phraseData(card, "route")
                });
            }

            const offAdd = log.onAdd(ctx.wrap(soon));
            ctx.onStop(offAdd);
            if (cover) { const off = cover.onAdd(ctx.wrap(soon)); ctx.onStop(off); }
            if (sync) { const off = sync.onChange(ctx.wrap(soon)); ctx.onStop(off); }
            if (route) { const off = route.onChange(ctx.wrap(setRoute)); ctx.onStop(off); }
            if (drive) {
                const off = drive.onChange(ctx.wrap((/** @type {any} */ d) => {
                    const was = navigating;
                    navigating = Boolean(d && d.navigating);
                    if (navigating !== was) { rebuild(); maybeAnnounce(); }
                }));
                ctx.onStop(off);
                navigating = Boolean(drive.current() && drive.current().navigating);
            }
            if (location) {
                const off = location.onFix(ctx.wrap((/** @type {any} */ f) => {
                    if (!navigating || !pts.length || !f || !Number.isFinite(f.lat) || !Number.isFinite(f.lng)) return;
                    const p = T.project(pts, f.lat, f.lng);
                    if (p.offsetM > cfg.offRouteM) return;               // off the route: keep the last position
                    fromM = p.alongM;
                    if (Math.abs(fromM - builtFromM) >= cfg.moveStepM) rebuild();
                }));
                ctx.onStop(off);
            }

            // "aage sadak kaisi hai?": the card ahead of the rider (or around them), and which phrase says it
            ctx.bus.handle("task.road-truth", () => {
                const t = ctx.now();
                let c, scope;
                if (path) { c = T.buildTruth({ log, cover, community: community(), path, now: t, fromM }); scope = fromM > 0 ? "ahead" : "route"; }
                else {
                    const here = location && location.current();
                    if (!here || !Number.isFinite(here.lat) || !Number.isFinite(here.lng)) return { kind: "road.truth-unknown", extras: [], data: { ...T.phraseData({ rows: [], verified: 0, candidates: 0, predicted: 0, byKind: {}, coverage: {} }, "near") }, card: null, sources: sources() };
                    c = T.buildNear({ log, community: community(), lat: here.lat, lng: here.lng, now: t, radiusM: cfg.nearRadiusM });
                    scope = "near";
                }
                return { kind: T.phraseKind(c), extras: T.phraseExtras(c), data: T.phraseData(c, scope), card: c, sources: sources() };
            });

            if (route) setRoute(route.current()); else rebuild();
        }
    };
});
