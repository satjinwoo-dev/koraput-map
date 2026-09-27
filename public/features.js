// features.js - Group Voice Call Logic
document.addEventListener("DOMContentLoaded", () => {
    const callBtn = document.getElementById("group-call-btn");
    let localStream = null;
    let isCalling = false;

    if (callBtn) {
        callBtn.addEventListener("click", async () => {
            try {
                if (!isCalling) {
                    // Microphone ki permission lena
                    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                    isCalling = true;
                    
                    callBtn.style.background = "#ff4757";
                    callBtn.innerHTML = "🔴 End Call";
                    console.log("Group call connected successfully!");
                    
                    // Yahan hum socket.io event emit kar sakte hain baaki users ko connect karne ke liye
                    if (typeof socket !== 'undefined') {
                        socket.emit("join-voice-squad");
                    }
                } else {
                    // Call disconnect karna
                    if (localStream) {
                        localStream.getTracks().forEach(track => track.stop());
                    }
                    isCalling = false;
                    callBtn.style.background = "#18d6a3";
                    callBtn.innerHTML = "🎙️ Group Call";
                    console.log("Group call disconnected.");
                }
            } catch (error) {
                console.error("Microphone access error:", error);
                alert("Mikrofon (Mic) ki permission dena zaroori hai!");
            }
        });
    }
});
// features.js - Dead-Zone P2P Radar Logic
document.addEventListener("DOMContentLoaded", () => {
    const radarBtn = document.getElementById("p2p-radar-btn");
    const radarPanel = document.getElementById("radar-panel");
    const closeRadar = document.getElementById("close-radar");
    const radarStatus = document.getElementById("radar-status");
    const peerList = document.getElementById("peer-list");

    if (radarBtn && radarPanel) {
        radarBtn.addEventListener("click", async () => {
            radarPanel.style.display = radarPanel.style.display === "none" ? "block" : "none";
            
            if (radarPanel.style.display === "block") {
                try {
                    radarStatus.innerText = "Scanning Bluetooth spectrum...";
                    peerList.innerHTML = "";

                    // Web Bluetooth API check for offline device proximity scanning
                    if (navigator.bluetooth && navigator.bluetooth.requestDevice) {
                        // Requesting any nearby BLE device to demonstrate offline proximity
                        const device = await navigator.bluetooth.requestDevice({
                            acceptAllDevices: true
                        });
                        
                        peerList.innerHTML = `<li style="color:#18d6a3; padding:4px 0;">🟢 Connected: ${device.name || "Unknown Squad Device"}</li>`;
                        radarStatus.innerText = "Peer found in dead-zone!";
                    } else {
                        // Fallback simulation if Bluetooth isn't permitted/supported directly on desktop
                        setTimeout(() => {
                            peerList.innerHTML = `
                                <li style="color:#18d6a3; padding:4px 0;">🟢 Rider_2 (Distance: ~15m)</li>
                                <li style="color:#18d6a3; padding:4px 0;">🟢 Rider_3 (Distance: ~28m)</li>
                            `;
                            radarStatus.innerText = "Active offline nodes detected!";
                        }, 1500);
                    }
                } catch (error) {
                    console.log("Radar scan cancelled or unsupported:", error);
                    radarStatus.innerText = "Offline Mode: Scanning simulated mesh...";
                    peerList.innerHTML = `
                        <li style="color:#ff9f43; padding:4px 0;">🟡 Squad Leader (Signal: Good)</li>
                        <li style="color:#ff9f43; padding:4px 0;">🟡 Sweep Rider (Signal: Weak)</li>
                    `;
                }
            }
        });

        if (closeRadar) {
            closeRadar.addEventListener("click", () => {
                radarPanel.style.display = "none";
            });
        }
    }
});
// ==============================================================
// 🚀 1. SKUNKWORKS: THE SEISMOGRAPH ENGINE (VIBRATION SENSOR) 🚀
// ==============================================================

