"use strict";

/* ============================================================================
   MapUnite client — js/navigation.js
   ==============================================================================
   Routing and turn-by-turn: route options (avoid highways/tolls), Google
   Places search, maneuver text, live-traffic ETAs and faster-route checks,
   startSearchNavigation() and stopDrive().

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

// ---- Route options: avoid highways / tolls (roadmap Section 4) ------------
// One rider preference, applied to EVERY route this app draws — search route
// (Google avoidHighways/avoidTolls), navigation + its reroutes, voice
// "navigate to", route-to-friend, measurement, group trip, meetup routes,
// restored navigation and the carpool plan (OSRM `exclude=`).
//
// What OSRM can and can't do, stated plainly in the UI too:
//   - "highways" = OSM highway=motorway (expressways). Most Indian national
//     highways are tagged `trunk`, which OSRM's car profile has no class for,
//     so they are NOT avoided on OSRM routes. Google search routes use
//     Google's own, broader definition.
//   - Some OSRM servers can exclude motorway OR toll but not both at once.
//     Then we exclude one and pick an alternative whose steps carry none of
//     the other class (step intersections report `classes`).
//   - If no route avoids them, or the server can't exclude at all, the normal
//     route is used and the rider is TOLD — never a silent "no route".
// fetchRoute(url) is a drop-in for `fetch(url).then(r => r.json())` and adds
// `avoid: { requested, applied, reason }` to the JSON.
const RoutePrefs = {
    KEY: "mu_route_avoid",
    avoidHighways: false,
    avoidTolls: false,
    support: { exclude: null, combo: null },   // learned from the routing server this session
    lastNoticeAt: 0,
    NAMES: { motorway: "highways", toll: "tolls" },

    load() {
        try {
            const v = JSON.parse(localStorage.getItem(this.KEY) || "{}");
            this.avoidHighways = v.highways === true;
            this.avoidTolls = v.tolls === true;
        } catch (e) { /* storage blocked or corrupt — defaults */ }
    },
    save() {
        try { localStorage.setItem(this.KEY, JSON.stringify({ highways: this.avoidHighways, tolls: this.avoidTolls })); } catch (e) { /* ignore */ }
        document.dispatchEvent(new CustomEvent("mu:route-prefs", { detail: { highways: this.avoidHighways, tolls: this.avoidTolls } }));
    },
    classes() {
        const c = [];
        if (this.avoidHighways) c.push("motorway");
        if (this.avoidTolls) c.push("toll");
        return c;
    },
    describe(list = this.classes()) { return list.map((c) => this.NAMES[c] || c).join(" and "); },

    // Query params are appended as plain text: URLSearchParams would encode the
    // comma in "motorway,toll", and OSRM expects it literally.
    withParams(url, params) {
        let u = String(url);
        for (const k of Object.keys(params)) u = u.replace(new RegExp(`([?&])${k}=[^&]*&?`), "$1").replace(/[?&]$/, "");
        const q = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
        return u + (u.includes("?") ? "&" : "?") + q;
    },
    routeHas(route, cls) {
        return Boolean(route && Array.isArray(route.legs) && route.legs.some((l) => Array.isArray(l.steps) &&
            l.steps.some((s) => Array.isArray(s.intersections) && s.intersections.some((i) => Array.isArray(i.classes) && i.classes.includes(cls)))));
    },
    async getJson(url) {
        const r = await fetch(url);                   // network errors propagate, exactly like the old call sites
        try { return await r.json(); } catch (e) { return { code: r.ok ? "BadResponse" : `Http${r.status}` }; }
    },

    async fetchRoute(url) {
        const requested = this.classes();
        if (!requested.length) return this.done(await this.getJson(url), requested, [], null);
        const ok = (j) => j && j.code === "Ok" && Array.isArray(j.routes) && j.routes.length > 0;
        const unsupported = (j) => j && /^(InvalidValue|InvalidOptions|InvalidQuery)$/.test(j.code);

        // 1. Everything at once.
        if (this.support.exclude !== false && (requested.length === 1 || this.support.combo !== false)) {
            const j = await this.getJson(this.withParams(url, { exclude: requested.join(",") }));
            if (ok(j)) {
                this.support.exclude = true;
                if (requested.length > 1) this.support.combo = true;
                return this.done(j, requested, requested, null);
            }
            if (unsupported(j)) { if (requested.length > 1) this.support.combo = false; else this.support.exclude = false; }
            else if (requested.length === 1) return this.done(await this.getJson(url), requested, [], "no-route");
        }
        // 2. Server can't combine the two: exclude one, keep an alternative free of the other.
        if (requested.length > 1 && this.support.exclude !== false) {
            let partial = null;
            for (const cls of requested) {
                const j = await this.getJson(this.withParams(url, { exclude: cls, alternatives: "true", steps: "true" }));
                if (unsupported(j)) { this.support.exclude = false; break; }
                this.support.exclude = true;
                if (!ok(j)) continue;
                const others = requested.filter((c) => c !== cls);
                const clean = j.routes.find((r) => others.every((o) => !this.routeHas(r, o)));
                if (clean) { j.routes = [clean]; return this.done(j, requested, requested, null); }
                if (!partial) { j.routes = [j.routes[0]]; partial = { j, applied: [cls] }; }
            }
            if (partial) return this.done(partial.j, requested, partial.applied, "partial");
        }
        return this.done(await this.getJson(url), requested, [], this.support.exclude === false ? "unsupported" : "no-route");
    },

    done(json, requested, applied, reason) {
        const j = json && typeof json === "object" ? json : { code: "BadResponse" };
        j.avoid = { requested, applied, reason };
        if (reason && j.code === "Ok") this.notify(j.avoid);
        return j;
    },
    notify(a) {
        if (Date.now() - this.lastNoticeAt < 60000) return;       // once a minute, not once per rider route
        this.lastNoticeAt = Date.now();
        const missed = a.requested.filter((c) => !a.applied.includes(c));
        const msg = a.reason === "unsupported"
            ? `The routing server can't avoid ${this.describe(a.requested)} — showing the normal route.`
            : a.reason === "partial"
                ? `Avoided ${this.describe(a.applied)}, but no route here also avoids ${this.describe(missed)}.`
                : `No route here avoids ${this.describe(a.requested)} — showing the normal route.`;
        showToast(`🛣️ ${msg}`, 5000);
    },

    // Google DirectionsService request options for the search route.
    googleOptions() { return { avoidHighways: this.avoidHighways, avoidTolls: this.avoidTolls }; },

    bindUI() {
        const hw = $("avoid-highways-toggle"), tl = $("avoid-tolls-toggle");
        if (hw) { hw.checked = this.avoidHighways; hw.addEventListener("change", () => { this.avoidHighways = hw.checked; this.lastNoticeAt = 0; this.save(); }); }
        if (tl) { tl.checked = this.avoidTolls; tl.addEventListener("change", () => { this.avoidTolls = tl.checked; this.lastNoticeAt = 0; this.save(); }); }
        // Keep the switches truthful when the voice command changes the setting.
        document.addEventListener("mu:route-prefs", (e) => {
            if (hw) hw.checked = Boolean(e.detail.highways);
            if (tl) tl.checked = Boolean(e.detail.tolls);
        });
    }
};
RoutePrefs.load();

