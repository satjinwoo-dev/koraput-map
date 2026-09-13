// ==========================================
// KORAPUT MAP - MAIN JAVASCRIPT
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
// SATELLITE MAP
// ==========================================

L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
        attribution: "Tiles &copy; Esri"
    }
).addTo(map);

// ==========================================
// LOAD SAVED USER DATA
// ==========================================

window.addEventListener("DOMContentLoaded", () => {
    const savedName = localStorage.getItem("koraput_name");
    const savedAvatar = localStorage.getItem("koraput_avatar");

    if (savedName) {
        myName = savedName;
    }

    if (savedAvatar) {
        myAvatarData = savedAvatar;
    }

    // If previous user data exists, open map automatically
    if (savedName && savedAvatar) {
        launchApp();
    }
});

// ==========================================
// JOIN MAP BUTTON
// ==========================================

document.addEventListener("click", (e) => {

    const target = e.target;

    if (
        target &&
        (
            target.id === "joinBtn" ||
            target.innerText?.trim() === "Join Map"
        )
    ) {

        e.preventDefault();

        // ------------------------------
        // Get name
        // ------------------------------

        const nameInput = document.querySelector(
            'input[type="text"]'
        );

        if (nameInput && nameInput.value.trim() !== "") {
            myName = nameInput.value.trim();
        }

        // ------------------------------
        // Get profile picture
        // ------------------------------

        const fileInput = document.querySelector(
            'input[type="file"]'
        );

        const file = fileInput?.files?.[0];

        // If user selected a picture
        if (file) {

            const reader = new FileReader();

            reader.onload = (event) => {

                myAvatarData = event.target.result;

                saveAndLaunch();
            };

            reader.onerror = () => {
                console.error("Unable to read profile picture.");
                saveAndLaunch();
            };

            reader.readAsDataURL(file);

        } else {

            // No picture selected
            saveAndLaunch();
        }
    }
});

// ==========================================
// SAVE USER DATA
// ==========================================

function saveAndLaunch() {

    localStorage.setItem(
        "koraput_name",
        myName
    );

    localStorage.setItem(
        "koraput_avatar",
        myAvatarData
    );

    launchApp();
}

// ==========================================
// START APPLICATION
// ==========================================

function launchApp() {

    // ------------------------------
    // Hide Join Screen
    // ------------------------------

    const joinScreen = document.getElementById(
        "join-screen"
    );

    if (joinScreen) {
        joinScreen.style.display = "none";
    }

    // ------------------------------
    // Show Chat Button
    // ------------------------------

    const chatToggle = document.getElementById(
        "chat-toggle-btn"
    );

    if (chatToggle) {
        chatToggle.style.display = "flex";
    }

    // ------------------------------
    // Fix Leaflet map size
    // ------------------------------

    setTimeout(() => {
        map.invalidateSize();
    }, 300);

    // ------------------------------
    // Start location tracking
    // ------------------------------

    startLocationTracking();
}

// ==========================================
// GEOLOCATION TRACKING
// ==========================================

function startLocationTracking() {

    if (!navigator.geolocation) {

        console.error(
            "Geolocation is not supported by this browser."
        );

        return;
    }

    navigator.geolocation.watchPosition(

        (position) => {

            const latitude = position.coords.latitude;
            const longitude = position.coords.longitude;

            myCoords = {
                lat: latitude,
                lng: longitude
            };

            // ------------------------------
            // Send location to server
            // ------------------------------

            socket.emit("updateLocation", {

                lat: latitude,

                lng: longitude,

                avatar: myAvatarData,

                name: myName,

                weather: myWeatherInfo
            });

            // ------------------------------
            // Update own marker
            // ------------------------------

            updateMyMarker(
                latitude,
                longitude
            );

        },

        (error) => {

            console.error(
                "Location error:",
                error.message
            );

        },

        {
            enableHighAccuracy: true,

            maximumAge: 5000,

            timeout: 15000
        }
    );
}

// ==========================================
// CREATE / UPDATE OWN MARKER
// ==========================================

function updateMyMarker(latitude, longitude) {

    if (myMarker) {

        myMarker.setLatLng([
            latitude,
            longitude
        ]);

    } else {

        myMarker = L.marker(
            [
                latitude,
                longitude
            ],
            {
                icon: createAvatarIcon(
                    myAvatarData
                )
            }
        ).addTo(map);

        myMarker.bindPopup(
            `<b>${escapeHTML(myName)}</b><br>
             <small>Your location</small>`
        );
    }

    // Move map to user's location
    map.setView(
        [
            latitude,
            longitude
        ],
        16
    );
}

