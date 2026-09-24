"use strict";

// ==========================================
// 1. SETUP & LEAFLET MAP
// ==========================================
const socket = io({ transports: ["websocket", "polling"] });
const DEFAULT_CENTER = [18.8136, 82.7153];
const DEFAULT_AVATAR = "satyam.png";

const map = L.map("map", {
    zoomControl: false, preferCanvas: false, minZoom: 3, maxBounds: [[-90, -180], [90, 180]], maxBoundsViscosity: 1.0
}).setView(DEFAULT_CENTER, 13);

const darkLayer = L.tileLayer("https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}", {
    maxZoom: 20, subdomains: ["mt0","mt1","mt2","mt3"], className: "google-dark-map"
});
darkLayer.addTo(map);

let currentUser = { name: localStorage.getItem("koraput_name") || "", avatar: localStorage.getItem("koraput_avatar") || DEFAULT_AVATAR };
let myCoords = null, myWeather = "", ownMarker = null, cityName = "";
const friendMarkers = Object.create(null);
const friendData = Object.create(null);

let lastFixCoords = null, lastFixTime = 0;
let locationHistory = [];
const p4LayerGroup = L.layerGroup().addTo(map);
const navigationLayer = L.layerGroup().addTo(map);
const memoryLayer = L.layerGroup().addTo(map);

let searchMarker = null;
const $ = id => document.getElementById(id);
const cleanName = v => String(v || "User").trim().replace(/\s+/g," ").slice(0, 40);

function distanceKm(a,b,c,d){
    if(!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) return 0;
    const p = Math.PI/180, a1 = 0.5 - Math.cos((c-a)*p)/2 + Math.cos(a*p)*Math.cos(c*p)*Math.sin((d-b)*p/2)**2;
    return (12742 * Math.asin(Math.sqrt(a1))).toFixed(2);
}

