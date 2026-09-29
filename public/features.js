"use strict";

/* ============================================================================
   MapUnite experimental features — features.js  (v2, roadmap-aligned)
   ==============================================================================
   Loaded after app.js — reuses its globals (socket, rtcConfig, currentUser,
   friendData, myOwnerKey, showToast, escapeHTML, distanceKm, validCoord, $,
   islandShow). Three modules, matching the roadmap's own verdicts:

     1. VoiceSquad — the old "Group Call" button got the mic, toggled itself,
        and emitted `join-voice-squad`, which server.js never listened for.
        No audio ever reached anyone. Step 1 added the matching server
        handlers (`join-voice-squad` / `voice-signal` / `leave-voice-squad`),
        so this is now a REAL multi-peer WebRTC mesh: one RTCPeerConnection
        per other squad member, signaled through the server.

     2. P2PRadar — the old panel's "success" path printed hardcoded strings
        ("Rider_2 ~15m", "Squad Leader Signal: Good") regardless of what
        Bluetooth actually found — a UI mockup, not a radar. The real Web
        Bluetooth central scan is kept (that part was genuine) and clearly
        labeled for what it is: a browser tab can only ever be a BLE
        *central*, never advertise as a peripheral, so it can find other
        *discoverable* BLE devices, not specifically "other MapUnite phones."
        Alongside it, a second, honestly-labeled panel shows real squad
        members within range using the GPS data the app already has —
        computed with real trigonometry (distance + bearing), not simulated.

     3. Skunkworks (Seismograph pothole detector, AI Dashcam, travel mode) —
        these were already real (DeviceMotion, getUserMedia), just wired
        loosely. Tightened up and connected to the Status Island. One real
        bug fixed along the way: the pothole marker read
        `lastFixCoords.latitude/.longitude`, but app.js's `lastFixCoords`
        object uses `.lat/.lng` — the marker was silently placing at
        undefined coordinates every time.
   ============================================================================ */

