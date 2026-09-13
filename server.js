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


const memoryPhotos = [];


// ==========================================
// SOCKET CONNECTION
// ==========================================

io.on(
    "connection",
    socket => {

        console.log(
            `User Connected: ${socket.id}`
        );


        // Send existing memories

        socket.emit(
            "loadMemoryPhotos",
            memoryPhotos
        );


        // ==================================
        // LOCATION
        // ==================================

        socket.on(
            "updateLocation",
            data => {

                if (
                    !data ||
                    typeof data !==
                        "object"
                ) {
                    return;
                }


                const lat =
                    Number(data.lat);

                const lng =
                    Number(data.lng);


                if (
                    !Number.isFinite(lat) ||
                    !Number.isFinite(lng) ||
                    lat < -90 ||
                    lat > 90 ||
                    lng < -180 ||
                    lng > 180
                ) {
                    return;
                }


                const name =
                    typeof data.name ===
                    "string"
                        ? data.name
                              .slice(
                                  0,
                                  40
                              )
                        : "Friend";


                const avatar =
                    typeof data.avatar ===
                    "string"
                        ? data.avatar
                        : "";


                const weather =
                    typeof data.weather ===
                    "string"
                        ? data.weather
                              .slice(
                                  0,
                                  50
                              )
                        : "";


                socket.broadcast.emit(
                    "friendMoved",
                    {
                        id:
                            socket.id,

                        name,

                        lat,

                        lng,

                        avatar,

                        weather
                    }
                );
            }
        );


        // ==================================
        // CHAT
        // ==================================

        socket.on(
            "chatMessage",
            msg => {

                if (
                    !msg ||
                    typeof msg !==
                        "object"
                ) {
                    return;
                }


                const allowedTypes = [
                    "text",
                    "image",
                    "video",
                    "audio",
                    "document"
                ];


                if (
                    !allowedTypes.includes(
                        msg.type
                    )
                ) {
                    return;
                }


                if (
                    typeof msg.name !==
                        "string" ||
                    typeof msg.data !==
                        "string"
                ) {
                    return;
                }


                const cleanMessage = {

                    name:
                        msg.name.slice(
                            0,
                            40
                        ),

                    type:
                        msg.type,

                    data:
                        msg.data
                };


                io.emit(
                    "chatMessage",
                    cleanMessage
                );
            }
        );


        // ==================================
        // MEMORY PHOTO
        // ==================================

        socket.on(
            "uploadMemoryPhoto",
            data => {

                if (
                    !data ||
                    typeof data !==
                        "object"
                ) {
                    return;
                }


                const lat =
                    Number(data.lat);

                const lng =
                    Number(data.lng);


                if (
                    !Number.isFinite(lat) ||
                    !Number.isFinite(lng) ||
                    lat < -90 ||
                    lat > 90 ||
                    lng < -180 ||
                    lng > 180
                ) {
                    return;
                }


                if (
                    typeof data.image !==
                        "string" ||
                    !data.image.startsWith(
                        "data:image/"
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


                const newPin = {

                    id:
                        `${socket.id}-${Date.now()}`,

                    name:
                        typeof data.name ===
                        "string"
                            ? data.name.slice(
                                  0,
                                  40
                              )
                            : "Memory",

                    lat,

                    lng,

                    image:
                        data.image,

                    time:
                        typeof data.time ===
                        "string"
                            ? data.time.slice(
                                  0,
                                  100
                              )
                            : ""
                };


                memoryPhotos.push(
                    newPin
                );


                // Keep only latest 100

                if (
                    memoryPhotos.length >
                    100
                ) {

                    memoryPhotos.shift();
                }


                io.emit(
                    "newMemoryPin",
                    newPin
                );
            }
        );


        // ==================================
        // DISCONNECT
        // ==================================

        socket.on(
            "disconnect",
            () => {

                console.log(
                    `User Disconnected: ${socket.id}`
                );


                io.emit(
                    "friendDisconnected",
                    socket.id
                );
            }
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
