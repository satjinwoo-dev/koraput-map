// @ts-check
/* ============================================================================
   MapUnite rides — ride summaries, the fleet share and their screens
   (roadmap Step 10)
   ==============================================================================
   Recording (SmartDrive calls onStart / onTick / onEnd through muHook):
     - every finished ride becomes one record on this phone (js/rides/ride-log.js):
       speed bands, coasting, hard braking, fill-ups, the fuel estimate, and — for
       the ride's own drawing and share card — the route simplified to ≤ 160
       points (js/rides/ride-model.js). Never uploaded. "mu:ride-saved" fires.
     - "mu:ride-summary" (the HUD's physics totals, js/hud/) makes the same record
       richer: fuel or battery energy, cost, eco score, harsh moments.

   Sharing (lib/bikedb/fleet.js, FLEET.md) is OFF until the rider says yes on the
   consent screen (#fleet-consent-modal, js/rides/consent-ui.js). It's offered ONCE,
   right after a fill-up makes the first usable full tank, never during a ride,
   never for an EV; "Not now" = not again for 60 days. Once on, the rider's
   full-tank records (FuelCurve.fleetTanks(): no times, no places) go to
   POST /api/bikes/fillups after each ride and fill-up, when the phone comes back
   online and at start-up (at most every 10 minutes). Off = erased on the server.

   Screens (loaded on first use, precached by sw.js): the ride dashboard
   (#rides-modal, js/rides/rides-ui.js), the consent screen, and "Delete my
   history" (#wipe-modal), which lets the rider pick what to erase. clearAll() is
   the same for everything at once; js/privacy.js's "Clear my history" calls it
   after the server confirmed its own deletion.
   ============================================================================ */