// ============================================================================
// 1. VOICE SQUAD — real multi-peer group call (mesh topology)
// ============================================================================
const VoiceSquad = {
    active: false,
    localStream: null,
    peers: new Map(),          // peerId -> RTCPeerConnection
    audioEls: new Map(),       // peerId -> <audio>
    roster: new Map(),         // peerId -> {id, name, avatar}

    init() {
        const callBtn = document.getElementById("group-call-btn");
        if (!callBtn) return;
        this.btn = callBtn;

        callBtn.addEventListener("click", () => { this.active ? this.leave() : this.join(); });

        socket.on("voice-squad-roster", (data) => {
            (data?.members || []).forEach((m) => this.roster.set(m.id, m));
            // We're the newcomer — initiate to every existing member. This
            // one-sided convention (newcomer always offers) is what avoids
            // two peers glaring at each other with simultaneous offers.
            this.roster.forEach((m) => this.callPeer(m.id));
        });

        socket.on("voice-squad-member-joined", (m) => {
            if (!this.active || !m?.id) return;
            this.roster.set(m.id, m);
            // We do NOT initiate here — the joiner initiates to us (see above).
            // We just make sure the UI knows they're in the squad now.
            this.updateBadge();
        });

        socket.on("voice-signal", async ({ from, signal }) => {
            if (!this.active || !from || !signal) return;
            if (signal.type === "offer") await this.handleOffer(from, signal);
            else if (signal.type === "answer") await this.handleAnswer(from, signal);
            else if (signal.type === "ice") await this.handleIce(from, signal);
        });

        socket.on("voice-squad-member-left", ({ id }) => { if (id) this.removePeer(id); });
    },

    async join() {
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch (err) {
            console.error("Voice squad mic error:", err);
            showToast("❌ Microphone permission is required for Group Call.");
            return;
        }
        this.active = true;
        this.roster.clear();
        this.btn.style.background = "#ff4757";
        this.btn.innerHTML = "🔴 End Call";
        showToast("🎙️ Joined the squad call.");
        if (window.StatusIsland) window.StatusIsland.show({ id: "voice", kind: "safe", title: "Squad call live", sub: "Tap the mic button to leave", ttl: 3500, haptic: false });
        socket.emit("join-voice-squad");
    },

    leave() {
        this.active = false;
        socket.emit("leave-voice-squad");
        this.peers.forEach((_, id) => this.removePeer(id));
        this.roster.clear();
        if (this.localStream) { this.localStream.getTracks().forEach((t) => t.stop()); this.localStream = null; }
        this.btn.style.background = "#18d6a3";
        this.btn.innerHTML = "🎙️ Group Call";
        showToast("Left the squad call.");
    },

    newPeerConnection(peerId) {
        const pc = new RTCPeerConnection(rtcConfig);
        if (this.localStream) this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream));
        pc.onicecandidate = (e) => { if (e.candidate) socket.emit("voice-signal", { to: peerId, signal: { type: "ice", candidate: e.candidate } }); };
        pc.ontrack = (e) => this.attachRemoteAudio(peerId, e);
        pc.onconnectionstatechange = () => {
            if (["failed", "closed", "disconnected"].includes(pc.connectionState)) this.removePeer(peerId);
        };
        this.peers.set(peerId, pc);
        return pc;
    },

    async callPeer(peerId) {
        if (this.peers.has(peerId)) return;
        const pc = this.newPeerConnection(peerId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("voice-signal", { to: peerId, signal: { type: "offer", sdp: offer } });
    },

    async handleOffer(fromId, signal) {
        const pc = this.peers.get(fromId) || this.newPeerConnection(fromId);
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("voice-signal", { to: fromId, signal: { type: "answer", sdp: answer } });
        this.updateBadge();
    },
    async handleAnswer(fromId, signal) {
        const pc = this.peers.get(fromId); if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        this.updateBadge();
    },
    async handleIce(fromId, signal) {
        const pc = this.peers.get(fromId); if (!pc || !signal.candidate) return;
        try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (e) { /* stale candidate, safe to ignore */ }
    },

    attachRemoteAudio(peerId, event) {
        let audio = this.audioEls.get(peerId);
        if (!audio) {
            audio = document.createElement("audio");
            audio.autoplay = true; audio.playsInline = true; audio.hidden = true;
            audio.dataset.voiceSquadPeer = peerId;
            document.body.appendChild(audio);
            this.audioEls.set(peerId, audio);
        }
        audio.srcObject = (event.streams && event.streams[0]) || new MediaStream([event.track]);
        audio.play().catch(() => { document.body.addEventListener("click", () => audio.play(), { once: true }); });
    },

    removePeer(peerId) {
        const pc = this.peers.get(peerId); if (pc) { pc.close(); this.peers.delete(peerId); }
        const audio = this.audioEls.get(peerId); if (audio) { audio.remove(); this.audioEls.delete(peerId); }
        this.roster.delete(peerId);
        this.updateBadge();
    },

    updateBadge() {
        if (!this.active) return;
        const n = this.peers.size;
        if (window.StatusIsland) window.StatusIsland.show({ id: "voice", kind: "safe", title: "Squad call live", sub: n > 0 ? `${n} other rider${n === 1 ? '' : 's'} connected` : "Waiting for others…", ttl: 3000, haptic: false });
    }
};

