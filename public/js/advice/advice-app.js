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
    /** Road conditions from the weather tracker (js/advice/advice-ui.js): { wet: boolean|null, at } — preferred to the bare weather code */
    let road = { wet: /** @type {boolean|null} */ (null), at: 0 };
    /** Per ride: economy advice the gate held back, by reason ({ reason: count }), counted at most once a minute per reason */
    let held = /** @type {Record<string, number>} */ ({}), heldAt = /** @type {Record<string, number>} */ ({});
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
        const wet = road.wet !== null && Date.now() - road.at < WEATHER_MAX_AGE ? road.wet
            : G.weatherCode !== null && Date.now() - G.weatherAt < WEATHER_MAX_AGE ? C.isWetWeather(G.weatherCode) : null;
        const gyroRate = gyro.rate !== null && Date.now() - gyro.at < 2000 ? gyro.rate : null;
        last = C.evaluateGate(gate, {
            t, v, gpsOk: !!fix.accepted, accuracy: Number.isFinite(fix.accuracyM) ? fix.accuracyM : null,
            yawRate: gyroRate, heading, curvatureHere, radiusAhead, wet,
            maneuverDistance: nav && nav.active ? nav.nextManeuverM : null, quiet, riding
        });
        if (last.canAdvise) maybeAdvise(C, G, t, v);
        else if (riding && (last.state === "hold" || last.state === "quiet" || last.state === "cooldown") && candidate(C, G, v)) {
            for (const r of last.reasons) if (!heldAt[r] || t - heldAt[r] >= 60) { held[r] = (held[r] || 0) + 1; heldAt[r] = t; }
        }
        return last;
    }

    /** The advice there would be right now, or null (no bike, nothing worth saying). */
    function candidate(/** @type {any} */ C, /** @type {any} */ G, /** @type {number} */ v) {
        const BF = G.BikeFuel;
        if (!BF || !BF.active() || !BF.snap || !BF.snap.eco) return null;
        const FC = G.FuelCurve;
        const kmPerLAt = (/** @type {number} */ kmh) => { const own = FC && typeof FC.kmPerL === "function" ? FC.kmPerL(kmh) : null; return own !== null && own !== undefined ? own : BF.kmPerL(kmh); };
        const SL = G.SpeedLimits;
        return C.ecoAdvice({ v, limit: SL && SL.known() ? SL.current.limit / 3.6 : null, kmPerLAt, eco: BF.snap.eco });
    }

    /** Economy advice, if the bike's physics has something worth saying. */
    function maybeAdvise(/** @type {any} */ C, /** @type {any} */ G, /** @type {number} */ t, /** @type {number} */ v) {
        if (!G.voiceAnnounce) return;
        const a = candidate(C, G, v);
        if (!a || C.repeatedTooSoon(gate, t, a.key)) return;
        const spoken = G.voiceAnnounce(a.text, { priority: 30, category: "advice", drivingOnly: true, dropIfBusy: true, maxAgeMs: 3000, key: `advice-${a.key}`, cooldownMs: C.GATE.repeatCooldown * 1000 });
        if (spoken) C.noteAdvice(gate, t, a.key);
    }

    function reset() { gate = null; last = null; lastPos = null; listenGyro(false); }
    let wasDriving = false;
    document.addEventListener("mu:drive-state", (/** @type {any} */ e) => {
        const on = Boolean(e.detail && e.detail.driving);
        if (on && !wasDriving) { held = {}; heldAt = {}; }               // a new ride: new "held back" counts
        if (!on) reset();
        wasDriving = on;
    });

    /**
     * Road conditions from the weather tracker (js/advice/conditions.js): a wet, drying, heavy-rain,
     * storm or ice condition holds advice like rain does; dry releases it; unknown falls back to the
     * weather code core.js fetches.
     * @param {{ kind: string } | null} cond
     */
    function setRoadCondition(cond) {
        const k = cond && cond.kind;
        road = { wet: !k || k === "unknown" ? null : ["wet", "drying", "heavy", "storm", "ice"].includes(k), at: Date.now() };
    }
    const HELD_WORDS = /** @type {Record<string, string>} */ ({
        "quiet-ride": "quiet ride", cornering: "in a corner", "curve-ahead": "a bend ahead", braking: "right after hard braking",
        wet: "a wet road", unsteady: "speed not steady", maneuver: "a turn coming up", gps: "weak GPS", slow: "slow traffic", cooldown: "too soon after another tip"
    });
    /** The held-back counts in words, for settings. */
    function heldSummary() {
        const parts = Object.entries(held).filter(([k, n]) => n > 0 && k in HELD_WORDS).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} (${HELD_WORDS[k]})`);
        if (!parts.length) return "";
        const total = Object.entries(held).filter(([k]) => k in HELD_WORDS).reduce((a, [, n]) => a + n, 0);
        return `This ride: ${total} tip${total === 1 ? "" : "s"} held back: ${parts.join(", ")}.`;
    }
    /** What the gate is doing, in words (the badge and settings). */
    function mode() {
        if (quiet) return { key: "quiet", label: "Quiet ride", detail: "No riding tips. Directions, speed alerts and safety warnings are spoken as usual." };
        const r = last && last.state === "hold" ? last.reasons : [];
        if (r.includes("wet")) return { key: "storm", label: "Wet road", detail: "Tips are held back so you can watch the road. Warnings still come through." };
        if (r.includes("gps")) return { key: "degraded", label: "GPS is weak", detail: "Tips pause until the signal is trusted again. Speed and safety alerts are unaffected." };
        if (r.some((x) => ["cornering", "curve-ahead", "braking", "maneuver"].includes(x))) return { key: "busy", label: "Holding tips", detail: "In a corner, near a turn, or right after hard braking, tips wait." };
        return { key: "open", label: "All advice on", detail: "Tips only on a steady road, at most every 3 minutes, never above the speed limit. Safety alerts always come through." };
    }

    W.MUAdvice = W.MUAdvice || {};
    W.MUAdvice.app = { onTick, setQuiet, setRoadCondition, heldSummary, mode, get quiet() { return quiet; }, get held() { return { ...held }; }, status: () => last, reset };
})(typeof globalThis !== "undefined" ? globalThis : this);
