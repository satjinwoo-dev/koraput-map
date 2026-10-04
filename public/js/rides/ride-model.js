// @ts-check
/* ============================================================================
   MapUnite rides — ride summaries: records, totals and buckets (roadmap step 10)
   ==============================================================================
   Pure functions, strict SI (m, s, m/s, m³ of fuel, J of battery energy).

     fromTripEnd(d)          "mu:trip-end" (SmartDrive)            → a record
     merge(rec, summary)     "mu:ride-summary" (HUD physics totals) → richer record
     rideName(ts)            "Morning ride" … by local hour
     economy(rec)            { value, unit } — km/L, or Wh/km for an EV
     rollup(records, range)  totals + bars for "7d" | "30d" | "12m" | "all"
     routePath(route, w, h)  north-up SVG path of the ride (no map tiles)

   A record never holds more than ~160 route points (simplified, ~12 m), and it
   never leaves the phone.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MURides || (/** @type {any} */ (root).MURides = {}); ns.model = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const R = 6371008.8, RAD = Math.PI / 180;
    const MAX_ROUTE = 160;
    const pad2 = (n) => String(n).padStart(2, "0");
    const num = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Number(x));

    /** Douglas–Peucker in metres, then thinned to ≤ max points. @param {number[][]} pts @param {number} tol @param {number} max */
    function simplify(pts, tol = 12, max = MAX_ROUTE) {
        if (pts.length <= 2) return pts.slice();
        const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length;
        const kx = Math.cos(lat0 * RAD) * R * RAD, ky = R * RAD;
        const X = pts.map((p) => p[1] * kx), Y = pts.map((p) => p[0] * ky);
        const run = (t) => {
            const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
            const stack = [[0, pts.length - 1]];
            while (stack.length) {
                const [a, b] = /** @type {number[]} */ (stack.pop());
                const dx = X[b] - X[a], dy = Y[b] - Y[a], L2 = dx * dx + dy * dy;
                let best = -1, idx = -1;
                for (let i = a + 1; i < b; i++) {
                    const tt = L2 > 0 ? Math.max(0, Math.min(1, ((X[i] - X[a]) * dx + (Y[i] - Y[a]) * dy) / L2)) : 0;
                    const d = Math.hypot(X[a] + dx * tt - X[i], Y[a] + dy * tt - Y[i]);
                    if (d > best) { best = d; idx = i; }
                }
                if (best > t && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
            }
            return pts.filter((_, i) => keep[i]);
        };
        let t = tol, out = run(t);
        while (out.length > max && t < 2000) { t *= 1.6; out = run(t); }
        return out;
    }

    /**
     * A record from SmartDrive's end-of-trip event.
     * @param {any} d { startedAt, endedAt, totalDistKm, avgSpeed (km/h), maxSpeed (km/h), fuelUsedL, idleMin, points:[{ts,lat,lng,speedKmh}], place }
     */
    function fromTripEnd(d) {
        const startedAt = num(d && d.startedAt) ?? Date.now();
        const endedAt = Math.max(startedAt, num(d && d.endedAt) ?? startedAt);
        const pts = (d && Array.isArray(d.points) ? d.points : []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng)).map((p) => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lng * 1e5) / 1e5]);
        const duration = (endedAt - startedAt) / 1000;
        const idle = Math.max(0, (num(d && d.idleMin) ?? 0) * 60);
        const fuelL = num(d && d.fuelUsedL);
        return {
            v: 1, id: `ride-${startedAt}`, startedAt, endedAt,
            place: d && typeof d.place === "string" ? d.place.slice(0, 60) : "",
            distance: Math.max(0, (num(d && d.totalDistKm) ?? 0) * 1000),
            duration, moving: Math.max(0, duration - idle), idleTime: idle,
            avgSpeed: Math.max(0, (num(d && d.avgSpeed) ?? 0) / 3.6), maxSpeed: Math.max(0, (num(d && d.maxSpeed) ?? 0) / 3.6),
            fuel: fuelL !== null ? fuelL / 1000 : null, evEnergy: null, powertrain: null,
            ecoScore: null, harsh: null, cost: null, priceUnit: null, bike: null, matched: false,
            route: simplify(pts), source: "smartdrive"
        };
    }

    /**
     * Add the HUD's physics totals (the better numbers) to a record.
     * @param {any} rec @param {any} s "mu:ride-summary" detail
     */
    function merge(rec, s) {
        const live = s && s.live ? s.live : null;
        const ev = s && s.powertrain === "ev";
        const out = { ...rec, source: live ? "hud" : rec.source, powertrain: s && s.powertrain ? s.powertrain : rec.powertrain, bike: (s && s.bike) || rec.bike, priceUnit: (s && s.priceUnit) || rec.priceUnit, matched: Boolean(s && Number.isFinite(s.correction) && s.correction !== 1) };
        if (!live) return out;
        if (num(live.distance) && live.distance > 0) out.distance = live.distance;
        if (num(live.moving) !== null) out.moving = live.moving;
        if (num(live.idleTime) !== null) out.idleTime = live.idleTime;
        if (num(live.maxSpeed) !== null && live.maxSpeed > 0) out.maxSpeed = live.maxSpeed;
        if (out.moving > 0) out.avgSpeed = out.distance / out.moving;
        if (num(live.energy) !== null) { if (ev) { out.evEnergy = Math.max(0, live.energy); out.fuel = null; } else out.fuel = Math.max(0, live.energy); }
        out.ecoScore = num(live.ecoScore);
        out.harsh = live.harsh ? (live.harsh.accel || 0) + (live.harsh.brake || 0) : null;
        out.cost = num(live.cost);
        return out;
    }

    /** @param {number} ts */
    function rideName(ts) {
        const h = new Date(ts).getHours();
        return h >= 5 && h < 11 ? "Morning ride" : h >= 11 && h < 16 ? "Afternoon ride" : h >= 16 && h < 20 ? "Evening ride" : "Night ride";
    }

    /**
     * @param {any} r @returns {{ value: number, unit: "km/L"|"Wh/km" }|null}
     */
    function economy(r) {
        if (!r || !(r.distance > 100)) return null;
        if (r.powertrain === "ev") return r.evEnergy > 0 ? { value: r.evEnergy / 3600 / (r.distance / 1000), unit: "Wh/km" } : null;
        return r.fuel > 0 ? { value: (r.distance / 1000) / (r.fuel * 1000), unit: "km/L" } : null;
    }

    const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const monthKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    /**
     * Totals and bars for a range.
     * @param {any[]} records @param {"7d"|"30d"|"12m"|"all"} range @param {number} [now]
     */
    function rollup(records, range, now = Date.now()) {
        const today = new Date(now);
        /** @type {Array<{ key: string, label: string, long: string, from: number, to: number, rides: number, distance: number, moving: number, fuel: number, evEnergy: number, cost: number }>} */
        const buckets = [];
        const mk = (key, label, long, from, to) => ({ key, label, long, from, to, rides: 0, distance: 0, moving: 0, fuel: 0, evEnergy: 0, cost: 0 });
        if (range === "7d" || range === "30d") {
            const n = range === "7d" ? 7 : 30;
            for (let i = n - 1; i >= 0; i--) {
                const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
                const e = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
                const label = n === 7 ? DAYS[d.getDay()] : (d.getDate() === 1 || i === n - 1 ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : String(d.getDate()));
                buckets.push(mk(dayKey(d), label, `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`, d.getTime(), e.getTime()));
            }
        } else {
            let n = 12;
            if (range === "all") {
                const first = records.reduce((a, r) => Math.min(a, r.startedAt), now);
                const f = new Date(first);
                n = Math.max(1, Math.min(36, (today.getFullYear() - f.getFullYear()) * 12 + today.getMonth() - f.getMonth() + 1));
            }
            for (let i = n - 1; i >= 0; i--) {
                const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
                const e = new Date(d.getFullYear(), d.getMonth() + 1, 1);
                buckets.push(mk(monthKey(d), MONTHS[d.getMonth()], `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, d.getTime(), e.getTime()));
            }
        }
        const from = range === "all" ? -Infinity : buckets[0].from, to = buckets[buckets.length - 1].to;
        const inRange = records.filter((r) => r.startedAt >= from && r.startedAt < to).sort((a, b) => b.startedAt - a.startedAt);
        const t = { rides: 0, distance: 0, moving: 0, fuel: 0, fuelRides: 0, evEnergy: 0, cost: 0, costRides: 0, ecoWeighted: 0, ecoDistance: 0, harsh: 0, harshDistance: 0 };
        for (const r of inRange) {
            const b = buckets.find((x) => r.startedAt >= x.from && r.startedAt < x.to);
            t.rides++; t.distance += r.distance || 0; t.moving += r.moving || 0;
            if (r.fuel > 0) { t.fuel += r.fuel; t.fuelRides++; }
            if (r.evEnergy > 0) t.evEnergy += r.evEnergy;
            if (r.cost !== null && r.cost !== undefined) { t.cost += r.cost; t.costRides++; }
            if (r.ecoScore !== null && r.ecoScore !== undefined && r.distance > 0) { t.ecoWeighted += r.ecoScore * r.distance; t.ecoDistance += r.distance; }
            if (r.harsh !== null && r.harsh !== undefined) { t.harsh += r.harsh; t.harshDistance += r.distance || 0; }
            if (b) { b.rides++; b.distance += r.distance || 0; b.moving += r.moving || 0; b.fuel += r.fuel > 0 ? r.fuel : 0; b.evEnergy += r.evEnergy > 0 ? r.evEnergy : 0; b.cost += r.cost || 0; }
        }
        return {
            range, buckets, records: inRange,
            totals: {
                rides: t.rides, distance: t.distance, moving: t.moving, fuel: t.fuel, fuelRides: t.fuelRides, evEnergy: t.evEnergy,
                cost: t.costRides ? t.cost : null, costRides: t.costRides,
                eco: t.ecoDistance > 0 ? t.ecoWeighted / t.ecoDistance : null,
                harshPer100km: t.harshDistance > 1000 ? (t.harsh / t.harshDistance) * 1e5 : null,
                economy: t.fuel > 0 ? (t.distance / 1000) / (t.fuel * 1000) : null
            }
        };
    }

    /**
     * North-up path of a ride inside a w × h box (no tiles, works offline).
     * @param {number[][]} route [[lat, lng], …] @param {number} w @param {number} h @param {number} [pad]
     * @returns {{ d: string, start: number[]|null, end: number[]|null }}
     */
    function routePath(route, w, h, pad = 4) {
        if (!Array.isArray(route) || route.length < 2) return { d: "", start: null, end: null };
        const lat0 = route.reduce((a, p) => a + p[0], 0) / route.length;
        const kx = Math.cos(lat0 * RAD);
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        const P = route.map(([la, ln]) => { const x = ln * kx, y = -la; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; return [x, y]; });
        const sx = (w - 2 * pad) / Math.max(1e-9, x1 - x0), sy = (h - 2 * pad) / Math.max(1e-9, y1 - y0);
        const s = Math.min(sx, sy);
        const ox = pad + (w - 2 * pad - (x1 - x0) * s) / 2, oy = pad + (h - 2 * pad - (y1 - y0) * s) / 2;
        const Q = P.map(([x, y]) => [ox + (x - x0) * s, oy + (y - y0) * s]);
        return { d: Q.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(""), start: Q[0], end: Q[Q.length - 1] };
    }

    return { MAX_ROUTE, simplify, fromTripEnd, merge, rideName, economy, rollup, routePath, dayKey, monthKey };
});
