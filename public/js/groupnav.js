"use strict";

/* ============================================================================
   MapUnite client — js/groupnav.js
   ==============================================================================
   Group riding: group navigation to a shared point, group trip routes and
   the trip panel (fuel per rider), the meetup planner, the carpool planner
   and the trip gear checklist.

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

// ============================================================================
// GROUP NAVIGATION — manual "everyone routes to a tapped point" (unchanged)
// ============================================================================
const GroupNavigation = {
    active: false, destination: null, selectedMembers: [], layerGroup: L.layerGroup().addTo(map),
    lastFetchedCoords: {}, colors: ['#18d6a3', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6'], recalcTimer: null,
    // Phase 3: per-member road ETA ({distKm, timeMin, ts}) keyed like
    // selectedMembers ("me" for self) — the convoy loop's "falling behind"
    // signal reads this in meetup mode, as it reads tripRoadStats in trip mode.
    memberStats: {},

    openSetup() {
        const list = $("group-nav-friend-list");
        if (!list) return;
        list.innerHTML = "";
        const activeFriends = Object.values(friendData).filter(f => f.online !== false);
        if (activeFriends.length === 0) list.innerHTML = `<div style="color:var(--muted); font-size:11px;">No friends online.</div>`;
        else activeFriends.forEach(f => {
            list.innerHTML += `<label style="display:flex; align-items:center; gap:8px; font-size:13px; color:white; cursor:pointer;"><input type="checkbox" value="${f.id}" class="group-nav-cb"><img src="${escapeHTML(f.avatar)}" style="width:28px; height:28px; border-radius:50%; object-fit:cover;">${escapeHTML(f.name)}</label>`;
        });
        safeShow("group-nav-setup", "flex");
    },
    startSelection() {
        const cbs = document.querySelectorAll(".group-nav-cb:checked");
        if (cbs.length === 0) return showToast("Select at least 1 friend.");
        if (cbs.length > 7) return showToast("Select up to 7 friends only.");
        this.selectedMembers = ["me", ...Array.from(cbs).map(cb => cb.value)];
        safeHide("group-nav-setup");
        mapActionMode = 'group-nav';
        showToast("📍 Tap the map to set the common destination — or use “Find best meetup point” next time.", 5500);
    },
    async setDestination(latlng) {
        this.active = true; this.destination = latlng; this.layerGroup.clearLayers(); this.lastFetchedCoords = {}; this.memberStats = {};

        if (typeof TripDB !== "undefined" && typeof currentUser !== "undefined") {
            TripDB.saveSession(currentUser.name, { active: true, dest: latlng, members: this.selectedMembers });
        }

        L.marker(latlng, { icon: L.divIcon({ className: 'geofence-marker', html: '📍' }) }).bindTooltip("Group Destination", { permanent: true, direction: "top", className: "weather-badge" }).addTo(this.layerGroup);
        safeShow("group-nav-active", "flex");
        await this.calculateAll();
    },
    async calculateAll() {
        if (!this.active || !this.destination) return;
        const statsList = $("group-nav-stats-list");
        if (statsList) statsList.innerHTML = "<div style='color:var(--muted); font-size:11px; text-align:center;'>Calculating road paths...</div>";

        let statsHTML = "", validPaths = [];

        for (let i = 0; i < this.selectedMembers.length; i++) {
            const memberId = this.selectedMembers[i];
            const color = this.colors[i % this.colors.length];
            let name = "User", avatar = DEFAULT_AVATAR, coords = null;

            if (memberId === "me") {
                if (!myCoords) continue;
                name = "You"; avatar = currentUser.avatar; coords = myCoords;
            } else {
                const f = friendData[memberId];
                if (!f || f.online === false || !validCoord(f.lat, f.lng)) continue;
                name = f.name; avatar = f.avatar; coords = { lat: f.lat, lng: f.lng };
            }

            try {
                // Your own route asks for turn steps too (roadmap Section 7: maneuver text on OSRM paths).
                const data = await RoutePrefs.fetchRoute(`${OSRM_BASE}/route/v1/driving/${coords.lng},${coords.lat};${this.destination.lng},${this.destination.lat}?overview=full&geometries=geojson&alternatives=true${memberId === "me" ? "&steps=true" : ""}`);
                if (data.routes && data.routes.length > 0) {
                    const r = data.routes.reduce((a, b) => b.distance < a.distance ? b : a, data.routes[0]);
                    if (memberId === "me") this.myRoute = r;
                    const pathCoords = r.geometry.coordinates.map(c => [c[1], c[0]]);

                    this.layerGroup.eachLayer(l => { if (l.memberId === memberId) this.layerGroup.removeLayer(l); });

                    const poly = L.polyline(pathCoords, { color: color, weight: 5, opacity: 0.8, className: 'nav-path-animated' });
                    poly.memberId = memberId;
                    poly.addTo(this.layerGroup);
                    validPaths.push(poly);

                    const distKm = (r.distance / 1000).toFixed(1);
                    const timeMin = Math.max(1, Math.round(r.duration / 60));

                    statsHTML += `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:rgba(255,255,255,0.05); border-radius:10px; border-left:4px solid ${color};">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <img src="${escapeHTML(avatar)}" style="width:30px; height:30px; border-radius:50%; object-fit:cover;">
                            <span style="color:white; font-size:13px; font-weight:bold;">${escapeHTML(name)}</span>
                        </div>
                        <div style="text-align:right;">
                            <div style="color:white; font-size:13px; font-weight:bold;">${distKm} km</div>
                            <div style="color:var(--muted); font-size:11px;">${timeMin} min</div>
                        </div>
                    </div>`;

                    this.lastFetchedCoords[memberId] = { lat: coords.lat, lng: coords.lng };
                    this.memberStats[memberId] = { distKm: r.distance / 1000, timeMin, ts: Date.now() };
                } else {
                    statsHTML += `<div style="color:#ef4444; font-size:11px; padding:10px;">No road route for ${escapeHTML(name)}</div>`;
                }
            } catch (e) { /* one member's route failing shouldn't blank the whole panel */ }
        }
        if (statsList) { statsList.innerHTML = statsHTML; this.renderDirections(statsList); }
        if (validPaths.length > 0) map.fitBounds(L.featureGroup(validPaths).getBounds(), { padding: [40, 40] });
        if (window.ConvoyIntelligence) window.ConvoyIntelligence.evaluateAll("routes");
    },

    // "Your directions": OSRM maneuvers in plain words, plus full voice
    // turn-by-turn navigation to the meeting point on the same route.
    myRoute: null, directionsOpen: false,
    renderDirections(host) {
        const r = this.myRoute;
        const steps = r && r.legs && r.legs[0] && Array.isArray(r.legs[0].steps) ? r.legs[0].steps : [];
        if (!steps.length) return;
        const box = document.createElement("div");
        box.className = "gn-directions";
        const det = document.createElement("details");
        det.id = "group-nav-directions";
        det.open = this.directionsOpen;
        det.addEventListener("toggle", () => { this.directionsOpen = det.open; });
        const sum = document.createElement("summary");
        const turns = steps.filter((st) => st.maneuver && st.maneuver.type !== "depart" && st.maneuver.type !== "arrive").length;
        sum.textContent = `Your directions · ${turns} ${turns === 1 ? "turn" : "turns"}`;
        det.appendChild(sum);
        const ol = document.createElement("ol");
        steps.forEach((st, i) => {
            const li = document.createElement("li");
            const phrase = maneuverPhrase(st);
            const onto = st.name && st.maneuver && st.maneuver.type !== "arrive" && !/ onto | on /.test(phrase) ? ` onto ${st.name}` : "";
            li.textContent = `${phrase}${onto}`;
            if (Number.isFinite(st.distance) && st.distance > 0 && i < steps.length - 1) {
                const d = document.createElement("span"); d.className = "gn-dist"; d.textContent = ` · ${formatDistanceShort(st.distance)}`; li.appendChild(d);
            }
            ol.appendChild(li);
        });
        det.appendChild(ol);
        box.appendChild(det);
        const go = document.createElement("button");
        go.type = "button"; go.id = "group-nav-go-btn"; go.className = "btn-primary-nav btn-block";
        go.textContent = "▶ Navigate there"; go.title = "Voice turn-by-turn to the meeting point";
        go.addEventListener("click", () => {
            if (!this.myRoute || !this.destination) return;
            safeHide("group-nav-active");                          // the nav UI takes over; the meetup keeps running
            startSearchNavigation(this.destination.lat, this.destination.lng, "the meeting point", this.myRoute);
        });
        box.appendChild(go);
        host.appendChild(box);
    },
    onLiveUpdate() {
        if (!this.active || !this.destination) return;
        let needsRecalc = false;
        if (this.selectedMembers.includes("me") && myCoords) {
            const last = this.lastFetchedCoords["me"];
            if (!last || distanceKm(last.lat, last.lng, myCoords.lat, myCoords.lng) > 0.1) needsRecalc = true;
        }
        this.selectedMembers.forEach(id => {
            if (id !== "me" && friendData[id]) {
                const f = friendData[id]; const last = this.lastFetchedCoords[id];
                if (validCoord(f.lat, f.lng) && (!last || distanceKm(last.lat, last.lng, f.lat, f.lng) > 0.1)) needsRecalc = true;
            }
        });
        if (needsRecalc) {
            clearTimeout(this.recalcTimer);
            this.recalcTimer = setTimeout(() => this.calculateAll(), 3000);
        }
    },
    stop() {
        this.active = false; this.destination = null; this.selectedMembers = []; this.memberStats = {}; this.myRoute = null;
        this.layerGroup.clearLayers(); safeHide("group-nav-active");
        if (myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16);
    }
};

