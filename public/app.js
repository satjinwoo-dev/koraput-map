// ==========================================
// KORAPUT MAP
// NORMAL GOOGLE MAPS VERSION
// GOOGLE 3D EARTH REMOVED
// ==========================================

const socket = io();


// ==========================================
// GLOBAL VARIABLES
// ==========================================

let map = null;

let myMarker = null;

let myName = "User";

let myAvatarData = "friend1.png";

let myCoords = null;

let myWeatherInfo = "";

let firstLocationFix = true;

let trackingStarted = false;

const friendMarkers = {};

const memoryMarkers = {};

const users = {};

const messageStore = new Map();

let unreadCount = 0;

let chatOpen = false;

let currentReply = null;

let typingTimer = null;

let isRecording = false;

let mediaRecorder = null;

let audioChunks = [];

let lastWeatherUpdate = 0;

const WEATHER_INTERVAL =
    10 * 60 * 1000;


// ==========================================
// GOOGLE MAP INITIALIZATION
// ==========================================

function initMap() {

    map = new google.maps.Map(
        document.getElementById("map"),
        {
            center: {
                lat: 18.8136,
                lng: 82.7153
            },

            zoom: 13,

            mapTypeId: "satellite",

            tilt: 0,

            streetViewControl: false,

            fullscreenControl: false,

            mapTypeControl: false,

            clickableIcons: true,

            gestureHandling: "greedy"
        }
    );


    map.addListener(
        "click",
        handleMapClick
    );


    setupMapControls();

    loadSavedProfile();

    setupJoinScreen();

    setupChat();

    setupMemoryUpload();

    startLocationTracking();
}


// ==========================================
// MAP CONTROLS
// ==========================================

function setupMapControls() {

    const locationButton =
        document.getElementById(
            "my-location-btn"
        );

    locationButton.addEventListener(
        "click",
        () => {

            if (!myCoords) {

                startLocationTracking();

                return;
            }

            map.panTo({
                lat: myCoords.lat,
                lng: myCoords.lng
            });

            map.setZoom(16);
        }
    );


    const styleButton =
        document.getElementById(
            "map-style-btn"
        );

    const styleMenu =
        document.getElementById(
            "map-style-menu"
        );

    styleButton.addEventListener(
        "click",
        (event) => {

            event.stopPropagation();

            styleMenu.classList.toggle(
                "show"
            );
        }
    );


    document
        .querySelectorAll(
            "#map-style-menu button"
        )
        .forEach(button => {

            button.addEventListener(
                "click",
                () => {

                    const style =
                        button.dataset.style;

                    changeMapStyle(style);

                    document
                        .querySelectorAll(
                            "#map-style-menu button"
                        )
                        .forEach(
                            b =>
                                b.classList.remove(
                                    "active"
                                )
                        );

                    button.classList.add(
                        "active"
                    );

                    styleMenu.classList.remove(
                        "show"
                    );
                }
            );
        });


    document.addEventListener(
        "click",
        () => {
            styleMenu.classList.remove(
                "show"
            );
        }
    );
}


// ==========================================
// MAP STYLES
// ==========================================

function changeMapStyle(style) {

    if (!map) return;


    if (style === "satellite") {

        map.setMapTypeId(
            "satellite"
        );

        map.setOptions({
            styles: null
        });

        return;
    }


    if (style === "street") {

        map.setMapTypeId(
            "roadmap"
        );

        map.setOptions({
            styles: null
        });

        return;
    }


    if (style === "hybrid") {

        map.setMapTypeId(
            "hybrid"
        );

        map.setOptions({
            styles: null
        });

        return;
    }


    if (style === "terrain") {

        map.setMapTypeId(
            "terrain"
        );

        map.setOptions({
            styles: null
        });

        return;
    }


    if (style === "dark") {

        map.setMapTypeId(
            "roadmap"
        );

        map.setOptions({

            styles: [

                {
                    elementType: "geometry",
                    stylers: [
                        {
                            color: "#242f3e"
                        }
                    ]
                },

                {
                    elementType: "labels.text.fill",
                    stylers: [
                        {
                            color: "#746855"
                        }
                    ]
                },

                {
                    elementType: "labels.text.stroke",
                    stylers: [
                        {
                            color: "#242f3e"
                        }
                    ]
                },

                {
                    featureType: "water",
                    elementType: "geometry",
                    stylers: [
                        {
                            color: "#17263c"
                        }
                    ]
                }

            ]
        });
    }
}


