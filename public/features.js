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

     PHASE 4 (roadmap Section 5 — experimental):
     7. MeshtasticLink — Web Bluetooth to a Meshtastic LoRa radio (the
        phone-to-phone path a browser can't do by itself): GATT ToRadio /
        FromRadio / FromNum, the want_config handshake, PRIVATE_APP packets,
        auto-reconnect, and plain-language warnings about the radio's own
        setup (region unset, transmit off, public channel).
     8. ConvoyRelay — position pings and SOS over the radio when mobile data
        drops: AES-GCM with a per-trip key (the default Meshtastic channel is
        public), a per-rider HMAC the server checks, last-writer-wins per
        rider, store-and-forward upload by any rider who still has data, and
        radio acks so an SOS sender hears "Rahul put your SOS online".
     2. (rewritten) The radar panel now shows riders heard over the radio —
        real distance/bearing from their own frames — beside riders known via
        the network, on a north-up canvas plus a text list.
     5. (extended) Voice: "radio status"; SOS confirmation says honestly
        whether it went online, over the radio, or is queued.

     PHASE 5 (roadmap — rare & experimental), core logic:
     9. RelativeMotion — per-rider velocity from a weighted least-squares fit
        of their recent track, then bearing, closing speed, closest point of
        approach and time-to-meet between you and each rider: "approaching /
        meeting / passed / moving away / holding distance", with confidence.
    10. ConvoyRegroup — a small graph over riders' travel times to the shared
        destination (road ETAs + direct along-road gaps), solved by weighted
        least squares, turned into safe suggestions: who eases off to what
        speed, who pauses for how long, where the convoy closes up. Never
        suggests speeding. Emits `mu:regroup`; no new socket events.
    11. Phase5UI — puts both on screen and in voice: motion line in the rider
        popup, motion label + arrow on the radar, regroup block in the trip
        panel / meetup sheet, a "Regroup here" pin, your own suggestion
        spoken once per change, a heads-up when a convoy rider is about to
        meet you, and the voice commands "regroup" / "who's approaching".
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
// 2. RADIO RADAR (Phase 4) — the old "P2P Radar", now real
// ============================================================================
// Phase 2 left this honestly labelled: Web Bluetooth could find "a Bluetooth
// device", not other riders. Phase 4 makes it real (see sections 7–8): pair
// a Meshtastic LoRa radio and this panel shows riders heard OVER THE RADIO —
// real distance and bearing from their own encrypted position frames — next
// to riders known via the network, each labelled with how we know. The
// canvas is a north-up radar of both; the list below it carries the same
// information as text (the canvas is aria-hidden).
const P2PRadar = {
    isOpen: false,

    init() {
        const radarBtn = document.getElementById("p2p-radar-btn");
        const panel = document.getElementById("radar-panel");
        const closeRadar = document.getElementById("close-radar");
        if (!radarBtn || !panel) return;
        this.panel = panel;
        radarBtn.addEventListener("click", () => (this.isOpen ? this.hide() : this.show()));
        if (closeRadar) closeRadar.addEventListener("click", () => this.hide());
        const connect = document.getElementById("relay-connect-btn");
        if (connect) connect.addEventListener("click", () => this.onConnectClick());
        const chip = document.getElementById("relay-chip");
        if (chip) chip.addEventListener("click", () => this.show());
        ConvoyRelay.onChange(() => { this.renderChip(); if (this.isOpen) this.render(); });
        setInterval(() => { this.renderChip(); if (this.isOpen) this.render(); }, 5000);
        this.renderChip();
    },

    show() { this.panel.style.display = "block"; this.isOpen = true; this.render(); },
    hide() { this.panel.style.display = "none"; this.isOpen = false; },

    async onConnectClick() {
        const st = MeshtasticLink.state;
        if (!MeshtasticLink.supported()) { this.render(); return; }
        if (st === "idle" || st === "error") {
            try { await MeshtasticLink.pair(); }
            catch (e) {
                if (e && e.name === "NotFoundError") MeshtasticLink.setState("idle", "No radio selected.");
                else MeshtasticLink.setState("error", (e && e.message) || "Couldn't connect to the radio.");
            }
        } else {
            await MeshtasticLink.disconnect();
        }
        this.render();
    },

    bearingCompass(lat1, lng1, lat2, lng2) {
        const toRad = (d) => (d * Math.PI) / 180;
        const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
        const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
        const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
        const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
        return dirs[Math.round(deg / 45) % 8];
    },

    // Riders with a live socket, from the server — labelled "network".
    nearbyViaNetwork(maxKm = 20) {
        const me = (typeof myCoords !== "undefined" && myCoords) || null;
        if (!me) return [];
        return Object.values(typeof friendData !== "undefined" ? friendData : {})
            .filter((f) => f.online !== false && typeof validCoord === "function" && validCoord(f.lat, f.lng))
            .map((f) => ({ id: f.id, name: f.name, lat: f.lat, lng: f.lng, km: Number(distanceKm(me.lat, me.lng, f.lat, f.lng)), bearing: this.bearingCompass(me.lat, me.lng, f.lat, f.lng), src: "network", est: f.est }))
            .filter((f) => Number.isFinite(f.km) && f.km <= maxKm)
            .sort((a, b) => a.km - b.km);
    },

    viaRadio() {
        const me = (typeof myCoords !== "undefined" && myCoords) || null;
        return ConvoyRelay.heardRecently().map((h) => ({
            id: (ConvoyRelay.friendFor(h) || {}).id || null, name: h.name, lat: h.lat, lng: h.lng, src: "radio", est: h.est, sos: h.type === RelayFrame.SOS && Date.now() - h.ts < 15 * 60000,
            km: me ? Number(distanceKm(me.lat, me.lng, h.lat, h.lng)) : null, bearing: me ? this.bearingCompass(me.lat, me.lng, h.lat, h.lng) : "",
            ts: h.ts, snr: h.snr, hops: h.hops, offline: h.offline
        }));
    },

    statusText() {
        const L = MeshtasticLink, R = ConvoyRelay;
        if (!L.supported()) return "Web Bluetooth isn't available in this browser. On Android use Chrome; on iPhone, the Bluefy browser.";
        switch (L.state) {
            case "idle": return L.lastError || "Pair a Meshtastic LoRa radio to keep the squad connected with no mobile data.";
            case "connecting": case "configuring": return `Connecting to ${L.deviceName()}…`;
            case "reconnecting": return `Radio disconnected — reconnecting…${L.lastError ? ` (${L.lastError})` : ""}`;
            case "error": return `Radio problem: ${L.lastError}`;
            default: break;
        }
        if (!R.creds) {
            if (!R.inTrip()) return `${L.deviceName()} connected. The relay switches on inside a group trip.`;
            return R.online() ? `${L.deviceName()} connected — fetching this trip's keys…` : `${L.deviceName()} connected, but it needs data once to fetch this trip's keys.`;
        }
        const s = R.stats;
        return `Relay on · ${R.online() ? "you have data" : "no data — radio only"} · sent ${s.tx} · heard ${s.rx}${s.uploaded ? ` · put ${s.uploaded} online` : ""}`;
    },

    render() {
        const status = document.getElementById("radar-status");
        if (status) status.textContent = this.statusText();
        const btn = document.getElementById("relay-connect-btn");
        if (btn) {
            const st = MeshtasticLink.state;
            btn.hidden = !MeshtasticLink.supported();
            btn.disabled = st === "connecting" || st === "configuring";
            btn.textContent = st === "idle" || st === "error" ? "Connect radio" : st === "reconnecting" ? "Stop reconnecting" : st === "ready" ? "Disconnect radio" : "Connecting…";
        }
        const warn = document.getElementById("relay-warn");
        if (warn) {
            const w = MeshtasticLink.warnings();
            warn.hidden = !w.length;
            warn.textContent = w.join(" ");
        }
        const list = document.getElementById("peer-list");
        const radio = this.viaRadio();
        const net = this.nearbyViaNetwork().filter((n) => !radio.some((r) => r.name === n.name));
        if (list) {
            list.textContent = "";
            const add = (cls, text) => { const li = document.createElement("li"); li.className = cls; li.textContent = text; list.appendChild(li); };
            radio.forEach((r) => {
                const where = Number.isFinite(r.km) ? `${r.km.toFixed(1)} km ${r.bearing}` : "position received";
                const extra = [agoText(r.ts), Number.isFinite(r.snr) ? `SNR ${r.snr} dB` : "", Number.isFinite(r.hops) ? `${r.hops} hop${r.hops === 1 ? "" : "s"}` : "", r.offline ? "no data" : ""].filter(Boolean).join(" · ");
                const mo = Phase5UI.motionFor(r.id);
                add(`peer radio${r.sos ? " sos" : ""}`, `${r.sos ? "🆘 " : "📻 "}${r.name}${r.est ? " (estimated)" : ""} — ${where} · ${extra}${mo ? ` · ${mo.text}` : ""}`);
            });
            net.forEach((n) => {
                const mo = Phase5UI.motionFor(n.id);
                add("peer network", `📶 ${n.name}${n.est ? " (estimated)" : ""} — ${n.km.toFixed(1)} km ${n.bearing} · via network${mo ? ` · ${mo.text}` : ""}`);
            });
            if (!radio.length && !net.length) add("peer empty", MeshtasticLink.state === "ready" ? "No riders heard on the radio yet." : "No riders nearby.");
        }
        this.drawCanvas(radio.concat(net));
    },

    renderChip() {
        const chip = document.getElementById("relay-chip");
        if (!chip) return;
        const ready = MeshtasticLink.state === "ready";
        chip.hidden = !(ready || MeshtasticLink.state === "reconnecting");
        const n = ConvoyRelay.heardRecently().length;
        const t = document.getElementById("relay-chip-text");
        if (t) t.textContent = !ready ? "Radio…" : ConvoyRelay.creds ? `Radio · ${n}` : "Radio";
        chip.dataset.state = ready ? (ConvoyRelay.creds ? "on" : "idle") : "reconnecting";
        chip.setAttribute("aria-label", ready ? `Radio relay on, ${n} rider${n === 1 ? "" : "s"} heard. Open radar.` : "Radio reconnecting. Open radar.");
    },

    drawCanvas(points) {
        const cvs = document.getElementById("radar-canvas");
        if (!cvs || !cvs.getContext) return;
        const css = cvs.clientWidth || 280;
        const dpr = Math.min(3, window.devicePixelRatio || 1);
        if (cvs.width !== Math.round(css * dpr)) { cvs.width = Math.round(css * dpr); cvs.height = Math.round(css * dpr); }
        const ctx = cvs.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, css, css);
        const c = css / 2, R = c - 18;
        const me = (typeof myCoords !== "undefined" && myCoords) || null;
        const pts = me ? points.filter((p) => Number.isFinite(p.km)) : [];
        const far = Math.max(0.5, ...pts.map((p) => p.km));
        const nice = [0.5, 1, 2, 5, 10, 20, 50].find((v) => v >= far) || 50;
        ctx.lineWidth = 1;
        ctx.font = "10.5px Inter, system-ui, sans-serif";
        for (let i = 1; i <= 3; i++) {
            const r = (R * i) / 3;
            ctx.strokeStyle = "rgba(255,255,255,0.10)";
            ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.stroke();
            ctx.fillStyle = "rgba(139,155,171,0.95)";
            const km = (nice * i) / 3;
            ctx.fillText(km < 1 ? `${Math.round(km * 1000)} m` : `${Math.round(km * 10) / 10} km`, c + 4, c - r + 12);
        }
        ctx.fillStyle = "rgba(198,210,219,0.9)";
        ctx.textAlign = "center";
        ctx.fillText("N", c, 11);
        ctx.textAlign = "left";
        // me
        ctx.fillStyle = "#34e0b4";
        ctx.beginPath(); ctx.arc(c, c, 5, 0, Math.PI * 2); ctx.fill();
        if (!me) {
            ctx.fillStyle = "rgba(139,155,171,0.95)"; ctx.textAlign = "center";
            ctx.fillText("Waiting for your position", c, c + 22); ctx.textAlign = "left";
            return;
        }
        pts.forEach((p) => {
            const brg = (DRMath.bearing(me.lat, me.lng, p.lat, p.lng) * Math.PI) / 180;
            const r = Math.min(R, (p.km / nice) * R);
            const x = c + r * Math.sin(brg), y = c - r * Math.cos(brg);
            const col = p.src === "radio" ? (p.sos ? "#ff2d55" : "#ff9f0a") : "#5ac8fa";
            ctx.fillStyle = col;
            ctx.strokeStyle = "#0e1724";
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(x, y, p.sos ? 7 : 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            // Phase 5: relative-motion arrow = where this rider drifts, relative
            // to you, over the next minute (same scale as the rings).
            const mo = p.id ? Phase5UI.motionFor(p.id) : null;
            if (mo && mo.rel.relVelMs && mo.rel.relSpeedMs > 1) {
                const k = (60 / 1000 / nice) * R;                       // px per (m/s) over 60 s
                const len = Math.min(R * 0.6, Math.max(10, mo.rel.relSpeedMs * k));
                const ang = Math.atan2(mo.rel.relVelMs[0], mo.rel.relVelMs[1]);
                const x2 = x + len * Math.sin(ang), y2 = y - len * Math.cos(ang);
                ctx.strokeStyle = col; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(x2, y2);
                ctx.lineTo(x2 - 7 * Math.sin(ang - 0.45), y2 + 7 * Math.cos(ang - 0.45));
                ctx.lineTo(x2 - 7 * Math.sin(ang + 0.45), y2 + 7 * Math.cos(ang + 0.45));
                ctx.closePath(); ctx.fillStyle = col; ctx.fill();
                ctx.strokeStyle = "#0e1724";
            }
            ctx.fillStyle = "#f2f6f8";
            const label = `${p.src === "radio" ? "📻 " : ""}${p.name}`;
            const w = ctx.measureText(label).width;
            ctx.fillText(label, Math.max(2, Math.min(css - w - 2, x + 9)), Math.max(12, Math.min(css - 4, y + 4)));
        });
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
    { name: "routeAvoid", test: (t) => {
        const R = "(tolls?|toll roads?|highways?|motorways?|expressways?)";
        const m = new RegExp(`^(?:please\\s+)?(avoid|no|skip|allow|use)\\s+(?:the\\s+)?${R}(?:\\s+(?:and|or)\\s+${R})?$`).exec(t);
        if (!m) return false;
        const cls = (w) => (w && /^toll/.test(w) ? "toll" : w ? "motorway" : null);
        const list = [cls(m[2]), cls(m[3])].filter(Boolean);
        return `${/^(allow|use)$/.test(m[1]) ? "allow" : "avoid"}:${[...new Set(list)].join(",")}`;
    } },
    { name: "navigateTo", test: (t) => { const m = /\b(?:navigate|take me|directions|route me|drive me|go|get me|chalo)\s+to\s+(.+)$/.exec(t); return m ? m[1] : false; } },
    { name: "startNav", test: (t) => /\b(start|begin|resume)\b.*\b(navigation|navigating|drive|ride|route|trip)\b|\blet'?s go\b|\bchalo\b|^go$/.test(t) },
    { name: "whereAmI", test: (t) => /\bwhere am i\b|\bmain kahan hu\b/.test(t) },
    { name: "convoy", test: (t) => /\b(squad|convoy|group|team)\b.*\b(status|update|check|report)\b|\bwhere is everyone\b|\bwhere's everyone\b|\beveryone ok\b|\bsab kahan hai\b/.test(t) },
    { name: "regroup", test: (t) => /\b(regroup|re group|close up|should i (slow down|wait|speed up|stop))\b/.test(t) },
    { name: "approaching", test: (t) => /\b(who'?s|who is) (approaching|coming|closing in|getting closer)\b|\banyone (approaching|coming|close)\b/.test(t) },
    { name: "radio", test: (t) => /\b(radio|mesh|lora)\b.*\b(status|check|update|report|anyone|who)\b|\bwho can (you|i) hear\b|^(radio|mesh|lora)$/.test(t) },
    { name: "whereIs", test: (t) => { const m = /\bwhere(?:'s| is)\s+(.+)$/.exec(t) || /^(.+?)\s+kahan hai$/.exec(t); return m ? m[1] : false; } },
    { name: "howFar", test: (t) => /\b(how far|how long|eta|time left|distance left|remaining|kitna door|kitni der|when will i (arrive|get there))\b/.test(t) },
    { name: "speedLimit", test: (t) => /\b(speed limit|what'?s the limit|limit here|how fast can i go)\b/.test(t) },
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
                this.reply("You can say: how far, where is, then a name, squad status, radio status, regroup, who's approaching, speed limit, avoid tolls, navigate to, then a place, start navigation, stop navigation, where am I, mute, or send S O S.");
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
            case "radio":
                this.reply(ConvoyRelay.summary());
                break;
            case "regroup":
                this.reply(Phase5UI.regroupSummary());
                break;
            case "speedLimit":
                this.reply(typeof SpeedLimits !== "undefined" ? SpeedLimits.describe() : "I don't know the speed limit here.");
                break;
            case "routeAvoid": {
                if (typeof RoutePrefs === "undefined" || !cmd.arg) { this.reply("Route options aren't available right now."); break; }
                const [verb, list] = cmd.arg.split(":");
                const on = verb === "avoid";
                list.split(",").forEach((c) => { if (c === "toll") RoutePrefs.avoidTolls = on; if (c === "motorway") RoutePrefs.avoidHighways = on; });
                RoutePrefs.lastNoticeAt = 0;
                RoutePrefs.save();
                const what = RoutePrefs.describe(list.split(","));
                const later = typeof navState !== "undefined" && navState.active ? " Your current route stays as it is; the next route will follow this." : "";
                this.reply(on ? `OK. Routes will avoid ${what}.${later}` : `OK. Routes can use ${what} again.${later}`);
                break;
            }
            case "approaching":
                this.reply(Phase5UI.motionSummary());
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
        const how = typeof sendSOS === "function" ? sendSOS() : false;
        if (how === "radio") this.reply("No mobile data here. S O S sent over the radio — I'll tell you when a rider confirms it.", { priority: 100 });
        else if (how === "queued") this.reply("No connection right now. Your S O S will send the moment you're back online.", { priority: 100 });
        else if (how) this.reply("S O S sent. Your squad has your location.", { priority: 100 });
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
            // Honours the rider's avoid-highways/tolls setting (app.js RoutePrefs).
            const url = `https://router.project-osrm.org/route/v1/driving/${myCoords.lng},${myCoords.lat};${place.lng},${place.lat}?overview=full&geometries=geojson&steps=true`;
            const data = typeof RoutePrefs !== "undefined" ? await RoutePrefs.fetchRoute(url) : await (await fetch(url)).json();
            route = data && data.routes && data.routes[0];
            if (route) route.avoidInfo = data.avoid || null;
        } catch (e) { route = null; }
        if (!route) { this.reply(`I found ${place.name}, but couldn't get a road route there.`); return; }
        startSearchNavigation(place.lat, place.lng, place.name, route);
        // The rider isn't looking at a toast: SAY when the avoid setting couldn't be met.
        const av = route.avoidInfo;
        let caveat = "";
        if (av && av.requested.length) {
            const missed = av.requested.filter((c) => !av.applied.includes(c));
            caveat = missed.length ? ` This route can't avoid ${RoutePrefs.describe(missed)}.` : ` Avoiding ${RoutePrefs.describe(av.requested)}.`;
        }
        this.reply(`${place.name}. ${spokenDistance(route.distance)}, about ${spokenMinutes(route.duration / 60)}.${caveat} Say start navigation to go.`);
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
        if (myCoords.est) s += ` GPS is lost, so that's an estimate, good to about ${spokenDistance(myCoords.accuracy || 0)}.`;
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
        const radio = f.online === false && typeof friendIsLive === "function" && friendIsLive(f);
        if (f.online === false && !radio) { this.reply(`${f.name} is offline.`); return; }
        if (!validCoord(f.lat, f.lng)) { this.reply(`${f.name} isn't sharing a location right now.`); return; }
        if (!myCoords) { this.reply(`${f.name} is on the map, but I don't have your position yet.`); return; }
        const dist = map.distance([myCoords.lat, myCoords.lng], [f.lat, f.lng]);
        const dir = compassWord(myCoords.lat, myCoords.lng, f.lat, f.lng);
        let s = `${f.name} is ${f.approx || f.est ? "roughly " : ""}${spokenDistance(dist)} ${dir} of you`;
        if (!f.approx) s += Number(f.speedKmh) > 3 ? `, moving at ${Math.round(f.speedKmh)} kilometres per hour` : ", not moving";
        s += ".";
        if (radio) s += ` They have no mobile data; that position came over the radio ${agoText(f.fixAt || f.viaAt)}.`;
        // Phase 5: how you're moving relative to each other.
        const mo = Phase5UI.motionFor(f.id);
        if (mo && mo.rel.status === "meeting") s += ` You're closing at ${Math.round(mo.rel.closingMs * 3.6)} kilometres per hour and should meet in about ${spokenMinutes(mo.rel.meetInS / 60)}.`;
        else if (mo && mo.rel.status === "approaching") s += ` You're getting closer, but on this heading you'll pass about ${spokenDistance(mo.rel.cpaM)} apart.`;
        else if (mo && mo.rel.status === "passed") s += " You passed each other a moment ago.";
        else if (mo && mo.rel.status === "moving-away") s += " You're moving apart.";
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
            .filter((id) => id === myId || (friendIsLive(friendData[id]) && !((this.states.get(id) || {}).flags || {}).silent))
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
        // Phase 4: say once when a rider drops to the radio relay.
        const radio = u.via === "radio";
        if (radio && !st.viaRadio && st.initialized) {
            const name = u.name || (friendData[u.id] && friendData[u.id].name) || "A rider";
            this.alert(st, "radio", {
                island: { kind: "sensor", icon: "📻", title: `${name} has no mobile data`, sub: "Following them over the radio relay", ttl: 6000, haptic: false },
                speech: `${name} is out of mobile signal. Following them over the radio.`, voicePriority: 45
            });
        }
        st.viaRadio = radio;
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
        document.dispatchEvent(new CustomEvent("mu:convoy-evaluated", { detail: { reason } }));   // Phase 5: ConvoyRegroup listens
    },

    evaluateMember(ctx, st, now, leadEta) {
        const f = friendData[st.id];
        const name = (f && f.name) || "A rider";
        const last = st.samples[st.samples.length - 1];
        const pos = last || (f && validCoord(f.lat, f.lng) ? { lat: f.lat, lng: f.lng, ts: st.lastUpdateTs, speedKmh: f.speedKmh } : null);
        const prev = st.flags;
        const next = { behind: false, stopped: false, offRoute: false, silent: false, arrived: false, offline: false };

        // Phase 4: a rider still heard over the radio relay isn't "offline".
        next.offline = !f || !friendIsLive(f) || !validCoord(f && f.lat, f && f.lng);
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
// 7. MESHTASTIC LINK (Phase 4) — Web Bluetooth to a LoRa radio
// ============================================================================
// A browser tab can only be a Bluetooth CENTRAL: it connects TO a device, it
// can't advertise itself for another phone to find (roadmap Section 5). So
// phone-to-phone relay goes through a radio each rider carries: Meshtastic
// firmware on an ESP32/nRF52 LoRa board (Heltec V3, T-Beam, RAK WisBlock,
// T-Echo …). Phone -> BLE -> its radio -> LoRa (km, multi-hop) -> other
// radios -> BLE -> their phones.
//
// Wire protocol = Meshtastic's documented phone API, verified against the
// official protobufs (meshtastic/protobufs mesh.proto / config.proto /
// channel.proto) and the official web client's BLE transport:
//   - GATT service 6ba1b218-…, write ToRadio, read FromRadio until empty,
//     FromNum notifies "there's more to read";
//   - handshake ToRadio.want_config_id = nonce; the radio streams its config
//     and only delivers mesh packets after FromRadio.config_complete_id;
//   - our data rides in MeshPacket.decoded {portnum: PRIVATE_APP (256)} —
//     not rate-limited by the firmware and not shown as chat on other
//     Meshtastic apps — broadcast, hop_limit 3.
// Only the handful of protobuf fields this needs are encoded/decoded, by
// hand (no dependency); unknown fields are skipped per the wire format.
const MeshProto = {
    PORT_ROUTING: 5,
    PORT_PRIVATE: 256,
    BROADCAST: 0xffffffff,
    PRIORITY_DEFAULT: 64,
    PRIORITY_ALERT: 110,

    // ---- writer ----
    pushVarint(out, v) {
        let n = Math.floor(Number(v));
        if (!(n >= 0)) n = 0;
        while (n > 0x7f) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); }
        out.push(n);
    },
    pushTag(out, field, wire) { this.pushVarint(out, field * 8 + wire); },
    pushFixed32(out, field, v) {
        const n = Number(v) >>> 0;
        this.pushTag(out, field, 5);
        out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
    },
    pushBytes(out, field, bytes) {
        this.pushTag(out, field, 2);
        this.pushVarint(out, bytes.length);
        for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
    },
    pushUint(out, field, v) { this.pushTag(out, field, 0); this.pushVarint(out, v); },

    encodeData({ portnum, payload, wantResponse = false }) {
        const out = [];
        this.pushUint(out, 1, portnum);                         // Data.portnum
        this.pushBytes(out, 2, payload);                        // Data.payload
        if (wantResponse) this.pushUint(out, 3, 1);             // Data.want_response
        return out;
    },
    encodeMeshPacket({ to = this.BROADCAST, channel = 0, data, id, hopLimit = 0, wantAck = false, priority = 0 }) {
        const out = [];
        this.pushFixed32(out, 2, to);                           // MeshPacket.to (fixed32)
        if (channel) this.pushUint(out, 3, channel);            // MeshPacket.channel
        this.pushBytes(out, 4, this.encodeData(data));          // MeshPacket.decoded (oneof)
        if (id) this.pushFixed32(out, 6, id);                   // MeshPacket.id (fixed32)
        if (hopLimit) this.pushUint(out, 9, hopLimit);          // MeshPacket.hop_limit
        if (wantAck) this.pushUint(out, 10, 1);                 // MeshPacket.want_ack
        if (priority) this.pushUint(out, 11, priority);         // MeshPacket.priority
        return out;
    },
    encodeToRadioPacket(pkt) { const out = []; this.pushBytes(out, 1, this.encodeMeshPacket(pkt)); return new Uint8Array(out); },   // ToRadio.packet
    encodeWantConfig(nonce) { const out = []; this.pushUint(out, 3, nonce); return new Uint8Array(out); },                         // ToRadio.want_config_id
    encodeDisconnect() { return new Uint8Array([4 << 3, 1]); },                                                                     // ToRadio.disconnect = true
    encodeHeartbeat() { return new Uint8Array([(7 << 3) | 2, 0]); },                                                                // ToRadio.heartbeat = {}

    // ---- reader ----
    readVarint(buf, pos) {
        let lo = 0, hi = 0, shift = 0;
        for (let i = 0; i < 10; i++) {
            if (pos >= buf.length) throw new Error("truncated varint");
            const b = buf[pos++];
            if (shift < 28) lo |= (b & 0x7f) << shift;
            else if (shift === 28) { lo |= (b & 0x0f) << 28; hi |= (b & 0x7f) >>> 4; }
            else hi |= (b & 0x7f) << (shift - 32);
            shift += 7;
            if (!(b & 0x80)) return { lo: lo >>> 0, hi: hi >>> 0, pos };
        }
        throw new Error("varint too long");
    },
    // [{field, wire, lo, hi, bytes}] — wire 0 varint (lo/hi), 1 fixed64, 2 bytes, 5 fixed32 (lo + bytes)
    fields(buf) {
        const out = [];
        let pos = 0;
        while (pos < buf.length) {
            const t = this.readVarint(buf, pos); pos = t.pos;
            const field = Math.floor((t.hi * 4294967296 + t.lo) / 8), wire = t.lo & 7;
            if (wire === 0) { const v = this.readVarint(buf, pos); pos = v.pos; out.push({ field, wire, lo: v.lo, hi: v.hi }); }
            else if (wire === 1) { if (pos + 8 > buf.length) throw new Error("truncated fixed64"); out.push({ field, wire, bytes: buf.subarray(pos, pos + 8) }); pos += 8; }
            else if (wire === 2) {
                const l = this.readVarint(buf, pos); pos = l.pos;
                const len = l.hi * 4294967296 + l.lo;
                if (pos + len > buf.length) throw new Error("truncated bytes");
                out.push({ field, wire, bytes: buf.subarray(pos, pos + len) }); pos += len;
            } else if (wire === 5) {
                if (pos + 4 > buf.length) throw new Error("truncated fixed32");
                const b = buf.subarray(pos, pos + 4);
                out.push({ field, wire, lo: (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0, bytes: b }); pos += 4;
            } else throw new Error(`unsupported wire type ${wire}`);
        }
        return out;
    },
    u(f) { return f.hi * 4294967296 + f.lo; },                   // unsigned varint / fixed32
    i32(f) { return f.lo | 0; },                                  // int32 (negatives are 10-byte varints)
    f32(f) { return new DataView(f.bytes.buffer, f.bytes.byteOffset, 4).getFloat32(0, true); },

    decodeData(buf) {
        const d = { portnum: 0, payload: new Uint8Array(0), requestId: null };
        for (const f of this.fields(buf)) {
            if (f.field === 1 && f.wire === 0) d.portnum = this.u(f);
            else if (f.field === 2 && f.wire === 2) d.payload = f.bytes;
            else if (f.field === 6 && f.wire === 5) d.requestId = f.lo;       // Data.request_id (fixed32)
        }
        return d;
    },
    decodeMeshPacket(buf) {
        const p = { from: 0, to: 0, channel: 0, id: 0, decoded: null, encrypted: false, rxSnr: null, rxRssi: null, hopLimit: null, hopStart: null, rxTime: null };
        for (const f of this.fields(buf)) {
            switch (f.field) {
                case 1: if (f.wire === 5) p.from = f.lo; break;
                case 2: if (f.wire === 5) p.to = f.lo; break;
                case 3: if (f.wire === 0) p.channel = this.u(f); break;
                case 4: if (f.wire === 2) p.decoded = this.decodeData(f.bytes); break;
                case 5: if (f.wire === 2) p.encrypted = true; break;
                case 6: if (f.wire === 5) p.id = f.lo; break;
                case 7: if (f.wire === 5) p.rxTime = f.lo; break;
                case 8: if (f.wire === 5) p.rxSnr = Math.round(this.f32(f) * 10) / 10; break;
                case 9: if (f.wire === 0) p.hopLimit = this.u(f); break;
                case 12: if (f.wire === 0) p.rxRssi = this.i32(f); break;
                case 15: if (f.wire === 0) p.hopStart = this.u(f); break;
                default: break;
            }
        }
        return p;
    },
    decodeRouting(buf) {
        for (const f of this.fields(buf)) if (f.field === 3 && f.wire === 0) return { errorReason: this.u(f) };
        return { errorReason: null };
    },
    decodeLoRa(buf) {
        const l = { region: 0, txEnabled: false, hopLimit: null };
        for (const f of this.fields(buf)) {
            if (f.wire !== 0) continue;
            if (f.field === 7) l.region = this.u(f);                 // LoRaConfig.region
            else if (f.field === 8) l.hopLimit = this.u(f);          // LoRaConfig.hop_limit
            else if (f.field === 9) l.txEnabled = this.u(f) !== 0;   // LoRaConfig.tx_enabled
        }
        return l;
    },
    decodeChannel(buf) {
        const c = { index: 0, role: 0, psk: null, name: "" };
        for (const f of this.fields(buf)) {
            if (f.field === 1 && f.wire === 0) c.index = this.i32(f);
            else if (f.field === 3 && f.wire === 0) c.role = this.u(f);
            else if (f.field === 2 && f.wire === 2) {
                for (const g of this.fields(f.bytes)) {
                    if (g.field === 2 && g.wire === 2) c.psk = g.bytes.slice();
                    else if (g.field === 3 && g.wire === 2) c.name = new TextDecoder().decode(g.bytes);
                }
            }
        }
        return c;
    },
    decodeFromRadio(buf) {
        const m = { id: null };
        for (const f of this.fields(buf)) {
            switch (f.field) {
                case 1: if (f.wire === 0) m.id = this.u(f); break;
                case 2: if (f.wire === 2) m.packet = this.decodeMeshPacket(f.bytes); break;
                case 3: if (f.wire === 2) { m.myInfo = { myNodeNum: null }; for (const g of this.fields(f.bytes)) if (g.field === 1 && g.wire === 0) m.myInfo.myNodeNum = this.u(g); } break;
                case 5: if (f.wire === 2) { for (const g of this.fields(f.bytes)) if (g.field === 6 && g.wire === 2) m.lora = this.decodeLoRa(g.bytes); } break;
                case 7: if (f.wire === 0) m.configCompleteId = this.u(f); break;
                case 8: if (f.wire === 0) m.rebooted = this.u(f) !== 0; break;
                case 10: if (f.wire === 2) m.channel = this.decodeChannel(f.bytes); break;
                case 11: if (f.wire === 2) {
                    m.queueStatus = { res: 0, free: null, maxlen: null, meshPacketId: null };
                    for (const g of this.fields(f.bytes)) {
                        if (g.wire !== 0) continue;
                        if (g.field === 1) m.queueStatus.res = this.i32(g);
                        else if (g.field === 2) m.queueStatus.free = this.u(g);
                        else if (g.field === 3) m.queueStatus.maxlen = this.u(g);
                        else if (g.field === 4) m.queueStatus.meshPacketId = this.u(g);
                    }
                } break;
                default: break;
            }
        }
        return m;
    }
};

const MeshtasticLink = {
    SERVICE: "6ba1b218-15a8-461f-9fa8-5dcae273eafd",
    TO_RADIO: "f75c76d2-129e-4dad-a1dd-7866124401e7",
    FROM_RADIO: "2c55e69e-4993-11ed-b878-0242ac120002",
    FROM_NUM: "ed9da18c-a800-4f66-a670-aa7547e34453",
    KEY_DEVICE: "mu_radio_device",
    REGION_NAMES: { 1: "US", 2: "EU 433", 3: "EU 868", 4: "CN", 5: "JP", 6: "ANZ", 7: "KR", 8: "TW", 9: "RU", 10: "IN" },

    state: "idle",                 // idle | connecting | configuring | ready | reconnecting | error
    lastError: "",
    device: null,
    chars: null,
    myNodeNum: null,
    configNonce: 0,
    info: { region: null, txEnabled: null, channelPublic: null, channelName: "", hopLimit: null },
    reading: false,
    readAgain: false,
    writeChain: Promise.resolve(),
    userClosed: false,
    reconnectDelay: 2000,
    reconnectTimer: null,
    heartbeatTimer: null,
    configTimer: null,
    handlers: { status: [], packet: [], queue: [] },

    supported() { return Boolean(navigator.bluetooth && typeof navigator.bluetooth.requestDevice === "function"); },
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    emit(ev, data) { (this.handlers[ev] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(`[radio] ${ev} handler failed:`, e); } }); },
    setState(s, err = "") { this.state = s; this.lastError = err; this.emit("status", { state: s, error: err }); },
    deviceName() { return (this.device && this.device.name) || "radio"; },

    // Chooser (must run from a tap). Only Meshtastic radios are listed.
    async pair() {
        if (!this.supported()) throw new Error("Web Bluetooth isn't available in this browser.");
        const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [this.SERVICE] }] });
        try { localStorage.setItem(this.KEY_DEVICE, device.id); } catch (e) { /* ignore */ }
        this.adopt(device);
        await this.connect();
    },

    // Reconnect to the radio paired last time without a chooser, where the
    // browser supports persistent permissions (getDevices).
    async restore() {
        if (!this.supported() || typeof navigator.bluetooth.getDevices !== "function") return false;
        let saved = null;
        try { saved = localStorage.getItem(this.KEY_DEVICE); } catch (e) { /* ignore */ }
        if (!saved) return false;
        try {
            const list = await navigator.bluetooth.getDevices();
            const d = list.find((x) => x.id === saved);
            if (!d) return false;
            this.adopt(d);
            await this.connect();
            return true;
        } catch (e) {
            this.scheduleReconnect(e && e.message);
            return false;
        }
    },

    adopt(device) {
        if (this.device === device) return;
        if (this.device) this.device.removeEventListener("gattserverdisconnected", this.onGattDisconnected);
        this.device = device;
        this.onGattDisconnected = this.onGattDisconnected || (() => this.handleDisconnect());
        device.addEventListener("gattserverdisconnected", this.onGattDisconnected);
    },

    async connect() {
        if (!this.device) return;
        this.userClosed = false;
        clearTimeout(this.reconnectTimer);
        this.setState("connecting");
        let server;
        try { server = await this.device.gatt.connect(); }
        catch (e) {
            // A radio that just woke up often fails the first GATT connect.
            await new Promise((r) => setTimeout(r, 750));
            server = await this.device.gatt.connect();
        }
        const svc = await server.getPrimaryService(this.SERVICE);
        this.chars = {
            toRadio: await svc.getCharacteristic(this.TO_RADIO),
            fromRadio: await svc.getCharacteristic(this.FROM_RADIO),
            fromNum: await svc.getCharacteristic(this.FROM_NUM)
        };
        this.onFromNum = this.onFromNum || (() => this.drain());
        await this.chars.fromNum.startNotifications();
        this.chars.fromNum.addEventListener("characteristicvaluechanged", this.onFromNum);
        await this.configure();
        this.reconnectDelay = 2000;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => { this.write(MeshProto.encodeHeartbeat()).catch(() => { /* next one */ }); }, 4 * 60 * 1000);
    },

    // The radio only starts forwarding mesh packets after this handshake.
    async configure() {
        this.setState("configuring");
        this.info = { region: null, txEnabled: null, channelPublic: null, channelName: "", hopLimit: null };
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        this.configNonce = (buf[0] || 1) >>> 0;
        const done = new Promise((resolve, reject) => {
            this.configResolve = resolve;
            clearTimeout(this.configTimer);
            this.configTimer = setTimeout(() => reject(new Error("The radio didn't finish its handshake — is it running Meshtastic 2.x?")), 30000);
        });
        await this.write(MeshProto.encodeWantConfig(this.configNonce));
        await done;
        clearTimeout(this.configTimer);
        this.setState("ready");
    },

    async drain() {
        if (!this.chars) return;
        if (this.reading) { this.readAgain = true; return; }
        this.reading = true;
        try {
            do {
                this.readAgain = false;
                for (let i = 0; i < 1000; i++) {                  // config dump on a big mesh = hundreds of records
                    const v = await this.chars.fromRadio.readValue();
                    if (!v || v.byteLength === 0) break;
                    this.handleFromRadio(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
                }
            } while (this.readAgain && this.chars);
        } catch (e) {
            if (this.chars) console.warn("[radio] read failed:", e && e.message);
        } finally {
            this.reading = false;
        }
    },

    handleFromRadio(bytes) {
        let m;
        try { m = MeshProto.decodeFromRadio(bytes); } catch (e) { console.warn("[radio] undecodable FromRadio:", e.message); return; }
        if (m.myInfo && m.myInfo.myNodeNum) this.myNodeNum = m.myInfo.myNodeNum;
        if (m.lora) { this.info.region = m.lora.region; this.info.txEnabled = m.lora.txEnabled; this.info.hopLimit = m.lora.hopLimit; }
        // Primary channel: a PSK of 0 or 1 byte is no key or one of the
        // publicly known default keys — anyone can hear that channel.
        if (m.channel && m.channel.role === 1) {
            this.info.channelPublic = !m.channel.psk || m.channel.psk.length <= 1;
            this.info.channelName = m.channel.name || "";
        }
        if (m.configCompleteId != null && m.configCompleteId === this.configNonce && this.configResolve) {
            const r = this.configResolve; this.configResolve = null; r();
        }
        if (m.rebooted && this.state === "ready") this.configure().catch((e) => this.fail(e));
        if (m.queueStatus) this.emit("queue", m.queueStatus);
        if (m.packet) this.emit("packet", m.packet);
    },

    write(bytes) {
        const run = async () => {
            if (!this.chars) throw new Error("radio not connected");
            const ch = this.chars.toRadio;
            if (typeof ch.writeValueWithResponse === "function") await ch.writeValueWithResponse(bytes);
            else await ch.writeValue(bytes);
        };
        const p = this.writeChain.then(run, run);
        this.writeChain = p.catch(() => { /* keep the chain alive */ });
        return p.then(() => { this.drain(); });
    },

    // Broadcast one PRIVATE_APP payload. Returns the MeshPacket id (for acks).
    async sendPrivate(payload, { wantAck = false, hopLimit = 3, priority = 0 } = {}) {
        if (this.state !== "ready") throw new Error("radio not ready");
        const idBuf = new Uint32Array(1);
        crypto.getRandomValues(idBuf);
        const id = (idBuf[0] || 1) >>> 0;
        await this.write(MeshProto.encodeToRadioPacket({
            to: MeshProto.BROADCAST, channel: 0, id, hopLimit, wantAck, priority,
            data: { portnum: MeshProto.PORT_PRIVATE, payload }
        }));
        return id;
    },

    handleDisconnect() {
        this.chars = null;
        clearInterval(this.heartbeatTimer);
        if (this.configResolve) { this.configResolve = null; }
        if (this.userClosed) { this.setState("idle"); return; }
        this.scheduleReconnect("Radio out of range or switched off");
    },

    scheduleReconnect(reason) {
        if (this.userClosed || !this.device) return;
        this.setState("reconnecting", reason || "");
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this.connect().catch((e) => this.scheduleReconnect(e && e.message));
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(60000, this.reconnectDelay * 2);
    },

    fail(e) {
        const msg = (e && e.message) || String(e);
        console.warn("[radio]", msg);
        if (this.device && !this.userClosed) this.scheduleReconnect(msg);
        else this.setState("error", msg);
    },

    async disconnect() {
        this.userClosed = true;
        clearTimeout(this.reconnectTimer);
        clearInterval(this.heartbeatTimer);
        try { if (this.chars) await this.write(MeshProto.encodeDisconnect()); } catch (e) { /* going away anyway */ }
        try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) { /* ignore */ }
        try { localStorage.removeItem(this.KEY_DEVICE); } catch (e) { /* ignore */ }
        this.chars = null;
        this.setState("idle");
    },

    // Plain-language problems with the radio's own setup, if any.
    warnings() {
        const w = [];
        if (this.state !== "ready") return w;
        if (this.info.region === 0) w.push("Your radio's LoRa region isn't set, so it can't transmit. Set it in the Meshtastic app (India: IN).");
        if (this.info.txEnabled === false) w.push("Transmit is switched off on your radio (LoRa › Transmit enabled).");
        if (this.info.channelPublic) w.push("Your radio is on a public channel. MapUnite encrypts its own data, but other Meshtastic users can see that you're transmitting — a private channel shared by the squad is better.");
        return w;
    }
};

// ============================================================================
// 8. CONVOY RELAY (Phase 4) — encrypted position + SOS over the radio
// ============================================================================
// Frame (byte layout mirrored exactly by server.js openRelayFrame()):
//   [0]      version<<4 | type    1 = position ping, 2 = SOS, 4 = radio ack
//   [1..4]   trip tag             filters other convoys sharing the channel
//   [5..16]  nonce                rid(4) | unix seconds(4) | seq(2) | random(2)
//   [17..]   AES-128-GCM(groupKey, AAD = bytes 0..16) of
//              body | HMAC-SHA256(deviceKey, bytes 0..16 | body)[0..8]
//            + 16-byte GCM tag. A position frame is 57 bytes on air.
// groupKey: every trip member can read the convoy's frames (and nobody else
// on the channel can). deviceKey: only this rider and the server have it, so
// a rider who UPLOADS a friend's frame can't alter or forge it.
// Keys come from the server (getRelayCredentials) while online and are cached
// on the phone for the trip, so the relay keeps working with no data at all.
const RelayFrame = {
    VERSION: 1, PING: 1, SOS: 2, ACK: 4,
    HEADER: 17, MAC: 8, GCM_TAG: 16, POS_BODY: 16, ACK_BODY: 11,
    FLAG_EST: 0x01, FLAG_OFFLINE: 0x02, FLAG_COURSE: 0x04,

    hexToBytes(h) { const out = new Uint8Array(h.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16); return out; },
    bytesToHex(b) { return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); },
    b64ToBytes(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; },
    bytesToB64(b) { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); },

    async importKeys(creds) {
        const subtle = crypto.subtle;
        return {
            group: await subtle.importKey("raw", this.b64ToBytes(creds.groupKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
            device: await subtle.importKey("raw", this.b64ToBytes(creds.deviceKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
            tag: this.hexToBytes(creds.tag),
            rid: this.hexToBytes(creds.rid)
        };
    },

    encodePosition(p) {
        const b = new Uint8Array(this.POS_BODY), v = new DataView(b.buffer);
        v.setInt32(0, Math.round(p.lat * 1e7));
        v.setInt32(4, Math.round(p.lng * 1e7));
        v.setUint8(8, Number.isFinite(p.speedKmh) ? Math.max(0, Math.min(254, Math.round(p.speedKmh))) : 255);
        const hasCourse = Number.isFinite(p.course);
        v.setUint8(9, hasCourse ? Math.round((((p.course % 360) + 360) % 360) * 256 / 360) % 256 : 0);
        v.setUint16(10, Number.isFinite(p.accuracy) ? Math.max(0, Math.min(65535, Math.round(p.accuracy))) : 65535);
        v.setUint8(12, (p.est ? this.FLAG_EST : 0) | (p.offline ? this.FLAG_OFFLINE : 0) | (hasCourse ? this.FLAG_COURSE : 0));
        v.setUint8(13, Number.isFinite(p.battery) ? Math.max(0, Math.min(100, Math.round(p.battery))) : 255);
        v.setInt16(14, Number.isFinite(p.alt) ? Math.max(-32767, Math.min(32767, Math.round(p.alt))) : -32768);
        return b;
    },
    decodePosition(b) {
        const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const speed = v.getUint8(8), flags = v.getUint8(12), batt = v.getUint8(13), alt = v.getInt16(14);
        return {
            lat: v.getInt32(0) / 1e7, lng: v.getInt32(4) / 1e7,
            speedKmh: speed === 255 ? null : speed,
            course: flags & this.FLAG_COURSE ? Math.round((v.getUint8(9) * 360) / 256) % 360 : null,
            accuracy: v.getUint16(10), est: Boolean(flags & this.FLAG_EST), offline: Boolean(flags & this.FLAG_OFFLINE),
            battery: batt === 255 ? null : batt, alt: alt === -32768 ? null : alt
        };
    },
    encodeAck(a) {
        const b = new Uint8Array(this.ACK_BODY), v = new DataView(b.buffer);
        b.set(this.hexToBytes(a.rid), 0);
        v.setUint32(4, a.ts >>> 0);
        v.setUint16(8, a.seq & 0xffff);
        v.setUint8(10, a.status);
        return b;
    },
    decodeAck(b) {
        const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
        return { rid: this.bytesToHex(b.subarray(0, 4)), ts: v.getUint32(4), seq: v.getUint16(8), status: v.getUint8(10) };
    },

    async build(keys, type, body, seq, tsSec = Math.floor(Date.now() / 1000)) {
        const header = new Uint8Array(this.HEADER);
        header[0] = (this.VERSION << 4) | type;
        header.set(keys.tag, 1);
        header.set(keys.rid, 5);
        const hv = new DataView(header.buffer);
        hv.setUint32(9, tsSec >>> 0);
        hv.setUint16(13, seq & 0xffff);
        crypto.getRandomValues(header.subarray(15, 17));
        const macInput = new Uint8Array(this.HEADER + body.length);
        macInput.set(header, 0); macInput.set(body, this.HEADER);
        const mac = new Uint8Array(await crypto.subtle.sign("HMAC", keys.device, macInput)).subarray(0, this.MAC);
        const plain = new Uint8Array(body.length + this.MAC);
        plain.set(body, 0); plain.set(mac, body.length);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: header.subarray(5, 17), additionalData: header, tagLength: 128 }, keys.group, plain));
        const out = new Uint8Array(this.HEADER + ct.length);
        out.set(header, 0); out.set(ct, this.HEADER);
        return out;
    },
    // -> null (not ours / not authentic) or {type, rid, ts, seq, nonceHex, body}
    async open(keys, bytes) {
        if (!bytes || bytes.length < this.HEADER + this.MAC + this.GCM_TAG + 1 || bytes.length > 140) return null;
        if (bytes[0] >> 4 !== this.VERSION) return null;
        for (let i = 0; i < 4; i++) if (bytes[1 + i] !== keys.tag[i]) return null;
        const header = bytes.slice(0, this.HEADER);
        const nonce = header.subarray(5, 17);
        let plain;
        try {
            plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: header, tagLength: 128 }, keys.group, bytes.slice(this.HEADER)));
        } catch (e) { return null; }
        const nv = new DataView(header.buffer, 5, 12);
        return {
            type: header[0] & 0x0f, rid: this.bytesToHex(nonce.subarray(0, 4)), ts: nv.getUint32(4), seq: nv.getUint16(8),
            nonceHex: this.bytesToHex(nonce), body: plain.subarray(0, plain.length - this.MAC)
        };
    }
};

