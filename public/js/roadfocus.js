/* ============================================================================
   MapUnite Straight-road focus — the road glows, the rest goes quiet
   ==============================================================================
   While navigating on a long straight stretch with no decision to make (the
   next turn is far away and the road doesn't bend much), the map focuses on
   the rider's road:
     - the road ahead, up to 3 km or the next turn, glows (soft cyan layers
       under the route line);
     - small particles drift along both edges of the road, towards the rider,
       like the road passing under the bike (slow; none with the phone's
       "reduce motion" setting);
     - everything around it is dimmed in five soft steps away from the road,
       with a fine dot grain (the "pixel" look) on the far part, and the map's
       colours fade a little;
     - a small chip says why: "Straight road · next turn 4.2 km".
   Before the next turn, or before the road starts to bend (a ghat), it fades
   back to the normal map in about a second, so the junction and the roads
   around it are fully visible in good time.

   WHEN (RoadFocusCore.decide, pure and tested):
     on   the next turn is ≥ 2 km AND ≥ 60 s away at the current speed, the
          road bends less than 35° in any 250 m for the next 1.2 km, the
          rider is moving (≥ 4 m/s, about 15 km/h), the position is a real GPS
          fix (not an estimate), and the map has been normal for ≥ 12 s;
     off  the next turn is within 800 m or 30 s, or a bend is within 600 m
          or 25 s, or the position is only an estimate.
   The next turn is the route's own next maneuver (the same one the voice
   prompts use), and "the road bends" is measured on the route's geometry: no
   AI or ML guess. Lane changes aren't known (the map data has no reliable
   lanes), so only turns, exits and the destination end the focus.

   NEVER DIMMED: the route line itself, the rider and every marker (road
   reports, hazards), the turn banner, alerts, speed, ETA and buttons: the dim
   layers sit under the route and the markers, and the screen's panels are
   outside the map.

   Optional: on by default, switched in Smart Drive Settings ("Straight-road
   focus"), remembered on this phone (localStorage "mu.roadfocus.v1").
   RoadFocus.start({ map, route, turn })                when a drive starts
   RoadFocus.update(lat, lng, speedMps, estimated)      on every fix / estimate
   RoadFocus.stop()                                     when the drive ends
   ============================================================================ */
"use strict";

