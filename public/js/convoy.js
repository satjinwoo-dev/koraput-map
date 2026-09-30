"use strict";

/* ============================================================================
   MapUnite client — js/convoy.js
   ==============================================================================
   Convoy intelligence: falling behind / stopped / off-route alerts, relative
   motion between riders, and convoy regroup suggestions (and their UI).

   Classic scripts sharing one global scope (no bundler, no build step),
   loaded by index.html in this order: core → voice → gps → navigation → smartdrive → groupnav → privacy → analytics → deadreckoning → presence → controls → chat → memories → calls → sos → pwa → skunkworks → radio → convoy → boot.
   ============================================================================ */

// ============================================================================
// 6. CONVOY INTELLIGENCE (Phase 3) — roadmap Section 4
// ============================================================================
// "Friend falling behind / stopped unexpectedly / deviated", built only on
// data the app already receives — no new sensors, no new server events:
//   - positions from `friendMoved` (sampled here into a short ring buffer),
//   - each member's real ROAD time-to-destination from the OSRM routes app.js
//     already fetches (tripRoadStats in a group trip, GroupNavigation.
//     memberStats in a meetup) — "behind" is measured in road minutes, not
//     straight-line distance,
//   - each member's route polyline, captured once as their "planned road".
// Active only while you're in a group trip or an active meetup. The first
// evaluation of each rider is silent (joining mid-trip doesn't fire a burst
// of stale alerts); after that, each flag alerts on its rising edge, at most
// once per rider per 5 minutes, and a clearing "moving again" / "back" is
// announced for the two flags that could mean trouble.
const CONVOY_CFG = {
    tickMs: 15000,
    behindMinMin: 5,          // minutes behind the lead before it counts...
    behindPct: 0.15,          // ...or 15% of that rider's own remaining time, whichever is larger
    behindClearRatio: 0.6,    // hysteresis: clears below 60% of the threshold
    behindHoldMs: 45000,      // must persist — one slow OSRM refresh isn't "behind"
    stopMs: 180000,           // stationary this long = stopped
    stopRadiusM: 80,          // parked-phone GPS jitter allowance
    movedKm: 0.3,             // must have actually ridden before a stop counts
    movingKmh: 12,
    arriveRadiusM: 250,
    offRouteM: 150,           // friends' fixes carry no accuracy value — stay conservative
    offRouteFixes: 2,         // two consecutive fixes, like the nav off-route check
    rebaseMs: 240000,         // off their planned road this long = they chose another road
    silentMs: 180000,
    realertMs: 300000,
    maxSamples: 90
};

