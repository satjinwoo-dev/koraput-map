// @ts-check
/* ============================================================================
   MapUnite Master AI — boot (load last, after the agent files)
   ==============================================================================
   Wires the pieces together and starts the kernel:

     bus ─┬─ kernel (agents: ride, network, vision, road, dynamics, and the cognitive engines:
          │          corridor → weather · traffic · topology · blackspot (the 2 km radar),
          │          link, poi, deep-search, mood, destination, context)
          ├─ brain  (policies → cognition: interest · affect · fusion → queue → persona → output → gate → voice)
          └─ caps   (network, location, route, drive, store, master-api, app-context, terrain;
                     radio + media in the Android app)

   Exposes window.MUMaster.live for the rest of the app and for the console:
     MUMaster.live.status()                   every agent and its state
     MUMaster.live.enable("network") / disable("network")
     MUMaster.live.setStyle("plain" | "desi") / setName("Rahul")
     MUMaster.live.delegate("deep-search", { query })
     MUMaster.live.delegate("fatigue-check")  the camera check now (only while stopped)
     MUMaster.live.tell({ kind: "master.reply", severity: "advice", text: "…" })
     MUMaster.live.debug.simulate("network.lost", { severity: "warning" })
     MUMaster.live.debug.log(true)            print every bus message
     MUMaster.live.ask("kal Araku mein mausam kaisa rahega?")   Deep Search (Gemini, else local Ollama), spoken in the persona
     MUMaster.live.nearest("hospital")        the best one nearby, instantly, spoken + { place }
     MUMaster.live.emergency("medical")       the hospital to go to now (+ 112), from the phone's cache
     MUMaster.live.music("next") / musicTips(false)   control the player / silence music tips

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
    // RoadSense Live (js/master/roadsense/): the one road event log on the phone, shared by every agent that
    // sees the road (the dynamics agent today; the camera's road agent and the server sync next)
    if (M.roadsense) {
        const roadsense = M.roadsense.createLog({ store: caps.get("store").namespace("roadsense") });
        roadsense.load();
        caps.provide("roadsense", roadsense);
    }
    // the cognitive engines: our server's /api/master (keys stay there), the app's own context, the DEM cache,
    // and in the Android app the radio-signal and media-session plugins
    if (M.remote) caps.provide("master-api", M.remote.createMasterApiProvider({ window: W }));
    if (M.providers) {
        caps.provide("app-context", M.providers.createAppContextProvider(W, W.document));
        if (W.MUTrip && W.MUTrip.elevation && typeof W.MUTrip.elevation.createElevation === "function") caps.provide("terrain", M.providers.createTerrainProvider(W.MUTrip.elevation.createElevation()));
        const radio = M.providers.plugin(W, "MapUniteRadio");
        if (radio) caps.provide("radio", M.providers.createRadioProvider(radio));
        const media = M.providers.plugin(W, "MapUniteMedia");
        if (media) caps.provide("media", M.providers.createMediaProvider(media));
    }
    const persona = M.phrases.install(M.persona.createPersona({ style: config.style, name: config.name }));
    for (const pack of Array.isArray(M.phrasePacks) ? M.phrasePacks : []) { try { pack.install(persona); } catch (e) { console.warn("[master] phrase pack failed:", e); } }
    const output = M.output.createOutput({ window: W });
    const brain = M.brain.createBrain({ bus, contracts: M.contracts, persona, output });
    const kernel = M.kernel.createKernel({ bus, caps, contracts: M.contracts, config, onConfigChange: save });
    // learning, affect and reasoning policies (js/master/cognition.js)
    const cognition = M.cognition ? M.cognition.install({ brain, bus, store: caps.get("store").namespace("cognition") }) : null;
    // agents that put words on screen themselves (the fatigue check) read the voice's style from here
    const sharePersona = () => bus.publish("state.persona", { style: persona.style, name: persona.name }, { source: "master", sticky: true });
    sharePersona();

    // agent files that loaded before this one queued their definitions; from now on define() goes straight in
    const pending = Array.isArray(M._pending) ? M._pending.splice(0) : [];
    M.define = (/** @type {any} */ def) => kernel.define(def);
    for (const def of pending) kernel.define(def);
    for (const entry of LAZY) kernel.lazy(entry);

    // the screen side: answers and places for the UI (DOM events, so no UI code depends on the Master)
    const toDom = (/** @type {string} */ topic, /** @type {string} */ type) => bus.subscribe(topic, (/** @type {any} */ d) => { try { W.document.dispatchEvent(new W.CustomEvent(type, { detail: d })); } catch (e) { /* no DOM */ } }, { owner: "master-app" });
    toDom("state.answer", "mu:master-answer");
    toDom("state.poi", "mu:master-poi");
    toDom("state.destination", "mu:master-destination");

    /** Words for a kind right now, without the queue (a reply to the rider's own question). @param {string} kind @param {any} data @param {"advice"|"warning"} [severity] */
    const words = (kind, data, severity = "advice") => persona.phrase({ kind, key: kind, severity, data }, brain.world);
    const WD = M.phrasesRadar ? M.phrasesRadar.WORDS : null;
    const catWords = (/** @type {string} */ c) => (WD && WD.category[c]) || { desi: c, plain: c };

    /** @type {Function|null} */ let untap = null;
    M.live = {
        bus, caps, kernel, brain, persona, output, config, cognition,
        /**
         * Ask the Master anything: Deep Search, answered in the persona's voice.
         * @param {string} query @param {{ chat?: boolean, reset?: boolean }} [o] chat: small talk ("hello"): a quick friendly reply, no web lookup;
         *   reset: forget the conversation so far first
         * @returns {Promise<{ ok: boolean, text: string, display: { title: string, sub: string }, result?: any }>}
         */
        async ask(query, o = {}) {
            const r = await brain.delegate("deep-search", { query, chat: Boolean(o && o.chat), reset: Boolean(o && o.reset) }, { timeoutMs: 60000 });
            if (r.ok && r.result && r.result.spoken) {
                // be honest on screen about an answer nobody checked live: only Gemini with Google Search reads the web
                // just now; every other answer (Gemini without Search, Groq, the local model) is from what the model knows
                const note = r.result.live ? "" : r.result.engine === "ollama" ? "Local AI, not checked live · " : "Not checked live · ";
                return { ok: true, text: r.result.spoken, display: { title: r.result.title, sub: `${note}${r.result.summary}`.slice(0, 140) }, result: r.result };
            }
            const w = words("search.failed", {});
            return { ok: false, text: w.text, display: w.display };
        },
        /**
         * The best place of a category nearby, from memory (instant).
         * @param {string} category hospital | mechanic | service | hotel | food
         */
        async nearest(category) {
            const r = await brain.delegate("poi-best", { category, count: 3 }, { timeoutMs: 2000 });
            const p = r.ok && Array.isArray(r.result) ? r.result[0] : null;
            const cw = catWords(category);
            const w = p ? words("poi.nearest", { place: p.name, distanceM: Math.max(100, p.distanceM), category: cw.desi, screen: { category: cw.plain } })
                : words("poi.none", { category: cw.desi, screen: { category: cw.plain } });
            return { ok: Boolean(p), text: w.text, display: w.display, place: p, alternatives: r.ok ? r.result.slice(1) : [] };
        },
        /** @param {"medical"|"breakdown"} kind */
        async emergency(kind = "medical") {
            const r = await brain.delegate("emergency", { kind }, { timeoutMs: 2000 });
            const p = r.ok && r.result ? r.result.primary : null;
            if (!p) return { ok: false, text: "", display: { title: "", sub: "" }, place: null, emergencyNumber: "112" };
            const w = kind === "medical" ? words("poi.emergency", { place: p.name, distanceM: Math.max(100, p.distanceM) }, "warning")
                : words("poi.nearest", { place: p.name, distanceM: Math.max(100, p.distanceM), category: catWords(p.category).desi, screen: { category: catWords(p.category).plain } });
            return { ok: true, text: w.text, display: w.display, place: p, alternatives: r.result.alternatives || [], emergencyNumber: "112" };
        },
        /** @param {"next"|"previous"|"pause"|"play"} action */
        music: async (action) => { const r = await brain.delegate("music-control", { action }, { timeoutMs: 3000 }); return Boolean(r.ok && r.result && r.result.ok); },
        /** @param {boolean} on @param {number} [minutes] */
        musicTips: async (on, minutes) => brain.delegate("music-mute", on ? { on: false } : { minutes }, { timeoutMs: 2000 }),
        destination: async () => { const r = await brain.delegate("destination-safety", {}, { timeoutMs: 2000 }); return r.ok ? r.result : null; },
        /** Forget what the Master learned about the rider (privacy). */
        async forget() { if (cognition) cognition.forget(); await brain.delegate("context-forget", {}, { timeoutMs: 2000 }); },
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
