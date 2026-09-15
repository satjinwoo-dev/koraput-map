// ============================================================
// KORAPUT MAP — ULTIMATE FINAL CLIENT (PHASE 1 + 2 + 3)
// ============================================================

"use strict";

const socket = io({
    transports: ["websocket", "polling"]
});

// ==========================================
// CONSTANTS & STATE
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

let ownMarker = null;
let accuracyCircle = null;
let firstLocationFix = true;
let locationWatchId = null;
let myCoords = null;
let currentWeatherData = "";
let currentCityName = "";

const friendMarkers = Object.create(null);
const friendData = Object.create(null);

// Phase 3 State
const memories = new Map();
let currentGalleryFilter = "all";
let currentGallerySearch = "";
let selectedMemoryId = null;

let currentUser = {
    name: localStorage.getItem("koraput_name") || "",
    avatar: localStorage.getItem("koraput_avatar") || DEFAULT_AVATAR
};

// ==========================================
// INITIALIZE MAP
// ==========================================

const map = L.map("map", {
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true
}).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

const memoryLayer = L.layerGroup().addTo(map);

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
// SOCKET STATUS
// ==========================================

socket.on("connect", () => {
    console.log("Connected:", socket.id);
    if (currentUser.name) {
        socket.emit("profileReady", {
            name: currentUser.name,
            avatar: currentUser.avatar || DEFAULT_AVATAR
        });
    }
});

socket.on("disconnect", () => console.log("Disconnected from server."));
socket.on("connect_error", (error) => console.warn("Socket connection error:", error.message));

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
    return String(name || "User").trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
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

