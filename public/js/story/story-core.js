// @ts-check
/* ============================================================================
   MapUnite Ride Story — the whole ride, worked out (pure)
   ==============================================================================
   build(journal, ctx) → everything the Ride Story screen shows, from the ride
   journal (js/story/journal.js), the HUD's trip totals and what the phone
   knows about the bike and the people on it. Strict SI out; the screen formats.

   Nothing is made up:
     - fuel, cost, eco score and hard moments are the HUD's (physics × the
       learned correction); the stretches add up to the same fuel;
     - "where it went" (air, rolling, climbing, speeding up) is the road-load
       physics' share of the push at the wheel, applied to the fuel burnt while
       moving: an estimate, and the screen says ≈;
     - weights marked typical are the bike class's typical rider (72 kg) when the
       rider hasn't entered their own;
     - potholes and rough road come from the phone's road sensor (the Android
       app's DynamicsCore) for THIS ride; without it the screen says the sensor
       was off, never "0 potholes";
     - weather is Open-Meteo's, sampled during the ride; offline → none.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const ns = /** @type {any} */ (root).MUStory || (/** @type {any} */ (root).MUStory = {}); ns.core = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const STORY_DEFAULTS = Object.freeze({
        eco: 0.8, thirsty: 0.55,        // stretch eco score bands (best possible ÷ actual)
        minHighlight: 500,              // m: a highlighted stretch is at least this long
        hardPer100: 10,                 // hard moments per 100 km that make the ride "hard"
        fastShare: 0.4, overShare: 0.15
    });
    const fin = (x) => typeof x === "number" && Number.isFinite(x);
    const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
    const WMO = [[0, "Clear sky", "☀️"], [1, "Mostly clear", "🌤️"], [2, "Partly cloudy", "⛅"], [3, "Overcast", "☁️"], [45, "Fog", "🌫️"], [48, "Fog", "🌫️"], [51, "Drizzle", "🌦️"], [56, "Freezing drizzle", "🌧️"], [61, "Rain", "🌧️"], [65, "Heavy rain", "🌧️"], [66, "Freezing rain", "🌧️"], [71, "Snow", "🌨️"], [80, "Rain showers", "🌦️"], [82, "Heavy showers", "⛈️"], [95, "Thunderstorm", "⛈️"]];
    const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

    /** @param {number|null} code */
    function sky(code) {
        if (!fin(code)) return null;
        let best = WMO[0];
        for (const w of WMO) if (/** @type {number} */ (code) >= Number(w[0])) best = w;
        return { text: String(best[1]), icon: String(best[2]) };
    }
    /** @param {number} deg */
    const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

    /** Stretch eco score: the best the bike could do there ÷ what it cost (1 = as good as it gets). */
    function scoreOf(x) { return x.e > 0 ? Math.max(0, Math.min(1, x.ideal / x.e)) : 1; }
    /** @param {number} sc */
    function kindOf(sc, D = STORY_DEFAULTS) { return sc >= D.eco ? "eco" : sc < D.thirsty ? "thirsty" : "normal"; }

    /** Consecutive stretches of one kind → runs. */
    function runs(st) {
        const out = [];
        for (const x of st) {
            const k = kindOf(scoreOf(x));
            const prev = out[out.length - 1];
            if (prev && prev.kind === k) prev.parts.push(x); else out.push({ kind: k, parts: [x] });
        }
        return out.map((r) => agg(r.parts, r.kind));
    }
    function agg(parts, kind) {
        const a = { kind, from: parts[0].s0, to: parts[0].s0, d: 0, e: 0, ideal: 0, time: 0, moving: 0, climb: 0, desc: 0, above: 0, accelT: 0, idle: 0, idleOn: 0, idleE: 0, brakes: 0, pulls: 0, vmax: 0, lat: null, lng: null };
        for (const p of parts) {
            for (const k of ["d", "e", "ideal", "time", "moving", "climb", "desc", "above", "accelT", "idle", "idleOn", "idleE", "brakes", "pulls"]) a[k] += p[k] || 0;
            a.vmax = Math.max(a.vmax, p.vmax || 0);
            if (p.lat !== null && a.lat === null) { a.lat = p.lat; a.lng = p.lng; }
        }
        a.to = a.from + a.d;
        return { ...a, score: scoreOf(a), perMetre: a.d > 0 ? a.e / a.d : null, speed: a.moving > 0 ? a.d / a.moving : null };
    }

    /** Why a stretch cost what it did, from its own numbers. */
    function reasons(x, best) {
        const r = [];
        const grade = x.d > 0 ? (x.climb - x.desc) / x.d : 0;
        if (best) {
            if (x.desc > x.climb && x.desc > 5) r.push({ key: "downhill", text: `downhill (−${Math.round(x.desc)} m)` });
            if (x.moving > 0 && x.above / x.moving < 0.15 && x.accelT / Math.max(1, x.moving) < 0.15) r.push({ key: "steady", text: "steady, in the eco speed band" });
            if (!r.length) r.push({ key: "smooth", text: "smooth throttle" });
            return r;
        }
        if (grade > 0.015 && x.climb > 8) r.push({ key: "uphill", text: `uphill (+${Math.round(x.climb)} m)` });
        if (x.moving > 0 && x.above / x.moving >= 0.3) r.push({ key: "fast", text: "faster than the eco speed" });
        if ((x.accelT / Math.max(1, x.moving) >= 0.25) || x.pulls > 0) r.push({ key: "pickup", text: x.pulls ? `${x.pulls} hard pick-up${x.pulls > 1 ? "s" : ""}` : "lots of speeding up" });
        if (x.brakes > 0) r.push({ key: "brakes", text: `${x.brakes} hard brake${x.brakes > 1 ? "s" : ""}` });
        const on = Number.isFinite(x.idleOn) ? x.idleOn : x.idle;
        if (on >= 30) r.push({ key: "idle", text: on < 90 ? `${Math.round(on)} s idling` : `${Math.round(on / 60)} min idling` });
        if (x.speed !== null && x.speed < 5 && on >= 30) r.push({ key: "traffic", text: "slow traffic" });
        if (!r.length) r.push({ key: "uneven", text: "speed going up and down" });
        return r;
    }

    /**
     * The road this phone's sensor felt on this ride (js/master/roadsense/review.js's ride record).
     * @param {any} rec @param {number} from @param {number} to
     */
    function roadFrom(rec, from, to) {
        if (!rec || !Array.isArray(rec.items) || !fin(rec.startedAt)) return { sensor: false };
        const recEnd = fin(rec.endedAt) ? rec.endedAt : to;
        if (rec.startedAt > to + 120000 || recEnd < from - 120000) return { sensor: false };
        const mine = rec.items.filter((x) => x && fin(x.t) && x.t >= from - 60000 && x.t <= to + 60000 && fin(x.lat) && fin(x.lng));
        const big = mine.filter((x) => !x.minor && !x.unknown);
        const of = (k) => big.filter((x) => x.hazard === k && x.kind !== "rough");
        const rough = big.filter((x) => x.kind === "rough");
        return {
            sensor: true,
            potholes: of("pothole").length, breakers: of("speed_breaker").length, bumps: of("bump").length,
            rough: rough.length, roughM: sum(rough, (x) => (fin(x.lengthM) ? x.lengthM : 0)),
            small: mine.filter((x) => x.minor && !x.unknown).length, unknown: mine.filter((x) => x.unknown).length,
            spots: big.map((x) => ({ type: x.kind === "rough" ? "rough" : x.hazard, lat: x.lat, lng: x.lng, severity: x.severity || 2 })).slice(0, 80)
        };
    }

    /**
     * @param {any} j the journal (journal.finish())
     * @param {any} ctx { trip (the HUD's trip totals), ev, priceUnit, bike: { name, tankM3 }, people: { me, rider, pillion },
     *   usualKmL, bestPm (the bike's best fuel per metre on the flat), tank: { start, end } (m³), road (sensor ride record), places: { start, end } }
     */
    function build(j, ctx = {}) {
        const D = STORY_DEFAULTS;
        const trip = ctx.trip || {};
        const ev = Boolean(ctx.ev);
        const st = Array.isArray(j && j.stretches) ? j.stretches.filter((x) => x && (x.d > 0 || x.time > 0)) : [];
        const startedAt = fin(trip.startedAt) ? trip.startedAt : j.startedAt, endedAt = fin(trip.endedAt) ? trip.endedAt : j.endedAt;
        const distance = fin(trip.distance) && trip.distance > 0 ? trip.distance : (j.distance || 0);
        const energy = fin(trip.energy) ? Math.max(0, trip.energy) : Math.max(0, sum(st, (x) => x.e));
        const idleE = sum(st, (x) => x.idleE || 0);
        const ideal = sum(st, (x) => x.ideal);
        const moving = fin(trip.moving) ? trip.moving : sum(st, (x) => x.moving);
        const duration = fin(startedAt) && fin(endedAt) ? Math.max(0, (endedAt - startedAt) / 1000) : (trip.time || 0);
        const cost = fin(trip.cost) ? trip.cost : null;
        const pricePer = cost !== null && energy > 0 ? cost / energy : null;

        // ---- time
        const stops = Array.isArray(j.stops) ? j.stops : [];
        const traffic = stops.filter((x) => !x.rest), rest = stops.filter((x) => x.rest);
        const time = {
            duration, riding: moving, standing: Math.max(0, duration - moving),
            stops: stops.length, traffic: traffic.length, trafficTime: sum(traffic, (x) => x.dur), rest: rest.length, restTime: sum(rest, (x) => x.dur),
            longestRun: j.longestRun ? { time: j.longestRun.t, distance: j.longestRun.d } : null,
            longestRest: rest.reduce((m, x) => Math.max(m, x.dur), 0) || null
        };

        // ---- fuel / energy
        const fuel = {
            used: energy, idle: idleE, cost, ideal: Math.min(energy, ideal + idleE),
            perMetre: distance > 50 && energy > 0 ? energy / distance : null,
            economy: !ev && energy > 0 && distance > 100 ? (distance / 1000) / (energy * 1000) : null,       // km/L
            whPerKm: ev && energy > 0 && distance > 100 ? (energy / 3600) / (distance / 1000) : null,
            usualKmL: fin(ctx.usualKmL) ? ctx.usualKmL : null,
            bestKmL: !ev && fin(ctx.bestPm) && ctx.bestPm > 0 ? 1 / (ctx.bestPm * 1e6) : null,
            tankStart: ctx.tank && fin(ctx.tank.start) ? ctx.tank.start : null,
            tankEnd: ctx.tank && fin(ctx.tank.start) ? Math.max(0, ctx.tank.start - energy) : null,
            tank: ctx.bike && fin(ctx.bike.tankM3) ? ctx.bike.tankM3 : null,
            save: 0, saveCost: null, vsUsual: null
        };
        fuel.save = Math.max(0, energy - fuel.ideal);
        fuel.saveCost = pricePer !== null ? fuel.save * pricePer : null;
        if (fuel.economy !== null && fuel.usualKmL) fuel.vsUsual = fuel.economy / fuel.usualKmL - 1;

        // ---- where the push went (≈: physics shares of the wheel work, applied to the fuel burnt while moving)
        const w = j.work || {};
        const W = (w.air || 0) + (w.rolling || 0) + (w.climb || 0) + (w.accel || 0);
        const movingE = Math.max(0, energy - idleE);
        const parts = W > 0 ? [["air", "Air drag", w.air], ["rolling", "Tyres rolling", w.rolling], ["climb", "Climbing", w.climb], ["accel", "Speeding up", w.accel]]
            .map(([key, label, x]) => ({ key, label, share: /** @type {number} */ (x) / W, fuel: movingE * /** @type {number} */ (x) / W })) : [];
        if (idleE > 0 && energy > 0) parts.push({ key: "idle", label: "Idling", share: null, fuel: idleE });
        const airShare = W > 0 ? (w.air || 0) / W : null;
        const windFuel = W > 0 && fin(w.wind) ? movingE * w.wind / W : null;
        const hw = fin(j.headwind) ? j.headwind : null;
        const drag = {
            share: airShare, fuel: W > 0 ? movingE * (w.air || 0) / W : null,
            wind: hw === null ? null : { headwind: hw, kind: Math.abs(hw) < 0.5 ? "calm" : hw > 0 ? "head" : "tail", fuel: windFuel, cost: windFuel !== null && pricePer !== null ? windFuel * pricePer : null },
            cda: j.physics ? j.physics.cda : null, rho: fin(j.rho) ? j.rho : null, rhoStd: j.physics ? j.physics.rhoStd : null
        };

        // ---- weather
        const ws = Array.isArray(j.weather) ? j.weather.filter((x) => fin(x.tempK) || fin(x.windMs)) : [];
        const avg = (k) => { const v = ws.filter((x) => fin(x[k])); return v.length ? sum(v, (x) => x[k]) / v.length : null; };
        let weather = null;
        if (ws.length) {
            const codes = ws.map((x) => x.code).filter(fin);
            const worst = codes.length ? Math.max(...codes) : null;
            const windFrom = (() => { const v = ws.filter((x) => fin(x.windFrom) && fin(x.windMs)); if (!v.length) return null; const sx = sum(v, (x) => Math.sin(x.windFrom * Math.PI / 180) * x.windMs), cx = sum(v, (x) => Math.cos(x.windFrom * Math.PI / 180) * x.windMs); return (Math.atan2(sx, cx) * 180 / Math.PI + 360) % 360; })();
            const tK = avg("tempK");
            weather = {
                tempC: tK !== null ? tK - 273.15 : null, rh: avg("rh"), wind: avg("windMs"), windFrom, windFromText: windFrom !== null ? compass(windFrom) : null,
                sky: sky(worst), precip: sum(ws, (x) => (fin(x.precipMm) ? x.precipMm : 0)), samples: ws.length,
                densityVsStd: drag.rho !== null && drag.rhoStd ? drag.rho / drag.rhoStd - 1 : null
            };
        }

        // ---- stretches and highlights
        const R = runs(st);
        const pick = (list, f) => list.reduce((b, x) => (b === null || f(x) > f(b) ? x : b), null);
        const longEnough = (x) => x.d >= D.minHighlight;
        const thirsty = pick(R.filter((x) => x.kind === "thirsty" && longEnough(x)), (x) => x.e - x.ideal);
        const ecoRun = pick(R.filter((x) => x.kind === "eco" && longEnough(x)), (x) => x.d);
        // the thriftiest kilometre (or so): the lowest fuel per metre over ≥ 1 km of consecutive stretches
        let thrifty = null;
        for (let i = 0; i < st.length; i++) {
            const parts2 = [];
            let d = 0;
            for (let k = i; k < st.length && d < 1000; k++) { parts2.push(st[k]); d += st[k].d; }
            if (d < Math.min(1000, distance * 0.5) || !parts2.length) continue;
            const a = agg(parts2, "thrifty");
            if (a.moving > 0 && (thrifty === null || a.perMetre < thrifty.perMetre)) thrifty = a;
        }
        const hl = (x, best) => (x ? { from: x.from, to: x.to, distance: x.d, fuel: x.e, extra: Math.max(0, x.e - x.ideal), perMetre: x.perMetre, score: x.score, speed: x.speed, lat: x.lat, lng: x.lng, reasons: reasons(x, best) } : null);
        const highlights = { thirsty: hl(thirsty, false), thrifty: hl(thrifty, true), eco: hl(ecoRun, true) };
        const share = (k) => { const d = sum(R.filter((x) => x.kind === k), (x) => x.d); return distance > 0 ? d / distance : 0; };
        const mix = { eco: share("eco"), normal: share("normal"), thirsty: share("thirsty") };

        // ---- riding behaviour
        const brakes = Array.isArray(j.brakes) ? j.brakes : [], pulls = Array.isArray(j.pulls) ? j.pulls : [];
        const hard = brakes.length + pulls.length;
        const per100 = distance >= 2000 ? hard / (distance / 100000) : null;
        const ecoScore = fin(trip.ecoScore) ? trip.ecoScore : (energy > 0 ? Math.min(1, ideal / Math.max(1e-12, energy - idleE)) : null);
        const aboveShare = moving > 0 ? sum(st, (x) => x.above) / moving : null;
        const overShare = j.limit ? j.limit.overShare : null;
        let mood;
        if (per100 !== null && per100 >= D.hardPer100 && hard >= 3) mood = brakes.length >= pulls.length ? { key: "brakes", label: "Hard on the brakes", tone: "red", icon: "🛑" } : { key: "throttle", label: "Quick on the throttle", tone: "red", icon: "⚡" };
        else if ((overShare !== null && overShare >= D.overShare) || (aboveShare !== null && aboveShare >= D.fastShare)) mood = { key: "fast", label: "Speedster", tone: "amber", icon: "🔥" };
        else if (ecoScore !== null && ecoScore >= 0.8 && (per100 === null || per100 <= 4)) mood = { key: "smooth", label: "Smooth operator", tone: "green", icon: "🍃" };
        else if (ecoScore !== null && ecoScore >= 0.65) mood = { key: "steady", label: "Steady cruiser", tone: "teal", icon: "🛣️" };
        else mood = { key: "mixed", label: "Mixed riding", tone: "amber", icon: "🌀" };
        const behaviour = {
            ...mood, ecoScore, hardBrakes: brakes.length, hardPulls: pulls.length, per100,
            inBand: j.band ? j.band.share : null, above: aboveShare, overLimit: overShare, overLimitTime: j.limit ? j.limit.over : null,
            top: j.top ? { speed: j.top.v, at: j.top.s } : (fin(trip.maxSpeed) ? { speed: trip.maxSpeed, at: null } : null),
            avgMoving: moving > 0 ? distance / moving : null,
            brakeList: brakes.map((b) => ({ at: b.s, from: b.from, lat: b.lat, lng: b.lng })).slice(0, 40)
        };

        // ---- people and bike
        const p = ctx.people || {};
        const phys = j.physics || {};
        const bike = {
            name: ctx.bike && ctx.bike.name ? String(ctx.bike.name) : null, mass: fin(phys.vehicleMass) ? phys.vehicleMass : null,
            tank: fuel.tank, typical: Boolean(ctx.bike && ctx.bike.typical)
        };
        const people = { me: p.me || "rider", rider: p.rider || null, pillion: p.pillion || null, total: fin(phys.mass) ? phys.mass : null, luggage: fin(phys.extraMass) && p.pillion && fin(p.pillion.kg) ? Math.max(0, phys.extraMass - p.pillion.kg) : (fin(phys.extraMass) && !p.pillion ? phys.extraMass : null) };

        // ---- the chart: one point per stretch
        let elev = 0;
        const series = st.map((x) => { elev += x.climb - x.desc; return { at: x.s0 + x.d / 2, speed: x.moving > 0 ? x.d / x.moving : 0, perMetre: x.d > 20 ? x.e / x.d : null, score: scoreOf(x), kind: kindOf(scoreOf(x)), elev, lat: x.lat, lng: x.lng }; });
        const climb = sum(st, (x) => x.climb), descent = sum(st, (x) => x.desc);

        // ---- fun facts (each from the numbers above)
        const facts = [];
        if (climb >= 15) facts.push({ key: "floors", value: Math.round(climb / 3), text: `You climbed ${Math.round(climb)} m: about ${Math.round(climb / 3)} floors of stairs.` });
        if (airShare !== null && airShare >= 0.4) facts.push({ key: "air", value: airShare, text: `${Math.round(airShare * 100)}% of the push went into the air. Drag grows with speed²: 10% slower ≈ 19% less drag.` });
        if (time.longestRun && time.longestRun.distance >= 1000) facts.push({ key: "run", value: time.longestRun.distance, text: "Longest non-stop stretch" });
        if (fuel.saveCost !== null && fuel.saveCost >= 1) facts.push({ key: "save", value: fuel.saveCost, text: "Fully eco riding would have saved" });
        if (behaviour.top && behaviour.top.at !== null) facts.push({ key: "top", value: behaviour.top.speed, text: "Top speed" });
        if (people.total) facts.push({ key: "mass", value: people.total, text: "Moving weight on the road" });

        return {
            v: 1, title: titleFor(startedAt), startedAt, endedAt, ev,
            places: { start: ctx.places && ctx.places.start ? String(ctx.places.start) : null, end: ctx.places && ctx.places.end ? String(ctx.places.end) : null },
            start: j.start || null, end: j.end || null,
            headline: { distance, duration, moving, avgMoving: behaviour.avgMoving, maxSpeed: fin(trip.maxSpeed) ? trip.maxSpeed : (j.top ? j.top.v : null), climb, descent },
            time, fuel, parts, drag, weather, highlights, mix, behaviour, bike, people,
            road: roadFrom(ctx.road, startedAt, endedAt), series, route: Array.isArray(j.route) ? j.route : [],
            stopList: stops.map((x) => ({ at: x.s, dur: x.dur, rest: x.rest, lat: x.lat, lng: x.lng })),
            facts, priceUnit: ctx.priceUnit || null, priceExample: Boolean(ctx.priceExample), corrected: Boolean(ctx.corrected)
        };
    }

    /** @param {number} ts */
    function titleFor(ts) {
        const h = new Date(fin(ts) ? ts : Date.now()).getHours();
        return h >= 5 && h < 11 ? "Morning ride" : h >= 11 && h < 16 ? "Afternoon ride" : h >= 16 && h < 20 ? "Evening ride" : "Night ride";
    }

    return { STORY_DEFAULTS, build, roadFrom, sky, compass, scoreOf, kindOf, runs, reasons, titleFor };
});