const RoadFocusCore = (() => {
    const RAD = Math.PI / 180;
    const TUNE = Object.freeze({
        enterM: 2000, enterS: 60,          // the next turn at least this far (metres) and this long (seconds) away
        exitM: 800, exitS: 30,             // back to normal this far before the turn
        straightM: 1200,                   // the road ahead must stay straight this far to start
        bendDeg: 35, bendWinM: 250,        // "a bend": more than 35° of turning within 250 m
        bendExitM: 600, bendExitS: 25,     // back to normal this far before a bend
        minSpeed: 4,                       // m/s (≈ 15 km/h): not in a jam or at a light
        holdS: 12,                         // at least this long normal before focusing again
        glowM: 3000                        // how far ahead the road glows
    });

    /** Local metres around a point. @param {number} lat0 @param {number} lng0 */
    function projector(lat0, lng0) {
        const kx = Math.cos(lat0 * RAD) * 111320, ky = 110540;
        return {
            to: (/** @type {number[]} */ p) => [(p[1] - lng0) * kx, (p[0] - lat0) * ky],
            back: (/** @type {number[]} */ q) => [lat0 + q[1] / ky, lng0 + q[0] / kx]
        };
    }
    /** Metres along a polyline [[lat, lng], …]. */
    function lengthM(pts) {
        if (!Array.isArray(pts) || pts.length < 2) return 0;
        const P = projector(pts[0][0], pts[0][1]);
        let s = 0;
        for (let i = 1; i < pts.length; i++) { const a = P.to(pts[i - 1]), b = P.to(pts[i]); s += Math.hypot(b[0] - a[0], b[1] - a[1]); }
        return s;
    }

    /**
     * The route from the rider: the nearest point on it, then the rest of the path. Pure.
     * @param {number[][]} path @param {number[]} rider @returns {{ pts: number[][], index: number }} index: the segment the rider is on
     */
    function fromRider(path, rider) {
        if (!Array.isArray(path) || path.length < 2 || !rider) return { pts: [], index: -1 };
        const P = projector(rider[0], rider[1]);
        let best = 0, bestD = Infinity, bestPt = path[0];
        for (let i = 0; i < path.length - 1; i++) {
            const a = P.to(path[i]), b = P.to(path[i + 1]);
            const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
            const t = L2 > 0 ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / L2)) : 0;
            const d = Math.hypot(a[0] + t * dx, a[1] + t * dy);
            if (d < bestD) { bestD = d; best = i; bestPt = [path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t]; }
        }
        return { pts: [bestPt, ...path.slice(best + 1)], index: best };
    }

    /** The first `maxM` metres of a polyline (cut inside the last segment). Pure. @param {number[][]} pts @param {number} maxM */
    function cut(pts, maxM) {
        if (!Array.isArray(pts) || pts.length < 2) return [];
        const P = projector(pts[0][0], pts[0][1]);
        const out = [pts[0]];
        let s = 0;
        for (let i = 1; i < pts.length; i++) {
            const a = P.to(pts[i - 1]), b = P.to(pts[i]), l = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (s + l >= maxM) {
                const t = l > 0 ? (maxM - s) / l : 0;
                out.push(P.back([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]));
                return out;
            }
            s += l; out.push(pts[i]);
        }
        return out;
    }

    /**
     * Metres along the route from the rider to the next turn (the nearest vertex to it at or after the rider), or to
     * the end of the route when there's no turn left (the destination). Pure.
     * @param {number[][]} path @param {number[]} rider @param {number[]|null} turn
     */
    function toTurnM(path, rider, turn) {
        const r = fromRider(path, rider);
        if (r.pts.length < 2) return 0;
        if (!turn) return lengthM(r.pts);
        const T = projector(turn[0], turn[1]);
        let ti = 1, tD = Infinity;
        for (let i = 1; i < r.pts.length; i++) { const q = T.to(r.pts[i]), d = Math.hypot(q[0], q[1]); if (d < tD) { tD = d; ti = i; } }
        return lengthM(r.pts.slice(0, ti + 1));
    }

    /**
     * Where the road first bends: the distance (metres from the start) of the first stretch of `winM` metres that
     * turns more than `limitDeg` in total, or Infinity. Resampled every 25 m, so short GPS-like zig-zags in the
     * geometry don't count as bends. Pure.
     * @param {number[][]} pts @param {number} [limitDeg] @param {number} [winM]
     */
    function firstBendM(pts, limitDeg = TUNE.bendDeg, winM = TUNE.bendWinM) {
        if (!Array.isArray(pts) || pts.length < 3) return Infinity;
        const P = projector(pts[0][0], pts[0][1]);
        const q = pts.map((p) => P.to(p));
        // resample every 25 m
        const STEP = 25, rs = [q[0]];
        let carry = 0;
        for (let i = 1; i < q.length; i++) {
            const a = q[i - 1], b = q[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
            let d = STEP - carry;
            while (d <= l) { rs.push([a[0] + (b[0] - a[0]) * d / l, a[1] + (b[1] - a[1]) * d / l]); d += STEP; }
            carry = l - (d - STEP);
        }
        if (rs.length < 3) return Infinity;
        const head = [];
        for (let i = 1; i < rs.length; i++) head.push(Math.atan2(rs[i][1] - rs[i - 1][1], rs[i][0] - rs[i - 1][0]));
        const turn = [];
        for (let i = 1; i < head.length; i++) { let d = head[i] - head[i - 1]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; turn.push(Math.abs(d) / RAD); }
        const n = Math.max(1, Math.round(winM / STEP));
        let sum = 0;
        for (let i = 0; i < turn.length; i++) {
            sum += turn[i];
            if (i >= n) sum -= turn[i - n];
            if (sum > limitDeg) return Math.max(0, (i + 1 - n) * STEP);
        }
        return Infinity;
    }

    /**
     * Focus or not, with hysteresis. Pure.
     * @param {{ focus: boolean, since: number }} prev since: when it last changed (ms)
     * @param {{ toTurnM: number, bendM: number, speedMps: number, estimated?: boolean, now: number }} s
     * @returns {{ focus: boolean, since: number, reason: string }}
     */
    function decide(prev, s) {
        const v = Math.max(0, s.speedMps || 0);
        if (prev.focus) {
            const why = s.estimated ? "no GPS fix" : s.toTurnM <= Math.max(TUNE.exitM, v * TUNE.exitS) ? "turn ahead" : s.bendM <= Math.max(TUNE.bendExitM, v * TUNE.bendExitS) ? "bend ahead" : "";
            return why ? { focus: false, since: s.now, reason: why } : { focus: true, since: prev.since, reason: "straight road" };
        }
        const ok = !s.estimated && v >= TUNE.minSpeed && s.toTurnM >= Math.max(TUNE.enterM, v * TUNE.enterS) && s.bendM >= TUNE.straightM && s.now - prev.since >= TUNE.holdS * 1000;
        return ok ? { focus: true, since: s.now, reason: "straight road" } : { focus: false, since: prev.since, reason: "" };
    }

    /** Unit normals (left of travel) at each vertex, averaged at joins. */
    function normals(q) {
        const n = [];
        for (let i = 0; i < q.length; i++) {
            const a = q[Math.max(0, i - 1)], b = q[Math.min(q.length - 1, i + 1)];
            const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
            n.push([-dy / l, dx / l]);
        }
        return n;
    }
    /** A line moved sideways by d metres (left of travel when d > 0). Pure. @param {number[][]} pts @param {number} d */
    function offsetLine(pts, d) {
        if (!Array.isArray(pts) || pts.length < 2) return [];
        const P = projector(pts[0][0], pts[0][1]);
        const q = pts.map((p) => P.to(p)), n = normals(q);
        return q.map((p, i) => P.back([p[0] + n[i][0] * d, p[1] + n[i][1] * d]));
    }
    /** A band around a line, halfM metres each side, as one closed ring. Pure. @param {number[][]} pts @param {number} halfM */
    function corridor(pts, halfM) {
        if (!Array.isArray(pts) || pts.length < 2) return [];
        return [...offsetLine(pts, halfM), ...offsetLine(pts, -halfM).reverse()];
    }

    /** Metres per screen pixel at a latitude and zoom (Web Mercator, 256-px tiles). Pure. */
    const metresPerPx = (/** @type {number} */ lat, /** @type {number} */ zoom) => (40075016.686 * Math.cos(lat * RAD)) / (256 * 2 ** zoom);

    return { TUNE, lengthM, fromRider, cut, toTurnM, firstBendM, decide, offsetLine, corridor, metresPerPx };
})();

