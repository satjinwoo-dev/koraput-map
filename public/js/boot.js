"use strict";

/* ============================================================================
   MapUnite client — js/boot.js
   ==============================================================================
   Start-up: initApp() starts every module in order, navigation restore after
   a refresh, and the window handles + start-up of the voice/convoy/radio
   modules. Must load last.

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → garage/fuel-baseline → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot (then the bike data, physics and js/trip/, which wire themselves).
   ============================================================================ */

// ==========================================
// BOOT
// ==========================================

function initApp() {
    const tasks = [
        { name: "Join Setup", fn: setupJoin },
        { name: "Controls", fn: setupBasicControlsSafe },
        { name: "Advanced Tools", fn: setupAdvancedToolsSafe },
        { name: "Chat UI", fn: setupChatSafe },
        { name: "Memories", fn: setupMemoriesSafe },
        { name: "Memory Heatmap", fn: () => MemoryHeatmap.init() },
        { name: "SmartDrive", fn: () => SmartDrive.init() },
        { name: "Fuel Curve", fn: () => FuelCurve.init() },
        { name: "Privacy Controls", fn: () => PrivacyControls.init() },
        { name: "Circles", fn: () => Circles.init() },
        { name: "Place Recall", fn: () => PlaceRecall.init() },
        { name: "Route Options", fn: () => RoutePrefs.bindUI() },
        { name: "Speed Limits", fn: () => SpeedLimits.init() },
        { name: "GPS Power", fn: () => GpsPower.init() },
        { name: "Mode Detector", fn: () => ModeDetector.init() },
        { name: "Traffic ETA", fn: () => TrafficETA.init() },
        { name: "Meetup Planner", fn: () => MeetupPlanner.init() },
        { name: "Carpool Planner", fn: () => CarpoolPlanner.init() },
        { name: "Trip Analytics", fn: () => TripAnalytics.init() },
        { name: "Dead Reckoning", fn: () => DeadReckoning.init() },
        { name: "GPS System", fn: startGPS },
        { name: "Google Search", fn: setupGoogleSearch },
        { name: "Emergency SOS", fn: setupSOS }
    ];

    tasks.forEach(task => {
        try { task.fn(); } catch (e) { console.error(`[INIT ERROR] Failed to load ${task.name}:`, e); }
    });

    setTimeout(() => {
        try {
            const panel = $("trip-panel");
            if (panel && !$("trip-checklist-container")) {
                const listDiv = document.createElement("div");
                listDiv.id = "trip-checklist-container";
                listDiv.style.cssText = "background:rgba(255,255,255,0.05); padding:10px; border-radius:10px; margin-top:10px;";
                // Fixed: this used insertBefore(listDiv, #trip-action-btn), but that
                // button sits inside a row <div>, not directly in #trip-panel —
                // insertBefore() threw NotFoundError and the checklist never showed.
                panel.appendChild(listDiv);
                TripChecklist.render();
            }
        } catch (e) { console.error(e); }
    }, 1000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initApp); else initApp();

// Auto-restore navigation across a refresh. Fixed: TripDB has no
// restoreNavState() — read the same backing store via restoreAll() instead
// (see tripDbRestoreNav() near SmartDrive, defined earlier in this file).
setTimeout(() => {
    const savedNav = tripDbRestoreNav();
    if (savedNav && savedNav.active && savedNav.destLat && typeof startSearchNavigation === "function") {
        console.log("🔄 Restoring previous navigation state...");
        // Fixed: the original called startSearchNavigation(..., null) here,
        // which crashed immediately on routeData.geometry.coordinates — a real
        // route has to be fetched first.
        if (myCoords) {
            RoutePrefs.fetchRoute(`${OSRM_BASE}/route/v1/driving/${myCoords.lng},${myCoords.lat};${savedNav.destLng},${savedNav.destLat}?overview=full&geometries=geojson&steps=true`)
                .then(data => {
                    const route = data.routes && data.routes[0];
                    if (!route) return;
                    startSearchNavigation(savedNav.destLat, savedNav.destLng, savedNav.destName, route);
                    setTimeout(() => { const startBtn = document.getElementById("btn-start-nav"); if (startBtn && startBtn.style.display !== "none") startBtn.click(); }, 1200);
                }).catch(() => { /* couldn't restore — rider just re-searches, no crash */ });
        }
    }
}, 2000);

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

// Batch 2: every app script has run (this is the last one) — connect now.
// core.js created the socket with autoConnect: false.
socket.connect();