// ==========================================
// 2. SMART DRIVE ENGINE (Fuel, Graph, Alert)
// ==========================================
const SmartDrive = {
    isRecording: false,
    baseMileage: 18,
    speedHistory: [],
    trip: { active: false, totalDist: 0, actualFuel: 0, maxSpeed: 0, sumSpeed: 0, ticks: 0, ranges: {efficient:0, moderate:0, inefficient:0} },
    audioCtx: null, lastAlertTime: 0, overlayTimer: null,

    init() {
        const savedMil = localStorage.getItem("sd_mileage");
        if(savedMil) this.baseMileage = parseFloat(savedMil);
        if($("fuel-input-val")) $("fuel-input-val").value = this.baseMileage;
        
        const savedRec = localStorage.getItem("sd_record");
        this.isRecording = savedRec === "1";
        if($("speed-record-toggle")) $("speed-record-toggle").checked = this.isRecording;
        if($("speed-graph-canvas")) $("speed-graph-canvas").style.display = this.isRecording ? "block" : "none";

        $("fuel-input-val")?.addEventListener("change", (e) => {
            this.baseMileage = parseFloat(e.target.value) || 18;
            localStorage.setItem("sd_mileage", this.baseMileage);
        });
        
        $("speed-record-toggle")?.addEventListener("change", (e) => {
            this.isRecording = e.target.checked;
            localStorage.setItem("sd_record", this.isRecording ? "1" : "0");
            if($("speed-graph-canvas")) $("speed-graph-canvas").style.display = this.isRecording ? "block" : "none";
            if(!this.isRecording) this.speedHistory = [];
        });

        $("profile-open-btn")?.addEventListener("click", () => {
            if($("profile-settings-modal")) $("profile-settings-modal").style.display = "flex";
        });
        $("close-settings-btn")?.addEventListener("click", () => {
            if($("profile-settings-modal")) $("profile-settings-modal").style.display = "none";
        });
        $("close-results-btn")?.addEventListener("click", () => {
            if($("results-panel")) $("results-panel").style.display = "none";
        });
        
        document.addEventListener("click", () => {
            if(!this.audioCtx) {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if(AudioContext) this.audioCtx = new AudioContext();
            }
            if(this.audioCtx && this.audioCtx.state === "suspended") this.audioCtx.resume();
        }, {passive:true});
    },

    beep(freq, ms) {
        if(!this.audioCtx) return;
        try {
            if (this.audioCtx.state === "suspended") this.audioCtx.resume();
            const osc = this.audioCtx.createOscillator(), gain = this.audioCtx.createGain();
            osc.type = "square"; osc.frequency.value = freq;
            gain.gain.value = 0.15;
            osc.connect(gain); gain.connect(this.audioCtx.destination);
            osc.start(); osc.stop(this.audioCtx.currentTime + ms/1000);
        } catch(e) {}
    },

    triggerRedMap() {
        const overlay = $("speed-danger-overlay");
        if(overlay) {
            overlay.classList.add("active");
            clearTimeout(this.overlayTimer);
            this.overlayTimer = setTimeout(() => overlay.classList.remove("active"), 10000);
        }
    },

    checkSafetyLimits(speed) {
        const now = Date.now();
        const dial = $("speed-dial");
        if(dial) {
            if(speed > 3) {
                dial.style.display = "flex";
                if($("speed-n")) $("speed-n").textContent = Math.round(speed);
                dial.className = "speed-dial " + (speed >= 100 ? "danger" : (speed >= 80 ? "warn" : ""));
            } else {
                dial.style.display = "none";
            }
        }
        if (now - this.lastAlertTime < 15000) return;

        if (speed >= 100) {
            this.triggerRedMap();
            this.beep(800, 300); setTimeout(()=>this.beep(800, 300), 500); setTimeout(()=>this.beep(800, 300), 1000);
            this.lastAlertTime = now;
        } else if (speed >= 80) {
            this.beep(600, 400); 
            this.lastAlertTime = now;
        }
    },

    tick(speedKmh, distKm) {
        this.checkSafetyLimits(speedKmh);
        if (!this.trip.active && !this.isRecording) return;
        this.speedHistory.push(speedKmh);
        if(this.speedHistory.length > 50) this.speedHistory.shift();
        this.drawGraph();

        if (this.trip.active && distKm > 0) {
            this.trip.totalDist += distKm;
            this.trip.ticks += 1;
            this.trip.sumSpeed += speedKmh;
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
        const cvs = $("speed-graph-canvas");
        if(!cvs || !this.isRecording) return;
        const ctx = cvs.getContext("2d");
        const w = cvs.width = cvs.offsetWidth, h = cvs.height = cvs.offsetHeight;
        ctx.clearRect(0,0,w,h);
        if(this.speedHistory.length < 2) return;
        const max = Math.max(60, ...this.speedHistory);
        ctx.beginPath();
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 2;
        this.speedHistory.forEach((v, i) => {
            const x = (i / (this.speedHistory.length - 1)) * w;
            const y = h - (v / max) * h * 0.8;
            if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        });
        ctx.stroke();
    },

    startTrip() {
        this.trip = { active: true, totalDist: 0, actualFuel: 0, maxSpeed: 0, sumSpeed: 0, ticks: 0, ranges: {efficient:0, moderate:0, inefficient:0} };
    },
    endTrip() {
        if(!this.trip.active || this.trip.ticks === 0) return;
        this.trip.active = false;
        const avg = this.trip.sumSpeed / this.trip.ticks;
        
        if($("res-dist")) $("res-dist").textContent = this.trip.totalDist.toFixed(2) + " km";
        if($("res-avg-speed")) $("res-avg-speed").textContent = Math.round(avg) + " km/h";
        if($("res-max-speed")) $("res-max-speed").textContent = Math.round(this.trip.maxSpeed) + " km/h";
        if($("res-eff-time")) $("res-eff-time").textContent = Math.round(this.trip.ranges.efficient / 60) + " min";
        if($("res-ineff-time")) $("res-ineff-time").textContent = Math.round(this.trip.ranges.inefficient / 60) + " min";
        if($("res-base-mlg")) $("res-base-mlg").textContent = this.baseMileage + " km/L";
        if($("res-actual-fuel")) $("res-actual-fuel").textContent = this.trip.actualFuel.toFixed(2) + " L";

        if($("results-panel")) $("results-panel").style.display = "flex";
    }
};

// ==========================================
// 3. CORE GPS & SOCKETS
// ==========================================
socket.on("connect", () => { if (currentUser.name) socket.emit("profileReady", currentUser); });

function startGPS() {
    if(!navigator.geolocation) return;
    navigator.geolocation.watchPosition(p=>{
        const lat=Number(p.coords.latitude), lng=Number(p.coords.longitude);
        myCoords={lat,lng};

        if(!ownMarker){
            ownMarker = L.marker([lat,lng],{icon:L.divIcon({className: "custom-own-icon", html: `<img src="${currentUser.avatar}" style="width:100%; height:100%; border-radius:50%; border:2.5px solid #18d6a3; object-fit:cover;">`, iconSize: [38, 38]}), zIndexOffset:1000}).addTo(map);
            map.setView([lat,lng], 16);
        } else {
            ownMarker.setLatLng([lat,lng]);
        }

        let speedKmh = 0, dist = 0;
        if (p.coords.speed != null && p.coords.speed >= 0) {
            speedKmh = p.coords.speed * 3.6;
        } 
        if (lastFixCoords && lastFixTime) {
            dist = Number(distanceKm(lastFixCoords.lat, lastFixCoords.lng, lat, lng)) || 0;
            const dtSec = (Date.now() - lastFixTime) / 1000;
            if (!p.coords.speed && dtSec > 0.5) speedKmh = (dist / dtSec) * 3600;
        }
        speedKmh = Math.min(speedKmh, 300); 
        lastFixCoords = { lat, lng }; lastFixTime = Date.now();

        SmartDrive.tick(speedKmh, dist);
        socket.emit("updateLocation",{name:currentUser.name, avatar:currentUser.avatar, lat, lng});
        updateFriendBadges(); 
    }, e => {}, {enableHighAccuracy:true,timeout:15000,maximumAge:3000});
}

function updateFriendBadges(){
    Object.keys(friendMarkers).forEach(id=>{
        const f=friendData[id], m=friendMarkers[id]; if(!f||!m) return;
        let text = f.online===false ? "Offline" : `📍 ${distanceKm(myCoords?.lat,myCoords?.lng,f.lat,f.lng)} km`;
        m.unbindTooltip(); m.bindTooltip(text,{permanent:true,direction:"right",offset:[15,0]});
    });
}

socket.on("onlineUsers", list=>{ if(Array.isArray(list)) list.forEach(u=>{ if(u.id!==socket.id){ friendData[u.id]={...u,online:true}; createOrUpdateFriendMarker(u);} }); });
socket.on("userOnline", u=>{ if(u.id!==socket.id){ friendData[u.id]={...u,online:true}; createOrUpdateFriendMarker(u); } });
socket.on("userOffline", d=>{ if(d?.id && friendData[d.id]){ friendData[d.id].online=false; if(friendMarkers[d.id]) friendMarkers[d.id].setOpacity(0.45); } });
socket.on("friendMoved", u=>{ if(u?.id) { createOrUpdateFriendMarker({...u,online:true}); }});
socket.on("friendDisconnected", id=>{ if(friendMarkers[id]){map.removeLayer(friendMarkers[id]); delete friendMarkers[id];} delete friendData[id]; });

function createOrUpdateFriendMarker(u){
    if(!u?.id || !validCoord(u.lat,u.lng)) return;
    friendData[u.id] = { id:u.id, name:u.name||"Friend", avatar:u.avatar||DEFAULT_AVATAR, lat:u.lat, lng:u.lng, online:u.online!==false };
    let m = friendMarkers[u.id];
    if(!m){ 
        m=L.marker([u.lat,u.lng],{icon:L.divIcon({className: "custom-friend-icon", html: `<img src="${u.avatar}" style="width:100%; height:100%; border-radius:50%; border:2px solid #60a5fa; object-fit:cover;">`, iconSize: [36, 36]})}).addTo(map); 
        m.on("click",()=>showProfilePopup(u)); 
        friendMarkers[u.id]=m; 
    } else { 
        m.setLatLng([u.lat,u.lng]); m.setOpacity(u.online===false?0.45:1); 
    }
    updateFriendBadges();
}

function showProfilePopup(u) {
    if($("profile-popup-avatar")) $("profile-popup-avatar").src=u.avatar; 
    if($("profile-popup-name")) $("profile-popup-name").textContent=u.name;
    if($("profile-popup-distance")) $("profile-popup-distance").textContent = myCoords ? `${distanceKm(myCoords.lat,myCoords.lng,u.lat,u.lng)} km away` : "--";
    if (typeof initCallButton === "function") initCallButton(u);
    if($("profile-popup")) $("profile-popup").style.display="flex";
    if($("profile-popup-close")) $("profile-popup-close").onclick=()=>$("profile-popup").style.display="none";
}

// ==========================================
// 4. GOOGLE NAVIGATION & SEARCH
// ==========================================
let navWatchId = null;

function setupGoogleSearch() {
    const searchInput = $("location-search-input");
    const clearBtn = $("location-search-clear");
    if (!searchInput) return;

    if (clearBtn) {
        clearBtn.onclick = () => {
            searchInput.value = ""; clearBtn.style.display = "none";
            if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
            navigationLayer.clearLayers();
            if($("nav-bottom-sheet")) $("nav-bottom-sheet").style.display = "none";
            if (myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16);
        };
    }
    searchInput.addEventListener('input', () => { if (clearBtn) clearBtn.style.display = searchInput.value.length > 0 ? "block" : "none"; });

    const checkGoogle = setInterval(() => {
        if (window.google && window.google.maps && window.google.maps.places) {
            clearInterval(checkGoogle);
            const autocomplete = new google.maps.places.Autocomplete(searchInput, { componentRestrictions: { country: "in" } });

            autocomplete.addListener("place_changed", () => {
                const place = autocomplete.getPlace();
                if (!place.geometry) return;
                
                const destLat = place.geometry.location.lat();
                const destLng = place.geometry.location.lng();
                const placeName = place.name;
                
                if (searchMarker) map.removeLayer(searchMarker);
                navigationLayer.clearLayers();
                map.flyTo([destLat, destLng], 15);
                
                searchMarker = L.marker([destLat, destLng], { icon: L.divIcon({ className: 'geofence-marker', html: '📍', iconSize: [30, 30] }) }).addTo(map);
                if (clearBtn) clearBtn.style.display = "block";

                if(myCoords && window.google) {
                    $("nav-bottom-sheet").style.display = "flex";
                    $("btn-start-nav").style.display = "block";
                    $("btn-exit-nav").style.display = "none";
                    $("stat-status").textContent = "Calculating...";

                    const ds = new google.maps.DirectionsService();
                    ds.route({ origin: new google.maps.LatLng(myCoords.lat, myCoords.lng), destination: new google.maps.LatLng(destLat, destLng), travelMode: 'DRIVING' }, (res, status) => {
                        if(status === 'OK' && res.routes.length > 0) {
                            const route = res.routes[0];
                            const leg = route.legs[0];
                            const coords = route.overview_path.map(p => [p.lat(), p.lng()]);
                            L.polyline(coords, { color: '#60a5fa', weight: 4, opacity: 0.5 }).addTo(navigationLayer);

                            $("stat-dist").innerHTML = leg.distance.text;
                            $("stat-eta").innerHTML = leg.duration.text;
                            $("stat-status").textContent = "Ready";
                            
                            $("btn-start-nav").onclick = () => startSearchNavigation(destLat, destLng, placeName, route);
                            $("btn-reset-nav").onclick = () => { searchMarker.remove(); navigationLayer.clearLayers(); $("nav-bottom-sheet").style.display = "none"; searchInput.value = ""; };
                        }
                    });
                }
            });
        }
    }, 500); 
}

function startSearchNavigation(destLat, destLng, destName, routeData) {
    navigationLayer.clearLayers();
    if(navWatchId) navigator.geolocation.clearWatch(navWatchId);
    
    if($("map-tools")) $("map-tools").style.display = "none";
    if($("search-container")) $("search-container").style.display = "none";
    if($("chat-toggle-btn")) $("chat-toggle-btn").style.display = "none";
    if($("turn-banner")) $("turn-banner").style.display = "flex";

    const leg = routeData.legs[0];
    const fullPath = routeData.overview_path.map(p => [p.lat(), p.lng()]);
    
    L.polyline(fullPath, { color: '#4f46e5', weight: 8, opacity: 0.7 }).addTo(navigationLayer);
    const solidPath = L.polyline([], { color: '#10b981', weight: 8, opacity: 1 }).addTo(navigationLayer);

    const userMarker = L.marker(fullPath[0], {icon: L.divIcon({className: 'nav-avatar-marker', html: `<img src="${currentUser.avatar}" style="width:100%;height:100%;object-fit:cover; border-radius:50%; border:2px solid #10b981;">`, iconSize: [40, 40]}), zIndexOffset: 1000}).addTo(navigationLayer);
    L.marker([destLat, destLng], { icon: L.divIcon({className: 'geofence-marker', html: '📍'}) }).addTo(navigationLayer);

    if($("stat-dist")) $("stat-dist").innerHTML = leg.distance.text;
    if($("turn-name")) $("turn-name").textContent = leg.steps[0].instructions.replace(/<[^>]*>?/gm, ''); 

    map.fitBounds(L.polyline(fullPath).getBounds(), { padding: [50, 50] });

    $("btn-start-nav").style.display = "none";
    $("btn-exit-nav").style.display = "block";
    $("btn-reset-nav").style.display = "none";
    $("stat-status").textContent = "En route";
    if(myCoords) map.flyTo([myCoords.lat, myCoords.lng], 18);
    
    SmartDrive.startTrip();
    
    if (navigator.geolocation) {
        let traveledCoords = [];
        navWatchId = navigator.geolocation.watchPosition((pos) => {
            const currentPos = [pos.coords.latitude, pos.coords.longitude];
            userMarker.setLatLng(currentPos);
            map.panTo(currentPos);

            traveledCoords.push(L.latLng(currentPos[0], currentPos[1]));
            solidPath.setLatLngs(traveledCoords);

            const remainingMeters = map.distance(currentPos, [destLat, destLng]);
            if($("stat-dist")) $("stat-dist").innerHTML = (remainingMeters / 1000).toFixed(1) + " km";

            if(remainingMeters < 30) {
                navigator.geolocation.clearWatch(navWatchId);
                $("stat-status").textContent = "Arrived";
                if($("turn-name")) $("turn-name").textContent = "Destination reached!";
                setTimeout(() => stopDrive(), 3000);
            }
        }, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 });
    }
    
    $("btn-exit-nav").onclick = () => stopDrive();
}