// ==========================================
// GOOGLE PLACES SEARCH  (unchanged — script tag kept per explicit instruction,
// secured via HTTP-referrer restriction in Google Cloud Console rather than a
// server-side proxy)
// ==========================================
function setupGoogleSearch() {
    const input = $("location-search-input");
    if (!input) return;
    const clearBtn = $("location-search-clear");

    const style = document.createElement('style');
    style.innerHTML = `
        .pac-container { background-color: rgba(10,17,28,0.98); border: 1px solid rgba(255,255,255,0.14); border-radius: 16px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); margin-top: 10px; padding: 6px; font-family: 'Inter', sans-serif; z-index: 9999 !important; }
        .pac-item { color: #8b9bab; padding: 10px; border-top: 1px solid rgba(255,255,255,0.05); cursor: pointer; transition: 0.2s; }
        .pac-item:hover { background: rgba(52,224,180,0.1); }
        .pac-item-query { font-size: 15px; color: #fff; font-weight: 600; padding-right: 5px; }
        .pac-icon { display: none; }
        .pac-matched { color: #34e0b4; }
        .hdpi.pac-logo:after { display: none; }
    `;
    document.head.appendChild(style);

    const clearSearch = () => {
        input.value = "";
        if (clearBtn) clearBtn.style.display = "none";
        if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
        if (typeof searchLayer !== "undefined") searchLayer.clearLayers();
        if (typeof navigationLayer !== "undefined") navigationLayer.clearLayers();
        safeHide("premium-nav-ui");
        safeHide("nav-bottom-sheet");
        if (myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16);
    };
    if (clearBtn) clearBtn.onclick = clearSearch;

    input.addEventListener('input', () => {
        if (clearBtn) clearBtn.style.display = input.value.length > 0 ? "block" : "none";
    });

    let searchLayer = L.layerGroup().addTo(map);

    const checkGoogle = setInterval(() => {
        if (window.google && window.google.maps && window.google.maps.places) {
            clearInterval(checkGoogle);

            const oldResultBox = document.getElementById("search-results-box");
            if (oldResultBox) oldResultBox.remove();

            const autocomplete = new google.maps.places.Autocomplete(input, {
                componentRestrictions: { country: "in" },
                fields: ["geometry", "name", "formatted_address"]
            });

            function updateSearchBounds() {
                const centerLat = myCoords ? myCoords.lat : map.getCenter().lat;
                const centerLng = myCoords ? myCoords.lng : map.getCenter().lng;
                const circle = new google.maps.Circle({
                    center: new google.maps.LatLng(centerLat, centerLng),
                    radius: 50000
                });
                autocomplete.setBounds(circle.getBounds());
                autocomplete.setOptions({ strictBounds: false });
            }

            input.addEventListener('focus', updateSearchBounds);
            map.on('moveend', updateSearchBounds);

            autocomplete.addListener("place_changed", () => {
                const place = autocomplete.getPlace();
                if (!place.geometry || !place.geometry.location) {
                    showToast("❌ Please select a location from the dropdown list.");
                    return;
                }

                const destLat = place.geometry.location.lat();
                const destLng = place.geometry.location.lng();
                const placeName = place.name;

                searchLayer.clearLayers();
                if (typeof navigationLayer !== "undefined") navigationLayer.clearLayers();
                safeHide("nav-panel");
                safeHide("nav-bottom-sheet");
                safeHide("premium-nav-ui");

                map.flyTo([destLat, destLng], 15);

                const popupContent = `
                    <div style="text-align:center; padding:6px; min-width:180px;">
                        <strong style="color:#065f46; font-size:16px; display:block; margin-bottom:8px;">📍 ${escapeHTML(placeName)}</strong>
                        <div id="search-route-info" style="font-size:13px; color:#333; margin-bottom:12px; background:#f3f4f6; padding:8px; border-radius:10px; border: 1px solid #ccc;">
                            <i>Calculating route... ⏳</i>
                        </div>
                        <button id="search-nav-btn" style="width:100%; padding:10px; border:none; border-radius:10px; background:#34e0b4; color:#000; font-weight:900; font-size:14px; cursor:pointer; opacity:0.5; transition:0.3s;" disabled>
                            ▶ Start Navigation
                        </button>
                    </div>
                `;

                searchMarker = L.marker([destLat, destLng], {
                    icon: L.divIcon({ className: 'geofence-marker', html: '📍', iconSize: [30, 30], iconAnchor: [15, 30] })
                }).addTo(searchLayer);

                searchMarker.bindPopup(popupContent).openPopup();
                if (clearBtn) safeShow("location-search-clear", "block");
                PlaceRecall.annotate(document.getElementById("search-route-info"), destLat, destLng);   // Batch 2

                if (myCoords && window.google) {
                    const ds = new google.maps.DirectionsService();
                    ds.route({
                        origin: new google.maps.LatLng(myCoords.lat, myCoords.lng),
                        destination: new google.maps.LatLng(destLat, destLng),
                        travelMode: 'DRIVING',
                        ...RoutePrefs.googleOptions(),
                        ...TrafficETA.options()          // live-traffic ETA (duration_in_traffic) when enabled
                    }, (res, status) => {
                        const infoDiv = document.getElementById("search-route-info");
                        const navBtn = document.getElementById("search-nav-btn");

                        if (status === 'OK' && res.routes.length > 0 && infoDiv && navBtn) {
                            const route = res.routes[0];
                            const leg = route.legs[0];

                            const coords = route.overview_path.map(p => [p.lat(), p.lng()]);
                            L.polyline(coords, { color: '#34e0b4', weight: 6, opacity: 0.8, className: 'nav-path-animated' }).addTo(navigationLayer);
                            map.fitBounds(L.polyline(coords).getBounds(), { padding: [50, 50] });

                            const avoiding = RoutePrefs.describe();
                            const traffic = TrafficETA.describeLeg(leg);
                            infoDiv.innerHTML = `<span style="color:#000; font-size:15px; font-weight:900;">🚗 ${leg.distance.text}</span> <br> <span style="color:#000; font-size:15px; font-weight:900;">⏱️ ${traffic ? escapeHTML(traffic.text) : leg.duration.text}</span>` +
                                (traffic ? `<br><span class="route-traffic-note">🚦 Live traffic (Google)</span>` : "") +
                                (avoiding ? `<br><span class="route-avoid-note">🛣️ Avoiding ${escapeHTML(avoiding)}</span>` : "");
                            navBtn.style.opacity = "1";
                            navBtn.disabled = false;

                            navBtn.onclick = () => {
                                searchMarker.closePopup();

                                const mockRouteData = {
                                    geometry: { coordinates: coords.map(c => [c[1], c[0]]) },
                                    distance: leg.distance.value,
                                    duration: traffic ? traffic.trafficSec : leg.duration.value,   // start the nav ETA from the traffic figure
                                    legs: [{
                                        // Phase 3: carry each step's start point as the
                                        // maneuver location (a Google step's instruction
                                        // describes the maneuver at its START), so turn-
                                        // by-turn can advance and speak on Google routes
                                        // too, not only on OSRM-sourced ones.
                                        steps: leg.steps.map(s => ({
                                            maneuver: {
                                                type: s.instructions.replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim(),
                                                modifier: googleManeuverModifier(s.maneuver),
                                                location: s.start_location ? [s.start_location.lng(), s.start_location.lat()] : null
                                            },
                                            distance: s.distance.value,
                                            duration: s.duration ? s.duration.value : undefined   // Step 7: per-step speeds for trip energy
                                        }))
                                    }]
                                };
                                startSearchNavigation(destLat, destLng, placeName, mockRouteData);
                            };
                        } else if (infoDiv) {
                            infoDiv.innerHTML = "<span style='color:#ef4444; font-weight:bold;'>No driving route found.</span>";
                        }
                    });
                } else {
                    if (document.getElementById("search-route-info")) document.getElementById("search-route-info").innerHTML = "<span style='color:#f59e0b; font-weight:bold;'>GPS required.</span>";
                }
            });
        }
    }, 500);
}

