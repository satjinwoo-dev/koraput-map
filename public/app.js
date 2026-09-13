const socket = io();
const map = L.map('map').setView([18.8136, 82.7153], 13);
const markers = {};
let myMarker = null;
let myAvatarData = null;
let myName = "satyam"; 
let myWeatherInfo = ""; 
let myCoords = null; 

// 1. Google Earth Style (Google Maps Satellite & Hybrid Layer)
const googleHybrid = L.tileLayer('https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    attribution: '&copy; Google Maps'
});
googleHybrid.addTo(map);

// 2. Haversine Distance Calculation
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const d = R * c; 
    
    if (d < 1) {
        return Math.round(d * 1000) + " m";
    }
    return d.toFixed(1) + " km";
}

// 3. Real-Time Weather Widget Logic (Open-Meteo)
function getWeatherEmoji(code, isDay) {
    if (code === 0) return isDay ? '☀️' : '🌙'; 
    if (code >= 1 && code <= 3) return isDay ? '⛅' : '☁️'; 
    if (code >= 45 && code <= 48) return '🌫️'; 
    if (code >= 51 && code <= 67) return '🌧️'; 
    if (code >= 71 && code <= 77) return '❄️'; 
    if (code >= 80 && code <= 82) return '🌦️'; 
    if (code >= 95) return '⛈️'; 
    return '🌡️';
}