const RoadFocus = (() => {
    const C = RoadFocusCore;
    const KEY = "mu.roadfocus.v1";
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document || typeof W.L === "undefined") return { core: C };
    const L = W.L;

    let enabled = true;
    try { const s = JSON.parse(localStorage.getItem(KEY) || "{}"); enabled = s.on !== false; } catch (e) { enabled = true; }
    /** @type {any} */ let drive = null;      // { map, route, turn }
    /** @type {any} */ let fx = null;         // the layers while a drive is on
    let state = { focus: false, since: -Infinity, reason: "" };
    let last = null;                           // { lat, lng, speed, estimated }

    // the soft steps of the dim, nearest the road first: hole half-width in screen px, and how dark
    const STEPS = [{ px: 26, a: 0.1 }, { px: 44, a: 0.11 }, { px: 68, a: 0.12 }, { px: 100, a: 0.14 }, { px: 145, a: 0.18 }];
    const GLOW = [{ w: 46, a: 0.07 }, { w: 30, a: 0.12 }, { w: 18, a: 0.2 }];
    const DOTS_PX = 22;                        // the particles' distance from the road's centre line, px

    function pane(m, name, z) {
        if (!m.getPane(name)) { m.createPane(name); const p = m.getPane(name); p.style.zIndex = String(z); p.style.pointerEvents = "none"; p.classList.add("mu-focus"); p.style.opacity = "0"; }
        return m.getPane(name);
    }
    function build() {
        const m = drive.map;
        const panes = [pane(m, "mu-focus-dim", 380), pane(m, "mu-focus-glow", 392), pane(m, "mu-focus-fx", 405)];
        const dimR = L.svg({ pane: "mu-focus-dim", padding: 0.5 });
        const opt = (/** @type {any} */ o) => ({ stroke: false, interactive: false, renderer: dimR, ...o });
        const dims = STEPS.map((s) => L.polygon([], opt({ fillColor: "#02050a", fillOpacity: s.a })).addTo(m));
        const grain = L.polygon([], opt({ fillColor: "url(#mu-focus-grain)", fillOpacity: 1 })).addTo(m);
        // the dot grain: a pattern in the dim layer's own SVG
        const svg = dimR._container;
        if (svg && !svg.querySelector("#mu-focus-grain")) {
            const NS = "http://www.w3.org/2000/svg";
            const defs = document.createElementNS(NS, "defs"), pat = document.createElementNS(NS, "pattern"), dot = document.createElementNS(NS, "circle");
            pat.setAttribute("id", "mu-focus-grain"); pat.setAttribute("patternUnits", "userSpaceOnUse"); pat.setAttribute("width", "7"); pat.setAttribute("height", "7");
            dot.setAttribute("cx", "3.5"); dot.setAttribute("cy", "3.5"); dot.setAttribute("r", "1.05"); dot.setAttribute("fill", "rgba(150,225,255,0.22)");
            pat.append(dot); defs.append(pat); svg.prepend(defs);
        }
        const glowR = L.svg({ pane: "mu-focus-glow", padding: 0.5 }), fxR = L.svg({ pane: "mu-focus-fx", padding: 0.5 });
        const glows = GLOW.map((g) => L.polyline([], { color: "#22d3ee", weight: g.w, opacity: g.a, lineCap: "round", lineJoin: "round", interactive: false, renderer: glowR }).addTo(m));
        const dots = [1, -1].map(() => L.polyline([], { color: "#a5f3fc", weight: 3.2, opacity: 0.75, lineCap: "round", dashArray: "0.1 22", interactive: false, renderer: fxR, className: "mu-focus-dots" }).addTo(m));
        fx = { panes, renderers: [dimR, glowR, fxR], dims, grain, glows, dots };
        m.on("zoomend", draw);
    }
    function teardown() {
        if (!fx || !drive) { fx = null; return; }
        const m = drive.map;
        m.off("zoomend", draw);
        [...fx.dims, fx.grain, ...fx.glows, ...fx.dots].forEach((l) => m.removeLayer(l));
        fx.renderers.forEach((r) => { try { m.removeLayer(r); } catch (e) { /* already gone */ } });
        fx.panes.forEach((p) => { p.style.opacity = "0"; });
        m.getContainer().classList.remove("mu-focus-on");
        fx = null;
    }

    /** Put the layers on the road ahead (once per fix, and on zoom). */
    function draw() {
        if (!fx || !drive || !last) return;
        const m = drive.map;
        const path = typeof drive.route === "function" ? drive.route() : null;
        if (!Array.isArray(path) || path.length < 2) return;
        const rider = [last.lat, last.lng];
        const toTurn = C.toTurnM(path, rider, typeof drive.turn === "function" ? drive.turn() : null);
        const road = C.cut(C.fromRider(path, rider).pts, Math.min(C.TUNE.glowM, Math.max(50, toTurn)));
        if (road.length < 2) return;
        const mpp = C.metresPerPx(last.lat, m.getZoom());
        const pad = 0.35;            // ≈ 35–40 km: past anything the tilted camera can show
        const outer = [[last.lat - pad, last.lng - pad], [last.lat - pad, last.lng + pad], [last.lat + pad, last.lng + pad], [last.lat + pad, last.lng - pad]];
        STEPS.forEach((s, i) => fx.dims[i].setLatLngs([outer, C.corridor(road, s.px * mpp)]));
        fx.grain.setLatLngs([outer, C.corridor(road, STEPS[STEPS.length - 1].px * mpp)]);
        fx.glows.forEach((g) => g.setLatLngs(road));
        fx.dots[0].setLatLngs(C.offsetLine(road, DOTS_PX * mpp));
        fx.dots[1].setLatLngs(C.offsetLine(road, -DOTS_PX * mpp));
    }

    function show(on) {
        if (!fx || !drive) return;
        fx.panes.forEach((p) => { p.style.opacity = on ? "1" : "0"; });
        drive.map.getContainer().classList.toggle("mu-focus-on", on);
    }

    // ------------------------------------------------------------ the chip
    let chip = null;
    function chipEl() {
        if (!chip) {
            chip = document.createElement("div");
            chip.id = "road-focus-chip";
            chip.hidden = true;
            document.body.append(chip);
        }
        return chip;
    }
    function chipUpdate(on, toTurn) {
        const c = chipEl();
        if (!on) { c.hidden = true; return; }
        const km = toTurn >= 10000 ? Math.round(toTurn / 1000) : Math.round(toTurn / 100) / 10;
        c.textContent = `Straight road · next turn ${km} km`;
        const banner = document.getElementById("turn-banner");
        const r = banner && banner.offsetParent ? banner.getBoundingClientRect() : null;
        c.style.top = r && r.bottom > 0 ? `${Math.round(r.bottom + 8)}px` : "";
        c.hidden = false;
    }

    // ------------------------------------------------------------ the loop
    function step() {
        if (!drive || !last) return;
        const path = typeof drive.route === "function" ? drive.route() : null;
        if (!Array.isArray(path) || path.length < 2) return;
        const rider = [last.lat, last.lng];
        const turn = typeof drive.turn === "function" ? drive.turn() : null;
        const toTurn = C.toTurnM(path, rider, turn);
        const ahead = C.cut(C.fromRider(path, rider).pts, Math.min(toTurn, C.TUNE.straightM + 400));
        const bend = C.firstBendM(ahead);
        state = C.decide(state, { toTurnM: toTurn, bendM: bend, speedMps: last.speed, estimated: last.estimated, now: Date.now() });
        if (state.focus && !fx) build();
        if (fx) draw();
        show(state.focus);
        chipUpdate(state.focus, toTurn);
    }

    // ------------------------------------------------------------ settings
    function ui() {
        const t = document.getElementById("road-focus-toggle");
        if (t && !t.dataset.wired) { t.dataset.wired = "1"; t.addEventListener("change", () => set(Boolean(t.checked))); }
        if (t) t.checked = enabled;
    }
    function set(v) {
        enabled = Boolean(v);
        try { localStorage.setItem(KEY, JSON.stringify({ on: enabled })); } catch (e) { /* private mode */ }
        if (!enabled) { state = { focus: false, since: Date.now(), reason: "" }; show(false); chipUpdate(false, 0); }
        else step();
        ui();
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ui); else ui();

    return {
        core: C,
        /** @param {{ map: any, route?: () => number[][], turn?: () => number[]|null }} o */
        start(o) { if (!o || !o.map) return; drive = o; last = null; state = { focus: false, since: -Infinity, reason: "" }; },
        update(lat, lng, speedMps = 0, estimated = false) {
            if (!drive || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
            last = { lat, lng, speed: Number.isFinite(speedMps) ? speedMps : 0, estimated: Boolean(estimated) };
            if (enabled) step();
        },
        stop() { show(false); teardown(); chipUpdate(false, 0); drive = null; last = null; state = { focus: false, since: -Infinity, reason: "" }; },
        set,
        get enabled() { return enabled; },
        get focused() { return state.focus; },
        get reason() { return state.reason; }
    };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).RoadFocus = RoadFocus;
if (typeof module === "object" && module.exports) module.exports = { RoadFocusCore };
