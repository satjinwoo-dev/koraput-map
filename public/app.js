"use strict";

const socket = io({ transports: ["websocket", "polling"] });
const DEFAULT_CENTER = [18.8136, 82.7153];
const DEFAULT_AVATAR = "satyam.png";
const MAX_NAME = 40;
const MAX_CHAT_FILE = 5 * 1024 * 1024;
const MAX_MEMORY_FILE = 8 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const map = L.map("map", { zoomControl: false, preferCanvas: true, minZoom: 3, maxBounds: [[-90, -180], [90, 180]] }).setView(DEFAULT_CENTER, 13);
const satelliteLayer = L.tileLayer("https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}", { maxZoom: 20, subdomains: ["mt0","mt1","mt2","mt3"] }).addTo(map);

let currentUser = { name: localStorage.getItem("koraput_name") || "", avatar: localStorage.getItem("koraput_avatar") || DEFAULT_AVATAR };
let myCoords = null, myWeather = "", ownMarker = null, accuracyCircle = null, cityName = "";
let lastEmittedCoords = null; 
let lastWeatherFetch = 0;
const friendMarkers = Object.create(null);
const friendData = Object.create(null);

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
const searchLayer = L.layerGroup().addTo(map);

const tripLastFetchedCoords = {}; 
let tripRoadStats = {}; 
const routeColors = ['#18d6a3', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6']; 

let mapActionMode = null; 
let pendingMemoryImage = null; 
let measurePoints = [];
let currentTrip = null;
let tripMarker = null;
let searchPlace = null;
let currentGeofences = []; 
const memories = new Map();
let currentGalleryFilter = "all", currentGallerySearch = "", selectedMemoryId = null;

const $ = id => document.getElementById(id);
const cleanName = v => String(v || "User").trim().replace(/\s+/g," ").slice(0, MAX_NAME);
const validCoord = (lat,lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat>=-90 && lat<=90 && lng>=-180 && lng<=180;
const validImageData = v => typeof v === "string" && v.startsWith("data:image/");

function distanceKm(a,b,c,d){
    if(!validCoord(a,b) || !validCoord(c,d)) return 0;
    const p = Math.PI/180, a1 = 0.5 - Math.cos((c-a)*p)/2 + Math.cos(a*p)*Math.cos(c*p)*Math.sin((d-b)*p/2)**2;
    return (12742 * Math.asin(Math.sqrt(a1)));
}
function escapeHTML(v) { return String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;"); }

function ownIcon() { 
    return L.divIcon({ className: "custom-own-icon", html: `<div style="width:100%; height:100%; border-radius:50%; border:2.5px solid #18d6a3; overflow:hidden; background:#071018; box-sizing:border-box;"><img src="${escapeHTML(currentUser.avatar)}" style="width:100%; height:100%; object-fit:cover;"></div>`, iconSize: [38, 38], iconAnchor: [19, 19] }); 
}

function friendIcon(avatar) { 
    return L.divIcon({ className: "custom-friend-icon", html: `<div style="width:100%; height:100%; border-radius:50%; border:2px solid #3b82f6; overflow:hidden; background:#071018; box-sizing:border-box;"><img src="${escapeHTML(avatar)}" style="width:100%; height:100%; object-fit:cover;"></div>`, iconSize: [36, 36], iconAnchor: [18, 18] }); 
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
        if (r.ok) { const d = await r.json(); return d.address?.city || d.address?.town || d.address?.county || "Rourkela"; }
    } catch { return "Rourkela"; }
}

function showToast(message, duration = 4000) {
    const container = $("toast-container"); if(!container) return;
    const toast = document.createElement("div"); toast.className = "toast"; toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, duration);
}

// CENTRALIZED OSRM ROUTING ENGINE
async function getRoadRoute(from, to, alternatives = false) {
    const alt = alternatives ? "true" : "false";
    const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?steps=true&geometries=geojson&overview=full&alternatives=${alt}`);
    if (!res.ok) throw new Error("Routing server error");
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes.length) throw new Error("No viable road route found");
    return data.routes;
}

// ==========================================
// TRUE LIVE NAVIGATION
// ==========================================
const Navigation = {
    active: false, targetCoords: null, targetName: '', lastRecalcTime: 0,
    
    async start(targetLat, targetLng, name) {
        if(!myCoords) return showToast("Waiting for GPS...");
        this.active = true; this.targetCoords = { lat: targetLat, lng: targetLng }; this.targetName = name;
        
        $("location-bottom-sheet").style.transform = "translateY(120%)";
        if($("profile-popup")) $("profile-popup").style.display = "none";
        
        $("nav-target-name").textContent = name;
        $("nav-panel").style.display = "flex";
        await this.calculate();
    },

    async previewCustom(lat, lng, name) {
        if(!myCoords) return showToast("Waiting for GPS...");
        navigationLayer.clearLayers();
        try {
            const routes = await getRoadRoute(myCoords, {lat, lng}, false);
            const r = routes[0];
            const coords = r.geometry.coordinates.map(c => [c[1], c[0]]); 
            L.polyline(coords, { color: '#3b82f6', weight: 6, opacity: 0.9 }).addTo(navigationLayer);
            map.fitBounds(L.polyline(coords).getBounds(), { padding: [50, 50] });
            const distKm = (r.distance / 1000).toFixed(1);
            const timeMin = Math.round(r.duration / 60);
            showToast(`🚗 Path to ${name}: ${distKm} km • ⏱️ ${timeMin} mins`, 5000);
        } catch (e) { showToast("Failed to preview route."); }
    },

    async calculate() {
        if(!this.active || !myCoords || !this.targetCoords) return;
        navigationLayer.clearLayers();
        $("nav-inst-text").textContent = "Analyzing best route...";
        $("nav-inst-arrow").textContent = "↻";
        $("nav-instruction-sub").textContent = "";

        try {
            const routes = await getRoadRoute(myCoords, this.targetCoords, false);
            const r = routes[0];
            const coords = r.geometry.coordinates.map(c => [c[1], c[0]]); 
            
            L.polyline(coords, { color: '#3b82f6', weight: 6, opacity: 0.9, className: 'nav-path-animated' }).addTo(navigationLayer);
            
            $("nav-dist").textContent = `${(r.distance / 1000).toFixed(1)} km`;
            const mins = Math.round(r.duration / 60);
            $("nav-time").textContent = mins > 60 ? `${Math.floor(mins/60)}h ${mins%60}m` : `${mins} min`;
            
            if(r.legs[0] && r.legs[0].steps && r.legs[0].steps.length > 1) {
                const step = r.legs[0].steps[1]; 
                let arrow = "↑";
                if(step.maneuver.modifier) { 
                    if(step.maneuver.modifier.includes('right')) arrow = "↱"; 
                    if(step.maneuver.modifier.includes('left')) arrow = "↰"; 
                }
                $("nav-inst-arrow").textContent = arrow;
                $("nav-inst-text").textContent = step.maneuver.instruction || "Continue straight";
                $("nav-instruction-sub").textContent = `In ${Math.round(step.distance)} meters`;
            } else {
                $("nav-inst-arrow").textContent = "🏁";
                $("nav-inst-text").textContent = "Head to destination";
            }
            
            this.lastRecalcTime = Date.now();
            map.panTo([myCoords.lat, myCoords.lng]);
        } catch (e) { 
            $("nav-inst-text").textContent = "Navigation error. Re-routing...";
        }
    },
    
    stop() {
        this.active = false; this.targetCoords = null;
        navigationLayer.clearLayers();
        $("nav-panel").style.display = "none";
        if(myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16);
    },

    onLiveUpdate() {
        if(!this.active || !myCoords || !this.targetCoords) return;
        const timeSinceRecalc = Date.now() - this.lastRecalcTime;
        if(timeSinceRecalc > 20000) this.calculate();
        else map.panTo([myCoords.lat, myCoords.lng], {animate: true});
    }
};

$("nav-exit-btn").onclick = () => Navigation.stop();
$("nav-recalc-btn").onclick = () => Navigation.calculate();

// ==========================================
// GROUP NAVIGATION
// ==========================================
const GroupNavigation = {
    active: false, destination: null, selectedMembers: [], layerGroup: L.layerGroup().addTo(map),
    lastFetchedCoords: {}, colors: ['#18d6a3', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6'], recalcTimer: null,

    openSetup() {
        const list = $("group-nav-friend-list"); list.innerHTML = "";
        const activeFriends = Object.values(friendData).filter(f => f.online !== false);
        if(activeFriends.length === 0) list.innerHTML = `<div style="color:var(--muted); font-size:11px;">No friends online.</div>`;
        else activeFriends.forEach(f => {
            list.innerHTML += `<label style="display:flex; align-items:center; gap:8px; font-size:13px; color:white; cursor:pointer;"><input type="checkbox" value="${f.id}" class="group-nav-cb"><img src="${escapeHTML(f.avatar)}" style="width:28px; height:28px; border-radius:50%; object-fit:cover;">${escapeHTML(f.name)}</label>`;
        });
        $("group-nav-setup").style.display = "flex";
    },
    startSelection() {
        const cbs = document.querySelectorAll(".group-nav-cb:checked");
        if(cbs.length === 0) return showToast("Select at least 1 friend.");
        if(cbs.length > 3) return showToast("Select up to 3 friends only.");
        this.selectedMembers = ["me", ...Array.from(cbs).map(cb => cb.value)];
        $("group-nav-setup").style.display = "none";
        mapActionMode = 'group-nav';
        showToast("📍 Tap the map to set the common destination!", 5000);
    },
    async setDestination(latlng) {
        this.active = true; this.destination = latlng; this.layerGroup.clearLayers(); this.lastFetchedCoords = {};
        L.marker(latlng, { icon: L.divIcon({className: 'geofence-marker', html: '🎯'}) }).bindTooltip("Group Destination", {permanent:true, direction:"top", className:"weather-badge"}).addTo(this.layerGroup);
        $("group-nav-active").style.display = "flex";
        await this.calculateAll();
    },
    async calculateAll() {
        if(!this.active || !this.destination) return;
        $("group-nav-stats-list").innerHTML = "<div style='color:var(--muted); font-size:11px; text-align:center;'>Calculating road paths...</div>";

        let statsHTML = "", validPaths = [];

        for(let i = 0; i < this.selectedMembers.length; i++) {
            const memberId = this.selectedMembers[i];
            const color = this.colors[i % this.colors.length];
            let name = "User", avatar = DEFAULT_AVATAR, coords = null;

            if (memberId === "me") { if (!myCoords) continue; name = "You"; avatar = currentUser.avatar; coords = myCoords; } 
            else { const f = friendData[memberId]; if (!f || f.online === false || !validCoord(f.lat, f.lng)) continue; name = f.name; avatar = f.avatar; coords = { lat: f.lat, lng: f.lng }; }

            try {
                const routes = await getRoadRoute(coords, this.destination, false);
                if(routes && routes.length > 0) {
                    const r = routes[0];
                    const pathCoords = r.geometry.coordinates.map(c => [c[1], c[0]]);
                    this.layerGroup.eachLayer(l => { if(l.memberId === memberId) this.layerGroup.removeLayer(l); });
                    const poly = L.polyline(pathCoords, { color: color, weight: 5, opacity: 0.8, className: 'nav-path-animated' });
                    poly.memberId = memberId; poly.addTo(this.layerGroup); validPaths.push(poly);

                    const distKm = (r.distance / 1000).toFixed(1); const timeMin = Math.round(r.duration / 60);
                    statsHTML += `<div style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:rgba(255,255,255,0.05); border-radius:10px; border-left:4px solid ${color};"><div style="display:flex; align-items:center; gap:10px;"><img src="${escapeHTML(avatar)}" style="width:30px; height:30px; border-radius:50%; object-fit:cover;"><span style="color:white; font-size:13px; font-weight:bold;">${escapeHTML(name)}</span></div><div style="text-align:right;"><div style="color:white; font-size:13px; font-weight:bold;">${distKm} km</div><div style="color:var(--muted); font-size:11px;">${timeMin} min</div></div></div>`;
                    this.lastFetchedCoords[memberId] = { lat: coords.lat, lng: coords.lng };
                } else statsHTML += `<div style="color:#ef4444; font-size:11px; padding:10px;">No road route for ${escapeHTML(name)}</div>`;
            } catch(e) {}
        }
        $("group-nav-stats-list").innerHTML = statsHTML;
        if(validPaths.length > 0) map.fitBounds(L.featureGroup(validPaths).getBounds(), { padding: [40, 40] });
    },
    onLiveUpdate() {
        if(!this.active || !this.destination) return;
        let needsRecalc = false;
        if (this.selectedMembers.includes("me") && myCoords) { const last = this.lastFetchedCoords["me"]; if(!last || distanceKm(last.lat, last.lng, myCoords.lat, myCoords.lng) > 0.1) needsRecalc = true; }
        this.selectedMembers.forEach(id => { if(id !== "me" && friendData[id]) { const f = friendData[id]; const last = this.lastFetchedCoords[id]; if(validCoord(f.lat, f.lng) && (!last || distanceKm(last.lat, last.lng, f.lat, f.lng) > 0.1)) needsRecalc = true; }});
        if (needsRecalc) { clearTimeout(this.recalcTimer); this.recalcTimer = setTimeout(() => this.calculateAll(), 3000); }
    },
    stop() { this.active = false; this.destination = null; this.selectedMembers = []; this.layerGroup.clearLayers(); $("group-nav-active").style.display = "none"; if(myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16); }
};

