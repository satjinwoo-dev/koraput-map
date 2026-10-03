"use strict";

/* ============================================================================
   MapUnite client — js/garage-sheet.js
   ==============================================================================
   "My bike" inside the app: the garage (js/garage/, Step 6) mounted in a sheet
   on index.html instead of a separate page, so opening it never leaves the
   map — the Socket.IO connection, the convoy and location sharing carry on.

   Nothing is loaded at start-up. The garage's code (search, physics, data
   layer, UI) and its stylesheet are loaded the first time they're needed:
     - core(): the data layer only (search + physics + store). SmartDrive's
       BikeFuel uses it to rebuild its fuel baseline when the bike changes.
     - open(): the whole garage UI, mounted into #garage-sheet-root.
   The service worker precaches all of it, so this works offline too.

   The garage's API server is resolved as on garage.html
   (MUGarage.store.resolveApiBase): this page's origin on the website,
   MU_SERVER_ORIGIN in the Android app.

   Classic scripts sharing one global scope (no bundler, no build step).
   ============================================================================ */

const GarageSheet = {
    CORE_SCRIPTS: [
        "js/bikedb/catalog-search.js",
        "js/physics/atmosphere.js", "js/physics/tyre.js", "js/physics/powertrain.js", "js/physics/roadload.js",
        "js/physics/model.js", "js/physics/cruise.js", "js/physics/index.js",
        "js/garage/store.js"
    ],
    UI_SCRIPTS: ["js/garage/units.js", "js/garage/silhouettes.js", "js/garage/picker.js", "js/garage/settings.js", "js/garage/visualizer.js", "js/garage/garage.js"],
    CSS: "js/garage/garage.css",
    _scripts: new Map(),
    _core: null,
    _ui: null,
    _mounted: null,
    _returnTo: null,

    loadScript(src) {
        if (!this._scripts.has(src)) {
            this._scripts.set(src, new Promise((resolve, reject) => {
                const s = document.createElement("script");
                s.src = src;
                s.async = false;                          // keep the dependency order
                s.onload = () => resolve();
                s.onerror = () => { this._scripts.delete(src); reject(new Error(`couldn't load ${src}`)); };
                document.head.appendChild(s);
            }));
        }
        return this._scripts.get(src);
    },
    loadCss(href) {
        if (document.querySelector(`link[data-garage-css]`)) return;
        const l = document.createElement("link");
        l.rel = "stylesheet"; l.href = href; l.setAttribute("data-garage-css", "");
        document.head.appendChild(l);
    },

    /** The garage's data layer: { store, physics } (shared by the sheet and BikeFuel). */
    core() {
        if (!this._core) {
            this._core = Promise.all(this.CORE_SCRIPTS.map((s) => this.loadScript(s))).then(() => {
                const store = window.MUGarage.store.createStore({
                    search: window.BikeCatalogSearch, physics: window.MUPhysics,
                    catalogUrl: "bikedb/catalog.json", staticBase: "bikedb/",
                    apiBase: window.MUGarage.store.resolveApiBase(window, location)
                });
                return { store, physics: window.MUPhysics };
            }).catch((e) => { this._core = null; throw e; });
        }
        return this._core;
    },
    ui() {
        if (!this._ui) {
            this.loadCss(this.CSS);
            this._ui = this.core().then((c) => Promise.all(this.UI_SCRIPTS.map((s) => this.loadScript(s))).then(() => c))
                .catch((e) => { this._ui = null; throw e; });
        }
        return this._ui;
    },

    async open() {
        const modal = $("garage-modal"), root = $("garage-sheet-root");
        if (!modal || !root) return;
        const settings = $("profile-settings-modal");
        this._returnTo = settings && settings.style.display && settings.style.display !== "none" ? "profile-settings-modal" : null;
        if (this._returnTo) safeHide(this._returnTo);
        safeShow("garage-modal", "flex");
        if (this._mounted) return;
        root.innerHTML = "";
        const p = document.createElement("p");
        p.className = "field-hint"; p.textContent = "Loading My bike…";
        root.appendChild(p);
        try {
            const { store, physics } = await this.ui();
            this._mounted = window.MUGarage.mount(root, {
                store, physics, title: "My bike",
                onChange: () => { if (typeof BikeFuel !== "undefined") BikeFuel.sync(); }
            });
        } catch (e) {
            p.textContent = "My bike couldn't load. Check your connection and try again.";
            console.warn("[GarageSheet]", e);
        }
    },

    close() {
        safeHide("garage-modal");
        if (this._returnTo) safeShow(this._returnTo, "flex");
        this._returnTo = null;
        if (typeof BikeFuel !== "undefined") BikeFuel.sync();
    },

    init() {
        const ob = $("garage-open-btn");
        if (ob) ob.addEventListener("click", () => this.open());
        const cb = $("garage-close-btn");
        if (cb) cb.addEventListener("click", () => this.close());
        const root = $("garage-sheet-root");
        // Escape belongs to the garage while you're in it (it clears the search, leaves the chart):
        // don't let the page-wide handler close the sheet from inside a field or the chart.
        if (root) root.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && e.target !== root && e.target.closest("input, select, textarea, [tabindex], [role=combobox], [role=listbox]")) e.stopPropagation();
        });
        const modal = $("garage-modal");
        // closed by the backdrop or Escape (shell.js): still re-read the bike
        if (modal && typeof MutationObserver !== "undefined") {
            new MutationObserver(() => { if (modal.style.display === "none" && typeof BikeFuel !== "undefined") BikeFuel.sync(); })
                .observe(modal, { attributes: true, attributeFilter: ["style"] });
        }
    }
};