// ============================================================================
// 2. P2P RADAR — real Bluetooth central scan + honestly-labeled network radar
// ============================================================================
// What a browser tab can honestly do here (roadmap Section 5): Web Bluetooth
// can only act as a *central* — it can find nearby discoverable BLE devices,
// but it can't discover specifically "other MapUnite phones" (that needs a
// native peripheral-advertising plugin or a cheap beacon, neither of which
// exists yet). So: real Bluetooth scan when available, clearly labeled for
// what it finds. Alongside it, a second real (not simulated) source: squad
// members' actual last-known GPS position, relayed through the server, shown
// as distance + compass bearing — genuine trigonometry over genuine data,
// explicitly labeled "via network" so nobody mistakes it for offline mesh.
const P2PRadar = {
    init() {
        const radarBtn = document.getElementById("p2p-radar-btn");
        const radarPanel = document.getElementById("radar-panel");
        const closeRadar = document.getElementById("close-radar");
        const radarStatus = document.getElementById("radar-status");
        const peerList = document.getElementById("peer-list");
        if (!radarBtn || !radarPanel) return;

        radarBtn.addEventListener("click", () => {
            const willOpen = radarPanel.style.display !== "block";
            radarPanel.style.display = willOpen ? "block" : "none";
            if (willOpen) this.scan(radarStatus, peerList);
        });
        if (closeRadar) closeRadar.addEventListener("click", () => { radarPanel.style.display = "none"; });
    },

    bearingCompass(lat1, lng1, lat2, lng2) {
        const toRad = (d) => (d * Math.PI) / 180;
        const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
        const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
        const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
        const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
        return dirs[Math.round(deg / 45) % 8];
    },

    // The honest part: real squad members, real GPS, real trig — labeled as
    // coming over the network, never presented as offline/Bluetooth-found.
    nearbyViaNetwork(maxKm = 5) {
        if (!window.myCoords && typeof myCoords === "undefined") return [];
        const me = (typeof myCoords !== "undefined" && myCoords) || null;
        if (!me) return [];
        return Object.values(typeof friendData !== "undefined" ? friendData : {})
            .filter((f) => f.online !== false && typeof validCoord === "function" && validCoord(f.lat, f.lng))
            .map((f) => ({ name: f.name, km: Number(distanceKm(me.lat, me.lng, f.lat, f.lng)), bearing: this.bearingCompass(me.lat, me.lng, f.lat, f.lng) }))
            .filter((f) => Number.isFinite(f.km) && f.km <= maxKm)
            .sort((a, b) => a.km - b.km);
    },

    renderNetworkList(peerList, extraHtml = "") {
        const nearby = this.nearbyViaNetwork();
        let html = extraHtml;
        if (nearby.length > 0) {
            html += `<li style="color:var(--muted); font-size:10.5px; padding:6px 0 2px; text-transform:uppercase; letter-spacing:.05em;">Squad nearby (via network)</li>`;
            nearby.forEach((f) => {
                html += `<li style="color:#5ac8fa; padding:4px 0;">📶 ${escapeHTML(f.name)} — ${f.km.toFixed(1)}km ${f.bearing}</li>`;
            });
        } else if (!extraHtml) {
            html = `<li style="color:var(--muted); padding:4px 0;">No devices found nearby.</li>`;
        }
        peerList.innerHTML = html;
    },

    async scan(radarStatus, peerList) {
        radarStatus.innerText = "Scanning…";
        peerList.innerHTML = "";

        if (navigator.bluetooth && navigator.bluetooth.requestDevice) {
            try {
                const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
                radarStatus.innerText = "Bluetooth device found nearby (not necessarily a MapUnite rider)";
                this.renderNetworkList(peerList, `<li style="color:#18d6a3; padding:4px 0;">🔵 ${escapeHTML(device.name || "Unknown Bluetooth device")}</li>`);
            } catch (error) {
                // A user-cancelled picker is not an error worth alarming over.
                if (error && error.name === "NotFoundError") radarStatus.innerText = "No Bluetooth device selected.";
                else { console.log("Bluetooth scan unavailable:", error); radarStatus.innerText = "Bluetooth scan unavailable on this device."; }
                this.renderNetworkList(peerList);
            }
        } else {
            radarStatus.innerText = "Bluetooth scanning isn't supported in this browser — showing squad via network instead.";
            this.renderNetworkList(peerList);
        }
    }
};