if($("group-nav-close-btn")) $("group-nav-close-btn").onclick = () => { $("group-nav-setup").style.display = "none"; mapActionMode = null; clearActiveTools(); };
if($("group-nav-next-btn")) $("group-nav-next-btn").onclick = () => GroupNavigation.startSelection();
if($("group-nav-stop-btn")) $("group-nav-stop-btn").onclick = () => GroupNavigation.stop();

// ==========================================
// GPS & SOCKET CONNECTION
// ==========================================
socket.on("connect", () => { if (currentUser.name) socket.emit("profileReady", currentUser); });

socket.on("geofenceAlert", (data) => {
    const action = data.type === "enter" ? "entered" : "left";
    showToast(`🔔 ${data.user} has ${action} ${data.fence}!`);
});

function startGPS() {
    if(!navigator.geolocation) return;
    navigator.geolocation.watchPosition(async p => {
        const lat = Number(p.coords.latitude), lng = Number(p.coords.longitude);
        if(!validCoord(lat,lng)) return;
        
        myCoords = {lat, lng};
        locationHistory.push([lat, lng]);
        if(locationHistory.length > 1000) locationHistory.shift(); 
        historyPolyline.setLatLngs(locationHistory);
        localStorage.setItem("koraput_history", JSON.stringify(locationHistory));

        if(!ownMarker){
            ownMarker = L.marker([lat,lng],{icon:ownIcon(), zIndexOffset:1000}).addTo(map);
            map.setView([lat,lng], 16);
        } else {
            ownMarker.setLatLng([lat,lng]);
        }

        if (!cityName) {
            cityName = await fetchCity(lat, lng);
            if (cityName) {
                if ($("header-app-title")) $("header-app-title").textContent = `${cityName} Map`;
                if ($("pill-city")) $("pill-city").textContent = `📍 ${cityName}`;
            }
        }

        if (!myWeather || Date.now() - lastWeatherFetch > 180000) {
            const w = await fetchWeather(lat, lng);
            if (w) {
                myWeather = w; lastWeatherFetch = Date.now();
                if ($("map-temp-display")) $("map-temp-display").textContent = w;
                if (ownMarker) ownMarker.unbindTooltip().bindTooltip(w, { permanent: true, direction: "right", className: "weather-badge", offset: [15, 0] });
            }
        }

        // GPS Throttling: Only emit if moved > 10 meters
        const movedEnough = !lastEmittedCoords || distanceKm(lastEmittedCoords.lat, lastEmittedCoords.lng, lat, lng) > 0.01;
        if (movedEnough) {
            socket.emit("updateLocation", {name: currentUser.name, avatar: currentUser.avatar, lat, lng, weather: myWeather});
            lastEmittedCoords = {lat, lng};
            updateFriendBadges(); 
        }

        triggerGroupRouteUpdate(); 
        Navigation.onLiveUpdate(); 
        GroupNavigation.onLiveUpdate(); 
    }, e => console.warn("GPS error",e), {enableHighAccuracy: true, timeout: 15000, maximumAge: 3000});
}

