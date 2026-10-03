"use strict";

/* ============================================================================
   MapUnite client — js/smartdrive.js
   ==============================================================================
   SmartDrive: speed alerts, the fuel model (baseline curve + the rider's
   personal fuel curve), trip recording and the trip summary.

   The fuel baseline is, in order:
     1. the rider's bike from "My bike" (js/garage/): the physics core's km/L at
        each steady speed and its idle burn for that bike and those settings
        (BikeFuel, from a snapshot kept on the phone);
     2. otherwise the generic U-curve from the km/L the rider typed, or 18 km/L
        when they never did, exactly as before (riders without a bike see no change).
   The fill-up learner (FuelCurve) corrects whichever baseline is in use.

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

// ============================================================================
// SMARTDRIVE — speed-alert v2 (Section 8) + fuel model v2 (Section 9)
// ============================================================================
const IDLE_L_PER_HOUR = 0.4;          // assumed idle burn while stopped-but-active — labeled, not measured
const IDLE_CUTOFF_SEC = 180;          // beyond this we assume the engine's actually off, not idling

// Speed bands the fuel model and the personal curve are expressed in. The
// 40–60 band is the "efficient" reference the trip summary compares against.
const FUEL_BANDS = [
    { label: "under 40", mid: 25 },
    { label: "40–60", mid: 50 },
    { label: "60–80", mid: 70 },
    { label: "over 80", mid: 95 }
];
function fuelBandIndex(kmh) { return kmh < 40 ? 0 : kmh <= 60 ? 1 : kmh <= 80 ? 2 : 3; }
// Shape of the generic U-curve as a fraction of the rated km/L: 1.0 inside
// 40–60, drag losses above 60, stop-start losses below 40 (Section 9).
function fuelShape(kmh) {
    let f = 1;
    if (kmh > 60) f -= (kmh - 60) * 0.005;
    else if (kmh < 40) f -= (40 - kmh) * 0.004;
    return Math.max(0.25, f);
}
// The generic curve exactly as Fuel model v2 always computed it.
function genericKmPerL(kmh, rated) {
    const r = rated || 18;
    let eff = r;
    if (kmh > 60) eff -= (kmh - 60) * 0.005 * r;
    else if (kmh < 40) eff -= (40 - kmh) * 0.004 * r;
    return Math.max(5, eff);
}

// ============================================================================
// BIKE FUEL — the physics of the rider's own bike as the baseline (Step 7)
// ============================================================================
// "My bike" (js/garage/) saves the rider's bike in localStorage (mu.garage.v1).
// From it, MUGarage.fuelBaseline builds a snapshot: km/L per km/h on a flat road,
// idle L/h, and the 40–60 km/h reference, all from the physics core. The snapshot
// is stored (mu_bike_fuel_v1) so the app starts with it at once and offline; it is
// rebuilt (loading the physics on demand) only when the bike, its data or the
// rider's settings change. No bike, an electric bike, or a bike whose data can't be
// loaded: inactive, and SmartDrive behaves exactly as it did before Step 7.
const SPEED_BIN_KMH = 5;          // drives also keep km per 5 km/h bin, so any baseline can be re-fitted later
const SPEED_BINS = 40;            // 0 … 200 km/h (the last bin takes anything faster)
const speedBin = (kmh) => Math.min(SPEED_BINS - 1, Math.max(0, Math.floor(kmh / SPEED_BIN_KMH)));

const BikeFuel = {
    GARAGE_KEY: "mu.garage.v1",
    SNAP_KEY: "mu_bike_fuel_v1",
    snap: null,            // the stored snapshot (petrol or ev), or null
    status: "none",        // none | ready | ev | loading | error
    error: "",
    _pending: null,

    lib() { return (typeof window !== "undefined" && window.MUGarage && window.MUGarage.fuelBaseline) || null; },
    garage() {
        try {
            const g = JSON.parse(localStorage.getItem(this.GARAGE_KEY) || "null");
            return g && g.v === 1 && /^[0-9a-f]{16}$/.test(g.bundle) && typeof g.classKey === "string" ? g : null;
        } catch (e) { return null; }
    },
    readSnap() {
        const L = this.lib();
        if (!L) return null;
        try { return L.readSnapshot(JSON.parse(localStorage.getItem(this.SNAP_KEY) || "null")); } catch (e) { return null; }
    },

    active() { return this.status === "ready" && Boolean(this.snap) && this.snap.kind === "petrol"; },
    kmPerL(kmh) { return this.active() ? this.lib().kmPerLAt(this.snap, kmh) : null; },
    idleLPerHour() { return this.active() ? this.snap.idleLPerHour : null; },
    referenceKmPerL() { return this.active() ? this.snap.referenceKmPerL : null; },
    // Which vehicle a fill-up belongs to (null without a bike: untagged, as before).
    tag() { const g = this.garage(); const L = this.lib(); return g && L ? L.bikeTag(g) : null; },

    init() {
        if (!this._listening && typeof window !== "undefined" && window.addEventListener) {
            this._listening = true;
            // the standalone garage.html in another tab, or a retry when the network comes back
            window.addEventListener("storage", (e) => { if (e.key === this.GARAGE_KEY) this.sync(); });
            window.addEventListener("online", () => { if (this.status === "error") this.sync(); });
        }
        return this.sync();
    },

    /** Bring the baseline in line with the saved bike. Synchronous when the snapshot matches. */
    sync() {
        const g = this.garage(), L = this.lib();
        if (!g || !L) {
            const had = this.status !== "none";
            this.snap = null; this.status = "none"; this.error = "";
            try { localStorage.removeItem(this.SNAP_KEY); } catch (e) { /* storage blocked */ }
            if (had) this.changed();
            return Promise.resolve(this.status);
        }
        const key = L.garageKey(g);
        const stored = this.readSnap();
        if (stored && stored.key === key) {
            const was = this.status, wasKey = this.snap && this.snap.key;
            this.snap = stored; this.status = stored.kind === "ev" ? "ev" : "ready"; this.error = "";
            if (was !== this.status || wasKey !== key) this.changed();
            return Promise.resolve(this.status);
        }
        return this.rebuild(g, key);
    },

    /** Recompute the snapshot from the physics (loads the garage's data layer on demand). */
    rebuild(g, key) {
        if (this._pending && this._pending.key === key) return this._pending.promise;
        const wasActive = this.active();
        this.status = "loading"; this.snap = null;
        if (wasActive) this.changed();
        const promise = (async () => {
            try {
                if (typeof GarageSheet === "undefined") throw new Error("garage loader missing");
                const { store, physics } = await GarageSheet.core();
                const { index } = await store.catalog();
                const { model } = await store.model(g, index);
                const snap = this.lib().buildFuelBaseline(physics, model, g);
                if (this.lib().garageKey(this.garage() || g) !== key) return this.status;      // the bike changed meanwhile
                try { localStorage.setItem(this.SNAP_KEY, JSON.stringify(snap)); } catch (e) { /* storage full: still used this session */ }
                this.snap = snap; this.status = snap.kind === "ev" ? "ev" : "ready"; this.error = "";
            } catch (e) {
                this.snap = null; this.status = "error"; this.error = (e && e.message) || String(e);
                console.warn("[BikeFuel] using the generic curve:", this.error);
            } finally {
                if (this._pending && this._pending.key === key) this._pending = null;
            }
            this.changed();
            return this.status;
        })();
        this._pending = { key, promise };
        return promise;
    },

    changed() {
        if (typeof FuelCurve !== "undefined" && FuelCurve.fit !== undefined) FuelCurve.refit();
        if (typeof SmartDrive !== "undefined" && SmartDrive.renderFuelSource) SmartDrive.renderFuelSource(true);
    },

    /** One line for Settings: where the fuel numbers come from. */
    describe() {
        const s = this.snap;
        if (this.status === "ready" && s) {
            const pm = Number.isFinite(s.sigmaRel) && s.sigmaRel > 0 ? ` ±${Math.round(s.sigmaRel * 100)}%` : "";
            const eco = s.eco ? ` Best mileage at ${Math.round(s.eco.fromKmh)}–${Math.round(s.eco.toKmh)} km/h.` : "";
            return `From your ${s.estimated ? "typical " : ""}${s.title} in My bike: ${s.referenceKmPerL.toFixed(1)} km/L at 40–60 km/h${pm} on a flat road (physics; stops and hills use more).${eco} Your fill-ups correct it.`;
        }
        if (this.status === "ev" && s) return `Your ${s.title} is electric: trip fuel isn't counted for it. Its energy use is in My bike.`;
        if (this.status === "loading") return "Loading your bike from My bike…";
        if (this.status === "error") return "Couldn't load your bike's data (offline?). Using the km/L below until it can.";
        return "";
    }
};

