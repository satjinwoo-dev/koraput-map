// ==========================================
// KORAPUT MAP - FINAL CLIENT LOGIC
// ==========================================

"use strict";

const socket = io({
    transports: ["websocket", "polling"]
});

// ==========================================
// CONSTANTS
// ==========================================

const DEFAULT_CENTER = [18.8136, 82.7153];
const DEFAULT_ZOOM = 13;

const DEFAULT_AVATAR = "satyam.png";

const MAX_NAME_LENGTH = 40;
const MAX_CHAT_LENGTH = 1000;

const MAX_CHAT_FILE_SIZE = 5 * 1024 * 1024;
const MAX_MEMORY_FILE_SIZE = 8 * 1024 * 1024;
const MAX_AVATAR_FILE_SIZE = 3 * 1024 * 1024;

const ALLOWED_MEMORY_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const ALLOWED_AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

// ==========================================
// SOCKET STATUS
// ==========================================

socket.on("connect", () => console.log("Connected:", socket.id));
socket.on("disconnect", () => console.log("Disconnected from server."));
socket.on("connect_error", (error) => console.warn("Socket connection error:", error.message));

// ==========================================
// INITIALIZE MAP
// ==========================================

const map = L.map("map", {
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true
}).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

// ==========================================
// MAP LAYERS
// ==========================================

const satelliteLayer = L.tileLayer("https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}", {
    maxZoom: 20, subdomains: ["mt0", "mt1", "mt2", "mt3"], attribution: "&copy; Google Maps"
});

const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
});

const darkLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 20, attribution: "&copy; CARTO"
});

let currentMapStyle = "satellite";
satelliteLayer.addTo(map);

// ==========================================
// GLOBAL STATE
// ==========================================

let ownMarker = null;
let accuracyCircle = null;

let firstLocationFix = true;
let locationWatchId = null;

let myCoords = null;
let currentWeatherData = "";

const friendMarkers = Object.create(null);
const friendData = Object.create(null);
const memoryMarkers = Object.create(null);

let currentUser = {
    name: localStorage.getItem("koraput_name") || "",
    avatar: localStorage.getItem("koraput_avatar") || DEFAULT_AVATAR
};

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

function escapeHTML(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function isValidCoordinate(lat, lng) {
    return (Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180);
}

function cleanName(name) {
    return String(name || "").trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
}

function weatherEmoji(code) {
    if (code === 0) return "☀️";
    if ([1, 2, 3].includes(code)) return "⛅";
    if ([45, 48].includes(code)) return "🌫️";
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67].includes(code)) return "🌧️";
    if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
    if ([80, 81, 82].includes(code)) return "🌦️";
    if ([95, 96, 99].includes(code)) return "⛈️";
    return "🌤️";
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    if (!isValidCoordinate(lat1, lon1) || !isValidCoordinate(lat2, lon2)) return "";
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return distance.toFixed(1);
}

function isValidImageDataURL(value) {
    if (typeof value !== "string") return false;
    return /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(value);
}

function isValidMediaDataURL(value) {
    if (typeof value !== "string") return false;
    return /^data:(image|video|audio|application)\//i.test(value);
}

// ==========================================
// WEATHER
// ==========================================