async function updateWeather(lat, lng) {
    try {
        const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true`);
        const data = await res.json();
        const temp = Math.round(data.current_weather.temperature);
        const isDay = data.current_weather.is_day;
        const code = data.current_weather.weathercode;
        
        myWeatherInfo = `${getWeatherEmoji(code, isDay)} ${temp}°C`;
        
        if (myMarker) {
            myMarker.bindTooltip(myWeatherInfo, { permanent: true, direction: 'right', className: 'weather-badge', offset: [20, 0] });
        }
    } catch (err) {
        console.error("Weather fetch failed:", err);
    }
}

const createAvatar = (imageSource) => L.icon({
    iconUrl: imageSource, iconSize: [45, 45], iconAnchor: [22, 22], className: 'avatar-icon'
});

// 4. Check LocalStorage on Page Load (Auto-Login if saved)
window.addEventListener('DOMContentLoaded', () => {
    const savedName = localStorage.getItem('koraput_name');
    const savedAvatar = localStorage.getItem('koraput_avatar');

    if (savedName && savedAvatar) {
        myName = savedName;
        myAvatarData = savedAvatar;
        document.getElementById('header-name').innerText = myName + " (Koraput Map)";
        document.getElementById('header-avatar').src = myAvatarData;
        startGame();
    }
});

// 5. Join Map Logic & Save to LocalStorage
document.getElementById('joinBtn').addEventListener('click', () => {
    const inputName = document.getElementById('nameInput').value.trim();
    if (inputName) myName = inputName;

    document.getElementById('header-name').innerText = myName + " (Koraput Map)";

    const file = document.getElementById('imageInput').files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            myAvatarData = e.target.result; 
            document.getElementById('header-avatar').src = myAvatarData;
            
            localStorage.setItem('koraput_name', myName);
            localStorage.setItem('koraput_avatar', myAvatarData);

            startGame();
        }
        reader.readAsDataURL(file);
    } else {
        myAvatarData = 'satyam.png';
        document.getElementById('header-avatar').src = myAvatarData;
        
        localStorage.setItem('koraput_name', myName);
        localStorage.setItem('koraput_avatar', myAvatarData);

        startGame();
    }
});

function startGame() {
    document.getElementById('join-screen').style.display = 'none';
    document.getElementById('chat-toggle-btn').style.display = 'flex';
    document.getElementById('chat-container').style.display = 'none'; 
    
    let weatherFetched = false;

    if (navigator.geolocation) {
        navigator.geolocation.watchPosition((position) => {
            const { latitude, longitude } = position.coords;
            myCoords = { lat: latitude, lng: longitude };
            
            if (!weatherFetched) {
                updateWeather(latitude, longitude);
                weatherFetched = true;
            }

            socket.emit('updateLocation', { lat: latitude, lng: longitude, avatar: myAvatarData, weather: myWeatherInfo });

            if (myMarker) {
                myMarker.setLatLng([latitude, longitude]);
                if(myWeatherInfo) myMarker.setTooltipContent(myWeatherInfo);
            } else {
                myMarker = L.marker([latitude, longitude], { icon: createAvatar(myAvatarData) }).addTo(map);
                if(myWeatherInfo) myMarker.bindTooltip(myWeatherInfo, { permanent: true, direction: 'right', className: 'weather-badge', offset: [20, 0] });
            }
            
            map.setView([latitude, longitude], 16);
        }, (err) => console.error(err), { enableHighAccuracy: true });
    }
}

// 6. Add Custom Upload Button Directly into Leaflet Control Area
const UploadControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function (map) {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        const button = L.DomUtil.create('a', 'map-upload-control', container);
        button.innerHTML = '📸';
        button.title = 'Upload Memory to Map';
        
        L.DomEvent.on(button, 'click', (e) => {
            L.DomEvent.stopPropagation(e);
            L.DomEvent.preventDefault(e);
            document.getElementById('map-file-input').click();
        });

        return container;
    }
});
map.addControl(new UploadControl());

// 7. Map Marker Syncing with Live Distance
socket.on('friendMoved', (data) => {
    let tooltipText = data.weather || '';
    
    if (myCoords) {
        const dist = calculateDistance(myCoords.lat, myCoords.lng, data.lat, data.lng);
        tooltipText = `${data.weather || ''} | 📍 ${dist}`.trim();
    }

    if (markers[data.id]) {
        markers[data.id].setLatLng([data.lat, data.lng]);
        if(tooltipText && markers[data.id].getTooltip()) {
            markers[data.id].setTooltipContent(tooltipText);
        } else if (tooltipText) {
            markers[data.id].bindTooltip(tooltipText, { permanent: true, direction: 'right', className: 'weather-badge', offset: [20, 0] });
        }
    } else {
        markers[data.id] = L.marker([data.lat, data.lng], { icon: createAvatar(data.avatar) }).addTo(map);
        if(tooltipText) {
            markers[data.id].bindTooltip(tooltipText, { permanent: true, direction: 'right', className: 'weather-badge', offset: [20, 0] });
        }
    }
});

socket.on('friendDisconnected', (id) => {
    if (markers[id]) { map.removeLayer(markers[id]); delete markers[id]; }
});

// 8. Interactive Click-to-Place Memory Upload Listener[cite: 1]
const mapFileInput = document.getElementById('map-file-input');

mapFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        const imageData = event.target.result;
        const photoTime = new Date().toLocaleString();

        alert("📸 Now click anywhere on the map where you want to place this memory photo!");[cite: 1]

        map.once('click', (mapEvent) => {
            const { lat, lng } = mapEvent.latlng;

            socket.emit('uploadMemoryPhoto', {
                name: myName,
                lat: lat,
                lng: lng,
                image: imageData,
                time: photoTime
            });
            alert("Memory photo pinned successfully at your chosen location!");
        });
    };
    
    reader.onerror = (error) => {
        console.error("File reading error:", error);
        alert("Failed to read image file.");
    };

    reader.readAsDataURL(file);
    mapFileInput.value = '';
});

// 9. WhatsApp UI & Minimize / Toggle Logic
const chatContainer = document.getElementById('chat-container');
const chatToggleBtn = document.getElementById('chat-toggle-btn');
const minimizeBtn = document.getElementById('chat-minimize-btn');

chatToggleBtn.addEventListener('click', () => {
    chatContainer.style.display = 'flex';
    chatToggleBtn.style.display = 'none';
});

minimizeBtn.addEventListener('click', () => {
    chatContainer.style.display = 'none';
    chatToggleBtn.style.display = 'flex';
});

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

chatInput.addEventListener('input', () => {
    if (chatInput.value.trim().length > 0) {
        micBtn.style.display = 'none';
        sendBtn.style.display = 'flex';
    } else {
        micBtn.style.display = 'flex';
        sendBtn.style.display = 'none';
    }
});

document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = chatInput.value.trim();
    if (msg) {
        socket.emit('chatMessage', { name: myName, type: 'text', data: msg });
        chatInput.value = '';
        micBtn.style.display = 'flex';
        sendBtn.style.display = 'none';
    }
});

attachBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    emojiPickerContainer.style.display = 'none';
    attachmentMenu.style.display = attachmentMenu.style.display === 'flex' ? 'none' : 'flex';
});

document.getElementById('att-media').addEventListener('click', () => {
    fileInput.accept = "image/*,video/*";
    fileInput.click();
    attachmentMenu.style.display = 'none';
});

document.getElementById('att-doc').addEventListener('click', () => {
    fileInput.accept = ".pdf,.docx,.txt,.zip";
    fileInput.click();
    attachmentMenu.style.display = 'none';
});

document.getElementById('att-audio').addEventListener('click', () => {
    fileInput.accept = "audio/*";
    fileInput.click();
    attachmentMenu.style.display = 'none';
});

document.getElementById('att-cam').addEventListener('click', () => {
    cameraFileInput.click();
    attachmentMenu.style.display = 'none';
});

document.getElementById('att-contact').addEventListener('click', () => {
    alert("Contact sharing feature coming soon!");
    attachmentMenu.style.display = 'none';
});

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

emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    attachmentMenu.style.display = 'none';
    emojiPickerContainer.style.display = emojiPickerContainer.style.display === 'block' ? 'none' : 'block';
});

document.addEventListener('click', (e) => {
    if (!attachmentMenu.contains(e.target) && e.target !== attachBtn) {
        attachmentMenu.style.display = 'none';
    }
    if (!emojiPickerContainer.contains(e.target) && e.target !== emojiBtn) {
        emojiPickerContainer.style.display = 'none';
    }
});

emojiPicker.addEventListener('emoji-click', event => {
    chatInput.value += event.detail.unicode;
    chatInput.focus();
    chatInput.dispatchEvent(new Event('input'));
});

let mediaRecorder;
let audioChunks = [];
let isRecording = false;

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

socket.on('chatMessage', (msg) => {
    const messagesDiv = document.getElementById('chat-messages');
    const newMsg = document.createElement('div');
    
    newMsg.className = 'msg-bubble ' + (msg.name === myName ? 'msg-mine' : 'msg-theirs');
    
    let content = `<div class="msg-name">${msg.name}</div>`;
    
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
            content += msg.data;
        }
    } else if (msg.type === 'image') {
        content += `<img src="${msg.data}" style="width: 280px; border-radius: 8px; margin-top: 5px; object-path: cover;">`;
    } else if (msg.type === 'audio') {
        content += `<audio controls src="${msg.data}" style="width: 260px; height: 35px; margin-top: 5px;"></audio>`;
    }

    newMsg.innerHTML = content;
    messagesDiv.appendChild(newMsg);
    messagesDiv.scrollTop = messagesDiv.scrollHeight; 
});

// 10. Load Existing Memory Photos on Connection & Refresh
function renderMemoryPin(memory) {
    const memoryIcon = L.divIcon({
        className: 'memory-pin-icon',
        html: `<div style="width: 42px; height: 42px; border-radius: 50%; border: 3px solid #00a884; overflow: hidden; background: #fff; box-shadow: 0 3px 8px rgba(0,0,0,0.6);">
                 <img src="${memory.image}" style="width: 100%; height: 100%; object-fit: cover;">
               </div>`,
        iconSize: [42, 42],
        iconAnchor: [21, 21]
    });

    const marker = L.marker([memory.lat, memory.lng], { icon: memoryIcon }).addTo(map);

    marker.bindPopup(`
        <div style="text-align: center; color: #111; font-family: sans-serif; padding: 2px;">
            <img src="${memory.image}" style="width: 220px; border-radius: 8px; margin-bottom: 6px; object-fit: cover;">
            <p style="margin: 4px 0; font-weight: bold; font-size: 13px;">📸 Captured by: ${memory.name}</p>
            <p style="margin: 0; font-size: 11px; color: #555;">🕒 ${memory.time}</p>
        </div>
    `);
}

socket.on('loadMemoryPhotos', (photos) => {
    photos.forEach(renderMemoryPin);
});

socket.on('newMemoryPin', renderMemoryPin);
