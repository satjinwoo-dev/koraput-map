// @ts-check
/* ============================================================================
   MapUnite Master AI — Vision agent ("vision"): the biometric break check
   ==============================================================================
   When the Ride agent says a break is due (1 h 30 min / 2 h of riding), this
   agent waits for the bike to STOP, offers a 10-second fatigue check, and
   reports what it saw to the Master.

     ride.break-due ──▶ armed ──▶ bike stopped ≥ 15 s ──▶ report vision.offer
        (Ride agent)                (GPS: speed ≈ 0)       (asked through the
                                                            "ek baat bolun?" gate)
       ──▶ rider said yes / it was shown ──▶ card "Start · Abhi nahi"
       ──▶ rider taps Start ──▶ face-scan (camera, MediaPipe, on the phone)
       ──▶ report fatigue.high (warning) | fatigue.moderate | fatigue.low (advice)
           | fatigue.retry (face not seen)  ──▶ persona ──▶ gate ──▶ voice

   THE SAFETY RULE: the camera, the card and the check exist only while the
   bike stands still.
     - offer: only when state.ride says stopped for ≥ 15 s AND the freshest GPS
       speed is ≤ 0.8 m/s (≈ 3 km/h, GPS jitter at rest);
     - the card closes the moment the bike moves;
     - during the check, guard() runs every frame: speed > 1.5 m/s or the Ride
       agent saying "moving" → camera off, check dropped;
     - no GPS fix while riding → no proof it stopped → no offer.
   Outside a ride (parked, app open) a manual check is allowed:
     MUMaster.live.delegate("fatigue-check").

   Not nagging: one offer per break-due; "nahi", silence or "Abhi nahi" ends
   it; at most one check every 45 min. The last 20 results stay on the phone
   (store "vision.history"); frames and photos are never kept.
   ============================================================================ */
