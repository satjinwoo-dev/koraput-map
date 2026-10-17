/* ============================================================================
   MapUnite Ride Focus AMOLED — an optional true-black map while navigating
   ==============================================================================
   Off by default. Turned on in Smart Drive Settings ("Ride Focus AMOLED") or
   with the ◐ button beside Stop during a drive; it takes effect at once, no
   restart, and the choice is remembered on this phone (localStorage
   "mu.ridefocus.v1"). It applies only while a drive is active: before and
   after, the map is the rider's own style (Satellite, Street, Dark, …).

   WHAT CHANGES (styling the existing layers, never an overlay on top):
     base map   the rider's style is swapped for CARTO's dark base without
                labels (the provider the Dark style already uses), with a CSS
                contrast filter on the TILES only: the near-black land goes to
                pure #000, roads stay as dim grey lines, so junctions and road
                geometry remain visible but quieter than the route. The map's
                own background is #000 where no tile has loaded yet.
     labels     CARTO's label layer on top, slightly dimmed (place and road
                names stay readable); the OSM places layer (js/mapdetail.js)
                keeps only the important kinds while driving.
     route      three looks that differ in WIDTH and FILL as well as colour:
                  this road, up to the next turn: widest, white core in a cyan
                  border;
                  the route after the turn: cyan, medium, black casing;
                  already ridden: dim grey (covers the route behind the rider).
     untouched  hazards and alerts (banner, voice, cards), the turn banner,
                markers, buttons, attribution: never dimmed.

   Raster tiles can't be restyled per road class (that needs vector tiles):
   "nearby roads dimmer than the route" comes from the dark base plus the
   filter, not from per-road styling. No battery figure is promised anywhere:
   true black can lower an AMOLED screen's power draw, how much depends on
   the screen, the brightness and what else the phone is doing.

   RideFocus.start({ map, ahead, trail, route, turn })   when a drive starts
   RideFocus.update(lat, lng)                            on every fix / estimate
   RideFocus.stop()                                      when the drive ends
   RideFocusCore: the pure part (splitting the route at the rider and the next
   turn), tested on its own (test/navcam/ridefocus.test.mjs).
   ============================================================================ */
"use strict";

const RideFocusCore = (() => {
    const RAD = Math.PI / 180;

    /** Local metres from a reference point. @param {number} lat0 */
    const proj = (lat0) => { const kx = Math.cos(lat0 * RAD) * 111320, ky = 110540; return (/** @type {number[]} */ p, /** @type {number[]} */ o) => [(p[1] - o[1]) * kx, (p[0] - o[0]) * ky]; };

    /**
     * Split the route at the rider and at the next turn.
     * @param {number[][]} path [[lat, lng], …]
     * @param {number[]} rider [lat, lng]
     * @param {number[]|null} turn [lat, lng] of the next maneuver, or null (none left: ride to the end)
     * @returns {{ current: number[][], next: number[][] }} current: the rider's point, then the route up to the turn;
     *   next: from the turn to the end
     */
    function splitRoute(path, rider, turn) {
        if (!Array.isArray(path) || path.length < 2 || !rider) return { current: [], next: [] };
        const P = proj(rider[0]);
        // the rider: the nearest point on the route
        let best = 0, bestD = Infinity, bestPt = path[0];
        for (let i = 0; i < path.length - 1; i++) {
            const a = P(path[i], rider), b = P(path[i + 1], rider);
            const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
            const t = L2 > 0 ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / L2)) : 0;
            const d = Math.hypot(a[0] + t * dx, a[1] + t * dy);
            if (d < bestD) { bestD = d; best = i; bestPt = [path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t]; }
        }
        if (!turn) return { current: [bestPt, ...path.slice(best + 1)], next: [] };
        // the turn: the nearest vertex AT OR AFTER the rider (a route can pass the same corner twice)
        const T = proj(turn[0]);
        let ti = best + 1, tD = Infinity;
        for (let i = best + 1; i < path.length; i++) {
            const q = T(path[i], turn), d = Math.hypot(q[0], q[1]);
            if (d < tD) { tD = d; ti = i; }
        }
        return { current: [bestPt, ...path.slice(best + 1, ti + 1)], next: path.slice(ti) };
    }

    /** The looks (exported for the tests and for anyone tuning them in one place). */
    const LOOK = Object.freeze({
        currentCasing: { color: "#00d8ff", weight: 16, opacity: 1, lineCap: "round", lineJoin: "round" },
        currentCore: { color: "#ffffff", weight: 8, opacity: 1, lineCap: "round", lineJoin: "round" },
        nextCasing: { color: "#000000", weight: 12, opacity: 1, lineCap: "round", lineJoin: "round" },
        next: { color: "#00d8ff", weight: 7, opacity: 1, dashArray: null },
        // ridden: dim grey, as wide as the route under it so no cyan shows behind the rider
        trail: { color: "#3f4950", weight: 8, opacity: 1 }
    });

    return { splitRoute, LOOK };
})();

