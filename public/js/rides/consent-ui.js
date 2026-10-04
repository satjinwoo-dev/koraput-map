// @ts-check
/* ============================================================================
   MapUnite rides — privacy consent (anonymous tank telemetry) and
   "Delete my history" (roadmap step 10, view)
   ==============================================================================
   createConsentDialog(root, deps) → { open(), close() }
     Opt-in to FLEET.md (anonymous full-tank records, POST /api/bikes/fillups). Plain words first (what's shared / never shared, with
     one real example from the rider's own tanks), the exact JSON payload one tap
     away, two equal buttons, nothing pre-ticked. Once on: what's been shared and
     "Stop sharing and delete".
   createWipeDialog(root, deps) → { open(), close() }
     Pick what to erase (everything ticked), confirm once, see what was done.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MURides || (/** @type {any} */ (root).MURides = {}); ns.consent = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const ICON = {
        shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>`,
        check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>`,
        no: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
        trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>`,
        x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`
    };

    /**
     * One tank in words (the consent screen's example). Pure.
     * @param {any} t a tank as POST /api/bikes/fillups takes it (FLEET.md): km, litres, idleH,
     *   hist (km per 5 km/h bin), massKg, fuelCode @param {any} U units
     */
    function tankInWords(t, U) {
        const hist = Array.isArray(t.hist) ? t.hist : [];
        const sum = hist.reduce((a, x) => a + (Number(x) || 0), 0) || 1;
        const band = (a, b) => Math.round((hist.slice(a, b).reduce((x, y) => x + (Number(y) || 0), 0) / sum) * 100);   // bins are 5 km/h wide
        return {
            line: `${U.num(t.km, 0)} km on ${U.num(t.litres, 2)} L`,
            bands: `${band(0, 8)} % under 40 km/h · ${band(8, 12)} % at 40–60 · ${band(12, 16)} % at 60–80 · ${band(16, 40)} % over 80`,
            idle: `${Math.round((Number(t.idleH) || 0) * 60)} min idling · ${t.massKg} kg on the bike · ${t.fuelCode}`
        };
    }

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
            else if (k === "html") el.innerHTML = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c !== null && c !== false && c !== undefined) el.append(c);
        return el;
    }
    const item = (icon, cls, text, sub) => h("li", { class: cls }, [h("span", { class: "cst-li-i", "aria-hidden": "true", html: icon }), h("span", {}, [text, sub ? h("small", { text: sub }) : null])]);

    /**
     * @param {HTMLElement} root  the modal's mount
     * @param {{ units: any, getStatus: () => any, getPreview: () => Promise<any>, bikeName: () => string,
     *   onYes: () => Promise<any>, onNo: () => void, onStop: () => Promise<{ ok: boolean, deleted: number|null, pending: boolean }>, onClose: () => void }} deps
     */
    function createConsentDialog(root, deps) {
        const U = deps.units;
        root.classList.add("cst");
        let busy = false;

        async function open() {
            const st = deps.getStatus();
            if (st.optedIn) return renderManage(st);
            return renderAsk();
        }

        async function renderAsk() {
            const preview = await deps.getPreview().catch(() => null);
            const tanks = preview && preview.body ? preview.body.tanks : [];
            const ex = tanks.length ? tankInWords(tanks[tanks.length - 1], U) : null;
            const bike = deps.bikeName();
            const status = h("p", { class: "cst-status", role: "status", "aria-live": "polite" });
            const yes = h("button", { type: "button", class: "cst-btn cst-yes", text: "Share anonymously", onclick: async () => {
                if (busy) return; busy = true; yes.disabled = true; no.disabled = true; status.textContent = "Turning it on…";
                try { const r = await deps.onYes(); status.textContent = r && r.sent ? `Thanks! ${r.sent} tank${r.sent === 1 ? "" : "s"} shared.` : r && r.queued ? "Thanks! Your tanks will be sent when you're online." : "Thanks! Tanks are shared as you log them."; setTimeout(() => deps.onClose(), 1400); }
                catch { status.textContent = "Couldn't turn it on. Try again later."; yes.disabled = false; no.disabled = false; } finally { busy = false; }
            } });
            const no = h("button", { type: "button", class: "cst-btn cst-no", text: "Not now", onclick: () => { deps.onNo(); deps.onClose(); } });
            root.replaceChildren(
                h("button", { type: "button", class: "cst-x", "aria-label": "Close", html: ICON.x, onclick: () => { deps.onNo(); deps.onClose(); } }),
                h("div", { class: "cst-hero" }, [h("span", { class: "cst-hero-i", "aria-hidden": "true", html: ICON.shield }), h("h2", { id: "cst-title", class: "cst-title", text: "Help riders get better fuel estimates" })]),
                h("p", { class: "cst-lead", text: `Share your fill-up results anonymously. Together they teach MapUnite how ${bike || "your bike"} really does on Indian roads, for you and everyone who rides one.` }),
                h("div", { class: "cst-cols" }, [
                    h("section", { class: "cst-col is-yes", "aria-labelledby": "cst-yes-h" }, [h("h3", { id: "cst-yes-h", text: "What's shared" }), h("ul", {}, [
                        item(ICON.check, "", "Your bike model", bike || undefined),
                        item(ICON.check, "", "Each full tank: distance and litres"),
                        item(ICON.check, "", "How far you rode in each 5 km/h speed range"),
                        item(ICON.check, "", "Idling time, the fuel grade, and the weight on the bike (rounded to 5 kg)")
                    ])]),
                    h("section", { class: "cst-col is-no", "aria-labelledby": "cst-no-h" }, [h("h3", { id: "cst-no-h", text: "Never shared" }), h("ul", {}, [
                        item(ICON.no, "", "Where you ride, routes or GPS"),
                        item(ICON.no, "", "Dates or times of day: not even the month"),
                        item(ICON.no, "", "Your name, number, account or friends"),
                        item(ICON.no, "", "Prices you pay"),
                        item(ICON.no, "", "Anything about your rides beyond the tanks")
                    ])])
                ]),
                ex ? h("figure", { class: "cst-example" }, [h("figcaption", { text: "Your latest tank, as it would be sent" }), h("strong", { text: ex.line }), h("span", { text: ex.bands }), h("span", { text: ex.idle })]) : h("p", { class: "cst-example is-empty", text: "Nothing to share yet: tanks count once you've logged two full fill-ups (with the odometer) and rides in between." }),
                h("details", { class: "cst-json" }, [h("summary", { text: "See exactly what's sent" }), h("pre", { tabindex: "0", text: preview ? `${preview.request}${preview.authorization ? `\nAuthorization: ${preview.authorization}` : ""}\n\n${JSON.stringify(preview.body, null, 2)}` : "(nothing yet)" })]),
                h("p", { class: "cst-fine", text: "Sent to the MapUnite server with a random ID made on this phone, which the server keeps only as a keyed hash, not linked to your account. A bike's numbers change only after at least 5 riders' tanks agree, and only after a person reviews the change. Turn it off any time in Ride summaries: that deletes everything you've shared. Kept for up to 24 months. (FLEET.md)" }),
                h("div", { class: "cst-actions" }, [no, yes]),
                status
            );
            root.setAttribute("aria-labelledby", "cst-title");
            no.focus({ preventScroll: true });                     // focus the safe choice, but open at the title
            const card = root.closest(".modal-card"); if (card) card.scrollTop = 0;
        }

        function renderManage(st) {
            const status = h("p", { class: "cst-status", role: "status", "aria-live": "polite" });
            const stop = h("button", { type: "button", class: "cst-btn cst-stop", onclick: async () => {
                if (busy) return; busy = true; stop.disabled = true; status.textContent = "Deleting what you shared…";
                try {
                    const r = await deps.onStop();
                    status.textContent = r.pending ? "Sharing is off. The delete will finish next time you're online." : `Sharing is off. ${r.deleted !== null ? `${r.deleted} tank${r.deleted === 1 ? "" : "s"} deleted from the server.` : "What you shared was deleted."}`;
                    setTimeout(() => deps.onClose(), 1800);
                } catch { status.textContent = "Couldn't reach the server. Try again."; stop.disabled = false; } finally { busy = false; }
            } }, [h("span", { class: "cst-li-i", "aria-hidden": "true", html: ICON.trash }), "Stop sharing and delete"]);
            const since = st.since ? new Date(st.since).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "";
            root.replaceChildren(
                h("button", { type: "button", class: "cst-x", "aria-label": "Close", html: ICON.x, onclick: () => deps.onClose() }),
                h("div", { class: "cst-hero" }, [h("span", { class: "cst-hero-i is-on", "aria-hidden": "true", html: ICON.shield }), h("h2", { id: "cst-title", class: "cst-title", text: "You're sharing anonymous fuel data" })]),
                h("ul", { class: "cst-facts" }, [
                    h("li", {}, [h("strong", { text: String(st.sentTotal || 0) }), ` tank${st.sentTotal === 1 ? "" : "s"} shared since ${since}`]),
                    st.queued ? h("li", {}, [h("strong", { text: String(st.queued) }), " waiting to send"]) : null,
                    st.lastError ? h("li", { class: "is-warn", text: `Last try: ${st.lastError}` }) : null
                ]),
                h("p", { class: "cst-lead", text: "Only full-tank results and the month are sent, under a random ID that isn't linked to your account. No routes, places, dates or prices." }),
                h("div", { class: "cst-actions" }, [h("button", { type: "button", class: "cst-btn cst-no", text: "Keep sharing", onclick: () => deps.onClose() }), stop]),
                status
            );
            root.setAttribute("aria-labelledby", "cst-title");
        }

        return { open, close: () => deps.onClose() };
    }

    /**
     * @param {HTMLElement} root
     * @param {{ getCounts: () => Promise<{ rides: number, fills: number, shared: boolean, sharedTanks: number, pendingDelete: boolean }>,
     *   onWipe: (what: { rides: boolean, fills: boolean, shared: boolean, caches: boolean }) => Promise<Array<{ label: string, ok: boolean, note?: string }>>,
     *   onServerHistory?: () => void, onClose: () => void }} deps
     */
    function createWipeDialog(root, deps) {
        root.classList.add("cst", "wipe");
        let counts = null;
        async function open() {
            counts = await deps.getCounts();
            const boxes = [];
            const box = (key, label, sub, on = true) => {
                const input = h("input", { type: "checkbox", class: "wipe-cb", checked: on, "data-k": key, onchange: () => sync() });
                boxes.push(input);
                return h("label", { class: "wipe-item" }, [input, h("span", {}, [h("strong", { text: label }), sub ? h("small", { text: sub }) : null])]);
            };
            const serverBox = h("input", { type: "checkbox", class: "wipe-cb", "data-k": "server" });
            const go = h("button", { type: "button", class: "cst-btn cst-stop", text: "Delete selected…", onclick: () => confirmStep() });
            function sync() { go.disabled = ![...boxes, serverBox].some((b) => /** @type {HTMLInputElement} */ (b).checked); }
            root.replaceChildren(
                h("button", { type: "button", class: "cst-x", "aria-label": "Close", html: ICON.x, onclick: () => deps.onClose() }),
                h("div", { class: "cst-hero" }, [h("span", { class: "cst-hero-i is-danger", "aria-hidden": "true", html: ICON.trash }), h("h2", { id: "wipe-title", class: "cst-title", text: "Delete my history" })]),
                h("p", { class: "cst-lead", text: "Choose what to erase from this phone and the server. This can't be undone." }),
                h("div", { class: "wipe-list" }, [
                    box("rides", "Ride summaries", `${counts.rides} ride${counts.rides === 1 ? "" : "s"} on this phone`),
                    box("fills", "Fill-up log and learned fuel curve", `${counts.fills} fill-up${counts.fills === 1 ? "" : "s"}. Trip fuel goes back to the generic curve.`),
                    counts.shared || counts.pendingDelete ? box("shared", "Anonymous fuel data on the MapUnite server", counts.shared ? `${counts.sharedTanks} tank${counts.sharedTanks === 1 ? "" : "s"} shared · sharing turns off` : "A delete is still pending") : null,
                    box("caches", "Route data saved for offline use", "Terrain heights, bridges and fuel stations along routes you looked at"),
                    deps.onServerHistory ? h("label", { class: "wipe-item is-next" }, [serverBox, h("span", {}, [h("strong", { text: "Also my trips, breadcrumbs, memories and chat on the server" }), h("small", { text: "Opens the server delete next, with its own confirmation" })])]) : null
                ]),
                h("div", { class: "cst-actions" }, [h("button", { type: "button", class: "cst-btn cst-no", text: "Cancel", onclick: () => deps.onClose() }), go])
            );
            root.setAttribute("aria-labelledby", "wipe-title");
            sync();

            function confirmStep() {
                const what = { rides: false, fills: false, shared: false, caches: false };
                for (const b of boxes) /** @type {any} */ (what)[/** @type {string} */ (b.getAttribute("data-k"))] = /** @type {HTMLInputElement} */ (b).checked;
                const server = /** @type {HTMLInputElement} */ (serverBox).checked;
                const n = Object.values(what).filter(Boolean).length + (server ? 1 : 0);
                const actions = root.querySelector(".cst-actions");
                if (!actions) return;
                const yes = h("button", { type: "button", class: "cst-btn cst-stop", text: "Delete for good", onclick: async () => {
                    yes.disabled = true; back.disabled = true; yes.textContent = "Deleting…";
                    const results = await deps.onWipe(what);
                    root.replaceChildren(
                        h("div", { class: "cst-hero" }, [h("span", { class: "cst-hero-i", "aria-hidden": "true", html: ICON.check }), h("h2", { id: "wipe-title", class: "cst-title", text: "Done" })]),
                        h("ul", { class: "wipe-done", role: "status" }, results.map((r) => item(r.ok ? ICON.check : ICON.no, r.ok ? "is-ok" : "is-warn", r.label, r.note))),
                        h("div", { class: "cst-actions" }, [h("button", { type: "button", class: "cst-btn cst-yes", text: "Close", onclick: () => { deps.onClose(); if (server && deps.onServerHistory) deps.onServerHistory(); } })])
                    );
                    const c = root.querySelector(".cst-yes"); if (c) /** @type {HTMLElement} */ (c).focus();
                } });
                const back = h("button", { type: "button", class: "cst-btn cst-no", text: "Back", onclick: () => open() });
                actions.replaceChildren(h("p", { class: "wipe-confirm", role: "alert", text: `Delete ${n} item${n === 1 ? "" : "s"} for good?` }), back, yes);
                yes.focus();
            }
        }
        return { open, close: () => deps.onClose() };
    }

    return { tankInWords, createConsentDialog, createWipeDialog };
});