const ConvoyIntelligence = {
    KEY_ENABLED: "mu_convoy_alerts",
    enabled: true,
    states: new Map(),
    contextKey: null,
    markedIds: new Set(),

    init() {
        try { this.enabled = localStorage.getItem(this.KEY_ENABLED) !== "0"; } catch (e) { /* keep default */ }
        const toggle = document.getElementById("convoy-alerts-toggle");
        if (toggle) {
            toggle.checked = this.enabled;
            toggle.addEventListener("change", () => {
                this.enabled = toggle.checked;
                try { localStorage.setItem(this.KEY_ENABLED, this.enabled ? "1" : "0"); } catch (e) { /* ignore */ }
            });
        }
        // app.js registered its own handlers for these first, so friendData
        // and the markers are already updated when these run.
        socket.on("friendMoved", (u) => this.onFriendMoved(u));
        socket.on("userOffline", () => this.evaluateAll("offline"));
        socket.on("userOnline", (u) => {
            const st = u && this.states.get(u.id);
            if (st) st.lastUpdateTs = Date.now();
            this.evaluateAll("online");
        });
        socket.on("friendDisconnected", () => this.evaluateAll("gone"));
        socket.on("tripData", () => setTimeout(() => this.evaluateAll("trip"), 0));
        setInterval(() => this.evaluateAll("tick"), CONVOY_CFG.tickMs);
    },

    // Which convoy are we in, and where do its numbers come from?
    context() {
        const myId = socket.id;
        if (typeof currentTrip !== "undefined" && currentTrip && Array.isArray(currentTrip.members) && currentTrip.members.some((m) => m.id === myId)) {
            return {
                key: `trip:${currentTrip.id}`, kind: "trip",
                dest: { lat: currentTrip.lat, lng: currentTrip.lng },
                memberIds: currentTrip.members.map((m) => m.id),
                etaMin: (id) => { const s = tripRoadStats[id]; const v = s ? Number(s.time) : NaN; return Number.isFinite(v) ? v : null; },
                routeFor: (id) => this.polylineFrom(tripRoutesLayer, id)
            };
        }
        if (typeof GroupNavigation !== "undefined" && GroupNavigation.active && GroupNavigation.destination) {
            const local = (id) => (id === myId ? "me" : id);
            const d = GroupNavigation.destination;
            return {
                key: `meet:${Number(d.lat).toFixed(5)},${Number(d.lng).toFixed(5)}`, kind: "meetup",
                dest: { lat: d.lat, lng: d.lng },
                memberIds: GroupNavigation.selectedMembers.map((id) => (id === "me" ? myId : id)),
                etaMin: (id) => { const s = GroupNavigation.memberStats && GroupNavigation.memberStats[local(id)]; return s && Number.isFinite(s.timeMin) ? s.timeMin : null; },
                routeFor: (id) => this.polylineFrom(GroupNavigation.layerGroup, local(id))
            };
        }
        return null;
    },

    liveEtas(ctx) {
        const myId = socket.id;
        return ctx.memberIds
            .filter((id) => id === myId || (friendIsLive(friendData[id]) && !((this.states.get(id) || {}).flags || {}).silent))
            .map((id) => ctx.etaMin(id))
            .filter((v) => Number.isFinite(v));
    },

    polylineFrom(layerGroup, memberId) {
        let found = null;
        if (!layerGroup) return null;
        layerGroup.eachLayer((l) => {
            if (!found && l.memberId === memberId && typeof l.getLatLngs === "function") {
                const ll = l.getLatLngs();
                if (Array.isArray(ll) && ll.length >= 2) found = ll.map((p) => [p.lat, p.lng]);
            }
        });
        return found;
    },

    newState(id) {
        return {
            id, samples: [], lastUpdateTs: Date.now(), firstPos: null, anchor: null, everMoved: false,
            plannedPath: null, offStreak: 0, offSince: null, lastXtTs: 0, xt: null,
            behindSince: null, gapMin: null, initialized: false,
            flags: { behind: false, stopped: false, offRoute: false, silent: false, arrived: false, offline: false },
            lastAlertAt: {}
        };
    },

    reset() {
        this.states.clear();
        this.contextKey = null;
        this.applyMarkers();
        this.renderStatus(null);
    },

    onFriendMoved(u) {
        if (!u || !u.id) return;
        const ctx = this.context();
        if (!ctx || u.id === socket.id || !ctx.memberIds.includes(u.id)) return;
        if (ctx.key !== this.contextKey) { this.evaluateAll("context"); }
        let st = this.states.get(u.id);
        if (!st) { st = this.newState(u.id); this.states.set(u.id, st); }
        if (!validCoord(u.lat, u.lng)) { this.evaluateAll("sharing-off"); return; }
        // Phase 4: say once when a rider drops to the radio relay.
        const radio = u.via === "radio";
        if (radio && !st.viaRadio && st.initialized) {
            const name = u.name || (friendData[u.id] && friendData[u.id].name) || "A rider";
            this.alert(st, "radio", {
                island: { kind: "sensor", icon: "📻", title: `${name} has no mobile data`, sub: "Following them over the radio relay", ttl: 6000, haptic: false },
                speech: `${name} is out of mobile signal. Following them over the radio.`, voicePriority: 45
            });
        }
        st.viaRadio = radio;
        const now = Date.now();
        const s = { ts: now, lat: u.lat, lng: u.lng, speedKmh: Number.isFinite(u.speedKmh) ? u.speedKmh : null };
        st.samples.push(s);
        if (st.samples.length > CONVOY_CFG.maxSamples) st.samples.shift();
        st.lastUpdateTs = now;
        if (!st.firstPos) st.firstPos = s;
        // The anchor moves only when the rider leaves an 80 m circle, so
        // `now - anchor.ts` is how long they've been parked.
        if (!st.anchor || map.distance([s.lat, s.lng], [st.anchor.lat, st.anchor.lng]) > CONVOY_CFG.stopRadiusM) st.anchor = s;
        if ((s.speedKmh || 0) > CONVOY_CFG.movingKmh || map.distance([s.lat, s.lng], [st.firstPos.lat, st.firstPos.lng]) > CONVOY_CFG.movedKm * 1000) st.everMoved = true;
        this.evaluateAll("moved");
    },

    displacementM(st, windowMs, now) {
        const recent = st.samples.filter((s) => now - s.ts <= windowMs);
        if (recent.length < 2) return 0;
        const a = recent[0], b = recent[recent.length - 1];
        return map.distance([a.lat, a.lng], [b.lat, b.lng]);
    },

    evaluateAll(reason) {
        const ctx = this.context();
        if (!ctx) { if (this.contextKey || this.states.size) this.reset(); return; }
        if (ctx.key !== this.contextKey) { this.states.clear(); this.contextKey = ctx.key; }

        const myId = socket.id;
        const now = Date.now();
        // Lead = smallest road ETA among riders with CURRENT numbers (me
        // included). A rider flagged silent has a frozen ETA — letting it
        // define the lead would measure everyone against a stale position.
        const etas = this.liveEtas(ctx);
        const leadEta = etas.length >= 2 ? Math.min(...etas) : null;

        let changed = false;
        const live = new Set();
        ctx.memberIds.forEach((id) => {
            if (id === myId) return;
            live.add(id);
            let st = this.states.get(id);
            if (!st) { st = this.newState(id); this.states.set(id, st); }
            if (this.evaluateMember(ctx, st, now, leadEta)) changed = true;
        });
        for (const id of Array.from(this.states.keys())) if (!live.has(id)) { this.states.delete(id); changed = true; }

        this.applyMarkers();
        this.renderStatus(ctx);
        if (changed && reason !== "routes" && ctx.kind === "trip" && typeof updateTripPanel === "function") updateTripPanel();
        document.dispatchEvent(new CustomEvent("mu:convoy-evaluated", { detail: { reason } }));   // Phase 5: ConvoyRegroup listens
    },

    evaluateMember(ctx, st, now, leadEta) {
        const f = friendData[st.id];
        const name = (f && f.name) || "A rider";
        const last = st.samples[st.samples.length - 1];
        const pos = last || (f && validCoord(f.lat, f.lng) ? { lat: f.lat, lng: f.lng, ts: st.lastUpdateTs, speedKmh: f.speedKmh } : null);
        const prev = st.flags;
        const next = { behind: false, stopped: false, offRoute: false, silent: false, arrived: false, offline: false };

        // Phase 4: a rider still heard over the radio relay isn't "offline".
        next.offline = !f || !friendIsLive(f) || !validCoord(f && f.lat, f && f.lng);
        next.silent = next.offline || now - st.lastUpdateTs > CONVOY_CFG.silentMs;
        next.arrived = Boolean(pos && map.distance([pos.lat, pos.lng], [ctx.dest.lat, ctx.dest.lng]) <= CONVOY_CFG.arriveRadiusM);

        const route = ctx.routeFor(st.id);
        if (!st.plannedPath && route) st.plannedPath = route;

        if (!next.silent && !next.arrived && pos) {
            // Stopped: they had been riding, and haven't left an 80 m circle in 3 min.
            next.stopped = Boolean(st.everMoved && st.anchor && now - st.anchor.ts >= CONVOY_CFG.stopMs);

            // Off route: cross-track distance to their PLANNED road, counted
            // once per new fix, only while actually moving.
            if (st.plannedPath && last && last.ts !== st.lastXtTs) {
                st.lastXtTs = last.ts;
                const moving = (Number(last.speedKmh) || 0) > 5 || this.displacementM(st, 30000, now) > 50;
                const xt = pointToPolylineDistanceMeters(last.lat, last.lng, st.plannedPath);
                st.xt = xt;
                if (xt > CONVOY_CFG.offRouteM && moving) { st.offStreak++; if (!st.offSince) st.offSince = now; }
                else if (xt <= CONVOY_CFG.offRouteM * 0.5) { st.offStreak = 0; st.offSince = null; }
            }
            next.offRoute = st.offStreak >= CONVOY_CFG.offRouteFixes;
            if (next.offRoute && st.offSince && now - st.offSince > CONVOY_CFG.rebaseMs && route) {
                // Four minutes on another road is a choice, not a mistake:
                // adopt their current route as the new plan and say so once.
                st.plannedPath = route;
                st.offStreak = 0;
                st.offSince = null;
                next.offRoute = false;
                if (st.initialized) this.alert(st, "rebased", {
                    island: { kind: "info", icon: "↪", title: `${name} took another road`, sub: "Tracking their new route", ttl: 4000, haptic: false },
                    speech: `${name} is taking a different road.`, voicePriority: 40
                });
            }

            // Behind: road minutes behind the lead, with hold time + hysteresis.
            const eta = ctx.etaMin(st.id);
            if (leadEta != null && Number.isFinite(eta)) {
                const gap = eta - leadEta;
                const thr = Math.max(CONVOY_CFG.behindMinMin, CONVOY_CFG.behindPct * eta);
                st.gapMin = Math.round(gap);
                if (gap >= thr) {
                    if (!st.behindSince) st.behindSince = now;
                    next.behind = now - st.behindSince >= CONVOY_CFG.behindHoldMs;
                } else if (gap < thr * CONVOY_CFG.behindClearRatio) {
                    st.behindSince = null;
                } else next.behind = prev.behind;
            } else { st.behindSince = null; st.gapMin = null; }
        } else {
            st.behindSince = null;
            st.offStreak = 0;
            st.offSince = null;
        }

        const changed = Object.keys(next).some((k) => next[k] !== prev[k]);
        if (st.initialized) this.announceTransitions(st, prev, next, name, now);
        st.flags = next;
        st.initialized = true;
        return changed;
    },

    announceTransitions(st, prev, next, name, now) {
        const rose = (k) => next[k] && !prev[k];
        const fell = (k) => !next[k] && prev[k];
        const f = friendData[st.id];
        const view = () => { if (friendData[st.id] && typeof showProfilePopup === "function") showProfilePopup(friendData[st.id]); };
        const fromMe = (() => {
            const p = st.samples[st.samples.length - 1];
            if (!p || !myCoords) return "";
            return ` · ${formatDistanceShort(map.distance([myCoords.lat, myCoords.lng], [p.lat, p.lng]))} from you`;
        })();

        if (rose("silent")) {
            const mins = Math.max(1, Math.round((now - st.lastUpdateTs) / 60000));
            this.alert(st, "silent", {
                island: { kind: "sensor", icon: "📵", title: next.offline ? `${name} went offline` : `No update from ${name}`, sub: next.offline ? "Their live location stopped" : `Nothing for ${mins} min — stopped or out of signal`, ttl: 8000, priority: 54, action: f ? { label: "View", onClick: view } : null },
                speech: next.offline ? `${name} went offline.` : `No location from ${name} for ${mins} minutes.`, voicePriority: 60
            });
        } else if (fell("silent") && !next.silent) {
            this.alert(st, "back", { island: { kind: "safe", icon: "📶", title: `${name} is back`, sub: "Live location restored", ttl: 3500, haptic: false }, speech: `${name}'s location is back.`, voicePriority: 40 }, true);
        }

        if (rose("stopped")) {
            const mins = Math.max(3, Math.round((now - st.anchor.ts) / 60000));
            this.alert(st, "stopped", {
                island: { kind: "sensor", icon: "⏸", title: `${name} has stopped`, sub: `Not moving for ${mins} min${fromMe}`, ttl: 9000, priority: 58, action: f ? { label: "View", onClick: view } : null },
                speech: `${name} has been stopped for ${mins} minutes.`, voicePriority: 70
            });
        } else if (fell("stopped") && !next.silent && !next.arrived) {
            this.alert(st, "moving", { island: { kind: "safe", icon: "▶", title: `${name} is moving again`, ttl: 3500, haptic: false }, speech: `${name} is moving again.`, voicePriority: 40 }, true);
        }

        if (rose("offRoute")) {
            this.alert(st, "offRoute", {
                island: { kind: "sensor", icon: "↪", title: `${name} left the route`, sub: `${Math.round(st.xt || 0)} m off their planned road`, ttl: 7000, priority: 54 },
                speech: `${name} has left the planned route.`, voicePriority: 55
            });
        }

        if (rose("behind")) {
            this.alert(st, "behind", {
                island: { kind: "sensor", icon: "⏳", title: `${name} is falling behind`, sub: `About ${st.gapMin} min behind the lead`, ttl: 7000, priority: 52 },
                speech: `${name} is falling behind, about ${spokenMinutes(st.gapMin)} back.`, voicePriority: 50
            });
        }

        if (rose("arrived")) {
            this.alert(st, "arrived", { island: { kind: "safe", icon: "🏁", title: `${name} arrived`, sub: "At the destination", ttl: 4000, haptic: false }, speech: `${name} has arrived.`, voicePriority: 40 });
        }
    },

    // One alert = Status Island (+ its haptics) + a spoken line. Cooldown is
    // per rider per kind; `bypassCooldown` is for the good-news clears.
    alert(st, kind, spec, bypassCooldown = false) {
        if (!this.enabled) return;
        const now = Date.now();
        if (!bypassCooldown && st.lastAlertAt[kind] && now - st.lastAlertAt[kind] < CONVOY_CFG.realertMs) return;
        st.lastAlertAt[kind] = now;
        const island = { id: `convoy-${st.id}`, ...spec.island };
        if (!island.action) delete island.action;
        islandShow(island);
        if (spec.speech) voiceAnnounce(spec.speech, { priority: spec.voicePriority || 50, key: `convoy-${kind}-${st.id}`, cooldownMs: 60000, category: "convoy" });
    },

    // Worst active issue for one rider, for the trip-panel badge.
    badgeFor(id) {
        const st = this.states.get(id);
        if (!st) return null;
        const fl = st.flags;
        if (fl.stopped && st.anchor) return { text: `⏸ Stopped ${Math.max(3, Math.round((Date.now() - st.anchor.ts) / 60000))} min`, tone: "bad" };
        if (fl.silent) return { text: fl.offline ? "📵 Offline" : "📵 No signal", tone: "bad" };
        if (fl.offRoute) return { text: "↪ Off route", tone: "warn" };
        if (fl.behind) return { text: `⏳ ${st.gapMin} min behind`, tone: "warn" };
        if (fl.arrived) return { text: "🏁 Arrived", tone: "ok" };
        return null;
    },

    sentenceFor(id) {
        const st = this.states.get(id);
        if (!st) return "";
        const f = friendData[id];
        const name = (f && f.name) || "They";
        const fl = st.flags;
        if (fl.stopped && st.anchor) return `${name} has been stopped for ${spokenMinutes((Date.now() - st.anchor.ts) / 60000)}.`;
        if (fl.silent) return fl.offline ? `${name} is offline.` : `There's been no location from ${name} for ${spokenMinutes((Date.now() - st.lastUpdateTs) / 60000)}.`;
        if (fl.offRoute) return `${name} is off the planned route.`;
        if (fl.behind) return `${name} is about ${spokenMinutes(st.gapMin)} behind the lead.`;
        if (fl.arrived) return `${name} has arrived.`;
        return "";
    },

    summary() {
        const ctx = this.context();
        if (!ctx) return "You're not in a group trip or meetup right now.";
        const ids = ctx.memberIds.filter((id) => id !== socket.id);
        if (!ids.length) return "No one else is in this convoy yet.";
        const order = (id) => { const fl = (this.states.get(id) || {}).flags || {}; return fl.stopped ? 0 : fl.silent ? 1 : fl.offRoute ? 2 : fl.behind ? 3 : fl.arrived ? 4 : 5; };
        const sentences = ids.slice().sort((a, b) => order(a) - order(b)).map((id) => this.sentenceFor(id)).filter(Boolean);
        const problems = ids.filter((id) => order(id) <= 3).length;
        let s = problems === 0 ? `All ${ids.length + 1} riders are together.` : "";
        if (sentences.length) s += (s ? " " : "") + sentences.slice(0, 3).join(" ");
        const etas = this.liveEtas(ctx);
        if (etas.length) s += ` The lead is about ${spokenMinutes(Math.min(...etas))} from the destination.`;
        return s.trim();
    },

    renderStatus(ctx) {
        ["convoy-status", "convoy-status-meetup"].forEach((hostId) => {
            const host = document.getElementById(hostId);
            if (!host) return;
            host.textContent = "";
            const relevant = ctx && ((hostId === "convoy-status" && ctx.kind === "trip") || (hostId === "convoy-status-meetup" && ctx.kind === "meetup"));
            if (!relevant) { host.hidden = true; return; }
            host.hidden = false;
            const ids = ctx.memberIds.filter((id) => id !== socket.id);
            const label = document.createElement("span");
            label.className = "convoy-label";
            label.textContent = "Convoy";
            host.appendChild(label);
            const issues = ids.map((id) => ({ id, badge: this.badgeFor(id) })).filter((x) => x.badge && x.badge.tone !== "ok");
            if (!ids.length) {
                const c = document.createElement("span"); c.className = "chip"; c.textContent = "Waiting for riders"; host.appendChild(c);
                return;
            }
            if (!issues.length) {
                const c = document.createElement("span"); c.className = "chip ok"; c.textContent = `Together · ${ids.length + 1} riders`; host.appendChild(c);
                return;
            }
            issues.forEach(({ id, badge }) => {
                const c = document.createElement("span");
                c.className = `chip ${badge.tone}`;
                const f = friendData[id];
                c.textContent = `${(f && f.name) || "Rider"}: ${badge.text}`;
                host.appendChild(c);
            });
        });
    },

    // A status ring on the friend's map marker (text lives in the badge /
    // status line, so this is never color alone).
    applyMarkers() {
        const now = new Set();
        this.states.forEach((st, id) => {
            const m = typeof friendMarkers !== "undefined" ? friendMarkers[id] : null;
            const el = m && typeof m.getElement === "function" ? m.getElement() : null;
            if (!el) return;
            const fl = st.flags;
            const state = fl.stopped ? "stopped" : fl.silent ? "silent" : (fl.offRoute || fl.behind) ? "warn" : "";
            if (state) { el.setAttribute("data-convoy", state); now.add(id); }
            else el.removeAttribute("data-convoy");
        });
        this.markedIds.forEach((id) => {
            if (now.has(id)) return;
            const m = typeof friendMarkers !== "undefined" ? friendMarkers[id] : null;
            const el = m && typeof m.getElement === "function" ? m.getElement() : null;
            if (el) el.removeAttribute("data-convoy");
        });
        this.markedIds = now;
    }
};

