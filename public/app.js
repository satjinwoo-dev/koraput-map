"use strict";

// ==========================================
// 1. GLOBAL CONFIG & STATE
// ==========================================
const socket = io({ transports: ["websocket", "polling"] });
const DEFAULT_CENTER = [18.8136, 82.7153];
const DEFAULT_AVATAR = "satyam.png";
const MAX_NAME = 40;
const MAX_CHAT_FILE = 5 * 1024 * 1024;
const MAX_MEMORY_FILE = 8 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

let currentUser = { name: localStorage.getItem("koraput_name") || "", avatar: localStorage.getItem("koraput_avatar") || DEFAULT_AVATAR };
let myCoords = null, myWeather = "", ownMarker = null, accuracyCircle = null, cityName = "";
let lastEmittedCoords = null; 
let lastWeatherFetch = 0;
let lastHistorySave = 0; 

const friendMarkers = Object.create(null);
const friendData = Object.create(null);

let locationHistory = [];
let recentSearches = []; // NEW: For Google Maps style recent searches
try {
    const stored = localStorage.getItem("koraput_history");
    if (stored) locationHistory = JSON.parse(stored);
    if (!Array.isArray(locationHistory)) locationHistory = [];

    const storedSearches = localStorage.getItem("koraput_recent_searches");
    if (storedSearches) recentSearches = JSON.parse(storedSearches);
    if (!Array.isArray(recentSearches)) recentSearches = [];
} catch(e) { locationHistory = []; recentSearches = []; }

// Map State
let mapActionMode = null; 
let measurePoints = [];
let currentTrip = null;
let tripMarker = null;
let searchPlace = null;
let pendingMemoryImage = null; 
let currentGeofences = []; 
const memories = new Map();
let currentGalleryFilter = "all", currentGallerySearch = "", selectedMemoryId = null;

// ==========================================
// 2. MAP INITIALIZATION & LAYERS
// ==========================================
const map = L.map("map", { 
    zoomControl: false, preferCanvas: true, minZoom: 3, maxBounds: [[-90, -180], [90, 180]], maxBoundsViscosity: 1.0
}).setView(DEFAULT_CENTER, 13);

const satelliteLayer = L.tileLayer("https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}", { maxZoom: 20, subdomains: ["mt0","mt1","mt2","mt3"] });
const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 });
const darkLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 20 });
satelliteLayer.addTo(map);

// Isolated Layer Groups for better cleanup
const p4LayerGroup = L.layerGroup().addTo(map); 
const measureLayer = L.layerGroup().addTo(map); 
const navigationLayer = L.layerGroup().addTo(map); 
const tripRoutesLayer = L.layerGroup().addTo(map); 
const memoryLayer = L.layerGroup().addTo(map); 
const searchLayer = L.layerGroup().addTo(map); 

const historyPolyline = L.polyline(locationHistory, { color: '#3b82f6', weight: 4, opacity: 0.8, dashArray: '5, 10' }).addTo(p4LayerGroup);

// ==========================================
// 3. UTILITY FUNCTIONS
// ==========================================
const $ = id => document.getElementById(id);
const cleanName = v => String(v || "User").trim().replace(/\s+/g," ").slice(0, MAX_NAME);
const validCoord = (lat,lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat>=-90 && lat<=90 && lng>=-180 && lng<=180;
const validImageData = v => typeof v === "string" && v.startsWith("data:image/");

function distanceKm(a,b,c,d){
    if(!validCoord(a,b) || !validCoord(c,d)) return 0;
    const p = Math.PI/180, a1 = 0.5 - Math.cos((c-a)*p)/2 + Math.cos(a*p)*Math.cos(c*p)*Math.sin((d-b)*p/2)**2;
    return (12742 * Math.asin(Math.sqrt(a1)));
}

function formatDistance(distKm) {
    if(distKm < 1) return `${Math.round(distKm * 1000)} m`;
    return `${distKm.toFixed(1)} km`;
}

function escapeHTML(v) { return String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;"); }

function ownIcon() { 
    return L.divIcon({ className: "custom-own-icon", html: `<div style="width:100%; height:100%; border-radius:50%; border:2.5px solid #18d6a3; overflow:hidden; background:#071018; box-sizing:border-box; box-shadow:0 0 10px rgba(24,214,163,0.5);"><img src="${escapeHTML(currentUser.avatar)}" style="width:100%; height:100%; object-fit:cover; display:block;"></div>`, iconSize: [38, 38], iconAnchor: [19, 19] }); 
}

function friendIcon(avatar) { 
    return L.divIcon({ className: "custom-friend-icon", html: `<div style="width:100%; height:100%; border-radius:50%; border:2px solid #3b82f6; overflow:hidden; background:#071018; box-sizing:border-box;"><img src="${escapeHTML(avatar)}" style="width:100%; height:100%; object-fit:cover; display:block;"></div>`, iconSize: [36, 36], iconAnchor: [18, 18] }); 
}

function weatherEmoji(code){
    if(code===0) return "☀️"; if([1,2,3].includes(code)) return "⛅"; if([45,48].includes(code)) return "🌫️";
    if([51,53,55,56,57,61,63,65,66,67].includes(code)) return "🌧️"; if([71,73,75,77,85,86].includes(code)) return "❄️";
    if([80,81,82].includes(code)) return "🌦️"; if([95,96,99].includes(code)) return "⛈️"; return "🌤️";
}

function showToast(message, duration = 4000) {
    const container = $("toast-container"); if(!container) return;
    const toast = document.createElement("div"); toast.className = "toast"; toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, duration);
}

// ==========================================
// 4. EXTERNAL APIs (Weather, City, OSRM)
// ==========================================
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
        if (r.ok) { const d = await r.json(); return d.address?.city || d.address?.town || d.address?.county || ""; }
    } catch { return ""; }
    return "";
}

