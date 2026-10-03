"use strict";

/* ============================================================================
   MapUnite client — js/privacy.js
   ==============================================================================
   Privacy: sharing mode, who can see me (everyone / my circles), share only
   during a trip or ride, export + clear history; friend circles; and "you
   were here before" place recall.

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

// ============================================================================
// PRIVACY CONTROLS — roadmap Section 15: exact / approx / off, who can see
// you (everyone or your circles), and "share only during a trip or ride"
// ============================================================================
const PrivacyControls = {
    mode: "exact",
    // Mirrors the server's privacyChanged: sharing mode, audience, trip-only,
    // and whether sharing is live right now (a ride or a trip is running).
    state: { sharingMode: "exact", visibility: "everyone", tripOnly: false, active: true, inTrip: false, session: false },

    init() {
        const seg = document.querySelector('[data-segment="sharingMode"]');
        if (seg) seg.addEventListener("segment", (e) => this.setMode(e.detail.value));
        const vis = document.querySelector('[data-segment="visibilityScope"]');
        if (vis) vis.addEventListener("segment", (e) => this.setVisibility(e.detail.value));
        const tog = $("share-trip-only-toggle");
        if (tog) tog.addEventListener("change", (e) => this.setTripOnly(e.target.checked));

        const exportBtn = $("export-data-btn");
        if (exportBtn) exportBtn.addEventListener("click", () => this.exportData());

        const clearBtn = $("clear-history-btn");
        if (clearBtn) clearBtn.addEventListener("click", () => this.clearHistory());

        socket.on("privacyChanged", (s) => this.apply(s));
        this.render();
    },

    // Location may go to the server right now (the server enforces the same rule).
    canShare() {
        return this.state.sharingMode !== "off" && (!this.state.tripOnly || this.state.active);
    },

    setMode(mode, { silent = false } = {}) {
        if (!["exact", "approx", "off"].includes(mode)) return;
        this.mode = mode;
        this.state.sharingMode = mode;
        if (window.MapUnite) window.MapUnite.setSegment("sharingMode", mode);
        if (!silent) socket.emit("setSharing", { mode });
        if (mode === "off") {
            islandShow({ id: "privacy", kind: "sensor", title: "Location sharing off", sub: "You appear offline to others", ttl: 4500 });
        } else if (mode === "approx") {
            islandShow({ id: "privacy", kind: "sensor", title: "Sharing approximate location", sub: "Rounded to ~1 km outside active trips", ttl: 4500 });
        }
        this.render();
    },

    setVisibility(value) {
        if (!["everyone", "circles"].includes(value)) return;
        const prev = this.state.visibility;
        this.state.visibility = value;
        this.render();
        socket.emit("setPrivacy", { visibility: value }, (r) => {
            if (!r || !r.ok) {
                this.state.visibility = prev;
                this.render();
                return showToast(r?.reason === "no-device-identity" ? "Circles need this device to be registered — reconnect and try again." : "Couldn't change who can see you right now.");
            }
            this.apply(r.privacy);
            if (value === "circles") {
                const n = (window.Circles && Circles.list.length) || 0;
                islandShow({ id: "privacy", kind: "sensor", title: "Only your circles can see you", sub: n ? `${n} circle${n === 1 ? "" : "s"} · plus whoever is in your trip` : "Create or join a circle so friends can see you", ttl: 4500 });
            }
        });
    },

    setTripOnly(on) {
        const prev = this.state.tripOnly;
        this.state.tripOnly = Boolean(on);
        this.render();
        socket.emit("setPrivacy", { tripOnly: Boolean(on) }, (r) => {
            if (!r || !r.ok) { this.state.tripOnly = prev; this.render(); return showToast("Couldn't change that setting right now."); }
            const wasPaused = !this.serverSharing;
            this.apply(r.privacy);
            if (!on && wasPaused && this.canShare()) islandShow({ id: "privacy", kind: "safe", icon: "📡", title: "Sharing your location", sub: "Trip-only sharing is off", ttl: 3000, haptic: false });
        });
    },

    // Server truth (profileAccepted.privacy / privacyChanged / setPrivacy ack).
    // "Was sharing" compares with the last state the SERVER confirmed (the
    // switches update optimistically), so turning trip-only off re-sends the
    // current position at once instead of waiting for the next GPS fix.
    serverSharing: true,
    apply(s) {
        if (!s || typeof s !== "object") return;
        const wasActive = this.serverSharing;
        Object.assign(this.state, {
            sharingMode: ["exact", "approx", "off"].includes(s.sharingMode) ? s.sharingMode : this.state.sharingMode,
            visibility: s.visibility === "circles" ? "circles" : "everyone",
            tripOnly: Boolean(s.tripOnly), active: s.active !== false, inTrip: Boolean(s.inTrip), session: Boolean(s.session)
        });
        this.mode = this.state.sharingMode;
        if (window.MapUnite) window.MapUnite.setSegment("sharingMode", this.mode);
        this.render();
        const nowActive = this.canShare();
        this.serverSharing = nowActive;
        if (this.state.tripOnly && wasActive !== nowActive && this.state.sharingMode !== "off") {
            islandShow(nowActive
                ? { id: "privacy", kind: "safe", icon: "📡", title: "Sharing your location", sub: this.state.inTrip ? "You're in a trip" : "Ride started", ttl: 3500, haptic: false }
                : { id: "privacy", kind: "sensor", icon: "⏸️", title: "Location sharing paused", sub: "Resumes when you start a ride or join a trip", ttl: 4500, haptic: false });
        }
        // Just went live: send the current fix instead of waiting for the next one.
        if (!wasActive && nowActive && typeof myCoords !== "undefined" && myCoords && !myCoords.est && validCoord(myCoords.lat, myCoords.lng)) {
            emitLocation({ lat: myCoords.lat, lng: myCoords.lng, alt: myCoords.alt ?? null, speedKmh: myCoords.speedKmh || 0, weather: myWeather });
        }
    },

    render() {
        const s = this.state;
        if (window.MapUnite) window.MapUnite.setSegment("visibilityScope", s.visibility);
        const tog = $("share-trip-only-toggle");
        if (tog) tog.checked = s.tripOnly;
        const st = $("privacy-status");
        if (st) {
            let text, tone;
            if (s.sharingMode === "off") { text = "Not sharing — you appear offline."; tone = "off"; }
            else if (s.tripOnly && !s.active) { text = "Paused — sharing starts when you start a ride or join a trip."; tone = "paused"; }
            else {
                const who = s.visibility === "circles" ? "your circles" : "everyone on the map";
                const how = s.sharingMode === "approx" ? "a ~1 km area" : "your live position";
                text = `Sharing ${how} with ${who}${s.inTrip ? " (your trip sees you exactly)" : ""}.`;
                tone = "live";
            }
            st.textContent = text;
            st.dataset.tone = tone;
        }
    },

    async exportData() {
        socket.emit("exportMyData", {}, (res) => {
            if (!res || !res.ok) return showToast("Couldn't export your data right now.");
            const blob = new Blob([JSON.stringify(res, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = `mapunite-export-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            showToast("📥 Export downloaded.");
        });
    },

    async clearHistory() {
        const { ok, checked } = await confirmDialog({
            title: "Clear your history?",
            body: "This permanently deletes your trips, breadcrumbs, memories, geofences and chat messages from this server, any fill-ups you shared anonymously, and on this phone your ride summaries, fill-up log and the fuel curve learned from it, and saved route data. It cannot be undone.",
            okLabel: "Delete everything", cancelLabel: "Cancel", danger: true,
            checkboxLabel: "Also remove my device identity and leave my circles (you'll appear as a new rider next time)"
        });
        if (!ok) return;
        socket.emit("deleteMyHistory", { includeIdentity: checked }, (res) => {
            if (!res || !res.ok) return showToast("Couldn't clear your history right now.");
            locationHistory = [];
            try { localStorage.removeItem("koraput_history"); } catch (e) { /* ignore */ }
            historyPolyline.setLatLngs([]);
            // Phase 3: zero-trace also means the not-yet-uploaded ride queue,
            // the cached rollups and any replay on screen.
            TripAnalytics.clearLocal();
            DeadReckoning.clearLocal();        // Phase 4: the GPS-outage log is location history too
            PlaceRecall.clearLocal();          // Batch 2: cached "been here before" answers
            try { if (window.caches) caches.delete("mapunite-media-v1"); } catch (e) { /* no Cache API */ }   // offline copies of photos
            // Step 10: ride summaries, the fuel learner's log, route caches, and the tanks shared anonymously
            if (window.MURides && window.MURides.app) window.MURides.app.clearAll().then((r) => {
                if (r && r.sharedPending) showToast("Your shared fill-ups will be erased from the server once you're back online.", 6000);
            }, (e) => console.warn("[rides] clear:", e));
            if (checked) DeviceIdentity.resetAfterRejection();
            const parts = [`${res.tripsDeleted} trip(s)`, `${res.memoriesDeleted} memor${res.memoriesDeleted === 1 ? "y" : "ies"}`, `${res.geofencesDeleted} geofence(s)`];
            if (Number.isFinite(res.chatDeleted)) parts.push(`${res.chatDeleted} message(s)`);
            showToast(`🗑️ Cleared ${parts.join(", ")}.`, 6000);
        });
    }
};

