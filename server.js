const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. IN-MEMORY DATABASE (State Management)
// ==========================================
const users = new Map(); 
const chatMessages = []; 
const memories = []; 
let geofences = []; 
let currentTrip = null; 

// Helper to generate unique IDs
const generateId = () => Math.random().toString(36).substr(2, 9);

// Distance Calculator for Geofence Alerts
function distanceKm(lat1, lon1, lat2, lon2) {
    const p = Math.PI / 180;
    const a = 0.5 - Math.cos((lat2 - lat1) * p) / 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin((lon2 - lon1) * p / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
}

// ==========================================
// 2. SOCKET.IO EVENT HANDLERS
// ==========================================
io.on('connection', (socket) => {
    console.log(`🟢 New Connection: ${socket.id}`);

    // --- A. PROFILE & INITIALIZATION ---
    socket.on('profileReady', (userData) => {
        const user = { ...userData, id: socket.id, online: true };
        users.set(socket.id, user);

        // Send all current states to the newly joined user
        socket.emit('chatHistory', chatMessages);
        socket.emit('loadMemoryPhotos', memories);
        socket.emit('loadGeofences', geofences);
        socket.emit('onlineUsers', Array.from(users.values()));
        if (currentTrip) socket.emit('tripData', currentTrip);

        // Tell everyone else this user is online
        socket.broadcast.emit('userOnline', user);
    });

    // --- B. LIVE LOCATION UPDATES & GEOFENCE CHECK ---
    socket.on('updateLocation', (data) => {
        if (!users.has(socket.id)) return;
        
        const user = users.get(socket.id);
        const oldLat = user.lat;
        const oldLng = user.lng;
        
        user.lat = data.lat;
        user.lng = data.lng;
        user.weather = data.weather;
        users.set(socket.id, user);

        socket.broadcast.emit('friendMoved', user);

        // Geofence Intersection check
        if (oldLat && oldLng) {
            geofences.forEach(fence => {
                const distOld = distanceKm(oldLat, oldLng, fence.lat, fence.lng) * 1000; 
                const distNew = distanceKm(user.lat, user.lng, fence.lat, fence.lng) * 1000; 

                const wasOutside = distOld > fence.radius;
                const isInside = distNew <= fence.radius;

                if (wasOutside && isInside) {
                    io.emit('geofenceAlert', { user: user.name, fence: fence.name, type: 'enter' });
                } else if (!wasOutside && !isInside) {
                    io.emit('geofenceAlert', { user: user.name, fence: fence.name, type: 'leave' });
                }
            });
        }
    });

    // --- C. CHAT SYSTEM ---
    socket.on('chatMessage', (msgData) => {
        const msg = {
            ...msgData,
            id: generateId(),
            senderId: socket.id,
            time: new Date().toISOString(), 
            reactions: { "👍": [], "❤️": [], "😂": [], "😮": [], "😢": [], "🔥": [] }
        };
        
        chatMessages.push(msg);
        if (chatMessages.length > 200) chatMessages.shift(); 
        io.emit('chatMessage', msg);
    });

    socket.on('typing', (isTyping) => {
        if (users.has(socket.id)) {
            socket.broadcast.emit('typing', { id: socket.id, name: users.get(socket.id).name, isTyping });
        }
    });

    socket.on('messageReaction', (data) => {
        const msg = chatMessages.find(m => m.id === data.messageId);
        if (msg) {
            const userIndex = msg.reactions[data.emoji].indexOf(socket.id);
            if (userIndex > -1) {
                msg.reactions[data.emoji].splice(userIndex, 1);
            } else {
                Object.keys(msg.reactions).forEach(e => {
                    const idx = msg.reactions[e].indexOf(socket.id);
                    if(idx > -1) msg.reactions[e].splice(idx, 1);
                });
                msg.reactions[data.emoji].push(socket.id);
            }
            io.emit('messageReaction', { messageId: msg.id, reactions: msg.reactions });
        }
    });

    // --- D. GEOFENCING SYSTEM ---
    socket.on('addGeofence', (data) => {
        const user = users.get(socket.id);
        if(!user) return;

        const newFence = {
            id: generateId(),
            name: data.name,
            lat: data.lat,
            lng: data.lng,
            radius: data.radius,
            ownerId: socket.id,
            ownerName: user.name
        };
        geofences.push(newFence);
        io.emit('loadGeofences', geofences);
    });

    socket.on('removeGeofence', (id) => {
        const fence = geofences.find(f => f.id === id);
        if (fence && fence.ownerId === socket.id) {
            geofences = geofences.filter(f => f.id !== id);
            io.emit('loadGeofences', geofences);
        }
    });

    // --- E. GROUP TRIP SYSTEM ---
    socket.on('startTrip', (data) => {
        const user = users.get(socket.id);
        if(!user) return;

        currentTrip = {
            name: data.name,
            lat: data.lat,
            lng: data.lng,
            hostId: socket.id,
            members: [{ id: socket.id, name: user.name }]
        };
        io.emit('tripData', currentTrip);
    });

    socket.on('joinTrip', () => {
        const user = users.get(socket.id);
        if (currentTrip && user && !currentTrip.members.some(m => m.id === socket.id)) {
            currentTrip.members.push({ id: socket.id, name: user.name });
            io.emit('tripData', currentTrip);
        }
    });

    socket.on('leaveTrip', () => {
        if (!currentTrip) return;

        if (currentTrip.hostId === socket.id) {
            currentTrip = null;
            io.emit('tripData', null);
        } else {
            currentTrip.members = currentTrip.members.filter(m => m.id !== socket.id);
            io.emit('tripData', currentTrip);
        }
    });

    // --- F. MEMORIES ---
    socket.on('uploadMemoryPhoto', (data) => {
        const memory = {
            id: generateId(),
            name: data.name,
            lat: data.lat,
            lng: data.lng,
            image: data.image,
            time: data.time || new Date().toISOString() 
        };
        memories.push(memory);
        io.emit('newMemoryPin', memory);
    });

    // --- G. VOICE CALLING SIGNALS (NEW) ---
    socket.on("call-user", data => {
        io.to(data.to).emit("incoming-call", { signal: data.signal, from: socket.id, name: data.name });
    });

    socket.on("answer-call", data => {
        io.to(data.to).emit("call-accepted", data.signal);
    });

    socket.on("end-call", data => {
        io.to(data.to).emit("call-ended");
    });

    // --- H. DISCONNECT LOGIC ---
    socket.on('disconnect', () => {
        console.log(`🔴 Disconnected: ${socket.id}`);
        if (users.has(socket.id)) {
            const user = users.get(socket.id);
            user.online = false;
            
            io.emit('userOffline', { id: socket.id });
            io.emit('friendDisconnected', socket.id);
            
            if (currentTrip) {
                if (currentTrip.hostId === socket.id) {
                    currentTrip = null; 
                    io.emit('tripData', null);
                } else {
                    currentTrip.members = currentTrip.members.filter(m => m.id !== socket.id);
                    io.emit('tripData', currentTrip);
                }
            }

            setTimeout(() => {
                users.delete(socket.id);
            }, 5000);
        }
    });
});

// ==========================================
// 3. START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Map Server is running on http://localhost:${PORT}`);
});
