"use strict";

console.log("🔥 KORAPUT MAP APP JS VERSION: 2026-09-25-GOOGLE-API-RESTORED");

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function(registrations) {
        for(let registration of registrations) {
            registration.unregister();
        }
    });
}

const socket = io({ transports: ["websocket", "polling"] });
const DEFAULT_CENTER = [22.2475, 84.8828]; // Rourkela Default Center
const DEFAULT_AVATAR = "satyam.png";
const MAX_NAME = 40;
const MAX_CHAT_FILE = 5 * 1024 * 1024;
const MAX_MEMORY_FILE = 8 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const map = L.map("map", { 
    zoomControl: false, preferCanvas: false, minZoom: 3, maxBounds: [[-90, -180], [90, 180]], maxBoundsViscosity: 1.0
}).setView(DEFAULT_CENTER, 13);

const satelliteLayer = L.tileLayer("https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}", { maxZoom: 20, subdomains: ["mt0","mt1","mt2","mt3"] });
const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 });
const darkLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 20 });
satelliteLayer.addTo(map);

let currentUser = { name: localStorage.getItem("koraput_name") || "", avatar: localStorage.getItem("koraput_avatar") || DEFAULT_AVATAR };
let myCoords = null, myWeather = "", ownMarker = null, accuracyCircle = null, cityName = "";
let lastWeatherFetch = 0;
const friendMarkers = Object.create(null);
const friendData = Object.create(null);

let lastFixCoords = null, lastFixTime = 0; 
let locationHistory = [];
try {
    const stored = localStorage.getItem("koraput_history");
    if (stored) locationHistory = JSON.parse(stored);
    if (!Array.isArray(locationHistory)) locationHistory = [];
} catch(e) { locationHistory = []; }

const p4LayerGroup = L.layerGroup().addTo(map);
const measureLayer = L.layerGroup().addTo(map);
const historyPolyline = L.polyline(locationHistory, { color: '#3b82f6', weight: 4, opacity: 0.8, dashArray: '5, 10' }).addTo(p4LayerGroup);
const navigationLayer = L.layerGroup().addTo(map);
const tripRoutesLayer = L.layerGroup().addTo(map);
const memoryLayer = L.layerGroup().addTo(map);

const tripLastFetchedCoords = {}; 
let tripRoadStats = {}; 
const routeColors = ['#18d6a3', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6']; 

let mapActionMode = null; 
let pendingMemoryImage = null; 
let measurePoints = [];
let currentTrip = null;
let tripMarker = null;

let geoClickCount = 0, geoClickTimer = null;
let currentGeofences = []; 
const memories = new Map();
let currentGalleryFilter = "all", currentGallerySearch = "", selectedMemoryId = null;

let searchMarker = null;
let offlineMessageQueue = [];
let offlineMemoryQueue = [];
let isNetworkOnline = navigator.onLine;

const $ = id => document.getElementById(id);
const safeShow = (id, displayStyle = "flex") => { const el = $(id); if (el) el.style.display = displayStyle; };
const safeHide = (id) => { const el = $(id); if (el) el.style.display = "none"; };
const cleanName = v => String(v || "User").trim().replace(/\s+/g," ").slice(0, MAX_NAME);
const validCoord = (lat,lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat>=-90 && lat<=90 && lng>=-180 && lng<=180;
const validImageData = v => typeof v === "string" && v.startsWith("data:image/");

function distanceKm(a,b,c,d){
    if(!validCoord(a,b) || !validCoord(c,d)) return "";
    const p = Math.PI/180, a1 = 0.5 - Math.cos((c-a)*p)/2 + Math.cos(a*p)*Math.cos(c*p)*Math.sin((d-b)*p/2)**2;
    return (12742 * Math.asin(Math.sqrt(a1))).toFixed(2);
}
function escapeHTML(v) { return String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;"); }

function ownIcon() { 
    return L.divIcon({ 
        className: "custom-own-icon", 
        html: `<div style="width:100%; height:100%; border-radius:50%; border:2.5px solid #18d6a3; overflow:hidden; background:#071018; box-sizing:border-box; box-shadow:0 0 10px rgba(24,214,163,0.5);"><img src="${escapeHTML(currentUser.avatar)}" style="width:100%; height:100%; object-fit:cover; display:block;"></div>`,
        iconSize: [38, 38], iconAnchor: [19, 19] 
    }); 
}

function friendIcon(avatar) { 
    return L.divIcon({ 
        className: "custom-friend-icon", 
        html: `<div style="width:100%; height:100%; border-radius:50%; border:2px solid #60a5fa; overflow:hidden; background:#071018; box-sizing:border-box;"><img src="${escapeHTML(avatar)}" style="width:100%; height:100%; object-fit:cover; display:block;"></div>`,
        iconSize: [36, 36], iconAnchor: [18, 18] 
    }); 
}

function weatherEmoji(code){
    if(code===0) return "☀️"; if([1,2,3].includes(code)) return "⛅"; if([45,48].includes(code)) return "🌫️";
    if([51,53,55,56,57,61,63,65,66,67].includes(code)) return "🌧️"; if([71,73,75,77,85,86].includes(code)) return "❄️";
    if([80,81,82].includes(code)) return "🌦️"; if([95,96,99].includes(code)) return "⛈️"; return "🌤️";
}

async function fetchWeather(lat,lng){
    try {
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&current=temperature_2m,weather_code`);
        if(!r.ok) return ""; const d = await r.json();
        const t = Number(d?.current?.temperature_2m), code = Number(d?.current?.weather_code);
        return Number.isFinite(t) ? `${weatherEmoji(code)} ${Math.round(t)}°C` : "";
    } catch { return ""; }
}

async function fetchCity(lat,lng){
    try {
        const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`);
        if (r.ok) { const d = await r.json(); const c = d.city || d.locality || d.principalSubdivision; if (c) return c; }
    } catch (e) {}
    try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=10`);
        if (r.ok) { const d = await r.json(); return d.address?.city || d.address?.town || d.address?.county || "Local Area"; }
    } catch { return "Local Area"; }
}

// ==========================================
// SMART DRIVE ENGINE
// ==========================================
const SmartDrive = {
    isRecording: false,
    baseMileage: 18,
    speedHistory: [],
    trip: { active: false, startTime: 0, totalDist: 0, actualFuel: 0, maxSpeed: 0, sumSpeed: 0, ticks: 0, ranges: { efficient: 0, moderate: 0, inefficient: 0 } },
    audioCtx: null, lastAlertTime: 0, overlayTimer: null,

    init() {
        const savedMil = localStorage.getItem("sd_mileage");
        if(savedMil) this.baseMileage = parseFloat(savedMil);
        const fiv = $("fuel-input-val");
        if(fiv) fiv.value = this.baseMileage;
        
        const savedRec = localStorage.getItem("sd_record");
        this.isRecording = savedRec === "1";
        const srt = $("speed-record-toggle");
        if(srt) srt.checked = this.isRecording;
        
        const sgc = $("speed-graph-canvas");
        if(sgc) sgc.style.display = this.isRecording ? "block" : "none";

        if(fiv) fiv.addEventListener("change", (e) => { this.baseMileage = parseFloat(e.target.value) || 18; localStorage.setItem("sd_mileage", this.baseMileage); });
        if(srt) srt.addEventListener("change", (e) => { this.isRecording = e.target.checked; localStorage.setItem("sd_record", this.isRecording ? "1" : "0"); const sgc2 = $("speed-graph-canvas"); if(sgc2) sgc2.style.display = this.isRecording ? "block" : "none"; if(!this.isRecording) this.speedHistory = []; });

        const pob = $("profile-open-btn");
        if(pob) pob.addEventListener("click", () => safeShow("profile-settings-modal", "flex"));
        const csb = $("close-settings-btn");
        if(csb) csb.addEventListener("click", () => safeHide("profile-settings-modal"));
        const crb = $("close-results-btn");
        if(crb) crb.addEventListener("click", () => safeHide("results-panel"));
        
        document.addEventListener("click", () => {
            if(!this.audioCtx) { const AudioContext = window.AudioContext || window.webkitAudioContext; if(AudioContext) this.audioCtx = new AudioContext(); }
            if(this.audioCtx && this.audioCtx.state === "suspended") this.audioCtx.resume();
        }, {passive:true});
    },

    beep(freq, ms) {
        if(!this.audioCtx) return;
        try {
            if (this.audioCtx.state === "suspended") this.audioCtx.resume();
            const osc = this.audioCtx.createOscillator(), gain = this.audioCtx.createGain();
            osc.type = "square"; osc.frequency.value = freq; gain.gain.value = 0.15;
            osc.connect(gain); gain.connect(this.audioCtx.destination);
            osc.start(); osc.stop(this.audioCtx.currentTime + ms/1000);
        } catch(e) {}
    },

    triggerRedMap() {
        const overlay = $("speed-danger-overlay") || $("speed-alert-overlay");
        if(overlay) {
            overlay.classList.add("active"); clearTimeout(this.overlayTimer);
            this.overlayTimer = setTimeout(() => overlay.classList.remove("active"), 10000);
        }
    },

    checkSafetyLimits(speed) {
        const now = Date.now();
        const dial = $("speed-dial");
        if(dial) {
            if(speed > 3) {
                dial.style.display = "flex";
                const sn = $("speed-n"); if(sn) sn.textContent = Math.round(speed);
                dial.className = "speed-dial " + (speed >= 100 ? "danger" : (speed >= 80 ? "warn" : ""));
            } else { dial.style.display = "none"; }
        }

        if (now - this.lastAlertTime < 15000) return; 

        if (speed >= 100) { showToast("🚨 DANGER: Speed 100+ km/h! Slow Down!", 5000); this.triggerRedMap(); this.beep(800, 3000); this.lastAlertTime = now; } 
        else if (speed >= 80) { showToast("⚠️ WARNING: Crossing 80 km/h.", 4000); this.beep(600, 400); this.lastAlertTime = now; } 
        else if (speed >= 60) { showToast("🟢 Alert: Speed above 60 km/h.", 3000); this.lastAlertTime = now; }
    },

    tick(speedKmh, distKm) {
        this.checkSafetyLimits(speedKmh);
        
        if (!this.trip.active && !this.isRecording) return;
        
        if (this.isRecording) {
            this.speedHistory.push(speedKmh);
            if(this.speedHistory.length > 50) this.speedHistory.shift();
            this.drawGraph();
        }

        if (this.trip.active && distKm > 0) {
            this.trip.totalDist += distKm; this.trip.ticks += 1; this.trip.sumSpeed += speedKmh;
            if(speedKmh > this.trip.maxSpeed) this.trip.maxSpeed = speedKmh;
            if(speedKmh >= 40 && speedKmh <= 60) this.trip.ranges.efficient++;
            else if (speedKmh > 80) this.trip.ranges.inefficient++;
            else this.trip.ranges.moderate++;

            let currentEff = this.baseMileage;
            if (speedKmh > 60) currentEff -= (speedKmh - 60) * 0.005 * this.baseMileage; 
            else if (speedKmh < 40) currentEff -= (40 - speedKmh) * 0.004 * this.baseMileage; 
            currentEff = Math.max(2, currentEff); 
            this.trip.actualFuel += (distKm / currentEff);
        }
    },

    drawGraph() {
        const cvs = $("speed-graph-canvas"); if(!cvs || !this.isRecording) return;
        const ctx = cvs.getContext("2d"); const w = cvs.width = cvs.offsetWidth, h = cvs.height = cvs.offsetHeight;
        ctx.clearRect(0,0,w,h);
        if(this.speedHistory.length < 2) return;
        const max = Math.max(60, ...this.speedHistory);
        ctx.beginPath(); ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 2;
        this.speedHistory.forEach((v, i) => {
            const x = (i / (this.speedHistory.length - 1)) * w; const y = h - (v / max) * h * 0.8;
            if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        });
        ctx.stroke();
    },

    startTrip() { this.trip = { active: true, startTime: Date.now(), totalDist: 0, actualFuel: 0, maxSpeed: 0, sumSpeed: 0, ticks: 0, ranges: {efficient:0, moderate:0, inefficient:0} }; },
    
    endTrip() {
        if(!this.trip.active) return;
        this.trip.active = false;
        const avg = this.trip.ticks > 0 ? this.trip.sumSpeed / this.trip.ticks : 0;
        
        const rd = $("res-dist"); if(rd) rd.textContent = this.trip.totalDist.toFixed(2) + " km";
        const ras = $("res-avg-speed"); if(ras) ras.textContent = Math.round(avg) + " km/h";
        const rms = $("res-max-speed"); if(rms) rms.textContent = Math.round(this.trip.maxSpeed) + " km/h";
        const ret = $("res-eff-time"); if(ret) ret.textContent = Math.round(this.trip.ranges.efficient / 60) + " min";
        const rit = $("res-ineff-time"); if(rit) rit.textContent = Math.round(this.trip.ranges.inefficient / 60) + " min";
        const rbm = $("res-base-mlg"); if(rbm) rbm.textContent = this.baseMileage + " km/L";
        const raf = $("res-actual-fuel"); if(raf) raf.textContent = this.trip.actualFuel.toFixed(2) + " L";
        safeShow("results-panel", "flex");
    }
};

// ==========================================
// MEET UP FEATURE
// ==========================================
const GroupNavigation = {
    active: false, destination: null, selectedMembers: [], layerGroup: L.layerGroup().addTo(map),
    lastFetchedCoords: {}, colors: ['#18d6a3', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6'], recalcTimer: null,

    openSetup() {
        const list = $("group-nav-friend-list"); 
        if(!list) return;
        list.innerHTML = "";
        const activeFriends = Object.values(friendData).filter(f => f.online !== false);
        if(activeFriends.length === 0) list.innerHTML = `<div style="color:var(--muted); font-size:11px;">No friends online.</div>`;
        else activeFriends.forEach(f => {
            list.innerHTML += `<label style="display:flex; align-items:center; gap:8px; font-size:13px; color:white; cursor:pointer;"><input type="checkbox" value="${f.id}" class="group-nav-cb"><img src="${escapeHTML(f.avatar)}" style="width:28px; height:28px; border-radius:50%; object-fit:cover;">${escapeHTML(f.name)}</label>`;
        });
        safeShow("group-nav-setup", "flex");
    },
    startSelection() {
        const cbs = document.querySelectorAll(".group-nav-cb:checked");
        if(cbs.length === 0) return showToast("Select at least 1 friend.");
        if(cbs.length > 3) return showToast("Select up to 3 friends only.");
        this.selectedMembers = ["me", ...Array.from(cbs).map(cb => cb.value)];
        safeHide("group-nav-setup");
        mapActionMode = 'group-nav';
        showToast("📍 Tap the map to set the common destination!", 5000);
    },
    async setDestination(latlng) {
        this.active = true; this.destination = latlng; this.layerGroup.clearLayers(); this.lastFetchedCoords = {};
        L.marker(latlng, { icon: L.divIcon({className: 'geofence-marker', html: '🎯'}) }).bindTooltip("Group Destination", {permanent:true, direction:"top", className:"weather-badge"}).addTo(this.layerGroup);
        safeShow("group-nav-active", "flex");
        await this.calculateAll();
    },
    async calculateAll() {
        if(!this.active || !this.destination) return;
        const statsList = $("group-nav-stats-list");
        if(statsList) statsList.innerHTML = "<div style='color:var(--muted); font-size:11px; text-align:center;'>Calculating road paths...</div>";

        let statsHTML = "", validPaths = [];

        for(let i = 0; i < this.selectedMembers.length; i++) {
            const memberId = this.selectedMembers[i];
            const color = this.colors[i % this.colors.length];
            let name = "User", avatar = DEFAULT_AVATAR, coords = null;

            if (memberId === "me") { 
                if (!myCoords) continue; 
                name = "You"; avatar = currentUser.avatar; coords = myCoords; 
            } 
            else { 
                const f = friendData[memberId]; 
                if (!f || f.online === false || !validCoord(f.lat, f.lng)) continue; 
                name = f.name; avatar = f.avatar; coords = { lat: f.lat, lng: f.lng }; 
            }

            try {
                const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords.lng},${coords.lat};${this.destination.lng},${this.destination.lat}?overview=full&geometries=geojson&alternatives=true`);
                const data = await res.json();
                if(data.routes && data.routes.length > 0) {
                    const r = data.routes.reduce((a,b)=>b.distance<a.distance?b:a, data.routes[0]);
                    const pathCoords = r.geometry.coordinates.map(c => [c[1], c[0]]);
                    
                    this.layerGroup.eachLayer(l => { if(l.memberId === memberId) this.layerGroup.removeLayer(l); });
                    
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
                } else {
                    statsHTML += `<div style="color:#ef4444; font-size:11px; padding:10px;">No road route for ${escapeHTML(name)}</div>`;
                }
            } catch(e) {}
        }
        if(statsList) statsList.innerHTML = statsHTML;
        if(validPaths.length > 0) map.fitBounds(L.featureGroup(validPaths).getBounds(), { padding: [40, 40] });
    },
    onLiveUpdate() {
        if(!this.active || !this.destination) return;
        let needsRecalc = false;
        if (this.selectedMembers.includes("me") && myCoords) { 
            const last = this.lastFetchedCoords["me"]; 
            if(!last || distanceKm(last.lat, last.lng, myCoords.lat, myCoords.lng) > 0.1) needsRecalc = true; 
        }
        this.selectedMembers.forEach(id => { 
            if(id !== "me" && friendData[id]) { 
                const f = friendData[id]; const last = this.lastFetchedCoords[id]; 
                if(validCoord(f.lat, f.lng) && (!last || distanceKm(last.lat, last.lng, f.lat, f.lng) > 0.1)) needsRecalc = true; 
            }
        });
        if (needsRecalc) { 
            clearTimeout(this.recalcTimer); 
            this.recalcTimer = setTimeout(() => this.calculateAll(), 3000); 
        }
    },
    stop() { 
        this.active = false; this.destination = null; this.selectedMembers = []; 
        this.layerGroup.clearLayers(); safeHide("group-nav-active"); 
        if(myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16); 
    }
};