const ConvoyRelay = {
    KEY_CREDS: "mu_relay_creds",
    KEY_SEQ: "mu_relay_seq",
    CREDS_MAX_AGE_MS: 24 * 3600 * 1000,
    HEARD_FRESH_MS: 10 * 60 * 1000,
    creds: null,
    keys: null,
    heard: new Map(),              // rid -> latest decoded position (last-writer-wins by origin timestamp)
    seen: new Set(),
    seenOrder: [],
    uploadQueue: [],
    uploading: false,
    lastPingAt: 0,
    lastCredsAskAt: 0,
    mySos: null,                   // {startedAt, packetIds:Set, attempts, nextAt, acks: Map(rid -> status), meshHeard}
    ackSent: new Map(),            // `${rid}:${ts}:${status}` -> ts
    stats: { tx: 0, rx: 0, uploaded: 0, rejected: 0, foreign: 0 },
    battery: null,
    listeners: [],

    init() {
        this.loadCreds();
        MeshtasticLink.on("status", (s) => this.onRadioStatus(s));
        MeshtasticLink.on("packet", (p) => this.onPacket(p));
        socket.on("tripData", () => this.refreshCreds("trip"));
        socket.on("profileAccepted", () => setTimeout(() => this.refreshCreds("profile"), 300));
        socket.on("connect", () => setTimeout(() => this.flush(), 1500));
        socket.on("disconnect", () => { setTimeout(() => this.tick(true), 5000); this.updateOfflineIsland(); });
        window.addEventListener("offline", () => setTimeout(() => this.updateOfflineIsland(), 0));
        setInterval(() => this.tick(false), 5000);
        setInterval(() => this.flush(), 3000);
        if (navigator.getBattery) navigator.getBattery().then((b) => {
            const upd = () => { this.battery = Math.round(b.level * 100); };
            upd(); b.addEventListener("levelchange", upd);
        }).catch(() => { /* not available */ });
        MeshtasticLink.restore().catch(() => { /* chooser needed next time */ });
    },

    onChange(fn) { this.listeners.push(fn); },
    changed() { this.listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); },

    ready() { return MeshtasticLink.state === "ready" && Boolean(this.creds && this.keys); },
    online() { return Boolean(socket.connected) && navigator.onLine !== false; },
    inTrip() { return Boolean(currentTrip && Array.isArray(currentTrip.members) && currentTrip.members.some((m) => m.id === socket.id)); },

    // ---- credentials ----------------------------------------------------------
    loadCreds() {
        try {
            const c = JSON.parse(localStorage.getItem(this.KEY_CREDS) || "null");
            if (c && c.tripId && c.groupKey && Date.now() - (c.fetchedAt || 0) < this.CREDS_MAX_AGE_MS) this.setCreds(c, false);
            else localStorage.removeItem(this.KEY_CREDS);
        } catch (e) { /* corrupt cache: fetch again */ }
    },
    async setCreds(c, persist = true) {
        if (!c) {
            this.creds = null; this.keys = null; this.heard.clear();
            try { localStorage.removeItem(this.KEY_CREDS); } catch (e) { /* ignore */ }
            this.changed();
            return;
        }
        try {
            const keys = await RelayFrame.importKeys(c);
            if (this.creds && this.creds.tripId !== c.tripId) this.heard.clear();
            this.creds = c; this.keys = keys;
            if (persist) { try { localStorage.setItem(this.KEY_CREDS, JSON.stringify(c)); } catch (e) { /* quota */ } }
        } catch (e) {
            console.warn("[relay] couldn't import relay keys:", e && e.message);
        }
        this.changed();
    },
    refreshCreds(reason) {
        if (!socket.connected) return;
        if (currentTrip === null && reason === "trip") { this.setCreds(null); return; }
        if (!this.inTrip()) { if (reason === "trip" && this.creds) this.setCreds(null); return; }
        // Everyone in the trip with a radio paired (or remembered) needs the
        // keys BEFORE the dead zone — ask now while there's data.
        const hasRadio = MeshtasticLink.state !== "idle" || (() => { try { return Boolean(localStorage.getItem(MeshtasticLink.KEY_DEVICE)); } catch (e) { return false; } })();
        if (!hasRadio) return;
        if (Date.now() - this.lastCredsAskAt < 2500) { clearTimeout(this.credsRetry); this.credsRetry = setTimeout(() => this.refreshCreds(reason), 2600); return; }
        this.lastCredsAskAt = Date.now();
        socket.emit("getRelayCredentials", { radio: true }, (res) => {
            if (res && res.ok) this.setCreds({ ...res, fetchedAt: Date.now() });
            else if (res && res.reason === "not-in-trip") this.setCreds(null);
            else if (res && res.reason === "too-frequent") { clearTimeout(this.credsRetry); this.credsRetry = setTimeout(() => this.refreshCreds(reason), 2600); }
        });
    },

    nextSeq() {
        let n = 0;
        try { n = (Number(localStorage.getItem(this.KEY_SEQ)) || 0) + 1; localStorage.setItem(this.KEY_SEQ, String(n % 65536)); } catch (e) { n = Math.floor(Math.random() * 65536); }
        return n % 65536;
    },

    onRadioStatus(s) {
        if (s.state === "ready") {
            this.refreshCreds("radio");
            islandShow({ id: "radio", kind: "safe", icon: "📻", title: "Radio connected", sub: MeshtasticLink.deviceName(), ttl: 3500, haptic: false });
            const warn = MeshtasticLink.warnings();
            if (warn.length) setTimeout(() => islandShow({ id: "radio-warn", kind: "sensor", icon: "📻", title: "Radio needs a setting", sub: warn[0], ttl: 9000 }), 3600);
            setTimeout(() => this.tick(true), 1000);
        } else if (s.state === "reconnecting") {
            islandShow({ id: "radio", kind: "sensor", icon: "📻", title: "Radio disconnected", sub: "Reconnecting…", ttl: 5000, haptic: false });
        }
        this.updateOfflineIsland();
        this.changed();
    },

    updateOfflineIsland() {
        // shell.js shows "You're offline"; with the radio up that's only half the story.
        if (!window.StatusIsland) return;
        if (!this.online() && this.ready() && this.inTripOrCached()) {
            window.StatusIsland.show({ id: "net", kind: "sensor", icon: "📻", title: "No data — radio relay on", sub: "Nearby riders still get your position", priority: 45, ttl: 0, sticky: true, haptic: false });
        }
    },
    inTripOrCached() { return this.inTrip() || Boolean(this.creds); },

    // ---- sending ------------------------------------------------------------------
    positionBody(extraFlags = {}) {
        const c = myCoords;
        if (!c || !validCoord(c.lat, c.lng)) return null;
        return RelayFrame.encodePosition({
            lat: c.lat, lng: c.lng, speedKmh: Number.isFinite(c.speedKmh) ? c.speedKmh : null,
            course: Number.isFinite(c.heading) ? c.heading : null,
            accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null,
            est: Boolean(c.est), offline: !this.online(), battery: this.battery, alt: c.alt, ...extraFlags
        });
    },

    // Every 5 s: is a ping due? Airtime is shared by everyone on the channel,
    // so: every 2 min while we have data (keeps riders WITHOUT data seeing
    // us), every 30 s without data while moving, 90 s when stopped.
    async tick(force) {
        if (!this.ready() || !myCoords) return;
        if (typeof PrivacyControls !== "undefined" && PrivacyControls.mode === "off") return;
        const now = Date.now();
        if (this.mySos && now >= this.mySos.nextAt) this.sendSosFrame();
        const moving = (Number(myCoords.speedKmh) || 0) > 5;
        const every = this.online() ? 120000 : moving ? 30000 : 90000;
        if (!force && now - this.lastPingAt < every) return;
        if (now - this.lastPingAt < 10000) {                    // never more than one ping per 10 s…
            // …but a forced ping (we just lost data) is postponed, not dropped:
            // the last one said "has data", so nobody would upload it.
            if (force) { clearTimeout(this.forceTimer); this.forceTimer = setTimeout(() => this.tick(true), this.lastPingAt + 10050 - now); }
            return;
        }
        const body = this.positionBody();
        if (!body) return;
        this.lastPingAt = now;
        try {
            const frame = await RelayFrame.build(this.keys, RelayFrame.PING, body, this.nextSeq());
            await MeshtasticLink.sendPrivate(frame, { hopLimit: 3 });
            this.stats.tx++;
            this.changed();
        } catch (e) { console.warn("[relay] ping failed:", e && e.message); }
    },

    // SOS over the radio. Retries (fresh position each time) at +15 s, +45 s,
    // +90 s, then every 3 min for 15 min, until a rider's phone confirms it
    // put the SOS online.
    sendSos() {
        if (!this.ready() || !myCoords) return false;
        this.mySos = { startedAt: Date.now(), packetIds: new Set(), attempts: 0, nextAt: 0, acks: new Map(), meshHeard: false, delivered: false };
        this.sendSosFrame();
        return true;
    },
    async sendSosFrame() {
        const s = this.mySos;
        if (!s || !this.ready()) return;
        const age = Date.now() - s.startedAt;
        // Delivered, expired, or we have data again (the direct SOS already
        // went out through the server): stop using airtime on retries.
        if (s.delivered || age > 15 * 60000 || (s.attempts >= 1 && this.online())) { this.mySos = null; this.changed(); return; }
        const gaps = [15000, 30000, 45000];
        s.nextAt = Date.now() + (s.attempts < gaps.length ? gaps[s.attempts] : 180000);
        s.attempts++;
        const body = this.positionBody();
        if (!body) return;
        try {
            const frame = await RelayFrame.build(this.keys, RelayFrame.SOS, body, this.nextSeq());
            const id = await MeshtasticLink.sendPrivate(frame, { hopLimit: 3, wantAck: true, priority: MeshProto.PRIORITY_ALERT });
            s.packetIds.add(id);
            this.stats.tx++;
        } catch (e) { console.warn("[relay] SOS send failed:", e && e.message); }
        this.changed();
    },
    async sendAck(target, status) {
        if (!this.ready()) return;
        const key = `${target.rid}:${target.ts}:${status}`;
        const last = this.ackSent.get(key);
        if (last && Date.now() - last < 20000) return;
        this.ackSent.set(key, Date.now());
        if (this.ackSent.size > 200) this.ackSent.delete(this.ackSent.keys().next().value);
        try {
            const frame = await RelayFrame.build(this.keys, RelayFrame.ACK, RelayFrame.encodeAck({ ...target, status }), this.nextSeq());
            await MeshtasticLink.sendPrivate(frame, { hopLimit: 3, priority: MeshProto.PRIORITY_ALERT });
            this.stats.tx++;
        } catch (e) { console.warn("[relay] ack failed:", e && e.message); }
    },

    // ---- receiving ----------------------------------------------------------------
    onPacket(p) {
        const d = p && p.decoded;
        if (!d) return;
        if (d.portnum === MeshProto.PORT_ROUTING && d.requestId && this.mySos && this.mySos.packetIds.has(d.requestId)) {
            // Firmware "implicit ack": another radio re-broadcast our SOS.
            const r = MeshProto.decodeRouting(d.payload);
            if (r.errorReason === 0 && !this.mySos.meshHeard) {
                this.mySos.meshHeard = true;
                islandShow({ id: "sos", kind: "sos", title: "SOS is on the mesh", sub: "Another radio repeated it — waiting for a rider to confirm", ttl: 8000 });
                this.changed();
            }
            return;
        }
        if (d.portnum !== MeshProto.PORT_PRIVATE) return;
        this.onFrame(d.payload, { snr: p.rxSnr, rssi: p.rxRssi, hops: Number.isFinite(p.hopStart) && Number.isFinite(p.hopLimit) ? Math.max(0, p.hopStart - p.hopLimit) : null }).catch((e) => console.warn("[relay] frame error:", e && e.message));
    },

    rememberNonce(hex) {
        if (this.seen.has(hex)) return false;
        this.seen.add(hex); this.seenOrder.push(hex);
        if (this.seenOrder.length > 512) this.seen.delete(this.seenOrder.shift());
        return true;
    },

    async onFrame(bytes, meta = {}) {
        if (!this.keys || !this.creds) return;
        const fr = await RelayFrame.open(this.keys, bytes);
        if (!fr) { this.stats.foreign++; return; }            // other convoy / other app / tampered
        if (fr.rid === this.creds.rid) return;                 // our own frame echoed back
        if (!this.rememberNonce(fr.nonceHex)) return;          // heard it already (mesh repeats)
        this.stats.rx++;
        const tsMs = fr.ts * 1000, now = Date.now();
        if (fr.type === RelayFrame.ACK) {
            if (fr.body.length === RelayFrame.ACK_BODY) this.onAck(fr, RelayFrame.decodeAck(fr.body));
            return;
        }
        if ((fr.type !== RelayFrame.PING && fr.type !== RelayFrame.SOS) || fr.body.length !== RelayFrame.POS_BODY) return;
        if (tsMs > now + 5 * 60000 || now - tsMs > 30 * 60000) return;
        const pos = RelayFrame.decodePosition(fr.body);
        if (!validCoord(pos.lat, pos.lng)) return;
        const who = (this.creds.roster || []).find((r) => r.rid === fr.rid) || null;
        const entry = { rid: fr.rid, name: who ? who.name : "Convoy rider", ownerKey: who ? who.ownerKey : null, ...pos, ts: tsMs, rxAt: now, snr: meta.snr, rssi: meta.rssi, hops: meta.hops, type: fr.type };
        const prev = this.heard.get(fr.rid);
        const newer = !prev || tsMs > prev.ts;
        if (newer) { this.heard.set(fr.rid, entry); this.applyLocal(entry); }

        // Carry it to the server if its sender has no data (or it's an SOS).
        if (fr.type === RelayFrame.SOS || pos.offline) this.enqueue(bytes, fr);

        if (fr.type === RelayFrame.SOS) {
            const f = this.friendFor(entry);
            if (typeof showIncomingSos === "function") showIncomingSos({ id: f ? f.id : `radio:${fr.rid}`, name: entry.name, lat: pos.lat, lng: pos.lng, alt: pos.alt, ownerKey: entry.ownerKey, via: "radio", at: tsMs });
            this.sendAck(fr, 1);                                // "my radio got it"
        }
        this.changed();
    },

    onAck(fr, ack) {
        if (!this.creds || ack.rid !== this.creds.rid || !this.mySos) return;
        const who = (this.creds.roster || []).find((r) => r.rid === fr.rid);
        const name = who ? who.name : "A rider";
        const prev = this.mySos.acks.get(fr.rid) || 0;
        if (ack.status <= prev) return;
        this.mySos.acks.set(fr.rid, ack.status);
        if (ack.status >= 2) {
            this.mySos.delivered = true;
            islandShow({ id: "sos", kind: "sos", title: "SOS delivered", sub: `${name} put it online for the squad`, ttl: 12000 });
            voiceAnnounce(`Your S O S was delivered. ${name} relayed it online.`, { priority: 100, force: true, key: "sos-delivered", cooldownMs: 60000, category: "sos" });
        } else {
            islandShow({ id: "sos", kind: "sos", title: "SOS received", sub: `${name}'s radio got it`, ttl: 9000 });
            voiceAnnounce(`${name} received your S O S over the radio.`, { priority: 100, force: true, key: `sos-ack-${fr.rid}`, cooldownMs: 60000, category: "sos" });
        }
        this.changed();
    },

    friendFor(entry) {
        if (!entry.ownerKey) return null;
        return Object.values(friendData).find((f) => f.ownerKey === entry.ownerKey) || null;
    },

    // Put a radio-heard rider on OUR map, even with no data at all.
    applyLocal(entry) {
        const f = this.friendFor(entry);
        // While WE have data and the server still has their socket (and their
        // frame doesn't say they've lost data), the server feed is the truth —
        // a parked rider sends no updates, which doesn't make the feed stale.
        if (f && f.online !== false && this.online() && !entry.offline) return;
        const u = {
            id: f ? f.id : `radio:${entry.rid}`, name: f ? f.name : entry.name, avatar: f ? f.avatar : DEFAULT_AVATAR,
            lat: entry.lat, lng: entry.lng, alt: entry.alt, speedKmh: entry.speedKmh, weather: "",
            online: false, approx: false, ownerKey: entry.ownerKey, accuracy: entry.accuracy, est: entry.est,
            via: "radio", fixAt: entry.ts, relayedBy: null
        };
        createOrUpdateFriendMarker(u);
        updateOnlineUI();
        if (typeof RelativeMotion !== "undefined") RelativeMotion.onPosition(u);     // Phase 5: radio positions feed the tracks too
        if (typeof ConvoyIntelligence !== "undefined") ConvoyIntelligence.onFriendMoved(u);
        if (currentTrip && typeof updateTripPanel === "function") updateTripPanel();
    },

    // ---- upload (store-and-forward) ------------------------------------------------
    enqueue(bytes, fr) {
        const b64 = RelayFrame.bytesToB64(bytes);
        if (this.uploadQueue.some((q) => q.b64 === b64)) return;
        this.uploadQueue.push({ b64, rid: fr.rid, ts: fr.ts, seq: fr.seq, sos: fr.type === RelayFrame.SOS, addedAt: Date.now() });
        // Positions are last-writer-wins: keep only each rider's newest ping, all SOS frames.
        const newest = new Map();
        this.uploadQueue.forEach((q) => { if (!q.sos && (!newest.has(q.rid) || newest.get(q.rid).ts < q.ts)) newest.set(q.rid, q); });
        this.uploadQueue = this.uploadQueue.filter((q) => q.sos || newest.get(q.rid) === q).slice(-64);
        if (fr.type === RelayFrame.SOS) setTimeout(() => this.flush(), 0);
    },

    flush() {
        if (this.uploading || !this.uploadQueue.length || !socket.connected || !this.creds) return;
        const cutoff = Date.now() - 15 * 60000;
        this.uploadQueue = this.uploadQueue.filter((q) => q.ts * 1000 >= cutoff);
        const batch = this.uploadQueue.slice().sort((a, b) => Number(b.sos) - Number(a.sos)).slice(0, 16);
        if (!batch.length) return;
        this.uploading = true;
        let settled = false;
        const timer = setTimeout(() => { if (!settled) { settled = true; this.uploading = false; } }, 8000);
        socket.emit("relayUpload", { frames: batch.map((q) => q.b64) }, (res) => {
            if (settled) return;
            settled = true; clearTimeout(timer); this.uploading = false;
            if (!res || !res.ok) {
                if (res && res.reason === "not-in-trip") { this.uploadQueue = []; this.setCreds(null); }
                return;                                           // too-frequent / rate-limited: next flush retries
            }
            const done = new Set();
            (res.results || []).forEach((r) => {
                const q = batch[r.i];
                if (!q) return;
                const retry = r.status === "rate-limited";
                if (!retry) done.add(q);
                if (["applied", "sos-broadcast", "sos-duplicate"].includes(r.status)) this.stats.uploaded++;
                else if (!["duplicate", "older", "live-direct"].includes(r.status)) this.stats.rejected++;
                if (q.sos && ["sos-broadcast", "sos-duplicate", "duplicate"].includes(r.status)) this.sendAck({ rid: q.rid, ts: q.ts, seq: q.seq }, 2);   // "it's online"
                if (r.status === "unknown-rider" || r.status === "wrong-trip") this.refreshCreds("stale");
            });
            this.uploadQueue = this.uploadQueue.filter((q) => !done.has(q));
            this.changed();
        });
    },

    // ---- read-outs ------------------------------------------------------------------
    heardRecently() {
        const now = Date.now();
        return Array.from(this.heard.values()).filter((h) => now - h.rxAt < this.HEARD_FRESH_MS).sort((a, b) => b.rxAt - a.rxAt);
    },
    summary() {
        if (MeshtasticLink.state === "idle") return "No radio connected. Open the radar and tap connect radio.";
        if (MeshtasticLink.state !== "ready") return "The radio is reconnecting.";
        if (!this.creds) return "The radio is connected, but the relay only works inside a group trip.";
        const list = this.heardRecently();
        if (!list.length) return "Radio connected. I haven't heard any riders on it in the last ten minutes.";
        const parts = list.slice(0, 3).map((h) => {
            let s = h.name;
            if (myCoords) s += `, ${spokenDistance(map.distance([myCoords.lat, myCoords.lng], [h.lat, h.lng]))} ${compassWord(myCoords.lat, myCoords.lng, h.lat, h.lng)}`;
            const m = Math.round((Date.now() - h.ts) / 60000);
            return `${s}, ${m < 1 ? "just now" : `${m} minute${m === 1 ? "" : "s"} ago`}`;
        });
        return `Radio connected. Heard ${list.length} rider${list.length === 1 ? "" : "s"}: ${parts.join("; ")}.`;
    }
};

