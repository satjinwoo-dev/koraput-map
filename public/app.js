"use strict";

const socket = io({ transports: ["websocket", "polling"] });

// ==========================================
// CONSTANTS & STATE
// ==========================================
const DEFAULT_CENTER = [18.8136, 82.7153];
const DEFAULT_ZOOM = 13;
const DEFAULT_AVATAR = "satyam.png";
const MAX_NAME = 40;
const MAX_CHAT = 1000;
const MAX_CHAT_FILE = 5 * 1024 * 1024;
const MAX_MEMORY_FILE = 8 * 1024 * 1024;
const MAX_AVATAR_FILE = 3 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

let ownMarker = null;
let accuracyCircle = null;
let firstFix = true;
let myCoords = null;
let myWeather = "";
let cityName = "";
let currentStyle = "satellite";

const friendMarkers = Object.create(null);
const friendData = Object.create(null);

// Phase 3 Memories State
const memories = new Map();
let currentGalleryFilter = "all";
let currentGallerySearch = "";
let selectedMemoryId = null;

let currentUser = { 
    name: localStorage.getItem("koraput_name") || "", 
    avatar: localStorage.getItem("koraput_avatar") || DEFAULT_AVATAR 
};

// ==========================================
// UTILITY FUNCTIONS
// ==========================================
const $ = id => document.getElementById(id);
const escapeHTML = v => String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
const cleanName = v => String(v || "User").trim().replace(/\s+/g," ").slice(0, MAX_NAME);
const validCoord = (lat,lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat>=-90 && lat<=90 && lng>=-180 && lng<=180;
const validImageData = v => typeof v === "string" && /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(v);
const validMediaData = v => typeof v === "string" && /^data:(image|video|audio|application|text)\//i.test(v);

function distanceKm(a,b,c,d){
    if(!validCoord(a,b) || !validCoord(c,d)) return "";
    const R=6371, p=Math.PI/180, dLat=(c-a)*p, dLon=(d-b)*p;
    const x=Math.sin(dLat/2)**2 + Math.cos(a*p)*Math.cos(c*p)*Math.sin(dLon/2)**2;
    return (R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x))).toFixed(1);
}

function weatherEmoji(code){
    if(code===0) return "☀️"; if([1,2,3].includes(code)) return "⛅"; if([45,48].includes(code)) return "🌫️";
    if([51,53,55,56,57,61,63,65,66,67].includes(code)) return "🌧️"; if([71,73,75,77,85,86].includes(code)) return "❄️";
    if([80,81,82].includes(code)) return "🌦️"; if([95,96,99].includes(code)) return "⛈️"; return "🌤️";
}

async function fetchWeather(lat,lng){
    try {
        const r=await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&current=temperature_2m,weather_code`);
        if(!r.ok) return ""; const d=await r.json();
        const t=Number(d?.current?.temperature_2m), code=Number(d?.current?.weather_code);
        return Number.isFinite(t) ? `${weatherEmoji(code)} ${Math.round(t)}°C` : "";
    } catch { return ""; }
}

async function fetchCity(lat,lng){
    try {
        const r=await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=10`);
        if(!r.ok) return ""; const d=await r.json();
        return d.address?.city||d.address?.town||d.address?.county||"Rourkela";
    } catch { return "Rourkela"; }
}

function ownIcon() { return L.icon({ iconUrl: currentUser.avatar, iconSize: [36,36], iconAnchor: [18,18], className: "avatar-icon own-live-avatar" }); }
function friendIcon(avatar) { return L.icon({ iconUrl: avatar || DEFAULT_AVATAR, iconSize: [34,34], iconAnchor: [17,17], className: "avatar-icon friend-marker" }); }

// ==========================================
// MAP INITIALIZATION
// ==========================================
const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
const satelliteLayer = L.tileLayer("https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}", { maxZoom: 20, subdomains: ["mt0","mt1","mt2","mt3"], attribution: "&copy; Google Maps" });
const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OSM" });
const darkLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 20, attribution: "&copy; CARTO" });
satelliteLayer.addTo(map);

const memoryLayer = L.layerGroup().addTo(map);

