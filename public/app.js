"use strict";

const socket = io({ transports: ["websocket", "polling"] });
const DEFAULT_CENTER = [18.8136, 82.7153];
const DEFAULT_AVATAR = "satyam.png";
const MAX_NAME = 40;

const map = L.map("map", { zoomControl: false, preferCanvas: true, minZoom: 3, maxBounds: [[-90, -180], [90, 180]] }).setView(DEFAULT_CENTER, 13);
const satelliteLayer = L.tileLayer("https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}", { maxZoom: 20, subdomains: ["mt0","mt1","mt2","mt3"] }).addTo(map);

let currentUser = { name: localStorage.getItem("koraput_name") || "", avatar: localStorage.getItem("koraput_avatar") || DEFAULT_AVATAR };
let myCoords = null, myWeather = "", ownMarker = null, cityName = "";
let lastEmittedCoords = null; // FIX 5: For GPS network throttling
const friendMarkers = Object.create(null);
const friendData = Object.create(null);

const p4LayerGroup = L.layerGroup().addTo(map);
const measureLayer = L.layerGroup().addTo(map); // FIX 3: Isolated Layer for Measurements
const navigationLayer = L.layerGroup().addTo(map);
const searchLayer = L.layerGroup().addTo(map);

let mapActionMode = null; 
let measurePoints = [];
let searchPlace = null;
const $ = id => document.getElementById(id);
const validCoord = (lat,lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat>=-90 && lat<=90 && lng>=-180 && lng<=180;

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

function showToast(message, duration = 4000) {
    const container = $("toast-container"); if(!container) return;
    const toast = document.createElement("div"); toast.className = "toast"; toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, duration);
}

