// @ts-check
/* ============================================================================
   MapUnite navigation camera — the maths (pure, no DOM, no Leaflet)
   ==============================================================================
   While a route is being driven the map behaves like a car navigator:
     - heading-up: the direction of travel always points up the screen;
     - pitched: the road ahead recedes into the distance (a CSS 3D tilt);
     - the rider sits in the lower third of the VISIBLE map (between the turn
       banner and the drive panel), so most of the screen shows the road ahead.

   Leaflet only draws a flat, north-up map. navcam.js draws it into an
   oversized square around the rider and turns that square with one CSS
   transform: perspective(P) rotateX(pitch) rotateZ(-bearing), about the
   rider's point. This file works out the numbers for it:

   courseFrom()   which direction is "ahead": the GPS course while moving
                  (≥ 2.5 m/s; slower, a phone's course is noise), else the
                  route's direction where the rider is on it, else the last
                  ~8 m of movement, else the previous course.
   stepBearing()  turns the map smoothly toward that course (time constant
                  0.6 s, never more than 90°/s), the short way round.
   zoomForSpeed() closer in town, further out at speed, with hysteresis so it
                  doesn't pump at a band edge.
   geometry()     where the rider sits on screen, and how far the drawn map must
                  reach ahead, behind and to the sides for the tilted view.
   box()          the drawn rectangle for the current heading: only what the camera
                  sees, turned into the map's north-up frame and widened to cover a
                  15° band of headings, so it's re-measured only when the heading
                  leaves the band. Far fewer tiles than a square that covers every
                  heading, and Leaflet (which loads nearest-the-centre first) starts
                  with the road AHEAD, where new tiles appear.

   These are display choices, not measurements: they're tuning values,
   named here and in DEFAULTS, so they can be changed in one place.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else /** @type {any} */ (root).MUNavCamCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const RAD = Math.PI / 180;

    const DEFAULTS = Object.freeze({
        pitchDeg: 50,            // the tilt; asked for 45–60°
        perspective: 1.1,        // camera distance, × viewport height: smaller = stronger 3D
        anchorFrac: 2 / 3,       // the rider, from the top of the visible map: the bottom third
        maxAheadPx: 1100,        // never draw further ahead than this (map px); beyond it the sky shows
        underBannerPx: 40,       // the map reaches this far up under the (glass) turn banner; above, the sky band.
                                 // Drawing all the way to the screen's top edge needs ~1.75× the tiles for a strip
                                 // the banner covers anyway (measured in Chromium: 132–163 tiles vs ~70).
        marginPx: 64,            // slack round the edge, so a fast turn never shows a corner
        gpsMinSpeedMs: 2.5,      // below this a phone's GPS course is too noisy to steer the map
        moveMinM: 8,             // movement needed to take a course from two fixes
        bearingTauMs: 600,       // how quickly the map turns to the new course
        bearingMaxDegS: 90,      // and never faster than this
        deadbandDeg: 2           // smaller changes are ignored (GPS shimmer)
    });

    /** Signed shortest turn from a to b, in (-180, 180]. @param {number} a @param {number} b */
    function angleDiff(a, b) {
        const d = ((b - a) % 360 + 540) % 360 - 180;
        return d === -180 ? 180 : d;
    }
    /** @param {number} a */
    const norm = (a) => ((a % 360) + 360) % 360;

    /** Initial bearing from one point to another, degrees clockwise from north. @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 */
    function bearing(lat1, lng1, lat2, lng2) {
        const y = Math.sin((lng2 - lng1) * RAD) * Math.cos(lat2 * RAD);
        const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lng2 - lng1) * RAD);
        return norm(Math.atan2(y, x) / RAD);
    }
    /** Great-circle distance, metres. @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 */
    function metres(lat1, lng1, lat2, lng2) {
        const dLat = (lat2 - lat1) * RAD, dLng = (lng2 - lng1) * RAD;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
        return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    /**
     * The route's direction where the rider is: the nearest segment within maxOffM,
     * looking aheadM along the route so a kink in the line doesn't swing the map.
     * @param {Array<ArrayLike<number>>} path [[lat, lng], …] @param {number} lat @param {number} lng
     * @returns {number|null} degrees, or null when off the route
     */
    function routeBearing(path, lat, lng, maxOffM = 40, aheadM = 30) {
        if (!Array.isArray(path) || path.length < 2) return null;
        const kx = Math.cos(lat * RAD) * 111320, ky = 110540;     // local metres per degree, fine at this scale
        let best = -1, bestD = Infinity, bestT = 0;
        for (let i = 0; i < path.length - 1; i++) {
            const ax = (path[i][1] - lng) * kx, ay = (path[i][0] - lat) * ky;
            const bx = (path[i + 1][1] - lng) * kx, by = (path[i + 1][0] - lat) * ky;
            const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
            const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
            const d = Math.hypot(ax + t * dx, ay + t * dy);
            if (d < bestD) { bestD = d; best = i; bestT = t; }
        }
        if (best < 0 || bestD > maxOffM) return null;
        // walk aheadM from the projected point
        const p = path[best], q = path[best + 1];
        let fromLat = p[0] + (q[0] - p[0]) * bestT, fromLng = p[1] + (q[1] - p[1]) * bestT;
        let left = aheadM, i = best + 1, toLat = q[0], toLng = q[1];
        let seg = metres(fromLat, fromLng, toLat, toLng);
        while (seg < left && i < path.length - 1) { left -= seg; i++; toLat = path[i][0]; toLng = path[i][1]; seg = metres(path[i - 1][0], path[i - 1][1], toLat, toLng); }
        if (metres(fromLat, fromLng, toLat, toLng) < 0.5) return bearing(p[0], p[1], q[0], q[1]);
        return bearing(fromLat, fromLng, toLat, toLng);
    }

    /**
     * Which way is ahead.
     * @param {{ gpsHeading?: number|null, speedMs?: number, routeBearing?: number|null, moveBearing?: number|null, moveM?: number }} s
     * @param {number|null} last @param {typeof DEFAULTS} [o]
     * @returns {{ deg: number|null, source: "gps"|"route"|"movement"|"last"|"none" }}
     */
    function courseFrom(s, last, o = DEFAULTS) {
        const ok = (/** @type {any} */ v) => typeof v === "number" && Number.isFinite(v);
        if (ok(s.gpsHeading) && ok(s.speedMs) && /** @type {number} */ (s.speedMs) >= o.gpsMinSpeedMs) return { deg: norm(/** @type {number} */ (s.gpsHeading)), source: "gps" };
        if (ok(s.routeBearing)) return { deg: norm(/** @type {number} */ (s.routeBearing)), source: "route" };
        if (ok(s.moveBearing) && ok(s.moveM) && /** @type {number} */ (s.moveM) >= o.moveMinM) return { deg: norm(/** @type {number} */ (s.moveBearing)), source: "movement" };
        if (ok(last)) return { deg: norm(/** @type {number} */ (last)), source: "last" };
        return { deg: null, source: "none" };
    }

    /**
     * One animation step of the map's bearing toward the target, the short way round.
     * @param {number} current @param {number} target @param {number} dtMs @param {typeof DEFAULTS} [o]
     */
    function stepBearing(current, target, dtMs, o = DEFAULTS) {
        const d = angleDiff(current, target);
        if (Math.abs(d) < 0.05) return norm(target);
        const k = 1 - Math.exp(-Math.max(0, dtMs) / o.bearingTauMs);
        const maxStep = o.bearingMaxDegS * Math.max(0, dtMs) / 1000;
        const step = Math.max(-maxStep, Math.min(maxStep, d * k));
        return norm(current + step);
    }

    /** Should a new course replace the target? Ignores shimmer under the deadband. @param {number|null} target @param {number} course @param {typeof DEFAULTS} [o] */
    function shouldRetarget(target, course, o = DEFAULTS) {
        return target == null || Math.abs(angleDiff(target, course)) >= o.deadbandDeg;
    }

    /**
     * Zoom for the speed: 18 up to 30 km/h, 17 up to 60 km/h, 16 above, ±1.5 m/s hysteresis.
     * @param {number} speedMs @param {number|null} prevZoom
     */
    function zoomForSpeed(speedMs, prevZoom) {
        const bands = [{ z: 18, upTo: 8.33 }, { z: 17, upTo: 16.67 }, { z: 16, upTo: Infinity }];
        const H = 1.5;
        if (!Number.isFinite(speedMs)) return prevZoom != null && bands.some((b) => b.z === prevZoom) ? prevZoom : bands[0].z;   // unknown speed: keep
        const v = Math.max(0, speedMs);
        const plain = bands.find((b) => v <= b.upTo).z;
        if (prevZoom == null || !bands.some((b) => b.z === prevZoom)) return plain;
        const cur = bands.find((b) => b.z === prevZoom);
        const lower = bands[bands.indexOf(cur) - 1];                 // the closer-in band
        if (v > cur.upTo + H) return plain;                          // clearly faster: zoom out
        if (lower && v < lower.upTo - H) return plain;               // clearly slower: zoom in
        return prevZoom;
    }

    /**
     * Where the rider sits and how big the drawn square must be.
     * @param {{ vw: number, vh: number, top?: number, bottom?: number, pitchDeg?: number, flat?: boolean }} v
     *   top/bottom: the visible map between the turn banner and the drive panel (px from the top)
     * @param {typeof DEFAULTS} [o]
     * @returns {{ ax: number, ay: number, radius: number, perspective: number, pitchDeg: number, horizonY: number, aheadPx: number, region: { hw: number, ahead: number, behind: number } }}
     */
    function geometry(v, o = DEFAULTS) {
        const vw = Math.max(1, v.vw), vh = Math.max(1, v.vh);
        const top = Number.isFinite(v.top) ? Math.max(0, Math.min(vh, /** @type {number} */ (v.top))) : 0;
        let bottom = Number.isFinite(v.bottom) ? Math.max(0, Math.min(vh, /** @type {number} */ (v.bottom))) : vh;
        if (bottom - top < 120) bottom = Math.min(vh, top + 120);       // a cramped layout still leaves the rider on screen
        const ax = vw / 2;
        const ay = Math.round(top + o.anchorFrac * (bottom - top));
        const pitchDeg = v.flat ? 0 : (Number.isFinite(v.pitchDeg) ? /** @type {number} */ (v.pitchDeg) : o.pitchDeg);
        const th = pitchDeg * RAD, P = Math.round(o.perspective * vh);
        // how far up the map must reach on screen: to just under the turn banner, or the whole screen when flat
        const up = v.flat ? ay : Math.max(1, ay - Math.max(0, top - o.underBannerPx)), down = vh - ay;
        // plane distance (map px) that lands on the screen's top edge; ∞ when the horizon is below the top
        const denom = P * Math.cos(th) - up * Math.sin(th);
        const aheadPx = Math.min(o.maxAheadPx, denom > 0 ? (up * P) / denom : Infinity, v.flat ? up : Infinity);
        const ys = (aheadPx * Math.cos(th) * P) / (P + aheadPx * Math.sin(th));
        const horizonY = Math.max(0, Math.round(ay - ys));
        const halfWideFar = (vw / 2) * (P + aheadPx * Math.sin(th)) / P;
        const behindPx = (down * P) / (P * Math.cos(th) + down * Math.sin(th));
        const radius = Math.ceil(Math.max(Math.hypot(halfWideFar, aheadPx), Math.hypot(vw / 2, behindPx), v.flat ? Math.hypot(vw / 2, up) : 0) + o.marginPx);
        // the region the camera sees, in the heading-up frame, from the rider (map px), with the slack added
        const m = o.marginPx;
        const region = { hw: Math.ceil(Math.max(halfWideFar, vw / 2) + m), ahead: Math.ceil(aheadPx + m), behind: Math.ceil(Math.max(behindPx, v.flat ? down : 0) + m) };
        return { ax, ay, radius, perspective: P, pitchDeg, horizonY, aheadPx: Math.round(aheadPx), region };
    }

    /**
     * The drawn rectangle in the map's north-up frame for a heading: covers what the camera sees for
     * every bearing in the 15° band around this one. ox/oy: where the rider is inside it.
     * Display = rotateZ(-bearing)(map), so a map offset is the display offset turned by +bearing.
     * @param {{ region: { hw: number, ahead: number, behind: number } }} g @param {number} bearingDeg
     * @returns {{ band: number, w: number, h: number, ox: number, oy: number }}
     */
    function box(g, bearingDeg, bandDeg = 15) {
        const { hw, ahead, behind } = g.region;
        const band = (Math.round(norm(bearingDeg) / bandDeg) * bandDeg) % 360;
        const corners = [[-hw, -ahead], [hw, -ahead], [hw, behind], [-hw, behind]];
        let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
        for (const a of [band - bandDeg / 2 - 1, band - bandDeg / 4, band, band + bandDeg / 4, band + bandDeg / 2 + 1]) {
            const c = Math.cos(a * RAD), sn = Math.sin(a * RAD);
            for (const [x, y] of corners) {
                const mx = x * c - y * sn, my = x * sn + y * c;
                if (mx < minx) minx = mx; if (mx > maxx) maxx = mx;
                if (my < miny) miny = my; if (my > maxy) maxy = my;
            }
        }
        return { band, w: Math.ceil(maxx - minx), h: Math.ceil(maxy - miny), ox: Math.ceil(-minx), oy: Math.ceil(-miny) };
    }

    /** The CSS transform for the drawn square, about the rider's point. @param {{ perspective: number, pitchDeg: number }} g @param {number} bearingDeg */
    function cssTransform(g, bearingDeg) {
        const b = Math.round(norm(bearingDeg) * 100) / 100;
        return g.pitchDeg > 0 ? `perspective(${g.perspective}px) rotateX(${g.pitchDeg}deg) rotateZ(${-b}deg)` : `rotateZ(${-b}deg)`;
    }

    return { DEFAULTS, angleDiff, bearing, metres, routeBearing, courseFrom, stepBearing, shouldRetarget, zoomForSpeed, geometry, box, cssTransform };
});
