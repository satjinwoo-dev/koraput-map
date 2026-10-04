// @ts-check
/* ============================================================================
   MapUnite share — draw the post-ride card on a canvas (exportable PNG)
   ==============================================================================
   MUShare.render.drawCard(canvas, card, { format, showCost, units }) → canvas

   Two sizes made for social apps: Story 1080×1920 (9:16) and Post 1080×1350
   (4:5). Everything is drawn (no screenshots of the DOM, no map tiles), so the
   PNG is crisp, the same on every phone, and contains only what's on it:
     - route art: your route as a glowing mint line on an ink grid — the shape
       of the ride, no streets or labels; start and finish trimmed by default;
     - the eco score ring and its word, distance, km/L (Wh/km), cost or fuel,
       moving time, and "Saved vs my usual" only when it's real (card-model);
     - the bike, the date, and a one-line footnote on how it was estimated.
   Brand: ink surfaces, mint accent, Sora for figures, Inter for labels.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUShare || (/** @type {any} */ (root).MUShare = {}); ns.render = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const SIZES = Object.freeze({ story: Object.freeze({ w: 1080, h: 1920 }), post: Object.freeze({ w: 1080, h: 1350 }) });
    const C = Object.freeze({ ink: "#080e17", ink2: "#0e1724", ink3: "#152131", mint: "#34e0b4", mintSoft: "rgba(52,224,180,0.16)", text: "#f2f6f8", soft: "#c6d2db", muted: "#8b9bab", line: "rgba(255,255,255,0.08)" });
    const DISPLAY = `"Sora", "Inter", system-ui, sans-serif`, UI = `"Inter", system-ui, sans-serif`;

    /** Where everything goes, per format (pure, tested). @param {"story"|"post"} format */
    function layout(format) {
        const S = SIZES[format] || SIZES.story;
        const pad = 84;
        if (format === "post") return { ...S, pad, header: 92, title: 196, titleSize: 70, sub: 248, box: { x: pad, y: 290, w: S.w - 2 * pad, h: 500 }, ring: { cx: pad + 118, cy: 944, r: 100, stroke: 20, word: 52 }, grid: { x: 404, y: 840, w: S.w - pad - 404, rowH: 128 }, banner: { x: pad, y: 1124, w: S.w - 2 * pad, h: 104 }, foot: 1290 };
        return { ...S, pad, header: 110, title: 250, titleSize: 84, sub: 312, box: { x: pad, y: 380, w: S.w - 2 * pad, h: 820 }, ring: { cx: pad + 150, cy: 1410, r: 130, stroke: 24, word: 58 }, grid: { x: 470, y: 1270, w: S.w - pad - 470, rowH: 160 }, banner: { x: pad, y: 1660, w: S.w - 2 * pad, h: 124 }, foot: 1856 };
    }

    /**
     * The route's unit-box points fitted into a box (aspect kept, centred) — pure.
     * @param {number[][]} pts in [0,1] (max dimension = 1) @param {{ x: number, y: number, w: number, h: number }} box @param {number} [inset]
     */
    function fitRoute(pts, box, inset = 56) {
        let mx = 0, my = 0;
        for (const [x, y] of pts) { if (x > mx) mx = x; if (y > my) my = y; }
        const W = box.w - 2 * inset, H = box.h - 2 * inset;
        const s = Math.min(W / Math.max(mx, 1e-6), H / Math.max(my, 1e-6));
        const ox = box.x + inset + (W - mx * s) / 2, oy = box.y + inset + (H - my * s) / 2;
        return pts.map(([x, y]) => [ox + x * s, oy + y * s]);
    }

    function rr(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
    function text(ctx, s, x, y, font, color, align = "left", spacing = 0) {
        ctx.font = font; ctx.fillStyle = color; ctx.textAlign = /** @type {CanvasTextAlign} */ (align); ctx.textBaseline = "alphabetic";
        if ("letterSpacing" in ctx) /** @type {any} */ (ctx).letterSpacing = `${spacing}px`;
        ctx.fillText(s, x, y);
        if ("letterSpacing" in ctx) /** @type {any} */ (ctx).letterSpacing = "0px";
        return ctx.measureText(s).width;
    }
    /** Largest size ≤ size at which s fits maxW. */
    function fit(ctx, s, weight, family, size, maxW) {
        let px = size;
        for (; px > 18; px -= 2) { ctx.font = `${weight} ${px}px ${family}`; if (ctx.measureText(s).width <= maxW) break; }
        return `${weight} ${px}px ${family}`;
    }

    /**
     * Stats shown in the grid (pure). @param {any} card @param {any} U @param {boolean} showCost
     * @returns {Array<{ label: string, value: string, unit: string }>}
     */
    function stats(card, U, showCost) {
        const km = card.distance / 1000;
        const mins = Math.round(card.moving / 60);
        const time = mins >= 60 ? { value: `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`, unit: "h" } : { value: String(Math.max(1, mins)), unit: "min" };
        let eco;
        if (card.perMetre === null) eco = { value: "–", unit: card.powertrain === "ev" ? "Wh/km" : "km/L" };
        else if (card.powertrain === "ev") eco = { value: U.num(Math.max(0, card.perMetre) / 3.6, 0), unit: "Wh/km" };
        else eco = { value: card.perMetre > 0 ? U.num(1 / (card.perMetre * 1e6), 1) : "∞", unit: "km/L" };
        const fuel = card.powertrain === "ev" ? { value: U.num(Math.max(0, card.energy) / 3.6e6, 2), unit: "kWh" } : { value: U.num(card.energy * 1000, 2), unit: "L" };
        const money = showCost && card.cost !== null ? { label: "Cost", value: `₹${U.num(card.cost, card.cost < 100 ? 1 : 0)}`, unit: "" } : { label: card.powertrain === "ev" ? "Energy" : "Fuel", ...fuel };
        return [
            { label: "Distance", value: U.num(km, km < 100 ? 1 : 0), unit: "km" },
            { label: card.powertrain === "ev" ? "Energy use" : "Mileage", ...eco },
            money,
            { label: "Moving time", ...time }
        ];
    }

    /** The savings / smoothness line (pure). @param {any} card @param {any} U @param {boolean} showCost */
    function bannerText(card, U, showCost) {
        if (card.saved) {
            const litres = card.saved.energy * 1000;     // m³ → L for display only
            const L = litres >= 0.1 ? `${U.num(litres, 2)} L` : `${U.num(litres * 1000, 0)} mL`;
            return {
                tone: "good",
                title: showCost && card.saved.cost !== null ? `Saved ₹${U.num(card.saved.cost, card.saved.cost < 100 ? 1 : 0)} vs my usual` : `${L} less than usual`,
                sub: `${L} less fuel than my average over ${card.saved.tanks} full tank${card.saved.tanks === 1 ? "" : "s"} (−${U.num(card.saved.share * 100, 0)} %)`
            };
        }
        if (card.harsh !== null && card.harsh !== undefined) return { tone: "neutral", title: card.harsh === 0 ? "Smooth all the way" : `${card.harsh} harsh moment${card.harsh === 1 ? "" : "s"}`, sub: `Top speed ${U.num(card.maxSpeed * 3.6, 0)} km/h · average ${U.num(card.avgSpeed * 3.6, 0)} km/h` };
        return { tone: "neutral", title: `Average ${U.num(card.avgSpeed * 3.6, 0)} km/h`, sub: `Top speed ${U.num(card.maxSpeed * 3.6, 0)} km/h` };
    }

    /**
     * @param {HTMLCanvasElement} canvas @param {any} card buildCard() result
     * @param {{ format?: "story"|"post", showCost?: boolean, units: any, locale?: string }} o
     */
    function drawCard(canvas, card, o) {
        const U = o.units, fmt = o.format === "post" ? "post" : "story", showCost = o.showCost !== false;
        const Lt = layout(fmt);
        canvas.width = Lt.w; canvas.height = Lt.h;
        const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
        // ---- background ----
        const bg = ctx.createLinearGradient(0, 0, 0, Lt.h);
        bg.addColorStop(0, "#0d1a26"); bg.addColorStop(0.55, C.ink); bg.addColorStop(1, "#060b12");
        ctx.fillStyle = bg; ctx.fillRect(0, 0, Lt.w, Lt.h);
        const glow = ctx.createRadialGradient(Lt.w * 0.5, Lt.box.y + Lt.box.h * 0.45, 10, Lt.w * 0.5, Lt.box.y + Lt.box.h * 0.45, Lt.w * 0.75);
        glow.addColorStop(0, "rgba(52,224,180,0.13)"); glow.addColorStop(1, "rgba(52,224,180,0)");
        ctx.fillStyle = glow; ctx.fillRect(0, 0, Lt.w, Lt.h);

        // ---- header: mark + date ----
        const hy = Lt.header;
        ctx.beginPath(); ctx.arc(Lt.pad + 18, hy - 13, 17, 0, Math.PI * 2); ctx.fillStyle = C.mintSoft; ctx.fill();
        ctx.beginPath(); ctx.arc(Lt.pad + 18, hy - 13, 9, 0, Math.PI * 2); ctx.fillStyle = C.mint; ctx.fill();
        text(ctx, "MapUnite", Lt.pad + 48, hy, `700 38px ${DISPLAY}`, C.text);
        const date = new Intl.DateTimeFormat(o.locale || "en-IN", { weekday: "short", day: "numeric", month: "short" }).format(new Date(card.startedAt));
        ctx.font = `600 26px ${UI}`;
        const dw = ctx.measureText(date).width + 40;
        rr(ctx, Lt.w - Lt.pad - dw, hy - 40, dw, 52, 26); ctx.fillStyle = "rgba(255,255,255,0.07)"; ctx.fill();
        text(ctx, date, Lt.w - Lt.pad - dw / 2, hy - 5, `600 26px ${UI}`, C.soft, "center");

        // ---- title ----
        text(ctx, card.title, Lt.pad, Lt.title, fit(ctx, card.title, 800, DISPLAY, Lt.titleSize, Lt.w - 2 * Lt.pad), C.text, "left", -1);
        const sub = [card.bike, card.place].filter(Boolean).join(" · ") || "Ridden with MapUnite";
        text(ctx, sub, Lt.pad, Lt.sub, fit(ctx, sub, 500, UI, 34, Lt.w - 2 * Lt.pad), C.soft);

        // ---- route art ----
        const b = Lt.box;
        rr(ctx, b.x, b.y, b.w, b.h, 40); ctx.fillStyle = "rgba(255,255,255,0.03)"; ctx.fill();
        ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.stroke();
        ctx.save(); rr(ctx, b.x, b.y, b.w, b.h, 40); ctx.clip();
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        for (let x = b.x + 30; x < b.x + b.w; x += 44) for (let y = b.y + 30; y < b.y + b.h; y += 44) { ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill(); }
        if (card.route && card.route.pts.length > 1) {
            const P = fitRoute(card.route.pts, b, 70);
            const path = () => { ctx.beginPath(); P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); };
            ctx.lineJoin = "round"; ctx.lineCap = "round";
            ctx.shadowColor = "rgba(52,224,180,0.75)"; ctx.shadowBlur = 36;
            path(); ctx.strokeStyle = "rgba(52,224,180,0.28)"; ctx.lineWidth = 22; ctx.stroke();
            ctx.shadowBlur = 0;
            path(); ctx.strokeStyle = C.mint; ctx.lineWidth = 9; ctx.stroke();
            path(); ctx.strokeStyle = "#d9fff3"; ctx.lineWidth = 2.5; ctx.stroke();
            const [sx, sy] = P[0], [ex, ey] = P[P.length - 1];
            ctx.beginPath(); ctx.arc(sx, sy, 14, 0, Math.PI * 2); ctx.fillStyle = C.ink; ctx.fill(); ctx.lineWidth = 6; ctx.strokeStyle = C.text; ctx.stroke();
            ctx.beginPath(); ctx.arc(ex, ey, 19, 0, Math.PI * 2); ctx.fillStyle = C.mint; ctx.fill();
            ctx.beginPath(); ctx.arc(ex, ey, 7, 0, Math.PI * 2); ctx.fillStyle = C.ink; ctx.fill();
        } else {
            text(ctx, "Route not shown", b.x + b.w / 2, b.y + b.h / 2, `600 34px ${UI}`, C.muted, "center");
            text(ctx, "too short to show without giving away start and finish", b.x + b.w / 2, b.y + b.h / 2 + 44, `500 24px ${UI}`, C.muted, "center");
        }
        ctx.restore();
        if (card.route && card.privacy) text(ctx, "start & finish hidden", b.x + b.w - 28, b.y + b.h - 26, `500 22px ${UI}`, C.muted, "right");
        if (card.route && card.route.extent) {
            // a small scale bar: honest about size without a map
            const kmPx = (b.w - 140) / Math.max(1, card.route.extent / 1000);
            const steps = [0.5, 1, 2, 5, 10, 20, 50, 100];
            const len = steps.find((s) => s * kmPx >= 90) || 100;
            const px = Math.min(240, len * kmPx);
            ctx.fillStyle = "rgba(242,246,248,0.6)"; ctx.fillRect(b.x + 30, b.y + b.h - 34, px, 4);
            text(ctx, `${len} km`, b.x + 30, b.y + b.h - 44, `600 22px ${UI}`, C.muted);
        }

        // ---- eco score ring ----
        const r = Lt.ring;
        ctx.beginPath(); ctx.arc(r.cx, r.cy, r.r, 0, Math.PI * 2); ctx.strokeStyle = "rgba(255,255,255,0.1)"; ctx.lineWidth = r.stroke; ctx.stroke();
        if (card.ecoScore !== null) {
            ctx.beginPath(); ctx.arc(r.cx, r.cy, r.r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.01, Math.min(1, card.ecoScore))); ctx.strokeStyle = C.mint; ctx.lineCap = "round"; ctx.stroke();
        }
        text(ctx, card.ecoScore === null ? "–" : String(Math.round(card.ecoScore * 100)), r.cx, r.cy + r.r * 0.22, `800 ${Math.round(r.r * 0.78)}px ${DISPLAY}`, C.text, "center", -2);
        text(ctx, "ECO SCORE", r.cx, r.cy + r.r * 0.52, `700 ${Math.round(r.r * 0.17)}px ${UI}`, C.muted, "center", 3);
        if (card.ecoWord) text(ctx, card.ecoWord, r.cx, r.cy + r.r + r.word, `700 ${Math.round(r.r * 0.27)}px ${DISPLAY}`, C.mint, "center");

        // ---- stats grid ----
        const g = Lt.grid, colW = g.w / 2;
        stats(card, U, showCost).forEach((st, i) => {
            const x = g.x + (i % 2) * colW, y = g.y + Math.floor(i / 2) * g.rowH;
            text(ctx, st.label.toUpperCase(), x, y + 26, `700 ${fmt === "post" ? 21 : 24}px ${UI}`, C.muted, "left", 2);
            const vs = fmt === "post" ? 54 : 64;
            const vw = text(ctx, st.value, x, y + 26 + vs + 8, fit(ctx, st.value, 800, DISPLAY, vs, colW - 70), C.text, "left", -1);
            if (st.unit) text(ctx, st.unit, x + vw + 10, y + 26 + vs + 8, `600 ${fmt === "post" ? 24 : 28}px ${UI}`, C.soft);
        });

        // ---- banner ----
        const bt = bannerText(card, U, showCost), bn = Lt.banner;
        rr(ctx, bn.x, bn.y, bn.w, bn.h, 30);
        ctx.fillStyle = bt.tone === "good" ? "rgba(52,224,180,0.13)" : "rgba(255,255,255,0.05)"; ctx.fill();
        ctx.strokeStyle = bt.tone === "good" ? "rgba(52,224,180,0.45)" : C.line; ctx.lineWidth = 2; ctx.stroke();
        // leaf mark
        const lx = bn.x + 54, ly = bn.y + bn.h / 2;
        ctx.save(); ctx.translate(lx, ly); ctx.strokeStyle = bt.tone === "good" ? C.mint : C.soft; ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.beginPath(); ctx.moveTo(-16, 16); ctx.bezierCurveTo(-16, -8, 0, -18, 20, -20); ctx.bezierCurveTo(18, 2, 6, 18, -16, 16); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-16, 16); ctx.lineTo(6, -4); ctx.stroke(); ctx.restore();
        text(ctx, bt.title, bn.x + 100, bn.y + bn.h / 2 - 4, fit(ctx, bt.title, 700, DISPLAY, fmt === "post" ? 36 : 40, bn.w - 130), C.text);
        text(ctx, bt.sub, bn.x + 100, bn.y + bn.h / 2 + 34, fit(ctx, bt.sub, 500, UI, fmt === "post" ? 23 : 26, bn.w - 130), C.soft);

        // ---- footer ----
        const foot = card.estimated ? "Estimated by MapUnite from GPS speed" : card.matched ? "Estimated by MapUnite physics from live GPS, matched to my fill-ups" : "Estimated by MapUnite physics from live GPS";
        text(ctx, foot, Lt.w / 2, Lt.foot, fit(ctx, foot, 500, UI, 24, Lt.w - 2 * Lt.pad), C.muted, "center");
        return canvas;
    }

    return { SIZES, layout, fitRoute, stats, bannerText, drawCard };
});