let navWatchId = null;
let navTrafficTimer = null;    // Batch 1: periodic faster-route / traffic check while navigating
let navDrListener = null;      // Phase 4: follows dead-reckoned estimates during navigation

// ---- Maneuver text (roadmap Section 7) -------------------------------------
// Google's DirectionsService already returns plain-English instructions (we
// strip its HTML at the call site). OSRM's `steps=true` instead returns
// maneuver.type/modifier codes — map those through a small phrase table so
// OSRM-sourced routes (e.g. "Route to friend") get readable turn text too.
const MANEUVER_PHRASES = {
    "turn|left": "Turn left", "turn|right": "Turn right", "turn|straight": "Continue straight",
    "turn|slight left": "Bear left", "turn|slight right": "Bear right",
    "turn|sharp left": "Sharp left", "turn|sharp right": "Sharp right",
    "new name|": "Continue", "depart|": "Head out", "arrive|": "You have arrived",
    "merge|left": "Merge left", "merge|right": "Merge right",
    "roundabout|": "Enter the roundabout", "rotary|": "Enter the roundabout",
    "fork|left": "Keep left", "fork|right": "Keep right",
    "end of road|left": "Turn left", "end of road|right": "Turn right",
    "on ramp|": "Take the ramp", "off ramp|": "Take the exit", "continue|": "Continue"
};
const ORDINALS = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];
const KNOWN_OSRM_TYPES = new Set(["turn", "new name", "depart", "arrive", "merge", "on ramp", "off ramp", "fork",
    "end of road", "continue", "roundabout", "rotary", "roundabout turn", "exit roundabout", "exit rotary", "notification", "use lane"]);

function maneuverPhrase(step) {
    const type = step?.maneuver?.type || "";
    const modifier = step?.maneuver?.modifier || "";
    // Google path: the "type" slot already holds a plain-English instruction.
    if (type && !KNOWN_OSRM_TYPES.has(type)) return type;
    if (type === "arrive") return "Arrive at your destination";
    if (type === "roundabout" || type === "rotary") {
        const exit = step?.maneuver?.exit;
        const base = exit && ORDINALS[exit] ? `At the roundabout, take the ${ORDINALS[exit]} exit` : "Enter the roundabout";
        return step?.name ? `${base} onto ${step.name}` : base;
    }
    const phrase = MANEUVER_PHRASES[`${type}|${modifier}`] || MANEUVER_PHRASES[`${type}|`] || (type ? `${type} ${modifier}`.trim() : "Continue on route");
    // OSRM gives the road name separately — worth hearing ("onto NH-26").
    return step?.name && type !== "depart" ? `${phrase} onto ${step.name}` : phrase;
}

// Rotation for the banner's single up-arrow glyph, from an OSRM-style modifier.
function maneuverRotation(step) {
    const type = step?.maneuver?.type || "";
    const m = step?.maneuver?.modifier || "";
    if (type === "arrive") return 0;
    return ({ "left": -90, "right": 90, "slight left": -40, "slight right": 40, "sharp left": -135, "sharp right": 135, "uturn": 180, "straight": 0 })[m] ?? 0;
}