function stopDrive(cancelled = false) {
    if(navWatchId) navigator.geolocation.clearWatch(navWatchId);
    navigationLayer.clearLayers();
    if($("nav-bottom-sheet")) $("nav-bottom-sheet").style.display = "none";
    if($("turn-banner")) $("turn-banner").style.display = "none";
    if($("speed-dial")) $("speed-dial").style.display = "none";
    
    if($("map-tools")) $("map-tools").style.display = "flex";
    if($("search-container")) $("search-container").style.display = "flex";
    if($("chat-toggle-btn")) $("chat-toggle-btn").style.display = "flex";
    
    if(myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16);
    if(!cancelled) SmartDrive.endTrip();
}

// ==========================================
// 5. VOICE CALLING (WEBRTC)
// ==========================================
let peerConnection = null, localStream = null, callDialog = null, activeCallBtn = null;
const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" }] };

function attachAudioTrack(event) {
    let audio = document.getElementById("remote-audio");
    if(!audio) {
        audio = document.createElement("audio");
        audio.id = "remote-audio"; audio.autoplay = true; audio.playsInline = true; audio.hidden = true;
        document.body.appendChild(audio);
    }
    audio.srcObject = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
    audio.play().catch(() => document.body.addEventListener('click', () => audio.play(), { once: true }));
}