let groupRouteUpdateTimer = null;
let isFetchingGroupRoutes = false;

function triggerGroupRouteUpdate() {
    clearTimeout(groupRouteUpdateTimer);
    groupRouteUpdateTimer = setTimeout(() => updateGroupTripRoutes(), 1000);
}

// ==========================================
// GROUP TRIP LOGIC (Distance, Time, Fuel calculations)
// ==========================================
async function updateGroupTripRoutes() {
    if (!currentTrip || isFetchingGroupRoutes) return;
    isFetchingGroupRoutes = true;

    const promises = currentTrip.members.map(async (member, index) => {
        const color = routeColors[index % routeColors.length];
        let coords = null;
        
        if (member.id === socket.id && myCoords) coords = myCoords;
        else if (friendData[member.id] && friendData[member.id].online !== false) coords = friendData[member.id];
        
        if (coords) {
            const last = tripLastFetchedCoords[member.id];
            if (last && distanceKm(last.lat, last.lng, coords.lat, coords.lng) < 0.1) return;

            try {
                const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords.lng},${coords.lat};${currentTrip.lng},${currentTrip.lat}?geometries=geojson&alternatives=true`);
                const data = await res.json();
                
                if (data.routes && data.routes.length > 0) {
                    const r = data.routes.reduce((a,b)=>b.distance<a.distance?b:a, data.routes[0]);
                    const pathCoords = r.geometry.coordinates.map(c => [c[1], c[0]]);
                    
                    tripRoutesLayer.eachLayer(l => { if(l.memberId === member.id) tripRoutesLayer.removeLayer(l); });

                    const poly = L.polyline(pathCoords, { color: color, weight: 5, opacity: 0.8, className: 'nav-path-animated' });
                    poly.memberId = member.id;
                    poly.addTo(tripRoutesLayer);
                    
                    tripLastFetchedCoords[member.id] = { lat: coords.lat, lng: coords.lng };
                    
                    const distKm = r.distance / 1000;
                    const timeMin = Math.max(1, Math.round(r.duration / 60));
                    const mileage = SmartDrive.baseMileage || 18;
                    const fuel = distKm / mileage;
                    
                    tripRoadStats[member.id] = { dist: distKm.toFixed(1), time: timeMin, fuel: fuel.toFixed(2) };
                }
            } catch(e) {}
        }
    });

    await Promise.all(promises);
    isFetchingGroupRoutes = false;
    updateTripPanel();
}

function updateTripPanel() {
    if(!currentTrip) return;
    const list = $("trip-members-list"); if(!list) return;
    list.innerHTML = "";
    
    const isMember = currentTrip.members.some(m => m.id === socket.id);
    let totalGroupFuel = 0;

    if(myCoords && currentUser.name && isMember) {
        const stats = tripRoadStats[socket.id] || { dist: '--', time: '--', fuel: '--' };
        if(stats.fuel !== '--') totalGroupFuel += Number(stats.fuel);
        list.innerHTML += `<div class="trip-member" style="display:flex;justify-content:space-between;gap:8px;align-items:center;"><div><img src="${escapeHTML(currentUser.avatar)}"> You</div> <span style="text-align:right;">${stats.dist} km<br><small style="color:var(--muted)">${stats.time} min • ⛽ ${stats.fuel} L</small></span></div>`;
    }
    
    Object.values(friendData).filter(f => f.online !== false && currentTrip.members.some(m => m.id === f.id)).forEach(f => {
        const stats = tripRoadStats[f.id] || { dist: '--', time: '--', fuel: '--' };
        if(stats.fuel !== '--') totalGroupFuel += Number(stats.fuel);
        list.innerHTML += `<div class="trip-member" style="display:flex;justify-content:space-between;gap:8px;align-items:center;"><div><img src="${escapeHTML(f.avatar)}"> ${escapeHTML(f.name)}</div> <span style="text-align:right;">${stats.dist} km<br><small style="color:var(--muted)">${stats.time} min • ⛽ ${stats.fuel} L</small></span></div>`;
    });
    
    if(list.innerHTML) list.innerHTML+=`<div style="border-top:1px solid #333;margin-top:6px;padding-top:8px;font-size:12px;color:var(--mint);">Estimated group fuel: ${totalGroupFuel.toFixed(2)} L</div>`;
}

// ==========================================
// CORE GPS
// ==========================================
socket.on("connect", () => { 
    if (currentUser.name) socket.emit("profileReady", currentUser); 
    if(offlineMessageQueue.length > 0) {
        offlineMessageQueue.forEach(msg => socket.emit("chatMessage", msg));
        offlineMessageQueue = [];
        showToast("📶 Back online! Sent queued messages.");
    }
    if(offlineMemoryQueue.length > 0) {
        offlineMemoryQueue.forEach(mem => socket.emit("uploadMemoryPhoto", mem));
        offlineMemoryQueue = [];
        showToast("📶 Back online! Pinned queued memories.");
    }
});

function showToast(message, duration = 4000) {
    const container = $("toast-container"); if(!container) return;
    const toast = document.createElement("div"); toast.className = "toast"; toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, duration);
}

socket.on("geofenceAlert", (data) => {
    const action = data.type === "enter" ? "entered" : "left";
    showToast(`🔔 ${data.user} has ${action} ${data.fence}!`);
});

function startGPS() {
    if(!navigator.geolocation) {
        showToast("❌ Browser does not support GPS");
        return;
    }

    const processLocation = async (p) => {
        const lat = Number(p.coords.latitude), lng = Number(p.coords.longitude), acc = Number(p.coords.accuracy);
        const alt = p.coords.altitude ? Math.round(p.coords.altitude) : null;
        let speedKmh = 0; let dist = 0;
        
        if (p.coords.speed != null && p.coords.speed >= 0) speedKmh = p.coords.speed * 3.6;
        if (lastFixCoords && lastFixTime) {
            dist = Number(distanceKm(lastFixCoords.lat, lastFixCoords.lng, lat, lng)) || 0;
            const dtSec = (Date.now() - lastFixTime) / 1000;
            if (!p.coords.speed && dtSec > 0.5) speedKmh = (dist / dtSec) * 3600;
        }
        speedKmh = Math.min(speedKmh, 300); 
        
        if(!validCoord(lat,lng)) return;
        myCoords = {lat, lng, alt, speedKmh};

        locationHistory.push([lat, lng]);
        if(locationHistory.length > 1000) locationHistory.shift(); 
        historyPolyline.setLatLngs(locationHistory);
        localStorage.setItem("koraput_history", JSON.stringify(locationHistory));

        if(!ownMarker){
            ownMarker = L.marker([lat,lng],{icon:ownIcon(), zIndexOffset:1000}).addTo(map);
            map.flyTo([lat,lng], 16, {animate: true, duration: 1.5}); 
        } else {
            ownMarker.setLatLng([lat,lng]);
        }

        if(acc > 0 && acc < 100000){
            if(!accuracyCircle) accuracyCircle=L.circle([lat,lng],{radius:acc, color:"#10b981", weight:2, fillOpacity:.15}).addTo(map);
            else {accuracyCircle.setLatLng([lat,lng]); accuracyCircle.setRadius(acc);}
        }

        if (!cityName) {
            fetchCity(lat, lng).then(c => {
                if (c) {
                    cityName = c;
                    const hat = $("header-app-title"); if (hat) hat.textContent = `${cityName} Tracker`;
                    const cnt = $("city-name-text"); if (cnt) cnt.textContent = cityName;
                    else { const pc = $("pill-city"); if (pc) pc.innerHTML = `<svg class="i"><use href="#i-pin"/></svg><span>${cityName}</span>`; }
                }
            });
        }

        if (!myWeather || Date.now() - lastWeatherFetch > 180000) {
            fetchWeather(lat, lng).then(w => {
                if (w) {
                    myWeather = w;
                    lastWeatherFetch = Date.now();
                    const mtd = $("map-temp-display"); if (mtd) mtd.textContent = w;
                    const tw = $("top-weather"); if (tw) { safeShow("top-weather", "flex"); tw.textContent = w; }
                    
                    const badgeText = alt !== null ? `${w} | ⛰️${alt}m` : w;
                    if (ownMarker) ownMarker.unbindTooltip().bindTooltip(badgeText, { permanent: true, direction: "right", className: "weather-badge", offset: [15, 0] });
                }
            });
        }

        lastFixCoords = { lat, lng }; lastFixTime = Date.now();
        if (typeof SmartDrive !== 'undefined') SmartDrive.tick(speedKmh, dist);

        socket.emit("updateLocation",{name:currentUser.name, avatar:currentUser.avatar, lat, lng, alt, speedKmh, weather:myWeather});
        updateFriendBadges(); 
        
        if(typeof triggerGroupRouteUpdate === 'function') triggerGroupRouteUpdate(); 
        if(typeof GroupNavigation !== 'undefined') GroupNavigation.onLiveUpdate();
    };

    const handleGpsError = (e) => {
        console.warn("GPS error", e);
        if(e.code === 1) showToast("⚠️ GPS Permission Denied! Please enable location.", 6000);
        else showToast("⚠️ GPS Signal Lost or Weak. Trying again...", 4000);
    };

    navigator.geolocation.getCurrentPosition(processLocation, (e) => { console.warn("Fast GPS fetch failed", e); }, { enableHighAccuracy: false, timeout: 7000, maximumAge: Infinity });
    navigator.geolocation.watchPosition(processLocation, handleGpsError, { enableHighAccuracy: true, timeout: 15000, maximumAge: 2000 });
}

function updateFriendBadges(){
    Object.keys(friendMarkers).forEach(id=>{
        const f=friendData[id], m=friendMarkers[id]; if(!f||!m) return;
        let text = f.online===false ? "Offline" : f.weather;
        if(f.alt) text += ` | ⛰️${f.alt}m`;
        if(myCoords && validCoord(f.lat,f.lng)) text += ` | 📍 ${distanceKm(myCoords.lat,myCoords.lng,f.lat,f.lng)} km away`;
        m.unbindTooltip(); if(text) m.bindTooltip(text,{permanent:true,direction:"right",className:"weather-badge",offset:[15,0]});
    });
}

socket.on("onlineUsers", list=>{ if(Array.isArray(list)) list.forEach(u=>{ if(u.id!==socket.id){ friendData[u.id]={...(friendData[u.id]||{}),...u,online:true}; createOrUpdateFriendMarker(u);} }); updateOnlineUI(); });
socket.on("userOnline", u=>{ if(u.id!==socket.id){ friendData[u.id]={...(friendData[u.id]||{}),...u,online:true}; createOrUpdateFriendMarker(u); } updateOnlineUI(); });
socket.on("userOffline", d=>{ if(d?.id && friendData[d.id]){ friendData[d.id].online=false; if(friendMarkers[d.id]) friendMarkers[d.id].setOpacity(0.45); } updateOnlineUI(); });
socket.on("friendMoved", u=>{ if(u?.id) { createOrUpdateFriendMarker({...u,online:true}); updateOnlineUI(); if(typeof triggerGroupRouteUpdate === 'function') triggerGroupRouteUpdate(); }});
socket.on("friendDisconnected", id=>{ if(friendMarkers[id]){map.removeLayer(friendMarkers[id]); delete friendMarkers[id];} delete friendData[id]; updateOnlineUI(); });

function createOrUpdateFriendMarker(u){
    if(!u?.id || !validCoord(u.lat,u.lng)) return;
    friendData[u.id] = { id:u.id, name:u.name||"Friend", avatar:u.avatar||DEFAULT_AVATAR, lat:u.lat, lng:u.lng, alt:u.alt, speedKmh:u.speedKmh, weather:u.weather||"", online:u.online!==false };
    let m = friendMarkers[u.id];
    if(!m){ m=L.marker([u.lat,u.lng],{icon:friendIcon(u.avatar)}).addTo(map); m.on("click",()=>showProfilePopup(u)); friendMarkers[u.id]=m; }
    else { m.setLatLng([u.lat,u.lng]); m.setOpacity(u.online===false?0.45:1); }
    updateFriendBadges();
}

function updateOnlineUI(){
    const cs = $("chat-subtitle"); if(cs) cs.textContent = `${currentUser.name ? 1 : 0} online`;
    const box=$("online-list"); if(!box) return; box.innerHTML="";
    Object.values(friendData).filter(f=>f.online!==false).forEach(u=>{
        const btn=document.createElement("button"); btn.className="online-friend";
        btn.innerHTML=`<img src="${escapeHTML(u.avatar)}"><span><b>${escapeHTML(u.name)}</b></span><div class="status-dot"></div>`;
        btn.onclick=()=>{ map.flyTo([u.lat,u.lng],16); showProfilePopup(u); }; box.appendChild(btn);
    });
}

function showProfilePopup(u) {
    const ppa = $("profile-popup-avatar"); if(ppa) ppa.src=u.avatar; 
    const ppn = $("profile-popup-name"); if(ppn) ppn.textContent=u.name;
    const st = $("profile-popup-status");
    if(st) { st.textContent = u.online!==false ? "● Online" : "● Offline"; st.style.color = u.online!==false ? "#18d6a3" : "#8fa1aa"; }
    const ppd = $("profile-popup-distance");
    if(ppd) ppd.textContent = myCoords ? `${distanceKm(myCoords.lat,myCoords.lng,u.lat,u.lng)} km away` : "--";
    const ppw = $("profile-popup-weather");
    if(ppw) ppw.textContent = u.weather || "--";
    
    const pnb = $("profile-nav-btn");
    if(pnb) { 
        pnb.onclick = () => { 
            if(validCoord(u.lat, u.lng)) {
                safeHide("profile-popup");
                fetch(`https://router.project-osrm.org/route/v1/driving/${myCoords.lng},${myCoords.lat};${u.lng},${u.lat}?steps=true&geometries=geojson&overview=full`)
                .then(res => res.json())
                .then(data => {
                    if(data.routes && data.routes.length > 0) {
                        startSearchNavigation(u.lat, u.lng, u.name, data.routes[0]);
                    }
                });
            }
        }; 
    }
    
    if (typeof initCallButton === "function") initCallButton(u);
    
    safeShow("profile-popup", "flex");
    const fb = $("profile-focus-btn");
    if(fb) fb.onclick=()=>{ map.flyTo([u.lat,u.lng],16); safeHide("profile-popup"); };
}
const ppc = $("profile-popup-close");
if(ppc) ppc.addEventListener("click",()=>safeHide("profile-popup"));

