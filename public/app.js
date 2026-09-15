"use strict";

const socket = io({ transports: ["websocket", "polling"] });
const DEFAULT_CENTER = [18.8136, 82.7153];
const DEFAULT_AVATAR = "satyam.png";
const MAX_NAME = 40;
const MAX_CHAT_FILE = 5 * 1024 * 1024;
const MAX_MEMORY_FILE = 8 * 1024 * 1024;
const MAX_AVATAR_FILE = 3 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView(DEFAULT_CENTER, 13);
const satelliteLayer = L.tileLayer("https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}", { maxZoom: 20, subdomains: ["mt0","mt1","mt2","mt3"] });
const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 });
const darkLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 20 });
satelliteLayer.addTo(map);

let currentUser = { name: localStorage.getItem("koraput_name") || "", avatar: localStorage.getItem("koraput_avatar") || DEFAULT_AVATAR };
let myCoords = null, myWeather = "", ownMarker = null, accuracyCircle = null, cityName = "";
const friendMarkers = Object.create(null);
const friendData = Object.create(null);

// Phase 4 States
const locationHistory = [];
const historyPolyline = L.polyline([], { color: '#3b82f6', weight: 4, opacity: 0.8, dashArray: '5, 10' }).addTo(map);

let mapActionMode = null; // 'measure', 'geofence', 'trip'
let measurePoints = [];
const p4LayerGroup = L.layerGroup().addTo(map);
let currentTrip = null;
let tripMarker = null;

const $ = id => document.getElementById(id);
const cleanName = v => String(v || "User").trim().replace(/\s+/g," ").slice(0, MAX_NAME);
const validCoord = (lat,lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat>=-90 && lat<=90 && lng>=-180 && lng<=180;
const distanceKm = (a,b,c,d) => {
    if(!validCoord(a,b) || !validCoord(c,d)) return "";
    const p = Math.PI/180, a1 = 0.5 - Math.cos((c-a)*p)/2 + Math.cos(a*p)*Math.cos(c*p)*Math.sin((d-b)*p/2)**2;
    return (12742 * Math.asin(Math.sqrt(a1))).toFixed(2);
};

socket.on("connect", () => { if (currentUser.name) socket.emit("profileReady", currentUser); });

// ==========================================
// TOAST NOTIFICATIONS (Phase 4)
// ==========================================
function showToast(message, duration = 4000) {
    const container = $("toast-container");
    const toast = document.createElement("div");
    toast.className = "toast"; toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, duration);
}

socket.on("geofenceAlert", (data) => {
    const action = data.type === "enter" ? "entered" : "left";
    showToast(`🔔 ${data.user} has ${action} ${data.fence}!`);
});

