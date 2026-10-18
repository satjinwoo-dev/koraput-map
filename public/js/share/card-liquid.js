// @ts-check
/* ============================================================================
   MapUnite share — liquid-glass cards (Lens, Gauge, Poster) and the Passport card
   ==============================================================================
   MUShare.liquid.draw(style, canvas, card, o, R)        style: "lens" | "gauge" | "poster"
   MUShare.liquid.drawPassport(canvas, passportCard, { style, photo })   the same three looks for the Rider Passport

     lens    real refractive glass: the background (the rider's photo, the map,
             or an iridescent chrome ribbon) is bent at the glass edges,
             magnified slightly inside, and split into colour fringes
             (chromatic aberration), with a specular rim. Inside: thin, light
             typography (big distance, a speed-shape wave line, three figures,
             an eco-score slider, the route in a small lens).
     gauge   a glass instrument dial over the dark map: the distance in the
             middle, the eco score as a red-to-blue arc with ticks, glass pills
             for time, average speed and cost. No top speed, anywhere.
     poster  kinetic type: one huge condensed word on a pale lavender ground,
             the route glowing across it, monospace labels in the corners.
   refract() works on pixels once per card (cached), so previews and the motion
   stay smooth. Photos are redrawn: no EXIF/GPS in the exported image.
   Pure and tested: sdfRoundRect(), refractSample(), ribbonPaths(), posterWord(), passportWord(), passportFigures().
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUShare || (/** @type {any} */ (root).MUShare = {}); ns.liquid = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const STYLES = Object.freeze(["lens", "gauge", "poster"]);
    const THIN = `"Inter", system-ui, sans-serif`, DISPLAY = `"Sora", "Inter", system-ui, sans-serif`;
    const CONDENSED = `"Anton", "Bebas Neue", "Roboto Condensed", "sans-serif-condensed", Impact, sans-serif`;
    const MONO = `"JetBrains Mono", "SFMono-Regular", "Roboto Mono", ui-monospace, monospace`;

    // ------------------------------------------------------------------ pure helpers
    /**
     * Signed distance to a rounded rectangle centred at 0 (negative inside), and the outward normal. Pure.
     * @param {number} px @param {number} py @param {number} hw half width @param {number} hh half height @param {number} r corner radius
     */
    function sdfRoundRect(px, py, hw, hh, r) {
        const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
        const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
        const d = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
        let nx, ny;
        if (qx > 0 && qy > 0) { const l = Math.hypot(qx, qy) || 1; nx = (qx / l) * Math.sign(px || 1); ny = (qy / l) * Math.sign(py || 1); }
        else if (qx > qy) { nx = Math.sign(px || 1); ny = 0; }
        else { nx = 0; ny = Math.sign(py || 1); }
        return { d, nx, ny };
    }

    /**
     * Where a glass pixel looks into the background: magnified toward the centre, bent outward near the edge
     * (strongest at the rim, fading over `band` px). Pure. Returns the sample offset from the glass centre.
     * @param {number} px @param {number} py offset from the glass centre @param {number} depth distance inside the edge (≥ 0)
     * @param {number} nx @param {number} ny outward normal @param {{ band: number, strength: number, mag: number }} o
     */
    function refractSample(px, py, depth, nx, ny, o) {
        const e = Math.max(0, 1 - depth / o.band);
        const k = e * e * o.strength;
        return { x: px * (1 - o.mag) + nx * k, y: py * (1 - o.mag) + ny * k, k };
    }

    /** A seeded PRNG (mulberry32). @param {number} seed */
    function rng(seed) {
        let a = (seed >>> 0) || 0x2545f491;
        return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }

    /** The chrome ribbon's curves (control points), seeded so a ride always gets the same art. Pure. @param {number} seed @param {number} W @param {number} H */
    function ribbonPaths(seed, W, H) {
        const r = rng(seed);
        const out = [];
        const tilt = (r() - 0.5) * 0.5;
        for (let i = 0; i < 5; i++) {
            const y0 = H * (0.62 + tilt + (r() - 0.5) * 0.18), y3 = H * (0.18 - tilt + (r() - 0.5) * 0.18);
            out.push({
                p0: [-W * 0.2, y0], p1: [W * (0.25 + r() * 0.2), H * (0.2 + r() * 0.6)],
                p2: [W * (0.55 + r() * 0.2), H * (0.3 + r() * 0.5)], p3: [W * 1.2, y3],
                width: W * (0.08 + r() * 0.16), hue: i
            });
        }
        return out;
    }

    /** The poster's word: the ride's title word, upper-case, ≤ 8 letters (MORNING, EVENING, …), or RIDE. Pure. @param {any} card */
    function posterWord(card) {
        const w = String(card.title || "").split(/\s+/)[0].toUpperCase().replace(/[^A-Z]/g, "");
        return w && w.length <= 8 ? w : "RIDE";
    }

    // ------------------------------------------------------------------ drawing helpers
    function rr(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
    function text(ctx, s, x, y, font, fill, align = "left", spacing = 0) {
        ctx.font = font; ctx.fillStyle = fill; ctx.textAlign = align; ctx.textBaseline = "alphabetic";
        if ("letterSpacing" in ctx) ctx.letterSpacing = `${spacing}px`;
        ctx.fillText(s, x, y);
        const w = ctx.measureText(s).width;
        if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
        return w;
    }
    function fit(ctx, s, weight, family, size, maxW) {
        let px = size;
        for (; px > 14; px -= 2) { ctx.font = `${weight} ${px}px ${family}`; if (ctx.measureText(s).width <= maxW) break; }
        return `${weight} ${px}px ${family}`;
    }
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const ease = (x) => 1 - (1 - clamp01(x)) ** 3;
    const phase = (t, d, s = 0.3) => ease((t - d) / s);

    /** The iridescent chrome ribbon on a pale ground (the liquidGL demo look). */
    function ribbon(ctx, W, H, seed, dark = false) {
        ctx.fillStyle = dark ? "#06070c" : "#e9ebf0"; ctx.fillRect(0, 0, W, H);
        const paths = ribbonPaths(seed, W, H);
        const stroke = (p, width, style, blur) => {
            ctx.save();
            if (blur && "filter" in ctx) ctx.filter = `blur(${blur}px)`;
            ctx.beginPath(); ctx.moveTo(p.p0[0], p.p0[1]); ctx.bezierCurveTo(p.p1[0], p.p1[1], p.p2[0], p.p2[1], p.p3[0], p.p3[1]);
            ctx.lineCap = "round"; ctx.lineWidth = width; ctx.strokeStyle = style; ctx.stroke();
            ctx.restore();
        };
        const pal = [["#0ea5e9", "#1d4ed8", "#7c3aed"], ["#22d3ee", "#2563eb", "#c084fc"], ["#38bdf8", "#4338ca", "#f0abfc"], ["#67e8f9", "#1e40af", "#a78bfa"], ["#a5f3fc", "#3b82f6", "#e879f9"]];
        paths.forEach((p, i) => {
            const g = ctx.createLinearGradient(p.p0[0], p.p0[1], p.p3[0], p.p3[1]);
            const c = pal[i % pal.length];
            g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.2, c[0]); g.addColorStop(0.5, c[1]); g.addColorStop(0.75, c[2]); g.addColorStop(1, "rgba(255,255,255,0)");
            stroke(p, p.width, g, 10);
            stroke(p, p.width * 0.32, "rgba(255,255,255,0.85)", 6);              // the chrome highlight
            stroke(p, p.width * 0.08, "rgba(10,14,40,0.55)", 2);                 // a dark fold
        });
    }

    /** The background each style refracts: photo, else map, else ribbon. Returns a canvas W × H. */
    function background(W, H, card, o, R, look) {
        const c = mk(W, H), ctx = c.getContext("2d");
        if (o.photo) {
            const f = R.cover(o.photo.naturalWidth || o.photo.width, o.photo.naturalHeight || o.photo.height, W, H);
            ctx.drawImage(o.photo, f.x, f.y, f.w, f.h);
        } else if (o.map && o.map.canvas && look !== "ribbon") {
            ctx.drawImage(o.map.canvas, 0, 0, W, H);
        } else ribbon(ctx, W, H, Math.floor((card.startedAt || 0) / 1000) + 3, look === "dark");
        return c;
    }

    /**
     * Refract the background inside a glass shape. Returns a canvas of the shape's box with transparent outside.
     * @param {HTMLCanvasElement} bg @param {{x:number,y:number,w:number,h:number}} b @param {{ r?: number, circle?: boolean, band?: number, strength?: number, mag?: number, chroma?: number, frost?: number }} s
     */
    function refract(bg, b, s) {
        const band = s.band || 70, strength = s.strength || 46, mag = s.mag ?? 0.07, chroma = s.chroma ?? 0.35;
        let src = bg;
        if (s.frost && "filter" in bg.getContext("2d")) {                      // a light frost first, like tinted glass
            src = mk(bg.width, bg.height);
            const fc = src.getContext("2d"); fc.filter = `blur(${s.frost}px)`; fc.drawImage(bg, 0, 0); fc.filter = "none";
        }
        const W = bg.width, H = bg.height;
        const sd = src.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data;
        const out = mk(b.w, b.h), oc = out.getContext("2d");
        const img = oc.createImageData(b.w, b.h), d = img.data;
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2, hw = b.w / 2, hh = b.h / 2, r = s.circle ? Math.min(hw, hh) : (s.r || 60);
        const at = (x, y, ch) => {
            const xi = Math.max(0, Math.min(W - 1, Math.round(x))), yi = Math.max(0, Math.min(H - 1, Math.round(y)));
            return sd[(yi * W + xi) * 4 + ch];
        };
        const o = { band, strength, mag };
        for (let y = 0; y < b.h; y++) {
            for (let x = 0; x < b.w; x++) {
                const px = x - hw + 0.5, py = y - hh + 0.5;
                let dist, nx, ny;
                if (s.circle) { const l = Math.hypot(px, py) || 1; dist = l - r; nx = px / l; ny = py / l; }
                else { const q = sdfRoundRect(px, py, hw, hh, r); dist = q.d; nx = q.nx; ny = q.ny; }
                if (dist > 0) continue;
                const depth = -dist;
                const sp = refractSample(px, py, depth, nx, ny, o);
                const sx = cx + sp.x, sy = cy + sp.y, cs = sp.k * chroma;
                const i = (y * b.w + x) * 4;
                d[i] = at(sx + nx * cs, sy + ny * cs, 0);
                d[i + 1] = at(sx, sy, 1);
                d[i + 2] = at(sx - nx * cs, sy - ny * cs, 2);
                d[i + 3] = Math.round(255 * clamp01(depth / 1.5));
            }
        }
        oc.putImageData(img, 0, 0);
        return out;
    }

    /** Glass finishing: a tint, the specular rim and an inner shadow, over a refracted shape already drawn at b. */
    function glassFinish(ctx, b, s) {
        ctx.save();
        if (s.circle) { ctx.beginPath(); ctx.arc(b.x + b.w / 2, b.y + b.h / 2, Math.min(b.w, b.h) / 2, 0, Math.PI * 2); }
        else rr(ctx, b.x, b.y, b.w, b.h, s.r || 60);
        ctx.clip();
        ctx.fillStyle = s.tint || "rgba(255,255,255,0.08)"; ctx.fillRect(b.x, b.y, b.w, b.h);
        const sheen = ctx.createLinearGradient(b.x, b.y, b.x + b.w * 0.6, b.y + b.h * 0.6);
        sheen.addColorStop(0, "rgba(255,255,255,0.32)"); sheen.addColorStop(0.35, "rgba(255,255,255,0.04)"); sheen.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = sheen; ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.restore();
        ctx.save();
        const rim = ctx.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h);
        rim.addColorStop(0, "rgba(255,255,255,0.95)"); rim.addColorStop(0.45, "rgba(255,255,255,0.15)"); rim.addColorStop(0.8, "rgba(255,255,255,0.35)"); rim.addColorStop(1, "rgba(255,255,255,0.8)");
        ctx.lineWidth = s.rimW || 2.5; ctx.strokeStyle = rim;
        if (s.circle) { ctx.beginPath(); ctx.arc(b.x + b.w / 2, b.y + b.h / 2, Math.min(b.w, b.h) / 2 - 1, 0, Math.PI * 2); } else rr(ctx, b.x + 1, b.y + 1, b.w - 2, b.h - 2, (s.r || 60) - 1);
        ctx.stroke();
        ctx.restore();
    }

    const cache = new Map();
    const photoIds = typeof WeakMap === "function" ? new WeakMap() : null;
    let seq = 0;
    const pid = (p) => (!p ? "-" : !photoIds ? "p" : (photoIds.has(p) || photoIds.set(p, ++seq), "p" + photoIds.get(p)));
    /** Background + refracted glass, computed once per ride/photo/map/size/shape and reused (motion frames, previews). */
    function scene(key, make) {
        if (cache.has(key)) return cache.get(key);
        const v = make();
        if (cache.size > 8) cache.delete(cache.keys().next().value);
        cache.set(key, v);
        return v;
    }

    /** The route as a line (absolute points from the map, or fitted), optional reveal. */
    function routeLine(ctx, card, box, R, look, pts, reveal = 1) {
        if (!card.route || card.route.pts.length < 2 || reveal <= 0) return false;
        let P = pts ? pts : R.fitRoute(card.route.pts, box, look.inset || 24);
        if (reveal < 1) P = P.slice(0, Math.max(2, Math.ceil(P.length * reveal)));
        ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round";
        const path = () => { ctx.beginPath(); P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); };
        if (look.glow) { ctx.shadowColor = look.glow; ctx.shadowBlur = look.blur || 30; }
        const g = ctx.createLinearGradient(P[0][0], P[0][1], P[P.length - 1][0], P[P.length - 1][1]);
        g.addColorStop(0, look.from); g.addColorStop(1, look.to);
        path(); ctx.strokeStyle = g; ctx.lineWidth = look.width; ctx.stroke();
        ctx.shadowBlur = 0;
        if (look.core) { path(); ctx.strokeStyle = look.core; ctx.lineWidth = look.width * 0.3; ctx.stroke(); }
        const [ex, ey] = P[P.length - 1];
        ctx.beginPath(); ctx.arc(ex, ey, look.width * 1.3, 0, Math.PI * 2); ctx.fillStyle = look.to; ctx.fill();
        ctx.restore();
        return true;
    }

    /** The speed shape as a smooth wave (like a heart-rate trace). */
    function wave(ctx, vals, x, y, w, h, color, reveal = 1) {
        if (!vals || vals.length < 2) return false;
        const n = Math.max(2, Math.ceil(vals.length * clamp01(reveal)));
        const pts = vals.slice(0, n).map((v, i) => [x + (i / (vals.length - 1)) * w, y + h - v * h]);
        ctx.save(); ctx.lineWidth = 3; ctx.strokeStyle = color; ctx.lineJoin = "round"; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) { const [px, py] = pts[i - 1], [qx, qy] = pts[i]; ctx.quadraticCurveTo(px, py, (px + qx) / 2, (py + qy) / 2); }
        ctx.stroke(); ctx.restore();
        return true;
    }

    // ------------------------------------------------------------------ Lens
    function drawLens(canvas, card0, o, R, S) {
        const t = o.t === undefined ? 1 : o.t, card = S ? S.motionCard(card0, t) : card0;
        const fmt = o.format === "post" ? "post" : "story", W = 1080, H = fmt === "post" ? 1350 : 1920;
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d");
        const G = fmt === "post" ? { x: 110, y: 150, w: 860, h: 1050 } : { x: 90, y: 260, w: 900, h: 1300 };
        const look = o.photo ? "photo" : o.map ? "map" : "ribbon";
        const sc = scene(`lens|${card0.startedAt}|${fmt}|${pid(o.photo)}|${o.map ? o.map.zoom + "," + o.map.pts.length : "-"}|${look}`, () => {
            const bg = background(W, H, card0, o, R, look);
            // on the map, the route is part of what the glass bends
            if (look === "map") routeLine(bg.getContext("2d"), card0, null, R, { from: "#22d3ee", to: "#a78bfa", glow: "rgba(34,211,238,0.9)", width: 12, core: "#ffffff" }, o.map.pts);
            return { bg, glass: refract(bg, G, { r: 70, band: 80, strength: 54, mag: 0.06, chroma: 0.45, frost: look === "ribbon" ? 2 : 6 }) };
        });
        ctx.drawImage(sc.bg, 0, 0);
        const dark = look !== "ribbon";
        const ink = dark ? "#ffffff" : "#0f172a", inkSoft = dark ? "rgba(255,255,255,0.72)" : "rgba(15,23,42,0.62)";
        const a = phase(t, 0.08, 0.35), lift = (1 - a) * 80;
        ctx.save(); ctx.globalAlpha = a; ctx.translate(0, lift);
        ctx.drawImage(sc.glass, G.x, G.y);
        glassFinish(ctx, G, { r: 70, tint: dark ? "rgba(10,14,24,0.30)" : "rgba(255,255,255,0.28)" });
        const px = G.x + 64, inner = G.w - 128;
        const date = new Intl.DateTimeFormat(o.locale || "en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
        text(ctx, `${card.title.toUpperCase()}`, px, G.y + 92, `400 26px ${THIN}`, inkSoft, "left", 4);
        text(ctx, `${date.format(new Date(card.startedAt))} – ${date.format(new Date(card.endedAt))}`, G.x + G.w - 64, G.y + 92, `500 28px ${THIN}`, ink, "right");
        ctx.fillStyle = dark ? "rgba(255,255,255,0.35)" : "rgba(15,23,42,0.25)"; ctx.fillRect(px, G.y + 122, inner * 0.42, 2);
        const st = R.stats(card, o.units, o.showCost !== false);
        const bigY = G.y + (fmt === "post" ? 370 : 470);
        text(ctx, "DISTANCE", px, bigY - (fmt === "post" ? 200 : 250), `300 38px ${THIN}`, inkSoft, "left", 3);
        const vw = text(ctx, st[0].value, px - 8, bigY, `200 ${fmt === "post" ? 230 : 300}px ${THIN}`, ink, "left", -8);
        text(ctx, "KM", px + vw + 14, bigY, `300 40px ${THIN}`, inkSoft, "left", 4);
        if (card.caption) text(ctx, card.caption, px, bigY + 58, fit(ctx, card.caption, 300, THIN, 34, inner), inkSoft);
        // the speed shape, like a heart-rate trace
        const wy = bigY + (fmt === "post" ? 90 : 120), wh = fmt === "post" ? 90 : 130;
        if (!wave(ctx, card0.speeds, px, wy, inner, wh, ink, phase(t, 0.15, 0.55))) routeLine(ctx, card, { x: px, y: wy - 20, w: inner, h: wh + 40 }, R, { from: ink, to: ink, width: 4, inset: 10 }, null, phase(t, 0.15, 0.55));
        // three figures
        const fy = wy + wh + (fmt === "post" ? 90 : 120), cw = inner / 3;
        [[st[3].label, st[3].value, st[3].unit], ["Eco score", card.ecoScore === null ? "–" : String(Math.round(card.ecoScore * 100)), ""], [st[2].label, st[2].value, st[2].unit]].forEach(([l, v, u], i) => {
            const x = px + i * cw;
            text(ctx, l.toUpperCase(), x, fy, `400 22px ${THIN}`, inkSoft, "left", 2.5);
            const w2 = text(ctx, v, x, fy + 64, fit(ctx, v, 300, THIN, 58, cw - 70), ink);
            if (u) text(ctx, u, x + w2 + 8, fy + 64, `300 24px ${THIN}`, inkSoft);
        });
        // an eco-score slider (the volume-slider look) and the route in a small lens
        const sy = G.y + G.h - (fmt === "post" ? 120 : 150);
        if (fmt !== "post" || true) {
            const sx = px, sw = card0.route ? inner - 190 : inner;
            rr(ctx, sx, sy - 34, sw, 68, 34); ctx.fillStyle = dark ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.45)"; ctx.fill();
            ctx.lineWidth = 1.5; ctx.strokeStyle = dark ? "rgba(255,255,255,0.3)" : "rgba(15,23,42,0.15)"; ctx.stroke();
            text(ctx, card.reports ? "REPORTS" : "ECO", sx + 30, sy + 9, `500 22px ${THIN}`, inkSoft, "left", 2);
            const tx0 = sx + 150, tw = sw - 260, k = card.reports ? Math.min(1, card.reports.published / Math.max(1, card.reports.reviewed)) : (card.ecoScore || 0);
            ctx.fillStyle = dark ? "rgba(255,255,255,0.25)" : "rgba(15,23,42,0.18)"; ctx.fillRect(tx0, sy - 2, tw, 4);
            ctx.fillStyle = ink; ctx.fillRect(tx0, sy - 2, tw * k, 4);
            ctx.beginPath(); ctx.arc(tx0 + tw * k, sy, 13, 0, Math.PI * 2); ctx.fillStyle = "#ffffff"; ctx.fill();
            ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(0,0,0,0.18)"; ctx.stroke();
            text(ctx, card.reports ? `${card.reports.published}/${card.reports.reviewed}` : String(card.ecoScore === null ? "–" : Math.round(card.ecoScore * 100)), sx + sw - 30, sy + 9, `500 24px ${THIN}`, ink, "right");
            if (card0.route) {
                const lb = { x: G.x + G.w - 64 - 150, y: sy - 75, w: 150, h: 150 };
                const lg = scene(`lensdot|${card0.startedAt}|${fmt}|${pid(o.photo)}|${look}`, () => refract(sc.bg, { x: lb.x, y: lb.y - lift, w: lb.w, h: lb.h }, { circle: true, band: 40, strength: 26, mag: 0.18, chroma: 0.6 }));
                ctx.drawImage(lg, lb.x, lb.y);
                glassFinish(ctx, lb, { circle: true, tint: dark ? "rgba(10,14,24,0.35)" : "rgba(255,255,255,0.35)", rimW: 2 });
                routeLine(ctx, card, lb, R, { from: ink, to: dark ? "#a5f3fc" : "#2563eb", width: 4, inset: 34 }, null, phase(t, 0.15, 0.55));
            }
        }
        ctx.restore();
        // brand + footnote, small, outside the glass
        text(ctx, "mapunite", 90, fmt === "post" ? 96 : 150, `700 34px ${DISPLAY}`, dark ? "rgba(255,255,255,0.92)" : "#0f172a", "left", -1);
        text(ctx, R.footText(card0), W / 2, H - 48, fit(ctx, R.footText(card0), 400, THIN, 22, W - 160), dark ? "rgba(255,255,255,0.75)" : "rgba(15,23,42,0.6)", "center");
        if (look === "map") text(ctx, o.map.attribution, W - 90, fmt === "post" ? 96 : 150, `400 18px ${THIN}`, "rgba(255,255,255,0.75)", "right");
        return canvas;
    }

    // ------------------------------------------------------------------ Gauge
    function drawGauge(canvas, card0, o, R, S) {
        const t = o.t === undefined ? 1 : o.t, card = S ? S.motionCard(card0, t) : card0;
        const fmt = o.format === "post" ? "post" : "story", W = 1080, H = fmt === "post" ? 1350 : 1920;
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d");
        const D = fmt === "post" ? { cx: 540, cy: 640, r: 330 } : { cx: 540, cy: 900, r: 380 };
        const box = { x: D.cx - D.r, y: D.cy - D.r, w: 2 * D.r, h: 2 * D.r };
        const sc = scene(`gauge|${card0.startedAt}|${fmt}|${pid(o.photo)}|${o.map ? o.map.zoom : "-"}`, () => {
            const bg = mk(W, H), b = bg.getContext("2d");
            if (o.photo) { const f = R.cover(o.photo.naturalWidth || o.photo.width, o.photo.naturalHeight || o.photo.height, W, H); b.drawImage(o.photo, f.x, f.y, f.w, f.h); b.fillStyle = "rgba(3,5,10,0.45)"; b.fillRect(0, 0, W, H); }
            else if (o.map && o.map.canvas) { b.drawImage(o.map.canvas, 0, 0, W, H); b.fillStyle = "rgba(3,5,10,0.35)"; b.fillRect(0, 0, W, H); }
            else { b.fillStyle = "#04060b"; b.fillRect(0, 0, W, H); }
            for (const [x, y, rad, c] of [[0.08, 0.92, 0.7, "rgba(239,68,68,0.45)"], [0.95, 0.2, 0.7, "rgba(59,130,246,0.40)"], [0.5, 0.5, 0.45, "rgba(124,58,237,0.18)"]]) {
                const g = b.createRadialGradient(x * W, y * H, 0, x * W, y * H, rad * W); g.addColorStop(0, c); g.addColorStop(1, "rgba(0,0,0,0)"); b.fillStyle = g; b.fillRect(0, 0, W, H);
            }
            if (!o.photo && card0.route) routeLine(b, card0, { x: 60, y: 160, w: W - 120, h: H - 520 }, R, { from: "#ef4444", to: "#3b82f6", glow: "rgba(239,68,68,0.6)", width: 7, inset: 40 }, o.map ? o.map.pts : null);
            return { bg, glass: refract(bg, box, { circle: true, band: 90, strength: 60, mag: 0.1, chroma: 0.6, frost: 8 }) };
        });
        ctx.drawImage(sc.bg, 0, 0);
        const a = phase(t, 0.05, 0.35);
        ctx.save(); ctx.globalAlpha = a;
        ctx.drawImage(sc.glass, box.x, box.y);
        glassFinish(ctx, box, { circle: true, tint: "rgba(8,10,20,0.42)", rimW: 3 });
        // ticks and the eco arc (red → magenta → blue), 270°
        const a0 = Math.PI * 0.75, span = Math.PI * 1.5, rr2 = D.r - 54;
        for (let i = 0; i <= 40; i++) {
            const ang = a0 + (span * i) / 40, long = i % 5 === 0;
            ctx.beginPath(); ctx.moveTo(D.cx + Math.cos(ang) * (rr2 - (long ? 26 : 14)), D.cy + Math.sin(ang) * (rr2 - (long ? 26 : 14)));
            ctx.lineTo(D.cx + Math.cos(ang) * rr2, D.cy + Math.sin(ang) * rr2);
            ctx.lineWidth = long ? 3 : 1.5; ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.stroke();
        }
        const eco = card.ecoScore === null ? 0 : card.ecoScore;
        const g = ctx.createConicGradient ? ctx.createConicGradient(a0, D.cx, D.cy) : null;
        if (g) { g.addColorStop(0, "#ef4444"); g.addColorStop(0.3, "#d946ef"); g.addColorStop(0.6, "#3b82f6"); g.addColorStop(1, "#ef4444"); }
        ctx.beginPath(); ctx.arc(D.cx, D.cy, rr2 + 22, a0, a0 + span); ctx.lineWidth = 12; ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineCap = "round"; ctx.stroke();
        if (eco > 0) { ctx.beginPath(); ctx.arc(D.cx, D.cy, rr2 + 22, a0, a0 + span * eco); ctx.strokeStyle = g || "#d946ef"; ctx.shadowColor = "rgba(217,70,239,0.8)"; ctx.shadowBlur = 24; ctx.stroke(); ctx.shadowBlur = 0; }
        const st = R.stats(card, o.units, o.showCost !== false);
        text(ctx, st[0].value, D.cx, D.cy + D.r * 0.12, `700 ${Math.round(D.r * 0.5)}px ${DISPLAY}`, "#ffffff", "center", -3);
        text(ctx, "KM", D.cx, D.cy + D.r * 0.32, `500 ${Math.round(D.r * 0.1)}px ${THIN}`, "rgba(255,255,255,0.75)", "center", 6);
        text(ctx, `ECO ${card.ecoScore === null ? "–" : Math.round(card.ecoScore * 100)}`, D.cx, D.cy + D.r * 0.62, `500 ${Math.round(D.r * 0.075)}px ${THIN}`, "rgba(255,255,255,0.7)", "center", 4);
        ctx.restore();
        // title and glass pills
        text(ctx, "mapunite", 90, fmt === "post" ? 110 : 170, `700 36px ${DISPLAY}`, "rgba(255,255,255,0.92)", "left", -1);
        text(ctx, card.title, 90, fmt === "post" ? 190 : 270, fit(ctx, card.title, 300, THIN, 76, W - 180), "#ffffff", "left", -1);
        if (card.caption) text(ctx, card.caption, 90, fmt === "post" ? 236 : 326, fit(ctx, card.caption, 300, THIN, 34, W - 180), "rgba(255,255,255,0.75)");
        const avg = `${o.units.num(card.avgSpeed * 3.6, 0)}`;
        const pills = [["MOVING", `${st[3].value} ${st[3].unit}`], ["AVERAGE", `${avg} km/h`], [st[2].label.toUpperCase(), `${st[2].value}${st[2].unit ? " " + st[2].unit : ""}`]];
        const py = D.cy + D.r + (fmt === "post" ? 70 : 110), pw = 280, gap = 30, x0 = (W - (3 * pw + 2 * gap)) / 2;
        pills.forEach(([l, v], i) => {
            const pa = phase(t, 0.4 + i * 0.08, 0.25);
            if (pa <= 0) return;
            const b = { x: x0 + i * (pw + gap), y: py + (1 - pa) * 40, w: pw, h: 120 };
            ctx.save(); ctx.globalAlpha = pa;
            const pg = scene(`gpill|${card0.startedAt}|${fmt}|${i}|${pid(o.photo)}|${o.map ? 1 : 0}`, () => refract(sc.bg, { x: b.x, y: py, w: b.w, h: b.h }, { r: 60, band: 40, strength: 22, mag: 0.04, chroma: 0.5, frost: 10 }));
            ctx.drawImage(pg, b.x, b.y);
            glassFinish(ctx, b, { r: 60, tint: "rgba(8,10,20,0.4)", rimW: 2 });
            text(ctx, l, b.x + b.w / 2, b.y + 44, `500 20px ${THIN}`, "rgba(255,255,255,0.7)", "center", 3);
            text(ctx, v, b.x + b.w / 2, b.y + 92, fit(ctx, v, 600, DISPLAY, 40, b.w - 30), "#ffffff", "center");
            ctx.restore();
        });
        if (card.reports) text(ctx, `${card.reports.reviewed} road reports reviewed · ${card.reports.published} published`, W / 2, py + 190, `400 28px ${THIN}`, "rgba(255,255,255,0.8)", "center");
        text(ctx, R.footText({ ...card0, reports: null }), W / 2, H - 50, fit(ctx, R.footText({ ...card0, reports: null }), 400, THIN, 22, W - 160), "rgba(255,255,255,0.6)", "center");
        if (o.map && !o.photo) text(ctx, o.map.attribution, W - 90, fmt === "post" ? 110 : 170, `400 18px ${THIN}`, "rgba(255,255,255,0.65)", "right");
        return canvas;
    }

    // ------------------------------------------------------------------ Poster
    function drawPoster(canvas, card0, o, R, S) {
        const t = o.t === undefined ? 1 : o.t, card = S ? S.motionCard(card0, t) : card0;
        const fmt = o.format === "post" ? "post" : "story", W = 1080, H = fmt === "post" ? 1350 : 1920;
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ece8f6"; ctx.fillRect(0, 0, W, H);
        const glow = ctx.createRadialGradient(W * 0.3, H * 0.35, 0, W * 0.3, H * 0.35, W);
        glow.addColorStop(0, "rgba(196,181,253,0.55)"); glow.addColorStop(1, "rgba(236,232,246,0)");
        ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
        // grain
        const r = rng(Math.floor((card0.startedAt || 0) / 1000) + 5);
        ctx.fillStyle = "rgba(40,20,80,0.05)";
        for (let i = 0; i < 2600; i++) ctx.fillRect(r() * W, r() * H, 1.4, 1.4);
        // the photo, if any, as a soft cut-out bubble behind the type
        const st = R.stats(card, o.units, o.showCost !== false);
        if (o.photo) {
            const cx = W * 0.5, cy = H * (fmt === "post" ? 0.38 : 0.36), rad = W * 0.36;
            ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.clip();
            const f = R.cover(o.photo.naturalWidth || o.photo.width, o.photo.naturalHeight || o.photo.height, rad * 2, rad * 2);
            ctx.globalAlpha = phase(t, 0, 0.4);
            ctx.drawImage(o.photo, cx - rad + f.x, cy - rad + f.y, f.w, f.h);
            ctx.restore();
        }
        // the huge word, sliding in letter by letter
        const word = posterWord(card0);
        const baseY = H * (fmt === "post" ? 0.62 : 0.6);
        // Anton when it has loaded; otherwise a heavy face squeezed sideways, so the poster still reads condensed
        // (document.fonts.check() says true when no Anton face is declared at all, e.g. offline: look for a loaded face instead)
        let anton = false;
        try { if (typeof document !== "undefined" && document.fonts) for (const f of /** @type {any} */ (document.fonts)) if (String(f.family).replace(/["']/g, "") === "Anton" && f.status === "loaded") { anton = true; break; } } catch (e) { anton = false; }
        const face = anton ? `400 {px}px ${CONDENSED}` : `900 {px}px ${DISPLAY}`, squeeze = anton ? 1 : 0.58;
        ctx.font = face.replace("{px}", "100");
        const w100 = (ctx.measureText(word).width || 1) * squeeze;
        const size = Math.min((W - 80) / w100 * 100, fmt === "post" ? 420 : 520);
        ctx.save();
        ctx.font = face.replace("{px}", String(Math.round(size))); ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
        const total = ctx.measureText(word).width * squeeze;
        ctx.translate((W - total) / 2, 0); ctx.scale(squeeze, 1);
        let x = 0;
        [...word].forEach((ch, i) => {
            const la = phase(t, 0.05 + i * 0.05, 0.25);
            const cw = ctx.measureText(ch).width;
            if (la > 0) { ctx.globalAlpha = la; ctx.fillStyle = "#0b0b10"; ctx.fillText(ch, x, baseY + (1 - la) * 120); }
            x += cw;
        });
        ctx.restore();
        // the route glowing across the word
        const rb = { x: 70, y: baseY - size * 1.15, w: W - 140, h: size * 1.25 };
        routeLine(ctx, card, rb, R, { from: "#7c3aed", to: "#2563eb", glow: "rgba(124,58,237,0.7)", width: 12, core: "#f5f3ff", inset: 30 }, null, phase(t, 0.3, 0.5));
        // corner labels, like a site nav
        text(ctx, "mapunite", 64, 92, `700 40px ${DISPLAY}`, "#0b0b10", "left", -1.5);
        const nav = `[${st[0].value} KM]  [${st[3].value} ${st[3].unit.toUpperCase()}]  [ECO ${card.ecoScore === null ? "–" : Math.round(card.ecoScore * 100)}]`;
        text(ctx, nav, W - 64, 90, fit(ctx, nav, 500, MONO, 24, W - 420), "#1f1640", "right", 1);
        // left ruler ticks
        ctx.fillStyle = "rgba(31,22,64,0.55)";
        for (let i = 0; i < 26; i++) ctx.fillRect(40, 220 + i * (H - 520) / 26, i % 5 === 0 ? 18 : 9, 2);
        // the line under the word
        const sub = (card.caption || "FOLLOW THE ROAD INTO THE NEXT RIDE").toUpperCase();
        text(ctx, sub, W / 2, baseY + 80, fit(ctx, sub, 400, CONDENSED, 46, W - 200), "#2a1f55", "center", 1);
        text(ctx, new Intl.DateTimeFormat(o.locale || "en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(card.startedAt)).toUpperCase(), W / 2, baseY + 130, `500 24px ${MONO}`, "#4b3f78", "center", 2);
        // the pill controls (bottom right) and a small dark chip (bottom left)
        const pw = 120, py2 = H - 140;
        ["#a855f7", "#a855f7", "#c4b5fd", "#ddd6fe"].forEach((c, i) => { rr(ctx, W - 64 - (4 - i) * (pw + 12), py2, pw, 46, 23); ctx.fillStyle = c; ctx.fill(); });
        rr(ctx, 64, py2, 130, 46, 23); ctx.fillStyle = "#0b0b10"; ctx.fill();
        text(ctx, "RIDE", 129, py2 + 31, `600 22px ${MONO}`, "#ece8f6", "center", 2);
        if (card.reports) text(ctx, `${card.reports.reviewed} ROAD REPORTS REVIEWED · ${card.reports.published} PUBLISHED`, W / 2, py2 - 40, `500 22px ${MONO}`, "#3b2a70", "center", 1);
        text(ctx, R.footText({ ...card0, reports: null }), W / 2, H - 40, fit(ctx, R.footText({ ...card0, reports: null }), 400, THIN, 20, W - 160), "rgba(31,22,64,0.6)", "center");
        return canvas;
    }

    // ------------------------------------------------------------------ Passport (Lens, Gauge, Poster)
    const PASSPORT_STYLES = Object.freeze(["lens", "gauge", "poster"]);

    /**
     * What the Passport card shows, from MUPassportModel.forCard(): the self-reported line, the recorded/confirmed rows,
     * and the headline (distance ridden when the rider put it on the card, else the first row). Pure.
     * @param {{ sections: any[] }} card
     */
    function passportFigures(card) {
        const self = card.sections.find((s) => s.source === "self");
        const selfLine = self && self.items.length ? self.items.map((/** @type {any} */ it) => (it.id === "experience" ? `riding since ${it.value}` : it.value)).join("  ·  ") : "";
        const rows = card.sections.filter((s) => s.source !== "self").flatMap((s) => s.items.map((/** @type {any} */ it) => {
            const m = /^([\d.,]+)\s*(.*)$/.exec(it.value);
            return { id: it.id, label: it.label, value: it.value, num: m ? m[1] : it.value, unit: m ? m[2] : "", source: s.source };
        }));
        const hi = rows.findIndex((r) => r.id === "distance");
        const headline = rows.length ? rows[hi >= 0 ? hi : 0] : null;
        return { selfLine, rows, headline, rest: headline ? rows.filter((r) => r !== headline) : [] };
    }

    /** The poster's word on the Passport: the rider's first name, upper-case Latin letters, ≤ 8, or RIDER. Pure. @param {string} name */
    function passportWord(name) {
        const w = String(name || "").trim().split(/\s+/)[0].toUpperCase();
        return /^[A-Z]{2,8}$/.test(w) ? w : "RIDER";
    }

    /** The rider's photo scaled to cover a box (the Passport has no recap renderer to ask). */
    function cover(img, W, H) {
        const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        const s = Math.max(W / iw, H / ih);
        return { x: (W - iw * s) / 2, y: (H - ih * s) / 2, w: iw * s, h: ih * s };
    }
    // Anton when it has loaded (document.fonts.check() says true when no Anton face is declared at all, e.g. offline)
    function antonLoaded() {
        try { if (typeof document !== "undefined" && document.fonts) for (const f of /** @type {any} */ (document.fonts)) if (String(f.family).replace(/["']/g, "") === "Anton" && f.status === "loaded") return true; } catch (e) { /* no FontFaceSet */ }
        return false;
    }
    const PP_NOTE = "Confirmed = other riders' independent rides. Self-reported lines are the rider's own.";

    /** Lens: thin type in a refractive glass panel over the chrome ribbon or the rider's photo. */
    function passportLens(canvas, card, o) {
        const W = 1080, H = 1350;
        const ctx = canvas.getContext("2d");
        const bg = mk(W, H), b = bg.getContext("2d");
        if (o.photo) { const f = cover(o.photo, W, H); b.drawImage(o.photo, f.x, f.y, f.w, f.h); }
        else ribbon(b, W, H, o.seed || 7);
        ctx.drawImage(bg, 0, 0);
        const G = { x: 80, y: 150, w: 920, h: 1120 };
        ctx.drawImage(refract(bg, G, { r: 70, band: 80, strength: 50, mag: 0.06, chroma: 0.45, frost: o.photo ? 14 : 3 }), G.x, G.y);
        glassFinish(ctx, G, { r: 70, tint: o.photo ? "rgba(255,255,255,0.52)" : "rgba(255,255,255,0.32)" });
        const F = passportFigures(card);
        const ink = "#0f172a", soft = "rgba(15,23,42,0.6)", px = G.x + 64, inner = G.w - 128;
        text(ctx, "mapunite", 80, 100, `700 36px ${DISPLAY}`, o.photo ? "#ffffff" : ink, "left", -1);
        text(ctx, "RIDER PASSPORT", G.x + G.w - 64, G.y + 86, `400 24px ${THIN}`, soft, "right", 5);
        text(ctx, card.name || "Rider", px, G.y + 200, fit(ctx, card.name || "Rider", 200, THIN, 130, inner), ink, "left", -4);
        ctx.fillStyle = "rgba(15,23,42,0.22)"; ctx.fillRect(px, G.y + 236, inner * 0.4, 2);
        let y = G.y + 300;
        if (F.selfLine) {
            text(ctx, F.selfLine, px, y, fit(ctx, F.selfLine, 300, THIN, 34, inner), ink);
            text(ctx, "SELF-REPORTED", px, y + 40, `400 18px ${THIN}`, soft, "left", 3);
            y += 110;
        }
        const colW = inner / 2;
        F.rows.slice(0, 6).forEach((it, i) => {
            const x = px + (i % 2) * colW, yy = y + Math.floor(i / 2) * 190;
            text(ctx, it.label.toUpperCase(), x, yy, `400 20px ${THIN}`, soft, "left", 2.5);
            const w2 = text(ctx, it.num, x - 4, yy + 104, fit(ctx, it.num, 200, THIN, 110, colW - 120), ink, "left", -3);
            if (it.unit) text(ctx, it.unit, x + w2 + 8, yy + 104, `300 26px ${THIN}`, soft);
            text(ctx, it.source === "community" ? "confirmed by other riders" : "recorded by MapUnite", x, yy + 140, `400 18px ${THIN}`, it.source === "community" ? "#0e7490" : soft);
        });
        if (card.badges.length) {
            let bx = px; const by = G.y + G.h - 120;
            for (const bd of card.badges.slice(0, 4)) {
                ctx.font = `500 24px ${THIN}`;
                const w = ctx.measureText(bd.name).width + 56;
                if (bx + w > px + inner) break;
                rr(ctx, bx, by, w, 56, 28); ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(15,23,42,0.18)"; ctx.stroke();
                text(ctx, bd.name, bx + w / 2, by + 36, `500 24px ${THIN}`, ink, "center");
                bx += w + 12;
            }
        }
        text(ctx, PP_NOTE, W / 2, H - 34, `400 20px ${THIN}`, o.photo ? "rgba(255,255,255,0.85)" : "rgba(15,23,42,0.55)", "center");
    }

    /** Gauge: the headline figure in a glass dial, the other rows in glass pills, on a dark ground. */
    function passportGauge(canvas, card, o) {
        const W = 1080, H = 1350;
        const ctx = canvas.getContext("2d");
        const bg = mk(W, H), b = bg.getContext("2d");
        if (o.photo) { const f = cover(o.photo, W, H); b.drawImage(o.photo, f.x, f.y, f.w, f.h); b.fillStyle = "rgba(3,5,10,0.5)"; b.fillRect(0, 0, W, H); }
        else { ribbon(b, W, H, o.seed || 7, true); b.fillStyle = "rgba(3,5,10,0.35)"; b.fillRect(0, 0, W, H); }
        for (const [x, y, rad, c] of [[0.08, 0.92, 0.7, "rgba(239,68,68,0.40)"], [0.95, 0.15, 0.7, "rgba(59,130,246,0.38)"], [0.5, 0.45, 0.45, "rgba(124,58,237,0.16)"]]) {
            const g = b.createRadialGradient(x * W, y * H, 0, x * W, y * H, rad * W); g.addColorStop(0, c); g.addColorStop(1, "rgba(0,0,0,0)"); b.fillStyle = g; b.fillRect(0, 0, W, H);
        }
        ctx.drawImage(bg, 0, 0);
        const F = passportFigures(card);
        const white = "#ffffff", soft = "rgba(255,255,255,0.7)", cyan = "#67e8f9";
        text(ctx, "mapunite", 80, 100, `700 36px ${DISPLAY}`, "rgba(255,255,255,0.92)", "left", -1);
        text(ctx, "RIDER PASSPORT", W - 80, 98, `400 22px ${THIN}`, soft, "right", 5);
        text(ctx, card.name || "Rider", 80, 200, fit(ctx, card.name || "Rider", 200, THIN, 84, W - 160), white, "left", -2);
        if (F.selfLine) text(ctx, F.selfLine, 80, 250, fit(ctx, F.selfLine, 300, THIN, 28, W - 160), soft);
        // the dial: a full bezel (decoration, not a score: nothing on the Passport is out of 100) and the headline figure
        const D = { cx: 540, cy: 575, r: 270 };
        const box = { x: D.cx - D.r, y: D.cy - D.r, w: 2 * D.r, h: 2 * D.r };
        ctx.drawImage(refract(bg, box, { circle: true, band: 90, strength: 60, mag: 0.1, chroma: 0.6, frost: 8 }), box.x, box.y);
        glassFinish(ctx, box, { circle: true, tint: "rgba(8,10,20,0.42)", rimW: 3 });
        const rr2 = D.r - 50;
        for (let i = 0; i < 60; i++) {
            const ang = (Math.PI * 2 * i) / 60, long = i % 5 === 0;
            ctx.beginPath(); ctx.moveTo(D.cx + Math.cos(ang) * (rr2 - (long ? 24 : 12)), D.cy + Math.sin(ang) * (rr2 - (long ? 24 : 12)));
            ctx.lineTo(D.cx + Math.cos(ang) * rr2, D.cy + Math.sin(ang) * rr2);
            ctx.lineWidth = long ? 3 : 1.5; ctx.strokeStyle = "rgba(255,255,255,0.45)"; ctx.stroke();
        }
        const cg = ctx.createConicGradient ? ctx.createConicGradient(-Math.PI / 2, D.cx, D.cy) : null;
        if (cg) { cg.addColorStop(0, "#ef4444"); cg.addColorStop(0.35, "#d946ef"); cg.addColorStop(0.7, "#3b82f6"); cg.addColorStop(1, "#ef4444"); }
        ctx.beginPath(); ctx.arc(D.cx, D.cy, rr2 + 20, 0, Math.PI * 2); ctx.lineWidth = 6; ctx.strokeStyle = cg || "rgba(217,70,239,0.8)"; ctx.shadowColor = "rgba(217,70,239,0.7)"; ctx.shadowBlur = 20; ctx.stroke(); ctx.shadowBlur = 0;
        if (F.headline) {
            const hl = F.headline;
            text(ctx, hl.num, D.cx, D.cy + 40, fit(ctx, hl.num, 700, DISPLAY, Math.round(D.r * 0.5), rr2 * 1.5), white, "center", -3);
            if (hl.unit) text(ctx, hl.unit.toUpperCase(), D.cx, D.cy + 96, `500 ${Math.round(D.r * 0.1)}px ${THIN}`, soft, "center", 6);
            text(ctx, hl.label.toUpperCase(), D.cx, D.cy - 92, fit(ctx, hl.label.toUpperCase(), 500, THIN, 22, rr2 * 1.4), soft, "center", 3);
            text(ctx, hl.source === "community" ? "confirmed by other riders" : "recorded by MapUnite", D.cx, D.cy + 150, `400 20px ${THIN}`, hl.source === "community" ? cyan : "rgba(255,255,255,0.55)", "center");
        } else text(ctx, "Nothing on the card yet", D.cx, D.cy + 12, `300 34px ${THIN}`, soft, "center");
        // glass pills, two per row
        const pw = 440, ph = 116, gap = 24, x0 = (W - 2 * pw - gap) / 2, y0 = D.cy + D.r + 44;
        F.rest.slice(0, 4).forEach((it, i) => {
            const pb = { x: x0 + (i % 2) * (pw + gap), y: y0 + Math.floor(i / 2) * (ph + 20), w: pw, h: ph };
            ctx.drawImage(refract(bg, pb, { r: 58, band: 40, strength: 22, mag: 0.04, chroma: 0.5, frost: 10 }), pb.x, pb.y);
            glassFinish(ctx, pb, { r: 58, tint: "rgba(8,10,20,0.4)", rimW: 2 });
            ctx.beginPath(); ctx.arc(pb.x + 40, pb.y + 40, 6, 0, Math.PI * 2);
            if (it.source === "community") { ctx.fillStyle = cyan; ctx.fill(); } else { ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.stroke(); }
            text(ctx, it.label.toUpperCase(), pb.x + 58, pb.y + 47, fit(ctx, it.label.toUpperCase(), 500, THIN, 19, pw - 80), soft, "left", 2.5);
            const w2 = text(ctx, it.num, pb.x + 36, pb.y + 96, fit(ctx, it.num, 600, DISPLAY, 40, pw - 170), white);
            if (it.unit) text(ctx, it.unit, pb.x + 46 + w2, pb.y + 96, fit(ctx, it.unit, 300, THIN, 26, pw - 80 - w2), soft);
        });
        if (card.badges.length) {
            ctx.font = `500 22px ${THIN}`;
            const names = card.badges.slice(0, 4).map((bd) => bd.name);
            const ws = names.map((s) => ctx.measureText(s).width + 52);
            let n = names.length; while (n > 1 && ws.slice(0, n).reduce((a, v) => a + v + 12, -12) > W - 160) n--;
            let bx = (W - ws.slice(0, n).reduce((a, v) => a + v + 12, -12)) / 2; const by = 1210;
            for (let i = 0; i < n; i++) {
                rr(ctx, bx, by, ws[i], 50, 25); ctx.fillStyle = "rgba(255,255,255,0.1)"; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.stroke();
                text(ctx, names[i], bx + ws[i] / 2, by + 33, `500 22px ${THIN}`, white, "center");
                bx += ws[i] + 12;
            }
        }
        text(ctx, "●  confirmed by other riders     ○  recorded by MapUnite", W / 2, H - 70, `400 19px ${THIN}`, "rgba(255,255,255,0.6)", "center");
        text(ctx, PP_NOTE, W / 2, H - 34, `400 19px ${THIN}`, "rgba(255,255,255,0.55)", "center");
    }

    /** Poster: the rider's first name huge and condensed on lavender, a glowing ribbon through it, a monospace ledger. */
    function passportPoster(canvas, card, o) {
        const W = 1080, H = 1350;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ece8f6"; ctx.fillRect(0, 0, W, H);
        const glow = ctx.createRadialGradient(W * 0.3, H * 0.3, 0, W * 0.3, H * 0.3, W);
        glow.addColorStop(0, "rgba(196,181,253,0.55)"); glow.addColorStop(1, "rgba(236,232,246,0)");
        ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
        const r = rng((o.seed || 7) + 5);
        ctx.fillStyle = "rgba(40,20,80,0.05)";
        for (let i = 0; i < 2200; i++) ctx.fillRect(r() * W, r() * H, 1.4, 1.4);
        const F = passportFigures(card);
        const ink = "#0b0b10", deep = "#2a1f55", mid = "#4b3f78";
        if (o.photo) {
            const cx = W * 0.5, cy = 380, rad = 280;
            ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.clip();
            const f = cover(o.photo, rad * 2, rad * 2);
            ctx.drawImage(o.photo, cx - rad + f.x, cy - rad + f.y, f.w, f.h);
            ctx.restore();
        }
        const word = passportWord(card.name);
        const anton = antonLoaded();
        const face = anton ? `400 {px}px ${CONDENSED}` : `900 {px}px ${DISPLAY}`, squeeze = anton ? 1 : 0.58;
        ctx.font = face.replace("{px}", "100");
        const size = Math.min((W - 80) / ((ctx.measureText(word).width || 1) * squeeze) * 100, 400);
        const baseY = 640;
        ctx.save();
        ctx.font = face.replace("{px}", String(Math.round(size))); ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
        const total = ctx.measureText(word).width * squeeze;
        ctx.translate((W - total) / 2, 0); ctx.scale(squeeze, 1);
        ctx.fillStyle = ink; ctx.fillText(word, 0, baseY);
        ctx.restore();
        // one glowing ribbon through the word
        const p = ribbonPaths(o.seed || 7, W, H)[0];
        const ys = baseY - size * 0.45;
        ctx.save(); ctx.lineCap = "round";
        const path = () => { ctx.beginPath(); ctx.moveTo(-40, ys + 120); ctx.bezierCurveTo(W * 0.3, p.p1[1] * 0.3 + ys * 0.7, W * 0.65, p.p2[1] * 0.3 + ys * 0.7 + 60, W + 40, ys - 110); };
        const g = ctx.createLinearGradient(0, 0, W, 0); g.addColorStop(0, "#7c3aed"); g.addColorStop(1, "#2563eb");
        ctx.shadowColor = "rgba(124,58,237,0.7)"; ctx.shadowBlur = 30; path(); ctx.strokeStyle = g; ctx.lineWidth = 12; ctx.stroke();
        ctx.shadowBlur = 0; path(); ctx.strokeStyle = "#f5f3ff"; ctx.lineWidth = 3.6; ctx.stroke();
        ctx.restore();
        text(ctx, "mapunite", 64, 92, `700 40px ${DISPLAY}`, ink, "left", -1.5);
        text(ctx, "[RIDER PASSPORT]", W - 64, 90, `500 24px ${MONO}`, "#1f1640", "right", 1);
        ctx.fillStyle = "rgba(31,22,64,0.55)";
        for (let i = 0; i < 26; i++) ctx.fillRect(40, 200 + i * (H - 440) / 26, i % 5 === 0 ? 18 : 9, 2);
        const full = (card.name || "Rider").toUpperCase();
        text(ctx, F.selfLine ? `${full}  ·  ${F.selfLine.toUpperCase()}` : full, W / 2, baseY + 74, fit(ctx, F.selfLine ? `${full}  ·  ${F.selfLine.toUpperCase()}` : full, 400, CONDENSED, 42, W - 200), deep, "center", 1);
        // the ledger: label …… value, a tick for confirmed lines
        const lx = 110, rx = W - 110;
        F.rows.slice(0, 6).forEach((it, i) => {
            const y = baseY + 160 + i * 58;
            const lab = it.label.toUpperCase(), val = `${it.value}${it.source === "community" ? "  ✓" : ""}`;
            ctx.font = `500 24px ${MONO}`;
            const lw = text(ctx, lab, lx, y, `500 24px ${MONO}`, mid, "left", 1);
            const vw = text(ctx, val, rx, y, `600 26px ${MONO}`, ink, "right", 0);
            ctx.fillStyle = "rgba(75,63,120,0.35)";
            for (let x = lx + lw + 14; x < rx - vw - 14; x += 12) ctx.fillRect(x, y - 6, 3, 3);
        });
        const py2 = H - 150;
        if (card.badges.length) {
            let bx = 64;
            for (const bd of card.badges.slice(0, 4)) {
                ctx.font = `600 20px ${MONO}`;
                const w = ctx.measureText(bd.name.toUpperCase()).width + 44;
                if (bx + w > W - 64) break;
                rr(ctx, bx, py2, w, 46, 23); ctx.fillStyle = "#a855f7"; ctx.fill();
                text(ctx, bd.name.toUpperCase(), bx + w / 2, py2 + 30, `600 20px ${MONO}`, "#ffffff", "center", 1);
                bx += w + 12;
            }
        } else {
            ["#a855f7", "#c4b5fd", "#ddd6fe"].forEach((c, i) => { rr(ctx, W - 64 - (3 - i) * 132, py2, 120, 46, 23); ctx.fillStyle = c; ctx.fill(); });
        }
        text(ctx, "✓ = confirmed by other riders' independent rides · the rest recorded by MapUnite", W / 2, H - 70, `500 18px ${MONO}`, "rgba(31,22,64,0.6)", "center");
        text(ctx, "Self-reported lines are the rider's own.", W / 2, H - 38, `500 18px ${MONO}`, "rgba(31,22,64,0.6)", "center");
    }

    /**
     * The Passport card, 1080 × 1350. Photos are redrawn: no EXIF/GPS in the exported image.
     * @param {HTMLCanvasElement} canvas @param {{ name: string, sections: any[], badges: any[] }} card
     * @param {{ style?: string, seed?: number, photo?: any }} [o]
     */
    function drawPassport(canvas, card, o = {}) {
        canvas.width = 1080; canvas.height = 1350;
        if (o.style === "gauge") passportGauge(canvas, card, o);
        else if (o.style === "poster") passportPoster(canvas, card, o);
        else passportLens(canvas, card, o);
        return canvas;
    }

    function draw(style, canvas, card, o, R, S) {
        if (style === "gauge") return drawGauge(canvas, card, o, R, S);
        if (style === "poster") return drawPoster(canvas, card, o, R, S);
        return drawLens(canvas, card, o, R, S);
    }

    return { STYLES, PASSPORT_STYLES, sdfRoundRect, refractSample, ribbonPaths, posterWord, passportWord, passportFigures, rng, refract, draw, drawLens, drawGauge, drawPoster, drawPassport };
});