function getMemoryDate(memory) {
    const date = new Date(memory?.time || 0);
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(timeValue) {
    if (!timeValue) return "Unknown date";
    const date = new Date(timeValue);
    if (Number.isNaN(date.getTime())) return String(timeValue);
    return date.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

function formatTime(timeValue) {
    if (!timeValue) return "";
    const date = new Date(timeValue);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ==========================================
// DYNAMIC REVERSE GEOCODING & WEATHER
// ==========================================

async function fetchCityName(lat, lng) {
    if (!isValidCoordinate(lat, lng)) return "";
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=10`;
        const response = await fetch(url, { headers: { "Accept-Language": "en" } });
        if (!response.ok) return "";
        const data = await response.json();
        return data.address?.city || data.address?.town || data.address?.municipality || data.address?.county || data.address?.state_district || "Rourkela";
    } catch {
        return "Rourkela";
    }
}

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

            if (!currentCityName) {
                currentCityName = await fetchCityName(lat, lng);
                if (currentCityName) {
                    const headerTitle = document.getElementById("header-app-title");
                    const pillCity = document.getElementById("pill-city");
                    if (headerTitle) headerTitle.textContent = `${currentCityName} Map`;
                    if (pillCity) pillCity.textContent = `📍 ${currentCityName}`;
                }
            }

            if (Number.isFinite(accuracy) && accuracy > 0 && accuracy < 100000) {
                if (!accuracyCircle) {
                    accuracyCircle = L.circle([lat, lng], {
                        radius: accuracy, color: "#10b981", weight: 2, opacity: 0.85,
                        fillColor: "#10b981", fillOpacity: 0.15, interactive: false
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
                ownMarker.setIcon(createOwnIcon(currentUser.avatar));
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
            updateFriendBadges();
        },
        (error) => {
            console.warn("GPS Error:", error.message);
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
    );
}

// ==========================================
// FRIENDS & PROFILE POPUPS
// ==========================================

function showProfilePopup(user) {
    const popup = document.getElementById("profile-popup");
    if (!popup || !user) return;

    const avatar = document.getElementById("profile-popup-avatar");
    const name = document.getElementById("profile-popup-name");
    const status = document.getElementById("profile-popup-status");
    const weather = document.getElementById("profile-popup-weather");
    const distance = document.getElementById("profile-popup-distance");

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

    if (weather) weather.textContent = user.weather || "Weather unavailable";

    if (distance && myCoords && isValidCoordinate(user.lat, user.lng)) {
        const km = haversineDistance(myCoords.lat, myCoords.lng, user.lat, user.lng);
        distance.textContent = km ? `📍 ${km} km away` : "📍 Location available";
    } else {
        if (distance) distance.textContent = "📍 Location unavailable";
    }

    popup.style.display = "flex";

    const focusButton = document.getElementById("profile-focus-btn");
    if (focusButton) {
        focusButton.onclick = () => {
            if (isValidCoordinate(user.lat, user.lng)) {
                map.flyTo([user.lat, user.lng], 16, { animate: true, duration: 0.8 });
            }
            hideProfilePopup();
        };
    }
}

function hideProfilePopup() {
    const popup = document.getElementById("profile-popup");
    if (popup) popup.style.display = "none";
}

function setupProfilePopup() {
    const closeButton = document.getElementById("profile-popup-close");
    const popup = document.getElementById("profile-popup");

    closeButton?.addEventListener("click", hideProfilePopup);
    popup?.addEventListener("click", (event) => {
        if (event.target === popup) hideProfilePopup();
    });
}

function updateOnlineCount() {
    let friendCount = 0;
    Object.keys(friendData).forEach((id) => {
        if (friendData[id] && friendData[id].online !== false) friendCount++;
    });

    const totalOnline = currentUser.name ? friendCount + 1 : friendCount;
    const elements = [
        document.getElementById("online-count"),
        document.getElementById("header-online-status"),
        document.getElementById("chat-subtitle")
    ];

    elements.forEach((element) => {
        if (element) element.textContent = `${totalOnline} online`;
    });
}

function renderOnlineList() {
    const box = document.getElementById("online-friends");
    if (!box) return;
    box.innerHTML = "";

    const activeFriends = Object.values(friendData).filter(f => f.online !== false);
    if (activeFriends.length === 0) {
        box.innerHTML = `<div style="color:#91a2ab;font-size:12px;padding:5px 0;">No friends online</div>`;
        return;
    }

    activeFriends.forEach(user => {
        const row = document.createElement("div");
        row.className = "online-friend";
        row.innerHTML = `<img src="${escapeHTML(user.avatar || DEFAULT_AVATAR)}"><span>${escapeHTML(user.name || "Friend")}</span><div class="status-dot"></div>`;
        row.addEventListener("click", () => {
             if (isValidCoordinate(user.lat, user.lng)) {
                 map.flyTo([user.lat, user.lng], 16, { animate: true });
                 showProfilePopup(user);
             }
        });
        box.appendChild(row);
    });
}

function createOrUpdateFriendMarker(user) {
    if (!user?.id) return;
    const lat = Number(user.lat);
    const lng = Number(user.lng);

    if (!isValidCoordinate(lat, lng)) return;

    const id = user.id;
    const name = cleanName(user.name) || "Friend";
    const avatar = isValidImageDataURL(user.avatar) ? user.avatar : (user.avatar || DEFAULT_AVATAR);
    const weather = typeof user.weather === "string" ? user.weather.slice(0, 50) : "";

    friendData[id] = {
        ...(friendData[id] || {}),
        id, name, avatar, lat, lng, weather,
        online: user.online !== false
    };

    if (!friendMarkers[id]) {
        friendMarkers[id] = L.marker([lat, lng], { icon: createFriendIcon(avatar) }).addTo(map);
        friendMarkers[id].on("click", () => {
            const friend = friendData[id];
            if (friend) showProfilePopup(friend);
        });
    } else {
        friendMarkers[id].setLatLng([lat, lng]);
        friendMarkers[id].setIcon(createFriendIcon(avatar));
        friendMarkers[id].setOpacity(user.online === false ? 0.45 : 1);
    }

    updateFriendMarkerTooltip(id);
}

function updateFriendMarkerTooltip(id) {
    const marker = friendMarkers[id];
    const friend = friendData[id];

    if (!marker || !friend) return;

    let badge = friend.weather || "";

    if (myCoords && isValidCoordinate(friend.lat, friend.lng)) {
        const distance = haversineDistance(myCoords.lat, myCoords.lng, friend.lat, friend.lng);
        if (distance) badge = `${badge ? badge + " | " : ""}📍 ${distance} km`;
    }

    marker.unbindTooltip();

    if (badge) {
        marker.bindTooltip(badge, {
            permanent: true, direction: "right", className: "weather-badge", offset: [15, 0]
        });
    }
}

function updateFriendBadges() {
    if (!myCoords) return;
    Object.keys(friendMarkers).forEach((id) => { updateFriendMarkerTooltip(id); });
}

// Socket Events for Online/Offline
socket.on("onlineUsers", (users) => {
    if (!Array.isArray(users)) return;
    users.forEach((user) => {
        if (!user?.id || user.id === socket.id) return;
        friendData[user.id] = { ...(friendData[user.id] || {}), ...user, online: true };
        if (isValidCoordinate(user.lat, user.lng)) createOrUpdateFriendMarker(user);
    });
    updateOnlineCount();
    renderOnlineList();
});

socket.on("userOnline", (user) => {
    if (!user?.id || user.id === socket.id) return;
    friendData[user.id] = { ...(friendData[user.id] || {}), ...user, online: true };
    if (isValidCoordinate(user.lat, user.lng)) createOrUpdateFriendMarker(user);
    updateOnlineCount();
    renderOnlineList();
});

socket.on("userOffline", (data) => {
    const id = data?.id;
    if (!id) return;
    if (friendData[id]) friendData[id].online = false;
    if (friendMarkers[id]) friendMarkers[id].setOpacity(0.45);
    updateOnlineCount();
    renderOnlineList();
});

socket.on("friendMoved", (data) => {
    if (!data?.id) return;
    const lat = Number(data.lat);
    const lng = Number(data.lng);
    if (!isValidCoordinate(lat, lng)) return;
    if (cleanName(data.name) === currentUser.name) return;

    createOrUpdateFriendMarker({ ...data, lat, lng, online: true });
    updateOnlineCount();
});

socket.on("friendDisconnected", (id) => {
    if (!id) return;
    if (friendMarkers[id]) {
        map.removeLayer(friendMarkers[id]);
        delete friendMarkers[id];
    }
    if (friendData[id]) delete friendData[id];
    updateOnlineCount();
    renderOnlineList();
});

// ==========================================
// PHASE 3 - MEMORIES UI INJECTION
// ==========================================

function injectPhase3UI() {
    if (document.getElementById("phase3-memory-style")) return;

    // Inject CSS
    const style = document.createElement("style");
    style.id = "phase3-memory-style";
    style.textContent = `
        /* HIDE OLD APP.JS PINS */
        .custom-pin { display: none !important; }

        /* GALLERY BUTTON */
        #phase3-gallery-btn {
            position: fixed; right: 14px; top: 140px; z-index: 1000;
            width: 42px; height: 42px; border: 1px solid rgba(255,255,255,0.10); border-radius: 13px;
            background: rgba(7,16,24,0.91); color: white; display: flex; align-items: center; justify-content: center;
            font-size: 18px; box-shadow: 0 12px 40px rgba(0,0,0,0.55); backdrop-filter: blur(14px); cursor: pointer; transition: transform 0.15s;
        }
        #phase3-gallery-btn:hover { background: rgba(16,185,129,0.18); }
        
        /* OVERLAY */
        #phase3-memory-overlay {
            position: fixed; inset: 0; z-index: 8000; display: none;
            background: rgba(0,0,0,0.65); backdrop-filter: blur(8px);
        }
        #phase3-memory-panel {
            position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
            width: min(760px, calc(100vw - 24px)); height: min(680px, calc(100vh - 30px));
            overflow: hidden; display: flex; flex-direction: column;
            background: #0b151c; border: 1px solid rgba(255,255,255,0.10); border-radius: 22px;
            box-shadow: 0 30px 100px rgba(0,0,0,0.75);
        }
        #phase3-memory-header {
            flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
            padding: 15px 17px; border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        #phase3-memory-title { display: flex; flex-direction: column; }
        #phase3-memory-title strong { font-size: 16px; color: white; }
        #phase3-memory-title span { margin-top: 3px; font-size: 10px; color: #84949d; }
        #phase3-memory-close {
            width: 34px; height: 34px; border: 0; border-radius: 10px;
            background: rgba(255,255,255,0.06); color: white; font-size: 19px; cursor: pointer;
        }
        #phase3-memory-filters {
            display: flex; gap: 6px; padding: 10px 13px; overflow-x: auto;
            border-bottom: 1px solid rgba(255,255,255,0.06); align-items: center;
        }
        .phase3-filter {
            flex: 0 0 auto; padding: 7px 11px; border: 1px solid rgba(255,255,255,0.08); border-radius: 999px;
            background: rgba(255,255,255,0.04); color: #aab7bd; font-size: 10px; cursor: pointer;
        }
        .phase3-filter.active { background: rgba(16,185,129,0.16); border-color: rgba(24,214,163,0.35); color: #18d6a3; }
        #phase3-memory-search {
            flex: 1; min-width: 120px; border: 1px solid rgba(255,255,255,.10); border-radius: 999px;
            padding: 7px 11px; background: rgba(255,255,255,.04); color: white; outline: none; font-size: 10px;
        }
        
        #phase3-memory-content { flex: 1; min-height: 0; overflow-y: auto; padding: 13px; }
        #phase3-memory-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
        .phase3-memory-card { position: relative; aspect-ratio: 1 / 1; overflow: hidden; border-radius: 13px; background: #111d24; border: 1px solid rgba(255,255,255,0.08); cursor: pointer; }
        .phase3-memory-card img { width: 100%; height: 100%; display: block; object-fit: cover; transition: transform 0.25s ease; }
        .phase3-memory-card:hover img { transform: scale(1.05); }
        .phase3-memory-card-info { position: absolute; left: 0; right: 0; bottom: 0; padding: 24px 8px 8px; background: linear-gradient(transparent, rgba(0,0,0,0.8)); color: white; }
        .phase3-memory-card-name { font-size: 10px; font-weight: 700; }
        .phase3-memory-card-date { margin-top: 2px; color: #bdc8cd; font-size: 8px; }
        #phase3-memory-empty { padding: 50px 20px; text-align: center; color: #819099; font-size: 12px; }
        
        /* VIEWER */
        #phase3-photo-viewer { position: fixed; inset: 0; z-index: 9000; display: none; align-items: center; justify-content: center; padding: 18px; background: rgba(0,0,0,0.88); backdrop-filter: blur(7px); }
        #phase3-photo-card { width: min(700px, 100%); max-height: calc(100vh - 36px); overflow: hidden; display: flex; flex-direction: column; border: 1px solid rgba(255,255,255,0.12); border-radius: 20px; background: #0c171e; box-shadow: 0 30px 100px rgba(0,0,0,0.8); }
        #phase3-photo-image { width: 100%; max-height: 60vh; object-fit: contain; background: #020608; }
        #phase3-photo-info { padding: 15px; }
        #phase3-photo-name { color: white; font-size: 16px; font-weight: 750; }
        #phase3-photo-date { margin-top: 4px; color: #8999a2; font-size: 10px; }
        #phase3-photo-location { margin-top: 10px; padding: 9px 11px; border-radius: 10px; background: rgba(255,255,255,0.05); color: #c9d3d8; font-size: 10px; }
        #phase3-photo-actions { display: flex; gap: 7px; margin-top: 10px; }
        .phase3-photo-action { flex: 1; padding: 10px; border: 0; border-radius: 10px; background: rgba(16,185,129,0.16); color: #18d6a3; font-size: 11px; font-weight: 700; cursor: pointer; }
        #phase3-photo-close { background: rgba(255,255,255,0.07); color: #d5dde0; }

        /* TIMELINE */
        #phase3-memory-timeline { margin-top: 20px; }
        .phase3-timeline-title { margin-bottom: 10px; color: white; font-size: 12px; font-weight: 750; }
        .phase3-timeline-item { display: flex; gap: 10px; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; }
        .phase3-timeline-thumb { flex: 0 0 52px; width: 52px; height: 52px; overflow: hidden; border-radius: 10px; }
        .phase3-timeline-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .phase3-timeline-info { min-width: 0; display: flex; flex-direction: column; justify-content: center; }
        .phase3-timeline-name { color: #e8eef0; font-size: 11px; font-weight: 700; }
        .phase3-timeline-date { margin-top: 3px; color: #84949d; font-size: 9px; }
        .phase3-timeline-location { margin-top: 3px; color: #6f8088; font-size: 8px; }

        /* LEAFLET POPUP OVERRIDES */
        .leaflet-popup-content-wrapper { background: #111b21 !important; color: #fff !important; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; box-shadow: 0 15px 40px rgba(0,0,0,0.6); }
        .leaflet-popup-tip { background: #111b21 !important; border: 1px solid rgba(255,255,255,0.1); }
        .leaflet-popup-close-button { color: #fff !important; }

        @media (max-width: 600px) {
            #phase3-gallery-btn { right: 10px; top: 128px; }
            #phase3-memory-panel { width: 100vw; height: 100dvh; border-radius: 0; border: 0; }
            #phase3-memory-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            #phase3-photo-card { width: 100%; border-radius: 16px; }
            #phase3-photo-image { max-height: 58vh; }
        }
    `;
    document.head.appendChild(style);

    // Inject Gallery Button
    const mapTools = document.getElementById("map-tools");
    if (mapTools) {
        const galleryBtn = document.createElement("button");
        galleryBtn.id = "phase3-gallery-btn";
        galleryBtn.type = "button";
        galleryBtn.title = "Memory Gallery";
        galleryBtn.textContent = "🖼️";
        galleryBtn.onclick = openGallery;
        mapTools.appendChild(galleryBtn);
    }

    // Inject Gallery Overlay
    const overlay = document.createElement("div");
    overlay.id = "phase3-memory-overlay";
    overlay.innerHTML = `
        <div id="phase3-memory-panel">
            <div id="phase3-memory-header">
                <div id="phase3-memory-title">
                    <strong>Memories</strong>
                    <span id="phase3-memory-count">0 memories</span>
                </div>
                <button id="phase3-memory-close" type="button">×</button>
            </div>
            <div id="phase3-memory-filters">
                <button class="phase3-filter active" data-filter="all" type="button">All</button>
                <button class="phase3-filter" data-filter="today" type="button">Today</button>
                <button class="phase3-filter" data-filter="week" type="button">Last 7 days</button>
                <button class="phase3-filter" data-filter="mine" type="button">Mine</button>
                <button class="phase3-filter" data-filter="others" type="button">Others</button>
                <input id="phase3-memory-search" type="text" placeholder="Search name...">
            </div>
            <div id="phase3-memory-content">
                <div id="phase3-memory-grid"></div>
                <div id="phase3-memory-empty">No memories yet.</div>
                <div id="phase3-memory-timeline">
                    <div class="phase3-timeline-title">Photo Timeline</div>
                    <div id="phase3-timeline-list"></div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Inject Photo Viewer
    const viewer = document.createElement("div");
    viewer.id = "phase3-photo-viewer";
    viewer.innerHTML = `
        <div id="phase3-photo-card">
            <img id="phase3-photo-image" src="" alt="Memory">
            <div id="phase3-photo-info">
                <div id="phase3-photo-name">Memory</div>
                <div id="phase3-photo-date">--</div>
                <div id="phase3-photo-location">📍 Location unavailable</div>
                <div id="phase3-photo-actions">
                    <button id="phase3-photo-focus" class="phase3-photo-action" type="button">📍 Focus on map</button>
                    <button id="phase3-photo-close" class="phase3-photo-action" type="button">Close</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(viewer);

    setupMemoryEvents();
}

function setupMemoryEvents() {
    document.getElementById("phase3-memory-close")?.addEventListener("click", closeGallery);
    document.getElementById("phase3-memory-overlay")?.addEventListener("click", (e) => {
        if (e.target.id === "phase3-memory-overlay") closeGallery();
    });

    document.getElementById("phase3-photo-close")?.addEventListener("click", closeViewer);
    document.getElementById("phase3-photo-viewer")?.addEventListener("click", (e) => {
        if (e.target.id === "phase3-photo-viewer") closeViewer();
    });

    document.getElementById("phase3-photo-focus")?.addEventListener("click", () => {
        const memory = memories.get(String(selectedMemoryId));
        if (!memory) return;
        if (isValidCoordinate(memory.lat, memory.lng)) {
            map.flyTo([Number(memory.lat), Number(memory.lng)], 17, { animate: true });
            closeViewer();
            closeGallery();
        }
    });

    document.querySelectorAll(".phase3-filter").forEach(button => {
        button.addEventListener("click", () => {
            currentGalleryFilter = button.dataset.filter || "all";
            document.querySelectorAll(".phase3-filter").forEach(item => item.classList.remove("active"));
            button.classList.add("active");
            refreshMemoryUI();
        });
    });

    document.getElementById("phase3-memory-search")?.addEventListener("input", (e) => {
        currentGallerySearch = e.target.value.toLowerCase();
        refreshMemoryUI();
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { closeViewer(); closeGallery(); }
    });
}

// ==========================================
// PHASE 3 - LOGIC & RENDERERS
// ==========================================

function openGallery() {
    const overlay = document.getElementById("phase3-memory-overlay");
    if (overlay) { overlay.style.display = "block"; refreshMemoryUI(); }
}

function closeGallery() {
    const overlay = document.getElementById("phase3-memory-overlay");
    if (overlay) overlay.style.display = "none";
}

function openViewer(memory) {
    if (!memory || typeof memory !== "object") return;
    selectedMemoryId = memory.id;

    const image = document.getElementById("phase3-photo-image");
    const name = document.getElementById("phase3-photo-name");
    const date = document.getElementById("phase3-photo-date");
    const location = document.getElementById("phase3-photo-location");

    if (image) image.src = memory.image || "";
    if (name) name.textContent = `📸 ${cleanName(memory.name)}`;
    if (date) date.textContent = `${formatDate(memory.time)} · ${formatTime(memory.time)}`;
    if (location) {
        if (isValidCoordinate(memory.lat, memory.lng)) location.textContent = `📍 ${Number(memory.lat).toFixed(5)}, ${Number(memory.lng).toFixed(5)}`;
        else location.textContent = "📍 Location unavailable";
    }

    const viewer = document.getElementById("phase3-photo-viewer");
    if (viewer) viewer.style.display = "flex";
}

function closeViewer() {
    const viewer = document.getElementById("phase3-photo-viewer");
    if (viewer) viewer.style.display = "none";
    selectedMemoryId = null;
}

function getFilteredMemories() {
    let result = Array.from(memories.values());

    if (currentGalleryFilter === "today") {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        result = result.filter(m => {
            const date = getMemoryDate(m);
            return date && date.getTime() >= start;
        });
    } else if (currentGalleryFilter === "week") {
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        result = result.filter(m => {
            const date = getMemoryDate(m);
            return date && date.getTime() >= weekAgo;
        });
    } else if (currentGalleryFilter === "mine") {
        result = result.filter(m => cleanName(m.name) === cleanName(currentUser.name));
    } else if (currentGalleryFilter === "others") {
        result = result.filter(m => cleanName(m.name) !== cleanName(currentUser.name));
    }

    if (currentGallerySearch) {
        result = result.filter(m => cleanName(m.name).toLowerCase().includes(currentGallerySearch));
    }

    result.sort((a, b) => {
        const da = getMemoryDate(a)?.getTime() || 0;
        const db = getMemoryDate(b)?.getTime() || 0;
        return db - da; // Newest first
    });

    return result;
}

function refreshMemoryUI() {
    const grid = document.getElementById("phase3-memory-grid");
    const empty = document.getElementById("phase3-memory-empty");
    const timeline = document.getElementById("phase3-timeline-list");
    const count = document.getElementById("phase3-memory-count");

    if (!grid || !empty || !timeline) return;

    const filtered = getFilteredMemories();

    if (count) count.textContent = `${filtered.length} ${filtered.length === 1 ? "memory" : "memories"}`;
    grid.innerHTML = "";
    timeline.innerHTML = "";
    empty.style.display = filtered.length === 0 ? "block" : "none";

    filtered.forEach(memory => {
        if (!memory.image) return;

        // Grid Card
        const card = document.createElement("div");
        card.className = "phase3-memory-card";
        card.innerHTML = `
            <img src="${escapeHTML(memory.image)}" alt="Memory" loading="lazy">
            <div class="phase3-memory-card-info">
                <div class="phase3-memory-card-name">${escapeHTML(memory.name || "Memory")}</div>
                <div class="phase3-memory-card-date">${escapeHTML(formatDate(memory.time))}</div>
            </div>
        `;
        card.addEventListener("click", () => openViewer(memory));
        grid.appendChild(card);

        // Timeline Item
        const item = document.createElement("div");
        item.className = "phase3-timeline-item";
        const coords = isValidCoordinate(memory.lat, memory.lng) ? `${Number(memory.lat).toFixed(4)}, ${Number(memory.lng).toFixed(4)}` : "Location unavailable";
        item.innerHTML = `
            <div class="phase3-timeline-thumb">
                <img src="${escapeHTML(memory.image || "")}" alt="Memory" loading="lazy">
            </div>
            <div class="phase3-timeline-info">
                <div class="phase3-timeline-name">${escapeHTML(memory.name || "Memory")}</div>
                <div class="phase3-timeline-date">${escapeHTML(formatDate(memory.time))} · ${escapeHTML(formatTime(memory.time))}</div>
                <div class="phase3-timeline-location">📍 ${escapeHTML(coords)}</div>
            </div>
        `;
        item.addEventListener("click", () => openViewer(memory));
        timeline.appendChild(item);
    });
}

function createMemoryIcon(memory) {
    return L.divIcon({
        className: "phase3-memory-marker",
        html: `
            <div style="width:46px; height:46px; border-radius:50%; overflow:hidden; background:#071018; border:2px solid white; box-shadow: 0 4px 15px rgba(0,0,0,0.65);">
                <img src="${escapeHTML(memory.image)}" style="width:100%; height:100%; object-fit:cover; display:block;" alt="Memory">
            </div>
        `,
        iconSize: [46, 46],
        iconAnchor: [23, 23]
    });
}

function renderMemoryMarkers() {
    memoryLayer.clearLayers();
    memories.forEach(memory => {
        if (!isValidCoordinate(memory.lat, memory.lng) || !memory.image) return;

        const marker = L.marker([Number(memory.lat), Number(memory.lng)], { icon: createMemoryIcon(memory) });

        marker.bindPopup(`
            <div style="width:230px; padding:3px; color:#111; text-align:center;">
                <img src="${escapeHTML(memory.image)}" style="width:100%; max-height:180px; object-fit:cover; border-radius:10px; display:block; margin-bottom:9px;" alt="Memory">
                <strong style="font-size:14px; color:#18d6a3;">📸 ${escapeHTML(memory.name || "Memory")}</strong>
                <div style="margin-top:4px; color:#8fa1aa; font-size:10px;">${escapeHTML(formatDate(memory.time))}</div>
                <button type="button" class="phase3-open-memory" style="width:100%; margin-top:9px; padding:8px; border:0; border-radius:8px; background:#10b981; color:white; font-weight:700; cursor:pointer;">View Memory</button>
            </div>
        `);

        marker.on("popupopen", event => {
            const popupElement = event.popup.getElement();
            if (!popupElement) return;
            const button = popupElement.querySelector(".phase3-open-memory");
            if (button) {
                button.onclick = () => openViewer(memory);
            }
        });

        marker.addTo(memoryLayer);
    });
}

function saveMemory(pin) {
    if (!pin || !pin.image || !isValidCoordinate(pin.lat, pin.lng)) return;
    const id = String(pin.id || `${pin.lat}_${pin.lng}_${pin.time}`);
    
    // Check duplicates
    let exists = false;
    memories.forEach(item => {
        if (item.id === id) exists = true;
        else if (item.image === pin.image && Number(item.lat) === Number(pin.lat) && Number(item.lng) === Number(pin.lng)) exists = true;
    });

    if (exists) return;

    memories.set(id, { ...pin, id, lat: Number(pin.lat), lng: Number(pin.lng), name: cleanName(pin.name) });
    
    renderMemoryMarkers();
    if (document.getElementById("phase3-memory-overlay")?.style.display === "block") refreshMemoryUI();
}

socket.on("loadMemoryPhotos", list => {
    if (!Array.isArray(list)) return;
    memories.clear();
    list.forEach(pin => {
        if (pin && pin.image && isValidCoordinate(pin.lat, pin.lng)) {
            const id = String(pin.id || `${pin.lat}_${pin.lng}_${pin.time}`);
            memories.set(id, { ...pin, id, lat: Number(pin.lat), lng: Number(pin.lng), name: cleanName(pin.name) });
        }
    });
    renderMemoryMarkers();
    refreshMemoryUI();
});

socket.on("newMemoryPin", pin => {
    saveMemory(pin);
});

// ==========================================
// USER JOIN LOGIC
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
        updateOnlineCount();
        socket.emit("profileReady", {
            name: currentUser.name,
            avatar: currentUser.avatar || DEFAULT_AVATAR
        });
    }

    avatarInput?.addEventListener("change", () => {
        const file = avatarInput.files?.[0];
        if (!file) return;
        if (!ALLOWED_AVATAR_TYPES.includes(file.type)) { alert("Please select a valid image."); avatarInput.value = ""; return; }
        if (file.size > MAX_AVATAR_FILE_SIZE) { alert("Profile photo must be under 3MB."); avatarInput.value = ""; return; }
        if (avatarLabelText) avatarLabelText.textContent = "Photo Selected ✓";
    });

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
                if (isValidImageDataURL(result)) {
                    currentUser.avatar = result;
                    localStorage.setItem("koraput_avatar", result);
                }
                completeJoin();
            };
            reader.onerror = completeJoin;
            reader.readAsDataURL(file);
        } else {
            completeJoin();
        }

        function completeJoin() {
            joinScreen.style.display = "none";
            if (chatToggleBtn) chatToggleBtn.style.display = "flex";
            if (headerAvatar) {
                headerAvatar.src = currentUser.avatar || DEFAULT_AVATAR;
                headerAvatar.style.display = "block";
            }
            if (ownMarker) ownMarker.setIcon(createOwnIcon(currentUser.avatar));

            socket.emit("profileReady", { name: currentUser.name, avatar: currentUser.avatar || DEFAULT_AVATAR });
            emitLocation();
            updateOnlineCount();
            setTimeout(() => map.invalidateSize(), 300);
        }
    });
}

// ==========================================
// MEMORY BUTTON (UPLOAD LOGIC)
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

        if (!ALLOWED_MEMORY_TYPES.includes(file.type)) {
            alert("Please select a valid image.");
            memoryInput.value = "";
            return;
        }

        if (file.size > MAX_MEMORY_FILE_SIZE) {
            alert("Memory photo must be under 8MB.");
            memoryInput.value = "";
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            const image = String(reader.result || "");
            if (!isValidImageDataURL(image)) { alert("Unable to read this image."); return; }

            alert("📸 Tap anywhere on the map to pin this photo!");
            map.once("click", (event) => {
                if (!event.latlng || !isValidCoordinate(event.latlng.lat, event.latlng.lng)) return;
                socket.emit("uploadMemoryPhoto", {
                    name: currentUser.name,
                    lat: event.latlng.lat,
                    lng: event.latlng.lng,
                    image,
                    time: new Date().toISOString()
                });
            });
        };
        reader.onerror = () => { alert("Could not read the photo."); };
        reader.readAsDataURL(file);
        memoryInput.value = "";
    });
}

// ==========================================
// CHAT FUNCTIONALITY
// ==========================================

function setupChat() {
    const chatContainer = document.getElementById("chat-container");
    const chatToggle = document.getElementById("chat-toggle-btn");
    const chatForm = document.getElementById("chatForm");
    const chatInput = document.getElementById("chatInput");
    const chatMessages = document.getElementById("chat-messages");
    const fileInput = document.getElementById("chatFileInput");
    const attachButton = document.getElementById("chat-attach-btn");
    const emojiPicker = document.getElementById("emojiPicker");
    const emojiButton = document.getElementById("emojiButton");
    const voiceButton = document.getElementById("voiceButton");
    const sendButton = document.getElementById("chat-send");

    const typingIndicator = document.getElementById("typing-indicator");
    const replyBar = document.getElementById("reply-bar");
    const replyPreview = document.getElementById("reply-preview");
    const replyCancel = document.getElementById("reply-cancel");

    const attachmentMenu = document.getElementById("attachment-menu");
    const emojiContainer = document.getElementById("emoji-picker-container");

    if (!chatContainer || !chatForm || !chatInput || !chatMessages) {
        return;
    }

    let unreadCount = 0;
    let typingTimer = null;
    let isTyping = false;

    let replyToMessage = null;
    let reactingToMsgId = null;

    const messageStore = new Map();
    const reactionEmojis = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

    function isChatOpen() {
        return chatContainer.style.display === "flex" || chatContainer.classList.contains("open");
    }

    function updateUnreadBadge() {
        const badge = document.getElementById("chat-unread-badge");
        if (!badge) return;
        badge.textContent = unreadCount;
        badge.style.display = unreadCount > 0 ? "flex" : "none";
    }

    function markChatRead() {
        unreadCount = 0;
        updateUnreadBadge();
    }

    function openChat() {
        chatContainer.classList.add("open");
        chatContainer.style.display = "flex";
        markChatRead();
        setTimeout(() => chatInput.focus(), 100);
    }

    function closeChat() {
        chatContainer.classList.remove("open");
        chatContainer.style.display = "none";
        if (attachmentMenu) attachmentMenu.style.display = "none";
        if (emojiContainer) emojiContainer.style.display = "none";
    }

    chatToggle?.addEventListener("click", () => {
        if (isChatOpen()) closeChat(); else openChat();
    });

    document.getElementById("chat-minimize-btn")?.addEventListener("click", closeChat);

    // Online List Toggle inside Chat
    document.getElementById("online-btn")?.addEventListener("click", () => {
        const list = document.getElementById("online-list");
        if (list) {
            list.style.display = list.style.display === "none" ? "block" : "none";
            renderOnlineList();
        }
    });

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
        if (!isTyping) { isTyping = true; sendTypingStatus(true); }
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => stopTyping(), 1200);
        updateSendButtons();
    });

    chatInput.addEventListener("blur", () => {
        clearTimeout(typingTimer);
        stopTyping();
    });

    socket.on("typing", (data) => {
        if (!typingIndicator) return;
        if (!data || data.id === socket.id) return;

        if (data.isTyping) {
            typingIndicator.textContent = `${cleanName(data.name) || "Someone"} is typing…`;
            typingIndicator.style.display = "flex";
        } else {
            typingIndicator.style.display = "none";
        }
    });

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
        replyToMessage = { id: msg.id, name: msg.name || "User", type: msg.type || "text", preview: getReplyPreview(msg) };
        if (replyPreview) replyPreview.textContent = `↩ ${replyToMessage.name}: ${replyToMessage.preview}`;
        if (replyBar) replyBar.style.display = "flex";
        chatInput.focus();
    }

    function clearReply() {
        replyToMessage = null;
        if (replyPreview) replyPreview.textContent = "";
        if (replyBar) replyBar.style.display = "none";
    }

    replyCancel?.addEventListener("click", clearReply);

    function updateSendButtons() {
        if (!sendButton) return;
        const hasText = chatInput.value.trim().length > 0;
        if (hasText) {
            sendButton.style.display = "flex";
            if (voiceButton) voiceButton.style.display = "none";
        } else {
            sendButton.style.display = "none";
            if (voiceButton) voiceButton.style.display = "flex";
        }
    }

    emojiButton?.addEventListener("click", (event) => {
        event.stopPropagation();
        if (attachmentMenu) attachmentMenu.style.display = "none";
        if (!emojiContainer && !emojiPicker) return;
        const target = emojiContainer || emojiPicker;
        target.style.display = target.style.display === "block" ? "none" : "block";
    });

    emojiPicker?.addEventListener("emoji-click", (event) => {
        const emoji = event.detail?.unicode;
        if (!emoji) return;

        if (reactingToMsgId) {
            socket.emit("messageReaction", { messageId: reactingToMsgId, emoji });
            if (emojiContainer) emojiContainer.style.display = "none";
            else emojiPicker.style.display = "none";
            reactingToMsgId = null;
        } else {
            chatInput.value += emoji;
            chatInput.focus();
            updateSendButtons();
        }
    });

    window.reactTo = (msgId) => {
        reactingToMsgId = msgId;
        if (attachmentMenu) attachmentMenu.style.display = "none";
        if (emojiContainer) emojiContainer.style.display = "block";
        else if (emojiPicker) emojiPicker.style.display = "block";
    };

    attachButton?.addEventListener("click", (event) => {
        event.stopPropagation();
        if (emojiContainer) emojiContainer.style.display = "none";
        else if (emojiPicker) emojiPicker.style.display = "none";

        if (attachmentMenu) attachmentMenu.style.display = attachmentMenu.style.display === "flex" ? "none" : "flex";
        else fileInput?.click();
    });

    document.addEventListener("click", (event) => {
        if (attachmentMenu && !attachmentMenu.contains(event.target) && event.target !== attachButton) {
            attachmentMenu.style.display = "none";
        }
        if (emojiContainer && !emojiContainer.contains(event.target) && event.target !== emojiButton) {
            emojiContainer.style.display = "none";
        }
    });

    document.getElementById("att-media")?.addEventListener("click", () => {
        if (!fileInput) return;
        fileInput.accept = "image/*,video/*";
        fileInput.click();
        if (attachmentMenu) attachmentMenu.style.display = "none";
    });

    document.getElementById("att-doc")?.addEventListener("click", () => {
        if (!fileInput) return;
        fileInput.accept = ".pdf,.doc,.docx,.txt,.zip";
        fileInput.click();
        if (attachmentMenu) attachmentMenu.style.display = "none";
    });

    document.getElementById("att-audio")?.addEventListener("click", () => {
        if (!fileInput) return;
        fileInput.accept = "audio/*";
        fileInput.click();
        if (attachmentMenu) attachmentMenu.style.display = "none";
    });

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
            if (file.type.startsWith("image/")) type = "image";
            else if (file.type.startsWith("video/")) type = "video";
            else if (file.type.startsWith("audio/")) type = "audio";

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

    function renderReactions(messageElement, msg) {
        if (!messageElement) return;

        const container = messageElement.querySelector(".reaction-row") || messageElement.querySelector(".message-reactions");
        if (!container) return;

        container.innerHTML = "";
        const reactions = msg.reactions || {};

        Object.keys(reactions).forEach((emoji) => {
            const users = reactions[emoji];
            if (!Array.isArray(users) || users.length === 0) return;

            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "reaction-chip";
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
            button.className = "action-btn";
            button.textContent = emoji;

            button.addEventListener("click", () => {
                socket.emit("messageReaction", { messageId: msg.id, emoji });
            });

            picker.appendChild(button);
        });
    }

    function renderMessage(msg) {
        if (!msg || !msg.id) return;

        const wrapper = document.createElement("div");
        wrapper.className = "chat-message-wrap";

        const message = document.createElement("div");
        message.className = "chat-message";

        const mine = msg.senderId === socket.id;

        if (mine) message.classList.add("msg-mine");
        else message.classList.add("msg-theirs");

        if (!mine) {
            const sender = document.createElement("div");
            sender.className = "msg-sender";
            sender.textContent = cleanName(msg.name) || "User";
            message.appendChild(sender);
        }

        if (msg.replyTo && msg.replyTo.preview) {
            const quote = document.createElement("div");
            quote.className = "reply-quote";
            Object.assign(quote.style, {
                 borderLeft: "3px solid var(--green-bright)",
                 padding: "4px 6px",
                 marginBottom: "6px",
                 background: "rgba(0,0,0,0.15)",
                 borderRadius: "4px",
                 fontSize: "10px",
                 color: "var(--muted)"
            });
            quote.innerHTML = `<b>${escapeHTML(msg.replyTo.name || "User")}</b><br>${escapeHTML(msg.replyTo.preview)}`;
            message.appendChild(quote);
        }

        const content = document.createElement("div");

        if (msg.type === "text") {
            const text = document.createElement("div");
            text.className = "message-text";
            text.textContent = msg.data || "";
            content.appendChild(text);
        } else if (msg.type === "image") {
            const image = document.createElement("img");
            image.className = "chat-media";
            image.src = msg.data;
            image.alt = "Photo";
            image.loading = "lazy";
            content.appendChild(image);
        } else if (msg.type === "video") {
            const video = document.createElement("video");
            video.className = "chat-media";
            video.controls = true;
            video.preload = "metadata";
            video.src = msg.data;
            content.appendChild(video);
        } else if (msg.type === "audio") {
            const audio = document.createElement("audio");
            audio.className = "chat-audio";
            audio.controls = true;
            audio.src = msg.data;
            content.appendChild(audio);
        } else if (msg.type === "document") {
            const link = document.createElement("a");
            link.className = "chat-document";
            link.href = msg.data;
            link.download = "Koraput-Map-file";
            link.textContent = "📄 Download File";
            content.appendChild(link);
        }

        message.appendChild(content);

        const meta = document.createElement("div");
        meta.className = "message-meta";

        const time = document.createElement("span");
        if (msg.time) {
            const date = new Date(msg.time);
            time.style.color = "var(--muted)";
            time.style.fontSize = "9px";
            time.style.display = "block";
            time.style.marginTop = "3px";
            time.style.textAlign = "right";
            time.textContent = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        }

        meta.appendChild(time);
        message.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "message-actions";

        const picker = document.createElement("div");
        picker.className = "reaction-picker";
        picker.style.display = "flex";
        picker.style.gap = "2px";

        addReactionButtons(picker, msg);
        actions.appendChild(picker);

        const replyButton = document.createElement("button");
        replyButton.type = "button";
        replyButton.className = "action-btn";
        replyButton.textContent = "↩ Reply";

        replyButton.addEventListener("click", () => beginReply(msg));

        actions.appendChild(replyButton);
        message.appendChild(actions);

        const reactions = document.createElement("div");
        reactions.className = "reaction-row";
        message.appendChild(reactions);

        wrapper.appendChild(message);
        chatMessages.appendChild(wrapper);

        msg.reactions = msg.reactions || {};
        messageStore.set(msg.id, { msg, element: wrapper });

        renderReactions(wrapper, msg);

        const fromOtherUser = msg.senderId && msg.senderId !== socket.id;
        if (fromOtherUser && !isChatOpen()) {
            unreadCount++;
            updateUnreadBadge();
        }

        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    socket.on("chatMessage", renderMessage);

    socket.on("messageReaction", (data) => {
        if (!data?.messageId) return;
        const stored = messageStore.get(String(data.messageId));
        if (!stored) return;

        stored.msg.reactions = data.reactions || {};
        const message = stored.element.querySelector(".chat-message");
        renderReactions(message, stored.msg);
    });

    updateSendButtons();
    updateUnreadBadge();
}

// ==========================================
// VOICE RECORDER
// ==========================================

function setupVoiceRecorder() {
    const voiceButton = document.getElementById("voiceButton");
    const chatInput = document.getElementById("chatInput");
    const sendBtn = document.getElementById("chat-send");
    
    if (!voiceButton) return;

    let mediaRecorder = null;
    let audioChunks = [];
    let recording = false;

    function resetVoiceButton() {
        voiceButton.style.background = "transparent";
        voiceButton.style.color = "var(--muted)";
        voiceButton.innerHTML = "🎙️";
        if (chatInput && sendBtn && chatInput.value.trim()) {
            voiceButton.style.display = "none";
            sendBtn.style.display = "flex";
        }
    }

    voiceButton.addEventListener("click", async () => {
        if (recording) { mediaRecorder?.stop(); return; }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert("Voice recording is not supported in this browser.");
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioChunks = [];
            let mimeType = "";
            if (MediaRecorder.isTypeSupported("audio/webm")) mimeType = "audio/webm";
            else if (MediaRecorder.isTypeSupported("audio/mp4")) mimeType = "audio/mp4";

            mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
            recording = true;

            voiceButton.textContent = "⏹";
            voiceButton.title = "Stop recording";
            voiceButton.style.background = "var(--green)";
            voiceButton.style.color = "#fff";

            mediaRecorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) audioChunks.push(event.data);
            };

            mediaRecorder.onstop = () => {
                recording = false;
                resetVoiceButton();
                stream.getTracks().forEach((track) => track.stop());

                const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
                if (blob.size === 0) return;
                if (blob.size > MAX_CHAT_FILE_SIZE) { alert("Voice message is too large."); return; }

                const reader = new FileReader();
                reader.onload = () => {
                    const data = String(reader.result || "");
                    if (!/^data:audio\//i.test(data)) return;
                    socket.emit("chatMessage", {
                        name: currentUser.name,
                        type: "audio",
                        data: data,
                        replyTo: null
                    });
                };
                reader.onerror = () => { alert("Failed to read audio data."); };
                reader.readAsDataURL(blob);
            };

            mediaRecorder.start();

        } catch (error) {
            console.warn("Microphone error:", error);
            alert("Microphone permission was not granted.");
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
        const center = map.getCenter();
        map.setView(center, map.getZoom(), { animate: true });
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
    document.querySelectorAll("#map-style-menu button").forEach((button) => {
        button.classList.toggle("active", button.dataset.style === style);
    });
    setTimeout(() => map.invalidateSize(), 100);
}

function updateFriendBadges() {
    if (!myCoords) return;
    Object.keys(friendMarkers).forEach((id) => {
        updateFriendMarkerTooltip(id);
    });
}

// ==========================================
// INITIALIZE & RUN APP
// ==========================================

function setupEverything() {
    setupPhase3UI();         // Injects Memory Gallery, Viewer, Timelines
    setupUserJoin();         // Handles user login/avatar
    setupMemoryButton();     // Binds Camera/Upload icon
    setupChat();             // Binds Chat, Emojis, Replies
    setupVoiceRecorder();    // Binds Mic
    setupProfilePopup();     // Binds clicking on friends
    setupMapControls();      // Binds Location & Style menus
    startLocationTracking(); // Boot GPS tracking

    updateOnlineCount();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
        setupEverything();
        setInterval(() => { emitLocation(); updateFriendBadges(); }, 5000);
    });
} else {
    setupEverything();
    setInterval(() => { emitLocation(); updateFriendBadges(); }, 5000);
}

console.log("Koraput Map ULTIMATE (Phases 1+2+3) Client Loaded Successfully!");