function updateFriendBadges(){
    Object.keys(friendMarkers).forEach(id=>{
        const f=friendData[id], m=friendMarkers[id]; if(!f||!m) return;
        let text = f.online===false ? "Offline" : f.weather;
        if(myCoords && validCoord(f.lat,f.lng)) text += ` | 📍 ${distanceKm(myCoords.lat,myCoords.lng,f.lat,f.lng).toFixed(1)} km`;
        m.unbindTooltip(); if(text) m.bindTooltip(text,{permanent:true,direction:"right",className:"weather-badge",offset:[15,0]});
    });
}

socket.on("onlineUsers", list=>{ if(Array.isArray(list)) list.forEach(u=>{ if(u.id!==socket.id){ friendData[u.id]={...(friendData[u.id]||{}),...u,online:true}; createOrUpdateFriendMarker(u);} }); updateOnlineUI(); });
socket.on("userOnline", u=>{ if(u.id!==socket.id){ friendData[u.id]={...(friendData[u.id]||{}),...u,online:true}; createOrUpdateFriendMarker(u); } updateOnlineUI(); });
socket.on("userOffline", d=>{ if(d?.id && friendData[d.id]){ friendData[d.id].online=false; if(friendMarkers[d.id]) friendMarkers[d.id].setOpacity(0.45); } updateOnlineUI(); });
socket.on("friendMoved", u=>{ if(u?.id) { createOrUpdateFriendMarker({...u,online:true}); updateOnlineUI(); triggerGroupRouteUpdate(); Navigation.onLiveUpdate(); GroupNavigation.onLiveUpdate(); }});
socket.on("friendDisconnected", id=>{ if(friendMarkers[id]){map.removeLayer(friendMarkers[id]); delete friendMarkers[id];} delete friendData[id]; updateOnlineUI(); });

