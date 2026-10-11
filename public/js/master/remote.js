// @ts-check
/* ============================================================================
   MapUnite Master AI — the "master-api" capability (the phone ↔ our server)
   ==============================================================================
   Every cognitive engine that needs the outside world (weather, traffic, road,
   blackspots, places, search, music) calls OUR server, never a third party:
   API keys live only on the server (lib/master/http-api.js).

     const api = ctx.caps.get("master-api");
     const r = await api.post("/weather", { points }, { timeoutMs: 8000, signal: ctx.signal });
     r → { ok, status, data, ms, bytes, reason }        (never throws)

   - Base URL: window.MU_SERVER_ORIGIN (the Android app) or the page's origin.
   - Offline (navigator.onLine false, or the network agent's state is
     "offline") → { ok: false, reason: "offline" } at once: no timeouts piling up
     in a tunnel.
   - Identical requests in flight are shared (two agents asking the same thing
     cost one request).
   - A 503 "…-not-configured" is remembered for 10 minutes per path, so a
     feature that the server doesn't offer isn't asked for every 30 s.
   - Every response's size and time is offered to onSample() listeners: the
     link agent turns them into a FREE bandwidth estimate (no test downloads
     needed while the app is busy anyway).
   - credentials: "omit": no cookies; nothing identifies the rider.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); (W.MUMaster || (W.MUMaster = {})).remote = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /**
     * @param {{
     *   window?: any, fetchImpl?: Function, base?: () => string, now?: () => number,
     *   online?: () => boolean
     * }} [o]
     */
    function createMasterApiProvider(o = {}) {
        const W = o.window || (typeof window !== "undefined" ? window : /** @type {any} */ ({}));
        const fetchImpl = o.fetchImpl || (W.fetch ? W.fetch.bind(W) : null);
        const now = o.now || (() => (W.performance && W.performance.now ? W.performance.now() : Date.now()));
        const base = o.base || (() => `${W.MU_SERVER_ORIGIN || (W.location && W.location.origin) || ""}/api/master`);
        const online = o.online || (() => !(W.navigator && W.navigator.onLine === false));
        /** @type {Map<string, Promise<any>>} */ const inflight = new Map();
        /** @type {Map<string, number>} path → until (ms, Date) */ const notConfigured = new Map();
        /** @type {Set<Function>} */ const samplers = new Set();
        let offlineHint = false;

        /**
         * @param {"GET"|"POST"} method @param {string} path @param {any} body
         * @param {{ timeoutMs?: number, signal?: AbortSignal, raw?: boolean }} c
         */
        async function call(method, path, body, c = {}) {
            if (!fetchImpl) return { ok: false, status: 0, data: null, reason: "no-fetch" };
            if (!online() || offlineHint) return { ok: false, status: 0, data: null, reason: "offline" };
            const nc = notConfigured.get(path);
            if (nc && Date.now() < nc) return { ok: false, status: 503, data: null, reason: "not-configured" };
            const key = `${method} ${path} ${body ? JSON.stringify(body) : ""}`;
            const running = inflight.get(key);
            if (running) return running;
            const p = (async () => {
                const ctl = typeof AbortController === "function" ? new AbortController() : null;
                const timer = setTimeout(() => ctl && ctl.abort(), c.timeoutMs || 10000);
                const onAbort = () => ctl && ctl.abort();
                if (c.signal) { if (c.signal.aborted) onAbort(); else c.signal.addEventListener("abort", onAbort, { once: true }); }
                const t0 = now();
                try {
                    const res = await fetchImpl(`${base()}${path}`, {
                        method, credentials: "omit", cache: "no-store",
                        headers: body ? { "content-type": "application/json" } : undefined,
                        body: body ? JSON.stringify(body) : undefined,
                        signal: ctl ? ctl.signal : undefined
                    });
                    let bytes = 0, data = null;
                    if (c.raw) { const buf = await res.arrayBuffer(); bytes = buf.byteLength; }
                    else { const text = await res.text(); bytes = text.length; try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; } }
                    const ms = Math.max(1, Math.round(now() - t0));
                    for (const fn of samplers) { try { fn({ bytes, ms, path, status: res.status }); } catch (e) { /* listeners are independent */ } }
                    const reason = data && typeof data.reason === "string" ? data.reason : res.ok ? "" : `http-${res.status}`;
                    if (res.status === 503 && /-not-configured$/.test(reason)) notConfigured.set(path, Date.now() + 600000);
                    return { ok: Boolean(res.ok && (c.raw || (data && data.ok !== false))), status: res.status, data, ms, bytes, reason };
                } catch (e) {
                    const aborted = Boolean(c.signal && c.signal.aborted);
                    return { ok: false, status: 0, data: null, ms: Math.round(now() - t0), bytes: 0, reason: aborted ? "aborted" : "unreachable" };
                } finally {
                    clearTimeout(timer);
                    if (c.signal) c.signal.removeEventListener("abort", onAbort);
                    inflight.delete(key);
                }
            })();
            inflight.set(key, p);
            return p;
        }

        return {
            available: () => Boolean(fetchImpl),
            /** @param {string} path @param {any} body @param {{ timeoutMs?: number, signal?: AbortSignal }} [c] */
            post: (path, body, c) => call("POST", path, body, c),
            /** @param {string} path @param {{ timeoutMs?: number, signal?: AbortSignal, raw?: boolean }} [c] */
            get: (path, c) => call("GET", path, null, c),
            /** Size/time of every response, for bandwidth estimates. @param {(s: { bytes: number, ms: number, path: string, status: number }) => void} fn */
            onSample(fn) { samplers.add(fn); return () => samplers.delete(fn); },
            /** The network agent knows better than navigator.onLine (a dead tower still says "online"). @param {boolean} off */
            setOffline(off) { offlineHint = Boolean(off); },
            /** @param {string} path */ isConfigured: (path) => !(notConfigured.get(path) > Date.now())
        };
    }

    return { createMasterApiProvider };
});