// ============================================================================
// 9. RELATIVE MOTION (Phase 5) — bearing, closing speed, CPA, time-to-meet
// ============================================================================
// Pure trigonometry over data the app already has: each rider's recent
// positions (friendMoved, radio relay, own GPS / dead-reckoning). No new
// sensors, no new socket events.
//
//   Local frame   every position -> metres east/north of ME (equirectangular
//                 tangent plane; < 1 m/km error at convoy distances).
//   Velocity      weighted least-squares line through the last ~45 s of a
//                 rider's track (weights 1/accuracy²), with a 1-σ velocity
//                 error from the fit residual. Late positions (radio pings
//                 carry the ORIGIN's timestamp) are extrapolated to "now",
//                 at most 60 s.
//   Relative      r = p_friend - p_me, v = v_friend - v_me
//     closing speed   -(r·v)/|r|            (+ = getting closer)
//     CPA             t* = -(r·v)/|v|²,  d_cpa = |r + v·t*|
//     time-to-meet    first t > 0 with |r + v·t| = R (R = 150 m):
//                     |v|²t² + 2(r·v)t + |r|² - R² = 0
//     bearing rate    (r × v)/|r|²  — near zero while closing = constant
//                     bearing, decreasing range: a collision course.
//   Honesty       forecasts are straight-line, so capped at 30 min and only
//                 made when |v_rel| is clearly above its own noise (2σ).
const RM_CFG = Object.freeze({
    windowMs: 45000,          // track window used for the velocity fit
    minSpanMs: 8000,          // need at least this much track...
    minSamples: 3,            // ...and this many fixes
    maxSamples: 60,
    staleMs: 120000,          // newest fix older than this: no velocity
    maxExtrapMs: 60000,       // carry a late position forward at most this far
    posSigmaM: 6,             // floor for GPS position noise
    rangeRateMs: 0.5,         // |closing speed| below this = holding distance
    meetRadiusM: 150,         // "meet" = within this distance of each other
    passedWindowS: 180,       // an OBSERVED closest approach in the last 3 min + now opening = "passed"
    passedCpaM: 400,
    horizonS: 1800,           // no straight-line forecast beyond 30 min
    confirmEvals: 2           // a new status must repeat before it's reported
});