async function getRoadRoute(from, to, alternatives = false) {
    const alt = alternatives ? "true" : "false";
    const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?steps=true&geometries=geojson&overview=full&alternatives=${alt}`);
    if (!res.ok) throw new Error("Routing server error");
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes.length) throw new Error("No viable road route found");
    return data.routes;
}

// ==========================================
// 5. NAVIGATION ENGINES (1-on-1 & Group)
// ==========================================
const Navigation = {
    active: false, targetCoords: null, targetName: '', lastCalcCoords: null, lastRecalcTime: 0,
    
    async start(targetLat, targetLng, name) {
        if(!myCoords) return showToast("Waiting for GPS...");
        this.active = true; this.targetCoords = { lat: targetLat, lng: targetLng }; this.targetName = name;
        this.lastCalcCoords = null;
        
        if($("location-bottom-sheet")) $("location-bottom-sheet").style.transform = "translateY(120%)";
        if($("profile-popup")) $("profile-popup").style.display = "none";
        
        if($("nav-target-name")) $("nav-target-name").textContent = name;
        if($("nav-panel")) $("nav-panel").style.display = "flex";
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
            const distKm = (r.distance / 1000);
            const timeMin = Math.round(r.duration / 60);
            showToast(`🚗 Path to ${name}: ${formatDistance(distKm)} • ⏱️ ${timeMin} mins`, 5000);
        } catch (e) { showToast("Failed to preview route."); }
    },

    async calculate() {
        if(!this.active || !myCoords || !this.targetCoords) return;
        if(Date.now() - this.lastRecalcTime < 2000) return; // Anti-spam

        navigationLayer.clearLayers();
        if($("nav-inst-text")) $("nav-inst-text").textContent = "Analyzing best route...";
        if($("nav-inst-arrow")) $("nav-inst-arrow").textContent = "↻";
        if($("nav-instruction-sub")) $("nav-instruction-sub").textContent = "";

        try {
            const routes = await getRoadRoute(myCoords, this.targetCoords, false);
            const r = routes[0];
            const coords = r.geometry.coordinates.map(c => [c[1], c[0]]); 
            
            L.polyline(coords, { color: '#3b82f6', weight: 6, opacity: 0.9, className: 'nav-path-animated' }).addTo(navigationLayer);
            
            if($("nav-dist")) $("nav-dist").textContent = formatDistance(r.distance / 1000);
            const mins = Math.round(r.duration / 60);
            if($("nav-time")) $("nav-time").textContent = mins > 60 ? `${Math.floor(mins/60)}h ${mins%60}m` : `${mins} min`;
            
            if(r.legs[0] && r.legs[0].steps && r.legs[0].steps.length > 0) {
                const step = r.legs[0].steps.length > 1 ? r.legs[0].steps[1] : r.legs[0].steps[0]; 
                let arrow = "↑";
                if(step.maneuver.modifier) { 
                    if(step.maneuver.modifier.includes('right')) arrow = "↱"; 
                    if(step.maneuver.modifier.includes('left')) arrow = "↰"; 
                    if(step.maneuver.modifier.includes('uturn')) arrow = "↶"; 
                }
                if($("nav-inst-arrow")) $("nav-inst-arrow").textContent = arrow;
                if($("nav-inst-text")) $("nav-inst-text").textContent = step.maneuver.instruction || step.name || "Continue straight";
                if($("nav-instruction-sub")) $("nav-instruction-sub").textContent = `In ${Math.round(step.distance)} meters`;
            } else {
                if($("nav-inst-arrow")) $("nav-inst-arrow").textContent = "🏁";
                if($("nav-inst-text")) $("nav-inst-text").textContent = "Arriving at destination";
            }
            
            this.lastCalcCoords = { lat: myCoords.lat, lng: myCoords.lng };
            this.lastRecalcTime = Date.now();
            map.panTo([myCoords.lat, myCoords.lng], {animate: true});
        } catch (e) { 
            if($("nav-inst-text")) $("nav-inst-text").textContent = "Navigation error. Re-routing...";
        }
    },
    
    stop() {
        this.active = false; this.targetCoords = null; this.lastCalcCoords = null;
        navigationLayer.clearLayers();
        if($("nav-panel")) $("nav-panel").style.display = "none";
        if(myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16);
    },

    onLiveUpdate() {
        if(!this.active || !myCoords || !this.targetCoords) return;
        let needsRecalc = false;

        if(this.targetId !== "custom" && friendData[this.targetId]) {
            const f = friendData[this.targetId];
            if(distanceKm(this.targetCoords.lat, this.targetCoords.lng, f.lat, f.lng) > 0.05) {
                this.targetCoords = { lat: f.lat, lng: f.lng }; needsRecalc = true;
            }
        }
        if(!this.lastCalcCoords || distanceKm(myCoords.lat, myCoords.lng, this.lastCalcCoords.lat, this.lastCalcCoords.lng) > 0.03) {
            needsRecalc = true;
        }

        if(needsRecalc) this.calculate();
        else map.panTo([myCoords.lat, myCoords.lng], {animate: true});
    }
};

if($("nav-exit-btn")) $("nav-exit-btn").onclick = () => Navigation.stop();
if($("nav-recalc-btn")) $("nav-recalc-btn").onclick = () => Navigation.calculate();

// --- Group Navigation Logic ---
const GroupNavigation = {
    active: false, destination: null, selectedMembers: [], layerGroup: L.layerGroup().addTo(map),
    lastFetchedCoords: {}, colors: ['#18d6a3', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6'], recalcTimer: null,

    openSetup() {
        const list = $("group-nav-friend-list"); if(!list) return;
        list.innerHTML = "";
        const activeFriends = Object.values(friendData).filter(f => f.online !== false);
        if(activeFriends.length === 0) {
            list.innerHTML = `<div style="color:var(--muted); font-size:11px;">No friends online.</div>`;
        } else {
            activeFriends.forEach(f => {
                list.innerHTML += `<label style="display:flex; align-items:center; gap:8px; font-size:13px; color:white; cursor:pointer;"><input type="checkbox" value="${f.id}" class="group-nav-cb"><img src="${escapeHTML(f.avatar)}" style="width:28px; height:28px; border-radius:50%; object-fit:cover;">${escapeHTML(f.name)}</label>`;
            });
        }
        if($("group-nav-setup")) $("group-nav-setup").style.display = "flex";
    },
    startSelection() {
        const cbs = document.querySelectorAll(".group-nav-cb:checked");
        if(cbs.length === 0) return showToast("Select at least 1 friend.");
        if(cbs.length > 3) return showToast("Select up to 3 friends only.");
        this.selectedMembers = ["me", ...Array.from(cbs).map(cb => cb.value)];
        if($("group-nav-setup")) $("group-nav-setup").style.display = "none";
        mapActionMode = 'group-nav';
        showToast("📍 Tap the map to set the common destination!", 5000);
    },
    async setDestination(latlng) {
        this.active = true; this.destination = latlng; this.layerGroup.clearLayers(); this.lastFetchedCoords = {};
        L.marker(latlng, { icon: L.divIcon({className: 'geofence-marker', html: '🎯'}) }).bindTooltip("Group Destination", {permanent:true, direction:"top", className:"weather-badge"}).addTo(this.layerGroup);
        if($("group-nav-active")) $("group-nav-active").style.display = "flex";
        await this.calculateAll();
    },
    async calculateAll() {
        if(!this.active || !this.destination) return;
        if($("group-nav-stats-list")) $("group-nav-stats-list").innerHTML = "<div style='color:var(--muted); font-size:11px; text-align:center;'>Calculating road paths...</div>";

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
                } else {
                    statsHTML += `<div style="color:#ef4444; font-size:11px; padding:10px;">No road route for ${escapeHTML(name)}</div>`;
                }
            } catch(e) {}
        }
        if($("group-nav-stats-list")) $("group-nav-stats-list").innerHTML = statsHTML;
        if(validPaths.length > 0) map.fitBounds(L.featureGroup(validPaths).getBounds(), { padding: [40, 40] });
    },
    onLiveUpdate() {
        if(!this.active || !this.destination) return;
        let needsRecalc = false;
        if (this.selectedMembers.includes("me") && myCoords) { const last = this.lastFetchedCoords["me"]; if(!last || distanceKm(last.lat, last.lng, myCoords.lat, myCoords.lng) > 0.1) needsRecalc = true; }
        this.selectedMembers.forEach(id => { if(id !== "me" && friendData[id]) { const f = friendData[id]; const last = this.lastFetchedCoords[id]; if(validCoord(f.lat, f.lng) && (!last || distanceKm(last.lat, last.lng, f.lat, f.lng) > 0.1)) needsRecalc = true; }});
        if (needsRecalc) { clearTimeout(this.recalcTimer); this.recalcTimer = setTimeout(() => this.calculateAll(), 3000); }
    },
    stop() { 
        this.active = false; this.destination = null; this.selectedMembers = []; this.layerGroup.clearLayers(); 
        if($("group-nav-active")) $("group-nav-active").style.display = "none"; 
        if(myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16); 
    }
};

if($("group-nav-close-btn")) $("group-nav-close-btn").onclick = () => { if($("group-nav-setup")) $("group-nav-setup").style.display = "none"; mapActionMode = null; clearActiveTools(); };
if($("group-nav-next-btn")) $("group-nav-next-btn").onclick = () => GroupNavigation.startSelection();
if($("group-nav-stop-btn")) $("group-nav-stop-btn").onclick = () => GroupNavigation.stop();


// ==========================================
// 6. GOOGLE MAPS STYLE LOCATION SEARCH
// ==========================================
let searchTimeout = null;
let searchController = null;

function saveRecentSearch(place) {
    recentSearches = recentSearches.filter(p => p.name !== place.name);
    recentSearches.unshift(place);
    if(recentSearches.length > 5) recentSearches.pop();
    localStorage.setItem("koraput_recent_searches", JSON.stringify(recentSearches));
}

function renderSearchResults(dataArr, isRecent = false) {
    const results = $("location-search-results");
    if(!results) return;
    results.innerHTML = "";

    if(!dataArr || dataArr.length === 0) {
        results.innerHTML = `<div style="padding:14px; color:var(--muted); font-size:12px; text-align:center;">No matching place found.</div>`;
        results.style.display = "block";
        return;
    }

    dataArr.forEach(item => {
        // Google maps UI: Icon on left, info middle, distance bottom of icon
        const icon = isRecent ? '🕒' : '📍';
        const name = item.name;
        const addr = item.address;
        const lat = Number(item.lat);
        const lng = Number(item.lng); // Handle both .lon and .lng depending on source

        let distStr = "";
        if(myCoords && validCoord(lat, lng)) {
            distStr = formatDistance(distanceKm(myCoords.lat, myCoords.lng, lat, lng));
        }

        const div = document.createElement("div");
        div.className = "search-item";
        div.style.cssText = "display:flex; align-items:center; gap:14px; padding:12px 14px; cursor:pointer;";
        
        div.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; min-width:40px;">
                <div style="font-size:18px; color:#8d9ba2;">${icon}</div>
                ${distStr ? `<div style="font-size:9px; color:var(--green-bright); margin-top:4px; font-weight:bold;">${distStr}</div>` : ''}
            </div>
            <div style="flex:1; min-width:0; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:8px;">
                <strong style="display:block; color:#fff; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHTML(name)}</strong>
                <span style="display:block; color:var(--muted); font-size:11px; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHTML(addr)}</span>
            </div>
        `;

        div.onclick = () => {
            results.style.display = "none";
            $("location-search-input").value = name;
            if(!isRecent) saveRecentSearch({name, address: addr, lat, lng});
            showLocationSheet(lat, lng, name, addr);
        };
        results.appendChild(div);
    });

    results.style.display = "block";
}