(function (root) {
    "use strict";
    const W = /** @type {any} */ (root);
    if (!W.document) return;
    const SYNC_EVERY = 10 * 60 * 1000;
    const OFFLINE_CACHES = ["mu-trip-v1", "mu-pitstop-v1"];         // route heights + bridges, fuel stations: route shapes
    const FILES = { js: ["js/rides/rides-ui.js", "js/rides/consent-ui.js"], css: "js/rides/rides.css" };
    const $ = (/** @type {string} */ id) => (typeof document.getElementById === "function" ? document.getElementById(id) : null);
    const core = () => (W.MURides && W.MURides.core) || null;
    const model = () => (W.MURides && W.MURides.model) || null;
    const storage = (() => { try { const s = W.localStorage; s.setItem("mu.t", "1"); s.removeItem("mu.t"); return s; } catch { return null; } })();

    /** classic-script lexicals are read by name */
    function g() {
        /** @type {any} */ const o = {};
        // @ts-ignore
        try { o.FuelCurve = typeof FuelCurve !== "undefined" ? FuelCurve : null; } catch { o.FuelCurve = null; }
        // @ts-ignore
        try { o.BikeFuel = typeof BikeFuel !== "undefined" ? BikeFuel : null; } catch { o.BikeFuel = null; }
        // @ts-ignore
        try { o.mode = typeof currentTravelMode !== "undefined" ? currentTravelMode : "bike"; } catch { o.mode = "bike"; }
        // @ts-ignore
        try { o.cityName = typeof cityName !== "undefined" ? cityName : ""; } catch { o.cityName = ""; }
        // @ts-ignore
        try { o.confirmDialog = typeof confirmDialog === "function" ? confirmDialog : null; } catch { o.confirmDialog = null; }
        return o;
    }
    function apiBase() {
        try { return W.MUGarage && W.MUGarage.store && W.MUGarage.store.resolveApiBase ? W.MUGarage.store.resolveApiBase(W, W.location) : W.location.origin; } catch { return null; }
    }

    let log = null, share = null, lastSync = 0, syncing = null, driving = false;
    let loading = null, view = null, consent = null, wipe = null;
    function ensure() {
        const C = core();
        if (!C) return false;
        if (!log) log = C.createRideLog({ storage });
        if (!share) share = C.createFleetShare({ storage, fetch: typeof W.fetch === "function" ? W.fetch.bind(W) : null, apiBase: apiBase() });
        return true;
    }
    const FC = () => g().FuelCurve;
    const intervals = () => { const f = FC(); try { return f && typeof f.intervals === "function" ? f.intervals() : []; } catch { return []; } };
    const usableTanks = () => intervals().filter((iv) => iv.usable).length;
    const fleetTanks = () => { const f = FC(); try { return f && typeof f.fleetTanks === "function" ? f.fleetTanks() : []; } catch { return []; } };
    /** The bike in My bike (name, powertrain) for the screens. */
    function bike() {
        const st = W.MUTrip && W.MUTrip.app && W.MUTrip.app.store;
        let gar = null; try { gar = st ? st.garage() : null; } catch { gar = null; }
        const classKey = gar && gar.classKey ? gar.classKey : null;
        return { name: gar && gar.title ? gar.title : "", powertrain: classKey && classKey.startsWith("ev") ? "ev" : classKey ? "ice" : null };
    }

    // ================================================================ recording
    /** @param {any} trip SmartDrive.trip */
    function onStart(trip) {
        const C = core();
        if (!C || !trip) return;
        if (!trip.rideSum || trip.rideSum.v !== 1) trip.rideSum = C.createAccumulator(trip.startTime || Date.now());    // a restored ride keeps its own
    }
    /** @param {any} trip @param {{ accepted: boolean, smoothedKmh: number, dtSec?: number, distKm?: number }} fix */
    function onTick(trip, fix) {
        const C = core();
        if (!C || !trip || !trip.active || !fix || !fix.accepted) return;
        if (!trip.rideSum) onStart(trip);
        C.step(trip.rideSum, { t: Date.now() / 1000, v: (Number(fix.smoothedKmh) || 0) / 3.6, dt: Number.isFinite(fix.dtSec) ? fix.dtSec : 1, distance: (Number(fix.distKm) || 0) * 1000 });
    }
    /**
     * @param {any} trip
     * @param {{ fuelL?: number, idleFuelL?: number, fuelSource?: string }} [extra]
     */
    function onEnd(trip, extra = {}) {
        const C = core();
        if (!C || !trip || !trip.rideSum || !ensure()) return null;
        const G = g();
        const acc = trip.rideSum;
        trip.rideSum = null;
        if (G.mode === "walk" || acc.distance < 50) return null;          // a walk, or barely moved: nothing to summarise
        const electric = G.BikeFuel && G.BikeFuel.status === "ev";
        const M = model();
        const pts = (Array.isArray(trip.points) ? trip.points : []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng)).map((p) => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lng * 1e5) / 1e5]);
        const b = bike();
        const s = C.finish(acc, {
            endedAt: Date.now(),
            fuelL: electric ? null : extra.fuelL, idleFuelL: electric ? null : extra.idleFuelL, fuelSource: extra.fuelSource,
            fills: G.FuelCurve && G.FuelCurve.state ? G.FuelCurve.state.fills : [],
            bikeTag: G.BikeFuel && typeof G.BikeFuel.tag === "function" ? G.BikeFuel.tag() : null,
            bike: b.name || null, powertrain: electric ? "ev" : b.powertrain, mode: G.mode || "bike",
            place: G.cityName || "", route: M && typeof M.simplify === "function" ? M.simplify(pts) : []
        });
        const prev = log.get(s.id);                                        // the HUD's totals may have arrived first
        log.add(prev && prev.source === "hud" ? { ...s, ...pick(prev, HUD_FIELDS), moving: prev.moving, avgSpeed: prev.avgSpeed } : s);
        document.dispatchEvent(new CustomEvent("mu:ride-saved", { detail: log.get(s.id) }));
        afterRide();
        return log.get(s.id);
    }
    const HUD_FIELDS = ["distance", "maxSpeed", "fuel", "evEnergy", "powertrain", "ecoScore", "harsh", "cost", "priceUnit", "bike", "matched", "source"];
    const pick = (/** @type {any} */ o, /** @type {string[]} */ keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
    /** "mu:ride-summary": the HUD's physics totals for the ride that just ended. */
    function onSummary(/** @type {any} */ e) {
        const s = e && e.detail;
        const M = model();
        if (!s || !s.trip || !Number.isFinite(s.trip.startedAt) || !M || !ensure()) return;
        const id = `ride-${s.trip.startedAt}`;
        const cur = log.get(id) || M.fromTripEnd(s.trip);
        const rec = M.merge(cur, s);
        if (!(rec.distance >= 200) && !log.get(id)) return;               // nothing worth a record
        log.add(rec);
        refreshSettings();
        if (view && isOpen("rides-modal")) renderView();
    }

    // ================================================================ the fleet share
    /** @param {boolean} [force] */
    function sync(force = false) {
        if (!ensure()) return Promise.resolve(null);
        const st = share.status();
        if (!st.optedIn && !st.pendingErase) return Promise.resolve(null);
        if (!force && Date.now() - lastSync < SYNC_EVERY) return Promise.resolve(null);
        if (syncing) return syncing;
        lastSync = Date.now();
        syncing = (st.optedIn ? share.sync(fleetTanks()) : share.flushErase())
            .catch((/** @type {any} */ e) => ({ ok: false, reason: String(e && e.message || e) }))
            .finally(() => { syncing = null; refreshSettings(); });
        return syncing;
    }
    function optIn() { if (!ensure()) return null; const s = share.optIn(); sync(true); return s; }
    /** @param {{ erase?: boolean }} [opts] */
    function optOut(opts) { return ensure() ? share.optOut(opts) : Promise.resolve(null); }
    function afterRide() { sync(true); refreshSettings(); const b = $("rides-all-btn"); if (b) b.hidden = false; }
    /** After a fill-up: share new tanks, or offer sharing once when the first usable tank appears. */
    async function afterFillUp() {
        if (!ensure()) return;
        if (share.status().optedIn) { await sync(true); return; }
        if (!driving && bike().powertrain !== "ev" && share.shouldAsk(usableTanks())) { share.markAsked(); setTimeout(() => openConsent(), 700); }
    }

    // ================================================================ "Clear my history" / "Delete my history"
    /**
     * Erase what the rider picked. Every item reports what happened.
     * @param {{ rides?: boolean, fills?: boolean, shared?: boolean, caches?: boolean }} what
     * @returns {Promise<Array<{ label: string, ok: boolean, note?: string }>>}
     */
    async function wipeHistory(what) {
        /** @type {Array<{ label: string, ok: boolean, note?: string }>} */ const out = [];
        if (!ensure()) return [{ label: "Ride data isn't available here", ok: false }];
        if (what.rides) {
            const n = log.size;
            log.clear();
            const b = $("rides-all-btn"); if (b) b.hidden = true;
            out.push({ label: `Ride summaries deleted (${n})`, ok: true });
        }
        if (what.fills) {
            const f = FC();
            try { W.localStorage.removeItem("mu.pitstop.v1"); } catch { /* blocked */ }      // convoy levels typed in
            if (f && typeof f.reset === "function") { f.reset(); out.push({ label: "Fill-up log and fuel curve cleared", ok: true }); }
            else out.push({ label: "Fill-up log", ok: false, note: "not available here" });
        }
        if (what.shared) {
            const r = await share.optOut({ erase: true }).catch(() => ({ deleted: 0, pending: 1 }));
            share.wipeLocal();
            out.push(r && r.pending ? { label: "Sharing is off", ok: false, note: "The server delete finishes next time you're online" }
                : { label: `Shared fuel data deleted from the server (${r ? r.deleted : 0} tank${r && r.deleted === 1 ? "" : "s"})`, ok: true });
        }
        if (what.caches) {
            let ok = true;
            try { if (W.caches) await Promise.all(OFFLINE_CACHES.map((n) => W.caches.delete(n))); } catch { ok = false; }
            out.push({ label: "Offline route data deleted", ok, note: ok ? "Re-downloaded the next time you look at a route" : "Couldn't reach the browser's cache" });
        }
        if (!out.length) out.push({ label: "Nothing on this phone was selected", ok: true });
        refreshSettings();
        return out;
    }
    /** Everything at once (js/privacy.js "Clear my history"). */
    async function clearAll() {
        if (!ensure()) return null;
        const rides = log.size;
        const f = FC();
        const fills = f && f.state ? (f.state.fills || []).length : 0;
        const res = await wipeHistory({ rides: true, fills: true, shared: true, caches: true });
        const st = share.status();
        const sharedLine = res.find((x) => /Shared fuel data deleted/.test(x.label));
        return { rides, fills, sharedDeleted: sharedLine ? Number(/\((\d+)/.exec(sharedLine.label)?.[1] || 0) : 0, sharedPending: st.pendingErase };
    }

    // ================================================================ screens (lazy)
    function load() {
        if (!loading) {
            if (!document.querySelector(`link[data-mu-href="${FILES.css}"]`)) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = FILES.css; l.dataset.muHref = FILES.css; document.head.append(l); }
            loading = FILES.js.reduce((p, src) => p.then(() => new Promise((resolve, reject) => {
                if (document.querySelector(`script[data-mu-src="${src}"]`)) return resolve(undefined);
                const sc = document.createElement("script"); sc.src = src; sc.async = false; sc.dataset.muSrc = src;
                sc.onload = () => resolve(undefined); sc.onerror = () => reject(new Error(src));
                document.head.append(sc);
            })), Promise.resolve()).catch((e) => { loading = null; throw e; });
        }
        return loading;
    }
    const isOpen = (/** @type {string} */ id) => { const m = $(id); return Boolean(m && m.style.display === "flex"); };
    function show(/** @type {string} */ id) { const m = $(id); if (m) { m.style.display = "flex"; m.setAttribute("aria-hidden", "false"); } }
    function hide(/** @type {string} */ id) { const m = $(id); if (m) { m.style.display = "none"; m.setAttribute("aria-hidden", "true"); } }

    function renderView() {
        if (!view || !ensure()) return;
        view.render(log.list().sort((a, b) => b.startedAt - a.startedAt), { fleet: share.status(), storeKind: storage ? "local" : "memory" });
    }
    async function openRides() {
        const mount = $("rides-mount");
        if (!mount || !ensure()) return;
        await load();
        if (!view) view = W.MURides.ui.createRidesView(mount, {
            units: W.MUGarage.units, model: W.MURides.model,
            onClose: () => hide("rides-modal"),
            onShare: (/** @type {any} */ r) => shareRide(r),
            onDelete: async (/** @type {string} */ id) => {
                if (!(await confirmAsk("Delete this ride?", "It's removed from this phone. This can't be undone.", "Delete"))) return;
                log.remove(id);
                renderView(); refreshSettings();
            },
            onOpenConsent: () => openConsent(),
            onWipe: () => openWipe()
        });
        show("rides-modal");
        renderView();
        const c = mount.querySelector(".rds-close"); if (c) /** @type {HTMLElement} */ (c).focus();
    }
    /** The app's confirm dialog (js/core.js), else the browser's. */
    async function confirmAsk(/** @type {string} */ title, /** @type {string} */ body, /** @type {string} */ okLabel) {
        const cd = g().confirmDialog;
        if (cd) { try { const r = await cd({ title, body, okLabel, cancelLabel: "Cancel", danger: true }); return Boolean(r && r.ok); } catch { /* fall back */ } }
        return W.confirm(`${title}\n\n${body}`);
    }
    function shareRide(/** @type {any} */ r) {
        if (!W.MUShare || !W.MUShare.app) return;
        hide("rides-modal");
        const ev = r.powertrain === "ev";
        const energy = ev ? r.evEnergy : r.fuel;
        W.MUShare.app.open({
            trip: { startedAt: r.startedAt, endedAt: r.endedAt, totalDistKm: r.distance / 1000, avgSpeed: (r.avgSpeed || 0) * 3.6, maxSpeed: (r.maxSpeed || 0) * 3.6, fuelUsedL: r.fuel ? r.fuel * 1000 : null, points: (r.route || []).map((/** @type {number[]} */ [lat, lng]) => ({ lat, lng })), place: r.place },
            live: r.source === "hud" ? { distance: r.distance, time: r.duration, moving: r.moving, energy: energy || 0, perMetre: energy && r.distance ? energy / r.distance : null, ecoScore: r.ecoScore, harsh: { accel: r.harsh || 0, brake: 0 }, cost: r.cost, maxSpeed: r.maxSpeed } : null,
            powertrain: r.powertrain || "ice", correction: r.matched ? 1.0001 : 1, bike: r.bike, priceUnit: r.priceUnit, priceExample: false
        });
    }
    async function openConsent() {
        const mount = $("fleet-consent-mount");
        if (!mount || !ensure()) return;
        await load();
        if (!consent) consent = W.MURides.consent.createConsentDialog(mount, {
            units: W.MUGarage.units,
            getStatus: () => share.status(),
            getPreview: async () => share.preview(fleetTanks()),
            bikeName: () => bike().name,
            onYes: async () => {
                share.optIn();
                const r = await sync(true);
                return r && r.ok ? { sent: r.stored } : { queued: true };
            },
            onNo: () => { if (!share.status().optedIn) share.decline(); refreshSettings(); },
            onStop: async () => { const r = await share.optOut({ erase: true }); refreshSettings(); return { ok: true, deleted: r ? r.deleted : null, pending: Boolean(r && r.pending) }; },
            onClose: () => { hide("fleet-consent-modal"); refreshSettings(); if (view && isOpen("rides-modal")) renderView(); }
        });
        show("fleet-consent-modal");
        await consent.open();
    }
    async function openWipe() {
        const mount = $("wipe-mount");
        if (!mount || !ensure()) return;
        await load();
        if (!wipe) wipe = W.MURides.consent.createWipeDialog(mount, {
            getCounts: async () => {
                const f = FC(); const st = share.status();
                return { rides: log.size, fills: f && f.state && Array.isArray(f.state.fills) ? f.state.fills.length : 0, shared: st.optedIn, sharedTanks: st.sentTotal || 0, pendingDelete: st.pendingDelete };
            },
            onWipe: (/** @type {any} */ what) => wipeHistory(what),
            onServerHistory: $("clear-history-btn") ? () => { const b = $("clear-history-btn"); if (b) b.click(); } : undefined,
            onClose: () => { hide("wipe-modal"); refreshSettings(); if (view && isOpen("rides-modal")) renderView(); }
        });
        show("wipe-modal");
        await wipe.open();
    }

    function refreshSettings() {
        if (!ensure()) return;
        const st = share.status();
        const btn = $("fleet-consent-btn"), line = $("fleet-status"), rb = $("open-rides-btn");
        if (btn) btn.textContent = st.optedIn ? "Manage" : "Learn more";
        if (line) line.textContent = st.optedIn ? `On. Sharing anonymous full-tank results (${st.sentTotal || 0} so far). No routes, places, dates or prices.`
            : st.pendingDelete ? "Off. Deleting what you shared: it finishes next time you're online."
            : st.available ? "Off. Your fill-ups stay on this phone. Turn on to help improve fuel estimates for your bike model." : "Off. This app isn't connected to a MapUnite server.";
        if (rb) { const n = log.size; const sm = rb.querySelector("small"); if (sm) sm.textContent = n ? `${n} ride${n === 1 ? "" : "s"}` : ""; }
    }

    function init() {
        document.addEventListener("mu:ride-summary", onSummary);
        document.addEventListener("mu:drive-state", (/** @type {any} */ e) => { const d = (e && e.detail) || {}; driving = Boolean(d.driving || d.navigating); });
        const bind = (/** @type {string} */ id, /** @type {() => void} */ fn) => { const el = $(id); if (el && el.addEventListener) el.addEventListener("click", fn); };
        bind("open-rides-btn", () => openRides());
        bind("rides-all-btn", () => { hide("results-panel"); openRides(); });
        bind("fleet-consent-btn", () => openConsent());
        bind("delete-my-history-btn", () => openWipe());
        bind("fillup-log-btn", () => setTimeout(afterFillUp, 300));
        for (const id of ["rides-modal", "fleet-consent-modal", "wipe-modal"]) {
            const m = $(id);
            if (m && m.addEventListener) m.addEventListener("click", (e) => { if (e.target === m) hide(id); });
        }
        document.addEventListener("keydown", (/** @type {any} */ e) => {
            if (!e || e.key !== "Escape") return;
            for (const id of ["wipe-modal", "fleet-consent-modal", "rides-modal"]) if (isOpen(id)) { hide(id); break; }
        });
        if (ensure()) { const b = $("rides-all-btn"); if (b) b.hidden = !log.size; }
        refreshSettings();
    }
    if (document.readyState === "loading" && document.addEventListener) document.addEventListener("DOMContentLoaded", init); else init();
    if (W.addEventListener) W.addEventListener("online", () => sync(true));
    setTimeout(() => sync(), 5000);                                      // start-up: pending erasures, unsent tanks

    W.MURides = W.MURides || {};
    W.MURides.app = {
        onStart, onTick, onEnd, sync, optIn, optOut, clearAll, wipeHistory, afterFillUp,
        openRides, openConsent, openWipe,
        summaries: () => (ensure() ? log.list() : []),
        status: () => (ensure() ? share.status() : null),
        mine: () => (ensure() ? share.mine() : Promise.resolve(null))
    };
})(typeof globalThis !== "undefined" ? globalThis : this);
