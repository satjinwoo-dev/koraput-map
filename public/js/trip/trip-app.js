// @ts-check
/* ============================================================================
   MapUnite trip — wiring into the map app (index.html)
   ==============================================================================
   Loaded after the app scripts. Owns three things:

   1. The trip-energy card in the route sheet (#nav-bottom-sheet). It listens for
        "mu:route"        { path:[[lat,lng]…], distanceM, durationSec, steps:[{distance,duration}], reason }
        "mu:route-clear"
        "mu:drive-state"  { navigating }      → one-line card while driving
      which js/navigation.js dispatches. Nothing here reaches into navigation.js.

   2. "My bike" inside the map: the garage (js/garage/) mounted in a sheet
      (#garage-modal), so choosing a bike never loses the route on screen. The
      garage UI scripts and stylesheet load on first open (all precached by
      sw.js, so this works offline). Entry points: the tool rail (#garage-btn,
      a real link to garage.html if scripts fail), the SmartDrive settings
      (#open-garage-btn) and the card's "Choose my bike".

   3. The "My bike" summary in SmartDrive settings (#my-bike-section).

   Everything stays on the phone: the bike and settings (mu.garage.v1), the
   trip preferences and prices (mu.trip.v1).
   ============================================================================ */
(function (root) {
    "use strict";
    const W = /** @type {any} */ (root);
    if (!W.document) return;
    const T = W.MUTrip, G = W.MUGarage, P = W.MUPhysics;
    if (!T || !T.card || !T.energy || !T.profile || !G || !G.store || !G.units || !P) {
        console.warn("[trip] missing modules: load catalog-search, physics, garage/units, garage/store, garage/silhouettes and js/trip/* before trip-app.js");
        return;
    }
    const $ = (id) => document.getElementById(id);
    const GARAGE_UI = ["js/garage/picker.js", "js/garage/settings.js", "js/garage/visualizer.js", "js/garage/garage.js"];
    const GARAGE_CSS = "js/garage/garage.css";

    // ---------------------------------------------------------------- store (same config as garage.html)
    const api = typeof W.MU_GARAGE_API === "string" ? W.MU_GARAGE_API : null;
    const store = G.store.createStore({
        search: W.BikeCatalogSearch, physics: P,
        catalogUrl: "bikedb/catalog.json", staticBase: "bikedb/",
        apiBase: api === "" ? location.origin : api
    });
    const elevation = T.elevation ? T.elevation.createElevation() : null;

    /** The saved bike, ready for the physics (null when none is chosen). */
    async function loadBike() {
        if (!store.garage()) return null;
        const { index } = await store.catalog();
        const g = store.refreshGarage(index);
        if (!g) return null;
        const bundle = await store.bundle(g.bundle);
        const cls = index.classes.find((c) => c.key === g.classKey);
        let classDefault;
        if (bundle.kind === "variant") {
            const dc = index.classes.find((c) => c.key === bundle.classKey);
            if (dc) classDefault = await store.bundle(dc.bundle).catch(() => undefined);
        }
        const row = g.bikeId ? index.get(g.bikeId) : null;
        return {
            name: row ? `${row.make} ${row.model}` : `Typical ${cls ? cls.title : "bike"}`,
            variant: row ? row.variant : "", estimated: !!g.estimated, classKey: g.classKey, classTitle: cls ? cls.title : "bike",
            image_url: row ? row.image_url : (cls ? cls.image_url : null), bundle, classDefault, settings: g.settings || {}
        };
    }

    // ---------------------------------------------------------------- 1. the card
    let card = null;
    function mountCard() {
        if (card) return card;
        const sheet = $("nav-bottom-sheet");
        if (!sheet) return null;
        let el = $("trip-energy");
        if (!el) {
            el = document.createElement("section");
            el.id = "trip-energy";
            const controls = sheet.querySelector(".controls-row");
            sheet.insertBefore(el, controls || null);
        }
        card = T.card.createTripCard(el, {
            physics: P, profile: T.profile, energy: T.energy, units: G.units, silhouettes: G.silhouettes, elevation,
            loadBike, onOpenGarage: () => openGarage()
        });
        return card;
    }
    let pendingRoute = null;
    document.addEventListener("mu:route", (e) => {
        const d = /** @type {CustomEvent} */ (e).detail;
        pendingRoute = d;
        const c = mountCard();
        if (c) c.setRoute(d);
    });
    document.addEventListener("mu:route-clear", () => { pendingRoute = null; if (card) card.clear(); });
    document.addEventListener("mu:drive-state", (e) => { const d = /** @type {CustomEvent} */ (e).detail || {}; if (card) card.setCompact(!!d.navigating); });

    // ---------------------------------------------------------------- 2. the in-app garage
    let garageUi = null, garageMounted = null;
    /** Load a classic script once. @param {string} src */
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector(`script[data-mu-src="${src}"]`)) return resolve(undefined);
            const s = document.createElement("script");
            s.src = src; s.async = false; s.dataset.muSrc = src;
            s.onload = () => resolve(undefined);
            s.onerror = () => reject(new Error(`Couldn't load ${src}. Connect to the internet once so the app can save it for offline use.`));
            document.head.append(s);
        });
    }
    function loadGarageUi() {
        if (!garageUi) {
            if (!document.querySelector(`link[data-mu-href="${GARAGE_CSS}"]`)) {
                const l = document.createElement("link");
                l.rel = "stylesheet"; l.href = GARAGE_CSS; l.dataset.muHref = GARAGE_CSS;
                document.head.append(l);
            }
            garageUi = GARAGE_UI.reduce((p, src) => p.then(() => loadScript(src)), Promise.resolve()).catch((e) => { garageUi = null; throw e; });
        }
        return garageUi;
    }
    async function openGarage() {
        const modal = $("garage-modal"), mountEl = $("garage-mount");
        if (!modal || !mountEl) { location.href = "garage.html"; return; }
        if (W.MapUnite && W.MapUnite.open) W.MapUnite.open("garage-modal"); else modal.style.display = "flex";
        modal.setAttribute("aria-hidden", "false");
        if (garageMounted) { garageMounted.reload(); return; }
        mountEl.replaceChildren(Object.assign(document.createElement("p"), { className: "garage-loading", textContent: "Loading…" }));
        try {
            await loadGarageUi();
            garageMounted = W.MUGarage.mount(mountEl, { store, physics: P });
        } catch (e) {
            mountEl.replaceChildren(Object.assign(document.createElement("p"), { className: "garage-loading", textContent: /** @type {Error} */ (e).message }));
        }
        const close = $("close-garage-btn");
        if (close) close.focus();
    }
    function garageChanged() {
        if (card) card.refreshBike();
        renderMyBike();
    }
    // the sheet's close button / backdrop / Escape just hide it: watch for that
    const gm = $("garage-modal");
    let lastSaved = (store.garage() || {}).savedAt || 0;
    if (gm && typeof MutationObserver === "function") {
        new MutationObserver(() => {
            if (gm.style.display !== "none") return;
            gm.setAttribute("aria-hidden", "true");
            const now = (store.garage() || {}).savedAt || 0;
            if (now !== lastSaved) { lastSaved = now; garageChanged(); }
        }).observe(gm, { attributes: true, attributeFilter: ["style"] });
    }
    // garage.html in another tab
    W.addEventListener("storage", (e) => { if (e.key === G.store.GARAGE_KEY) { lastSaved = (store.garage() || {}).savedAt || 0; garageChanged(); } });
    // coming back from garage.html (bfcache or reload)
    W.addEventListener("pageshow", () => {
        const now = (store.garage() || {}).savedAt || 0;
        if (now !== lastSaved) { lastSaved = now; garageChanged(); }
    });

    function wireEntryPoints() {
        const go = (e) => {
            if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) return;   // new tab: let the link work
            if (e) e.preventDefault();
            const settings = $("profile-settings-modal");
            if (settings && settings.style.display && settings.style.display !== "none") settings.style.display = "none";
            openGarage();
        };
        for (const id of ["garage-btn", "open-garage-btn"]) { const b = $(id); if (b) b.addEventListener("click", go); }
    }

    // ---------------------------------------------------------------- 3. settings summary
    async function renderMyBike() {
        const name = $("my-bike-name"), hint = $("my-bike-hint"), thumb = $("my-bike-thumb");
        if (!name || !hint) return;
        let b = null;
        try { b = await loadBike(); } catch { b = null; }
        if (thumb && G.silhouettes) thumb.innerHTML = G.silhouettes.silhouette(b ? b.classKey : "ice_manual.commuter");
        const btn = $("open-garage-btn");
        if (btn) btn.textContent = store.garage() ? "Change bike" : "Choose bike";
        if (!b) {
            name.textContent = store.garage() ? "Your bike (data not on this phone yet)" : "No bike chosen";
            hint.textContent = "Choose your bike for its fuel curve and the fuel and cost of every route.";
            return;
        }
        name.textContent = b.estimated ? `Typical ${b.classTitle.toLowerCase()} (estimated)` : `${b.name}${b.variant ? ` · ${b.variant}` : ""}`;
        try {
            const model = P.createBikeModel(b.bundle, { classDefault: b.classDefault, settings: b.settings });
            const t = P.cruiseTable(model, {}, { sigma: false });
            const U = G.units;
            if (t.eco) {
                const ev = model.powertrain === "ev";
                const best = ev ? `${U.num(U.whPerKm(t.eco.perMetreBest), 0)} Wh/km` : `${U.smart(U.kmPerLitre(t.eco.perMetreBest))} km/L`;
                hint.textContent = `${ev ? "Longest range" : "Best mileage"} at ${U.num(U.kmh(t.eco.speedLow), 0)}–${U.num(U.kmh(t.eco.speedHigh), 0)} km/h: about ${best} on the flat.`;
            } else hint.textContent = "";
        } catch { hint.textContent = ""; }
    }

    function init() {
        mountCard();
        if (pendingRoute && card) card.setRoute(pendingRoute);
        wireEntryPoints();
        const settings = $("profile-settings-modal");
        if (settings && typeof MutationObserver === "function") {
            new MutationObserver(() => { if (settings.style.display && settings.style.display !== "none") renderMyBike(); })
                .observe(settings, { attributes: true, attributeFilter: ["style"] });
        }
        renderMyBike();
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();

    // roadmap step 9: the gradient (js/gradient/) reuses this terrain lookup, so its cache is shared
    W.MUTrip.app = { store, openGarage, loadBike, get card() { return card; }, get elevation() { return elevation; } };
})(typeof globalThis !== "undefined" ? globalThis : this);
