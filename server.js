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

const MAX_MEMORY_PHOTOS = 100;
const MAX_MESSAGES = 200;

function validCoord(value, min, max) {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max;
}

function cleanName(value) {
    if (typeof value !== "string") return "User";

    return value
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 40) || "User";
}

function safeAvatar(value) {
    if (typeof value !== "string") {
        return "friend1.png";
    }

    if (
        value.startsWith("data:image/") ||
        /^https?:\/\//i.test(value) ||
        /^[a-zA-Z0-9._/-]+$/.test(value)
    ) {
        return value.slice(0, 3_000_000);
    }

    return "friend1.png";
}

function validChatMessage(msg) {
    if (!msg || typeof msg !== "object") {
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

    if (typeof msg.data !== "string") {
        return false;
    }

    if (msg.data.length > 8 * 1024 * 1024) {
        return false;
    }

    return true;
}

function publicUser(id) {
    const user = users.get(id);

    if (!user) {
        return null;
    }

    return {
        id,
        name: user.name,
        avatar: user.avatar,
        online: true,
        lat: user.lat,
        lng: user.lng,
        weather: user.weather || ""
    };
}

function getOnlineUsers() {
    return Array.from(users.keys())
        .map(publicUser)
        .filter(Boolean);
}

function broadcastOnlineUsers() {
    io.emit("onlineUsers", getOnlineUsers());
}


// ==========================================
// SOCKET.IO
// ==========================================

io.on("connection", (socket) => {

    console.log("User connected:", socket.id);

    // Send memory pins
    socket.emit("loadMemoryPhotos", memoryPhotos);

    // Send online users
    socket.emit("onlineUsers", getOnlineUsers());


    // ======================================
    // PROFILE
    // ======================================

    socket.on("profileReady", (data) => {

        const old = users.get(socket.id) || {};

        const user = {
            name: cleanName(data?.name),
            avatar: safeAvatar(data?.avatar),

            lat:
                validCoord(old.lat, -90, 90)
                    ? old.lat
                    : null,

            lng:
                validCoord(old.lng, -180, 180)
                    ? old.lng
                    : null,

            weather: old.weather || ""
        };

        users.set(socket.id, user);

        socket.emit(
            "profileConfirmed",
            publicUser(socket.id)
        );

        socket.broadcast.emit(
            "userOnline",
            publicUser(socket.id)
        );

        broadcastOnlineUsers();
    });


    // ======================================
    // LIVE LOCATION
    // ======================================

    socket.on("updateLocation", (data) => {

        if (!data || typeof data !== "object") {
            return;
        }

        const lat = Number(data.lat);
        const lng = Number(data.lng);

        if (
            !validCoord(lat, -90, 90) ||
            !validCoord(lng, -180, 180)
        ) {
            return;
        }

        const old = users.get(socket.id) || {};

        const user = {
            name: cleanName(data.name ?? old.name),

            avatar:
                data.avatar !== undefined
                    ? safeAvatar(data.avatar)
                    : safeAvatar(old.avatar),

            lat,
            lng,

            weather:
                typeof data.weather === "string"
                    ? data.weather.slice(0, 50)
                    : old.weather || ""
        };

        users.set(socket.id, user);

        socket.broadcast.emit("friendMoved", {
            id: socket.id,
            ...publicUser(socket.id)
        });
    });


    // ======================================
    // TYPING INDICATOR
    // ======================================

    socket.on("typing", (isTyping) => {

        const user = users.get(socket.id);

        if (!user) {
            return;
        }

        socket.broadcast.emit("typing", {
            id: socket.id,
            name: user.name,
            isTyping: Boolean(isTyping)
        });
    });


    // ======================================
    // CHAT MESSAGE
    // ======================================

    socket.on("chatMessage", (msg) => {

        if (!validChatMessage(msg)) {
            return;
        }

        const user = users.get(socket.id);

        const message = {
            id: crypto.randomUUID(),

            senderId: socket.id,

            name:
                user?.name ||
                cleanName(msg.name),

            type: msg.type,

            data: msg.data,

            time: new Date().toISOString(),

            replyTo:
                msg.replyTo &&
                typeof msg.replyTo === "object"
                    ? {
                        id: String(
                            msg.replyTo.id || ""
                        ).slice(0, 100),

                        name: cleanName(
                            msg.replyTo.name
                        ),

                        type: String(
                            msg.replyTo.type || "text"
                        ).slice(0, 20),

                        preview: String(
                            msg.replyTo.preview || ""
                        ).slice(0, 200)
                    }
                    : null,

            reactions: {}
        };

        messages.set(message.id, message);

        while (messages.size > MAX_MESSAGES) {
            const firstId =
                messages.keys().next().value;

            messages.delete(firstId);
        }

        io.emit("chatMessage", message);
    });


    // ======================================
    // MESSAGE REACTION
    // ======================================

    socket.on("messageReaction", (data) => {

        if (!data || typeof data !== "object") {
            return;
        }

        const messageId =
            String(data.messageId || "");

        const emoji =
            typeof data.emoji === "string"
                ? data.emoji.slice(0, 8)
                : "";

        const message =
            messages.get(messageId);

        const allowed = [
            "👍",
            "❤️",
            "😂",
            "😮",
            "😢",
            "🔥"
        ];

        if (
            !message ||
            !allowed.includes(emoji)
        ) {
            return;
        }

        if (!message.reactions[emoji]) {
            message.reactions[emoji] = [];
        }

        const list =
            message.reactions[emoji];

        const index =
            list.indexOf(socket.id);

        if (index >= 0) {
            list.splice(index, 1);
        } else {
            list.push(socket.id);
        }

        io.emit("messageReaction", {
            messageId: message.id,
            reactions: message.reactions
        });
    });


    // ======================================
    // MEMORY PHOTO
    // ======================================

    socket.on("uploadMemoryPhoto", (data) => {

        if (!data || typeof data !== "object") {
            return;
        }

        const lat = Number(data.lat);
        const lng = Number(data.lng);

        if (
            !validCoord(lat, -90, 90) ||
            !validCoord(lng, -180, 180)
        ) {
            return;
        }

        if (
            typeof data.image !== "string" ||
            !/^data:image\/[a-z0-9.+-]+;base64,/i.test(
                data.image
            )
        ) {
            return;
        }

        if (data.image.length > 7 * 1024 * 1024) {
            return;
        }

        const user = users.get(socket.id);

        const pin = {
            id:
                `${socket.id}-${Date.now()}`,

            name:
                user?.name ||
                cleanName(data.name),

            lat,
            lng,

            image: data.image,

            time:
                typeof data.time === "string"
                    ? data.time.slice(0, 100)
                    : ""
        };

        memoryPhotos.push(pin);

        if (
            memoryPhotos.length >
            MAX_MEMORY_PHOTOS
        ) {
            memoryPhotos.shift();
        }

        io.emit("newMemoryPin", pin);
    });


    // ======================================
    // DISCONNECT
    // ======================================

    socket.on("disconnect", (reason) => {

        users.delete(socket.id);

        socket.broadcast.emit("typing", {
            id: socket.id,
            name: "",
            isTyping: false
        });

        socket.broadcast.emit(
            "friendDisconnected",
            socket.id
        );

        io.emit("userOffline", {
            id: socket.id
        });

        broadcastOnlineUsers();

        console.log(
            "User disconnected:",
            socket.id,
            reason
        );
    });
});


io.engine.on("connection_error", (error) => {
    console.error(
        "Socket connection error:",
        error.message
    );
});


// ==========================================
// START SERVER
// ==========================================

const PORT =
    process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(
        `Koraput Map running at http://localhost:${PORT}`
    );
});
