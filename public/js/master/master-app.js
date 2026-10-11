// @ts-check
/* ============================================================================
   MapUnite Master AI — boot (load last, after the agent files)
   ==============================================================================
   Wires the pieces together and starts the kernel:

     bus ─┬─ kernel (agents: ride, network, vision, road, dynamics … later radar, swarm)
          ├─ brain  (policies → queue → persona → output → safety gate → voice)
          └─ caps   (network, location, route, drive, store; camera/bluetooth later)

   Exposes window.MUMaster.live for the rest of the app and for the console:
     MUMaster.live.status()                   every agent and its state
     MUMaster.live.enable("network") / disable("network")
     MUMaster.live.setStyle("plain" | "desi") / setName("Rahul")
     MUMaster.live.delegate("deep-search", { query })
     MUMaster.live.delegate("fatigue-check")  the camera check now (only while stopped)
     MUMaster.live.tell({ kind: "master.reply", severity: "advice", text: "…" })
     MUMaster.live.debug.simulate("network.lost", { severity: "warning" })
     MUMaster.live.debug.log(true)            print every bus message

   Settings live on the phone only (localStorage "mu.master.v1").
   ============================================================================ */
(function (root) {
    "use strict";
    const W = /** @type {any} */ (root);
    if (!W.document) return;
    const M = W.MUMaster;
    const need = ["contracts", "bus", "caps", "kernel", "persona", "phrases", "output", "brain"];
    const missing = need.filter((k) => !M || !M[k]);
    if (missing.length) { console.warn(`[master] missing ${missing.join(", ")}: load js/master/*.js before master-app.js`); return; }
    if (M.live) return;                                                  // booted already

    const KEY = "mu.master.v1";
    /** @returns {{ style: "desi"|"plain", name: string, agents: Record<string, any> }} */
    function load() {
        const d = { style: /** @type {"desi"|"plain"} */ ("desi"), name: "", agents: {} };
        try { const v = JSON.parse(W.localStorage.getItem(KEY) || "null"); if (v && typeof v === "object") return { ...d, ...v, agents: { ...(v.agents || {}) } }; } catch (e) { /* first run / private mode */ }
        return d;
    }
    const config = load();
    const save = () => { try { W.localStorage.setItem(KEY, JSON.stringify(config)); } catch (e) { /* storage full / private mode */ } };

    // Agents loaded only when their moment comes (heavy engines). Add entries here in later steps, e.g.
    //   { id: "vision", src: "js/master/agents/vision-agent.js?v=…", loadOn: "report.ride.ride.break-due" }
    const LAZY = [];

    const bus = M.bus.createBus({ onError: (/** @type {any} */ err, /** @type {any} */ env, /** @type {string} */ owner) => console.warn(`[master] handler of ${owner} failed on ${env.topic}:`, err) });
    const caps = M.caps.installDefaults(M.caps.createCapabilities(), { window: W, document: W.document });
    // the camera check (js/master/vision/): its agent waits until this capability exists. It's provided only
    // when the MediaPipe loader (js/master/vision/landmarker.js) is loaded too, so a check is never offered
    // that couldn't run.
    if (M.vision && typeof M.vision.createFaceScanProvider === "function" && M.vision.landmarker && typeof M.vision.landmarker.load === "function") caps.provide("face-scan", M.vision.createFaceScanProvider(W));
    // the unified road model (js/master/perception/): the native plugin in the app, or a recorded replay for development
    //   window.MU_PERCEPTION_REPLAY = "<JSONL of PerceptionFrames>" before this script loads, to ride a recording in the browser
    if (M.perception && M.perception.provider && M.perception.contract) {
        const plugin = M.perception.provider.nativePlugin(W);
        const replay = typeof W.MU_PERCEPTION_REPLAY === "string" || Array.isArray(W.MU_PERCEPTION_REPLAY) ? W.MU_PERCEPTION_REPLAY : null;
        if (plugin || replay) caps.provide("perception", M.perception.provider.createPerceptionProvider({ contract: M.perception.contract, plugin, replay }));
    }
    // bike dynamics (js/master/perception/dynamics.js): IMU 100 Hz + GNSS from the native plugin, no camera needed
    //   window.MU_DYNAMICS_REPLAY = "<JSONL of DynamicsFrames>" to ride a recording in the browser
    if (M.perception && M.perception.dynamics) {
        const plugin = M.perception.provider ? M.perception.provider.nativePlugin(W) : null;
        const replay = typeof W.MU_DYNAMICS_REPLAY === "string" || Array.isArray(W.MU_DYNAMICS_REPLAY) ? W.MU_DYNAMICS_REPLAY : null;
        if (plugin || replay) caps.provide("dynamics", M.perception.dynamics.createDynamicsProvider({ plugin, replay }));
    }
    const persona = M.phrases.install(M.persona.createPersona({ style: config.style, name: config.name }));
    const output = M.output.createOutput({ window: W });
    const brain = M.brain.createBrain({ bus, contracts: M.contracts, persona, output });
    const kernel = M.kernel.createKernel({ bus, caps, contracts: M.contracts, config, onConfigChange: save });
    // agents that put words on screen themselves (the fatigue check) read the voice's style from here
    const sharePersona = () => bus.publish("state.persona", { style: persona.style, name: persona.name }, { source: "master", sticky: true });
    sharePersona();

    // agent files that loaded before this one queued their definitions; from now on define() goes straight in
    const pending = Array.isArray(M._pending) ? M._pending.splice(0) : [];
    M.define = (/** @type {any} */ def) => kernel.define(def);
    for (const def of pending) kernel.define(def);
    for (const entry of LAZY) kernel.lazy(entry);

    /** @type {Function|null} */ let untap = null;
    M.live = {
        bus, caps, kernel, brain, persona, output, config,
        status: () => kernel.status(),
        /** @param {string} id */ enable: (id) => kernel.enable(id),
        /** @param {string} id */ disable: (id) => kernel.disable(id),
        /** @param {"desi"|"plain"} s */ setStyle(s) { persona.setStyle(s); config.style = persona.style; save(); sharePersona(); },
        /** @param {string} n */ setName(n) { persona.setName(n); config.name = persona.name; save(); sharePersona(); },
        /** @param {string} task @param {any} [payload] @param {any} [o] */ delegate: (task, payload, o) => brain.delegate(task, payload, o),
        /** @param {any} report */ tell: (report) => brain.tell(report),
        transcript: () => brain.transcript(),
        debug: {
            /** Pretend an agent reported something. @param {string} kind @param {any} [payload] */
            simulate(kind, payload = {}) { return bus.publish(M.contracts.TOPIC.report("debug", kind), { severity: "advice", ...payload, kind }, { source: "debug" }); },
            /** @param {boolean} on */
            log(on) {
                if (untap) { untap(); untap = null; }
                if (on) untap = bus.tap((/** @type {any} */ env) => console.log(`[bus] ${env.topic} ← ${env.source}`, env.data));
            }
        }
    };

    const start = () => { kernel.start(); W.document.dispatchEvent(new W.CustomEvent("mu:master-ready", { detail: { agents: kernel.status().map((/** @type {any} */ a) => a.id) } })); };
    if (W.document.readyState === "loading") W.document.addEventListener("DOMContentLoaded", start); else start();
})(typeof globalThis !== "undefined" ? globalThis : this);
