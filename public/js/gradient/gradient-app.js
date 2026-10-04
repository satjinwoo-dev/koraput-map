// @ts-check
/* ============================================================================
   MapUnite gradient — wiring into the map app (roadmap step 9)
   ==============================================================================
   - On every route ("mu:route"): the gradient from the SAME terrain samples the
     trip card uses (so they come from its cache, no extra network), with DEM
     spikes fixed. MUGradient.app.current is that profile: the HUD reads the grade
     under you from it.
   - When navigation starts, or the rider opens the sheet: OpenStreetMap bridges
     and tunnels along the route are fetched (MUTrip.structures, cached 30 days in
     mu-trip-v1 — the same lookup the trip card uses), and the profile is redone
     with them.
   - "Gradient & bridges" (#gradient-open-btn, added under the trip card's
     elevation chart) opens the sheet (#gradient-modal); "Show on map" draws the
     section on the map.
   Works offline: scripts precached by sw.js; terrain heights and structures come
   from Cache Storage; with nothing saved the sheet says what's missing.
   ============================================================================ */
(function (root) {
    "use strict";
    const W = /** @type {any} */ (root);
    if (!W.document) return;
    const GR = W.MUGradient, T = W.MUTrip;
    if (!GR || !GR.core || !T || !T.profile || !T.structures) { console.warn("[gradient] load js/trip/profile.js, js/trip/structures.js and js/gradient/gradient.js before gradient-app.js"); return; }
    const $ = (id) => document.getElementById(id);
    const VIEW = { js: ["js/gradient/profile-chart.js"], css: "js/gradient/gradient.css" };
    const structures = T.structures.createStructures();
    let route = null, token = 0, last = null, current = null, view = null, loading = null, navigating = false, highlight = null, wantOsm = false;
    /** @type {any} */ let ownElevation = null;

    function elevation() {
        const app = T.app;
        if (app && app.elevation) return app.elevation;                  // the trip card's instance: shared memory cache
        if (!ownElevation && T.elevation) ownElevation = T.elevation.createElevation();
        return ownElevation;
    }

    function routeKey(r) {
        const p = r.path || [];
        const a = p[0] || [0, 0], b = p[p.length - 1] || [0, 0];
        return `${p.length}:${Number(a[0]).toFixed(5)},${Number(a[1]).toFixed(5)}:${Number(b[0]).toFixed(5)},${Number(b[1]).toFixed(5)}:${Math.round(r.distanceM || 0)}`;
    }

    /** Wait (≤ 8 s) for the trip card's terrain lookup, so ours is answered from memory. */
    function cardTerrainReady() {
        return new Promise((resolve) => {
            const t0 = Date.now();
            const check = () => {
                const card = T.app && T.app.card;
                const p = card ? card.profile : null;
                if (!card || (p && p.source === "dem") || Date.now() - t0 > 8000) return resolve(undefined);
                setTimeout(check, 400);
            };
            check();
        });
    }

    /**
     * Redo the gradient for the current route.
     * @param {{ osm?: boolean, waitCard?: boolean }} [o]
     */
    async function analyze(o = {}) {
        if (!route || !Array.isArray(route.path) || route.path.length < 2) return null;
        const my = ++token, r = route;
        const P = T.profile;
        const spacing = P.plan(r.distanceM);
        const rs = P.resample(r.path, spacing);
        if (o.waitCard) await cardTerrainReady();
        if (my !== token) return null;
        const el = elevation();
        let elev = { z: new Float64Array(rs.lat.length).fill(NaN), source: "none", fetched: 0, missing: rs.lat.length };
        try { if (el) elev = await el.lookup(rs.lat, rs.lng); } catch { /* flat */ }
        if (my !== token) return null;
        let spans = null, structureSource = "none";
        if (o.osm || wantOsm) {
            try { const st = await structures.along(rs); spans = st.spans; structureSource = st.source === "osm" ? "network" : st.source; } catch { spans = null; }
            if (my !== token) return null;
            if (structureSource === "none") spans = null;
        }
        const res = GR.core.analyze({ sample: rs, z: elev.z, distance: r.distanceM || rs.length, spans, profileLib: P, structuresLib: T.structures });
        const meta = {
            elevation: { source: elev.source, fetched: elev.fetched || 0, missing: elev.missing || 0, total: rs.lat.length },
            structureSource, offline: typeof navigator !== "undefined" && navigator.onLine === false,
            routeName: (nav() && nav().destName) || ""
        };
        last = { key: routeKey(r), result: res, meta, osm: Boolean(spans) };
        current = res.profile.source === "dem" ? res.profile : null;
        placeButton();
        if (view && isOpen()) view.render(res, { ...meta, progress: progress() });
        document.dispatchEvent(new CustomEvent("mu:gradient", { detail: { summary: res.summary, structures: res.structures.length, sections: res.sections.length } }));
        return last;
    }

    /** js/voice.js's navState (a classic-script lexical, so read with a typeof guard). @returns {any} */
    function nav() {
        // @ts-ignore
        try { return typeof navState !== "undefined" && navState && typeof navState === "object" ? navState : null; } catch { return null; }
    }
    function progress() {
        const ns = nav();
        if (!ns || !last || !ns.active || !Number.isFinite(ns.remainingM)) return null;
        return Math.max(0, last.result.profile.distance - ns.remainingM);
    }

    // ---------------------------------------------------------------- the button under the trip card's chart
    function placeButton() {
        const fig = document.querySelector("#trip-energy .trip-elev");
        let btn = $("gradient-open-btn");
        if (!route || !last) { if (btn) btn.hidden = true; return; }
        if (!btn) {
            const nb = document.createElement("button");
            nb.type = "button"; nb.id = "gradient-open-btn"; nb.className = "grd-open-btn";
            nb.addEventListener("click", () => open());
            btn = nb;
        }
        if (fig && btn.parentElement !== fig) fig.append(btn);
        const sm = last.result.summary, secs = last.result.sections;
        const climbs = secs.filter((x) => x.kind === "climb").length;
        const fixed = last.result.structures.length;
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20 9 9l4 6 3-4 5 9z"/></svg><span>Gradient &amp; bridges</span><small></small>`;
        /** @type {HTMLElement} */ (btn.querySelector("small")).textContent = last.result.profile.source === "flat" ? "hills unknown" : `${climbs} steep climb${climbs === 1 ? "" : "s"}${fixed ? ` · ${fixed} fixed` : ""} · max ${Math.round(sm.maxClimb * 100)} %`;
        btn.hidden = false;
    }

    // ---------------------------------------------------------------- the sheet
    function loadView() {
        if (!loading) {
            if (!document.querySelector(`link[data-mu-href="${VIEW.css}"]`)) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = VIEW.css; l.dataset.muHref = VIEW.css; document.head.append(l); }
            loading = VIEW.js.reduce((p, src) => p.then(() => new Promise((resolve, reject) => {
                if (document.querySelector(`script[data-mu-src="${src}"]`)) return resolve(undefined);
                const s = document.createElement("script"); s.src = src; s.async = false; s.dataset.muSrc = src;
                s.onload = () => resolve(undefined); s.onerror = () => reject(new Error(src));
                document.head.append(s);
            })), Promise.resolve()).catch((e) => { loading = null; throw e; });
        }
        return loading;
    }
    function isOpen() { const m = $("gradient-modal"); return Boolean(m && m.style.display === "flex"); }
    function close() {
        const m = $("gradient-modal");
        if (m) { m.style.display = "none"; m.setAttribute("aria-hidden", "true"); }
        clearHighlight();
        const b = $("gradient-open-btn"); if (b) b.focus();
    }
    async function open() {
        const host = $("gradient-modal"), mount = $("gradient-mount");
        if (!host || !mount || !route) return;
        await loadView();
        if (!view) view = GR.view.createProfileView(mount, { units: W.MUGarage.units, core: GR.core, onClose: close, onFocusSection: (sec) => showOnMap(sec) });
        host.style.display = "flex"; host.setAttribute("aria-hidden", "false");
        if (last) view.render(last.result, { ...last.meta, progress: progress() });
        // opening the sheet is the moment to check OpenStreetMap for bridges and tunnels
        if (!last || !last.osm) { wantOsm = true; await analyze({ osm: true }); }
        const plot = mount.querySelector(".grd-plot"); if (plot) /** @type {HTMLElement} */ (plot).focus({ preventScroll: true });
    }

    // ---------------------------------------------------------------- "Show on map"
    function clearHighlight() { try { if (highlight && W.map) W.map.removeLayer(highlight); } catch { /* map gone */ } highlight = null; }
    /** @param {{ s0: number, s1: number, what: string }} sec */
    function showOnMap(sec) {
        if (!route || !W.L || !W.map || !last) return;
        const G = GR.core.routeGeometry(route.path);
        const k = G.length > 0 ? G.length / last.result.profile.distance : 1;          // profile metres → route metres
        const a = sec.s0 * k, b = sec.s1 * k, pts = [];
        const at = (x) => {
            let i = 0; while (i < G.n - 2 && G.s[i + 1] < x) i++;
            const t = (x - G.s[i]) / ((G.s[i + 1] - G.s[i]) || 1);
            const p0 = route.path[i], p1 = route.path[Math.min(i + 1, route.path.length - 1)];
            return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
        };
        pts.push(at(a));
        for (let i = 0; i < G.n; i++) if (G.s[i] > a && G.s[i] < b) pts.push([route.path[i][0], route.path[i][1]]);
        pts.push(at(b));
        clearHighlight();
        highlight = W.L.polyline(pts, { color: "#ffb020", weight: 8, opacity: 0.95, lineCap: "round" }).addTo(W.map);
        highlight.bindTooltip(sec.what, { permanent: true, direction: "top", className: "weather-badge" });
        try { W.map.fitBounds(highlight.getBounds(), { padding: [60, 60], maxZoom: 16 }); } catch { /* ignore */ }
        const m = $("gradient-modal"); if (m) { m.style.display = "none"; m.setAttribute("aria-hidden", "true"); }
        setTimeout(clearHighlight, 20000);
    }

    // ---------------------------------------------------------------- events
    function init() {
        document.addEventListener("mu:route", (e) => {
            route = /** @type {CustomEvent} */ (e).detail || null;
            last = null; current = null; wantOsm = navigating;
            placeButton();
            analyze({ osm: navigating, waitCard: true });
        });
        document.addEventListener("mu:route-clear", () => { route = null; last = null; current = null; token++; placeButton(); clearHighlight(); });
        document.addEventListener("mu:drive-state", (e) => {
            const d = /** @type {CustomEvent} */ (e).detail || {};
            const was = navigating; navigating = Boolean(d.navigating);
            if (navigating && !was && route && (!last || !last.osm)) { wantOsm = true; analyze({ osm: true }); }
        });
        document.addEventListener("mu:fix", () => { if (view && isOpen()) view.setProgress(progress()); });
        const host = $("gradient-modal");
        if (host) host.addEventListener("click", (e) => { if (e.target === host) close(); });
        document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen()) close(); });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();

    GR.app = { open, close, analyze, get current() { return current; }, get last() { return last; } };
})(typeof globalThis !== "undefined" ? globalThis : this);
