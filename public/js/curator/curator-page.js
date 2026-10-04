// @ts-check
/* MapUnite curator — boot for /admin/curator.html (a file, not inline: the CSP has no 'unsafe-inline'). */
(function () {
    "use strict";
    const W = /** @type {any} */ (window);
    const getJson = async (url) => { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); };
    W.MU_CURATOR = W.MUCurator.app.mount(/** @type {HTMLElement} */ (document.getElementById("curator-root")), {
        contract: W.BikeContract, search: W.BikeCatalogSearch, physics: W.MUPhysics, units: W.MUGarage.units, silhouettes: W.MUGarage.silhouettes,
        draftLib: W.MUCurator.draft, apiLib: W.MUCurator.api,
        catalog: () => getJson("/bikedb/catalog.json"),
        loadBundle: (hash) => getJson(`/bikedb/bundles/${hash}.json`),
        apiBase: typeof W.MU_CURATOR_API === "string" ? W.MU_CURATOR_API : location.origin
    });
})();