// ============================================================================
// 9. RELATIVE MOTION (Phase 5) — bearing, closing speed, CPA, time-to-meet
// ============================================================================
// Pure trigonometry over data the app already has: each rider's recent
// positions (friendMoved, radio relay, own GPS / dead-reckoning). No new
// sensors, no new socket events.
//
//   Local frame   every position -> metres east/north of ME (equirectangular
//                 tangent plane; < 1 m/km error at convoy distances).
//   Velocity      weighted least-squares line through the last ~45 s of a
//                 rider's track (weights 1/accuracy²), with a 1-σ velocity
//                 error from the fit residual. Late positions (radio pings
//                 carry the ORIGIN's timestamp) are extrapolated to "now",
//                 at most 60 s.
//   Relative      r = p_friend - p_me, v = v_friend - v_me
//     closing speed   -(r·v)/|r|            (+ = getting closer)
//     CPA             t* = -(r·v)/|v|²,  d_cpa = |r + v·t*|
//     time-to-meet    first t > 0 with |r + v·t| = R (R = 150 m):
//                     |v|²t² + 2(r·v)t + |r|² - R² = 0
//     bearing rate    (r × v)/|r|²  — near zero while closing = constant
//                     bearing, decreasing range: a collision course.
//   Honesty       forecasts are straight-line, so capped at 30 min and only
//                 made when |v_rel| is clearly above its own noise (2σ).
const RM_CFG = Object.freeze({
    windowMs: 45000,          // track window used for the velocity fit
    minSpanMs: 8000,          // need at least this much track...
    minSamples: 3,            // ...and this many fixes
    maxSamples: 60,
    staleMs: 120000,          // newest fix older than this: no velocity
    maxExtrapMs: 60000,       // carry a late position forward at most this far
    posSigmaM: 6,             // floor for GPS position noise
    rangeRateMs: 0.5,         // |closing speed| below this = holding distance
    meetRadiusM: 150,         // "meet" = within this distance of each other
    passedWindowS: 180,       // an OBSERVED closest approach in the last 3 min + now opening = "passed"
    passedCpaM: 400,
    horizonS: 1800,           // no straight-line forecast beyond 30 min
    confirmEvals: 2           // a new status must repeat before it's reported
});