let groupRouteUpdateTimer = null;
let isFetchingGroupRoutes = false;

// ---- Trip fuel: every rider costed at their OWN km/L -----------------------
// The server sends each trip member's stated km/L to the trip's members only
// ("tripFuelProfiles"). Each rider's road leg is costed with the same model the
// live ride and the fuel-aware meetup use: rated km/L, worse below 40 km/h
// (stop-start) and above 60 km/h (drag), judged by the leg's average speed.
// A rider who never set a km/L is costed at the default and marked "*"; a
// rider in a Walk session burns nothing. Until profiles arrive, friends are
// shown at the default (marked) — never at YOUR km/L.
const TripFuel = {
    profiles: {}, tripId: null, defaultKmPerL: 18,

    legL(distanceM, durationSec, kmPerL) {
        if (!Number.isFinite(distanceM) || distanceM <= 0 || !Number.isFinite(kmPerL) || kmPerL <= 0) return 0;
        const km = distanceM / 1000;
        const v = Number.isFinite(durationSec) && durationSec > 0 ? km / (durationSec / 3600) : 40;
        let eff = kmPerL;
        if (v > 60) eff -= (v - 60) * 0.005 * kmPerL;
        else if (v < 40) eff -= (40 - v) * 0.004 * kmPerL;
        eff = Math.max(Math.min(5, kmPerL), eff);
        return km / eff;
    },

    profileFor(id) {
        if (typeof socket !== "undefined" && id === socket.id) {
            const walking = (window.currentTravelMode || "bike") === "walk";
            let stated = false;
            try { stated = localStorage.getItem("sd_mileage") !== null; } catch (e) { /* storage blocked */ }
            if (typeof BikeFuel !== "undefined" && BikeFuel.active()) stated = true;          // the bike from My bike
            const own = SmartDrive.ratedKmPerL();
            const km = stated && Number.isFinite(own) && own > 0 ? own : this.defaultKmPerL;
            return { kmPerL: walking ? null : km, assumed: !walking && !stated, walking };
        }
        const p = this.profiles[id];
        if (p && (p.walking || Number.isFinite(p.kmPerL))) return { kmPerL: p.walking ? null : p.kmPerL, assumed: Boolean(p.assumed), walking: Boolean(p.walking) };
        return { kmPerL: this.defaultKmPerL, assumed: true, walking: false };
    },

    // stats = tripRoadStats[id] ({ distM, durSec, ... }) -> { litres | null, profile }
    fuelFor(id, stats) {
        const profile = this.profileFor(id);
        if (!stats || !Number.isFinite(stats.distM)) return { litres: null, profile };
        return { litres: profile.walking ? 0 : this.legL(stats.distM, stats.durSec, profile.kmPerL), profile };
    },

    onProfiles(d) {
        if (!d || typeof d.profiles !== "object" || d.profiles === null) return;
        this.profiles = d.profiles;
        this.tripId = d.tripId || null;
        if (Number.isFinite(d.defaultKmPerL) && d.defaultKmPerL > 0) this.defaultKmPerL = d.defaultKmPerL;
        updateTripPanel();
    }
};