// ==========================================
// CORE LOCATION LOGIC
// ==========================================
socket.on("connect", () => {
    if (currentUser.name) socket.emit("profileReady", currentUser);
});

function emitLocation(){
    if(!myCoords || !currentUser.name) return;
    socket.emit("updateLocation",{name:currentUser.name, avatar:currentUser.avatar, lat:myCoords.lat, lng:myCoords.lng, weather:myWeather});
}

function updateFriendBadges(){
    if(!myCoords) return;
    Object.keys(friendMarkers).forEach(id=>{
        const f=friendData[id], m=friendMarkers[id]; if(!f||!m) return;
        let text = f.online===false ? "Offline" : (f.weather||"");
        const d = distanceKm(myCoords.lat, myCoords.lng, f.lat, f.lng);
        if(d) text += `${text?" | ":""}📍 ${d} km`;
        m.unbindTooltip(); if(text) m.bindTooltip(text,{permanent:true,direction:"right",className:"weather-badge",offset:[15,0]});
    });
}

function startGPS(){
    if(!navigator.geolocation) return console.warn("Geolocation disabled.");
    navigator.geolocation.watchPosition(async p=>{
        const lat=Number(p.coords.latitude), lng=Number(p.coords.longitude), acc=Number(p.coords.accuracy);
        if(!validCoord(lat,lng)) return;
        myCoords={lat,lng};

        if(Number.isFinite(acc) && acc>0 && acc<100000){
            if(!accuracyCircle) accuracyCircle=L.circle([lat,lng],{radius:acc,color:"#10b981",weight:2,opacity:.85,fillColor:"#10b981",fillOpacity:.15,interactive:false}).addTo(map);
            else {accuracyCircle.setLatLng([lat,lng]); accuracyCircle.setRadius(acc);}
        }

        if(!ownMarker){
            ownMarker = L.marker([lat,lng],{icon:ownIcon(),zIndexOffset:1000}).addTo(map);
            if(firstFix){map.setView([lat,lng],16); firstFix=false;}
        } else ownMarker.setLatLng([lat,lng]).setIcon(ownIcon());

        if(!cityName){
            cityName = await fetchCity(lat,lng);
            if(cityName){ $("header-app-title").textContent=`${cityName} Map`; $("pill-city").textContent=`📍 ${cityName}`; }
        }

        const w = await fetchWeather(lat,lng);
        if(w){
            myWeather=w; $("map-temp-display").textContent=w;
            ownMarker.unbindTooltip(); ownMarker.bindTooltip(w,{permanent:true,direction:"right",className:"weather-badge",offset:[15,0]});
        }
        emitLocation(); updateFriendBadges();
    }, e=>console.warn("GPS error",e), {enableHighAccuracy:true,timeout:15000,maximumAge:3000});
}

// ==========================================
// FRIENDS & PROFILES
// ==========================================
function showFriendProfile(id){
    const f=friendData[id]; if(!f) return;
    $("profile-popup-avatar").src = f.avatar||DEFAULT_AVATAR;
    $("profile-popup-name").textContent = f.name||"Friend";
    const st = $("profile-popup-status");
    if(f.online!==false){ st.textContent="● Online"; st.style.color="#18d6a3"; } else { st.textContent="● Offline"; st.style.color="#8fa1aa"; }
    const d = myCoords ? distanceKm(myCoords.lat,myCoords.lng,f.lat,f.lng) : "";
    $("profile-popup-distance").textContent = d ? `📍 ${d} km away` : "📍 Location unavailable";
    $("profile-popup-weather").textContent = f.weather || "Weather unavailable";
    $("profile-popup").style.display="flex";
    $("profile-focus-btn").onclick=()=>{ if(validCoord(f.lat,f.lng)) map.flyTo([f.lat,f.lng],16,{animate:true}); $("profile-popup").style.display="none"; };
}

