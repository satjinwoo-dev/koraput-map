// ==========================================
// KORAPUT MAP - MAIN JAVASCRIPT (FULL VERSION)
// ==========================================

const socket = io();

// ==========================================
// MAP SETUP
// ==========================================

const map = L.map("map").setView([18.8136, 82.7153], 13);

const markers = {};
let myMarker = null;

// ==========================================
// USER DATA
// ==========================================

let myAvatarData = "satyam.png";
let myName = "satyam";
let myWeatherInfo = "";
let myCoords = null;

// ==========================================
// GOOGLE EARTH SATELLITE MAP (Hybrid Layer)
// ==========================================

L.tileLayer(
    "https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}", 
    {
        maxZoom: 20,
        subdomains: ["mt0", "mt1", "mt2", "mt3"],
        attribution: "&copy; Google Maps"
    }
).addTo(map);

// ==========================================
// LOAD SAVED USER DATA
// ==========================================

window.addEventListener("DOMContentLoaded", () => {
    const savedName = localStorage.getItem("koraput_name");
    const savedAvatar = localStorage.getItem("koraput_avatar");

    if (savedName) myName = savedName;
    if (savedAvatar) myAvatarData = savedAvatar;

    if (savedName && savedAvatar) {
        launchApp();
    }
});

// ==========================================
// JOIN MAP BUTTON
// ==========================================

document.addEventListener("click", (e) => {
    const target = e.target;

    if (target && (target.id === "joinBtn" || target.innerText?.trim() === "Join Map")) {
        e.preventDefault();

        const nameInput = document.querySelector('input[type="text"]');
        if (nameInput && nameInput.value.trim() !== "") {
            myName = nameInput.value.trim();
        }

        const fileInput = document.querySelector('input[type="file"]');
        const file = fileInput?.files?.[0];

        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                myAvatarData = event.target.result;
                saveAndLaunch();
            };
            reader.onerror = () => {
                saveAndLaunch();
            };
            reader.readAsDataURL(file);
        } else {
            saveAndLaunch();
        }
    }
});

// ==========================================
// SAVE USER DATA
// ==========================================

function saveAndLaunch() {
    localStorage.setItem("koraput_name", myName);
    localStorage.setItem("koraput_avatar", myAvatarData);
    launchApp();
}

// ==========================================
// START APPLICATION
// ==========================================

function launchApp() {
    const joinScreen = document.getElementById("join-screen");
    if (joinScreen) joinScreen.style.display = "none";

    // Fallback hide any overlay
    document.querySelectorAll('form, div').forEach(el => {
        if (el.innerHTML && el.innerHTML.includes('Join Koraput Map')) {
            el.style.display = 'none';
        }
    });

    const chatToggle = document.getElementById("chat-toggle-btn");
    if (chatToggle) chatToggle.style.display = "flex";

    setTimeout(() => {
        map.invalidateSize();
    }, 300);

    startLocationTracking();
}

// ==========================================
// GEOLOCATION TRACKING
// ==========================================

function startLocationTracking() {
    if (!navigator.geolocation) return;

    navigator.geolocation.watchPosition(
        (position) => {
            const latitude = position.coords.latitude;
            const longitude = position.coords.longitude;

            myCoords = { lat: latitude, lng: longitude };

            socket.emit("updateLocation", {
                lat: latitude,
                lng: longitude,
                avatar: myAvatarData,
                name: myName,
                weather: myWeatherInfo
            });

            updateMyMarker(latitude, longitude);
        },
        (error) => console.error("Location error:", error.message),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
}

// ==========================================
// CREATE / UPDATE OWN MARKER
// ==========================================

function updateMyMarker(latitude, longitude) {
    if (myMarker) {
        myMarker.setLatLng([latitude, longitude]);
    } else {
        myMarker = L.marker([latitude, longitude], {
            icon: createAvatarIcon(myAvatarData)
        }).addTo(map);

        myMarker.bindPopup(
            `<b>${escapeHTML(myName)}</b><br><small>Your location</small>`
        );
    }
    map.setView([latitude, longitude], 16);
}

// ==========================================
// CREATE AVATAR ICON
// ==========================================

function createAvatarIcon(avatar) {
    return L.icon({
        iconUrl: avatar,
        iconSize: [45, 45],
        iconAnchor: [22, 22],
        popupAnchor: [0, -22],
        className: "avatar-icon"
    });
}

// ==========================================
// MEMORY PHOTO INPUT
// ==========================================

const mapFileInput = document.getElementById("map-file-input");

if (mapFileInput) {
    mapFileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
            const imageData = ev.target.result;
            alert("📸 Click anywhere on the map to pin your memory photo!");

            map.once("click", (mapEvent) => {
                const memory = {
                    name: myName,
                    lat: mapEvent.latlng.lat,
                    lng: mapEvent.latlng.lng,
                    image: imageData,
                    time: new Date().toLocaleString()
                };

                socket.emit("uploadMemoryPhoto", memory);
                mapFileInput.value = "";
            });
        };
        reader.readAsDataURL(file);
    });
}

