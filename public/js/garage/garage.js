// @ts-check
/* ============================================================================
   MapUnite garage — "My bike": picker + rider settings + physics visualizer
   ==============================================================================
   MUGarage.mount(root, { store, physics }) renders the whole feature into
   `root`: the picker when no bike is saved, otherwise the bike, its settings and
   the physics visualizer. Everything after the first catalogue download works
   offline, and the rider's choices stay on the phone.

   Load order (plain scripts, no bundler):
     js/bikedb/catalog-search.js, js/physics/{atmosphere,tyre,powertrain,roadload,model,cruise,index}.js,
     js/garage/{units,store,silhouettes,picker,settings,visualizer,garage}.js
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory;
    else { const ns = /** @type {any} */ (root).MUGarage || (/** @type {any} */ (root).MUGarage = {}); Object.assign(ns, factory(ns)); }
})(typeof globalThis !== "undefined" ? globalThis : this, function (/** @type {any} */ G) {
    "use strict";

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
            else if (k === "html") el.innerHTML = v;                 // static, trusted markup only
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? "" : String(v));
        }
        for (const c of kids) if (c !== null && c !== false) el.append(c);
        return el;
    }
    const WARN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18h.01"/></svg>`;
    /** Settings that belong to the rider, not the bike: kept when the bike changes. */
    const PERSONAL = ["riderMass", "pillionMass", "luggageMass"];
    const sentence = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/\s*:\s*/g, ": ") + (/[.!?]$/.test(t) ? "" : ".") : t);

    /**
     * @param {HTMLElement} root
     * @param {{ store: any, physics: any, env?: any, title?: string, onChange?: (g: any) => void }} o
     *   onChange: called after the rider's bike or settings are saved (SmartDrive re-reads its fuel baseline)
     */
    function mount(root, o) {
        const { store, physics } = o;
        root.classList.add("mu-garage");
        const head = h("header", { class: "mu-garage-head" }, [h("h2", { class: "mu-garage-title", text: o.title || "My bike" })]);
        const net = h("p", { class: "mu-net", role: "status", "aria-live": "polite" });
        const body = h("div", { class: "mu-garage-body" });
        root.replaceChildren(head, net, body);
        let index = null, viz = null;
        const onOnline = () => { sendRequests(); net.textContent = ""; };
        if (typeof window !== "undefined") window.addEventListener("online", onOnline);

        async function start() {
            body.replaceChildren(h("p", { class: "mu-loading", text: "Loading the bike list…" }));
            try {
                const cat = await store.catalog();
                index = cat.index;
                net.textContent = cat.source === "cache" ? "Offline: using the bike list saved on this phone." : "";
            } catch (e) {
                body.replaceChildren(h("div", { class: "mu-empty-state" }, [
                    h("p", { text: /** @type {Error} */ (e).message }),
                    h("button", { type: "button", class: "mu-btn", text: "Try again", onclick: start })
                ]));
                return;
            }
            sendRequests();
            const g = store.refreshGarage(index);
            if (g) showBike(g); else showPicker(null);
        }

        function showPicker(prev) {
            if (viz) { viz.destroy(); viz = null; }
            const box = h("section", { class: "mu-garage-picker", "aria-label": "Choose your bike" });
            body.replaceChildren(box);
            G.picker.createPicker(box, {
                index, silhouettes: G.silhouettes, units: G.units, offline: net.textContent !== "",
                search: store.apiBase ? store.search : undefined,                 // GET /api/bikes/search
                onPick: (p) => pick(p, prev),
                onRequest: (r) => { store.requestBike(r); sendRequests(); }    // throws a message the picker shows
            }).focus();
        }
        /** Save a pick (keeping the rider's own settings) and show it. @param {any} p @param {any} prev */
        function pick(p, prev) {
            const keep = {};
            if (prev && prev.settings) for (const k of PERSONAL) if (prev.settings[k] !== undefined) keep[k] = prev.settings[k];
            showBike(saved(store.saveGarage(store.garageFromPick(index, { ...p, settings: keep }))));
        }
        /** Tell the host page (index.html's sheet) the garage changed. @param {any} g */
        function saved(g) {
            if (o.onChange) { try { o.onChange(g); } catch (e) { /* the host's problem, not the garage's */ } }
            return g;
        }
        /** POST queued requests; if the server already lists a requested bike, offer it. */
        function sendRequests() {
            store.flushRequests().then(renderListed).catch(() => { });
        }
        const listedBox = h("div", { class: "mu-listed-box", "aria-live": "polite" });
        function renderListed() {
            const offers = store.listed();
            listedBox.replaceChildren(...offers.map((o2) => {
                const m = o2.matches[0];
                return h("div", { class: "mu-listed", role: "status" }, [
                    h("p", { text: `Good news: “${m.title}” is already in the bike list.` }),
                    h("div", { class: "mu-actions" }, [
                        h("button", { type: "button", class: "mu-btn", text: "Use it", onclick: () => { store.dismissListed(o2.request.id); renderListed(); pick({ bikeId: m.id, year: o2.request.year }, store.garage()); } }),
                        h("button", { type: "button", class: "mu-btn-ghost", text: "Not my bike", onclick: () => { store.dismissListed(o2.request.id); renderListed(); } })
                    ])
                ]);
            }));
        }

        async function showBike(g) {
            body.replaceChildren(h("p", { class: "mu-loading", text: "Loading your bike…" }));
            let bundle, classDefault;
            try {
                bundle = await store.bundle(g.bundle);
                if (bundle.kind === "variant") {
                    const cls = index.classes.find((c) => c.key === bundle.classKey);
                    classDefault = cls ? await store.bundle(cls.bundle).catch(() => undefined) : undefined;
                }
            } catch (e) {
                body.replaceChildren(h("div", { class: "mu-empty-state" }, [
                    h("p", { text: /** @type {Error} */ (e).message }),
                    h("div", { class: "mu-actions" }, [
                        h("button", { type: "button", class: "mu-btn", text: "Try again", onclick: () => showBike(g) }),
                        h("button", { type: "button", class: "mu-btn-ghost", text: "Choose another bike", onclick: () => showPicker(g) })
                    ])
                ]));
                return;
            }
            const row = g.bikeId ? store.row(index, g.bikeId) : null;     // the phone's list, or a newer bike the server returned
            const cls = index.classes.find((c) => c.key === g.classKey);
            const thumbSrc = row || { classKey: g.classKey, image_url: cls ? cls.image_url : null };

            // ---- bike card ----
            const thumb = h("span", { class: "mu-thumb mu-thumb-xl", "aria-hidden": "true", html: G.silhouettes.silhouette(g.classKey) });
            if (thumbSrc.image_url) {
                const img = h("img", { src: thumbSrc.image_url, alt: "", decoding: "async", referrerpolicy: "no-referrer" });
                img.addEventListener("load", () => thumb.classList.add("has-photo"));
                img.addEventListener("error", () => img.remove());
                thumb.append(img);
            }
            const name = row ? `${row.make} ${row.model}` : g.bikeId ? g.title : `Typical ${cls ? cls.title : "bike"}`;
            const card = h("section", { class: "mu-bike-card", "aria-label": "Your bike" }, [
                thumb,
                h("div", { class: "mu-bike-id" }, [
                    h("p", { class: "mu-bike-name", text: name }),
                    row && row.variant ? h("p", { class: "mu-bike-variant", text: row.variant }) : null,
                    h("p", { class: "mu-bike-facts" }, [
                        row ? h("span", { text: G.units.size(row) }) : null,
                        g.year ? h("span", { text: String(g.year) }) : null,
                        g.estimated ? h("span", { class: "mu-badge-warn" }, [h("span", { class: "mu-icon", "aria-hidden": "true", html: WARN_ICON }), "Estimated"]) : null
                    ])
                ]),
                h("button", { type: "button", class: "mu-btn-ghost mu-change", text: "Change bike", onclick: () => showPicker(store.garage()) })
            ]);
            const estimates = h("details", { class: "mu-estimates", hidden: true });
            const settingsBox = h("section", { class: "mu-garage-settings", "aria-label": "Rider settings" });
            const vizBox = h("section", { class: "mu-garage-viz", "aria-label": "Fuel and speed" });
            // phone: bike, chart, settings; wide screens: bike and settings on the left, chart on the right
            body.replaceChildren(listedBox, h("div", { class: "mu-garage-grid" }, [
                h("div", { class: "mu-area-bike" }, [card, estimates]),
                h("div", { class: "mu-area-viz" }, [vizBox]),
                h("div", { class: "mu-area-settings" }, [settingsBox])
            ]));

            // ---- visualizer ----
            if (viz) viz.destroy();
            try {
                viz = G.visualizer.createVisualizer(vizBox, { physics, bundle, classDefault, settings: g.settings, env: o.env, estimated: g.estimated });
            } catch (e) {
                vizBox.replaceChildren(h("p", { class: "mu-empty-state", text: `The physics couldn't run for this bike: ${/** @type {Error} */ (e).message}` }));
            }
            const renderEstimates = () => {
                const flags = viz ? viz.model.flags : [];
                const lines = [...(g.estimated ? ["Every number comes from a typical bike of this type, not your exact model."] : []), ...flags.map(sentence)];
                estimates.hidden = lines.length === 0;
                estimates.replaceChildren(
                    h("summary", {}, [h("span", { class: "mu-icon", "aria-hidden": "true", html: WARN_ICON }), "Some numbers are estimated"]),
                    h("ul", {}, lines.map((t) => h("li", { text: t })))
                );
            };
            renderEstimates();

            // ---- settings ----
            G.settings.createSettings(settingsBox, {
                bundle, settings: g.settings, physics,
                onChange: (st) => {
                    g = saved(store.saveGarage({ ...g, settings: st }));
                    if (viz) { try { viz.update({ settings: st }); renderEstimates(); } catch (e) { /* invalid combination: keep the last chart */ } }
                }
            });
        }

        start();
        return {
            reload: start,
            destroy() { if (viz) viz.destroy(); if (typeof window !== "undefined") window.removeEventListener("online", onOnline); root.replaceChildren(); }
        };
    }

    return { mount };
});