async function fetchWeather(lat, lng) {
    if (!isValidCoordinate(lat, lng)) return "";
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&current=temperature_2m,weather_code`;
        const response = await fetch(url);
        if (!response.ok) throw new Error("Weather request failed");
        const data = await response.json();
        const temperature = Number(data?.current?.temperature_2m);
        const weatherCode = Number(data?.current?.weather_code);
        if (!Number.isFinite(temperature)) return "";
        return `${weatherEmoji(weatherCode)} ${Math.round(temperature)}°C`;
    } catch (error) {
        console.warn("Weather error:", error);
        return "";
    }
}

// ==========================================
// ICONS
// ==========================================

function createOwnIcon(avatar) {
    return L.icon({
        iconUrl: avatar || DEFAULT_AVATAR,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
        popupAnchor: [0, -18],
        className: "avatar-icon own-live-avatar"
    });
}

function createFriendIcon(avatar) {
    return L.icon({
        iconUrl: avatar || DEFAULT_AVATAR,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
        popupAnchor: [0, -17],
        className: "avatar-icon friend-marker"
    });
}

// ==========================================
// LOCATION EMIT
// ==========================================

function emitLocation() {
    if (!myCoords || !currentUser.name || !isValidCoordinate(myCoords.lat, myCoords.lng)) return;
    socket.emit("updateLocation", {
        name: currentUser.name,
        avatar: currentUser.avatar || DEFAULT_AVATAR,
        lat: myCoords.lat,
        lng: myCoords.lng,
        weather: currentWeatherData || ""
    });
}

// ==========================================
// GPS
// ==========================================

function startLocationTracking() {
    if (!navigator.geolocation) {
        console.warn("Geolocation is not supported.");
        return;
    }

    locationWatchId = navigator.geolocation.watchPosition(
        async (position) => {
            const lat = Number(position.coords.latitude);
            const lng = Number(position.coords.longitude);
            const accuracy = Number(position.coords.accuracy);

            if (!isValidCoordinate(lat, lng)) return;
            myCoords = { lat, lng };

            if (Number.isFinite(accuracy) && accuracy > 0 && accuracy < 100000) {
                if (!accuracyCircle) {
                    accuracyCircle = L.circle([lat, lng], {
                        radius: accuracy, color: "#10b981", weight: 1, opacity: 0.7,
                        fillColor: "#10b981", fillOpacity: 0.08, interactive: false
                    }).addTo(map);
                } else {
                    accuracyCircle.setLatLng([lat, lng]);
                    accuracyCircle.setRadius(accuracy);
                }
            }

            if (!ownMarker) {
                ownMarker = L.marker([lat, lng], { icon: createOwnIcon(currentUser.avatar), zIndexOffset: 1000 }).addTo(map);
                if (firstLocationFix) { map.setView([lat, lng], 16); firstLocationFix = false; }
            } else {
                ownMarker.setLatLng([lat, lng]);
            }

            const weather = await fetchWeather(lat, lng);
            if (weather) {
                currentWeatherData = weather;
                const tempElement = document.getElementById("map-temp-display");
                if (tempElement) tempElement.textContent = weather;

                if (ownMarker) {
                    ownMarker.unbindTooltip();
                    ownMarker.bindTooltip(weather, { permanent: true, direction: "right", className: "weather-badge", offset: [15, 0] });
                }
            }

            emitLocation();
        },
        (error) => console.warn("GPS Error:", error.message),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
    );
}

// ==========================================
// FRIENDS
// ==========================================

socket.on("friendMoved", (data) => {
    if (!data || !data.id) return;
    const lat = Number(data.lat);
    const lng = Number(data.lng);
    if (!isValidCoordinate(lat, lng)) return;

    const name = cleanName(data.name);
    if (name && name === currentUser.name) return;

    const avatar = isValidImageDataURL(data.avatar) ? data.avatar : (data.avatar || DEFAULT_AVATAR);
    const weather = typeof data.weather === "string" ? data.weather.slice(0, 50) : "";

    friendData[data.id] = { id: data.id, name: name || "Friend", lat, lng, avatar, weather };

    let badge = weather;
    if (myCoords) {
        const distance = haversineDistance(myCoords.lat, myCoords.lng, lat, lng);
        if (distance) badge = `${badge ? badge + " | " : ""}📍 ${distance} km`;
    }

    if (!friendMarkers[data.id]) {
        friendMarkers[data.id] = L.marker([lat, lng], { icon: createFriendIcon(avatar) }).addTo(map);
    } else {
        friendMarkers[data.id].setLatLng([lat, lng]);
        friendMarkers[data.id].setIcon(createFriendIcon(avatar));
    }

    const marker = friendMarkers[data.id];
    marker.unbindTooltip();
    if (badge) {
        marker.bindTooltip(badge, { permanent: true, direction: "right", className: "weather-badge", offset: [15, 0] });
    }
});

socket.on("friendDisconnected", (id) => {
    if (friendMarkers[id]) { map.removeLayer(friendMarkers[id]); delete friendMarkers[id]; }
    if (friendData[id]) delete friendData[id];
});

// ==========================================
// MEMORY PHOTO PIN
// ==========================================

function renderMemoryPin(pin) {
    if (!pin) return;
    const lat = Number(pin.lat);
    const lng = Number(pin.lng);
    if (!isValidCoordinate(lat, lng)) return;
    if (!isValidImageDataURL(pin.image)) return;

    const pinId = String(pin.id || `${lat}_${lng}_${Date.now()}`);
    if (memoryMarkers[pinId]) return;

    const safeImage = escapeHTML(pin.image);
    const safeName = escapeHTML(cleanName(pin.name) || "Memory");
    const safeTime = escapeHTML(String(pin.time || "").slice(0, 100));

    const icon = L.divIcon({
        className: "custom-pin",
        html: `<div class="memory-pin-box"><img src="${safeImage}" alt="Memory"></div>`,
        iconSize: [44, 44],
        iconAnchor: [22, 22]
    });

    const marker = L.marker([lat, lng], { icon }).addTo(map);

    marker.bindPopup(`
        <div style="text-align:center; color:#111; min-width:210px;">
            <b>📸 ${safeName}</b><br><small style="color:#666">${safeTime}</small><br><br>
            <img src="${safeImage}" alt="Memory" style="width:200px; max-width:100%; border-radius:8px; display:block; margin:auto;">
        </div>
    `);

    memoryMarkers[pinId] = marker;
}

socket.on("loadMemoryPhotos", (pins) => {
    if (!Array.isArray(pins)) return;
    pins.forEach(renderMemoryPin);
});

socket.on("newMemoryPin", renderMemoryPin);

// ==========================================
// USER JOIN
// ==========================================

function setupUserJoin() {
    const joinScreen = document.getElementById("join-screen");
    const joinForm = document.getElementById("join-form");
    const nameInput = document.getElementById("nameInput");
    const avatarInput = document.getElementById("avatarInput");
    const avatarLabelText = document.getElementById("avatar-label-text");
    const chatToggleBtn = document.getElementById("chat-toggle-btn");
    const headerAvatar = document.getElementById("header-avatar");

    if (!joinScreen || !joinForm) return;

    if (currentUser.name) {
        joinScreen.style.display = "none";
        if (chatToggleBtn) chatToggleBtn.style.display = "flex";
        if (headerAvatar) {
            headerAvatar.src = currentUser.avatar || DEFAULT_AVATAR;
            headerAvatar.style.display = "block";
        }
    }

    if (avatarInput) {
        avatarInput.addEventListener("change", () => {
            const file = avatarInput.files?.[0];
            if (!file) return;
            if (!ALLOWED_AVATAR_TYPES.includes(file.type)) { alert("Please select a valid image."); avatarInput.value = ""; return; }
            if (file.size > MAX_AVATAR_FILE_SIZE) { alert("Profile photo must be under 3MB."); avatarInput.value = ""; return; }
            if (avatarLabelText) avatarLabelText.textContent = "Photo Selected ✓";
        });
    }

    joinForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const name = cleanName(nameInput?.value);
        if (!name) { alert("Please enter your name."); nameInput?.focus(); return; }

        currentUser.name = name;
        localStorage.setItem("koraput_name", name);

        const file = avatarInput?.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = () => {
                const result = String(reader.result || "");
                if (!isValidImageDataURL(result)) { completeJoin(); return; }
                currentUser.avatar = result;
                localStorage.setItem("koraput_avatar", result);
                completeJoin();
            };
            reader.onerror = () => completeJoin();
            reader.readAsDataURL(file);
        } else {
            completeJoin();
        }
    });

    function completeJoin() {
        joinScreen.style.display = "none";
        if (chatToggleBtn) chatToggleBtn.style.display = "flex";
        if (headerAvatar) {
            headerAvatar.src = currentUser.avatar || DEFAULT_AVATAR;
            headerAvatar.style.display = "block";
        }
        if (ownMarker) ownMarker.setIcon(createOwnIcon(currentUser.avatar));
        emitLocation();
        setTimeout(() => map.invalidateSize(), 300);
    }
}

// ==========================================
// MEMORY BUTTON
// ==========================================

function setupMemoryButton() {
    const memoryBtn = document.getElementById("memoryButton");
    const memoryInput = document.getElementById("memoryPhotoInput");
    if (!memoryBtn || !memoryInput) return;

    memoryBtn.addEventListener("click", () => {
        if (!currentUser.name) { alert("Please join the map first."); return; }
        if (!myCoords) { alert("GPS location loading... please wait."); return; }
        memoryInput.click();
    });

    memoryInput.addEventListener("change", () => {
        const file = memoryInput.files?.[0];
        if (!file) return;
        if (!ALLOWED_MEMORY_TYPES.includes(file.type)) { alert("Please select a valid image."); memoryInput.value = ""; return; }
        if (file.size > MAX_MEMORY_FILE_SIZE) { alert("Memory photo must be under 8MB."); memoryInput.value = ""; return; }

        const reader = new FileReader();
        reader.onload = () => {
            const image = String(reader.result || "");
            if (!isValidImageDataURL(image)) { alert("Unable to read this image."); return; }
            alert("📸 Tap anywhere on the map to pin this photo!");
            map.once("click", (event) => {
                if (!event.latlng || !isValidCoordinate(event.latlng.lat, event.latlng.lng)) return;
                socket.emit("uploadMemoryPhoto", {
                    name: currentUser.name, lat: event.latlng.lat, lng: event.latlng.lng,
                    image, time: new Date().toLocaleString()
                });
            });
        };
        reader.onerror = () => { alert("Could not read the photo."); };
        reader.readAsDataURL(file);
        memoryInput.value = "";
    });
}

// ==========================================
// CHAT
// ==========================================

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

    if (!chatContainer || !chatForm || !chatInput || !chatMessages) return;

    chatToggleBtn?.addEventListener("click", () => {
        chatContainer.style.display = "flex";
        if (chatToggleBtn) chatToggleBtn.style.display = "none";
        setTimeout(() => chatInput.focus(), 100);
    });

    chatMinimizeBtn?.addEventListener("click", () => {
        chatContainer.style.display = "none";
        if (chatToggleBtn) chatToggleBtn.style.display = "flex";
    });

    function updateSendButtons() {
        const hasText = Boolean(chatInput.value.trim());
        if (voiceBtn) voiceBtn.style.display = hasText ? "none" : "flex";
        if (sendBtn) sendBtn.style.display = hasText ? "flex" : "none";
    }

    chatInput.addEventListener("input", updateSendButtons);

    attachBtn?.addEventListener("click", (event) => {
        event.stopPropagation();
        if (emojiContainer) emojiContainer.style.display = "none";
        if (attachMenu) attachMenu.style.display = attachMenu.style.display === "flex" ? "none" : "flex";
    });

    emojiBtn?.addEventListener("click", (event) => {
        event.stopPropagation();
        if (attachMenu) attachMenu.style.display = "none";
        if (emojiContainer) emojiContainer.style.display = emojiContainer.style.display === "block" ? "none" : "block";
    });

    document.addEventListener("click", (event) => {
        if (attachMenu && !attachMenu.contains(event.target) && event.target !== attachBtn) attachMenu.style.display = "none";
        if (emojiContainer && !emojiContainer.contains(event.target) && event.target !== emojiBtn) emojiContainer.style.display = "none";
    });

    emojiPicker?.addEventListener("emoji-click", (event) => {
        const emoji = event?.detail?.unicode;
        if (!emoji) return;
        chatInput.value += emoji;
        chatInput.focus();
        updateSendButtons();
    });

    function openAttachmentPicker(accept) {
        if (!chatAttachment) return;
        chatAttachment.accept = accept;
        chatAttachment.click();
    }

    document.getElementById("att-media")?.addEventListener("click", () => openAttachmentPicker("image/*,video/*"));
    document.getElementById("att-doc")?.addEventListener("click", () => openAttachmentPicker(".pdf,.doc,.docx,.txt,.zip"));
    document.getElementById("att-audio")?.addEventListener("click", () => openAttachmentPicker("audio/*"));

    chatAttachment?.addEventListener("change", () => {
        const file = chatAttachment.files?.[0];
        if (!file) return;
        if (file.size > MAX_CHAT_FILE_SIZE) { alert("Maximum file size is 5MB."); chatAttachment.value = ""; return; }

        let type = "document";
        if (file.type.startsWith("image/")) type = "image";
        else if (file.type.startsWith("video/")) type = "video";
        else if (file.type.startsWith("audio/")) type = "audio";

        const reader = new FileReader();
        reader.onload = () => {
            const data = String(reader.result || "");
            if (!isValidMediaDataURL(data)) { alert("This file type cannot be sent."); return; }
            socket.emit("chatMessage", { name: currentUser.name, type, data });
        };
        reader.onerror = () => { alert("Could not read the file."); };
        reader.readAsDataURL(file);
        chatAttachment.value = "";
    });

    chatForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const text = chatInput.value.trim().slice(0, MAX_CHAT_LENGTH);
        if (!text) return;
        if (!currentUser.name) { alert("Please join the map first."); return; }
        socket.emit("chatMessage", { name: currentUser.name, type: "text", data: text });
        chatInput.value = "";
        updateSendButtons();
        chatInput.focus();
    });

    socket.on("chatMessage", (msg) => {
        if (!msg || typeof msg !== "object") return;
        const name = cleanName(msg.name) || "User";
        const type = String(msg.type || "");
        const data = msg.data;
        if (typeof data !== "string") return;

        const div = document.createElement("div");
        div.className = "chat-message " + (name === currentUser.name ? "msg-mine" : "msg-theirs");

        const sender = document.createElement("div");
        sender.className = "msg-sender";
        sender.textContent = name;
        div.appendChild(sender);

        if (type === "text") {
            const text = document.createElement("div");
            text.textContent = data.slice(0, MAX_CHAT_LENGTH);
            div.appendChild(text);
        } else if (type === "image" && /^data:image\//i.test(data)) {
            const image = document.createElement("img");
            image.className = "chat-media"; image.src = data; image.alt = "Shared image"; image.loading = "lazy";
            div.appendChild(image);
        } else if (type === "video" && /^data:video\//i.test(data)) {
            const video = document.createElement("video");
            video.className = "chat-media"; video.controls = true; video.preload = "metadata"; video.src = data;
            div.appendChild(video);
        } else if (type === "audio" && /^data:audio\//i.test(data)) {
            const audio = document.createElement("audio");
            audio.className = "chat-audio"; audio.controls = true; audio.preload = "metadata"; audio.src = data;
            div.appendChild(audio);
        } else if (type === "document" && /^data:application\//i.test(data)) {
            const link = document.createElement("a");
            link.className = "chat-document"; link.href = data; link.download = "Koraput-Map-file"; link.textContent = "📄 Download File";
            div.appendChild(link);
        } else { return; }

        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
}

// ==========================================
// VOICE RECORDER
// ==========================================

function setupVoiceRecorder() {
    const voiceBtn = document.getElementById("voiceButton");
    const chatInput = document.getElementById("chatInput");
    const sendBtn = document.getElementById("chat-send");
    if (!voiceBtn) return;

    let recorder = null;
    let chunks = [];

    function resetVoiceButton() {
        voiceBtn.style.background = "transparent";
        voiceBtn.style.color = "var(--muted)";
        voiceBtn.innerHTML = "🎙️";
        if (chatInput && sendBtn && chatInput.value.trim()) {
            voiceBtn.style.display = "none";
            sendBtn.style.display = "flex";
        }
    }

    voiceBtn.addEventListener("click", async () => {
        if (recorder && recorder.state === "recording") { recorder.stop(); return; }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { alert("Voice recording is not supported on this device."); return; }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            let mimeType = "";
            if (MediaRecorder.isTypeSupported("audio/webm")) mimeType = "audio/webm";
            else if (MediaRecorder.isTypeSupported("audio/mp4")) mimeType = "audio/mp4";

            recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
            chunks = [];

            recorder.ondataavailable = (event) => { if (event.data && event.data.size > 0) chunks.push(event.data); };
            recorder.onstop = () => {
                stream.getTracks().forEach(track => track.stop());
                const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
                if (blob.size === 0) { resetVoiceButton(); return; }
                if (blob.size > MAX_CHAT_FILE_SIZE) { alert("Voice message is too large."); resetVoiceButton(); return; }

                const reader = new FileReader();
                reader.onload = () => {
                    const data = String(reader.result || "");
                    if (!/^data:audio\//i.test(data)) { resetVoiceButton(); return; }
                    socket.emit("chatMessage", { name: currentUser.name, type: "audio", data });
                    resetVoiceButton();
                };
                reader.onerror = () => resetVoiceButton();
                reader.readAsDataURL(blob);
            };

            recorder.onerror = () => {
                stream.getTracks().forEach(track => track.stop());
                resetVoiceButton();
                alert("Voice recording failed.");
            };

            recorder.start();
            voiceBtn.style.background = "var(--green)"; voiceBtn.style.color = "#fff"; voiceBtn.innerHTML = "⏹️";
        } catch (error) {
            console.warn("Microphone error:", error);
            alert("Microphone access denied.");
        }
    });
}

// ==========================================
// MAP CONTROLS
// ==========================================

function setupMapControls() {
    const locationBtn = document.getElementById("my-location-btn");
    const compassBtn = document.getElementById("compass-btn");
    const styleBtn = document.getElementById("map-style-btn");
    const styleMenu = document.getElementById("map-style-menu");

    locationBtn?.addEventListener("click", () => {
        if (!myCoords) { alert("Waiting for GPS location..."); return; }
        map.flyTo([myCoords.lat, myCoords.lng], Math.max(map.getZoom(), 16), { animate: true, duration: 0.8 });
    });

    compassBtn?.addEventListener("click", () => {
        if (!map) return;
        map.setView(map.getCenter(), map.getZoom(), { animate: true });
        const icon = document.getElementById("compass-icon");
        if (icon) icon.style.transform = "rotate(0deg)";
    });

    styleBtn?.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!styleMenu) return;
        styleMenu.style.display = styleMenu.style.display === "flex" ? "none" : "flex";
    });

    styleMenu?.addEventListener("click", (event) => {
        const button = event.target.closest("[data-style]");
        if (!button) return;
        changeMapStyle(button.dataset.style);
        styleMenu.style.display = "none";
    });

    document.addEventListener("click", (event) => {
        if (styleMenu && styleBtn && !styleMenu.contains(event.target) && event.target !== styleBtn) {
            styleMenu.style.display = "none";
        }
    });

    if (typeof DeviceOrientationEvent !== "undefined") {
        window.addEventListener("deviceorientation", (event) => {
            const icon = document.getElementById("compass-icon");
            if (!icon) return;
            if (typeof event.webkitCompassHeading === "number" && Number.isFinite(event.webkitCompassHeading)) {
                icon.style.transform = `rotate(${-event.webkitCompassHeading}deg)`;
                return;
            }
            if (typeof event.alpha === "number" && Number.isFinite(event.alpha)) {
                icon.style.transform = `rotate(${event.alpha}deg)`;
            }
        }, true);
    }
}

function changeMapStyle(style) {
    if (!["satellite", "street", "dark"].includes(style)) return;
    if (style === currentMapStyle) return;

    if (currentMapStyle === "satellite") map.removeLayer(satelliteLayer);
    if (currentMapStyle === "street") map.removeLayer(streetLayer);
    if (currentMapStyle === "dark") map.removeLayer(darkLayer);

    if (style === "satellite") satelliteLayer.addTo(map);
    if (style === "street") streetLayer.addTo(map);
    if (style === "dark") darkLayer.addTo(map);

    currentMapStyle = style;

    document.querySelectorAll("#map-style-menu button").forEach(button => {
        button.classList.toggle("active", button.dataset.style === style);
    });

    setTimeout(() => map.invalidateSize(), 100);
}

// ==========================================
// UPDATE FRIEND DISTANCES
// ==========================================

function updateFriendBadges() {
    if (!myCoords) return;
    Object.keys(friendMarkers).forEach(id => {
        const friend = friendData[id];
        const marker = friendMarkers[id];
        if (!friend || !marker) return;

        const distance = haversineDistance(myCoords.lat, myCoords.lng, friend.lat, friend.lng);
        let badge = friend.weather || "";
        if (distance) badge = `${badge ? badge + " | " : ""}📍 ${distance} km`;

        marker.unbindTooltip();
        if (badge) {
            marker.bindTooltip(badge, { permanent: true, direction: "right", className: "weather-badge", offset: [15, 0] });
        }
    });
}

// ==========================================
// INITIALIZE EVERYTHING
// ==========================================

function setupEverything() {
    setupUserJoin();
    setupMemoryButton();
    setupChat();
    setupVoiceRecorder();
    setupMapControls();
    startLocationTracking();
}

setInterval(() => {
    emitLocation();
    updateFriendBadges();
}, 5000);

setupEverything();
console.log("Koraput Map client loaded successfully.");