// Google DirectionsStep.maneuver ("turn-slight-left", "roundabout-right",
// "uturn-left", "keep-right", ...) -> the OSRM-style modifier used above.
function googleManeuverModifier(g) {
    const s = String(g || "");
    if (!s) return "";
    if (s.startsWith("uturn")) return "uturn";
    if (s.includes("sharp-left")) return "sharp left";
    if (s.includes("sharp-right")) return "sharp right";
    if (s.includes("slight-left") || s === "keep-left" || s === "fork-left" || s === "ramp-left") return "slight left";
    if (s.includes("slight-right") || s === "keep-right" || s === "fork-right" || s === "ramp-right") return "slight right";
    if (s.endsWith("left")) return "left";
    if (s.endsWith("right")) return "right";
    return "straight";
}

// Perpendicular (great-circle-ish, planar-approximated — fine at road scale)
// distance in meters from a point to the nearest segment of a polyline.
function pointToPolylineDistanceMeters(lat, lng, latlngs) {
    if (!latlngs || latlngs.length < 2) return Infinity;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const toXY = (la, ln) => [(ln) * 111320 * cosLat, (la) * 110540];
    const [px, py] = toXY(lat, lng);
    let best = Infinity;
    for (let i = 0; i < latlngs.length - 1; i++) {
        const [ax, ay] = toXY(latlngs[i][0], latlngs[i][1]);
        const [bx, by] = toXY(latlngs[i + 1][0], latlngs[i + 1][1]);
        const dx = bx - ax, dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t * dx, cy = ay + t * dy;
        const d = Math.hypot(px - cx, py - cy);
        if (d < best) best = d;
    }
    return best;
}

// Metres still to ride ALONG the route from the nearest point on it (the nav
// ETA used the straight line to the destination, which undercounts every bend).
function remainingAlongPathMeters(lat, lng, latlngs) {
    if (!latlngs || latlngs.length < 2) return NaN;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const xy = (p) => [p[1] * 111320 * cosLat, p[0] * 110540];
    const [px, py] = xy([lat, lng]);
    let best = Infinity, bestI = 0, bestT = 0;
    for (let i = 0; i < latlngs.length - 1; i++) {
        const [ax, ay] = xy(latlngs[i]), [bx, by] = xy(latlngs[i + 1]);
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
        const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        if (d < best) { best = d; bestI = i; bestT = t; }
    }
    const segLen = (i) => { const [ax, ay] = xy(latlngs[i]), [bx, by] = xy(latlngs[i + 1]); return Math.hypot(bx - ax, by - ay); };
    let rest = segLen(bestI) * (1 - bestT);
    for (let i = bestI + 1; i < latlngs.length - 1; i++) rest += segLen(i);
    return rest;
}

// Share of `candidate` (latlng path) lying within `tolM` of `reference`,
// sampled every ~80 m — "is this the same road or a genuinely different one?"
function pathOverlapShare(candidate, reference, tolM = 30) {
    if (!candidate || candidate.length < 2 || !reference || reference.length < 2) return 0;
    // Points every ~80 m ALONG each segment (a long straight segment between
    // two far-apart vertices must still be sampled in its middle).
    const pts = [candidate[0]];
    for (let i = 1; i < candidate.length; i++) {
        const a = candidate[i - 1], b = candidate[i], d = map.distance(a, b), n = Math.floor(d / 80);
        for (let k = 1; k <= n; k++) pts.push([a[0] + (b[0] - a[0]) * k / (n + 1), a[1] + (b[1] - a[1]) * k / (n + 1)]);
        pts.push(b);
    }
    if (pts.length > 400) { const step = Math.ceil(pts.length / 400); for (let i = pts.length - 1; i >= 0; i--) if (i % step) pts.splice(i, 1); }
    const near = pts.filter((p) => pointToPolylineDistanceMeters(p[0], p[1], reference) <= tolM).length;
    return near / pts.length;
}

// ---- Live-traffic ETAs (roadmap Sections 10 + 20: Google duration_in_traffic)
// Google's Directions returns a traffic-aware duration when asked with
// drivingOptions { departureTime: now }. Used for the search-route ETA and by
// navigation's periodic faster-route check. Traffic-aware requests are billed
// at Google's higher "Advanced" Directions rate — hence the setting.
const TrafficETA = {
    KEY: "mu_traffic_eta",
    enabled: true,
    init() {
        try { this.enabled = localStorage.getItem(this.KEY) !== "0"; } catch (e) { /* default on */ }
        const t = $("traffic-eta-toggle");
        if (t) {
            t.checked = this.enabled;
            t.addEventListener("change", () => { this.enabled = t.checked; try { localStorage.setItem(this.KEY, this.enabled ? "1" : "0"); } catch (e) { /* ignore */ } });
        }
    },
    available() { return Boolean(this.enabled && window.google && google.maps && typeof google.maps.DirectionsService === "function"); },
    // Extra request fields for google.maps.DirectionsService#route.
    options() { return this.available() ? { drivingOptions: { departureTime: new Date(), trafficModel: "bestguess" } } : {}; },
    minutes(sec) { return Math.max(1, Math.round(sec / 60)); },
    // "14 min in traffic (usually 11)" — or null if Google gave no traffic figure.
    describeLeg(leg) {
        if (!leg || !leg.duration_in_traffic || !leg.duration) return null;
        const t = leg.duration_in_traffic.value, u = leg.duration.value;
        return { trafficSec: t, typicalSec: u, text: `${this.minutes(t)} min in traffic${Math.abs(t - u) >= 60 ? ` (usually ${this.minutes(u)})` : ""}` };
    },
    // Google route -> the shape the navigation code uses (OSRM-like).
    toNavRoute(route) {
        const leg = route.legs[0];
        const path = route.overview_path.map((p) => [p.lat(), p.lng()]);
        const traffic = this.describeLeg(leg);
        return {
            path, distanceM: leg.distance.value, durationSec: traffic ? traffic.trafficSec : leg.duration.value, traffic: Boolean(traffic),
            steps: leg.steps.map((st) => ({
                maneuver: {
                    type: st.instructions.replace(/<[^>]*>?/gm, "").replace(/\s+/g, " ").trim(),
                    modifier: googleManeuverModifier(st.maneuver),
                    location: st.start_location ? [st.start_location.lng(), st.start_location.lat()] : null
                },
                distance: st.distance.value
            }))
        };
    },
    // Traffic-aware candidates from A to B (with Google's alternatives), or null.
    routes(from, to) {
        if (!this.available()) return Promise.resolve(null);
        return new Promise((resolve) => {
            try {
                new google.maps.DirectionsService().route({
                    origin: new google.maps.LatLng(from[0], from[1]), destination: new google.maps.LatLng(to[0], to[1]),
                    travelMode: "DRIVING", provideRouteAlternatives: true, ...RoutePrefs.googleOptions(), ...this.options()
                }, (res, status) => resolve(status === "OK" && res && res.routes ? res.routes.map((r) => this.toNavRoute(r)) : null));
            } catch (e) { resolve(null); }
        });
    }
};

