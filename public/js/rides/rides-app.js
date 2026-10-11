// @ts-check
/* ============================================================================
   MapUnite rides — wiring ride summaries, consent and "Delete my history"
   into the map app (roadmap step 10)
   ==============================================================================
   - Every finished drive becomes a ride summary on this phone (IndexedDB):
       "mu:trip-end"     SmartDrive's totals and route → the record
       "mu:ride-summary" the HUD's physics totals → the same record, richer
   - "Ride summaries" (#open-rides-btn in settings, #rides-all-btn after a ride)
     opens the dashboard (#rides-modal).
   - Anonymous fuel data (FLEET.md): the consent screen (#fleet-consent-modal)
     appears ONCE, right after a fill-up makes the first usable tank, never
     during a ride; "Not now" = not again for 60 days. When opted in, new usable
     tanks are sent after each fill-up and when the app starts online.
   - "Delete my history" (#delete-my-history-btn, and in the dashboard) opens
     #wipe-modal: ride summaries, fill-ups + fuel curve, shared fuel data on the
     server, offline route caches, and optionally the existing server-side
     history delete (#clear-history-btn).
   The dashboard and dialog scripts load on first use (precached by sw.js).
   ============================================================================ */
(function (root) {
    "use strict";
    const W = /** @type {any} */ (root);
    if (!W.document) return;
    const R = W.MURides, F = W.MUFleet;
    if (!R || !R.store || !R.model || !F) { console.warn("[rides] load js/rides/ride-store.js, ride-model.js and fleet.js before rides-app.js"); return; }
    const $ = (id) => document.getElementById(id);
    const FILES = { js: ["js/rides/rides-ui.js", "js/rides/consent-ui.js"], css: "js/rides/rides.css" };
    const OFFLINE_CACHES = ["mu-trip-v1", "mu-gradient-v1", "mu-pitstop-v1"];
    const store = R.store.createRideStore();
    const fleet = F.createFleetClient({ base: typeof W.MU_FLEET_API === "string" ? W.MU_FLEET_API : location.origin, appVersion: "mu-2026-10-04.3" });
    /** @type {Map<string, any>} records seen this session (keeps trip-end / ride-summary merging synchronous) */
    const mem = new Map();
    let loading = null, view = null, consent = null, wipe = null, driving = false;

    // ---------------------------------------------------------------- app globals (guarded)
    function FC() {
        // @ts-ignore — js/smartdrive.js
        try { return typeof FuelCurve !== "undefined" ? FuelCurve : null; } catch { return null; }
    }
    const intervals = () => { const f = FC(); try { return f && typeof f.intervals === "function" ? f.intervals() : []; } catch { return []; } };
    const usable = () => intervals().filter((iv) => iv.usable).length;
    function bike() {
        const st = W.MUTrip && W.MUTrip.app && W.MUTrip.app.store;
        let g = null; try { g = st ? st.garage() : null; } catch { g = null; }
        const classKey = g && g.classKey ? g.classKey : "ice_manual.commuter";
        return { id: g && g.bikeId ? g.bikeId : null, classKey, powertrain: classKey.startsWith("ev") ? "ev" : "ice", name: g && g.title ? g.title : "" };
    }

    // ---------------------------------------------------------------- recording rides
    function onTripEnd(e) {
        const d = /** @type {CustomEvent} */ (e).detail;
        if (!d || !Number.isFinite(d.startedAt)) return;
        const id = `ride-${d.startedAt}`;
        if (mem.has(id)) return;                                  // the HUD's richer summary already arrived
        const rec = R.model.fromTripEnd(d);
        if (rec.distance < 200) return;
        mem.set(id, rec);
        save(rec);
    }
    function onSummary(e) {
        const s = /** @type {CustomEvent} */ (e).detail;
        if (!s || !s.trip || !Number.isFinite(s.trip.startedAt)) return;
        const id = `ride-${s.trip.startedAt}`;
        const rec = R.model.merge(mem.get(id) || R.model.fromTripEnd(s.trip), s);
        if (rec.distance < 200) return;
        mem.set(id, rec);
        save(rec);
    }
    async function save(rec) {
        try { await store.put(rec); } catch { /* storage full or blocked */ }
        const b = $("rides-all-btn"); if (b) b.hidden = false;
        refreshSettings();
        if (view && isOpen("rides-modal")) renderView();
    }

    // ---------------------------------------------------------------- lazy UI
    function load() {
        if (!loading) {
            if (!document.querySelector(`link[data-mu-href="${FILES.css}"]`)) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = FILES.css; l.dataset.muHref = FILES.css; document.head.append(l); }
            loading = FILES.js.reduce((p, src) => p.then(() => new Promise((resolve, reject) => {
                if (document.querySelector(`script[data-mu-src="${src}"]`)) return resolve(undefined);
                const s = document.createElement("script"); s.src = src; s.async = false; s.dataset.muSrc = src;
                s.onload = () => resolve(undefined); s.onerror = () => reject(new Error(src));
                document.head.append(s);
            })), Promise.resolve()).catch((e) => { loading = null; throw e; });
        }
        return loading;
    }
    const isOpen = (id) => { const m = $(id); return Boolean(m && m.style.display === "flex"); };
    function show(id) { const m = $(id); if (m) { m.style.display = "flex"; m.setAttribute("aria-hidden", "false"); } }
    function hide(id) { const m = $(id); if (m) { m.style.display = "none"; m.setAttribute("aria-hidden", "true"); } }

    async function renderView() {
        if (!view) return;
        let all = [];
        try { all = await store.all(); } catch { all = [...mem.values()]; }
        view.render(all, { fleet: fleet.status(), storeKind: store.kind });
    }
    async function openRides() {
        const mount = $("rides-mount");
        if (!mount) return;
        await load();
        if (!view) view = R.ui.createRidesView(mount, {
            units: W.MUGarage.units, model: R.model,
            onClose: () => hide("rides-modal"),
            onShare: (r) => shareRide(r),
            onDelete: async (id) => {
                const ok = await confirmAsk("Delete this ride?", "It's removed from this phone. This can't be undone.", "Delete");
                if (!ok) return;
                try { await store.remove(id); } catch { /* gone */ }
                mem.delete(id);
                renderView(); refreshSettings();
            },
            onOpenConsent: () => openConsent(),
            onWipe: () => openWipe()
        });
        show("rides-modal");
        await renderView();
        const c = mount.querySelector(".rds-close"); if (c) /** @type {HTMLElement} */ (c).focus();
    }
    /** The app's confirm dialog when there is one (js/core.js), else the browser's. */
    async function confirmAsk(title, body, okLabel) {
        // @ts-ignore — js/core.js
        const cd = typeof confirmDialog === "function" ? confirmDialog : null;
        if (cd) { try { const r = await cd({ title, body, okLabel, cancelLabel: "Cancel", danger: true }); return Boolean(r && r.ok); } catch { /* fall back */ } }
        return W.confirm(`${title}\n\n${body}`);
    }
    function shareRide(r) {
        if (!W.MUShare || !W.MUShare.app) return;
        hide("rides-modal");
        const ev = r.powertrain === "ev";
        const energy = ev ? r.evEnergy : r.fuel;
        W.MUShare.app.open({
            trip: { startedAt: r.startedAt, endedAt: r.endedAt, totalDistKm: r.distance / 1000, avgSpeed: (r.avgSpeed || 0) * 3.6, maxSpeed: (r.maxSpeed || 0) * 3.6, fuelUsedL: r.fuel ? r.fuel * 1000 : null, points: (r.route || []).map(([lat, lng]) => ({ lat, lng })), place: r.place },
            live: r.source === "hud" ? { distance: r.distance, time: r.duration, moving: r.moving, energy: energy || 0, perMetre: energy && r.distance ? energy / r.distance : null, ecoScore: r.ecoScore, harsh: { accel: r.harsh || 0, brake: 0 }, cost: r.cost, maxSpeed: r.maxSpeed } : null,
            powertrain: r.powertrain || "ice", correction: r.matched ? 1.0001 : 1, bike: r.bike, priceUnit: r.priceUnit, priceExample: false
        });
    }

    // ---------------------------------------------------------------- consent (FLEET.md)
    async function openConsent() {
        const mount = $("fleet-consent-mount");
        if (!mount) return;
        await load();
        if (!consent) consent = R.consent.createConsentDialog(mount, {
            units: W.MUGarage.units,
            getStatus: () => fleet.status(),
            getPreview: () => fleet.preview(intervals(), bike()),
            bikeName: () => bike().name,
            onYes: async () => { const r = await fleet.optIn(intervals(), bike()); refreshSettings(); return r; },
            onNo: () => { if (!fleet.status().optedIn) fleet.decline(); refreshSettings(); },
            onStop: async () => { const r = await fleet.optOut(); refreshSettings(); return r; },
            onClose: () => { hide("fleet-consent-modal"); refreshSettings(); if (view && isOpen("rides-modal")) renderView(); }
        });
        show("fleet-consent-modal");
        await consent.open();
    }
    /** After a fill-up: share new tanks, or ask once when the first usable tank appears. */
    async function afterFillUp() {
        const n = usable();
        if (fleet.optedIn()) { await fleet.sync(intervals(), bike()); refreshSettings(); return; }
        if (!driving && bike().powertrain === "ice" && fleet.shouldAsk(n)) { fleet.markAsked(); setTimeout(() => openConsent(), 700); }
    }

    // ---------------------------------------------------------------- delete my history
    async function openWipe() {
        const mount = $("wipe-mount");
        if (!mount) return;
        await load();
        if (!wipe) wipe = R.consent.createWipeDialog(mount, {
            getCounts: async () => {
                let rides = 0; try { rides = await store.count(); } catch { rides = mem.size; }
                const f = FC(); const st = fleet.status();
                return { rides, fills: f && f.state && Array.isArray(f.state.fills) ? f.state.fills.length : 0, shared: st.optedIn, sharedTanks: st.sentTotal || 0, pendingDelete: st.pendingDelete };
            },
            onWipe: (what) => wipeHistory(what),
            onServerHistory: $("clear-history-btn") ? () => { const b = $("clear-history-btn"); if (b) b.click(); } : undefined,
            onClose: () => { hide("wipe-modal"); refreshSettings(); if (view && isOpen("rides-modal")) renderView(); }
        });
        show("wipe-modal");
        await wipe.open();
    }
    /**
     * @param {{ rides: boolean, fills: boolean, shared: boolean, caches: boolean }} what
     * @returns {Promise<Array<{ label: string, ok: boolean, note?: string }>>}
     */
    async function wipeHistory(what) {
        const out = [];
        if (what.rides) {
            let n = 0; try { n = await store.clear(); } catch { n = mem.size; }
            mem.clear();
            const b = $("rides-all-btn"); if (b) b.hidden = true;
            out.push({ label: `Ride summaries deleted (${n})`, ok: true });
        }
        if (what.fills) {
            const f = FC();
            if (f && typeof f.reset === "function") { f.reset(); out.push({ label: "Fill-up log and fuel curve cleared", ok: true }); }
            else out.push({ label: "Fill-up log", ok: false, note: "not available here" });
        }
        if (what.shared) {
            const r = await fleet.optOut();
            fleet.wipeLocal();
            out.push(r.pending ? { label: "Sharing is off", ok: false, note: "The server delete finishes next time you're online" } : { label: `Shared fuel data deleted from the server${r.deleted !== null ? ` (${r.deleted} tank${r.deleted === 1 ? "" : "s"})` : ""}`, ok: true });
        }
        if (what.caches) {
            let ok = true;
            try { if (W.caches) for (const name of OFFLINE_CACHES) await W.caches.delete(name); } catch { ok = false; }
            out.push({ label: "Offline route data deleted", ok, note: ok ? "Re-downloaded the next time you look at a route" : "Couldn't reach the browser's cache" });
        }
        if (!out.length) out.push({ label: "Nothing on this phone was selected", ok: true });
        refreshSettings();
        return out;
    }

    // ---------------------------------------------------------------- settings line
    async function refreshSettings() {
        const st = fleet.status();
        const btn = $("fleet-consent-btn"), line = $("fleet-status"), rb = $("open-rides-btn");
        if (btn) btn.textContent = st.optedIn ? "Manage" : "Learn more";
        if (line) line.textContent = st.optedIn ? `On. Sharing anonymous full-tank results (${st.sentTotal || 0} so far${st.queued ? `, ${st.queued} waiting` : ""}). No routes, places, dates or prices.`
            : st.pendingDelete ? "Off. Deleting what you shared: it finishes next time you're online."
            : "Off. Your fill-ups stay on this phone. Turn on to help improve fuel estimates for your bike model.";
        if (rb) { let n = 0; try { n = await store.count(); } catch { n = mem.size; } const sm = rb.querySelector("small"); if (sm) sm.textContent = n ? `${n} ride${n === 1 ? "" : "s"}` : ""; }
    }

    function init() {
        document.addEventListener("mu:trip-end", onTripEnd);
        document.addEventListener("mu:ride-summary", onSummary);
        document.addEventListener("mu:drive-state", (e) => { const d = /** @type {CustomEvent} */ (e).detail || {}; driving = Boolean(d.driving || d.navigating); });
        const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
        bind("open-rides-btn", () => openRides());
        bind("rides-all-btn", () => { hide("results-panel"); openRides(); });
        bind("fleet-consent-btn", () => openConsent());
        bind("delete-my-history-btn", () => openWipe());
        bind("fillup-log-btn", () => setTimeout(afterFillUp, 300));
        for (const id of ["rides-modal", "fleet-consent-modal", "wipe-modal"]) {
            const m = $(id);
            if (m) m.addEventListener("click", (e) => { if (e.target === m) hide(id); });
        }
        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            for (const id of ["wipe-modal", "fleet-consent-modal", "rides-modal"]) if (isOpen(id)) { hide(id); break; }
        });
        window.addEventListener("online", () => { fleet.sync(intervals(), bike()).then(refreshSettings).catch(() => { }); });
        setTimeout(() => { fleet.sync(intervals(), bike()).then(refreshSettings).catch(() => { }); }, 4000);
        store.count().then((n) => { const b = $("rides-all-btn"); if (b) b.hidden = !n; }).catch(() => { });
        refreshSettings();
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();

    R.app = { openRides, openConsent, openWipe, wipeHistory, store, fleet, get records() { return [...mem.values()]; } };
})(typeof globalThis !== "undefined" ? globalThis : this);