function renderOnlineList(){
    const box=$("online-list"); if(!box) return; box.innerHTML="";
    const active=Object.values(friendData).filter(f=>f.online!==false);
    if(!active.length){box.innerHTML=`<div style="color:#91a2ab;font-size:12px;padding:5px 0;">No friends online</div>`; return;}
    active.forEach(u=>{
        const btn=document.createElement("button"); btn.className="online-friend";
        btn.innerHTML=`<img src="${escapeHTML(u.avatar||DEFAULT_AVATAR)}"><span><b>${escapeHTML(u.name)}</b></span><div class="status-dot"></div>`;
        btn.onclick=()=>{ if(validCoord(u.lat,u.lng)){map.flyTo([u.lat,u.lng],16); showFriendProfile(u.id);} };
        box.appendChild(btn);
    });
}

function updateOnlineCount(){
    let c=0; Object.values(friendData).forEach(f=>{if(f.online!==false) c++;});
    const tot = currentUser.name ? c+1 : c;
    ["header-online-status","chat-subtitle"].forEach(i=>{if($(i)) $(i).textContent=`${tot} online`;});
}

function createOrUpdateFriendMarker(u){
    if(!u?.id || !validCoord(u.lat,u.lng)) return;
    const av = validImageData(u.avatar)?u.avatar:DEFAULT_AVATAR;
    friendData[u.id] = { id:u.id, name:cleanName(u.name), avatar:av, lat:Number(u.lat), lng:Number(u.lng), weather:u.weather||"", online:u.online!==false };
    let m = friendMarkers[u.id];
    if(!m){ m=L.marker([u.lat,u.lng],{icon:friendIcon(av)}).addTo(map); m.on("click",()=>showFriendProfile(u.id)); friendMarkers[u.id]=m; }
    else { m.setLatLng([u.lat,u.lng]).setIcon(friendIcon(av)); m.setOpacity(u.online===false?0.45:1); }
    updateFriendMarkerTooltip(u.id);
}

function updateFriendMarkerTooltip(id){
    const m=friendMarkers[id], f=friendData[id]; if(!m||!f) return;
    let b=f.weather||""; if(myCoords&&validCoord(f.lat,f.lng)){const d=distanceKm(myCoords.lat,myCoords.lng,f.lat,f.lng); if(d) b+=`${b?" | ":""}📍 ${d} km`;}
    m.unbindTooltip(); if(b) m.bindTooltip(b,{permanent:true,direction:"right",className:"weather-badge",offset:[15,0]});
}

socket.on("onlineUsers", list=>{ if(Array.isArray(list)) list.forEach(u=>{ if(u.id!==socket.id){ friendData[u.id]={...(friendData[u.id]||{}),...u,online:true}; createOrUpdateFriendMarker(u);} }); updateOnlineCount(); renderOnlineList(); });
socket.on("userOnline", u=>{ if(u.id!==socket.id){ friendData[u.id]={...(friendData[u.id]||{}),...u,online:true}; createOrUpdateFriendMarker(u); } updateOnlineCount(); renderOnlineList(); });
socket.on("userOffline", d=>{ if(d?.id && friendData[d.id]){ friendData[d.id].online=false; if(friendMarkers[d.id]) friendMarkers[d.id].setOpacity(0.45); } updateOnlineCount(); renderOnlineList(); });
socket.on("friendMoved", u=>{ if(u?.id && cleanName(u.name)!==currentUser.name) createOrUpdateFriendMarker({...u,online:true}); updateOnlineCount(); });
socket.on("friendDisconnected", id=>{ if(friendMarkers[id]){map.removeLayer(friendMarkers[id]); delete friendMarkers[id];} delete friendData[id]; updateOnlineCount(); renderOnlineList(); });

