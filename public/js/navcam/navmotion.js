/* ============================================================================
   MapUnite navigation motion — the arrow, the route ahead and the camera, every frame
   ==============================================================================
   NavMotion.start({ map, route, puck, ahead, casing, turn })   when a drive starts (js/navigation.js)
   NavMotion.fix(lat, lng, speedMs, estimated)               every fix / dead-reckoned estimate
   NavMotion.reroute()                                       the route changed
   NavMotion.stop()                                          the drive ended

   Like a car navigator, between fixes that come about once a second:
     - the rider's arrow glides along the road every frame (on the route it is
       held to the road; off it, it follows the fixes) and points the way the
       road goes; it lies flat on the map, tilted with it;
     - the camera moves with the arrow, frame by frame (NavCamera.frame), so
       arrow and map never drift apart;
     - the route ahead starts at the arrow: what's behind it is gone;
     - near a turn the camera zooms in and a white arrow is drawn on the road
       through the turn; after it, back out.
   The maths is in navmotion-core.js (tested on its own). Nothing here touches
   the Maps script tag or an existing element id.
   ============================================================================ */
"use strict";

const NavMotion = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    const C = W ? W.MUNavMotionCore : null;
    if (!W || !C || typeof W.L === "undefined") return { start: () => false, fix() {}, reroute() {}, stop() {}, get active() { return false; } };
    const L = W.L;
    const CAM = () => (typeof NavCamera !== "undefined" && NavCamera.active ? NavCamera : null);
    const camCore = () => W.MUNavCamCore || null;
    const reduceMotion = () => { try { return W.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };

    let on = false, raf = 0;
    /** @type {any} */ let o = null;
    /** @type {any} */ let ix = null, motion = null;
    let speed = 0, lastCut = -1, lastCutT = 0, lastRoute = null;
    /** @type {{ key: string, s: number }|null} */ let turnAt = null;
    /** @type {any} */ let arrow = null;               // { casing, shaft, head, key }
    let zoomNow = null;

    function puckEl() { const el = o && o.puck && typeof o.puck.getElement === "function" ? o.puck.getElement() : null; return el; }

    /** Where the next turn is along the route (metres), from the maneuver point; cached per turn. */
    function turnS() {
        const ll = o.turn ? o.turn() : null;
        if (!ll || !ix) { turnAt = null; return null; }
        const key = `${ll[0].toFixed(6)},${ll[1].toFixed(6)}:${ix.length}`;
        if (!turnAt || turnAt.key !== key) { const p = C.project(ix, ll[0], ll[1]); turnAt = p && p.offM < 60 ? { key, s: p.s } : { key, s: NaN }; }
        return Number.isFinite(turnAt.s) ? turnAt.s : null;
    }

    function clearArrow() {
        if (arrow) { for (const l of [arrow.casing, arrow.shaft, arrow.head]) if (l) o.map.removeLayer(l); }
        arrow = null;
    }
    /** The white arrow on the road through the next turn, drawn while it's near and until just after it. */
    function drawArrow(sTurn, toTurn, lat) {
        const z = o.map.getZoom();
        const showM = Math.max(200, Math.min(500, speed * 15));
        if (sTurn == null || toTurn > showM || toTurn < -C.DEFAULTS.arrowAfterM * Math.pow(2, Math.max(0, 18 - z))) { clearArrow(); return; }
        const key = `${Math.round(sTurn)}:${z}`;
        if (arrow && arrow.key === key) return;
        clearArrow();
        const g = C.turnArrow(ix, sTurn, z, C.metresPerPx(lat, z));
        if (!g) return;
        const pane = o.map.getPane("mu-turnarrow") ? "mu-turnarrow" : "overlayPane";
        arrow = {
            key,
            casing: L.polyline(g.shaft, { pane, color: "#0b3a7a", weight: 15, opacity: 0.9, lineCap: "butt", lineJoin: "round", interactive: false }).addTo(o.map),
            shaft: L.polyline(g.shaft, { pane, color: "#ffffff", weight: 9, opacity: 1, lineCap: "butt", lineJoin: "round", interactive: false }).addTo(o.map),
            head: g.head.length ? L.polygon(g.head, { pane, color: "#0b3a7a", weight: 3, fillColor: "#ffffff", fillOpacity: 1, opacity: 0.9, interactive: false }).addTo(o.map) : null
        };
    }

    /** The route ahead starts at the arrow (a few times a second: the arrow covers the gap meanwhile). */
    function cutRoute(s, t) {
        if (s == null || !o.ahead) return;
        if (Math.abs(s - lastCut) < 3 && t - lastCutT < 1000) return;
        if (t - lastCutT < 200 && Math.abs(s - lastCut) < 30) return;
        lastCut = s; lastCutT = t;
        const rest = C.slice(ix, s, ix.length);
        if (rest.length < 2) return;
        o.ahead.setLatLngs(rest);
        if (o.casing) o.casing.setLatLngs(rest);
    }

    // the map's own "you are here" dot, its accuracy circle and the location-history trail: hidden while the
    // navigation arrow shows the rider (one arrow on the road, like a car navigator), back when the drive ends
    let lastHideT = 0;
    function hideOthers(t) {
        if (t - lastHideT < 1000) return;
        lastHideT = t;
        const layers = [];
        // globals of core.js / gps.js / deadreckoning.js (classic scripts share them by name)
        try { if (typeof ownMarker !== "undefined") layers.push(ownMarker); } catch (e) { /* not loaded */ }
        try { if (typeof accuracyCircle !== "undefined") layers.push(accuracyCircle); } catch (e) { /* not loaded */ }
        try { if (typeof historyPolyline !== "undefined") layers.push(historyPolyline); } catch (e) { /* not loaded */ }
        try { if (typeof uncertaintyEllipse !== "undefined") layers.push(uncertaintyEllipse); } catch (e) { /* not loaded */ }
        for (const l of layers) {
            const el = l && typeof l.getElement === "function" ? l.getElement() : null;
            if (el) el.classList.add("mu-nav-hide");
        }
    }

    function loop(t) {
        raf = 0;
        if (!on) return;
        hideOthers(t);
        const d = motion.frame(t);
        if (d) {
            o.puck.setLatLng([d.lat, d.lng]);
            if (window.__navmotionLog) window.__navmotionLog.push({ t, s: d.s, mode: motion.mode });
            const el = puckEl();
            if (el && d.bearing != null) el.style.setProperty("--mu-puck-deg", `${Math.round(d.bearing * 10) / 10}deg`);
            if (d.onRoute) cutRoute(d.s, t);
            const sT = d.onRoute ? turnS() : null;
            const toTurn = sT != null && d.s != null ? sT - d.s : null;
            const cc = camCore();
            const cam = CAM();
            if (cam && cc) {
                const z = C.zoomFor(speed, toTurn, cam.zoom ?? zoomNow, cc.zoomForSpeed);
                zoomNow = z;
                cam.frame({ lat: d.lat, lng: d.lng, bearingDeg: d.bearing, zoom: z }, t);
            }
            drawArrow(sT, toTurn == null ? Infinity : toTurn, d.lat);
        }
        raf = requestAnimationFrame(loop);
    }

    /**
     * @param {{ map: any, route: () => number[][], puck: any, ahead?: any, casing?: any, turn?: () => number[]|null }} opts
     */
    function start(opts) {
        stop();
        if (!opts || !opts.map || !opts.puck || typeof opts.route !== "function") return false;
        o = opts;
        lastRoute = o.route();
        ix = C.index(lastRoute || []);
        if (ix.line.length < 2) return false;
        motion = C.createMotion(ix);
        if (!o.map.getPane("mu-turnarrow")) { const p = o.map.createPane("mu-turnarrow"); p.style.zIndex = "455"; p.style.pointerEvents = "none"; }
        const el = puckEl();
        if (el) el.classList.add("mu-puck-on");
        on = true; speed = 0; lastCut = -1; lastCutT = 0; turnAt = null; zoomNow = null; lastHideT = 0;
        document.body.classList.add("mu-navmotion");
        const ll = o.puck.getLatLng ? o.puck.getLatLng() : null;
        if (ll) motion.fix({ lat: ll.lat, lng: ll.lng, speedMs: 0, t: performance.now() });
        raf = requestAnimationFrame(loop);
        return true;
    }
    /** A fix or an estimate. @param {number} lat @param {number} lng @param {number} speedMs @param {boolean} [estimated] */
    function fix(lat, lng, speedMs, estimated) {
        if (!on) return;
        if (o.route() !== lastRoute) reroute();
        motion.fix({ lat, lng, speedMs: Number.isFinite(speedMs) ? speedMs : null, t: performance.now() });
        // the phone's speed, or (none reported) the speed the fixes show along the road
        speed = Number.isFinite(speedMs) && speedMs > 0.3 ? speedMs : motion.v;
        if (reduceMotion()) { const d = motion.frame(performance.now() + 5000); if (d) o.puck.setLatLng([d.lat, d.lng]); }
        const el = puckEl();
        if (el) el.classList.toggle("dr-est", Boolean(estimated));
    }
    function reroute() {
        if (!on) return;
        lastRoute = o.route();
        ix = C.index(lastRoute || []);
        motion.setRoute(ix);
        turnAt = null; lastCut = -1; clearArrow();
        if (o.ahead && ix.line.length > 1) { o.ahead.setLatLngs(ix.line); if (o.casing) o.casing.setLatLngs(ix.line); }
    }
    function stop() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (o) clearArrow();
        if (typeof document !== "undefined") document.body.classList.remove("mu-navmotion");
        on = false;
    }

    return { start, fix, reroute, stop, get active() { return on; }, state: () => ({ on, mode: motion ? motion.mode : null, s: motion ? motion.s : null, speed, zoom: zoomNow, arrow: Boolean(arrow) }) };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).NavMotion = NavMotion;