function createOrUpdateFriendMarker(u){
    if(!u?.id || !validCoord(u.lat,u.lng)) return;
    friendData[u.id] = { id:u.id, name:u.name||"Friend", avatar:u.avatar||DEFAULT_AVATAR, lat:u.lat, lng:u.lng, weather:u.weather||"", online:u.online!==false };
    let m = friendMarkers[u.id];
    if(!m){ m=L.marker([u.lat,u.lng],{icon:friendIcon(u.avatar)}).addTo(map); m.on("click",()=>showProfilePopup(u)); friendMarkers[u.id]=m; }
    else { m.setLatLng([u.lat,u.lng]); m.setOpacity(u.online===false?0.45:1); }
    updateFriendBadges();
}

function updateOnlineUI(){
    const list = $("friends-list"); if(!list) return;
    list.innerHTML = "";
    Object.values(friendData).filter(f => f.online !== false).forEach(u => {
        const dist = myCoords && validCoord(u.lat, u.lng) ? `${distanceKm(myCoords.lat, myCoords.lng, u.lat, u.lng).toFixed(1)} km away` : 'Location unknown';
        const item = document.createElement("div");
        item.className = "friend-list-item";
        item.innerHTML = `<img src="${escapeHTML(u.avatar)}"><div class="friend-info-col"><span class="friend-list-name">${escapeHTML(u.name)}</span><span class="friend-list-dist">${dist}</span></div><div class="status-dot-small"></div>`;
        item.onclick = () => { map.flyTo([u.lat,u.lng], 16); showProfilePopup(u); }; 
        list.appendChild(item);
    });
}

function showProfilePopup(u) {
    if($("profile-popup-avatar")) $("profile-popup-avatar").src=u.avatar; 
    if($("profile-popup-name")) $("profile-popup-name").textContent=u.name;
    const st = $("profile-popup-status");
    if(st) { st.textContent = u.online!==false ? "● Online" : "● Offline"; st.style.color = u.online!==false ? "#18d6a3" : "#8fa1aa"; }
    const dist = myCoords && validCoord(u.lat, u.lng) ? `${distanceKm(myCoords.lat, myCoords.lng, u.lat, u.lng).toFixed(1)} km` : '--';
    if($("profile-popup-distance")) $("profile-popup-distance").textContent = dist;
    
    if($("profile-nav-btn")) $("profile-nav-btn").onclick = () => { if(validCoord(u.lat, u.lng)) Navigation.start(u.lat, u.lng, u.name); };
    
    if($("profile-popup")) $("profile-popup").style.display="flex";
    if($("profile-focus-btn")) $("profile-focus-btn").onclick=()=>{ map.flyTo([u.lat,u.lng],16); $("profile-popup").style.display="none"; };
}
$("profile-popup-close")?.addEventListener("click",()=>$("profile-popup").style.display="none");

// ==========================================
// ADVANCED MAP TOOLS
// ==========================================
window.removeGeofence = (id) => { socket.emit("removeGeofence", id); };

function renderGeofenceList() {
    const list = $("geofence-items"); list.innerHTML = "";
    if(currentGeofences.length === 0) { list.innerHTML = "<div style='color:var(--muted); font-size:12px; text-align:center;'>No active geofences.</div>"; } 
    else {
        currentGeofences.forEach(f => {
            const isOwner = f.ownerId === socket.id;
            const actionBtn = isOwner ? `<button onclick="removeGeofence('${f.id}')" style="background:rgba(239, 68, 68, 0.2); color:#ef4444; border:none; padding:6px 12px; border-radius:8px; font-weight:bold; font-size:11px; cursor:pointer;">Remove</button>` : `<span style="font-size:10px; color:var(--muted); font-weight:bold;">Owner: ${escapeHTML(f.ownerName)}</span>`;
            list.innerHTML += `<div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); padding:10px; border-radius:10px;"><div><div style="color:white; font-size:13px; font-weight:bold;">${escapeHTML(f.name)}</div><div style="color:var(--muted); font-size:11px;">Radius: ${f.radius}m</div></div>${actionBtn}</div>`;
        });
    }
    $("geofence-list-modal").style.display = "flex";
}
if($("geofence-list-close")) $("geofence-list-close").onclick = () => $("geofence-list-modal").style.display = "none";

function clearActiveTools() {
    document.querySelectorAll('.tool-option').forEach(b => b.classList.remove('active-tool'));
}