function initCallButton(u) {
    const callBtn = $("profile-call-btn");
    if (!callBtn) return;
    const newBtn = callBtn.cloneNode(true);
    callBtn.parentNode.replaceChild(newBtn, callBtn);
    
    newBtn.onclick = async () => {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            peerConnection = new RTCPeerConnection(rtcConfig);
            localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
            peerConnection.ontrack = attachAudioTrack; 
            peerConnection.onicecandidate = (event) => { if (event.candidate) socket.emit("call-user", { to: u.id, signal: { type: "ice", candidate: event.candidate }, name: currentUser.name }); };
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit("call-user", { to: u.id, signal: { type: "offer", sdp: offer }, name: currentUser.name });
            showActiveCallUI(() => socket.emit("end-call", { to: u.id }));
        } catch (err) {}
    };
}

socket.on("incoming-call", async (data) => {
    if (data.signal.type === "offer") {
        if (peerConnection) { socket.emit("end-call", { to: data.from }); return; }
        if (callDialog) callDialog.remove();
        
        callDialog = document.createElement('div');
        callDialog.style.cssText = "position:fixed;top:70px;left:50%;transform:translateX(-50%);background:rgba(15,23,42,0.98);padding:24px;border:1px solid #18d6a3;border-radius:20px;z-index:9999;color:white;text-align:center;";
        callDialog.innerHTML = `<div style="font-size:32px;margin-bottom:10px;">📞</div><strong style="font-size:18px;display:block;">${escapeHTML(data.name)}</strong><div style="font-size:13px;color:#94a3b8;margin-top:6px;margin-bottom:20px;">Incoming Voice Call...</div><div style="display:flex;gap:12px;justify-content:center;"><button id="accept-call-btn" style="flex:1;background:#10b981;border:none;padding:12px;border-radius:12px;color:#064e3b;font-weight:800;cursor:pointer;">Accept</button><button id="reject-call-btn" style="flex:1;background:#ef4444;border:none;padding:12px;border-radius:12px;color:white;font-weight:700;cursor:pointer;">Decline</button></div>`;
        document.body.appendChild(callDialog);

        document.getElementById("accept-call-btn").onclick = async () => {
            if (callDialog) callDialog.remove(); callDialog = null;
            try {
                localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                peerConnection = new RTCPeerConnection(rtcConfig);
                localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
                peerConnection.ontrack = attachAudioTrack; 
                peerConnection.onicecandidate = (event) => { if (event.candidate) socket.emit("answer-call", { to: data.from, signal: { type: "ice", candidate: event.candidate } }); };
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal.sdp));
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                socket.emit("answer-call", { to: data.from, signal: { type: "answer", sdp: answer } });
                showActiveCallUI(() => socket.emit("end-call", { to: data.from }));
            } catch (e) { socket.emit("end-call", { to: data.from }); endLocalCall(); }
        };
        document.getElementById("reject-call-btn").onclick = () => { if (callDialog) callDialog.remove(); callDialog = null; socket.emit("end-call", { to: data.from }); };
    } else if (data.signal.type === "ice") {
        if (peerConnection && peerConnection.remoteDescription) { try { await peerConnection.addIceCandidate(new RTCIceCandidate(data.signal.candidate)); } catch(e){} }
    }
});