function renderGeofenceList() {
    const list = $("geofence-items"); if(!list) return; list.innerHTML = "";
    if(currentGeofences.length === 0) {
        list.innerHTML = "<div style='color:var(--muted); font-size:12px; text-align:center;'>No active geofences.</div>";
    } else {
        currentGeofences.forEach(f => {
            const isOwner = f.ownerId === socket.id;
            const actionBtn = isOwner 
                ? `<button onclick="removeGeofence('${f.id}')" style="background:rgba(239, 68, 68, 0.2); color:#ef4444; border:none; padding:6px 12px; border-radius:8px; font-weight:bold; font-size:11px; cursor:pointer;">Remove</button>`
                : `<span style="font-size:10px; color:var(--muted); font-weight:bold;">Owner: ${escapeHTML(f.ownerName)}</span>`;

            list.innerHTML += `
            <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); padding:10px; border-radius:10px; margin-bottom:8px;">
                <div><div style="color:white; font-size:13px; font-weight:bold;">${escapeHTML(f.name)}</div><div style="color:var(--muted); font-size:11px;">Radius: ${f.radius}m</div></div>${actionBtn}
            </div>`;
        });
    }
    const modal = $("geofence-list-modal"); if(modal) modal.style.display = "flex";
}
const gflc = $("geofence-list-close");
if(gflc) gflc.addEventListener("click", () => safeHide("geofence-list-modal"));