function setupAdvancedTools() {
    $("main-tools-btn").onclick = () => {
        const menu = $("tools-menu");
        menu.style.display = menu.style.display === "flex" ? "none" : "flex";
    };

    $("measure-btn").onclick = () => {
        mapActionMode = mapActionMode === 'measure' ? null : 'measure';
        clearActiveTools();
        if(mapActionMode) { $("measure-btn").classList.add("active-tool"); measureLayer.clearLayers(); measurePoints = []; showToast("📍 Tap 2 points to measure road routes"); }
        $("tools-menu").style.display = "none";
    };

    let geoClickCount = 0, geoClickTimer = null;
    $("geofence-btn").onclick = () => {
        geoClickCount++;
        if (geoClickCount === 3) { clearTimeout(geoClickTimer); geoClickCount = 0; renderGeofenceList(); $("tools-menu").style.display = "none"; return; }
        clearTimeout(geoClickTimer);
        geoClickTimer = setTimeout(() => {
            geoClickCount = 0; mapActionMode = mapActionMode === 'geofence' ? null : 'geofence';
            clearActiveTools();
            if(mapActionMode) { $("geofence-btn").classList.add("active-tool"); showToast("⭕ Tap map to set Geofence. (Tap button 3 times to delete)"); }
            $("tools-menu").style.display = "none";
        }, 300);
    };

    $("trip-btn").onclick = () => {
        mapActionMode = mapActionMode === 'trip' ? null : 'trip';
        clearActiveTools();
        if(mapActionMode) { $("trip-btn").classList.add("active-tool"); showToast("🚗 Tap the map to set Group Trip Destination"); }
        $("tools-menu").style.display = "none";
    };

    $("group-nav-btn").onclick = () => {
        mapActionMode = mapActionMode === 'group-nav' ? null : 'group-nav';
        clearActiveTools();
        if(mapActionMode) { $("group-nav-btn").classList.add("active-tool"); GroupNavigation.openSetup(); }
        else $("group-nav-setup").style.display = "none";
        $("tools-menu").style.display = "none";
    };

    map.on('click', async (e) => {
        if (mapActionMode === 'measure') {
            measurePoints.push(e.latlng);
            L.circleMarker(e.latlng, {color: '#f59e0b', radius: 5, fillOpacity: 1}).addTo(measureLayer);
            
            if (measurePoints.length === 2) {
                const [p1, p2] = measurePoints;
                showToast("📏 Calculating shortest & fastest routes...", 2000);
                try {
                    const routes = await getRoadRoute(p1, p2, true);
                    measureLayer.clearLayers();
                    if(routes.length > 1) {
                        const altCoords = routes[1].geometry.coordinates.map(c => [c[1], c[0]]);
                        L.polyline(altCoords, {color: '#8d9ba2', weight: 4, opacity: 0.6}).addTo(measureLayer);
                    }
                    const mainCoords = routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
                    L.polyline(mainCoords, {color: '#f59e0b', weight: 5, className: 'nav-path-animated'}).addTo(measureLayer);
                    const d1 = (routes[0].distance / 1000).toFixed(1); const t1 = Math.round(routes[0].duration / 60);
                    if (routes.length > 1) {
                        const d2 = (routes[1].distance / 1000).toFixed(1); const t2 = Math.round(routes[1].duration / 60);
                        showToast(`🏎️ Fastest: ${d1}km (${t1}m) | 📏 Alt: ${d2}km (${t2}m)`, 6000);
                    } else { showToast(`📏 Route: ${d1} km • ⏱️ ${t1} mins`, 5000); }
                    map.fitBounds(L.polyline(mainCoords).getBounds(), { padding: [50, 50] });
                } catch(error) {
                    measureLayer.clearLayers(); showToast("❌ Road route unavailable. Try again.", 4000);
                }
                setTimeout(() => { measureLayer.clearLayers(); measurePoints = []; mapActionMode = null; clearActiveTools(); }, 6000);
            }
        } 
        else if (mapActionMode === 'geofence') {
            const name = prompt("Enter Geofence Name (e.g., Home, College):");
            if (name && name.trim()) {
                const radInput = prompt("Enter Geofence Radius in meters (10 to 50000):", "500");
                const radius = Number(radInput);
                if (Number.isFinite(radius) && radius >= 10 && radius <= 50000) {
                    socket.emit("addGeofence", { name: name.trim(), lat: e.latlng.lat, lng: e.latlng.lng, radius: radius });
                    showToast(`⭕ Geofence '${name}' created with ${radius}m radius!`);
                } else showToast("❌ Invalid radius!");
            }
            mapActionMode = null; clearActiveTools();
        }
        else if (mapActionMode === 'trip') {
            const name = prompt("Enter Trip Destination Name:");
            if (name && name.trim()) {
                socket.emit("startTrip", { name: name.trim(), lat: e.latlng.lat, lng: e.latlng.lng });
                showToast(`🚗 Trip started to ${name}!`);
            }
            mapActionMode = null; clearActiveTools();
        }
        else if (mapActionMode === 'group-nav') {
            GroupNavigation.setDestination(e.latlng);
            mapActionMode = null; clearActiveTools();
        }
        else if (mapActionMode === 'memory') {
            if (pendingMemoryImage) socket.emit("uploadMemoryPhoto", { name: currentUser.name, lat: e.latlng.lat, lng: e.latlng.lng, image: pendingMemoryImage });
            showToast("✅ Memory pinned successfully!");
            mapActionMode = null; pendingMemoryImage = null; clearActiveTools();
        }
    });

    socket.on("loadGeofences", fences => {
        currentGeofences = fences;
        p4LayerGroup.eachLayer(l => { if(l.options?.isGeofence) map.removeLayer(l); });
        fences.forEach(f => {
            L.circle([f.lat, f.lng], { radius: f.radius, color: "#8b5cf6", weight: 2, fillOpacity: 0.1, isGeofence: true }).addTo(p4LayerGroup);
            L.marker([f.lat, f.lng], { icon: L.divIcon({className: 'geofence-marker', html: '📍'}), isGeofence: true }).bindTooltip(f.name, {permanent: true, direction: "top", className: "weather-badge"}).addTo(p4LayerGroup);
        });
        if($("geofence-list-modal").style.display === "flex") renderGeofenceList();
    });

    socket.on("tripData", trip => {
        currentTrip = trip;
        if(tripMarker) { map.removeLayer(tripMarker); tripMarker = null; }
        if(trip) {
            $("trip-panel").style.display = "flex";
            $("trip-title").textContent = `Trip to ${trip.name}`;
            tripMarker = L.marker([trip.lat, trip.lng], { icon: L.divIcon({className: 'geofence-marker', html: '🏁'}) }).addTo(map);

            const isMember = trip.members.some(m => m.id === socket.id);
            const isHost = trip.hostId === socket.id;
            const actionBtn = $("trip-action-btn");
            
            if (actionBtn) {
                if (isHost) { actionBtn.textContent = "End Trip"; actionBtn.style.color = "#ef4444"; actionBtn.style.background = "rgba(239, 68, 68, 0.2)"; actionBtn.onclick = () => socket.emit("leaveTrip"); }
                else if (isMember) { actionBtn.textContent = "Leave Trip"; actionBtn.style.color = "#f59e0b"; actionBtn.style.background = "rgba(245, 158, 11, 0.2)"; actionBtn.onclick = () => socket.emit("leaveTrip"); }
                else { actionBtn.textContent = "Join Trip"; actionBtn.style.color = "#10b981"; actionBtn.style.background = "rgba(16, 185, 129, 0.2)"; actionBtn.onclick = () => socket.emit("joinTrip"); }
            }
            triggerGroupRouteUpdate(); 
        } else {
            tripRoutesLayer.clearLayers(); tripRoadStats = {};
            if($("trip-panel")) $("trip-panel").style.display = "none";
        }
    });
}

let groupRouteUpdateTimer = null;
let isFetchingGroupRoutes = false;

