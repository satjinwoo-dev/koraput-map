"use strict";

/* ============================================================================
   MapUnite client — js/presence.js
   ==============================================================================
   Presence: the socket connection lifecycle and identity handshake, friend
   markers and the online list, the profile popup, geofence alerts and the
   geofence list, and follow-me.

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

// ============================================================================
// SOCKET CONNECTION LIFECYCLE + IDENTITY HANDSHAKE
// ============================================================================
socket.on("connect", () => {
    if (currentUser.name) {
        socket.emit("profileReady", { name: currentUser.name, avatar: currentUser.avatar, deviceId: DeviceIdentity.id, deviceToken: DeviceIdentity.token });
    }
    if (offlineMessageQueue.length > 0) {
        offlineMessageQueue.forEach(msg => socket.emit("chatMessage", msg));
        offlineMessageQueue = [];
        showToast("📶 Back online! Sent queued messages.");
    }
    if (offlineMemoryQueue.length > 0) {
        offlineMemoryQueue.forEach(mem => socket.emit("uploadMemoryPhoto", mem));
        offlineMemoryQueue = [];
        showToast("📶 Back online! Pinned queued memories.");
    }
});

socket.on("profileAccepted", (data) => {
    if (data?.deviceToken) DeviceIdentity.storeIssuedToken(data.deviceToken);
    // Batch 2: privacy lives on the server per device (mode, audience, trip-only).
    if (data?.privacy) PrivacyControls.apply(data.privacy);
    else if (data?.sharingMode) PrivacyControls.setMode(data.sharingMode, { silent: true });
    if (data?.ownerKey) myOwnerKey = data.ownerKey;    // used to tell "my own geofence" apart, see renderGeofenceList()
    if (Number.isFinite(data?.tripRetentionDays)) TripAnalytics.retentionDays = data.tripRetentionDays;
    // The server only persists trips for a VERIFIED device, so this — not
    // "connect" — is the moment queued rides can be uploaded.
    TripAnalytics.profileVerified = true;
    TripAnalytics.flushPending();
    SmartDrive.shareMileage();                          // fuel-aware meetup needs each rider's own km/L
    Circles.onProfile();                                // Batch 2: circle list + pending invite link
    // Fixed: a fix taken before the socket was identified was dropped by the
    // server (unknown socket), so a rider standing still showed NO position
    // to the squad until they moved. Re-send the current fix now.
    if (myCoords && !myCoords.est && validCoord(myCoords.lat, myCoords.lng)) {
        emitLocation({ lat: myCoords.lat, lng: myCoords.lng, alt: myCoords.alt ?? null, speedKmh: myCoords.speedKmh || 0, weather: myWeather });
    }
    // Phase 4: an SOS pressed with no connection goes out NOW, with the
    // current position. Not via Socket.IO's send buffer: that flushes on
    // reconnect BEFORE profileReady, and the server drops an SOS from a
    // socket it doesn't know yet — the emergency would be silently lost.
    if (pendingSos) {
        const age = Date.now() - pendingSos.queuedAt;
        pendingSos = null;
        if (age < 30 * 60 * 1000 && myCoords) {
            socket.emit("sos-alert", { name: currentUser.name, lat: myCoords.lat, lng: myCoords.lng, alt: myCoords.alt ?? null });
            showToast("🚨 Back online — your queued SOS has now been sent to everyone online.", 8000);
            islandShow({ id: "sos", kind: "sos", title: "Queued SOS sent", sub: "Back online — your friends were alerted", ttl: 8000 });
        }
    }
});

socket.on("profileRejected", () => {
    console.warn("[identity] Server rejected our device token — minting a new identity.");
    DeviceIdentity.resetAfterRejection();
    socket.emit("profileReady", { name: currentUser.name, avatar: currentUser.avatar, deviceId: DeviceIdentity.id, deviceToken: null });
    showToast("Your device identity was reset — you'll appear as a fresh rider.", 5000);
});

socket.on("locationRejected", (data) => {
    if (data?.reason === "implausible-jump") console.warn("[gps] Server flagged an implausible jump; strike", data.strikes);
});

socket.on("sharingChanged", (data) => { if (data?.mode) PrivacyControls.setMode(data.mode, { silent: true }); });

socket.on("geofenceAlert", (data) => {
    const action = data.type === "enter" ? "entered" : "left";
    showToast(`🔔 ${data.user} has ${action} ${data.fence}!`);
    // StatusIsland renders via textContent — pass raw strings (escaping here
    // made "Tom & Jerry" display as "Tom &amp; Jerry").
    islandShow({ id: "geo", kind: "geofence", title: String(data.fence || ""), sub: `${data.user || "Someone"} ${action}`, ttl: 5500 });
    voiceAnnounce(`${data.user || "Someone"} ${action} ${data.fence || "a geofence"}.`, { priority: 40, key: `geo-${data.user}-${data.fence}-${data.type}`, cooldownMs: 60000, category: "hazard", drivingOnly: true });
});

function updateFriendBadges() {
    Object.keys(friendMarkers).forEach(id => {
        const f = friendData[id], m = friendMarkers[id]; if (!f || !m) return;
        let text;
        if (f.online === false && f.via === "radio" && friendIsLive(f)) text = `📻 via radio · ${agoText(f.fixAt || f.viaAt)}`;
        else text = f.online === false ? "Offline" : (f.approx ? "📶 Approx. location" : f.weather);
        if (f.est && Number.isFinite(f.accuracy)) text += `${text ? " | " : ""}≈ ±${formatDistanceShort(f.accuracy)}`;
        if (f.alt) text += ` | ⛰️${f.alt}m`;
        if (myCoords && validCoord(f.lat, f.lng)) text += ` | 📍 ${distanceKm(myCoords.lat, myCoords.lng, f.lat, f.lng)} km away`;
        m.unbindTooltip(); if (text) m.bindTooltip(text, { permanent: true, direction: "right", className: "weather-badge", offset: [15, 0] });
    });
}

socket.on("onlineUsers", list => { if (Array.isArray(list)) list.forEach(u => { if (u.id !== socket.id) { friendData[u.id] = { ...(friendData[u.id] || {}), ...u, online: true }; createOrUpdateFriendMarker(u); } }); updateOnlineUI(); });
socket.on("userOnline", u => { if (u.id !== socket.id) { friendData[u.id] = { ...(friendData[u.id] || {}), ...u, online: true }; createOrUpdateFriendMarker(u); } updateOnlineUI(); });
socket.on("userOffline", d => { if (d?.id && friendData[d.id]) { friendData[d.id].online = false; if (friendMarkers[d.id]) friendMarkers[d.id].setOpacity(0.45); } updateOnlineUI(); });
socket.on("friendMoved", u => {
    // Fixed: trip start/join re-broadcasts the rider's own state to EVERYONE
    // (server broadcastUserState), and this handler used to add YOU to your
    // own friend list — a second marker, "you" in the online list.
    if (!u?.id || u.id === socket.id) return;
    if (u.lat == null || u.lng == null) {                         // sharing set to "off" — remove the marker, don't misplace it
        if (friendMarkers[u.id]) { map.removeLayer(friendMarkers[u.id]); delete friendMarkers[u.id]; }
        removeFriendAccuracy(u.id);
        friendData[u.id] = { ...(friendData[u.id] || {}), ...u, online: u.online !== false };
        updateOnlineUI();
        return;
    }
    // Phase 4: a radio-relayed position (their socket is gone) is not "online";
    // one older than what we already show (e.g. heard first over our own
    // radio) is dropped.
    const cur = friendData[u.id];
    if (u.via === "radio" && cur && Number.isFinite(cur.fixAt) && Number.isFinite(u.fixAt) && u.fixAt <= cur.fixAt) return;
    createOrUpdateFriendMarker({ ...u, online: u.via !== "radio" });
    updateOnlineUI();
    if (typeof triggerGroupRouteUpdate === 'function') triggerGroupRouteUpdate();
});
socket.on("friendDisconnected", id => { if (friendMarkers[id]) { map.removeLayer(friendMarkers[id]); delete friendMarkers[id]; } removeFriendAccuracy(id); delete friendData[id]; updateOnlineUI(); });

// Phase 4: dashed uncertainty ring for a friend whose position is an estimate.
const friendAccuracyCircles = Object.create(null);
function removeFriendAccuracy(id) {
    if (friendAccuracyCircles[id]) { map.removeLayer(friendAccuracyCircles[id]); delete friendAccuracyCircles[id]; }
}

function createOrUpdateFriendMarker(u) {
    if (!u?.id || !validCoord(u.lat, u.lng)) return;
    const prev = friendData[u.id] || {};
    const via = u.via === "radio" ? "radio" : null;
    friendData[u.id] = {
        id: u.id, name: u.name || prev.name || "Friend", avatar: u.avatar || prev.avatar || DEFAULT_AVATAR, lat: u.lat, lng: u.lng, alt: u.alt,
        speedKmh: u.speedKmh, weather: u.weather || "", online: u.online !== false, approx: Boolean(u.approx),
        // Phase 4 — kept so the radio relay can find this rider by ownerKey,
        // and so the UI can say how the position was obtained.
        ownerKey: u.ownerKey || prev.ownerKey || null,
        accuracy: Number.isFinite(u.accuracy) ? u.accuracy : null, est: Boolean(u.est), via,
        viaAt: via ? Date.now() : null, fixAt: Number.isFinite(u.fixAt) ? u.fixAt : null,
        relayedBy: via ? (u.relayedBy || null) : null, updatedAt: Date.now()
    };
    const f = friendData[u.id];
    const opacity = f.online ? 1 : via ? 0.9 : 0.45;
    let m = friendMarkers[u.id];
    // Fixed: the click handler used to capture `u` at creation, so the popup
    // showed the rider's FIRST position/status forever. Read the live record.
    if (!m) { m = L.marker([u.lat, u.lng], { icon: friendIcon(f.avatar) }).addTo(map); m.on("click", () => showProfilePopup(friendData[u.id] || u)); friendMarkers[u.id] = m; }
    else { m.setLatLng([u.lat, u.lng]); }
    m.setIcon(friendIcon(f.avatar));
    m.setOpacity(opacity);
    const el = m.getElement ? m.getElement() : null;
    if (el) {
        el.classList.toggle("approx-marker", f.approx);
        el.classList.toggle("est-marker", f.est);
        el.classList.toggle("radio-marker", Boolean(via));
    }
    if (f.est && Number.isFinite(f.accuracy) && f.accuracy >= 30) {
        if (!friendAccuracyCircles[u.id]) friendAccuracyCircles[u.id] = L.circle([u.lat, u.lng], { radius: f.accuracy, color: "#ff9f0a", weight: 1.5, dashArray: "5 6", fillOpacity: 0.05, interactive: false }).addTo(map);
        else { friendAccuracyCircles[u.id].setLatLng([u.lat, u.lng]); friendAccuracyCircles[u.id].setRadius(f.accuracy); }
    } else removeFriendAccuracy(u.id);
    updateFriendBadges();
}

function updateOnlineUI() {
    const cs = $("chat-subtitle"); if (cs) cs.textContent = `${currentUser.name ? 1 : 0} online`;
    const box = $("online-list"); if (!box) return; box.innerHTML = "";
    Object.values(friendData).filter(f => friendIsLive(f)).forEach(u => {
        const btn = document.createElement("button"); btn.className = "online-friend";
        const radio = u.online === false;   // live only via the radio relay
        btn.innerHTML = `<img src="${escapeHTML(u.avatar)}"><span><b>${escapeHTML(u.name)}</b>${radio ? " <small>📻 radio</small>" : ""}</span><div class="status-dot${radio ? " radio" : ""}"></div>`;
        btn.onclick = () => { if (validCoord(u.lat, u.lng)) map.flyTo([u.lat, u.lng], 16); showProfilePopup(u); }; box.appendChild(btn);
    });
}

function showProfilePopup(u) {
    const ppa = $("profile-popup-avatar"); if (ppa) ppa.src = u.avatar;
    const ppn = $("profile-popup-name"); if (ppn) ppn.textContent = u.name;
    const st = $("profile-popup-status");
    if (st) {
        const radio = u.online === false && friendIsLive(u);
        st.textContent = u.online !== false
            ? (u.approx ? "● Approx. location" : u.est ? `● Estimated position (±${formatDistanceShort(u.accuracy || 0)})` : "● Online")
            : radio ? `● Via radio relay · ${agoText(u.fixAt || u.viaAt)}` : "● Offline";
        st.style.color = u.online !== false ? "#18d6a3" : radio ? "#ff9f0a" : "#8fa1aa";
    }
    const ppd = $("profile-popup-distance");
    if (ppd) ppd.textContent = (myCoords && validCoord(u.lat, u.lng)) ? `${distanceKm(myCoords.lat, myCoords.lng, u.lat, u.lng)} km away` : "--";
    const ppw = $("profile-popup-weather");
    if (ppw) ppw.textContent = u.weather || "--";

    const pnb = $("profile-nav-btn");
    if (pnb) {
        pnb.onclick = () => {
            if (validCoord(u.lat, u.lng) && myCoords) {
                safeHide("profile-popup");
                RoutePrefs.fetchRoute(`${OSRM_BASE}/route/v1/driving/${myCoords.lng},${myCoords.lat};${u.lng},${u.lat}?steps=true&geometries=geojson&overview=full`)
                    .then(data => {
                        if (data.routes && data.routes.length > 0) {
                            startSearchNavigation(u.lat, u.lng, u.name, data.routes[0]);
                        }
                    });
            } else if (!validCoord(u.lat, u.lng)) {
                showToast("This rider's exact location isn't shared right now.");
            }
        };
    }

    if (typeof initCallButton === "function") initCallButton(u);

    // Phase 5: live relative-motion line (features.js keeps it fresh while open).
    const pp = $("profile-popup");
    if (pp) pp.dataset.friendId = u.id || "";
    if (window.Phase5UI) window.Phase5UI.fillPopup(u.id);

    safeShow("profile-popup", "flex");
    const fb = $("profile-focus-btn");
    if (fb) fb.onclick = () => { if (validCoord(u.lat, u.lng)) map.flyTo([u.lat, u.lng], 16); safeHide("profile-popup"); };
}
const ppc = $("profile-popup-close");
if (ppc) ppc.addEventListener("click", () => safeHide("profile-popup"));

function renderGeofenceList() {
    const list = $("geofence-items"); if (!list) return; list.innerHTML = "";
    if (currentGeofences.length === 0) {
        list.innerHTML = "<div style='color:var(--muted); font-size:12px; text-align:center;'>No active geofences.</div>";
    } else {
        currentGeofences.forEach(f => {
            // Ownership now comes from the server as ownerKey (a per-device HMAC),
            // which survives reconnects — the old ownerId===socket.id check broke
            // on every reconnect since socket ids aren't stable.
            const isOwner = f.ownerKey && f.ownerKey === myOwnerKey;
            const actionBtn = isOwner
                ? `<button data-remove-geofence="${escapeHTML(f.id)}" style="background:rgba(239, 68, 68, 0.2); color:#ef4444; border:none; padding:6px 12px; border-radius:8px; font-weight:bold; font-size:11px; cursor:pointer;">Remove</button>`
                : `<span style="font-size:10px; color:var(--muted); font-weight:bold;">Owner: ${escapeHTML(f.ownerName || "Someone")}</span>`;

            list.innerHTML += `
            <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); padding:10px; border-radius:10px; margin-bottom:8px;">
                <div><div style="color:white; font-size:13px; font-weight:bold;">${escapeHTML(f.name)}</div><div style="color:var(--muted); font-size:11px;">Radius: ${f.radius}m</div></div>${actionBtn}
            </div>`;
        });
        list.querySelectorAll("[data-remove-geofence]").forEach((btn) => {
            btn.addEventListener("click", () => socket.emit("removeGeofence", btn.dataset.removeGeofence));
        });
    }
    const modal = $("geofence-list-modal"); if (modal) modal.style.display = "flex";
}
const gflc = $("geofence-list-close");
if (gflc) gflc.addEventListener("click", () => safeHide("geofence-list-modal"));

// myOwnerKey (declared in part 1) is set from profileAccepted — the server's
// stable, non-reversible per-device tag, so "is this mine?" survives socket
// reconnects, unlike the old ownerId===socket.id check.

let followMe = false;
function setFollowMe(on, { quiet = false } = {}) {
    followMe = Boolean(on);
    const b = $("compass-btn");
    if (b) { b.setAttribute("aria-pressed", followMe ? "true" : "false"); b.title = followMe ? "Following you — tap to stop" : "Follow me"; }
    if (!quiet) islandShow({ id: "follow", kind: "info", icon: "➤", title: followMe ? "Following you" : "Follow off", sub: followMe ? "Drag the map to stop" : "", ttl: 2500, haptic: false });
}
function followIfOn(lat, lng) {
    if (followMe && !navState.active && validCoord(lat, lng)) map.panTo([lat, lng], { animate: true });
}