(function (root, factory) {
    const def = factory();
    if (typeof module === "object" && module.exports) module.exports = def;
    else {
        // load order doesn't matter: before the kernel exists, definitions wait in a queue
        const M = /** @type {any} */ (root).MUMaster || (/** @type {any} */ (root).MUMaster = {});
        if (typeof M.define === "function") M.define(def); else (M._pending || (M._pending = [])).push(def);
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /** fatigue.js, from require() in node or the page's MUMaster.vision */
    function fatigueLib() {
        const g = /** @type {any} */ (globalThis);
        if (g.MUMaster && g.MUMaster.vision && g.MUMaster.vision.fatigue) return g.MUMaster.vision.fatigue;
        // @ts-ignore: node (tests) only
        if (typeof module === "object" && typeof require === "function") return require("../vision/fatigue.js");
        return null;
    }

    return {
        id: "vision",
        version: "1.0.0",
        apiVersion: 1,
        description: "Break-time fatigue check from the front camera (on-device), only while the bike is stopped.",
        requires: ["face-scan"],
        optional: ["location", "drive"],
        depends: ["ride"],
        defaults: {
            stopSec: 15,               // stopped this long before anything is offered
            stillSpeedMs: 0.8,         // freshest GPS speed must be at or below this to offer / start
            moveAbortMs: 1.5,          // above this during a check: camera off
            fixFreshMs: 15000,
            offerWindowMs: 45 * 60 * 1000,   // a break-due is good for this long
            minGapMs: 45 * 60 * 1000,        // between two checks
            durationMs: 10000,
            offerTimeoutMs: 120000,
            checkEveryMs: 5000,
            historySize: 20
        },

        /** @param {any} ctx */
        start(ctx) {
            const cfg = ctx.config;
            const scan = ctx.caps.get("face-scan");
            const loc = ctx.caps.get("location");
            const F = fatigueLib();
            if (!F) throw new Error("vision/fatigue.js isn't loaded");

            let pendingSince = /** @type {number|null} */ (null), offered = false, running = false;
            const stored = Number(ctx.store.get("lastCheckAt", null));
            let lastCheckAt = Number.isFinite(stored) && stored > 0 ? stored : -Infinity;
            /** @type {any} */ let card = null;
            // the VOICE's style (desi Hinglish / plain English); the screens are always English
            const voiceStyle = () => { const p = ctx.bus.last("state.persona"); return p && p.style === "plain" ? "plain" : "desi"; };

            /** Is the bike standing still, provably? */
            function stillness() {
                const t = ctx.now();
                const ride = ctx.bus.last("state.ride");
                const fix = loc && loc.current();
                const fresh = fix && Number.isFinite(fix.t) && t - fix.t <= cfg.fixFreshMs;
                const speed = fresh ? fix.speedMs : ride && Number.isFinite(ride.speedMs) ? ride.speedMs : null;
                if (speed !== null && speed > cfg.stillSpeedMs) return { still: false, reason: "moving" };
                if (ride && ride.active) {
                    if (!ride.stopped) return { still: false, reason: "moving" };
                    const stoppedFor = (ride.stoppedForSec || 0) + Math.max(0, (t - (ride.at || t)) / 1000);
                    if (stoppedFor < cfg.stopSec) return { still: false, reason: "just-stopped" };
                }
                return { still: true, reason: "" };
            }
            /** For the running check: only real movement stops it. */
            function moving() {
                const t = ctx.now();
                const ride = ctx.bus.last("state.ride");
                const fix = loc && loc.current();
                if (fix && Number.isFinite(fix.t) && t - fix.t <= cfg.fixFreshMs && fix.speedMs > cfg.moveAbortMs) return true;
                return Boolean(ride && ride.active && !ride.stopped);
            }

            function closeCard() { if (card) { card.close(); card = null; } }
            function disarm() { pendingSince = null; offered = false; closeCard(); }

            function tryOffer() {
                if (pendingSince === null || offered || running || (scan.busy && scan.busy())) return;
                if (ctx.now() - pendingSince > cfg.offerWindowMs) { disarm(); return; }
                if (!stillness().still) return;
                offered = true;
                const ride = ctx.bus.last("state.ride");
                ctx.report("vision.offer", { severity: "advice", key: "vision.offer", category: "fatigue", ttlMs: 90000, data: { ridingSec: (ride && ride.ridingSec) || 0 } });
            }

            function showCard() {
                if (!stillness().still) { offered = false; return; }      // rolled off while being asked: try at the next stop
                closeCard();
                card = scan.offer({
                    timeoutMs: cfg.offerTimeoutMs,
                    onStart: ctx.wrap(() => { card = null; runCheck("offer"); }),
                    onLater: ctx.wrap(() => { card = null; disarm(); })
                });
            }

            /** @param {string} trigger */
            async function runCheck(trigger) {
                if (running || (scan.busy && scan.busy())) return { ok: false, reason: "busy" };
                const s = stillness();
                if (!s.still) return { ok: false, reason: s.reason };
                running = true;
                closeCard();
                const ride = ctx.bus.last("state.ride");
                const ridingSec = (ride && ride.ridingSec) || 0;
                ctx.setState("vision", { checking: true, at: ctx.now(), trigger });
                /** @type {any} */ let out;
                try { out = await scan.scan({ durationMs: cfg.durationMs, ridingSec, guard: () => (moving() ? "moving" : null) }); }
                catch (e) { out = { ok: false, reason: "camera" }; }
                running = false;
                pendingSince = null; offered = false;
                ctx.setState("vision", { checking: false, at: ctx.now(), trigger });
                if (!out || !out.ok) {
                    const reason = (out && out.reason) || "camera";
                    if (reason === "camera-denied") ctx.markDegraded("camera permission denied");
                    if (reason === "model" || reason === "camera" || reason === "camera-denied") ctx.report("vision.unavailable", { severity: "advice", key: "vision.status", category: "fatigue", data: { reason } });
                    else if (reason === "no-face") ctx.report("fatigue.retry", { severity: "advice", key: "fatigue", category: "fatigue" });
                    // "moving" / "cancelled": the rider knows; nothing to say
                    return { ok: false, reason };
                }
                const r = out.result;
                lastCheckAt = ctx.now();
                ctx.store.set("lastCheckAt", lastCheckAt);
                if (r.confidence === "poor") {
                    ctx.report("fatigue.retry", { severity: "advice", key: "fatigue", category: "fatigue" });
                    scan.showResult(r);
                    return { ok: true, result: r };
                }
                const history = (ctx.store.get("history", []) || []).concat([{ at: lastCheckAt, score: r.score, level: r.level, mode: r.mode, confidence: r.confidence, ridingSec }]).slice(-cfg.historySize);
                ctx.store.set("history", history);
                const detail = F.signalWords(r.signals, voiceStyle());          // spoken
                const screenDetail = F.signalWords(r.signals, "plain");        // on screen (status island), always English
                ctx.report(`fatigue.${r.level}`, {
                    severity: r.level === "high" ? "warning" : "advice",
                    key: "fatigue", category: "fatigue", ttlMs: 120000,
                    data: {
                        score: r.score, level: r.level, confidence: r.confidence, mode: r.mode, ridingSec, signals: r.signals.map((/** @type {any} */ x) => x.id),
                        ...(detail ? { detail, screen: { detail: screenDetail.charAt(0).toUpperCase() + screenDetail.slice(1) } } : {})
                    }
                });
                ctx.setState("fatigue", { at: lastCheckAt, score: r.score, level: r.level, confidence: r.confidence, mode: r.mode });
                scan.showResult(r);
                return { ok: true, result: r };
            }

            // a break is due → arm (unless a check happened recently)
            ctx.bus.subscribe("report.ride.ride.break-due", () => {
                if (ctx.now() - lastCheckAt < cfg.minGapMs) return;
                if (pendingSince === null) { pendingSince = ctx.now(); offered = false; }
                tryOffer();
            });
            // the Master's verdict on our offer: show the card only if the rider didn't turn it down
            ctx.bus.subscribe("master.decision", (/** @type {any} */ d) => {
                if (!d || d.source !== "vision" || d.kind !== "vision.offer") return;
                if (d.action === "spoken" || d.action === "shown" || d.action === "held") showCard();
                // offered a few minutes ago and the rider rolled off before tapping: just show the card again, quietly
                else if (d.action === "dropped" && /^cooldown/.test(d.reason || "")) showCard();
                else if (d.action === "declined" || d.action === "unanswered" || d.action === "dropped") disarm();
            });
            // movement closes the card; a finished ride ends everything
            ctx.bus.subscribe("state.ride", (/** @type {any} */ ride) => {
                if (card && moving()) { closeCard(); offered = false; }
                if (ride && ride.active === false && !running) disarm();
                tryOffer();
            });
            // stopped time keeps growing even when fixes pause (GPS asleep at rest): look again now and then
            ctx.timers.setInterval(() => { tryOffer(); if (card && moving()) { closeCard(); offered = false; } }, cfg.checkEveryMs);
            // manual: MUMaster.live.delegate("fatigue-check")
            ctx.bus.handle("task.fatigue-check", () => runCheck("manual"));
            ctx.onStop(() => { closeCard(); if (scan.cancel) scan.cancel(); });
        }
    };
});