// ==========================================
// SETUP FUNCTIONS (NULL-SAFE CHECKED)
// ==========================================
function setupBasicControlsSafe() {
    const locBtn = $("my-location-btn");
    if (locBtn) locBtn.onclick = () => {
        if (myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16, {animate:true, duration:.8});
        else showToast("📍 Waiting for GPS location...");
    };

    const compassBtn = $("compass-btn");
    if (compassBtn) compassBtn.onclick = () => {
        map.setView(map.getCenter(), map.getZoom(), {animate:true});
        const ci = $("compass-icon"); if (ci) ci.style.transform = "rotate(0deg)";
    };

    const styleBtn = $("map-style-btn");
    const sm = $("map-style-menu");
    if (styleBtn && sm) {
        styleBtn.onclick = e => {
            e.stopPropagation();
            sm.style.display = sm.style.display === "flex" ? "none" : "flex";
        };
        sm.onclick = e => {
            const b = e.target.closest("[data-style]"); if (!b) return;
            const s = b.dataset.style;
            [satelliteLayer, streetLayer, darkLayer].forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); });
            const layers = {satellite:satelliteLayer, street:streetLayer, dark:darkLayer};
            if (layers[s]) layers[s].addTo(map);
            document.querySelectorAll("#map-style-menu button").forEach(x => x.classList.toggle("active", x.dataset.style === s));
            safeHide("map-style-menu");
        };
    }

    if (window.DeviceOrientationEvent) window.addEventListener("deviceorientation", e => {
        const icon = $("compass-icon"); if (!icon) return;
        if (typeof e.webkitCompassHeading === "number") icon.style.transform = `rotate(${-e.webkitCompassHeading}deg)`;
        else if (typeof e.alpha === "number") icon.style.transform = `rotate(${e.alpha}deg)`;
    }, true);

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
}