// ==========================================
// RENDER MEMORY PHOTO
// ==========================================

function renderMemoryPhoto(memory) {
    if (!memory || typeof memory.lat !== "number" || typeof memory.lng !== "number" || !memory.image) return;

    const memoryIcon = L.divIcon({
        className: "memory-pin-icon",
        html: `
            <div style="width:42px; height:42px; border-radius:50%; border:3px solid #00a884; overflow:hidden; background:#ffffff; box-shadow:0 2px 8px rgba(0,0,0,0.4);">
                <img src="${memory.image}" alt="Memory" style="width:100%; height:100%; object-fit:cover;">
            </div>
        `,
        iconSize: [42, 42],
        iconAnchor: [21, 21]
    });

    const marker = L.marker([memory.lat, memory.lng], { icon: memoryIcon }).addTo(map);

    const safeName = escapeHTML(memory.name || "Someone");
    const safeTime = escapeHTML(memory.time || "");

    marker.bindPopup(`
        <div style="text-align:center;">
            <b>📸 ${safeName}</b><br>
            <small>${safeTime}</small><br><br>
            <img src="${memory.image}" alt="Memory photo" style="width:200px; max-width:100%; border-radius:8px;">
        </div>
    `);
}

socket.on("newMemoryPin", (memory) => {
    renderMemoryPhoto(memory);
});

socket.on("loadMemoryPhotos", (photos) => {
    if (Array.isArray(photos)) {
        photos.forEach((photo) => renderMemoryPhoto(photo));
    }
});

// ==========================================
// WHATSAPP CHAT & MEDIA UI LOGIC
// ==========================================

const chatContainer = document.getElementById('chat-container');
const chatToggleBtn = document.getElementById('chat-toggle-btn');
const minimizeBtn = document.getElementById('chat-minimize-btn');

if (chatToggleBtn && chatContainer) {
    chatToggleBtn.addEventListener('click', () => {
        chatContainer.style.display = 'flex';
        chatToggleBtn.style.display = 'none';
    });
}

if (minimizeBtn && chatContainer && chatToggleBtn) {
    minimizeBtn.addEventListener('click', () => {
        chatContainer.style.display = 'none';
        chatToggleBtn.style.display = 'flex';
    });
}

const chatInput = document.getElementById('chat-input');
const micBtn = document.getElementById('chat-mic-btn');
const sendBtn = document.getElementById('chat-send');
const attachBtn = document.getElementById('chat-attach-btn');
const attachmentMenu = document.getElementById('attachment-menu');
const fileInput = document.getElementById('chat-file');
const cameraFileInput = document.getElementById('chat-camera-file');
const emojiBtn = document.getElementById('chat-emoji-btn');
const emojiPickerContainer = document.getElementById('emoji-picker-container');
const emojiPicker = document.querySelector('emoji-picker');

if (chatInput && micBtn && sendBtn) {
    chatInput.addEventListener('input', () => {
        if (chatInput.value.trim().length > 0) {
            micBtn.style.display = 'none';
            sendBtn.style.display = 'flex';
        } else {
            micBtn.style.display = 'flex';
            sendBtn.style.display = 'none';
        }
    });
}

const chatForm = document.getElementById('chat-form');
if (chatForm && chatInput) {
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const msg = chatInput.value.trim();
        if (msg) {
            socket.emit('chatMessage', { name: myName, type: 'text', data: msg });
            chatInput.value = '';
            if (micBtn) micBtn.style.display = 'flex';
            if (sendBtn) sendBtn.style.display = 'none';
        }
    });
}

if (attachBtn && attachmentMenu) {
    attachBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (emojiPickerContainer) emojiPickerContainer.style.display = 'none';
        attachmentMenu.style.display = attachmentMenu.style.display === 'flex' ? 'none' : 'flex';
    });
}

document.getElementById('att-media')?.addEventListener('click', () => {
    if (fileInput) { fileInput.accept = "image/*,video/*"; fileInput.click(); }
    if (attachmentMenu) attachmentMenu.style.display = 'none';
});

document.getElementById('att-doc')?.addEventListener('click', () => {
    if (fileInput) { fileInput.accept = ".pdf,.docx,.txt,.zip"; fileInput.click(); }
    if (attachmentMenu) attachmentMenu.style.display = 'none';
});

document.getElementById('att-audio')?.addEventListener('click', () => {
    if (fileInput) { fileInput.accept = "audio/*"; fileInput.click(); }
    if (attachmentMenu) attachmentMenu.style.display = 'none';
});

