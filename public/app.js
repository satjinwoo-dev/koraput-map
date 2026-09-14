// ==========================================
// KORAPUT MAP - PHASE 2 CLIENT (LEAFLET + SOCKET)
// ==========================================

"use strict";
const socket = io({ transports: ["websocket", "polling"] });

// Core Map Setup
const map = L.map("map", { zoomControl: false, attributionControl: false }).setView([18.8136, 82.7153], 13);
const mapLayers = {
    satellite: L.tileLayer("https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}", { maxZoom: 20, subdomains: ["mt0", "mt1", "mt2", "mt3"] }),
    street: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }),
    dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 20 })
};
let currentMapStyle = "satellite";
mapLayers[currentMapStyle].addTo(map);

// App State
let myCoords = null, ownMarker = null, accuracyCircle = null, myWeather = "", currentCityName = "";
const friendMarkers = {}, friendProfiles = {}, memoryMarkers = {};
const onlineUsers = new Map(); 
let unreadCount = 0, chatOpen = false, typingTimer, reactingToMsgId = null, replyTarget = null;
let currentlyTyping = false;
const defaultAvatar = "friend1.png";

let currentUser = {
    name: localStorage.getItem("koraputUser") ? JSON.parse(localStorage.getItem("koraputUser")).name : "User",
    avatar: localStorage.getItem("koraputUser") ? JSON.parse(localStorage.getItem("koraputUser")).avatar : defaultAvatar
};

function saveUser() {
    try { localStorage.setItem("koraputUser", JSON.stringify(currentUser)); } catch (error) { console.warn(error); }
}

// Utilities
const escapeHTML = str => String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cleanName = str => String(str || "").trim().slice(0, 40) || "User";
const distanceKm = (lat1, lon1, lat2, lon2) => {
    const a = Math.sin((lat2-lat1)*Math.PI/360)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin((lon2-lon1)*Math.PI/360)**2;
    return (6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
};
const weatherEmoji = code => [0].includes(code)?"☀️":[1,2,3].includes(code)?"⛅":[45,48].includes(code)?"🌫️":[51,53,55,56,57,61,63,65,66,67].includes(code)?"🌧️":[71,73,75,77,85,86].includes(code)?"❄️":[80,81,82].includes(code)?"🌦️":[95,96,99].includes(code)?"⛈️":"🌤️";

function isSafeDataUrl(value, expectedPrefix) {
    if (typeof value !== "string") return false;
    const regex = new RegExp("^data:" + expectedPrefix.replace("/", "\\/") + "[a-zA-Z0-9.+-]+;base64,", "i");
    return regex.test(value);
}
function getSafeImageSource(value) {
    if (typeof value !== "string") return defaultAvatar;
    if (isSafeDataUrl(value, "image/")) return value;
    try { const url = new URL(value, window.location.href); return (url.protocol === "http:" || url.protocol === "https:") ? value : defaultAvatar; } catch { return defaultAvatar; }
}

// Markers & Icons
const createOwnIcon = avatar => L.icon({ iconUrl: getSafeImageSource(avatar), iconSize: [36, 36], iconAnchor: [18, 18], className: "leaflet-marker-icon avatar-icon own-live-avatar" });
const createFriendIcon = avatar => L.icon({ iconUrl: getSafeImageSource(avatar), iconSize: [34, 34], iconAnchor: [17, 17], className: "leaflet-marker-icon avatar-icon friend-marker" });

// Location & Weather Sync
function emitLocation(lat, lng, weather = "") {
    socket.emit("updateLocation", { name: currentUser.name, avatar: currentUser.avatar, lat, lng, weather });
}

async function fetchCityName(lat, lng) {
    try { const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10`); return (await res.json()).address?.city || "Rourkela"; } catch { return "Rourkela"; }
}

async function updateWeather(lat, lng) {
    try {
        const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&current=temperature_2m,weather_code`);
        const data = await response.json();
        const temperature = data?.current?.temperature_2m;
        const code = data?.current?.weather_code;
        if (typeof temperature !== "number" || typeof code !== "number") return;

        myWeather = `${weatherEmoji(code)} ${Math.round(temperature)}°C`;
        const pill = document.getElementById("map-temp-display");
        if (pill) pill.textContent = myWeather;
        emitLocation(lat, lng, myWeather);
    } catch (error) { console.warn("Weather error:", error); }
}