const RideFocus = (() => {
    const C = RideFocusCore;
    const KEY = "mu.ridefocus.v1";
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document || typeof W.L === "undefined") return { core: C };
    const L = W.L;
    const CARTO = "https://{s}.basemaps.cartocdn.com";
    const CARTO_CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>';

    let enabled = false;
    try { enabled = JSON.parse(localStorage.getItem(KEY) || "{}").on === true; } catch (e) { enabled = false; }
    /** @type {any} */ let drive = null;          // { map, ahead, trail, route, turn }
    /** @type {any} */ let applied = null;        // what was changed, to put back
    let lastRider = null;

    // ------------------------------------------------------------ layers
    /** @type {any} */ let base = null, labels = null;
    function layers() {
        if (!base) {
            base = L.tileLayer(`${CARTO}/dark_nolabels/{z}/{x}/{y}{r}.png`, { maxZoom: 20, className: "mu-amoled-base", attribution: CARTO_CREDIT });
            labels = L.tileLayer(`${CARTO}/dark_only_labels/{z}/{x}/{y}{r}.png`, { maxZoom: 20, pane: "mu-labels", muOverlay: true, opacity: 0.8, attribution: CARTO_CREDIT });
        }
        return { base, labels };
    }
    function panes(m) {
        for (const [name, z] of [["mu-rf-under", "395"], ["mu-rf-over", "410"]]) {
            if (!m.getPane(name)) { m.createPane(name); m.getPane(name).style.zIndex = z; m.getPane(name).style.pointerEvents = "none"; }
        }
        if (!m.getPane("mu-labels")) { m.createPane("mu-labels"); m.getPane("mu-labels").style.zIndex = "250"; m.getPane("mu-labels").style.pointerEvents = "none"; }
    }

    /** The rider's own base map layers now on the map, and the style menu's choice. */
    function ownBase(m) {
        const known = [];
        try { known.push(satelliteLayer, streetLayer, darkLayer, terrainLayer); } catch (e) { /* core.js not loaded */ }
        if (W.MapDetail && W.MapDetail.googleLayer) known.push(W.MapDetail.googleLayer);
        const on = known.filter((l) => l && m.hasLayer(l));
        const btn = document.querySelector("#map-style-menu button[data-style].active");
        return { layers: on, style: btn ? btn.dataset.style : "satellite" };
    }
    const styleEvent = (style) => { try { document.dispatchEvent(new CustomEvent("mu:map-style", { detail: { style } })); } catch (e) { /* old browser */ } };
    const rebaseCamera = () => { if (W.NavCamera && W.NavCamera.active && typeof W.NavCamera.rebase === "function") W.NavCamera.rebase(); };

    // ------------------------------------------------------------ on / off
    function enter() {
        if (applied || !drive) return;
        const m = drive.map;
        panes(m);
        const { base: b, labels: lb } = layers();
        const own = ownBase(m);
        own.layers.forEach((l) => m.removeLayer(l));
        b.addTo(m);
        lb.addTo(m);
        m.getContainer().classList.add("mu-amoled");
        const keep = (pl) => (pl ? { color: pl.options.color, weight: pl.options.weight, opacity: pl.options.opacity, dashArray: pl.options.dashArray || null } : null);
        applied = {
            own, ahead: keep(drive.ahead), trail: keep(drive.trail),
            nextCasing: L.polyline([], { ...C.LOOK.nextCasing, pane: "mu-rf-under", interactive: false }).addTo(m),
            curCasing: L.polyline([], { ...C.LOOK.currentCasing, pane: "mu-rf-over", interactive: false }).addTo(m),
            curCore: L.polyline([], { ...C.LOOK.currentCore, pane: "mu-rf-over", interactive: false }).addTo(m)
        };
        if (drive.ahead) drive.ahead.setStyle(C.LOOK.next);
        if (drive.trail) drive.trail.setStyle(C.LOOK.trail);
        styleEvent("amoled");
        rebaseCamera();
        draw();
    }
    function leave() {
        if (!applied || !drive) { applied = null; return; }
        const m = drive.map;
        const { base: b, labels: lb } = layers();
        if (m.hasLayer(b)) m.removeLayer(b);
        if (m.hasLayer(lb)) m.removeLayer(lb);
        for (const k of ["nextCasing", "curCasing", "curCore"]) if (applied[k]) m.removeLayer(applied[k]);
        applied.own.layers.forEach((l) => { if (!m.hasLayer(l)) l.addTo(m); });
        m.getContainer().classList.remove("mu-amoled");
        if (drive.ahead && applied.ahead) drive.ahead.setStyle(applied.ahead);
        if (drive.trail && applied.trail) drive.trail.setStyle(applied.trail);
        const style = applied.own.style;
        applied = null;
        styleEvent(style);
        rebaseCamera();
    }
    function sync() {
        if (enabled && drive) enter(); else leave();
        ui();
    }

    /** Redraw the current-road and casing lines from the latest position (cheap: no animation, once per fix). */
    function draw() {
        if (!applied || !drive) return;
        const path = typeof drive.route === "function" ? drive.route() : null;
        if (!Array.isArray(path) || path.length < 2) return;
        const rider = lastRider || path[0];
        const turn = typeof drive.turn === "function" ? drive.turn() : null;
        const s = C.splitRoute(path, rider, turn);
        applied.curCasing.setLatLngs(s.current);
        applied.curCore.setLatLngs(s.current);
        applied.nextCasing.setLatLngs(s.next.length ? s.next : []);
    }

    // ------------------------------------------------------------ controls
    const els = {};
    function ensureUi() {
        if (els.btn) return;
        const row = document.querySelector("#nav-bottom-sheet .controls-row");
        if (row) {
            els.btn = document.createElement("button");
            els.btn.id = "ridefocus-btn";
            els.btn.type = "button";
            els.btn.className = "btn-icon-nav";
            els.btn.hidden = true;
            els.btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/></svg>';
            els.btn.addEventListener("click", (e) => { e.stopPropagation(); set(!enabled); });
            const voice = document.getElementById("voice-cmd-btn");
            row.insertBefore(els.btn, voice || null);
        }
        els.toggle = document.getElementById("ride-focus-toggle");
        if (els.toggle) els.toggle.addEventListener("change", () => set(Boolean(els.toggle.checked)));
    }
    function ui() {
        ensureUi();
        if (els.btn) {
            els.btn.hidden = !drive;
            els.btn.setAttribute("aria-pressed", String(enabled));
            els.btn.classList.toggle("on", enabled);
            const label = enabled ? "Ride Focus AMOLED is on. Tap for your usual map." : "Ride Focus AMOLED: true-black map. Tap to turn on.";
            els.btn.setAttribute("aria-label", label);
            els.btn.title = label;
        }
        if (els.toggle) els.toggle.checked = enabled;
    }
    function set(v) {
        enabled = Boolean(v);
        try { localStorage.setItem(KEY, JSON.stringify({ on: enabled })); } catch (e) { /* private mode */ }
        sync();
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ui); else ui();

    return {
        core: C,
        /** @param {{ map: any, ahead?: any, trail?: any, route?: () => number[][], turn?: () => number[]|null }} o */
        start(o) { if (!o || !o.map) return; drive = o; lastRider = null; sync(); },
        update(lat, lng) { if (!Number.isFinite(lat) || !Number.isFinite(lng)) return; lastRider = [lat, lng]; draw(); },
        stop() { leave(); drive = null; lastRider = null; ui(); },
        set,
        get enabled() { return enabled; },
        get active() { return Boolean(applied); }
    };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).RideFocus = RideFocus;
if (typeof module === "object" && module.exports) module.exports = { RideFocusCore };
