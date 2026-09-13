// Initialize Socket.io connection
const socket = io();

let myName = "Explorer";
let myAvatar = 'friend1.png';

// Initialize Leaflet Map (initially hidden or behind modal)
const map = L.map('map').setView([18.8121, 82.7135], 14);

// Google Maps Satellite / Hybrid Layer (Google Earth style)
const googleHybrid = L.tileLayer('https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    attribution: '&copy; Google Maps'
});
googleHybrid.addTo(map);

// Handle Join Map Form submission
const joinBtn = document.getElementById('join-btn'); // Jo bhi button ki id ho
const nameInput = document.getElementById('name-input'); // Name input field ki id
const loginModal = document.getElementById('login-modal'); // Modal ki id

// Agar aapke HTML mein join form hai, toh yeh use handle karega:
document.getElementById('join-map-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    myName = document.getElementById('username').value || "Explorer";
    
    // Hide modal
    const modal = document.getElementById('join-modal');
    if (modal) modal.style.display = 'none';

    // Start geolocation after joining
    initTracking();
});
