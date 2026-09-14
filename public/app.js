// ==========================================
// KORAPUT MAP — PHASE 2 SOCIAL CLIENT
// ==========================================

const socket = io();

// ==========================================
// GOOGLE 3D MARKER ADAPTER
// ==========================================

class Google3DMarkerAdapter {
    constructor(position, options = {}) {
        this.options = options;
        this.element = document.createElement("gmp-marker");
        this.element.position = `${position[0]},${position[1]},0`;
        this.element.setAttribute("position", `${position[0]},${position[1]},0`);
        this.element.title = "Koraput Map";

        const iconUrl = options?.icon?.iconUrl || "friend1.png";
        const size = options?.icon?.iconSize?.[0] || 45;

        const wrapper = document.createElement("div");
        Object.assign(wrapper.style, {
            width: `${size}px`, height: `${size}px`, borderRadius: "50%",
            overflow: "hidden", border: "3px solid white", background: "white",
            boxShadow: "0 2px 10px rgba(0,0,0,.45)"
        });

        const img = document.createElement("img");
        Object.assign(img.style, { width: "100%", height: "100%", objectFit: "cover" });
        img.src = iconUrl;
        img.alt = "Map marker";
        img.draggable = false;

        wrapper.appendChild(img);
        this.element.appendChild(wrapper);

        this.popupText = "";
        this.tooltipText = "";
        this.map = null;
        this._popupClickHandler = null;
    }

    addTo(map) {
        this.map = map;
        map.element.appendChild(this.element);
        return this;
    }

    setLatLng(coords) {
        const lat = coords.lat ?? coords[0];
        const lng = coords.lng ?? coords[1];
        this.element.position = `${lat},${lng},0`;
        this.element.setAttribute("position", `${lat},${lng},0`);
        return this;
    }

    getLatLng() {
        const value = String(this.element.position || this.element.getAttribute("position") || "0,0,0");
        const parts = value.split(",");
        return { lat: Number(parts[0]), lng: Number(parts[1]) };
    }

    setIcon(icon) {
        const img = this.element.querySelector("img");
        if (img && icon?.iconUrl) img.src = icon.iconUrl;
        return this;
    }

    bindPopup(html) {
        this.popupText = html;
        this.element.title = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        if (!this._popupClickHandler) {
            this._popupClickHandler = () => { this.map?.showInfo(this.popupText); };
            this.element.addEventListener("gmp-click", this._popupClickHandler);
        }
        return this;
    }

    onClick(callback) {
        this.element.addEventListener("gmp-click", callback);
        return this;
    }

    bindTooltip(text) {
        this.tooltipText = String(text || "");
        this.element.title = this.tooltipText;
        return this;
    }

    getTooltip() { return this.tooltipText ? { content: this.tooltipText } : null; }
    setTooltipContent(text) { this.tooltipText = String(text || ""); this.element.title = this.tooltipText; return this; }
    remove() { this.element.remove(); }
}

// ==========================================
// GOOGLE 3D MAP ADAPTER
// ==========================================

class Google3DMapAdapter {
    constructor(id) {
        this.element = document.getElementById(id);
        this.listeners = {};
        if (!this.element) throw new Error("Map element not found");

        this.element.addEventListener("gmp-click", event => {
            const position = event.position;
            if (!position) return;
            const payload = { latlng: { lat: Number(position.lat), lng: Number(position.lng) } };
            (this.listeners.click || []).forEach(fn => fn(payload));
            (this.listeners.onceClick || []).splice(0).forEach(fn => fn(payload));
        });
    }

    setView(coords, range = 2500) {
        const lat = coords[0], lng = coords[1];
        this.element.center = `${lat},${lng},250`;
        this.element.setAttribute("center", `${lat},${lng},250`);
        this.element.range = Math.max(300, Math.min(1800, range * 45));
        return this;
    }