// ==========================================
// SETUP JOIN
// ==========================================
function setupJoin(){
    const sc=$("join-screen"), fm=$("join-form"), nameInp=$("nameInput"), avInp=$("avatarInput");
    if(currentUser.name){ sc.style.display="none"; $("header-avatar").src=currentUser.avatar; $("header-avatar").style.display="block"; socket.emit("profileReady",currentUser); }
    avInp?.addEventListener("change",()=>{ const f=avInp.files?.[0]; if(!f) return; if(!IMAGE_TYPES.includes(f.type)||f.size>MAX_AVATAR_FILE){alert("Invalid photo."); avInp.value=""; return;} $("avatar-label-text").textContent="Photo Selected ✓"; });
    fm?.addEventListener("submit",e=>{
        e.preventDefault(); const n=cleanName(nameInp.value); if(!n) return alert("Enter name.");
        currentUser.name=n; localStorage.setItem("koraput_name",n);
        const f=avInp.files?.[0];
        if(f){ const r=new FileReader(); r.onload=()=>{ if(validImageData(r.result)){currentUser.avatar=r.result; localStorage.setItem("koraput_avatar",r.result);} done(); }; r.readAsDataURL(f); } else done();
        function done(){ sc.style.display="none"; $("header-avatar").src=currentUser.avatar; $("header-avatar").style.display="block"; if(ownMarker) ownMarker.setIcon(ownIcon()); socket.emit("profileReady",currentUser); emitLocation(); updateOnlineCount(); setTimeout(()=>map.invalidateSize(),300); }
    });
}

// ==========================================
// MAP CONTROLS & COMPASS
// ==========================================
function setupMapControls(){
    $("my-location-btn")?.addEventListener("click",()=>{ if(myCoords) map.flyTo([myCoords.lat,myCoords.lng],Math.max(map.getZoom(),16),{animate:true}); else alert("Waiting for GPS..."); });
    $("compass-btn")?.addEventListener("click",()=>{ map.setView(map.getCenter(),map.getZoom(),{animate:true}); $("compass-icon").style.transform="rotate(0deg)"; });
    $("map-style-btn")?.addEventListener("click",e=>{ e.stopPropagation(); const m=$("map-style-menu"); m.style.display=m.style.display==="flex"?"none":"flex"; });
    $("map-style-menu")?.addEventListener("click",e=>{
        const b=e.target.closest("[data-style]"); if(!b) return; const s=b.dataset.style; if(s===currentStyle){ $("map-style-menu").style.display="none"; return; }
        [satelliteLayer,streetLayer,darkLayer].forEach(l=>{if(map.hasLayer(l)) map.removeLayer(l);});
        ({satellite:satelliteLayer,street:streetLayer,dark:darkLayer})[s].addTo(map); currentStyle=s;
        document.querySelectorAll("#map-style-menu button").forEach(x=>x.classList.toggle("active",x.dataset.style===s));
        $("map-style-menu").style.display="none"; setTimeout(()=>map.invalidateSize(),100);
    });
    document.addEventListener("click",e=>{ if($("map-style-menu") && !$("map-style-menu").contains(e.target) && e.target!==$("map-style-btn")) $("map-style-menu").style.display="none"; });

    // Compass Rotation Device Orientation
    if (typeof DeviceOrientationEvent !== "undefined") {
        window.addEventListener("deviceorientation", e => {
            const icon = $("compass-icon"); if (!icon) return;
            if (typeof e.webkitCompassHeading === "number") icon.style.transform = `rotate(${-e.webkitCompassHeading}deg)`;
            else if (typeof e.alpha === "number") icon.style.transform = `rotate(${e.alpha}deg)`;
        }, true);
    }
}

