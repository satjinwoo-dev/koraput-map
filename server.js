// ==========================================
// KORAPUT MAP - CLEAN SERVER
// ==========================================

const express = require("express");
const http = require("http");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = require("socket.io")(server, {
    maxHttpBufferSize: 10 * 1024 * 1024
});

app.disable("x-powered-by");

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);

// ==========================================
// MEMORY STORAGE
// ==========================================

const memoryPhotos = [];
const MAX_MEMORY_PHOTOS = 100;

// ==========================================
// CONSTANTS
// ==========================================

const MAX_NAME_LENGTH = 40;
const MAX_CHAT_LENGTH = 1000;
const MAX_MEMORY_IMAGE_LENGTH = 7 * 1024 * 1024;

// ==========================================
// HELPERS
// ==========================================

function isValidCoordinate(value, min, max) {
    const number = Number(value);

    return (
        Number.isFinite(number) &&
        number >= min &&
        number <= max
    );
}

function cleanName(value) {

    if (typeof value !== "string") {
        return "User";
    }

    return value
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, MAX_NAME_LENGTH) || "User";
}

function isValidDataURL(value) {

    if (typeof value !== "string") {
        return false;
    }

    return /^data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,/i
        .test(value);
}

function isValidImageDataURL(value) {

    if (typeof value !== "string") {
        return false;
    }

    return /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i
        .test(value);
}

function isValidChatMessage(msg) {

    if (!msg || typeof msg !== "object") {
        return false;
    }

    if (
        typeof msg.name !== "string" ||
        typeof msg.type !== "string" ||
        typeof msg.data !== "string"
    ) {
        return false;
    }

    const allowedTypes = [
        "text",
        "image",
        "video",
        "audio",
        "document"
    ];

    if (!allowedTypes.includes(msg.type)) {
        return false;
    }

    if (
        msg.type === "text" &&
        msg.data.length > MAX_CHAT_LENGTH
    ) {
        return false;
    }

    if (
        msg.type !== "text" &&
        !isValidDataURL(msg.data)
    ) {
        return false;
    }

    return true;
}

// ==========================================
// SOCKET.IO
// ==========================================

io.on("connection", socket => {

    console.log(
        `User Connected: ${socket.id}`
    );

    // ------------------------------
    // SEND EXISTING MEMORY PHOTOS
    // ------------------------------

    socket.emit(
        "loadMemoryPhotos",
        memoryPhotos
    );

    // ==========================================
    // LIVE LOCATION
    // ==========================================

    socket.on(
        "updateLocation",
        data => {

            if (
                !data ||
                typeof data !== "object"
            ) {
                return;
            }

            const lat =
                Number(data.lat);

            const lng =
                Number(data.lng);

            if (
                !isValidCoordinate(
                    lat,
                    -90,
                    90
                ) ||
                !isValidCoordinate(
                    lng,
                    -180,
                    180
                )
            ) {
                return;
            }

            const name =
                cleanName(data.name);

            const avatar =
                typeof data.avatar === "string"
                    ? data.avatar.slice(
                        0,
                        7 * 1024 * 1024
                    )
                    : "";

            const weather =
                typeof data.weather === "string"
                    ? data.weather.slice(0, 50)
                    : "";

            // IMPORTANT:
            // name must be sent to other users.

            socket.broadcast.emit(
                "friendMoved",
                {
                    id: socket.id,
                    name: name, // <-- FIX: Ensures name is always sent correctly
                    lat: lat,
                    lng: lng,
                    avatar: avatar,
                    weather: weather
                }
            );
        }
    );

    // ==========================================
    // CHAT
    // ==========================================

    socket.on(
        "chatMessage",
        msg => {

            if (
                !isValidChatMessage(msg)
            ) {
                return;
            }

            const cleanMessage = {

                name:
                    cleanName(msg.name),

                type:
                    msg.type,

                data:
                    msg.type === "text"
                        ? msg.data
                            .trim()
                            .slice(
                                0,
                                MAX_CHAT_LENGTH
                            )
                        : msg.data
            };

            if (
                cleanMessage.type === "text" &&
                !cleanMessage.data
            ) {
                return;
            }

            io.emit(
                "chatMessage",
                cleanMessage
            );
        }
    );

    // ==========================================
    // MEMORY PHOTO
    // ==========================================

    socket.on(
        "uploadMemoryPhoto",
        data => {

            if (
                !data ||
                typeof data !== "object"
            ) {
                return;
            }

            const lat =
                Number(data.lat);

            const lng =
                Number(data.lng);

            if (
                !isValidCoordinate(
                    lat,
                    -90,
                    90
                ) ||
                !isValidCoordinate(
                    lng,
                    -180,
                    180
                )
            ) {
                return;
            }

            if (
                !isValidImageDataURL(
                    data.image
                )
            ) {
                return;
            }

            if (
                data.image.length >
                MAX_MEMORY_IMAGE_LENGTH
            ) {
                return;
            }

            const newPin = {

                id:
                    `${socket.id}-${Date.now()}`,

                name:
                    cleanName(data.name),

                lat,
                lng,

                image:
                    data.image,

                time:
                    typeof data.time === "string"
                        ? data.time.slice(0, 100)
                        : ""
            };

            memoryPhotos.push(
                newPin
            );

            if (
                memoryPhotos.length >
                MAX_MEMORY_PHOTOS
            ) {
                memoryPhotos.shift();
            }

            io.emit(
                "newMemoryPin",
                newPin
            );
        }
    );

    // ==========================================
    // DISCONNECT
    // ==========================================

    socket.on(
        "disconnect",
        reason => {

            console.log(
                `User Disconnected: ${socket.id} (${reason})`
            );

            io.emit(
                "friendDisconnected",
                socket.id
            );
        }
    );
});

// ==========================================
// SOCKET.IO ERRORS
// ==========================================

io.engine.on(
    "connection_error",
    error => {

        console.error(
            "Socket connection error:",
            error.message
        );
    }
);

// ==========================================
// SERVER
// ==========================================

const PORT =
    process.env.PORT || 3000;

server.listen(
    PORT,
    () => {

        console.log(
            `Koraput Map running at http://localhost:${PORT}`
        );
    }
);