const RelativeMotion = {
    tracks: new Map(),        // key (ownerKey | id | "me") -> [{t, lat, lng, acc}]
    status: new Map(),        // key -> {shown, pending, count}
    lastMe: null,

    init() {
        socket.on("friendMoved", (u) => this.onPosition(u));
        socket.on("friendDisconnected", (id) => { const f = friendData[id]; if (!f || !f.ownerKey) this.tracks.delete(String(id)); });
        // Own track: sample myCoords (GPS fix or tunnel-mode estimate) at 1 Hz.
        setInterval(() => this.sampleMe(), 1000);
        // Keep every live rider's relation (range history + hysteresis) current.
        setInterval(() => { try { this.all(); } catch (e) { /* no position yet */ } }, 2000);
    },

    keyFor(u) { return (u && (u.ownerKey || u.id)) ? String(u.ownerKey || u.id) : null; },

    push(key, s) {
        let tr = this.tracks.get(key);
        if (!tr) { tr = []; this.tracks.set(key, tr); }
        const last = tr[tr.length - 1];
        if (last && s.t <= last.t) {
            // Out of order (a delayed radio frame): insert in place, drop exact duplicates.
            if (tr.some((x) => x.t === s.t)) return;
            tr.push(s); tr.sort((a, b) => a.t - b.t);
        } else tr.push(s);
        const cutoff = s.t - Math.max(RM_CFG.windowMs * 2, RM_CFG.staleMs);
        while (tr.length && (tr[0].t < cutoff || tr.length > RM_CFG.maxSamples)) tr.shift();
    },

    onPosition(u) {
        if (!u || !validCoord(u.lat, u.lng) || u.approx) return;          // a 1 km cell has no usable motion
        if (typeof socket !== "undefined" && u.id === socket.id) return;
        const key = this.keyFor(u);
        if (!key) return;
        const t = Number.isFinite(u.fixAt) ? u.fixAt : Date.now();
        this.push(key, { t, lat: u.lat, lng: u.lng, acc: Number.isFinite(u.accuracy) ? u.accuracy : 10 });
    },

    sampleMe() {
        if (!myCoords || !validCoord(myCoords.lat, myCoords.lng)) return;
        const now = Date.now(), p = this.lastMe;
        // Keep a sample at least every 5 s even when parked, so "not moving" is measurable.
        if (p && p.lat === myCoords.lat && p.lng === myCoords.lng && now - p.t < 5000) return;
        this.lastMe = { t: now, lat: myCoords.lat, lng: myCoords.lng };
        this.push("me", { t: now, lat: myCoords.lat, lng: myCoords.lng, acc: Number.isFinite(myCoords.accuracy) ? myCoords.accuracy : 10 });
    },

    // metres east / north of `ref`
    toXY(lat, lng, ref) {
        const k = Math.cos((ref.lat * Math.PI) / 180);
        return [(lng - ref.lng) * 111320 * k, (lat - ref.lat) * 110540];
    },

    // Kinematic state of one track, in the frame of `ref`, at time `now`.
    estimate(key, ref, now = Date.now()) {
        const tr = this.tracks.get(key);
        if (!tr || !tr.length) return null;
        const last = tr[tr.length - 1];
        const age = now - last.t;
        const win = tr.filter((s) => last.t - s.t <= RM_CFG.windowMs);
        const pLast = this.toXY(last.lat, last.lng, ref);
        const base = { key, pos: pLast, v: [0, 0], sigmaV: Infinity, speed: null, heading: null, n: win.length, spanS: 0, ageS: age / 1000, valid: false };
        if (age > RM_CFG.staleMs || win.length < RM_CFG.minSamples || last.t - win[0].t < RM_CFG.minSpanMs) return base;

        // Weighted least squares x(t), y(t) = a + b·t  (t centred)
        const pts = win.map((s) => ({ t: (s.t - last.t) / 1000, xy: this.toXY(s.lat, s.lng, ref), w: 1 / Math.max(RM_CFG.posSigmaM, s.acc) ** 2 }));
        const W = pts.reduce((a, p) => a + p.w, 0);
        const tm = pts.reduce((a, p) => a + p.w * p.t, 0) / W;
        const xm = [0, 1].map((k) => pts.reduce((a, p) => a + p.w * p.xy[k], 0) / W);
        const Stt = pts.reduce((a, p) => a + p.w * (p.t - tm) ** 2, 0);
        if (!(Stt > 0)) return base;
        const v = [0, 1].map((k) => pts.reduce((a, p) => a + p.w * (p.t - tm) * (p.xy[k] - xm[k]), 0) / Stt);
        // residual RMS -> velocity 1-σ (per axis, combined)
        let ss = 0;
        pts.forEach((p) => { for (let k = 0; k < 2; k++) { const fit = xm[k] + v[k] * (p.t - tm); ss += (p.xy[k] - fit) ** 2; } });
        const dof = Math.max(1, 2 * pts.length - 4);
        const sigmaPos = Math.max(RM_CFG.posSigmaM, Math.sqrt(ss / dof));
        const sumT2 = pts.reduce((a, p) => a + (p.t - tm) ** 2, 0);
        const sigmaV = (sigmaPos / Math.sqrt(sumT2)) * Math.SQRT2;
        // Position "now": fitted position at the last fix, carried forward (bounded).
        const extra = Math.min(age, RM_CFG.maxExtrapMs) / 1000;
        const pos = [0, 1].map((k) => xm[k] + v[k] * (0 - tm) + v[k] * extra);
        const speed = Math.hypot(v[0], v[1]);
        return {
            ...base, pos, v, sigmaV, speed, valid: true, spanS: (last.t - win[0].t) / 1000,
            heading: speed > 1 ? (((Math.atan2(v[0], v[1]) * 180) / Math.PI) + 360) % 360 : null
        };
    },

    // Pure relative-motion maths between two kinematic states (exported for tests).
    relate(a, b) {
        const r = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]];
        const v = [b.v[0] - a.v[0], b.v[1] - a.v[1]];
        const d = Math.hypot(r[0], r[1]);
        const vv = v[0] * v[0] + v[1] * v[1];
        const rv = r[0] * v[0] + r[1] * v[1];
        const bearing = ((Math.atan2(r[0], r[1]) * 180) / Math.PI + 360) % 360;
        const out = {
            distanceM: d, bearingDeg: bearing, closingMs: d > 0 ? -rv / d : 0, relSpeedMs: Math.sqrt(vv),
            bearingRateDegS: d > 1 ? (((r[0] * v[1] - r[1] * v[0]) / (d * d)) * 180) / Math.PI : 0,
            cpaS: null, cpaM: null, meetInS: null, status: "unknown", confidence: 0,
            relVelMs: v                                  // east/north m/s, for the radar's motion arrow
        };
        const sigmaRel = Math.hypot(a.sigmaV, b.sigmaV);
        if (!a.valid || !b.valid || !Number.isFinite(sigmaRel)) return out;
        out.confidence = Math.max(0, Math.min(1, 1 - sigmaRel / Math.max(1, out.relSpeedMs)));
        // Relative motion within its own noise: all we can say is "about the same distance".
        if (out.relSpeedMs < 2 * sigmaRel || Math.abs(out.closingMs) < RM_CFG.rangeRateMs) { out.status = "holding"; return out; }
        const tStar = -rv / vv;
        out.cpaS = tStar;
        out.cpaM = Math.hypot(r[0] + v[0] * tStar, r[1] + v[1] * tStar);
        const R = RM_CFG.meetRadiusM;
        // Sideways velocity noise grows into miss-distance noise over t*:
        // "on course to meet" allows for it (2σ), so an overtake on the same
        // road isn't misread as "will pass apart" because of GPS jitter.
        const sigmaCpa = sigmaRel * Math.max(0, tStar);
        if (out.closingMs > 0) {
            if (d <= R) { out.status = "together"; out.meetInS = 0; }
            else if (tStar <= RM_CFG.horizonS && out.cpaM <= R + 2 * sigmaCpa) {
                const disc = rv * rv - vv * (d * d - R * R);
                out.meetInS = disc >= 0 ? (-rv - Math.sqrt(disc)) / vv : Math.max(0, tStar - R / Math.sqrt(vv));
                out.status = "meeting";
            } else out.status = tStar <= RM_CFG.horizonS ? "approaching" : "approaching-slowly";
        } else {
            // Opening. "passed" needs EVIDENCE — relation() checks the observed
            // range history; the straight line traced backwards isn't enough
            // (two riders who started apart would "have passed" each other).
            out.status = "moving-away";
        }
        return out;
    },

    // Relation between me and one friend (friendData id).
    relation(id, now = Date.now()) {
        const f = friendData[id];
        if (!f || !myCoords || !validCoord(myCoords.lat, myCoords.lng)) return null;
        const key = this.keyFor(f);
        const ref = { lat: myCoords.lat, lng: myCoords.lng };
        const me = this.estimate("me", ref, now);
        const fr = this.estimate(key, ref, now);
        if (!me || !fr) return null;
        const rel = this.relate(me, fr);
        // Clock position relative to MY direction of travel (only when moving).
        rel.clock = me.heading == null ? null : (Math.round((((rel.bearingDeg - me.heading) + 360) % 360) / 30) % 12) || 12;
        rel.id = id; rel.name = f.name; rel.mySpeedMs = me.speed; rel.theirSpeedMs = fr.speed; rel.ageS = fr.ageS;
        const st = this.status.get(key) || { shown: rel.status, pending: null, count: 0, hist: [] };
        // Observed range history (3 min): "passed" = the range really reached a
        // minimum (≤ 400 m) in that window and has opened by 50 m+ since.
        st.hist.push({ t: now, d: rel.distanceM });
        while (st.hist.length && now - st.hist[0].t > RM_CFG.passedWindowS * 1000) st.hist.shift();
        if (rel.status === "moving-away" && st.hist.length >= 3) {
            let min = st.hist[0];
            st.hist.forEach((h) => { if (h.d < min.d) min = h; });
            if (min !== st.hist[0] && min.d <= RM_CFG.passedCpaM && rel.distanceM - min.d > 50) {
                rel.status = "passed"; rel.cpaS = (min.t - now) / 1000; rel.cpaM = min.d;
            }
        }
        // Hysteresis: a changed status must repeat before it's reported.
        if (rel.status !== st.shown) {
            if (st.pending === rel.status) st.count++; else { st.pending = rel.status; st.count = 1; }
            if (st.count >= RM_CFG.confirmEvals || rel.confidence > 0.8) { st.shown = rel.status; st.pending = null; st.count = 0; }
        } else { st.pending = null; st.count = 0; }
        this.status.set(key, st);
        rel.rawStatus = rel.status;
        rel.status = st.shown;
        return rel;
    },

    all(now = Date.now()) {
        return Object.keys(friendData)
            .filter((id) => friendIsLive(friendData[id]) && validCoord(friendData[id].lat, friendData[id].lng) && !friendData[id].approx)
            .map((id) => this.relation(id, now))
            .filter(Boolean)
            .sort((a, b) => a.distanceM - b.distanceM);
    },

    // Short text ("Approaching · closing 42 km/h · meet in ~3 min") and a spoken sentence.
    describe(rel) {
        if (!rel) return { text: "", speech: "" };
        const kmh = (ms) => Math.round(Math.abs(ms) * 3.6);
        const where = rel.clock ? `at your ${rel.clock} o'clock` : `${["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(rel.bearingDeg / 45) % 8]} of you`;
        const dist = spokenDistance(rel.distanceM);
        const mins = (s) => spokenMinutes(s / 60);
        switch (rel.status) {
            case "together": return { text: "Together", speech: `${rel.name} is right with you.` };
            case "meeting": return { text: `Approaching · closing ${kmh(rel.closingMs)} km/h · meet in ~${Math.max(1, Math.round(rel.meetInS / 60))} min`, speech: `${rel.name} is ${dist} ${where}, closing at ${kmh(rel.closingMs)} kilometres per hour. You'll meet in about ${mins(rel.meetInS)}.` };
            case "approaching": return { text: `Approaching · will pass ${formatDistanceShort(rel.cpaM)} apart in ~${Math.max(1, Math.round(rel.cpaS / 60))} min`, speech: `${rel.name} is ${dist} ${where} and getting closer, but on this heading you'll pass about ${spokenDistance(rel.cpaM)} apart.` };
            case "approaching-slowly": return { text: `Closing slowly · ${kmh(rel.closingMs)} km/h`, speech: `${rel.name} is ${dist} ${where}, closing slowly.` };
            case "passed": return { text: `Passed ~${Math.max(1, Math.round(-rel.cpaS / 60))} min ago · now ${formatDistanceShort(rel.distanceM)}`, speech: `You passed ${rel.name} about ${mins(-rel.cpaS)} ago; ${dist} ${where} now.` };
            case "moving-away": return { text: `Moving apart · ${kmh(rel.closingMs)} km/h`, speech: `${rel.name} is ${dist} ${where} and moving away at ${kmh(rel.closingMs)} kilometres per hour.` };
            case "holding": return { text: "Holding distance", speech: `${rel.name} is ${dist} ${where}, keeping about the same distance.` };
            default: return { text: "Motion unknown yet", speech: `${rel.name} is ${dist} ${where}.` };
        }
    }
};