// ==========================================
// FIX 1 & 2: CENTRALIZED OSRM ROUTING ENGINE
// ==========================================
async function getRoadRoute(from, to, alternatives = false) {
    const alt = alternatives ? "true" : "false";
    const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?steps=true&geometries=geojson&overview=full&alternatives=${alt}`);
    if (!res.ok) throw new Error("Routing server error");
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes.length) throw new Error("No viable road route found");
    return data.routes;
}

// ==========================================
// FIX 3: MAP TOOLS CLEANUP & MEASURE ALTERNATIVES
// ==========================================
$("main-tools-btn").onclick = () => {
    const menu = $("tools-menu");
    menu.style.display = menu.style.display === "flex" ? "none" : "flex";
};

$("measure-btn").onclick = () => {
    mapActionMode = mapActionMode === 'measure' ? null : 'measure';
    document.querySelectorAll('.tool-option').forEach(b => b.classList.remove('active-tool'));
    if(mapActionMode) {
        $("measure-btn").classList.add("active-tool");
        measureLayer.clearLayers(); measurePoints = [];
        showToast("📍 Tap 2 points to measure road routes");
    }
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
                // Get routes with alternatives = true
                const routes = await getRoadRoute(p1, p2, true);
                measureLayer.clearLayers();
                
                // Draw alternative route first (grey)
                if(routes.length > 1) {
                    const altCoords = routes[1].geometry.coordinates.map(c => [c[1], c[0]]);
                    L.polyline(altCoords, {color: '#8d9ba2', weight: 4, opacity: 0.6}).addTo(measureLayer);
                }
                
                // Draw main route (blue/orange)
                const mainCoords = routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
                L.polyline(mainCoords, {color: '#f59e0b', weight: 5, className: 'nav-path-animated'}).addTo(measureLayer);
                
                const d1 = (routes[0].distance / 1000).toFixed(1);
                const t1 = Math.round(routes[0].duration / 60);
                
                if (routes.length > 1) {
                    const d2 = (routes[1].distance / 1000).toFixed(1);
                    const t2 = Math.round(routes[1].duration / 60);
                    showToast(`🏎️ Fastest: ${d1}km (${t1}m) | 📏 Alt: ${d2}km (${t2}m)`, 6000);
                } else {
                    showToast(`📏 Route: ${d1} km • ⏱️ ${t1} mins`, 5000);
                }
                
                map.fitBounds(L.polyline(mainCoords).getBounds(), { padding: [50, 50] });

            } catch(error) {
                // Removed straight-line fallback. Explicit error as requested.
                measureLayer.clearLayers();
                showToast("❌ Road route unavailable. Try again.", 4000);
            }
            
            setTimeout(() => { measureLayer.clearLayers(); measurePoints = []; mapActionMode = null; $("measure-btn").classList.remove("active-tool"); }, 6000);
        }
    }
});


// ==========================================
// FIX 4: TRUE LIVE NAVIGATION UI
// ==========================================
const Navigation = {
    active: false, targetCoords: null, targetName: '', 
    lastRecalcTime: 0,
    
    async start(targetLat, targetLng, name) {
        if(!myCoords) return showToast("Waiting for GPS...");
        this.active = true; 
        this.targetCoords = { lat: targetLat, lng: targetLng }; 
        this.targetName = name;
        
        $("location-bottom-sheet").style.transform = "translateY(120%)";
        if($("profile-popup")) $("profile-popup").style.display = "none";
        
        $("nav-target-name").textContent = name;
        $("nav-panel").style.display = "flex";
        await this.calculate();
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
            
            // Draw active navigation line
            L.polyline(coords, { color: '#3b82f6', weight: 6, opacity: 0.9, className: 'nav-path-animated' }).addTo(navigationLayer);
            
            // Update Stats Pills
            $("nav-dist").textContent = `${(r.distance / 1000).toFixed(1)} km`;
            const mins = Math.round(r.duration / 60);
            $("nav-time").textContent = mins > 60 ? `${Math.floor(mins/60)}h ${mins%60}m` : `${mins} min`;
            
            // Turn-by-Turn logic (Gets immediate next step)
            if(r.legs[0] && r.legs[0].steps && r.legs[0].steps.length > 1) {
                const step = r.legs[0].steps[1]; // Index 1 is usually the first meaningful turn
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
        
        // Auto-recalculate if user moves off-route or every 20 seconds
        const timeSinceRecalc = Date.now() - this.lastRecalcTime;
        if(timeSinceRecalc > 20000) {
            this.calculate();
        } else {
            // Light pan to keep user centered
            map.panTo([myCoords.lat, myCoords.lng], {animate: true});
        }
    }
};

$("nav-exit-btn").onclick = () => Navigation.stop();


// ==========================================
// FIX 5: GPS NETWORK THROTTLING
// ==========================================
function startGPS() {
    if(!navigator.geolocation) return;
    navigator.geolocation.watchPosition(async p => {
        const lat = Number(p.coords.latitude), lng = Number(p.coords.longitude);
        if(!validCoord(lat,lng)) return;
        
        myCoords = {lat, lng};

        if(!ownMarker){
            ownMarker = L.marker([lat,lng],{icon:ownIcon(), zIndexOffset:1000}).addTo(map);
            map.setView([lat,lng], 16);
        } else {
            ownMarker.setLatLng([lat,lng]);
        }

        // Only emit to server if moved > 10 meters (0.01 km) to prevent spam
        const movedEnough = !lastEmittedCoords || distanceKm(lastEmittedCoords.lat, lastEmittedCoords.lng, lat, lng) > 0.01;
        
        if (movedEnough) {
            socket.emit("updateLocation", {name: currentUser.name, avatar: currentUser.avatar, lat, lng, weather: myWeather});
            lastEmittedCoords = {lat, lng};
            updateFriendBadges(); 
        }

        // Live Navigation Updates
        Navigation.onLiveUpdate(); 

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

// ==========================================
// FIX 6: NEW FRIENDS PANEL
// ==========================================
function updateOnlineUI(){
    const list = $("friends-list"); if(!list) return;
    list.innerHTML = "";
    
    Object.values(friendData).filter(f => f.online !== false).forEach(u => {
        const dist = myCoords && validCoord(u.lat, u.lng) ? `${distanceKm(myCoords.lat, myCoords.lng, u.lat, u.lng).toFixed(1)} km away` : 'Location unknown';
        const item = document.createElement("div");
        item.className = "friend-list-item";
        item.innerHTML = `
            <img src="${escapeHTML(u.avatar)}">
            <div class="friend-info-col">
                <span class="friend-list-name">${escapeHTML(u.name)}</span>
                <span class="friend-list-dist">${dist}</span>
            </div>
            <div class="status-dot-small"></div>
        `;
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
    
    if($("profile-nav-btn")) {
        $("profile-nav-btn").onclick = () => {
            if(validCoord(u.lat, u.lng)) Navigation.start(u.lat, u.lng, u.name);
        };
    }
    
    if($("profile-popup")) $("profile-popup").style.display="flex";
    if($("profile-focus-btn")) $("profile-focus-btn").onclick=()=>{ map.flyTo([u.lat,u.lng],16); $("profile-popup").style.display="none"; };
}

$("profile-popup-close")?.addEventListener("click",()=>$("profile-popup").style.display="none");

// ==========================================
// CORE SOCKET LOGIC
// ==========================================
socket.on("connect", () => { if (currentUser.name) socket.emit("profileReady", currentUser); });

socket.on("onlineUsers", list=>{ if(Array.isArray(list)) list.forEach(u=>{ if(u.id!==socket.id){ friendData[u.id]={...(friendData[u.id]||{}),...u,online:true}; createOrUpdateFriendMarker(u);} }); updateOnlineUI(); });
socket.on("userOnline", u=>{ if(u.id!==socket.id){ friendData[u.id]={...(friendData[u.id]||{}),...u,online:true}; createOrUpdateFriendMarker(u); } updateOnlineUI(); });
socket.on("userOffline", d=>{ if(d?.id && friendData[d.id]){ friendData[d.id].online=false; if(friendMarkers[d.id]) friendMarkers[d.id].setOpacity(0.45); } updateOnlineUI(); });
socket.on("friendMoved", u=>{ if(u?.id) { createOrUpdateFriendMarker({...u,online:true}); updateOnlineUI(); }});
socket.on("friendDisconnected", id=>{ if(friendMarkers[id]){map.removeLayer(friendMarkers[id]); delete friendMarkers[id];} delete friendData[id]; updateOnlineUI(); });

function createOrUpdateFriendMarker(u){
    if(!u?.id || !validCoord(u.lat,u.lng)) return;
    friendData[u.id] = { id:u.id, name:u.name||"Friend", avatar:u.avatar||DEFAULT_AVATAR, lat:u.lat, lng:u.lng, weather:u.weather||"", online:u.online!==false };
    let m = friendMarkers[u.id];
    if(!m){ m=L.marker([u.lat,u.lng],{icon:friendIcon(u.avatar)}).addTo(map); m.on("click",()=>showProfilePopup(u)); friendMarkers[u.id]=m; }
    else { m.setLatLng([u.lat,u.lng]); m.setOpacity(u.online===false?0.45:1); }
    updateFriendBadges();
}

function setupJoin(){
    // FIX 1: emitLocation is fully removed from here
    if(currentUser.name){ $("join-screen").style.display="none"; $("header-avatar").style.display="block"; $("header-avatar").src=currentUser.avatar; socket.emit("profileReady",currentUser); }
    $("join-form").onsubmit=e=>{ e.preventDefault(); currentUser.name=cleanName($("nameInput").value); localStorage.setItem("koraput_name",currentUser.name);
        const f=$("avatarInput").files?.[0];
        if(f){const r=new FileReader(); r.onload=()=>{currentUser.avatar=r.result; localStorage.setItem("koraput_avatar",r.result); done();}; r.readAsDataURL(f);} else done();
        function done(){$("join-screen").style.display="none"; $("header-avatar").style.display="block"; $("header-avatar").src=currentUser.avatar; socket.emit("profileReady",currentUser); updateOnlineUI();}
    };
}

// SEARCH BAR LOGIC
let searchTimeout = null;
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
                    div.innerHTML = `<strong>${name}</strong><span>${addr}</span>`;
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

function showLocationSheet(lat, lng, name, address) {
    map.flyTo([lat, lng], 16);
    if(searchPlace) map.removeLayer(searchPlace);
    searchPlace = L.marker([lat, lng], {icon: L.divIcon({className:'geofence-marker', html:'📍'})}).addTo(map);
    
    $("sheet-title").textContent = name;
    $("sheet-address").textContent = address;
    $("location-bottom-sheet").style.transform = "translateY(0)";
    
    $("search-direction-btn").onclick = () => { $("location-bottom-sheet").style.transform = "translateY(120%)"; Navigation.start(lat, lng, name); };
    $("search-start-btn").onclick = () => { $("location-bottom-sheet").style.transform = "translateY(120%)"; Navigation.start(lat, lng, name); };
}

function initApp(){ setupJoin(); startGPS(); }
if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", initApp); else initApp();
