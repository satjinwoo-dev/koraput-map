/* ============================================================================
   MapUnite Rider Passport — the screen, the card, and where its numbers come from
   ==============================================================================
   Opens from Smart Drive Settings → "Rider Passport". Shows the three kinds of
   line from passport-model.js (self-reported, recorded by MapUnite, confirmed
   by other riders), each with its own visibility: "Only me" or "On my card".
   The rider edits the self-reported part here; nothing else can be edited.

   Data:
     self + visibility    localStorage "mu.passport.v1" (this phone only)
     rides                MURides.app.summaries() (the ride log, this phone only)
     road reports         "mu:roadpulse-reviewed" from the post-ride review
                          (js/master/roadsense/review.js), one entry per ride
     confirmed / thanks   the RoadPulse server's /roadsense/me, only when the
                          rider has Community road reports on
     places shared        MUPlaceShare.sharedCount
   MapUnite has no public profile: the Passport leaves the phone only as the
   card image the rider shares, with only the lines marked "On my card".
   ============================================================================ */
"use strict";

const MUPassport = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    if (!W || !W.document || !W.MUPassportModel) return {};
    const M = W.MUPassportModel;
    const KEY = "mu.passport.v1";

    function load() {
        try { const s = JSON.parse(localStorage.getItem(KEY) || "{}"); return { self: s.self || {}, visibility: s.visibility || {}, reports: s.reports || {} }; } catch (e) { return { self: {}, visibility: {}, reports: {} }; }
    }
    function save(st) { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* private mode */ } }

    // one tally per reviewed ride (a ride reviewed twice is counted once, the latest answers win)
    document.addEventListener("mu:roadpulse-reviewed", (e) => {
        const d = /** @type {CustomEvent} */ (e).detail || {};
        if (!Number.isFinite(d.startedAt)) return;
        const st = load();
        st.reports[String(d.startedAt)] = { detected: d.detected | 0, reviewed: d.reviewed | 0, published: d.published | 0, at: Date.now() };
        const keys = Object.keys(st.reports);
        if (keys.length > 500) for (const k of keys.sort((a, b) => Number(a) - Number(b)).slice(0, keys.length - 500)) delete st.reports[k];
        save(st);
    });

    const caps = () => (W.MUMaster && W.MUMaster.live && W.MUMaster.live.caps ? W.MUMaster.live.caps : null);
    async function community() {
        const c = caps();
        const sync = c ? c.get("roadsense-sync") : null;
        if (!sync || typeof sync.reputation !== "function") return null;
        try { return await sync.reputation(); } catch (e) { return null; }
    }
    function riderName() { try { return (typeof currentUser !== "undefined" && currentUser.name) || ""; } catch (e) { return ""; } }

    async function current() {
        const st = load();
        return M.build({
            self: { ...st.self, name: riderName() }, visibility: st.visibility, reports: st.reports,
            rides: W.MURides && W.MURides.app && typeof W.MURides.app.summaries === "function" ? W.MURides.app.summaries() : [],
            community: await community(), placesShared: W.MUPlaceShare ? W.MUPlaceShare.sharedCount : 0
        });
    }

    // ------------------------------------------------------------ the card (1080 × 1350, drawn on the phone)
    // Bento style (js/share/card-styles.js, loaded with the recap): a name header, self-reported chips, tiles for
    // what MapUnite recorded and what other riders confirmed (each tile says which), and the badges earned.
    const FONT = `"Inter", system-ui, sans-serif`, DISPLAY = `"Sora", "Inter", system-ui, sans-serif`;
    function drawCard(canvas, card) {
        const S = W.MUShare && W.MUShare.styles;
        canvas.width = 1080; canvas.height = 1350;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#050608"; ctx.fillRect(0, 0, 1080, 1350);
        for (const [cx, cy, r, c] of [[120, 80, 760, "rgba(52,224,180,0.13)"], [1000, 1250, 820, "rgba(99,102,241,0.12)"]]) {
            const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r); g.addColorStop(0, c); g.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = g; ctx.fillRect(0, 0, 1080, 1350);
        }
        const t = (s, x, y, font, color, align = "left") => { ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = "alphabetic"; ctx.fillText(s, x, y); return ctx.measureText(s).width; };
        const fitFont = (s, w, size, weight, fam) => { let px = size; for (; px > 16; px -= 2) { ctx.font = `${weight} ${px}px ${fam}`; if (ctx.measureText(s).width <= w) break; } return `${weight} ${px}px ${fam}`; };
        const rr = (x, y, w, h, r) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };
        const tile = (b) => (S ? S.tile(ctx, b, 40) : (rr(b.x, b.y, b.w, b.h, 40), ctx.fillStyle = "rgba(255,255,255,0.06)", ctx.fill()));
        const grad = (x, y, w, a = "#34e0b4", b = "#22d3ee") => { const g = ctx.createLinearGradient(x, y - 60, x + w, y); g.addColorStop(0, a); g.addColorStop(1, b); return g; };
        const m = 56;
        if (S) S.brand(ctx, m + 4, 96, 30); else t("MapUnite", m, 96, `700 30px ${DISPLAY}`, "#f5f7fa");
        rr(1080 - m - 250, 58, 250, 52, 26); ctx.fillStyle = "rgba(52,224,180,0.14)"; ctx.fill();
        t("RIDER PASSPORT", 1080 - m - 125, 92, `700 22px ${FONT}`, "#34e0b4", "center");
        const name = card.name || "Rider";
        const nf = fitFont(name, 968, 96, 800, DISPLAY);
        ctx.font = nf;
        t(name, m, 220, nf, grad(m, 220, ctx.measureText(name).width, "#ffffff", "#a7f3d0"));
        // self-reported chips
        const self = card.sections.find((x) => x.source === "self");
        let cx = m, cy = 262;
        if (self) {
            for (const it of self.items) {
                const s = it.id === "experience" ? `Riding since ${it.value}` : it.value;
                ctx.font = `600 26px ${FONT}`;
                const w = Math.min(968, ctx.measureText(s).width + 48);
                if (cx + w > 1080 - m) { cx = m; cy += 62; }
                rr(cx, cy, w, 50, 25); ctx.fillStyle = "rgba(255,255,255,0.08)"; ctx.fill();
                t(s, cx + 24, cy + 34, fitFont(s, w - 48, 26, 600, FONT), "#dbe3ea");
                cx += w + 12;
            }
            t("SELF-REPORTED", m, cy + 88, `700 18px ${FONT}`, "#7d8a97");
            cy += 112;
        } else cy += 10;
        // tiles: recorded + confirmed
        const tiles = [];
        for (const sec of card.sections.filter((x) => x.source !== "self")) for (const it of sec.items) tiles.push({ ...it, source: sec.source });
        // fewer tiles: taller ones, so the card is full either way
        const rows = Math.max(1, Math.ceil(Math.min(6, tiles.length) / 2));
        const tw = (1080 - 2 * m - 24) / 2, th = Math.max(196, Math.min(280, (1180 - cy - (rows - 1) * 24) / rows));
        tiles.slice(0, 6).forEach((it, i) => {
            const b = { x: m + (i % 2) * (tw + 24), y: cy + Math.floor(i / 2) * (th + 24), w: tw, h: th };
            if (b.y + b.h > 1180) return;
            tile(b);
            t(it.label.toUpperCase(), b.x + 30, b.y + 48, `700 20px ${FONT}`, "#7d8a97");
            const mt = /^([\d.,]+)\s*(.*)$/.exec(it.value) || [null, it.value, ""];
            const vf = fitFont(mt[1], b.w - 140, 92, 800, DISPLAY);
            ctx.font = vf;
            const vw = ctx.measureText(mt[1]).width;
            const vy = b.y + b.h - 62;
            t(mt[1], b.x + 28, vy, vf, it.source === "community" ? grad(b.x, vy, vw) : "#f5f7fa");
            if (mt[2]) t(mt[2], b.x + 36 + vw, vy, `600 28px ${FONT}`, "#b9c4cf");
            t(it.source === "community" ? "confirmed by other riders" : "recorded by MapUnite", b.x + 30, b.y + b.h - 22, `500 19px ${FONT}`, it.source === "community" ? "#34e0b4" : "#7d8a97");
        });
        // badges
        if (card.badges.length) {
            const by = 1206;
            let bx = m;
            for (const b of card.badges.slice(0, 4)) {
                ctx.font = `700 24px ${DISPLAY}`;
                const w = ctx.measureText(b.name).width + 74;
                if (bx + w > 1080 - m) break;
                rr(bx, by, w, 56, 28); ctx.fillStyle = "rgba(52,224,180,0.14)"; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(52,224,180,0.45)"; ctx.stroke();
                ctx.beginPath(); ctx.arc(bx + 28, by + 28, 9, 0, Math.PI * 2); ctx.fillStyle = "#34e0b4"; ctx.fill();
                t(b.name, bx + 48, by + 37, `700 24px ${DISPLAY}`, "#e6fff7");
                bx += w + 12;
            }
        }
        t("Confirmed = other riders' independent rides. Self-reported lines are the rider's own.", 540, 1312, `500 20px ${FONT}`, "#6b7a89", "center");
        return canvas;
    }

    // ------------------------------------------------------------ the screen
    const h = (tag, a = {}, kids = []) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(a)) {
            if (v == null || v === false) continue;
            if (k === "class") el.className = v; else if (k === "text") el.textContent = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c != null && c !== false) el.append(c);
        return el;
    };
    let modal = null;
    async function open() {
        if (modal) modal.remove();
        const st = load();
        const body = h("div", { class: "pp-body" }, [h("p", { class: "pp-sub", text: "Loading…" })]);
        const close = () => { if (modal) { modal.remove(); modal = null; } };
        modal = h("div", { class: "modal pp-modal", role: "dialog", "aria-modal": "true", "aria-label": "Rider Passport", onclick: (e) => { if (e.target === modal) close(); } }, [
            h("div", { class: "modal-card pp-card pp-wide" }, [h("button", { class: "close-modal", type: "button", "aria-label": "Close", text: "✕", onclick: close }), h("h2", { text: "Rider Passport" }), body])
        ]);
        document.body.append(modal);
        modal.style.display = "flex";

        const render = async () => {
            const p = await current();
            const year = new Date().getFullYear();
            const since = h("input", { class: "pp-input", type: "number", min: "1950", max: String(year), inputmode: "numeric", value: st.self.ridingSince || "", placeholder: "e.g. 2016", "aria-label": "Riding since (year)" });
            const bike = h("input", { class: "pp-input", type: "text", maxlength: "40", value: st.self.bike || "", placeholder: "e.g. Pulsar 150", "aria-label": "Usual bike" });
            const about = h("textarea", { class: "pp-input", maxlength: "140", rows: "2", placeholder: "One line about your riding (optional)", "aria-label": "About you" });
            about.value = st.self.about || "";
            const saveSelf = () => {
                const y = Number(since.value);
                st.self = { ridingSince: Number.isInteger(y) && y >= 1950 && y <= year ? y : null, bike: bike.value.trim().slice(0, 40), about: about.value.trim().slice(0, 140) };
                save(st); render();
            };
            const visSel = (it) => {
                const sel = h("select", { class: "pp-vis", "aria-label": `Who sees "${it.label}"` }, [h("option", { value: "private", text: "Only me" }), h("option", { value: "card", text: "On my card" })]);
                sel.value = it.visibility;
                sel.addEventListener("change", () => { st.visibility = { ...st.visibility, [it.id]: sel.value }; save(st); render(); });
                return sel;
            };
            const sections = p.sections.map((s) => h("section", { class: `pp-sec pp-${s.source}` }, [
                h("div", { class: "pp-sec-head" }, [h("h3", { text: s.title }), h("span", { class: "pp-tag", text: s.tag })]),
                s.items.length ? null : h("p", { class: "pp-sub", text: s.empty || (s.source === "self" ? "Add something below: it's shown as self-reported." : "") }),
                ...s.items.map((it) => h("div", { class: "pp-line" }, [
                    h("div", {}, [h("div", { class: "pp-l", text: it.label }), it.note ? h("div", { class: "pp-n", text: it.note }) : null]),
                    h("div", { class: "pp-v", text: it.value }), visSel(it)
                ]))
            ]));
            const badgeSel = h("select", { class: "pp-vis", "aria-label": "Who sees your badges" }, [h("option", { value: "private", text: "Only me" }), h("option", { value: "card", text: "On my card" })]);
            badgeSel.value = { ...M.DEFAULT_VIS, ...st.visibility }.badges;
            badgeSel.addEventListener("change", () => { st.visibility = { ...st.visibility, badges: badgeSel.value }; save(st); render(); });
            const badges = h("section", { class: "pp-sec" }, [
                h("div", { class: "pp-sec-head" }, [h("h3", { text: "Badges" }), badgeSel]),
                h("p", { class: "pp-sub", text: "For reports other riders' rides confirmed, never for distance, speed or likes." }),
                ...p.badges.map((b) => h("div", { class: `pp-badge${b.earned ? " on" : ""}` }, [
                    h("div", { class: "pp-l", text: `${b.earned ? "🏅" : "○"} ${b.name}${b.local ? ` · ${b.local}` : ""}` }),
                    h("div", { class: "pp-n", text: b.why })
                ]))
            ]);
            const canvas = h("canvas", { class: "pp-canvas", role: "img", "aria-label": "Your Passport card" });
            const status = h("p", { class: "pp-status", role: "status" });
            const cardWrap = h("section", { class: "pp-sec", hidden: true }, [h("h3", { text: "Card preview: only the lines marked On my card" }), canvas,
                h("div", { class: "pp-actions" }, [
                    h("button", { type: "button", class: "btn-primary-nav", text: "Share card", onclick: () => canvas.toBlob(async (blob) => { if (!blob) return; status.textContent = W.MUShareOut.said(await W.MUShareOut.image({ blob, fileName: "mapunite-passport.png", title: "My MapUnite Rider Passport" })); }, "image/png") })
                ]), status]);
            body.replaceChildren(
                h("p", { class: "pp-sub", text: "Kept on this phone. MapUnite has no public profile page: your Passport leaves the phone only as a card image you share, with only the lines you mark On my card." }),
                h("section", { class: "pp-sec pp-self" }, [h("div", { class: "pp-sec-head" }, [h("h3", { text: "Edit what you say about yourself" }), h("span", { class: "pp-tag", text: "Self-reported" })]),
                    h("label", { class: "pp-label", text: "Riding since (year)" }), since, h("label", { class: "pp-label", text: "Usual bike" }), bike, h("label", { class: "pp-label", text: "About" }), about,
                    h("div", { class: "pp-actions" }, [h("button", { type: "button", class: "btn-secondary-nav", text: "Save", onclick: saveSelf })])]),
                ...sections, badges,
                h("div", { class: "pp-actions" }, [h("button", { type: "button", class: "btn-primary-nav", text: "Preview my card", onclick: async () => {
                    // the card's Bento tiles come from the recap's styles: load them on first use (precached)
                    if (W.MUShare && W.MUShare.app && typeof W.MUShare.app.load === "function" && !W.MUShare.styles) { try { await W.MUShare.app.load(); } catch (e) { /* plain tiles */ } }
                    drawCard(canvas, M.forCard(p, { ...M.DEFAULT_VIS, ...st.visibility })); cardWrap.hidden = false; cardWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
                } })]),
                cardWrap
            );
        };
        render();
    }

    function wire() {
        const b = document.getElementById("passport-open-btn");
        if (b) b.addEventListener("click", open);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
    return { open, current, drawCard };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).MUPassport = MUPassport;
