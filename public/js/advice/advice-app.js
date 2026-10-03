// @ts-check
/* ============================================================================
   MapUnite advice — wiring the safety gate into the ride (roadmap Step 8)
   ==============================================================================
   SmartDrive.tick() calls onTick(fix) for every GPS verdict. This feeds the gate
   (js/advice/advice.js) with:
     - speed and fix quality       the GPS verdict (smoothed speed, accepted, accuracy)
     - heading rate                bearing between consecutive accepted fixes
     - gyroscope                   |rotation rate| from devicemotion, low-passed over
                                   ~0.5 s; listened to only while riding (on iOS only
                                   once motion access was granted, e.g. by tunnel mode)
     - the route ahead             navState.routePath: curvature here, tightest bend ahead
     - the next turn               navState.nextManeuverM
     - wet road                    the Open-Meteo weather code core.js already fetches
     - quiet ride                  the rider's switch (setQuiet, "quiet ride" by voice)
   and, when the gate is "ready", speaks economy advice through VoiceAssistant:
   priority 30 (below every navigation, convoy and safety cue), category "advice",
   driving only, dropped if anything else is speaking or queued, stale after 3 s.
   Advice needs the rider's bike (My bike): its physics eco band and km/L (or the
   fuel learner's own curve on top of it). Without a bike it stays silent — the
   generic curve isn't good enough to advise on. The target speed is never above
   the posted limit (SpeedLimits); over the limit it says nothing.
   ============================================================================ */
