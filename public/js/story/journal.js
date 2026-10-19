// @ts-check
/* ============================================================================
   MapUnite Ride Story — the ride journal (what happened WHERE on a ride)
   ==============================================================================
   createJournal(physics, model, opts).push(fix, state) … .finish() → journal

   The HUD's live estimator (js/hud/live.js) keeps trip TOTALS. The journal sits
   next to it and keeps the shape of the ride, from the same numbers:
     - stretches of ~250 m: fuel (the estimator's own, so the parts add up to the
       trip), the best the bike could have done there (its eco band on that
       grade), time, climb, speed, time above the eco band, hard moments;
     - stops: every halt of 10 s or more, where and how long;
     - hard braking and hard acceleration: where, and from what speed (the
       estimator decides what is "hard": < −3.5 / > 2.5 m/s² held 1 s);
     - where the push at the wheel went: air, rolling, climbing, speeding up
       (road-load physics with the bike's own CdA, Crr and the real masses), and
       what the wind did (Open-Meteo wind at 10 m, brought down to ~1 m above
       the road by the log-law with z0 = 0.1 m: × 0.5);
     - weather samples (the app fetches them; journal.weather(sample));
     - the route, one point every ~40 m.
   Pure, strict SI (m, s, m/s, m³, J, kg, K, Pa). Nothing here is sent anywhere.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUStory || (/** @type {any} */ (root).MUStory = {}); ns.journal = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const JOURNAL_DEFAULTS = Object.freeze({
        step: 250,              // m per stretch while riding (merged down at the end)
        maxStretches: 96,
        maxGap: 5,              // s: no integration across a longer gap (same as the estimator)
        moving: 0.8,            // m/s
        stopMin: 10,            // s standing still before it counts as a stop
        restMin: 120,           // s: a stop this long is a break, shorter is traffic
        routeEvery: 40,         // m between route points
        maxRoute: 400,
        maxEvents: 80,
        windHeight: 0.5,        // log-law: ln(1 m / 0.1 m) ÷ ln(10 m / 0.1 m)
        overLimit: 5 / 3.6      // m/s over the posted limit before it counts
    });
    const RAD = Math.PI / 180, R = 6371008.8;
    const fin = (x) => typeof x === "number" && Number.isFinite(x);

    /** @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 */
    function metres(lat1, lng1, lat2, lng2) {
        const x = (lng2 - lng1) * RAD * Math.cos(((lat1 + lat2) / 2) * RAD), y = (lat2 - lat1) * RAD;
        return Math.hypot(x, y) * R;
    }
    /** Bearing from 1 to 2, degrees clockwise from north. */
    function bearing(lat1, lng1, lat2, lng2) {
        const y = Math.sin((lng2 - lng1) * RAD) * Math.cos(lat2 * RAD);
        const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lng2 - lng1) * RAD);
        return ((Math.atan2(y, x) / RAD) + 360) % 360;
    }
    /**
     * The wind's push against the rider, m/s (+ headwind, − tailwind).
     * @param {number} speed10 wind at 10 m, m/s @param {number} fromDeg where it blows FROM @param {number} headingDeg where the bike goes
     */
    function headwind(speed10, fromDeg, headingDeg, k = JOURNAL_DEFAULTS.windHeight) {
        return speed10 * k * Math.cos((fromDeg - headingDeg) * RAD);
    }

    function newStretch(s0) {
        return { s0, d: 0, e: 0, ideal: 0, time: 0, moving: 0, vmax: 0, climb: 0, desc: 0, above: 0, accelT: 0, idle: 0, idleOn: 0, idleE: 0, brakes: 0, pulls: 0, lat: null, lng: null };
    }

    /**
     * @param {any} physics MUPhysics
     * @param {any} model   BikeModel (the HUD's)
     * @param {{ altitude?: number, step?: number }} [o]
     */
    function createJournal(physics, model, o = {}) {
        const D = JOURNAL_DEFAULTS;
        const step = fin(o.step) && /** @type {number} */ (o.step) > 0 ? /** @type {number} */ (o.step) : D.step;
        const altitude = fin(o.altitude) ? /** @type {number} */ (o.altitude) : 0;
        const P = model && model.params ? model.params : {};
        const mean = (k, f) => (P[k] && fin(P[k].mean) ? P[k].mean : f);
        const cda = mean("cda", 0.6), crr = mean("crr", 0.02), riderMass = mean("riderMass", 72);
        const mass = (fin(model && model.massFixed) ? model.massFixed : 150) + riderMass;
        const rl = physics && physics.roadload && physics.roadload.roadLoad ? physics.roadload.roadLoad : physics.roadLoad;
        const rhoStd = physics.airDensityAt({ altitude });

        const stretches = [], stops = [], brakes = [], pulls = [], weather = [], route = [];
        let cur = newStretch(0);
        let last = null, lastS = null;
        let heading = null, routeAcc = 0, travelled = 0;
        let stopAt = null;                               // { t, lat, lng } while standing
        let startedAt = null, endedAt = null, start = null, end = null;
        const work = { air: 0, rolling: 0, climb: 0, accel: 0, wind: 0, airCalm: 0 };
        let windHead = 0, windMetres = 0, rhoSum = 0, rhoMetres = 0;   // distance-weighted headwind and air density
        let top = { v: 0, s: 0, lat: null, lng: null };
        let overLimitT = 0, limitT = 0, bandD = 0, bandKnownD = 0;
        let run = { t: 0, d: 0, from: null }, best = { t: 0, d: 0, from: null, to: null };
        const recentV = [];

        function wx() { return weather.length ? weather[weather.length - 1] : null; }
        function rho() {
            const w = wx();
            if (!w || !fin(w.tempK)) return rhoStd;
            try {
                return physics.airDensityAt({ altitude, temperature: w.tempK, pressure: fin(w.pressurePa) && w.pressurePa > 30000 ? w.pressurePa : undefined, relativeHumidity: fin(w.rh) ? Math.max(0, Math.min(1, w.rh)) : 0 });
            } catch (e) { return rhoStd; }
        }
        function closeStretch() {
            if (cur.d <= 0 && cur.time <= 0) return;
            stretches.push(cur);
            cur = newStretch(travelled);
        }
        function endRun(t) {
            if (run.t > best.t) best = { t: run.t, d: run.d, from: run.from, to: t };
            run = { t: 0, d: 0, from: null };
        }

        /**
         * @param {{ t: number, lat?: number, lng?: number, v?: number|null, accepted?: boolean }} f
         * @param {any} s the estimator's state right after it took this fix
         */
        function push(f, s) {
            if (!f || f.accepted === false || !fin(f.t) || !s || !s.trip) return;
            const t = f.t / 1000;
            const hasPos = fin(f.lat) && fin(f.lng);
            const v = fin(s.v) ? s.v : 0;
            if (startedAt === null) startedAt = f.t;
            endedAt = f.t;
            if (hasPos && !start) start = { lat: f.lat, lng: f.lng, t: f.t };
            if (hasPos) end = { lat: f.lat, lng: f.lng, t: f.t };
            const dtRaw = last ? t - last.t : 0;
            const dt = dtRaw > 0 && dtRaw <= D.maxGap ? dtRaw : 0;
            const dE = lastS ? Math.max(-1, s.trip.energy - lastS.energy) : 0;
            const dD = lastS ? Math.max(0, s.trip.distance - lastS.distance) : 0;
            // heading from the positions (≥ 3 m apart)
            if (hasPos && last && last.lat !== null) {
                const m = metres(last.lat, last.lng, f.lat, f.lng);
                if (m >= 3) heading = bearing(last.lat, last.lng, f.lat, f.lng);
            }
            recentV.push({ t, v });
            while (recentV.length && t - recentV[0].t > 5) recentV.shift();

            // stops
            if (v < D.moving) {
                if (!stopAt) stopAt = { t: f.t, lat: hasPos ? f.lat : (end ? end.lat : null), lng: hasPos ? f.lng : (end ? end.lng : null), km: travelled };
            } else if (stopAt) {
                const dur = (f.t - stopAt.t) / 1000;
                if (dur >= D.stopMin) {
                    if (stops.length < D.maxEvents) stops.push({ t: stopAt.t, dur, lat: stopAt.lat, lng: stopAt.lng, s: stopAt.km, rest: dur >= D.restMin });
                    if (dur >= D.restMin) endRun(stopAt.t);
                }
                stopAt = null;
            }

            // hard moments (the estimator's counters went up)
            const hb = s.trip.harsh ? s.trip.harsh.brake : 0, ha = s.trip.harsh ? s.trip.harsh.accel : 0;
            const vFrom = recentV.reduce((m, x) => Math.max(m, x.v), 0);
            if (lastS && hb > lastS.brake) { cur.brakes++; if (brakes.length < D.maxEvents) brakes.push({ t: f.t, lat: hasPos ? f.lat : null, lng: hasPos ? f.lng : null, s: travelled, from: vFrom }); }
            if (lastS && ha > lastS.accel) { cur.pulls++; if (pulls.length < D.maxEvents) pulls.push({ t: f.t, lat: hasPos ? f.lat : null, lng: hasPos ? f.lng : null, s: travelled }); }

            if (dt > 0) {
                cur.time += dt; cur.e += dE; cur.d += dD; travelled += dD;
                const g = fin(s.grade) ? s.grade : 0;
                if (v >= D.moving) {
                    cur.moving += dt;
                    if (!run.from) run.from = f.t;
                    run.t += dt; run.d += dD;
                    if (g > 0) cur.climb += g * dD; else cur.desc += -g * dD;
                    if (s.mode === "accel") cur.accelT += dt;
                    if (s.eco && fin(s.eco.bestPm)) { cur.ideal += s.eco.bestPm * dD; bandKnownD += dD; if (s.eco.inBand) bandD += dD; if (s.eco.above) cur.above += dt; }
                    else cur.ideal += Math.max(0, dE);
                    if (fin(s.limit) && s.limit > 0) { limitT += dt; if (v > s.limit + D.overLimit) overLimitT += dt; }
                    // where the push went
                    const w = wx();
                    const hw = w && fin(w.windMs) && fin(w.windFrom) && heading !== null ? headwind(w.windMs, w.windFrom, heading) : 0;
                    const r = rho();
                    const a = fin(s.a) ? s.a : 0;
                    const L = rl({ mass, v, grade: g, cda, crr, rho: r, wind: hw, accel: a });
                    const calm = 0.5 * r * cda * v * v;
                    work.rolling += Math.max(0, L.rolling) * dD;
                    work.air += Math.max(0, L.aero) * dD;
                    work.airCalm += calm * dD;
                    work.wind += (L.aero - calm) * dD;
                    work.climb += Math.max(0, L.gravity) * dD;
                    work.accel += Math.max(0, L.inertia) * dD;
                    if (w && fin(w.windMs)) { windHead += hw * dD; windMetres += dD; }
                    rhoSum += r * dD; rhoMetres += dD;
                } else { cur.idle += dt; cur.idleE += Math.max(0, dE); if (dE > 0) cur.idleOn += dt; }   // idleOn: the engine still running (the estimator stops it after 3 min)
                if (v > cur.vmax) cur.vmax = v;
                if (v > top.v) top = { v, s: travelled, lat: hasPos ? f.lat : null, lng: hasPos ? f.lng : null };
                if (hasPos) { routeAcc += dD; if (!route.length || routeAcc >= D.routeEvery) { route.push([Math.round(f.lat * 1e5) / 1e5, Math.round(f.lng * 1e5) / 1e5]); routeAcc = 0; } cur.lat = f.lat; cur.lng = f.lng; }
                if (cur.d >= step) closeStretch();
            } else if (hasPos && !route.length) route.push([Math.round(f.lat * 1e5) / 1e5, Math.round(f.lng * 1e5) / 1e5]);
            last = { t, lat: hasPos ? f.lat : (last ? last.lat : null), lng: hasPos ? f.lng : (last ? last.lng : null) };
            lastS = { energy: s.trip.energy, distance: s.trip.distance, brake: hb, accel: ha };
        }

        /** A weather sample: { t, tempK, rh (0–1), pressurePa, windMs (10 m), windFrom (deg), code (WMO), precipMm } */
        function addWeather(w) {
            if (!w || !fin(w.t)) return;
            if (weather.length >= 48) weather.shift();
            weather.push({ t: w.t, tempK: fin(w.tempK) ? w.tempK : null, rh: fin(w.rh) ? w.rh : null, pressurePa: fin(w.pressurePa) ? w.pressurePa : null, windMs: fin(w.windMs) ? w.windMs : null, windFrom: fin(w.windFrom) ? w.windFrom : null, code: fin(w.code) ? w.code : null, precipMm: fin(w.precipMm) ? w.precipMm : null });
        }

        /** Two neighbours at a time until there are few enough. */
        function merged() {
            let list = stretches.slice();
            if (cur.d > 0 || cur.time > 0) list.push({ ...cur });
            while (list.length > D.maxStretches) {
                const out = [];
                for (let i = 0; i < list.length; i += 2) {
                    const a = list[i], b = list[i + 1];
                    if (!b) { out.push(a); continue; }
                    out.push({ s0: a.s0, d: a.d + b.d, e: a.e + b.e, ideal: a.ideal + b.ideal, time: a.time + b.time, moving: a.moving + b.moving, vmax: Math.max(a.vmax, b.vmax), climb: a.climb + b.climb, desc: a.desc + b.desc, above: a.above + b.above, accelT: a.accelT + b.accelT, idle: a.idle + b.idle, idleOn: a.idleOn + b.idleOn, idleE: a.idleE + b.idleE, brakes: a.brakes + b.brakes, pulls: a.pulls + b.pulls, lat: b.lat ?? a.lat, lng: b.lng ?? a.lng });
                }
                list = out;
            }
            return list;
        }

        /** The journal so far (the ride's end calls it once). */
        function finish() {
            const t = endedAt;
            if (stopAt && t !== null) {
                const dur = (t - stopAt.t) / 1000;
                if (dur >= D.stopMin && stops.length < D.maxEvents) stops.push({ t: stopAt.t, dur, lat: stopAt.lat, lng: stopAt.lng, s: stopAt.km, rest: dur >= D.restMin, last: true });
            }
            endRun(t);
            let rt = route.slice();
            if (end && (!rt.length || rt[rt.length - 1][0] !== Math.round(end.lat * 1e5) / 1e5)) rt.push([Math.round(end.lat * 1e5) / 1e5, Math.round(end.lng * 1e5) / 1e5]);
            if (rt.length > D.maxRoute) { const k = rt.length / D.maxRoute; rt = Array.from({ length: D.maxRoute }, (_, i) => rt[Math.min(rt.length - 1, Math.round(i * k))]); rt[rt.length - 1] = route[route.length - 1] || rt[rt.length - 1]; }
            return {
                v: 1, startedAt, endedAt, start, end, distance: travelled,
                stretches: merged(), stops, brakes, pulls, weather, route: rt,
                work: { ...work }, headwind: windMetres > 0 ? windHead / windMetres : null, rho: rhoMetres > 0 ? rhoSum / rhoMetres : null, top: top.v > 0 ? top : null,
                band: bandKnownD > 0 ? { share: bandD / bandKnownD, known: bandKnownD } : null,
                limit: limitT > 0 ? { overShare: overLimitT / limitT, over: overLimitT, known: limitT } : null,
                longestRun: best.t > 0 ? best : null,
                physics: { mass, riderMass, vehicleMass: fin(model && model.vehicleMass) ? model.vehicleMass : null, extraMass: fin(model && model.massFixed) && fin(model && model.vehicleMass) ? model.massFixed - model.vehicleMass : null, cda, crr, rhoStd }
            };
        }

        return { push, weather: addWeather, finish, get distance() { return travelled; } };
    }

    return { JOURNAL_DEFAULTS, createJournal, headwind, bearing, metres };
});