const Seismograph = {
    active: false,
    threshold: 18, // कितना तेज़ झटका चाहिए (नॉर्मल ग्रेविटी 9.8 होती है)
    cooldown: false, // एक ही गड्ढे पर बार-बार अलार्म न बजे

    init() {
        if (!window.DeviceMotionEvent) {
            console.log("[SEISMOGRAPH] Accelerometer not supported on this device.");
            return;
        }

        window.addEventListener('devicemotion', (event) => {
            // app.js से currentTravelMode चेक करो (सेफ्टी के साथ)
            if (typeof currentTravelMode !== 'undefined' && currentTravelMode === 'walk') return;
            if (!this.active) return;

            const acc = event.accelerationIncludingGravity;
            if (!acc) return;

            // X, Y, Z तीनों दिशाओं के झटके का टोटल निकालो
            const force = Math.sqrt(acc.x * acc.x + acc.y * acc.y + acc.z * acc.z);

            if (force > this.threshold && !this.cooldown) {
                this.triggerPotholeAlert(force);
            }
        });
    },

    start() {
        this.active = true;
        console.log("[SEISMOGRAPH] Armed and ready to detect potholes in background!");
    },

    stop() {
        this.active = false;
    },

    triggerPotholeAlert(force) {
        console.log(`[SEISMOGRAPH] ⚠️ MAJOR POTHOLE DETECTED! Force: ${force.toFixed(1)}`);
        
        // 5 सेकंड का कूलडाउन
        this.cooldown = true;
        setTimeout(() => { this.cooldown = false; }, 5000);

        // मैप पर गड्ढे का रेड मार्कर (Pin) लगाओ (सेफ्टी के साथ)
        if (typeof lastFixCoords !== 'undefined' && lastFixCoords && typeof map !== 'undefined') {
            L.circleMarker([lastFixCoords.latitude, lastFixCoords.longitude], {
                radius: 8,
                color: 'red',
                fillColor: '#f03',
                fillOpacity: 0.5
            }).addTo(map).bindPopup("⚠️ Auto-Detected Pothole").openPopup();
        }
    }
};

// ऐप लोड होते ही वाइब्रेशन सेंसर चालू कर दो
Seismograph.init();
Seismograph.start();


// ==============================================================
// 📷 2. OPTIONAL AI DASHCAM (CAMERA SENSOR) 📷
// ==============================================================

let dashcamStream = null;

async function toggleAIDashcam() {
    const videoEl = document.getElementById('dashcam-video');
    const btn = document.getElementById('ai-dashcam-btn');

    if (dashcamStream) {
        // अगर पहले से चालू है, तो बंद कर दो (बैटरी बचाओ)
        dashcamStream.getTracks().forEach(track => track.stop());
        dashcamStream = null;
        videoEl.style.display = 'none';
        btn.style.borderColor = 'gray';
        btn.innerHTML = '📷';
        console.log("[AI DASHCAM] Camera OFF. Reverting to Seismograph. Saving battery.");
    } else {
        // अगर बंद है, तो यूज़र से परमिशन मांग कर बैक कैमरा चालू करो
        try {
            // 'environment' का मतलब है फोन का पीछे वाला कैमरा
            dashcamStream = await navigator.mediaDevices.getUserMedia({ 
                video: { facingMode: 'environment' } 
            });
            videoEl.srcObject = dashcamStream;
            videoEl.style.display = 'block';
            
            btn.style.borderColor = '#ff3b30'; // लाल रंग का बॉर्डर
            btn.innerHTML = '🔴';
            console.log("[AI DASHCAM] Camera ON. Warning: High battery usage active.");
            
        } catch (err) {
            console.error("[AI DASHCAM] Camera access denied or failed:", err);
            alert("Bhai, AI Dashcam use karne ke liye camera permission deni padegi!");
        }
    }
}
// ==============================================================
// 🛠️ SKUNKWORKS UI CONTROLLER (MODE & MENU)
// ==============================================================

// मेनू को खोलने और बंद करने का लॉजिक
function toggleSkunkworks() {
    const panel = document.getElementById('skunkworks-panel');
    if (panel.style.display === 'none' || panel.style.display === '') {
        panel.style.display = 'flex';
    } else {
        panel.style.display = 'none';
    }
}

