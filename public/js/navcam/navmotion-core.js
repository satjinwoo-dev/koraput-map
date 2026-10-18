// @ts-check
/* ============================================================================
   MapUnite navigation motion — the maths (pure, no DOM, no Leaflet)
   ==============================================================================
   How a car navigator moves, between GPS fixes that come about once a second:
     - the rider's arrow sits ON the route while they're on it (a fix 10 m
       off the road is GPS error, not the rider in a field), and glides along
       the road at their speed every frame instead of jumping once a second:
       it goes where the last fix said, then keeps going at the last speed for
       up to 2 s (no fix yet), and never slides backwards for GPS shimmer;
     - off the route (further than snapM), it follows the raw fixes, gliding
       from where it is to each new one;
     - the route ahead starts at the arrow: the part behind it is gone;
     - near a turn, the camera zooms in and a white arrow is drawn on the road
       through the turn; after it, back out.
   index()        the route with distances along it
   project()      the nearest point on the route (searched near the last one first)
   pointAt(), bearingAt(), slice()   positions, the road's direction, pieces
   createMotion() the arrow's motion: fix() on each fix, frame(t) each frame
   zoomFor()      zoom by speed, closer in when a turn is near
   turnArrow()    the arrow drawn on the road through a turn
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else /** @type {any} */ (root).MUNavMotionCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const RAD = Math.PI / 180, R = 6371008.8;
    const DEFAULTS = Object.freeze({
        snapM: 35,             // a fix this close to the route is on it
        backJumpM: 40,         // further back than this is real (a U-turn, a bad earlier fix), not shimmer
        extrapolateMs: 2000,   // keep gliding at the last speed this long after a fix, then wait
        tauMs: 250,            // how quickly the drawn arrow catches up with where it should be
        freeGlideMs: 1000,     // off the route: glide to a new fix over about this long
        turnZoom: 18,          // zoom near a turn
        turnLeadS: 12,         // "near": this many seconds of riding before the turn…
        turnMinM: 150,         // …but at least this far
        turnMaxM: 400,         // …and at most this far
        arrowBeforeM: 40,      // the turn arrow: this much road before the turn (at zoom 18; longer when further out)
        arrowAfterM: 30        // and this much after it
    });

    /** Shortest signed turn a → b, degrees. @param {number} a @param {number} b */
    const angleDiff = (a, b) => { const d = ((b - a) % 360 + 540) % 360 - 180; return d === -180 ? 180 : d; };
    /** @param {number} a */
    const norm = (a) => ((a % 360) + 360) % 360;
    /** @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 */
    function metres(lat1, lng1, lat2, lng2) {
        const dLat = (lat2 - lat1) * RAD, dLng = (lng2 - lng1) * RAD;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }
    /** @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 */
    function bearing(lat1, lng1, lat2, lng2) {
        const y = Math.sin((lng2 - lng1) * RAD) * Math.cos(lat2 * RAD);
        const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lng2 - lng1) * RAD);
        return norm(Math.atan2(y, x) / RAD);
    }
    /** A point `m` metres from (lat, lng) towards `deg`. @param {number} lat @param {number} lng @param {number} deg @param {number} m */
    function offset(lat, lng, deg, m) {
        const dy = Math.cos(deg * RAD) * m, dx = Math.sin(deg * RAD) * m;
        return [lat + dy / R / RAD, lng + dx / (R * Math.cos(lat * RAD)) / RAD];
    }

    /**
     * The route, with the distance to every vertex.
     * @param {number[][]} line [[lat, lng], …]
     * @returns {{ line: number[][], cum: number[], length: number }}
     */
    function index(line) {
        const l = (Array.isArray(line) ? line : []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
        const cum = [0];
        for (let i = 1; i < l.length; i++) cum.push(cum[i - 1] + metres(l[i - 1][0], l[i - 1][1], l[i][0], l[i][1]));
        return { line: l, cum, length: cum[cum.length - 1] || 0 };
    }

    /**
     * The nearest point on the route. Searches around `hintSeg` first (the rider moves forward a little each fix),
     * and the whole route when that finds nothing within 60 m.
     * @param {ReturnType<typeof index>} ix @param {number} lat @param {number} lng @param {number} [hintSeg]
     * @returns {{ s: number, seg: number, lat: number, lng: number, offM: number }|null}
     */
    function project(ix, lat, lng, hintSeg) {
        const l = ix.line;
        if (l.length < 2) return l.length ? { s: 0, seg: 0, lat: l[0][0], lng: l[0][1], offM: metres(lat, lng, l[0][0], l[0][1]) } : null;
        const kx = Math.cos(lat * RAD) * R * RAD, ky = R * RAD;      // degrees → metres, locally
        const search = (/** @type {number} */ a, /** @type {number} */ b) => {
            let best = null;
            for (let i = Math.max(0, a); i < Math.min(l.length - 1, b); i++) {
                const ax = (l[i][1] - lng) * kx, ay = (l[i][0] - lat) * ky, bx = (l[i + 1][1] - lng) * kx, by = (l[i + 1][0] - lat) * ky;
                const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
                const f = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
                const px = ax + f * dx, py = ay + f * dy, d = Math.hypot(px, py);
                if (!best || d < best.offM) best = { seg: i, f, offM: d };
            }
            return best;
        };
        let b = Number.isFinite(hintSeg) ? search(/** @type {number} */ (hintSeg) - 20, /** @type {number} */ (hintSeg) + 300) : null;
        if (!b || b.offM > 60) { const g = search(0, l.length - 1); if (g && (!b || g.offM < b.offM)) b = g; }
        if (!b) return null;
        const i = b.seg, p = l[i], q = l[i + 1];
        return { s: ix.cum[i] + b.f * (ix.cum[i + 1] - ix.cum[i]), seg: i, lat: p[0] + b.f * (q[0] - p[0]), lng: p[1] + b.f * (q[1] - p[1]), offM: b.offM };
    }

    /** The vertex index whose segment holds s. @param {ReturnType<typeof index>} ix @param {number} s */
    function segAt(ix, s) {
        const c = ix.cum;
        if (s <= 0) return 0;
        if (s >= ix.length) return Math.max(0, c.length - 2);
        let lo = 0, hi = c.length - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
        return lo;
    }
    /** The point s metres along the route. @param {ReturnType<typeof index>} ix @param {number} s @returns {{ lat: number, lng: number, seg: number }} */
    function pointAt(ix, s) {
        const l = ix.line;
        if (l.length < 2) return { lat: l[0] ? l[0][0] : 0, lng: l[0] ? l[0][1] : 0, seg: 0 };
        const i = segAt(ix, s), a = ix.cum[i], b = ix.cum[i + 1];
        const f = b > a ? Math.max(0, Math.min(1, (s - a) / (b - a))) : 0;
        return { lat: l[i][0] + f * (l[i + 1][0] - l[i][0]), lng: l[i][1] + f * (l[i + 1][1] - l[i][1]), seg: i };
    }
    /** The road's direction at s: from a little behind to a little ahead, so a corner turns the arrow smoothly. @param {ReturnType<typeof index>} ix @param {number} s */
    function bearingAt(ix, s, behindM = 5, aheadM = 15) {
        const a = pointAt(ix, Math.max(0, s - behindM)), b = pointAt(ix, Math.min(ix.length, s + aheadM));
        if (metres(a.lat, a.lng, b.lat, b.lng) < 0.5) return null;
        return bearing(a.lat, a.lng, b.lat, b.lng);
    }
    /** The route from a to b, as [[lat, lng], …], ends included. @param {ReturnType<typeof index>} ix @param {number} a @param {number} b */
    function slice(ix, a, b) {
        if (ix.line.length < 2 || b <= a) return [];
        const p = pointAt(ix, a), q = pointAt(ix, b), out = [[p.lat, p.lng]];
        for (let i = p.seg + 1; i <= q.seg; i++) out.push(ix.line[i]);
        out.push([q.lat, q.lng]);
        return out;
    }

    /**
     * The rider's arrow between fixes.
     * fix({ lat, lng, speedMs, t }) on each fix (t in ms, the same clock as frame); frame(t) → where to draw it.
     * @param {ReturnType<typeof index>} ix @param {Partial<typeof DEFAULTS>} [opts]
     */
    function createMotion(ix, opts) {
        const o = { ...DEFAULTS, ...(opts || {}) };
        let route = ix;
        /** @type {"none"|"snap"|"free"} */ let mode = "none";
        let sFix = 0, tFix = 0, v = 0, sDisp = 0, tLast = 0, seg = 0;
        /** @type {{ lat: number, lng: number }|null} */ let disp = null;
        /** @type {{ from: { lat: number, lng: number }, to: { lat: number, lng: number }, t0: number, dur: number }|null} */ let glide = null;
        let course = /** @type {number|null} */ (null), lastFixT = 0;

        /** @param {{ lat: number, lng: number, speedMs?: number|null, t: number }} f */
        function fix(f) {
            if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng) || !Number.isFinite(f.t)) return;
            const p = project(route, f.lat, f.lng, seg);
            const dt = lastFixT ? f.t - lastFixT : 1000;
            lastFixT = f.t;
            if (p && p.offM <= o.snapM) {
                seg = p.seg;
                // the fix's own speed; without one (many phones give none, or 0, between fixes) the distance along the road per second
                const along = mode === "snap" && dt > 0 ? Math.max(0, (p.s - sFix) / (dt / 1000)) : 0;
                const speed = Number.isFinite(f.speedMs) && /** @type {number} */ (f.speedMs) > 0.3 ? /** @type {number} */ (f.speedMs) : along;
                if (mode !== "snap") {
                    // joining the route: start from where the arrow is now, on the road
                    const from = disp ? project(route, disp.lat, disp.lng, seg) : null;
                    sDisp = from && from.offM <= o.snapM * 2 ? from.s : p.s;
                }
                if (p.s < sDisp - o.backJumpM) sDisp = p.s;      // really behind: go there
                sFix = p.s; tFix = f.t; v = Math.min(70, speed);
                mode = "snap"; glide = null;
            } else {
                // off the route: glide from where the arrow is to the fix
                const here = disp || { lat: f.lat, lng: f.lng };
                glide = { from: { ...here }, to: { lat: f.lat, lng: f.lng }, t0: f.t, dur: Math.max(300, Math.min(o.freeGlideMs * 1.5, dt)) };
                if (metres(here.lat, here.lng, f.lat, f.lng) >= 3) course = bearing(here.lat, here.lng, f.lat, f.lng);
                mode = "free";
            }
        }
        /** @param {number} t @returns {{ lat: number, lng: number, bearing: number|null, s: number|null, onRoute: boolean }|null} */
        function frame(t) {
            const dt = tLast ? Math.max(0, Math.min(200, t - tLast)) : 16;
            tLast = t;
            if (mode === "snap") {
                const ahead = sFix + v * Math.min(o.extrapolateMs, Math.max(0, t - tFix)) / 1000;
                const target = Math.min(route.length, ahead);
                // catch up smoothly, never backwards (GPS shimmer); a real jump back was taken in fix()
                if (target > sDisp) sDisp += (target - sDisp) * (1 - Math.exp(-dt / o.tauMs));
                const p = pointAt(route, sDisp);
                const b = bearingAt(route, sDisp);
                if (b != null) course = b;
                disp = { lat: p.lat, lng: p.lng };
                return { lat: p.lat, lng: p.lng, bearing: course, s: sDisp, onRoute: true };
            }
            if (mode === "free" && glide) {
                const f = Math.max(0, Math.min(1, (t - glide.t0) / glide.dur));
                const e = f * (2 - f);                              // ease out
                disp = { lat: glide.from.lat + (glide.to.lat - glide.from.lat) * e, lng: glide.from.lng + (glide.to.lng - glide.from.lng) * e };
                return { lat: disp.lat, lng: disp.lng, bearing: course, s: null, onRoute: false };
            }
            return null;
        }
        /** A new route (reroute): the arrow keeps its place and joins the new line from there. @param {ReturnType<typeof index>} next */
        function setRoute(next) {
            // where the arrow is now (on the old road, mid-glide too)
            const here = mode === "snap" ? pointAt(route, sDisp) : disp;
            route = next; seg = 0;
            if (mode === "snap") mode = "none";
            if (here) {
                const p = project(route, here.lat, here.lng);
                if (p && p.offM <= o.snapM) { sDisp = p.s; sFix = p.s; seg = p.seg; mode = "snap"; tFix = tLast; v = 0; }
                else if (!disp) disp = { lat: here.lat, lng: here.lng };
            }
        }
        return { fix, frame, setRoute, get mode() { return mode; }, get s() { return mode === "snap" ? sDisp : null; }, /** the speed it glides at, m/s */ get v() { return mode === "snap" ? v : 0; } };
    }

    /**
     * Zoom by speed (closer in town, further out at speed), and close in near a turn, like a car navigator.
     * @param {number} speedMs @param {number|null} toTurnM metres to the next turn along the route @param {number|null} prevZoom
     * @param {(v: number, prev: number|null) => number} bySpeed the camera's own speed bands (navcam-core zoomForSpeed)
     */
    function zoomFor(speedMs, toTurnM, prevZoom, bySpeed, o = DEFAULTS) {
        const z = bySpeed(speedMs, prevZoom);
        if (toTurnM == null || !Number.isFinite(toTurnM) || toTurnM < 0) return z;
        const near = Math.max(o.turnMinM, Math.min(o.turnMaxM, (Number.isFinite(speedMs) ? speedMs : 0) * o.turnLeadS));
        return toTurnM <= near ? Math.max(z, o.turnZoom) : z;
    }

    /**
     * The white arrow drawn on the road through a turn: a shaft along the route from before the turn to after it,
     * and a head at its end pointing the way the road goes. Lengths grow when zoomed out so it reads the same size.
     * @param {ReturnType<typeof index>} ix @param {number} sTurn @param {number} zoom @param {number} metresPerPx
     * @returns {{ shaft: number[][], head: number[][] }|null}
     */
    function turnArrow(ix, sTurn, zoom, metresPerPx, o = DEFAULTS) {
        if (ix.line.length < 2 || !Number.isFinite(sTurn)) return null;
        const k = Math.pow(2, Math.max(0, 18 - zoom));
        const a = Math.max(0, sTurn - o.arrowBeforeM * k), b = Math.min(ix.length, sTurn + o.arrowAfterM * k);
        if (b - a < 5) return null;
        const shaft = slice(ix, a, b);
        const end = shaft[shaft.length - 1];
        const dir = bearingAt(ix, b, Math.min(12 * k, b - a), 0) ?? bearingAt(ix, b);
        if (dir == null) return { shaft, head: [] };
        const len = 24 * metresPerPx, half = 16 * metresPerPx;      // px on screen: a head clearly wider than the road
        const tip = offset(end[0], end[1], dir, len * 0.6), base = offset(end[0], end[1], dir, -len * 0.4);
        const left = offset(base[0], base[1], dir - 90, half), right = offset(base[0], base[1], dir + 90, half);
        return { shaft, head: [left, tip, right] };
    }

    /** Metres per screen pixel at a latitude and zoom (Web Mercator, 256 px tiles). @param {number} lat @param {number} zoom */
    const metresPerPx = (lat, zoom) => 156543.03392 * Math.cos(lat * RAD) / Math.pow(2, zoom);

    return { DEFAULTS, index, project, pointAt, bearingAt, slice, segAt, createMotion, zoomFor, turnArrow, metresPerPx, metres, bearing, angleDiff };
});
