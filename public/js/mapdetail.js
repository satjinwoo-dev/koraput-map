/* ============================================================================
   MapUnite map detail (phone) — named places on the map, and Google's map
   ==============================================================================
   1. PLACES: gyms, temples, schools, shops, petrol pumps, hospitals, areas…
      with an icon and their name, like Google Maps, from OpenStreetMap
      (server: lib/map-detail.js, /api/map/places, 0.01° tiles cached 24 h).
        - shown from zoom 15 (only the most important kinds) to 17+ (all);
        - labels that would overlap are dropped, the more important kept
          (an area name beats a hospital beats a temple beats a shop);
        - during a drive only the important kinds (rank ≤ 3: areas, health,
          fuel, police, worship, schools, stations, sights);
        - shown on the Satellite, Dark, Terrain and Ride Focus AMOLED styles; not on Street (OSM
          tiles already draw them) nor on Google (Google draws its own).
      Under the navigation camera markers stand upright (navcam.css), so the
      names stay readable as the map turns.

   2. GOOGLE: when the server has a Google Map Tiles key (MU_CONFIG.googleTiles),
      a "Google" style appears in the map-style menu: Google's satellite
      imagery with its roads and names, through /api/map/gtile (the key stays
      on the server). Google's logo and copyright line show while it's on.

   MapDetail.core holds the pure parts (tiles for a view, decluttering), tested
   on their own (test/navcam/map-detail.test.mjs).
   ============================================================================ */
"use strict";