function setupAdvancedToolsSafe() {
    const mb = $("measure-btn");
    if(mb) mb.onclick = () => {
        mapActionMode = mapActionMode === 'measure' ? null : 'measure';
        mb.classList.toggle("active-tool", mapActionMode === 'measure');
        const gb = $("geofence-btn"); if(gb) gb.classList.remove("active-tool"); 
        const tb = $("trip-btn"); if(tb) tb.classList.remove("active-tool"); 
        const gnb = $("group-nav-btn"); if(gnb) gnb.classList.remove("active-tool");
        if(mapActionMode !== 'measure') { 
            measureLayer.clearLayers(); 
            measurePoints = []; 
            const mr=$("measure-result-panel"); if(mr) mr.style.display="none"; 
        }
        else showToast("📍 Tap two points on the map to measure road distance");
    };

    const gb = $("geofence-btn");
    if(gb) gb.onclick = () => {
        geoClickCount++;
        if (geoClickCount === 3) {
            clearTimeout(geoClickTimer); geoClickCount = 0; renderGeofenceList(); return;
        }
        clearTimeout(geoClickTimer);
        geoClickTimer = setTimeout(() => {
            geoClickCount = 0; mapActionMode = mapActionMode === 'geofence' ? null : 'geofence';
            gb.classList.toggle("active-tool", mapActionMode === 'geofence');
            const mb = $("measure-btn"); if(mb) mb.classList.remove("active-tool"); 
            const tb = $("trip-btn"); if(tb) tb.classList.remove("active-tool"); 
            const gnb = $("group-nav-btn"); if(gnb) gnb.classList.remove("active-tool");
            if(mapActionMode === 'geofence') showToast("⭕ Tap map to set Geofence. (Tap button 3 times to view/delete)");
        }, 900);
    };

    const tb = $("trip-btn");
    if(tb) tb.onclick = () => {
        mapActionMode = mapActionMode === 'trip' ? null : 'trip';
        tb.classList.toggle("active-tool", mapActionMode === 'trip');
        const mb = $("measure-btn"); if(mb) mb.classList.remove("active-tool"); 
        const gb = $("geofence-btn"); if(gb) gb.classList.remove("active-tool"); 
        const gnb = $("group-nav-btn"); if(gnb) gnb.classList.remove("active-tool");
        if(mapActionMode === 'trip') showToast("🚗 Tap the map to set Group Trip Destination");
    };

    const gnb = $("group-nav-btn");
    if(gnb) gnb.onclick = () => {
        mapActionMode = mapActionMode === 'group-nav' ? null : 'group-nav';
        gnb.classList.toggle("active-tool", mapActionMode === 'group-nav');
        const mb = $("measure-btn"); if(mb) mb.classList.remove("active-tool"); 
        const gb = $("geofence-btn"); if(gb) gb.classList.remove("active-tool"); 
        const tb = $("trip-btn"); if(tb) tb.classList.remove("active-tool");
        if(mapActionMode === 'group-nav') { if(typeof GroupNavigation !== 'undefined') GroupNavigation.openSetup(); }
        else safeHide("group-nav-setup");
    };

    // MEET UP CHOOSE POINT FIX
    const gNCB = $("group-nav-close-btn");
    if(gNCB) gNCB.onclick = () => { safeHide("group-nav-setup"); mapActionMode = null; const btn = $("group-nav-btn"); if(btn) btn.classList.remove("active-tool"); };
    
    const gNNB = $("group-nav-next-btn");
    if(gNNB) gNNB.onclick = () => { if(typeof GroupNavigation !== 'undefined') GroupNavigation.startSelection(); };
    
    const gNSB = $("group-nav-stop-btn");
    if(gNSB) gNSB.onclick = () => { if(typeof GroupNavigation !== 'undefined') GroupNavigation.stop(); };

    map.on('click', (e) => {
        if (mapActionMode === 'measure') {
            measurePoints.push(e.latlng);
            L.circleMarker(e.latlng, {color: '#f59e0b', radius: 5, fillOpacity: 1}).addTo(measureLayer);
            
            if (measurePoints.length === 2) {
                const p1 = measurePoints[0], p2 = measurePoints[1];
                showToast("📏 Calculating road distance...", 2000);
                
                fetch(`https://router.project-osrm.org/route/v1/driving/${p1.lng},${p1.lat};${p2.lng},${p2.lat}?overview=full&geometries=geojson&alternatives=true`)
                .then(r => r.json())
                .then(data => {
                    measureLayer.clearLayers();
                    if(data.routes && data.routes.length > 0) {
                        const r = data.routes.reduce((a,b) => b.distance < a.distance ? b : a, data.routes[0]);
                        const coords = r.geometry.coordinates.map(c => [c[1], c[0]]);
                        L.polyline(coords, {color:'#f59e0b', weight:6, className:'nav-path-animated'}).addTo(measureLayer);
                        L.marker(p1, {icon:L.divIcon({className:'measure-point',html:'A',iconSize:[24,24],iconAnchor:[12,12]})}).addTo(measureLayer);
                        L.marker(p2, {icon:L.divIcon({className:'measure-point',html:'B',iconSize:[24,24],iconAnchor:[12,12]})}).addTo(measureLayer);
                        
                        const distKm=(r.distance/1000).toFixed(2);
                        const timeMin=Math.max(1,Math.round(r.duration/60));
                        
                        let panel=$("measure-result-panel");
                        if(!panel){ 
                            panel=document.createElement("div"); 
                            panel.id="measure-result-panel"; 
                            panel.style.cssText="position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:4500;background:rgba(10,17,28,.96);border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:12px 16px;color:#fff;box-shadow:0 15px 40px rgba(0,0,0,.45);font-size:13px;text-align:center;min-width:220px;"; 
                            document.body.appendChild(panel); 
                        }
                        panel.innerHTML=`<b style="color:#f59e0b">📏 Shortest road route</b><br><strong>${distKm} km</strong> &nbsp;•&nbsp; <strong>${timeMin} min</strong>`;
                        panel.style.display="block";
                        showToast(`📏 Shortest: ${distKm} km • ⏱️ ${timeMin} min`,5000);
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
            mapActionMode = null; const gb = $("geofence-btn"); if(gb) gb.classList.remove("active-tool");
        }
        else if (mapActionMode === 'trip') {
            const name = prompt("Enter Trip Destination Name:");
            if (name && name.trim()) { socket.emit("startTrip", { name: name.trim(), lat: e.latlng.lat, lng: e.latlng.lng }); showToast(`🚗 Trip started!`); }
            mapActionMode = null; const tb = $("trip-btn"); if(tb) tb.classList.remove("active-tool");
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
            if(typeof GroupNavigation !== 'undefined') {
                GroupNavigation.setDestination(e.latlng);
                mapActionMode = null;
            }
        }
    });

    socket.on("loadGeofences", fences => {
        currentGeofences = fences;
        p4LayerGroup.eachLayer(l => { if(l.options?.isGeofence) map.removeLayer(l); });
        fences.forEach(f => {
            L.circle([f.lat, f.lng], { radius: f.radius, color: "#8b5cf6", weight: 2, fillOpacity: 0.1, isGeofence: true }).addTo(p4LayerGroup);
            L.marker([f.lat, f.lng], { icon: L.divIcon({className: 'geofence-marker', html: '📍'}), isGeofence: true }).bindTooltip(f.name, {permanent: true, direction: "top", className: "weather-badge"}).addTo(p4LayerGroup);
        });
        const geoModal = $("geofence-list-modal"); if (geoModal && geoModal.style.display === "flex") renderGeofenceList();
    });

    socket.on("tripData", trip => {
        currentTrip = trip;
        if(tripMarker) { map.removeLayer(tripMarker); tripMarker = null; }
        if(trip) {
            safeShow("trip-panel", "flex");
            const tt = $("trip-title"); if(tt) tt.textContent = `Trip to ${trip.name}`;
            tripMarker = L.marker([trip.lat, trip.lng], { icon: L.divIcon({className: 'geofence-marker', html: '🏁'}) }).addTo(map);

            const isMember = trip.members.some(m => m.id === socket.id);
            const isHost = trip.hostId === socket.id;
            const actionBtn = $("trip-action-btn");
            
            if (actionBtn) {
                if (isHost) {
                    actionBtn.textContent = "End Trip"; actionBtn.style.color = "#ef4444"; actionBtn.style.background = "rgba(239, 68, 68, 0.2)"; 
                    actionBtn.onclick = () => { if(typeof SmartDrive!="undefined" && SmartDrive.trip.active) SmartDrive.endTrip(); socket.emit("leaveTrip"); };
                } else if (isMember) {
                    actionBtn.textContent = "Leave Trip"; actionBtn.style.color = "#f59e0b"; actionBtn.style.background = "rgba(245, 158, 11, 0.2)"; 
                    actionBtn.onclick = () => { if(typeof SmartDrive!="undefined" && SmartDrive.trip.active) SmartDrive.endTrip(); socket.emit("leaveTrip"); };
                } else {
                    actionBtn.textContent = "Join Trip"; actionBtn.style.color = "#10b981"; actionBtn.style.background = "rgba(16, 185, 129, 0.2)"; actionBtn.onclick = () => socket.emit("joinTrip");
                }
            }
            if(typeof SmartDrive !== "undefined" && isMember && !SmartDrive.trip.active) SmartDrive.startTrip();
            if(typeof triggerGroupRouteUpdate === 'function') triggerGroupRouteUpdate(); 
            if(window.renderTripChecklist) window.renderTripChecklist();
        } else {
            if(typeof SmartDrive !== "undefined" && SmartDrive.trip.active) SmartDrive.endTrip();
            tripRoutesLayer.clearLayers(); tripRoadStats = {}; safeHide("trip-panel");
        }
    });
}

function setupChatSafe() {
    const cc=$("chat-container"), inp=$("chatInput"), send=$("chat-send"), vb=$("voiceButton");
    let unread=0, typingTimer=null, replyTo=null, reactingId=null;
    const msgStore=new Map(), emojis=["👍","❤️","😂","😮","😢","🔥"];

    function updateUnreadBadge(){ const b=$("chat-unread-badge"); if(b){ b.textContent=unread>99?"99+":unread; b.style.display=unread>0?"flex":"none"; } }

    const ctb = $("chat-toggle-btn");
    if(ctb) ctb.onclick = () => { safeShow("chat-container", "flex"); safeHide("chat-toggle-btn"); unread=0; updateUnreadBadge(); if(inp) inp.focus(); };
    
    const cmb = $("chat-minimize-btn");
    if(cmb) cmb.onclick = () => { safeHide("chat-container"); safeShow("chat-toggle-btn", "flex"); };
    
    const ob = $("online-btn");
    if(ob) ob.onclick = (e) => { e.stopPropagation(); const l=$("online-list"); if(l) l.style.display = l.style.display === "block" ? "none" : "block"; updateOnlineUI(); };
    
    document.addEventListener("click", e => { 
        const ol = $("online-list");
        const obtn = $("online-btn");
        if (ol && obtn && !ol.contains(e.target) && e.target !== obtn) safeHide("online-list"); 
    });

    if(inp) {
        inp.oninput=()=>{ socket.emit("typing",true); clearTimeout(typingTimer); typingTimer=setTimeout(()=>socket.emit("typing",false), 1200); if(send && vb) { send.style.display=inp.value.trim()?"flex":"none"; vb.style.display=inp.value.trim()?"none":"flex"; } };
    }
    socket.on("typing", d=>{ const t=$("typing-indicator"); if(t) { if(d.id!==socket.id && d.isTyping){t.textContent=`${escapeHTML(d.name)} is typing…`; t.style.display="block";}else t.style.display="none"; } });

    const rc = $("reply-cancel"); if(rc) rc.onclick=()=>{replyTo=null; safeHide("reply-bar");};
    
    const eb = $("emojiButton"); if(eb) eb.onclick=(e)=>{e.stopPropagation(); safeHide("attachment-menu"); const ec=$("emoji-picker-container"); if(ec) ec.style.display=ec.style.display==="block"?"none":"block";};
    
    const ep = $("emojiPicker");
    if(ep) { ep.addEventListener("emoji-click",e=>{ const em=e.detail.unicode; if(reactingId){socket.emit("messageReaction",{messageId:reactingId,emoji:em});safeHide("emoji-picker-container");reactingId=null;}else if(inp){inp.value+=em;inp.focus();if(send) send.style.display="flex";if(vb) vb.style.display="none";} }); }
    
    const cab = $("chat-attach-btn"); if(cab) cab.onclick=(e)=>{e.stopPropagation(); safeHide("emoji-picker-container"); const am=$("attachment-menu"); if(am) am.style.display=am.style.display==="flex"?"none":"flex";};
    
    const fInp=$("chatFileInput");
    const atm = $("att-media"); if(atm) atm.onclick=()=>{if(fInp){fInp.accept="image/*,video/*";fInp.click();safeHide("attachment-menu");}};
    const atd = $("att-doc"); if(atd) atd.onclick=()=>{if(fInp){fInp.accept=".pdf,.doc,.txt,.zip";fInp.click();safeHide("attachment-menu");}};
    const ata = $("att-audio"); if(ata) ata.onclick=()=>{if(fInp){fInp.accept="audio/*";fInp.click();safeHide("attachment-menu");}};
    
    if(fInp) {
        fInp.onchange=()=>{ 
            const f=fInp.files?.[0]; if(!f) return; const r=new FileReader(); r.onload=()=>{ 
            const payload = {name:currentUser.name, type:f.type.split('/')[0]==="image"?"image":f.type.split('/')[0]==="video"?"video":f.type.split('/')[0]==="audio"?"audio":"document", data:r.result, replyTo};
            if(navigator.onLine) socket.emit("chatMessage", payload); 
            else { offlineMessageQueue.push(payload); showToast("📶 Offline: Message queued"); }
            const rcb = $("reply-cancel"); if(rcb) rcb.click();}; r.readAsDataURL(f); fInp.value="";
        };
    }

    const cForm = $("chatForm");
    if(cForm) {
        cForm.onsubmit=e=>{ 
            e.preventDefault(); if(!inp) return;
            const t=inp.value.trim(); 
            if(t){
                const payload = {name:currentUser.name,type:"text",data:t,replyTo};
                if(navigator.onLine) socket.emit("chatMessage",payload);
                else { offlineMessageQueue.push(payload); showToast("📶 Offline: Message queued"); }
                inp.value=""; const rcb = $("reply-cancel"); if(rcb) rcb.click(); if(send) send.style.display="none"; if(vb) vb.style.display="flex"; inp.focus();
            } 
        };
    }

    function renderMsg(m){
        if(msgStore.has(m.id)) return;
        const w=document.createElement("div"); w.className="chat-row "+(m.senderId===socket.id?"mine":"");
        const b=document.createElement("div"); b.className="chat-message "+(m.senderId===socket.id?"msg-mine":"msg-theirs");
        if(m.senderId!==socket.id) b.innerHTML+=`<div class="msg-sender">${escapeHTML(m.name)}</div>`;
        if(m.replyTo) b.innerHTML+=`<div class="reply-quote"><b>${escapeHTML(m.replyTo.name)}</b><br>${escapeHTML(m.replyTo.preview)}</div>`;
        
        if(m.type==="text") b.innerHTML+=`<div style="word-wrap:break-word;word-break:break-word;">${escapeHTML(m.data)}</div>`;
        else if(m.type==="image") b.innerHTML+=`<img class="chat-media" src="${m.data}">`;
        else if(m.type==="video") b.innerHTML+=`<video class="chat-media" controls src="${m.data}"></video>`;
        else if(m.type==="audio") b.innerHTML+=`<audio class="chat-audio" controls src="${m.data}"></audio>`;
        else if(m.type==="document") b.innerHTML+=`<a class="chat-document" href="${m.data}" download>📄 Download File</a>`;
        
        b.innerHTML+=`<div class="message-meta">${new Date(m.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>`;
        
        const a=document.createElement("div"); a.className="message-actions";
        emojis.forEach(e=>{const btn=document.createElement("button"); btn.className="action-btn"; btn.textContent=e; btn.onclick=()=>socket.emit("messageReaction",{messageId:m.id,emoji:e}); a.appendChild(btn);});
        const rep=document.createElement("button"); rep.className="action-btn"; rep.textContent="↩ Reply"; rep.onclick=()=>{replyTo={id:m.id,name:m.name,type:m.type,preview:m.type==="text"?m.data.slice(0,50):"Attachment"}; const rp=$("reply-preview"); if(rp) rp.textContent=`↩ ${m.name}`; safeShow("reply-bar", "flex"); if(inp) inp.focus();}; a.appendChild(rep);
        b.appendChild(a); const rr=document.createElement("div"); rr.className="reaction-row"; b.appendChild(rr); w.appendChild(b); 
        
        const chatMsgs = $("chat-messages");
        if(chatMsgs) { chatMsgs.appendChild(w); chatMsgs.scrollTop=chatMsgs.scrollHeight; }
        msgStore.set(m.id,{msg:m,el:w});
        if(m.senderId!==socket.id && cc && cc.style.display!=="flex"){unread++; updateUnreadBadge();}
    }
    socket.on("chatHistory", l=>l.forEach(renderMsg)); socket.on("chatMessage", renderMsg);
}

function setupMemoriesSafe(){
    const pgb = $("phase3-gallery-btn");
    if(pgb) pgb.onclick = () => { safeShow("phase3-memory-overlay", "block"); renderMemGallery(); };
    const pmc = $("phase3-memory-close");
    if(pmc) pmc.onclick = () => safeHide("phase3-memory-overlay");
    const pvc = $("p3-view-close");
    if(pvc) pvc.onclick = () => safeHide("phase3-photo-viewer");
    
    document.querySelectorAll(".phase3-filter").forEach(b => {
        b.onclick = () => { document.querySelectorAll(".phase3-filter").forEach(x=>x.classList.remove("active")); b.classList.add("active"); currentGalleryFilter=b.dataset.filter; renderMemGallery(); };
    });
    
    const pms = $("phase3-memory-search");
    if(pms) pms.oninput = e => { currentGallerySearch=e.target.value.toLowerCase(); renderMemGallery(); };
    
    const pvf = $("p3-view-focus");
    if(pvf) pvf.onclick = () => { const m=memories.get(selectedMemoryId); if(m) map.flyTo([m.lat,m.lng],17); safeHide("phase3-photo-viewer"); safeHide("phase3-memory-overlay"); };

    function renderMemGallery(){
        let arr = Array.from(memories.values());
        if(currentGalleryFilter==="today") arr=arr.filter(m=>new Date(m.time)>=new Date().setHours(0,0,0,0));
        else if(currentGalleryFilter==="mine") arr=arr.filter(m=>cleanName(m.name)===currentUser.name);
        if(currentGallerySearch) arr=arr.filter(m=>cleanName(m.name).toLowerCase().includes(currentGallerySearch));
        arr.sort((a,b) => new Date(b.time) - new Date(a.time));

        const pmc = $("phase3-memory-count"); if(pmc) pmc.textContent = `${arr.length} memories`;
        const grid=$("phase3-memory-grid"), time=$("phase3-timeline-list"), emp=$("phase3-memory-empty");
        if(grid) grid.innerHTML=""; if(time) time.innerHTML=""; if(emp) emp.style.display=arr.length?"none":"block";

        arr.forEach(m=>{
            if(grid) {
                const c=document.createElement("div"); c.className="p3-card";
                c.innerHTML=`<img src="${escapeHTML(m.image)}" loading="lazy"><div class="p3-card-info"><b>${escapeHTML(m.name)}</b><span>${new Date(m.time).toLocaleDateString()}</span></div>`;
                c.onclick=()=>{selectedMemoryId=m.id; const pvi=$("p3-view-image"); if(pvi) pvi.src=m.image; const pvn=$("p3-view-name"); if(pvn) pvn.textContent=m.name; const pvd=$("p3-view-date"); if(pvd) pvd.textContent=new Date(m.time).toLocaleString(); safeShow("phase3-photo-viewer", "flex");}; 
                grid.appendChild(c);
            }
            if(time) {
                const t=document.createElement("div"); t.className="p3-time-item";
                t.innerHTML=`<div class="p3-time-thumb"><img src="${escapeHTML(m.image)}" loading="lazy"></div><div class="p3-time-info"><b>${escapeHTML(m.name)}</b><span>${new Date(m.time).toLocaleString()}</span></div>`;
                t.onclick=()=>{selectedMemoryId=m.id; const pvi=$("p3-view-image"); if(pvi) pvi.src=m.image; const pvn=$("p3-view-name"); if(pvn) pvn.textContent=m.name; const pvd=$("p3-view-date"); if(pvd) pvd.textContent=new Date(m.time).toLocaleString(); safeShow("phase3-photo-viewer", "flex");}; 
                time.appendChild(t);
            }
        });
    }

    function renderPins(){
        memoryLayer.clearLayers();
        memories.forEach(m=>{
            const icon = L.divIcon({ className:"p3-memory-marker", html:`<div style="width:46px;height:46px;border-radius:50%;overflow:hidden;border:2px solid #fff;background:#071018;box-shadow:0 4px 15px rgba(0,0,0,.65)"><img src="${escapeHTML(m.image)}" style="width:100%;height:100%;object-fit:cover;"></div>`, iconSize:[46,46], iconAnchor:[23,23]});
            const marker = L.marker([m.lat,m.lng],{icon}).addTo(memoryLayer);
            
            marker.bindPopup(`<div class="p3-map-popup"><img src="${escapeHTML(m.image)}"><b style="color:var(--mint);">📸 ${escapeHTML(m.name)}</b><br><small style="color:#aaa;">${new Date(m.time).toLocaleString()}</small><br><button class="p3-open-map-memory" style="margin-top:8px;padding:6px;width:100%;background:#34e0b4;color:#000;border:none;border-radius:6px;font-weight:bold;cursor:pointer;">View Detail</button></div>`);
            
            marker.on("popupopen",e=>{ const b=e.popup.getElement()?.querySelector(".p3-open-map-memory"); if(b) b.onclick=()=>{selectedMemoryId=m.id; const pvi=$("p3-view-image"); if(pvi) pvi.src=m.image; const pvn=$("p3-view-name"); if(pvn) pvn.textContent=m.name; const pvd=$("p3-view-date"); if(pvd) pvd.textContent=new Date(m.time).toLocaleString(); safeShow("phase3-photo-viewer", "flex");}; });
        });
    }

    socket.on("loadMemoryPhotos", l=>{ memories.clear(); l.forEach(m=>memories.set(m.id,m)); renderPins(); });
    socket.on("newMemoryPin", m=>{ memories.set(m.id,m); renderPins(); const pmo=$("phase3-memory-overlay"); if(pmo && pmo.style.display==="block") renderMemGallery(); });

    const mInp=$("memoryPhotoInput");
    const mb = $("memoryButton");
    if(mb) mb.onclick=()=>{ if(!currentUser.name) return alert("Join map first."); if(mInp) mInp.click(); };
    
    const addMemBtn = $("p3-add-memory-btn");
    if(addMemBtn) addMemBtn.onclick = () => { safeHide("phase3-memory-overlay"); if(mInp) mInp.click(); };
    
    if(mInp) {
        mInp.onchange=()=>{
            const f=mInp.files?.[0]; if(!f) return;
            if(!IMAGE_TYPES.includes(f.type)||f.size>MAX_MEMORY_FILE){
                alert("Invalid image or >8MB."); 
                mInp.value=""; 
                return;
            }
            const r=new FileReader(); 
            r.onload=()=>{
                if(validImageData(r.result)){ 
                    pendingMemoryImage = r.result;
                    mapActionMode = 'memory'; 
                    showToast("📸 Photo Selected! Now TAP ANYWHERE on the map to pin it.", 5000);
                }
            }; 
            r.readAsDataURL(f); 
            mInp.value="";
        };
    }
}

function setupJoin(){
    if(currentUser.name){ 
        safeHide("join-screen"); 
        const hAv = $("header-avatar");
        if(hAv) { hAv.style.display="block"; hAv.src=currentUser.avatar; } 
        socket.emit("profileReady",currentUser); 
    }
    
    const jForm = $("join-form") || document.querySelector("form");
    
    const handleJoin = (e) => {
        if(e) e.preventDefault(); 
        
        const nInp = $("nameInput") || document.querySelector("input[type='text']");
        if(nInp && nInp.value.trim()) currentUser.name = cleanName(nInp.value); 
        else currentUser.name = "Explorer";
        
        localStorage.setItem("koraput_name",currentUser.name);
        
        const aInp = $("avatarInput") || document.querySelector("input[type='file']");
        const f = aInp ? aInp.files?.[0] : null;
        
        if(f){
            const r=new FileReader(); 
            r.onload=()=>{
                currentUser.avatar=r.result; 
                localStorage.setItem("koraput_avatar",r.result); 
                done();
            }; 
            r.readAsDataURL(f);
        } else {
            done();
        }
    };

    if(jForm) {
        jForm.addEventListener("submit", handleJoin);
    }
    
    function done(){
        safeHide("join-screen"); 
        const hAv2 = $("header-avatar");
        if(hAv2) { hAv2.style.display="block"; hAv2.src=currentUser.avatar; } 
        socket.emit("profileReady",currentUser); 
        if(typeof updateOnlineUI === 'function') updateOnlineUI();
    }
}

function setupGoogleSearch() {
    const input = $("location-search-input");
    if (!input) return;
    const clearBtn = $("location-search-clear");
    let timer = null, requestId = 0;

    const clearSearch = () => {
        input.value = "";
        if (clearBtn) clearBtn.style.display = "none";
        searchPlace = null;
        if (typeof searchLayer !== "undefined") searchLayer.clearLayers();
        if (typeof navigationLayer !== "undefined") navigationLayer.clearLayers();
        safeHide("premium-nav-ui");
        safeHide("nav-bottom-sheet");
        if (myCoords) map.flyTo([myCoords.lat,myCoords.lng],16);
    };
    if (clearBtn) clearBtn.onclick = clearSearch;

    const resultBox = document.createElement("div");
    resultBox.id = "search-results-box";
    resultBox.style.cssText = "position:fixed;top:130px;left:50%;transform:translateX(-50%);width:min(90vw,420px);max-height:300px;overflow:auto;z-index:3500;background:rgba(10,17,28,.97);border:1px solid rgba(255,255,255,.14);border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.5);display:none;padding:6px;";
    document.body.appendChild(resultBox);

    function hideResults(){ resultBox.style.display="none"; }
    function showResults(){ resultBox.style.display="block"; }

    input.addEventListener("input", () => {
        if (clearBtn) clearBtn.style.display = input.value.trim() ? "block" : "none";
        clearTimeout(timer);
        const q=input.value.trim();
        if(!q){ hideResults(); return; }
        const id=++requestId;
        timer=setTimeout(async()=>{
            try{
                let viewBoxStr = "";
                if (map) {
                    const center = map.getCenter();
                    const x1 = center.lng - 0.3, y1 = center.lat + 0.3;
                    const x2 = center.lng + 0.3, y2 = center.lat - 0.3;
                    viewBoxStr = `&viewbox=${x1},${y1},${x2},${y2}&bounded=0`;
                }

                const url=`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&countrycodes=in${viewBoxStr}&q=${encodeURIComponent(q)}`;
                const res=await fetch(url,{headers:{"Accept-Language":"en"}});
                const data=await res.json();
                if(id!==requestId) return;
                resultBox.innerHTML="";
                if(!Array.isArray(data)||!data.length){ resultBox.innerHTML='<div style="padding:14px;color:#8b9bab">No location found.</div>'; showResults(); return; }
                data.forEach(item=>{
                    const lat=Number(item.lat),lng=Number(item.lon); if(!validCoord(lat,lng)) return;
                    const name=item.name || item.display_name.split(",")[0];
                    const b=document.createElement("button");
                    b.type="button";
                    b.style.cssText="width:100%;text-align:left;padding:12px;border-radius:12px;color:#fff;background:transparent;border:0;display:flex;flex-direction:column;gap:3px;cursor:pointer;";
                    b.onmouseenter=()=>b.style.background="rgba(52,224,180,.10)";
                    b.onmouseleave=()=>b.style.background="transparent";
                    b.innerHTML=`<strong style="color:#fff;">${escapeHTML(name)}</strong><span style="font-size:11px;color:#8b9bab">${escapeHTML(item.display_name)}</span>`;
                    b.onclick=()=>selectSearchPlace({lat,lng,name,address:item.display_name});
                    resultBox.appendChild(b);
                });
                showResults();
            }catch(e){ resultBox.innerHTML='<div style="padding:14px;color:#ff6b6b">Search unavailable. Try again.</div>'; showResults(); }
        },350);
    });

    input.addEventListener("keydown",e=>{
        if(e.key==="Escape"){hideResults();input.blur();}
        if(e.key==="Enter"){const first=resultBox.querySelector("button");if(first)first.click();}
    });
    document.addEventListener("click",e=>{ if(e.target!==input && !resultBox.contains(e.target)) hideResults(); });

    let searchLayer = L.layerGroup().addTo(map);

    window.selectSearchPlace = async place => {
        searchPlace=place; hideResults(); input.value=place.name;
        if(clearBtn) clearBtn.style.display="block";
        searchLayer.clearLayers(); navigationLayer.clearLayers();
        const marker=L.marker([place.lat,place.lng],{icon:L.divIcon({className:'search-destination-marker',html:'📍',iconSize:[34,34],iconAnchor:[17,34]})}).addTo(searchLayer);
        marker.bindTooltip(place.name,{direction:'top',offset:[0,-28],className:'weather-badge'}).openTooltip();
        map.flyTo([place.lat,place.lng],16,{duration:.8});

        let route=null;
        if(myCoords){
            try{
                const url=`https://router.project-osrm.org/route/v1/driving/${myCoords.lng},${myCoords.lat};${place.lng},${place.lat}?steps=true&overview=full&geometries=geojson&alternatives=true`;
                const res=await fetch(url); const data=await res.json();
                if(data.routes?.length) route=data.routes.reduce((a,b)=>b.distance<a.distance?b:a,data.routes[0]);
            }catch(e){ route=null; }
        }

        const popup=document.createElement("div");
        popup.style.cssText="min-width:220px;text-align:center;";
        const dist=route ? (route.distance/1000).toFixed(1) : "--";
        const mins=route ? Math.max(1,Math.round(route.duration/60)) : "--";
        popup.innerHTML=`<b style="color:var(--mint);font-size:15px">📍 ${escapeHTML(place.name)}</b><div style="margin:8px 0;color:#fff">🚗 ${dist} km &nbsp;•&nbsp; ⏱️ ${mins} min</div><div style="display:flex;gap:8px"><button id="popup-directions" style="flex:1;padding:9px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-weight:800;cursor:pointer;">🗺️ Directions</button><button id="popup-start" style="flex:1;padding:9px;border:0;border-radius:10px;background:#34e0b4;color:#062112;font-weight:800;cursor:pointer;">▶ Start</button></div>`;
        marker.bindPopup(popup).openPopup();

        if(route){
            const line=L.polyline(route.geometry.coordinates.map(c=>[c[1],c[0]]),{color:'#34e0b4',weight:6,opacity:.9,className:'nav-path-animated'}).addTo(navigationLayer);
            map.fitBounds(line.getBounds(),{padding:[70,220]});
            setTimeout(()=>{
                const el=marker.getPopup()?.getElement(); if(!el)return;
                const d=el.querySelector("#popup-directions"), st=el.querySelector("#popup-start");
                if(d)d.onclick=()=>{map.fitBounds(line.getBounds(),{padding:[70,220]});showToast(`🗺️ Shortest route: ${dist} km • ⏱️ ${mins} min`,5000);};
                if(st)st.onclick=()=>{marker.closePopup();startSearchNavigation(place.lat,place.lng,place.name,route);};
            },50);
        }else{
            setTimeout(()=>{const el=marker.getPopup()?.getElement();if(el){const d=el.querySelector("#popup-directions"),st=el.querySelector("#popup-start");if(d)d.onclick=()=>showToast("⚠️ GPS required for route preview.");if(st)st.onclick=()=>showToast("⚠️ GPS required for navigation.");}},50);
        }
    };
}

let navWatchId = null;

function startSearchNavigation(destLat, destLng, destName, routeData) {
    navigationLayer.clearLayers();
    if(navWatchId) navigator.geolocation.clearWatch(navWatchId);
    
    safeHide("map-tools");
    safeHide("search-container");
    safeHide("top-header");
    safeHide("bottom-info");
    safeHide("chat-toggle-btn");
    safeHide("memoryButton");
    
    safeShow("premium-nav-ui", "block");
    safeShow("nav-bottom-sheet", "flex");
    safeShow("turn-banner", "flex");

    const fullPath = routeData.geometry.coordinates.map(c => [c[1], c[0]]);
    
    const dottedPath = L.polyline(fullPath, { color: '#4f46e5', weight: 8, opacity: 0.7, className: 'anim-dash' }).addTo(navigationLayer);
    const solidPath = L.polyline([], { color: '#34e0b4', weight: 8, opacity: 1, className: 'solid-trail' }).addTo(navigationLayer);

    const userIcon = L.divIcon({
        className: 'nav-avatar-marker',
        html: `<img src="${escapeHTML(currentUser.avatar)}" style="width:100%;height:100%;object-fit:cover; border-radius:50%; border:2px solid #34e0b4;">`,
        iconSize: [40, 40],
        iconAnchor: [20, 20]
    });
    
    const startPos = myCoords ? [myCoords.lat, myCoords.lng] : fullPath[0];
    const userMarker = L.marker(startPos, {icon: userIcon, zIndexOffset: 1000}).addTo(navigationLayer);
    L.marker([destLat, destLng], { icon: L.divIcon({className: 'geofence-marker', html: '📍'}) }).addTo(navigationLayer);

    if($("stat-dist")) $("stat-dist").innerHTML = (routeData.distance / 1000).toFixed(1) + "<small> km</small>";
    if($("stat-eta")) $("stat-eta").innerHTML = Math.round(routeData.duration / 60) + "<small> min</small>";
    
    const arrivalTime = new Date(Date.now() + routeData.duration * 1000);
    if($("nav-arrival-time")) $("nav-arrival-time").innerHTML = arrivalTime.toLocaleTimeString([], {hour: 'numeric', minute:'2-digit', hour12: true});
    
    if(routeData.legs && routeData.legs[0] && routeData.legs[0].steps && routeData.legs[0].steps.length > 0) {
        if($("nav-step-text")) $("nav-step-text").textContent = routeData.legs[0].steps[0].maneuver.type + " " + (routeData.legs[0].steps[0].maneuver.modifier || ""); 
        if($("nav-step-dist")) $("nav-step-dist").textContent = routeData.legs[0].steps[0].distance + "m";
    }
    
    if($("turn-name")) $("turn-name").textContent = "Heading to " + destName;

    map.fitBounds(dottedPath.getBounds(), { paddingBottomRight: [0, 350], paddingTopLeft: [50, 150] });

    const startBtn = $("btn-start-nav");
    const resetBtn = $("btn-reset-nav");
    const exitBtn = $("btn-exit-nav");
    
    if(startBtn) {
        startBtn.style.display = "block";
        startBtn.textContent = "Start Navigation";
        startBtn.style.background = "linear-gradient(135deg, #34d399, #22c55e)";
        startBtn.style.color = "#062112";
    }
    if(resetBtn) resetBtn.style.display = "block";
    if(exitBtn) exitBtn.style.display = "none";
    if($("stat-status")) $("stat-status").textContent = "Ready";
    if($("speed-n")) $("speed-n").textContent = "0";

    if(startBtn) {
        startBtn.onclick = () => {
            startBtn.style.display = "none";
            if(resetBtn) resetBtn.style.display = "none";
            if(exitBtn) exitBtn.style.display = "block";
            
            if($("stat-status")) {
                $("stat-status").textContent = "En route";
                $("stat-status").style.color = "#f5a524";
            }
            
            if(myCoords) map.flyTo([myCoords.lat, myCoords.lng], 18, {animate: true, duration: 1.5});
            
            SmartDrive.startTrip();
            
            if (navigator.geolocation) {
                let traveledCoords = [];
                navWatchId = navigator.geolocation.watchPosition((pos) => {
                    const currentLat = pos.coords.latitude;
                    const currentLng = pos.coords.longitude;
                    const currentPos = [currentLat, currentLng];
                    
                    const speedMps = pos.coords.speed || 0; 
                    const speedKmh = Math.round(speedMps * 3.6);
                    if($("speed-n")) $("speed-n").textContent = speedKmh;

                    userMarker.setLatLng(currentPos);
                    map.panTo(currentPos);

                    traveledCoords.push(L.latLng(currentLat, currentLng));
                    solidPath.setLatLngs(traveledCoords);

                    const remainingMeters = map.distance(currentPos, [destLat, destLng]);
                    const remainingKm = (remainingMeters / 1000).toFixed(1);
                    if($("stat-dist")) $("stat-dist").innerHTML = remainingKm + "<small> km</small>";

                    if(remainingMeters < 30) {
                        navigator.geolocation.clearWatch(navWatchId);
                        if(exitBtn) {
                            exitBtn.textContent = "Arrived";
                            exitBtn.style.background = "#3b82f6";
                            exitBtn.style.color = "white";
                        }
                        if($("stat-status")) {
                            $("stat-status").textContent = "Arrived";
                            $("stat-status").style.color = "var(--mint)";
                        }
                        if($("turn-name")) $("turn-name").textContent = "Destination reached!";
                        
                        setTimeout(() => stopDrive(), 3000);
                    }
                }, (err) => {
                    console.error("GPS Error during nav:", err);
                }, { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 });
            }
        };
    }
    
    if(resetBtn) resetBtn.onclick = () => stopDrive(true);
    if(exitBtn) exitBtn.onclick = () => stopDrive();
}

function stopDrive(cancelled = false) {
    if(navWatchId) navigator.geolocation.clearWatch(navWatchId);
    navigationLayer.clearLayers();
    safeHide("premium-nav-ui");
    safeHide("nav-bottom-sheet");
    safeHide("turn-banner");
    safeHide("speed-dial");
    
    safeShow("map-tools", "flex");
    safeShow("search-container", "flex");
    safeShow("top-header", "flex");
    safeShow("bottom-info", "flex");
    safeShow("chat-toggle-btn", "flex");
    safeShow("memoryButton", "flex");
    
    if(myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16);
    
    if(!cancelled) {
        SmartDrive.endTrip();
    }
}

// ==========================================
// VOICE CALLING (ONLINE WEBRTC & OFFLINE GSM)
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
    if(!audio) {
        audio = document.createElement("audio");
        audio.id = "remote-audio";
        audio.autoplay = true;
        audio.playsInline = true;
        audio.hidden = true;
        document.body.appendChild(audio);
    }
    
    if (event.streams && event.streams[0]) {
        audio.srcObject = event.streams[0];
    } else {
        audio.srcObject = new MediaStream([event.track]);
    }
    
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
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            peerConnection = new RTCPeerConnection(rtcConfig);
            localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

            peerConnection.ontrack = attachAudioTrack; 

            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    socket.emit("call-user", { to: u.id, signal: { type: "ice", candidate: event.candidate }, name: currentUser.name });
                }
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
        if (peerConnection) {
            socket.emit("end-call", { to: data.from });
            return;
        }
        
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
        if(acceptBtn) {
            acceptBtn.onclick = async () => {
                if (callDialog) callDialog.remove();
                callDialog = null;
                
                try {
                    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                    peerConnection = new RTCPeerConnection(rtcConfig);
                    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

                    peerConnection.ontrack = attachAudioTrack; 

                    peerConnection.onicecandidate = (event) => {
                        if (event.candidate) {
                            socket.emit("answer-call", { to: data.from, signal: { type: "ice", candidate: event.candidate } });
                        }
                    };

                    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal.sdp));
                    const answer = await peerConnection.createAnswer();
                    await peerConnection.setLocalDescription(answer);

                    socket.emit("answer-call", { to: data.from, signal: { type: "answer", sdp: answer } });
                    showToast(`🎙️ Call Connected with ${data.name}`);
                    
                    showActiveCallUI(() => socket.emit("end-call", { to: data.from }));

                    incomingIceCandidates.forEach(async (c) => {
                        try { await peerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch(e){}
                    });
                    incomingIceCandidates = [];
                    
                } catch (e) {
                    showToast("❌ Mic error.");
                    socket.emit("end-call", { to: data.from });
                    endLocalCall();
                }
            };
        }

        const rejectBtn = document.getElementById("reject-call-btn");
        if(rejectBtn) {
            rejectBtn.onclick = () => {
                if (callDialog) callDialog.remove();
                callDialog = null;
                socket.emit("end-call", { to: data.from });
            };
        }

    } else if (data.signal.type === "ice") {
        if (peerConnection && peerConnection.remoteDescription) {
            try { await peerConnection.addIceCandidate(new RTCIceCandidate(data.signal.candidate)); } catch(e){}
        } else {
            incomingIceCandidates.push(data.signal.candidate);
        }
    }
});

