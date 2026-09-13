const express = require('express');
const app = express();
const http = require('http').createServer(app);

// Increase max payload size to 10MB (1e7 bytes)
const io = require('socket.io')(http, {
    maxHttpBufferSize: 1e7
});

app.use(express.static('public'));

io.on('connection', (socket) => {
    socket.on('updateLocation', (data) => {
        socket.broadcast.emit('friendMoved', { id: socket.id, ...data });
    });

    socket.on('chatMessage', (data) => {
        io.emit('chatMessage', data);
    });
// Geo-tagged Memory Photo Upload & Broadcast
    socket.on('uploadMemoryPhoto', (data) => {
        io.emit('newMemoryPin', {
            id: socket.id,
            name: data.name,
            lat: data.lat,
            lng: data.lng,
            image: data.image,
            time: data.time
        });
    });
    socket.on('disconnect', () => {
        io.emit('friendDisconnected', socket.id);
    });
});

http.listen(3000, () => {
    console.log('Server running on port 3000 (10MB Payload Limit Active)');
});
