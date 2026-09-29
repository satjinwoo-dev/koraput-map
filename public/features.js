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

     PHASE 3 (roadmap Section 4):
     5. VoiceAssistant — voice-first Safe Drive. SpeechSynthesis behind a
        priority queue (pre-emption, expiry, de-dupe, mute) for every spoken
        cue app.js sends through voiceAnnounce(); SpeechRecognition for
        hands-free commands — push-to-talk by default, optional continuous
        listening during drives with an echo guard so it never obeys its own
        voice. Commands: how far · where is <name> · where am I · squad status
        · navigate to <place> · start / stop navigation · recenter · speed ·
        mute / unmute · send SOS (two-step: "confirm SOS").
     6. ConvoyIntelligence — the comparison loop over `friendMoved` +
        per-member OSRM road ETAs: falling behind (in road minutes, not
        straight-line), stopped 3+ min, off their planned road, lost signal,
        arrived. Island + voice + trip-panel badge + marker ring.
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
        // Keep the mic glyph (the button is a 52px circle since Step 2 —
        // writing "🔴 End Call" into it overflowed); state = color + aria.
        this.btn.style.background = "#ff4757";
        this.btn.setAttribute("aria-pressed", "true");
        this.btn.setAttribute("aria-label", "Leave group voice call");
        this.btn.title = "Leave group call";
        // SpeechRecognition and the call can't share the mic.
        if (window.VoiceAssistant) window.VoiceAssistant.updateHandsFree();
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
        this.btn.style.background = "var(--mint)";
        this.btn.setAttribute("aria-pressed", "false");
        this.btn.setAttribute("aria-label", "Join group voice call");
        this.btn.title = "Group voice call";
        if (window.VoiceAssistant) window.VoiceAssistant.updateHandsFree();
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
// 5. VOICE ASSISTANT (Phase 3) — voice-first Safe Drive (roadmap Sections 4, 25)
// ============================================================================
// Speaking: SpeechSynthesis behind a small priority queue.
//   - a higher-priority cue pre-empts a lower one (a speed warning never
//     waits behind "Rahul is moving again");
//   - equal/lower cues queue (max 4) and EXPIRE — a turn prompt heard ten
//     seconds late is worse than none;
//   - `key` + `cooldownMs` de-duplicates repeats;
//   - the "Spoken alerts" setting and "mute" apply to everything except
//     `force` (replies to a command the rider just gave, and SOS).
// Listening: SpeechRecognition, two modes.
//   - push-to-talk (tap a mic button, say one command) — the default;
//   - hands-free (opt-in setting): listens continuously ONLY while a drive
//     is active and the app is visible, pauses while it's speaking (so it
//     can't hear its own "say start navigation"), ignores long utterances
//     (conversation, not commands), and never runs during a call.
// Honesty note surfaced in settings: in Chrome, SpeechRecognition audio is
// processed by Google's speech service while the mic is listening.
function normalizeSpeech(t) {
    return String(t || "")
        .toLowerCase()
        .replace(/[’`]/g, "'")
        .replace(/[^\p{L}\p{N}'\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Small Levenshtein for fuzzy rider names ("Rahool" -> "Rahul").
function editDistance(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[n];
}

// Ordered: first match wins. `ctx` = {mode:"ptt"|"handsfree", pendingSos:boolean}.
const VOICE_COMMANDS = [
    { name: "confirmSos", test: (t, ctx) => ctx.pendingSos && /\b(confirm|confirmed|yes|haan|send it|do it)\b/.test(t) },
    { name: "cancelPending", test: (t, ctx) => ctx.pendingSos && /\b(cancel|no|nahi|stop|don'?t)\b/.test(t) },
    { name: "sos", test: (t) => /\b(send|trigger|raise|call)\b.*\b(sos|s o s|emergency)\b|\bemergency\b|\bhelp me\b|\bsos\b|\bs o s\b/.test(t) },
    { name: "help", test: (t) => /\b(help|what can i say|commands|options)\b/.test(t) },
    { name: "unmute", test: (t) => /\b(unmute|un mute|voice on|alerts on|sound on|speak again)\b/.test(t) },
    { name: "mute", test: (t) => /\b(mute|quiet|silence|shut up|chup|alerts off|voice off)\b/.test(t) },
    { name: "stopNav", test: (t, ctx) => /\b(stop|end|cancel|exit|finish)\b.*\b(navigation|navigating|drive|ride|trip|route|directions)\b/.test(t) || (ctx.mode === "ptt" && /^(stop|ruko|band karo|end)$/.test(t)) },
    { name: "navigateTo", test: (t) => { const m = /\b(?:navigate|take me|directions|route me|drive me|go|get me|chalo)\s+to\s+(.+)$/.exec(t); return m ? m[1] : false; } },
    { name: "startNav", test: (t) => /\b(start|begin|resume)\b.*\b(navigation|navigating|drive|ride|route|trip)\b|\blet'?s go\b|\bchalo\b|^go$/.test(t) },
    { name: "whereAmI", test: (t) => /\bwhere am i\b|\bmain kahan hu\b/.test(t) },
    { name: "convoy", test: (t) => /\b(squad|convoy|group|team)\b.*\b(status|update|check|report)\b|\bwhere is everyone\b|\bwhere's everyone\b|\beveryone ok\b|\bsab kahan hai\b/.test(t) },
    { name: "whereIs", test: (t) => { const m = /\bwhere(?:'s| is)\s+(.+)$/.exec(t) || /^(.+?)\s+kahan hai$/.exec(t); return m ? m[1] : false; } },
    { name: "howFar", test: (t) => /\b(how far|how long|eta|time left|distance left|remaining|kitna door|kitni der|when will i (arrive|get there))\b/.test(t) },
    { name: "speed", test: (t) => /\b(my speed|how fast|what speed|current speed)\b/.test(t) },
    { name: "recenter", test: (t) => /\b(re ?cent(er|re)|locate me|center map|centre map|show my location)\b/.test(t) }
];

function matchVoiceCommand(text, ctx) {
    for (const c of VOICE_COMMANDS) {
        const r = c.test(text, ctx);
        if (r) return { name: c.name, arg: typeof r === "string" ? r.trim() : null };
    }
    return null;
}

const VoiceAssistant = {
    KEY_ALERTS: "mu_voice_alerts",
    KEY_HANDSFREE: "mu_voice_handsfree",
    MUTE_MS: 30 * 60 * 1000,
    MAX_QUEUE: 4,
    ECHO_GUARD_MS: 700,

    alertsEnabled: true,
    handsFree: false,
    mutedUntil: 0,
    synth: ("speechSynthesis" in window) ? window.speechSynthesis : null,
    voice: null,
    current: null,
    queue: [],
    recentKeys: new Map(),
    watchdog: null,
    unlocked: false,
    lastTtsEndTs: 0,

    Recognition: window.SpeechRecognition || window.webkitSpeechRecognition || null,
    recognizer: null,
    listenMode: null,              // "ptt" | "handsfree" | null
    restartTimer: null,
    resumeTimer: null,
    errorTimes: [],
    handsFreePausedUntil: 0,
    suspendedForTts: false,
    pendingConfirm: null,          // { type: "sos", until }

    init() {
        try {
            this.alertsEnabled = localStorage.getItem(this.KEY_ALERTS) !== "0";
            this.handsFree = localStorage.getItem(this.KEY_HANDSFREE) === "1";
        } catch (e) { /* storage blocked: keep defaults */ }

        if (this.synth) {
            // Chrome can keep a stuck utterance across reloads; start clean.
            try { this.synth.cancel(); } catch (e) { /* ignore */ }
            this.pickVoice();
            if (typeof this.synth.addEventListener === "function") this.synth.addEventListener("voiceschanged", () => this.pickVoice());
            else this.synth.onvoiceschanged = () => this.pickVoice();
        }

        // iOS only allows speech after speak() has run inside a user gesture once.
        const unlock = () => this.unlock();
        document.addEventListener("pointerdown", unlock, { once: true, capture: true });
        document.addEventListener("keydown", unlock, { once: true, capture: true });

        this.bindUI();
        document.addEventListener("mu:drive-state", () => this.updateHandsFree());
        document.addEventListener("visibilitychange", () => this.updateHandsFree());
    },

    bindUI() {
        const alertsToggle = document.getElementById("voice-alerts-toggle");
        if (alertsToggle) {
            alertsToggle.checked = this.alertsEnabled;
            alertsToggle.addEventListener("change", () => {
                this.alertsEnabled = alertsToggle.checked;
                try { localStorage.setItem(this.KEY_ALERTS, this.alertsEnabled ? "1" : "0"); } catch (e) { /* ignore */ }
                if (!this.alertsEnabled) this.silence();
            });
        }

        const hfToggle = document.getElementById("voice-handsfree-toggle");
        if (hfToggle) {
            hfToggle.checked = this.handsFree && Boolean(this.Recognition);
            hfToggle.disabled = !this.Recognition;
            hfToggle.addEventListener("change", () => {
                this.handsFree = hfToggle.checked;
                this.handsFreePausedUntil = 0;
                try { localStorage.setItem(this.KEY_HANDSFREE, this.handsFree ? "1" : "0"); } catch (e) { /* ignore */ }
                if (this.handsFree && !this.driving()) showToast("Hands-free listening starts automatically when a drive begins.", 4000);
                this.updateHandsFree();
            });
        }

        const hint = document.getElementById("voice-support-hint");
        if (hint) {
            const parts = [];
            if (!this.synth) parts.push("This browser can't speak alerts.");
            if (!this.Recognition) parts.push("Voice commands aren't supported in this browser — Chrome on Android supports them.");
            else parts.push("While the mic is listening, your browser's speech service turns speech into text — in Chrome that audio is sent to Google.");
            parts.push("Emergency SOS alerts are always spoken.");
            hint.textContent = parts.join(" ");
        }

        const testBtn = document.getElementById("voice-test-btn");
        if (testBtn) testBtn.addEventListener("click", () => {
            this.unlock();
            this.announce(this.Recognition
                ? "Voice alerts are on. Tap the microphone and say help to hear the commands."
                : "Voice alerts are on.", { priority: 80, force: true });
        });

        ["voice-cmd-btn", "voice-cmd-map-btn"].forEach((id) => {
            const b = document.getElementById(id);
            if (!b) return;
            if (!this.Recognition) b.title = "Voice commands aren't supported in this browser";
            b.addEventListener("click", () => this.togglePushToTalk());
        });
    },

    // ---------------------------------------------------------------- speaking
    pickVoice() {
        if (!this.synth) return;
        const voices = this.synth.getVoices() || [];
        if (!voices.length) return;
        const region = ((navigator.language || "en-IN").split("-")[1] || "IN").toLowerCase();
        // All cues are English: prefer English in the rider's region (en-IN),
        // then any English, then an on-device voice (works offline, keeps
        // text on the phone).
        const score = (v) => {
            const lang = String(v.lang || "").toLowerCase().replace("_", "-");
            let s = 0;
            if (lang.startsWith("en")) s += 2;
            if (lang === `en-${region}`) s += 2;
            if (v.localService) s += 1;
            if (v.default) s += 0.5;
            return s;
        };
        this.voice = voices.slice().sort((a, b) => score(b) - score(a))[0] || null;
    },

    unlock() {
        if (!this.synth || this.unlocked) return;
        try {
            const u = new SpeechSynthesisUtterance(" ");
            u.volume = 0;
            this.synth.speak(u);
            this.unlocked = true;
        } catch (e) { /* ignore */ }
    },

    driving() { return typeof isDriving === "function" ? isDriving() : false; },
    isMuted() { return Date.now() < this.mutedUntil; },

    silence() {
        this.queue = [];
        if (this.current) { this.current = null; this.lastTtsEndTs = Date.now(); clearTimeout(this.watchdog); }
        try { if (this.synth) this.synth.cancel(); } catch (e) { /* ignore */ }
        // The cancelled utterance's onend is ignored (done() checks identity),
        // so hand hands-free listening back here instead.
        this.resumeRecognitionAfterTts();
    },

    announce(text, opts = {}) {
        if (!this.synth || !text) return false;
        const priority = Number.isFinite(opts.priority) ? opts.priority : 50;
        const force = Boolean(opts.force);
        if (!force) {
            if (!this.alertsEnabled) return false;
            if (this.isMuted() && priority < 100) return false;
            if (opts.drivingOnly && !this.driving() && priority < 90) return false;
        }
        const now = Date.now();
        if (opts.key) {
            const last = this.recentKeys.get(opts.key);
            if (last && now - last < (Number.isFinite(opts.cooldownMs) ? opts.cooldownMs : 20000)) return false;
            this.recentKeys.set(opts.key, now);
            if (this.recentKeys.size > 200) {
                for (const [k, t] of this.recentKeys) if (now - t > 10 * 60 * 1000) this.recentKeys.delete(k);
            }
        }
        const item = { text: String(text), priority, createdAt: now, maxAgeMs: Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : 12000 };

        if (!this.current) { this.speakNow(item); return true; }
        if (priority > this.current.priority) {
            // Pre-empt. Chrome can drop an utterance queued in the same tick
            // as cancel(), so the new one starts a moment later.
            this.current = item;
            clearTimeout(this.watchdog);
            try { this.synth.cancel(); } catch (e) { /* ignore */ }
            setTimeout(() => { if (this.current === item) this.utter(item); }, 60);
            return true;
        }
        this.queue.push(item);
        this.queue.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
        if (this.queue.length > this.MAX_QUEUE) this.queue.length = this.MAX_QUEUE;
        return true;
    },

    speakNow(item) {
        this.current = item;
        this.utter(item);
    },

    utter(item) {
        this.suspendRecognitionForTts();
        let u;
        try { u = new SpeechSynthesisUtterance(item.text); } catch (e) { this.done(item); return; }
        if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; } else u.lang = "en-IN";
        u.rate = 1; u.pitch = 1; u.volume = 1;
        u.onend = () => this.done(item);
        u.onerror = () => this.done(item);
        clearTimeout(this.watchdog);
        // Some engines never fire onend; don't let the queue wedge.
        this.watchdog = setTimeout(() => this.done(item), Math.max(4000, item.text.length * 110));
        try { this.synth.speak(u); } catch (e) { this.done(item); }
    },

    done(item) {
        if (this.current !== item) return;          // a pre-empted utterance's late onend/onerror
        clearTimeout(this.watchdog);
        this.current = null;
        this.lastTtsEndTs = Date.now();
        const now = Date.now();
        this.queue = this.queue.filter((q) => now - q.createdAt <= q.maxAgeMs);
        const next = this.queue.shift();
        if (next) setTimeout(() => { if (!this.current) this.speakNow(next); }, 120);
        else this.resumeRecognitionAfterTts();
    },

    reply(text, extra = {}) {
        return this.announce(text, { priority: 80, force: true, ...extra });
    },

    // --------------------------------------------------------------- listening
    recognitionLang() {
        const l = navigator.language || "en-IN";
        // Indian English recognises Hinglish commands ("chalo", "ruko") better
        // than hi-IN does for our English grammar.
        return /^(en|hi)\b/i.test(l) ? "en-IN" : l;
    },

    callActive() {
        const oneToOne = typeof peerConnection !== "undefined" && Boolean(peerConnection);
        const squad = typeof VoiceSquad !== "undefined" && VoiceSquad.active;
        return oneToOne || squad;
    },

    shouldHandsFree() {
        return Boolean(this.handsFree && this.Recognition && this.driving()
            && document.visibilityState === "visible" && !this.callActive()
            && Date.now() > this.handsFreePausedUntil);
    },

    updateHandsFree() {
        const want = this.shouldHandsFree();
        if (want && !this.listenMode && !this.current) this.startListening("handsfree");
        else if (!want && this.listenMode === "handsfree") this.stopListening();
    },

    togglePushToTalk() {
        this.unlock();
        if (!this.Recognition) {
            showToast("Voice commands aren't supported in this browser — try Chrome on Android.", 4500);
            return;
        }
        if (this.listenMode === "ptt") { this.stopListening(); return; }
        if (this.callActive()) { showToast("Voice commands are paused during a call.", 3500); return; }
        if (this.current) this.silence();           // the rider wants to talk, not listen
        this.startListening("ptt");
    },

    startListening(mode) {
        this.stopRecognizerOnly();
        let r;
        try { r = new this.Recognition(); } catch (e) { return false; }
        r.lang = this.recognitionLang();
        r.interimResults = false;
        r.maxAlternatives = 3;
        r.continuous = mode === "handsfree";
        r.onresult = (e) => this.onResult(e, mode);
        r.onerror = (e) => this.onError(e, mode);
        r.onend = () => this.onEnd(r, mode);
        this.recognizer = r;
        this.listenMode = mode;
        try { r.start(); } catch (e) {
            this.recognizer = null;
            this.listenMode = null;
            return false;
        }
        this.setMicUi(true, mode);
        if (mode === "ptt") {
            const pending = this.pendingConfirm && this.pendingConfirm.until > Date.now();
            islandShow({ id: "voice-listen", kind: "info", icon: "🎙️", title: pending ? "Say “confirm SOS”" : "Listening…", sub: pending ? "Or say “cancel”" : "Try “how far?” or “where is …”", ttl: 9000, haptic: false });
        }
        return true;
    },

    stopRecognizerOnly() {
        const r = this.recognizer;
        this.recognizer = null;
        this.listenMode = null;
        if (r) { try { r.abort(); } catch (e) { /* ignore */ } }
    },

    stopListening() {
        this.stopRecognizerOnly();
        clearTimeout(this.restartTimer);
        islandHide("voice-listen");
        this.setMicUi(false);
    },

    setMicUi(on, mode) {
        ["voice-cmd-btn", "voice-cmd-map-btn"].forEach((id) => {
            const b = document.getElementById(id);
            if (!b) return;
            b.classList.toggle("listening", Boolean(on));
            b.setAttribute("aria-pressed", on ? "true" : "false");
            b.setAttribute("aria-label", on ? (mode === "handsfree" ? "Hands-free listening — tap to give a command now" : "Listening — tap to stop") : "Voice command");
        });
    },

    onResult(e, mode) {
        // Echo guard: never act on something heard while (or just after) we spoke.
        if (this.current || Date.now() - this.lastTtsEndTs < this.ECHO_GUARD_MS) return;
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            if (!res.isFinal) continue;
            const alts = [];
            for (let k = 0; k < res.length; k++) alts.push({ transcript: res[k].transcript, confidence: res[k].confidence });
            this.handleAlternatives(alts, mode);
        }
    },

    handleAlternatives(alts, mode) {
        const ctx = { mode, pendingSos: Boolean(this.pendingConfirm && this.pendingConfirm.type === "sos" && this.pendingConfirm.until > Date.now()) };
        for (const a of alts) {
            const text = normalizeSpeech(a.transcript);
            if (!text) continue;
            if (mode === "handsfree") {
                if (text.split(" ").length > 8) continue;                 // conversation, not a command
                if (a.confidence > 0 && a.confidence < 0.45) continue;
            }
            const cmd = matchVoiceCommand(text, ctx);
            if (cmd) {
                if (mode === "ptt") islandHide("voice-listen");
                this.execute(cmd);
                return true;
            }
        }
        if (mode === "ptt") {
            islandHide("voice-listen");
            this.reply("Sorry, I didn't catch a command. Say help to hear what I can do.");
        }
        return false;
    },

    onError(e, mode) {
        const err = e && e.error;
        if (err === "no-speech" || err === "aborted") return;    // normal; onend decides what's next
        const now = Date.now();
        this.errorTimes = this.errorTimes.filter((t) => now - t < 60000);
        this.errorTimes.push(now);
        if (err === "not-allowed" || err === "service-not-allowed") {
            this.handsFree = false;
            try { localStorage.setItem(this.KEY_HANDSFREE, "0"); } catch (x) { /* ignore */ }
            const t = document.getElementById("voice-handsfree-toggle");
            if (t) t.checked = false;
            showToast("Microphone access is blocked, so voice commands are off. Allow the mic in site settings to use them.", 6000);
        } else if (err === "audio-capture") {
            showToast("No microphone was found for voice commands.", 4000);
        } else if (err === "network") {
            if (mode === "ptt") showToast("Voice commands need a connection in this browser.", 4000);
        }
        if (mode === "handsfree" && this.errorTimes.length >= 5) {
            this.handsFreePausedUntil = now + 2 * 60 * 1000;
            islandShow({ id: "voice-paused", kind: "sensor", title: "Hands-free paused", sub: "Voice recognition kept failing — retrying in 2 min", ttl: 5000, haptic: false });
        }
    },

    onEnd(r, mode) {
        if (this.recognizer !== r) return;          // superseded or aborted on purpose
        this.recognizer = null;
        this.listenMode = null;
        this.setMicUi(false);
        if (mode === "ptt") islandHide("voice-listen");
        if (this.suspendedForTts) return;           // resumes after the utterance
        if (this.shouldHandsFree()) {
            // Continuous recognition still ends after silence; pick it back up.
            clearTimeout(this.restartTimer);
            this.restartTimer = setTimeout(() => { if (!this.listenMode && !this.current && this.shouldHandsFree()) this.startListening("handsfree"); }, 350);
        }
    },

    suspendRecognitionForTts() {
        if (this.listenMode === "handsfree" && this.recognizer) {
            this.suspendedForTts = true;
            this.stopRecognizerOnly();
            this.setMicUi(false);
        }
    },

    resumeRecognitionAfterTts() {
        this.suspendedForTts = false;
        clearTimeout(this.resumeTimer);
        this.resumeTimer = setTimeout(() => {
            if (this.current || this.listenMode) return;
            const pending = this.pendingConfirm && this.pendingConfirm.until > Date.now();
            if (this.shouldHandsFree()) this.startListening("handsfree");
            else if (pending) this.startListening("ptt");        // listen once more for "confirm SOS"
        }, 600);
    },

    // ---------------------------------------------------------------- commands
    execute(cmd) {
        switch (cmd.name) {
            case "help":
                this.reply("You can say: how far, where is, then a name, squad status, navigate to, then a place, start navigation, stop navigation, where am I, mute, or send S O S.");
                break;
            case "mute":
                this.mutedUntil = Date.now() + this.MUTE_MS;
                this.queue = [];
                this.reply("Alerts muted for 30 minutes. Emergency alerts still come through.");
                islandShow({ id: "voice-muted", kind: "info", icon: "🔇", title: "Voice alerts muted", sub: "30 minutes · say “unmute” to undo", ttl: 4000, haptic: false });
                break;
            case "unmute":
                this.mutedUntil = 0;
                this.reply("Voice alerts are back on.");
                break;
            case "stopNav": {
                if (navState.active || navState.ready) {
                    const wasActive = navState.active;
                    stopDrive(!wasActive);
                    this.reply(wasActive ? "Navigation ended." : "Route cancelled.");
                } else this.reply("You're not navigating right now.");
                break;
            }
            case "startNav":
                this.startNavigation();
                break;
            case "navigateTo":
                this.navigateTo(cmd.arg || "");
                break;
            case "whereAmI":
                this.whereAmI();
                break;
            case "whereIs":
                this.whereIs(cmd.arg || "");
                break;
            case "convoy":
                this.reply(typeof ConvoyIntelligence !== "undefined" ? ConvoyIntelligence.summary() : "Convoy status isn't available.");
                break;
            case "howFar":
                if ((navState.active || navState.ready) && Number.isFinite(navState.remainingM)) {
                    const next = navState.nextManeuver ? ` Next, ${lowerFirst(navState.nextManeuver)}.` : "";
                    this.reply(`${spokenDistance(navState.remainingM)} to ${navState.destName || "go"}, about ${spokenMinutes((navState.etaSec || 0) / 60)}.${next}`);
                } else this.reply("You're not navigating right now.");
                break;
            case "speed": {
                const v = typeof GpsFilter !== "undefined" ? GpsFilter.lastSmoothed : (myCoords && myCoords.speedKmh) || 0;
                this.reply(v > 3 ? `You're doing ${Math.round(v)} kilometres per hour.` : "You're not moving.");
                break;
            }
            case "recenter": {
                const b = document.getElementById("my-location-btn");
                if (myCoords) { map.flyTo([myCoords.lat, myCoords.lng], 16, { animate: true, duration: 0.8 }); this.reply("Centred on you."); }
                else if (b) { b.click(); this.reply("Still waiting for your GPS position."); }
                break;
            }
            case "sos":
                if (!myCoords) { this.reply("I can't send an S O S yet — waiting for your GPS position."); break; }
                this.pendingConfirm = { type: "sos", until: Date.now() + 10000 };
                islandShow({
                    id: "voice-sos", kind: "sos", title: "Say “confirm SOS”", sub: "Or tap to send · expires in 10 s", ttl: 10000,
                    action: { label: "Send", onClick: () => this.confirmSos() }
                });
                this.reply("Say confirm S O S within 10 seconds to alert your squad, or say cancel.", { priority: 95 });
                break;
            case "confirmSos":
                this.confirmSos();
                break;
            case "cancelPending":
                this.pendingConfirm = null;
                islandHide("voice-sos");
                this.reply("Cancelled.");
                break;
            default:
                break;
        }
    },

    confirmSos() {
        const valid = this.pendingConfirm && this.pendingConfirm.type === "sos" && this.pendingConfirm.until > Date.now();
        this.pendingConfirm = null;
        islandHide("voice-sos");
        if (!valid) { this.reply("That request expired. Say send S O S again if you need help."); return; }
        if (typeof sendSOS === "function" && sendSOS()) this.reply("S O S sent. Your squad has your location.", { priority: 100 });
        else this.reply("I couldn't send the S O S — no GPS position yet.");
    },

    startNavigation() {
        if (navState.active) { this.reply("You're already navigating."); return; }
        const startBtn = document.getElementById("btn-start-nav");
        if (navState.ready && startBtn && startBtn.style.display !== "none") { startBtn.click(); return; }   // it announces itself
        const searchBtn = document.getElementById("search-nav-btn");
        if (searchBtn && !searchBtn.disabled) {
            searchBtn.click();
            setTimeout(() => { const b = document.getElementById("btn-start-nav"); if (b && b.style.display !== "none") b.click(); }, 300);
            return;
        }
        this.reply("Search for a destination first, or say navigate to, then a place.");
    },

    async navigateTo(query) {
        const q = String(query || "").replace(/\b(please|now|right now)\b/g, " ").replace(/\s+/g, " ").trim();
        if (!q) { this.reply("Where to? Say navigate to, then a place."); return; }
        if (navState.active) { this.reply("Say stop navigation first, then ask again."); return; }
        if (!myCoords) { this.reply("I need your GPS position first."); return; }
        this.reply(`Looking for ${q}.`, { priority: 70 });
        let place = null;
        try { place = await this.findPlace(q); } catch (e) { place = null; }
        if (!place) { this.reply(`I couldn't find ${q}.`); return; }
        let route = null;
        try {
            const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${myCoords.lng},${myCoords.lat};${place.lng},${place.lat}?overview=full&geometries=geojson&steps=true`);
            const data = await r.json();
            route = data && data.routes && data.routes[0];
        } catch (e) { route = null; }
        if (!route) { this.reply(`I found ${place.name}, but couldn't get a road route there.`); return; }
        startSearchNavigation(place.lat, place.lng, place.name, route);
        this.reply(`${place.name}. ${spokenDistance(route.distance)}, about ${spokenMinutes(route.duration / 60)}. Say start navigation to go.`);
    },

    // Google Places (already loaded, key referrer-restricted) first; free
    // Nominatim as the fallback so the command still works if Places isn't up.
    findPlace(query) {
        const near = myCoords ? { lat: myCoords.lat, lng: myCoords.lng } : null;
        const viaGoogle = () => new Promise((resolve) => {
            try {
                if (!(window.google && google.maps && google.maps.places && google.maps.places.PlacesService)) return resolve(null);
                const svc = new google.maps.places.PlacesService(document.createElement("div"));
                const req = { query, fields: ["name", "geometry", "formatted_address"] };
                if (near) req.locationBias = { center: near, radius: 50000 };
                const timer = setTimeout(() => resolve(null), 6000);
                svc.findPlaceFromQuery(req, (results, status) => {
                    clearTimeout(timer);
                    const p = results && results[0];
                    if (status === google.maps.places.PlacesServiceStatus.OK && p && p.geometry && p.geometry.location) {
                        resolve({ name: p.name || query, lat: p.geometry.location.lat(), lng: p.geometry.location.lng() });
                    } else resolve(null);
                });
            } catch (e) { resolve(null); }
        });
        const viaNominatim = async () => {
            try {
                const box = near ? `&viewbox=${near.lng - 0.5},${near.lat + 0.5},${near.lng + 0.5},${near.lat - 0.5}` : "";
                const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}${box}`, { headers: { "Accept-Language": navigator.language || "en" } });
                if (!r.ok) return null;
                const j = await r.json();
                const p = j && j[0];
                if (!p) return null;
                const lat = Number(p.lat), lng = Number(p.lon);
                if (!validCoord(lat, lng)) return null;
                return { name: p.name || String(p.display_name || query).split(",")[0], lat, lng };
            } catch (e) { return null; }
        };
        return viaGoogle().then((g) => g || viaNominatim());
    },

    whereAmI() {
        if (!myCoords) { this.reply("I don't have your GPS position yet."); return; }
        const v = typeof GpsFilter !== "undefined" ? GpsFilter.lastSmoothed : 0;
        let s = `You're near ${cityName || "an unnamed area"}`;
        if (v > 3) s += `, moving at ${Math.round(v)} kilometres per hour`;
        s += ".";
        if ((navState.active || navState.ready) && Number.isFinite(navState.remainingM)) s += ` ${spokenDistance(navState.remainingM)} from ${navState.destName}.`;
        this.reply(s);
    },

    findRider(query) {
        const q = normalizeSpeech(query).replace(/\b(right now|now|please|at)\b/g, " ").replace(/\s+/g, " ").trim();
        if (!q) return null;
        let best = null;
        Object.values(friendData).forEach((f) => {
            const full = normalizeSpeech(f.name);
            if (!full) return;
            const first = full.split(" ")[0];
            let score = Infinity;
            if (full === q || first === q) score = 0;
            else if (full.includes(q) || q.includes(first)) score = 1;
            else {
                const d = Math.min(editDistance(first, q), editDistance(full, q));
                if (d <= Math.max(1, Math.floor(q.length / 4))) score = 1 + d;
            }
            if (score < Infinity && (!best || score < best.score)) best = { f, score };
        });
        return best ? best.f : null;
    },

    whereIs(query) {
        const f = this.findRider(query);
        if (!f) { this.reply(`I don't see anyone called ${normalizeSpeech(query) || "that"} on the map.`); return; }
        if (f.online === false) { this.reply(`${f.name} is offline.`); return; }
        if (!validCoord(f.lat, f.lng)) { this.reply(`${f.name} isn't sharing a location right now.`); return; }
        if (!myCoords) { this.reply(`${f.name} is on the map, but I don't have your position yet.`); return; }
        const dist = map.distance([myCoords.lat, myCoords.lng], [f.lat, f.lng]);
        const dir = compassWord(myCoords.lat, myCoords.lng, f.lat, f.lng);
        let s = `${f.name} is ${f.approx ? "roughly " : ""}${spokenDistance(dist)} ${dir} of you`;
        if (!f.approx) s += Number(f.speedKmh) > 3 ? `, moving at ${Math.round(f.speedKmh)} kilometres per hour` : ", not moving";
        s += ".";
        const extra = typeof ConvoyIntelligence !== "undefined" ? ConvoyIntelligence.sentenceFor(f.id) : "";
        if (extra) s += ` ${extra}`;
        this.reply(s);
    }
};

// ============================================================================
// 6. CONVOY INTELLIGENCE (Phase 3) — roadmap Section 4
// ============================================================================
// "Friend falling behind / stopped unexpectedly / deviated", built only on
// data the app already receives — no new sensors, no new server events:
//   - positions from `friendMoved` (sampled here into a short ring buffer),
//   - each member's real ROAD time-to-destination from the OSRM routes app.js
//     already fetches (tripRoadStats in a group trip, GroupNavigation.
//     memberStats in a meetup) — "behind" is measured in road minutes, not
//     straight-line distance,
//   - each member's route polyline, captured once as their "planned road".
// Active only while you're in a group trip or an active meetup. The first
// evaluation of each rider is silent (joining mid-trip doesn't fire a burst
// of stale alerts); after that, each flag alerts on its rising edge, at most
// once per rider per 5 minutes, and a clearing "moving again" / "back" is
// announced for the two flags that could mean trouble.
const CONVOY_CFG = {
    tickMs: 15000,
    behindMinMin: 5,          // minutes behind the lead before it counts...
    behindPct: 0.15,          // ...or 15% of that rider's own remaining time, whichever is larger
    behindClearRatio: 0.6,    // hysteresis: clears below 60% of the threshold
    behindHoldMs: 45000,      // must persist — one slow OSRM refresh isn't "behind"
    stopMs: 180000,           // stationary this long = stopped
    stopRadiusM: 80,          // parked-phone GPS jitter allowance
    movedKm: 0.3,             // must have actually ridden before a stop counts
    movingKmh: 12,
    arriveRadiusM: 250,
    offRouteM: 150,           // friends' fixes carry no accuracy value — stay conservative
    offRouteFixes: 2,         // two consecutive fixes, like the nav off-route check
    rebaseMs: 240000,         // off their planned road this long = they chose another road
    silentMs: 180000,
    realertMs: 300000,
    maxSamples: 90
};

const ConvoyIntelligence = {
    KEY_ENABLED: "mu_convoy_alerts",
    enabled: true,
    states: new Map(),
    contextKey: null,
    markedIds: new Set(),

    init() {
        try { this.enabled = localStorage.getItem(this.KEY_ENABLED) !== "0"; } catch (e) { /* keep default */ }
        const toggle = document.getElementById("convoy-alerts-toggle");
        if (toggle) {
            toggle.checked = this.enabled;
            toggle.addEventListener("change", () => {
                this.enabled = toggle.checked;
                try { localStorage.setItem(this.KEY_ENABLED, this.enabled ? "1" : "0"); } catch (e) { /* ignore */ }
            });
        }
        // app.js registered its own handlers for these first, so friendData
        // and the markers are already updated when these run.
        socket.on("friendMoved", (u) => this.onFriendMoved(u));
        socket.on("userOffline", () => this.evaluateAll("offline"));
        socket.on("userOnline", (u) => {
            const st = u && this.states.get(u.id);
            if (st) st.lastUpdateTs = Date.now();
            this.evaluateAll("online");
        });
        socket.on("friendDisconnected", () => this.evaluateAll("gone"));
        socket.on("tripData", () => setTimeout(() => this.evaluateAll("trip"), 0));
        setInterval(() => this.evaluateAll("tick"), CONVOY_CFG.tickMs);
    },

    // Which convoy are we in, and where do its numbers come from?
    context() {
        const myId = socket.id;
        if (typeof currentTrip !== "undefined" && currentTrip && Array.isArray(currentTrip.members) && currentTrip.members.some((m) => m.id === myId)) {
            return {
                key: `trip:${currentTrip.id}`, kind: "trip",
                dest: { lat: currentTrip.lat, lng: currentTrip.lng },
                memberIds: currentTrip.members.map((m) => m.id),
                etaMin: (id) => { const s = tripRoadStats[id]; const v = s ? Number(s.time) : NaN; return Number.isFinite(v) ? v : null; },
                routeFor: (id) => this.polylineFrom(tripRoutesLayer, id)
            };
        }
        if (typeof GroupNavigation !== "undefined" && GroupNavigation.active && GroupNavigation.destination) {
            const local = (id) => (id === myId ? "me" : id);
            const d = GroupNavigation.destination;
            return {
                key: `meet:${Number(d.lat).toFixed(5)},${Number(d.lng).toFixed(5)}`, kind: "meetup",
                dest: { lat: d.lat, lng: d.lng },
                memberIds: GroupNavigation.selectedMembers.map((id) => (id === "me" ? myId : id)),
                etaMin: (id) => { const s = GroupNavigation.memberStats && GroupNavigation.memberStats[local(id)]; return s && Number.isFinite(s.timeMin) ? s.timeMin : null; },
                routeFor: (id) => this.polylineFrom(GroupNavigation.layerGroup, local(id))
            };
        }
        return null;
    },

    liveEtas(ctx) {
        const myId = socket.id;
        return ctx.memberIds
            .filter((id) => id === myId || (friendData[id] && friendData[id].online !== false && !((this.states.get(id) || {}).flags || {}).silent))
            .map((id) => ctx.etaMin(id))
            .filter((v) => Number.isFinite(v));
    },

    polylineFrom(layerGroup, memberId) {
        let found = null;
        if (!layerGroup) return null;
        layerGroup.eachLayer((l) => {
            if (!found && l.memberId === memberId && typeof l.getLatLngs === "function") {
                const ll = l.getLatLngs();
                if (Array.isArray(ll) && ll.length >= 2) found = ll.map((p) => [p.lat, p.lng]);
            }
        });
        return found;
    },

    newState(id) {
        return {
            id, samples: [], lastUpdateTs: Date.now(), firstPos: null, anchor: null, everMoved: false,
            plannedPath: null, offStreak: 0, offSince: null, lastXtTs: 0, xt: null,
            behindSince: null, gapMin: null, initialized: false,
            flags: { behind: false, stopped: false, offRoute: false, silent: false, arrived: false, offline: false },
            lastAlertAt: {}
        };
    },

    reset() {
        this.states.clear();
        this.contextKey = null;
        this.applyMarkers();
        this.renderStatus(null);
    },

    onFriendMoved(u) {
        if (!u || !u.id) return;
        const ctx = this.context();
        if (!ctx || u.id === socket.id || !ctx.memberIds.includes(u.id)) return;
        if (ctx.key !== this.contextKey) { this.evaluateAll("context"); }
        let st = this.states.get(u.id);
        if (!st) { st = this.newState(u.id); this.states.set(u.id, st); }
        if (!validCoord(u.lat, u.lng)) { this.evaluateAll("sharing-off"); return; }
        const now = Date.now();
        const s = { ts: now, lat: u.lat, lng: u.lng, speedKmh: Number.isFinite(u.speedKmh) ? u.speedKmh : null };
        st.samples.push(s);
        if (st.samples.length > CONVOY_CFG.maxSamples) st.samples.shift();
        st.lastUpdateTs = now;
        if (!st.firstPos) st.firstPos = s;
        // The anchor moves only when the rider leaves an 80 m circle, so
        // `now - anchor.ts` is how long they've been parked.
        if (!st.anchor || map.distance([s.lat, s.lng], [st.anchor.lat, st.anchor.lng]) > CONVOY_CFG.stopRadiusM) st.anchor = s;
        if ((s.speedKmh || 0) > CONVOY_CFG.movingKmh || map.distance([s.lat, s.lng], [st.firstPos.lat, st.firstPos.lng]) > CONVOY_CFG.movedKm * 1000) st.everMoved = true;
        this.evaluateAll("moved");
    },

    displacementM(st, windowMs, now) {
        const recent = st.samples.filter((s) => now - s.ts <= windowMs);
        if (recent.length < 2) return 0;
        const a = recent[0], b = recent[recent.length - 1];
        return map.distance([a.lat, a.lng], [b.lat, b.lng]);
    },

    evaluateAll(reason) {
        const ctx = this.context();
        if (!ctx) { if (this.contextKey || this.states.size) this.reset(); return; }
        if (ctx.key !== this.contextKey) { this.states.clear(); this.contextKey = ctx.key; }

        const myId = socket.id;
        const now = Date.now();
        // Lead = smallest road ETA among riders with CURRENT numbers (me
        // included). A rider flagged silent has a frozen ETA — letting it
        // define the lead would measure everyone against a stale position.
        const etas = this.liveEtas(ctx);
        const leadEta = etas.length >= 2 ? Math.min(...etas) : null;

        let changed = false;
        const live = new Set();
        ctx.memberIds.forEach((id) => {
            if (id === myId) return;
            live.add(id);
            let st = this.states.get(id);
            if (!st) { st = this.newState(id); this.states.set(id, st); }
            if (this.evaluateMember(ctx, st, now, leadEta)) changed = true;
        });
        for (const id of Array.from(this.states.keys())) if (!live.has(id)) { this.states.delete(id); changed = true; }

        this.applyMarkers();
        this.renderStatus(ctx);
        if (changed && reason !== "routes" && ctx.kind === "trip" && typeof updateTripPanel === "function") updateTripPanel();
    },

    evaluateMember(ctx, st, now, leadEta) {
        const f = friendData[st.id];
        const name = (f && f.name) || "A rider";
        const last = st.samples[st.samples.length - 1];
        const pos = last || (f && validCoord(f.lat, f.lng) ? { lat: f.lat, lng: f.lng, ts: st.lastUpdateTs, speedKmh: f.speedKmh } : null);
        const prev = st.flags;
        const next = { behind: false, stopped: false, offRoute: false, silent: false, arrived: false, offline: false };

        next.offline = !f || f.online === false || !validCoord(f && f.lat, f && f.lng);
        next.silent = next.offline || now - st.lastUpdateTs > CONVOY_CFG.silentMs;
        next.arrived = Boolean(pos && map.distance([pos.lat, pos.lng], [ctx.dest.lat, ctx.dest.lng]) <= CONVOY_CFG.arriveRadiusM);

        const route = ctx.routeFor(st.id);
        if (!st.plannedPath && route) st.plannedPath = route;

        if (!next.silent && !next.arrived && pos) {
            // Stopped: they had been riding, and haven't left an 80 m circle in 3 min.
            next.stopped = Boolean(st.everMoved && st.anchor && now - st.anchor.ts >= CONVOY_CFG.stopMs);

            // Off route: cross-track distance to their PLANNED road, counted
            // once per new fix, only while actually moving.
            if (st.plannedPath && last && last.ts !== st.lastXtTs) {
                st.lastXtTs = last.ts;
                const moving = (Number(last.speedKmh) || 0) > 5 || this.displacementM(st, 30000, now) > 50;
                const xt = pointToPolylineDistanceMeters(last.lat, last.lng, st.plannedPath);
                st.xt = xt;
                if (xt > CONVOY_CFG.offRouteM && moving) { st.offStreak++; if (!st.offSince) st.offSince = now; }
                else if (xt <= CONVOY_CFG.offRouteM * 0.5) { st.offStreak = 0; st.offSince = null; }
            }
            next.offRoute = st.offStreak >= CONVOY_CFG.offRouteFixes;
            if (next.offRoute && st.offSince && now - st.offSince > CONVOY_CFG.rebaseMs && route) {
                // Four minutes on another road is a choice, not a mistake:
                // adopt their current route as the new plan and say so once.
                st.plannedPath = route;
                st.offStreak = 0;
                st.offSince = null;
                next.offRoute = false;
                if (st.initialized) this.alert(st, "rebased", {
                    island: { kind: "info", icon: "↪", title: `${name} took another road`, sub: "Tracking their new route", ttl: 4000, haptic: false },
                    speech: `${name} is taking a different road.`, voicePriority: 40
                });
            }

            // Behind: road minutes behind the lead, with hold time + hysteresis.
            const eta = ctx.etaMin(st.id);
            if (leadEta != null && Number.isFinite(eta)) {
                const gap = eta - leadEta;
                const thr = Math.max(CONVOY_CFG.behindMinMin, CONVOY_CFG.behindPct * eta);
                st.gapMin = Math.round(gap);
                if (gap >= thr) {
                    if (!st.behindSince) st.behindSince = now;
                    next.behind = now - st.behindSince >= CONVOY_CFG.behindHoldMs;
                } else if (gap < thr * CONVOY_CFG.behindClearRatio) {
                    st.behindSince = null;
                } else next.behind = prev.behind;
            } else { st.behindSince = null; st.gapMin = null; }
        } else {
            st.behindSince = null;
            st.offStreak = 0;
            st.offSince = null;
        }

        const changed = Object.keys(next).some((k) => next[k] !== prev[k]);
        if (st.initialized) this.announceTransitions(st, prev, next, name, now);
        st.flags = next;
        st.initialized = true;
        return changed;
    },

    announceTransitions(st, prev, next, name, now) {
        const rose = (k) => next[k] && !prev[k];
        const fell = (k) => !next[k] && prev[k];
        const f = friendData[st.id];
        const view = () => { if (friendData[st.id] && typeof showProfilePopup === "function") showProfilePopup(friendData[st.id]); };
        const fromMe = (() => {
            const p = st.samples[st.samples.length - 1];
            if (!p || !myCoords) return "";
            return ` · ${formatDistanceShort(map.distance([myCoords.lat, myCoords.lng], [p.lat, p.lng]))} from you`;
        })();

        if (rose("silent")) {
            const mins = Math.max(1, Math.round((now - st.lastUpdateTs) / 60000));
            this.alert(st, "silent", {
                island: { kind: "sensor", icon: "📵", title: next.offline ? `${name} went offline` : `No update from ${name}`, sub: next.offline ? "Their live location stopped" : `Nothing for ${mins} min — stopped or out of signal`, ttl: 8000, priority: 54, action: f ? { label: "View", onClick: view } : null },
                speech: next.offline ? `${name} went offline.` : `No location from ${name} for ${mins} minutes.`, voicePriority: 60
            });
        } else if (fell("silent") && !next.silent) {
            this.alert(st, "back", { island: { kind: "safe", icon: "📶", title: `${name} is back`, sub: "Live location restored", ttl: 3500, haptic: false }, speech: `${name}'s location is back.`, voicePriority: 40 }, true);
        }

        if (rose("stopped")) {
            const mins = Math.max(3, Math.round((now - st.anchor.ts) / 60000));
            this.alert(st, "stopped", {
                island: { kind: "sensor", icon: "⏸", title: `${name} has stopped`, sub: `Not moving for ${mins} min${fromMe}`, ttl: 9000, priority: 58, action: f ? { label: "View", onClick: view } : null },
                speech: `${name} has been stopped for ${mins} minutes.`, voicePriority: 70
            });
        } else if (fell("stopped") && !next.silent && !next.arrived) {
            this.alert(st, "moving", { island: { kind: "safe", icon: "▶", title: `${name} is moving again`, ttl: 3500, haptic: false }, speech: `${name} is moving again.`, voicePriority: 40 }, true);
        }

        if (rose("offRoute")) {
            this.alert(st, "offRoute", {
                island: { kind: "sensor", icon: "↪", title: `${name} left the route`, sub: `${Math.round(st.xt || 0)} m off their planned road`, ttl: 7000, priority: 54 },
                speech: `${name} has left the planned route.`, voicePriority: 55
            });
        }

        if (rose("behind")) {
            this.alert(st, "behind", {
                island: { kind: "sensor", icon: "⏳", title: `${name} is falling behind`, sub: `About ${st.gapMin} min behind the lead`, ttl: 7000, priority: 52 },
                speech: `${name} is falling behind, about ${spokenMinutes(st.gapMin)} back.`, voicePriority: 50
            });
        }

        if (rose("arrived")) {
            this.alert(st, "arrived", { island: { kind: "safe", icon: "🏁", title: `${name} arrived`, sub: "At the destination", ttl: 4000, haptic: false }, speech: `${name} has arrived.`, voicePriority: 40 });
        }
    },

    // One alert = Status Island (+ its haptics) + a spoken line. Cooldown is
    // per rider per kind; `bypassCooldown` is for the good-news clears.
    alert(st, kind, spec, bypassCooldown = false) {
        if (!this.enabled) return;
        const now = Date.now();
        if (!bypassCooldown && st.lastAlertAt[kind] && now - st.lastAlertAt[kind] < CONVOY_CFG.realertMs) return;
        st.lastAlertAt[kind] = now;
        const island = { id: `convoy-${st.id}`, ...spec.island };
        if (!island.action) delete island.action;
        islandShow(island);
        if (spec.speech) voiceAnnounce(spec.speech, { priority: spec.voicePriority || 50, key: `convoy-${kind}-${st.id}`, cooldownMs: 60000, category: "convoy" });
    },

    // Worst active issue for one rider, for the trip-panel badge.
    badgeFor(id) {
        const st = this.states.get(id);
        if (!st) return null;
        const fl = st.flags;
        if (fl.stopped && st.anchor) return { text: `⏸ Stopped ${Math.max(3, Math.round((Date.now() - st.anchor.ts) / 60000))} min`, tone: "bad" };
        if (fl.silent) return { text: fl.offline ? "📵 Offline" : "📵 No signal", tone: "bad" };
        if (fl.offRoute) return { text: "↪ Off route", tone: "warn" };
        if (fl.behind) return { text: `⏳ ${st.gapMin} min behind`, tone: "warn" };
        if (fl.arrived) return { text: "🏁 Arrived", tone: "ok" };
        return null;
    },

    sentenceFor(id) {
        const st = this.states.get(id);
        if (!st) return "";
        const f = friendData[id];
        const name = (f && f.name) || "They";
        const fl = st.flags;
        if (fl.stopped && st.anchor) return `${name} has been stopped for ${spokenMinutes((Date.now() - st.anchor.ts) / 60000)}.`;
        if (fl.silent) return fl.offline ? `${name} is offline.` : `There's been no location from ${name} for ${spokenMinutes((Date.now() - st.lastUpdateTs) / 60000)}.`;
        if (fl.offRoute) return `${name} is off the planned route.`;
        if (fl.behind) return `${name} is about ${spokenMinutes(st.gapMin)} behind the lead.`;
        if (fl.arrived) return `${name} has arrived.`;
        return "";
    },

    summary() {
        const ctx = this.context();
        if (!ctx) return "You're not in a group trip or meetup right now.";
        const ids = ctx.memberIds.filter((id) => id !== socket.id);
        if (!ids.length) return "No one else is in this convoy yet.";
        const order = (id) => { const fl = (this.states.get(id) || {}).flags || {}; return fl.stopped ? 0 : fl.silent ? 1 : fl.offRoute ? 2 : fl.behind ? 3 : fl.arrived ? 4 : 5; };
        const sentences = ids.slice().sort((a, b) => order(a) - order(b)).map((id) => this.sentenceFor(id)).filter(Boolean);
        const problems = ids.filter((id) => order(id) <= 3).length;
        let s = problems === 0 ? `All ${ids.length + 1} riders are together.` : "";
        if (sentences.length) s += (s ? " " : "") + sentences.slice(0, 3).join(" ");
        const etas = this.liveEtas(ctx);
        if (etas.length) s += ` The lead is about ${spokenMinutes(Math.min(...etas))} from the destination.`;
        return s.trim();
    },

    renderStatus(ctx) {
        ["convoy-status", "convoy-status-meetup"].forEach((hostId) => {
            const host = document.getElementById(hostId);
            if (!host) return;
            host.textContent = "";
            const relevant = ctx && ((hostId === "convoy-status" && ctx.kind === "trip") || (hostId === "convoy-status-meetup" && ctx.kind === "meetup"));
            if (!relevant) { host.hidden = true; return; }
            host.hidden = false;
            const ids = ctx.memberIds.filter((id) => id !== socket.id);
            const label = document.createElement("span");
            label.className = "convoy-label";
            label.textContent = "Convoy";
            host.appendChild(label);
            const issues = ids.map((id) => ({ id, badge: this.badgeFor(id) })).filter((x) => x.badge && x.badge.tone !== "ok");
            if (!ids.length) {
                const c = document.createElement("span"); c.className = "chip"; c.textContent = "Waiting for riders"; host.appendChild(c);
                return;
            }
            if (!issues.length) {
                const c = document.createElement("span"); c.className = "chip ok"; c.textContent = `Together · ${ids.length + 1} riders`; host.appendChild(c);
                return;
            }
            issues.forEach(({ id, badge }) => {
                const c = document.createElement("span");
                c.className = `chip ${badge.tone}`;
                const f = friendData[id];
                c.textContent = `${(f && f.name) || "Rider"}: ${badge.text}`;
                host.appendChild(c);
            });
        });
    },

    // A status ring on the friend's map marker (text lives in the badge /
    // status line, so this is never color alone).
    applyMarkers() {
        const now = new Set();
        this.states.forEach((st, id) => {
            const m = typeof friendMarkers !== "undefined" ? friendMarkers[id] : null;
            const el = m && typeof m.getElement === "function" ? m.getElement() : null;
            if (!el) return;
            const fl = st.flags;
            const state = fl.stopped ? "stopped" : fl.silent ? "silent" : (fl.offRoute || fl.behind) ? "warn" : "";
            if (state) { el.setAttribute("data-convoy", state); now.add(id); }
            else el.removeAttribute("data-convoy");
        });
        this.markedIds.forEach((id) => {
            if (now.has(id)) return;
            const m = typeof friendMarkers !== "undefined" ? friendMarkers[id] : null;
            const el = m && typeof m.getElement === "function" ? m.getElement() : null;
            if (el) el.removeAttribute("data-convoy");
        });
        this.markedIds = now;
    }
};

// ============================================================================
// BOOT
// ============================================================================
// Window handles: app.js reaches these through `window.X` (never the bare
// name) so a call that races script evaluation can't hit a TDZ error.
window.VoiceAssistant = VoiceAssistant;
window.ConvoyIntelligence = ConvoyIntelligence;

document.addEventListener("DOMContentLoaded", () => {
    const boot = [
        ["Voice squad", () => VoiceSquad.init()],
        ["P2P radar", () => P2PRadar.init()],
        ["Voice assistant", () => VoiceAssistant.init()],
        ["Convoy intelligence", () => ConvoyIntelligence.init()]
    ];
    boot.forEach(([name, fn]) => { try { fn(); } catch (e) { console.error(`[features] ${name} failed to start:`, e); } });
});
