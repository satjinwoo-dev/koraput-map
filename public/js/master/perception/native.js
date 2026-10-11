// @ts-check
/* ============================================================================
   MapUnite Master AI — MapUnitePerception native plugin, JS interface
   ==============================================================================
   The typed door to the Kotlin plugin (native/android/perception/). The road
   agent uses provider.js (frames only); this wrapper adds everything else the
   plugin can do: the dataset recorder, mount preview, calibration, status.

     const P = MUMaster.perception.native.connect(window, { owner: "recorder" });
     if (!P.available) …                          // website, or plugin not compiled in
     await P.start({ targetFps: 30 });            // camera + sensors + model + 10 Hz frames
     const jpegUrl = await P.preview();           // "data:image/jpeg;base64,…" to aim the mount
     await P.calibrate({ mountHeightM: 1.05 });   // bike on its stand, 2 s still
     const { dir } = await P.startRecording({ intervalMs: 500, note: "NH-48 dusk" });
     await P.mark("pothole");                     // rider's "hazard here"
     const summary = await P.stopRecording();
     await P.stop();                              // releases this owner only

   OWNERS: the camera stays on while any owner holds it ("app" = the road agent,
   "recorder" = the recorder page), so ending a ride never cuts a recording.

   Every method rejects with a PerceptionError { code, message }:
     UNAVAILABLE, PERMISSION_DENIED, CAMERA_ERROR, NOT_STILL, RECORDER_ERROR, FAILED
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); const M = W.MUMaster || (W.MUMaster = {}); (M.perception || (M.perception = {})).native = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const PLUGIN = "MapUnitePerception";
    const SCENARIOS = Object.freeze(["none", "pothole", "truck", "mixed"]);
    const MARKS = Object.freeze(["pothole", "waterlogging", "speed_breaker", "road_work", "animal", "other"]);

    /**
     * @typedef {{ id: string, pitchDeg: number, rollDeg: number, mountHeightM: number|null }} Calibration
     * @typedef {{ active: boolean, dir: string|null, frames: number, bytes: number, imuRows: number, gnssRows: number, events: number,
     *             facesBlurred: number, platesBlurred: number, redactionFailures: number, skippedBusy: number,
     *             startedAtMs: number|null, freeMB: number|null, reason?: string }} RecordingSummary
     * @typedef {{ running: boolean, paused: boolean, owners: string[], model: { id: string, version: string, delegate: string },
     *             targetFps: number, thermalCapFps: number, effectiveFps: number, cameraFps: number|null, inferFps: number|null, latencyMs: number|null,
     *             framesIn: number, framesInferred: number, errors: number, thermal: string, headroom: number|null, batteryPct: number, charging: boolean,
     *             camera: null|{ width: number, height: number, fpsRange: string, focus: string, timestampRealtime: boolean, hfovDeg: number|null },
     *             sensors: { imu: boolean, rotationVector: boolean, gnss: boolean, gnssWhy: string|null, gnssFixes: number, gnssAgeMs: number|null,
     *                        speedMs: number|null, speedSigma: number|null, pitchDeg: number|null, rollDeg: number|null },
     *             quality: { usable: number, reasons: string[], meanLuma: number|null, sharpness: number|null },
     *             calibration: Calibration|null, recording: RecordingSummary }} Status
     */

    class PerceptionError extends Error {
        /** @param {string} code @param {string} message */
        constructor(code, message) { super(message); this.name = "PerceptionError"; this.code = code; }
    }

    /** @param {any} e @returns {PerceptionError} */
    function toError(e) {
        if (e instanceof PerceptionError) return e;
        const code = e && typeof e.code === "string" && e.code ? e.code : "FAILED";
        const msg = (e && (e.message || e.errorMessage)) || String(e || "failed");
        return new PerceptionError(code, msg);
    }

    /**
     * The registered plugin object, or null (website, iOS, or not compiled in).
     * @param {any} W window
     */
    function findPlugin(W) {
        try {
            const core = W && (W.capacitorExports || null);
            const Cap = (core && core.Capacitor) || (W && W.Capacitor);
            if (!Cap || typeof Cap.isNativePlatform !== "function" || !Cap.isNativePlatform()) return null;
            if (typeof Cap.isPluginAvailable === "function" && !Cap.isPluginAvailable(PLUGIN)) return null;
            const register = (core && core.registerPlugin) || Cap.registerPlugin;
            return typeof register === "function" ? register(PLUGIN) : null;
        } catch (e) { return null; }
    }

    /**
     * @param {{ plugin: any, owner?: string }} o
     */
    function createNativePerception(o) {
        const plugin = o.plugin || null;
        const owner = String(o.owner || "recorder").slice(0, 20);
        /** @type {Set<any>} */ const handles = new Set();

        /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
        async function call(fn) {
            if (!plugin) throw new PerceptionError("UNAVAILABLE", "The road camera works in the MapUnite Android app only.");
            try { return await fn(); } catch (e) { throw toError(e); }
        }

        /** @param {string} event @param {(x: any) => void} fn @returns {() => void} */
        function listen(event, fn) {
            if (!plugin) return () => {};
            let handle = /** @type {any} */ (null), removed = false;
            Promise.resolve(plugin.addListener(event, fn)).then((h) => { if (removed) h.remove(); else { handle = h; handles.add(h); } }).catch(() => {});
            return () => { removed = true; if (handle) { handles.delete(handle); handle.remove(); } };
        }

        return {
            available: Boolean(plugin),
            owner,
            SCENARIOS, MARKS,

            /** @param {{ targetFps?: number, emitHz?: number, scenario?: string }} [p] @returns {Promise<Status>} */
            start(p = {}) {
                const scenario = SCENARIOS.includes(String(p.scenario)) ? String(p.scenario) : "none";
                return call(() => plugin.start({ targetFps: clampInt(p.targetFps, 0, 30, 30), emitHz: clampInt(p.emitHz, 1, 15, 10), scenario, owner }));
            },
            /** @returns {Promise<{ stopped: boolean }>} */
            stop() { return call(() => plugin.stop({ owner })); },
            /** @param {number} fps 0 pauses the model (camera stays warm) */
            setTargetFps(fps) { return call(() => plugin.setTargetFps({ fps: clampInt(fps, 0, 30, 30) })); },
            /** @returns {Promise<Status>} */
            status() { return call(() => plugin.status()); },
            /** The next camera frame as a data: URL (480 px wide), for aiming the mount. @returns {Promise<string>} */
            async preview() {
                const r = await call(() => plugin.preview());
                return `data:${r.mime || "image/jpeg"};base64,${r.jpeg}`;
            },
            /** @param {{ mountHeightM?: number }} [p] @returns {Promise<Calibration>} */
            calibrate(p = {}) {
                const h = Number(p.mountHeightM);
                return call(() => plugin.calibrate(Number.isFinite(h) && h >= 0.3 && h <= 2.5 ? { mountHeightM: h } : {}));
            },
            /** @param {{ intervalMs?: number, note?: string }} [p] @returns {Promise<{ dir: string }>} */
            startRecording(p = {}) {
                return call(() => plugin.startRecording({ intervalMs: clampInt(p.intervalMs, 200, 5000, 500), note: String(p.note || "").slice(0, 200) }));
            },
            /** @returns {Promise<RecordingSummary>} */
            stopRecording() { return call(() => plugin.stopRecording()); },
            /** @param {string} label @returns {Promise<boolean>} */
            async mark(label) {
                const r = await call(() => plugin.mark({ label: String(label || "other").replace(/[^A-Za-z0-9_\- ]/g, "").slice(0, 40) || "other" }));
                return Boolean(r && r.ok);
            },
            /** PerceptionFrames as objects (the plugin sends JSON text). @param {(frame: any) => void} fn */
            onFrame(fn) {
                return listen("frame", (e) => {
                    const raw = e && e.frame !== undefined ? e.frame : e;
                    let f = raw;
                    if (typeof raw === "string") { try { f = JSON.parse(raw); } catch (err) { return; } }
                    fn(f);
                });
            },
            /** @param {(state: { state: string, [k: string]: any }) => void} fn */
            onState(fn) { return listen("state", fn); },
            /** Removes every listener this wrapper added. */
            dispose() { for (const h of handles) { try { h.remove(); } catch (e) { /* gone */ } } handles.clear(); }
        };
    }

    /** @param {any} v @param {number} lo @param {number} hi @param {number} dflt */
    function clampInt(v, lo, hi, dflt) {
        const n = Math.round(Number(v));
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    }

    /** @param {any} W @param {{ owner?: string }} [o] */
    function connect(W, o = {}) { return createNativePerception({ plugin: findPlugin(W), owner: o.owner }); }

    return { createNativePerception, connect, findPlugin, PerceptionError, SCENARIOS, MARKS, PLUGIN };
});
