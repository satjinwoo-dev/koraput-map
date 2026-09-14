// ==========================================
// KORAPUT MAP — PHASE 2 SOCIAL SERVER
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

// ==========================================
// MEMORY STORAGE
// ==========================================

const memoryPhotos = [];
const MAX_MEMORY_PHOTOS = 100;

// ==========================================
// SOCIAL STORAGE
// ==========================================

const users = new Map();
const messages = new Map();

const MAX_MESSAGES = 200;

// ==========================================
// VALIDATION
// ==========================================

function validCoordinate(value, min, max) {
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

    return value.trim().slice(0, 40) || "User";
}

function safeAvatar(value) {
    if (typeof value !== "string") {
        return "friend1.png";
    }

    if (
        value.startsWith("data:image/") ||
        /^https?:\/\//i.test(value)
    ) {
        return value.slice(0, 3000000);
    }

    return "friend1.png";
}

function validChatMessage(message) {
    if (!message || typeof message !== "object") {
        return false;
    }

    const allowedTypes = [
        "text",
        "image",
        "video",
        "audio",
        "document"
    ];

    return (
        allowedTypes.includes(message.type) &&
        typeof message.data === "string" &&
        message.data.length <= 8 * 1024 * 1024
    );
}

// ==========================================
// PUBLIC USER DATA
// ==========================================

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

// ==========================================
// ONLINE USERS
// ==========================================

function broadcastOnlineUsers() {
    const online = Array.from(users.keys())
        .map(publicUser)
        .filter(Boolean);

    io.emit("onlineUsers", online);
}

// ==========================================
// SOCKET CONNECTION
// ==========================================

io.on("connection", socket => {

    console.log("User connected:", socket.id);

    // Send existing memories
    socket.emit(
        "loadMemoryPhotos",
        memoryPhotos
    );

    // Send current online users
    socket.emit(
        "onlineUsers",
        Array.from(users.keys())
            .map(publicUser)
            .filter(Boolean)
    );

    // ==========================================
    // PROFILE
    // ==========================================

    socket.on("profileReady", data => {

        const oldUser = users.get(socket.id) || {};

        users.set(socket.id, {

            name: cleanName(data?.name),

            avatar: safeAvatar(data?.avatar),

            lat:
                oldUser.lat ??
                null,

            lng:
                oldUser.lng ??
                null,

            weather:
                oldUser.weather ||
                ""
        });

        const user = publicUser(socket.id);

        socket.emit(
            "profileConfirmed",
            user
        );

        socket.broadcast.emit(
            "userOnline",
            user
        );

        broadcastOnlineUsers();
    });

    // ==========================================
    // LIVE LOCATION
    // ==========================================

    socket.on("updateLocation", data => {

        if (!data || typeof data !== "object") {
            return;
        }

        const lat = Number(data.lat);
        const lng = Number(data.lng);

        if (
            !validCoordinate(lat, -90, 90) ||
            !validCoordinate(lng, -180, 180)
        ) {
            return;
        }

        const oldUser = users.get(socket.id) || {};

        const user = {

            name:
                cleanName(
                    data.name ??
                    oldUser.name
                ),

            avatar:
                safeAvatar(
                    data.avatar ??
                    oldUser.avatar
                ),

            lat,
            lng,

            weather:
                typeof data.weather === "string"
                    ? data.weather.slice(0, 50)
                    : oldUser.weather || ""
        };

        users.set(
            socket.id,
            user
        );

        socket.broadcast.emit(
            "friendMoved",
            {
                id: socket.id,
                ...publicUser(socket.id)
            }
        );
    });

    // ==========================================
    // TYPING INDICATOR
    // ==========================================

    socket.on("typing", value => {

        const user = users.get(socket.id);

        if (!user) {
            return;
        }

        socket.broadcast.emit(
            "typing",
            {
                id: socket.id,

                name: user.name,

                isTyping:
                    Boolean(value)
            }
        );
    });

    // ==========================================
    // CHAT MESSAGE
    // ==========================================

    socket.on("chatMessage", message => {

        if (!validChatMessage(message)) {
            return;
        }

        const user = users.get(socket.id);

        const messageId =
            crypto.randomUUID();

        const cleanMessage = {

            id: messageId,

            senderId:
                socket.id,

            name:
                user?.name ||
                cleanName(message.name),

            type:
                message.type,

            data:
                message.data,

            time:
                new Date().toISOString(),

            replyTo:
                message.replyTo &&
                typeof message.replyTo === "object"
                    ? {

                        id:
                            String(
                                message.replyTo.id ||
                                ""
                            ).slice(0, 100),

                        name:
                            cleanName(
                                message.replyTo.name
                            ),

                        type:
                            String(
                                message.replyTo.type ||
                                "text"
                            ).slice(0, 20),

                        preview:
                            String(
                                message.replyTo.preview ||
                                ""
                            ).slice(0, 200)

                    }
                    : null,

            reactions: {}
        };

        messages.set(
            messageId,
            cleanMessage
        );

        // Keep only the newest messages
        if (messages.size > MAX_MESSAGES) {

            const firstId =
                messages.keys().next().value;

            messages.delete(firstId);
        }

        io.emit(
            "chatMessage",
            cleanMessage
        );
    });

    // ==========================================
    // MESSAGE REACTIONS
    // ==========================================

    socket.on("messageReaction", data => {

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

        const allowedReactions = [
            "👍",
            "❤️",
            "😂",
            "😮",
            "😢",
            "🔥"
        ];

        if (
            !message ||
            !allowedReactions.includes(emoji)
        ) {
            return;
        }

        if (!message.reactions[emoji]) {
            message.reactions[emoji] = [];
        }

        const usersForReaction =
            message.reactions[emoji];

        const existingIndex =
            usersForReaction.indexOf(
                socket.id
            );

        if (existingIndex >= 0) {

            usersForReaction.splice(
                existingIndex,
                1
            );

        } else {

            usersForReaction.push(
                socket.id
            );
        }

        io.emit(
            "messageReaction",
            {
                messageId:
                    message.id,

                reactions:
                    message.reactions
            }
        );
    });

    // ==========================================
    // MEMORY PHOTO
    // ==========================================

    socket.on("uploadMemoryPhoto", data => {

        if (!data || typeof data !== "object") {
            return;
        }

        const lat = Number(data.lat);
        const lng = Number(data.lng);

        if (
            !validCoordinate(lat, -90, 90) ||
            !validCoordinate(lng, -180, 180)
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

        if (
            data.image.length >
            7 * 1024 * 1024
        ) {
            return;
        }

        const user =
            users.get(socket.id);

        const newPin = {

            id:
                `${socket.id}-${Date.now()}`,

            name:
                user?.name ||
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
    });

    // ==========================================
    // DISCONNECT
    // ==========================================

    socket.on("disconnect", reason => {

        users.delete(
            socket.id
        );

        socket.broadcast.emit(
            "typing",
            {
                id: socket.id,
                name: "",
                isTyping: false
            }
        );

        io.emit(
            "friendDisconnected",
            socket.id
        );

        io.emit(
            "userOffline",
            {
                id: socket.id
            }
        );

        broadcastOnlineUsers();

        console.log(
            "User disconnected:",
            socket.id,
            reason
        );
    });
});

// ==========================================
// SOCKET ERROR
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
// START SERVER
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
