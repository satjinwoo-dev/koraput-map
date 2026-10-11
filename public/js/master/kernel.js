// @ts-check
/* ============================================================================
   MapUnite Master AI — the kernel (agent registry and lifecycle)
   ==============================================================================
   Sub-agents are plug-ins. An agent is a plain object (see agents/_template.js):

     MUMaster.define({
       id: "network", version: "1.0.0", apiVersion: 1,
       requires: ["network"],          // capabilities it can't work without
       optional: ["location"],         // capabilities it uses when present
       depends:  ["ride"],             // other agents that must be running first
       runWhen:  { topic: "state.ride", test: (ride) => ride && ride.active },
       heartbeatMs: 30000,             // optional watchdog
       defaults: { … },                // settings, overridable from config
       start(ctx) { … }, stop(ctx) { … }
     });

   The kernel decides WHEN each agent runs and keeps a crashing agent from
   taking anything else down:

     registered → waiting (needs a capability / agent / condition)
                → starting → running ⇄ degraded
                → failed (restarted with back-off 1 s, 2 s, 4 s … 60 s;
                          after 5 restarts in 10 min it stays failed until
                          restart(id))
                → stopped / disabled

   - Everything an agent registers through ctx (subscriptions, responders,
     timers, onStop callbacks) is removed when it stops, so a stop or a crash
     never leaves a ghost listener behind.
   - An exception in an agent's handler is caught and counted: 3 in a minute
     marks it degraded, 10 in a minute restarts it.
   - define() with an id that already exists hot-swaps the agent (stop old,
     start new): updates don't need an app restart.
   - lazy({ id, src, loadOn }) loads an agent's script only when a topic first
     fires (e.g. the heavy Vision engine when the first break starts).
   - Each agent reads only the capabilities it declared; asking for an
     undeclared one throws, so dependencies stay visible in the definition.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); (W.MUMaster || (W.MUMaster = {})).kernel = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const ACTIVE = new Set(["starting", "running", "degraded"]);

    function memoryStore() {
        /** @type {Map<string, any>} */ const m = new Map();
        return {
            get: (/** @type {string} */ k, /** @type {any} */ f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f),
            set: (/** @type {string} */ k, /** @type {any} */ v) => { m.set(k, JSON.stringify(v)); return true; },
            remove: (/** @type {string} */ k) => { m.delete(k); },
            keys: () => [...m.keys()],
            clear: () => m.clear()
        };
    }

    function defaultLoadScript(/** @type {string} */ src) {
        return new Promise((resolve, reject) => {
            const d = /** @type {any} */ (globalThis).document;
            if (!d) { reject(new Error("no document to load scripts into")); return; }
            const s = d.createElement("script");
            s.src = src; s.async = false;
            s.onload = () => resolve(undefined);
            s.onerror = () => reject(new Error(`couldn't load ${src}`));
            d.head.appendChild(s);
        });
    }

    /**
     * @param {{
     *   bus: any, caps: any, contracts: any,
     *   now?: () => number,
     *   timers?: { setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function },
     *   config?: { agents?: Record<string, { enabled?: boolean, settings?: Record<string, any> }> },
     *   log?: { info?: Function, warn?: Function, error?: Function },
     *   loadScript?: (src: string) => Promise<any>,
     *   onConfigChange?: (config: any) => void,
     *   startTimeoutMs?: number, maxRestarts?: number, restartWindowMs?: number,
     *   baseBackoffMs?: number, maxBackoffMs?: number, watchdogMs?: number
     * }} opts
     */
    function createKernel(opts) {
        const { bus, caps, contracts } = opts;
        const now = opts.now || (() => Date.now());
        const timers = opts.timers || globalThis;
        const config = opts.config || {};
        if (!config.agents) config.agents = {};
        const log = opts.log || console;
        const loadScript = opts.loadScript || defaultLoadScript;
        const T = {
            start: opts.startTimeoutMs ?? 10000, maxRestarts: opts.maxRestarts ?? 5, window: opts.restartWindowMs ?? 600000,
            base: opts.baseBackoffMs ?? 1000, maxBackoff: opts.maxBackoffMs ?? 60000, watchdog: opts.watchdogMs ?? 5000
        };

        /**
         * @typedef {{
         *   def: any, state: string, reason: string, gen: number, ctx: any,
         *   cleanup: Function[], timerIds: Set<any>, abort: AbortController|null,
         *   restarts: number[], errors: number[], lastError: string|null,
         *   startedAt: number|null, lastBeat: number, retryAt: number|null, retryTimer: any, permanent: boolean
         * }} Rec
         */
        /** @type {Map<string, Rec>} */ const agents = new Map();
        /** @type {Set<string>} */ const loading = new Set();
        let running = false, evaluating = false, dirty = false;
        /** @type {Function[]} */ let unsubs = [];
        let watchdog = /** @type {any} */ (null);

        const say = (/** @type {"info"|"warn"|"error"} */ lvl, /** @type {any[]} */ ...a) => { try { const f = log[lvl] || log.warn; f && f.call(log, "[master]", ...a); } catch (e) { /* logging is best-effort */ } };
        const msg = (/** @type {any} */ err) => String((err && err.message) || err);

        function setState(/** @type {Rec} */ rec, /** @type {string} */ state, reason = "") {
            if (rec.state === state && rec.reason === reason) return;
            rec.state = state; rec.reason = reason;
            bus.publish(contracts.TOPIC.lifecycle, { id: rec.def.id, version: rec.def.version, state, reason }, { source: "kernel" });
        }

        function isEnabled(/** @type {Rec} */ rec) {
            const c = config.agents && config.agents[rec.def.id];
            if (c && typeof c.enabled === "boolean") return c.enabled;
            return rec.def.enabledByDefault !== false;
        }

        /** @param {Rec} rec @returns {{ ok: boolean, state?: string, reason?: string }} */
        function canRun(rec) {
            const def = rec.def;
            if (!isEnabled(rec)) return { ok: false, state: "disabled", reason: "turned off" };
            for (const dep of def.depends || []) {
                const d = agents.get(dep);
                if (!d) return { ok: false, state: "waiting", reason: `needs agent "${dep}"` };
                if (d.state !== "running" && d.state !== "degraded") return { ok: false, state: "waiting", reason: `waiting for agent "${dep}"` };
            }
            for (const cap of def.requires || []) if (!caps.has(cap)) return { ok: false, state: "waiting", reason: `needs ${cap}` };
            if (def.runWhen) {
                let ok = false;
                try { ok = Boolean(def.runWhen.test(bus.last(def.runWhen.topic))); } catch (e) { ok = false; }
                if (!ok) return { ok: false, state: "waiting", reason: `idle until ${def.runWhen.topic}` };
            }
            return { ok: true };
        }

        /** Dependency order; agents in a cycle are failed for good. @returns {Rec[]} */
        function order() {
            /** @type {Rec[]} */ const out = [];
            /** @type {Map<string, number>} */ const mark = new Map();     // 1 visiting, 2 done
            /** @type {Set<string>} */ const cyclic = new Set();
            const visit = (/** @type {string} */ id, /** @type {string[]} */ stack) => {
                const rec = agents.get(id);
                if (!rec) return;
                const m = mark.get(id);
                if (m === 2) return;
                if (m === 1) { for (const s of stack.slice(stack.indexOf(id))) cyclic.add(s); return; }
                mark.set(id, 1);
                for (const dep of rec.def.depends || []) visit(dep, [...stack, id]);
                mark.set(id, 2);
                out.push(rec);
            };
            for (const id of agents.keys()) visit(id, []);
            for (const id of cyclic) {
                const rec = /** @type {Rec} */ (agents.get(id));
                if (ACTIVE.has(rec.state)) teardown(rec);
                rec.permanent = true;
                setState(rec, "failed", "dependency cycle");
            }
            return out.filter((r) => !cyclic.has(r.def.id));
        }

        function evaluate() {
            if (!running) return;
            if (evaluating) { dirty = true; return; }
            evaluating = true;
            try {
                let rounds = 0;
                do { dirty = false; pass(); } while (dirty && ++rounds < 20);
            } finally { evaluating = false; }
        }

        function pass() {
            for (const rec of order()) {
                const want = canRun(rec);
                const active = ACTIVE.has(rec.state);
                if (want.ok) {
                    if (rec.state === "failed") {
                        if (!rec.permanent && rec.retryAt !== null && now() >= rec.retryAt) startAgent(rec);
                    } else if (!active) startAgent(rec);
                } else if (active) {
                    teardown(rec);
                    setState(rec, want.state || "waiting", want.reason || "");
                } else if (rec.state !== "failed" || want.state === "disabled") {
                    setState(rec, want.state || "waiting", want.reason || "");
                }
            }
        }

        function noteError(/** @type {Rec} */ rec, /** @type {any} */ err, /** @type {number} */ gen) {
            if (gen !== rec.gen) return;
            const t = now();
            rec.errors = rec.errors.filter((x) => t - x < 60000);
            rec.errors.push(t);
            rec.lastError = msg(err);
            say("warn", `agent "${rec.def.id}" error:`, err);
            if (rec.errors.length >= 10) fail(rec, new Error(`too many errors (${rec.lastError})`), gen);
            else if (rec.errors.length >= 3 && rec.state === "running") setState(rec, "degraded", `errors: ${rec.lastError}`);
        }

        /** @param {Rec} rec @param {number} gen */
        function makeCtx(rec, gen) {
            const def = rec.def, id = def.id, owner = `agent:${id}`;
            const declared = new Set([...(def.requires || []), ...(def.optional || [])]);
            const alive = () => rec.gen === gen;
            const guard = (/** @type {Function} */ fn) => function (/** @type {any[]} */ ...args) {
                if (!alive()) return undefined;
                try {
                    // @ts-ignore
                    const r = fn.apply(this, args);
                    if (r && typeof r.then === "function") r.then(null, (/** @type {any} */ e) => noteError(rec, e, gen));
                    return r;
                } catch (e) { noteError(rec, e, gen); return undefined; }
            };
            const cfg = (config.agents && config.agents[id]) || {};
            const settings = Object.freeze({ ...(def.defaults || {}), ...(cfg.settings || {}) });
            const storeProvider = caps.get("store");
            const store = storeProvider && typeof storeProvider.namespace === "function" ? storeProvider.namespace(id) : memoryStore();
            const prefix = `[agent:${id}]`;
            return Object.freeze({
                id, version: def.version, config: settings, now,
                signal: rec.abort ? rec.abort.signal : undefined,
                log: Object.freeze({
                    info: (/** @type {any[]} */ ...a) => say("info", prefix, ...a),
                    warn: (/** @type {any[]} */ ...a) => say("warn", prefix, ...a),
                    error: (/** @type {any[]} */ ...a) => say("error", prefix, ...a)
                }),
                bus: Object.freeze({
                    publish: (/** @type {string} */ topic, /** @type {any} */ data, /** @type {any} */ meta = {}) => bus.publish(topic, data, { ...meta, source: id }),
                    subscribe: (/** @type {string} */ pattern, /** @type {Function} */ handler, /** @type {any} */ o = {}) => bus.subscribe(pattern, guard(handler), { ...o, owner }),
                    last: (/** @type {string} */ topic) => bus.last(topic),
                    request: (/** @type {string} */ topic, /** @type {any} */ data, /** @type {any} */ o = {}) => bus.request(topic, data, { ...o, source: id }),
                    handle: (/** @type {string} */ topic, /** @type {Function} */ fn) => bus.handle(topic, (/** @type {any} */ d, /** @type {any} */ env) => {
                        if (!alive()) throw new Error(`agent "${id}" has stopped`);
                        return fn(d, env);
                    }, { owner })
                }),
                /** Send a report to the Master. @param {string} kind @param {any} [payload] */
                report(kind, payload = {}) {
                    if (!alive()) return null;
                    return bus.publish(contracts.TOPIC.report(id, kind), { ...payload, kind }, { source: id });
                },
                /** Share world state (sticky): state.<name>. @param {string} name @param {any} value */
                setState(name, value) {
                    if (!alive()) return null;
                    return bus.publish(contracts.TOPIC.state(name), value, { source: id, sticky: true });
                },
                caps: Object.freeze({
                    /** @param {string} name */
                    get(name) {
                        if (!declared.has(name)) throw new Error(`agent "${id}" must list "${name}" in requires or optional`);
                        return caps.has(name) ? caps.get(name) : null;
                    },
                    /** @param {string} name */ has: (name) => declared.has(name) && caps.has(name)
                }),
                store,
                timers: Object.freeze({
                    setTimeout(/** @type {Function} */ fn, /** @type {number} */ ms) {
                        const g = guard(fn);
                        const h = timers.setTimeout(() => { rec.timerIds.delete(h); g(); }, ms);
                        rec.timerIds.add(h);
                        return h;
                    },
                    setInterval(/** @type {Function} */ fn, /** @type {number} */ ms) {
                        const h = timers.setInterval(guard(fn), ms);
                        rec.timerIds.add(h);
                        return h;
                    },
                    clear(/** @type {any} */ h) { timers.clearTimeout(h); timers.clearInterval(h); rec.timerIds.delete(h); }
                }),
                /** Wrap a callback you hand to anything outside ctx (a capability's onFix, a DOM event):
                    errors are counted against this agent and it goes quiet once the agent stops. @param {Function} fn */
                wrap(fn) { return guard(fn); },
                heartbeat() { if (alive()) rec.lastBeat = now(); },
                /** @param {Function} fn */ onStop(fn) { if (alive()) rec.cleanup.push(fn); },
                /** The agent says it's broken; the kernel restarts it. @param {any} err */
                fail(err) { fail(rec, err instanceof Error ? err : new Error(String(err)), gen); },
                /** Still running but limited (e.g. an optional permission was denied). "" clears it. @param {string} reason */
                markDegraded(reason) { if (alive() && (rec.state === "running" || rec.state === "degraded")) setState(rec, reason ? "degraded" : "running", reason || ""); }
            });
        }

        function startAgent(/** @type {Rec} */ rec) {
            const gen = ++rec.gen;
            rec.abort = typeof AbortController === "function" ? new AbortController() : null;
            rec.cleanup = []; rec.timerIds = new Set(); rec.errors = [];
            if (rec.retryTimer) { timers.clearTimeout(rec.retryTimer); rec.retryTimer = null; }
            setState(rec, "starting", "");
            const ctx = makeCtx(rec, gen);
            rec.ctx = ctx;
            /** @type {any} */ let result;
            try { result = rec.def.start(ctx); } catch (err) { fail(rec, err, gen); return; }
            const ready = () => { rec.startedAt = now(); rec.lastBeat = now(); rec.retryAt = null; setState(rec, "running", ""); };
            if (result && typeof result.then === "function") {
                const t = timers.setTimeout(() => { if (rec.gen === gen && rec.state === "starting") fail(rec, new Error(`start() took longer than ${T.start} ms`), gen); }, T.start);
                result.then(
                    () => { timers.clearTimeout(t); if (rec.gen === gen && rec.state === "starting") { ready(); evaluate(); } },
                    (/** @type {any} */ err) => { timers.clearTimeout(t); if (rec.gen === gen) fail(rec, err, gen); });
            } else ready();
        }

        /** Stop an agent and remove everything it registered. */
        function teardown(/** @type {Rec} */ rec) {
            const ctx = rec.ctx;
            if (ctx && typeof rec.def.stop === "function") { try { rec.def.stop(ctx); } catch (e) { say("warn", `agent "${rec.def.id}" stop() threw:`, e); } }
            for (const fn of rec.cleanup.splice(0).reverse()) { try { fn(); } catch (e) { say("warn", `agent "${rec.def.id}" onStop threw:`, e); } }
            rec.gen++;                                                   // late handlers, timers and promises are ignored from here
            for (const h of rec.timerIds) { timers.clearTimeout(h); timers.clearInterval(h); }
            rec.timerIds.clear();
            try { rec.abort && rec.abort.abort(); } catch (e) { /* ignore */ }
            rec.abort = null;
            bus.removeOwner(`agent:${rec.def.id}`);
            rec.ctx = null;
            rec.startedAt = null;
        }

        function fail(/** @type {Rec} */ rec, /** @type {any} */ err, /** @type {number} [gen] */ gen) {
            if (gen !== undefined && gen !== rec.gen) return;
            if (rec.ctx) teardown(rec);
            const text = msg(err);
            rec.lastError = text;
            say("warn", `agent "${rec.def.id}" failed:`, err);
            const t = now();
            rec.restarts = rec.restarts.filter((x) => t - x < T.window);
            if (rec.restarts.length >= T.maxRestarts) {
                rec.permanent = true; rec.retryAt = null;
                setState(rec, "failed", `crashed ${rec.restarts.length + 1} times: ${text}`);
                evaluate();
                return;
            }
            const backoff = Math.min(T.maxBackoff, T.base * 2 ** rec.restarts.length);
            rec.restarts.push(t);
            rec.retryAt = t + backoff;
            setState(rec, "failed", `${text} (retry in ${Math.round(backoff / 1000)} s)`);
            if (rec.retryTimer) timers.clearTimeout(rec.retryTimer);
            rec.retryTimer = timers.setTimeout(() => { rec.retryTimer = null; evaluate(); }, backoff);
            evaluate();                                                  // agents that depend on this one stop now
        }

        // ------------------------------------------------------------------ public
        /** @param {any} def @returns {boolean} accepted? */
        function define(def) {
            const v = contracts.validateAgent(def);
            if (!v.ok) {
                say("warn", `agent "${def && def.id}" rejected:`, v.errors.join("; "));
                bus.publish(contracts.TOPIC.lifecycle, { id: def && def.id, state: "rejected", reason: v.errors.join("; ") }, { source: "kernel" });
                return false;
            }
            loading.delete(def.id);
            let rec = agents.get(def.id);
            if (rec) {
                if (ACTIVE.has(rec.state)) teardown(rec);
                if (rec.retryTimer) { timers.clearTimeout(rec.retryTimer); rec.retryTimer = null; }
                rec.def = def; rec.restarts = []; rec.permanent = false; rec.retryAt = null; rec.lastError = null;
                setState(rec, "registered", `updated to ${def.version}`);
            } else {
                rec = { def, state: "", reason: "", gen: 0, ctx: null, cleanup: [], timerIds: new Set(), abort: null, restarts: [], errors: [], lastError: null, startedAt: null, lastBeat: 0, retryAt: null, retryTimer: null, permanent: false };
                agents.set(def.id, rec);
                setState(rec, "registered", "");
            }
            evaluate();
            return true;
        }

        /**
         * Load an agent's script the first time `loadOn` fires (sticky values count).
         * @param {{ id: string, src: string, loadOn: string, test?: (data: any) => boolean }} entry
         */
        function lazy(entry) {
            if (agents.has(entry.id) || loading.has(entry.id)) return;
            let fired = false;
            /** @type {Function|null} */ let un = null;
            const go = (/** @type {any} */ data) => {
                if (fired) return;
                if (entry.test) { let ok = false; try { ok = Boolean(entry.test(data)); } catch (e) { ok = false; } if (!ok) return; }
                fired = true;
                if (un) un();
                loading.add(entry.id);
                bus.publish(contracts.TOPIC.lifecycle, { id: entry.id, state: "loading", reason: entry.src }, { source: "kernel" });
                Promise.resolve().then(() => loadScript(entry.src)).then(
                    () => { if (!agents.has(entry.id)) { loading.delete(entry.id); say("warn", `${entry.src} loaded but didn't define agent "${entry.id}"`); } },
                    (/** @type {any} */ err) => { loading.delete(entry.id); bus.publish(contracts.TOPIC.lifecycle, { id: entry.id, state: "load-failed", reason: msg(err) }, { source: "kernel" }); });
            };
            un = bus.subscribe(entry.loadOn, go, { owner: "kernel", replay: true });
            if (fired) un();
            unsubs.push(un);
        }

        function start() {
            if (running) return;
            running = true;
            // re-check when a runWhen topic changes, or a capability comes or goes
            unsubs.push(bus.subscribe("state.**", (/** @type {any} */ _d, /** @type {any} */ env) => {
                for (const rec of agents.values()) if (rec.def.runWhen && rec.def.runWhen.topic === env.topic) { evaluate(); return; }
            }, { owner: "kernel" }));
            unsubs.push(caps.onChange(() => evaluate()));
            watchdog = timers.setInterval(() => {
                for (const rec of agents.values()) {
                    const hb = rec.def.heartbeatMs;
                    if (hb && (rec.state === "running" || rec.state === "degraded") && now() - rec.lastBeat > hb * 3) fail(rec, new Error("stopped responding (no heartbeat)"), rec.gen);
                }
                for (const rec of agents.values()) if (rec.state === "failed" && !rec.permanent && rec.retryAt !== null && now() >= rec.retryAt) { evaluate(); break; }
            }, T.watchdog);
            evaluate();
        }

        function shutdown() {
            if (!running) return;
            running = false;
            if (watchdog) { timers.clearInterval(watchdog); watchdog = null; }
            for (const fn of unsubs.splice(0)) { try { fn(); } catch (e) { /* ignore */ } }
            for (const rec of order().reverse()) {
                if (rec.retryTimer) { timers.clearTimeout(rec.retryTimer); rec.retryTimer = null; }
                if (ACTIVE.has(rec.state)) teardown(rec);
                setState(rec, "stopped", "shutdown");
            }
        }

        const snapshot = (/** @type {Rec} */ r) => ({
            id: r.def.id, version: r.def.version, description: r.def.description || "", state: r.state, reason: r.reason,
            startedAt: r.startedAt, lastError: r.lastError, recentErrors: r.errors.length, restarts: r.restarts.length,
            requires: [...(r.def.requires || [])], depends: [...(r.def.depends || [])]
        });
        const setEnabled = (/** @type {string} */ id, /** @type {boolean} */ on) => {
            config.agents = config.agents || {};
            config.agents[id] = { ...(config.agents[id] || {}), enabled: on };
            try { opts.onConfigChange && opts.onConfigChange(config); } catch (e) { /* ignore */ }
            const rec = agents.get(id);
            if (rec && on && rec.state === "failed") { rec.permanent = false; rec.restarts = []; rec.retryAt = now(); }
            evaluate();
        };

        return {
            define, lazy, start, shutdown,
            /** @param {string} id */ enable: (id) => setEnabled(id, true),
            /** @param {string} id */ disable: (id) => setEnabled(id, false),
            /** Clear a crash history and start again. @param {string} id */
            restart(id) {
                const rec = agents.get(id);
                if (!rec) return false;
                if (ACTIVE.has(rec.state)) teardown(rec);
                if (rec.retryTimer) { timers.clearTimeout(rec.retryTimer); rec.retryTimer = null; }
                rec.restarts = []; rec.permanent = false; rec.retryAt = null;
                setState(rec, "stopped", "restart");
                evaluate();
                return true;
            },
            /** Re-check every agent now (e.g. after a permission change). */
            refresh: () => evaluate(),
            status: () => order().map(snapshot),
            /** @param {string} id */ get: (id) => { const r = agents.get(id); return r ? snapshot(r) : null; },
            /** @param {string} id */ has: (id) => agents.has(id),
            get running() { return running; },
            config
        };
    }

    return { createKernel };
});