(function (root) {
    "use strict";
    const W = /** @type {any} */ (root);
    if (!W.document) return;
    const QUIET_KEY = "mu_quiet_ride";
    const WEATHER_MAX_AGE = 3600 * 1000;
    const core = () => (W.MUAdvice && W.MUAdvice.core) || null;

    /** classic-script lexicals (core.js, smartdrive.js, gps.js …) are read by name */
    function g() {
        /** @type {any} */ const o = {};
        // @ts-ignore
        try { o.SmartDrive = typeof SmartDrive !== "undefined" ? SmartDrive : null; } catch { o.SmartDrive = null; }
        // @ts-ignore
        try { o.BikeFuel = typeof BikeFuel !== "undefined" ? BikeFuel : null; } catch { o.BikeFuel = null; }
        // @ts-ignore
        try { o.FuelCurve = typeof FuelCurve !== "undefined" ? FuelCurve : null; } catch { o.FuelCurve = null; }
        // @ts-ignore
        try { o.SpeedLimits = typeof SpeedLimits !== "undefined" ? SpeedLimits : null; } catch { o.SpeedLimits = null; }
        // @ts-ignore
        try { o.navState = typeof navState !== "undefined" ? navState : null; } catch { o.navState = null; }
        // @ts-ignore
        try { o.myCoords = typeof myCoords !== "undefined" ? myCoords : null; } catch { o.myCoords = null; }
        // @ts-ignore
        try { o.weatherCode = typeof myWeatherCode !== "undefined" ? myWeatherCode : null; o.weatherAt = typeof myWeatherCodeAt !== "undefined" ? myWeatherCodeAt : 0; } catch { o.weatherCode = null; o.weatherAt = 0; }
        // @ts-ignore
        try { o.mode = typeof currentTravelMode !== "undefined" ? currentTravelMode : "bike"; } catch { o.mode = "bike"; }
        // @ts-ignore
        try { o.voiceAnnounce = typeof voiceAnnounce === "function" ? voiceAnnounce : null; } catch { o.voiceAnnounce = null; }
        return o;
    }

    let gate = null, last = null, lastPos = null, quiet = readQuiet();
    let gyro = { rate: null, at: 0, listening: false, handler: /** @type {any} */ (null) };

    function readQuiet() { try { return localStorage.getItem(QUIET_KEY) === "1"; } catch { return false; } }
    /** @param {boolean} on */
    function setQuiet(on) {
        quiet = !!on;
        try { if (quiet) localStorage.setItem(QUIET_KEY, "1"); else localStorage.removeItem(QUIET_KEY); } catch { /* storage blocked */ }
        document.dispatchEvent(new CustomEvent("mu:advice-quiet", { detail: { quiet } }));
    }

    // ---------------------------------------------------------------- gyroscope, only while riding
    function listenGyro(on) {
        if (on && !gyro.listening && typeof W.DeviceMotionEvent !== "undefined") {
            gyro.handler = (/** @type {any} */ e) => {
                const r = e.rotationRate;
                if (!r || !Number.isFinite(r.alpha) && !Number.isFinite(r.beta) && !Number.isFinite(r.gamma)) return;
                const mag = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0) * Math.PI / 180;     // deg/s → rad/s
                const now = Date.now(), dt = gyro.at ? Math.min(1, (now - gyro.at) / 1000) : 0.05;
                const k = 1 - Math.exp(-dt / 0.5);                                                   // ~0.5 s low-pass: bumps aren't corners
                gyro.rate = gyro.rate === null ? mag : gyro.rate + k * (mag - gyro.rate);
                gyro.at = now;
            };
            W.addEventListener("devicemotion", gyro.handler);
            gyro.listening = true;
        } else if (!on && gyro.listening) {
            W.removeEventListener("devicemotion", gyro.handler);
            gyro = { rate: null, at: 0, listening: false, handler: null };
        }
    }

    function bearing(/** @type {number} */ lat1, /** @type {number} */ lng1, /** @type {number} */ lat2, /** @type {number} */ lng2) {
        const R = Math.PI / 180, y = Math.sin((lng2 - lng1) * R) * Math.cos(lat2 * R);
        const x = Math.cos(lat1 * R) * Math.sin(lat2 * R) - Math.sin(lat1 * R) * Math.cos(lat2 * R) * Math.cos((lng2 - lng1) * R);
        return Math.atan2(y, x);
    }

    /**
     * One GPS verdict (GpsFilter.assess) from SmartDrive.tick.
     * @param {{ smoothedKmh: number, accepted: boolean, accuracyM?: number|null }} fix
     */
    function onTick(fix) {
        const C = core();
        if (!C || !fix) return null;
        const G = g();
        const riding = Boolean(G.SmartDrive && G.SmartDrive.trip && G.SmartDrive.trip.active) && G.mode !== "walk";
        listenGyro(riding);
        if (!gate) gate = C.createGateState();
        const t = Date.now() / 1000, v = (Number(fix.smoothedKmh) || 0) / 3.6;
        // a new heading each time the rider is ≥ 20 m from the last anchor (shorter
        // baselines turn GPS scatter into fake corners); null in between
        let heading = null;
        const pos = G.myCoords;
        if (fix.accepted && pos && Number.isFinite(pos.lat)) {
            if (lastPos) {
                const kx = 111320 * Math.cos(pos.lat * Math.PI / 180);
                const d = Math.hypot((pos.lng - lastPos.lng) * kx, (pos.lat - lastPos.lat) * 110540);
                if (d >= 20) { heading = bearing(lastPos.lat, lastPos.lng, pos.lat, pos.lng); lastPos = { lat: pos.lat, lng: pos.lng }; }
            } else lastPos = { lat: pos.lat, lng: pos.lng };
        }
        // the planned route around and ahead of the rider
        let curvatureHere = null, radiusAhead = null;
        const nav = G.navState;
        if (nav && nav.active && Array.isArray(nav.routePath) && pos) {
            const rc = C.routeCurvature(nav.routePath, pos.lat, pos.lng, Math.max(C.GATE.lookaheadMin, C.GATE.lookaheadTime * v));
            curvatureHere = rc.curvatureHere; radiusAhead = rc.radiusAhead;
        }
        const wet = G.weatherCode !== null && Date.now() - G.weatherAt < WEATHER_MAX_AGE ? C.isWetWeather(G.weatherCode) : null;
        const gyroRate = gyro.rate !== null && Date.now() - gyro.at < 2000 ? gyro.rate : null;
        last = C.evaluateGate(gate, {
            t, v, gpsOk: !!fix.accepted, accuracy: Number.isFinite(fix.accuracyM) ? fix.accuracyM : null,
            yawRate: gyroRate, heading, curvatureHere, radiusAhead, wet,
            maneuverDistance: nav && nav.active ? nav.nextManeuverM : null, quiet, riding
        });
        if (last.canAdvise) maybeAdvise(C, G, t, v);
        return last;
    }

    /** Economy advice, if the bike's physics has something worth saying. */
    function maybeAdvise(/** @type {any} */ C, /** @type {any} */ G, /** @type {number} */ t, /** @type {number} */ v) {
        const BF = G.BikeFuel;
        if (!BF || !BF.active() || !BF.snap || !BF.snap.eco || !G.voiceAnnounce) return;
        const FC = G.FuelCurve;
        const kmPerLAt = (/** @type {number} */ kmh) => {
            const own = FC && typeof FC.kmPerL === "function" ? FC.kmPerL(kmh) : null;       // the learner's curve when it's in use
            return own !== null && own !== undefined ? own : BF.kmPerL(kmh);
        };
        const SL = G.SpeedLimits;
        const limit = SL && SL.known() ? SL.current.limit / 3.6 : null;
        const a = C.ecoAdvice({ v, limit, kmPerLAt, eco: BF.snap.eco });
        if (!a || C.repeatedTooSoon(gate, t, a.key)) return;
        const spoken = G.voiceAnnounce(a.text, { priority: 30, category: "advice", drivingOnly: true, dropIfBusy: true, maxAgeMs: 3000, key: `advice-${a.key}`, cooldownMs: C.GATE.repeatCooldown * 1000 });
        if (spoken) C.noteAdvice(gate, t, a.key);
    }

    function reset() { gate = null; last = null; lastPos = null; listenGyro(false); }
    document.addEventListener("mu:drive-state", (/** @type {any} */ e) => { if (!e.detail || !e.detail.driving) reset(); });

    W.MUAdvice = W.MUAdvice || {};
    W.MUAdvice.app = { onTick, setQuiet, get quiet() { return quiet; }, status: () => last, reset };
})(typeof globalThis !== "undefined" ? globalThis : this);
