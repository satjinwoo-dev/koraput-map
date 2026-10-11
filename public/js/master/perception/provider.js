// @ts-check
/* ============================================================================
   MapUnite Master AI — perception provider (capability "perception")
   ==============================================================================
   One door to the road model, whatever is behind it:

     native  the MapUnitePerception Capacitor plugin (Kotlin/Java: CameraX →
             LiteRT/TFLite on the NPU → tracking → fusion). See PERCEPTION.md
             for the plugin's methods and events. Used when it's registered.
     replay  recorded PerceptionFrames (JSONL from the recorder, or arrays
             in tests) played back on their own timestamps. This is how agents
             are built and tested before a model exists, and how a new model's
             output on yesterday's ride is reviewed.

   API (same for both):
     available()                 → boolean
     start({ targetFps })        → Promise<void>
     stop()                      → Promise<void>
     setTargetFps(fps)           → Promise<void>   (0 pauses inference, camera stays warm)
     onFrame(fn) / onState(fn)   → unsubscribe
     status()                    → { running, backend, fps, lastFrameAt, framesSeen, framesDropped }
   Frames are validated against contract.js before anyone sees them.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); const M = W.MUMaster || (W.MUMaster = {}); (M.perception || (M.perception = {})).provider = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function emitter() {
        /** @type {Set<Function>} */ const fns = new Set();
        return { on: (/** @type {Function} */ fn) => { fns.add(fn); return () => fns.delete(fn); }, emit: (/** @type {any} */ v) => { for (const fn of fns) { try { fn(v); } catch (e) { /* listeners are independent */ } } } };
    }

    /**
     * @param {{ contract: any, plugin?: any, replay?: any[]|string, timers?: { setTimeout: Function, clearTimeout: Function }, now?: () => number, speed?: number }} o
     *   plugin: a Capacitor plugin object (registerPlugin("MapUnitePerception")); replay: frames or JSONL text
     */
    function createPerceptionProvider(o) {
        const C = o.contract;
        const timers = o.timers || globalThis;
        const frames = emitter(), states = emitter();
        const st = { running: false, backend: o.plugin ? "native" : o.replay ? "replay" : "none", fps: 0, lastFrameAt: 0, framesSeen: 0, framesDropped: 0, lastErrors: /** @type {string[]} */ ([]) };

        function deliver(/** @type {any} */ raw) {
            const v = C.validateFrame(raw);
            if (!v.ok) { st.framesDropped++; st.lastErrors = v.errors.slice(0, 5); return; }
            st.framesSeen++;
            st.lastFrameAt = v.frame.t;
            frames.emit(v.frame);
        }

        // ---------------------------------------------------------------- native backend
        /** @type {any[]} */ let handles = [];
        const native = o.plugin ? {
            async start(/** @type {number} */ fps) {
                handles.push(await o.plugin.addListener("frame", (/** @type {any} */ e) => deliver(e && e.frame ? (typeof e.frame === "string" ? JSON.parse(e.frame) : e.frame) : e)));
                handles.push(await o.plugin.addListener("state", (/** @type {any} */ s) => states.emit(s)));
                await o.plugin.start({ targetFps: fps });
            },
            async stop() { try { await o.plugin.stop(); } finally { for (const h of handles.splice(0)) { try { await h.remove(); } catch (e) { /* gone */ } } } },
            async setTargetFps(/** @type {number} */ fps) { await o.plugin.setTargetFps({ fps }); }
        } : null;

        // ---------------------------------------------------------------- replay backend
        const replayList = typeof o.replay === "string"
            ? o.replay.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean)
            : Array.isArray(o.replay) ? o.replay : null;
        /** @type {any} */ let timer = null;
        let idx = 0, paused = false;
        const replay = replayList ? {
            async start() {
                idx = 0;
                const step = () => {
                    timer = null;
                    if (!st.running || idx >= replayList.length) { if (idx >= replayList.length) states.emit({ state: "ended" }); return; }
                    const f = replayList[idx++];
                    if (!paused) deliver(f);
                    const next = replayList[idx];
                    const gap = next ? Math.max(0, (next.t - f.t) / (o.speed || 1)) : 0;
                    timer = timers.setTimeout(step, gap);
                };
                step();
            },
            async stop() { if (timer) timers.clearTimeout(timer); timer = null; },
            async setTargetFps(/** @type {number} */ fps) { paused = fps <= 0; }
        } : null;

        const backend = native || replay;
        return {
            available: () => Boolean(backend),
            async start(/** @type {{ targetFps?: number }} */ p = {}) {
                if (!backend || st.running) return;
                st.running = true; st.fps = p.targetFps || 30;
                states.emit({ state: "starting", backend: st.backend });
                try { await backend.start(st.fps); states.emit({ state: "running", backend: st.backend }); }
                catch (e) { st.running = false; states.emit({ state: "error", message: String((e && /** @type {any} */ (e).message) || e) }); throw e; }
            },
            async stop() { if (!backend || !st.running) return; st.running = false; await backend.stop(); states.emit({ state: "stopped" }); },
            async setTargetFps(/** @type {number} */ fps) { if (!backend) return; st.fps = fps; await backend.setTargetFps(fps); },
            onFrame: frames.on,
            onState: states.on,
            status: () => ({ ...st, lastErrors: st.lastErrors.slice() })
        };
    }

    /** The native plugin, if this is the Android app and the plugin is compiled in. @param {any} W */
    function nativePlugin(W) {
        try {
            const core = W.capacitorExports;
            const Cap = core && core.Capacitor;
            if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform() || !Cap.isPluginAvailable || !Cap.isPluginAvailable("MapUnitePerception")) return null;
            return core.registerPlugin("MapUnitePerception");
        } catch (e) { return null; }
    }

    return { createPerceptionProvider, nativePlugin };
});
