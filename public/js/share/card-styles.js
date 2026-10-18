// @ts-check
/* ============================================================================
   MapUnite share — the modern recap styles (Bento, Liquid Glass, Verse)
   ==============================================================================
   MUShare.styles.draw(style, canvas, card, o, R) → canvas      R = MUShare.render

     bento   Apple-style bento grid on near-black: one big route tile, then
             tiles for distance (huge gradient figure), moving time, an
             activity-ring eco score, mileage + cost, and the road reports.
     glass   Liquid Glass: the rider's photo (or a vivid mesh gradient) behind
             frosted panels — the background blurred inside the panel, a soft
             white veil, a hairline border and a specular top edge.
     verse   Comic "verse" look: a black band with a lowercase monospace line,
             then the photo (or the route) posterised, split into offset
             colour channels, halftone-dotted and glitch-sliced, with bold
             comic stickers for the figures.
   Everything is drawn on the phone; photos are redrawn, so no EXIF/GPS leaves
   with the PNG. The "random" parts (glitch slices) are seeded by the ride's
   start time, so the same ride always gives the same card. Top speed is never
   drawn. The pure helpers (layouts, rng, posterise, channel split) are tested.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUShare || (/** @type {any} */ (root).MUShare = {}); ns.styles = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const STYLES = Object.freeze(["bento", "glass", "verse", "minimal"]);
    const DISPLAY = `"Sora", "Inter", system-ui, sans-serif`, UI = `"Inter", system-ui, sans-serif`, MONO = `"JetBrains Mono", "SFMono-Regular", "Roboto Mono", ui-monospace, monospace`;
    const MINT = "#34e0b4", CYAN = "#22d3ee", TEXT = "#f5f7fa", SOFT = "#b9c4cf", MUTED = "#7d8a97";

    // ------------------------------------------------------------------ pure helpers
    /** A small seeded PRNG (mulberry32), so a ride's card never changes between previews. @param {number} seed */
    function rng(seed) {
        let a = (seed >>> 0) || 0x9e3779b9;
        return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }

    /** Posterise + contrast on RGBA bytes, in place (pure on the array). @param {Uint8ClampedArray|number[]} d @param {number} levels @param {number} contrast */
    function posterize(d, levels = 5, contrast = 1.25) {
        const step = 255 / (levels - 1);
        for (let i = 0; i < d.length; i += 4) {
            for (let k = 0; k < 3; k++) {
                const v = (d[i + k] - 128) * contrast + 128;
                d[i + k] = Math.max(0, Math.min(255, Math.round(Math.round(Math.max(0, Math.min(255, v)) / step) * step)));
            }
        }
        return d;
    }

    /** Split the colour channels sideways (chromatic aberration): red from x+dx, blue from x−dx. Pure. @param {Uint8ClampedArray|number[]} src @param {number} w @param {number} h @param {number} dx */
    function splitChannels(src, w, h, dx) {
        const out = new Uint8ClampedArray(src.length);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                const r = (y * w + Math.min(w - 1, x + dx)) * 4, b = (y * w + Math.max(0, x - dx)) * 4;
                out[i] = src[r]; out[i + 1] = src[i + 1]; out[i + 2] = src[b + 2]; out[i + 3] = 255;
            }
        }
        return out;
    }

    const clamp01 = (/** @type {number} */ v) => Math.max(0, Math.min(1, v));
    /** easeOutCubic. @param {number} x */
    const ease = (x) => 1 - (1 - clamp01(x)) ** 3;
    /** Where an element is in the motion: 0 → hidden, 1 → in place. delay and span are fractions of the clip. Pure. */
    const phase = (/** @type {number} */ t, /** @type {number} */ delay, /** @type {number} */ span = 0.3) => ease((t - delay) / span);
    /**
     * The card at time t of the motion (0…1): figures count up, the line draws itself. Pure. t ≥ 1 → the card as it is.
     * @param {any} card @param {number} t
     */
    function motionCard(card, t) {
        if (!(t < 1)) return card;
        const k = phase(t, 0.22, 0.5);
        return { ...card, distance: card.distance * k, moving: card.moving * k, energy: card.energy * k,
            cost: card.cost === null ? null : card.cost * k, ecoScore: card.ecoScore === null ? null : card.ecoScore * k,
            reports: card.reports ? { reviewed: Math.round(card.reports.reviewed * k), published: Math.round(card.reports.published * k) } : null };
    }

    /** Bento tile rectangles for a format (pure, tested: inside the canvas, never overlapping). @param {"story"|"post"} fmt */
    function bentoLayout(fmt) {
        const W = 1080, H = fmt === "post" ? 1350 : 1920, m = 56, g = 24, half = (W - 2 * m - g) / 2;
        if (fmt === "post") {
            const heroY = 250, heroH = 470, r2 = heroY + heroH + g, rh = 230, r3 = r2 + rh + g;
            return { W, H, m, title: 168, caption: 214, hero: { x: m, y: heroY, w: W - 2 * m, h: heroH },
                dist: { x: m, y: r2, w: half, h: rh }, time: { x: m + half + g, y: r2, w: half, h: rh },
                eco: { x: m, y: r3, w: half, h: rh }, fuel: { x: m + half + g, y: r3, w: half, h: rh }, wide: null, foot: H - 40 };
        }
        const heroY = 320, heroH = 760, r2 = heroY + heroH + g, rh = 280, r3 = r2 + rh + g, r4 = r3 + rh + g;
        return { W, H, m, title: 200, caption: 260, hero: { x: m, y: heroY, w: W - 2 * m, h: heroH },
            dist: { x: m, y: r2, w: half, h: rh }, time: { x: m + half + g, y: r2, w: half, h: rh },
            eco: { x: m, y: r3, w: half, h: rh }, fuel: { x: m + half + g, y: r3, w: half, h: rh },
            wide: { x: m, y: r4, w: W - 2 * m, h: 120 }, foot: H - 44 };
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
        for (; px > 16; px -= 2) { ctx.font = `${weight} ${px}px ${family}`; if (ctx.measureText(s).width <= maxW) break; }
        return `${weight} ${px}px ${family}`;
    }
    const dateOf = (card, o, opts) => new Intl.DateTimeFormat(o.locale || "en-IN", opts).format(new Date(card.startedAt));

    /** The route in a box; glow optional. Returns false when there's no route to show. */
    function route(ctx, card, box, inset, R, look, extra = {}) {
        if (!card.route || card.route.pts.length < 2) return false;
        // on a map: the map's own projection of the same points; else fitted into the box
        let P = extra.pts ? extra.pts.map(([x, y]) => [box.x + x, box.y + y]) : R.fitRoute(card.route.pts, box, inset);
        const reveal = extra.reveal === undefined ? 1 : clamp01(extra.reveal);
        if (reveal <= 0.001) return true;
        if (reveal < 1) P = P.slice(0, Math.max(2, Math.ceil(P.length * reveal)));
        const path = () => { ctx.beginPath(); P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); };
        ctx.save();
        ctx.lineJoin = "round"; ctx.lineCap = "round";
        const grad = ctx.createLinearGradient(P[0][0], P[0][1], P[P.length - 1][0], P[P.length - 1][1]);
        grad.addColorStop(0, look.from); grad.addColorStop(1, look.to);
        if (look.glow) { ctx.shadowColor = look.glow; ctx.shadowBlur = look.blur || 40; path(); ctx.strokeStyle = grad; ctx.globalAlpha = 0.45; ctx.lineWidth = look.width * 2.6; ctx.stroke(); ctx.globalAlpha = 1; ctx.shadowBlur = 0; }
        path(); ctx.strokeStyle = grad; ctx.lineWidth = look.width; ctx.stroke();
        if (look.core) { path(); ctx.strokeStyle = look.core; ctx.lineWidth = Math.max(2, look.width * 0.28); ctx.stroke(); }
        const [sx, sy] = P[0], [ex, ey] = P[P.length - 1];
        ctx.beginPath(); ctx.arc(sx, sy, look.width * 1.15, 0, Math.PI * 2); ctx.fillStyle = "#0a0d12"; ctx.fill(); ctx.lineWidth = look.width * 0.5; ctx.strokeStyle = look.from; ctx.stroke();
        ctx.beginPath(); ctx.arc(ex, ey, look.width * 1.6, 0, Math.PI * 2); ctx.fillStyle = look.to; ctx.fill();
        ctx.beginPath(); ctx.arc(ex, ey, look.width * 0.6, 0, Math.PI * 2); ctx.fillStyle = "#0a0d12"; ctx.fill();
        ctx.restore();
        return true;
    }
    /** A tile: soft fill, a lighter top edge, a hairline. */
    function tile(ctx, b, r = 44) {
        ctx.save();
        rr(ctx, b.x, b.y, b.w, b.h, r);
        const f = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
        f.addColorStop(0, "rgba(255,255,255,0.085)"); f.addColorStop(1, "rgba(255,255,255,0.035)");
        ctx.fillStyle = f; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,255,255,0.09)"; ctx.stroke();
        ctx.restore();
    }
    function label(ctx, s, x, y, size = 24, color = MUTED) { text(ctx, s.toUpperCase(), x, y, `700 ${size}px ${UI}`, color, "left", 2.5); }
    function brand(ctx, x, y, size, alpha = 0.9) {
        ctx.beginPath(); ctx.arc(x + size * 0.42, y - size * 0.34, size * 0.26, 0, Math.PI * 2);
        const g = ctx.createLinearGradient(x, y - size, x + size, y); g.addColorStop(0, MINT); g.addColorStop(1, CYAN);
        ctx.fillStyle = g; ctx.fill();
        text(ctx, "MapUnite", x + size * 0.92, y, `700 ${size}px ${DISPLAY}`, `rgba(245,247,250,${alpha})`, "left", -0.5);
    }
    /** A big figure with a gradient fill and its unit. */
    function figure(ctx, value, unit, x, y, size, maxW, from = MINT, to = CYAN) {
        const font = fit(ctx, value, 800, DISPLAY, size, maxW - (unit ? size * 0.9 : 0));
        ctx.font = font;
        const w = ctx.measureText(value).width;
        const g = ctx.createLinearGradient(x, y - size, x + w, y);
        g.addColorStop(0, from); g.addColorStop(1, to);
        text(ctx, value, x, y, font, g, "left", -size * 0.035);
        if (unit) text(ctx, unit, x + w + size * 0.08, y, `600 ${Math.round(size * 0.3)}px ${UI}`, SOFT);
    }

    // ------------------------------------------------------------------ Bento
    function drawBento(canvas, card0, o, R) {
        const t = o.t === undefined ? 1 : o.t, card = motionCard(card0, t);
        const fmt = o.format === "post" ? "post" : "story", L = bentoLayout(fmt);
        canvas.width = L.W; canvas.height = L.H;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#050608"; ctx.fillRect(0, 0, L.W, L.H);
        for (const [cx, cy, r, c] of [[0.1, 0.06, 0.7, "rgba(52,224,180,0.10)"], [0.95, 0.75, 0.8, "rgba(59,130,246,0.10)"]]) {
            const g = ctx.createRadialGradient(cx * L.W, cy * L.H, 0, cx * L.W, cy * L.H, r * L.W);
            g.addColorStop(0, c); g.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = g; ctx.fillRect(0, 0, L.W, L.H);
        }
        brand(ctx, L.m + 4, 98, 34);
        const date = dateOf(card, o, { weekday: "short", day: "numeric", month: "short" });
        ctx.font = `600 26px ${UI}`;
        const dw = ctx.measureText(date).width + 44;
        rr(ctx, L.W - L.m - dw, 58, dw, 54, 27); ctx.fillStyle = "rgba(255,255,255,0.08)"; ctx.fill();
        text(ctx, date, L.W - L.m - dw / 2, 94, `600 26px ${UI}`, SOFT, "center");
        text(ctx, card.title, L.m, L.title, fit(ctx, card.title, 800, DISPLAY, fmt === "post" ? 72 : 88, L.W - 2 * L.m), TEXT, "left", -2);
        const sub = card.caption || card.place || card.bike || "";
        if (sub) text(ctx, sub, L.m, L.caption, fit(ctx, sub, 500, UI, fmt === "post" ? 30 : 36, L.W - 2 * L.m), SOFT);

        // hero: the route
        const hb = L.hero;
        ctx.save(); rr(ctx, hb.x, hb.y, hb.w, hb.h, 52);
        const hg = ctx.createLinearGradient(0, hb.y, 0, hb.y + hb.h); hg.addColorStop(0, "#0e1a26"); hg.addColorStop(1, "#091019");
        ctx.fillStyle = hg; ctx.fill(); ctx.clip();
        ctx.fillStyle = "rgba(255,255,255,0.045)";
        for (let x = hb.x + 28; x < hb.x + hb.w; x += 40) for (let y = hb.y + 28; y < hb.y + hb.h; y += 40) { ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fill(); }
        const map = o.map && o.map.canvas ? o.map : null;
        if (map) {
            // the real map, dimmed toward the edges so the line and the tiles stay the heroes
            ctx.globalAlpha = phase(t, 0, 0.35);
            ctx.drawImage(map.canvas, hb.x, hb.y, hb.w, hb.h);
            const v = ctx.createRadialGradient(hb.x + hb.w / 2, hb.y + hb.h / 2, hb.h * 0.25, hb.x + hb.w / 2, hb.y + hb.h / 2, hb.w * 0.75);
            v.addColorStop(0, "rgba(5,6,8,0.05)"); v.addColorStop(1, "rgba(5,6,8,0.7)");
            ctx.fillStyle = v; ctx.fillRect(hb.x, hb.y, hb.w, hb.h);
            ctx.globalAlpha = 1;
        }
        const drawn = route(ctx, card, hb, 80, R, { from: MINT, to: CYAN, glow: "rgba(52,224,180,0.8)", width: 10, core: "rgba(235,255,250,0.9)" }, { pts: map ? map.pts : null, reveal: phase(t, 0.08, 0.6) });
        if (!drawn) text(ctx, "Route hidden for privacy", hb.x + hb.w / 2, hb.y + hb.h / 2, `600 32px ${UI}`, MUTED, "center");
        if (map) text(ctx, map.attribution, hb.x + 30, hb.y + hb.h - 28, `500 18px ${UI}`, "rgba(255,255,255,0.55)");
        ctx.restore();
        ctx.lineWidth = 1.5; rr(ctx, hb.x, hb.y, hb.w, hb.h, 52); ctx.strokeStyle = "rgba(255,255,255,0.09)"; ctx.stroke();
        rr(ctx, hb.x + 28, hb.y + 28, 128, 44, 22); ctx.fillStyle = "rgba(0,0,0,0.45)"; ctx.fill();
        text(ctx, "ROUTE", hb.x + 92, hb.y + 58, `700 20px ${UI}`, MINT, "center", 2.5);
        if (drawn && card.privacy) text(ctx, "start & finish hidden", hb.x + hb.w - 30, hb.y + hb.h - 28, `500 21px ${UI}`, MUTED, "right");

        const st = R.stats(card, o.units, o.showCost !== false);
        const big = fmt === "post" ? 112 : 140;
        // each tile slides up and fades in, one after another
        const enter = (/** @type {number} */ i, /** @type {() => void} */ fn) => {
            const a = phase(t, 0.18 + i * 0.07, 0.28);
            if (a <= 0) return;
            ctx.save(); ctx.globalAlpha = a; ctx.translate(0, (1 - a) * 46); fn(); ctx.restore();
        };
        enter(0, () => {
        // distance
        tile(ctx, L.dist); label(ctx, "Distance", L.dist.x + 34, L.dist.y + 52);
        figure(ctx, st[0].value, "km", L.dist.x + 32, L.dist.y + L.dist.h - 44, big, L.dist.w - 60);
        });
        enter(1, () => {
        // moving time
        tile(ctx, L.time); label(ctx, "Moving time", L.time.x + 34, L.time.y + 52);
        figure(ctx, st[3].value, st[3].unit, L.time.x + 32, L.time.y + L.time.h - 44, big, L.time.w - 60, "#ffffff", "#c7d2fe");
        });
        enter(2, () => {
        // eco ring (activity-ring style)
        tile(ctx, L.eco);
        const rc = { x: L.eco.x + L.eco.h / 2, y: L.eco.y + L.eco.h / 2, r: L.eco.h * 0.3 };
        ctx.lineCap = "round"; ctx.lineWidth = L.eco.h * 0.11;
        ctx.beginPath(); ctx.arc(rc.x, rc.y, rc.r, 0, Math.PI * 2); ctx.strokeStyle = "rgba(52,224,180,0.16)"; ctx.stroke();
        if (card.ecoScore !== null) {
            const rg = ctx.createLinearGradient(rc.x - rc.r, rc.y - rc.r, rc.x + rc.r, rc.y + rc.r); rg.addColorStop(0, MINT); rg.addColorStop(1, CYAN);
            ctx.beginPath(); ctx.arc(rc.x, rc.y, rc.r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, Math.min(1, card.ecoScore))); ctx.strokeStyle = rg; ctx.stroke();
        }
        const tx = L.eco.x + L.eco.h * 0.98;
        label(ctx, "Eco score", tx, L.eco.y + 70, 22);
        text(ctx, card.ecoScore === null ? "–" : String(Math.round(card.ecoScore * 100)), tx, L.eco.y + L.eco.h * 0.66, `800 ${Math.round(L.eco.h * 0.36)}px ${DISPLAY}`, TEXT, "left", -2);
        if (card.ecoWord) text(ctx, card.ecoWord, tx, L.eco.y + L.eco.h - 38, fit(ctx, card.ecoWord, 700, DISPLAY, 30, L.eco.w - (tx - L.eco.x) - 24), MINT);
        });
        enter(3, () => {
        // mileage + cost
        tile(ctx, L.fuel);
        const fx = L.fuel.x + 34, half = L.fuel.h / 2;
        label(ctx, st[1].label, fx, L.fuel.y + 50, 22);
        const vw1 = text(ctx, st[1].value, fx, L.fuel.y + half - 8, fit(ctx, st[1].value, 800, DISPLAY, Math.round(L.fuel.h * 0.22), L.fuel.w * 0.55), TEXT, "left", -1);
        text(ctx, st[1].unit, fx + vw1 + 10, L.fuel.y + half - 8, `600 ${Math.round(L.fuel.h * 0.09)}px ${UI}`, SOFT);
        ctx.fillStyle = "rgba(255,255,255,0.08)"; ctx.fillRect(fx, L.fuel.y + half + 12, L.fuel.w - 68, 2);
        label(ctx, st[2].label, fx, L.fuel.y + half + 50, 22);
        const vw2 = text(ctx, st[2].value, fx, L.fuel.y + L.fuel.h - 22, fit(ctx, st[2].value, 800, DISPLAY, Math.round(L.fuel.h * 0.17), L.fuel.w * 0.6), TEXT, "left", -1);
        if (st[2].unit) text(ctx, st[2].unit, fx + vw2 + 10, L.fuel.y + L.fuel.h - 22, `600 ${Math.round(L.fuel.h * 0.08)}px ${UI}`, SOFT);
        });
        // the wide tile: road reports, or how smooth it was
        if (L.wide) enter(4, () => {
            tile(ctx, L.wide, 40);
            const bt = R.bannerText(card, o.units, o.showCost !== false);
            const line = card.reports ? `${card.reports.reviewed} road reports reviewed · ${card.reports.published} published` : bt.title;
            ctx.beginPath(); ctx.arc(L.wide.x + 60, L.wide.y + L.wide.h / 2, 20, 0, Math.PI * 2); ctx.fillStyle = "rgba(52,224,180,0.18)"; ctx.fill();
            ctx.beginPath(); ctx.arc(L.wide.x + 60, L.wide.y + L.wide.h / 2, 8, 0, Math.PI * 2); ctx.fillStyle = MINT; ctx.fill();
            text(ctx, line, L.wide.x + 102, L.wide.y + L.wide.h / 2 + 12, fit(ctx, line, 700, DISPLAY, 36, L.wide.w - 140), TEXT);
        });
        const foot = R.footText({ ...card, reports: L.wide ? null : card.reports });
        text(ctx, foot, L.W / 2, L.foot, fit(ctx, foot, 500, UI, 22, L.W - 2 * L.m), MUTED, "center");
        return canvas;
    }

    // ------------------------------------------------------------------ Liquid Glass
    /** The background: the photo (cover) or a vivid mesh gradient. */
    function backdrop(ctx, W, H, card, photo, R, map, reveal = 1) {
        if (!photo && map && map.canvas) {
            // the real map, tinted toward the Liquid Glass palette, with the route as a bright trail
            ctx.drawImage(map.canvas, 0, 0, W, H);
            const g = ctx.createLinearGradient(0, 0, W, H);
            g.addColorStop(0, "rgba(124,58,237,0.42)"); g.addColorStop(0.5, "rgba(37,99,235,0.28)"); g.addColorStop(1, "rgba(236,72,153,0.38)");
            ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
            route(ctx, card, { x: 0, y: 0, w: W, h: H }, 0, R, { from: "#ffffff", to: "#a5f3fc", glow: "rgba(255,255,255,0.85)", width: 9, core: "#ffffff" }, { pts: map.pts, reveal });
            return;
        }
        if (photo) {
            const f = R.cover(photo.naturalWidth || photo.width, photo.naturalHeight || photo.height, W, H);
            ctx.drawImage(photo, f.x, f.y, f.w, f.h);
            return;
        }
        ctx.fillStyle = "#0b0a1f"; ctx.fillRect(0, 0, W, H);
        const r = rng(Math.floor(card.startedAt / 1000) || 7);
        const blobs = [["#7c3aed", 0.15, 0.18], ["#2563eb", 0.85, 0.3], ["#06b6d4", 0.25, 0.7], ["#ec4899", 0.9, 0.85], ["#22c55e", 0.55, 0.5]];
        for (const [c, x, y] of blobs) {
            const cx = (x + (r() - 0.5) * 0.12) * W, cy = (y + (r() - 0.5) * 0.08) * H, rad = (0.45 + r() * 0.2) * W;
            const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
            g.addColorStop(0, c); g.addColorStop(1, "rgba(0,0,0,0)");
            ctx.globalAlpha = 0.75; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        }
        ctx.globalAlpha = 1;
        // the route as a soft light trail across the gradient
        route(ctx, card, { x: 0, y: H * 0.06, w: W, h: H * 0.5 }, 120, R, { from: "rgba(255,255,255,0.85)", to: "rgba(255,255,255,0.95)", glow: "rgba(255,255,255,0.6)", width: 7 }, { reveal });
    }

    /** A frosted panel: the backdrop blurred inside it, a veil, a hairline and a specular top edge. */
    function glassPanel(ctx, src, b, r, smoky = false) {
        ctx.save();
        rr(ctx, b.x, b.y, b.w, b.h, r); ctx.clip();
        if ("filter" in ctx) {
            ctx.filter = "blur(38px) saturate(1.5)";
            ctx.drawImage(src, b.x - 60, b.y - 60, b.w + 120, b.h + 120, b.x - 60, b.y - 60, b.w + 120, b.h + 120);
            ctx.filter = "none";
            ctx.fillStyle = smoky ? "rgba(12,16,34,0.42)" : "rgba(255,255,255,0.13)";   // over a light map: a darker glass, so white text reads
        } else ctx.fillStyle = "rgba(20,24,40,0.62)";                              // no canvas blur: a plain smoked panel
        ctx.fillRect(b.x, b.y, b.w, b.h);
        const sheen = ctx.createLinearGradient(0, b.y, 0, b.y + b.h * 0.45);
        sheen.addColorStop(0, "rgba(255,255,255,0.22)"); sheen.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = sheen; ctx.fillRect(b.x, b.y, b.w, b.h * 0.45);
        ctx.restore();
        ctx.save();
        rr(ctx, b.x + 1, b.y + 1, b.w - 2, b.h - 2, r);
        const edge = ctx.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h);
        edge.addColorStop(0, "rgba(255,255,255,0.65)"); edge.addColorStop(0.5, "rgba(255,255,255,0.12)"); edge.addColorStop(1, "rgba(255,255,255,0.35)");
        ctx.lineWidth = 2; ctx.strokeStyle = edge; ctx.stroke();
        ctx.restore();
    }

    function drawGlass(canvas, card0, o, R) {
        const t = o.t === undefined ? 1 : o.t, card = motionCard(card0, t);
        const fmt = o.format === "post" ? "post" : "story", W = 1080, H = fmt === "post" ? 1350 : 1920, m = 56;
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d");
        const bg = typeof document !== "undefined" ? document.createElement("canvas") : canvas;
        bg.width = W; bg.height = H;
        const bctx = bg.getContext("2d");
        backdrop(bctx, W, H, card, o.photo, R, o.map, phase(t, 0.05, 0.6));
        ctx.drawImage(bg, 0, 0);
        if (o.map && !o.photo) text(ctx, o.map.attribution, W - m, 168, `500 18px ${UI}`, "rgba(255,255,255,0.7)", "right");
        // top chip
        const chip = { x: m, y: 54, w: 330, h: 76 };
        const smoky = Boolean(o.map && !o.photo);
        glassPanel(ctx, bg, chip, 38, smoky);
        brand(ctx, chip.x + 28, chip.y + 51, 30, 0.95);
        const date = dateOf(card, o, { day: "numeric", month: "short" });
        const dchip = { x: W - m - 180, y: 54, w: 180, h: 76 };
        glassPanel(ctx, bg, dchip, 38, smoky);
        text(ctx, date, dchip.x + dchip.w / 2, dchip.y + 50, `600 30px ${UI}`, "#ffffff", "center");
        // the main panel
        const ph = fmt === "post" ? 560 : 720;
        const lift = (1 - phase(t, 0.12, 0.4)) * 160;                     // the panel rises into place
        const P = { x: m, y: H - ph - m + lift, w: W - 2 * m, h: ph };
        glassPanel(ctx, bg, P, 60, smoky);
        const px = P.x + 52;
        text(ctx, card.title, px, P.y + 104, fit(ctx, card.title, 800, DISPLAY, fmt === "post" ? 62 : 72, P.w - 300), "#ffffff", "left", -1.5);
        const sub = card.caption || card.place || "";
        if (sub) text(ctx, sub, px, P.y + 158, fit(ctx, sub, 500, UI, 32, P.w - 104), "rgba(255,255,255,0.86)");
        // mini route chip inside the panel
        if (card.route) {
            const mr = { x: P.x + P.w - 52 - 190, y: P.y + 40, w: 190, h: 190 };
            glassPanel(ctx, bg, mr, 40, smoky);
            route(ctx, card, mr, 30, R, { from: "#ffffff", to: "#a5f3fc", width: 6 });
        }
        const st = R.stats(card, o.units, o.showCost !== false);
        const big = fmt === "post" ? 150 : 190;
        const bigY = P.y + (fmt === "post" ? 360 : 430);
        figure(ctx, st[0].value, "km", px - 4, bigY, big, P.w - 104, "#ffffff", "#d9f99d");
        // three stat pills
        const rowY = P.y + P.h - (fmt === "post" ? 150 : 190), pw = (P.w - 104 - 2 * 18) / 3, phh = fmt === "post" ? 110 : 140;
        [st[3], st[1], st[2]].forEach((s, i) => {
            const b = { x: px + i * (pw + 18), y: rowY, w: pw, h: phh };
            ctx.save(); rr(ctx, b.x, b.y, b.w, b.h, 30); ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.stroke(); ctx.restore();
            text(ctx, s.label.toUpperCase(), b.x + 24, b.y + 38, `700 19px ${UI}`, "rgba(255,255,255,0.75)", "left", 2);
            const vw = text(ctx, s.value, b.x + 22, b.y + b.h - 26, fit(ctx, s.value, 800, DISPLAY, fmt === "post" ? 46 : 56, b.w - 80), "#ffffff", "left", -1);
            if (s.unit) text(ctx, s.unit, b.x + 22 + vw + 6, b.y + b.h - 26, `600 22px ${UI}`, "rgba(255,255,255,0.8)");
        });
        const foot = R.footText(card);
        text(ctx, foot, W / 2, P.y - 22, fit(ctx, foot, 500, UI, 22, W - 2 * m), "rgba(255,255,255,0.82)", "center");
        return canvas;
    }

    // ------------------------------------------------------------------ Verse (comic)
    const verseCache = new Map();
    function drawVerse(canvas, card0, o, R) {
        const t = o.t === undefined ? 1 : o.t, card = motionCard(card0, t);
        const fmt = o.format === "post" ? "post" : "story", W = 1080, H = fmt === "post" ? 1350 : 1920;
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
        const band = fmt === "post" ? 330 : 560;
        const st = R.stats(card, o.units, o.showCost !== false);
        // the monospace line, lowercase, centred, like a reel caption
        const lines = (card.caption ? [card.caption.toLowerCase()] : [card.title.toLowerCase(), `${st[0].value} km in ${st[3].value} ${st[3].unit === "h" ? "h" : "min"}`]).flatMap((l) => wrap(ctx, l, `500 46px ${MONO}`, W - 200));
        lines.push("", "made it with mapunite");
        const lh = 62, y0 = band / 2 - ((lines.length - 1) * lh) / 2 + 16;
        lines.forEach((l, i) => text(ctx, l, W / 2, y0 + i * lh, `${i === lines.length - 1 ? 400 : 500} ${i === lines.length - 1 ? 34 : 46}px ${MONO}`, i === lines.length - 1 ? "#9aa4ae" : "#f2f2f2", "center"));
        // the image area
        const A = { x: 0, y: band, w: W, h: H - band };
        if (typeof document === "undefined") return canvas;
        // the heavy part (posterise, channel split, halftone) is done once per ride, photo, map and size, then reused by
        // every frame of the motion and every preview
        const ckey = `${card0.startedAt}|${fmt}|${o.photo ? photoId(o.photo) : "-"}|${o.map ? "map" + o.map.zoom : "-"}|${card0.trim ? card0.trim.start + "," + card0.trim.end : ""}`;
        let off = verseCache.get(ckey);
        if (!off) {
        off = document.createElement("canvas");
        off.width = A.w; off.height = A.h;
        const o2 = off.getContext("2d", { willReadFrequently: true });
        if (o.photo) {
            const f = R.cover(o.photo.naturalWidth || o.photo.width, o.photo.naturalHeight || o.photo.height, A.w, A.h);
            o2.drawImage(o.photo, f.x, f.y, f.w, f.h);
        } else if (o.map && o.map.canvas) {
            o2.drawImage(o.map.canvas, 0, 0, A.w, A.h);
            o2.globalCompositeOperation = "multiply";                          // deepen the light map into comic colours
            const tint = o2.createLinearGradient(0, 0, A.w, A.h); tint.addColorStop(0, "#7c3aed"); tint.addColorStop(1, "#0891b2");
            o2.fillStyle = tint; o2.fillRect(0, 0, A.w, A.h);
            o2.globalCompositeOperation = "source-over";
            route(o2, card0, { x: 0, y: 0, w: A.w, h: A.h }, 0, R, { from: "#ff2bd6", to: "#22e1ff", glow: "rgba(255,43,214,0.8)", width: 16, core: "#ffffff" }, { pts: o.map.pts });
        } else {
            const g = o2.createLinearGradient(0, 0, A.w, A.h); g.addColorStop(0, "#1e1b4b"); g.addColorStop(0.55, "#581c87"); g.addColorStop(1, "#0e7490");
            o2.fillStyle = g; o2.fillRect(0, 0, A.w, A.h);
            route(o2, card0, { x: 0, y: 0, w: A.w, h: A.h }, 140, R, { from: "#ff2bd6", to: "#22e1ff", glow: "rgba(255,43,214,0.8)", width: 16, core: "#ffffff" });
        }
        // posterise + colour split
        const img = o2.getImageData(0, 0, A.w, A.h);
        posterize(img.data, 5, 1.3);
        img.data.set(splitChannels(img.data, A.w, A.h, 9));
        o2.putImageData(img, 0, 0);
        // halftone: dots, bigger in the shadows
        const cell = 14;
        const lum = o2.getImageData(0, 0, A.w, A.h).data;
        o2.fillStyle = "rgba(10,0,20,0.55)";
        for (let y = cell / 2; y < A.h; y += cell) {
            for (let x = ((y / cell) % 2 ? cell : cell / 2); x < A.w; x += cell) {
                const i = (Math.floor(y) * A.w + Math.floor(x)) * 4;
                const L = (0.299 * lum[i] + 0.587 * lum[i + 1] + 0.114 * lum[i + 2]) / 255;
                const rad = (1 - L) * cell * 0.42;
                if (rad > 0.8) { o2.beginPath(); o2.arc(x, y, rad, 0, Math.PI * 2); o2.fill(); }
            }
        }
        if (verseCache.size > 6) verseCache.delete(verseCache.keys().next().value);
        verseCache.set(ckey, off);
        }
        ctx.globalAlpha = phase(t, 0, 0.25);
        ctx.drawImage(off, A.x, A.y);
        ctx.globalAlpha = 1;
        // glitch slices: a few strips shifted and tinted (seeded, so the same ride looks the same; in motion they jitter)
        const r = rng(Math.floor(card.startedAt / 1000) + 11 + (t < 1 ? Math.floor(t * 24) : 0));
        for (let k = 0; k < 7; k++) {
            const sy = A.y + r() * (A.h - 60), sh = 12 + r() * 46, dx = (r() - 0.5) * 70;
            ctx.drawImage(off, 0, sy - A.y, A.w, sh, dx, sy, A.w, sh);
            ctx.fillStyle = k % 2 ? "rgba(255,43,214,0.22)" : "rgba(34,225,255,0.22)";
            ctx.fillRect(0, sy, A.w, sh);
        }
        // comic stickers
        let si = 0;
        const sticker = (s, sub, x, y, rot, bg, fg, size) => {
            const pop = phase(t, 0.35 + 0.1 * si++, 0.22);                  // each sticker pops in, with a little overshoot
            if (pop <= 0) return;
            const k = pop < 1 ? pop * (1 + 0.25 * Math.sin(pop * Math.PI)) : 1;
            ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(k, k);
            ctx.font = `900 ${size}px ${DISPLAY}`;
            const w = ctx.measureText(s).width + size * 0.7, h = size * (sub ? 1.55 : 1.25);
            ctx.fillStyle = "#000"; ctx.fillRect(10, 12, w, h);
            ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
            ctx.lineWidth = 6; ctx.strokeStyle = "#000"; ctx.strokeRect(0, 0, w, h);
            text(ctx, s, size * 0.35, size * 1.0, `900 ${size}px ${DISPLAY}`, fg, "left", -1);
            if (sub) text(ctx, sub, size * 0.38, size * 1.38, `800 ${Math.round(size * 0.26)}px ${UI}`, fg, "left", 3);
            ctx.restore();
        };
        const sy = H - (fmt === "post" ? 300 : 420);
        sticker(`${st[0].value} KM`, "DISTANCE", 70, sy, -0.06, "#ffe600", "#000", fmt === "post" ? 96 : 120);
        sticker(`${st[3].value} ${st[3].unit.toUpperCase()}`, "MOVING", fmt === "post" ? 520 : 560, sy + (fmt === "post" ? 120 : 170), 0.05, "#ff2bd6", "#fff", fmt === "post" ? 60 : 72);
        if (card.reports) sticker(`${card.reports.published} REPORTED`, "ROAD REPORTS", 70, A.y + 60, 0.04, "#22e1ff", "#000", 46);
        brand(ctx, W - 300, H - 44, 28, 0.9);
        if (o.map && !o.photo) text(ctx, o.map.attribution, W - 40, band + 34, `500 18px ${UI}`, "rgba(255,255,255,0.75)", "right");
        text(ctx, R.footText({ ...card, reports: null }), 40, H - 44, fit(ctx, R.footText({ ...card, reports: null }), 500, UI, 20, W - 400), "rgba(255,255,255,0.75)");
        return canvas;
    }
    const photoIds = typeof WeakMap === "function" ? new WeakMap() : null;
    let photoSeq = 0;
    /** A stable id per photo object (the cache key), without reading its pixels. @param {object} p */
    function photoId(p) { if (!photoIds) return "p"; if (!photoIds.has(p)) photoIds.set(p, ++photoSeq); return "p" + photoIds.get(p); }

    /** Word-wrap one line for a font and width. */
    function wrap(ctx, s, font, maxW) {
        ctx.font = font;
        const out = []; let cur = "";
        for (const w of s.split(/\s+/)) {
            const t = cur ? `${cur} ${w}` : w;
            if (ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = w; } else cur = t;
        }
        if (cur) out.push(cur);
        return out.slice(0, 4);
    }

    /** @param {string} style @param {HTMLCanvasElement} canvas @param {any} card @param {any} o @param {any} R */
    function draw(style, canvas, card, o, R) {
        if (style === "glass") return drawGlass(canvas, card, o, R);
        if (style === "verse") return drawVerse(canvas, card, o, R);
        return drawBento(canvas, card, o, R);
    }

    /** Which map (and its size) a style draws behind the route: null for none. Pure. @param {string} style @param {"story"|"post"} fmt @param {boolean} hasPhoto */
    function mapSpec(style, fmt, hasPhoto) {
        const H = fmt === "post" ? 1350 : 1920;
        if (style === "bento") { const L = bentoLayout(fmt); return { w: L.hero.w, h: L.hero.h, inset: 80, theme: "dark" }; }
        // Glass: the map fills the card, the route sits in the space above the glass panel
        if (style === "glass" && !hasPhoto) { const ph = fmt === "post" ? 560 : 720; return { w: 1080, h: H, inset: 90, theme: "light", focus: { x: 0, y: 170, w: 1080, h: H - ph - 56 - 170 - 40 } }; }
        if (style === "verse" && !hasPhoto) return { w: 1080, h: H - (fmt === "post" ? 330 : 560), inset: 160, theme: "light" };
        return null;
    }

    return { STYLES, rng, posterize, splitChannels, bentoLayout, mapSpec, motionCard, phase, ease, draw, drawBento, drawGlass, drawVerse, rr, text, fit, tile, label, brand, figure };
});
