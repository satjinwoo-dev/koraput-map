// 1. Initialize Socket & Map Variables
const socket = io();
let myName = "Explorer";
let myAvatar = 'friend1.png';
const markers = {};
let myMarker = null;

// 2. Initialize Map with Google Earth (Hybrid) View
const map = L.map('map').setView([18.8121, 82.7135], 14);
L.tileLayer('https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    attribution: '&copy; Google Maps'
}).addTo(map);

// 3. Core Tracking Function (Starts ONLY after joining)
function initTracking() {
    if ("geolocation" in navigator) {
        navigator.geolocation.watchPosition((position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            const weatherText = "28°C";

            if (!myMarker) {
                const customIcon = L.divIcon({
                    className: 'custom-avatar-icon',
                    html: `<div style="background-image: url('${myAvatar}'); width: 40px; height: 40px; background-size: cover; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 5px rgba(0,0,0,0.5);"></div>`,
                    iconSize: [40, 40],
                    iconAnchor: [20, 20]
                });
                myMarker = L.marker([lat, lng], { icon: customIcon }).addTo(map);
                myMarker.bindPopup(`<b>You (${myName})</b><br>Weather: ${weatherText}`).openPopup();
                map.setView([lat, lng], 16);
            } else {
                myMarker.setLatLng([lat, lng]);
            }

            socket.emit('updateLocation', { lat, lng, avatar: myAvatar, weather: weatherText });
        }, (error) => console.error(error), { enableHighAccuracy: true, maximumAge: 10000 });
    }
}

// 4. Safe "Join Map" Logic (Prevents page reload & shows all features)
window.addEventListener('DOMContentLoaded', () => {
    // Attach listener directly to the document body to catch any "Join Map" click safely
    document.body.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON' && e.target.innerText.includes('Join Map')) {
            e.preventDefault(); // Stop form submission / reload
            
            // Try to grab the username from possible inputs
            const nameInput = document.getElementById('username') || document.querySelector('input[type="text"]');
            if (nameInput && nameInput.value.trim() !== '') {
                myName = nameInput.value.trim();
            }

            // Hide the Modal properly (finds the closest modal container)
            const modal = document.getElementById('login-modal') || document.getElementById('join-modal') || e.target.closest('div[style*="fixed"]');
            if (modal) modal.style.display = 'none';

            // Start location sharing
            initTracking();
        }
    });

    // Handle form submit just in case it's triggered via 'Enter' key
    const joinForm = document.getElementById('join-map-form') || document.querySelector('form');
    if (joinForm && joinForm.innerText.includes('Join Map')) {
        joinForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const btn = joinForm.querySelector('button');
            if(btn) btn.click();
        });
    }
});

// 5. Chat Box Functionality
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');

if (chatForm && chatInput) {
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (chatInput.value.trim() !== '') {
            socket.emit('chatMessage', {
                name: myName,
                text: chatInput.value.trim(),
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
            chatInput.value = '';
        }
    });
}

socket.on('chatMessage', (msg) => {
    if (chatMessages) {
        const msgDiv = document.createElement('div');
        msgDiv.style.margin = '4px 0';
        msgDiv.innerHTML = `<b>${msg.name}:</b> ${msg.text} <span style="font-size: 9px; color: gray;">(${msg.time})</span>`;
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
});

// 6. Multiplayer Features (Friend Movements)
socket.on('friendMoved', (data) => {
    if (markers[data.id]) {
        markers[data.id].setLatLng([data.lat, data.lng]);
    } else {
        const icon = L.divIcon({
            className: 'custom-avatar-icon',
            html: `<div style="background-image: url('${data.avatar || 'friend1.png'}'); width: 40px; height: 40px; background-size: cover; border-radius: 50%; border: 2px solid #00a884;"></div>`,
            iconSize: [40, 40], iconAnchor: [20, 20]
        });
        markers[data.id] = L.marker([data.lat, data.lng], { icon }).addTo(map).bindPopup(`<b>Friend</b>`);
    }
});

socket.on('friendDisconnected', (id) => {
    if (markers[id]) { map.removeLayer(markers[id]); delete markers[id]; }
});

// 7. Memory Photos (Loading & Placing)
function renderMemoryPin(data) {
    const memoryIcon = L.divIcon({
        className: 'memory-pin-icon',
        html: `<div style="width: 42px; height: 42px; border-radius: 50%; border: 3px solid #00a884; overflow: hidden; background: #fff;"><img src="${data.image}" style="width: 100%; height: 100%; object-fit: cover;"></div>`,
        iconSize: [42, 42], iconAnchor: [21, 21]
    });
    const popupContent = `<div style="text-align: center;"><img src="${data.image}" style="width: 220px; border-radius: 8px;"><br><b>📸 ${data.name}</b><br><small>${data.time}</small></div>`;
    L.marker([data.lat, data.lng], { icon: memoryIcon }).addTo(map).bindPopup(popupContent);
}

socket.on('loadMemoryPhotos', (photos) => photos.forEach(renderMemoryPin));
socket.on('newMemoryPin', renderMemoryPin);

// 8. Click-to-Place Photo Upload
const mapFileInput = document.getElementById('map-file-input');
if (mapFileInput) {
    mapFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            alert("📸 Map par click karo kahan photo lagani hai!");
            map.once('click', (mapEvent) => {
                socket.emit('uploadMemoryPhoto', {
                    name: myName,
                    lat: mapEvent.latlng.lat,
                    lng: mapEvent.latlng.lng,
                    image: event.target.result,
                    time: new Date().toLocaleString()
                });
            });
        };
        reader.readAsDataURL(file);
        mapFileInput.value = ''; // Reset
    });
}