    on(event, callback) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(callback);
        return this;
    }

    once(event, callback) {
        if (event !== "click") return this;
        if (!this.listeners.onceClick) this.listeners.onceClick = [];
        this.listeners.onceClick.push(callback);
        return this;
    }

    removeLayer(marker) { marker?.remove?.(); }
    invalidateSize() {}

    showInfo(html) {
        const panel = document.getElementById("map-info-panel");
        if (!panel) return;
        panel.innerHTML = `<button id="close-map-info" type="button">×</button>${html}`;
        panel.style.display = "block";
        document.getElementById("close-map-info")?.addEventListener("click", () => { panel.style.display = "none"; });
    }
}

// ==========================================
// LEAFLET-LIKE API
// ==========================================

const L = {
    map: id => new Google3DMapAdapter(id),
    tileLayer: () => ({ addTo: () => {} }),
    icon: options => options,
    marker: (position, options) => new Google3DMarkerAdapter(position, options)
};

const map = L.map("map").setView([18.8136, 82.7153], 16);

// ==========================================
// STATE
// ==========================================

let ownMarker = null, firstLocationFix = true, myCoords = null, myWeather = "";
const friendMarkers = {}, friendProfiles = {}, onlineUsers = new Map(), memoryMarkers = [];
const defaultAvatar = "friend1.png";

let chatOpen = false, unreadCount = 0, replyTarget = null, typingTimer = null, currentlyTyping = false;

let currentUser = (() => {
    try { const raw = localStorage.getItem("koraputUser"); return raw ? JSON.parse(raw) : { name: "User", avatar: defaultAvatar }; }
    catch { return { name: "User", avatar: defaultAvatar }; }
})();

function saveUser() {
    try { localStorage.setItem("koraputUser", JSON.stringify(currentUser)); } catch (e) { console.warn(e); }
}

// ==========================================
// HELPERS
// ==========================================