const MapDetailCore = (() => {
    const TILE_DEG = 0.01;

    /** Tile keys ("a:b", south-west corner in 0.01° steps) covering a box, nearest the centre first, at most max. @param {{ s: number, w: number, n: number, e: number }} b */
    function tilesFor(b, max = 12) {
        const a0 = Math.floor(b.s / TILE_DEG), a1 = Math.floor(b.n / TILE_DEG), b0 = Math.floor(b.w / TILE_DEG), b1 = Math.floor(b.e / TILE_DEG);
        const ca = (b.s + b.n) / 2 / TILE_DEG - 0.5, cb = (b.w + b.e) / 2 / TILE_DEG - 0.5;
        const out = [];
        for (let a = a0; a <= a1; a++) for (let c = b0; c <= b1; c++) out.push({ k: `${a}:${c}`, d: (a - ca) ** 2 + (c - cb) ** 2 });
        return out.sort((x, y) => x.d - y.d).slice(0, max).map((x) => x.k);
    }

    /** Which ranks show at a zoom (and while driving). @param {number} z @param {boolean} driving */
    function maxRank(z, driving) {
        const r = z >= 17 ? 7 : z >= 16 ? 5 : z >= 15 ? 3 : 0;
        return driving ? Math.min(r, 3) : r;
    }

    /**
     * Keep the places whose labels don't collide, the more important first.
     * @template {{ rank: number, x: number, y: number, name: string }} P
     * @param {P[]} places screen positions (px)
     * @returns {P[]}
     */
    function declutter(places, max = 120, charW = 6.6, h = 22) {
        const kept = /** @type {P[]} */ ([]);
        const boxes = /** @type {Array<[number, number, number, number]>} */ ([]);
        const sorted = [...places].sort((a, b) => a.rank - b.rank || a.name.length - b.name.length);
        for (const p of sorted) {
            if (kept.length >= max) break;
            const w = 26 + Math.min(22, p.name.length) * charW;         // icon + label to its right
            const box = /** @type {[number, number, number, number]} */ ([p.x - 12, p.y - h / 2, p.x - 12 + w, p.y + h / 2]);
            if (boxes.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
            boxes.push(box);
            kept.push(p);
        }
        return kept;
    }

    /** The icon and colour for a kind (Google-like colours). @type {Record<string, [string, string]>} */
    const LOOK = {
        area: ["", "#ffffff"], health: ["✚", "#e8453c"], fuel: ["⛽", "#1a73e8"], police: ["★", "#5c6bc0"],
        worship: ["ॐ", "#7c8ba1"], education: ["🎓", "#7c8ba1"], transit: ["🚌", "#1a73e8"], attraction: ["◉", "#12a37d"],
        food: ["🍴", "#f29900"], lodging: ["🛏", "#e8457a"], bank: ["₹", "#5c6bc0"], government: ["🏛", "#7c8ba1"],
        gym: ["💪", "#12a37d"], park: ["🌳", "#12a37d"], shop: ["🛍", "#4285f4"], service: ["🔧", "#7c8ba1"], other: ["•", "#7c8ba1"]
    };

    return { TILE_DEG, tilesFor, maxRank, declutter, LOOK };
})();

const MapDetail = (() => {
    const C = MapDetailCore;
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : {});
    if (!W.document || typeof W.L === "undefined") return { core: C, googleLayer: null };
    const L = W.L;
    // core.js's globals: script-scope lexicals, visible here by name (not as window properties)
    const lmap = () => (typeof map !== "undefined" ? map : null);
    const origin = () => (typeof MU_SERVER_ORIGIN === "string" ? MU_SERVER_ORIGIN : "");
    const cfg = W.MU_CONFIG || {};

    // ------------------------------------------------------------ 1. places
    /** @type {Map<string, any[]>} */ const tiles = new Map();
    const pending = new Set();
    let layer = /** @type {any} */ (null), style = "satellite", timer = 0, retry = 0;
    const SHOW_ON = new Set(["satellite", "dark", "terrain", "amoled"]);   // amoled: Ride Focus (js/ridefocus.js)

    function ensureLayer(m) {
        if (layer) return layer;
        if (!m.getPane("mu-places")) {
            m.createPane("mu-places");
            const pane = m.getPane("mu-places");
            pane.style.zIndex = "590";                        // over routes (400), under markers (600)
        }
        layer = L.layerGroup().addTo(m);
        return layer;
    }

    const driving = () => Boolean(W.NavCamera && W.NavCamera.active);
    const esc = (/** @type {string} */ s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c] || c));

    function icon(p) {
        const [glyph, colour] = C.LOOK[p.kind] || C.LOOK.other;
        const label = esc(p.en ? `${p.name} · ${p.en}` : p.name);
        const html = p.kind === "area"
            ? `<span class="mu-place area">${label}</span>`
            : `<span class="mu-place k-${p.kind}"><i style="background:${colour}">${glyph}</i><b style="color:${colour}">${label}</b></span>`;
        return L.divIcon({ className: "mu-place-icon", html, iconSize: [0, 0], iconAnchor: [0, 0] });
    }

    function render() {
        const m = lmap();
        if (!m) return;
        const lay = ensureLayer(m);
        lay.clearLayers();
        const z = m.getZoom();
        const rmax = C.maxRank(z, driving());
        if (!SHOW_ON.has(style) || rmax === 0) return;
        const b = m.getBounds().pad(0.15);
        const seen = new Set();
        const cand = [];
        for (const k of C.tilesFor({ s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() }, 64)) {
            for (const p of tiles.get(k) || []) {
                if (p.rank > rmax || seen.has(p.id) || !b.contains([p.lat, p.lng])) continue;
                seen.add(p.id);
                const pt = m.latLngToContainerPoint([p.lat, p.lng]);
                cand.push({ ...p, x: pt.x, y: pt.y });
            }
        }
        for (const p of C.declutter(cand, driving() ? 40 : 120)) {
            const mk = L.marker([p.lat, p.lng], { icon: icon(p), pane: "mu-places", keyboard: false, interactive: p.kind !== "area" });
            // the "Share place" button: js/passport/place-share.js (the phone's share menu, with a preview first)
            const shareBtn = W.MUPlaceShare && W.MUPlaceShare.button ? `<br>${W.MUPlaceShare.button({ lat: p.lat, lng: p.lng, name: p.en || p.name, kind: p.kind })}` : "";
            if (p.kind !== "area") mk.bindPopup(`<strong>${esc(p.name)}</strong>${p.en ? `<br>${esc(p.en)}` : ""}<br><small>${esc(p.kind)} · © OpenStreetMap contributors</small>${shareBtn}`, { closeButton: false });
            lay.addLayer(mk);
        }
    }

    async function load() {
        const m = lmap();
        if (!m || !SHOW_ON.has(style) || C.maxRank(m.getZoom(), false) === 0) { render(); return; }
        const b = m.getBounds();
        const want = C.tilesFor({ s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() }, 12).filter((k) => !tiles.has(k) && !pending.has(k));
        render();
        if (!want.length || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
        want.forEach((k) => pending.add(k));
        let again = false;
        try {
            const r = await fetch(`${origin()}/api/map/places?tiles=${want.join(",")}`);
            const j = r.ok ? await r.json() : null;
            for (const k of want) {
                const t = j && j.tiles && j.tiles[k];
                if (t && Array.isArray(t.places)) {
                    tiles.set(k, t.places);
                    if (tiles.size > 400) tiles.delete(/** @type {string} */ (tiles.keys().next().value));
                } else again = true;                          // busy or failed: ask again shortly
            }
        } catch (e) {
            again = true;
        } finally {
            want.forEach((k) => pending.delete(k));
        }
        render();
        if (again && retry < 5) { retry++; setTimeout(load, 2500 * retry); } else if (!again) retry = 0;
    }
    const schedule = () => { clearTimeout(timer); timer = setTimeout(load, 350); };

    // ------------------------------------------------------------ 2. Google
    let googleLayer = /** @type {any} */ (null);
    if (cfg.googleTiles) {
        googleLayer = L.tileLayer(`${origin()}/api/map/gtile/satellite/{z}/{x}/{y}`, { maxZoom: 21, maxNativeZoom: 21, attribution: "Map data &copy; Google" });
        const logo = document.createElement("div");
        logo.className = "mu-google-logo";
        logo.textContent = "Google";
        logo.hidden = true;
        let attrTimer = 0, lastAttr = "";
        const attribution = async () => {
            const m = lmap();
            if (!m || !m.hasLayer(googleLayer)) return;
            const b = m.getBounds();
            try {
                const r = await fetch(`${origin()}/api/map/gattr?type=satellite&zoom=${Math.round(m.getZoom())}&n=${b.getNorth().toFixed(5)}&s=${b.getSouth().toFixed(5)}&e=${b.getEast().toFixed(5)}&w=${b.getWest().toFixed(5)}`);
                const j = r.ok ? await r.json() : null;
                const text = j && j.copyright ? esc(j.copyright) : "Map data &copy; Google";       // Google's line carries its own ©
                if (text !== lastAttr && m.attributionControl) { m.attributionControl.removeAttribution(lastAttr || "Map data &copy; Google"); m.attributionControl.addAttribution(text); lastAttr = text; }
            } catch (e) { /* keep the last line */ }
        };
        googleLayer.on("add", () => { logo.hidden = false; attribution(); });
        googleLayer.on("remove", () => { logo.hidden = true; const m = lmap(); if (m && m.attributionControl && lastAttr) m.attributionControl.removeAttribution(lastAttr); lastAttr = ""; });
        document.addEventListener("DOMContentLoaded", () => document.body.appendChild(logo));
        if (document.body) document.body.appendChild(logo);
        const m = lmap();
        if (m) m.on("moveend", () => { clearTimeout(attrTimer); attrTimer = setTimeout(attribution, 800); });
        // the style menu gets a "Google" choice (controls.js switches it like the others)
        const menu = document.getElementById("map-style-menu");
        const after = menu && menu.querySelector('button[data-style="terrain"]');
        if (after) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.dataset.style = "google";
            btn.setAttribute("role", "menuitemradio");
            btn.setAttribute("aria-checked", "false");
            btn.textContent = "Google";
            after.after(btn);
        }
    }

    // ------------------------------------------------------------ wiring
    const m = lmap();
    if (m) {
        m.on("moveend zoomend", schedule);
        document.addEventListener("mu:map-style", (e) => { style = (/** @type {CustomEvent} */ (e).detail || {}).style || style; schedule(); });
        document.addEventListener("mu:drive-state", schedule);
        schedule();
    }

    return { core: C, googleLayer, refresh: schedule, get count() { return layer ? layer.getLayers().length : 0; } };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).MapDetail = MapDetail;
if (typeof module === "object" && module.exports) module.exports = { MapDetailCore };