function triggerGroupRouteUpdate() {
    clearTimeout(groupRouteUpdateTimer);
    groupRouteUpdateTimer = setTimeout(() => updateGroupTripRoutes(), 1000);
}

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
                const routes = await getRoadRoute(coords, currentTrip, false);
                if (routes && routes.length > 0) {
                    const r = routes[0];
                    const pathCoords = r.geometry.coordinates.map(c => [c[1], c[0]]);
                    tripRoutesLayer.eachLayer(l => { if(l.memberId === member.id) tripRoutesLayer.removeLayer(l); });
                    const poly = L.polyline(pathCoords, { color: color, weight: 5, opacity: 0.8, className: 'nav-path-animated' });
                    poly.memberId = member.id; poly.addTo(tripRoutesLayer);
                    tripLastFetchedCoords[member.id] = { lat: coords.lat, lng: coords.lng };
                    tripRoadStats[member.id] = { dist: (r.distance / 1000).toFixed(1), time: Math.round(r.duration / 60) };
                }
            } catch(e) {}
        }
    });

    await Promise.all(promises);
    isFetchingGroupRoutes = false; updateTripPanel();
}

function updateTripPanel() {
    if(!currentTrip) return;
    const list = $("trip-members-list"); if(!list) return;
    list.innerHTML = "";
    
    const isMember = currentTrip.members.some(m => m.id === socket.id);

    if(myCoords && currentUser.name && isMember) {
        const stats = tripRoadStats[socket.id] || { dist: distanceKm(myCoords.lat, myCoords.lng, currentTrip.lat, currentTrip.lng).toFixed(1), time: '--' };
        list.innerHTML += `<div class="trip-member"><div><img src="${escapeHTML(currentUser.avatar)}"> You</div> <span style="text-align:right;">${stats.dist} km<br><small style="color:var(--muted)">${stats.time} min</small></span></div>`;
    }
    Object.values(friendData).filter(f => f.online !== false && currentTrip.members.some(m => m.id === f.id)).forEach(f => {
        const stats = tripRoadStats[f.id] || { dist: distanceKm(f.lat, f.lng, currentTrip.lat, currentTrip.lng).toFixed(1), time: '--' };
        list.innerHTML += `<div class="trip-member"><div><img src="${escapeHTML(f.avatar)}"> ${escapeHTML(f.name)}</div> <span style="text-align:right;">${stats.dist} km<br><small style="color:var(--muted)">${stats.time} min</small></span></div>`;
    });
}

