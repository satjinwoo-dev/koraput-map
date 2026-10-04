// @ts-check
/* ============================================================================
   MapUnite share — the post-ride share sheet
   ==============================================================================
   MUShare.ui.createShareSheet(root, deps) → { open(summary), close, render }

   Pops up when a ride ends (or from "Share ride" in the trip summary):
     - a live preview of the card (the real canvas, scaled to fit);
     - Story (9:16) or Post (4:5);
     - "Hide where I started and finished" (on by default) and "Show the cost";
     - Share (the system share sheet, with the PNG, where the browser supports
       sharing files), Save image (download), Copy image (clipboard, where
       supported);
     - "Show this after every ride" (remembered on this phone).
   The image is drawn on the phone; nothing is uploaded.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUShare || (/** @type {any} */ (root).MUShare = {}); ns.ui = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const PREFS_KEY = "mu.share.v1";
    /**
     * @template {keyof HTMLElementTagNameMap} K
     * @param {K} tag @param {Record<string, any>} [attrs] @param {Array<Node|string|null|false>} [kids]
     * @returns {HTMLElementTagNameMap[K]}
     */
    function h(tag, attrs = {}, kids = []) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === "class") el.className = v;
            else if (k === "text") el.textContent = v;
            else if (k === "html") el.innerHTML = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c !== null && c !== false) el.append(c);
        return el;
    }
    const ICON = {
        share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>`,
        save: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>`,
        copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`,
        x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`
    };

    /** @param {Storage|null} st */
    function loadPrefs(st) {
        const d = { format: "story", privacy: true, showCost: true, auto: true };
        try { const p = JSON.parse((st && st.getItem(PREFS_KEY)) || "{}") || {}; if (p.format === "post" || p.format === "story") d.format = p.format; for (const k of ["privacy", "showCost", "auto"]) if (typeof p[k] === "boolean") d[k] = p[k]; } catch { /* defaults */ }
        return d;
    }
    function savePrefs(st, p) { try { if (st) st.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* blocked */ } }

    /** A file name like mapunite-evening-ride-2026-10-04.png @param {any} card */
    function fileName(card) {
        const d = new Date(card.startedAt);
        const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return `mapunite-${card.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${ymd}.png`;
    }

    /**
     * @param {HTMLElement} root
     * @param {{ model: any, render: any, units: any, storage?: Storage|null, onClose?: () => void, nav?: any, fonts?: any }} deps
     */
    function createShareSheet(root, deps) {
        const U = deps.units;
        const storage = deps.storage !== undefined ? deps.storage : (() => { try { return globalThis.localStorage; } catch { return null; } })();
        const nav = deps.nav || (typeof navigator !== "undefined" ? navigator : null);
        const prefs = loadPrefs(storage);
        let summary = null, card = null, blobUrl = null;
        root.classList.add("sh");

        const canvas = h("canvas", { class: "sh-canvas", role: "img", "aria-label": "Your ride card" });
        const status = h("p", { class: "sh-status", role: "status", "aria-live": "polite" });
        const seg = (items, get, set) => h("div", { class: "sh-seg", role: "radiogroup", "aria-label": "Card size" }, items.map(([v, label]) => h("button", { type: "button", role: "radio", class: "sh-seg-btn", "data-v": v, "aria-checked": String(get() === v), text: label, onclick: (e) => {
            set(v);
            for (const b of /** @type {HTMLElement} */ (e.currentTarget).parentElement.children) b.setAttribute("aria-checked", String(b.getAttribute("data-v") === v));
        } })));
        const toggle = (label, key) => {
            const id = `sh-${key}-${Math.random().toString(36).slice(2, 6)}`;
            const input = h("input", { type: "checkbox", id, class: "switch", onchange: (e) => { prefs[key] = /** @type {HTMLInputElement} */ (e.currentTarget).checked; savePrefs(storage, prefs); if (key !== "auto") build(); } });
            input.checked = !!prefs[key];
            return h("label", { class: "sh-toggle", for: id }, [h("span", { text: label }), input]);
        };
        const canShareFiles = !!(nav && typeof nav.canShare === "function" && typeof File === "function" && (() => { try { return nav.canShare({ files: [new File([new Blob([""], { type: "image/png" })], "x.png", { type: "image/png" })] }); } catch { return false; } })());
        const canCopy = !!(nav && nav.clipboard && typeof nav.clipboard.write === "function" && typeof globalThis.ClipboardItem === "function");
        const actions = h("div", { class: "sh-actions" }, [
            canShareFiles ? h("button", { type: "button", class: "sh-btn", onclick: share }, [h("span", { class: "sh-i", "aria-hidden": "true", html: ICON.share }), "Share"]) : null,
            h("button", { type: "button", class: canShareFiles ? "sh-btn-ghost" : "sh-btn", onclick: save }, [h("span", { class: "sh-i", "aria-hidden": "true", html: ICON.save }), "Save image"]),
            canCopy ? h("button", { type: "button", class: "sh-btn-ghost", onclick: copy }, [h("span", { class: "sh-i", "aria-hidden": "true", html: ICON.copy }), "Copy"]) : null
        ]);
        root.replaceChildren(
            h("header", { class: "sh-head" }, [
                h("div", {}, [h("h2", { class: "sh-title", text: "Share your ride" }), h("p", { class: "sh-sub", text: "Made on your phone. Nothing is uploaded." })]),
                h("button", { type: "button", class: "sh-close", "aria-label": "Close", html: ICON.x, onclick: () => close() })
            ]),
            h("div", { class: "sh-body" }, [
                h("div", { class: "sh-preview" }, [canvas]),
                h("div", { class: "sh-side" }, [
                    seg([["story", "Story 9:16"], ["post", "Post 4:5"]], () => prefs.format, (v) => { prefs.format = v; savePrefs(storage, prefs); build(); }),
                    h("div", { class: "sh-opts" }, [toggle("Hide where I started and finished", "privacy"), toggle("Show the cost", "showCost"), toggle("Show this after every ride", "auto")]),
                    actions, status
                ])
            ])
        );

        async function build() {
            if (!summary) return;
            card = deps.model.buildCard(summary, { privacy: prefs.privacy });
            if (deps.fonts && typeof deps.fonts.load === "function") {
                try { await Promise.race([Promise.all(["800 80px Sora", "700 40px Sora", "500 30px Inter", "700 24px Inter"].map((f) => deps.fonts.load(f))), new Promise((r) => setTimeout(r, 1200))]); } catch { /* system fonts */ }
            }
            deps.render.drawCard(canvas, card, { format: prefs.format, showCost: prefs.showCost, units: U });
            canvas.dataset.format = prefs.format;
            canvas.setAttribute("aria-label", `${card.title}: ${U.num(card.distance / 1000, 1)} km${card.ecoScore !== null ? `, eco score ${Math.round(card.ecoScore * 100)}` : ""}${card.saved ? `, ${U.num(card.saved.share * 100, 0)} % less fuel than usual` : ""}`);
            status.textContent = "";
        }
        const toBlob = () => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make the image"))), "image/png"));

        async function share() {
            try {
                const blob = await toBlob();
                const file = new File([/** @type {Blob} */ (blob)], fileName(card), { type: "image/png" });
                await nav.share({ files: [file], title: card.title, text: `${card.title} · ${U.num(card.distance / 1000, 1)} km with MapUnite` });
                status.textContent = "Shared.";
            } catch (e) { if (/** @type {any} */ (e).name !== "AbortError") { status.textContent = "Sharing didn't work here. Saving the image instead."; save(); } }
        }
        async function save() {
            try {
                const blob = await toBlob();
                if (blobUrl) URL.revokeObjectURL(blobUrl);
                blobUrl = URL.createObjectURL(/** @type {Blob} */ (blob));
                const a = h("a", { href: blobUrl, download: fileName(card) });
                document.body.append(a); a.click(); a.remove();
                status.textContent = "Saved to your downloads.";
            } catch (e) { status.textContent = /** @type {Error} */ (e).message; }
        }
        async function copy() {
            try {
                const blob = await toBlob();
                await nav.clipboard.write([new globalThis.ClipboardItem({ "image/png": blob })]);
                status.textContent = "Copied. Paste it into any app.";
            } catch { status.textContent = "Copying images isn't allowed here. Use Save image."; }
        }

        function open(s) {
            summary = s;
            root.hidden = false;
            build();
            const c = root.querySelector(".sh-close"); if (c) /** @type {HTMLElement} */ (c).focus();
        }
        function close() { root.hidden = true; if (deps.onClose) deps.onClose(); }

        return { open, close, render: build, get card() { return card; }, get prefs() { return prefs; }, canvas };
    }

    return { PREFS_KEY, loadPrefs, fileName, createShareSheet };
});
