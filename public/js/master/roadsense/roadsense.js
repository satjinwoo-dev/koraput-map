// @ts-check
/* ============================================================================
   MapUnite RoadSense Live — the road event log and its verification rules
   ==============================================================================
   One record of what is on the road, kept on the phone. Sensors and people add
   OBSERVATIONS; the log groups them into EVENTS (one per spot and kind) and
   decides, by fixed rules, how much each event can be believed:

     observation  { type, t, lat, lng, source, rider, present, conf, peakMs2? }
                  present: true  = "it is here" (a jolt, a camera sighting, a report)
                  present: false = "I went over this spot and it was NOT there"
     event        the observations within 12 m of each other, same kind, plus
                  status: "candidate" | "verified" | "cleared" | "expired"
                  confidence 0..1, and the evidence summary a Truth Card shows

   The rules (assess()), "sensors verify":
     1. Every piece of evidence fades with age: weight = conf × ½^(age / halfLife),
        halfLife per kind (a pothole lasts weeks, water on the road hours).
     2. confidence = 1 − Π(1 − weight) over "it is here" pieces (noisy-OR), then
        × Π(1 − absenceWeight × weight) over "not there" passes made AFTER the
        latest sighting. Passes before a sighting don't count (it came back, or
        that rider swerved round it).
     3. verified  = ≥ 2 independent pieces still worth ≥ minPieceWeight, and
                    confidence ≥ verifyConf. Independent = a different rider, a
                    separate pass by the same rider (≥ 60 s apart), or a
                    different sensor in the same pass (IMU + camera). An
                    official source (SACHET/IMD/NHAI) alone verifies.
        cleared   = ≥ clearPasses "not there" passes after the latest sighting,
                    by sensors that can sense that kind (an IMU can't feel water).
        expired   = faded below floorConf, or older than the kind's maxAge.
        candidate = anything else: seen, not yet confirmed. Never spoken as fact.
   Expiry is mainly rule 2 (riders going over a fixed pothole clear it); the
   half-lives are only a backstop for spots nobody rides any more.

   Where the numbers come from (no invented "facts"):
     passGapMs 60 s, mergeRadiusM 12 m, cellDeg 0.0002°, 2 pieces: carried over
     from the dynamics agent, which shipped and passed its Kotlin ride fixture.
     Half-lives, maxAge, absenceWeight, verifyConf, the default confidences of
     rider reports and official feeds: DESIGN PRIORS, marked basis: "prior" in
     TYPES / SOURCES, to be calibrated from the pilot rides (how often a
     verified event is still there; how many clean passes a repair takes).

   Rider identity: an opaque string. This phone is "self"; other riders come
   from the server (sync.js) as labels the server derives from a pseudonym that
   changes every day: never names, accounts or phone numbers.
   Anyone can upload, so remote evidence is capped: ONE other rider counts as at
   most one piece per sensor, however many passes they claim, and their many
   "not there"s as one clean pass. So a single uploader can neither verify a fake
   pothole nor clear a real one; it takes 2 riders (or this phone's own sensors).
   Every observation has an id; adding one that's already in the log does
   nothing, so an observation uploaded by this phone and downloaded again isn't
   counted twice.
   Pure: no DOM, no timers. Storage is any { get(key, fallback), set(key, v) }.
   ============================================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { const W = /** @type {any} */ (root); const M = W.MUMaster || (W.MUMaster = {}); M.roadsense = factory(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const VERSION = 1;
    const SELF = "self";
    const TILE_DEG = 0.05;                          // ≈ 5.5 km: the unit of server sync (sync.js, lib/master/roadsense.js)
    const ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
    const M_PER_DEG = 111320;
    const H = 3600000, D = 24 * H;

    /**
     * Road event kinds. group: kinds in one group share an event at a spot (an IMU "bump" and a camera
     * "pothole" there are one thing, and the more specific name wins). sensedBy: the sources whose
     * "not there" counts against it.
     * @type {Readonly<Record<string, { group: string, halfLifeMs: number, maxAgeMs: number, clearPasses: number, sensedBy: string[], basis: string }>>}
     */
    const TYPES = Object.freeze({
        bump:          { group: "shock", halfLifeMs: 14 * D,  maxAgeMs: 120 * D, clearPasses: 3, sensedBy: ["imu", "camera"], basis: "prior" },    // IMU: pothole or breaker, can't tell which
        pothole:       { group: "shock", halfLifeMs: 14 * D,  maxAgeMs: 120 * D, clearPasses: 3, sensedBy: ["imu", "camera"], basis: "prior" },
        speed_breaker: { group: "shock", halfLifeMs: 180 * D, maxAgeMs: 730 * D, clearPasses: 3, sensedBy: ["imu", "camera"], basis: "prior" },
        rough:         { group: "rough", halfLifeMs: 30 * D,  maxAgeMs: 180 * D, clearPasses: 3, sensedBy: ["imu"],           basis: "prior" },
        waterlogging:  { group: "water", halfLifeMs: 3 * H,   maxAgeMs: 1 * D,   clearPasses: 2, sensedBy: ["camera"],        basis: "prior" },
        gravel:        { group: "loose", halfLifeMs: 2 * D,   maxAgeMs: 14 * D,  clearPasses: 2, sensedBy: ["camera"],        basis: "prior" },
        debris:        { group: "debris", halfLifeMs: 6 * H,  maxAgeMs: 3 * D,   clearPasses: 2, sensedBy: ["camera"],        basis: "prior" },
        animal:        { group: "animal", halfLifeMs: 10 * 60000, maxAgeMs: H,   clearPasses: 1, sensedBy: ["camera"],        basis: "prior" },
        // roadworks come mostly from official lists (MoRTH, municipal) with their own validity window
        roadworks:     { group: "works", halfLifeMs: 7 * D,   maxAgeMs: 180 * D, clearPasses: 2, sensedBy: ["camera"],        basis: "prior" }
    });

    /**
     * Who can report. defaultConf is used only when an observation has no conf of its own (IMU and camera
     * always send theirs: DynamicsCore's jolt conf, confirm.js's confirmed conf).
     * @type {Readonly<Record<string, { defaultConf: number, verifiesAlone: boolean, basis: string }>>}
     */
    const SOURCES = Object.freeze({
        imu:      { defaultConf: 0.7,  verifiesAlone: false, basis: "prior" },
        camera:   { defaultConf: 0.7,  verifiesAlone: false, basis: "prior" },
        rider:    { defaultConf: 0.6,  verifiesAlone: false, basis: "prior" },    // "gaddha!" said or tapped by a rider
        official: { defaultConf: 0.95, verifiesAlone: true,  basis: "prior" },    // SACHET CAP, IMD, MoRTH, municipal: their own feed
        // a model's forecast (e.g. low-lying ground from ISRO Bhuvan + an IMD rain nowcast → waterlogging risk). It never
        // verifies, never counts as a rider and never clears anything: an event with only predictions is "predicted".
        // Its confidence must come with it (no default).
        prediction: { defaultConf: 0, verifiesAlone: false, basis: "model" }
    });
    /** Sources only the server's feeds may use (phones can't claim them); they must name their source (ref). */
    const FEED_SOURCES = Object.freeze(["official", "prediction"]);

    const POLICY = Object.freeze({
        passGapMs: 60000,          // one rider's sightings this far apart are separate passes (dynamics agent)
        mergeRadiusM: 12,          // GNSS error: sightings this close are the same spot (dynamics agent)
        cellDeg: 0.0002,           // ≈ 20 m grid for the index (dynamics agent)
        minPieces: 2,              // independent pieces to verify (dynamics agent's 2 passes)
        minPieceWeight: 0.1,       // a piece faded below this no longer counts as a piece   (prior)
        verifyConf: 0.5,           // (prior)
        floorConf: 0.1,            // below this the event has expired                         (prior)
        absenceWeight: 0.4,        // how much one clean pass lowers belief                    (prior)
        maxObs: 8,                 // newest observations kept per event (enough for 2 pieces + 3 clean passes)
        maxEvents: 2000            // events kept on the phone, least recently seen go first: ≈ 0.5 MB saved when full
    });

    const fin = (/** @type {any} */ v) => typeof v === "number" && Number.isFinite(v);
    const TYPE_CODES = Object.keys(TYPES), SOURCE_CODES = Object.keys(SOURCES);
    const r7 = (/** @type {number} */ v) => Math.round(v * 1e7) / 1e7;

    /** Saved form (phone storage is small: localStorage is ≈ 5 MB for the whole app):
        [id, type, lat, lng, t0 (s), [[dt (s), source, rider, present 1/0, conf %, type, peak × 10 | -1, obs id, (valid until (s) | -1, ref)?], …]] */
    function pack(/** @type {any} */ e) {
        const t0 = Math.floor(Math.min(...e.obs.map((/** @type {any} */ o) => o.t)) / 1000);
        return [e.id, TYPE_CODES.indexOf(e.type), r7(e.lat), r7(e.lng), t0, e.obs.map((/** @type {any} */ o) => [
            Math.round(o.t / 1000) - t0, SOURCE_CODES.indexOf(o.source), o.rider, o.present ? 1 : 0, Math.round(o.conf * 100),
            TYPE_CODES.indexOf(o.type), fin(o.peakMs2) ? Math.round(o.peakMs2 * 10) : -1, o.id,
            ...(fin(o.validUntil) || o.ref ? [fin(o.validUntil) ? Math.round(o.validUntil / 1000) : -1, o.ref || ""] : [])
        ])];
    }
    /** @returns {any} null when the record isn't one of ours */
    function unpack(/** @type {any} */ a) {
        if (!Array.isArray(a) || a.length !== 6 || typeof a[0] !== "string" || !TYPE_CODES[a[1]] || !fin(a[2]) || !fin(a[3]) || !fin(a[4]) || !Array.isArray(a[5])) return null;
        const obs = [];
        for (const x of a[5]) {
            if (!Array.isArray(x) || (x.length !== 8 && x.length !== 10) || typeof x[7] !== "string" || !ID_RE.test(x[7]) || !fin(x[0]) || !SOURCE_CODES[x[1]] || typeof x[2] !== "string" || !x[2] || !fin(x[4]) || x[4] < 0 || x[4] > 100 || !TYPE_CODES[x[5]]) continue;
            const feed = x.length === 10 ? { ...(fin(x[8]) && x[8] > 0 ? { validUntil: x[8] * 1000 } : {}), ...(typeof x[9] === "string" && x[9] ? { ref: x[9] } : {}) } : {};
            if (FEED_SOURCES.includes(SOURCE_CODES[x[1]]) && !feed.ref) continue;
            obs.push({ ...feed, id: x[7], t: (a[4] + x[0]) * 1000, source: SOURCE_CODES[x[1]], rider: x[2], present: x[3] === 1, conf: x[4] / 100, type: TYPE_CODES[x[5]], ...(fin(x[6]) && x[6] >= 0 ? { peakMs2: x[6] / 10 } : {}) });
        }
        if (!obs.length) return null;
        return { id: a[0], v: VERSION, type: TYPE_CODES[a[1]], lat: a[2], lng: a[3], obs, lastT: Math.max(...obs.map((o) => o.t)) };
    }
    const clamp01 = (/** @type {number} */ v) => Math.max(0, Math.min(1, v));

    /**
     * Check one observation; fill in what can be filled. Bad ones are refused, never guessed.
     * @param {any} o
     * @returns {{ ok: boolean, obs: any, error: string|null }}
     */
    function validateObservation(o) {
        const bad = (/** @type {string} */ error) => ({ ok: false, obs: null, error });
        if (!o || typeof o !== "object") return bad("observation must be an object");
        if (!TYPES[o.type]) return bad(`unknown type "${o.type}"`);
        if (!SOURCES[o.source]) return bad(`unknown source "${o.source}"`);
        if (!fin(o.t) || o.t <= 0) return bad("t is required");
        if (!fin(o.lat) || !fin(o.lng) || Math.abs(o.lat) > 90 || Math.abs(o.lng) > 180) return bad("lat, lng are required");
        if (typeof o.present !== "boolean") return bad("present must be true or false");
        if (typeof o.rider !== "string" || !o.rider || o.rider.length > 64) return bad("rider must be a short opaque id");
        if (o.conf !== undefined && o.conf !== null && (!fin(o.conf) || o.conf < 0 || o.conf > 1)) return bad("conf must be 0..1");
        if (o.peakMs2 !== undefined && o.peakMs2 !== null && !fin(o.peakMs2)) return bad("peakMs2 must be a number");
        if (o.id !== undefined && o.id !== null && (typeof o.id !== "string" || !ID_RE.test(o.id))) return bad("id must be 6–32 letters, digits, _ or -");
        if (o.validUntil !== undefined && o.validUntil !== null && (!fin(o.validUntil) || o.validUntil <= 0)) return bad("validUntil must be a time");
        if (o.ref !== undefined && o.ref !== null && (typeof o.ref !== "string" || !o.ref.trim() || o.ref.length > 80)) return bad("ref must be a short source name");
        if (FEED_SOURCES.includes(o.source) && !(typeof o.ref === "string" && o.ref.trim())) return bad(`${o.source} needs ref: where it comes from`);
        if (o.source === "prediction" && (!fin(o.conf) || !o.present)) return bad("a prediction needs its own conf and present: true");
        return {
            ok: true, error: null,
            obs: {
                id: typeof o.id === "string" ? o.id : null,
                type: o.type, t: o.t, lat: o.lat, lng: o.lng, source: o.source, rider: o.rider, present: o.present,
                conf: fin(o.conf) ? o.conf : SOURCES[o.source].defaultConf,
                peakMs2: fin(o.peakMs2) ? Math.abs(o.peakMs2) : null,
                validUntil: fin(o.validUntil) ? o.validUntil : null,
                ref: typeof o.ref === "string" ? o.ref.trim() : null
            }
        };
    }

    /** Evidence weight of one observation at time `now`. @param {any} o @param {number} halfLifeMs @param {number} now */
    function weight(o, halfLifeMs, now) {
        // a feed item with a validity window (an official roadworks notice, a nowcast) holds until then, then is gone
        if (fin(o.validUntil)) return now > o.validUntil ? 0 : clamp01(o.conf);
        const age = Math.max(0, now - o.t);
        return clamp01(o.conf) * Math.pow(0.5, age / halfLifeMs);
    }

    /**
     * Group a list of observations into passes: per rider, sightings within passGapMs of the previous one
     * are the same pass. Returns one entry per (rider, pass), with the sources seen in it.
     * @param {any[]} list
     * @param {number} gapMs
     */
    function passesOf(list, gapMs) {
        /** @type {Map<string, { rider: string, t0: number, t1: number, sources: Set<string>, obs: any[] }[]>} */
        const byRider = new Map();
        for (const o of [...list].sort((a, b) => a.t - b.t)) {
            const ps = byRider.get(o.rider) || [];
            const last = ps[ps.length - 1];
            if (last && o.t - last.t1 < gapMs) { last.t1 = o.t; last.sources.add(o.source); last.obs.push(o); }
            else ps.push({ rider: o.rider, t0: o.t, t1: o.t, sources: new Set([o.source]), obs: [o] });
            byRider.set(o.rider, ps);
        }
        return [...byRider.values()].flat();
    }

    /** Another rider's passes count as one (see the header): merge each remote rider's passes. @param {ReturnType<typeof passesOf>} passes */
    function capRemote(passes) {
        /** @type {Map<string, any>} */ const remote = new Map();
        const out = [];
        for (const p of passes) {
            if (p.rider === SELF) { out.push(p); continue; }
            const r = remote.get(p.rider);
            if (!r) { const q = { ...p, sources: new Set(p.sources), obs: [...p.obs] }; remote.set(p.rider, q); out.push(q); }
            else { r.t0 = Math.min(r.t0, p.t0); r.t1 = Math.max(r.t1, p.t1); for (const s of p.sources) r.sources.add(s); r.obs.push(...p.obs); }
        }
        return out;
    }

    /** The sightings that count towards belief: all of this phone's; another rider's latest per sensor only. @param {any[]} present */
    function countable(present) {
        /** @type {Map<string, any>} */ const latest = new Map();
        const out = [];
        for (const o of present) {
            if (o.rider === SELF) { out.push(o); continue; }
            const k = `${o.rider}|${o.source}`;
            const prev = latest.get(k);
            if (!prev || o.t > prev.t) latest.set(k, o);
        }
        return out.concat([...latest.values()]);
    }

    /** The sync tile (≈ 5.5 km) a point is in. @param {number} lat @param {number} lng */
    function tileOf(lat, lng) { return `${Math.floor(lat / TILE_DEG)}:${Math.floor(lng / TILE_DEG)}`; }
    /** A tile's south-west corner and size, in degrees. @param {string} tile */
    function tileBounds(tile) {
        const m = /^(-?\d+):(-?\d+)$/.exec(String(tile));
        if (!m) return null;
        const y = Number(m[1]), x = Number(m[2]);
        if (Math.abs(y * TILE_DEG) > 90 || Math.abs(x * TILE_DEG) > 180) return null;
        return { south: y * TILE_DEG, west: x * TILE_DEG, north: (y + 1) * TILE_DEG, east: (x + 1) * TILE_DEG };
    }

    /** A random 12-character observation id (crypto when there is one). */
    function newId() {
        const c = /** @type {any} */ (globalThis).crypto;
        const b = new Uint8Array(12);
        if (c && typeof c.getRandomValues === "function") c.getRandomValues(b); else for (let k = 0; k < b.length; k++) b[k] = Math.floor(Math.random() * 256);
        const A = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
        let out = "";
        for (const v of b) out += A[v & 63];
        return out;
    }

    /**
     * The rules: how much an event can be believed now, and why.
     * @param {any} ev  an event from the log (needs type and obs)
     * @param {number} now
     * @param {any} [policy]
     */
    function assess(ev, now, policy = POLICY) {
        const ty = TYPES[ev.type];
        const P = { ...POLICY, ...policy };
        const present = countable(ev.obs.filter((/** @type {any} */ o) => o.present && o.source !== "prediction"));
        // predictions are kept apart: they can make an event "predicted", nothing more
        const predictions = ev.obs.filter((/** @type {any} */ o) => o.source === "prediction" && weight(o, ty.halfLifeMs, now) > 0);
        const lastSeen = present.length ? Math.max(...present.map((/** @type {any} */ o) => o.t)) : -Infinity;
        const firstSeen = present.length ? Math.min(...present.map((/** @type {any} */ o) => o.t)) : -Infinity;

        // "not there" passes after the latest sighting, only from sensors that can sense this kind
        const absent = ev.obs.filter((/** @type {any} */ o) => !o.present && o.t > lastSeen && ty.sensedBy.includes(o.source));
        const absentPasses = capRemote(passesOf(absent, P.passGapMs));

        let belief = 1;
        for (const o of present) belief *= 1 - weight(o, ty.halfLifeMs, now);
        let confidence = present.length ? 1 - belief : 0;
        for (const p of absentPasses) {
            const w = Math.max(...p.obs.map((/** @type {any} */ o) => weight(o, ty.halfLifeMs, now)));
            confidence *= 1 - P.absenceWeight * w;
        }
        confidence = clamp01(confidence);

        // independent pieces: each (rider, pass) counts once per sensor kind in it, if it hasn't faded
        // (another rider's passes together are one pass)
        let pieces = 0;
        const presentPasses = capRemote(passesOf(present, P.passGapMs));
        for (const p of presentPasses) for (const s of p.sources) {
            const w = Math.max(...p.obs.filter((/** @type {any} */ o) => o.source === s).map((/** @type {any} */ o) => weight(o, ty.halfLifeMs, now)));
            if (w >= P.minPieceWeight) pieces++;
        }
        const officialAlive = present.some((/** @type {any} */ o) => SOURCES[o.source].verifiesAlone && weight(o, ty.halfLifeMs, now) >= P.minPieceWeight);

        /** @type {"candidate"|"verified"|"cleared"|"expired"|"predicted"} */
        let status;
        const predicted = predictions.length ? {
            confidence: Math.max(...predictions.map((/** @type {any} */ o) => clamp01(o.conf))),
            refs: [...new Set(predictions.map((/** @type {any} */ o) => o.ref))],
            validUntil: Math.max(...predictions.map((/** @type {any} */ o) => fin(o.validUntil) ? o.validUntil : o.t + ty.halfLifeMs))
        } : null;
        const noLiveEvidence = !present.length || now - lastSeen > ty.maxAgeMs || confidence < P.floorConf;
        if (noLiveEvidence && predicted && absentPasses.length < ty.clearPasses) { status = "predicted"; confidence = predicted.confidence; }
        else if (noLiveEvidence) status = "expired";
        else if (absentPasses.length >= ty.clearPasses) status = "cleared";
        else if (officialAlive || (pieces >= P.minPieces && confidence >= P.verifyConf)) status = "verified";
        else status = "candidate";

        /** @type {Record<string, number>} */ const sources = {};
        for (const o of present) sources[o.source] = (sources[o.source] || 0) + 1;
        const peaks = present.map((/** @type {any} */ o) => o.peakMs2).filter(fin);
        const official = present.filter((/** @type {any} */ o) => o.source === "official" && weight(o, ty.halfLifeMs, now) > 0);
        return {
            // official lists by name, and how long they say it lasts; a model's prediction, kept apart
            refs: [...new Set(official.map((/** @type {any} */ o) => o.ref).filter(Boolean))],
            validUntil: official.some((/** @type {any} */ o) => fin(o.validUntil)) ? Math.max(...official.filter((/** @type {any} */ o) => fin(o.validUntil)).map((/** @type {any} */ o) => o.validUntil)) : null,
            predicted,
            status, confidence: Math.round(confidence * 1000) / 1000, pieces,
            passes: presentPasses.length, riders: new Set(present.filter((/** @type {any} */ o) => !FEED_SOURCES.includes(o.source)).map((/** @type {any} */ o) => o.rider)).size,
            felt: present.some((/** @type {any} */ o) => o.rider === SELF),                   // this phone's own evidence is part of it
            absentPasses: absentPasses.length, sources,
            firstSeen: present.length ? firstSeen : null, lastSeen: present.length ? lastSeen : null,
            peakMs2: peaks.length ? Math.max(...peaks) : null
        };
    }

    /**
     * When the event fades below floorConf if nothing new is seen (for the Truth Card's "valid until").
     * @param {any} ev @param {number} now @param {any} [policy]
     */
    function expiresAt(ev, now, policy = POLICY) {
        const ty = TYPES[ev.type];
        const a = assess(ev, now, policy);
        if (a.status === "predicted" && a.predicted) return a.predicted.validUntil;
        if (a.status === "expired" || a.status === "cleared" || a.lastSeen === null) return now;
        const cap = a.lastSeen + ty.maxAgeMs;
        const live = (/** @type {number} */ t) => assess(ev, t, policy).status !== "expired";
        if (live(cap - 1)) return cap;
        let lo = now, hi = cap;                       // live at lo, dead at hi: confidence only falls with time
        for (let i = 0; i < 40 && hi - lo > 60000; i++) { const mid = (lo + hi) / 2; if (live(mid)) lo = mid; else hi = mid; }
        return Math.round(hi);
    }

    /** The more specific name for a spot wins: "bump" (IMU) becomes "pothole" once a camera or rider names it. */
    function nameFor(/** @type {any[]} */ obs, /** @type {string} */ fallback) {
        /** @type {Record<string, number>} */ const n = {};
        for (const o of obs) if (o.present && o.type !== "bump") n[o.type] = (n[o.type] || 0) + 1;
        const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
        return best ? best[0] : fallback;
    }

    /**
     * The log: events on the phone, indexed in ~20 m cells, saved to a small store.
     * @param {{ store?: { get: (k: string, f?: any) => any, set: (k: string, v: any) => any } | null, policy?: any }} [o]
     * Listeners added with onAdd(fn) get each new observation (with its id) as it's added: sync.js queues
     * this phone's own for upload.
     */
    function createLog(o = {}) {
        const P = { ...POLICY, ...(o.policy || {}) };
        const store = o.store || null;
        /** @type {Map<string, any>} */ const events = new Map();
        /** @type {Map<string, Set<string>>} */ const index = new Map();
        /** @type {Set<string>} observation ids in the log */ const ids = new Set();
        /** @type {Set<(obs: any) => void>} */ const listeners = new Set();
        let seq = 0, dirty = false;

        const cellOf = (/** @type {number} */ lat, /** @type {number} */ lng) => [Math.round(lat / P.cellDeg), Math.round(lng / P.cellDeg)];
        const keyOf = (/** @type {number} */ y, /** @type {number} */ x) => `${y}:${x}`;
        /** metres from (lat, lng) to (lat2, lng2), as north / east */
        const offset = (/** @type {number} */ lat, /** @type {number} */ lng, /** @type {number} */ lat2, /** @type {number} */ lng2) => ({
            north: (lat2 - lat) * M_PER_DEG,
            east: (lng2 - lng) * M_PER_DEG * Math.cos(lat * Math.PI / 180)
        });
        const dist = (/** @type {number} */ lat, /** @type {number} */ lng, /** @type {any} */ e) => { const v = offset(lat, lng, e.lat, e.lng); return Math.hypot(v.north, v.east); };

        function indexAdd(/** @type {any} */ e) { const [y, x] = cellOf(e.lat, e.lng); e.cell = keyOf(y, x); (index.get(e.cell) || index.set(e.cell, new Set()).get(e.cell)).add(e.id); }
        function indexDel(/** @type {any} */ e) { const s = index.get(e.cell); if (s) { s.delete(e.id); if (!s.size) index.delete(e.cell); } }

        /** events whose position lies within radiusM of (lat, lng) */
        function near(/** @type {number} */ lat, /** @type {number} */ lng, /** @type {number} */ radiusM, /** @type {string|null} */ group = null) {
            const [y, x] = cellOf(lat, lng);
            const r = Math.ceil(radiusM / (P.cellDeg * M_PER_DEG * Math.max(0.2, Math.cos(lat * Math.PI / 180)))) + 1;
            const out = [];
            for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                const s = index.get(keyOf(y + dy, x + dx));
                if (!s) continue;
                for (const id of s) {
                    const e = events.get(id);
                    if (!e || (group && TYPES[e.type].group !== group)) continue;
                    const d = dist(lat, lng, e);
                    if (d <= radiusM) out.push({ e, d });
                }
            }
            return out.sort((a, b) => a.d - b.d);
        }

        /**
         * Add one observation. "It is here" joins the nearest event of its group within mergeRadiusM, or
         * starts one. "Not there" only joins an existing event (it never creates one). An id already in the
         * log is a duplicate and changes nothing.
         * @param {any} raw
         * @returns {{ ok: boolean, id: string|null, error: string|null, dup?: boolean, obsId?: string }}
         */
        function add(raw) {
            const v = validateObservation(raw);
            if (!v.ok) return { ok: false, id: null, error: v.error };
            const ob = v.obs;
            if (ob.id && ids.has(ob.id)) return { ok: true, id: null, error: null, dup: true, obsId: ob.id };
            ob.id = ob.id || newId();
            const group = TYPES[ob.type].group;
            const hit = near(ob.lat, ob.lng, P.mergeRadiusM, group)[0];
            let e = hit ? hit.e : null;
            if (!e) {
                if (!ob.present) return { ok: true, id: null, error: null };
                e = { id: `rs${ob.t.toString(36)}${(++seq).toString(36)}`, v: VERSION, type: ob.type, lat: ob.lat, lng: ob.lng, obs: [], lastT: ob.t };
                events.set(e.id, e);
                indexAdd(e);
            }
            const compact = {
                id: ob.id, t: ob.t, source: ob.source, rider: ob.rider, present: ob.present, conf: Math.round(ob.conf * 1000) / 1000, type: ob.type,
                ...(ob.peakMs2 !== null ? { peakMs2: Math.round(ob.peakMs2 * 10) / 10 } : {}),
                ...(ob.validUntil !== null ? { validUntil: ob.validUntil } : {}), ...(ob.ref ? { ref: ob.ref } : {})
            };
            e.obs.push(compact);
            ids.add(ob.id);
            // keep the newest maxObs by time (an old one arriving late, e.g. downloaded, drops out at once)
            if (e.obs.length > P.maxObs) {
                e.obs.sort((/** @type {any} */ a, /** @type {any} */ b) => a.t - b.t);
                for (const gone of e.obs.splice(0, e.obs.length - P.maxObs)) ids.delete(gone.id);
                if (!e.obs.includes(compact)) { dirty = true; return { ok: true, id: e.id, error: null, obsId: ob.id }; }
            }
            if (ob.present) {
                // the spot is the running mean of the sightings; re-index if it moved to another cell
                const seen = e.obs.filter((/** @type {any} */ x) => x.present).length;
                const lat = e.lat + (ob.lat - e.lat) / seen, lng = e.lng + (ob.lng - e.lng) / seen;
                indexDel(e); e.lat = lat; e.lng = lng; indexAdd(e);
                e.type = nameFor(e.obs, e.type);
            }
            e.lastT = Math.max(e.lastT, ob.t);
            dirty = true;
            for (const fn of listeners) { try { fn({ ...ob }); } catch (err) { /* listeners are independent */ } }
            return { ok: true, id: e.id, error: null, obsId: ob.id };
        }

        function drop(/** @type {any} */ e) { indexDel(e); events.delete(e.id); for (const x of e.obs) ids.delete(x.id); }

        /** Drop expired and cleared events, then the least recently seen beyond maxEvents. @param {number} now */
        function prune(now) {
            let removed = 0;
            for (const e of [...events.values()]) {
                const s = assess(e, now, P).status;
                if (s === "expired" || s === "cleared") { drop(e); removed++; }
            }
            if (events.size > P.maxEvents) {
                const old = [...events.values()].sort((a, b) => a.lastT - b.lastT).slice(0, events.size - P.maxEvents);
                for (const e of old) { drop(e); removed++; }
            }
            if (removed) dirty = true;
            return removed;
        }

        /** One event with its assessment, ready for the screen or the voice ("valid until" only when asked:
            it costs a few dozen assessments). @param {any} e @param {number} now @param {boolean} [until] */
        function view(e, now, until = false) {
            const a = assess(e, now, P);
            return { id: e.id, type: e.type, group: TYPES[e.type].group, lat: e.lat, lng: e.lng, ...a, ...(until ? { expiresAt: expiresAt(e, now, P) } : {}) };
        }

        return {
            add,
            /** A batch, oldest first (a "not there" before the sighting it's about would be dropped:
                it never creates an event). @param {any[]} list */
            addAll(list) {
                const ok = (Array.isArray(list) ? list : []).filter((x) => x && typeof x === "object");
                return ok.sort((a, b) => (fin(a.t) ? a.t : 0) - (fin(b.t) ? b.t : 0) || Number(Boolean(b.present)) - Number(Boolean(a.present))).map(add);
            },
            /** @param {string} id @param {number} now */
            get(id, now) { const e = events.get(id); return e ? view(e, now, true) : null; },
            /** Events within radiusM, nearest first, assessed at `now`; expired/cleared are left out unless asked.
                @param {{ lat: number, lng: number, radiusM: number, now: number, group?: string|null, all?: boolean, until?: boolean }} q */
            query(q) {
                return near(q.lat, q.lng, q.radiusM, q.group || null)
                    .map(({ e, d }) => ({ ...view(e, q.now, Boolean(q.until)), distanceM: Math.round(d * 10) / 10 }))
                    .filter((x) => q.all || (x.status !== "expired" && x.status !== "cleared"));
            },
            /**
             * What is known about one spot: the Route Truth Card's line. "unknown" when the log has nothing
             * (no evidence is not the same as a clear road).
             * @param {{ lat: number, lng: number, radiusM?: number, now: number }} q
             */
            truthAt(q) {
                const found = this.query({ lat: q.lat, lng: q.lng, radiusM: q.radiusM ?? P.mergeRadiusM * 2, now: q.now, until: true });
                if (!found.length) return { status: "unknown", events: [] };
                const order = { verified: 0, candidate: 1, predicted: 2 };
                found.sort((a, b) => (/** @type {any} */ (order)[a.status] - /** @type {any} */ (order)[b.status]) || b.confidence - a.confidence);
                return { status: found[0].status, events: found };
            },
            prune,
            /** @param {number} now */
            stats(now) {
                /** @type {Record<string, number>} */ const by = { candidate: 0, verified: 0, cleared: 0, expired: 0 };
                for (const e of events.values()) by[assess(e, now, P).status]++;
                return { events: events.size, ...by };
            },
            size: () => events.size,
            /** @param {string} obsId */ has: (obsId) => ids.has(obsId),
            /** Every event, assessed at `now` (expired/cleared left out unless asked). @param {number} now @param {boolean} [all] */
            list(now, all = false) { return [...events.values()].map((e) => view(e, now)).filter((x) => all || (x.status !== "expired" && x.status !== "cleared")); },
            /** An event's observations as plain observations at the event's spot (what the server sends back). @param {string} id */
            evidence(id) {
                const e = events.get(id);
                if (!e) return [];
                return e.obs.map((/** @type {any} */ x) => ({
                    id: x.id, type: x.type, t: x.t, lat: r7(e.lat), lng: r7(e.lng), source: x.source, rider: x.rider, present: x.present, conf: x.conf,
                    ...(fin(x.peakMs2) ? { peakMs2: x.peakMs2 } : {}), ...(fin(x.validUntil) ? { validUntil: x.validUntil } : {}), ...(x.ref ? { ref: x.ref } : {})
                }));
            },
            /** Hear every new observation. @param {(obs: any) => void} fn @returns {() => void} */
            onAdd(fn) { listeners.add(fn); return () => listeners.delete(fn); },
            /** Write to the store if anything changed. */
            save() {
                if (!store || !dirty) return false;
                store.set("events", { v: VERSION, events: [...events.values()].map(pack) });
                dirty = false;
                return true;
            },
            /** Read from the store (records of an unknown version, kind or shape are skipped, never trusted). */
            load() {
                if (!store) return 0;
                const saved = store.get("events", null);
                events.clear(); index.clear(); ids.clear();
                if (!saved || saved.v !== VERSION || !Array.isArray(saved.events)) return 0;
                for (const raw of saved.events) {
                    const ev = unpack(raw);
                    if (!ev || events.has(ev.id)) continue;
                    ev.obs = ev.obs.filter((/** @type {any} */ x) => !ids.has(x.id));
                    if (!ev.obs.length) continue;
                    for (const x of ev.obs) ids.add(x.id);
                    events.set(ev.id, ev);
                    indexAdd(ev);
                }
                dirty = false;
                return events.size;
            },
            policy: P
        };
    }

    /* ------------------------------------------------------------------------
       COVERAGE: "ridden, nothing found" (smooth passes)
       A smooth pass = this phone rode through a ≈ 220 m cell at ≥ 3 m/s with the IMU
       working and felt no jolt and no rough road there. Kept per cell and rider (the
       latest pass of each), so the Truth Card can say a stretch was ridden recently by
       N riders with nothing felt, instead of "unknown". What it can't say: a phone
       can't feel water, gravel or animals, so "clear" only ever means no bumps felt.
       Other riders' passes come from the server under per-cell labels (sync.js):
       a label can't be linked to the same rider's other cells.
       ------------------------------------------------------------------------ */
    const COVER = Object.freeze({
        cellDeg: 0.002,            // ≈ 220 m: coarse on purpose (less of a track), fine enough for a stretch
        freshMs: 7 * D,            // a pass older than a week no longer says anything      (prior)
        clearRiders: 2,            // "clear" needs 2 riders, like "verified"
        ridersPerCell: 4,          // the latest pass of up to 4 riders per cell
        maxCells: 5000             // ≈ 0.3 MB saved when full; least recently ridden go first
    });
    const COVER_CELL_RE = /^-?\d{1,6}:-?\d{1,6}$/;
    /** @param {number} lat @param {number} lng */
    const coverCell = (lat, lng) => `${Math.floor(lat / COVER.cellDeg)}:${Math.floor(lng / COVER.cellDeg)}`;

    /** @param {{ store?: { get: (k: string, f?: any) => any, set: (k: string, v: any) => any } | null, policy?: Partial<typeof COVER> }} [o] */
    function createCoverage(o = {}) {
        const P = { ...COVER, ...(o.policy || {}) };
        const store = o.store || null;
        /** @type {Map<string, Map<string, number>>} cell → rider → latest smooth pass */ const cells = new Map();
        /** @type {Set<(p: any) => void>} */ const listeners = new Set();
        let dirty = false;

        /**
         * One smooth pass. { cell } or { lat, lng }, t, rider. Returns the cell, or null when refused.
         * @param {{ cell?: string, lat?: number, lng?: number, t: number, rider: string }} p
         */
        function add(p) {
            if (!p || !fin(p.t) || p.t <= 0 || typeof p.rider !== "string" || !p.rider || p.rider.length > 64) return null;
            const cell = typeof p.cell === "string" ? p.cell : fin(p.lat) && fin(p.lng) ? coverCell(/** @type {number} */ (p.lat), /** @type {number} */ (p.lng)) : null;
            if (!cell || !COVER_CELL_RE.test(cell)) return null;
            const m = cells.get(cell) || new Map();
            if ((m.get(p.rider) || 0) >= p.t) return cell;                       // already have this or a newer pass
            m.set(p.rider, p.t);
            if (m.size > P.ridersPerCell) {
                const keep = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, P.ridersPerCell);
                m.clear(); for (const [r, t] of keep) m.set(r, t);
            }
            cells.set(cell, m);
            dirty = true;
            for (const fn of listeners) { try { fn({ cell, t: p.t, rider: p.rider }); } catch (e) { /* independent */ } }
            return cell;
        }

        /** Fresh smooth passes in a cell: how many riders, the latest, and whether this phone is one. @param {string} cell @param {number} now */
        function at(cell, now) {
            const m = cells.get(cell);
            let riders = 0, last = null, self = false;
            if (m) for (const [r, t] of m) if (now - t <= P.freshMs && t <= now + 60000) { riders++; last = last === null ? t : Math.max(last, t); if (r === SELF) self = true; }
            return { riders, last, self };
        }

        return {
            add, at, cellOf: coverCell,
            /** @param {(p: any) => void} fn */ onAdd(fn) { listeners.add(fn); return () => listeners.delete(fn); },
            size: () => cells.size,
            /** Drop stale passes and empty cells, then the least recently ridden beyond maxCells. @param {number} now */
            prune(now) {
                let removed = 0;
                for (const [cell, m] of cells) {
                    for (const [r, t] of m) if (now - t > P.freshMs) { m.delete(r); dirty = true; }
                    if (!m.size) { cells.delete(cell); removed++; }
                }
                if (cells.size > P.maxCells) {
                    const latest = (/** @type {Map<string, number>} */ m) => Math.max(...m.values());
                    const old = [...cells.entries()].sort((a, b) => latest(a[1]) - latest(b[1])).slice(0, cells.size - P.maxCells);
                    for (const [cell] of old) { cells.delete(cell); removed++; }
                }
                if (removed) dirty = true;
                return removed;
            },
            save() {
                if (!store || !dirty) return false;
                store.set("cover", { v: VERSION, cells: [...cells.entries()].map(([c, m]) => [c, [...m.entries()].map(([r, t]) => [r, Math.round(t / 1000)])]) });
                dirty = false;
                return true;
            },
            load() {
                if (!store) return 0;
                const saved = store.get("cover", null);
                cells.clear();
                if (!saved || saved.v !== VERSION || !Array.isArray(saved.cells)) return 0;
                for (const row of saved.cells) {
                    if (!Array.isArray(row) || typeof row[0] !== "string" || !COVER_CELL_RE.test(row[0]) || !Array.isArray(row[1])) continue;
                    const m = new Map();
                    for (const x of row[1]) if (Array.isArray(x) && typeof x[0] === "string" && x[0] && fin(x[1])) m.set(x[0], x[1] * 1000);
                    if (m.size) cells.set(row[0], m);
                }
                dirty = false;
                return cells.size;
            },
            policy: P
        };
    }

    return { VERSION, SELF, TILE_DEG, COVER, FEED_SOURCES, coverCell, createCoverage, TYPES, SOURCES, POLICY, validateObservation, weight, passesOf, assess, expiresAt, tileOf, tileBounds, newId, createLog };
});