// ============================================================================
// 10. CONVOY REGROUP (Phase 5) — who should ease off (or catch up) to converge
// ============================================================================
// Phase 3 says "Priya is 9 min behind". This says what to DO about it, from
// a small graph over the riders' travel times to the shared destination.
//
//   Nodes   riders still moving (stopped / no-signal riders are the convoy
//           alerts' job and are left out). Each node's potential φ_i =
//           minutes from the destination.
//   Unary   φ_i ≈ ê_i: the rider's OSRM road ETA, aged by the minutes since
//           it was fetched while they're moving; σ grows with ETA and age.
//   Edges   φ_j − φ_i ≈ Δ_ij: when rider j is ON rider i's planned route
//           (≤ 60 m cross-track), their along-road gap / i's road pace. A
//           direct measurement, independent of when each ETA was fetched —
//           so it gets more weight.
//   Solve   weighted least squares (L_w + W_0)·φ = W_0·ê + Σ edge terms —
//           an n ≤ 8 linear system, Gaussian elimination.
//   Plan    tail = last moving rider. A rider g minutes ahead reaches the
//           tail's timing over horizon H by riding at s·H/(H+g) (covering
//           L = s·H at the slower speed costs exactly g extra minutes). If
//           that's under 70 % of their speed or 25 km/h: "stop for ~g min at
//           the next safe spot" instead. The tail is only nudged to speed up
//           when riding 25 %+ below that road's usual pace, and never above
//           that pace or 80 km/h. Nobody is ever told to speed.
const REGROUP_CFG = Object.freeze({
    everyMs: 30000,
    minSpreadMin: 5, spreadPct: 0.15, clearRatio: 0.6,   // same thresholds as "falling behind"
    horizonMin: 15,
    toleranceMin: 1,          // gaps under this need no action
    minSlowFactor: 0.7, minSlowKmh: 25,
    maxKmh: 75,               // stays under the app's own 80 km/h "Speed check" tier
    minCatchupGainKmh: 10,    // "speed up by 5" isn't advice worth giving
    catchupSlackPct: 0.25,
    onRouteM: 60,
    nearArrivalMin: 5,        // lead this close: just regroup at the destination
    maxRoadsideWaitMin: 20,   // a chai / fuel stop; a bigger gap closes at the destination, not on the road
    changeTolPct: 0.1
});

