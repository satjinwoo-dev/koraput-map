// ==========================================
// KORAPUT MAP - FINAL PRO CLIENT LOGIC
// ==========================================

const socket = io();

// 1. Initialize Map
const map = L.map("map", { zoomControl: false }).setView([18.8136, 82.7153], 13);

// ==========================================
// MAP STYLES SYSTEM
// ==========================================
const satelliteLayer = L.tileLayer(
    "https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}",
    {
        maxZoom: 20,
        subdomains: ["mt0", "mt1", "mt2", "mt3"],
        attribution: "&copy; Google Maps"
    }
);

const streetLayer = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
    }
);

const darkLayer = L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    {
        maxZoom: 20,
        attribution: "&copy; CARTO"
    }
);

let currentMapStyle = "satellite";
satelliteLayer.addTo(map);

// ==========================================
// GLOBAL STATE VARIABLES
// ==========================================
let ownMarker = null;
let accuracyCircle = null;
let firstLocationFix = true;

const friendMarkers = {};
const friendData = {}; 
let myCoords = null;
let currentWeatherData = "";

let currentUser = {
    name: localStorage.getItem("koraput_name") || "",
    avatar: localStorage.getItem("koraput_avatar") || "satyam.png"
};

// ==========================================
// UTILITY FUNCTIONS
// ==========================================
function escapeHTML(str) {
    return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function weatherEmoji(code) {
    if (code === 0) return "☀️";
    if ([1, 2, 3].includes(code)) return "⛅";
    if ([45, 48].includes(code)) return "🌫️";
    if ([51, 53, 55, 61, 63, 65].includes(code)) return "🌧️";
    if ([71, 73, 75].includes(code)) return "❄️";
    if ([95, 96, 99].includes(code)) return "⛈️";
    return "🌤️";
}

async function fetchWeather(lat, lng) {
    try {
        const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code`);
        const data = await res.json();
        return `${weatherEmoji(data.current.weather_code)} ${Math.round(data.current.temperature_2m)}°C`;
    } catch { return ""; }
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
    return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1);
}

function createOwnIcon(avatar) {
    return L.icon({
        iconUrl: escapeHTML(avatar),
        iconSize: [36, 36],
        iconAnchor: [18, 18],
        className: "avatar-icon own-live-avatar"
    });
}

function createFriendIcon(avatar) {
    return L.icon({
        iconUrl: escapeHTML(avatar),
        iconSize: [34, 34],
        iconAnchor: [17, 17],
        className: "avatar-icon friend-marker"
    });
}

function emitLocation() {
    if (myCoords && currentUser.name) {
        socket.emit("updateLocation", {
            name: currentUser.name,
            avatar: currentUser.avatar,
            lat: myCoords.lat,
            lng: myCoords.lng,
            weather: currentWeatherData
        });
    }
}

// ==========================================
// GPS TRACKER & ACCURACY RING
// ==========================================
if (navigator.geolocation) {
    navigator.geolocation.watchPosition(async (pos) => {
        const lat = Number(pos.coords.latitude);
        const lng = Number(pos.coords.longitude);
        const accuracy = Number(pos.coords.accuracy);

        myCoords = { lat, lng };

        if (Number.isFinite(accuracy) && accuracy > 0) {
            if (!accuracyCircle) {
                accuracyCircle = L.circle([lat, lng], {
                    radius: accuracy,
                    color: "#10b981",
                    weight: 1,
                    opacity: 0.7,
                    fillColor: "#10b981",
                    fillOpacity: 0.08,
                    interactive: false
                }).addTo(map);
            } else {
                accuracyCircle.setLatLng([lat, lng]);
                accuracyCircle.setRadius(accuracy);
            }
        }

        if (!ownMarker) {
            ownMarker = L.marker([lat, lng], { icon: createOwnIcon(currentUser.avatar) }).addTo(map);
            if (firstLocationFix) { map.setView([lat, lng], 16); firstLocationFix = false; }
        } else {
            ownMarker.setLatLng([lat, lng]);
        }

        currentWeatherData = await fetchWeather(lat, lng);
        const tempElem = document.getElementById("map-temp-display");
        if(tempElem && currentWeatherData) tempElem.textContent = currentWeatherData;

        if (currentWeatherData && ownMarker) {
            ownMarker.bindTooltip(currentWeatherData, { permanent: true, direction: 'right', className: 'weather-badge', offset: [15, 0] });
        }
        
        emitLocation();
    }, (err) => console.warn("GPS Error:", err), { enableHighAccuracy: true });
}

setInterval(emitLocation, 5000);

// ==========================================
// SYNC FRIENDS & STORE FRIEND DATA
// ==========================================
socket.on("friendMoved", (data) => {
    if (!data.id || data.name === currentUser.name) return;
    
    const weatherStr = typeof data.weather === "string" ? data.weather.slice(0, 50) : "";
    friendData[data.id] = {
        id: data.id,
        name: data.name,
        lat: data.lat,
        lng: data.lng,
        avatar: data.avatar,
        weather: weatherStr
    };

    let badge = weatherStr;
    if (myCoords) {
        const dist = haversineDistance(myCoords.lat, myCoords.lng, data.lat, data.lng);
        badge = `${badge ? badge + ' | ' : ''}📍 ${dist}km`;
    }

    if (!friendMarkers[data.id]) {
        friendMarkers[data.id] = L.marker([data.lat, data.lng], { icon: createFriendIcon(data.avatar || 'satyam.png') }).addTo(map);
    } else {
        friendMarkers[data.id].setLatLng([data.lat, data.lng]);
    }
    
    if (badge) {
        friendMarkers[data.id].bindTooltip(badge, { permanent: true, direction: 'right', className: 'weather-badge', offset: [15, 0] });
    }
});

socket.on("friendDisconnected", (id) => {
    if (friendMarkers[id]) { 
        map.removeLayer(friendMarkers[id]); 
        delete friendMarkers[id]; 
    }
    if (friendData[id]) {
        delete friendData[id];
    }
});

function renderMemoryPin(pin) {
    const icon = L.divIcon({
        className: 'custom-pin',
        html: `<div class="memory-pin-box"><img src="${escapeHTML(pin.image)}"></div>`,
        iconSize: [44, 44],
        iconAnchor: [22, 22]
    });
    L.marker([pin.lat, pin.lng], { icon }).addTo(map).bindPopup(`
        <div style="text-align:center; color:#111;">
            <b>📸 ${escapeHTML(pin.name)}</b><br><small style="color:#666">${escapeHTML(pin.time || '')}</small><br><br>
            <img src="${escapeHTML(pin.image)}" style="width:200px; border-radius:8px;">
        </div>
    `);
}

socket.on("loadMemoryPhotos", (pins) => pins.forEach(renderMemoryPin));
socket.on("newMemoryPin", renderMemoryPin);

// ==========================================
// MODULE SETUP FUNCTIONS
// ==========================================

function setupUserJoin() {
    const joinScreen = document.getElementById("join-screen");
    const joinForm = document.getElementById("join-form");
    const nameInput = document.getElementById("nameInput");
    const avatarInput = document.getElementById("avatarInput");
    const avatarLabelText = document.getElementById("avatar-label-text");
    const chatToggleBtn = document.getElementById("chat-toggle-btn");
    const headerAvatar = document.getElementById("header-avatar");

    if (!joinScreen) return;

    if (currentUser.name) {
        joinScreen.style.display = "none";
        if (chatToggleBtn) chatToggleBtn.style.display = "flex";
        if (headerAvatar) headerAvatar.src = currentUser.avatar;
    }

    if (avatarInput) {
        avatarInput.addEventListener("change", () => {
            if (avatarInput.files[0]) avatarLabelText.textContent = "Photo Selected ✓";
        });
    }

    if (joinForm) {
        joinForm.addEventListener("submit", (e) => {
            e.preventDefault();
            currentUser.name = nameInput.value.trim();
            localStorage.setItem("koraput_name", currentUser.name);

            if (avatarInput.files[0]) {
                const reader = new FileReader();
                reader.onload = () => {
                    currentUser.avatar = reader.result;
                    localStorage.setItem("koraput_avatar", currentUser.avatar);
                    completeJoin();
                };
                reader.readAsDataURL(avatarInput.files[0]);
            } else {
                completeJoin();
            }
        });
    }

    function completeJoin() {
        joinScreen.style.display = "none";
        if (chatToggleBtn) chatToggleBtn.style.display = "flex";
        if (headerAvatar) headerAvatar.src = currentUser.avatar;
        if (ownMarker) ownMarker.setIcon(createOwnIcon(currentUser.avatar));
        emitLocation();
        setTimeout(() => map.invalidateSize(), 300);
    }
}

function setupMemoryButton() {
    const memoryBtn = document.getElementById("memoryButton");
    const memoryInput = document.getElementById("memoryPhotoInput");
    if (!memoryBtn || !memoryInput) return;

    memoryBtn.addEventListener("click", () => {
        if (!myCoords) { alert("GPS location loading... please wait."); return; }
        memoryInput.click();
    });

    memoryInput.addEventListener("change", () => {
        const file = memoryInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            alert("📸 Tap anywhere on the map to pin this photo!");
            map.once("click", (e) => {
                socket.emit("uploadMemoryPhoto", {
                    name: currentUser.name,
                    lat: e.latlng.lat,
                    lng: e.latlng.lng,
                    image: reader.result,
                    time: new Date().toLocaleString()
                });
            });
        };
        reader.readAsDataURL(file);
        memoryInput.value = "";
    });
}

function setupChat() {
    const chatContainer = document.getElementById("chat-container");
    const chatMinimizeBtn = document.getElementById("chat-minimize-btn");
    const chatForm = document.getElementById("chatForm");
    const chatInput = document.getElementById("chatInput");
    const chatMessages = document.getElementById("chat-messages");
    const voiceBtn = document.getElementById("voiceButton");
    const sendBtn = document.getElementById("chat-send");
    const attachBtn = document.getElementById("chat-attach-btn");
    const attachMenu = document.getElementById("attachment-menu");
    const chatAttachment = document.getElementById("chatAttachment");
    const emojiBtn = document.getElementById("emojiButton");
    const emojiContainer = document.getElementById("emoji-picker-container");
    const emojiPicker = document.getElementById("emojiPicker");
    const chatToggleBtn = document.getElementById("chat-toggle-btn");

    if (!chatContainer) return;

    chatToggleBtn.addEventListener("click", () => { chatContainer.style.display = "flex"; chatToggleBtn.style.display = "none"; });
    chatMinimizeBtn.addEventListener("click", () => { chatContainer.style.display = "none"; chatToggleBtn.style.display = "flex"; });

    chatInput.addEventListener("input", () => {
        if (chatInput.value.trim()) { voiceBtn.style.display = "none"; sendBtn.style.display = "flex"; }
        else { voiceBtn.style.display = "flex"; sendBtn.style.display = "none"; }
    });

    attachBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        emojiContainer.style.display = "none";
        attachMenu.style.display = attachMenu.style.display === "flex" ? "none" : "flex";
    });

    emojiBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        attachMenu.style.display = "none";
        emojiContainer.style.display = emojiContainer.style.display === "block" ? "none" : "block";
    });

    document.addEventListener("click", () => {
        attachMenu.style.display = "none";
        emojiContainer.style.display = "none";
    });

    emojiPicker.addEventListener("emoji-click", (e) => {
        chatInput.value += e.detail.unicode;
        chatInput.focus();
        voiceBtn.style.display = "none";
        sendBtn.style.display = "flex";
    });

    document.getElementById("att-media").onclick = () => { chatAttachment.accept = "image/*,video/*"; chatAttachment.click(); };
    document.getElementById("att-doc").onclick = () => { chatAttachment.accept = ".pdf,.doc,.docx,.txt,.zip"; chatAttachment.click(); };
    document.getElementById("att-audio").onclick = () => { chatAttachment.accept = "audio/*"; chatAttachment.click(); };

    chatAttachment.addEventListener("change", () => {
        const file = chatAttachment.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) { alert("Max 5MB allowed"); chatAttachment.value = ""; return; }
        
        let type = "document";
        if (file.type.startsWith("image/")) type = "image";
        else if (file.type.startsWith("video/")) type = "video";
        else if (file.type.startsWith("audio/")) type = "audio";

        const reader = new FileReader();
        reader.onload = () => socket.emit("chatMessage", { name: currentUser.name, type, data: reader.result });
        reader.readAsDataURL(file);
        chatAttachment.value = "";
    });

    chatForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = chatInput.value.trim();
        if (!text) return;
        socket.emit("chatMessage", { name: currentUser.name, type: "text", data: text });
        chatInput.value = "";
        voiceBtn.style.display = "flex";
        sendBtn.style.display = "none";
    });

    socket.on("chatMessage", (msg) => {
        const div = document.createElement("div");
        div.className = `chat-message ${msg.name === currentUser.name ? 'msg-mine' : 'msg-theirs'}`;
        let html = `<div class="msg-sender">${escapeHTML(msg.name)}</div>`;

        if (msg.type === "text") html += `<div>${escapeHTML(msg.data)}</div>`;
        else if (msg.type === "image") html += `<img src="${msg.data}" style="max-width:100%; border-radius:6px;">`;
        else if (msg.type === "video") html += `<video controls src="${msg.data}" style="max-width:100%; border-radius:6px;"></video>`;
        else if (msg.type === "audio") html += `<audio controls src="${msg.data}" style="max-width:100%; height:36px;"></audio>`;
        else if (msg.type === "document") html += `<a href="${msg.data}" download="file" style="color:#10b981; text-decoration:none; font-weight:600;">📄 Download File</a>`;

        div.innerHTML = html;
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
}

function setupVoiceRecorder() {
    const voiceBtn = document.getElementById("voiceButton");
    if (!voiceBtn) return;
    
    let recorder, chunks = [];
    voiceBtn.addEventListener("click", async () => {
        if (recorder && recorder.state === "recording") {
            recorder.stop();
            voiceBtn.style.background = "transparent";
            voiceBtn.style.color = "#8d9ba2";
            voiceBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>`;
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            recorder = new MediaRecorder(stream);
            chunks = [];
            recorder.ondataavailable = e => chunks.push(e.data);
            recorder.onstop = () => {
                stream.getTracks().forEach(t => t.stop());
                const blob = new Blob(chunks, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.onload = () => socket.emit("chatMessage", { name: currentUser.name, type: "audio", data: reader.result });
                reader.readAsDataURL(blob);
            };
            recorder.start();
            voiceBtn.style.background = "#ef4444";
            voiceBtn.style.color = "#fff";
            voiceBtn.innerHTML = "⏹️";
        } catch { alert("Microphone access denied."); }
    });
}

