// ==========================================
// KORAPUT MAP - CLEAN SERVER
// ==========================================

const express = require("express");
const http = require("http");
const path = require("path");

const app = express();
const server = http.createServer(app);

// ==========================================
// 1. SOCKET.IO
// ==========================================

const io = require("socket.io")(server, {
    // Base64 files are larger than the original files,
    // so keep this above the client's 5 MB limit.
    maxHttpBufferSize: 10 * 1024 * 1024
});

// ==========================================
// 2. STATIC FILES
// ==========================================

app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// 3. MEMORY PHOTO STORAGE
// ==========================================

// Temporary in-memory storage.
// Photos will disappear when the server restarts.
const memoryPhotos = [];

// Maximum number of memory pins kept in RAM.
const MAX_MEMORY_PHOTOS = 100;

// ==========================================
// 4. VALIDATION HELPERS
// ==========================================

function isValidCoordinate(value, min, max) {
    const number = Number(value);

    return (
        Number.isFinite(number) &&
        number >= min &&
        number <= max
    );
}

function isValidImageData(value) {
    if (typeof value !== "string") {
        return false;
    }

    return /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value);
}

function cleanName(value) {
    if (typeof value !== "string") {
        return "User";
    }

    return value
        .trim()
        .slice(0, 40) || "User";
}

function isValidChatMessage(msg) {
    if (!msg || typeof msg !== "object") {
        return false;
    }

    if (
        typeof msg.name !== "string" ||
        typeof msg.type !== "string"
    ) {
        return false;
    }

    if (typeof msg.data !== "string") {
        return false;
    }

    const allowedTypes = [
        "text",
        "image",
        "video",
        "audio",
        "document"
    ];

    return allowedTypes.includes(msg.type);
}

// ==========================================
// 5. SOCKET CONNECTION
// ==========================================

io.on("connection", (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Send existing memory photos to the new user.
    socket.emit(
        "loadMemoryPhotos",
        memoryPhotos
    );

    // ======================================
    // REAL-TIME LOCATION
    // ======================================

    socket.on("updateLocation", (data) => {
        if (!data || typeof data !== "object") {
            return;
        }

        const lat = Number(data.lat);
        const lng = Number(data.lng);

        if (
            !isValidCoordinate(lat, -90, 90) ||
            !isValidCoordinate(lng, -180, 180)
        ) {
            console.warn(
                `Invalid location from ${socket.id}`
            );
            return;
        }

        const name = cleanName(data.name);

        const avatar =
            typeof data.avatar === "string"
                ? data.avatar
                : "friend1.png";

        const weather =
            typeof data.weather === "string"
                ? data.weather.slice(0, 50)
                : "";

        socket.broadcast.emit(
            "friendMoved",
            {
                id: socket.id,
                name,
                lat,
                lng,
                avatar,
                weather
            }
        );
    });

    // ======================================
    // CHAT
    // ======================================

    socket.on("chatMessage", (msg) => {
        if (!isValidChatMessage(msg)) {
            console.warn(
                `Invalid chat message from ${socket.id}`
            );
            return;
        }

        const cleanMessage = {
            name: cleanName(msg.name),
            type: msg.type,
            data: msg.data
        };

        io.emit(
            "chatMessage",
            cleanMessage
        );
    });

    // ======================================
    // MEMORY PHOTO
    // ======================================

    socket.on(
        "uploadMemoryPhoto",
        (data) => {
            if (!data || typeof data !== "object") {
                return;
            }

            const lat = Number(data.lat);
            const lng = Number(data.lng);

            if (
                !isValidCoordinate(lat, -90, 90) ||
                !isValidCoordinate(lng, -180, 180)
            ) {
                console.warn(
                    `Invalid memory coordinates from ${socket.id}`
                );
                return;
            }

            if (!isValidImageData(data.image)) {
                console.warn(
                    `Invalid memory image from ${socket.id}`
                );
                return;
            }

            // Keep memory usage under control.
            if (
                memoryPhotos.length >=
                MAX_MEMORY_PHOTOS
            ) {
                memoryPhotos.shift();
            }

            const newPin = {
                id: socket.id,
                name: cleanName(data.name),
                lat,
                lng,
                image: data.image,
                time:
                    typeof data.time === "string"
                        ? data.time.slice(0, 100)
                        : new Date().toLocaleString()
            };

            memoryPhotos.push(newPin);

            // Send new memory to everyone.
            io.emit(
                "newMemoryPin",
                newPin
            );
        }
    );

    // ======================================
    // DISCONNECT
    // ======================================

    socket.on("disconnect", (reason) => {
        console.log(
            `User disconnected: ${socket.id} (${reason})`
        );

        io.emit(
            "friendDisconnected",
            socket.id
        );
    });
});

// ==========================================
// 6. SOCKET ERROR HANDLING
// ==========================================

io.engine.on("connection_error", (error) => {
    console.error(
        "Socket connection error:",
        error.message
    );
});

// ==========================================
// 7. SERVER
// ==========================================

const PORT =
    process.env.PORT || 3000;

server.listen(
    PORT,
    () => {
        console.log(
            `Koraput Map server running on port ${PORT}`
        );

        console.log(
            "Socket.IO max payload: 10 MB"
        );
    }
);