function triggerGroupRouteUpdate() {
    clearTimeout(groupRouteUpdateTimer);
    groupRouteUpdateTimer = setTimeout(() => updateGroupTripRoutes(), 1000);
}

async function updateGroupTripRoutes() {
    if (!currentTrip || isFetchingGroupRoutes) return;
    isFetchingGroupRoutes = true;

    const promises = currentTrip.members.map(async (member, index) => {
        const color = routeColors[index % routeColors.length];
        let coords = null;

        if (member.id === socket.id && myCoords) coords = myCoords;
        // Phase 4: radio-relayed riders count. validCoord: a rider with no fix
        // yet (or sharing "off") has lat/lng null — the old code asked OSRM
        // for a route from "null,null".
        else if (friendIsLive(friendData[member.id]) && validCoord(friendData[member.id].lat, friendData[member.id].lng)) coords = friendData[member.id];

        if (coords) {
            const last = tripLastFetchedCoords[member.id];
            if (last && distanceKm(last.lat, last.lng, coords.lat, coords.lng) < 0.1) return;

            try {
                const data = await RoutePrefs.fetchRoute(`${OSRM_BASE}/route/v1/driving/${coords.lng},${coords.lat};${currentTrip.lng},${currentTrip.lat}?geometries=geojson&alternatives=true`);

                if (data.routes && data.routes.length > 0) {
                    const r = data.routes.reduce((a, b) => b.distance < a.distance ? b : a, data.routes[0]);
                    const pathCoords = r.geometry.coordinates.map(c => [c[1], c[0]]);

                    tripRoutesLayer.eachLayer(l => { if (l.memberId === member.id) tripRoutesLayer.removeLayer(l); });

                    const poly = L.polyline(pathCoords, { color: color, weight: 5, opacity: 0.8, className: 'nav-path-animated' });
                    poly.memberId = member.id;
                    poly.addTo(tripRoutesLayer);

                    tripLastFetchedCoords[member.id] = { lat: coords.lat, lng: coords.lng };

                    const distKm = r.distance / 1000;
                    const timeMin = Math.max(1, Math.round(r.duration / 60));
                    // Raw metres/seconds kept so the fuel can be re-costed when a
                    // rider's km/L arrives or changes, without re-routing.
                    const stats = { dist: distKm.toFixed(1), time: timeMin, distM: r.distance, durSec: r.duration, ts: Date.now() };
                    const f = TripFuel.fuelFor(member.id, stats);
                    stats.fuel = f.litres === null ? '--' : f.litres.toFixed(2);
                    tripRoadStats[member.id] = stats;
                }
            } catch (e) { /* one member's fetch failing shouldn't stall the others */ }
        }
    });

    await Promise.all(promises);
    isFetchingGroupRoutes = false;
    // Fresh road ETAs are exactly what the convoy "falling behind" check
    // needs — evaluate before re-rendering so the badges are current.
    if (window.ConvoyIntelligence) window.ConvoyIntelligence.evaluateAll("routes");
    updateTripPanel();
}