socket.on("call-accepted", async (signal) => {
    if (signal.type === "answer" && peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        showToast("🎙️ Call Connected!");
    } else if (signal.type === "ice" && peerConnection && peerConnection.remoteDescription) {
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch(e){}
    }
});

socket.on("call-ended", () => {
    endLocalCall();
    showToast("📴 Call Ended.");
});

function showActiveCallUI(endFn) {
    if (activeCallBtn) return;
    activeCallBtn = document.createElement("button");
    activeCallBtn.innerHTML = "📴 End Call";
    activeCallBtn.style.cssText = "position:fixed;top:80px;left:50%;transform:translateX(-50%);z-index:9999;background:#ef4444;color:white;border:none;padding:12px 24px;border-radius:30px;font-weight:bold;box-shadow:0 10px 25px rgba(239,68,68,0.5);cursor:pointer;font-size:14px;";
    document.body.appendChild(activeCallBtn);
    activeCallBtn.onclick = () => {
        endFn();
        endLocalCall();
    };
}

function endLocalCall() {
    if (activeCallBtn) { activeCallBtn.remove(); activeCallBtn = null; }
    if (callDialog) { callDialog.remove(); callDialog = null; }
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    incomingIceCandidates = [];
}

// ==========================================
// PWA APP INSTALL BUTTON LOGIC
// ==========================================
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const installBtn = $("install-app-btn");
    if (installBtn) installBtn.style.display = 'flex';
});

