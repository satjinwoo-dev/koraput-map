/* ============================================================================
   MapUnite navigation, minimized — the small window and the live notification
   ==============================================================================
   Like a car navigator: while navigating, going to the home screen or another
   app keeps the next turn in front of the rider.

   IN THE ANDROID APP (native/android/nav/, plugin "MapUniteNavPip"):
     - leaving the app (home button, gesture, recent apps) shrinks it into a
       picture-in-picture window: the live map with a glass turn card on it
       (body.mu-pip: everything else hidden);
     - a live notification with the turn arrow, "200 m · Turn left onto NH-26",
       the next step, the arrival time, the distance left and a progress bar,
       updated as the rider goes; "Stop" in it ends the navigation;
     - the ⧉ button minimizes on purpose.
   IN A BROWSER:
     - ⧉ opens a floating window (the video picture-in-picture of a glass turn
       card drawn on a canvas, the only floating window a web page may open;
       Chrome also opens it by itself when the rider leaves the tab, where it
       allows that);
     - the same live notification through the service worker, when the rider
       has allowed notifications (asked when a drive starts).
   The words come from navpip-core.js. Nothing leaves the phone.
   ============================================================================ */
"use strict";

const NavPip = (() => {
    const W = /** @type {any} */ (typeof window !== "undefined" ? window : null);
    const C = W ? W.MUNavPipCore : null;
    if (!W || !W.document || !C) return { get active() { return false; } };
    const TAG = "mu-nav";

    // ---------------------------------------------------------------- the Android app
    function native() {
        const core = W.capacitorExports, Cap = core && core.Capacitor;
        if (!Cap || typeof Cap.isNativePlatform !== "function" || !Cap.isNativePlatform() || typeof core.registerPlugin !== "function") return null;
        try { return core.registerPlugin("MapUniteNavPip"); } catch (e) { return null; }
    }
    const N = native();
    let nativeListening = false;
    async function listenNative() {
        if (!N || nativeListening) return;
        nativeListening = true;
        try {
            await N.addListener("pip", (/** @type {any} */ e) => setPipLayout(Boolean(e && e.active)));
            await N.addListener("action", (/** @type {any} */ e) => { if (e && e.action === "stop") stopNavigation(); });
        } catch (e) { /* older app build without the plugin */ }
    }

    // ---------------------------------------------------------------- state
    let on = false, timer = 0, last = null;
    const state = () => { try { return typeof navState !== "undefined" ? navState : null; } catch (e) { return null; } };
    const current = () => { const s = state(); return s && s.active ? C.card(s, Date.now()) : null; };
    function stopNavigation() { try { if (typeof stopDrive === "function") stopDrive(); } catch (e) { /* not loaded */ } }

    // ---------------------------------------------------------------- the glass turn card (canvas: browser window + notification icon)
    /** @param {CanvasRenderingContext2D} g @param {string} kind @param {number} x @param {number} y @param {number} size */
    function drawArrow(g, kind, x, y, size) {
        const a = C.arrowPath(kind), k = size / 100, P = (/** @type {number[]} */ p) => [x + p[0] * k, y + p[1] * k];
        g.save();
        g.strokeStyle = "#ffffff"; g.fillStyle = "#ffffff"; g.lineCap = "round"; g.lineJoin = "round"; g.lineWidth = 11 * k;
        g.shadowColor = "rgba(0,0,0,.35)"; g.shadowBlur = 6 * k;
        if (a.pin) {
            const [cx, cy] = P([50, 42]);
            g.beginPath(); g.arc(cx, cy, 20 * k, Math.PI, 0); g.lineTo(cx, cy + 40 * k); g.closePath(); g.fill();
            g.fillStyle = "#0e7c6b"; g.beginPath(); g.arc(cx, cy, 8 * k, 0, Math.PI * 2); g.fill();
        } else {
            g.beginPath(); a.shaft.forEach((p, i) => { const [px, py] = P(p); if (i) g.lineTo(px, py); else g.moveTo(px, py); }); g.stroke();
            g.beginPath(); a.head.forEach((p, i) => { const [px, py] = P(p); if (i) g.lineTo(px, py); else g.moveTo(px, py); }); g.closePath(); g.fill();
        }
        g.restore();
    }
    const rr = (/** @type {CanvasRenderingContext2D} */ g, x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
    function fit(g, text, max, font) { g.font = font; let t = text; while (t.length > 3 && g.measureText(t).width > max) t = t.slice(0, -2); return t === text ? t : `${t.trimEnd()}…`; }
    /** The floating window's picture: a glass card over a soft road-coloured glow. @param {HTMLCanvasElement} cv @param {any} c */
    function drawCard(cv, c) {
        const g = /** @type {CanvasRenderingContext2D} */ (cv.getContext("2d")), w = cv.width, h = cv.height;
        const bg = g.createLinearGradient(0, 0, w, h);
        bg.addColorStop(0, "#0b2a2a"); bg.addColorStop(0.55, "#101a2e"); bg.addColorStop(1, "#1d1647");
        g.fillStyle = bg; g.fillRect(0, 0, w, h);
        for (const [cx, cy, r, col] of [[w * 0.15, h * 0.1, w * 0.6, "rgba(52,224,180,.35)"], [w * 0.95, h * 0.95, w * 0.7, "rgba(99,102,241,.4)"]]) {
            const rg = g.createRadialGradient(cx, cy, 0, cx, cy, r); rg.addColorStop(0, col); rg.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = rg; g.fillRect(0, 0, w, h);
        }
        // the glass card
        const m = 18;
        rr(g, m, m, w - 2 * m, h - 2 * m, 30);
        g.fillStyle = "rgba(255,255,255,.08)"; g.fill();
        const sheen = g.createLinearGradient(0, m, 0, h * 0.55); sheen.addColorStop(0, "rgba(255,255,255,.18)"); sheen.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = sheen; g.fill();
        g.lineWidth = 2; g.strokeStyle = "rgba(255,255,255,.22)"; g.stroke();
        if (!c) {
            g.fillStyle = "#fff"; g.font = "700 30px system-ui, sans-serif"; g.fillText("MapUnite", m + 28, h / 2);
            return;
        }
        // the turn: arrow in a bright tile, distance big beside it
        const tile = 132, tx = m + 24, ty = m + 24;
        rr(g, tx, ty, tile, tile, 28);
        const tg = g.createLinearGradient(tx, ty, tx + tile, ty + tile); tg.addColorStop(0, "#34e0b4"); tg.addColorStop(1, "#0e9f85");
        g.fillStyle = tg; g.fill();
        drawArrow(g, c.turn, tx + 10, ty + 10, tile - 20);
        const lx = tx + tile + 22, lw = w - lx - m - 24;
        g.fillStyle = "#ffffff";
        g.font = "800 56px system-ui, sans-serif"; g.fillText(fit(g, c.distance || "", lw, "800 56px system-ui, sans-serif"), lx, ty + 60);
        g.fillStyle = "rgba(255,255,255,.92)";
        const ins = c.instruction || "";
        const words = ins.split(" "); let l1 = "", l2 = "";
        g.font = "600 27px system-ui, sans-serif";
        for (const wd of words) { if (!l2 && g.measureText(`${l1} ${wd}`.trim()).width <= lw) l1 = `${l1} ${wd}`.trim(); else l2 = `${l2} ${wd}`.trim(); }
        g.fillText(l1, lx, ty + 100);
        if (l2) g.fillText(fit(g, l2, lw, "600 27px system-ui, sans-serif"), lx, ty + 132);
        // then, arrival and what's left
        const by = h - m - 84;
        g.fillStyle = "rgba(255,255,255,.12)"; rr(g, m + 24, by, w - 2 * m - 48, 1.5, 1); g.fill();
        g.fillStyle = "rgba(255,255,255,.72)";
        g.font = "500 22px system-ui, sans-serif";
        if (c.then) g.fillText(fit(g, c.then, w - 2 * m - 48, "500 22px system-ui, sans-serif"), m + 24, by + 32);
        g.fillStyle = "#34e0b4"; g.font = "700 24px system-ui, sans-serif";
        g.fillText(fit(g, [c.eta ? `Arrive ${c.eta}` : "", c.left].filter(Boolean).join("  ·  "), w - 2 * m - 48, "700 24px system-ui, sans-serif"), m + 24, by + 64);
        if (c.progress != null) {
            g.fillStyle = "rgba(255,255,255,.14)"; rr(g, m + 24, h - m - 12, w - 2 * m - 48, 5, 3); g.fill();
            g.fillStyle = "#34e0b4"; rr(g, m + 24, h - m - 12, Math.max(6, (w - 2 * m - 48) * c.progress), 5, 3); g.fill();
        }
    }
    /** The notification's icon: the arrow on the mint tile, as a data URL. @param {string} kind */
    function iconUrl(kind) {
        try {
            const cv = document.createElement("canvas"); cv.width = cv.height = 192;
            const g = /** @type {CanvasRenderingContext2D} */ (cv.getContext("2d"));
            rr(g, 0, 0, 192, 192, 44);
            const tg = g.createLinearGradient(0, 0, 192, 192); tg.addColorStop(0, "#34e0b4"); tg.addColorStop(1, "#4f46e5");
            g.fillStyle = tg; g.fill();
            drawArrow(g, kind, 20, 20, 152);
            return cv.toDataURL("image/png");
        } catch (e) { return undefined; }
    }

    // ---------------------------------------------------------------- the browser's floating window (video picture-in-picture)
    /** @type {HTMLCanvasElement|null} */ let canvas = null;
    /** @type {HTMLVideoElement|null} */ let video = null;
    const pipSupported = () => Boolean(document.pictureInPictureEnabled && HTMLCanvasElement.prototype.captureStream);
    function ensureVideo() {
        if (video) return video;
        canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 400;
        drawCard(canvas, current());
        video = document.createElement("video");
        video.muted = true; video.playsInline = true; video.setAttribute("playsinline", ""); video.setAttribute("aria-hidden", "true");
        Object.assign(video.style, { position: "fixed", width: "1px", height: "1px", opacity: "0", pointerEvents: "none", left: "0", bottom: "0" });
        video.srcObject = canvas.captureStream(4);
        try { /** @type {any} */ (video).autoPictureInPicture = true; } catch (e) { /* not in this browser */ }
        document.body.append(video);
        video.addEventListener("enterpictureinpicture", () => setPipLayout(false));
        return video;
    }
    async function openWindow() {
        if (N) { try { await N.enterPip(); } catch (e) { /* the system said no */ } return; }
        if (!pipSupported()) return;
        const v = ensureVideo();
        try { await v.play(); if (document.pictureInPictureElement !== v) await v.requestPictureInPicture(); } catch (e) { /* needs a tap, or the browser said no */ }
    }
    async function closeWindow() {
        try { if (video && document.pictureInPictureElement === video) await document.exitPictureInPicture(); } catch (e) { /* already closed */ }
        if (video) { try { video.pause(); video.srcObject = null; } catch (e) { /* gone */ } video.remove(); }
        video = null; canvas = null;
    }

    // ---------------------------------------------------------------- the live notification (browser)
    async function swReg() { try { return "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null; } catch (e) { return null; } }
    async function notifyWeb(c) {
        if (N || !("Notification" in W) || Notification.permission !== "granted") return;
        const reg = await swReg();
        if (!reg || typeof reg.showNotification !== "function") return;
        const n = C.notice(c);
        try {
            await reg.showNotification(n.title, {
                tag: TAG, body: n.text, icon: iconUrl(c.turn), badge: "/icon-192.png", silent: true, renotify: false, requireInteraction: true,
                data: { kind: "nav" }, actions: [{ action: "nav-stop", title: "Stop" }]
            });
        } catch (e) { /* a browser without actions */ }
    }
    async function clearWeb() {
        const reg = await swReg();
        if (!reg || typeof reg.getNotifications !== "function") return;
        try { for (const n of await reg.getNotifications({ tag: TAG })) n.close(); } catch (e) { /* none */ }
    }
    if ("serviceWorker" in navigator) {
        try { navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.type === "mu-nav-stop") stopNavigation(); }); } catch (e) { /* no worker */ }
    }

    // ---------------------------------------------------------------- the small-window layout (the Android app's picture-in-picture)
    function setPipLayout(v) {
        document.body.classList.toggle("mu-pip", v);
        try { W.dispatchEvent(new Event("resize")); } catch (e) { /* old browser */ }
    }

    // ---------------------------------------------------------------- the ⧉ button
    /** @type {HTMLButtonElement|null} */ let btn = null;
    function ensureButton() {
        if (btn) return btn;
        btn = /** @type {HTMLButtonElement} */ (document.createElement("button"));
        btn.id = "nav-minimize-btn"; btn.type = "button"; btn.hidden = true;
        btn.setAttribute("aria-label", "Minimize navigation: keep the next turn in a small window");
        btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><rect x="11.5" y="11" width="7.5" height="6" rx="1.5" class="in"/></svg>';
        btn.addEventListener("click", (e) => { e.stopPropagation(); openWindow(); });
        document.body.append(btn);
        return btn;
    }
    function placeButton() {
        if (!btn) return;
        const cmp = document.getElementById("navcam-compass");
        const r = cmp && !cmp.hidden ? cmp.getBoundingClientRect() : null;
        btn.style.top = r && r.height ? `${Math.round(r.bottom + 10)}px` : "";
    }

    // ---------------------------------------------------------------- the drive
    function tick() {
        const c = current();
        if (!c) return;
        if (canvas) drawCard(canvas, c);
        placeButton();
        if (!C.changed(last, c)) return;
        last = c;
        if (N) { try { N.update(c); } catch (e) { /* plugin gone */ } }
        else notifyWeb(c);
    }
    async function begin() {
        if (on) return;
        on = true; last = null;
        if (N) {
            await listenNative();
            // Android 13+: the live notification needs the notification permission (asked once, by MapUniteNative)
            try { const core = W.capacitorExports; const NN = core.registerPlugin("MapUniteNative"); if (NN && NN.requestNotifications) await NN.requestNotifications(); } catch (e) { /* older app build */ }
            try { await N.start(current() || {}); } catch (e) { /* older app build */ }
        } else if ("Notification" in W && Notification.permission === "default") {
            try { await Notification.requestPermission(); } catch (e) { /* the browser said no */ }
        }
        if (!N && pipSupported()) {
            // ready before the rider leaves: where the browser allows it, the window opens by itself
            const v = ensureVideo();
            try { await v.play(); } catch (e) { /* plays on the first tap */ }
            try { navigator.mediaSession.setActionHandler(/** @type {any} */ ("enterpictureinpicture"), () => { openWindow(); }); } catch (e) { /* not in this browser */ }
        }
        const b = ensureButton();
        b.hidden = !(N || pipSupported());
        tick();
        timer = W.setInterval(tick, 1000);
    }
    async function end() {
        if (!on) return;
        on = false;
        if (timer) W.clearInterval(timer);
        timer = 0; last = null;
        if (btn) btn.hidden = true;
        setPipLayout(false);
        if (N) { try { await N.stop(); } catch (e) { /* gone */ } }
        await clearWeb();
        try { navigator.mediaSession.setActionHandler(/** @type {any} */ ("enterpictureinpicture"), null); } catch (e) { /* not in this browser */ }
        await closeWindow();
    }
    document.addEventListener("mu:drive-state", (e) => {
        const d = /** @type {CustomEvent} */ (e).detail || {};
        if (d.navigating) begin(); else end();
    });

    return { open: openWindow, get active() { return on; }, drawCard, iconUrl, state: () => ({ on, native: Boolean(N), pip: pipSupported(), last }) };
})();

if (typeof window !== "undefined") /** @type {any} */ (window).NavPip = NavPip;