// GPS Location Handler
let firstLocationFix = true;
function handleLocation(position) {
    const lat = Number(position.coords.latitude);
    const lng = Number(position.coords.longitude);
    const accuracy = Number(position.coords.accuracy);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    myCoords = { lat, lng };

    // Dynamic City Fix
    if (!currentCityName) {
        fetchCityName(lat, lng).then(city => {
            currentCityName = city;
            const headerTitle = document.getElementById("header-app-title");
            if (headerTitle) headerTitle.textContent = `${currentCityName} Map`;
            const pillCity = document.getElementById("pill-city");
            if (pillCity) pillCity.textContent = `📍 ${currentCityName}`;
        });
    }

    if (Number.isFinite(accuracy) && accuracy > 0 && accuracy < 100000) {
        if (!accuracyCircle) {
            accuracyCircle = L.circle([lat, lng], { radius: accuracy, color: "#18d6a3", weight: 1, fillOpacity: 0.1, interactive:false }).addTo(map);
        } else {
            accuracyCircle.setLatLng([lat, lng]); accuracyCircle.setRadius(accuracy);
        }
    }

    if (!ownMarker) {
        ownMarker = L.marker([lat, lng], { icon: createOwnIcon(currentUser.avatar) }).addTo(map);
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
// FRIENDS & PROFILE LOGIC
// ==========================================
function updateFriendTooltip(friend) {
    const marker = friendMarkers[friend.id];
    if (!marker) return;
    
    let text = friend.weather || "Online";
    if (myCoords) {
        const distance = distanceKm(myCoords.lat, myCoords.lng, friend.lat, friend.lng);
        text += " | 📍 " + (distance < 1 ? Math.round(distance * 1000) + " m" : distance.toFixed(1) + " km");
    }
    marker.unbindTooltip().bindTooltip(text, { permanent: true, direction: "right", className: "weather-badge", offset: [15, 0] });
}

function updateAllFriendDistances() { Object.values(friendProfiles).forEach(updateFriendTooltip); }

function showFriendProfile(friend) {
    const panel = document.getElementById("map-info-panel");
    if (!panel) return;
    
    let distanceText = "Unavailable";
    if (myCoords) {
        const distance = distanceKm(myCoords.lat, myCoords.lng, friend.lat, friend.lng);
        distanceText = distance < 1 ? `${Math.round(distance * 1000)} m away` : `${distance.toFixed(1)} km away`;
    }

    document.getElementById("popup-avatar").src = getSafeImageSource(friend.avatar);
    document.getElementById("popup-name").textContent = escapeHTML(friend.name);
    document.getElementById("popup-dist").textContent = distanceText;
    document.getElementById("popup-weather").textContent = escapeHTML(friend.weather || "Unavailable");

    panel.style.display = "block";
    document.getElementById("profile-focus-btn").onclick = () => { map.setView([friend.lat, friend.lng], 16); panel.style.display = "none"; };
}
document.getElementById("close-map-info").onclick = () => document.getElementById("map-info-panel").style.display = "none";

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
        friendMarkers[id].on("click", () => {
            const latest = friendProfiles[id];
            if (latest) showFriendProfile(latest);
        });
    } else {
        friendMarkers[id].setLatLng([friend.lat, friend.lng]).setIcon(createFriendIcon(friend.avatar));
    }
    updateFriendTooltip(friend);
    renderOnlineList();
}

