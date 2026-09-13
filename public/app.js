// Initialize Socket.io connection
const socket = io();

let myName = "Explorer";
let myAvatar = 'friend1.png';

// Initialize Leaflet Map
const map = L.map('map').setView([18.8121, 82.7135], 14);

// Google Maps Satellite / Hybrid Layer (Google Earth style)
const googleHybrid = L.tileLayer('https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    attribution: '&copy; Google Maps'
});
googleHybrid.addTo(map);

// Markers dictionary to track connected friends
const markers = {};
let myMarker = null;

// Function to start Geolocation Tracking after joining
function initTracking() {
    if ("geolocation" in navigator) {
        navigator.geolocation.watchPosition((position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            const weatherText = "28°C";

            // Update or create own marker
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

            // Broadcast location to server
            socket.emit('updateLocation', {
                lat: lat,
                lng: lng,
                avatar: myAvatar,
                weather: weatherText
            });
        }, (error) => {
            console.error("Geolocation error:", error);
        }, {
            enableHighAccuracy: true,
            maximumAge: 10000,
            timeout: 5000
        });
    }
}

// Handle Join Map Form submission
document.getElementById('join-map-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    myName = document.getElementById('username')?.value || "Explorer";
    
    // Hide login modal
    const modal = document.getElementById('login-modal');
    if (modal) modal.style.display = 'none';

    // Start geolocation and tracking after joining
    initTracking();
});

// 2. Listen for Friends Moving
socket.on('friendMoved', (data) => {
    if (markers[data.id]) {
        markers[data.id].setLatLng([data.lat, data.lng]);
    } else {
        const friendIcon = L.divIcon({
            className: 'custom-avatar-icon',
            html: `<div style="background-image: url('${data.avatar || 'friend1.png'}'); width: 40px; height: 40px; background-size: cover; border-radius: 50%; border: 2px solid #00a884; box-shadow: 0 0 5px rgba(0,0,0,0.5);"></div>`,
            iconSize: [40, 40],
            iconAnchor: [20, 20]
        });
        markers[data.id] = L.marker([data.lat, data.lng], { icon: friendIcon }).addTo(map);
        markers[data.id].bindPopup(`<b>Friend</b><br>Weather: ${data.weather || 'N/A'}`);
    }
});

// 3. Handle Friend Disconnection
socket.on('friendDisconnected', (id) => {
    if (markers[id]) {
        map.removeLayer(markers[id]);
        delete markers[id];
    }
});

// 4. Load Existing Saved Memory Photos on Page Load
socket.on('loadMemoryPhotos', (photos) => {
    photos.forEach((data) => {
        const memoryIcon = L.divIcon({
            className: 'memory-pin-icon',
            html: `<div style="width: 42px; height: 42px; border-radius: 50%; border: 3px solid #00a884; overflow: hidden; background: #fff; box-shadow: 0 3px 8px rgba(0,0,0,0.4);">
                    <img src="${data.image}" style="width: 100%; height: 100%; object-fit: cover;">
                   </div>`,
            iconSize: [42, 42],
            iconAnchor: [21, 21]
        });

        const popupContent = `
            <div style="text-align: center; color: #111; font-family: sans-serif; padding: 2px;">
                <img src="${data.image}" style="width: 220px; border-radius: 8px; margin-bottom: 6px; object-fit: cover;">
                <p style="margin: 4px 0; font-weight: bold; font-size: 13px;">📸 Captured by: ${data.name}</p>
                <p style="margin: 0; font-size: 11px; color: #555;">🕒 ${data.time}</p>
            </div>
        `;
        L.marker([data.lat, data.lng], { icon: memoryIcon }).addTo(map).bindPopup(popupContent);
    });
});

// 5. Listen for New Memory Pins Broadcasted by Server
socket.on('newMemoryPin', (data) => {
    const memoryIcon = L.divIcon({
        className: 'memory-pin-icon',
        html: `<div style="width: 42px; height: 42px; border-radius: 50%; border: 3px solid #00a884; overflow: hidden; background: #fff; box-shadow: 0 3px 8px rgba(0,0,0,0.4);">
                <img src="${data.image}" style="width: 100%; height: 100%; object-fit: cover;">
               </div>`,
            iconSize: [42, 42],
            iconAnchor: [21, 21]
    });

    const popupContent = `
        <div style="text-align: center; color: #111; font-family: sans-serif; padding: 2px;">
            <img src="${data.image}" style="width: 220px; border-radius: 8px; margin-bottom: 6px; object-fit: cover;">
            <p style="margin: 4px 0; font-weight: bold; font-size: 13px;">📸 Captured by: ${data.name}</p>
            <p style="margin: 0; font-size: 11px; color: #555;">🕒 ${data.time}</p>
        </div>
    `;
    L.marker([data.lat, data.lng], { icon: memoryIcon }).addTo(map).bindPopup(popupContent);
});

// 6. Interactive Click-to-Place Memory Upload Listener
const mapFileInput = document.getElementById('map-file-input');

if (mapFileInput) {
    mapFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const imageData = event.target.result;
            const photoTime = new Date().toLocaleString();

            alert("📸 Now click anywhere on the map where you want to place this memory photo!");

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
}