// ============================================================================
// 3. SKUNKWORKS — Seismograph (pothole detector), AI Dashcam, travel mode
// ============================================================================
const Seismograph = {
    active: false,
    threshold: 18,           // m/s^2 — normal gravity is ~9.8, a pothole jolt clears this
    cooldown: false,         // don't re-alert on the same pothole

    init() {
        if (!window.DeviceMotionEvent) {
            console.log("[SEISMOGRAPH] Accelerometer not supported on this device.");
            return;
        }
        window.addEventListener('devicemotion', (event) => {
            if (typeof currentTravelMode !== 'undefined' && currentTravelMode === 'walk') return;
            if (!this.active) return;
            const acc = event.accelerationIncludingGravity;
            if (!acc) return;
            const force = Math.sqrt(acc.x * acc.x + acc.y * acc.y + acc.z * acc.z);
            if (force > this.threshold && !this.cooldown) this.triggerPotholeAlert(force);
        });
    },

    start() { this.active = true; console.log("[SEISMOGRAPH] Armed."); },
    stop() { this.active = false; },

    triggerPotholeAlert(force) {
        console.log(`[SEISMOGRAPH] Possible pothole. Force: ${force.toFixed(1)} m/s²`);
        this.cooldown = true;
        setTimeout(() => { this.cooldown = false; }, 5000);

        // Fixed: this used to read lastFixCoords.latitude/.longitude, but
        // app.js's lastFixCoords (and myCoords) use .lat/.lng — the marker
        // was silently placing at undefined coordinates every time.
        const pos = (typeof myCoords !== "undefined" && myCoords) ? myCoords : null;
        if (pos && typeof map !== 'undefined') {
            L.circleMarker([pos.lat, pos.lng], { radius: 8, color: 'red', fillColor: '#f03', fillOpacity: 0.5 })
                .addTo(map).bindPopup("⚠️ Possible pothole (accelerometer spike)").openPopup();
        }
        if (window.StatusIsland) window.StatusIsland.show({ id: "pothole", kind: "sensor", title: "Rough road", sub: "Possible pothole detected", ttl: 4000 });
        try { if (navigator.vibrate) navigator.vibrate([50, 30, 50]); } catch (e) { /* not supported everywhere */ }
    }
};
Seismograph.init();
Seismograph.start();

let dashcamStream = null;

async function toggleAIDashcam() {
    const videoEl = document.getElementById('dashcam-video');
    const btn = document.getElementById('ai-dashcam-btn');
    if (!videoEl || !btn) return;

    if (dashcamStream) {
        dashcamStream.getTracks().forEach(track => track.stop());
        dashcamStream = null;
        videoEl.style.display = 'none';
        videoEl.srcObject = null;
        btn.style.borderColor = 'gray';
        btn.innerHTML = '📷';
        console.log("[AI DASHCAM] Camera OFF.");
    } else {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showToast("❌ Camera isn't available in this browser.");
            return;
        }
        try {
            dashcamStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
            videoEl.srcObject = dashcamStream;
            videoEl.style.display = 'block';
            btn.style.borderColor = '#ff3b30';
            btn.innerHTML = '🔴';
            console.log("[AI DASHCAM] Camera ON — this increases battery use noticeably.");
            if (window.StatusIsland) window.StatusIsland.show({ id: "dashcam", kind: "sensor", title: "Dashcam on", sub: "Higher battery use while active", ttl: 4000, haptic: false });
        } catch (err) {
            console.error("[AI DASHCAM] Camera access denied or failed:", err);
            showToast("❌ Camera permission is needed for the dashcam.");
        }
    }
}

function toggleSkunkworks() {
    const panel = document.getElementById('skunkworks-panel');
    const btn = document.getElementById('skunkworks-toggle-btn');
    if (!panel) return;
    const willOpen = panel.style.display === 'none' || panel.style.display === '';
    panel.style.display = willOpen ? 'flex' : 'none';
    if (btn) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
}

