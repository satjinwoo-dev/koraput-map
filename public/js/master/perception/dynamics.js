// @ts-check
/* ============================================================================
   MapUnite Master AI — bike dynamics: DynamicsFrame contract v1 + provider
   ==============================================================================
   The native plugin's DynamicsCore (IMU 100 Hz + GNSS) sends one DynamicsFrame
   per second while a ride runs (no camera needed):

     { v: 1, kind: "dynamics", t, seq,
       ego: { speedMs, speedSigma, headingDeg, lat?, lng?, posSigmaM? },
       longMs2, longMinMs2, longMaxMs2, vertRmsMs2, braking, imuHz,
       events:   [{ id, type: "hard_brake"|"hard_accel"|"jolt", t, durS, peakMs2,
                    speedFromMs, speedToMs, dvImuMs, lat, lng, headingDeg, conf, source }],
       segments: [{ t, distM, rmsMs2, refRmsMs2, cls: "smooth"|"fair"|"rough"|"very_rough",
                    speedMs, lat, lng, headingDeg }] }

   validateDynamics() checks it strictly (bad events/segments are dropped, not
   the frame). createDynamicsProvider() is the "dynamics" capability:
     native  MapUnitePerception.startDynamics / "dynamics" events / stopDynamics
     replay  recorded frames (JSONL or array) on their own timestamps (tests, desk)
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); const M = W.MUMaster || (W.MUMaster = {}); (M.perception || (M.perception = {})).dynamics = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const VERSION = 1;
    const EVENTS = Object.freeze(["hard_brake", "hard_accel", "jolt"]);
    const ROUGHNESS = Object.freeze(["smooth", "fair", "rough", "very_rough"]);

    const fin = (/** @type {any} */ v) => typeof v === "number" && Number.isFinite(v);
    const finOrNull = (/** @type {any} */ v) => v === null || v === undefined || fin(v);

    /**
     * @param {any} f
     * @returns {{ ok: boolean, frame: any, errors: string[], dropped: number }}
     */
    function validateDynamics(f) {
        const errors = [];
        if (!f || typeof f !== "object") return { ok: false, frame: null, errors: ["frame must be an object"], dropped: 0 };
        if (f.v !== VERSION || f.kind !== "dynamics") errors.push(`not a DynamicsFrame v${VERSION}`);
        if (!fin(f.t) || f.t <= 0) errors.push("t is required");
        if (!Number.isInteger(f.seq) || f.seq < 0) errors.push("seq must be a non-negative integer");
        const ego = f.ego || {};
        if (!fin(ego.speedMs) || !fin(ego.speedSigma) || ego.speedSigma < 0) errors.push("ego { speedMs, speedSigma } is required");
        for (const k of ["longMs2", "longMinMs2", "longMaxMs2", "vertRmsMs2"]) if (!fin(f[k])) errors.push(`${k} is required`);
        if (errors.length) return { ok: false, frame: null, errors, dropped: 0 };
        let dropped = 0;
        const keep = (/** @type {any[]} */ list, /** @type {(x: any) => string|null} */ check, /** @type {string} */ what) => (Array.isArray(list) ? list : []).filter((x) => {
            const why = check(x);
            if (why) { dropped++; if (errors.length < 20) errors.push(`${what}: ${why}`); return false; }
            return true;
        });
        const events = keep(f.events, (e) => {
            if (!e || !EVENTS.includes(e.type)) return `unknown type "${e && e.type}"`;
            if (!fin(e.t) || !fin(e.peakMs2) || !fin(e.durS)) return "t, peakMs2, durS required";
            if (!fin(e.conf) || e.conf < 0 || e.conf > 1) return "conf must be 0..1";
            if (!finOrNull(e.lat) || !finOrNull(e.lng) || !finOrNull(e.speedFromMs) || !finOrNull(e.speedToMs)) return "bad number";
            return null;
        }, "event");
        const segments = keep(f.segments, (s) => {
            if (!s || !ROUGHNESS.includes(s.cls)) return `unknown roughness "${s && s.cls}"`;
            if (!fin(s.t) || !fin(s.distM) || !fin(s.refRmsMs2) || !fin(s.speedMs)) return "t, distM, refRmsMs2, speedMs required";
            if (!finOrNull(s.lat) || !finOrNull(s.lng)) return "bad position";
            return null;
        }, "segment");
        return {
            ok: true, errors, dropped,
            frame: {
                v: f.v, kind: f.kind, t: f.t, seq: f.seq, ego,
                longMs2: f.longMs2, longMinMs2: f.longMinMs2, longMaxMs2: f.longMaxMs2, vertRmsMs2: f.vertRmsMs2,
                braking: Boolean(f.braking), imuHz: fin(f.imuHz) ? f.imuHz : null, events, segments
            }
        };
    }

    function emitter() {
        /** @type {Set<Function>} */ const fns = new Set();
        return { on: (/** @type {Function} */ fn) => { fns.add(fn); return () => fns.delete(fn); }, emit: (/** @type {any} */ v) => { for (const fn of fns) { try { fn(v); } catch (e) { /* independent */ } } } };
    }

    /**
     * @param {{ plugin?: any, replay?: any[]|string, timers?: { setTimeout: Function, clearTimeout: Function }, owner?: string }} o
     */
    function createDynamicsProvider(o) {
        const timers = o.timers || globalThis;
        const owner = o.owner || "app";
        const frames = emitter(), states = emitter();
        const st = { running: false, backend: o.plugin ? "native" : o.replay ? "replay" : "none", framesSeen: 0, framesDropped: 0, lastFrameAt: 0 };
        const deliver = (/** @type {any} */ raw) => {
            const v = validateDynamics(raw);
            if (!v.ok) { st.framesDropped++; return; }
            st.framesSeen++; st.lastFrameAt = v.frame.t;
            frames.emit(v.frame);
        };

        /** @type {any[]} */ let handles = [];
        const native = o.plugin ? {
            async start() {
                handles.push(await o.plugin.addListener("dynamics", (/** @type {any} */ e) => {
                    const raw = e && e.dynamics !== undefined ? e.dynamics : e;
                    if (typeof raw === "string") { try { deliver(JSON.parse(raw)); } catch (err) { st.framesDropped++; } } else deliver(raw);
                }));
                await o.plugin.startDynamics({ owner });
            },
            async stop() { try { await o.plugin.stopDynamics({ owner }); } finally { for (const h of handles.splice(0)) { try { await h.remove(); } catch (e) { /* gone */ } } } }
        } : null;

        const list = typeof o.replay === "string"
            ? o.replay.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean)
            : Array.isArray(o.replay) ? o.replay : null;
        /** @type {any} */ let timer = null;
        const replay = list ? {
            async start() {
                let i = 0;
                const step = () => {
                    timer = null;
                    if (!st.running || i >= list.length) { if (i >= list.length) states.emit({ state: "ended" }); return; }
                    const f = list[i++];
                    deliver(f);
                    const next = list[i];
                    timer = timers.setTimeout(step, next ? Math.max(0, next.t - f.t) : 0);
                };
                step();
            },
            async stop() { if (timer) timers.clearTimeout(timer); timer = null; }
        } : null;

        const backend = native || replay;
        return {
            available: () => Boolean(backend),
            async start() {
                if (!backend || st.running) return;
                st.running = true;
                try { await backend.start(); states.emit({ state: "running", backend: st.backend }); }
                catch (e) { st.running = false; states.emit({ state: "error", message: String((e && /** @type {any} */ (e).message) || e) }); throw e; }
            },
            async stop() { if (!backend || !st.running) return; st.running = false; await backend.stop(); states.emit({ state: "stopped" }); },
            onFrame: frames.on,
            onState: states.on,
            status: () => ({ ...st })
        };
    }

    return { VERSION, EVENTS, ROUGHNESS, validateDynamics, createDynamicsProvider };
});
