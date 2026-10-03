// @ts-check
/* ============================================================================
   MapUnite pitstops — wiring the Convoy & Pitstop planner into the map app
   ==============================================================================
   Entry: "Plan fuel stops" (#pitstop-plan-btn) in the group-trip panel. Opens
   #pitstop-panel over the map and draws the stops on the map. The planner's
   scripts and stylesheet load on first use (precached by sw.js).

   Where each number comes from:
     - the group and destination: currentTrip (group trip) or GroupNavigation
       (meetup), riders' positions from friendData, colours = routeColors (the
       same as each rider's route line);
     - the route: your own road to the destination (the group-trip route layer,
       else your navigation route, else one OSRM request);
     - your bike: MUTrip.app.loadBike(); other riders' bikes: TripFuel.profiles[id]
       .bike, relayed by the server ({ bundle, bikeId, classKey, title, settings });
       until then (or if that bundle can't be loaded) a typical bike scaled to
       the km/L they already share;
     - levels: what a rider set here (kept on this phone for 6 h), a level they
       shared (TripFuel.profiles[id].level = { share, at }), your own estimated
       from your last full fill-up (the fuel learner), else "assumed half";
     - energy along the route: MUTrip.energy (each rider's own bike, the route's
       hills and traffic), stations: MUPitstop.stations (OpenStreetMap).

   Sharing (Step 8): myShare() is your bike and the level you set for yourself;
   shareFuel() sends it as "setFuelShare" — after every (re)connect, when My bike
   changes and when you set your own level. The server relays it ONLY to the
   members of your trip (in "tripFuelProfiles"), the way it relays your km/L.
   The level travels as its age (ageMs), so phones with different clocks agree.
   ============================================================================ */