// Solve A·x = b (small dense system) by Gaussian elimination with partial pivoting.
function solveLinear(A, b) {
    const n = b.length, M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        if (Math.abs(M[p][c]) < 1e-12) return null;
        [M[c], M[p]] = [M[p], M[c]];
        for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
    return x;
}

const ConvoyRegroup = {
    plan: null,
    active: false,
    lastEmitted: null,
    lastRun: 0,

    init() {
        setInterval(() => this.update("tick"), REGROUP_CFG.everyMs);
        document.addEventListener("mu:convoy-evaluated", () => this.update("convoy"));
    },

    // ---- pure core (exported for tests) ----------------------------------------
    // riders: [{id, etaMin, etaAgeMin, moving, speedKmh, routeAvgKmh}]
    // edges:  [{i, j, deltaMin, sigmaMin}]   (φ_j − φ_i ≈ deltaMin)
    solve(riders, edges) {
        const n = riders.length;
        if (!n) return [];
        const A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
        riders.forEach((r, i) => {
            const aged = Math.max(0, r.etaMin - (r.moving ? r.etaAgeMin : 0));
            const sigma = 0.5 + 0.1 * aged + 0.5 * r.etaAgeMin;
            const w = 1 / (sigma * sigma);
            A[i][i] += w; b[i] += w * aged;
        });
        edges.forEach(({ i, j, deltaMin, sigmaMin }) => {
            const w = 1 / (sigmaMin * sigmaMin);
            A[i][i] += w; A[j][j] += w; A[i][j] -= w; A[j][i] -= w;
            b[j] += w * deltaMin; b[i] -= w * deltaMin;
        });
        return solveLinear(A, b) || riders.map((r) => Math.max(0, r.etaMin - (r.moving ? r.etaAgeMin : 0)));
    },

    // phi: solved minutes-to-destination per rider (same order as riders)
    suggest(riders, phi, prevActive = false) {
        const C = REGROUP_CFG;
        const idx = riders.map((_, i) => i).sort((a, b) => phi[a] - phi[b]);
        const lead = idx[0], tail = idx[idx.length - 1];
        const spread = phi[tail] - phi[lead];
        const thr = Math.max(C.minSpreadMin, C.spreadPct * phi[tail]);
        const active = riders.length >= 2 && (spread >= thr || (prevActive && spread >= thr * C.clearRatio));
        const out = { active, spreadMin: spread, thresholdMin: thr, leadId: riders[lead] && riders[lead].id, tailId: riders[tail] && riders[tail].id, horizonMin: null, atDestination: false, actions: [] };
        if (!active) return out;
        if (phi[lead] <= C.nearArrivalMin || spread > C.maxRoadsideWaitMin) {
            // Lead nearly there, or a gap no roadside stop should absorb:
            // everyone ahead carries on and waits at the destination.
            out.atDestination = true;
            out.destinationReason = phi[lead] <= C.nearArrivalMin ? "lead-arriving" : "gap-too-big";
            out.actions = riders.map((r, i) => ({ id: r.id, action: i === tail ? "hold" : "wait-at-destination", gapMin: phi[tail] - phi[i] }));
            return out;
        }
        const H = Math.max(3, Math.min(C.horizonMin, phi[lead] * 0.8));
        out.horizonMin = H;
        // Tail catch-up (only if well below the road's usual pace; capped).
        const t = riders[tail];
        let tailGain = 0, tailAction = { id: t.id, action: "hold", gapMin: 0 };
        if (t.speedKmh > 5 && t.routeAvgKmh && t.speedKmh < (1 - C.catchupSlackPct) * t.routeAvgKmh) {
            const target = Math.min(t.routeAvgKmh, C.maxKmh);
            if (target >= t.speedKmh + C.minCatchupGainKmh) {
                tailGain = Math.min(spread / 2, H * (target / t.speedKmh - 1));
                tailAction = { id: t.id, action: "catch-up", targetKmh: Math.floor(target / 5) * 5, gapMin: 0, gainMin: tailGain };
            }
        }
        out.actions = riders.map((r, i) => {
            if (i === tail) return tailAction;
            const g = phi[tail] - phi[i] - tailGain;
            if (g < C.toleranceMin) return { id: r.id, action: "hold", gapMin: Math.max(0, g) };
            const s = r.speedKmh > 5 ? r.speedKmh : (r.routeAvgKmh || 0);
            const slowed = s * H / (H + g);
            if (s > 0 && slowed >= Math.max(C.minSlowFactor * s, C.minSlowKmh)) {
                return { id: r.id, action: "slow", targetKmh: Math.max(C.minSlowKmh, Math.floor(slowed / 5) * 5), fromKmh: Math.round(s), gapMin: g };
            }
            return { id: r.id, action: "wait", waitMin: Math.ceil(g), gapMin: g };
        });
        return out;
    },

    // ---- live wiring --------------------------------------------------------------
    // Build the graph from what ConvoyIntelligence already tracks.
    snapshot(now = Date.now()) {
        const ctx = typeof ConvoyIntelligence !== "undefined" ? ConvoyIntelligence.context() : null;
        if (!ctx || !myCoords) return null;
        const myId = socket.id;
        const riders = [];
        const routes = [];
        const statsFor = (id) => {
            if (ctx.kind === "trip") { const s = tripRoadStats[id]; return s && Number.isFinite(Number(s.time)) ? { eta: Number(s.time), ts: s.ts || now } : null; }
            const s = GroupNavigation.memberStats && GroupNavigation.memberStats[id === myId ? "me" : id];
            return s && Number.isFinite(s.timeMin) ? { eta: s.timeMin, ts: s.ts || now } : null;
        };
        ctx.memberIds.forEach((id) => {
            const isMe = id === myId;
            const f = isMe ? null : friendData[id];
            if (!isMe && (!friendIsLive(f) || !validCoord(f.lat, f.lng))) return;
            const flags = isMe ? {} : ((ConvoyIntelligence.states.get(id) || {}).flags || {});
            if (flags.stopped || flags.silent || flags.arrived) return;         // the convoy alerts' job
            const st = statsFor(id);
            if (!st) return;
            const ref = { lat: myCoords.lat, lng: myCoords.lng };
            const est = RelativeMotion.estimate(isMe ? "me" : RelativeMotion.keyFor(f), ref, now);
            const speedKmh = est && est.valid ? est.speed * 3.6 : (isMe ? (myCoords.speedKmh || 0) : (f.speedKmh || 0));
            const path = ctx.routeFor(id);
            const route = path ? DRMath.prepareRoute(path) : null;
            const pos = isMe ? { lat: myCoords.lat, lng: myCoords.lng } : { lat: f.lat, lng: f.lng };
            riders.push({
                id, name: isMe ? "You" : f.name, isMe, pos, etaMin: st.eta, etaAgeMin: Math.max(0, (now - st.ts) / 60000),
                moving: speedKmh > 8, speedKmh, routeAvgKmh: route && st.eta > 0 ? (route.total / 1000) / (st.eta / 60) : null
            });
            routes.push(route);
        });
        if (riders.length < 2) return null;
        // Direct along-road gap edges.
        const edges = [];
        riders.forEach((ri, i) => {
            const route = routes[i];
            if (!route || !ri.routeAvgKmh) return;
            const me = DRMath.projectOnRoute(route, ri.pos.lat, ri.pos.lng);
            if (me.distM > REGROUP_CFG.onRouteM) return;
            riders.forEach((rj, j) => {
                if (j <= i) return;
                const pj = DRMath.projectOnRoute(route, rj.pos.lat, rj.pos.lng);
                if (pj.distM > REGROUP_CFG.onRouteM) return;
                const gapMin = ((pj.s - me.s) / 1000) / ri.routeAvgKmh * 60;  // + = j further along = closer to the destination
                edges.push({ i, j, deltaMin: -gapMin, sigmaMin: 0.5 + 0.05 * Math.abs(gapMin) });
            });
        });
        return { ctx, riders, routes, edges };
    },

    // Where the convoy comes back together: on the lead's route, after the
    // lead rides the horizon at the suggested (slower) speed.
    regroupPoint(snap, plan) {
        if (!plan || !plan.active || plan.atDestination || !plan.horizonMin) return null;
        const li = snap.riders.findIndex((r) => r.id === plan.leadId);
        const route = snap.routes[li];
        const act = plan.actions.find((a) => a.id === plan.leadId);
        if (!route || !act) return null;
        const pr = DRMath.projectOnRoute(route, snap.riders[li].pos.lat, snap.riders[li].pos.lng);
        const kmh = act.action === "slow" ? act.targetKmh : act.action === "wait" ? snap.riders[li].speedKmh * Math.max(0, plan.horizonMin - act.waitMin) / plan.horizonMin : snap.riders[li].speedKmh;
        const p = DRMath.pointAtS(route, pr.s + (kmh / 3.6) * plan.horizonMin * 60);
        return { lat: p.lat, lng: p.lng, inMin: plan.horizonMin };
    },

    update(reason) {
        // Convoy evaluations fire on every position update; the plan needs 5 s at most.
        const now = Date.now();
        if (reason !== "tick" && this.lastRun && now - this.lastRun < 5000) return;
        this.lastRun = now;
        const snap = this.snapshot();
        if (!snap) { if (this.plan) { this.plan = null; this.active = false; this.emit(null); } return; }
        const phi = this.solve(snap.riders, snap.edges);
        const plan = this.suggest(snap.riders, phi, this.active);
        plan.riders = snap.riders.map((r, i) => ({ id: r.id, name: r.name, isMe: r.isMe, phiMin: phi[i], speedKmh: r.speedKmh }));
        plan.point = this.regroupPoint(snap, plan);
        plan.at = Date.now(); plan.reason = reason;
        this.active = plan.active;
        const changed = this.materiallyDifferent(this.lastEmitted, plan);
        this.plan = plan;
        if (changed) this.emit(plan);
    },

    // A new plan is worth announcing only if it switched on/off, someone's
    // action changed, or a target speed / wait moved by more than 10 %.
    materiallyDifferent(a, b) {
        if (!a || !b) return a !== b;
        if (a.active !== b.active || a.actions.length !== b.actions.length) return true;
        return a.actions.some((x, i) => {
            const y = b.actions[i];
            if (!y || x.id !== y.id || x.action !== y.action) return true;
            const vx = x.targetKmh || x.waitMin || 0, vy = y.targetKmh || y.waitMin || 0;
            return Math.abs(vx - vy) > REGROUP_CFG.changeTolPct * Math.max(1, vx);
        });
    },

    emit(plan) {
        this.lastEmitted = plan;
        document.dispatchEvent(new CustomEvent("mu:regroup", { detail: plan }));
    },

    // Plain-language line for one rider's action ("You: ease off to 45 km/h").
    sentenceFor(a, name) {
        if (!a) return "";
        switch (a.action) {
            case "slow": return `${name}: ease off to about ${a.targetKmh} km/h (from ${a.fromKmh}) — the convoy closes up in ~${Math.round(this.plan && this.plan.horizonMin || REGROUP_CFG.horizonMin)} min`;
            case "wait": return `${name}: take a break at the next safe stop (chai / fuel) for about ${a.waitMin} min`;
            case "catch-up": return `${name}: this road usually allows about ${a.targetKmh} km/h — no need to hang back`;
            case "wait-at-destination": return this.plan && this.plan.destinationReason === "gap-too-big"
                ? `${name}: the convoy is ${Math.round(this.plan.spreadMin)} min apart — too far to close on the road; carry on and regroup at the destination`
                : `${name}: you're nearly there — wait at the destination`;
            default: return "";
        }
    }
};

