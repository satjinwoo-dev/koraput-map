// @ts-check
/* ============================================================================
   MapUnite insights — wiring the Fuel Learner dashboard into the map app
   ==============================================================================
   Entry point: "See how your bike really does" (#open-fuel-dash-btn) in the
   SmartDrive settings' "My fuel curve" section. Opens #fuel-dash-modal and
   loads the dashboard's scripts and stylesheet on first use (precached by
   sw.js, so it works offline).

   Data:
     - the learner: js/smartdrive.js FuelCurve (a top-level const, so it's read
       by name, not from window) → MUInsights.fuel.snapshotFromLearner()
     - the bike: MUTrip.app.loadBike() (the garage's saved bike + settings)
     - the physics: MUInsights.fuel.physicsCurve(MUPhysics, model)
   Nothing leaves the phone.
   ============================================================================ */
(function (root) {
    "use strict";
    const W = /** @type {any} */ (root);
    if (!W.document) return;
    const $ = (id) => document.getElementById(id);
    const FILES = { js: ["js/insights/fuel-insights.js", "js/insights/fuel-dashboard.js"], css: "js/insights/fuel-dashboard.css" };
    let loading = null, dash = null;

    /** The learner and its helpers, read by name (classic-script globals aren't all on window). */
    function learner() {
        /** @type {any} */ let FC = null; /** @type {any} */ const g = {};
        // @ts-ignore — defined by js/smartdrive.js
        try { FC = typeof FuelCurve !== "undefined" ? FuelCurve : null; } catch { FC = null; }
        // @ts-ignore
        try { if (typeof fuelShape === "function") g.fuelShape = fuelShape; } catch { /* absent */ }
        // @ts-ignore
        try { if (typeof IDLE_L_PER_HOUR !== "undefined") g.IDLE_L_PER_HOUR = IDLE_L_PER_HOUR; } catch { /* absent */ }
        // @ts-ignore
        try { if (typeof FUEL_BANDS !== "undefined") g.FUEL_BANDS = FUEL_BANDS; } catch { /* absent */ }
        return { FC: FC || W.MU_FUEL_LEARNER || null, g };
    }

    function load() {
        if (!loading) {
            if (!document.querySelector(`link[data-mu-href="${FILES.css}"]`)) {
                const l = document.createElement("link");
                l.rel = "stylesheet"; l.href = FILES.css; l.dataset.muHref = FILES.css;
                document.head.append(l);
            }
            loading = FILES.js.reduce((p, src) => p.then(() => new Promise((resolve, reject) => {
                if (document.querySelector(`script[data-mu-src="${src}"]`)) return resolve(undefined);
                const sc = document.createElement("script");
                sc.src = src; sc.async = false; sc.dataset.muSrc = src;
                sc.onload = () => resolve(undefined);
                sc.onerror = () => reject(new Error(`Couldn't load ${src}. Connect once so the app can save it for offline use.`));
                document.head.append(sc);
            })), Promise.resolve()).catch((e) => { loading = null; throw e; });
        }
        return loading;
    }

    async function getData() {
        const I = W.MUInsights.fuel;
        const { FC, g } = learner();
        if (!FC) return { snapshot: null, physics: null, bike: null, reason: "The fuel learner isn't available." };
        if (!FC.fit && typeof FC.refit === "function") FC.refit();
        const snapshot = I.snapshotFromLearner(FC, g);
        let bike = null, physics = null;
        try {
            const b = W.MUTrip && W.MUTrip.app ? await W.MUTrip.app.loadBike() : null;
            if (b) {
                bike = { name: b.name, powertrain: b.bundle.powertrain, estimated: b.estimated };
                if (b.bundle.powertrain !== "ev") {
                    const model = W.MUPhysics.createBikeModel(b.bundle, { classDefault: b.classDefault, settings: b.settings });
                    physics = I.physicsCurve(W.MUPhysics, model);
                }
            }
        } catch (e) { console.warn("[insights] bike unavailable:", e); }
        return { snapshot, physics, bike };
    }

    function closeModal() { const m = $("fuel-dash-modal"); if (m) { m.style.display = "none"; m.setAttribute("aria-hidden", "true"); } }

    async function open() {
        const modal = $("fuel-dash-modal"), mount = $("fuel-dash-mount");
        if (!modal || !mount) return;
        const settings = $("profile-settings-modal");
        if (settings && settings.style.display && settings.style.display !== "none") settings.style.display = "none";
        if (W.MapUnite && W.MapUnite.open) W.MapUnite.open("fuel-dash-modal"); else modal.style.display = "flex";
        modal.setAttribute("aria-hidden", "false");
        if (dash) { dash.refresh(); return; }
        mount.replaceChildren(Object.assign(document.createElement("p"), { className: "fd-loading", textContent: "Loading…" }));
        try {
            await load();
            dash = W.MUInsights.dashboard.createFuelDashboard(mount, {
                units: W.MUGarage.units, insights: W.MUInsights.fuel, getData,
                onLogFill: () => {
                    closeModal();
                    if (W.MapUnite && W.MapUnite.open) W.MapUnite.open("profile-settings-modal");
                    const f = $("fillup-litres");
                    if (f) { f.scrollIntoView({ block: "center", behavior: "smooth" }); setTimeout(() => f.focus(), 300); }
                },
                onChooseBike: W.MUTrip && W.MUTrip.app ? () => { closeModal(); W.MUTrip.app.openGarage(); } : undefined
            });
        } catch (e) {
            mount.replaceChildren(Object.assign(document.createElement("p"), { className: "fd-loading", textContent: /** @type {Error} */ (e).message }));
        }
        const c = $("close-fuel-dash-btn");
        if (c) c.focus();
    }

    function init() {
        const b = $("open-fuel-dash-btn");
        if (b) b.addEventListener("click", open);
        // a bike change in the garage sheet: refresh next time it's shown
        W.addEventListener("storage", (e) => { if (dash && e.key && /^mu[._]/.test(e.key)) dash.refresh(); });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
    W.MUInsights = W.MUInsights || {};
    W.MUInsights.app = { open, getData };
})(typeof globalThis !== "undefined" ? globalThis : this);
