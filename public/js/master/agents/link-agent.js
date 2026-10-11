// @ts-check
/* ============================================================================
   MapUnite Master AI — Link agent ("link"): radio signal and real bandwidth,
   and a warning BEFORE the connection drops
   ==============================================================================
   The network agent (agents/network-agent.js) already says "lost", "weak" and
   "restored" from the OS flag and round trips. This agent adds what those
   can't see:

   RADIO (Android app, capability "radio"): signal level 0–4 and dBm every 2 s
     (LTE/NR: RSRP; 3G/2G: dBm; Wi-Fi: RSSI), plus the generation (2g … 5g).
     A least-squares slope over the last 60 s predicts when RSRP crosses the
     edge of usable coverage (−115 dBm LTE/NR, −105 dBm 3G/2G):
       network.degrading   advice, when that crossing is ≤ 45 s away and the
                           level is already ≤ 2. Key "network.status", so the
                           network agent's "lost" REPLACES it if it comes first.
   BANDWIDTH (everywhere, capability "master-api"):
     - passive: every response from our server ≥ 8 KB is a free throughput
       sample (bytes / time), smoothed (EWMA, α = 0.3);
     - active: while riding, GET /api/master/bw?kb=64 every 120 s if the last
       passive sample is older than that (≈ 2 MB per hour of riding; off on a
       metered link the radio reports as "2g"/level 0, and settable to 0).
       network.slow        advice, < 0.25 Mbit/s for 3 samples in a row while the
                           round trip is still fine (connected but crawling)
   Feeds the remote capability's offline hint, so agents stop timing out in tunnels.

   Shares state.link = { at, transport, gen, level, dbm, trendDbmPerMin, downMbps, source }.
   Units: dBm, dB, Mbit/s, seconds.
   ============================================================================ */
