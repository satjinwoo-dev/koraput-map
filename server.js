const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server, { maxHttpBufferSize: 10 * 1024 * 1024 });

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));

const users = new Map();
const messages = new Map();
const memoryPhotos = [];

const MAX_MESSAGES = 200;
const MAX_MEMORY_PHOTOS = 100;
const MAX_MESSAGE_DATA = 8 * 1024 * 1024;
const MAX_MEMORY_DATA = 7 * 1024 * 1024;

const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
const CHAT_TYPES = ["text", "image", "video", "audio", "document"];

function validCoord(v, min, max) {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max;
}

function cleanName(v) {
    if (typeof v !== "string") return "User";
    return v.trim().replace(/\s+/g, " ").slice(0, 40) || "User";
}

function safeAvatar(v) {
    if (typeof v !== "string") return "satyam.png";
    if (/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(v)) return v.slice(0, 3_000_000);
    if (/^https?:\/\//i.test(v)) return v.slice(0, 2000);
    if (/^[a-zA-Z0-9._/-]+$/.test(v)) return v.slice(0, 300);
    return "satyam.png";
}

function validDataUrl(v, type) {
    if (typeof v !== "string") return false;
    if (v.length > MAX_MESSAGE_DATA) return false;
    return new RegExp(`^data:${type}\\/`, "i").test(v);
}

function validChatMessage(msg) {
    if (!msg || typeof msg !== "object") return false;
    if (!CHAT_TYPES.includes(msg.type)) return false;
    if (typeof msg.data !== "string" || msg.data.length === 0 || msg.data.length > MAX_MESSAGE_DATA) return false;
    if (msg.type === "text") return msg.data.length <= 1000;
    if (!["image", "video", "audio", "document"].includes(msg.type)) return false;
    return /^(data:(image|video|audio|application|text)\/|https?:\/\/)/i.test(msg.data);
}

function publicUser(id) {
    const u = users.get(id);
    if (!u) return null;
    return { id, name: u.name, avatar: u.avatar, online: u.online !== false, lat: u.lat, lng: u.lng, weather: u.weather || "" };
}

function onlineUsers() {
    return [...users.keys()].map(publicUser).filter(Boolean);
}

function broadcastUsers() {
    io.emit("onlineUsers", onlineUsers());
}

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.emit("loadMemoryPhotos", memoryPhotos);
    socket.emit("onlineUsers", onlineUsers());
    socket.emit("chatHistory", [...messages.values()]);

    socket.on("profileReady", (data = {}) => {
        const old = users.get(socket.id) || {};
        const user = {
            name: cleanName(data.name),
            avatar: safeAvatar(data.avatar),
            lat: validCoord(old.lat, -90, 90) ? old.lat : null,
            lng: validCoord(old.lng, -180, 180) ? old.lng : null,
            weather: old.weather || "",
            online: true
        };
        users.set(socket.id, user);
        socket.emit("profileConfirmed", publicUser(socket.id));
        socket.broadcast.emit("userOnline", publicUser(socket.id));
        broadcastUsers();
    });

    socket.on("updateLocation", (data = {}) => {
        const lat = Number(data.lat);
        const lng = Number(data.lng);
        if (!validCoord(lat, -90, 90) || !validCoord(lng, -180, 180)) return;

        const old = users.get(socket.id) || {};
        const user = {
            name: cleanName(data.name ?? old.name),
            avatar: data.avatar !== undefined ? safeAvatar(data.avatar) : safeAvatar(old.avatar),
            lat, lng,
            weather: typeof data.weather === "string" ? data.weather.slice(0, 50) : old.weather || "",
            online: true
        };
        users.set(socket.id, user);
        socket.broadcast.emit("friendMoved", publicUser(socket.id));
        broadcastUsers();
    });

    socket.on("typing", (isTyping) => {
        const user = users.get(socket.id);
        if (!user) return;
        socket.broadcast.emit("typing", { id: socket.id, name: user.name, isTyping: Boolean(isTyping) });
    });

    socket.on("chatMessage", (msg) => {
        if (!validChatMessage(msg)) return;
        const user = users.get(socket.id);
        const message = {
            id: crypto.randomUUID(),
            senderId: socket.id,
            name: user?.name || cleanName(msg.name),
            type: msg.type,
            data: msg.data,
            time: new Date().toISOString(),
            replyTo: msg.replyTo && typeof msg.replyTo === "object" ? {
                id: String(msg.replyTo.id || "").slice(0, 100),
                name: cleanName(msg.replyTo.name),
                type: String(msg.replyTo.type || "text").slice(0, 20),
                preview: String(msg.replyTo.preview || "").slice(0, 200)
            } : null,
            reactions: {}
        };
        messages.set(message.id, message);
        while (messages.size > MAX_MESSAGES) messages.delete(messages.keys().next().value);
        io.emit("chatMessage", message);
    });

    socket.on("messageReaction", (data = {}) => {
        const id = String(data.messageId || "");
        const emoji = typeof data.emoji === "string" ? data.emoji : "";
        if (!REACTIONS.includes(emoji)) return;
        const message = messages.get(id);
        if (!message) return;
        message.reactions ||= {};
        message.reactions[emoji] ||= [];
        const list = message.reactions[emoji];
        const i = list.indexOf(socket.id);
        if (i >= 0) list.splice(i, 1); else list.push(socket.id);
        io.emit("messageReaction", { messageId: id, reactions: message.reactions });
    });

    socket.on("uploadMemoryPhoto", (data = {}) => {
        const lat = Number(data.lat);
        const lng = Number(data.lng);
        if (!validCoord(lat, -90, 90) || !validCoord(lng, -180, 180)) return;
        if (!validDataUrl(data.image, "image")) return;
        if (data.image.length > MAX_MEMORY_DATA) return;

        const user = users.get(socket.id);
        const pin = {
            id: `${socket.id}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
            name: user?.name || cleanName(data.name),
            lat, lng,
            image: data.image,
            time: typeof data.time === "string" ? data.time.slice(0, 100) : new Date().toISOString()
        };
        memoryPhotos.push(pin);
        while (memoryPhotos.length > MAX_MEMORY_PHOTOS) memoryPhotos.shift();
        io.emit("newMemoryPin", pin);
    });

    socket.on("disconnect", (reason) => {
        users.delete(socket.id);
        socket.broadcast.emit("typing", { id: socket.id, name: "", isTyping: false });
        socket.broadcast.emit("friendDisconnected", socket.id);
        io.emit("userOffline", { id: socket.id });
        broadcastUsers();
        console.log("User disconnected:", socket.id, reason);
    });
});

io.engine.on("connection_error", (err) => console.error("Socket connection error:", err.message));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Koraput Map running at http://localhost:${PORT}`));