const RelativeMotion = {
    tracks: new Map(),        // key (ownerKey | id | "me") -> [{t, lat, lng, acc}]
    status: new Map(),        // key -> {shown, pending, count}
    lastMe: null,

    init() {
        socket.on("friendMoved", (u) => this.onPosition(u));
        socket.on("friendDisconnected", (id) => { const f = friendData[id]; if (!f || !f.ownerKey) this.tracks.delete(String(id)); });
        // Own track: sample myCoords (GPS fix or tunnel-mode estimate) at 1 Hz.
        setInterval(() => this.sampleMe(), 1000);
        // Keep every live rider's relation (range history + hysteresis) current.
        setInterval(() => { try { this.all(); } catch (e) { /* no position yet */ } }, 2000);
    },

    keyFor(u) { return (u && (u.ownerKey || u.id)) ? String(u.ownerKey || u.id) : null; },

    push(key, s) {
        let tr = this.tracks.get(key);
        if (!tr) { tr = []; this.tracks.set(key, tr); }
        const last = tr[tr.length - 1];
        if (last && s.t <= last.t) {
            // Out of order (a delayed radio frame): insert in place, drop exact duplicates.
            if (tr.some((x) => x.t === s.t)) return;
            tr.push(s); tr.sort((a, b) => a.t - b.t);
        } else tr.push(s);
        const cutoff = s.t - Math.max(RM_CFG.windowMs * 2, RM_CFG.staleMs);
        while (tr.length && (tr[0].t < cutoff || tr.length > RM_CFG.maxSamples)) tr.shift();
    },

    onPosition(u) {
        if (!u || !validCoord(u.lat, u.lng) || u.approx) return;          // a 1 km cell has no usable motion
        if (typeof socket !== "undefined" && u.id === socket.id) return;
        const key = this.keyFor(u);
        if (!key) return;
        const t = Number.isFinite(u.fixAt) ? u.fixAt : Date.now();
        this.push(key, { t, lat: u.lat, lng: u.lng, acc: Number.isFinite(u.accuracy) ? u.accuracy : 10 });
    },

    sampleMe() {
        if (!myCoords || !validCoord(myCoords.lat, myCoords.lng)) return;
        const now = Date.now(), p = this.lastMe;
        // Keep a sample at least every 5 s even when parked, so "not moving" is measurable.
        if (p && p.lat === myCoords.lat && p.lng === myCoords.lng && now - p.t < 5000) return;
        this.lastMe = { t: now, lat: myCoords.lat, lng: myCoords.lng };
        this.push("me", { t: now, lat: myCoords.lat, lng: myCoords.lng, acc: Number.isFinite(myCoords.accuracy) ? myCoords.accuracy : 10 });
    },

    // metres east / north of `ref`
    toXY(lat, lng, ref) {
        const k = Math.cos((ref.lat * Math.PI) / 180);
        return [(lng - ref.lng) * 111320 * k, (lat - ref.lat) * 110540];
    },

    // Kinematic state of one track, in the frame of `ref`, at time `now`.
    estimate(key, ref, now = Date.now()) {
        const tr = this.tracks.get(key);
        if (!tr || !tr.length) return null;
        const last = tr[tr.length - 1];
        const age = now - last.t;
        const win = tr.filter((s) => last.t - s.t <= RM_CFG.windowMs);
        const pLast = this.toXY(last.lat, last.lng, ref);
        const base = { key, pos: pLast, v: [0, 0], sigmaV: Infinity, speed: null, heading: null, n: win.length, spanS: 0, ageS: age / 1000, valid: false };
        if (age > RM_CFG.staleMs || win.length < RM_CFG.minSamples || last.t - win[0].t < RM_CFG.minSpanMs) return base;

        // Weighted least squares x(t), y(t) = a + b·t  (t centred)
        const pts = win.map((s) => ({ t: (s.t - last.t) / 1000, xy: this.toXY(s.lat, s.lng, ref), w: 1 / Math.max(RM_CFG.posSigmaM, s.acc) ** 2 }));
        const W = pts.reduce((a, p) => a + p.w, 0);
        const tm = pts.reduce((a, p) => a + p.w * p.t, 0) / W;
        const xm = [0, 1].map((k) => pts.reduce((a, p) => a + p.w * p.xy[k], 0) / W);
        const Stt = pts.reduce((a, p) => a + p.w * (p.t - tm) ** 2, 0);
        if (!(Stt > 0)) return base;
        const v = [0, 1].map((k) => pts.reduce((a, p) => a + p.w * (p.t - tm) * (p.xy[k] - xm[k]), 0) / Stt);
        // residual RMS -> velocity 1-σ (per axis, combined)
        let ss = 0;
        pts.forEach((p) => { for (let k = 0; k < 2; k++) { const fit = xm[k] + v[k] * (p.t - tm); ss += (p.xy[k] - fit) ** 2; } });
        const dof = Math.max(1, 2 * pts.length - 4);
        const sigmaPos = Math.max(RM_CFG.posSigmaM, Math.sqrt(ss / dof));
        const sumT2 = pts.reduce((a, p) => a + (p.t - tm) ** 2, 0);
        const sigmaV = (sigmaPos / Math.sqrt(sumT2)) * Math.SQRT2;
        // Position "now": fitted position at the last fix, carried forward (bounded).
        const extra = Math.min(age, RM_CFG.maxExtrapMs) / 1000;
        const pos = [0, 1].map((k) => xm[k] + v[k] * (0 - tm) + v[k] * extra);
        const speed = Math.hypot(v[0], v[1]);
        return {
            ...base, pos, v, sigmaV, speed, valid: true, spanS: (last.t - win[0].t) / 1000,
            heading: speed > 1 ? (((Math.atan2(v[0], v[1]) * 180) / Math.PI) + 360) % 360 : null
        };
    },

    // Pure relative-motion maths between two kinematic states (exported for tests).
    relate(a, b) {
        const r = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]];
        const v = [b.v[0] - a.v[0], b.v[1] - a.v[1]];
        const d = Math.hypot(r[0], r[1]);
        const vv = v[0] * v[0] + v[1] * v[1];
        const rv = r[0] * v[0] + r[1] * v[1];
        const bearing = ((Math.atan2(r[0], r[1]) * 180) / Math.PI + 360) % 360;
        const out = {
            distanceM: d, bearingDeg: bearing, closingMs: d > 0 ? -rv / d : 0, relSpeedMs: Math.sqrt(vv),
            bearingRateDegS: d > 1 ? (((r[0] * v[1] - r[1] * v[0]) / (d * d)) * 180) / Math.PI : 0,
            cpaS: null, cpaM: null, meetInS: null, status: "unknown", confidence: 0,
            relVelMs: v                                  // east/north m/s, for the radar's motion arrow
        };
        const sigmaRel = Math.hypot(a.sigmaV, b.sigmaV);
        if (!a.valid || !b.valid || !Number.isFinite(sigmaRel)) return out;
        out.confidence = Math.max(0, Math.min(1, 1 - sigmaRel / Math.max(1, out.relSpeedMs)));
        // Relative motion within its own noise: all we can say is "about the same distance".
        if (out.relSpeedMs < 2 * sigmaRel || Math.abs(out.closingMs) < RM_CFG.rangeRateMs) { out.status = "holding"; return out; }
        const tStar = -rv / vv;
        out.cpaS = tStar;
        out.cpaM = Math.hypot(r[0] + v[0] * tStar, r[1] + v[1] * tStar);
        const R = RM_CFG.meetRadiusM;
        // Sideways velocity noise grows into miss-distance noise over t*:
        // "on course to meet" allows for it (2σ), so an overtake on the same
        // road isn't misread as "will pass apart" because of GPS jitter.
        const sigmaCpa = sigmaRel * Math.max(0, tStar);
        if (out.closingMs > 0) {
            if (d <= R) { out.status = "together"; out.meetInS = 0; }
            else if (tStar <= RM_CFG.horizonS && out.cpaM <= R + 2 * sigmaCpa) {
                const disc = rv * rv - vv * (d * d - R * R);
                out.meetInS = disc >= 0 ? (-rv - Math.sqrt(disc)) / vv : Math.max(0, tStar - R / Math.sqrt(vv));
                out.status = "meeting";
            } else out.status = tStar <= RM_CFG.horizonS ? "approaching" : "approaching-slowly";
        } else {
            // Opening. "passed" needs EVIDENCE — relation() checks the observed
            // range history; the straight line traced backwards isn't enough
            // (two riders who started apart would "have passed" each other).
            out.status = "moving-away";
        }
        return out;
    },

    // Relation between me and one friend (friendData id).
    relation(id, now = Date.now()) {
        const f = friendData[id];
        if (!f || !myCoords || !validCoord(myCoords.lat, myCoords.lng)) return null;
        const key = this.keyFor(f);
        const ref = { lat: myCoords.lat, lng: myCoords.lng };
        const me = this.estimate("me", ref, now);
        const fr = this.estimate(key, ref, now);
        if (!me || !fr) return null;
        const rel = this.relate(me, fr);
        // Clock position relative to MY direction of travel (only when moving).
        rel.clock = me.heading == null ? null : (Math.round((((rel.bearingDeg - me.heading) + 360) % 360) / 30) % 12) || 12;
        rel.id = id; rel.name = f.name; rel.mySpeedMs = me.speed; rel.theirSpeedMs = fr.speed; rel.ageS = fr.ageS;
        const st = this.status.get(key) || { shown: rel.status, pending: null, count: 0, hist: [] };
        // Observed range history (3 min): "passed" = the range really reached a
        // minimum (≤ 400 m) in that window and has opened by 50 m+ since.
        st.hist.push({ t: now, d: rel.distanceM });
        while (st.hist.length && now - st.hist[0].t > RM_CFG.passedWindowS * 1000) st.hist.shift();
        if (rel.status === "moving-away" && st.hist.length >= 3) {
            let min = st.hist[0];
            st.hist.forEach((h) => { if (h.d < min.d) min = h; });
            if (min !== st.hist[0] && min.d <= RM_CFG.passedCpaM && rel.distanceM - min.d > 50) {
                rel.status = "passed"; rel.cpaS = (min.t - now) / 1000; rel.cpaM = min.d;
            }
        }
        // Hysteresis: a changed status must repeat before it's reported.
        if (rel.status !== st.shown) {
            if (st.pending === rel.status) st.count++; else { st.pending = rel.status; st.count = 1; }
            if (st.count >= RM_CFG.confirmEvals || rel.confidence > 0.8) { st.shown = rel.status; st.pending = null; st.count = 0; }
        } else { st.pending = null; st.count = 0; }
        this.status.set(key, st);
        rel.rawStatus = rel.status;
        rel.status = st.shown;
        return rel;
    },

    all(now = Date.now()) {
        return Object.keys(friendData)
            .filter((id) => friendIsLive(friendData[id]) && validCoord(friendData[id].lat, friendData[id].lng) && !friendData[id].approx)
            .map((id) => this.relation(id, now))
            .filter(Boolean)
            .sort((a, b) => a.distanceM - b.distanceM);
    },

    // Short text ("Approaching · closing 42 km/h · meet in ~3 min") and a spoken sentence.
    describe(rel) {
        if (!rel) return { text: "", speech: "" };
        const kmh = (ms) => Math.round(Math.abs(ms) * 3.6);
        const where = rel.clock ? `at your ${rel.clock} o'clock` : `${["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(rel.bearingDeg / 45) % 8]} of you`;
        const dist = spokenDistance(rel.distanceM);
        const mins = (s) => spokenMinutes(s / 60);
        switch (rel.status) {
            case "together": return { text: "Together", speech: `${rel.name} is right with you.` };
            case "meeting": return { text: `Approaching · closing ${kmh(rel.closingMs)} km/h · meet in ~${Math.max(1, Math.round(rel.meetInS / 60))} min`, speech: `${rel.name} is ${dist} ${where}, closing at ${kmh(rel.closingMs)} kilometres per hour. You'll meet in about ${mins(rel.meetInS)}.` };
            case "approaching": return { text: `Approaching · will pass ${formatDistanceShort(rel.cpaM)} apart in ~${Math.max(1, Math.round(rel.cpaS / 60))} min`, speech: `${rel.name} is ${dist} ${where} and getting closer, but on this heading you'll pass about ${spokenDistance(rel.cpaM)} apart.` };
            case "approaching-slowly": return { text: `Closing slowly · ${kmh(rel.closingMs)} km/h`, speech: `${rel.name} is ${dist} ${where}, closing slowly.` };
            case "passed": return { text: `Passed ~${Math.max(1, Math.round(-rel.cpaS / 60))} min ago · now ${formatDistanceShort(rel.distanceM)}`, speech: `You passed ${rel.name} about ${mins(-rel.cpaS)} ago; ${dist} ${where} now.` };
            case "moving-away": return { text: `Moving apart · ${kmh(rel.closingMs)} km/h`, speech: `${rel.name} is ${dist} ${where} and moving away at ${kmh(rel.closingMs)} kilometres per hour.` };
            case "holding": return { text: "Holding distance", speech: `${rel.name} is ${dist} ${where}, keeping about the same distance.` };
            default: return { text: "Motion unknown yet", speech: `${rel.name} is ${dist} ${where}.` };
        }
    }
};