// Every live-position send goes through here: nothing leaves the phone while
// sharing is off or paused (trip-only and not riding). The server applies the
// same rule; this saves the upload and keeps the phone honest on its own.
function emitLocation(payload) {
    if (typeof PrivacyControls !== "undefined" && !PrivacyControls.canShare()) return false;
    socket.emit("updateLocation", payload);
    return true;
}

// ============================================================================
// FRIEND CIRCLES (Batch 2) — roadmap Section 15 "visibility scoping"
// ============================================================================
// A circle is a named group you join with an invite code (or link). With
// "Who can see me: My circles", only people who share a circle with you —
// plus whoever is in your trip — see you at all. A trip can be started for
// one circle: only that circle is offered it.
const Circles = {
    list: [],
    KEY_AUDIENCE: "mu_trip_audience",
    pendingCode: null,
    busy: false,

    init() {
        const cb = $("circle-create-btn");
        if (cb) cb.addEventListener("click", () => this.create());
        const jb = $("circle-join-btn");
        if (jb) jb.addEventListener("click", () => this.join());
        const ci = $("circle-code-input");
        if (ci) ci.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.join(); } });
        const ni = $("circle-name-input");
        if (ni) ni.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.create(); } });
        const aud = $("trip-audience-select");
        if (aud) aud.addEventListener("change", (e) => { try { localStorage.setItem(this.KEY_AUDIENCE, e.target.value); } catch (err) { /* storage blocked */ } });
        socket.on("circlesChanged", () => this.refresh());
        // Invite links: https://…/?circle=ABCD-EF23 — joined once we're registered.
        try {
            const u = new URL(window.location.href);
            const code = u.searchParams.get("circle");
            if (code && /^[A-Za-z0-9-]{8,9}$/.test(code)) {
                this.pendingCode = code;
                u.searchParams.delete("circle");
                window.history.replaceState(null, "", u.pathname + (u.search ? u.search : "") + u.hash);
            }
        } catch (e) { /* no URL API */ }
        this.render();
    },

    // After profileAccepted: load circles, then act on an invite link.
    onProfile() {
        this.refresh().then(() => {
            if (!this.pendingCode) return;
            const code = this.pendingCode;
            this.pendingCode = null;
            this.joinCode(code, { fromLink: true });
        });
    },

    refresh() {
        return new Promise((resolve) => {
            if (!socket.connected) return resolve(this.list);
            socket.emit("listCircles", {}, (r) => {
                if (r && r.ok && Array.isArray(r.circles)) this.list = r.circles;
                this.render();
                resolve(this.list);
            });
        });
    },

    tripAudience() {
        let v = "";
        try { v = localStorage.getItem(this.KEY_AUDIENCE) || ""; } catch (e) { v = ""; }
        return this.list.some((c) => c.id === v) ? v : null;
    },

    create() {
        const inp = $("circle-name-input");
        const name = (inp?.value || "").trim();
        if (!name) { showToast("Give the circle a name first."); if (inp) inp.focus(); return; }
        if (this.busy) return;
        this.busy = true;
        socket.emit("createCircle", { name: name.slice(0, 40) }, (r) => {
            this.busy = false;
            if (!r || !r.ok) return showToast(this.reasonText(r?.reason));
            if (inp) inp.value = "";
            showToast(`⭕ “${r.circle.name}” created — share code ${r.circle.inviteCode}.`, 5000);
            this.refresh();
        });
    },

    join() {
        const inp = $("circle-code-input");
        const code = (inp?.value || "").trim();
        if (!code) { showToast("Paste an invite code, like ABCD-EF23."); if (inp) inp.focus(); return; }
        this.joinCode(code, { input: inp });
    },

    joinCode(code, { input = null, fromLink = false } = {}) {
        if (this.busy) return;
        this.busy = true;
        socket.emit("joinCircle", { code }, (r) => {
            this.busy = false;
            if (r && !r.ok && r.reason === "already-member" && fromLink) return showToast(`You're already in “${r.circle?.name || "that circle"}”.`);
            if (!r || !r.ok) return showToast(this.reasonText(r?.reason));
            if (input) input.value = "";
            showToast(`✅ Joined “${r.circle.name}”.`, 4000);
            islandShow({ id: "circles", kind: "safe", icon: "⭕", title: `Joined ${r.circle.name}`, sub: `${r.circle.memberCount} member${r.circle.memberCount === 1 ? "" : "s"}`, ttl: 3500, haptic: false });
            this.refresh();
        });
    },

    leave(c) {
        confirmDialog({
            title: `Leave “${c.name}”?`,
            body: c.isOwner && c.memberCount > 1 ? "You own this circle — the longest-standing member becomes the owner." : c.memberCount <= 1 ? "You're the last member, so the circle will be deleted." : "Riders who only share with this circle won't see you (and you won't see them) any more.",
            okLabel: "Leave", cancelLabel: "Cancel", danger: true
        }).then(({ ok }) => {
            if (!ok) return;
            socket.emit("leaveCircle", { circleId: c.id }, (r) => { if (!r || !r.ok) return showToast(this.reasonText(r?.reason)); this.refresh(); });
        });
    },

    removeMember(c, m) {
        confirmDialog({ title: `Remove ${m.name}?`, body: `They leave “${c.name}”. They can rejoin only with a new code if you also renew it.`, okLabel: "Remove", cancelLabel: "Cancel", danger: true })
            .then(({ ok }) => {
                if (!ok) return;
                socket.emit("removeCircleMember", { circleId: c.id, ownerKey: m.ownerKey }, (r) => { if (!r || !r.ok) return showToast(this.reasonText(r?.reason)); this.refresh(); });
            });
    },

    renewCode(c) {
        socket.emit("renewCircleCode", { circleId: c.id }, (r) => {
            if (!r || !r.ok) return showToast(this.reasonText(r?.reason));
            showToast(`🔁 New code: ${r.circle.inviteCode} — the old one no longer works.`, 5000);
            this.refresh();
        });
    },

    remove(c) {
        confirmDialog({ title: `Delete “${c.name}”?`, body: "Everyone is removed from it. Trips started for it keep going, but nobody new can join them.", okLabel: "Delete circle", cancelLabel: "Cancel", danger: true })
            .then(({ ok }) => {
                if (!ok) return;
                socket.emit("deleteCircle", { circleId: c.id }, (r) => { if (!r || !r.ok) return showToast(this.reasonText(r?.reason)); this.refresh(); });
            });
    },

    inviteLink(c) { return `${window.location.origin}${window.location.pathname}?circle=${encodeURIComponent(c.inviteCode)}`; },

    share(c) {
        const text = `Join my MapUnite circle “${c.name}” — code ${c.inviteCode}`;
        const url = this.inviteLink(c);
        if (navigator.share) {
            navigator.share({ title: `MapUnite · ${c.name}`, text, url }).catch(() => { /* cancelled */ });
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(`${text}\n${url}`).then(() => showToast("📋 Invite copied."), () => showToast(`Code: ${c.inviteCode}`, 6000));
        } else showToast(`Code: ${c.inviteCode}`, 6000);
    },

    reasonText(reason) {
        return ({
            "not-found": "No circle has that code — check it, or ask for a fresh one.",
            "already-member": "You're already in that circle.",
            "circle-full": "That circle is full (50 riders).",
            "too-many-circles": "You're in 10 circles already — leave one first.",
            "too-frequent": "One moment — try again in a second.",
            "not-owner": "Only the circle's owner can do that.",
            "bad-name": "Give the circle a name (up to 40 characters).",
            "no-device-identity": "This device isn't registered yet — reconnect and try again."
        })[reason] || "Couldn't do that right now.";
    },

    render() {
        const host = $("circles-list");
        if (host) {
            host.innerHTML = "";
            if (!this.list.length) {
                host.innerHTML = `<p class="field-hint circles-empty">No circles yet. Create one and share its code, or join a friend's.</p>`;
            }
            this.list.forEach((c) => {
                const card = document.createElement("div");
                card.className = "circle-card";
                card.dataset.circleId = c.id;
                const members = c.members.map((m) => `<li class="circle-member${m.online ? " online" : ""}"><span class="cm-dot" aria-hidden="true"></span><span class="cm-name">${escapeHTML(m.name)}${m.isYou ? " (you)" : ""}</span>${m.isOwner ? '<span class="cm-badge">owner</span>' : ""}${c.isOwner && !m.isYou ? `<button type="button" class="cm-remove" data-owner-key="${escapeHTML(m.ownerKey)}" aria-label="Remove ${escapeHTML(m.name)}">✕</button>` : ""}</li>`).join("");
                card.innerHTML = `
                    <div class="circle-head">
                        <strong class="circle-name">${escapeHTML(c.name)}</strong>
                        <span class="circle-count">${c.memberCount} member${c.memberCount === 1 ? "" : "s"}</span>
                    </div>
                    <div class="circle-code-row">
                        <span class="circle-code-label">Invite code</span>
                        <code class="circle-code">${escapeHTML(c.inviteCode)}</code>
                        <button type="button" class="circle-share btn-mini">Share</button>
                    </div>
                    <ul class="circle-members">${members}</ul>
                    <div class="circle-actions">
                        ${c.isOwner ? '<button type="button" class="circle-renew btn-mini">New code</button><button type="button" class="circle-delete btn-mini danger">Delete</button>' : ""}
                        <button type="button" class="circle-leave btn-mini">Leave</button>
                    </div>`;
                card.querySelector(".circle-share").onclick = () => this.share(c);
                card.querySelector(".circle-leave").onclick = () => this.leave(c);
                const rn = card.querySelector(".circle-renew"); if (rn) rn.onclick = () => this.renewCode(c);
                const dl = card.querySelector(".circle-delete"); if (dl) dl.onclick = () => this.remove(c);
                card.querySelectorAll(".cm-remove").forEach((b) => {
                    b.onclick = () => { const m = c.members.find((x) => x.ownerKey === b.dataset.ownerKey); if (m) this.removeMember(c, m); };
                });
                host.appendChild(card);
            });
        }
        const aud = $("trip-audience-select");
        if (aud) {
            const cur = this.tripAudience() || "";
            aud.innerHTML = `<option value="">Everyone on the map</option>` + this.list.map((c) => `<option value="${escapeHTML(c.id)}">${escapeHTML(c.name)} only</option>`).join("");
            aud.value = cur;
            aud.disabled = this.list.length === 0;
        }
        const hint = $("visibility-hint");
        if (hint) {
            hint.textContent = this.list.length
                ? `My circles: only people in ${this.list.map((c) => c.name).join(", ")} (and whoever is in your trip) see you.`
                : "My circles: nobody sees you until you create or join a circle — except riders in the same trip.";
        }
    }
};

