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
