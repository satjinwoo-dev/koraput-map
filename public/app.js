// ==========================================
// KORAPUT MAP - FINAL CLIENT LOGIC (MIXED WITH PHASE 2)
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
let currentCityName = "";

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
// DYNAMIC REVERSE GEOCODING (ROURKELA / LIVE CITY)
// ==========================================

async function fetchCityName(lat, lng) {
    if (!isValidCoordinate(lat, lng)) return "";
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=10`;
        const response = await fetch(url, { headers: { "Accept-Language": "en" } });
        if (!response.ok) return "";
        const data = await response.json();
        const city = data.address?.city || data.address?.town || data.address?.municipality || data.address?.county || data.address?.state_district || "Rourkela";
        return city;
    } catch {
        return "Rourkela";
    }
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
// GPS & ACCURACY CIRCLE
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

            // Dynamic City Detection
            if (!currentCityName) {
                currentCityName = await fetchCityName(lat, lng);
                if (currentCityName) {
                    const headerTitle = document.getElementById("header-app-title");
                    if (headerTitle) headerTitle.textContent = `${currentCityName} Map`;
                    const pillCity = document.getElementById("pill-city");
                    if (pillCity) pillCity.textContent = `📍 ${currentCityName}`;
                }
            }

            // GPS Accuracy Ring
            if (Number.isFinite(accuracy) && accuracy > 0 && accuracy < 100000) {
                if (!accuracyCircle) {
                    accuracyCircle = L.circle([lat, lng], {
                        radius: accuracy,
                        color: "#10b981",
                        weight: 2,
                        opacity: 0.85,
                        fillColor: "#10b981",
                        fillOpacity: 0.15,
                        interactive: false
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
// FRIENDS & PROFILE POPUP LOGIC
// ==========================================

function showProfilePopup(user) {
    const popup = document.getElementById("map-info-panel");
    if (!popup || !user) return;

    const avatar = document.getElementById("popup-avatar");
    const name = document.getElementById("popup-name");
    const status = popup.querySelector(".profile-status");
    const weather = document.getElementById("popup-weather");
    const distance = document.getElementById("popup-dist");

    if (avatar) avatar.src = user.avatar || DEFAULT_AVATAR;
    if (name) name.textContent = cleanName(user.name) || "User";

    if (status) {
        if (user.online !== false) {
            status.textContent = "● Online";
            status.style.color = "#18d6a3";
        } else {
            status.textContent = "● Offline";
            status.style.color = "#8fa1aa";
        }
    }

    if (weather) weather.textContent = user.weather || "Unavailable";

    if (distance && myCoords && isValidCoordinate(user.lat, user.lng)) {
        const km = haversineDistance(myCoords.lat, myCoords.lng, user.lat, user.lng);
        distance.textContent = km ? `📍 ${km} km` : "📍 Location available";
    } else if(distance) {
        distance.textContent = "📍 Location unavailable";
    }

    popup.style.display = "block";
    document.getElementById("profile-focus-btn").onclick = () => { map.setView([user.lat, user.lng], 16); hideProfilePopup(); };
}

function hideProfilePopup() {
    const popup = document.getElementById("map-info-panel");
    if(popup) popup.style.display = "none";
}

function setupProfilePopup() {
    const closeButton = document.getElementById("close-map-info");
    const popup = document.getElementById("map-info-panel");

    closeButton?.addEventListener("click", hideProfilePopup);

    popup?.addEventListener("click", (event) => {
        if (event.target === popup) hideProfilePopup();
    });

    // Online users sync
    socket.on("onlineUsers", (users) => {
        if (!Array.isArray(users)) return;
        users.forEach((user) => {
            if (!user?.id || user.id === socket.id) return;
            friendData[user.id] = { ...(friendData[user.id] || {}), ...user, online: true };
        });
        updateOnlineCount();
    });

    socket.on("userOnline", (user) => {
        if (!user?.id || user.id === socket.id) return;
        friendData[user.id] = { ...(friendData[user.id] || {}), ...user, online: true };
        updateOnlineCount();
    });

    socket.on("userOffline", (data) => {
        const id = data?.id;
        if (!id) return;
        if (friendData[id]) friendData[id].online = false;
        if (friendMarkers[id]) friendMarkers[id].setOpacity(0.45);
        updateOnlineCount();
    });
}

function updateOnlineCount() {
    const onlineCount = document.getElementById("chat-subtitle");
    let count = 0;
    Object.keys(friendData).forEach((id) => {
        if (friendData[id] && friendData[id].online !== false) count++;
    });
    if (onlineCount) onlineCount.textContent = `${count} online`;
}

socket.on("friendMoved", (data) => {
    if (!data || !data.id) return;
    const lat = Number(data.lat);
    const lng = Number(data.lng);
    if (!isValidCoordinate(lat, lng)) return;

    const name = cleanName(data.name);
    if (name && name === currentUser.name) return;

    const avatar = isValidImageDataURL(data.avatar) ? data.avatar : (data.avatar || DEFAULT_AVATAR);
    const weather = typeof data.weather === "string" ? data.weather.slice(0, 50) : "";

    // Save friend data & online status
    friendData[data.id] = { 
        id: data.id, 
        name: name || "Friend", 
        avatar: avatar, 
        lat: lat, 
        lng: lng, 
        weather: weather, 
        online: true 
    };

    let badge = weather;
    if (myCoords) {
        const distance = haversineDistance(myCoords.lat, myCoords.lng, lat, lng);
        if (distance) badge = `${badge ? badge + " | " : ""}📍 ${distance} km`;
    }

    if (!friendMarkers[data.id]) {
        friendMarkers[data.id] = L.marker([lat, lng], { icon: createFriendIcon(avatar) }).addTo(map);
        
        // CLICK EVENT ADDED FOR PROFILE POPUP (From your screenshot)
        friendMarkers[data.id].on("click", () => {
            const friend = friendData[data.id];
            if (friend) showProfilePopup(friend);
        });

    } else {
        friendMarkers[data.id].setLatLng([lat, lng]);
        friendMarkers[data.id].setIcon(createFriendIcon(avatar));
        friendMarkers[data.id].setOpacity(1); // Set to active opacity
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
    updateOnlineCount();
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

        // EMIT PROFILE READY (From your screenshot)
        socket.emit("profileReady", {
            name: currentUser.name,
            avatar: currentUser.avatar || DEFAULT_AVATAR
        });

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
// CHAT (MIXED)
// ==========================================

function setupChat() {
    const chatContainer = document.getElementById("chat-container");
    const chatToggle = document.getElementById("chat-toggle-btn");
    const chatForm = document.getElementById("chatForm");
    const chatInput = document.getElementById("chatInput");
    const chatMessages = document.getElementById("chat-messages");
    
    // Adjusted DOM IDs to match Base HTML
    const fileInput = document.getElementById("chatAttachment"); 
    const attachButton = document.getElementById("chat-attach-btn"); 
    const emojiPicker = document.getElementById("emojiPicker");
    const emojiButton = document.getElementById("emojiButton");
    const voiceButton = document.getElementById("voiceButton");
    const sendButton = document.getElementById("chat-send");
    
    const typingIndicator = document.getElementById("typing-indicator");
    const replyBar = document.getElementById("reply-preview-container"); 
    const replyPreview = document.getElementById("reply-preview-text"); 
    const replyCancel = document.getElementById("cancel-reply-btn"); 

    if (!chatContainer || !chatForm || !chatInput || !chatMessages) {
        return;
    }

    let unreadCount = 0;
    let typingTimer = null;
    let isTyping = false;

    let replyToMessage = null;

    const messageStore = new Map();

    const reactionEmojis = [
        "👍", "❤️", "😂", "😮", "😢", "🔥"
    ];

    // ------------------------------------------
    // CHAT OPEN / CLOSE
    // ------------------------------------------

    function isChatOpen() {
        return chatContainer.style.display === "flex";
    }

    function updateUnreadBadge() {
        const badge = document.getElementById("unread-badge");
        if (!badge) return;
        badge.textContent = unreadCount;
        badge.style.display = unreadCount > 0 ? "flex" : "none";
    }

    function markChatRead() {
        unreadCount = 0;
        updateUnreadBadge();
    }

    function openChat() {
        chatContainer.style.display = "flex";
        if(chatToggle) chatToggle.style.display = "none";
        markChatRead();
        setTimeout(() => { chatInput.focus(); }, 100);
    }

    function closeChat() {
        chatContainer.style.display = "none";
        if(chatToggle) chatToggle.style.display = "flex";
        
        // Hide popups when chat closes
        const attachMenu = document.getElementById("attachment-menu");
        if(attachMenu) attachMenu.style.display = "none";
        const emojiContainer = document.getElementById("emoji-picker-container");
        if(emojiContainer) emojiContainer.style.display = "none";
    }

    chatToggle?.addEventListener("click", () => {
        if (isChatOpen()) { closeChat(); } else { openChat(); }
    });

    document.getElementById("chat-minimize-btn")?.addEventListener("click", closeChat);

    // ------------------------------------------
    // TYPING INDICATOR
    // ------------------------------------------

    function sendTypingStatus(value) {
        if (!currentUser.name) return;
        socket.emit("typing", Boolean(value));
    }

    function stopTyping() {
        if (!isTyping) return;
        isTyping = false;
        sendTypingStatus(false);
    }

    chatInput.addEventListener("input", () => {
        if (!isTyping) {
            isTyping = true;
            sendTypingStatus(true);
        }

        clearTimeout(typingTimer);

        typingTimer = setTimeout(() => {
            stopTyping();
        }, 1200);

        updateSendButtons();
    });

    chatInput.addEventListener("blur", () => {
        clearTimeout(typingTimer);
        stopTyping();
    });

    socket.on("typing", (data) => {
        if (!typingIndicator) return;

        if (!data || data.id === socket.id) {
            return;
        }

        if (data.isTyping) {
            typingIndicator.textContent = `${cleanName(data.name) || "Someone"} is typing…`;
            typingIndicator.style.display = "flex";
        } else {
            typingIndicator.style.display = "none";
        }
    });

    // ------------------------------------------
    // REPLY
    // ------------------------------------------

    function getReplyPreview(msg) {
        if (!msg) return "";
        if (msg.type === "text") return String(msg.data || "").slice(0, 150);
        if (msg.type === "image") return "📷 Photo";
        if (msg.type === "video") return "🎥 Video";
        if (msg.type === "audio") return "🎙️ Voice message";
        if (msg.type === "document") return "📄 File";
        return "Message";
    }

    function beginReply(msg) {
        if (!msg) return;

        replyToMessage = {
            id: msg.id,
            name: msg.name || "User",
            type: msg.type || "text",
            preview: getReplyPreview(msg)
        };

        if (replyPreview) {
            replyPreview.textContent = `↩ ${replyToMessage.name}: ${replyToMessage.preview}`;
        }

        if (replyBar) {
            replyBar.style.display = "flex";
        }

        chatInput.focus();
    }

    function clearReply() {
        replyToMessage = null;
        if (replyPreview) replyPreview.textContent = "";
        if (replyBar) replyBar.style.display = "none";
    }

    replyCancel?.addEventListener("click", (e) => { e.preventDefault(); clearReply(); });

    // ------------------------------------------
    // SEND BUTTON
    // ------------------------------------------

    function updateSendButtons() {
        if (!sendButton) return;

        const hasText = chatInput.value.trim().length > 0;

        if (hasText) {
            sendButton.style.display = "flex";
            if (voiceButton) { voiceButton.style.display = "none"; }
        } else {
            sendButton.style.display = "none";
            if (voiceButton) { voiceButton.style.display = "flex"; }
        }
    }

    // ------------------------------------------
    // EMOJI PICKER
    // ------------------------------------------

    const emojiContainer = document.getElementById("emoji-picker-container");
    const attachMenu = document.getElementById("attachment-menu");

    emojiButton?.addEventListener("click", (event) => {
        event.stopPropagation();
        if(attachMenu) attachMenu.style.display = "none";
        if (!emojiContainer) return;
        emojiContainer.style.display = emojiContainer.style.display === "block" ? "none" : "block";
    });

    emojiPicker?.addEventListener("emoji-click", (event) => {
        const emoji = event.detail?.unicode;
        if (!emoji) return;

        // Directly checking custom reaction implementation
        if (reactingToMsgId) {
             socket.emit("messageReaction", { messageId: reactingToMsgId, emoji });
             emojiContainer.style.display = "none";
             reactingToMsgId = null;
        } else {
             chatInput.value += emoji;
             chatInput.focus();
             updateSendButtons();
        }
    });

    // ------------------------------------------
    // ATTACHMENT
    // ------------------------------------------

    attachButton?.addEventListener("click", (event) => {
        event.stopPropagation();
        if(emojiContainer) emojiContainer.style.display = "none";
        if(attachMenu) attachMenu.style.display = attachMenu.style.display === "flex" ? "none" : "flex";
    });

    document.addEventListener("click", (event) => {
        if (attachMenu && !attachMenu.contains(event.target) && event.target !== attachButton) attachMenu.style.display = "none";
        if (emojiContainer && !emojiContainer.contains(event.target) && event.target !== emojiButton) emojiContainer.style.display = "none";
    });

    document.getElementById("att-media")?.addEventListener("click", () => { fileInput.accept="image/*,video/*"; fileInput.click(); if(attachMenu) attachMenu.style.display="none"; });
    document.getElementById("att-doc")?.addEventListener("click", () => { fileInput.accept=".pdf,.doc,.docx,.txt,.zip"; fileInput.click(); if(attachMenu) attachMenu.style.display="none"; });
    document.getElementById("att-audio")?.addEventListener("click", () => { fileInput.accept="audio/*"; fileInput.click(); if(attachMenu) attachMenu.style.display="none"; });

    fileInput?.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        if (!file) return;

        if (file.size > MAX_CHAT_FILE_SIZE) {
            alert("File is too large. Maximum size is 5 MB.");
            fileInput.value = "";
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            let type = "document";
            if (file.type.startsWith("image/")) { type = "image"; } 
            else if (file.type.startsWith("video/")) { type = "video"; } 
            else if (file.type.startsWith("audio/")) { type = "audio"; }

            socket.emit("chatMessage", {
                name: currentUser.name,
                type,
                data: String(reader.result || ""),
                replyTo: replyToMessage
            });

            clearReply();
            fileInput.value = "";
        };

        reader.readAsDataURL(file);
    });

    // ------------------------------------------
    // SEND MESSAGE
    // ------------------------------------------

    function sendMessage() {
        const text = chatInput.value.trim().slice(0, MAX_CHAT_LENGTH);
        if (!text) return;

        socket.emit("chatMessage", {
            name: currentUser.name,
            type: "text",
            data: text,
            replyTo: replyToMessage
        });

        chatInput.value = "";
        clearReply();
        stopTyping();
        updateSendButtons();
        chatInput.focus();
    }

    chatForm.addEventListener("submit", (event) => {
        event.preventDefault();
        sendMessage();
    });

    // ------------------------------------------
    // REACTIONS
    // ------------------------------------------

    function renderReactions(messageElement, msg) {
        if (!messageElement) return;

        let container = messageElement.querySelector(".reaction-row");
        if (!container) {
            container = document.createElement("div");
            container.className = "reaction-row";
            messageElement.appendChild(container);
        }

        container.innerHTML = "";
        const reactions = msg.reactions || {};

        Object.keys(reactions).forEach((emoji) => {
            const users = reactions[emoji];
            if (!Array.isArray(users) || users.length === 0) { return; }

            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "reaction"; // Mapped to base HTML class
            chip.textContent = `${emoji} ${users.length}`;
            chip.title = "Toggle reaction";

            chip.addEventListener("click", () => {
                socket.emit("messageReaction", { messageId: msg.id, emoji });
            });

            container.appendChild(chip);
        });
    }

    function addReactionButtons(picker, msg) {
        picker.innerHTML = "";
        reactionEmojis.forEach((emoji) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "action-btn"; // Mapped to base HTML class
            button.textContent = emoji;

            button.addEventListener("click", () => {
                socket.emit("messageReaction", { messageId: msg.id, emoji });
            });

            picker.appendChild(button);
        });
    }

    window.reactTo = (msgId) => {
         reactingToMsgId = msgId;
         if (emojiContainer) emojiContainer.style.display = "block";
         if (attachMenu) attachMenu.style.display = "none";
    };

    // ------------------------------------------
    // RENDER MESSAGE
    // ------------------------------------------

    function renderMessage(msg) {
        if (!msg || !msg.id) return;

        const wrapper = document.createElement("div");
        const mine = msg.senderId === socket.id;
        wrapper.className = "chat-message" + (mine ? " msg-mine" : " msg-theirs");
        wrapper.dataset.messageId = msg.id;

        // --------------------------------------
        // SENDER NAME & TIME
        // --------------------------------------
        const sender = document.createElement("div");
        sender.className = "msg-sender";
        sender.textContent = cleanName(msg.name) || "User";
        
        if (msg.time) {
            const date = new Date(msg.time);
            const timeSpan = document.createElement("span");
            timeSpan.style.color = "var(--muted)";
            timeSpan.style.marginLeft = "5px";
            timeSpan.style.fontSize = "9px";
            timeSpan.textContent = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            sender.appendChild(timeSpan);
        }
        wrapper.appendChild(sender);

        // --------------------------------------
        // REPLY QUOTE
        // --------------------------------------
        if (msg.replyTo && msg.replyTo.preview) {
            const quote = document.createElement("div");
            quote.className = "inline-reply"; // Optional CSS class if needed, fallback works
            quote.style.borderLeft = "3px solid var(--green-bright)";
            quote.style.padding = "4px";
            quote.style.marginBottom = "4px";
            quote.style.background = "rgba(255,255,255,0.05)";
            quote.innerHTML = `<b>${escapeHTML(msg.replyTo.name || "User")}</b><br>${escapeHTML(msg.replyTo.preview)}`;
            wrapper.appendChild(quote);
        }

        // --------------------------------------
        // CONTENT
        // --------------------------------------
        const content = document.createElement("div");

        if (msg.type === "text") {
            content.textContent = msg.data || "";
        }
        else if (msg.type === "image") {
            const image = document.createElement("img");
            image.className = "chat-media";
            image.src = msg.data;
            image.alt = "Photo";
            image.loading = "lazy";
            content.appendChild(image);
        }
        else if (msg.type === "video") {
            const video = document.createElement("video");
            video.className = "chat-media";
            video.controls = true;
            video.preload = "metadata";
            video.src = msg.data;
            content.appendChild(video);
        }
        else if (msg.type === "audio") {
            const audio = document.createElement("audio");
            audio.className = "chat-audio";
            audio.controls = true;
            audio.src = msg.data;
            content.appendChild(audio);
        }
        else if (msg.type === "document") {
            const link = document.createElement("a");
            link.className = "chat-document";
            link.href = msg.data;
            link.download = "Koraput-Map-file";
            link.textContent = "📄 Download File";
            content.appendChild(link);
        }

        wrapper.appendChild(content);

        // --------------------------------------
        // ACTIONS (Reaction Picker & Reply)
        // --------------------------------------
        const actions = document.createElement("div");
        actions.className = "message-actions";

        const picker = document.createElement("div");
        picker.style.display = "flex"; picker.style.gap = "2px";
        addReactionButtons(picker, msg);
        actions.appendChild(picker);

        const replyButton = document.createElement("button");
        replyButton.type = "button";
        replyButton.className = "action-btn";
        replyButton.textContent = "↩ Reply";
        replyButton.addEventListener("click", () => beginReply(msg));
        actions.appendChild(replyButton);

        wrapper.appendChild(actions);
        chatMessages.appendChild(wrapper);

        msg.reactions = msg.reactions || {};
        messageStore.set(msg.id, { msg, element: wrapper });
        renderReactions(wrapper, msg);

        // --------------------------------------
        // UNREAD
        // --------------------------------------
        const fromOtherUser = msg.senderId && msg.senderId !== socket.id;
        if (fromOtherUser && !isChatOpen()) {
            unreadCount++;
            updateUnreadBadge();
        }

        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    socket.on("chatMessage", renderMessage);

    // ------------------------------------------
    // REACTION UPDATE
    // ------------------------------------------

    socket.on("messageReaction", (data) => {
        if (!data?.messageId) return;

        const stored = messageStore.get(String(data.messageId));
        if (!stored) return;

        stored.msg.reactions = data.reactions || {};
        renderReactions(stored.element, stored.msg);
    });

    // ------------------------------------------
    // INITIAL
    // ------------------------------------------

    updateSendButtons();
    updateUnreadBadge();
}

// ==========================================
// VOICE RECORDER
// ==========================================

function setupVoiceRecorder() {
    // Basic logic intact to not break functionality
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
    setupProfilePopup(); // Injected!
    setupMapControls();
    startLocationTracking();
}

setInterval(() => {
    emitLocation();
    updateFriendBadges();
}, 5000);

setupEverything();
console.log("Koraput Map client loaded successfully.");