function renderOnlineList() {
    const box = document.getElementById("online-friends");
    if (!box) return;
    box.innerHTML = "";
    const friends = Array.from(onlineUsers.values()).filter(user => user.id !== socket.id);
    
    document.getElementById("chat-subtitle").textContent = `${friends.length} online`;

    if (!friends.length) { box.innerHTML = `<div style="color:#91a2ab;font-size:12px;">No friends online</div>`; return; }

    friends.forEach(user => {
        const row = document.createElement("div"); row.className = "online-friend";
        row.innerHTML = `<img src="${getSafeImageSource(user.avatar)}"><span>${escapeHTML(user.name || "Friend")}</span><span class="status-dot"></span>`;
        row.addEventListener("click", () => {
            const friend = friendProfiles[user.id];
            if (friend && Number.isFinite(friend.lat) && Number.isFinite(friend.lng)) {
                map.setView([friend.lat, friend.lng], 16);
                showFriendProfile(friend);
            }
        });
        box.appendChild(row);
    });
}

// Online Presence Sockets
socket.on("onlineUsers", list => { if(!Array.isArray(list)) return; list.forEach(u => { if(u?.id !== socket.id) { onlineUsers.set(u.id, u); friendProfiles[u.id] = u; if(Number.isFinite(Number(u.lat)) && Number.isFinite(Number(u.lng))) createOrUpdateFriend(u); }}); renderOnlineList(); });
socket.on("userOnline", user => { if(!user || user.id === socket.id) return; onlineUsers.set(user.id, user); friendProfiles[user.id] = user; createOrUpdateFriend(user); renderOnlineList(); });
socket.on("userOffline", data => { const id = data?.id; if(!id) return; onlineUsers.delete(id); delete friendProfiles[id]; if(friendMarkers[id]){ map.removeLayer(friendMarkers[id]); delete friendMarkers[id]; } renderOnlineList(); });
socket.on("friendDisconnected", id => { if(friendMarkers[id]){ map.removeLayer(friendMarkers[id]); delete friendMarkers[id]; } onlineUsers.delete(id); delete friendProfiles[id]; renderOnlineList(); });
socket.on("friendMoved", data => createOrUpdateFriend(data));

// ==========================================
// CHAT UI & LOGIC
// ==========================================
const input = document.getElementById("chatInput"), toggle = document.getElementById("chat-toggle-btn");
const minimize = document.getElementById("chat-minimize-btn"), attach = document.getElementById("chat-attach-btn");
const menu = document.getElementById("attachment-menu"), emojiPicker = document.getElementById("emojiPicker");
const sendBtn = document.getElementById("sendButton"), voiceBtn = document.getElementById("voiceButton");

function openChat() { chatOpen = true; document.getElementById("chat-container").style.display = "flex"; toggle.style.display = "none"; unreadCount = 0; updateUnread(); input?.focus(); }
function closeChat() { chatOpen = false; document.getElementById("chat-container").style.display = "none"; toggle.style.display = "flex"; hideMenus(); sendTyping(false); }
function updateUnread() { const b = document.getElementById("unread-badge"); if(b) { b.textContent = unreadCount > 99 ? "99+" : String(unreadCount); b.style.display = unreadCount ? "flex" : "none"; } }
function hideMenus() { if(menu) menu.style.display="none"; if(emojiPicker) emojiPicker.style.display="none"; }
function previewForMessage(msg) { return msg.type === "text" ? String(msg.data).slice(0, 50) + "..." : msg.type==="image" ? "📷 Photo" : msg.type==="video" ? "🎥 Video" : msg.type==="audio" ? "🎤 Voice" : "📎 Document"; }
function timeText(iso) { try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } }

toggle?.addEventListener("click", openChat); minimize?.addEventListener("click", closeChat);
input?.addEventListener("input", () => {
    const hasText = input.value.trim().length > 0;
    voiceBtn.style.display = hasText ? "none" : "flex"; sendBtn.style.display = hasText ? "flex" : "none";
    sendTyping(hasText);
    clearTimeout(typingTimer);
    if(hasText) typingTimer = setTimeout(() => sendTyping(false), 1200);
});