// ==========================================
// LOCATION TRACKING & HISTORY (Phase 4 Update)
// ==========================================
function startGPS() {
    if(!navigator.geolocation) return;
    navigator.geolocation.watchPosition(async p=>{
        const lat=Number(p.coords.latitude), lng=Number(p.coords.longitude), acc=Number(p.coords.accuracy);
        if(!validCoord(lat,lng)) return;
        myCoords={lat,lng};

        // Phase 4: Location History Trail Update
        locationHistory.push([lat, lng]);
        historyPolyline.setLatLngs(locationHistory);

        if(!ownMarker){
            ownMarker = L.marker([lat,lng],{icon:L.icon({iconUrl:currentUser.avatar, iconSize:[36,36], iconAnchor:[18,18], className:"avatar-icon own-live-avatar"}), zIndexOffset:1000}).addTo(map);
            map.setView([lat,lng], 16);
        } else ownMarker.setLatLng([lat,lng]);

        if(acc>0 && acc<100000){
            if(!accuracyCircle) accuracyCircle=L.circle([lat,lng],{radius:acc, color:"#10b981", weight:2, fillOpacity:.15}).addTo(map);
            else {accuracyCircle.setLatLng([lat,lng]); accuracyCircle.setRadius(acc);}
        }

        if(!cityName) {
            try{ const r=await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10`); const d=await r.json(); cityName=d.address?.city||"Rourkela"; $("header-app-title").textContent=`${cityName} Map`; $("pill-city").textContent=`📍 ${cityName}`; }catch{}
        }
        
        try{ const r=await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code`); const d=await r.json(); myWeather=`${Math.round(d.current.temperature_2m)}°C`; ownMarker.unbindTooltip().bindTooltip(myWeather,{permanent:true,direction:"right",className:"weather-badge",offset:[15,0]}); }catch{}
        
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

// ==========================================
// FRIENDS HANDLING
// ==========================================
socket.on("onlineUsers", list=>{ if(Array.isArray(list)) list.forEach(u=>{ if(u.id!==socket.id){ friendData[u.id]={...(friendData[u.id]||{}),...u,online:true}; createOrUpdateFriendMarker(u);} }); updateOnlineUI(); });
socket.on("userOnline", u=>{ if(u.id!==socket.id){ friendData[u.id]={...(friendData[u.id]||{}),...u,online:true}; createOrUpdateFriendMarker(u); } updateOnlineUI(); });
socket.on("userOffline", d=>{ if(d?.id && friendData[d.id]){ friendData[d.id].online=false; if(friendMarkers[d.id]) friendMarkers[d.id].setOpacity(0.45); } updateOnlineUI(); });
socket.on("friendMoved", u=>{ if(u?.id) createOrUpdateFriendMarker({...u,online:true}); updateOnlineUI(); updateTripPanel();});
socket.on("friendDisconnected", id=>{ if(friendMarkers[id]){map.removeLayer(friendMarkers[id]); delete friendMarkers[id];} delete friendData[id]; updateOnlineUI(); });

function createOrUpdateFriendMarker(u){
    if(!u?.id || !validCoord(u.lat,u.lng)) return;
    friendData[u.id] = { id:u.id, name:u.name||"Friend", avatar:u.avatar||DEFAULT_AVATAR, lat:u.lat, lng:u.lng, weather:u.weather||"", online:u.online!==false };
    let m = friendMarkers[u.id];
    if(!m){ m=L.marker([u.lat,u.lng],{icon:L.icon({iconUrl:u.avatar, iconSize:[34,34], className:"avatar-icon friend-marker"})}).addTo(map); m.on("click",()=>showProfilePopup(u)); friendMarkers[u.id]=m; }
    else { m.setLatLng([u.lat,u.lng]); m.setOpacity(u.online===false?0.45:1); }
    updateFriendBadges();
}

function updateOnlineUI(){
    let c=0; Object.values(friendData).forEach(f=>{if(f.online!==false) c++;});
    $("header-online-status").textContent = `${currentUser.name ? c+1 : c} online`;
    $("chat-subtitle").textContent = `${currentUser.name ? c+1 : c} online`;
    const box=$("online-list"); if(!box) return; box.innerHTML="";
    Object.values(friendData).filter(f=>f.online!==false).forEach(u=>{
        const btn=document.createElement("button"); btn.className="online-friend";
        btn.innerHTML=`<img src="${u.avatar}"><span><b>${u.name}</b></span><div class="status-dot"></div>`;
        btn.onclick=()=>{ map.flyTo([u.lat,u.lng],16); showProfilePopup(u); };
        box.appendChild(btn);
    });
}

function showProfilePopup(u) {
    $("profile-popup-avatar").src=u.avatar; $("profile-popup-name").textContent=u.name;
    $("profile-popup-status").textContent = u.online!==false ? "● Online" : "● Offline";
    $("profile-popup-status").style.color = u.online!==false ? "#18d6a3" : "#8fa1aa";
    $("profile-popup-distance").textContent = myCoords ? `${distanceKm(myCoords.lat,myCoords.lng,u.lat,u.lng)} km away` : "--";
    $("profile-popup-weather").textContent = u.weather || "--";
    $("profile-popup").style.display="flex";
    $("profile-focus-btn").onclick=()=>{ map.flyTo([u.lat,u.lng],16); $("profile-popup").style.display="none"; };
}
$("profile-popup-close")?.addEventListener("click",()=>$("profile-popup").style.display="none");

// ==========================================
// PHASE 4: ADVANCED MAP TOOLS 
// ==========================================
function setupAdvancedTools() {
    // 1. Distance Measurement Tool
    $("measure-btn").onclick = () => {
        mapActionMode = mapActionMode === 'measure' ? null : 'measure';
        $("measure-btn").classList.toggle("active-tool", mapActionMode === 'measure');
        $("geofence-btn").classList.remove("active-tool"); $("trip-btn").classList.remove("active-tool");
        if(mapActionMode !== 'measure') { p4LayerGroup.clearLayers(); measurePoints = []; }
        else showToast("📍 Tap two points on the map to measure distance");
    };

    // 2. Geofence Tool
    $("geofence-btn").onclick = () => {
        mapActionMode = mapActionMode === 'geofence' ? null : 'geofence';
        $("geofence-btn").classList.toggle("active-tool", mapActionMode === 'geofence');
        $("measure-btn").classList.remove("active-tool"); $("trip-btn").classList.remove("active-tool");
        if(mapActionMode === 'geofence') showToast("⭕ Tap the map to set a Geofence area");
    };

    // 3. Trip Mode Tool
    $("trip-btn").onclick = () => {
        mapActionMode = mapActionMode === 'trip' ? null : 'trip';
        $("trip-btn").classList.toggle("active-tool", mapActionMode === 'trip');
        $("measure-btn").classList.remove("active-tool"); $("geofence-btn").classList.remove("active-tool");
        if(mapActionMode === 'trip') showToast("🚗 Tap the map to set Group Trip Destination");
    };

    // Global Map Click Handler
    map.on('click', (e) => {
        if (mapActionMode === 'measure') {
            measurePoints.push(e.latlng);
            L.circleMarker(e.latlng, {color: '#f59e0b', radius: 5, fillOpacity: 1}).addTo(p4LayerGroup);
            if (measurePoints.length === 2) {
                L.polyline(measurePoints, {color: '#f59e0b', weight: 4, dashArray: '5, 5'}).addTo(p4LayerGroup);
                const d = distanceKm(measurePoints[0].lat, measurePoints[0].lng, measurePoints[1].lat, measurePoints[1].lng);
                showToast(`📏 Distance: ${d} km`, 5000);
                setTimeout(() => { p4LayerGroup.clearLayers(); measurePoints = []; }, 5000);
            }
        } 
        else if (mapActionMode === 'geofence') {
            const name = prompt("Enter Geofence Name (e.g., Home, College):");
            if (name && name.trim()) {
                socket.emit("addGeofence", { name: name.trim(), lat: e.latlng.lat, lng: e.latlng.lng, radius: 500 });
                showToast(`⭕ Geofence '${name}' created!`);
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
    });

    // Render Geofences from Server
    socket.on("loadGeofences", fences => {
        map.eachLayer(l => { if(l.options?.isGeofence) map.removeLayer(l); });
        fences.forEach(f => {
            L.circle([f.lat, f.lng], { radius: f.radius, color: "#8b5cf6", weight: 2, fillOpacity: 0.1, isGeofence: true }).addTo(map);
            L.marker([f.lat, f.lng], { icon: L.divIcon({className: 'geofence-marker', html: '📍'}), isGeofence: true }).bindTooltip(f.name, {permanent: true, direction: "top", className: "weather-badge"}).addTo(map);
        });
    });

    // Handle Trip Data
    socket.on("tripData", trip => {
        currentTrip = trip;
        if(tripMarker) { map.removeLayer(tripMarker); tripMarker = null; }
        
        if(trip) {
            $("trip-panel").style.display = "flex";
            $("trip-title").textContent = `Trip to ${trip.name}`;
            tripMarker = L.marker([trip.lat, trip.lng], { icon: L.divIcon({className: 'geofence-marker', html: '🏁'}) }).addTo(map);
            updateTripPanel();
        } else {
            $("trip-panel").style.display = "none";
        }
    });

    $("trip-end-btn").onclick = () => socket.emit("endTrip");
}

function updateTripPanel() {
    if(!currentTrip) return;
    const list = $("trip-members-list"); list.innerHTML = "";
    
    // My Distance
    if(myCoords && currentUser.name) {
        const d = distanceKm(myCoords.lat, myCoords.lng, currentTrip.lat, currentTrip.lng);
        list.innerHTML += `<div class="trip-member"><div><img src="${currentUser.avatar}"> You</div> <span>${d} km</span></div>`;
    }
    
    // Friends Distance
    Object.values(friendData).filter(f=>f.online!==false).forEach(f => {
        const d = distanceKm(f.lat, f.lng, currentTrip.lat, currentTrip.lng);
        list.innerHTML += `<div class="trip-member"><div><img src="${f.avatar}"> ${f.name}</div> <span>${d} km</span></div>`;
    });
}

// ==========================================
// BASIC MAP CONTROLS
// ==========================================
function setupBasicControls(){
    $("my-location-btn").onclick = () => { if(myCoords) map.flyTo([myCoords.lat,myCoords.lng], 16); };
    $("compass-btn").onclick = () => map.setView(map.getCenter(), map.getZoom(), {animate:true});
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

// ==========================================
// CHAT FUNCTIONALITY
// ==========================================
function setupChat(){
    const cc=$("chat-container"), inp=$("chatInput"), send=$("chat-send"), vb=$("voiceButton");
    let unread=0, typingTimer=null, replyTo=null, reactingId=null;
    const msgStore=new Map(), emojis=["👍","❤️","😂","😮","😢","🔥"];

    function updateUnread(){ const b=$("chat-unread-badge"); b.textContent=unread; b.style.display=unread>0?"flex":"none"; }
    $("chat-toggle-btn").onclick=()=>{ if(cc.style.display==="flex"){cc.style.display="none";}else{cc.style.display="flex";unread=0;updateUnread();inp.focus();} };
    $("chat-minimize-btn").onclick=()=>{cc.style.display="none";};
    $("online-btn").onclick=()=>{$("online-list").style.display=$("online-list").style.display==="block"?"none":"block"; renderOnlineList();};

    inp.oninput=()=>{ socket.emit("typing",true); clearTimeout(typingTimer); typingTimer=setTimeout(()=>socket.emit("typing",false), 1200); send.style.display=inp.value.trim()?"flex":"none"; vb.style.display=inp.value.trim()?"none":"flex"; };
    socket.on("typing", d=>{ const t=$("typing-indicator"); if(d.id!==socket.id && d.isTyping){t.textContent=`${d.name} is typing…`; t.style.display="block";}else t.style.display="none"; });

    $("reply-cancel").onclick=()=>{replyTo=null; $("reply-bar").style.display="none";};
    $("emojiButton").onclick=(e)=>{e.stopPropagation(); $("emoji-picker-container").style.display=$("emoji-picker-container").style.display==="block"?"none":"block";};
    $("emojiPicker").addEventListener("emoji-click",e=>{ const em=e.detail.unicode; if(reactingId){socket.emit("messageReaction",{messageId:reactingId,emoji:em});$("emoji-picker-container").style.display="none";reactingId=null;}else{inp.value+=em;inp.focus();send.style.display="flex";vb.style.display="none";} });
    
    $("chat-attach-btn").onclick=(e)=>{e.stopPropagation(); $("attachment-menu").style.display=$("attachment-menu").style.display==="flex"?"none":"flex";};
    const fInp=$("chatFileInput");
    $("att-media").onclick=()=>{fInp.accept="image/*,video/*";fInp.click();$("attachment-menu").style.display="none";};
    $("att-doc").onclick=()=>{fInp.accept=".pdf,.doc,.txt,.zip";fInp.click();$("attachment-menu").style.display="none";};
    $("att-audio").onclick=()=>{fInp.accept="audio/*";fInp.click();$("attachment-menu").style.display="none";};
    fInp.onchange=()=>{ const f=fInp.files?.[0]; if(!f) return; const r=new FileReader(); r.onload=()=>{ socket.emit("chatMessage",{name:currentUser.name, type:f.type.split('/')[0]==="image"?"image":f.type.split('/')[0]==="video"?"video":f.type.split('/')[0]==="audio"?"audio":"document", data:r.result, replyTo}); $("reply-cancel").click();}; r.readAsDataURL(f); };

    $("chatForm").onsubmit=e=>{ e.preventDefault(); const t=inp.value.trim(); if(t){socket.emit("chatMessage",{name:currentUser.name,type:"text",data:t,replyTo}); inp.value=""; $("reply-cancel").click(); send.style.display="none"; vb.style.display="flex"; inp.focus();} };

    function renderMsg(m){
        if(msgStore.has(m.id)) return;
        const w=document.createElement("div"); w.className="chat-row "+(m.senderId===socket.id?"mine":"");
        const b=document.createElement("div"); b.className="chat-message "+(m.senderId===socket.id?"msg-mine":"msg-theirs");
        if(m.senderId!==socket.id) b.innerHTML+=`<div class="msg-sender">${m.name}</div>`;
        if(m.replyTo) b.innerHTML+=`<div class="reply-quote"><b>${m.replyTo.name}</b><br>${m.replyTo.preview}</div>`;
        
        if(m.type==="text") b.innerHTML+=`<div>${m.data}</div>`;
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

// ==========================================
// PHASE 3: MEMORY GALLERY
// ==========================================
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
            c.innerHTML=`<img src="${m.image}" loading="lazy"><div class="p3-card-info"><b>${m.name}</b><span>${new Date(m.time).toLocaleDateString()}</span></div>`;
            c.onclick=()=>{selectedMemoryId=m.id; $("p3-view-image").src=m.image; $("p3-view-name").textContent=m.name; $("p3-view-date").textContent=new Date(m.time).toLocaleString(); $("phase3-photo-viewer").style.display="flex";}; grid.appendChild(c);
            
            const t=document.createElement("div"); t.className="p3-time-item";
            t.innerHTML=`<div class="p3-time-thumb"><img src="${m.image}" loading="lazy"></div><div class="p3-time-info"><b>${m.name}</b><span>${new Date(m.time).toLocaleString()}</span></div>`;
            t.onclick=c.onclick; time.appendChild(t);
        });
    }

    const memLayer = L.layerGroup().addTo(map);
    function renderPins(){
        memLayer.clearLayers();
        memories.forEach(m=>{
            const icon = L.divIcon({ className:"p3-memory-marker", html:`<div style="width:46px;height:46px;border-radius:50%;overflow:hidden;border:2px solid #fff;background:#071018;box-shadow:0 4px 15px rgba(0,0,0,.65)"><img src="${m.image}" style="width:100%;height:100%;object-fit:cover;"></div>`, iconSize:[46,46], iconAnchor:[23,23]});
            const marker = L.marker([m.lat,m.lng],{icon}).addTo(memLayer);
            marker.bindPopup(`<div class="p3-map-popup"><img src="${m.image}"><b>📸 ${m.name}</b><button class="p3-open-map-memory">View</button></div>`);
            marker.on("popupopen",e=>{ const b=e.popup.getElement()?.querySelector(".p3-open-map-memory"); if(b) b.onclick=()=>{selectedMemoryId=m.id; $("p3-view-image").src=m.image; $("p3-view-name").textContent=m.name; $("p3-view-date").textContent=new Date(m.time).toLocaleString(); $("phase3-photo-viewer").style.display="flex";}; });
        });
    }

    socket.on("loadMemoryPhotos", l=>{ memories.clear(); l.forEach(m=>memories.set(m.id,m)); renderPins(); });
    socket.on("newMemoryPin", m=>{ memories.set(m.id,m); renderPins(); if($("phase3-memory-overlay").style.display==="block") renderMemGallery(); });

    $("memoryButton").onclick=()=>$("memoryPhotoInput").click();
    $("memoryPhotoInput").onchange=()=>{
        const f=$("memoryPhotoInput").files?.[0]; if(!f)return;
        const r=new FileReader(); r.onload=()=>{ map.once("click",e=>socket.emit("uploadMemoryPhoto",{name:currentUser.name,lat:e.latlng.lat,lng:e.latlng.lng,image:r.result})); showToast("📸 Tap map to pin photo"); }; r.readAsDataURL(f);
    };
}

// ==========================================
// INIT
// ==========================================
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
