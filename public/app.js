// ==========================================
// KORAPUT MAP - CLEAN CLIENT (UI FIXED)
// ==========================================

const socket = io();

const map = L.map("map").setView([18.8136, 82.7153], 13);

L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
        maxZoom: 19,
        attribution: "Tiles © Esri"
    }
).addTo(map);

let ownMarker = null;
let firstLocationFix = true;
const friendMarkers = {};
const memoryMarkers = [];

let lastWeatherUpdate = 0;
const WEATHER_INTERVAL = 10 * 60 * 1000;

const defaultAvatar = "satyam.png"; // Set default to satyam.png

function escapeHTML(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
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
    // Basic fix to allow relative paths like "satyam.png" or "friend1.png"
    if (typeof value === "string" && !value.startsWith("data:") && !value.startsWith("http")) {
        return value; 
    }
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
    } catch (error) {
        console.warn("Weather error:", error);
        return "";
    }
}

function createOwnIcon(avatar) {
    return L.icon({
        iconUrl: getSafeImageSource(avatar),
        iconSize: [45, 45],
        iconAnchor: [22, 22],
        className: "avatar-icon" // Use CSS for circle rounding
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

function getStoredUser() {
    try {
        const raw = localStorage.getItem("koraputUser");
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function saveStoredUser(user) {
    try {
        localStorage.setItem("koraputUser", JSON.stringify(user));
    } catch (error) {
        console.warn("Could not save user:", error);
    }
}

let currentUser = getStoredUser() || { name: "User", avatar: defaultAvatar };
let currentWeatherData = "";

function updateUserUI() {
    const nameElements = document.querySelectorAll("#userName, #profileName, #header-name, [data-user-name]");
    nameElements.forEach((element) => {
        element.textContent = (currentUser.name || "User") + " (Koraput Map)";
    });
    const headerAvatar = document.getElementById('header-avatar');
    if (headerAvatar) headerAvatar.src = getSafeImageSource(currentUser.avatar);
}

function emitLocation(lat, lng, weather = "") {
    socket.emit("updateLocation", {
        name: currentUser.name,
        avatar: currentUser.avatar,
        lat,
        lng,
        weather
    });
}

function handleLocation(position) {
    const lat = Number(position.coords.latitude);
    const lng = Number(position.coords.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;

    if (!ownMarker) {
        ownMarker = L.marker([lat, lng], { icon: createOwnIcon(currentUser.avatar) }).addTo(map);
        if (firstLocationFix) {
            map.setView([lat, lng], 16);
            firstLocationFix = false;
        }
    } else {
        ownMarker.setLatLng([lat, lng]);
    }

    emitLocation(lat, lng, currentWeatherData);

    getWeather(lat, lng).then((weather) => {
        if (!weather) return;
        currentWeatherData = weather;
        emitLocation(lat, lng, weather);
        
        // FIXED: Weather Badge as Permanent Tooltip
        if (ownMarker) {
            ownMarker.bindTooltip(weather, { permanent: true, direction: 'right', className: 'weather-badge', offset: [20, 0] });
        }
    });
}

function handleLocationError(error) {
    console.warn("Location error:", error.message);
}

if ("geolocation" in navigator) {
    navigator.geolocation.watchPosition(handleLocation, handleLocationError, { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
}

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

    if (ownMarker) {
        const own = ownMarker.getLatLng();
        const distance = haversineDistance(own.lat, own.lng, lat, lng);
        badgeText = `${weather ? weather + ' | ' : ''}📍 ${distance < 1 ? Math.round(distance * 1000) + 'm' : distance.toFixed(1) + 'km'}`;
    }

    if (!friendMarkers[id]) {
        friendMarkers[id] = L.marker([lat, lng], { icon: createFriendIcon(avatar) }).addTo(map);
    } else {
        friendMarkers[id].setLatLng([lat, lng]);
        friendMarkers[id].setIcon(createFriendIcon(avatar));
    }

    // FIXED: Weather & Distance Badge as Permanent Tooltip
    if (badgeText) {
        friendMarkers[id].bindTooltip(badgeText, { permanent: true, direction: 'right', className: 'weather-badge', offset: [20, 0] });
    }
});

socket.on("friendDisconnected", (id) => {
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
        iconSize: [42, 42],
        iconAnchor: [21, 21]
    });

    const marker = L.marker([lat, lng], { icon: memoryIcon }).addTo(map);

    marker.bindPopup(`
        <div style="text-align:center; padding: 2px;">
            <b>📸 ${escapeHTML(name)}</b><br>
            ${time ? `<small>${escapeHTML(time)}</small><br><br>` : "<br>"}
            <img src="${image}" alt="Memory photo" style="width:200px; max-width:100%; border-radius:8px;">
        </div>
    `);

    memoryMarkers.push(marker);
}

socket.on("loadMemoryPhotos", (photos) => {
    if (!Array.isArray(photos)) return;
    photos.forEach(renderMemoryPhoto);
});

socket.on("newMemoryPin", (pin) => renderMemoryPhoto(pin));

function setupMemoryUpload() {
    const input = document.getElementById("map-file-input") || document.getElementById("memoryPhotoInput");
    if (!input) return;

    input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (!file) return;

        if (!file.type.startsWith("image/")) {
            alert("Please select an image.");
            input.value = "";
            return;
        }

        if (file.size > 5 * 1024 * 1024) {
            alert("Image must be 5 MB or smaller.");
            input.value = "";
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result;
            if (!isSafeDataUrl(result, "image/")) {
                alert("Invalid image.");
                return;
            }

            alert("📸 Click anywhere on the map to pin your memory photo!");
            map.once("click", (mapEvent) => {
                socket.emit("uploadMemoryPhoto", {
                    name: currentUser.name,
                    lat: mapEvent.latlng.lat,
                    lng: mapEvent.latlng.lng,
                    image: result,
                    time: new Date().toLocaleString()
                });
            });
        };
        reader.onerror = () => alert("Could not read the image.");
        reader.readAsDataURL(file);
        input.value = "";
    });
}

function setupMemoryButton() {
    // FIXED: Restore Top-Left Leaflet Camera Control
    const UploadControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd: function () {
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
            const button = L.DomUtil.create('a', 'map-upload-control', container);
            button.innerHTML = '📸';
            button.href = '#';
            button.title = 'Upload Memory to Map';
            button.style.fontSize = '18px';
            button.style.lineHeight = '30px';
            button.style.textAlign = 'center';
            
            L.DomEvent.on(button, 'click', (e) => {
                L.DomEvent.stopPropagation(e);
                L.DomEvent.preventDefault(e);
                const input = document.getElementById("map-file-input") || document.getElementById("memoryPhotoInput");
                if (input) input.click();
            });
            return container;
        }
    });
    map.addControl(new UploadControl());
}

function launchAppUI() {
    // FIXED: Properly Hide Join Screen Elements
    document.querySelectorAll('#join-screen, .join-container, form').forEach(el => {
        if (el.innerHTML && el.innerHTML.includes('Join Koraput Map') || el.id === 'join-screen') {
            el.style.display = 'none';
        }
    });
    
    const chatToggleBtn = document.getElementById('chat-toggle-btn');
    if (chatToggleBtn) chatToggleBtn.style.display = 'flex';

    setTimeout(() => map.invalidateSize(), 300);
}

function setupUserJoin() {
    // Auto-login logic
    if (currentUser && currentUser.name && currentUser.name !== "User" && getStoredUser()) {
        updateUserUI();
        launchAppUI();
    }

    // Capture explicit Join Map clicks
    document.addEventListener("click", (e) => {
        const target = e.target;
        if (target && (target.id === "joinBtn" || target.innerText?.trim() === "Join Map" || target.type === "submit")) {
            e.preventDefault();

            const nameInput = document.querySelector('input[type="text"]') || document.getElementById("nameInput");
            if (nameInput && nameInput.value.trim() !== "") {
                currentUser.name = nameInput.value.trim().slice(0, 40);
            }

            const fileInput = document.querySelector('input[type="file"]') || document.getElementById("avatarInput");
            const file = fileInput?.files?.[0];

            if (file) {
                if (file.size > 2 * 1024 * 1024) {
                    alert("Avatar must be 2 MB or smaller.");
                    return;
                }
                const reader = new FileReader();
                reader.onload = () => {
                    if (isSafeDataUrl(reader.result, "image/")) {
                        currentUser.avatar = reader.result;
                    }
                    finalizeJoin();
                };
                reader.readAsDataURL(file);
            } else {
                finalizeJoin();
            }
        }
    });
}

function finalizeJoin() {
    saveStoredUser(currentUser);
    updateUserUI();
    
    if (ownMarker) {
        ownMarker.setIcon(createOwnIcon(currentUser.avatar));
        ownMarker.bindPopup(`<b>${escapeHTML(currentUser.name)}</b><br>You are here`);
        const location = ownMarker.getLatLng();
        emitLocation(location.lat, location.lng, currentWeatherData);
    }
    
    launchAppUI();
}

function getChatElements() {
    return {
        form: document.getElementById("chat-form") || document.getElementById("chatForm"),
        input: document.getElementById("chat-input") || document.getElementById("chatInput"),
        messages: document.getElementById("chat-messages") || document.getElementById("chatMessages"),
        attachmentInput: document.getElementById("chat-file") || document.getElementById("chatAttachment"),
        emojiButton: document.getElementById("chat-emoji-btn") || document.getElementById("emojiButton"),
        emojiPicker: document.getElementById("emoji-picker-container") || document.getElementById("emojiPicker"),
        voiceButton: document.getElementById("chat-mic-btn") || document.getElementById("voiceButton"),
        container: document.getElementById("chat-container"),
        toggleBtn: document.getElementById("chat-toggle-btn"),
        minimizeBtn: document.getElementById("chat-minimize-btn"),
        attachMenuBtn: document.getElementById("chat-attach-btn"),
        attachMenu: document.getElementById("attachment-menu")
    };
}

function addChatMessage(msg) {
    const { messages } = getChatElements();
    if (!messages || !msg || typeof msg !== "object") return;
    if (typeof msg.name !== "string" || typeof msg.type !== "string" || typeof msg.data !== "string") return;

    const allowedTypes = ["text", "image", "video", "audio", "document"];
    if (!allowedTypes.includes(msg.type)) return;

    const wrapper = document.createElement("div");
    wrapper.className = "msg-bubble " + (msg.name === currentUser.name ? "msg-mine" : "msg-theirs");

    const sender = document.createElement("div");
    sender.className = "msg-name";
    sender.textContent = msg.name.slice(0, 40);

    const content = document.createElement("div");

    if (msg.type === "text") {
        const text = msg.data.slice(0, 5000);
        const spotifyRegex = /https:\/\/open\.spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/;
        const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        
        if (spotifyRegex.test(text)) {
            const match = text.match(spotifyRegex);
            content.innerHTML = `<div style="margin-top: 5px; width: 280px;"><iframe style="border-radius:12px; display:block;" src="https://open.spotify.com/embed/${match[1]}/${match[2]}?utm_source=generator&theme=0" width="100%" height="152" frameBorder="0" allowfullscreen="" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe></div>`;
        } else if (youtubeRegex.test(text)) {
            const match = text.match(youtubeRegex);
            content.innerHTML = `<div style="margin-top: 5px; width: 280px; position: relative; padding-bottom: 56.25%; height: 0;"><iframe style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border:0; border-radius: 8px;" src="https://www.youtube.com/embed/${match[1]}" allowfullscreen="" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe></div>`;
        } else {
            content.textContent = text;
        }
    }

    if (msg.type === "image") {
        if (!isSafeDataUrl(msg.data, "image/")) return;
        const img = document.createElement("img");
        img.src = msg.data;
        img.style.maxWidth = "280px";
        img.style.borderRadius = "8px";
        img.style.marginTop = "5px";
        content.appendChild(img);
    }

    if (msg.type === "video") {
        if (!isSafeDataUrl(msg.data, "video/")) return;
        const video = document.createElement("video");
        video.src = msg.data;
        video.controls = true;
        video.style.maxWidth = "280px";
        video.style.borderRadius = "8px";
        video.style.marginTop = "5px";
        content.appendChild(video);
    }

    if (msg.type === "audio") {
        if (!isSafeDataUrl(msg.data, "audio/")) return;
        const audio = document.createElement("audio");
        audio.src = msg.data;
        audio.controls = true;
        audio.style.maxWidth = "260px";
        audio.style.height = "40px";
        audio.style.marginTop = "5px";
        content.appendChild(audio);
    }

    if (msg.type === "document") {
        if (!msg.data.startsWith("data:")) return;
        const link = document.createElement("a");
        link.href = msg.data;
        link.textContent = "📎 Download File";
        link.download = "attachment";
        link.style.display = "block";
        link.style.marginTop = "5px";
        link.style.padding = "10px";
        link.style.background = "#202c33";
        link.style.color = "white";
        link.style.textDecoration = "none";
        link.style.borderRadius = "8px";
        content.appendChild(link);
    }

    wrapper.appendChild(sender);
    wrapper.appendChild(content);
    messages.appendChild(wrapper);
    messages.scrollTop = messages.scrollHeight;
}

socket.on("chatMessage", (msg) => addChatMessage(msg));

function setupChat() {
    const { form, input, attachmentInput, emojiButton, emojiPicker, container, toggleBtn, minimizeBtn, attachMenuBtn, attachMenu } = getChatElements();

    // FIXED: Chat UI Minimizing Logic
    if (toggleBtn && container) {
        toggleBtn.addEventListener('click', () => {
            container.style.display = 'flex';
            toggleBtn.style.display = 'none';
        });
    }

    if (minimizeBtn && container && toggleBtn) {
        minimizeBtn.addEventListener('click', () => {
            container.style.display = 'none';
            toggleBtn.style.display = 'flex';
        });
    }

    if (attachMenuBtn && attachMenu) {
        attachMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if(emojiPicker) emojiPicker.style.display = 'none';
            attachMenu.style.display = attachMenu.style.display === 'flex' ? 'none' : 'flex';
        });
    }

    // Media Options Handlers
    const clickProxy = (id, accept) => {
        const btn = document.getElementById(id);
        if(btn) btn.addEventListener('click', () => {
            if(attachmentInput) { attachmentInput.accept = accept; attachmentInput.click(); }
            if(attachMenu) attachMenu.style.display = 'none';
        });
    }
    clickProxy('att-media', 'image/*,video/*');
    clickProxy('att-doc', '.pdf,.docx,.txt,.zip');
    clickProxy('att-audio', 'audio/*');
    clickProxy('att-cam', 'image/*,video/*'); // If separate camera input exists, link it here

    if (form && input) {
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            const text = input.value.trim();
            if (!text) return;
            socket.emit("chatMessage", { name: currentUser.name, type: "text", data: text.slice(0, 5000) });
            input.value = "";
        });
    }

    if (attachmentInput) {
        attachmentInput.addEventListener("change", () => {
            const file = attachmentInput.files?.[0];
            if (!file) return;

            if (file.size > 5 * 1024 * 1024) {
                alert("Attachment must be 5 MB or smaller.");
                attachmentInput.value = "";
                return;
            }

            let type = "document";
            if (file.type.startsWith("image/")) type = "image";
            else if (file.type.startsWith("video/")) type = "video";
            else if (file.type.startsWith("audio/")) type = "audio";

            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result;
                if (typeof result !== "string" || !result.startsWith("data:")) return;
                socket.emit("chatMessage", { name: currentUser.name, type, data: result });
            };
            reader.readAsDataURL(file);
            attachmentInput.value = "";
        });
    }

    if (emojiButton && emojiPicker) {
        const pickerInner = document.querySelector('emoji-picker') || emojiPicker;
        emojiButton.addEventListener("click", (e) => {
            e.stopPropagation();
            if(attachMenu) attachMenu.style.display = 'none';
            emojiPicker.style.display = emojiPicker.style.display === "none" ? "block" : "none";
        });

        if (pickerInner.tagName === 'EMOJI-PICKER') {
            pickerInner.addEventListener('emoji-click', event => {
                input.value += event.detail.unicode;
                input.focus();
            });
        }
    }

    document.addEventListener('click', (e) => {
        if (attachMenu && !attachMenu.contains(e.target) && e.target !== attachMenuBtn) attachMenu.style.display = 'none';
        if (emojiPicker && !emojiPicker.contains(e.target) && e.target !== emojiButton) emojiPicker.style.display = 'none';
    });
}