(function (root, factory) {
    const def = factory();
    if (typeof module === "object" && module.exports) module.exports = def;
    else {
        const M = /** @type {any} */ (root).MUMaster || (/** @type {any} */ (root).MUMaster = {});
        if (typeof M.define === "function") M.define(def); else (M._pending || (M._pending = [])).push(def);
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /** Least-squares slope of y over x. @param {Array<[number, number]>} pts */
    function slope(pts) {
        const n = pts.length;
        if (n < 4) return null;
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
        const den = n * sxx - sx * sx;
        return den === 0 ? null : (n * sxy - sx * sy) / den;
    }

    return {
        id: "link",
        version: "1.0.0",
        apiVersion: 1,
        description: "Radio signal strength, real bandwidth, and a warning before the connection drops.",
        requires: ["master-api"],
        optional: ["radio", "network"],
        depends: ["network"],
        defaults: {
            windowMs: 60000, predictS: 45, edgeLteDbm: -115, edgeLegacyDbm: -105, maxLevelForWarn: 2,
            passiveMinBytes: 8192, ewma: 0.3, probeKb: 64, probeEveryMs: 120000, slowMbps: 0.25, slowSamples: 3,
            degradeRepeatMs: 600000
        },
        slope,

        /** @param {any} ctx */
        start(ctx) {
            const cfg = ctx.config;
            const api = ctx.caps.get("master-api");
            const radio = ctx.caps.get("radio");
            /** @type {Array<[number, number]>} */ const series = [];         // [tSec, dBm]
            /** @type {any} */ let lastRadio = null;
            /** @type {number|null} */ let downMbps = null;
            let lastSampleAt = -Infinity, slowRun = 0, lastDegradeAt = -Infinity, lastSlowAt = -Infinity;

            const riding = () => { const r = ctx.bus.last("state.ride"); return Boolean(r && r.active); };
            const strength = (/** @type {any} */ s) => (s.transport === "wifi" ? s.wifiRssi : (s.rsrp ?? s.dbm));

            function share() {
                const tr = slope(series);
                ctx.setState("link", {
                    at: ctx.now(), source: radio ? "radio" : "bandwidth",
                    transport: lastRadio ? lastRadio.transport : null, gen: lastRadio ? lastRadio.gen : null,
                    level: lastRadio ? lastRadio.level : null, dbm: lastRadio ? strength(lastRadio) : null,
                    trendDbmPerMin: tr === null ? null : Math.round(tr * 60 * 10) / 10,
                    downMbps: downMbps === null ? null : Math.round(downMbps * 100) / 100
                });
            }

            function onRadio(/** @type {any} */ s) {
                lastRadio = s;
                const t = ctx.now() / 1000;
                const dbm = strength(s);
                if (Number.isFinite(dbm)) series.push([t, dbm]);
                while (series.length && t - series[0][0] > cfg.windowMs / 1000) series.shift();
                if (api && typeof api.setOffline === "function") api.setOffline(s.transport === "none");
                share();
                // predict the crossing of the coverage edge
                if (s.transport !== "cellular" || !Number.isFinite(dbm) || s.level === null || s.level > cfg.maxLevelForWarn) return;
                const k = slope(series);
                if (k === null || k >= -0.05) return;                         // flat or improving (dBm per second)
                const edge = s.gen === "4g" || s.gen === "5g" ? cfg.edgeLteDbm : cfg.edgeLegacyDbm;
                const inS = (edge - dbm) / k;
                if (inS < 0 || inS > cfg.predictS) return;
                if (ctx.now() - lastDegradeAt < cfg.degradeRepeatMs || !riding()) return;
                lastDegradeAt = ctx.now();
                ctx.report("network.degrading", { severity: "advice", key: "network.status", category: "network", ridingOnly: true, data: { inS: Math.round(inS), dbm: Math.round(dbm) }, ttlMs: Math.max(10000, Math.round(inS * 1000)), cooldownMs: cfg.degradeRepeatMs });
            }

            function onThroughput(/** @type {number} */ mbps) {
                lastSampleAt = ctx.now();
                downMbps = downMbps === null ? mbps : downMbps + cfg.ewma * (mbps - downMbps);
                const net = ctx.bus.last("state.network");
                const connected = !net || net.level !== "offline";
                slowRun = mbps < cfg.slowMbps && connected ? slowRun + 1 : 0;
                share();
                if (slowRun >= cfg.slowSamples && ctx.now() - lastSlowAt > 1800000) {
                    lastSlowAt = ctx.now();
                    ctx.report("network.slow", { severity: "advice", key: "network.status", category: "network", data: { downMbps: Math.round(mbps * 100) / 100 }, cooldownMs: 1800000 });
                }
            }

            const offs = [];
            offs.push(api.onSample(ctx.wrap((/** @type {any} */ s) => {
                if (s.status === 200 && s.bytes >= cfg.passiveMinBytes && s.ms > 0) onThroughput((s.bytes * 8) / (s.ms / 1000) / 1e6);
            })));
            if (radio) {
                offs.push(radio.onSample(ctx.wrap(onRadio)));
            } else ctx.timers.setTimeout(() => ctx.markDegraded("radio signal needs the Android app; bandwidth only"), 0);   // after start() returns: "degraded" only applies to a running agent
            ctx.onStop(() => offs.forEach((off) => off()));
            // network agent's verdict feeds the offline hint too (a dead tower still says "connected")
            ctx.bus.subscribe("state.network", (/** @type {any} */ n) => { if (api && typeof api.setOffline === "function") api.setOffline(Boolean(n && n.level === "offline")); }, { replay: true });

            ctx.timers.setInterval(async () => {
                if (!cfg.probeKb || !riding() || ctx.now() - lastSampleAt < cfg.probeEveryMs) return;
                if (lastRadio && (lastRadio.gen === "2g" || lastRadio.level === 0)) return;    // don't spend a weak link on a test
                const r = await api.get(`/bw?kb=${cfg.probeKb}`, { timeoutMs: 15000, raw: true, signal: ctx.signal });
                if (!r.ok) { if (r.reason !== "offline") onThroughput(0); return; }
                // the sampler already counted it (bytes ≥ passiveMinBytes)
            }, Math.max(10000, Math.round(cfg.probeEveryMs / 4)));
        }
    };
});