function updateTripPanel() {
    if (!currentTrip) return;
    const list = $("trip-members-list"); if (!list) return;
    list.innerHTML = "";

    const isMember = currentTrip.members.some(m => m.id === socket.id);
    let totalGroupFuel = 0, anyFuel = false;
    const assumedNames = [];
    const avatarStyle = "width:32px; height:32px; border-radius:50%; object-fit:cover; vertical-align:middle; margin-right:8px; border:2px solid #34e0b4;";

    // Each rider's fuel at THEIR km/L (TripFuel); "*" = no km/L set, default assumed.
    const fuelCell = (id, name, stats) => {
        const { litres, profile } = TripFuel.fuelFor(id, stats);
        if (litres === null) return "⛽ -- L";
        stats.fuel = litres.toFixed(2);
        totalGroupFuel += litres; anyFuel = true;
        if (profile.walking) return "🚶 no fuel";
        if (profile.assumed) assumedNames.push(name);
        return `⛽ ${litres.toFixed(2)} L${profile.assumed ? '<span class="fuel-assumed" title="No km/L set — default assumed">*</span>' : ""}`;
    };

    if (myCoords && currentUser.name && isMember) {
        const stats = tripRoadStats[socket.id] || { dist: '--', time: '--', fuel: '--' };
        const fuel = fuelCell(socket.id, "You", stats);
        list.innerHTML += `<div class="trip-member" style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px;"><div><img src="${escapeHTML(currentUser.avatar)}" style="${avatarStyle}"> <b>You</b></div> <span style="text-align:right;">${stats.dist} km<br><small style="color:var(--muted)">${stats.time} min • ${fuel}</small></span></div>`;
    }

    Object.values(friendData).filter(f => friendIsLive(f) && currentTrip.members.some(m => m.id === f.id)).forEach(f => {
        const stats = tripRoadStats[f.id] || { dist: '--', time: '--', fuel: '--' };
        const fuel = fuelCell(f.id, f.name, stats);
        // Phase 3: convoy badge (stopped / behind / off route / no signal) —
        // text + tone dot, never color alone.
        const badge = window.ConvoyIntelligence ? window.ConvoyIntelligence.badgeFor(f.id) : null;
        let badgeHtml = badge ? `<br><span class="chip ${badge.tone}" style="margin-top:4px;">${escapeHTML(badge.text)}</span>` : "";
        // Phase 4: say HOW we know where they are when it isn't a live socket.
        if (f.online === false && f.via === "radio") badgeHtml += `<br><span class="chip warn" style="margin-top:4px;">📻 via radio · ${escapeHTML(agoText(f.fixAt || f.viaAt))}</span>`;
        else if (f.est) badgeHtml += `<br><span class="chip" style="margin-top:4px;">≈ estimated ±${escapeHTML(formatDistanceShort(f.accuracy || 0))}</span>`;
        list.innerHTML += `<div class="trip-member" style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px;"><div><img src="${escapeHTML(f.avatar)}" style="${avatarStyle}"> ${escapeHTML(f.name)}${badgeHtml}</div> <span style="text-align:right;">${stats.dist} km<br><small style="color:var(--muted)">${stats.time} min • ${fuel}</small></span></div>`;
    });

    // Total + how it's costed live OUTSIDE the scrolling member list (it was
    // the list's last row, so it scrolled out of view with 3+ riders).
    const summary = $("trip-fuel-summary");
    const note = anyFuel
        ? `Each rider at their own km/L, adjusted for average road speed — an estimate.${assumedNames.length ? ` * No km/L set for ${escapeHTML(assumedNames.join(", "))} — assumed ${TripFuel.defaultKmPerL} km/L.` : ""}`
        : "";
    const html = list.innerHTML
        ? `<div id="trip-fuel-total">Estimated group fuel: ${totalGroupFuel.toFixed(2)} L</div>` + (note ? `<div id="trip-fuel-note" class="field-hint">${note}</div>` : "")
        : "";
    if (summary) summary.innerHTML = html;
    else if (html) list.innerHTML += html;               // older index.html without the summary slot
}