// Emojis
const emojis = ["😀","😂","😍","😎","🥳","👍","❤️","🔥","🎉","📍","📸","🚗","🌧️","☀️","😄","😮","😢","👏"];
emojis.forEach(emoji => {
    const btn = document.createElement("button"); btn.type = "button"; btn.textContent = emoji;
    btn.onclick = () => { if(reactingToMsgId){ socket.emit("messageReaction",{messageId: reactingToMsgId, emoji}); emojiPicker.style.display="none"; reactingToMsgId=null;} else { input.value += emoji; input.focus(); emojiPicker.style.display = "none"; voiceBtn.style.display="none"; sendBtn.style.display="flex";}};
    emojiPicker.appendChild(btn);
});
document.getElementById("emojiButton")?.addEventListener("click", (e) => { e.stopPropagation(); reactingToMsgId=null; emojiPicker.style.display = emojiPicker.style.display === "grid" ? "none" : "grid"; menu.style.display = "none"; });

// Typing Sockets
function sendTyping(value) {
    if(value && !currentlyTyping) { currentlyTyping = true; socket.emit("typing", true); }
    if(!value && currentlyTyping) { currentlyTyping = false; socket.emit("typing", false); }
}
const activeTypers = new Set();
socket.on("typing", data => {
    if(!data || data.id === socket.id) return;
    const indicator = document.getElementById("typing-indicator");
    if(!indicator) return;
    if(data.isTyping && data.name) activeTypers.add(data.name); else activeTypers.delete(data.name);
    
    if(activeTypers.size > 0) {
        indicator.textContent = Array.from(activeTypers).join(", ") + (activeTypers.size > 1 ? " are typing..." : " is typing...");
        indicator.style.display = "flex";
    } else {
        indicator.textContent = ""; indicator.style.display = "none";
    }
});

// Reply Logic
function setReply(msg) { replyTarget = { id: msg.id, name: msg.name, type: msg.type, preview: previewForMessage(msg) }; document.getElementById("reply-preview-container").style.display="block"; document.getElementById("reply-preview-text").textContent = `Replying to ${msg.name}: ${replyTarget.preview}`; input.focus(); }
function clearReply() { replyTarget = null; document.getElementById("reply-preview-container").style.display="none"; }
document.getElementById("cancel-reply-btn").onclick = (e) => { e.preventDefault(); clearReply(); };

window.reactTo = (msgId) => { reactingToMsgId = msgId; emojiPicker.style.display = "grid"; menu.style.display = "none"; };

// Render Message
function renderReactions(wrapper, reactions, messageId) {
    let row = wrapper.querySelector(".reaction-row");
    if (!row) { row = document.createElement("div"); row.className = "reaction-row"; wrapper.appendChild(row); }
    row.innerHTML = "";
    Object.entries(reactions || {}).forEach(([emoji, ids]) => {
        if (!Array.isArray(ids) || !ids.length) return;
        const btn = document.createElement("button"); btn.type = "button"; btn.className = "reaction"; btn.textContent = `${emoji} ${ids.length}`;
        btn.onclick = () => socket.emit("messageReaction", { messageId, emoji });
        row.appendChild(btn);
    });
}

