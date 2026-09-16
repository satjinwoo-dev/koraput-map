"use strict";

const socket = io({ transports: ["websocket", "polling"] });
const DEFAULT_CENTER = [18.8136, 82.7153];
const DEFAULT_AVATAR = "satyam.png";
const MAX_NAME = 40;
const MAX_CHAT_FILE = 5 * 1024 * 1024;
const MAX_MEMORY_FILE = 8 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

// Prevent infinite map scrolling/repeating worlds
const map = L.map("map", { 
    zoomControl: false, 
    preferCanvas: true,
    minZoom: 3,
    maxBounds: [[-90, -180], [90, 180]],
    maxBoundsViscosity: 1.0
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

let locationHistory = [];
try {
    const stored = localStorage.getItem("koraput_history");
    if (stored) locationHistory = JSON.parse(stored);
    if (!Array.isArray(locationHistory)) locationHistory = [];
} catch(e) { locationHistory = []; }

const p4LayerGroup = L.layerGroup().addTo(map);
const historyPolyline = L.polyline(locationHistory, { color: '#3b82f6', weight: 4, opacity: 0.8, dashArray: '5, 10' }).addTo(p4LayerGroup);

let mapActionMode = null; 
let pendingMemoryImage = null; 
let measurePoints = [];
let currentTrip = null;
let tripMarker = null;

const memories = new Map();
const memoryLayer = L.layerGroup().addTo(map);
let currentGalleryFilter = "all", currentGallerySearch = "", selectedMemoryId = null;

const $ = id => document.getElementById(id);
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
        iconSize: [38, 38], 
        iconAnchor: [19, 19] 
    }); 
}