// ============================================================================
// MEETUP PLANNER (new) — roadmap Section 11
// ============================================================================
// Inserts a candidate-search-and-score step BEFORE GroupNavigation.setDestination()
// is called, instead of that destination always coming from a manual tap. Reuses
// GroupNavigation's existing per-member routing/rendering once a point is chosen —
// additive, not a rewrite, per the roadmap's own framing.
const MeetupPlanner = {
    lastResult: null,
    strategy: "sum",

    init() {
        const openBtn = $("meetup-find-btn");
        if (openBtn) openBtn.addEventListener("click", () => this.compute());
        const seg = document.querySelector('[data-segment="meetupStrategy"]');
        if (seg) seg.addEventListener("segment", (e) => { this.strategy = e.detail.value; if (this.lastResult) this.renderCandidates(); });
        const closeBtn = $("meetup-results-close");
        if (closeBtn) closeBtn.addEventListener("click", () => safeHide("meetup-results-sheet"));
    },

    async compute() {
        if (GroupNavigation.selectedMembers.length === 0) {
            const cbs = document.querySelectorAll(".group-nav-cb:checked");
            if (cbs.length === 0) return showToast("Select at least 1 friend first.");
            GroupNavigation.selectedMembers = ["me", ...Array.from(cbs).map(cb => cb.value)];
        }
        const memberIds = GroupNavigation.selectedMembers;
        if (memberIds.filter((id) => id === "me" ? !!myCoords : (friendData[id] && validCoord(friendData[id].lat, friendData[id].lng))).length < 2) {
            return showToast("Need at least 2 located members (only Exact-sharing riders count).");
        }

        safeHide("group-nav-setup");
        const resultsList = $("meetup-results-list");
        if (resultsList) resultsList.innerHTML = `<div style="color:var(--muted); font-size:12px; text-align:center; padding:20px 0;">Scoring nearby meetup points by real road time…</div>`;
        safeShow("meetup-results-sheet", "flex");

        socket.emit("computeMeetup", { memberIds, strategy: this.strategy }, (res) => {
            if (!res || !res.ok) {
                if (resultsList) resultsList.innerHTML = `<div style="color:#ef4444; font-size:12px; text-align:center; padding:20px 0;">${escapeHTML(res?.reason === "need-at-least-2-located-members" ? "Need at least 2 located members." : "Couldn't compute a meetup point right now.")}</div>`;
                return;
            }
            this.lastResult = res;
            this.renderCandidates();
        });
    },

    renderCandidates() {
        const resultsList = $("meetup-results-list");
        if (!resultsList || !this.lastResult) return;
        const candidates = this.lastResult.rankings?.[this.strategy] || this.lastResult.results || [];
        if (candidates.length === 0) { resultsList.innerHTML = `<div style="color:var(--muted); font-size:12px; text-align:center;">No reachable candidate found.</div>`; return; }

        meetupLayer.clearLayers();
        resultsList.innerHTML = "";
        this.renderComparison(resultsList);
        const fuelMode = this.strategy === "fuel";
        if (fuelMode) {
            // Say what the estimate assumed, next to the numbers (roadmap Section 9).
            const a = this.lastResult.fuelAssumptions || {};
            const note = document.createElement("div");
            note.className = "meetup-fuel-note";
            let text = "⛽ Estimated fuel from road distance, average speed and each rider's km/L setting.";
            if (a.assumedFor && a.assumedFor.length) text += ` No km/L set for ${a.assumedFor.join(", ")} — assumed ${a.defaultKmPerL} km/L.`;
            if (a.walking && a.walking.length) text += ` ${a.walking.join(", ")} walking: no fuel.`;
            note.textContent = text;
            resultsList.appendChild(note);
        }
        const nameFor = (p) => (p.id === socket.id ? "You" : p.name);
        candidates.forEach((c, i) => {
            L.marker([c.lat, c.lng], { icon: L.divIcon({ className: 'geofence-marker', html: i === 0 ? '🏆' : '📍' }) })
                .bindTooltip(c.label, { permanent: false, direction: "top" }).addTo(meetupLayer);

            const card = document.createElement("div");
            card.className = "list-card" + (i === 0 ? " pick" : "");
            const worst = Math.round(c.maxSec / 60), total = Math.round(c.sumSec / 60);
            card.innerHTML = `<strong>${escapeHTML(c.label)}</strong>${c.kind === "venue" ? ' <span style="color:var(--muted);font-size:11px;">real venue</span>' : ''}
                <div style="margin-top:4px;color:var(--soft);font-size:12.5px;">
                    ${fuelMode && Number.isFinite(c.fuelL) ? `⛽ ${c.fuelL.toFixed(2)} L total · ${total} min` : this.strategy === "minimax" ? `Worst rider: ${worst} min` : `Total: ${total} min`} · Spread: ${Math.round(c.spreadSec / 60)} min
                </div>${fuelMode && Array.isArray(c.perMember) ? `<div class="meetup-fuel-split">${c.perMember.map((p) => `${escapeHTML(nameFor(p))} ${Number.isFinite(p.fuelL) ? p.fuelL.toFixed(2) : "?"} L`).join(" · ")}</div>` : ""}`;
            const pickBtn = document.createElement("button");
            pickBtn.type = "button"; pickBtn.className = "btn-primary-nav btn-block"; pickBtn.style.marginTop = "8px"; pickBtn.textContent = "Meet here";
            pickBtn.onclick = () => {
                safeHide("meetup-results-sheet");
                meetupLayer.clearLayers();
                GroupNavigation.setDestination({ lat: c.lat, lng: c.lng });
            };
            card.appendChild(pickBtn);
            resultsList.appendChild(card);
        });
        if (candidates.length) map.flyTo([candidates[0].lat, candidates[0].lng], 14);
    },

    setStrategy(value) {
        this.strategy = value;
        if (window.MapUnite && typeof window.MapUnite.setSegment === "function") window.MapUnite.setSegment("meetupStrategy", value);
        else document.querySelectorAll('[data-segment="meetupStrategy"] [data-value]').forEach((b) => b.setAttribute("aria-pressed", b.dataset.value === value ? "true" : "false"));
        if (this.lastResult) this.renderCandidates();
    },

    // Minimum-sum vs minimax vs least-fuel, side by side (roadmap Section 11,
    // Section 30 #15): the top pick of every strategy with the same three
    // numbers, so the trade-off is visible before choosing, not after.
    renderComparison(host) {
        const r = this.lastResult?.rankings;
        if (!r) return;
        const STRATS = [["sum", "Fastest"], ["minimax", "Fair to all"], ["fuel", "Least fuel"]];
        const rows = STRATS.filter(([k]) => Array.isArray(r[k]) && r[k][0]).map(([k, label]) => ({ k, label, c: r[k][0] }));
        if (rows.length < 2) return;
        const min = (sel) => Math.min(...rows.map((x) => sel(x.c)).filter(Number.isFinite));
        const bestTotal = min((c) => c.sumSec), bestWorst = min((c) => c.maxSec), bestFuel = min((c) => (Number.isFinite(c.fuelL) ? c.fuelL : NaN));
        const box = document.createElement("div");
        box.className = "meetup-compare";
        box.setAttribute("role", "group");
        box.setAttribute("aria-label", "Compare meetup strategies");
        const same = (a, b) => a && b && Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lng - b.lng) < 1e-6;
        let html = `<div class="mc-row mc-head" aria-hidden="true"><span>Strategy · pick</span><span>Total</span><span>Longest</span><span>Fuel</span></div>`;
        rows.forEach(({ k, label, c }) => {
            const tot = Math.round(c.sumSec / 60), worst = Math.round(c.maxSec / 60);
            const fuel = Number.isFinite(c.fuelL) ? `${c.fuelL.toFixed(2)} L` : "—";
            html += `<button type="button" class="mc-row${k === this.strategy ? " on" : ""}" data-strategy="${k}" aria-pressed="${k === this.strategy}">
                <span class="mc-name"><strong>${label}</strong><em>${escapeHTML(c.label)}</em></span>
                <span class="${c.sumSec === bestTotal ? "mc-best" : ""}">${tot} min</span>
                <span class="${c.maxSec === bestWorst ? "mc-best" : ""}">${worst} min</span>
                <span class="${Number.isFinite(c.fuelL) && c.fuelL === bestFuel ? "mc-best" : ""}">${fuel}</span>
            </button>`;
        });
        // One plain sentence on the main trade-off: fastest vs fair.
        const sum = r.sum?.[0], mm = r.minimax?.[0];
        let verdict = "";
        if (sum && mm) {
            if (same(sum, mm)) verdict = `Fastest and Fair to all agree on ${sum.label}.`;
            else {
                const cut = Math.round((sum.maxSec - mm.maxSec) / 60), extra = Math.round((mm.sumSec - sum.sumSec) / 60);
                verdict = `Fair to all shortens the longest ride by ${cut} min, for ${extra} min more travel in total.`;
            }
        }
        html += `<div class="mc-verdict">${escapeHTML(verdict)} Tap a row to switch.</div>`;
        box.innerHTML = html;
        box.querySelectorAll("[data-strategy]").forEach((b) => { b.onclick = () => this.setStrategy(b.dataset.strategy); });
        host.appendChild(box);
    }
};