// ============================================================================
// 10. CONVOY REGROUP (Phase 5) — who should ease off (or catch up) to converge
// ============================================================================
// Phase 3 says "Priya is 9 min behind". This says what to DO about it, from
// a small graph over the riders' travel times to the shared destination.
//
//   Nodes   riders still moving (stopped / no-signal riders are the convoy
//           alerts' job and are left out). Each node's potential φ_i =
//           minutes from the destination.
//   Unary   φ_i ≈ ê_i: the rider's OSRM road ETA, aged by the minutes since
//           it was fetched while they're moving; σ grows with ETA and age.
//   Edges   φ_j − φ_i ≈ Δ_ij: when rider j is ON rider i's planned route
//           (≤ 60 m cross-track), their along-road gap / i's road pace. A
//           direct measurement, independent of when each ETA was fetched —
//           so it gets more weight.
//   Solve   weighted least squares (L_w + W_0)·φ = W_0·ê + Σ edge terms —
//           an n ≤ 8 linear system, Gaussian elimination.
//   Plan    tail = last moving rider. A rider g minutes ahead reaches the
//           tail's timing over horizon H by riding at s·H/(H+g) (covering
//           L = s·H at the slower speed costs exactly g extra minutes). If
//           that's under 70 % of their speed or 25 km/h: "stop for ~g min at
//           the next safe spot" instead. The tail is only nudged to speed up
//           when riding 25 %+ below that road's usual pace, and never above
//           that pace or 80 km/h. Nobody is ever told to speed.
const REGROUP_CFG = Object.freeze({
    everyMs: 30000,
    minSpreadMin: 5, spreadPct: 0.15, clearRatio: 0.6,   // same thresholds as "falling behind"
    horizonMin: 15,
    toleranceMin: 1,          // gaps under this need no action
    minSlowFactor: 0.7, minSlowKmh: 25,
    maxKmh: 75,               // stays under the app's own 80 km/h "Speed check" tier
    minCatchupGainKmh: 10,    // "speed up by 5" isn't advice worth giving
    catchupSlackPct: 0.25,
    onRouteM: 60,
    nearArrivalMin: 5,        // lead this close: just regroup at the destination
    maxRoadsideWaitMin: 20,   // a chai / fuel stop; a bigger gap closes at the destination, not on the road
    changeTolPct: 0.1
});