(function (root) {
    "use strict";
    const W = /** @type {any} */ (root);
    if (!W.document) return;
    const $ = (id) => document.getElementById(id);
    const FILES = { js: ["js/pitstop/plan.js", "js/pitstop/stations.js", "js/pitstop/convoy-panel.js"], css: "js/pitstop/convoy-panel.css" };
    const LEVELS_KEY = "mu.pitstop.v1";
    const LEVEL_TTL = 6 * 3600000;
    const FALLBACK_COLORS = ["#18d6a3", "#3b82f6", "#f59e0b", "#ec4899", "#8b5cf6"];
    let loading = null, panel = null, layer = null, refreshTimer = null, lastModel = null, stationsApi = null, elevation = null, overrideCtx = null;

    // ------------------------------------------------------------------ app globals, read by name (classic-script lexicals aren't on window)
    function g() {
        /** @type {any} */ const o = {};
        // @ts-ignore
        try { o.currentTrip = typeof currentTrip !== "undefined" ? currentTrip : null; } catch { o.currentTrip = null; }
        // @ts-ignore
        try { o.friendData = typeof friendData !== "undefined" ? friendData : {}; } catch { o.friendData = {}; }
        // @ts-ignore
        try { o.friendMarkers = typeof friendMarkers !== "undefined" ? friendMarkers : {}; } catch { o.friendMarkers = {}; }
        // @ts-ignore
        try { o.TripFuel = typeof TripFuel !== "undefined" ? TripFuel : null; } catch { o.TripFuel = null; }
        // @ts-ignore
        try { o.Convoy = typeof ConvoyIntelligence !== "undefined" ? ConvoyIntelligence : null; } catch { o.Convoy = null; }
        // @ts-ignore
        try { o.GroupNavigation = typeof GroupNavigation !== "undefined" ? GroupNavigation : null; } catch { o.GroupNavigation = null; }
        // @ts-ignore
        try { o.routeColors = typeof routeColors !== "undefined" ? routeColors : FALLBACK_COLORS; } catch { o.routeColors = FALLBACK_COLORS; }
        // @ts-ignore
        try { o.myCoords = typeof myCoords !== "undefined" ? myCoords : null; } catch { o.myCoords = null; }
        // @ts-ignore
        try { o.currentUser = typeof currentUser !== "undefined" ? currentUser : { name: "You" }; } catch { o.currentUser = { name: "You" }; }
        // @ts-ignore
        try { o.map = typeof map !== "undefined" ? map : null; } catch { o.map = null; }
        // @ts-ignore
        try { o.FuelCurve = typeof FuelCurve !== "undefined" ? FuelCurve : null; } catch { o.FuelCurve = null; }
        // @ts-ignore
        try { o.SmartDrive = typeof SmartDrive !== "undefined" ? SmartDrive : null; } catch { o.SmartDrive = null; }
        // @ts-ignore
        try { o.OSRM_BASE = typeof OSRM_BASE !== "undefined" ? OSRM_BASE : null; } catch { o.OSRM_BASE = null; }
        // @ts-ignore
        try { o.RoutePrefs = typeof RoutePrefs !== "undefined" ? RoutePrefs : null; } catch { o.RoutePrefs = null; }
        // @ts-ignore
        try { o.startSearchNavigation = typeof startSearchNavigation === "function" ? startSearchNavigation : null; } catch { o.startSearchNavigation = null; }
        // core.js declares `const socket` (a classic-script lexical, not on window): read it by name too
        // @ts-ignore
        try { o.socketId = typeof socket !== "undefined" && socket && socket.id ? socket.id : "me"; } catch { o.socketId = "me"; }
        return o;
    }

    function loadFiles() {
        if (!loading) {
            if (!document.querySelector(`link[data-mu-href="${FILES.css}"]`)) {
                const l = document.createElement("link");
                l.rel = "stylesheet"; l.href = FILES.css; l.dataset.muHref = FILES.css;
                document.head.append(l);
            }
            loading = FILES.js.reduce((p, src) => p.then(() => new Promise((resolve, reject) => {
                if (document.querySelector(`script[data-mu-src="${src}"]`) || (src.endsWith("plan.js") && W.MUPitstop && W.MUPitstop.plan)) return resolve(undefined);
                const sc = document.createElement("script");
                sc.src = src; sc.async = false; sc.dataset.muSrc = src;
                sc.onload = () => resolve(undefined);
                sc.onerror = () => reject(new Error(`Couldn't load ${src}. Connect once so the app can save it for offline use.`));
                document.head.append(sc);
            })), Promise.resolve()).catch((e) => { loading = null; throw e; });
        }
        return loading;
    }

    // ------------------------------------------------------------------ levels set on this phone
    function readLevels() { try { const o = JSON.parse(localStorage.getItem(LEVELS_KEY) || "{}"); return o && typeof o.levels === "object" && o.levels ? o.levels : {}; } catch { return {}; } }
    function writeLevel(key, share) {
        const lv = readLevels();
        lv[key] = { share: Math.max(0, Math.min(1, share)), at: Date.now() };
        for (const k of Object.keys(lv)) if (Date.now() - lv[k].at > LEVEL_TTL) delete lv[k];
        try { localStorage.setItem(LEVELS_KEY, JSON.stringify({ v: 1, levels: lv })); } catch { /* storage blocked */ }
    }
    const agoText = (at) => { const m = Math.max(0, Math.round((Date.now() - at) / 60000)); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

    // ------------------------------------------------------------------ context: who, where to, which road
    /**
     * @returns {Promise<null | { title: string, destName: string, dest: { lat: number, lng: number },
     *   members: Array<{ id: string, key: string, name: string, avatar: string, me: boolean, lat: number|null, lng: number|null, color: string, profile: any }>,
     *   route: { path: number[][], distanceM: number, durationSec: number, steps: any[] } | null }>}
     */
    async function context() {
        if (overrideCtx) return overrideCtx;
        const G = g();
        const me = G.socketId;
        let ids = [], dest = null, destName = "the destination", routeFor = null, title = "Group ride";
        if (G.currentTrip && Array.isArray(G.currentTrip.members) && G.currentTrip.members.some((m) => m.id === me)) {
            ids = G.currentTrip.members.map((m) => m.id);
            dest = { lat: Number(G.currentTrip.lat), lng: Number(G.currentTrip.lng) };
            destName = G.currentTrip.destName || G.currentTrip.name || G.currentTrip.title || destName;
            title = "Group trip";
        } else if (G.GroupNavigation && G.GroupNavigation.active && G.GroupNavigation.destination) {
            ids = G.GroupNavigation.selectedMembers.map((id) => (id === "me" ? me : id));
            dest = { lat: Number(G.GroupNavigation.destination.lat), lng: Number(G.GroupNavigation.destination.lng) };
            destName = G.GroupNavigation.destination.name || "the meeting point";
            title = "Meetup";
        } else return null;
        const ctx = G.Convoy && typeof G.Convoy.context === "function" ? G.Convoy.context() : null;
        if (ctx && typeof ctx.routeFor === "function") routeFor = ctx.routeFor;
        // my road to the destination
        let route = null;
        const path = routeFor ? routeFor(me) : null;
        if (path && path.length >= 2) {
            // @ts-ignore
            const st = typeof tripRoadStats !== "undefined" ? tripRoadStats[me] : null;
            route = { path, distanceM: st && st.distM ? st.distM : 0, durationSec: st && st.durSec ? st.durSec : 0, steps: [] };
        } else if (G.myCoords && G.OSRM_BASE && G.RoutePrefs) {
            try {
                const data = await G.RoutePrefs.fetchRoute(`${G.OSRM_BASE}/route/v1/driving/${G.myCoords.lng},${G.myCoords.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson&steps=true`);
                const r = data && data.routes && data.routes[0];
                if (r) route = { path: r.geometry.coordinates.map((c) => [c[1], c[0]]), distanceM: r.distance, durationSec: r.duration, steps: (r.legs && r.legs[0] && r.legs[0].steps) || [] };
            } catch { route = null; }
        }
        const colors = G.routeColors && G.routeColors.length ? G.routeColors : FALLBACK_COLORS;
        const members = ids.map((id, i) => {
            const isMe = id === me;
            const f = isMe ? null : G.friendData[id];
            if (!isMe && !f) return null;
            const profile = G.TripFuel && G.TripFuel.profiles ? G.TripFuel.profiles[id] || null : null;
            if (profile && profile.walking) return null;
            return {
                id, key: isMe ? "me" : String((f && (f.ownerKey || f.name)) || id), me: isMe,
                name: isMe ? (G.currentUser.name || "You") : String(f.name || "Rider"),
                avatar: isMe ? G.currentUser.avatar || "" : f.avatar || "",
                lat: isMe ? (G.myCoords ? G.myCoords.lat : null) : (Number.isFinite(f.lat) ? f.lat : null),
                lng: isMe ? (G.myCoords ? G.myCoords.lng : null) : (Number.isFinite(f.lng) ? f.lng : null),
                color: colors[i % colors.length], profile
            };
        }).filter(Boolean);
        return { title, destName, dest, members: /** @type {any[]} */ (members), route };
    }

    // ------------------------------------------------------------------ bikes
    /** A typical commuter, scaled so its flat 50 km/h economy equals `kmPerL`. */
    async function typicalBike(store, index, kmPerL, classKey = "ice_manual.commuter") {
        const cls = index.classes.find((c) => c.key === classKey) || index.classes.find((c) => c.powertrain !== "ev");
        const bundle = await store.bundle(cls.bundle);
        return { bundle, classDefault: undefined, settings: {}, name: `Typical ${cls.title.toLowerCase()}`, classKey: cls.key, estimated: true, kmPerL, image_url: cls.image_url || null };
    }

    /** Your fuel level from the learner: the last full fill-up, minus what was ridden since. */
    function myLevelFromFillups(G, capacity, model, P) {
        const FC = G.FuelCurve;
        if (!FC || !FC.state || !Array.isArray(FC.state.fills) || !(capacity > 0)) return null;
        const fulls = FC.state.fills.filter((f) => f.full).sort((a, b) => b.ts - a.ts);
        if (!fulls.length || Date.now() - fulls[0].ts > 30 * 86400000) return null;
        const since = (FC.state.trips || []).filter((t) => t.endedAt > fulls[0].ts);
        const mids = [25, 50, 70, 95].map((k) => P.operatingPoint(model, k / 3.6, {}).fuelPerMetre || 0);
        const idle = P.operatingPoint(model, 0, {}).fuelRate || 0;
        let used = 0, km = 0;
        for (const t of since) { for (let j = 0; j < 4; j++) used += (Number(t.bandKm && t.bandKm[j]) || 0) * 1000 * mids[j]; used += (t.idleH || 0) * 3600 * idle; km += t.km || 0; }
        const share = Math.max(0, Math.min(1, (capacity - used) / capacity));
        const day = new Date(fulls[0].ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
        return { share, note: `Estimated: full tank on ${day}, ${Math.round(km)} km recorded since` };
    }

    // ------------------------------------------------------------------ the model the panel draws
    async function buildModel(onStations) {
        const ctx = await context();
        if (!ctx) return { state: "error", message: "Start or join a group trip (or a meetup) to plan fuel stops for everyone." };
        if (!ctx.route || ctx.route.path.length < 2) return { state: "error", destName: ctx.destName, message: "Waiting for your route to the destination…" };
        const P = W.MUPhysics, T = W.MUTrip, Pit = W.MUPitstop;
        const store = T.app.store;
        const { index } = await store.catalog();
        const G = g();
        // route geometry + hills
        const spacing = T.profile.plan(ctx.route.distanceM || 1);
        const rs = T.profile.resample(ctx.route.path, spacing);
        const distance = ctx.route.distanceM || rs.length;
        if (!elevation) elevation = T.elevation.createElevation();
        let z = null;
        try { z = (await Promise.race([elevation.lookup(rs.lat, rs.lng), new Promise((r) => setTimeout(() => r(null), 7000))])); } catch { z = null; }
        const profile = T.profile.buildProfile(rs.s, z ? /** @type {any} */ (z).z : null, { distance });
        const speeds = T.profile.segmentSpeeds(profile.edges, ctx.route.steps, { distance, duration: ctx.route.durationSec });
        let vMax = 0; for (const v of speeds.speed) vMax = Math.max(vMax, v);
        const routeS = { s: profile.s, lat: rs.lat, lng: rs.lng };
        const levels = readLevels();
        const prefs = T.card && T.card.loadPrefs ? T.card.loadPrefs((() => { try { return localStorage; } catch { return null; } })()) : { traffic: "normal", fuelPerLitre: null, energyPerKWh: null };
        const riders = [];
        for (const mb of ctx.members) {
            let b = null;
            try {
                if (mb.me) {
                    const mine = await T.app.loadBike();
                    if (mine) b = { ...mine, classKey: mine.classKey };
                    else b = await typicalBike(store, index, G.SmartDrive && G.SmartDrive.baseMileage ? G.SmartDrive.baseMileage : null);
                } else if (mb.profile && mb.profile.bike && mb.profile.bike.bundle) {
                    const pb = mb.profile.bike;
                    // offline and never seen that bundle: their km/L on a typical bike, rather than leaving them out
                    const bundle = await store.bundle(pb.bundle).catch(() => null);
                    const dc = bundle ? index.classes.find((c) => c.key === bundle.classKey) : null;
                    if (bundle) b = { bundle, classDefault: bundle.kind === "variant" && dc ? await store.bundle(dc.bundle).catch(() => undefined) : undefined, settings: pb.settings || {}, name: pb.title || "Their bike", classKey: bundle.classKey, estimated: false };
                    else b = await typicalBike(store, index, Number.isFinite(mb.profile.kmPerL) ? mb.profile.kmPerL : null);
                } else b = await typicalBike(store, index, mb.profile && Number.isFinite(mb.profile.kmPerL) ? mb.profile.kmPerL : null);
            } catch (e) { console.warn("[pitstop] bike for", mb.name, e); continue; }
            const model = P.createBikeModel(b.bundle, { classDefault: b.classDefault, settings: b.settings });
            const ev = model.powertrain === "ev";
            const est = T.energy.createTripEstimator(P, model, { altitude: profile.zMean, vMax: vMax || 15 });
            const r = est.estimate(profile, speeds, { traffic: prefs.traffic || "normal" });
            let scale = r.cruise.mean > 0 ? r.total.mean / r.cruise.mean : 1;
            let note = "";
            if (b.kmPerL && !ev) {                                            // a typical bike, scaled to the km/L the rider shares
                const pm50 = P.operatingPoint(model, 50 / 3.6, {}).fuelPerMetre;
                const f = pm50 > 0 ? (1 / (b.kmPerL * 1e6)) / pm50 : 1;
                scale *= f;
                note = `No bike shared yet: a typical bike scaled to their ${Math.round(b.kmPerL)} km/L`;
            } else if (b.estimated) note = "No bike or km/L shared yet: a typical commuter bike";
            const C = Pit.plan.cumulative(r.perMetre, profile.ds, scale);
            const tank = b.bundle.chassis && b.bundle.chassis.fuelTank ? b.bundle.chassis.fuelTank.v : (b.classDefault && b.classDefault.chassis && b.classDefault.chassis.fuelTank ? b.classDefault.chassis.fuelTank.v : 0.012);
            const capacity = ev ? (model.battery ? (model.battery.usable !== null ? model.battery.usable : model.battery.gross * 0.92) : 7.2e6) : tank;
            // level
            let share = 0.5, levelSource = "assumed", levelNote = `Not known: half ${ev ? "a battery" : "a tank"} assumed. Set it below.`;
            const set = levels[mb.key];
            const shared = mb.profile && mb.profile.level && Number.isFinite(mb.profile.level.share) ? mb.profile.level : null;
            if (set && Date.now() - set.at < LEVEL_TTL) { share = set.share; levelSource = "set"; levelNote = `${mb.me ? "Set by you" : "Set here"}, ${agoText(set.at)}`; }
            else if (shared) { share = shared.share; levelSource = "shared"; levelNote = `Shared by ${mb.name}${shared.at ? `, ${agoText(shared.at)}` : ""}`; }
            else if (mb.me && !ev) { const m = myLevelFromFillups(G, capacity, model, P); if (m) { share = m.share; levelSource = "estimated"; levelNote = m.note; } }
            // where they join the route
            let startS = 0, offRoute = 0;
            if (Number.isFinite(mb.lat) && Number.isFinite(mb.lng)) {
                const pr = Pit.stations.project([{ id: mb.id, lat: mb.lat, lng: mb.lng, kinds: ["fuel"], name: "" }], routeS, Infinity)[0];
                if (pr) { startS = mb.me ? 0 : pr.s; offRoute = mb.me ? 0 : pr.offRoute; }
            }
            const pmFlat = P.operatingPoint(model, 40 / 3.6, {});
            const joinCost = offRoute > 300 ? offRoute * 1.3 * ((ev ? pmFlat.energyPerMetre : pmFlat.fuelPerMetre) || 0) * scale : 0;
            riders.push({
                id: mb.id, key: mb.key, name: mb.name, avatar: mb.avatar, color: mb.color, me: mb.me, kind: ev ? "ev" : "fuel",
                capacity, energy: share * capacity, levelSource, levelNote, startS, offRoute, joinCost, C,
                bike: { name: b.name, classKey: b.classKey || model.classKey, estimated: !!b.estimated, note }
            });
        }
        if (!riders.length) return { state: "error", destName: ctx.destName, message: "No riders to plan for yet." };
        const modelOut = {
            state: "ready", title: ctx.title, destName: ctx.destName,
            route: { s: profile.s, lat: rs.lat, lng: rs.lng, distance, duration: ctx.route.durationSec || distance / (40 / 3.6) },
            riders, stations: { list: [], source: "loading" },
            prices: { fuelPerLitre: prefs.fuelPerLitre || 100, energyPerKWh: prefs.energyPerKWh || 8, fuelExample: prefs.fuelPerLitre === null, energyExample: prefs.energyPerKWh === null }
        };
        // stations: arrive later, then the plan is redone
        if (!stationsApi) stationsApi = Pit.stations.createStations();
        stationsApi.along(routeS).then((res) => { modelOut.stations = { list: res.stations, source: res.source }; onStations(modelOut); }, () => { modelOut.stations = { list: [], source: "none" }; onStations(modelOut); });
        return modelOut;
    }

    // ------------------------------------------------------------------ map
    function drawStops(plan, model) {
        const G = g(), L = W.L;
        if (!G.map || !L) return;
        if (!layer) layer = L.layerGroup().addTo(G.map);
        layer.clearLayers();
        plan.stops.forEach((st, i) => {
            const pos = st.station ? [st.station.lat, st.station.lng] : pointAt(model.route, st.s);
            if (!pos) return;
            const icon = L.divIcon({ className: "", html: `<div class="mu-pit-pin${st.noStation ? " is-zone" : ""}"><span>${i + 1}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 30] });
            const mk = L.marker(pos, { icon, zIndexOffset: 900, title: st.station ? st.station.name : `Refuel around km ${Math.round(st.s / 1000)}` });
            mk.on("click", () => { const el = document.querySelector(`.cp-stop:nth-child(${i + 1})`); if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
            mk.addTo(layer);
            if (st.noStation) {
                const seg = [];
                for (let k = 0; k < model.route.s.length; k++) if (model.route.s[k] >= st.window[0] && model.route.s[k] <= st.window[1]) seg.push([model.route.lat[k], model.route.lng[k]]);
                if (seg.length > 1) L.polyline(seg, { color: "#ffb020", weight: 7, opacity: 0.7, dashArray: "6 8" }).addTo(layer);
            }
        });
    }
    function pointAt(route, sv) {
        const S = route.s;
        for (let k = 1; k < S.length; k++) if (S[k] >= sv) { const w = (sv - S[k - 1]) / (S[k] - S[k - 1] || 1); return [route.lat[k - 1] + (route.lat[k] - route.lat[k - 1]) * w, route.lng[k - 1] + (route.lng[k] - route.lng[k - 1]) * w]; }
        return null;
    }

    // ------------------------------------------------------------------ open / close
    async function open(opts = {}) {
        if (opts.context) overrideCtx = opts.context;
        const host = $("pitstop-panel");
        if (!host) return;
        host.hidden = false;
        try { await loadFiles(); } catch (e) { host.textContent = /** @type {Error} */ (e).message; return; }
        const Pit = W.MUPitstop;
        if (!panel) {
            panel = Pit.panel.createConvoyPanel(host, {
                units: W.MUGarage.units, plan: Pit.plan, silhouettes: W.MUGarage.silhouettes,
                onClose: close,
                onPlan: (plan, model) => drawStops(plan, model),
                onLevelChange: (id, share) => {
                    const r = lastModel && lastModel.riders.find((x) => x.id === id);
                    if (r) writeLevel(r.key, share);
                    panel.setLevel(id, share);
                    if (r && r.me) shareFuel();                        // your own level: your trip-mates plan with it too
                },
                onFocusRider: (id) => {
                    const G = g();
                    if (!G.map) return;
                    const m = id === G.socketId ? (G.myCoords ? [G.myCoords.lat, G.myCoords.lng] : null) : (G.friendMarkers[id] ? G.friendMarkers[id].getLatLng() : null);
                    if (m) G.map.panTo(m);
                },
                onFocusStop: (st) => {
                    const G = g();
                    const pos = st.station ? [st.station.lat, st.station.lng] : lastModel ? pointAt(lastModel.route, st.s) : null;
                    if (G.map && pos) G.map.flyTo(pos, 14);
                },
                onNavigateStop: async (st) => {
                    const G = g();
                    if (!st.station || !G.myCoords || !G.OSRM_BASE || !G.RoutePrefs || !G.startSearchNavigation) return;
                    try {
                        const data = await G.RoutePrefs.fetchRoute(`${G.OSRM_BASE}/route/v1/driving/${G.myCoords.lng},${G.myCoords.lat};${st.station.lng},${st.station.lat}?overview=full&geometries=geojson&steps=true`);
                        const r = data && data.routes && data.routes[0];
                        if (r) { close(); G.startSearchNavigation(st.station.lat, st.station.lng, st.station.name, r); }
                    } catch { /* offline: the stop is still on the map */ }
                }
            });
        }
        panel.setModel({ state: "loading", message: "Working out everyone's fuel…" });
        const rebuild = async () => {
            try {
                const m = await buildModel((withStations) => { if (lastModel === withStations && panel) panel.setModel(withStations); });
                lastModel = m;
                panel.setModel(m);
            } catch (e) { panel.setModel({ state: "error", message: `Couldn't plan: ${/** @type {Error} */ (e).message}` }); }
        };
        await rebuild();
        clearInterval(refreshTimer);
        refreshTimer = setInterval(() => { if (!host.hidden && !overrideCtx) rebuild(); }, 120000);
        const c = host.querySelector(".cp-close");
        if (c) /** @type {HTMLElement} */ (c).focus();
    }
    function close() {
        const host = $("pitstop-panel");
        if (host) host.hidden = true;
        clearInterval(refreshTimer);
        if (layer) layer.clearLayers();
    }

    /** What the server can relay to the group so others plan with your real bike and level. */
    async function myShare() {
        const b = W.MUTrip && W.MUTrip.app ? await W.MUTrip.app.loadBike().catch(() => null) : null;
        const g0 = W.MUTrip && W.MUTrip.app ? W.MUTrip.app.store.garage() : null;
        const lv = readLevels().me;
        return {
            bike: b && g0 ? { bundle: g0.bundle, bikeId: g0.bikeId || null, classKey: g0.classKey, title: b.name, settings: g0.settings } : null,
            level: lv && Date.now() - lv.at < LEVEL_TTL ? { share: lv.share, at: lv.at } : null
        };
    }

    /** myShare() as the server takes it (setFuelShare): the level as its age, not a clock time. */
    function wireShare(/** @type {any} */ s) {
        return { bike: s.bike, level: s.level ? { share: s.level.share, ageMs: Math.max(0, Date.now() - s.level.at) } : null };
    }
    /** Send your bike and level to the server for your trip-mates. Never throws. */
    async function shareFuel() {
        try {
            // @ts-ignore
            const sock = typeof socket !== "undefined" ? socket : null;
            if (!sock || !sock.connected) return false;
            sock.emit("setFuelShare", wireShare(await myShare()));
            return true;
        } catch (e) { console.warn("[pitstop] couldn't share bike and level:", e); return false; }
    }

    function init() {
        const b = $("pitstop-plan-btn");
        if (b) b.addEventListener("click", () => open());
        document.addEventListener("keydown", (e) => { const host = $("pitstop-panel"); if (e.key === "Escape" && host && !host.hidden) close(); });
        // share after every (re)connect (a new socket id starts empty on the server) and when My bike changes
        // @ts-ignore
        const sock = typeof socket !== "undefined" ? socket : null;
        if (sock && typeof sock.on === "function") sock.on("profileAccepted", () => setTimeout(shareFuel, 500));
        document.addEventListener("mu:garage-change", () => shareFuel());
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
    W.MUPitstop = W.MUPitstop || {};
    W.MUPitstop.app = { open, close, myShare, shareFuel, wireShare, buildModel, get panel() { return panel; } };
})(typeof globalThis !== "undefined" ? globalThis : this);
