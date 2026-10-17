// @ts-check
/* ============================================================================
   MapUnite Rider Passport — what the profile says, and where each line comes from (pure)
   ==============================================================================
   Three kinds of line, always labelled, never mixed:
     self       what the rider typed (riding since, usual bike, a line about
                themselves): shown as "self-reported";
     app        what MapUnite recorded on this phone: distance, rides, riding
                time, towns ridden through, places shared, road reports the
                phone detected / the rider reviewed / the rider published;
     community  what OTHER riders' independent rides bore out (the RoadPulse
                server, lib/master/roadpulse-reputation.js): reports confirmed,
                accuracy, answers borne out later, thank-yous.
   "Confirmed" only ever comes from the server's independent-evidence rule
   (another contributor AND another device, 2 h+ later, one report per hazard).
   The rider's own approval or a like never confirms anything, and thank-yous
   are shown as helpfulness, not evidence.

   Visibility per line: "private" (only on this phone) or "card" (included on
   the Passport card when the rider shares it). Travel lines (towns) start
   private. MapUnite has no public profile page: nothing here is published
   unless the rider shares the card themself.

   Badges: for the QUALITY of contributions, never for distance, speed or count
   alone (no top speed, no "most km" anywhere). Each says why it was earned or
   what's missing; thresholds are in BADGES, to be tuned in the pilot.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else /** @type {any} */ (root).MUPassportModel = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /** @typedef {"private"|"card"} Vis */
    const DEFAULT_VIS = Object.freeze({
        experience: "card", bike: "card", about: "card",
        distance: "card", rides: "card", time: "private", towns: "private", placesShared: "card",
        reports: "card", confirmed: "card", helpful: "card", badges: "card"
    });

    /**
     * Badge rules. RoadPulse badges come from the server (it alone sees other riders' evidence); the others are
     * computed here from server numbers. Thresholds are design priors.
     */
    const BADGES = Object.freeze([
        { id: "rasta_scout", name: "Road Scout", local: "Rasta Scout", source: "server", rule: "5 of your reports confirmed by other riders' rides, with at least 70 % accuracy" },
        { id: "pakka_scout", name: "Reliable Reporter", local: "Pakka Scout", source: "server", rule: "25 reports confirmed by other riders, at least 80 % accuracy, over 3 or more months" },
        { id: "sadak_prahari", name: "Road Guardian", local: "Sadak Prahari", source: "server", rule: "100 confirmed reports, at least 85 % accuracy, and 20 of your answers on others' reports borne out by later riders" },
        { id: "ilaake_ka_ustaad", name: "Local Route Expert", local: "Ilaake ka Ustaad", source: "server", rule: "20 confirmed reports in one area (about 25 km across) over 3 or more months" },
        { id: "route_helper", name: "Route Helper", local: "", source: "computed", thanks: 10, confirmed: 3, rule: "10 thank-yous from riders, on top of at least 3 reports other riders confirmed (thanks alone never count)" },
        { id: "local_guide", name: "Local Guide", local: "", source: "unavailable", rule: "places you share, confirmed by other riders", unavailable: "Not awarded yet: MapUnite doesn't collect other riders' confirmations of shared places, and a badge isn't given on a guess." }
    ]);

    const n = (/** @type {any} */ v) => (Number.isFinite(v) ? Number(v) : 0);
    const plural = (/** @type {number} */ k, /** @type {string} */ one, /** @type {string} */ many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

    /**
     * Totals from this phone's ride log (rides under 200 m are never kept). Pure.
     * @param {Array<{ distance?: number, startedAt?: number, endedAt?: number, moving?: number, duration?: number, place?: string }>} rides
     */
    function rideTotals(rides) {
        const list = (rides || []).filter((r) => r && n(r.distance) >= 200);
        const distance = list.reduce((a, r) => a + n(r.distance), 0);
        const time = list.reduce((a, r) => a + (n(r.moving) || n(r.duration) || Math.max(0, (n(r.endedAt) - n(r.startedAt)) / 1000)), 0);
        const towns = [...new Set(list.map((r) => String(r.place || "").trim()).filter(Boolean))];
        const first = list.length ? Math.min(...list.map((r) => n(r.startedAt)).filter((t) => t > 0)) : null;
        return { rides: list.length, distance, time, towns, since: Number.isFinite(first) ? first : null };
    }

    /**
     * Road reports tallied on this phone, one entry per reviewed ride (a ride reviewed twice counts once). Pure.
     * @param {Record<string, { detected?: number, reviewed?: number, published?: number }>} perRide
     */
    function reportTotals(perRide) {
        const t = { detected: 0, reviewed: 0, published: 0, rides: 0 };
        for (const v of Object.values(perRide || {})) { t.detected += n(v.detected); t.reviewed += n(v.reviewed); t.published += n(v.published); t.rides++; }
        return t;
    }

    /**
     * The badges, each with why (or what's missing). Pure.
     * @param {any} community the server's /roadsense/me answer, or null (sharing off / offline)
     */
    function badges(community) {
        const c = community || null;
        const earnedIds = new Set(c && Array.isArray(c.badges) ? c.badges.map((/** @type {any} */ b) => b.id) : []);
        const pct = c ? Math.round(n(c.accuracy) * 100) : 0;
        return BADGES.map((b) => {
            if (b.source === "unavailable") return { id: b.id, name: b.name, earned: false, available: false, why: /** @type {string} */ (b.unavailable), rule: b.rule };
            if (!c) return { id: b.id, name: b.name, local: b.local, earned: false, available: true, why: "Turn on Community road reports to earn this: it needs other riders' rides to confirm your reports.", rule: b.rule };
            if (b.source === "server") {
                const earned = earnedIds.has(b.id);
                return { id: b.id, name: b.name, local: b.local, earned, available: true, rule: b.rule,
                    why: earned ? `${plural(n(c.confirmed), "report")} confirmed by other riders' rides, ${pct} % accuracy.` : `Needs: ${b.rule}. Now: ${n(c.confirmed)} confirmed, ${pct} % accuracy.` };
            }
            // Route Helper: helpfulness (thanks) on top of real, confirmed contributions
            const th = n(c.thanksReceived), cf = n(c.confirmed);
            const earned = th >= /** @type {number} */ (b.thanks) && cf >= /** @type {number} */ (b.confirmed);
            return { id: b.id, name: b.name, local: b.local, earned, available: true, rule: b.rule,
                why: earned ? `${plural(th, "thank-you")} from riders, and ${cf} of your reports confirmed by others.` : `Needs: ${b.rule}. Now: ${plural(th, "thank-you")}, ${cf} confirmed.` };
        });
    }

    /**
     * The whole Passport. Pure.
     * @param {{ self?: { name?: string, ridingSince?: number|null, bike?: string, about?: string }, rides?: any[],
     *   reports?: Record<string, any>, community?: any, placesShared?: number, visibility?: Partial<Record<keyof typeof DEFAULT_VIS, Vis>>, now?: number }} input
     */
    function build(input) {
        const now = input.now || Date.now();
        const vis = { ...DEFAULT_VIS, ...(input.visibility || {}) };
        const self = input.self || {};
        const rt = rideTotals(input.rides || []);
        const rp = reportTotals(input.reports || {});
        const c = input.community || null;
        const year = new Date(now).getFullYear();
        const since = Number.isInteger(self.ridingSince) && /** @type {number} */ (self.ridingSince) >= 1950 && /** @type {number} */ (self.ridingSince) <= year ? /** @type {number} */ (self.ridingSince) : null;
        const line = (/** @type {keyof typeof DEFAULT_VIS} */ id, /** @type {string} */ label, /** @type {string} */ value, /** @type {string} */ note = "") => ({ id, label, value, note, visibility: vis[id] });
        const km = rt.distance / 1000;
        const hrs = rt.time / 3600;
        const sections = [
            { id: "self", title: "About me", source: "self", tag: "Self-reported", items: [
                since !== null ? line("experience", "Riding since", `${since}`, `${year - since} year${year - since === 1 ? "" : "s"}, as the rider says`) : null,
                self.bike ? line("bike", "Usual bike", String(self.bike).slice(0, 40)) : null,
                self.about ? line("about", "About", String(self.about).slice(0, 140)) : null
            ].filter(Boolean) },
            { id: "app", title: "Recorded by MapUnite", source: "app", tag: "Recorded on this phone", items: [
                line("distance", "Distance ridden", `${km >= 100 ? Math.round(km) : Math.round(km * 10) / 10} km`, rt.since ? `${plural(rt.rides, "ride")} since ${new Date(rt.since).toLocaleDateString("en-IN", { month: "short", year: "numeric" })}` : "no rides recorded yet"),
                line("rides", "Rides", String(rt.rides)),
                line("time", "Riding time", hrs >= 1 ? `${Math.round(hrs)} h` : `${Math.round(rt.time / 60)} min`),
                line("towns", "Towns ridden through", String(rt.towns.length), rt.towns.slice(0, 6).join(", ")),
                line("placesShared", "Places shared", String(n(input.placesShared)), "shares you sent, not checked by anyone"),
                line("reports", "Road reports", `${rp.published} published`, `${rp.detected} detected by the phone · ${rp.reviewed} reviewed by you · ${rp.published} published`)
            ] },
            { id: "community", title: "Confirmed by other riders", source: "community", tag: "Independent rides", items: c ? [
                line("confirmed", "Reports confirmed", String(n(c.confirmed)), `by other riders' rides (another rider and phone, later) · ${n(c.pending)} waiting · ${Math.round(n(c.accuracy) * 100)} % accuracy`),
                line("helpful", "Thank-yous", String(n(c.thanksReceived)), "riders found your reports helpful (this is thanks, not proof a hazard is there)")
            ] : [] , empty: c ? "" : "Turn on Community road reports in Settings to see what other riders confirmed. Until then nothing here is claimed." }
        ];
        return { name: String(self.name || "Rider").slice(0, 40), sections, badges: badges(c), totals: { rides: rt, reports: rp } };
    }

    /** Only what the rider chose for the card (everything else stays on the phone). Pure. @param {ReturnType<typeof build>} p @param {Record<string, Vis>} [vis] */
    function forCard(p, vis = DEFAULT_VIS) {
        const sections = p.sections.map((s) => ({ ...s, items: s.items.filter((/** @type {any} */ it) => it.visibility === "card") })).filter((s) => s.items.length);
        return { name: p.name, sections, badges: vis.badges === "card" ? p.badges.filter((b) => b.earned) : [] };
    }

    return { DEFAULT_VIS, BADGES, rideTotals, reportTotals, badges, build, forCard };
});
