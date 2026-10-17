// @ts-check
/* ============================================================================
   MapUnite RoadPulse — community agreement: what riders who reviewed a hazard said
   ==============================================================================
   The percentage MapUnite shows is NOT "an 80% chance the pothole exists". It is:

       rider agreement = riders who found it / (riders who found it + riders who explicitly did not)

   among the riders who reviewed THIS hazard after riding past it. Riders who
   didn't review are not counted at all: not reviewing is not "no pothole". A
   phone's sensor riding over it and feeling nothing is a separate, labelled
   signal (roadsense.js coverage / absent passes), never part of this number.

   One module, run by the phone and by the server (lib/master/roadsense.js):

     publicType(type)            "impact" (pothole, hump, bump, broken patch) | "rough"
     findMatch(hazards, report)  the existing hazard a new report is a duplicate of, or null
     mergePosition(reports)      the hazard's marker from all its reports (accuracy-weighted)
     summarize(hazard, votes, now)  counts, agreement, status, freshness, whether to warn
     epochFor(hazard, summary, verdict)  a "found" on a fixed hazard opens a new epoch

   VOTES  { contributor, device?, verdict: "found"|"not_found"|"unsure", t, epoch }
     - the first report is the reporter's "found" vote;
     - one vote per rider per epoch: their LATEST counts (crossing it 5 times is
       still one rider); two accounts on one device count once;
     - "unsure" is kept and shown ("2 not sure"), never in the denominator.

   STATUS (first that applies)
     fixed        official repair data, or "maybe fixed" for 7 days with no new "found"
     maybe_fixed  after the last "found", 3+ riders didn't find it, on 2+ different days
     expired      the last "found" is older than the kind's lifetime (pothole 30 d,
                  rough 90 d, speed breaker 365 d: humps are built to stay)
     disputed     3+ reviewers and under 40% agreement: on the map, never warned
     active       an INDEPENDENT rider found it: another contributor, another device,
                  at least 2 hours after the first report
     reported     one rider's report so far: warned (calmly), shown as "1 rider reported"

   A later "found" on a fixed hazard opens a new EPOCH: potholes come back, and
   the old votes say nothing about the new hole.

   DIRECTION  Reports carry the rider's heading. A report matches a hazard only
   within 45° of its heading (dual carriageways are separate roads), unless the
   hazard is marked both ways (a rider said "both sides"). Opposite-direction
   reports never merge on their own: on a divided road the other carriageway can
   be 10 m away.

   All numbers here are design priors (basis: prior), to be tuned in the pilot.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); const M = W.MUMaster || (W.MUMaster = {}); M.roadAgreement = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const H = 3600000, D = 24 * H;
    const KINDS = Object.freeze({ pothole: "impact", speed_breaker: "impact", bump: "impact", broken_patch: "impact", rough: "rough" });
    const VERDICTS = Object.freeze(["found", "not_found", "unsure"]);
    const POLICY = Object.freeze({
        matchM: 15,                    // a report this close to a hazard (or 2σ of its fix) is the same hazard
        headingTolDeg: 45,
        maxNewSigmaM: 30,              // a report this inaccurate may vote on a hazard but never create one
        independentGapMs: 2 * H,
        minReviewersForPct: 3,         // fewer reviewers: counts only, no percentage
        disputedBelow: 0.4,
        maybeFixedNotFound: 3, maybeFixedDays: 2, fixedAfterMs: 7 * D,
        recentDisagree: 2,             // the last 2 riders after the last "found" didn't find it
        lifetimeMs: Object.freeze({ pothole: 30 * D, bump: 30 * D, broken_patch: 30 * D, rough: 90 * D, speed_breaker: 365 * D })
    });

    const M_PER_DEG = 111320;
    /** @param {number} lat @param {number} lng @param {number} lat2 @param {number} lng2 */
    function distM(lat, lng, lat2, lng2) {
        const n = (lat2 - lat) * M_PER_DEG, e = (lng2 - lng) * M_PER_DEG * Math.cos(lat * Math.PI / 180);
        return Math.hypot(n, e);
    }
    /** smallest angle between two headings, 0..180 @param {number} a @param {number} b */
    const headingDiff = (a, b) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };
    const fin = (/** @type {any} */ v) => typeof v === "number" && Number.isFinite(v);

    /** @param {string} type */
    const publicType = (type) => /** @type {any} */ (KINDS)[type] || null;

    /** Can this report be the same hazard? @param {any} h @param {any} r @param {typeof POLICY} [P] */
    function canMatch(h, r, P = POLICY) {
        if (!h || !r || publicType(h.type) !== publicType(r.type)) return false;
        const d = distM(h.lat, h.lng, r.lat, r.lng);
        if (d > Math.max(P.matchM, 2 * (fin(r.sigmaM) ? r.sigmaM : 0))) return false;
        if (h.bothWays || !fin(h.heading) || !fin(r.heading)) return true;
        return headingDiff(h.heading, r.heading) <= P.headingTolDeg;
    }

    /** The nearest hazard a report duplicates, or null. @param {any[]} hazards @param {any} r @param {typeof POLICY} [P] */
    function findMatch(hazards, r, P = POLICY) {
        let best = null, bestD = Infinity;
        for (const h of hazards || []) {
            if (!canMatch(h, r, P)) continue;
            const d = distM(h.lat, h.lng, r.lat, r.lng);
            if (d < bestD) { best = h; bestD = d; }
        }
        return best;
    }

    /**
     * The marker from all reports: an accuracy-weighted mean (1/σ²), after dropping reports more than 3× the
     * median distance from the median point (one bad fix can't drag the marker).
     * @param {{ lat: number, lng: number, sigmaM?: number|null }[]} reports
     */
    function mergePosition(reports) {
        const pts = (reports || []).filter((r) => fin(r.lat) && fin(r.lng));
        if (!pts.length) return null;
        const mean = (/** @type {any[]} */ xs, /** @type {(x: any) => number} */ w) => {
            let sw = 0, la = 0, ln = 0;
            for (const x of xs) { const k = w(x); sw += k; la += x.lat * k; ln += x.lng * k; }
            return { lat: la / sw, lng: ln / sw };
        };
        const median = (/** @type {number[]} */ xs) => { const s = [...xs].sort((a, b) => a - b); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
        const m0 = { lat: median(pts.map((p) => p.lat)), lng: median(pts.map((p) => p.lng)) };
        const ds = pts.map((p) => distM(m0.lat, m0.lng, p.lat, p.lng));
        const med = [...ds].sort((a, b) => a - b)[Math.floor(ds.length / 2)];
        const keep = pts.filter((_, i) => pts.length < 3 || ds[i] <= Math.max(3 * med, 3));
        const sig = (/** @type {any} */ p) => Math.max(2, fin(p.sigmaM) ? p.sigmaM : 10);
        const m = mean(keep, (p) => 1 / (sig(p) * sig(p)));
        const sigma = 1 / Math.sqrt(keep.reduce((s, p) => s + 1 / (sig(p) * sig(p)), 0));
        return { lat: m.lat, lng: m.lng, sigmaM: Math.round(sigma * 10) / 10, used: keep.length };
    }

    /** One vote per rider (their latest), two accounts on one device counted once. @param {any[]} votes @param {number} epoch */
    function latestVotes(votes, epoch) {
        /** @type {Map<string, any>} */ const byWho = new Map();
        for (const v of (votes || []).filter((x) => x && (x.epoch || 0) === epoch && VERDICTS.includes(x.verdict) && fin(x.t)).sort((a, b) => a.t - b.t)) {
            byWho.set(String(v.contributor), v);
        }
        /** @type {Map<string, any>} */ const byDevice = new Map();
        const out = [];
        for (const v of [...byWho.values()].sort((a, b) => a.t - b.t)) {
            if (v.device) {
                const prev = byDevice.get(v.device);
                if (prev) out.splice(out.indexOf(prev), 1);
                byDevice.set(v.device, v);
            }
            out.push(v);
        }
        return out.sort((a, b) => a.t - b.t);
    }

    const dayKey = (/** @type {number} */ t) => Math.floor(t / D);

    /**
     * Everything a card, a warning and the server need about one hazard.
     * @param {{ type: string, epoch?: number, firstReportedAt?: number, reporter?: string, reporterDevice?: string|null, fixedAt?: number|null }} h
     * @param {any[]} votes @param {number} now @param {typeof POLICY} [P]
     */
    function summarize(h, votes, now, P = POLICY) {
        const epoch = h.epoch || 0;
        const vs = latestVotes(votes, epoch);
        const found = vs.filter((v) => v.verdict === "found"), notFound = vs.filter((v) => v.verdict === "not_found"), unsure = vs.filter((v) => v.verdict === "unsure");
        const F = found.length, N = notFound.length;
        const firstAt = fin(h.firstReportedAt) ? /** @type {number} */ (h.firstReportedAt) : (vs[0] ? vs[0].t : now);
        const lastFoundAt = F ? Math.max(...found.map((v) => v.t)) : null;
        const lastReviewedAt = vs.length ? Math.max(...vs.map((v) => v.t)) : null;
        // independent confirmation: someone else, on another device, well after the first report
        const independent = found.some((v) => String(v.contributor) !== String(h.reporter) && (!v.device || v.device !== h.reporterDevice) && v.t >= firstAt + P.independentGapMs);
        // after the last "found": who didn't find it, and on how many days
        const after = lastFoundAt === null ? vs : vs.filter((v) => v.t > lastFoundAt);
        const afterNo = after.filter((v) => v.verdict === "not_found");
        let maybeFixedSince = null;
        /** @type {Set<number>} */ const days = new Set();
        for (let i = 0; i < afterNo.length; i++) {
            days.add(dayKey(afterNo[i].t));
            if (i + 1 >= P.maybeFixedNotFound && days.size >= P.maybeFixedDays) { maybeFixedSince = afterNo[i].t; break; }
        }
        const decided = after.filter((v) => v.verdict !== "unsure");
        const recentDisagree = lastFoundAt !== null && decided.length >= P.recentDisagree && decided.slice(-P.recentDisagree).every((v) => v.verdict === "not_found");
        const lifetime = /** @type {any} */ (P.lifetimeMs)[h.type] || 30 * D;
        const expiresAt = (lastFoundAt ?? firstAt) + lifetime;
        const reviewers = F + N;
        const agreement = reviewers >= P.minReviewersForPct ? F / reviewers : null;
        let status;
        if (fin(h.fixedAt) || (maybeFixedSince !== null && now - maybeFixedSince >= P.fixedAfterMs)) status = "fixed";
        else if (maybeFixedSince !== null) status = "maybe_fixed";
        else if (now > expiresAt) status = "expired";
        else if (agreement !== null && agreement < P.disputedBelow) status = "disputed";
        else if (independent) status = "active";
        else if (F > 0) status = "reported";
        else status = "disputed";              // nobody (any more) says it's there
        return {
            epoch, status, found: F, notFound: N, unsure: unsure.length, reviewers, agreement,
            agreementPct: agreement === null ? null : Math.round(agreement * 100),
            firstReportedAt: firstAt, lastFoundAt, lastReviewedAt, independent, recentDisagree, maybeFixedSince, expiresAt,
            alertable: status === "reported" || status === "active"
        };
    }

    /** The epoch a new vote belongs to: a "found" on a fixed hazard is a new pothole. @param {any} h @param {any} summary @param {string} verdict */
    function epochFor(h, summary, verdict) {
        const e = h.epoch || 0;
        return summary && summary.status === "fixed" && verdict === "found" ? e + 1 : e;
    }

    return { KINDS, VERDICTS, POLICY, publicType, canMatch, findMatch, mergePosition, latestVotes, summarize, epochFor, headingDiff, distM };
});