// ============================================================================
// PERSONAL FUEL CURVE — roadmap Section 6 / Section 30 #10 and #16
// ============================================================================
// Learns how THIS vehicle actually burns fuel, from the rider's own fill-ups.
//
// Every recorded drive keeps, per speed band j, the "shape distance"
//   g_j = Σ distKm / fuelShape(speed)
// so the generic curve's fuel for that band is g_j / rated. Between two
// full-tank fill-ups the litres pumped are known. For interval i:
//   litres_i ≈ Σ_j β_j · g_ij / rated  +  β_idle · 0.4 L/h · idleHours_i
// β = 1 everywhere is exactly the generic curve. β is found by bounded,
// ridge-regularised linear least squares, pulled toward 1 with a weight
// worth about one fill-up interval — so a band you rarely drive in stays
// near the generic curve instead of swinging on one noisy data point. The
// U-shape inside each band is kept; only its level per band is learned.
//
// The curve is only used once it has ≥ 3 usable intervals AND predicts
// those fill-ups better than the generic curve does. Everything is local
// (localStorage) — fill-ups never leave the phone.
//
// With the rider's bike (BikeFuel) the baseline is the bike's physics curve
// instead of rated · fuelShape: feature j becomes the physics litres in band j
// (from each drive's 5 km/h speed bins; older drives without bins use their
// band's mid speed), idle is the physics idle burn, and β corrects that.
// Fill-ups are tagged with the bike; a tank logged with a different bike
// isn't used for this one.
const FuelCurve = {
    KEY: "mu_fuel_curve",
    MIN_INTERVALS: 3,
    PRIOR_WEIGHT: 1,
    MAX_FILLS: 80,
    MAX_TRIPS: 600,
    LO: [0.25, 0.25, 0.25, 0.25, 0],   // β bounds: km/L can't be 4× better or worse than
    HI: [4, 4, 4, 4, 5],               // stated; idle between 0 and 2 L/h
    state: { fills: [], trips: [], enabled: true },
    fit: null,

    load() {
        try {
            const raw = JSON.parse(localStorage.getItem(this.KEY) || "null");
            if (raw && typeof raw === "object") {
                this.state = {
                    fills: Array.isArray(raw.fills) ? raw.fills.filter((f) => f && Number.isFinite(f.ts) && Number.isFinite(f.litres)) : [],
                    trips: Array.isArray(raw.trips) ? raw.trips.filter((t) => t && Number.isFinite(t.endedAt) && Array.isArray(t.shape)) : [],
                    enabled: raw.enabled !== false
                };
            }
        } catch (e) { /* corrupt or blocked storage — start empty */ }
    },
    save() {
        try { localStorage.setItem(this.KEY, JSON.stringify(this.state)); } catch (e) { /* storage full/blocked — the curve just won't persist */ }
    },

    // One drive segment: {startedAt, endedAt, shape[4], bandKm[4], idleH, km}.
    recordTrip(seg) {
        if (!seg || !Number.isFinite(seg.km) || (seg.km < 0.05 && !(seg.idleH > 0))) return;
        const clean = (a) => [0, 1, 2, 3].map((j) => Math.max(0, Number(a?.[j]) || 0));
        const trip = {
            startedAt: seg.startedAt || seg.endedAt, endedAt: seg.endedAt,
            shape: clean(seg.shape), bandKm: clean(seg.bandKm),
            idleH: Math.max(0, Number(seg.idleH) || 0), km: Math.max(0, seg.km)
        };
        if (Array.isArray(seg.hist) && seg.hist.length === SPEED_BINS) trip.hist = seg.hist.map((x) => Math.round(Math.max(0, Number(x) || 0) * 1e4) / 1e4);
        this.state.trips.push(trip);
        this.state.trips.sort((a, b) => a.endedAt - b.endedAt);
        if (this.state.trips.length > this.MAX_TRIPS) this.state.trips.splice(0, this.state.trips.length - this.MAX_TRIPS);
        this.save();
        this.refit();
    },

    logFill({ litres, full = true, odometerKm = null, ts = Date.now() }) {
        const L = Number(litres);
        if (!Number.isFinite(L) || L <= 0 || L > 300) return { ok: false, reason: "litres" };
        const odo = Number(odometerKm);
        // A fill logged mid-drive splits that drive: the part before the pump
        // belongs to the tank that just ran down.
        if (typeof SmartDrive !== "undefined" && SmartDrive.trip && SmartDrive.trip.active) SmartDrive.flushFitSegment(ts - 1);
        const fill = { ts, litres: Math.round(L * 100) / 100, full: Boolean(full), odometerKm: Number.isFinite(odo) && odo > 0 ? odo : null };
        const bike = typeof BikeFuel !== "undefined" ? BikeFuel.tag() : null;
        if (bike) fill.bike = bike;
        this.state.fills.push(fill);
        this.state.fills.sort((a, b) => a.ts - b.ts);
        if (this.state.fills.length > this.MAX_FILLS) this.state.fills.splice(0, this.state.fills.length - this.MAX_FILLS);
        // Trips older than the oldest remaining full fill can never be used.
        const firstFull = this.state.fills.find((f) => f.full);
        if (firstFull) this.state.trips = this.state.trips.filter((t) => t.endedAt > firstFull.ts - 1);
        this.save();
        this.refit();
        return { ok: true };
    },

    removeFill(ts) {
        this.state.fills = this.state.fills.filter((f) => f.ts !== ts);
        this.save();
        this.refit();
    },

    reset() {
        this.state = { fills: [], trips: [], enabled: this.state.enabled };
        this.fit = null;
        this.save();
        this.render();
    },

    rated() { return (typeof SmartDrive !== "undefined" && SmartDrive.baseMileage) || 18; },
    bike() { return typeof BikeFuel !== "undefined" && BikeFuel.active(); },
    // The curve the learner corrects: the bike's physics, else rated · fuelShape (the generic curve).
    baseKmPerL(kmh, rated = this.rated()) { return this.bike() ? BikeFuel.kmPerL(kmh) : rated * fuelShape(kmh); },
    baseIdle() { return this.bike() ? BikeFuel.idleLPerHour() : IDLE_L_PER_HOUR; },
    baseName() { return this.bike() ? "your bike's physics" : "the generic curve"; },
    // Physics litres per band for one drive: from its speed bins, else its band km at the band's mid speed.
    bikeLitres(t) {
        const out = [0, 0, 0, 0];
        if (Array.isArray(t.hist) && t.hist.length === SPEED_BINS) {
            t.hist.forEach((km, b) => { if (km > 0) { const v = (b + 0.5) * SPEED_BIN_KMH; out[fuelBandIndex(v)] += km / BikeFuel.kmPerL(v); } });
        } else for (let j = 0; j < 4; j++) if (t.bandKm[j] > 0) out[j] = t.bandKm[j] / BikeFuel.kmPerL(FUEL_BANDS[j].mid);
        return out;
    },

    // Full-to-full intervals with the drives recorded inside them.
    intervals() {
        const fills = [...this.state.fills].sort((a, b) => a.ts - b.ts);
        const out = [];
        let prev = -1;
        for (let i = 0; i < fills.length; i++) {
            if (!fills[i].full) continue;
            if (prev >= 0) {
                const from = fills[prev], to = fills[i];
                const litres = fills.slice(prev + 1, i + 1).reduce((a, f) => a + f.litres, 0);
                const trips = this.state.trips.filter((t) => t.endedAt > from.ts && t.endedAt <= to.ts);
                const shape = [0, 0, 0, 0], bandKm = [0, 0, 0, 0], bikeL = [0, 0, 0, 0];
                const useBike = this.bike();
                let idleH = 0, km = 0;
                trips.forEach((t) => {
                    for (let j = 0; j < 4; j++) { shape[j] += t.shape[j]; bandKm[j] += t.bandKm[j]; }
                    idleH += t.idleH; km += t.km;
                    if (useBike) { const b = this.bikeLitres(t); for (let j = 0; j < 4; j++) bikeL[j] += b[j]; }
                });
                const odoKm = from.odometerKm && to.odometerKm && to.odometerKm > from.odometerKm ? to.odometerKm - from.odometerKm : null;
                const coverage = odoKm ? km / odoKm : null;
                let usable = true, reason = "";
                const nowBike = typeof BikeFuel !== "undefined" ? BikeFuel.tag() : null;
                if (nowBike && ((from.bike && from.bike !== nowBike) || (to.bike && to.bike !== nowBike))) { usable = false; reason = "logged with a different bike"; }
                else if (trips.length === 0 || km < 5) { usable = false; reason = "too little recorded driving"; }
                else if (coverage !== null && coverage < 0.6) { usable = false; reason = `only ${Math.round(coverage * 100)}% of the odometer distance was recorded`; }
                else if (coverage !== null && coverage > 1.25) { usable = false; reason = "recorded distance is more than the odometer shows"; }
                else if (km / litres < 2 || km / litres > 90) { usable = false; reason = `${(km / litres).toFixed(1)} km/L doesn't add up — some driving may not have been recorded`; }
                // Driving the app didn't see still burned some of these litres:
                // assume it burned at this interval's own average rate.
                const litresAdj = coverage !== null && coverage < 1 ? litres * coverage : litres;
                const iv = { fromTs: from.ts, toTs: to.ts, litres, litresAdj, shape, bandKm, idleH, km, odoKm, coverage, trips: trips.length, usable, reason };
                if (useBike) iv.bikeL = bikeL;
                out.push(iv);
            }
            prev = i;
        }
        return out;
    },

    // min Σ(y − Xβ)² + Σ λ_j(β_j − β0_j)²  s.t. lo ≤ β ≤ hi, by projected
    // coordinate descent on the normal equations (convex, 5 unknowns).
    solve(X, y, beta0, lambda, lo, hi) {
        const p = beta0.length;
        const A = Array.from({ length: p }, () => new Array(p).fill(0));
        const b = new Array(p).fill(0);
        for (let i = 0; i < X.length; i++) {
            for (let j = 0; j < p; j++) {
                b[j] += X[i][j] * y[i];
                for (let k = 0; k < p; k++) A[j][k] += X[i][j] * X[i][k];
            }
        }
        for (let j = 0; j < p; j++) { A[j][j] += lambda[j]; b[j] += lambda[j] * beta0[j]; }
        const beta = beta0.slice();
        for (let sweep = 0; sweep < 2000; sweep++) {
            let delta = 0;
            for (let j = 0; j < p; j++) {
                if (A[j][j] <= 0) continue;
                let s = b[j];
                for (let k = 0; k < p; k++) if (k !== j) s -= A[j][k] * beta[k];
                const nv = Math.min(hi[j], Math.max(lo[j], s / A[j][j]));
                delta = Math.max(delta, Math.abs(nv - beta[j]));
                beta[j] = nv;
            }
            if (delta < 1e-12) break;
        }
        return beta;
    },

    design(iv, rated) {
        if (iv.bikeL) return [iv.bikeL[0], iv.bikeL[1], iv.bikeL[2], iv.bikeL[3], iv.idleH * BikeFuel.idleLPerHour()];
        return [iv.shape[0] / rated, iv.shape[1] / rated, iv.shape[2] / rated, iv.shape[3] / rated, iv.idleH * IDLE_L_PER_HOUR];
    },

    refit() {
        const rated = this.rated();
        const all = this.intervals();
        const ivs = all.filter((iv) => iv.usable);
        const base = { intervals: all, usable: ivs.length, rated, beta: null, ready: false, mape: null, priorMape: null };
        if (this.bike()) base.baseline = BikeFuel.snap.key;
        if (ivs.length === 0) { this.fit = base; this.render(); return this.fit; }
        const X = ivs.map((iv) => this.design(iv, rated));
        const y = ivs.map((iv) => iv.litresAdj);
        const p = 5, beta0 = [1, 1, 1, 1, 1];
        const meanSq = new Array(p).fill(0);
        X.forEach((row) => row.forEach((v, j) => { meanSq[j] += (v * v) / X.length; }));
        const scale = Math.max(...meanSq, 1e-9);
        const lambda = meanSq.map((m) => this.PRIOR_WEIGHT * Math.max(m, 1e-3 * scale));
        const beta = this.solve(X, y, beta0, lambda, this.LO, this.HI);
        const pred = (row, bb) => row.reduce((a, v, j) => a + v * bb[j], 0);
        const mape = (bb) => X.reduce((a, row, i) => a + Math.abs(pred(row, bb) - y[i]) / y[i], 0) / X.length;
        const fitMape = mape(beta), priorMape = mape(beta0);
        this.fit = {
            ...base, beta, mape: fitMape, priorMape,
            ready: ivs.length >= this.MIN_INTERVALS && fitMape <= priorMape + 1e-9,
            fittedAt: Date.now()
        };
        this.render();
        return this.fit;
    },

    active() {
        if (!(this.state.enabled && this.fit && this.fit.ready && this.fit.beta)) return false;
        // a fit made on another baseline (bike added, changed or removed) waits for refit()
        return (this.fit.baseline || null) === (this.bike() ? BikeFuel.snap.key : null);
    },

    // Personal km/L at a moving speed, or null when the baseline applies.
    kmPerL(kmh, rated = this.rated()) {
        if (!this.active()) return null;
        const j = fuelBandIndex(kmh);
        return Math.max(1, this.baseKmPerL(kmh, rated) / this.fit.beta[j]);
    },
    idleLPerHour() { return this.active() ? this.baseIdle() * this.fit.beta[4] : this.baseIdle(); },
    // Reference km/L for the "efficient drive" comparison: the 40–60 band.
    efficientKmPerL(rated = this.rated()) {
        const ref = this.bike() ? BikeFuel.referenceKmPerL() : rated;
        return this.active() ? ref / this.fit.beta[1] : ref;
    },

    status() {
        const f = this.fit;
        const fullFills = this.state.fills.filter((x) => x.full).length;
        if (!f || f.intervals.length === 0) {
            return fullFills === 0
                ? "Log each fill-up (fill to full) and the app learns how your vehicle really burns fuel at each speed."
                : "One full tank logged. Drive with the app open, then log your next full fill-up.";
        }
        const need = Math.max(0, this.MIN_INTERVALS - f.usable);
        if (need > 0) return `${f.usable} of ${this.MIN_INTERVALS} full-to-full tanks recorded — ${need} more to go before your own curve is used.`;
        if (this.bike()) {
            if (!f.ready) return `Your fill-ups don't fit a personal curve better than your bike's physics yet (±${Math.round(f.mape * 100)}% vs ±${Math.round(f.priorMape * 100)}%), so the physics stays in use.`;
            if (!this.state.enabled) return `Your curve is ready (±${Math.round(f.mape * 100)}% on ${f.usable} tanks) but switched off.`;
            return `Using your curve — it matches your last ${f.usable} tanks within ±${Math.round(f.mape * 100)}% (your bike's physics alone: ±${Math.round(f.priorMape * 100)}%).`;
        }
        if (!f.ready) return `Your fill-ups don't fit a personal curve better than the generic one yet (±${Math.round(f.mape * 100)}% vs ±${Math.round(f.priorMape * 100)}%), so the generic curve stays in use.`;
        if (!this.state.enabled) return `Your curve is ready (±${Math.round(f.mape * 100)}% on ${f.usable} tanks) but switched off.`;
        return `Using your curve — it matches your last ${f.usable} tanks within ±${Math.round(f.mape * 100)}% (generic curve: ±${Math.round(f.priorMape * 100)}%).`;
    },

    render() {
        const st = $("fuel-curve-status");
        if (st) st.textContent = this.status();
        const tg = $("fuel-curve-toggle");
        if (tg) tg.checked = this.state.enabled;
        const bands = $("fuel-curve-bands");
        if (bands) {
            const rated = this.rated();
            const f = this.fit;
            if (f && f.beta) {
                const word = this.bike() ? "bike" : "generic";
                bands.innerHTML = FUEL_BANDS.map((b, j) => {
                    const gen = this.baseKmPerL(b.mid, rated);
                    const mine = gen / f.beta[j];
                    return `<div class="fc-band"><span class="fc-b-label">${b.label} km/h</span><span class="fc-b-val">${mine.toFixed(1)} km/L</span><span class="fc-b-gen">${word} ${gen.toFixed(1)}</span></div>`;
                }).join("") + `<div class="fc-band"><span class="fc-b-label">Idling</span><span class="fc-b-val">${(this.baseIdle() * f.beta[4]).toFixed(2)} L/h</span><span class="fc-b-gen">${word} ${this.baseIdle().toFixed(2)}</span></div>`;
                bands.style.display = "";
            } else { bands.innerHTML = ""; bands.style.display = "none"; }
        }
        const list = $("fillup-list");
        if (list) {
            const ivByTo = new Map((this.fit?.intervals || []).map((iv) => [iv.toTs, iv]));
            const fills = [...this.state.fills].sort((a, b) => b.ts - a.ts).slice(0, 8);
            list.innerHTML = "";
            fills.forEach((fl) => {
                const row = document.createElement("div");
                row.className = "fc-fill-row";
                const iv = ivByTo.get(fl.ts);
                const d = new Date(fl.ts);
                const when = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
                let note = fl.full ? "full" : "top-up";
                if (iv) note += iv.usable ? ` · ${iv.km.toFixed(0)} km · ${(iv.km / iv.litres).toFixed(1)} km/L` : ` · not used: ${iv.reason}`;
                row.innerHTML = `<span class="fc-fill-when">${escapeHTML(when)}</span><span class="fc-fill-l">${fl.litres.toFixed(2)} L</span><span class="fc-fill-note">${escapeHTML(note)}</span>`;
                const del = document.createElement("button");
                del.type = "button"; del.className = "fc-fill-del"; del.setAttribute("aria-label", "Remove this fill-up"); del.textContent = "✕";
                del.onclick = () => this.removeFill(fl.ts);
                row.appendChild(del);
                list.appendChild(row);
            });
        }
    },

    init() {
        this.load();
        const tg = $("fuel-curve-toggle");
        if (tg) tg.addEventListener("change", (e) => { this.state.enabled = e.target.checked; this.save(); this.render(); });
        const btn = $("fillup-log-btn");
        if (btn) btn.addEventListener("click", () => {
            const litres = parseFloat($("fillup-litres")?.value);
            const odo = parseFloat($("fillup-odo")?.value);
            const full = $("fillup-full") ? $("fillup-full").checked : true;
            const r = this.logFill({ litres, full, odometerKm: Number.isFinite(odo) ? odo : null });
            if (!r.ok) return showToast("Enter how many litres you put in.");
            if ($("fillup-litres")) $("fillup-litres").value = "";
            if ($("fillup-odo")) $("fillup-odo").value = "";
            showToast(full ? "⛽ Fill-up logged." : "⛽ Top-up logged — it counts toward the next full tank.");
        });
        const rb = $("fuel-curve-reset-btn");
        if (rb) rb.addEventListener("click", () => { this.reset(); showToast("Fuel curve cleared."); });
        this.refit();
    }
};