socket.on("call-accepted", async (signal) => {
    if (signal.type === "answer" && peerConnection) { await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp)); } 
    else if (signal.type === "ice" && peerConnection && peerConnection.remoteDescription) { try { await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch(e){} }
});
socket.on("call-ended", () => { endLocalCall(); });

function showActiveCallUI(endFn) {
    if (activeCallBtn) return;
    activeCallBtn = document.createElement("button");
    activeCallBtn.innerHTML = "📴 End Call";
    activeCallBtn.style.cssText = "position:fixed;top:80px;left:50%;transform:translateX(-50%);z-index:9999;background:#ef4444;color:white;border:none;padding:12px 24px;border-radius:30px;font-weight:bold;cursor:pointer;";
    document.body.appendChild(activeCallBtn);
    activeCallBtn.onclick = () => { endFn(); endLocalCall(); };
}

function endLocalCall() {
    if (activeCallBtn) { activeCallBtn.remove(); activeCallBtn = null; }
    if (callDialog) { callDialog.remove(); callDialog = null; }
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
}

function setupJoin(){
    if(currentUser.name){ $("join-screen").style.display="none"; socket.emit("profileReady",currentUser); }
    $("join-form").onsubmit=e=>{ e.preventDefault(); currentUser.name=cleanName($("nameInput").value); localStorage.setItem("koraput_name",currentUser.name);
        $("join-screen").style.display="none"; socket.emit("profileReady",currentUser);
    };
}

// ==========================================
// INITIALIZATION
// ==========================================
function initApp(){ 
    setupJoin(); 
    SmartDrive.init();
    startGPS(); 
    setupGoogleSearch(); 
}
if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", initApp); else initApp();