// ==========================================
// CHAT FUNCTIONALITY
// ==========================================
function setupChat(){
    const cc=$("chat-container"), inp=$("chatInput"), send=$("chat-send"), vb=$("voiceButton"), tb=$("chat-toggle-btn");
    let unread=0, typingTimer=null, isTyping=false, replyTo=null, reactingId=null;
    const msgStore=new Map(), emojis=["👍","❤️","😂","😮","😢","🔥"];

    function updateUnread(){ const b=$("chat-unread-badge"); b.textContent=unread>99?"99+":unread; b.style.display=unread>0?"flex":"none"; }
    tb.onclick=()=>{ if(cc.classList.contains("open")){cc.classList.remove("open");cc.style.display="none";}else{cc.classList.add("open");cc.style.display="flex";unread=0;updateUnread();inp.focus();} };
    $("chat-minimize-btn").onclick=()=>{cc.classList.remove("open");cc.style.display="none";};
    $("online-btn").onclick=()=>{const l=$("online-list"); l.style.display=l.style.display==="block"?"none":"block"; renderOnlineList();};

    inp.oninput=()=>{ if(!isTyping){isTyping=true;socket.emit("typing",true);} clearTimeout(typingTimer); typingTimer=setTimeout(()=>{isTyping=false;socket.emit("typing",false);},1200); send.style.display=inp.value.trim()?"flex":"none"; vb.style.display=inp.value.trim()?"none":"flex"; };
    socket.on("typing",d=>{ const ind=$("typing-indicator"); if(d?.id===socket.id)return; if(d.isTyping){ind.textContent=`${cleanName(d.name)} is typing…`;ind.style.display="block";}else ind.style.display="none"; });

    function beginReply(m){
        let p="Message"; if(m.type==="text") p=m.data.slice(0,100); else if(m.type==="image") p="📷 Photo"; else if(m.type==="video") p="🎥 Video"; else if(m.type==="audio") p="🎙️ Voice";
        replyTo={id:m.id, name:cleanName(m.name), type:m.type, preview:p}; $("reply-preview").textContent=`↩ ${replyTo.name}: ${replyTo.preview}`; $("reply-bar").style.display="flex"; inp.focus();
    }
    $("reply-cancel").onclick=()=>{replyTo=null; $("reply-bar").style.display="none";};

    $("emojiButton").onclick=e=>{e.stopPropagation();$("attachment-menu").style.display="none";$("emoji-picker-container").style.display=$("emoji-picker-container").style.display==="block"?"none":"block";};
    $("emojiPicker").addEventListener("emoji-click",e=>{
        const em=e.detail.unicode; if(!em) return;
        if(reactingId){socket.emit("messageReaction",{messageId:reactingId,emoji:em}); $("emoji-picker-container").style.display="none"; reactingId=null;}
        else {inp.value+=em; inp.focus(); inp.dispatchEvent(new Event("input"));}
    });
    window.reactTo=id=>{reactingId=id; $("attachment-menu").style.display="none"; $("emoji-picker-container").style.display="block";};

    $("chat-attach-btn").onclick=e=>{e.stopPropagation();$("emoji-picker-container").style.display="none";$("attachment-menu").style.display=$("attachment-menu").style.display==="flex"?"none":"flex";};
    document.addEventListener("click",e=>{ if($("attachment-menu")&&!$("attachment-menu").contains(e.target)&&e.target!==$("chat-attach-btn"))$("attachment-menu").style.display="none"; if($("emoji-picker-container")&&!$("emoji-picker-container").contains(e.target)&&e.target!==$("emojiButton"))$("emoji-picker-container").style.display="none"; });

    const fInp=$("chatFileInput");
    $("att-media").onclick=()=>{fInp.accept="image/*,video/*";fInp.click();$("attachment-menu").style.display="none";};
    $("att-doc").onclick=()=>{fInp.accept=".pdf,.doc,.docx,.txt,.zip";fInp.click();$("attachment-menu").style.display="none";};
    $("att-audio").onclick=()=>{fInp.accept="audio/*";fInp.click();$("attachment-menu").style.display="none";};
    fInp.onchange=()=>{
        const f=fInp.files?.[0]; if(!f) return; if(f.size>MAX_CHAT_FILE){alert("File too large (Max 5MB)"); fInp.value=""; return;}
        const r=new FileReader(); r.onload=()=>{
            let t="document"; if(f.type.startsWith("image/"))t="image"; else if(f.type.startsWith("video/"))t="video"; else if(f.type.startsWith("audio/"))t="audio";
            socket.emit("chatMessage",{name:currentUser.name,type:t,data:String(r.result),replyTo}); $("reply-cancel").click(); fInp.value="";
        }; r.readAsDataURL(f);
    };

    $("chatForm").onsubmit=e=>{
        e.preventDefault(); const t=inp.value.trim().slice(0,MAX_CHAT); if(!t)return;
        socket.emit("chatMessage",{name:currentUser.name,type:"text",data:t,replyTo}); inp.value=""; $("reply-cancel").click(); inp.dispatchEvent(new Event("input")); inp.focus();
    };

    function renderReactions(w,m){
        const c=w.querySelector(".reaction-row"); if(!c)return; c.innerHTML="";
        Object.keys(m.reactions||{}).forEach(e=>{ const list=m.reactions[e]; if(!list.length)return;
            const b=document.createElement("button"); b.type="button"; b.className="reaction-chip"; b.textContent=`${e} ${list.length}`;
            b.onclick=()=>socket.emit("messageReaction",{messageId:m.id,emoji:e}); c.appendChild(b);
        });
    }

    function renderMsg(m){
        if(!m||!m.id||msgStore.has(m.id)) return;
        const w=document.createElement("div"); w.className="chat-row"; w.dataset.id=m.id;
        const b=document.createElement("div"); const mine=m.senderId===socket.id; b.className=`chat-message ${mine?"msg-mine":"msg-theirs"}`;
        
        if(!mine){const s=document.createElement("div"); s.className="msg-sender"; s.textContent=cleanName(m.name); b.appendChild(s);}
        if(m.replyTo){const q=document.createElement("div"); q.className="reply-quote"; q.innerHTML=`<b>${escapeHTML(m.replyTo.name)}</b><br>${escapeHTML(m.replyTo.preview)}`; b.appendChild(q);}
        
        const c=document.createElement("div");
        if(m.type==="text") c.innerHTML=`<div class="message-text">${escapeHTML(m.data)}</div>`;
        else if(m.type==="image") c.innerHTML=`<img class="chat-media" src="${m.data}" loading="lazy">`;
        else if(m.type==="video") c.innerHTML=`<video class="chat-media" controls src="${m.data}"></video>`;
        else if(m.type==="audio") c.innerHTML=`<audio class="chat-audio" controls src="${m.data}"></audio>`;
        else if(m.type==="document") c.innerHTML=`<a class="chat-document" href="${m.data}" download="KoraputMap-File" target="_blank">📄 Download File</a>`;
        b.appendChild(c);

        if(m.time) {const d=new Date(m.time); const t=document.createElement("div"); t.className="message-meta"; t.textContent=d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}); b.appendChild(t);}
        
        const a=document.createElement("div"); a.className="message-actions";
        emojis.forEach(e=>{const btn=document.createElement("button"); btn.type="button"; btn.className="action-btn"; btn.textContent=e; btn.onclick=()=>socket.emit("messageReaction",{messageId:m.id,emoji:e}); a.appendChild(btn);});
        const rep=document.createElement("button"); rep.type="button"; rep.className="action-btn"; rep.textContent="↩ Reply"; rep.onclick=()=>beginReply(m); a.appendChild(rep);
        b.appendChild(a);

        const rr=document.createElement("div"); rr.className="reaction-row"; b.appendChild(rr);
        w.appendChild(b); $("chat-messages").appendChild(w); msgStore.set(m.id,{msg:m,el:w}); renderReactions(w,m);
        
        if(!mine && !cc.classList.contains("open")){unread++; updateUnreadBadge();}
        $("chat-messages").scrollTop=$("chat-messages").scrollHeight;
    }

    socket.on("chatHistory", l=>{if(Array.isArray(l)) l.forEach(renderMsg);});
    socket.on("chatMessage", renderMsg);
    socket.on("messageReaction", d=>{ const s=msgStore.get(String(d.messageId)); if(s){s.msg.reactions=d.reactions||{}; renderReactions(s.el,s.msg);} });
}