function setupLocationSearch() {
    const input = $("location-search-input");
    const clearBtn = $("location-search-clear");
    const results = $("location-search-results");

    if (!input) return;

    // Show recent searches on focus if empty
    input.addEventListener("focus", () => {
        if(!input.value.trim() && recentSearches.length > 0) {
            if (clearBtn) clearBtn.style.display = "block";
            renderSearchResults(recentSearches, true);
        }
    });

    input.addEventListener("input", (e) => {
        const val = e.target.value.trim();

        if (clearBtn) clearBtn.style.display = val ? "block" : "none";
        clearTimeout(searchTimeout);

        if (!val) {
            if(recentSearches.length > 0) renderSearchResults(recentSearches, true);
            else if (results) results.style.display = "none";
            if (searchController) searchController.abort();
            return;
        }

        searchTimeout = setTimeout(() => searchPlaces(val), 450);
    });

    async function searchPlaces(query) {
        if (!results) return;
        if (searchController) searchController.abort();
        searchController = new AbortController();

        try {
            const center = map.getCenter();
            const bounds = map.getBounds();
            const viewbox = [bounds.getWest(), bounds.getNorth(), bounds.getEast(), bounds.getSouth()].join(",");

            let searchQuery = query;
            if (cityName) searchQuery = `${query}, ${cityName}, Odisha, India`;
            else searchQuery = `${query}, Rourkela, Odisha, India`;

            const apiUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(searchQuery)}&limit=10&countrycodes=in&addressdetails=1&viewbox=${encodeURIComponent(viewbox)}&dedupe=1`;

            const res = await fetch(apiUrl, { signal: searchController.signal, headers: { "Accept-Language": "en" } });
            if (!res.ok) throw new Error("Search failed");
            const data = await res.json();

            const words = query.toLowerCase().split(/\s+/).filter(Boolean);

            data.forEach(item => {
                const name = String(item.name || "").toLowerCase();
                const display = String(item.display_name || "").toLowerCase();
                const city = String(item.address?.city || item.address?.town || item.address?.municipality || item.address?.county || "").toLowerCase();

                let score = 0;
                if (name === query.toLowerCase()) score += 200;
                if (words.every(w => name.includes(w))) score += 150;
                words.forEach(word => { if (name.includes(word)) score += 50; else if (display.includes(word)) score += 15; });
                if (city.includes("rourkela")) score += 100;
                if (display.includes("rourkela")) score += 60;
                if (display.includes("odisha")) score += 20;

                const lat = Number(item.lat), lon = Number(item.lon);
                if (validCoord(lat, lon)) {
                    const distance = distanceKm(center.lat, center.lng, lat, lon);
                    score += Math.max(0, 50 - Math.min(distance, 50));
                }
                item._searchScore = score;
            });

            data.sort((a, b) => b._searchScore - a._searchScore);

            const filtered = data.filter(item => {
                const name = String(item.name || "").toLowerCase();
                const display = String(item.display_name || "").toLowerCase();
                return words.some(word => name.includes(word) || display.includes(word));
            });

            const unique = [];
            const seen = new Set();
            filtered.forEach(item => {
                const key = `${String(item.name || "").toLowerCase()}|${Number(item.lat).toFixed(5)}|${Number(item.lon).toFixed(5)}`;
                if (!seen.has(key)) { seen.add(key); unique.push(item); }
            });

            // Format for render
            const formattedResults = unique.slice(0, 6).map(item => {
                const parts = String(item.display_name || "").split(",");
                return {
                    name: item.name || parts[0] || "Unknown place",
                    address: parts.slice(1, 4).join(",").trim(),
                    lat: item.lat,
                    lng: item.lon
                };
            });

            renderSearchResults(formattedResults, false);

        } catch (e) {
            if (e.name === "AbortError") return;
            results.innerHTML = `<div style="padding:12px; color:var(--muted); font-size:12px; text-align:center;">Search temporarily unavailable.</div>`;
            results.style.display = "block";
        }
    }

    if (clearBtn) {
        clearBtn.onclick = () => {
            input.value = "";
            clearBtn.style.display = "none";
            if (results) { results.innerHTML = ""; results.style.display = "none"; }
            if (searchController) searchController.abort();
            if (searchPlace) { map.removeLayer(searchPlace); searchPlace = null; }
            if ($("location-bottom-sheet")) $("location-bottom-sheet").style.transform = "translateY(120%)";
            Navigation.stop();
        };
    }
}

function showLocationSheet(lat, lng, name, address) {
    map.flyTo([lat, lng], 16);
    if(searchPlace) map.removeLayer(searchPlace);
    searchPlace = L.marker([lat, lng], {icon: L.divIcon({className:'geofence-marker', html:'📍'})}).addTo(map);
    
    if($("sheet-title")) $("sheet-title").textContent = name;
    if($("sheet-address")) $("sheet-address").textContent = address;
    if($("location-bottom-sheet")) $("location-bottom-sheet").style.transform = "translateY(0)";
    
    // PREVIEW DIRECTIONS (Static Path)
    if($("search-direction-btn")) $("search-direction-btn").onclick = () => { 
        if($("location-bottom-sheet")) $("location-bottom-sheet").style.transform = "translateY(120%)"; 
        Navigation.previewCustom(lat, lng, name); 
    };
    
    // START NAVIGATION (Live Turn-by-turn)
    if($("search-start-btn")) $("search-start-btn").onclick = () => { 
        if($("location-bottom-sheet")) $("location-bottom-sheet").style.transform = "translateY(120%)"; 
        Navigation.start(lat, lng, name); 
    };
}


// ==========================================
// 7. CORE GPS & SOCKET LOGIC
// ==========================================
socket.on("connect", () => { if (currentUser.name) socket.emit("profileReady", currentUser); });

socket.on("geofenceAlert", (data) => {
    const action = data.type === "enter" ? "entered" : "left";
    showToast(`🔔 ${data.user} has ${action} ${data.fence}!`);
});

function startGPS() {
    if(!navigator.geolocation) return;
    navigator.geolocation.watchPosition(async p => {
        const lat = Number(p.coords.latitude), lng = Number(p.coords.longitude), acc = Number(p.coords.accuracy);
        if(!validCoord(lat,lng)) return;
        
        myCoords = {lat, lng};
        locationHistory.push([lat, lng]);
        if(locationHistory.length > 1000) locationHistory.shift(); 
        historyPolyline.setLatLngs(locationHistory);
        
        if (Date.now() - lastHistorySave > 30000) {
            localStorage.setItem("koraput_history", JSON.stringify(locationHistory));
            lastHistorySave = Date.now();
        }

        if(!ownMarker){
            ownMarker = L.marker([lat,lng],{icon:ownIcon(), zIndexOffset:1000}).addTo(map);
            map.setView([lat,lng], 16);
        } else {
            ownMarker.setLatLng([lat,lng]);
        }

        if(acc>0 && acc<100000){
            if(!accuracyCircle) accuracyCircle=L.circle([lat,lng],{radius:acc, color:"#10b981", weight:2, fillOpacity:.15}).addTo(map);
            else {accuracyCircle.setLatLng([lat,lng]); accuracyCircle.setRadius(acc);}
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

// ==========================================
// 8. FRIENDS & SOCIAL SYSTEM
// ==========================================
function updateFriendBadges(){
    Object.keys(friendMarkers).forEach(id=>{
        const f=friendData[id], m=friendMarkers[id]; if(!f||!m) return;
        let text = f.online===false ? "Offline" : f.weather;
        if(myCoords && validCoord(f.lat,f.lng)) text += ` | 📍 ${formatDistance(distanceKm(myCoords.lat,myCoords.lng,f.lat,f.lng))}`;
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
        const dist = myCoords && validCoord(u.lat, u.lng) ? formatDistance(distanceKm(myCoords.lat, myCoords.lng, u.lat, u.lng)) : 'Location unknown';
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
    const dist = myCoords && validCoord(u.lat, u.lng) ? formatDistance(distanceKm(myCoords.lat, myCoords.lng, u.lat, u.lng)) : '--';
    if($("profile-popup-distance")) $("profile-popup-distance").textContent = dist;
    
    if($("profile-nav-btn")) $("profile-nav-btn").onclick = () => { if(validCoord(u.lat, u.lng)) Navigation.start(u.lat, u.lng, u.name); };
    
    if($("profile-popup")) $("profile-popup").style.display="flex";
    if($("profile-focus-btn")) $("profile-focus-btn").onclick=()=>{ map.flyTo([u.lat,u.lng],16); $("profile-popup").style.display="none"; };
}
$("profile-popup-close")?.addEventListener("click",()=> { if($("profile-popup")) $("profile-popup").style.display="none"; });


// ==========================================
// 9. MAP TOOLS & GEOFENCING
// ==========================================
window.removeGeofence = (id) => { socket.emit("removeGeofence", id); };

function renderGeofenceList() {
    const list = $("geofence-items"); if(!list) return;
    list.innerHTML = "";
    if(currentGeofences.length === 0) { list.innerHTML = "<div style='color:var(--muted); font-size:12px; text-align:center;'>No active geofences.</div>"; } 
    else {
        currentGeofences.forEach(f => {
            const isOwner = f.ownerId === socket.id;
            const actionBtn = isOwner ? `<button onclick="removeGeofence('${f.id}')" style="background:rgba(239, 68, 68, 0.2); color:#ef4444; border:none; padding:6px 12px; border-radius:8px; font-weight:bold; font-size:11px; cursor:pointer;">Remove</button>` : `<span style="font-size:10px; color:var(--muted); font-weight:bold;">Owner: ${escapeHTML(f.ownerName)}</span>`;
            list.innerHTML += `<div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); padding:10px; border-radius:10px;"><div><div style="color:white; font-size:13px; font-weight:bold;">${escapeHTML(f.name)}</div><div style="color:var(--muted); font-size:11px;">Radius: ${f.radius}m</div></div>${actionBtn}</div>`;
        });
    }
    if($("geofence-list-modal")) $("geofence-list-modal").style.display = "flex";
}
if($("geofence-list-close")) $("geofence-list-close").onclick = () => { if($("geofence-list-modal")) $("geofence-list-modal").style.display = "none"; };