// Solve A·x = b (small dense system) by Gaussian elimination with partial pivoting.
function solveLinear(A, b) {
    const n = b.length, M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        if (Math.abs(M[p][c]) < 1e-12) return null;
        [M[c], M[p]] = [M[p], M[c]];
        for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
    return x;
}

const ConvoyRegroup = {
    plan: null,
    active: false,
    lastEmitted: null,
    lastRun: 0,

    init() {
        setInterval(() => this.update("tick"), REGROUP_CFG.everyMs);
        document.addEventListener("mu:convoy-evaluated", () => this.update("convoy"));
    },

    // ---- pure core (exported for tests) ----------------------------------------
    // riders: [{id, etaMin, etaAgeMin, moving, speedKmh, routeAvgKmh}]
    // edges:  [{i, j, deltaMin, sigmaMin}]   (φ_j − φ_i ≈ deltaMin)
    solve(riders, edges) {
        const n = riders.length;
        if (!n) return [];
        const A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
        riders.forEach((r, i) => {
            const aged = Math.max(0, r.etaMin - (r.moving ? r.etaAgeMin : 0));
            const sigma = 0.5 + 0.1 * aged + 0.5 * r.etaAgeMin;
            const w = 1 / (sigma * sigma);
            A[i][i] += w; b[i] += w * aged;
        });
        edges.forEach(({ i, j, deltaMin, sigmaMin }) => {
            const w = 1 / (sigmaMin * sigmaMin);
            A[i][i] += w; A[j][j] += w; A[i][j] -= w; A[j][i] -= w;
            b[j] += w * deltaMin; b[i] -= w * deltaMin;
        });
        return solveLinear(A, b) || riders.map((r) => Math.max(0, r.etaMin - (r.moving ? r.etaAgeMin : 0)));
    },

    // phi: solved minutes-to-destination per rider (same order as riders)
    suggest(riders, phi, prevActive = false) {
        const C = REGROUP_CFG;
        const idx = riders.map((_, i) => i).sort((a, b) => phi[a] - phi[b]);
        const lead = idx[0], tail = idx[idx.length - 1];
        const spread = phi[tail] - phi[lead];
        const thr = Math.max(C.minSpreadMin, C.spreadPct * phi[tail]);
        const active = riders.length >= 2 && (spread >= thr || (prevActive && spread >= thr * C.clearRatio));
        const out = { active, spreadMin: spread, thresholdMin: thr, leadId: riders[lead] && riders[lead].id, tailId: riders[tail] && riders[tail].id, horizonMin: null, atDestination: false, actions: [] };
        if (!active) return out;
        if (phi[lead] <= C.nearArrivalMin || spread > C.maxRoadsideWaitMin) {
            // Lead nearly there, or a gap no roadside stop should absorb:
            // everyone ahead carries on and waits at the destination.
            out.atDestination = true;
            out.destinationReason = phi[lead] <= C.nearArrivalMin ? "lead-arriving" : "gap-too-big";
            out.actions = riders.map((r, i) => ({ id: r.id, action: i === tail ? "hold" : "wait-at-destination", gapMin: phi[tail] - phi[i] }));
            return out;
        }
        const H = Math.max(3, Math.min(C.horizonMin, phi[lead] * 0.8));
        out.horizonMin = H;
        // Tail catch-up (only if well below the road's usual pace; capped).
        const t = riders[tail];
        let tailGain = 0, tailAction = { id: t.id, action: "hold", gapMin: 0 };
        if (t.speedKmh > 5 && t.routeAvgKmh && t.speedKmh < (1 - C.catchupSlackPct) * t.routeAvgKmh) {
            const target = Math.min(t.routeAvgKmh, C.maxKmh);
            if (target >= t.speedKmh + C.minCatchupGainKmh) {
                tailGain = Math.min(spread / 2, H * (target / t.speedKmh - 1));
                tailAction = { id: t.id, action: "catch-up", targetKmh: Math.floor(target / 5) * 5, gapMin: 0, gainMin: tailGain };
            }
        }
        out.actions = riders.map((r, i) => {
            if (i === tail) return tailAction;
            const g = phi[tail] - phi[i] - tailGain;
            if (g < C.toleranceMin) return { id: r.id, action: "hold", gapMin: Math.max(0, g) };
            const s = r.speedKmh > 5 ? r.speedKmh : (r.routeAvgKmh || 0);
            const slowed = s * H / (H + g);
            if (s > 0 && slowed >= Math.max(C.minSlowFactor * s, C.minSlowKmh)) {
                return { id: r.id, action: "slow", targetKmh: Math.max(C.minSlowKmh, Math.floor(slowed / 5) * 5), fromKmh: Math.round(s), gapMin: g };
            }
            return { id: r.id, action: "wait", waitMin: Math.ceil(g), gapMin: g };
        });
        return out;
    },

    // ---- live wiring --------------------------------------------------------------
    // Build the graph from what ConvoyIntelligence already tracks.
    snapshot(now = Date.now()) {
        const ctx = typeof ConvoyIntelligence !== "undefined" ? ConvoyIntelligence.context() : null;
        if (!ctx || !myCoords) return null;
        const myId = socket.id;
        const riders = [];
        const routes = [];
        const statsFor = (id) => {
            if (ctx.kind === "trip") { const s = tripRoadStats[id]; return s && Number.isFinite(Number(s.time)) ? { eta: Number(s.time), ts: s.ts || now } : null; }
            const s = GroupNavigation.memberStats && GroupNavigation.memberStats[id === myId ? "me" : id];
            return s && Number.isFinite(s.timeMin) ? { eta: s.timeMin, ts: s.ts || now } : null;
        };
        ctx.memberIds.forEach((id) => {
            const isMe = id === myId;
            const f = isMe ? null : friendData[id];
            if (!isMe && (!friendIsLive(f) || !validCoord(f.lat, f.lng))) return;
            const flags = isMe ? {} : ((ConvoyIntelligence.states.get(id) || {}).flags || {});
            if (flags.stopped || flags.silent || flags.arrived) return;         // the convoy alerts' job
            const st = statsFor(id);
            if (!st) return;
            const ref = { lat: myCoords.lat, lng: myCoords.lng };
            const est = RelativeMotion.estimate(isMe ? "me" : RelativeMotion.keyFor(f), ref, now);
            const speedKmh = est && est.valid ? est.speed * 3.6 : (isMe ? (myCoords.speedKmh || 0) : (f.speedKmh || 0));
            const path = ctx.routeFor(id);
            const route = path ? DRMath.prepareRoute(path) : null;
            const pos = isMe ? { lat: myCoords.lat, lng: myCoords.lng } : { lat: f.lat, lng: f.lng };
            riders.push({
                id, name: isMe ? "You" : f.name, isMe, pos, etaMin: st.eta, etaAgeMin: Math.max(0, (now - st.ts) / 60000),
                moving: speedKmh > 8, speedKmh, routeAvgKmh: route && st.eta > 0 ? (route.total / 1000) / (st.eta / 60) : null
            });
            routes.push(route);
        });
        if (riders.length < 2) return null;
        // Direct along-road gap edges.
        const edges = [];
        riders.forEach((ri, i) => {
            const route = routes[i];
            if (!route || !ri.routeAvgKmh) return;
            const me = DRMath.projectOnRoute(route, ri.pos.lat, ri.pos.lng);
            if (me.distM > REGROUP_CFG.onRouteM) return;
            riders.forEach((rj, j) => {
                if (j <= i) return;
                const pj = DRMath.projectOnRoute(route, rj.pos.lat, rj.pos.lng);
                if (pj.distM > REGROUP_CFG.onRouteM) return;
                const gapMin = ((pj.s - me.s) / 1000) / ri.routeAvgKmh * 60;  // + = j further along = closer to the destination
                edges.push({ i, j, deltaMin: -gapMin, sigmaMin: 0.5 + 0.05 * Math.abs(gapMin) });
            });
        });
        return { ctx, riders, routes, edges };
    },

    // Where the convoy comes back together: on the lead's route, after the
    // lead rides the horizon at the suggested (slower) speed.
    regroupPoint(snap, plan) {
        if (!plan || !plan.active || plan.atDestination || !plan.horizonMin) return null;
        const li = snap.riders.findIndex((r) => r.id === plan.leadId);
        const route = snap.routes[li];
        const act = plan.actions.find((a) => a.id === plan.leadId);
        if (!route || !act) return null;
        const pr = DRMath.projectOnRoute(route, snap.riders[li].pos.lat, snap.riders[li].pos.lng);
        const kmh = act.action === "slow" ? act.targetKmh : act.action === "wait" ? snap.riders[li].speedKmh * Math.max(0, plan.horizonMin - act.waitMin) / plan.horizonMin : snap.riders[li].speedKmh;
        const p = DRMath.pointAtS(route, pr.s + (kmh / 3.6) * plan.horizonMin * 60);
        return { lat: p.lat, lng: p.lng, inMin: plan.horizonMin };
    },

    update(reason) {
        // Convoy evaluations fire on every position update; the plan needs 5 s at most.
        const now = Date.now();
        if (reason !== "tick" && this.lastRun && now - this.lastRun < 5000) return;
        this.lastRun = now;
        const snap = this.snapshot();
        if (!snap) { if (this.plan) { this.plan = null; this.active = false; this.emit(null); } return; }
        const phi = this.solve(snap.riders, snap.edges);
        const plan = this.suggest(snap.riders, phi, this.active);
        plan.riders = snap.riders.map((r, i) => ({ id: r.id, name: r.name, isMe: r.isMe, phiMin: phi[i], speedKmh: r.speedKmh }));
        plan.point = this.regroupPoint(snap, plan);
        plan.at = Date.now(); plan.reason = reason;
        this.active = plan.active;
        const changed = this.materiallyDifferent(this.lastEmitted, plan);
        this.plan = plan;
        if (changed) this.emit(plan);
    },

    // A new plan is worth announcing only if it switched on/off, someone's
    // action changed, or a target speed / wait moved by more than 10 %.
    materiallyDifferent(a, b) {
        if (!a || !b) return a !== b;
        if (a.active !== b.active || a.actions.length !== b.actions.length) return true;
        return a.actions.some((x, i) => {
            const y = b.actions[i];
            if (!y || x.id !== y.id || x.action !== y.action) return true;
            const vx = x.targetKmh || x.waitMin || 0, vy = y.targetKmh || y.waitMin || 0;
            return Math.abs(vx - vy) > REGROUP_CFG.changeTolPct * Math.max(1, vx);
        });
    },

    emit(plan) {
        this.lastEmitted = plan;
        document.dispatchEvent(new CustomEvent("mu:regroup", { detail: plan }));
    },

    // Plain-language line for one rider's action ("You: ease off to 45 km/h").
    sentenceFor(a, name) {
        if (!a) return "";
        switch (a.action) {
            case "slow": return `${name}: ease off to about ${a.targetKmh} km/h (from ${a.fromKmh}) — the convoy closes up in ~${Math.round(this.plan && this.plan.horizonMin || REGROUP_CFG.horizonMin)} min`;
            case "wait": return `${name}: take a break at the next safe stop (chai / fuel) for about ${a.waitMin} min`;
            case "catch-up": return `${name}: this road usually allows about ${a.targetKmh} km/h — no need to hang back`;
            case "wait-at-destination": return this.plan && this.plan.destinationReason === "gap-too-big"
                ? `${name}: the convoy is ${Math.round(this.plan.spreadMin)} min apart — too far to close on the road; carry on and regroup at the destination`
                : `${name}: you're nearly there — wait at the destination`;
            default: return "";
        }
    }
};

