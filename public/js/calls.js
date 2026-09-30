"use strict";

/* ============================================================================
   MapUnite client — js/calls.js
   ==============================================================================
   Voice calls: 1:1 WebRTC calls and the multi-peer voice squad.

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

// ==========================================
// VOICE CALLING (1:1 WebRTC via Socket.IO signaling)
// ==========================================
let peerConnection = null;
let localStream = null;
let incomingIceCandidates = [];
let callDialog = null;
let activeCallBtn = null;

const rtcConfig = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" },
        { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
        { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
    ]
};

function attachAudioTrack(event) {
    let audio = document.getElementById("remote-audio");
    if (!audio) {
        audio = document.createElement("audio");
        audio.id = "remote-audio";
        audio.autoplay = true;
        audio.playsInline = true;
        audio.hidden = true;
        document.body.appendChild(audio);
    }
    if (event.streams && event.streams[0]) audio.srcObject = event.streams[0];
    else audio.srcObject = new MediaStream([event.track]);

    audio.play().catch(e => {
        console.log("Audio play error, forcing play:", e);
        document.body.addEventListener('click', () => { audio.play(); }, { once: true });
    });
}

function initCallButton(u) {
    const callBtn = $("profile-call-btn");
    if (!callBtn) return;
    const newBtn = callBtn.cloneNode(true);
    callBtn.parentNode.replaceChild(newBtn, callBtn);

    newBtn.onclick = async () => {
        if (!navigator.onLine || u.online === false) {
            const phone = prompt(`No Internet or Friend is offline.\nEnter mobile number to dial via SIM:`);
            if (phone) window.location.href = `tel:${phone.trim()}`;
            return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showToast("❌ Microphone is not available in this browser.");
            return;
        }
        try {
            // Phase 3: hand the mic over from hands-free voice commands first.
            if (window.VoiceAssistant) window.VoiceAssistant.stopListening();
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            peerConnection = new RTCPeerConnection(rtcConfig);
            localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
            peerConnection.ontrack = attachAudioTrack;
            peerConnection.onicecandidate = (event) => {
                if (event.candidate) socket.emit("call-user", { to: u.id, signal: { type: "ice", candidate: event.candidate }, name: currentUser.name });
            };
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit("call-user", { to: u.id, signal: { type: "offer", sdp: offer }, name: currentUser.name });
            showToast(`📞 Calling ${u.name}...`, 5000);
            showActiveCallUI(() => socket.emit("end-call", { to: u.id }));
        } catch (err) {
            console.error("CALL MIC ERROR:", err);
            showToast(`❌ Mic Error: ${err.name || "Unknown"}`);
            endLocalCall();
        }
    };
}

socket.on("incoming-call", async (data) => {
    if (data.signal.type === "offer") {
        if (peerConnection) { socket.emit("end-call", { to: data.from }); return; }
        incomingIceCandidates = [];
        if (callDialog) callDialog.remove();

        callDialog = document.createElement('div');
        callDialog.style.cssText = "position:fixed;top:70px;left:50%;transform:translateX(-50%);background:rgba(15,23,42,0.98);padding:24px;border:1px solid #18d6a3;border-radius:20px;z-index:9999;box-shadow:0 15px 40px rgba(0,0,0,0.7);color:white;text-align:center;backdrop-filter:blur(10px);min-width:280px;";
        callDialog.innerHTML = `
            <div style="font-size:32px;margin-bottom:10px;">📞</div>
            <strong style="font-size:18px;display:block;">${escapeHTML(data.name)}</strong>
            <div style="font-size:13px;color:#94a3b8;margin-top:6px;margin-bottom:20px;">Incoming Voice Call...</div>
            <div style="display:flex;gap:12px;justify-content:center;">
                <button id="accept-call-btn" style="flex:1;background:#10b981;border:none;padding:12px;border-radius:12px;color:#064e3b;font-weight:800;cursor:pointer;font-size:15px;box-shadow:0 4px 10px rgba(16,185,129,0.3);">Accept</button>
                <button id="reject-call-btn" style="flex:1;background:#ef4444;border:none;padding:12px;border-radius:12px;color:white;font-weight:700;cursor:pointer;font-size:15px;box-shadow:0 4px 10px rgba(239,68,68,0.3);">Decline</button>
            </div>
        `;
        document.body.appendChild(callDialog);

        const acceptBtn = document.getElementById("accept-call-btn");
        if (acceptBtn) {
            acceptBtn.onclick = async () => {
                if (callDialog) callDialog.remove();
                callDialog = null;
                try {
                    if (window.VoiceAssistant) window.VoiceAssistant.stopListening();
                    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                    peerConnection = new RTCPeerConnection(rtcConfig);
                    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
                    peerConnection.ontrack = attachAudioTrack;
                    peerConnection.onicecandidate = (event) => {
                        if (event.candidate) socket.emit("answer-call", { to: data.from, signal: { type: "ice", candidate: event.candidate } });
                    };
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal.sdp));
                    const answer = await peerConnection.createAnswer();
                    await peerConnection.setLocalDescription(answer);
                    socket.emit("answer-call", { to: data.from, signal: { type: "answer", sdp: answer } });
                    showToast(`🎙️ Call Connected with ${data.name}`);
                    showActiveCallUI(() => socket.emit("end-call", { to: data.from }));
                    incomingIceCandidates.forEach(async (c) => { try { await peerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { /* stale candidate, ignore */ } });
                    incomingIceCandidates = [];
                } catch (e) {
                    showToast("❌ Mic error.");
                    socket.emit("end-call", { to: data.from });
                    endLocalCall();
                }
            };
        }
        const rejectBtn = document.getElementById("reject-call-btn");
        if (rejectBtn) rejectBtn.onclick = () => { if (callDialog) callDialog.remove(); callDialog = null; socket.emit("end-call", { to: data.from }); };
    } else if (data.signal.type === "ice") {
        if (peerConnection && peerConnection.remoteDescription) { try { await peerConnection.addIceCandidate(new RTCIceCandidate(data.signal.candidate)); } catch (e) { /* stale candidate, ignore */ } }
        else incomingIceCandidates.push(data.signal.candidate);
    }
});

socket.on("call-accepted", async (signal) => {
    if (signal.type === "answer" && peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        showToast("🎙️ Call Connected!");
    } else if (signal.type === "ice" && peerConnection && peerConnection.remoteDescription) {
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (e) { /* stale candidate, ignore */ }
    }
});

socket.on("call-ended", () => { endLocalCall(); showToast("📴 Call Ended."); });

function showActiveCallUI(endFn) {
    if (activeCallBtn) return;
    activeCallBtn = document.createElement("button");
    activeCallBtn.innerHTML = "📴 End Call";
    activeCallBtn.style.cssText = "position:fixed;top:80px;left:50%;transform:translateX(-50%);z-index:9999;background:#ef4444;color:white;border:none;padding:12px 24px;border-radius:30px;font-weight:bold;box-shadow:0 10px 25px rgba(239,68,68,0.5);cursor:pointer;font-size:14px;";
    document.body.appendChild(activeCallBtn);
    activeCallBtn.onclick = () => { endFn(); endLocalCall(); };
}

function endLocalCall() {
    if (activeCallBtn) { activeCallBtn.remove(); activeCallBtn = null; }
    if (callDialog) { callDialog.remove(); callDialog = null; }
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    incomingIceCandidates = [];
    // Phase 3: the mic is free again — hands-free listening may resume.
    if (window.VoiceAssistant) window.VoiceAssistant.updateHandsFree();
}

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