function addChatMessage(msg) {
    const box = document.getElementById("chat-messages");
    if(!box || !msg || !msg.id) return;

    const wrapper = document.createElement("div");
    wrapper.className = "chat-message" + (msg.senderId === socket.id ? " mine" : "");
    wrapper.dataset.messageId = msg.id;

    const sender = document.createElement("div"); sender.className = "sender"; sender.innerHTML = `${escapeHTML(msg.name || "User")} <span class="msg-time">${timeText(msg.time)}</span>`;
    wrapper.appendChild(sender);

    if(msg.replyTo?.id) {
        const reply = document.createElement("div"); reply.className = "inline-reply";
        reply.innerHTML = `<span><b>${escapeHTML(msg.replyTo.name)}</b>: ${escapeHTML(msg.replyTo.preview)}</span>`;
        wrapper.appendChild(reply);
    }

    const content = document.createElement("div");
    if(msg.type === "text") {
        const text = String(msg.data).slice(0, 5000);
        content.textContent = text;
        const urls = text.match(/https?:\/\/\S+/g) || [];
        urls.slice(0, 2).forEach(rawUrl => {
            try {
                const url = new URL(rawUrl.replace(/[),.!?]+$/, ""));
                const host = url.hostname.toLowerCase();
                if(["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"].includes(host)) {
                    let videoId = url.searchParams.get("v");
                    if(!videoId && host === "youtu.be") videoId = url.pathname.slice(1).split("/")[0];
                    if(videoId && /^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
                        const vBox = document.createElement("div"); vBox.className = "youtube-box";
                        vBox.innerHTML = `<iframe src="https://www.youtube.com/embed/${videoId}" title="YouTube" allowfullscreen></iframe>`;
                        content.appendChild(vBox);
                    }
                }
            } catch {}
        });
    } else if(msg.type === "image" && isSafeDataUrl(msg.data, "image/")) {
        const img = document.createElement("img"); img.className = "chat-media"; img.src = msg.data; content.appendChild(img);
    } else if(msg.type === "video" && isSafeDataUrl(msg.data, "video/")) {
        const vid = document.createElement("video"); vid.className = "chat-media"; vid.src = msg.data; vid.controls = true; content.appendChild(vid);
    } else if(msg.type === "audio" && isSafeDataUrl(msg.data, "audio/")) {
        const aud = document.createElement("audio"); aud.className = "chat-audio"; aud.src = msg.data; aud.controls = true; content.appendChild(aud);
    } else if(msg.type === "document" && String(msg.data).startsWith("data:")) {
        const link = document.createElement("a"); link.className = "chat-document"; link.href = msg.data; link.target = "_blank"; link.download = "KoraputMap-File"; link.textContent = "📎 Download Document"; content.appendChild(link);
    } else return;
    wrapper.appendChild(content);

    // Actions
    const actions = document.createElement("div"); actions.className = "message-actions";
    const repBtn = document.createElement("button"); repBtn.type = "button"; repBtn.className = "action-btn"; repBtn.textContent = "↩ Reply";
    repBtn.onclick = () => setReply(msg); actions.appendChild(repBtn);
    const reactBtn = document.createElement("button"); reactBtn.type = "button"; reactBtn.className = "action-btn"; reactBtn.textContent = "😀";
    reactBtn.onclick = () => reactTo(msg.id); actions.appendChild(reactBtn);
    
    wrapper.appendChild(actions);
    box.appendChild(wrapper);

    renderReactions(wrapper, msg.reactions, msg.id);
    
    const clearDiv = document.createElement("div"); clearDiv.style.clear = "both"; box.appendChild(clearDiv);
    box.scrollTop = box.scrollHeight;
}

socket.on("chatMessage", msg => { addChatMessage(msg); if(!chatOpen && msg.senderId !== socket.id) { unreadCount++; updateUnread(); } });
socket.on("messageReaction", data => {
    const wrapper = document.querySelector(`[data-message-id="${CSS.escape(data.messageId)}"]`);
    if(wrapper) renderReactions(wrapper, data.reactions, data.messageId);
});

// Chat Forms & Attachments
document.getElementById("chatForm")?.addEventListener("submit", e => {
    e.preventDefault(); const text = input.value.trim(); if(!text) return;
    socket.emit("chatMessage", { type: "text", data: text.slice(0, 5000), replyTo: replyTarget });
    input.value = ""; voiceBtn.style.display="flex"; sendBtn.style.display="none"; clearReply(); sendTyping(false);
});

attach?.addEventListener("click", e => { e.stopPropagation(); menu.style.display = menu.style.display==="flex"?"none":"flex"; emojiPicker.style.display = "none"; });
document.addEventListener("click", e => { if(menu && !menu.contains(e.target) && e.target !== attach) menu.style.display = "none"; if(emojiPicker && !emojiPicker.contains(e.target) && e.target.id !== "emojiButton") emojiPicker.style.display="none";});

const fileIn = document.getElementById("chatAttachment"), camIn = document.getElementById("chat-camera-file");
document.getElementById("att-media")?.addEventListener("click", () => { fileIn.accept="image/*,video/*"; fileIn.click(); menu.style.display="none"; });
document.getElementById("att-doc")?.addEventListener("click", () => { fileIn.accept=".pdf,.doc,.docx,.txt,.csv,.xlsx,.ppt,.pptx,application/pdf,text/plain"; fileIn.click(); menu.style.display="none"; });
document.getElementById("att-audio")?.addEventListener("click", () => { fileIn.accept="audio/*"; fileIn.click(); menu.style.display="none"; });
document.getElementById("att-cam")?.addEventListener("click", () => { camIn.click(); menu.style.display="none"; });