function getSupportedAudioMimeType() {
    if (!window.MediaRecorder) return "";
    const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"];
    return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function setupVoiceRecorder() {
    const { voiceButton } = getChatElements();
    if (!voiceButton) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        voiceButton.disabled = true;
        return;
    }

    let recorder = null;
    let chunks = [];

    voiceButton.addEventListener("click", async () => {
        if (recorder && recorder.state === "recording") {
            recorder.stop();
            voiceButton.style.background = '#00a884'; 
            voiceButton.style.color = '#111b21';
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mimeType = getSupportedAudioMimeType();
            recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
            chunks = [];

            recorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) chunks.push(event.data);
            };

            recorder.onstop = () => {
                stream.getTracks().forEach((track) => track.stop());
                const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });

                if (blob.size > 5 * 1024 * 1024) {
                    alert("Voice message is too large.");
                    return;
                }

                const reader = new FileReader();
                reader.onload = () => {
                    if (!isSafeDataUrl(reader.result, "audio/")) {
                        alert("Unsupported audio format.");
                        return;
                    }
                    socket.emit("chatMessage", { name: currentUser.name, type: "audio", data: reader.result });
                };
                reader.readAsDataURL(blob);
            };

            recorder.start();
            voiceButton.style.background = '#f15c6d'; 
            voiceButton.style.color = 'white';
        } catch (error) {
            console.warn("Microphone error:", error);
            alert("Microphone permission was not granted.");
        }
    });
}

function setupEverything() {
    updateUserUI();
    setupUserJoin();
    setupMemoryUpload();
    setupMemoryButton();
    setupChat();
    setupVoiceRecorder();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupEverything);
} else {
    setupEverything();
}
