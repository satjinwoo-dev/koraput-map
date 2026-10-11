// @ts-check
/* ============================================================================
   MapUnite Master AI — the event bus
   ==============================================================================
   The only way agents and the Master talk. Nobody holds a reference to anyone
   else, so an agent can be added, replaced or removed without touching the
   others.

   TOPICS are dotted names: "report.network.network.weak", "state.ride".
   PATTERNS for subscribe():
     "state.ride"   exactly that topic
     "state.*"      one segment after "state."
     "report.**"    anything under "report" (any depth)
     "**"           everything

   Three ways to talk:
     publish(topic, data)         fire and forget; every matching subscriber gets it
     publish(…, { sticky: true }) also kept as the topic's latest value: last(topic),
                                  and subscribe(…, { replay: true }) gets it at once
     request(topic, data)         ask the one responder registered with handle(topic)
                                  and await its answer (with a timeout)

   GUARANTEES
     - Delivery order is publish order, even when a handler publishes while
       being called (nested publishes are queued, not run inside the handler).
     - A throwing handler never stops the others: the error goes to "bus.error"
       (and onError), tagged with the subscriber's owner.
     - removeOwner(owner) drops every subscription and responder an owner made.
       The kernel uses it so a stopped agent leaves nothing behind.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); (W.MUMaster || (W.MUMaster = {})).bus = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const TOPIC_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/i;
    const PATTERN_RE = /^(\*\*|\*|[a-z0-9_-]+)(\.(\*\*|\*|[a-z0-9_-]+))*$/i;

    /**
     * @typedef {{ id: number, topic: string, data: any, source: string, at: number, sticky: boolean }} Envelope
     * @typedef {(data: any, env: Envelope) => any} Handler
     */

    /** @param {string[]} p @param {number} i @param {string[]} t @param {number} j @returns {boolean} */
    function match(p, i, t, j) {
        if (i === p.length) return j === t.length;
        if (p[i] === "**") {
            if (i === p.length - 1) return true;
            for (let k = j; k <= t.length; k++) if (match(p, i + 1, t, k)) return true;
            return false;
        }
        if (j === t.length) return false;
        return (p[i] === "*" || p[i] === t[j]) && match(p, i + 1, t, j + 1);
    }
    /** @param {string} pattern @returns {(topic: string) => boolean} */
    function compile(pattern) {
        if (!PATTERN_RE.test(pattern)) throw new Error(`bus: bad pattern "${pattern}"`);
        const parts = pattern.split(".");
        if (!pattern.includes("*")) return (topic) => topic === pattern;
        return (topic) => match(parts, 0, topic.split("."), 0);
    }

    /**
     * @param {{
     *   now?: () => number,
     *   timers?: { setTimeout: Function, clearTimeout: Function },
     *   historySize?: number,
     *   onError?: (err: any, env: Envelope, owner: string) => void
     * }} [opts]
     */
    function createBus(opts = {}) {
        const now = opts.now || (() => Date.now());
        const timers = opts.timers || globalThis;
        const historySize = Number.isFinite(opts.historySize) ? /** @type {number} */ (opts.historySize) : 200;
        /** @type {Array<{ id: number, pattern: string, test: (t: string) => boolean, handler: Handler, once: boolean, owner: string, order: number, dead: boolean }>} */
        let subs = [];
        /** @type {Map<string, Envelope>} */ const sticky = new Map();
        /** @type {Map<string, { fn: (data: any, env: Envelope) => any, owner: string }>} */ const responders = new Map();
        /** @type {Envelope[]} */ const history = [];
        /** @type {Set<(env: Envelope) => void>} */ const taps = new Set();
        /** @type {Envelope[]} */ const queue = [];
        let seq = 0, subSeq = 0, dispatching = false;

        function fail(/** @type {any} */ err, /** @type {Envelope} */ env, /** @type {string} */ owner) {
            try { opts.onError && opts.onError(err, env, owner); } catch (e) { /* never let error reporting throw */ }
            if (env.topic !== "bus.error") publish("bus.error", { topic: env.topic, owner, message: String((err && err.message) || err) }, { source: "bus" });
        }

        function deliver(/** @type {Envelope} */ env) {
            for (const tap of taps) { try { tap(env); } catch (e) { /* taps are for debugging only */ } }
            const list = subs.filter((s) => !s.dead && s.test(env.topic));
            for (const s of list) {
                if (s.dead) continue;                         // removed by an earlier handler in this round
                if (s.once) remove(s);
                try {
                    const r = s.handler(env.data, env);
                    if (r && typeof r.then === "function") r.then(null, (/** @type {any} */ err) => fail(err, env, s.owner));
                } catch (err) { fail(err, env, s.owner); }
            }
        }
        function drain() {
            dispatching = true;
            try { while (queue.length) deliver(/** @type {Envelope} */ (queue.shift())); }
            finally { dispatching = false; }
        }

        /**
         * @param {string} topic
         * @param {any} [data]
         * @param {{ source?: string, sticky?: boolean }} [meta]
         * @returns {Envelope}
         */
        function publish(topic, data, meta = {}) {
            if (typeof topic !== "string" || !TOPIC_RE.test(topic)) throw new Error(`bus: bad topic "${topic}"`);
            /** @type {Envelope} */
            const env = Object.freeze({ id: ++seq, topic, data, source: String(meta.source || "app"), at: now(), sticky: Boolean(meta.sticky) });
            if (env.sticky) sticky.set(topic, env);
            history.push(env);
            if (history.length > historySize) history.splice(0, history.length - historySize);
            queue.push(env);
            if (!dispatching) drain();
            return env;
        }

        function remove(/** @type {{ dead: boolean }} */ s) { s.dead = true; subs = subs.filter((x) => x !== s); }

        /**
         * @param {string} pattern
         * @param {Handler} handler
         * @param {{ once?: boolean, replay?: boolean, owner?: string, order?: number }} [o]
         *   order: higher runs first (default 0). replay: get matching sticky values now.
         * @returns {() => void} unsubscribe
         */
        function subscribe(pattern, handler, o = {}) {
            if (typeof handler !== "function") throw new Error("bus: handler must be a function");
            const s = { id: ++subSeq, pattern, test: compile(pattern), handler, once: Boolean(o.once), owner: String(o.owner || "app"), order: Number(o.order) || 0, dead: false };
            subs.push(s);
            subs.sort((a, b) => b.order - a.order || a.id - b.id);
            if (o.replay) {
                for (const env of sticky.values()) {
                    if (s.dead || !s.test(env.topic)) continue;
                    if (s.once) remove(s);
                    try { handler(env.data, env); } catch (err) { fail(err, env, s.owner); }
                }
            }
            return () => remove(s);
        }

        /**
         * The single responder for a request topic.
         * @param {string} topic
         * @param {(data: any, env: Envelope) => any} fn may return a promise
         * @param {{ owner?: string }} [o]
         * @returns {() => void}
         */
        function handle(topic, fn, o = {}) {
            if (!TOPIC_RE.test(topic)) throw new Error(`bus: bad topic "${topic}"`);
            if (responders.has(topic)) throw new Error(`bus: "${topic}" already has a responder (${/** @type {any} */ (responders.get(topic)).owner})`);
            const entry = { fn, owner: String(o.owner || "app") };
            responders.set(topic, entry);
            return () => { if (responders.get(topic) === entry) responders.delete(topic); };
        }

        /**
         * Ask the responder of `topic`. Rejects with code NO_HANDLER, TIMEOUT or the responder's error.
         * @param {string} topic
         * @param {any} [data]
         * @param {{ timeoutMs?: number, source?: string }} [o]
         * @returns {Promise<any>}
         */
        function request(topic, data, o = {}) {
            const r = responders.get(topic);
            if (!r) return Promise.reject(Object.assign(new Error(`bus: nobody handles "${topic}"`), { code: "NO_HANDLER" }));
            /** @type {Envelope} */
            const env = Object.freeze({ id: ++seq, topic, data, source: String(o.source || "app"), at: now(), sticky: false });
            const timeoutMs = Number.isFinite(o.timeoutMs) ? /** @type {number} */ (o.timeoutMs) : 8000;
            return new Promise((resolve, reject) => {
                let done = false;
                const timer = timers.setTimeout(() => { if (!done) { done = true; reject(Object.assign(new Error(`bus: "${topic}" timed out after ${timeoutMs} ms`), { code: "TIMEOUT" })); } }, timeoutMs);
                const finish = (/** @type {boolean} */ ok, /** @type {any} */ v) => { if (done) return; done = true; timers.clearTimeout(timer); ok ? resolve(v) : reject(v); };
                try { Promise.resolve(r.fn(data, env)).then((v) => finish(true, v), (e) => finish(false, e)); }
                catch (e) { finish(false, e); }
            });
        }

        return {
            publish, subscribe, handle, request,
            /** @param {string} topic @returns {any} the latest sticky value */
            last(topic) { const e = sticky.get(topic); return e ? e.data : undefined; },
            /** @param {string} topic */ lastEnvelope(topic) { return sticky.get(topic); },
            /** @param {string} topic */ clearSticky(topic) { sticky.delete(topic); },
            /** Remove everything an owner registered. @param {string} owner */
            removeOwner(owner) {
                for (const s of subs) if (s.owner === owner) s.dead = true;
                subs = subs.filter((s) => !s.dead);
                for (const [t, r] of responders) if (r.owner === owner) responders.delete(t);
            },
            /** Debug: see every envelope. @param {(env: Envelope) => void} fn */
            tap(fn) { taps.add(fn); return () => taps.delete(fn); },
            history() { return history.slice(); },
            /** @param {string} topic */ hasResponder(topic) { return responders.has(topic); },
            get size() { return subs.length; }
        };
    }

    return { createBus, compile };
});
