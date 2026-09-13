// ==========================================
// KORAPUT MAP - APP.JS (OPTION A STABLE)
// ==========================================

const socket = io();
const map = L.map("map", { zoomControl: false }).setView([18.8136, 82.7153], 13);

// 1. Google Earth Satellite View
L.tileLayer("https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}", {
    maxZoom: 20,
    subdomains: ["mt0", "mt1", "mt2", "mt3"],
    attribution: "&copy; Google Maps"
}).addTo(map);

let ownMarker = null;
let firstLocationFix = true;
const friendMarkers = {};
const memoryMarkers = [];

let lastWeatherUpdate = 0;
const WEATHER_INTERVAL = 10 * 60 * 1000;
const defaultAvatar = "satyam.png";

// ==========================================
// MOBILE UI FIXES (Injected CSS for Leaflet Controls)
// ==========================================
const mobileFixStyles = document.createElement('style');
mobileFixStyles.innerHTML = `
    .map-upload-control { 
        display: block !important; width: 45px !important; height: 45px !important; 
        line-height: 45px !important; font-size: 24px !important; text-align: center !important; 
        text-decoration: none !important; background: #111b21 !important; color: #fff !important; 
        border-radius: 50% !important; border: 2px solid #00a884 !important;
        margin-top: env(safe-area-inset-top, 15px) !important; margin-left: 15px !important;
        box-shadow: 0 5px 20px #0008 !important; cursor: pointer;
    }
    .weather-badge {
        background: #111b21; border: 1px solid #00a884; color: white; font-weight: bold; border-radius: 8px;
    }
    .leaflet-control-container .leaflet-top { z-index: 10000; }
`;
document.head.appendChild(mobileFixStyles);