// ============================================================================
// CARPOOL PLANNER (new) — roadmap Section 12
// ============================================================================
// Server does the actual ordering (OSRM /trip, falling back to greedy+2-opt)
// and the fuel split; this module is just pickup selection + rendering.
const CarpoolPlanner = {
    pickups: [],           // [{id, name, lat, lng}]
    destination: null,
    lastResult: null,
    objective: "shortest", // pickup order: "shortest" total | "fair" (least worst detour)
    splitMode: "leg",      // fuel split: "leg" (equal per leg aboard) | "shapley"

    init() {
        const openBtn = $("carpool-open-btn");
        if (openBtn) openBtn.addEventListener("click", () => this.openSetup());
        const closeBtn = $("carpool-close-btn");
        if (closeBtn) closeBtn.addEventListener("click", () => this.closeSetup());
        const destBtn = $("carpool-pick-dest-btn");
        if (destBtn) destBtn.addEventListener("click", () => {
            showToast("🚗 Tap the map to set the drop-off point.", 4000);
            mapActionMode = "carpool-dest";
            safeHide("carpool-modal");
        });
        const runBtn = $("carpool-run-btn");
        if (runBtn) runBtn.addEventListener("click", () => this.compute());
        // Order changes the route -> re-plan; split is presentation -> re-render.
        const ord = document.querySelector('[data-segment="carpoolOrder"]');
        if (ord) ord.addEventListener("segment", (e) => { this.objective = e.detail.value; if (this.lastResult) this.compute(); });
        const spl = document.querySelector('[data-segment="carpoolSplit"]');
        if (spl) spl.addEventListener("segment", (e) => { this.splitMode = e.detail.value; if (this.lastResult) this.render(this.lastResult); });
    },

    openSetup() {
        const list = $("carpool-riders");
        if (!list) return;
        list.innerHTML = "";
        const online = Object.values(friendData).filter(f => f.online !== false && validCoord(f.lat, f.lng));
        if (online.length === 0) list.innerHTML = `<div style="color:var(--muted); font-size:11px;">No located friends online.</div>`;
        else online.forEach(f => {
            list.innerHTML += `<label style="display:flex; align-items:center; gap:8px; font-size:13px; color:white; cursor:pointer;"><input type="checkbox" value="${f.id}" class="carpool-cb"><img src="${escapeHTML(f.avatar)}" style="width:26px;height:26px;border-radius:50%;object-fit:cover;">${escapeHTML(f.name)}</label>`;
        });
        const destLbl = $("carpool-dest-label");
        if (destLbl) destLbl.textContent = this.destination ? `${this.destination.lat.toFixed(4)}, ${this.destination.lng.toFixed(4)}` : "Not set";
        safeShow("carpool-modal", "flex");
    },
    closeSetup() { safeHide("carpool-modal"); mapActionMode = null; },

    setDestination(latlng) {
        this.destination = latlng;
        carpoolLayer.clearLayers();
        L.marker(latlng, { icon: L.divIcon({ className: 'geofence-marker', html: '🏁' }) }).bindTooltip("Carpool drop-off", { permanent: true, direction: "top" }).addTo(carpoolLayer);
        showToast("🏁 Drop-off set.");
        this.openSetup();
    },

    compute() {
        if (!myCoords) return showToast("Waiting for your GPS fix…");
        if (!this.destination) return showToast("Set a drop-off point first.");
        const cbs = document.querySelectorAll(".carpool-cb:checked");
        if (cbs.length === 0) return showToast("Select at least 1 rider to pick up.");

        this.pickups = Array.from(cbs).map((cb) => {
            const f = friendData[cb.value];
            return { id: f.id, name: f.name, lat: f.lat, lng: f.lng };
        });

        const kmPerL = parseFloat($("carpool-kmpl")?.value) || SmartDrive.ratedKmPerL() || 15;
        const pricePerL = parseFloat($("carpool-price")?.value) || 0;

        const resultsBox = $("carpool-results");
        if (resultsBox) resultsBox.innerHTML = `<div style="color:var(--muted);font-size:12px;text-align:center;">Ordering pickups…</div>`;
        safeShow("carpool-modal", "flex");

        socket.emit("carpoolOptimize", {
            start: myCoords, destination: this.destination, pickups: this.pickups, kmPerL, fuelPricePerL: pricePerL,
            avoid: RoutePrefs.classes(),           // the driver's avoid-highways/tolls setting
            objective: this.objective
        }, (res) => {
            if (!res || !res.ok) { if (resultsBox) resultsBox.innerHTML = `<div style="color:#ef4444;font-size:12px;">Couldn't plan the carpool right now.</div>`; return; }
            this.lastResult = res;
            this.render(res);
        });
    },

    // Route-options outcome, only when the driver asked to avoid something.
    avoidLine(a) {
        if (!a || !Array.isArray(a.requested) || !a.requested.length) return "";
        const missed = a.requested.filter((c) => !(a.applied || []).includes(c));
        const text = missed.length === 0 ? `🛣️ Avoiding ${RoutePrefs.describe(a.requested)}`
            : (a.applied || []).length ? `🛣️ Avoided ${RoutePrefs.describe(a.applied)} — couldn't also avoid ${RoutePrefs.describe(missed)}`
                : `🛣️ Couldn't avoid ${RoutePrefs.describe(missed)} on this plan`;
        return `<div class="carpool-avoid${missed.length ? " warn" : ""}">${escapeHTML(text)}</div>`;
    },

    render(res) {
        carpoolLayer.clearLayers();
        if (myCoords) L.marker([myCoords.lat, myCoords.lng], { icon: L.divIcon({ className: 'geofence-marker', html: '🚗' }) }).addTo(carpoolLayer);
        if (res.geometry && Array.isArray(res.geometry.coordinates)) {
            const path = res.geometry.coordinates.map(c => [c[1], c[0]]);
            const line = L.polyline(path, { color: '#f59e0b', weight: 6, opacity: 0.85, className: 'nav-path-animated' }).addTo(carpoolLayer);
            map.fitBounds(line.getBounds(), { padding: [40, 40] });
        }
        res.pickupOrder.forEach((p, i) => {
            L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'geofence-marker', html: `${i + 1}️⃣` }) }).bindTooltip(p.name, { permanent: false }).addTo(carpoolLayer);
        });
        if (this.destination) L.marker([this.destination.lat, this.destination.lng], { icon: L.divIcon({ className: 'geofence-marker', html: '🏁' }) }).addTo(carpoolLayer);

        const resultsBox = $("carpool-results");
        if (!resultsBox) return;
        const order = res.pickupOrder.map((p) => escapeHTML(p.name)).join(" → ");
        let html = `<div class="list-card"><strong>Pickup order</strong><div style="margin-top:4px;color:var(--soft);font-size:12.5px;">You → ${order} → Drop-off</div>
            <div style="margin-top:6px;color:var(--soft);font-size:12.5px;">${res.totalDistanceKm} km${res.totalDurationMin != null ? ` · ${res.totalDurationMin} min` : ''}${res.approximate ? ' · <span style="color:var(--c-warn);">approximate ordering</span>' : ''}</div>${this.avoidLine(res.avoid)}</div>`;
        // Order comparison (shortest vs fairest), when the server had a road matrix.
        const o = res.orders;
        if (o && o.shortest && o.fairest) {
            const chosen = res.objective === "fair" ? o.fairest : o.shortest, other = res.objective === "fair" ? o.shortest : o.fairest;
            const worstName = (plan) => { const w = plan.detours.slice().sort((a, b) => b.min - a.min)[0]; return w && w.min > 0 ? ` (${escapeHTML(w.name)})` : ""; };
            const same = o.shortest.pickupOrder.map((p) => p.id).join() === o.fairest.pickupOrder.map((p) => p.id).join();
            html += `<div class="list-card carpool-orders"><strong>${res.objective === "fair" ? "Fairest for riders" : "Shortest total"}</strong>
                <div class="co-line">Longest extra time in the car: <b>${chosen.worstDetourMin} min</b>${worstName(chosen)} · total ${chosen.totalMin} min</div>
                ${same ? `<div class="co-line co-muted">The shortest order is also the fairest here.</div>`
                    : `<div class="co-line co-muted">${res.objective === "fair" ? "Shortest" : "Fairest"} order: worst extra ${other.worstDetourMin} min · total ${other.totalMin} min</div>`}</div>`;
        }
        const useShapley = this.splitMode === "shapley" && res.shapley;
        const drv = useShapley ? res.shapley.driver : res.driver;
        const priced = res.assumptions.fuelPricePerL > 0;
        html += `<div class="list-card"><strong>You (driver)</strong><div style="margin-top:4px;color:var(--soft);font-size:12.5px;">${res.driver.distanceKm} km · ⛽ ${Number(drv.fuelL).toFixed(2)} L${priced ? ` · ${Number(drv.cost).toFixed(2)}` : ''}</div></div>`;
        res.riders.forEach((r) => {
            const sh = useShapley ? res.shapley.riders.find((x) => x.id === r.id) : null;
            const fuel = sh ? sh.fuelL : r.fuelL, cost = sh ? sh.cost : r.cost;
            const alone = sh && Number.isFinite(sh.aloneL) ? ` <span class="co-muted">(alone: ${sh.aloneL.toFixed(2)} L)</span>` : "";
            html += `<div class="list-card"><strong>${escapeHTML(r.name)}</strong><div style="margin-top:4px;color:var(--soft);font-size:12.5px;">${r.distanceKm} km ridden · ⛽ ${Number(fuel).toFixed(2)} L share${priced ? ` · ${Number(cost).toFixed(2)}` : ''}${alone}</div></div>`;
        });
        html += `<p class="field-hint">${escapeHTML(useShapley ? res.shapley.note : res.assumptions.note)}${this.splitMode === "shapley" && !res.shapley ? " (Shapley needs the road matrix — shown per leg this time.)" : ""}</p>`;
        resultsBox.innerHTML = html;
    }
};