function sendChatFile(file) {
    if(!file) return;
    if(file.size > 5*1024*1024) return alert("Attachment must be 5 MB or smaller.");
    let type = "document"; if(file.type.startsWith("image/")) type = "image"; else if(file.type.startsWith("video/")) type = "video"; else if(file.type.startsWith("audio/")) type = "audio";
    const r = new FileReader();
    r.onload = () => { socket.emit("chatMessage", { type, data: r.result, replyTo: replyTarget }); clearReply(); };
    r.onerror = () => alert("Could not read attachment.");
    r.readAsDataURL(file);
}
fileIn?.addEventListener("change", () => { if(fileIn.files?.[0]) sendChatFile(fileIn.files[0]); fileIn.value=""; });
camIn?.addEventListener("change", () => { if(camIn.files?.[0]) sendChatFile(camIn.files[0]); camIn.value=""; });

function setupVoice() {
    const btn = document.getElementById("voiceButton");
    if(!btn || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { if(btn) btn.disabled=true; return; }
    let recorder=null, chunks=[];
    btn.addEventListener("click", async () => {
        if(recorder?.state==="recording") { recorder.stop(); btn.textContent="🎤"; return; }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({audio:true});
            recorder = new MediaRecorder(stream); chunks=[];
            recorder.ondataavailable=e => { if(e.data?.size) chunks.push(e.data); };
            recorder.onstop=() => {
                stream.getTracks().forEach(t=>t.stop());
                const blob = new Blob(chunks, {type: recorder.mimeType || "audio/webm"});
                if(blob.size > 5*1024*1024) return alert("Voice message is too large.");
                const r = new FileReader();
                r.onload = () => { socket.emit("chatMessage", {type:"audio", data: r.result, replyTo: replyTarget}); clearReply(); };
                r.readAsDataURL(blob);
            };
            recorder.start(); btn.textContent="⏹️";
        } catch { alert("Microphone permission was not granted."); }
    });
}

// ==========================================
// MEMORY
// ==========================================
function renderMemoryPhoto(pin) {
    if(!pin || !Number.isFinite(Number(pin.lat)) || !Number.isFinite(Number(pin.lng)) || !isSafeDataUrl(pin.image, "image/")) return;
    const icon = L.divIcon({ className: "custom-pin", html: `<div class="memory-pin-box"><img src="${escapeHTML(pin.image)}" alt="Memory"></div>`, iconSize: [44, 44], iconAnchor: [22, 22] });
    const marker = L.marker([Number(pin.lat), Number(pin.lng)], {icon}).addTo(map);
    marker.bindPopup(`<div class="memory-popup"><img src="${escapeHTML(pin.image)}" alt="Memory"><b>${escapeHTML(pin.name || "Memory")}</b>${pin.time ? `<br><small>${escapeHTML(pin.time)}</small>` : ""}</div>`);
    memoryMarkers[pin.id] = marker;
}
socket.on("loadMemoryPhotos", photos => { if(Array.isArray(photos)) photos.forEach(renderMemoryPhoto); });
socket.on("newMemoryPin", renderMemoryPhoto);

function setupMemory() {
    const btn = document.getElementById("memoryButton"), input = document.getElementById("memoryPhotoInput");
    if(!btn || !input) return;
    btn.addEventListener("click", () => { if(!ownMarker) return alert("Wait for your location to load first."); input.click(); });
    input.addEventListener("change", () => {
        const file = input.files?.[0]; if(!file) return;
        if(!file.type.startsWith("image/") || file.size > 5*1024*1024) { alert("Choose an image up to 5 MB."); input.value=""; return; }
        const r = new FileReader();
        r.onload = () => {
            const pos = ownMarker.getLatLng();
            socket.emit("uploadMemoryPhoto", { name: currentUser.name, lat: pos.lat, lng: pos.lng, image: r.result, time: new Date().toLocaleString() });
            input.value="";
        };
        r.readAsDataURL(file);
    });
}