// ============================================================================
// 11. PHASE 5 ON SCREEN + IN VOICE — relative motion and regroup
// ============================================================================
// Everything here only READS RelativeMotion / ConvoyRegroup:
//   - rider popup: a live motion line ("Approaching · meet in ~3 min");
//   - radar: motion label per rider + a relative-motion arrow on the canvas
//     (P2PRadar calls motionFor / arrowFor);
//   - trip panel + meetup sheet: a regroup block, YOUR line highlighted;
//   - map: a "Regroup here" pin where the convoy closes up;
//   - voice: your own suggestion once when it changes, "back together" when
//     it clears, and a heads-up when a convoy rider is about to meet you.
const Phase5UI = {
    KEY_ENABLED: "mu_regroup_hints",
    enabled: true,
    layer: null,
    pin: null,
    lastMine: null,
    wasActive: false,
    meetAnnounced: new Map(),       // friend key -> ts

    init() {
        try { this.enabled = localStorage.getItem(this.KEY_ENABLED) !== "0"; } catch (e) { /* keep default */ }
        const toggle = document.getElementById("regroup-toggle");
        if (toggle) {
            toggle.checked = this.enabled;
            toggle.addEventListener("change", () => {
                this.enabled = toggle.checked;
                try { localStorage.setItem(this.KEY_ENABLED, this.enabled ? "1" : "0"); } catch (e) { /* ignore */ }
                this.onPlan(ConvoyRegroup.plan);
            });
        }
        this.layer = L.layerGroup().addTo(map);
        document.addEventListener("mu:regroup", (e) => this.onPlan(e.detail));
        setInterval(() => this.tick(), 4000);
    },

    // ---- regroup ------------------------------------------------------------------
    onPlan(plan) {
        const show = Boolean(this.enabled && plan && plan.active);
        this.renderPanels(show ? plan : null);
        this.renderPin(show ? plan : null);
        if (!this.enabled) { this.wasActive = false; this.lastMine = null; return; }
        this.speakForMe(plan);
    },

    myAction(plan) { return plan && plan.actions ? plan.actions.find((a) => a.id === socket.id) : null; },
    nameOf(plan, id) { const r = plan.riders && plan.riders.find((x) => x.id === id); return r ? r.name : "A rider"; },

    renderPanels(plan) {
        const ctx = typeof ConvoyIntelligence !== "undefined" ? ConvoyIntelligence.context() : null;
        [["regroup-panel", "trip"], ["regroup-panel-meetup", "meetup"]].forEach(([id, kind]) => {
            const host = document.getElementById(id);
            if (!host) return;
            host.textContent = "";
            if (!plan || !ctx || ctx.kind !== kind) { host.hidden = true; return; }
            host.hidden = false;
            const head = document.createElement("div");
            head.className = "regroup-head";
            const label = document.createElement("span"); label.className = "convoy-label"; label.textContent = "Regroup";
            const spread = document.createElement("span"); spread.className = "chip warn"; spread.textContent = `${Math.round(plan.spreadMin)} min apart`;
            head.append(label, spread);
            host.appendChild(head);
            const list = document.createElement("ul");
            list.className = "regroup-list";
            const mine = this.myAction(plan);
            const ordered = plan.actions.slice().sort((a, b) => (b === mine) - (a === mine));
            ordered.forEach((a) => {
                const text = ConvoyRegroup.sentenceFor(a, a.id === socket.id ? "You" : this.nameOf(plan, a.id));
                if (!text) return;
                const li = document.createElement("li");
                li.className = `regroup-item ${a.action}${a.id === socket.id ? " mine" : ""}`;
                li.textContent = text;
                list.appendChild(li);
            });
            if (!list.children.length) {
                const li = document.createElement("li"); li.className = "regroup-item"; li.textContent = "Keep riding — the others are closing up.";
                list.appendChild(li);
            }
            host.appendChild(list);
        });
    },

    renderPin(plan) {
        this.layer.clearLayers();
        this.pin = null;
        if (!plan || !plan.point || plan.atDestination) return;
        this.pin = L.marker([plan.point.lat, plan.point.lng], {
            icon: L.divIcon({ className: "regroup-pin", html: '<div class="regroup-pin-dot" aria-hidden="true">⟲</div>', iconSize: [34, 34], iconAnchor: [17, 17] }),
            zIndexOffset: 800
        }).bindTooltip(`Regroup here · ~${Math.round(plan.point.inMin)} min`, { permanent: true, direction: "top", className: "weather-badge" }).addTo(this.layer);
    },

    speechFor(a, plan) {
        switch (a.action) {
            case "slow": return `Convoy regroup. Ease off to about ${a.targetKmh} kilometres per hour; the group closes up in about ${spokenMinutes(plan.horizonMin)}.`;
            case "wait": return `Convoy regroup. Take a break at the next safe stop for about ${spokenMinutes(a.waitMin)}.`;
            case "catch-up": return `This road usually allows about ${a.targetKmh} kilometres per hour. No need to hang back.`;
            case "wait-at-destination": return plan.destinationReason === "gap-too-big"
                ? `The convoy is ${spokenMinutes(plan.spreadMin)} apart. Carry on and regroup at the destination.`
                : "You're nearly there. Wait for the others at the destination.";
            default: return "";
        }
    },

    speakForMe(plan) {
        const active = Boolean(plan && plan.active);
        const mine = active ? this.myAction(plan) : null;
        const sig = mine ? `${mine.action}:${mine.targetKmh || mine.waitMin || 0}:${plan.destinationReason || ""}` : null;
        if (mine && sig !== this.lastMine && mine.action !== "hold") {
            const speech = this.speechFor(mine, plan);
            if (speech) {
                islandShow({ id: "regroup", kind: "info", icon: "⟲", title: "Convoy regroup", sub: ConvoyRegroup.sentenceFor(mine, "You").replace(/^You: /, ""), ttl: 9000 });
                voiceAnnounce(speech, { priority: 55, key: `regroup-${sig}`, cooldownMs: 180000, category: "convoy", drivingOnly: true });
            }
        }
        if (!active && this.wasActive) {
            islandShow({ id: "regroup", kind: "safe", icon: "⟲", title: "Convoy is back together", ttl: 4000, haptic: false });
            voiceAnnounce("The convoy is back together.", { priority: 40, key: "regroup-clear", cooldownMs: 120000, category: "convoy", drivingOnly: true });
        }
        this.lastMine = sig;
        this.wasActive = active;
    },

    regroupSummary() {
        const ctx = typeof ConvoyIntelligence !== "undefined" ? ConvoyIntelligence.context() : null;
        if (!ctx) return "You're not in a group trip or meetup right now.";
        const plan = ConvoyRegroup.plan;
        if (!plan) return "I don't have road times for enough riders yet.";
        if (!plan.active) return "The convoy is together. No regrouping needed.";
        const mine = this.myAction(plan);
        const others = plan.actions.filter((a) => a !== mine && (a.action === "slow" || a.action === "wait"))
            .map((a) => ConvoyRegroup.sentenceFor(a, this.nameOf(plan, a.id)).replace(/ — .*$/, "").replace(/: /, " should "));
        let s = mine && mine.action !== "hold" ? this.speechFor(mine, plan) : `The convoy is ${spokenMinutes(plan.spreadMin)} apart; keep riding, the others are adjusting.`;
        if (others.length) s += ` ${others.slice(0, 2).join(". ")}.`;
        return s;
    },

    // ---- relative motion ------------------------------------------------------------
    motionFor(id) {
        if (typeof RelativeMotion === "undefined" || !id || !friendData[id]) return null;
        const rel = RelativeMotion.relation(id);
        if (!rel || rel.status === "unknown") return null;
        return { rel, text: RelativeMotion.describe(rel).text };
    },

    motionSummary() {
        const rels = RelativeMotion.all().filter((r) => r.status !== "unknown");
        if (!rels.length) return "I don't have enough movement from anyone yet to tell.";
        const closing = rels.filter((r) => r.status === "meeting" || r.status === "approaching" || r.status === "approaching-slowly")
            .sort((a, b) => (a.meetInS ?? a.cpaS ?? 1e9) - (b.meetInS ?? b.cpaS ?? 1e9));
        if (!closing.length) return "Nobody is closing in on you right now.";
        return closing.slice(0, 3).map((r) => RelativeMotion.describe(r).speech).join(" ");
    },

    tick() {
        // Rider popup: keep its motion line live while it's open.
        const pop = document.getElementById("profile-popup");
        if (pop && pop.style.display === "flex" && pop.dataset.friendId) this.fillPopup(pop.dataset.friendId);
        // Heads-up when a convoy rider is about to meet you (once per rider per 10 min).
        if (typeof ConvoyIntelligence === "undefined") return;
        const ctx = ConvoyIntelligence.context();
        if (!ctx) return;
        const now = Date.now();
        ctx.memberIds.forEach((id) => {
            if (id === socket.id || !friendData[id]) return;
            const rel = RelativeMotion.relation(id, now);
            if (!rel || rel.status !== "meeting" || rel.meetInS > 180 || rel.distanceM < 400 || rel.confidence < 0.5) return;
            const key = RelativeMotion.keyFor(friendData[id]);
            if (now - (this.meetAnnounced.get(key) || 0) < 600000) return;
            this.meetAnnounced.set(key, now);
            const d = RelativeMotion.describe(rel);
            islandShow({ id: `meet-${key}`, kind: "info", icon: "↔", title: `${rel.name} is approaching`, sub: d.text, priority: 35, ttl: 8000, haptic: false });
            voiceAnnounce(d.speech, { priority: 50, key: `meet-${key}`, cooldownMs: 600000, category: "convoy", drivingOnly: true });
        });
    },

    fillPopup(id) {
        const el = document.getElementById("profile-popup-motion");
        if (!el) return;
        const m = this.motionFor(id);
        el.hidden = !m;
        el.textContent = m ? m.text : "";
        el.dataset.status = m ? m.rel.status : "";
    }
};

// ============================================================================
// BOOT
// ============================================================================
// Window handles: app.js reaches these through `window.X` (never the bare
// name) so a call that races script evaluation can't hit a TDZ error.
window.VoiceAssistant = VoiceAssistant;
window.ConvoyIntelligence = ConvoyIntelligence;
window.ConvoyRelay = ConvoyRelay;          // app.js sendSOS() reaches the radio through this
window.RelativeMotion = RelativeMotion;    // Phase 5
window.ConvoyRegroup = ConvoyRegroup;
window.Phase5UI = Phase5UI;

document.addEventListener("DOMContentLoaded", () => {
    const boot = [
        ["Voice squad", () => VoiceSquad.init()],
        ["Radio relay", () => ConvoyRelay.init()],
        ["Radio radar", () => P2PRadar.init()],
        ["Relative motion", () => RelativeMotion.init()],
        ["Convoy regroup", () => ConvoyRegroup.init()],
        ["Phase 5 UI", () => Phase5UI.init()],
        ["Voice assistant", () => VoiceAssistant.init()],
        ["Convoy intelligence", () => ConvoyIntelligence.init()]
    ];
    boot.forEach(([name, fn]) => { try { fn(); } catch (e) { console.error(`[features] ${name} failed to start:`, e); } });
});
