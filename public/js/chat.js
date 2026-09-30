"use strict";

/* ============================================================================
   MapUnite client — js/chat.js
   ==============================================================================
   Squad chat: messages, attachments, replies, reactions, typing, history.

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

// ==========================================
// CHAT
// ==========================================
const typingTimerRef = { id: null };

function setupChatSafe() {
    const cc = $("chat-container"), inp = $("chatInput"), send = $("chat-send"), vb = $("voiceButton");
    const emojis = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
    const msgStore = new Map();
    let unread = 0, replyTo = null, reactingId = null;

    function updateUnreadBadge() { const b = $("chat-unread-badge"); if (b) { b.textContent = unread > 99 ? "99+" : unread; b.style.display = unread > 0 ? "flex" : "none"; } }

    const ctb = $("chat-toggle-btn");
    if (ctb) ctb.onclick = () => { safeShow("chat-container", "flex"); safeHide("chat-toggle-btn"); unread = 0; updateUnreadBadge(); if (inp) inp.focus(); };

    const cmb = $("chat-minimize-btn");
    if (cmb) cmb.onclick = () => { safeHide("chat-container"); safeShow("chat-toggle-btn", "flex"); };

    const ob = $("online-btn");
    if (ob) ob.onclick = (e) => { e.stopPropagation(); const l = $("online-list"); if (l) l.style.display = l.style.display === "flex" ? "none" : "flex"; updateOnlineUI(); };

    document.addEventListener("click", e => {
        const ol = $("online-list");
        const obtn = $("online-btn");
        if (ol && obtn && !ol.contains(e.target) && e.target !== obtn) safeHide("online-list");
    });

    if (inp) {
        inp.oninput = () => { socket.emit("typing", true); clearTimeout(typingTimerRef.id); typingTimerRef.id = setTimeout(() => socket.emit("typing", false), 1200); if (send && vb) { send.style.display = inp.value.trim() ? "flex" : "none"; vb.style.display = inp.value.trim() ? "none" : "flex"; } };
    }
    socket.on("typing", d => { const t = $("typing-indicator"); if (t) { if (d.id !== socket.id && d.isTyping) { t.textContent = `${escapeHTML(d.name)} is typing…`; t.style.display = "block"; } else t.style.display = "none"; } });

    const rc = $("reply-cancel"); if (rc) rc.onclick = () => { replyTo = null; safeHide("reply-bar"); };

    const eb = $("emojiButton"); if (eb) eb.onclick = (e) => { e.stopPropagation(); safeHide("attachment-menu"); const ec = $("emoji-picker-container"); if (ec) ec.style.display = ec.style.display === "block" ? "none" : "block"; };

    const ep = $("emojiPicker");
    if (ep) { ep.addEventListener("emoji-click", e => { const em = e.detail.unicode; if (reactingId) { socket.emit("messageReaction", { messageId: reactingId, emoji: em }); safeHide("emoji-picker-container"); reactingId = null; } else if (inp) { inp.value += em; inp.focus(); if (send) send.style.display = "flex"; if (vb) vb.style.display = "none"; } }); }

    const cab = $("chat-attach-btn"); if (cab) cab.onclick = (e) => { e.stopPropagation(); safeHide("emoji-picker-container"); const am = $("attachment-menu"); if (am) am.style.display = am.style.display === "flex" ? "none" : "flex"; };

    const fInp = $("chatFileInput");
    const atm = $("att-media"); if (atm) atm.onclick = () => { if (fInp) { fInp.accept = "image/*,video/*"; fInp.click(); safeHide("attachment-menu"); } };
    const atd = $("att-doc"); if (atd) atd.onclick = () => { if (fInp) { fInp.accept = ".pdf,.doc,.txt,.zip"; fInp.click(); safeHide("attachment-menu"); } };
    const ata = $("att-audio"); if (ata) ata.onclick = () => { if (fInp) { fInp.accept = "audio/*"; fInp.click(); safeHide("attachment-menu"); } };

    if (fInp) {
        fInp.onchange = () => {
            const f = fInp.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => {
                const payload = { name: currentUser.name, type: f.type.split('/')[0] === "image" ? "image" : f.type.split('/')[0] === "video" ? "video" : f.type.split('/')[0] === "audio" ? "audio" : "document", data: r.result, replyTo, fileName: f.name ? f.name.slice(0, 120) : null };
                if (navigator.onLine) socket.emit("chatMessage", payload);
                else { offlineMessageQueue.push(payload); showToast("📶 Offline: Message queued"); }
                const rcb = $("reply-cancel"); if (rcb) rcb.click();
            }; r.readAsDataURL(f); fInp.value = "";
        };
    }

    const cForm = $("chatForm");
    if (cForm) {
        cForm.onsubmit = e => {
            e.preventDefault(); if (!inp) return;
            const t = inp.value.trim();
            if (t) {
                const payload = { name: currentUser.name, type: "text", data: t, replyTo };
                if (navigator.onLine) socket.emit("chatMessage", payload);
                else { offlineMessageQueue.push(payload); showToast("📶 Offline: Message queued"); }
                inp.value = ""; const rcb = $("reply-cancel"); if (rcb) rcb.click(); if (send) send.style.display = "none"; if (vb) vb.style.display = "flex"; inp.focus();
            }
        };
    }

    // Batch 2: history survives restarts and reconnects, so "is this mine?" goes
    // by the device's ownerKey (stable), not the socket id (new every reconnect).
    const isMine = (m) => m.senderId === socket.id || Boolean(m.senderKey && myOwnerKey && m.senderKey === myOwnerKey);
    // Attachments are server URLs (/media/chat/…); older ones may be data-URLs.
    // In the Android app they're resolved against the server (serverUrl).
    const safeMediaSrc = (v) => {
        if (typeof v !== "string") return "";
        if (/^\/media\/chat\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/.test(v)) return serverUrl(v);
        return /^data:(image|video|audio|application|text)\/[a-z0-9.+-]+(;[a-z0-9=._+-]+)*;base64,/i.test(v) ? v : "";
    };

    function renderMsg(m) {
        if (msgStore.has(m.id)) return;
        const mine = isMine(m);
        const w = document.createElement("div"); w.className = "chat-row " + (mine ? "mine" : "");
        const b = document.createElement("div"); b.className = "chat-message " + (mine ? "msg-mine" : "msg-theirs");
        if (!mine) b.innerHTML += `<div class="msg-sender">${escapeHTML(m.name)}</div>`;
        if (m.replyTo) b.innerHTML += `<div class="reply-quote"><b>${escapeHTML(m.replyTo.name)}</b><br>${escapeHTML(m.replyTo.preview)}</div>`;

        if (m.type === "text") b.innerHTML += `<div style="word-wrap:break-word;word-break:break-word;">${escapeHTML(m.data)}</div>`;
        else if (m.type === "image") b.innerHTML += `<img class="chat-media" src="${escapeHTML(safeMediaSrc(m.data))}" loading="lazy" alt="">`;
        else if (m.type === "video") b.innerHTML += `<video class="chat-media" controls preload="metadata" src="${escapeHTML(safeMediaSrc(m.data))}"></video>`;
        else if (m.type === "audio") b.innerHTML += `<audio class="chat-audio" controls preload="metadata" src="${escapeHTML(safeMediaSrc(m.data))}"></audio>`;
        else if (m.type === "document") b.innerHTML += `<a class="chat-document" href="${escapeHTML(safeMediaSrc(m.data))}" download="${escapeHTML(m.fileName || "file")}">📄 ${escapeHTML(m.fileName || "Download file")}</a>`;

        b.innerHTML += `<div class="message-meta">${new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>`;

        const a = document.createElement("div"); a.className = "message-actions";
        emojis.forEach(e => { const btn = document.createElement("button"); btn.className = "action-btn"; btn.textContent = e; btn.onclick = () => socket.emit("messageReaction", { messageId: m.id, emoji: e }); a.appendChild(btn); });
        const rep = document.createElement("button"); rep.className = "action-btn"; rep.textContent = "↩ Reply"; rep.onclick = () => { replyTo = { id: m.id, name: m.name, type: m.type, preview: m.type === "text" ? m.data.slice(0, 50) : "Attachment" }; const rp = $("reply-preview"); if (rp) rp.textContent = `↩ ${m.name}`; safeShow("reply-bar", "flex"); if (inp) inp.focus(); }; a.appendChild(rep);
        b.appendChild(a); const rr = document.createElement("div"); rr.className = "reaction-row"; b.appendChild(rr); w.appendChild(b);

        const chatMsgs = $("chat-messages");
        if (chatMsgs) { chatMsgs.appendChild(w); chatMsgs.scrollTop = chatMsgs.scrollHeight; }
        msgStore.set(m.id, { msg: m, el: w });
        if (!mine && !m.fromHistory && cc && cc.style.display !== "flex") { unread++; updateUnreadBadge(); }
        // History arrives with its reactions already set.
        if (m.reactions) paintReactions(w, m.reactions);
    }
    function paintReactions(el, reactions) {
        const rr = el.querySelector(".reaction-row"); if (!rr) return;
        rr.innerHTML = "";
        Object.entries(reactions || {}).forEach(([emoji, ids]) => {
            if (!ids || ids.length === 0) return;
            const chip = document.createElement("span"); chip.textContent = `${emoji} ${ids.length}`;
            chip.className = "reaction-chip" + (myOwnerKey && ids.includes(myOwnerKey) ? " mine" : "");
            chip.style.cssText = "background:rgba(255,255,255,.08);border-radius:10px;padding:2px 7px;margin-right:4px;";
            rr.appendChild(chip);
        });
    }
    // Saved history (server restarts included): shown without counting as unread.
    socket.on("chatHistory", l => { if (Array.isArray(l)) l.forEach((m) => renderMsg({ ...m, fromHistory: true })); });
    socket.on("chatMessage", renderMsg);
    socket.on("chatMessagesRemoved", (d) => {
        (d && Array.isArray(d.ids) ? d.ids : []).forEach((id) => { const e = msgStore.get(id); if (e) { e.el.remove(); msgStore.delete(id); } });
    });
    socket.on("chatRejected", (d) => {
        const why = { "type-mismatch": "That file's contents don't match its type — not sent.", "too-large": "That file is too big (5 MB max).", "too-frequent": "Wait a moment between attachments.", "not-a-data-url": "Couldn't read that file." }[d?.reason];
        showToast(`📎 ${why || "Attachment not sent."}`, 4000);
    });
    socket.on("messageReaction", (data) => {
        const entry = msgStore.get(data.messageId); if (!entry) return;
        paintReactions(entry.el, data.reactions);
    });
}
