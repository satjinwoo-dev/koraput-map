// @ts-check
/* ============================================================================
   MapUnite Master AI — Network agent ("network")
   ==============================================================================
   Watches network health and warns before and when you lose signal.

   HEALTH  good / weak / offline, from:
     - the OS's online flag and connection type (Capacitor Network plugin when
       bundled, the browser's navigator.connection otherwise);
     - a small round trip to our own server (/api/config) every 20 s while
       riding, every 60 s otherwise. "Connected" to a dead tower is offline
       after 2 failed probes; a slow round trip (> 1.5 s) is weak.

   NO-SIGNAL ZONES AHEAD (learned on this phone, nothing is uploaded)
     When the signal drops during a ride, the ~1 km map cells you're in are
     remembered. Later, riding a route that passes through a remembered cell
     300 m – 2 km ahead, you're told in time to send that message (after
     stopping). Riding through a cell with good signal twice as often as it
     failed forgets it again, so the map corrects itself.
     Nobody's coverage map is used: the phone learns from your own rides.

   Reports (all key "network.status" except zones, so a newer state replaces
   an unsaid older one in the Master's queue):
     network.lost      warning while riding / navigating, advice otherwise;
                       once per 5 min at most, flapping stays quiet
     network.weak      warning while navigating, advice otherwise
     network.restored  advice if it was gone ≥ 60 s, info otherwise
     network.zone-ahead  advice, ridingOnly

   Shares state.network = { level, since, connected, type, rttMs, knownZones }.
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

    const R = 6371000;
    /** @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 */
    function metres(lat1, lng1, lat2, lng2) {
        const toRad = Math.PI / 180;
        const dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    return {
        id: "network",
        version: "1.0.0",
        apiVersion: 1,
        description: "Network health, no-signal warnings and learned no-signal zones on your routes.",
        requires: ["network"],
        optional: ["location", "route", "drive"],
        defaults: {
            probeRidingMs: 20000,
            probeIdleMs: 60000,
            probeTimeoutMs: 4000,
            weakRttMs: 1500,
            weakDownlinkMbps: 0.25,
            failuresForLost: 2,
            restoredSpeakAfterMs: 60000,
            lostRepeatMs: 300000,
            cellDeg: 0.01,             // ≈ 1.1 km cells
            lookAheadM: 2000,
            minAheadM: 300,
            zoneCooldownMs: 1800000,
            zoneCheckEveryMs: 10000,
            maxCells: 600
        },

        /** @param {any} ctx */
        start(ctx) {
            const cfg = ctx.config;
            const net = ctx.caps.get("network");
            const loc = ctx.caps.get("location");
            const route = ctx.caps.get("route");
            const drive = ctx.caps.get("drive");

            /** @type {Record<string, { hits: number, good: number, last: number }>} */
            const cells = ctx.store.get("deadCells", {}) || {};
            let level = "unknown", since = ctx.now(), failures = 0;
            /** @type {number|null} */ let rtt = null;
            let lastLostReport = -Infinity, lastZoneCheck = -Infinity, cursor = 0;
            /** @type {any} */ let routeRef = null;
            /** @type {string|null} */ let lastCell = null;
            /** @type {Set<string>} cells already counted in this outage */ let outageCells = new Set();
            /** @type {Map<string, number>} */ const warned = new Map();

            const riding = () => { const r = ctx.bus.last("state.ride"); return Boolean(r && r.active); };
            const navigating = () => Boolean(drive && drive.current().navigating);
            const cellKey = (/** @type {number} */ lat, /** @type {number} */ lng) => `${Math.round(lat / cfg.cellDeg)}:${Math.round(lng / cfg.cellDeg)}`;
            const saveCells = () => {
                const keys = Object.keys(cells);
                if (keys.length > cfg.maxCells) keys.sort((a, b) => cells[a].last - cells[b].last).slice(0, keys.length - cfg.maxCells).forEach((k) => delete cells[k]);
                ctx.store.set("deadCells", cells);
            };

            function share() {
                const st = net.status();
                ctx.setState("network", { level, since, connected: st.connected, type: st.type, rttMs: rtt, knownZones: Object.keys(cells).length });
            }

            /** @param {any} st */
            function classify(st) {
                if (!st.connected || failures >= cfg.failuresForLost) return "offline";
                const r = rtt !== null ? rtt : st.rttMs;
                const slowType = st.type === "slow-2g" || st.type === "2g";
                const slowLink = Number.isFinite(st.downlinkMbps) && st.downlinkMbps > 0 && st.downlinkMbps < cfg.weakDownlinkMbps;
                if (slowType || slowLink || (Number.isFinite(r) && r > cfg.weakRttMs)) return "weak";
                return "good";
            }

            /** Count the cell we're in as a no-signal cell (once per outage). */
            function markDead(/** @type {any} */ f) {
                if (!f || !Number.isFinite(f.lat) || !Number.isFinite(f.lng) || !riding()) return;
                const k = cellKey(f.lat, f.lng);
                if (outageCells.has(k)) return;
                outageCells.add(k);
                const c = cells[k] || { hits: 0, good: 0, last: 0 };
                c.hits++; c.last = ctx.now();
                cells[k] = c;
                saveCells();
            }

            function apply(/** @type {string} */ next) {
                if (next === level) return;
                const t = ctx.now(), prev = level, goneMs = t - since;
                level = next; since = t;
                share();
                if (prev === "unknown" && next === "good") return;           // starting up fine: nothing to say
                const nav = navigating(), ride = riding();
                if (next === "offline") {
                    outageCells = new Set();
                    markDead(loc && loc.current());
                    const repeat = t - lastLostReport < cfg.lostRepeatMs;
                    if (!repeat) lastLostReport = t;
                    ctx.report("network.lost", { severity: repeat ? "info" : nav || ride ? "warning" : "advice", key: "network.status", category: "network", data: { navigating: nav } });
                } else if (next === "weak") {
                    ctx.report("network.weak", { severity: nav ? "warning" : "advice", key: "network.status", category: "network", data: { navigating: nav, rttMs: rtt }, cooldownMs: 600000 });
                } else if (prev === "offline" || prev === "weak") {
                    const speak = prev === "offline" && goneMs >= cfg.restoredSpeakAfterMs;
                    ctx.report("network.restored", { severity: speak ? "advice" : "info", key: "network.status", category: "network", data: { goneSec: Math.round(goneMs / 1000) } });
                }
            }

            async function probe() {
                const st = net.status();
                if (!st.connected) { apply("offline"); return; }
                const r = await net.probe({ timeoutMs: cfg.probeTimeoutMs });
                if (r && r.ok) { failures = 0; rtt = Number.isFinite(r.rttMs) ? r.rttMs : null; }
                else { failures++; rtt = null; }
                const before = level;
                apply(classify(net.status()));
                if (level === before) share();                              // fresh round-trip time for the dashboard
            }
            const loop = ctx.wrap(async () => {
                try { await probe(); }
                finally { if (!(ctx.signal && ctx.signal.aborted)) ctx.timers.setTimeout(loop, riding() ? cfg.probeRidingMs : cfg.probeIdleMs); }
            });

            /** Look along the route for remembered no-signal cells. */
            function lookAhead(/** @type {any} */ f, /** @type {number} */ t) {
                if (!route || !riding()) return;
                const r = route.current();
                if (!r || !Array.isArray(r.path) || r.path.length < 2) return;
                const path = r.path;
                if (r !== routeRef) { routeRef = r; cursor = 0; }
                let best = cursor, bestD = Infinity;
                const scan = (/** @type {number} */ from, /** @type {number} */ to) => {
                    for (let i = from; i < to; i++) { const d = metres(f.lat, f.lng, path[i][0], path[i][1]); if (d < bestD) { bestD = d; best = i; } }
                };
                scan(Math.max(0, cursor - 20), Math.min(path.length, cursor + 400));
                if (bestD > 300) scan(0, path.length);
                if (bestD > 500) return;                                      // off the route
                cursor = best;
                let ahead = 0;
                for (let i = best; i < path.length - 1 && ahead <= cfg.lookAheadM; i++) {
                    ahead += metres(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
                    if (ahead < cfg.minAheadM) continue;
                    const k = cellKey(path[i + 1][0], path[i + 1][1]);
                    const c = cells[k];
                    if (!c || c.hits < 1) continue;
                    if (t - (warned.get(k) || -Infinity) < cfg.zoneCooldownMs) return;   // already told about this zone
                    warned.set(k, t);
                    ctx.report("network.zone-ahead", { severity: "advice", key: "network.zone", category: "network", ridingOnly: true, data: { distanceM: Math.max(100, Math.round(ahead / 100) * 100), seen: c.hits }, cooldownMs: 600000 });
                    return;
                }
            }

            function onFix(/** @type {any} */ f) {
                if (!f || !Number.isFinite(f.lat) || !Number.isFinite(f.lng)) return;
                const t = Number.isFinite(f.t) ? f.t : ctx.now();
                const k = cellKey(f.lat, f.lng);
                if (level === "offline") markDead(f);
                else if (level === "good" && k !== lastCell && cells[k] && riding()) {
                    // good signal in a remembered cell: forget it once it's been fine twice as often as it failed
                    const c = cells[k];
                    c.good++;
                    if (c.good >= 2 * c.hits) delete cells[k];
                    saveCells();
                }
                lastCell = k;
                if (level !== "offline" && t - lastZoneCheck >= cfg.zoneCheckEveryMs) { lastZoneCheck = t; lookAhead(f, t); }
            }

            const offs = [net.onChange(ctx.wrap((/** @type {any} */ st) => {
                if (!st.connected) apply("offline");
                else { failures = 0; probe(); }
            }))];
            if (loc) offs.push(loc.onFix(ctx.wrap(onFix)));
            ctx.onStop(() => offs.forEach((off) => off()));

            apply(classify(net.status()));
            loop();
        }
    };
});