// ==========================================
// UTILITIES
// ==========================================
function escapeHTML(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function isSafeDataUrl(value, expectedPrefix) {
    if (typeof value !== "string") return false;
    const regex = new RegExp("^data:" + expectedPrefix.replace("/", "\\/") + "[a-zA-Z0-9.+-]+;base64,", "i");
    return regex.test(value);
}

function isSafeImageSource(value) {
    if (typeof value !== "string") return false;
    if (isSafeDataUrl(value, "image/")) return true;
    try {
        const url = new URL(value, window.location.href);
        return (url.protocol === "https:" || url.protocol === "http:");
    } catch { return false; }
}

function getSafeImageSource(value) {
    if (typeof value === "string" && !value.startsWith("data:") && !value.startsWith("http")) return value; 
    return isSafeImageSource(value) ? value : defaultAvatar;
}

function weatherEmoji(code) {
    if (code === 0) return "☀️";
    if ([1, 2, 3].includes(code)) return "⛅";
    if ([45, 48].includes(code)) return "🌫️";
    if ([51, 53, 55, 56, 57].includes(code)) return "🌦️";
    if ([61, 63, 65, 66, 67].includes(code)) return "🌧️";
    if ([71, 73, 75, 77].includes(code)) return "❄️";
    if ([80, 81, 82].includes(code)) return "🌦️";
    if ([85, 86].includes(code)) return "🌨️";
    if ([95, 96, 99].includes(code)) return "⛈️";
    return "🌡️";
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getWeather(lat, lng) {
    const now = Date.now();
    if (now - lastWeatherUpdate < WEATHER_INTERVAL) return "";
    lastWeatherUpdate = now;

    try {
        const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&current=temperature_2m,weather_code`);
        if (!response.ok) throw new Error("Weather request failed");
        const data = await response.json();
        const temperature = data?.current?.temperature_2m;
        const code = data?.current?.weather_code;

        if (typeof temperature !== "number" || typeof code !== "number") return "";
        return `${weatherEmoji(code)} ${Math.round(temperature)}°C`;
    } catch (error) { return ""; }
}

function createOwnIcon(avatar) {
    return L.icon({
        iconUrl: getSafeImageSource(avatar),
        iconSize: [45, 45],
        iconAnchor: [22, 22],
        className: "avatar-icon"
    });
}

function createFriendIcon(avatar) {
    return L.icon({
        iconUrl: getSafeImageSource(avatar),
        iconSize: [42, 42],
        iconAnchor: [21, 21],
        className: "avatar-icon friend-marker"
    });
}

// ==========================================
// USER STATE & HEARTBEAT
// ==========================================
function getStoredUser() {
    try { const raw = localStorage.getItem("koraputUser"); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function saveStoredUser(user) {
    try { localStorage.setItem("koraputUser", JSON.stringify(user)); } catch (error) {}
}

let currentUser = getStoredUser() || { name: "User", avatar: defaultAvatar };
let currentWeatherData = "";
let myCoords = null; 

function emitLocation(lat, lng, weather = "") {
    socket.emit("updateLocation", { name: currentUser.name, avatar: currentUser.avatar, lat, lng, weather });
}

// Heartbeat for stationary users
setInterval(() => {
    if (myCoords && currentUser.name !== "User") {
        emitLocation(myCoords.lat, myCoords.lng, currentWeatherData);
    }
}, 5000);

// ==========================================
// GEOLOCATION TRACKING
// ==========================================
function handleLocation(position) {
    const lat = Number(position.coords.latitude);
    const lng = Number(position.coords.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
    myCoords = { lat, lng };

    if (!ownMarker) {
        ownMarker = L.marker([lat, lng], { icon: createOwnIcon(currentUser.avatar) }).addTo(map);
        if (firstLocationFix) { map.setView([lat, lng], 16); firstLocationFix = false; }
    } else {
        ownMarker.setLatLng([lat, lng]);
    }

    emitLocation(lat, lng, currentWeatherData);

    getWeather(lat, lng).then((weather) => {
        if (!weather) return;
        currentWeatherData = weather;
        emitLocation(lat, lng, weather);
        if (ownMarker) ownMarker.bindTooltip(weather, { permanent: true, direction: 'right', className: 'weather-badge', offset: [20, 0] });
    });
}

if ("geolocation" in navigator) {
    navigator.geolocation.watchPosition(handleLocation, (err) => console.warn(err), { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
}

// ==========================================
// FRIEND SYNCING
// ==========================================
socket.on("friendMoved", (data) => {
    if (!data || typeof data !== "object") return;

    const id = String(data.id || "");
    const lat = Number(data.lat);
    const lng = Number(data.lng);

    if (!id || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;

    const name = typeof data.name === "string" ? data.name.slice(0, 40) : "Friend";
    const avatar = getSafeImageSource(data.avatar);
    const weather = typeof data.weather === "string" ? data.weather.slice(0, 50) : "";

    let badgeText = weather;
    if (myCoords) {
        const distance = haversineDistance(myCoords.lat, myCoords.lng, lat, lng);
        badgeText = `${weather ? weather + ' | ' : ''}📍 ${distance < 1 ? Math.round(distance * 1000) + 'm' : distance.toFixed(1) + 'km'}`;
    }

    if (!friendMarkers[id]) {
        friendMarkers[id] = L.marker([lat, lng], { icon: createFriendIcon(avatar) }).addTo(map);
    } else {
        friendMarkers[id].setLatLng([lat, lng]);
        friendMarkers[id].setIcon(createFriendIcon(avatar));
    }

    if (badgeText) friendMarkers[id].bindTooltip(badgeText, { permanent: true, direction: 'right', className: 'weather-badge', offset: [20, 0] });
});

socket.on("friendDisconnected", (id) => {
    if (!id) return;
    if (friendMarkers[id]) { map.removeLayer(friendMarkers[id]); delete friendMarkers[id]; }
});

// ==========================================
// MEMORY PHOTO SYSTEM (LEAFLET CONTROL)
// ==========================================
function renderMemoryPhoto(pin) {
    if (!pin || typeof pin !== "object") return;
    const lat = Number(pin.lat);
    const lng = Number(pin.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
    if (!isSafeDataUrl(pin.image, "image/")) return;

    const name = typeof pin.name === "string" ? pin.name.slice(0, 40) : "Memory";
    const time = typeof pin.time === "string" ? pin.time.slice(0, 100) : "";
    const image = escapeHTML(pin.image);

    const memoryIcon = L.divIcon({
        className: "memory-pin-icon",
        html: `<div style="width:42px; height:42px; border-radius:50%; border:3px solid #00a884; overflow:hidden; background:#ffffff; box-shadow:0 2px 8px rgba(0,0,0,0.4);">
                <img src="${image}" alt="Memory" style="width:100%; height:100%; object-fit:cover;">
            </div>`,
        iconSize: [42, 42], iconAnchor: [21, 21]
    });

    const marker = L.marker([lat, lng], { icon: memoryIcon }).addTo(map);
    marker.bindPopup(`
        <div style="text-align:center; padding: 2px;">
            <b style="color: black;">📸 ${escapeHTML(name)}</b><br>
            ${time ? `<small style="color: gray;">${escapeHTML(time)}</small><br><br>` : "<br>"}
            <img src="${image}" alt="Memory photo" style="width:200px; max-width:100%; border-radius:8px;">
        </div>
    `);
    memoryMarkers.push(marker);
}

socket.on("loadMemoryPhotos", (photos) => {
    if (!Array.isArray(photos)) return;
    photos.forEach(renderMemoryPhoto);
});
socket.on("newMemoryPin", renderMemoryPhoto);

function setupMemoryButton() {
    const UploadControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd: function () {
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
            const button = L.DomUtil.create('a', 'map-upload-control', container);
            button.innerHTML = '📸';
            button.href = '#';
            button.title = 'Upload Memory to Map';
            
            // Generate invisible file input specifically for map uploads
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.style.display = 'none';
            container.appendChild(fileInput);

            L.DomEvent.on(button, 'click', (e) => {
                L.DomEvent.stopPropagation();
                L.DomEvent.preventDefault();
                if (!myCoords) { alert("Please wait for your GPS location to load first."); return; }
                fileInput.click();
            });

            fileInput.addEventListener("change", () => {
                const file = fileInput.files?.[0];
                if (!file) return;
                if (!file.type.startsWith("image/")) { alert("Please select an image."); fileInput.value = ""; return; }
                if (file.size > 5 * 1024 * 1024) { alert("Image must be 5 MB or smaller."); fileInput.value = ""; return; }

                const reader = new FileReader();
                reader.onload = () => {
                    if (!isSafeDataUrl(reader.result, "image/")) return;
                    alert("📸 Click anywhere on the map to pin your memory photo!");
                    map.once("click", (mapEvent) => {
                        socket.emit("uploadMemoryPhoto", {
                            name: currentUser.name,
                            lat: mapEvent.latlng.lat,
                            lng: mapEvent.latlng.lng,
                            image: reader.result,
                            time: new Date().toLocaleString()
                        });
                    });
                };
                reader.readAsDataURL(file);
                fileInput.value = "";
            });

            return container;
        }
    });
    map.addControl(new UploadControl());
}

// ==========================================
// STARTUP & JOIN FLOW
// ==========================================
function launchAppUI() {
    const joinScreen = document.getElementById('join-screen');
    if (joinScreen) joinScreen.style.display = 'none';
    
    const chatToggleBtn = document.getElementById('chat-toggle-btn');
    if (chatToggleBtn) chatToggleBtn.style.display = 'flex';
    
    setTimeout(() => map.invalidateSize(), 300);
}

function finalizeJoin() {
    saveStoredUser(currentUser);
    if (ownMarker) {
        ownMarker.setIcon(createOwnIcon(currentUser.avatar));
        if(currentWeatherData) ownMarker.bindTooltip(currentWeatherData, { permanent: true, direction: 'right', className: 'weather-badge', offset: [20, 0] });
        const location = ownMarker.getLatLng();
        emitLocation(location.lat, location.lng, currentWeatherData);
    }
    launchAppUI();
}

function setupUserJoin() {
    if (currentUser && currentUser.name && currentUser.name !== "User" && getStoredUser()) {
        launchAppUI();
    }

    const joinForm = document.getElementById('join-form');
    if (joinForm) {
        joinForm.addEventListener("submit", (e) => {
            e.preventDefault();

            const nameInput = document.getElementById("nameInput");
            if (nameInput && nameInput.value.trim() !== "") currentUser.name = nameInput.value.trim().slice(0, 40);

            const fileInput = document.getElementById("avatarInput");
            const file = fileInput?.files?.[0];

            if (file) {
                if (file.size > 2 * 1024 * 1024) { alert("Avatar must be 2 MB or smaller."); return; }
                const reader = new FileReader();
                reader.onload = () => {
                    if (isSafeDataUrl(reader.result, "image/")) currentUser.avatar = reader.result;
                    finalizeJoin();
                };
                reader.readAsDataURL(file);
            } else { finalizeJoin(); }
        });
    }
}

// ==========================================
// WHATSAPP CHAT LOGIC
// ==========================================
function getChatElements() {
    return {
        form: document.getElementById("chatForm"),
        input: document.getElementById("chatInput"),
        messages: document.getElementById("chat-messages"),
        attachmentInput: document.getElementById("chatAttachment"),
        emojiButton: document.getElementById("emojiButton"),
        emojiPicker: document.getElementById("emojiPicker"),
        emojiContainer: document.getElementById("emoji-picker-container"),
        voiceButton: document.getElementById("voiceButton"),
        container: document.getElementById("chat-container"),
        toggleBtn: document.getElementById("chat-toggle-btn"),
        minimizeBtn: document.getElementById("chat-minimize-btn"),
        attachMenuBtn: document.getElementById("chat-attach-btn"),
        attachMenu: document.getElementById("attachment-menu"),
        sendBtn: document.getElementById("chat-send")
    };
}

function addChatMessage(msg) {
    const { messages } = getChatElements();
    if (!messages || !msg || typeof msg !== "object") return;
    if (typeof msg.name !== "string" || typeof msg.type !== "string" || typeof msg.data !== "string") return;

    const allowedTypes = ["text", "image", "video", "audio", "document"];
    if (!allowedTypes.includes(msg.type)) return;

    const wrapper = document.createElement("div");
    wrapper.className = "chat-message";
    
    wrapper.style.alignSelf = msg.name === currentUser.name ? "flex-end" : "flex-start";
    wrapper.style.background = msg.name === currentUser.name ? "#005c4b" : "#202c33";
    wrapper.style.marginLeft = msg.name === currentUser.name ? "auto" : "0";
    wrapper.style.marginRight = msg.name === currentUser.name ? "0" : "auto";

    const sender = document.createElement("strong");
    sender.textContent = msg.name.slice(0, 40);
    sender.style.color = msg.name === currentUser.name ? "#25d366" : "#8de2cd";

    const content = document.createElement("div");

    if (msg.type === "text") {
        const text = msg.data.slice(0, 5000);
        const spotifyRegex = /https:\/\/open\.spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/;
        const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        
        if (spotifyRegex.test(text)) {
            const match = text.match(spotifyRegex);
            content.innerHTML = `<div style="margin-top: 5px; width: 280px; max-width: 100%;"><iframe style="border-radius:12px; display:block;" src="https://open.spotify.com/embed/${match[1]}/${match[2]}?utm_source=generator&theme=0" width="100%" height="152" frameBorder="0" allowfullscreen="" loading="lazy"></iframe></div>`;
        } else if (youtubeRegex.test(text)) {
            const match = text.match(youtubeRegex);
            content.innerHTML = `<div style="margin-top: 5px; width: 280px; max-width: 100%; position: relative; padding-bottom: 56.25%; height: 0;"><iframe style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border:0; border-radius: 8px;" src="https://www.youtube.com/embed/${match[1]}" allowfullscreen=""></iframe></div>`;
        } else {
            content.textContent = text;
        }
    } else if (msg.type === "image") {
        if (!isSafeDataUrl(msg.data, "image/")) return;
        content.innerHTML = `<img src="${msg.data}" style="max-width: 260px; width: 100%; border-radius: 8px; margin-top: 5px;">`;
    } else if (msg.type === "video") {
        if (!isSafeDataUrl(msg.data, "video/")) return;
        content.innerHTML = `<video controls src="${msg.data}" style="max-width: 260px; width: 100%; border-radius: 8px; margin-top: 5px;"></video>`;
    } else if (msg.type === "audio") {
        if (!isSafeDataUrl(msg.data, "audio/")) return;
        content.innerHTML = `<audio controls src="${msg.data}" style="max-width: 240px; width: 100%; height: 40px; margin-top: 5px;"></audio>`;
    } else if (msg.type === "document") {
        if (!msg.data.startsWith("data:")) return;
        content.innerHTML = `<a href="${msg.data}" download="attachment" style="display: block; margin-top: 5px; padding: 10px; background: #2a3942; color: white; text-decoration: none; border-radius: 8px; text-align: center;">📎 Download File</a>`;
    }

    wrapper.appendChild(sender);
    wrapper.appendChild(content);
    
    const flexWrapper = document.createElement("div");
    flexWrapper.style.display = "flex"; flexWrapper.style.flexDirection = "column"; flexWrapper.style.width = "100%";
    flexWrapper.appendChild(wrapper);

    messages.appendChild(flexWrapper);
    messages.scrollTop = messages.scrollHeight;
}

socket.on("chatMessage", addChatMessage);

function setupChat() {
    const { form, input, attachmentInput, emojiButton, emojiPicker, emojiContainer, container, toggleBtn, minimizeBtn, attachMenuBtn, attachMenu, sendBtn, voiceButton } = getChatElements();

    if (toggleBtn && container) toggleBtn.addEventListener('click', () => { container.style.display = 'flex'; toggleBtn.style.display = 'none'; });
    if (minimizeBtn && container && toggleBtn) minimizeBtn.addEventListener('click', () => { container.style.display = 'none'; toggleBtn.style.display = 'flex'; });

    if (attachMenuBtn && attachMenu) {
        attachMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if(emojiContainer) emojiContainer.style.display = 'none';
            attachMenu.style.display = attachMenu.style.display === 'flex' ? 'none' : 'flex';
        });
    }

    const clickProxy = (id, accept) => {
        const btn = document.getElementById(id);
        if(btn) btn.addEventListener('click', () => {
            if(attachmentInput) { attachmentInput.accept = accept; attachmentInput.click(); }
            if(attachMenu) attachMenu.style.display = 'none';
        });
    };
    clickProxy('att-media', 'image/*,video/*');
    clickProxy('att-doc', '.pdf,.docx,.txt,.zip');
    clickProxy('att-audio', 'audio/*');
    clickProxy('att-cam', 'image/*,video/*');

    if (input && voiceButton && sendBtn) {
        input.addEventListener('input', () => {
            if (input.value.trim().length > 0) {
                voiceButton.style.display = 'none'; sendBtn.style.display = 'flex';
            } else {
                voiceButton.style.display = 'flex'; sendBtn.style.display = 'none';
            }
        });
    }

    if (form && input) {
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            const text = input.value.trim();
            if (!text) return;
            socket.emit("chatMessage", { name: currentUser.name, type: "text", data: text.slice(0, 5000) });
            input.value = "";
            if (voiceButton && sendBtn) { voiceButton.style.display = 'flex'; sendBtn.style.display = 'none'; }
        });
    }

    if (attachmentInput) {
        attachmentInput.addEventListener("change", () => {
            const file = attachmentInput.files?.[0];
            if (!file) return;

            if (file.size > 5 * 1024 * 1024) { alert("Attachment must be 5 MB or smaller."); attachmentInput.value = ""; return; }

            let type = "document";
            if (file.type.startsWith("image/")) type = "image";
            else if (file.type.startsWith("video/")) type = "video";
            else if (file.type.startsWith("audio/")) type = "audio";

            const reader = new FileReader();
            reader.onload = () => {
                if (typeof reader.result === "string" && reader.result.startsWith("data:")) {
                    socket.emit("chatMessage", { name: currentUser.name, type, data: reader.result });
                }
            };
            reader.readAsDataURL(file);
            attachmentInput.value = "";
        });
    }

    if (emojiButton && emojiContainer) {
        emojiButton.addEventListener("click", (e) => {
            e.stopPropagation();
            if(attachMenu) attachMenu.style.display = 'none';
            emojiContainer.style.display = emojiContainer.style.display === "none" ? "block" : "none";
        });
        
        if (emojiPicker) {
            emojiPicker.addEventListener('emoji-click', event => {
                input.value += event.detail.unicode;
                input.focus();
                if (voiceButton && sendBtn) { voiceButton.style.display = 'none'; sendBtn.style.display = 'flex'; }
            });
        }
    }

    document.addEventListener('click', (e) => {
        if (attachMenu && !attachMenu.contains(e.target) && e.target !== attachMenuBtn) attachMenu.style.display = 'none';
        if (emojiContainer && !emojiContainer.contains(e.target) && e.target !== emojiButton) emojiContainer.style.display = 'none';
    });
}

