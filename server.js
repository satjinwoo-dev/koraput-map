// ==========================================
// KORAPUT MAP — PHASE 2 SOCIAL SERVER (LEAFLET COMPATIBLE)
// ==========================================

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = require("socket.io")(server, {
    maxHttpBufferSize: 10 * 1024 * 1024
});

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));

const memoryPhotos = [];
const users = new Map();
const messages = new Map();

function validCoordinate(value, min, max) { const n = Number(value); return Number.isFinite(n) && n >= min && n <= max; }
function cleanName(value) { return typeof value === "string" ? value.trim().slice(0, 40) || "User" : "User"; }
function safeAvatar(value) { return (typeof value === "string" && (value.startsWith("data:image/") || /^https?:\/\//i.test(value))) ? value.slice(0, 3000000) : "friend1.png"; }

function publicUser(id) {
    const user = users.get(id);
    if (!user) return null;
    return { id, name: user.name, avatar: user.avatar, online: true, lat: user.lat, lng: user.lng, weather: user.weather || "" };
}

function broadcastOnlineUsers() {
    const online = Array.from(users.keys()).map(publicUser).filter(Boolean);
    io.emit("onlineUsers", online);
}

io.on("connection", socket => {
    console.log("User connected:", socket.id);
    socket.emit("loadMemoryPhotos", memoryPhotos);
    socket.emit("onlineUsers", Array.from(users.keys()).map(publicUser).filter(Boolean));

    // JOIN
    socket.on("profileReady", data => {
        const oldUser = users.get(socket.id) || {};
        users.set(socket.id, {
            name: cleanName(data?.name), avatar: safeAvatar(data?.avatar),
            lat: oldUser.lat ?? null, lng: oldUser.lng ?? null, weather: oldUser.weather || ""
        });
        const user = publicUser(socket.id);
        socket.broadcast.emit("userOnline", user);
        broadcastOnlineUsers();
    });

    // MAP LOCATION
    socket.on("updateLocation", data => {
        if (!data || typeof data !== "object") return;
        const lat = Number(data.lat), lng = Number(data.lng);
        if (!validCoordinate(lat, -90, 90) || !validCoordinate(lng, -180, 180)) return;

        const oldUser = users.get(socket.id) || {};
        const user = {
            name: cleanName(data.name ?? oldUser.name),
            avatar: safeAvatar(data.avatar ?? oldUser.avatar),
            lat, lng, weather: typeof data.weather === "string" ? data.weather.slice(0, 50) : oldUser.weather || ""
        };
        users.set(socket.id, user);

        socket.broadcast.emit("friendMoved", { id: socket.id, ...publicUser(socket.id) });
    });

    // TYPING
    socket.on("typing", value => {
        const user = users.get(socket.id);
        if (user) socket.broadcast.emit("typing", { id: socket.id, name: user.name, isTyping: Boolean(value) });
    });

    // CHAT
    socket.on("chatMessage", msg => {
        if (!msg || typeof msg !== "object") return;
        const user = users.get(socket.id);
        const messageId = crypto.randomUUID();

        const cleanMessage = {
            id: messageId, senderId: socket.id,
            name: user?.name || cleanName(msg.name),
            type: msg.type, data: msg.type === "text" ? String(msg.data).trim().slice(0, 1000) : msg.data,
            time: new Date().toISOString(),
            replyTo: (msg.replyTo && typeof msg.replyTo === "object") ? {
                id: String(msg.replyTo.id || "").slice(0, 100),
                name: cleanName(msg.replyTo.name),
                preview: String(msg.replyTo.preview || "").slice(0, 200)
            } : null,
            reactions: {}
        };

        if (cleanMessage.type === "text" && !cleanMessage.data) return;

        messages.set(messageId, cleanMessage);
        if (messages.size > 200) messages.delete(messages.keys().next().value);
        io.emit("chatMessage", cleanMessage);
    });

    // REACTIONS
    socket.on("messageReaction", data => {
        if (!data || typeof data !== "object") return;
        const messageId = String(data.messageId || "");
        const emoji = typeof data.emoji === "string" ? data.emoji.slice(0, 8) : "";
        const message = messages.get(messageId);
        const allowedReactions = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

        if (!message || !allowedReactions.includes(emoji)) return;
        if (!message.reactions[emoji]) message.reactions[emoji] = [];
        
        const usersForReaction = message.reactions[emoji];
        const existingIndex = usersForReaction.indexOf(socket.id);
        if (existingIndex >= 0) usersForReaction.splice(existingIndex, 1);
        else usersForReaction.push(socket.id);

        io.emit("messageReaction", { messageId: message.id, reactions: message.reactions });
    });

    // MEMORY
    socket.on("uploadMemoryPhoto", data => {
        if (!data || typeof data !== "object") return;
        const lat = Number(data.lat), lng = Number(data.lng);
        if (!validCoordinate(lat, -90, 90) || !validCoordinate(lng, -180, 180) || typeof data.image !== "string" || data.image.length > 7 * 1024 * 1024) return;

        const user = users.get(socket.id);
        const newPin = {
            id: `${socket.id}-${Date.now()}`, name: user?.name || cleanName(data.name),
            lat, lng, image: data.image, time: typeof data.time === "string" ? data.time.slice(0, 100) : ""
        };

        memoryPhotos.push(newPin);
        if (memoryPhotos.length > MAX_MEMORY_PHOTOS) memoryPhotos.shift();
        io.emit("newMemoryPin", newPin);
    });

    // DISCONNECT
    socket.on("disconnect", () => {
        users.delete(socket.id);
        socket.broadcast.emit("typing", { id: socket.id, name: "", isTyping: false });
        io.emit("friendDisconnected", socket.id);
        io.emit("userOffline", { id: socket.id });
        broadcastOnlineUsers();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Koraput Map running at http://localhost:${PORT}`));
