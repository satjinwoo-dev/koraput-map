/* ============================================================================
   MapUnite navigation camera — heading-up, 3D tilt, rider in the lower third
   ==============================================================================
   NavCamera.start({ map, route })   when a drive starts (js/navigation.js)
   NavCamera.follow({ lat, lng, speedMs, headingDeg })   every fix / estimate
   NavCamera.frame({ lat, lng, bearingDeg, zoom }, t)    every frame, from navmotion.js (then
                                     follow() isn't used: the map moves with the drawn arrow)
   NavCamera.stop()                  when the drive ends

   HOW: Leaflet draws a flat, north-up map. While the camera is on, #map is
   resized to exactly what the tilted camera sees for the current heading (a
   rectangle reaching far ahead, re-measured when the heading leaves its 15° band),
   placed so the rider sits on their spot on screen, and turned with one CSS
   transform about that spot: perspective · rotateX(pitch) · rotateZ(-bearing).
   The maths (which way is ahead, how fast to turn, zoom, sizes) is in
   navcam-core.js and tested on its own.

   NO BLACK HORIZON: a tilted map needs many more tiles than a flat one, and a phone
   fetches a handful at a time, nearest first, so the far road (the top of the
   screen) used to show the dark background until its tiles came. Now:
     - a low-resolution UNDERLAY of the same map (zoom 15, scaled up) sits under
       the sharp tiles: 1–4 tiles cover the whole tilted plane at once, so a gap
       is a slightly blurry patch for a moment, never black;
     - the drawn area is only what the camera sees (2–4× fewer tiles than a square
       for every heading), and its centre is AHEAD of the rider, so Leaflet loads
       the road ahead first;
     - the sharp layer keeps a wider ring of loaded tiles (keepBuffer 4) while the
       camera is on, so turning doesn't throw away what's loaded;
     - the map is drawn all the way to the screen's top edge, under the glass
       turn banner, like Google Maps' navigation: the tilt is lowered a little on a
       tall screen instead of letting the horizon (and a dark sky) show. The sky
       band is only a fallback if even the lowest tilt can't fill the screen; the
       map's own background is ground-coloured, not black.

   Markers stay readable: each marker's content is turned back by the same
   bearing and stretched by 1/cos(pitch), so it stands upright facing the
   rider instead of lying flat. Tooltips and popups are hidden while the
   camera is on (they'd be sideways); they come back when it's off.

   TOUCHING THE MAP hands it back: the view goes flat and north-up at once
   (so a drag moves the map under the finger, not at an angle), and a
   "Re-centre" button brings the camera back. The compass switches between
   heading-up 3D and north-up 2D; the choice is remembered on this phone
   (localStorage "mu.navcam.v1").

   Nothing here touches the Maps script tag or any existing element id; the
   two buttons and the sky band are added by this file.
   ============================================================================ */
"use strict";

