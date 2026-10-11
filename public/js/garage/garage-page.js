// @ts-check
/* ============================================================================
   MapUnite garage — boot for the standalone page (garage.html)
   ==============================================================================
   Was an inline <script>; moved to a file so the page passes the app's CSP
   (script-src has no 'unsafe-inline'). Same behaviour as before.

   Step 5 endpoints: set window.MU_GARAGE_API = "https://your.server" (or "" for
   same origin) before this file loads. Until then the garage reads the static
   catalogue and bundles built into public/bikedb/.
   ============================================================================ */
(function () {
    "use strict";
    const W = /** @type {any} */ (window);
    const api = typeof W.MU_GARAGE_API === "string" ? W.MU_GARAGE_API : null;
    const store = W.MUGarage.store.createStore({
        search: W.BikeCatalogSearch,
        physics: W.MUPhysics,
        catalogUrl: "bikedb/catalog.json",
        staticBase: "bikedb/",
        apiBase: api === "" ? location.origin : api
    });
    W.MU_GARAGE = W.MUGarage.mount(/** @type {HTMLElement} */ (document.getElementById("garage-root")), { store, physics: W.MUPhysics });

    // "Back to the map": return to the map page already in history (keeps its route on
    // screen via the back-forward cache) rather than loading a fresh copy.
    const back = document.getElementById("garage-back");
    if (back) back.addEventListener("click", (e) => {
        let fromMap = false;
        try { fromMap = !!document.referrer && new URL(document.referrer).origin === location.origin && /\/(index\.html)?$/.test(new URL(document.referrer).pathname); } catch { /* no referrer */ }
        if (fromMap && history.length > 1) { e.preventDefault(); history.back(); }
    });
})();