function escapeHTML(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function isSafeDataUrl(value, expectedPrefix) {
    if (typeof value !== "string") return false;
    const regex = new RegExp("^data:" + expectedPrefix.replace("/", "\\/") + "[a-zA-Z0-9.+-]+;base64,", "i");
    return regex.test(value);
}

function getSafeImageSource(value) {
    if (typeof value !== "string") return defaultAvatar;
    if (isSafeDataUrl(value, "image/")) return value;
    try { const url = new URL(value, window.location.href); return (url.protocol === "http:" || url.protocol === "https:") ? value : defaultAvatar; } 
    catch { return defaultAvatar; }
}

function distanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function weatherEmoji(code) {
    if (code === 0) return "☀️"; if (code <= 3) return "⛅"; if (code <= 48) return "🌫️";
    if (code <= 67) return "🌧️"; if (code <= 77) return "❄️"; if (code <= 82) return "🌦️";
    if (code <= 86) return "🌨️"; if (code >= 95) return "⛈️"; return "🌤️";
}

async function updateWeather(lat, lng) {
    try {
        const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&current=temperature_2m,weather_code`);
        const data = await res.json();
        const temp = data?.current?.temperature_2m, code = data?.current?.weather_code;
        if (typeof temp !== "number" || typeof code !== "number") return;

        myWeather = `${weatherEmoji(code)} ${Math.round(temp)}°C`;
        const pill = document.getElementById("weather-pill");
        if (pill) pill.textContent = myWeather;
        emitLocation(lat, lng, myWeather);
    } catch (error) { console.warn("Weather error:", error); }
}

function createOwnIcon(avatar) {
    return L.icon({ iconUrl: getSafeImageSource(avatar), iconSize: [45, 45], iconAnchor: [22, 45], className: "user-marker" });
}

function createFriendIcon(avatar) {
    return L.icon({ iconUrl: getSafeImageSource(avatar), iconSize: [42, 42], iconAnchor: [21, 42], className: "friend-marker" });
}

// ==========================================
// PROFILE SYNC
// ==========================================

function announceProfile() {
    socket.emit("profileReady", { name: currentUser.name, avatar: currentUser.avatar });
}

// ==========================================
// LOCATION
// ==========================================

function emitLocation(lat, lng, weather = "") {
    socket.emit("updateLocation", { name: currentUser.name, avatar: currentUser.avatar, lat, lng, weather });
}

function handleLocation(position) {
    const lat = Number(position.coords.latitude);
    const lng = Number(position.coords.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    myCoords = { lat, lng };

    if (!ownMarker) {
        ownMarker = L.marker([lat, lng], { icon: createOwnIcon(currentUser.avatar) }).addTo(map);
        ownMarker.bindPopup(`<b>${escapeHTML(currentUser.name)}</b><br>You are here`);
        if (firstLocationFix) { map.setView([lat, lng], 15); firstLocationFix = false; }
    } else {
        ownMarker.setLatLng([lat, lng]);
    }

    emitLocation(lat, lng, myWeather);
    updateWeather(lat, lng);
    updateAllFriendDistances();
}

if ("geolocation" in navigator) {
    navigator.geolocation.watchPosition(handleLocation, e => console.warn(e), { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
}

// ==========================================
// FRIEND PROFILE & MAP UPDATES
// ==========================================

function showFriendProfile(friend) {
    const panel = document.getElementById("map-info-panel");
    if (!panel) return;

    const distance = myCoords ? distanceKm(myCoords.lat, myCoords.lng, friend.lat, friend.lng) : null;
    let distanceText = "Unavailable";
    if (distance !== null) distanceText = distance < 1 ? `${Math.round(distance * 1000)} m away` : `${distance.toFixed(1)} km away`;

    panel.innerHTML = `
        <button id="close-map-info" type="button">×</button>
        <div class="profile-card">
            <div class="profile-avatar-wrap">
                <img class="profile-avatar" src="${escapeHTML(getSafeImageSource(friend.avatar))}" alt="Profile">
            </div>
            <h2 class="profile-name">${escapeHTML(friend.name)}</h2>
            <div class="profile-status">● Online</div>
            <div class="profile-info">
                <div class="profile-row"><span class="profile-label">📍 Distance</span><span>${escapeHTML(distanceText)}</span></div>
                <div class="profile-row"><span class="profile-label">🌤️ Weather</span><span>${escapeHTML(friend.weather || "Unavailable")}</span></div>
            </div>
            <button id="profile-focus-btn" class="profile-focus" type="button">📍 Focus on ${escapeHTML(friend.name)}</button>
        </div>
    `;

    panel.style.display = "block";
    document.getElementById("close-map-info")?.addEventListener("click", () => { panel.style.display = "none"; });
    document.getElementById("profile-focus-btn")?.addEventListener("click", () => { map.setView([friend.lat, friend.lng], 15); panel.style.display = "none"; });
}

function createOrUpdateFriend(user) {
    if (!user?.id) return;
    const id = String(user.id);
    const friend = {
        id, name: typeof user.name === "string" ? user.name.slice(0, 40) : "Friend",
        avatar: getSafeImageSource(user.avatar),
        lat: Number(user.lat), lng: Number(user.lng),
        weather: typeof user.weather === "string" ? user.weather.slice(0, 50) : "",
        online: true
    };

    if (!Number.isFinite(friend.lat) || !Number.isFinite(friend.lng)) return;

    friendProfiles[id] = friend;
    onlineUsers.set(id, friend);

    if (!friendMarkers[id]) {
        friendMarkers[id] = L.marker([friend.lat, friend.lng], { icon: createFriendIcon(friend.avatar) }).addTo(map);
        friendMarkers[id].onClick(() => { const latest = friendProfiles[id]; if (latest) showFriendProfile(latest); });
    } else {
        friendMarkers[id].setLatLng([friend.lat, friend.lng]).setIcon(createFriendIcon(friend.avatar));
    }

    updateFriendTooltip(friend);
    renderOnlineList();
}

socket.on("friendMoved", data => createOrUpdateFriend(data));

// ==========================================
// ONLINE USERS
// ==========================================

socket.on("onlineUsers", list => {
    if (!Array.isArray(list)) return;
    list.forEach(user => {
        if (user?.id === socket.id) return;
        onlineUsers.set(user.id, user);
        friendProfiles[user.id] = user;
        if (Number.isFinite(Number(user.lat)) && Number.isFinite(Number(user.lng))) createOrUpdateFriend(user);
    });
    renderOnlineList();
});

socket.on("userOnline", user => {
    if (!user || user.id === socket.id) return;
    onlineUsers.set(user.id, user); friendProfiles[user.id] = user;
    createOrUpdateFriend(user); renderOnlineList();
});

socket.on("userOffline", data => {
    const id = data?.id; if (!id) return;
    onlineUsers.delete(id); delete friendProfiles[id];
    if (friendMarkers[id]) { map.removeLayer(friendMarkers[id]); delete friendMarkers[id]; }
    renderOnlineList();
});

socket.on("friendDisconnected", id => {
    if (friendMarkers[id]) { map.removeLayer(friendMarkers[id]); delete friendMarkers[id]; }
    onlineUsers.delete(id); delete friendProfiles[id]; renderOnlineList();
});

function updateFriendTooltip(friend) {
    const marker = friendMarkers[friend.id];
    if (!marker) return;
    let text = friend.weather || "Online";
    if (myCoords) {
        const distance = distanceKm(myCoords.lat, myCoords.lng, friend.lat, friend.lng);
        text += " • 📍 " + (distance < 1 ? Math.round(distance * 1000) + " m" : distance.toFixed(1) + " km");
    }
    marker.setTooltipContent(text);
}

function updateAllFriendDistances() { Object.values(friendProfiles).forEach(updateFriendTooltip); }

function renderOnlineList() {
    const box = document.getElementById("online-friends");
    if (!box) return;
    box.innerHTML = "";
    const friends = Array.from(onlineUsers.values()).filter(user => user.id !== socket.id);
    
    document.getElementById("chat-subtitle").textContent = `${friends.length} online`;

    if (!friends.length) {
        box.innerHTML = `<div style="color:#91a2ab; font-size:12px;">No friends online</div>`; return;
    }

    friends.forEach(user => {
        const row = document.createElement("div"); row.className = "online-friend";
        row.innerHTML = `<img src="${getSafeImageSource(user.avatar)}"><span>${escapeHTML(user.name || "Friend")}</span><span class="status-dot"></span>`;
        row.addEventListener("click", () => {
            const friend = friendProfiles[user.id];
            if (friend && Number.isFinite(friend.lat) && Number.isFinite(friend.lng)) {
                map.setView([friend.lat, friend.lng], 15);
                showFriendProfile(friend);
            }
        });
        box.appendChild(row);
    });
}

// ==========================================
// MEMORY
// ==========================================

function renderMemoryPhoto(pin) {
    if (!pin || !Number.isFinite(Number(pin.lat)) || !Number.isFinite(Number(pin.lng)) || !isSafeDataUrl(pin.image, "image/")) return;
    const marker = L.marker([Number(pin.lat), Number(pin.lng)]).addTo(map);
    marker.bindPopup(`
        <div class="memory-popup">
            <img src="${escapeHTML(pin.image)}" alt="Memory">
            <b>${escapeHTML(pin.name || "Memory")}</b>
            ${pin.time ? `<br><small>${escapeHTML(pin.time)}</small>` : ""}
        </div>
    `);
    memoryMarkers.push(marker);
}

socket.on("loadMemoryPhotos", photos => { if (Array.isArray(photos)) photos.forEach(renderMemoryPhoto); });
socket.on("newMemoryPin", renderMemoryPhoto);

function setupMemory() {
    const button = document.getElementById("memoryButton");
    const input = document.getElementById("memoryPhotoInput");
    if (!button || !input) return;

    button.addEventListener("click", () => {
        if (!ownMarker) { alert("Wait for your location to load first."); return; }
        input.click();
    });

    input.addEventListener("change", () => {
        const file = input.files?.[0]; if (!file) return;
        if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) { alert("Choose an image up to 5 MB."); input.value = ""; return; }
        const reader = new FileReader();
        reader.onload = () => {
            const position = ownMarker.getLatLng();
            socket.emit("uploadMemoryPhoto", { name: currentUser.name, lat: position.lat, lng: position.lng, image: reader.result, time: new Date().toLocaleString() });
            input.value = "";
        };
        reader.readAsDataURL(file);
    });
}

// ==========================================
// JOIN / PROFILE
// ==========================================

function setupJoin() {
    const button = document.getElementById("joinButton");
    const input = document.getElementById("nameInput");
    const screen = document.getElementById("join-screen");
    const avatarInput = document.getElementById("avatarInput");

    if (!button) return;

    input.value = currentUser.name !== "User" ? currentUser.name : "";
    if (currentUser.name !== "User") screen.style.display = "none";

    button.addEventListener("click", () => {
        const name = input.value.trim();
        if (!name) { alert("Please enter your name."); return; }
        currentUser.name = name.slice(0, 40); saveUser(); announceProfile(); screen.style.display = "none";
        if (ownMarker && myCoords) { ownMarker.setIcon(createOwnIcon(currentUser.avatar)); emitLocation(myCoords.lat, myCoords.lng, myWeather); }
    });

    avatarInput?.addEventListener("change", () => {
        const file = avatarInput.files?.[0]; if (!file) return;
        if (!file.type.startsWith("image/") || file.size > 2 * 1024 * 1024) { alert("Avatar must be an image up to 2 MB."); avatarInput.value = ""; return; }
        const reader = new FileReader();
        reader.onload = () => {
            if (!isSafeDataUrl(reader.result, "image/")) return;
            currentUser.avatar = reader.result; saveUser(); announceProfile();
            if (ownMarker) ownMarker.setIcon(createOwnIcon(currentUser.avatar));
        };
        reader.readAsDataURL(file);
    });
}

// ==========================================
// CHAT HELPERS & SETUP
// ==========================================

function openChat() { chatOpen = true; document.getElementById("chat-container").style.display = "flex"; document.getElementById("chat-toggle-btn").style.display = "none"; unreadCount = 0; updateUnread(); document.getElementById("chatInput")?.focus(); }
function closeChat() { chatOpen = false; document.getElementById("chat-container").style.display = "none"; document.getElementById("chat-toggle-btn").style.display = "flex"; hideMenus(); sendTyping(false); }
function updateUnread() { const badge = document.getElementById("unread-badge"); if (!badge) return; badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount); badge.style.display = unreadCount ? "flex" : "none"; }
function hideMenus() { 
    ["attachment-menu", "emojiPicker", "online-list"].forEach(id => { const el = document.getElementById(id); if(el) el.style.display="none"; }); 
}
function previewForMessage(msg) {
    if (msg.type === "text") return String(msg.data).slice(0, 200);
    if (msg.type === "image") return "📷 Photo";
    if (msg.type === "video") return "🎥 Video";
    if (msg.type === "audio") return "🎤 Voice message";
    return "📎 Document";
}
function timeText(iso) { try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } }

// Reply
function setReply(msg) {
    replyTarget = { id: msg.id, name: msg.name, type: msg.type, preview: previewForMessage(msg) };
    const container = document.getElementById("reply-preview-container");
    if(container) { container.style.display = "block"; document.getElementById("reply-preview-text").textContent = `↩ Replying to ${msg.name}: ${replyTarget.preview}`; }
    document.getElementById("chatInput").focus();
}
function clearReply() { replyTarget = null; const c = document.getElementById("reply-preview-container"); if(c) c.style.display="none"; }
document.getElementById("cancel-reply-btn")?.addEventListener("click", e => { e.preventDefault(); clearReply(); });

// Reactions
function renderReactions(wrapper, reactions, messageId) {
    let row = wrapper.querySelector(".reaction-row");
    if (!row) { row = document.createElement("div"); row.className = "reaction-row"; wrapper.appendChild(row); }
    row.innerHTML = "";
    Object.entries(reactions || {}).forEach(([emoji, ids]) => {
        if (!Array.isArray(ids) || !ids.length) return;
        const button = document.createElement("button"); button.type = "button"; button.className = "reaction"; button.textContent = `${emoji} ${ids.length}`;
        button.addEventListener("click", () => socket.emit("messageReaction", { messageId, emoji }));
        row.appendChild(button);
    });
}
window.reactTo = (msgId) => { reactingToMsgId = msgId; document.getElementById("emojiPicker").style.display = "grid"; document.getElementById("attachment-menu").style.display = "none"; };

// Render Chat Message
function addChatMessage(msg) {
    const box = document.getElementById("chat-messages");
    if (!box || !msg || !msg.id) return;

    const wrapper = document.createElement("div");
    wrapper.className = "chat-message" + (msg.senderId === socket.id ? " mine" : "");
    wrapper.dataset.messageId = msg.id;

    const sender = document.createElement("div"); sender.className = "sender";
    sender.textContent = msg.name || "User";
    const time = document.createElement("span"); time.className = "msg-time"; time.textContent = timeText(msg.time);
    sender.appendChild(time); wrapper.appendChild(sender);

    if (msg.replyTo?.id) {
        const reply = document.createElement("div"); reply.className = "reply-preview";
        reply.textContent = `↩ ${msg.replyTo.name}: ${msg.replyTo.preview}`;
        wrapper.appendChild(reply);
    }

    const content = document.createElement("div");
    if (msg.type === "text") {
        const text = String(msg.data).slice(0, 5000); content.textContent = text;
        const urls = text.match(/https?:\/\/\S+/g) || [];
        urls.slice(0, 2).forEach(rawUrl => {
            try {
                const url = new URL(rawUrl.replace(/[),.!?]+$/, "")); const host = url.hostname.toLowerCase();
                if (["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"].includes(host)) {
                    let videoId = url.searchParams.get("v");
                    if (!videoId && host === "youtu.be") videoId = url.pathname.slice(1).split("/")[0];
                    if (videoId && /^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
                        const videoBox = document.createElement("div"); videoBox.className = "youtube-box";
                        videoBox.innerHTML = `<iframe src="https://www.youtube.com/embed/${videoId}" title="YouTube" allowfullscreen></iframe>`;
                        content.appendChild(videoBox);
                    }
                }
            } catch {}
        });
    } else if (msg.type === "image" && isSafeDataUrl(msg.data, "image/")) {
        const image = document.createElement("img"); image.className = "chat-media"; image.src = msg.data; image.alt = "Shared image"; content.appendChild(image);
    } else if (msg.type === "video" && isSafeDataUrl(msg.data, "video/")) {
        const video = document.createElement("video"); video.className = "chat-media"; video.src = msg.data; video.controls = true; content.appendChild(video);
    } else if (msg.type === "audio" && isSafeDataUrl(msg.data, "audio/")) {
        const audio = document.createElement("audio"); audio.className = "chat-audio"; audio.src = msg.data; audio.controls = true; content.appendChild(audio);
    } else if (msg.type === "document" && String(msg.data).startsWith("data:")) {
        const link = document.createElement("a"); link.className = "chat-document"; link.href = msg.data; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "📎 Open shared document"; content.appendChild(link);
    } else return;
    
    wrapper.appendChild(content);

    const actions = document.createElement("div"); actions.className = "message-actions";
    const replyBtn = document.createElement("button"); replyBtn.type = "button"; replyBtn.className = "action-btn"; replyBtn.textContent = "↩ Reply"; replyBtn.addEventListener("click", () => setReply(msg)); actions.appendChild(replyBtn);
    const reactBtn = document.createElement("button"); reactBtn.type = "button"; reactBtn.className = "action-btn"; reactBtn.textContent = "😀"; reactBtn.addEventListener("click", () => reactTo(msg.id)); actions.appendChild(reactBtn);
    wrapper.appendChild(actions);
    
    box.appendChild(wrapper);
    renderReactions(wrapper, msg.reactions, msg.id);
    box.scrollTop = box.scrollHeight;
}

socket.on("chatMessage", message => { addChatMessage(message); if (!chatOpen && message.senderId !== socket.id) { unreadCount++; updateUnread(); } });
socket.on("messageReaction", data => { const wrapper = document.querySelector(`[data-message-id="${CSS.escape(data.messageId)}"]`); if (wrapper) renderReactions(wrapper, data.reactions, data.messageId); });

// Typing Indicator
function sendTyping(value) {
    if (value && !currentlyTyping) { currentlyTyping = true; socket.emit("typing", true); }
    if (!value && currentlyTyping) { currentlyTyping = false; socket.emit("typing", false); }
}

const activeTypers = new Set();
socket.on("typing", data => {
    if (!data || data.id === socket.id) return;
    const indicator = document.getElementById("typing-indicator");
    if (!indicator) return;
    
    if (data.isTyping) activeTypers.add(data.name || "Someone");
    else activeTypers.delete(data.name || "Someone");

    if(activeTypers.size > 0) { indicator.textContent = Array.from(activeTypers).join(", ") + " is typing..."; indicator.style.display = "flex"; }
    else { indicator.textContent = ""; indicator.style.display = "none"; }
});

// Setup Chat UI
function setupChat() {
    const form = document.getElementById("chatForm"), input = document.getElementById("chatInput");
    const toggle = document.getElementById("chat-toggle-btn"), minimize = document.getElementById("chat-minimize-btn");
    const attach = document.getElementById("chat-attach-btn"), menu = document.getElementById("attachment-menu");
    const emojiPicker = document.getElementById("emojiPicker"), emojiButton = document.getElementById("emojiButton");

    toggle?.addEventListener("click", openChat); minimize?.addEventListener("click", closeChat);

    input?.addEventListener("input", () => {
        const hasText = input.value.trim().length > 0;
        document.getElementById("voiceButton").style.display = hasText ? "none" : "block";
        document.getElementById("sendButton").style.display = hasText ? "block" : "none";
        sendTyping(hasText);
        clearTimeout(typingTimer);
        if (hasText) typingTimer = setTimeout(() => sendTyping(false), 1200);
    });

    form?.addEventListener("submit", event => {
        event.preventDefault(); const text = input.value.trim(); if (!text) return;
        socket.emit("chatMessage", { type: "text", data: text.slice(0, 5000), replyTo: replyTarget });
        input.value = ""; clearReply(); sendTyping(false);
        document.getElementById("voiceButton").style.display = "block"; document.getElementById("sendButton").style.display = "none";
    });

    attach?.addEventListener("click", event => { event.stopPropagation(); menu.style.display = menu.style.display === "flex" ? "none" : "flex"; emojiPicker.style.display = "none"; });
    document.addEventListener("click", event => { if (menu && !menu.contains(event.target) && event.target !== attach) menu.style.display = "none"; if(emojiPicker && !emojiPicker.contains(event.target) && event.target.id !== "emojiButton") emojiPicker.style.display = "none"; });

    // File Upload
    const file = document.getElementById("chatAttachment"), camera = document.getElementById("chat-camera-file");
    document.getElementById("att-media")?.addEventListener("click", () => { file.accept = "image/*,video/*"; file.click(); menu.style.display = "none"; });
    document.getElementById("att-doc")?.addEventListener("click", () => { file.accept = ".pdf,.doc,.docx,.txt,.csv,.xlsx,.ppt,.pptx,application/pdf,text/plain"; file.click(); menu.style.display = "none"; });
    document.getElementById("att-audio")?.addEventListener("click", () => { file.accept = "audio/*"; file.click(); menu.style.display = "none"; });
    document.getElementById("att-cam")?.addEventListener("click", () => { camera.click(); menu.style.display = "none"; });

    const handleFile = f => {
        if (!f) return;
        if (f.size > 5 * 1024 * 1024) return alert("Attachment must be 5 MB or smaller.");
        let type = "document"; if (f.type.startsWith("image/")) type = "image"; else if (f.type.startsWith("video/")) type = "video"; else if (f.type.startsWith("audio/")) type = "audio";
        const reader = new FileReader();
        reader.onload = () => { socket.emit("chatMessage", { type, data: reader.result, replyTo: replyTarget }); clearReply(); };
        reader.readAsDataURL(f); file.value = ""; camera.value = "";
    };
    file?.addEventListener("change", () => handleFile(file.files[0]));
    camera?.addEventListener("change", () => handleFile(camera.files[0]));

    // Emojis
    const emojis = ["😀", "😂", "😍", "😎", "🥳", "👍", "❤️", "🔥", "🎉", "📍", "📸", "🚗", "🌧️", "☀️", "😄", "😮", "😢", "👏"];
    emojis.forEach(emoji => {
        const button = document.createElement("button"); button.type = "button"; button.textContent = emoji;
        button.addEventListener("click", () => {
            if(reactingToMsgId) { socket.emit("messageReaction", { messageId: reactingToMsgId, emoji }); emojiPicker.style.display = "none"; reactingToMsgId = null; }
            else { input.value += emoji; input.focus(); emojiPicker.style.display = "none"; document.getElementById("voiceButton").style.display = "none"; document.getElementById("sendButton").style.display = "block"; }
        });
        emojiPicker.appendChild(button);
    });
    emojiButton?.addEventListener("click", (e) => { e.stopPropagation(); reactingToMsgId = null; emojiPicker.style.display = emojiPicker.style.display === "grid" ? "none" : "grid"; menu.style.display = "none"; });

    document.getElementById("online-btn")?.addEventListener("click", () => { const list = document.getElementById("online-list"); list.style.display = list.style.display === "none" ? "block" : "none"; renderOnlineList(); });
}

// ==========================================
// VOICE
// ==========================================
function setupVoice() {
    const button = document.getElementById("voiceButton");
    if (!button || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { if (button) button.disabled = true; return; }
    let recorder = null, chunks = [];

    button.addEventListener("click", async () => {
        if (recorder?.state === "recording") { recorder.stop(); button.textContent = "🎤"; return; }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            recorder = new MediaRecorder(stream); chunks = [];
            recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
            recorder.onstop = () => {
                stream.getTracks().forEach(track => track.stop());
                const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
                if (blob.size > 5 * 1024 * 1024) return alert("Voice message is too large.");
                const reader = new FileReader();
                reader.onload = () => { socket.emit("chatMessage", { type: "audio", data: reader.result, replyTo: replyTarget }); clearReply(); };
                reader.readAsDataURL(blob);
            };
            recorder.start(); button.textContent = "⏹️";
        } catch { alert("Microphone permission was not granted."); }
    });
}

// ==========================================
// MAP CONTROLS
// ==========================================
function setupMapControls() {
    document.getElementById("my-location-btn")?.addEventListener("click", () => { if (myCoords) map.setView([myCoords.lat, myCoords.lng], 15); else alert("Waiting for GPS location…"); });
    document.getElementById("compass-btn")?.addEventListener("click", () => { document.getElementById("map").heading = 0; });
    const styleMenu = document.getElementById("map-style-menu");
    document.getElementById("map-style-btn")?.addEventListener("click", () => { styleMenu.style.display = styleMenu.style.display === "flex" ? "none" : "flex"; });
    styleMenu?.querySelectorAll("button[data-style]").forEach(button => {
        button.addEventListener("click", () => {
            const style = button.dataset.style;
            document.getElementById("map").mode = "SATELLITE"; // Native Google 3D defaults to satellite
            styleMenu.querySelectorAll("button").forEach(item => item.classList.remove("active"));
            button.classList.add("active"); styleMenu.style.display = "none";
        });
    });
}

// ==========================================
// START
// ==========================================
socket.on("connect", () => { announceProfile(); if (myCoords) emitLocation(myCoords.lat, myCoords.lng, myWeather); });

function setup() {
    setupJoin(); setupMemory(); setupChat(); setupVoice(); setupMapControls(); renderOnlineList();
    if (currentUser.name !== "User") announceProfile();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup); else setup();