function friendIcon(avatar) { 
    return L.divIcon({ 
        className: "custom-friend-icon", 
        html: `<div style="width:100%; height:100%; border-radius:50%; border:2px solid #60a5fa; overflow:hidden; background:#071018; box-sizing:border-box;"><img src="${escapeHTML(avatar)}" style="width:100%; height:100%; object-fit:cover; display:block;"></div>`,
        iconSize: [36, 36], 
        iconAnchor: [18, 18] 
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
        if (r.ok) {
            const d = await r.json();
            const c = d.city || d.locality || d.principalSubdivision;
            if (c) return c;
        }
    } catch (e) {}
    try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=10`);
        if (r.ok) {
            const d = await r.json();
            return d.address?.city || d.address?.town || d.address?.county || "Rourkela";
        }
    } catch { return "Rourkela"; }
}

socket.on("connect", () => { if (currentUser.name) socket.emit("profileReady", currentUser); });

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

// FIXED GPS: RESTORED FETCHCITY & FETCHWEATHER CALLS
function startGPS() {
    if(!navigator.geolocation) return;
    navigator.geolocation.watchPosition(async p=>{
        const lat=Number(p.coords.latitude), lng=Number(p.coords.longitude), acc=Number(p.coords.accuracy);
        if(!validCoord(lat,lng)) return;
        myCoords={lat,lng};

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

        if(acc>0 && acc<100000){
            if(!accuracyCircle) accuracyCircle=L.circle([lat,lng],{radius:acc, color:"#10b981", weight:2, fillOpacity:.15}).addTo(map);
            else {accuracyCircle.setLatLng([lat,lng]); accuracyCircle.setRadius(acc);}
        }

        // 1. Fetch and update city
        if (!cityName) {
            cityName = await fetchCity(lat, lng);
            if (cityName) {
                if ($("header-app-title")) $("header-app-title").textContent = `${cityName} Map`;
                if ($("pill-city")) $("pill-city").textContent = `📍 ${cityName}`;
            }
        }

        // 2. Fetch and update weather
        if (!myWeather || Date.now() - lastWeatherFetch > 180000) {
            const w = await fetchWeather(lat, lng);
            if (w) {
                myWeather = w;
                lastWeatherFetch = Date.now();
                if ($("map-temp-display")) $("map-temp-display").textContent = w;
                if (ownMarker) {
                    ownMarker.unbindTooltip().bindTooltip(w, { permanent: true, direction: "right", className: "weather-badge", offset: [15, 0] });
                }
            }
        }
        
        socket.emit("updateLocation",{name:currentUser.name, avatar:currentUser.avatar, lat, lng, weather:myWeather});
        updateFriendBadges(); updateTripPanel();
    }, e=>console.warn("GPS error",e), {enableHighAccuracy:true,timeout:15000,maximumAge:3000});
}

function updateFriendBadges(){
    Object.keys(friendMarkers).forEach(id=>{
        const f=friendData[id], m=friendMarkers[id]; if(!f||!m) return;
        let text = f.online===false ? "Offline" : f.weather;
        if(myCoords && validCoord(f.lat,f.lng)) text += ` | 📍 ${distanceKm(myCoords.lat,myCoords.lng,f.lat,f.lng)} km`;
        m.unbindTooltip(); if(text) m.bindTooltip(text,{permanent:true,direction:"right",className:"weather-badge",offset:[15,0]});
    });
}

socket.on("onlineUsers", list=>{ if(Array.isArray(list)) list.forEach(u=>{ if(u.id!==socket.id){ friendData[u.id]={...(friendData[u.id]||{}),...u,online:true}; createOrUpdateFriendMarker(u);} }); updateOnlineUI(); });
socket.on("userOnline", u=>{ if(u.id!==socket.id){ friendData[u.id]={...(friendData[u.id]||{}),...u,online:true}; createOrUpdateFriendMarker(u); } updateOnlineUI(); });
socket.on("userOffline", d=>{ if(d?.id && friendData[d.id]){ friendData[d.id].online=false; if(friendMarkers[d.id]) friendMarkers[d.id].setOpacity(0.45); } updateOnlineUI(); });
socket.on("friendMoved", u=>{ if(u?.id) createOrUpdateFriendMarker({...u,online:true}); updateOnlineUI(); updateTripPanel();});
socket.on("friendDisconnected", id=>{ if(friendMarkers[id]){map.removeLayer(friendMarkers[id]); delete friendMarkers[id];} delete friendData[id]; updateOnlineUI(); updateTripPanel();});

function createOrUpdateFriendMarker(u){
    if(!u?.id || !validCoord(u.lat,u.lng)) return;
    friendData[u.id] = { id:u.id, name:u.name||"Friend", avatar:u.avatar||DEFAULT_AVATAR, lat:u.lat, lng:u.lng, weather:u.weather||"", online:u.online!==false };
    let m = friendMarkers[u.id];
    if(!m){ m=L.marker([u.lat,u.lng],{icon:friendIcon(u.avatar)}).addTo(map); m.on("click",()=>showProfilePopup(u)); friendMarkers[u.id]=m; }
    else { m.setLatLng([u.lat,u.lng]); m.setOpacity(u.online===false?0.45:1); }
    updateFriendBadges();
}

function updateOnlineUI(){
    let c=0; Object.values(friendData).forEach(f=>{if(f.online!==false) c++;});
    if($("header-online-status")) $("header-online-status").textContent = `${currentUser.name ? c+1 : c} online`;
    if($("chat-subtitle")) $("chat-subtitle").textContent = `${currentUser.name ? c+1 : c} online`;
    const box=$("online-list"); if(!box) return; box.innerHTML="";
    Object.values(friendData).filter(f=>f.online!==false).forEach(u=>{
        const btn=document.createElement("button"); btn.className="online-friend";
        btn.innerHTML=`<img src="${escapeHTML(u.avatar)}"><span><b>${escapeHTML(u.name)}</b></span><div class="status-dot"></div>`;
        btn.onclick=()=>{ map.flyTo([u.lat,u.lng],16); showProfilePopup(u); }; box.appendChild(btn);
    });
}

function showProfilePopup(u) {
    if($("profile-popup-avatar")) $("profile-popup-avatar").src=u.avatar; 
    if($("profile-popup-name")) $("profile-popup-name").textContent=u.name;
    const st = $("profile-popup-status");
    if(st) { st.textContent = u.online!==false ? "● Online" : "● Offline"; st.style.color = u.online!==false ? "#18d6a3" : "#8fa1aa"; }
    if($("profile-popup-distance")) $("profile-popup-distance").textContent = myCoords ? `${distanceKm(myCoords.lat,myCoords.lng,u.lat,u.lng)} km away` : "--";
    if($("profile-popup-weather")) $("profile-popup-weather").textContent = u.weather || "--";
    if($("profile-popup")) $("profile-popup").style.display="flex";
    if($("profile-focus-btn")) $("profile-focus-btn").onclick=()=>{ map.flyTo([u.lat,u.lng],16); $("profile-popup").style.display="none"; };
}
$("profile-popup-close")?.addEventListener("click",()=>$("profile-popup").style.display="none");

function setupAdvancedTools() {
    $("measure-btn").onclick = () => {
        mapActionMode = mapActionMode === 'measure' ? null : 'measure';
        $("measure-btn").classList.toggle("active-tool", mapActionMode === 'measure');
        $("geofence-btn").classList.remove("active-tool"); $("trip-btn").classList.remove("active-tool");
        if(mapActionMode !== 'measure') { p4LayerGroup.eachLayer(l => { if(!l.options?.isGeofence) map.removeLayer(l); }); measurePoints = []; }
        else showToast("📍 Tap two points on the map to measure distance");
    };

    $("geofence-btn").onclick = () => {
        mapActionMode = mapActionMode === 'geofence' ? null : 'geofence';
        $("geofence-btn").classList.toggle("active-tool", mapActionMode === 'geofence');
        $("measure-btn").classList.remove("active-tool"); $("trip-btn").classList.remove("active-tool");
        if(mapActionMode === 'geofence') showToast("⭕ Tap the map to set a Geofence area");
    };

    $("trip-btn").onclick = () => {
        mapActionMode = mapActionMode === 'trip' ? null : 'trip';
        $("trip-btn").classList.toggle("active-tool", mapActionMode === 'trip');
        $("measure-btn").classList.remove("active-tool"); $("geofence-btn").classList.remove("active-tool");
        if(mapActionMode === 'trip') showToast("🚗 Tap the map to set Group Trip Destination");
    };

    map.on('click', (e) => {
        if (mapActionMode === 'measure') {
            measurePoints.push(e.latlng);
            L.circleMarker(e.latlng, {color: '#f59e0b', radius: 5, fillOpacity: 1}).addTo(p4LayerGroup);
            if (measurePoints.length === 2) {
                L.polyline(measurePoints, {color: '#f59e0b', weight: 4, dashArray: '5, 5'}).addTo(p4LayerGroup);
                const d = distanceKm(measurePoints[0].lat, measurePoints[0].lng, measurePoints[1].lat, measurePoints[1].lng);
                showToast(`📏 Distance: ${d} km`, 5000);
                setTimeout(() => { p4LayerGroup.eachLayer(l => { if(!l.options?.isGeofence) map.removeLayer(l); }); measurePoints = []; mapActionMode = null; $("measure-btn").classList.remove("active-tool"); }, 5000);
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
                } else {
                    showToast("❌ Invalid radius! Must be between 10 and 50000 meters.");
                }
            }
            mapActionMode = null; $("geofence-btn").classList.remove("active-tool");
        }
        else if (mapActionMode === 'trip') {
            const name = prompt("Enter Trip Destination Name:");
            if (name && name.trim()) {
                socket.emit("startTrip", { name: name.trim(), lat: e.latlng.lat, lng: e.latlng.lng });
                showToast(`🚗 Trip started to ${name}!`);
            }
            mapActionMode = null; $("trip-btn").classList.remove("active-tool");
        }
        else if (mapActionMode === 'memory') {
            if (pendingMemoryImage) {
                socket.emit("uploadMemoryPhoto", { name: currentUser.name, lat: e.latlng.lat, lng: e.latlng.lng, image: pendingMemoryImage });
                showToast("✅ Memory pinned successfully!");
            }
            mapActionMode = null; pendingMemoryImage = null;
        }
    });

    socket.on("loadGeofences", fences => {
        map.eachLayer(l => { if(l.options?.isGeofence) map.removeLayer(l); });
        fences.forEach(f => {
            L.circle([f.lat, f.lng], { radius: f.radius, color: "#8b5cf6", weight: 2, fillOpacity: 0.1, isGeofence: true }).addTo(map);
            L.marker([f.lat, f.lng], { icon: L.divIcon({className: 'geofence-marker', html: '📍'}), isGeofence: true }).bindTooltip(f.name, {permanent: true, direction: "top", className: "weather-badge"}).addTo(map);
        });
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
                if (isHost) {
                    actionBtn.textContent = "End Trip";
                    actionBtn.style.color = "#ef4444"; actionBtn.style.background = "rgba(239, 68, 68, 0.2)";
                    actionBtn.onclick = () => socket.emit("leaveTrip");
                } else if (isMember) {
                    actionBtn.textContent = "Leave Trip";
                    actionBtn.style.color = "#f59e0b"; actionBtn.style.background = "rgba(245, 158, 11, 0.2)";
                    actionBtn.onclick = () => socket.emit("leaveTrip");
                } else {
                    actionBtn.textContent = "Join Trip";
                    actionBtn.style.color = "#10b981"; actionBtn.style.background = "rgba(16, 185, 129, 0.2)";
                    actionBtn.onclick = () => socket.emit("joinTrip");
                }
            }
            updateTripPanel();
        } else {
            if($("trip-panel")) $("trip-panel").style.display = "none";
        }
    });
}

function updateTripPanel() {
    if(!currentTrip) return;
    const list = $("trip-members-list"); if(!list) return;
    list.innerHTML = "";
    
    const isMember = currentTrip.members.some(m => m.id === socket.id);

    if(myCoords && currentUser.name && isMember) {
        const d = distanceKm(myCoords.lat, myCoords.lng, currentTrip.lat, currentTrip.lng);
        list.innerHTML += `<div class="trip-member"><div><img src="${escapeHTML(currentUser.avatar)}"> You</div> <span>${d} km</span></div>`;
    }
    
    Object.values(friendData).filter(f => f.online !== false && currentTrip.members.some(m => m.id === f.id)).forEach(f => {
        const d = distanceKm(f.lat, f.lng, currentTrip.lat, currentTrip.lng);
        list.innerHTML += `<div class="trip-member"><div><img src="${escapeHTML(f.avatar)}"> ${escapeHTML(f.name)}</div> <span>${d} km</span></div>`;
    });
}

function setupBasicControls(){
    $("my-location-btn").onclick = () => { if(myCoords) map.flyTo([myCoords.lat,myCoords.lng], 16); };
    $("compass-btn").onclick = () => { map.setView(map.getCenter(), map.getZoom(), {animate:true}); $("compass-icon").style.transform="rotate(0deg)"; };
    $("map-style-btn").onclick = (e) => { e.stopPropagation(); $("map-style-menu").style.display = $("map-style-menu").style.display==="flex"?"none":"flex"; };
    $("map-style-menu").onclick = (e) => {
        const b=e.target.closest("[data-style]"); if(!b) return; const s=b.dataset.style;
        [satelliteLayer,streetLayer,darkLayer].forEach(l=>map.removeLayer(l));
        ({satellite:satelliteLayer,street:streetLayer,dark:darkLayer})[s].addTo(map);
        document.querySelectorAll("#map-style-menu button").forEach(x=>x.classList.toggle("active",x.dataset.style===s));
        $("map-style-menu").style.display="none";
    };
    if (window.DeviceOrientationEvent) window.addEventListener("deviceorientation", e => { const icon = $("compass-icon"); if (icon) icon.style.transform = `rotate(${e.webkitCompassHeading ? -e.webkitCompassHeading : e.alpha}deg)`; }, true);
}

function setupChat(){
    const cc=$("chat-container"), inp=$("chatInput"), send=$("chat-send"), vb=$("voiceButton");
    let unread=0, typingTimer=null, replyTo=null, reactingId=null;
    const msgStore=new Map(), emojis=["👍","❤️","😂","😮","😢","🔥"];

    function updateUnreadBadge(){ const b=$("chat-unread-badge"); if(!b) return; b.textContent=unread>99?"99+":unread; b.style.display=unread>0?"flex":"none"; }

    $("chat-toggle-btn").onclick = () => { cc.style.display = "flex"; $("chat-toggle-btn").style.display = "none"; unread=0; updateUnreadBadge(); inp.focus(); };
    $("chat-minimize-btn").onclick = () => { cc.style.display = "none"; $("chat-toggle-btn").style.display = "flex"; };
    $("online-btn").onclick = (e) => { e.stopPropagation(); const l=$("online-list"); l.style.display = l.style.display === "block" ? "none" : "block"; updateOnlineUI(); };
    document.addEventListener("click", e => { if ($("online-list") && !$("online-list").contains(e.target) && e.target !== $("online-btn")) $("online-list").style.display = "none"; });

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
    $("phase3-gallery-btn").onclick = () => { $("phase3-memory-overlay").style.display="block"; renderMemGallery(); };
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
        function done(){$("join-screen").style.display="none"; $("header-avatar").style.display="block"; $("header-avatar").src=currentUser.avatar; socket.emit("profileReady",currentUser); emitLocation(); updateOnlineUI();}
    };
}

function initApp(){ setupJoin(); setupBasicControls(); setupAdvancedTools(); setupChat(); setupMemories(); startGPS(); }
if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", initApp); else initApp();