// ============================================================================
// 11. PHASE 5 ON SCREEN + IN VOICE — relative motion and regroup
// ============================================================================
// Everything here only READS RelativeMotion / ConvoyRegroup:
//   - rider popup: a live motion line ("Approaching · meet in ~3 min");
//   - radar: motion label per rider + a relative-motion arrow on the canvas
//     (P2PRadar calls motionFor / arrowFor);
//   - trip panel + meetup sheet: a regroup block, YOUR line highlighted;
//   - map: a "Regroup here" pin where the convoy closes up;
//   - voice: your own suggestion once when it changes, "back together" when
//     it clears, and a heads-up when a convoy rider is about to meet you.
const Phase5UI = {
    KEY_ENABLED: "mu_regroup_hints",
    enabled: true,
    layer: null,
    pin: null,
    lastMine: null,
    wasActive: false,
    meetAnnounced: new Map(),       // friend key -> ts

    init() {
        try { this.enabled = localStorage.getItem(this.KEY_ENABLED) !== "0"; } catch (e) { /* keep default */ }
        const toggle = document.getElementById("regroup-toggle");
        if (toggle) {
            toggle.checked = this.enabled;
            toggle.addEventListener("change", () => {
                this.enabled = toggle.checked;
                try { localStorage.setItem(this.KEY_ENABLED, this.enabled ? "1" : "0"); } catch (e) { /* ignore */ }
                this.onPlan(ConvoyRegroup.plan);
            });
        }
        this.layer = L.layerGroup().addTo(map);
        document.addEventListener("mu:regroup", (e) => this.onPlan(e.detail));
        setInterval(() => this.tick(), 4000);
    },

    // ---- regroup ------------------------------------------------------------------
    onPlan(plan) {
        const show = Boolean(this.enabled && plan && plan.active);
        this.renderPanels(show ? plan : null);
        this.renderPin(show ? plan : null);
        if (!this.enabled) { this.wasActive = false; this.lastMine = null; return; }
        this.speakForMe(plan);
    },

    myAction(plan) { return plan && plan.actions ? plan.actions.find((a) => a.id === socket.id) : null; },
    nameOf(plan, id) { const r = plan.riders && plan.riders.find((x) => x.id === id); return r ? r.name : "A rider"; },

    renderPanels(plan) {
        const ctx = typeof ConvoyIntelligence !== "undefined" ? ConvoyIntelligence.context() : null;
        [["regroup-panel", "trip"], ["regroup-panel-meetup", "meetup"]].forEach(([id, kind]) => {
            const host = document.getElementById(id);
            if (!host) return;
            host.textContent = "";
            if (!plan || !ctx || ctx.kind !== kind) { host.hidden = true; return; }
            host.hidden = false;
            const head = document.createElement("div");
            head.className = "regroup-head";
            const label = document.createElement("span"); label.className = "convoy-label"; label.textContent = "Regroup";
            const spread = document.createElement("span"); spread.className = "chip warn"; spread.textContent = `${Math.round(plan.spreadMin)} min apart`;
            head.append(label, spread);
            host.appendChild(head);
            const list = document.createElement("ul");
            list.className = "regroup-list";
            const mine = this.myAction(plan);
            const ordered = plan.actions.slice().sort((a, b) => (b === mine) - (a === mine));
            ordered.forEach((a) => {
                const text = ConvoyRegroup.sentenceFor(a, a.id === socket.id ? "You" : this.nameOf(plan, a.id));
                if (!text) return;
                const li = document.createElement("li");
                li.className = `regroup-item ${a.action}${a.id === socket.id ? " mine" : ""}`;
                li.textContent = text;
                list.appendChild(li);
            });
            if (!list.children.length) {
                const li = document.createElement("li"); li.className = "regroup-item"; li.textContent = "Keep riding — the others are closing up.";
                list.appendChild(li);
            }
            host.appendChild(list);
        });
    },

    renderPin(plan) {
        this.layer.clearLayers();
        this.pin = null;
        if (!plan || !plan.point || plan.atDestination) return;
        this.pin = L.marker([plan.point.lat, plan.point.lng], {
            icon: L.divIcon({ className: "regroup-pin", html: '<div class="regroup-pin-dot" aria-hidden="true">⟲</div>', iconSize: [34, 34], iconAnchor: [17, 17] }),
            zIndexOffset: 800
        }).bindTooltip(`Regroup here · ~${Math.round(plan.point.inMin)} min`, { permanent: true, direction: "top", className: "weather-badge" }).addTo(this.layer);
    },

    speechFor(a, plan) {
        switch (a.action) {
            case "slow": return `Convoy regroup. Ease off to about ${a.targetKmh} kilometres per hour; the group closes up in about ${spokenMinutes(plan.horizonMin)}.`;
            case "wait": return `Convoy regroup. Take a break at the next safe stop for about ${spokenMinutes(a.waitMin)}.`;
            case "catch-up": return `This road usually allows about ${a.targetKmh} kilometres per hour. No need to hang back.`;
            case "wait-at-destination": return plan.destinationReason === "gap-too-big"
                ? `The convoy is ${spokenMinutes(plan.spreadMin)} apart. Carry on and regroup at the destination.`
                : "You're nearly there. Wait for the others at the destination.";
            default: return "";
        }
    },

    speakForMe(plan) {
        const active = Boolean(plan && plan.active);
        const mine = active ? this.myAction(plan) : null;
        const sig = mine ? `${mine.action}:${mine.targetKmh || mine.waitMin || 0}:${plan.destinationReason || ""}` : null;
        if (mine && sig !== this.lastMine && mine.action !== "hold") {
            const speech = this.speechFor(mine, plan);
            if (speech) {
                islandShow({ id: "regroup", kind: "info", icon: "⟲", title: "Convoy regroup", sub: ConvoyRegroup.sentenceFor(mine, "You").replace(/^You: /, ""), ttl: 9000 });
                voiceAnnounce(speech, { priority: 55, key: `regroup-${sig}`, cooldownMs: 180000, category: "convoy", drivingOnly: true });
            }
        }
        if (!active && this.wasActive) {
            islandShow({ id: "regroup", kind: "safe", icon: "⟲", title: "Convoy is back together", ttl: 4000, haptic: false });
            voiceAnnounce("The convoy is back together.", { priority: 40, key: "regroup-clear", cooldownMs: 120000, category: "convoy", drivingOnly: true });
        }
        this.lastMine = sig;
        this.wasActive = active;
    },

    regroupSummary() {
        const ctx = typeof ConvoyIntelligence !== "undefined" ? ConvoyIntelligence.context() : null;
        if (!ctx) return "You're not in a group trip or meetup right now.";
        const plan = ConvoyRegroup.plan;
        if (!plan) return "I don't have road times for enough riders yet.";
        if (!plan.active) return "The convoy is together. No regrouping needed.";
        const mine = this.myAction(plan);
        const others = plan.actions.filter((a) => a !== mine && (a.action === "slow" || a.action === "wait"))
            .map((a) => ConvoyRegroup.sentenceFor(a, this.nameOf(plan, a.id)).replace(/ — .*$/, "").replace(/: /, " should "));
        let s = mine && mine.action !== "hold" ? this.speechFor(mine, plan) : `The convoy is ${spokenMinutes(plan.spreadMin)} apart; keep riding, the others are adjusting.`;
        if (others.length) s += ` ${others.slice(0, 2).join(". ")}.`;
        return s;
    },

    // ---- relative motion ------------------------------------------------------------
    motionFor(id) {
        if (typeof RelativeMotion === "undefined" || !id || !friendData[id]) return null;
        const rel = RelativeMotion.relation(id);
        if (!rel || rel.status === "unknown") return null;
        return { rel, text: RelativeMotion.describe(rel).text };
    },

    motionSummary() {
        const rels = RelativeMotion.all().filter((r) => r.status !== "unknown");
        if (!rels.length) return "I don't have enough movement from anyone yet to tell.";
        const closing = rels.filter((r) => r.status === "meeting" || r.status === "approaching" || r.status === "approaching-slowly")
            .sort((a, b) => (a.meetInS ?? a.cpaS ?? 1e9) - (b.meetInS ?? b.cpaS ?? 1e9));
        if (!closing.length) return "Nobody is closing in on you right now.";
        return closing.slice(0, 3).map((r) => RelativeMotion.describe(r).speech).join(" ");
    },

    tick() {
        // Rider popup: keep its motion line live while it's open.
        const pop = document.getElementById("profile-popup");
        if (pop && pop.style.display === "flex" && pop.dataset.friendId) this.fillPopup(pop.dataset.friendId);
        // Heads-up when a convoy rider is about to meet you (once per rider per 10 min).
        if (typeof ConvoyIntelligence === "undefined") return;
        const ctx = ConvoyIntelligence.context();
        if (!ctx) return;
        const now = Date.now();
        ctx.memberIds.forEach((id) => {
            if (id === socket.id || !friendData[id]) return;
            const rel = RelativeMotion.relation(id, now);
            if (!rel || rel.status !== "meeting" || rel.meetInS > 180 || rel.distanceM < 400 || rel.confidence < 0.5) return;
            const key = RelativeMotion.keyFor(friendData[id]);
            if (now - (this.meetAnnounced.get(key) || 0) < 600000) return;
            this.meetAnnounced.set(key, now);
            const d = RelativeMotion.describe(rel);
            islandShow({ id: `meet-${key}`, kind: "info", icon: "↔", title: `${rel.name} is approaching`, sub: d.text, priority: 35, ttl: 8000, haptic: false });
            voiceAnnounce(d.speech, { priority: 50, key: `meet-${key}`, cooldownMs: 600000, category: "convoy", drivingOnly: true });
        });
    },

    fillPopup(id) {
        const el = document.getElementById("profile-popup-motion");
        if (!el) return;
        const m = this.motionFor(id);
        el.hidden = !m;
        el.textContent = m ? m.text : "";
        el.dataset.status = m ? m.rel.status : "";
    }
};