// ==========================================
// TRIP GEAR CHECKLIST
// ==========================================
const TripChecklist = {
    items: JSON.parse(localStorage.getItem("koraput_gear")) || {
        "Action Camera & Mounts": false, "Powerbanks & Extra Batteries": false,
        "Vehicle & ID Documents": false, "Trekking Shoes": false, "First Aid & Meds": false
    },
    toggle(key) { this.items[key] = !this.items[key]; localStorage.setItem("koraput_gear", JSON.stringify(this.items)); this.render(); },
    render() {
        const container = $("trip-checklist-container");
        if (!container) return;
        container.innerHTML = `<h4 style="margin:5px 0; color:#18d6a3; font-size:13px;">🎒 Trip Gear Checklist</h4>`;
        Object.keys(this.items).forEach(item => {
            const row = document.createElement("label");
            row.style.cssText = "display:flex; align-items:center; gap:8px; font-size:12px; color:white; cursor:pointer; margin-bottom:4px;";
            const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = Boolean(this.items[item]); cb.style.accentColor = "#18d6a3";
            cb.addEventListener("change", () => this.toggle(item));
            const span = document.createElement("span"); span.textContent = item;
            if (this.items[item]) span.style.cssText = "text-decoration:line-through; color:#94a3b8;";
            row.appendChild(cb); row.appendChild(span); container.appendChild(row);
        });
    }
};
window.TripChecklist = TripChecklist;