const NavCamera = (() => {
    const C = typeof window !== "undefined" ? window.MUNavCamCore : null;
    const KEY = "mu.navcam.v1";
    const PAN_S = 0.9;                      // glide between 1 Hz fixes instead of jumping

    /** @type {any} */ let lmap = null;
    let routeFn = () => null;
    let on = false, paused = false, headingUp = true;
    let bearing = 0, target = null, course = null, zoom = null;
    let user = null, lastMoveFrom = null;
    let geom = null, applied = null;        // the geometry now on #map; applied: the box (w, h, ox, oy, band) and anchor
    const UNDERLAY_ZOOM = 15;               // the underlay's tiles: one covers 16× the ground of a zoom-17 tile
    /** @type {any} */ let underlay = null;
    /** @type {Array<[any, number]>} */ let boosted = [];
    let raf = 0, lastT = 0;
    const els = {};
    const reduceMotion = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };

    function load() { try { const s = JSON.parse(localStorage.getItem(KEY) || "{}"); headingUp = s.headingUp !== false; } catch (e) { headingUp = true; } }
    function save() { try { localStorage.setItem(KEY, JSON.stringify({ headingUp })); } catch (e) { /* private mode */ } }

    function supported() {
        return Boolean(C && typeof L !== "undefined" && typeof CSS !== "undefined" && CSS.supports && CSS.supports("transform", "perspective(100px) rotateX(10deg)"));
    }

    // ---------------------------------------------------------------- layout
    const visible = (el) => { if (!el || el.hidden) return null; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none" ? r : null; };
    /** The visible map: under the turn banner, above the speed dial / HUD / drive panel. */
    function obstacles() {
        const vh = window.innerHeight;
        const banner = visible(document.getElementById("turn-banner"));
        let top = banner ? banner.bottom : 0;
        let bottom = vh;
        for (const id of ["speed-dial", "smartdrive-hud", "nav-bottom-sheet"]) {
            const r = visible(document.getElementById(id));
            if (r && r.top > top + 60) bottom = Math.min(bottom, r.top);
        }
        return { top, bottom };
    }

    function ensureUi() {
        if (els.compass) return;
        els.sky = document.createElement("div");
        els.sky.id = "navcam-sky";
        els.sky.setAttribute("aria-hidden", "true");
        els.compass = document.createElement("button");
        els.compass.id = "navcam-compass";
        els.compass.type = "button";
        els.compass.innerHTML = '<span class="navcam-needle" aria-hidden="true"><span class="n">N</span></span>';
        els.compass.addEventListener("click", (e) => { e.stopPropagation(); toggleHeadingUp(); });
        els.recenter = document.createElement("button");
        els.recenter.id = "navcam-recenter";
        els.recenter.type = "button";
        els.recenter.innerHTML = '<span class="navcam-arrow" aria-hidden="true"></span>Re-centre';
        els.recenter.addEventListener("click", (e) => { e.stopPropagation(); resume(); });
        document.body.append(els.sky, els.compass, els.recenter);
    }
    function placeUi(ob) {
        if (!els.compass) return;
        els.compass.style.top = `${Math.round(ob.top + 12)}px`;
        els.recenter.style.top = `${Math.round(Math.max(ob.top + 64, ob.bottom - 56))}px`;
        els.compass.hidden = !on;
        els.recenter.hidden = !(on && paused);
        els.compass.setAttribute("aria-label", headingUp ? "Heading up, 3D. Tap for north up." : "North up. Tap for heading up, 3D.");
        els.compass.classList.toggle("north", !headingUp);
        const tilted = on && !paused && geom && geom.pitchDeg > 0;
        // a fallback only: geometry() fits the tilt so the map reaches the top edge (horizonY 0)
        els.sky.hidden = !tilted || !(geom.horizonY > 0);
        if (!els.sky.hidden) els.sky.style.height = `${geom.horizonY + 56}px`;
    }

    // ---------------------------------------------------------------- the transform
    const displayBearing = () => (headingUp ? bearing : 0);

    /** The map centre that puts this point on the rider's spot (ox, oy) in the drawn box. @param {{ lat: number, lng: number }} ll @param {number} z */
    function viewCenter(ll, z) {
        if (!applied) return L.latLng(ll.lat, ll.lng);
        const p = lmap.project(L.latLng(ll.lat, ll.lng), z).add(L.point(applied.w / 2 - applied.ox, applied.h / 2 - applied.oy));
        return lmap.unproject(p, z);
    }
    /** Size #map for the current layout, mode and heading band; returns true if Leaflet had to re-measure. */
    function layout() {
        const ob = obstacles();
        const o = headingUp ? C.DEFAULTS : { ...C.DEFAULTS, anchorFrac: 0.5 };
        geom = C.geometry({ vw: window.innerWidth, vh: window.innerHeight, top: ob.top, bottom: ob.bottom, flat: !headingUp }, o);
        placeUi(ob);
        const bx = C.box(geom, displayBearing());
        const same = applied && applied.band === bx.band && Math.abs(applied.w - bx.w) < 4 && Math.abs(applied.h - bx.h) < 4
            && Math.abs(applied.ax - geom.ax) < 2 && Math.abs(applied.ay - geom.ay) < 2;
        if (same) return false;
        // where the rider is drawn right now (mid-glide too), so the new box doesn't make the map jump
        const here = applied ? lmap.containerPointToLatLng([applied.ox, applied.oy]) : (user ? L.latLng(user.lat, user.lng) : null);
        const el = lmap.getContainer();
        Object.assign(el.style, { left: `${geom.ax - bx.ox}px`, top: `${geom.ay - bx.oy}px`, right: "auto", bottom: "auto",
            width: `${bx.w}px`, height: `${bx.h}px`, transformOrigin: `${bx.ox}px ${bx.oy}px` });
        el.classList.add("navcam");
        applied = { ...bx, ax: geom.ax, ay: geom.ay };
        lmap.invalidateSize({ pan: false, animate: false });
        if (here) lmap.setView(viewCenter(here, lmap.getZoom()), lmap.getZoom(), { animate: false });
        return true;
    }

    /** A low-resolution copy of the base map under it: covers the whole tilted view in a few tiles. */
    function addUnderlay() {
        removeUnderlay();
        /** @type {any} */ let base = null;
        // the base map, not the name labels drawn over the satellite view (muOverlay, js/core.js)
        const isBase = (/** @type {any} */ l) => l instanceof L.TileLayer && !l.options.muOverlay;
        lmap.eachLayer((/** @type {any} */ l) => { if (!base && isBase(l) && typeof l._url === "string") base = l; });
        if (!base) return;
        const o = base.options;
        underlay = L.tileLayer(base._url, {
            subdomains: o.subdomains, maxZoom: o.maxZoom, maxNativeZoom: Math.min(UNDERLAY_ZOOM, o.maxNativeZoom || o.maxZoom || UNDERLAY_ZOOM),
            zIndex: 0, keepBuffer: 1, attribution: "", className: "navcam-underlay", crossOrigin: o.crossOrigin
        }).addTo(lmap);
        // the sharp layer keeps a wider ring of tiles while the view turns
        lmap.eachLayer((/** @type {any} */ l) => { if (l !== underlay && isBase(l)) { boosted.push([l, l.options.keepBuffer]); l.options.keepBuffer = 4; } });
    }
    function removeUnderlay() {
        if (underlay && lmap) { try { lmap.removeLayer(underlay); } catch (e) { /* already gone */ } }
        underlay = null;
        for (const [l, kb] of boosted) l.options.keepBuffer = kb;
        boosted = [];
    }
    function paint() {
        if (!on || paused || !geom) return;
        const el = lmap.getContainer();
        const b = displayBearing();
        el.style.transform = C.cssTransform(geom, b);
        el.style.setProperty("--navcam-bearing", `${Math.round(b * 100) / 100}deg`);
        el.style.setProperty("--navcam-unpitch", String(Math.round(1000 / Math.cos(geom.pitchDeg * Math.PI / 180)) / 1000));
        el.style.setProperty("--navcam-course-rel", `${Math.round(((course == null ? b : course) - b) * 100) / 100}deg`);
        if (els.compass) els.compass.style.setProperty("--navcam-north", `${-b}deg`);
    }
    function restore() {
        const el = lmap && lmap.getContainer();
        if (!el) return;
        for (const p of ["left", "top", "right", "bottom", "width", "height", "transform", "transformOrigin"]) el.style[p] = "";
        for (const v of ["--navcam-bearing", "--navcam-unpitch", "--navcam-course-rel"]) el.style.removeProperty(v);
        el.classList.remove("navcam");
        applied = null;
        lmap.invalidateSize({ pan: false, animate: false });
    }

    function tick(t) {
        raf = 0;
        if (!on || paused) return;
        const dt = lastT ? Math.min(100, t - lastT) : 16;
        lastT = t;
        if (target != null) bearing = reduceMotion() ? target : C.stepBearing(bearing, target, dt);
        if (applied && geom && C.box(geom, displayBearing()).band !== applied.band) layout();   // a new 15° band: re-measure
        paint();
        if (target != null && Math.abs(C.angleDiff(bearing, target)) > 0.05) raf = requestAnimationFrame(tick);
        else lastT = 0;
    }
    const kick = () => { if (!raf && on && !paused) raf = requestAnimationFrame(tick); };

    // ---------------------------------------------------------------- touch hands the map back
    function onTouch(e) {
        if (!on || paused || !lmap) return;
        const el = lmap.getContainer();
        if (!el.contains(e.target) || (e.target.closest && e.target.closest(".leaflet-control"))) return;
        pause();
    }
    const onResize = () => { if (on && !paused) { layout(); paint(); } };

    // ---------------------------------------------------------------- API
    function start(o) {
        if (!supported() || !o || !o.map) return false;
        lmap = o.map;
        routeFn = typeof o.route === "function" ? o.route : () => null;
        load();
        ensureUi();
        on = true; paused = false;
        bearing = 0; target = null; course = null; zoom = null; lastMoveFrom = null;
        const at = o.at && Number.isFinite(o.at.lat) ? o.at : null;
        if (at) {
            user = { lat: at.lat, lng: at.lng };
            const rb = C.routeBearing(routeFn() || [], at.lat, at.lng);
            if (rb != null) { course = rb; target = rb; }
        }
        zoom = C.zoomForSpeed(0, null);
        document.addEventListener("pointerdown", onTouch, true);
        document.addEventListener("wheel", onTouch, { capture: true, passive: true });
        window.addEventListener("resize", onResize);
        addUnderlay();
        layout();
        if (user) lmap.setView(viewCenter(user, zoom), zoom, { animate: false });
        paint();
        kick();                                    // swings from north to the road's direction
        return true;
    }

    /** @param {{ lat: number, lng: number, speedMs?: number, headingDeg?: number|null }} f */
    function follow(f) {
        if (!on || !f || !Number.isFinite(f.lat) || !Number.isFinite(f.lng)) return;
        const speed = Number.isFinite(f.speedMs) ? f.speedMs : 0;
        let moveBearing = null, moveM = 0;
        if (lastMoveFrom) {
            moveM = C.metres(lastMoveFrom.lat, lastMoveFrom.lng, f.lat, f.lng);
            if (moveM >= C.DEFAULTS.moveMinM) moveBearing = C.bearing(lastMoveFrom.lat, lastMoveFrom.lng, f.lat, f.lng);
        }
        if (!lastMoveFrom || moveM >= C.DEFAULTS.moveMinM) lastMoveFrom = { lat: f.lat, lng: f.lng };
        const c = C.courseFrom({ gpsHeading: f.headingDeg, speedMs: speed, routeBearing: C.routeBearing(routeFn() || [], f.lat, f.lng), moveBearing, moveM }, course);
        if (c.deg != null) { course = c.deg; if (C.shouldRetarget(target, c.deg)) target = c.deg; }
        user = { lat: f.lat, lng: f.lng };
        const z = C.zoomForSpeed(speed, zoom);
        const zoomChanged = z !== zoom;
        zoom = z;
        if (paused) return;
        layout();                                  // the drive panel can grow or shrink
        if (zoomChanged) lmap.setView(viewCenter(f, zoom), zoom, { animate: !reduceMotion() });
        else lmap.setView(viewCenter(f, zoom), zoom, { pan: { animate: !reduceMotion(), duration: PAN_S, easeLinearity: 1 } });
        paint();
        kick();
    }

    /**
     * Every frame, from the navigation motion (navmotion.js): the arrow's drawn position, the road's direction
     * there and the zoom. The map moves with the arrow (no once-a-second glide) and turns with the road.
     * @param {{ lat: number, lng: number, bearingDeg?: number|null, zoom?: number|null }} f @param {number} t
     */
    let lastLayoutT = 0, lastMoveEndT = 0;
    function frame(f, t) {
        if (!on || !f || !Number.isFinite(f.lat) || !Number.isFinite(f.lng)) return;
        user = { lat: f.lat, lng: f.lng };
        if (f.bearingDeg != null && Number.isFinite(f.bearingDeg)) { course = f.bearingDeg; target = f.bearingDeg; }
        const z = f.zoom != null && Number.isFinite(f.zoom) ? f.zoom : zoom;
        if (paused) { zoom = z; return; }
        if (raf) { cancelAnimationFrame(raf); raf = 0; }   // this frame does the turning
        const dt = lastT ? Math.min(100, t - lastT) : 16;
        lastT = t;
        if (target != null) bearing = reduceMotion() ? target : C.stepBearing(bearing, target, dt);
        if (t - lastLayoutT > 500 || (applied && geom && C.box(geom, displayBearing()).band !== applied.band)) { lastLayoutT = t; layout(); }
        if (lmap._animatingZoom) { paint(); return; }
        if (z !== zoom) {
            zoom = z;
            lmap.setView(viewCenter(f, zoom), zoom, { animate: !reduceMotion() });
            paint();
            return;
        }
        const want = lmap.project(viewCenter(f, zoom), zoom), cur = lmap.project(lmap.getCenter(), zoom);
        const d = want.subtract(cur);
        if (Math.abs(d.x) > 2000 || Math.abs(d.y) > 2000 || typeof lmap._rawPanBy !== "function") lmap.setView(viewCenter(f, zoom), zoom, { animate: false });
        else if (Math.abs(d.x) + Math.abs(d.y) > 0.01) {
            // sub-pixel pan without an animation; "moveend" (tiles, vector redraw) a few times a second, not every frame
            lmap._rawPanBy(d);
            lmap.fire("move");
            if (t - lastMoveEndT > 250) { lastMoveEndT = t; lmap.fire("moveend"); }
        }
        paint();
    }

    function pause() {
        if (!on || paused) return;
        paused = true;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        lastT = 0;
        // where the rider is drawn becomes the centre of the flat map
        const center = applied ? lmap.containerPointToLatLng([applied.ox, applied.oy]) : lmap.getCenter();
        restore();
        lmap.setView(center, lmap.getZoom(), { animate: false });
        placeUi(obstacles());
    }
    function resume() {
        if (!on) return;
        paused = false;
        layout();
        if (user) lmap.setView(viewCenter(user, zoom || lmap.getZoom()), zoom || lmap.getZoom(), { animate: false });
        paint();
        placeUi(obstacles());
        kick();
    }
    function toggleHeadingUp() {
        headingUp = !headingUp;
        save();
        if (paused) { resume(); return; }
        applied = null;                            // a different anchor and size
        layout();
        paint();
        kick();
    }
    /** The base map changed mid-drive (Ride Focus AMOLED): copy the new one into the underlay. */
    function rebase() {
        if (!on || !lmap) return;
        addUnderlay();
    }
    function stop() {
        if (!on) return;
        on = false; paused = false;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        lastT = 0;
        document.removeEventListener("pointerdown", onTouch, true);
        document.removeEventListener("wheel", onTouch, true);
        window.removeEventListener("resize", onResize);
        removeUnderlay();
        restore();
        placeUi({ top: 0, bottom: 0 });
        if (els.sky) els.sky.hidden = true;
        geom = null;
    }

    return {
        start, follow, frame, stop, pause, resume, supported, toggleHeadingUp, rebase,
        get active() { return on; },
        get zoom() { return zoom; },
        /** The map's turn now (0 when north-up): the rider's arrow is drawn relative to it. */
        get bearing() { return on && !paused ? displayBearing() : 0; },
        get paused() { return paused; },
        /** For the console and tests. */
        state: () => ({ on, paused, headingUp, bearing: Math.round(bearing * 10) / 10, target, course, zoom, geom, box: applied, underlay: Boolean(underlay) })
    };
})();

if (typeof window !== "undefined") window.NavCamera = NavCamera;
