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
app.use(express.static(path.join(__dirname, "public")));

const memoryPhotos = [];
const MAX_MEMORY_PHOTOS = 100;

function isValidCoordinate(value, min, max) {
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max;
}

function cleanName(value) {
    if (typeof value !== "string") return "User";
    return value.trim().slice(0, 40) || "User";
}

function isValidChatMessage(msg) {
    if (!msg || typeof msg !== "object") return false;
    if (typeof msg.name !== "string" || typeof msg.type !== "string" || typeof msg.data !== "string") return false;
    const allowedTypes = ["text", "image", "video", "audio", "document"];
    return allowedTypes.includes(msg.type);
}

io.on("connection", socket => {
    console.log(`User Connected: ${socket.id}`);

    socket.emit("loadMemoryPhotos", memoryPhotos);

    socket.on("updateLocation", data => {
        if (!data || typeof data !== "object") return;

        const lat = Number(data.lat);
        const lng = Number(data.lng);

        if (!isValidCoordinate(lat, -90, 90) || !isValidCoordinate(lng, -180, 180)) return;

        const name = cleanName(data.name);
        const avatar = typeof data.avatar === "string" ? data.avatar : "";
        const weather = typeof data.weather === "string" ? data.weather.slice(0, 50) : "";

        socket.broadcast.emit("friendMoved", {
            id: socket.id,
            name, lat, lng, avatar, weather
        });
    });

    socket.on("chatMessage", msg => {
        if (!isValidChatMessage(msg)) return;

        const cleanMessage = {
            name: cleanName(msg.name),
            type: msg.type,
            data: msg.data
        };
        io.emit("chatMessage", cleanMessage);
    });

    socket.on("uploadMemoryPhoto", data => {
        if (!data || typeof data !== "object") return;

        const lat = Number(data.lat);
        const lng = Number(data.lng);

        if (!isValidCoordinate(lat, -90, 90) || !isValidCoordinate(lng, -180, 180)) return;
        if (typeof data.image !== "string" || !data.image.startsWith("data:image/")) return;
        if (data.image.length > 7 * 1024 * 1024) return;

        const newPin = {
            id: `${socket.id}-${Date.now()}`,
            name: cleanName(data.name),
            lat, lng,
            image: data.image,
            time: typeof data.time === "string" ? data.time.slice(0, 100) : ""
        };

        memoryPhotos.push(newPin);
        if (memoryPhotos.length > MAX_MEMORY_PHOTOS) memoryPhotos.shift();

        io.emit("newMemoryPin", newPin);
    });

    socket.on("disconnect", () => {
        console.log(`User Disconnected: ${socket.id}`);
        io.emit("friendDisconnected", socket.id);
    });
});

io.engine.on("connection_error", (error) => {
    console.error("Socket connection error:", error.message);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Koraput Map running at http://localhost:${PORT}`);
});