function setupVoice(){
    const vb=$("voiceButton"); if(!vb)return; let rec=null, chunks=[], isRec=false;
    vb.onclick=async()=>{
        if(isRec){rec?.stop();return;} if(!navigator.mediaDevices?.getUserMedia){alert("Mic not supported.");return;}
        try{
            const str=await navigator.mediaDevices.getUserMedia({audio:true}); chunks=[];
            let mt=MediaRecorder.isTypeSupported("audio/webm")?"audio/webm":(MediaRecorder.isTypeSupported("audio/mp4")?"audio/mp4":"");
            rec=mt?new MediaRecorder(str,{mimeType:mt}):new MediaRecorder(str); isRec=true;
            vb.textContent="⏹"; vb.style.background="var(--green)"; vb.style.color="#fff";
            rec.ondataavailable=e=>{if(e.data.size>0)chunks.push(e.data);};
            rec.onstop=()=>{
                isRec=false; vb.style.background="transparent"; vb.style.color="var(--muted)"; vb.textContent="🎙️"; str.getTracks().forEach(t=>t.stop());
                const blob=new Blob(chunks,{type:rec.mimeType||"audio/webm"}); if(blob.size===0)return; if(blob.size>MAX_CHAT_FILE)return alert("Voice too large.");
                const r=new FileReader(); r.onload=()=>socket.emit("chatMessage",{name:currentUser.name,type:"audio",data:String(r.result),replyTo:null}); r.readAsDataURL(blob);
            };
            rec.start();
        }catch{alert("Mic access denied.");}
    };
}

