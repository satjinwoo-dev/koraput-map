// @ts-check
/* ============================================================================
   MapUnite RoadSense Live — the Route Truth Card: what is KNOWN about a road,
   and from what evidence
   ==============================================================================
   buildTruth({ log, path, now, fromM }) walks a route ([[lat, lng], …]) and
   lists every RoadSense event (roadsense.js) lying on it, nearest first, each
   with the evidence behind it:

     row { id, type, status ("verified" | "candidate"), confidence 0..1,
           alongM (from the route's start), aheadM (from the rider), offsetM,
           sources { imu: 3, rider: 1 }, riders, felt (this phone felt it),
           lastSeen, ageS, expiresAt, peakMs2,
           words: { desi, plain } — the evidence in one clause, see evidence() }

   and the honest summary: counts by status and kind, and `unknown: true`
   when there's nothing at all. NO REPORT IS NOT A CLEAR ROAD: nobody may have
   ridden it, so the card says "condition unknown", never "clear".

   Every value comes from the log's rules (assess); this file only measures
   positions along the route and words the evidence. No language model: the
   voice and the screen read these fields through fixed phrases
   (phrases-desi.js "road.truth", "road.route-truth", "road.bump-*").

   Matching: the route is resampled every 50 m; an event counts when it lies
   within corridorM (15 m: GNSS error plus a lane) of the route line.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); const M = W.MUMaster || (W.MUMaster = {}); M.roadTruth = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const M_PER_DEG = 111320;
    const DEFAULTS = Object.freeze({ corridorM: 15, stepM: 50, maxRows: 60 });

    /** Spoken and screen names of each kind. */
    const KIND_WORDS = Object.freeze({
        bump: { desi: "gaddha ya breaker", plain: "bump or pothole", many: "bumps or potholes", one: "Bump" },
        pothole: { desi: "gaddha", plain: "pothole", many: "potholes", one: "Pothole" },
        speed_breaker: { desi: "speed breaker", plain: "speed breaker", many: "speed breakers", one: "Speed breaker" },
        rough: { desi: "kharab sadak", plain: "rough road", many: "rough stretches", one: "Rough road" },
        waterlogging: { desi: "paani bhara hua", plain: "waterlogging", many: "waterlogged spots", one: "Waterlogging" },
        gravel: { desi: "bajri aur ret", plain: "gravel or sand", many: "gravel patches", one: "Gravel" },
        debris: { desi: "sadak pe malba", plain: "debris", many: "debris spots", one: "Debris" },
        animal: { desi: "janwar", plain: "animals on the road", many: "animal sightings", one: "Animals" }
    });

    /** How long ago, in each style ("3 ghante pehle" / "3 hours ago"). @param {number} ageS */
    function ago(ageS) {
        const m = Math.max(0, Math.round(ageS / 60));
        if (m < 2) return { desi: "abhi abhi", plain: "just now" };
        if (m < 60) return { desi: `${m} minute pehle`, plain: `${m} minutes ago` };
        const h = Math.round(m / 60);
        if (h < 24) return { desi: `${h} ghante pehle`, plain: `${h} hour${h === 1 ? "" : "s"} ago` };
        const d = Math.round(h / 24);
        if (d === 1) return { desi: "kal", plain: "yesterday" };
        return { desi: `${d} din pehle`, plain: `${d} days ago` };
    }

    /** Confidence in words; the screen also shows the percentage. Bands: ≥ 0.8 high, ≥ 0.5 medium, else low. @param {number} c */
    function confidenceWords(c) {
        if (c >= 0.8) return { desi: "bharosa zyada", plain: "high confidence", band: "high" };
        if (c >= 0.5) return { desi: "bharosa theek-thaak", plain: "medium confidence", band: "medium" };
        return { desi: "bharosa kam", plain: "low confidence", band: "low" };
    }

    /**
     * The evidence in one clause: WHO saw it (this phone / other riders / an official feed), WHEN, and
     * whether it's confirmed. Short enough to say inside a warning.
     * @param {any} row an assessed event (status, riders, felt, sources, ageS)
     */
    function evidence(row) {
        const when = ago(row.ageS);
        const others = row.riders - (row.felt ? 1 : 0);
        const official = Boolean(row.sources && row.sources.official);
        let desi, plain;
        if (official) { desi = `sarkari alert, ${when.desi}`; plain = `official alert, ${when.plain}`; }
        else if (row.felt && others <= 0) { desi = `aapne khud feel kiya tha, ${when.desi}`; plain = `you felt it yourself, ${when.plain}`; }
        else if (row.felt) { desi = `aap aur ${others} aur riders ne feel kiya, aakhri baar ${when.desi}`; plain = `felt by you and ${others} other rider${others === 1 ? "" : "s"}, last ${when.plain}`; }
        else { desi = `${others} riders ne report kiya, aakhri baar ${when.desi}`; plain = `reported by ${others} rider${others === 1 ? "" : "s"}, last ${when.plain}`; }
        if (row.status !== "verified") { desi += ", abhi pakka nahi"; plain += ", not confirmed"; }
        // inside a warning said 2–8 s before the spot, only who and when (confidence is on screen)
        let shortDesi, shortPlain;
        if (official) { shortDesi = `sarkari alert ${when.desi}`; shortPlain = `official alert ${when.plain}`; }
        else if (row.felt && others <= 0) { shortDesi = `aapko ${when.desi} yahin laga tha`; shortPlain = `you hit it here ${when.plain}`; }
        else { const n = others + (row.felt ? 1 : 0); shortDesi = `${n} riders ne bataya, ${when.desi}`; shortPlain = `reported by ${n} riders ${when.plain}`; }
        return { desi, plain, shortDesi, shortPlain };
    }

    /** One line for a screen row: "2 riders · 3 h ago · 82%". @param {any} row */
    function screenEvidence(row) {
        const parts = [];
        const others = row.riders - (row.felt ? 1 : 0);
        if (row.sources && row.sources.official) parts.push("Official alert");
        if (row.felt) parts.push(others > 0 ? `You + ${others} rider${others === 1 ? "" : "s"}` : "You");
        else if (others > 0) parts.push(`${others} rider${others === 1 ? "" : "s"}`);
        const how = Object.entries(row.sources || {}).filter(([s]) => s !== "official").map(([s]) => (s === "imu" ? "motion sensor" : s === "camera" ? "camera" : "rider report")).join(" + ");
        if (how) parts.push(how);
        parts.push(ago(row.ageS).plain);
        parts.push(`${Math.round(row.confidence * 100)}%`);
        return parts.join(" · ");
    }

    /** metres between two points (equirectangular: fine at route-step scale) */
    function dist(/** @type {number} */ lat, /** @type {number} */ lng, /** @type {number} */ lat2, /** @type {number} */ lng2) {
        const n = (lat2 - lat) * M_PER_DEG, e = (lng2 - lng) * M_PER_DEG * Math.cos(lat * Math.PI / 180);
        return Math.hypot(n, e);
    }

    /**
     * The route resampled: points every ≤ stepM with their distance from the start.
     * @param {number[][]} path @param {number} stepM
     */
    function resample(path, stepM) {
        /** @type {{ lat: number, lng: number, s: number }[]} */ const out = [];
        const pts = (Array.isArray(path) ? path : []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (!pts.length) return out;
        let s = 0;
        out.push({ lat: pts[0][0], lng: pts[0][1], s: 0 });
        for (let i = 1; i < pts.length; i++) {
            const [a, b] = [pts[i - 1], pts[i]];
            const d = dist(a[0], a[1], b[0], b[1]);
            const n = Math.max(1, Math.ceil(d / stepM));
            for (let k = 1; k <= n; k++) out.push({ lat: a[0] + (b[0] - a[0]) * k / n, lng: a[1] + (b[1] - a[1]) * k / n, s: s + d * k / n });
            s += d;
        }
        return out;
    }

    /**
     * Where a point lies along resampled route points: { alongM, offsetM } of its projection on the nearest segment.
     * @param {{ lat: number, lng: number, s: number }[]} pts @param {number} lat @param {number} lng @param {number} [from] @param {number} [to]
     */
    function project(pts, lat, lng, from = 0, to = pts.length - 1) {
        let best = { alongM: 0, offsetM: Infinity };
        const kx = M_PER_DEG * Math.cos(lat * Math.PI / 180), ky = M_PER_DEG;
        for (let i = Math.max(1, from); i <= Math.min(to, pts.length - 1); i++) {
            const a = pts[i - 1], b = pts[i];
            const bx = (b.lng - a.lng) * kx, by = (b.lat - a.lat) * ky, px = (lng - a.lng) * kx, py = (lat - a.lat) * ky;
            const len2 = bx * bx + by * by;
            const u = len2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
            const off = Math.hypot(px - u * bx, py - u * by);
            if (off < best.offsetM) best = { alongM: a.s + u * (b.s - a.s), offsetM: off };
        }
        return best;
    }

    /**
     * The Truth Card for a route.
     * @param {{ log: any, path: number[][], now: number, fromM?: number, corridorM?: number, stepM?: number, maxRows?: number }} o
     *   fromM: the rider's distance along the route (rows behind them are left out; aheadM counts from here)
     */
    function buildTruth(o) {
        const cfg = { ...DEFAULTS, ...o };
        const pts = resample(o.path, cfg.stepM);
        const lengthM = pts.length ? pts[pts.length - 1].s : 0;
        const fromM = Math.max(0, Number(o.fromM) || 0);
        /** @type {Map<string, any>} */ const found = new Map();
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            if (p.s < fromM - cfg.stepM) continue;
            for (const ev of o.log.query({ lat: p.lat, lng: p.lng, radiusM: cfg.stepM / 2 + cfg.corridorM + 5, now: o.now })) {
                if (found.has(ev.id)) continue;
                const pr = project(pts, ev.lat, ev.lng, i - 2, i + 2);
                if (pr.offsetM > cfg.corridorM || pr.alongM < fromM) continue;
                found.set(ev.id, { ev, ...pr });
            }
        }
        const rows = [...found.values()].sort((a, b) => a.alongM - b.alongM).slice(0, cfg.maxRows).map(({ ev, alongM, offsetM }) => {
            const row = {
                id: ev.id, type: ev.type, status: ev.status, confidence: ev.confidence,
                alongM: Math.round(alongM), aheadM: Math.round(alongM - fromM), offsetM: Math.round(offsetM * 10) / 10,
                sources: ev.sources, riders: ev.riders, felt: Boolean(ev.felt), lastSeen: ev.lastSeen,
                ageS: Math.max(0, Math.round((o.now - ev.lastSeen) / 1000)), peakMs2: ev.peakMs2,
                // "valid until" if nothing new is seen: measured for the rows shown only (it costs a few dozen assessments)
                expiresAt: (o.log.get(ev.id, o.now) || {}).expiresAt ?? null
            };
            return { ...row, words: evidence(row), screen: screenEvidence(row), kind: KIND_WORDS[/** @type {keyof typeof KIND_WORDS} */ (ev.type)] || { desi: ev.type, plain: ev.type, many: ev.type, one: ev.type } };
        });
        /** @type {Record<string, number>} */ const byKind = {};
        for (const r of rows) if (r.status === "verified") byKind[r.type] = (byKind[r.type] || 0) + 1;
        const verified = rows.filter((r) => r.status === "verified").length;
        return {
            lengthM: Math.round(lengthM), fromM: Math.round(fromM), rows, verified, candidates: rows.length - verified, byKind,
            unknown: rows.length === 0
        };
    }

    /**
     * Without a route: the events within radiusM of the rider, nearest first (straight-line distance as aheadM).
     * @param {{ log: any, lat: number, lng: number, now: number, radiusM?: number, maxRows?: number }} o
     */
    function buildNear(o) {
        const found = o.log.query({ lat: o.lat, lng: o.lng, radiusM: o.radiusM || 2000, now: o.now }).slice(0, o.maxRows || DEFAULTS.maxRows);
        const rows = found.map((/** @type {any} */ ev) => {
            const row = {
                id: ev.id, type: ev.type, status: ev.status, confidence: ev.confidence, alongM: Math.round(ev.distanceM), aheadM: Math.round(ev.distanceM), offsetM: 0,
                sources: ev.sources, riders: ev.riders, felt: Boolean(ev.felt), lastSeen: ev.lastSeen, ageS: Math.max(0, Math.round((o.now - ev.lastSeen) / 1000)),
                peakMs2: ev.peakMs2, expiresAt: (o.log.get(ev.id, o.now) || {}).expiresAt ?? null
            };
            return { ...row, words: evidence(row), screen: screenEvidence(row), kind: KIND_WORDS[/** @type {keyof typeof KIND_WORDS} */ (ev.type)] || { desi: ev.type, plain: ev.type, many: ev.type, one: ev.type } };
        });
        /** @type {Record<string, number>} */ const byKind = {};
        for (const r of rows) if (r.status === "verified") byKind[r.type] = (byKind[r.type] || 0) + 1;
        const verified = rows.filter((r) => r.status === "verified").length;
        return { lengthM: 0, fromM: 0, rows, verified, candidates: rows.length - verified, byKind, unknown: rows.length === 0 };
    }

    /**
     * The values a phrase needs to SAY a card (the persona renders them; nothing is invented here).
     * @param {ReturnType<typeof buildTruth>} card @param {"ahead"|"route"|"near"} scope
     */
    function phraseData(card, scope) {
        const first = card.rows.find((r) => r.status === "verified") || card.rows[0] || null;
        const kinds = Object.entries(card.byKind).sort((a, b) => b[1] - a[1]);
        const word = (/** @type {string} */ k) => KIND_WORDS[/** @type {keyof typeof KIND_WORDS} */ (k)] || { desi: k, plain: k, many: k };
        const list = (/** @type {"desi"|"plain"} */ st) => kinds.map(([k, n]) => `${n} ${st === "plain" ? (n === 1 ? word(k).plain : word(k).many) : word(k).desi}`).join(st === "plain" ? ", " : " aur ");
        const where = { ahead: { desi: "aage ke raaste", plain: "the road ahead" }, route: { desi: "is raaste", plain: "this route" }, near: { desi: "aas-paas ki sadak", plain: "the roads around you" } }[scope];
        return {
            scope, count: card.rows.length, verified: card.verified, candidates: card.candidates,
            where: where.desi, kinds: list("desi"),
            hazard: first ? first.kind.desi : "", distanceM: first ? Math.max(10, first.aheadM) : 0, evidence: first ? first.words.desi : "",
            confidence: first ? confidenceWords(first.confidence).desi : "",
            screen: {
                where: where.plain, kinds: list("plain"), hazard: first ? first.kind.plain : "", evidence: first ? first.words.plain : "",
                confidence: first ? `${confidenceWords(first.confidence).plain} (${Math.round(first.confidence * 100)}%)` : ""
            }
        };
    }

    /** Which phrase says a card: unknown (nothing), unconfirmed (candidates only), or the confirmed summary. @param {{ rows: any[], verified: number }} card */
    function phraseKind(card) { return card.rows.length === 0 ? "road.truth-unknown" : card.verified === 0 ? "road.truth-unconfirmed" : "road.truth"; }

    return { DEFAULTS, KIND_WORDS, ago, confidenceWords, evidence, screenEvidence, resample, project, buildTruth, buildNear, phraseData, phraseKind };
});
