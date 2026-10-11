// @ts-check
/* ============================================================================
   MapUnite Master AI — agent template (copy me; not loaded by index.html)
   ==============================================================================
   A new sub-agent is ONE file. Copy this to agents/<your-id>-agent.js, fill it
   in, add one <script> tag (or a kernel.lazy() entry), done. Nothing else in
   the system changes.

   The rules that keep the system easy to grow:
     1. Talk only through ctx: ctx.report() to the Master, ctx.setState() for
        shared facts, ctx.bus for anything else. Never call another agent.
     2. Ask for sensors only through ctx.caps, and list them in requires /
        optional. Never touch window.Capacitor, navigator.* or app globals
        directly: add a capability provider instead (capabilities.js).
     3. Report FACTS (kind + data), not sentences. The persona phrases them, the
        brain decides if and when they're said, the gate decides if they're
        spoken. Add your lines to phrases-desi.js (or addPhrases below).
     4. Register everything through ctx (subscribe, timers, onStop, wrap) so
        a stop or a crash cleans up after you automatically.
     5. Keep start() fast. Heavy work (a vision model, a scan) goes in
        handlers or timers, or load the whole agent lazily with kernel.lazy().
   ============================================================================ */
(function (root, factory) {
    const def = factory();
    if (typeof module === "object" && module.exports) module.exports = def;          // node tests: require() it
    else {
        // load order doesn't matter: before the kernel exists, definitions wait in a queue
        const M = /** @type {any} */ (root).MUMaster || (/** @type {any} */ (root).MUMaster = {});
        if (typeof M.define === "function") M.define(def); else (M._pending || (M._pending = [])).push(def);
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    return {
        // ---- identity -----------------------------------------------------------------
        id: "example",                 // lowercase, digits, dashes; unique
        version: "0.1.0",              // semver; define() with a known id hot-swaps the agent
        apiVersion: 1,                 // the contracts.js API_VERSION this was written for
        description: "What this agent watches and what it reports.",

        // ---- what it needs ------------------------------------------------------------
        requires: ["location"],        // capabilities it can't run without: it waits until they exist
        optional: ["route"],           // capabilities it uses when present (ctx.caps.get → null if not)
        depends: ["ride"],             // agents that must be running first
        // Run only while a shared state says so; the kernel starts/stops it automatically:
        runWhen: { topic: "state.ride", test: (/** @type {any} */ ride) => Boolean(ride && ride.active) },
        // heartbeatMs: 30000,         // optional: call ctx.heartbeat() at least this often or be restarted
        // enabledByDefault: false,    // optional: ship it switched off (MUMaster.live.enable("example"))

        // ---- settings (overridable per user: config.agents.example.settings) ----------
        defaults: {
            everyMs: 30000
        },

        /**
         * Called when every requirement is met. May be async (10 s limit).
         * @param {any} ctx
         *   ctx.id, ctx.version, ctx.config (defaults + overrides), ctx.now()
         *   ctx.report(kind, { severity, data, key, category, ttlMs, cooldownMs, ridingOnly, confidence, text })
         *   ctx.setState(name, value)          shared sticky state: state.<name>
         *   ctx.bus.publish / subscribe / last / request / handle
         *   ctx.caps.get(name) / has(name)     only declared capabilities
         *   ctx.store.get / set / remove / keys / clear   on-phone storage, namespaced to this agent
         *   ctx.timers.setTimeout / setInterval / clear   cleared automatically on stop
         *   ctx.wrap(fn)                       guard a callback you give to a capability or the DOM
         *   ctx.onStop(fn), ctx.heartbeat(), ctx.markDegraded(reason), ctx.fail(err)
         *   ctx.log.info / warn / error, ctx.signal (aborted on stop)
         */
        start(ctx) {
            const loc = ctx.caps.get("location");

            // 1. react to a capability (always through ctx.wrap)
            const off = loc.onFix(ctx.wrap((/** @type {any} */ fix) => {
                if (fix.speedMs > 30) {
                    ctx.report("example.fast", {
                        severity: "warning",                 // critical | warning | advice | info
                        key: "example.speed",                // same key = newer replaces older in the queue
                        category: "speed",                   // the gate's category (speed cues pause on weak GPS)
                        data: { speedKmh: Math.round(fix.speedMs * 3.6) },
                        ridingOnly: true
                    });
                }
            }));
            ctx.onStop(off);

            // 2. react to shared state from other agents
            ctx.bus.subscribe("state.network", (/** @type {any} */ net) => {
                if (net && net.level === "offline") ctx.log.info("offline; pausing uploads");
            }, { replay: true });

            // 3. offer a service the Master (or another agent) can delegate to
            ctx.bus.handle("task.example-lookup", async (/** @type {any} */ query) => ({ answer: `looked up ${query && query.q}` }));

            // 4. periodic work
            ctx.timers.setInterval(() => ctx.setState("example", { at: ctx.now() }), ctx.config.everyMs);
        },

        /** Optional: anything ctx didn't register. Subscriptions/timers are already cleaned up. */
        stop(/** @type {any} */ ctx) { /* nothing */ }
    };
});

/* Phrases for the reports above (or put them in phrases-desi.js):
   MUMaster.live.persona.addPhrases("desi", {
     "example.fast": { warning: [{ say: "{{name}}, {{speedKmh}} pe chal raha hai, thoda dheere.", title: "Speed kam kar", sub: "{{speedKmh}} km/h" }] }
   });
*/