// ==========================================
// JOIN / SETUP
// ==========================================
function announceProfile() { socket.emit("profileReady", {name: currentUser.name, avatar: currentUser.avatar}); }
function setupJoin() {
    const btn = document.getElementById("joinButton"), input = document.getElementById("nameInput"), screen = document.getElementById("join-screen"), avatarInput = document.getElementById("avatarInput");
    if(!btn) return;
    input.value = currentUser.name !== "User" ? currentUser.name : "";
    if(currentUser.name !== "User") { screen.style.display = "none"; document.getElementById("header-avatar").style.display = "block"; document.getElementById("header-avatar").src = currentUser.avatar;}

    btn.addEventListener("click", () => {
        const name = input.value.trim(); if(!name) return alert("Please enter your name.");
        currentUser.name = name.slice(0, 40); saveUser(); announceProfile(); screen.style.display="none";
        document.getElementById("header-avatar").style.display = "block"; document.getElementById("header-avatar").src = currentUser.avatar;
        if(ownMarker && myCoords) { ownMarker.setIcon(createOwnIcon(currentUser.avatar)); emitLocation(myCoords.lat, myCoords.lng, myWeather); }
    });

    avatarInput?.addEventListener("change", () => {
        const file = avatarInput.files?.[0]; if(!file) return;
        if(!file.type.startsWith("image/") || file.size > 2*1024*1024) { alert("Avatar must be an image up to 2 MB."); avatarInput.value=""; return; }
        const r = new FileReader();
        r.onload = () => {
            if(!isSafeDataUrl(r.result, "image/")) return;
            currentUser.avatar = r.result; saveUser(); announceProfile();
            document.getElementById("header-avatar").src = currentUser.avatar;
            if(ownMarker) ownMarker.setIcon(createOwnIcon(currentUser.avatar));
        };
        r.readAsDataURL(file);
    });
}

// Controls
document.getElementById("map-style-btn")?.addEventListener("click", (e) => { e.stopPropagation(); const m = document.getElementById("map-style-menu"); m.style.display = m.style.display === "flex" ? "none" : "flex"; });
document.getElementById("map-style-menu")?.querySelectorAll("button[data-style]").forEach(b => {
    b.addEventListener("click", () => {
        const style = b.dataset.style; if(style === currentMapStyle) return;
        map.removeLayer(mapLayers[currentMapStyle]); currentMapStyle = style; mapLayers[currentMapStyle].addTo(map);
        document.getElementById("map-style-menu").querySelectorAll("button").forEach(btn => btn.classList.remove("active"));
        b.classList.add("active"); document.getElementById("map-style-menu").style.display = "none";
    });
});
document.addEventListener("click", e => { const m = document.getElementById("map-style-menu"), btn = document.getElementById("map-style-btn"); if (m && !m.contains(e.target) && e.target !== btn) m.style.display = "none"; });
document.getElementById("my-location-btn").onclick = () => { if(myCoords) map.flyTo([myCoords.lat, myCoords.lng], 16); };
document.getElementById("compass-btn").onclick = () => { map.setView(map.getCenter(), map.getZoom(), {animate:true}); document.getElementById("compass-icon").style.transform="rotate(0deg)";};
if(window.DeviceOrientationEvent) window.addEventListener('deviceorientation', e => { const icon=document.getElementById('compass-icon'); if(icon && e.webkitCompassHeading) icon.style.transform=`rotate(${-e.webkitCompassHeading}deg)`; }, true);

// START
socket.on("connect", () => { announceProfile(); if(myCoords) emitLocation(myCoords.lat, myCoords.lng, myWeather); });

function setup() {
    setupJoin(); setupMemory(); setupVoice();
    document.getElementById("online-btn").onclick = () => { const l = document.getElementById("online-list"); l.style.display = l.style.display==="none" ? "block" : "none"; renderOnlineList(); };
    if(currentUser.name !== "User") announceProfile();
}

if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup); else setup();
