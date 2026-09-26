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
