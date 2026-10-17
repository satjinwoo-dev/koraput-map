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
    const FONT = `"Inter", system-ui, sans-serif`, DISPLAY = `"Sora", "Inter", system-ui, sans-serif`;
    function drawCard(canvas, card) {
        canvas.width = 1080; canvas.height = 1350;
        const ctx = canvas.getContext("2d");
        const g = ctx.createLinearGradient(0, 0, 0, 1350);
        g.addColorStop(0, "#0d1a26"); g.addColorStop(1, "#05090f");
        ctx.fillStyle = g; ctx.fillRect(0, 0, 1080, 1350);
        const t = (s, x, y, font, color, align = "left") => { ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(s, x, y); };
        const fitFont = (s, w, size, weight, fam) => { let px = size; for (; px > 16; px -= 2) { ctx.font = `${weight} ${px}px ${fam}`; if (ctx.measureText(s).width <= w) break; } return `${weight} ${px}px ${fam}`; };
        t("RIDER PASSPORT", 80, 120, `700 28px ${FONT}`, "#34e0b4");
        t(card.name || "Rider", 80, 200, fitFont(card.name || "Rider", 920, 76, 800, DISPLAY), "#f2f6f8");
        let y = 270;
        for (const s of card.sections) {
            if (y > 1080) break;
            ctx.font = `700 22px ${FONT}`;
            const tag = s.tag.toUpperCase(), tw = ctx.measureText(tag).width + 36;
            ctx.fillStyle = s.source === "self" ? "rgba(255,255,255,0.08)" : s.source === "community" ? "rgba(52,224,180,0.16)" : "rgba(77,163,255,0.16)";
            ctx.beginPath(); ctx.roundRect ? ctx.roundRect(80, y, tw, 40, 20) : ctx.rect(80, y, tw, 40); ctx.fill();
            t(tag, 98, y + 28, `700 22px ${FONT}`, s.source === "self" ? "#c6d2db" : s.source === "community" ? "#34e0b4" : "#8ec5ff");
            y += 76;
            for (const it of s.items) {
                if (y > 1110) break;
                t(it.label, 80, y, `500 30px ${FONT}`, "#8b9bab");
                t(it.value, 1000, y, fitFont(it.value, 520, 40, 700, DISPLAY), "#f2f6f8", "right");
                y += 58;
            }
            y += 20;
        }
        if (card.badges.length) {
            t("BADGES", 80, Math.min(y + 10, 1160), `700 22px ${FONT}`, "#8b9bab");
            t(card.badges.map((b) => b.name).join(" · "), 80, Math.min(y + 56, 1206), fitFont(card.badges.map((b) => b.name).join(" · "), 920, 34, 700, DISPLAY), "#34e0b4");
        }
        t("Self-reported lines are the rider's own. Confirmed = other riders' independent rides.", 540, 1290, `500 22px ${FONT}`, "#6b7a89", "center");
        t("MapUnite", 1000, 120, `700 28px ${DISPLAY}`, "rgba(242,246,248,0.55)", "right");
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
                h("div", { class: "pp-actions" }, [h("button", { type: "button", class: "btn-primary-nav", text: "Preview my card", onclick: () => { drawCard(canvas, M.forCard(p, { ...M.DEFAULT_VIS, ...st.visibility })); cardWrap.hidden = false; cardWrap.scrollIntoView({ behavior: "smooth", block: "nearest" }); } })]),
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
