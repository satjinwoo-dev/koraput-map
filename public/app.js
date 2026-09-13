// ==========================================
// KORAPUT MAP - FINAL LOCKED CLIENT LOGIC
// ==========================================

const socket = io();
const map = L.map("map", { zoomControl: false }).setView([18.8136, 82.7153], 13);

// Esri Satellite (Clean, Stable & No Billing Key Required)
L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "Tiles © Esri"
}).addTo(map);

let ownMarker = null;
let firstLocationFix = true;
const friendMarkers = {};
let myCoords = null;
let currentWeatherData = "";

let currentUser = {
    name: localStorage.getItem("koraput_name") || "",
    avatar: localStorage.getItem("koraput_avatar") || "satyam.png"
};

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

// Markers
function makeAvatarIcon(src, isFriend = false) {
    return L.divIcon({
        className: 'custom-icon',
        html: `<div class="avatar-marker ${isFriend ? 'friend' : ''}"><img src="${escapeHTML(src)}"></div>`,
        iconSize: [44, 44],
        iconAnchor: [22, 22]
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

// GPS Tracker
if (navigator.geolocation) {
    navigator.geolocation.watchPosition(async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        myCoords = { lat, lng };

        if (!ownMarker) {
            ownMarker = L.marker([lat, lng], { icon: makeAvatarIcon(currentUser.avatar) }).addTo(map);
            if (firstLocationFix) { map.setView([lat, lng], 16); firstLocationFix = false; }
        } else {
            ownMarker.setLatLng([lat, lng]);
        }

        currentWeatherData = await fetchWeather(lat, lng);
        if (currentWeatherData && ownMarker) {
            ownMarker.bindTooltip(currentWeatherData, { permanent: true, direction: 'right', className: 'weather-badge', offset: [15, 0] });
        }
        emitLocation();
    }, (err) => console.warn(err), { enableHighAccuracy: true });
}

setInterval(emitLocation, 5000);

// Sync Friends
socket.on("friendMoved", (data) => {
    if (!data.id || data.name === currentUser.name) return;
    let badge = data.weather || "";
    if (myCoords) {
        const dist = haversineDistance(myCoords.lat, myCoords.lng, data.lat, data.lng);
        badge = `${badge ? badge + ' | ' : ''}📍 ${dist}km`;
    }

    if (!friendMarkers[data.id]) {
        friendMarkers[data.id] = L.marker([data.lat, data.lng], { icon: makeAvatarIcon(data.avatar || 'satyam.png', true) }).addTo(map);
    } else {
        friendMarkers[data.id].setLatLng([data.lat, data.lng]);
    }
    if (badge) friendMarkers[data.id].bindTooltip(badge, { permanent: true, direction: 'right', className: 'weather-badge', offset: [15, 0] });
});

socket.on("friendDisconnected", (id) => {
    if (friendMarkers[id]) { map.removeLayer(friendMarkers[id]); delete friendMarkers[id]; }
});

// Memory Pins
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

// Setup Memory Upload Button
const memoryBtn = document.getElementById("memoryButton");
const memoryInput = document.getElementById("memoryPhotoInput");

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

// Join Screen
const joinScreen = document.getElementById("join-screen");
const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("nameInput");
const avatarInput = document.getElementById("avatarInput");
const avatarLabelText = document.getElementById("avatar-label-text");
const chatToggleBtn = document.getElementById("chat-toggle-btn");
const headerAvatar = document.getElementById("header-avatar");

if (currentUser.name) {
    joinScreen.style.display = "none";
    chatToggleBtn.style.display = "flex";
    headerAvatar.src = currentUser.avatar;
}

avatarInput.addEventListener("change", () => {
    if (avatarInput.files[0]) avatarLabelText.textContent = "Photo Selected ✓";
});

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

function completeJoin() {
    joinScreen.style.display = "none";
    chatToggleBtn.style.display = "flex";
    headerAvatar.src = currentUser.avatar;
    if (ownMarker) ownMarker.setIcon(makeAvatarIcon(currentUser.avatar));
    emitLocation();
    setTimeout(() => map.invalidateSize(), 300);
}

// Chat System
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
    if (!file || file.size > 5 * 1024 * 1024) { alert("Max 5MB allowed"); return; }
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
    div.className = `msg-bubble ${msg.name === currentUser.name ? 'msg-mine' : 'msg-theirs'}`;
    let html = `<div class="msg-sender">${escapeHTML(msg.name)}</div>`;

    if (msg.type === "text") html += `<div>${escapeHTML(msg.data)}</div>`;
    else if (msg.type === "image") html += `<img src="${msg.data}" style="max-width:100%; border-radius:6px;">`;
    else if (msg.type === "video") html += `<video controls src="${msg.data}" style="max-width:100%; border-radius:6px;"></video>`;
    else if (msg.type === "audio") html += `<audio controls src="${msg.data}" style="max-width:100%; height:36px;"></audio>`;
    else if (msg.type === "document") html += `<a href="${msg.data}" download="file" style="color:#53bdeb; text-decoration:none;">📄 Download Attachment</a>`;

    div.innerHTML = html;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
});

// Voice Note Recording
let recorder, chunks = [];
voiceBtn.addEventListener("click", async () => {
    if (recorder && recorder.state === "recording") {
        recorder.stop();
        voiceBtn.style.background = "#00a884";
        voiceBtn.textContent = "🎤";
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
        voiceBtn.style.background = "#ea4335";
        voiceBtn.textContent = "⏹️";
    } catch { alert("Microphone access denied."); }
});