// ==========================================
// PHASE 3: MEMORY GALLERY & TIMELINE
// ==========================================
function setupMemories(){
    const getMemDate = m => { const d=new Date(m?.time||0); return isNaN(d.getTime())?null:d; };
    const fDate = m => { const d=getMemDate(m); return d ? d.toLocaleDateString([],{day:"2-digit",month:"short",year:"numeric"}) : "Unknown"; };
    const fTime = m => { const d=getMemDate(m); return d ? d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}) : ""; };

    $("phase3-gallery-btn").onclick = () => { $("phase3-memory-overlay").style.display="flex"; renderGallery(); };
    $("phase3-memory-close").onclick = () => $("phase3-memory-overlay").style.display="none";
    $("p3-view-close").onclick = () => { $("phase3-photo-viewer").style.display="none"; selectedMemoryId=null; };
    
    document.querySelectorAll(".phase3-filter").forEach(b => {
        b.onclick = () => { document.querySelectorAll(".phase3-filter").forEach(x=>x.classList.remove("active")); b.classList.add("active"); currentGalleryFilter=b.dataset.filter; renderGallery(); };
    });
    $("phase3-memory-search").oninput = e => { currentGallerySearch=e.target.value.toLowerCase(); renderGallery(); };
    
    $("p3-view-focus").onclick = () => {
        const m = memories.get(selectedMemoryId);
        if(m && validCoord(m.lat, m.lng)){ map.flyTo([m.lat,m.lng],17,{animate:true}); $("phase3-photo-viewer").style.display="none"; $("phase3-memory-overlay").style.display="none"; }
    };

    function renderGallery(){
        let arr = Array.from(memories.values());
        if(currentGalleryFilter==="today"){ const today=new Date().setHours(0,0,0,0); arr=arr.filter(m=>getMemDate(m)?.getTime()>=today); }
        else if(currentGalleryFilter==="week"){ const wk=Date.now()-7*86400000; arr=arr.filter(m=>getMemDate(m)?.getTime()>=wk); }
        else if(currentGalleryFilter==="mine"){ arr=arr.filter(m=>cleanName(m.name)===currentUser.name); }
        else if(currentGalleryFilter==="others"){ arr=arr.filter(m=>cleanName(m.name)!==currentUser.name); }
        
        if(currentGallerySearch) arr=arr.filter(m=>cleanName(m.name).toLowerCase().includes(currentGallerySearch));
        arr.sort((a,b) => (getMemDate(b)?.getTime()||0) - (getMemDate(a)?.getTime()||0));

        $("phase3-memory-count").textContent = `${arr.length} memories`;
        const grid=$("phase3-memory-grid"), time=$("phase3-timeline-list"), emp=$("phase3-memory-empty");
        grid.innerHTML=""; time.innerHTML=""; emp.style.display=arr.length?"none":"block";

        arr.forEach(m=>{
            const c=document.createElement("div"); c.className="p3-card";
            c.innerHTML=`<img src="${escapeHTML(m.image)}" loading="lazy"><div class="p3-card-info"><b>${escapeHTML(m.name)}</b><span>${escapeHTML(fDate(m))}</span></div>`;
            c.onclick=()=>openView(m); grid.appendChild(c);

            const t=document.createElement("div"); t.className="p3-time-item";
            t.innerHTML=`<div class="p3-time-thumb"><img src="${escapeHTML(m.image)}" loading="lazy"></div><div class="p3-time-info"><b>${escapeHTML(m.name)}</b><span>${escapeHTML(fDate(m))} · ${escapeHTML(fTime(m))}</span></div>`;
            t.onclick=()=>openView(m); time.appendChild(t);
        });
    }

    function openView(m){
        selectedMemoryId = m.id;
        $("p3-view-image").src=m.image; $("p3-view-name").textContent=`📸 ${cleanName(m.name)}`;
        $("p3-view-date").textContent=`${fDate(m)} · ${fTime(m)}`;
        $("p3-view-location").textContent=validCoord(m.lat,m.lng)?`📍 ${Number(m.lat).toFixed(4)}, ${Number(m.lng).toFixed(4)}`:"📍 Location unavailable";
        $("phase3-photo-viewer").style.display="flex";
    }

    function renderPins(){
        memoryLayer.clearLayers();
        memories.forEach(m=>{
            if(!validCoord(m.lat,m.lng) || !m.image) return;
            const icon = L.divIcon({ className:"p3-memory-marker", html:`<div style="width:46px;height:46px;border-radius:50%;overflow:hidden;border:2px solid #fff;background:#071018;box-shadow:0 4px 15px rgba(0,0,0,.65)"><img src="${escapeHTML(m.image)}" style="width:100%;height:100%;object-fit:cover;display:block"></div>`, iconSize:[46,46], iconAnchor:[23,23]});
            const marker = L.marker([m.lat,m.lng],{icon}).addTo(memoryLayer);
            marker.bindPopup(`<div class="p3-map-popup"><img src="${escapeHTML(m.image)}"><b>📸 ${escapeHTML(m.name)}</b><small>${escapeHTML(fDate(m))}</small><button type="button" class="p3-open-map-memory">View Memory</button></div>`);
            marker.on("popupopen",e=>{ const b=e.popup.getElement()?.querySelector(".p3-open-map-memory"); if(b) b.onclick=()=>openView(m); });
        });
    }

    socket.on("loadMemoryPhotos", list=>{ if(Array.isArray(list)){ memories.clear(); list.forEach(m=>{if(m?.image&&validCoord(m.lat,m.lng)) memories.set(String(m.id||Date.now()),m);}); renderPins(); }});
    socket.on("newMemoryPin", m=>{ if(m?.image&&validCoord(m.lat,m.lng)){ memories.set(String(m.id||Date.now()),m); renderPins(); if($("phase3-memory-overlay").style.display==="block") renderGallery(); }});

    const mInp=$("memoryPhotoInput");
    $("memoryButton").onclick=()=>{ if(!currentUser.name) return alert("Join map first."); if(!myCoords) return alert("Waiting for GPS..."); mInp.click(); };
    mInp.onchange=()=>{
        const f=mInp.files?.[0]; if(!f) return;
        if(!IMAGE_TYPES.includes(f.type)||f.size>MAX_MEMORY_FILE){alert("Invalid image or >8MB."); mInp.value=""; return;}
        const r=new FileReader(); r.onload=()=>{
            if(validImageData(r.result)){ alert("📸 Tap the map to drop your photo pin!"); map.once("click",e=>{ socket.emit("uploadMemoryPhoto",{name:currentUser.name,lat:e.latlng.lat,lng:e.latlng.lng,image:r.result}); }); }
        }; r.readAsDataURL(f); mInp.value="";
    };
}

// ==========================================
// INITIALIZATION
// ==========================================
$("profile-popup-close")?.addEventListener("click",()=>$("profile-popup").style.display="none");

function initApp(){
    setupJoin();
    setupMapControls();
    setupChat();
    setupVoice();
    setupMemories();
    startGPS();
}

if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", initApp);
else initApp();

setInterval(()=>{emitLocation(); updateFriendBadges();}, 5000);
console.log("Koraput Map ULTIMATE (Phase 1,2,3) initialized without any overlap issues.");