// ============================================================================
// "YOU WERE HERE BEFORE" (Batch 2) — roadmap Section 30 #8
// ============================================================================
// Looks up YOUR OWN saved rides and memories near a place (server
// recallPlace — your device only, rides from the last 6 h don't count) and
// mentions it: under a searched destination, when you arrive, and when you
// park somewhere you've ridden to before. Off switch in Settings.
const PlaceRecall = {
    KEY: "mu_recall",
    enabled: true,
    cache: new Map(),          // "lat,lng" (3 dp) -> {ts, res}
    TTL_MS: 10 * 60 * 1000,
    shownAt: new Map(),        // place key -> last time we announced it

    init() {
        try { this.enabled = localStorage.getItem(this.KEY) !== "0"; } catch (e) { this.enabled = true; }
        const t = $("recall-toggle");
        if (t) {
            t.checked = this.enabled;
            t.addEventListener("change", (e) => {
                this.enabled = e.target.checked;
                try { localStorage.setItem(this.KEY, this.enabled ? "1" : "0"); } catch (err) { /* storage blocked */ }
            });
        }
        // Parked somewhere (GPS power drops to low): worth a look.
        document.addEventListener("mu:gps-power", (e) => {
            if (e.detail && e.detail.mode === "low" && myCoords && !myCoords.est) this.announceHere(myCoords.lat, myCoords.lng, { reason: "parked" });
        });
    },

    key(lat, lng) { return `${lat.toFixed(3)},${lng.toFixed(3)}`; },

    lookup(lat, lng, radiusM = 150) {
        if (!this.enabled || !validCoord(lat, lng) || !socket.connected) return Promise.resolve(null);
        const k = this.key(lat, lng) + ":" + radiusM;
        const hit = this.cache.get(k);
        if (hit && Date.now() - hit.ts < this.TTL_MS) return Promise.resolve(hit.res);
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), 6000);
            const ask = (retry) => socket.emit("recallPlace", { lat, lng, radiusM }, (r) => {
                // Two lookups in the same second (arrive + park): ask again once.
                if (r && r.reason === "too-frequent" && retry) return setTimeout(() => ask(false), 900);
                clearTimeout(timer);
                const res = r && r.ok ? r : null;
                if (res) this.cache.set(k, { ts: Date.now(), res });
                resolve(res);
            });
            ask(true);
        });
    },

    fmtDate(ts) {
        const d = new Date(ts);
        const sameYear = d.getFullYear() === new Date().getFullYear();
        return d.toLocaleDateString(undefined, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
    },

    // One human sentence, or null when there's nothing to say.
    describe(r) {
        if (!r || (!r.visitCount && !r.memoryCount)) return null;
        const bits = [];
        if (r.visitCount) {
            const last = r.visits[0];
            bits.push(r.visitCount === 1
                ? `You rode here on ${this.fmtDate(last.at)}${last.name ? ` (${last.name})` : ""}`
                : `You've ridden here ${r.visitCount} times — last on ${this.fmtDate(r.lastAt)}`);
        }
        if (r.memoryCount) bits.push(`${r.memoryCount} memor${r.memoryCount === 1 ? "y" : "ies"} from here`);
        return bits.join(" · ");
    },

    // Line under a searched destination's route.
    annotate(el, lat, lng) {
        if (!el) return;
        this.lookup(lat, lng, 250).then((r) => {
            const text = this.describe(r);
            if (!text || !el.isConnected) return;
            const div = document.createElement("div");
            div.className = "recall-note";
            div.textContent = `🕘 ${text}`;
            el.insertAdjacentElement("afterend", div);
        });
    },

    // Island, at most once per place per 12 h.
    announceHere(lat, lng, { reason = "parked", name = "" } = {}) {
        const k = this.key(lat, lng);
        const last = this.shownAt.get(k) || 0;
        if (Date.now() - last < 12 * 3600 * 1000) return;
        this.lookup(lat, lng, reason === "arrived" ? 250 : 150).then((r) => {
            const text = this.describe(r);
            if (!text) return;
            this.shownAt.set(k, Date.now());
            const mem = r.memories && r.memories[0];
            const known = mem && typeof memories !== "undefined" && memories.get ? memories.get(mem.id) : null;
            islandShow({
                id: "recall", kind: "info", icon: "🕘",
                title: reason === "arrived" && name ? `Back at ${name}` : "You've been here before",
                sub: text, ttl: 7000, haptic: false,
                action: known && window.MemoryUI ? { label: "See memory", onClick: () => window.MemoryUI.open(known) } : undefined
            });
        });
    },

    clearLocal() { this.cache.clear(); this.shownAt.clear(); }
};