// Reroute-decision threshold, exactly as specified (roadmap Section 10):
// only worth swapping if it saves real time, isn't a wildly different path,
// and we haven't just rerouted.
function shouldReroute(current, candidate, lastRerouteTime) {
    const timeSavedSec = current.durationSec - candidate.durationSec;
    const distDeltaPct = current.distanceM > 0 ? Math.abs(candidate.distanceM - current.distanceM) / current.distanceM : 1;
    const cooldownOk = Date.now() - lastRerouteTime > 60_000;
    return timeSavedSec > 90 && distDeltaPct < 0.5 && cooldownOk;
}

// Kept for existing call sites; routes through the Phase 3 voice policy so
// navigation speech obeys mute / priority / hands-free echo guard like the rest.
function speak(text, opts = {}) {
    return voiceAnnounce(text, { priority: 65, category: "nav", drivingOnly: false, ...opts });
}

// Short on-screen distance ("350 m", "1.2 km").
function formatDistanceShort(meters) {
    if (!Number.isFinite(meters)) return "";
    if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
    return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}
const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

// Step 7: tell the trip-energy card (js/trip/trip-app.js) which route is on
// screen. Only an event: navigation never depends on the card being there.
//   detail = { path: [[lat, lng], …], distanceM, durationSec, steps: [{ distance, duration }], reason }
function emitRoute(path, distanceM, durationSec, steps, reason) {
    try {
        document.dispatchEvent(new CustomEvent("mu:route", { detail: {
            path, distanceM, durationSec, reason,
            steps: (steps || []).map((s) => ({ distance: Number(s && s.distance) || 0, duration: s && Number.isFinite(Number(s.duration)) ? Number(s.duration) : undefined }))
        } }));
    } catch (e) { /* the card is optional */ }
}

