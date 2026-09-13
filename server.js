const express = require('express');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Increase max payload size to 10MB (1e7 bytes) for high-res photos
const io = require('socket.io')(server, {
    maxHttpBufferSize: 1e7
});

// Serve static files from 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Temporary storage for memory photos (in-memory array)
const memoryPhotos = [];

io.on('connection', (socket) => {
    console.log(`User Connected: ${socket.id}`);

    // Naye user ke connect hote hi use purani saari saved photos bhej do
    socket.emit('loadMemoryPhotos', memoryPhotos);

    // Real-Time Location Tracking & Sync
    socket.on('updateLocation', (data) => {
        socket.broadcast.emit('friendMoved', { 
            id: socket.id, 
            lat: data.lat, 
            lng: data.lng, 
            avatar: data.avatar, 
            weather: data.weather 
        });
    });

    // Real-time Chat Message Broadcast
    socket.on('chatMessage', (msg) => {
        io.emit('chatMessage', msg);
    });

    // Geo-tagged Memory Photo Upload & Broadcast & Save
    socket.on('uploadMemoryPhoto', (data) => {
        const newPin = {
            id: socket.id,
            name: data.name,
            lat: data.lat,
            lng: data.lng,
            image: data.image,
            time: data.time
        };
        
        // Array mein save karo taaki refresh hone par bhi rahe
        memoryPhotos.push(newPin);

        // Sabhi ko broadcast karo
        io.emit('newMemoryPin', newPin);
    });

    socket.on('disconnect', () => {
        io.emit('friendDisconnected', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT} (10MB Payload Limit Active)`);
});