function setupVoiceRecorder() {
    const { voiceButton } = getChatElements();
    if (!voiceButton) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { voiceButton.disabled = true; return; }

    let recorder = null;
    let chunks = [];

    voiceButton.addEventListener("click", async () => {
        if (recorder && recorder.state === "recording") {
            recorder.stop();
            voiceButton.style.background = 'transparent'; voiceButton.style.color = '#111b21'; voiceButton.textContent = '🎤';
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"];
            const mimeType = types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
            
            recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
            chunks = [];

            recorder.ondataavailable = (event) => { if (event.data && event.data.size > 0) chunks.push(event.data); };
            recorder.onstop = () => {
                stream.getTracks().forEach((track) => track.stop());
                const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
                if (blob.size > 5 * 1024 * 1024) { alert("Voice message is too large."); return; }

                const reader = new FileReader();
                reader.onload = () => {
                    if (isSafeDataUrl(reader.result, "audio/")) socket.emit("chatMessage", { name: currentUser.name, type: "audio", data: reader.result });
                };
                reader.readAsDataURL(blob);
            };

            recorder.start();
            voiceButton.style.background = '#f15c6d'; voiceButton.style.color = 'white'; voiceButton.textContent = '⏹️';
        } catch (error) { alert("Microphone permission denied."); }
    });
}

function setupEverything() {
    setupUserJoin();
    setupMemoryButton();
    setupChat();
    setupVoiceRecorder();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setupEverything);
else setupEverything();
