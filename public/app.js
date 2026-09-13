// ==========================================
// KORAPUT MAP - OPTION A LEAFLET CLIENT
// ==========================================

const socket = io();
const map = L.map("map", { zoomControl: false }).setView([18.8136, 82.7153], 13);

// High-Res Satellite View (Works without billing)
L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "Tiles © Esri"
}).addTo(map);

let ownMarker = null;
let firstLocationFix = true;
const friendMarkers = {};
const memoryMarkers = [];

let lastWeatherUpdate = 0;
const WEATHER_INTERVAL = 10 * 60 * 1000;
const defaultAvatar = "satyam.png";

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
    } catch {
        return false;
    }
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
    } catch {
        return "";
    }
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getStoredUser() {
    try {
        const raw = localStorage.getItem("koraputUser");
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function saveStoredUser(user) {
    try { localStorage.setItem("koraputUser", JSON.stringify(user)); } catch {}
}

let currentUser = getStoredUser() || { name: "User", avatar: defaultAvatar };
let currentWeatherData = "";
let myCoords = null;

function createCustomMarkerIcon(imageSrc, isFriend = false) {
    return L.divIcon({
        className: 'custom-leaflet-marker',
        html: `<div class="avatar-marker ${isFriend ? 'friend' : ''}"><img src="${escapeHTML(imageSrc)}"></div>`,
        iconSize: [45, 45],
        iconAnchor: [22, 22]
    });
}

function emitLocation(lat, lng, weather = "") {
    socket.emit("updateLocation", {
        name: currentUser.name,
        avatar: currentUser.avatar,
        lat, lng, weather
    });
}

function handleLocation(position) {
    const lat = Number(position.coords.latitude);
    const lng = Number(position.coords.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
    myCoords = { lat, lng };

    if (!ownMarker) {
        ownMarker = L.marker([lat, lng], { icon: createCustomMarkerIcon(getSafeImageSource(currentUser.avatar)) }).addTo(map);
        if (firstLocationFix) {
            map.setView([lat, lng], 16);
            firstLocationFix = false;
        }
    } else {
        ownMarker.setLatLng([lat, lng]);
    }

    emitLocation(lat, lng, currentWeatherData);

    getWeather(lat, lng).then(weather => {
        if (!weather) return;
        currentWeatherData = weather;
        emitLocation(lat, lng, weather);
        if (ownMarker) {
            ownMarker.bindTooltip(weather, { permanent: true, direction: 'right', className: 'weather-badge', offset: [20, 0] });
        }
    });
}

if ("geolocation" in navigator) {
    navigator.geolocation.watchPosition(handleLocation, err => console.warn("GPS error:", err), { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
}

setInterval(() => {
    if (myCoords && currentUser.name !== "User") {
        emitLocation(myCoords.lat, myCoords.lng, currentWeatherData);
    }
}, 5000);

socket.on("friendMoved", data => {
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
        friendMarkers[id] = L.marker([lat, lng], { icon: createCustomMarkerIcon(avatar, true) }).addTo(map);
    } else {
        friendMarkers[id].setLatLng([lat, lng]);
    }

    if (badgeText) {
        friendMarkers[id].bindTooltip(badgeText, { permanent: true, direction: 'right', className: 'weather-badge', offset: [20, 0] });
    }
});

socket.on("friendDisconnected", id => {
    if (!id) return;
    if (friendMarkers[id]) {
        map.removeLayer(friendMarkers[id]);
        delete friendMarkers[id];
    }
});

function renderMemoryPhoto(pin) {
    if (!pin || typeof pin !== "object") return;
    const lat = Number(pin.lat);
    const lng = Number(pin.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !isSafeDataUrl(pin.image, "image/")) return;

    const name = typeof pin.name === "string" ? pin.name.slice(0, 40) : "Memory";
    const time = typeof pin.time === "string" ? pin.time.slice(0, 100) : "";
    const image = escapeHTML(pin.image);

    const memoryIcon = L.divIcon({
        className: 'custom-memory-pin',
        html: `<div class="memory-marker"><img src="${image}"></div>`,
        iconSize: [45, 45],
        iconAnchor: [22, 22]
    });

    const marker = L.marker([lat, lng], { icon: memoryIcon }).addTo(map);
    marker.bindPopup(`
        <div style="text-align:center; padding: 2px; color: #111;">
            <b>📸 ${escapeHTML(name)}</b><br>
            ${time ? `<small style="color: #666;">${escapeHTML(time)}</small><br><br>` : "<br>"}
            <img src="${image}" alt="Memory photo" style="width:200px; max-width:100%; border-radius:8px;">
        </div>
    `);
    memoryMarkers.push(marker);
}

socket.on("loadMemoryPhotos", photos => {
    if (!Array.isArray(photos)) return;
    photos.forEach(renderMemoryPhoto);
});
socket.on("newMemoryPin", renderMemoryPhoto);

function setupMemoryButton() {
    const button = document.getElementById("memoryButton");
    const input = document.getElementById("memoryPhotoInput");
    if (!button || !input) return;

    button.addEventListener("click", () => {
        if (!myCoords) { alert("Please wait for your GPS location to load first."); return; }
        input.click();
    });

    input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (!file) return;

        if (!file.type.startsWith("image/")) { alert("Please select an image."); input.value = ""; return; }
        if (file.size > 5 * 1024 * 1024) { alert("Image must be 5 MB or smaller."); input.value = ""; return; }

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
        input.value = "";
    });
}

function launchAppUI() {
    const joinScreen = document.getElementById("join-screen");
    if (joinScreen) joinScreen.style.display = "none";
    const chatButton = document.getElementById("chat-toggle-btn");
    if (chatButton) chatButton.style.display = "flex";
    setTimeout(() => map.invalidateSize(), 300);
}

function finalizeJoin() {
    saveStoredUser(currentUser);
    if (ownMarker) {
        ownMarker.setIcon(createCustomMarkerIcon(getSafeImageSource(currentUser.avatar)));
        if (currentWeatherData) {
            ownMarker.bindTooltip(currentWeatherData, { permanent: true, direction: 'right', className: 'weather-badge', offset: [20, 0] });
        }
    }
    if (myCoords) emitLocation(myCoords.lat, myCoords.lng, currentWeatherData);
    launchAppUI();
}

function setupUserJoin() {
    if (currentUser && currentUser.name && currentUser.name !== "User" && getStoredUser()) {
        launchAppUI();
    }

    const form = document.getElementById("join-form");
    if (!form) return;

    form.addEventListener("submit", event => {
        event.preventDefault();
        const nameInput = document.getElementById("nameInput");
        if (nameInput && nameInput.value.trim()) currentUser.name = nameInput.value.trim().slice(0, 40);

        const avatarInput = document.getElementById("avatarInput");
        const file = avatarInput?.files?.[0];

        if (!file) { finalizeJoin(); return; }
        if (!file.type.startsWith("image/")) { alert("Please select an image."); return; }
        if (file.size > 2 * 1024 * 1024) { alert("Avatar must be 2 MB or smaller."); return; }

        const reader = new FileReader();
        reader.onload = () => {
            if (isSafeDataUrl(reader.result, "image/")) currentUser.avatar = reader.result;
            finalizeJoin();
        };
        reader.readAsDataURL(file);
    });
}

function getChatElements() {
    return {
        form: document.getElementById("chatForm"),
        input: document.getElementById("chatInput"),
        messages: document.getElementById("chat-messages"),
        attachmentInput: document.getElementById("chatAttachment"),
        cameraInput: document.getElementById("chat-camera-file"),
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
    const mine = msg.name === currentUser.name;
    
    wrapper.style.alignSelf = mine ? "flex-end" : "flex-start";
    wrapper.style.background = mine ? "#005c4b" : "#202c33";
    wrapper.style.marginLeft = mine ? "auto" : "0";
    wrapper.style.marginRight = mine ? "0" : "auto";

    const sender = document.createElement("strong");
    sender.textContent = msg.name.slice(0, 40);
    sender.style.color = mine ? "#25d366" : "#8de2cd";

    const content = document.createElement("div");

    if (msg.type === "text") {
        const text = msg.data.slice(0, 5000);
        const spotifyRegex = /https:\/\/open\.spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/;
        const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        
        if (spotifyRegex.test(text)) {
            const match = text.match(spotifyRegex);
            content.innerHTML = `<div style="margin-top:5px; width:280px; max-width:100%;"><iframe style="border-radius:12px; display:block;" src="https://open.spotify.com/embed/${match[1]}/${match[2]}?utm_source=generator&theme=0" width="100%" height="152" frameborder="0" allowfullscreen loading="lazy"></iframe></div>`;
        } else if (youtubeRegex.test(text)) {
            const match = text.match(youtubeRegex);
            content.innerHTML = `<div style="margin-top:5px; width:280px; max-width:100%; position:relative; padding-bottom:56.25%; height:0;"><iframe style="position:absolute; top:0; left:0; width:100%; height:100%; border:0; border-radius:8px;" src="https://www.youtube.com/embed/${match[1]}" allowfullscreen></iframe></div>`;
        } else {
            content.textContent = text;
        }
    } else if (msg.type === "image") {
        if (!isSafeDataUrl(msg.data, "image/")) return;
        content.innerHTML = `<img src="${msg.data}" style="max-width:260px; width:100%; border-radius:8px; margin-top:5px;">`;
    } else if (msg.type === "video") {
        if (!isSafeDataUrl(msg.data, "video/")) return;
        content.innerHTML = `<video controls src="${msg.data}" style="max-width:260px; width:100%; border-radius:8px; margin-top:5px;"></video>`;
    } else if (msg.type === "audio") {
        if (!isSafeDataUrl(msg.data, "audio/")) return;
        content.innerHTML = `<audio controls src="${msg.data}" style="max-width:240px; width:100%; height:40px; margin-top:5px;"></audio>`;
    } else if (msg.type === "document") {
        if (!msg.data.startsWith("data:")) return;
        content.innerHTML = `<a href="${msg.data}" download="attachment" style="display:block; margin-top:5px; padding:10px; background:#2a3942; color:white; text-decoration:none; border-radius:8px; text-align:center;">📎 Download File</a>`;
    }

    wrapper.appendChild(sender);
    wrapper.appendChild(content);

    const flexWrap = document.createElement("div");
    flexWrap.style.display = "flex"; flexWrap.style.flexDirection = "column"; flexWrap.style.width = "100%";
    flexWrap.appendChild(wrapper);

    messages.appendChild(flexWrap);
    messages.scrollTop = messages.scrollHeight;
}

socket.on("chatMessage", addChatMessage);

function setupChat() {
    const { form, input, attachmentInput, cameraInput, emojiButton, emojiPicker, emojiContainer, container, toggleBtn, minimizeBtn, attachMenuBtn, attachMenu, sendBtn, voiceButton } = getChatElements();

    if (toggleBtn && container) toggleBtn.addEventListener("click", () => { container.style.display = "flex"; toggleBtn.style.display = "none"; });
    if (minimizeBtn && container && toggleBtn) minimizeBtn.addEventListener("click", () => { container.style.display = "none"; toggleBtn.style.display = "flex"; });
    if (attachMenuBtn && attachMenu) attachMenuBtn.addEventListener("click", e => { e.stopPropagation(); if (emojiContainer) emojiContainer.style.display = "none"; attachMenu.style.display = attachMenu.style.display === "flex" ? "none" : "flex"; });

    const bindAttachment = (btnId, targetInput, acceptStr) => {
        const btn = document.getElementById(btnId);
        if(btn && targetInput) {
            btn.addEventListener("click", () => {
                targetInput.accept = acceptStr;
                targetInput.click();
                if(attachMenu) attachMenu.style.display = "none";
            });
        }
    };
    bindAttachment("att-media", attachmentInput, "image/*,video/*");
    bindAttachment("att-doc", attachmentInput, ".pdf,.doc,.docx,.txt,.zip");
    bindAttachment("att-audio", attachmentInput, "audio/*");
    bindAttachment("att-cam", cameraInput, "image/*");

    if (input && voiceButton && sendBtn) {
        input.addEventListener("input", () => {
            if (input.value.trim()) { voiceButton.style.display = "none"; sendBtn.style.display = "flex"; }
            else { voiceButton.style.display = "flex"; sendBtn.style.display = "none"; }
        });
    }

    if (form && input) {
        form.addEventListener("submit", event => {
            event.preventDefault();
            const text = input.value.trim();
            if (!text) return;
            socket.emit("chatMessage", { name: currentUser.name, type: "text", data: text.slice(0, 5000) });
            input.value = "";
            if (voiceButton && sendBtn) { voiceButton.style.display = "flex"; sendBtn.style.display = "none"; }
        });
    }

    const processFile = (fileInputElem) => {
        const file = fileInputElem.files?.[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) { alert("Attachment must be 5 MB or smaller."); fileInputElem.value = ""; return; }

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
        fileInputElem.value = "";
    };

    if (attachmentInput) attachmentInput.addEventListener("change", () => processFile(attachmentInput));
    if (cameraInput) cameraInput.addEventListener("change", () => processFile(cameraInput));

    if (emojiButton && emojiContainer) {
        emojiButton.addEventListener("click", event => {
            event.stopPropagation();
            if (attachMenu) attachMenu.style.display = "none";
            emojiContainer.style.display = emojiContainer.style.display === "none" ? "block" : "none";
        });
        if (emojiPicker) {
            emojiPicker.addEventListener("emoji-click", event => {
                input.value += event.detail.unicode;
                input.focus();
                if (voiceButton && sendBtn) { voiceButton.style.display = "none"; sendBtn.style.display = "flex"; }
            });
        }
    }

    document.addEventListener("click", event => {
        if (attachMenu && !attachMenu.contains(event.target) && event.target !== attachMenuBtn) attachMenu.style.display = "none";
        if (emojiContainer && !emojiContainer.contains(event.target) && event.target !== emojiButton) emojiContainer.style.display = "none";
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
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"];
            const mimeType = types.find(type => MediaRecorder.isTypeSupported(type)) || "";

            recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
            chunks = [];

            recorder.ondataavailable = event => { if (event.data && event.data.size > 0) chunks.push(event.data); };
            recorder.onstop = () => {
                stream.getTracks().forEach(track => track.stop());
                const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
                if (blob.size > 5 * 1024 * 1024) { alert("Voice message is too large."); return; }

                const reader = new FileReader();
                reader.onload = () => {
                    if (isSafeDataUrl(reader.result, "audio/")) socket.emit("chatMessage", { name: currentUser.name, type: "audio", data: reader.result });
                };
                reader.readAsDataURL(blob);

                voiceButton.textContent = "🎤";
                voiceButton.style.background = "transparent";
                voiceButton.style.color = "white";
            };

            recorder.start();
            voiceButton.textContent = "⏹️";
            voiceButton.style.background = "#f15c6d";
            voiceButton.style.color = "white";
        } catch { alert("Microphone permission denied."); }
    });
}

function setupEverything() {
    setupUserJoin();
    setupMemoryButton();
    setupChat();
    setupVoiceRecorder();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupEverything);
} else {
    setupEverything();
}