function setTravelMode(mode) {
    window.currentTravelMode = mode;
    console.log("[SYSTEM] Travel mode changed to:", mode);

    ['car', 'bike', 'walk'].forEach(m => {
        const btn = document.getElementById(`mode-${m}`);
        if (btn) { btn.style.background = 'transparent'; btn.style.borderColor = 'gray'; btn.setAttribute('aria-pressed', 'false'); }
    });
    const selectedBtn = document.getElementById(`mode-${mode}`);
    if (selectedBtn) { selectedBtn.style.background = '#18d6a3'; selectedBtn.style.borderColor = '#18d6a3'; selectedBtn.setAttribute('aria-pressed', 'true'); }

    // Walking riders don't get speed alerts or pothole detection — both
    // assume a vehicle (see SmartDrive.tick and Seismograph above).
    if (mode === 'walk') Seismograph.stop(); else Seismograph.start();
}
window.currentTravelMode = 'bike';

// ============================================================================
// 4. TRIPDB — 7-day local backup + export (unchanged; app.js now reads it
//    correctly via restoreAll() instead of the nonexistent restoreTrip() /
//    restoreNavState() methods the shipped build called)
// ============================================================================
const TripDB = {
    autoSaveInterval: null,
    expiryTime: 7 * 24 * 60 * 60 * 1000,

    checkExpiry() {
        const lastSaved = localStorage.getItem('mapUnite_last_saved');
        if (lastSaved && (Date.now() - parseInt(lastSaved)) > this.expiryTime) {
            this.clearBackup();
            console.log("🗑️ [DB] 7 days passed — old local backup cleared for privacy.");
        }
    },
    startAutoSave(tripObject) {
        this.checkExpiry();
        if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
        this.autoSaveInterval = setInterval(() => {
            if (tripObject && tripObject.active) {
                localStorage.setItem('mapUnite_trip_backup', JSON.stringify(tripObject));
                localStorage.setItem('mapUnite_last_saved', Date.now().toString());
            }
        }, 5000);
    },
    saveNavState(destinationData) {
        if (destinationData) {
            localStorage.setItem('mapUnite_nav_backup', JSON.stringify(destinationData));
            localStorage.setItem('mapUnite_last_saved', Date.now().toString());
        }
    },
    saveSession(username, groupData) {
        if (username) localStorage.setItem('mapUnite_username', username);
        if (groupData) localStorage.setItem('mapUnite_group_backup', JSON.stringify(groupData));
        localStorage.setItem('mapUnite_last_saved', Date.now().toString());
    },
    restoreAll() {
        this.checkExpiry();
        return {
            username: localStorage.getItem('mapUnite_username'),
            nav: JSON.parse(localStorage.getItem('mapUnite_nav_backup') || "null"),
            trip: JSON.parse(localStorage.getItem('mapUnite_trip_backup') || "null"),
            group: JSON.parse(localStorage.getItem('mapUnite_group_backup') || "null")
        };
    },
    clearBackup() {
        localStorage.removeItem('mapUnite_trip_backup');
        localStorage.removeItem('mapUnite_nav_backup');
        localStorage.removeItem('mapUnite_group_backup');
        localStorage.removeItem('mapUnite_last_saved');
        if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
    },
    downloadDetailedInfo() {
        const allBackup = {
            ExportDate: new Date().toLocaleString(),
            Username: localStorage.getItem('mapUnite_username') || "Not Set",
            TripDetails: JSON.parse(localStorage.getItem('mapUnite_trip_backup') || "{}"),
            Navigation: JSON.parse(localStorage.getItem('mapUnite_nav_backup') || "{}"),
            GroupData: JSON.parse(localStorage.getItem('mapUnite_group_backup') || "{}")
        };
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(allBackup, null, 2));
        const a = document.createElement('a');
        a.setAttribute("href", dataStr);
        a.setAttribute("download", `MapUnite_Data_${new Date().toLocaleDateString().replace(/\//g, '-')}.json`);
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
};
TripDB.checkExpiry();

// ============================================================================
// BOOT
// ============================================================================
document.addEventListener("DOMContentLoaded", () => {
    VoiceSquad.init();
    P2PRadar.init();
});