window.addEventListener('DOMContentLoaded', () => {
    const installBtn = $("install-app-btn");
    if (installBtn) {
        installBtn.onclick = async () => {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                if (outcome === 'accepted') {
                    installBtn.style.display = 'none'; 
                }
                deferredPrompt = null;
            }
        };
    }
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true) {
        if (installBtn) installBtn.style.display = 'none';
    }
});

window.addEventListener('appinstalled', () => {
    const installBtn = $("install-app-btn");
    if (installBtn) installBtn.style.display = 'none';
});

// ==========================================
// KORAPUT GEAR CHECKLIST & SOS FEATURE
// ==========================================
const TripChecklist = {
    items: JSON.parse(localStorage.getItem("koraput_gear")) || {
        "Action Camera & V50X Mounts": false,
        "Powerbanks & Extra Batteries": false,
        "Motorcycle & ID Documents": false,
        "Deomali Trekking Shoes": false,
        "First Aid & Meds": false
    },
    toggle(key) {
        this.items[key] = !this.items[key];
        localStorage.setItem("koraput_gear", JSON.stringify(this.items));
        this.render();
    },
    render() {
        const container = $("trip-checklist-container");
        if(!container) return; 
        container.innerHTML = `<h4 style="margin:5px 0; color:#18d6a3; font-size:13px;">🎒 Trip Gear Checklist</h4>`;
        Object.keys(this.items).forEach(item => {
            container.innerHTML += `
            <label style="display:flex; align-items:center; gap:8px; font-size:12px; color:white; cursor:pointer; margin-bottom:4px;">
                <input type="checkbox" ${this.items[item] ? "checked" : ""} onchange="TripChecklist.toggle('${item}')" style="accent-color:#18d6a3;">
                <span style="${this.items[item] ? 'text-decoration:line-through; color:#94a3b8;' : ''}">${item}</span>
            </label>`;
        });
    }
};
window.TripChecklist = TripChecklist;

