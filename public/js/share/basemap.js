// @ts-check
/* ============================================================================
   MapUnite share — a real map behind the route on the recap card
   ==============================================================================
   MUShare.basemap.render(geo, w, h, { inset, theme }) → Promise<null | { canvas, pts, attribution }>

   Draws the map tiles around the route into a w × h canvas, and returns the
   route's points in that canvas (Web Mercator, so the line sits exactly on its
   roads). The tiles are the ones the app's Dark style already uses (CARTO,
   OpenStreetMap data: data/sources.json), at 2× for a crisp 1080-px card.
     theme "dark"   CARTO Dark Matter (Bento)
     theme "light"  CARTO Voyager (Glass and Verse, which restyle it)
   Tiles load with crossOrigin="anonymous": one that comes without CORS
   headers simply doesn't load (the canvas never gets "tainted", so Share and
   Save keep working). Offline, the service worker's tile cache answers; tiles
   that can't load leave the background, and with none at all render() gives
   null and the card draws its dotted grid instead. Nothing is uploaded.
   The map shows only the area of the line the card draws: with the start and
   finish hidden (the default), the streets around them aren't on it either.

   Pure and tested: mercator(), fitZoom(), tilesFor().
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUShare || (/** @type {any} */ (root).MUShare = {}); ns.basemap = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const TILE = 256;
    const THEMES = Object.freeze({
        dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        light: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png"
    });
    const ATTRIBUTION = "© OpenStreetMap contributors © CARTO";
    const MAX_TILES = 64;

    /** Web Mercator world pixels at a zoom (256-px tiles). @param {number} lat @param {number} lng @param {number} z */
    function mercator(lat, lng, z) {
        const s = TILE * 2 ** z;
        const sin = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180);
        return [((lng + 180) / 360) * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
    }

    /**
     * The largest zoom (≤ maxZoom) at which the route fits the box minus the inset, and the pixel offset that centres it.
     * @param {Array<{lat:number,lng:number}>} geo @param {number} w @param {number} h @param {number} inset @param {number} [maxZoom]
     */
    function fitZoom(geo, w, h, inset, maxZoom = 17) {
        let z = maxZoom;
        for (; z > 2; z--) {
            const p = geo.map((g) => mercator(g.lat, g.lng, z));
            const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
            if (Math.max(...xs) - Math.min(...xs) <= w - 2 * inset && Math.max(...ys) - Math.min(...ys) <= h - 2 * inset) break;
        }
        const p = geo.map((g) => mercator(g.lat, g.lng, z));
        const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
        const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
        // origin: the world pixel at the box's top-left corner
        return { z, ox: cx - w / 2, oy: cy - h / 2, pts: p.map(([x, y]) => [x - (cx - w / 2), y - (cy - h / 2)]) };
    }

    /**
     * Between whole zooms: scale the map (1–2×, where 2× tiles stay sharp) so the route fills the box. Pure.
     * @param {{ z: number, pts: number[][] }} f fitZoom's answer @param {number} w @param {number} h @param {number} inset
     */
    function scaled(f, w, h, inset) {
        const xs = f.pts.map((p) => p[0]), ys = f.pts.map((p) => p[1]);
        const ex = Math.max(1, Math.max(...xs) - Math.min(...xs)), ey = Math.max(1, Math.max(...ys) - Math.min(...ys));
        const s = Math.max(1, Math.min(2, (w - 2 * inset) / ex, (h - 2 * inset) / ey));
        const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;   // in box pixels at zoom z
        // world origin of the scaled box, and the points in the w × h canvas
        const ox0 = /** @type {any} */ (f).ox + cx - w / (2 * s), oy0 = /** @type {any} */ (f).oy + cy - h / (2 * s);
        return { s, ox: ox0, oy: oy0, pts: f.pts.map(([x, y]) => [(x - cx) * s + w / 2, (y - cy) * s + h / 2]) };
    }

    /** The tiles covering a box at a zoom. @param {number} z @param {number} ox @param {number} oy @param {number} w @param {number} h */
    function tilesFor(z, ox, oy, w, h) {
        const n = 2 ** z, out = [];
        for (let ty = Math.floor(oy / TILE); ty <= Math.floor((oy + h) / TILE); ty++) {
            if (ty < 0 || ty >= n) continue;
            for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + w) / TILE); tx++) {
                out.push({ x: ((tx % n) + n) % n, y: ty, dx: tx * TILE - ox, dy: ty * TILE - oy });
            }
        }
        return out;
    }

    /** @param {string} tpl @param {{x:number,y:number}} t @param {number} z */
    const urlOf = (tpl, t, z) => tpl.replace("{s}", "abcd"[(t.x + t.y) % 4]).replace("{z}", String(z)).replace("{x}", String(t.x)).replace("{y}", String(t.y));

    /** @param {string} url @param {number} timeoutMs @returns {Promise<HTMLImageElement|null>} */
    function load(url, timeoutMs) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            const timer = setTimeout(() => { img.src = ""; resolve(null); }, timeoutMs);
            img.onload = () => { clearTimeout(timer); resolve(img); };
            img.onerror = () => { clearTimeout(timer); resolve(null); };
            img.src = url;
        });
    }

    const memo = new Map();
    /**
     * @param {Array<{lat:number,lng:number}>} geo the points the card draws (already trimmed for privacy)
     * @param {number} w @param {number} h
     * @param {{ inset?: number, theme?: "dark"|"light", timeoutMs?: number, focus?: { x: number, y: number, w: number, h: number } }} [o]
     */
    async function render(geo, w, h, o = {}) {
        if (typeof document === "undefined" || !Array.isArray(geo) || geo.length < 2) return null;
        const theme = o.theme === "light" ? "light" : "dark", inset = o.inset ?? 80;
        const key = `${theme}|${w}|${h}|${inset}|${o.focus ? [o.focus.x, o.focus.y, o.focus.w, o.focus.h].join(",") : ""}|${geo.length}|${geo[0].lat},${geo[0].lng}|${geo[geo.length - 1].lat},${geo[geo.length - 1].lng}`;
        if (memo.has(key)) return memo.get(key);
        // the route is fitted into `focus` (a part of the canvas, e.g. above a panel); the map still fills all of it
        const F = o.focus || { x: 0, y: 0, w, h };
        const place = (/** @type {number} */ maxZ) => {
            const f = fitZoom(geo, F.w, F.h, inset, maxZ);
            const v = scaled(f, F.w, F.h, inset);
            const ox = v.ox - F.x / v.s, oy = v.oy - F.y / v.s;
            return { z: f.z, s: v.s, ox, oy, pts: v.pts.map(([x, y]) => [x + F.x, y + F.y]), tiles: tilesFor(f.z, ox, oy, w / v.s, h / v.s) };
        };
        let pl = place(17);
        while (pl.tiles.length > MAX_TILES && pl.z > 3) pl = place(pl.z - 1);   // a huge box: one zoom out, same centre
        const z = pl.z, pts = pl.pts, tiles = pl.tiles, v = { s: pl.s };
        const imgs = await Promise.all(tiles.map((t) => load(urlOf(THEMES[theme], t, z), o.timeoutMs || 5000)));
        if (!imgs.some(Boolean)) return null;
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
        ctx.fillStyle = theme === "dark" ? "#0e0e0e" : "#e8e6e1"; ctx.fillRect(0, 0, w, h);
        // 2× tiles drawn at up to 2× scale stay sharp
        tiles.forEach((t, i) => { const im = imgs[i]; if (im) ctx.drawImage(im, t.dx * v.s, t.dy * v.s, TILE * v.s + 0.5, TILE * v.s + 0.5); });
        const out = { canvas: c, pts, attribution: ATTRIBUTION, zoom: z };
        if (memo.size > 12) memo.delete(/** @type {string} */ (memo.keys().next().value));
        memo.set(key, out);
        return out;
    }

    return { TILE, THEMES, ATTRIBUTION, mercator, fitZoom, scaled, tilesFor, render };
});