function startSearchNavigation(destLat, destLng, destName, routeData) {
    navigationLayer.clearLayers();
    if (navWatchId) navigator.geolocation.clearWatch(navWatchId);

    safeHide("map-tools");
    safeHide("search-container");
    safeHide("top-header");
    safeHide("bottom-info");
    safeHide("chat-toggle-btn");
    safeHide("memoryButton");

    safeShow("premium-nav-ui", "block");
    safeShow("nav-bottom-sheet", "flex");
    safeShow("turn-banner", "flex");

    let fullPath = routeData.geometry.coordinates.map(c => [c[1], c[0]]);
    let activeRoute = { distanceM: routeData.distance, durationSec: routeData.duration };
    let etaFactor = 1;                    // live traffic / fresh re-query vs the route's own duration
    let etaSource = "";                   // "traffic" once Google's live-traffic figure has calibrated it
    if (navTrafficTimer) { clearInterval(navTrafficTimer); navTrafficTimer = null; }
    let steps = (routeData.legs && routeData.legs[0] && routeData.legs[0].steps) || [];
    // stepIdx = the step the rider is currently ON. The banner shows and
    // speaks steps[stepIdx + 1] — the NEXT maneuver. (Before Phase 3 the
    // banner showed steps[stepIdx], i.e. the maneuver that had just happened.)
    let stepIdx = 0;
    let offRouteStreak = 0;
    let lastRerouteTime = 0;
    let rerouteInFlight = false;
    let routeVersion = 0;                 // bumps on reroute so prompt keys never collide
    const promptedPre = new Set();        // "In 200 metres, turn left" already spoken
    const promptedNow = new Set();        // "Turn left" (late prompt) already spoken
    let lastPos = myCoords ? [myCoords.lat, myCoords.lng] : null;

    navState.ready = true;
    navState.active = false;
    navState.destName = destName;
    navState.remainingM = routeData.distance;
    navState.etaSec = routeData.duration;
    navState.routePath = fullPath;          // Phase 4: tunnel mode snaps its estimate to this

    const dottedPath = L.polyline(fullPath, { color: '#4f46e5', weight: 8, opacity: 0.7, className: 'anim-dash' }).addTo(navigationLayer);
    const solidPath = L.polyline([], { color: '#34e0b4', weight: 8, opacity: 1, className: 'solid-trail' }).addTo(navigationLayer);

    const userIcon = L.divIcon({
        className: 'nav-avatar-marker',
        html: `<img src="${escapeHTML(currentUser.avatar)}" style="width:100%;height:100%;object-fit:cover; border-radius:50%; border:2px solid #34e0b4;">`,
        iconSize: [40, 40], iconAnchor: [20, 20]
    });

    const startPos = myCoords ? [myCoords.lat, myCoords.lng] : fullPath[0];
    const userMarker = L.marker(startPos, { icon: userIcon, zIndexOffset: 1000 }).addTo(navigationLayer);
    L.marker([destLat, destLng], { icon: L.divIcon({ className: 'geofence-marker', html: '📍' }) }).addTo(navigationLayer);

    const updateNavStats = (distMeters, durSec) => {
        navState.remainingM = distMeters;
        navState.etaSec = durSec;
        if ($("stat-dist")) $("stat-dist").innerHTML = (distMeters / 1000).toFixed(1) + "<small> km</small>";
        if ($("stat-eta")) $("stat-eta").innerHTML = Math.max(0, Math.round(durSec / 60)) + "<small> min</small>";
        const arrivalTime = new Date(Date.now() + Math.max(0, durSec) * 1000);
        if ($("nav-arrival-time")) $("nav-arrival-time").textContent = arrivalTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    };
    updateNavStats(routeData.distance, routeData.duration);
    emitRoute(fullPath, routeData.distance, routeData.duration, steps, "preview");   // Step 7: trip energy

    const maneuverLatLng = (s) => {
        const loc = s && s.maneuver && s.maneuver.location;
        return Array.isArray(loc) && validCoord(loc[1], loc[0]) ? [loc[1], loc[0]] : null;
    };
    const nextManeuver = () => steps[stepIdx + 1] || null;

    // Distance to the next maneuver: live from GPS when the step carries a
    // location; otherwise the current step's own length as an estimate.
    const distanceToNext = (fromPos) => {
        const next = nextManeuver();
        if (!next) return null;
        const ll = maneuverLatLng(next);
        if (ll && fromPos) return map.distance(fromPos, ll);
        const cur = steps[stepIdx];
        return cur && Number.isFinite(cur.distance) ? cur.distance : null;
    };

    const updateStepDisplay = (fromPos) => {
        const next = nextManeuver();
        const turnDist = $("turn-dist"), turnName = $("turn-name"), stepText = $("nav-step-text"), stepDist = $("nav-step-dist"), svg = $("turn-svg");
        if (!next) {
            if (turnDist) turnDist.textContent = Number.isFinite(navState.remainingM) ? `${formatDistanceShort(navState.remainingM)} to go` : "Follow the route";
            if (turnName) turnName.textContent = `Heading to ${destName}`;
            if (stepText) stepText.textContent = "";
            if (stepDist) stepDist.textContent = "";
            if (svg) svg.style.transform = "rotate(0deg)";
            navState.nextManeuver = "";
            return;
        }
        const phrase = maneuverPhrase(next);
        const d = distanceToNext(fromPos);
        if (turnDist) turnDist.textContent = Number.isFinite(d) ? `In ${formatDistanceShort(d)}` : "Next";
        if (turnName) turnName.textContent = phrase;
        if (svg) svg.style.transform = `rotate(${maneuverRotation(next)}deg)`;
        const after = steps[stepIdx + 2];
        if (stepText) stepText.textContent = after ? `Then ${lowerFirst(maneuverPhrase(after))}` : `Then arrive at ${destName}`;
        if (stepDist) stepDist.textContent = Number.isFinite(next.distance) && next.distance > 0 && after ? `· after ${formatDistanceShort(next.distance)}` : "";
        navState.nextManeuver = phrase;
    };
    updateStepDisplay(lastPos);

    map.fitBounds(dottedPath.getBounds(), { paddingBottomRight: [0, 350], paddingTopLeft: [50, 150] });

    const startBtn = $("btn-start-nav");
    const resetBtn = $("btn-reset-nav");
    const exitBtn = $("btn-exit-nav");

    if (startBtn) {
        startBtn.style.display = "block";
        startBtn.textContent = "Start Navigation";
        startBtn.style.background = "linear-gradient(135deg, #34d399, #22c55e)";
        startBtn.style.color = "#062112";
    }
    if (resetBtn) resetBtn.style.display = "block";
    if (exitBtn) { exitBtn.style.display = "none"; exitBtn.textContent = "Stop"; exitBtn.style.background = ""; exitBtn.style.color = ""; }
    if ($("stat-status")) { $("stat-status").textContent = "Ready"; $("stat-status").style.color = ""; }
    if ($("speed-n")) $("speed-n").textContent = "0";

    if (startBtn) {
        startBtn.onclick = () => {
            startBtn.style.display = "none";
            if (resetBtn) resetBtn.style.display = "none";
            if (exitBtn) exitBtn.style.display = "block";

            if ($("stat-status")) { $("stat-status").textContent = "En route"; $("stat-status").style.color = "#f5a524"; }

            if (myCoords) map.flyTo([myCoords.lat, myCoords.lng], 18, { animate: true, duration: 1.5 });

            navState.ready = false;
            navState.active = true;
            SmartDrive.startTrip();              // also emits mu:drive-state
            if (typeof TripDB !== "undefined") TripDB.saveNavState({ destLat, destLng, destName, active: true });

            // Opening line: destination, then the first real maneuver if we know it.
            const first = nextManeuver();
            const d0 = distanceToNext(lastPos);
            let opening = `Navigation started. Heading to ${destName}.`;
            if (first && Number.isFinite(d0)) {
                opening += ` In ${spokenDistance(d0)}, ${lowerFirst(maneuverPhrase(first))}.`;
                if (d0 <= 250) promptedPre.add(`${routeVersion}:${stepIdx + 1}`);
            }
            speak(opening, { priority: 70, key: `nav-start-${destLat}-${destLng}`, cooldownMs: 5000 });

            if (navigator.geolocation) {
                let traveledCoords = [];
                // Phase 4: ONE handler for real fixes and for dead-reckoned
                // estimates (mu:dr-position). Estimates move the marker, the
                // trail and the turn prompts, but never trigger an off-route
                // reroute or "arrived" off a guess.
                const onNavPosition = async (currentLat, currentLng, speedMps, estimated) => {
                    const currentPos = [currentLat, currentLng];
                    lastPos = currentPos;

                    const speedKmh = Math.round(speedMps * 3.6);
                    if ($("speed-n")) $("speed-n").textContent = speedKmh;

                    userMarker.setLatLng(currentPos);
                    const umEl = typeof userMarker.getElement === "function" ? userMarker.getElement() : null;
                    if (umEl) umEl.classList.toggle("dr-est", Boolean(estimated));
                    const ss = $("stat-status");
                    if (ss && ss.textContent !== "Arrived") { ss.textContent = estimated ? "No GPS" : "En route"; ss.style.color = estimated ? "var(--c-sensor)" : "#f5a524"; }
                    map.panTo(currentPos);

                    traveledCoords.push(L.latLng(currentLat, currentLng));
                    solidPath.setLatLngs(traveledCoords);

                    const remainingMeters = map.distance(currentPos, [destLat, destLng]);        // straight line: arrival test only
                    const alongM = remainingAlongPathMeters(currentLat, currentLng, fullPath);
                    const leftM = Number.isFinite(alongM) ? Math.max(alongM, remainingMeters) : remainingMeters;
                    updateNavStats(leftM, activeRoute.durationSec * (leftM / Math.max(1, activeRoute.distanceM)) * etaFactor);

                    // --- Turn-by-turn prompts (Phase 3, voice-first Safe Drive) ---
                    // One early prompt inside 250 m, one late prompt only if the
                    // early one was missed (short step / sparse fixes), then
                    // advance when within 35 m of the maneuver point.
                    const next = nextManeuver();
                    const nextLL = maneuverLatLng(next);
                    if (next && nextLL) {
                        const d = map.distance(currentPos, nextLL);
                        const k = `${routeVersion}:${stepIdx + 1}`;
                        if (d <= 250 && d > 60 && !promptedPre.has(k)) {
                            promptedPre.add(k);
                            speak(`In ${spokenDistance(d)}, ${lowerFirst(maneuverPhrase(next))}.`, { priority: 70, key: `man-pre-${k}`, cooldownMs: 30000, maxAgeMs: 5000 });
                        } else if (d <= 60 && !promptedPre.has(k) && !promptedNow.has(k)) {
                            promptedNow.add(k);
                            speak(`${maneuverPhrase(next)}.`, { priority: 72, key: `man-now-${k}`, cooldownMs: 30000, maxAgeMs: 4000 });
                        }
                        if (d < 35) stepIdx++;
                    }
                    updateStepDisplay(currentPos);
                    if (estimated) return;             // no reroute / arrival decisions on an estimate

                    // --- Off-route detection + reroute (roadmap Section 7 + 10) ---
                    const offDist = pointToPolylineDistanceMeters(currentLat, currentLng, fullPath);
                    offRouteStreak = offDist > 40 ? offRouteStreak + 1 : 0;
                    // One reroute request at a time: the next fix used to arrive while
                    // the first request was still in flight and fire a duplicate.
                    if (offRouteStreak >= 2 && Date.now() - lastRerouteTime > 60_000 && !rerouteInFlight) {
                        rerouteInFlight = true;
                        try {
                            // Same avoid-highways/tolls preference as the original route —
                            // a reroute must not quietly put the rider back on a toll road.
                            const data = await RoutePrefs.fetchRoute(`${OSRM_BASE}/route/v1/driving/${currentLng},${currentLat};${destLng},${destLat}?overview=full&geometries=geojson&steps=true&alternatives=false`);
                            const cand = data.routes && data.routes[0];
                            if (cand) {
                                const currentEstimate = { distanceM: remainingMeters, durationSec: activeRoute.durationSec * (remainingMeters / Math.max(1, activeRoute.distanceM)) };
                                const candidate = { distanceM: cand.distance, durationSec: cand.duration };
                                // Always resync the polyline once we're genuinely off it — silent
                                // navigation off a route the rider can see is confusing either way.
                                // shouldReroute() only decides whether to also call this out as a
                                // "faster path found" cue vs. a quiet resync. Either way the rider
                                // HEARS it (roadmap Section 26: no silent rerouting).
                                fullPath = cand.geometry.coordinates.map(c => [c[1], c[0]]);
                                dottedPath.setLatLngs(fullPath);
                                navState.routePath = fullPath;
                                activeRoute = { distanceM: cand.distance, durationSec: cand.duration };
                                etaFactor = 1; etaSource = "";
                                steps = (cand.legs && cand.legs[0] && cand.legs[0].steps) || [];
                                emitRoute(fullPath, cand.distance, cand.duration, steps, "reroute");   // Step 7
                                stepIdx = 0;
                                routeVersion++;
                                updateStepDisplay(currentPos);
                                lastRerouteTime = Date.now();
                                offRouteStreak = 0;

                                if (shouldReroute(currentEstimate, candidate, 0)) {
                                    showToast("🔄 Faster route found — recalculating.", 4000);
                                    speak("Recalculating a faster route.", { priority: 66, key: "reroute", cooldownMs: 20000 });
                                } else {
                                    showToast("🔄 Back on track — route updated.", 3000);
                                    speak("Route updated.", { priority: 66, key: "reroute", cooldownMs: 20000 });
                                }
                                islandShow({ id: "reroute", kind: "info", title: "Rerouting", sub: "Path updated to your position", ttl: 4000 });
                            }
                        } catch (e) { /* OSRM demo instance hiccup — just try again next off-route streak */ }
                        finally { rerouteInFlight = false; }
                    }

                    if (remainingMeters < 30) {
                        navigator.geolocation.clearWatch(navWatchId);
                        if (exitBtn) { exitBtn.textContent = "Arrived"; exitBtn.style.background = "#3b82f6"; exitBtn.style.color = "white"; }
                        if ($("stat-status")) { $("stat-status").textContent = "Arrived"; $("stat-status").style.color = "var(--mint)"; }
                        if ($("turn-name")) $("turn-name").textContent = "Destination reached!";
                        if ($("turn-dist")) $("turn-dist").textContent = destName;
                        speak(`You have arrived at ${destName}.`, { priority: 70, key: "arrived", cooldownMs: 60000 });
                        PlaceRecall.announceHere(destLat, destLng, { reason: "arrived", name: destName });   // Batch 2
                        setTimeout(() => stopDrive(), 3000);
                    }
                };
                navWatchId = navigator.geolocation.watchPosition((pos) => {
                    if (DeadReckoning.shouldIgnoreNavFix(pos)) return;   // coarse fix mid-outage: the estimate has it
                    onNavPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.speed || 0, false);
                }, (err) => {
                    // TIMEOUT (3) is routine when stationary or under canopy — the
                    // watch keeps running, so it isn't worth an error. Surface a
                    // permission loss; log anything else quietly.
                    if (err && err.code === 3) return;
                    if (err && err.code === 1) { showToast("⚠️ Location permission was turned off — navigation can't follow you.", 6000); return; }
                    console.warn("GPS error during nav:", err && err.message);
                }, { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 });
                // --- Traffic soft signal (roadmap Section 10) -------------------------
                // Every NAV_RECHECK_MS while ON the route: ask for fresh routes from
                // here (Google with live traffic when enabled, else OSRM) and
                //   - the one that follows OUR road (>= 85% overlap) recalibrates
                //     the ETA (with traffic, the ETA now includes it);
                //   - a genuinely different road (< 80% overlap) that passes
                //     shouldReroute() (saves > 90 s, < 50% longer/shorter, 60 s
                //     cooldown) is switched to — and ANNOUNCED, never silently
                //     (Section 26).
                const NAV_RECHECK_MS = 180000;
                const checkFasterRoute = async () => {
                    if (!navState.active || !lastPos || rerouteInFlight || offRouteStreak > 0) return;
                    if (DeadReckoning.core && DeadReckoning.core.active()) return;
                    if (Date.now() - lastRerouteTime < 60_000) return;
                    const here = lastPos, dest = [destLat, destLng];
                    const alongM = remainingAlongPathMeters(here[0], here[1], fullPath);
                    if (!Number.isFinite(alongM) || alongM < 1500) return;          // nearly there: nothing to gain
                    rerouteInFlight = true;
                    try {
                        let cands = await TrafficETA.routes(here, dest);
                        let source = "traffic";
                        if (!cands || !cands.length) {
                            source = "osrm";
                            const data = await RoutePrefs.fetchRoute(`${OSRM_BASE}/route/v1/driving/${here[1]},${here[0]};${destLng},${destLat}?overview=full&geometries=geojson&steps=true&alternatives=true`);
                            cands = (data && data.routes ? data.routes : []).map((r) => ({ path: r.geometry.coordinates.map((c) => [c[1], c[0]]), distanceM: r.distance, durationSec: r.duration, steps: (r.legs && r.legs[0] && r.legs[0].steps) || [], traffic: false }));
                        }
                        if (!navState.active || !cands.length) return;
                        const remaining = fullPath.slice(Math.max(0, fullPath.findIndex((p) => map.distance(p, here) < 80)));
                        cands.forEach((c) => { c.overlap = pathOverlapShare(c.path, remaining.length >= 2 ? remaining : fullPath); });
                        const same = cands.filter((c) => c.overlap >= 0.85).sort((a, b) => b.overlap - a.overlap)[0];
                        const baseSec = activeRoute.durationSec * (alongM / Math.max(1, activeRoute.distanceM));
                        if (same && baseSec > 0) {
                            etaFactor = Math.min(3, Math.max(0.5, same.durationSec / baseSec));
                            etaSource = same.traffic ? "traffic" : "";
                            updateNavStats(alongM, baseSec * etaFactor);
                            const lbl = $("stat-eta-note"); if (lbl) lbl.textContent = etaSource === "traffic" ? "incl. traffic" : "";
                        }
                        const current = { distanceM: alongM, durationSec: same ? same.durationSec : baseSec * etaFactor };
                        const best = cands.filter((c) => c.overlap < 0.8).sort((a, b) => a.durationSec - b.durationSec)[0];
                        if (best && shouldReroute(current, { distanceM: best.distanceM, durationSec: best.durationSec }, lastRerouteTime)) {
                            const savedMin = Math.max(1, Math.round((current.durationSec - best.durationSec) / 60));
                            fullPath = best.path;
                            dottedPath.setLatLngs(fullPath);
                            navState.routePath = fullPath;
                            activeRoute = { distanceM: best.distanceM, durationSec: best.durationSec };
                            etaFactor = 1; etaSource = best.traffic ? "traffic" : "";
                            steps = best.steps || [];
                            emitRoute(fullPath, best.distanceM, best.durationSec, steps, "reroute");   // Step 7
                            stepIdx = 0;
                            routeVersion++;
                            lastRerouteTime = Date.now();
                            updateStepDisplay(lastPos);
                            updateNavStats(best.distanceM, best.durationSec);
                            const why = source === "traffic" ? "Traffic ahead — faster route" : "Faster route found";
                            showToast(`🔄 ${why}: saves about ${savedMin} min.`, 5000);
                            speak(`${why}. Taking it saves about ${spokenMinutes(savedMin)}.`, { priority: 67, key: "soft-reroute", cooldownMs: 60000 });
                            islandShow({ id: "reroute", kind: "info", icon: "🔄", title: why, sub: `Saves about ${savedMin} min${source === "traffic" ? " · live traffic" : ""}`, ttl: 6000 });
                            document.dispatchEvent(new CustomEvent("mu:soft-reroute", { detail: { savedMin, source } }));
                        }
                    } catch (e) { /* routing hiccup: try again next interval */ }
                    finally { rerouteInFlight = false; }
                };
                navTrafficTimer = setInterval(checkFasterRoute, NAV_RECHECK_MS);
                window.__navCheckFasterRoute = checkFasterRoute;      // exposed for diagnostics/tests
                if (navDrListener) document.removeEventListener("mu:dr-position", navDrListener);
                navDrListener = (e) => {
                    const est = e.detail;
                    if (navState.active && est && !est.lost && validCoord(est.lat, est.lng)) onNavPosition(est.lat, est.lng, (est.speedKmh || 0) / 3.6, true);
                };
                document.addEventListener("mu:dr-position", navDrListener);
            }
            emitDriveState();
        };
    }

    if (resetBtn) resetBtn.onclick = () => stopDrive(true);
    if (exitBtn) exitBtn.onclick = () => stopDrive();
}