function clearActiveTools() { document.querySelectorAll('.tool-option').forEach(b => b.classList.remove('active-tool')); }

function setupAdvancedTools() {
    if($("main-tools-btn")) $("main-tools-btn").onclick = () => {
        const menu = $("tools-menu");
        if(menu) menu.style.display = menu.style.display === "flex" ? "none" : "flex";
    };

    if($("measure-btn")) $("measure-btn").onclick = () => {
        mapActionMode = mapActionMode === 'measure' ? null : 'measure';
        clearActiveTools();
        if(mapActionMode) { $("measure-btn").classList.add("active-tool"); measureLayer.clearLayers(); measurePoints = []; showToast("📍 Tap 2 points to measure road routes"); }
        if($("tools-menu")) $("tools-menu").style.display = "none";
    };

    let geoClickCount = 0, geoClickTimer = null;
    if($("geofence-btn")) $("geofence-btn").onclick = () => {
        geoClickCount++;
        if (geoClickCount === 3) { clearTimeout(geoClickTimer); geoClickCount = 0; renderGeofenceList(); if($("tools-menu")) $("tools-menu").style.display = "none"; return; }
        clearTimeout(geoClickTimer);
        geoClickTimer = setTimeout(() => {
            geoClickCount = 0; mapActionMode = mapActionMode === 'geofence' ? null : 'geofence';
            clearActiveTools();
            if(mapActionMode) { $("geofence-btn").classList.add("active-tool"); showToast("⭕ Tap map to set Geofence. (Tap button 3 times to delete)"); }
            if($("tools-menu")) $("tools-menu").style.display = "none";
        }, 300);
    };

    if($("trip-btn")) $("trip-btn").onclick = () => {
        mapActionMode = mapActionMode === 'trip' ? null : 'trip';
        clearActiveTools();
        if(mapActionMode) { $("trip-btn").classList.add("active-tool"); showToast("🚗 Tap the map to set Group Trip Destination"); }
        if($("tools-menu")) $("tools-menu").style.display = "none";
    };

    if($("group-nav-btn")) $("group-nav-btn").onclick = () => {
        mapActionMode = mapActionMode === 'group-nav' ? null : 'group-nav';
        clearActiveTools();
        if(mapActionMode) { $("group-nav-btn").classList.add("active-tool"); GroupNavigation.openSetup(); }
        else { if($("group-nav-setup")) $("group-nav-setup").style.display = "none"; }
        if($("tools-menu")) $("tools-menu").style.display = "none";
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
                    
                    let fastest = routes[0], shortest = routes[0];
                    routes.forEach(r => {
                        if(r.duration < fastest.duration) fastest = r;
                        if(r.distance < shortest.distance) shortest = r;
                    });

                    if(fastest !== shortest && routes.length > 1) {
                        const shortCoords = shortest.geometry.coordinates.map(c => [c[1], c[0]]);
                        L.polyline(shortCoords, {color: '#8d9ba2', weight: 4, opacity: 0.8}).addTo(measureLayer);
                    }

                    const mainCoords = fastest.geometry.coordinates.map(c => [c[1], c[0]]);
                    L.polyline(mainCoords, {color: '#f59e0b', weight: 5, className: 'nav-path-animated'}).addTo(measureLayer);
                    
                    const d1 = formatDistance(fastest.distance / 1000); 
                    const t1 = Math.round(fastest.duration / 60);
                    if (fastest !== shortest) {
                        const d2 = formatDistance(shortest.distance / 1000); 
                        const t2 = Math.round(shortest.duration / 60);
                        showToast(`🏎️ Fastest: ${d1} (${t1}m) | 📏 Shortest: ${d2} (${t2}m)`, 6000);
                    } else { showToast(`📏 Route: ${d1} • ⏱️ ${t1} mins`, 5000); }
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
        if($("geofence-list-modal") && $("geofence-list-modal").style.display === "flex") renderGeofenceList();
    });

    socket.on("tripData", trip => {
        currentTrip = trip;
        if(tripMarker) { map.removeLayer(tripMarker); tripMarker = null; }
        if(trip) {
            if($("trip-panel")) $("trip-panel").style.display = "flex";
            if($("trip-title")) $("trip-title").textContent = `Trip to ${trip.name}`;
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
        const stats = tripRoadStats[socket.id] || { dist: formatDistance(distanceKm(myCoords.lat, myCoords.lng, currentTrip.lat, currentTrip.lng)), time: '--' };
        list.innerHTML += `<div class="trip-member"><div><img src="${escapeHTML(currentUser.avatar)}"> You</div> <span style="text-align:right;">${stats.dist}<br><small style="color:var(--muted)">${stats.time} min</small></span></div>`;
    }
    Object.values(friendData).filter(f => f.online !== false && currentTrip.members.some(m => m.id === f.id)).forEach(f => {
        const stats = tripRoadStats[f.id] || { dist: formatDistance(distanceKm(f.lat, f.lng, currentTrip.lat, currentTrip.lng)), time: '--' };
        list.innerHTML += `<div class="trip-member"><div><img src="${escapeHTML(f.avatar)}"> ${escapeHTML(f.name)}</div> <span style="text-align:right;">${stats.dist}<br><small style="color:var(--muted)">${stats.time} min</small></span></div>`;
    });
}

// ==========================================
// 10. CHAT, VOICE & MEMORIES
// ==========================================
function setupBasicControls(){
    if($("my-location-btn")) $("my-location-btn").onclick = () => { if(myCoords) map.flyTo([myCoords.lat,myCoords.lng], 16); };
    if($("compass-btn")) $("compass-btn").onclick = () => { map.setView(map.getCenter(), map.getZoom(), {animate:true}); };
    if($("map-style-btn")) $("map-style-btn").onclick = (e) => { e.stopPropagation(); if($("map-style-menu")) $("map-style-menu").style.display = $("map-style-menu").style.display==="flex"?"none":"flex"; };
    if($("map-style-menu")) $("map-style-menu").onclick = (e) => {
        const b=e.target.closest("[data-style]"); if(!b) return; const s=b.dataset.style;
        [satelliteLayer,streetLayer,darkLayer].forEach(l=>map.removeLayer(l));
        ({satellite:satelliteLayer,street:streetLayer,dark:darkLayer})[s].addTo(map);
        document.querySelectorAll("#map-style-menu button").forEach(x=>x.classList.toggle("active",x.dataset.style===s));
        $("map-style-menu").style.display="none";
    };
}

function setupChat(){
    const cc=$("chat-container"), inp=$("chatInput"), send=$("chat-send"), vb=$("voiceButton");
    if(!cc || !inp || !send) return;

    let unread=0, typingTimer=null, replyTo=null, reactingId=null;
    const msgStore=new Map(), emojis=["👍","❤️","😂","😮","😢","🔥"];

    function updateUnreadBadge(){ const b=$("chat-unread-badge"); if(!b) return; b.textContent=unread>99?"99+":unread; b.style.display=unread>0?"flex":"none"; }

    if($("chat-toggle-btn")) $("chat-toggle-btn").onclick = () => { cc.style.display = "flex"; $("chat-toggle-btn").style.display = "none"; unread=0; updateUnreadBadge(); inp.focus(); };
    if($("chat-minimize-btn")) $("chat-minimize-btn").onclick = () => { cc.style.display = "none"; if($("chat-toggle-btn")) $("chat-toggle-btn").style.display = "flex"; };

    inp.oninput=()=>{ socket.emit("typing",true); clearTimeout(typingTimer); typingTimer=setTimeout(()=>socket.emit("typing",false), 1200); send.style.display=inp.value.trim()?"flex":"none"; if(vb) vb.style.display=inp.value.trim()?"none":"flex"; };
    socket.on("typing", d=>{ const t=$("typing-indicator"); if(t) { if(d.id!==socket.id && d.isTyping){t.textContent=`${escapeHTML(d.name)} is typing…`; t.style.display="block";}else t.style.display="none"; } });

    if($("reply-cancel")) $("reply-cancel").onclick=()=>{replyTo=null; if($("reply-bar")) $("reply-bar").style.display="none";};
    if($("emojiButton")) $("emojiButton").onclick=(e)=>{e.stopPropagation(); if($("attachment-menu")) $("attachment-menu").style.display="none"; if($("emoji-picker-container")) $("emoji-picker-container").style.display=$("emoji-picker-container").style.display==="block"?"none":"block";};
    if($("emojiPicker")) $("emojiPicker").addEventListener("emoji-click",e=>{ const em=e.detail.unicode; if(reactingId){socket.emit("messageReaction",{messageId:reactingId,emoji:em});if($("emoji-picker-container")) $("emoji-picker-container").style.display="none";reactingId=null;}else{inp.value+=em;inp.focus();send.style.display="flex";if(vb) vb.style.display="none";} });
    
    if($("chat-attach-btn")) $("chat-attach-btn").onclick=(e)=>{e.stopPropagation(); if($("emoji-picker-container")) $("emoji-picker-container").style.display="none"; if($("attachment-menu")) $("attachment-menu").style.display=$("attachment-menu").style.display==="flex"?"none":"flex";};
    const fInp=$("chatFileInput");
    if($("att-media")) $("att-media").onclick=()=>{fInp.accept="image/*,video/*";fInp.click();$("attachment-menu").style.display="none";};
    if($("att-doc")) $("att-doc").onclick=()=>{fInp.accept=".pdf,.doc,.txt,.zip";fInp.click();$("attachment-menu").style.display="none";};
    if($("att-audio")) $("att-audio").onclick=()=>{fInp.accept="audio/*";fInp.click();$("attachment-menu").style.display="none";};
    if(fInp) fInp.onchange=()=>{ const f=fInp.files?.[0]; if(!f) return; const r=new FileReader(); r.onload=()=>{ socket.emit("chatMessage",{name:currentUser.name, type:f.type.split('/')[0]==="image"?"image":f.type.split('/')[0]==="video"?"video":f.type.split('/')[0]==="audio"?"audio":"document", data:r.result, replyTo}); if($("reply-cancel")) $("reply-cancel").click();}; r.readAsDataURL(f); fInp.value="";};

    if($("chatForm")) $("chatForm").onsubmit=e=>{ e.preventDefault(); const t=inp.value.trim(); if(t){socket.emit("chatMessage",{name:currentUser.name,type:"text",data:t,replyTo}); inp.value=""; if($("reply-cancel")) $("reply-cancel").click(); send.style.display="none"; if(vb) vb.style.display="flex"; inp.focus();} };

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
        const rep=document.createElement("button"); rep.className="action-btn"; rep.textContent="↩ Reply"; rep.onclick=()=>{replyTo={id:m.id,name:m.name,type:m.type,preview:m.type==="text"?m.data.slice(0,50):"Attachment"}; if($("reply-preview")) $("reply-preview").textContent=`↩ ${m.name}`; if($("reply-bar")) $("reply-bar").style.display="flex"; inp.focus();}; a.appendChild(rep);
        b.appendChild(a); const rr=document.createElement("div"); rr.className="reaction-row"; b.appendChild(rr); w.appendChild(b); if($("chat-messages")) $("chat-messages").appendChild(w);
        
        msgStore.set(m.id,{msg:m,el:w});
        if(m.senderId!==socket.id && cc.style.display!=="flex"){unread++; updateUnreadBadge();}
        if($("chat-messages")) $("chat-messages").scrollTop=$("chat-messages").scrollHeight;
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
    if($("phase3-gallery-btn")) $("phase3-gallery-btn").onclick = () => { 
        if($("phase3-memory-overlay")) $("phase3-memory-overlay").style.display="block"; 
        if($("tools-menu")) $("tools-menu").style.display="none";
        renderMemGallery(); 
    };
    if($("phase3-memory-close")) $("phase3-memory-close").onclick = () => { if($("phase3-memory-overlay")) $("phase3-memory-overlay").style.display="none"; };
    if($("p3-view-close")) $("p3-view-close").onclick = () => { if($("phase3-photo-viewer")) $("phase3-photo-viewer").style.display="none"; };
    
    document.querySelectorAll(".phase3-filter").forEach(b => {
        b.onclick = () => { document.querySelectorAll(".phase3-filter").forEach(x=>x.classList.remove("active")); b.classList.add("active"); currentGalleryFilter=b.dataset.filter; renderMemGallery(); };
    });
    if($("phase3-memory-search")) $("phase3-memory-search").oninput = e => { currentGallerySearch=e.target.value.toLowerCase(); renderMemGallery(); };
    if($("p3-view-focus")) $("p3-view-focus").onclick = () => { const m=memories.get(selectedMemoryId); if(m) map.flyTo([m.lat,m.lng],17); if($("phase3-photo-viewer")) $("phase3-photo-viewer").style.display="none"; if($("phase3-memory-overlay")) $("phase3-memory-overlay").style.display="none"; };

    function renderMemGallery(){
        let arr = Array.from(memories.values());
        if(currentGalleryFilter==="today") arr=arr.filter(m=>new Date(m.time)>=new Date().setHours(0,0,0,0));
        else if(currentGalleryFilter==="mine") arr=arr.filter(m=>cleanName(m.name)===currentUser.name);
        if(currentGallerySearch) arr=arr.filter(m=>cleanName(m.name).toLowerCase().includes(currentGallerySearch));
        arr.sort((a,b) => new Date(b.time) - new Date(a.time));

        if($("phase3-memory-count")) $("phase3-memory-count").textContent = `${arr.length} memories`;
        const grid=$("phase3-memory-grid"), time=$("phase3-timeline-list"), emp=$("phase3-memory-empty");
        if(grid) grid.innerHTML=""; if(time) time.innerHTML=""; if(emp) emp.style.display=arr.length?"none":"block";

        arr.forEach(m=>{
            const c=document.createElement("div"); c.className="p3-card";
            c.innerHTML=`<img src="${escapeHTML(m.image)}" loading="lazy"><div class="p3-card-info"><b>${escapeHTML(m.name)}</b><span>${new Date(m.time).toLocaleDateString()}</span></div>`;
            c.onclick=()=>{selectedMemoryId=m.id; if($("p3-view-image")) $("p3-view-image").src=m.image; if($("p3-view-name")) $("p3-view-name").textContent=m.name; if($("p3-view-date")) $("p3-view-date").textContent=new Date(m.time).toLocaleString(); if($("phase3-photo-viewer")) $("phase3-photo-viewer").style.display="flex";}; if(grid) grid.appendChild(c);
            
            const t=document.createElement("div"); t.className="p3-time-item";
            t.innerHTML=`<div class="p3-time-thumb"><img src="${escapeHTML(m.image)}" loading="lazy"></div><div class="p3-time-info"><b>${escapeHTML(m.name)}</b><span>${new Date(m.time).toLocaleString()}</span></div>`;
            t.onclick=c.onclick; if(time) time.appendChild(t);
        });
    }

    function renderPins(){
        memoryLayer.clearLayers();
        memories.forEach(m=>{
            const icon = L.divIcon({ className:"p3-memory-marker", html:`<div style="width:46px;height:46px;border-radius:50%;overflow:hidden;border:2px solid #fff;background:#071018;box-shadow:0 4px 15px rgba(0,0,0,.65)"><img src="${escapeHTML(m.image)}" style="width:100%;height:100%;object-fit:cover;"></div>`, iconSize:[46,46], iconAnchor:[23,23]});
            const marker = L.marker([m.lat,m.lng],{icon}).addTo(memoryLayer);
            marker.bindPopup(`<div class="p3-map-popup"><img src="${escapeHTML(m.image)}"><b>📸 ${escapeHTML(m.name)}</b><button class="p3-open-map-memory">View</button></div>`);
            marker.on("popupopen",e=>{ const b=e.popup.getElement()?.querySelector(".p3-open-map-memory"); if(b) b.onclick=()=>{selectedMemoryId=m.id; if($("p3-view-image")) $("p3-view-image").src=m.image; if($("p3-view-name")) $("p3-view-name").textContent=m.name; if($("p3-view-date")) $("p3-view-date").textContent=new Date(m.time).toLocaleString(); if($("phase3-photo-viewer")) $("phase3-photo-viewer").style.display="flex";}; });
        });
    }

    socket.on("loadMemoryPhotos", l=>{ memories.clear(); l.forEach(m=>memories.set(m.id,m)); renderPins(); });
    socket.on("newMemoryPin", m=>{ memories.set(m.id,m); renderPins(); if($("phase3-memory-overlay") && $("phase3-memory-overlay").style.display==="block") renderMemGallery(); });

    const mInp=$("memoryPhotoInput");
    if($("memoryButton")) $("memoryButton").onclick=()=>{ if(!currentUser.name) return alert("Join map first."); if(mInp) mInp.click(); };
    const addMemBtn = $("p3-add-memory-btn");
    if(addMemBtn) addMemBtn.onclick = () => { if($("phase3-memory-overlay")) $("phase3-memory-overlay").style.display="none"; if($("memoryButton")) $("memoryButton").click(); };
    
    if(mInp) mInp.onchange=()=>{
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

// ==========================================
// 11. INITIALIZATION & AUTH
// ==========================================
function setupJoin(){
    if(currentUser.name && $("join-screen")){ 
        $("join-screen").style.display="none"; 
        if($("header-avatar")) { $("header-avatar").style.display="block"; $("header-avatar").src=currentUser.avatar; }
        socket.emit("profileReady",currentUser); 
    }
    
    if($("join-form")) {
        $("join-form").onsubmit=e=>{ 
            e.preventDefault(); 
            currentUser.name=cleanName($("nameInput").value); 
            localStorage.setItem("koraput_name",currentUser.name);
            const f=$("avatarInput").files?.[0];
            if(f){
                const r=new FileReader(); 
                r.onload=()=>{
                    currentUser.avatar=r.result; 
                    localStorage.setItem("koraput_avatar",r.result); 
                    done();
                }; 
                r.readAsDataURL(f);
            } else done();
            
            function done(){
                if($("join-screen")) $("join-screen").style.display="none"; 
                if($("header-avatar")) { $("header-avatar").style.display="block"; $("header-avatar").src=currentUser.avatar; }
                socket.emit("profileReady",currentUser); 
                updateOnlineUI();
            }
        };
    }
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