document.getElementById('att-cam')?.addEventListener('click', () => {
    if (cameraFileInput) cameraFileInput.click();
    if (attachmentMenu) attachmentMenu.style.display = 'none';
});

if (fileInput) {
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                socket.emit('chatMessage', { name: myName, type: 'image', data: e.target.result });
            };
            reader.readAsDataURL(file);
            fileInput.value = '';
        }
    });
}

if (cameraFileInput) {
    cameraFileInput.addEventListener('change', () => {
        const file = cameraFileInput.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                socket.emit('chatMessage', { name: myName, type: 'image', data: e.target.result });
            };
            reader.readAsDataURL(file);
            cameraFileInput.value = '';
        }
    });
}

if (emojiBtn && emojiPickerContainer) {
    emojiBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (attachmentMenu) attachmentMenu.style.display = 'none';
        emojiPickerContainer.style.display = emojiPickerContainer.style.display === 'block' ? 'none' : 'block';
    });
}

document.addEventListener('click', (e) => {
    if (attachmentMenu && !attachmentMenu.contains(e.target) && e.target !== attachBtn) {
        attachmentMenu.style.display = 'none';
    }
    if (emojiPickerContainer && !emojiPickerContainer.contains(e.target) && e.target !== emojiBtn) {
        emojiPickerContainer.style.display = 'none';
    }
});

if (emojiPicker && chatInput) {
    emojiPicker.addEventListener('emoji-click', event => {
        chatInput.value += event.detail.unicode;
        chatInput.focus();
        chatInput.dispatchEvent(new Event('input'));
    });
}

// Voice Recorder
let mediaRecorder;
let audioChunks = [];
let isRecording = false;

if (micBtn) {
    micBtn.addEventListener('click', async () => {
        if (!isRecording) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream);
                
                mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
                mediaRecorder.onstop = () => {
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    audioChunks = [];
                    const reader = new FileReader();
                    reader.onload = (e) => socket.emit('chatMessage', { name: myName, type: 'audio', data: e.target.result });
                    reader.readAsDataURL(audioBlob);
                };

                mediaRecorder.start();
                isRecording = true;
                micBtn.style.background = '#f15c6d'; 
                micBtn.style.color = 'white';
            } catch (err) {
                alert("Microphone permission denied.");
            }
        } else {
            mediaRecorder.stop();
            mediaRecorder.stream.getTracks().forEach(t => t.stop());
            isRecording = false;
            micBtn.style.background = '#00a884'; 
            micBtn.style.color = '#111b21';
        }
    });
}

// Incoming Chat Messages (with Spotify & YouTube Support)
socket.on('chatMessage', (msg) => {
    const messagesDiv = document.getElementById('chat-messages');
    if (!messagesDiv) return;
    
    const newMsg = document.createElement('div');
    newMsg.className = 'msg-bubble ' + (msg.name === myName ? 'msg-mine' : 'msg-theirs');
    
    let content = `<div class="msg-name">${escapeHTML(msg.name)}</div>`;
    
    if (msg.type === 'text') {
        const spotifyRegex = /https:\/\/open\.spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/;
        const spotifyMatch = msg.data.match(spotifyRegex);

        const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const youtubeMatch = msg.data.match(youtubeRegex);

        if (spotifyMatch) {
            const type = spotifyMatch[1];
            const id = spotifyMatch[2];
            content += `<div style="margin-top: 5px; width: 280px;">
                <iframe style="border-radius:12px; display:block;" src="https://open.spotify.com/embed/${type}/${id}?utm_source=generator&theme=0" width="100%" height="152" frameBorder="0" allowfullscreen="" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>
            </div>`;
        } else if (youtubeMatch) {
            const videoId = youtubeMatch[1];
            content += `<div style="margin-top: 5px; width: 280px; position: relative; padding-bottom: 56.25%; height: 0;">
                <iframe style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border:0; border-radius: 8px;" src="https://www.youtube.com/embed/${videoId}" allowfullscreen="" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe>
            </div>`;
        } else {
            content += escapeHTML(msg.data);
        }
    } else if (msg.type === 'image') {
        content += `<img src="${msg.data}" style="width: 280px; border-radius: 8px; margin-top: 5px; object-fit: cover;">`;
    } else if (msg.type === 'audio') {
        content += `<audio controls src="${msg.data}" style="width: 260px; height: 35px; margin-top: 5px;"></audio>`;
    }

    newMsg.innerHTML = content;
    messagesDiv.appendChild(newMsg);
    messagesDiv.scrollTop = messagesDiv.scrollHeight; 
});

// ==========================================
// ESCAPE HTML UTILITY
// ==========================================

function escapeHTML(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