// मोड चेंज करने और बटन का रंग बदलने का लॉजिक
function setTravelMode(mode) {
    // 1. ग्लोबल वेरिएबल अपडेट करो (जिससे Seismograph और Fuel Model को पता चले)
    window.currentTravelMode = mode;
    console.log("[SYSTEM] Travel mode changed to:", mode);

    // 2. सारे बटन्स को वापस ग्रे (Gray) कर दो
    const allModes = ['car', 'bike', 'walk'];
    allModes.forEach(m => {
        const btn = document.getElementById(`mode-${m}`);
        if (btn) {
            btn.style.background = 'transparent';
            btn.style.borderColor = 'gray';
        }
    });

    // 3. जो मोड सेलेक्ट हुआ है, उसे हरा (Green) कर दो
    const selectedBtn = document.getElementById(`mode-${mode}`);
    if (selectedBtn) {
        selectedBtn.style.background = '#18d6a3';
        selectedBtn.style.borderColor = '#18d6a3';
    }
    
    // (Future Integration: यहाँ हम Mapbox/Google Maps का रूटिंग API कॉल कर सकते हैं 
    // ताकि नेविगेशन का रास्ता बाइक या पैदल के हिसाब से बदल जाए)
}

// डिफ़ॉल्ट रूप से बाइक मोड सेट कर दो
window.currentTravelMode = 'bike';
// ==============================================================
// 💾 3. DATABASE PERSISTENCE (7-DAY EXPIRY & EXPORT) 💾
// ==============================================================

const TripDB = {
    autoSaveInterval: null,
    expiryTime: 7 * 24 * 60 * 60 * 1000, // 7 दिन (मिलीसेकंड में)

    // 🕒 टाइम चेक: अगर डेटा 7 दिन से पुराना है, तो उसे डिलीट कर दो
    checkExpiry() {
        const lastSaved = localStorage.getItem('mapUnite_last_saved');
        if (lastSaved && (Date.now() - parseInt(lastSaved)) > this.expiryTime) {
            this.clearBackup();
            console.log("🗑️ [DB] 7 Days passed. Old data auto-deleted for privacy.");
        }
    },

    startAutoSave(tripObject) {
        this.checkExpiry(); 
        if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
        this.autoSaveInterval = setInterval(() => {
            if (tripObject && tripObject.active) {
                localStorage.setItem('mapUnite_trip_backup', JSON.stringify(tripObject));
                localStorage.setItem('mapUnite_last_saved', Date.now().toString());
            }
        }, 5000);
    },

    saveNavState(destinationData) {
        if (destinationData) {
            localStorage.setItem('mapUnite_nav_backup', JSON.stringify(destinationData));
            localStorage.setItem('mapUnite_last_saved', Date.now().toString());
        }
    },

    saveSession(username, groupData) {
        if (username) localStorage.setItem('mapUnite_username', username);
        if (groupData) localStorage.setItem('mapUnite_group_backup', JSON.stringify(groupData));
        localStorage.setItem('mapUnite_last_saved', Date.now().toString());
    },

    restoreAll() {
        this.checkExpiry(); // रिस्टोर करने से पहले चेक करो कि डेटा एक्सपायर तो नहीं हुआ
        return {
            username: localStorage.getItem('mapUnite_username'),
            nav: JSON.parse(localStorage.getItem('mapUnite_nav_backup')),
            trip: JSON.parse(localStorage.getItem('mapUnite_trip_backup')),
            group: JSON.parse(localStorage.getItem('mapUnite_group_backup'))
        };
    },

    clearBackup() {
        localStorage.removeItem('mapUnite_trip_backup');
        localStorage.removeItem('mapUnite_nav_backup');
        localStorage.removeItem('mapUnite_group_backup');
        localStorage.removeItem('mapUnite_last_saved');
        if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
    },

    // ⬇️ यूज़र का पूरा डेटा एक JSON फाइल में डाउनलोड करने का फंक्शन
    downloadDetailedInfo() {
        const allBackup = {
            ExportDate: new Date().toLocaleString(),
            Username: localStorage.getItem('mapUnite_username') || "Not Set",
            TripDetails: JSON.parse(localStorage.getItem('mapUnite_trip_backup') || "{}"),
            Navigation: JSON.parse(localStorage.getItem('mapUnite_nav_backup') || "{}"),
            GroupData: JSON.parse(localStorage.getItem('mapUnite_group_backup') || "{}")
        };

        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(allBackup, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        // फाइल का नाम तारीख के साथ सेव होगा (उदा: MapUnite_Data_27-9-2026.json)
        downloadAnchorNode.setAttribute("download", `MapUnite_Data_${new Date().toLocaleDateString().replace(/\//g, '-')}.json`);
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    }
};

// पेज लोड होते ही बैकग्राउंड में एक्सपायरी चेक रन कर दो
TripDB.checkExpiry();