const SmartDrive = {
    isRecording: false,
    baseMileage: 18,
    speedHistory: [],
    trip: {
        active: false, startTime: 0, totalDist: 0, actualFuel: 0, maxSpeed: 0, sumSpeed: 0, ticks: 0,
        ranges: { efficient: 0, moderate: 0, inefficient: 0 },
        stoppedTimeSec: 0, points: [], lastPointTs: 0,
        idleSec: 0, idleFuelL: 0, bandKm: [0, 0, 0, 0], fitSeg: null
    },
    audioCtx: null, overlayTimer: null,
    lastAlertTime: 0, lastAlertTier: 0,     // escalation-safe cooldown state (Section 8)
    wakeLock: null,

    init() {
        const savedMil = localStorage.getItem("sd_mileage");
        if (savedMil) this.baseMileage = parseFloat(savedMil);
        const fiv = $("fuel-input-val");
        if (fiv) fiv.value = this.baseMileage;

        const savedRec = localStorage.getItem("sd_record");
        this.isRecording = savedRec === "1";
        const srt = $("speed-record-toggle");
        if (srt) srt.checked = this.isRecording;

        const sgc = $("speed-graph-canvas");
        if (sgc) sgc.style.display = this.isRecording ? "block" : "none";

        if (fiv) fiv.addEventListener("change", (e) => { this.baseMileage = parseFloat(e.target.value) || 18; localStorage.setItem("sd_mileage", this.baseMileage); this.shareMileage(); if (typeof FuelCurve !== "undefined") FuelCurve.refit(); });
        BikeFuel.init();
        this.renderFuelSource();
        if (srt) srt.addEventListener("change", (e) => { this.isRecording = e.target.checked; localStorage.setItem("sd_record", this.isRecording ? "1" : "0"); const sgc2 = $("speed-graph-canvas"); if (sgc2) sgc2.style.display = this.isRecording ? "block" : "none"; if (!this.isRecording) this.speedHistory = []; });

        const pob = $("profile-open-btn");
        if (pob) pob.addEventListener("click", () => safeShow("profile-settings-modal", "flex"));
        const csb = $("close-settings-btn");
        if (csb) csb.addEventListener("click", () => safeHide("profile-settings-modal"));
        const crb = $("close-results-btn");
        if (crb) crb.addEventListener("click", () => safeHide("results-panel"));

        document.addEventListener("click", () => {
            if (!this.audioCtx) { const AudioContext = window.AudioContext || window.webkitAudioContext; if (AudioContext) this.audioCtx = new AudioContext(); }
            if (this.audioCtx && this.audioCtx.state === "suspended") this.audioCtx.resume();
        }, { passive: true });
    },

    beep(freq, ms) {
        if (!this.audioCtx) return;
        try {
            if (this.audioCtx.state === "suspended") this.audioCtx.resume();
            const osc = this.audioCtx.createOscillator(), gain = this.audioCtx.createGain();
            osc.type = "square"; osc.frequency.value = freq; gain.gain.value = 0.15;
            osc.connect(gain); gain.connect(this.audioCtx.destination);
            osc.start(); osc.stop(this.audioCtx.currentTime + ms / 1000);
        } catch (e) { /* AudioContext can throw pre-gesture on some browsers — non-fatal */ }
    },

    triggerRedMap() {
        const overlay = $("speed-danger-overlay");
        if (overlay) {
            overlay.classList.add("active"); clearTimeout(this.overlayTimer);
            this.overlayTimer = setTimeout(() => overlay.classList.remove("active"), 10000);
        }
    },

    // km/L at 40–60 km/h: the bike's physics when the rider picked one in My
    // bike, else their typed figure, else 18 (unchanged for riders without a bike).
    ratedKmPerL() { return BikeFuel.active() ? BikeFuel.referenceKmPerL() : (this.baseMileage || 18); },

    // Settings: say where the fuel numbers come from; with a bike the km/L field shows (and is) the physics figure.
    renderFuelSource(share = false) {
        const fiv = $("fuel-input-val"), hint = $("fuel-source-hint"), status = $("bike-fuel-status");
        const bike = BikeFuel.active();
        if (fiv) {
            fiv.disabled = bike;
            fiv.value = bike ? BikeFuel.referenceKmPerL().toFixed(1) : this.baseMileage;
            fiv.title = bike ? "Set by your bike in My bike" : "";
        }
        const text = BikeFuel.describe();
        if (hint) { hint.textContent = text; hint.hidden = !text; }
        if (status) {
            const g = BikeFuel.garage();
            status.textContent = g ? (g.estimated ? `Typical ${g.title}` : g.title) : "No bike chosen: the fuel numbers use the km/L above.";
        }
        if (share) this.shareMileage();                   // the bike changed: meetups cost this rider's leg with it
    },

    // Tell the server this rider's stated km/L so the fuel-aware meetup can
    // cost THEIR leg with THEIR vehicle. null = never set: the server then
    // uses its default and names this rider as "assumed" in the result.
    // A bike chosen in My bike counts as stated (its physics figure).
    shareMileage() {
        let stated = null;
        try { stated = localStorage.getItem("sd_mileage") !== null ? this.baseMileage : null; } catch (e) { /* storage blocked */ }
        if (BikeFuel.active()) stated = BikeFuel.referenceKmPerL();
        const kmPerL = Number.isFinite(stated) && stated >= 1 && stated <= 100 ? stated : null;
        if (socket && socket.connected) socket.emit("setMileage", { kmPerL });
        if (typeof currentTrip !== "undefined" && currentTrip) updateTripPanel();   // my own row re-costs at once
    },

    async requestWakeLock() {
        try { if ("wakeLock" in navigator) this.wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { /* e.g. tab not visible — fine, not fatal */ }
    },
    releaseWakeLock() {
        try { if (this.wakeLock) { this.wakeLock.release(); this.wakeLock = null; } } catch (e) { /* ignore */ }
    },

    // --- Speed-alert v2: escalation-safe per-tier cooldown (Section 8) -----
    // The shipped build had one shared `lastAlertTime`: a 60 km/h alert could
    // suppress a 100 km/h critical alert 5s later, since the cooldown didn't
    // know the new alert was more severe. Fix: only a cooldown from an
    // EQUAL-OR-HIGHER tier blocks a new alert.
    checkSafetyLimits(speed, confidence) {
        // Road-limit-aware thresholds when OpenStreetMap knows this road's limit
        // (SpeedLimits); the original flat 60/80/100 ladder everywhere else.
        // Tighten-only: each level is the lower of the flat ladder and the
        // road-based level, and the message names whichever one is binding.
        const lim = typeof SpeedLimits !== "undefined" ? SpeedLimits.thresholds() : null;
        const FLAT = [60, 80, 100];
        const byRoad = lim ? [lim.t1, lim.t2, lim.t3] : null;
        const [t1, t2, t3] = FLAT.map((f, i) => (byRoad ? Math.min(f, byRoad[i]) : f));
        const roadBinding = (tierNo) => Boolean(byRoad && byRoad[tierNo - 1] <= FLAT[tierNo - 1]);
        const dial = $("speed-dial");
        if (dial) {
            if (speed > 3) {
                dial.style.display = "flex";
                const sn = $("speed-n"); if (sn) sn.textContent = Math.round(speed);
                dial.className = "speed-dial " + (speed >= t3 ? "danger" : (speed >= t2 ? "warn" : (lim && speed >= lim.t1 ? "over" : ""))) + (confidence < 0.6 ? " lowconf" : "");
            } else { dial.style.display = "none"; }
        }

        if (confidence < 0.4) return;                    // don't act on low-confidence data — display only, above

        const tier = speed >= t3 ? 3 : speed >= t2 ? 2 : speed >= t1 ? 1 : 0;
        if (tier === 0) { this.lastAlertTier = 0; return; }

        const now = Date.now();
        if (tier <= this.lastAlertTier && now - this.lastAlertTime < 15000) return;

        // Spoken cue (Phase 3): the rider shouldn't have to look down to learn
        // why the phone beeped (roadmap Section 25). On the flat ladder tier 1
        // stays silent (every 60 km/h crossing would train riders to ignore
        // voice); over a KNOWN posted limit it's worth one short sentence.
        const v = Math.round(speed);
        if (roadBinding(tier)) {
            const L = lim.limit;
            if (tier === 3) {
                showToast(`🚨 Far over the ${L} km/h limit — slow down!`, 5000);
                this.triggerRedMap();
                this.beep(800, 3000);
                islandShow({ id: "speed", kind: "speed-danger", title: "Slow down", sub: `Limit ${L} km/h here`, meta: `${v}`, ttl: 8000 });
                voiceAnnounce(`Slow down. The limit here is ${L}.`, { priority: 90, key: `speed-3-${L}`, cooldownMs: 15000, category: "speed", maxAgeMs: 4000 });
            } else if (tier === 2) {
                showToast(`⚠️ Over the ${L} km/h limit.`, 4000);
                this.beep(600, 400);
                islandShow({ id: "speed", kind: "speed-warn", title: "Speed check", sub: `Limit ${L} km/h here`, meta: `${v}`, ttl: 4500 });
                voiceAnnounce(`Speed check. Limit ${L}.`, { priority: 62, key: `speed-2-${L}`, cooldownMs: 15000, category: "speed", drivingOnly: true, maxAgeMs: 4000 });
            } else {
                showToast(`🔵 Speed limit ${L} km/h (OpenStreetMap).`, 3000);
                islandShow({ id: "speed", kind: "info", title: `Limit ${L}`, sub: "You're just over it", meta: `${v}`, ttl: 3000, haptic: false });
                voiceAnnounce(`Speed limit ${L}.`, { priority: 58, key: `speed-1-${L}`, cooldownMs: 60000, category: "speed", drivingOnly: true, maxAgeMs: 4000 });
            }
        } else if (tier === 3) {
            showToast("🚨 DANGER: Speed 100+ km/h! Slow Down!", 5000);
            this.triggerRedMap();
            this.beep(800, 3000);
            islandShow({ id: "speed", kind: "speed-danger", title: "Slow down", sub: "Over 100 km/h", meta: `${v}`, ttl: 8000 });
            voiceAnnounce("Slow down. You are over 100 kilometres per hour.", { priority: 90, key: "speed-3", cooldownMs: 15000, category: "speed", maxAgeMs: 4000 });
        } else if (tier === 2) {
            showToast("⚠️ WARNING: Crossing 80 km/h.", 4000);
            this.beep(600, 400);
            islandShow({ id: "speed", kind: "speed-warn", title: "Speed check", sub: "Over 80 km/h", meta: `${v}`, ttl: 4500 });
            voiceAnnounce("Speed check. Over 80.", { priority: 62, key: "speed-2", cooldownMs: 15000, category: "speed", drivingOnly: true, maxAgeMs: 4000 });
        } else {
            showToast("🟢 Alert: Speed above 60 km/h.", 3000);
            islandShow({ id: "speed", kind: "info", title: "Speed", sub: "Over 60 km/h", meta: `${v}`, ttl: 3000, haptic: false });
        }
        this.lastAlertTime = now;
        this.lastAlertTier = tier;
    },

    // `fix` is GpsFilter.assess()'s verdict for the real GPS fix from
    // startGPS(). Only an ACCEPTED fix reaches the average, the graph and the
    // trip stats; a rejected one only refreshes the dial (held speed, marked
    // low-confidence) so the rider can see the app isn't trusting it.
    tick(fix) {
        if (!fix) return;
        const smoothedSpeed = fix.smoothedKmh;
        const conf = fix.accepted ? fix.confidence : Math.min(fix.confidence, GpsFilter.GATE - 0.01);
        const dt = Number.isFinite(fix.dtSec) ? fix.dtSec : 1;
        const distKm = fix.distKm;
        const accuracyM = fix.accuracyM;

        const walking = typeof currentTravelMode !== "undefined" && currentTravelMode === "walk";
        if (!walking) this.checkSafetyLimits(smoothedSpeed, conf);

        // Low-confidence fixes don't get to shape the recorded graph either —
        // "feed it to the map for display, but don't let it drive an alert or
        // a graph point" (Section 14).
        if (!fix.accepted) return;                        // …nor the trip stats below
        if (this.isRecording) {
            this.speedHistory.push(smoothedSpeed);
            if (this.speedHistory.length > 120) this.speedHistory.shift();
            this.drawGraph();
        }

        if (!this.trip.active) return;

        this.trip.ticks += 1;
        if (distKm > 0) {
            this.trip.totalDist += distKm;
            this.trip.sumSpeed += smoothedSpeed;
            if (smoothedSpeed > this.trip.maxSpeed) this.trip.maxSpeed = smoothedSpeed;
            if (smoothedSpeed >= 40 && smoothedSpeed <= 60) this.trip.ranges.efficient++;
            else if (smoothedSpeed > 80) this.trip.ranges.inefficient++;
            else this.trip.ranges.moderate++;
        }

        // --- Fuel model v2: U-shaped curve + idle burn (Section 9) ---------
        // With a fitted personal curve (FuelCurve) the level of each speed
        // band and the idle rate are the rider's own; otherwise the generic
        // curve. Moving and idling fuel are tracked separately (Section 30 #16).
        // With a bike from My bike the baseline is its physics curve (BikeFuel);
        // an electric bike burns no fuel at all.
        const rated = this.baseMileage || 18;
        const electric = BikeFuel.status === "ev";
        const seg = this.ensureFitSegment();
        let fuelBurned = 0;
        if (smoothedSpeed > 3) {
            this.trip.stoppedTimeSec = 0;
            const personal = typeof FuelCurve !== "undefined" ? FuelCurve.kmPerL(smoothedSpeed, rated) : null;
            const currentEff = personal ?? (BikeFuel.active() ? BikeFuel.kmPerL(smoothedSpeed) : genericKmPerL(smoothedSpeed, rated));
            fuelBurned = distKm > 0 && !electric ? distKm / currentEff : 0;
            if (distKm > 0) {
                const j = fuelBandIndex(smoothedSpeed);
                this.trip.bandKm[j] += distKm;
                seg.bandKm[j] += distKm;
                seg.shape[j] += distKm / fuelShape(smoothedSpeed);
                seg.hist[speedBin(smoothedSpeed)] += distKm;
                seg.km += distKm;
            }
        } else if (this.trip.active) {
            // Idling engine still burns fuel — the original model silently
            // credited a stop with zero consumption.
            this.trip.stoppedTimeSec += dt;
            if (this.trip.stoppedTimeSec < IDLE_CUTOFF_SEC && !electric) {
                const idleRate = typeof FuelCurve !== "undefined" ? FuelCurve.idleLPerHour() : IDLE_L_PER_HOUR;
                fuelBurned = idleRate * (dt / 3600);
                this.trip.idleSec += dt;
                this.trip.idleFuelL += fuelBurned;
                seg.idleH += dt / 3600;
            }
        }
        this.trip.actualFuel += fuelBurned;

        // Downsampled point log for Section 13's trip analytics — ~1 point/5s
        // even if ticks arrive faster, so a 2h ride is ~1,440 points, not 7,200.
        const nowTs = Date.now();
        if (myCoords && (nowTs - this.trip.lastPointTs >= 5000 || this.trip.points.length === 0)) {
            this.trip.points.push({ ts: nowTs, lat: myCoords.lat, lng: myCoords.lng, speedKmh: Math.round(smoothedSpeed * 10) / 10, accuracy: accuracyM ?? null });
            this.trip.lastPointTs = nowTs;
            if (this.trip.points.length > 2000) this.trip.points.shift();
        }
    },

    drawGraph() {
        const cvs = $("speed-graph-canvas"); if (!cvs || !this.isRecording) return;
        const ctx = cvs.getContext("2d"); const w = cvs.width = cvs.offsetWidth, h = cvs.height = cvs.offsetHeight;
        ctx.clearRect(0, 0, w, h);
        if (this.speedHistory.length < 2) return;
        const max = Math.max(60, ...this.speedHistory);
        ctx.beginPath(); ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 2;
        this.speedHistory.forEach((v, i) => {
            const x = (i / (this.speedHistory.length - 1)) * w; const y = h - (v / max) * h * 0.8;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
    },

    // The part of the current drive not yet handed to FuelCurve. A fill-up
    // logged mid-drive closes it (flushFitSegment) so the litres pumped are
    // matched with the driving that actually emptied that tank.
    ensureFitSegment() {
        if (!this.trip.fitSeg) this.trip.fitSeg = { startedAt: Date.now(), shape: [0, 0, 0, 0], bandKm: [0, 0, 0, 0], hist: new Array(SPEED_BINS).fill(0), idleH: 0, km: 0 };
        if (!Array.isArray(this.trip.fitSeg.hist)) this.trip.fitSeg.hist = new Array(SPEED_BINS).fill(0);     // a drive restored from an older backup
        if (!Array.isArray(this.trip.bandKm)) this.trip.bandKm = [0, 0, 0, 0];
        return this.trip.fitSeg;
    },
    flushFitSegment(endedAt = Date.now()) {
        const seg = this.trip.fitSeg;
        this.trip.fitSeg = null;
        if (!seg) return;
        const mode = (typeof currentTravelMode !== "undefined" && currentTravelMode) || "drive";
        if (mode === "walk") return;                      // walking burns no fuel; keep it out of the vehicle's curve
        if (BikeFuel.status === "ev") return;             // nor does an electric bike
        if (typeof FuelCurve !== "undefined") FuelCurve.recordTrip({ ...seg, endedAt });
    },

    startTrip() {
        const saved = tripDbRestoreTrip();                // fixed: TripDB has no restoreTrip(), read via restoreAll()
        const fresh = { stoppedTimeSec: 0, points: [], lastPointTs: 0, idleSec: 0, idleFuelL: 0, bandKm: [0, 0, 0, 0], fitSeg: null };
        if (saved && saved.active) {
            this.trip = { ...fresh, ...saved };
            console.log("[SmartDrive] Recovered an in-progress trip from local backup.");
        } else {
            this.trip = {
                active: true, startTime: Date.now(), totalDist: 0, actualFuel: 0, maxSpeed: 0, sumSpeed: 0, ticks: 0,
                ranges: { efficient: 0, moderate: 0, inefficient: 0 }, ...fresh
            };
        }
        GpsFilter.reset();
        this.lastAlertTier = 0;
        if (typeof TripDB !== "undefined") TripDB.startAutoSave(this.trip);
        this.requestWakeLock();
        const mode = (typeof currentTravelMode !== "undefined" && currentTravelMode) || "drive";
        socket.emit("startSession", { mode: mode === "car" ? "drive" : mode });
        emitDriveState();
    },

    endTrip() {
        if (!this.trip.active) return;
        this.trip.active = false;
        this.releaseWakeLock();
        if (typeof TripDB !== "undefined") TripDB.clearBackup();
        socket.emit("endSession");

        const avg = this.trip.ticks > 0 ? this.trip.sumSpeed / this.trip.ticks : 0;
        const personal = typeof FuelCurve !== "undefined" && FuelCurve.active();
        // Reference economy = the 40–60 band: the stated km/L, or the rider's
        // own measured 40–60 figure once their fuel curve is in use.
        const rated = personal ? FuelCurve.efficientKmPerL(this.baseMileage || 18) : this.ratedKmPerL();
        const bike = BikeFuel.active();
        this.flushFitSegment(Date.now());                 // this drive now counts toward the next full tank

        // "What if you'd driven efficiently the whole way" comparison (Section 9.2) —
        // labeled plainly as an estimate, not measured fuel.
        const potentialFuelL = this.trip.totalDist / rated;
        const extraFuelL = Math.max(0, this.trip.actualFuel - potentialFuelL);
        // Roadmap Section 9: extraDistanceKm = actualFuel · rated − totalDist —
        // how much further that fuel would have taken you at 40–60 km/h.
        const extraDistanceKm = Math.max(0, this.trip.actualFuel * rated - this.trip.totalDist);
        const idleFuelL = this.trip.idleFuelL || 0;
        const idleMin = (this.trip.idleSec || 0) / 60;
        const movingFuelL = Math.max(0, this.trip.actualFuel - idleFuelL);

        const rd = $("res-dist"); if (rd) rd.textContent = this.trip.totalDist.toFixed(2) + " km";
        const ras = $("res-avg-speed"); if (ras) ras.textContent = Math.round(avg) + " km/h";
        const rms = $("res-max-speed"); if (rms) rms.textContent = Math.round(this.trip.maxSpeed) + " km/h";
        const ret = $("res-eff-time"); if (ret) ret.textContent = Math.round(this.trip.ranges.efficient / 60) + " min";
        const rit = $("res-ineff-time"); if (rit) rit.textContent = Math.round(this.trip.ranges.inefficient / 60) + " min";
        const rbm = $("res-base-mlg"); if (rbm) rbm.textContent = (personal || bike ? rated.toFixed(1) : rated) + " km/L";
        const raf = $("res-actual-fuel"); if (raf) raf.textContent = this.trip.actualFuel.toFixed(2) + " L";
        const rmv = $("res-moving-fuel"); if (rmv) rmv.textContent = movingFuelL.toFixed(2) + " L";
        const rid = $("res-idle-fuel");
        if (rid) {
            const idleRate = personal ? FuelCurve.idleLPerHour() : IDLE_L_PER_HOUR;
            rid.textContent = idleMin >= 0.5
                ? `${idleFuelL.toFixed(2)} L · ${Math.round(idleMin)} min`
                : "none";
            rid.title = `Idling counted at ${idleRate.toFixed(2)} L/h (${personal ? "learned from your fill-ups" : "assumed"}) for stops up to ${IDLE_CUTOFF_SEC / 60} min — longer stops count as engine off.`;
        }
        const rex = $("res-extra-fuel");
        if (rex) rex.textContent = extraFuelL > 0.01
            ? `~${extraFuelL.toFixed(2)} L more than an efficient drive (est.) — enough for ~${extraDistanceKm.toFixed(1)} km more at 40–60 km/h.`
            : "Right around an efficient drive — nice.";
        const rmn = $("res-model-note");
        if (rmn) rmn.textContent = BikeFuel.status === "ev"
            ? `Your ${BikeFuel.snap.title} is electric: no fuel counted. Its energy use is in My bike.`
            : personal
                ? `Using your own fuel curve, learned from ${FuelCurve.fit.usable} full tanks (±${Math.round(FuelCurve.fit.mape * 100)}%)${bike ? ` on top of your ${BikeFuel.snap.title}'s physics` : ""}.`
                : bike
                    ? `Physics of your ${BikeFuel.snap.title} (My bike) at each speed on a flat road; idling ${BikeFuel.idleLPerHour().toFixed(2)} L/h. Stops, hills and wind use more: log fill-ups in Settings and it learns your real riding.`
                    : `Generic fuel curve from your ${this.baseMileage || 18} km/L setting; idling assumed at ${IDLE_L_PER_HOUR} L/h. Log fill-ups in Settings to learn your own.`;
        safeShow("results-panel", "flex");

        // Close the loop with the persistence layer — one compact record per
        // trip, not a stream per tick (Section 13). Phase 3: routed through
        // TripAnalytics' localStorage-backed queue, so a ride that ends in a
        // dead zone is saved once the socket is back and verified, instead
        // of being lost in a buffered emit that dies with the tab.
        if (this.trip.totalDist > 0.05) {
            const travelMode = (typeof currentTravelMode !== "undefined" && currentTravelMode) || "drive";
            TripAnalytics.submitFinishedTrip({
                name: cityName ? `Ride near ${cityName}` : "Ride",
                mode: travelMode === "car" ? "drive" : travelMode,
                startedAt: this.trip.startTime, endedAt: Date.now(),
                totalDistKm: this.trip.totalDist, avgSpeed: avg, maxSpeed: this.trip.maxSpeed,
                fuelUsedL: this.trip.actualFuel, idleFuelL, idleMin, points: this.trip.points
            });
        }
        emitDriveState();
    }
};

// TripDB (features.js) only exposes restoreAll() -> {username, nav, trip, group}.
// The shipped app.js called TripDB.restoreTrip()/restoreNavState(), which don't
// exist and threw. These two helpers read the SAME backing store correctly.
function tripDbRestoreTrip() {
    if (typeof TripDB === "undefined" || typeof TripDB.restoreAll !== "function") return null;
    try { return TripDB.restoreAll()?.trip || null; } catch { return null; }
}
function tripDbRestoreNav() {
    if (typeof TripDB === "undefined" || typeof TripDB.restoreAll !== "function") return null;
    try { return TripDB.restoreAll()?.nav || null; } catch { return null; }
}