// ==========================================
// SAFE HTML
// ==========================================

function escapeHTML(value) {

    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}


// ==========================================
// SAFE IMAGE
// ==========================================

function safeImage(value) {

    if (
        typeof value !== "string"
    ) {
        return "friend1.png";
    }

    if (
        value.startsWith("data:image/")
    ) {
        return value;
    }

    if (
        /^https?:\/\//i.test(value)
    ) {
        return value;
    }

    if (
        /^[a-zA-Z0-9._/-]+$/.test(value)
    ) {
        return value;
    }

    return "friend1.png";
}


// ==========================================
// PROFILE STORAGE
// ==========================================

function loadSavedProfile() {

    const savedName =
        localStorage.getItem(
            "koraput_name"
        );

    const savedAvatar =
        localStorage.getItem(
            "koraput_avatar"
        );


    if (savedName) {
        myName = savedName;
    }

    if (savedAvatar) {
        myAvatarData = savedAvatar;
    }


    if (
        savedName &&
        savedAvatar
    ) {

        document.getElementById(
            "join-screen"
        ).style.display = "none";

        sendProfile();

    } else {

        document.getElementById(
            "join-screen"
        ).style.display = "flex";
    }
}


// ==========================================
// JOIN SCREEN
// ==========================================

function setupJoinScreen() {

    const joinButton =
        document.getElementById(
            "joinButton"
        );

    const nameInput =
        document.getElementById(
            "nameInput"
        );

    const avatarInput =
        document.getElementById(
            "avatarInput"
        );


    nameInput.value = myName !== "User"
        ? myName
        : "";


    joinButton.addEventListener(
        "click",
        async () => {

            const name =
                nameInput.value
                    .trim()
                    .replace(/\s+/g, " ");


            if (!name) {

                alert(
                    "Please enter your name."
                );

                return;
            }


            myName =
                name.slice(0, 40);


            if (
                avatarInput.files &&
                avatarInput.files[0]
            ) {

                myAvatarData =
                    await fileToDataURL(
                        avatarInput.files[0]
                    );
            }


            localStorage.setItem(
                "koraput_name",
                myName
            );

            localStorage.setItem(
                "koraput_avatar",
                myAvatarData
            );


            document.getElementById(
                "join-screen"
            ).style.display = "none";


            sendProfile();


            if (!trackingStarted) {
                startLocationTracking();
            }
        }
    );
}


// ==========================================
// SEND PROFILE
// ==========================================

function sendProfile() {

    socket.emit(
        "profileReady",
        {
            name: myName,
            avatar: myAvatarData
        }
    );
}


// ==========================================
// LOCATION TRACKING
// ==========================================