function setupMapControls() {
    const locationBtn = document.getElementById("my-location-btn");
    const compassBtn = document.getElementById("compass-btn");
    const styleBtn = document.getElementById("map-style-btn");
    const styleMenu = document.getElementById("map-style-menu");

    /* MY LOCATION */
    if (locationBtn) {
        locationBtn.addEventListener("click", () => {
            if (!myCoords) {
                alert("Waiting for GPS location...");
                return;
            }
            map.flyTo(
                [myCoords.lat, myCoords.lng],
                Math.max(map.getZoom(), 16),
                { animate: true, duration: 0.8 }
            );
        });
    }

    /* COMPASS */
    if (compassBtn) {
        compassBtn.addEventListener("click", () => {
            map.setView(map.getCenter(), map.getZoom(), { animate: true });
        });
    }

    /* MAP STYLE MENU */
    if (styleBtn && styleMenu) {
        styleBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            styleMenu.style.display = styleMenu.style.display === "flex" ? "none" : "flex";
        });

        styleMenu.addEventListener("click", (event) => {
            const button = event.target.closest("[data-style]");
            if (!button) return;
            const style = button.dataset.style;
            changeMapStyle(style);
            styleMenu.style.display = "none";
        });

        document.addEventListener("click", (event) => {
            if (!styleMenu.contains(event.target) && event.target !== styleBtn) {
                styleMenu.style.display = "none";
            }
        });
    }
    
    /* HARDWARE COMPASS */
    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientation', (e) => {
            const icon = document.getElementById('compass-icon');
            if (icon && e.webkitCompassHeading) {
                icon.style.transform = `rotate(${-e.webkitCompassHeading}deg)`;
            } else if (icon && e.alpha) {
                icon.style.transform = `rotate(${e.alpha}deg)`;
            }
        });
    }
}

function changeMapStyle(style) {
    if (style === currentMapStyle) return;

    if (currentMapStyle === "satellite") {
        map.removeLayer(satelliteLayer);
    }
    if (currentMapStyle === "street") {
        map.removeLayer(streetLayer);
    }
    if (currentMapStyle === "dark") {
        map.removeLayer(darkLayer);
    }

    if (style === "satellite") {
        satelliteLayer.addTo(map);
    }
    if (style === "street") {
        streetLayer.addTo(map);
    }
    if (style === "dark") {
        darkLayer.addTo(map);
    }

    currentMapStyle = style;

    document.querySelectorAll("#map-style-menu button").forEach(button => {
        button.classList.toggle("active", button.dataset.style === style);
    });
}

function setupEverything() {
    setupUserJoin();
    setupMemoryButton();
    setupChat();
    setupVoiceRecorder();
    setupMapControls();
}

// ==========================================
// ACTIVATE ALL MODULES
// ==========================================
setupEverything();