// ==========================================
// CREATE AVATAR ICON
// ==========================================

function createAvatarIcon(avatar) {

    return L.icon({

        iconUrl: avatar,

        iconSize: [
            45,
            45
        ],

        iconAnchor: [
            22,
            22
        ],

        popupAnchor: [
            0,
            -22
        ],

        className: "avatar-icon"
    });
}

// ==========================================
// MEMORY PHOTO INPUT
// ==========================================

const mapFileInput = document.getElementById(
    "map-file-input"
);

if (mapFileInput) {

    mapFileInput.addEventListener(
        "change",
        (event) => {

            const file = event.target.files?.[0];

            if (!file) {
                return;
            }

            // Make sure it is an image
            if (!file.type.startsWith("image/")) {

                alert(
                    "Please select an image file."
                );

                mapFileInput.value = "";

                return;
            }

            const reader = new FileReader();

            reader.onload = (ev) => {

                const imageData = ev.target.result;

                alert(
                    "📸 Click anywhere on the map to pin your memory photo!"
                );

                // Wait for the next map click
                map.once(
                    "click",
                    (mapEvent) => {

                        const memory = {

                            name: myName,

                            lat: mapEvent.latlng.lat,

                            lng: mapEvent.latlng.lng,

                            image: imageData,

                            time: new Date().toLocaleString()
                        };

                        // Send to server
                        socket.emit(
                            "uploadMemoryPhoto",
                            memory
                        );

                        // Reset file input
                        mapFileInput.value = "";
                    }
                );
            };

            reader.onerror = () => {

                alert(
                    "Unable to read the selected image."
                );

                mapFileInput.value = "";
            };

            reader.readAsDataURL(file);
        }
    );
}

// ==========================================
// RENDER MEMORY PHOTO
// ==========================================

function renderMemoryPhoto(memory) {

    if (
        !memory ||
        typeof memory.lat !== "number" ||
        typeof memory.lng !== "number" ||
        !memory.image
    ) {
        console.error(
            "Invalid memory photo:",
            memory
        );

        return;
    }

    const memoryIcon = L.divIcon({

        className: "memory-pin-icon",

        html: `
            <div
                style="
                    width:42px;
                    height:42px;
                    border-radius:50%;
                    border:3px solid #00a884;
                    overflow:hidden;
                    background:#ffffff;
                    box-shadow:0 2px 8px rgba(0,0,0,0.4);
                "
            >
                <img
                    src="${memory.image}"
                    alt="Memory"
                    style="
                        width:100%;
                        height:100%;
                        object-fit:cover;
                    "
                >
            </div>
        `,

        iconSize: [
            42,
            42
        ],

        iconAnchor: [
            21,
            21
        ]
    });

    const marker = L.marker(
        [
            memory.lat,
            memory.lng
        ],
        {
            icon: memoryIcon
        }
    ).addTo(map);

    const safeName = escapeHTML(
        memory.name || "Someone"
    );

    const safeTime = escapeHTML(
        memory.time || ""
    );

    marker.bindPopup(`
        <div style="text-align:center;">

            <b>📸 ${safeName}</b>

            <br>

            <small>${safeTime}</small>

            <br><br>

            <img
                src="${memory.image}"
                alt="Memory photo"
                style="
                    width:200px;
                    max-width:100%;
                    border-radius:8px;
                "
            >

        </div>
    `);
}

// ==========================================
// NEW MEMORY PHOTO FROM SERVER
// ==========================================

socket.on(
    "newMemoryPin",
    (memory) => {

        renderMemoryPhoto(memory);
    }
);

// ==========================================
// LOAD OLD MEMORY PHOTOS
// ==========================================

socket.on(
    "loadMemoryPhotos",
    (photos) => {

        if (!Array.isArray(photos)) {

            console.error(
                "Invalid memory photo list:",
                photos
            );

            return;
        }

        photos.forEach(
            (photo) => {

                renderMemoryPhoto(photo);

            }
        );
    }
);

// ==========================================
// ESCAPE HTML
// Prevents names from injecting HTML
// ==========================================

function escapeHTML(value) {

    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ==========================================
// SOCKET CONNECTION EVENTS
// ==========================================

socket.on(
    "connect",
    () => {

        console.log(
            "Connected to server:",
            socket.id
        );
    }
);

socket.on(
    "disconnect",
    () => {

        console.log(
            "Disconnected from server."
        );
    }
);

socket.on(
    "connect_error",
    (error) => {

        console.error(
            "Socket connection error:",
            error.message
        );
    }
);
