// @ts-check
/* ============================================================================
   MapUnite garage — boot for the standalone page (garage.html)
   ==============================================================================
   Was an inline <script>; moved to a file so the page passes the app's CSP
   (script-src has no 'unsafe-inline'). Same behaviour as before.

   The Step 5 API server (/api/bikes/search, /bundles, /requests) comes from
   MUGarage.store.resolveApiBase: on the website this page's origin; in the
   Android app window.MU_GARAGE_API, which scripts/build-native.mjs sets to
   MU_SERVER_ORIGIN; never the app's own origin (https://localhost, capacitor:).
   ============================================================================ */
(function () {
    "use strict";
    const W = /** @type {any} */ (window);
    const store = W.MUGarage.store.createStore({
        search: W.BikeCatalogSearch,
        physics: W.MUPhysics,
        catalogUrl: "bikedb/catalog.json",
        staticBase: "bikedb/",
        apiBase: W.MUGarage.store.resolveApiBase(W, location)
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