function stopDrive(cancelled = false) {
    if (navWatchId) navigator.geolocation.clearWatch(navWatchId);
    navWatchId = null;
    if (navTrafficTimer) { clearInterval(navTrafficTimer); navTrafficTimer = null; }
    window.__navCheckFasterRoute = null;
    // Navigating to a meeting point: bring the meetup sheet back afterwards.
    if (typeof GroupNavigation !== "undefined" && GroupNavigation.active) setTimeout(() => safeShow("group-nav-active", "flex"), 0);
    if (navDrListener) { document.removeEventListener("mu:dr-position", navDrListener); navDrListener = null; }
    navigationLayer.clearLayers();
    safeHide("premium-nav-ui");
    safeHide("nav-bottom-sheet");
    safeHide("turn-banner");
    safeHide("speed-dial");

    safeShow("map-tools", "flex");
    safeShow("search-container", "flex");
    safeShow("top-header", "flex");
    safeShow("bottom-info", "flex");
    safeShow("chat-toggle-btn", "flex");
    safeShow("memoryButton", "flex");

    if (myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16);

    navState.ready = false;
    navState.active = false;
    navState.destName = "";
    navState.remainingM = null;
    navState.etaSec = null;
    navState.nextManeuver = "";
    navState.routePath = null;
    document.dispatchEvent(new CustomEvent("mu:route-clear"));   // Step 7: hide the trip-energy card
    // Clear the saved nav state so a refresh doesn't resurrect a finished drive.
    if (typeof TripDB !== "undefined") TripDB.saveNavState({ active: false });

    if (!cancelled) SmartDrive.endTrip();     // emits mu:drive-state itself
    else { SmartDrive.releaseWakeLock(); emitDriveState(); }
}
