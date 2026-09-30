"use strict";

/* ============================================================================
   MapUnite client — js/skunkworks.js
   ==============================================================================
   Experimental tools: pothole seismograph, AI dashcam, travel-mode picker.

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

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