function startLocationTracking() {

    if (trackingStarted) {
        return;
    }

    if (!navigator.geolocation) {

        console.warn(
            "Geolocation not supported."
        );

        return;
    }


    trackingStarted = true;


    navigator.geolocation.watchPosition(
        position => {

            const lat =
                position.coords.latitude;

            const lng =
                position.coords.longitude;


            myCoords = {
                lat,
                lng
            };


            updateMyMarker(
                lat,
                lng
            );


            socket.emit(
                "updateLocation",
                {
                    lat,
                    lng,

                    name: myName,

                    avatar: myAvatarData,

                    weather: myWeatherInfo
                }
            );


            updateWeather(
                lat,
                lng
            );


            if (firstLocationFix) {

                firstLocationFix = false;

                map.panTo({
                    lat,
                    lng
                });

                map.setZoom(16);
            }

        },

        error => {

            console.warn(
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
// OWN MARKER
// ==========================================

function updateMyMarker(lat, lng) {

    const position = {
        lat,
        lng
    };


    if (!myMarker) {

        myMarker =
            new google.maps.Marker({

                position,

                map,

                title:
                    `${myName} • You`,

                icon: {

                    url: safeImage(
                        myAvatarData
                    ),

                    scaledSize:
                        new google.maps.Size(
                            44,
                            44
                        ),

                    anchor:
                        new google.maps.Point(
                            22,
                            22
                        )
                },

                zIndex: 1000
            });


        myMarker.addListener(
            "click",
            () => {

                showProfilePopup(
                    myMarker,
                    {
                        id: "me",
                        name: myName,
                        avatar:
                            myAvatarData,
                        online: true,
                        weather:
                            myWeatherInfo,
                        isMe: true
                    }
                );
            }
        );

    } else {

        myMarker.setPosition(
            position
        );

        myMarker.setIcon({

            url: safeImage(
                myAvatarData
            ),

            scaledSize:
                new google.maps.Size(
                    44,
                    44
                ),

            anchor:
                new google.maps.Point(
                    22,
                    22
                )
        });
    }
}


// ==========================================
// FRIEND MARKER
// ==========================================

function updateFriendMarker(user) {

    if (!user || !user.id) {
        return;
    }

    if (
        user.lat === null ||
        user.lng === null ||
        user.lat === undefined ||
        user.lng === undefined
    ) {
        return;
    }


    users[user.id] = user;


    const position = {
        lat: Number(user.lat),
        lng: Number(user.lng)
    };


    if (!friendMarkers[user.id]) {

        const marker =
            new google.maps.Marker({

                position,

                map,

                title:
                    user.name || "Friend",

                icon: {

                    url: safeImage(
                        user.avatar
                    ),

                    scaledSize:
                        new google.maps.Size(
                            40,
                            40
                        ),

                    anchor:
                        new google.maps.Point(
                            20,
                            20
                        )
                },

                zIndex: 500
            });


        marker.addListener(
            "click",
            () => {

                showProfilePopup(
                    marker,
                    users[user.id]
                );
            }
        );


        friendMarkers[user.id] =
            marker;

    } else {

        friendMarkers[user.id]
            .setPosition(position);

        friendMarkers[user.id]
            .setIcon({

                url: safeImage(
                    user.avatar
                ),

                scaledSize:
                    new google.maps.Size(
                        40,
                        40
                    ),

                anchor:
                    new google.maps.Point(
                        20,
                        20
                    )
            });
    }
}


// ==========================================
// PROFILE POPUP
// ==========================================

let infoWindow = null;

function showProfilePopup(
    marker,
    user
) {

    if (!user) return;


    if (!infoWindow) {

        infoWindow =
            new google.maps.InfoWindow();
    }


    const status =
        user.isMe
            ? "🟢 You"
            : user.online
                ? "🟢 Online"
                : "⚫ Offline";


    const weather =
        user.weather ||
        "Weather unavailable";


    const html = `

        <div class="profile-card">

            <img
                src="${safeImage(user.avatar)}"
                alt="Profile"
            >

            <div class="profile-name">
                ${escapeHTML(user.name)}
            </div>

            <div class="profile-status">
                ${status}
            </div>

            <div class="profile-weather">
                ${escapeHTML(weather)}
            </div>

        </div>

    `;


    infoWindow.setContent(html);

    infoWindow.open({
        map,
        anchor: marker
    });
}


// ==========================================
// WEATHER
// ==========================================

function weatherEmoji(
    code,
    isDay
) {

    if (code === 0) {
        return isDay
            ? "☀️"
            : "🌙";
    }

    if (code >= 1 && code <= 3) {
        return isDay
            ? "⛅"
            : "☁️";
    }

    if (code >= 45 && code <= 48) {
        return "🌫️";
    }

    if (code >= 51 && code <= 67) {
        return "🌧️";
    }

    if (code >= 71 && code <= 77) {
        return "❄️";
    }

    if (code >= 80 && code <= 82) {
        return "🌦️";
    }

    if (code >= 95) {
        return "⛈️";
    }

    return "🌡️";
}


async function updateWeather(
    lat,
    lng
) {

    const now = Date.now();


    if (
        now - lastWeatherUpdate <
        WEATHER_INTERVAL
    ) {
        return;
    }


    lastWeatherUpdate = now;


    try {

        const response =
            await fetch(
                `https://api.open-meteo.com/v1/forecast` +
                `?latitude=${encodeURIComponent(lat)}` +
                `&longitude=${encodeURIComponent(lng)}` +
                `&current_weather=true`
            );


        if (!response.ok) {
            throw new Error(
                "Weather request failed"
            );
        }


        const data =
            await response.json();


        const weather =
            data.current_weather;


        if (!weather) {
            return;
        }


        const temperature =
            Math.round(
                Number(
                    weather.temperature
                )
            );


        const emoji =
            weatherEmoji(
                Number(weather.weathercode),
                Number(weather.is_day) === 1
            );


        myWeatherInfo =
            `${emoji} ${temperature}°C`;


        document.getElementById(
            "temperature-pill"
        ).textContent =
            myWeatherInfo;


        socket.emit(
            "updateLocation",
            {
                lat,
                lng,
                name: myName,
                avatar: myAvatarData,
                weather: myWeatherInfo
            }
        );

    } catch (error) {

        console.warn(
            "Weather failed:",
            error
        );
    }
}


// ==========================================
// MAP CLICK
// ==========================================

function handleMapClick(event) {

    if (!event.latLng) {
        return;
    }

    // Don't automatically upload.
    // Memory button controls uploads.
}


// ==========================================
// MEMORY PHOTO
// ==========================================

function setupMemoryUpload() {

    const button =
        document.getElementById(
            "memoryButton"
        );

    const input =
        document.getElementById(
            "memoryPhotoInput"
        );


    button.addEventListener(
        "click",
        () => {

            if (!myCoords) {

                alert(
                    "Wait for your live location first."
                );

                return;
            }

            input.click();
        }
    );


    input.addEventListener(
        "change",
        async () => {

            const file =
                input.files?.[0];

            if (!file) {
                return;
            }


            if (
                !file.type.startsWith(
                    "image/"
                )
            ) {

                alert(
                    "Please choose an image."
                );

                return;
            }


            if (
                file.size >
                5 * 1024 * 1024
            ) {

                alert(
                    "Image must be smaller than 5 MB."
                );

                input.value = "";

                return;
            }


            try {

                const image =
                    await fileToDataURL(
                        file
                    );


                socket.emit(
                    "uploadMemoryPhoto",
                    {
                        name: myName,

                        lat: myCoords.lat,

                        lng: myCoords.lng,

                        image,

                        time:
                            new Date()
                                .toLocaleString()
                    }
                );

            } catch (error) {

                console.error(error);

                alert(
                    "Could not upload image."
                );
            }


            input.value = "";
        }
    );
}


function addMemoryMarker(pin) {

    if (!pin) return;


    const marker =
        new google.maps.Marker({

            position: {
                lat: Number(pin.lat),
                lng: Number(pin.lng)
            },

            map,

            title:
                `Memory • ${pin.name}`,

            icon: {

                url: pin.image,

                scaledSize:
                    new google.maps.Size(
                        48,
                        48
                    ),

                anchor:
                    new google.maps.Point(
                        24,
                        24
                    )
            },

            zIndex: 300
        });


    const popup =
        new google.maps.InfoWindow({

            content: `

                <div
                    style="
                        width:220px;
                        color:#111;
                    "
                >

                    <img
                        src="${safeImage(pin.image)}"
                        style="
                            width:100%;
                            border-radius:10px;
                            display:block;
                        "
                    >

                    <strong>
                        📸 ${escapeHTML(pin.name)}
                    </strong>

                    <br>

                    <small>
                        ${escapeHTML(pin.time)}
                    </small>

                </div>

            `
        });


    marker.addListener(
        "click",
        () => {

            popup.open({
                map,
                anchor: marker
            });
        }
    );


    memoryMarkers[pin.id] =
        marker;
}


// ==========================================
// FILE → DATA URL
// ==========================================

function fileToDataURL(file) {

    return new Promise(
        (resolve, reject) => {

            const reader =
                new FileReader();


            reader.onload = () =>
                resolve(
                    reader.result
                );


            reader.onerror =
                reject;


            reader.readAsDataURL(
                file
            );
        }
    );
}


// ==========================================
// CHAT SETUP
// ==========================================

function setupChat() {

    const chat =
        document.getElementById(
            "chat-container"
        );

    const toggle =
        document.getElementById(
            "chat-toggle-btn"
        );

    const minimize =
        document.getElementById(
            "chat-minimize-btn"
        );


    toggle.addEventListener(
        "click",
        () => {

            chatOpen =
                !chatOpen;

            chat.classList.toggle(
                "open",
                chatOpen
            );


            if (chatOpen) {

                unreadCount = 0;

                updateUnreadCounter();

                scrollChatToBottom();
            }
        }
    );


    minimize.addEventListener(
        "click",
        () => {

            chatOpen = false;

            chat.classList.remove(
                "open"
            );
        }
    );


    setupChatInput();

    setupAttachments();

    setupEmojiPicker();

    setupVoiceRecorder();
}


// ==========================================
// CHAT INPUT
// ==========================================

function setupChatInput() {

    const form =
        document.getElementById(
            "chatForm"
        );

    const input =
        document.getElementById(
            "chatInput"
        );


    input.addEventListener(
        "input",
        () => {

            socket.emit(
                "typing",
                input.value.length > 0
            );


            clearTimeout(
                typingTimer
            );


            typingTimer =
                setTimeout(
                    () => {

                        socket.emit(
                            "typing",
                            false
                        );

                    },
                    900
                );
        }
    );


    form.addEventListener(
        "submit",
        event => {

            event.preventDefault();


            const text =
                input.value.trim();


            if (!text) {
                return;
            }


            sendChatMessage(
                "text",
                text
            );


            input.value = "";

            socket.emit(
                "typing",
                false
            );
        }
    );
}


// ==========================================
// SEND MESSAGE
// ==========================================

function sendChatMessage(
    type,
    data
) {

    const message = {

        type,

        data,

        name: myName,

        replyTo:
            currentReply
                ? {
                    id:
                        currentReply.id,

                    name:
                        currentReply.name,

                    type:
                        currentReply.type,

                    preview:
                        currentReply.preview
                }
                : null
    };


    socket.emit(
        "chatMessage",
        message
    );


    clearReply();
}


// ==========================================
// ATTACHMENTS
// ==========================================

function setupAttachments() {

    const button =
        document.getElementById(
            "chat-attach-btn"
        );

    const menu =
        document.getElementById(
            "attachment-menu"
        );


    button.addEventListener(
        "click",
        event => {

            event.stopPropagation();

            menu.classList.toggle(
                "show"
            );
        }
    );


    document.addEventListener(
        "click",
        () => {

            menu.classList.remove(
                "show"
            );
        }
    );


    const attachment =
        document.getElementById(
            "chatAttachment"
        );


    document.getElementById(
        "att-media"
    ).addEventListener(
        "click",
        () => {

            attachment.accept =
                "image/*,video/*";

            attachment.click();

            menu.classList.remove(
                "show"
            );
        }
    );


    document.getElementById(
        "att-doc"
    ).addEventListener(
        "click",
        () => {

            attachment.accept =
                ".pdf,.doc,.docx,.txt,.zip";

            attachment.click();

            menu.classList.remove(
                "show"
            );
        }
    );


    document.getElementById(
        "att-audio"
    ).addEventListener(
        "click",
        () => {

            attachment.accept =
                "audio/*";

            attachment.click();

            menu.classList.remove(
                "show"
            );
        }
    );


    document.getElementById(
        "att-cam"
    ).addEventListener(
        "click",
        () => {

            document.getElementById(
                "chat-camera-file"
            ).click();

            menu.classList.remove(
                "show"
            );
        }
    );


    attachment.addEventListener(
        "change",
        () => {

            handleAttachment(
                attachment
            );
        }
    );


    document
        .getElementById(
            "chat-camera-file"
        )
        .addEventListener(
            "change",
            event => {

                handleAttachment(
                    event.target
                );
            }
        );
}


async function handleAttachment(
    input
) {

    const file =
        input.files?.[0];

    if (!file) {
        return;
    }


    if (
        file.size >
        7 * 1024 * 1024
    ) {

        alert(
            "File must be smaller than 7 MB."
        );

        input.value = "";

        return;
    }


    try {

        const data =
            await fileToDataURL(
                file
            );


        let type = "document";


        if (
            file.type.startsWith(
                "image/"
            )
        ) {

            type = "image";

        } else if (
            file.type.startsWith(
                "video/"
            )
        ) {

            type = "video";

        } else if (
            file.type.startsWith(
                "audio/"
            )
        ) {

            type = "audio";
        }


        sendChatMessage(
            type,
            data
        );

    } catch (error) {

        console.error(error);

        alert(
            "Could not read the file."
        );
    }


    input.value = "";
}


// ==========================================
// EMOJI PICKER
// ==========================================

function setupEmojiPicker() {

    const button =
        document.getElementById(
            "emojiButton"
        );

    const container =
        document.getElementById(
            "emoji-picker-container"
        );

    const picker =
        document.getElementById(
            "emojiPicker"
        );


    const emojis = [
        "😀","😂","🤣","😊",
        "😍","🥰","😘","😎",
        "🤔","😮","😢","😭",
        "😡","👍","👎","👏",
        "🙏","❤️","🔥","🎉",
        "💯","✨","🚀","🌍",
        "📍","📸","😂","😴",
        "🤝","💙","💚","⭐"
    ];


    emojis.forEach(
        emoji => {

            const item =
                document.createElement(
                    "button"
                );

            item.type = "button";

            item.textContent =
                emoji;


            item.addEventListener(
                "click",
                () => {

                    const input =
                        document.getElementById(
                            "chatInput"
                        );

                    input.value += emoji;

                    input.focus();
                }
            );


            picker.appendChild(
                item
            );
        }
    );


    button.addEventListener(
        "click",
        event => {

            event.stopPropagation();

            container.classList.toggle(
                "show"
            );
        }
    );


    document.addEventListener(
        "click",
        () => {

            container.classList.remove(
                "show"
            );
        }
    );
}


// ==========================================
// VOICE RECORDER
// ==========================================

function setupVoiceRecorder() {

    const button =
        document.getElementById(
            "voiceButton"
        );


    button.addEventListener(
        "click",
        async () => {

            if (isRecording) {

                stopRecording();

                return;
            }


            try {

                const stream =
                    await navigator
                        .mediaDevices
                        .getUserMedia({
                            audio: true
                        });


                audioChunks = [];


                mediaRecorder =
                    new MediaRecorder(
                        stream
                    );


                mediaRecorder.ondataavailable =
                    event => {

                        if (
                            event.data.size >
                            0
                        ) {

                            audioChunks.push(
                                event.data
                            );
                        }
                    };


                mediaRecorder.onstop =
                    async () => {

                        const blob =
                            new Blob(
                                audioChunks,
                                {
                                    type:
                                        "audio/webm"
                                }
                            );


                        const reader =
                            new FileReader();


                        reader.onload =
                            () => {

                                sendChatMessage(
                                    "audio",
                                    reader.result
                                );
                            };


                        reader.readAsDataURL(
                            blob
                        );


                        stream
                            .getTracks()
                            .forEach(
                                track =>
                                    track.stop()
                            );
                    };


                mediaRecorder.start();

                isRecording = true;

                button.textContent =
                    "⏹️";

            } catch (error) {

                console.error(error);

                alert(
                    "Microphone permission is required."
                );
            }
        }
    );
}


function stopRecording() {

    if (
        mediaRecorder &&
        isRecording
    ) {

        mediaRecorder.stop();

        isRecording = false;

        document.getElementById(
            "voiceButton"
        ).textContent = "🎤";
    }
}


// ==========================================
// MESSAGE RENDERING
// ==========================================

function renderMessage(message) {

    if (!message?.id) {
        return;
    }


    messageStore.set(
        message.id,
        message
    );


    const container =
        document.getElementById(
            "chat-messages"
        );


    const row =
        document.createElement(
            "div"
        );


    row.className =
        "message-row" +
        (
            message.senderId ===
            socket.id
                ? " mine"
                : ""
        );


    const bubble =
        document.createElement(
            "div"
        );


    bubble.className =
        "message" +
        (
            message.senderId ===
            socket.id
                ? " mine"
                : ""
        );


    // NAME

    if (
        message.senderId !==
        socket.id
    ) {

        const name =
            document.createElement(
                "div"
            );

        name.className =
            "message-name";

        name.textContent =
            message.name ||
            "User";

        bubble.appendChild(
            name
        );
    }


    // REPLY

    if (message.replyTo) {

        const reply =
            document.createElement(
                "div"
            );

        reply.className =
            "reply-preview";

        reply.textContent =
            `↩ ${message.replyTo.name}: ${message.replyTo.preview}`;

        bubble.appendChild(
            reply
        );
    }


    // CONTENT

    const content =
        createMessageContent(
            message
        );

    bubble.appendChild(
        content
    );


    // TIME

    const time =
        document.createElement(
            "div"
        );

    time.className =
        "message-time";

    time.textContent =
        formatTime(
            message.time
        );

    bubble.appendChild(
        time
    );


    // ACTIONS

    const actions =
        document.createElement(
            "div"
        );

    actions.className =
        "message-actions";


    const replyButton =
        document.createElement(
            "button"
        );

    replyButton.type = "button";

    replyButton.textContent =
        "↩";

    replyButton.title =
        "Reply";


    replyButton.addEventListener(
        "click",
        () => {

            setReply(
                message
            );
        }
    );


    actions.appendChild(
        replyButton
    );


    const reactionButton =
        document.createElement(
            "button"
        );

    reactionButton.type =
        "button";

    reactionButton.textContent =
        "❤️";

    reactionButton.title =
        "React";


    reactionButton.addEventListener(
        "click",
        () => {

            socket.emit(
                "messageReaction",
                {
                    messageId:
                        message.id,

                    emoji:
                        "❤️"
                }
            );
        }
    );


    actions.appendChild(
        reactionButton
    );


    bubble.appendChild(
        actions
    );


    // REACTIONS

    const reactions =
        document.createElement(
            "div"
        );

    reactions.className =
        "reactions";

    reactions.id =
        `reactions-${message.id}`;


    bubble.appendChild(
        reactions
    );


    row.appendChild(
        bubble
    );

    container.appendChild(
        row
    );


    renderReactions(
        message.id,
        message.reactions || {}
    );


    if (!chatOpen) {

        if (
            message.senderId !==
            socket.id
        ) {

            unreadCount++;

            updateUnreadCounter();
        }
    }


    scrollChatToBottom();
}


// ==========================================
// MESSAGE CONTENT
// ==========================================

function createMessageContent(
    message
) {

    if (
        message.type === "text"
    ) {

        const text =
            document.createElement(
                "div"
            );

        text.textContent =
            message.data;

        return text;
    }


    if (
        message.type === "image"
    ) {

        const img =
            document.createElement(
                "img"
            );

        img.src =
            safeImage(
                message.data
            );

        img.alt =
            "Image";

        img.loading =
            "lazy";

        return img;
    }


    if (
        message.type === "video"
    ) {

        const video =
            document.createElement(
                "video"
            );

        video.src =
            message.data;

        video.controls = true;

        return video;
    }


    if (
        message.type === "audio"
    ) {

        const audio =
            document.createElement(
                "audio"
            );

        audio.src =
            message.data;

        audio.controls = true;

        return audio;
    }


    if (
        message.type === "document"
    ) {

        const link =
            document.createElement(
                "a"
            );

        link.href =
            message.data;

        link.download =
            "Koraput-file";

        link.textContent =
            "📎 Open attachment";

        link.target =
            "_blank";

        return link;
    }


    const fallback =
        document.createElement(
            "div"
        );

    fallback.textContent =
        "Unsupported message";

    return fallback;
}


// ==========================================
// REPLY
// ==========================================

function setReply(message) {

    currentReply =
        message;


    const bar =
        document.getElementById(
            "reply-bar"
        );

    const text =
        document.getElementById(
            "reply-text"
        );


    text.textContent =
        `↩ Replying to ${message.name}: ${getMessagePreview(message)}`;


    bar.style.display =
        "block";


    document.getElementById(
        "chatInput"
    ).focus();
}


function clearReply() {

    currentReply =
        null;


    document.getElementById(
        "reply-bar"
    ).style.display =
        "none";
}


document.addEventListener(
    "DOMContentLoaded",
    () => {

        document.getElementById(
            "cancel-reply"
        ).addEventListener(
            "click",
            clearReply
        );
    }
);


function getMessagePreview(
    message
) {

    if (
        message.type === "text"
    ) {
        return String(
            message.data
        ).slice(0, 100);
    }


    if (
        message.type === "image"
    ) {
        return "📷 Photo";
    }


    if (
        message.type === "video"
    ) {
        return "🎥 Video";
    }


    if (
        message.type === "audio"
    ) {
        return "🎵 Audio";
    }


    return "📎 Attachment";
}


// ==========================================
// REACTIONS
// ==========================================

function renderReactions(
    messageId,
    reactions
) {

    const container =
        document.getElementById(
            `reactions-${messageId}`
        );


    if (!container) {
        return;
    }


    container.innerHTML = "";


    Object.entries(
        reactions || {}
    ).forEach(
        ([emoji, usersList]) => {

            if (
                !usersList ||
                usersList.length === 0
            ) {
                return;
            }


            const item =
                document.createElement(
                    "span"
                );

            item.className =
                "reaction";

            item.textContent =
                `${emoji} ${usersList.length}`;


            container.appendChild(
                item
            );
        }
    );
}


// ==========================================
// UNREAD COUNTER
// ==========================================

function updateUnreadCounter() {

    const badge =
        document.getElementById(
            "unread-count"
        );


    if (
        unreadCount <= 0
    ) {

        badge.style.display =
            "none";

        badge.textContent =
            "0";

        return;
    }


    badge.style.display =
        "flex";


    badge.textContent =
        unreadCount > 99
            ? "99+"
            : String(
                unreadCount
            );
}


// ==========================================
// TYPING INDICATOR
// ==========================================

const typingUsers =
    new Map();


function updateTypingIndicator() {

    const indicator =
        document.getElementById(
            "typing-indicator"
        );


    const names =
        Array.from(
            typingUsers.values()
        );


    if (!names.length) {

        indicator.textContent =
            "";

        return;
    }


    if (names.length === 1) {

        indicator.textContent =
            `${names[0]} is typing…`;

    } else {

        indicator.textContent =
            `${names.length} people are typing…`;
    }
}


// ==========================================
// ONLINE USERS
// ==========================================

function updateOnlineUsers(
    list
) {

    if (!Array.isArray(list)) {
        return;
    }


    list.forEach(
        user => {

            users[user.id] =
                user;

            updateFriendMarker(
                user
            );
        }
    );


    const onlineBar =
        document.getElementById(
            "online-bar"
        );


    const count =
        list.length;


    onlineBar.textContent =
        `Online: ${count}`;
}


// ==========================================
// TIME
// ==========================================

function formatTime(
    value
) {

    if (!value) {
        return "";
    }


    try {

        return new Date(
            value
        ).toLocaleTimeString(
            [],
            {
                hour: "2-digit",
                minute: "2-digit"
            }
        );

    } catch {

        return "";
    }
}


// ==========================================
// SCROLL CHAT
// ==========================================

function scrollChatToBottom() {

    const container =
        document.getElementById(
            "chat-messages"
        );


    requestAnimationFrame(
        () => {

            container.scrollTop =
                container.scrollHeight;
        }
    );
}


// ==========================================
// SOCKET EVENTS
// ==========================================

socket.on(
    "profileConfirmed",
    user => {

        if (!user) return;

        users[user.id] =
            user;
    }
);


socket.on(
    "onlineUsers",
    list => {

        updateOnlineUsers(
            list
        );
    }
);


socket.on(
    "userOnline",
    user => {

        if (!user) return;

        users[user.id] =
            user;

        updateFriendMarker(
            user
        );
    }
);


socket.on(
    "friendMoved",
    user => {

        updateFriendMarker(
            user
        );
    }
);


socket.on(
    "friendDisconnected",
    id => {

        if (
            friendMarkers[id]
        ) {

            friendMarkers[id]
                .setMap(null);

            delete friendMarkers[id];
        }


        delete users[id];
    }
);


socket.on(
    "userOffline",
    data => {

        const id =
            data?.id;

        if (!id) return;


        if (
            users[id]
        ) {

            users[id].online =
                false;
        }
    }
);


socket.on(
    "typing",
    data => {

        if (!data?.id) {
            return;
        }


        if (data.isTyping) {

            typingUsers.set(
                data.id,
                data.name ||
                    "Someone"
            );

        } else {

            typingUsers.delete(
                data.id
            );
        }


        updateTypingIndicator();
    }
);


socket.on(
    "chatMessage",
    message => {

        renderMessage(
            message
        );
    }
);


socket.on(
    "messageReaction",
    data => {

        const message =
            messageStore.get(
                data.messageId
            );


        if (!message) {
            return;
        }


        message.reactions =
            data.reactions || {};


        renderReactions(
            data.messageId,
            message.reactions
        );
    }
);


socket.on(
    "loadMemoryPhotos",
    photos => {

        if (!Array.isArray(photos)) {
            return;
        }


        photos.forEach(
            pin => {

                addMemoryMarker(
                    pin
                );
            }
        );
    }
);


socket.on(
    "newMemoryPin",
    pin => {

        addMemoryMarker(
            pin
        );
    }
);


// ==========================================
// START
// ==========================================

window.addEventListener(
    "load",
    () => {

        if (
            typeof google ===
            "undefined" ||
            !google.maps
        ) {

            alert(
                "Google Maps failed to load. Check your API key."
            );

            return;
        }


        initMap();
    }
);