// ==========================================
// SEARCH BAR & CHAT & MEMORY SETUP
// ==========================================
let searchTimeout = null;
function setupLocationSearch() {
    $("search-input").addEventListener("input", (e) => {
        const val = e.target.value;
        $("search-clear-btn").style.display = val ? "block" : "none";
        clearTimeout(searchTimeout);
        if(!val.trim()) { $("search-results").style.display = "none"; return; }
        
        searchTimeout = setTimeout(async () => {
            try {
                const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(val)}&limit=5`);
                const data = await res.json();
                $("search-results").innerHTML = "";
                if(data.features.length === 0) {
                    $("search-results").innerHTML = `<div style="padding:12px; color:var(--muted); font-size:12px;">No results found</div>`;
                } else {
                    data.features.forEach(f => {
                        const item = f.properties;
                        const name = item.name || item.street || item.city || "Location";
                        const addr = [item.street, item.city, item.state, item.country].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(', ');
                        
                        const div = document.createElement("div");
                        div.className = "search-item";
                        div.innerHTML = `<strong>${escapeHTML(name)}</strong><span>${escapeHTML(addr)}</span>`;
                        div.onclick = () => {
                            $("search-results").style.display = "none";
                            $("search-input").value = name;
                            const lat = f.geometry.coordinates[1], lng = f.geometry.coordinates[0];
                            showLocationSheet(lat, lng, name, addr);
                        };
                        $("search-results").appendChild(div);
                    });
                }
                $("search-results").style.display = "block";
            } catch(e) {}
        }, 500);
    });

    $("search-clear-btn").onclick = () => {
        $("search-input").value = ""; $("search-clear-btn").style.display = "none"; $("search-results").style.display = "none";
        if(searchPlace) map.removeLayer(searchPlace);
        $("location-bottom-sheet").style.transform = "translateY(120%)";
        Navigation.stop();
    };
}

function showLocationSheet(lat, lng, name, address) {
    map.flyTo([lat, lng], 16);
    if(searchPlace) map.removeLayer(searchPlace);
    searchPlace = L.marker([lat, lng], {icon: L.divIcon({className:'geofence-marker', html:'📍'})}).addTo(map);
    
    $("sheet-title").textContent = name;
    $("sheet-address").textContent = address;
    $("location-bottom-sheet").style.transform = "translateY(0)";
    
    $("search-direction-btn").onclick = () => { $("location-bottom-sheet").style.transform = "translateY(120%)"; Navigation.previewCustom(lat, lng, name); };
    $("search-start-btn").onclick = () => { $("location-bottom-sheet").style.transform = "translateY(120%)"; Navigation.start(lat, lng, name); };
}

function setupBasicControls(){
    $("my-location-btn").onclick = () => { if(myCoords) map.flyTo([myCoords.lat,myCoords.lng], 16); };
    $("compass-btn").onclick = () => { map.setView(map.getCenter(), map.getZoom(), {animate:true}); };
    $("map-style-btn").onclick = (e) => { e.stopPropagation(); $("map-style-menu").style.display = $("map-style-menu").style.display==="flex"?"none":"flex"; };
    $("map-style-menu").onclick = (e) => {
        const b=e.target.closest("[data-style]"); if(!b) return; const s=b.dataset.style;
        [satelliteLayer,streetLayer,darkLayer].forEach(l=>map.removeLayer(l));
        ({satellite:satelliteLayer,street:streetLayer,dark:darkLayer})[s].addTo(map);
        document.querySelectorAll("#map-style-menu button").forEach(x=>x.classList.toggle("active",x.dataset.style===s));
        $("map-style-menu").style.display="none";
    };
}

function setupChat(){
    const cc=$("chat-container"), inp=$("chatInput"), send=$("chat-send"), vb=$("voiceButton");
    let unread=0, typingTimer=null, replyTo=null, reactingId=null;
    const msgStore=new Map(), emojis=["👍","❤️","😂","😮","😢","🔥"];

    function updateUnreadBadge(){ const b=$("chat-unread-badge"); if(!b) return; b.textContent=unread>99?"99+":unread; b.style.display=unread>0?"flex":"none"; }

    $("chat-toggle-btn").onclick = () => { cc.style.display = "flex"; $("chat-toggle-btn").style.display = "none"; unread=0; updateUnreadBadge(); inp.focus(); };
    $("chat-minimize-btn").onclick = () => { cc.style.display = "none"; $("chat-toggle-btn").style.display = "flex"; };
    $("online-btn").onclick = (e) => { e.stopPropagation(); const l=$("friends-panel"); l.style.display = l.style.display === "flex" ? "none" : "flex"; updateOnlineUI(); };

    inp.oninput=()=>{ socket.emit("typing",true); clearTimeout(typingTimer); typingTimer=setTimeout(()=>socket.emit("typing",false), 1200); send.style.display=inp.value.trim()?"flex":"none"; vb.style.display=inp.value.trim()?"none":"flex"; };
    socket.on("typing", d=>{ const t=$("typing-indicator"); if(d.id!==socket.id && d.isTyping){t.textContent=`${escapeHTML(d.name)} is typing…`; t.style.display="block";}else t.style.display="none"; });

    $("reply-cancel").onclick=()=>{replyTo=null; $("reply-bar").style.display="none";};
    $("emojiButton").onclick=(e)=>{e.stopPropagation(); $("attachment-menu").style.display="none"; $("emoji-picker-container").style.display=$("emoji-picker-container").style.display==="block"?"none":"block";};
    $("emojiPicker").addEventListener("emoji-click",e=>{ const em=e.detail.unicode; if(reactingId){socket.emit("messageReaction",{messageId:reactingId,emoji:em});$("emoji-picker-container").style.display="none";reactingId=null;}else{inp.value+=em;inp.focus();send.style.display="flex";vb.style.display="none";} });
    
    $("chat-attach-btn").onclick=(e)=>{e.stopPropagation(); $("emoji-picker-container").style.display="none"; $("attachment-menu").style.display=$("attachment-menu").style.display==="flex"?"none":"flex";};
    const fInp=$("chatFileInput");
    $("att-media").onclick=()=>{fInp.accept="image/*,video/*";fInp.click();$("attachment-menu").style.display="none";};
    $("att-doc").onclick=()=>{fInp.accept=".pdf,.doc,.txt,.zip";fInp.click();$("attachment-menu").style.display="none";};
    $("att-audio").onclick=()=>{fInp.accept="audio/*";fInp.click();$("attachment-menu").style.display="none";};
    fInp.onchange=()=>{ const f=fInp.files?.[0]; if(!f) return; const r=new FileReader(); r.onload=()=>{ socket.emit("chatMessage",{name:currentUser.name, type:f.type.split('/')[0]==="image"?"image":f.type.split('/')[0]==="video"?"video":f.type.split('/')[0]==="audio"?"audio":"document", data:r.result, replyTo}); $("reply-cancel").click();}; r.readAsDataURL(f); fInp.value="";};

    $("chatForm").onsubmit=e=>{ e.preventDefault(); const t=inp.value.trim(); if(t){socket.emit("chatMessage",{name:currentUser.name,type:"text",data:t,replyTo}); inp.value=""; $("reply-cancel").click(); send.style.display="none"; vb.style.display="flex"; inp.focus();} };

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
        const rep=document.createElement("button"); rep.className="action-btn"; rep.textContent="↩ Reply"; rep.onclick=()=>{replyTo={id:m.id,name:m.name,type:m.type,preview:m.type==="text"?m.data.slice(0,50):"Attachment"}; $("reply-preview").textContent=`↩ ${m.name}`; $("reply-bar").style.display="flex"; inp.focus();}; a.appendChild(rep);
        b.appendChild(a); const rr=document.createElement("div"); rr.className="reaction-row"; b.appendChild(rr); w.appendChild(b); $("chat-messages").appendChild(w);
        
        msgStore.set(m.id,{msg:m,el:w});
        if(m.senderId!==socket.id && cc.style.display!=="flex"){unread++; updateUnreadBadge();}
        $("chat-messages").scrollTop=$("chat-messages").scrollHeight;
    }

    socket.on("chatHistory", l=>l.forEach(renderMsg)); socket.on("chatMessage", renderMsg);
    socket.on("messageReaction", d=>{ const s=msgStore.get(d.messageId); if(s){ const c=s.el.querySelector(".reaction-row"); c.innerHTML=""; Object.keys(d.reactions).forEach(e=>{ if(d.reactions[e].length){ const b=document.createElement("button"); b.className="reaction-chip"; b.textContent=`${e} ${d.reactions[e].length}`; b.onclick=()=>socket.emit("messageReaction",{messageId:d.messageId,emoji:e}); c.appendChild(b);} }); }});
}

function setupVoice(){
    const vb=$("voiceButton"); if(!vb)return; let rec=null, chunks=[], isRec=false;
    vb.onclick=async()=>{
        if(isRec){rec?.stop();return;} if(!navigator.mediaDevices?.getUserMedia){alert("Mic not supported.");return;}
        try{
            const str=await navigator.mediaDevices.getUserMedia({audio:true}); chunks=[];
            let mt=MediaRecorder.isTypeSupported("audio/webm")?"audio/webm":(MediaRecorder.isTypeSupported("audio/mp4")?"audio/mp4":"");
            rec=mt?new MediaRecorder(str,{mimeType:mt}):new MediaRecorder(str); isRec=true;
            vb.textContent="⏹"; vb.style.background="var(--green)"; vb.style.color="#fff";
            rec.ondataavailable=e=>{if(e.data.size>0)chunks.push(e.data);};
            rec.onstop=()=>{
                isRec=false; vb.style.background="transparent"; vb.style.color="var(--muted)"; vb.textContent="🎙️"; str.getTracks().forEach(t=>t.stop());
                const blob=new Blob(chunks,{type:rec.mimeType||"audio/webm"}); if(blob.size===0)return; if(blob.size>MAX_CHAT_FILE)return alert("Voice too large.");
                const r=new FileReader(); r.onload=()=>socket.emit("chatMessage",{name:currentUser.name,type:"audio",data:String(r.result),replyTo:null}); r.readAsDataURL(blob);
            };
            rec.start();
        }catch{alert("Mic access denied.");}
    };
}

function setupMemories(){
    $("phase3-gallery-btn").onclick = () => { 
        $("phase3-memory-overlay").style.display="block"; 
        $("tools-menu").style.display="none";
        renderMemGallery(); 
    };
    $("phase3-memory-close").onclick = () => $("phase3-memory-overlay").style.display="none";
    $("p3-view-close").onclick = () => $("phase3-photo-viewer").style.display="none";
    
    document.querySelectorAll(".phase3-filter").forEach(b => {
        b.onclick = () => { document.querySelectorAll(".phase3-filter").forEach(x=>x.classList.remove("active")); b.classList.add("active"); currentGalleryFilter=b.dataset.filter; renderMemGallery(); };
    });
    $("phase3-memory-search").oninput = e => { currentGallerySearch=e.target.value.toLowerCase(); renderMemGallery(); };
    $("p3-view-focus").onclick = () => { const m=memories.get(selectedMemoryId); if(m) map.flyTo([m.lat,m.lng],17); $("phase3-photo-viewer").style.display="none"; $("phase3-memory-overlay").style.display="none"; };

    function renderMemGallery(){
        let arr = Array.from(memories.values());
        if(currentGalleryFilter==="today") arr=arr.filter(m=>new Date(m.time)>=new Date().setHours(0,0,0,0));
        else if(currentGalleryFilter==="mine") arr=arr.filter(m=>cleanName(m.name)===currentUser.name);
        if(currentGallerySearch) arr=arr.filter(m=>cleanName(m.name).toLowerCase().includes(currentGallerySearch));
        arr.sort((a,b) => new Date(b.time) - new Date(a.time));

        $("phase3-memory-count").textContent = `${arr.length} memories`;
        const grid=$("phase3-memory-grid"), time=$("phase3-timeline-list"), emp=$("phase3-memory-empty");
        grid.innerHTML=""; time.innerHTML=""; emp.style.display=arr.length?"none":"block";

        arr.forEach(m=>{
            const c=document.createElement("div"); c.className="p3-card";
            c.innerHTML=`<img src="${escapeHTML(m.image)}" loading="lazy"><div class="p3-card-info"><b>${escapeHTML(m.name)}</b><span>${new Date(m.time).toLocaleDateString()}</span></div>`;
            c.onclick=()=>{selectedMemoryId=m.id; $("p3-view-image").src=m.image; $("p3-view-name").textContent=m.name; $("p3-view-date").textContent=new Date(m.time).toLocaleString(); $("phase3-photo-viewer").style.display="flex";}; grid.appendChild(c);
            
            const t=document.createElement("div"); t.className="p3-time-item";
            t.innerHTML=`<div class="p3-time-thumb"><img src="${escapeHTML(m.image)}" loading="lazy"></div><div class="p3-time-info"><b>${escapeHTML(m.name)}</b><span>${new Date(m.time).toLocaleString()}</span></div>`;
            t.onclick=c.onclick; time.appendChild(t);
        });
    }

    function renderPins(){
        memoryLayer.clearLayers();
        memories.forEach(m=>{
            const icon = L.divIcon({ className:"p3-memory-marker", html:`<div style="width:46px;height:46px;border-radius:50%;overflow:hidden;border:2px solid #fff;background:#071018;box-shadow:0 4px 15px rgba(0,0,0,.65)"><img src="${escapeHTML(m.image)}" style="width:100%;height:100%;object-fit:cover;"></div>`, iconSize:[46,46], iconAnchor:[23,23]});
            const marker = L.marker([m.lat,m.lng],{icon}).addTo(memoryLayer);
            marker.bindPopup(`<div class="p3-map-popup"><img src="${escapeHTML(m.image)}"><b>📸 ${escapeHTML(m.name)}</b><button class="p3-open-map-memory">View</button></div>`);
            marker.on("popupopen",e=>{ const b=e.popup.getElement()?.querySelector(".p3-open-map-memory"); if(b) b.onclick=()=>{selectedMemoryId=m.id; $("p3-view-image").src=m.image; $("p3-view-name").textContent=m.name; $("p3-view-date").textContent=new Date(m.time).toLocaleString(); $("phase3-photo-viewer").style.display="flex";}; });
        });
    }

    socket.on("loadMemoryPhotos", l=>{ memories.clear(); l.forEach(m=>memories.set(m.id,m)); renderPins(); });
    socket.on("newMemoryPin", m=>{ memories.set(m.id,m); renderPins(); if($("phase3-memory-overlay").style.display==="block") renderMemGallery(); });

    const mInp=$("memoryPhotoInput");
    $("memoryButton").onclick=()=>{ if(!currentUser.name) return alert("Join map first."); mInp.click(); };
    const addMemBtn = $("p3-add-memory-btn");
    if(addMemBtn) addMemBtn.onclick = () => { $("phase3-memory-overlay").style.display="none"; $("memoryButton").click(); };
    
    mInp.onchange=()=>{
        const f=mInp.files?.[0]; if(!f) return;
        if(!IMAGE_TYPES.includes(f.type)||f.size>MAX_MEMORY_FILE){alert("Invalid image or >8MB."); mInp.value=""; return;}
        const r=new FileReader(); 
        r.onload=()=>{
            if(validImageData(r.result)){ 
                pendingMemoryImage = r.result;
                mapActionMode = 'memory';
                alert("📸 Photo Selected!\n\nTap ANYWHERE on the map to pin it.");
            }
        }; 
        r.readAsDataURL(f); mInp.value="";
    };
}

function setupJoin(){
    if(currentUser.name){ $("join-screen").style.display="none"; $("header-avatar").style.display="block"; $("header-avatar").src=currentUser.avatar; socket.emit("profileReady",currentUser); }
    $("join-form").onsubmit=e=>{ e.preventDefault(); currentUser.name=cleanName($("nameInput").value); localStorage.setItem("koraput_name",currentUser.name);
        const f=$("avatarInput").files?.[0];
        if(f){const r=new FileReader(); r.onload=()=>{currentUser.avatar=r.result; localStorage.setItem("koraput_avatar",r.result); done();}; r.readAsDataURL(f);} else done();
        function done(){$("join-screen").style.display="none"; $("header-avatar").style.display="block"; $("header-avatar").src=currentUser.avatar; socket.emit("profileReady",currentUser); updateOnlineUI();}
    };
}

function initApp(){ 
    setupJoin(); 
    setupBasicControls(); 
    setupAdvancedTools(); 
    setupLocationSearch(); 
    setupChat(); 
    setupVoice();
    setupMemories(); 
    startGPS(); 
}

if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", initApp); else initApp();
