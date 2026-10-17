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
        animal: { desi: "janwar", plain: "animals on the road", many: "animal sightings", one: "Animals" },
        roadworks: { desi: "sadak ka kaam", plain: "roadworks", many: "roadworks", one: "Roadworks" }
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
     * The evidence in one clause: WHO saw it (this phone / other riders / an official list / a model's prediction),
     * WHEN, and whether it's confirmed. Short enough to say inside a warning.
     * @param {any} row an assessed event (status, riders, felt, sources, ageS, refs, predicted)
     */
    function evidence(row) {
        const when = ago(row.ageS);
        const others = row.riders - (row.felt ? 1 : 0);
        const refs = (row.refs || []).join(", ") || "official list";
        const official = Boolean(row.sources && row.sources.official);
        let desi, plain;
        if (row.status === "predicted") {
            const by = ((row.predicted && row.predicted.refs) || []).join(", ");
            desi = `sirf anumaan, ${by} se, kisi ne dekha nahi`; plain = `a prediction from ${by}, not seen by anyone`;
            return { desi, plain, shortDesi: desi, shortPlain: plain, tu: desi };
        }
        if (official && others <= 0 && !row.felt) { desi = `sarkari jaankari, ${refs}`; plain = `official: ${refs}`; }
        else if (official) { desi = `sarkari jaankari (${refs}) aur ${row.riders} riders`; plain = `official (${refs}) and ${row.riders} rider${row.riders === 1 ? "" : "s"}`; }
        else if (row.felt && others <= 0) { desi = `aapne khud feel kiya tha, ${when.desi}`; plain = `you felt it yourself, ${when.plain}`; }
        else if (row.felt) { desi = `aap aur ${others} aur riders ne feel kiya, aakhri baar ${when.desi}`; plain = `felt by you and ${others} other rider${others === 1 ? "" : "s"}, last ${when.plain}`; }
        else { desi = `${others} riders ne report kiya, aakhri baar ${when.desi}`; plain = `reported by ${others} rider${others === 1 ? "" : "s"}, last ${when.plain}`; }
        // the same, in "tu" (the rowdy tone, phrases-tone.js): only the words that address the rider change
        let tu = desi.replace(/^aapne khud/, "tune khud").replace(/^aap aur /, "tu aur ");
        if (row.status !== "verified") { desi += ", abhi pakka nahi"; plain += ", not confirmed"; tu += ", abhi pakka nahi"; }
        // inside a warning said 2–8 s before the spot, only who and when (confidence is on screen)
        let shortDesi, shortPlain;
        if (official) { shortDesi = `sarkari jaankari, ${refs}`; shortPlain = `official, ${refs}`; }
        else if (row.felt && others <= 0) { shortDesi = `aapko ${when.desi} yahin laga tha`; shortPlain = `you hit it here ${when.plain}`; }
        else { const n = others + (row.felt ? 1 : 0); shortDesi = `${n} riders ne bataya, ${when.desi}`; shortPlain = `reported by ${n} riders ${when.plain}`; }
        return { desi, plain, shortDesi, shortPlain, tu };
    }

    /**
     * One line for a screen row: "You + 2 riders · motion sensor · 3 hours ago". No percentage: the log's confidence
     * gates warnings internally; shown as a number it would read as a probability (Confirmed Decision 3).
     * @param {any} row
     */
    function screenEvidence(row) {
        if (row.status === "predicted") return `AI prediction · ${((row.predicted && row.predicted.refs) || []).join(", ")} · not seen by anyone`;
        const parts = [];
        const others = row.riders - (row.felt ? 1 : 0);
        if (row.sources && row.sources.official) parts.push(`Official: ${(row.refs || []).join(", ") || "official list"}`);
        if (row.felt) parts.push(others > 0 ? `You + ${others} rider${others === 1 ? "" : "s"}` : "You");
        else if (others > 0) parts.push(`${others} rider${others === 1 ? "" : "s"}`);
        const how = Object.entries(row.sources || {}).filter(([s]) => s !== "official").map(([s]) => (s === "imu" ? "motion sensor" : s === "camera" ? "camera" : "rider report")).join(" + ");
        if (how) parts.push(how);
        parts.push(ago(row.ageS).plain);
        return parts.join(" · ");
    }

    /**
     * What riders said about a published hazard (agreement.js summary fields, as /area sends them), in words:
     * counts of riders who reviewed it, never a probability.
     *   1 report            "1 rider reported this · yesterday"
     *   fewer than 3        "found by 2 riders, 1 didn't find it"
     *   3+ reviewers        "8 of 10 reviewing riders found it · 80% rider agreement"
     *   + "last confirmed 3 hours ago"; "recent riders disagree · condition may have changed"; "2 not sure"
     * short*: inside a warning (who and when only); screen: one line for a card row.
     * @param {any} h @param {number} now
     */
    function communityEvidence(h, now) {
        const last = Number.isFinite(h.lastFoundAt) ? ago(Math.max(0, (now - h.lastFoundAt) / 1000)) : null;
        const rd = (/** @type {number} */ n) => `${n} rider${n === 1 ? "" : "s"}`;
        let desi, plain, shortDesi, shortPlain;
        if (h.found <= 1 && h.notFound === 0) {
            desi = shortDesi = `1 rider ne report kiya${last ? `, ${last.desi}` : ""}`;
            plain = shortPlain = `1 rider reported this${last ? ` ${last.plain}` : ""}`;
        } else if (h.agreementPct === null || h.agreementPct === undefined) {
            desi = `${h.found} riders ko mila${h.notFound ? `, ${h.notFound} ko nahi` : ""}`;
            plain = `found by ${rd(h.found)}${h.notFound ? `, ${h.notFound} didn't find it` : ""}`;
            shortDesi = `${h.found} riders ne confirm kiya${last ? `, ${last.desi}` : ""}`;
            shortPlain = `confirmed by ${rd(h.found)}${last ? `, last ${last.plain}` : ""}`;
        } else {
            desi = `${h.reviewers} mein se ${h.found} riders ko mila`;
            plain = `${h.found} of ${h.reviewers} reviewing riders found it · ${h.agreementPct}% rider agreement`;
            shortDesi = `${h.reviewers} mein se ${h.found} riders ne confirm kiya`;
            shortPlain = `${h.found} of ${h.reviewers} riders confirmed it`;
        }
        if (last && !(h.found <= 1 && h.notFound === 0)) { desi += `, aakhri baar ${last.desi}`; plain += ` · last confirmed ${last.plain}`; }
        if (h.recentDisagree) { desi += ", par haal ke riders ko nahi mila, shayad badal gaya ho"; plain += " · recent riders disagree, condition may have changed"; }
        if (h.unsure) plain += ` · ${h.unsure} not sure`;
        const screen = plain.charAt(0).toUpperCase() + plain.slice(1);
        return { desi, plain, shortDesi, shortPlain, screen };
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

    /** One card row from an assessed event. @param {any} ev @param {any} log @param {number} now @param {number} alongM @param {number} aheadM @param {number} offsetM */
    function rowOf(ev, log, now, alongM, aheadM, offsetM) {
        const seen = ev.lastSeen !== null ? ev.lastSeen : now;
        const row = {
            id: ev.id, type: ev.type, status: ev.status, confidence: ev.confidence,
            alongM: Math.round(alongM), aheadM: Math.round(aheadM), offsetM: Math.round(offsetM * 10) / 10,
            sources: ev.sources, riders: ev.riders, felt: Boolean(ev.felt), lastSeen: ev.lastSeen,
            ageS: Math.max(0, Math.round((now - seen) / 1000)), peakMs2: ev.peakMs2,
            refs: ev.refs || [], predicted: ev.predicted || null,
            // "valid until" if nothing new is seen: measured for the rows shown only (it costs a few dozen assessments)
            expiresAt: (log.get(ev.id, now) || {}).expiresAt ?? null
        };
        return { ...row, words: evidence(row), screen: screenEvidence(row), kind: KIND_WORDS[/** @type {keyof typeof KIND_WORDS} */ (ev.type)] || { desi: ev.type, plain: ev.type, many: ev.type, one: ev.type } };
    }

    /** A card row from a published hazard (RoadPulse, agreement.js summary as /area sends it). @param {any} h @param {number} now @param {number} alongM @param {number} aheadM @param {number} offsetM */
    function communityRow(h, now, alongM, aheadM, offsetM) {
        const status = h.status === "active" ? "verified" : h.status === "reported" ? "candidate" : h.status;      // disputed, maybe_fixed: shown, never counted
        const w = communityEvidence(h, now);
        return {
            id: h.id, type: h.type, status, community: { status: h.status, found: h.found, notFound: h.notFound, unsure: h.unsure, reviewers: h.reviewers, agreementPct: h.agreementPct, recentDisagree: Boolean(h.recentDisagree) },
            confidence: null, alongM: Math.round(alongM), aheadM: Math.round(aheadM), offsetM: Math.round(offsetM * 10) / 10,
            sources: { rider: h.found }, riders: h.found, felt: false, lastSeen: h.lastFoundAt ?? null,
            ageS: Number.isFinite(h.lastFoundAt) ? Math.max(0, Math.round((now - h.lastFoundAt) / 1000)) : 0, peakMs2: null, refs: [], predicted: null,
            expiresAt: h.expiresAt ?? null,
            words: { desi: w.desi, plain: w.plain, shortDesi: w.shortDesi, shortPlain: w.shortPlain, tu: w.desi }, screen: w.screen,
            kind: KIND_WORDS[/** @type {keyof typeof KIND_WORDS} */ (h.type)] || { desi: h.type, plain: h.type, many: h.type, one: h.type }
        };
    }

    /**
     * Adds the published hazards along the route as rows; one within 15 m of a row the phone already has is the same
     * hazard: its rider counts are added to that row's screen line instead.
     * @param {any[]} rows @param {any[]} community @param {(lat: number, lng: number) => { alongM: number, offsetM: number }|null} place @param {number} fromM @param {number} now
     */
    function withCommunity(rows, community, place, fromM, now) {
        const out = [...rows];
        for (const h of community || []) {
            if (!h || !Number.isFinite(h.lat) || !Number.isFinite(h.lng)) continue;
            const pr = place(h.lat, h.lng);
            if (!pr || pr.alongM < fromM) continue;
            const same = out.find((r) => !r.community && Math.abs(r.alongM - pr.alongM) <= 15);
            if (same) { same.screen = `${same.screen} · ${communityEvidence(h, now).screen}`; continue; }
            out.push(communityRow(h, now, pr.alongM, pr.alongM - fromM, pr.offsetM));
        }
        return out.sort((a, b) => a.alongM - b.alongM);
    }

    /** Counts of a card's rows. @param {any[]} rows */
    function tally(rows) {
        /** @type {Record<string, number>} */ const byKind = {};
        for (const r of rows) if (r.status === "verified") byKind[r.type] = (byKind[r.type] || 0) + 1;
        return {
            byKind, verified: rows.filter((r) => r.status === "verified").length,
            candidates: rows.filter((r) => r.status === "candidate").length, predicted: rows.filter((r) => r.status === "predicted").length
        };
    }

    /**
     * Coverage along the route: stretches that are "hazard" (a report there), "clear" (smooth passes by ≥ clearRiders
     * riders, nothing reported), "ridden" (one rider, nothing felt) or "unknown".
     * @param {{ lat: number, lng: number, s: number }[]} pts @param {number} fromM @param {any[]} rows @param {any} cover @param {number} now
     */
    function stretchesOf(pts, fromM, rows, cover, now) {
        const end = pts.length ? pts[pts.length - 1].s : 0;
        const totals = { clearM: 0, riddenM: 0, unknownM: 0, hazardM: 0 };
        /** @type {{ fromM: number, toM: number, state: string, riders: number, last: number|null }[]} */ const out = [];
        const hazards = rows.filter((r) => r.status === "verified" || r.status === "candidate").map((r) => r.alongM);
        const need = cover ? cover.policy.clearRiders : Infinity;
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i];
            if (b.s <= fromM) continue;
            const s0 = Math.max(a.s, fromM), s1 = b.s;
            const c = cover ? cover.at(cover.cellOf((a.lat + b.lat) / 2, (a.lng + b.lng) / 2), now) : { riders: 0, last: null };
            const state = hazards.some((h) => h >= s0 - 25 && h <= s1 + 25) ? "hazard" : c.riders >= need ? "clear" : c.riders === 1 ? "ridden" : "unknown";
            const prev = out[out.length - 1];
            if (prev && prev.state === state) {
                prev.toM = s1;
                if (state === "clear" || state === "ridden") { prev.riders = Math.min(prev.riders, c.riders); prev.last = prev.last === null ? c.last : c.last === null ? prev.last : Math.min(prev.last, c.last); }
            } else out.push({ fromM: s0, toM: s1, state, riders: c.riders, last: c.last });
            /** @type {any} */ (totals)[`${state}M`] += s1 - s0;
        }
        if (!out.length && end > fromM) { out.push({ fromM, toM: end, state: "unknown", riders: 0, last: null }); totals.unknownM = end - fromM; }
        const clear = out.filter((x) => x.state === "clear"), ridden = out.filter((x) => x.state === "ridden");
        const oldest = (/** @type {any[]} */ xs) => { const ls = xs.map((x) => x.last).filter((x) => x !== null); return ls.length ? Math.min(...ls) : null; };
        return {
            stretches: out.map((x) => ({ fromM: Math.round(x.fromM), toM: Math.round(x.toM), state: x.state, riders: x.riders, lastSeen: x.last })),
            coverage: {
                clearM: Math.round(totals.clearM), riddenM: Math.round(totals.riddenM), unknownM: Math.round(totals.unknownM), hazardM: Math.round(totals.hazardM),
                clearRiders: clear.length ? Math.min(...clear.map((x) => x.riders)) : 0, clearLastSeen: oldest(clear), riddenLastSeen: oldest(ridden)
            }
        };
    }

    /**
     * The Truth Card for a route.
     * @param {{ log: any, path: number[][], now: number, fromM?: number, cover?: any, community?: any[], corridorM?: number, stepM?: number, maxRows?: number }} o
     *   fromM: the rider's distance along the route (rows behind them are left out; aheadM counts from here)
     *   cover: the smooth-pass coverage (roadsense.js createCoverage); without it every unreported stretch is "unknown"
     *   community: published hazards (RoadPulse) with what riders said; shown with their counts
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
        const own = [...found.values()].sort((a, b) => a.alongM - b.alongM).slice(0, cfg.maxRows)
            .map(({ ev, alongM, offsetM }) => rowOf(ev, o.log, o.now, alongM, alongM - fromM, offsetM));
        const rows = withCommunity(own, o.community || [], (lat, lng) => { const pr = project(pts, lat, lng); return pr.offsetM <= cfg.corridorM ? pr : null; }, fromM, o.now).slice(0, cfg.maxRows);
        const t = tally(rows);
        const cov = stretchesOf(pts, fromM, rows, o.cover || null, o.now);
        const active = t.verified + t.candidates;
        return {
            at: o.now, lengthM: Math.round(lengthM), fromM: Math.round(fromM), rows, ...t, ...cov,
            // nothing reported AND nobody rode it: the only honest word is "unknown"
            unknown: active === 0 && cov.coverage.clearM === 0 && cov.coverage.riddenM === 0
        };
    }

    /**
     * Without a route: the events within radiusM of the rider, nearest first (straight-line distance as aheadM).
     * @param {{ log: any, lat: number, lng: number, now: number, radiusM?: number, maxRows?: number, community?: any[] }} o
     */
    function buildNear(o) {
        const radiusM = o.radiusM || 2000;
        const found = o.log.query({ lat: o.lat, lng: o.lng, radiusM, now: o.now }).slice(0, o.maxRows || DEFAULTS.maxRows);
        const own = found.map((/** @type {any} */ ev) => rowOf(ev, o.log, o.now, ev.distanceM, ev.distanceM, 0));
        const rows = withCommunity(own, o.community || [], (lat, lng) => { const d = dist(o.lat, o.lng, lat, lng); return d <= radiusM ? { alongM: d, offsetM: 0 } : null; }, 0, o.now).slice(0, o.maxRows || DEFAULTS.maxRows);
        const t = tally(rows);
        return {
            at: o.now, lengthM: 0, fromM: 0, rows, ...t, stretches: [],
            coverage: { clearM: 0, riddenM: 0, unknownM: 0, hazardM: 0, clearRiders: 0, clearLastSeen: null, riddenLastSeen: null },
            unknown: t.verified + t.candidates === 0
        };
    }

    /**
     * The values a phrase needs to SAY a card (the persona renders them; nothing is invented here).
     * @param {any} card @param {"ahead"|"route"|"near"} scope
     */
    function phraseData(card, scope) {
        const active = card.rows.filter((/** @type {any} */ r) => r.status === "verified" || r.status === "candidate");
        const first = active.find((/** @type {any} */ r) => r.status === "verified") || active[0] || null;
        const kinds = Object.entries(card.byKind).sort((a, b) => b[1] - a[1]);
        const word = (/** @type {string} */ k) => KIND_WORDS[/** @type {keyof typeof KIND_WORDS} */ (k)] || { desi: k, plain: k, many: k };
        const list = (/** @type {"desi"|"plain"} */ st) => kinds.map(([k, n]) => `${n} ${st === "plain" ? (n === 1 ? word(k).plain : word(k).many) : word(k).desi}`).join(st === "plain" ? ", " : " aur ");
        const where = { ahead: { desi: "aage ke raaste", plain: "the road ahead" }, route: { desi: "is raaste", plain: "this route" }, near: { desi: "aas-paas ki sadak", plain: "the roads around you" } }[scope];
        const cov = card.coverage || {};
        const now = card.at || 0;
        const clearAgo = cov.clearLastSeen ? ago((now - cov.clearLastSeen) / 1000) : null;
        const riddenAgo = cov.riddenLastSeen ? ago((now - cov.riddenLastSeen) / 1000) : null;
        const off = card.rows.find((/** @type {any} */ r) => r.status === "verified" && r.refs && r.refs.length) || null;
        const pred = card.rows.find((/** @type {any} */ r) => r.status === "predicted") || null;
        const predBy = pred && pred.predicted ? pred.predicted.refs.join(", ") : "";
        return {
            scope, count: active.length, verified: card.verified, candidates: card.candidates, predicted: card.predicted || 0,
            where: where.desi, kinds: list("desi"),
            hazard: first ? first.kind.desi : "", distanceM: first ? Math.max(10, first.aheadM) : 0, evidence: first ? first.words.desi : "", evidenceTu: first ? first.words.tu : "",
            // a published hazard's evidence already says how many riders confirmed it: no extra "bharosa" words
            confidence: first && first.confidence !== null ? confidenceWords(first.confidence).desi : "riders ke review ke hisaab se",
            clearM: cov.clearM || 0, clearRiders: cov.clearRiders || 0, clearAgo: clearAgo ? clearAgo.desi : "",
            unknownM: cov.unknownM || 0, riddenAgo: riddenAgo ? riddenAgo.desi : "",
            officialKind: off ? off.kind.desi : "", officialRefs: off ? off.refs.join(", ") : "", officialM: off ? Math.max(10, off.aheadM) : 0,
            predictedKind: pred ? pred.kind.desi : "", predictedM: pred ? Math.max(10, pred.aheadM) : 0, predictedBy: predBy,
            screen: {
                where: where.plain, kinds: list("plain"), hazard: first ? first.kind.plain : "", evidence: first ? first.words.plain : "",
                confidence: first && first.confidence !== null ? confidenceWords(first.confidence).plain : "",
                clearAgo: clearAgo ? clearAgo.plain : "", riddenAgo: riddenAgo ? riddenAgo.plain : "",
                officialKind: off ? off.kind.plain : "", predictedKind: pred ? pred.kind.plain : ""
            }
        };
    }

    /**
     * Which phrase says a card:
     *   reports on it          → road.truth (some confirmed) / road.truth-unconfirmed (none confirmed)
     *   no reports, ridden     → road.truth-clear (≥ 90 % clear) / road.truth-partly-clear / road.truth-ridden (1 rider)
     *   nothing at all         → road.truth-unknown
     * @param {any} card
     */
    function phraseKind(card) {
        if (card.verified > 0) return "road.truth";
        if (card.candidates > 0) return "road.truth-unconfirmed";
        const cov = card.coverage || {};
        const span = Math.max(1, (card.lengthM || 0) - (card.fromM || 0));
        if (cov.clearM > 0 && cov.clearM >= 0.9 * span) return "road.truth-clear";
        if (cov.clearM > 0) return "road.truth-partly-clear";
        if (cov.riddenM > 0) return "road.truth-ridden";
        return "road.truth-unknown";
    }

    /**
     * Sentences said after the main one, each a fixed phrase: what's known about the rest of the road (after
     * reports), an official list's item by name, and a model's prediction, never mixed with evidence.
     * @param {any} card
     */
    function phraseExtras(card) {
        const kind = phraseKind(card);
        /** @type {string[]} */ const out = [];
        if (kind === "road.truth" || kind === "road.truth-unconfirmed") out.push(card.coverage && card.coverage.clearM > 0 ? "road.truth-also-clear" : "road.truth-rest-unknown");
        if (card.rows.some((/** @type {any} */ r) => r.status === "verified" && r.refs && r.refs.length)) out.push("road.truth-official");
        if (card.rows.some((/** @type {any} */ r) => r.status === "predicted")) out.push("road.truth-predicted");
        return out;
    }

    return { DEFAULTS, KIND_WORDS, ago, confidenceWords, evidence, screenEvidence, communityEvidence, resample, project, buildTruth, buildNear, phraseData, phraseKind, phraseExtras };
});
