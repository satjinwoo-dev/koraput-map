// @ts-check
"use strict";
/* ============================================================================
   MapUnite RoadPulse — reputation and badges (Confirmed Decision 5)
   ==============================================================================
   Earned by ACCURACY, confirmed by OTHER riders — never by report count alone,
   kilometres, speed, or likes. Computed live from the reports and votes on every
   request, so a badge goes away by itself if accuracy falls (nothing to revoke).

   One report per hazard (and epoch) counts; at most 20 reports a day count.
   A report is
     confirmed  another rider (another contributor AND device) found it, 2 h+ later
     refuted    no such "found", and 2+ other riders didn't find it within 7 days
                of the report (later "not found" may just mean it was repaired)
     pending    neither yet
   accuracy = (confirmed + 1) / (confirmed + refuted + 2)   (Bayesian: 1 of 1 isn't 100%)

   Badges (starting rules, design priors):
     Rasta Scout       5 confirmed, accuracy ≥ 0.70
     Pakka Scout       25 confirmed, accuracy ≥ 0.80, in 3+ different months
     Sadak Prahari     100 confirmed, accuracy ≥ 0.85, and 20+ reviews of others' reports
     Ilaake ka Ustaad  20 confirmed in one area (≈ 25 km grid cell) over 3+ months
     Ghat Guardian     not awarded yet: it needs a ghat-road tag on hazards (DEM slope +
                       curvature), which isn't built; no badge is given on a guess.
   Reviews ("did you find it?") are counted as given, never scored: scoring them
   against the majority would teach riders to agree with the crowd.
   ============================================================================ */

const H = 3600000, D = 24 * H;
const RULES = Object.freeze({
    independentGapMs: 2 * H, refuteWithinMs: 7 * D, refuteNeeded: 2, perDay: 20, areaDeg: 0.25,
    badges: Object.freeze([
        { id: "rasta_scout", name: "Rasta Scout", en: "Road Scout", confirmed: 5, accuracy: 0.7 },
        { id: "pakka_scout", name: "Pakka Scout", en: "Trusted Road Scout", confirmed: 25, accuracy: 0.8, months: 3 },
        { id: "sadak_prahari", name: "Sadak Prahari", en: "Road Guardian", confirmed: 100, accuracy: 0.85, reviews: 20 },
        { id: "ilaake_ka_ustaad", name: "Ilaake ka Ustaad", en: "Local Route Expert", areaConfirmed: 20, areaMonths: 3 }
    ])
});
const monthOf = (/** @type {number} */ t) => { const d = new Date(t); return `${d.getUTCFullYear()}-${d.getUTCMonth()}`; };

/**
 * @param {{
 *   contributor: string,
 *   reports: { hazard_id: string, epoch: number, device: string|null, t: number, received: number, lat: number, lng: number }[],
 *   votesOf: (hazardId: string) => { contributor: string, device: string|null, verdict: string, t: number, epoch: number }[],
 *   reviewsGiven: number
 * }} o
 */
function reputationOf(o) {
    // one report per hazard and epoch (the first), at most perDay a day
    /** @type {Map<string, any>} */ const firsts = new Map();
    for (const r of [...o.reports].sort((a, b) => a.t - b.t)) { const k = `${r.hazard_id}#${r.epoch}`; if (!firsts.has(k)) firsts.set(k, r); }
    /** @type {Map<number, number>} */ const perDay = new Map();
    const counted = [];
    for (const r of [...firsts.values()].sort((a, b) => a.received - b.received)) {
        const day = Math.floor(r.received / D);
        const n = perDay.get(day) || 0;
        if (n >= RULES.perDay) continue;
        perDay.set(day, n + 1);
        counted.push(r);
    }
    let confirmed = 0, refuted = 0, pending = 0;
    /** @type {Set<string>} */ const months = new Set();
    /** @type {Map<string, { n: number, months: Set<string> }>} */ const areas = new Map();
    for (const r of counted) {
        const others = o.votesOf(r.hazard_id).filter((v) => v.epoch === r.epoch && v.contributor !== o.contributor && (!v.device || v.device !== r.device) && v.t >= r.t + RULES.independentGapMs);
        if (others.some((v) => v.verdict === "found")) {
            confirmed++;
            months.add(monthOf(r.t));
            const a = `${Math.floor(r.lat / RULES.areaDeg)}:${Math.floor(r.lng / RULES.areaDeg)}`;
            const x = areas.get(a) || { n: 0, months: new Set() };
            x.n++; x.months.add(monthOf(r.t)); areas.set(a, x);
        } else if (others.filter((v) => v.verdict === "not_found" && v.t <= r.t + RULES.refuteWithinMs).length >= RULES.refuteNeeded) refuted++;
        else pending++;
    }
    const accuracy = (confirmed + 1) / (confirmed + refuted + 2);
    const bestArea = [...areas.values()].sort((a, b) => b.n - a.n)[0] || { n: 0, months: new Set() };
    const badges = [];
    for (const b of RULES.badges) {
        const ok = "areaConfirmed" in b
            ? bestArea.n >= /** @type {number} */ (b.areaConfirmed) && bestArea.months.size >= /** @type {number} */ (b.areaMonths)
            : confirmed >= /** @type {number} */ (b.confirmed) && accuracy >= /** @type {number} */ (b.accuracy)
                && (!("months" in b) || months.size >= /** @type {number} */ (b.months)) && (!("reviews" in b) || o.reviewsGiven >= /** @type {number} */ (b.reviews));
        if (ok) badges.push({ id: b.id, name: b.name, en: b.en });
    }
    // the next badge in the main ladder, and what it still needs (motivation without a leaderboard)
    const ladder = RULES.badges.filter((b) => "confirmed" in b);
    const next = ladder.find((b) => !badges.some((x) => x.id === b.id)) || null;
    return {
        reports: counted.length, confirmed, refuted, pending, accuracy: Math.round(accuracy * 100) / 100, reviewsGiven: o.reviewsGiven, badges,
        next: next ? { id: next.id, name: next.name, en: next.en, needConfirmed: Math.max(0, /** @type {number} */ (next.confirmed) - confirmed), needAccuracy: next.accuracy } : null
    };
}

module.exports = { RULES, reputationOf };
