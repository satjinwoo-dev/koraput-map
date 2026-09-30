"use strict";

/* ============================================================================
   MapUnite client — js/sos.js
   ==============================================================================
   Emergency SOS: sending (online or queued), incoming alerts on the map.

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

// ==========================================
// EMERGENCY SOS
// ==========================================
// Shared by the SOS button (after its confirm sheet) and the voice command
// "send SOS" (after a spoken "confirm SOS") — one code path, one payload.
// Phase 4: also goes out over the paired LoRa radio (features.js ConvoyRelay).
// Returns "server" | "radio" | "queued" (truthy) or false (no position yet).
//   server — the socket is up: everyone online is alerted now;
//   radio  — no data, but the SOS left over the radio (a rider with data
//            uploads it; nearby radios alert their riders directly);
//   queued — no data and no radio: held here and sent right after the next
//            profileAccepted (see there for why NOT Socket.IO's own buffer).
let pendingSos = null;
function sendSOS() {
    if (!myCoords) { showToast("❌ Waiting for GPS..."); return false; }
    const online = Boolean(socket.connected);
    if (online) socket.emit("sos-alert", { name: currentUser.name, lat: myCoords.lat, lng: myCoords.lng, alt: myCoords.alt ?? null });
    else pendingSos = { queuedAt: Date.now() };
    const radio = Boolean(window.ConvoyRelay && typeof window.ConvoyRelay.sendSos === "function" && window.ConvoyRelay.sendSos());
    if (online) {
        showToast(radio ? "🚨 SOS BROADCASTED TO ALL FRIENDS — and over the radio." : "🚨 SOS BROADCASTED TO ALL FRIENDS!", 8000);
        islandShow({ id: "sos", kind: "sos", title: "SOS sent", sub: radio ? "Friends alerted · radio too" : "Your friends were alerted", ttl: 6000 });
        return "server";
    }
    if (radio) {
        showToast("🚨 No data — SOS sent over the radio. It also goes out online as soon as you have signal.", 9000);
        islandShow({ id: "sos", kind: "sos", title: "SOS sent by radio", sub: "Waiting for a rider to confirm", ttl: 9000 });
        return "radio";
    }
    showToast("🚨 No connection — your SOS will send the moment you're back online.", 9000);
    islandShow({ id: "sos", kind: "sos", title: "SOS queued", sub: "Sends as soon as you're back online", ttl: 9000 });
    return "queued";
}

// 8-point compass word from A to B ("north-east"), for spoken directions.
function compassWord(lat1, lng1, lat2, lng2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
    const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(deg / 45) % 8];
}

function setupSOS() {
    let sosBtn = $("sos-btn");
    if (!sosBtn) {
        sosBtn = document.createElement("button");
        sosBtn.id = "sos-btn";
        sosBtn.innerHTML = "🚨 SOS";
        sosBtn.style.cssText = "position:fixed;bottom:calc(90px + env(safe-area-inset-bottom,0px));right:20px;z-index:9998;background:#ef4444;color:white;border:none;border-radius:50%;width:55px;height:55px;font-weight:900;font-size:12px;box-shadow:0 0 15px rgba(239,68,68,0.7);cursor:pointer;animation:dangerPulse 1s infinite alternate;";
        document.body.appendChild(sosBtn);
    }

    sosBtn.onclick = async () => {
        if (!myCoords) return showToast("❌ Waiting for GPS...");
        const { ok } = await confirmDialog({
            title: "Send emergency SOS?", body: "This alerts every connected friend with your exact coordinates.",
            okLabel: "Send SOS", cancelLabel: "Cancel", danger: true
        });
        if (!ok) return;
        sendSOS();
    };

    socket.on("sos-alert", (data) => showIncomingSos(data));
}

// Phase 4: one entry point for an incoming SOS — from the server, or heard
// directly over our own radio (features.js). The same emergency can arrive
// both ways (and a radio retry again), so it alerts ONCE per rider per minute;
// later copies only move that rider's SOS pin.
const recentSos = new Map();        // ownerKey | id -> {ts, marker}
function showIncomingSos(data) {
    if (!data || !validCoord(data.lat, data.lng)) return;
    const key = data.ownerKey || data.id || data.name || "unknown";
    const now = Date.now();
    const seen = recentSos.get(key);
    const who = String(data.name || "A rider");
    const viaRadio = data.via === "radio";
    const ageSec = Number.isFinite(data.at) ? Math.round((now - data.at) / 1000) : 0;
    const note = viaRadio ? ` (via radio${data.relayedBy ? `, relayed by ${data.relayedBy}` : ""}${ageSec > 45 ? `, ${agoText(data.at)}` : ""})` : "";

    let marker = seen && seen.marker;
    if (marker) marker.setLatLng([data.lat, data.lng]);
    else {
        marker = L.marker([data.lat, data.lng], { icon: L.divIcon({ className: 'sos-marker', html: '<div style="font-size:30px;animation:dangerPulse 1s infinite alternate;">🚨</div>' }) })
            .bindPopup(`<b style="color:red;">EMERGENCY SOS: ${escapeHTML(who)}</b>${escapeHTML(note)}`).addTo(map);
        marker.openPopup();
    }
    recentSos.set(key, { ts: seen && now - seen.ts < 60000 ? seen.ts : now, marker });
    if (seen && now - seen.ts < 60000) return;

    const div = document.createElement("div");
    div.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(239,68,68,0.3);border:10px solid #ef4444;z-index:99999;pointer-events:none;animation:dangerPulse 1s infinite alternate;";
    document.body.appendChild(div);

    showToast(`🚨 URGENT SOS FROM ${who.toUpperCase()}!${note} Check Map!`, 15000);
    // StatusIsland uses textContent — raw string, not escapeHTML().
    islandShow({ id: "sos-in", kind: "sos", title: "SOS", sub: `${who} needs help${viaRadio ? " · via radio" : ""}`, ttl: 15000 });
    // Always spoken: an emergency bypasses mute and the "spoken alerts"
    // toggle (stated next to that toggle in settings).
    let where = "";
    if (myCoords && validCoord(data.lat, data.lng)) {
        where = ` ${spokenDistance(map.distance([myCoords.lat, myCoords.lng], [data.lat, data.lng]))} ${compassWord(myCoords.lat, myCoords.lng, data.lat, data.lng)} of you.`;
    }
    const radioNote = viaRadio ? " Received over the radio." : "";
    voiceAnnounce(`Emergency. ${who} sent an S O S.${where}${radioNote}`, { priority: 100, force: true, key: `sos-in-${key}`, cooldownMs: 10000, category: "sos" });

    map.flyTo([data.lat, data.lng], 16, { animate: true, duration: 2 });
    setTimeout(() => div.remove(), 10000);
}
