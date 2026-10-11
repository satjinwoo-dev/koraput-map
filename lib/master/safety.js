// @ts-check
"use strict";
/* ============================================================================
   MapUnite Master AI (server) — how safe is the arrival at the destination?
   ==============================================================================
   POST /api/master/destination  { lat, lng, etaS, name? }
     → { ok, score 0–100, level: "good"|"care"|"caution", factors: [{ id, weight, detail }],
         facts: { light, weather, blackspotsWithin3km, hospital, police, servicesWithin2km } }

   WHAT THIS IS — AND ISN'T. India has no public, per-location, up-to-date crime
   dataset that can be used this way, and a made-up "crime score" would be both
   wrong and unfair to the people who live there. So this is an ARRIVAL RISK
   score for a rider: things that are measurable and that change what a rider
   should do. Each factor is shown with its reason; the app never says a place
   is "unsafe", it says what to plan for.

     dark arrival        sun < −6° at ETA: −20 (dusk 0…−6°: −10)
     weather at ETA      a warning hazard −20, an advice hazard −8   (Open-Meteo)
     blackspots          official blackspots within 3 km: −6 each, max −24
     hospital far        nearest hospital > 10 km: −12 (> 25 km or none: −18)
     police far          nearest police station > 5 km or none: −6
     remote              < 3 everyday services (food, fuel, pharmacy, ATM) within 2 km: −10
     long ride           ETA > 4 h: −6 (fatigue on arrival)
   score = 100 + Σ; level: ≥ 75 good, ≥ 50 care, else caution.
   ============================================================================ */

const { isCoord } = require("./geo");
const { light } = require("./sun");

/**
 * Pure scoring from facts (tests feed this directly).
 * @param {{ light: "day"|"dusk"|"dark", weather: any, blackspots: number, hospitalM: number|null, policeM: number|null, services: number|null, etaS: number }} f
 */
function score(f) {
    /** @type {Array<{ id: string, weight: number, detail: string }>} */ const factors = [];
    if (f.light === "dark") factors.push({ id: "dark", weight: -20, detail: "It will be dark when you arrive" });
    else if (f.light === "dusk") factors.push({ id: "dusk", weight: -10, detail: "You'll arrive around dusk" });
    const hz = (f.weather && Array.isArray(f.weather.hazards)) ? f.weather.hazards : [];
    const warn = hz.find((/** @type {any} */ h) => h.level === "warning"), adv = hz.find((/** @type {any} */ h) => h.level === "advice");
    if (warn) factors.push({ id: `weather-${warn.type}`, weight: -20, detail: `Forecast at arrival: ${warn.type.replace("-", " ")}` });
    else if (adv) factors.push({ id: `weather-${adv.type}`, weight: -8, detail: `Forecast at arrival: ${adv.type.replace("-", " ")}` });
    if (f.blackspots > 0) factors.push({ id: "blackspots", weight: -Math.min(24, 6 * f.blackspots), detail: `${f.blackspots} listed accident blackspot${f.blackspots > 1 ? "s" : ""} within 3 km` });
    if (f.hospitalM === null || f.hospitalM > 25000) factors.push({ id: "hospital-far", weight: -18, detail: f.hospitalM === null ? "No hospital found within 15 km" : "Nearest hospital is over 25 km away" });
    else if (f.hospitalM > 10000) factors.push({ id: "hospital-far", weight: -12, detail: `Nearest hospital is ${Math.round(f.hospitalM / 1000)} km away` });
    if (f.policeM === null || f.policeM > 5000) factors.push({ id: "police-far", weight: -6, detail: "No police station within 5 km" });
    if (f.services !== null && f.services < 3) factors.push({ id: "remote", weight: -10, detail: "Few shops or services nearby: a remote spot" });
    if (f.etaS > 4 * 3600) factors.push({ id: "long-ride", weight: -6, detail: "Over 4 hours of riding before you arrive" });
    const s = Math.max(0, Math.min(100, 100 + factors.reduce((a, x) => a + x.weight, 0)));
    return { score: s, level: s >= 75 ? "good" : s >= 50 ? "care" : "caution", factors };
}

/**
 * @param {{ weather: { at: Function }, blackspots: { nearPoint: Function }, poi: { safetyAnchors: Function }, now?: () => number }} deps
 */
function createSafety(deps) {
    const now = deps.now || (() => Date.now());
    /** @param {any} body @returns {Promise<{ status: number, json: any }>} */
    async function handle(body) {
        const lat = Number(body && body.lat), lng = Number(body && body.lng);
        if (!isCoord(lat, lng)) return { status: 400, json: { ok: false, reason: "bad-position" } };
        const etaS = Math.max(0, Math.min(48 * 3600, Number(body.etaS) || 0));
        const arrive = now() + etaS * 1000;
        const [w, anchors] = await Promise.allSettled([deps.weather.at(lat, lng, arrive), deps.poi.safetyAnchors(lat, lng)]);
        const weather = w.status === "fulfilled" ? w.value : null;
        const a = anchors.status === "fulfilled" ? anchors.value : null;
        const spots = deps.blackspots.nearPoint(lat, lng, 3000);
        const facts = {
            light: light(lat, lng, arrive), weather,
            blackspotsWithin3km: spots.length,
            hospital: a ? a.hospital : undefined, police: a ? a.police : undefined,
            servicesWithin2km: a ? a.servicesWithin2km : null
        };
        const s = score({
            light: facts.light, weather, blackspots: spots.length,
            // anchors unavailable (Overpass down): don't punish the place for our outage
            hospitalM: a ? (a.hospital ? a.hospital.distanceM : null) : 0,
            policeM: a ? (a.police ? a.police.distanceM : null) : 0,
            services: a ? a.servicesWithin2km : null, etaS
        });
        return { status: 200, json: { ok: true, ...s, facts, arriveAt: arrive, partial: !a || !weather } };
    }
    return { handle, score };
}

module.exports = { createSafety, score };