function setupSOS() {
    let sosBtn = $("sos-btn");
    if (!sosBtn) {
        sosBtn = document.createElement("button");
        sosBtn.id = "sos-btn";
        sosBtn.innerHTML = "🚨 SOS";
        sosBtn.style.cssText = "position:fixed;bottom:90px;right:20px;z-index:9998;background:#ef4444;color:white;border:none;border-radius:50%;width:55px;height:55px;font-weight:900;font-size:12px;box-shadow:0 0 15px rgba(239,68,68,0.7);cursor:pointer;animation:dangerPulse 1s infinite alternate;";
        document.body.appendChild(sosBtn);
    }
    
    sosBtn.onclick = () => {
        if(!myCoords) return showToast("❌ Waiting for GPS...");
        if(confirm("🚨 SEND EMERGENCY SOS? This will alert all friends with your exact coordinates!")) {
            socket.emit("sos-alert", { 
                name: currentUser.name, 
                lat: myCoords.lat, 
                lng: myCoords.lng, 
                alt: myCoords.alt || "Unknown" 
            });
            showToast("🚨 SOS BROADCASTED TO ALL FRIENDS!", 8000);
        }
    };

    socket.on("sos-alert", (data) => {
        const div = document.createElement("div");
        div.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(239,68,68,0.3);border:10px solid #ef4444;z-index:99999;pointer-events:none;animation:dangerPulse 1s infinite alternate;";
        document.body.appendChild(div);
        
        showToast(`🚨 URGENT SOS FROM ${data.name.toUpperCase()}! Check Map!`, 15000);
        
        L.marker([data.lat, data.lng], {
            icon: L.divIcon({className: 'sos-marker', html: '<div style="font-size:30px;animation:dangerPulse 1s infinite alternate;">🚨</div>'})
        }).bindPopup(`<b style="color:red;">EMERGENCY SOS: ${data.name}</b>`).addTo(map).openPopup();
        
        map.flyTo([data.lat, data.lng], 16, {animate:true, duration: 2});
        setTimeout(() => div.remove(), 10000);
    });
}

function initApp(){ 
    const tasks = [
        { name: "Join Setup", fn: setupJoin },
        { name: "Controls", fn: setupBasicControlsSafe },
        { name: "Advanced Tools", fn: setupAdvancedToolsSafe },
        { name: "Chat UI", fn: setupChatSafe },
        { name: "Memories", fn: setupMemoriesSafe },
        { name: "SmartDrive", fn: () => SmartDrive.init() },
        { name: "GPS System", fn: startGPS },
        { name: "Google Search", fn: setupGoogleSearch },
        { name: "Emergency SOS", fn: setupSOS }
    ];

    tasks.forEach(task => {
        try {
            task.fn();
        } catch(e) {
            console.error(`[INIT ERROR] Failed to load ${task.name}:`, e);
        }
    });
    
    setTimeout(() => {
        try {
            if($("trip-panel") && !$("trip-checklist-container")) {
                const listDiv = document.createElement("div");
                listDiv.id = "trip-checklist-container";
                listDiv.style.cssText = "background:rgba(255,255,255,0.05); padding:10px; border-radius:10px; margin-top:10px;";
                $("trip-panel").insertBefore(listDiv, $("trip-action-btn"));
                TripChecklist.render();
            }
        } catch(e) { console.error(e); }
    }, 1000);
}

if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", initApp); else initApp();
