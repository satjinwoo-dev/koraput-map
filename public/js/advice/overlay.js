// @ts-check
/* ============================================================================
   MapUnite advice — the speed-advice badge (Step 8, view)
   ==============================================================================
   MUAdvice.overlay.createOverlay(root, { units, onToggle, onOpenSettings })
     → { update(model, ctx), place(anchor), show(), hide(), destroy() }

   A small badge stacked on the existing speed-limit sign (#speed-limit-sign), in
   the left column above the speed dial, so it never covers the HUD strip or the
   turn banner. It shows, at most, ONE thing:
     - the speed advised for the conditions ("ADVISED 50 · Wet"), or
     - the condition alone when no limit is known ("WET · Ease off"), or
     - how far over the posted limit you are ("OVER BY 8 km/h"), or
     - a muted bell when quiet ride is on and there's nothing else to say.
   Tapping it (best done at a stop) opens a small card with the reason, the
   source, and the two switches a rider might want mid-ride: Quiet ride and
   Weather alerts. Words + icon always; colour only reinforces.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUAdvice || (/** @type {any} */ (root).MUAdvice = {}); ns.overlay = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const ICON = {
        drop: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.7s6 6.4 6 11.3a6 6 0 0 1-12 0c0-4.9 6-11.3 6-11.3z"/></svg>`,
        rain: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 15a4.5 4.5 0 0 0-1-8.9A6 6 0 0 0 5 8.5 4 4 0 0 0 6 16"/><path d="M8 19v2M12 17v4M16 19v2"/></svg>`,
        storm: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 15a4.5 4.5 0 0 0-1-8.9A6 6 0 0 0 5 8.5 4 4 0 0 0 6 16"/><path d="m13 12-3 5h4l-3 5"/></svg>`,
        fog: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9h16M3 13h18M5 17h14M8 5h8"/></svg>`,
        ice: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M4.9 6.5l14.2 11M19.1 6.5 4.9 17.5"/><path d="m9 4 3 2 3-2M9 20l3-2 3 2"/></svg>`,
        wind: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h16a3 3 0 1 1-3 3"/><path d="M3 16h7"/></svg>`,
        sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
        cloud: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.5A4 4 0 0 0 6 19z"/></svg>`,
        over: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18h.01"/></svg>`,
        mute: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M13.7 21a2 2 0 0 1-3.4 0"/><path d="M18.6 13A17.9 17.9 0 0 1 18 8M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.3-5"/><path d="m2 2 20 20"/></svg>`,
        x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`
    };

    /**
     * @template {keyof HTMLElementTagNameMap} K
     * @param {K} tag @param {Record<string, any>} [attrs] @param {Array<Node|string|null|false|undefined>} [kids]
     * @returns {HTMLElementTagNameMap[K]}
     */
    function h(tag, attrs = {}, kids = []) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === "class") el.className = v;
            else if (k === "text") el.textContent = v;
            else if (k === "html") el.innerHTML = v;                 // static icon markup only
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c !== null && c !== false && c !== undefined) el.append(c);
        return el;
    }

    /**
     * @param {HTMLElement} root
     * @param {{ units: any, onToggle?: (key: "quiet"|"weather", on: boolean) => void, onOpenSettings?: () => void }} deps
     */
    function createOverlay(root, deps) {
        const U = deps.units;
        root.classList.add("adv");
        let open = false, lastModel = null, lastCtx = null;

        const kicker = h("span", { class: "adv-k" });
        const value = h("span", { class: "adv-v" });
        const wordI = h("span", { class: "adv-wi", "aria-hidden": "true" });
        const wordT = h("span", { class: "adv-wt" });
        const quietMark = h("span", { class: "adv-q", "aria-hidden": "true", html: ICON.mute, hidden: true });
        const chip = h("button", { type: "button", class: "adv-chip", "aria-expanded": "false", "aria-controls": "advice-pop", onclick: () => setOpen(!open) },
            [kicker, value, h("span", { class: "adv-w" }, [wordI, wordT]), quietMark]);

        const popIcon = h("span", { class: "adv-pop-i", "aria-hidden": "true" });
        const popTitle = h("strong", { class: "adv-pop-title" });
        const popDetail = h("p", { class: "adv-pop-detail" });
        const popMode = h("p", { class: "adv-pop-mode" });
        const toggle = (key, label) => {
            const input = h("input", { type: "checkbox", class: "adv-switch", onchange: (e) => { if (deps.onToggle) deps.onToggle(key, /** @type {HTMLInputElement} */ (e.currentTarget).checked); } });
            return { input, el: h("label", { class: "adv-toggle" }, [h("span", { text: label }), input]) };
        };
        const tQuiet = toggle("quiet", "Quiet ride"), tWeather = toggle("weather", "Weather alerts");
        const pop = h("div", { id: "advice-pop", class: "adv-pop", role: "dialog", "aria-label": "Speed advice", hidden: true }, [
            h("div", { class: "adv-pop-head" }, [popIcon, popTitle, h("button", { type: "button", class: "adv-pop-x", "aria-label": "Close", html: ICON.x, onclick: () => setOpen(false) })]),
            popDetail, popMode,
            h("div", { class: "adv-pop-toggles" }, [tQuiet.el, tWeather.el]),
            h("p", { class: "adv-pop-foot" }, [
                "Advice only: road signs always win. ",
                deps.onOpenSettings ? h("button", { type: "button", class: "adv-link", text: "More in settings", onclick: () => { setOpen(false); deps.onOpenSettings && deps.onOpenSettings(); } }) : null
            ])
        ]);
        root.replaceChildren(chip, pop);

        function setOpen(on) {
            open = Boolean(on) && !chip.hidden;
            pop.hidden = !open;
            chip.setAttribute("aria-expanded", String(open));
            if (open) renderPop();
        }
        function onKey(e) { if (open && e.key === "Escape") { setOpen(false); chip.focus(); } }
        document.addEventListener("keydown", onKey);

        function renderPop() {
            const m = lastModel, c = lastCtx || {};
            const icon = m ? m.icon : "mute";
            popIcon.innerHTML = /** @type {any} */ (ICON)[icon] || ICON.cloud;
            popIcon.dataset.tone = m ? m.tone : "info";
            popTitle.textContent = m ? m.title : "Quiet ride is on";
            popDetail.textContent = m ? m.detail : "Only safety warnings are spoken. Tips wait until you switch it off.";
            popMode.textContent = c.mode ? `${c.mode.label}: ${c.mode.detail}` : "";
            popMode.hidden = !c.mode;
            tQuiet.input.checked = Boolean(c.quiet);
            tWeather.input.checked = c.weather !== false;
        }

        /**
         * @param {any} m  MUAdvice.conditions.overlayModel() result, or null
         * @param {{ quiet?: boolean, weather?: boolean, mode?: { key: string, label: string, detail: string } }} ctx
         */
        function update(m, ctx = {}) {
            lastModel = m; lastCtx = ctx;
            const quiet = Boolean(ctx.quiet);
            const show = Boolean(m) || quiet;
            chip.hidden = !show;
            root.hidden = !show;
            if (!show) { setOpen(false); return; }
            chip.dataset.tone = m ? m.tone : "quiet";
            if (m) {
                kicker.textContent = m.kicker;
                value.hidden = m.value === null;
                value.textContent = m.value === null ? "" : U.num(m.value * 3.6, 0);
                wordI.innerHTML = /** @type {any} */ (ICON)[m.icon] || "";
                wordT.textContent = m.word;
                chip.setAttribute("aria-label", `${m.title}${quiet ? ". Quiet ride is on" : ""}. Tap for details.`);
            } else {
                kicker.textContent = "Quiet";
                value.hidden = true; value.textContent = "";
                wordI.innerHTML = ICON.mute; wordT.textContent = "ride";
                chip.setAttribute("aria-label", "Quiet ride is on: only safety warnings are spoken. Tap for details.");
            }
            quietMark.hidden = !(quiet && m);
            chip.classList.toggle("is-word", !m || m.value === null);
            if (open) renderPop();
        }

        /**
         * Stack the badge above the limit sign (or the speed dial when no sign shows).
         * @param {{ left: number, top: number, width: number }|null} anchor  viewport rect
         */
        function place(anchor) {
            if (!anchor) { root.style.removeProperty("--adv-left"); root.style.removeProperty("--adv-bottom"); return; }
            const vh = window.innerHeight;
            const w = chip.offsetWidth || 72;
            root.style.setProperty("--adv-left", `${Math.max(8, Math.round(anchor.left + anchor.width / 2 - w / 2))}px`);
            root.style.setProperty("--adv-bottom", `${Math.round(vh - anchor.top + 8)}px`);
        }

        return {
            update, place,
            show() { if (lastModel || (lastCtx && lastCtx.quiet)) root.hidden = false; },
            hide() { root.hidden = true; setOpen(false); },
            get open() { return open; },
            destroy() { document.removeEventListener("keydown", onKey); root.replaceChildren(); }
        };
    }

    return { ICON, createOverlay };
});
