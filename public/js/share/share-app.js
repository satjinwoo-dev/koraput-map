// @ts-check
/* ============================================================================
   MapUnite share — wiring the post-ride share card into the map app
   ==============================================================================
   - "mu:ride-summary" (from the HUD when a drive ends, with SmartDrive's trip
     and the live physics totals) → after the trip summary appears, the share
     sheet (#share-modal) pops up for rides of 1 km or more, unless the rider
     turned "Show this after every ride" off.
   - "Share ride" (#share-ride-btn) in the trip summary opens it any time.
   - "Saved vs my usual" uses the fuel learner's usable full tanks (real litres
     pumped); no tanks, no savings claim.
   Card scripts and stylesheet load on first use (precached by sw.js).
   ============================================================================ */
(function (root) {
    "use strict";
    const W = /** @type {any} */ (root);
    if (!W.document) return;
    const $ = (id) => document.getElementById(id);
    const FILES = { js: ["js/share/card-model.js", "js/share/card-render.js", "js/share/share-ui.js"], css: "js/share/share.css" };
    let loading = null, sheet = null, last = null;

    function load() {
        if (!loading) {
            if (!document.querySelector(`link[data-mu-href="${FILES.css}"]`)) {
                const l = document.createElement("link"); l.rel = "stylesheet"; l.href = FILES.css; l.dataset.muHref = FILES.css; document.head.append(l);
            }
            loading = FILES.js.reduce((p, src) => p.then(() => new Promise((resolve, reject) => {
                if (document.querySelector(`script[data-mu-src="${src}"]`)) return resolve(undefined);
                const s = document.createElement("script"); s.src = src; s.async = false; s.dataset.muSrc = src;
                s.onload = () => resolve(undefined); s.onerror = () => reject(new Error(`Couldn't load ${src}`));
                document.head.append(s);
            })), Promise.resolve()).catch((e) => { loading = null; throw e; });
        }
        return loading;
    }

    function usual() {
        /** @type {any} */ let FC = null;
        // @ts-ignore — js/smartdrive.js
        try { FC = typeof FuelCurve !== "undefined" ? FuelCurve : null; } catch { FC = null; }
        return W.MUShare && W.MUShare.model ? W.MUShare.model.usualFromLearner(FC) : null;
    }

    async function open(summary) {
        const s = summary || last;
        if (!s) return;
        const host = $("share-modal"), mount = $("share-mount");
        if (!host || !mount) return;
        await load();
        if (!sheet) sheet = W.MUShare.ui.createShareSheet(mount, {
            model: W.MUShare.model, render: W.MUShare.render, units: W.MUGarage.units,
            fonts: document.fonts, onClose: () => { host.style.display = "none"; host.setAttribute("aria-hidden", "true"); }
        });
        host.style.display = "flex"; host.setAttribute("aria-hidden", "false");
        sheet.open({ ...s, usual: s.powertrain === "ev" ? null : usual() });
    }

    function onSummary(e) {
        const s = /** @type {CustomEvent} */ (e).detail;
        if (!s) return;
        last = s;
        const km = s.live && s.live.distance ? s.live.distance / 1000 : Number(s.trip && s.trip.totalDistKm) || 0;
        const btn = $("share-ride-btn"); if (btn) btn.hidden = km < 0.2;
        let auto = true;
        try { const p = JSON.parse(localStorage.getItem("mu.share.v1") || "{}"); if (p && p.auto === false) auto = false; } catch { /* default */ }
        if (auto && km >= 1) setTimeout(() => open(s), 900);
    }

    function init() {
        document.addEventListener("mu:ride-summary", onSummary);
        const btn = $("share-ride-btn"); if (btn) btn.addEventListener("click", () => open(null));
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
    W.MUShare = W.MUShare || {};
    W.MUShare.app = { open, get last() { return last; } };
})(typeof globalThis !== "undefined" ? globalThis : this);
