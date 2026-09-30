"use strict";

/* ============================================================================
   MapUnite client — js/controls.js
   ==============================================================================
   Map controls and tools (layers, measure, geofence, trip start, meetup,
   carpool entry points) and the join screen.

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

function setupBasicControlsSafe() {
    const locBtn = $("my-location-btn");
    if (locBtn) locBtn.onclick = () => {
        if (myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16, { animate: true, duration: .8 });
        else showToast("📍 Waiting for GPS location...");
    };

    // "Follow me" (was a compass whose "reset bearing" did nothing — this
    // map never rotates). On: the map re-centres on every new position (GPS
    // or tunnel-mode estimate). Dragging the map turns it off, as in any
    // navigation app. Navigation keeps its own camera, so it's skipped there.
    const compassBtn = $("compass-btn");
    if (compassBtn) compassBtn.onclick = () => {
        setFollowMe(!followMe);
        if (followMe && myCoords) map.flyTo([myCoords.lat, myCoords.lng], Math.max(map.getZoom(), 16), { animate: true, duration: .8 });
        else if (followMe) showToast("📍 Waiting for GPS location...");
    };
    map.on("dragstart", () => { if (followMe) setFollowMe(false, { quiet: true }); });

    // Tool rail: fade the bottom edge while more buttons are scrolled out of view.
    const rail = $("map-tools");
    if (rail) {
        const updateRailFade = () => rail.classList.toggle("more-below", rail.scrollTop + rail.clientHeight < rail.scrollHeight - 4);
        rail.addEventListener("scroll", updateRailFade, { passive: true });
        window.addEventListener("resize", updateRailFade, { passive: true });
        setTimeout(updateRailFade, 0);
    }

    const styleBtn = $("map-style-btn");
    const sm = $("map-style-menu");
    if (styleBtn && sm) {
        styleBtn.onclick = e => {
            e.stopPropagation();
            const willOpen = sm.style.display !== "flex";
            sm.style.display = willOpen ? "flex" : "none";
            styleBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
        };
        sm.onclick = e => {
            const b = e.target.closest("[data-style]"); if (!b) return;
            const s = b.dataset.style;
            [satelliteLayer, streetLayer, darkLayer, terrainLayer].forEach(l => {
                if (map.hasLayer(l)) map.removeLayer(l);
            });
            const layers = { satellite: satelliteLayer, street: streetLayer, dark: darkLayer, terrain: terrainLayer };
            if (layers[s]) layers[s].addTo(map);
            // [data-style] only: the menu also holds the memory-heatmap checkbox item.
            document.querySelectorAll("#map-style-menu button[data-style]").forEach(x => { const active = x.dataset.style === s; x.classList.toggle("active", active); x.setAttribute("aria-checked", active ? "true" : "false"); });
            safeHide("map-style-menu");
            document.dispatchEvent(new CustomEvent("mu:map-style", { detail: { style: s } }));
        };
    }


    window.addEventListener("offline", () => showToast("📶 You are offline. Data saved locally."));
    window.addEventListener("online", () => {
        showToast("📶 Back online!");
        if (offlineMessageQueue.length) {
            offlineMessageQueue.forEach(msg => socket.emit("chatMessage", msg));
            offlineMessageQueue = [];
        }
        if (typeof offlineMemoryQueue !== "undefined" && offlineMemoryQueue.length) {
            offlineMemoryQueue.forEach(mem => socket.emit("uploadMemoryPhoto", mem));
            offlineMemoryQueue = [];
        }
    });

    // Battery: don't run the chat's typing-indicator/presence chatter while
    // the tab is hidden (roadmap Section 24).
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") { clearTimeout(typingTimerRef.id); socket.emit("typing", false); }
    });
}

function clearActiveToolButtons(except) {
    ["measure-btn", "geofence-btn", "trip-btn", "group-nav-btn"].forEach((id) => { if (id !== except) { const b = $(id); if (b) b.classList.remove("active-tool"); } });
}

function setupAdvancedToolsSafe() {
    const mb = $("measure-btn");
    if (mb) mb.onclick = () => {
        mapActionMode = mapActionMode === 'measure' ? null : 'measure';
        mb.classList.toggle("active-tool", mapActionMode === 'measure');
        clearActiveToolButtons("measure-btn");
        if (mapActionMode !== 'measure') {
            measureLayer.clearLayers();
            measurePoints = [];
            const mr = $("measure-result-panel"); if (mr) mr.style.display = "none";
        }
        else showToast("📍 Tap two points on the map to measure road distance");
    };

    const gb = $("geofence-btn");
    if (gb) gb.onclick = () => {
        geoClickCount++;
        if (geoClickCount === 3) {
            clearTimeout(geoClickTimer); geoClickCount = 0; renderGeofenceList(); return;
        }
        clearTimeout(geoClickTimer);
        geoClickTimer = setTimeout(() => {
            geoClickCount = 0; mapActionMode = mapActionMode === 'geofence' ? null : 'geofence';
            gb.classList.toggle("active-tool", mapActionMode === 'geofence');
            clearActiveToolButtons("geofence-btn");
            if (mapActionMode === 'geofence') showToast("⭕ Tap map to set Geofence. (Tap button 3 times to view/delete)");
        }, 900);
    };

    const tb = $("trip-btn");
    if (tb) tb.onclick = () => {
        mapActionMode = mapActionMode === 'trip' ? null : 'trip';
        tb.classList.toggle("active-tool", mapActionMode === 'trip');
        clearActiveToolButtons("trip-btn");
        if (mapActionMode === 'trip') showToast("🚗 Tap the map to set Group Trip Destination");
    };

    const gnb = $("group-nav-btn");
    if (gnb) gnb.onclick = () => {
        mapActionMode = mapActionMode === 'group-nav' ? null : 'group-nav';
        gnb.classList.toggle("active-tool", mapActionMode === 'group-nav');
        clearActiveToolButtons("group-nav-btn");
        if (mapActionMode === 'group-nav') { if (typeof GroupNavigation !== 'undefined') GroupNavigation.openSetup(); }
        else safeHide("group-nav-setup");
    };

    const gNCB = $("group-nav-close-btn");
    if (gNCB) gNCB.onclick = () => { safeHide("group-nav-setup"); mapActionMode = null; const btn = $("group-nav-btn"); if (btn) btn.classList.remove("active-tool"); };

    const gNNB = $("group-nav-next-btn");
    if (gNNB) gNNB.onclick = () => { if (typeof GroupNavigation !== 'undefined') GroupNavigation.startSelection(); };

    const gNSB = $("group-nav-stop-btn");
    if (gNSB) gNSB.onclick = () => { if (typeof GroupNavigation !== 'undefined') GroupNavigation.stop(); };

    map.on('click', (e) => {
        if (mapActionMode === 'measure') {
            measurePoints.push(e.latlng);
            L.circleMarker(e.latlng, { color: '#f59e0b', radius: 5, fillOpacity: 1 }).addTo(measureLayer);

            if (measurePoints.length === 2) {
                const p1 = measurePoints[0], p2 = measurePoints[1];
                showToast("📏 Calculating road distance...", 2000);

                RoutePrefs.fetchRoute(`${OSRM_BASE}/route/v1/driving/${p1.lng},${p1.lat};${p2.lng},${p2.lat}?overview=full&geometries=geojson&alternatives=true`)
                    .then(data => {
                        measureLayer.clearLayers();
                        if (data.routes && data.routes.length > 0) {
                            const r = data.routes.reduce((a, b) => b.distance < a.distance ? b : a, data.routes[0]);
                            const coords = r.geometry.coordinates.map(c => [c[1], c[0]]);
                            L.polyline(coords, { color: '#f59e0b', weight: 6, className: 'nav-path-animated' }).addTo(measureLayer);
                            L.marker(p1, { icon: L.divIcon({ className: 'measure-point', html: 'A', iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(measureLayer);
                            L.marker(p2, { icon: L.divIcon({ className: 'measure-point', html: 'B', iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(measureLayer);

                            const distKm = (r.distance / 1000).toFixed(2);
                            const timeMin = Math.max(1, Math.round(r.duration / 60));

                            let panel = $("measure-result-panel");
                            if (!panel) {
                                panel = document.createElement("div");
                                panel.id = "measure-result-panel";
                                panel.style.cssText = "position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:4500;background:rgba(10,17,28,.96);border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:12px 16px;color:#fff;box-shadow:0 15px 40px rgba(0,0,0,.45);font-size:13px;text-align:center;min-width:220px;";
                                document.body.appendChild(panel);
                            }
                            panel.innerHTML = `<b style="color:#f59e0b">📏 Shortest road route</b><br><strong>${distKm} km</strong> &nbsp;•&nbsp; <strong>${timeMin} min</strong>`;
                            panel.style.display = "block";
                            showToast(`📏 Shortest: ${distKm} km • ⏱️ ${timeMin} min`, 5000);
                        } else showToast("❌ Road route unavailable. Try again.");
                    }).catch(() => showToast("❌ Road route unavailable. Try again."));
            }
        }
        else if (mapActionMode === 'geofence') {
            const name = prompt("Enter Geofence Name:");
            if (name && name.trim()) {
                const radius = Number(prompt("Enter Radius in meters (10 to 50000):", "500"));
                if (Number.isFinite(radius) && radius >= 10 && radius <= 50000) { socket.emit("addGeofence", { name: name.trim(), lat: e.latlng.lat, lng: e.latlng.lng, radius: radius }); showToast(`⭕ Geofence created!`); }
            }
            mapActionMode = null; const gb2 = $("geofence-btn"); if (gb2) gb2.classList.remove("active-tool");
        }
        else if (mapActionMode === 'trip') {
            const name = prompt("Enter Trip Destination Name:");
            if (name && name.trim()) {
                // Batch 2: "Trips I start are visible to" (Settings → Circles).
                const circleId = Circles.tripAudience();
                const circle = circleId ? Circles.list.find((c) => c.id === circleId) : null;
                socket.emit("startTrip", { name: name.trim(), lat: e.latlng.lat, lng: e.latlng.lng, circleId });
                showToast(circle ? `🚗 Trip started — only “${circle.name}” can see and join it.` : `🚗 Trip started!`);
            }
            mapActionMode = null; const tb2 = $("trip-btn"); if (tb2) tb2.classList.remove("active-tool");
        }
        else if (mapActionMode === 'memory') {
            if (pendingMemoryImage) {
                const payload = { name: currentUser.name, lat: e.latlng.lat, lng: e.latlng.lng, image: pendingMemoryImage, time: new Date().toISOString() };
                if (navigator.onLine) { socket.emit("uploadMemoryPhoto", payload); showToast("✅ Memory pinned successfully!"); }
                else { offlineMemoryQueue.push(payload); showToast("📶 Offline: Memory saved. Will sync when reconnected."); }
            }
            mapActionMode = null; pendingMemoryImage = null;
        }
        else if (mapActionMode === 'group-nav') {
            if (typeof GroupNavigation !== 'undefined') {
                GroupNavigation.setDestination(e.latlng);
                mapActionMode = null;
            }
        }
        else if (mapActionMode === 'carpool-dest') {
            CarpoolPlanner.setDestination(e.latlng);
            mapActionMode = null;
        }
    });

    socket.on("loadGeofences", fences => {
        currentGeofences = fences;
        p4LayerGroup.eachLayer(l => { if (l.options?.isGeofence) map.removeLayer(l); });
        fences.forEach(f => {
            L.circle([f.lat, f.lng], { radius: f.radius, color: "#8b5cf6", weight: 2, fillOpacity: 0.1, isGeofence: true }).addTo(p4LayerGroup);
            L.marker([f.lat, f.lng], { icon: L.divIcon({ className: 'geofence-marker', html: '📍' }), isGeofence: true }).bindTooltip(f.name, { permanent: true, direction: "top", className: "weather-badge" }).addTo(p4LayerGroup);
        });
        const geoModal = $("geofence-list-modal"); if (geoModal && geoModal.style.display === "flex") renderGeofenceList();
    });

    socket.on("tripFuelProfiles", (d) => TripFuel.onProfiles(d));
    socket.on("tripError", (d) => {
        const why = { "already-in-trip": "You're already in a trip — leave it first.", "not-in-circle": "You're not in that circle any more — pick another audience in Settings." }[d?.reason];
        showToast(why || "Couldn't start the trip.", 5000);
    });
    socket.on("tripData", trip => {
        if (!trip || !currentTrip || trip.id !== currentTrip.id) TripFuel.profiles = {};   // never carry one trip's profiles into another
        // Batch 2: only a trip we were IN ending may end our recorded ride —
        // a trip we were merely offered disappearing must not stop a solo drive.
        const wasMember = Boolean(currentTrip && currentTrip.members && currentTrip.members.some((m) => m.id === socket.id));
        currentTrip = trip;
        if (tripMarker) { map.removeLayer(tripMarker); tripMarker = null; }
        if (trip) {
            safeShow("trip-panel", "flex");
            const tt = $("trip-title"); if (tt) tt.textContent = trip.circleName ? `Trip to ${trip.name} · ${trip.circleName}` : `Trip to ${trip.name}`;
            tripMarker = L.marker([trip.lat, trip.lng], { icon: L.divIcon({ className: 'geofence-marker', html: '🏁' }) }).addTo(map);

            const isMember = trip.members.some(m => m.id === socket.id);
            const isHost = trip.hostId === socket.id;
            const actionBtn = $("trip-action-btn");

            if (actionBtn) {
                if (isHost) {
                    actionBtn.textContent = "End Trip"; actionBtn.style.color = "#ef4444"; actionBtn.style.background = "rgba(239, 68, 68, 0.2)";
                    actionBtn.onclick = () => { if (typeof SmartDrive != "undefined" && SmartDrive.trip.active) SmartDrive.endTrip(); socket.emit("leaveTrip"); };
                } else if (isMember) {
                    actionBtn.textContent = "Leave Trip"; actionBtn.style.color = "#f59e0b"; actionBtn.style.background = "rgba(245, 158, 11, 0.2)";
                    actionBtn.onclick = () => { if (typeof SmartDrive != "undefined" && SmartDrive.trip.active) SmartDrive.endTrip(); socket.emit("leaveTrip"); };
                } else {
                    actionBtn.textContent = "Join Trip"; actionBtn.style.color = "#10b981"; actionBtn.style.background = "rgba(16, 185, 129, 0.2)"; actionBtn.onclick = () => socket.emit("joinTrip", { tripId: trip.id });
                }
            }
            if (typeof SmartDrive !== "undefined" && isMember && !SmartDrive.trip.active) SmartDrive.startTrip();
            if (typeof triggerGroupRouteUpdate === 'function') triggerGroupRouteUpdate();
            if (window.TripChecklist) window.TripChecklist.render();
        } else {
            if (wasMember && typeof SmartDrive !== "undefined" && SmartDrive.trip.active) SmartDrive.endTrip();
            tripRoutesLayer.clearLayers(); tripRoadStats = {}; safeHide("trip-panel");
        }
    });
}

function setupJoin() {
    if (currentUser.name) {
        safeHide("join-screen");
        const hAv = $("header-avatar");
        if (hAv) { hAv.style.display = "block"; hAv.src = currentUser.avatar; }
        socket.emit("profileReady", { name: currentUser.name, avatar: currentUser.avatar, deviceId: DeviceIdentity.id, deviceToken: DeviceIdentity.token });
    }

    const jForm = $("join-form") || document.querySelector("form");

    const handleJoin = (e) => {
        if (e) e.preventDefault();

        const nInp = $("nameInput") || document.querySelector("input[type='text']");
        if (nInp && nInp.value.trim()) currentUser.name = cleanName(nInp.value);
        else currentUser.name = "Explorer";

        localStorage.setItem("koraput_name", currentUser.name);
        if (typeof TripDB !== "undefined") TripDB.saveSession(currentUser.name, null);

        const aInp = $("avatarInput") || document.querySelector("input[type='file']");
        const f = aInp ? aInp.files?.[0] : null;

        if (f) {
            const r = new FileReader();
            r.onload = () => {
                currentUser.avatar = r.result;
                localStorage.setItem("koraput_avatar", r.result);
                done();
            };
            r.readAsDataURL(f);
        } else {
            done();
        }
    };

    if (jForm) jForm.addEventListener("submit", handleJoin);

    function done() {
        safeHide("join-screen");
        const hAv2 = $("header-avatar");
        if (hAv2) { hAv2.style.display = "block"; hAv2.src = currentUser.avatar; }
        socket.emit("profileReady", { name: currentUser.name, avatar: currentUser.avatar, deviceId: DeviceIdentity.id, deviceToken: DeviceIdentity.token });
        if (typeof updateOnlineUI === 'function') updateOnlineUI();
    }
}
