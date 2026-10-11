// @ts-check
/* ============================================================================
   MapUnite garage — bike picker
   ==============================================================================
   Type-ahead search over the offline catalogue (BikeCatalogSearch.CatalogIndex):
   instant, works in airplane mode, and matches what the server would. Then a
   year, if the bike was sold over several. Bikes that aren't listed get a
   typical bike of their class (marked "estimated") and an optional request to
   add them.

   Accessible combobox: label, listbox, aria-activedescendant, arrow keys,
   Enter, Escape. All catalogue text goes in via textContent.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUGarage || (/** @type {any} */ (root).MUGarage = {}); ns.picker = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const GROUPS = [
        { label: "Motorcycles", keys: ["ice_manual.commuter", "ice_manual.naked", "ice_manual.sport", "ice_manual.adventure", "ice_manual.cruiser"] },
        { label: "Scooters", keys: ["ice_cvt.scooter", "ice_cvt.maxi_scooter"] },
        { label: "Electric", keys: ["ev.scooter", "ev.commuter", "ev.sport"] }
    ];

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
            else if (k === "html") el.innerHTML = v;                 // static, trusted markup only (silhouettes)
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c !== null && c !== false) el.append(c);
        return el;
    }

    /** Thumbnail: the bike's picture if it has one (falls back on error), else its class silhouette. */
    function thumb(row, sil, cls = "mu-thumb") {
        const box = h("span", { class: cls, "aria-hidden": "true", html: sil.silhouette(row.classKey || row.key) });
        if (row.image_url) {
            const img = h("img", { src: row.image_url, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
            img.addEventListener("load", () => { box.classList.add("has-photo"); });
            img.addEventListener("error", () => img.remove());
            box.append(img);
        }
        return box;
    }

    /**
     * @param {HTMLElement} root
     * @param {{ index: any, silhouettes: any, units: any, onPick: (p: { bikeId?: string, classKey?: string, year: number|null }) => void,
     *           onRequest?: (description: string, classKey: string|null) => void, initialQuery?: string, offline?: boolean }} o
     */
    function createPicker(root, o) {
        const { index, silhouettes: sil, units: U } = o;
        const uid = `pk${Math.random().toString(36).slice(2, 8)}`;
        let results = [], active = -1, chosen = null;
        root.classList.add("mu-picker");
        root.replaceChildren();

        // ---------- search ----------
        const input = h("input", {
            id: `${uid}-q`, class: "mu-search-input", type: "search", inputmode: "search", autocomplete: "off", spellcheck: "false",
            role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": `${uid}-list`,
            placeholder: "Hunter 350, Activa, NS200…", enterkeyhint: "search"
        });
        const list = h("ul", { id: `${uid}-list`, class: "mu-results", role: "listbox", "aria-label": "Bikes" });
        const status = h("p", { class: "mu-picker-status", role: "status", "aria-live": "polite" });
        const makes = h("div", { class: "mu-makes", role: "group", "aria-label": "Browse by make" });
        const searchView = h("div", { class: "mu-picker-search" }, [
            h("label", { class: "mu-label", for: `${uid}-q`, text: "Find your bike" }),
            h("div", { class: "mu-search-box" }, [h("span", { class: "mu-search-icon", "aria-hidden": "true", html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>` }), input]),
            status, makes, list,
            h("button", { type: "button", class: "mu-link", text: "My bike isn't listed", onclick: () => show(classView) })
        ]);

        // makes, for browsing without typing
        const makeNames = [...new Set(index.rows.map((r) => r.make))].sort();
        for (const mk of makeNames) makes.append(h("button", { type: "button", class: "mu-chip", text: mk, onclick: () => { input.value = mk; run(); input.focus(); } }));

        // ---------- year ----------
        const yearView = h("div", { class: "mu-picker-year", hidden: true });

        // ---------- not listed: pick a class ----------
        const classView = h("div", { class: "mu-picker-classes", hidden: true });
        const reqInput = h("input", { id: `${uid}-req`, class: "mu-text-input", type: "text", maxlength: "200", placeholder: "e.g. Bajaj Avenger 220 Street, 2023" });
        let reqClass = null;
        classView.append(
            h("button", { type: "button", class: "mu-back", text: "Back to search", onclick: () => show(searchView) }),
            h("h3", { class: "mu-picker-title", text: "Choose the closest type" }),
            h("p", { class: "mu-hint", text: "We'll use a typical bike of that type. Its numbers are estimates, and they get better as the app learns your riding." })
        );
        for (const g of GROUPS) {
            const classes = g.keys.map((k) => index.classes.find((c) => c.key === k)).filter(Boolean);
            if (!classes.length) continue;
            const grid = h("div", { class: "mu-class-grid" });
            for (const c of classes) {
                grid.append(h("button", { type: "button", class: "mu-class-btn", "data-class": c.key, onclick: () => { reqClass = c.key; finishClass(c); } }, [
                    thumb(c, sil, "mu-thumb mu-thumb-lg"), h("span", { class: "mu-class-name", text: c.title })
                ]));
            }
            classView.append(h("h4", { class: "mu-group-title", text: g.label }), grid);
        }
        classView.append(h("div", { class: "mu-request" }, [
            h("label", { class: "mu-label", for: `${uid}-req`, text: "Tell us your bike, and we'll add it (optional)" }),
            reqInput
        ]));
        function finishClass(c) {
            const d = reqInput.value.trim();
            if (d && o.onRequest) { try { o.onRequest(d, reqClass); } catch (e) { status.textContent = /** @type {Error} */ (e).message; } }
            o.onPick({ classKey: c.key, year: null });
        }

        root.append(searchView, yearView, classView);

        function show(view) {
            for (const v of [searchView, yearView, classView]) v.hidden = v !== view;
            const f = view.querySelector("input, button");
            if (f) /** @type {HTMLElement} */ (f).focus();
        }

        // ---------- search behaviour ----------
        function run() {
            const q = input.value;
            results = q.trim() ? index.search(q, { limit: 30 }) : [];
            active = results.length ? 0 : -1;
            renderResults(q);
        }
        function renderResults(q) {
            list.replaceChildren();
            makes.hidden = !!q.trim();
            input.setAttribute("aria-expanded", String(results.length > 0));
            if (!q.trim()) { status.textContent = o.offline ? "Offline: searching the bike list saved on this phone." : ""; input.removeAttribute("aria-activedescendant"); return; }
            if (!results.length) {
                status.textContent = "";
                list.append(h("li", { class: "mu-empty", role: "presentation" }, [
                    h("p", { text: `No bike matches “${q.trim()}”.` }),
                    h("button", { type: "button", class: "mu-btn-ghost", text: "Use a typical bike instead", onclick: () => { reqInput.value = q.trim(); show(classView); } })
                ]));
                return;
            }
            status.textContent = `${results.length === 30 ? "30+" : results.length} ${results.length === 1 ? "bike" : "bikes"}`;
            results.forEach((r, i) => {
                const li = h("li", {
                    id: `${uid}-opt-${i}`, role: "option", class: "mu-result", "aria-selected": String(i === active),
                    onclick: () => choose(i), onpointermove: () => setActive(i)
                }, [
                    thumb(r, sil),
                    h("span", { class: "mu-result-main" }, [
                        h("span", { class: "mu-result-title", text: `${r.make} ${r.model}` }),
                        r.variant ? h("span", { class: "mu-result-variant", text: r.variant }) : null
                    ]),
                    h("span", { class: "mu-result-meta" }, [h("span", { text: U.size(r) }), h("span", { text: U.years(r) })])
                ]);
                list.append(li);
            });
            setActive(active);
        }
        function setActive(i) {
            active = i;
            [...list.children].forEach((li, j) => li.setAttribute("aria-selected", String(j === i)));
            if (i >= 0) {
                input.setAttribute("aria-activedescendant", `${uid}-opt-${i}`);
                const el = list.children[i];
                if (el && /** @type {any} */ (el).scrollIntoView) /** @type {any} */ (el).scrollIntoView({ block: "nearest" });
            } else input.removeAttribute("aria-activedescendant");
        }
        function choose(i) {
            const r = results[i];
            if (!r) return;
            chosen = r;
            const last = r.yearTo === null ? new Date().getFullYear() : r.yearTo;
            if (last <= r.yearFrom) { o.onPick({ bikeId: r.id, year: r.yearFrom }); return; }
            yearView.replaceChildren(
                h("button", { type: "button", class: "mu-back", text: "Back to search", onclick: () => show(searchView) }),
                h("div", { class: "mu-chosen" }, [thumb(r, sil, "mu-thumb mu-thumb-lg"), h("span", {}, [h("span", { class: "mu-result-title", text: `${r.make} ${r.model}` }), r.variant ? h("span", { class: "mu-result-variant", text: r.variant }) : null])]),
                h("h3", { class: "mu-picker-title", text: "Which year is yours?" })
            );
            const yrs = h("div", { class: "mu-year-grid", role: "group", "aria-label": "Model year" });
            for (let y = last; y >= r.yearFrom; y--) yrs.append(h("button", { type: "button", class: "mu-chip mu-chip-year", text: String(y), onclick: () => o.onPick({ bikeId: r.id, year: y }) }));
            yearView.append(yrs, h("button", { type: "button", class: "mu-link", text: "Not sure", onclick: () => o.onPick({ bikeId: r.id, year: null }) }));
            show(yearView);
        }

        input.addEventListener("input", run);
        input.addEventListener("keydown", (e) => {
            if (e.key === "ArrowDown") { if (results.length) setActive(Math.min(results.length - 1, active + 1)); e.preventDefault(); }
            else if (e.key === "ArrowUp") { if (results.length) setActive(Math.max(0, active - 1)); e.preventDefault(); }
            else if (e.key === "Enter") { if (active >= 0) { choose(active); e.preventDefault(); } }
            else if (e.key === "Escape") { input.value = ""; run(); }
        });
        if (o.initialQuery) { input.value = o.initialQuery; }
        run();

        return {
            focus: () => input.focus(),
            search: (q) => { input.value = q; run(); },
            get results() { return results; },
            get chosen() { return chosen; }
        };
    }

    return { GROUPS, createPicker };
});
